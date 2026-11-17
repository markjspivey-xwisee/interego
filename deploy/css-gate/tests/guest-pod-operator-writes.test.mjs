/**
 * css-gate: what the operator bearer may write into a guest's pod (server.mjs, "Operator-bearer
 * writes into a guest's pod").
 *
 * The operator bearer wrote any path of any pod, and every check on a guest's pod was on the
 * guest's own token. An application's bridge holds that bearer, so it could write into a guest's
 * pod after the guest's deadline and after identity had closed and purged it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

process.env.WRITE_SECRET = 'operator-fixture';
process.env.CSS_INTERNAL_URL = 'http://guest-storage.invalid';
process.env.CSS_HOST_HEADER = 'storage.example';
process.env.PUBLIC_BASE_URL = 'https://gate.example';
process.env.CSS_GATE_AUTOSTART = '0';
process.env.RELAY_VERIFY_URL = '';
process.env.IDENTITY_URL = '';
process.env.GUEST_POD_OPERATOR_WRITES = '3';
process.env.GUEST_POD_OPERATOR_BYTES = '1000';
process.env.GUEST_POD_OPERATOR_RESOURCE_BYTES = '600';

const { server, _setUpstreamPool } = await import('../server.mjs');

const guest = letter => `u-try-play-${letter.repeat(32)}`;
const general = letter => `u-try-guest-${letter.repeat(32)}`;
const hour = 3600;
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** An anchor as identity seals one (`ipa1_<claims>.<signature>`); the gate reads its claims and cannot check its signature. */
const anchor = (userId, expiresAt) => `ipa1_${Buffer.from(JSON.stringify({ version: 1, provisional: true, userId, expiresAt })).toString('base64url')}.${'s'.repeat(43)}`;
const empty = userId => ({ userId, walletAddresses: [], webAuthnCredentials: [], didKeys: [] });
const live = (userId, expiresAt = nowSeconds() + hour) => ({ ...empty(userId), provisionalPlayAnchor: anchor(userId, expiresAt) });
const tombstone = (userId, extra = {}) => ({ ...empty(userId), sessionEpoch: 2, deletedAt: '2026-11-17', ...extra });

/** Each pod's sign-in record as the store answers it: an object (200), a string (200, that body), a number (that status), or nothing (404). */
const records = new Map();
const requests = [];
const upstream = await listenLoopback(createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, bytes: body.length });
  const record = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(req.url);
  if (req.method === 'GET' && record) {
    const held = records.get(record[1]);
    if (held === undefined) { res.writeHead(404); res.end(); return; }
    if (typeof held === 'number') { res.writeHead(held); res.end('unavailable'); return; }
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(typeof held === 'string' ? held : JSON.stringify(held)); return;
  }
  res.writeHead(req.method === 'DELETE' ? 205 : 201); res.end('stored');
}));
const pool = new Pool(upstream.base, { connections: 4 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, pool);
const gate = await listenLoopback(server);
after(async () => { await gate.close(); await pool.close(); await upstream.close(); });

const operator = (method, path, { body = method === 'DELETE' ? undefined : '{"record":1}', headers = {} } = {}) =>
  fetch(gate.base + path, { method, headers: { Authorization: 'Bearer operator-fixture', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body });
/** The writes that reached the store since `from`, as `METHOD path`. */
const stored = from => requests.slice(from).filter(r => r.method !== 'GET').map(r => `${r.method} ${r.path}`);
const refusal = async response => { const text = await response.text(); try { return { status: response.status, error: JSON.parse(text).error }; } catch { return { status: response.status, error: text }; } };

test('a write into a live guest\'s pod goes through, with the bearer stripped, for a per-application guest and a general one', async () => {
  for (const pod of [guest('a'), general('a')]) {
    records.set(pod, live(pod));
    const from = requests.length;
    for (const [method, path] of [['PUT', `/${pod}/foxxi-lattice/workbench.json`], ['POST', `/${pod}/records/`], ['PATCH', `/${pod}/records/one.ttl`]]) {
      assert.equal((await operator(method, path)).status, 201, `${method} ${path}`);
    }
    assert.deepEqual(stored(from), [`PUT /${pod}/foxxi-lattice/workbench.json`, `POST /${pod}/records/`, `PATCH /${pod}/records/one.ttl`]);
    assert.ok(requests.slice(from).every(r => r.auth === undefined), 'the operator bearer never reaches the store');
    // The record is read from the store before each of them, never cached.
    assert.equal(requests.slice(from).filter(r => r.method === 'GET' && r.path === `/${pod}/auth-methods.jsonld`).length, 3);
  }
});

test('a write into a guest\'s pod whose account is closed is refused, from the write after the closure; DELETE still goes through', async () => {
  const pod = guest('b');
  records.set(pod, live(pod));
  assert.equal((await operator('PUT', `/${pod}/records/before.json`)).status, 201);
  // Identity closes the account: its tombstone, marked while the purge goes on, and unmarked after.
  for (const record of [tombstone(pod, { provisionalPlayPurgePending: true }), tombstone(pod)]) {
    records.set(pod, record);
    const from = requests.length;
    for (const [method, path] of [['PUT', `/${pod}/records/after.json`], ['POST', `/${pod}/records/`], ['PATCH', `/${pod}/records/before.json`], ['PUT', `/${pod}/`]]) {
      assert.deepEqual(await refusal(await operator(method, path)), { status: 410, error: 'guest_pod_closed' }, `${method} ${path}`);
    }
    assert.deepEqual(stored(from), [], 'nothing reaches the store');
    // What a closed pod still holds is removed with DELETE, as the operator's tooling does.
    assert.equal((await operator('DELETE', `/${pod}/records/before.json`)).status, 205);
    assert.deepEqual(stored(from), [`DELETE /${pod}/records/before.json`]);
    assert.equal(requests.slice(from).filter(r => r.method === 'GET').length, 4, 'a DELETE reads no record');
  }
});

test('an unclaimed guest past its deadline takes no more writes, closed yet or not; one that was claimed is an account like any other', async () => {
  const expired = guest('c');
  records.set(expired, live(expired, nowSeconds() - 1));
  let from = requests.length;
  assert.deepEqual(await refusal(await operator('PUT', `/${expired}/records/late.json`)), { status: 410, error: 'guest_pod_expired' });
  assert.deepEqual(stored(from), []);
  // A general guest linked to an account is still a guest with its own deadline (linking extends nothing).
  const linked = general('c');
  records.set(linked, { ...live(linked, nowSeconds() - 1), provisionalGuestLinkedTo: { userId: 'u-pk-0123456789ab', linkedAt: 1 } });
  assert.deepEqual(await refusal(await operator('PUT', `/${linked}/records/late.json`)), { status: 410, error: 'guest_pod_expired' });
  // Claimed: the record holds a credential, the deadline no longer ends anything, and no bound applies.
  for (const credential of [{ webAuthnCredentials: [{ id: 'passkey' }] }, { walletAddresses: ['0xabc'] }, { didKeys: [{ did: 'did:key:z6Mk' }] }]) {
    const claimed = guest('d');
    records.set(claimed, { ...live(claimed, nowSeconds() - 86_400), ...credential });
    from = requests.length;
    for (let i = 0; i < 5; i++) assert.equal((await operator('PUT', `/${claimed}/records/${i}.json`)).status, 201);
    assert.equal(stored(from).length, 5, 'more than GUEST_POD_OPERATOR_WRITES: a claimed pod has no such bound');
  }
});

test('a guest pod with no account behind it, or whose record cannot be read, takes no write', async () => {
  const cases = [
    ['no record', undefined, 409, 'guest_pod_not_open'],
    ['a record with no anchor', empty(guest('e')), 409, 'guest_pod_not_open'],
    ['an anchor that names another pod', { ...empty(guest('e')), provisionalPlayAnchor: anchor(guest('f'), nowSeconds() + hour) }, 409, 'guest_pod_not_open'],
    ['an anchor that is no anchor', { ...empty(guest('e')), provisionalPlayAnchor: 'ipa1_bm90IGpzb24.sig' }, 409, 'guest_pod_not_open'],
    ['a store that does not answer the read', 503, 503, 'guest_pod_state_unavailable'],
    ['a record that is not JSON', '<html>', 503, 'guest_pod_state_unavailable'],
    ['a record that is no object', '[]', 503, 'guest_pod_state_unavailable'],
  ];
  const pod = guest('e');
  for (const [name, record, status, error] of cases) {
    if (record === undefined) records.delete(pod); else records.set(pod, record);
    const from = requests.length;
    const response = await operator('PUT', `/${pod}/records/x.json`);
    assert.deepEqual(await refusal(response), { status, error }, name);
    if (status === 503) assert.equal(response.headers.get('retry-after'), '2', name);
    assert.deepEqual(stored(from), [], name);
  }
});

test('a guest pod\'s sign-in record and write budget are not written through the gate; another pod\'s are the operator\'s as before', async () => {
  const pod = guest('1');
  records.set(pod, live(pod));
  const from = requests.length;
  for (const [method, path, headers] of [['PUT', `/${pod}/auth-methods.jsonld`], ['PATCH', `/${pod}/AUTH-METHODS.jsonld`], ['PUT', `/${pod}/play-budget.json`],
    ['PUT', `/${pod}/auth-methods.jsonld.acl`], ['POST', `/${pod}/`, { Slug: 'auth-methods.jsonld' }]]) {
    assert.deepEqual(await refusal(await operator(method, path, { headers })), { status: 403, error: 'guest_pod_private_document' }, `${method} ${path}`);
  }
  assert.deepEqual(requests.slice(from), [], 'refused before anything is asked of the store');
  // Writing over a tombstone would re-open a closed guest: refused the same way.
  records.set(pod, tombstone(pod));
  assert.deepEqual(await refusal(await operator('PUT', `/${pod}/auth-methods.jsonld`)), { status: 403, error: 'guest_pod_private_document' });
  assert.equal((await operator('PUT', '/alice/auth-methods.jsonld')).status, 201);
});

test('a pod that is no guest\'s is written as before: no record is read, nothing is counted', async () => {
  const from = requests.length;
  for (const pod of ['alice', 'foxxi', 'u-pk-0123456789ab', 'u-try-play-short', `u-try-play-${'A'.repeat(32)}`, `x-u-try-play-${'a'.repeat(32)}`]) {
    for (let i = 0; i < 5; i++) assert.equal((await operator('PUT', `/${pod}/records/${i}.json`)).status, 201, pod);
    assert.equal((await operator('DELETE', `/${pod}/records/0.json`)).status, 205, pod);
  }
  assert.equal(requests.slice(from).filter(r => r.method === 'GET').length, 0, 'no sign-in record is read');
  assert.equal(stored(from).length, 36);
});

test('however the pod is spelled, it is the pod the store would write: an encoded separator does not hide a guest\'s', async () => {
  const pod = guest('2');
  records.set(pod, tombstone(pod));
  const from = requests.length;
  for (const path of [`/${pod}%2Frecords/x.json`, `/${pod}%5Crecords/x.json`, `/alice/../${pod}/records/x.json`, `/${pod}//records/x.json`]) {
    assert.deepEqual(await refusal(await operator('PUT', path)), { status: 410, error: 'guest_pod_closed' }, path);
  }
  assert.deepEqual(stored(from), []);
});

test('a live guest\'s pod takes a bounded number of operator writes and bytes, each of a bounded size; another guest\'s count is its own', async () => {
  const pod = guest('3');
  const other = guest('4');
  records.set(pod, live(pod));
  records.set(other, live(other));
  const from = requests.length;
  const sized = bytes => ({ body: 'x'.repeat(bytes) });
  // GUEST_POD_OPERATOR_RESOURCE_BYTES=600: one write over it is refused, and not counted.
  assert.deepEqual(await refusal(await operator('PUT', `/${pod}/records/big.json`, sized(601))), { status: 413, error: 'guest_pod_operator_resource_limit' });
  // GUEST_POD_OPERATOR_BYTES=1000: 600 + 300 fit, 200 more do not.
  assert.equal((await operator('PUT', `/${pod}/records/1.json`, sized(600))).status, 201);
  assert.equal((await operator('PUT', `/${pod}/records/2.json`, sized(300))).status, 201);
  assert.deepEqual(await refusal(await operator('PUT', `/${pod}/records/3.json`, sized(200))), { status: 507, error: 'guest_pod_operator_write_limit' });
  // GUEST_POD_OPERATOR_WRITES=3: one more small write fits, the next does not.
  assert.equal((await operator('POST', `/${pod}/records/`, sized(10))).status, 201);
  assert.deepEqual(await refusal(await operator('PATCH', `/${pod}/records/1.json`, sized(1))), { status: 507, error: 'guest_pod_operator_write_limit' });
  assert.deepEqual(stored(from), [`PUT /${pod}/records/1.json`, `PUT /${pod}/records/2.json`, `POST /${pod}/records/`]);
  // DELETE is not a write that fills a pod, and another guest starts from nothing.
  assert.equal((await operator('DELETE', `/${pod}/records/1.json`)).status, 205);
  assert.equal((await operator('PUT', `/${other}/records/1.json`, sized(10))).status, 201);
  // A guest that is kept (claimed) meanwhile is an account: the bound is gone.
  records.set(pod, { ...live(pod), webAuthnCredentials: [{ id: 'passkey' }] });
  assert.equal((await operator('PUT', `/${pod}/records/4.json`, sized(600))).status, 201);
});

test('the legacy evaluation ids have no deadline the gate can read: only their tombstone refuses a write', async () => {
  const pod = 'u-try-0123456789ab';
  records.delete(pod);
  assert.equal((await operator('PUT', `/${pod}/records/x.json`)).status, 201);
  records.set(pod, empty(pod));
  assert.equal((await operator('PUT', `/${pod}/records/x.json`)).status, 201);
  records.set(pod, tombstone(pod));
  assert.deepEqual(await refusal(await operator('PUT', `/${pod}/records/x.json`)), { status: 410, error: 'guest_pod_closed' });
  records.set(pod, 500);
  assert.deepEqual(await refusal(await operator('PUT', `/${pod}/records/x.json`)), { status: 503, error: 'guest_pod_state_unavailable' });
});

test('/healthz states the bound and that it is counted in this process', async () => {
  const health = await (await fetch(`${gate.base}/healthz`)).json();
  assert.deepEqual(health.guestPodOperatorWrites, { writes: 3, bytes: 1000, resourceBytes: 600, accounting: 'per-process' });
});

// ── Identity's own provisioning and cleanup do not come through this gate ────────────────────────
//
// The rule above refuses writes this gate sees. It can refuse none of identity's (the record it
// creates and closes, the purge's DELETEs) because identity sends them to the store itself, with
// no bearer: this gate answers a write without one 401, so identity could not be using it.

const repository = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('identity and the relay reach the store this gate fronts, not this gate, and identity sends the store no bearer', async () => {
  const services = JSON.parse(readFileSync(join(repository, 'deploy', 'railway', 'services.json'), 'utf8')).services;
  const env = name => services.find(s => s.name === name).env;
  const store = env('css-gate').CSS_INTERNAL_URL;
  assert.ok(store, 'the gate\'s upstream is stated');
  assert.equal(env('identity').CSS_URL, store, 'identity\'s CSS_URL is the store itself');
  assert.equal(env('relay').CSS_URL, store, 'and so is the relay\'s');
  // A write with no bearer is refused here, whatever the pod: identity's would be.
  const pod = guest('5');
  records.set(pod, live(pod));
  for (const method of ['PUT', 'DELETE']) assert.equal((await fetch(`${gate.base}/${pod}/auth-methods.jsonld`, { method, body: method === 'PUT' ? '{}' : undefined })).status, 401, method);
  // The cleanup's requests carry no Authorization header (deploy/identity/provisional-play-cleanup.ts).
  assert.doesNotMatch(readFileSync(join(repository, 'deploy', 'identity', 'provisional-play-cleanup.ts'), 'utf8'), /authorization/i);
});
