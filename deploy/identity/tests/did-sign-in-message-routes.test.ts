/**
 * The DID sign-in proof names this server, through the routes: server.ts is started as a child
 * process against a stand-in pod server (no live pod).
 *
 * POST /auth/did verified an Ed25519 signature over the bare /challenges nonce. A signature over
 * a bare nonce names no server. POST /challenges with purpose 'did-sig' now also returns
 * `message`, a versioned text that names this server's host (from BASE_URL, never the request)
 * and carries the nonce, and /auth/did verifies the signature over that text, the bytes stored
 * with the challenge. A signature over the bare nonce is still accepted while
 * DID_ACCEPT_BARE_NONCE is unset or 1, with Deprecation and Warning headers and one
 * `WARN identity_did_bare_nonce` line for each sign-in made with one, naming the account signed
 * in to, and refused with 401, and logged, when it is 0.
 *
 * Two servers. LENIENT: the setting unset, and a BASE_URL naming a host the tests never connect
 * to, so the host in the message can only have come from configuration. STRICT: the setting 0,
 * BASE_URL its own address, a bootstrap invite configured and timing lines on. A start with an
 * unknown value must stop before it listens; starts with an empty value and a padded '0' must not.
 *
 * A key of small order, for which a signature can be made without a private key, is refused with
 * 400 before any signature is checked, on either server.
 *
 * Run:
 *   node --test --import tsx tests/did-sign-in-message-routes.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { deriveUserIdFromDid } from '../derive-userid.js';
import { isSmallOrderEd25519Key } from '../did-parse.js';
import { closeServer, stopChild } from './teardown.js';

const now = new Date().toISOString();
const LENIENT_HOST = 'identity.example.test';

// ── Keys ──
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}
type Key = { privateKey: crypto.KeyObject; multibase: string; legacyMultibase: string };
type DidKey = Key & { did: string };
/**
 * A fresh Ed25519 key. The raw public key is the last 32 bytes of its SPKI DER export: a JWK
 * export of a freshly generated key can deadlock on Node 20 (tests/public-jwk.ts).
 */
function ed25519(): Key {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return {
    privateKey,
    multibase: `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`,
    legacyMultibase: `z${raw.toString('base64url')}`,
  };
}
const didKey = (): DidKey => { const k = ed25519(); return { ...k, did: `did:key:${k.multibase}` }; };
/** A did:key in the legacy form this server once emitted: 'z' + base64url(raw key). */
const legacyDidKey = (): DidKey => { const k = ed25519(); return { ...k, did: `did:key:${k.legacyMultibase}` }; };
const sign = (text: string, key: { privateKey: crypto.KeyObject }) =>
  crypto.sign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('base64url');

// A did:web an account lists with its owner's key; listed, so loaded at startup.
const web = { did: 'did:web:owner.example', owner: ed25519() };
const webId = deriveUserIdFromDid(web.did);
// A seeded account claimed with a bootstrap invite (STRICT only). Not in the store: its GET is
// 404 and its create PUT carries If-None-Match: *.
const seeded = { userId: 'seeded-did', token: crypto.randomBytes(16).toString('hex') };

// ── Pods ──
const pods = new Map<string, Record<string, unknown>>([
  [webId, { userId: webId, name: 'did:web owner', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [{ did: web.did, publicKeyMultibase: web.owner.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: now }] }],
]);
const listed = new Set([webId]);
// Every PUT, by the pod (first path segment) it went to.
const writes: Array<{ userId: string; path: string; ifNoneMatch: string | undefined }> = [];
const writesTo = (userId: string) => writes.filter(w => w.userId === userId);

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
  if (req.method === 'PUT') {
    const userId = path.split('/')[1] ?? '';
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    let body = '';
    req.on('data', d => { body += String(d); });
    req.on('end', () => {
      if (m && ifNoneMatch === '*' && pods.has(userId)) { res.writeHead(412).end(); return; }
      writes.push({ userId, path, ifNoneMatch });
      if (m) pods.set(userId, JSON.parse(body) as Record<string, unknown>);
      res.writeHead(201).end();
    });
    return;
  }
  // Anything else is absent, so a first sign-in's probe for a pod deleted before tombstones
  // (HEAD of the pod, its agents and its profile card) finds nothing.
  res.writeHead(404).end();
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type IdentityProcess = { proc: ChildProcess; url: string; port: number; sink: { text: string }; closed: Promise<number | null> };
const STRIPPED = ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES',
  'PROVISIONAL_PLAY_CLIENTS', 'RELAY_PUBLIC_URL', 'SIWE_DOMAINS', 'WEBAUTHN_RP_ORIGINS', 'WEBAUTHN_RP_ORIGIN',
  'IDENTITY_TIMING', 'DID_ACCEPT_BARE_NONCE'];

/** server.ts as a child process over the pod server on `podPort`; BASE_URL is its own address unless `extraEnv` sets it. */
async function spawnIdentity(podPort: number, extraEnv: (port: number) => Record<string, string>): Promise<IdentityProcess> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIPPED) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: url, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: crypto.randomBytes(32).toString('base64'), JANITOR_INTERVAL_MS: '0',
  }, extraEnv(port));
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = { text: '' };
  proc.stdout!.on('data', d => { sink.text += String(d); });
  proc.stderr!.on('data', d => { sink.text += String(d); });
  const closed = new Promise<number | null>(resolve => proc.on('close', code => resolve(code)));
  return { proc, url, port, sink, closed };
}

/** spawnIdentity, once /health says every account is loaded; a server that never gets there is stopped. */
async function startIdentity(podPort: number, extraEnv: (port: number) => Record<string, string>): Promise<IdentityProcess> {
  const s = await spawnIdentity(podPort, extraEnv);
  const deadline = Date.now() + 60_000;
  try {
    for (;;) {
      if (s.proc.exitCode !== null) throw new Error(`identity server exited ${s.proc.exitCode}:\n${s.sink.text}`);
      try {
        const health = await (await fetch(`${s.url}/health`)).json() as { accountIndex: { complete: boolean } };
        if (health.accountIndex.complete) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${s.sink.text}`);
      await sleep(100);
    }
  } catch (err) {
    // No caller holds this child yet, so no hook could stop it, and a live child keeps the
    // file's process from ever exiting.
    await stopChild(s.proc);
    throw err;
  }
  return s;
}

// Each test arrives from its own address (the server trusts one proxy hop), so the per-IP
// limits (60 challenges and 30 sign-ins a minute) are not shared across the whole file.
let clientAddr = 0;
beforeEach(() => { clientAddr++; });
type Reply = { status: number; json: Record<string, unknown>; headers: Headers };
async function post(server: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const r = await fetch(`${server}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${clientAddr}`, ...headers }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { body: text }; }
  return { status: r.status, json, headers: r.headers };
}
/** A POST through node:http, so the request can carry a Host header of the caller's choosing. */
function rawPost(server: string, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(`${server}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), 'X-Forwarded-For': `198.51.100.${clientAddr}`, ...headers },
    }, res => {
      let text = '';
      res.on('data', d => { text += String(d); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function challenge(server: string, body: Record<string, unknown> = { purpose: 'did-sig' }) {
  const r = await post(server, '/challenges', body);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { nonce: r.json['nonce'] as string, message: r.json['message'], json: r.json };
}
/** A did-sig challenge whose message is a string, as this server must now return. */
async function messageChallenge(server: string) {
  const ch = await challenge(server);
  assert.equal(typeof ch.message, 'string', `a did-sig challenge carries a message: ${JSON.stringify(ch.json)}`);
  return { nonce: ch.nonce, message: ch.message as string };
}
/** Sign in the way every DID client now does: over the challenge's message. */
async function overMessage(server: string, key: { did: string; privateKey: crypto.KeyObject }, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const { nonce, message } = await messageChallenge(server);
  return post(server, '/auth/did', { did: key.did, nonce, signature: sign(message, key), name: 'New', ...extra }, headers);
}
/** Sign in the old way: over the bare nonce, of a challenge from `challengeBody`. */
async function overBareNonce(server: string, key: { did: string; privateKey: crypto.KeyObject }, extra: Record<string, unknown> = {},
  headers: Record<string, string> = {}, challengeBody: Record<string, unknown> = { purpose: 'did-sig' }) {
  const { nonce } = await challenge(server, challengeBody);
  return post(server, '/auth/did', { did: key.did, nonce, signature: sign(nonce, key), name: 'New', ...extra }, headers);
}

const BARE_PREFIX = '[identity] WARN identity_did_bare_nonce ';
// Every character a log reader may end a line at (Python's str.splitlines): CRLF, LF, CR, VT, FF,
// U+001C to U+001E, U+0085, U+2028 and U+2029.
const READER_BREAKS = ['\r\n', '\n', '\r', '\v', '\f', '\x1c', '\x1d', '\x1e', '\x85', '\u2028', '\u2029'];
const logLines = (s: IdentityProcess) => s.sink.text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
const bareLines = (s: IdentityProcess) => logLines(s).filter(l => l.startsWith(BARE_PREFIX));
async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
/** The bare-nonce lines logged since `before` lines were, once there are `n` more. */
async function newBareLines(s: IdentityProcess, before: number, n: number): Promise<string[]> {
  await waitFor(() => bareLines(s).length >= before + n, 2000, `${n} identity_did_bare_nonce line(s)\n${s.sink.text}`);
  return bareLines(s).slice(before);
}
/** Time for a line the child wrote before it answered to reach this process. */
const settle = () => sleep(200);

let podServer: http.Server;
let podPort = 0;
let lenient: IdentityProcess;
let strict: IdentityProcess;
let lenientStartup = '';
let strictStartup = '';

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  podPort = (podServer.address() as net.AddressInfo).port;
  // allSettled, so a server that started is held (and stopped by after()) when the other did not.
  const [l, s] = await Promise.allSettled([
    startIdentity(podPort, () => ({ BASE_URL: `https://${LENIENT_HOST}` })),
    startIdentity(podPort, () => ({ DID_ACCEPT_BARE_NONCE: '0', BOOTSTRAP_INVITES: `${seeded.userId}:${seeded.token}`, IDENTITY_TIMING: '1' })),
  ]);
  if (l.status === 'fulfilled') lenient = l.value;
  if (s.status === 'fulfilled') strict = s.value;
  for (const r of [l, s]) if (r.status === 'rejected') throw r.reason;
  lenientStartup = lenient.sink.text;
  strictStartup = strict.sink.text;
});

after(async () => {
  await Promise.all([stopChild(lenient?.proc), stopChild(strict?.proc)]);
  await closeServer(podServer);
});

test('a did-sig challenge carries a message naming this server, and no other challenge carries one', async () => {
  const { nonce, message } = await messageChallenge(lenient.url);
  assert.equal(message, `Interego DID sign-in v1\nHost: ${LENIENT_HOST}\nNonce: ${nonce}`);
  assert.equal(message.includes('\r'), false);
  assert.equal(message.endsWith('\n'), false);
  assert.match(message, /^[\x20-\x7e\n]*$/);
  assert.equal(message.split('\n')[2], `Nonce: ${nonce}`);
  for (const body of [{ purpose: 'siwe' }, { purpose: 'webauthn-register' }, { purpose: 'webauthn-authenticate' }, {}]) {
    const ch = await challenge(lenient.url, body);
    assert.equal('message' in ch.json, false, `${JSON.stringify(body)}: ${JSON.stringify(ch.json)}`);
  }
  const s = await messageChallenge(strict.url);
  assert.equal(s.message, `Interego DID sign-in v1\nHost: 127.0.0.1:${strict.port}\nNonce: ${s.nonce}`);
});

test('the host and the text come from configuration, never from the request', async () => {
  const health = await (await fetch(`${lenient.url}/health`)).json() as { base: string };
  const r = await rawPost(lenient.url, '/challenges', {
    purpose: 'did-sig', userId: 'attacker.example', did: 'did:web:attacker.example',
    address: `0x${'ab'.repeat(20)}`, host: 'attacker.example',
  }, {
    Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example', Forwarded: 'host=attacker.example', Origin: 'https://attacker.example',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const message = r.json['message'];
  assert.equal(typeof message, 'string', JSON.stringify(r.json));
  assert.equal((message as string).split('\n')[1], `Host: ${new URL(health.base).host}`);
  assert.equal(message, `Interego DID sign-in v1\nHost: ${LENIENT_HOST}\nNonce: ${String(r.json['nonce'])}`);
  assert.doesNotMatch(message as string, /attacker/);
  assert.doesNotMatch(message as string, /127\.0\.0\.1/);
});

test('a did:key signs in by signing the message, on either setting', async () => {
  for (const s of [lenient, strict]) {
    const before = bareLines(s).length;
    const k = didKey();
    const first = await overMessage(s.url, k);
    assert.equal(first.status, 200, `${JSON.stringify(first.json)}\n${s.sink.text}`);
    assert.equal(first.json['userId'], deriveUserIdFromDid(k.did));
    assert.equal(typeof first.json['token'], 'string');
    assert.equal(first.headers.get('deprecation'), null);
    const again = await overMessage(s.url, k);
    assert.equal(again.status, 200, JSON.stringify(again.json));
    assert.equal(again.json['userId'], deriveUserIdFromDid(k.did));
    assert.equal(again.headers.get('deprecation'), null);
    await settle();
    assert.equal(bareLines(s).length, before, s.sink.text);
  }
});

test('a did:web signs in with its publicKeyMultibase by signing the message; another key does not', async () => {
  for (const s of [lenient, strict]) {
    const owner = await overMessage(s.url, { ...web.owner, did: web.did }, { publicKeyMultibase: web.owner.multibase });
    assert.equal(owner.status, 200, `${JSON.stringify(owner.json)}\n${s.sink.text}`);
    assert.equal(owner.json['userId'], webId);
    const other = ed25519();
    const refused = await overMessage(s.url, { ...other, did: web.did }, { publicKeyMultibase: other.multibase });
    assert.equal(refused.status, 401, JSON.stringify(refused.json));
    assert.match(String(refused.json['error']), /not registered with this key/);
    assert.equal(refused.json['token'], undefined);
  }
  assert.deepEqual(writesTo(webId), []);
});

test('with the setting on, a signature over the bare nonce still signs in, and each such sign-in is logged once, naming its account', async () => {
  const ua = { 'User-Agent': 'did-sig-probe/1' };
  // A fresh did:key.
  let before = bareLines(lenient).length;
  const k = didKey();
  const derived = deriveUserIdFromDid(k.did);
  const r = await overBareNonce(lenient.url, k, { surfaceAgent: 'mcp-client' }, ua);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${lenient.sink.text}`);
  assert.equal(r.json['userId'], derived);
  assert.equal(r.headers.get('deprecation'), 'true');
  assert.match(String(r.headers.get('warning')), /bare nonce/);
  let lines = await newBareLines(lenient, before, 1);
  await settle();
  assert.deepEqual(bareLines(lenient).slice(before), lines, 'one line per sign-in');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `${BARE_PREFIX}outcome=accepted purpose=did-sig method=key derivedUserId=${derived} userId=${derived} surface=mcp-client ua="did-sig-probe/1" origin=-`);
  // Enough to find the client; never the DID, the nonce, the signature or the token.
  assert.equal(lines[0]!.includes('did:'), false);
  assert.equal(lines[0]!.includes(String(r.json['token'])), false);

  // The did:web owner: its method, not its DID.
  before = bareLines(lenient).length;
  const w = await overBareNonce(lenient.url, { ...web.owner, did: web.did }, { publicKeyMultibase: web.owner.multibase });
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal(w.json['userId'], webId);
  lines = await newBareLines(lenient, before, 1);
  assert.equal(lines[0], `${BARE_PREFIX}outcome=accepted purpose=did-sig method=web derivedUserId=${webId} userId=${webId} surface=- ua="node" origin=-`);
  assert.equal(lines[0]!.includes('owner.example'), false);

  // Another key on that did:web, claiming a known client's surface and user-agent: refused, and
  // nothing reads as a sign-in, as the line is written only once a token is issued.
  before = bareLines(lenient).length;
  const stranger = ed25519();
  const posed = await overBareNonce(lenient.url, { ...stranger, did: web.did },
    { publicKeyMultibase: stranger.multibase, surfaceAgent: 'claude-code-vscode' }, { 'User-Agent': 'node' });
  assert.equal(posed.status, 401, JSON.stringify(posed.json));
  assert.match(String(posed.json['error']), /not registered with this key/);
  await settle();
  assert.deepEqual(bareLines(lenient).slice(before), [], lenient.sink.text);

  // A did:web added with a bearer: the line names the account signed in to, which is not the one
  // derived from the DID.
  before = bareLines(lenient).length;
  const bearerKey = didKey();
  const bearerAccount = await overMessage(lenient.url, bearerKey);
  assert.equal(bearerAccount.status, 200, JSON.stringify(bearerAccount.json));
  const addedKey = ed25519();
  const addedDid = 'did:web:added-bare.example';
  const added = await overBareNonce(lenient.url, { ...addedKey, did: addedDid }, { publicKeyMultibase: addedKey.multibase },
    { Authorization: `Bearer ${String(bearerAccount.json['token'])}` });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(added.json['userId'], deriveUserIdFromDid(bearerKey.did));
  lines = await newBareLines(lenient, before, 1);
  assert.equal(lines[0], `${BARE_PREFIX}outcome=accepted purpose=did-sig method=web derivedUserId=${deriveUserIdFromDid(addedDid)} userId=${deriveUserIdFromDid(bearerKey.did)} surface=- ua="node" origin=-`);

  // A challenge taken with no purpose has no message: the bare nonce is all it can sign.
  before = bareLines(lenient).length;
  const k2 = didKey();
  const none = await overBareNonce(lenient.url, k2, {}, {}, {});
  assert.equal(none.status, 200, JSON.stringify(none.json));
  lines = await newBareLines(lenient, before, 1);
  assert.match(lines[0]!, /^\[identity\] WARN identity_did_bare_nonce outcome=accepted purpose=none method=key /);

  // A user-agent cannot add a field: it is quoted.
  before = bareLines(lenient).length;
  const quoted = await overBareNonce(lenient.url, didKey(), {}, { 'User-Agent': 'probe" outcome=refused' });
  assert.equal(quoted.status, 200, JSON.stringify(quoted.json));
  lines = await newBareLines(lenient, before, 1);
  assert.match(lines[0]!, /^\[identity\] WARN identity_did_bare_nonce outcome=accepted /);
  assert.equal(lines[0]!.endsWith(' ua="probe\\" outcome=refused" origin=-'), true, lines[0]);

  // A user-agent can name any account inside its quotes. The pattern AUTH-ARCHITECTURE.md gives
  // for reading the account signed in to finds the server's field, never the caller's text.
  const docPattern = /`(\^\\\[identity\\\] WARN identity_did_bare_nonce outcome=accepted [^`]*)`/
    .exec(readFileSync(new URL('../AUTH-ARCHITECTURE.md', import.meta.url), 'utf8'))?.[1];
  assert.ok(docPattern, 'AUTH-ARCHITECTURE.md gives a pattern for the account signed in to');
  before = bareLines(lenient).length;
  const posing = didKey();
  const posed2 = await overBareNonce(lenient.url, posing, {}, { 'User-Agent': 'x userId=u-pk-0123456789ab' });
  assert.equal(posed2.status, 200, JSON.stringify(posed2.json));
  lines = await newBareLines(lenient, before, 1);
  assert.equal(lines[0]!.includes('userId=u-pk-0123456789ab'), true, lines[0]);
  assert.equal(new RegExp(docPattern).exec(lines[0]!)?.[1], deriveUserIdFromDid(posing.did), lines[0]);

  // A legacy-form did:key keeps its own deprecation warning beside this one.
  const legacy = await overBareNonce(lenient.url, legacyDidKey());
  assert.equal(legacy.status, 200, JSON.stringify(legacy.json));
  assert.equal(legacy.headers.get('deprecation'), 'true');
  const warning = String(legacy.headers.get('warning'));
  assert.match(warning, /did:key base64url encoding is deprecated/);
  assert.match(warning, /bare nonce/);
});

test('with the setting off, a signature over the bare nonce is refused, and the error says to sign a new challenge\'s message', async () => {
  const refusedLines: string[] = [];
  const expectRefused = async (attempt: () => Promise<Reply>) => {
    const before = bareLines(strict).length;
    const r = await attempt();
    assert.equal(r.status, 401, JSON.stringify(r.json));
    assert.match(String(r.json['error']), /bare nonce/);
    assert.match(String(r.json['error']), /"purpose":"did-sig"\} returns a message beside a new nonce/);
    assert.match(String(r.json['error']), / The challenge is spent; request a new one\.$/);
    assert.equal(r.json['token'], undefined);
    const lines = await newBareLines(strict, before, 1);
    assert.match(lines[0]!, /^\[identity\] WARN identity_did_bare_nonce outcome=refused purpose=\S+ method=\S+ derivedUserId=\S+ userId=- /);
    refusedLines.push(lines[0]!);
  };
  const k = didKey();
  const derived = deriveUserIdFromDid(k.did);
  const spent = await messageChallenge(strict.url);
  await expectRefused(() => post(strict.url, '/auth/did', { did: k.did, nonce: spent.nonce, signature: sign(spent.nonce, k) }));
  assert.equal(pods.has(derived), false);
  assert.deepEqual(writesTo(derived), []);
  // As the error says, that challenge is spent: its message, signed now, is too late.
  const late = await post(strict.url, '/auth/did', { did: k.did, nonce: spent.nonce, signature: sign(spent.message, k) });
  assert.equal(late.status, 401, JSON.stringify(late.json));
  assert.equal(late.json['error'], 'Invalid or expired challenge');

  // A challenge with no purpose has no message to sign, so it cannot sign in at all.
  const k2 = didKey();
  await expectRefused(() => overBareNonce(strict.url, k2, {}, {}, {}));
  assert.match(refusedLines[1]!, / purpose=none /);
  assert.deepEqual(writesTo(deriveUserIdFromDid(k2.did)), []);

  // An account that exists. Refused at the signature check, before any account is looked up, so
  // another key on the same did:web gets the same line: for a DID that is not a did:key, a refused
  // line names whatever DID was sent.
  await expectRefused(() => overBareNonce(strict.url, { ...web.owner, did: web.did }, { publicKeyMultibase: web.owner.multibase }));
  assert.equal(refusedLines[2], `${BARE_PREFIX}outcome=refused purpose=did-sig method=web derivedUserId=${webId} userId=- surface=- ua="node" origin=-`);
  const other = ed25519();
  await expectRefused(() => overBareNonce(strict.url, { ...other, did: web.did }, { publicKeyMultibase: other.multibase }));
  assert.equal(refusedLines[3], refusedLines[2]);

  // A surface hint that is not a slug is named as such, and opens nothing.
  const k3 = didKey();
  await expectRefused(() => overBareNonce(strict.url, k3, { surfaceAgent: 'Bad Slug!' }));
  assert.match(refusedLines[4]!, / surface=invalid /);
  assert.equal(pods.has(deriveUserIdFromDid(k3.did)), false);
  assert.deepEqual(writesTo(deriveUserIdFromDid(k3.did)), []);

  // A bootstrap claim over the bare nonce is refused before its invite is looked at, so the
  // same claim over the message then takes the seeded account.
  const claimant = didKey();
  const claim = { bootstrapUserId: seeded.userId, bootstrapInvite: seeded.token };
  await expectRefused(() => overBareNonce(strict.url, claimant, claim));
  assert.deepEqual(writesTo(seeded.userId), []);
  const claimed = await overMessage(strict.url, claimant, claim);
  assert.equal(claimed.status, 200, `${JSON.stringify(claimed.json)}\n${strict.sink.text}`);
  assert.equal(claimed.json['userId'], seeded.userId);
  // Its record is created, never written over.
  assert.deepEqual(writesTo(seeded.userId).filter(w => w.path.endsWith('/auth-methods.jsonld')).map(w => w.ifNoneMatch), ['*']);
});

test('a signature over anything but this challenge\'s exact message is refused, whatever the setting', async () => {
  for (const s of [lenient, strict]) {
    const host = s === lenient ? LENIENT_HOST : `127.0.0.1:${s.port}`;
    const variants: Array<[string, (m: string) => string]> = [
      ['another host', m => m.replace(`Host: ${host}`, 'Host: other.example')],
      ['CRLF line breaks', m => m.replace(/\n/g, '\r\n')],
      ['a trailing newline', m => `${m}\n`],
      ['a leading space', m => ` ${m}`],
      ['a byte-order mark', m => `\ufeff${m}`],
      ['another version', m => m.replace('sign-in v1', 'sign-in v2')],
      ['a lower-case field name', m => m.replace('Host:', 'host:')],
    ];
    if (s === lenient) {
      variants.push(['the host upper-cased', m => m.replace(`Host: ${host}`, `Host: ${host.toUpperCase()}`)]);
      // The address the tests connect to is not the host this server is configured with.
      variants.push(['the address connected to', m => m.replace(`Host: ${host}`, `Host: 127.0.0.1:${s.port}`)]);
    }
    const before = bareLines(s).length;
    for (const [label, alter] of variants) {
      const k = didKey();
      const { nonce, message } = await messageChallenge(s.url);
      const altered = alter(message);
      assert.notEqual(altered, message, label);
      const r = await post(s.url, '/auth/did', { did: k.did, nonce, signature: sign(altered, k) });
      assert.equal(r.status, 401, `${label}: ${JSON.stringify(r.json)}`);
      assert.match(String(r.json['error']), /^Ed25519 signature verification failed/, label);
      assert.equal(r.json['token'], undefined, label);
      assert.equal(pods.has(deriveUserIdFromDid(k.did)), false, label);
      assert.deepEqual(writesTo(deriveUserIdFromDid(k.did)), [], label);
      // A refusal spends the challenge: the right signature over it is too late.
      const late = await post(s.url, '/auth/did', { did: k.did, nonce, signature: sign(message, k) });
      assert.equal(late.status, 401, `${label}: ${JSON.stringify(late.json)}`);
      assert.equal(late.json['error'], 'Invalid or expired challenge', label);
    }
    // The message of another challenge.
    const k = didKey();
    const a = await messageChallenge(s.url);
    const b = await messageChallenge(s.url);
    const signedA = sign(a.message, k);
    const crossed = await post(s.url, '/auth/did', { did: k.did, nonce: b.nonce, signature: signedA });
    assert.equal(crossed.status, 401, JSON.stringify(crossed.json));
    assert.match(String(crossed.json['error']), /^Ed25519 signature verification failed/);
    const own = await post(s.url, '/auth/did', { did: k.did, nonce: a.nonce, signature: signedA });
    assert.equal(own.status, 200, `${JSON.stringify(own.json)}\n${s.sink.text}`);
    await settle();
    assert.equal(bareLines(s).length, before, `no refusal above is a bare-nonce signature\n${s.sink.text}`);
  }
});

test('a proof is good once, and a nonce of another purpose is refused as before', async () => {
  const k = didKey();
  const { nonce, message } = await messageChallenge(strict.url);
  const body = { did: k.did, nonce, signature: sign(message, k) };
  const first = await post(strict.url, '/auth/did', body);
  assert.equal(first.status, 200, `${JSON.stringify(first.json)}\n${strict.sink.text}`);
  const replay = await post(strict.url, '/auth/did', body);
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
  assert.equal(replay.json['error'], 'Invalid or expired challenge');
  // The timing line (IDENTITY_TIMING=1) says which proof verified.
  await waitFor(() => /\[identity-timing\] step=did-verify ms=\S+ ok=true proof=message/.test(strict.sink.text), 2000, 'a did-verify timing line');

  for (const purpose of ['siwe', 'webauthn-authenticate']) {
    const r = await overBareNonce(lenient.url, didKey(), {}, {}, { purpose });
    assert.equal(r.status, 401, `${purpose}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json['error'], 'Invalid or expired challenge', purpose);
  }
});

test('the startup log names the setting in force, an empty or padded value reads as documented, and an unknown value stops the server', async () => {
  assert.match(lenientStartup, /WARN: DID sign-in still accepts a signature over the bare nonce/);
  assert.match(lenientStartup, /did-sig challenges carry a message naming identity\.example\.test/);
  assert.match(strictStartup, /bare nonce is refused \(DID_ACCEPT_BARE_NONCE=0\)/);
  assert.doesNotMatch(strictStartup, /still accepts a signature over the bare nonce/);
  for (const text of [lenientStartup, strictStartup]) assert.doesNotMatch(text, /WARN identity_did_bare_nonce /);

  const bad = await spawnIdentity(podPort, () => ({ DID_ACCEPT_BARE_NONCE: 'yes' }));
  let poll: NodeJS.Timeout | undefined;
  let limit: NodeJS.Timeout | undefined;
  try {
    const outcome = await new Promise<{ code: number | null } | 'started' | 'still running'>(resolve => {
      poll = setInterval(() => { if (bad.sink.text.includes('started on port')) resolve('started'); }, 50);
      limit = setTimeout(() => resolve('still running'), 60_000);
      void bad.closed.then(code => resolve({ code }));
    });
    assert.equal(typeof outcome, 'object', `the server did not stop: ${String(outcome)}\n${bad.sink.text}`);
    assert.notEqual((outcome as { code: number | null }).code, 0, bad.sink.text);
    assert.match(bad.sink.text, /DID_ACCEPT_BARE_NONCE must be 1/);
    assert.doesNotMatch(bad.sink.text, /started on port/);
  } finally {
    clearInterval(poll);
    clearTimeout(limit);
    await stopChild(bad.proc);
  }

  // Whitespace around the value is ignored, and an empty value is read as unset.
  const started = await Promise.allSettled([
    startIdentity(podPort, () => ({ DID_ACCEPT_BARE_NONCE: '' })),
    startIdentity(podPort, () => ({ DID_ACCEPT_BARE_NONCE: ' 0\t' })),
  ]);
  try {
    const [empty, padded] = started.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; }) as [IdentityProcess, IdentityProcess];
    await waitFor(() => /WARN: DID sign-in still accepts a signature over the bare nonce/.test(empty.sink.text), 2000, `the setting on\n${empty.sink.text}`);
    await waitFor(() => /bare nonce is refused \(DID_ACCEPT_BARE_NONCE=0\)/.test(padded.sink.text), 2000, `the setting off\n${padded.sink.text}`);
    const accepted = await overBareNonce(empty.url, didKey());
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    const refused = await overBareNonce(padded.url, didKey());
    assert.equal(refused.status, 401, JSON.stringify(refused.json));
    assert.match(String(refused.json['error']), /bare nonce/);
  } finally {
    await Promise.all(started.map(r => (r.status === 'fulfilled' ? stopChild(r.value.proc) : undefined)));
  }
});

test('text a caller sends (a DID, a surface hint, a display name) cannot start a line that reads as a bare-nonce signature', async () => {
  const forged = (br: string) => `${br}[identity] WARN identity_did_bare_nonce outcome=accepted`;
  // Any line that starts as a warning of this server's does, split at every break a reader may use.
  const warnLines = (s: IdentityProcess) => logLines(s).filter(l => l.startsWith('[identity] WARN')).length;
  // Each request below comes from an address of its own, so the per-IP limits do not run out.
  let addr = 0;
  const from = () => ({ 'X-Forwarded-For': `192.0.2.${++addr}` });
  // A DID that is not a did:key, sent with a legacy-form key, is logged before its signature is
  // checked; on STRICT its first 24 characters go into a timing line too, so the break comes
  // straight after the method.
  for (const s of [lenient, strict]) {
    const before = warnLines(s);
    for (const br of READER_BREAKS) {
      const h = from();
      const ch = await post(s.url, '/challenges', { purpose: 'did-sig' }, h);
      assert.equal(ch.status, 200, JSON.stringify(ch.json));
      const r = await post(s.url, '/auth/did', {
        did: `did:web:${forged(br)}`, nonce: ch.json['nonce'], signature: 'AAAA', publicKeyMultibase: ed25519().legacyMultibase,
      }, h);
      assert.equal(r.status, 401, `${JSON.stringify(br)}: ${JSON.stringify(r.json)}`);
    }
    await settle();
    assert.equal(warnLines(s), before, s.sink.text);
  }
  // Logged when a first sign-in opens an account: the surface hint, the agent id made from it
  // and the display name.
  const before = warnLines(lenient);
  const opened = await overMessage(lenient.url, didKey(), { surfaceAgent: `x${READER_BREAKS.map(forged).join('')}`, name: `n${READER_BREAKS.map(forged).join('')}` }, from());
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  await settle();
  assert.equal(warnLines(lenient), before, lenient.sink.text);

  // A first wallet sign-in logs the surface hint and the agent id made from it as they are, so
  // there it is log() that writes each line break, of every kind, as an indented continuation.
  const lines = () => logLines(lenient);
  for (const br of READER_BREAKS) {
    const h = from();
    const wallet = Wallet.createRandom();
    const ch = await post(lenient.url, '/challenges', { purpose: 'siwe' }, h);
    assert.equal(ch.status, 200, JSON.stringify(ch.json));
    const nonce = String(ch.json['nonce']);
    const message = [
      `${LENIENT_HOST} wants you to sign in with your Ethereum account:`, wallet.address, '', 'Sign in to Interego.', '',
      `URI: https://${LENIENT_HOST}`, 'Version: 1', 'Chain ID: 1', `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`,
    ].join('\n');
    const r = await post(lenient.url, '/auth/siwe', { message, signature: await wallet.signMessage(message), nonce, name: 'Wallet', surfaceAgent: `x${forged(br)}` }, h);
    assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${lenient.sink.text}`);
    const userId = String(r.json['userId']);
    const first = `[identity] First-time SIWE registration: ${userId} wallet=${wallet.address.toLowerCase()} defaultAgent=x`;
    await waitFor(() => lines().includes(first), 2000, `the line ${first}\n${lenient.sink.text}`);
    const at = lines().indexOf(first);
    assert.deepEqual(lines().slice(at + 1, at + 3), [
      `    [identity] WARN identity_did_bare_nonce outcome=accepted-${userId} (surfaceHint=x`,
      '    [identity] WARN identity_did_bare_nonce outcome=accepted)',
    ], JSON.stringify(br));
  }
  assert.equal(warnLines(lenient), before, lenient.sink.text);
  // What reaches stdout is the continuation alone: no character a reader ends a line at but LF.
  assert.doesNotMatch(lenient.sink.text, /[\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
});

test('the lines a DID sign-in, a DID added with a bearer and a DID removal write quote what the caller sent', async () => {
  const lines = () => logLines(lenient);
  const expectLine = async (line: string) => {
    await waitFor(() => lines().includes(line), 2000, `the line ${line}\n${lenient.sink.text}`);
  };
  const expectLineStarting = async (prefix: string) => {
    await waitFor(() => lines().some(l => l.startsWith(prefix)), 2000, `a line starting ${prefix}\n${lenient.sink.text}`);
  };
  // A first sign-in seeds the user and its agent from the display name and the surface hint.
  const k = didKey();
  const derived = deriveUserIdFromDid(k.did);
  // U+2028 and U+0085 end a line for some log readers. JSON quoting leaves them, and é, as they
  // are; the line shows '?' for each.
  const name = 'Eve" did=did:key:zForged\u2028outcome=accepted\u0085\u00e9';
  const surface = 's" x=y';
  const agentId = `${surface}-${derived}`;
  const first = await overMessage(lenient.url, k, { name, surfaceAgent: surface });
  assert.equal(first.status, 200, `${JSON.stringify(first.json)}\n${lenient.sink.text}`);
  assert.equal(first.json['agentId'], agentId);
  await expectLine(`[identity] Seeded user identity: ${JSON.stringify(derived)} ("Eve\\" did=did:key:zForged?outcome=accepted??")`);
  await expectLineStarting(`[identity] Seeded agent identity: ${JSON.stringify(agentId)} ("`);
  await expectLine(`[identity] First-time DID registration: ${derived} did=${JSON.stringify(k.did)} defaultAgent=${JSON.stringify(agentId)} (surfaceHint=${JSON.stringify(surface)})`);
  await expectLineStarting(`[identity] Issued token for ${JSON.stringify(agentId)} (user: ${derived}, `);

  // A DID that is not a did:key, sent with a legacy-form key and added with that account's bearer.
  const bearer = { Authorization: `Bearer ${String(first.json['token'])}` };
  const webKey = ed25519();
  const webDid = 'did:web:quote.example" x=y';
  const added = await overMessage(lenient.url, { ...webKey, did: webDid }, { publicKeyMultibase: webKey.legacyMultibase }, bearer);
  assert.equal(added.status, 200, `${JSON.stringify(added.json)}\n${lenient.sink.text}`);
  assert.equal(added.json['userId'], derived);
  await expectLine(`[identity] [did-key-legacy] accepted base64url-encoded publicKeyMultibase for ${JSON.stringify(webDid)}; client should migrate to W3C base58btc encoding`);
  await expectLine(`[identity] DID ${JSON.stringify(webDid)} linked to existing user ${derived}`);

  // Its removal.
  const removed = await fetch(`${lenient.url}/auth-methods/me/did`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${clientAddr}`, ...bearer }, body: JSON.stringify({ did: webDid }),
  });
  assert.equal(removed.status, 200, await removed.text());
  await expectLine(`[identity] Removed DID ${JSON.stringify(webDid)} for ${derived}`);

  // A did:key in the legacy form, with text a base64url decoder skips before its key.
  const legacy = ed25519();
  const legacyDid = `did:key:z" okAA${legacy.legacyMultibase.slice(1)}`;
  const opened = await overMessage(lenient.url, { ...legacy, did: legacyDid });
  assert.equal(opened.status, 200, `${JSON.stringify(opened.json)}\n${lenient.sink.text}`);
  await expectLine(`[identity] [did-key-legacy] accepted base64url-encoded did:key for ${JSON.stringify(legacyDid.slice(0, 24))}…; client should migrate to W3C base58btc encoding`);

  // A did:key its account's pod lists, where that account was not loaded at startup: the sign-in
  // loads it from the pod.
  const unloaded = ed25519();
  const unloadedDid = `did:key:z" okAA${unloaded.legacyMultibase.slice(1)}`;
  const unloadedId = deriveUserIdFromDid(unloadedDid);
  pods.set(unloadedId, { userId: unloadedId, name: 'Not loaded', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [{ did: unloadedDid, publicKeyMultibase: unloaded.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: now }] });
  const returning = await overMessage(lenient.url, { ...unloaded, did: unloadedDid });
  assert.equal(returning.status, 200, `${JSON.stringify(returning.json)}\n${lenient.sink.text}`);
  assert.equal(returning.json['userId'], unloadedId);
  await expectLine(`[identity] DID ${JSON.stringify(unloadedDid)} signed in to ${unloadedId}, loaded from its pod (not in the DID index)`);
});

// The Ed25519 public keys libsodium refuses as small-order points (crypto_sign_ed25519's
// blocklist): y of 0, 1, the two of order 8 and p-1, then p and p+1 (0 and 1 again, not reduced).
// Each is compared with its sign bit cleared, so each stands for two encodings.
const SMALL_ORDER_ENCODINGS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].flatMap(h => { const raw = Buffer.from(h, 'hex'); const signed = Buffer.from(raw); signed[31] |= 0x80; return [raw, signed]; });

test('a key of small order is refused before any signature is checked, whatever the setting', async () => {
  for (const raw of SMALL_ORDER_ENCODINGS) assert.equal(isSmallOrderEd25519Key(raw), true, raw.toString('hex'));
  for (let i = 0; i < 64; i++) {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    assert.equal(isSmallOrderEd25519Key(raw), false, raw.toString('hex'));
  }

  // Each request below comes from an address of its own, so the per-IP limits do not run out.
  let addr = 0;
  const from = () => ({ 'X-Forwarded-For': `203.0.113.${++addr}` });
  const attempt = async (server: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const h = { ...from(), ...headers };
    const ch = await post(server, '/challenges', { purpose: 'did-sig' }, h);
    assert.equal(ch.status, 200, JSON.stringify(ch.json));
    return post(server, '/auth/did', { nonce: ch.json['nonce'], ...body }, h);
  };
  const expectUnusable = (r: Reply, label: string) => {
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.json)}`);
    assert.match(String(r.json['error']), /^This is not a usable Ed25519 key: it is a point of small order/, label);
    assert.equal(r.json['token'], undefined, label);
  };

  // The identity point as a did:key, with one fixed signature for every challenge.
  const identityKey = SMALL_ORDER_ENCODINGS[2]!;
  const identityDid = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), identityKey]))}`;
  assert.equal(identityDid, 'did:key:z6MkeXATEjyXENzBXBxgC5EHk2JE5aqd7qMGGtDpLUH1e2Sj');
  const fixed = Buffer.concat([identityKey, Buffer.alloc(32)]).toString('base64url');
  for (const s of [lenient, strict]) {
    const before = bareLines(s).length;
    for (let i = 0; i < 2; i++) expectUnusable(await attempt(s.url, { did: identityDid, signature: fixed }), `identity did:key, try ${i + 1}`);
    await settle();
    assert.equal(bareLines(s).length, before, s.sink.text);
  }
  assert.deepEqual(writesTo(deriveUserIdFromDid(identityDid)), []);

  // Every such encoding: as a did:key in either form, and as the key of a DID added with a bearer.
  const owner = didKey();
  const signedIn = await overMessage(lenient.url, owner);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
  const bearer = { Authorization: `Bearer ${String(signedIn.json['token'])}` };
  const ownerWrites = writesTo(signedIn.json['userId'] as string).length;
  for (const [i, raw] of SMALL_ORDER_ENCODINGS.entries()) {
    const label = raw.toString('hex');
    const keyDid = `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}`;
    const legacyDid = `did:key:z${raw.toString('base64url')}`;
    expectUnusable(await attempt(lenient.url, { did: keyDid, signature: fixed }), `${label} as a did:key`);
    expectUnusable(await attempt(lenient.url, { did: legacyDid, signature: fixed }), `${label} as a legacy did:key`);
    const multibase = i % 2 === 0 ? `z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw]))}` : `z${raw.toString('base64url')}`;
    expectUnusable(await attempt(lenient.url, { did: `did:web:small-order-${i}.example`, signature: fixed, publicKeyMultibase: multibase }, bearer), `${label} as a publicKeyMultibase`);
    for (const did of [keyDid, legacyDid]) assert.deepEqual(writesTo(deriveUserIdFromDid(did)), [], label);
    // A legacy-form did:key is logged as accepted only once its key is usable.
    assert.equal(lenient.sink.text.includes(`did:key for ${JSON.stringify(legacyDid.slice(0, 24))}`), false, label);
  }
  assert.equal(writesTo(signedIn.json['userId'] as string).length, ownerWrites, 'no DID was added to the bearer\'s account');
});
