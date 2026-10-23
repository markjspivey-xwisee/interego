/**
 * Relay-delegated identity: a person who signs in with their Interego account holds no key. The
 * Interego relay signs a request for them with its delegation key (its `sign_request` tool), binding
 * the agent identity of their authenticated session, which the caller cannot choose. This module
 * turns such a request into the person it is for:
 *
 *   1. the signature over `sha256:<hex sha256 of _signed_payload>` recovers to a relay address this
 *      bridge trusts (the operator lists them; the live anchor is published by the relay as
 *      `signing.relayAnchor`);
 *   2. `agent_id` names an agent on the configured identity host, `did:web:<host>:agents:<slug>`;
 *   3. that agent's DID document, fetched from the identity host, has that id and a `controller`
 *      that is a user on the same host, `did:web:<host>:users:<id>`: the principal. When the agent's
 *      id ends in a canonical user id (`<surface>-u-pk-…`, `-u-eth-…`, `-u-did-…`, as the relay
 *      mints them), the controller must be that user.
 *
 * ★ WHEN THE AGENT'S DOCUMENT IS GONE. The identity host keeps the agents the relay mints at
 * sign-in in memory and does not restore them when it restarts, while the relay's session goes on
 * signing as them: measured live, a connector authorised before the restart got 404 for its agent.
 * The relay sets `agent_id` from the session, and the relay key is already what this trusts, so the
 * person is then read from the canonical user id the agent's id ends in, and that user's own DID
 * document (users are restored) must exist on the identity host and name that user. An agent whose
 * id ends in no canonical user id still needs its own document.
 *
 * ★ WHAT THIS TRUSTS. The relay key can sign for any agent, and the identity host says whose agent
 * it is. So whoever holds the relay's delegation key, or controls the identity host, can act as any
 * person here. Records made this way say so (authority `relay-delegated`, with the agent and the
 * relay address), so a reader can tell them from a signature a person made with a key they hold.
 *
 * The caller's `pod_url` is part of the signed payload (the relay keeps the one a caller names);
 * `subject_pod_url` is the caller's OWN pod and is never read as the pod an act targets. Freshness
 * is read from `timestamp`, which the relay sets, never from a caller-supplied field.
 *
 * Pure apart from the DID-document fetch, which is injected and cached.
 */
import { recoverMessageSigner, sha256Hex } from '@interego/core';

export interface RelayDelegationPolicy {
  /** Lower-cased 0x addresses of relay delegation keys this bridge trusts; empty disables the route. */
  readonly relayAddresses: readonly string[];
  /** The identity host, e.g. `identity.interego.xwisee.com` (no scheme, no path). */
  readonly identityHost: string;
  /** GET a DID document by URL; returns the parsed JSON or throws. SSRF-guarded and size-capped by the caller. */
  readonly fetchDidDocument: (url: string) => Promise<unknown>;
}

export type RelayDelegated =
  | {
    readonly ok: true;
    /** The person: the agent's controller, `did:web:<host>:users:<id>`. */
    readonly principal: string;
    /** The agent the relay signed for (which surface acted: claude-…, chatgpt-…, work-redesign-…). */
    readonly agentId: string;
    /** The relay address the signature recovered to. */
    readonly relaySigner: string;
    /** The signed payload, parsed. */
    readonly payload: Record<string, unknown>;
    /** The exact text that was signed. */
    readonly signedPayload: string;
    readonly signature: string;
  }
  | { readonly ok: false; readonly status: 400 | 401 | 502; readonly code: string; readonly message: string };

const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const SLUG = /^[A-Za-z0-9._-]{1,128}$/;
const MAX_SIGNED_PAYLOAD = 64 * 1024;

const escapeHost = (h: string): string => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The agent slug of `did:web:<host>:agents:<slug>`, or null. */
export function agentSlugOf(agentId: string, identityHost: string): string | null {
  const m = new RegExp(`^did:web:${escapeHost(identityHost)}:agents:(.+)$`).exec(agentId);
  return m && SLUG.test(m[1] ?? '') ? m[1]! : null;
}

/** True for `did:web:<host>:users:<id>` on the identity host. */
export function isUserDid(did: string, identityHost: string): boolean {
  const m = new RegExp(`^did:web:${escapeHost(identityHost)}:users:(.+)$`).exec(did);
  return m !== null && SLUG.test(m[1] ?? '');
}

/** The canonical user id a relay agent's slug ends with (`<surface>-<userId>`), or null. */
export function userIdOfAgentSlug(slug: string): string | null {
  return /-(u-(?:pk|eth|did)-[0-9a-f]{12})$/.exec(slug)?.[1] ?? null;
}

/** Where a did:web user's document is served: `https://<host>/users/<id>/did.json`. */
export const userDidDocumentUrl = (identityHost: string, userId: string): string =>
  `https://${identityHost}/users/${encodeURIComponent(userId)}/did.json`;

/** Where a did:web agent's document is served: `https://<host>/agents/<slug>/did.json`. */
export const agentDidDocumentUrl = (identityHost: string, slug: string): string =>
  `https://${identityHost}/agents/${encodeURIComponent(slug)}/did.json`;

/** True when the request is in the relay-signed shape at all (top level, or under `envelope`). */
export function relayEnvelopeOf(args: Record<string, unknown>): { signedPayload: unknown; signature: unknown } | null {
  let raw: unknown = args['envelope'];
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = undefined; } }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    if ('_signed_payload' in o || '_signature' in o) return { signedPayload: o['_signed_payload'], signature: o['_signature'] };
  }
  if ('_signed_payload' in args || '_signature' in args) return { signedPayload: args['_signed_payload'], signature: args['_signature'] };
  return null;
}

/**
 * Check a relay-signed request and name its principal. `relaySigner` must be one of
 * `policy.relayAddresses`; an address that is not is refused here, so a caller's own key signing
 * the same shape goes through the vertical's ordinary key-held route instead.
 */
export async function openRelayDelegated(
  signedPayload: unknown, signature: unknown, policy: RelayDelegationPolicy,
): Promise<RelayDelegated> {
  const no = (status: 400 | 401 | 502, code: string, message: string): RelayDelegated => ({ ok: false, status, code, message });
  if (typeof signedPayload !== 'string' || signedPayload.length === 0 || typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    return no(401, 'envelope-missing', 'A relay-signed request is {_signed_payload: string, _signature: 0x… (65 bytes)}.');
  }
  if (signedPayload.length > MAX_SIGNED_PAYLOAD) return no(400, 'payload-too-large', `_signed_payload is over ${MAX_SIGNED_PAYLOAD} characters.`);
  let relaySigner: string;
  try { relaySigner = recoverMessageSigner(`sha256:${sha256Hex(signedPayload)}`, signature).toLowerCase(); } catch {
    return no(401, 'signature-unrecoverable', 'No signer can be recovered from this signature over these bytes.');
  }
  if (!policy.relayAddresses.includes(relaySigner)) {
    return no(401, 'relay-not-trusted', `This request was signed by ${relaySigner}, which is not a relay this bridge trusts for Interego sign-in.`);
  }
  let payload: unknown;
  try { payload = JSON.parse(signedPayload); } catch { payload = undefined; }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return no(400, 'envelope-payload-format', 'The signed payload must be a JSON object.');
  }
  const p = payload as Record<string, unknown>;
  const agentId = typeof p['agent_id'] === 'string' ? p['agent_id'] : '';
  const slug = agentSlugOf(agentId, policy.identityHost);
  if (slug === null) {
    return no(401, 'agent-not-on-identity-host', `agent_id must be did:web:${policy.identityHost}:agents:<slug>; this request names ${agentId || '(none)'}.`);
  }
  const why = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 200);
  const asObject = (doc: unknown): Record<string, unknown> => (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) ? doc as Record<string, unknown> : {};
  const userId = userIdOfAgentSlug(slug);
  const namedUser = userId === null ? null : `did:web:${policy.identityHost}:users:${userId}`;
  let doc: unknown;
  try { doc = await policy.fetchDidDocument(agentDidDocumentUrl(policy.identityHost, slug)); } catch (e) {
    // The agent's document is gone (see the header): read the person from the user its id names.
    if (userId === null || namedUser === null) return no(502, 'agent-document-unreadable', `The DID document of ${agentId} could not be read: ${why(e)}`);
    let user: unknown;
    try { user = await policy.fetchDidDocument(userDidDocumentUrl(policy.identityHost, userId)); } catch (e2) {
      return no(502, 'agent-document-unreadable', `The DID document of ${agentId} could not be read (${why(e)}), nor that of the user its id names, ${namedUser}: ${why(e2)}`);
    }
    if (asObject(user)['id'] !== namedUser) return no(401, 'agent-document-mismatch', `The DID document served for ${namedUser} names another id.`);
    return { ok: true, principal: namedUser, agentId, relaySigner, payload: p, signedPayload, signature };
  }
  const d = asObject(doc);
  if (d['id'] !== agentId) return no(401, 'agent-document-mismatch', `The DID document served for ${agentId} names another id.`);
  const controller = d['controller'];
  if (typeof controller !== 'string' || !isUserDid(controller, policy.identityHost)) {
    return no(401, 'agent-has-no-user', `${agentId} is not controlled by a user on ${policy.identityHost}.`);
  }
  if (namedUser !== null && controller !== namedUser) {
    return no(401, 'agent-has-no-user', `${agentId} names the user ${namedUser}, but its document names ${controller} as its controller.`);
  }
  return { ok: true, principal: controller, agentId, relaySigner, payload: p, signedPayload, signature };
}

/**
 * A DID-document fetch that keeps answers for `ttlMs` (failures are not kept), so a burst of acts
 * from one agent reads its document once. `get` must be SSRF-guarded, time-limited and size-capped.
 */
export function cachedDidDocuments(get: (url: string) => Promise<unknown>, ttlMs = 10 * 60_000, max = 1000, now = (): number => Date.now()):
  (url: string) => Promise<unknown> {
  const kept = new Map<string, { readonly at: number; readonly doc: unknown }>();
  return async (url) => {
    const t = now();
    const hit = kept.get(url);
    if (hit && t - hit.at < ttlMs) return hit.doc;
    const doc = await get(url);
    kept.delete(url);
    kept.set(url, { at: t, doc });
    while (kept.size > max) { const first = kept.keys().next(); if (first.done) break; kept.delete(first.value); }
    return doc;
  };
}
