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
  /** Opt-in physical database ceiling; env PGSL_PG_MAX_DATABASE_BYTES. */
  maxDatabaseBytes?: number;
  /** Cumulative positive k+v plus replaced-value bound (default 256 MiB when enabled). */
  maxTransactionInputBytes?: number;
  /** Additional physical headroom (default 64 MiB when enabled). */
  writeReserveBytes?: number;
}

/** A refused write never commits any part of its transaction. Reads and deletes remain available. */
export class PgWritePressureError extends Error {
  readonly code = 'PGSL_WRITE_PRESSURE';
  constructor(message: string) {
    super(`pgsl-store: write refused: ${message}`);
    this.name = 'PgWritePressureError';
  }
}

interface WritePressure {
  maximum: number;
  inputMaximum: number;
  reserve: number;
}

function byteLimit(value: number | string | undefined, name: string, zero = false): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`pgsl-store: ${name} must be a safe integer byte count`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (zero ? 0 : 1)) {
    throw new Error(`pgsl-store: ${name} must be a safe ${zero ? 'nonnegative' : 'positive'} integer byte count`);
  }
  return parsed;
}

function writePressure(opts: PgStoreOptions): WritePressure | undefined {
  const maximum = byteLimit(opts.maxDatabaseBytes ?? process.env.PGSL_PG_MAX_DATABASE_BYTES, 'PGSL_PG_MAX_DATABASE_BYTES');
  const inputMaximum = byteLimit(opts.maxTransactionInputBytes ?? process.env.PGSL_PG_MAX_TRANSACTION_INPUT_BYTES,
    'PGSL_PG_MAX_TRANSACTION_INPUT_BYTES') ?? 256 * 1024 * 1024;
  const reserve = byteLimit(opts.writeReserveBytes ?? process.env.PGSL_PG_WRITE_RESERVE_BYTES,
    'PGSL_PG_WRITE_RESERVE_BYTES', true) ?? 64 * 1024 * 1024;
  if (maximum === undefined) return undefined;
  if (reserve >= maximum) throw new Error('pgsl-store: write reserve must be smaller than the database ceiling');
  return { maximum, inputMaximum, reserve };
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
  query<R = never>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null; command: string }>;
  release(): void;
}

export async function openPgStore(opts: PgStoreOptions = {}): Promise<FdbLike> {
  const pressure = writePressure(opts);
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

  return {
    async transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
      const maxAttempts = 24;
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        // Queue SQL, rather than starting it in set(): admission must run BEFORE a
        // positive write. Serial flushing also preserves read-your-own-writes.
        const pending: Array<() => Promise<unknown>> = [];
        let flushing: Promise<void> = Promise.resolve();
        let inputBytes = 0;
        let positiveOperations = 0;
        let admission: Promise<number> | undefined;
        let mutationLock: Promise<void> | undefined;
        let refusal: PgWritePressureError | undefined;
        const planPositive = (key: Key, value: Value): void => {
          if (!pressure) return;
          if (refusal) throw refusal;
          // Even an empty key/value consumes one operation's finite input budget.
          inputBytes += Math.max(1, key.byteLength + value.byteLength);
          positiveOperations++;
          if (!Number.isSafeInteger(inputBytes) || inputBytes > pressure.inputMaximum || positiveOperations > 1_048_576) {
            refusal ??= new PgWritePressureError('transaction input or 1048576-operation bound exceeded');
            throw refusal;
          }
        };
        const databaseBytes = async (): Promise<number> => {
          const result = await client.query<{ bytes: string }>(
            'SELECT pg_database_size(current_database())::text AS bytes');
          const size = Number(result.rows[0]?.bytes);
          if (!Number.isSafeInteger(size) || size < 0) {
            throw new PgWritePressureError('physical database size is unavailable');
          }
          return size;
        };
        const checkPressure = (size: number): void => {
          if (refusal) throw refusal;
          if (!pressure) return;
          // Opaque atoms base64-expand the representation. Reserve beyond raw
          // k+v for heap/TOAST/index allocation and WAL; this is conservative
          // admission headroom, not an assertion that WAL has a fixed ratio.
          const required = pressure.reserve + inputBytes * 4 + positiveOperations * 8192;
          if (!Number.isSafeInteger(required) || size > pressure.maximum - required) {
            refusal ??= new PgWritePressureError('physical database ceiling or write reserve reached');
            throw refusal;
          }
        };
        const lockMutation = (): Promise<void> => {
          if (!pressure) return Promise.resolve();
          // Lock-only CAS may precede a positive write in the same transaction.
          // Preserve lock ordering without applying a physical growth check.
          mutationLock ??= client.query(
            'SELECT pg_advisory_xact_lock(1346851660, hashtext(current_database()))',
          ).then(() => undefined);
          return mutationLock;
        };
        const admit = async (): Promise<void> => {
          if (!pressure || positiveOperations === 0) return;
          if (refusal) throw refusal;
          admission ??= (async () => {
            // Same database-wide transaction lock across tables, pools, and
            // replicas. It is released only by COMMIT/ROLLBACK, never before
            // the fresh final physical-size check.
            await lockMutation();
            return databaseBytes();
          })();
          checkPressure(await admission);
        };
        const reserveExisting = async (key: Buffer): Promise<void> => {
          if (!pressure) return;
          // Retirement triggers can copy OLD.v into a rollback journal. Count
          // its uncompressed byte length too, without loading its payload.
          const prior = await client.query<{ bytes: number }>(
            `SELECT octet_length(v) AS bytes FROM ${table} WHERE k = $1 FOR UPDATE`, [key]);
          const retiredBytes = prior.rows.length === 0 ? 0 : prior.rows[0]?.bytes;
          if (typeof retiredBytes !== 'number' || !Number.isSafeInteger(retiredBytes) || retiredBytes < 0) {
            refusal ??= new PgWritePressureError('replaced value size is unavailable');
            throw refusal;
          }
          inputBytes += retiredBytes;
          if (!Number.isSafeInteger(inputBytes) || inputBytes > pressure.inputMaximum) {
            refusal ??= new PgWritePressureError('transaction input including replaced values exceeds its byte bound');
            throw refusal;
          }
          await admit();
        };
        const flush = (): Promise<void> => {
          const operations = pending.splice(0);
          flushing = flushing.then(async () => {
            await admit();
            for (const operation of operations) await operation();
          });
          return flushing;
        };
        try {
          await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
          const txn: FdbTxn = {
            get: async (key: Key) => {
              const capturedKey = Buffer.from(key);
              await flush();
              const r = await client.query<{ v: Buffer }>(
                `SELECT v FROM ${table} WHERE k = $1`, [capturedKey]);
              return r.rows[0] ? new Uint8Array(r.rows[0].v) : undefined;
            },
            set: (key: Key, value: Key) => {
              const capturedKey = Buffer.from(key), capturedValue = Buffer.from(value);
              planPositive(capturedKey, capturedValue);
              pending.push(async () => {
                await reserveExisting(capturedKey);
                return client.query(
                  `INSERT INTO ${table}(k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
                  [capturedKey, capturedValue]);
              });
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
              const capturedKey = Buffer.from(key), capturedValue = Buffer.from(value);
              const capturedExpected = expected === null ? null : Buffer.from(expected);
              if (capturedExpected !== null && capturedExpected.equals(capturedValue)) {
                await lockMutation();
                await flush();
                // READ COMMITTED rechecks the predicate after waiting. A proof
                // needs a row lock, not a replacement tuple or retirement journal.
                const proof = await client.query(
                  `SELECT 1 FROM ${table} WHERE k = $1 AND v = $2 FOR UPDATE`,
                  [capturedKey, capturedExpected],
                );
                return proof.rowCount === 1;
              }
              planPositive(capturedKey, capturedValue);
              await flush();
              await reserveExisting(capturedKey);
              const r = capturedExpected === null
                ? await client.query(
                  `INSERT INTO ${table}(k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING`,
                  [capturedKey, capturedValue])
                : await client.query(
                  `UPDATE ${table} SET v = $2 WHERE k = $1 AND v = $3`,
                  [capturedKey, capturedValue, capturedExpected]);
              return r.rowCount === 1;
            },
            clear: (key: Key) => {
              const capturedKey = Buffer.from(key);
              pending.push(() => client.query(`DELETE FROM ${table} WHERE k = $1`, [capturedKey]));
            },
            clearRange: (begin: Key, end: Key) => {
              const capturedBegin = Buffer.from(begin), capturedEnd = Buffer.from(end);
              pending.push(() => client.query(`DELETE FROM ${table} WHERE k >= $1 AND k < $2`, [capturedBegin, capturedEnd]));
            },
            getRange: async (begin: Key, end: Key, opts?: { readonly limit?: number }): Promise<KeyValue[]> => {
              const capturedBegin = Buffer.from(begin), capturedEnd = Buffer.from(end);
              const lim = opts?.limit;
              await flush();
              // ★ THE BOUND GOES IN THE SQL, not around the result. Fetching every row and slicing
              // in the client bounds the RESPONSE and not the query — the scan, the transfer and the
              // memory are all still linear in the range, which is most of what makes an unbounded
              // read expensive at this layer.
              const bounded = typeof lim === 'number' && Number.isFinite(lim) && lim > 0;
              const r = await client.query<{ k: Buffer; v: Buffer }>(
                `SELECT k, v FROM ${table} WHERE k >= $1 AND k < $2 ORDER BY k${bounded ? ' LIMIT $3' : ''}`,
                bounded ? [capturedBegin, capturedEnd, Math.floor(lim)] : [capturedBegin, capturedEnd],
              );
              return r.rows.map(row => ({
                key: new Uint8Array(row.k),
                value: new Uint8Array(row.v),
              }));
            },
            /**
             * A loose index scan in ONE statement: each recursive step is one primary-key probe for
             * the first key past the previous row's group — the next key for a row with no separator,
             * strinc(group) for a group (the separator becomes separator + 1, which never carries).
             * The row counter bounds the recursion itself, so `limit` bounds the work and not only
             * the result, and the outer ORDER BY is over at most `limit` rows. Values are sent only
             * for rows callers read (see fdb-like.ts); the rest come back empty.
             */
            firstPerSegment: async (
              start: Key, end: Key,
              opts: { readonly segmentOffset: number; readonly separator: number; readonly limit: number },
            ): Promise<KeyValue[]> => {
              const { segmentOffset, separator, limit } = opts;
              if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('pgsl-store: firstPerSegment needs a positive integer limit');
              if (!Number.isSafeInteger(segmentOffset) || segmentOffset < 0) throw new RangeError('pgsl-store: firstPerSegment needs a nonnegative integer segmentOffset');
              if (!Number.isInteger(separator) || separator < 0 || separator > 0xfe) throw new RangeError('pgsl-store: firstPerSegment separator must be a byte below 0xff');
              const capturedStart = Buffer.from(start), capturedEnd = Buffer.from(end);
              await flush();
              const r = await client.query<{ k: Buffer; v: Buffer | null }>(
                `WITH RECURSIVE walk(k, v, n) AS (
                  (SELECT k, v, 1 FROM ${table} WHERE k >= $1::bytea AND k < $2::bytea ORDER BY k LIMIT 1)
                  UNION ALL
                  SELECT nx.k, nx.v, w.n + 1 FROM walk w
                  CROSS JOIN LATERAL (SELECT position($4::bytea IN substring(w.k FROM $3::int + 1)) AS s) p
                  CROSS JOIN LATERAL (
                    SELECT t.k, t.v FROM ${table} t
                    WHERE t.k >= CASE WHEN p.s = 0 THEN w.k || '\\x00'::bytea
                                      ELSE substring(w.k FROM 1 FOR $3::int + p.s - 1) || $5::bytea END
                      AND t.k < $2::bytea
                    ORDER BY t.k LIMIT 1) nx
                  WHERE w.n < $6::int
                )
                SELECT k, CASE WHEN position($4::bytea IN substring(k FROM $3::int + 1)) IN (0, octet_length(k) - $3::int)
                               THEN v END AS v
                FROM walk ORDER BY k`,
                [capturedStart, capturedEnd, segmentOffset, Buffer.of(separator), Buffer.of(separator + 1), limit],
              );
              return r.rows.map(row => ({
                key: new Uint8Array(row.k),
                value: row.v === null ? new Uint8Array(0) : new Uint8Array(row.v),
              }));
            },
          };
          const result = await fn(txn);
          await flush();
          if (pressure && positiveOperations > 0) checkPressure(await databaseBytes());
          const committed = await client.query('COMMIT');
          // A callback can catch a SQL error while PostgreSQL leaves BEGIN aborted.
          // In that state COMMIT succeeds as a command tagged ROLLBACK, not a commit.
          if (committed.command !== 'COMMIT') throw new Error('pgsl-store: transaction did not commit');
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
