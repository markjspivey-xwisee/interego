#!/usr/bin/env node
/** Trusted operator maintenance only. No HTTP route, token creation or source-process mutation. */
import { createHash, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFile, mkdir, open, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PRIMARY = 1000;
const MAX_ALIAS = 1000;
const KINDS = ['state', 'activityProfile', 'agentProfile', 'attachments'];
const SNAPSHOT_INFO = 'interego:live-lrs-map-snapshot:v1';
const CHECKPOINT_INFO = 'interego:native-lrs-import-checkpoint:v1';
const fail = code => { throw new ImportRefusal(code); };
export class ImportRefusal extends Error {
  constructor(code) { super(code); this.name = 'ImportRefusal'; this.code = code; }
}
const sha = x => createHash('sha256').update(x).digest('hex');
const plainObject = x => x !== null && typeof x === 'object' && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const string = (x, max = 65536) => typeof x === 'string' && x.length > 0 && x.length <= max && !x.includes('\0');
const iso = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)
  && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
function base64(x, size) {
  if (typeof x !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x)) fail('invalid-base64');
  const b = Buffer.from(x, 'base64');
  if (b.toString('base64') !== x || (size !== undefined && b.length !== size)) fail('invalid-base64');
  return b;
}
export function decodeTagged(node, budget = { nodes: 0 }, depth = 0) {
  if (++budget.nodes > 300000 || depth > 50 || !plainObject(node)) fail('invalid-tagged-value');
  const recur = n => decodeTagged(n, budget, depth + 1);
  switch (node.t) {
    case 'null': return null;
    case 'undefined': return undefined;
    case 'string': if (typeof node.v !== 'string') fail('invalid-tagged-value'); return node.v;
    case 'boolean': if (typeof node.v !== 'boolean') fail('invalid-tagged-value'); return node.v;
    case 'number': if (typeof node.v !== 'number' && !['NaN', 'Infinity', '-Infinity', '-0'].includes(node.v)) fail('invalid-tagged-value'); return Number(node.v);
    case 'Buffer': {
      const b = base64(node.v);
      if (!Number.isSafeInteger(node.n) || b.length !== node.n) fail('invalid-tagged-value');
      return b;
    }
    case 'array': if (!Array.isArray(node.v)) fail('invalid-tagged-value'); return node.v.map(recur);
    case 'object': case 'null-object': {
      if (!Array.isArray(node.v)) fail('invalid-tagged-value');
      const out = node.t === 'null-object' ? Object.create(null) : {}, keys = new Set();
      for (const pair of node.v) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || keys.has(pair[0])) fail('invalid-tagged-value');
        keys.add(pair[0]);
        Object.defineProperty(out, pair[0], { value: recur(pair[1]), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    default: fail('invalid-tagged-value');
  }
}
/** Stable semantic hash keeps undefined, object prototypes and bytes; object key order is retained separately for wire statements. */
function tagged(value) {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (Buffer.isBuffer(value)) return ['bytes', value.toString('base64')];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value)];
  if (['string', 'boolean'].includes(typeof value)) return [typeof value, value];
  if (Array.isArray(value)) return ['array', value.map(tagged)];
  if (plainObject(value)) return [Object.getPrototypeOf(value) === null ? 'null-object' : 'object',
    Object.keys(value).sort().map(k => [k, tagged(value[k])])];
  fail('unsupported-source-value');
}
const valueHash = value => sha(JSON.stringify(tagged(value)));
function decryptEnvelope(envelope, seed, info, schema) {
  if (!string(seed)) fail('missing-archive-seed');
  if (!plainObject(envelope) || !plainObject(envelope.header) || envelope.header.schema !== schema
    || envelope.header.algorithm !== 'AES-256-GCM' || envelope.header.kdf !== 'HKDF-SHA256') fail('invalid-encrypted-envelope');
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(seed), base64(envelope.salt, 32), Buffer.from(info), 32));
  let clear;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, base64(envelope.iv, 12));
    cipher.setAAD(Buffer.from(JSON.stringify(envelope.header))); cipher.setAuthTag(base64(envelope.tag, 16));
    const ciphertext = base64(envelope.ciphertext);
    if (ciphertext.length > MAX_BYTES) fail('archive-byte-limit');
    clear = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    if (!HASH.test(envelope.header.plaintextSha256) || sha(clear) !== envelope.header.plaintextSha256) fail('archive-digest-mismatch');
    return clear;
  } catch (error) {
    if (error instanceof ImportRefusal) throw error;
    fail('archive-authentication-failed');
  } finally { key.fill(0); }
}
export function decryptSnapshot(encoded, seed) {
  if (Buffer.byteLength(encoded) > 100 * 1024 * 1024) fail('archive-byte-limit');
  let envelope;
  try { envelope = JSON.parse(encoded); } catch { fail('invalid-encrypted-envelope'); }
  const clear = decryptEnvelope(envelope, seed, SNAPSHOT_INFO, 'interego-encrypted-live-lrs-v1');
  try {
    if (!iso(envelope.header.createdAt) || !HASH.test(envelope.header.targetSourceSha256 ?? '')) fail('archive-source-metadata-missing');
    const raw = clear.toString('utf8'), snapshot = JSON.parse(raw), plan = validateSnapshot(snapshot);
    return { snapshot, ...plan, sourceDigest: sha(clear), archiveDigest: sha(encoded),
      provenanceTime: envelope.header.createdAt, targetSourceSha256: envelope.header.targetSourceSha256 };
  } catch (error) { if (error instanceof ImportRefusal) throw error; fail('invalid-source-snapshot'); }
  finally { clear.fill(0); }
}
function voidTarget(statement) {
  return statement?.verb?.id === 'http://adlnet.gov/expapi/verbs/voided' && statement?.object?.objectType === 'StatementRef'
    && typeof statement.object.id === 'string' ? statement.object.id : null;
}
export function validateSnapshot(snapshot) {
  if (!plainObject(snapshot) || snapshot.schema !== 'interego-live-lrs-map-snapshot-v1' || !Array.isArray(snapshot.statements)) fail('invalid-source-snapshot');
  const records = [], docs = [], attachments = [], tenants = new Set(), identities = new Set(), statementIndex = new Map();
  const counts = { statementTenants: snapshot.statements.length, tenantPartitions: 0, statements: 0, voidedStatements: 0,
    stateDocuments: 0, activityProfiles: 0, agentProfiles: 0, attachments: 0, attachmentBytes: 0 };
  const addIdentity = (tenant, kind, key) => {
    const identity = JSON.stringify([tenant, kind, key]);
    if (!string(tenant, 8192) || !string(key) || identities.has(identity)) fail('duplicate-or-invalid-record-identity');
    identities.add(identity); tenants.add(tenant);
  };
  const statementTenants = new Set();
  for (const partition of snapshot.statements) {
    if (!plainObject(partition) || !string(partition.tenant, 8192) || !Array.isArray(partition.records)
      || statementTenants.has(partition.tenant) || !['store', 'hot', 'memory.store', 'cache.store'].includes(partition.storageField)) fail('invalid-statement-partition');
    statementTenants.add(partition.tenant); tenants.add(partition.tenant);
    for (const pair of partition.records) {
      if (!Array.isArray(pair) || pair.length !== 2) fail('invalid-source-record');
      const [key, encoded] = pair, original = decodeTagged(encoded);
      addIdentity(partition.tenant, 'statement', key);
      if (!plainObject(original) || original.id !== key || !plainObject(original.statement) || original.statement.id !== key
        || !iso(original.stored) || original.statement.stored !== original.stored || typeof original.voided !== 'boolean'
        || (original.timestampAssignedByLrs !== undefined && typeof original.timestampAssignedByLrs !== 'boolean')
        || (!original.voided && Object.hasOwn(original, 'voidingStatementId'))
        || (original.voided && !string(original.voidingStatementId))) fail('invalid-source-statement');
      const base = { ...original, voided: false }; delete base.voidingStatementId;
      const row = { tenant: partition.tenant, id: key, original, base };
      statementIndex.set(JSON.stringify([row.tenant, key]), row); records.push(row);
      counts.statements++; if (original.voided) counts.voidedStatements++;
    }
  }
  const voids = [];
  for (const record of records) {
    if (!record.original.voided) continue;
    const voider = statementIndex.get(JSON.stringify([record.tenant, record.original.voidingStatementId]));
    if (!voider || voidTarget(voider.original.statement) !== record.id || voidTarget(record.original.statement)) fail('source-void-relationship-incomplete');
    voids.push({ tenant: record.tenant, id: record.id, value: { target: record.id, voidingStatementId: record.original.voidingStatementId } });
  }
  for (const kind of KINDS) {
    if (!Array.isArray(snapshot[kind])) fail('invalid-resource-partition');
    const partitionTenants = new Set();
    for (const part of snapshot[kind]) {
      if (!Array.isArray(part) || part.length !== 2 || !string(part[0], 8192) || !Array.isArray(part[1]) || partitionTenants.has(part[0])) fail('invalid-resource-partition');
      const [tenant, entries] = part; tenants.add(tenant); partitionTenants.add(tenant);
      for (const pair of entries) {
        if (!Array.isArray(pair) || pair.length !== 2) fail('invalid-source-record');
        const [key, encoded] = pair, value = decodeTagged(encoded);
        addIdentity(tenant, kind, key);
        if (kind === 'attachments') {
          if (!HASH.test(key) || !plainObject(value) || !Buffer.isBuffer(value.data) || !string(value.contentType, 200) || sha(value.data) !== key
            || Object.keys(value).some(k => !['data', 'contentType'].includes(k))) fail('invalid-source-attachment');
          attachments.push({ tenant, id: key, value }); counts.attachments++; counts.attachmentBytes += value.data.length;
        } else {
          if (!plainObject(value) || typeof value.etag !== 'string' || !iso(value.updated) || !string(value.contentType, 1024) || !Object.hasOwn(value, 'content')) fail('invalid-source-document');
          docs.push({ tenant, kind, id: key, value });
          counts[{ state: 'stateDocuments', activityProfile: 'activityProfiles', agentProfile: 'agentProfiles' }[kind]]++;
        }
      }
    }
  }
  for (const record of records) for (const attachment of Array.isArray(record.original.statement.attachments) ? record.original.statement.attachments : []) {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.sha2 !== 'string') fail('invalid-source-statement-attachment');
    if (!attachment.fileUrl && !identities.has(JSON.stringify([record.tenant, 'attachments', attachment.sha2.toLowerCase()]))) fail('source-attachment-bytes-missing');
  }
  counts.tenantPartitions = tenants.size;
  const primaryCount = records.length + docs.length + attachments.length + voids.length + tenants.size;
  if (primaryCount > MAX_PRIMARY) fail('primary-import-exceeds-atomic-bound');
  if (records.length > MAX_ALIAS) fail('query-projection-exceeds-atomic-bound');
  return { records, docs, attachments, voids, tenants: [...tenants].sort(), counts, primaryCount };
}
function decodeNative(encoded) {
  if (!Array.isArray(encoded) || encoded.length !== 2) fail('native-roundtrip-failed');
  const [tag, value] = encoded;
  if (tag === 'bytes') return base64(value);
  if (tag === 'value') return value;
  if (tag === 'array') return value.map(decodeNative);
  if (tag === 'object') return Object.fromEntries(value.map(([key, val]) => [key, decodeNative(val)]));
  fail('native-roundtrip-failed');
}
function artifactShape(artifact) { return { topUri: artifact.topUri, nodes: artifact.pgsl.nodes }; }
export function buildNativePlan(database, input, runtime) {
  const { createNativeByteArtifact, readNativeByteArtifact } = runtime;
  const provenance = { wasAttributedTo: database.owner, generatedAtTime: input.provenanceTime };
  const primary = [], queries = [], expected = new Map();
  const push = (tenant, kind, id, value) => {
    const provisional = database.artifact(tenant, kind, id, value);
    const payload = readNativeByteArtifact(artifactShape(provisional));
    const decoded = decodeNative(JSON.parse(Buffer.from(payload.bytes).toString('utf8')).value);
    if (valueHash(decoded) !== valueHash(value)) fail('native-value-would-lose-source-fidelity');
    const artifact = createNativeByteArtifact({ owner: database.owner, contentType: payload.contentType, bytes: payload.bytes, provenance });
    const key = database.key(tenant, kind, id);
    primary.push({ key, artifact }); expected.set(key, { tenant, kind, id, valueHash: valueHash(value) });
    return artifact;
  };
  for (const tenant of input.tenants) push(tenant, 'registry', 'tenant', tenant);
  for (const row of input.records) {
    const artifact = push(row.tenant, 'statement', row.id, row.base);
    queries.push({ key: database.queryKey(row.tenant, row.base), artifact });
  }
  for (const row of input.docs) push(row.tenant, row.kind, row.id, row.value);
  for (const row of input.voids) push(row.tenant, 'void', row.id, row.value);
  for (const row of input.attachments) {
    const artifact = createNativeByteArtifact({ owner: database.owner, contentType: row.value.contentType, bytes: row.value.data, provenance });
    const key = database.key(row.tenant, 'attachment', row.id); primary.push({ key, artifact });
    expected.set(key, { tenant: row.tenant, kind: 'attachment', id: row.id, valueHash: valueHash(row.value) });
  }
  if (primary.length !== input.primaryCount || primary.length > MAX_PRIMARY || queries.length > MAX_ALIAS
    || new Set([...primary, ...queries].map(x => x.key)).size !== primary.length + queries.length) fail('native-plan-capacity-or-key-conflict');
  const planDigest = sha(JSON.stringify([...primary, ...queries].map(change =>
    [change.key, nativeArtifactHash(change.artifact, runtime)]).sort(([a], [b]) => a.localeCompare(b))));
  const bindings = { sourceDigest: input.sourceDigest, archiveDigest: input.archiveDigest, provenanceTime: input.provenanceTime,
    targetSourceSha256: input.targetSourceSha256, owner: database.owner, planDigest };
  return { primary, queries, expected, bindings, source: input };
}
function nativeArtifactHash(artifact, runtime) {
  const payload = runtime.readNativeByteArtifact(artifactShape(artifact));
  return valueHash({ owner: payload.owner, contentType: payload.contentType, bytes: Buffer.from(payload.bytes),
    nodes: Object.fromEntries(artifact.pgsl.nodes), topUri: artifact.topUri });
}
async function compareHead(database, snapshot, changes, runtime) {
  if (snapshot.records.size !== changes.length) return false;
  for (const change of changes) {
    const ref = snapshot.records.get(change.key); if (!ref) return false;
    const actual = await database.client.readArtifact(ref);
    const expected = nativeArtifactHash(change.artifact, runtime);
    const fake = { topUri: actual.topUri, pgsl: { nodes: actual.nodes } };
    if (nativeArtifactHash(fake, runtime) !== expected) return false;
  }
  return true;
}
function receiptSummary(receipt) {
  return { operationId: receipt.operationId, head: receipt.head, previousHead: receipt.previousHead,
    replayed: receipt.replayed, resourceReceipt: receipt.resourceReceipt ? {
      resource: receipt.resourceReceipt.resource, revision: receipt.resourceReceipt.revision,
      bodyDigest: receipt.resourceReceipt.bodyDigest, expectedRevision: receipt.resourceReceipt.expectedRevision,
    } : null };
}
/** Complete fixed-head verification checks raw primaries, query aliases and reconstructed original envelopes. */
export async function verifyPlan(database, plan, head, runtime, aliases = true) {
  const changes = aliases ? [...plan.primary, ...plan.queries] : plan.primary;
  if (!await compareHead(database, head, changes, runtime)) fail('native-import-readback-mismatch');
  for (const row of plan.source.records) {
    const base = await database.read(head, row.tenant, 'statement', row.id);
    const edge = await database.read(head, row.tenant, 'void', row.id);
    const reconstructed = edge ? { ...base, voided: true, voidingStatementId: edge.voidingStatementId } : base;
    if (valueHash(reconstructed) !== valueHash(row.original)
      || JSON.stringify(reconstructed.statement) !== JSON.stringify(row.original.statement)) fail('restored-statement-envelope-mismatch');
  }
  return { ...plan.source.counts, primaryRecords: plan.primary.length, queryAliases: aliases ? plan.queries.length : 0,
    sourceDigest: plan.source.sourceDigest, archiveDigest: plan.source.archiveDigest,
    exactStatementWireBodies: true, exactStoredAuthorityAndVoidFlags: true, exactOpaqueCollectionKeys: true,
    exactDocumentMetadataAndBytes: true, restoredRecordSetSha256: plan.bindings.planDigest,
    fixedHead: head.reference, cutoverReady: aliases, sourceAsOfOnly: true };
}
/** All primary records publish in ONE CAS; aliases are derived and require their own pre-serving CAS. */
export async function executeImport(database, plan, runtime, { apply = false, checkpoint, saveCheckpoint } = {}) {
  await database.client.ready(); // Discovery only; never database.ready(), which performs an unrelated write.
  const initial = await database.client.readHead(), scope = initial.scope;
  const binding = sha(JSON.stringify({ ...plan.bindings, scope }));
  const primaryOperation = 'foxxi-lrs-restore:' + binding + ':primary';
  const queryOperation = 'foxxi-lrs-restore:' + binding + ':queries';
  let state = checkpoint;
  if (state && (state.schema !== 'interego-native-lrs-import-checkpoint-v1' || state.binding !== binding
    || state.primaryOperation !== primaryOperation || state.queryOperation !== queryOperation)) fail('checkpoint-input-or-scope-mismatch');
  if (!state) state = { schema: 'interego-native-lrs-import-checkpoint-v1', binding, scope,
    bindings: plan.bindings, primaryOperation, queryOperation, stage: 'planned', before: {
      revision: initial.revision, reference: initial.reference, operationId: initial.operationId,
    }, primaryReceipt: null, queryReceipt: null, cutoverReady: false };
  if (apply) {
    if (typeof saveCheckpoint !== 'function') fail('durable-maintenance-checkpoint-required');
    state.cutoverReady = false;
    if (state.stage === 'complete') state.stage = 'revalidating';
    await saveCheckpoint(state);
  }
  const primaryPresent = await compareHead(database, initial, plan.primary, runtime);
  const completePresent = await compareHead(database, initial, [...plan.primary, ...plan.queries], runtime);
  if (initial.records.size && !primaryPresent && !completePresent) fail('destination-not-empty-or-conflicting');
  if (initial.records.size && !checkpoint && ![primaryOperation, queryOperation].includes(initial.operationId)) fail('destination-import-history-unverified');
  if (completePresent && (plan.primary.length || initial.operationId === queryOperation)) {
    const report = await verifyPlan(database, plan, initial, runtime, true);
    if ((await database.client.readHead()).revision !== initial.revision) fail('destination-changed-during-verification');
    state.stage = 'complete'; state.cutoverReady = true; state.finalHead = initial.reference; state.report = report;
    if (apply) await saveCheckpoint?.(state);
    return { ...report, applied: false, idempotent: true, dryRun: !apply, checkpoint: state };
  }
  if (!apply) return { dryRun: true, applied: false, primaryChanges: plan.primary.length, derivedQueryChanges: plan.queries.length,
    needsPrimaryCommit: !primaryPresent, needsDerivedCommit: true, cutoverReady: false,
    ...plan.source.counts, sourceDigest: plan.source.sourceDigest, archiveDigest: plan.source.archiveDigest, checkpoint: state };
  // Encrypted bindings and planned operation IDs were persisted before any write.
  let primaryHead;
  if (primaryPresent) {
    if (initial.operationId !== primaryOperation && state.primaryReceipt?.head?.revision !== initial.revision) fail('primary-import-history-unverified');
    primaryHead = initial;
  } else {
    if (initial.records.size) fail('destination-not-empty-or-conflicting');
    const expected = { scope, revision: state.before.revision, reference: state.before.reference,
      operationId: state.before.operationId, records: new Map() };
    const receipt = await database.client.commit({ operationId: primaryOperation, expected, changes: plan.primary });
    state.primaryReceipt = receiptSummary(receipt); primaryHead = receipt.snapshot;
  }
  await verifyPlan(database, plan, primaryHead, runtime, false);
  state.stage = 'primary-committed'; state.cutoverReady = false; state.primaryHead = primaryHead.reference;
  await saveCheckpoint(state);
  const derivedReceipt = await database.client.commit({ operationId: queryOperation, expected: primaryHead, changes: plan.queries });
  state.queryReceipt = receiptSummary(derivedReceipt);
  const finalHead = await database.client.readSnapshotAt(derivedReceipt.head);
  const report = await verifyPlan(database, plan, finalHead, runtime, true);
  // Refuse to declare ready if another writer published while restoration was being verified.
  const current = await database.client.readHead();
  if (current.revision !== finalHead.revision) fail('destination-changed-during-verification');
  state.stage = 'complete'; state.cutoverReady = true; state.finalHead = finalHead.reference; state.report = report;
  await saveCheckpoint(state);
  return { ...report, applied: true, idempotent: false, dryRun: false, checkpoint: state };
}
export function encryptCheckpoint(state, seed) {
  if (!string(seed)) fail('missing-archive-seed');
  const plaintext = Buffer.from(JSON.stringify(state)), salt = randomBytes(32), iv = randomBytes(12);
  const header = { schema: 'interego-encrypted-native-lrs-checkpoint-v1', algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256',
    plaintextSha256: sha(plaintext), createdAt: new Date().toISOString() };
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(seed), salt, Buffer.from(CHECKPOINT_INFO), 32));
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return JSON.stringify({ header, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  } finally { key.fill(0); plaintext.fill(0); }
}
export function decryptCheckpoint(encoded, seed) {
  let envelope; try { envelope = JSON.parse(encoded); } catch { fail('invalid-encrypted-envelope'); }
  const clear = decryptEnvelope(envelope, seed, CHECKPOINT_INFO, 'interego-encrypted-native-lrs-checkpoint-v1');
  try { return JSON.parse(clear.toString('utf8')); } finally { clear.fill(0); }
}
async function writePrivateAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.tmp-' + randomBytes(8).toString('hex');
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
export function parseArguments(args) {
  const allowed = new Set(['--archive', '--checkpoint', '--runtime', '--apply', '--expect-source-sha', '--offline']);
  const result = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.has(key) || result.has(key)) fail('unknown-or-duplicate-cli-argument');
    if (['--apply', '--offline'].includes(key)) result.set(key, true);
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail('missing-cli-argument-value');
      result.set(key, args[++i]);
    }
  }
  return result;
}
export function validateArtifactPaths(archivePath, checkpointPath, runtimePath, scriptPath) {
  const protectedPaths = [archivePath, runtimePath, scriptPath].map(path => resolve(path));
  const outputs = [checkpointPath, checkpointPath + '.summary.json'].map(path => resolve(path));
  if (new Set([...protectedPaths, ...outputs]).size !== protectedPaths.length + outputs.length) fail('maintenance-artifact-path-collision');
}
async function main() {
  const args = parseArguments(process.argv.slice(2)), flag = name => args.get(name) === true, get = name => args.get(name);
  const archivePath = get('--archive'); if (!archivePath) fail('archive-required');
  const seed = process.env.FOXXI_ADMIN_KEY_SEED;
  const source = decryptSnapshot(await readFile(resolve(archivePath), 'utf8'), seed);
  if (get('--expect-source-sha') && get('--expect-source-sha') !== source.targetSourceSha256) fail('source-script-mismatch');
  if (flag('--offline')) {
    if (flag('--apply')) fail('offline-cannot-apply');
    console.log(JSON.stringify({ dryRun: true, offline: true, archiveValidationOnly: true, nativeRepresentabilityChecked: false,
      ...source.counts, primaryChanges: source.primaryCount,
      sourceDigest: source.sourceDigest, archiveDigest: source.archiveDigest, cutoverReady: false })); return;
  }
  const runtimePath = resolve(get('--runtime') || resolve(dirname(new URL(import.meta.url).pathname), 'runtime.mjs'));
  const checkpointPath = resolve(get('--checkpoint') || archivePath + '.native-import.checkpoint.encrypted.json');
  validateArtifactPaths(resolve(archivePath), checkpointPath, runtimePath, new URL(import.meta.url).pathname);
  const runtime = await import(pathToFileURL(runtimePath).href);
  const database = runtime.createConfiguredNativeLrsDatabase();
  const plan = buildNativePlan(database, source, runtime);
  let checkpoint;
  try { checkpoint = decryptCheckpoint(await readFile(checkpointPath, 'utf8'), seed); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = await executeImport(database, plan, runtime, { apply: flag('--apply'), checkpoint,
    saveCheckpoint: state => writePrivateAtomic(checkpointPath, encryptCheckpoint(state, seed)) });
  const { checkpoint: _private, ...safeReport } = report;
  if (flag('--apply')) await writePrivateAtomic(checkpointPath + '.summary.json', JSON.stringify(safeReport, null, 2));
  console.log(JSON.stringify(safeReport));
  await database.close();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: error instanceof ImportRefusal ? error.code : 'native-maintenance-operation-failed',
    cutoverReady: false, instruction: 'Keep the replacement unserved; retain the encrypted archive and checkpoint.' }));
  process.exitCode = 1;
});
