/**
 * The work-redesign web UI: three static assets served from the bridge itself.
 *
 *   GET /ui          the HTML shell — no inline script, no inline style, no style attribute
 *   GET /ui/app.js   the browser client (./ui/app.js), read once when the UI is attached
 *   GET /ui/app.css  the stylesheet below, including the print layout for one decision
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
 * call the relay's tools as the person, so whoever runs this bridge is trusted with it for the
 * session. It is never logged, stored, echoed or put in a URL here. The identity server's token
 * behind the sign-in never reaches this bridge or the page: nothing here calls the relay's
 * /identity-token or its REST /tool/ routes, and the refresh token the relay's token answer
 * carries is dropped.
 *
 * All three answers carry the same Content-Security-Policy: scripts, styles and connections
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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseQueryString } from 'node:querystring';
import type { Express, NextFunction, Request, Response } from 'express';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';
import { isEnvelopeIntent } from '../src/payloads.js';
import { openRelayDelegated, relayEnvelopeOf, type RelayDelegationPolicy } from '../src/relay-delegated.js';
import { cappedText, type CappedAnswer } from './relay-sign-in.js';

export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** HTML-safe text for an attribute or element body (the shell interpolates one value: the bridge's base URL). */
const htmlText = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(base: string, loading = 'Loading the affordance manifest…'): string {
  const b = htmlText(base);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Work redesign</title>',
    '<link rel="icon" href="data:,">',
    '<link rel="stylesheet" href="/ui/app.css">',
    `<link rel="alternate" type="text/turtle" href="${b}/affordances" title="Affordance manifest">`,
    '<script type="module" src="/ui/app.js"></script>',
    '</head>',
    '<body>',
    '<noscript><p class="noscript">This page is a client for the work-redesign bridge and needs JavaScript. ',
    `Without it, read the affordance manifest at <a href="${b}/affordances">${b}/affordances</a> and call the affordances directly.</p></noscript>`,
    `<div id="app" class="app" aria-live="polite"><p class="muted">${htmlText(loading)}</p></div>`,
    '<div id="print" class="print-only"></div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const APP_CSS = `
:root { color-scheme: light dark; --fg: #1c2230; --muted: #5b6475; --line: #8a92a466; --bg: #ffffff; --panel: #f4f6f9;
  --accent: #0a6b64; --warn: #8a5a00; --bad: #a3271f; --good: #1d6b2c; --chip: #e8ecf2; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e6e9ef; --muted: #a0a8b8; --line: #8a92a455; --bg: #12151b; --panel: #1b2029; --accent: #45d6cc;
    --warn: #e0b04a; --bad: #ff8a80; --good: #7bd88f; --chip: #262c37; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.88em; overflow-wrap: anywhere; }
h1 { font-size: 1.25rem; margin: 0; }
h2 { font-size: 1.1rem; margin: 1.2rem 0 0.4rem; }
h3 { font-size: 1rem; margin: 1rem 0 0.3rem; }
p { margin: 0.4rem 0; }
.muted { color: var(--muted); }
.small { font-size: 0.85em; }
.noscript { padding: 1rem; }
.app { max-width: 1280px; margin: 0 auto; padding: 0.75rem; }
.strip { display: grid; gap: 0.5rem; grid-template-columns: 1fr; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem 0.8rem; }
.strip .row { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; align-items: center; }
.strip > *, .strip .row > * { min-width: 0; max-width: 100%; }
.strip code { word-break: break-all; }
.strip .chip { white-space: normal; border-radius: 0.6rem; }
.demo-banner { border: 3px solid var(--bad); border-radius: 6px; padding: 0.4rem 0.6rem; font-weight: 600; color: var(--bad); }
.warnbox { border-left: 4px solid var(--warn); padding: 0.3rem 0.6rem; background: var(--panel); }
.badbox { border-left: 4px solid var(--bad); padding: 0.3rem 0.6rem; background: var(--panel); }
.goodbox { border-left: 4px solid var(--good); padding: 0.3rem 0.6rem; background: var(--panel); }
.layout { display: grid; grid-template-columns: 1fr; gap: 0.75rem; margin-top: 0.75rem; }
nav.tabs { display: flex; flex-wrap: wrap; gap: 0.3rem; }
nav.tabs button { border: 1px solid var(--line); background: var(--panel); color: var(--fg); border-radius: 6px; padding: 0.35rem 0.6rem; cursor: pointer; text-align: left; }
nav.tabs button[aria-current="page"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
main { min-width: 0; }
@media (min-width: 761px) {
  .layout { grid-template-columns: 13rem 1fr; }
  nav.tabs { flex-direction: column; }
  .strip { grid-template-columns: 1fr 1fr; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
}
.card { border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.6rem 0; background: var(--bg); }
.panel { border: 2px solid var(--accent); border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.6rem 0; }
table { border-collapse: collapse; width: 100%; margin: 0.4rem 0; }
th, td { border-bottom: 1px solid var(--line); padding: 0.3rem 0.4rem; text-align: left; vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: 0.85em; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
.chip { display: inline-block; padding: 0 0.45rem; border-radius: 999px; background: var(--chip); font-size: 0.82em; margin: 0 0.15rem 0.15rem 0; white-space: nowrap; }
.chip.good { color: var(--good); } .chip.bad { color: var(--bad); } .chip.warn { color: var(--warn); }
.chip.demo { border: 1px solid var(--bad); color: var(--bad); }
td .chip { white-space: normal; border-radius: 0.6rem; }
button, .button { font: inherit; border: 1px solid var(--accent); color: var(--accent); background: transparent; border-radius: 6px; padding: 0.25rem 0.6rem; cursor: pointer; margin: 0.1rem 0.2rem 0.1rem 0; }
button.primary { background: var(--accent); color: var(--bg); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
label { display: block; margin: 0.35rem 0 0.1rem; font-size: 0.9em; color: var(--muted); }
label.inline { display: inline-flex; gap: 0.3rem; align-items: center; margin-right: 0.8rem; color: var(--fg); }
input, select, textarea { font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 0.25rem 0.4rem; max-width: 100%; }
input[type="number"] { width: 6.5rem; }
textarea { width: 100%; min-height: 4.5rem; }
textarea.tall { min-height: 12rem; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 0.5rem; overflow: auto; max-height: 24rem; font-size: 0.82em; }
details > summary { cursor: pointer; color: var(--muted); }
.result { margin: 0.6rem 0; }
.bar { height: 0.7rem; background: var(--accent); border-radius: 3px; min-width: 1px; }
.bartrack { background: var(--chip); border-radius: 3px; width: 100%; }
.tri { display: flex; flex-wrap: wrap; gap: 0.25rem; align-items: center; }
.tri input[type="number"] { width: 5.5rem; }
.tri .lbl { min-width: 12rem; font-size: 0.9em; }
.quote { border-left: 3px solid var(--line); padding-left: 0.5rem; margin: 0.2rem 0; }
.quote.verified { border-color: var(--good); }
.quote.unverified { border-color: var(--bad); }
.stack > * + * { margin-top: 0.3rem; }
.print-only { display: none; }
@media print {
  body > .app { display: none !important; }
  .print-only { display: block; padding: 1rem; color: #000; background: #fff; }
  .print-only table { font-size: 10pt; }
  .print-only .chip { border: 1px solid #000; background: #fff; color: #000; }
  .print-only .badbox { border: 1px solid #000; border-left-width: 4px; background: #fff; color: #000; }
}
`;

function secure(res: Response): void {
  res.setHeader('Content-Security-Policy', UI_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Mount GET /ui, /ui/app.js and /ui/app.css, and the sign-in routes (attachInteregoSignIn). `base`
 * is the bridge's public base URL; `signIn`, the relay a person signs in through (absent: every
 * sign-in route says it is not set up, and the page offers no sign-in).
 */
export function attachUi(app: Express, opts: { readonly base: string; readonly signIn?: UiSignIn }): void {
  const appJs = readFileSync(new URL('./ui/app.js', import.meta.url), 'utf8');
  const base = opts.base.replace(/\/$/, '');
  const html = shell(base);
  app.get('/ui', (_req, res) => { secure(res); res.type('text/html; charset=utf-8').send(html); });
  app.get('/ui/app.js', (_req, res) => { secure(res); res.type('text/javascript; charset=utf-8').send(appJs); });
  app.get('/ui/app.css', (_req, res) => { secure(res); res.type('text/css; charset=utf-8').send(APP_CSS); });
  attachInteregoSignIn(app, { base, ...(opts.signIn ? { signIn: opts.signIn } : {}) });
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
}
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
const MAX_IN_FLIGHT = 16;
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
export const TOKEN_PASSES_THROUGH = 'Relay-attested, not a key you hold: the Interego relay signs each act for you. This page holds the relay\'s OAuth access token for your sign-in, good for about an hour, and sends it through this bridge with every signature. Until it ends it lets whoever holds it call the relay\'s tools as you, so whoever runs this bridge is trusted with it while you are signed in; the bridge never logs, stores or echoes it. It is not your identity-server token, which never reaches this bridge or this page. Signing out forgets it in this tab but revokes nothing: the relay offers no way to revoke it, so it stays good until it ends.';

class SignInDown extends Error {
  constructor(readonly status: number, message: string) { super(message); }
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
 * are refused), follows no redirect, takes at most 8 s and reads at most 256 KiB; at most 16 run
 * at once (429 beyond). The code, the verifier and the tokens are never logged, stored or put in
 * a URL; a relay's error text is repeated with each of them withheld.
 */
export function attachInteregoSignIn(app: Express, opts: { readonly base: string; readonly signIn?: UiSignIn }): void {
  const base = opts.base.replace(/\/$/, '');
  const clientDocUrl = `${base}${SIGN_IN_PATHS.client}`;
  let baseHost = '';
  try { baseHost = new URL(base).host.toLowerCase(); } catch { baseHost = ''; }
  const callbackUrl = `${base}${SIGN_IN_PATHS.callback}`;
  const callbackHtml = shell(base, 'Finishing sign-in with your Interego account…');
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

  const clientDocument = (): Record<string, unknown> => ({
    client_id: clientDocUrl, client_name: SIGN_IN_CLIENT_NAME, client_uri: `${base}/ui`, redirect_uris: [callbackUrl],
    grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SIGN_IN_SCOPE,
  });

  /** One call to the relay: its status, its body and that body as JSON (null when it is not), or SignInDown; `secrets` are withheld from any error text. */
  async function relayCall(url: string, init: Omit<RelayRequest, 'redirect' | 'signal'>, secrets: readonly string[] = []): Promise<{ readonly status: number; readonly text: string; readonly json: unknown }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchFn(url, { ...init, redirect: 'error', signal: ac.signal });
      const text = await cappedText(r, RELAY_ANSWER_MAX_BYTES, 'the relay\'s answer');
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, text, json };
    } catch (e) {
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
  /** The relay's endpoints, from its authorization server metadata, kept ten minutes (a failure is not kept). */
  async function endpoints(): Promise<Endpoints> {
    if (discovered && Date.now() - discovered.at < DISCOVERY_TTL_MS) return discovered.value;
    const where = `${relayUrl}/.well-known/oauth-authorization-server`;
    const r = await relayCall(where, { method: 'GET', headers: { accept: 'application/json' } });
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
  /** The client_id this UI signs in as: its metadata document's URL, or, where the relay cannot read that, one registered once per process. */
  async function client(): Promise<{ readonly id: string; readonly how: Registration }> {
    const ep = await endpoints();
    const https = base.startsWith('https://');
    if (ep.cimd && https) return { id: clientDocUrl, how: 'client-id-metadata-document' };
    if (ep.registration === null) {
      throw new SignInDown(502, `the relay cannot read this UI's Client ID Metadata Document (${https ? 'its metadata does not say client_id_metadata_document_supported' : `the deployment URL ${base} is not https`}) and names no registration endpoint`);
    }
    const at = ep.registration;
    registered ??= (async () => {
      const doc = clientDocument();
      const metadata = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'client_id'));
      const r = await relayCall(at, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(metadata) });
      const id = isObj(r.json) ? r.json['client_id'] : undefined;
      if ((r.status !== 200 && r.status !== 201) || typeof id !== 'string' || !TOKEN.test(id)) {
        throw new SignInDown(502, `the relay's registration endpoint answered ${r.status} with no client_id`);
      }
      return id;
    })().catch((e: unknown) => { registered = null; throw e; });
    return { id: await registered, how: 'dynamic-registration' };
  }

  let inFlight = 0;
  /** Run `work` for one request, at most MAX_IN_FLIGHT at once; a relay that fails answers as a typed refusal. */
  async function bounded(res: Response, work: () => Promise<void>): Promise<void> {
    if (inFlight >= MAX_IN_FLIGHT) {
      no(res, 429, 'Too many sign-in requests are in progress on this bridge; try again in a moment.', `at most ${MAX_IN_FLIGHT} calls to the relay run at once`);
      return;
    }
    inFlight += 1;
    try {
      await work();
    } catch (e) {
      if (e instanceof SignInDown) no(res, e.status, RELAY_DOWN, e.message);
      else no(res, 500, 'Sign-in failed on this bridge.', 'an unexpected error; nothing was kept');
    } finally {
      inFlight -= 1;
    }
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

  app.get(SIGN_IN_PATHS.config, (_req, res) => {
    if (offWhy !== null) { answer(res, 200, { enabled: false, why: `${NOT_SET_UP} ${offWhy[0]?.toUpperCase()}${offWhy.slice(1)}.`, ...(relayUrl ? { relayUrl } : {}) }); return; }
    void bounded(res, async () => {
      let ep: Endpoints;
      let c: { readonly id: string; readonly how: Registration };
      try { ep = await endpoints(); c = await client(); } catch (e) {
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
    void bounded(res, async () => {
      const c = await client();
      const ep = await endpoints();
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callbackUrl, client_id: c.id });
      const t = await relayCall(ep.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form.toString() }, [code, verifier]);
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
      // identity-server token (the bridge never calls /identity-token) and no refresh token (dropped
      // here, so nothing on this side can renew the sign-in). It forgets the token when it ends:
      // expires_in from now (the relay's is an hour), at most MAX_TOKEN_SECONDS.
      const lifetime = tj['expires_in'];
      const seconds = typeof lifetime === 'number' && Number.isFinite(lifetime) ? Math.min(Math.max(lifetime, 0), MAX_TOKEN_SECONDS) : DEFAULT_TOKEN_SECONDS;
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
    void bounded(res, async () => {
      // A stateless MCP call, as any MCP client may make one: no initialize and no session, so the
      // relay serves it from its stateless handler and stamps the session's own agent itself.
      const rpcId = `wrd-sign-${randomUUID()}`;
      const secrets = [bearer];
      const r = await relayCall(`${relayUrl}${RELAY_MCP_PATH}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: SIGN_TOOL, arguments: { payload } } }),
      }, secrets);
      const j = isObj(r.json) ? r.json : {};
      const relaySaid = `${typeof j['error'] === 'string' ? `: ${relayText(j['error'], secrets)}` : ''}${typeof j['error_description'] === 'string' ? ` (${relayText(j['error_description'], secrets)})` : ''}`;
      if (r.status === 401) {
        answer(res, 401, { ...refuse(401, SIGN_IN_ENDED, `the relay's ${RELAY_MCP_PATH} answered 401${relaySaid}: it no longer takes the access token this tab holds (it has ended, or is not the relay's)`), code: SIGN_IN_EXPIRED });
        return;
      }
      if (r.status === 403) {
        answer(res, 401, { ...refuse(401, RELAY_REFUSED, `the relay's ${RELAY_MCP_PATH} answered 403${relaySaid}: the access token this tab holds cannot sign`), code: SIGN_IN_REFUSED });
        return;
      }
      if (r.status !== 200) { no(res, 502, NOT_SIGNED, `the relay's ${RELAY_MCP_PATH} answered ${r.status}${relaySaid}`); return; }
      const rpc = mcpResponse(r.text, rpcId);
      if (rpc === null) { no(res, 502, NOT_SIGNED, `the relay's ${RELAY_MCP_PATH} answer holds no JSON-RPC response to this request`); return; }
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
      answer(res, 200, { _signature: signature, _signed_payload: signed });
    });
  });

  app.post(SIGN_IN_PATHS.whoami, (req, res) => {
    if (!ready(res) || refusedPost(req, res, SIGN_IN_MAX_BYTES + 1024, baseHost) || policy === null) return;
    const form = relayEnvelopeOf(isObj(req.body) ? req.body : {});
    if (form === null) { no(res, 400, 'Send a relay-signed request: {_signed_payload, _signature}.', 'the body holds neither _signed_payload nor _signature'); return; }
    void bounded(res, async () => {
      const v = await openRelayDelegated(form.signedPayload, form.signature, policy);
      if (!v.ok) { no(res, v.status, 'The relay-signed request does not name a person this bridge can verify.', `${v.code}: ${v.message}`); return; }
      answer(res, 200, { authority: 'relay-delegated', principal: v.principal, agentId: v.agentId, relaySigner: v.relaySigner, trust: TOKEN_PASSES_THROUGH });
    });
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
