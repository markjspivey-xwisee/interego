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
 *
 * One phase runs first in this process, with no CSS server: the native-delete
 * accessor contract over CSS's own DataAccessorBasedStore and the in-memory PGSL
 * engine, including engine answers HTTP cannot reach (CSS's own If-Match check
 * answers a stale ETag before the accessor runs).
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
let requestSequence = 0;
let testPhase = 'startup';
function beginPhase(phase: string): void { testPhase = phase; console.log(`[native-http] phase=${phase}`); }

interface WorkerDiagnostic { stage: string; name: string; code?: string; message: string; frames?: string[]; jsonParse?: true; }
let workerStage = 'import-css';

/** Startup diagnostics are bounded test metadata; never forward stacks, URLs, credentials or payload tokens. */
function workerDiagnostic(error: unknown, stage: string): WorkerDiagnostic {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown } : {};
  const token = (item: unknown): string | undefined => typeof item === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(item) ? item : undefined;
  const message = (typeof value.message === 'string' ? value.message : 'Worker startup failed without an Error message')
    .slice(0, 4096)
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\"'<>]+/g, '[url]')
    .replace(/\b(password|passwd|pwd|secret|token|authorization|capability|private[_ -]?key|encryption[_ -]?key)\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9+\/_=-]{48,}/g, '[redacted-token]')
    .split(/\r?\n/).filter(line => !/^\s*at\s/.test(line)).slice(0, 6).join(' | ').slice(0, 800);
  const stackLines = typeof value.stack === 'string' ? value.stack.split(/\r?\n/).filter(line => /^\s+at\s/.test(line)).slice(0, 12) : [];
  const frames = stackLines.map(line => /[\\/]([A-Za-z0-9_.-]{1,80}:\d+:\d+)\)?\s*$/.exec(line)?.[1]).filter((frame): frame is string => !!frame).slice(0, 6);
  const jsonParse = stackLines.some(line => /^\s+at\s+JSON\.parse\s/.test(line));
  return { stage: token(stage) ?? 'startup', name: token(value.name) ?? 'Error', ...(token(value.code) ? { code: token(value.code) } : {}), message,
    ...(frames.length ? { frames } : {}), ...(jsonParse ? { jsonParse: true as const } : {}) };
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
  let errorReports = 0;
  child.on('message', (message: WorkerMessage) => {
    if (message.event === 'operation-error' && message.diagnostic && ++errorReports <= 24) {
      console.error(`[native-http] worker-operation-error workerPort=${port}`, JSON.stringify(message.diagnostic));
    }
  });
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

/** Failure-only fixture metadata: no query text, parameters, learner data or connection credentials. */
async function reportFixtureDatabaseWaits(): Promise<void> {
  let client: { connect(): Promise<unknown>; query(sql: string): Promise<{ rows: unknown[] }>; end(): Promise<unknown> } | undefined;
  try {
    const { Client } = await import('pg');
    client = new Client({ connectionString: process.env.PGSL_PG_CONNSTR, connectionTimeoutMillis: 2000, query_timeout: 2000 });
    await client.connect();
    const result = await client.query(`SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
      CASE split_part(upper(ltrim(query)), ' ', 1)
        WHEN 'SELECT' THEN 'SELECT' WHEN 'UPDATE' THEN 'UPDATE' WHEN 'INSERT' THEN 'INSERT'
        WHEN 'DELETE' THEN 'DELETE' WHEN 'BEGIN' THEN 'BEGIN' WHEN 'COMMIT' THEN 'COMMIT'
        WHEN 'ROLLBACK' THEN 'ROLLBACK' ELSE 'OTHER' END AS command
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() ORDER BY pid LIMIT 24`);
    console.error('[native-http] isolated-db-waits', JSON.stringify(result.rows));
  } catch (error) {
    console.error('[native-http] isolated-db-waits unavailable', JSON.stringify(workerDiagnostic(error, 'pg-wait-diagnostic')));
  } finally { await client?.end().catch(() => undefined); }
}

/** Connect locally, preserving the resource URL CSS and both PG backends see. */
function wire(worker: Worker, resource: string, method = 'GET', headers: Record<string, string> = {}, body?: Buffer): Promise<WireResponse> {
  const target = new URL(resource);
  const kind = target.pathname === '/' ? 'root' : target.pathname.endsWith('-invalid.bin') ? 'invalid' : target.pathname.endsWith('-coherence.bin') ? 'coherence' : target.pathname.endsWith('-aba.bin') ? 'aba' : 'primary';
  const id = ++requestSequence;
  const label = `phase=${testPhase} request=${id} method=${method} target=${kind} workerPort=${worker.port}`;
  const accept = headers.accept ? `${headers.accept}${headers.accept.includes('application/json') ? '' : ',application/json;q=0.1'}` : 'application/json,*/*;q=0.1';
  const trace = id <= 24;
  if (trace) console.log(`[native-http] start ${label}`);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: worker.port, method,
      path: `${target.pathname}${target.search}`,
      headers: { host: target.host, ...headers, accept, ...(body ? { 'content-length': String(body.length) } : {}) },
    }, response => {
      if (trace) console.log(`[native-http] headers ${label} status=${response.statusCode ?? 0}`);
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => {
        const body = Buffer.concat(chunks);
        if (trace) console.log(`[native-http] end ${label} bytes=${body.length}`);
        if ((response.statusCode ?? 0) >= 500) {
          let detail = 'Non-JSON error response';
          try {
            const parsed = JSON.parse(body.subarray(0, 4096).toString('utf8')) as { message?: unknown; error?: unknown };
            detail = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : 'JSON error response without a public message';
          } catch { /* Do not print arbitrary response bytes. */ }
          console.error(`[native-http] response-error ${label}`, JSON.stringify(workerDiagnostic({ name: 'HttpResponse', code: `HTTP_${response.statusCode}`, message: detail }, 'response')));
        }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
      });
    });
    request.setTimeout(30_000, () => request.destroy(new Error(`CSS native-commit HTTP request timed out: ${label}`)));
    request.once('error', reject);
    if (trace) request.once('finish', () => console.log(`[native-http] sent ${label}`));
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
  assert.equal(response.headers['interego-native-delete'], '1', 'OPTIONS must advertise native delete version 1 explicitly');
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

/**
 * Native delete at the accessor seam, no CSS server. CSS 7.2's DataAccessorBasedStore deletes a
 * document's auxiliary resources (<doc>.acl, <doc>.meta) before the document itself, so a native
 * delete that is refused or loses the engine compare-and-delete must not have removed them.
 */
async function accessorNativeDeleteContract(): Promise<void> {
  const css = await import('@solid/community-server');
  const { PgslDataAccessor } = await import('../dist/PgslDataAccessor.js');
  const { nativeDeleteScope } = await import('../dist/NativeDelete.js');
  const { NativeDeleteOperationHandler } = await import('../dist/NativeDeleteOperationHandler.js');
  const { NativeETagHandler } = await import('../dist/NativeETagHandler.js');
  const { LdpStore } = await import('../../../packages/pgsl-store/dist/ldp.js');
  const { openStore } = await import('../../../packages/pgsl-store/dist/store.js');
  const { InMemoryFdb } = await import('../../../packages/pgsl-store/dist/mem-fdb.js');
  const { CodecRegistry } = await import('../../../packages/pgsl-store/dist/codec.js');
  const { rdfCodec } = await import('../../../packages/pgsl-store/dist/codec-rdf.js');
  type Ldp = InstanceType<typeof LdpStore>;
  const pod = 'css';
  const base = 'http://accessor.native-delete.test/';
  const strong = `sha256:${'1'.repeat(64)}`;

  // An engine conflict is a failed precondition whether the head changed or disappeared.
  for (const conflict of [{ status: 'conflict', revision: 'x' }, { status: 'conflict', revision: null }] as const) {
    const calls: unknown[][] = [];
    const stub = { deleteResourceConditionally: async (...args: unknown[]) => { calls.push(args); return conflict; } } as unknown as Ldp;
    const target = `${base}stub.bin`;
    await assert.rejects(
      nativeDeleteScope.run({ resource: target, expectedRevision: strong, auxiliaries: new Set<string>(), deferredAuxiliaries: [], settled: false },
        () => new PgslDataAccessor(stub).deleteResource({ path: target })),
      (error: unknown) => css.PreconditionFailedHttpError.isInstance(error),
      `an engine conflict with revision ${String(conflict.revision)} must reject as a failed precondition`);
    assert.deepEqual(calls, [[pod, target, strong]], 'the accessor must ask the engine for exactly the scoped revision');
  }

  // CSS's own store, auxiliary strategies (as css:config/util/auxiliary/acl.json) and the native
  // delete handler, over a real LdpStore on the in-memory engine.
  const ldp = new LdpStore(openStore(new InMemoryFdb()), new CodecRegistry().register(rdfCodec));
  const engineDelete = ldp.deleteResourceConditionally.bind(ldp);
  let beforeEngineDelete: (() => Promise<unknown>) | undefined;
  ldp.deleteResourceConditionally = async (...args: Parameters<Ldp['deleteResourceConditionally']>) => {
    const step = beforeEngineDelete;
    beforeEngineDelete = undefined;
    await step?.();
    return engineDelete(...args);
  };
  const accessor = new PgslDataAccessor(ldp, pod);
  const metaStrategy = new css.ComposedAuxiliaryStrategy(new css.SuffixAuxiliaryIdentifierStrategy('.meta'), undefined, undefined, false, false);
  const aclStrategy = new css.ComposedAuxiliaryStrategy(new css.SuffixAuxiliaryIdentifierStrategy('.acl'), undefined, undefined, true, true);
  const auxiliaryStrategy = new css.RoutingAuxiliaryStrategy([aclStrategy, metaStrategy]);
  const store = new css.DataAccessorBasedStore(accessor, new css.SingleRootIdentifierStrategy(base),
    auxiliaryStrategy, metaStrategy);
  const handler = new NativeDeleteOperationHandler(store, auxiliaryStrategy);
  const eTags = new NativeETagHandler();
  const exists = async (path: string): Promise<boolean> => (await ldp.stat(pod, path)) !== null;
  const nativeDelete = async (path: string) => {
    const etag = eTags.getETag(await accessor.getMetadata({ path }));
    assert.ok(etag);
    const conditions = Object.assign(new css.BasicConditions(eTags, { matchesETag: [etag] }), { nativeDelete: true as const });
    return handler.handle({ operation: { method: 'DELETE', target: { path }, preferences: {}, conditions, body: new css.BasicRepresentation() } });
  };
  const aclBody = (subject: string): Uint8Array => Buffer.from(`@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#public> a acl:Authorization; acl:agentClass <http://xmlns.com/foaf/0.1/Agent>; acl:accessTo <${subject}>; acl:mode acl:Read.\n`);
  const commitBytes = async (path: string, value: string, expectedRevision: string | null): Promise<string> => {
    const committed = await ldp.commitResource(pod, path, Buffer.from(value), 'application/octet-stream', { expectedRevision });
    assert.equal(committed.status, 'committed');
    return committed.revision;
  };

  // Another writer commits after CSS's If-Match check passed: the engine refuses, the .acl stays.
  const raced = `${base}raced.bin`;
  const first = await commitBytes(raced, 'first', null);
  await ldp.writeResource(pod, `${raced}.acl`, aclBody(raced), 'text/turtle');
  let second: string | undefined;
  beforeEngineDelete = async () => { second = await commitBytes(raced, 'second', first); };
  await assert.rejects(nativeDelete(raced), (error: unknown) => css.PreconditionFailedHttpError.isInstance(error),
    'a native delete that loses the engine compare-and-delete must be a failed precondition');
  assert.ok(second, 'the interleaved writer must have committed before the engine delete');
  assert.equal((await ldp.stat(pod, raced))?.revision, second, 'the interleaved writer must keep its head');
  assert.ok(await exists(`${raced}.acl`), 'a native delete that loses the engine compare-and-delete must keep the .acl');

  // The exact delete removes the document, then the auxiliary CSS asked to delete first.
  assert.equal((await nativeDelete(raced)).statusCode, 205);
  assert.ok(!await exists(raced), 'the exact native delete must remove the document');
  assert.ok(!await exists(`${raced}.acl`), 'the exact native delete must remove the deferred .acl');

  // A legacy head is refused by the engine (409), and its .acl stays.
  const legacy = `${base}legacy.bin`;
  await ldp.writeResource(pod, legacy, Buffer.from('legacy'), 'application/octet-stream');
  await ldp.writeResource(pod, `${legacy}.acl`, aclBody(legacy), 'text/turtle');
  await assert.rejects(nativeDelete(legacy), (error: unknown) => css.ConflictHttpError.isInstance(error),
    'a native delete of a legacy head must be refused');
  assert.ok(await exists(legacy), 'a refused native delete must keep the legacy document');
  assert.ok(await exists(`${legacy}.acl`), 'a refused native delete must keep the .acl');

  // An absent auxiliary is answered NotFound (CSS ignores it) and is not held for deletion.
  const deferredAuxiliaries: { path: string }[] = [];
  const legacyAuxiliaries = new Set([`${legacy}.acl`, `${legacy}.meta`]);
  await assert.rejects(
    nativeDeleteScope.run({ resource: legacy, expectedRevision: strong, auxiliaries: legacyAuxiliaries, deferredAuxiliaries, settled: false },
      () => accessor.deleteResource({ path: `${legacy}.meta` })),
    (error: unknown) => css.NotFoundHttpError.isInstance(error), 'an absent auxiliary must be answered NotFound');
  assert.deepEqual(deferredAuxiliaries, [], 'an absent auxiliary must not be held for deletion');

  // Only the target's own auxiliaries are held, and only until the target is decided. A path that
  // merely starts with the target's (CSS's own /.internal/ records under a target named /.i), and
  // any delete made in the scope after the target settled, are ordinary deletes.
  const prefix = `${base}.i`;
  const internal = `${base}.internal/notifications/record.json`;
  await commitBytes(prefix, 'prefix', null);
  await ldp.writeResource(pod, internal, Buffer.from('{}'), 'application/json');
  const prefixAuxiliaries = new Set([`${prefix}.acl`, `${prefix}.meta`]);
  const prefixScope = { resource: prefix, expectedRevision: strong, auxiliaries: prefixAuxiliaries, deferredAuxiliaries: [] as { path: string }[], settled: false };
  await nativeDeleteScope.run(prefixScope, () => accessor.deleteResource({ path: internal }));
  assert.ok(!await exists(internal), 'a path that only starts with the target must be deleted as an ordinary delete');
  assert.deepEqual(prefixScope.deferredAuxiliaries, [], 'a path that only starts with the target must not be held');
  const settledAcl = `${legacy}.acl`;
  const settledScope = { resource: legacy, expectedRevision: strong, auxiliaries: legacyAuxiliaries, deferredAuxiliaries: [] as { path: string }[], settled: true };
  await nativeDeleteScope.run(settledScope, () => accessor.deleteResource({ path: settledAcl }));
  assert.ok(!await exists(settledAcl), 'an auxiliary deleted after the target settled must be an ordinary delete');
  assert.deepEqual(settledScope.deferredAuxiliaries, [], 'nothing may be held once the target settled');
}

async function main(): Promise<void> {
  assert.notEqual(process.env.PGSL_INMEM, '1', 'native multiwriter/restart proof requires real shared PostgreSQL; PGSL_INMEM is only a wiring smoke');
  assert.ok(process.env.PGSL_PG_CONNSTR, 'PGSL_PG_CONNSTR must point to the isolated integration-test PostgreSQL database');
  const diagnosticProbe = workerDiagnostic(new Error('Found multiple types BasicETagHandler NativeETagHandler\npostgresql://fixture:fixture-password@localhost/example token=fixture-secret'), 'create-css');
  assert.ok(diagnosticProbe.message.includes('BasicETagHandler'));
  assert.ok(!/fixture-password|fixture-secret/.test(diagnosticProbe.message), 'startup diagnostics must redact fixture credentials');
  assert.ok(diagnosticProbe.message.length <= 800);
  beginPhase('accessor-native-delete');
  await accessorNativeDeleteContract();
  const canonicalPort = await freePort();
  const baseUrl = `http://127.0.0.1:${canonicalPort}/`;
  const prefix = `native-commit-${randomUUID()}`;
  const resource = `${baseUrl}${prefix}.bin`;
  const abaResource = `${baseUrl}${prefix}-aba.bin`;
  const coherenceResource = `${baseUrl}${prefix}-coherence.bin`;
  const invalidResource = `${baseUrl}${prefix}-invalid.bin`;
  const deleteResource = `${baseUrl}${prefix}-delete.bin`;
  const guardResource = `${baseUrl}${prefix}-delete-guards.bin`;
  const aclResource = `${baseUrl}${prefix}-delete-acl.bin`;
  const legacyAclResource = `${baseUrl}${prefix}-delete-legacy-acl.bin`;
  const bodyA = Buffer.from([0, 255, 1, 13, 10, 200, 65]);
  const bodyB = Buffer.from([0, 254, 2, 13, 10, 199, 66]);
  const bodyC = Buffer.from([0, 253, 3, 13, 10, 198, 67]);
  const bodyD = Buffer.from([0, 252, 4, 13, 10, 197, 68]);

  try {
    beginPhase('start-workers');
    const left = await startWorker(baseUrl);
    const right = await startWorker(baseUrl);
    beginPhase('root-readiness');
    for (const worker of [left, right]) assert.equal((await wire(worker, baseUrl, 'GET', { accept: 'application/json,text/turtle;q=0.9' })).status, 200);
    beginPhase('native-discovery');
    for (const worker of [left, right]) await expectNativeOptions(worker, invalidResource);

    beginPhase('reject-missing-condition');
    const missingHeader = await commit(left, invalidResource, null, bodyA, {});
    assert.ok(missingHeader.status >= 400 && missingHeader.status < 500, 'native create must refuse a missing If-None-Match condition');
    assert.equal((await wire(right, invalidResource)).status, 404, 'refused create must leave no resource on the other server');

    // Neither process shares a CSS lock. Exactly one absent-head CAS may commit.
    beginPhase('create-race');
    const creates = await Promise.all([commit(left, resource, null, bodyA), commit(right, resource, null, bodyB)]);
    assert.deepEqual(creates.map(response => response.status).sort(), [200, 412], 'two independent native creators must produce one commit and one precondition failure');
    const createdBytes = creates[0]!.status === 200 ? bodyA : bodyB;
    const created = receipt(creates.find(response => response.status === 200)!, resource, null, createdBytes);
    beginPhase('read-created');
    let etag = await read(left, resource, created, createdBytes);
    await read(right, resource, created, createdBytes, etag);

    beginPhase('range-read');
    const partial = await wire(right, resource, 'GET', { accept: binaryType, range: 'bytes=0-1' });
    assert.equal(partial.status, 206);
    assert.deepEqual(partial.body, createdBytes.subarray(0, 2));
    assert.equal(partial.headers['interego-body-digest'], undefined, 'partial GET must not claim a full-body digest');

    // Ordinary Solid mutations cannot bypass a head that was enrolled in native CAS.
    beginPhase('reject-ordinary-mutations');
    assert.equal((await wire(right, resource, 'PUT', { 'content-type': binaryType }, bodyD)).status, 409, 'ordinary PUT must not replace a native-managed head');
    assert.equal((await wire(left, resource, 'DELETE')).status, 409, 'ordinary DELETE must not erase a native-managed head');
    await read(right, resource, created, createdBytes, etag);

    // Both preconditions refer to the same current GET ETag, so this race cannot
    // pass merely because one writer sent an unsupported conditional syntax.
    beginPhase('update-race');
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
    beginPhase('stale-and-inconsistent');
    assert.equal((await commit(left, resource, created.revision, bodyA, { 'if-match': oldEtag })).status, 412, 'a stale GET ETag must not overwrite the winner');
    const mismatched = await commit(left, resource, created.revision, bodyA, { 'if-match': etag });
    assert.equal(mismatched.status, 400, 'body expectedRevision and current HTTP condition must agree');
    await read(right, resource, updated, updatedBytes, etag);

    // The wire contract allows either a quoted raw revision or the GET ETag.
    beginPhase('raw-revision-update');
    const rawResponse = await commit(left, resource, updated.revision, bodyA);
    const raw = receipt(rawResponse, resource, updated.revision, bodyA);
    etag = await read(right, resource, raw, bodyA);

    beginPhase('native-conditional-delete');
    const deletable = receipt(await commit(left, deleteResource, null, bodyB), deleteResource, null, bodyB);
    const deleteEtag = await read(right, deleteResource, deletable, bodyB);
    assert.equal((await wire(left, deleteResource, 'DELETE', { 'if-match': deleteEtag })).status, 409,
      'If-Match alone must not opt an ordinary DELETE into native deletion');
    assert.equal((await wire(left, deleteResource, 'DELETE', {
      'if-match': `"sha256:${'0'.repeat(64)}"`, 'interego-native-delete': '1',
    })).status, 412, 'a stale native delete must fail its precondition');
    await read(right, deleteResource, deletable, bodyB, deleteEtag);
    assert.equal((await wire(left, deleteResource, 'DELETE', {
      'if-match': deleteEtag, 'interego-native-delete': '1',
    })).status, 205, 'an exact native delete must use CSS normal successful DELETE response');
    assert.equal((await wire(right, deleteResource)).status, 404);
    assert.equal((await wire(right, deleteResource, 'DELETE', {
      'if-match': deleteEtag, 'interego-native-delete': '1',
    })).status, 412, 'an absent exact target must be a precondition failure');
    assert.equal((await wire(left, baseUrl, 'DELETE', {
      'if-match': deleteEtag, 'interego-native-delete': '1',
    })).status, 400, 'native deletion must refuse containers');

    // Each malformed or unknown opt-in leaves the live native document in place.
    beginPhase('native-delete-guards');
    const guarded = receipt(await commit(left, guardResource, null, bodyC), guardResource, null, bodyC);
    const guardEtag = await read(right, guardResource, guarded, bodyC);
    const zeroEtag = `"sha256:${'0'.repeat(64)}"`;
    for (const [headers, status, why] of [
      [{ 'interego-native-delete': '1', 'if-match': `${guardEtag}, ${zeroEtag}` }, 400, 'native delete must refuse two If-Match validators'],
      [{ 'interego-native-delete': '1', 'if-match': guardEtag, 'if-none-match': zeroEtag }, 400, 'native delete must refuse If-None-Match beside If-Match'],
      [{ 'interego-native-delete': '2', 'if-match': guardEtag }, 409, 'an unknown native-delete version must stay an ordinary DELETE of a native head'],
      [{ 'interego-native-delete': '1' }, 400, 'native delete must refuse a missing If-Match'],
      [{ 'interego-native-delete': '1', 'if-match': '*' }, 400, 'native delete must refuse If-Match: *'],
      [{ 'interego-native-delete': '1', 'if-match': `W/${guardEtag}` }, 400, 'native delete must refuse a weak validator'],
    ] as const) {
      assert.equal((await wire(left, guardResource, 'DELETE', headers)).status, status, why);
      await read(right, guardResource, guarded, bodyC, guardEtag);
    }

    // CSS deletes a document's auxiliaries before the document; a native delete that does not
    // delete the document must not have deleted its .acl.
    beginPhase('native-delete-auxiliaries');
    const aclBody = (subject: string): Buffer => Buffer.from(`@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#public> a acl:Authorization; acl:agentClass <http://xmlns.com/foaf/0.1/Agent>; acl:accessTo <${subject}>; acl:mode acl:Read.\n`);
    const putAcl = async (subject: string): Promise<void> => {
      assert.equal((await wire(left, `${subject}.acl`, 'PUT', { 'content-type': 'text/turtle' }, aclBody(subject))).status, 201,
        'this configuration must accept a per-document .acl');
      assert.equal((await wire(right, `${subject}.acl`, 'GET', { accept: 'text/turtle' })).status, 200);
    };
    const aclStatus = async (subject: string): Promise<number> => (await wire(right, `${subject}.acl`, 'GET', { accept: 'text/turtle' })).status;
    const withAcl = receipt(await commit(left, aclResource, null, bodyD), aclResource, null, bodyD);
    const withAclEtag = await read(right, aclResource, withAcl, bodyD);
    await putAcl(aclResource);
    assert.equal((await wire(left, aclResource, 'DELETE', { 'if-match': zeroEtag, 'interego-native-delete': '1' })).status, 412,
      'a stale native delete of a document with an .acl must fail its precondition');
    assert.equal(await aclStatus(aclResource), 200, 'a stale native delete must keep the document .acl');
    await read(right, aclResource, withAcl, bodyD, withAclEtag);
    assert.equal((await wire(left, aclResource, 'DELETE', { 'if-match': withAclEtag, 'interego-native-delete': '1' })).status, 205,
      'an exact native delete of a document with an .acl must succeed');
    assert.equal((await wire(right, aclResource)).status, 404);
    assert.equal(await aclStatus(aclResource), 404, 'an exact native delete must delete the document .acl');
    // A legacy head passes CSS's If-Match check with its own strong ETag, so the engine is what
    // refuses it (409), after CSS has asked for the .acl to be deleted.
    assert.equal((await wire(left, legacyAclResource, 'PUT', { 'content-type': binaryType }, bodyA)).status, 201);
    const legacyRead = await wire(right, legacyAclResource, 'GET', { accept: binaryType });
    assert.equal(legacyRead.status, 200);
    const legacyEtag = strongEtag(legacyRead);
    await putAcl(legacyAclResource);
    assert.equal((await wire(left, legacyAclResource, 'DELETE', { 'if-match': legacyEtag, 'interego-native-delete': '1' })).status, 409,
      'a native delete of a legacy head must be refused');
    assert.equal(await aclStatus(legacyAclResource), 200, 'a refused native delete must keep the document .acl');
    assert.deepEqual((await wire(right, legacyAclResource, 'GET', { accept: binaryType })).body, bodyA, 'a refused native delete must keep the legacy document');
    assert.equal((await wire(left, legacyAclResource, 'DELETE')).status, 205, 'an ordinary DELETE of a legacy head still succeeds');
    assert.equal(await aclStatus(legacyAclResource), 404, 'an ordinary DELETE still deletes the document .acl');

    beginPhase('concurrent-get-coherence');
    const coherent = await concurrentReadCoherence(left, right, coherenceResource);

    // Pin Date.now INSIDE both real server processes. Equal content and clock
    // must not resurrect an earlier revision or let a stale ABA writer commit.
    beginPhase('same-clock-aba');
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
    beginPhase('kill-and-recover');
    await Promise.all([killWorker(left), killWorker(right)]);
    const restarted = await startWorker(baseUrl);
    beginPhase('cold-get-and-index');
    await read(restarted, resource, raw, bodyA, etag);
    await read(restarted, abaResource, identical, bodyA, identicalEtag);
    await read(restarted, coherenceResource, coherent.receipt, coherent.bytes, coherent.etag);
    const listing = await wire(restarted, baseUrl, 'GET', { accept: 'text/turtle' });
    assert.equal(listing.status, 200);
    assert.ok(listing.body.toString('utf8').includes(`${prefix}.bin`), 'cold server container index must retain the committed resource');
    assert.ok(listing.body.toString('utf8').includes(`${prefix}-aba.bin`), 'cold server container index must retain the ABA resource');
    assert.ok(listing.body.toString('utf8').includes(`${prefix}-coherence.bin`), 'cold server container index must retain the concurrently read resource');
    beginPhase('post-recovery-commit');
    const afterRestart = receipt(await commit(restarted, abaResource, identical.revision, bodyC, { 'if-match': identicalEtag }), abaResource, identical.revision, bodyC);
    await read(restarted, abaResource, afterRestart, bodyC);

    // Native-managed heads deliberately reject ordinary deletion. This isolated
    // CI database owns cleanup; random resource names prevent cross-run collisions.
    console.log('CSS native commit HTTP: native-delete accessor contract, exact-target OPTIONS, shared-PG multiwriter CAS, native delete guards and auxiliaries, coherent GET metadata/bytes, same-clock ABA, and process-death recovery ALL PASS');
  } catch (error) {
    await reportFixtureDatabaseWaits();
    throw error;
  } finally {
    for (const child of [...children]) await killWorker({ child, port: 0 });
  }
}

async function workerMain(): Promise<void> {
  const { AppRunner, SafeErrorHandler, MemoryMapStorage } = await import('@solid/community-server');
  const safeHandle = SafeErrorHandler.prototype.handle;
  SafeErrorHandler.prototype.handle = async function(this: InstanceType<typeof SafeErrorHandler>, input: Parameters<typeof safeHandle>[0]) {
    process.send?.({ event: 'operation-error', diagnostic: workerDiagnostic(input.error, 'css-http-error') });
    if (input.error.cause) process.send?.({ event: 'operation-error', diagnostic: workerDiagnostic(input.error.cause, 'css-http-cause') });
    return safeHandle.call(this, input);
  };
  workerStage = 'instrument-native-errors';
  const { NativePutOperationHandler } = await import('../dist/NativePutOperationHandler.js');
  const nativeHandle = NativePutOperationHandler.prototype.handle;
  NativePutOperationHandler.prototype.handle = async function(this: InstanceType<typeof NativePutOperationHandler>, input: Parameters<typeof nativeHandle>[0]) {
    try { return await nativeHandle.call(this, input); }
    catch (error) {
      process.send?.({ event: 'operation-error', diagnostic: workerDiagnostic(error, 'native-put') });
      throw error;
    }
  };
  const { NativeGetOperationHandler } = await import('../dist/NativeGetOperationHandler.js');
  const nativeGet = NativeGetOperationHandler.prototype.handle;
  NativeGetOperationHandler.prototype.handle = async function(this: InstanceType<typeof NativeGetOperationHandler>, input: Parameters<typeof nativeGet>[0]) {
    try { return await nativeGet.call(this, input); }
    catch (error) {
      process.send?.({ event: 'operation-error', diagnostic: workerDiagnostic(error, 'native-get') });
      throw error;
    }
  };
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
  const runner = new AppRunner();
  type FixtureManager = { instantiate(id: string, settings: Record<string, unknown>): Promise<unknown> };
  const createManager = Reflect.get(runner, 'createComponentsManager') as (...args: unknown[]) => Promise<FixtureManager>;
  Object.defineProperty(runner, 'createComponentsManager', { value: async (...args: unknown[]) => {
    const manager = await createManager.apply(runner, args);
    workerStage = 'validate-lock-storage';
    const lockStorage = await manager.instantiate('urn:solid-server:default:LockStorage', {});
    assert.ok(lockStorage && typeof lockStorage === 'object');
    assert.ok(Reflect.get(lockStorage, 'source') instanceof MemoryMapStorage,
      'memory resource mutexes require process-local reader counts from the actual ComponentsJS instance');
    workerStage = 'create-css';
    return manager;
  } });
  const app = await runner.create({
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

