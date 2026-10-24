/**
 * The work-redesign web pages: static assets served from the bridge itself, each read once when
 * the UI is attached.
 *
 *   GET /                 for a browser (an Accept that names text/html, names no Markdown and ranks
 *                         no JSON or RDF type as high; no ?format=): the landing page
 *                         (./ui/landing.html, filled by landing.ts, prefersHtml); everyone else falls
 *                         through to the factory's JSON-LD / HMD entry point, unchanged
 *   GET /ui               the HTML shell of the app — no inline script, no inline style, no style attribute
 *   GET /ui/app.js        the browser client (./ui/app.js)
 *   GET /ui/app.css       the design system plus bridge/ui/app.css, including the print layout for one decision
 *   GET /ui/help          the guide (./ui/help.html): how to use Work Redesign, by role; no script
 *   GET /ui/favicon.svg   the Interego mark
 *
 * The UI adds no data endpoint. The client reads the affordance manifest
 * (`GET /affordances?format=jsonld`) and calls only the targets it declares, like any Path-A
 * agent: every number on the page comes from an affordance response, and every change is a
 * signed envelope the bridge verifies. Keys stay where they are: in the person's own wallet,
 * or — only in the offline demo — on the demo server, which the page says on every screen.
 *
 * "Sign in with your Interego account" (attachInteregoSignIn, below) adds the routes a person with
 * no key signs in through. They carry the OAuth exchange and the relay's signature through this
 * origin, so the page's connect-src stays 'self', and none of them reads or writes a record:
 *
 *   GET  /ui/oauth/client.json  the Client ID Metadata Document this UI signs in as ("Work Redesign")
 *   GET  /ui/oauth/config       what the page needs to send a person to the relay's sign-in page
 *   GET  /ui/oauth/callback     the page the relay sends the person back to (the same shell)
 *   POST /ui/oauth/exchange     {code, code_verifier, state} → the relay's OAuth access token, server-side
 *   POST /ui/relay/sign         {payload} + that token → the relay's {_signature, _signed_payload}, from its
 *                               MCP endpoint (tools/call sign_request at <relay>/mcp)
 *   POST /ui/relay/whoami       a relay-signed request → the person it is for, as the handlers name them
 *
 * RELAY-ATTESTED, NOT USER-HELD, AND THE TOKEN PASSES THROUGH THIS BRIDGE. The relay signs each act
 * for the person with its delegation key. The page holds the relay's own OAuth access token for
 * the sign-in (about an hour), and sends it with every signature through POST /ui/relay/sign,
 * which presents it at the relay's /mcp as any MCP client does; for that hour it lets its holder
 * call the relay's tools as the person, and the relay's GET /identity-token trades it for the
 * identity server's bearer behind the sign-in (up to a day; it links a wallet, removes sign-in
 * methods, deletes the account). Nothing here calls /identity-token or the REST /tool/ routes, and
 * the refresh token the relay's token answer carries is dropped, but that is what this code does,
 * not a boundary: no narrower token can sign (sign_request takes the scope mcp or mcp:write, and
 * /identity-token takes exactly those), so whoever runs this bridge, or holds a copy of the token,
 * is trusted with the person's account for up to a day, past the hour and past sign-out. The
 * token is never logged, stored, echoed or put in a URL here (only its sha256 is kept, to count
 * its relay calls and to remember a token the relay refused).
 *
 * EVERY CALL THIS BRIDGE MAKES TO THE RELAY COMES FROM ITS ONE ADDRESS, and the relay limits some
 * routes per client address before it checks any credential (its token endpoint takes 50 requests
 * every 15 minutes, its registration endpoint 20 an hour). So whoever makes this bridge call the
 * relay spends what everyone signing in here shares. RelayLimits, below, keeps the bridge under
 * those limits, keeps a caller the relay has not accepted from spending what people already signed
 * in need, and puts every signed-in person's calls in budgets of their own, so no one with an
 * Interego account can spend another's either; a limit reached is 429 with retryAfterSeconds and a
 * code. The client address is req.ip: server.ts trusts one proxy hop when it does not listen on
 * loopback, and WRD_TRUST_PROXY_HOPS sets another number.
 *
 * Every page and asset answer carries the same Content-Security-Policy: scripts, styles and connections
 * from this origin only, no inline script or style, no framing. Because `style-src 'self'`
 * has no 'unsafe-inline', the client sets widths through the CSSOM (allowed) and never
 * writes a style attribute or innerHTML.
 *
 * `hostAllowlistGuard` refuses (421) any request whose Host header is not one of the names the
 * bridge is served under. A loopback bridge holds a signing key and answers unauthenticated
 * reads of every record on its pod — and the demo server also holds the personas' keys and signs
 * for them — so without it a page on another site could rebind its own DNS name to 127.0.0.1
 * and read or act as that origin. Cross-site POSTs are already blocked by the JSON-only body
 * parser and the absence of CORS headers; this closes the rebinding path. Both compositions
 * install it first in their `middleware` hook, which the shared factory runs before every route
 * except its build-identity `/health`.
 *
 * `parseEveryQueryPair` makes the app parse every parameter of a query string. Express's default
 * parser keeps the first 1000 pairs (empty ones count) and drops the rest without a word, so a
 * signed read placed after them would never reach the GET wrd.envelope_template's check and would
 * be answered 200 from a URL that logs keep. Both compositions install it in their hook.
 *
 * No environment reads; bridge/server.ts and demo/run.ts attach this.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseQueryString } from 'node:querystring';
import type { Express, NextFunction, Request, Response } from 'express';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';
import { isEnvelopeIntent } from '../src/payloads.js';
import { openRelayDelegated, relayEnvelopeOf, type RelayDelegationPolicy } from '../src/relay-delegated.js';
import { cappedText, type CappedAnswer } from './relay-sign-in.js';
import { designSystemCss } from '../../_shared/design-system/index.js';
import { FAVICON_SVG, prefersHtml, renderSitePage, siteValues, SIBLING, type LandingOptions } from './landing.js';

export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** HTML-safe text for an attribute or element body (the shell interpolates the base URL, its loading line and the sibling's address). */
const htmlText = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(base: string, loading = 'Loading Work Redesign…', siblingUrl: string = SIBLING.url, reads?: UiReads): string {
  const b = htmlText(base);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Work Redesign</title>',
    '<meta name="description" content="Decide which work to hand to AI, price the change honestly, and keep a signed record your people can check.">',
    '<meta name="color-scheme" content="light dark">',
    `<meta name="wrd-sibling-name" content="${htmlText(SIBLING.name)}">`,
    `<meta name="wrd-sibling-url" content="${htmlText(siblingUrl)}">`,
    // Told how this bridge answers reads, the page asks for no unsigned read it knows is refused (401).
    reads ? `<meta name="wrd-reads" content="${reads}">` : null,
    '<link rel="icon" href="/ui/favicon.svg" type="image/svg+xml">',
    '<link rel="stylesheet" href="/ui/app.css">',
    `<link rel="alternate" type="text/turtle" href="${b}/affordances" title="Action manifest for AI agents">`,
    '<script type="module" src="/ui/app.js"></script>',
    '</head>',
    '<body class="product-wrd">',
    '<a class="skip-link" href="#main">Skip to content</a>',
    '<noscript><div class="auth"><div class="auth__card"><h1 class="auth__title">Work Redesign needs JavaScript</h1><p class="auth__text">Turn JavaScript on and reload this page to sign in. ',
    `You can read <a href="/ui/help">how Work Redesign works</a> without it. (For AI agents: the action manifest is at <a href="${b}/affordances">${b}/affordances</a>.)</p></div></div></noscript>`,
    `<div id="app" class="app"><div class="auth"><div class="auth__card" aria-busy="true"><span class="spinner" aria-hidden="true"></span><p class="auth__text">${htmlText(loading)}</p></div></div></div>`,
    '<div class="toast-region" id="toasts" role="status" aria-live="polite" aria-label="Notifications"></div>',
    '<div id="print" class="print-only"></div>',
    '</body>',
    '</html>',
    '',
  ].filter((line) => line !== null).join('\n');
}


function secure(res: Response): void {
  res.setHeader('Content-Security-Policy', UI_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

/** How this bridge answers reads: 'signed' when unsigned reads are refused (no WRD_PUBLIC_READS), 'public' when its operator opened them. */
export type UiReads = 'signed' | 'public';

/**
 * Mount the web pages and the sign-in routes (attachInteregoSignIn): GET /ui (the app), /ui/app.js,
 * /ui/app.css (the design system plus bridge/ui/app.css), /ui/help (the guide), /ui/favicon.svg,
 * and GET / for a browser (the landing page; an agent's request falls through to the factory's
 * entry point). `base` is the bridge's public base URL; `signIn`, the relay a person signs in
 * through (absent: every sign-in route says it is not set up, and the page offers no sign-in);
 * `landing`, the contact link, legal name, sibling address and record sealing the pages show (defaults
 * in landing.ts); `reads`, how the bridge answers reads (absent: the page asks, as before).
 */
export function attachUi(app: Express, opts: { readonly base: string; readonly signIn?: UiSignIn; readonly landing?: LandingOptions; readonly reads?: UiReads }): void {
  const appJs = readFileSync(new URL('./ui/app.js', import.meta.url), 'utf8');
  const appCss = `${designSystemCss()}\n${readFileSync(new URL('./ui/app.css', import.meta.url), 'utf8')}`;
  const base = opts.base.replace(/\/$/, '');
  const values = siteValues({ base, ...(opts.signIn ? { signIn: opts.signIn } : {}), ...(opts.landing ? { landing: opts.landing } : {}) });
  const siblingUrl = values['sibling_url'] ?? SIBLING.url;
  const landingPage = renderSitePage(readFileSync(new URL('./ui/landing.html', import.meta.url), 'utf8'), values);
  const helpPage = renderSitePage(readFileSync(new URL('./ui/help.html', import.meta.url), 'utf8'), values);
  const html = shell(base, undefined, siblingUrl, opts.reads);
  app.get('/ui', (_req, res) => { secure(res); res.type('text/html; charset=utf-8').send(html); });
  app.get('/ui/app.js', (_req, res) => { secure(res); res.type('text/javascript; charset=utf-8').send(appJs); });
  app.get('/ui/app.css', (_req, res) => { secure(res); res.type('text/css; charset=utf-8').send(appCss); });
  app.get('/ui/help', (_req, res) => { secure(res); res.type('text/html; charset=utf-8').send(helpPage); });
  app.get('/ui/favicon.svg', (_req, res) => { secure(res); res.type('image/svg+xml; charset=utf-8').send(FAVICON_SVG); });
  // The landing page, for a browser only: ?format= and every agent's Accept fall through to the factory's entry point.
  app.get('/', (req, res, next) => {
    res.vary('Accept');
    if (req.query['format'] !== undefined) { next(); return; }
    if (!prefersHtml(req)) { next(); return; }
    secure(res);
    res.type('text/html; charset=utf-8').send(landingPage);
  });
  attachInteregoSignIn(app, { base, ...(opts.signIn ? { signIn: opts.signIn } : {}), siblingUrl, ...(opts.reads ? { reads: opts.reads } : {}) });
}

// ── Sign in with your Interego account ───────────────────────────────────────────────────

/** The relay this UI signs a person in through, and what a relay-signed request is checked against. */
export interface UiSignIn {
  /** The relay's base URL (WRD_RELAY_URL), with no trailing slash. */
  readonly relayUrl: string;
  /**
   * The verifier's policy, the one the handlers use: POST /ui/relay/whoami names the person a
   * relay-signed request is for with it. Null when this bridge trusts no relay: then no act the
   * relay signed would be taken, and the page offers no sign-in.
   */
  readonly policy: RelayDelegationPolicy | null;
  /** How the bridge reaches the relay (default: fetch). Every call is time-limited, size-capped and follows no redirect. */
  readonly fetchFn?: RelayFetch;
  /** How long one call to the relay may take (default SIGN_IN_TIMEOUT_MS). */
  readonly timeoutMs?: number;
  /** How many relay calls this bridge makes, and for whom (RELAY_LIMITS unless a test sets others). */
  readonly limits?: Partial<RelayLimits>;
  /** The clock the limits and the token memories are kept by, in ms (default Date.now). */
  readonly now?: () => number;
}

/**
 * How many calls this bridge makes to the relay, and for whom. Every call comes from the bridge's
 * one address, and the relay limits its token endpoint to 50 requests every 15 minutes and its
 * registration endpoint to 20 an hour per client address, before it checks any credential (it sets
 * no per-address limit on /mcp, where each made-up token still costs it a token check). These keep
 * the bridge well under those limits, keep a caller with no sign-in from spending the calls that
 * people already signed in need, and keep each person signed in from spending another's:
 *
 *   unproven           calls made for no access token the relay has accepted here, a minute, in
 *                      all: a code exchange, the sign-in set-up (the relay's metadata, a
 *                      registration), a sign with a token the relay has not accepted from this
 *                      bridge. These are the only calls a stranger can make.
 *   unprovenPerClient  of those, from one client address (req.ip), a minute
 *   perSignIn          calls for one access token the relay accepted here, a minute
 *   perPerson          calls for one person, a minute, over every token of theirs the relay
 *                      accepted here (the person is the user the relay's signed text names, as
 *                      POST /ui/relay/whoami names them, learned at the first sign with a token)
 *   exchanges          code exchanges at the relay's token endpoint, every 15 minutes, in all
 *   exchangesPerClient of those, from one client address
 *   registrations      client registrations at the relay, an hour (once per process when it works)
 *   unprovenAtOnce     relay calls running at once for callers the relay has not accepted here
 *   signedInAtOnce     relay calls running at once for people signed in, in all
 *   perPersonAtOnce    of those, for one person (or one sign-in whose person no sign has named yet)
 *
 * A call made with a token the relay accepted here counts in no minute budget shared with anyone
 * else: the relay keeps no per-address limit on /mcp for such a budget to stay under, and whoever
 * holds the token can call the relay's /mcp directly at any rate, so a cap over every signed-in
 * call would protect nothing and would let anyone with an Interego account (sign-up is open) stop
 * everyone else's signing with a few tokens. The one thing people signed in share is
 * signedInAtOnce, a bound on the bridge's own work, of which each person holds at most
 * perPersonAtOnce.
 *
 * A token the relay refused (401 or 403 at /mcp) is refused again from memory for a minute, with no
 * relay call. POST /ui/relay/whoami makes no relay call (it checks the relay's signature itself and
 * reads only the agent's DID document on the identity host), so it is not counted here; it has a
 * bound of its own on how many run at once.
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
/** How long a token the relay refused is refused again from memory. */
const REFUSED_TOKEN_MS = MINUTE_MS;
/** The most tokens each memory holds, and windows the counter keeps; the ones already over go first, then the oldest. */
const TOKEN_MEMORY_MAX = 4096;
const WINDOWS_MAX = 4096;
/** How many POST /ui/relay/whoami run at once (it calls no relay, so it holds no relay call's place). */
const WHOAMI_AT_ONCE = 16;

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
const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const clientOf = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';
/** What a call to the relay is sent with. */
export interface RelayRequest {
  readonly method: 'GET' | 'POST';
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly redirect: 'error';
  readonly signal: AbortSignal;
}
export type RelayFetch = (url: string, init: RelayRequest) => Promise<CappedAnswer>;

export const SIGN_IN_PATHS = {
  client: '/ui/oauth/client.json', config: '/ui/oauth/config', callback: '/ui/oauth/callback',
  exchange: '/ui/oauth/exchange', sign: '/ui/relay/sign', whoami: '/ui/relay/whoami',
} as const;
/** The client name the relay sees. It slugifies it into the agent of the session, work-redesign-<user id>: the slug the handlers take decisive acts from. */
export const SIGN_IN_CLIENT_NAME = 'Work Redesign';
/** The scope asked for: the relay's full scope. Its write-side tools, sign_request among them, refuse a token with mcp:read alone. */
export const SIGN_IN_SCOPE = 'mcp';
export const SIGN_IN_TIMEOUT_MS = 8_000;
/** The most a request to the sign or whoami route may carry (a relay-signed text is at most 64 KiB). */
export const SIGN_IN_MAX_BYTES = 64 * 1024;
const EXCHANGE_MAX_BYTES = 4 * 1024;
const RELAY_ANSWER_MAX_BYTES = 256 * 1024;
const DISCOVERY_TTL_MS = 10 * 60_000;

const CODE = /^[\x21-\x7e]{1,512}$/;
/** RFC 7636: 43 to 128 unreserved characters. */
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const STATE = /^[A-Za-z0-9\-._~]{16,128}$/;
const TOKEN = /^[\x21-\x7e]{1,8192}$/;
const BEARER = /^Bearer ([\x21-\x7e]{1,8192})$/i;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
/** The relay's MCP endpoint and the one tool the bridge calls there. */
const RELAY_MCP_PATH = '/mcp';
const SIGN_TOOL = 'sign_request';
/** The most an access token's lifetime is taken as, whatever the relay says (the relay's own is an hour). */
const MAX_TOKEN_SECONDS = 24 * 3600;
/** The relay's access token lifetime when its token answer says none (deploy/mcp-relay: tokenTtlSec, 3600). */
const DEFAULT_TOKEN_SECONDS = 3600;
/** Keys the relay sets itself or drops from what it signs (handleSignRequest): a payload holding one would not be signed as sent. */
const RELAY_SETS = new Set(['agent_id', 'timestamp', 'subject_pod_url', 'payload', 'pod_name', 'owner_webid', 'owner_name']);

const NOT_SET_UP = 'This bridge is not set up for signing in with an Interego account.';
const RELAY_DOWN = 'The Interego relay could not be reached for sign-in.';
const BAD_EXCHANGE = 'The sign-in could not be finished: this is not what the relay sent back.';
const NOT_SIGNED_IN = 'Sign in with your Interego account first.';
const RELAY_REFUSED = 'The Interego relay did not accept your sign-in. Sign in again.';
const SIGN_IN_ENDED = 'Your Interego sign-in has ended: sign in again.';
const NOT_SIGNED = 'The Interego relay did not sign this payload.';
/** The refusal code of POST /ui/relay/sign when the relay no longer takes the tab's token (401): the page forgets it. */
export const SIGN_IN_EXPIRED = 'interego-sign-in-expired';
/** The refusal code when the relay's /mcp answers 403 (a token with no mcp scope at all, which cannot sign): the page forgets it too. */
export const SIGN_IN_REFUSED = 'interego-sign-in-refused';
/** Said wherever the token is handed out or used. */
export const TOKEN_PASSES_THROUGH = 'Relay-attested, not a key you hold: the Interego relay signs each act for you. This page holds the relay\'s OAuth access token for your sign-in, good for about an hour, and sends it through this bridge with every signature; the bridge never logs, stores or echoes it. Until it ends it lets whoever holds it call the relay\'s tools as you, and the relay will also trade it, at its /identity-token, for the identity-server token behind your sign-in: that one is good for up to a day and works on your account itself (linking a wallet, removing your sign-in methods, deleting the account). This bridge never asks for it, but no narrower token can sign, so whoever runs this bridge, and anyone who gets a copy of your access token while it lasts, is trusted with your account for up to a day, past the hour and past signing out. Signing out forgets the access token in this tab but revokes nothing: the relay offers no way to revoke it, so it stays good until it ends. "Sign out everywhere" on the identity server\'s dashboard ends every identity-server token, a traded one included, but not the relay\'s access token.';

class SignInDown extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** A limit reached (this bridge's, or the relay's 429): answered 429 with the code and retryAfterSeconds. */
class Limited extends Error {
  constructor(readonly code: string, readonly retryAfterSeconds: number, message: string, readonly why: string) { super(message); }
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A relay's text, safe to repeat to the page: one line, at most 300 characters, every secret this call holds withheld. */
function relayText(v: unknown, secrets: readonly string[]): string {
  let t = typeof v === 'string' ? v : '';
  for (const s of secrets) if (s.length >= 8) t = t.split(s).join('[withheld]');
  return [...t].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').slice(0, 300);
}

/**
 * The JSON-RPC response to request `id` in the body the relay's /mcp answered: the body itself
 * when it is JSON, else the data of its server-sent events (the streamable HTTP transport answers
 * either way), whichever message answers `id` (or an error with a null id). Null when none does.
 */
export function mcpResponse(text: string, id: string): Record<string, unknown> | null {
  const messages: unknown[] = [];
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j: unknown = JSON.parse(t);
      messages.push(...(Array.isArray(j) ? j : [j]));
    } catch { /* not JSON: no answer */ }
  } else {
    for (const event of t.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (data === '') continue;
      try { messages.push(JSON.parse(data)); } catch { /* an event that is not JSON answers nothing */ }
    }
  }
  const found = messages.find((m) => isObj(m) && m['jsonrpc'] === '2.0'
    && ((m['id'] === id && ('result' in m || 'error' in m)) || (m['id'] === null && 'error' in m)));
  return isObj(found) ? found : null;
}

/**
 * What a tools/call result says the tool answered: its JSON object (structuredContent, else the
 * JSON of its first text content), or why there is none: the result is an error (isError), holds
 * no object, or the object is the tool's own {error}. `secrets` are withheld from what is repeated.
 */
export function toolAnswer(result: unknown, secrets: readonly string[]): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly why: string } {
  if (!isObj(result)) return { ok: false, why: 'tools/call answer holds no result' };
  const content = Array.isArray(result['content']) ? result['content'] : [];
  const first: unknown = content[0];
  const text = isObj(first) && first['type'] === 'text' && typeof first['text'] === 'string' ? first['text'] : '';
  if (result['isError'] === true) return { ok: false, why: `${SIGN_TOOL} failed${text ? `: ${relayText(text, secrets)}` : ''}` };
  let value: unknown = result['structuredContent'];
  if (!isObj(value)) {
    try { value = JSON.parse(text); } catch { value = null; }
  }
  if (!isObj(value)) return { ok: false, why: `${SIGN_TOOL} answered no JSON object` };
  if (typeof value['error'] === 'string') return { ok: false, why: `${SIGN_TOOL} answered: ${relayText(value['error'], secrets)}` };
  return { ok: true, value };
}

/** An answer of one of these routes: JSON, never cached, never sniffed, never referred on. */
function answer(res: Response, status: number, body: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.status(status).json(body);
}
const no = (res: Response, status: number, error: string, why: string): void => answer(res, status, refuse(status, error, why));
/** A limit reached: 429, its code and how long to wait, in the body and as Retry-After. */
function limited(res: Response, l: Limited): void {
  res.setHeader('Retry-After', String(l.retryAfterSeconds));
  answer(res, 429, { ...refuse(429, l.message, l.why), code: l.code, retryAfterSeconds: l.retryAfterSeconds });
}

/**
 * A POST from a page on another site: its Origin names a host other than the one it was sent to
 * (Host, or the X-Forwarded-Host a proxy in front sets) and other than the deployment URL's.
 */
function crossSite(req: Request, baseHost: string): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  let host: string;
  try { host = new URL(origin).host.toLowerCase(); } catch { return true; }
  const forwarded = req.headers['x-forwarded-host'];
  const ours = [req.headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded]), baseHost]
    .filter((h): h is string => typeof h === 'string').map((h) => h.split(',')[0]?.trim().toLowerCase() ?? '');
  return !ours.includes(host);
}
/** Over `max` bytes, by its declared length or as parsed (the shared factory's JSON parser has already read it). */
function tooLarge(req: Request, max: number): boolean {
  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) return true;
  try { return Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8') > max; } catch { return true; }
}
/** Refuse what no POST of these routes takes: another site's page, a body that is not JSON, or one over `max` bytes. */
function refusedPost(req: Request, res: Response, max: number, baseHost: string): boolean {
  if (crossSite(req, baseHost)) { no(res, 403, 'This route answers only this bridge\'s own page.', 'the request\'s Origin is another site'); return true; }
  if (!req.is('application/json')) { no(res, 415, 'Send a JSON body.', 'the Content-Type must be application/json'); return true; }
  if (tooLarge(req, max)) { no(res, 413, 'The request is too large.', `this route takes at most ${max} bytes`); return true; }
  return false;
}

/**
 * Mount the sign-in routes (see the header). With no `signIn`, or a relay this bridge does not
 * trust, GET /ui/oauth/config says why and every other route refuses (404), so the page offers no
 * sign-in; the callback page is served either way.
 *
 * The client is a Client ID Metadata Document at GET /ui/oauth/client.json, its client_id that URL
 * on the deployment URL: the relay reads it (SSRF-guarded) and needs nothing registered. The relay
 * takes one only over https and when its metadata says client_id_metadata_document_supported; a
 * bridge at an http deployment URL (a local run), or a relay that does not say so, registers the
 * same metadata once per process by Dynamic Client Registration instead, and GET /ui/oauth/config
 * says which (clientRegistration).
 *
 * POST /ui/oauth/exchange does only the code-for-token exchange (PKCE, at the relay's token
 * endpoint) and hands the page the relay's OAuth access token and when it ends; it asks for no
 * refresh token (the client's metadata names only the authorization_code grant) and drops the one
 * the relay's answer carries. POST /ui/relay/sign presents the page's access token at the relay's
 * /mcp, as a stateless tools/call of sign_request with a fresh JSON-RPC id (no initialize, no
 * session), reads the answer as JSON or as server-sent events, and hands back only the pair.
 *
 * Every call to the relay goes to the relay's own origin (endpoints its metadata names elsewhere
 * are refused), follows no redirect, takes at most 8 s and reads at most 256 KiB, and is admitted
 * under RelayLimits first, both how many a minute and how many at once (429 beyond them, with
 * retryAfterSeconds and a code, before the relay is asked anything). The code, the verifier and the
 * tokens are never logged, stored or put in a URL; a relay's error text is repeated with each of
 * them withheld.
 */
export function attachInteregoSignIn(app: Express, opts: { readonly base: string; readonly signIn?: UiSignIn; readonly siblingUrl?: string; readonly reads?: UiReads }): void {
  const base = opts.base.replace(/\/$/, '');
  const clientDocUrl = `${base}${SIGN_IN_PATHS.client}`;
  let baseHost = '';
  try { baseHost = new URL(base).host.toLowerCase(); } catch { baseHost = ''; }
  const callbackUrl = `${base}${SIGN_IN_PATHS.callback}`;
  const callbackHtml = shell(base, 'Finishing sign-in with your Interego account…', opts.siblingUrl ?? SIBLING.url, opts.reads);
  app.get(SIGN_IN_PATHS.callback, (_req, res) => { secure(res); res.type('text/html; charset=utf-8').send(callbackHtml); });

  const signIn = opts.signIn;
  const relayUrl = signIn ? signIn.relayUrl.replace(/\/$/, '') : '';
  const policy = signIn?.policy ?? null;
  const offWhy = !signIn ? 'WRD_RELAY_URL is not set'
    : policy === null ? `this bridge trusts no Interego relay (WRD_TRUSTED_RELAY_ADDRESSES is empty), so an act the relay at ${relayUrl} signed would not be taken` : null;
  const fetchFn: RelayFetch = signIn?.fetchFn ?? ((url, init) => fetch(url, init));
  const timeoutMs = signIn?.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
  let relayOrigin = '';
  try { relayOrigin = relayUrl === '' ? '' : new URL(relayUrl).origin; } catch { relayOrigin = ''; }
  const now = signIn?.now ?? ((): number => Date.now());
  const limits: RelayLimits = { ...RELAY_LIMITS, ...signIn?.limits };
  const windows = new Windows(now);
  /**
   * Access tokens the relay issued (an exchange here) or accepted (a sign it answered), tagged with
   * the person once a sign has named them ('' until then), and ones it refused, tagged with the
   * code, by sha256.
   */
  const accepted = new TokenMemory(now);
  const refused = new TokenMemory(now);
  /** Relay calls running now: for callers the relay has not accepted here, for people signed in, and for each person (or sign-in). */
  let unprovenNow = 0;
  let signedInNow = 0;
  const personNow = new Map<string, number>();
  let whoamiNow = 0;

  const clientDocument = (): Record<string, unknown> => ({
    client_id: clientDocUrl, client_name: SIGN_IN_CLIENT_NAME, client_uri: `${base}/ui`, redirect_uris: [callbackUrl],
    grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SIGN_IN_SCOPE,
  });

  /**
   * The windows a relay call of `kind` for `caller` is counted in: [key, limit, span, whose limit
   * it is, what it counts, and for whom when it is the caller's own]. A call with a token the
   * relay accepted here is counted for that sign-in and that person only, in no window anyone else
   * spends (see RelayLimits).
   */
  function windowsFor(caller: Caller, kind: CallKind): Array<readonly [string, number, number, 'bridge' | 'caller', string, string]> {
    const w: Array<readonly [string, number, number, 'bridge' | 'caller', string, string]> = [];
    if (caller.signIn !== null) {
      w.push([`sign-in:${caller.signIn}`, limits.perSignIn, MINUTE_MS, 'caller', 'relay calls a minute for one sign-in', 'one sign-in']);
      if (caller.person !== null) w.push([`person:${caller.person}`, limits.perPerson, MINUTE_MS, 'caller', 'relay calls a minute for one person, over all their sign-ins', 'one person']);
    } else {
      w.push(['unproven', limits.unproven, MINUTE_MS, 'bridge', 'relay calls a minute for callers the relay has not accepted here', ''],
        [`client:${caller.client}`, limits.unprovenPerClient, MINUTE_MS, 'caller', 'relay calls a minute for one address that is not signed in', 'one address that is not signed in']);
    }
    if (kind === 'exchange') {
      w.push(['exchanges', limits.exchanges, EXCHANGE_WINDOW_MS, 'bridge', 'code exchanges every 15 minutes in all', ''],
        [`exchanges:${caller.client}`, limits.exchangesPerClient, EXCHANGE_WINDOW_MS, 'caller', 'code exchanges every 15 minutes from one address', 'one address']);
    }
    if (kind === 'registration') w.push(['registrations', limits.registrations, REGISTRATION_WINDOW_MS, 'bridge', 'client registrations an hour', '']);
    return w;
  }
  /** Throw Limited when one more relay call of `kind` for `caller` does not fit now; the relay is asked nothing. */
  function check(caller: Caller, kind: CallKind): void {
    let worst: { readonly wait: number; readonly who: 'bridge' | 'caller'; readonly limit: number; readonly what: string; readonly whose: string } | null = null;
    for (const [key, limit, span, who, what, whose] of windowsFor(caller, kind)) {
      const wait = windows.wait(key, limit, 1, span);
      if (wait > 0 && (worst === null || wait > worst.wait)) worst = { wait, who, limit, what, whose };
    }
    if (worst === null) return;
    const why = `this bridge's limit of ${worst.limit} ${worst.what} is reached; the relay was not asked`;
    throw worst.who === 'caller'
      ? new Limited(RELAY_CALLS_LIMITED, worst.wait, `This bridge asks the Interego relay only so often for ${worst.whose}; try again in ${worst.wait} s.`, why)
      : new Limited(RELAY_BUSY, worst.wait, `This bridge is asking the Interego relay for many people at once and keeps under the relay's own limits; try again in ${worst.wait} s.`, why);
  }
  /** Admit one relay call of `kind` for `caller` (check, then count it), or throw Limited. */
  function admit(caller: Caller, kind: CallKind): void {
    check(caller, kind);
    for (const [key, , span] of windowsFor(caller, kind)) windows.take(key, 1, span);
  }
  /**
   * Take a place for one relay call for `caller` among those running at once, or throw Limited;
   * the function returned gives it back. A caller the relay has not accepted here takes one of
   * unprovenAtOnce; a person signed in, one of signedInAtOnce, holding at most perPersonAtOnce.
   */
  function hold(caller: Caller): () => void {
    if (caller.signIn === null) {
      if (unprovenNow >= limits.unprovenAtOnce) {
        throw new Limited(RELAY_BUSY, 5, 'Too many sign-in requests are in progress on this bridge; try again in a moment.', `at most ${limits.unprovenAtOnce} relay calls run at once for callers the relay has not accepted here; the relay was not asked`);
      }
      unprovenNow += 1;
      return () => { unprovenNow -= 1; };
    }
    const key = caller.person ?? `sign-in:${caller.signIn}`;
    const mine = personNow.get(key) ?? 0;
    if (mine >= limits.perPersonAtOnce) {
      throw new Limited(RELAY_CALLS_LIMITED, 1, 'This bridge runs only so many relay calls at once for one person; try again in a moment.', `at most ${limits.perPersonAtOnce} relay calls run at once for one person; the relay was not asked`);
    }
    if (signedInNow >= limits.signedInAtOnce) {
      throw new Limited(RELAY_BUSY, 1, 'This bridge is waiting on the Interego relay for many people at once; try again in a moment.', `at most ${limits.signedInAtOnce} relay calls run at once for people signed in; the relay was not asked`);
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
   * One call to the relay, admitted for `caller` first (a place among those running at once, then
   * the minute's budgets): its status, its body and that body as JSON (null when it is not), or
   * SignInDown; a 429 from the relay is Limited. `secrets` are withheld from any error text.
   */
  async function relayCall(url: string, init: Omit<RelayRequest, 'redirect' | 'signal'>, caller: Caller, kind: CallKind, secrets: readonly string[] = []): Promise<{ readonly status: number; readonly text: string; readonly json: unknown }> {
    const release = hold(caller);
    try {
      admit(caller, kind);
      return await sendToRelay(url, init, secrets);
    } finally {
      release();
    }
  }
  async function sendToRelay(url: string, init: Omit<RelayRequest, 'redirect' | 'signal'>, secrets: readonly string[]): Promise<{ readonly status: number; readonly text: string; readonly json: unknown }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchFn(url, { ...init, redirect: 'error', signal: ac.signal });
      const text = await cappedText(r, RELAY_ANSWER_MAX_BYTES, 'the relay\'s answer');
      if (r.status === 429) {
        const after = Number(r.headers.get('retry-after'));
        const wait = Number.isFinite(after) && after >= 1 ? Math.min(Math.ceil(after), 3600) : 60;
        throw new Limited(RELAY_BUSY, wait, `The Interego relay is limiting how often this bridge asks it; try again in ${wait} s.`, `the relay answered 429 at ${new URL(url).pathname}`);
      }
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, text, json };
    } catch (e) {
      if (e instanceof Limited) throw e;
      if (ac.signal.aborted) throw new SignInDown(504, `the relay did not answer within ${timeoutMs} ms`);
      throw new SignInDown(502, `the relay could not be reached: ${relayText(messageOf(e), secrets)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** An endpoint the relay's metadata names, kept only when it is on the relay's own origin. */
  const onRelay = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    try {
      const u = new URL(v);
      return u.origin === relayOrigin && u.hash === '' && u.username === '' && u.password === '' ? u.href : null;
    } catch { return null; }
  };
  interface Endpoints { readonly authorization: string; readonly token: string; readonly registration: string | null; readonly cimd: boolean }
  let discovered: { readonly at: number; readonly value: Endpoints } | null = null;
  /** The relay's endpoints, from its authorization server metadata, kept ten minutes (a failure is not kept); a fetch is a call for `caller`. */
  async function endpoints(caller: Caller): Promise<Endpoints> {
    if (discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) return discovered.value;
    const where = `${relayUrl}/.well-known/oauth-authorization-server`;
    const r = await relayCall(where, { method: 'GET', headers: { accept: 'application/json' } }, caller, 'call');
    const m = isObj(r.json) ? r.json : null;
    if (r.status !== 200 || m === null) throw new SignInDown(502, `the relay's authorization server metadata (${where}) answered ${r.status}${m === null ? ' with no JSON object' : ''}`);
    const authorization = onRelay(m['authorization_endpoint']);
    const token = onRelay(m['token_endpoint']);
    if (authorization === null || token === null) throw new SignInDown(502, `the relay's metadata names no authorization and token endpoint on ${relayOrigin}`);
    const methods = m['code_challenge_methods_supported'];
    if (Array.isArray(methods) && !methods.includes('S256')) throw new SignInDown(502, 'the relay does not take PKCE with S256');
    const value: Endpoints = { authorization, token, registration: onRelay(m['registration_endpoint']), cimd: m['client_id_metadata_document_supported'] === true };
    discovered = { at: Date.now(), value };
    return value;
  }

  type Registration = 'client-id-metadata-document' | 'dynamic-registration';
  let registered: Promise<string> | null = null;
  /** The client_id this UI signs in as: its metadata document's URL, or, where the relay cannot read that, one registered once per process (a call for `caller`). */
  async function client(caller: Caller): Promise<{ readonly id: string; readonly how: Registration }> {
    const ep = await endpoints(caller);
    const https = base.startsWith('https://');
    if (ep.cimd && https) return { id: clientDocUrl, how: 'client-id-metadata-document' };
    if (ep.registration === null) {
      throw new SignInDown(502, `the relay cannot read this UI's Client ID Metadata Document (${https ? 'its metadata does not say client_id_metadata_document_supported' : `the deployment URL ${base} is not https`}) and names no registration endpoint`);
    }
    const at = ep.registration;
    registered ??= (async () => {
      const doc = clientDocument();
      const metadata = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'client_id'));
      const r = await relayCall(at, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(metadata) }, caller, 'registration');
      const id = isObj(r.json) ? r.json['client_id'] : undefined;
      if ((r.status !== 200 && r.status !== 201) || typeof id !== 'string' || !TOKEN.test(id)) {
        throw new SignInDown(502, `the relay's registration endpoint answered ${r.status} with no client_id`);
      }
      return id;
    })().catch((e: unknown) => { registered = null; throw e; });
    return { id: await registered, how: 'dynamic-registration' };
  }

  /** Run `work` for one request; a relay that fails, or a limit reached (each relay call is admitted in relayCall), answers as a typed refusal. */
  async function handled(res: Response, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (e) {
      if (e instanceof Limited) limited(res, e);
      else if (e instanceof SignInDown) no(res, e.status, RELAY_DOWN, e.message);
      else no(res, 500, 'Sign-in failed on this bridge.', 'an unexpected error; nothing was kept');
    }
  }
  /**
   * The person the relay signed `signed` for, as POST /ui/relay/whoami names them: the user its
   * agent belongs to (the agent's DID document, read through the same cache), or, when that cannot
   * be read, the agent itself; '' when the text names no agent. The relay sets the agent from the
   * sign-in of the token it was called with, so no caller can make a token count against someone else.
   */
  async function personOf(signed: string, signature: string, text: Record<string, unknown>): Promise<string> {
    if (policy !== null) {
      try {
        const v = await openRelayDelegated(signed, signature, policy);
        if (v.ok) return `user ${v.principal}`;
      } catch { /* no person named: the agent stands for them */ }
    }
    const agent = text['agent_id'];
    return typeof agent === 'string' && agent !== '' ? `agent ${agent}` : '';
  }
  /** False (and the refusal sent) when sign-in is not set up. */
  const ready = (res: Response): boolean => {
    if (offWhy === null) return true;
    no(res, 404, NOT_SET_UP, offWhy);
    return false;
  };

  app.get(SIGN_IN_PATHS.client, (_req, res) => {
    if (!ready(res)) return;
    res.setHeader('Cache-Control', 'max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).json(clientDocument());
  });

  app.get(SIGN_IN_PATHS.config, (req, res) => {
    if (offWhy !== null) { answer(res, 200, { enabled: false, why: `${NOT_SET_UP} ${offWhy[0]?.toUpperCase()}${offWhy.slice(1)}.`, ...(relayUrl ? { relayUrl } : {}) }); return; }
    const caller: Caller = { client: clientOf(req), signIn: null, person: null };
    void handled(res, async () => {
      let ep: Endpoints;
      let c: { readonly id: string; readonly how: Registration };
      try { ep = await endpoints(caller); c = await client(caller); } catch (e) {
        if (!(e instanceof SignInDown)) throw e;
        answer(res, 200, { enabled: false, relayUrl, why: `${RELAY_DOWN} ${e.message[0]?.toUpperCase()}${e.message.slice(1)}.` });
        return;
      }
      answer(res, 200, {
        enabled: true, relayUrl, authorizationEndpoint: ep.authorization, clientId: c.id, clientRegistration: c.how,
        redirectUri: callbackUrl, scope: SIGN_IN_SCOPE, identityHost: policy?.identityHost ?? null, trust: TOKEN_PASSES_THROUGH,
      });
    });
  });

  app.post(SIGN_IN_PATHS.exchange, (req, res) => {
    if (!ready(res) || refusedPost(req, res, EXCHANGE_MAX_BYTES, baseHost)) return;
    const b = isObj(req.body) ? req.body : {};
    const code = b['code'];
    const verifier = b['code_verifier'];
    const state = b['state'];
    if (typeof code !== 'string' || !CODE.test(code)) { no(res, 400, BAD_EXCHANGE, 'code must be the authorization code the relay sent back to the callback page (1 to 512 visible ASCII characters)'); return; }
    if (typeof verifier !== 'string' || !PKCE_VERIFIER.test(verifier)) { no(res, 400, BAD_EXCHANGE, 'code_verifier must be the PKCE verifier this page made: 43 to 128 of A-Z a-z 0-9 - . _ ~'); return; }
    // The page checked the state against the one it stored before it sent the person to the relay; here only its form is.
    if (typeof state !== 'string' || !STATE.test(state)) { no(res, 400, BAD_EXCHANGE, 'state must be the state this page made: 16 to 128 of A-Z a-z 0-9 - . _ ~'); return; }
    // A code exchange is made for no token the relay has accepted: it is counted per address and in all, and in the 15-minute windows the relay's token endpoint is kept under.
    const caller: Caller = { client: clientOf(req), signIn: null, person: null };
    void handled(res, async () => {
      // Before any relay call (the set-up's included): an exchange that would not be admitted asks the relay nothing.
      check(caller, 'exchange');
      const c = await client(caller);
      const ep = await endpoints(caller);
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callbackUrl, client_id: c.id });
      const t = await relayCall(ep.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() }, caller, 'exchange', [code, verifier]);
      const tj = isObj(t.json) ? t.json : {};
      if (t.status !== 200) {
        const secrets = [code, verifier];
        const said = `${typeof tj['error'] === 'string' ? `: ${relayText(tj['error'], secrets)}` : ''}${typeof tj['error_description'] === 'string' ? ` (${relayText(tj['error_description'], secrets)})` : ''}`;
        no(res, t.status >= 400 && t.status < 500 ? 400 : 502, 'The Interego relay did not take this sign-in. Sign in again.', `the relay's token endpoint answered ${t.status}${said}`);
        return;
      }
      const access = tj['access_token'];
      if (typeof access !== 'string' || !TOKEN.test(access)) { no(res, 502, RELAY_DOWN, 'the relay\'s token answer holds no access_token'); return; }
      const kind = tj['token_type'];
      if (typeof kind === 'string' && kind.toLowerCase() !== 'bearer') { no(res, 502, RELAY_DOWN, `the relay issued a ${relayText(kind, [access])} token, which this page cannot present`); return; }
      // The page holds this access token itself, as any MCP client does, and nothing else: no
      // identity-server token (the bridge never calls /identity-token, though the relay would trade
      // this token there for one) and no refresh token (dropped here, so nothing on this side can
      // renew the sign-in). It forgets the token when it ends:
      // expires_in from now (the relay's is an hour), at most MAX_TOKEN_SECONDS.
      const lifetime = tj['expires_in'];
      const seconds = typeof lifetime === 'number' && Number.isFinite(lifetime) ? Math.min(Math.max(lifetime, 0), MAX_TOKEN_SECONDS) : DEFAULT_TOKEN_SECONDS;
      // The relay issued it here: its signs count against its own sign-in from now until it ends (and
      // against its person, once its first sign names them), not against callers not signed in.
      const h = tokenHash(access);
      refused.delete(h);
      accepted.add(h, seconds * 1000);
      answer(res, 200, {
        status: 'signed-in', token: access, tokenType: 'Bearer', expiresAt: new Date(Date.now() + seconds * 1000).toISOString(), relayUrl,
        clientId: c.id, clientRegistration: c.how, trust: TOKEN_PASSES_THROUGH,
      });
    });
  });

  app.post(SIGN_IN_PATHS.sign, (req, res) => {
    if (!ready(res) || refusedPost(req, res, SIGN_IN_MAX_BYTES - 1024, baseHost)) return;
    const m = BEARER.exec(String(req.headers.authorization ?? ''));
    const bearer = m?.[1];
    if (bearer === undefined) {
      no(res, 401, NOT_SIGNED_IN, `${SIGN_IN_PATHS.sign} sends the payload to the Interego relay with the access token your sign-in gave this page (Authorization: Bearer <token>), and this request carries none`);
      return;
    }
    const b = isObj(req.body) ? req.body : {};
    const payload = b['payload'];
    if (!isObj(payload)) { no(res, 400, NOT_SIGNED, 'send {payload}: the unsigned payload of the act, a JSON object'); return; }
    const intent = payload['intent'];
    if (!isEnvelopeIntent(intent) || intent === 'wrd:agent-run') {
      no(res, 400, NOT_SIGNED, `payload.intent must be one of this bridge's intents (wrd.envelope_template lists them); an agent signs its own runs with its key, so wrd:agent-run is never relay-signed`);
      return;
    }
    const kept = Object.keys(payload).find((k) => k.startsWith('_') || RELAY_SETS.has(k));
    if (kept !== undefined) { no(res, 400, NOT_SIGNED, `payload holds ${JSON.stringify(kept.slice(0, 40))}, which the relay sets itself or drops, so the text it signs would not be this payload`); return; }
    // A token the relay refused in the last minute is refused again from memory, with no relay call.
    const h = tokenHash(bearer);
    const before = refused.get(h);
    if (before !== null) {
      answer(res, 401, { ...refuse(401, before === SIGN_IN_REFUSED ? RELAY_REFUSED : SIGN_IN_ENDED, `the relay refused this access token within the last minute (${before === SIGN_IN_REFUSED ? 'it cannot sign' : 'it has ended, or is not the relay\'s'}), so it is refused again here without asking the relay`), code: before });
      return;
    }
    // Signs with a token the relay accepted here count against that sign-in and its person alone; any
    // other token is a caller not signed in, from its address.
    const known = accepted.get(h);
    const caller: Caller = { client: clientOf(req), signIn: known !== null ? h : null, person: known !== null && known !== '' ? known : null };
    void handled(res, async () => {
      // A stateless MCP call, as any MCP client may make one: no initialize and no session, so the
      // relay serves it from its stateless handler and stamps the session's own agent itself.
      const rpcId = `wrd-sign-${randomUUID()}`;
      const secrets = [bearer];
      const r = await relayCall(`${relayUrl}${RELAY_MCP_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: SIGN_TOOL, arguments: { payload } } }),
      }, caller, 'call', secrets);
      const j = isObj(r.json) ? r.json : {};
      const relaySaid = `${typeof j['error'] === 'string' ? `: ${relayText(j['error'], secrets)}` : ''}${typeof j['error_description'] === 'string' ? ` (${relayText(j['error_description'], secrets)})` : ''}`;
      if (r.status === 401 || r.status === 403) {
        const code = r.status === 401 ? SIGN_IN_EXPIRED : SIGN_IN_REFUSED;
        accepted.delete(h);
        refused.add(h, REFUSED_TOKEN_MS, code);
        answer(res, 401, r.status === 401
          ? { ...refuse(401, SIGN_IN_ENDED, `the relay's ${RELAY_MCP_PATH} answered 401${relaySaid}: it no longer takes the access token this tab holds (it has ended, or is not the relay's)`), code }
          : { ...refuse(401, RELAY_REFUSED, `the relay's ${RELAY_MCP_PATH} answered 403${relaySaid}: the access token this tab holds cannot sign`), code });
        return;
      }
      if (r.status !== 200) { no(res, 502, NOT_SIGNED, `the relay's ${RELAY_MCP_PATH} answered ${r.status}${relaySaid}`); return; }
      const rpc = mcpResponse(r.text, rpcId);
      if (rpc === null) { no(res, 502, NOT_SIGNED, `the relay's ${RELAY_MCP_PATH} answer holds no JSON-RPC response to this request`); return; }
      // The relay answered this very call behind its bearer check, so it takes the token: from now on (for at most the relay's hour) it is a sign-in.
      if (rpc['id'] === rpcId && accepted.get(h) === null) accepted.add(h, DEFAULT_TOKEN_SECONDS * 1000);
      const rpcError = rpc['error'];
      if (rpcError !== undefined) {
        const e = isObj(rpcError) ? rpcError : {};
        no(res, 502, NOT_SIGNED, `the relay answered JSON-RPC error${typeof e['code'] === 'number' ? ` ${e['code']}` : ''}${typeof e['message'] === 'string' ? `: ${relayText(e['message'], secrets)}` : ''}`);
        return;
      }
      const tool = toolAnswer(rpc['result'], secrets);
      if (!tool.ok) { no(res, 502, NOT_SIGNED, `the relay's ${tool.why}`); return; }
      const signed = tool.value['_signed_payload'];
      const signature = tool.value['_signature'];
      let parsed: unknown = null;
      try { parsed = typeof signed === 'string' ? JSON.parse(signed) : null; } catch { parsed = null; }
      if (typeof signed !== 'string' || signed.length > SIGN_IN_MAX_BYTES || typeof signature !== 'string' || !SIGNATURE.test(signature) || !isObj(parsed)
        || parsed['intent'] !== intent || (typeof payload['nonce'] === 'string' && parsed['nonce'] !== payload['nonce'])) {
        no(res, 502, NOT_SIGNED, 'the relay\'s answer is not {_signature, _signed_payload} over this payload');
        return;
      }
      // The first sign with a token names its person: from now on its calls count against them too, over all their sign-ins.
      if (accepted.get(h) === '') {
        const person = await personOf(signed, signature, parsed);
        if (person !== '') accepted.retag(h, person);
      }
      answer(res, 200, { _signature: signature, _signed_payload: signed });
    });
  });

  app.post(SIGN_IN_PATHS.whoami, (req, res) => {
    if (!ready(res) || refusedPost(req, res, SIGN_IN_MAX_BYTES + 1024, baseHost) || policy === null) return;
    const form = relayEnvelopeOf(isObj(req.body) ? req.body : {});
    if (form === null) { no(res, 400, 'Send a relay-signed request: {_signed_payload, _signature}.', 'the body holds neither _signed_payload nor _signature'); return; }
    if (whoamiNow >= WHOAMI_AT_ONCE) {
      limited(res, new Limited(RELAY_BUSY, 5, 'Too many sign-in requests are in progress on this bridge; try again in a moment.', `at most ${WHOAMI_AT_ONCE} of ${SIGN_IN_PATHS.whoami} run at once`));
      return;
    }
    whoamiNow += 1;
    void handled(res, async () => {
      const v = await openRelayDelegated(form.signedPayload, form.signature, policy);
      if (!v.ok) { no(res, v.status, 'The relay-signed request does not name a person this bridge can verify.', `${v.code}: ${v.message}`); return; }
      answer(res, 200, { authority: 'relay-delegated', principal: v.principal, agentId: v.agentId, relaySigner: v.relaySigner, trust: TOKEN_PASSES_THROUGH });
    }).finally(() => { whoamiNow -= 1; });
  });
}

const LOOPBACK_BINDS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when `host`, the address the bridge listens on, is a loopback name. */
export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BINDS.has(host.trim().toLowerCase());
}

/**
 * The Host header values a loopback bridge listening on `port` answers: 127.0.0.1, localhost and
 * [::1] on that port — bare as well on port 80, where a browser omits the port — and the host of
 * `base`, the bridge's public URL, so a reverse proxy on the same machine that forwards the
 * public name still reaches it. A `base` that is not a URL adds nothing.
 */
export function servedHostNames(port: number, base?: string): string[] {
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  const names = loopback.map((h) => `${h}:${port}`);
  if (port === 80) names.push(...loopback);
  if (base !== undefined) {
    try { names.push(new URL(base).host); } catch { /* not a URL: the loopback names remain */ }
  }
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

/** Refuse (421) any request whose Host header, lowercased, is not in `allowed`. */
export function hostAllowlistGuard(allowed: readonly string[]): (req: Request, res: Response, next: NextFunction) => void {
  const names = new Set(allowed.map((h) => h.toLowerCase()));
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? '').toLowerCase();
    if (names.has(host)) { next(); return; }
    res.status(421).json(refuse(421, 'This bridge does not answer for that host name.',
      'the Host header is not a name this bridge is served under, which is what a page that rebinds its own DNS name to the bridge sends'));
  };
}

/**
 * Parse every pair of a query string: node:querystring's parse, as Express's default ('simple')
 * parser is, with no cap on the number of keys (its default, 1000, drops the rest silently). A
 * GET's arguments are its query, and a check over them (signedReadIn, for the GET
 * wrd.envelope_template) sees only what the parser keeps. Node's header-size limit (16 KiB by
 * default) bounds the request line, and so how many pairs there can be. Express reads the setting
 * on each request, so it can be set at any point before the app serves one.
 */
export function parseEveryQueryPair(app: Express): void {
  app.set('query parser', (query: string) => parseQueryString(query, '&', '=', { maxKeys: 0 }));
}
