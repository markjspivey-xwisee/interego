/**
 * POST /auth/did for a DID that is not a did:key, through the route: server.ts is started as
 * a child process against a stand-in pod server (no live pod).
 *
 * A did:key carries its public key, so the signature proves control of the DID. Any other DID
 * (did:web, ...) is verified against a key the caller sends in `publicKeyMultibase`, so the
 * signature proves only that the caller holds THAT key. The route used to look the account up
 * by the DID string alone and issue its token, so anyone could sign in to a registered did:web
 * account with a key of their own; it cached that caller-supplied key by DID and applied it to
 * the next caller's request; and it let anyone open an account for a did:web nobody had
 * registered. Here a did:web signs in only with a key its account lists for it, keys are never
 * shared between requests, and a did:web cannot open an account on its own.
 *
 * Run:
 *   node --test --import tsx tests/did-key-binding-routes.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { deriveUserIdFromDid } from '../derive-userid.js';

const now = new Date().toISOString();

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
  return {
    multibase: `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`,
    // The server's original encoding, still accepted (and still on pods).
    legacy: `z${raw.toString('base64url')}`,
    privateKey,
  };
}
type Key = ReturnType<typeof ed25519>;
const didKey = () => { const k = ed25519(); return { did: `did:key:${k.multibase}`, ...k }; };
const didKeyEntry = (did: string, publicKeyMultibase: string) =>
  ({ did, publicKeyMultibase, keyType: 'Ed25519VerificationKey2020', createdAt: now });

// ── Credentials ──
const victim = { did: 'did:web:victim.example', owner: ed25519() };
const legacyStored = { did: 'did:web:legacy-stored.example', owner: ed25519() };   // pod holds the base64url form
const legacySent = { did: 'did:web:legacy-sent.example', owner: ed25519() };       // pod holds base58btc, caller sends base64url
const unindexed = { did: 'did:web:unindexed.example', owner: ed25519() };          // on its pod, not in the root listing
const attacker = ed25519();
const returningDidKey = didKey();
const freshDidKey = didKey();
const adder = didKey();                                                              // signs in, then adds a did:web from there
const added = { did: 'did:web:added.example', owner: ed25519() };

const user = (did: string) => deriveUserIdFromDid(did);
const account = (did: string, keys: Array<ReturnType<typeof didKeyEntry>>) =>
  [user(did), { userId: user(did), name: did, walletAddresses: [], webAuthnCredentials: [], didKeys: keys }] as const;

// ── Pods ──
const pods = new Map<string, Record<string, unknown>>([
  account(victim.did, [didKeyEntry(victim.did, victim.owner.multibase)]),
  account(legacyStored.did, [didKeyEntry(legacyStored.did, legacyStored.owner.legacy)]),
  account(legacySent.did, [didKeyEntry(legacySent.did, legacySent.owner.multibase)]),
  account(unindexed.did, [didKeyEntry(unindexed.did, unindexed.owner.multibase)]),
  account(returningDidKey.did, [didKeyEntry(returningDidKey.did, returningDidKey.multibase)]),
]);
// Only these are in the root listing, so only these are in the DID index at startup.
const listed = new Set([victim.did, legacyStored.did, legacySent.did, returningDidKey.did].map(user));
const writes: string[] = [];
const snapshot = (did: string) => JSON.stringify(pods.get(user(did)) ?? null);

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...listed].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET') {
    const doc = pods.get(m[1]!);
    if (!doc) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify(doc));
    return;
  }
  if (m && req.method === 'PUT') {
    const userId = m[1]!;
    const ifNoneMatch = req.headers['if-none-match'];
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

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

/** Sign a fresh challenge with `signer` and present it for `did`, sending `publicKeyMultibase` when given. */
async function signIn(did: string, signer: Pick<Key, 'privateKey'>, publicKeyMultibase?: string, headers: Record<string, string> = {}) {
  const { nonce } = (await post('/challenges', { purpose: 'did-sig' })).json as { nonce: string };
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), signer.privateKey).toString('base64url');
  return post('/auth/did', { did, nonce, signature, name: 'New', ...(publicKeyMultibase ? { publicKeyMultibase } : {}) }, headers);
}

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

test('a registered did:web refuses a key its account does not list, issues nothing and writes nothing', async () => {
  const before = snapshot(victim.did);
  const r = await signIn(victim.did, attacker, attacker.multibase);
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.match(String(r.json['error']), /Sign in with an existing credential/);
  assert.equal(r.json['token'], undefined);
  assert.equal(r.json['userId'], undefined);
  assert.deepEqual(writes, []);
  assert.equal(snapshot(victim.did), before);
});

test('the owner\'s key signs in to that account, also right after a stranger\'s attempt with the same DID', async () => {
  // The stranger's key used to be cached under the DID for 60 s and applied to this request.
  assert.equal((await signIn(victim.did, attacker, attacker.multibase)).status, 401);
  const r = await signIn(victim.did, victim.owner, victim.owner.multibase);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], user(victim.did));
  assert.equal(typeof r.json['token'], 'string');
  assert.deepEqual(writes, []);
});

test('a request is verified against the key it sends, never one an earlier request sent for that DID', async () => {
  assert.equal((await signIn(victim.did, victim.owner, victim.owner.multibase)).status, 200);
  // Signed by the owner's key but naming no usable key: an earlier request's key must not stand in.
  const r = await signIn(victim.did, victim.owner, 'z0OIl');
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json['token'], undefined);
});

test('the same key matches in the legacy base64url form and the base58btc form, either way round', async () => {
  const stored = await signIn(legacyStored.did, legacyStored.owner, legacyStored.owner.multibase);
  assert.equal(stored.status, 200, `${JSON.stringify(stored.json)}\n${output}`);
  assert.equal(stored.json['userId'], user(legacyStored.did));
  const sent = await signIn(legacySent.did, legacySent.owner, legacySent.owner.legacy);
  assert.equal(sent.status, 200, `${JSON.stringify(sent.json)}\n${output}`);
  assert.equal(sent.json['userId'], user(legacySent.did));
  // A different key in the legacy form is still a different key.
  assert.equal((await signIn(legacyStored.did, attacker, attacker.legacy)).status, 401);
  assert.deepEqual(writes, []);
});

test('a did:web cannot open an account by itself; one its pod lists still signs in when the index missed it', async () => {
  for (const did of ['did:web:unclaimed.example', 'did:key:Xnot-content-addressed']) {
    const r = await signIn(did, attacker, attacker.multibase);
    assert.equal(r.status, 401, `${did}: ${JSON.stringify(r.json)}`);
    assert.match(String(r.json['error']), /only a did:key can open an account by itself/);
    assert.equal(r.json['token'], undefined);
    assert.equal(pods.has(user(did)), false);
  }
  const impostor = await signIn(unindexed.did, attacker, attacker.multibase);
  assert.equal(impostor.status, 401, JSON.stringify(impostor.json));
  const owner = await signIn(unindexed.did, unindexed.owner, unindexed.owner.multibase);
  assert.equal(owner.status, 200, `${JSON.stringify(owner.json)}\n${output}`);
  assert.equal(owner.json['userId'], user(unindexed.did));
  assert.deepEqual(writes, []);
});

test('a signed-in account can add a did:web, which then signs in with that key only', async () => {
  const first = await signIn(adder.did, adder);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const r = await signIn(added.did, added.owner, added.owner.multibase, { Authorization: `Bearer ${String(first.json['token'])}` });
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], user(adder.did));
  // The enrollment is written to the pod after the response.
  const dids = () => (pods.get(user(adder.did))!['didKeys'] as Array<{ did: string }>).map(k => k.did);
  for (let i = 0; i < 100 && dids().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(dids(), [adder.did, added.did]);
  const back = await signIn(added.did, added.owner, added.owner.multibase);
  assert.equal(back.status, 200, JSON.stringify(back.json));
  assert.equal(back.json['userId'], user(adder.did));
  assert.equal((await signIn(added.did, attacker, attacker.multibase)).status, 401);
  writes.length = 0;
});

test('did:key is unchanged: a returning did:key signs in, a new one opens its account once', async () => {
  const returning = await signIn(returningDidKey.did, returningDidKey);
  assert.equal(returning.status, 200, JSON.stringify(returning.json));
  assert.equal(returning.json['userId'], user(returningDidKey.did));
  // A did:key's key is the DID itself; a publicKeyMultibase alongside it is ignored.
  assert.equal((await signIn(returningDidKey.did, returningDidKey, attacker.multibase)).status, 200);
  assert.equal((await signIn(returningDidKey.did, attacker)).status, 401);
  assert.deepEqual(writes, []);

  const created = await signIn(freshDidKey.did, freshDidKey);
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.equal(created.json['userId'], user(freshDidKey.did));
  assert.deepEqual(writes, [user(freshDidKey.did)]);
  assert.equal((await signIn(freshDidKey.did, freshDidKey)).status, 200);
  assert.deepEqual(writes, [user(freshDidKey.did)]);
});
