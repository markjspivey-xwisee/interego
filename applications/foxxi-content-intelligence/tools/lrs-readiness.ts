/**
 * Exercise the real Foxxi HTTP LRS on the native CSS/gate/PostgreSQL fixture.
 * Each corpus and credential is synthetic. The ADL suite leaves records behind.
 */
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { NATIVE_CSS_FIXTURE_CAPABILITY, startNativeCssFixture } from '../tests/support/native-css-fixture.js';

const ADL_COMMIT = '5bc232d349c60faded8240da698f195106091638';
const sourceDb = 'foxxi_lrs_readiness';
const restoreDb = 'foxxi_lrs_restore';
const database = new URL(process.env.TEST_NATIVE_PG_URL ?? 'postgresql://127.0.0.1');
const container = process.env.FOXXI_TEST_POSTGRES_CONTAINER ?? '';
const suiteDirectory = resolve(process.env.FOXXI_TEST_ADL_DIRECTORY ?? '.');
const reportDirectory = resolve(process.env.FOXXI_TEST_REPORT_DIRECTORY ?? 'foxxi-readiness');
const statementCount = Number(process.env.FOXXI_TEST_STATEMENTS ?? 1000);
assert(
  database.protocol === 'postgresql:' && database.hostname === '127.0.0.1'
  && database.pathname === '/' + sourceDb && database.username === 'foxxi_test',
  'Use the isolated native LRS readiness database.',
);
assert(/^[0-9a-f]{12,64}$/.test(container), 'Use the isolated PostgreSQL service container.');
assert(Number.isInteger(statementCount) && statementCount >= 100 && statementCount <= 10_000, 'Choose 100–10,000 synthetic statements.');

const restoreUrl = new URL(database);
restoreUrl.pathname = '/' + restoreDb;
const adlScript = join(suiteDirectory, 'bin', 'console_runner.js');
const childScript = fileURLToPath(new URL('../tests/support/durable-lrs-http-child.ts', import.meta.url));
const owner = 'did:web:synthetic-foxxi-readiness.test:service' as IRI;
const privateKey = '0x' + '19'.repeat(32);
const ownerPublicKey = deriveEncryptionKeyPair(privateKey, owner).publicKey;
const password = randomBytes(24).toString('hex');
const accounts = ['alice', 'bob', 'adl'] as const;
type Account = typeof accounts[number];
type Version = '1.0.3' | '2.0.0';
const actor = { objectType: 'Agent', mbox: 'mailto:fixture@example.test' };
const activityId = 'https://fixture.example.test/performance';
const verb = { id: 'http://adlnet.gov/expapi/verbs/experienced' };
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const ms = (start: number) => Math.round((performance.now() - start) * 100) / 100;
const headers = (account: Account = 'alice', version: Version = '2.0.0') => ({
  Authorization: 'Basic ' + Buffer.from(account + ':' + password).toString('base64'),
  'X-Experience-API-Version': version,
});
const endpoint = (path: string, params: Record<string, string>) => '/xapi/' + path + '?' + new URLSearchParams(params);
const state = endpoint('activities/state', { activityId, agent: JSON.stringify(actor), stateId: 'checkpoint' });
const activityProfile = endpoint('activities/profile', { activityId, profileId: 'practice' });
const agentProfile = endpoint('agents/profile', { agent: JSON.stringify(actor), profileId: 'practice' });
const statementsPath = '/xapi/statements';
const makeStatement = () => ({ id: randomUUID(), actor, verb, object: { objectType: 'Activity', id: activityId } });

async function startLrs(pod: string, scope: string) {
  const child = fork(childScript, [], {
    execArgv: ['--import', 'tsx'],
    silent: true,
    env: {
      ...process.env, NODE_ENV: 'test', FOXXI_LRS_BACKEND: 'interego',
      FOXXI_LRS_NATIVE_POD_URL: pod, FOXXI_LRS_NATIVE_OWNER: owner, FOXXI_LRS_NATIVE_PRIVATE_KEY: privateKey,
      FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: ownerPublicKey, FOXXI_LRS_NATIVE_CAPABILITY: NATIVE_CSS_FIXTURE_CAPABILITY,
      FOXXI_LRS_NATIVE_HEAD_URL: new URL('foxxi/lrs/readiness/' + scope + '/head', pod).href,
      FOXXI_LRS_NATIVE_ARTIFACT_CONTAINER: new URL('foxxi/lrs/readiness/' + scope + '/artifacts/', pod).href,
      LRS_TEST_BASIC_AUTH_PAIRS: accounts.map(account => account + ':' + password + ':' + account).join(','),
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  };
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(() => reject(new Error('Foxxi readiness fixture timed out')), 30_000);
      child.once('message', (event: { event?: string; port?: number }) => {
        clearTimeout(timer);
        if (event.event === 'ready' && event.port) resolvePort(event.port);
        else reject(new Error('Foxxi readiness fixture did not declare a port'));
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Foxxi readiness fixture could not start')); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Foxxi readiness fixture exited')); });
    });
    return { base: 'http://127.0.0.1:' + port, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function request(base: string, path: string, expected: number, init: RequestInit = {}) {
  const response = await fetch(base + path, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(90_000),
    headers: { ...headers(), ...init.headers },
  });
  assert.equal(response.status, expected, (init.method ?? 'GET') + ' ' + path.split('?')[0]);
  return response;
}

async function batch(base: string, statements: ReturnType<typeof makeStatement>[]) {
  const start = performance.now();
  const response = await request(base, statementsPath, 200, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statements),
  });
  assert.deepEqual(await response.json(), statements.map(statement => statement.id));
  return ms(start);
}

async function page(base: string, path: string) {
  const response = await request(base, path, 200);
  const result = await response.json() as { statements: { id: string }[]; more?: string | null };
  assert(Array.isArray(result.statements) && (result.more == null || typeof result.more === 'string'), 'Expected a StatementResult.');
  return result;
}

async function allStatements(base: string) {
  const records = new Map<string, string>();
  let path = statementsPath + '?limit=100';
  while (path) {
    const result = await page(base, path);
    for (const statement of result.statements) {
      assert(!records.has(statement.id), 'Readback contains duplicate statements.');
      records.set(statement.id, digest(JSON.stringify(statement)));
    }
    assert(records.size <= statementCount + 2, 'Readback contains unexpected records.');
    if (!result.more) break;
    assert(result.statements.length > 0, 'The unfiltered cursor must make progress.');
    const next = new URL(result.more, base);
    assert.equal(next.pathname, statementsPath, 'Continuation must name the Statements resource.');
    path = next.pathname + next.search;
  }
  const ids = [...records.keys()].sort();
  return { ids, sha256: digest(JSON.stringify(ids.map(id => [id, records.get(id)]))) };
}

function distribution(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { requests: sorted.length, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99), maxMs: sorted.at(-1) };
}

async function load(base: string) {
  const seeded = Array.from({ length: statementCount }, makeStatement);
  const writes = [];
  const start = performance.now();
  for (let offset = 0; offset < seeded.length; offset += 16) writes.push(await batch(base, seeded.slice(offset, offset + 16)));
  const elapsedMs = ms(start);
  const reads = [];
  for (let sample = 0; sample < 6; sample++) {
    reads.push(...await Promise.all(Array.from({ length: 4 }, async () => {
      const begin = performance.now();
      const result = await page(base, statementsPath + '?limit=25&ascending=true');
      assert.equal(result.statements.length, 25);
      return ms(begin);
    })));
  }
  return {
    ids: seeded.map(statement => statement.id),
    metrics: { statements: seeded.length, elapsedMs, statementsPerSecond: Math.round(seeded.length * 1000 / elapsedMs),
      batchWrites: distribution(writes), firstPagesParallelism: 4, firstPages: distribution(reads) },
  };
}

async function seedRecovery(base: string) {
  const target = makeStatement();
  const voiding = { ...makeStatement(), verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: target.id } };
  const bytes = randomBytes(3072);
  const sha2 = digest(bytes);
  const attached = { ...target, attachments: [{
    usageType: 'https://fixture.example.test/attachment', display: { en: 'Synthetic sample' },
    contentType: 'application/octet-stream', length: bytes.length, sha2,
  }] };
  const boundary = 'foxxi-readiness-' + randomUUID();
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(attached) +
      '\r\n--' + boundary + '\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\nX-Experience-API-Hash: ' + sha2 + '\r\n\r\n'),
    bytes, Buffer.from('\r\n--' + boundary + '--\r\n'),
  ]);
  const posted = await request(base, statementsPath, 200, {
    method: 'POST', headers: { 'Content-Type': 'multipart/mixed; boundary=' + boundary }, body,
  });
  assert.deepEqual(await posted.json(), [target.id]);
  await request(base, state, 204, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  for (const path of [activityProfile, agentProfile]) {
    await request(base, path, 204, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"synthetic":true}' });
  }
  await request(base, statementsPath, 200, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(voiding) });
  return { target: target.id, voiding: voiding.id, bytes, sha2 };
}

async function readRecovery(base: string, data: Awaited<ReturnType<typeof seedRecovery>>, expectedIds: string[]) {
  const start = performance.now();
  const statements = await allStatements(base);
  const completeReadMs = ms(start);
  assert.deepEqual(statements.ids, expectedIds);
  const targetPath = endpoint('statements', { statementId: data.target });
  const voidedPath = endpoint('statements', { voidedStatementId: data.target });
  await request(base, targetPath, 404);
  await request(base, voidedPath, 404, { headers: headers('bob') });
  await request(base, state, 404, { headers: headers('bob') });
  const attachment = await request(base, voidedPath + '&attachments=true', 200);
  assert.match(attachment.headers.get('content-type') ?? '', /^multipart\/mixed/i);
  assert(Buffer.from(await attachment.arrayBuffer()).includes(data.bytes), 'Expected the original attachment bytes.');
  const fingerprints = [];
  for (const path of [voidedPath, endpoint('statements', { statementId: data.voiding }), state, activityProfile, agentProfile]) {
    const response = await request(base, path, 200);
    const body = Buffer.from(await response.arrayBuffer());
    if (path === state) assert.deepEqual(body, data.bytes);
    const etag = path.startsWith('/xapi/statements') ? null : response.headers.get('etag');
    if (!path.startsWith('/xapi/statements')) assert(etag, 'Document is missing its ETag.');
    fingerprints.push({ sha256: digest(body), etag });
  }
  return { fingerprints, completeReadMs, statementsSha256: statements.sha256 };
}

function pg(command: string, args: string[], input: number | 'ignore', output: number | 'ignore') {
  const result = spawnSync('docker', ['exec', '-i', container, command, ...args], {
    stdio: [input, output, 'pipe'], timeout: 120_000,
  });
  assert.equal(result.status, 0, command + ' did not complete against the isolated PostgreSQL service.');
}

function dumpAndRestore() {
  const bundle = join(reportDirectory, 'synthetic-native.dump');
  const startedDump = performance.now();
  const destination = openSync(bundle, 'wx');
  try {
    pg('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '-U', database.username, sourceDb], 'ignore', destination);
  } finally { closeSync(destination); }
  const dumpMs = ms(startedDump);
  const sizeBytes = statSync(bundle).size;
  assert(sizeBytes > 0, 'Expected a nonempty native database backup.');
  const startedRestore = performance.now();
  const source = openSync(bundle, 'r');
  try {
    pg('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges',
      '-U', database.username, '-d', restoreDb], source, 'ignore');
  } finally { closeSync(source); }
  return { sizeBytes, dumpMs, restoreMs: ms(startedRestore) };
}

interface AdlCase { status?: string; title?: string; requirement?: unknown; tests?: AdlCase[] }
function failedCases(node?: AdlCase): { title: string; requirement?: string }[] {
  if (!node) return [];
  if (node.tests?.length) return node.tests.flatMap(failedCases);
  return node.status === 'failed' ? [{ title: node.title ?? '(unnamed case)',
    ...(typeof node.requirement === 'string' ? { requirement: node.requirement } : {}) }] : [];
}

function adl(base: string, version: Version) {
  const logDirectory = join(suiteDirectory, 'logs');
  const oldLogs = new Set(existsSync(logDirectory) ? readdirSync(logDirectory) : []);
  const start = performance.now();
  const child = spawnSync(process.execPath, [adlScript, '-x', version, '-e', base + '/xapi', '-a', '-u', 'adl', '-p', password], {
    cwd: suiteDirectory, stdio: 'ignore', timeout: 360_000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  const logs = existsSync(logDirectory) ? readdirSync(logDirectory).filter(name => name.endsWith('.log') && !oldLogs.has(name)) : [];
  assert.equal(logs.length, 1, 'ADL runner did not produce one result for ' + version + ' (exit ' + child.status + ').');
  const record = JSON.parse(readFileSync(join(logDirectory, logs[0]!), 'utf8')) as {
    summary: { total: number; passed: number; failed: number; version: string }; log?: AdlCase;
  };
  const { summary } = record;
  assert.equal(summary.version, version);
  assert(Number.isSafeInteger(summary.total) && summary.total > 1000
    && Number.isSafeInteger(summary.passed) && summary.passed >= 0
    && Number.isSafeInteger(summary.failed) && summary.failed >= 0
    && summary.total === summary.passed + summary.failed
    && child.status === summary.failed % 256, 'ADL runner did not finish the complete ' + version + ' suite.');
  return { ...summary, elapsedMs: ms(start), result: summary.failed ? 'failed' : 'passed', failedCases: failedCases(record.log) };
}

mkdirSync(reportDirectory, { recursive: true });
const proof: Record<string, unknown> = {
  schemaVersion: 1, target: 'isolated Foxxi HTTP LRS through native CSS gate and PostgreSQL',
  sourceCommit: process.env.GITHUB_SHA ?? null, adlCommit: ADL_COMMIT, node: process.version,
  startedAt: new Date().toISOString(), sample: 'synthetic', stages: {},
};
const stages = proof.stages as Record<string, unknown>;
const reportPath = join(reportDirectory, 'report.json');
const persist = () => writeFileSync(reportPath, JSON.stringify(proof, null, 2) + '\n');
persist();

try {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: suiteDirectory, encoding: 'utf8', timeout: 10_000 });
  assert.equal(git.stdout?.trim(), ADL_COMMIT, 'Unexpected ADL suite commit.');
  proof.adlResolvedLockSha256 = digest(readFileSync(join(suiteDirectory, 'package-lock.json')));
  pg('createdb', ['-U', database.username, sourceDb], 'ignore', 'ignore');
  pg('createdb', ['-U', database.username, restoreDb], 'ignore', 'ignore');
  const fixture = await startNativeCssFixture();
  try {
    const scope = randomUUID();
    const before = await startLrs(fixture.podUrl, scope);
    let recovery: Awaited<ReturnType<typeof seedRecovery>>;
    let expectedIds: string[];
    let original: Awaited<ReturnType<typeof readRecovery>>;
    try {
      const about = await (await request(before.base, '/xapi/about', 200)).json() as { extensions: Record<string, unknown> };
      assert(Object.entries(about.extensions).some(([iri, value]) =>
        iri.endsWith('#lrsBackend') && typeof value === 'string' && value.startsWith('interego')));
      const corpus = await load(before.base);
      stages.load = corpus.metrics;
      persist();
      recovery = await seedRecovery(before.base);
      expectedIds = [...corpus.ids, recovery.voiding].sort();
      original = await readRecovery(before.base, recovery, expectedIds);
    } finally { await before.stop(); }

    const backup = dumpAndRestore();
    const coldStart = performance.now();
    await fixture.restart(restoreUrl.href);
    const restored = await startLrs(fixture.podUrl, scope);
    try {
      const restartMs = ms(coldStart);
      const restoredRead = await readRecovery(restored.base, recovery, expectedIds);
      assert.deepEqual(restoredRead.fingerprints, original.fingerprints, 'Restored records or ETags changed.');
      assert.equal(restoredRead.statementsSha256, original.statementsSha256, 'A restored statement envelope changed.');
      await batch(restored.base, [makeStatement()]);
      stages.recovery = { ...backup, restartMs, coldCompleteReadMs: restoredRead.completeReadMs,
        statementsCompared: expectedIds.length, statementsSha256: restoredRead.statementsSha256,
        attachmentSha256: recovery.sha2, result: 'passed' };
      persist();
    } finally { await restored.stop(); }

    for (const version of ['2.0.0', '1.0.3'] as const) {
      const app = await startLrs(fixture.podUrl, randomUUID());
      try { stages[version] = adl(app.base, version); persist(); }
      finally { await app.stop(); }
    }
  } finally { await fixture.stop(); }
} catch (error) {
  proof.error = error instanceof Error ? error.message : 'Fixture failed';
  throw error;
} finally {
  proof.finishedAt = new Date().toISOString();
  persist();
  console.info('FOXXI_LRS_READINESS ' + JSON.stringify(proof));
}
