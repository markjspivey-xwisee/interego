#!/usr/bin/env node
/**
 * One-shot, best-effort preservation. GETs only after scoped Railway config queries.
 * Never restarts, flushes, enrols, changes credentials or signs as an operator.
 * Exact response bytes live only in memory until AES-256-GCM encryption succeeds.
 */
import { createCipheriv, createDecipheriv, createHash, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TARGET as INVENTORY_TARGET, credentialsFromConfig, continuationUrl } from './lrs-safe-inventory.mjs';

export const TARGET = Object.freeze({ ...INVENTORY_TARGET,
  ref: 'refs/heads/codex/lrs-preservation-20261015',
  gate: 'https://gate.interego.xwisee.com',
});
export const LIMITS = Object.freeze({ responseBytes: 16 * 1024 * 1024, totalBytes: 96 * 1024 * 1024,
  requests: 2400, pages: 256, statements: 100_000, pods: 128, segments: 128, descriptors: 1200,
  entries: 100_000, timeoutMs: 15_000 });
const PAGE_SIZE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const SNAPSHOTS = new Set(['XapiTenantSnapshot', 'ScormTenantSnapshot', 'Cmi5TenantSnapshot',
  'LtiTenantSnapshot', 'LtiPlatformSnapshot', 'OneRosterSnapshot', 'AgentTrajectorySnapshot',
  'PerformanceProbeSnapshot', 'EvaluationSnapshot', 'CalibrationProfileSnapshot']);
const CONFIG_KEYS = ['BRIDGE_DEPLOYMENT_URL', 'FOXXI_LRS_BACKEND', 'FOXXI_LRS_BASIC_AUTH_PAIRS',
  'FOXXI_LRS_MEMORY_TENANTS', 'FOXXI_LRS_MEMORY_TENANT_PREFIXES', 'FOXXI_TENANT_POD_URL',
  'FOXXI_AUTHORITATIVE_SOURCE', 'FOXXI_MESH_PODS', 'FOXXI_MESH_ACTOR_LABELS',
  'FOXXI_ADMIN_KEY_SEED', 'FOXXI_POD_WRITE_SECRET', 'FOXXI_BRIDGE_PRIVATE_KEY', 'FOXXI_CSS_INTERNAL_URL'];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const sha256 = x => createHash('sha256').update(x).digest('hex');
const localName = x => String(x).split(/[#/]/).pop();
class PreservationError extends Error { constructor(code) { super(code); this.code = code; } }
const refuse = code => { throw new PreservationError(code); };
const staticCode = e => e instanceof PreservationError ? e.code : 'unexpected-failure';

/** Re-spell the one known internal store origin; all actual network reads stay public. */
export function publicStoreSpelling(raw, configuredInternal = 'http://css.railway.internal:3456/') {
  if (typeof raw !== 'string' || /[\\\s%]/.test(raw) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) refuse('unsafe-store-spelling');
  let u; try { u = new URL(raw); } catch { return raw; }
  let internal; try { internal = new URL(configuredInternal); } catch { refuse('unsafe-internal-store-config'); }
  // This fixed deployment's internal alias, never an arbitrary config-derived origin.
  if (internal.origin !== 'http://css.railway.internal:3456' || internal.username || internal.password) refuse('unsafe-internal-store-config');
  if (u.origin !== internal.origin) return raw;
  if (u.username || u.password || u.search || u.hash) refuse('unsafe-store-spelling');
  return `${TARGET.gate}${u.pathname}`;
}

/** Fixed public gate and one pod segment; reject URL normalization tricks before parsing. */
export function checkedPod(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\\\s%?#]/.test(raw)) refuse('unsafe-pod-url');
  let u; try { u = new URL(raw); } catch { refuse('unsafe-pod-url'); }
  if (u.origin !== TARGET.gate || u.username || u.password || !/^\/[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\/?$/.test(u.pathname)
    || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) refuse('unsafe-pod-url');
  return `${u.origin}${u.pathname.replace(/\/$/, '')}/`;
}

/** Arbitrary descriptor/graph targets must remain inside their already selected pod. */
export function checkedPodResource(raw, pod, { archive = false, manifest = false } = {}) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\\\s%?#]/.test(raw)
    || /(?:^|\/)\.{1,2}(?:\/|$)/.test(raw)) refuse('unsafe-pod-resource');
  const root = checkedPod(pod);
  let u; try { u = new URL(raw, root); } catch { refuse('unsafe-pod-resource'); }
  if (u.origin !== TARGET.gate || u.username || u.password || u.search || u.hash || !u.pathname.startsWith(new URL(root).pathname)) refuse('unsafe-pod-resource');
  if (archive && !new RegExp(`^${new URL(root).pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.well-known/context-graphs-archive-\\d+$`).test(u.pathname)) refuse('unsafe-manifest-archive');
  if (manifest && u.href !== `${root}.well-known/context-graphs`) refuse('unsafe-manifest-resource');
  return u.href;
}

/** Existing protocol rebases ONLY archive basenames; original bytes and IRIs stay archived. */
export function archiveTarget(raw, pod) {
  let u; try { u = new URL(raw, pod); } catch { refuse('unsafe-manifest-archive'); }
  const basename = u.pathname.split('/').pop() ?? '';
  if (!/^context-graphs-archive-\d+$/.test(basename) || /[\\\s%]/.test(raw) || u.search || u.hash || u.username || u.password) refuse('unsafe-manifest-archive');
  return checkedPodResource(`${checkedPod(pod)}.well-known/${basename}`, pod, { archive: true });
}

export function nativeReadiness(config) {
  let bridgeKeyValid = false;
  try {
    if (/^(?:0x)?[0-9a-f]{64}$/i.test(config.FOXXI_BRIDGE_PRIVATE_KEY ?? '')) {
      createECDH('secp256k1').setPrivateKey(Buffer.from(config.FOXXI_BRIDGE_PRIVATE_KEY.replace(/^0x/, ''), 'hex'));
      bridgeKeyValid = true;
    }
  } catch { /* only a boolean escapes */ }
  let configuredPodValid = false;
  try { checkedPod(publicStoreSpelling(config.FOXXI_TENANT_POD_URL, config.FOXXI_CSS_INTERNAL_URL)); configuredPodValid = true; } catch { /* fail closed */ }
  return { configuredPodValid, configuredOwnerPresent: Boolean(config.FOXXI_AUTHORITATIVE_SOURCE),
    bridgeKeyPresent: Boolean(config.FOXXI_BRIDGE_PRIVATE_KEY), bridgeKeyValid,
    podWriteSecretPresent: Boolean(config.FOXXI_POD_WRITE_SECRET), archiveSeedPresent: Boolean(config.FOXXI_ADMIN_KEY_SEED) };
}

/** All config requests are scoped read-only GraphQL queries with no mutation operation. */
export async function readArchiveConfig(token, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token || token.length > 16384) refuse('missing-project-token');
  const query = async (query, variables = {}) => {
    let r; try { r = await fetchImpl(TARGET.railway, { method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(LIMITS.timeoutMs), headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({ query, variables }) }); } catch { refuse('railway-read-failed'); }
    if (r.status !== 200 || !/application\/json/i.test(r.headers.get('content-type') ?? '')) refuse('railway-read-failed');
    const bytes = await boundedBody(r, LIMITS.responseBytes);
    let json; try { json = JSON.parse(bytes); } catch { refuse('railway-read-failed'); }
    if (!object(json?.data) || json.errors) refuse('railway-read-failed');
    return json.data;
  };
  const me = await query('query { projectToken { projectId environmentId } }');
  if (me.projectToken?.projectId !== TARGET.project || me.projectToken?.environmentId !== TARGET.environment) refuse('railway-scope-mismatch');
  const project = await query('query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }', { id: TARGET.project });
  const service = project.project?.services?.edges?.find(e => e.node?.id === TARGET.service)?.node;
  if (service?.name !== TARGET.serviceName) refuse('railway-scope-mismatch');
  const data = await query('query($projectId: String!, $environmentId: String!, $serviceId: String!) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }',
    { projectId: TARGET.project, environmentId: TARGET.environment, serviceId: TARGET.service });
  if (!object(data.variables)) refuse('invalid-service-configuration');
  const config = {};
  for (const key of CONFIG_KEYS) {
    if (data.variables[key] !== undefined && typeof data.variables[key] !== 'string') refuse('invalid-service-configuration');
    if (data.variables[key] !== undefined) config[key] = data.variables[key];
  }
  if (config.BRIDGE_DEPLOYMENT_URL?.replace(/\/$/, '') !== TARGET.origin) refuse('foxxi-origin-mismatch');
  if (!config.FOXXI_ADMIN_KEY_SEED) refuse('archive-encryption-seed-unavailable');
  return config;
}

async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); refuse('response-byte-limit'); }
  const reader = response.body?.getReader(); if (!reader) refuse('empty-response-body');
  const chunks = []; let n = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      n += value.byteLength; if (n > limit) { await reader.cancel(); refuse('response-byte-limit'); }
      chunks.push(value);
    }
  } catch (e) { if (e instanceof PreservationError) throw e; refuse('response-read-failed'); }
  return Buffer.concat(chunks);
}

/** Minimal envelope parser mirrors the deployed line-oriented manifest, not private bodies. */
export function parseManifestEnvelope(turtle) {
  const entries = []; let current = null;
  const finish = () => { if (current) entries.push(current); current = null; };
  const patterns = [
    ['describes', /iep:describes\s+<([^>]+)>/, true], ['conformsTo', /dct:conformsTo\s+<([^>]+)>/, true],
    ['facetTypes', /iep:hasFacetType\s+iep:(\w+)/, true], ['supersedes', /iep:supersedes\s+<([^>]+)>/, true],
    ['modalStatus', /iep:modalStatus\s+iep:(\w+)/], ['trustLevel', /iep:trustLevel\s+iep:(\w+)/],
    ['validFrom', /iep:validFrom\s+"([^"]+)"/], ['validUntil', /iep:validUntil\s+"([^"]+)"/],
    ['cid', /iep:contentCid\s+"([^"]+)"/], ['pgslUri', /iep:pgslUri\s+<([^>]+)>/],
  ];
  for (const raw of turtle.split('\n')) {
    const line = raw.trim();
    const entry = /^<([^>]+)>\s+a\s+iep:ManifestEntry/.exec(line);
    if (entry) { finish(); current = { descriptorUrl: entry[1], describes: [], conformsTo: [], facetTypes: [], supersedes: [] }; }
    if (!current) continue;
    for (const [field, pattern, many] of patterns) {
      const m = pattern.exec(line); if (!m) continue;
      if (many) current[field].push(m[1]); else current[field] = m[1];
    }
    if (line.endsWith('.')) finish();
    if (entries.length > LIMITS.entries) refuse('manifest-entry-limit');
  }
  finish(); return entries;
}

function archiveLinks(turtle) {
  const links = [];
  const re = /(?:iep:manifestArchive|hydra:previous)\s*((?:<[^>]*>\s*,\s*)*<[^>]*>)/g;
  for (const match of turtle.matchAll(re)) for (const iri of match[1].matchAll(/<([^>]*)>/g)) links.push(iri[1]);
  return links;
}
function distributionTargets(turtle) {
  return [...turtle.matchAll(/(?:hydra:target|dcat:accessURL)\s+<([^>]+)>/g)].map(x => x[1]);
}
function decodePublicRegister(turtle) {
  const m = /(?:<[^>]*#bundleJson>|[\w-]+:bundleJson)\s+"([A-Za-z0-9+/=\s]+)"/.exec(turtle);
  if (!m || m[1].length > LIMITS.responseBytes) refuse('public-register-unparsed');
  let rows; try { rows = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { refuse('public-register-unparsed'); }
  if (!Array.isArray(rows)) refuse('public-register-unparsed');
  return rows;
}
function candidateId(descriptorUrl) {
  const h = sha256(descriptorUrl), v = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function collectArchive(config, { fetchImpl = fetch, now = new Date(), limits = LIMITS } = {}) {
  if (!config.FOXXI_ADMIN_KEY_SEED) refuse('archive-encryption-seed-unavailable');
  const horizon = now.toISOString();
  const bundle = { schema: 'lrs-best-effort-preservation-v1', createdAt: horizon,
    coverage: 'Accessible canonical Basic scopes plus existing pod source material. Not a copy of every resident statement.',
    responses: [], sources: [], candidates: [], failures: [] };
  const summary = { schema: bundle.schema, createdAt: horizon, readOnly: true,
    completeProcessInventory: false, originalResidentStatementsCopied: false,
    operator: { available: false, attempted: false, reason: 'no-existing-verified-operator-session' },
    nativeReadiness: nativeReadiness(config), observedProcessResidentStatements: null,
    basicScopesAvailable: 0, basicScopesFullyRead: 0, canonicalStatementsCopied: 0,
    voidedTargetsCopied: 0, attachmentResponsesCopied: 0, attachmentBytesVerified: 0,
    publicMeshRegisterRead: false, publicMeshActivePodCount: 0,
    podsManifestsRead: 0, completeManifestChains: 0, manifestEntriesArchived: 0,
    reconstructionCandidates: 0, tenantDescriptorsArchived: 0, tenantSnapshotGraphsArchived: 0,
    sourceBytesArchived: 0, requestCount: 0, failedOperations: 0, failureCodes: {},
    omissions: ['uncredentialed_resident_tenants_not_exported', 'no_complete_process_inventory',
      'manifest_candidates_are_not_proof_of_original_resident_copies', 'original_stored_timestamps_not_reconstructed',
      'mesh_private_graph_bodies_not_read', 'external_attachment_fileUrl_bytes_not_fetched', 'no_state_flush_or_mutation',
      'plain_admin_exports_unavailable', 'archives_and_descriptors_can_change_during_reads'] };
  let totalBytes = 0;
  const note = (phase, e) => { const code = staticCode(e); bundle.failures.push({ phase, code });
    summary.failedOperations++; summary.failureCodes[code] = (summary.failureCodes[code] || 0) + 1; };
  const get = async (url, kind, { authorization, accept = '*/*' } = {}) => {
    const u = new URL(url);
    if (u.origin !== TARGET.origin && u.origin !== TARGET.gate) refuse('unexpected-get-origin');
    if (++summary.requestCount > limits.requests) refuse('request-limit');
    let response;
    try { response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(limits.timeoutMs),
      headers: { Accept: accept, ...(authorization ? { Authorization: authorization } : {}),
        ...(u.origin === TARGET.origin ? { 'X-Experience-API-Version': '2.0.0' } : {}) } });
    } catch { refuse('get-failed'); }
    if (response.status !== 200) { await response.body?.cancel(); refuse(response.status === 401 || response.status === 403 ? 'read-access-unavailable' : response.status >= 300 && response.status < 400 ? 'redirect-refused' : 'get-status-unavailable'); }
    const bytes = await boundedBody(response, limits.responseBytes);
    if (totalBytes + bytes.length > limits.totalBytes) refuse('archive-byte-limit');
    totalBytes += bytes.length;
    const item = { kind, url, contentType: response.headers.get('content-type') ?? '',
      etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
      bytes: bytes.length, sha256: sha256(bytes), bodyBase64: bytes.toString('base64') };
    bundle.responses.push(item); summary.sourceBytesArchived = totalBytes;
    return { item, bytes };
  };
  const jsonOf = ({ bytes, item }) => {
    if (!/\bapplication\/(?:[\w.+-]*\+)?json\b/i.test(item.contentType)) refuse('unexpected-json-content-type');
    try { return JSON.parse(bytes); } catch { refuse('invalid-json-response'); }
  };
  try {
    const about = jsonOf(await get(`${TARGET.origin}/xapi/about`, 'xapi-about', { accept: 'application/json' }));
    const backend = about?.extensions?.[`${TARGET.origin}/ns/foxxi#lrsBackend`];
    const m = typeof backend === 'string' ? /; (\d+)\/\d+ statements resident process-wide\)/.exec(backend) : null;
    if (m && Number.isSafeInteger(Number(m[1]))) summary.observedProcessResidentStatements = Number(m[1]);
  } catch (e) { note('xapi-about', e); }

  let credentials = [];
  try { credentials = credentialsFromConfig(config.FOXXI_LRS_BASIC_AUTH_PAIRS ?? ''); }
  catch { note('basic-configuration', new PreservationError('invalid-basic-configuration')); }
  summary.basicScopesAvailable = credentials.length;
  const recordIds = new Set(); let rows = 0;
  for (const [index, credential] of credentials.entries()) {
    const phase = `basic-scope-${index + 1}`;
    const source = { kind: 'canonical-basic-scope', tenant: credential.tenant, fullyRead: false, records: [] };
    bundle.sources.push(source);
    const attachments = new Map(), targets = new Set(); let pages = 0, offset = 0;
    let url = `${TARGET.origin}/xapi/statements?until=${encodeURIComponent(horizon)}&ascending=true&limit=${PAGE_SIZE}`;
    try {
      for (;;) {
        if (++pages > limits.pages) refuse('statement-page-limit');
        const result = await get(url, 'canonical-statement-page', { authorization: credential.authorization, accept: 'application/json' });
        const page = jsonOf(result);
        if (!object(page) || !Array.isArray(page.statements) || typeof page.more !== 'string') refuse('invalid-statement-page');
        source.records.push(result.item.sha256);
        for (const statement of page.statements) {
          if (++rows > limits.statements) refuse('statement-row-limit');
          if (!object(statement) || !UUID.test(statement.id ?? '') || typeof statement.stored !== 'string' || !Number.isFinite(Date.parse(statement.stored))) refuse('invalid-statement-metadata');
          if (Date.parse(statement.stored) > Date.parse(horizon)) continue;
          const key = `${index}:${statement.id.toLowerCase()}`;
          if (!recordIds.has(key)) { summary.canonicalStatementsCopied++; recordIds.add(key); }
          if (statement.verb?.id === 'http://adlnet.gov/expapi/verbs/voided' && statement.object?.objectType === 'StatementRef' && UUID.test(statement.object.id ?? '')) targets.add(statement.object.id);
          if (Array.isArray(statement.attachments) && statement.attachments.length) attachments.set(statement.id, statement.attachments);
        }
        if (!page.more) { source.fullyRead = true; summary.basicScopesFullyRead++; break; }
        if (!page.statements.length) refuse('invalid-statement-page');
        let next; try { next = continuationUrl(page.more, horizon, offset); } catch { refuse('unsafe-continuation'); }
        url = next.url; offset = next.offset;
      }
    } catch (e) { note(phase, e); }
    for (const id of targets) {
      try {
        const result = await get(`${TARGET.origin}/xapi/statements?voidedStatementId=${id}`, 'canonical-voided-target', { authorization: credential.authorization, accept: 'application/json' });
        const statement = jsonOf(result);
        if (statement?.id?.toLowerCase() !== id.toLowerCase()) refuse('voided-target-mismatch');
        summary.voidedTargetsCopied++;
        if (Array.isArray(statement.attachments) && statement.attachments.length) attachments.set(id, statement.attachments);
      } catch (e) { note(`${phase}-voided-target`, e); }
    }
    for (const [id, metadata] of attachments) {
      try {
        const name = targets.has(id) ? 'voidedStatementId' : 'statementId';
        const result = await get(`${TARGET.origin}/xapi/statements?${name}=${id}&attachments=true`, 'canonical-multipart-attachments', { authorization: credential.authorization });
        summary.attachmentBytesVerified += verifyMultipartAttachments(result.bytes, result.item.contentType, metadata);
        summary.attachmentResponsesCopied++;
      } catch (e) { note(`${phase}-attachments`, e); }
    }
  }

  const publicSpelling = raw => publicStoreSpelling(raw, config.FOXXI_CSS_INTERNAL_URL);
  let tenantPod;
  try { tenantPod = checkedPod(publicSpelling(config.FOXXI_TENANT_POD_URL)); }
  catch (e) { note('tenant-pod-config', e); }
  const pods = new Set();
  if (tenantPod) pods.add(tenantPod);
  for (const raw of (config.FOXXI_MESH_PODS ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
    try { pods.add(checkedPod(publicSpelling(raw))); } catch (e) { note('configured-mesh-pod', e); }
  }
  try {
    const result = await get(`${TARGET.origin}/agent/mesh/enrolment`, 'public-live-mesh-enrolment-register', { accept: 'text/turtle' });
    const text = result.bytes.toString('utf8');
    // Only active iep:enrolled blocks. Retirements have the same store predicate and must not be swept.
    const activePods = new Set();
    for (const block of text.matchAll(/iep:enrolled\s+\[([\s\S]*?)\]\s*;/g)) {
      const raw = /iep:store\s+<([^>]+)>/.exec(block[1])?.[1];
      if (!raw) { note('public-mesh-register', new PreservationError('public-register-entry-unparsed')); continue; }
      try { const pod = checkedPod(publicSpelling(raw)); activePods.add(pod); pods.add(pod); }
      catch (e) { note('public-mesh-register-pod', e); }
    }
    summary.publicMeshRegisterRead = true; summary.publicMeshActivePodCount = activePods.size;
  } catch (e) { note('public-mesh-register', e); }
  const tenantAuth = url => config.FOXXI_POD_WRITE_SECRET && tenantPod && new URL(url).origin === TARGET.gate
    && new URL(url).pathname.startsWith(new URL(tenantPod).pathname) ? `Bearer ${config.FOXXI_POD_WRITE_SECRET}` : undefined;
  const rawTenantEntries = [];
  let descriptorCount = 0;
  const readManifest = async pod => {
    const source = { kind: 'pod-manifest-chain', pod, complete: true, records: [], entries: [] };
    bundle.sources.push(source);
    const manifest = `${pod}.well-known/context-graphs`, frontier = [manifest], seen = new Set();
    while (frontier.length) {
      const url = frontier.shift(); if (seen.has(url)) continue;
      if (seen.size >= limits.segments) { source.complete = false; note('manifest-chain', new PreservationError('manifest-segment-limit')); break; }
      seen.add(url);
      try {
        checkedPodResource(url, pod, { manifest: url === manifest, archive: url !== manifest });
        // Mesh manifests are public envelopes; the existing tenant secret is sent only inside its own pod.
        const result = await get(url, 'pod-manifest-envelope', { authorization: tenantAuth(url), accept: 'text/turtle' });
        source.records.push(result.item.sha256);
        const turtle = result.bytes.toString('utf8');
        source.entries.push(...parseManifestEnvelope(turtle));
        for (const link of archiveLinks(turtle)) {
          try { const target = archiveTarget(link, pod); if (!seen.has(target)) frontier.push(target); }
          catch (e) { source.complete = false; note('manifest-archive-link', e); }
        }
      } catch (e) { source.complete = false; note('manifest-chain', e); }
    }
    // The hot manifest is visited first and wins over older archive copies, as in Interego's reader.
    const byDescriptor = new Map();
    for (const entry of source.entries) if (!byDescriptor.has(entry.descriptorUrl)) byDescriptor.set(entry.descriptorUrl, entry);
    const deduped = [...byDescriptor.values()];
    if (deduped.length > limits.entries) { source.complete = false; refuse('manifest-entry-limit'); }
    source.entries = deduped;
    if (source.records.length) summary.podsManifestsRead++;
    if (source.complete && source.records.length) summary.completeManifestChains++;
    summary.manifestEntriesArchived += deduped.length;
    for (const entry of deduped) bundle.candidates.push({ kind: 'deterministic-projection-reconstruction-input', pod,
      candidateStatementId: candidateId(entry.descriptorUrl), envelope: entry,
      originalResidentCopyVerified: false, originalStoredTimestampAvailable: false });
    summary.reconstructionCandidates = bundle.candidates.length;
    return deduped;
  };
  // Read configured tenant first to discover the existing PUBLIC durable enrolment register.
  if (tenantPod) {
    try { rawTenantEntries.push(...await readManifest(tenantPod)); }
    catch (e) { note('tenant-manifest', e); }
    const seenDescriptors = new Set();
    for (const entry of rawTenantEntries) {
      if (seenDescriptors.has(entry.descriptorUrl)) continue;
      seenDescriptors.add(entry.descriptorUrl);
      const isRegister = entry.conformsTo.some(x => localName(x) === 'MeshEnrolmentRegister');
      const isSnapshot = entry.conformsTo.some(x => SNAPSHOTS.has(localName(x)));
      // Existing tenant descriptor envelopes only; read graph bodies only for declared snapshots/register.
      try {
        if (++descriptorCount > limits.descriptors) refuse('tenant-descriptor-limit');
        const url = checkedPodResource(publicSpelling(entry.descriptorUrl), tenantPod);
        const desc = await get(url, 'tenant-descriptor-envelope', { authorization: tenantAuth(url), accept: 'text/turtle' });
        summary.tenantDescriptorsArchived++;
        if (!isRegister && !isSnapshot) continue;
        const targets = [...new Set(distributionTargets(desc.bytes.toString('utf8')))];
        if (!targets.length) refuse('descriptor-graph-target-unavailable');
        for (const rawTarget of targets.slice(0, 4)) {
          const target = checkedPodResource(publicSpelling(rawTarget), tenantPod);
          const graph = await get(target, isRegister ? 'public-mesh-enrolment-register' : 'tenant-snapshot-graph', { authorization: tenantAuth(target) });
          if (isSnapshot) summary.tenantSnapshotGraphsArchived++;
          if (isRegister) for (const row of decodePublicRegister(graph.bytes.toString('utf8'))) {
            if (!object(row) || row.retired_at || typeof row.pod_url !== 'string') continue;
            try { pods.add(checkedPod(publicSpelling(row.pod_url))); } catch (e) { note('registered-mesh-pod', e); }
          }
        }
      } catch (e) { note('tenant-descriptor', e); if (staticCode(e) === 'tenant-descriptor-limit') break; }
    }
  }
  let walked = tenantPod ? 1 : 0;
  for (const pod of pods) {
    if (pod === tenantPod) continue;
    if (++walked > limits.pods) { note('mesh-pods', new PreservationError('mesh-pod-limit')); break; }
    try { await readManifest(pod); } catch (e) { note('mesh-manifest', e); }
  }
  return { bundle, summary };
}

/** Verify content hashes of present attachment parts; missing bytes are an explicit omission. */
export function verifyMultipartAttachments(bytes, contentType, metadata) {
  const m = /\bmultipart\/mixed\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s\r\n]+))/i.exec(contentType);
  if (!m) refuse('attachment-multipart-unavailable');
  const boundary = m[1] ?? m[2]; if (boundary.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(boundary)) refuse('invalid-multipart-boundary');
  const sep = Buffer.from(`\r\n--${boundary}`), expected = new Map();
  for (const a of metadata) if (typeof a.sha2 === 'string' && /^[a-f0-9]{64}$/i.test(a.sha2)) expected.set(a.sha2.toLowerCase(), a);
  const verified = new Set(); let cursor = 0, total = 0;
  while (cursor < bytes.length) {
    const start = bytes.indexOf(Buffer.from(`--${boundary}\r\n`), cursor); if (start < 0) break;
    const headersEnd = bytes.indexOf(Buffer.from('\r\n\r\n'), start); if (headersEnd < 0 || headersEnd - start > 8192) refuse('invalid-multipart-part');
    const end = bytes.indexOf(sep, headersEnd + 4); if (end < 0) refuse('invalid-multipart-part');
    const headers = bytes.subarray(start, headersEnd).toString('ascii');
    const hash = /(?:^|\r\n)X-Experience-API-Hash:\s*([a-f0-9]{64})\s*(?:\r\n|$)/i.exec(headers)?.[1]?.toLowerCase();
    if (hash) {
      const data = bytes.subarray(headersEnd + 4, end);
      if (!expected.has(hash) || sha256(data) !== hash || (Number.isSafeInteger(expected.get(hash).length) && data.length !== expected.get(hash).length)) refuse('attachment-hash-mismatch');
      if (!verified.has(hash)) { verified.add(hash); total += data.length; }
    }
    cursor = end + 2;
  }
  if ([...expected].some(([hash, a]) => !a.fileUrl && !verified.has(hash))) refuse('attachment-bytes-missing');
  return total;
}

function manifestFor(bundle) {
  return bundle.responses.map(({ bodyBase64: _body, ...metadata }) => metadata);
}
function encryptionKey(seed, salt) {
  if (typeof seed !== 'string' || !seed) refuse('archive-encryption-seed-unavailable');
  return Buffer.from(hkdfSync('sha256', Buffer.from(seed), salt, Buffer.from('interego:lrs-best-effort-preservation:v1'), 32));
}
export function sealArchive(bundle, seed) {
  const plaintext = Buffer.from(JSON.stringify(bundle));
  const salt = randomBytes(32), iv = randomBytes(12), key = encryptionKey(seed, salt);
  const header = { schema: 'interego-encrypted-preservation-v1', algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256',
    keyContext: 'FOXXI_ADMIN_KEY_SEED; interego:lrs-best-effort-preservation:v1', createdAt: bundle.createdAt,
    plaintextSha256: sha256(plaintext), manifestSha256: sha256(JSON.stringify(manifestFor(bundle))) };
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = { header, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  key.fill(0);
  const restored = openArchive(envelope, seed);
  if (!restored.equals(plaintext)) refuse('archive-byte-comparison-failed');
  verifyRestoredArchive(restored);
  plaintext.fill(0); restored.fill(0);
  return envelope;
}
export function openArchive(envelope, seed) {
  const key = encryptionKey(seed, Buffer.from(envelope.salt, 'base64'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(envelope.header))); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    if (sha256(plain) !== envelope.header.plaintextSha256) refuse('archive-plaintext-hash-mismatch');
    const bundle = verifyRestoredArchive(plain);
    if (sha256(JSON.stringify(manifestFor(bundle))) !== envelope.header.manifestSha256) refuse('archive-manifest-hash-mismatch');
    return plain;
  } finally { key.fill(0); }
}
export function verifyRestoredArchive(bytes) {
  const bundle = JSON.parse(bytes);
  if (bundle?.schema !== 'lrs-best-effort-preservation-v1' || !Array.isArray(bundle.responses)) refuse('invalid-archive-bundle');
  for (const r of bundle.responses) {
    const body = Buffer.from(r.bodyBase64, 'base64');
    if (body.length !== r.bytes || sha256(body) !== r.sha256) refuse('archived-response-hash-mismatch');
  }
  return bundle;
}

export async function main(env = process.env, fetchImpl = fetch, output = console.log) {
  try {
    if (env.GITHUB_REPOSITORY !== TARGET.repository || env.GITHUB_REF !== TARGET.ref) refuse('execution-scope-mismatch');
    const config = await readArchiveConfig(env.RAILWAY_PROJECT_TOKEN, fetchImpl);
    const { bundle, summary } = await collectArchive(config, { fetchImpl });
    const encrypted = sealArchive(bundle, config.FOXXI_ADMIN_KEY_SEED);
    const ciphertextBytes = Buffer.from(JSON.stringify(encrypted));
    Object.assign(summary, { archiveWritten: true, archiveDecryptedAndByteCompared: true,
      exactResponseHashesVerified: bundle.responses.length, ciphertextSha256: sha256(ciphertextBytes),
      manifestSha256: encrypted.header.manifestSha256,
      coverage: 'Best effort: canonical configured Basic scopes and source reconstruction materials; not a complete process export.' });
    const out = resolve('lrs-preservation-output');
    await mkdir(out, { recursive: true, mode: 0o700 });
    await writeFile(resolve(out, 'lrs-preservation.encrypted.json'), ciphertextBytes, { mode: 0o600 });
    await writeFile(resolve(out, 'lrs-preservation-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    output(`LRS_PRESERVATION=${JSON.stringify(summary)}`);
    return 0;
  } catch (e) {
    output(`LRS_PRESERVATION_FAILED=${JSON.stringify({ code: staticCode(e), archiveWritten: false, completeProcessInventory: false })}`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
