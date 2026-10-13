/**
 * css-gate decides on the path it forwards, and each pod's sign-in record is read only by its owner.
 *
 * ── ★★ TWO HOLES THESE CLOSE ─────────────────────────────────────────────────
 *
 * 1. A CROSS-POD WRITE. The gate took the pod from the RAW request-target and forwarded the
 *    WHATWG-parsed URL, which removes `..` segments (percent-encoded ones too). So
 *    `PUT /alice/../bob/x` with alice's bearer was checked as a write to alice and arrived at CSS
 *    as `PUT /bob/x`. Any signed-in user could write into any pod, including the
 *    `auth-methods.jsonld` the identity server signs people in from.
 *
 * 2. EVERY ACCOUNT'S SIGN-IN RECORD WAS PUBLIC. Reads pass through anonymously, and
 *    `auth-methods.jsonld` is plaintext: anyone listing the root container could read every
 *    account's display name tied to its wallet addresses, passkey labels and DIDs.
 *
 * Requests are sent with node:http, not fetch(): fetch normalizes `..` out of the URL before it
 * leaves the client, so it could never send the request that exploited hole 1.
 *
 * Run:
 *   node --test "tests/*.test.mjs"
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

process.env.WRITE_SECRET = 'test-write-secret';
process.env.CSS_INTERNAL_URL = 'http://upstream.invalid.test';
process.env.PUBLIC_BASE_URL = 'http://gate.invalid.test';
process.env.CSS_GATE_AUTOSTART = '0';

// Identity verifier: alice's token is valid for userId "alice"; nothing else is.
const identity = await listenLoopback(createHttpServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const { token } = JSON.parse(body || '{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(token === 'alice-token'
      ? { valid: true, userId: 'alice', agentId: 'agt-alice', scope: 'pod:write' }
      : { valid: false, reason: 'unknown token' }));
  });
}));
process.env.IDENTITY_URL = identity.base;
delete process.env.RELAY_VERIFY_URL;

const { server: gateServer, _setUpstreamPool } = await import('../server.mjs');

// Upstream CSS stand-in: records each request it receives.
const received = [];
const upstream = await listenLoopback(createHttpServer((req, res) => {
  req.resume();
  req.on('end', () => {
    received.push({ method: req.method, url: req.url, authorization: req.headers['authorization'] });
    res.writeHead(200, { 'content-type': 'application/ld+json' });
    res.end('{}');
  });
}));
const pool = new Pool(upstream.base, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, pool);
const gate = await listenLoopback(gateServer);

after(async () => {
  await pool.close();
  await gate.close();
  await upstream.close();
  await identity.close();
});

const BEARER = { alice: 'Bearer alice-token', operator: 'Bearer test-write-secret' };

/** Send `path` exactly as written, and report the status and what reached the upstream. */
function send(method, path, authorization) {
  received.length = 0;
  const { hostname, port } = new URL(gate.base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: hostname, port, method, path,
      headers: authorization ? { authorization } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, upstream: [...received] });
      });
    });
    req.on('error', reject);
    req.end(method === 'PUT' ? '<> a <urn:x> .' : undefined);
  });
}

test('★★ a user bearer cannot reach another pod through dot segments', async () => {
  for (const path of ['/alice/../bob/x', '/alice/%2e%2e/bob/x', '/alice/.%2E/bob/x', '/alice/sub/../../bob/x', '/alice\\..\\bob/x', '//bob/x']) {
    const r = await send('PUT', path, BEARER.alice);
    assert.equal(r.status, 403, `${path} → ${r.status}`);
    assert.equal(r.json?.error, 'cross-pod write denied', path);
    assert.deepEqual(r.upstream, [], `${path} must not reach CSS`);
  }
  // An encoded separator is refused outright: whether CSS decodes it decides the pod.
  const enc = await send('PUT', '/alice/x%2F..%2F..%2Fbob%2Fx', BEARER.alice);
  assert.equal(enc.status, 400);
  assert.deepEqual(enc.upstream, []);
});

test('a user bearer still writes into its own pod, at the path the check saw', async () => {
  for (const [path, forwarded] of [['/alice/x', '/alice/x'], ['/alice/a/../x', '/alice/x'], ['/alice/x?y=1', '/alice/x?y=1']]) {
    const r = await send('PUT', path, BEARER.alice);
    assert.equal(r.status, 200, path);
    assert.deepEqual(r.upstream.map((u) => u.url), [forwarded], path);
    assert.equal(r.upstream[0].authorization, undefined, 'the bearer is stripped before CSS');
  }
});

test('★★ a pod\'s sign-in record is not readable anonymously, however it is spelled', async () => {
  for (const [method, path] of [
    ['GET', '/alice/auth-methods.jsonld'], ['HEAD', '/alice/auth-methods.jsonld'],
    ['GET', '/alice/auth-methods.jsonld?x=1'], ['GET', '/alice/AUTH-METHODS.JSONLD'],
    ['GET', '/alice/auth%2Dmethods.jsonld'], ['GET', '/alice/x/../auth-methods.jsonld'],
    ['GET', '/alice/%2e%2e/alice/auth-methods.jsonld'], ['GET', '/alice%2Fauth-methods.jsonld'],
    ['GET', '//alice/auth-methods.jsonld'], ['GET', '/alice\\auth-methods.jsonld'],
  ]) {
    const r = await send(method, path);
    assert.equal(r.status, 401, `${method} ${path} → ${r.status}`);
    assert.deepEqual(r.upstream, [], `${method} ${path} must not reach CSS`);
  }
});

test('the owner and the operator read it; another user does not', async () => {
  const own = await send('GET', '/alice/auth-methods.jsonld', BEARER.alice);
  assert.equal(own.status, 200);
  assert.deepEqual(own.upstream.map((u) => [u.url, u.authorization]), [['/alice/auth-methods.jsonld', undefined]]);
  const op = await send('GET', '/bob/auth-methods.jsonld', BEARER.operator);
  assert.equal(op.status, 200);
  const other = await send('GET', '/bob/auth-methods.jsonld', BEARER.alice);
  assert.equal(other.status, 403);
  assert.equal(other.json?.error, 'cross-pod read denied');
  assert.deepEqual(other.upstream, []);
  const forged = await send('GET', '/alice/auth-methods.jsonld', 'Bearer not-a-token');
  assert.equal(forged.status, 401);
});

test('every other read stays anonymous', async () => {
  for (const path of ['/', '/alice/', '/alice/profile/card', '/alice/context-graphs/1.ttl', '/alice/sub/auth-methods.jsonld']) {
    const r = await send('GET', path);
    assert.equal(r.status, 200, path);
    assert.deepEqual(r.upstream.map((u) => u.url), [path], path);
  }
});
