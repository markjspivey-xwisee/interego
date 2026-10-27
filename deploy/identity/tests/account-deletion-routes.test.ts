/**
 * Deleting an account (POST /users/me/delete), through the routes: server.ts is started as a
 * child process against a stand-in pod server (no live pod).
 *
 * Deletion cannot empty the pod: its container and other files stay, and a derived account id
 * (u-pk-/u-eth-/u-did-) is a function of a credential, so re-creating it would hand them, and
 * its did:web name, to whoever presents an old credential (a passkey id is not secret), and a
 * fresh document at session epoch 0 would make the deleted account's tokens verify again. So
 * deletion leaves a tombstone at auth-methods.jsonld, which every first sign-in reads: an old
 * passkey id, wallet or DID is refused, old tokens are refused (after a restart too), a new
 * credential opens a new account as before, and a pod that cannot be read refuses (503), it
 * never re-opens.
 *
 * Run:
 *   node --test --import tsx tests/account-deletion-routes.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { deriveUserIdFromCredentialId, deriveUserIdFromDid, deriveUserIdFromWallet } from '../derive-userid.js';
import { closeServer, stopChild } from './teardown.js';
import { publicJwk } from './public-jwk.js';

// ── A software authenticator ('none' attestation; see passkey-register-routes.test.ts) ──
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: unsupported ${typeof v}`);
}

function softPasskey(rawId: Buffer = crypto.randomBytes(16)) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicJwk(publicKey);
  const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const id = rawId.toString('base64url');
  return { id, rawId, cose, privateKey, userId: deriveUserIdFromCredentialId(id) };
}
type SoftPasskey = ReturnType<typeof softPasskey>;

function attest(key: SoftPasskey, challenge: string, origin: string, rpId: string) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(key.rawId.length);
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
    len, key.rawId, key.cose,
  ]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
  const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
  return {
    id: key.id, rawId: key.id, type: 'public-key', clientExtensionResults: {},
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      attestationObject: attestationObject.toString('base64url'),
      transports: ['internal'],
    },
  };
}

function didKey() {
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const bytes = Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.from(publicJwk(publicKey).x!, 'base64url')]);
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return { did: `did:key:z${out}`, privateKey };
}

const invite = { userId: 'seeded-alias', token: crypto.randomBytes(16).toString('hex') };
const tokenSigningKey = crypto.randomBytes(32).toString('base64');

// ── Pods: every pod is in the root listing, so a restart loads what is on file ──
const pods = new Map<string, Record<string, unknown>>();
const blipping = new Set<string>();   // GET answers 502
const failingPuts = new Set<string>(); // PUT answers 500
const writes: Array<{ userId: string; method: string }> = [];
const unlisted = new Set<string>(); // left out of the root listing, so a restart does not load it
// One GET of an account's record, answered with the record as it was when the GET arrived, but
// only once the test releases it: a read that starts before a deletion and finishes after it.
let heldGet: { userId: string; received: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;

// One staged race at a time, on one account: the deletion's read of the record is held until a
// write of the account's old (credentialed) record arrives, and that write is held until the
// tombstone has landed, so the old record is put after the tombstone unless the server orders
// them itself. Each hold gives up after a while, so a writer the server serialises behind the
// deletion is not waited for for ever.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
// The give-up timer is cleared once `p` settles: left pending, a 10s hold kept this file's
// process alive for 10s after its last test, as every CI run of the suite showed.
async function within(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([p, new Promise<void>(r => { timer = setTimeout(r, ms); })]); } finally { clearTimeout(timer); }
}
const RACE_HOLD_MS = 1500;
let race: { userId: string; readHeld: boolean; deletionRead: ReturnType<typeof deferred>;
  staleWrite: ReturnType<typeof deferred>; tombstone: ReturnType<typeof deferred> } | null = null;

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    const listed = [...pods.keys()].filter(p => !unlisted.has(p));
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${listed.map(p => `<${p}/>`).join(', ') || '<>'} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m) {
    const userId = m[1]!;
    if (req.method === 'GET') {
      if (blipping.has(userId)) { res.writeHead(502).end(); return; }
      if (heldGet && heldGet.userId === userId) {
        const held = heldGet;
        heldGet = null;
        const snapshot = pods.get(userId);
        held.received.resolve();
        void within(held.release.promise, 10_000).then(() => {
          if (!snapshot) { res.writeHead(404).end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/ld+json' });
          res.end(JSON.stringify(snapshot));
        });
        return;
      }
      if (race && race.userId === userId && !race.readHeld) {
        const held = race;
        held.readHeld = true;
        held.deletionRead.resolve();
        void within(held.staleWrite.promise, RACE_HOLD_MS).then(() => {
          const doc = pods.get(userId);
          if (!doc) { res.writeHead(404).end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/ld+json' });
          res.end(JSON.stringify(doc));
        });
        return;
      }
      const doc = pods.get(userId);
      if (!doc) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/ld+json' });
      res.end(JSON.stringify(doc));
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', d => { body += String(d); });
      req.on('end', async () => {
        if (failingPuts.has(userId)) { res.writeHead(500).end(); return; }
        if (req.headers['if-none-match'] === '*' && pods.has(userId)) { res.writeHead(412).end(); return; }
        const doc = JSON.parse(body) as Record<string, unknown>;
        const held = race && race.userId === userId ? race : null;
        if (held && doc['deletedAt'] === undefined) {
          held.staleWrite.resolve();
          await within(held.tombstone.promise, RACE_HOLD_MS);
        }
        writes.push({ userId, method: 'PUT' });
        pods.set(userId, doc);
        res.writeHead(201).end();
        if (held && doc['deletedAt'] !== undefined) held.tombstone.resolve();
      });
      return;
    }
    if (req.method === 'DELETE') {
      writes.push({ userId, method: 'DELETE' });
      pods.delete(userId);
      res.writeHead(205).end();
      return;
    }
  }
  if (req.method === 'PUT' || req.method === 'DELETE') { res.writeHead(205).end(); return; }
  res.writeHead(404).end();
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}

let podServer: http.Server;
let podPort = 0;
let identity: ChildProcess;
let base = '';
let output = '';
// Each test signs in from its own address, so the per-IP sign-in limits never run out.
let clientIp = '';

async function startIdentity(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS',
    'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_ORIGIN', 'WEBAUTHN_RP_ORIGINS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: tokenSigningKey, JANITOR_INTERVAL_MS: '0', BOOTSTRAP_INVITES: `${invite.userId}:${invite.token}`,
  });
  identity = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  identity.stdout!.on('data', d => { output += String(d); });
  identity.stderr!.on('data', d => { output += String(d); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (identity.exitCode !== null) throw new Error(`identity server exited ${identity.exitCode}:\n${output}`);
    try {
      const health = await (await fetch(`${base}/health`)).json() as { accountIndex: { complete: boolean } };
      if (health.accountIndex.complete) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function stopIdentity(): Promise<void> {
  await stopChild(identity);
}

async function call(method: string, path: string, body?: unknown, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': clientIp, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}
const post = (path: string, body: unknown, bearer?: string) => call('POST', path, body, bearer);
const me = (bearer: string) => call('GET', '/auth-methods/me', undefined, bearer);
const deleteAccount = (bearer: string) => post('/users/me/delete', {}, bearer);

async function register(key: SoftPasskey, extra: Record<string, unknown> = {}) {
  const options = await post('/auth/webauthn/register-options', { name: 'Someone', ...extra });
  if (options.status !== 200) return options;
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), base, rpId) });
}

async function siwe(w: { address: string; signMessage(message: string): Promise<string> }) {
  const { nonce } = (await post('/challenges', { purpose: 'siwe' })).json as { nonce: string };
  const message = `${new URL(base).host} wants you to sign in with your Ethereum account:\n${w.address}\n\nSign in.\n\n`
    + `URI: ${base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'Someone' });
}

async function didSignIn(k: { did: string; privateKey: crypto.KeyObject }, extra: Record<string, unknown> = {}) {
  const { nonce, message } = (await post('/challenges', { purpose: 'did-sig' })).json as { nonce: string; message?: unknown };
  // As every DID client signs: the challenge's `message` when the server returns one, else the nonce.
  const signed = typeof message === 'string' ? message : nonce;
  const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), k.privateKey).toString('base64url');
  return post('/auth/did', { did: k.did, nonce, signature, name: 'Someone', ...extra });
}

const writesTo = (userId: string) => writes.filter(w => w.userId === userId).length;
const settle = () => new Promise(resolve => setTimeout(resolve, 300)); // time for a deferred write to land

/** The tombstone holds the id, the day and an epoch, and nothing that names or signs in anyone. */
function assertTombstone(userId: string, epoch: number): void {
  const doc = pods.get(userId)!;
  assert.ok(doc, `no document for ${userId}`);
  assert.deepEqual(Object.keys(doc).sort(),
    ['@context', '@id', '@type', 'deletedAt', 'didKeys', 'name', 'sessionEpoch', 'userId', 'walletAddresses', 'webAuthnCredentials']);
  assert.equal(doc['userId'], userId);
  assert.equal(doc['name'], userId);
  assert.match(String(doc['deletedAt']), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(doc['sessionEpoch'], epoch);
  for (const k of ['walletAddresses', 'webAuthnCredentials', 'didKeys']) assert.deepEqual(doc[k], [], k);
}

/** A sign-in with an old credential of a deleted account: 409, no token, nothing written. */
async function assertDeletedRefusal(userId: string, attempt: () => Promise<{ status: number; json: Record<string, unknown> }>): Promise<void> {
  const before = writesTo(userId);
  const doc = JSON.stringify(pods.get(userId));
  const r = await attempt();
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}\n${output}`);
  assert.match(String(r.json['error']), /account was deleted/);
  assert.equal(r.json['token'], undefined);
  await settle();
  assert.equal(writesTo(userId), before);
  assert.equal(JSON.stringify(pods.get(userId)), doc);
}

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  podPort = (podServer.address() as net.AddressInfo).port;
  await startIdentity();
});

after(async () => {
  await stopIdentity();
  await closeServer(podServer);
});

const deletedPasskey = softPasskey();
let deletedPasskeyToken = '';
test('a deleted passkey account leaves a tombstone, and its credential id cannot open it again', async () => {
  clientIp = '198.51.100.1';
  const { userId } = deletedPasskey;
  const created = await register(deletedPasskey);
  assert.equal(created.status, 200, `${JSON.stringify(created.json)}\n${output}`);
  assert.equal(created.json['userId'], userId);
  deletedPasskeyToken = String(created.json['token']);
  assert.equal((await me(deletedPasskeyToken)).status, 200);

  const deleted = await deleteAccount(deletedPasskeyToken);
  assert.equal(deleted.status, 200, `${JSON.stringify(deleted.json)}\n${output}`);
  assert.equal(deleted.json['deleted'], true);
  assertTombstone(userId, 1);

  const old = await me(deletedPasskeyToken);
  assert.equal(old.status, 401, JSON.stringify(old.json));
  // The same credential id, from any authenticator (here with a key of its own), is refused.
  await assertDeletedRefusal(userId, () => register(deletedPasskey));
  await assertDeletedRefusal(userId, () => register(softPasskey(deletedPasskey.rawId)));
});

test('a deleted wallet account cannot be opened again by the wallet, and its token is refused', async () => {
  clientIp = '198.51.100.2';
  const wallet = Wallet.createRandom();
  const userId = deriveUserIdFromWallet(wallet.address.toLowerCase());
  const created = await siwe(wallet);
  assert.equal(created.status, 200, `${JSON.stringify(created.json)}\n${output}`);
  assert.equal(created.json['userId'], userId);
  const token = String(created.json['token']);
  assert.equal((await deleteAccount(token)).status, 200);
  assertTombstone(userId, 1);
  assert.equal((await me(token)).status, 401);
  await assertDeletedRefusal(userId, () => siwe(wallet));
});

test('a deleted did:key account cannot be opened again by the DID, and its token is refused', async () => {
  clientIp = '198.51.100.3';
  const key = didKey();
  const userId = deriveUserIdFromDid(key.did);
  const created = await didSignIn(key);
  assert.equal(created.status, 200, `${JSON.stringify(created.json)}\n${output}`);
  assert.equal(created.json['userId'], userId);
  const token = String(created.json['token']);
  // A signed-out-everywhere account keeps counting: the tombstone's epoch is above it.
  assert.equal((await post('/tokens/me/sign-out-everywhere', {}, token)).status, 200);
  const again = await didSignIn(key);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.equal((await deleteAccount(String(again.json['token']))).status, 200);
  assertTombstone(userId, 2);
  assert.equal((await me(String(again.json['token']))).status, 401);
  await assertDeletedRefusal(userId, () => didSignIn(key));
});

test('a genuinely new credential still opens a new account of its own', async () => {
  clientIp = '198.51.100.4';
  const key = softPasskey();
  const created = await register(key);
  assert.equal(created.status, 200, `${JSON.stringify(created.json)}\n${output}`);
  assert.equal(created.json['userId'], key.userId);
  assert.notEqual(key.userId, deletedPasskey.userId);
  assert.deepEqual((pods.get(key.userId)!['webAuthnCredentials'] as Array<{ id: string }>).map(c => c.id), [key.id]);
  assert.equal(pods.get(key.userId)!['deletedAt'], undefined);
});

test('a deletion the pod cannot take is a 503 that changes nothing, and the account keeps working', async () => {
  clientIp = '198.51.100.5';
  const wallet = Wallet.createRandom();
  const userId = deriveUserIdFromWallet(wallet.address.toLowerCase());
  const created = await siwe(wallet);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const token = String(created.json['token']);
  const doc = JSON.stringify(pods.get(userId));
  for (const fault of [blipping, failingPuts]) {
    fault.add(userId);
    const r = await deleteAccount(token);
    fault.delete(userId);
    assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
    assert.equal(r.json['deleted'], undefined);
    assert.equal(JSON.stringify(pods.get(userId)), doc);
    assert.equal((await me(token)).status, 200);
    const signedIn = await siwe(wallet);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
    assert.equal(signedIn.json['userId'], userId);
  }
});

test('a deleted account whose pod cannot be read is refused with a 503, never re-opened', async () => {
  clientIp = '198.51.100.6';
  const { userId } = deletedPasskey;
  blipping.add(userId);
  const before = writesTo(userId);
  const r = await register(deletedPasskey);
  blipping.delete(userId);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  await settle();
  assert.equal(writesTo(userId), before);
  assertTombstone(userId, 1);
});

test('after a restart, old tokens stay refused and a deleted bootstrap alias cannot be claimed again', async () => {
  clientIp = '198.51.100.7';
  const key = didKey();
  const claim = { bootstrapUserId: invite.userId, bootstrapInvite: invite.token };
  const claimed = await didSignIn(key, claim);
  assert.equal(claimed.status, 200, `${JSON.stringify(claimed.json)}\n${output}`);
  assert.equal(claimed.json['userId'], invite.userId);
  const aliasToken = String(claimed.json['token']);
  assert.equal((await deleteAccount(aliasToken)).status, 200);
  assertTombstone(invite.userId, 1);

  // A restart forgets which invites were spent and every account in memory.
  await stopIdentity();
  await startIdentity();
  for (const token of [aliasToken, deletedPasskeyToken]) {
    const r = await me(token);
    assert.equal(r.status, 401, JSON.stringify(r.json));
  }
  // The invite works again as far as the invite goes, but the account it opens was deleted;
  // the invite is handed back each time, so every path gives the same answer.
  await assertDeletedRefusal(invite.userId, () => didSignIn(didKey(), claim));
  await assertDeletedRefusal(invite.userId, () => register(softPasskey(), claim));
  await assertDeletedRefusal(invite.userId, () => didSignIn(key, claim));
  // And the old credentials still cannot open their accounts.
  await assertDeletedRefusal(deletedPasskey.userId, () => register(deletedPasskey));
  assertTombstone(invite.userId, 1);
});

/** A usernameless passkey sign-in's request body, with a challenge fetched now. */
async function passkeyAssertion(key: SoftPasskey): Promise<Record<string, unknown>> {
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate' });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const rpId = String(ch.json['rpId'] ?? new URL(base).hostname);
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(1);
  const authData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x05]), counter]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: String(ch.json['nonce']), origin: base, crossOrigin: false }));
  const signature = crypto.sign('sha256',
    Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), key.privateKey);
  return { response: { id: key.id, rawId: key.id, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url') } } };
}

test('a passkey sign-in that read the account before its deletion cannot write it back over the tombstone', async () => {
  clientIp = '198.51.100.8';
  const key = softPasskey();
  const { userId } = key;
  const created = await register(key);
  assert.equal(created.status, 200, `${JSON.stringify(created.json)}\n${output}`);
  const token = String(created.json['token']);
  const signIn = await passkeyAssertion(key);

  // The deletion starts and reads the record; the sign-in then reads the account (still
  // loaded), verifies its assertion and writes the record back with the advanced counter.
  race = { userId, readHeld: false, deletionRead: deferred(), staleWrite: deferred(), tombstone: deferred() };
  const deletion = deleteAccount(token);
  await within(race.deletionRead.promise, 10_000);
  assert.ok(race.readHeld, `the deletion never read the record\n${output}`);
  const signedIn = await post('/auth/webauthn/authenticate', signIn);
  const deleted = await deletion;
  race = null;

  assert.equal(deleted.status, 200, `${JSON.stringify(deleted.json)}\n${output}`);
  assertTombstone(userId, 1);
  assert.equal(signedIn.status, 409, `${JSON.stringify(signedIn.json)}\n${output}`);
  assert.match(String(signedIn.json['error']), /account was deleted/);
  assert.equal(signedIn.json['token'], undefined);
  await settle();
  assertTombstone(userId, 1);
  assert.equal((await me(token)).status, 401);

  // The pod is what a restart loads: the account stays deleted and its token refused.
  await stopIdentity();
  await startIdentity();
  assert.equal((await me(token)).status, 401);
  await assertDeletedRefusal(userId, () => register(key));
  assertTombstone(userId, 1);
});

test('an add-device challenge issued before the deletion cannot bring the account back, even with the pod unreadable', async () => {
  clientIp = '198.51.100.9';
  const key = softPasskey();
  const { userId } = key;
  const created = await register(key);
  assert.equal(created.status, 200, `${JSON.stringify(created.json)}\n${output}`);
  const token = String(created.json['token']);
  // Someone holding the token asks to add a device, then the owner deletes the account.
  const options = await post('/auth/webauthn/register-options', { name: 'Someone' }, token);
  assert.equal(options.status, 200, JSON.stringify(options.json));
  assert.equal((await deleteAccount(token)).status, 200);
  assertTombstone(userId, 1);

  // The ceremony completes while the pod cannot be read: refused as deleted, no token, and
  // nothing put back in memory for the account.
  blipping.add(userId);
  try {
    const rpId = (options.json['rp'] as { id: string }).id;
    const added = await post('/auth/webauthn/register', { response: attest(softPasskey(), String(options.json['challenge']), base, rpId) });
    assert.equal(added.status, 409, `${JSON.stringify(added.json)}\n${output}`);
    assert.match(String(added.json['error']), /account was deleted/);
    assert.equal(added.json['token'], undefined);
    // With nothing to read on the pod, the old token is still refused, and the account's
    // documents do not resolve.
    assert.equal((await me(token)).status, 401);
    assert.equal((await call('GET', `/users/${userId}/did.json`)).status, 404);
    assert.equal((await call('GET', `/users/${userId}/profile`)).status, 404);
  } finally {
    blipping.delete(userId);
  }
  await settle();
  assertTombstone(userId, 1);
  assert.equal((await me(token)).status, 401);
});

test('a load of the account that read it before the deletion does not put it back in memory', async () => {
  clientIp = '198.51.100.10';
  const key = softPasskey();
  const { userId } = key;
  const created = await register(key);
  assert.equal(created.status, 200, `${JSON.stringify(created.json)}\n${output}`);
  const token = String(created.json['token']);
  // After a restart that did not list the pod, the account is loaded on demand.
  unlisted.add(userId);
  await stopIdentity();
  await startIdentity();

  // A request with the token starts that load and reads the record; the deletion (which loads
  // the account for itself) then completes; only then does the first read come back.
  const release = deferred();
  heldGet = { userId, received: deferred(), release };
  const pending = me(token);
  await within(heldGet.received.promise, 10_000);
  assert.equal(heldGet, null, `the on-demand load never read the record\n${output}`);
  const deleted = await deleteAccount(token);
  assert.equal(deleted.status, 200, `${JSON.stringify(deleted.json)}\n${output}`);
  assertTombstone(userId, 1);
  release.resolve();

  const late = await pending;
  assert.equal(late.status, 401, `${JSON.stringify(late.json)}\n${output}`);
  assert.equal((await me(token)).status, 401);
  assert.equal((await call('GET', `/users/${userId}/did.json`)).status, 404);
  await assertDeletedRefusal(userId, () => register(key));
  assertTombstone(userId, 1);
  unlisted.delete(userId);
});

test('every DID sign-in above signed the challenge\'s message', () => {
  assert.doesNotMatch(output, /WARN identity_did_bare_nonce /);
});
