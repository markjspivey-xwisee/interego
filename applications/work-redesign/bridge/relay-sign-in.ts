/**
 * "Sign in with your Interego account": the configuration bridge/server.ts reads for it, and the
 * DID-document fetch src/relay-delegated.ts reads agents through. No environment reads here:
 * server.ts passes the values in.
 *
 * RELAY-ATTESTED, NOT USER-HELD. A person who signs in this way holds no key. The Interego relay
 * signs each request for them with its delegation key, binding the agent of their session, and
 * the identity host says which person that agent belongs to. So whoever holds a trusted relay key,
 * or controls the identity host, can act here as any person; every record made this way says
 * relay-delegated (README, "Signing in with an Interego account").
 */
import { guardedFetchFn } from '@interego/core';
import { cachedDidDocuments, isUserDid } from '../src/relay-delegated.js';
import { isAddress } from '../src/records.js';

export interface RelaySignInConfig {
  /** Lower-cased 0x addresses of the relay delegation keys trusted; empty: no request is relay-delegated. */
  readonly relayAddresses: readonly string[];
  /** Lower-cased 0x addresses of relay keys retired from new requests, read only to re-check stored countersigns they signed. */
  readonly retiredRelayAddresses: readonly string[];
  /** The identity host user DIDs must be on (lower-cased), or null: then the registry takes no user DID either. */
  readonly identityHost: string | null;
  /** The relay a person signs in through, for the web UI; null when not set. */
  readonly relayUrl: string | null;
  /** did:web:<identity host>:users:<id> principals who are admins, as spelled. */
  readonly adminDids: readonly string[];
  /** WRD_CHAT_AGENTS_DECIDE=1: decisive acts are taken from chat agents too, not only this bridge's web UI. */
  readonly chatAgentsDecide: boolean;
}

/** The raw values, as server.ts reads them (an empty value already read as unset). */
export interface RelaySignInValues {
  readonly relays?: string | undefined; readonly retiredRelays?: string | undefined; readonly identityHost?: string | undefined; readonly relayUrl?: string | undefined;
  readonly adminDids?: string | undefined; readonly chatAgentsDecide?: string | undefined;
}

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const items = (v: string | undefined): string[] => (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

/**
 * Read the sign-in settings, or say which one is malformed (the bridge then does not start):
 *   WRD_TRUSTED_RELAY_ADDRESSES  comma list of 0x addresses; empty → no request is relay-delegated
 *   WRD_RETIRED_RELAY_ADDRESSES  comma list of 0x addresses retired from new requests (key rotation), none of them
 *                                also trusted; read only to re-check stored countersigns
 *   WRD_IDENTITY_HOST            a bare host name (no scheme, port or path); required with a relay address or an admin DID
 *   WRD_RELAY_URL                the relay's http(s) base URL, no query, fragment or credentials
 *   WRD_ADMIN_DIDS               comma list of did:web:<WRD_IDENTITY_HOST>:users:<id>
 *   WRD_CHAT_AGENTS_DECIDE       1 lifts the limit on decisive acts; 0 or unset keeps it; anything else is malformed
 */
export function parseRelaySignIn(v: RelaySignInValues): { readonly ok: true; readonly config: RelaySignInConfig } | { readonly ok: false; readonly why: string } {
  const no = (why: string): { readonly ok: false; readonly why: string } => ({ ok: false, why });
  const relayAddresses: string[] = [];
  for (const a of items(v.relays)) {
    if (!isAddress(a)) return no(`WRD_TRUSTED_RELAY_ADDRESSES holds ${JSON.stringify(String(a).slice(0, 80))}, which is not a 0x address (40 hex characters)`);
    relayAddresses.push(a.toLowerCase());
  }
  const retiredRelayAddresses: string[] = [];
  for (const a of items(v.retiredRelays)) {
    if (!isAddress(a)) return no(`WRD_RETIRED_RELAY_ADDRESSES holds ${JSON.stringify(String(a).slice(0, 80))}, which is not a 0x address (40 hex characters)`);
    if (relayAddresses.includes(a.toLowerCase())) return no(`WRD_RETIRED_RELAY_ADDRESSES holds ${a.toLowerCase()}, which WRD_TRUSTED_RELAY_ADDRESSES lists too: a retired relay key takes no new request, so list it in one or the other`);
    retiredRelayAddresses.push(a.toLowerCase());
  }
  let identityHost: string | null = null;
  if (v.identityHost !== undefined) {
    const h = v.identityHost.trim().toLowerCase();
    if (!HOST.test(h)) return no(`WRD_IDENTITY_HOST must be a bare host name such as identity.interego.xwisee.com (no scheme, port or path); it is ${JSON.stringify(v.identityHost.slice(0, 120))}`);
    identityHost = h;
  }
  if (relayAddresses.length > 0 && identityHost === null) {
    return no('WRD_TRUSTED_RELAY_ADDRESSES is set and WRD_IDENTITY_HOST is not: a relay-signed request names an agent on the identity host, and without one no person can be found for it');
  }
  if (retiredRelayAddresses.length > 0 && identityHost === null) {
    return no('WRD_RETIRED_RELAY_ADDRESSES is set and WRD_IDENTITY_HOST is not: a stored relay-signed countersign names an agent on the identity host, and without one none is re-checked');
  }
  let relayUrl: string | null = null;
  if (v.relayUrl !== undefined) {
    let u: URL | null = null;
    try { u = new URL(v.relayUrl.trim()); } catch { u = null; }
    if (u === null || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
      return no(`WRD_RELAY_URL must be the relay's http(s) base URL, such as https://relay.interego.xwisee.com, with no query, fragment or credentials; it is ${JSON.stringify(v.relayUrl.slice(0, 120))}`);
    }
    relayUrl = u.href.replace(/\/$/, '');
  }
  const adminDids: string[] = [];
  for (const d of items(v.adminDids)) {
    if (identityHost === null) return no('WRD_ADMIN_DIDS is set and WRD_IDENTITY_HOST is not: an admin DID is a user on the identity host');
    if (!isUserDid(d, identityHost)) return no(`WRD_ADMIN_DIDS holds ${JSON.stringify(d.slice(0, 120))}, which is not did:web:${identityHost}:users:<id>`);
    adminDids.push(d);
  }
  const decide = v.chatAgentsDecide?.trim();
  if (decide !== undefined && decide !== '' && decide !== '0' && decide !== '1') {
    return no(`WRD_CHAT_AGENTS_DECIDE is neither 1 nor 0; set it to 1 to take decisive acts from chat agents too, or to 0 (or unset it) to take them only from this bridge's web UI`);
  }
  return { ok: true, config: { relayAddresses, retiredRelayAddresses, identityHost, relayUrl, adminDids, chatAgentsDecide: decide === '1' } };
}

/** The response fields the capped read uses. */
export interface CappedAnswer {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
type Answer = CappedAnswer;
type GetFn = (url: string, init?: Record<string, unknown>) => Promise<Answer>;

export const DID_DOCUMENT_TIMEOUT_MS = 8_000;
export const DID_DOCUMENT_MAX_BYTES = 64 * 1024;

/**
 * The body as UTF-8 text, refusing it past `max` bytes (by its Content-Length, and while it is
 * read); `what` names the body in the error. The web UI's sign-in routes read the relay's answers
 * through it too (bridge/ui.ts).
 */
export async function cappedText(r: Answer, max: number, what = 'the DID document'): Promise<string> {
  const declared = Number(r.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) throw new Error(`${what} is over ${max} bytes`);
  const body = r.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${what} is over ${max} bytes`);
      }
      chunks.push(value);
    }
    const all = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(all);
  }
  const t = await r.text();
  if (new TextEncoder().encode(t).byteLength > max) throw new Error(`${what} is over ${max} bytes`);
  return t;
}

/**
 * A time-limited, size-capped GET of a DID document as JSON, through `get` (which server.ts makes
 * SSRF-guarded: didDocumentFetcher). Anything but a 200 with a JSON body within the cap and the
 * time limit throws, and openRelayDelegated refuses the request (502).
 */
export function cappedDidDocumentGet(get: GetFn, timeoutMs = DID_DOCUMENT_TIMEOUT_MS, maxBytes = DID_DOCUMENT_MAX_BYTES): (url: string) => Promise<unknown> {
  return async (url) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await get(url, { method: 'GET', headers: { accept: 'application/did+json, application/json' }, signal: ac.signal });
      if (r.status !== 200) throw new Error(`the identity host answered ${r.status}`);
      return JSON.parse(await cappedText(r, maxBytes)) as unknown;
    } catch (e) {
      if (ac.signal.aborted) throw new Error(`the identity host did not answer within ${timeoutMs} ms`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * How the bridge reads agents' DID documents: every hop SSRF-guarded (guardedFetchFn re-checks
 * the target and each redirect, and refuses private and loopback hosts), 8 s, 64 KiB, and kept
 * for ten minutes per URL (cachedDidDocuments; failures are not kept).
 */
export function didDocumentFetcher(base: typeof fetch): (url: string) => Promise<unknown> {
  return cachedDidDocuments(cappedDidDocumentGet(guardedFetchFn(base as unknown as GetFn)));
}
