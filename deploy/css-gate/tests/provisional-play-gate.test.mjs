import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';
import { provisionalCheckpointPaths } from '../provisional-play.mjs';

const userId = 'u-try-play-' + 'a'.repeat(32);
const ownerDid = `did:web:identity.example:users:${userId}`;
const deadline = Math.floor(Date.now() / 1000) + 3600;
const marker = { audience: 'https://game.example', proofKeyThumbprint: 'a'.repeat(43), expiresAt: deadline };
process.env.WRITE_SECRET = 'operator-fixture';
process.env.CSS_INTERNAL_URL = 'http://play-storage.invalid';
process.env.CSS_HOST_HEADER = 'storage.example';
process.env.PUBLIC_BASE_URL = 'https://gate.example';
process.env.CSS_GATE_AUTOSTART = '0';
process.env.PROVISIONAL_PLAY_STORAGE_WRITES = '3';
process.env.RELAY_VERIFY_URL = '';

const identity = await listenLoopback(createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const token = JSON.parse(body).token;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(token === 'guest-token' ? { valid: true, userId, ownerDid, provisionalPlay: marker }
    : token === 'canonical-token' ? { valid: true, userId: 'canonical' }
      : token === 'bad-marker' ? { valid: true, userId, ownerDid, provisionalPlay: null } : { valid: false }));
}));
process.env.IDENTITY_URL = identity.base;

const { server, _setUpstreamPool } = await import('../server.mjs');
const stored = new Map();
const forwarded = [];
let budgetUnavailable = false;
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
let generation = 0;
const upstream = await listenLoopback(createServer(async (req, res) => {
  const path = req.url;
  const budget = path.endsWith('/play-budget.json');
  if (!budget) forwarded.push({ path, method: req.method, auth: req.headers.authorization });
  if (budget && budgetUnavailable) { res.writeHead(503); res.end('unavailable'); return; }
  const previous = stored.get(path);
  if (req.method === 'GET') {
    res.writeHead(previous ? 200 : 404, previous ? { 'Content-Type': 'application/json', ETag: `"${previous.revision}"`,
      'Interego-Revision': previous.revision, 'Interego-Body-Digest': hash(previous.body) } : {});
    res.end(previous?.body ?? ''); return;
  }
  let wrapper = ''; for await (const chunk of req) wrapper += chunk;
  if (req.method !== 'PUT' || req.headers['content-type'] !== 'application/vnd.interego.native-commit+json') {
    res.writeHead(201); res.end('canonical passthrough'); return;
  }
  const command = JSON.parse(wrapper);
  if ((previous?.revision ?? null) !== command.expectedRevision) { res.writeHead(412); res.end('conflict'); return; }
  const body = Buffer.from(command.bodyBase64, 'base64');
  const revision = hash(Buffer.concat([Buffer.from(String(++generation)), body]));
  stored.set(path, { body, revision });
  const resource = 'http://storage.example' + path;
  const receipt = { version: 1, status: 'committed', expectedRevision: command.expectedRevision, resource, path: resource,
    pod: 'fixture', revision, bodyDigest: hash(body), contentType: 'application/json', updatedAt: Date.now(), size: body.length,
    topUri: 'urn:pgsl:atom:' + 'a'.repeat(40), opaqueUri: 'urn:pgsl:atom:' + 'b'.repeat(40) };
  res.writeHead(201, { 'Content-Type': 'application/json', ETag: `"${revision}"` }); res.end(JSON.stringify(receipt));
}));
const pool = new Pool(upstream.base, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, pool);
const gate = await listenLoopback(server);
after(async () => { await gate.close(); await pool.close(); await upstream.close(); await identity.close(); });

const path = provisionalCheckpointPaths({ userId, ownerDid })[0];
const encrypted = Buffer.from(JSON.stringify({ version: 1, algorithm: 'X25519-XSalsa20-Poly1305',
  content: { algorithm: 'XSalsa20-Poly1305', ciphertext: 'opaque' }, wrappedKeys: [{}] }));
const makeCommand = expectedRevision => JSON.stringify({ version: 1, expectedRevision, contentType: 'application/json', bodyBase64: encrypted.toString('base64') });
const send = (target = path, extra = {}) => fetch(gate.base + target, { method: 'PUT', headers: {
  Authorization: 'Bearer guest-token', 'Content-Type': 'application/vnd.interego.native-commit+json', 'If-None-Match': '*', ...extra }, body: makeCommand(null) });

test('guest arbitrary/metadata writes, bad markers and nonconditional saves never reach upstream', async () => {
  forwarded.length = 0;
  assert.equal((await send(`/${userId}/junk.json`)).status, 403);
  assert.equal((await send(`/${userId}/play-budget.json`)).status, 403);
  assert.equal((await send(path, { Authorization: 'Bearer bad-marker' })).status, 401);
  assert.equal((await send(path, { 'If-None-Match': '' })).status, 428);
  assert.equal(forwarded.length, 0);
  assert.equal(stored.size, 0);
  assert.equal((await fetch(gate.base + `/${userId}/play-budget.json`)).status, 401);
});

test('budget outage preserves prior checkpoint and canonical ownership remains ordinary', async () => {
  budgetUnavailable = true; forwarded.length = 0;
  assert.equal((await send()).status, 503);
  assert.equal(forwarded.length, 0);
  budgetUnavailable = false;
  const canonical = await fetch(gate.base + '/canonical/normal.ttl', { method: 'PUT',
    headers: { Authorization: 'Bearer canonical-token', 'Content-Type': 'text/turtle' }, body: '<a> <b> <c>.' });
  assert.equal(canonical.status, 201);
  assert.equal(forwarded.at(-1).auth, undefined);
});

test('native saves charge durable ledger before forwarding, conflicts count, exhaustion preserves saved bytes', async () => {
  let response = await send();
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Interego-Provisional-Writes-Remaining'), '2');
  assert.equal(Number(response.headers.get('Interego-Provisional-Bytes-Remaining')), 33554432 - encrypted.length);
  assert.equal(response.headers.get('Interego-Provisional-Expires-At'), String(deadline));
  assert.match(response.headers.get('Access-Control-Expose-Headers'), /Interego-Provisional-Bytes-Remaining/);
  const receipt = await response.json();
  assert.equal(receipt.resource, 'https://gate.example' + path);
  assert.deepEqual(stored.get(path).body, encrypted);
  response = await send();
  assert.equal(response.status, 412, 'uncertain retry conflict still consumes its reservation');
  assert.equal(response.headers.get('Interego-Provisional-Writes-Remaining'), '1');
  response = await fetch(gate.base + path, { method: 'PUT', headers: { Authorization: 'Bearer guest-token',
    'Content-Type': 'application/vnd.interego.native-commit+json', 'If-Match': `"${receipt.revision}"` }, body: makeCommand(receipt.revision) });
  assert.equal(response.status, 201);
  const confirmed = stored.get(path).revision;
  const before = forwarded.length;
  response = await send();
  assert.equal(response.status, 507);
  assert.equal(response.headers.get('Interego-Play-Budget-Exhausted'), '1');
  assert.equal((await response.json()).error, 'provisional_play_storage_limit');
  assert.equal(forwarded.length, before, 'exhaustion never writes the personal resource');
  assert.equal(stored.get(path).revision, confirmed);
  const budget = JSON.parse(stored.get(`/${userId}/play-budget.json`).body);
  assert.equal(budget.writes, 3);
  assert.equal(budget.bytes, encrypted.length * 3);
});
