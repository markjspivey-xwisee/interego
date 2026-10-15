import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidLrsQueryError, PostgresLrsDatabase, type LrsPgClient, type LrsPgPool, type PostgresLrsStore,
} from '../src/postgres-lrs-store.js';
import { ConflictError, decodeCursor } from '../src/statement-store.js';
import type { QueryFilter, StoredStatement } from '../src/statement-store.js';

const KEY = 'synthetic-postgres-lrs-test-stable-key-0000000000001';
const url = process.env.TEST_PG_URL;
if (process.env.REQUIRE_LRS_PG_TESTS === '1' && !url) throw new Error('TEST_PG_URL is required for durable LRS integration tests');
const noTransport: LrsPgPool = {
  async query() { throw new Error('unexpected SQL request'); },
  async connect() { throw new Error('unexpected SQL connection'); },
  async end() {},
};
function record(index = 1, verb = 'https://example.test/verbs/tested'): StoredStatement {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const stored = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
  return {
    id, stored, voided: false,
    statement: { id, actor: { account: { homePage: 'https://example.test/', name: 'synthetic-learner' } },
      verb: { id: verb }, object: { id: 'https://example.test/courses/fictional' },
      stored, authority: { account: { name: 'synthetic-lrs', homePage: 'https://example.test/' } }, version: '2.0.0' },
  };
}

describe('PostgreSQL LRS authenticated record codec', () => {
  it('requires a stable key and configured server-side database', () => {
    expect(() => new PostgresLrsDatabase({ connectionString: 'postgres://unused', encryptionKey: '' })).toThrow(/stable encryption key/);
    expect(() => new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY })).toThrow(/connection string/);
  });
  it('round-trips actual binary documents without interpreting caller JSON as Buffer', async () => {
    const db = new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY, pool: noTransport });
    const input = { bytes: Buffer.from([0, 255, 17]), json: { type: 'Buffer', data: [1, 2] }, nested: [null, true, 'synthetic-private-document-content'] };
    const sealed = db.seal('tenant-a', 'state', 'state-id', input);
    const opened = db.open<typeof input>('tenant-a', 'state', 'state-id', sealed);
    expect(opened).toEqual(input);
    expect(Buffer.isBuffer(opened.bytes)).toBe(true);
    expect(Buffer.isBuffer(opened.json)).toBe(false);
    expect(sealed.includes(Buffer.from('synthetic-private-document-content'))).toBe(false);
    await db.close();
  });
  it('binds encrypted records to tenant, kind and ID and rejects modified bytes', async () => {
    const db = new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY, pool: noTransport });
    const sealed = db.seal('tenant-a', 'state', 'state-id', { answer: 42 });
    expect(() => db.open('tenant-b', 'state', 'state-id', sealed)).toThrow();
    expect(() => db.open('tenant-a', 'agentProfile', 'state-id', sealed)).toThrow();
    expect(() => db.open('tenant-a', 'state', 'another-id', sealed)).toThrow();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => db.open('tenant-a', 'state', 'state-id', tampered)).toThrow();
    await db.close();
  });
  it('uses fresh nonces and opaque, tenant-separated record indexes', async () => {
    const db = new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY, pool: noTransport });
    expect(db.seal('a', 'state', 'id', 42)).not.toEqual(db.seal('a', 'state', 'id', 42));
    expect(db.tenantKey('a')).not.toBe(db.tenantKey('b'));
    expect(db.recordKey('a', 'state', 'id')).not.toBe(db.recordKey('b', 'state', 'id'));
    expect(db.recordKey('a', 'state', 'id')).not.toBe(db.recordKey('a', 'agentProfile', 'id'));
    expect(db.recordKey('a', 'state', 'id')).toMatch(/^[a-f0-9]{64}$/);
    await db.close();
  });
  it('never falls back to memory when the database refuses a transaction', async () => {
    let verification: unknown;
    const pool: LrsPgPool = {
      async query<R>(sql: string, values?: readonly unknown[]) {
        if (sql.includes('INSERT INTO foxxi_lrs_metadata')) verification = values?.[0];
        return { rows: (sql.startsWith('SELECT verification') ? [{ verification }] : []) as R[], rowCount: 0 };
      },
      async connect() { throw new Error('synthetic database unavailable'); }, async end() {},
    };
    const db = new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY, pool });
    await expect(db.forTenant('a').put(record())).rejects.toThrow('synthetic database unavailable');
    await db.close();
  });
  it('recovers schema initialization after a transient SQL failure', async () => {
    let attempts = 0;
    let verification: unknown;
    const pool: LrsPgPool = {
      async query<R>(sql: string, values?: readonly unknown[]) {
        if (attempts++ === 0) throw new Error('synthetic transient schema failure');
        if (sql.includes('INSERT INTO foxxi_lrs_metadata')) verification = values?.[0];
        return { rows: (sql.startsWith('SELECT verification') ? [{ verification }] : []) as R[], rowCount: 0 };
      }, async connect() { throw new Error('not needed'); }, async end() {},
    };
    const db = new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY, pool });
    await expect(db.ready()).rejects.toThrow('synthetic transient schema failure');
    await expect(db.ready()).resolves.toBeUndefined();
    expect(attempts).toBe(7);
    await db.close();
  });
  it('refuses malformed limits, cursor queries and context tampering before any SQL', async () => {
    let calls = 0;
    const pool: LrsPgPool = { ...noTransport, async query() { calls++; throw new Error('unexpected SQL request'); } };
    const db = new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY, pool });
    const store = db.forTenant('tenant-a');
    for (const limit of [1.5, -1, NaN, Infinity, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.query({ limit } as unknown as QueryFilter)).rejects.toBeInstanceOf(InvalidLrsQueryError);
    }
    const body = { offset: 1, pgRevision: '1', pgScanned: 1,
      pgAfterStored: '2026-01-01T00:00:00.000Z', pgAfterKey: 'a'.repeat(64), q: { ascending: false, limit: 100 } };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const q of [{ limit: 1.5 }, { limit: '2' }, { limit: null }, { ascending: 'false' }, { agent: [] },
      { registration: 'bad' }, { verb: 'relative' }, { activity: {} }, { since: 'not a timestamp' }, { until: 42 }, { unknown: true }]) {
      const cursor = encode({ ...body, q, pgProof: '0'.repeat(64) });
      await expect(store.query({ cursor })).rejects.toThrow('invalid LRS query');
    }
    const signed = { ...body, pgProof: db.continuationSignature('tenant-a', body) };
    await expect(db.forTenant('tenant-b').query({ cursor: encode(signed) })).rejects.toThrow(/signature/);
    await expect(store.query({ cursor: encode(signed), limit: 1 })).rejects.toThrow(/does not match/);
    await expect(store.query({ cursor: encode({ ...signed, q: { ...body.q, limit: 200 } }), limit: 200 })).rejects.toThrow(/signature/);
    expect(calls).toBe(0);
    await db.close();
  });
  it('rejects noncanonical stored timestamps before SQL without changing their envelopes', async () => {
    let calls = 0;
    const pool: LrsPgPool = { ...noTransport, async query() { calls++; throw new Error('unexpected SQL request'); } };
    const db = new PostgresLrsDatabase({ connectionString: '', encryptionKey: KEY, pool });
    for (const stored of ['2026-01-01T00:00:00.000123Z', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00Z', 'invalid']) {
      const input = { ...record(), stored };
      await expect(db.forTenant('a').put(input)).rejects.toThrow(/canonical UTC milliseconds/);
      expect(input.stored).toBe(stored);
    }
    expect(calls).toBe(0);
    await db.close();
  });
});

describe.runIf(!!url)('PostgreSQL LRS real-engine durability', () => {
  let db: PostgresLrsDatabase;
  let store: PostgresLrsStore;
  let tenant: string;
  const opened: PostgresLrsDatabase[] = [];
  const cleanup: Array<{ database: PostgresLrsDatabase; tenant: string }> = [];
  function openDatabase(): PostgresLrsDatabase {
    const value = new PostgresLrsDatabase({ connectionString: url!, encryptionKey: KEY, allowClear: true });
    opened.push(value);
    return value;
  }
  function tenantStore(database: PostgresLrsDatabase, at: string): PostgresLrsStore {
    cleanup.push({ database, tenant: at });
    return database.forTenant(at);
  }
  beforeEach(async () => {
    tenant = `synthetic-test:${randomUUID()}`;
    db = openDatabase();
    store = tenantStore(db, tenant);
    await db.ready();
  });
  afterEach(async () => {
    for (const entry of cleanup.splice(0)) await entry.database.forTenant(entry.tenant).clear();
    for (const value of opened.splice(0)) await value.close();
  });

  it('recovers the exact original LRS envelope through an independent database/pool', async () => {
    const input = record();
    await store.put(input);
    const restarted = openDatabase().forTenant(tenant);
    expect(await restarted.get(input.id)).toEqual(input);
    expect(await restarted.query({})).toEqual({ statements: [input], more: null });
    expect(await restarted.count()).toBe(1);
  });
  it('discovers encrypted tenant names after recovery without registering anonymous reads', async () => {
    const otherTenant = `${tenant}:other`;
    const other = tenantStore(db, otherTenant);
    expect((await db.listTenants()).includes(tenant)).toBe(false);
    expect(await store.get(record().id)).toBeNull();
    expect(await store.markVoided(record().id, record(9).id)).toBe(false);
    await store.deleteResource('state', 'missing');
    expect((await db.listTenants()).includes(tenant)).toBe(false);
    await store.put(record());
    await other.putResource('state', 'document', { answer: 'other synthetic tenant' });
    const restarted = openDatabase();
    const names = await restarted.listTenants();
    expect(names).toContain(tenant);
    expect(names).toContain(otherTenant);
    expect(await restarted.forTenant(otherTenant).get(record().id)).toBeNull();
    const raw = await db.query<{ encrypted_name: Buffer }>('SELECT encrypted_name FROM foxxi_lrs_tenants WHERE tenant_key=$1', [db.tenantKey(tenant)]);
    expect(raw.rows[0]!.encrypted_name.includes(Buffer.from(tenant))).toBe(false);
    await store.deleteResource('state', 'missing');
    expect(await restarted.listTenants()).toContain(tenant);
    await store.clear();
    expect(await restarted.listTenants()).not.toContain(tenant);
    expect(await restarted.listTenants()).toContain(otherTenant);
  });
  it('refuses a changed encryption key instead of treating private history as empty', async () => {
    await store.put(record());
    const wrongKey = new PostgresLrsDatabase({ connectionString: url!, encryptionKey: 'different-synthetic-stable-key-0000000000000000000' });
    try {
      await expect(wrongKey.ready()).rejects.toThrow(/encryption key does not match/);
      await expect(wrongKey.forTenant(tenant).put(record(2))).rejects.toThrow(/encryption key does not match/);
      expect(await store.count()).toBe(1);
    } finally { await wrongKey.close(); }
  });
  it('isolates identical statement UUIDs and document/attachment keys across tenants', async () => {
    const other = tenantStore(db, `${tenant}:other`);
    const a = record();
    const b = { ...record(), statement: { ...record().statement, result: { response: 'different tenant answer' } } };
    await Promise.all([store.put(a), other.put(b)]);
    await Promise.all([store.putResource('state', 'same-id', { answer: 'a' }), other.putResource('state', 'same-id', { answer: 'b' })]);
    expect(await store.get(a.id)).toEqual(a);
    expect(await other.get(a.id)).toEqual(b);
    expect(await store.getResource('state', 'same-id')).toEqual({ answer: 'a' });
    expect(await other.getResource('state', 'same-id')).toEqual({ answer: 'b' });
    expect(await store.listAll()).toEqual([a]);
    expect(await other.listAll()).toEqual([b]);
  });
  it('enforces immutability concurrently and keeps the first LRS-assigned envelope', async () => {
    const first = record();
    await store.put(first);
    const replay = structuredClone(first);
    replay.stored = '2027-01-01T00:00:00.000Z';
    replay.statement.stored = replay.stored;
    replay.statement.authority = { account: { name: 'different authority', homePage: 'https://example.test/' } };
    await store.put(replay);
    expect(await store.get(first.id)).toEqual(first);
    const conflicting = { ...first, statement: { ...first.statement, result: { response: 'mutated' } } };
    await expect(store.put(conflicting)).rejects.toBeInstanceOf(ConflictError);
    const simultaneous = await Promise.allSettled([store.put(record(2)), store.put({ ...record(2), statement: { ...record(2).statement, result: { response: 'other' } } })]);
    expect(simultaneous.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(simultaneous.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await store.count()).toBe(2);
  });
  it('commits guarded voids and preserves their markers after recovery', async () => {
    const input = record();
    await store.put(input);
    expect(await store.markVoided(input.id, record(9).id, () => false)).toBe(false);
    expect((await store.get(input.id))?.voided).toBe(false);
    expect(await store.markVoided(input.id, record(9).id, actual => actual.statement.id === input.id)).toBe(true);
    const restarted = openDatabase().forTenant(tenant);
    expect(await restarted.query({ statementId: input.id })).toEqual({ statements: [], more: null });
    expect((await restarted.query({ voidedStatementId: input.id })).statements[0])
      .toEqual({ ...input, voided: true, voidingStatementId: record(9).id });
  });
  it('atomically commits statements and multipart bytes and recovers documents with their ETags', async () => {
    const bytes = Buffer.from([0, 255, 17, 128]);
    const sha = createHash('sha256').update(bytes).digest('hex');
    await store.putWithAttachments(record(), new Map([[sha, { data: bytes, contentType: 'application/octet-stream' }]]));
    const document = { content: Buffer.from([255, 0, 4]), etag: '"v1"', updated: '2026-01-01T00:00:00Z', contentType: 'application/octet-stream' };
    for (const kind of ['state', 'activityProfile', 'agentProfile']) await store.putResource(kind, 'same-document-id', document);
    const restarted = openDatabase().forTenant(tenant);
    expect(await restarted.getAttachment(sha)).toEqual({ data: bytes, contentType: 'application/octet-stream' });
    for (const kind of ['state', 'activityProfile', 'agentProfile']) {
      expect(await restarted.getResource(kind, 'same-document-id')).toEqual(document);
      expect(await restarted.listResources(kind)).toEqual([['same-document-id', document]]);
    }
  });
  it('rolls back the entire multipart write when an attachment hash is invalid', async () => {
    await expect(store.putWithAttachments(record(), new Map([['0'.repeat(64), { data: Buffer.from('not that hash'), contentType: 'text/plain' }]])))
      .rejects.toThrow(/hash/);
    expect(await store.get(record().id)).toBeNull();
    expect(await store.count()).toBe(0);
    expect(await db.listTenants()).not.toContain(tenant);
  });
  it('serializes missing-document creation and concurrent read/modify/write operations', async () => {
    const operation = () => store.updateResource<{ count: number }, number>('state', 'counter', current => {
      const count = (current?.count ?? 0) + 1;
      return { value: { count }, result: count };
    });
    const counts = await Promise.all(Array.from({ length: 30 }, operation));
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(await openDatabase().forTenant(tenant).getResource('state', 'counter')).toEqual({ count: 30 });
  });
  it('checks a document precondition against the version it atomically changes', async () => {
    await store.putResource('state', 'conditional', { etag: '"original"' });
    const update = (etag: string) => store.updateResource<{ etag: string }, boolean>('state', 'conditional', current => {
      if (current?.etag !== '"original"') return { value: current, result: false };
      return { value: { etag }, result: true };
    });
    expect((await Promise.all([update('"a"'), update('"b"')])).sort()).toEqual([false, true]);
    await store.deleteResource('state', 'conditional');
    expect(await openDatabase().forTenant(tenant).getResource('state', 'conditional')).toBeNull();
  });
  it('keeps stable filtered pages across writes, voids, and independent pools', async () => {
    for (let index = 1; index <= 8; index++) await store.put(record(index, index % 2 ? 'https://example.test/odd' : 'https://example.test/even'));
    const first = await store.query({ verb: 'https://example.test/odd', ascending: true, limit: 2 });
    expect(first.statements.map(item => item.id)).toEqual([record(1).id, record(3).id]);
    expect(first.more).toBeTruthy();
    await store.markVoided(record(1).id, record(99).id);
    await store.put(record(9, 'https://example.test/odd'));
    const restarted = openDatabase().forTenant(tenant);
    const cursor = decodeCursor(first.more!);
    const second = await restarted.query({ ...cursor?.q, cursor: first.more! });
    expect(second.statements.map(item => item.id)).toEqual([record(5).id, record(7).id]);
    expect(second.more).toBeNull();
    await expect(store.query({ cursor: Buffer.from(JSON.stringify({ offset: -1 })).toString('base64url') })).rejects.toThrow(/continuation/);
  });
  it('caps query results at 500, rejects fractional limits and finds matches beyond one SQL page', async () => {
    for (let offset = 0; offset < 520; offset += 16) {
      await Promise.all(Array.from({ length: Math.min(16, 520 - offset) }, (_, position) => {
        const index = offset + position;
        return store.put(record(index + 1, index === 519 ? 'https://example.test/needle' : 'https://example.test/haystack'));
      }));
    }
    await expect(store.query({ limit: 1.5 })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    const result = await store.query({ verb: 'https://example.test/needle', ascending: true, limit: 1 });
    expect(result.statements.map(item => item.id)).toEqual([record(520).id]);
    expect(result.more).toBeNull();
    const capped = await store.query({ limit: 0 });
    expect(capped.statements).toHaveLength(500);
    expect(capped.more).toBeTruthy();
    expect((await store.query({ limit: 9000 })).statements).toHaveLength(500);
    const cursor = decodeCursor(capped.more!);
    const remaining = await openDatabase().forTenant(tenant).query({ ...cursor?.q, cursor: capped.more! });
    expect(remaining.statements).toHaveLength(20);
    expect(remaining.more).toBeNull();
    expect(new Set([...capped.statements, ...remaining.statements].map(item => item.id)).size).toBe(520);
  });
  it('orders per-tenant insert commits before exposing a continuation watermark', async () => {
    for (let index = 1; index <= 3; index++) await store.put(record(index));
    const moduleName = 'pg';
    const pg = await import(moduleName) as { Pool: new (options: { connectionString: string }) => LrsPgPool };
    const firstPool = new pg.Pool({ connectionString: url! });
    const secondPool = new pg.Pool({ connectionString: url! });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
    let sawCommit!: () => void;
    const commitReached = new Promise<void>(resolve => { sawCommit = resolve; });
    let sawSecondLock!: () => void;
    const secondLockReached = new Promise<void>(resolve => { sawSecondLock = resolve; });
    let secondPid: number | undefined;
    const firstWrapper: LrsPgPool = {
      query: (sql, values) => firstPool.query(sql, values), end: () => firstPool.end(),
      async connect() {
        const client = await firstPool.connect();
        return {
          async query<R = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
            if (sql === 'COMMIT') { sawCommit(); await commitGate; }
            return client.query<R>(sql, values);
          }, release: () => client.release(),
        };
      },
    };
    const secondWrapper: LrsPgPool = {
      query: (sql, values) => secondPool.query(sql, values), end: () => secondPool.end(),
      async connect() {
        const client = await secondPool.connect();
        secondPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        return {
          query<R = Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
            const pending = client.query<R>(sql, values);
            if (sql.includes('pg_advisory_xact_lock')) sawSecondLock();
            return pending;
          }, release: () => client.release(),
        };
      },
    };
    const firstDb = new PostgresLrsDatabase({ connectionString: url!, encryptionKey: KEY, pool: firstWrapper });
    const secondDb = new PostgresLrsDatabase({ connectionString: url!, encryptionKey: KEY, pool: secondWrapper });
    let pendingFirst: Promise<void> | undefined;
    let pendingSecond: Promise<void> | undefined;
    try {
      // Schema setup needs table locks. Finish both independent pools' setup
      // before intentionally holding a write transaction open; otherwise the
      // second pool waits in DDL instead of reaching the lock under test.
      await firstDb.ready();
      await secondDb.ready();
      pendingFirst = firstDb.forTenant(tenant).put(record(4));
      await Promise.race([commitReached, pendingFirst.then(() => { throw new Error('first write completed without reaching its commit barrier'); })]);
      let secondSettled = false;
      pendingSecond = secondDb.forTenant(tenant).put(record(5)).then(() => { secondSettled = true; });
      await Promise.race([secondLockReached, pendingSecond.then(() => { throw new Error('second write completed without reaching its lock barrier'); })]);
      // Verify the PostgreSQL server actually reports an ungranted advisory
      // lock for the second connection, rather than inferring it from timing.
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const locks = await db.query<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted
        ) AS waiting`, [secondPid]);
        waiting = locks.rows[0]!.waiting;
        if (waiting) break;
        await db.query('SELECT pg_sleep(0.02)', []);
      }
      expect(waiting).toBe(true);
      expect(secondSettled).toBe(false);
      const page = await store.query({ ascending: true, limit: 1 });
      expect(page.statements.map(item => item.id)).toEqual([record(1).id]);
      releaseCommit();
      await Promise.all([pendingFirst, pendingSecond]);
      const cursor = decodeCursor(page.more!);
      const remainder = await store.query({ ...cursor?.q, cursor: page.more! });
      expect(remainder.statements.map(item => item.id)).toEqual([record(2).id]);
      const finalCursor = decodeCursor(remainder.more!);
      const final = await store.query({ ...finalCursor?.q, cursor: remainder.more! });
      expect(final.statements.map(item => item.id)).toEqual([record(3).id]);
      expect(final.more).toBeNull();
    } finally {
      releaseCommit();
      await Promise.allSettled([pendingFirst, pendingSecond]);
      await Promise.all([firstDb.close(), secondDb.close()]);
    }
  });
  it('contains no plaintext learner payload or document key in SQL and rejects ciphertext corruption', async () => {
    await store.put(record());
    await store.putResource('state', 'private-document-key', { answer: 'private synthetic answer' });
    const rows = await db.query<{ kind: string; record_id: string; payload: Buffer }>(
      'SELECT kind,record_id,payload FROM foxxi_lrs_records WHERE tenant_key=$1', [db.tenantKey(tenant)]);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.record_id).toMatch(/^[a-f0-9]{64}$/);
      expect(row.payload.includes(Buffer.from('synthetic-learner'))).toBe(false);
      expect(row.payload.includes(Buffer.from('private-document-key'))).toBe(false);
      expect(row.payload.includes(Buffer.from('private synthetic answer'))).toBe(false);
    }
    const row = rows.rows.find(item => item.kind === 'statement')!;
    const damaged = Buffer.from(row.payload);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    await db.query('UPDATE foxxi_lrs_records SET payload=$1 WHERE tenant_key=$2 AND kind=$3 AND record_id=$4',
      [damaged, db.tenantKey(tenant), row.kind, row.record_id]);
    await expect(store.get(record().id)).rejects.toThrow();
  });
  it('rejects ciphertext moved to another tenant or kind', async () => {
    const otherTenant = `${tenant}:other`;
    const other = tenantStore(db, otherTenant);
    await store.putResource('state', 'same', { private: 'a' });
    await other.putResource('state', 'same', { private: 'b' });
    const row = (await db.query<{ payload: Buffer }>('SELECT payload FROM foxxi_lrs_records WHERE tenant_key=$1 AND kind=$2 AND record_id=$3',
      [db.tenantKey(tenant), 'state', db.recordKey(tenant, 'state', 'same')])).rows[0]!;
    await db.query('UPDATE foxxi_lrs_records SET payload=$1 WHERE tenant_key=$2 AND kind=$3 AND record_id=$4',
      [row.payload, db.tenantKey(otherTenant), 'state', db.recordKey(otherTenant, 'state', 'same')]);
    await expect(other.getResource('state', 'same')).rejects.toThrow();
  });
  it('refuses SQL metadata that would expose an encrypted voided record as active', async () => {
    await store.put(record());
    await store.markVoided(record().id, record(9).id);
    await db.query('UPDATE foxxi_lrs_records SET voided=false WHERE tenant_key=$1 AND kind=$2 AND record_id=$3',
      [db.tenantKey(tenant), 'statement', db.recordKey(tenant, 'statement', record().id)]);
    await expect(store.query({})).rejects.toThrow(/metadata binding/);
  });
  it('refuses a success receipt when COMMIT is not sent and leaves no speculative readable record', async () => {
    const moduleName = 'pg';
    const pg = await import(moduleName) as { Pool: new (options: { connectionString: string }) => LrsPgPool };
    const actual = new pg.Pool({ connectionString: url! });
    const wrapper: LrsPgPool = {
      query: (sql, values) => actual.query(sql, values), end: () => actual.end(),
      async connect() {
        const client = await actual.connect();
        const wrapped: LrsPgClient = {
          async query(sql, values) {
            if (sql === 'COMMIT') throw new Error('synthetic commit refusal');
            return client.query(sql, values);
          }, release: () => client.release(),
        };
        return wrapped;
      },
    };
    const failing = new PostgresLrsDatabase({ connectionString: url!, encryptionKey: KEY, pool: wrapper });
    try {
      await expect(failing.forTenant(tenant).put(record())).rejects.toThrow('synthetic commit refusal');
      expect(await store.get(record().id)).toBeNull();
    } finally { await failing.close(); }
  });
  it('disables destructive clears unless explicitly enabled for a test database', async () => {
    const guarded = new PostgresLrsDatabase({ connectionString: url!, encryptionKey: KEY });
    try { await expect(guarded.forTenant(tenant).clear()).rejects.toThrow(/clear is disabled/); }
    finally { await guarded.close(); }
  });
});
