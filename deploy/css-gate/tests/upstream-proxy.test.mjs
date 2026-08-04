// css-gate upstream-proxy contract test.
//
// Spins up a tiny loopback HTTP server that pretends to be CSS, points
// the gate's undici Pool at it (via the _setUpstreamPool test hook), and
// drives requests through the gate's http.Server on an ephemeral port.
//
// Asserts:
//   1. The gate's outgoing Host header equals CSS_HOST_HEADER when set,
//      regardless of the upstream's actual hostname (this is the whole
//      reason the gate exists — CSS would reject a mismatched Host with
//      "outside the configured identifier space").
//   2. The upstream's status code is bubbled up to the caller 1:1.
//   3. The upstream's response body is bubbled up 1:1.
//   4. Anonymous GETs pass through (the read path is not gated).
//   5. Anonymous writes are denied with 401 (the write gate is enforced).
//   6. Operator-bearer writes pass through AND the bearer is stripped
//      before forwarding (CSS must not see Authorization).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

// Required env BEFORE importing server.mjs (it reads env at module load).
process.env.WRITE_SECRET = 'test-write-secret';
process.env.CSS_INTERNAL_URL = 'http://upstream.invalid.test';
process.env.PUBLIC_BASE_URL = 'http://gate.invalid.test';
process.env.CSS_HOST_HEADER = 'css.public.example';
process.env.CSS_GATE_AUTOSTART = '0';
// Suppress the unset-IDENTITY_URL warning during tests.
process.env.IDENTITY_URL = '';

const { server: gateServer, _setUpstreamPool } = await import('../server.mjs');

// ── Loopback "upstream" that records what the gate forwarded. ───────
//
// Every listener here goes through listenLoopback, which unrefs the handle and destroys
// the keep-alive sockets fetch() leaves behind before closing. Without the unref, a run
// that never reaches the teardown does not leak a socket — it leaks a PROCESS that cannot
// exit because of one, which is how these suites were found still holding ports days
// later. See tests/loopback.mjs.
async function startUpstream() {
  const received = [];
  const srv = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      // Echo a known status + body so the test can assert pass-through.
      res.writeHead(201, { 'content-type': 'text/turtle', 'x-upstream-token': 'echoed' });
      res.end(`OK ${req.method} ${req.url}`);
    });
  });
  return { ...(await listenLoopback(srv)), received };
}

// ── Test harness setup. ─────────────────────────────────────────────
const upstream = await startUpstream();
const upstreamOrigin = upstream.base;

// Point the gate's pool at our loopback upstream. The Pool is keyed
// by the origin of CSS_INTERNAL_URL — we override that key so the
// gate's pool lookup hits OUR Pool instead of trying to dial the
// nonexistent CSS_INTERNAL_URL host.
//
// allowH2 is intentionally false here — Node's bare http.createServer
// does not negotiate h2, and we are testing the gate's request-forming
// behavior, not the h2 transport itself.
const testPool = new Pool(upstreamOrigin, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, testPool);

const gate = await listenLoopback(gateServer);
const gateBase = gate.base;

// ★ `after`, not a trailing `test('teardown')`. An `after` hook runs when the file is
// done however it got there — including after a failing assertion — whereas a teardown
// written as the last test only runs if the file reaches it, and registers only if the
// top-level setup above it did not throw first.
after(async () => {
  await testPool.close();
  await gate.close();
  await upstream.close();
});

test('GET passes through anonymously and bubbles status + body 1:1', async () => {
  upstream.received.length = 0;
  const r = await fetch(`${gateBase}/markj/test-graph`);
  assert.equal(r.status, 201);
  assert.equal(await r.text(), 'OK GET /markj/test-graph');
  assert.equal(r.headers.get('x-upstream-token'), 'echoed');

  assert.equal(upstream.received.length, 1);
  const got = upstream.received[0];
  assert.equal(got.method, 'GET');
  assert.equal(got.url, '/markj/test-graph');
  // The gate translated the outgoing Host to the configured CSS host
  // header (this is the central correctness property — CSS uses Host
  // to decide whether a request is in its identifier space).
  assert.equal(got.headers.host, 'css.public.example');
});

test('anonymous PUT is denied with 401 (write gate enforced)', async () => {
  upstream.received.length = 0;
  const r = await fetch(`${gateBase}/markj/x.ttl`, {
    method: 'PUT',
    headers: { 'content-type': 'text/turtle' },
    body: '<a> <b> <c> .',
  });
  assert.equal(r.status, 401);
  assert.equal(upstream.received.length, 0, 'gate must NOT forward an unauthenticated write');
});

test('operator-bearer PUT passes through, bearer is stripped, Host is translated, body + status bubble 1:1', async () => {
  upstream.received.length = 0;
  const r = await fetch(`${gateBase}/markj/x.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      'authorization': `Bearer ${process.env.WRITE_SECRET}`,
    },
    body: '<a> <b> <c> .',
  });
  assert.equal(r.status, 201, 'gate must bubble upstream 201 through');
  assert.equal(await r.text(), 'OK PUT /markj/x.ttl');

  assert.equal(upstream.received.length, 1);
  const got = upstream.received[0];
  assert.equal(got.method, 'PUT');
  assert.equal(got.url, '/markj/x.ttl');
  assert.equal(got.headers.host, 'css.public.example',
    'Host MUST be translated to CSS_HOST_HEADER, not the upstream socket hostname');
  assert.equal(got.headers.authorization, undefined,
    'Authorization MUST be stripped before forwarding so CSS does not try to parse it');
  assert.equal(got.headers['content-type'], 'text/turtle');
  assert.equal(got.body, '<a> <b> <c> .');
});

test('query string is preserved on the forwarded path', async () => {
  upstream.received.length = 0;
  const r = await fetch(`${gateBase}/markj/x.ttl?slug=foo&depth=1`);
  assert.equal(r.status, 201);
  assert.equal(upstream.received[0].url, '/markj/x.ttl?slug=foo&depth=1');
});

// ★ HSTS, ON EVERY EXIT PATH, ASSERTED THROUGH THE REAL SERVER.
//
// The gate is the ONE public surface that carries `Authorization: Bearer <WRITE_SECRET>`,
// so it is the one where a first-request protocol downgrade costs a credential rather than
// a page view — and it was the one surface serving no Strict-Transport-Security in
// production while relay, identity and dashboard all sent it.
//
// The code sets it with a single `res.setHeader` at the top of the handler, which is the
// right shape, and NOTHING TESTED IT — so it was one deleted line from silently regressing,
// and the deployed image predated the line entirely. The sibling suite
// (`cors-and-headers.test.mjs`) could not have caught this: it calls `corsHeadersFor`, a
// pure function that never touches the response object. A test that stands in for the
// server cannot verify what the server sets on a response.
//
// Each case below is a DIFFERENT exit path — preflight short-circuits, /healthz never
// proxies, the 401 is written before any upstream call, and the proxied body is streamed —
// which is exactly the "remember it at every writeHead" pattern the header went missing to.
test('every response carries Strict-Transport-Security, on all four exit paths', async () => {
  const hsts = (r) => r.headers.get('strict-transport-security');

  const preflight = await fetch(`${gateBase}/markj/x.ttl`, {
    method: 'OPTIONS',
    headers: { origin: 'https://dashboard.interego.xwisee.com', 'access-control-request-method': 'PUT' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(hsts(preflight), 'max-age=31536000', 'CORS preflight must carry HSTS');

  const health = await fetch(`${gateBase}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(hsts(health), 'max-age=31536000', '/healthz must carry HSTS');

  const denied = await fetch(`${gateBase}/markj/x.ttl`, { method: 'PUT', body: 'x' });
  assert.equal(denied.status, 401);
  assert.equal(hsts(denied), 'max-age=31536000',
    'the 401 is the response an unauthenticated client sees FIRST — it must carry HSTS');

  const proxied = await fetch(`${gateBase}/markj/x.ttl`);
  assert.equal(hsts(proxied), 'max-age=31536000', 'the proxied upstream response must carry HSTS');
});
