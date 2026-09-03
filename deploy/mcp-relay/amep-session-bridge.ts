/**
 * AMEP same-origin session bridge.
 *
 * Lets an OAuth MCP caller drive AMEP acts (POST /amep/acts — e.g. Compose)
 * WITHOUT pasting a bearer. It also preserves one constrained MCP loopback for
 * the generic Application Lab executor when a connector's cached tool catalog
 * predates that live tool. The relay reuses the caller's ALREADY-VERIFIED
 * session token only for its own exact endpoints and, for the MCP loopback,
 * only when the JSON-RPC body selects `execute_application_action`.
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
import { createHash } from 'node:crypto';
import type { FetchFn } from '@interego/core';

/** Deterministic JSON with recursively sorted keys (stable across serialization). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/**
 * The canonical bytes an AMEP act's proof commits to — binding the act's
 * IDENTITY + LINEAGE (actor, type, id, all head/branch/operand references,
 * timestamp) and its CONTENT (a sha256 of the submitted memory), but NOT the
 * proof itself. Computed identically by the relay when it signs and by the AMEP
 * engine when it verifies, so a replay onto different content — or a different
 * actor/head — no longer matches. Robust across YAML↔JSON round-trips (only
 * scalars + one memory hash; sorted keys).
 */
export function amepAuthPayload(act: Record<string, unknown>, memory: unknown): string {
  const memorySha = memory !== undefined && memory !== null
    ? createHash('sha256').update(stableStringify(memory), 'utf8').digest('hex')
    : null;
  return stableStringify({
    v: 'amep-act-proof/1',
    actor: act['actor'] ?? null,
    actType: act['actType'] ?? null,
    id: act['@id'] ?? act['id'] ?? null,
    expectedHead: act['expectedHead'] ?? null,
    parentHead: act['parentHead'] ?? null,
    branch: act['branch'] ?? null,
    operands: act['operands'] ?? null,
    operator: act['operator'] ?? null,
    challengedAct: act['challengedAct'] ?? null,
    acceptedAct: act['acceptedAct'] ?? null,
    createdAt: act['createdAt'] ?? null,
    memorySha,
  });
}

/** Signer shape (the relay's delegation signer): signs a string, returns an
 *  ECDSA signature + the did:ethr verificationMethod that recovers to it. */
export type AmepSigner = (payload: string) => Promise<{ signature: string; verificationMethod: string }>;

/**
 * Stamp a GENUINE relay-attestation proof onto a same-origin /amep act. The
 * relay signs {@link amepAuthPayload} with its delegation key — the OAuth session
 * holds no key of its own, so this is the "delegated verification" model: the
 * relay cryptographically attests that the authenticated session submitted this
 * exact act. Only the relay's wallet can produce it (a client cannot forge a
 * Verified proof); the AMEP engine re-derives the same payload and checks the
 * signature recovers to the relay's address. No-op for non-/amep targets or
 * when no signer is available (→ the act keeps whatever proof it had → Unverified).
 */
export async function stampAmepProof(
  payload: unknown,
  targetForActor: string,
  deps: { signer?: AmepSigner; publicBaseUrl: string },
): Promise<unknown> {
  if (!deps.signer || !amepSameOriginUrl(targetForActor, deps.publicBaseUrl)) return payload;
  let obj: unknown;
  try { obj = typeof payload === 'string' ? yaml.load(payload) : payload; }
  catch { return payload; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return payload;
  const act = (obj as Record<string, unknown>)['act'];
  if (!act || typeof act !== 'object' || Array.isArray(act)) return payload;
  const actObj = act as Record<string, unknown>;
  try {
    const canonical = amepAuthPayload(actObj, (obj as Record<string, unknown>)['memory']);
    const { signature, verificationMethod } = await deps.signer(canonical);
    actObj['proof'] = {
      '@type': 'iep:SignedAuthorship',
      verificationMethod,
      created: (actObj['createdAt'] as string) ?? new Date().toISOString(),
      proofValue: signature,
    };
  } catch { /* signing failed → leave the act's existing proof → Unverified */ }
  return obj;
}

/** True if `s` looks like an absolute IRI (has a URI scheme: did:, https:, urn:…). */
export function isIriLike(s: string | undefined): boolean {
  return !!s && /^[a-z][a-z0-9+.-]*:/i.test(s);
}

/**
 * The IRI that identifies an OAuth session as an AMEP `actor` / `submittedBy`.
 * AMEP requires these to be absolute IRIs (they become node `@id`s), but the
 * relay's `userId` is a bare slug (`u-pk-…`) — using it verbatim yields a 422
 * "actor MUST be a node object with an IRI @id". Prefer the session agent DID
 * when it is an IRI (did:web/did:key), else the user's WebID (always a URL).
 * MUST be computed identically wherever the principal is set (amep's introspect
 * AND the session-bridge actor stamp) so the actor-binding `act.actor ===
 * principal.id` holds — both derive from the same token's extra, so they agree.
 */
export function principalIri(agentId?: string, ownerWebId?: string, userId?: string): string {
  if (isIriLike(agentId)) return agentId as string;
  if (isIriLike(ownerWebId)) return ownerWebId as string;
  return agentId || userId || '';
}

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

/**
 * Returns the parsed URL only for an exact same-origin MCP request whose body
 * selects the Application Lab action executor. This is deliberately a request
 * predicate, not a generic `/mcp` URL check: forwarding a session bearer to an
 * arbitrary nested `tools/call` would collapse the per-tool authorization
 * boundary.
 */
export function applicationActionMcpRequest(
  rawUrl: string,
  publicBaseUrl: string,
  init?: Parameters<FetchFn>[1],
): URL | null {
  if (!publicBaseUrl || !rawUrl) return null;
  let u: URL;
  let base: URL;
  try { u = new URL(rawUrl); base = new URL(publicBaseUrl); } catch { return null; }
  if (u.origin !== base.origin) return null;
  if (u.pathname !== '/mcp' || u.search || u.username || u.password) return null;
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST') return null;
  if (typeof init?.body !== 'string') return null;
  let wire: unknown;
  try { wire = JSON.parse(init.body); } catch { return null; }
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const rpc = wire as Record<string, unknown>;
  const params = rpc['params'];
  if (rpc['jsonrpc'] !== '2.0' || rpc['method'] !== 'tools/call') return null;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  if ((params as Record<string, unknown>)['name'] !== 'execute_application_action') return null;
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
 * kernelAct: a fetch that auto-attaches the caller's bearer to the exact
 * same-origin POST /amep/acts endpoint or one exact Application Lab JSON-RPC
 * tools/call at POST /mcp, and a payload whose act.actor is stamped to the
 * principal id (only when same-origin /amep and the caller left actor absent).
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

  // (b) Credential injection — ONLY one of two exact same-origin requests, and
  // ONLY when the caller supplied no explicit authorization:
  //   - /amep/acts (the original AMEP bridge), or
  //   - /mcp with JSON-RPC tools/call selecting execute_application_action.
  // The latter keeps kernel `act` usable when a connector's cached tool catalog
  // predates the live Application Lab tool. The MCP verifier authenticates the
  // forwarded token normally, and the executor still performs every graph,
  // guard, actor, effect, CAS and complete-replay check itself.
  if (!sessionBearer || explicitAuth) return { fetch: solidFetch, payload: outPayload };
  const wireFetch: FetchFn = async (url, init) => {
    const u = amepSameOriginUrl(url, publicBaseUrl);
    const applicationAction = applicationActionMcpRequest(url, publicBaseUrl, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST' && ((u && u.pathname === '/amep/acts') || applicationAction)) {
      const headers: Record<string, string> = { ...(init?.headers ?? {}) };
      // MCP Streamable HTTP requires the client to advertise both response
      // representations. The generic kernel deliberately mirrors an
      // affordance's media type into Accept, so repair that transport header
      // only after the exact Application Lab JSON-RPC predicate has passed.
      if (applicationAction) {
        for (const key of Object.keys(headers)) if (key.toLowerCase() === 'accept') delete headers[key];
        headers['Accept'] = 'application/json, text/event-stream';
      }
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
