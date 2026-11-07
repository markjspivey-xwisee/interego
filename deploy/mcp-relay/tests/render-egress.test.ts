/** The real authenticated render route must screen a plaintext descriptor's payload too. */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type AddressInfo } from 'node:net';
import express from 'express';
import { listenLoopback, type TestListener } from './listen-loopback.js';
import { stopChild } from '../../identity/tests/teardown.js';

const owner = 'u-render-existing';
const token = randomBytes(32).toString('hex');
const introspectionSecret = randomBytes(32).toString('hex');
const listeners: TestListener[] = [];
const storageReads: string[] = [], publicReads: string[] = [], privateReads: string[] = [];
let child: ChildProcess | undefined;
let storage = '', publicOrigin = '', privateOrigin = '', relay = '', temporary = '', output = '';
let payload = '', encrypted = false;
const graph = (text: string) => '@prefix schema: <https://schema.org/> .\n<urn:render:note> schema:name "Fixture note" ; schema:text "' + text + '" .';
const descriptor = () => `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
@prefix dcat: <http://www.w3.org/ns/dcat#> .
<urn:render:descriptor> a iep:ContextDescriptor ; iep:visibility "public" ;
  iep:affordance [ a iep:Affordance, dcat:Distribution ;
    hydra:target <${payload}> ; hydra:method "GET" ;
    dcat:mediaType "text/turtle" ; iep:encrypted ${encrypted} ] .`;

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'interego-render-egress-'));
  const privateApp = express();
  privateApp.use((req, res) => { privateReads.push(req.path); res.type('text/turtle').send(graph('PRIVATE_FIXTURE_MUST_NOT_ESCAPE')); });
  const privateServer = await listenLoopback(privateApp); listeners.push(privateServer); privateOrigin = privateServer.base;

  const publicApp = express();
  publicApp.use((req, res) => {
    publicReads.push(req.path);
    if (req.path === '/redirect-private') { res.redirect(privateOrigin + '/private'); return; }
    if (req.path === '/graph') { res.type('text/turtle').send(graph('PUBLIC_FIXTURE_NOTE')); return; }
    res.status(404).end();
  });
  const publicServer = await listenLoopback(publicApp); listeners.push(publicServer); publicOrigin = publicServer.base;

  const storeApp = express(); storeApp.use(express.text({ type: () => true }));
  storeApp.use((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(201).end(); return; }
    storageReads.push(req.path);
    if (req.path === '/maintainer/amep/state/release42.json') { res.json({ exchange: 'release42', openHeads: [], order: [], acts: {} }); return; }
    if (req.path === `/${owner}/context-graphs/descriptor.ttl`) { res.type('text/turtle').send(descriptor()); return; }
    if (req.path === `/${owner}/context-graphs/graph.ttl`) { res.type('text/turtle').send(graph('STORAGE_FIXTURE_NOTE')); return; }
    if (req.path === '/') { res.type('text/turtle').send('@prefix ldp: <http://www.w3.org/ns/ldp#> . <> a ldp:Container .'); return; }
    res.status(404).end();
  });
  const storeServer = await listenLoopback(storeApp); listeners.push(storeServer); storage = storeServer.base;

  const identityApp = express(); identityApp.use(express.json());
  identityApp.post('/tokens/verify', (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + introspectionSecret) { res.status(401).end(); return; }
    res.json(req.body?.token === token
      ? { valid: true, userId: owner, agentId: 'mcp-render-fixture', scope: 'ReadWrite' }
      : { valid: false, reason: 'Unknown fixture credential' });
  });
  identityApp.use((_req, res) => { res.status(404).end(); });
  const identity = await listenLoopback(identityApp); listeners.push(identity);
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  relay = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, PORT: String(port), CSS_URL: storage + '/', CSS_PUBLIC_URL: 'https://gate.fixture.example/',
      IDENTITY_URL: identity.base, PUBLIC_BASE_URL: publicOrigin, IDENTITY_INTROSPECTION_SECRET: introspectionSecret, RELAY_ADDRESS_SCREEN: '1',
      RELAY_AGENT_KEY_FILE: join(temporary, 'relay-key.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', data => { output = (output + String(data)).slice(-16_000); });
  child.stderr!.on('data', data => { output = (output + String(data)).slice(-16_000); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('Relay fixture exited: ' + output);
    try { if ((await fetch(relay + '/health', { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Relay fixture startup timed out: ' + output);
    await new Promise(done => setTimeout(done, 100));
  }
});
beforeEach(() => { payload = `${storage}/${owner}/context-graphs/graph.ttl`; encrypted = false; storageReads.length = 0; publicReads.length = 0; privateReads.length = 0; });
after(async () => {
  await stopChild(child); await Promise.all(listeners.map(listener => listener.close()));
  if (temporary) {
    const path = resolve(temporary);
    if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('interego-render-egress-')) throw new Error('Unexpected render fixture cleanup path.');
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function render(credential: string | null = token, accept = 'text/markdown') {
  const iri = `${storage}/${owner}/context-graphs/descriptor.ttl`;
  const response = await fetch(`${relay}/render/${encodeURIComponent(iri)}`, {
    headers: { accept, ...(credential ? { authorization: 'Bearer ' + credential } : {}) }, signal: AbortSignal.timeout(20_000),
  });
  return { response, text: await response.text() };
}

test('the real render route preserves authentication and its public Turtle contract', async () => {
  assert.equal((await render(null)).response.status, 401);
  assert.equal((await render('unknown-fixture-token')).response.status, 401);
  assert.equal(storageReads.filter(path => path.endsWith('/descriptor.ttl')).length, 0);
  const answer = await render(token, 'text/turtle'); assert.equal(answer.response.status, 409, answer.text);
  assert.equal(storageReads.filter(path => path.endsWith('/graph.ttl')).length, 0);
});
test('authenticated plaintext notes still render from trusted storage and the configured public origin', async () => {
  const stored = await render(); assert.equal(stored.response.status, 200, stored.text); assert.ok(stored.text.includes('STORAGE_FIXTURE_NOTE'), stored.text);
  assert.ok(storageReads.includes(`/${owner}/context-graphs/graph.ttl`));
  payload = publicOrigin + '/graph';
  const published = await render(); assert.equal(published.response.status, 200, published.text); assert.ok(published.text.includes('PUBLIC_FIXTURE_NOTE'), published.text);
  assert.deepEqual(publicReads, ['/graph']); assert.deepEqual(privateReads, []);
});
test('plaintext payloads cannot reach a separate private loopback listener through address aliases', async () => {
  const reachable = await fetch(privateOrigin + '/reachability-control', { signal: AbortSignal.timeout(2000) });
  assert.ok((await reachable.text()).includes('PRIVATE_FIXTURE_MUST_NOT_ESCAPE'));
  assert.deepEqual(privateReads, ['/reachability-control']); privateReads.length = 0;
  for (const host of ['127.0.0.1', '127.1', 'localhost']) {
    const target = privateOrigin.replace('127.0.0.1', host) + '/private';
    payload = target; const answer = await render();
    assert.equal(answer.response.status, 200, answer.text);
    assert.ok(!answer.text.includes('PRIVATE_FIXTURE_MUST_NOT_ESCAPE'), answer.text);
    assert.deepEqual(privateReads, [], 'A descriptor-controlled private payload was fetched');
  }
});
test('a permitted public payload redirect cannot escape to an untrusted private listener', async () => {
  payload = publicOrigin + '/redirect-private'; const answer = await render();
  assert.equal(answer.response.status, 200, answer.text);
  assert.ok(!answer.text.includes('PRIVATE_FIXTURE_MUST_NOT_ESCAPE'), answer.text);
  assert.deepEqual(publicReads, ['/redirect-private']); assert.deepEqual(privateReads, []);
});
test('the existing encrypted payload branch also refuses the private target without releasing plaintext', async () => {
  encrypted = true; payload = privateOrigin + '/private'; const answer = await render();
  assert.equal(answer.response.status, 500, answer.text);
  assert.ok(!answer.text.includes('PRIVATE_FIXTURE_MUST_NOT_ESCAPE'), answer.text); assert.deepEqual(privateReads, []);
});
