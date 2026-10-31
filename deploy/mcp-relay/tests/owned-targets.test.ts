/** Real OAuth signature reads and admin CAS writes remain inside their authorized pod. */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, type AddressInfo } from 'node:net';
import express from 'express';
import { createWallet, signDescriptor, computeCid, type IRI } from '@interego/core';
import { createOwnedTargets, fetchWithoutRedirect } from '../owned-targets.js';
import { listenLoopback, type TestListener } from './listen-loopback.js';
import { stopChild } from '../../identity/tests/teardown.js';

const owner = 'u-owned-existing', other = 'u-owned-other';
const publicStore = 'https://gate.fixture.example';
// Public, nonsecret example identifiers accepted only by this ephemeral test relay.
// These fixed lookup keys are the SHA-256 values of the two documented sample strings.
// They are fixture data, never production grants, and no secret/password is hashed here.
const oauthToken = 'public-test-only-owned-oauth';
const peerOAuthToken = 'public-test-only-peer-oauth';
const oauthLookupKey = '65be7465a91f9667a70aaa9e4cb75e828a2f36cf58d9b04a9afc8899ce42aed9';
const peerOAuthLookupKey = '9b3f2c1c111e2d561629c6a3db2faeefa420e440a577ac4bbf32772abbe09c49';
const adminToken = randomBytes(32).toString('hex');
const listeners: TestListener[] = [];
const storageRequests: Array<{ method: string; path: string; authorization?: string; ifMatch?: string }> = [];
const committedWrites: Array<{ path: string; body: string }> = [];
const privateRequests: string[] = [];
const peerRequests: string[] = [];
const mirroredIndexes = new Set<string>();
let child: ChildProcess | undefined;
let storage = '', privateOrigin = '', peerOrigin = '', relay = '', temporary = '', output = '';
let signature: unknown;
let descriptorCid = '', coldCid = '';
let mode: 'normal' | 'audit-redirect' | 'signature-redirect' | 'hot-redirect' | 'archive-redirect' | 'descriptor-redirect'
  | 'write-redirect' | 'poison-private' | 'poison-crosspod' | 'bad-archive' | 'cas' | 'peer-redirect' = 'normal';
let redirectKind: 'private' | 'crosspod' | 'samepod' = 'private';
const descriptorBody = '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n<urn:fixture:descriptor> a iep:ContextDescriptor ; iep:describes <urn:fixture:graph> .\n';
const coldBody = '@prefix schema: <https://schema.org/> .\n<urn:fixture:cold> schema:name "Cold fixture" .\n';
const hotPath = `/${owner}/.well-known/context-graphs`;
const archivePath = `/${owner}/.well-known/context-graphs-archive-0001`;
const descriptorPath = `/${owner}/context-graphs/d.ttl`;
const coldPath = `/${owner}/context-graphs/cold.ttl`;
const prefixes = '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n';
function entry(url: string, graph: string, cid?: string): string {
  return `<${url}> a iep:ManifestEntry ;\n`
    + (cid ? `    iep:contentCid "${cid}" ;\n` : '')
    + `    iep:describes <${graph}> .\n`;
}
function hotManifest(): string {
  const link = mode === 'bad-archive' ? privateOrigin + '/private-index' : 'context-graphs-archive-0001';
  let body = prefixes + `<> iep:manifestArchive <${link}> .\n`
    + entry(storage + descriptorPath, 'urn:fixture:graph', mirroredIndexes.has(hotPath) ? descriptorCid : undefined);
  if (mode === 'poison-private') body += entry(privateOrigin + '/private.ttl', 'urn:fixture:poison');
  if (mode === 'poison-crosspod') body += entry(storage + `/${other}/private.ttl`, 'urn:fixture:poison');
  return body;
}
function canonicalIndex(path: string, mirrored: boolean): string {
  if (path === hotPath) return prefixes + '<> iep:manifestArchive <context-graphs-archive-0001> .\n'
    + entry(storage + descriptorPath, 'urn:fixture:graph', mirrored ? descriptorCid : undefined);
  if (path === archivePath) return prefixes + entry(storage + coldPath, 'urn:fixture:cold', mirrored ? coldCid : undefined);
  throw new Error('Unknown fixture index');
}
function redirectTarget(): string {
  return redirectKind === 'private' ? privateOrigin + '/private'
    : storage + (redirectKind === 'crosspod' ? `/${other}/private.ttl` : `/${owner}/redirected.ttl`);
}
function requestHeaders(credential: string | null) {
  return credential ? { authorization: 'Bearer ' + credential } : {};
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'interego-owned-targets-'));
  const peerHost = 'owned-peer.fixture.example';
  const keyFile = join(temporary, 'peer-key.pem'), certFile = join(temporary, 'peer-cert.pem');
  const openssl = process.platform === 'win32' ? join(process.env['ProgramFiles'] ?? 'C:/Program Files', 'Git/usr/bin/openssl.exe') : 'openssl';
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=' + peerHost, '-addext', 'subjectAltName=DNS:' + peerHost], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  const peer = createHttpsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (req, res) => {
    peerRequests.push(req.url!);
    if (decodeURIComponent(req.url!) === `/people/${owner}/context-graphs/d name.ttl`) {
      if (mode === 'peer-redirect') { res.writeHead(302, { Location: redirectTarget() }); res.end(); return; }
      res.setHeader('Content-Type', 'text/turtle'); res.end(descriptorBody); return;
    }
    if (decodeURIComponent(req.url!) === `/people/${owner}/context-graphs/d name.ttl.sig.json`) {
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(signature)); return;
    }
    res.statusCode = 404; res.end();
  });
  const peerListener = await listenLoopback(peer); listeners.push(peerListener); peerOrigin = `https://${peerHost}:${peerListener.port}`;
  const preload = join(temporary, 'peer-dns.mjs');
  await writeFile(preload, `import dns from 'node:dns';\nimport { syncBuiltinESMExports } from 'node:module';\nconst original = dns.lookup;\ndns.lookup = function(hostname, options, callback) {\n  if (hostname !== '${peerHost}') return original.call(dns, hostname, options, callback);\n  const done = typeof options === 'function' ? options : callback;\n  queueMicrotask(() => typeof options === 'object' && options?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4));\n};\nsyncBuiltinESMExports();\n`);
  const privateApp = express(); privateApp.use(express.text({ type: () => true }));
  privateApp.use((req, res) => { privateRequests.push(req.method + ' ' + req.path); res.send('PRIVATE_FIXTURE_MUST_NOT_ESCAPE'); });
  const privateServer = await listenLoopback(privateApp); listeners.push(privateServer); privateOrigin = privateServer.base;

  const storeApp = express(); storeApp.use(express.text({ type: () => true }));
  storeApp.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  storeApp.use((req, res) => {
    storageRequests.push({ method: req.method, path: req.path, authorization: req.headers.authorization, ifMatch: req.headers['if-match'] });
    if (req.path === '/maintainer/amep/state/release42.json') { res.json({ exchange: 'release42', openHeads: [], order: [], acts: {} }); return; }
    const account = req.path === `/svc-relay-dcr/tokens/${oauthLookupKey}.jsonld` ? { key: oauthLookupKey, pod: `${storage}/${owner}/` }
      : req.path === `/svc-relay-dcr/tokens/${peerOAuthLookupKey}.jsonld` ? { key: peerOAuthLookupKey, pod: `${peerOrigin}/people/${owner}/` } : null;
    if (req.method === 'GET' && account) {
      res.json({ token_sha256: account.key, clientId: 'owned-target-fixture', scopes: ['mcp:tools'], expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { userId: owner, agentId: 'mcp-owned-fixture', ownerWebId: `${publicStore}/${owner}/profile#me`,
          podUrl: account.pod, identityToken: 'synthetic-identity-fixture' } }); return;
    }
    if (req.method === 'PUT' && [hotPath, archivePath].includes(req.path)) {
      if (mode === 'write-redirect') { res.redirect(307, redirectTarget()); return; }
      if (mode === 'cas') { res.status(412).end(); return; }
      if (req.headers['if-match'] !== (req.path === hotPath ? '"hot-v1"' : '"archive-v1"')) { res.status(412).end(); return; }
      const body = typeof req.body === 'string' ? req.body : '';
      const expected = canonicalIndex(req.path, true);
      // This fixture accepts one known canonical representation per index. Compare
      // bytes before changing state; no parser needs to process a submitted body.
      if (body !== expected) {
        res.status(400).json({ error: 'fixture_manifest_rejected' }); return;
      }
      // Keep the submitted bytes only for assertions. GETs regenerate a known valid
      // fixture document from validated state; arbitrary request bodies are never echoed.
      committedWrites.push({ path: req.path, body }); mirroredIndexes.add(req.path); res.status(204).end(); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(201).end(); return; }
    if (req.path === descriptorPath) {
      if (mode === 'audit-redirect' || mode === 'descriptor-redirect') { res.redirect(redirectTarget()); return; }
      res.type('text/turtle').send(descriptorBody); return;
    }
    if (req.path === descriptorPath + '.sig.json') {
      if (mode === 'signature-redirect') { res.redirect(redirectTarget()); return; }
      res.json(signature); return;
    }
    if (req.path === coldPath) { res.type('text/turtle').send(coldBody); return; }
    if (req.path === hotPath) {
      if (mode === 'hot-redirect') { res.redirect(redirectTarget()); return; }
      res.setHeader('ETag', '"hot-v1"'); res.type('text/turtle').send(hotManifest()); return;
    }
    if (req.path === archivePath) {
      if (mode === 'archive-redirect') { res.redirect(redirectTarget()); return; }
      res.setHeader('ETag', '"archive-v1"'); res.type('text/turtle').send(canonicalIndex(archivePath, mirroredIndexes.has(archivePath))); return;
    }
    if (req.path.startsWith(`/${other}/`) || req.path === `/${owner}/redirected.ttl`) { res.send('CROSSPOD_FIXTURE_MUST_NOT_ESCAPE'); return; }
    if (req.path.endsWith('/')) { res.type('text/turtle').send('@prefix ldp: <http://www.w3.org/ns/ldp#> . <> a ldp:Container .'); return; }
    res.status(404).end();
  });
  const store = await listenLoopback(storeApp); listeners.push(store); storage = store.base;
  descriptorCid = await computeCid(descriptorBody); coldCid = await computeCid(coldBody);
  signature = await signDescriptor('urn:fixture:descriptor' as IRI, descriptorBody, await createWallet('agent', 'owned-target-fixture'));
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port; await new Promise<void>((done, reject) => probe.close(error => error ? reject(error) : done()));
  relay = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, '--import', 'tsx', 'server.ts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true,
    env: { ...process.env, PORT: String(port), CSS_URL: storage + '/', CSS_PUBLIC_URL: publicStore + '/', PUBLIC_BASE_URL: peerOrigin,
      NODE_EXTRA_CA_CERTS: certFile, IDENTITY_URL: privateOrigin, RELAY_POD_HOST_ALLOWLIST: 'gate.fixture.example,foreign.fixture.example,' + peerHost,
      RELAY_INTROSPECTION_SECRET: adminToken, RELAY_ADDRESS_SCREEN: '1', RELAY_AGENT_KEY_FILE: join(temporary, 'relay-key.json') },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', data => { output = (output + String(data)).slice(-16_000); }); child.stderr!.on('data', data => { output = (output + String(data)).slice(-16_000); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error('Relay fixture exited: ' + output);
    try { if ((await fetch(relay + '/health', { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Relay fixture startup timed out: ' + output);
    await new Promise(done => setTimeout(done, 100));
  }
});
beforeEach(() => { mode = 'normal'; redirectKind = 'private'; mirroredIndexes.clear(); storageRequests.length = 0; committedWrites.length = 0; privateRequests.length = 0; peerRequests.length = 0; });
after(async () => {
  await stopChild(child); await Promise.all(listeners.map(listener => listener.close()));
  if (temporary) {
    const target = resolve(temporary);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('interego-owned-targets-')) throw new Error('Unexpected owned-target fixture cleanup path');
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function audit(url = publicStore + descriptorPath, credential: string | null = oauthToken) {
  const response = await fetch(relay + '/audit/verify-signature?descriptor=' + encodeURIComponent(url), {
    headers: requestHeaders(credential), signal: AbortSignal.timeout(20_000) });
  const text = await response.text(); return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}
async function backfill(podUrl = storage + '/' + owner + '/', credential: string | null = adminToken, descriptorUrls?: string[]) {
  const response = await fetch(relay + '/admin/backfill-manifest-cid', { method: 'POST', signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', ...requestHeaders(credential) }, body: JSON.stringify({ podUrl, ...(descriptorUrls ? { descriptorUrls } : {}) }) });
  const text = await response.text(); return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}
function assertNoPrivateOrWrites() {
  assert.deepEqual(privateRequests, []); assert.deepEqual(committedWrites, []);
  assert.ok(!storageRequests.some(req => req.path.startsWith(`/${other}/`) || req.path === `/${owner}/redirected.ttl`));
  assert.ok(!storageRequests.some(req => req.method === 'PUT'));
}

test('the real OAuth audit verifies canonical storage bytes and retains safe encoded resource names', async () => {
  for (const resource of [publicStore + descriptorPath, publicStore + descriptorPath.replace('d.ttl', '%64%2Ettl')]) {
    const answer = await audit(resource); assert.equal(answer.response.status, 200, answer.text); assert.equal(answer.body['valid'], true, answer.text);
    assert.equal(answer.body['descriptorUrl'], resource);
  }
  assert.ok(storageRequests.some(req => req.path === descriptorPath)); assert.ok(storageRequests.some(req => req.path === descriptorPath + '.sig.json'));
  assert.ok(storageRequests.every(req => req.authorization !== 'Bearer ' + oauthToken && req.authorization !== 'Bearer ' + adminToken));
  assert.deepEqual(privateRequests, []); assert.deepEqual(committedWrites, []);
});

test('the real OAuth audit follows a verified third-party owner base through guarded HTTPS transport', async () => {
  const url = `${peerOrigin}/people/${owner}/context-graphs/d%20name.ttl`;
  const answer = await audit(url, peerOAuthToken); assert.equal(answer.response.status, 200, answer.text); assert.equal(answer.body['valid'], true, answer.text);
  assert.deepEqual(peerRequests.sort(), [`/people/${owner}/context-graphs/d%20name.ttl`, `/people/${owner}/context-graphs/d%20name.ttl.sig.json`].sort());
  assert.ok(!storageRequests.some(req => req.path.startsWith(`/${owner}/`))); assertNoPrivateOrWrites();
  peerRequests.length = 0;
  const foreign = await audit(`${peerOrigin}/people/${other}/context-graphs/d.ttl`, peerOAuthToken);
  assert.equal(foreign.response.status, 403, foreign.text); assert.deepEqual(peerRequests, []);
  mode = 'peer-redirect'; const redirected = await audit(url, peerOAuthToken);
  assert.equal(redirected.response.status, 502, redirected.text); assertNoPrivateOrWrites();
});

test('OAuth audit keeps authentication and rejects foreign, cross-pod and ambiguous addresses before resource reads', async () => {
  assert.equal((await audit(undefined, null)).response.status, 401);
  assert.equal((await audit(undefined, 'unknown-oauth-fixture')).response.status, 401);
  for (const url of [privateOrigin + '/private', 'https://foreign.fixture.example/' + owner + '/d.ttl',
    publicStore + `/${other}/context-graphs/d.ttl`, publicStore + descriptorPath + '?ignored=1', publicStore + descriptorPath + '#ignored',
    publicStore.replace('https://', 'https://user:secret@') + descriptorPath,
    publicStore + `/${owner}/context-graphs/%2e%2e/context-graphs/d.ttl`,
    publicStore + `/${owner}/context-graphs/d%2fttl`, publicStore + `/${owner}/context-graphs/d%252fttl`]) {
    const answer = await audit(url); assert.ok([400, 403].includes(answer.response.status), answer.text);
  }
  assert.ok(!storageRequests.some(req => req.path.startsWith(`/${owner}/`))); assertNoPrivateOrWrites();
});

test('descriptor and signature redirects cannot reach private, cross-pod or same-pod destinations', async () => {
  for (const variant of ['audit-redirect', 'signature-redirect'] as const) for (const kind of ['private', 'crosspod', 'samepod'] as const) {
    mode = variant; redirectKind = kind;
    const answer = await audit(); assert.equal(answer.response.status, 502, answer.text);
    assert.ok(!answer.text.includes('FIXTURE_MUST_NOT_ESCAPE')); assertNoPrivateOrWrites();
  }
});

test('admin backfill preserves hot/archive discovery, CID bytes and If-Match CAS through the public store alias', async () => {
  const answer = await backfill(publicStore + '/' + owner); assert.equal(answer.response.status, 200, answer.text);
  assert.equal(answer.body['scanned'], 2); assert.equal(answer.body['backfilled'], 2);
  assert.deepEqual(committedWrites.map(write => write.path), [hotPath, archivePath]);
  assert.ok(committedWrites.find(write => write.path === hotPath)!.body.includes(await computeCid(descriptorBody)));
  assert.ok(committedWrites.find(write => write.path === archivePath)!.body.includes(await computeCid(coldBody)));
  assert.ok(committedWrites[0]!.body.includes('iep:manifestArchive <context-graphs-archive-0001>'));
  assert.deepEqual(storageRequests.filter(req => req.method === 'PUT').map(req => req.ifMatch), ['"hot-v1"', '"archive-v1"']);
  assert.deepEqual(privateRequests, []);
  const second = await backfill(); assert.equal(second.response.status, 200, second.text); assert.equal(second.body['backfilled'], 0);
});

test('admin secret checks and configured-store pod selection fail before manifest traffic', async () => {
  assert.equal((await backfill(undefined, null)).response.status, 401);
  assert.equal((await backfill(undefined, 'wrong-admin-fixture')).response.status, 401);
  for (const pod of [privateOrigin + '/' + owner + '/', 'https://foreign.fixture.example/' + owner + '/',
    storage + '/' + owner + '/context-graphs/', storage + '/' + owner + '/?query=1', storage + '/' + owner + '/#fragment',
    storage.replace('http://', 'http://user:secret@') + '/' + owner + '/', storage + '/%2e%2e/' + owner + '/', storage + '/' + owner + '%252f' + other + '/']) {
    const answer = await backfill(pod); assert.equal(answer.response.status, 400, answer.text);
  }
  assert.equal(storageRequests.length, 0); assertNoPrivateOrWrites();
});

test('poisoned selected descriptor addresses and unreadable archives refuse all maintenance writes', async () => {
  for (const variant of ['poison-private', 'poison-crosspod', 'bad-archive'] as const) {
    mode = variant; storageRequests.length = 0;
    const answer = await backfill(); assert.equal(answer.response.status, 502, answer.text);
    assert.ok(!storageRequests.some(req => req.path === descriptorPath || req.path === coldPath)); assertNoPrivateOrWrites();
  }
});

test('admin read redirects refuse out-of-pod responses and the descriptor whitelist remains selective', async () => {
  for (const variant of ['hot-redirect', 'archive-redirect', 'descriptor-redirect'] as const) {
    mode = variant;
    // Select only the hot descriptor so a refused descriptor cannot cause an unrelated partial write.
    const answer = await backfill(undefined, adminToken, [storage + descriptorPath]); assert.equal(answer.response.status, 502, answer.text);
    assertNoPrivateOrWrites();
  }
  mode = 'normal'; storageRequests.length = 0;
  const selected = await backfill(undefined, adminToken, [storage + descriptorPath]); assert.equal(selected.response.status, 200, selected.text);
  assert.equal(selected.body['scanned'], 2); assert.equal(selected.body['backfilled'], 1);
  assert.deepEqual(committedWrites.map(write => write.path), [hotPath]); assert.ok(!storageRequests.some(req => req.path === coldPath));
});

test('CAS conflicts preserve 412 and write redirects cannot cause a second PUT', async () => {
  const malformed = await fetch(storage + hotPath, { method: 'PUT', headers: { 'Content-Type': 'text/turtle', 'If-Match': '"hot-v1"' },
    body: canonicalIndex(hotPath, true).replace(descriptorCid, 'INVALID_FIXTURE_CID') });
  assert.equal(malformed.status, 400); assert.deepEqual(committedWrites, []);
  const unchanged = await fetch(storage + hotPath);
  assert.equal(unchanged.headers.get('content-type')?.split(';')[0], 'text/turtle'); assert.equal(unchanged.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await unchanged.text(), canonicalIndex(hotPath, false)); storageRequests.length = 0;
  mode = 'cas'; const conflict = await backfill(); assert.equal(conflict.response.status, 412, conflict.text); assert.equal(conflict.body['retryable'], true);
  assert.deepEqual(committedWrites, []); storageRequests.length = 0;
  mode = 'write-redirect'; const refused = await backfill(); assert.equal(refused.response.status, 502, refused.text);
  assert.deepEqual(committedWrites, []); assert.deepEqual(privateRequests, []);
  assert.ok(storageRequests.filter(req => req.method === 'PUT').every(req => [hotPath, archivePath].includes(req.path)));
});

test('target construction preserves verified third-party owner bases and canonicalizes safe encodings', () => {
  const targets = createOwnedTargets('http://css.internal:3456/store/', new Set(['http://css.internal:3456', 'https://gate.example']));
  assert.equal(targets.ownedResource('https://peer.example/people/me/context/d%20name%2Ettl', 'https://peer.example/people/me/'), 'https://peer.example/people/me/context/d%20name.ttl');
  assert.equal(targets.ownedResource('https://gate.example/store/u-owner/context/d.ttl', 'http://css.internal:3456/store/u-owner/'), 'http://css.internal:3456/store/u-owner/context/d.ttl');
  assert.equal(targets.maintenancePod('https://gate.example/store/u-owner'), 'http://css.internal:3456/store/u-owner/');
  for (const url of ['https://peer.example/people/other/d.ttl', 'https://foreign.example/people/me/d.ttl',
    'https://peer.example/people/me/../me/d.ttl', 'https://peer.example/people/me/%2e%2e/me/d.ttl',
    'https://peer.example/people/me/d%2fttl', 'https://peer.example/people/me/d%5cttl', 'https://peer.example/people/me/d%252fttl',
    'https://peer.example/people/me/d.ttl?', 'https://peer.example/people/me/d.ttl#', 'https://@peer.example/people/me/d.ttl']) {
    assert.throws(() => targets.ownedResource(url, 'https://peer.example/people/me/'));
  }
  assert.throws(() => targets.maintenanceTarget('https://gate.example/store/u-other/private.ttl', 'https://gate.example/store/u-owner/'));
  assert.throws(() => targets.maintenanceTarget('https://gate.example/store/u-owner/auth-methods.jsonld', 'https://gate.example/store/u-owner/', true));
});

test('manual redirect responses are rejected before either body reader is invoked', async () => {
  let read = false;
  await assert.rejects(fetchWithoutRedirect(async (_url, init) => {
    assert.equal((init as { redirect?: string }).redirect, 'manual');
    return { ok: false, status: 302, statusText: 'Found', text: async () => { read = true; return 'secret'; }, json: async () => { read = true; return {}; } };
  }, 'https://owner.example/me/d.ttl'), /do not follow redirects/);
  assert.equal(read, false);
});

test('owner-scoped fetch preserves caller cancellation across the real HTTP transport', async () => {
  let reached!: () => void;
  const entered = new Promise<void>(done => { reached = done; });
  const app = express(); app.get('/stall', (_req, _res) => { reached(); });
  const listener = await listenLoopback(app);
  try {
    const caller = new AbortController();
    const init = { method: 'GET', signal: caller.signal };
    const pending = fetchWithoutRedirect((url, request) => fetch(url, request), listener.base + '/stall', init);
    await entered; caller.abort(); await assert.rejects(pending, /abort/i);
  } finally { await listener.close(); }
});
