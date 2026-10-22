/**
 * The web UI and the browser-facing protection of a practice-evidence bridge.
 *
 * `attachUi` serves three things and nothing else: a static HTML shell at /ui, the client at
 * /ui/app.js and its styles at /ui/app.css. The client is a Path-A client: it reads this
 * bridge's affordance manifest and invokes every act at the target the manifest names. It adds no
 * endpoint of its own, holds no key (demo role keys stay in the bridge; wallet keys stay in the
 * wallet) and computes nothing the record does not already say.
 *
 * Every UI response carries a Content-Security-Policy that allows only this origin's own script,
 * style and fetches, and no inline script or style; the shell has neither, and the client renders
 * every piece of untrusted text through textContent.
 *
 * `hostAllowlistGuard` refuses (421) any request whose Host header is not one of the names this
 * bridge is served under. A loopback bridge that holds a signing key — and, in demo mode, role
 * keys — would otherwise answer a page on another site that rebinds its own DNS name to
 * 127.0.0.1. Cross-site POSTs are already blocked by the JSON-only body parser and the absence of
 * CORS headers; this closes the rebinding path.
 */
import { readFileSync } from 'node:fs';
import type { Express, NextFunction, Request, Response } from 'express';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';

export const UI_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const readUiFile = (name: string): string => readFileSync(new URL(`./ui/${name}`, import.meta.url), 'utf8');
const APP_JS = readUiFile('app.js');
const APP_CSS = readUiFile('app.css');

/**
 * The shell: a constant, with no interpolation and no inline script or style. Relative URLs, so a
 * bridge deployed under a path prefix still loads its own client.
 */
const SHELL = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="no-referrer">',
  '<title>Practice evidence</title>',
  '<link rel="stylesheet" href="ui/app.css">',
  '<script type="module" src="ui/app.js"></script>',
  '</head>',
  '<body>',
  '<header id="bar"><p class="muted">Practice evidence: loading…</p></header>',
  '<nav id="tabs" aria-label="Views"></nav>',
  '<section id="signing" aria-live="polite"></section>',
  '<main id="view"></main>',
  '<noscript><p>This page needs JavaScript. Everything it offers is also an affordance: see the manifest at <a href="affordances">affordances</a>.</p></noscript>',
  '</body>',
  '</html>',
  '',
].join('\n');

function secure(res: Response): void {
  res.setHeader('Content-Security-Policy', UI_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
}

/** Mount GET /ui, /ui/app.js and /ui/app.css. */
export function attachUi(app: Express): void {
  app.get('/ui', (req: Request, res: Response) => {
    // The shell's URLs are relative to /ui; at /ui/ they would resolve one level too deep.
    if (req.path.endsWith('/')) { res.redirect(301, '../ui'); return; }
    secure(res);
    res.type('text/html; charset=utf-8').send(SHELL);
  });
  app.get('/ui/app.js', (_req: Request, res: Response) => { secure(res); res.type('text/javascript; charset=utf-8').send(APP_JS); });
  app.get('/ui/app.css', (_req: Request, res: Response) => { secure(res); res.type('text/css; charset=utf-8').send(APP_CSS); });
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
