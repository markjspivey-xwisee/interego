import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

process.env.WRITE_SECRET = 'native-gate-fixture-authority';
process.env.CSS_INTERNAL_URL = 'http://native-storage.invalid';
process.env.PUBLIC_BASE_URL = 'https://native-gate.invalid';
process.env.CSS_HOST_HEADER = 'native-canonical.invalid';
process.env.CSS_GATE_AUTOSTART = '0';
process.env.RELAY_VERIFY_URL = '';
process.env.RELAY_INTROSPECTION_SECRET = '';

const identity = await listenLoopback(createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const valid = JSON.parse(body || '{}').token === 'alice-native-token';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid ? { valid: true, userId: 'alice', scope: 'pod:write' } : { valid: false }));
  });
}));
process.env.IDENTITY_URL = identity.base;
const { server, _setUpstreamPool } = await import('../server.mjs');
const received = [];
const revision = 'sha256:' + 'a'.repeat(64);
let mutate = value => value;
let responseType = 'application/json';
const upstream = await listenLoopback(createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    received.push({ method: req.method, path: req.url, authorization: req.headers.authorization,
      contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Accept-Put': 'application/vnd.interego.native-commit+json', 'Interego-Native-Commit': '1' });
      res.end();
      return;
    }
    if (req.method !== 'PUT') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ciphertext":"unchanged"}'); return; }
    const resource = 'http://native-canonical.invalid' + req.url;
    const receipt = mutate({ version: 1, status: 'committed', expectedRevision: null, resource, path: resource,
      pod: 'css', revision, bodyDigest: 'sha256:' + 'b'.repeat(64), contentType: 'application/json',
      updatedAt: 123456789, size: 7, topUri: 'urn:pgsl:atom:' + 'c'.repeat(40), opaqueUri: 'urn:pgsl:atom:' + 'c'.repeat(40) });
    res.writeHead(200, { 'Content-Type': responseType, ETag: '"' + revision + '-0123456789abcdef"' });
    res.end(JSON.stringify(receipt));
  });
}));
const pool = new Pool(upstream.base, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, pool);
const gate = await listenLoopback(server);
after(async () => { await gate.close(); await pool.close(); await upstream.close(); await identity.close(); });

const nativeHeaders = { Authorization: 'Bearer native-gate-fixture-authority', 'Content-Type': 'application/vnd.interego.native-commit+json', 'If-None-Match': '*' };

test('non-preflight OPTIONS discovers the real upstream; CORS preflight remains local', async () => {
  received.length = 0;
  const discovery = await fetch(gate.base + '/alice/head', { method: 'OPTIONS' });
  assert.equal(discovery.status, 204);
  assert.equal(discovery.headers.get('Interego-Native-Commit'), '1');
  assert.equal(discovery.headers.get('Accept-Put'), 'application/vnd.interego.native-commit+json');
  assert.equal(received.length, 1);
  const preflight = await fetch(gate.base + '/alice/head', { method: 'OPTIONS', headers: {
    Origin: 'https://dashboard.interego.xwisee.com', 'Access-Control-Request-Method': 'PUT',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(received.length, 1);
  assert.match(discovery.headers.get('Access-Control-Expose-Headers'), /Interego-Body-Digest/);
});

test('verified gate read credentials are stripped without bypassing private reads or replacing CSS authentication', async () => {
  for (const token of ['native-gate-fixture-authority', 'alice-native-token']) {
    received.length = 0;
    const result = await fetch(gate.base + '/alice/artifact.json', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '{"ciphertext":"unchanged"}');
    assert.equal(received[0].authorization, undefined);
  }
  received.length = 0;
  assert.equal((await fetch(gate.base + '/bob/artifact.json', { headers: { Authorization: 'Bearer alice-native-token' } })).status, 403);
  assert.equal(received.length, 0);
  assert.equal((await fetch(gate.base + '/alice/auth-methods.jsonld')).status, 401);
  assert.equal(received.length, 0, 'private-document reads still require genuine owner authority');
  assert.equal((await fetch(gate.base + '/alice/auth-methods.jsonld', { headers: { Authorization: 'Bearer invalid-token' } })).status, 401);
  assert.equal(received.length, 0);
  await fetch(gate.base + '/alice/artifact.json', { headers: { Authorization: 'Bearer css-oidc-token' } });
  assert.equal(received[0].authorization, 'Bearer css-oidc-token', 'unrecognized public-read credentials remain CSS authentication input, never stripped');
});

test('native PUT maps only its exact engine receipt and retains the physical engine identifier', async () => {
  mutate = value => value; responseType = 'application/json'; received.length = 0;
  const result = await fetch(gate.base + '/alice/head', { method: 'PUT', headers: nativeHeaders, body: '{"opaque":"command"}' });
  assert.equal(result.status, 200);
  const receipt = await result.json();
  assert.equal(receipt.resource, 'https://native-gate.invalid/alice/head');
  assert.equal(receipt.path, receipt.resource);
  assert.equal(receipt.storageResource, 'http://native-canonical.invalid/alice/head');
  assert.equal(receipt.storagePath, receipt.storageResource);
  assert.equal(receipt.revision, revision);
  assert.equal(receipt.bodyDigest, 'sha256:' + 'b'.repeat(64));
  assert.equal(received[0].authorization, undefined);
  assert.equal(received[0].body, '{"opaque":"command"}');
});

test('a successful receipt for a different resource, malformed revision or oversized receipt is refused', async () => {
  for (const change of [value => ({ ...value, resource: 'http://native-canonical.invalid/bob/head' }),
    value => ({ ...value, revision: 'sha256:bad' }), value => ({ ...value, expectedRevision: 'sha256:' + 'd'.repeat(64) }),
    value => ({ ...value, extra: 'x'.repeat(33_000) })]) {
    mutate = change;
    const result = await fetch(gate.base + '/alice/head', { method: 'PUT', headers: nativeHeaders, body: '{}' });
    assert.equal(result.status, 502);
    assert.deepEqual(await result.json(), { error: 'native commit receipt did not bind the forwarded resource' });
  }
  mutate = value => value;
});

test('ordinary JSON application bodies are byte-transparent even if they look like receipts', async () => {
  mutate = value => value; responseType = 'application/json';
  const result = await fetch(gate.base + '/alice/head', { method: 'PUT',
    headers: { Authorization: nativeHeaders.Authorization, 'Content-Type': 'application/json' }, body: '{"application":"bytes"}' });
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.resource, 'http://native-canonical.invalid/alice/head');
  assert.equal(body.storageResource, undefined);
});

test('native MIME never bypasses anonymous write refusal', async () => {
  received.length = 0;
  const result = await fetch(gate.base + '/alice/head', { method: 'PUT', headers: { 'Content-Type': nativeHeaders['Content-Type'] }, body: '{}' });
  assert.equal(result.status, 401);
  assert.equal(received.length, 0);
});
