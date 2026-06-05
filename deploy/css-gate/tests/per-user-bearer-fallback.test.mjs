// css-gate per-user-bearer verification fallback (FIX B).
//
// The gate accepts two per-user-bearer verification sources on the
// inbound write path:
//
//   1. identity-server's POST /tokens/verify        (primary)
//   2. mcp-relay's   POST /verify-token             (fallback)
//
// The fallback exists because the relay's OAuth flow mints OPAQUE
// access tokens (randomBytes(32).hex) that the identity server has
// never seen and cannot signature-verify — without the fallback,
// every relay-OAuth-bearer write through the gate gets 401.
//
// This test spins up loopback "identity" and "relay" verifiers,
// points the gate at them via env vars + an injected undici Pool, and
// drives PUTs through the gate's http.Server. We assert:
//
//   1. A bearer the IDENTITY accepts → 201 (path-segment OK), and the
//      RELAY is never called.
//   2. A bearer the IDENTITY rejects (valid:false) → gate falls back
//      to the RELAY; on relay-valid → 201.
//   3. A bearer BOTH reject → 401 with detail propagated.
//   4. A relay-valid bearer but mismatched path segment → 403
//      "cross-pod write denied".
//   5. Cache warm: a second relay-valid request does NOT re-hit the
//      relay (warm path).
//   6. The relay /verify-token request carries the shared bearer
//      secret (gate↔relay introspection auth) — wrong secret = no
//      relay accept (we verify by inspecting the captured headers).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Pool } from 'undici';

// Required env BEFORE importing server.mjs (it reads env at module load).
process.env.WRITE_SECRET = 'test-write-secret';
process.env.CSS_INTERNAL_URL = 'http://upstream.invalid.test';
process.env.CSS_HOST_HEADER = 'css.public.example';
process.env.CSS_GATE_AUTOSTART = '0';
// Use a very short cache TTL so we can write a non-flaky cache test
// (well, we test the warm case here; the expiry case isn't worth the
// time-travel ceremony).
process.env.USER_BEARER_CACHE_TTL_MS = '60000';

// Loopback identity + relay verifiers. We point the gate at these
// via env vars BEFORE importing server.mjs.
function startVerifier(handler) {
  return new Promise((resolve) => {
    const received = [];
    const srv = createHttpServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        received.push({
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body,
        });
        const reply = handler(body, req);
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ srv, received, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// Identity logic: returns valid for token "good-id-token-for-alice",
// 200+valid:false for anything else.
const identity = await startVerifier((body) => {
  try {
    const { token } = JSON.parse(body);
    if (token === 'good-id-token-for-alice') {
      return { status: 200, body: { valid: true, userId: 'alice', agentId: 'agt-alice', scope: 'pod:write' } };
    }
    return { status: 200, body: { valid: false, reason: 'identity does not recognize this token' } };
  } catch {
    return { status: 400, body: { valid: false, reason: 'bad body' } };
  }
});

// Relay logic: requires Authorization: Bearer <RELAY_INTROSPECTION_SECRET>;
// returns valid for "good-relay-token-for-bob"; rejects unknown tokens
// with 200+valid:false (matches the contract).
const RELAY_SECRET = 'test-relay-introspect-secret';
const relay = await startVerifier((body, req) => {
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${RELAY_SECRET}`) {
    return { status: 401, body: { valid: false, reason: 'introspection bearer rejected' } };
  }
  try {
    const { token } = JSON.parse(body);
    if (token === 'good-relay-token-for-bob') {
      return {
        status: 200,
        body: {
          valid: true, userId: 'bob', agentId: 'agt-bob',
          ownerWebId: 'https://example/bob#me', podUrl: 'https://example/bob/',
          scope: 'pod:write', expiresAt: Math.floor(Date.now() / 1000) + 3600,
          clientId: 'oauth-client-1',
        },
      };
    }
    return { status: 200, body: { valid: false, reason: 'relay does not recognize this token' } };
  } catch {
    return { status: 400, body: { valid: false, reason: 'bad body' } };
  }
});

process.env.IDENTITY_URL = identity.base;
process.env.RELAY_VERIFY_URL = relay.base;
process.env.RELAY_INTROSPECTION_SECRET = RELAY_SECRET;

// Now import the gate. server.mjs reads env at module load.
const { server: gateServer, _setUpstreamPool } = await import('../server.mjs');

function startUpstream() {
  return new Promise((resolve) => {
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
        res.writeHead(201, { 'content-type': 'text/turtle' });
        res.end(`OK ${req.method} ${req.url}`);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, received }));
  });
}

function startGate() {
  return new Promise((resolve) => {
    gateServer.listen(0, '127.0.0.1', () => {
      const addr = gateServer.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

function closeServer(srv) {
  return new Promise((resolve) => srv.close(() => resolve()));
}

const upstream = await startUpstream();
const upstreamAddr = upstream.srv.address();
const upstreamOrigin = `http://127.0.0.1:${upstreamAddr.port}`;
const testPool = new Pool(upstreamOrigin, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, testPool);

const gateBase = await startGate();

test('identity-valid bearer passes; relay is not called', async () => {
  upstream.received.length = 0;
  identity.received.length = 0;
  relay.received.length = 0;

  const r = await fetch(`${gateBase}/alice/note.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      'authorization': 'Bearer good-id-token-for-alice',
    },
    body: '<a> <b> <c> .',
  });
  assert.equal(r.status, 201);
  assert.equal(identity.received.length, 1, 'identity must be called as the primary verifier');
  assert.equal(relay.received.length, 0, 'relay must NOT be called when identity validates');
  assert.equal(upstream.received[0].headers.authorization, undefined,
    'bearer must be stripped before forwarding to CSS');
});

test('identity-rejects bearer falls back to relay; relay-valid → 201', async () => {
  upstream.received.length = 0;
  identity.received.length = 0;
  relay.received.length = 0;

  const r = await fetch(`${gateBase}/bob/note.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      'authorization': 'Bearer good-relay-token-for-bob',
    },
    body: '<a> <b> <c> .',
  });
  assert.equal(r.status, 201, 'gate must bubble upstream 201 when relay validates');
  assert.equal(identity.received.length, 1, 'identity is tried first');
  assert.equal(relay.received.length, 1, 'relay is consulted on identity miss');
  // The relay must receive the shared introspection secret.
  assert.equal(relay.received[0].headers.authorization, `Bearer ${RELAY_SECRET}`,
    'gate must carry RELAY_INTROSPECTION_SECRET on its outbound /verify-token');
});

test('both reject → 401 with reason propagated', async () => {
  upstream.received.length = 0;
  identity.received.length = 0;
  relay.received.length = 0;

  const r = await fetch(`${gateBase}/alice/note.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      'authorization': 'Bearer this-token-is-unknown-to-everyone',
    },
    body: '<a> <b> <c> .',
  });
  assert.equal(r.status, 401);
  const json = await r.json();
  assert.match(JSON.stringify(json), /relay does not recognize/);
  assert.equal(upstream.received.length, 0, 'gate must not forward when verification fails');
});

test('relay-valid bearer but wrong path segment → 403 cross-pod write denied', async () => {
  upstream.received.length = 0;
  identity.received.length = 0;
  relay.received.length = 0;

  // Token resolves to userId="bob" but we target /alice/...
  const r = await fetch(`${gateBase}/alice/sneak.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      // Use a fresh bearer NOT in the cache (the bob-token from the
      // earlier test is cached); a new opaque value forces a re-check.
      'authorization': 'Bearer good-relay-token-for-bob-2',
    },
    body: '<a> <b> <c> .',
  });
  // We didn't teach the relay loopback about "-2", so it returns
  // valid:false — which here surfaces as 401 (both rejected). The
  // 403-cross-pod path requires a token the verifier accepts but for
  // a different userId. Use the cached good token instead:
  assert.equal(r.status, 401);

  // Now the real 403 test: cached good token, wrong target pod.
  const r2 = await fetch(`${gateBase}/alice/sneak.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      'authorization': 'Bearer good-relay-token-for-bob',
    },
    body: '<a> <b> <c> .',
  });
  assert.equal(r2.status, 403);
  const j = await r2.json();
  assert.equal(j.error, 'cross-pod write denied');
});

test('relay-valid bearer cache warm: second hit does NOT re-call relay', async () => {
  upstream.received.length = 0;
  identity.received.length = 0;
  relay.received.length = 0;

  // First call hits both verifiers (already done in earlier test
  // BUT the cache may have been populated; re-use the same token).
  const r1 = await fetch(`${gateBase}/bob/note-1.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      'authorization': 'Bearer good-relay-token-for-bob',
    },
    body: '<a> <b> <c> .',
  });
  assert.equal(r1.status, 201);
  const callsAfterFirst = relay.received.length;

  // Second call — same bearer, different (still bob-scoped) path.
  const r2 = await fetch(`${gateBase}/bob/note-2.ttl`, {
    method: 'PUT',
    headers: {
      'content-type': 'text/turtle',
      'authorization': 'Bearer good-relay-token-for-bob',
    },
    body: '<a> <b> <c> .',
  });
  assert.equal(r2.status, 201);
  assert.equal(relay.received.length, callsAfterFirst,
    'second cached-warm call must not produce another relay /verify-token roundtrip');
});

test('teardown', async () => {
  await testPool.close();
  await closeServer(gateServer);
  await closeServer(upstream.srv);
  await closeServer(identity.srv);
  await closeServer(relay.srv);
});
