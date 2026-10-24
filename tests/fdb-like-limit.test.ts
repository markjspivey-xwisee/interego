/**
 * `getRange` must honour its bound, in every backend, or nothing above it can be bounded.
 *
 * ── ★★ WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
 *
 * A system-wide audit found 51 response surfaces returning collections that grow with stored data —
 * including the substrate's own `discover()` and the kernel's `dereference()`. Every one of them is
 * ultimately an ordered scan over this interface, which was declared with no bound at all. The
 * bounded read is the primitive the whole zero-copy refactor sits on, so an implementation that
 * silently ignores `limit` is not slower, it is broken: its callers page correctly against the mock
 * and unboundedly against production.
 *
 * ★ THE CURSOR PROPERTY IS THE POINT, not the slice. The keyspace is bytewise-order-preserving, so
 * the LAST KEY of a page is the cursor and `strinc(lastKey)` starts the next one. These tests walk a
 * range in pages and assert the walk reconstructs the whole range exactly once — no gaps, no
 * repeats — because a pager that merely returns fewer rows while losing or duplicating items at the
 * seam is the failure that looks like success.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryFdb } from '../packages/pgsl-store/src/mem-fdb.js';
import { strinc } from '../packages/pgsl-store/src/keyspace.js';
import type { FdbLike, KeyValue } from '../packages/pgsl-store/src/fdb-like.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const key = (n: number): Uint8Array => enc.encode('k/' + String(n).padStart(4, '0'));
const BEGIN = enc.encode('k/');
const END = strinc(BEGIN);

async function seed(db: FdbLike, n: number): Promise<void> {
  await db.transact(async (t) => { for (let i = 0; i < n; i++) t.set(key(i), enc.encode('v' + i)); });
}

/** Walk the whole range in pages of `size`, using the last key as the cursor. */
async function walk(db: FdbLike, size: number): Promise<{ keys: string[]; pages: number }> {
  const keys: string[] = [];
  let cursor: Uint8Array<ArrayBufferLike> = BEGIN;
  let pages = 0;
  for (;;) {
    const rows: KeyValue[] = await db.transact(async (t) => t.getRange(cursor, END, { limit: size }));
    if (rows.length === 0) break;
    pages++;
    for (const r of rows) keys.push(dec.decode(r.key));
    expect(rows.length).toBeLessThanOrEqual(size);
    const last = rows[rows.length - 1]!.key;
    cursor = strinc(last);
    if (pages > 500) throw new Error('walk did not terminate — the cursor is not advancing');
  }
  return { keys, pages };
}

describe('InMemoryFdb honours the range bound', () => {
  it('★ returns at most `limit` rows', async () => {
    const db = new InMemoryFdb();
    await seed(db, 50);
    const rows = await db.transact(async (t) => t.getRange(BEGIN, END, { limit: 7 }));
    expect(rows.length).toBe(7);
  });

  it('an absent or non-positive limit is unbounded, as before', async () => {
    const db = new InMemoryFdb();
    await seed(db, 12);
    expect((await db.transact(async (t) => t.getRange(BEGIN, END))).length).toBe(12);
    expect((await db.transact(async (t) => t.getRange(BEGIN, END, {}))).length).toBe(12);
    expect((await db.transact(async (t) => t.getRange(BEGIN, END, { limit: 0 }))).length).toBe(12);
  });

  it('the page is the FIRST n in bytewise key order, so the last key is a usable cursor', async () => {
    const db = new InMemoryFdb();
    await seed(db, 30);
    const rows = await db.transact(async (t) => t.getRange(BEGIN, END, { limit: 5 }));
    expect(rows.map(r => dec.decode(r.key))).toEqual([0, 1, 2, 3, 4].map(n => dec.decode(key(n))));
  });

  it('★★ a paged walk reconstructs the whole range exactly once — no gap, no repeat at the seam', async () => {
    const db = new InMemoryFdb();
    await seed(db, 47);
    const { keys, pages } = await walk(db, 10);
    const expected = Array.from({ length: 47 }, (_, i) => dec.decode(key(i)));
    expect(keys).toEqual(expected);
    expect(new Set(keys).size).toBe(47);
    expect(pages).toBe(5);
  });

  it('a page size larger than the range terminates in one page', async () => {
    const db = new InMemoryFdb();
    await seed(db, 3);
    const { keys, pages } = await walk(db, 100);
    expect(keys.length).toBe(3);
    expect(pages).toBe(1);
  });

  it('the bound applies to uncommitted writes in the same transaction too', async () => {
    // getRange merges committed rows with the transaction's own buffered writes. A limit applied
    // only to the committed half would return more than asked for mid-transaction.
    const db = new InMemoryFdb();
    await seed(db, 5);
    const rows = await db.transact(async (t) => {
      for (let i = 5; i < 20; i++) t.set(key(i), enc.encode('v' + i));
      return t.getRange(BEGIN, END, { limit: 6 });
    });
    expect(rows.length).toBe(6);
    expect(rows.map(r => dec.decode(r.key))).toEqual([0, 1, 2, 3, 4, 5].map(n => dec.decode(key(n))));
  });
});

describe('InMemoryFdb range reads cost what they return', () => {
  // The direct-children skip-scan (store.ts cpListChildren) issues one small bounded read per child
  // container. The fake used to scan and sort its whole map on every read whatever the limit, which
  // made a root listing over 200 pods x 100 records take 98 s here against 1.2 s for one full scan.
  // It now keeps a sorted key index; these hold that the index answers exactly what the scan did.

  /** Small deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('★ a bounded read matches a naive filter-and-sort, across commits and over pending writes', async () => {
    for (const seedNo of [1, 2, 3]) {
      const r = rng(seedNo);
      const db = new InMemoryFdb();
      const model = new Map<number, string>(); // the committed state, by key number
      const bytes = (n: number): Uint8Array => key(n);
      for (let round = 0; round < 40; round++) {
        const pending = new Map(model);
        const got = await db.transact(async (t) => {
          // Sets (new keys and overwrites), clears (present and absent) and a clearRange, so a
          // pending write can add a key, hide one, or replace a value the index already holds.
          for (let i = 0; i < 1 + Math.floor(r() * 12); i++) {
            const n = Math.floor(r() * 200);
            if (r() < 0.65) { t.set(bytes(n), enc.encode(`v${n}.${round}`)); pending.set(n, `v${n}.${round}`); }
            else { t.clear(bytes(n)); pending.delete(n); }
          }
          if (r() < 0.2) {
            const lo = Math.floor(r() * 200);
            const hi = lo + Math.floor(r() * 20);
            t.clearRange(bytes(lo), bytes(hi));
            for (const n of [...pending.keys()]) if (n >= lo && n < hi) pending.delete(n);
          }
          const lo = Math.floor(r() * 210);
          const hi = lo + Math.floor(r() * 120);
          const limit = r() < 0.2 ? undefined : 1 + Math.floor(r() * 15);
          const rows = await t.getRange(bytes(lo), bytes(hi), limit === undefined ? undefined : { limit });
          const want = [...pending.keys()].filter((n) => n >= lo && n < hi).sort((a, b) => a - b)
            .slice(0, limit ?? Infinity).map((n) => [dec.decode(bytes(n)), pending.get(n)]);
          return { rows: rows.map((x) => [dec.decode(x.key), dec.decode(x.value)]), want };
        });
        expect(got.rows, `seed ${seedNo} round ${round}`).toEqual(got.want);
        model.clear();
        for (const [n, v] of pending) model.set(n, v);
      }
    }
  });

  it('★ bounded reads do not scan the store: 100 one-row reads cost less than one full read', async () => {
    // Relative, so it does not depend on the machine's speed: before the index each one-row read
    // sorted the whole range, so 100 of them cost about 100 full reads.
    const db = new InMemoryFdb();
    await db.transact(async (t) => { for (let i = 0; i < 20000; i++) t.set(enc.encode('k/' + String(i).padStart(6, '0')), enc.encode('v' + i)); });
    await db.transact(async (t) => t.getRange(BEGIN, END, { limit: 1 })); // builds the index
    const t0 = performance.now();
    const all = await db.transact(async (t) => t.getRange(BEGIN, END));
    const full = performance.now() - t0;
    const t1 = performance.now();
    await db.transact(async (t) => {
      for (let i = 0; i < 100; i++) expect((await t.getRange(BEGIN, END, { limit: 1 })).length).toBe(1);
    });
    const bounded = performance.now() - t1;
    expect(all.length).toBe(20000);
    expect(bounded).toBeLessThan(full);
  });
});
