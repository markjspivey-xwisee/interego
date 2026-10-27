/**
 * Writes to one account that overlap a passkey sign-in of it, through the routes: server.ts is
 * started as a child process against a stand-in pod server whose reads and writes a test can
 * hold, with passkeys from the software authenticator in tests/soft-authenticator.ts.
 *
 * A passkey sign-in reads the account's record from its pod under the account's lock and writes
 * it back with the passkey's new sign counter. The other writers of an account read this
 * server's copy of the record: a credential added with a bearer is applied to that copy at once
 * and written to the pod afterwards, behind the lock; a removal or a sign-out-everywhere reads
 * the record once it holds the lock. Each test lets one of them land while a sign-in's read of
 * the pod is in flight (or queued), and checks that neither undoes the other: the credential
 * added signs in to its account at once, and the counter and relying-party binding the sign-in
 * wrote are still on the pod afterwards. The last test makes the pod refuse a removal.
 *
 * Run:
 *   node --test --import tsx tests/concurrent-account-writes-routes.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { assertion, attest, softPasskey, type SoftPasskey } from './soft-authenticator.js';
import { deriveUserIdFromDid, deriveUserIdFromWallet } from '../derive-userid.js';

const now = new Date().toISOString();
const stored = (key: SoftPasskey, counter = 0) => ({ id: key.id, publicKey: key.cose.toString('base64url'), counter, createdAt: now });
const account = (key: SoftPasskey, ...more: SoftPasskey[]) =>
  ({ userId: key.userId, name: key.userId, walletAddresses: [] as string[], didKeys: [] as unknown[], webAuthnCredentials: [key, ...more].map(k => stored(k)) });

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
function didKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const multibase = `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
  return { did: `did:key:${multibase}`, multibase, privateKey };
}

// Each account is the one derived from its first passkey, and is loaded at startup.
const addWallet = { key: softPasskey(), wallet: Wallet.createRandom() };
const addPasskey = { key: softPasskey(), added: softPasskey() };
// Its first passkey was enrolled before passkeys were pinned to a relying party; the second
// gives the test a token.
const signOut = { legacy: softPasskey(), key: softPasskey() };
const removal = { key: softPasskey(), wallet: Wallet.createRandom() };
const twoAdds = { key: softPasskey(), added: softPasskey(), wallet: Wallet.createRandom() };
const refused = { key: softPasskey(), wallet: Wallet.createRandom(), did: didKey() };

const pods = new Map<string, Record<string, unknown>>([
  [addWallet.key.userId, account(addWallet.key)],
  [addPasskey.key.userId, account(addPasskey.key)],
  [signOut.legacy.userId, account(signOut.legacy, signOut.key)],
  [removal.key.userId, { ...account(removal.key), walletAddresses: [removal.wallet.address.toLowerCase()] }],
  [twoAdds.key.userId, account(twoAdds.key)],
  [refused.key.userId, { ...account(refused.key), walletAddresses: [refused.wallet.address.toLowerCase()],
    didKeys: [{ did: refused.did.did, publicKeyMultibase: refused.did.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: now }] }],
]);
const listed = new Set(pods.keys());
const failingPuts = new Set<string>();
const writes: string[] = [];

type Hold = { arrived: Promise<void>; release: () => void };
const heldReads = new Map<string, { arrive: () => void; released: Promise<void> }>();
// userId -> the doc PUTs still to let through before the one held.
const heldWrites = new Map<string, { skip: number; arrive: () => void; released: Promise<void> }>();
/** Hold the next read of `userId`'s auth-methods.jsonld until released. */
function holdRead(userId: string): Hold {
  let arrive!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  heldReads.set(userId, { arrive, released: new Promise<void>(resolve => { release = resolve; }) });
  return { arrived, release };
}
/** Hold the `nth` write of `userId`'s auth-methods.jsonld from now until released. */
function holdWrite(userId: string, nth = 1): Hold {
  let arrive!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  heldWrites.set(userId, { skip: nth - 1, arrive, released: new Promise<void>(resolve => { release = resolve; }) });
  return { arrived, release };
}

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...listed].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET') {
    const userId = m[1]!;
    // What the pod holds when the read arrives, answered once the test lets go.
    const doc = pods.get(userId);
    const answer = (): void => {
      if (!doc) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/ld+json' });
      res.end(JSON.stringify(doc));
    };
    const held = heldReads.get(userId);
    if (held) {
      heldReads.delete(userId);
      held.arrive();
      void held.released.then(answer);
      return;
    }
    answer();
    return;
  }
  if (m && req.method === 'PUT') {
    const userId = m[1]!;
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    let body = '';
    req.on('data', d => { body += String(d); });
    req.on('end', () => {
      const land = (): void => {
        if (failingPuts.has(userId)) { res.writeHead(500).end(); return; }
        if (ifNoneMatch === '*' && pods.has(userId)) { res.writeHead(412).end(); return; }
        writes.push(userId);
        pods.set(userId, JSON.parse(body) as Record<string, unknown>);
        res.writeHead(201).end();
      };
      const held = heldWrites.get(userId);
      if (held && held.skip-- === 0) {
        heldWrites.delete(userId);
        held.arrive();
        void held.released.then(land);
        return;
      }
      land();
    });
    return;
  }
  if (req.method === 'PUT') { res.writeHead(201).end(); return; }
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
let identity: ChildProcess;
let base = '';
let output = '';

// Each test arrives from its own address (the server trusts one proxy hop), so the per-IP
// auth-enroll budget (30 a minute) is not shared across the whole file.
let clientAddr = 0;
beforeEach(() => { clientAddr++; });
async function call(method: string, path: string, body: unknown, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${clientAddr}`, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}
const post = (path: string, body: unknown, bearer?: string) => call('POST', path, body, bearer);

async function signIn(key: SoftPasskey, counter: number) {
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate' });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const rpId = String(ch.json['rpId'] ?? new URL(base).hostname);
  return post('/auth/webauthn/authenticate', { response: assertion(key, String(ch.json['nonce']), base, rpId, counter) });
}
async function tokenFor(key: SoftPasskey, counter: number, userId = key.userId): Promise<string> {
  const r = await signIn(key, counter);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], userId);
  return String(r.json['token']);
}
async function addDevice(key: SoftPasskey, bearer: string) {
  const options = await post('/auth/webauthn/register-options', { name: 'New' }, bearer);
  assert.equal(options.status, 200, JSON.stringify(options.json));
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), base, rpId) });
}
async function siwe(w: { address: string; signMessage(message: string): Promise<string> }, bearer?: string, extra: Record<string, unknown> = {}) {
  const { nonce } = (await post('/challenges', { purpose: 'siwe' })).json as { nonce: string };
  const message = `${new URL(base).host} wants you to sign in with your Ethereum account:\n${w.address}\n\nSign in.\n\n`
    + `URI: ${base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'New', ...extra }, bearer);
}
async function didSignIn(k: { did: string; privateKey: crypto.KeyObject }) {
  const { nonce } = (await post('/challenges', { purpose: 'did-sig' })).json as { nonce: string };
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), k.privateKey).toString('base64url');
  return post('/auth/did', { did: k.did, nonce, signature, name: 'New' });
}

type PodRecord = { walletAddresses: string[]; didKeys: Array<{ did: string }>; sessionEpoch?: number;
  webAuthnCredentials: Array<{ id: string; counter: number; rpId?: string }> };
const record = (userId: string) => pods.get(userId) as unknown as PodRecord;
const credential = (userId: string, key: SoftPasskey) => record(userId).webAuthnCredentials.find(c => c.id === key.id);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Waits until `ready` holds (a write behind the lock has landed), or fails after 5 s. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`${what}\n${output}`);
    await sleep(25);
  }
}
/** A request that may wait for the account's lock: settled within `ms`, or still pending. */
const settles = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  const podPort = (podServer.address() as net.AddressInfo).port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS',
    'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_ORIGIN', 'WEBAUTHN_RP_ORIGINS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: crypto.randomBytes(32).toString('base64'), JANITOR_INTERVAL_MS: '0',
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
    await sleep(100);
  }
});

after(async () => {
  identity?.kill('SIGTERM');
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

test('a wallet added with a bearer while a passkey sign-in reads the pod signs in to that account at once, and the counter is kept', async () => {
  const { key, wallet } = addWallet;
  const id = key.userId;
  const token = await tokenFor(key, 1);
  const read = holdRead(id);
  const signingIn = signIn(key, 2);
  await read.arrived;
  const added = await siwe(wallet, token);
  assert.equal(added.status, 200, `${JSON.stringify(added.json)}\n${output}`);
  assert.equal(added.json['userId'], id);
  // The sign-in writes first; the add's own write, queued behind it, is held.
  const addWrite = holdWrite(id, 2);
  read.release();
  const r = await signingIn;
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  await addWrite.arrived;
  // The wallet's first sign-in before the add's write lands goes to the account it was added
  // to, not to a new account derived from it (which would keep its sign-ins for good).
  const walletSignIn = siwe(wallet);
  await settles(walletSignIn, 2_000);
  addWrite.release();
  const w = await walletSignIn;
  assert.equal(w.status, 200, `${JSON.stringify(w.json)}\n${output}`);
  assert.equal(w.json['userId'], id);
  assert.ok(!pods.has(deriveUserIdFromWallet(wallet.address.toLowerCase())), 'no account opened for the wallet');
  await until(() => record(id).walletAddresses.includes(wallet.address.toLowerCase()), 'the add lands');
  assert.equal(credential(id, key)?.counter, 2, 'the counter the sign-in accepted is on the pod');
  const again = await siwe(wallet);
  assert.equal(again.json['userId'], id);
});

test('a passkey added with a bearer while a passkey sign-in reads the pod signs in at once', async () => {
  const { key, added } = addPasskey;
  const id = key.userId;
  const token = await tokenFor(key, 1);
  const read = holdRead(id);
  const signingIn = signIn(key, 2);
  await read.arrived;
  const registered = await addDevice(added, token);
  assert.equal(registered.status, 200, `${JSON.stringify(registered.json)}\n${output}`);
  assert.equal(registered.json['userId'], id);
  const addWrite = holdWrite(id, 2);
  read.release();
  const r = await signingIn;
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  await addWrite.arrived;
  // Signed in while the add's write is held, the new passkey finds its account (its sign-in
  // waits for the account's lock, behind that write).
  const newSignIn = signIn(added, 1);
  await settles(newSignIn, 2_000);
  addWrite.release();
  const n = await newSignIn;
  assert.equal(n.status, 200, `${JSON.stringify(n.json)}\n${output}`);
  assert.equal(n.json['userId'], id);
  await until(() => credential(id, added)?.counter === 1, 'both writes land');
  assert.equal(credential(id, key)?.counter, 2, 'the first sign-in\'s counter is on the pod');
});

test('sign-out-everywhere while a passkey sign-in reads the pod keeps the counter and relying-party binding the sign-in wrote', async () => {
  const { legacy, key } = signOut;
  const id = legacy.userId;
  const token = await tokenFor(key, 1, id);
  assert.equal(credential(id, legacy)?.rpId, undefined);
  const read = holdRead(id);
  const signingIn = signIn(legacy, 1);
  await read.arrived;
  // Its bearer is checked and it reaches the account's lock while the sign-in holds it.
  const signingOut = post('/tokens/me/sign-out-everywhere', {}, token);
  assert.equal(await settles(signingOut, 300), false, 'sign-out waits for the account\'s lock');
  read.release();
  const [r, s] = await Promise.all([signingIn, signingOut]);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(s.status, 200, `${JSON.stringify(s.json)}\n${output}`);
  assert.equal(record(id).sessionEpoch, 1);
  assert.equal(credential(id, legacy)?.counter, 1, 'the sign-in\'s counter');
  assert.equal(credential(id, legacy)?.rpId, new URL(base).hostname, 'the relying party the sign-in pinned');
  // So the same counter again is refused, as a replay.
  const replay = await signIn(legacy, 1);
  assert.equal(replay.status, 401, `${JSON.stringify(replay.json)}\n${output}`);
});

test('a wallet removed while a passkey sign-in reads the pod keeps the sign-in\'s counter', async () => {
  const { key, wallet } = removal;
  const id = key.userId;
  const token = await tokenFor(key, 1);
  const read = holdRead(id);
  const signingIn = signIn(key, 2);
  await read.arrived;
  const removing = call('DELETE', `/auth-methods/me/wallet/${wallet.address.toLowerCase()}`, {}, token);
  assert.equal(await settles(removing, 300), false, 'the removal waits for the account\'s lock');
  read.release();
  const [r, d] = await Promise.all([signingIn, removing]);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(d.status, 200, `${JSON.stringify(d.json)}\n${output}`);
  assert.deepEqual(record(id).walletAddresses, []);
  assert.equal(credential(id, key)?.counter, 2);
  const replay = await signIn(key, 2);
  assert.equal(replay.status, 401, `${JSON.stringify(replay.json)}\n${output}`);
});

test('a passkey sign-in queued behind one added credential\'s write and ahead of another\'s keeps both, and its counter', async () => {
  const { key, added, wallet } = twoAdds;
  const id = key.userId;
  const token = await tokenFor(key, 1);
  const firstWrite = holdWrite(id);
  const registered = await addDevice(added, token);
  assert.equal(registered.status, 200, `${JSON.stringify(registered.json)}\n${output}`);
  await firstWrite.arrived;
  // The sign-in waits for the lock behind the first add's write; the second add's write
  // queues behind the sign-in.
  const signingIn = signIn(key, 2);
  assert.equal(await settles(signingIn, 300), false, 'the sign-in waits for the account\'s lock');
  const second = await siwe(wallet, token);
  assert.equal(second.status, 200, `${JSON.stringify(second.json)}\n${output}`);
  assert.equal(second.json['userId'], id);
  await sleep(100);
  firstWrite.release();
  const r = await signingIn;
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  await until(() => record(id).walletAddresses.includes(wallet.address.toLowerCase()), 'the second add lands');
  await sleep(100);
  assert.ok(credential(id, added), 'the first add is on the pod');
  assert.equal(credential(id, key)?.counter, 2, 'the sign-in\'s counter is on the pod');
  const w = await siwe(wallet);
  assert.equal(w.json['userId'], id);
});

test('a removal the pod refuses leaves the credential signing in to its account', async () => {
  const { key, wallet, did } = refused;
  const id = key.userId;
  const token = await tokenFor(key, 1);
  const before = structuredClone(record(id));
  failingPuts.add(id);
  const d = await call('DELETE', '/auth-methods/me/did', { did: did.did }, token);
  const w = await call('DELETE', `/auth-methods/me/wallet/${wallet.address.toLowerCase()}`, {}, token);
  failingPuts.delete(id);
  assert.equal(d.status, 500, JSON.stringify(d.json));
  assert.equal(w.status, 500, JSON.stringify(w.json));
  assert.deepEqual(record(id), before, 'the pod still lists both');
  // Within this server's 10 s cache: the did:key signs in to its account, not to a new one
  // derived from it, and the wallet signs in too, where this server's copy had dropped them.
  const signedInDid = await didSignIn(did);
  assert.equal(signedInDid.status, 200, `${JSON.stringify(signedInDid.json)}\n${output}`);
  assert.equal(signedInDid.json['userId'], id);
  assert.ok(!pods.has(deriveUserIdFromDid(did.did)), 'no account opened for the did:key');
  const signedInWallet = await siwe(wallet);
  assert.equal(signedInWallet.status, 200, `${JSON.stringify(signedInWallet.json)}\n${output}`);
  assert.equal(signedInWallet.json['userId'], id);
  const existing = await siwe(wallet, undefined, { existingOnly: true });
  assert.equal(existing.status, 200, `${JSON.stringify(existing.json)}\n${output}`);
  assert.equal(existing.json['userId'], id);
  // Removed again with the pod taking it, both are gone.
  const again = await call('DELETE', '/auth-methods/me/did', { did: did.did }, token);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual(record(id).didKeys, []);
});
