// css-gate's call to identity's POST /tokens/verify carries IDENTITY_INTROSPECTION_SECRET, and
// follows no redirect.
//
// An identity server holding the variable answers a verify without `Authorization: Bearer
// <that value>` with 401, so the gate must present it whenever it holds the variable. The
// unset case (no Authorization at all) is asserted in per-user-bearer-fallback.test.mjs.
//
// A redirect from the verifier must not be followed: on a 307 or 308 fetch re-sends the POST
// body, which is the user's own token, to wherever the Location points, and on a same-origin
// redirect it re-sends the Authorization header as well. Neither verifier redirects, so the
// gate refuses the redirect and treats the verify as failed.
//
// /healthz reports whether the gate presents a bearer (`identityVerifyAuth`) and how identity
// has answered since start (`identityVerifyResults`), and never the value. The rollout tool
// (tools/identity-introspection-provision.mjs) reads a rise in `accepted` as identity accepting
// the gate, so every answer that is not a 2xx JSON verify result has to land in `refused` (401,
// 403) or `other` (5xx, 429 and other 4xx, a redirect, a body that is not JSON), never in
// `accepted`.
//
// This file runs in its own process under `node --test`, so the env set here is its own.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

const SECRET = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

process.env.WRITE_SECRET = 'test-write-secret';
process.env.CSS_INTERNAL_URL = 'http://upstream.invalid.test';
process.env.PUBLIC_BASE_URL = 'http://gate.invalid.test';
process.env.CSS_HOST_HEADER = 'css.public.example';
process.env.CSS_GATE_AUTOSTART = '0';
process.env.USER_BEARER_CACHE_TTL_MS = '60000';
delete process.env.RELAY_VERIFY_URL;
delete process.env.RELAY_INTROSPECTION_SECRET;

/** A loopback server that records every request and answers with `handler`. */
async function recording(handler) {
  const received = [];
  const srv = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      const reply = handler(req, body);
      res.writeHead(reply.status, { 'content-type': 'application/json', ...(reply.headers ?? {}) });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    });
  });
  return { ...(await listenLoopback(srv)), received };
}

const VALID_ALICE = { status: 200, body: { valid: true, userId: 'alice', agentId: 'agt-alice', scope: 'pod:write' } };

// Anything that reaches it is a request that followed a redirect off the verifier.
const trap = await recording(() => VALID_ALICE);

let expected = SECRET;
const identity = await recording((req, body) => {
  if (req.url === '/elsewhere') return VALID_ALICE;
  if (req.headers.authorization !== `Bearer ${expected}`) {
    return { status: 401, body: { error: 'introspection bearer rejected' } };
  }
  const { token } = JSON.parse(body);
  if (token === 'good') return VALID_ALICE;
  if (token === 'redirect-away') return { status: 307, headers: { location: `${trap.base}/tokens/verify` } };
  if (token === 'redirect-same') return { status: 307, headers: { location: '/elsewhere' } };
  if (token === 'answer-500') return { status: 500, body: { error: 'internal' } };
  if (token === 'answer-429') return { status: 429, body: { error: 'Too many requests' } };
  if (token === 'answer-400') return { status: 400, body: { error: 'token required' } };
  if (token === 'not-json') return { status: 200, raw: 'ok' };
  return { status: 200, body: { valid: false, reason: 'Token not found' } };
});

process.env.IDENTITY_URL = identity.base;
process.env.IDENTITY_INTROSPECTION_SECRET = SECRET;

const { server: gateServer, _setUpstreamPool } = await import('../server.mjs');

const upstream = await recording(() => ({ status: 201, body: {} }));
const testPool = new Pool(upstream.base, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, testPool);
const gate = await listenLoopback(gateServer);

after(async () => {
  await testPool.close();
  await gate.close();
  await upstream.close();
  await identity.close();
  await trap.close();
});

async function put(bearer, path = '/alice/a') {
  const r = await fetch(`${gate.base}${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/turtle', authorization: `Bearer ${bearer}` },
    body: '<a> <b> <c> .',
  });
  return { status: r.status, text: await r.text() };
}

async function healthz() {
  const text = await (await fetch(`${gate.base}/healthz`)).text();
  return { text, body: JSON.parse(text) };
}

test('the verify call carries Bearer <IDENTITY_INTROSPECTION_SECRET>', async () => {
  identity.received.length = 0;
  upstream.received.length = 0;
  const r = await put('good');
  assert.equal(r.status, 201, r.text);
  assert.equal(identity.received.length, 1);
  assert.equal(identity.received[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0].headers.authorization, undefined, 'the bearer is stripped before CSS');
});

test('a redirect to another origin is not followed: neither the secret nor the token goes there', async () => {
  upstream.received.length = 0;
  const r = await put('redirect-away');
  assert.equal(r.status, 401, r.text);
  assert.equal(trap.received.length, 0, `the trap was sent: ${JSON.stringify(trap.received)}`);
  assert.equal(r.text.includes(SECRET), false);
  assert.equal(upstream.received.length, 0, 'nothing is forwarded after a failed verify');
});

test('a redirect on the same origin is not followed either', async () => {
  upstream.received.length = 0;
  const r = await put('redirect-same');
  assert.equal(r.status, 401, r.text);
  assert.equal(identity.received.some((q) => q.url === '/elsewhere'), false, 'the redirect target was requested');
  assert.equal(upstream.received.length, 0);
});

test('/healthz says a bearer is presented, counts identity\'s answers, and never shows the value', async () => {
  const before = (await healthz()).body.identityVerifyResults;
  assert.equal(typeof before.accepted, 'number');
  const r = await put('good-2');
  assert.equal(r.status, 401, 'identity answered valid:false and there is no relay to ask');
  const h = await healthz();
  assert.equal(h.body.identityVerifyAuth, true);
  assert.equal(h.text.includes(SECRET), false);
  assert.equal(h.text.includes(SECRET.slice(0, 12)), false);
  assert.equal(h.body.identityVerifyResults.accepted, before.accepted + 1);
  assert.equal(h.body.identityVerifyResults.refused, before.refused);
});

test('identity refusing the gate\'s bearer is counted as refused', async () => {
  const before = (await healthz()).body.identityVerifyResults;
  expected = 'other';
  try {
    const r = await fetch(`${gate.base}/alice/auth-methods.jsonld`, { headers: { authorization: 'Bearer fresh-token-1' } });
    const text = await r.text();
    assert.equal(r.status, 401, text);
    assert.equal(text.includes(SECRET), false);
  } finally {
    expected = SECRET;
  }
  const after = (await healthz()).body.identityVerifyResults;
  assert.equal(after.refused, before.refused + 1);
  assert.equal(after.accepted, before.accepted);
});

for (const [token, what] of [
  ['answer-500', 'a 500'],
  ['answer-429', 'a 429'],
  ['answer-400', 'another 4xx'],
  ['redirect-away', 'a redirect'],
  ['not-json', 'a 2xx body that is not JSON'],
]) {
  test(`${what} from identity is counted as other, not as accepted or refused`, async () => {
    const before = (await healthz()).body.identityVerifyResults;
    const r = await put(token);
    assert.equal(r.status, 401, r.text);
    assert.equal(r.text.includes(SECRET), false);
    const after = (await healthz()).body.identityVerifyResults;
    assert.deepEqual(after, { accepted: before.accepted, refused: before.refused, other: before.other + 1 });
  });
}
