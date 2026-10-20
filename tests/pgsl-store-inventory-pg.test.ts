import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-ignore optional driver already used by the existing isolated PG16 CI fixture.
import { Client } from 'pg';
import { collectInventory, SQL, type Query } from '../tools/pgsl-store-inventory.js';
import { cpKey, subspaceRange, SUBSPACE_PAYLOAD_OFFSET } from '../packages/pgsl-store/src/keyspace.js';

const url = process.env['TEST_NATIVE_PG_URL'];
if (process.env['REQUIRE_INVENTORY_PG_TESTS'] === '1' && !url) throw new Error('isolated inventory PostgreSQL fixture is required');
if (url) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    || parsed.pathname !== '/native_interego_test' || parsed.search || parsed.hash)
    throw new Error('inventory test accepts only the isolated loopback fixture');
}
const suite = url ? describe : describe.skip;
const range = subspaceRange('C');
const values = (limit: number) => [Buffer.from(range.begin), Buffer.from(range.end), limit, SUBSPACE_PAYLOAD_OFFSET + 1];
type Fixture = { k: Buffer; v: Buffer };
const fixture: Fixture[] = [];
function record(path: string, value: unknown) {
  const entry = { k: Buffer.from(cpKey('ldp private-fixture-pod', `https://private-fixture.example/${path}`)),
    v: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) };
  fixture.push(entry); return entry;
}
record('lrs/native/artifacts/artifact-private', { size: 123, meta: { secret: 'private metadata' } });
record('lrs/native/artifacts/commit-private', { size: 456 });
record('lrs/native/head', { size: 789 });
record('gaming/head', { size: 1.25 });
record('activity/own-subject/head', { size: -1 });
record('foxxi-lattice/shared-lattice.holon.json', { size: '123' });
record('foxxi-lattice/holon-private', { size: 9007199254740992 });
record('context-graphs/private', { size: 44 });
record('agents', { size: 55 });
record('other-invalid-json', '{"size":');
record('other-scalar-json', '45');
fixture.push({ k: Buffer.from(cpKey('not-ldp private-fixture', 'private-record')), v: Buffer.from([0xff]) });
fixture.push({ k: Buffer.concat([Buffer.from(range.begin), Buffer.from('malformed-no-separator')]), v: Buffer.from([0xff]) });

suite('inventory SQL on the isolated PostgreSQL16 fixture', () => {
  let db: InstanceType<typeof Client>;
  let ownsTable = false;
  beforeAll(async () => {
    db = new Client({ connectionString: url });
    await db.connect();
    expect(Number((await db.query("SHOW server_version_num")).rows[0].server_version_num)).toBeGreaterThanOrEqual(160000);
    // Fail rather than touching a fixture table another suite owns. This step runs before native store tests.
    expect((await db.query("SELECT to_regclass('public.pgsl_kv') AS relation")).rows[0].relation).toBeNull();
    await db.query('CREATE TABLE public.pgsl_kv (k bytea PRIMARY KEY, v bytea NOT NULL)');
    ownsTable = true;
    for (const row of fixture) await db.query('INSERT INTO public.pgsl_kv(k,v) VALUES($1,$2)', [row.k, row.v]);
    // A non-C payload deliberately cannot be decoded as JSON/UTF8; it must remain outside the range.
    await db.query('INSERT INTO public.pgsl_kv(k,v) VALUES($1,$2)', [Buffer.from('pgsl\0Nprivate'), Buffer.from([0xff])]);
  });
  afterAll(async () => {
    if (db) {
      try { if (ownsTable) await db.query('DROP TABLE public.pgsl_kv'); }
      finally { await db.end(); }
    }
  });

  it('executes real keyspace/NUL splitting and guarded JSON size aggregates without revealing private metadata', async () => {
    const safety: string[] = [];
    const report = await collectInventory({ async query(q: Query) {
      if (Object.values(SQL).includes(q.text)) {
        safety.push((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only);
        safety.push((await db.query('SHOW temp_file_limit')).rows[0].temp_file_limit);
      }
      return db.query(q);
    } }, { maxControlRecords: 100 });
    expect(safety).toEqual(Array.from({ length: 6 }, () => ['on', '0']).flat());
    const sections = report.sections as Record<string, { status: string; rows: Record<string, unknown>[] }>;
    expect(sections.control_categories!.status).toBe('ok');
    const categories = sections.control_categories!.rows;
    expect(categories.find(r => r.category === 'native_lrs_artifact')).toMatchObject({ records: '1', represented_resource_bytes: '123', size_metadata_records: '1' });
    expect(categories.find(r => r.category === 'native_lrs_commit')).toMatchObject({ represented_resource_bytes: '456' });
    expect(categories.find(r => r.category === 'native_lrs_head')).toMatchObject({ represented_resource_bytes: '789' });
    expect(categories.find(r => r.category === 'agent_registry')).toMatchObject({ records: '1', represented_resource_bytes: '55' });
    for (const category of ['gaming_head', 'own_subject_head', 'shared_lattice_head', 'immutable_lattice_holon']) {
      expect(categories.find(r => r.category === category)).toMatchObject({ represented_resource_bytes: '0', invalid_size_metadata_records: '1' });
    }
    expect(categories.find(r => r.category === 'other_ldp_resource')).toMatchObject({ records: '2', invalid_size_metadata_records: '2' });
    expect(categories.find(r => r.category === 'malformed_control_key')).toMatchObject({ records: '1' });
    expect(categories.find(r => r.category === 'other_control_record')).toMatchObject({ records: '1' });
    expect(categories.reduce((n, r) => n + Number(r.control_metadata_bytes), 0)).toBe(fixture.reduce((n, r) => n + r.v.length, 0));
    expect(categories.reduce((n, r) => n + Number(r.control_key_bytes), 0)).toBe(fixture.reduce((n, r) => n + r.k.length, 0));
    expect(JSON.stringify(report)).not.toMatch(/private|fixture-pod|secret|metadata'|https:/);
    expect(Number((await db.query('SELECT count(*) FROM public.pgsl_kv')).rows[0].count)).toBe(fixture.length + 1);
  });

  it('enforces the cap with a sentinel and reports exact prefix counts rather than extrapolating', async () => {
    const result = await db.query(SQL.control_categories, values(3));
    expect(result.rows.reduce((n: number, r: { records: string }) => n + Number(r.records), 0)).toBe(3);
    expect(result.rows.every((r: { truncated: boolean }) => r.truncated)).toBe(true);
    const complete = await db.query(SQL.control_categories, values(fixture.length));
    expect(complete.rows.every((r: { truncated: boolean }) => !r.truncated)).toBe(true);
  });

  it('sanitizes malformed UTF8 metadata as an unavailable section and rolls back cleanly', async () => {
    const k = Buffer.from(cpKey('ldp private-fixture-pod', 'https://private-fixture.example/bad-utf8'));
    await db.query('INSERT INTO public.pgsl_kv(k,v) VALUES($1,$2)', [k, Buffer.from([0xff])]);
    try {
      const report = await collectInventory(db, { maxControlRecords: 100 });
      expect(report).toMatchObject({ status: 'partial', sections: { control_categories: { status: 'unavailable', sqlstate: '22021' } } });
      expect(JSON.stringify(report)).not.toMatch(/private|UTF8|invalid byte/);
      expect((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off');
    } finally { await db.query('DELETE FROM public.pgsl_kv WHERE k=$1', [k]); }
  });

  it('refuses temporary-file allocation for a sort that spills', async () => {
    await db.query('BEGIN READ ONLY');
    try {
      await db.query("SET LOCAL work_mem = '64kB'");
      await db.query("SET LOCAL temp_file_limit = '0'");
      await db.query("SET LOCAL statement_timeout = '5000ms'");
      await expect(db.query('SELECT count(*) FROM (SELECT n FROM generate_series(1,100000) n ORDER BY md5(n::text)) sorted'))
        .rejects.toMatchObject({ code: '53400' });
    } finally { await db.query('ROLLBACK'); }
  });
});
