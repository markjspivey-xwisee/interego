// A CLIENT THAT WALKS AWAY MUST NOT COST THIS GATE A CONNECTION.
//
// ── ★★ THE INCIDENT THIS COMES FROM ─────────────────────────────────
//
// Twice in three hours, css-gate accepted TCP, completed TLS, and then never answered a single
// proxied request. CSS behind it was healthy throughout — its own log showed it serving requests
// the whole time. Railway reported the service SUCCESS, and the gate's own /healthz answered 200,
// because /healthz does not proxy.
//
// The mechanism: an undici Pool connection is returned only when its response body is CONSUMED.
// The gate piped the upstream body to the client and handled 'error', but nothing handled the
// CLIENT GOING AWAY. A disconnect mid-stream left the body undrained, so that connection was never
// released. The pool is `connections: 16` with an unbounded queue, so after sixteen such leaks
// every later request — read or write — queued forever.
//
// The cost was not one outage. It was three wrong diagnoses: a delegate concluded Foxxi published
// nothing, I concluded the relay's stale URN hint was to blame, and both of us were reasoning about
// a dependency that had stopped answering while looking healthy.
//
// These cases drive the REAL server through a REAL socket and assert on the REAL pool's counters.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

process.env.WRITE_SECRET = 'test-write-secret';
process.env.CSS_INTERNAL_URL = 'http://upstream.invalid.test';
process.env.PUBLIC_BASE_URL = 'http://gate.invalid.test';
process.env.CSS_HOST_HEADER = 'css.public.example';
process.env.CSS_GATE_AUTOSTART = '0';
process.env.IDENTITY_URL = '';

const { server: gateServer, _setUpstreamPool, _getUpstreamPool } = await import('../server.mjs');

/** An upstream that streams slowly, so a client can disconnect mid-body. */
async function startSlowUpstream() {
  const srv = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first-chunk');
    // Never finished within the test's lifetime: the point is a body left mid-flight.
    setTimeout(() => { try { res.end('second-chunk'); } catch { /* client gone */ } }, 5_000).unref?.();
  });
  return listenLoopback(srv);
}

const upstream = await startSlowUpstream();
const pool = new Pool(upstream.base, { connections: 2 });
_setUpstreamPool('http://upstream.invalid.test', pool);
const gate = await listenLoopback(gateServer);

after(async () => {
  await pool.close().catch(() => {});
  await gate.close?.().catch?.(() => {});
  await upstream.close?.().catch?.(() => {});
});

/** The gate's live view of its own pool, as /healthz reports it. */
const poolStats = () => _getUpstreamPool('http://upstream.invalid.test').stats;

test('★★ a client that disconnects mid-body does not strand an upstream connection', async () => {
  const before = poolStats().running ?? 0;

  // Start a read and abandon it once the first chunk is on the wire — a page closed, a poll
  // cancelled, an agent timing out. All ordinary.
  for (let i = 0; i < 4; i++) {
    const ac = new AbortController();
    const req = fetch(`${gate.base}/u-eth-x/thing.ttl`, { signal: ac.signal });
    // Wait until bytes are actually flowing, then walk away.
    await req.then(async (r) => {
      const reader = r.body.getReader();
      await reader.read();
      ac.abort();
      await reader.cancel().catch(() => {});
    }).catch(() => { /* the abort itself */ });
  }

  // Give the server's 'close' handler a tick to run for each.
  await new Promise((r) => { setTimeout(r, 500); });

  const after_ = poolStats();
  // ★ THE ASSERTION THAT FAILS WITHOUT THE FIX. Four abandoned reads against a two-connection
  // pool strand every connection, and `running` stays pinned at the pool size forever.
  assert.ok(
    (after_.running ?? 0) <= before + 1,
    `four abandoned reads left ${after_.running} connection(s) running (was ${before}) — `
    + 'the pool is leaking, and once it is full the gate stops answering entirely',
  );
});

test('★★ /healthz reports pool saturation instead of a bare 200', async () => {
  // /healthz answered 200 through both incidents because it does not proxy. It cannot be made to
  // proxy — that would couple the gate's liveness to CSS's — so instead it now carries the one
  // fact that distinguishes "idle" from "wedged".
  const r = await fetch(`${gate.base}/healthz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok('upstreamPool' in body, '/healthz must report the pool, or a wedge is invisible from outside');
  assert.ok('saturated' in body, '/healthz must say whether the pool is saturated');
  assert.equal(typeof body.saturated, 'boolean');
});
