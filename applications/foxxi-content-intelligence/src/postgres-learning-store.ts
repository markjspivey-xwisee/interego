/** Private transactional storage for Foxxi's operational learning state.
 * PGSL/pod evidence remains independently addressable; this database is the
 * durable authority for protocol state and retries, never a public pod dump.
 */
import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { serialize, deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { StoredStatement, StatementStore, QueryFilter, QueryResult } from './statement-store.js';
import { ConflictError, matchesFilter, paginate } from './statement-store.js';

export interface LearningSql {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
export const LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS foxxi_learning_statements (
 tenant text NOT NULL, id text NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY (tenant,id)
);
CREATE INDEX IF NOT EXISTS foxxi_learning_statements_stored ON foxxi_learning_statements (tenant, (record->>'stored'));
CREATE TABLE IF NOT EXISTS foxxi_learning_runtime (
 namespace text PRIMARY KEY, payload bytea NOT NULL, sha256 text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS foxxi_learning_outbox (
 tenant text NOT NULL, statement_id text NOT NULL,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant,statement_id),
 FOREIGN KEY (tenant,statement_id) REFERENCES foxxi_learning_statements(tenant,id)
);
`;

let pool: Pool | undefined;
let schemaReady: Promise<void> | undefined;
export function durableLearningEnabled(): boolean { return !!(process.env.FOXXI_LEARNING_DATABASE_URL || process.env.FOXXI_LEARNING_DB_HOST); }
function getPool(): Pool {
  if (!pool) {
    if (!durableLearningEnabled()) throw new Error('FOXXI_LEARNING_DATABASE_URL is required for durable learning');
    pool = new Pool({
      ...(process.env.FOXXI_LEARNING_DATABASE_URL ? { connectionString:process.env.FOXXI_LEARNING_DATABASE_URL } : {
        host:process.env.FOXXI_LEARNING_DB_HOST,port:Number(process.env.FOXXI_LEARNING_DB_PORT ?? '5432'),
        user:process.env.FOXXI_LEARNING_DB_USER,password:process.env.FOXXI_LEARNING_DB_PASSWORD,database:process.env.FOXXI_LEARNING_DB_NAME,
      }), max:8,connectionTimeoutMillis:10_000,statement_timeout:30_000,
    });
  }
  return pool;
}
export async function initializeLearningDatabase(): Promise<void> {
  if (!schemaReady) schemaReady = getPool().query(LEARNING_SCHEMA).then(() => undefined);
  await schemaReady;
}
export async function closeLearningDatabase():Promise<void> {
  await queue.catch(() => undefined);
  await pool?.end(); pool=undefined; schemaReady=undefined;
}
const active = new AsyncLocalStorage<{db:LearningSql;pending:Set<Promise<unknown>>;open:boolean}>();
export function trackLearningWork<T>(promise:Promise<T>):Promise<T> {
  const context=active.getStore();
  if (context?.open) {
    context.pending.add(promise);
    void promise.then(() => context.pending.delete(promise), () => undefined);
  }
  return promise;
}
async function sql(): Promise<LearningSql> {
  await initializeLearningDatabase();
  const context=active.getStore();
  if (context && !context.open) throw new Error('learning work escaped its committed transaction');
  return context?.db ?? getPool();
}

export class PostgresStatementStore implements StatementStore {
  constructor(readonly tenant: string, private readonly db: () => Promise<LearningSql> = sql) {}
  backendDescription(): string { return 'PostgreSQL (durable, tenant-partitioned; transactional forwarding outbox)'; }
  async put(record: StoredStatement): Promise<void> {
    const db = await this.db();
    // One SQL statement commits both the immutable record and its retry job.
    // An identical retry also recreates an absent job, repairing interrupted legacy delivery.
    const result = await db.query(`WITH accepted AS (
      INSERT INTO foxxi_learning_statements(tenant,id,record) VALUES($1,$2,$3::jsonb)
      ON CONFLICT(tenant,id) DO UPDATE SET record=foxxi_learning_statements.record
      WHERE ((foxxi_learning_statements.record->'statement') - 'stored' - 'authority')=((EXCLUDED.record->'statement') - 'stored' - 'authority')
      RETURNING tenant,id
    ), queued AS (
      INSERT INTO foxxi_learning_outbox(tenant,statement_id)
      SELECT tenant,id FROM accepted ON CONFLICT DO NOTHING
    ) SELECT id FROM accepted`, [this.tenant, record.id, JSON.stringify(record)]);
    if (!result.rows.length) throw new ConflictError(`statement ${record.id} already exists with a different body`);
  }
  async get(id: string): Promise<StoredStatement | null> {
    const result = await (await this.db()).query('SELECT record FROM foxxi_learning_statements WHERE tenant=$1 AND id=$2', [this.tenant, id]);
    return (result.rows[0]?.record as StoredStatement | undefined) ?? null;
  }
  async markVoided(id: string, voidingStatementId: string, onlyIf?: (target: StoredStatement) => boolean): Promise<boolean> {
    const db = await this.db();
    const rec = await this.get(id);
    if (!rec || (onlyIf && !onlyIf(rec))) return false;
    const changed: StoredStatement = { ...rec, voided: true, voidingStatementId };
    const result = await db.query(`UPDATE foxxi_learning_statements SET record=$3::jsonb
      WHERE tenant=$1 AND id=$2 AND record=$4::jsonb RETURNING id`, [this.tenant,id,JSON.stringify(changed),JSON.stringify(rec)]);
    return result.rows.length === 1;
  }
  async listAll(): Promise<StoredStatement[]> {
    const result = await (await this.db()).query('SELECT record FROM foxxi_learning_statements WHERE tenant=$1 ORDER BY id', [this.tenant]);
    return result.rows.map(row => row.record as StoredStatement);
  }
  async query(filter: QueryFilter): Promise<QueryResult> {
    if (filter.statementId || filter.voidedStatementId) {
      const rec = await this.get(filter.statementId ?? filter.voidedStatementId!);
      return { statements: rec && (filter.voidedStatementId ? rec.voided : !rec.voided) ? [rec] : [], more: null };
    }
    // Preserve the existing cursor/filter contract without an arbitrary scan ceiling.
    // SQL optimization must retain continuation-token filters and timestamp horizons.
    return paginate((await this.listAll()).filter(rec => !rec.voided && matchesFilter(rec,filter)), filter);
  }
  async count(): Promise<number> {
    const result = await (await this.db()).query('SELECT count(*) AS n FROM foxxi_learning_statements WHERE tenant=$1', [this.tenant]);
    return Number(result.rows[0]?.n ?? 0);
  }
  async clear(): Promise<void> {
    if (process.env.NODE_ENV === 'production') throw new Error('test clear is disabled in production');
    const db = await this.db();
    await db.query('DELETE FROM foxxi_learning_outbox WHERE tenant=$1', [this.tenant]);
    await db.query('DELETE FROM foxxi_learning_statements WHERE tenant=$1', [this.tenant]);
  }
}

type RuntimeState = { collect: () => unknown; restore: (value: unknown) => void };
const runtime = new Map<string, RuntimeState>();
export function registerLearningState(namespace: string, state: RuntimeState): void { runtime.set(namespace, state); }
export function registerLearningMap<K,V>(namespace: string, map: Map<K,V>): void {
  registerLearningState(namespace, {
    collect: () => map,
    restore: value => {
      if (!(value instanceof Map)) throw new Error(`invalid durable state for ${namespace}`);
      map.clear(); for (const [key,item] of value) map.set(key as K,item as V);
    },
  });
}
export function registerLearningPartition<T>(namespace: string, partition: {
  all(): Array<[string,T]>; restore(entries: Array<[string,T]>): void;
}): void {
  registerLearningState(namespace, {
    collect: () => partition.all(),
    restore: value => {
      if (!Array.isArray(value)) throw new Error(`invalid durable state for ${namespace}`);
      partition.restore(value as Array<[string,T]>);
    },
  });
}

/** The binary codec preserves Maps, Sets, Buffers, cycles and shared tree references.
 * This is PRIVATE operational storage, not an interchange format or a public graph.
 */
export async function restoreLearningState(db: LearningSql): Promise<Map<string,string>> {
  const rows = await db.query('SELECT namespace,payload,sha256 FROM foxxi_learning_runtime');
  const hashes = new Map<string,string>();
  for (const row of rows.rows) {
    const name = String(row.namespace), state = runtime.get(name);
    if (!state) continue;
    const bytes = Buffer.from(row.payload as Uint8Array);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== row.sha256) throw new Error(`durable learning state integrity failure: ${name}`);
    state.restore(deserialize(bytes)); hashes.set(name,hash);
  }
  return hashes;
}
export async function saveLearningState(db: LearningSql, hashes = new Map<string,string>()): Promise<void> {
  for (const [name,state] of runtime) {
    const bytes = serialize(state.collect()), hash = createHash('sha256').update(bytes).digest('hex');
    if (hashes.get(name) === hash) continue;
    await db.query(`INSERT INTO foxxi_learning_runtime(namespace,payload,sha256) VALUES($1,$2,$3)
      ON CONFLICT(namespace) DO UPDATE SET payload=EXCLUDED.payload,sha256=EXCLUDED.sha256,updated_at=now()`, [name,bytes,hash]);
  }
}

let queue: Promise<unknown> = Promise.resolve();
/** Single ordered learning transaction, including the LRS, runtime and retry queue.
 * The advisory lock protects concurrent replicas; each operation reloads durable
 * state under that lock. No success is returned before the database commit.
 */
export async function withLearningTransaction<T>(work: () => Promise<T>): Promise<T> {
  if (!durableLearningEnabled() || active.getStore()) return work();
  const run = async (): Promise<T> => {
    await initializeLearningDatabase();
    const client: PoolClient = await getPool().connect();
    let before = new Map<string,Buffer>();
    let context:{db:LearningSql;pending:Set<Promise<unknown>>;open:boolean}|undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('foxxi-learning-runtime-v1',0))");
      const hashes = await restoreLearningState(client);
      before = new Map([...runtime].map(([name,state]) => [name,serialize(state.collect())]));
      const current={db:client,pending:new Set<Promise<unknown>>(),open:true}; context=current;
      return await active.run(current, async () => {
        const result = await work();
        while (current.pending.size) await Promise.all([...current.pending]);
        await saveLearningState(client, hashes);
        await client.query('COMMIT');
        current.open=false;
        return result;
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      for (const [name,bytes] of before) runtime.get(name)?.restore(deserialize(bytes));
      throw err;
    } finally { if(context) context.open=false; client.release(); }
  };
  const next = queue.then(run,run); queue = next.catch(() => undefined); return next;
}

/** Buffer ordinary protocol responses until the operation's state is committed.
 * MCP's long-lived streams use withLearningTransaction around their handlers.
 */
export const durableLearningMiddleware: RequestHandler = (req,res,next) => {
  if (!durableLearningEnabled() || req.path === '/mcp' || req.path === '/health' || req.method === 'OPTIONS') { next(); return; }
  const originalEnd = res.end.bind(res), originalWrite = res.write.bind(res), originalFlush = res.flushHeaders.bind(res);
  const chunks: Buffer[] = [];
  let bytes = 0, finish: (() => void) | undefined;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  let ended = false;
  res.flushHeaders = () => undefined;
  res.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    const part = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined) : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > 32*1024*1024) throw new Error('learning response exceeds buffer limit');
    chunks.push(part); (typeof encoding === 'function' ? encoding : callback)?.(); return true;
  }) as typeof res.write;
  res.end = ((chunk?: string | Uint8Array, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk !== undefined && chunk !== null) { if (typeof encoding === 'string') res.write(chunk, encoding); else res.write(chunk); }
    ended = true; finish?.(); (typeof encoding === 'function' ? encoding : callback)?.(); return res;
  }) as typeof res.end;
  const disconnected = (): void => { if (!ended) { finish?.(); } };
  req.once('aborted',disconnected); res.once('close',disconnected);
  void withLearningTransaction(async () => { next(); await completed; }).then(() => {
    res.write = originalWrite; res.end = originalEnd; res.flushHeaders = originalFlush;
    req.removeListener('aborted',disconnected); res.removeListener('close',disconnected);
    if (!res.destroyed) originalEnd(Buffer.concat(chunks));
  }, () => {
    res.write = originalWrite; res.end = originalEnd; res.flushHeaders = originalFlush;
    if (!res.destroyed && !res.headersSent) {
      for (const header of res.getHeaderNames()) res.removeHeader(header);
      res.statusCode = 503; res.setHeader('Content-Type','application/json');
      originalEnd(JSON.stringify({ error:'durable learning storage unavailable; operation not acknowledged' }));
    } else res.destroy();
  });
};

/** At-least-once worker. Work and deletion share the runtime/LRS transaction.
 * No target configured means keep pending, never silently discard a delivery.
 */
export async function drainLearningOutbox(deliver: (tenant: string, statement: Record<string,unknown>) => Promise<boolean>, limit = 25): Promise<number> {
  return withLearningTransaction(async () => {
    const db = await sql();
    const jobs = await db.query(`SELECT o.tenant,o.statement_id,s.record FROM foxxi_learning_outbox o
      JOIN foxxi_learning_statements s ON s.tenant=o.tenant AND s.id=o.statement_id
      WHERE next_attempt_at<=now() ORDER BY next_attempt_at LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [limit]);
    let delivered = 0;
    for (const job of jobs.rows) {
      const ok = await deliver(String(job.tenant),(job.record as StoredStatement).statement);
      if (ok) { await db.query('DELETE FROM foxxi_learning_outbox WHERE tenant=$1 AND statement_id=$2',[job.tenant,job.statement_id]); delivered++; }
      else await db.query("UPDATE foxxi_learning_outbox SET attempts=attempts+1,next_attempt_at=now()+interval '30 seconds' WHERE tenant=$1 AND statement_id=$2",[job.tenant,job.statement_id]);
    }
    return delivered;
  });
}
