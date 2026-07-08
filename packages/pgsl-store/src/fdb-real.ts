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

export async function openRealFdb(opts: FdbRealOptions = {}): Promise<FdbLike> {
  // A real dynamic import (a Function('return import()') escape hatch has no
  // import callback under a VM/vitest and throws ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
  // @ts-ignore optional native dependency; installed only where openRealFdb() is
  // actually used (CI integration + production), so the package compiles + imports
  // fine without it.
  const fdb: any = await import('foundationdb');
  fdb.setAPIVersion(opts.apiVersion ?? 720);
  const db: any = opts.clusterFile ? fdb.open(opts.clusterFile) : fdb.open();

  const toBuf = (u: Uint8Array): any => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

  const wrapTxn = (tn: any): FdbTxn => ({
    get: async (key: Key) => {
      const v = await tn.get(toBuf(key));
      return v == null ? undefined : new Uint8Array(v);
    },
    set: (key, value) => { tn.set(toBuf(key), toBuf(value)); },
    clear: (key) => { tn.clear(toBuf(key)); },
    clearRange: (begin, end) => { tn.clearRange(toBuf(begin), toBuf(end)); },
    getRange: async (begin, end) => {
      const arr: any[] = await tn.getRangeAll(toBuf(begin), toBuf(end));
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
      db.doTransaction((tn: any) => fn(wrapTxn(tn))),
    close: async () => { db.close(); },
  };
}
