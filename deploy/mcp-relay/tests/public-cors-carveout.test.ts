#!/usr/bin/env tsx
/**
 * The public CORS carve-out — tested where the decision actually lives.
 *
 * ★ WHY THIS FILE EXISTS. A fix was made in the agent-interop mount to expose the
 * `Link` and `ETag` headers to cross-origin readers. It passed its test and was
 * absent from production. The route handler was not wrong; it was POWERLESS —
 * server.ts installs a middleware that freezes every `access-control-*` header, so
 * `setHeader` for those names is a silent no-op in any handler mounted after it.
 *
 * The mount test boots the mount ALONE. It therefore cannot observe the freeze, and
 * no amount of assertion strength in that file would have caught this. The lesson is
 * not "write a stronger assertion" — it is that a test of a component in isolation
 * says nothing about a behaviour the composition decides. So this tests the
 * middleware that genuinely owns the decision, with the freeze in place.
 */

import express from 'express';
import { corsMiddleware } from '../cors-allowlist.js';
import { listenLoopback } from './listen-loopback.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('\npublic CORS carve-out: a public document is only as followable as its headers are readable');

const app = express();
app.use(corsMiddleware({ allowedOrigins: ['https://app.example'] } as never) as never);

// Reproduce the production hazard: the SAME freeze server.ts installs, mounted
// between the CORS middleware and the routes. Without this the test would pass
// while production failed, which is the exact bug being guarded.
const FROZEN = new Set([
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-expose-headers',
  'access-control-allow-credentials', 'vary',
]);
app.use((_req, res, next) => {
  const original = res.setHeader.bind(res);
  (res as never as { setHeader: typeof res.setHeader }).setHeader = function (
    name: string, value: number | string | readonly string[],
  ) {
    if (typeof name === 'string' && FROZEN.has(name.toLowerCase())) return res;
    return original(name, value);
  };
  next();
});

// A route that tries to set the header itself — as the mount used to. It must be
// demonstrably unable to, so the test proves WHY the header has to be set upstream.
for (const p of ['/.well-known/agent-card.json', '/.well-known/interego-agents.json', '/ns/maintainer/hmd']) {
  app.get(p, (_req, res) => {
    res.setHeader('Access-Control-Expose-Headers', 'X-Should-Not-Win');
    res.setHeader('Link', '<https://relay.test/ns/x>; rel="describedby"');
    res.setHeader('ETag', '"abc"');
    res.json({ ok: true });
  });
}
app.get('/private', (_req, res) => res.json({ ok: true }));

// Loopback-bound and closed from a `finally`: `srv.close()` used to be the last statement
// of this block, so every throwing path above it — a rejected fetch, a header that is not
// there — left the listener bound. See tests/listen-loopback.ts.
const srv = await listenLoopback(app);
const B = srv.base;

try {
  for (const p of ['/.well-known/agent-card.json', '/.well-known/interego-agents.json', '/ns/maintainer/hmd']) {
    const r = await fetch(`${B}${p}`, { headers: { Origin: 'https://stranger.example' } });
    const acao = r.headers.get('access-control-allow-origin');
    const exposed = (r.headers.get('access-control-expose-headers') ?? '').toLowerCase();

    check(`${p} is readable by ANY origin`, acao === '*', String(acao));
    check(`${p} exposes Link so the client can follow it`,
      exposed.includes('link'), exposed || '<unset>');
    check(`${p} exposes ETag so the client can revalidate`,
      exposed.includes('etag'), exposed || '<unset>');
    // The point of the whole file: the handler's own attempt lost to the freeze.
    check(`${p} — the ROUTE's attempt to set it was silently dropped (proves it must be upstream)`,
      !exposed.includes('x-should-not-win'), exposed);
  }

  // The carve-out must stay a carve-out: a non-public path is still allowlisted.
  const priv = await fetch(`${B}/private`, { headers: { Origin: 'https://stranger.example' } });
  check('a non-carve-out path does NOT become world-readable',
    priv.headers.get('access-control-allow-origin') !== '*',
    String(priv.headers.get('access-control-allow-origin')));

  // Credentials must never be combined with the wildcard.
  const cardR = await fetch(`${B}/.well-known/agent-card.json`, { headers: { Origin: 'https://stranger.example' } });
  check('no Allow-Credentials is emitted alongside the wildcard',
    !cardR.headers.get('access-control-allow-credentials'),
    String(cardR.headers.get('access-control-allow-credentials')));
} finally {
  await srv.close();
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nPublic CORS carve-out holds.\n');
