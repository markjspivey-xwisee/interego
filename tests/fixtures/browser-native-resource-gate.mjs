// Mandatory loopback contract proof: real gate and native LdpStore engine. The
// isolated InMemoryFdb is only this transactional-engine test's backing store.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { webcrypto } from 'node:crypto';
import { Pool } from 'undici';
import { listenLoopback } from '../../deploy/css-gate/tests/loopback.mjs';
import { openStore, InMemoryFdb, CodecRegistry, LdpStore } from '../../packages/pgsl-store/dist/index.js';
import { createNativeResourceClient } from '../../packages/pgsl/dist/browser-native-resource.js';

process.env.WRITE_SECRET = 'isolated-gate-fixture';
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
    const valid = JSON.parse(body || '{}').token === 'owner-oauth';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid ? { valid: true, userId: 'alice', scope: 'pod:write' } : { valid: false }));
  });
}));
process.env.IDENTITY_URL = identity.base;
const ldp = new LdpStore(openStore(new InMemoryFdb()), new CodecRegistry());
const upstream = await listenLoopback(createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => { void (async () => {
    // The gate must consume owner OAuth instead of leaking it into CSS.
    if (req.method !== 'OPTIONS') assert.equal(req.headers.authorization, undefined);
    const resource = 'http://native-canonical.invalid' + req.url;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Interego-Native-Commit': '1', 'Accept-Put': 'application/vnd.interego.native-commit+json' });
      res.end(); return;
    }
    if (req.method === 'PUT') {
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(req.headers['content-type'], 'application/vnd.interego.native-commit+json');
      if (command.expectedRevision === null) assert.equal(req.headers['if-none-match'], '*');
      else assert.equal(req.headers['if-match'], '"' + command.expectedRevision + '"');
      const result = await ldp.commitResource('css', resource, new Uint8Array(Buffer.from(command.bodyBase64, 'base64')),
        command.contentType, { expectedRevision: command.expectedRevision });
      if (result.status === 'conflict') { res.writeHead(412); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"' + result.revision + '-0123456789abcdef"' });
      res.end(JSON.stringify({ ...result, version: 1, resource, expectedRevision: command.expectedRevision })); return;
    }
    const result = await ldp.readResource('css', resource);
    if (!result) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': result.contentType, ETag: '"' + result.revision + '-0123456789abcdef"',
      'Interego-Revision': result.revision, 'Interego-Body-Digest': result.bodyDigest });
    res.end(result.bytes);
  })().catch(error => { res.writeHead(500); res.end(String(error)); }); });
}));
const { server, _setUpstreamPool } = await import('../../deploy/css-gate/server.mjs');
const pool = new Pool(upstream.base, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, pool);
const gate = await listenLoopback(server);
try {
  const publicBase = process.env.PUBLIC_BASE_URL;
  let token = 'owner-oauth';
  const authorizedFetch = async (url, init) => {
    assert.equal(new URL(url).origin, publicBase);
    const headers = new Headers(init?.headers); headers.set('Authorization', 'Bearer ' + token);
    if (init?.method !== 'OPTIONS') {
      const preflight = await fetch(gate.base + new URL(url).pathname, { method: 'OPTIONS', headers: {
        Origin: 'https://game.example', 'Access-Control-Request-Method': init?.method ?? 'GET',
        'Access-Control-Request-Headers': [...headers.keys()].join(','),
      } });
      const allowed = preflight.headers.get('Access-Control-Allow-Headers').toLowerCase().split(',').map(value => value.trim());
      for (const name of headers.keys()) assert.ok(allowed.includes(name), 'browser CORS must allow authored header ' + name);
    }
    const response = await fetch(gate.base + new URL(url).pathname, { ...init, headers });
    // Routing seam for the isolated test's public hostname. The actual gate maps
    // its engine receipt to this public URL; no production helper URL is rewritten.
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  const url = publicBase + '/alice/character/head';
  const client = createNativeResourceClient({ resourceUrl: url, podUrl: publicBase + '/alice/', fetch: authorizedFetch,
    maxBytes: 1024, crypto: webcrypto });
  await client.ready();
  const discovery = await authorizedFetch(url, { method: 'OPTIONS' });
  assert.match(discovery.headers.get('Access-Control-Expose-Headers'), /Interego-Revision/);
  assert.match(discovery.headers.get('Access-Control-Expose-Headers'), /Interego-Body-Digest/);
  const preflight = await fetch(gate.base + '/alice/character/head', { method: 'OPTIONS', headers: {
    Origin: 'https://game.example', 'Access-Control-Request-Method': 'PUT',
    'Access-Control-Request-Headers': 'authorization,content-type,if-match',
  } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /If-Match/);
  const first = await client.write({ expectedRevision: null, body: new TextEncoder().encode('{"sealed":"one"}'), contentType: 'application/json' });
  assert.equal(first.receipt.resource, url);
  assert.equal(first.receipt.storageResource, 'http://native-canonical.invalid/alice/character/head');
  await assert.rejects(client.write({ expectedRevision: null, body: new Uint8Array([1]), contentType: 'application/octet-stream' }),
    { code: 'CONFLICT', writeMayHaveCommitted: false });
  const second = await client.write({ expectedRevision: first.receipt.revision, body: new TextEncoder().encode('{"sealed":"two"}'), contentType: 'application/json' });
  assert.notEqual(first.receipt.revision, second.receipt.revision);
  const foreign = createNativeResourceClient({ resourceUrl: publicBase + '/bob/character/head', podUrl: publicBase + '/bob/',
    fetch: authorizedFetch, maxBytes: 1024, crypto: webcrypto });
  await assert.rejects(foreign.read(), { code: 'HTTP', status: 403 });
  token = 'invalid-current-token';
  await assert.rejects(client.write({ expectedRevision: second.receipt.revision, body: new Uint8Array([1]), contentType: 'application/octet-stream' }),
    { code: 'HTTP', status: 401 });
  process.stdout.write(JSON.stringify({ ok: true, ownerOnly: true, cors: true, cas: true }) + '\n');
} finally {
  await gate.close(); await pool.close(); await upstream.close(); await identity.close();
}
