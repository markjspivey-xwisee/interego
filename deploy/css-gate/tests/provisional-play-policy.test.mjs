import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { provisionalLimits, verifiedProvisional, provisionalCheckpointPaths, checkProvisionalTarget,
  readProvisionalCommit, reserveProvisionalWrite, createProvisionalWriteLimiter } from '../provisional-play.mjs';

const userId = 'u-try-play-' + 'a'.repeat(32);
const ownerDid = `did:web:identity.example:users:${userId}`;
const data = () => ({ userId, ownerDid, provisionalPlay: { audience: 'https://game.example',
  proofKeyThumbprint: 'x'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 3600 } });
const claims = () => verifiedProvisional(data());
const limits = provisionalLimits({});
const initial = { 'content-type': 'application/vnd.interego.native-commit+json', 'if-none-match': '*' };
const revision = 'sha256:' + 'a'.repeat(64);
const envelope = { version: 1, algorithm: 'X25519-XSalsa20-Poly1305',
  content: { algorithm: 'XSalsa20-Poly1305', ciphertext: 'opaque' }, wrappedKeys: [{}] };
const command = (body = envelope, expectedRevision = null) => Buffer.from(JSON.stringify({ version: 1, expectedRevision,
  contentType: 'application/json', bodyBase64: Buffer.from(JSON.stringify(body)).toString('base64') }));

test('guest bounds are hard, malformed/expired verifier markers never downgrade into canonical ownership', () => {
  assert.deepEqual(limits, { lifetimeBytes: 33554432, lifetimeWrites: 1024, resourceBytes: 4194304, resources: 2 });
  assert.throws(() => provisionalLimits({ PROVISIONAL_PLAY_STORAGE_BYTES: 1024 ** 4 }));
  assert.equal(verifiedProvisional({ userId: 'canonical' }), undefined);
  for (const mutate of [x => { x.provisionalPlay = null; }, x => { x.ownerDid = 'did:web:other:users:someone'; },
    x => { x.provisionalPlay.expiresAt = Math.floor(Date.now() / 1000); },
    x => { x.provisionalPlay.expiresAt += 8 * 86400; }, x => { x.provisionalPlay.audience += '/path'; },
    x => { x.provisionalPlay.proofKeyThumbprint = ''; }]) {
    const value = data(); mutate(value);
    assert.throws(() => verifiedProvisional(value), error => error.status === 401);
  }
});

test('only two owner-derived checkpoint paths accept exact conditional native PUTs', () => {
  const guest = claims(); const paths = provisionalCheckpointPaths(guest);
  assert.equal(paths.length, 2);
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(paths[0], `/${userId}/hallowmarch/checkpoints/${hash('urn:graph:hallowmarch:player-profile:' + hash(ownerDid))}.json`);
  assert.equal(checkProvisionalTarget(guest, 'PUT', new URL(paths[0], 'https://gate.example'), initial), null);
  assert.equal(checkProvisionalTarget(guest, 'PUT', new URL(paths[0], 'https://gate.example'),
    { ...initial, 'if-none-match': undefined, 'if-match': `"${revision}-0123456789abcdef"` }), revision);
  for (const [method, path, headers, status] of [
    ['DELETE', paths[0], initial, 403], ['PATCH', paths[0], initial, 403], ['POST', `/${userId}/`, initial, 403],
    ['PUT', `/${userId}/anything.json`, initial, 403], ['PUT', paths[0] + '?variant=1', initial, 403],
    ['PUT', paths[0], { ...initial, 'content-type': 'application/json' }, 415],
    ['PUT', paths[0], { ...initial, 'content-encoding': 'gzip' }, 415],
    ['PUT', paths[0], { 'content-type': initial['content-type'] }, 428],
    ['PUT', paths[0], { ...initial, 'if-match': `"${revision}"` }, 428],
  ]) assert.throws(() => checkProvisionalTarget(guest, method, new URL(path, 'https://gate.example'), headers), error => error.status === status);
});

test('decoded ciphertext body, native command revision and owner envelope are bounded before forwarding', async () => {
  const exact = command();
  assert.deepEqual(await readProvisionalCommit(Readable.from([exact]), null, limits),
    { body: exact, bytes: Buffer.byteLength(JSON.stringify(envelope)) });
  await assert.rejects(readProvisionalCommit(Readable.from([exact]), revision, limits), error => error.status === 400);
  const surplus = JSON.parse(exact); surplus.unrelated = 'metadata';
  await assert.rejects(readProvisionalCommit(Readable.from([Buffer.from(JSON.stringify(surplus))]), null, limits), error => error.status === 400);
  await assert.rejects(readProvisionalCommit(Readable.from([command({ plaintext: 'save' })]), null, limits), error => error.code === 'provisional_play_encrypted_required');
  await assert.rejects(readProvisionalCommit(Readable.from([command({ ...envelope, wrappedKeys: [{}, {}] })]), null, limits), error => error.status === 400);
  await assert.rejects(readProvisionalCommit(Readable.from([exact]), null, { ...limits, resourceBytes: 16 }), error => error.status === 413);
});

test('buffer admission bounds total memory and keeps one native write in flight per guest', () => {
  const acquire = createProvisionalWriteLimiter();
  const release = acquire('guest0');
  assert.throws(() => acquire('guest0'), error => error.status === 429);
  const rest = Array.from({ length: 7 }, (_, index) => acquire('guest' + (index + 1)));
  assert.throws(() => acquire('guest8'), error => error.status === 429);
  release();
  const sameOwner = acquire('guest0');
  release();
  assert.throws(() => acquire('guest0'), error => error.status === 429, 'a late close cannot release a newer request');
  sameOwner();
  const replacement = acquire('guest8'); replacement();
  rest.forEach(done => done());
  acquire('guest0')();
});

function memoryStorage() {
  const rows = new Map(); let generation = 0;
  return { rows, read: async path => structuredClone(rows.get(path) ?? null),
    compareAndSet: async (path, expected, value) => {
      const current = rows.get(path);
      if ((current?.revision ?? null) !== expected) return false;
      rows.set(path, { revision: 'sha256:' + (++generation).toString(16).padStart(64, '0'), value: structuredClone(value) });
      return true;
    } };
}

test('durable lifetime ledger bounds concurrent writes across new instances, tokens and failed retries', async () => {
  const storage = memoryStorage(); const guest = claims();
  const small = { ...limits, lifetimeBytes: 12, lifetimeWrites: 3 };
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => reserveProvisionalWrite(guest, 4, small, storage)));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 3);
  assert.equal(outcomes.filter(x => x.status === 'rejected' && x.reason.status === 507).length, 5);
  const saved = [...storage.rows.values()][0].value;
  assert.equal(saved.bytes, 12); assert.equal(saved.writes, 3);
  await assert.rejects(reserveProvisionalWrite({ ...guest }, 1, small, { read: storage.read, compareAndSet: storage.compareAndSet }),
    error => error.status === 507 && error.remaining.bytesRemaining === 0 && error.remaining.writesRemaining === 0);
});

test('budget marker changes, corrupt records, contention and unavailable storage fail closed', async () => {
  const storage = memoryStorage(); const guest = claims();
  await reserveProvisionalWrite(guest, 1, limits, storage);
  await assert.rejects(reserveProvisionalWrite({ ...guest, expiresAt: guest.expiresAt + 1 }, 1, limits, storage), error => error.status === 503);
  const row = [...storage.rows.values()][0]; row.value.bytes = -1;
  await assert.rejects(reserveProvisionalWrite(guest, 1, limits, storage), error => error.status === 503);
  await assert.rejects(reserveProvisionalWrite(guest, 1, limits, { read: async () => null, compareAndSet: async () => false }),
    error => error.code === 'provisional_play_budget_busy');
  await assert.rejects(reserveProvisionalWrite(guest, 1, limits, { read: async () => { throw new Error('storage offline'); } }), /storage offline/);
});
