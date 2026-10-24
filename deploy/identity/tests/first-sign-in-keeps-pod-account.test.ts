/**
 * A first-time DID or wallet sign-in must not replace an account its pod already holds.
 *
 * On 2026-10-23 the startup listing stopped at a dotted file name at the pod root, so the
 * server loaded no account. Every returning DID or SIWE sign-in then took the first-time
 * branch: it derived the same userId from the credential, built an auth-methods.jsonld
 * holding that one credential, and PUT it over the pod's. The account's other wallets,
 * passkeys and DIDs, its name and its sessionEpoch were lost, and losing the epoch let
 * tokens signed out everywhere verify again.
 *
 * server.ts is started as a child process against a stand-in pod server. Its root lists
 * one ordinary account; the accounts under test are on their pods but missing from the
 * listing, so the server has not loaded them, as in the incident. An account under a
 * credential's derived id that does not hold that credential refuses it (DID, wallet and
 * passkey alike) rather than gaining it. The bearer tokens are minted here with the server's
 * TOKEN_SIGNING_KEY, in its `cg2_` format.
 *
 * Run:
 *   node --test --import tsx tests/first-sign-in-keeps-pod-account.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet, encodeBase58 } from 'ethers';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { deriveUserIdFromCredentialId, deriveUserIdFromDid, deriveUserIdFromWallet } from '../derive-userid.js';

interface DidKey { did: string; privateKey: crypto.KeyObject }

function didKey(): DidKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 32);
  return { did: `did:key:z${encodeBase58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`, privateKey };
}

const now = new Date().toISOString();
const didEntry = (did: string) => ({ did, publicKeyMultibase: `z${did.slice('did:key:z'.length)}`, keyType: 'Ed25519VerificationKey2020', createdAt: now });

const LISTED = 'u-pk-aaaaaaaaaaaa';
// Signs in with a DID; its document also holds a second DID, a wallet and a passkey.
const signer = didKey();
const otherDid = didKey();
const DID_ACCOUNT = deriveUserIdFromDid(signer.did);
// Signs in with a wallet; its document also holds another wallet and a DID.
const wallet = Wallet.createRandom();
const WALLET_ACCOUNT = deriveUserIdFromWallet(wallet.address.toLowerCase());
// Its id is derived from `stray`, but its document does not hold `stray`.
const stray = didKey();
const STRAY_ACCOUNT = deriveUserIdFromDid(stray.did);
// The same for a wallet: its u-eth- id names an account that holds another wallet.
const strayWallet = Wallet.createRandom();
const STRAY_WALLET_ACCOUNT = deriveUserIdFromWallet(strayWallet.address.toLowerCase());
// Pods that cannot be read.
const blockedDid = didKey();
const BLOCKED_DID_ACCOUNT = deriveUserIdFromDid(blockedDid.did);
const blockedWallet = Wallet.createRandom();
const BLOCKED_WALLET_ACCOUNT = deriveUserIdFromWallet(blockedWallet.address.toLowerCase());
// No pod at all.
const newcomer = didKey();
const NEW_ACCOUNT = deriveUserIdFromDid(newcomer.did);
// A passkey whose credential id derives to an account that holds a different passkey (as a
// software authenticator could choose one), and a passkey with no account.
const collidingPasskeyId = crypto.randomBytes(16).toString('base64url');
const PASSKEY_ACCOUNT = deriveUserIdFromCredentialId(collidingPasskeyId);
const freshPasskeyId = crypto.randomBytes(16).toString('base64url');

const pods = new Map<string, Record<string, unknown>>([
  [LISTED, { userId: LISTED, name: 'Listed', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [{ id: 'cred-listed', publicKey: 'AA', counter: 0, createdAt: now }] }],
  [DID_ACCOUNT, { userId: DID_ACCOUNT, name: 'Dana', sessionEpoch: 3,
    walletAddresses: ['0x2222222222222222222222222222222222222222'],
    webAuthnCredentials: [{ id: 'cred-dana', publicKey: 'AA', counter: 4, createdAt: now }],
    didKeys: [didEntry(signer.did), didEntry(otherDid.did)] }],
  [WALLET_ACCOUNT, { userId: WALLET_ACCOUNT, name: 'Wren', sessionEpoch: 3,
    walletAddresses: [wallet.address.toLowerCase(), '0x3333333333333333333333333333333333333333'],
    webAuthnCredentials: [], didKeys: [didEntry(otherDid.did)] }],
  [STRAY_ACCOUNT, { userId: STRAY_ACCOUNT, name: 'Stella', sessionEpoch: 5,
    walletAddresses: ['0x4444444444444444444444444444444444444444'], webAuthnCredentials: [],
    didKeys: [didEntry(otherDid.did)] }],
  [BLOCKED_DID_ACCOUNT, { userId: BLOCKED_DID_ACCOUNT, name: 'Blake', sessionEpoch: 3,
    walletAddresses: [], webAuthnCredentials: [], didKeys: [didEntry(blockedDid.did), didEntry(otherDid.did)] }],
  [BLOCKED_WALLET_ACCOUNT, { userId: BLOCKED_WALLET_ACCOUNT, name: 'Bea', sessionEpoch: 3,
    walletAddresses: [blockedWallet.address.toLowerCase()], webAuthnCredentials: [], didKeys: [didEntry(otherDid.did)] }],
  [STRAY_WALLET_ACCOUNT, { userId: STRAY_WALLET_ACCOUNT, name: 'Sam', sessionEpoch: 1,
    walletAddresses: ['0x5555555555555555555555555555555555555555'], webAuthnCredentials: [], didKeys: [] }],
  [PASSKEY_ACCOUNT, { userId: PASSKEY_ACCOUNT, name: 'Pat', sessionEpoch: 2, walletAddresses: [], didKeys: [],
    webAuthnCredentials: [{ id: 'cred-pat', publicKey: 'AA', counter: 9, createdAt: now }] }],
]);
const seeded = new Map([...pods].map(([id, doc]) => [id, structuredClone(doc)]));
// The root lists only LISTED, so the server loads no other account at startup.
const listed = [LISTED];
const unreadable = new Set([BLOCKED_DID_ACCOUNT, BLOCKED_WALLET_ACCOUNT]);
// Every write the server makes, as `<METHOD> <path>`.
const writes: string[] = [];

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') writes.push(`${req.method} ${path}`);
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(req.method === 'HEAD' ? undefined
      : `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${listed.map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET') {
    if (unreadable.has(m[1]!)) { res.writeHead(500).end(); return; }
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

const signingKey = crypto.randomBytes(32);
let podServer: http.Server;
let identity: ChildProcess;
let base = '';
let output = '';

/** A token as issueToken signs it, under the given sessionEpoch. */
function token(userId: string, agentId: string, epoch: number): string {
  const b64 = Buffer.from(JSON.stringify({
    userId, agentId, scope: 'ReadWrite', issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), epoch,
  }), 'utf8').toString('base64url');
  return `cg2_${b64}.${crypto.createHmac('sha256', signingKey).update(b64).digest('base64url')}`;
}

async function get(path: string): Promise<Record<string, unknown>> {
  return await (await fetch(`${base}${path}`)).json() as Record<string, unknown>;
}

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

async function nonce(purpose: 'did-sig' | 'siwe'): Promise<string> {
  const ch = await post('/challenges', { purpose });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  return ch.json['nonce'] as string;
}

async function signInWithDid(key: DidKey) {
  const n = await nonce('did-sig');
  const signature = crypto.sign(null, Buffer.from(n, 'utf8'), key.privateKey).toString('base64url');
  // A first-time sign-in may name itself; an account already on file keeps its own name.
  return post('/auth/did', { did: key.did, nonce: n, signature, name: 'Someone else' });
}

async function signInWithWallet(w: Pick<Wallet, 'address' | 'signMessage'>) {
  const n = await nonce('siwe');
  const message = [
    '127.0.0.1 wants you to sign in with your Ethereum account:', w.address, '',
    'Sign in to Interego.', '', `URI: ${base}`, 'Version: 1', 'Chain ID: 1', `Nonce: ${n}`, `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce: n, name: 'Someone else' });
}

/**
 * A passkey registration as a software authenticator makes it: "none" attestation, an ES256
 * key, user present and verified, and a credential id the caller chooses.
 */
async function registerPasskey(credentialId: string) {
  const options = await post('/auth/webauthn/register-options', { name: 'Someone else' });
  assert.equal(options.status, 200, JSON.stringify(options.json));
  const challenge = options.json['challenge'] as string;
  const rpId = (options.json['rp'] as { id: string }).id;
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coseKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  const id = Buffer.from(credentialId, 'base64url');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(id.length);
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
    length, id, Buffer.from(coseKey),
  ]);
  const attestationObject = isoCBOR.encode(new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)],
  ]));
  const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin: base, crossOrigin: false });
  return post('/auth/webauthn/register', { response: {
    id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(clientDataJSON).toString('base64url'),
      attestationObject: Buffer.from(attestationObject).toString('base64url'),
      transports: ['internal'],
    },
  } });
}

const writesTo = (userId: string) => writes.filter(w => w.split(' ')[1]!.startsWith(`/${userId}/`));

/** Long enough for a write the server deferred past its response to reach the pod. */
const settle = () => new Promise(resolve => setTimeout(resolve, 500));

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
    TOKEN_SIGNING_KEY: signingKey.toString('base64'), ALLOW_OPEN_INTROSPECTION: '1', JANITOR_INTERVAL_MS: '0',
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
      const health = await get('/health');
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

test('the server starts knowing only the listed account', async () => {
  assert.equal((await get('/health'))['users'], 1);
  assert.deepEqual(writes, []);
});

test('a DID sign-in to an account the index missed leaves its auth-methods.jsonld whole', async () => {
  const r = await signInWithDid(signer);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], DID_ACCOUNT);
  assert.equal(r.json['name'], 'Dana');
  assert.deepEqual(r.json['authMethods'], { wallets: 1, webauthn: 1, dids: 2 });
  await settle();
  assert.deepEqual(writesTo(DID_ACCOUNT), []);
  const stored = pods.get(DID_ACCOUNT)!;
  assert.deepEqual(stored, seeded.get(DID_ACCOUNT));
  assert.deepEqual((stored['didKeys'] as Array<{ did: string }>).map(k => k.did), [signer.did, otherDid.did]);
  assert.deepEqual(stored['walletAddresses'], ['0x2222222222222222222222222222222222222222']);
  assert.equal(stored['sessionEpoch'], 3);
  // The token it was given carries the account's epoch, so it verifies.
  const verified = await post('/tokens/verify', { token: r.json['token'] });
  assert.equal(verified.json['valid'], true, JSON.stringify(verified.json));
});

test('a token issued before the account signed out everywhere is still refused', async () => {
  const r = await post('/tokens/verify', { token: token(DID_ACCOUNT, `mcp-client-${DID_ACCOUNT}`, 2) });
  assert.equal(r.json['valid'], false, JSON.stringify(r.json));
  assert.match(String(r.json['reason']), /revoked/);
});

test('a wallet sign-in to an account the index missed leaves its auth-methods.jsonld whole', async () => {
  const r = await signInWithWallet(wallet);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], WALLET_ACCOUNT);
  assert.equal(r.json['name'], 'Wren');
  await settle();
  assert.deepEqual(writesTo(WALLET_ACCOUNT), []);
  assert.deepEqual(pods.get(WALLET_ACCOUNT), seeded.get(WALLET_ACCOUNT));
  const stale = await post('/tokens/verify', { token: token(WALLET_ACCOUNT, `mcp-client-${WALLET_ACCOUNT}`, 2) });
  assert.equal(stale.json['valid'], false, JSON.stringify(stale.json));
  assert.match(String(stale.json['reason']), /revoked/);
});

test('an account whose document lacks the DID its id derives from refuses that DID and is left alone', async () => {
  // Twice: first while the account is only on its pod, then once that first try has loaded it.
  for (const attempt of ['on the pod', 'in memory']) {
    const r = await signInWithDid(stray);
    assert.equal(r.status, 409, `${attempt}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json['token'], undefined, attempt);
    await settle();
    assert.deepEqual(writesTo(STRAY_ACCOUNT), [], attempt);
    assert.deepEqual(pods.get(STRAY_ACCOUNT), seeded.get(STRAY_ACCOUNT), attempt);
  }
  // The DID was not added: the account's own credentials are still all it has.
  const stale = await post('/tokens/verify', { token: token(STRAY_ACCOUNT, `mcp-client-${STRAY_ACCOUNT}`, 4) });
  assert.equal(stale.json['valid'], false, JSON.stringify(stale.json));
});

test('an account whose document lacks the wallet its id derives from refuses that wallet and is left alone', async () => {
  const r = await signInWithWallet(strayWallet);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.equal(r.json['token'], undefined);
  await settle();
  assert.deepEqual(writesTo(STRAY_WALLET_ACCOUNT), []);
  assert.deepEqual(pods.get(STRAY_WALLET_ACCOUNT), seeded.get(STRAY_WALLET_ACCOUNT));
});

test('a passkey whose credential id derives to an existing account is refused, and a new one still registers', async () => {
  const refused = await registerPasskey(collidingPasskeyId);
  assert.equal(refused.status, 409, `${JSON.stringify(refused.json)}\n${output}`);
  assert.equal(refused.json['token'], undefined);
  await settle();
  assert.deepEqual(writesTo(PASSKEY_ACCOUNT), []);
  assert.deepEqual(pods.get(PASSKEY_ACCOUNT), seeded.get(PASSKEY_ACCOUNT));

  const fresh = await registerPasskey(freshPasskeyId);
  assert.equal(fresh.status, 200, `${JSON.stringify(fresh.json)}\n${output}`);
  const freshAccount = deriveUserIdFromCredentialId(freshPasskeyId);
  assert.equal(fresh.json['userId'], freshAccount);
  await until(() => ((pods.get(freshAccount)?.['webAuthnCredentials'] as unknown[] | undefined) ?? []).length > 0, 'the new passkey to be written');
  assert.deepEqual((pods.get(freshAccount)!['webAuthnCredentials'] as Array<{ id: string }>).map(c => c.id), [freshPasskeyId]);
});

test('a pod that cannot be read gets a 503 and no write, and the account signs in once it can be read', async () => {
  const users = (await get('/health'))['users'];
  const did = await signInWithDid(blockedDid);
  assert.equal(did.status, 503, JSON.stringify(did.json));
  assert.equal(did.json['token'], undefined);
  const siwe = await signInWithWallet(blockedWallet);
  assert.equal(siwe.status, 503, JSON.stringify(siwe.json));
  assert.equal(siwe.json['token'], undefined);
  await settle();
  assert.deepEqual(writesTo(BLOCKED_DID_ACCOUNT), []);
  assert.deepEqual(writesTo(BLOCKED_WALLET_ACCOUNT), []);
  assert.equal((await get('/health'))['users'], users);

  unreadable.clear();
  const again = await signInWithDid(blockedDid);
  assert.equal(again.status, 200, `${JSON.stringify(again.json)}\n${output}`);
  assert.equal(again.json['userId'], BLOCKED_DID_ACCOUNT);
  assert.equal(again.json['name'], 'Blake');
  const siweAgain = await signInWithWallet(blockedWallet);
  assert.equal(siweAgain.status, 200, `${JSON.stringify(siweAgain.json)}\n${output}`);
  assert.equal(siweAgain.json['userId'], BLOCKED_WALLET_ACCOUNT);
  await settle();
  assert.deepEqual(writesTo(BLOCKED_DID_ACCOUNT), []);
  assert.deepEqual(writesTo(BLOCKED_WALLET_ACCOUNT), []);
  assert.deepEqual(pods.get(BLOCKED_DID_ACCOUNT), seeded.get(BLOCKED_DID_ACCOUNT));
  assert.deepEqual(pods.get(BLOCKED_WALLET_ACCOUNT), seeded.get(BLOCKED_WALLET_ACCOUNT));
});

test('a DID with no account on any pod still registers a new one', async () => {
  const r = await signInWithDid(newcomer);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], NEW_ACCOUNT);
  assert.equal(r.json['name'], 'Someone else');
  await until(() => pods.has(NEW_ACCOUNT), 'the new account to be written');
  const stored = pods.get(NEW_ACCOUNT)!;
  assert.deepEqual((stored['didKeys'] as Array<{ did: string }>).map(k => k.did), [newcomer.did]);
  assert.deepEqual(stored['walletAddresses'], []);
  assert.equal(stored['sessionEpoch'], undefined);
});
