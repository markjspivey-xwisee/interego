/**
 * PostgreSQL adapter for the FdbLike seam.
 *
 * Because the whole PGSL store is coded against `FdbLike`, swapping the durable
 * backend from FoundationDB to Postgres is a THIN adapter — every existing test
 * (compose, structural indexes, atom-granular ABAC, LDP CRUD, migration) runs
 * over it UNCHANGED. Postgres is the design's original recommendation: coherent,
 * transactional (SERIALIZABLE), multi-writer, MANAGED (no ops), runs on the
 * existing ACA topology (no AKS / no k8s networking), and cheap (Azure Postgres
 * Burstable ~$12-25/mo, or a free Neon/Supabase tier) — chosen after AKS+FDB
 * (~$220/mo) proved far over budget.
 *
 * Model: one table `kv(k bytea PRIMARY KEY, v bytea)`. The keyspace's
 * order-preserving byte keys are bytea PKs (Postgres compares bytea bytewise), so
 * `getRange` is an indexed `k >= begin AND k < end ORDER BY k` scan.
 *
 * Isolation = READ COMMITTED (with retry on the rare deadlock 40P01). NOT
 * SERIALIZABLE: the store never depends on cross-key serializability. Every write
 * is either content-addressed (the value is a pure function of the key, so two
 * writers of the same node/index row converge via `ON CONFLICT DO UPDATE` — the
 * `created`/`dedup` counts are best-effort stats, not invariants) or intentional
 * last-writer-wins (the mutable control-plane). Atomicity ("a reader never sees a
 * partial holon") comes from BEGIN..COMMIT, which holds at any isolation level.
 * Optimistic CAS that DOES matter (the CSS If-Match/ETag manifest update) is
 * serialized a layer up by the CSS resource locker (memory/Redis), not here.
 * SERIALIZABLE was over-strict for the LDP + notification workload: it flags
 * convergent concurrent writes to shared atoms / index rows / notification state
 * as read/write-dependency conflicts (40001), which under load exhaust retries and
 * surface as 500s (observed: the contract battery over real Postgres). READ
 * COMMITTED removes those false conflicts while preserving every real invariant.
 *
 * `pg` (node-postgres, pure JS — no native build) is loaded via dynamic import so
 * this package keeps zero hard runtime deps on it; install `pg` where
 * openPgStore() is actually used (deploy + CI).
 */

import type { FdbLike, FdbTxn, Key, KeyValue, Value } from './fdb-like.js';

export interface PgStoreOptions {
  /** e.g. postgres://user:pass@host:5432/db; omit to use PG* env vars. */
  connectionString?: string;
  /** Table name (default 'pgsl_kv'). */
  table?: string;
  /** Create the table if missing (default true). */
  ensureSchema?: boolean;
}

// deadlock_detected (rare under READ COMMITTED) + serialization_failure (kept for
// safety though READ COMMITTED does not raise it). Both are safe to retry whole.
const RETRYABLE = new Set(['40P01', '40001']);

/**
 * The slice of node-postgres this adapter uses.
 *
 * Declared rather than `any` for the same reason as `fdb-real.ts`: an optional dependency
 * has no resolvable `.d.ts` in a normal tree, but the eight calls made against it can still
 * be written down, and writing them down is what makes them checkable. `@ts-ignore` still
 * covers the unresolvable specifier on the import line and nothing after it.
 *
 * `query` is generic in the ROW so each call site names the columns it selected. Under
 * `any` both `r.rows[0].v` and `row.k` were unchecked, and a `SELECT v` whose reader asks
 * for `.value` — or a column rename in the `CREATE TABLE` above — produced `undefined`
 * passed to `new Uint8Array(undefined)`, i.e. an empty array where the stored bytes should
 * be. That is a silent-wrong-answer failure in the durable store, not a crash.
 */
interface PgModule {
  Pool?: PgPoolCtor;
  default?: { Pool?: PgPoolCtor };
}
type PgPoolCtor = new (config: { connectionString?: string }) => PgPool;
interface PgPool {
  connect(): Promise<PgClient>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}
interface PgClient {
  // `rowCount` is what makes a conditional write CHECKABLE: `UPDATE … WHERE v = $expected`
  // affects 1 row or 0, and 0 IS the refusal. Omitting it from this declared slice is how
  // the adapter ended up with only unconditional writes to offer. node-postgres types it
  // nullable (some commands report no count), so a caller must treat null as "not one row".
  query<R = never>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  release(): void;
}

export async function openPgStore(opts: PgStoreOptions = {}): Promise<FdbLike> {
  // @ts-ignore optional dependency (pure-JS node-postgres), installed where used.
  const pg: PgModule = await import('pg');
  const Pool = pg.Pool ?? pg.default?.Pool;
  // Both spellings are checked because `pg` ships CJS and the interop shape depends on how
  // the consumer's bundler wrapped it. If neither is there the install is broken, and
  // saying so beats `new undefined()`'s "Pool is not a constructor" — which is what the
  // `any` produced, from a line that mentions neither `pg` nor the install.
  if (!Pool) {
    throw new Error(
      "pgsl-store: the 'pg' module exports no Pool (neither pg.Pool nor pg.default.Pool). "
      + "Install node-postgres where openPgStore() is used.",
    );
  }
  const table = (opts.table ?? 'pgsl_kv').replace(/[^a-zA-Z0-9_]/g, '');
  const pool = new Pool(opts.connectionString ? { connectionString: opts.connectionString } : {});
  if (opts.ensureSchema !== false) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (k bytea PRIMARY KEY, v bytea NOT NULL)`);
  }
  const buf = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

  return {
    async transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
      const maxAttempts = 24;
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        const pending: Array<Promise<unknown>> = [];
        const flush = async (): Promise<void> => {
          if (pending.length) await Promise.all(pending.splice(0));
        };
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          const txn: FdbTxn = {
            get: async (key: Key) => {
              await flush();
              const r = await client.query<{ v: Buffer }>(
                `SELECT v FROM ${table} WHERE k = $1`, [buf(key)]);
              return r.rows[0] ? new Uint8Array(r.rows[0].v) : undefined;
            },
            set: (key: Key, value: Key) => {
              pending.push(
                client.query(
                  `INSERT INTO ${table}(k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
                  [buf(key), buf(value)],
                ),
              );
            },
            /**
             * ★ THE CONDITION IS IN THE STATEMENT, NOT IN AN EARLIER SELECT.
             *
             * This adapter runs READ COMMITTED (see the header), so a value returned by
             * `get` is not held against concurrent writers and is not re-checked at
             * commit. A caller that read v0, compared it, and then called `set` was
             * issuing an UNCONDITIONAL `INSERT … ON CONFLICT DO UPDATE`. Measured on
             * postgres:16: two overlapping transactions both landed, the second won, and
             * the first's engagement turn was gone while both callers were told 200.
             *
             * `UPDATE … WHERE k = $1 AND v = $3` is re-evaluated by Postgres AFTER the row
             * lock is granted — the losing writer blocks, wakes on the winner's COMMIT,
             * re-checks against the NEW row version, matches nothing, and reports 0 rows.
             * `ON CONFLICT DO NOTHING` does the same job for the create case, where there
             * is no row to lock: the loser's speculative insert waits on the winner's and
             * then does nothing.
             *
             * Buffered writes are flushed first for the same reason `get` flushes: this
             * statement must see this transaction's own earlier writes, or it would
             * compare against a row this transaction has already moved past.
             */
            compareAndSet: async (key: Key, expected: Value | null, value: Value): Promise<boolean> => {
              await flush();
              const r = expected === null
                ? await client.query(
                  `INSERT INTO ${table}(k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING`,
                  [buf(key), buf(value)])
                : await client.query(
                  `UPDATE ${table} SET v = $2 WHERE k = $1 AND v = $3`,
                  [buf(key), buf(value), buf(expected)]);
              return r.rowCount === 1;
            },
            clear: (key: Key) => {
              pending.push(client.query(`DELETE FROM ${table} WHERE k = $1`, [buf(key)]));
            },
            clearRange: (begin: Key, end: Key) => {
              pending.push(client.query(`DELETE FROM ${table} WHERE k >= $1 AND k < $2`, [buf(begin), buf(end)]));
            },
            getRange: async (begin: Key, end: Key, opts?: { readonly limit?: number }): Promise<KeyValue[]> => {
              await flush();
              // ★ THE BOUND GOES IN THE SQL, not around the result. Fetching every row and slicing
              // in the client bounds the RESPONSE and not the query — the scan, the transfer and the
              // memory are all still linear in the range, which is most of what makes an unbounded
              // read expensive at this layer.
              const lim = opts?.limit;
              const bounded = typeof lim === 'number' && Number.isFinite(lim) && lim > 0;
              const r = await client.query<{ k: Buffer; v: Buffer }>(
                `SELECT k, v FROM ${table} WHERE k >= $1 AND k < $2 ORDER BY k${bounded ? ' LIMIT $3' : ''}`,
                bounded ? [buf(begin), buf(end), Math.floor(lim)] : [buf(begin), buf(end)],
              );
              return r.rows.map(row => ({
                key: new Uint8Array(row.k),
                value: new Uint8Array(row.v),
              }));
            },
          };
          const result = await fn(txn);
          await flush();
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch { /* ignore */ }
          const code = (err as { code?: string }).code;
          if (code && RETRYABLE.has(code) && attempt < maxAttempts) {
            continue; // serialization conflict — retry the whole transaction
          }
          throw err;
        } finally {
          client.release();
        }
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
