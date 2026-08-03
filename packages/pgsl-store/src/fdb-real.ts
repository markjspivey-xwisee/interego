/**
 * Real FoundationDB adapter over the `FdbLike` seam, using the `foundationdb`
 * npm binding (native libfdb_c). The store's logic is identical over this and
 * the in-memory fake.
 *
 * NOT unit-tested on the dev box (the native client is Linux-first). Verified by
 * the CI integration job (.github/workflows/pgsl-store-fdb.yml) on Linux, which
 * installs FDB and runs tests/pgsl-store-fdb-integration.test.ts against it.
 *
 * `foundationdb` is loaded via the dynamic-import escape hatch (the same pattern
 * @interego/solid uses for @interego/pgsl) so THIS package compiles and imports
 * cleanly even where the native binding is absent — it's only required at the
 * moment `openRealFdb()` is actually called.
 */

import type { FdbLike, FdbTxn, Key, KeyValue } from './fdb-like.js';

export interface FdbRealOptions {
  /** Path to fdb.cluster; omit to use the FDB default. */
  clusterFile?: string;
  /** FDB API version (default 720 — the max the node-foundationdb binding
   *  supports; a 7.x server accepts 720 clients). */
  apiVersion?: number;
}

/**
 * The `foundationdb` binding's surface, as far as this adapter uses it.
 *
 * ── WHY THIS IS DECLARED AND NOT `any` ───────────────────────────────────────
 *
 * Six `any`s lived here on the argument that an optional native dependency has no
 * resolvable types, so "there is nothing to narrow TO". The first half is true and the
 * conclusion does not follow: what the adapter needs is not the binding's real `.d.ts` but
 * a statement of the five calls it makes, and that can be written down. The `@ts-ignore`
 * below still covers the unresolvable specifier; everything after it is checked.
 *
 * The concrete failure that was possible and now is not: `getRangeAll` is the only range
 * read used, and `tn.getRange(...)` — the binding's OTHER, iterator-returning range method,
 * and the name of the `FdbTxn` member being implemented three lines away — compiled just as
 * happily under `any`. It would have returned an async iterator, `for (const kv of arr)`
 * would have thrown `arr is not iterable`, and the only place that runs is the Linux CI
 * integration job. Same for `db.close()` vs `db.destroy()`, and for `fdb.open()`'s
 * arity.
 *
 * This is a claim about the binding, not a guarantee from it — but a claim in one place
 * that fails loudly beats six casts that fail in CI.
 */
interface FdbModule {
  setAPIVersion(version: number): void;
  open(clusterFile?: string): FdbDatabase;
}

interface FdbDatabase {
  /** FDB's own retry-on-conflict loop. */
  doTransaction<T>(fn: (tn: FdbTransaction) => Promise<T>): Promise<T>;
  close(): void;
}

/**
 * Byte-shaped in and out. Values come back as node `Buffer`s in practice, but the adapter
 * only ever feeds them to `new Uint8Array(...)`, so the weaker `ArrayLike<number>` is both
 * true and enough — and `null` is spelled out because `v == null` below is load-bearing
 * (an absent key is `undefined`, not empty bytes).
 */
interface FdbTransaction {
  get(key: Buffer): Promise<ArrayLike<number> | null | undefined>;
  set(key: Buffer, value: Buffer): void;
  clear(key: Buffer): void;
  clearRange(begin: Buffer, end: Buffer): void;
  getRangeAll(begin: Buffer, end: Buffer): Promise<FdbKeyValue[]>;
}

/** The binding may yield [key, value] tuples or {key, value} objects — both are handled. */
type FdbKeyValue = [ArrayLike<number>, ArrayLike<number>] | {
  key: ArrayLike<number>;
  value: ArrayLike<number>;
};

export async function openRealFdb(opts: FdbRealOptions = {}): Promise<FdbLike> {
  // A real dynamic import (a Function('return import()') escape hatch has no
  // import callback under a VM/vitest and throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
  // @ts-ignore optional native dependency; installed only where openRealFdb() is
  // actually used (CI integration + production), so the package compiles + imports
  // fine without it.
  const fdb: FdbModule = await import('foundationdb');
  fdb.setAPIVersion(opts.apiVersion ?? 720);
  const db: FdbDatabase = opts.clusterFile ? fdb.open(opts.clusterFile) : fdb.open();

  const toBuf = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

  const wrapTxn = (tn: FdbTransaction): FdbTxn => ({
    get: async (key: Key) => {
      const v = await tn.get(toBuf(key));
      return v == null ? undefined : new Uint8Array(v);
    },
    set: (key, value) => { tn.set(toBuf(key), toBuf(value)); },
    clear: (key) => { tn.clear(toBuf(key)); },
    clearRange: (begin, end) => { tn.clearRange(toBuf(begin), toBuf(end)); },
    getRange: async (begin, end) => {
      const arr: FdbKeyValue[] = await tn.getRangeAll(toBuf(begin), toBuf(end));
      const out: KeyValue[] = [];
      for (const kv of arr) {
        // The binding may yield [key, value] tuples or {key, value} objects.
        const k = Array.isArray(kv) ? kv[0] : kv.key;
        const val = Array.isArray(kv) ? kv[1] : kv.value;
        out.push({ key: new Uint8Array(k), value: new Uint8Array(val) });
      }
      return out;
    },
  });

  return {
    // db.doTransaction is FDB's own retry-on-conflict loop.
    transact: <T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> =>
      db.doTransaction((tn) => fn(wrapTxn(tn))),
    close: async () => { db.close(); },
  };
}
