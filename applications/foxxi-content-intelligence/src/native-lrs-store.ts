/**
 * Native Interego primary for xAPI. Complete encrypted canonical PGSL artifacts
 * are authoritative; the paired statement query entries are rebuildable views.
 * No process cache, SQL database or public pod snapshot is a source of truth.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  NativeCommitConflictError, createNativeByteArtifact, readNativeByteArtifact,
  type NativeCommitClient, type NativeSnapshot, type NativeSnapshotReference,
} from '@interego/pgsl';
import type { IRI } from '@interego/core';
import {
  ConflictError, cursorQueryOf, encodeCursor, matchesFilter,
  type CursorQuery, type QueryFilter, type QueryResult, type StatementStore, type StoredStatement,
} from './statement-store.js';
import { utcTimestamp, validateAgentObject } from './xapi-validate.js';
import { RFC3339_UTC_TIMESTAMP } from './spec/patterns.js';

export interface LrsAttachment { data: Buffer; contentType: string; }
export interface NativeInteregoLrsOptions {
  client: NativeCommitClient;
  owner: IRI;
  /** Exact configured pod/head identity; included in all opaque index/cursor bindings. */
  scopeIdentity: string;
  cursorSecret: string | Uint8Array;
  /** Native media/version discovery; write authority is separately proved by a CAS. */
  verifyReadiness?: () => Promise<void>;
  allowClear?: boolean;
  now?: () => number;
}
type NativeChange = Parameters<NativeCommitClient['commit']>[0]['changes'][number];
type ByteArtifact = ReturnType<typeof createNativeByteArtifact>;
interface RecordEnvelope { format: string; tenant: string; kind: string; id: string; value: unknown; }
interface NativeCursor {
  offset: number; q: CursorQuery; head: NativeSnapshotReference; after: string;
  expires: number; authorizationRegistration: string | null; proof?: string;
}
const PREFIX = 'foxxi-lrs/v1/';
const RECORD_TYPE = 'application/vnd.foxxi.lrs-record+json';
const MAX_SCAN = 4096;
const CURSOR_LIFETIME = 60 * 60 * 1000;
const UTC_TIMESTAMP = new RegExp(RFC3339_UTC_TIMESTAMP);
export class InvalidLrsQueryError extends Error {
  readonly status = 400;
  constructor(message = 'invalid LRS query') { super(message); this.name = 'InvalidLrsQueryError'; }
}
function bounded(value: string, label: string, max: number): void {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw new Error('invalid LRS ' + label);
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function checkedQuery(value: unknown): CursorQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidLrsQueryError();
  const q = value as Record<string, unknown>;
  if (Object.keys(q).some(k => !['agent', 'verb', 'activity', 'registration', 'since', 'until', 'ascending', 'limit'].includes(k))) throw new InvalidLrsQueryError();
  if (q.limit !== undefined && (typeof q.limit !== 'number' || !Number.isSafeInteger(q.limit) || q.limit < 0)) throw new InvalidLrsQueryError();
  if (q.ascending !== undefined && typeof q.ascending !== 'boolean') throw new InvalidLrsQueryError();
  for (const key of ['verb', 'activity']) {
    const v = q[key];
    if (v !== undefined && (typeof v !== 'string' || v.length > 8192 || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(v))) throw new InvalidLrsQueryError();
  }
  if (q.registration !== undefined && (typeof q.registration !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(q.registration))) throw new InvalidLrsQueryError();
  for (const key of ['since', 'until']) {
    const v = q[key];
    if (v !== undefined && (typeof v !== 'string' || v.length > 128 || !UTC_TIMESTAMP.test(utcTimestamp(v)) || !Number.isFinite(Date.parse(utcTimestamp(v))))) throw new InvalidLrsQueryError();
  }
  if (q.agent !== undefined && (typeof q.agent !== 'object' || q.agent === null || Array.isArray(q.agent) || JSON.stringify(q.agent).length > 8192 || validateAgentObject(q.agent).length)) throw new InvalidLrsQueryError();
  return { ...cursorQueryOf(q as CursorQuery), limit: q.limit === 0 ? 500 : Math.min(q.limit as number | undefined ?? 100, 500), ascending: q.ascending === true };
}
/** Tagged tree preserves real binary docs while ordinary JSON Buffer-shaped objects remain JSON. */
function encodeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return ['bytes', value.toString('base64')];
  if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return ['value', value];
  if (Array.isArray(value)) return ['array', value.map(encodeValue)];
  if (value && typeof value === 'object') return ['object', Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encodeValue(v)])];
  throw new Error('LRS storage requires finite JSON values or binary documents');
}
function decodeValue(encoded: unknown): unknown {
  if (!Array.isArray(encoded) || encoded.length !== 2) throw new Error('invalid native LRS value');
  const [kind, value] = encoded as [unknown, unknown];
  if (kind === 'bytes' && typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return Buffer.from(value, 'base64');
  if (kind === 'value' && (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value)))) return value;
  if (kind === 'array' && Array.isArray(value)) return value.map(decodeValue);
  if (kind === 'object' && Array.isArray(value)) return Object.fromEntries(value.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error('invalid native LRS object');
    return [entry[0], decodeValue(entry[1])];
  }));
  throw new Error('invalid native LRS value');
}
function immutableBody(statement: Record<string, unknown>): string {
  const body = { ...statement }; delete body.stored; delete body.authority;
  return stableJson(body);
}
const voidTarget = (s: Record<string, unknown>): string | null => {
  const verb = s.verb as { id?: string } | undefined, object = s.object as { objectType?: string; id?: string } | undefined;
  return verb?.id === 'http://adlnet.gov/expapi/verbs/voided' && object?.objectType === 'StatementRef' && typeof object.id === 'string' ? object.id : null;
};
function checkedStatement(value: StoredStatement, id: string): StoredStatement {
  if (!value || value.id !== id || value.statement?.id !== id || typeof value.stored !== 'string'
    || !Number.isFinite(Date.parse(value.stored)) || new Date(value.stored).toISOString() !== value.stored
    || value.statement.stored !== value.stored || value.voided !== false || value.voidingStatementId !== undefined) throw new Error('invalid immutable native LRS statement');
  return value;
}

class NativeMutation {
  readonly changes = new Map<string, NativeChange>();
  private readonly values = new Map<string, unknown>();
  constructor(readonly database: NativeInteregoLrsDatabase, readonly snapshot: NativeSnapshot) {}
  async read<T>(tenant: string, kind: string, id: string): Promise<T | null> {
    const key = this.database.key(tenant, kind, id);
    if (this.values.has(key)) return this.values.get(key) as T | null;
    return this.database.read<T>(this.snapshot, tenant, kind, id);
  }
  write(tenant: string, kind: string, id: string, value: unknown): ByteArtifact {
    const artifact = this.database.artifact(tenant, kind, id, value);
    const key = this.database.key(tenant, kind, id);
    this.changes.set(key, { key, artifact }); this.values.set(key, value);
    return artifact;
  }
  remove(key: string): void { this.changes.set(key, { key, artifact: null }); this.values.set(key, null); }
  async registerTenant(tenant: string): Promise<void> {
    if (await this.read<string>(tenant, 'registry', 'tenant') === null) this.write(tenant, 'registry', 'tenant', tenant);
  }
}

/** Shares only transport and stable keys. Every operation starts from a verified durable native head. */
export class NativeInteregoLrsDatabase {
  private closed = false;
  private readiness?: Promise<void>;
  private readonly secret: Buffer;
  constructor(private readonly options: NativeInteregoLrsOptions) {
    this.secret = Buffer.from(options.cursorSecret);
    if (this.secret.length < 32) throw new Error('native LRS requires a stable cursor secret of at least 32 bytes');
    bounded(options.scopeIdentity, 'native scope', 8192);
  }
  get client(): NativeCommitClient { return this.options.client; }
  get owner(): IRI { return this.options.owner; }
  now(): number { return this.options.now?.() ?? Date.now(); }
  digest(value: string): string { return createHmac('sha256', this.secret).update(JSON.stringify([this.options.scopeIdentity, value])).digest('hex'); }
  prefix(tenant: string): string { return PREFIX + this.digest(tenant) + '/'; }
  key(tenant: string, kind: string, id: string): string {
    bounded(tenant, 'tenant', 8192); bounded(kind, 'record kind', 64); bounded(id, 'record ID', 65536);
    return this.prefix(tenant) + kind + '/' + this.digest(JSON.stringify([tenant, kind, id]));
  }
  queryKey(tenant: string, record: StoredStatement): string {
    return this.prefix(tenant) + 'query/' + record.stored + '/' + this.digest(JSON.stringify([tenant, 'statement', record.id]));
  }
  signature(tenant: string, cursor: Omit<NativeCursor, 'proof'>): string {
    return createHmac('sha256', this.secret).update(JSON.stringify([this.options.scopeIdentity, tenant, stableJson(cursor)])).digest('hex');
  }
  artifact(tenant: string, kind: string, id: string, value: unknown): ByteArtifact {
    const envelope: RecordEnvelope = { format: 'foxxi-native-lrs/1', tenant, kind, id, value: encodeValue(value) };
    return createNativeByteArtifact({ owner: this.owner, contentType: RECORD_TYPE, bytes: Buffer.from(JSON.stringify(envelope), 'utf8') });
  }
  async readReference<T>(snapshot: NativeSnapshot, key: string, tenant: string, kind: string, id?: string): Promise<T | null> {
    const reference = snapshot.records.get(key);
    if (!reference) return null;
    const payload = readNativeByteArtifact(await this.client.readArtifact(reference));
    if (payload.owner !== this.owner || payload.contentType !== RECORD_TYPE) throw new Error('native LRS artifact owner/type binding failed');
    const envelope = JSON.parse(Buffer.from(payload.bytes).toString('utf8')) as RecordEnvelope;
    if (envelope.format !== 'foxxi-native-lrs/1' || envelope.tenant !== tenant || envelope.kind !== kind
      || (id !== undefined && envelope.id !== id)) throw new Error('native LRS artifact/index binding failed');
    const decoded = decodeValue(envelope.value);
    if (decoded === null || decoded === undefined) throw new Error('native LRS artifact contains an absent record');
    if (kind === 'statement') checkedStatement(decoded as StoredStatement, envelope.id);
    const expectedKey = kind === 'statement' && key.startsWith(this.prefix(tenant) + 'query/')
      ? this.queryKey(tenant, checkedStatement(decoded as StoredStatement, envelope.id))
      : this.key(tenant, kind, envelope.id);
    if (expectedKey !== key) throw new Error('native LRS artifact/index binding failed');
    return decoded as T;
  }
  async read<T>(snapshot: NativeSnapshot, tenant: string, kind: string, id: string): Promise<T | null> {
    return this.readReference<T>(snapshot, this.key(tenant, kind, id), tenant, kind, id);
  }
  async ready(): Promise<void> {
    if (this.closed) throw new Error('native LRS is closed');
    if (!this.readiness) this.readiness = (async () => {
      await this.client.ready();
      await this.options.verifyReadiness?.();
      // A real native write, not a read-only probe: verifies live write authority.
      for (let attempt = 0; attempt < 8; attempt++) {
        const expected = await this.client.readHead();
        try { await this.client.commit({ operationId: randomUUID(), expected, changes: [] }); return; }
        catch (error) { if (!(error instanceof NativeCommitConflictError) || attempt === 7) throw error; }
      }
    })();
    const pending = this.readiness;
    try { await pending; } catch (error) { if (pending === this.readiness) this.readiness = undefined; throw error; }
  }
  async transaction<R>(prepare: (mutation: NativeMutation) => Promise<R>): Promise<R> {
    await this.ready();
    for (let attempt = 0; attempt < 8; attempt++) {
      const mutation = new NativeMutation(this, await this.client.readHead());
      const result = await prepare(mutation);
      if (!mutation.changes.size) return result;
      try {
        await this.client.commit({ operationId: randomUUID(), expected: mutation.snapshot, changes: [...mutation.changes.values()] });
        return result;
      } catch (error) {
        if (!(error instanceof NativeCommitConflictError)) throw error;
        if (attempt === 7) throw new Error('native LRS commit contention limit reached');
      }
    }
    throw new Error('native LRS commit contention limit reached');
  }
  forTenant(tenant: string): NativeInteregoLrsStore { bounded(tenant, 'tenant', 8192); return new NativeInteregoLrsStore(this, tenant); }
  async listTenants(): Promise<string[]> {
    await this.ready();
    const head = await this.client.readHead(), names: string[] = [];
    for (const [key, ref] of head.records) {
      if (!key.startsWith(PREFIX) || !key.includes('/registry/')) continue;
      const value = readNativeByteArtifact(await this.client.readArtifact(ref));
      if (value.owner !== this.owner || value.contentType !== RECORD_TYPE) throw new Error('native LRS tenant registry owner/type binding failed');
      const row = JSON.parse(Buffer.from(value.bytes).toString('utf8')) as RecordEnvelope;
      const tenant = decodeValue(row.value);
      if (row.format !== 'foxxi-native-lrs/1' || row.kind !== 'registry' || row.id !== 'tenant'
        || typeof tenant !== 'string' || row.tenant !== tenant || this.key(tenant, 'registry', 'tenant') !== key) throw new Error('native LRS tenant registry binding failed');
      names.push(tenant);
    }
    return names.sort();
  }
  clearAllowed(): boolean { return this.options.allowClear === true; }
  async close(): Promise<void> { this.closed = true; this.secret.fill(0); }
}

export interface AppliedNativeVoid { target: StoredStatement; voidingStatementId: string; }
export interface NativeStatementCommit { records: StoredStatement[]; inserted: StoredStatement[]; appliedVoids: AppliedNativeVoid[]; }
export class NativeInteregoLrsStore implements StatementStore {
  constructor(private readonly database: NativeInteregoLrsDatabase, private readonly tenant: string) {}
  private async getAt(head: NativeSnapshot, id: string): Promise<StoredStatement | null> {
    const record = await this.database.read<StoredStatement>(head, this.tenant, 'statement', id);
    if (!record) return null;
    checkedStatement(record, id);
    const relation = await this.database.read<{ target: string; voidingStatementId: string }>(head, this.tenant, 'void', id);
    if (!relation) return record;
    const voider = await this.database.read<StoredStatement>(head, this.tenant, 'statement', relation.voidingStatementId);
    if (relation.target !== id || !voider || voidTarget(checkedStatement(voider, relation.voidingStatementId).statement) !== id || voidTarget(record.statement)) throw new Error('native LRS void relationship binding failed');
    return { ...record, voided: true, voidingStatementId: relation.voidingStatementId };
  }
  async put(record: StoredStatement): Promise<void> { await this.putWithAttachments(record, new Map()); }
  async putWithAttachments(record: StoredStatement, attachments: ReadonlyMap<string, LrsAttachment>, registration?: string): Promise<NativeStatementCommit> {
    return this.putBatchWithAttachments([record], attachments, registration);
  }
  /** Whole HTTP batch + exact envelopes + attachment bytes + guarded void edges share one native CAS. */
  async putBatchWithAttachments(records: readonly StoredStatement[], attachments: ReadonlyMap<string, LrsAttachment>, registration?: string): Promise<NativeStatementCommit> {
    if (!records.length) { if (attachments.size) throw new Error('native LRS attachment commit requires a statement'); return { records: [], inserted: [], appliedVoids: [] }; }
    const ids = new Set<string>();
    for (const row of records) {
      checkedStatement(row, row.id);
      if (ids.has(row.id)) throw new ConflictError('duplicate statement UUID in batch');
      ids.add(row.id);
    }
    return this.database.transaction(async tx => {
      await tx.registerTenant(this.tenant);
      const kept: StoredStatement[] = [], inserted: StoredStatement[] = [];
      for (const row of records) {
        const prior = await tx.read<StoredStatement>(this.tenant, 'statement', row.id);
        if (prior && immutableBody(prior.statement) !== immutableBody(row.statement)) throw new ConflictError('statement id ' + row.id + ' already stored with different content');
        kept.push(prior ? checkedStatement(prior, row.id) : row);
        if (!prior) {
          inserted.push(row);
          const artifact = tx.write(this.tenant, 'statement', row.id, row);
          const key = this.database.queryKey(this.tenant, row);
          tx.changes.set(key, { key, artifact });
        }
      }
      for (const [sha, attachment] of attachments) {
        if (!/^[a-f0-9]{64}$/i.test(sha) || createHash('sha256').update(attachment.data).digest('hex') !== sha.toLowerCase()) throw new Error('LRS attachment hash does not match its bytes');
        bounded(attachment.contentType, 'attachment content type', 1024);
        const key = this.database.key(this.tenant, 'attachment', sha.toLowerCase());
        const prior = tx.snapshot.records.get(key);
        if (prior) {
          const old = readNativeByteArtifact(await this.database.client.readArtifact(prior));
          if (old.sha256 !== 'sha256:' + sha.toLowerCase() || old.owner !== this.database.owner || old.contentType !== attachment.contentType || !Buffer.from(old.bytes).equals(attachment.data)) throw new ConflictError('attachment already stored with different metadata');
        } else tx.changes.set(key, { key, artifact: createNativeByteArtifact({ owner: this.database.owner, contentType: attachment.contentType, bytes: attachment.data }) });
      }
      const applied: AppliedNativeVoid[] = [];
      for (const row of inserted) {
        const id = voidTarget(row.statement); if (!id) continue;
        const target = await tx.read<StoredStatement>(this.tenant, 'statement', id);
        if (!target || voidTarget(target.statement) || (registration !== undefined && (target.statement.context as { registration?: string } | undefined)?.registration !== registration)) continue;
        tx.write(this.tenant, 'void', id, { target: id, voidingStatementId: row.id });
        applied.push({ target: { ...target, voided: true, voidingStatementId: row.id }, voidingStatementId: row.id });
      }
      return { records: kept, inserted, appliedVoids: applied };
    });
  }
  async get(id: string): Promise<StoredStatement | null> { await this.database.ready(); return this.getAt(await this.database.client.readHead(), id); }
  async markVoided(id: string, voidingStatementId: string, onlyIf?: (target: StoredStatement) => boolean): Promise<boolean> {
    return this.database.transaction(async tx => {
      const target = await this.getAt(tx.snapshot, id);
      const voider = await tx.read<StoredStatement>(this.tenant, 'statement', voidingStatementId);
      if (!target || !voider || voidTarget(voider.statement) !== id || voidTarget(target.statement) || (onlyIf && !onlyIf(target))) return false;
      await tx.registerTenant(this.tenant);
      tx.write(this.tenant, 'void', id, { target: id, voidingStatementId });
      return true;
    });
  }
  private queryEntries(head: NativeSnapshot): Array<{ key: string; stored: string; opaque: string }> {
    const prefix = this.database.prefix(this.tenant), statementPrefix = prefix + 'statement/', queryPrefix = prefix + 'query/';
    const statements = new Map([...head.records].filter(([key]) => key.startsWith(statementPrefix)).map(([key, ref]) => [key.slice(statementPrefix.length), ref]));
    const seen = new Set<string>(), rows: Array<{ key: string; stored: string; opaque: string }> = [];
    for (const [key, ref] of head.records) {
      if (!key.startsWith(queryPrefix)) continue;
      const suffix = key.slice(queryPrefix.length), stored = suffix.slice(0, 24), opaque = suffix.slice(25);
      const primary = statements.get(opaque);
      if (suffix[24] !== '/' || !/^[a-f0-9]{64}$/.test(opaque) || !Number.isFinite(Date.parse(stored)) || new Date(stored).toISOString() !== stored
        || !primary || primary.plaintextDigest !== ref.plaintextDigest || primary.topUri !== ref.topUri || seen.has(opaque)) throw new Error('native LRS query view binding failed');
      seen.add(opaque); rows.push({ key, stored, opaque });
    }
    if (seen.size !== statements.size) throw new Error('native LRS query view incomplete; rebuild from native statement artifacts before serving');
    return rows;
  }
  private cursor(token: string, query: CursorQuery, authorizationRegistration: string | null): NativeCursor {
    if (token.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new InvalidLrsQueryError('invalid LRS continuation token');
    let value: NativeCursor;
    try { value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as NativeCursor; } catch { throw new InvalidLrsQueryError(); }
    if (!value || Object.keys(value).some(k => !['offset', 'q', 'head', 'after', 'expires', 'authorizationRegistration', 'proof'].includes(k))
      || value.authorizationRegistration !== authorizationRegistration
      || !Number.isSafeInteger(value.offset) || value.offset < 0 || !Number.isSafeInteger(value.expires)
      || value.expires <= this.database.now() || value.expires > this.database.now() + CURSOR_LIFETIME
      || typeof value.after !== 'string' || value.after.length > 1024 || !value.after.startsWith(this.database.prefix(this.tenant) + 'query/')
      || !value.head || Object.keys(value.head).some(k => !['revision', 'commitUrl', 'topUri'].includes(k))
      || !['revision', 'commitUrl', 'topUri'].every(k => { const field = value.head[k as keyof NativeSnapshotReference]; return typeof field === 'string' && field.length <= 8192; })
      || typeof value.proof !== 'string' || !/^[a-f0-9]{64}$/.test(value.proof) || stableJson(checkedQuery(value.q)) !== stableJson(query)) throw new InvalidLrsQueryError('invalid LRS continuation token');
    const { proof, ...body } = value;
    if (!timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(this.database.signature(this.tenant, body), 'hex'))) throw new InvalidLrsQueryError('invalid LRS continuation signature');
    return value;
  }
  async query(filter: QueryFilter): Promise<QueryResult> {
    await this.database.ready();
    const q = checkedQuery(cursorQueryOf(filter));
    const authorizationRegistration = filter.authorizedRegistration ?? null;
    if (authorizationRegistration !== null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(authorizationRegistration)) throw new InvalidLrsQueryError();
    if (filter.statementId || filter.voidedStatementId) {
      if (filter.cursor || (filter.statementId && filter.voidedStatementId)) throw new InvalidLrsQueryError();
      const record = await this.get(filter.statementId ?? filter.voidedStatementId!);
      return { statements: record && record.voided === !!filter.voidedStatementId
        && (authorizationRegistration === null || (record.statement.context as { registration?: string } | undefined)?.registration === authorizationRegistration) ? [record] : [], more: null };
    }
    const cursor = filter.cursor === undefined ? null : this.cursor(filter.cursor, q, authorizationRegistration);
    const head = cursor ? await this.database.client.readSnapshotAt(cursor.head) : await this.database.client.readHead();
    const index = this.queryEntries(head).sort((a, b) => (q.ascending ? a.stored.localeCompare(b.stored) : b.stored.localeCompare(a.stored)) || a.opaque.localeCompare(b.opaque));
    let start = 0;
    if (cursor) { const found = index.findIndex(row => row.key === cursor.after); if (found < 0) throw new InvalidLrsQueryError(); start = found + 1; }
    const statements: StoredStatement[] = [];
    let next = start;
    for (; next < index.length && next - start < MAX_SCAN && statements.length < q.limit!; next++) {
      const row = index[next]!;
      const base = await this.database.readReference<StoredStatement>(head, row.key, this.tenant, 'statement');
      if (!base || this.database.queryKey(this.tenant, checkedStatement(base, base.id)) !== row.key) throw new Error('native LRS query timestamp binding failed');
      const record = await this.getAt(head, base.id);
      if (!record || record.voided || (authorizationRegistration !== null
        && (record.statement.context as { registration?: string } | undefined)?.registration !== authorizationRegistration)) continue;
      let matches = matchesFilter(record, q);
      const targetId = voidTarget(record.statement);
      // Expansion belongs to this same immutable snapshot and result cursor.
      // Registration authorization applies to the emitted voider as well as its target.
      if (!matches && targetId) {
        const target = await this.getAt(head, targetId);
        matches = !!target?.voided && target.voidingStatementId === record.id && matchesFilter(target, q);
      }
      if (matches) statements.push(record);
    }
    if (next >= index.length) return { statements, more: null };
    if (!head.reference || next <= start) throw new Error('native LRS pagination requires a committed snapshot');
    const body: NativeCursor = { offset: (cursor?.offset ?? 0) + statements.length, q, head: head.reference, after: index[next - 1]!.key, authorizationRegistration, expires: cursor?.expires ?? this.database.now() + CURSOR_LIFETIME };
    const signed = { ...body, proof: this.database.signature(this.tenant, body) };
    return { statements, more: encodeCursor(signed) };
  }
  async listAll(): Promise<StoredStatement[]> {
    await this.database.ready();
    const head = await this.database.client.readHead(), prefix = this.database.prefix(this.tenant) + 'statement/', records: StoredStatement[] = [];
    for (const key of head.records.keys()) {
      if (!key.startsWith(prefix)) continue;
      const base = await this.database.readReference<StoredStatement>(head, key, this.tenant, 'statement');
      if (base) { const row = await this.getAt(head, checkedStatement(base, base.id).id); if (row) records.push(row); }
    }
    return records;
  }
  async count(): Promise<number> {
    await this.database.ready(); const prefix = this.database.prefix(this.tenant) + 'statement/';
    return [...(await this.database.client.readHead()).records.keys()].filter(key => key.startsWith(prefix)).length;
  }
  async clear(): Promise<void> {
    if (!this.database.clearAllowed()) throw new Error('native LRS clear is disabled');
    await this.database.transaction(async tx => { for (const key of tx.snapshot.records.keys()) if (key.startsWith(this.database.prefix(this.tenant))) tx.remove(key); });
  }
  backendDescription(): string { return 'interego (encrypted canonical PGSL artifacts; awaited native atomic commits; rebuildable xAPI view)'; }
  async getResource<T>(kind: string, id: string): Promise<T | null> { await this.database.ready(); return this.database.read<T>(await this.database.client.readHead(), this.tenant, kind, id); }
  async listResources<T>(kind: string): Promise<Array<[string, T]>> {
    await this.database.ready(); bounded(kind, 'record kind', 64);
    const head = await this.database.client.readHead(), prefix = this.database.prefix(this.tenant) + kind + '/', result: Array<[string, T]> = [];
    for (const [key, ref] of head.records) {
      if (!key.startsWith(prefix)) continue;
      const payload = readNativeByteArtifact(await this.database.client.readArtifact(ref));
      if (payload.owner !== this.database.owner || payload.contentType !== RECORD_TYPE) throw new Error('native LRS resource owner/type binding failed');
      const row = JSON.parse(Buffer.from(payload.bytes).toString('utf8')) as RecordEnvelope;
      if (row.format !== 'foxxi-native-lrs/1' || row.tenant !== this.tenant || row.kind !== kind || this.database.key(this.tenant, kind, row.id) !== key) throw new Error('native LRS resource binding failed');
      result.push([row.id, decodeValue(row.value) as T]);
    }
    return result;
  }
  async updateResource<T, R>(kind: string, id: string, mutate: (current: T | null) => { value: T | null; result: R }): Promise<R> {
    if (['statement', 'attachment', 'void', 'registry', 'query'].includes(kind)) throw new Error('use the immutable native LRS record methods');
    return this.database.transaction(async tx => {
      const next = mutate(await tx.read<T>(this.tenant, kind, id));
      if (next.value === null) tx.remove(this.database.key(this.tenant, kind, id));
      else { await tx.registerTenant(this.tenant); tx.write(this.tenant, kind, id, next.value); }
      return next.result;
    });
  }
  async putResource<T>(kind: string, id: string, value: T): Promise<void> { await this.updateResource<T, void>(kind, id, () => ({ value, result: undefined })); }
  async deleteResource(kind: string, id: string): Promise<void> { await this.updateResource<unknown, void>(kind, id, () => ({ value: null, result: undefined })); }
  async getAttachment(sha: string): Promise<LrsAttachment | null> {
    if (!/^[a-f0-9]{64}$/i.test(sha)) throw new Error('invalid LRS attachment hash');
    await this.database.ready();
    const ref = (await this.database.client.readHead()).records.get(this.database.key(this.tenant, 'attachment', sha.toLowerCase()));
    if (!ref) return null;
    const value = readNativeByteArtifact(await this.database.client.readArtifact(ref));
    if (value.owner !== this.database.owner || value.sha256 !== 'sha256:' + sha.toLowerCase()) throw new Error('native LRS attachment binding failed');
    return { data: Buffer.from(value.bytes), contentType: value.contentType };
  }
  /** Recover the query projection solely from complete verified native statement artifacts. */
  async rebuildQueryView(): Promise<void> {
    await this.database.transaction(async tx => {
      const prefix = this.database.prefix(this.tenant);
      for (const key of tx.snapshot.records.keys()) if (key.startsWith(prefix + 'query/')) tx.remove(key);
      for (const key of tx.snapshot.records.keys()) {
        if (!key.startsWith(prefix + 'statement/')) continue;
        const row = await this.database.readReference<StoredStatement>(tx.snapshot, key, this.tenant, 'statement');
        if (!row) throw new Error('native statement artifact disappeared');
        checkedStatement(row, row.id);
        const queryKey = this.database.queryKey(this.tenant, row);
        const reference = tx.snapshot.records.get(key);
        if (!reference) throw new Error('native statement reference disappeared');
        const source = await this.database.client.readArtifact(reference), top = source.nodes.get(source.topUri);
        if (!top) throw new Error('native statement top disappeared');
        // Preserve exact canonical nodes and their original provenance.
        tx.changes.set(queryKey, { key: queryKey, artifact: { topUri: source.topUri,
          pgsl: { atoms: new Map(), fragments: new Map(), nodes: new Map(source.nodes), defaultProvenance: top.provenance } } });
      }
    });
  }
}
