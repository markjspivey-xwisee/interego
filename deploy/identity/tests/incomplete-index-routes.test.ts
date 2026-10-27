/**
 * Sign-ins and registrations while the account index is incomplete, through the routes: server.ts
 * is started as a child process against a stand-in pod server (no live pod) that lists
 * accounts whose pods answer 502 for the whole run, so the startup scan never completes.
 *
 * The sign-in indexes hold the accounts loaded so far, and the order that keeps a credential
 * with its owner (credential-index.ts) ranks only those. While the owner's account was not
 * loaded, a credential missing from the index opened an account of its own: a wallet's first
 * sign-in created the account derived from it, which then took the wallet's sign-ins from the
 * account listing it once that loaded; a did:key did the same; and anyone could register an
 * unloaded owner's passkey id with a copy of its public key ('none' attestation proves nothing
 * about the private key), after which the owner's usernameless sign-in found only the copy and
 * signed in to it. Now, until every account is loaded, a credential no loaded account holds
 * opens no account, and no passkey joins one (503 "still loading", nothing written, no
 * bootstrap invite spent), while an account that already lists it still signs in. A passkey
 * registration is refused when it asks for its options, before the browser has created a
 * passkey no account would list. A did:web is not bound with a bearer either (bound with another
 * key it takes no sign-in, but keeps its owner from binding it again once the owner removes it).
 * A passkey or did:web sign-in no loaded holder verifies is told to wait rather than refused, as
 * is a wallet sign-in for an existing account only, and a passkey sign-in waits for the account
 * derived from its id.
 *
 * Run:
 *   node --test --import tsx tests/incomplete-index-routes.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { deriveUserIdFromDid, deriveUserIdFromWallet } from '../derive-userid.js';
import { assertion, attest, softPasskey, type SoftPasskey } from './soft-authenticator.js';
import { closeServer, stopChild } from './teardown.js';
import { publicJwk } from './public-jwk.js';

const now = new Date().toISOString();
const earlier = '2025-01-01T00:00:00.000Z';
const walletUser = (w: { address: string }) => deriveUserIdFromWallet(w.address.toLowerCase());
const stored = (key: SoftPasskey, createdAt: string) => ({ id: key.id, publicKey: key.cose.toString('base64url'), counter: 0, createdAt });

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
  const raw = Buffer.from(publicJwk(publicKey).x!, 'base64url');
  return { multibase: `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`, privateKey };
}

// ── The account that is never loaded ──
// Not derived from any credential it holds (a passkey account that added a wallet and a
// did:key), and listed, so the index stays incomplete while its pod answers 502.
const ownerId = 'u-pk-0000000000f1';
const owner = {
  wallet: Wallet.createRandom(),
  didKey: (() => { const k = ed25519(); return { did: `did:key:${k.multibase}`, ...k }; })(),
  copied: softPasskey(),     // someone registers its id with a copy of its public key
  contested: softPasskey(),  // a loaded account lists its id with a key of its own
  didWeb: { did: 'did:web:contested.example', ...ed25519() },  // the same, for a did:web
  soleWeb: { did: 'did:web:owner.example', ...ed25519() },     // a did:web no loaded account lists
};
// A loaded account listing the owner's `contested` id, and its did:web, with keys of its own.
const contestedOther = { id: 'a-loaded-holder', key: softPasskey(owner.contested.rawId), didWebKey: ed25519() };
// A loaded account derived from its wallet, whose token adds a device.
const linked = Wallet.createRandom();
// Accounts derived from their wallets that list them but are not in the listing, so not loaded:
// one signed in to by a plain sign-in, one by a sign-in for an existing account only.
const returning = Wallet.createRandom();
const returningExisting = Wallet.createRandom();
// A loaded account derived from its wallet, whose token adds DIDs.
const adder = Wallet.createRandom();
// A did:web no loaded account lists.
const didWeb = { did: 'did:web:loading.example', ...ed25519() };
// A passkey whose account is the one derived from its id (a fresh registration opened it),
// listed but unreadable, and a loaded account that lists its id with a later copy of its key
// (registered before registrations waited for every account).
const derivedOwner = softPasskey();
const copyHolder = 'u-eth-00000000c0b1';

// Seeded legacy accounts claimed with a bootstrap invite (mode B), one per credential kind.
const invites = {
  wallet: { userId: 'seeded-wallet', token: crypto.randomBytes(16).toString('hex') },
  did: { userId: 'seeded-did', token: crypto.randomBytes(16).toString('hex') },
  passkey: { userId: 'seeded-passkey', token: crypto.randomBytes(16).toString('hex') },
};

// ── Pods ──
const account = (userId: string, fields: Record<string, unknown>) =>
  ({ userId, name: userId, walletAddresses: [], webAuthnCredentials: [], didKeys: [], ...fields });
const pods = new Map<string, Record<string, unknown>>([
  [ownerId, account(ownerId, {
    walletAddresses: [owner.wallet.address.toLowerCase()],
    didKeys: [{ did: owner.didKey.did, publicKeyMultibase: owner.didKey.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: earlier },
      { did: owner.didWeb.did, publicKeyMultibase: owner.didWeb.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: earlier },
      { did: owner.soleWeb.did, publicKeyMultibase: owner.soleWeb.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: earlier }],
    webAuthnCredentials: [stored(owner.copied, earlier), stored(owner.contested, earlier)],
  })],
  [contestedOther.id, account(contestedOther.id, {
    webAuthnCredentials: [stored(contestedOther.key, now)],
    didKeys: [{ did: owner.didWeb.did, publicKeyMultibase: contestedOther.didWebKey.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: now }],
  })],
  [walletUser(linked), account(walletUser(linked), { walletAddresses: [linked.address.toLowerCase()] })],
  [walletUser(returning), account(walletUser(returning), { walletAddresses: [returning.address.toLowerCase()] })],
  [walletUser(returningExisting), account(walletUser(returningExisting), { walletAddresses: [returningExisting.address.toLowerCase()] })],
  [walletUser(adder), account(walletUser(adder), { walletAddresses: [adder.address.toLowerCase()] })],
  [derivedOwner.userId, account(derivedOwner.userId, { webAuthnCredentials: [stored(derivedOwner, earlier)] })],
  [copyHolder, account(copyHolder, { webAuthnCredentials: [stored(derivedOwner, now)] })],
]);
const listed = new Set([ownerId, contestedOther.id, walletUser(linked), walletUser(adder), derivedOwner.userId, copyHolder]);
const unreadable = new Set([ownerId, derivedOwner.userId]);
const writes: string[] = [];
const reads: string[] = [];
const snapshot = (userId: string) => JSON.stringify(pods.get(userId) ?? null);

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...listed].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET') reads.push(m[1]!);
  if (m && unreadable.has(m[1]!)) { res.writeHead(502).end(); return; }
  if (m && req.method === 'GET') {
    const doc = pods.get(m[1]!);
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
      writes.push(userId);
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

// Each test arrives from its own address (the server trusts one proxy hop), so the per-IP
// auth-enroll budget (30 a minute) is not shared across the whole file.
let clientAddr = 0;
beforeEach(() => { clientAddr++; });
async function post(path: string, body: unknown, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${clientAddr}`, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

async function siwe(w: { address: string; signMessage(message: string): Promise<string> }, extra: Record<string, unknown> = {}) {
  const { nonce } = (await post('/challenges', { purpose: 'siwe' })).json as { nonce: string };
  const message = `${new URL(base).host} wants you to sign in with your Ethereum account:\n${w.address}\n\nSign in.\n\n`
    + `URI: ${base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'New', ...extra });
}

async function didSignIn(k: { did: string; privateKey: crypto.KeyObject }, extra: Record<string, unknown> = {}, bearer?: string) {
  const { nonce, message } = (await post('/challenges', { purpose: 'did-sig' })).json as { nonce: string; message?: unknown };
  // As every DID client signs: the challenge's `message` when the server returns one, else the nonce.
  const signed = typeof message === 'string' ? message : nonce;
  const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), k.privateKey).toString('base64url');
  return post('/auth/did', { did: k.did, nonce, signature, name: 'New', ...extra }, bearer);
}

function registerOptions(opts: { bearer?: string; bootstrap?: { userId: string; token: string } } = {}) {
  const extra = opts.bootstrap ? { bootstrapUserId: opts.bootstrap.userId, bootstrapInvite: opts.bootstrap.token } : {};
  return post('/auth/webauthn/register-options', { name: 'New', ...extra }, opts.bearer);
}
/**
 * A fresh registration with a challenge from POST /challenges, which a client can take without
 * the options: /register refuses it on its own.
 */
async function registerWithoutOptions(key: SoftPasskey) {
  const ch = await post('/challenges', { purpose: 'webauthn-register' });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  return post('/auth/webauthn/register', { response: attest(key, String(ch.json['nonce']), base, new URL(base).hostname) });
}

let signCount = 0;
async function signIn(key: SoftPasskey, userId?: string) {
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate', ...(userId ? { userId } : {}) });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const rpId = String(ch.json['rpId'] ?? new URL(base).hostname);
  return post('/auth/webauthn/authenticate', { response: assertion(key, String(ch.json['nonce']), base, rpId, ++signCount) });
}

/** The 503 every refusal here answers with: nothing issued. */
function assertStillLoading(r: { status: number; json: Record<string, unknown> }): void {
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['error'], 'Interego is still loading accounts');
  assert.match(String(r.json['detail']), /Nothing was changed/);
  assert.equal(r.json['token'], undefined);
  assert.equal(r.json['userId'], undefined);
}
const writesTo = (userId: string) => writes.filter(w => w === userId).length;
const readsOf = (userId: string) => reads.filter(r => r === userId).length;

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
    BOOTSTRAP_INVITES: Object.values(invites).map(i => `${i.userId}:${i.token}`).join(','),
  });
  identity = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  identity.stdout!.on('data', d => { output += String(d); });
  identity.stderr!.on('data', d => { output += String(d); });
  // The index never completes, so wait instead for the readable listed accounts to load (a
  // profile is served only for an account in memory, and asking for one loads nothing).
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (identity.exitCode !== null) throw new Error(`identity server exited ${identity.exitCode}:\n${output}`);
    try {
      const loaded = await Promise.all([contestedOther.id, walletUser(linked), walletUser(adder), copyHolder]
        .map(async id => (await fetch(`${base}/users/${id}/profile`)).status === 200));
      if (loaded.every(Boolean)) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const health = await (await fetch(`${base}/health`)).json() as { accountIndex: { complete: boolean } };
  assert.equal(health.accountIndex.complete, false);
});

after(async () => {
  await stopChild(identity);
  await closeServer(podServer);
});

test('while accounts are loading, a wallet whose only holder is not loaded opens no account of its own', async () => {
  // Its account is the unloaded one, so the account derived from the wallet would have been
  // created, and then kept the wallet's sign-ins once the owner's account loaded.
  const r = await siwe(owner.wallet);
  assertStillLoading(r);
  assert.equal(writesTo(walletUser(owner.wallet)), 0);
  assert.equal(pods.has(walletUser(owner.wallet)), false);
  // The cost: a wallet nobody holds waits too.
  const fresh = Wallet.createRandom();
  assertStillLoading(await siwe(fresh));
  assert.equal(pods.has(walletUser(fresh)), false);
});

test('while accounts are loading, a did:key whose only holder is not loaded opens no account of its own', async () => {
  const r = await didSignIn(owner.didKey);
  assertStillLoading(r);
  assert.equal(writesTo(deriveUserIdFromDid(owner.didKey.did)), 0);
  assert.equal(pods.has(deriveUserIdFromDid(owner.didKey.did)), false);
});

test('while accounts are loading, a did:web no loaded account lists is told to wait, not that it is unregistered', async () => {
  assertStillLoading(await didSignIn(didWeb, { publicKeyMultibase: didWeb.multibase }));
  assert.equal(writesTo(deriveUserIdFromDid(didWeb.did)), 0);
});

test('while accounts are loading, a did:web whose loaded holders list other keys is told to wait, not that it is unregistered', async () => {
  // A loaded account bound the owner's did:web with a key of its own; the owner's account, which
  // lists it with the key that signs here, is the unloaded one.
  const r = await didSignIn(owner.didWeb, { publicKeyMultibase: owner.didWeb.multibase });
  assertStillLoading(r);
  assert.equal(writesTo(contestedOther.id), 0);
  assert.equal(writesTo(deriveUserIdFromDid(owner.didWeb.did)), 0);
  assert.equal(pods.has(deriveUserIdFromDid(owner.didWeb.did)), false);
  // The loaded holder still signs in with its own key.
  const own = await didSignIn({ did: owner.didWeb.did, privateKey: contestedOther.didWebKey.privateKey },
    { publicKeyMultibase: contestedOther.didWebKey.multibase });
  assert.equal(own.status, 200, `${JSON.stringify(own.json)}\n${output}`);
  assert.equal(own.json['userId'], contestedOther.id);
});

test('while accounts are loading, a did:web only an unloaded account lists is not bound to another account with its bearer', async () => {
  // Bound with a key of the caller's own, it would not take the owner's sign-ins, but once the
  // owner removed the DID (to change its key, say) the owner could never bind it again: a DID a
  // loaded account lists with another key is refused.
  const signedIn = await siwe(adder);
  assert.equal(signedIn.status, 200, `${JSON.stringify(signedIn.json)}\n${output}`);
  assert.equal(signedIn.json['userId'], walletUser(adder));
  const bearer = String(signedIn.json['token']);
  const before = snapshot(walletUser(adder));
  const ownKey = ed25519();
  const r = await didSignIn({ did: owner.soleWeb.did, privateKey: ownKey.privateKey }, { publicKeyMultibase: ownKey.multibase }, bearer);
  assertStillLoading(r);
  assert.match(String(r.json['detail']), /added to no account/);
  // The cost: a did:web nobody lists waits too.
  assertStillLoading(await didSignIn(didWeb, { publicKeyMultibase: didWeb.multibase }, bearer));
  await new Promise(resolve => setTimeout(resolve, 300));   // a deferred write would land by now
  assert.equal(snapshot(walletUser(adder)), before);
  assert.equal(writesTo(walletUser(adder)), 0);
  assert.equal(writesTo(deriveUserIdFromDid(owner.soleWeb.did)), 0);
  assert.equal(writesTo(deriveUserIdFromDid(didWeb.did)), 0);
  // A did:key is still added: only its key's holder can bind it.
  const k = ed25519();
  const added = await didSignIn({ did: `did:key:${k.multibase}`, privateKey: k.privateKey }, {}, bearer);
  assert.equal(added.status, 200, `${JSON.stringify(added.json)}\n${output}`);
  assert.equal(added.json['userId'], walletUser(adder));
});

/**
 * A spent invite is refused at registration options as consumed (409), before they are refused
 * for loading; an unspent one is told to wait, and reads no pod.
 */
async function assertInviteUnspent(invite: { userId: string; token: string }): Promise<void> {
  const before = readsOf(invite.userId);
  assertStillLoading(await registerOptions({ bootstrap: invite }));
  assert.equal(readsOf(invite.userId), before);
}

test('while accounts are loading, a wallet bootstrap claim opens nothing and keeps its invite', async () => {
  const r = await siwe(Wallet.createRandom(), { bootstrapUserId: invites.wallet.userId, bootstrapInvite: invites.wallet.token });
  assertStillLoading(r);
  // Not even the empty document a read of a missing seeded pod writes.
  assert.equal(writesTo(invites.wallet.userId), 0);
  assert.equal(pods.has(invites.wallet.userId), false);
  await assertInviteUnspent(invites.wallet);
});

test('while accounts are loading, a did:key bootstrap claim opens nothing and keeps its invite', async () => {
  const k = ed25519();
  const r = await didSignIn({ did: `did:key:${k.multibase}`, privateKey: k.privateKey },
    { bootstrapUserId: invites.did.userId, bootstrapInvite: invites.did.token });
  assertStillLoading(r);
  assert.equal(writesTo(invites.did.userId), 0);
  assert.equal(pods.has(invites.did.userId), false);
  await assertInviteUnspent(invites.did);
});

test('while accounts are loading, an account that already lists its wallet still signs in to it', async () => {
  // Not in the listing, so not loaded: the first-time path reads the derived pod and finds it.
  const r = await siwe(returning);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], walletUser(returning));
  assert.equal(writesTo(walletUser(returning)), 0);
});

test('while accounts are loading, a wallet sign-in for an existing account only is told to wait, and still finds its own account', async () => {
  // The relay's /sign-action page signs in with existingOnly, which was told the wallet was not
  // registered whenever no loaded account listed it.
  const r = await siwe(owner.wallet, { existingOnly: true });
  assertStillLoading(r);
  assert.equal(writesTo(walletUser(owner.wallet)), 0);
  assert.equal(pods.has(walletUser(owner.wallet)), false);
  const found = await siwe(returningExisting, { existingOnly: true });
  assert.equal(found.status, 200, `${JSON.stringify(found.json)}\n${output}`);
  assert.equal(found.json['userId'], walletUser(returningExisting));
  assert.equal(writesTo(walletUser(returningExisting)), 0);
});

test('while accounts are loading, an unloaded owner\'s passkey id with a copy of its key is not registered, so its sign-in finds no copy', async () => {
  // The copy's account would have been created, and the owner's usernameless sign-in would
  // have found only it, verified the owner's signature with the copied key, and signed in to it.
  // The options are refused, so the browser starts no ceremony; a challenge taken without them
  // is refused at /register.
  assertStillLoading(await registerOptions());
  const copy = { ...owner.copied };
  assertStillLoading(await registerWithoutOptions(copy));
  assert.equal(writesTo(copy.userId), 0);
  assert.equal(pods.has(copy.userId), false);
  assertStillLoading(await signIn(owner.copied));
});

test('while accounts are loading, a passkey is not added to a loaded account with its bearer', async () => {
  const opened = await siwe(linked);
  assert.equal(opened.status, 200, `${JSON.stringify(opened.json)}\n${output}`);
  assert.equal(opened.json['userId'], walletUser(linked));
  const before = snapshot(walletUser(linked));
  assertStillLoading(await registerOptions({ bearer: String(opened.json['token']) }));
  await new Promise(resolve => setTimeout(resolve, 300));   // a deferred write would land by now
  assert.equal(snapshot(walletUser(linked)), before);
  assert.equal(writesTo(walletUser(linked)), 0);
});

test('while accounts are loading, a passkey bootstrap claim starts no ceremony, touches no pod and keeps its invite', async () => {
  // The options used to read the seeded pod, which wrote it an empty document, and hand out a
  // ceremony /register then refused.
  assertStillLoading(await registerOptions({ bootstrap: invites.passkey }));
  await new Promise(resolve => setTimeout(resolve, 300));   // a deferred write would land by now
  assert.equal(readsOf(invites.passkey.userId), 0);
  assert.equal(writesTo(invites.passkey.userId), 0);
  assert.equal(pods.has(invites.passkey.userId), false);
  await assertInviteUnspent(invites.passkey);
  // A wrong invite is still refused as one, and a spent one would be 409: neither waits.
  const wrong = await registerOptions({ bootstrap: { userId: invites.passkey.userId, token: 'x'.repeat(32) } });
  assert.equal(wrong.status, 401, JSON.stringify(wrong.json));
});

test('while accounts are loading, a passkey no loaded holder verifies is told to wait, not refused', async () => {
  // A loaded account lists the owner's id with a key of its own; the owner's account is the
  // unloaded one, so "no holder verified" is not "this passkey is unknown".
  const r = await signIn(owner.contested);
  assertStillLoading(r);
  assert.equal(writesTo(contestedOther.id), 0);
  // A sign-in scoped to the loaded holder tried the account it named: a plain refusal.
  const scoped = await signIn(owner.contested, contestedOther.id);
  assert.equal(scoped.status, 401, JSON.stringify(scoped.json));
  assert.equal(scoped.json['token'], undefined);
  assert.equal(writesTo(contestedOther.id), 0);
});

test('while accounts are loading, a passkey whose derived account is unreadable does not sign in to a loaded copy of its key', async () => {
  // The owner is the account a fresh registration of the id opened; a loaded account lists the
  // id with a later copy of its key. Tried alone, the copy verified the owner's signature and
  // took the sign-in.
  const r = await signIn(derivedOwner);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
  assert.match(String(r.json['detail']), /Nothing was changed/);
  assert.equal(r.json['token'], undefined);
  assert.equal(r.json['userId'], undefined);
  await new Promise(resolve => setTimeout(resolve, 300));   // a deferred write would land by now
  assert.equal(writesTo(copyHolder), 0);
  assert.equal(writesTo(derivedOwner.userId), 0);
});

test('every DID sign-in above signed the challenge\'s message', () => {
  assert.doesNotMatch(output, /WARN identity_did_bare_nonce /);
});
