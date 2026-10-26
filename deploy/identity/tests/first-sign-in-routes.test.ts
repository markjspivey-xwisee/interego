/**
 * First-time wallet and DID sign-ins, through the routes: server.ts is started as a child
 * process against a stand-in pod server (no live pod). Some accounts are on their pods but
 * not in the root listing, so the startup rebuild never loads them, as a pod unreadable at
 * startup is never loaded; one listed account no longer holds the wallet its id was derived
 * from, as after the owner removed it. A sign-in with such a wallet or DID misses the
 * indexes and takes the first-time path, which used to PUT a fresh auth-methods document
 * over whatever the pod held.
 *
 * The pure half is tests/first-sign-in.test.ts.
 *
 * Run:
 *   node --test --import tsx tests/first-sign-in-routes.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { deriveUserIdFromDid, deriveUserIdFromWallet } from '../derive-userid.js';

const now = new Date().toISOString();
const passkey = (id: string) => ({ id, publicKey: 'AA', counter: 0, createdAt: now });

// ── Credentials ──
const wallets = {
  passkeyOnly: Wallet.createRandom(),   // its account holds a passkey (the wallet was removed)
  unloaded: Wallet.createRandom(),      // its account lists it but was never loaded
  unreadable: Wallet.createRandom(),    // its pod answers 502
  fresh: Wallet.createRandom(),         // no pod
  raced: Wallet.createRandom(),         // no pod when read; another writer creates it before the write
};
const walletUser = (w: { address: string }) => deriveUserIdFromWallet(w.address.toLowerCase());

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
function ed25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return { multibase: `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`, privateKey };
}
function didKey() {
  const { multibase, privateKey } = ed25519();
  return { did: `did:key:${multibase}`, privateKey };
}
const dids = { passkeyOnly: didKey(), unloaded: didKey(), unreadable: didKey(), fresh: didKey(), bootstrap: didKey() };
const didUser = (k: { did: string }) => deriveUserIdFromDid(k.did);
// A did:web is checked against the key the caller sends, so its account must list that key.
const didWeb = { did: 'did:web:owner.example', owner: ed25519(), other: ed25519() };
// A did:web two accounts list, each with its own key: its owner's (non-derived, loaded at
// startup) and one bound by someone else (loaded later). Neither is the account derived from it.
const sharedWeb = { did: 'did:web:shared.example', owner: ed25519(), other: ed25519(),
  ownerId: 'u-eth-0000000000d1', otherId: 'u-eth-0000000000d2' };
// A wallet two accounts list (each binding proved possession): the one derived from it, loaded
// at startup, and another loaded later.
const sharedWallet = Wallet.createRandom();
const sharedWalletOther = 'wallet-second-holder';
const didWebKey = (did: string, multibase: string) =>
  ({ did, publicKeyMultibase: multibase, keyType: 'Ed25519VerificationKey2020', createdAt: now });

// Seeded legacy accounts claimed with a bootstrap invite (mode B).
const invites = { wallet: { userId: 'seeded-wallet', token: crypto.randomBytes(16).toString('hex') },
  did: { userId: 'seeded-did', token: crypto.randomBytes(16).toString('hex') } };
const bootstrapWallet = Wallet.createRandom();

// ── Pods ──
const pods = new Map<string, Record<string, unknown>>([
  [walletUser(wallets.passkeyOnly), { userId: walletUser(wallets.passkeyOnly), name: 'Owner', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [passkey('cred-wallet-owner')] }],
  [walletUser(wallets.unloaded), { userId: walletUser(wallets.unloaded), name: 'Unloaded', didKeys: [],
    walletAddresses: [wallets.unloaded.address.toLowerCase()], webAuthnCredentials: [passkey('cred-unloaded')] }],
  [didUser(dids.passkeyOnly), { userId: didUser(dids.passkeyOnly), name: 'DID owner', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [passkey('cred-did-owner')] }],
  [didUser(dids.unloaded), { userId: didUser(dids.unloaded), name: 'DID unloaded', walletAddresses: [],
    webAuthnCredentials: [passkey('cred-did-unloaded')],
    didKeys: [{ did: dids.unloaded.did, publicKeyMultibase: 'z', keyType: 'Ed25519VerificationKey2020', createdAt: now }] }],
  [didUser(didWeb), { userId: didUser(didWeb), name: 'did:web owner', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [{ did: didWeb.did, publicKeyMultibase: didWeb.owner.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: now }] }],
  [sharedWeb.ownerId, { userId: sharedWeb.ownerId, name: 'did:web owner', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [didWebKey(sharedWeb.did, sharedWeb.owner.multibase)] }],
  [sharedWeb.otherId, { userId: sharedWeb.otherId, name: 'did:web other', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [didWebKey(sharedWeb.did, sharedWeb.other.multibase)] }],
  [walletUser(sharedWallet), { userId: walletUser(sharedWallet), name: 'Wallet derived', didKeys: [],
    walletAddresses: [sharedWallet.address.toLowerCase()], webAuthnCredentials: [] }],
  [sharedWalletOther, { userId: sharedWalletOther, name: 'Wallet other', didKeys: [],
    walletAddresses: [sharedWallet.address.toLowerCase()], webAuthnCredentials: [] }],
]);
// Only these are in the root listing, so only these load at startup.
const listed = new Set([walletUser(wallets.passkeyOnly), didUser(dids.passkeyOnly), sharedWeb.ownerId, walletUser(sharedWallet)]);
const unreadable = new Set([walletUser(wallets.unreadable), didUser(dids.unreadable)]);
// Pods a test makes unreadable for a while (a CSS blip), after startup has loaded the rest.
const blipping = new Set<string>();
// GET once answers 404, and the document then appears as another writer's.
const racedUser = walletUser(wallets.raced);
const racedDoc = { userId: racedUser, name: 'Other writer', walletAddresses: [], didKeys: [], webAuthnCredentials: [passkey('cred-other-writer')] };
let racedReads = 0;
const writes: Array<{ userId: string; ifNoneMatch: string | undefined }> = [];

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
    if (unreadable.has(userId) || blipping.has(userId)) { res.writeHead(502).end(); return; }
    if (userId === racedUser && racedReads++ === 0) {
      pods.set(racedUser, racedDoc);
      res.writeHead(404).end();
      return;
    }
    const doc = pods.get(userId);
    if (!doc) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify(doc));
    return;
  }
  if (m && req.method === 'PUT') {
    const userId = m[1]!;
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    let body = '';
    req.on('data', d => { body += String(d); });
    req.on('end', () => {
      if (ifNoneMatch === '*' && pods.has(userId)) { res.writeHead(412).end(); return; }
      writes.push({ userId, ifNoneMatch });
      pods.set(userId, JSON.parse(body) as Record<string, unknown>);
      res.writeHead(201).end();
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

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

async function siwe(w: { address: string; signMessage(message: string): Promise<string> }, extra: Record<string, unknown> = {}) {
  const { nonce } = (await post('/challenges', { purpose: 'siwe' })).json as { nonce: string };
  const message = `example.test wants you to sign in with your Ethereum account:\n${w.address}\n\nSign in.\n\nNonce: ${nonce}`;
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'New', ...extra });
}

async function didSignIn(k: { did: string; privateKey: crypto.KeyObject }, extra: Record<string, unknown> = {}) {
  const { nonce } = (await post('/challenges', { purpose: 'did-sig' })).json as { nonce: string };
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), k.privateKey).toString('base64url');
  return post('/auth/did', { did: k.did, nonce, signature, name: 'New', ...extra });
}

const writesTo = (userId: string) => writes.filter(w => w.userId === userId);

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  const podPort = (podServer.address() as net.AddressInfo).port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: crypto.randomBytes(32).toString('base64'), JANITOR_INTERVAL_MS: '0',
    BOOTSTRAP_INVITES: Object.values(invites).map(i => `${i.userId}:${i.token}`).join(','),
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
});

after(async () => {
  identity?.kill('SIGTERM');
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

test('a first-time wallet whose account holds a passkey is refused, and the account is left as it was', async () => {
  const userId = walletUser(wallets.passkeyOnly);
  const r = await siwe(wallets.passkeyOnly);
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.match(String(r.json['error']), /Sign in with an existing credential/);
  assert.equal(r.json['token'], undefined);
  assert.deepEqual(writesTo(userId), []);
  assert.deepEqual(pods.get(userId)!['webAuthnCredentials'], [passkey('cred-wallet-owner')]);
});

test('a wallet its pod lists but the index missed signs in to that account, and nothing is written', async () => {
  const userId = walletUser(wallets.unloaded);
  const r = await siwe(wallets.unloaded);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], userId);
  assert.deepEqual(writesTo(userId), []);
  // Loaded now: its passkey is known too, so a second sign-in is an ordinary one.
  assert.equal((await siwe(wallets.unloaded)).status, 200);
  assert.deepEqual(writesTo(userId), []);
});

test('a wallet whose pod cannot be read is told to try again, and nothing is written', async () => {
  const r = await siwe(wallets.unreadable);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(writesTo(walletUser(wallets.unreadable)), []);
});

test('a wallet with no pod creates its account once, with a write that requires absence', async () => {
  const userId = walletUser(wallets.fresh);
  const r = await siwe(wallets.fresh);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json['userId'], userId);
  assert.deepEqual(writesTo(userId), [{ userId, ifNoneMatch: '*' }]);
  assert.deepEqual(pods.get(userId)!['walletAddresses'], [wallets.fresh.address.toLowerCase()]);
  // Signing in again is a returning sign-in: no second write.
  assert.equal((await siwe(wallets.fresh)).status, 200);
  assert.equal(writesTo(userId).length, 1);
});

test('an account another writer creates between the read and the write is not overwritten', async () => {
  const r = await siwe(wallets.raced);
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.deepEqual(writesTo(racedUser), []);
  assert.deepEqual(pods.get(racedUser), racedDoc);
});

test('the same for a DID: refused beside a passkey, signed in when listed, 503 when unreadable, created once', async () => {
  const refused = await didSignIn(dids.passkeyOnly);
  assert.equal(refused.status, 401, JSON.stringify(refused.json));
  assert.match(String(refused.json['error']), /Sign in with an existing credential/);
  assert.deepEqual(writesTo(didUser(dids.passkeyOnly)), []);
  assert.deepEqual(pods.get(didUser(dids.passkeyOnly))!['webAuthnCredentials'], [passkey('cred-did-owner')]);

  const returning = await didSignIn(dids.unloaded);
  assert.equal(returning.status, 200, `${JSON.stringify(returning.json)}\n${output}`);
  assert.equal(returning.json['userId'], didUser(dids.unloaded));
  assert.deepEqual(writesTo(didUser(dids.unloaded)), []);

  const down = await didSignIn(dids.unreadable);
  assert.equal(down.status, 503, JSON.stringify(down.json));
  assert.deepEqual(writesTo(didUser(dids.unreadable)), []);

  const userId = didUser(dids.fresh);
  const created = await didSignIn(dids.fresh);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json['userId'], userId);
  assert.deepEqual(writesTo(userId), [{ userId, ifNoneMatch: '*' }]);
  assert.equal((await didSignIn(dids.fresh)).status, 200);
  assert.equal(writesTo(userId).length, 1);
});

test('a bootstrap claim that meets an unreadable pod keeps its invite, so the retry succeeds', async () => {
  for (const [kind, attempt] of [
    ['wallet', () => siwe(bootstrapWallet, { bootstrapUserId: invites.wallet.userId, bootstrapInvite: invites.wallet.token })],
    ['did', () => didSignIn(dids.bootstrap, { bootstrapUserId: invites.did.userId, bootstrapInvite: invites.did.token })],
  ] as const) {
    const { userId } = invites[kind];
    blipping.add(userId);
    const down = await attempt();
    assert.equal(down.status, 503, `${kind}: ${JSON.stringify(down.json)}`);
    assert.deepEqual(writesTo(userId), []);
    blipping.delete(userId);
    const retry = await attempt();
    assert.equal(retry.status, 200, `${kind}: ${JSON.stringify(retry.json)}\n${output}`);
    assert.equal(retry.json['userId'], userId);
  }
});

test('a did:web the index missed signs in only with the key its pod lists for it', async () => {
  const userId = didUser(didWeb);
  const impostor = await didSignIn({ did: didWeb.did, privateKey: didWeb.other.privateKey }, { publicKeyMultibase: didWeb.other.multibase });
  assert.equal(impostor.status, 401, JSON.stringify(impostor.json));
  assert.equal(impostor.json['token'], undefined);
  assert.deepEqual(writesTo(userId), []);
  assert.equal((pods.get(userId)!['didKeys'] as Array<{ publicKeyMultibase: string }>)[0]!.publicKeyMultibase, didWeb.owner.multibase);
});

/** Load an account the startup pass did not (a targeted passkey sign-in names it). */
async function load(userId: string): Promise<void> {
  await post('/challenges', { purpose: 'webauthn-authenticate', userId });
}

test('a did:web two accounts list signs in to the one holding the key that signed, whichever loaded last', async () => {
  await load(sharedWeb.otherId);
  for (const [key, userId] of [[sharedWeb.owner, sharedWeb.ownerId], [sharedWeb.other, sharedWeb.otherId], [sharedWeb.owner, sharedWeb.ownerId]] as const) {
    const r = await didSignIn({ did: sharedWeb.did, privateKey: key.privateKey }, { publicKeyMultibase: key.multibase });
    assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
    assert.equal(r.json['userId'], userId);
  }
  // A key neither lists is still refused.
  const stranger = ed25519();
  const r = await didSignIn({ did: sharedWeb.did, privateKey: stranger.privateKey }, { publicKeyMultibase: stranger.multibase });
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.deepEqual(writesTo(sharedWeb.ownerId), []);
  assert.deepEqual(writesTo(sharedWeb.otherId), []);
});

test('a wallet two accounts list signs in to the one derived from it, whichever loaded last', async () => {
  await load(sharedWalletOther);
  const r = await siwe(sharedWallet);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], walletUser(sharedWallet));
  // The legacy verify route picks the same account.
  const message = `example.test wants you to sign in with your Ethereum account:\n${sharedWallet.address}\n\nSign in.`;
  const legacy = await post('/siwe/verify', { message, signature: await sharedWallet.signMessage(message) });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
  assert.equal(legacy.json['userId'], walletUser(sharedWallet));
  assert.deepEqual(writesTo(walletUser(sharedWallet)), []);
  assert.deepEqual(writesTo(sharedWalletOther), []);
});
