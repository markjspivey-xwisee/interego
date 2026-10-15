/**
 * Native commit wire contract against actual CSS HTTP servers and shared PostgreSQL.
 *
 * Each writer is a separate AppRunner process with its own CSS memory locker and
 * PG connection pool. They advertise the SAME canonical base URL, while HTTP
 * requests connect to distinct loopback ports with that canonical Host header.
 * Thus local CSS locks cannot serialize the two writers: the native PGSL engine
 * must decide their shared resource's conditional commit atomically.
 *
 * This test deliberately refuses PGSL_INMEM: separate in-memory backends cannot
 * establish either cross-server exclusion or recovery after process death.
 * Child IPC controls readiness and Date.now only; storage and HTTP are not mocked.
 */
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, '..');
const configPath = path.join(pkgRoot, 'config', 'pgsl-server.json');
const mediaType = 'application/vnd.interego.native-commit+json';
const binaryType = 'application/octet-stream';
const revisionPattern = /^sha256:[0-9a-f]{64}$/;
const children = new Set<ChildProcess>();
let sequence = 0;

interface WorkerDiagnostic { stage: string; name: string; code?: string; message: string; }
let workerStage = 'import-css';

/** Startup diagnostics are bounded test metadata; never forward stacks, URLs, credentials or payload tokens. */
function workerDiagnostic(error: unknown, stage: string): WorkerDiagnostic {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown } : {};
  const token = (item: unknown): string | undefined => typeof item === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(item) ? item : undefined;
  const message = (typeof value.message === 'string' ? value.message : 'Worker startup failed without an Error message')
    .slice(0, 4096)
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\"'<>]+/g, '[url]')
    .replace(/\b(password|passwd|pwd|secret|token|authorization|capability|private[_ -]?key|encryption[_ -]?key)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9+\/_=-]{48,}/g, '[redacted-token]')
    .split(/\r?\n/).filter(line => !/^\s*at\s/.test(line)).slice(0, 6).join(' | ').slice(0, 800);
  return { stage: token(stage) ?? 'startup', name: token(value.name) ?? 'Error', ...(token(value.code) ? { code: token(value.code) } : {}), message };
}

interface WorkerMessage {
  diagnostic?: WorkerDiagnostic;
  event?: string;
  id?: number;
  command?: string;
  now?: number;
}
interface Worker {
  child: ChildProcess;
  port: number;
}
interface WireResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
interface Receipt {
  version: number;
  status: string;
  resource: string;
  expectedRevision: string | null;
  revision: string;
  bodyDigest: string;
  contentType: string;
  pod: string;
  path: string;
  size: number;
  updatedAt: number;
  topUri: string;
  opaqueUri: string;
}

function waitMessage(child: ChildProcess, accepts: (message: WorkerMessage) => boolean): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('CSS native-commit worker did not acknowledge within 60 seconds')); }, 60_000);
    const onMessage = (message: WorkerMessage): void => {
      if (message.event === 'failed') {
        cleanup();
        const detail = message.diagnostic;
        reject(new Error(`CSS native-commit worker failed: ${detail ? `${detail.stage}: ${detail.name}${detail.code ? ` [${detail.code}]` : ''}: ${detail.message}` : 'startup diagnostic unavailable'}`));
      }
      else if (accepts(message)) { cleanup(); resolve(message); }
    };
    const onExit = (): void => { cleanup(); reject(new Error('CSS native-commit worker exited before acknowledgement')); };
    const onError = (): void => { cleanup(); reject(new Error('Unable to launch CSS native-commit worker')); };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startWorker(baseUrl: string): Promise<Worker> {
  const port = await freePort();
  const child = fork(fileURLToPath(import.meta.url), ['--native-commit-worker'], {
    execArgv: ['--import', 'tsx'],
    // Do not copy a database URL or internal server diagnostics into test output.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, NATIVE_COMMIT_TEST_PORT: String(port), NATIVE_COMMIT_TEST_BASE_URL: baseUrl },
  });
  children.add(child);
  await waitMessage(child, message => message.event === 'ready');
  return { child, port };
}

async function setClock(worker: Worker, now: number | undefined): Promise<void> {
  const id = ++sequence;
  const acknowledged = waitMessage(worker.child, message => message.event === 'clock' && message.id === id);
  worker.child.send({ command: 'clock', id, now });
  await acknowledged;
}

async function killWorker(worker: Worker): Promise<void> {
  const { child } = worker;
  if (child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit');
    child.kill('SIGKILL');
    await ended;
  }
  children.delete(child);
}

/** Connect locally, preserving the resource URL CSS and both PG backends see. */
function wire(worker: Worker, resource: string, method = 'GET', headers: Record<string, string> = {}, body?: Buffer): Promise<WireResponse> {
  const target = new URL(resource);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: worker.port, method,
      path: `${target.pathname}${target.search}`,
      headers: { host: target.host, ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(30_000, () => request.destroy(new Error('CSS native-commit HTTP request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

function commit(worker: Worker, resource: string, expectedRevision: string | null, bytes: Buffer, conditionalHeaders?: Record<string, string>): Promise<WireResponse> {
  const body = Buffer.from(JSON.stringify({ version: 1, expectedRevision, contentType: binaryType, bodyBase64: bytes.toString('base64') }));
  return wire(worker, resource, 'PUT', {
    'content-type': mediaType,
    ...conditionalHeaders ?? (expectedRevision === null ? { 'if-none-match': '*' } : { 'if-match': `"${expectedRevision}"` }),
  }, body);
}

function strongEtag(response: WireResponse): string {
  const etag = response.headers.etag;
  assert.equal(typeof etag, 'string', 'native resource and receipt responses must carry an ETag');
  assert.match(etag!, /^"[^"\r\n]+"$/, 'the revision ETag must be strong and quoted');
  return etag!;
}

function receipt(response: WireResponse, resource: string, expectedRevision: string | null, bytes: Buffer): Receipt {
  assert.equal(response.status, 200, 'a native commit must return its engine receipt with status 200');
  assert.match(String(response.headers['content-type']), /^application\/json(?:;|$)/i);
  const value = JSON.parse(response.body.toString('utf8')) as Receipt;
  assert.equal(value.version, 1);
  assert.equal(value.status, 'committed');
  assert.equal(value.resource, resource);
  assert.equal(value.path, resource);
  assert.equal(value.expectedRevision, expectedRevision);
  assert.match(value.revision, revisionPattern);
  assert.equal(value.bodyDigest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  assert.equal(value.contentType, binaryType);
  assert.equal(value.pod, 'css');
  assert.equal(value.size, bytes.length);
  assert.ok(Number.isFinite(value.updatedAt));
  assert.ok(typeof value.topUri === 'string' && value.topUri.length > 0);
  assert.ok(typeof value.opaqueUri === 'string' && value.opaqueUri.length > 0);
  assert.ok(strongEtag(response).includes(value.revision), 'receipt ETag must bind its committed revision');
  return value;
}

async function read(worker: Worker, resource: string, expected: Receipt, bytes: Buffer, expectedEtag?: string): Promise<string> {
  const response = await wire(worker, resource, 'GET', { accept: binaryType });
  assert.equal(response.status, 200, 'a normal CSS GET must read the native committed resource');
  assert.equal(response.headers['content-type'], binaryType);
  assert.equal(response.headers['interego-revision'], expected.revision, 'GET must expose its actual native revision');
  assert.equal(response.headers['interego-body-digest'], expected.bodyDigest, 'GET must expose its underlying representation digest');
  assert.deepEqual(response.body, bytes, 'CSS GET must expose underlying representation bytes, not the commit command');
  assert.equal(response.headers['interego-body-digest'], `sha256:${createHash('sha256').update(response.body).digest('hex')}`, 'GET digest must describe its actual response bytes');
  const etag = strongEtag(response);
  assert.ok(etag.includes(expected.revision), 'normal GET must bind the native committed revision');
  if (expectedEtag) assert.equal(etag, expectedEtag, 'both server processes must expose the same committed ETag');
  return etag;
}

async function expectNativeOptions(worker: Worker, resource: string): Promise<void> {
  assert.equal((await wire(worker, resource)).status, 404, 'readiness discovery must target this exact absent resource');
  const response = await wire(worker, resource, 'OPTIONS');
  assert.ok(response.status >= 200 && response.status < 300, 'OPTIONS must advertise the native protocol on an absent document target');
  const putTypes = String(response.headers['accept-put'] ?? '').split(',').map(value => value.split(';', 1)[0]!.trim().toLowerCase());
  assert.ok(putTypes.includes(mediaType), 'OPTIONS Accept-Put must include the native commit media type');
  assert.equal(response.headers['interego-native-commit'], '1', 'OPTIONS must advertise native commit version 1 explicitly');
  assert.equal((await wire(worker, resource)).status, 404, 'OPTIONS must not create the probed resource');
}

/** Every response must bind bytes and metadata from ONE committed native revision. */
async function concurrentReadCoherence(left: Worker, right: Worker, resource: string): Promise<{ receipt: Receipt; bytes: Buffer; etag: string }> {
  const bodyForVersion = (version: number): Buffer => {
    const bytes = Buffer.alloc(128 * 1024 + version % 7, version & 0xff);
    bytes.writeUInt32BE(version, 0);
    return bytes;
  };
  let bytes = bodyForVersion(0);
  const initialResponse = await commit(left, resource, null, bytes);
  let current = receipt(initialResponse, resource, null, bytes);
  let etag = await read(right, resource, current, bytes);
  const versions = new Map<string, { receipt: Receipt; bytes: Buffer }>([[etag, { receipt: current, bytes }]]);
  const observed: WireResponse[] = [];

  // Launch real GETs before each real write, then keep each reader issuing GETs
  // while that write can commit in the other server process. No accessor method
  // or storage backend is replaced, paused, or given a test-only receipt.
  for (let version = 1; version <= 24; version++) {
    const readers = [left, right, left, right].map(async worker => {
      for (let readIndex = 0; readIndex < 2; readIndex++) {
        observed.push(await wire(worker, resource, 'GET', { accept: binaryType }));
      }
    });
    const nextBytes = bodyForVersion(version);
    const writing = commit(version % 2 === 0 ? left : right, resource, current.revision, nextBytes, { 'if-match': etag });
    const [response] = await Promise.all([writing, Promise.all(readers)]);
    current = receipt(response, resource, current.revision, nextBytes);
    bytes = nextBytes;
    etag = strongEtag(response);
    assert.ok(!versions.has(etag), 'each coherence-test commit must have a distinct strong ETag');
    versions.set(etag, { receipt: current, bytes });
  }

  assert.equal(observed.length, 24 * 4 * 2, 'all concurrent HTTP reader requests must complete');
  const observedRevisions = new Set<string>();
  for (const response of observed) {
    assert.equal(response.status, 200, 'concurrent GET must read a committed document');
    const observedEtag = strongEtag(response);
    const committed = versions.get(observedEtag);
    assert.ok(committed, 'GET ETag must identify a receipt from an actual completed native commit');
    const digest = `sha256:${createHash('sha256').update(response.body).digest('hex')}`;
    assert.equal(response.headers['content-type'], committed.receipt.contentType);
    assert.equal(response.headers['interego-revision'], committed.receipt.revision, 'GET revision header and ETag must identify the same snapshot');
    assert.equal(response.headers['interego-body-digest'], committed.receipt.bodyDigest, 'GET digest header and ETag must identify the same snapshot');
    assert.equal(digest, committed.receipt.bodyDigest, 'a concurrent write must not pair old metadata with new response bytes');
    assert.deepEqual(response.body, committed.bytes, 'concurrent GET bytes must belong to its advertised committed revision');
    assert.equal(response.body.length, committed.receipt.size);
    if (response.headers['content-length'] !== undefined) assert.equal(Number(response.headers['content-length']), committed.receipt.size);
    if (response.headers['last-modified'] !== undefined) assert.equal(response.headers['last-modified'], new Date(committed.receipt.updatedAt).toUTCString());
    observedRevisions.add(committed.receipt.revision);
  }
  assert.ok(observedRevisions.size > 1, 'the readers must observe multiple revisions while writes progress');
  await read(left, resource, current, bytes, etag);
  await read(right, resource, current, bytes, etag);
  return { receipt: current, bytes, etag };
}

async function main(): Promise<void> {
  assert.notEqual(process.env.PGSL_INMEM, '1', 'native multiwriter/restart proof requires real shared PostgreSQL; PGSL_INMEM is only a wiring smoke');
  assert.ok(process.env.PGSL_PG_CONNSTR, 'PGSL_PG_CONNSTR must point to the isolated integration-test PostgreSQL database');
  const diagnosticProbe = workerDiagnostic(new Error('Found multiple types BasicETagHandler NativeETagHandler\npostgresql://fixture:fixture-password@localhost/example token=fixture-secret'), 'create-css');
  assert.ok(diagnosticProbe.message.includes('BasicETagHandler'));
  assert.ok(!/fixture-password|fixture-secret/.test(diagnosticProbe.message), 'startup diagnostics must redact fixture credentials');
  assert.ok(diagnosticProbe.message.length <= 800);
  const canonicalPort = await freePort();
  const baseUrl = `http://127.0.0.1:${canonicalPort}/`;
  const prefix = `native-commit-${randomUUID()}`;
  const resource = `${baseUrl}${prefix}.bin`;
  const abaResource = `${baseUrl}${prefix}-aba.bin`;
  const coherenceResource = `${baseUrl}${prefix}-coherence.bin`;
  const invalidResource = `${baseUrl}${prefix}-invalid.bin`;
  const bodyA = Buffer.from([0, 255, 1, 13, 10, 200, 65]);
  const bodyB = Buffer.from([0, 254, 2, 13, 10, 199, 66]);
  const bodyC = Buffer.from([0, 253, 3, 13, 10, 198, 67]);
  const bodyD = Buffer.from([0, 252, 4, 13, 10, 197, 68]);

  try {
    const left = await startWorker(baseUrl);
    const right = await startWorker(baseUrl);
    for (const worker of [left, right]) assert.equal((await wire(worker, baseUrl, 'GET', { accept: 'text/turtle' })).status, 200);
    for (const worker of [left, right]) await expectNativeOptions(worker, invalidResource);

    const missingHeader = await commit(left, invalidResource, null, bodyA, {});
    assert.ok(missingHeader.status >= 400 && missingHeader.status < 500, 'native create must refuse a missing If-None-Match condition');
    assert.equal((await wire(right, invalidResource)).status, 404, 'refused create must leave no resource on the other server');

    // Neither process shares a CSS lock. Exactly one absent-head CAS may commit.
    const creates = await Promise.all([commit(left, resource, null, bodyA), commit(right, resource, null, bodyB)]);
    assert.deepEqual(creates.map(response => response.status).sort(), [200, 412], 'two independent native creators must produce one commit and one precondition failure');
    const createdBytes = creates[0]!.status === 200 ? bodyA : bodyB;
    const created = receipt(creates.find(response => response.status === 200)!, resource, null, createdBytes);
    let etag = await read(left, resource, created, createdBytes);
    await read(right, resource, created, createdBytes, etag);

    const partial = await wire(right, resource, 'GET', { accept: binaryType, range: 'bytes=0-1' });
    assert.equal(partial.status, 206);
    assert.deepEqual(partial.body, createdBytes.subarray(0, 2));
    assert.equal(partial.headers['interego-body-digest'], undefined, 'partial GET must not claim a full-body digest');

    // Ordinary Solid mutations cannot bypass a head that was enrolled in native CAS.
    assert.equal((await wire(right, resource, 'PUT', { 'content-type': binaryType }, bodyD)).status, 409, 'ordinary PUT must not replace a native-managed head');
    assert.equal((await wire(left, resource, 'DELETE')).status, 409, 'ordinary DELETE must not erase a native-managed head');
    await read(right, resource, created, createdBytes, etag);

    // Both preconditions refer to the same current GET ETag, so this race cannot
    // pass merely because one writer sent an unsupported conditional syntax.
    const updates = await Promise.all([
      commit(left, resource, created.revision, bodyC, { 'if-match': etag }),
      commit(right, resource, created.revision, bodyD, { 'if-match': etag }),
    ]);
    assert.deepEqual(updates.map(response => response.status).sort(), [200, 412], 'two independent native updaters must produce one commit and one precondition failure');
    const updatedBytes = updates[0]!.status === 200 ? bodyC : bodyD;
    const updated = receipt(updates.find(response => response.status === 200)!, resource, created.revision, updatedBytes);
    assert.notEqual(updated.revision, created.revision);
    const oldEtag = etag;
    etag = await read(right, resource, updated, updatedBytes);
    await read(left, resource, updated, updatedBytes, etag);
    assert.equal((await commit(left, resource, created.revision, bodyA, { 'if-match': oldEtag })).status, 412, 'a stale GET ETag must not overwrite the winner');
    const mismatched = await commit(left, resource, created.revision, bodyA, { 'if-match': etag });
    assert.equal(mismatched.status, 400, 'body expectedRevision and current HTTP condition must agree');
    await read(right, resource, updated, updatedBytes, etag);

    // The wire contract allows either a quoted raw revision or the GET ETag.
    const rawResponse = await commit(left, resource, updated.revision, bodyA);
    const raw = receipt(rawResponse, resource, updated.revision, bodyA);
    etag = await read(right, resource, raw, bodyA);
    const coherent = await concurrentReadCoherence(left, right, coherenceResource);

    // Pin Date.now INSIDE both real server processes. Equal content and clock
    // must not resurrect an earlier revision or let a stale ABA writer commit.
    const fixedNow = Date.now();
    await Promise.all([setClock(left, fixedNow), setClock(right, fixedNow)]);
    const firstResponse = await commit(left, abaResource, null, bodyA);
    const first = receipt(firstResponse, abaResource, null, bodyA);
    const firstEtag = await read(right, abaResource, first, bodyA);
    const middleResponse = await commit(right, abaResource, first.revision, bodyB, { 'if-match': firstEtag });
    const middle = receipt(middleResponse, abaResource, first.revision, bodyB);
    const middleEtag = await read(left, abaResource, middle, bodyB);
    const lastResponse = await commit(left, abaResource, middle.revision, bodyA, { 'if-match': middleEtag });
    const last = receipt(lastResponse, abaResource, middle.revision, bodyA);
    const lastEtag = await read(right, abaResource, last, bodyA);
    assert.deepEqual([first.updatedAt, middle.updatedAt, last.updatedAt], [fixedNow, fixedNow, fixedNow], 'ABA commits must actually share the pinned server clock');
    assert.equal(first.bodyDigest, last.bodyDigest, 'the ABA endpoint representations must be identical');
    assert.equal(new Set([first.revision, middle.revision, last.revision]).size, 3, 'A -> B -> A must assign three distinct revisions at the same clock');
    assert.equal((await commit(right, abaResource, first.revision, bodyC, { 'if-match': firstEtag })).status, 412, 'a pre-ABA revision must stay stale after content returns to A');
    const identicalResponse = await commit(right, abaResource, last.revision, bodyA, { 'if-match': lastEtag });
    const identical = receipt(identicalResponse, abaResource, last.revision, bodyA);
    assert.equal(identical.updatedAt, fixedNow);
    assert.equal(identical.bodyDigest, last.bodyDigest);
    assert.notEqual(identical.revision, last.revision, 'identical bytes at the identical clock still need a fresh revision nonce');
    const identicalEtag = await read(left, abaResource, identical, bodyA);
    await Promise.all([setClock(left, undefined), setClock(right, undefined)]);

    // No graceful stop or process-local flush can rescue these acknowledgements.
    await Promise.all([killWorker(left), killWorker(right)]);
    const restarted = await startWorker(baseUrl);
    await read(restarted, resource, raw, bodyA, etag);
    await read(restarted, abaResource, identical, bodyA, identicalEtag);
    await read(restarted, coherenceResource, coherent.receipt, coherent.bytes, coherent.etag);
    const listing = await wire(restarted, baseUrl, 'GET', { accept: 'text/turtle' });
    assert.equal(listing.status, 200);
    assert.ok(listing.body.toString('utf8').includes(`${prefix}.bin`), 'cold server container index must retain the committed resource');
    assert.ok(listing.body.toString('utf8').includes(`${prefix}-aba.bin`), 'cold server container index must retain the ABA resource');
    assert.ok(listing.body.toString('utf8').includes(`${prefix}-coherence.bin`), 'cold server container index must retain the concurrently read resource');
    const afterRestart = receipt(await commit(restarted, abaResource, identical.revision, bodyC, { 'if-match': identicalEtag }), abaResource, identical.revision, bodyC);
    await read(restarted, abaResource, afterRestart, bodyC);

    // Native-managed heads deliberately reject ordinary deletion. This isolated
    // CI database owns cleanup; random resource names prevent cross-run collisions.
    console.log('CSS native commit HTTP: exact-target OPTIONS, shared-PG multiwriter CAS, coherent GET metadata/bytes, same-clock ABA, and process-death recovery ALL PASS');
  } finally {
    for (const child of [...children]) await killWorker({ child, port: 0 });
  }
}

async function workerMain(): Promise<void> {
  const { AppRunner } = await import('@solid/community-server');
  const originalNow = Date.now;
  process.on('message', (message: WorkerMessage) => {
    if (message.command !== 'clock') return;
    Date.now = typeof message.now === 'number' && Number.isFinite(message.now) ? () => message.now! : originalNow;
    process.send?.({ event: 'clock', id: message.id });
  });
  workerStage = 'validate-worker-config';
  const port = Number(process.env.NATIVE_COMMIT_TEST_PORT);
  const baseUrl = process.env.NATIVE_COMMIT_TEST_BASE_URL;
  assert.ok(Number.isInteger(port) && port > 0 && baseUrl);
  workerStage = 'create-css';
  const app = await new AppRunner().create({
    loaderProperties: { mainModulePath: pkgRoot, typeChecking: false },
    config: configPath,
    shorthand: { port, baseUrl, loggingLevel: 'error', rootFilePath: path.join(os.tmpdir(), `pgsl-native-${randomUUID()}`) },
  });
  workerStage = 'start-css';
  await app.start();
  process.send?.({ event: 'ready' });
}

if (process.argv.includes('--native-commit-worker')) {
  workerMain().catch(error => {
    const diagnostic = workerDiagnostic(error, workerStage);
    if (process.send && process.connected) process.send({ event: 'failed', diagnostic }, () => process.exit(1));
    else process.exit(1);
  });
} else {
  main().catch(error => { console.error('CSS native commit HTTP integration FAILED:', error); process.exitCode = 1; });
}
