/**
 * REAL PostgreSQL integration — proves the ENTIRE PGSL store stack (content-
 * addressed compose, structural indexes, atom-granular ABAC projection, LDP CRUD,
 * mutable control-plane, durable rehydrate) runs UNCHANGED over the Postgres
 * FdbLike adapter. This is the budget-fitting managed backend (vs AKS+FDB).
 *
 * Skipped unless PGSL_PG_IT=1 (set by the CI job that stands up a Postgres service
 * container). node-postgres is pure JS, so no native build is needed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client, types } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import {
  openPgStore,
  PgWritePressureError,
  openStore,
  publicAtomAddress,
  CodecRegistry,
  rdfCodec,
  LdpStore,
  clearancePdp,
  projectHolonFor,
  CLASSIFICATION,
  type FdbLike,
  type StoredNode,
  InMemoryFdb,
} from '../packages/pgsl-store/src/index.js';
import { collectLive, hex, readerFromPg, rebuildTable, RebuildDeferredError, type KvReader } from '../packages/pgsl-store/src/gc.js';
import { nodeAddrFromUrn } from '../packages/pgsl-store/src/addressing.js';
import { nodeKey, cpKey } from '../packages/pgsl-store/src/keyspace.js';
import type { Engagement } from '@interego/agent-interop';

const RUN = process.env.PGSL_PG_IT === '1';
const ns = `${Date.now()}`;
const atom = (v: string): StoredNode => ({ uri: publicAtomAddress(`${ns}:${v}`), kind: 'atom', level: 0, value: v });

describe.skipIf(!RUN)('pgsl-store: FULL stack over REAL PostgreSQL', () => {
  let fdb: FdbLike;
  beforeAll(async () => {
    fdb = await openPgStore({ table: 'pgsl_kv' });
  });
  afterAll(async () => { await fdb?.close(); });

  async function collectorFixture(label: string) {
    const writer = new Client({ host: '127.0.0.1' }), reader = new Client({ host: '127.0.0.1' });
    const table = `pgsl_gc_${label}_${process.pid}_${Date.now()}`;
    const memory = new InMemoryFdb(), store = openStore(memory);
    const nodes = Array.from({ length: 32 }, (_, index) => atom(`${table}:${index}`));
    const fragment: StoredNode = { uri: 'urn:pgsl:fragment:' + 'f'.repeat(40), kind: 'fragment', level: 1, items: nodes.map(node => node.uri) };
    await store.compose([...nodes, fragment], { pod: table, resource: 'head' });
    await store.cpSet(`ldp ${table}`, 'head', { topUri: fragment.uri });
    const rows = await memory.transact(tx => tx.getRange(new TextEncoder().encode('pgsl\x00'), new TextEncoder().encode('pgsl\x01'), { limit: 1000 }));
    // Security deletion/revocation markers must survive both an aborted and a
    // successful attempt independently of which old graph nodes are collected.
    rows.push({ key: cpKey('security tombstones', 'revoked-agent'), value: new TextEncoder().encode('{"revoked":true,"permanent":true}') });
    await writer.connect(); await reader.connect();
    await writer.query(`CREATE TABLE ${table} (k bytea PRIMARY KEY, v bytea NOT NULL)`);
    for (const row of rows) await writer.query(`INSERT INTO ${table} VALUES($1,$2)`, [Buffer.from(row.key), Buffer.from(row.value)]);
    const original = (await writer.query(`SELECT encode(k,'hex') AS k, encode(v,'hex') AS v FROM ${table} ORDER BY k`)).rows;
    return { writer, reader, table, original,
      async unchanged() { expect((await reader.query(`SELECT encode(k,'hex') AS k, encode(v,'hex') AS v FROM ${table} ORDER BY k`)).rows).toEqual(original); },
      async close() {
        await writer.query('ROLLBACK').catch(() => undefined); await reader.query('ROLLBACK').catch(() => undefined);
        await writer.query(`DROP TABLE IF EXISTS ${table}, ${table}_live, ${table}_old_budget_fixture`);
        await writer.end(); await reader.end(); await memory.close();
      } };
  }

  it('bounds total collector SQL work across individually fast queries, rolls back a partial copy and releases a waiting reader', async () => {
    const f = await collectorFixture('budget');
    const allowances: number[] = [];
    let copies = 0, waitingRead: Promise<unknown> | undefined, readerFinished = false;
    const wrapped = { async query(sql: string, params?: unknown[]) {
      const timeout = /^SET LOCAL statement_timeout = '(\d+)ms'$/.exec(sql);
      if (timeout) allowances.push(Number(timeout[1]));
      if (sql.startsWith(`INSERT INTO ${f.table}_live `)) {
        // Each server statement is much shorter than the total budget. A fixed
        // per-statement timeout alone would let all of them finish and swap.
        await f.writer.query('SELECT pg_sleep(0.08)');
        const result = await f.writer.query(sql, params);
        copies++;
        if (!waitingRead) waitingRead = f.reader.query(`SELECT count(*) FROM ${f.table}`).then(value => { readerFinished = true; return value; });
        if (copies > 1) expect(readerFinished).toBe(false);
        return result;
      }
      return f.writer.query(sql, params);
    } };
    try {
      const started = performance.now();
      await expect(rebuildTable(wrapped, f.table, { sqlWorkBudgetMs: 1200, batch: 2, suffixOld: 'old_budget_fixture' }))
        .rejects.toBeInstanceOf(RebuildDeferredError);
      expect(copies).toBeGreaterThan(1); expect(waitingRead).toBeDefined();
      await waitingRead; expect(readerFinished).toBe(true);
      expect(performance.now() - started).toBeLessThan(4000);
      expect(allowances.at(-1)!).toBeLessThan(allowances[0]!);
      await f.unchanged();
      expect((await f.reader.query('SELECT to_regclass($1) AS staging, to_regclass($2) AS backup', [`${f.table}_live`, `${f.table}_old_budget_fixture`])).rows)
        .toEqual([{ staging: null, backup: null }]);
    } finally { await f.close(); }
  }, 15_000);

  it('never queues an exclusive maintenance lock behind a live reader', async () => {
    const f = await collectorFixture('nowait');
    try {
      await f.reader.query('BEGIN'); await f.reader.query(`SELECT k FROM ${f.table} LIMIT 1`);
      const started = performance.now();
      await expect(rebuildTable(f.writer, f.table, { suffixOld: 'old_budget_fixture' }))
        .rejects.toMatchObject({ code: 'REBUILD_DEFERRED', reason: 'lock-unavailable' });
      expect(performance.now() - started).toBeLessThan(2000);
      await f.reader.query('ROLLBACK'); await f.unchanged();
      expect((await f.reader.query('SELECT to_regclass($1) AS staging, to_regclass($2) AS backup', [`${f.table}_live`, `${f.table}_old_budget_fixture`])).rows)
        .toEqual([{ staging: null, backup: null }]);
    } finally { await f.close(); }
  }, 10_000);

  it('can commit a small exact live closure within the default budget without dropping security tombstones', async () => {
    const f = await collectorFixture('success');
    try {
      const result = await rebuildTable(f.writer, f.table, { suffixOld: 'old_budget_fixture' });
      expect(result.copied).toBe(result.newRows); expect(result.newRows).toBe(f.original.length);
      await f.unchanged();
      expect((await f.reader.query('SELECT to_regclass($1) AS backup', [`${f.table}_old_budget_fixture`])).rows[0]?.backup)
        .toBe(`${f.table}_old_budget_fixture`);
    } finally { await f.close(); }
  }, 10_000);

  it('collects identical topology and byte statistics without exporting normal payloads, including escaped Unicode atoms', async () => {
    // This connection is deliberately loopback-only. Seed only this test's
    // unique table from an in-memory store, never from a live store URL.
    const client = new Client({ host: '127.0.0.1' });
    const table = `pgsl_gc_topology_${process.pid}_${Date.now()}`;
    const memory = new InMemoryFdb();
    const store = openStore(memory);
    const nodes = [atom('large:' + 'opaque'.repeat(350_000)), atom('\u0000'), atom('\ud800'), atom('literal \\u text')];
    const fragment: StoredNode = { uri: 'urn:pgsl:fragment:' + 'd'.repeat(40), kind: 'fragment', level: 1,
      items: nodes.map(node => node.uri) };
    await store.compose([...nodes, fragment], { pod: 'topology-test', resource: 'head' });
    await store.cpSet('ldp topology-test', 'head', { topUri: fragment.uri });
    const rows = await memory.transact(transaction => transaction.getRange(
      new TextEncoder().encode('pgsl\x00'), new TextEncoder().encode('pgsl\x01'), { limit: 1000 }));
    const nodeKeys = new Set([...nodes, fragment].map(node => hex(nodeKey(nodeAddrFromUrn(node.uri)))));
    await client.connect();
    try {
      await client.query(`CREATE TABLE ${table} (k bytea PRIMARY KEY, v bytea NOT NULL)`);
      for (const row of rows) await client.query(`INSERT INTO ${table} (k,v) VALUES ($1,$2)`, [Buffer.from(row.key), Buffer.from(row.value)]);
      const completeReader = readerFromPg(client, table, 3);
      const byteFallback: KvReader = { scan: completeReader.scan, getMany: completeReader.getMany };
      const complete = await collectLive(byteFallback);
      let projectedBytes = 0, exportedNodeBytes = 0;
      const observed = readerFromPg({ async query(sql, params) {
        const result = await client.query<{ k: Buffer; v?: Buffer; topology?: unknown; value_bytes?: unknown }>(sql, params);
        for (const row of result.rows) {
          if (row.topology !== undefined) projectedBytes += Buffer.byteLength(JSON.stringify(row.topology));
          if (Buffer.isBuffer(row.v) && nodeKeys.has(hex(row.k))) {
            exportedNodeBytes += row.v.length;
            expect(row.v.length, 'normal large payload must remain inside PostgreSQL').toBeLessThan(1024);
          }
        }
        return result;
      } }, table, 3);
      await client.query('BEGIN');
      let projected: Awaited<ReturnType<typeof collectLive>>;
      try {
        projected = await collectLive(observed);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      expect([...projected.keys].sort()).toEqual([...complete.keys].sort());
      expect(projected.stats).toEqual(complete.stats);
      expect(projected.stats.liveNodeBytes).toBeGreaterThan(2 * 1024 * 1024);
      expect(projectedBytes + exportedNodeBytes).toBeLessThan(10_000);

      const corruptKey = Buffer.from(nodeKey(nodeAddrFromUrn(nodes[0]!.uri)));
      const original = rows.find(row => Buffer.from(row.key).equals(corruptKey))!.value;
      const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      for (const corrupt of [Buffer.from('{"kind":"atom","value":"PRIVATE_INVALID_JSON",'), Buffer.from([0xff, 0xfe, 0xfd]),
        Buffer.concat([Buffer.from('{"kind":"atom","level":0,"value":"'), Buffer.from([0xff]), Buffer.from('"}')])]) {
        await client.query(`UPDATE ${table} SET v=$2 WHERE k=$1`, [corruptKey, corrupt]);
        const error: unknown = await collectLive(observed).catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('refusing collection: PostgreSQL node topology could not be read');
        expect((error as Error).cause).toBeUndefined();
        expect((await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows).toEqual(count.rows);
        await client.query(`UPDATE ${table} SET v=$2 WHERE k=$1`, [corruptKey, Buffer.from(original)]);
      }
      await client.query(`UPDATE ${table} SET v=$2 WHERE k=$1`, [corruptKey, Buffer.from(JSON.stringify({ uri: nodes[0]!.uri, kind: 'wrong', level: 0 }))]);
      const malformedShape = await collectLive(observed);
      expect(malformedShape.stats.unreadableNodes).toBe(1);
    } finally {
      await client.query(`DROP TABLE IF EXISTS ${table}`);
      await client.end();
      await memory.close();
    }
  }, 60_000);

  it('compose + structural queries + durable rehydrate over Postgres', async () => {
    const store = openStore(fdb);
    const a = atom('alpha');
    const b = atom('beta');
    const frag: StoredNode = { uri: `urn:pgsl:fragment:${'a'.repeat(39)}0`, kind: 'fragment', level: 1, items: [a.uri, b.uri] };
    const res = await store.compose([a, b, frag], { pod: `https://pod/${ns}/`, resource: 'g/f' });
    expect(res.created).toBe(3);
    expect(await store.fragmentItems(frag.uri)).toEqual([a.uri, b.uri]);
    expect(await store.resolveResource(`https://pod/${ns}/`, 'g/f')).toEqual(frag);

    // Reconnect (new pool) -> rehydrate bodies from Postgres.
    const fdb2 = await openPgStore({ table: 'pgsl_kv' });
    try {
      const s2 = openStore(fdb2);
      expect(await s2.resolve(a.uri)).toEqual(a);
    } finally {
      await fdb2.close();
    }
  });

  it('idempotent compose over Postgres (content-addressed set-if-absent)', async () => {
    const store = openStore(fdb);
    const slice = [atom('p'), atom('q')];
    const first = await store.putMany(slice);
    expect(first.created + first.dedup).toBe(2);
    const second = await store.putMany(slice);
    expect(second).toEqual({ created: 0, dedup: 2 });
  });

  it('atom-granular ABAC projection over Postgres (same holon, different bytes)', async () => {
    const store = openStore(fdb);
    const name = atom('Ada');
    const ssn = atom('123-45-6789');
    const frag: StoredNode = { uri: `urn:pgsl:fragment:${'b'.repeat(39)}0`, kind: 'fragment', level: 1, items: [name.uri, ssn.uri] };
    await store.compose([name, ssn, frag], { pod: `https://pod/${ns}/`, resource: 'g/person' });
    await store.putAtomAttributes(frag.uri, ssn.uri, { classification: CLASSIFICATION.secret });

    const high = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.secret));
    const low = await projectHolonFor(store, frag.uri, clearancePdp(CLASSIFICATION.internal));
    expect(high.partial).toBe(false);
    expect(low.partial).toBe(true);
    expect(low.items.find((i) => i.uri === ssn.uri)!.redacted).toBe(true);
    expect(low.items.map((i) => i.uri)).toEqual(high.items.map((i) => i.uri)); // structure intact
  });

  it('mutable control-plane UPDATE/DELETE over Postgres', async () => {
    const store = openStore(fdb);
    const id = `acct-${ns}`;
    await store.cpSet('accounts', id, { v: 1 });
    await store.cpSet('accounts', id, { v: 2 });
    expect(await store.cpGet<{ v: number }>('accounts', id)).toEqual({ v: 2 });
    await store.cpDelete('accounts', id);
    expect(await store.cpGet('accounts', id)).toBeNull();
  });

  it('LDP resource CRUD over Postgres (byte-faithful)', async () => {
    const ldp = new LdpStore(openStore(fdb), new CodecRegistry().register(rdfCodec));
    const turtle = '@prefix ex: <http://ex/> .\nex:s ex:p "exact" .\n';
    await ldp.writeResource(`pod-${ns}`, 'ctx/doc.ttl', new TextEncoder().encode(turtle), 'text/turtle');
    const got = await ldp.readResource(`pod-${ns}`, 'ctx/doc.ttl');
    expect(new TextDecoder().decode(got!.bytes)).toBe(turtle);
  });

  // The direct-children skip-scan leans on bytea ordering and LIMIT; tests/pgsl-store-ldp-listing
  // holds the in-memory listing to the old full scan, and this holds Postgres to the in-memory one.
  it('container listing over Postgres matches the in-memory listing, tricky names included', async () => {
    const pod = `list-${ns}`;
    const base = 'http://css.internal/';
    const names = ['a', 'ab', 'a.b', 'a-b', 'a b', '日本', '😀', '', 'z'];
    const ids: string[] = [base];
    for (const n of names) {
      ids.push(`${base}${n}`, `${base}${n}/`);
      for (let i = 0; i < 12; i++) ids.push(`${base}${n}/x${i}`, `${base}${n}/deep/${i}/y`);
    }
    ids.push(`${base}nomarker/only/deep/z`);
    const mem = openStore(new InMemoryFdb());
    const pg = openStore(fdb);
    for (const [i, id] of ids.entries()) {
      const rec = { topUri: 'urn:x', opaqueUri: 'urn:x', contentType: id.endsWith('/') ? 'internal/container' : 'text/turtle', updatedAt: i, size: i };
      await mem.cpSet(`ldp ${pod}`, id, rec);
      await pg.cpSet(`ldp ${pod}`, id, rec);
    }
    const memLdp = new LdpStore(mem, new CodecRegistry());
    const pgLdp = new LdpStore(pg, new CodecRegistry());
    for (const probe of [base, `${base}a/`, `${base}a`, `${base}nomarker/`, `${base}absent/`, '']) {
      const want = await memLdp.listChildren(pod, probe);
      expect(await pgLdp.listChildren(pod, probe), probe).toStrictEqual(want);
      expect(await pgLdp.hasChildren(pod, probe), probe).toBe(want.length > 0);
    }
    expect((await pgLdp.listChildren(pod, base)).length).toBe(2 * names.length + 1);
  });

  // ★ THE ONE PROPERTY NO DOUBLE CAN CHECK. Everything else in this file would pass over
  // InMemoryFdb; these would not, because what is under test is an ISOLATION LEVEL — and
  // InMemoryFdb refuses the second write at either level, so it reports the guard as
  // working while production loses turns. The barrier below only ORDERS the calls the
  // real code makes against a real connection; it stands in for nothing.
  it('compareAndSet survives two OVERLAPPING transactions under READ COMMITTED', async () => {
    const enc = new TextEncoder(); const dec = new TextDecoder();
    const k = enc.encode(`cas:${ns}:overlap`);
    await fdb.transact(async (txn) => txn.compareAndSet(k, null, enc.encode('v0')));

    let open: () => void = () => {}; let arrived = 0;
    const gate = new Promise<void>((r) => { open = r; });
    const bothHaveRead = async (): Promise<void> => { if (++arrived === 2) open(); else await gate; };

    const race = (mine: string): Promise<boolean> => fdb.transact(async (txn) => {
      const seen = await txn.get(k);
      await bothHaveRead();               // neither has written yet — the losing interleave
      return txn.compareAndSet(k, seen ?? null, enc.encode(mine));
    });
    const [a, b] = await Promise.all([race('vA'), race('vB')]);

    // WHICH one lands is a race; that EXACTLY ONE does is the invariant. With the previous
    // unconditional `set` both landed and the loser's bytes were gone with no error.
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const final = await fdb.transact(async (txn) => txn.get(k));
    expect(dec.decode(final!)).toBe(a ? 'vA' : 'vB');
  });

  it('two concurrent creators of one absent key: exactly one lands', async () => {
    const enc = new TextEncoder();
    const k = enc.encode(`cas:${ns}:create`);
    let open: () => void = () => {}; let arrived = 0;
    const gate = new Promise<void>((r) => { open = r; });
    const bothHaveRead = async (): Promise<void> => { if (++arrived === 2) open(); else await gate; };
    const race = (mine: string): Promise<boolean> => fdb.transact(async (txn) => {
      await txn.get(k); await bothHaveRead();
      return txn.compareAndSet(k, null, enc.encode(mine));   // both saw: absent
    });
    // This is the `open` case in engagement-store: a minted id that must not overwrite a
    // stranger's row. `ON CONFLICT DO NOTHING` refuses the loser; DO UPDATE would not.
    expect((await Promise.all([race('A'), race('B')])).filter(Boolean)).toHaveLength(1);
  });

  it('ENGAGEMENT: an overlapped put is refused, not silently overwritten', async () => {
    // Imports the RELAY'S REAL store over the REAL adapter. This is the regression for the
    // defect: before the fix BOTH puts resolved and one turn vanished, with both callers
    // answered 200.
    const { engagementStoreOverFdb, ConcurrentModification } =
      await import('../deploy/mcp-relay/engagement-store.js');

    let open: () => void = () => {}; let arrived = 0; let armed = false;
    const gate = new Promise<void>((r) => { open = r; });
    const afterGet = async (): Promise<void> => {
      if (!armed) return;
      if (++arrived === 2) { armed = false; open(); } else await gate;
    };
    const ordered: FdbLike = {
      transact: (fn) => fdb.transact((txn) => fn({
        ...txn,
        get: async (key) => { const v = await txn.get(key); await afterGet(); return v; },
      })),
      close: () => fdb.close(),
    };

    const store = engagementStoreOverFdb(ordered);
    const id = `https://relay.test/engagements/${ns}-cas`;
    const rec = (turns: unknown[]): Engagement => ({
      id, state: 'working', openedBy: 'did:ethr:0xalice', turns,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Engagement);

    await store.put(rec([]), null);
    const base = (await store.get(id))!.version;

    armed = true;
    const out = await Promise.allSettled([
      store.put(rec([{ who: 'A' }]), base),
      store.put(rec([{ who: 'B' }]), base),
    ]);
    const kept = out.filter((r) => r.status === 'fulfilled');
    const refused = out.filter((r) => r.status === 'rejected');
    expect(kept).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // Asserted by TYPE, not by "it rejected": a raw pg error escaping as a StoreFault is a
    // different bug and must not read as this one fixed.
    expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConcurrentModification);
    // And the survivor's turn is really there — a refusal that also lost the winner's
    // write would satisfy the counts above and none of the point.
    expect((await store.get(id))!.record.turns).toHaveLength(1);
  });
});


describe.skipIf(!RUN)('pgsl-store: physical write admission over REAL PostgreSQL', () => {
  async function pressureFixture(label: string) {
    const client = new Client({ host: '127.0.0.1' });
    const suffix = `${process.pid}_${Date.now()}_${label}`;
    const table = `pgsl_pressure_${suffix}`;
    const filler = `${table}_filler`;
    const pools: FdbLike[] = [];
    await client.connect();
    await client.query(`CREATE TABLE ${table} (k bytea PRIMARY KEY, v bytea NOT NULL)`);
    await client.query(`CREATE TABLE ${filler} (v bytea NOT NULL)`);
    const connectionString = (applicationName: string): string => {
      const url = new URL('postgresql://127.0.0.1');
      url.port = process.env.PGPORT ?? '5432';
      url.username = process.env.PGUSER ?? 'postgres';
      url.password = process.env.PGPASSWORD ?? '';
      url.pathname = '/' + (process.env.PGDATABASE ?? 'pgsl');
      url.searchParams.set('application_name', applicationName);
      return url.href;
    };
    return {
      client, table, filler, suffix,
      async open(options: { maxDatabaseBytes: number; maxTransactionInputBytes?: number; writeReserveBytes?: number },
        applicationName = `pgsl-pressure-${suffix}-${pools.length}`) {
        const adapter = await openPgStore({ table, ensureSchema: false, connectionString: connectionString(applicationName), ...options });
        pools.push(adapter);
        return adapter;
      },
      async databaseBytes() {
        const result = await client.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes');
        return Number(result.rows[0]!.bytes);
      },
      async value(key: Uint8Array) {
        const result = await client.query<{ v: Buffer }>(`SELECT v FROM ${table} WHERE k=$1`, [Buffer.from(key)]);
        return result.rows[0]?.v;
      },
      async close() {
        await Promise.all(pools.map(pool => pool.close()));
        await client.query(`DROP TABLE IF EXISTS ${table}, ${filler}`);
        await client.end();
      },
    };
  }

  it('refuses positive writes above the physical ceiling without committing an earlier delete, while reads and delete-only reclamation remain available', async () => {
    const fixture = await pressureFixture('reclaim');
    const key = Buffer.from('seed'), replacement = Buffer.from('replacement');
    try {
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [key, Buffer.from('original')]);
      const adapter = await fixture.open({ maxDatabaseBytes: 1, maxTransactionInputBytes: 4096, writeReserveBytes: 0 });
      expect(Buffer.from((await adapter.transact(tx => tx.get(key)))!).toString()).toBe('original');
      await expect(adapter.transact(async tx => {
        tx.clear(key);
        tx.set(replacement, Buffer.from('must never be acknowledged'));
        await tx.get(replacement);
        return 'acknowledged';
      })).rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      expect((await fixture.value(key))?.toString()).toBe('original');
      expect(await fixture.value(replacement)).toBeUndefined();
      await expect(adapter.transact(tx => tx.compareAndSet(key, Buffer.from('original'), Buffer.from('forbidden replacement'))))
        .rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      await expect(adapter.transact(tx => tx.compareAndSet(replacement, null, Buffer.from('forbidden create'))))
        .rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      expect((await fixture.value(key))?.toString()).toBe('original');
      expect(await fixture.value(replacement)).toBeUndefined();
      await adapter.transact(async tx => { tx.clear(key); });
      expect(await fixture.value(key)).toBeUndefined();
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [replacement, Buffer.from('reclaim this too')]);
      await adapter.transact(async tx => { tx.clearRange(Buffer.from([0]), Buffer.from([255])); });
      expect(await fixture.value(replacement)).toBeUndefined();
    } finally { await fixture.close(); }
  }, 15_000);

  it('rolls a flushed write back when cumulative transaction input exceeds its bound, then releases the writer lock', async () => {
    const fixture = await pressureFixture('rollback');
    const first = Buffer.from('first'), second = Buffer.from('second'), survivor = Buffer.from('survivor');
    try {
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await expect(adapter.transact(async tx => {
        tx.set(first, Buffer.alloc(512, 1));
        expect((await tx.get(first))?.length).toBe(512);
        tx.set(second, Buffer.alloc(4096, 2));
        await tx.get(second);
        return 'acknowledged';
      })).rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      expect(await fixture.value(first)).toBeUndefined();
      expect(await fixture.value(second)).toBeUndefined();
      const anotherPool = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await anotherPool.transact(async tx => { tx.set(survivor, Buffer.from('committed')); });
      expect((await fixture.value(survivor))?.toString()).toBe('committed');
    } finally { await fixture.close(); }
  }, 15_000);

  it('serializes positive writes from separate pools through COMMIT while a third pool can still read', async () => {
    const fixture = await pressureFixture('concurrent');
    const seed = Buffer.from('readable'), firstKey = Buffer.from('writer-one'), secondKey = Buffer.from('writer-two');
    let releaseFirst = () => {};
    let first: Promise<void> | undefined, second: Promise<void> | undefined;
    try {
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [seed, Buffer.from('read while writing')]);
      const options = { maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 };
      const one = await fixture.open(options), twoName = `pgsl-pressure-waiter-${fixture.suffix}`;
      const two = await fixture.open(options, twoName), reader = await fixture.open(options);
      let entered = () => {};
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const held = new Promise<void>(resolve => { releaseFirst = resolve; });
      first = one.transact(async tx => {
        tx.set(firstKey, Buffer.from('first'));
        await tx.get(firstKey);
        entered();
        await held;
      });
      await Promise.race([enteredPromise, first.then(() => { throw new Error('writer completed before its barrier'); })]);
      second = two.transact(async tx => { tx.set(secondKey, Buffer.from('second')); await tx.get(secondKey); });
      void second.catch(() => undefined); // Keep an early SQL failure handled until the final await.
      // Observe a real PostgreSQL lock wait rather than assuming timer order.
      let waiting = false;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const activity = await fixture.client.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND wait_event='advisory') AS waiting",
          [twoName]);
        if (activity.rows[0]?.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      expect(await fixture.value(secondKey)).toBeUndefined();
      expect(Buffer.from((await reader.transact(tx => tx.get(seed)))!).toString()).toBe('read while writing');
      releaseFirst();
      await Promise.all([first, second]);
      expect((await fixture.value(firstKey))?.toString()).toBe('first');
      expect((await fixture.value(secondKey))?.toString()).toBe('second');
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second].filter((operation): operation is Promise<void> => operation !== undefined));
      await fixture.close();
    }
  }, 15_000);

  it('refreshes physical size before COMMIT and rolls back an admitted write if independent database growth consumes its headroom', async () => {
    const fixture = await pressureFixture('refresh');
    const key = Buffer.from('not-acknowledged');
    try {
      const ceiling = (await fixture.databaseBytes()) + 128 * 1024;
      const adapter = await fixture.open({ maxDatabaseBytes: ceiling, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await expect(adapter.transact(async tx => {
        tx.set(key, Buffer.from('small admitted write'));
        expect(Buffer.from((await tx.get(key))!).toString()).toBe('small admitted write');
        // Random bytes force real heap/TOAST allocation, not a stubbed size.
        await fixture.client.query(`INSERT INTO ${fixture.filler}(v) VALUES ($1)`, [randomBytes(1024 * 1024)]);
        expect(await fixture.databaseBytes()).toBeGreaterThan(ceiling);
        return 'acknowledged';
      })).rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      expect(await fixture.value(key)).toBeUndefined();
      expect((await fixture.client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${fixture.filler}`)).rows[0]?.count).toBe('1');
    } finally { await fixture.close(); }
  }, 15_000);

  it('charges empty positive operations against an explicitly small input budget before issuing mutation SQL', async () => {
    const fixture = await pressureFixture('operation_bound');
    const seed = Buffer.from('existing');
    const sequence = `${fixture.table}_writes`, counter = `${fixture.table}_count`;
    try {
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [seed, Buffer.from('preserved')]);
      await fixture.client.query(`CREATE SEQUENCE ${sequence}`);
      await fixture.client.query(`CREATE FUNCTION ${counter}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('${sequence}'); RETURN NEW; END; $$`);
      await fixture.client.query(`CREATE TRIGGER pressure_count BEFORE INSERT OR UPDATE ON ${fixture.table}
        FOR EACH ROW EXECUTE FUNCTION ${counter}()`);
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await expect(adapter.transact(async tx => {
        for (let operation = 0; operation < 4097; operation++) tx.set(Buffer.alloc(0), Buffer.alloc(0));
        return 'acknowledged';
      })).rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      // nextval is deliberately not transactional: rollback would hide the KV
      // effects, but could not hide an INSERT/UPDATE that reached this trigger.
      expect((await fixture.client.query<{ is_called: boolean }>(`SELECT is_called FROM ${sequence}`)).rows[0]?.is_called).toBe(false);
      expect((await fixture.value(seed))?.toString()).toBe('preserved');
      expect(await fixture.value(Buffer.alloc(0))).toBeUndefined();
    } finally {
      await fixture.client.query(`DROP FUNCTION IF EXISTS ${counter}() CASCADE`);
      await fixture.client.query(`DROP SEQUENCE IF EXISTS ${sequence}`);
      await fixture.close();
    }
  }, 15_000);


  it('keeps submitted set bytes when caller-owned key and value buffers are reused before flush', async () => {
    const fixture = await pressureFixture('set_snapshot');
    try {
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await adapter.transact(async tx => {
        const key = Buffer.from('write-a'), value = Buffer.from('original');
        tx.set(key, value);
        key.write('write-b');
        value.write('mutated!');
        expect(Buffer.from((await tx.get(Buffer.from('write-a')))!).toString()).toBe('original');
      });
      expect((await fixture.value(Buffer.from('write-a')))?.toString()).toBe('original');
      expect(await fixture.value(Buffer.from('write-b'))).toBeUndefined();
    } finally { await fixture.close(); }
  }, 15_000);

  it('captures compareAndSet arguments before awaiting a pending flush, including the expected revision bytes', async () => {
    const fixture = await pressureFixture('cas_snapshot');
    try {
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2),($3,$4)`,
        [Buffer.from('cas-a'), Buffer.from('v0'), Buffer.from('cas-b'), Buffer.from('e1')]);
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await adapter.transact(async tx => {
        tx.set(Buffer.from('flush-before-cas'), Buffer.from('pending'));
        const key = Buffer.from('cas-a'), expected = Buffer.from('v0'), value = Buffer.from('v1');
        const committing = tx.compareAndSet(key, expected, value);
        // compareAndSet must capture all three before its await flush yields.
        key.write('cas-b');
        expected.write('e1');
        value.write('xx');
        expect(await committing).toBe(true);
      });
      expect((await fixture.value(Buffer.from('cas-a')))?.toString()).toBe('v1');
      expect((await fixture.value(Buffer.from('cas-b')))?.toString()).toBe('e1');
    } finally { await fixture.close(); }
  }, 15_000);

  it('keeps read keys and queued deletion ranges scoped to the submitted buffers after callers reuse them', async () => {
    const fixture = await pressureFixture('range_snapshot');
    try {
      for (const key of ['read/a', 'read/b', 'delete/a', 'delete/b', 'range/a', 'range/b', 'range/c', 'range/z']) {
        await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [Buffer.from(key), Buffer.from(key)]);
      }
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await adapter.transact(async tx => {
        tx.set(Buffer.from('flush-before-read'), Buffer.from('pending'));
        const key = Buffer.from('read/a');
        const reading = tx.get(key);
        key.write('read/b');
        expect(Buffer.from((await reading)!).toString()).toBe('read/a');
        tx.set(Buffer.from('flush-before-range'), Buffer.from('pending'));
        const begin = Buffer.from('range/b'), end = Buffer.from('range/c');
        const scanning = tx.getRange(begin, end);
        begin.write('range/a');
        end.write('range/z');
        expect((await scanning).map(row => Buffer.from(row.key).toString())).toEqual(['range/b']);
      });
      await adapter.transact(async tx => {
        const key = Buffer.from('delete/a');
        tx.clear(key);
        key.write('delete/b');
        const begin = Buffer.from('range/b'), end = Buffer.from('range/c');
        tx.clearRange(begin, end);
        begin.write('range/a');
        end.write('range/z');
      });
      expect(await fixture.value(Buffer.from('delete/a'))).toBeUndefined();
      expect((await fixture.value(Buffer.from('delete/b')))?.toString()).toBe('delete/b');
      expect(await fixture.value(Buffer.from('range/b'))).toBeUndefined();
      for (const key of ['range/a', 'range/c', 'range/z']) expect((await fixture.value(Buffer.from(key)))?.toString()).toBe(key);
    } finally { await fixture.close(); }
  }, 15_000);


  it('charges retired OLD.v bytes before each update and rolls the whole transaction and its retirement journal back on overflow', async () => {
    const fixture = await pressureFixture('retired_budget');
    const retired = `${fixture.table}_retired`, journal = `${fixture.table}_journal`;
    const first = Buffer.from('first'), second = Buffer.from('second');
    const originalFirst = randomBytes(3072), originalSecond = randomBytes(3072);
    try {
      await fixture.client.query(`CREATE TABLE ${retired} (v bytea NOT NULL)`);
      await fixture.client.query(`CREATE FUNCTION ${journal}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO ${retired}(v) VALUES (OLD.v); RETURN NEW; END; $$`);
      await fixture.client.query(`CREATE TRIGGER pressure_retire AFTER UPDATE ON ${fixture.table}
        FOR EACH ROW EXECUTE FUNCTION ${journal}()`);
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2),($3,$4)`,
        [first, originalFirst, second, originalSecond]);
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await expect(adapter.transact(async tx => {
        tx.set(first, Buffer.from('a'));
        expect(Buffer.from((await tx.get(first))!).toString()).toBe('a');
        tx.set(second, Buffer.from('b'));
        await tx.get(second);
        return 'acknowledged';
      })).rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      expect(await fixture.value(first)).toEqual(originalFirst);
      expect(await fixture.value(second)).toEqual(originalSecond);
      expect((await fixture.client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${retired}`)).rows[0]?.count).toBe('0');
    } finally {
      await fixture.client.query(`DROP FUNCTION IF EXISTS ${journal}() CASCADE`);
      await fixture.client.query(`DROP TABLE IF EXISTS ${retired}`);
      await fixture.close();
    }
  }, 15_000);


  it.each([NaN, null, undefined])('keeps a caught CAS size-decoder refusal (%s) sticky and rolls back earlier flushed writes after the decoder recovers', async (invalidSize) => {
    const fixture = await pressureFixture('decoder_refusal');
    const existing = Buffer.from('existing'), first = Buffer.from('first');
    const originalParser = types.getTypeParser(23, 'text');
    let refusals = 0;
    try {
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [existing, Buffer.from('original')]);
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 });
      await expect(adapter.transact(async tx => {
        tx.set(first, Buffer.from('must roll back'));
        expect(Buffer.from((await tx.get(first))!).toString()).toBe('must roll back');
        try {
          // Fault only the int4 decoder used by octet_length(v); the queries,
          // transaction, CAS target and rollback all use actual PostgreSQL.
          types.setTypeParser(23, 'text', () => invalidSize);
          try {
            await tx.compareAndSet(existing, Buffer.from('original'), Buffer.from('replacement'));
          } catch (error) {
            if (!(error instanceof PgWritePressureError)) throw error;
            refusals++;
          }
        } finally {
          // Restore before callback completion so the final size check can
          // succeed. The prior refusal itself must still prevent COMMIT.
          types.setTypeParser(23, 'text', originalParser);
        }
        expect(refusals).toBe(1);
        return 'acknowledged';
      })).rejects.toBeInstanceOf(PgWritePressureError);
      expect(refusals).toBe(1);
      expect(await fixture.value(first)).toBeUndefined();
      expect((await fixture.value(existing))?.toString()).toBe('original');
    } finally {
      types.setTypeParser(23, 'text', originalParser);
      await fixture.close();
    }
  }, 15_000);

  it('keeps identical CAS a conditional row-lock proof above the ceiling, so legacy resource deletion still works without retirement updates', async () => {
    const fixture = await pressureFixture('proof_delete');
    const key = Buffer.from('proof'), value = Buffer.from('original');
    const sequence = `${fixture.table}_updates`, counter = `${fixture.table}_count`;
    try {
      const normal = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER });
      const registry = new CodecRegistry().register(rdfCodec);
      const seeded = new LdpStore(openStore(normal), registry);
      await seeded.writeResource('css', '/deletable.bin', Buffer.from('resource'), 'application/octet-stream');
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [key, value]);
      await fixture.client.query(`CREATE SEQUENCE ${sequence}`);
      await fixture.client.query(`CREATE FUNCTION ${counter}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM nextval('${sequence}'); RETURN NEW; END; $$`);
      await fixture.client.query(`CREATE TRIGGER count_proof_updates BEFORE UPDATE ON ${fixture.table}
        FOR EACH ROW EXECUTE FUNCTION ${counter}()`);
      const blocked = await fixture.open({ maxDatabaseBytes: 1, writeReserveBytes: 0 });
      expect(await blocked.transact(tx => tx.compareAndSet(key, Buffer.from('wrong'), Buffer.from('wrong')))).toBe(false);
      expect(await blocked.transact(tx => tx.compareAndSet(key, value, value))).toBe(true);
      expect(await blocked.transact(tx => tx.compareAndSet(Buffer.from('absent'), value, value))).toBe(false);
      await expect(blocked.transact(async tx => {
        expect(await tx.compareAndSet(key, value, value)).toBe(true);
        tx.set(Buffer.from('growth'), Buffer.from('still forbidden'));
      })).rejects.toMatchObject({ code: 'PGSL_WRITE_PRESSURE' });
      expect(await fixture.value(Buffer.from('growth'))).toBeUndefined();
      const deleting = new LdpStore(openStore(blocked), registry);
      expect(await deleting.deleteResource('css', '/deletable.bin')).toBe(true);
      expect(await deleting.stat('css', '/deletable.bin')).toBeNull();
      await blocked.transact(async tx => { expect(await tx.compareAndSet(key, value, value)).toBe(true); tx.clear(key); });
      expect(await fixture.value(key)).toBeUndefined();
      expect((await fixture.client.query<{ is_called: boolean }>(`SELECT is_called FROM ${sequence}`)).rows[0]?.is_called).toBe(false);
    } finally {
      await fixture.client.query(`DROP FUNCTION IF EXISTS ${counter}() CASCADE`);
      await fixture.client.query(`DROP SEQUENCE IF EXISTS ${sequence}`);
      await fixture.close();
    }
  }, 20_000);

  it('admits a previously supported large replacement including retired old-value bytes under the bounded default', async () => {
    const fixture = await pressureFixture('large_replace');
    const key = Buffer.from('large');
    const before = randomBytes(22 * 1024 * 1024), after = randomBytes(22 * 1024 * 1024);
    try {
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2)`, [key, before]);
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER });
      expect(await adapter.transact(tx => tx.compareAndSet(key, before, after))).toBe(true);
      expect(createHash('sha256').update((await fixture.value(key))!).digest('hex')).toBe(createHash('sha256').update(after).digest('hex'));
    } finally { await fixture.close(); }
  }, 45_000);

  it('stores the upload contract maximum 48 MiB opaque package through the actual chunked LDP transaction under default bounds', async () => {
    const fixture = await pressureFixture('package_max');
    const bytes = randomBytes(48 * 1024 * 1024);
    try {
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER });
      const ldp = new LdpStore(openStore(adapter), new CodecRegistry().register(rdfCodec));
      await ldp.writeStream('css', '/maximum-package.zip', (async function* () { yield bytes; })(), 'application/zip');
      expect((await ldp.stat('css', '/maximum-package.zip'))?.size).toBe(bytes.length);
      const actual = createHash('sha256');
      for await (const part of ldp.readStream('css', '/maximum-package.zip')) actual.update(part);
      expect(actual.digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    } finally { await fixture.close(); }
  }, 60_000);

  it('admits native 8 MiB opaque revisions and more than 4096 RDF projection writes without lowering the existing representation contracts', async () => {
    const fixture = await pressureFixture('native_rdf');
    try {
      const adapter = await fixture.open({ maxDatabaseBytes: Number.MAX_SAFE_INTEGER });
      const ldp = new LdpStore(openStore(adapter), new CodecRegistry().register(rdfCodec));
      const first = randomBytes(8 * 1024 * 1024), second = randomBytes(8 * 1024 * 1024);
      const committed = await ldp.commitResource('css', '/native.json', first, 'application/json', { expectedRevision: null });
      expect(committed.status).toBe('committed');
      if (committed.status !== 'committed') throw new Error('first native revision was not committed');
      const replaced = await ldp.commitResource('css', '/native.json', second, 'application/json', { expectedRevision: committed.revision });
      expect(replaced.status).toBe('committed');
      expect(createHash('sha256').update((await ldp.readResource('css', '/native.json'))!.bytes).digest('hex')).toBe(createHash('sha256').update(second).digest('hex'));
      // 1000 unique statement atoms produce at least 5000 node/index KV writes.
      const rdf = Buffer.from(Array.from({ length: 1000 }, (_, i) => `<urn:s:${i}> <urn:p> "${i}" .\n`).join(''));
      expect(rdf.length).toBeLessThan(8 * 1024 * 1024);
      await ldp.writeResource('css', '/many.ttl', rdf, 'text/turtle');
      expect(Buffer.from((await ldp.readResource('css', '/many.ttl'))!.bytes)).toEqual(rdf);
    } finally { await fixture.close(); }
  }, 60_000);

  it('takes the mutation lock before flushing queued deletes for an identical CAS, avoiding inversion with a concurrent writer', async () => {
    const fixture = await pressureFixture('proof_order');
    const target = Buffer.from('target'), proof = Buffer.from('proof'), original = Buffer.from('original');
    const gate = `${fixture.table}_gate`;
    const deleterName = `proof-deleter-${fixture.suffix}`, writerName = `proof-writer-${fixture.suffix}`;
    let gateHeld = false, deleteAttempts = 0, writeAttempts = 0;
    let deleting: Promise<boolean> | undefined, writing: Promise<void> | undefined;
    const unlock = async () => {
      if (gateHeld) {
        await fixture.client.query('SELECT pg_advisory_unlock(1346851661, hashtext($1))', [fixture.table]);
        gateHeld = false;
      }
    };
    const waitForLock = async (applicationName: string): Promise<string | null> => {
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        const result = await fixture.client.query<{ wait_event_type: string | null; wait_event: string | null }>(
          'SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE application_name=$1', [applicationName]);
        const row = result.rows[0];
        if (row?.wait_event_type === 'Lock') return row.wait_event;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('expected a PostgreSQL lock wait');
    };
    try {
      await fixture.client.query(`INSERT INTO ${fixture.table}(k,v) VALUES ($1,$2),($3,$4)`, [target, original, proof, original]);
      await fixture.client.query(`CREATE FUNCTION ${gate}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(1346851661, hashtext(TG_TABLE_NAME)); RETURN OLD; END; $$`);
      await fixture.client.query(`CREATE TRIGGER hold_delete BEFORE DELETE ON ${fixture.table}
        FOR EACH ROW EXECUTE FUNCTION ${gate}()`);
      await fixture.client.query('SELECT pg_advisory_lock(1346851661, hashtext($1))', [fixture.table]);
      gateHeld = true;
      const options = { maxDatabaseBytes: Number.MAX_SAFE_INTEGER, maxTransactionInputBytes: 4096, writeReserveBytes: 8192 };
      const deleter = await fixture.open(options, deleterName), writer = await fixture.open(options, writerName);
      deleting = deleter.transact(async tx => {
        deleteAttempts++;
        tx.clear(target);
        return tx.compareAndSet(proof, original, original);
      });
      void deleting.catch(() => undefined);
      expect(await waitForLock(deleterName)).toBe('advisory');
      writing = writer.transact(async tx => {
        writeAttempts++;
        tx.set(target, Buffer.from('replacement'));
        await tx.get(target);
      });
      void writing.catch(() => undefined);
      // The writer must wait at the shared admission lock, not at the row
      // locked by DELETE while the deleter later waits for that same admission.
      expect(await waitForLock(writerName)).toBe('advisory');
      await unlock();
      expect(await deleting).toBe(true);
      await writing;
      expect(deleteAttempts).toBe(1);
      expect(writeAttempts).toBe(1);
      expect((await fixture.value(target))?.toString()).toBe('replacement');
    } finally {
      await unlock();
      await Promise.allSettled([deleting, writing].filter(operation => operation !== undefined));
      await fixture.client.query(`DROP FUNCTION IF EXISTS ${gate}() CASCADE`);
      await fixture.close();
    }
  }, 20_000);

});
