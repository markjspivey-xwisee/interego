/**
 * The general guest door on the running identity server: what it answers with the setting off
 * (nothing: the same as before this feature existed), and with it on (the door page, the door, the
 * exchange, what an application's token and the door's token can and cannot do on this server).
 *
 * Three servers run as child processes over one stand-in pod store and one stand-in relay, as in
 * token-introspection-routes.test.ts:
 *   - `off`:   PROVISIONAL_PLAY_CLIENTS names applications that opted in, the setting is not set;
 *   - `plain`: the same applications without the opt-in, the setting not set;
 *   - `on`:    the opt-in and PROVISIONAL_GENERAL_GUEST=1.
 * The store keeps documents in memory with conditional writes; the relay answers verify_agent for
 * a key generated here. Nothing live is called.
 *
 * Run:
 *   node --test --test-timeout=120000 --import tsx tests/provisional-general-guest-routes.test.ts
 */
import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { closeServer, stopChild } from './teardown.js';
import { publicJwk } from './public-jwk.js';
import { inlineScripts } from './inline-scripts.js';
import { generalGuestUserId, playKeyThumbprint, publicPlayKey } from '../provisional-play.js';
import { claimProofPayload, doorProofPayload } from '../provisional-general-guest.js';

const game = 'https://play.example';
const learn = 'https://learn.example';
const gameAgent = { agentDid: 'did:web:identity.example:agents:game', podUrl: 'https://pods.example/game/' };
const learnAgent = { agentDid: 'did:web:identity.example:agents:learn', podUrl: 'https://pods.example/learn/' };
const optIn = { generalGuest: true, generalGuestReturnPath: '/guest/return' };
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
async function startIdentity(extraEnv: Record<string, string> | ((port: number) => Record<string, string>)): Promise<Server> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  if (typeof extraEnv === 'function') extraEnv = extraEnv(port);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['GENERAL_GUEST_DOOR_ORIGIN', 'IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS', 'PROVISIONAL_GENERAL_GUEST',
    'HOSTED_TERMS_VERSION', 'PROVISIONAL_PLAY_TTL_SECONDS', 'PROVISIONAL_PLAY_MAX_PODS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${(podServer.address() as net.AddressInfo).port}/`,
    CSS_PUBLIC_URL: 'https://pods.example/', RELAY_URL: `http://127.0.0.1:${(relayServer.address() as net.AddressInfo).port}`,
    TOKEN_SIGNING_KEY: signingKey.toString('base64'), JANITOR_INTERVAL_MS: '0', ALLOW_OPEN_INTROSPECTION: '1', ...extraEnv,
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
let plain: Server;
let on: Server;
/** As `on`, with the door on an origin of its own: the same process under the name `localhost`. */
let dedicated: Server;
const doorOriginOf = (server: Server) => server.base.replace('127.0.0.1', 'localhost');
before(async () => {
  podServer = http.createServer(servePods);
  relayServer = http.createServer(serveRelay);
  await Promise.all([podServer, relayServer].map(s => new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))));
  const optedIn = JSON.stringify({ [game]: { ...gameAgent, ...optIn }, [learn]: { ...learnAgent, namespace: 'foxxi', ...optIn } });
  [off, plain, on, dedicated] = await Promise.all([
    startIdentity({ PROVISIONAL_PLAY_CLIENTS: optedIn }),
    startIdentity({ PROVISIONAL_PLAY_CLIENTS: JSON.stringify({ [game]: gameAgent, [learn]: { ...learnAgent, namespace: 'foxxi' } }) }),
    startIdentity({ PROVISIONAL_PLAY_CLIENTS: optedIn, PROVISIONAL_GENERAL_GUEST: '1' }),
    startIdentity(port => ({ PROVISIONAL_PLAY_CLIENTS: optedIn, PROVISIONAL_GENERAL_GUEST: '1', GENERAL_GUEST_DOOR_ORIGIN: `http://localhost:${port}` })),
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
type Pair = crypto.KeyPairKeyObjectResult;
const newPair = (): Pair => crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwkOf = (pair: Pair) => publicPlayKey(publicJwk(pair.publicKey));
const sign = (pair: Pair, text: string) => crypto.sign('sha256', Buffer.from(text), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
const sha = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('base64url');

/** An application backend's grant, signed as the relay signs a sign_request envelope. */
async function grantFor(audience: string, agent: { agentDid: string; podUrl: string }) {
  const now = Math.floor(Date.now() / 1000);
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const payload = JSON.stringify({ purpose: 'interego-general-guest-v1', audience, state, codeChallenge: sha(verifier), expiresAt: now + 60,
    agent_id: agent.agentDid, subject_pod_url: agent.podUrl, timestamp: new Date(now * 1000).toISOString() });
  const signature = await service.signMessage(`sha256:${crypto.createHash('sha256').update(payload, 'utf8').digest('hex')}`);
  return { playGrant: { _signed_payload: payload, _signature: signature }, state, verifier, audience };
}
async function enter(server: Server, pair: Pair, audience: string, agent: { agentDid: string; podUrl: string }) {
  const prepared = await grantFor(audience, agent);
  const answer = await call(server, 'POST', '/guest/door', { origin: server.base,
    body: { playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(prepared.playGrant)) } });
  assert.equal(answer.status, 200, answer.text);
  const back = new URL(answer.body['redirect'] as string);
  const exchanged = await call(server, 'POST', '/guest/exchange', { body: { code: back.searchParams.get('code'), codeVerifier: prepared.verifier,
    audience, state: back.searchParams.get('state') } });
  return { prepared, back, exchanged };
}

test('with the setting off, the door\'s paths answer exactly as a path that never existed, and the metadata is unchanged', async () => {
  for (const server of [off, plain]) {
    const pair = newPair();
    const prepared = await grantFor(game, gameAgent);
    const cases: Array<[string, string, unknown]> = [
      ['GET', '/guest/door', undefined],
      ['POST', '/guest/door', { playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(prepared.playGrant)) }],
      ['POST', '/guest/door/claim', { publicKeyJwk: jwkOf(pair), expiresAt: 1, proof: 'x' }],
      ['POST', '/guest/exchange', { code: 'igc1_a.b', codeVerifier: prepared.verifier, audience: game, state: prepared.state }],
    ];
    for (const [method, path, body] of cases) {
      const answered = await call(server, method, path, { body, origin: server.base });
      const unknown = await call(server, method, '/a-path-that-never-existed', { body, origin: server.base });
      assert.equal(answered.status, 404, `${method} ${path}`);
      assert.equal(answered.status, unknown.status);
      assert.equal(answered.text.replace(path, 'P'), unknown.text.replace('/a-path-that-never-existed', 'P'), `${method} ${path}`);
      assert.equal(answered.headers.get('content-security-policy'), unknown.headers.get('content-security-policy'));
    }
  }
  const metadata = async (server: Server) => (await call(server, 'GET', '/.well-known/play-provisional')).text.split(server.base).join('BASE');
  assert.equal(await metadata(off), await metadata(plain));
  assert.ok(!('generalGuest' in JSON.parse(await metadata(off))));
  assert.ok('generalGuest' in JSON.parse(await metadata(on)));
  assert.doesNotMatch(off.output(), /General guest door/);
  assert.match(on.output(), /General guest door: on/);
  assert.equal(documents.size, 0, 'nothing was written to the store');
});

test('with the setting on, the door page is served as a top-level document with a script named by hash', async () => {
  const page = await call(on, 'GET', '/guest/door');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const script = inlineScripts(page.text)[0]!;
  assert.ok(csp.includes(`script-src 'sha256-${crypto.createHash('sha256').update(script, 'utf8').digest('base64')}'`));
  assert.ok(script.includes(`"issuer":"${on.base}"`));
});

test('door, exchange and introspection: one guest for two applications, and an application token that acts on no account', async () => {
  const pair = newPair();
  const thumbprint = playKeyThumbprint(jwkOf(pair));
  const userId = generalGuestUserId(thumbprint);
  const first = await enter(on, pair, game, gameAgent);
  assert.equal(first.back.origin + first.back.pathname, `${game}/guest/return`);
  assert.equal(first.back.searchParams.get('state'), first.prepared.state);
  assert.equal(first.exchanged.status, 200, first.exchanged.text);
  const guest = first.exchanged.body;
  assert.equal(guest['userId'], userId);
  assert.equal(guest['podUrl'], `https://pods.example/${userId}/`);
  assert.ok(!('attestation' in guest));
  const token = guest['token'] as string;
  assert.match(token, /^cg2_/);
  const marker = JSON.parse(Buffer.from(token.slice(4).split('.')[0]!, 'base64url').toString('utf8')).provisionalPlay as Record<string, unknown>;
  assert.deepEqual(marker, { general: true, application: game, proofKeyThumbprint: thumbprint, expiresAt: (guest['subjectAttributes'] as { standingUntil: number }).standingUntil });

  // Introspection answers it, with the marker (no audience) and the attributes read from the owner's record.
  const introspected = await call(on, 'POST', '/tokens/verify', { body: { token } });
  assert.equal(introspected.body['valid'], true, introspected.text);
  assert.equal(introspected.body['userId'], userId);
  assert.deepEqual(introspected.body['provisionalPlay'], marker);
  assert.deepEqual(introspected.body['subjectAttributes'], guest['subjectAttributes']);
  assert.deepEqual((guest['subjectAttributes'] as { admittedBy: string[] }).admittedBy, [game]);

  // Every other route of this server refuses it: it reads nothing, renews nothing, enrols nothing, deletes nothing.
  const before = documents.get(`/${userId}/auth-methods.jsonld`)!.revision;
  const refusals: Array<[string, string, unknown]> = [
    ['GET', '/me', undefined], ['GET', '/auth-methods/me', undefined], ['GET', '/agents/me', undefined],
    ['POST', '/tokens', { agentId: `mcp-client-${userId}` }], ['POST', '/users/me/delete', {}],
    ['POST', '/tokens/me/sign-out-everywhere', {}], ['POST', '/register-agent', { agentId: 'another-agent', name: 'x' }],
    ['POST', '/auth/webauthn/register-options', { name: 'x' }], ['POST', '/wallet/link', { address: `0x${'ab'.repeat(20)}`, signature: '0x00', message: 'm', nonce: 'n' }],
    ['DELETE', '/auth-methods/me/did', undefined],
  ];
  for (const [method, path, body] of refusals) {
    const answer = await call(on, method, path, { body, bearer: token });
    assert.equal(answer.status, 401, `${method} ${path}: ${answer.status} ${answer.text.slice(0, 200)}`);
    assert.doesNotMatch(answer.text, /cg2_/, `${method} ${path} issues nothing`);
  }
  assert.equal(documents.get(`/${userId}/auth-methods.jsonld`)!.revision, before, 'none of them wrote the record');
  assert.equal((await call(on, 'POST', '/tokens/verify', { body: { token } })).body['valid'], true, 'and the guest is as it was');

  // The code is spent, and the verification route answers no general guest.
  assert.equal((await call(on, 'POST', '/guest/exchange', { body: { code: first.back.searchParams.get('code'), codeVerifier: first.prepared.verifier,
    audience: game, state: first.prepared.state } })).body['error'], 'guest_code_already_used');

  // A second application: the same owner, one admission.
  const second = await enter(on, pair, learn, learnAgent);
  assert.equal(second.exchanged.body['userId'], userId);
  assert.equal(second.exchanged.body['namespace'], 'foxxi');
  assert.deepEqual((second.exchanged.body['subjectAttributes'] as { admittedBy: string[] }).admittedBy, [learn]);
  const ledger = JSON.parse(documents.get('/provisional-play-admission.json')!.body) as { owners: Record<string, string> };
  assert.deepEqual(Object.keys(ledger.owners), [userId]);
  const learnToken = second.exchanged.body['token'] as string;
  const learnIntrospected = await call(on, 'POST', '/tokens/verify', { body: { token: learnToken } });
  assert.deepEqual(learnIntrospected.body['provisionalPlay'], { ...marker, application: learn, namespace: 'foxxi' });
  // The first application's token still reads only itself: an application is not told which others the subject uses.
  assert.deepEqual(((await call(on, 'POST', '/tokens/verify', { body: { token } })).body['subjectAttributes'] as { admittedBy: string[] }).admittedBy, [game]);

  // A server without the setting, holding the same signing key, refuses the same token outright.
  for (const server of [off, plain]) {
    const answer = await call(server, 'POST', '/tokens/verify', { body: { token } });
    assert.equal(answer.body['valid'], false, answer.text);
  }

  // The claim flow: the door's own token is the guest's bearer on this origin, and is marked as the door's.
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  const claim = { publicKeyJwk: jwkOf(pair), expiresAt, proof: sign(pair, claimProofPayload(on.base, thumbprint, expiresAt)) };
  assert.equal((await call(on, 'POST', '/guest/door/claim', { body: claim, origin: game })).status, 403);
  assert.equal((await call(on, 'POST', '/guest/door/claim', { body: claim })).status, 403, 'no Origin header');
  const claimed = await call(on, 'POST', '/guest/door/claim', { body: claim, origin: on.base });
  assert.equal(claimed.status, 200, claimed.text);
  const doorToken = claimed.body['token'] as string;
  const me = await call(on, 'GET', '/me', { bearer: doorToken });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.body['userId'], userId);
  assert.deepEqual(me.body['provisionalPlay'], { general: true, door: true, proofKeyThumbprint: thumbprint, expiresAt: marker['expiresAt'] });
  assert.equal((await call(on, 'POST', '/register-agent', { body: { agentId: 'another-agent', name: 'x' }, bearer: doorToken })).status, 403, 'a guest registers no further agent');
  assert.equal((await call(on, 'POST', '/guest/door/claim', { body: claim, origin: on.base })).body['error'], 'play_grant_already_used');
});

test('the door answers a request of another origin, and one with no Origin header, 403 before anything is read', async () => {
  const pair = newPair();
  const prepared = await grantFor(game, gameAgent);
  const body = { playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(prepared.playGrant)) };
  for (const origin of [game, 'https://evil.example', undefined]) {
    const answer = await call(on, 'POST', '/guest/door', { body, origin });
    assert.equal(answer.status, 403, String(origin));
    assert.equal(answer.body['error'], 'general_guest_door_origin');
  }
  assert.equal(documents.has(`/${generalGuestUserId(playKeyThumbprint(jwkOf(pair)))}/auth-methods.jsonld`), false);
});

/** A request to `server` under the host name `host` (the door's, or identity's own), whatever address it is sent to. */
function hosted(server: Server, host: string, method: string, path: string, opts: { body?: unknown; origin?: string } = {}): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  const target = new URL(server.base);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: target.port, method, path,
      headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(opts.origin ? { Origin: opts.origin } : {}) } },
    response => { let text = ''; response.on('data', chunk => { text += String(chunk); }); response.on('end', () => resolve({ status: response.statusCode ?? 0, text, headers: response.headers })); });
    request.on('error', reject);
    request.end(payload);
  });
}

test('with a dedicated door origin, the door exists on that host alone, and that host serves nothing else', async () => {
  const door = doorOriginOf(dedicated);
  const doorHost = new URL(door).host;
  const mainHost = new URL(dedicated.base).host;
  assert.match(dedicated.output(), new RegExp(`General guest door: on at ${door.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const metadata = JSON.parse((await hosted(dedicated, mainHost, 'GET', '/.well-known/play-provisional')).text) as { generalGuest: { doorUrl: string; exchangeEndpoint: string } };
  assert.equal(metadata.generalGuest.doorUrl, `${door}/guest/door`);
  assert.equal(metadata.generalGuest.exchangeEndpoint, `${dedicated.base}/guest/exchange`);
  // Identity's own origin has no door: it never serves the page that holds a guest key.
  assert.equal((await hosted(dedicated, mainHost, 'GET', '/guest/door')).status, 404);
  assert.equal((await hosted(dedicated, mainHost, 'POST', '/guest/door', { body: {}, origin: dedicated.base })).status, 404);
  assert.equal((await hosted(dedicated, mainHost, 'POST', '/guest/door/claim', { body: {}, origin: dedicated.base })).status, 404);
  // The door's origin has the door and nothing else: no sign-in page, no dashboard, no token route, no metadata.
  const page = await hosted(dedicated, doorHost, 'GET', '/guest/door');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; style-src 'sha256-[A-Za-z0-9+/=]+'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
  assert.equal(page.headers['set-cookie'], undefined);
  for (const [method, path] of [['GET', '/'], ['GET', '/connect'], ['GET', '/dashboard'], ['GET', '/sign-action'], ['GET', '/health'], ['GET', '/me'],
    ['POST', '/tokens/verify'], ['POST', '/challenges'], ['POST', '/guest/exchange'], ['GET', '/.well-known/play-provisional'], ['GET', '/guest/door/'], ['GET', '/guest/door/x']] as const) {
    const answer = await hosted(dedicated, doorHost, method, path, method === 'POST' ? { body: {} } : {});
    assert.equal(answer.status, 404, `${method} ${path} on the door's host`);
    assert.equal(answer.text, '{"error":"not_found"}');
  }
  for (const [method, path] of [['GET', '/connect'], ['GET', '/health']] as const) assert.equal((await hosted(dedicated, mainHost, method, path)).status, 200, `${path} on identity's host`);
  // The door's requests are answered for the door's own origin only, and the exchange stays on identity's.
  const pair = newPair();
  const prepared = await grantFor(game, gameAgent);
  const body = { playGrant: prepared.playGrant, publicKeyJwk: jwkOf(pair), proof: sign(pair, doorProofPayload(prepared.playGrant)) };
  for (const origin of [dedicated.base, game, undefined]) assert.equal((await hosted(dedicated, doorHost, 'POST', '/guest/door', { body, origin })).status, 403, String(origin));
  const admitted = await hosted(dedicated, doorHost, 'POST', '/guest/door', { body, origin: door });
  assert.equal(admitted.status, 200, admitted.text);
  const back = new URL((JSON.parse(admitted.text) as { redirect: string }).redirect);
  const exchanged = await call(dedicated, 'POST', '/guest/exchange', { body: { code: back.searchParams.get('code'), codeVerifier: prepared.verifier, audience: game, state: prepared.state } });
  assert.equal(exchanged.body['userId'], generalGuestUserId(playKeyThumbprint(jwkOf(pair))));
});

test('a door origin that is identity\'s own, or not an origin, stops the server at start', async () => {
  for (const value of ['SAME', 'https://door.example/path', 'http://door.example', 'door.example']) {
    await assert.rejects(startIdentity(port => ({ GENERAL_GUEST_DOOR_ORIGIN: value === 'SAME' ? `http://127.0.0.1:${port}` : value })), /GENERAL_GUEST_DOOR_ORIGIN/, value);
  }
});

// ── The pages, run in a real browser ─────────────────────────
// Playwright is not a dependency of this workspace: where it (or a browser) is not installed the
// test says so and is skipped. Where it is, the door and claim pages run for real, on the door's own
// origin, against the server above.
type Browser = { newContext(options?: object): Promise<BrowserContext>; close(): Promise<void> };
type BrowserContext = { newPage(): Promise<Page>; route(url: string, handler: (route: { fulfill(response: object): Promise<void> }) => void): Promise<void>; close(): Promise<void> };
type Page = { goto(url: string): Promise<unknown>; click(selector: string): Promise<void>; waitForURL(url: string | RegExp, options?: object): Promise<void>; url(): string;
  evaluate<T>(fn: string): Promise<T>; waitForSelector(selector: string, options?: object): Promise<unknown>; textContent(selector: string): Promise<string | null>;
  inputValue(selector: string): Promise<string>; on(event: string, handler: (value: { type?(): string; text?(): string; message?: string }) => void): void };
async function launchBrowser(): Promise<Browser | string> {
  let chromium: { launch(options: object): Promise<Browser> };
  try { chromium = (createRequire(import.meta.url)('playwright') as { chromium: typeof chromium }).chromium; } catch { return 'playwright is not installed'; }
  const args = ['--host-resolver-rules=MAP localhost 127.0.0.1'];
  try { return await chromium.launch({ args }); }
  catch (error) {
    // The installed browser may be another build than this Playwright's own: use whichever headless
    // Chromium PLAYWRIGHT_BROWSERS_PATH holds.
    const root = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    const shells = root && existsSync(root) ? readdirSync(root).filter(name => name.startsWith('chromium_headless_shell-'))
      .map(name => join(root, name, 'chrome-headless-shell-linux64', 'chrome-headless-shell')).filter(path => existsSync(path)) : [];
    for (const executablePath of shells) {
      try { return await chromium.launch({ args, executablePath }); } catch { /* the next one */ }
    }
    return `no browser to launch: ${(error as Error).message.split('\n')[0]}`;
  }
}

test('in a browser: the door page admits this browser\'s guest for an application, keeps its key on the door\'s origin, and opens the claim', async t => {
  const browser = await launchBrowser();
  if (typeof browser === 'string') { t.skip(browser); return; }
  const door = doorOriginOf(dedicated);
  try {
    const visit = async (context: BrowserContext, audience: string, agent: { agentDid: string; podUrl: string }) => {
      const problems: string[] = [];
      const page = await context.newPage();
      page.on('console', message => { if (message.type?.() === 'error') problems.push(message.text?.() ?? ''); });
      page.on('pageerror', error => { problems.push(error.message ?? 'page error'); });
      const prepared = await grantFor(audience, agent);
      const grant = Buffer.from(JSON.stringify(prepared.playGrant)).toString('base64url');
      await page.goto(`${door}/guest/door#grant=${grant}`);
      await page.waitForSelector('#go:not([disabled])');
      // The grant has left the address bar, and the page names the application before anything happens.
      assert.equal(page.url(), `${door}/guest/door`);
      assert.match(await page.textContent('#who') ?? '', new RegExp(`^${audience.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} asks to continue`));
      await page.click('#go');
      await page.waitForURL(new RegExp(`^${audience.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/guest/return\\?code=`), { timeout: 15_000 });
      const back = new URL(page.url());
      assert.equal(back.searchParams.get('state'), prepared.state);
      const exchanged = await call(dedicated, 'POST', '/guest/exchange', { body: { code: back.searchParams.get('code'), codeVerifier: prepared.verifier, audience, state: prepared.state } });
      assert.equal(exchanged.status, 200, exchanged.text);
      assert.deepEqual(problems, [], 'no script error and no Content-Security-Policy violation');
      return { page, guest: exchanged.body };
    };
    const first = await browser.newContext();
    // The applications are not real: their return addresses are answered here.
    for (const application of [game, learn]) await first.route(`${application}/**`, route => { void route.fulfill({ status: 200, contentType: 'text/plain', body: 'returned' }); });
    const atGame = await visit(first, game, gameAgent);
    assert.match(atGame.guest['userId'] as string, /^u-try-guest-[a-f0-9]{32}$/);
    // The same browser at another application is the same guest; coming back is too.
    const atLearn = await visit(first, learn, learnAgent);
    assert.equal(atLearn.guest['userId'], atGame.guest['userId']);
    assert.deepEqual((atLearn.guest['subjectAttributes'] as { admittedBy: string[] }).admittedBy, [learn]);
    assert.equal((await visit(first, game, gameAgent)).guest['userId'], atGame.guest['userId']);

    // The key is in the door origin's IndexedDB, cannot be exported, and identity's own origin holds none.
    const page = atGame.page;
    await page.goto(`${door}/guest/door`);
    const stored = await page.evaluate<{ extractable: boolean; type: string; exported: string }>(`new Promise((resolve, reject) => {
      const open = indexedDB.open('interego-general-guest', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => { const request = open.result.transaction('keys').objectStore('keys').get('guest');
        request.onsuccess = () => crypto.subtle.exportKey('pkcs8', request.result.privateKey).then(() => 'exported', error => error.name)
          .then(exported => resolve({ extractable: request.result.privateKey.extractable, type: request.result.privateKey.type, exported })); };
    })`);
    assert.deepEqual(stored, { extractable: false, type: 'private', exported: 'InvalidAccessError' });
    await page.goto(`${dedicated.base}/health`);
    assert.deepEqual(await page.evaluate<string[]>(`indexedDB.databases().then(list => list.map(db => db.name))`), []);
    assert.equal(await page.evaluate<string>(`document.cookie`), '');

    // The claim: the door page proves the key and hands the guest's bearer to identity's own claim page.
    await page.goto(`${door}/guest/door#claim`);
    await page.waitForSelector('#go:not([disabled])');
    await page.click('#go');
    await page.waitForURL(new RegExp(`^${dedicated.base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/connect`), { timeout: 15_000 });
    await page.waitForSelector('#addDeviceToken');
    const bearer = await page.inputValue('#addDeviceToken');
    assert.match(bearer, /^cg2_/);
    assert.doesNotMatch(page.url(), /claim=/, 'the claim page takes the bearer out of its address');
    const me = await call(dedicated, 'GET', '/me', { bearer });
    assert.equal(me.body['userId'], atGame.guest['userId']);
    assert.equal((me.body['provisionalPlay'] as { door?: boolean }).door, true);
    await first.close();

    // Another browser is another guest; one with no guest has nothing to claim.
    const second = await browser.newContext();
    await second.route(`${game}/**`, route => { void route.fulfill({ status: 200, contentType: 'text/plain', body: 'returned' }); });
    const other = await second.newPage();
    await other.goto(`${door}/guest/door#claim`);
    await other.waitForSelector('#go:not([disabled])');
    await other.click('#go');
    await other.waitForSelector('#status');
    for (let i = 0; i < 50 && !/^Not done/.test(await other.textContent('#status') ?? ''); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await other.textContent('#status'), 'Not done: there is no guest in this browser.');
    assert.notEqual((await visit(second, game, gameAgent)).guest['userId'], atGame.guest['userId']);
    // Opened without a grant, the page does nothing and offers nothing.
    await other.goto(`${door}/guest/door`);
    assert.match(await other.textContent('#who') ?? '', /^This page is opened by an application/);
    assert.equal(await other.evaluate<boolean>(`document.getElementById('go').disabled`), true);
    await second.close();
  } finally { await browser.close(); }
});
