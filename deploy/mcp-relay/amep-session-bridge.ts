/**
 * AMEP same-origin session bridge.
 *
 * Lets an OAuth MCP caller drive AMEP acts (POST /amep/acts — e.g. Compose)
 * WITHOUT pasting a bearer: the relay reuses the caller's ALREADY-VERIFIED
 * session token, but ONLY when the act targets the relay's OWN /amep endpoint
 * (same parsed origin as PUBLIC_BASE_URL). This grants no authority the caller
 * lacked — they could already pass the same token via the `authorization` arg —
 * it just removes the paste. amep.ts still authenticates the real forwarded
 * token (introspect + write-scope gate + `act.actor === principal` binding), so
 * every AMEP authorization invariant still runs against a genuine credential.
 *
 * Security posture (from the adversarial design review):
 *   - Same-origin is decided by PARSED URL.origin, never a string prefix (so
 *     case / port / userinfo / trailing-dot / traversal / lookalike are handled).
 *   - The credential is attached ONLY to a POST at the EXACT /amep/acts path —
 *     never to the public GET descriptor/head reads the kernel does first.
 *   - redirect:'manual' so a 3xx can never carry a (possibly DPoP-bound) bearer
 *     off-origin.
 *   - The reserved args that carry the token + principal are stripped from wire
 *     input UNCONDITIONALLY by the CallTool handler so they can't be smuggled.
 *   - Fail-closed: if publicBaseUrl is unset, no forwarding happens at all.
 *
 * Extracted from server.ts (which self-starts on import) so the same-origin gate
 * and the fetch/actor-stamp logic are unit-testable in isolation.
 */
import yaml from 'js-yaml';
import type { FetchFn } from '@interego/core';

/**
 * Returns the parsed URL iff `rawUrl` is on the relay's OWN origin and under
 * /amep/; otherwise null. Uses URL.origin (scheme + lowercased host + explicit
 * port) so string-prefix bypasses do not apply. Fail-closed on unset base / a
 * malformed URL.
 */
export function amepSameOriginUrl(rawUrl: string, publicBaseUrl: string): URL | null {
  if (!publicBaseUrl || !rawUrl) return null;
  let u: URL;
  let base: URL;
  try { u = new URL(rawUrl); base = new URL(publicBaseUrl); } catch { return null; }
  if (u.origin !== base.origin) return null;
  if (!u.pathname.startsWith('/amep/')) return null;
  return u;
}

export interface AmepSessionOpts {
  /** Raw OAuth access token the MCP client presented (relay-injected, never from the wire). */
  sessionBearer?: string;
  /** Authenticated principal id (= introspect(token).userId), used to stamp act.actor. */
  principalId?: string;
  /** An explicit `authorization` the caller supplied; when present we do NOT auto-forward. */
  explicitAuth?: string;
}

/**
 * Given the act's target and payload, returns the fetch + payload to hand to
 * kernelAct: a fetch that auto-attaches the caller's bearer to a same-origin
 * POST /amep/acts, and a payload whose act.actor is stamped to the principal id
 * (only when same-origin /amep and the caller left actor absent).
 */
export function withAmepSession(
  targetForActor: string,
  payload: unknown,
  opts: AmepSessionOpts,
  deps: { solidFetch: FetchFn; publicBaseUrl: string },
): { fetch: FetchFn; payload: unknown } {
  const { sessionBearer, principalId, explicitAuth } = opts;
  const { solidFetch, publicBaseUrl } = deps;

  // (a) Actor binding — same-origin /amep only. On the OAuth path amep REQUIRES
  // act.actor === principal.id, so ANY other value (absent, a placeholder the
  // model invented, or a different DID) is invalid and would only 403. Rather than
  // make the caller think about a field they can't set correctly, we ALWAYS bind
  // act.actor to the authenticated identity: an OAuth caller is always attributed
  // to themselves — never anyone else (no impersonation), and never has to touch
  // the field. This is not a silent downgrade: you could never be attributed as
  // someone else either way; this just turns a confusing 403 into "it's you".
  let outPayload = payload;
  if (principalId && amepSameOriginUrl(targetForActor, publicBaseUrl)) {
    try {
      const obj = typeof payload === 'string' ? yaml.load(payload) : payload;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const act = (obj as Record<string, unknown>)['act'];
        if (act && typeof act === 'object' && !Array.isArray(act)) {
          (act as Record<string, unknown>)['actor'] = principalId;
          outPayload = obj;
        }
      }
    } catch { /* unparseable payload → leave as-is; amep returns a clear error */ }
  }

  // (b) Credential injection — ONLY a POST to the exact /amep/acts write endpoint,
  // ONLY when the caller supplied no explicit authorization.
  if (!sessionBearer || explicitAuth) return { fetch: solidFetch, payload: outPayload };
  const wireFetch: FetchFn = async (url, init) => {
    const u = amepSameOriginUrl(url, publicBaseUrl);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u && method === 'POST' && u.pathname === '/amep/acts') {
      const headers: Record<string, string> = { ...(init?.headers ?? {}) };
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
        headers['Authorization'] = `Bearer ${sessionBearer}`;
      }
      // redirect:'manual' is not in the FetchFn init type, but solidFetch spreads
      // init into the underlying fetch, so the cast forwards it at runtime.
      return solidFetch(url, { ...init, headers, redirect: 'manual' } as Parameters<FetchFn>[1]);
    }
    return solidFetch(url, init);
  };
  return { fetch: wireFetch, payload: outPayload };
}
