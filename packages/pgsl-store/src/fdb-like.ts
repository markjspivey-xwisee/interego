/**
 * The minimal FoundationDB surface the PGSL store depends on.
 *
 * The store codes against THIS interface, never the `foundationdb` package
 * directly, so it can be:
 *   - unit-tested locally against an in-memory transactional fake (mem-fdb.ts) —
 *     no native client, no Docker;
 *   - run in production against the real `foundationdb` Node binding (a thin
 *     adapter, added when a running FDB is available), verified in CI on Linux.
 *
 * Keys and values are raw bytes; key order is bytewise (as in real FDB), which
 * is what our order-preserving keyspace encoding relies on.
 */

export type Key = Uint8Array;
export type Value = Uint8Array;

export interface KeyValue {
  key: Key;
  value: Value;
}

/** A transaction handle. All reads/writes are buffered and commit atomically. */
export interface FdbTxn {
  get(key: Key): Promise<Value | undefined>;
  set(key: Key, value: Value): void;
  clear(key: Key): void;
  /** Clear the half-open range [begin, end). */
  clearRange(begin: Key, end: Key): void;
  /** Read the half-open range [begin, end); results ascending by bytewise key. */
  getRange(begin: Key, end: Key): Promise<KeyValue[]>;
}

export interface FdbLike {
  /**
   * Run `fn` inside a transaction and commit atomically. On a serializable
   * conflict the implementation retries `fn` from scratch (so `fn` MUST be
   * idempotent / side-effect-free outside the txn).
   */
  transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
