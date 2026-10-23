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
import { readFileSync } from 'node:fs';
import { parse as parseQueryString } from 'node:querystring';
import type { Express, NextFunction, Request, Response } from 'express';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';

export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** HTML-safe text for an attribute or element body (the shell interpolates one value: the bridge's base URL). */
const htmlText = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(base: string): string {
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
    '<div id="app" class="app" aria-live="polite"><p class="muted">Loading the affordance manifest…</p></div>',
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

/** Mount GET /ui, /ui/app.js and /ui/app.css. `base` is the bridge's public base URL. */
export function attachUi(app: Express, opts: { readonly base: string }): void {
  const appJs = readFileSync(new URL('./ui/app.js', import.meta.url), 'utf8');
  const html = shell(opts.base.replace(/\/$/, ''));
  app.get('/ui', (_req, res) => { secure(res); res.type('text/html; charset=utf-8').send(html); });
  app.get('/ui/app.js', (_req, res) => { secure(res); res.type('text/javascript; charset=utf-8').send(appJs); });
  app.get('/ui/app.css', (_req, res) => { secure(res); res.type('text/css; charset=utf-8').send(APP_CSS); });
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
