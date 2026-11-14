/**
 * Linking a general guest to a registered account, on the running identity server
 * (provisional-guest-link.ts, provisional-guest-link-routes.ts): what the routes answer with the
 * setting off (nothing), what a bearer can and cannot do without a fresh credential proof, the
 * whole ceremony through the door, what introspection states before and after, and that a
 * registered account's record and its sign-in, sign-out and deletion are what they were.
 *
 * server.ts runs as a child process over a stand-in pod and relay, as in
 * provisional-general-guest-routes.test.ts. Every account is a wallet generated here; the names are
 * fictional. No live identity, pod or relay is called.
 */
import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet, type HDNodeWallet } from 'ethers';
import { closeServer, stopChild } from './teardown.js';
import { publicJwk } from './public-jwk.js';
import { assertion, softPasskey } from './soft-authenticator.js';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../provisional-play.js';
import { claimProofPayload, doorProofPayload } from '../provisional-general-guest.js';
import { linkPreviewPayload, linkProofPayload } from '../provisional-guest-link.js';

const game = 'https://play.example';
const gameAgent = { agentDid: 'did:web:identity.example:agents:game', podUrl: 'https://pods.example/game/' };
const service = Wallet.createRandom();
const signingKey = crypto.randomBytes(32);

const documents = new Map<string, { body: string; revision: number }>();
function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/' && req.method !== 'PUT') {
    const pods = new Set([...documents.keys()].filter(p => p.includes('/', 1)).map(p => p.split('/')[1]!));
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(req.method === 'HEAD' ? undefined : pods.size
      ? `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...pods].map(p => `<${p}/>`).join(', ')} .\n` : '');
    return;
  }
  if (req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      if (path.endsWith('/')) { res.writeHead(201).end(); return; }
      const current = documents.get(path);
      const ifMatch = req.headers['if-match'];
      if ((req.headers['if-none-match'] === '*' && current) || (ifMatch && ifMatch !== `"${current?.revision}"`)) { res.writeHead(412).end(); return; }
      documents.set(path, { body, revision: (current?.revision ?? 0) + 1 });
      res.writeHead(current ? 205 : 201, { ETag: `"${(current?.revision ?? 0) + 1}"` }).end();
    });
    return;
  }
  const current = documents.get(path);
  if ((req.method === 'GET' || req.method === 'HEAD') && current) {
    res.writeHead(200, { 'Content-Type': path.endsWith('.jsonld') ? 'application/ld+json' : 'application/json', ETag: `"${current.revision}"` });
    res.end(req.method === 'HEAD' ? undefined : current.body);
    return;
  }
  res.writeHead(404).end();
}
function serveRelay(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = '';
  req.on('data', chunk => { body += String(chunk); });
  req.on('end', () => {
    if (req.url !== '/tool/verify_agent') { res.writeHead(404).end(); return; }
    const asked = JSON.parse(body) as { pod_url: string };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ verified: true, subject_pod_url: asked.pod_url, signing: { relayAnchor: service.address, canSignDelegatedRequests: true } }));
  });
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}
interface Server { child: ChildProcess; base: string; output: () => string }
let podServer: http.Server;
let relayServer: http.Server;
const servers: Server[] = [];
async function startIdentity(extraEnv: (port: number) => Record<string, string>): Promise<Server> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GENERAL_GUEST_DOOR_ORIGIN', 'IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS', 'PROVISIONAL_GENERAL_GUEST',
    'HOSTED_TERMS_VERSION', 'PROVISIONAL_PLAY_TTL_SECONDS', 'PROVISIONAL_PLAY_MAX_PODS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${(podServer.address() as net.AddressInfo).port}/`,
    CSS_PUBLIC_URL: 'https://pods.example/', RELAY_URL: `http://127.0.0.1:${(relayServer.address() as net.AddressInfo).port}`,
    TOKEN_SIGNING_KEY: signingKey.toString('base64'), JANITOR_INTERVAL_MS: '0', ALLOW_OPEN_INTROSPECTION: '1', ...extraEnv(port),
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', d => { out += String(d); });
  child.stderr!.on('data', d => { out += String(d); });
  const server: Server = { child, base, output: () => out };
  servers.push(server);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`identity server exited ${child.exitCode}:\n${out}`);
    try {
      const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      if ((health['accountIndex'] as { complete: boolean }).complete) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${out}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return server;
}

let off: Server;
let on: Server;
/** As `on`, with the door on an origin of its own: the same process under the name `localhost`. */
let dedicated: Server;
const doorOriginOf = (server: Server) => server.base.replace('127.0.0.1', 'localhost');
before(async () => {
  podServer = http.createServer(servePods);
  relayServer = http.createServer(serveRelay);
  await Promise.all([podServer, relayServer].map(s => new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))));
  const clients = JSON.stringify({ [game]: { ...gameAgent, generalGuest: true, generalGuestReturnPath: '/guest/return' } });
  [off, on, dedicated] = await Promise.all([
    startIdentity(() => ({ PROVISIONAL_PLAY_CLIENTS: clients })),
    startIdentity(() => ({ PROVISIONAL_PLAY_CLIENTS: clients, PROVISIONAL_GENERAL_GUEST: '1' })),
    startIdentity(port => ({ PROVISIONAL_PLAY_CLIENTS: clients, PROVISIONAL_GENERAL_GUEST: '1', GENERAL_GUEST_DOOR_ORIGIN: `http://localhost:${port}` })),
  ]);
});
after(async () => {
  await Promise.all(servers.map(s => stopChild(s.child)));
  await closeServer(podServer);
  await closeServer(relayServer);
});

interface Answer { status: number; text: string; body: Record<string, unknown>; headers: Headers }
async function call(server: Server, method: string, path: string, opts: { body?: unknown; bearer?: string; origin?: string } = {}): Promise<Answer> {
  const response = await fetch(`${server.base}${path}`, { method, redirect: 'manual',
    headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.origin ? { Origin: opts.origin } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: response.status, text, body, headers: response.headers };
}
/** A request to `server` under the host name `host` (the door's, or identity's own), whatever address it is sent to. */
function hosted(server: Server, host: string, method: string, path: string, opts: { body?: unknown; origin?: string } = {}): Promise<{ status: number; text: string }> {
  const target = new URL(server.base);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: target.port, method, path,
      headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(opts.origin ? { Origin: opts.origin } : {}) } },
    response => { let text = ''; response.on('data', chunk => { text += String(chunk); }); response.on('end', () => resolve({ status: response.statusCode ?? 0, text })); });
    request.on('error', reject);
    request.end(payload);
  });
}
type Pair = crypto.KeyPairKeyObjectResult;
const newPair = (): Pair => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwkOf = (pair: Pair) => publicPlayKey(publicJwk(pair.publicKey));
const thumbprintOf = (pair: Pair) => playKeyThumbprint(jwkOf(pair));
const guestIdOf = (pair: Pair) => generalGuestUserId(thumbprintOf(pair));
const sign = (pair: Pair, text: string) => crypto.sign('sha256', Buffer.from(text), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const sha = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
const didOf = (server: Server, userId: string) => `did:web:${new URL(server.base).host}:users:${userId}`;
const recordOf = (userId: string) => JSON.parse(documents.get(`/${userId}/auth-methods.jsonld`)!.body) as Record<string, unknown>;
const bytesOf = (userId: string) => documents.get(`/${userId}/auth-methods.jsonld`)!.body;

/** A registered account: a wallet signs in the supported way, which creates its account on first use. */
async function signIn(server: Server, wallet: HDNodeWallet): Promise<{ token: string; userId: string }> {
  const nonce = (await call(server, 'POST', '/challenges', { body: { purpose: 'siwe' } })).body['nonce'] as string;
  const message = `${new URL(server.base).host} wants you to sign in with your Ethereum account:\n${wallet.address}\n\nSign in to Interego.\n\nURI: ${server.base}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  const signed = await call(server, 'POST', '/auth/siwe', { body: { message, nonce, signature: await wallet.signMessage(message) }, origin: server.base });
  assert.equal(signed.status, 200, signed.text);
  return { token: signed.body['token'] as string, userId: signed.body['userId'] as string };
}
/** The owner's fresh proof by the wallet already on the account, for one action. */
async function prepare(server: Server, wallet: HDNodeWallet, token: string, action: Record<string, unknown>) {
  const prepared = await call(server, 'POST', '/guest/link/prepare', { bearer: token, origin: server.base, body: { ...action, method: 'wallet', address: wallet.address, chainId: 1 } });
  assert.equal(prepared.status, 200, prepared.text);
  return { stepUpId: prepared.body['stepUpId'] as string, message: prepared.body['message'] as string, signature: await wallet.signMessage(prepared.body['message'] as string) };
}
async function codeFor(server: Server, wallet: HDNodeWallet, token: string): Promise<string> {
  const step = await prepare(server, wallet, token, { action: 'code' });
  const issued = await call(server, 'POST', '/guest/link/code', { bearer: token, origin: server.base, body: { stepUpId: step.stepUpId, signature: step.signature } });
  assert.equal(issued.status, 200, issued.text);
  return issued.body['code'] as string;
}
/** An application visit for `pair` through the door at `door`: the exchange's answer. */
async function enter(server: Server, pair: Pair, door = server.base) {
  const now = Math.floor(Date.now() / 1000);
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const payload = JSON.stringify({ purpose: 'interego-general-guest-v1', audience: game, state, codeChallenge: sha(verifier), expiresAt: now + 60,
    agent_id: gameAgent.agentDid, subject_pod_url: gameAgent.podUrl, timestamp: new Date(now * 1000).toISOString() });
  const playGrant = { _signed_payload: payload, _signature: await service.signMessage(`sha256:${crypto.createHash('sha256').update(payload, 'utf8').digest('hex')}`) };
  const admitted = await hosted(server, new URL(door).host, 'POST', '/guest/door', { origin: door,
    body: { playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(playGrant)) } });
  assert.equal(admitted.status, 200, admitted.text);
  const back = new URL((JSON.parse(admitted.text) as { redirect: string }).redirect);
  const exchanged = await call(server, 'POST', '/guest/exchange', { body: { code: back.searchParams.get('code'), codeVerifier: verifier, audience: game, state } });
  assert.equal(exchanged.status, 200, exchanged.text);
  return exchanged.body as { token: string; subjectAttributes: Record<string, unknown>; ownerDid: string };
}
/** The door page's link request, at the door `door`: without `account` it asks which account the code names. */
async function doorLink(server: Server, pair: Pair, code: string, account?: string, door = server.base) {
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const text = account === undefined ? linkPreviewPayload(server.base, thumbprintOf(pair), code, expiresAt) : linkProofPayload(server.base, thumbprintOf(pair), code, expiresAt, account);
  const answered = await hosted(server, new URL(door).host, 'POST', '/guest/door/link', { origin: door,
    body: { publicKeyJwk: jwkOf(pair), code, expiresAt, proof: sign(pair, text), ...(account !== undefined ? { account } : {}) } });
  return { status: answered.status, body: JSON.parse(answered.text) as Record<string, unknown> };
}
const introspect = async (server: Server, token: string) => (await call(server, 'POST', '/tokens/verify', { body: { token } })).body;

/** The members of a registered account's record, in the order the server writes them. Nothing of a guest link is among them. */
const ACCOUNT_KEYS = ['@context', '@id', '@type', 'userId', 'name', 'walletAddresses', 'webAuthnCredentials', 'didKeys', 'agentId', 'sessionEpoch'];

test('with the setting off, the link\'s paths answer exactly as a path that never existed, and an account\'s record is written as it always was', async () => {
  const wallet = Wallet.createRandom();
  const owner = await signIn(off, wallet);
  const pair = newPair();
  const cases: Array<[string, string, unknown]> = [
    ['GET', '/guest/link/guests', undefined],
    ['POST', '/guest/link/prepare', { action: 'code', method: 'wallet', address: wallet.address, chainId: 1 }],
    ['POST', '/guest/link/code', { stepUpId: 'x', signature: 'y' }],
    ['POST', '/guest/link/unlink', { stepUpId: 'x', signature: 'y' }],
    ['POST', '/guest/door/link', { publicKeyJwk: jwkOf(pair), code: `${owner.userId}:000000000000`, expiresAt: 1, proof: 'x' }],
  ];
  for (const [method, path, body] of cases) {
    const answered = await call(off, method, path, { body, origin: off.base, bearer: owner.token });
    const unknown = await call(off, method, '/a-path-that-never-existed', { body, origin: off.base, bearer: owner.token });
    assert.equal(answered.status, 404, `${method} ${path}`);
    assert.equal(answered.text.replace(path, 'P'), unknown.text.replace('/a-path-that-never-existed', 'P'), `${method} ${path}`);
  }
  assert.ok(!('generalGuest' in (await call(off, 'GET', '/.well-known/play-provisional')).body));
  // The dashboard has no guest-link section, and with the setting on it has one that names the door.
  assert.doesNotMatch((await call(off, 'GET', '/dashboard')).text, /guest-link|Link a guest/);
  const dashboard = (await call(dedicated, 'GET', '/dashboard')).text;
  assert.match(dashboard, /id="guest-link-settings"/);
  assert.ok(dashboard.includes(JSON.stringify(`${doorOriginOf(dedicated)}/guest/door#link`)));
  // A write through the server's own writer (a sign-out everywhere): the record's members, in order.
  assert.equal((await call(off, 'POST', '/tokens/me/sign-out-everywhere', { bearer: owner.token })).status, 200);
  assert.deepEqual(Object.keys(recordOf(owner.userId)), ACCOUNT_KEYS);
});

test('a bearer alone gets no code and unlinks nothing: each needs a fresh proof by a credential on the account, bound to that action', async () => {
  const wallet = Wallet.createRandom();
  const owner = await signIn(on, wallet);
  const untouched = bytesOf(owner.userId);
  const post = (path: string, body: unknown, opts: { bearer?: string; origin?: string } = { bearer: owner.token, origin: on.base }) => call(on, 'POST', path, { body, ...opts });
  // No step, an unknown step, no bearer, another site's request.
  assert.equal((await post('/guest/link/code', {})).status, 401);
  assert.equal((await post('/guest/link/code', { stepUpId: crypto.randomBytes(32).toString('base64url'), signature: `0x${'00'.repeat(65)}` })).body['error'], 'link_expired');
  assert.equal((await post('/guest/link/prepare', { action: 'code', method: 'wallet', address: wallet.address, chainId: 1 }, { origin: on.base })).status, 403);
  assert.equal((await post('/guest/link/prepare', { action: 'code', method: 'wallet', address: wallet.address, chainId: 1 }, { bearer: owner.token, origin: game })).status, 403);
  assert.equal((await post('/guest/link/prepare', { action: 'code', method: 'wallet', address: wallet.address, chainId: 1 }, { bearer: owner.token })).status, 403, 'no Origin header');
  // A wallet that is not on the account, a passkey where the account has none, an action that is neither.
  assert.equal((await post('/guest/link/prepare', { action: 'code', method: 'wallet', address: Wallet.createRandom().address, chainId: 1 })).status, 400);
  assert.equal((await post('/guest/link/prepare', { action: 'code', method: 'passkey' })).body['error'], 'no_link_passkey');
  assert.equal((await post('/guest/link/prepare', { action: 'adopt', method: 'wallet', address: wallet.address, chainId: 1 })).status, 400);
  assert.equal((await post('/guest/link/prepare', { action: 'unlink', guest: owner.userId, method: 'wallet', address: wallet.address, chainId: 1 })).status, 400);
  // A prepared step with no signature, and with another wallet's signature: no code, and the step is spent.
  const unsigned = await prepare(on, wallet, owner.token, { action: 'code' });
  assert.ok(unsigned.message.includes(`Authorize a code that links one guest to ${didOf(on, owner.userId)}`));
  assert.equal((await post('/guest/link/code', { stepUpId: unsigned.stepUpId })).body['error'], 'link_proof_required');
  assert.equal((await post('/guest/link/code', { stepUpId: unsigned.stepUpId, signature: unsigned.signature })).body['error'], 'link_expired', 'a step is finished once, however it ended');
  const forged = await prepare(on, wallet, owner.token, { action: 'code' });
  const refusedProof = await post('/guest/link/code', { stepUpId: forged.stepUpId, signature: await Wallet.createRandom().signMessage(forged.message) });
  assert.equal(refusedProof.status, 401, refusedProof.text);
  // A proof for one action is not a proof for the other.
  const guest = newPair();
  const toUnlink = await prepare(on, wallet, owner.token, { action: 'unlink', guest: guestIdOf(guest) });
  assert.ok(toUnlink.message.includes(`Authorize unlinking the guest ${guestIdOf(guest)} from `));
  assert.equal((await post('/guest/link/code', { stepUpId: toUnlink.stepUpId, signature: toUnlink.signature })).body['error'], 'link_expired');
  const toCode = await prepare(on, wallet, owner.token, { action: 'code' });
  assert.equal((await post('/guest/link/unlink', { stepUpId: toCode.stepUpId, signature: toCode.signature })).body['error'], 'link_expired');
  // Another account's bearer does not finish this account's step.
  const otherWallet = Wallet.createRandom();
  const other = await signIn(on, otherWallet);
  const mine = await prepare(on, wallet, owner.token, { action: 'code' });
  assert.equal((await post('/guest/link/code', { stepUpId: mine.stepUpId, signature: mine.signature }, { bearer: other.token, origin: on.base })).body['error'], 'link_expired');
  // A guest's own bearer (the door's token) is no account owner's.
  const exchanged = await enter(on, guest);
  const at = Math.floor(Date.now() / 1000) + 60;
  const doorToken = (await call(on, 'POST', '/guest/door/claim', { origin: on.base,
    body: { publicKeyJwk: jwkOf(guest), expiresAt: at, proof: sign(guest, claimProofPayload(on.base, thumbprintOf(guest), at)) } })).body['token'] as string;
  for (const bearer of [doorToken, exchanged.token]) {
    assert.equal((await post('/guest/link/prepare', { action: 'code', method: 'wallet', address: wallet.address, chainId: 1 }, { bearer, origin: on.base })).status, 401);
    assert.equal((await call(on, 'GET', '/guest/link/guests', { bearer })).status, 401);
  }
  assert.equal(bytesOf(owner.userId), untouched, 'none of this wrote the account\'s record');
  assert.equal(recordOf(owner.userId)['guestLinkCode'], undefined);
});

test('the ceremony on the running server: a code from the signed-in account, entered at the door, and introspection then states the link', async () => {
  const wallet = Wallet.createRandom();
  const owner = await signIn(on, wallet);
  const ownerDid = didOf(on, owner.userId);
  const before = bytesOf(owner.userId);
  const pair = newPair(); const guestId = guestIdOf(pair);
  const visit = await enter(on, pair);
  assert.equal(visit.subjectAttributes['linkedTo'], undefined);
  assert.equal((await introspect(on, visit.token))['valid'], true);

  // A claim opened BEFORE the link: the door's token for this guest, which is its bearer for now.
  const early = Math.floor(Date.now() / 1000) + 59;
  const doorToken = (await call(on, 'POST', '/guest/door/claim', { origin: on.base,
    body: { publicKeyJwk: jwkOf(pair), expiresAt: early, proof: sign(pair, claimProofPayload(on.base, thumbprintOf(pair), early)) } })).body['token'] as string;
  assert.equal((await introspect(on, doorToken))['valid'], true);

  const code = await codeFor(on, wallet, owner.token);
  assert.equal(code.split(':')[0], owner.userId);
  // The door's link request is the door page's alone.
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const preview = { publicKeyJwk: jwkOf(pair), code, expiresAt, proof: sign(pair, linkPreviewPayload(on.base, thumbprintOf(pair), code, expiresAt)) };
  assert.equal((await call(on, 'POST', '/guest/door/link', { body: preview, origin: game })).status, 403);
  assert.equal((await call(on, 'POST', '/guest/door/link', { body: preview })).status, 403, 'no Origin header');
  const shown = await doorLink(on, pair, code);
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, { linked: false, account: { did: ownerDid, userId: owner.userId, name: (recordOf(owner.userId)['name'] as string) } });
  assert.equal(((await introspect(on, visit.token))['subjectAttributes'] as Record<string, unknown>)['linkedTo'], undefined, 'asking which account links nothing');
  const linked = await doorLink(on, pair, code, ownerDid);
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body['linked'], true);

  // Introspection of the guest's application token, and a new exchange, both state the link.
  const stated = (await introspect(on, visit.token))['subjectAttributes'] as Record<string, unknown>;
  assert.equal(stated['linkedTo'], ownerDid);
  assert.equal(stated['subject'], visit.ownerDid);
  assert.equal((await enter(on, pair)).subjectAttributes['linkedTo'], ownerDid);
  const guests = await call(on, 'GET', '/guest/link/guests', { bearer: owner.token, origin: on.base });
  assert.deepEqual((guests.body['guests'] as Array<{ userId: string }>).map(row => row.userId), [guestId]);
  // The claim opened before the link is over: its token is no bearer once the guest is linked, so
  // it cannot go on to give the guest a credential of its own.
  const lapsed = await introspect(on, doorToken);
  assert.equal(lapsed['valid'], false);
  assert.equal(lapsed['reason'], 'Guest is linked to an account');
  // The code is spent: a second guest with it gets nothing.
  const second = newPair(); await enter(on, second);
  assert.equal((await doorLink(on, second, code)).body['error'], 'invalid_link_code');
  // A linked guest is not given the claim flow.
  const at = Math.floor(Date.now() / 1000) + 61;
  assert.equal((await call(on, 'POST', '/guest/door/claim', { origin: on.base,
    body: { publicKeyJwk: jwkOf(pair), expiresAt: at, proof: sign(pair, claimProofPayload(on.base, thumbprintOf(pair), at)) } })).body['error'], 'guest_linked');

  // The account itself is as it was: it signs in, and a write by the server's own writer keeps the link.
  const again = await signIn(on, wallet);
  assert.equal(again.userId, owner.userId);
  assert.deepEqual(Object.keys(recordOf(owner.userId)).filter(key => key !== 'sessionEpoch'), [...ACCOUNT_KEYS.filter(key => key !== 'sessionEpoch'), 'linkedGuests']);
  assert.equal(((await introspect(on, visit.token))['subjectAttributes'] as Record<string, unknown>)['linkedTo'], ownerDid);

  // Unlinking needs the bearer and a fresh proof naming that guest, and removes both sides.
  const step = await prepare(on, wallet, again.token, { action: 'unlink', guest: guestId });
  const unlinked = await call(on, 'POST', '/guest/link/unlink', { bearer: again.token, origin: on.base, body: { stepUpId: step.stepUpId, signature: step.signature } });
  assert.deepEqual(unlinked.body, { unlinked: true, wasLinked: true });
  assert.equal(((await introspect(on, visit.token))['subjectAttributes'] as Record<string, unknown>)['linkedTo'], undefined);
  assert.equal(recordOf(guestId)['provisionalGuestLinkedTo'], undefined);
  assert.deepEqual((await call(on, 'GET', '/guest/link/guests', { bearer: again.token, origin: on.base })).body['guests'], []);
  assert.equal(bytesOf(owner.userId), before, 'an account whose guest was unlinked is the bytes it was before it ever asked for a code');
});

test('sign-out everywhere and deletion of a linked account behave as before; a deleted account\'s guest is no longer stated as linked', async () => {
  const door = doorOriginOf(dedicated);
  const wallet = Wallet.createRandom();
  const owner = await signIn(dedicated, wallet);
  const pair = newPair(); const guestId = guestIdOf(pair);
  const visit = await enter(dedicated, pair, door);
  const code = await codeFor(dedicated, wallet, owner.token);
  assert.equal((await doorLink(dedicated, pair, code, didOf(dedicated, owner.userId), door)).body['linked'], true);
  // Sign-out everywhere: the old bearer ends, the link stays on the record the writer wrote.
  assert.equal((await call(dedicated, 'POST', '/tokens/me/sign-out-everywhere', { bearer: owner.token })).status, 200);
  assert.equal((await call(dedicated, 'GET', '/me', { bearer: owner.token })).status, 401);
  assert.ok('linkedGuests' in recordOf(owner.userId));
  assert.deepEqual(Object.keys(recordOf(owner.userId)).filter(key => key !== 'linkedGuests'), ACCOUNT_KEYS, 'every other member is where it always was');
  assert.equal(((await introspect(dedicated, visit.token))['subjectAttributes'] as Record<string, unknown>)['linkedTo'], didOf(dedicated, owner.userId));
  // Deletion: the tombstone lists nobody, so the guest is itself again.
  const fresh = await signIn(dedicated, wallet);
  const deleted = await call(dedicated, 'POST', '/users/me/delete', { bearer: fresh.token, body: {} });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(typeof recordOf(owner.userId)['deletedAt'], 'string');
  assert.equal(recordOf(owner.userId)['linkedGuests'], undefined);
  const after = await introspect(dedicated, visit.token);
  assert.equal(after['valid'], true);
  assert.equal((after['subjectAttributes'] as Record<string, unknown>)['linkedTo'], undefined);
  assert.equal((recordOf(guestId)['provisionalGuestLinkedTo'] as { userId: string }).userId, owner.userId, 'the guest\'s side alone states nothing');
});

test('with a dedicated door origin, the link request exists on the door\'s host alone and the account\'s routes on identity\'s alone', async () => {
  const door = doorOriginOf(dedicated);
  const doorHost = new URL(door).host;
  const mainHost = new URL(dedicated.base).host;
  const wallet = Wallet.createRandom();
  const owner = await signIn(dedicated, wallet);
  const pair = newPair();
  await enter(dedicated, pair, door);
  const code = await codeFor(dedicated, wallet, owner.token);
  // Identity's own host has no door link, and the door's host has none of the account's routes.
  assert.equal((await hosted(dedicated, mainHost, 'POST', '/guest/door/link', { body: {}, origin: dedicated.base })).status, 404);
  for (const [method, path] of [['GET', '/guest/link/guests'], ['POST', '/guest/link/prepare'], ['POST', '/guest/link/code'], ['POST', '/guest/link/unlink'], ['POST', '/guest/door/link/x']] as const) {
    assert.equal((await hosted(dedicated, doorHost, method, path, method === 'POST' ? { body: {}, origin: door } : {})).status, 404, `${method} ${path} on the door's host`);
  }
  // Answered for the door's own origin only.
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const preview = { publicKeyJwk: jwkOf(pair), code, expiresAt, proof: sign(pair, linkPreviewPayload(dedicated.base, thumbprintOf(pair), code, expiresAt)) };
  for (const origin of [dedicated.base, game, undefined]) assert.equal((await hosted(dedicated, doorHost, 'POST', '/guest/door/link', { body: preview, origin })).status, 403, String(origin));
  const ownerDid = didOf(dedicated, owner.userId);
  assert.equal((await doorLink(dedicated, pair, code, undefined, door)).body['linked'], false);
  assert.equal((await doorLink(dedicated, pair, code, ownerDid, door)).body['linked'], true);
  assert.equal((await enter(dedicated, pair, door)).subjectAttributes['linkedTo'], ownerDid);
  // The page offers the link, and names where a code comes from.
  const page = await hosted(dedicated, doorHost, 'GET', '/guest/door');
  assert.match(page.text, /\/guest\/door\/link/);
  assert.match(page.text, /interego-general-guest-link-preview-v1/);
  const metadata = (await call(dedicated, 'GET', '/.well-known/play-provisional')).body['generalGuest'] as { accountLink: Record<string, unknown> };
  assert.deepEqual(metadata.accountLink, { doorUrl: `${door}/guest/door#link`, codeEndpoint: `${dedicated.base}/guest/link/code`, codeTtlSeconds: 300, codeMaxAttempts: 5 });
});

test('a passkey registered on this site proves as a wallet does, for the challenge it was given and no other', async () => {
  const wallet = Wallet.createRandom();
  const owner = await signIn(dedicated, wallet);
  // The account also holds a passkey registered on identity's own origin (written to its record as enrolment writes one).
  const key = softPasskey();
  const path = `/${owner.userId}/auth-methods.jsonld`;
  const current = documents.get(path)!;
  const record = JSON.parse(current.body) as Record<string, unknown>;
  record['webAuthnCredentials'] = [{ id: key.id, publicKey: key.cose.toString('base64url'), counter: 0, createdAt: new Date().toISOString(), rpId: '127.0.0.1', rpOrigin: dedicated.base }];
  documents.set(path, { body: JSON.stringify(record, null, 2), revision: current.revision + 1 });
  const prepare = async () => {
    const prepared = await call(dedicated, 'POST', '/guest/link/prepare', { bearer: owner.token, origin: dedicated.base, body: { action: 'code', method: 'passkey' } });
    assert.equal(prepared.status, 200, prepared.text);
    const options = prepared.body['options'] as { challenge: string; rpId: string; allowCredentials: Array<{ id: string }>; userVerification: string };
    assert.equal(options.rpId, '127.0.0.1');
    assert.equal(options.userVerification, 'required');
    assert.deepEqual(options.allowCredentials.map(row => row.id), [key.id]);
    return { stepUpId: prepared.body['stepUpId'] as string, challenge: options.challenge };
  };
  const finish = (stepUpId: string, response: unknown) => call(dedicated, 'POST', '/guest/link/code', { bearer: owner.token, origin: dedicated.base, body: { stepUpId, response } });
  // An assertion over another challenge, and one by a passkey that is not on the account, get no code.
  const first = await prepare();
  assert.equal((await finish(first.stepUpId, assertion(key, crypto.randomBytes(32).toString('base64url'), dedicated.base, '127.0.0.1', 1))).status, 401);
  const second = await prepare();
  assert.equal((await finish(second.stepUpId, assertion(softPasskey(), second.challenge, dedicated.base, '127.0.0.1', 1))).status, 401);
  assert.equal(recordOf(owner.userId)['guestLinkCode'], undefined);
  // The account's own passkey, over the challenge it was given: a code.
  const third = await prepare();
  const issued = await finish(third.stepUpId, assertion(key, third.challenge, dedicated.base, '127.0.0.1', 2));
  assert.equal(issued.status, 200, issued.text);
  assert.equal((issued.body['code'] as string).split(':')[0], owner.userId);
  assert.equal((recordOf(owner.userId)['guestLinkCode'] as { attempts: number }).attempts, 0);
  // That assertion again finishes nothing: its step is spent.
  assert.equal((await finish(third.stepUpId, assertion(key, third.challenge, dedicated.base, '127.0.0.1', 3))).body['error'], 'link_expired');
});

// The door page's link mode in a real browser, where one can be launched (as in
// provisional-general-guest-routes.test.ts); where none can, the test says so and is skipped.
type Page = { goto(url: string): Promise<unknown>; click(selector: string): Promise<void>; fill(selector: string, value: string): Promise<void>;
  waitForURL(url: string | RegExp, options?: object): Promise<void>; waitForSelector(selector: string, options?: object): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  on(event: string, handler: (value: { type?(): string; text?(): string; message?: string }) => void): void };
type BrowserContext = { newPage(): Promise<Page>; route(url: string, handler: (route: { fulfill(response: object): Promise<void> }) => void): Promise<void>; close(): Promise<void> };
type Browser = { newContext(options?: object): Promise<BrowserContext>; close(): Promise<void> };
async function launchBrowser(): Promise<Browser | string> {
  let chromium: { launch(options: object): Promise<Browser> };
  try { chromium = (createRequire(import.meta.url)('playwright') as { chromium: typeof chromium }).chromium; } catch { return 'playwright is not installed'; }
  const args = ['--host-resolver-rules=MAP localhost 127.0.0.1'];
  try { return await chromium.launch({ args }); }
  catch (error) {
    const root = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    const shells = root && existsSync(root) ? readdirSync(root).filter(name => name.startsWith('chromium_headless_shell-'))
      .map(name => join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell')).filter(path => existsSync(path)) : [];
    for (const executablePath of shells) {
      try { return await chromium.launch({ args, executablePath }); } catch { /* the next one */ }
    }
    return `no browser to launch: ${(error as Error).message.split('\n')[0]}`;
  }
}

/** The page's status line once it starts with `prefix`. The page's policy forbids evaluating a string in it, so it is read, not waited on. */
async function statusOf(page: Page, prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const text = await page.textContent('#status') ?? '';
    if (text.startsWith(prefix)) return text;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`the page never said "${prefix}": ${await page.textContent('#status')}`);
}

test('in a browser: the door page names the account a typed code is for, and links this browser\'s guest only on the second click', async t => {
  const browser = await launchBrowser();
  if (typeof browser === 'string') { t.skip(browser); return; }
  const door = doorOriginOf(dedicated);
  try {
    const context = await browser.newContext();
    await context.route(`${game}/**`, route => { void route.fulfill({ status: 200, contentType: 'text/plain', body: 'returned' }); });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', message => { if (message.type?.() === 'error') problems.push(message.text?.() ?? ''); });
    page.on('pageerror', error => { problems.push(error.message ?? 'page error'); });
    // This browser gets its guest the ordinary way: an application sends it through the door.
    const now = Math.floor(Date.now() / 1000);
    const state = crypto.randomBytes(24).toString('base64url'); const verifier = crypto.randomBytes(32).toString('base64url');
    const payload = JSON.stringify({ purpose: 'interego-general-guest-v1', audience: game, state, codeChallenge: sha(verifier), expiresAt: now + 60,
      agent_id: gameAgent.agentDid, subject_pod_url: gameAgent.podUrl, timestamp: new Date(now * 1000).toISOString() });
    const playGrant = { _signed_payload: payload, _signature: await service.signMessage(`sha256:${crypto.createHash('sha256').update(payload, 'utf8').digest('hex')}`) };
    await page.goto(`${door}/guest/door#grant=${Buffer.from(JSON.stringify(playGrant)).toString('base64url')}`);
    await page.waitForSelector('#go:not([disabled])');
    await page.click('#go');
    await page.waitForURL(/^https:\/\/play\.example\/guest\/return\?code=/, { timeout: 15_000 });
    const back = new URL((page as unknown as { url(): string }).url());
    const exchanged = await call(dedicated, 'POST', '/guest/exchange', { body: { code: back.searchParams.get('code'), codeVerifier: verifier, audience: game, state } });
    assert.equal(exchanged.status, 200, exchanged.text);
    const guestId = exchanged.body['userId'] as string;

    // On another device, the account's owner asks for a code.
    const wallet = Wallet.createRandom();
    const owner = await signIn(dedicated, wallet);
    const code = await codeFor(dedicated, wallet, owner.token);
    const [account, secret] = code.split(':') as [string, string];
    // Typed the way a person types it: lower case, in groups.
    const typed = `${account}:${secret.slice(0, 4).toLowerCase()}-${secret.slice(4, 8).toLowerCase()} ${secret.slice(8).toLowerCase()}`;
    await page.goto(`${door}/guest/door#link`);
    await page.waitForSelector('#code');
    assert.match(await page.textContent('#who') ?? '', /^Link the guest this browser holds to an account you already have/);
    assert.equal(await page.textContent('#go'), 'Check this code');
    await page.fill('#code', typed);
    await page.click('#go');
    await page.waitForSelector('#account:not([hidden])', { timeout: 15_000 });
    // The account is named, by DID, before anything is linked.
    const shown = await page.textContent('#account') ?? '';
    assert.ok(shown.includes(didOf(dedicated, owner.userId)), shown);
    assert.match(shown, /If someone else gave you this code, stop\./);
    assert.match(await page.textContent('#go') ?? '', /^Link this guest to /);
    assert.equal(recordOf(guestId)['provisionalGuestLinkedTo'], undefined, 'the first click links nothing');
    assert.equal(recordOf(owner.userId)['linkedGuests'], undefined);
    await page.click('#go');
    assert.ok((await statusOf(page, 'Linked.')).includes(didOf(dedicated, owner.userId)));
    assert.equal((recordOf(guestId)['provisionalGuestLinkedTo'] as { userId: string }).userId, owner.userId);
    assert.deepEqual((recordOf(owner.userId)['linkedGuests'] as Array<{ userId: string }>).map(row => row.userId), [guestId]);
    assert.deepEqual(problems, [], 'no script error and no Content-Security-Policy violation');

    // A browser with no guest has nothing to link, and says so.
    const empty = await browser.newContext();
    const other = await empty.newPage();
    await other.goto(`${door}/guest/door#link=${encodeURIComponent(code)}`);
    await other.waitForSelector('#go:not([disabled])');
    await other.click('#go');
    assert.match(await statusOf(other, 'Not done:'), /there is no guest in this browser/);
    await empty.close();
    await context.close();
  } finally { await browser.close(); }
});
