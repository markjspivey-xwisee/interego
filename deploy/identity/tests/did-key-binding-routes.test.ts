/**
 * A DID that does not name its key (did:web, unlike did:key) signs in only with the key on file.
 *
 * POST /auth/did checks the signature against a key. A did:key carries its key; for any other
 * DID the caller sends one as `publicKeyMultibase`. The server checked the signature against
 * that key and never compared it with the key stored when the DID was added, so anyone who
 * knew such a DID could sign in as its account with a key of their own. It also cached the
 * caller's key under the DID for 60 seconds and used it for the next sign-in with that DID,
 * so one wrong key refused the DID's owner for a minute.
 *
 * server.ts is started as a child process against a stand-in pod server (no live pod).
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
import { encodeBase58 } from 'ethers';
import { deriveUserIdFromDid } from '../derive-userid.js';

interface Key { privateKey: crypto.KeyObject; raw: Buffer }

function key(): Key {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, raw: Buffer.from(spki.subarray(spki.length - 32)) };
}
/** The W3C form this server stores: 'z' + base58btc(0xed 0x01 || key). */
const multibase = (k: Key) => `z${encodeBase58(Buffer.concat([Buffer.from([0xed, 0x01]), k.raw]))}`;
/** The legacy form it once accepted and stored: 'z' + base64url(key). */
const legacyMultibase = (k: Key) => `z${k.raw.toString('base64url')}`;

const now = new Date().toISOString();
const ALICE = 'u-pk-aaaaaaaaaaaa';
const BOB = 'u-pk-bbbbbbbbbbbb';
const ALICE_DID = 'did:web:example.com:alice';
const BOB_DID = 'did:web:example.com:bob';
// Carol's account is on its pod under her DID's derived id, but not in the root listing.
const CAROL_DID = 'did:web:example.com:carol';
const CAROL = deriveUserIdFromDid(CAROL_DID);
const DAVE_DID = 'did:web:example.com:dave';
const aliceKey = key();
const bobKey = key();
const carolKey = key();
const daveKey = key();
const stranger = key();

const didEntry = (did: string, publicKeyMultibase: string) => ({ did, publicKeyMultibase, keyType: 'Ed25519VerificationKey2020', createdAt: now });
const pods = new Map<string, Record<string, unknown>>([
  [ALICE, { userId: ALICE, name: 'Alice', walletAddresses: [], didKeys: [didEntry(ALICE_DID, multibase(aliceKey))],
    webAuthnCredentials: [{ id: 'cred-alice', publicKey: 'AA', counter: 0, createdAt: now }] }],
  [BOB, { userId: BOB, name: 'Bob', walletAddresses: [], webAuthnCredentials: [], didKeys: [didEntry(BOB_DID, legacyMultibase(bobKey))] }],
  [CAROL, { userId: CAROL, name: 'Carol', walletAddresses: [], webAuthnCredentials: [], didKeys: [didEntry(CAROL_DID, multibase(carolKey))] }],
]);
const listed = [ALICE, BOB];

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(req.method === 'HEAD' ? undefined
      : `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${listed.map(p => `<${p}/>`).join(', ')} .\n`);
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
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      pods.set(m[1]!, JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
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

/** Sign in with `did`, signing with `signer` and sending `publicKeyMultibase` as its key. */
async function signIn(did: string, signer: Key, publicKeyMultibase = multibase(signer)) {
  const ch = await post('/challenges', { purpose: 'did-sig' });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const nonce = ch.json['nonce'] as string;
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), signer.privateKey).toString('base64url');
  return post('/auth/did', { did, nonce, signature, publicKeyMultibase });
}

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
    TOKEN_SIGNING_KEY: crypto.randomBytes(32).toString('base64'), ALLOW_OPEN_INTROSPECTION: '1', JANITOR_INTERVAL_MS: '0',
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
      const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      if ((health['accountIndex'] as { complete: boolean }).complete) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

after(async () => {
  identity?.kill('SIGTERM');
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

test('a did:web on an account signs in only with the key stored with it, and a wrong key does not lock its owner out', async () => {
  const forged = await signIn(ALICE_DID, stranger);
  assert.equal(forged.status, 401, JSON.stringify(forged.json));
  assert.equal(forged.json['token'], undefined);
  // Straight after the forged attempt, which the old cache would have served for 60 seconds.
  const owner = await signIn(ALICE_DID, aliceKey);
  assert.equal(owner.status, 200, `${JSON.stringify(owner.json)}\n${output}`);
  assert.equal(owner.json['userId'], ALICE);
  // The stored key is unchanged.
  assert.equal((pods.get(ALICE)!['didKeys'] as Array<{ publicKeyMultibase: string }>)[0]!.publicKeyMultibase, multibase(aliceKey));
});

test('a key stored in the legacy encoding still signs in, in either encoding, and no other key does', async () => {
  const forged = await signIn(BOB_DID, stranger, legacyMultibase(stranger));
  assert.equal(forged.status, 401, JSON.stringify(forged.json));
  for (const sent of [legacyMultibase(bobKey), multibase(bobKey)]) {
    const r = await signIn(BOB_DID, bobKey, sent);
    assert.equal(r.status, 200, `${sent}: ${JSON.stringify(r.json)}\n${output}`);
    assert.equal(r.json['userId'], BOB);
  }
});

test('an account the index missed is held to its key too', async () => {
  const forged = await signIn(CAROL_DID, stranger);
  assert.equal(forged.status, 401, JSON.stringify(forged.json));
  assert.equal(forged.json['token'], undefined);
  const owner = await signIn(CAROL_DID, carolKey);
  assert.equal(owner.status, 200, `${JSON.stringify(owner.json)}\n${output}`);
  assert.equal(owner.json['userId'], CAROL);
});

// Within a minute of a sign-in the old cache happened to refuse other keys too, so this one
// checks that registration binds the key it signed with, not the fix above.
test('a new did:web registers with the key it signed with, and from then on only that key signs in', async () => {
  const first = await signIn(DAVE_DID, daveKey);
  assert.equal(first.status, 200, `${JSON.stringify(first.json)}\n${output}`);
  const dave = deriveUserIdFromDid(DAVE_DID);
  assert.equal(first.json['userId'], dave);
  await until(() => pods.has(dave), 'the new account to be written');
  assert.deepEqual((pods.get(dave)!['didKeys'] as Array<{ did: string; publicKeyMultibase: string }>)
    .map(k => [k.did, k.publicKeyMultibase]), [[DAVE_DID, multibase(daveKey)]]);
  assert.equal((await signIn(DAVE_DID, stranger)).status, 401);
  assert.equal((await signIn(DAVE_DID, daveKey)).status, 200);
});
