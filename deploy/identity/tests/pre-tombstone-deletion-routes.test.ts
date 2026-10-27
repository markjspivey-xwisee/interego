/**
 * Accounts deleted before deletions left a tombstone, through the routes: server.ts is started
 * as a child process against a stand-in pod server that models containers and the files a pod
 * keeps (no live pod).
 *
 * Until 2026-10-26 POST /users/me/delete removed auth-methods.jsonld and <pod>/agents and kept
 * every other file: the container, the relay's profile/card, the descriptors and the
 * .well-known/context-graphs manifest, the inbox. Such a pod has no tombstone, so a first
 * sign-in that derived the same id again created the account over it and inherited all of
 * that. A derived id whose pod looks deleted is now refused (409) and given its tombstone; a
 * brand-new account pays one HEAD, a live account is never probed, a seeded id claimed with
 * its invite is not probed, and a pod that cannot be read is 503 with nothing written. For a
 * wallet or did:key pod only the relay's card counts: a manifest or descriptors a bridge
 * published into the signer's pod, with no account here, do not lock that signer out.
 *
 * Run:
 *   node --test --import tsx tests/pre-tombstone-deletion-routes.test.ts
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
import { attest, softPasskey, type SoftPasskey } from './soft-authenticator.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function ed25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const bytes = Buffer.concat([Buffer.from([0xed, 0x01]), Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url')]);
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return { multibase: `z${out}`, privateKey };
}
function didKey() {
  const { multibase, privateKey } = ed25519();
  return { did: `did:key:${multibase}`, privateKey };
}
const walletUser = (w: { address: string }) => deriveUserIdFromWallet(w.address.toLowerCase());

const invite = { userId: 'seeded-alias', token: crypto.randomBytes(16).toString('hex') };
const tokenSigningKey = crypto.randomBytes(32).toString('base64');

// ── A pod store: auth-methods documents, other files, containers ──
const docs = new Map<string, Record<string, unknown>>();
const files = new Set<string>();        // '/<pod>/profile/card', '/<pod>/agents', ...
const containers = new Set<string>();   // pods whose container exists
const failing = new Set<string>();      // paths whose HEAD or GET answers 502
const requests: Array<{ method: string; path: string }> = [];

function podOf(path: string): string | null { return /^\/([^/]+)\//.exec(path)?.[1] ?? null; }
function exists(path: string): boolean {
  const pod = podOf(path);
  if (!pod) return false;
  if (path === `/${pod}/`) return containers.has(pod) || docs.has(pod) || [...files].some(f => f.startsWith(path));
  if (path.endsWith('/')) return [...files].some(f => f.startsWith(path));
  return files.has(path);
}

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  requests.push({ method: req.method ?? '', path });
  if (path === '/') {
    const pods = new Set([...containers, ...docs.keys(), ...[...files].map(f => podOf(f)!)]);
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...pods].map(p => `<${p}/>`).join(', ') || '<>'} .\n`);
    return;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && failing.has(path)) { res.writeHead(502).end(); return; }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m) {
    const userId = m[1]!;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const doc = docs.get(userId);
      if (!doc) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/ld+json' });
      res.end(req.method === 'GET' ? JSON.stringify(doc) : undefined);
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', d => { body += String(d); });
      req.on('end', () => {
        if (req.headers['if-none-match'] === '*' && docs.has(userId)) { res.writeHead(412).end(); return; }
        docs.set(userId, JSON.parse(body) as Record<string, unknown>);
        containers.add(userId);
        res.writeHead(201).end();
      });
      return;
    }
  }
  if (req.method === 'HEAD' || req.method === 'GET') {
    res.writeHead(exists(path) ? 200 : 404).end();
    return;
  }
  if (req.method === 'PUT') {
    const pod = podOf(path);
    if (pod) { containers.add(pod); if (!path.endsWith('/')) files.add(path); }
    res.writeHead(205).end();
    return;
  }
  if (req.method === 'DELETE') { files.delete(path); res.writeHead(205).end(); return; }
  res.writeHead(404).end();
}

/** What a pod looked like after a deletion before 2026-10-26: the relay's files kept, agents gone. */
function deletedBeforeTombstones(pod: string, extra: { agents?: boolean; doc?: Record<string, unknown> } = {}): void {
  containers.add(pod);
  for (const f of ['profile/card', '.well-known/context-graphs', 'context-graphs/urn-iep-pod-bootstrap.ttl', 'inbox/old.jsonld', '.acl']) {
    files.add(`/${pod}/${f}`);
  }
  if (extra.agents) files.add(`/${pod}/agents`);
  if (extra.doc) docs.set(pod, extra.doc);
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

async function startIdentity(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS',
    'RELAY_PUBLIC_URL', 'SIWE_DOMAINS', 'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_ORIGIN', 'WEBAUTHN_RP_ORIGINS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: tokenSigningKey, JANITOR_INTERVAL_MS: '0', BOOTSTRAP_INVITES: `${invite.userId}:${invite.token}`,
  });
  output = '';
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
  if (!identity || identity.exitCode !== null) return;
  const exited = new Promise(resolve => identity.once('exit', resolve));
  identity.kill('SIGTERM');
  await exited;
}

// Each test arrives from its own address (the server trusts one proxy hop), so the per-IP
// auth-enroll budget (30 a minute) is not shared across the whole file.
let clientAddr = 0;
beforeEach(() => { clientAddr++; });
async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${clientAddr}` }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}
async function register(key: SoftPasskey) {
  const options = await post('/auth/webauthn/register-options', { name: 'Someone' });
  assert.equal(options.status, 200, JSON.stringify(options.json));
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), base, rpId) });
}
async function siwe(w: { address: string; signMessage(message: string): Promise<string> }, extra: Record<string, unknown> = {}) {
  const { nonce } = (await post('/challenges', { purpose: 'siwe' })).json as { nonce: string };
  const message = `${new URL(base).host} wants you to sign in with your Ethereum account:\n${w.address}\n\nSign in.\n\n`
    + `URI: ${base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'Someone', ...extra });
}
async function didSignIn(k: { did: string; privateKey: crypto.KeyObject }, extra: Record<string, unknown> = {}) {
  const { nonce } = (await post('/challenges', { purpose: 'did-sig' })).json as { nonce: string };
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), k.privateKey).toString('base64url');
  return post('/auth/did', { did: k.did, nonce, signature, name: 'Someone', ...extra });
}
/** HEAD requests on `pod`'s resources since request number `since`. */
const probesOf = (pod: string, since = 0) => requests.slice(since).filter(r => r.method === 'HEAD' && r.path.startsWith(`/${pod}/`)).map(r => r.path);
const authWritesOf = (pod: string, since = 0) => requests.slice(since).filter(r => r.method === 'PUT' && r.path === `/${pod}/auth-methods.jsonld`).length;
const isTombstone = (pod: string) => {
  const doc = docs.get(pod);
  return typeof doc?.['deletedAt'] === 'string'
    && (doc['webAuthnCredentials'] as unknown[]).length === 0
    && (doc['walletAddresses'] as unknown[]).length === 0
    && (doc['didKeys'] as unknown[]).length === 0;
};
const DELETED = /This account was deleted/;

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  podPort = (podServer.address() as net.AddressInfo).port;
  await startIdentity();
});
after(async () => {
  await stopIdentity();
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

const oldPasskey = softPasskey();
test('u-pk: a pod deleted before tombstones is refused, tombstoned and logged; the next try reads the tombstone and probes nothing', async () => {
  deletedBeforeTombstones(oldPasskey.userId);
  const r = await register(softPasskey(oldPasskey.rawId));
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}\n${output}`);
  assert.match(String(r.json['error']), DELETED);
  assert.equal(r.json['token'], undefined);
  assert.ok(isTombstone(oldPasskey.userId), JSON.stringify(docs.get(oldPasskey.userId)));
  assert.equal(docs.get(oldPasskey.userId)!['sessionEpoch'], 1);
  assert.match(output, new RegExp(`WARN identity_deleted_before_tombstone userId=${oldPasskey.userId} evidence=container`));
  const since = requests.length;
  const again = await register(softPasskey(oldPasskey.rawId));
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.deepEqual(probesOf(oldPasskey.userId, since), [], 'the tombstone answers; nothing is probed');
  assert.equal(authWritesOf(oldPasskey.userId, since), 0);
});

test('u-pk: a container holding only a record without credentials is refused too, its epoch kept above the old one', async () => {
  const k = softPasskey();
  containers.add(k.userId);
  docs.set(k.userId, { userId: k.userId, name: k.userId, walletAddresses: [], webAuthnCredentials: [], didKeys: [], sessionEpoch: 2 });
  const r = await register(k);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(isTombstone(k.userId));
  assert.equal(docs.get(k.userId)!['sessionEpoch'], 3);
});

test('u-pk: a brand-new account pays one HEAD on its pod root and is created', async () => {
  const k = softPasskey();
  const since = requests.length;
  const r = await register(k);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], k.userId);
  assert.ok(r.json['token']);
  assert.deepEqual(probesOf(k.userId, since), [`/${k.userId}/`]);
});

test('u-eth: the deleted shape (relay files kept, agents gone, no record) is refused and tombstoned', async () => {
  const w = Wallet.createRandom();
  const id = walletUser(w);
  deletedBeforeTombstones(id);
  const since = requests.length;
  const r = await siwe(w);
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}\n${output}`);
  assert.match(String(r.json['error']), DELETED);
  assert.ok(isTombstone(id));
  assert.match(output, new RegExp(`WARN identity_deleted_before_tombstone userId=${id} evidence=profile/card refused=deleted`));
  // The pod root, then agents and the card: nothing else in the pod is asked about.
  assert.deepEqual(probesOf(id, since).sort(), [`/${id}/`, `/${id}/agents`, `/${id}/profile/card`]);
});

test('u-eth: the relay\'s card alone is enough', async () => {
  const w = Wallet.createRandom();
  const id = walletUser(w);
  containers.add(id);
  files.add(`/${id}/profile/card`);
  files.add(`/${id}/inbox/old.jsonld`);
  const r = await siwe(w);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(isTombstone(id));
});

// What a bridge holding the gate's write secret leaves in a signer's own pod when it publishes
// there with no identity account involved: publish() writes the manifest and the descriptor
// files, and nothing writes agents or the card. Foxxi's self-sovereign enrolment does this for
// the u-eth- spelling of a wallet's pod (foxxi/tenant-membership*); credential issuance and
// publish_ontology publish under context-graphs/.
const BRIDGE_PUBLISHED = [
  ['.well-known/context-graphs', 'foxxi/tenant-membership.ttl', 'foxxi/tenant-membership-graph.trig'],
  ['.well-known/context-graphs', 'context-graphs/credential.ttl', 'context-graphs/credential-graph.trig'],
];

test('u-eth: a pod a bridge published into, with no card and no agents, is its wallet\'s: the first sign-in opens the account', async () => {
  for (const shape of BRIDGE_PUBLISHED) {
    const w = Wallet.createRandom();
    const id = walletUser(w);
    containers.add(id);
    for (const f of shape) files.add(`/${id}/${f}`);
    const first = await siwe(w);
    assert.equal(first.status, 200, `${shape.join(' ')}: ${JSON.stringify(first.json)}\n${output}`);
    assert.equal(first.json['userId'], id);
    assert.ok(first.json['token']);
    assert.equal(isTombstone(id), false, JSON.stringify(docs.get(id)));
    assert.deepEqual(docs.get(id)!['walletAddresses'], [w.address.toLowerCase()]);
    assert.doesNotMatch(output, new RegExp(`identity_deleted_before_tombstone userId=${id}`));
    const again = await siwe(w);
    assert.equal(again.status, 200, JSON.stringify(again.json));
  }
});

test('did:key: a pod a bridge published into, with no card and no agents, is its key\'s', async () => {
  const k = didKey();
  const id = deriveUserIdFromDid(k.did);
  containers.add(id);
  for (const f of BRIDGE_PUBLISHED[1]!) files.add(`/${id}/${f}`);
  const r = await didSignIn(k);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], id);
  assert.equal(isTombstone(id), false);
});

test('u-eth: a record without credentials over the deleted shape keeps its epoch above the old one', async () => {
  const w = Wallet.createRandom();
  const id = walletUser(w);
  deletedBeforeTombstones(id, { doc: { userId: id, name: id, walletAddresses: [], webAuthnCredentials: [], didKeys: [], sessionEpoch: 4 } });
  const r = await siwe(w);
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(isTombstone(id));
  assert.equal(docs.get(id)!['sessionEpoch'], 5);
});

test('u-eth: a pod that kept its agents registry (a lost sign-in record) is its owner\'s, as before', async () => {
  const w = Wallet.createRandom();
  const id = walletUser(w);
  deletedBeforeTombstones(id, { agents: true });
  const r = await siwe(w);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], id);
  assert.deepEqual(docs.get(id)!['walletAddresses'], [w.address.toLowerCase()]);
});

test('u-eth: an inbox someone delivered to does not lock the wallet out', async () => {
  const w = Wallet.createRandom();
  const id = walletUser(w);
  containers.add(id);
  files.add(`/${id}/inbox/hello.jsonld`);
  const r = await siwe(w);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(docs.get(id)!['walletAddresses'], [w.address.toLowerCase()]);
});

test('u-eth: a probe the pod cannot answer is 503 and writes nothing', async () => {
  const w = Wallet.createRandom();
  const id = walletUser(w);
  deletedBeforeTombstones(id);
  failing.add(`/${id}/profile/card`);
  try {
    const since = requests.length;
    const r = await siwe(w);
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json['token'], undefined);
    assert.equal(docs.has(id), false);
    assert.equal(authWritesOf(id, since), 0);
  } finally {
    failing.delete(`/${id}/profile/card`);
  }
  // Once the pod answers, the same sign-in is refused as deleted.
  assert.equal((await siwe(w)).status, 409);
});

test('u-eth: two sign-ins at once on one deleted pod are both refused, and the tombstone is written once', async () => {
  const w = Wallet.createRandom();
  const id = walletUser(w);
  deletedBeforeTombstones(id);
  const since = requests.length;
  const [a, b] = await Promise.all([siwe(w), siwe(w)]);
  assert.deepEqual([a.status, b.status], [409, 409], `${JSON.stringify(a.json)} ${JSON.stringify(b.json)}`);
  assert.ok(isTombstone(id));
  assert.equal(authWritesOf(id, since), 1);
});

test('did:key: the deleted shape is refused and tombstoned', async () => {
  const k = didKey();
  const id = deriveUserIdFromDid(k.did);
  deletedBeforeTombstones(id);
  const r = await didSignIn(k);
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}\n${output}`);
  assert.ok(isTombstone(id));
});

test('did:web: a derived id that may not create an account is refused as before, and its pod is not probed', async () => {
  const key = ed25519();
  const did = `did:web:deleted-${crypto.randomBytes(4).toString('hex')}.example`;
  const id = deriveUserIdFromDid(did);
  deletedBeforeTombstones(id);
  const since = requests.length;
  const r = await didSignIn({ did, privateKey: key.privateKey }, { publicKeyMultibase: key.multibase });
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.deepEqual(probesOf(id, since), []);
  assert.equal(docs.has(id), false);
});

test('a bootstrap invite still claims a seeded pod whose files predate its credentials, unprobed', async () => {
  deletedBeforeTombstones(invite.userId);
  const w = Wallet.createRandom();
  const since = requests.length;
  const r = await siwe(w, { bootstrapUserId: invite.userId, bootstrapInvite: invite.token });
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], invite.userId);
  assert.deepEqual(probesOf(invite.userId, since), []);
  assert.deepEqual(docs.get(invite.userId)!['walletAddresses'], [w.address.toLowerCase()]);
});

test('a live account is never probed: a returning wallet the index missed, and a pod listing another credential', async () => {
  // Its record lists the wallet but the server never loaded it (written after startup).
  const w = Wallet.createRandom();
  const id = walletUser(w);
  deletedBeforeTombstones(id, { doc: { userId: id, name: 'Live', walletAddresses: [w.address.toLowerCase()], webAuthnCredentials: [], didKeys: [] } });
  let since = requests.length;
  const r = await siwe(w);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(probesOf(id, since), []);
  assert.equal(authWritesOf(id, since), 0);
  // A pod listing only a passkey: the wallet derived to it is refused as unregistered, not deleted.
  const v = Wallet.createRandom();
  const vid = walletUser(v);
  deletedBeforeTombstones(vid, { doc: { userId: vid, name: 'Passkey', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [{ id: 'cred-live', publicKey: 'AA', counter: 0, createdAt: new Date().toISOString() }] } });
  since = requests.length;
  const refused = await siwe(v);
  assert.equal(refused.status, 401, JSON.stringify(refused.json));
  assert.deepEqual(probesOf(vid, since), []);
  assert.equal(isTombstone(vid), false);
});

test('after a restart the tombstones written here still refuse, and count as pods without credentials', async () => {
  assert.ok(isTombstone(oldPasskey.userId), 'the first test left a tombstone');
  await stopIdentity();
  await startIdentity();
  const since = requests.length;
  const r = await register(softPasskey(oldPasskey.rawId));
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.match(String(r.json['error']), DELETED);
  assert.deepEqual(probesOf(oldPasskey.userId, since), []);
  assert.match(output, /Account index: \d+ loaded, \d+ without credentials/);
});
