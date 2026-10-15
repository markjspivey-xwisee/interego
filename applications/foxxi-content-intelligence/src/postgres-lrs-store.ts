/**
 * Durable, tenant-isolated xAPI storage. PostgreSQL is the source of truth;
 * decrypted records are never retained in a process-local cache. Every successful
 * mutation has committed with synchronous_commit=on. Private payloads (including
 * document keys and attachment bytes) use authenticated encryption at rest.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ConflictError, cursorQueryOf, decodeCursor, encodeCursor, matchesFilter,
  type CursorQuery, type QueryFilter, type QueryResult, type StatementStore, type StoredStatement,
} from './statement-store.js';
import { utcTimestamp, validateAgentObject } from './xapi-validate.js';
import { RFC3339_UTC_TIMESTAMP } from './spec/patterns.js';

interface PgResult<R> { rows: R[]; rowCount: number | null; }
export interface LrsPgClient {
  query<R = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<R>>;
  release(): void;
}
export interface LrsPgPool {
  query<R = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgResult<R>>;
  connect(): Promise<LrsPgClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: () => void): void;
}
interface PgModule { Pool?: new (options: {
  connectionString: string; max: number; connectionTimeoutMillis: number;
  idleTimeoutMillis: number; query_timeout: number; statement_timeout: number;
}) => LrsPgPool; default?: PgModule; }
export interface PostgresLrsOptions {
  connectionString: string;
  /** Stable operator-held secret; never log it or fall back to a generated key. */
  encryptionKey: string | Uint8Array;
  /** Injection seam for transport-failure tests, never supplied by HTTP callers. */
  pool?: LrsPgPool;
  /** Destructive clear is available only to explicitly configured test databases. */
  allowClear?: boolean;
}
export interface LrsAttachment { data: Buffer; contentType: string; }
interface EncryptedRow { record_id: string; payload: Buffer; stored_at: string | Date | null; voided: boolean; }
interface StatementRow extends EncryptedRow { stored_at: string | Date; revision: string; }
interface PgCursor { offset: number; pgRevision: string; pgScanned: number; pgAfterStored: string; pgAfterKey: string; q: CursorQuery; }
const TABLE = 'foxxi_lrs_records';
const TENANTS = 'foxxi_lrs_tenants';
const METADATA = 'foxxi_lrs_metadata';
const BATCH = 256;
const KEY_CONTEXT = 'interego/foxxi/lrs/postgres/v1';
const REGISTRY_CONTEXT = `${KEY_CONTEXT}/tenant-registry`;
const UTC_TIMESTAMP = new RegExp(RFC3339_UTC_TIMESTAMP);

// A tagged tree preserves binary State/Profile documents without confusing a
// caller's ordinary JSON `{type:'Buffer',data:[...]}` with actual binary data.
function encodeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return ['bytes', value.toString('base64')];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['value', value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['value', value];
  if (Array.isArray(value)) return ['array', value.map(encodeValue)];
  if (typeof value === 'object' && value !== null) {
    return ['object', Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, encodeValue(item)])];
  }
  throw new Error('LRS storage requires finite JSON values or binary documents');
}
function decodeValue(encoded: unknown): unknown {
  if (!Array.isArray(encoded) || encoded.length !== 2) throw new Error('invalid LRS value encoding');
  const [kind, value] = encoded as [unknown, unknown];
  if (kind === 'bytes' && typeof value === 'string') return Buffer.from(value, 'base64');
  if (kind === 'value' && (value === null || ['string', 'number', 'boolean'].includes(typeof value))) return value;
  if (kind === 'array' && Array.isArray(value)) return value.map(decodeValue);
  if (kind === 'object' && Array.isArray(value)) return Object.fromEntries(value.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error('invalid LRS object encoding');
    return [entry[0], decodeValue(entry[1])];
  }));
  throw new Error('invalid LRS value encoding');
}
function immutableBody(statement: Record<string, unknown>): string {
  const value = { ...statement };
  delete value.stored;
  delete value.authority;
  return JSON.stringify(value);
}
function bounded(value: string, label: string, max: number): void {
  if (!value || value.length > max || value.includes('\0')) throw new Error(`invalid LRS ${label}`);
}
export class InvalidLrsQueryError extends Error {
  readonly status = 400;
  constructor(message = 'invalid LRS query') { super(message); this.name = 'InvalidLrsQueryError'; }
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}
function checkedQuery(value: unknown): CursorQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidLrsQueryError();
  const q = value as Record<string, unknown>;
  if (Object.keys(q).some(key => !['agent', 'verb', 'activity', 'registration', 'since', 'until', 'ascending', 'limit'].includes(key))) {
    throw new InvalidLrsQueryError();
  }
  if (q.limit !== undefined && (typeof q.limit !== 'number' || !Number.isSafeInteger(q.limit) || q.limit < 0)) throw new InvalidLrsQueryError();
  if (q.ascending !== undefined && typeof q.ascending !== 'boolean') throw new InvalidLrsQueryError();
  for (const key of ['verb', 'activity']) {
    const field = q[key];
    if (field !== undefined && (typeof field !== 'string' || field.length > 8192 || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(field))) {
      throw new InvalidLrsQueryError();
    }
  }
  if (q.registration !== undefined && (typeof q.registration !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(q.registration))) throw new InvalidLrsQueryError();
  for (const key of ['since', 'until']) {
    const field = q[key];
    if (field !== undefined && (typeof field !== 'string' || field.length > 128
      || !UTC_TIMESTAMP.test(utcTimestamp(field)) || !Number.isFinite(Date.parse(utcTimestamp(field))))) throw new InvalidLrsQueryError();
  }
  if (q.agent !== undefined && (typeof q.agent !== 'object' || q.agent === null || Array.isArray(q.agent)
    || JSON.stringify(q.agent).length > 8192 || validateAgentObject(q.agent).length)) throw new InvalidLrsQueryError();
  const result = cursorQueryOf(q as CursorQuery);
  // xAPI limit=0 requests the implementation maximum; it does not disable the cap.
  result.limit = q.limit === 0 ? 500 : Math.min(q.limit as number | undefined ?? 100, 500);
  result.ascending = q.ascending === true;
  return result;
}

export class PostgresLrsDatabase {
  private readonly rootKey: Buffer;
  private readonly indexKey: Buffer;
  private readonly poolPromise: Promise<LrsPgPool>;
  private schemaPromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: PostgresLrsOptions) {
    const secret = typeof options.encryptionKey === 'string'
      ? Buffer.from(options.encryptionKey, 'utf8') : Buffer.from(options.encryptionKey);
    if (secret.length < 32) throw new Error('durable LRS requires a stable encryption key of at least 32 bytes');
    if (!options.connectionString && !options.pool) throw new Error('durable LRS requires a PostgreSQL connection string');
    this.rootKey = Buffer.from(hkdfSync('sha256', secret, KEY_CONTEXT, 'payload', 32));
    this.indexKey = Buffer.from(hkdfSync('sha256', secret, KEY_CONTEXT, 'index', 32));
    // Delay loading the optional driver until the configured durable backend is used.
    this.poolPromise = options.pool ? Promise.resolve(options.pool) : this.openPool();
    // A rejected lazy driver load must still be observed before the first operation.
    void this.poolPromise.catch(() => undefined);
  }

  private async openPool(): Promise<LrsPgPool> {
    const moduleName = 'pg';
    const pg = await import(moduleName) as PgModule;
    const Pool = pg.Pool ?? pg.default?.Pool;
    if (!Pool) throw new Error('durable LRS requires the PostgreSQL pg driver');
    const pool = new Pool({ connectionString: this.options.connectionString, max: 6,
      connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, query_timeout: 15_000, statement_timeout: 10_000 });
    pool.on?.('error', () => {
      // Never log driver errors: they can contain connection details or SQL values.
      process.stderr.write('[durable-lrs] idle PostgreSQL connection failed\n');
    });
    return pool;
  }

  async ready(): Promise<void> {
    if (this.closed) throw new Error('durable LRS database is closed');
    if (!this.schemaPromise) {
      this.schemaPromise = (async () => {
        const pool = await this.poolPromise;
        await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
          tenant_key text NOT NULL,
          kind text NOT NULL,
          record_id text NOT NULL,
          payload bytea NOT NULL,
          stored_at timestamptz,
          voided boolean NOT NULL DEFAULT false,
          revision bigint GENERATED ALWAYS AS IDENTITY,
          PRIMARY KEY (tenant_key, kind, record_id)
        )`);
        await pool.query(`CREATE INDEX IF NOT EXISTS foxxi_lrs_statement_page ON ${TABLE}
          (tenant_key, kind, stored_at, record_id)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${TENANTS} (
          tenant_key text PRIMARY KEY,
          encrypted_name bytea NOT NULL
        )`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${METADATA} (id text PRIMARY KEY,verification bytea NOT NULL)`);
        // HMAC indexes intentionally conceal tenant names. Without this check,
        // accidentally changing the key would make old rows look absent and
        // let a new deployment fork an apparently empty history.
        await pool.query(`INSERT INTO ${METADATA} (id,verification) VALUES ('encryption-v1',$1)
          ON CONFLICT (id) DO NOTHING`, [this.seal(REGISTRY_CONTEXT, 'key-check', 'v1', 'foxxi-lrs-encryption-v1')]);
        const check = await pool.query<{ verification: Buffer }>(`SELECT verification FROM ${METADATA} WHERE id='encryption-v1'`);
        try {
          if (!check.rows[0] || this.open(REGISTRY_CONTEXT, 'key-check', 'v1', check.rows[0].verification) !== 'foxxi-lrs-encryption-v1') {
            throw new Error('key mismatch');
          }
        } catch {
          throw new Error('durable LRS encryption key does not match this database; restore the stable key before serving requests');
        }
      })();
    }
    const pending = this.schemaPromise;
    try { await pending; }
    catch (error) {
      if (this.schemaPromise === pending) this.schemaPromise = undefined;
      throw error;
    }
  }

  forTenant(tenant: string): PostgresLrsStore {
    bounded(tenant, 'tenant', 8192);
    return new PostgresLrsStore(this, tenant);
  }

  tenantKey(tenant: string): string {
    return createHmac('sha256', this.indexKey).update(tenant).digest('hex');
  }
  recordKey(tenant: string, kind: string, id: string): string {
    bounded(kind, 'record kind', 64);
    bounded(id, 'record ID', 65_536);
    return createHmac('sha256', this.indexKey).update(JSON.stringify([tenant, kind, id])).digest('hex');
  }
  continuationSignature(tenant: string, cursor: PgCursor): string {
    return createHmac('sha256', this.indexKey).update(JSON.stringify([`${KEY_CONTEXT}/cursor`, tenant, stableJson(cursor)])).digest('hex');
  }
  private payloadKey(tenant: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.rootKey, KEY_CONTEXT, tenant, 32));
  }
  seal(tenant: string, kind: string, id: string, value: unknown): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.payloadKey(tenant), nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([KEY_CONTEXT, tenant, kind, id])));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(encodeValue(value)), 'utf8')), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  }
  open<T>(tenant: string, kind: string, id: string, bytes: Buffer): T {
    if (bytes.length < 30 || bytes[0] !== 1) throw new Error('invalid encrypted LRS record');
    const cipher = createDecipheriv('aes-256-gcm', this.payloadKey(tenant), bytes.subarray(1, 13));
    cipher.setAAD(Buffer.from(JSON.stringify([KEY_CONTEXT, tenant, kind, id])));
    cipher.setAuthTag(bytes.subarray(13, 29));
    return decodeValue(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8'))) as T;
  }

  async query<R>(sql: string, values: readonly unknown[]): Promise<PgResult<R>> {
    await this.ready();
    return (await this.poolPromise).query<R>(sql, values);
  }

  async transaction<R>(work: (client: LrsPgClient) => Promise<R>): Promise<R> {
    await this.ready();
    const client = await (await this.poolPromise).connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = on');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async lock(client: LrsPgClient, tenant: string, kind: string, id: string): Promise<void> {
    // Transaction-scoped locks also serialize create-if-absent resources, which
    // SELECT FOR UPDATE alone cannot protect when no row exists yet.
    const digest = createHash('sha256').update(JSON.stringify([tenant, kind, id])).digest();
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [digest.readBigInt64BE(0).toString()]);
  }
  async registerTenant(client: LrsPgClient, tenant: string): Promise<void> {
    // The same transaction contains the registry entry and its first durable
    // resource. Anonymous reads and creating a lightweight view register nothing.
    await this.lock(client, tenant, 'tenant-registry', 'entry');
    const index = this.tenantKey(tenant);
    await client.query(`INSERT INTO ${TENANTS} (tenant_key,encrypted_name) VALUES ($1,$2)
      ON CONFLICT (tenant_key) DO NOTHING`, [index, this.seal(REGISTRY_CONTEXT, 'tenant', index, tenant)]);
  }
  async listTenantPage(options: { limit?: number; cursor?: string } = {}): Promise<{ tenants: string[]; more: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    if (!Number.isSafeInteger(limit) || (options.cursor && !/^[a-f0-9]{64}$/.test(options.cursor))) {
      throw new Error('invalid durable LRS tenant page');
    }
    const result = await this.query<{ tenant_key: string; encrypted_name: Buffer }>(
      `SELECT tenant_key,encrypted_name FROM ${TENANTS}
        WHERE ($1::text IS NULL OR tenant_key>$1) ORDER BY tenant_key LIMIT $2`, [options.cursor ?? null, limit + 1]);
    const page = result.rows.slice(0, limit);
    const tenants = page.map(row => {
      const name = this.open<string>(REGISTRY_CONTEXT, 'tenant', row.tenant_key, row.encrypted_name);
      if (typeof name !== 'string' || this.tenantKey(name) !== row.tenant_key) throw new Error('encrypted LRS tenant binding failed');
      return name;
    });
    return { tenants, more: result.rows.length > limit ? page[page.length - 1]!.tenant_key : null };
  }
  async listTenants(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listTenantPage({ limit: 500, cursor });
      names.push(...page.tenants);
      cursor = page.more ?? undefined;
    } while (cursor);
    return names;
  }
  clearAllowed(): boolean { return this.options.allowClear === true; }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await (await this.poolPromise).end();
    this.rootKey.fill(0);
    this.indexKey.fill(0);
  }
}

/** A lightweight tenant view sharing the database pool; it holds no record cache. */
export class PostgresLrsStore implements StatementStore {
  private readonly tenantKey: string;
  constructor(private readonly database: PostgresLrsDatabase, private readonly tenant: string) {
    this.tenantKey = database.tenantKey(tenant);
  }

  private key(kind: string, id: string): string { return this.database.recordKey(this.tenant, kind, id); }
  private decode<T>(kind: string, id: string, row: EncryptedRow): T {
    const envelope = this.database.open<{ id: string; value: T }>(this.tenant, kind, row.record_id, row.payload);
    if (envelope.id !== id || this.key(kind, id) !== row.record_id) throw new Error('encrypted LRS index binding failed');
    this.checkMetadata(kind, row, envelope.value);
    return envelope.value;
  }

  private checkMetadata(kind: string, row: EncryptedRow, value: unknown): void {
    if (kind !== 'statement') return;
    const record = value as StoredStatement;
    if (row.stored_at === null || Date.parse(record.stored) !== new Date(row.stored_at).getTime()
      || record.voided !== row.voided) throw new Error('encrypted LRS statement metadata binding failed');
  }

  private async read<T>(client: LrsPgClient, kind: string, id: string): Promise<T | null> {
    const result = await client.query<EncryptedRow>(`SELECT record_id,payload,stored_at,voided FROM ${TABLE}
      WHERE tenant_key=$1 AND kind=$2 AND record_id=$3 FOR UPDATE`, [this.tenantKey, kind, this.key(kind, id)]);
    return result.rows[0] ? this.decode<T>(kind, id, result.rows[0]) : null;
  }
  private async write(client: LrsPgClient, kind: string, id: string, value: unknown,
    stored: string | null = null, voided = false): Promise<void> {
    await client.query(`INSERT INTO ${TABLE} (tenant_key,kind,record_id,payload,stored_at,voided)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_key,kind,record_id)
      DO UPDATE SET payload=EXCLUDED.payload,stored_at=EXCLUDED.stored_at,voided=EXCLUDED.voided`,
    [this.tenantKey, kind, this.key(kind, id),
      this.database.seal(this.tenant, kind, this.key(kind, id), { id, value }), stored === null ? null : new Date(stored).toISOString(), voided]);
  }

  async put(record: StoredStatement): Promise<void> { await this.putWithAttachments(record, new Map()); }
  async putWithAttachments(record: StoredStatement, attachments: ReadonlyMap<string, LrsAttachment>): Promise<void> {
    if (typeof record.stored !== 'string' || !Number.isFinite(Date.parse(record.stored))
      || new Date(record.stored).toISOString() !== record.stored) throw new Error('LRS stored timestamp must be canonical UTC milliseconds');
    await this.database.transaction(async client => {
      await this.database.registerTenant(client, this.tenant);
      // Identity sequences are assigned before COMMIT. Serializing statement
      // insertions per tenant makes the pagination watermark a commit horizon,
      // rather than allowing a lower revision to arrive after a later page.
      await this.database.lock(client, this.tenant, 'statement-inserts', 'all');
      await this.database.lock(client, this.tenant, 'statement', record.id);
      const prior = await this.read<StoredStatement>(client, 'statement', record.id);
      if (prior && immutableBody(prior.statement) !== immutableBody(record.statement)) {
        throw new ConflictError(`statement id ${record.id} already stored with different content`);
      }
      if (!prior) await this.write(client, 'statement', record.id, record, record.stored, record.voided);
      // Lock ordering is deterministic for overlapping multipart requests.
      for (const [sha, attachment] of [...attachments].sort(([a], [b]) => a.localeCompare(b))) {
        await this.writeAttachment(client, sha, attachment);
      }
    });
  }

  async get(id: string): Promise<StoredStatement | null> { return this.getResource('statement', id); }
  async markVoided(id: string, voidingStatementId: string, onlyIf?: (target: StoredStatement) => boolean): Promise<boolean> {
    return this.database.transaction(async client => {
      await this.database.lock(client, this.tenant, 'tenant-registry', 'entry');
      await this.database.lock(client, this.tenant, 'statement', id);
      const target = await this.read<StoredStatement>(client, 'statement', id);
      if (!target || (onlyIf && !onlyIf(target))) return false;
      await this.database.registerTenant(client, this.tenant);
      const marked = { ...target, voided: true, voidingStatementId };
      await this.write(client, 'statement', id, marked, target.stored, true);
      return true;
    });
  }

  async query(filter: QueryFilter): Promise<QueryResult> {
    const query = checkedQuery(cursorQueryOf(filter));
    if (filter.statementId || filter.voidedStatementId) {
      if (filter.cursor || (filter.statementId && filter.voidedStatementId)) throw new InvalidLrsQueryError();
      const row = await this.get(filter.statementId ?? filter.voidedStatementId!);
      return { statements: row && row.voided === !!filter.voidedStatementId ? [row] : [], more: null };
    }
    if (filter.cursor !== undefined && (typeof filter.cursor !== 'string' || !filter.cursor || filter.cursor.length > 16_384
      || !/^[A-Za-z0-9_-]+$/.test(filter.cursor))) throw new InvalidLrsQueryError('invalid LRS continuation token');
    const decoded = decodeCursor(filter.cursor);
    if (filter.cursor && (!decoded || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0)) {
      throw new InvalidLrsQueryError('invalid LRS continuation token');
    }
    const pg = decoded as (typeof decoded & Partial<PgCursor> & { pgProof?: unknown });
    if (filter.cursor && (!pg || Object.keys(pg).some(key => !['offset', 'pgRevision', 'pgScanned', 'pgAfterStored', 'pgAfterKey', 'q', 'pgProof'].includes(key))
      || typeof pg.pgRevision !== 'string' || !/^\d{1,19}$/.test(pg.pgRevision)
      || BigInt(pg.pgRevision) > 9_223_372_036_854_775_807n
      || !Number.isSafeInteger(pg.pgScanned) || pg.pgScanned! < 0
      || typeof pg.pgAfterStored !== 'string' || pg.pgAfterStored.length > 32 || !Number.isFinite(Date.parse(pg.pgAfterStored))
      || typeof pg.pgAfterKey !== 'string' || !/^[a-f0-9]{64}$/.test(pg.pgAfterKey)
      || typeof pg.pgProof !== 'string' || !/^[a-f0-9]{64}$/.test(pg.pgProof))) throw new InvalidLrsQueryError('invalid LRS continuation token');
    if (pg) {
      const bound = checkedQuery(pg.q);
      if (stableJson(bound) !== stableJson(query)) throw new InvalidLrsQueryError('LRS continuation query does not match');
      const body: PgCursor = { offset: pg.offset, pgRevision: pg.pgRevision!, pgScanned: pg.pgScanned!,
        pgAfterStored: pg.pgAfterStored!, pgAfterKey: pg.pgAfterKey!, q: bound };
      const signature = this.database.continuationSignature(this.tenant, body);
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(pg.pgProof as string, 'hex'))) {
        throw new InvalidLrsQueryError('invalid LRS continuation signature');
      }
    }
    const latest = pg?.pgRevision ?? (await this.database.query<{ revision: string }>(
      `SELECT COALESCE(MAX(revision),0)::text AS revision FROM ${TABLE} WHERE tenant_key=$1 AND kind='statement'`,
      [this.tenantKey])).rows[0]!.revision;
    const limit = query.limit!;
    const rows: StoredStatement[] = [];
    let scanned = pg?.pgScanned ?? 0;
    let afterStored = pg?.pgAfterStored ?? null;
    let afterKey = pg?.pgAfterKey ?? null;
    // Decrypt at most one small SQL page at a time. Only this tenant's rows are
    // queried; unrelated tenants' private records never enter this process.
    for (;;) {
      const batch = await this.database.query<StatementRow>(`SELECT record_id,payload,stored_at,voided,revision::text FROM ${TABLE}
        WHERE tenant_key=$1 AND kind='statement' AND revision<=$2::bigint AND voided=false
        AND ($4::timestamptz IS NULL OR stored_at ${query.ascending ? '>' : '<'} $4::timestamptz
          OR (stored_at=$4::timestamptz AND record_id>$5))
        ORDER BY stored_at ${query.ascending ? 'ASC' : 'DESC'},record_id ASC LIMIT $3`,
      [this.tenantKey, latest, BATCH, afterStored, afterKey]);
      for (const row of batch.rows) {
        // Statement UUIDs are private inside the encrypted envelope. The row's
        // opaque index is bound as AAD; an envelope includes its logical ID.
        const record = this.openIndexed<StoredStatement>('statement', row);
        if (matchesFilter(record, query)) {
          if (rows.length >= limit) {
            const token: PgCursor = { offset: (decoded?.offset ?? 0) + rows.length, pgRevision: latest,
              pgScanned: scanned, pgAfterStored: afterStored!, pgAfterKey: afterKey!, q: query };
            const signed = { ...token, pgProof: this.database.continuationSignature(this.tenant, token) };
            return { statements: rows, more: encodeCursor(signed) };
          }
          rows.push(record);
        }
        scanned++;
        afterStored = new Date(row.stored_at).toISOString();
        afterKey = row.record_id;
      }
      if (batch.rows.length < BATCH) return { statements: rows, more: null };
    }
  }

  private openIndexed<T>(kind: string, row: EncryptedRow): T {
    // List operations cannot recover a logical key from its HMAC. An outer
    // authenticated envelope binds the opaque index; its inner value retains
    // the logical ID. See sealIndexed/getResource below.
    const outer = this.database.open<{ id: string; value: T }>(this.tenant, kind, row.record_id, row.payload);
    if (this.key(kind, outer.id) !== row.record_id) throw new Error('encrypted LRS index binding failed');
    this.checkMetadata(kind, row, outer.value);
    return outer.value;
  }

  async listAll(): Promise<StoredStatement[]> {
    return (await this.listResources<StoredStatement>('statement')).map(([, record]) => record);
  }
  async count(): Promise<number> {
    const result = await this.database.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${TABLE}
      WHERE tenant_key=$1 AND kind='statement'`, [this.tenantKey]);
    const count = Number(result.rows[0]!.count);
    if (!Number.isSafeInteger(count)) throw new Error('LRS count exceeds supported range');
    return count;
  }
  async clear(): Promise<void> {
    if (!this.database.clearAllowed()) throw new Error('durable LRS clear is disabled');
    await this.database.transaction(async client => {
      await this.database.lock(client, this.tenant, 'tenant-registry', 'entry');
      await client.query(`DELETE FROM ${TABLE} WHERE tenant_key=$1`, [this.tenantKey]);
      await client.query(`DELETE FROM ${TENANTS} WHERE tenant_key=$1
        AND NOT EXISTS (SELECT 1 FROM ${TABLE} WHERE tenant_key=$1)`, [this.tenantKey]);
    });
  }
  backendDescription(): string { return 'postgres (tenant-isolated authenticated encryption; synchronous durable commits)'; }

  async getResource<T>(kind: string, id: string): Promise<T | null> {
    const result = await this.database.query<EncryptedRow>(`SELECT record_id,payload,stored_at,voided FROM ${TABLE}
      WHERE tenant_key=$1 AND kind=$2 AND record_id=$3`, [this.tenantKey, kind, this.key(kind, id)]);
    return result.rows[0] ? this.decode<T>(kind, id, result.rows[0]) : null;
  }
  async listResources<T>(kind: string): Promise<Array<[string, T]>> {
    bounded(kind, 'record kind', 64);
    const result = await this.database.query<EncryptedRow>(`SELECT record_id,payload,stored_at,voided FROM ${TABLE}
      WHERE tenant_key=$1 AND kind=$2 ORDER BY record_id`, [this.tenantKey, kind]);
    return result.rows.map(row => {
      const envelope = this.database.open<{ id: string; value: T }>(this.tenant, kind, row.record_id, row.payload);
      if (this.key(kind, envelope.id) !== row.record_id) throw new Error('encrypted LRS index binding failed');
      this.checkMetadata(kind, row, envelope.value);
      return [envelope.id, envelope.value];
    });
  }
  async updateResource<T, R>(kind: string, id: string,
    mutate: (current: T | null) => { value: T | null; result: R }): Promise<R> {
    if (kind === 'statement' || kind === 'attachment') throw new Error('use the immutable LRS record methods');
    return this.database.transaction(async client => {
      await this.database.lock(client, this.tenant, 'tenant-registry', 'entry');
      await this.database.lock(client, this.tenant, kind, id);
      const current = await this.read<T>(client, kind, id);
      const next = mutate(current);
      if (next.value === null) {
        await client.query(`DELETE FROM ${TABLE} WHERE tenant_key=$1 AND kind=$2 AND record_id=$3`,
          [this.tenantKey, kind, this.key(kind, id)]);
      } else {
        await this.database.registerTenant(client, this.tenant);
        await this.write(client, kind, id, next.value);
      }
      return next.result;
    });
  }
  async putResource<T>(kind: string, id: string, value: T): Promise<void> {
    await this.updateResource<T, void>(kind, id, () => ({ value, result: undefined }));
  }
  async deleteResource(kind: string, id: string): Promise<void> {
    await this.updateResource<unknown, void>(kind, id, () => ({ value: null, result: undefined }));
  }
  private async writeAttachment(client: LrsPgClient, sha: string, attachment: LrsAttachment): Promise<void> {
    if (!/^[a-fA-F0-9]{64}$/.test(sha) || createHash('sha256').update(attachment.data).digest('hex') !== sha.toLowerCase()) {
      throw new Error('LRS attachment hash does not match its bytes');
    }
    await this.database.lock(client, this.tenant, 'attachment', sha);
    await this.write(client, 'attachment', sha, { data: attachment.data.toString('base64'), contentType: attachment.contentType });
  }
  async putAttachment(sha: string, attachment: LrsAttachment): Promise<void> {
    await this.database.transaction(async client => {
      await this.database.registerTenant(client, this.tenant);
      await this.writeAttachment(client, sha, attachment);
    });
  }
  async getAttachment(sha: string): Promise<LrsAttachment | null> {
    const value = await this.getResource<{ data: string; contentType: string }>('attachment', sha);
    return value ? { data: Buffer.from(value.data, 'base64'), contentType: value.contentType } : null;
  }
}
