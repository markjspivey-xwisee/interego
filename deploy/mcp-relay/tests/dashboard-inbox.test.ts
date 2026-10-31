import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type AddressInfo } from 'node:net';
import express from 'express';
import { dashboardInboxHandler, DASHBOARD_INBOX_MAX_BYTES, DASHBOARD_INBOX_MAX_READ_BYTES } from '../dashboard-inbox.js';
import { createEgress } from '../egress.js';
import { listenLoopback, type TestListener } from './listen-loopback.js';
import { closeServer, stopChild } from '../../identity/tests/teardown.js';

const owner = 'u-pk-dashboard-existing'; const other = 'u-pk-dashboard-other';
const revokedOwner = 'u-pk-dashboard-revoked';
const secret = randomBytes(32); const signingKey = randomBytes(32);
const requests: Array<{ method: string; path: string; authorization?: string }> = [];
const children: ChildProcess[] = []; const listeners: TestListener[] = [];
let identity = '', relay = '', store = '', temporary = '', output = '';
let mode: 'normal' | 'redirect' | 'foreign-archive' | 'crosspod-archive' | 'oversize' | 'large-stream' | 'stalled-stream' | 'cumulative-stream' = 'normal';
let upstreamClosed = false; let upstreamWritten = 0;
const signedToken = (extra: Record<string, unknown> = {}) => {
  const encoded = Buffer.from(JSON.stringify({ userId: owner, agentId: `mcp-client-${owner}`, scope: 'ReadWrite', epoch: 0,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...extra })).toString('base64url');
  return `cg2_${encoded}.${createHmac('sha256', signingKey).update(encoded).digest('base64url')}`;
};
const bearer = signedToken();
const prefixes = '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n';
function manifest() {
  const entries = Array.from({ length: mode === 'oversize' ? 50 : 3 }, (_, index) =>
    `<${store}/${owner}/context-graphs/${index}.ttl> a iep:ManifestEntry ;\n    iep:describes <urn:graph:${index}:${mode === 'oversize' ? 'a'.repeat(3000) : index}> ;\n    iep:validFrom "${new Date(Date.now() - index * 1000).toISOString()}"^^xsd:dateTime ;\n    iep:modalStatus "Asserted" .`).join('\n');
  if (mode === 'foreign-archive') return prefixes + `<> iep:manifestArchive <http://169.254.169.254/private> .` + entries;
  if (mode === 'crosspod-archive') return prefixes + `<> iep:manifestArchive <${store}/${other}/private> .` + entries;
  return prefixes + entries;
}
async function freePort(): Promise<number> {
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done())); return port;
}
async function boot(folder: string, env: NodeJS.ProcessEnv, ready: (value: Record<string, unknown>) => boolean = () => true) {
  const port = await freePort(); const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: fileURLToPath(new URL(folder, import.meta.url)), windowsHide: true,
    env: { ...process.env, ...env, PORT: String(port), BASE_URL: base, PUBLIC_BASE_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  child.stdout!.on('data', data => { output = (output + String(data)).slice(-16_000); }); child.stderr!.on('data', data => { output = (output + String(data)).slice(-16_000); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('Fixture exited: ' + output);
    try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(2000) }); if (response.ok && ready(await response.json() as Record<string, unknown>)) return base; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Fixture startup timed out: ' + output);
    await new Promise(done => setTimeout(done, 100));
  }
}
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'interego-dashboard-inbox-'));
  const app = express(); app.use(express.text({ type: () => true }));
  app.use((req, res) => {
    requests.push({ method: req.method, path: req.path, authorization: req.headers.authorization });
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(201).end(); return; }
    // A pre-existing exchange keeps the relay's unrelated asynchronous startup
    // seed from writing during the read-only inbox observation window.
    if (req.path === '/maintainer/amep/state/release42.json') { res.json({ exchange: 'release42', openHeads: [], order: [], acts: {} }); return; }
    if (req.path === '/') { res.type('text/turtle').send(`@prefix ldp: <http://www.w3.org/ns/ldp#> . <> ldp:contains <${owner}/>, <${other}/>, <${revokedOwner}/> .`); return; }
    if ([`/${owner}/auth-methods.jsonld`, `/${other}/auth-methods.jsonld`, `/${revokedOwner}/auth-methods.jsonld`].includes(req.path)) {
      const userId = req.path.split('/')[1]!;
      res.type('application/ld+json').send(JSON.stringify({ userId, name: 'Existing account', sessionEpoch: userId === revokedOwner ? 1 : 0,
        walletAddresses: [], didKeys: [], webAuthnCredentials: [{ id: 'fixture-credential-' + userId, publicKey: 'AA', counter: 0, createdAt: new Date().toISOString() }] })); return;
    }
    if (req.path === `/${owner}/.well-known/context-graphs`) {
      if (mode === 'redirect') { res.redirect(`${store}/${other}/private`); return; }
      if (mode === 'large-stream' || mode === 'stalled-stream') {
        res.type('text/turtle'); res.write('# streamed comment\n'); upstreamWritten = 0; upstreamClosed = false;
        res.once('close', () => { upstreamClosed = true; });
        if (mode === 'stalled-stream') return;
        const chunk = Buffer.from('#' + 'a'.repeat(64 * 1024 - 2) + '\n');
        const pump = () => {
          if (res.destroyed) return;
          if (upstreamWritten >= 2 * DASHBOARD_INBOX_MAX_READ_BYTES) { res.end(); return; }
          upstreamWritten += chunk.byteLength;
          if (res.write(chunk)) setImmediate(pump); else res.once('drain', pump);
        };
        pump(); return;
      }
      if (mode === 'cumulative-stream') {
        res.type('text/turtle').send(prefixes + '<> iep:manifestArchive <context-graphs-archive-0001> .\n#' + 'a'.repeat(9 * 1024 * 1024) + '\n'); return;
      }
      res.type('text/turtle').send(manifest()); return;
    }
    if (mode === 'cumulative-stream' && req.path === `/${owner}/.well-known/context-graphs-archive-0001`) {
      res.type('text/turtle').send('#' + 'a'.repeat(9 * 1024 * 1024) + '\n'); return;
    }
    res.status(404).end();
  });
  const pod = await listenLoopback(app); listeners.push(pod); store = pod.base;
  identity = await boot('../../identity/', { CSS_URL: store + '/', CSS_PUBLIC_URL: 'https://gate.fixture.example/', RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: signingKey.toString('base64'), IDENTITY_INTROSPECTION_SECRET: secret.toString('hex'), ALLOW_OPEN_INTROSPECTION: '0', JANITOR_INTERVAL_MS: '0' },
  value => Boolean((value['accountIndex'] as { complete?: boolean })?.complete));
  relay = await boot('../', { CSS_URL: store + '/', CSS_PUBLIC_URL: 'https://gate.fixture.example/', IDENTITY_URL: identity,
    IDENTITY_INTROSPECTION_SECRET: secret.toString('hex'), RELAY_AGENT_KEY_FILE: join(temporary, 'relay-key.json') });
});
beforeEach(() => { mode = 'normal'; requests.length = 0; upstreamClosed = false; upstreamWritten = 0; });
after(async () => {
  await Promise.all(children.map(child => stopChild(child))); await Promise.all(listeners.map(listener => listener.close()));
  if (temporary) {
    const path = resolve(temporary);
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('interego-dashboard-inbox-')) throw new Error('Unexpected fixture cleanup path.');
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function read(path = '/dashboard/inbox?limit=20', token: string | null = bearer, origin: string | null = identity) {
  const response = await fetch(relay + path, { headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(origin ? { origin } : {}) }, signal: AbortSignal.timeout(20_000) });
  const text = await response.text(); return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}
test('fresh identity cg2 works at /me and the dashboard inbox while original /inbox still requires OAuth', async () => {
  const me = await fetch(identity + '/me', { headers: { authorization: 'Bearer ' + bearer } }); assert.equal(me.status, 200); assert.equal((await me.json() as { userId: string }).userId, owner);
  const answer = await read(); assert.equal(answer.response.status, 200, answer.text); assert.equal(answer.body['count'], 3); assert.equal(answer.body['totalOnPod'], 3);
  assert.equal((answer.body['events'] as Array<{ graphIris: string[] }>)[0]!.graphIris.length, 1);
  assert.equal(answer.body['pod'], `${store}/${owner}/`); assert.equal(answer.response.headers.get('cache-control'), 'no-store'); assert.equal(answer.response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(answer.response.headers.get('access-control-allow-origin'), identity);
  const legacy = await read('/inbox?pod=' + encodeURIComponent(`${store}/${owner}/`)); assert.equal(legacy.response.status, 401); assert.match(legacy.text, /Invalid access token/);
  assert.ok(requests.every(req => ['GET', 'HEAD'].includes(req.method)), JSON.stringify(requests));
  assert.ok(requests.every(req => req.authorization !== 'Bearer ' + bearer && req.authorization !== 'Bearer ' + secret.toString('hex')));
});
test('the actual server preflight and frozen CORS headers permit only the configured identity account page', async () => {
  const response = await fetch(relay + '/dashboard/inbox?limit=20', { method: 'OPTIONS', headers: { origin: identity,
    'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,accept' } });
  assert.equal(response.status, 204); assert.equal(response.headers.get('access-control-allow-origin'), identity);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS'); assert.match(response.headers.get('access-control-allow-headers')!, /Authorization/);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  for (const headers of [{ origin: 'https://foreign.example', 'access-control-request-method': 'GET' },
    { origin: identity, 'access-control-request-method': 'POST' }, { origin: identity, 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-untrusted' }]) {
    const denied = await fetch(relay + '/dashboard/inbox', { method: 'OPTIONS', headers }); assert.equal(denied.status, 403);
  }
  assert.equal(requests.length, 0);
});
test('read-capable identity scopes work, while publish-only, missing and unknown scopes never read the manifest', async () => {
  for (const scope of ['ReadWrite', 'ReadOnly', 'DiscoverOnly']) assert.equal((await read('/dashboard/inbox', signedToken({ scope }))).response.status, 200);
  requests.length = 0;
  for (const scope of ['PublishOnly', undefined, 'UnknownScope']) {
    const answer = await read('/dashboard/inbox', signedToken({ scope })); assert.equal(answer.response.status, 403, answer.text);
  }
  assert.ok(!requests.some(req => req.path.endsWith('/.well-known/context-graphs')));
});
test('foreign/missing origins, caller-selected pods and invalid windows fail before any pod read', async () => {
  for (const origin of [null, 'null', 'https://foreign.example', relay]) { const answer = await read('/dashboard/inbox', bearer, origin); assert.equal(answer.response.status, 403); }
  for (const path of ['/dashboard/inbox?pod=' + encodeURIComponent(`${store}/${other}/`), '/dashboard/inbox?limit=0', '/dashboard/inbox?limit=51',
    '/dashboard/inbox?limit=1&limit=2', '/dashboard/inbox?since=invalid', '/dashboard/inbox?since=2000-01-01T00:00:00.000Z', '/dashboard/inbox?since=' + encodeURIComponent(new Date(Date.now() + 60_000).toISOString())]) {
    const answer = await read(path); assert.equal(answer.response.status, 400, path + ' ' + answer.text);
  }
  assert.equal(requests.length, 0);
});
test('missing, invalid, expired and already revoked sessions cannot read metadata', async () => {
  assert.equal((await read('/dashboard/inbox', null)).response.status, 401);
  assert.equal((await read('/dashboard/inbox', 'cg2_invalid.invalid')).response.status, 401);
  const revoked = await read('/dashboard/inbox', signedToken({ userId: revokedOwner, agentId: `mcp-client-${revokedOwner}` }));
  assert.equal(revoked.response.status, 401); assert.ok(!revoked.text.includes('context-graphs'));
  const expired = await read('/dashboard/inbox', signedToken({ expiresAt: new Date(Date.now() - 1000).toISOString() })); assert.equal(expired.response.status, 401);
  assert.ok(requests.every(req => ['GET', 'HEAD'].includes(req.method)));
});
test('a session reported revoked during its pod read receives no metadata', async () => {
  let verifies = 0;
  const app = express(); app.get('/dashboard/inbox', dashboardInboxHandler({ identityOrigin: identity, cssUrl: store + '/',
    verifyIdentity: async () => ++verifies === 1 ? { authenticated: true, userId: owner, scope: 'ReadWrite' } : { authenticated: false },
    fetch: (url, init) => fetch(url, init) }));
  const listener = await listenLoopback(app);
  try {
    const response = await fetch(listener.base + '/dashboard/inbox', { headers: { origin: identity, authorization: 'Bearer fixture-session' } });
    assert.equal(response.status, 401); assert.equal(verifies, 2); assert.ok(!(await response.text()).includes('context-graphs'));
  } finally { await listener.close(); }
});
test('redirects and manifest archive links cannot reach another pod or a foreign host', async () => {
  for (const variant of ['redirect', 'foreign-archive', 'crosspod-archive'] as const) {
    mode = variant; requests.length = 0; const answer = await read(); assert.equal(answer.response.status, 503, variant + ' ' + answer.text);
    assert.ok(!requests.some(req => req.path.includes(`/${other}/private`)), JSON.stringify(requests));
    assert.ok(!answer.text.includes('169.254') && !answer.text.includes(bearer));
  }
});
test('response metadata is bounded and changing the permitted limit keeps the total count', async () => {
  const small = await read('/dashboard/inbox?limit=1'); assert.equal(small.response.status, 200, small.text); assert.equal(small.body['count'], 1); assert.equal(small.body['totalOnPod'], 3);
  assert.ok(Buffer.byteLength(small.text) <= DASHBOARD_INBOX_MAX_BYTES);
  mode = 'oversize'; const oversized = await read('/dashboard/inbox?limit=50'); assert.equal(oversized.response.status, 503,
    JSON.stringify({ status: oversized.response.status, count: oversized.body['count'], bytes: Buffer.byteLength(oversized.text) })); assert.ok(Buffer.byteLength(oversized.text) <= DASHBOARD_INBOX_MAX_BYTES);
});
test('an oversized stream is cancelled before parsing, and a stalled body reaches the request deadline', async () => {
  mode = 'large-stream'; const oversized = await read(); assert.equal(oversized.response.status, 503);
  for (let i = 0; i < 30 && !upstreamClosed; i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(upstreamClosed, true); assert.ok(upstreamWritten < 2 * DASHBOARD_INBOX_MAX_READ_BYTES);
  mode = 'stalled-stream'; upstreamClosed = false; const start = Date.now(); const stalled = await read();
  assert.equal(stalled.response.status, 503); assert.ok(Date.now() - start < 18_000);
  for (let i = 0; i < 30 && !upstreamClosed; i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(upstreamClosed, true);
});
test('the upstream byte ceiling is cumulative across independently small manifest segments', async () => {
  mode = 'cumulative-stream'; const answer = await read(); assert.equal(answer.response.status, 503);
  assert.ok(requests.some(req => req.path.endsWith('/.well-known/context-graphs')));
  assert.ok(requests.some(req => req.path.endsWith('/.well-known/context-graphs-archive-0001')));
});
test('the mounted handler refuses provisional owners and unsafe identity-to-pod bindings before storage', async () => {
  let calls = 0; let userId = owner; let provisionalPlay: unknown = {};
  const app = express(); app.get('/dashboard/inbox', dashboardInboxHandler({ identityOrigin: identity, cssUrl: store + '/',
    verifyIdentity: async () => ({ authenticated: true, userId, provisionalPlay, scope: 'ReadWrite' }), fetch: async () => { calls++; throw new Error('No storage read expected'); } }));
  const listener = await listenLoopback(app);
  try {
    const request = () => fetch(listener.base + '/dashboard/inbox', { headers: { origin: identity, authorization: 'Bearer fixture-identity' } });
    assert.equal((await request()).status, 403); provisionalPlay = undefined;
    for (const invalid of ['../other', owner + '/../../other', 'https://foreign.example', '%2fother', '']) { userId = invalid; const result = await request(); assert.ok([401, 403].includes(result.status)); }
    assert.equal(calls, 0);
  } finally { await closeServer(listener.server); }
});

test('caller cancellation crosses the real storage transport while its existing deadline remains active', async () => {
  let entered!: () => void; let reached = new Promise<void>(done => { entered = done; });
  const app = express(); app.get('/stall', (_req, _res) => { entered(); });
  const listener = await listenLoopback(app);
  const transport = createEgress({ cssUrl: listener.base + '/', publicBaseUrl: '', screenAddresses: true });
  const previous = process.env['NS_FETCH_TIMEOUT_MS'];
  try {
    const abort = new AbortController();
    const init = { method: 'GET', signal: abort.signal };
    const pending = transport.solidFetch(listener.base + '/stall', init);
    await reached; abort.abort(); await assert.rejects(pending, /abort/i);
    reached = new Promise<void>(done => { entered = done; });
    process.env['NS_FETCH_TIMEOUT_MS'] = '40';
    const deadline = transport.solidFetch(listener.base + '/stall', { method: 'GET', signal: new AbortController().signal } as Parameters<typeof transport.solidFetch>[1]);
    await reached; await assert.rejects(deadline, /after 40 ms/);
  } finally {
    if (previous === undefined) delete process.env['NS_FETCH_TIMEOUT_MS']; else process.env['NS_FETCH_TIMEOUT_MS'] = previous;
    await listener.close(); await transport.close();
  }
});

test('the route deadline settles during retry backoff and no later storage request can start', async () => {
  let reads = 0;
  const upstream = express(); upstream.get('*', (_req, res) => { reads++; res.status(503).end(); });
  const source = await listenLoopback(upstream);
  const app = express(); app.get('/dashboard/inbox', dashboardInboxHandler({ identityOrigin: identity, cssUrl: source.base + '/', readTimeoutMs: 75,
    verifyIdentity: async () => ({ authenticated: true, userId: owner, scope: 'ReadWrite' }), fetch: (url, init) => fetch(url, init) }));
  const listener = await listenLoopback(app);
  try {
    const began = Date.now();
    const response = await fetch(listener.base + '/dashboard/inbox', { headers: { origin: identity, authorization: 'Bearer fixture-session' } });
    assert.equal(response.status, 503); await response.text(); assert.ok(Date.now() - began < 400);
    await new Promise(done => setTimeout(done, 650)); assert.equal(reads, 1);
  } finally { await listener.close(); await source.close(); }
});
