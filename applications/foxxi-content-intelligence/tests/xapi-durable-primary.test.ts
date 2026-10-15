import { afterAll, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mintSessionToken } from '../src/auth.js';
import { PostgresLrsDatabase } from '../src/postgres-lrs-store.js';

const connectionString = process.env.TEST_PG_URL;
if (!connectionString && process.env.REQUIRE_LRS_PG_TESTS === '1') throw new Error('TEST_PG_URL is required for durable HTTP primary tests');
const key = 'synthetic-postgres-lrs-test-stable-key-0000000000001';
const alice = `lens:durable-http-alice-${randomUUID()}`;
const bob = `lens:durable-http-bob-${randomUUID()}`;
interface Message { event?: string; port?: number; id?: number; kind?: string; }
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
async function start(): Promise<{ child: ChildProcess; base: string }> {
  const child = fork(fileURLToPath(new URL('./support/durable-lrs-http-child.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], silent: true,
    env: { ...process.env, NODE_ENV: 'test', FOXXI_LRS_BACKEND: 'postgres', FOXXI_LRS_POSTGRES_URL: connectionString,
      FOXXI_LRS_ENCRYPTION_KEY: key, LRS_TEST_ALICE: alice, LRS_TEST_BOB: bob },
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
  if (connectionString) {
    const db = new PostgresLrsDatabase({ connectionString, encryptionKey: key, allowClear: true });
    try { await db.forTenant(alice).clear(); await db.forTenant(bob).clear(); } finally { await db.close(); }
  }
});

describe.skipIf(!connectionString)('the HTTP LRS acknowledges its durable primary', () => {
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
    // Concurrent JSON POSTs merge under a database lock, preserving both accepted updates.
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
    app = await start();
    expect((await fetch(`${app.base}/xapi/statements?statementId=${stmt.id}`, { headers: headers() })).status).toBe(404);
    expect((await fetch(`${app.base}/xapi/statements?voidedStatementId=${stmt.id}`, { headers: headers() })).status).toBe(200);
    expect((await fetch(`${app.base}${state}`, { headers: headers() })).status).toBe(404);
    await kill(app.child);
  }, 60_000);

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
});
