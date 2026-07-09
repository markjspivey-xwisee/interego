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

import type { FdbLike, FdbTxn, Key, KeyValue } from './fdb-like.js';

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

export async function openPgStore(opts: PgStoreOptions = {}): Promise<FdbLike> {
  // @ts-ignore optional dependency (pure-JS node-postgres), installed where used.
  const pg: any = await import('pg');
  const Pool = pg.Pool ?? pg.default?.Pool;
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
              const r = await client.query(`SELECT v FROM ${table} WHERE k = $1`, [buf(key)]);
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
            clear: (key: Key) => {
              pending.push(client.query(`DELETE FROM ${table} WHERE k = $1`, [buf(key)]));
            },
            clearRange: (begin: Key, end: Key) => {
              pending.push(client.query(`DELETE FROM ${table} WHERE k >= $1 AND k < $2`, [buf(begin), buf(end)]));
            },
            getRange: async (begin: Key, end: Key): Promise<KeyValue[]> => {
              await flush();
              const r = await client.query(
                `SELECT k, v FROM ${table} WHERE k >= $1 AND k < $2 ORDER BY k`,
                [buf(begin), buf(end)],
              );
              return r.rows.map((row: { k: Buffer; v: Buffer }) => ({
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
