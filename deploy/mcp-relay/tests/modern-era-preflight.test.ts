#!/usr/bin/env tsx
/**
 * A browser can actually SPEAK the 2026-07-28 revision.
 *
 * ★ WHY. Protocol revision 2026-07-28 REQUIRES `Mcp-Method` on every modern request,
 * and `Mcp-Name` whenever the body carries `params.name` (i.e. every `tools/call`).
 * Measured against the SDK: omitting either yields `-32020` — "the request headers and
 * body disagree".
 *
 * A browser cannot send a header the CORS preflight did not allow. So a server can
 * implement the whole revision correctly and still be unreachable from every browser
 * client, with no error on the server side at all — the request simply never arrives.
 * That was the state after the transport migration: all three deployed services served
 * the modern era, and none of them allowed its headers. Verified live at the time:
 *
 *   relay        Content-Type, Authorization, mcp-session-id, mcp-protocol-version, DPoP
 *   foxxi-bridge Content-Type, Authorization, X-Experience-API-Version, If-Match, If-None-Match
 *   bridge       Content-Type
 *
 * This pins the allow-list at the layer that owns it. The allow-list is duplicated
 * across four files (relay + identity share a shape; the foxxi bridge and the substrate
 * demo bridge each set their own), which is exactly how one surface silently stops
 * accepting a revision the others serve — so this asserts the relay's, and the sibling
 * copies are kept identical by hand with a comment saying why.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { corsMiddleware } from '../cors-allowlist.js';

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`); }
};

const ORIGIN = 'https://dashboard.interego.xwisee.com';

const app = express();
app.use(corsMiddleware());
app.post('/mcp', (_req, res) => { res.json({ ok: true }); });
const server = app.listen(0);
await new Promise<void>(r => server.once('listening', () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

console.log('\n/mcp preflight: the modern era is reachable from a browser');

try {
  const res = await fetch(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, mcp-method, mcp-name',
    },
  });
  const allow = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();

  ok(res.status >= 200 && res.status < 400, 'the preflight is answered', `HTTP ${res.status}`);

  // The two the revision makes mandatory. Without these the modern era is served but
  // no browser can reach it.
  ok(allow.includes('mcp-method'),
    'Mcp-Method is allowed (required on every modern request; -32020 without it)', allow);
  ok(allow.includes('mcp-name'),
    'Mcp-Name is allowed (required on every modern tools/call)', allow);

  // Still-needed companions: the 2025 era is served from the same endpoint.
  for (const h of ['content-type', 'authorization', 'mcp-protocol-version', 'mcp-session-id']) {
    ok(allow.includes(h), `${h} is still allowed (2025-era clients share this endpoint)`, allow);
  }

  // DPoP is the relay's proof-of-possession scheme; dropping it from the list would
  // silently downgrade every browser client to plain Bearer.
  ok(allow.includes('dpop'), 'DPoP is still allowed', allow);
} finally {
  server.close();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
