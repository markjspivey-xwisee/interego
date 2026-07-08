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
 * `getRange` is an indexed `k >= begin AND k < end ORDER BY k` scan. Each
 * transaction is a SERIALIZABLE Postgres transaction with retry on
 * serialization_failure (40001) / deadlock (40P01) — that is what gives the
 * two-writer convergence + all-or-nothing atomicity the store relies on.
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

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

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
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
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
