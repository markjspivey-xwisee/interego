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
  /**
   * Write `value` at `key` ONLY IF the stored value is byte-identical to `expected` —
   * or, when `expected` is null, only if the key is absent. Resolves true if the write
   * will land with this transaction, false if the stored value did not match, in which
   * case NOTHING is written and the caller decides what to do.
   *
   * ★ WHY THIS EXISTS RATHER THAN `get` + `set`, WHICH LOOKS EQUIVALENT AND IS NOT.
   *
   * `get`-then-`set` is a compare-and-swap only where the transaction is serializable,
   * which is what `transact` below promises. `InMemoryFdb` and the real FDB binding keep
   * that promise. `openPgStore` deliberately does not — it runs READ COMMITTED, where a
   * plain SELECT takes no lock and is never re-validated at commit. Measured on
   * postgres:16: two transactions both SELECT v0, both pass their own version check, and
   * the second's `INSERT … ON CONFLICT DO UPDATE` overwrites the first. The relay's
   * engagement records lost turns exactly that way, with BOTH callers answered 200.
   *
   * Putting the expectation INSIDE the write is what fixes it: Postgres re-evaluates an
   * `UPDATE … WHERE` after it is granted the row lock, so the losing writer matches
   * nothing and reports 0 rows. Every implementation must provide this and there is
   * deliberately no default, so a new backend cannot silently inherit last-writer-wins.
   */
  compareAndSet(key: Key, expected: Value | null, value: Value): Promise<boolean>;
}

/**
 * Byte-for-byte equality, with null/undefined both meaning "absent".
 *
 * Shared so the two adapters that implement `compareAndSet` in JavaScript compare the
 * same way. `a === b` on two Uint8Arrays is object identity: it is false for a freshly
 * read buffer holding the same bytes, so a CAS written that way would refuse EVERY
 * write. That is a different outage, not a safer one.
 */
export function sameBytes(a: Value | undefined | null, b: Value | undefined | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
