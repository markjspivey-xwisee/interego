// A malformed IDENTITY_INTROSPECTION_SECRET does not appear in the gate's 401.
//
// A value with a line break (or any other byte a header cannot carry) makes fetch throw before
// anything is sent, and undici's error message quotes the whole header value, secret included.
// The gate's 401 carries the verify failure's reason in `detail`, so that reason must not be
// the error's message. This file runs in its own process under `node --test`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

const LEFT = 'x'.repeat(24);
const RIGHT = 'y'.repeat(24);

process.env.WRITE_SECRET = 'test-write-secret';
process.env.CSS_INTERNAL_URL = 'http://upstream.invalid.test';
process.env.PUBLIC_BASE_URL = 'http://gate.invalid.test';
process.env.CSS_HOST_HEADER = 'css.public.example';
process.env.CSS_GATE_AUTOSTART = '0';
delete process.env.RELAY_VERIFY_URL;
delete process.env.RELAY_INTROSPECTION_SECRET;

// Would accept anything; the gate's request never gets this far.
const identity = await listenLoopback(createHttpServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ valid: true, userId: 'alice' }));
}));
process.env.IDENTITY_URL = identity.base;
process.env.IDENTITY_INTROSPECTION_SECRET = `${LEFT}\n${RIGHT}`;

const { server: gateServer, _setUpstreamPool } = await import('../server.mjs');
const testPool = new Pool('http://127.0.0.1:9', { connections: 1 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, testPool);
const gate = await listenLoopback(gateServer);

after(async () => {
  await testPool.close();
  await gate.close();
  await identity.close();
});

test('the 401 says the verify failed and does not quote the header', async () => {
  const r = await fetch(`${gate.base}/alice/a`, {
    method: 'PUT',
    headers: { 'content-type': 'text/turtle', authorization: 'Bearer some-user-token' },
    body: '<a> <b> <c> .',
  });
  const text = await r.text();
  assert.equal(r.status, 401, text);
  assert.match(JSON.parse(text).detail, /unreachable/);
  assert.equal(text.includes(LEFT), false, text);
  assert.equal(text.includes(RIGHT), false, text);
});
