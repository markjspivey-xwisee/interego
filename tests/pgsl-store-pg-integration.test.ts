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
import { Client } from 'pg';
import {
  openPgStore,
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
      await client.query(`UPDATE ${table} SET v=$2 WHERE k=$1`, [corruptKey, Buffer.from('{"kind":"wrong","level":0}')]);
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
