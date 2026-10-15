import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mintSessionToken } from '../src/auth.js';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { NATIVE_CSS_FIXTURE_CAPABILITY, startNativeCssFixture, type NativeCssFixture } from './support/native-css-fixture.js';

const fixtureInputs = Boolean(process.env.TEST_NATIVE_CSS_ROOT && process.env.TEST_NATIVE_PG_URL);
const optionalPod = process.env.TEST_NATIVE_POD_URL;
if (process.env.REQUIRE_LRS_NATIVE_TESTS === '1' && !fixtureInputs) throw new Error('Required native HTTP tests need TEST_NATIVE_CSS_ROOT and TEST_NATIVE_PG_URL for actual CSS/engine recovery');
const nativeEnabled = fixtureInputs || Boolean(optionalPod);
const owner = 'did:web:synthetic-native-lrs.test:service' as IRI;
const privateKey = '0x' + '11'.repeat(32), ownerPublicKey = deriveEncryptionKeyPair(privateKey, owner).publicKey;
const scopeId = randomUUID();
let fixture: NativeCssFixture | undefined, pod = optionalPod;
const originalPod = process.env.TEST_NATIVE_POD_URL;
beforeAll(async () => {
  fixture = fixtureInputs ? await startNativeCssFixture() : undefined;
  if (fixture) { pod = fixture.podUrl; process.env.TEST_NATIVE_POD_URL = pod; }
}, 60000);
const alice = `lens:durable-http-alice-${randomUUID()}`;
const bob = `lens:durable-http-bob-${randomUUID()}`;
interface Message { event?: string; port?: number; id?: number; kind?: string; callbacks?: Array<{ id: string; statement: Record<string, unknown> }>; voidCallbacks?: Array<{ target: string; voidingId: string }>; forwardChecks?: number; }
let sequence = 0;
const children = new Set<ChildProcess>();
function message(child: ChildProcess, predicate: (value: Message) => boolean): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('durable HTTP child did not respond')); }, 15_000);
    const onMessage = (value: Message): void => { if (predicate(value)) { cleanup(); resolve(value); } };
    const onExit = (): void => { cleanup(); reject(new Error('durable HTTP child exited before acknowledgement')); };
    const cleanup = (): void => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); };
    child.on('message', onMessage); child.once('exit', onExit);
  });
}
async function start(backend: 'interego' | 'memory' = 'interego'): Promise<{ child: ChildProcess; base: string }> {
  const child = fork(fileURLToPath(new URL('./support/durable-lrs-http-child.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, NODE_ENV: 'test', FOXXI_LRS_BACKEND: backend,
      FOXXI_LRS_NATIVE_POD_URL: pod, FOXXI_LRS_NATIVE_OWNER: owner, FOXXI_LRS_NATIVE_PRIVATE_KEY: privateKey,
      FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: ownerPublicKey,
      FOXXI_LRS_NATIVE_CAPABILITY: fixture ? NATIVE_CSS_FIXTURE_CAPABILITY : process.env.TEST_NATIVE_CAPABILITY,
      FOXXI_LRS_NATIVE_HEAD_URL: pod ? new URL('foxxi/lrs/native/http-' + scopeId + '/head', pod).href : undefined,
      FOXXI_LRS_NATIVE_ARTIFACT_CONTAINER: pod ? new URL('foxxi/lrs/native/http-' + scopeId + '/artifacts/', pod).href : undefined,
      LRS_TEST_ALICE: alice, LRS_TEST_BOB: bob },
  });
  children.add(child);
  // Drain output without copying statements, keys or DB connection details into test reports.
  child.stdout?.resume(); child.stderr?.resume();
  const ready = await message(child, value => value.event === 'ready');
  return { child, base: `http://127.0.0.1:${ready.port}` };
}
async function command(child: ChildProcess, command: string): Promise<void> {
  const id = ++sequence;
  const reply = message(child, value => value.event === 'configured' && value.id === id);
  child.send({ command, id });
  await reply;
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; children.delete(child);
}
const headers = (user = 'alice') => ({ Authorization: `Bearer ${user}`, 'X-Experience-API-Version': '2.0.0', 'Content-Type': 'application/json' });
const statement = (id = randomUUID()) => ({ id, actor: { mbox: 'mailto:alice@example.test' }, verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: 'https://example.test/course' } });
const address = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`;
const state = address('/xapi/activities/state', { activityId: 'https://example.test/course', agent: JSON.stringify({ mbox: 'mailto:alice@example.test' }), stateId: 'progress' });
const activityProfile = address('/xapi/activities/profile', { activityId: 'https://example.test/course', profileId: 'settings' });
const agentProfile = address('/xapi/agents/profile', { agent: JSON.stringify({ mbox: 'mailto:alice@example.test' }), profileId: 'settings' });

afterAll(async () => {
  for (const child of children) await kill(child);
  await fixture?.stop();
  if (originalPod === undefined) delete process.env.TEST_NATIVE_POD_URL; else process.env.TEST_NATIVE_POD_URL = originalPod;
});

describe('the real subprocess forwards rejected xAPI promises to its error handler', () => {
  it('returns sanitized 503 for POST and PUT write failures and keeps serving requests', async () => {
    const app = await start('memory');
    try {
      for (const method of ['POST', 'PUT']) {
        await command(app.child, 'fail-statement');
        const id = randomUUID();
        const target = `${app.base}/xapi/statements${method === 'PUT' ? `?statementId=${id}` : ''}`;
        const response = await fetch(target, { method, headers: headers(), body: JSON.stringify(statement(id)) });
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'LRS storage operation unavailable' });
        expect((await fetch(`${app.base}/xapi/statements?statementId=${id}`, { headers: headers() })).status).toBe(404);
      }
      const healthy = statement();
      const response = await fetch(`${app.base}/xapi/statements`, { method: 'POST', headers: headers(), body: JSON.stringify(healthy) });
      expect(response.status).toBe(200); expect(await response.json()).toEqual([healthy.id]);
    } finally { await kill(app.child); }
  });
});

describe.skipIf(!nativeEnabled)('the HTTP LRS acknowledges its native Interego primary', () => {
  it('keeps a multipart statement, binary State and both profiles through process death, with tenant isolation and ETags', async () => {
    let app = await start();
    const stmt = statement();
    const bytes = Buffer.from([0, 1, 2, 255, 13, 10, 200]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const attached = { ...stmt, attachments: [{ usageType: 'https://example.test/evidence', display: { en: 'Evidence' }, contentType: 'application/octet-stream', length: bytes.length, sha2: sha }] };
    const boundary = 'durable-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(attached)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\nX-Experience-API-Hash: ${sha}\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const posted = await fetch(`${app.base}/xapi/statements`, { method: 'POST', headers: { ...headers(), 'Content-Type': `multipart/mixed; boundary=${boundary}` }, body });
    expect(posted.status).toBe(200); expect(await posted.json()).toEqual([stmt.id]);
    const stateResponse = await fetch(`${app.base}${state}`, { method: 'PUT', headers: { ...headers(), 'Content-Type': 'application/octet-stream' }, body: bytes });
    expect(stateResponse.status).toBe(204);
    const etag = stateResponse.headers.get('etag')!;
    for (const path of [activityProfile, agentProfile]) expect((await fetch(`${app.base}${path}`, { method: 'PUT', headers: headers(), body: '{"saved":true}' })).status).toBe(204);
    await kill(app.child); // No graceful snapshot or flush can rescue a volatile acknowledgement.
    if (fixture) await fixture.restart();
    app = await start();
    // Enumerate before any tenant read: a restarted process has no populated TenantPartition.
    const adminToken = await mintSessionToken({ userId: 'durable-admin', webId: 'https://pod.test/durable-admin/profile/card#me', seed: 'durable-http-admin-synthetic-seed' });
    const directory = await fetch(`${app.base}/xapi/admin/tenants`, { headers: { Authorization: `Bearer ${adminToken}` } });
    expect(directory.status).toBe(200);
    expect((await directory.json() as { tenants: Array<{ tenant: string; count: number }> }).tenants).toContainEqual({ tenant: alice, count: 1 });
    const read = await fetch(`${app.base}/xapi/statements?statementId=${stmt.id}&attachments=true`, { headers: headers() });
    expect(read.status).toBe(200);
    const returned = Buffer.from(await read.arrayBuffer());
    expect(returned.includes(Buffer.from(stmt.id))).toBe(true); expect(returned.includes(bytes)).toBe(true);
    expect((await fetch(`${app.base}/xapi/statements?statementId=${stmt.id}`, { headers: headers('bob') })).status).toBe(404);
    const doc = await fetch(`${app.base}${state}`, { headers: headers() });
    expect(doc.status).toBe(200); expect(doc.headers.get('etag')).toBe(etag); expect(Buffer.from(await doc.arrayBuffer())).toEqual(bytes);
    expect((await fetch(`${app.base}${state}`, { headers: { ...headers(), 'If-None-Match': etag } })).status).toBe(304);
    expect((await fetch(`${app.base}${state}`, { headers: headers('bob') })).status).toBe(404);
    for (const path of [activityProfile, agentProfile]) expect(await (await fetch(`${app.base}${path}`, { headers: headers() })).json()).toEqual({ saved: true });
    // Concurrent JSON POSTs merge under native head CAS, preserving both accepted updates.
    const merges = await Promise.all(['left', 'right'].map(field => fetch(`${app.base}${activityProfile}`, { method: 'POST', headers: headers(), body: JSON.stringify({ [field]: true }) })));
    expect(merges.map(response => response.status)).toEqual([204, 204]);
    expect(await (await fetch(`${app.base}${activityProfile}`, { headers: headers() })).json()).toEqual({ saved: true, left: true, right: true });
    const head = await fetch(`${app.base}${state}`, { method: 'HEAD', headers: headers() });
    expect(head.status).toBe(200); expect(head.headers.get('etag')).toBe(etag); expect(await head.text()).toBe('');
    // A stale writer cannot overwrite a committed document after restart.
    expect((await fetch(`${app.base}${state}`, { method: 'PUT', headers: { ...headers(), 'If-Match': '"stale"' }, body: '{}' })).status).toBe(412);
    expect((await fetch(`${app.base}${state}`, { method: 'DELETE', headers: { ...headers(), 'If-Match': etag } })).status).toBe(204);
    const voiding = { ...statement(), verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: stmt.id } };
    expect((await fetch(`${app.base}/xapi/statements`, { method: 'POST', headers: headers(), body: JSON.stringify(voiding) })).status).toBe(200);
    await kill(app.child);
    if (fixture) await fixture.restart();
    app = await start();
    expect((await fetch(`${app.base}/xapi/statements?statementId=${stmt.id}`, { headers: headers() })).status).toBe(404);
    expect((await fetch(`${app.base}/xapi/statements?voidedStatementId=${stmt.id}`, { headers: headers() })).status).toBe(200);
    expect((await fetch(`${app.base}${state}`, { headers: headers() })).status).toBe(404);
    await kill(app.child);
  }, 120_000);

  it('does not send an ID or document success while the primary write is pending, and refuses write failure', async () => {
    const app = await start();
    for (const kind of ['statement', 'resource'] as const) {
      await command(app.child, kind);
      const entered = message(app.child, value => value.event === 'entered' && value.kind === kind);
      const stmt = statement();
      let acknowledged = false;
      const response = kind === 'statement'
        ? fetch(`${app.base}/xapi/statements`, { method: 'POST', headers: headers(), body: JSON.stringify(stmt) })
        : fetch(`${app.base}${activityProfile.replace('settings', randomUUID())}`, { method: 'PUT', headers: headers(), body: '{}' });
      const pending = response.then(value => { acknowledged = true; return value; });
      await entered;
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(acknowledged).toBe(false);
      await command(app.child, 'release');
      expect((await pending).status).toBe(kind === 'statement' ? 200 : 204);
      await command(app.child, `fail-${kind}`);
      const failedId = randomUUID();
      const failure = kind === 'statement'
        ? await fetch(`${app.base}/xapi/statements?statementId=${failedId}`, { method: 'PUT', headers: headers(), body: JSON.stringify(statement(failedId)) })
        : await fetch(`${app.base}${activityProfile.replace('settings', failedId)}`, { method: 'PUT', headers: headers(), body: '{}' });
      if (kind === 'statement') {
        expect(failure.status).toBe(503); expect(await failure.json()).toEqual({ error: 'LRS storage operation unavailable' });
        expect((await fetch(`${app.base}/xapi/statements?statementId=${failedId}`, { headers: headers() })).status).toBe(404);
      } else {
        expect(failure.status).toBe(503); expect(await failure.json()).toEqual({ error: 'LRS storage operation unavailable' });
        expect((await fetch(`${app.base}${activityProfile.replace('settings', failedId)}`, { headers: headers() })).status).toBe(404);
      }
    }
    await kill(app.child);
  }, 60_000);
  it('returns sanitized 503 when an authenticated cmi5 launch cannot commit its State, then remains usable', async () => {
    const app = await start();
    try {
      const adminToken = await mintSessionToken({ userId: 'durable-admin', webId: 'https://pod.test/durable-admin/profile/card#me', seed: 'durable-http-admin-synthetic-seed' });
      const query = new URLSearchParams({ au_id: 'https://durable.test/au/failure', au_url: 'https://durable.test/content/failure', learner: 'did:web:learner.test', tenant_pod_url: alice });
      await command(app.child, 'fail-resource');
      const failure = await fetch(`${app.base}/cmi5/launch?${query}`, { headers: { Authorization: `Bearer ${adminToken}` } });
      expect(failure.status).toBe(503); expect(await failure.json()).toEqual({ error: 'LRS launch data storage is unavailable' });
      const retry = await fetch(`${app.base}/cmi5/launch?${query}`, { headers: { Authorization: `Bearer ${adminToken}` } });
      expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ launchDataStaged: true });
    } finally { await kill(app.child); }
  });

  it('resolves independent HTTP writers through native CAS and rejects a conflicting batch without a partial keep', async () => {
    const left = await start(), right = await start();
    try {
      const shared = statement(), other = { ...shared, object: { id: 'https://example.test/other-course' } };
      const answers = await Promise.all([
        fetch(left.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(shared) }),
        fetch(right.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(other) }),
      ]);
      expect(answers.map(response => response.status).sort()).toEqual([200, 409]);
      const held = await (await fetch(left.base + '/xapi/statements?statementId=' + shared.id, { headers: headers() })).json() as { object: { id: string } };
      const newRecord = statement(), conflict = { ...shared, object: { id: held.object.id + '/conflict' } };
      const rejected = await fetch(right.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify([newRecord, conflict]) });
      expect(rejected.status).toBe(409);
      expect((await fetch(left.base + '/xapi/statements?statementId=' + newRecord.id, { headers: headers() })).status).toBe(404);
    } finally { await kill(left.child); await kill(right.child); }
  }, 120000);

  it('pages matching voiders at one immutable head and does not expose another launch registration', async () => {
    const app = await start();
    const paged = async (first: string, auth = headers()) => {
      const ids: string[] = []; let next = first;
      for (let page = 0; next && page < 20; page++) {
        const response = await fetch(app.base + next, { headers: auth });
        expect(response.status).toBe(200);
        const result = await response.json() as { statements: Array<{ id: string }>; more: string };
        expect(result.statements.length).toBeLessThanOrEqual(1);
        ids.push(...result.statements.map(row => row.id)); next = result.more;
      }
      expect(next).toBe(''); return ids;
    };
    try {
      const verb = 'https://example.test/verbs/paging-' + randomUUID();
      const targets = Array.from({ length: 3 }, () => ({ ...statement(), verb: { id: verb } }));
      const voiders = targets.map(target => ({ ...statement(), verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: target.id } }));
      for (const batch of [targets, voiders]) expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(batch) })).status).toBe(200);
      const ids = await paged('/xapi/statements?' + new URLSearchParams({ verb, limit: '1' }));
      expect(ids.sort()).toEqual(voiders.map(row => row.id).sort()); expect(new Set(ids).size).toBe(3);
      const regA = randomUUID(), regB = randomUUID(), privateVerb = 'https://example.test/verbs/private-' + randomUUID();
      const target = { ...statement(), verb: { id: privateVerb }, context: { registration: regA } };
      const other = { ...statement(), verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: target.id }, context: { registration: regB } };
      for (const row of [target, other]) expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(row) })).status).toBe(200);
      expect(await paged('/xapi/statements?' + new URLSearchParams({ verb: privateVerb, registration: regA, limit: '1' }))).toEqual([other.id]);
      expect(await paged('/xapi/statements?' + new URLSearchParams({ verb: privateVerb, limit: '1' }), headers('alice-reg:' + regA))).toEqual([]);
      expect((await fetch(app.base + '/xapi/statements?statementId=' + other.id, { headers: headers('alice-reg:' + regA) })).status).toBe(404);
    } finally { await kill(app.child); }
  }, 120000);
  it('never injects a later voider into a continuation captured before the void', async () => {
    const app = await start();
    try {
      const verb = 'https://example.test/verbs/head-bound-' + randomUUID();
      const targets = Array.from({ length: 3 }, () => ({ ...statement(), verb: { id: verb } }));
      expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(targets) })).status).toBe(200);
      const first = await (await fetch(app.base + '/xapi/statements?' + new URLSearchParams({ verb, limit: '2' }), { headers: headers() })).json() as { statements: Array<{ id: string }>; more: string };
      expect(first.statements).toHaveLength(2); expect(first.more).toBeTruthy();
      const remainder = targets.find(row => !first.statements.some(held => held.id === row.id))!;
      const late = { ...statement(), verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: remainder.id } };
      expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(late) })).status).toBe(200);
      const next = await (await fetch(app.base + first.more, { headers: headers() })).json() as { statements: Array<{ id: string }>; more: string };
      expect(next.statements.map(row => row.id)).toEqual([remainder.id]);
      expect(next.more).toBe('');
    } finally { await kill(app.child); }
  }, 120000);
  it('keeps delimiter-containing document addresses distinct and scopes list/delete by full tuples', async () => {
    const app = await start();
    try {
      const base = 'https://example.test/tuple/' + randomUUID();
      const left = address('/xapi/activities/profile', { activityId: base + '/a::b', profileId: 'c' });
      const right = address('/xapi/activities/profile', { activityId: base + '/a', profileId: 'b::c' });
      for (const [path, value] of [[left, 'left'], [right, 'right']] as const) {
        expect((await fetch(app.base + path, { method: 'PUT', headers: headers(), body: JSON.stringify({ value }) })).status).toBe(204);
        expect(await (await fetch(app.base + path, { headers: headers() })).json()).toEqual({ value });
      }
      const list = (activityId: string) => address('/xapi/activities/profile', { activityId });
      expect(await (await fetch(app.base + list(base + '/a::b'), { headers: headers() })).json()).toEqual(['c']);
      expect(await (await fetch(app.base + list(base + '/a'), { headers: headers() })).json()).toEqual(['b::c']);
      expect((await fetch(app.base + left, { method: 'DELETE', headers: headers() })).status).toBe(204);
      expect(await (await fetch(app.base + right, { headers: headers() })).json()).toEqual({ value: 'right' });
      const agent = JSON.stringify({ mbox: 'mailto:tuple@example.test' }), stateId = 'with::delimiters', registration = randomUUID();
      const stateAddress = address('/xapi/activities/state', { activityId: base, agent, stateId, registration });
      expect((await fetch(app.base + stateAddress, { method: 'PUT', headers: headers(), body: '{"saved":true}' })).status).toBe(204);
      const scope = address('/xapi/activities/state', { activityId: base, agent, registration });
      expect(await (await fetch(app.base + scope, { headers: headers() })).json()).toEqual([stateId]);
      expect((await fetch(app.base + scope, { method: 'DELETE', headers: headers() })).status).toBe(204);
      expect((await fetch(app.base + stateAddress, { headers: headers() })).status).toBe(404);
    } finally { await kill(app.child); }
  }, 120000);

  it('does not repeat learning callbacks or forwarding on exact UUID retries and always keeps the first envelope', async () => {
    let app = await start();
    const inspect = async () => {
      const id = ++sequence;
      const result = message(app.child, value => value.event === 'callbacks' && value.id === id);
      app.child.send({ command: 'callbacks', id }); return result;
    };
    try {
      const target = { ...statement(), timestamp: '2026-10-15T10:00:00.000Z' };
      expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(target) })).status).toBe(200);
      const first = await (await fetch(app.base + '/xapi/statements?statementId=' + target.id, { headers: headers() })).json() as Record<string, unknown>;
      const retry = { ...target, stored: '2099-01-01T00:00:00.000Z', authority: { objectType: 'Agent', account: { homePage: 'https://example.test', name: 'retry-authority-must-not-be-projected' } } };
      expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(retry) })).status).toBe(200);
      expect((await fetch(app.base + '/xapi/statements?statementId=' + target.id, { method: 'PUT', headers: headers(), body: JSON.stringify(retry) })).status).toBe(204);
      const voiding = { ...statement(), timestamp: '2026-10-15T10:00:01.000Z', verb: { id: 'http://adlnet.gov/expapi/verbs/voided' }, object: { objectType: 'StatementRef', id: target.id } };
      for (let attempt = 0; attempt < 2; attempt++) expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(voiding) })).status).toBe(200);
      const effects = await inspect();
      expect(effects.callbacks).toHaveLength(2);
      expect(effects.callbacks?.find(row => row.id === target.id)?.statement).toEqual(first);
      expect(effects.voidCallbacks).toEqual([{ target: target.id, voidingId: voiding.id }]);
      expect(effects.forwardChecks).toBe(2);
      expect(await (await fetch(app.base + '/xapi/statements?voidedStatementId=' + target.id, { headers: headers() })).json()).toEqual(first);
      await kill(app.child); app = await start();
      expect((await fetch(app.base + '/xapi/statements', { method: 'POST', headers: headers(), body: JSON.stringify(retry) })).status).toBe(200);
      const afterRestart = await inspect();
      expect(afterRestart.callbacks).toEqual([]); expect(afterRestart.voidCallbacks).toEqual([]); expect(afterRestart.forwardChecks).toBe(0);
    } finally { await kill(app.child); }
  }, 120000);

});
