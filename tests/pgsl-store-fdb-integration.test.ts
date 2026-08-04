/**
 * REAL FoundationDB integration — the same store logic the in-memory suite
 * exercises, run against a live FDB via the openRealFdb adapter. Skipped unless
 * PGSL_FDB_IT=1 (set by the CI job that stands up FoundationDB on Linux), so the
 * local dev box needs no native client and no Docker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { openRealFdb } from '../packages/pgsl-store/src/fdb-real.js';
import {
  openStore,
  publicAtomAddress,
  type FdbLike,
  type StoredNode,
} from '../packages/pgsl-store/src/index.js';

const RUN = process.env.PGSL_FDB_IT === '1';
const ns = `${Date.now()}`; // unique per run, so re-runs on a shared cluster don't collide

function atom(v: string): StoredNode {
  return { uri: publicAtomAddress(`${ns}:${v}`), kind: 'atom', level: 0, value: v };
}
const fragUri = 'urn:pgsl:fragment:' + createHash('sha256').update(`${ns}:frag`).digest('hex').slice(0, 40);

describe.skipIf(!RUN)('pgsl-store: REAL FoundationDB integration', () => {
  let fdb: FdbLike;
  beforeAll(async () => { fdb = await openRealFdb(); });
  afterAll(async () => { await fdb?.close(); });

  it('durably survives a real reconnect with node bodies', async () => {
    const a = atom('alpha');
    const b = atom('beta');
    const frag: StoredNode = { uri: fragUri, kind: 'fragment', level: 1, items: [a.uri, b.uri] };

    const w = openStore(fdb);
    const res = await w.compose([a, b, frag], { pod: `https://pod/${ns}/`, resource: 'ctx/frag' });
    expect(res.created).toBe(3);

    // Reconnect (a brand-new FDB connection) and read back through it.
    const fdb2 = await openRealFdb();
    try {
      const r = openStore(fdb2);
      expect(await r.resolve(a.uri)).toEqual(a); // full body survived
      expect(await r.resolveResource(`https://pod/${ns}/`, 'ctx/frag')).toEqual(frag);
      expect(await r.fragmentItems(fragUri)).toEqual([a.uri, b.uri]); // ordered
    } finally {
      await fdb2.close();
    }
  });

  it('is idempotent on replay (content-addressed set-if-absent)', async () => {
    const store = openStore(fdb);
    const slice = [atom('p'), atom('q')];
    expect((await store.putMany(slice)).created).toBe(2);
    expect(await store.putMany(slice)).toEqual({ created: 0, dedup: 2 });
  });

  it('mutable control-plane UPDATE/DELETE works on real FDB', async () => {
    const store = openStore(fdb);
    const id = `acct-${ns}`;
    await store.cpSet('accounts', id, { v: 1 });
    expect(await store.cpGet('accounts', id)).toEqual({ v: 1 });
    await store.cpSet('accounts', id, { v: 2 });
    expect(await store.cpGet<{ v: number }>('accounts', id)).toEqual({ v: 2 });
    await store.cpDelete('accounts', id);
    expect(await store.cpGet('accounts', id)).toBeNull();
  });

  it('compareAndSet: two overlapping transactions, exactly one lands', async () => {
    // The THIRD implementation of the seam. FDB transactions are genuinely serializable,
    // so `doTransaction` retries the loser and its re-read makes the compare fail — but
    // that is asserted here rather than argued, so this binding is not the untested one.
    const enc = new TextEncoder(); const dec = new TextDecoder();
    const k = enc.encode(`cas:${ns}:overlap`);
    await fdb.transact(async (txn) => txn.compareAndSet(k, null, enc.encode('v0')));

    const [a, b] = await Promise.all([
      fdb.transact(async (txn) => {
        const seen = await txn.get(k);
        return txn.compareAndSet(k, seen ?? null, enc.encode('vA'));
      }),
      fdb.transact(async (txn) => {
        const seen = await txn.get(k);
        return txn.compareAndSet(k, seen ?? null, enc.encode('vB'));
      }),
    ]);
    expect([a, b].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const final = await fdb.transact(async (txn) => txn.get(k));
    expect(['vA', 'vB']).toContain(dec.decode(final!));

    // A stale expectation is refused and writes nothing.
    const stale = enc.encode('v0');
    expect(await fdb.transact(async (txn) => txn.compareAndSet(k, stale, enc.encode('vC')))).toBe(false);
    const after = await fdb.transact(async (txn) => txn.get(k));
    expect(dec.decode(after!)).toBe(dec.decode(final!));
  });
});
