/**
 * Bounded metadata only: no node bodies, credentials, resource keys or learner payloads.
 * Uses the existing Railway project token and an ALREADY provisioned Postgres proxy.
 * It cannot create a proxy, compact a table, or change data/configuration.
 *
 * RAILWAY_PROJECT_TOKEN=... node --import=tsx tools/pgsl-store-inventory.ts
 */
import { pathToFileURL } from 'node:url';
import { subspaceRange, SUBSPACE_PAYLOAD_OFFSET } from '../packages/pgsl-store/src/keyspace.js';

export const MAX_RUNTIME_MS = 60_000;
export const DEFAULT_CONTROL_LIMIT = 10_000;
export const MAX_CONTROL_LIMIT = 50_000;
const QUERY_MS = 5_000;
const ENDPOINT = 'https://backboard.railway.com/graphql/v2';
type Row = Record<string, unknown>;
export interface Query { text: string; values?: unknown[]; query_timeout: number; }
export interface InventoryClient {
  query(query: Query): Promise<{ rows: Row[] }>;
}
type Gql = (query: string, variables?: Row) => Promise<Row>;

class InventoryError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
export function safeFailure(error: unknown): Row {
  const reason = error instanceof InventoryError ? error.reason : 'query_unavailable';
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return { status: 'unavailable', reason, ...(typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? { sqlstate: code } : {}) };
}
export function controlLimit(value: unknown = DEFAULT_CONTROL_LIMIT): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > MAX_CONTROL_LIMIT) throw new InventoryError('invalid_control_limit');
  return n;
}
function object(value: unknown): value is Row { return !!value && typeof value === 'object' && !Array.isArray(value); }
function decimal(value: unknown): string | null {
  const s = String(value ?? '');
  return /^\d{1,30}(?:\.\d{1,6})?$/.test(s) ? s : null;
}
function date(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
const CATEGORIES = ['native_lrs_artifact', 'native_lrs_commit', 'native_lrs_head', 'gaming_head',
  'own_subject_head', 'shared_lattice_head', 'immutable_lattice_holon', 'context_graph',
  'agent_registry', 'other_ldp_resource', 'other_control_record', 'malformed_control_key'];
const APPS = ['inventory', 'collector', 'unset', 'other'];
const STATES = ['active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'disabled', 'other'];
const WAITS = ['Activity', 'Client', 'Extension', 'IO', 'IPC', 'Lock', 'LWLock', 'BufferPin', 'Timeout', 'none', 'other'];

/** Whitelist output fields; even an unexpected driver/server row cannot print a payload. */
export function projectRows(section: string, rows: readonly Row[]): Row[] {
  return rows.slice(0, 128).map(row => {
    const out: Row = {};
    if (section === 'relations') {
      const label = String(row.relation ?? '');
      out.relation = ['pgsl_kv', 'pgsl_kv_old'].includes(label) || /^pgsl_kv_old_\d{8}(?:_\d{9})?$/.test(label) ? label : 'other_public_tables';
    }
    if (section === 'control_categories') out.category = CATEGORIES.includes(String(row.category)) ? row.category : 'other_control_record';
    if (section === 'sessions') {
      out.application = APPS.includes(String(row.application)) ? row.application : 'other';
      out.state = STATES.includes(String(row.state)) ? row.state : 'other';
      out.wait_type = WAITS.includes(String(row.wait_type)) ? row.wait_type : 'other';
    }
    const fields: Record<string, string[]> = {
      database: ['database_bytes', 'server_version_num'],
      relations: ['tables', 'relation_total_bytes', 'heap_main_bytes', 'table_bytes_including_toast', 'indexes_bytes', 'toast_total_bytes', 'estimated_live_tuples', 'estimated_dead_tuples'],
      wal: ['files', 'wal_bytes'], slots: ['slots', 'active_slots', 'sum_slot_retained_wal_bytes', 'max_slot_retained_wal_bytes'],
      sessions: ['sessions', 'oldest_transaction_seconds'],
      control_categories: ['records', 'control_key_bytes', 'control_metadata_bytes', 'represented_resource_bytes', 'size_metadata_records', 'invalid_size_metadata_records'],
    };
    for (const key of fields[section] ?? []) out[key] = decimal(row[key]);
    if (section === 'relations') for (const key of ['last_vacuum', 'last_autovacuum', 'last_analyze', 'last_autoanalyze']) out[key] = date(row[key]);
    if (section === 'control_categories') out.truncated = row.truncated === true;
    return out;
  });
}

export const SQL = {
  database: `SELECT pg_database_size(current_database())::text AS database_bytes,
    current_setting('server_version_num') AS server_version_num`,
  relations: `SELECT CASE WHEN c.relname IN ('pgsl_kv', 'pgsl_kv_old') OR c.relname ~ '^pgsl_kv_old_[0-9]{8}(_[0-9]{9})?$'
      THEN c.relname ELSE 'other_public_tables' END AS relation, count(*)::text AS tables,
    sum(pg_total_relation_size(c.oid))::text AS relation_total_bytes,
    sum(pg_relation_size(c.oid))::text AS heap_main_bytes,
    sum(pg_table_size(c.oid))::text AS table_bytes_including_toast,
    sum(pg_indexes_size(c.oid))::text AS indexes_bytes,
    sum(CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END)::text AS toast_total_bytes,
    sum(coalesce(s.n_live_tup, 0))::text AS estimated_live_tuples,
    sum(coalesce(s.n_dead_tup, 0))::text AS estimated_dead_tuples,
    max(s.last_vacuum) AS last_vacuum, max(s.last_autovacuum) AS last_autovacuum,
    max(s.last_analyze) AS last_analyze, max(s.last_autoanalyze) AS last_autoanalyze
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'm') GROUP BY 1 ORDER BY sum(pg_total_relation_size(c.oid)) DESC LIMIT 129`,
  wal: `SELECT count(*)::text AS files, coalesce(sum(size), 0)::text AS wal_bytes FROM pg_ls_waldir()`,
  slots: `SELECT count(*)::text AS slots, count(*) FILTER (WHERE active)::text AS active_slots,
    coalesce(sum(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)), 0)::text AS sum_slot_retained_wal_bytes,
    coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)), 0)::text AS max_slot_retained_wal_bytes FROM pg_replication_slots`,
  sessions: `SELECT CASE WHEN application_name = 'pgsl-storage-inventory' THEN 'inventory'
      WHEN application_name LIKE 'pgsl-store-gc%' THEN 'collector' WHEN application_name = '' THEN 'unset' ELSE 'other' END AS application,
    CASE WHEN state IN ('active', 'idle', 'idle in transaction', 'idle in transaction (aborted)', 'fastpath function call', 'disabled') THEN state ELSE 'other' END AS state,
    CASE WHEN wait_event_type IN ('Activity', 'Client', 'Extension', 'IO', 'IPC', 'Lock', 'LWLock', 'BufferPin', 'Timeout') THEN wait_event_type
      WHEN wait_event_type IS NULL THEN 'none' ELSE 'other' END AS wait_type,
    count(*)::text AS sessions, greatest(0, coalesce(max(extract(epoch FROM clock_timestamp() - xact_start)), 0))::text AS oldest_transaction_seconds
    FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1, 2, 3 ORDER BY count(*) DESC LIMIT 129`,
  // This reads C resource-head metadata only. Actual N/I/B/etc lattice values are never read.
  // The bytea separator is deliberate: the NUL-delimited key is not PostgreSQL text.
  control_categories: `WITH candidates AS MATERIALIZED (
      SELECT k, v FROM public.pgsl_kv WHERE k >= $1 AND k < $2 ORDER BY k LIMIT ($3::integer + 1)
    ), sampled AS MATERIALIZED (SELECT k, v FROM candidates ORDER BY k LIMIT $3),
    split AS (SELECT k, v, substring(k FROM $4::integer) AS payload FROM sampled),
    parts AS (SELECT k, v, payload, position(decode('00', 'hex') IN payload) AS separator FROM split),
    resource_keys AS (SELECT k, v, separator,
      substring(payload FROM 1 FOR 4) = convert_to('ldp ', 'UTF8') AS ldp,
      substring(payload FROM separator + 1) AS resource FROM parts),
    classified AS (SELECT *, CASE
      WHEN separator = 0 THEN 'malformed_control_key'
      WHEN NOT ldp THEN 'other_control_record'
      WHEN position(convert_to('lrs/native/artifacts/artifact-', 'UTF8') IN resource) > 0 THEN 'native_lrs_artifact'
      WHEN position(convert_to('lrs/native/artifacts/commit-', 'UTF8') IN resource) > 0 THEN 'native_lrs_commit'
      WHEN position(convert_to('lrs/native/head', 'UTF8') IN resource) > 0 THEN 'native_lrs_head'
      WHEN position(convert_to('gaming/head', 'UTF8') IN resource) > 0 THEN 'gaming_head'
      WHEN position(convert_to('activity/own-subject/head', 'UTF8') IN resource) > 0 THEN 'own_subject_head'
      WHEN position(convert_to('foxxi-lattice/shared-lattice.holon.json', 'UTF8') IN resource) > 0 THEN 'shared_lattice_head'
      WHEN position(convert_to('foxxi-lattice/holon-', 'UTF8') IN resource) > 0 THEN 'immutable_lattice_holon'
      WHEN position(convert_to('context-graphs/', 'UTF8') IN resource) > 0 THEN 'context_graph'
      WHEN resource = convert_to('agents', 'UTF8')
        OR substring(resource FROM greatest(1, octet_length(resource) - 6)) = convert_to('/agents', 'UTF8') THEN 'agent_registry'
      ELSE 'other_ldp_resource' END AS category,
      CASE WHEN ldp AND separator > 0 THEN CASE WHEN convert_from(v, 'UTF8') IS JSON OBJECT
        THEN convert_from(v, 'UTF8')::jsonb ELSE NULL END ELSE NULL END AS metadata
      FROM resource_keys),
    sizes AS (SELECT *, CASE WHEN jsonb_typeof(metadata->'size') = 'number' THEN CASE
      WHEN (metadata->>'size')::numeric BETWEEN 0 AND 9007199254740991
        AND trunc((metadata->>'size')::numeric) = (metadata->>'size')::numeric
      THEN (metadata->>'size')::numeric ELSE NULL END ELSE NULL END AS represented_bytes FROM classified)
    SELECT category, count(*)::text AS records, sum(octet_length(k))::text AS control_key_bytes,
      sum(octet_length(v))::text AS control_metadata_bytes, coalesce(sum(represented_bytes), 0)::text AS represented_resource_bytes,
      count(represented_bytes)::text AS size_metadata_records,
      count(*) FILTER (WHERE ldp AND represented_bytes IS NULL)::text AS invalid_size_metadata_records,
      (SELECT count(*) FROM candidates) > $3::integer AS truncated
      FROM sizes GROUP BY category ORDER BY category`,
};

/** Separate READ ONLY transactions isolate optional permission/time-limit failures. */
export async function collectInventory(client: InventoryClient, options: { maxControlRecords?: number; remainingMs?: () => number } = {}): Promise<Row> {
  const limit = controlLimit(options.maxControlRecords);
  const started = Date.now();
  const remaining = options.remainingMs ?? (() => MAX_RUNTIME_MS - (Date.now() - started));
  const query = async (text: string, values?: unknown[]) => {
    const budget = Math.min(QUERY_MS, Math.floor(remaining()));
    if (budget < 1) throw new InventoryError('deadline');
    return client.query({ text, ...(values ? { values } : {}), query_timeout: budget });
  };
  const sections: Row = {};
  let version = 0;
  for (const section of ['database', 'relations', 'sessions', 'wal', 'slots', 'control_categories'] as const) {
    if (section === 'control_categories' && version < 160000) { sections[section] = { status: 'unavailable', reason: 'requires_postgresql_16_json_validation' }; continue; }
    let begun = false;
    try {
      await query('BEGIN READ ONLY'); begun = true;
      const budget = Math.max(1, Math.min(QUERY_MS, Math.floor(remaining())));
      await query(`SET LOCAL statement_timeout = '${budget}ms'`);
      await query("SET LOCAL lock_timeout = '500ms'");
      await query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'");
      // READ ONLY can still spill a sort/CTE to disk. Refuse spill on this pressured store.
      await query("SET LOCAL temp_file_limit = '0'");
      const mode = await query('SHOW transaction_read_only');
      if (mode.rows[0]?.transaction_read_only !== 'on') throw new InventoryError('read_only_not_confirmed');
      const range = subspaceRange('C');
      const result = await query(SQL[section], section === 'control_categories'
        ? [Buffer.from(range.begin), Buffer.from(range.end), limit, SUBSPACE_PAYLOAD_OFFSET + 1] : undefined);
      const rows = projectRows(section, result.rows);
      if (section === 'database') version = Number(rows[0]?.server_version_num ?? 0);
      sections[section] = { status: 'ok', rows, ...(section === 'relations' || section === 'sessions' ? {
        group_limit: 128, truncated: result.rows.length > 128,
      } : {}), ...(section === 'control_categories' ? {
        row_limit: limit, truncated: rows.some(row => row.truncated === true), order: 'lexicographic_prefix', representative: false,
      } : {}) };
    } catch (error) { sections[section] = safeFailure(error); }
    finally {
      if (begun) {
        try { await query('ROLLBACK'); }
        catch { throw new InventoryError('rollback_unconfirmed'); }
      }
    }
  }
  return { status: Object.values(sections).every(s => object(s) && s.status === 'ok' && s.truncated !== true) ? 'ok' : 'partial', sections,
    notes: [
      'READ ONLY metadata; no GC, DDL, data changes, node bodies or learner payloads.',
      'Relation totals include indexes and TOAST. Table/TOAST fields overlap; do not add them. Heap main excludes auxiliary forks.',
      'Tuple counts are PostgreSQL estimates. Measurements use separate read-only transactions.',
      'Other public tables are grouped; their latest vacuum/analyze timestamps do not describe every member.',
      'Per-slot retained WAL intervals overlap. Do not add their sum or maximum to the physical WAL directory size.',
      'C categories are a capped lexicographic prefix, not a representative sample or extrapolated total.',
      'Partial status includes deliberately capped coverage as well as unavailable sections; inspect section status and truncated flags.',
      'Categories describe fixed resource path patterns, not verified application ownership or safe deletion scope.',
      'Represented resource bytes come only from C head size metadata, not physical lattice/database allocation.',
    ] };
}

/** Resolve existing access only. This function contains no Railway mutation or proxy creation. */
export async function existingConnection(gql: Gql): Promise<Row> {
  const token = await gql('query { projectToken { projectId environmentId } }');
  const context = token.projectToken;
  if (!object(context) || typeof context.projectId !== 'string' || typeof context.environmentId !== 'string') throw new InventoryError('project_context_unavailable');
  const services = await gql('query($p:String!){ project(id:$p){ services{ edges{ node{ id name } } } } }', { p: context.projectId });
  const project = services.project;
  const edges = object(project) && object(project.services) && Array.isArray(project.services.edges) ? project.services.edges : [];
  const matches = edges.filter(edge => object(edge) && object(edge.node) && edge.node.name === 'postgres');
  const service = matches.length === 1 && object(matches[0]) ? matches[0].node : undefined;
  if (!object(service) || typeof service.id !== 'string') throw new InventoryError('postgres_service_unavailable');
  const result = await gql('query($p:String!,$e:String!,$s:String!){ variables(projectId:$p,environmentId:$e,serviceId:$s) tcpProxies(environmentId:$e,serviceId:$s){ domain proxyPort applicationPort } }', { p: context.projectId, e: context.environmentId, s: service.id });
  const proxies = Array.isArray(result.tcpProxies) ? result.tcpProxies.filter(p => object(p) && p.applicationPort === 5432) : [];
  const proxy = proxies.length === 1 ? proxies[0] : undefined;
  if (!object(proxy) || typeof proxy.domain !== 'string' || !/^[a-z0-9-]+\.proxy\.rlwy\.net\.?$/i.test(proxy.domain)
    || typeof proxy.proxyPort !== 'number' || !Number.isInteger(proxy.proxyPort) || proxy.proxyPort < 1 || proxy.proxyPort > 65535) throw new InventoryError('existing_proxy_required');
  const vars = result.variables;
  if (!object(vars) || !['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'].every(key => typeof vars[key] === 'string' && vars[key])) throw new InventoryError('database_credentials_unavailable');
  return { host: proxy.domain.replace(/\.$/, ''), port: proxy.proxyPort, user: vars.POSTGRES_USER, password: vars.POSTGRES_PASSWORD,
    database: vars.POSTGRES_DB, application_name: 'pgsl-storage-inventory', connectionTimeoutMillis: QUERY_MS,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=10000' };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--max-control-records')) throw new InventoryError('unsupported_arguments');
  const limit = controlLimit(args[1] ?? DEFAULT_CONTROL_LIMIT);
  const token = process.env['RAILWAY_PROJECT_TOKEN'];
  if (!token) throw new InventoryError('railway_project_token_required');
  const started = Date.now(), remainingMs = () => MAX_RUNTIME_MS - (Date.now() - started);
  let client: (InventoryClient & { connect(): Promise<unknown>; end(): Promise<void>; on(event: string, listener: () => void): void }) | undefined;
  const hardStop = setTimeout(() => {
    process.stderr.write(JSON.stringify({ status: 'unavailable', reason: 'deadline' }) + '\n');
    process.exit(2);
  }, MAX_RUNTIME_MS);
  try {
    const gql: Gql = async (query, variables = {}) => {
      if (!/^\s*query\b/.test(query)) throw new InventoryError('railway_query_only');
      const timeout = Math.min(QUERY_MS, remainingMs());
      if (timeout < 1) throw new InventoryError('deadline');
      const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new InventoryError('railway_read_failed');
      const json: unknown = await response.json();
      if (!object(json) || json.errors || !object(json.data)) throw new InventoryError('railway_read_failed');
      return json.data;
    };
    const config = await existingConnection(gql);
    // @ts-ignore optional node-postgres driver, already in the locked workspace dependency tree.
    const pg = await import('pg');
    const Client = pg.Client ?? pg.default?.Client;
    if (!Client) throw new InventoryError('postgres_driver_unavailable');
    client = new Client(config);
    client.on('error', () => {}); // Connection errors are reported only through safeFailure.
    await client.connect();
    const report = await collectInventory(client, { maxControlRecords: limit, remainingMs });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.status !== 'ok') process.exitCode = 2;
  } finally {
    try { if (client) await client.end(); }
    finally { clearTimeout(hardStop); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(JSON.stringify(safeFailure(error)) + '\n'); process.exitCode = 2; });
}
