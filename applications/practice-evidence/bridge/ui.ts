/**
 * The web UI and the browser-facing protection of a practice-evidence bridge.
 *
 * `attachUi` serves a static HTML shell at /ui, the client at /ui/app.js and its styles at
 * /ui/app.css (the shared Interego design system, then this product's own rules). The client is a
 * Path-A client: it reads this bridge's affordance manifest and invokes every act at the target the
 * manifest names. It holds no key (demo role keys stay in the bridge; wallet keys stay in the
 * wallet) and computes nothing the record does not already say.
 *
 * It also serves the pages a person reads before signing in, each a constant under the same policy:
 *
 *   GET  /                      the landing page, to a browser only: a request whose best match
 *                               among the types / serves is text/html, with no ?format=. Every
 *                               other request (agents, curl, fetch's `*\/*`, ?format=…) falls
 *                               through to the factory's JSON-LD or Markdown, unchanged.
 *   GET  /ui/help               the guide, and /ui/help.js, the few lines that show this
 *                               workspace's address on it
 *   GET  /ui/favicon.svg        the mark
 *
 * Interego sign-in (`attachUi(app, { interego })`, on when the operator sets PEV_RELAY_URL and
 * trusts a relay): a person with no key of their own signs in with their Interego account on the
 * relay's own sign-in page (their passkey), and the page then has the relay sign each act for the
 * agent of that session. These routes are the only ones the UI adds, and every relay call goes
 * through them, so the page's policy keeps `connect-src 'self'`:
 *
 *   GET  /ui/oauth/client.json  this client's Client ID Metadata Document; its client_id is that
 *                               URL on the deployment URL, its client_name "Practice Evidence", so
 *                               the relay names the session's agent practice-evidence-<userId>
 *   GET  /ui/oauth/start        what the page needs to send the person to the relay: the relay's
 *                               authorization endpoint (discovered from its metadata), the client
 *                               id (the CIMD URL, or one registered by DCR when the relay offers no
 *                               CIMD or the deployment URL is not https), the redirect URI, scope
 *                               and resource. The page makes the PKCE verifier and the state itself.
 *   GET  /ui/oauth/callback     the page the relay sends the person back to: the shell again, with
 *                               its asset URLs one level up. The code is in the query; the page
 *                               takes it out of the address bar before doing anything else.
 *   POST /ui/oauth/exchange     {code, code_verifier, state}: the code for an access token at the
 *                               relay's token endpoint, and nothing more. The page gets that OAuth
 *                               access token and how long it lasts (at most SIGN_IN_MAX_SECONDS);
 *                               a refresh token the relay sends anyway is dropped here.
 *   POST /ui/relay/sign         {payload} with that access token as `Authorization: Bearer`: one
 *                               MCP tools/call of the relay's sign_request at <relay>/mcp, where the
 *                               relay itself names the session's agent, answered with only
 *                               {_signature, _signed_payload}.
 *
 * The access token is the relay's, for this sign-in: until it expires (an hour, as the relay is
 * written) whoever holds it can call the relay's tools as the person. It is not the identity
 * server's account token, which this bridge never asks for (though the relay's GET /identity-token
 * trades any write-scoped access token for it, so a holder could). It passes through this bridge
 * on every sign request, so the operator is trusted with it for the session. This module never
 * logs, stores or echoes a bearer or a code, never puts either in a URL it serves, and drops both
 * from any relay text it passes on (it keeps only a sha256 of a token, to count its calls). Every
 * relay call has a deadline and a size cap and follows no redirect, and is admitted under
 * RELAY_LIMITS before it is made, both how many a minute and how many at once: a caller who is
 * not signed in cannot spend the relay calls that people signed in here need, and no one signed
 * in, with however many tokens, can spend another person's (see RelayLimits).
 *
 * Every UI response carries a Content-Security-Policy that allows only this origin's own script,
 * style and fetches, and no inline script or style; the shells have neither, and the client
 * renders every piece of untrusted text through textContent.
 *
 * `hostAllowlistGuard` refuses (421) any request whose Host header is not one of the names this
 * bridge is served under. A loopback bridge that holds a signing key — and, in demo mode, role
 * keys — would otherwise answer a page on another site that rebinds its own DNS name to
 * 127.0.0.1. Cross-site POSTs are already blocked by the JSON-only body parser and the absence of
 * CORS headers; this closes the rebinding path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Express, NextFunction, Request, Response } from 'express';
import { guardedFetchFn } from '@interego/core';
import { designSystemCss } from '../../_shared/design-system/index.js';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';
import { openRelayDelegated, type RelayDelegationPolicy } from '../src/relay-delegated.js';
import { cappedFetch } from './pod-helpers.js';

export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const readUiFile = (name: string): string => readFileSync(new URL(`./ui/${name}`, import.meta.url), 'utf8');
const APP_JS = readUiFile('app.js');
/** The Interego design system (shared with work-redesign), then this product's own rules. */
const APP_CSS = `${designSystemCss()}\n${readUiFile('app.css')}`;
const LANDING_HTML = readUiFile('landing.html');
const HELP_HTML = readUiFile('help.html');
const HELP_JS = readUiFile('help.js');
const FAVICON_SVG = readUiFile('favicon.svg');

/**
 * A shell: a constant, with no interpolation and no inline script or style. Relative URLs, so a
 * bridge deployed under a path prefix still loads its own client. `up` is the path from the page
 * to the directory /ui sits in: '' for /ui itself, '../../' for /ui/oauth/callback.
 */
const shell = (up: string): string => [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="no-referrer">',
  '<title>Practice evidence</title>',
  `<link rel="stylesheet" href="${up}ui/app.css">`,
  `<script type="module" src="${up}ui/app.js"></script>`,
  '</head>',
  '<body>',
  '<header id="bar"><p class="muted">Practice evidence: loading…</p></header>',
  '<nav id="tabs" aria-label="Views"></nav>',
  '<section id="signing" aria-live="polite"></section>',
  '<main id="view"></main>',
  `<noscript><p>This page needs JavaScript. Everything it offers is also an affordance: see the manifest at <a href="${up}affordances">affordances</a>.</p></noscript>`,
  '</body>',
  '</html>',
  '',
].join('\n');
const SHELL = shell('');
/** The page the relay sends a person back to after sign-in. It never shows the query it is given. */
const CALLBACK_SHELL = shell('../../');

function secure(res: Response): void {
  res.setHeader('Content-Security-Policy', UI_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
//  Interego sign-in
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The OAuth client name the relay turns into the agent slug (`practice-evidence-<userId>`). */
export const PEV_UI_CLIENT_NAME = 'Practice Evidence';
/** The relay's scope for its write-side tools on /mcp, sign_request among them (an mcp:read token is refused there). */
export const INTEREGO_SCOPE = 'mcp';
/**
 * The longest the page keeps a sign-in: the relay's access tokens last an hour (its tokenTtlSec),
 * and a longer `expires_in`, or one that is missing or not a number, is taken as this. A number
 * under one second says the token is already dead, and the exchange refuses it.
 */
export const SIGN_IN_MAX_SECONDS = 3600;
/** One relay call, from the first byte sent to the last read, DNS look-up included. */
export const RELAY_CALL_TIMEOUT_MS = 10_000;
/** The most one relay answer may be. */
export const RELAY_MAX_BYTES = 256 * 1024;
/** The most a payload to sign may be: the verifier refuses a signed payload over 64 KiB, and the relay adds its own fields. */
export const SIGN_PAYLOAD_MAX_BYTES = 60 * 1024;
/** The most a code exchange request may be. */
export const EXCHANGE_BODY_MAX_BYTES = 8 * 1024;
/** How long the relay's authorization server metadata is kept. */
const METADATA_TTL_MS = 10 * 60_000;

/**
 * How many relay calls this bridge makes, and for whom. Every call it makes comes from its one
 * address, and the relay limits some routes per client address before it checks any credential:
 * /token to 60 a minute and 50 every 15 minutes, /register to 20 an hour (deploy/mcp-relay's OAuth
 * router). It sets no per-address limit on /mcp, where each made-up token still costs it a token
 * check. So whoever makes this bridge call the relay spends what every person signing in here
 * shares. These limits keep the bridge well under the relay's, keep a caller with no sign-in from
 * spending the calls people already signed in need, and keep each person signed in from spending
 * another's:
 *
 *   unproven            calls made for no access token the relay has accepted here, a minute, in
 *                       all: a code exchange, the sign-in set-up (the relay's metadata, a
 *                       registration), a sign with a token this bridge has not seen the relay
 *                       accept. These are the only calls a stranger can make.
 *   unprovenPerClient   of those, from one client address (req.ip: server.ts says how many proxy
 *                       hops it is read through), a minute
 *   perSignIn           calls for one access token the relay accepted here, a minute
 *   perPerson           calls for one person, a minute, over every token of theirs the relay
 *                       accepted here. The person is the user the relay's signed text names (its
 *                       agent's controller on the identity host, read through the DID-document
 *                       cache the handlers use), or that agent when its document cannot be read,
 *                       learned at the first sign with the token that succeeds.
 *   exchanges           code exchanges at the relay's token endpoint, every 15 minutes, in all
 *   exchangesPerClient  of those, from one client address
 *   registrations       client registrations at the relay, an hour (once per process when it works)
 *   unprovenAtOnce      relay calls running at once for callers the relay has not accepted here
 *   signedInAtOnce      relay calls running at once for people signed in, in all
 *   perPersonAtOnce     of those, for one person (or for one sign-in whose person no sign has named yet)
 *
 * A call made with a token the relay accepted here counts in no minute budget shared with anyone
 * else: the relay keeps no per-address limit on /mcp for such a budget to stay under, and whoever
 * holds the token can call the relay's /mcp directly at any rate, so a cap over every signed-in
 * call would protect nothing, and would let anyone with an Interego account (sign-up is open) stop
 * everyone else's signing with a few tokens. The one thing people signed in share is
 * signedInAtOnce, a bound on this bridge's own work, of which each person holds at most
 * perPersonAtOnce.
 *
 * A token the relay refuses (401 or 403 at /mcp) is answered from memory for a minute, so it costs
 * no further call.
 */
export interface RelayLimits {
  readonly unproven: number;
  readonly unprovenPerClient: number;
  readonly perSignIn: number;
  readonly perPerson: number;
  readonly exchanges: number;
  readonly exchangesPerClient: number;
  readonly registrations: number;
  readonly unprovenAtOnce: number;
  readonly signedInAtOnce: number;
  readonly perPersonAtOnce: number;
}
export const RELAY_LIMITS: RelayLimits = {
  unproven: 20, unprovenPerClient: 10, perSignIn: 20, perPerson: 40, exchanges: 30, exchangesPerClient: 10, registrations: 10,
  unprovenAtOnce: 8, signedInAtOnce: 64, perPersonAtOnce: 2,
};
/** The refusal code when one caller's own limit is reached (an address not signed in, one sign-in, or one person). */
export const RELAY_CALLS_LIMITED = 'relay-calls-limited';
/** The refusal code when the bridge's own limit is reached, or the relay itself answers 429. */
export const RELAY_BUSY = 'relay-busy';
const MINUTE_MS = 60_000;
const EXCHANGE_WINDOW_MS = 15 * MINUTE_MS;
const REGISTRATION_WINDOW_MS = 60 * MINUTE_MS;
/** How long a token the relay refused is answered from memory. */
const REFUSED_TOKEN_MS = MINUTE_MS;
/** How long a token the relay accepted in a sign counts as signed in here: no access token it issues lasts longer. */
const ACCEPTED_TOKEN_MS = SIGN_IN_MAX_SECONDS * 1000;
/** The most tokens each memory holds, and windows the counter keeps; the ones already over go first, then the oldest. */
const TOKEN_MEMORY_MAX = 4096;
const WINDOWS_MAX = 4096;

/**
 * Fixed windows, one per key, each `spanMs` long from the first call admitted under it. A key with
 * no colon is a bridge-wide one (the minute's unproven calls, the exchanges, the registrations): it
 * is never dropped to make room, so no number of callers can reset the bridge's own budgets.
 */
class Windows {
  private readonly counts = new Map<string, { start: number; n: number; span: number }>();
  constructor(private readonly now: () => number) {}
  /** Seconds until `cost` more fit under `limit` for `key`: 0 when they fit now. */
  wait(key: string, limit: number, cost: number, spanMs: number): number {
    const t = this.now();
    const c = this.counts.get(key);
    const live = c !== undefined && t - c.start < c.span;
    if ((live ? c.n : 0) + cost <= limit) return 0;
    return live ? Math.max(1, Math.ceil((c.start + c.span - t) / 1000)) : Math.ceil(spanMs / 1000);
  }
  take(key: string, cost: number, spanMs: number): void {
    const t = this.now();
    const c = this.counts.get(key);
    if (c !== undefined && t - c.start < c.span) { c.n += cost; return; }
    this.counts.delete(key);
    if (this.counts.size >= WINDOWS_MAX) for (const [k, v] of this.counts) if (t - v.start >= v.span) this.counts.delete(k);
    for (const k of this.counts.keys()) {
      if (this.counts.size < WINDOWS_MAX) break;
      if (k.includes(':')) this.counts.delete(k);
    }
    this.counts.set(key, { start: t, n: cost, span: spanMs });
  }
}

/** Token hashes, each with the time it is remembered until and a tag; bounded, the ones already over dropped first, then the oldest. */
class TokenMemory {
  private readonly kept = new Map<string, { readonly until: number; readonly tag: string }>();
  constructor(private readonly now: () => number) {}
  /** The tag `h` is remembered with, or null. */
  get(h: string): string | null {
    const k = this.kept.get(h);
    if (k === undefined) return null;
    if (k.until > this.now()) return k.tag;
    this.kept.delete(h);
    return null;
  }
  add(h: string, ttlMs: number, tag = ''): void {
    this.kept.delete(h);
    if (!(ttlMs > 0)) return;
    const t = this.now();
    if (this.kept.size >= TOKEN_MEMORY_MAX) for (const [k, v] of this.kept) if (v.until <= t) this.kept.delete(k);
    this.kept.set(h, { until: t + ttlMs, tag });
    while (this.kept.size > TOKEN_MEMORY_MAX) { const first = this.kept.keys().next(); if (first.done) break; this.kept.delete(first.value); }
  }
  /** Give `h`, while it is remembered, the tag `tag`, until the same time. */
  retag(h: string, tag: string): void {
    const k = this.kept.get(h);
    if (k !== undefined && k.until > this.now()) this.kept.set(h, { until: k.until, tag });
  }
  delete(h: string): void { this.kept.delete(h); }
}

/**
 * Who a relay call is made for: the client's address; the hash of an access token the relay
 * accepted here (or null); and the person that token is for, once a sign with it has named them
 * (or null).
 */
interface Caller { readonly client: string; readonly signIn: string | null; readonly person: string | null }
/** What a relay call is: a code exchange and a registration are counted in windows of their own too. */
type CallKind = 'call' | 'exchange' | 'registration';
/** One window a relay call is counted in: its key, limit and span, whose limit it is, and what it counts. */
interface Counted { readonly key: string; readonly limit: number; readonly span: number; readonly who: 'bridge' | 'caller'; readonly what: string }
const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const clientOf = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

export interface InteregoUiOptions {
  /** The relay a person signs in through (PEV_RELAY_URL), e.g. https://relay.interego.xwisee.com. */
  readonly relayUrl: string;
  /** This bridge's public base URL (BRIDGE_DEPLOYMENT_URL): the client id and the redirect URI are on it. */
  readonly deploymentUrl: string;
  /**
   * The fetch every relay call goes through. server.ts passes `relayCallFetch(fetch)`: SSRF-guarded
   * (unless the operator's relay is on loopback), size-capped, refusing every redirect. Tests pass
   * a relay of their own.
   */
  readonly relayFetch: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * The relay-delegation policy the handlers check acts with (server.ts passes the same one, so its
   * DID-document cache is shared): the first sign that succeeds with a token names its person with
   * it, the user its agent belongs to. Without it, or when the agent's document cannot be read, the
   * agent stands for the person.
   */
  readonly relayDelegation?: RelayDelegationPolicy;
  /** How many relay calls this bridge makes, and for whom (`RELAY_LIMITS` unless a test sets others), and the clock they are counted by. */
  readonly limits?: Partial<RelayLimits>;
  readonly now?: () => number;
}

/** What the page needs to send a person to the relay's sign-in page. */
interface StartConfig {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly resource: string;
  readonly registration: 'client-id-metadata-document' | 'dynamic-registration';
  readonly relay: string;
}

interface RelayMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | null;
  readonly cimd: boolean;
}

/** A refusal to send as it is: the status, the shared refusal shape, and any extra fields. */
class Declined extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly extra: Readonly<Record<string, unknown>> = {}) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** An OAuth authorization code: visible ASCII (RFC 6749 VSCHAR, no space). */
const CODE = /^[\x21-\x7e]{8,512}$/;
/** A PKCE code verifier (RFC 7636 §4.1). */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** The state the page makes: base64url, 16 to 128 characters. */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** A bearer token (RFC 6750 b64token), bounded. */
const BEARER = /^[A-Za-z0-9._~+/-]+=*$/;
const BEARER_MAX = 8192;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
/** An OAuth error code as RFC 6749 spells them; anything else from the relay is not passed on as a code. */
const OAUTH_ERROR = /^[a-z_]{1,64}$/;

/** The bearer of an `Authorization: Bearer <token>` header, or null. */
function bearerOf(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  if (!m || !m[1] || m[1].length > BEARER_MAX || !BEARER.test(m[1])) return null;
  return m[1];
}

/** Text from the relay, with every secret of this call taken out and the rest cut short. */
function scrub(text: unknown, secrets: readonly string[]): string {
  let t = typeof text === 'string' ? text : '';
  for (const s of secrets) if (s.length >= 4) t = t.split(s).join('[withheld]');
  return t.slice(0, 200);
}

/** The body is over `max` bytes, by what it declares or by what was parsed. */
function tooLarge(req: Request, max: number): boolean {
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) return true;
  try { return Buffer.byteLength(JSON.stringify(req.body ?? {}), 'utf8') > max; } catch { return true; }
}

/**
 * The JSON-RPC answer to request `id` in a body from the relay's /mcp: one JSON message (or a
 * batch), or Server-Sent Events, each event's `data:` lines joined, any notification before it
 * passed over. Null when no answer to `id` is there.
 */
export function mcpAnswer(text: string, id: string): Record<string, unknown> | null {
  const t = text.trim();
  const messages: unknown[] = [];
  if (t.startsWith('{') || t.startsWith('[')) {
    try { const v = JSON.parse(t) as unknown; messages.push(...(Array.isArray(v) ? v : [v])); } catch { return null; }
  } else {
    for (const event of t.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { messages.push(JSON.parse(data) as unknown); } catch { /* not a message: passed over */ }
    }
  }
  for (const m of messages) if (isRecord(m) && m['jsonrpc'] === '2.0' && m['id'] === id && ('result' in m || 'error' in m)) return m;
  return null;
}

/** A tools/call result's value as the relay answers it: its structuredContent, or the JSON of its first text. */
function toolValue(result: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(result['structuredContent'])) return result['structuredContent'];
  const text = firstText(result);
  if (text === null) return null;
  try { const v = JSON.parse(text) as unknown; return isRecord(v) ? v : null; } catch { return null; }
}
function firstText(result: Record<string, unknown>): string | null {
  const c: unknown = Array.isArray(result['content']) ? (result['content'] as unknown[])[0] : undefined;
  return isRecord(c) && typeof c['text'] === 'string' ? c['text'] : null;
}

/**
 * The fetch for relay calls that server.ts composes: no redirect is followed (a credential must
 * not follow one anywhere), every answer is read up to `RELAY_MAX_BYTES`, and every target goes
 * through the substrate's SSRF guard unless `privateRelay` (the operator's relay is on loopback,
 * which the guard refuses by design; the origin is the operator's, never a caller's).
 */
export function relayCallFetch(baseFetch: typeof fetch, o: { readonly privateRelay?: boolean; readonly maxBytes?: number } = {}): typeof fetch {
  const noRedirect = (async (input: RequestInfo | URL, init?: RequestInit): Promise<globalThis.Response> => {
    const res = await baseFetch(input, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`the relay answered with a redirect (HTTP ${res.status}), which this bridge does not follow`);
    }
    return res;
  }) as typeof fetch;
  const capped = cappedFetch(noRedirect, o.maxBytes ?? RELAY_MAX_BYTES);
  return o.privateRelay === true ? capped : guardedFetchFn(capped);
}

/** Mount Interego sign-in, or (with no options) routes that say it is off. */
function attachInteregoSignIn(app: Express, o: InteregoUiOptions | undefined): void {
  const paths = ['/ui/oauth/client.json', '/ui/oauth/start', '/ui/oauth/callback', '/ui/oauth/exchange', '/ui/relay/sign'];
  if (o === undefined) {
    const off = (_req: Request, res: Response): void => {
      secure(res);
      res.status(404).json(refuse(404, 'Interego sign-in is not on for this bridge\'s web UI: the operator sets PEV_RELAY_URL and trusts a relay (PEV_TRUSTED_RELAY_ADDRESSES).', 'interego-sign-in-off', { env: 'PEV_RELAY_URL' }));
    };
    for (const p of paths) app.all(p, off);
    return;
  }
  const relayFetch = o.relayFetch;
  const base = o.deploymentUrl.replace(/\/+$/, '');
  const relay = new URL(o.relayUrl);
  const relayBase = relay.href.replace(/\/+$/, '');
  const resource = relay.href;
  const clientIdUrl = `${base}/ui/oauth/client.json`;
  const redirectUri = `${base}/ui/oauth/callback`;
  /** CIMD identifies a client by an https URL with no fragment; a loopback or http deployment registers by DCR. */
  const cimdUsable = ((): boolean => { try { const u = new URL(clientIdUrl); return u.protocol === 'https:' && u.hash === ''; } catch { return false; } })();
  const timeoutMs = o.timeoutMs ?? RELAY_CALL_TIMEOUT_MS;
  const now = o.now ?? ((): number => Date.now());
  const limits: RelayLimits = { ...RELAY_LIMITS, ...o.limits };
  const policy = o.relayDelegation ?? null;
  const windows = new Windows(now);
  /**
   * Access tokens the relay issued or accepted through this bridge (a sign-in it finished, a sign it
   * made), tagged with the person once a sign has named them ('' until then), and ones it refused,
   * by sha256.
   */
  const accepted = new TokenMemory(now);
  const refused = new TokenMemory(now);
  /** Relay calls running now: for callers the relay has not accepted here, for people signed in, and for each person (or sign-in). */
  let unprovenNow = 0;
  let signedInNow = 0;
  const personNow = new Map<string, number>();

  /**
   * The windows a relay call of `kind` for `caller` is counted in. A call with a token the relay
   * accepted here is counted for that sign-in and that person only, in no window anyone else spends
   * (see RelayLimits); every other call, in the bridge's window for callers not signed in and its
   * address's. A code exchange and a registration are counted in their own longer windows as well.
   */
  function windowsFor(caller: Caller, kind: CallKind): Counted[] {
    const w: Counted[] = [];
    if (caller.signIn !== null) {
      w.push({ key: `sign-in:${caller.signIn}`, limit: limits.perSignIn, span: MINUTE_MS, who: 'caller', what: 'relay calls a minute for one sign-in' });
      if (caller.person !== null) w.push({ key: `person:${caller.person}`, limit: limits.perPerson, span: MINUTE_MS, who: 'caller', what: 'relay calls a minute for one person, over all their sign-ins' });
    } else {
      w.push(
        { key: 'unproven', limit: limits.unproven, span: MINUTE_MS, who: 'bridge', what: 'relay calls a minute for callers the relay has not accepted here' },
        { key: `client:${caller.client}`, limit: limits.unprovenPerClient, span: MINUTE_MS, who: 'caller', what: 'relay calls a minute for one address that is not signed in' },
      );
    }
    if (kind === 'exchange') {
      w.push(
        { key: 'exchanges', limit: limits.exchanges, span: EXCHANGE_WINDOW_MS, who: 'bridge', what: 'code exchanges every 15 minutes in all' },
        { key: `exchanges:${caller.client}`, limit: limits.exchangesPerClient, span: EXCHANGE_WINDOW_MS, who: 'caller', what: 'code exchanges every 15 minutes from one address' },
      );
    }
    if (kind === 'registration') w.push({ key: 'registrations', limit: limits.registrations, span: REGISTRATION_WINDOW_MS, who: 'bridge', what: 'client registrations an hour' });
    return w;
  }
  /** Refuse (429), asking the relay nothing, when one more relay call of `kind` for `caller` does not fit now. */
  function check(caller: Caller, kind: CallKind): void {
    let worst: { readonly wait: number; readonly at: Counted } | null = null;
    for (const at of windowsFor(caller, kind)) {
      const wait = windows.wait(at.key, at.limit, 1, at.span);
      if (wait > 0 && (worst === null || wait > worst.wait)) worst = { wait, at };
    }
    if (worst === null) return;
    const { wait, at } = worst;
    throw at.who === 'caller'
      ? new Declined(429, `This bridge's limit of ${at.limit} ${at.what} is reached, so it did not ask the Interego relay; try again in ${wait} s.`, RELAY_CALLS_LIMITED, { retryAfterSeconds: wait })
      : new Declined(429, `This bridge is asking the Interego relay for many people at once and keeps under the relay's own limits (${at.limit} ${at.what}); try again in ${wait} s.`, RELAY_BUSY, { retryAfterSeconds: wait });
  }
  /** Admit one relay call of `kind` for `caller` (check, then count it), or refuse (429). */
  function admit(caller: Caller, kind: CallKind): void {
    check(caller, kind);
    for (const at of windowsFor(caller, kind)) windows.take(at.key, 1, at.span);
  }
  /**
   * Take a place for one relay call for `caller` among those running at once, or refuse (429); the
   * function returned gives it back. A caller the relay has not accepted here takes one of
   * unprovenAtOnce; a person signed in, one of signedInAtOnce, holding at most perPersonAtOnce.
   */
  function hold(caller: Caller): () => void {
    if (caller.signIn === null) {
      if (unprovenNow >= limits.unprovenAtOnce) {
        throw new Declined(429, `This bridge runs at most ${limits.unprovenAtOnce} relay calls at once for callers the relay has not accepted here; try again in a moment.`, RELAY_BUSY, { retryAfterSeconds: 5 });
      }
      unprovenNow += 1;
      return () => { unprovenNow -= 1; };
    }
    const key = caller.person ?? `sign-in:${caller.signIn}`;
    const mine = personNow.get(key) ?? 0;
    if (mine >= limits.perPersonAtOnce) {
      throw new Declined(429, `This bridge runs at most ${limits.perPersonAtOnce} relay calls at once for one person; try again in a moment.`, RELAY_CALLS_LIMITED, { retryAfterSeconds: 1 });
    }
    if (signedInNow >= limits.signedInAtOnce) {
      throw new Declined(429, `This bridge runs at most ${limits.signedInAtOnce} relay calls at once for people signed in, and is waiting on the Interego relay for that many; try again in a moment.`, RELAY_BUSY, { retryAfterSeconds: 1 });
    }
    signedInNow += 1;
    personNow.set(key, mine + 1);
    return () => {
      signedInNow -= 1;
      const left = (personNow.get(key) ?? 1) - 1;
      if (left > 0) personNow.set(key, left);
      else personNow.delete(key);
    };
  }

  /**
   * One relay call of `kind` for `caller`, admitted first (a place among those running at once,
   * then the budgets; 429 beyond either, with the relay asked nothing): within the deadline,
   * capped, its text and its JSON (null when it is not JSON). A 429 from the relay is 429
   * `relay-busy` with the wait it asked for.
   */
  async function relayJson(url: string, init: RequestInit, secrets: readonly string[], caller: Caller, kind: CallKind): Promise<{ readonly status: number; readonly text: string; readonly json: unknown }> {
    const release = hold(caller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      admit(caller, kind);
      const call = (async () => {
        const res = await relayFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        const text = await res.text();
        let json: unknown = null;
        try { json = JSON.parse(text) as unknown; } catch { json = null; }
        return { status: res.status, text, json, retryAfter: res.headers.get('retry-after') };
      })();
      // The call that loses the race to the deadline still settles (its signal aborts it); handled here, so it is not an unhandled rejection.
      call.catch(() => undefined);
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
      });
      const r = await Promise.race([call, deadline]);
      if (r.status === 429) {
        const after = Number(r.retryAfter);
        const wait = Number.isFinite(after) && after >= 1 ? Math.min(Math.ceil(after), 3600) : 60;
        throw new Declined(429, `The Interego relay is limiting how often this bridge asks it; try again in ${wait} s.`, RELAY_BUSY, { retryAfterSeconds: wait });
      }
      return { status: r.status, text: r.text, json: r.json };
    } catch (e) {
      if (e instanceof Declined) throw e;
      throw new Declined(502, `The Interego relay could not be reached: ${scrub(e instanceof Error ? e.message : String(e), secrets)}.`, 'relay-unreachable');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
    }
  }

  /**
   * The person the relay signed `signedPayload` for: the user its agent belongs to (the agent's DID
   * document, read through the cache the handlers use), or, when that cannot be read, the agent
   * itself; '' when the text names no agent. The relay sets the agent from the sign-in of the token
   * it was called with, so no caller can make a token count against someone else.
   */
  async function personOf(signedPayload: string, signature: string, text: Record<string, unknown>): Promise<string> {
    if (policy !== null) {
      try {
        const v = await openRelayDelegated(signedPayload, signature, policy);
        if (v.ok) return `user ${v.principal}`;
      } catch { /* no person named: the agent stands for them */ }
    }
    const agent = text['agent_id'];
    return typeof agent === 'string' && agent !== '' ? `agent ${agent}` : '';
  }

  /** An endpoint the relay's metadata names, held to the relay's own origin. */
  const onRelay = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    try { const u = new URL(v); return u.origin === relay.origin && u.hash === '' ? u.href : null; } catch { return null; }
  };

  let metadataKept: { readonly at: number; readonly value: RelayMetadata } | null = null;
  /** The relay's authorization server metadata (RFC 8414), kept 10 minutes; a failure is not kept. */
  async function metadata(caller: Caller): Promise<RelayMetadata> {
    if (metadataKept && now() - metadataKept.at < METADATA_TTL_MS) return metadataKept.value;
    const r = await relayJson(`${relayBase}/.well-known/oauth-authorization-server`, { method: 'GET', headers: { accept: 'application/json' } }, [], caller, 'call');
    const m = r.json;
    const unusable = (why: string): Declined => new Declined(502, `The Interego relay's sign-in metadata cannot be used: ${why}.`, 'relay-metadata-unusable');
    if (r.status !== 200 || !isRecord(m)) throw unusable(`it answered HTTP ${r.status}`);
    const authorizationEndpoint = onRelay(m['authorization_endpoint']);
    const tokenEndpoint = onRelay(m['token_endpoint']);
    if (authorizationEndpoint === null || tokenEndpoint === null) throw unusable(`its authorization and token endpoints must be on ${relay.origin}`);
    const methods = m['code_challenge_methods_supported'];
    if (!Array.isArray(methods) || !methods.includes('S256')) throw unusable('it does not offer PKCE with S256');
    const types = m['response_types_supported'];
    if (Array.isArray(types) && !types.includes('code')) throw unusable('it does not offer the authorization code flow');
    const value: RelayMetadata = {
      authorizationEndpoint, tokenEndpoint,
      registrationEndpoint: onRelay(m['registration_endpoint']),
      cimd: m['client_id_metadata_document_supported'] === true,
    };
    metadataKept = { at: now(), value };
    return value;
  }

  let registered: Promise<string> | null = null;
  /**
   * This client's id at the relay: the CIMD URL when the relay takes Client ID Metadata Documents
   * and the deployment URL is https; otherwise one registered by DCR, once per process (a failed
   * registration is tried again on the next sign-in).
   */
  async function clientIdFor(meta: RelayMetadata, caller: Caller): Promise<{ readonly clientId: string; readonly registration: StartConfig['registration'] }> {
    if (meta.cimd && cimdUsable) return { clientId: clientIdUrl, registration: 'client-id-metadata-document' };
    if (meta.registrationEndpoint === null) {
      throw new Declined(502, cimdUsable
        ? 'The Interego relay takes neither a Client ID Metadata Document nor a dynamic registration, so this page cannot sign anyone in.'
        : `This bridge's deployment URL (${base}) is not https, so the relay cannot read its Client ID Metadata Document, and the relay offers no dynamic registration.`,
      'relay-registration-unavailable');
    }
    const endpoint = meta.registrationEndpoint;
    registered ??= (async (): Promise<string> => {
      const r = await relayJson(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(clientMetadata(false)),
      }, [], caller, 'registration');
      const id = isRecord(r.json) ? r.json['client_id'] : undefined;
      if ((r.status !== 200 && r.status !== 201) || typeof id !== 'string' || id.length === 0 || id.length > 256) {
        throw new Declined(502, `The Interego relay did not register this page as a client (HTTP ${r.status}).`, 'relay-registration-refused');
      }
      return id;
    })();
    const pending = registered;
    try {
      return { clientId: await pending, registration: 'dynamic-registration' };
    } catch (e) {
      if (registered === pending) registered = null;
      throw e;
    }
  }

  /**
   * The client's metadata: in the CIMD with its client_id, in a DCR request without one. Only the
   * authorization code grant: the page keeps the access token the relay gives it until it expires
   * (an hour) and then signs in again, rather than keep a refresh token (a 14-day credential) in the
   * browser.
   */
  const clientMetadata = (withId: boolean): Record<string, unknown> => ({
    ...(withId ? { client_id: clientIdUrl } : {}),
    client_name: PEV_UI_CLIENT_NAME,
    client_uri: `${base}/ui`,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: INTEREGO_SCOPE,
  });

  const send = (res: Response, e: unknown): void => {
    const d = e instanceof Declined ? e : new Declined(500, 'Interego sign-in failed inside this bridge.', 'interego-sign-in-failed');
    const wait = d.extra['retryAfterSeconds'];
    if (d.status === 429 && typeof wait === 'number') res.setHeader('Retry-After', String(wait));
    res.status(d.status).json({ ...refuse(d.status, d.message, d.code), ...d.extra });
  };

  app.get('/ui/oauth/client.json', (_req: Request, res: Response) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('application/json').send(JSON.stringify(clientMetadata(true), null, 2));
  });

  app.get('/ui/oauth/start', async (req: Request, res: Response) => {
    secure(res);
    try {
      const caller: Caller = { client: clientOf(req), signIn: null, person: null };
      const meta = await metadata(caller);
      const { clientId, registration } = await clientIdFor(meta, caller);
      const out: StartConfig = {
        authorizationEndpoint: meta.authorizationEndpoint, clientId, redirectUri, scope: INTEREGO_SCOPE, resource, registration, relay: relay.origin,
      };
      res.json(out);
    } catch (e) { send(res, e); }
  });

  app.get('/ui/oauth/callback', (_req: Request, res: Response) => {
    secure(res);
    res.type('text/html; charset=utf-8').send(CALLBACK_SHELL);
  });

  app.post('/ui/oauth/exchange', async (req: Request, res: Response) => {
    secure(res);
    try {
      if (tooLarge(req, EXCHANGE_BODY_MAX_BYTES)) throw new Declined(413, `A code exchange is at most ${EXCHANGE_BODY_MAX_BYTES} bytes.`, 'payload-too-large');
      const b = isRecord(req.body) ? req.body : {};
      const code = b['code'];
      const verifier = b['code_verifier'];
      const state = b['state'];
      if (typeof code !== 'string' || !CODE.test(code)) throw new Declined(400, 'code must be the authorization code the relay sent back (8 to 512 visible characters).', 'oauth-code-shape');
      if (typeof verifier !== 'string' || !VERIFIER.test(verifier)) throw new Declined(400, 'code_verifier must be a PKCE verifier: 43 to 128 letters, digits, ".", "_", "~" or "-".', 'pkce-verifier-shape');
      // The page checks the state against the one it sent; the bridge holds none and checks its form.
      if (typeof state !== 'string' || !STATE.test(state)) throw new Declined(400, 'state must be the state the page sent: 16 to 128 base64url characters.', 'oauth-state-shape');
      // A code exchange is made for no token the relay has accepted: it is counted per address and
      // in all, a minute, and in the 15-minute windows the relay's token endpoint is kept under. One
      // that would not be admitted asks the relay nothing, the set-up's calls included.
      const caller: Caller = { client: clientOf(req), signIn: null, person: null };
      check(caller, 'exchange');
      const meta = await metadata(caller);
      const { clientId } = await clientIdFor(meta, caller);
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource });
      const t = await relayJson(meta.tokenEndpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString(),
      }, [code, verifier], caller, 'exchange');
      const tj = isRecord(t.json) ? t.json : {};
      if (t.status !== 200) {
        const err = typeof tj['error'] === 'string' && OAUTH_ERROR.test(tj['error']) ? tj['error'] : null;
        throw new Declined(400, `The Interego relay did not take this sign-in's code${err ? ` (${err})` : ''}: ${scrub(tj['error_description'], [code, verifier]) || `HTTP ${t.status}`}. Sign in again.`,
          'oauth-code-refused', err ? { relayError: err } : {});
      }
      const access = tj['access_token'];
      const tokenType = tj['token_type'];
      if (typeof access !== 'string' || bearerOf(`Bearer ${access}`) === null) throw new Declined(502, 'The Interego relay answered the code with no usable access token.', 'relay-token-unusable');
      if (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer') {
        throw new Declined(502, `The Interego relay issued a ${scrub(tokenType, [access])} token, which this page cannot present.`, 'relay-token-unusable');
      }
      // sign_request is one of the relay's write-side tools: a token granted only mcp:read cannot sign.
      const granted = typeof tj['scope'] === 'string' ? tj['scope'].split(/\s+/) : null;
      if (granted !== null && !granted.includes('mcp') && !granted.includes('mcp:write')) {
        throw new Declined(502, `The Interego relay gave this sign-in no write scope, so it cannot sign acts (it asked for "${INTEREGO_SCOPE}").`, 'relay-token-unusable');
      }
      // How long the page keeps it: what the relay says, never more than an hour, and never longer
      // than the relay said. The refresh token the relay may send as well is not read, kept or passed on.
      const said = tj['expires_in'];
      if (typeof said === 'number' && !(said >= 1)) {
        throw new Declined(502, 'The Interego relay said this sign-in\'s access token expires in under a second, so it is already spent. Sign in again.', 'relay-token-unusable');
      }
      const expiresIn = typeof said === 'number' ? Math.min(Math.floor(said), SIGN_IN_MAX_SECONDS) : SIGN_IN_MAX_SECONDS;
      // The relay issued it here: its signs count against its own sign-in from now until it expires
      // (and against its person, once its first sign names them), not against callers not signed in.
      const h = tokenHash(access);
      refused.delete(h);
      accepted.add(h, expiresIn * 1000);
      res.json({
        signedIn: true, accessToken: access, expiresIn, relay: relay.origin,
        note: 'Keep this token in this tab only, forget it when it expires, and send it only to this bridge\'s ui/relay/sign. It is the Interego relay\'s access token for this sign-in: until it expires, whoever holds it can call the relay\'s tools as you, and it passes through this bridge on every act it signs.',
      });
    } catch (e) { send(res, e); }
  });

  app.post('/ui/relay/sign', async (req: Request, res: Response) => {
    secure(res);
    try {
      const bearer = bearerOf(req.headers.authorization);
      if (bearer === null) {
        throw new Declined(401, 'Sign in with your Interego account first: this route takes the access token the sign-in gave this page, as Authorization: Bearer.', 'interego-bearer-missing');
      }
      if (tooLarge(req, SIGN_PAYLOAD_MAX_BYTES)) throw new Declined(413, `A payload to sign is at most ${SIGN_PAYLOAD_MAX_BYTES} bytes.`, 'payload-too-large');
      const payload = isRecord(req.body) ? req.body['payload'] : undefined;
      if (!isRecord(payload) || payload['v'] !== 1 || typeof payload['action'] !== 'string' || !payload['action'].startsWith('urn:iep:action:pev:')) {
        throw new Declined(400, 'payload must be an unsigned practice-evidence act: {v: 1, action: urn:iep:action:pev:…, nonce, podUrl, …}. This route signs nothing else.', 'payload-shape');
      }
      if (typeof payload['nonce'] !== 'string') throw new Declined(400, 'payload.nonce must be a fresh nonce.', 'payload-shape');
      const expired = (): Declined => new Declined(401, 'The Interego relay did not accept your sign-in (it may have expired). Sign in again.', 'interego-sign-in-expired');
      // A token the relay refused in the last minute is refused again from memory, at no relay call.
      const h = tokenHash(bearer);
      if (refused.get(h) !== null) throw expired();
      // A sign with a token the relay accepted here counts against that sign-in and its person
      // alone; any other token is a caller not signed in, from its address.
      const known = accepted.get(h);
      const caller: Caller = { client: clientOf(req), signIn: known !== null ? h : null, person: known !== null && known !== '' ? known : null };
      // One MCP tools/call with no initialize: the relay serves a request with no session as a
      // stateless one, and names the session's agent itself (agent_id), from the token.
      const rpcId = randomUUID();
      const r = await relayJson(`${relayBase}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 'sign_request', arguments: { payload } } }),
      }, [bearer], caller, 'call');
      if (r.status === 401 || r.status === 403) {
        accepted.delete(h);
        refused.add(h, REFUSED_TOKEN_MS);
        throw expired();
      }
      const notSigned = (why: string): Declined => new Declined(502, `The Interego relay did not sign this act: ${why}.`, 'relay-refused-signing');
      if (r.status !== 200) {
        const said = isRecord(r.json) && typeof r.json['error'] === 'string' ? scrub(r.json['error'], [bearer]) : '';
        throw notSigned(said ? `${said} (HTTP ${r.status})` : `HTTP ${r.status}`);
      }
      const answer = mcpAnswer(r.text, rpcId);
      if (answer === null) throw notSigned('its answer held no JSON-RPC answer to this request');
      if ('error' in answer) {
        const e = answer['error'];
        throw notSigned(isRecord(e) && typeof e['message'] === 'string' ? scrub(e['message'], [bearer]) || 'a JSON-RPC error' : 'a JSON-RPC error');
      }
      const result = isRecord(answer['result']) ? answer['result'] : {};
      const j = toolValue(result);
      const relayError = j !== null && typeof j['error'] === 'string' ? j['error'] : null;
      if (relayError === 'insufficient_scope') throw notSigned(`it gave this sign-in no write scope (it asked for "${INTEREGO_SCOPE}")`);
      if (result['isError'] === true || relayError !== null || j === null) {
        throw notSigned(scrub(relayError ?? firstText(result), [bearer]) || 'its answer was not a signed request');
      }
      const signedPayload = j['_signed_payload'];
      const signature = j['_signature'];
      if (typeof signedPayload !== 'string' || signedPayload.length === 0 || signedPayload.length > 64 * 1024 || typeof signature !== 'string' || !SIGNATURE.test(signature)) {
        throw new Declined(502, 'The Interego relay answered without a signed request.', 'relay-refused-signing');
      }
      // The relay signs the caller's own fields; what it returns must be this act, not another.
      let signed: unknown;
      try { signed = JSON.parse(signedPayload) as unknown; } catch { signed = null; }
      if (!isRecord(signed) || signed['action'] !== payload['action'] || signed['nonce'] !== payload['nonce']) {
        throw new Declined(502, 'The Interego relay signed something other than this act.', 'relay-signed-something-else');
      }
      // The relay signed this act with the token, so it is a sign-in here: kept as long as it was (a
      // token this bridge's exchange issued, until it expires), and otherwise for at most the
      // relay's hour. Its first sign names its person, so from now on its calls count against
      // them too, over all their sign-ins. A token a concurrent sign found refused meanwhile is
      // not taken back.
      const tag = accepted.get(h);
      if (tag === null || tag === '') {
        const person = await personOf(signedPayload, signature, signed);
        if (refused.get(h) === null) {
          if (accepted.get(h) === null) accepted.add(h, ACCEPTED_TOKEN_MS, person);
          else if (person !== '') accepted.retag(h, person);
        }
      }
      res.json({ _signature: signature, _signed_payload: signedPayload });
    } catch (e) { send(res, e); }
  });
}

/**
 * A body these routes cannot read (not JSON, or over the parser's limit) answered as a refusal,
 * not as the framework's HTML error page. Registered after the body parser, so its errors reach it.
 */
function uiBodyErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(err); return; }
  const status = isRecord(err) && err['status'] === 413 ? 413 : 400;
  secure(res);
  res.status(status).json(refuse(status, status === 413 ? 'The request body is over this bridge\'s limit.' : 'The request body is not JSON this route can read.', status === 413 ? 'payload-too-large' : 'body-unreadable'));
}

/**
 * A browser asking for a page: no ?format=, and text/html is its best match among what this bridge
 * serves at /. `*\/*`, a missing Accept and Node fetch's default all resolve to JSON-LD, the first
 * listed, so agents keep the factory's entry point; a browser's Accept resolves to text/html.
 */
export function wantsLandingPage(req: Request): boolean {
  if (req.query['format'] !== undefined) return false;
  return req.accepts(['application/ld+json', 'application/json', 'text/turtle', 'text/markdown', 'text/html']) === 'text/html';
}

/**
 * Mount the landing page at / (browsers only), GET /ui, /ui/app.js, /ui/app.css, the guide at
 * /ui/help, its script and the favicon, and the Interego sign-in routes (or their refusals).
 */
export function attachUi(app: Express, o: { readonly interego?: InteregoUiOptions } = {}): void {
  // First, so it runs before the factory's own GET / (registered after this hook); anything but a
  // browser's page request falls through to it unchanged.
  app.get('/', (req: Request, res: Response, next: NextFunction) => {
    if (!wantsLandingPage(req)) { next(); return; }
    secure(res);
    res.vary('Accept');
    res.type('text/html; charset=utf-8').send(LANDING_HTML);
  });
  app.get('/ui', (req: Request, res: Response) => {
    // The shell's URLs are relative to /ui; at /ui/ they would resolve one level too deep.
    if (req.path.endsWith('/')) { res.redirect(301, '../ui'); return; }
    secure(res);
    res.type('text/html; charset=utf-8').send(SHELL);
  });
  app.get('/ui/app.js', (_req: Request, res: Response) => { secure(res); res.type('text/javascript; charset=utf-8').send(APP_JS); });
  app.get('/ui/app.css', (_req: Request, res: Response) => { secure(res); res.type('text/css; charset=utf-8').send(APP_CSS); });
  app.get('/ui/help', (req: Request, res: Response) => {
    // Its URLs are relative to /ui/help, as the shell's are to /ui.
    if (req.path.endsWith('/')) { res.redirect(301, '../help'); return; }
    secure(res);
    res.type('text/html; charset=utf-8').send(HELP_HTML);
  });
  app.get('/ui/help.js', (_req: Request, res: Response) => { secure(res); res.type('text/javascript; charset=utf-8').send(HELP_JS); });
  app.get('/ui/favicon.svg', (_req: Request, res: Response) => { secure(res); res.type('image/svg+xml').send(FAVICON_SVG); });
  attachInteregoSignIn(app, o.interego);
  app.use('/ui', uiBodyErrors);
}

/** Refuse any request whose Host header (lowercased) is not in `allowed`. */
export function hostAllowlistGuard(allowed: readonly string[]): (req: Request, res: Response, next: NextFunction) => void {
  const names = new Set(allowed.map((h) => h.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (names.has(host)) { next(); return; }
    res.status(421).json(refuse(421, 'This bridge does not answer for that host name.', 'host-not-served'));
  };
}
