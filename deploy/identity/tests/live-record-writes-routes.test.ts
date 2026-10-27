/**
 * Every write of an account's auth-methods.jsonld starts from the record as the pod holds it,
 * through the routes: server.ts is started as a child process (twice, where two instances share
 * the pods as during a deploy's overlap) against a stand-in pod server that answers like stock
 * CSS 7 (an ETag of `"<modified ms>-application/ld+json"`, If-Match and If-None-Match: * honoured
 * with 412) and lets a test hold, fail or delay its requests and edit a record out of band (the
 * other instance, an operator). Passkeys come from the software authenticator in
 * tests/soft-authenticator.ts.
 *
 * The identity server keeps a 10 s copy of each account's record. Its writers used to save a
 * record built from that copy, and some were acknowledged before the pod had them; a change that
 * reached the pod by another route within the 10 s came undone (a removed credential came back, a
 * raised session epoch dropped, a sign counter went backwards), and a write that failed left this
 * server believing in a record the pod never held. These tests make each writer meet such a
 * change, or such a failure, and check what the pod and this server hold afterwards; and they
 * check the costs (a passkey sign-in reads once and writes only what changed; readers of a stale
 * copy share one read).
 *
 * Run:
 *   node --test --import tsx tests/live-record-writes-routes.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { assertion, attest, softPasskey, type SoftPasskey } from './soft-authenticator.js';
import { deriveUserIdFromDid, deriveUserIdFromWallet } from '../derive-userid.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);
const TTL_WAIT_MS = 10_600;

// ── The stand-in pod server ─────────────────────────────────────────────────────────────────
type Doc = Record<string, unknown>;
type Logged = { method: string; userId: string; target: 'doc' | 'container'; ifMatch?: string; ifNoneMatch?: string; body?: Doc; status?: number; at: number };
const docs = new Map<string, { doc: Doc; modified: number }>();
let clock = Date.now();
const etagOf = (userId: string) => { const d = docs.get(userId); return d ? `"${d.modified}-application/ld+json"` : null; };
const unlisted = new Set<string>();
const failingGets = new Map<string, number>();
const nonJson = new Set<string>();
const putFaults = new Map<string, Array<'500' | 'apply-then-500' | 'hang'>>();
const failingDeletes = new Set<string>();
const requests: Logged[] = [];
let latencyMs = 0;
type Hold = { arrived: Promise<void>; release: () => void };
type HoldEntry = { method: string; matches: (userId: string) => boolean; arrive: (userId: string) => void; released: Promise<void>; skip: number };
const holds: HoldEntry[] = [];

/**
 * Hold the `nth` next `method` request for the auth-methods.jsonld of `userId` (or of any id it
 * matches) until released. A GET answers with the record as it was when it arrived; a PUT or a
 * DELETE checks its precondition when released. `onArrive` runs as it arrives, with the id.
 */
function hold(method: 'GET' | 'PUT' | 'DELETE', userId: string | ((id: string) => boolean), nth = 1, onArrive?: (id: string) => void): Hold {
  let arrive!: () => void; let release!: () => void;
  const arrived = new Promise<void>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const entry: HoldEntry = { method, matches: typeof userId === 'string' ? id => id === userId : userId,
    arrive: id => { onArrive?.(id); arrive(); }, released, skip: nth - 1 };
  holds.push(entry);
  return { arrived, release: () => { const i = holds.indexOf(entry); if (i >= 0) holds.splice(i, 1); release(); } };
}
function failPuts(userId: string, ...faults: Array<'500' | 'apply-then-500' | 'hang'>): void { putFaults.set(userId, faults); }
/** An edit by another writer: the other instance, or an operator. The ETag moves on. */
function outOfBand(userId: string, edit: (doc: Doc) => void): void {
  const d = docs.get(userId)!;
  edit(d.doc);
  d.modified = clock = Math.max(clock + 1, Date.now());
}
const record = (userId: string) => docs.get(userId)?.doc as unknown as PodRecord | undefined;
type PodRecord = { walletAddresses: string[]; didKeys: Array<{ did: string }>; sessionEpoch?: number; deletedAt?: string; name?: string;
  webAuthnCredentials: Array<{ id: string; counter: number; rpId?: string; rpOrigin?: string }> };
const docPuts = (userId: string, since = 0) => requests.slice(since).filter(r => r.userId === userId && r.target === 'doc' && r.method === 'PUT');
const docGets = (userId: string, since = 0) => requests.slice(since).filter(r => r.userId === userId && r.target === 'doc' && r.method === 'GET');
const containerPuts = (userId: string, since = 0) => requests.slice(since).filter(r => r.userId === userId && r.target === 'container');
const mark = () => requests.length;

async function servePods(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  if (latencyMs) await sleep(latencyMs);
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    const listed = [...docs.keys()].filter(p => !unlisted.has(p));
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${listed.map(p => `<${p}/>`).join(', ') || '<>'} .\n`);
    return;
  }
  const container = /^\/([^/]+)\/$/.exec(path);
  if (container) {
    requests.push({ method: req.method!, userId: container[1]!, target: 'container', at: Date.now() });
    res.writeHead(req.method === 'PUT' ? 201 : 404).end();
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (!m) { res.writeHead(req.method === 'GET' ? 404 : 205).end(); return; }
  const userId = m[1]!;
  const entry: Logged = { method: req.method!, userId, target: 'doc', at: Date.now(),
    ...(req.headers['if-match'] ? { ifMatch: String(req.headers['if-match']) } : {}),
    ...(req.headers['if-none-match'] ? { ifNoneMatch: String(req.headers['if-none-match']) } : {}) };
  requests.push(entry);
  const answer = (status: number, headers: Record<string, string> = {}, body = '') => { entry.status = status; res.writeHead(status, headers).end(body); };
  const snapshot = docs.get(userId) ? structuredClone(docs.get(userId)!) : undefined;
  const held = holds.find(h => h.method === req.method && h.matches(userId) && h.skip-- <= 0);
  if (held) {
    holds.splice(holds.indexOf(held), 1);
    held.arrive(userId);
    await held.released;
  }
  if (req.method === 'GET') {
    const left = failingGets.get(userId) ?? 0;
    if (left > 0) { failingGets.set(userId, left - 1); answer(502); return; }
    if (nonJson.has(userId)) { answer(200, { 'Content-Type': 'application/ld+json' }, '{ "userId": "not json'); return; }
    const at = held ? snapshot : docs.get(userId);
    if (!at) { answer(404); return; }
    answer(200, { 'Content-Type': 'application/ld+json', ETag: `"${at.modified}-application/ld+json"` }, JSON.stringify(at.doc));
    return;
  }
  if (req.method === 'PUT') {
    entry.body = JSON.parse(raw) as Doc;
    const fault = putFaults.get(userId)?.shift();
    if (fault === 'hang') return;   // never answered: the writer's own timeout must end it
    if (fault === '500') { answer(500); return; }
    if (entry.ifNoneMatch === '*' && docs.has(userId)) { answer(412); return; }
    if (entry.ifMatch && entry.ifMatch !== etagOf(userId)) { answer(412); return; }
    docs.set(userId, { doc: entry.body, modified: clock = Math.max(clock + 1, Date.now()) });
    answer(fault === 'apply-then-500' ? 500 : 201);
    return;
  }
  if (req.method === 'DELETE') {
    if (failingDeletes.has(userId)) { answer(500); return; }
    if (entry.ifMatch && entry.ifMatch !== etagOf(userId)) { answer(412); return; }
    docs.delete(userId);
    answer(205);
    return;
  }
  answer(405);
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────
const earlier = '2025-01-01T00:00:00.000Z';
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
type DidKey = ReturnType<typeof didKey>;
const didEntry = (k: DidKey, did = k.did) => ({ did, publicKeyMultibase: k.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: earlier });
const stored = (key: SoftPasskey, counter = 0, pin?: string, createdAt = earlier) => ({
  id: key.id, publicKey: key.cose.toString('base64url'), counter, transports: ['internal'], createdAt,
  ...(pin ? { rpId: '127.0.0.1', rpOrigin: pin } : {}),
});
type Seed = { keys?: SoftPasskey[]; wallets?: AnyWallet[]; dids?: DidKey[]; epoch?: number; pin?: string; counter?: number; extra?: Doc };
function seed(userId: string, s: Seed): void {
  docs.set(userId, { modified: clock = Math.max(clock + 1, Date.now()), doc: {
    userId, name: userId, walletAddresses: (s.wallets ?? []).map(w => w.address.toLowerCase()),
    webAuthnCredentials: (s.keys ?? []).map(k => stored(k, s.counter ?? 0, s.pin)), didKeys: (s.dids ?? []).map(d => didEntry(d)),
    ...(s.epoch !== undefined ? { sessionEpoch: s.epoch } : {}), ...(s.extra ?? {}),
  } });
}
/** An account derived from its first passkey (as a fresh registration opens one), listed and loaded at startup. */
function account(s: Seed & { keys: SoftPasskey[] }) {
  const userId = s.keys[0]!.userId;
  seed(userId, s);
  return { userId, ...s };
}
const P = () => softPasskey();
type AnyWallet = { address: string; signMessage(message: string): Promise<string> };
const W = (): AnyWallet => Wallet.createRandom();

// ── Identity server instances ───────────────────────────────────────────────────────────────
const tokenSigningKey = crypto.randomBytes(32).toString('base64');
const invites = { pk: { userId: 'seeded-pk', token: crypto.randomBytes(12).toString('hex') },
  claimed: { userId: 'seeded-claimed', token: crypto.randomBytes(12).toString('hex') },
  never: { userId: 'seeded-never', token: crypto.randomBytes(12).toString('hex') },
  del: { userId: 'seeded-del', token: crypto.randomBytes(12).toString('hex') } };
let podServer: http.Server;
let podPort = 0;
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
type Instance = { base: string; port: number; output: () => string; stop(): Promise<void>; ready: Promise<void> };
const instances: Instance[] = [];
async function startIdentity(port: number, env: Record<string, string> = {}, waitComplete = true): Promise<Instance> {
  const base = `http://127.0.0.1:${port}`;
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS',
    'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_ORIGIN', 'WEBAUTHN_RP_ORIGINS', 'TRY_USER_TTL_MS']) delete childEnv[k];
  Object.assign(childEnv, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: tokenSigningKey, JANITOR_INTERVAL_MS: '0', ALLOW_OPEN_INTROSPECTION: '1',
    BOOTSTRAP_INVITES: Object.values(invites).map(i => `${i.userId}:${i.token}`).join(','), ...env,
  });
  const proc: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout!.on('data', d => { output += String(d); });
  proc.stderr!.on('data', d => { output += String(d); });
  const ready = (async () => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`identity server exited ${proc.exitCode}:\n${output}`);
      try {
        const health = await (await fetch(`${base}/health`)).json() as { accountIndex: { complete: boolean } };
        if (health.accountIndex.complete) return;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${output}`);
      await sleep(100);
    }
  })();
  const inst: Instance = {
    base, port, ready, output: () => output,
    stop: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      const exited = new Promise(resolve => proc.once('exit', resolve));
      proc.kill('SIGTERM');
      await exited;
    },
  };
  instances.push(inst);
  if (waitComplete) await ready;
  else {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try { await fetch(`${base}/health`); break; } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`identity server did not start:\n${output}`);
      await sleep(100);
    }
  }
  return inst;
}

// ── Clients ─────────────────────────────────────────────────────────────────────────────────
let ipCounter = 0;
// Every request comes from its own address (the server trusts one proxy hop), so the per-IP
// sign-in limits never run out.
const nextIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`; };
type Reply = { status: number; json: Record<string, unknown>; at: number };
let primary: Instance;
async function call(inst: Instance, method: string, path: string, body?: unknown, bearer?: string): Promise<Reply> {
  const r = await fetch(`${inst.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp(), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { text }; }
  return { status: r.status, json, at: Date.now() };
}
const post = (path: string, body: unknown, bearer?: string, inst = primary) => call(inst, 'POST', path, body, bearer);
const out = (inst = primary) => `\n${inst.output().split('\n').slice(-40).join('\n')}`;
async function signIn(key: SoftPasskey, counter: number, inst = primary): Promise<Reply> {
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate' }, undefined, inst);
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const rpId = String(ch.json['rpId'] ?? '127.0.0.1');
  return post('/auth/webauthn/authenticate', { response: assertion(key, String(ch.json['nonce']), inst.base, rpId, counter) }, undefined, inst);
}
async function tokenFor(key: SoftPasskey, counter: number, userId = key.userId, inst = primary): Promise<string> {
  const r = await signIn(key, counter, inst);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out(inst)}`);
  assert.equal(r.json['userId'], userId);
  return String(r.json['token']);
}
async function addDevice(key: SoftPasskey, bearer: string, inst = primary): Promise<Reply> {
  const options = await post('/auth/webauthn/register-options', { name: 'Device' }, bearer, inst);
  if (options.status !== 200) return options;
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), inst.base, rpId) }, undefined, inst);
}
async function bootstrapPasskey(key: SoftPasskey, invite: { userId: string; token: string }, inst = primary): Promise<Reply> {
  const options = await post('/auth/webauthn/register-options', { name: 'Seeded', bootstrapUserId: invite.userId, bootstrapInvite: invite.token }, undefined, inst);
  if (options.status !== 200) return options;
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), inst.base, rpId) }, undefined, inst);
}
async function siwe(w: AnyWallet, opts: { bearer?: string; existingOnly?: boolean; extra?: Doc } = {}, inst = primary): Promise<Reply> {
  const { nonce } = (await post('/challenges', { purpose: 'siwe' }, undefined, inst)).json as { nonce: string };
  const message = `${new URL(inst.base).host} wants you to sign in with your Ethereum account:\n${w.address}\n\nSign in.\n\n`
    + `URI: ${inst.base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'Wallet',
    ...(opts.existingOnly ? { existingOnly: true } : {}), ...(opts.extra ?? {}) }, opts.bearer, inst);
}
async function didSignIn(k: DidKey, opts: { bearer?: string; did?: string; extra?: Doc } = {}, inst = primary): Promise<Reply> {
  const { nonce } = (await post('/challenges', { purpose: 'did-sig' }, undefined, inst)).json as { nonce: string };
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), k.privateKey).toString('base64url');
  return post('/auth/did', { did: opts.did ?? k.did, nonce, signature, name: 'DID',
    ...(opts.did ? { publicKeyMultibase: k.multibase } : {}), ...(opts.extra ?? {}) }, opts.bearer, inst);
}
const del = (path: string, bearer: string, body?: unknown, inst = primary) => call(inst, 'DELETE', path, body ?? {}, bearer);
const signOut = (bearer: string, inst = primary) => post('/tokens/me/sign-out-everywhere', {}, bearer, inst);
const me = (bearer: string, inst = primary) => call(inst, 'GET', '/auth-methods/me', undefined, bearer);
const verify = (token: string, inst = primary) => post('/tokens/verify', { token }, undefined, inst);
async function signsInTo(r: Promise<Reply>, userId: string, inst = primary): Promise<Reply> {
  const reply = await r;
  assert.equal(reply.status, 200, `${JSON.stringify(reply.json)}${out(inst)}`);
  assert.equal(reply.json['userId'], userId, JSON.stringify(reply.json));
  return reply;
}
const credentialOf = (userId: string, key: SoftPasskey) => record(userId)!.webAuthnCredentials.find(c => c.id === key.id);

// ── Accounts (seeded before the servers start, so every one is loaded) ─────────────────────
const a1 = account({ keys: [P(), P()], wallets: [W()] });
const a2 = account({ keys: [P()], wallets: [W()] });
const a3 = account({ keys: [P(), P()] });
const a4 = account({ keys: [P()] });
const a5 = account({ keys: [P()], wallets: [W()] });
const a6 = account({ keys: [P(), P()], wallets: [W()] });
const a11 = account({ keys: [P()], wallets: [W()], dids: [didKey()] });
const a9 = { signIn: account({ keys: [P()] }), add: account({ keys: [P()] }), remove: account({ keys: [P()], wallets: [W()] }), out: account({ keys: [P()] }) };
const b1 = account({ keys: [P()], wallets: [W()] });
const b2 = account({ keys: [P()] });
const c1 = account({ keys: [P()] });
const c2 = account({ keys: [P()] });   // its passkey predates relying-party pinning: no rpId on file
const d2 = account({ keys: [P()] });
const d3 = account({ keys: [P()] });
const e3 = account({ keys: [P()] });
const f1 = account({ keys: [P()] });
const f2 = account({ keys: [P()] });
const f3 = account({ keys: [P()] });
const f5 = account({ keys: [P()], wallets: [W()], dids: [didKey()] });
const f6 = account({ keys: [P()] });
const f7 = account({ keys: [P()] });
const f8 = account({ keys: [P()] });
const f9 = account({ keys: [P(), P()], wallets: [W(), W()], dids: [didKey(), didKey()] });
const f11 = account({ keys: [P()] });
const f12 = account({ keys: [P()], wallets: [W()] });
const g = account({ keys: [P()] });
const t7 = account({ keys: [P()], wallets: [W()] });
const t8 = { owner: account({ keys: [P()] }), key: didKey() };
const t9 = { key: didKey(), did: 'did:web:readd.example', y: account({ keys: [P()] }) };
const t9u = { key: didKey(), did: 'did:web:dropped.example', y: account({ keys: [P()] }) };
const tR = account({ keys: [P()] });
const tH = account({ keys: [P()] });
const bothRemovals = account({ keys: [P()], wallets: [W()] });
const twoAdds = account({ keys: [P()] });
const raceOut = account({ keys: [P()] });
const raceAdd = account({ keys: [P()] });
const raceSignOut = account({ keys: [P()] });
const raceRemove = account({ keys: [P()], wallets: [W()] });
const play = { key: P(), id: `u-try-play-${crypto.randomBytes(16).toString('hex')}` };
const del4 = { pk: account({ keys: [P()] }) };
const scanned = account({ keys: [P()] });
const unlistedEth = W();
const h4 = { key: P() };
// Passkeys whose relying party is pinned already: a synced one (counter 0) and a counting one.
const h1 = { id: 'zz-h1', key: P() };
const h2 = { id: 'zz-h2', key: P() };
// One credential id on three accounts, each with a key of its own: the earliest-enrolled verifies.
const h4ids = ['zz-h4-a', 'zz-h4-b', 'zz-h4-c'];
const sameId = (k: SoftPasskey) => softPasskey(k.rawId);

before(async () => {
  podServer = http.createServer((req, res) => { void servePods(req, res); });
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  podPort = (podServer.address() as net.AddressInfo).port;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // Passkeys whose relying party is pinned already (a counter-0 synced passkey, and a counting one).
  seed(h1.id, { keys: [h1.key], pin: origin });
  seed(h2.id, { keys: [h2.key], pin: origin });
  seed(t8.owner.userId, { keys: t8.owner.keys, dids: [t8.key] });
  docs.get(t8.owner.userId)!.doc['didKeys'] = [{ ...didEntry(t8.key), createdAt: '2024-01-01T00:00:00.000Z' }];
  seed(deriveUserIdFromDid(t8.key.did), { dids: [t8.key], keys: [P()] });
  for (const t of [t9, t9u]) {
    seed(t.y.userId, { keys: t.y.keys, dids: [] });
    docs.get(t.y.userId)!.doc['didKeys'] = [didEntry(t.key, t.did)];
  }
  seed(play.id, { keys: [play.key] });
  const h4a = h4.key; const h4b = sameId(h4a); const h4c = sameId(h4a);
  docs.set(h4ids[0]!, { modified: ++clock, doc: { userId: h4ids[0], name: 'a', walletAddresses: [], didKeys: [], webAuthnCredentials: [stored(h4a, 0, origin, '2024-01-01T00:00:00.000Z')] } });
  docs.set(h4ids[1]!, { modified: ++clock, doc: { userId: h4ids[1], name: 'b', walletAddresses: [], didKeys: [], webAuthnCredentials: [stored(h4b, 0, origin, '2025-06-01T00:00:00.000Z')] } });
  docs.set(h4ids[2]!, { modified: ++clock, doc: { userId: h4ids[2], name: 'c', walletAddresses: [], didKeys: [], webAuthnCredentials: [stored(h4c, 0, origin, '2025-07-01T00:00:00.000Z')] } });
  // An account derived from a wallet, on its pod but not in the listing (opened on the other instance).
  seed(deriveUserIdFromWallet(unlistedEth.address.toLowerCase()), { wallets: [unlistedEth] });
  unlisted.add(deriveUserIdFromWallet(unlistedEth.address.toLowerCase()));
  primary = await startIdentity(port);
});

after(async () => {
  for (const inst of instances) await inst.stop();
  podServer?.closeAllConnections();
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

// ── A. Edits made by another instance or an operator, within this server's 10 s ─────────────
test('A1: a passkey sign-in writes only its counter into the record as the pod holds it', async () => {
  const [p1, p2] = a1.keys;
  const token = await tokenFor(p1!, 1, a1.userId);
  outOfBand(a1.userId, d => {
    d['walletAddresses'] = [];
    d['webAuthnCredentials'] = (d['webAuthnCredentials'] as Array<{ id: string }>).filter(c => c.id !== p2!.id);
    d['sessionEpoch'] = 3;
  });
  const edited = structuredClone(record(a1.userId)!);
  await signsInTo(signIn(p1!, 2), a1.userId);
  const after = record(a1.userId)!;
  assert.deepEqual(after.walletAddresses, []);
  assert.deepEqual(after.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal(after.sessionEpoch, 3);
  assert.equal(credentialOf(a1.userId, p1!)!.counter, 2);
  assert.deepEqual({ ...after, webAuthnCredentials: [] }, { ...edited, webAuthnCredentials: [] });
  // And this server holds that record: the removed wallet and passkey, and the old token, are refused.
  assert.equal((await siwe(a1.wallets![0]!, { existingOnly: true })).status, 401);
  assert.equal((await signIn(p2!, 1)).status, 401);
  assert.equal((await me(token)).status, 401);
});

test('A2: a passkey removed out of band signs in nowhere, writes nothing, and leaves the index', async () => {
  const [p1] = a2.keys;
  outOfBand(a2.userId, d => { d['webAuthnCredentials'] = []; });
  const since = mark();
  const first = await signIn(p1!, 1);
  assert.equal(first.status, 401, JSON.stringify(first.json));
  assert.match(String(first.json['error']), /not on file/);
  const second = await signIn(p1!, 2);
  assert.equal(second.status, 401, JSON.stringify(second.json));
  assert.match(String(second.json['error']), /No WebAuthn credential matches/);
  assert.equal(docPuts(a2.userId, since).length, 0);
  assert.deepEqual(record(a2.userId)!.webAuthnCredentials, []);
});

test('A3: a wallet added with a bearer is added to the record as the pod holds it', async () => {
  const [p1, p2] = a3.keys;
  const token = await tokenFor(p1!, 1, a3.userId);
  outOfBand(a3.userId, d => { d['webAuthnCredentials'] = (d['webAuthnCredentials'] as Array<{ id: string }>).filter(c => c.id !== p2!.id); });
  const w = W();
  await signsInTo(siwe(w, { bearer: token }), a3.userId);
  // Answered only once the pod had it.
  assert.deepEqual(record(a3.userId)!.walletAddresses, [w.address.toLowerCase()]);
  assert.deepEqual(record(a3.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal((await signIn(p2!, 1)).status, 401);
});

test('A4: a device added with a bearer keeps a session epoch raised out of band', async () => {
  const token = await tokenFor(a4.keys[0]!, 1, a4.userId);
  outOfBand(a4.userId, d => { d['sessionEpoch'] = 2; });
  const k2 = P();
  const added = await addDevice(k2, token);
  assert.equal(added.status, 200, `${JSON.stringify(added.json)}${out()}`);
  assert.equal(record(a4.userId)!.sessionEpoch, 2);
  assert.deepEqual(record(a4.userId)!.webAuthnCredentials.map(c => c.id), [a4.keys[0]!.id, k2.id]);
});

test('A5: a wallet removal keeps a did:key added out of band', async () => {
  const token = await tokenFor(a5.keys[0]!, 1, a5.userId);
  const k = didKey();
  outOfBand(a5.userId, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); });
  const r = await del(`/auth-methods/me/wallet/${a5.wallets![0]!.address.toLowerCase()}`, token);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.deepEqual(record(a5.userId)!.walletAddresses, []);
  assert.deepEqual(record(a5.userId)!.didKeys.map(x => x.did), [k.did]);
  await signsInTo(didSignIn(k), a5.userId);
});

test('A6: sign-out keeps a removal made out of band and raises the epoch above the pod\'s', async () => {
  const [p1, p2] = a6.keys;
  const token = await tokenFor(p1!, 1, a6.userId);
  outOfBand(a6.userId, d => {
    d['webAuthnCredentials'] = (d['webAuthnCredentials'] as Array<{ id: string }>).filter(c => c.id !== p2!.id);
    d['sessionEpoch'] = 5;
  });
  const r = await signOut(token);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.equal(r.json['sessionEpoch'], 6);
  assert.equal(record(a6.userId)!.sessionEpoch, 6);
  assert.deepEqual(record(a6.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal((await me(token)).status, 401);
});

test('A11: a wallet or DID sign-in writes nothing, even to an account whose pod dropped it a moment ago', async () => {
  outOfBand(a11.userId, d => { d['walletAddresses'] = []; d['didKeys'] = []; });
  const since = mark();
  // Within this server's 10 s the copy still lists them, so they sign in (documented), but
  // nothing puts them back on the pod.
  await signsInTo(siwe(a11.wallets![0]!), a11.userId);
  await signsInTo(didSignIn(a11.dids![0]!), a11.userId);
  assert.equal(docPuts(a11.userId, since).length, 0);
  assert.deepEqual(record(a11.userId)!.walletAddresses, []);
  assert.deepEqual(record(a11.userId)!.didKeys, []);
});

test('A9: a write that meets another writer\'s change between its read and its write reads again and keeps both', async () => {
  const k = didKey();
  const edit = (userId: string) => outOfBand(userId, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); });
  const cas = async (userId: string, run: () => Promise<Reply>) => {
    const since = mark();
    const held = hold('GET', userId);
    const reply = run();
    assert.ok(await within(held.arrived, 5_000), `the writer never read the pod${out()}`);
    edit(userId);
    held.release();
    const r = await reply;
    assert.equal(r.status, 200, `${userId}: ${JSON.stringify(r.json)}${out()}`);
    assert.deepEqual(record(userId)!.didKeys.map(x => x.did), [k.did], userId);
    const puts = docPuts(userId, since);
    assert.deepEqual(puts.map(p => p.status), [412, 201], `${userId}: a stale write refused, then one built on the new record`);
    return r;
  };
  // A passkey sign-in still signs in, its check run again on the new record.
  const tokenS = await tokenFor(a9.signIn.keys[0]!, 1, a9.signIn.userId);
  assert.ok(tokenS);
  await cas(a9.signIn.userId, () => signIn(a9.signIn.keys[0]!, 2));
  assert.equal(credentialOf(a9.signIn.userId, a9.signIn.keys[0]!)!.counter, 2);
  // An added wallet.
  const tokenA = await tokenFor(a9.add.keys[0]!, 1, a9.add.userId);
  const w = W();
  await cas(a9.add.userId, () => siwe(w, { bearer: tokenA }));
  assert.deepEqual(record(a9.add.userId)!.walletAddresses, [w.address.toLowerCase()]);
  // A removal.
  const tokenR = await tokenFor(a9.remove.keys[0]!, 1, a9.remove.userId);
  await cas(a9.remove.userId, () => del(`/auth-methods/me/wallet/${a9.remove.wallets![0]!.address.toLowerCase()}`, tokenR));
  assert.deepEqual(record(a9.remove.userId)!.walletAddresses, []);
  // A sign-out.
  const tokenO = await tokenFor(a9.out.keys[0]!, 1, a9.out.userId);
  await cas(a9.out.userId, () => signOut(tokenO));
  assert.equal(record(a9.out.userId)!.sessionEpoch, 1);
});

test('A10, D3, E1: two instances on the same pods (a deploy\'s overlap) do not undo each other', async () => {
  const second = await startIdentity(await freePort());
  // A wallet removed on one instance stays removed after a passkey sign-in on the other.
  const token1 = await tokenFor(b1.keys[0]!, 1, b1.userId);
  const removed = await del(`/auth-methods/me/wallet/${b1.wallets![0]!.address.toLowerCase()}`, token1);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  await signsInTo(signIn(b1.keys[0]!, 2, second), b1.userId, second);
  assert.deepEqual(record(b1.userId)!.walletAddresses, []);
  assert.equal((await siwe(b1.wallets![0]!, { existingOnly: true }, second)).status, 401);
  // A sign-out on one instance is kept by every writer on the other.
  const tokenB = await tokenFor(b2.keys[0]!, 1, b2.userId);
  assert.equal((await signOut(tokenB)).status, 200);
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  const token2 = await tokenFor(b2.keys[0]!, 2, b2.userId, second);
  const k2 = P();
  assert.equal((await addDevice(k2, token2, second)).status, 200, out(second));
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  const w = W();
  await signsInTo(siwe(w, { bearer: token2 }, second), b2.userId, second);
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  assert.equal((await del(`/auth-methods/me/wallet/${w.address.toLowerCase()}`, token2, undefined, second)).status, 200);
  assert.equal(record(b2.userId)!.sessionEpoch, 1);
  assert.deepEqual(record(b2.userId)!.webAuthnCredentials.map(c => c.id), [b2.keys[0]!.id, k2.id]);
  // Sign counters rise strictly across the two: a replay the other instance has seen is refused.
  const key = d3.keys[0]!;
  await signsInTo(signIn(key, 10), d3.userId);
  await signsInTo(signIn(key, 11, second), d3.userId, second);
  await signsInTo(signIn(key, 12, second), d3.userId, second);
  const replay = await signIn(key, 11);
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
  assert.equal(credentialOf(d3.userId, key)!.counter, 12);
  await second.stop();
});

// ── B. Writers of one account on one instance, at the same time ─────────────────────────────
/** Hold a passkey sign-in on its read of the pod (under the account's lock), run `other`, then let go. */
async function duringSignIn(userId: string, key: SoftPasskey, counter: number, other: () => Promise<Reply>) {
  const held = hold('GET', userId);
  const signingIn = signIn(key, counter);
  assert.ok(await within(held.arrived, 5_000), `the sign-in never read the pod${out()}`);
  const otherReply = other();
  // The other writer waits for the account's lock: nothing it answers comes before the sign-in's write.
  assert.equal(await within(otherReply, 300), false, 'answered while the sign-in held the account');
  held.release();
  const [s, o] = await Promise.all([signingIn, otherReply]);
  assert.equal(s.status, 200, `${JSON.stringify(s.json)}${out()}`);
  assert.equal(o.status, 200, `${JSON.stringify(o.json)}${out()}`);
  return { s, o };
}

test('B1: a wallet added while a passkey sign-in holds the account is kept, and signs in to it', async () => {
  const key = raceAdd.keys[0]!;
  const token = await tokenFor(key, 1, raceAdd.userId);
  const w = W();
  await duringSignIn(raceAdd.userId, key, 2, () => siwe(w, { bearer: token }));
  assert.equal(credentialOf(raceAdd.userId, key)!.counter, 2);
  assert.deepEqual(record(raceAdd.userId)!.walletAddresses, [w.address.toLowerCase()]);
  await signsInTo(siwe(w, { existingOnly: true }), raceAdd.userId);
  assert.equal(docs.has(deriveUserIdFromWallet(w.address.toLowerCase())), false, 'no account opened for the wallet');
});

test('B2, B8: a device added while a legacy passkey signs in keeps both, and the relying-party pin', async () => {
  const key = c2.keys[0]!;
  assert.equal(credentialOf(c2.userId, key)!.rpId, undefined);
  const token = await tokenFor(key, 1, c2.userId);
  const k2 = P();
  await duringSignIn(c2.userId, key, 2, () => addDevice(k2, token));
  assert.equal(credentialOf(c2.userId, key)!.counter, 2);
  assert.equal(credentialOf(c2.userId, key)!.rpId, '127.0.0.1');
  await signsInTo(signIn(k2, 1), c2.userId);
});

test('B3: a sign-out while a passkey signs in keeps the counter, and a replayed assertion is refused', async () => {
  const key = raceSignOut.keys[0]!;
  const token = await tokenFor(key, 1, raceSignOut.userId);
  await duringSignIn(raceSignOut.userId, key, 2, () => signOut(token));
  assert.equal(credentialOf(raceSignOut.userId, key)!.counter, 2);
  assert.equal(record(raceSignOut.userId)!.sessionEpoch, 1);
  assert.equal((await signIn(key, 2)).status, 401);
});

test('B4: a wallet removal while a passkey signs in removes it and keeps the counter', async () => {
  const key = raceRemove.keys[0]!;
  const token = await tokenFor(key, 1, raceRemove.userId);
  await duringSignIn(raceRemove.userId, key, 2, () => del(`/auth-methods/me/wallet/${raceRemove.wallets![0]!.address.toLowerCase()}`, token));
  assert.equal(credentialOf(raceRemove.userId, key)!.counter, 2);
  assert.deepEqual(record(raceRemove.userId)!.walletAddresses, []);
});

test('B5: with pod latency, racing sign-ins, sign-outs and added devices undo nothing', async () => {
  latencyMs = 20;
  try {
    const key = raceOut.keys[0]!;
    let counter = 1;
    let token = await tokenFor(key, counter++, raceOut.userId);
    for (let i = 0; i < 6; i++) {
      const [s, o] = await Promise.all([signIn(key, counter++), signOut(token)]);
      assert.equal(s.status, 200, JSON.stringify(s.json));
      assert.equal(o.status, 200, JSON.stringify(o.json));
      token = await tokenFor(key, counter++, raceOut.userId);
    }
    assert.equal(record(raceOut.userId)!.sessionEpoch, 6);
    assert.equal(credentialOf(raceOut.userId, key)!.counter, counter - 1);
    const k = twoAdds.keys[0]!;
    let c = 1;
    const bearer = await tokenFor(k, c++, twoAdds.userId);
    const added: SoftPasskey[] = [];
    for (let i = 0; i < 6; i++) {
      const device = P();
      added.push(device);
      const [a, s] = await Promise.all([addDevice(device, bearer), signIn(k, c++)]);
      assert.equal(a.status, 200, JSON.stringify(a.json));
      assert.equal(s.status, 200, JSON.stringify(s.json));
    }
    assert.deepEqual(record(twoAdds.userId)!.webAuthnCredentials.map(x => x.id), [k.id, ...added.map(d => d.id)]);
    assert.equal(credentialOf(twoAdds.userId, k)!.counter, c - 1);
  } finally {
    latencyMs = 0;
  }
});

test('B7, C10: credentials added at once both land, and neither is acknowledged before the pod has it', async () => {
  const token = await tokenFor(c1.keys[0]!, 1, c1.userId);
  const w = W();
  const k = didKey();
  const held = hold('PUT', c1.userId);
  const addW = siwe(w, { bearer: token });
  assert.ok(await within(held.arrived, 5_000), `no write arrived${out()}`);
  const addD = didSignIn(k, { bearer: token });
  assert.equal(await within(Promise.race([addW, addD]), 500), false, 'acknowledged while its write was held');
  // Nor does this server act on it before the pod has it.
  assert.equal((await siwe(w, { existingOnly: true })).status, 401);
  held.release();
  await signsInTo(addW, c1.userId);
  await signsInTo(addD, c1.userId);
  assert.deepEqual(record(c1.userId)!.walletAddresses, [w.address.toLowerCase()]);
  assert.deepEqual(record(c1.userId)!.didKeys.map(x => x.did), [k.did]);
});

test('B10: a startup scan whose read a write overtook installs nothing', async () => {
  const token = await tokenFor(scanned.keys[0]!, 1, scanned.userId);
  // A third instance whose scan of this account is held; meanwhile it loads the account on demand
  // and signs it out.
  const held = hold('GET', scanned.userId);
  const third = await startIdentity(await freePort(), {}, false);
  assert.ok(await within(held.arrived, 20_000), `the scan never read the account${out(third)}`);
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate', userId: scanned.userId }, undefined, third);
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const r = await signOut(token, third);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out(third)}`);
  held.release();
  await third.ready;
  assert.equal((await me(token, third)).status, 401, 'the token signed out is refused');
  await third.stop();
});

test('B11: an on-demand load that a sign-in\'s load overtook still finds the account', async () => {
  const userId = deriveUserIdFromWallet(unlistedEth.address.toLowerCase());
  // A token for the unlisted account, from another instance.
  const other = await startIdentity(await freePort());
  const signedIn = await signsInTo(siwe(unlistedEth, {}, other), userId, other);
  await other.stop();
  const held = hold('GET', userId);
  const reading = me(String(signedIn.json['token']));
  assert.ok(await within(held.arrived, 5_000), `the token's account was never read${out()}`);
  await signsInTo(siwe(unlistedEth), userId);
  held.release();
  const r = await reading;
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
});

// ── C. Writes the pod refuses, or never answers ─────────────────────────────────────────────
test('C1: a wallet the pod refused to add is not acknowledged, and does not sign in', async () => {
  const token = await tokenFor(f1.keys[0]!, 1, f1.userId);
  const w = W();
  failPuts(f1.userId, '500');
  const r = await siwe(w, { bearer: token });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(r.json['token'], undefined);
  assert.deepEqual(record(f1.userId)!.walletAddresses, []);
  assert.equal((await siwe(w, { existingOnly: true })).status, 401);
  await signsInTo(siwe(w, { bearer: token }), f1.userId);
  await signsInTo(siwe(w, { existingOnly: true }), f1.userId);
});

test('C2: a device the pod refused to add does not sign in, and a later sign-in neither carries nor loses it', async () => {
  const [p1] = f2.keys;
  const token = await tokenFor(p1!, 1, f2.userId);
  const k2 = P();
  failPuts(f2.userId, '500');
  const r = await addDevice(k2, token);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal((await signIn(k2, 1)).status, 401);
  await signsInTo(signIn(p1!, 2), f2.userId);
  assert.deepEqual(record(f2.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id]);
  assert.equal((await addDevice(k2, token)).status, 200);
  await signsInTo(signIn(p1!, 3), f2.userId);
  assert.deepEqual(record(f2.userId)!.webAuthnCredentials.map(c => c.id), [p1!.id, k2.id]);
  await signsInTo(signIn(k2, 1), f2.userId);
});

test('C3: a did:key the pod refused to add is not acknowledged and opens no account', async () => {
  const token = await tokenFor(f3.keys[0]!, 1, f3.userId);
  const k = didKey();
  failPuts(f3.userId, '500');
  const r = await didSignIn(k, { bearer: token });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(record(f3.userId)!.didKeys, []);
  assert.equal(docs.has(deriveUserIdFromDid(k.did)), false);
  await signsInTo(didSignIn(k, { bearer: token }), f3.userId);
  await signsInTo(didSignIn(k), f3.userId);
});

test('C4: a bootstrap passkey the pod refused gives the invite back; each attempt reads once and writes no empty record', async () => {
  const key = P();
  failPuts(invites.pk.userId, '500');
  const first = await bootstrapPasskey(key, invites.pk);
  assert.equal(first.status, 503, JSON.stringify(first.json));
  assert.equal(docs.has(invites.pk.userId), false);
  const before = mark();
  const second = await bootstrapPasskey(key, invites.pk);
  assert.equal(second.status, 200, `${JSON.stringify(second.json)}${out()}`);
  assert.equal(second.json['userId'], invites.pk.userId);
  // The options read the seeded pod once, and the registration reads it once and writes it once.
  assert.equal(docGets(invites.pk.userId, before).length, 2);
  assert.equal(docPuts(invites.pk.userId, before).length, 1);
  for (const put of docPuts(invites.pk.userId)) {
    assert.equal((put.body!['webAuthnCredentials'] as unknown[]).length, 1, 'no empty record is written');
  }
  assert.deepEqual(record(invites.pk.userId)!.webAuthnCredentials.map(c => c.id), [key.id]);
});

test('C5: a removal the pod refused changes nothing here either', async () => {
  const token = await tokenFor(f5.keys[0]!, 1, f5.userId);
  const wallet = f5.wallets![0]!.address.toLowerCase();
  failPuts(f5.userId, '500');
  const r = await del(`/auth-methods/me/wallet/${wallet}`, token);
  assert.equal(r.status, 500, JSON.stringify(r.json));
  assert.deepEqual(record(f5.userId)!.walletAddresses, [wallet]);
  const listed = await me(token);
  assert.deepEqual(listed.json['walletAddresses'], [wallet], 'this server lists what the pod does');
  await signsInTo(siwe(f5.wallets![0]!), f5.userId);
  await signsInTo(didSignIn(f5.dids![0]!), f5.userId);
});

test('C6: a sign-out the pod refused leaves the session working; one it applied anyway ends it here too', async () => {
  const token = await tokenFor(f6.keys[0]!, 1, f6.userId);
  failPuts(f6.userId, '500');
  assert.equal((await signOut(token)).status, 500);
  assert.equal(record(f6.userId)!.sessionEpoch, undefined);
  assert.equal((await me(token)).status, 200);
  // The store applied it and answered 500: the pod's epoch is the one this server checks.
  failPuts(f6.userId, 'apply-then-500');
  assert.equal((await signOut(token)).status, 500);
  assert.equal(record(f6.userId)!.sessionEpoch, 1);
  assert.equal((await me(token)).status, 401);
});

test('C7: a sign counter the pod refused is not advanced here; one it applied anyway is', async () => {
  const key = f7.keys[0]!;
  await tokenFor(key, 1, f7.userId);
  failPuts(f7.userId, '500');
  const r = await signIn(key, 5);
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.equal(credentialOf(f7.userId, key)!.counter, 1);
  await signsInTo(signIn(key, 2), f7.userId);
  assert.equal(credentialOf(f7.userId, key)!.counter, 2);
  // Applied, then 500: a replay of that counter is refused, as the pod's counter says.
  failPuts(f7.userId, 'apply-then-500');
  assert.equal((await signIn(key, 6)).status, 503);
  assert.equal(credentialOf(f7.userId, key)!.counter, 6);
  const replay = await signIn(key, 6);
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
  assert.equal(credentialOf(f7.userId, key)!.counter, 6);
});

test('C8: a write the pod applied but answered 500 leaves this server holding what the pod holds', async () => {
  const token = await tokenFor(f8.keys[0]!, 1, f8.userId);
  const w = W();
  failPuts(f8.userId, 'apply-then-500');
  const r = await siwe(w, { bearer: token });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.deepEqual(record(f8.userId)!.walletAddresses, [w.address.toLowerCase()]);
  await signsInTo(siwe(w, { existingOnly: true }), f8.userId);
  const since = mark();
  await signsInTo(siwe(w, { bearer: token }), f8.userId);
  assert.equal(docPuts(f8.userId, since).length, 0);
});

test('C9: every writer whose read of the pod fails answers 503 and writes nothing', async () => {
  const [p1, p2] = f9.keys;
  const token = await tokenFor(p1!, 1, f9.userId);
  const since = mark();
  failingGets.set(f9.userId, 1000);
  try {
    const attempts: Array<[string, () => Promise<Reply>]> = [
      ['add wallet', () => siwe(W(), { bearer: token })],
      ['add did', () => didSignIn(didKey(), { bearer: token })],
      ['add device', () => addDevice(P(), token)],
      ['remove passkey', () => del(`/auth-methods/me/webauthn/${encodeURIComponent(p2!.id)}`, token)],
      ['remove wallet', () => del(`/auth-methods/me/wallet/${f9.wallets![0]!.address.toLowerCase()}`, token)],
      ['remove did', () => del('/auth-methods/me/did', token, { did: f9.dids![0]!.did })],
      ['sign out', () => signOut(token)],
      ['passkey sign-in', () => signIn(p1!, 2)],
      ['delete', () => post('/users/me/delete', {}, token)],
    ];
    for (const [what, attempt] of attempts) {
      const r = await attempt();
      assert.equal(r.status, 503, `${what}: ${JSON.stringify(r.json)}${out()}`);
    }
  } finally {
    failingGets.delete(f9.userId);
  }
  assert.equal(docPuts(f9.userId, since).length, 0);
  assert.equal(record(f9.userId)!.deletedAt, undefined);
});

test('C11: a write the pod never answers ends within the write timeout, and frees the account', { timeout: 40_000 }, async () => {
  const key = f11.keys[0]!;
  const token = await tokenFor(key, 1, f11.userId);
  failPuts(f11.userId, 'hang');
  const started = Date.now();
  const r = await siwe(W(), { bearer: token });
  assert.equal(r.status, 503, JSON.stringify(r.json));
  assert.ok(Date.now() - started < 17_000, `took ${Date.now() - started} ms`);
  await signsInTo(signIn(key, 2), f11.userId);
});

test('C12: a record that is not JSON stops a passkey sign-in, and is never overwritten', async () => {
  const [p1] = f12.keys;
  await tokenFor(p1!, 1, f12.userId);
  const since = mark();
  nonJson.add(f12.userId);
  try {
    const r = await signIn(p1!, 2);
    assert.equal(r.status, 503, JSON.stringify(r.json));
    // A wallet sign-in decides on this server's copy, still under 10 s old.
    await signsInTo(siwe(f12.wallets![0]!), f12.userId);
  } finally {
    nonJson.delete(f12.userId);
  }
  assert.equal(docPuts(f12.userId, since).length, 0);
});

// ── D, E. Counters and epochs ───────────────────────────────────────────────────────────────
test('D2: a sign counter raised out of band is the one an assertion must beat', async () => {
  const key = d2.keys[0]!;
  await tokenFor(key, 1, d2.userId);
  outOfBand(d2.userId, d => { (d['webAuthnCredentials'] as Array<{ counter: number }>)[0]!.counter = 7; });
  assert.equal((await signIn(key, 6)).status, 401);
  assert.equal(credentialOf(d2.userId, key)!.counter, 7);
  await signsInTo(signIn(key, 8), d2.userId);
  assert.equal(credentialOf(d2.userId, key)!.counter, 8);
});

test('E3: a deletion\'s tombstone takes an epoch above the pod\'s and this server\'s', async () => {
  const key = e3.keys[0]!;
  let token = await tokenFor(key, 1, e3.userId);
  assert.equal((await signOut(token)).status, 200);
  token = await tokenFor(key, 2, e3.userId);
  assert.equal((await signOut(token)).status, 200);
  token = await tokenFor(key, 3, e3.userId);
  outOfBand(e3.userId, d => { d['sessionEpoch'] = 1; });
  const r = await post('/users/me/delete', {}, token);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}${out()}`);
  assert.equal(record(e3.userId)!.deletedAt !== undefined, true);
  assert.equal(record(e3.userId)!.sessionEpoch, 3);
});

// ── F. Play owners, the janitor ─────────────────────────────────────────────────────────────
test('F2: a Play owner\'s passkey sign-in and a wallet added meanwhile both land', async () => {
  const since = mark();
  const token = await tokenFor(play.key, 1, play.id);
  const w = W();
  await duringSignIn(play.id, play.key, 2, () => siwe(w, { bearer: token }));
  assert.equal(credentialOf(play.id, play.key)!.counter, 2);
  assert.deepEqual(record(play.id)!.walletAddresses, [w.address.toLowerCase()]);
  // Writes of a record the pod has cost one request each: no container write before them.
  assert.equal(containerPuts(play.id, since).length, 0);
});

test('F4, I5: a claimed u-try- account is kept: by the janitor if it was claimed after its decision, and when its removal fails', async () => {
  const janitor = await startIdentity(await freePort(), { JANITOR_INTERVAL_MS: '400', TRY_USER_TTL_MS: '1' });
  // The janitor decides on its copy (no credential) and deletes the record only if it still is
  // the one it read: here a credential lands on the pod just as its deletion arrives.
  const k = didKey();
  const held = hold('DELETE', id => id.startsWith('u-try-'), 1, id => outOfBand(id, d => { (d['didKeys'] as unknown[]).push(didEntry(k)); }));
  const tried = await post('/try', {}, undefined, janitor);
  assert.equal(tried.status, 200, JSON.stringify(tried.json));
  const tryId = String(tried.json['userId']);
  assert.ok(await within(held.arrived, 10_000), `the janitor never tried to delete ${tryId}${out(janitor)}`);
  held.release();
  await sleep(500);
  assert.deepEqual(record(tryId)?.didKeys.map(x => x.did), [k.did], `the claimed account was deleted${out(janitor)}`);
  assert.equal((await me(String(tried.json['token']), janitor)).status, 200);
  await janitor.stop();
  // A claimed u-try- account whose removal the pod refuses stays whole: 503, and it still signs in.
  const own = await post('/try', {});
  assert.equal(own.status, 200, JSON.stringify(own.json));
  const ownId = String(own.json['userId']);
  const key = P();
  assert.equal((await addDevice(key, String(own.json['token']))).status, 200, out());
  failingDeletes.add(ownId);
  try {
    const r = await post('/users/me/delete', {}, String(own.json['token']));
    assert.equal(r.status, 503, JSON.stringify(r.json));
  } finally {
    failingDeletes.delete(ownId);
  }
  await signsInTo(signIn(key, 1), ownId);
});

// ── After this server's copy has aged (one wait for all of them) ───────────────────────────
test('A7, A8, B6, B9, G1, G2, H3, I2: once the copy is 10 s old, every decision and write goes to the pod', async () => {
  const tokenT7 = await tokenFor(t7.keys[0]!, 1, t7.userId);
  assert.ok(tokenT7);
  const tokenY = await tokenFor(t9.y.keys[0]!, 1, t9.y.userId);
  const tokenG = await tokenFor(g.keys[0]!, 1, g.userId);
  const tokenR = await tokenFor(tR.keys[0]!, 1, tR.userId);
  const tokenH = await tokenFor(tH.keys[0]!, 1, tH.userId);
  const tokenB6 = await tokenFor(bothRemovals.keys[0]!, 1, bothRemovals.userId);
  const derivedDid = deriveUserIdFromDid(t8.key.did);
  outOfBand(t7.userId, d => { d['walletAddresses'] = []; });
  outOfBand(derivedDid, d => { d['didKeys'] = []; });
  outOfBand(t9.y.userId, d => { d['didKeys'] = []; });
  outOfBand(t9u.y.userId, d => { d['didKeys'] = []; });
  docs.delete(g.userId);
  await sleep(TTL_WAIT_MS);

  // A7: a wallet the pod dropped signs in to that account no more, and nothing writes it back.
  let since = mark();
  assert.equal((await siwe(t7.wallets![0]!, { existingOnly: true })).status, 401);
  const relay = await siwe(t7.wallets![0]!);
  assert.notEqual(relay.json['userId'], t7.userId);
  assert.equal(docPuts(t7.userId, since).length, 0);
  assert.deepEqual(record(t7.userId)!.walletAddresses, []);

  // A8: a did:key the derived account dropped signs in to the owner's, writing nothing.
  since = mark();
  await signsInTo(didSignIn(t8.key), t8.owner.userId);
  assert.equal(docPuts(derivedDid, since).length + docPuts(t8.owner.userId, since).length, 0);
  assert.deepEqual(record(derivedDid)!.didKeys, []);

  // I2: a did:web the pod dropped, added again with the account's bearer, is added on the first
  // try (its stale holder drops out on reading, and the add goes on); without a bearer it signs
  // in nowhere and nothing writes it back.
  await signsInTo(didSignIn(t9.key, { did: t9.did, bearer: tokenY }), t9.y.userId);
  assert.deepEqual(record(t9.y.userId)!.didKeys.map(x => x.did), [t9.did]);
  since = mark();
  const unbound = await didSignIn(t9u.key, { did: t9u.did });
  assert.equal(unbound.status, 401, JSON.stringify(unbound.json));
  assert.equal(docPuts(t9u.y.userId, since).length, 0);
  assert.deepEqual(record(t9u.y.userId)!.didKeys, []);

  // G1: an account whose document is gone: reads create nothing.
  since = mark();
  assert.equal((await verify(tokenG)).json['valid'], true);
  await sleep(200);
  await post('/challenges', { purpose: 'webauthn-authenticate', userId: g.userId });
  await me(tokenG);
  await post('/auth/webauthn/register-options', { name: 'x' }, tokenG);
  assert.equal(docPuts(g.userId, since).length + containerPuts(g.userId, since).length, 0);
  // G2: nor do writes: an add or a removal needs the document.
  assert.equal((await siwe(W(), { bearer: tokenG })).status, 404);
  assert.equal((await addDevice(P(), tokenG)).status, 404);
  assert.equal((await del(`/auth-methods/me/webauthn/${encodeURIComponent(g.keys[0]!.id)}`, tokenG)).status, 404);
  assert.equal(docPuts(g.userId, since).length + containerPuts(g.userId, since).length, 0);
  assert.equal(docs.has(g.userId), false);

  // H3: readers of a stale copy share one read of the pod; a passkey sign-in alongside adds its own.
  since = mark();
  const verifies = Array.from({ length: 20 }, () => verify(tokenH));
  const signingIn = signIn(tH.keys[0]!, 2);
  await Promise.all(verifies);
  await signsInTo(signingIn, tH.userId);
  assert.ok(docGets(tH.userId, since).length <= 2, `${docGets(tH.userId, since).length} reads`);

  // B6: removing an account's last two methods at once leaves one: each removal checks, under the
  // account's lock, the record the other one wrote.
  const [a, b] = await Promise.all([
    del(`/auth-methods/me/webauthn/${encodeURIComponent(bothRemovals.keys[0]!.id)}`, tokenB6),
    del(`/auth-methods/me/wallet/${bothRemovals.wallets![0]!.address.toLowerCase()}`, tokenB6),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const left = record(bothRemovals.userId)!;
  assert.equal(left.walletAddresses.length + left.webAuthnCredentials.length, 1);

  // B9: a wallet added while a refresh of the copy reads the pod is in the index once acknowledged.
  const held = hold('GET', tR.userId);
  void verify(tokenR);
  assert.ok(await within(held.arrived, 5_000), `no refresh read the pod${out()}`);
  const w = W();
  const adding = siwe(w, { bearer: tokenR });
  assert.equal(await within(adding, 300), false, 'acknowledged while a refresh held the account');
  held.release();
  await signsInTo(adding, tR.userId);
  // Whatever the refresh read before the add is never installed over it.
  await sleep(300);
  await signsInTo(siwe(w, { existingOnly: true }), tR.userId);
});

// ── H. What a sign-in costs ─────────────────────────────────────────────────────────────────
test('H1, H2, H4: a passkey sign-in reads its record once and writes only a changed counter, with no container write', async () => {
  let since = mark();
  await signsInTo(signIn(h1.key, 0), h1.id);
  await signsInTo(signIn(h1.key, 0), h1.id);
  assert.equal(docGets(h1.id, since).length, 2);
  assert.equal(docPuts(h1.id, since).length, 0);

  since = mark();
  await signsInTo(signIn(h2.key, 5), h2.id);
  assert.equal(docGets(h2.id, since).length, 1);
  assert.equal(docPuts(h2.id, since).length, 1);
  assert.equal(containerPuts(h2.id, since).length, 0);
  assert.equal(credentialOf(h2.id, h2.key)!.counter, 5);

  since = mark();
  await signsInTo(signIn(h4.key, 0), h4ids[0]!);
  assert.equal(h4ids.reduce((n, id) => n + docGets(id, since).length, 0), 1);
  assert.equal(h4ids.reduce((n, id) => n + docPuts(id, since).length, 0), 0);
});

// ── I. Deletion, bootstrap claims ───────────────────────────────────────────────────────────
test('I1: a wrong invite for a seeded id that was never claimed reads and writes nothing', async () => {
  const since = mark();
  const r = await siwe(W(), { extra: { bootstrapUserId: invites.never.userId, bootstrapInvite: 'wrong' } });
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.equal(requests.slice(since).filter(q => q.userId === invites.never.userId).length, 0);
});

test('I4: deleting an account takes its lock once, for every kind of id, and answers promptly', async () => {
  const kinds: Array<[string, () => Promise<{ token: string; userId: string }>]> = [
    ['u-pk-', async () => ({ token: await tokenFor(del4.pk.keys[0]!, 1, del4.pk.userId), userId: del4.pk.userId })],
    ['u-eth-', async () => { const w = W(); const r = await siwe(w); return { token: String(r.json['token']), userId: String(r.json['userId']) }; }],
    ['u-did-', async () => { const r = await didSignIn(didKey()); return { token: String(r.json['token']), userId: String(r.json['userId']) }; }],
    ['seeded', async () => {
      const r = await didSignIn(didKey(), { extra: { bootstrapUserId: invites.del.userId, bootstrapInvite: invites.del.token } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      return { token: String(r.json['token']), userId: String(r.json['userId']) };
    }],
  ];
  for (const [kind, open] of kinds) {
    const { token, userId } = await open();
    const started = Date.now();
    const r = await post('/users/me/delete', {}, token);
    assert.equal(r.status, 200, `${kind}: ${JSON.stringify(r.json)}${out()}`);
    assert.ok(Date.now() - started < 2_000, `${kind}: took ${Date.now() - started} ms`);
    assert.ok(record(userId)!.deletedAt, `${kind}: tombstone`);
  }
});

test('I6: a bootstrap passkey for a seeded account claimed meanwhile is refused, and leaves no account shell', async () => {
  const options = await post('/auth/webauthn/register-options', { name: 'Seeded', bootstrapUserId: invites.claimed.userId, bootstrapInvite: invites.claimed.token });
  assert.equal(options.status, 200, JSON.stringify(options.json));
  // Claimed by another route before this ceremony completes (the other instance, say).
  seed(invites.claimed.userId, { dids: [didKey()] });
  const rpId = (options.json['rp'] as { id: string }).id;
  const r = await post('/auth/webauthn/register', { response: attest(P(), String(options.json['challenge']), primary.base, rpId) });
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.equal((await call(primary, 'GET', `/users/${invites.claimed.userId}/did.json`)).status, 404);
  assert.equal(record(invites.claimed.userId)!.webAuthnCredentials.length, 0);
});
