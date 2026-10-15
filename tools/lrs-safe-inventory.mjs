#!/usr/bin/env node
/**
 * Isolated, count-only inventory of existing Basic-auth LRS scopes. No writes to the LRS,
 * no operator impersonation, no raw responses, credentials, tenant IDs or learner data in output.
 * This is neither a backup nor a claim that all process-resident tenants were inspected.
 */
import { pathToFileURL } from 'node:url';

export const TARGET = Object.freeze({
  project: 'b88ceabb-7461-4949-81d7-3d29132e7806',
  environment: '449996a2-3533-462f-98c6-4ab4c05dd777',
  service: '62242b69-dae2-4798-ae0d-d9ea5234d985',
  serviceName: 'foxxi-bridge',
  origin: 'https://foxxi-bridge.interego.xwisee.com',
  railway: 'https://backboard.railway.com/graphql/v2',
  repository: 'markjspivey-xwisee/interego',
  ref: 'refs/heads/codex/lrs-record-inventory-20261015',
});
const PAGE_SIZE = 500;
const MAX_PAGES = 256;
const MAX_ROWS = 100_000;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_CREDENTIALS = 64;
const NS = `${TARGET.origin}/ns/foxxi#`;
const TELEMETRY_NS = `${TARGET.origin}/llm-telemetry/`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const normalizeTenant = x => String(x || 'default').trim().replace(/\/+$/, '').toLowerCase() || 'default';
class InventoryError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = code => { throw new InventoryError(code); };
function iso(value) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString() === value ? value : null;
}
function increment(obj, key) { obj[key] = (obj[key] || 0) + 1; }

// Exact sources: src/xapi-profile.ts, src/mesh-event-projector.ts and
// applications/llm-telemetry/profile.ts. No suffix/display/caller-controlled IRI is echoed.
const VERBS = new Map();
for (const label of ['launched', 'initialized', 'experienced', 'completed', 'passed', 'failed',
  'satisfied', 'terminated', 'abandoned', 'waived', 'voided', 'answered', 'attempted',
  'interacted', 'progressed', 'registered', 'resumed', 'suspended']) {
  VERBS.set(`http://adlnet.gov/expapi/verbs/${label}`, `adl:${label}`);
}
for (const label of ['scene-completed', 'asked', 'retrieved', 'enrolled', 'credentialed',
  'wallet-exported', 'framework-aligned', 'policy-decided', 'affordance-invoked',
  'asserted', 'intended', 'considered', 'authored']) {
  VERBS.set(`${NS}verbs/${label}`, `foxxi:${label}`);
}
VERBS.set(`${NS}performed`, 'foxxi:performed');
for (const label of ['satisfied', 'abandoned', 'waived']) {
  VERBS.set(`https://w3id.org/xapi/adl/verbs/${label}`, `cmi5:${label}`);
}
for (const label of ['session-observed', 'session-ended', 'input-received', 'response-completed',
  'interrupted', 'tool-started', 'tool-completed', 'tool-failed', 'agent-started', 'agent-stopped',
  'agent-failed', 'compaction-started', 'compaction-completed', 'model-invoked', 'model-completed',
  'model-failed', 'handed-off', 'artifact-produced', 'feedback-received']) {
  VERBS.set(`${TELEMETRY_NS}verbs/${label}`, `llm:${label}`);
}
const OBJECT_TYPES = new Set(['Activity', 'Agent', 'Group', 'StatementRef', 'SubStatement']);
const FAMILY_LABELS = ['pod_projection_inferred', 'course_or_lesson_inferred',
  'affordance_telemetry_inferred', 'performance_inferred', 'credential_inferred',
  'question_or_retrieval_inferred', 'other_or_unknown', 'llm_telemetry_inferred',
  'learning_artifact_authorship_inferred', 'enrollment_inferred', 'administrative_activity_inferred'];
function family(statement, verb) {
  const ext = statement.context?.extensions;
  if (isObject(ext) && typeof ext[`${NS}substrateDescriptorIri`] === 'string') return FAMILY_LABELS[0];
  if (verb.startsWith('llm:')) return FAMILY_LABELS[7];
  if (verb === 'foxxi:authored') return FAMILY_LABELS[8];
  if (verb === 'foxxi:enrolled') return FAMILY_LABELS[9];
  if (['foxxi:policy-decided', 'foxxi:framework-aligned', 'foxxi:wallet-exported'].includes(verb)) return FAMILY_LABELS[10];
  if (verb === 'foxxi:credentialed') return FAMILY_LABELS[4];
  if (['foxxi:asked', 'foxxi:retrieved'].includes(verb)) return FAMILY_LABELS[5];
  const type = statement.object?.definition?.type;
  if (['http://adlnet.gov/expapi/activities/course', 'http://adlnet.gov/expapi/activities/lesson',
    `${NS}Course`, `${NS}Lesson`, `${NS}activities/scene`].includes(type)) return FAMILY_LABELS[1];
  if (verb === 'foxxi:affordance-invoked') return FAMILY_LABELS[2];
  if (['foxxi:performed', 'foxxi:asserted', 'foxxi:intended', 'foxxi:considered'].includes(verb)) return FAMILY_LABELS[3];
  return FAMILY_LABELS[6];
}
function emptyAggregate() {
  return { count: 0, oldestStored: null, newestStored: null, verbs: {}, objectTypes: {},
    authorityTypes: {}, familiesInferred: {}, attachmentMetadataPresentCount: 0 };
}
function addStatement(out, statement, stored) {
  const verb = VERBS.get(statement.verb?.id) || 'other_unrecognized';
  const objectType = statement.object?.objectType ?? 'Activity';
  const authorityType = statement.authority === undefined ? 'missing'
    : statement.authority?.objectType === undefined ? 'implicit_Agent'
      : ['Agent', 'Group'].includes(statement.authority.objectType) ? statement.authority.objectType : 'other';
  out.count++;
  if (!out.oldestStored || stored < out.oldestStored) out.oldestStored = stored;
  if (!out.newestStored || stored > out.newestStored) out.newestStored = stored;
  increment(out.verbs, verb);
  increment(out.objectTypes, OBJECT_TYPES.has(objectType) ? objectType : 'other');
  increment(out.authorityTypes, authorityType);
  increment(out.familiesInferred, family(statement, verb));
  if (Array.isArray(statement.attachments) && statement.attachments.length) out.attachmentMetadataPresentCount++;
}

/** Match the existing registry's env format without exposing names, passwords or scope IDs. */
export function credentialsFromConfig(raw) {
  if (typeof raw !== 'string' || raw.length > 65_536) refuse('invalid-basic-configuration');
  const entries = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (entries.length > MAX_CREDENTIALS) refuse('credential-limit');
  const byAuth = new Map();
  const registryIds = new Map();
  for (const entry of entries) {
    const parts = entry.split(':');
    if (parts.length < 2 || !parts[0] || !parts[1] || /[\r\n]/.test(entry)) refuse('invalid-basic-configuration');
    const tenant = normalizeTenant(parts.slice(2).join(':'));
    const auth = `${parts[0]}:${parts[1]}`;
    // Match lrs-forwarding.ts seedFromEnv/put, including same-principal secret rotation
    // and its existing truncated registry-ID collision behavior. No broader scope is invented.
    const id = `cred-${Buffer.from(`${parts[0]}:${tenant}`).toString('base64url').slice(0, 24)}`;
    const prior = registryIds.get(id);
    if (prior !== undefined) byAuth.delete(prior);
    registryIds.set(id, auth);
    byAuth.set(auth, tenant);
  }
  // One existing credential per mapped scope. Never synthesize credentials or tenant selectors.
  const byTenant = new Map();
  for (const [auth, tenant] of byAuth) if (!byTenant.has(tenant)) byTenant.set(tenant, auth);
  return [...byTenant].map(([tenant, auth]) => ({ tenant, authorization: `Basic ${Buffer.from(auth).toString('base64')}` }));
}

function backendKind(raw) {
  if (raw === 'memory' || !raw) return 'memory';
  for (const kind of ['file', 'forward', 'pod']) if (raw === kind || raw.startsWith(`${kind}:`)) return kind;
  return 'unknown';
}
function configSummary(config) {
  const tenants = (config.FOXXI_LRS_MEMORY_TENANTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const prefixes = (config.FOXXI_LRS_MEMORY_TENANT_PREFIXES ?? 'lens:').split(',').map(s => s.trim()).filter(Boolean);
  return { backendKind: backendKind(config.FOXXI_LRS_BACKEND), explicitlyMemoryBackedTenantCount: tenants.length,
    memoryTenantPrefixCount: prefixes.length, lensPrefixConfigured: prefixes.includes('lens:'),
    agentMeshExplicitlyMemoryBacked: tenants.includes('agent-mesh') };
}

/** Never trust a continuation link as a URL or a broader query. Inspect its fixed query binding. */
export function continuationUrl(more, horizon, priorOffset = 0) {
  if (typeof more !== 'string' || more.length > 16_384 || /[\\\r\n]/.test(more)) refuse('unsafe-continuation');
  let url;
  try { url = new URL(more, TARGET.origin); } catch { refuse('unsafe-continuation'); }
  if (url.origin !== TARGET.origin || url.pathname !== '/xapi/statements' || url.username || url.password || url.hash) refuse('unsafe-continuation');
  const entries = [...url.searchParams];
  if (entries.length !== 1 || !['continuationToken', 'cursor'].includes(entries[0][0])) refuse('unsafe-continuation');
  const value = entries[0][1];
  if (!/^[A-Za-z0-9_-]+$/.test(value)) refuse('unsafe-continuation');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { refuse('unsafe-continuation'); }
  if (!isObject(cursor) || Object.keys(cursor).some(k => !['offset', 'ts', 'q'].includes(k))
      || !Number.isSafeInteger(cursor.offset) || cursor.offset <= priorOffset || cursor.offset > MAX_ROWS
      || !Number.isSafeInteger(cursor.ts) || cursor.ts <= 0 || cursor.ts > Date.parse(horizon)
      || !isObject(cursor.q) || Object.keys(cursor.q).sort().join(',') !== 'ascending,limit,until'
      || cursor.q.until !== horizon || cursor.q.ascending !== true || cursor.q.limit !== PAGE_SIZE) refuse('unsafe-continuation');
  return { url: url.href, offset: cursor.offset };
}

async function boundedJson(fetchImpl, url, options, code) {
  let response;
  try { response = await fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15_000) }); }
  catch { refuse(code); }
  // Do not read authentication errors, redirect bodies, or unexpected response types.
  if (response.status !== 200 || !/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(response.headers.get('content-type') || '')) refuse(code);
  const reader = response.body?.getReader();
  if (!reader) refuse(code);
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); refuse(code); }
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { refuse(code); }
}
async function graphql(fetchImpl, token, query, variables = {}) {
  const data = await boundedJson(fetchImpl, TARGET.railway, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  }, 'railway-read-failed');
  if (!isObject(data) || data.errors || !isObject(data.data)) refuse('railway-read-failed');
  return data.data;
}

/** Existing project credentials read only; exact owner/environment/service checks precede vars. */
export async function readScopedConfig(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token || token.length > 16_384) refuse('missing-project-token');
  const me = await graphql(fetchImpl, token, 'query { projectToken { projectId environmentId } }');
  if (me.projectToken?.projectId !== TARGET.project || me.projectToken?.environmentId !== TARGET.environment) refuse('railway-scope-mismatch');
  const project = await graphql(fetchImpl, token,
    'query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }', { id: TARGET.project });
  const service = project.project?.services?.edges?.find(e => e.node?.id === TARGET.service)?.node;
  if (service?.name !== TARGET.serviceName) refuse('railway-scope-mismatch');
  const data = await graphql(fetchImpl, token,
    'query($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }',
    { projectId: TARGET.project, environmentId: TARGET.environment, serviceId: TARGET.service });
  if (!isObject(data.variables)) refuse('railway-read-failed');
  const config = {};
  for (const key of ['BRIDGE_DEPLOYMENT_URL', 'FOXXI_LRS_BACKEND', 'FOXXI_LRS_BASIC_AUTH_PAIRS', 'FOXXI_LRS_MEMORY_TENANTS', 'FOXXI_LRS_MEMORY_TENANT_PREFIXES']) {
    if (data.variables[key] !== undefined && typeof data.variables[key] !== 'string') refuse('invalid-service-configuration');
    if (data.variables[key] !== undefined) config[key] = data.variables[key];
  }
  if (config.BRIDGE_DEPLOYMENT_URL?.replace(/\/$/, '') !== TARGET.origin) refuse('foxxi-origin-mismatch');
  return config;
}

export async function inventory(config, { fetchImpl = fetch, now = new Date() } = {}) {
  const horizon = iso(now.toISOString());
  if (!horizon) refuse('invalid-horizon');
  const credentials = credentialsFromConfig(config.FOXXI_LRS_BASIC_AUTH_PAIRS || '');
  const report = {
    schema: 'lrs-safe-inventory-v1', fixedStoredHorizon: horizon,
    readOnly: true, backupCreated: false, operatorCredentialsUsed: false,
    configuration: configSummary(config), observedProcessResidentStatements: null,
    basicMappedTenantScopesAvailable: credentials.length, scopes: [],
    aggregateAcrossQueriedScopes: emptyAggregate(), distinctStatementIdsAcrossQueriedScopes: 0,
    crossScopeRepeatedIds: 0,
    excludedAfterHorizon: 0, duplicateRowsSkipped: 0, pagesRead: 0,
    coverage: 'Only scopes of existing configured Basic credentials; not a complete process inventory.',
    unknowns: ['ordinary_queries_exclude_voided_target_records', 'attachment_bytes_not_read',
      'uncredentialed_and_runtime_created_tenants_not_inspected', 'evictions_or_voids_can_change_pages',
      'family_labels_are_inferences_not_provenance_or_durability_verification',
      'no_record_copy_or_restart_recovery_verified'],
  };
  const about = await boundedJson(fetchImpl, `${TARGET.origin}/xapi/about`, { method: 'GET', headers: { Accept: 'application/json' } }, 'about-read-failed');
  const backend = about?.extensions?.[`${NS}lrsBackend`];
  if (typeof backend === 'string') {
    const match = /; (\d+)\/\d+ statements resident process-wide\)/.exec(backend);
    if (match && Number.isSafeInteger(Number(match[1]))) report.observedProcessResidentStatements = Number(match[1]);
  }
  const globalIds = new Set();
  let observedRows = 0;
  const memoryTenants = (config.FOXXI_LRS_MEMORY_TENANTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const memoryPrefixes = (config.FOXXI_LRS_MEMORY_TENANT_PREFIXES ?? 'lens:').split(',').map(s => s.trim()).filter(Boolean);
  for (const [index, credential] of credentials.entries()) {
    const scope = { ordinal: index + 1, defaultScope: credential.tenant === 'default',
      configuredDerivedMemoryScope: memoryTenants.includes(credential.tenant) || memoryPrefixes.some(p => credential.tenant.startsWith(p)),
      reachedLastPage: false, aggregate: emptyAggregate() };
    const ids = new Set();
    let url = `${TARGET.origin}/xapi/statements?until=${encodeURIComponent(horizon)}&ascending=true&limit=${PAGE_SIZE}`;
    let offset = 0;
    for (;;) {
      if (++report.pagesRead > MAX_PAGES) refuse('page-limit');
      const page = await boundedJson(fetchImpl, url, { method: 'GET', headers: {
        Accept: 'application/json', Authorization: credential.authorization, 'X-Experience-API-Version': '2.0.0',
      } }, 'statement-read-failed');
      if (!isObject(page) || !Array.isArray(page.statements) || page.statements.length > MAX_ROWS
          || typeof page.more !== 'string') refuse('invalid-statement-page');
      for (const statement of page.statements) {
        if (++observedRows > MAX_ROWS) refuse('row-limit');
        if (!isObject(statement) || typeof statement.id !== 'string' || !UUID.test(statement.id)) refuse('invalid-statement-metadata');
        // Every live ingestion/internal-emission route assigns stored = nowIso(), which
        // uses Date.toISOString() (xapi-lrs.ts ensureStatementFields), not a caller timestamp.
        const stored = iso(statement.stored);
        if (!stored) refuse('invalid-statement-metadata');
        // The live route can append a voiding statement beyond the original query's horizon.
        if (stored > horizon) { report.excludedAfterHorizon++; continue; }
        const id = statement.id.toLowerCase();
        if (ids.has(id)) { report.duplicateRowsSkipped++; continue; }
        ids.add(id);
        addStatement(scope.aggregate, statement, stored);
        // UUID identity is scoped by tenant. The same UUID in two tenants is TWO records;
        // track cross-scope identifier overlap separately from the summed record categories.
        addStatement(report.aggregateAcrossQueriedScopes, statement, stored);
        if (globalIds.has(id)) report.crossScopeRepeatedIds++;
        else globalIds.add(id);
        report.distinctStatementIdsAcrossQueriedScopes = globalIds.size;
      }
      if (page.more === '') { scope.reachedLastPage = true; break; }
      if (!page.statements.length) refuse('invalid-statement-page');
      const next = continuationUrl(page.more, horizon, offset);
      url = next.url;
      offset = next.offset;
    }
    report.scopes.push(scope);
  }
  return report;
}

export async function main(env = process.env, fetchImpl = fetch, output = console.log) {
  try {
    if (env.GITHUB_REPOSITORY !== TARGET.repository || env.GITHUB_REF !== TARGET.ref) refuse('execution-scope-mismatch');
    const config = await readScopedConfig(env.RAILWAY_PROJECT_TOKEN, fetchImpl);
    const report = await inventory(config, { fetchImpl });
    output(`LRS_SAFE_INVENTORY=${JSON.stringify(report)}`);
    return 0;
  } catch (error) {
    // Never print Error.message/stack, request URL, headers, response, config, or environment.
    const code = error instanceof InventoryError ? error.code : 'unexpected-failure';
    output(`LRS_SAFE_INVENTORY_FAILED=${JSON.stringify({ code, backupCreated: false, completeProcessInventory: false })}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
