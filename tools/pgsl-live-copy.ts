/**
 * Offline target-only copy for the measured two-table PGSL database.
 * Source stays READ ONLY and SHARE-fenced through explicit volume handoff.
 * Never changes routing, source rows, or volumes; never retires the old volume.
 */
import { createHash } from 'node:crypto';
import { acquireCollectorLock, collectLive, hex, readerFromPg, type NodeTopologyRecord } from '../packages/pgsl-store/src/gc.js';
import { nodeAddrFromUrn } from '../packages/pgsl-store/src/addressing.js';
import { nodeKey, subspaceRange } from '../packages/pgsl-store/src/keyspace.js';

type Row = Record<string, unknown>;
export interface CopyClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
  on?(name: string, callback: (...args: unknown[]) => void): unknown;
  removeListener?(name: string, callback: (...args: unknown[]) => void): unknown;
  end(): Promise<unknown>;
}
export interface CopyOptions {
  readonly log?: (event: Row) => void;
  readonly maxInputBytes?: number;
  readonly maxTargetDatabaseBytes?: number;
  readonly maxValueBytes?: number;
  readonly payloadBatchBytes?: number;
  /** Only the isolated fixture may use different databases in one server. */
  readonly fixtureSameServer?: boolean;
}
/** Preparation starts synchronously; deadline/error cleanup must retain its writer fence. */
export const holdsPreparedFence = (state: string | undefined): boolean =>
  state === 'preparing-volume-cutover' || state === 'prepared-for-volume-cutover'
  || state === 'preparation-failed-source-fenced';
const TABLES = ['pgsl_kv', 'relay_pgsl_published'] as const;
const PREFIX = Buffer.from('pgsl\0');
const TAGS = new Set('NIBLRVOWPAXC');
const DERIVED = new Set('IBLRV');
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });
const quote = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('live copy refused: ' + message);
}
function tagOf(key: Uint8Array): string | null {
  return key.length >= 6 && Buffer.from(key.subarray(0, 5)).equals(PREFIX)
    ? String.fromCharCode(key[5]!) : null;
}
function missingDerived(key: Uint8Array): boolean {
  const tag = tagOf(key);
  return tag !== null && (DERIVED.has(tag) || tag === 'P' && key.length >= 10
    && Buffer.from(key).readUInt32BE(key.length - 4) === 2);
}
function frame(hash: ReturnType<typeof createHash>, key: Buffer, value: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(key.length)); hash.update(length); hash.update(key);
  length.writeBigUInt64BE(BigInt(value.length)); hash.update(length); hash.update(value);
}
function nodeTopology(key: Buffer, value: Buffer, retained: ReadonlySet<string>): NodeTopologyRecord {
  invariant(key.length === 27 && tagOf(key) === 'N' && (key[6] === 1 || key[6] === 2), 'invalid retained node key');
  const parsed: unknown = JSON.parse(fatalUtf8.decode(value));
  invariant(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'invalid retained node JSON');
  const body = parsed as Row;
  invariant(typeof body.uri === 'string', 'node identifier missing');
  invariant(Buffer.from(nodeKey(nodeAddrFromUrn(body.uri))).equals(key), 'node identifier/key mismatch');
  invariant(body.kind === (key[6] === 1 ? 'atom' : 'fragment'), 'node kind/key mismatch');
  invariant(Number.isSafeInteger(body.level) && (body.level as number) >= 0, 'invalid node level');
  if (body.kind === 'atom') {
    invariant(body.level === 0, 'invalid atom level');
    return { topology: { kind: 'atom', level: 0 }, byteLength: value.length };
  }
  invariant(body.items == null || Array.isArray(body.items) && body.items.every(x => typeof x === 'string'), 'invalid fragment items');
  invariant(body.left == null || typeof body.left === 'string', 'invalid fragment left edge');
  invariant(body.right == null || typeof body.right === 'string', 'invalid fragment right edge');
  const edges = [...((body.items as string[] | undefined) ?? []), body.left, body.right];
  for (const edge of edges) {
    if (typeof edge !== 'string') continue;
    let child: Uint8Array;
    try { child = nodeKey(nodeAddrFromUrn(edge)); } catch { continue; }
    invariant(retained.has(hex(child)), 'full node body references an unretained child');
  }
  return { topology: { kind: 'fragment', level: body.level as number,
    items: body.items as string[] | undefined, left: body.left as string | undefined,
    right: body.right as string | undefined }, byteLength: value.length };
}
async function identity(client: CopyClient): Promise<Row> {
  const result = await client.query("SELECT current_database() AS db,current_user AS role,current_setting('server_version_num') AS version,(SELECT system_identifier::text FROM pg_control_system()) AS system_id,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,(SELECT json_build_object('encoding',encoding,'collate',datcollate,'ctype',datctype,'provider',datlocprovider,'icu',daticulocale) FROM pg_database WHERE datname=current_database()) AS locale");
  invariant(result.rows.length === 1, 'database identity unavailable');
  return result.rows[0]!;
}
function validRelayAcl(acl: unknown, owner: string): boolean {
  if (!Array.isArray(acl) || acl.length !== 11) return false;
  const ownerRights = new Set(['INSERT','SELECT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']);
  const relayRights = new Set(['INSERT','SELECT','UPDATE','DELETE']);
  for (const entry of acl as Row[]) {
    if (entry.grantor !== owner || entry.grantable !== false) return false;
    const rights = entry.grantee === owner ? ownerRights : entry.grantee === 'relay_pgsl' ? relayRights : null;
    if (!rights?.delete(String(entry.privilege))) return false;
  }
  return ownerRights.size === 0 && relayRights.size === 0;
}
async function copyRelayRole(source: CopyClient, target: CopyClient): Promise<void> {
  const query = "SELECT r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil::text,r.rolconfig,a.rolpassword FROM pg_roles r JOIN pg_authid a ON a.oid=r.oid WHERE r.rolname='relay_pgsl'";
  const original = await source.query(query);
  invariant(original.rows.length === 1, 'reviewed relay role is missing');
  const role = original.rows[0]!;
  invariant(role.rolsuper === false && role.rolinherit === true && role.rolcreaterole === false
    && role.rolcreatedb === false && role.rolcanlogin === true && role.rolreplication === false
    && role.rolbypassrls === false && role.rolconnlimit === -1 && role.rolvaliduntil === null
    && (role.rolconfig === null || Array.isArray(role.rolconfig) && role.rolconfig.length === 0), 'relay role has unreviewed attributes or settings');
  const memberships = await source.query("SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE parent.rolname='relay_pgsl' OR child.rolname='relay_pgsl'");
  invariant(memberships.rows[0]!.n === 0, 'relay role memberships require separate preservation');
  invariant(typeof role.rolpassword === 'string'
    && /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/.test(role.rolpassword), 'relay password is not a reviewed SCRAM verifier');
  const targetMemberships = await target.query("SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles child ON child.oid=m.member WHERE parent.rolname='relay_pgsl' OR child.rolname='relay_pgsl'");
  invariant(targetMemberships.rows[0]!.n === 0, 'target relay role memberships differ');
  const existing = await target.query(query);
  if (existing.rows.length) {
    invariant(existing.rows.length === 1 && JSON.stringify(existing.rows[0]) === JSON.stringify(role), 'existing target relay role differs');
    return;
  }
  // Suppress statement/parameter/error-statement logging for this transaction.
  // The verifier travels only in process memory and a private DB
  // session; it is never returned, logged, or written into the code artifact.
  await target.query('BEGIN');
  try {
    await target.query("SET LOCAL log_statement='none'");
    await target.query("SET LOCAL log_min_duration_statement='-1'");
    await target.query("SET LOCAL log_min_duration_sample='-1'");
    await target.query("SET LOCAL log_parameter_max_length='0'");
    await target.query("SET LOCAL log_parameter_max_length_on_error='0'");
    await target.query("SET LOCAL log_min_error_statement='panic'");
    await target.query("CREATE ROLE relay_pgsl LOGIN NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD '" + role.rolpassword + "'");
    await target.query('COMMIT');
  } catch {
    await target.query('ROLLBACK').catch(() => undefined);
    throw new Error('live copy refused: relay credential copy failed');
  }
  const copied = await target.query(query);
  invariant(copied.rows.length === 1 && JSON.stringify(copied.rows[0]) === JSON.stringify(role), 'copied relay role differs');
}

async function schema(client: CopyClient, empty: boolean): Promise<Row[]> {
  const current = await client.query('SELECT current_user AS role');
  const owner = String(current.rows[0]!.role);
  const relation = await client.query("SELECT n.nspname AS schema,c.relname,pg_get_userbyid(c.relowner) AS owner,(SELECT json_agg(json_build_object('grantee',pg_get_userbyid(a.grantee),'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type) FROM aclexplode(c.relacl) a) AS acl,c.relkind,c.relpersistence,c.relrowsecurity,c.relacl,c.relreplident,c.reloptions,tc.reloptions AS toast_options FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_class tc ON tc.oid=c.reltoastrelid WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','m','v','S','f') ORDER BY n.nspname,c.relname");
  if (empty) invariant(relation.rows.length === 0, 'destination contains user relations');
  else invariant(relation.rows.length === 2 && relation.rows.every((r, i) => r.schema === 'public'
    && r.relname === [...TABLES].sort()[i] && r.relkind === 'r' && r.relpersistence === 'p'
    && r.relrowsecurity === false && r.owner === owner && r.relreplident === 'd'
    && (r.relname === 'pgsl_kv' ? r.relacl === null : validRelayAcl(r.acl, owner))), 'source schema differs from the reviewed two-table allowlist');
  const extras = await client.query("SELECT (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%')::int AS schemas,(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%')::int AS routines,(SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql')::int AS extensions,(SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal)::int AS triggers,(SELECT count(*) FROM pg_largeobject_metadata)::int AS large_objects,(SELECT count(*) FROM pg_default_acl)::int AS default_acls,(SELECT count(*) FROM pg_foreign_server)::int AS foreign_servers,(SELECT count(*) FROM pg_publication)::int AS publications,(SELECT count(*) FROM pg_subscription)::int AS subscriptions,(SELECT count(*) FROM pg_policy)::int AS policies,(SELECT count(*) FROM pg_description d JOIN pg_class c ON d.classoid='pg_class'::regclass AND d.objoid=c.oid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')::int AS comments");
  invariant(extras.rows.length === 1 && Object.values(extras.rows[0]!).every(value => Number(value) === 0), 'unhandled database objects would be lost');
  if (empty) return [];
  for (const table of TABLES) {
    const columns = await client.query("SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,a.attacl,a.attstorage,a.attcompression,pg_get_expr(d.adbin,d.adrelid) AS default_expr FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", ['public.' + table]);
    invariant(columns.rows.length === 2 && columns.rows.every((r, i) => r.attname === ['k', 'v'][i]
      && r.type === 'bytea' && r.attnotnull === true && r.attidentity === '' && r.attgenerated === ''
      && r.attacl === null && r.default_expr === null), 'unhandled table columns');
    const constraints = await client.query("SELECT conname,contype,condeferrable,condeferred,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass", ['public.' + table]);
    invariant(constraints.rows.length === 1 && constraints.rows[0]!.contype === 'p'
      && constraints.rows[0]!.condeferrable === false && constraints.rows[0]!.convalidated === true
      && constraints.rows[0]!.definition === 'PRIMARY KEY (k)', 'unhandled table constraint');
    const indexes = await client.query("SELECT count(*)::int AS n FROM pg_index WHERE indrelid=$1::regclass", ['public.' + table]);
    invariant(indexes.rows[0]!.n === 1, 'unhandled table indexes');
    Object.assign(relation.rows.find(r => r.relname === table)!, { columns: columns.rows, primaryKey: constraints.rows[0]!.conname });
  }
  return relation.rows;
}
function storageOptions(values: unknown, toast = false): string[] {
  invariant(values === null || Array.isArray(values), 'invalid storage settings');
  return ((values as string[] | null) ?? []).map(value => {
    invariant(/^[a-z_]+=[A-Za-z0-9_.-]+$/.test(value), 'unrecognized storage setting');
    return (toast ? 'toast.' : '') + value;
  });
}
async function createTables(target: CopyClient, definitions: Row[]): Promise<void> {
  for (const table of TABLES) {
    const def = definitions.find(row => row.relname === table)!;
    await target.query('CREATE TABLE public.' + quote(table) + ' (k bytea NOT NULL,v bytea NOT NULL,CONSTRAINT ' + quote(String(def.primaryKey)) + ' PRIMARY KEY(k))');
    const settings = [...storageOptions(def.reloptions), ...storageOptions(def.toast_options, true)];
    if (settings.length) await target.query('ALTER TABLE public.' + quote(table) + ' SET (' + settings.join(',') + ')');
    for (const column of def.columns as Row[]) {
      const mode = ({ p: 'PLAIN', e: 'EXTERNAL', x: 'EXTENDED', m: 'MAIN' } as Record<string, string>)[String(column.attstorage)];
      invariant(mode, 'unrecognized column storage');
      await target.query('ALTER TABLE public.' + quote(table) + ' ALTER COLUMN ' + quote(String(column.attname)) + ' SET STORAGE ' + mode);
      if (column.attcompression) {
        const compression = ({ p: 'pglz', l: 'lz4' } as Record<string, string>)[String(column.attcompression)];
        invariant(compression, 'unrecognized column compression');
        await target.query('ALTER TABLE public.' + quote(table) + ' ALTER COLUMN ' + quote(String(column.attname)) + ' SET COMPRESSION ' + compression);
      }
    }
  }
  await target.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.relay_pgsl_published TO relay_pgsl');
}
function candidateReader(source: CopyClient) {
  // Sizing only: atoms are leaves under the N-key contract. Complete bodies are
  // independently validated during copy, before any ready receipt is possible.
  return readerFromPg({ query(sql: string, params?: unknown[]) {
    if (sql.includes('AS atom_header') && sql.includes('UNION ALL')) {
      sql = sql.replace(/substring\(source\.v FROM 1 FOR \d+\) AS atom_header/, 'NULL::bytea AS atom_header')
        .replace('false AS needs_js_parse, NULL::json AS topology', "false AS needs_js_parse, json_build_object('kind','atom','level',0) AS topology");
    }
    return source.query(sql, params);
  } });
}
function validateControl(key: Buffer, value: Buffer): void {
  const tag = tagOf(key);
  if (tag === 'C') JSON.parse(fatalUtf8.decode(value));
  if (tag === 'O') nodeAddrFromUrn(fatalUtf8.decode(value));
}
interface Summary { rows: number; bytes: number; digest: string; }
export interface LiveCopySession {
  readonly receipt: Row;
  readonly state: string;
  /** Target disconnect is explicit; source disconnect becomes expected only now. */
  prepareVolumeCutover(): Promise<Row>;
  /** Before preparation only: abandons the target and restores the old database. */
  abortBeforeCutover(): Promise<void>;
}
export async function copyLiveDatabase(source: CopyClient, target: CopyClient, options: CopyOptions = {}): Promise<LiveCopySession> {
  const log = options.log ?? (() => undefined);
  const maxInput = options.maxInputBytes ?? 40_000_000_000;
  const maxDatabase = options.maxTargetDatabaseBytes ?? 48_000_000_000;
  const maxValue = options.maxValueBytes ?? 128 * 1024 * 1024;
  const maxBatch = options.payloadBatchBytes ?? 8 * 1024 * 1024;
  for (const value of [maxInput, maxDatabase, maxValue, maxBatch]) invariant(Number.isSafeInteger(value) && value > 0, 'invalid copy budget');
  let state = 'copying', failure: Error | undefined, fenced = false, targetFenced = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let releaseCollector: (() => Promise<void>) | undefined;
  const loseFence = () => {
    if (state === 'prepared-for-volume-cutover') { if (heartbeat) clearInterval(heartbeat); state = 'source-disconnected-after-preparation'; log({ kind: state }); return; }
    if (state === 'aborted' || state === 'source-disconnected-after-preparation') return;
    failure ??= new Error('live copy refused: source fence connection was lost');
    if (state === 'verified-source-fenced' || state === 'preparing-volume-cutover' || state === 'preparation-failed-source-fenced') { state = 'failed-source-fence-lost'; if (heartbeat) clearInterval(heartbeat); }
    void target.end().catch(() => undefined);
  };
  source.on?.('error', loseFence); source.on?.('end', loseFence);
  const check = () => { if (failure) throw failure; };
  const sq = async (sql: string, params?: unknown[]) => { check(); const result = await source.query(sql, params); check(); return result; };
  const tq = async (sql: string, params?: unknown[]) => { check(); const result = await target.query(sql, params); check(); return result; };
  const clean = async () => {
    if (heartbeat) clearInterval(heartbeat);
    if (targetFenced) await target.query('ROLLBACK').catch(() => undefined);
    if (fenced) await source.query('ROLLBACK').catch(() => undefined);
    await releaseCollector?.().catch(() => undefined);
    source.removeListener?.('error', loseFence); source.removeListener?.('end', loseFence);
  };
  try {
    const from = await identity(source), to = await identity(target);
    invariant(from.system_id !== to.system_id || options.fixtureSameServer === true
      && from.database_oid !== to.database_oid && from.db !== to.db, 'destination is the source server/database');
    invariant(Math.floor(Number(from.version) / 10000) === 16 && Math.floor(Number(to.version) / 10000) === 16, 'requires reviewed PostgreSQL 16');
    invariant(JSON.stringify(from.locale) === JSON.stringify(to.locale), 'database locales differ');
    await schema(target, true);
    releaseCollector = await acquireCollectorLock(source, 'pgsl_kv');
    await sq('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    fenced = true;
    await sq("SET LOCAL statement_timeout='30s'");
    await sq("SET LOCAL idle_in_transaction_session_timeout='45s'");
    // No snapshot SELECT occurs between BEGIN and these two writer fences.
    await sq('LOCK TABLE public.pgsl_kv,public.relay_pgsl_published IN SHARE MODE NOWAIT');
    heartbeat = setInterval(() => { void source.query('SELECT 1').catch(loseFence); }, 10_000);
    const definitions = await schema({ ...source, query: sq, end: () => source.end() }, false);
    const namespaces = await sq("SELECT encode(substring(k FROM 1 FOR 6),'hex') AS prefix FROM public.pgsl_kv GROUP BY substring(k FROM 1 FOR 6)");
    for (const row of namespaces.rows) {
      const key = Buffer.from(String(row.prefix), 'hex');
      invariant(key.length === 6 && tagOf(key) !== null && TAGS.has(tagOf(key)!), 'unknown KV namespace must not be discarded');
    }
    const n = subspaceRange('N');
    const malformed = await sq("SELECT count(*)::int AS n FROM public.pgsl_kv WHERE k >= $1 AND k < $2 AND (octet_length(k)<>27 OR CASE WHEN octet_length(k)>6 THEN get_byte(k,6) ELSE -1 END NOT IN (1,2))", [Buffer.from(n.begin), Buffer.from(n.end)]);
    invariant(malformed.rows[0]!.n === 0, 'malformed N keys require separate review');
    const candidate = await collectLive(candidateReader({ ...source, query: sq, end: () => source.end() }), { log: line => log({ kind: 'closure', line }) });
    invariant(candidate.keys.size > 0 && candidate.stats.danglingRoots.length === 0
      && candidate.stats.unreadableNodes === 0, 'candidate closure is incomplete');
    const wanted = [...candidate.keys].sort(), actual: string[] = [];
    const missing: Record<string, number> = {};
    let inputBytes = 0, inputKeyBytes = 0, largestValue = 0;
    for (let offset = 0; offset < wanted.length; offset += 4096) {
      const keys = wanted.slice(offset, offset + 4096), expected = new Set(keys);
      const result = await sq('SELECT k,octet_length(v) AS bytes FROM public.pgsl_kv WHERE k=ANY($1::bytea[]) ORDER BY k', [keys.map(k => Buffer.from(k, 'hex'))]);
      for (const row of result.rows) {
        invariant(Buffer.isBuffer(row.k) && Number.isSafeInteger(row.bytes) && (row.bytes as number) >= 0, 'invalid retained row metadata');
        const h = row.k.toString('hex');
        invariant(expected.delete(h), 'unexpected or duplicate retained row');
        invariant((row.bytes as number) <= maxValue, 'retained value exceeds the reviewed memory bound');
        actual.push(h); inputBytes += row.bytes as number; inputKeyBytes += row.k.length;
        largestValue = Math.max(largestValue, row.bytes as number);
      }
      for (const h of expected) {
        const key = Buffer.from(h, 'hex');
        invariant(missingDerived(key), 'a retained root or node is missing from the source');
        const tag = tagOf(key)!; missing[tag] = (missing[tag] ?? 0) + 1;
      }
    }
    invariant(inputBytes <= maxInput, 'retained input exceeds the reviewed 64 GB target budget');
    invariant(inputBytes * 1.2 + inputKeyBytes * 2 + actual.length * 160 < maxDatabase, 'retained storage estimate exceeds target reserve');
    log({ kind: 'preflight', actualRows: actual.length, serializedBytes: inputBytes, largestValue, missingDerived: missing });
    await copyRelayRole({ ...source, query: sq, end: () => source.end() }, { ...target, query: tq, end: () => target.end() });
    await createTables({ ...target, query: tq, end: () => target.end() }, definitions);
    const boundedRows = async (client: { query: typeof sq }, table: string, keys: string[], consume: (key: Buffer, value: Buffer) => void | Promise<void>) => {
      const meta = await client.query('SELECT k,octet_length(v) AS bytes FROM public.' + quote(table) + ' WHERE k=ANY($1::bytea[]) ORDER BY k', [keys.map(k => Buffer.from(k, 'hex'))]);
      invariant(meta.rows.length === keys.length, 'planned source rows changed');
      let group: Buffer[] = [], bytes = 0;
      const flush = async () => {
        if (!group.length) return;
        const rows = await client.query('SELECT k,v FROM public.' + quote(table) + ' WHERE k=ANY($1::bytea[]) ORDER BY k', [group]);
        invariant(rows.rows.length === group.length, 'payload batch lost rows');
        for (let i = 0; i < rows.rows.length; i++) {
          const row = rows.rows[i]!;
          invariant(Buffer.isBuffer(row.k) && row.k.equals(group[i]!) && Buffer.isBuffer(row.v), 'payload row/key mismatch');
          await consume(row.k, row.v);
          rows.rows[i] = {}; // release opaque bytes immediately
        }
        group = []; bytes = 0;
      };
      for (const row of meta.rows) {
        invariant(Buffer.isBuffer(row.k) && Number.isSafeInteger(row.bytes) && (row.bytes as number) <= maxValue, 'invalid payload plan');
        if (group.length && (group.length >= 128 || bytes + (row.bytes as number) > maxBatch)) await flush();
        group.push(row.k); bytes += row.bytes as number;
      }
      await flush();
    };
    const copy = async (table: string, keys: string[], validate: boolean): Promise<Summary> => {
      const digest = createHash('sha256'); let rows = 0, bytes = 0, lastCheck = 0;
      let pending: Buffer[] = [], pendingBytes = 0;
      const insert = async () => {
        if (!pending.length) return;
        const count = pending.length / 2;
        const placeholders = Array.from({ length: count }, (_, i) => '($' + (i * 2 + 1) + '::bytea,$' + (i * 2 + 2) + '::bytea)').join(',');
        const result = await tq('INSERT INTO public.' + quote(table) + '(k,v) VALUES ' + placeholders, pending);
        invariant(result.rowCount === count, 'target insert count differs');
        pending = []; pendingBytes = 0;
        if (bytes - lastCheck >= 64 * 1024 * 1024) {
          const size = await tq('SELECT pg_database_size(current_database())::text AS bytes');
          invariant(Number(size.rows[0]!.bytes) < maxDatabase, 'target database crossed its fixed budget');
          lastCheck = bytes; log({ kind: 'copied', table, rows, bytes });
        }
      };
      for (let offset = 0; offset < keys.length; offset += 4096) {
        await boundedRows({ query: sq }, table, keys.slice(offset, offset + 4096), async (key, value) => {
          if (validate) { validateControl(key, value); if (tagOf(key) === 'N') nodeTopology(key, value, candidate.keys); }
          frame(digest, key, value); rows++; bytes += value.length;
          if (pending.length && (pending.length >= 256 || pendingBytes + value.length > maxBatch)) await insert();
          pending.push(key, value); pendingBytes += value.length;
        });
        await insert();
      }
      return { rows, bytes, digest: digest.digest('hex') };
    };
    const relayKeys: string[] = [];
    let relayCursor = Buffer.alloc(0);
    for (;;) {
      const rows = await sq('SELECT k,octet_length(v) AS bytes FROM public.relay_pgsl_published WHERE k>$1 ORDER BY k LIMIT 4096', [relayCursor]);
      if (!rows.rows.length) break;
      for (const row of rows.rows) { invariant(Buffer.isBuffer(row.k) && Number.isSafeInteger(row.bytes) && (row.bytes as number) <= maxValue, 'invalid relay row size'); relayKeys.push(row.k.toString('hex')); inputBytes += row.bytes as number; }
      relayCursor = rows.rows.at(-1)!.k as Buffer;
    }
    // Empty bytea is a legal relay key and must be copied too.
    const emptyRelay = await sq("SELECT k,octet_length(v) AS bytes FROM public.relay_pgsl_published WHERE k=''::bytea");
    if (emptyRelay.rows.length) { relayKeys.unshift(''); inputBytes += Number(emptyRelay.rows[0]!.bytes); }
    invariant(inputBytes <= maxInput, 'combined retained tables exceed the input budget');
    const copiedKv = await copy('pgsl_kv', actual, true);
    const copiedRelay = await copy('relay_pgsl_published', relayKeys, false);
    await tq('ANALYZE public.pgsl_kv,public.relay_pgsl_published');
    await sq('SELECT 1'); // prove the source fence survived the last target write
    await tq('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); targetFenced = true;
    await tq('LOCK TABLE public.pgsl_kv,public.relay_pgsl_published IN SHARE MODE NOWAIT');
    await tq("SET LOCAL statement_timeout='30s'");
    const topologies = new Map<string, NodeTopologyRecord>();
    const verify = async (table: string, expected: Summary): Promise<void> => {
      const digest = createHash('sha256'); let rows = 0, bytes = 0;
      let cursor: Buffer | null = null;
      for (;;) {
        const meta = await tq('SELECT k FROM public.' + quote(table) + (cursor === null ? '' : ' WHERE k>$1') + ' ORDER BY k LIMIT 4096', cursor === null ? [] : [cursor]);
        if (!meta.rows.length) break;
        const keys = meta.rows.map(row => { invariant(Buffer.isBuffer(row.k), 'invalid target key'); return row.k.toString('hex'); });
        await boundedRows({ query: tq }, table, keys, (key, value) => {
          frame(digest, key, value); rows++; bytes += value.length;
          if (table === 'pgsl_kv') validateControl(key, value);
          if (table === 'pgsl_kv' && tagOf(key) === 'N') topologies.set(key.toString('hex'), nodeTopology(key, value, candidate.keys));
        });
        cursor = Buffer.from(keys.at(-1)!, 'hex');
      }
      invariant(rows === expected.rows && bytes === expected.bytes && digest.digest('hex') === expected.digest, 'target byte digest differs for ' + table);
    };
    await verify('pgsl_kv', copiedKv); await verify('relay_pgsl_published', copiedRelay);
    const targetReader = readerFromPg({ query: tq });
    targetReader.getManyTopology = async keys => new Map(keys.filter(key => topologies.has(hex(key))).map(key => [hex(key), topologies.get(hex(key))!]));
    const independent = await collectLive(targetReader);
    invariant(independent.stats.danglingRoots.length === 0 && independent.stats.unreadableNodes === 0
      && independent.keys.size === candidate.keys.size && [...candidate.keys].every(key => independent.keys.has(key)), 'independent full-body target closure differs');
    invariant(independent.stats.liveNodeBytes === candidate.stats.liveNodeBytes, 'validated node byte count differs');
    const targetSize = await tq('SELECT pg_database_size(current_database())::text AS bytes');
    invariant(Number(targetSize.rows[0]!.bytes) < maxDatabase, 'verified target exceeds database budget');
    await schema({ ...source, query: sq, end: () => source.end() }, false);
    await schema({ ...target, query: tq, end: () => target.end() }, false);
    await tq('ROLLBACK'); targetFenced = false;
    await sq('SELECT 1');
    state = 'verified-source-fenced';
    const receipt: Row = { kind: 'verified-source-fenced', source: from, target: to, kv: copiedKv,
      relay: copiedRelay, targetDatabaseBytes: Number(targetSize.rows[0]!.bytes),
      liveNodes: independent.stats.liveNodes, retainedKeyPromises: candidate.keys.size,
      actualCopiedKeys: actual.length, missingDerived: missing, verifiedAt: new Date().toISOString() };
    log(receipt);
    return {
      receipt, get state() { return state; },
      async prepareVolumeCutover() {
        invariant(state === 'verified-source-fenced', 'copy is not ready for volume cutover');
        // Claim the transition before yielding so abort and duplicate prepare cannot release the fence.
        state = 'preparing-volume-cutover';
        try {
          await sq('SELECT 1');
          invariant(state === 'preparing-volume-cutover', 'source fence failed during preparation');
          await target.end();
          await sq('SELECT 1');
          invariant(state === 'preparing-volume-cutover', 'source fence failed during preparation');
          state = 'prepared-for-volume-cutover';
          log({ kind: state, targetSystemId: to.system_id });
          return { ...receipt, kind: state };
        } catch {
          if (state === 'preparing-volume-cutover') state = 'preparation-failed-source-fenced';
          throw new Error('live copy refused: volume preparation failed');
        }
      },
      async abortBeforeCutover() {
        invariant(state === 'verified-source-fenced', 'prepared cutover requires operator recovery, not automatic cleanup');
        state = 'aborted'; await clean();
      },
    };
  } catch (error) {
    state = 'aborted'; await clean();
    // Never include SQL/JSON payloads or connection strings in the error.
    if (error instanceof Error && error.message.startsWith('live copy refused:')) throw error;
    throw new Error('live copy refused: copy or verification failed');
  }
}
