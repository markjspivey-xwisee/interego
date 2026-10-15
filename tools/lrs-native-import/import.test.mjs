import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeTagged, decryptSnapshot, validateSnapshot, buildNativePlan, executeImport, encryptCheckpoint, decryptCheckpoint,
  parseArguments, validateArtifactPaths } from './import.mjs';
import * as runtime from './runtime.mjs';
import { encryptLiveSnapshot } from '../lrs-inprocess-export/export.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const time = '2026-10-15T19:40:00.000Z', seed = 'synthetic-private-maintenance-fixture-seed';
function encode(value) {
  if (value === null) return { t: 'null' };
  if (value === undefined) return { t: 'undefined' };
  if (Buffer.isBuffer(value)) return { t: 'Buffer', n: value.length, v: value.toString('base64') };
  if (typeof value === 'number') return { t: 'number', v: Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value) };
  if (['string', 'boolean'].includes(typeof value)) return { t: typeof value, v: value };
  if (Array.isArray(value)) return { t: 'array', v: value.map(encode) };
  return { t: Object.getPrototypeOf(value) === null ? 'null-object' : 'object', v: Object.entries(value).map(([k, v]) => [k, encode(v)]) };
}
const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function statement(i) {
  const sid = id(i);
  return { id: sid, statement: { id: sid, actor: { account: { homePage: 'https://subject.test', name: 'fixture' } },
    verb: { id: 'https://verbs.test/observed' }, object: { id: 'https://tasks.test/' + i },
    stored: time, timestamp: '2026-10-14T14:00:00.000Z', authority: { account: { homePage: 'https://old-lrs.test', name: 'original-authority' } },
    context: { extensions: { 'https://extension.test/a': { value: i } } } }, stored: time, voided: false };
}
function fixture(n = 779) {
  const bytes = Buffer.from([0, 0xff, 1, 0, 0x80]), attachmentHash = sha(bytes);
  const partitions = [
    { tenant: 'default', storageField: 'store', records: [] },
    { tenant: 'lens:Case Sensitive / untouched', storageField: 'store', records: [] },
    { tenant: 'https://tenant.example/Path/', storageField: 'store', records: [] },
  ];
  for (let i = 0; i < n; i++) {
    const row = statement(i);
    if (i === 0) row.statement.attachments = [{ sha2: attachmentHash, contentType: 'application/octet-stream', length: bytes.length }];
    partitions[i % 3].records.push([row.id, encode(row)]);
  }
  if (n > 3) {
    const target = decodeTagged(partitions[0].records[1][1]);
    target.voided = true; target.voidingStatementId = id(6);
    partitions[0].records[1][1] = encode(target);
    const voider = decodeTagged(partitions[0].records[2][1]);
    voider.statement.verb = { id: 'http://adlnet.gov/expapi/verbs/voided' };
    voider.statement.object = { objectType: 'StatementRef', id: target.id };
    partitions[0].records[2][1] = encode(voider);
  }
  const document = content => ({ content, etag: '"original-opaque-etag"', updated: time, contentType: Buffer.isBuffer(content) ? 'application/octet-stream' : 'application/json' });
  return { schema: 'interego-live-lrs-map-snapshot-v1', statements: partitions,
    state: [['default', [['exact | state key []', encode(document(bytes))]]]],
    activityProfile: [['lens:Case Sensitive / untouched', [['literal profile key', encode(document({ type: 'Buffer', data: [1, 2, 3] }))]]]],
    agentProfile: [['https://tenant.example/Path/', [['{"agent":"opaque"}', encode(document(bytes))]]], ['empty document-only tenant', []]],
    attachments: [['default', [[attachmentHash, encode({ data: bytes, contentType: 'application/octet-stream' })]]]],
    counts: { nodes: 1, rows: n + 4, binaryBytes: bytes.length * 3 } };
}
function input(snapshot, options = {}) {
  return { snapshot, ...validateSnapshot(snapshot, options), sourceDigest: sha(JSON.stringify(snapshot)), archiveDigest: sha('synthetic-archive:' + JSON.stringify(snapshot)),
    provenanceTime: time, targetSourceSha256: 'a'.repeat(64) };
}
const scope = { pod: 'https://native.test/tenant/', owner: 'did:web:tenant.test', headUrl: 'https://native.test/tenant/native/head',
  artifactContainer: 'https://native.test/tenant/native/artifacts/' };
function stable(value) {
  if (value instanceof Map) return [...value].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]);
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
class FakeNativeClient {
  constructor() {
    this.head = { scope, revision: null, reference: null, operationId: null, records: new Map() };
    this.operations = new Map(); this.artifacts = new Map(); this.snapshots = new Map(); this.writes = 0; this.commits = 0;
    this.failAfterCommit = null; this.failBeforeOperation = null; this.readyCount = 0;
  }
  async ready() { this.readyCount++; }
  async readHead() { return { ...this.head, records: new Map(this.head.records) }; }
  async readSnapshotAt(ref) { return this.snapshots.get(ref.revision); }
  async readArtifact(ref) { const found = this.artifacts.get(ref.resourceUrl); if (!found) throw new Error('missing artifact'); return found; }
  async commit(request) {
    const digest = sha(JSON.stringify(stable(request.changes.map(c => [c.key, c.artifact]))));
    const prior = this.operations.get(request.operationId);
    if (prior) { assert.equal(digest, prior.digest, 'stable replay must preserve exact artifact provenance'); return { ...prior.receipt, replayed: true }; }
    if (this.failBeforeOperation && request.operationId.endsWith(this.failBeforeOperation)) throw new Error('fixture storage unavailable');
    assert.ok(request.changes.length <= 1000);
    if (request.expected.revision !== this.head.revision) throw new runtime.NativeCommitConflictError();
    const records = new Map(this.head.records);
    for (const change of request.changes) {
      this.writes++;
      if (!change.artifact) { records.delete(change.key); continue; }
      const key = sha(JSON.stringify(stable(change.artifact)));
      const ref = { resourceUrl: 'https://native.test/artifact/' + key, bodyDigest: 'sha256:' + key, plaintextDigest: 'sha256:' + key, topUri: change.artifact.topUri };
      this.artifacts.set(ref.resourceUrl, { topUri: change.artifact.topUri, nodes: new Map(change.artifact.pgsl.nodes) }); records.set(change.key, ref);
    }
    const revision = 'sha256:' + sha('revision:' + (++this.commits));
    const reference = { revision, commitUrl: 'https://native.test/commit/' + revision.slice(7), topUri: 'urn:pgsl:fragment:' + 'a'.repeat(40) };
    const snapshot = { scope, revision, reference, operationId: request.operationId, records };
    const receipt = { operationId: request.operationId, scope, previousHead: this.head.reference, head: reference,
      snapshot, createdAt: time, replayed: false, resourceReceipt: { resource: scope.headUrl, revision, bodyDigest: 'sha256:' + digest, expectedRevision: request.expected.revision } };
    this.head = snapshot; this.snapshots.set(revision, snapshot); this.operations.set(request.operationId, { digest, receipt });
    if (this.failAfterCommit && request.operationId.endsWith(this.failAfterCommit)) { this.failAfterCommit = null; throw new Error('fixture lost ACK'); }
    return receipt;
  }
}
function database(client, cursorSecret = 'c'.repeat(32)) {
  return new runtime.NativeInteregoLrsDatabase({ client, owner: scope.owner, scopeIdentity: JSON.stringify(scope), cursorSecret });
}
async function setup(n = 779) {
  const source = input(fixture(n)), client = new FakeNativeClient(), db = database(client), plan = buildNativePlan(db, source, runtime);
  let checkpoint;
  const saveCheckpoint = async value => { checkpoint = decryptCheckpoint(encryptCheckpoint(value, seed), seed); };
  return { source, client, db, plan, saveCheckpoint, checkpoint: () => checkpoint };
}

test('779-record source with exact metadata, valid void, binary docs, orphan attachment and empty tenant imports atomically then aliases', async () => {
  const s = await setup();
  const dry = await executeImport(s.db, s.plan, runtime);
  assert.equal(dry.dryRun, true); assert.equal(s.client.commits, 0); assert.equal(dry.cutoverReady, false);
  assert.equal(dry.statements, 779); assert.equal(dry.tenantPartitions, 4);
  const result = await executeImport(s.db, s.plan, runtime, { apply: true, saveCheckpoint: s.saveCheckpoint });
  assert.equal(s.client.commits, 2); assert.equal(result.primaryRecords, 788); assert.equal(result.queryAliases, 779);
  assert.equal(result.cutoverReady, true); assert.equal(result.exactStoredAuthorityAndVoidFlags, true);
  assert.equal(s.checkpoint().stage, 'complete');
  const countsBefore = s.client.writes;
  const again = await executeImport(s.db, buildNativePlan(s.db, s.source, runtime), runtime,
    { apply: true, checkpoint: s.checkpoint(), saveCheckpoint: s.saveCheckpoint });
  assert.equal(again.idempotent, true); assert.equal(s.client.writes, countsBefore); assert.equal(s.client.commits, 2);
});

test('primary ACK loss resumes from encrypted planned checkpoint without duplicating records', async () => {
  const s = await setup(12); s.client.failAfterCommit = ':primary';
  await assert.rejects(executeImport(s.db, s.plan, runtime, { apply: true, saveCheckpoint: s.saveCheckpoint }), /lost ACK/);
  assert.equal(s.client.commits, 1); assert.equal(s.checkpoint().stage, 'planned');
  const result = await executeImport(s.db, buildNativePlan(s.db, s.source, runtime), runtime,
    { apply: true, checkpoint: s.checkpoint(), saveCheckpoint: s.saveCheckpoint });
  assert.equal(result.cutoverReady, true); assert.equal(s.client.commits, 2);
});

test('aliases ACK loss resumes by full fixed-head proof; derived failure stays unready', async () => {
  const s = await setup(12); s.client.failBeforeOperation = ':queries';
  await assert.rejects(executeImport(s.db, s.plan, runtime, { apply: true, saveCheckpoint: s.saveCheckpoint }), /storage unavailable/);
  assert.equal(s.checkpoint().stage, 'primary-committed'); assert.equal(s.checkpoint().cutoverReady, false);
  const dry = await executeImport(s.db, s.plan, runtime, { checkpoint: s.checkpoint() });
  assert.equal(dry.needsPrimaryCommit, false); assert.equal(dry.cutoverReady, false);
  s.client.failBeforeOperation = null; s.client.failAfterCommit = ':queries';
  await assert.rejects(executeImport(s.db, s.plan, runtime, { apply: true, checkpoint: s.checkpoint(), saveCheckpoint: s.saveCheckpoint }), /lost ACK/);
  assert.equal(s.checkpoint().stage, 'primary-committed');
  const resumed = await executeImport(s.db, s.plan, runtime, { apply: true, checkpoint: s.checkpoint(), saveCheckpoint: s.saveCheckpoint });
  assert.equal(resumed.cutoverReady, true); assert.equal(resumed.idempotent, true); assert.equal(s.client.commits, 2);
});

test('source or scope/cursor binding changes refuse before any new write', async () => {
  const s = await setup(12);
  await executeImport(s.db, s.plan, runtime, { apply: true, saveCheckpoint: s.saveCheckpoint });
  const writes = s.client.writes;
  for (const field of ['stored', 'authority']) {
    const snapshot = fixture(12), original = decodeTagged(snapshot.statements[0].records[0][1]);
    if (field === 'stored') { original.stored = '2026-10-15T19:41:00.000Z'; original.statement.stored = original.stored; }
    else original.statement.authority = { account: { homePage: 'https://other.test', name: 'changed' } };
    snapshot.statements[0].records[0][1] = encode(original);
    await assert.rejects(executeImport(s.db, buildNativePlan(s.db, input(snapshot), runtime), runtime,
      { apply: true, checkpoint: s.checkpoint(), saveCheckpoint: s.saveCheckpoint }), /checkpoint-input-or-scope-mismatch/);
  }
  const changedKey = database(s.client, 'd'.repeat(32));
  await assert.rejects(executeImport(changedKey, buildNativePlan(changedKey, s.source, runtime), runtime,
    { apply: true, checkpoint: s.checkpoint(), saveCheckpoint: s.saveCheckpoint }), /checkpoint-input-or-scope-mismatch/);
  assert.equal(s.client.writes, writes);
});

test('duplicates, dangling/mismatched voids, missing binary bytes and atomic primary overflow fail preflight', () => {
  const duplicate = fixture(12); duplicate.state.push(duplicate.state[0]);
  assert.throws(() => validateSnapshot(duplicate), /invalid-resource-partition/);
  const missing = fixture(12); missing.statements[0].records.splice(2, 1);
  assert.throws(() => validateSnapshot(missing), /source-void-relationship-incomplete/);
  const wrong = fixture(12), voider = decodeTagged(wrong.statements[0].records[2][1]);
  voider.statement.object.id = id(33); wrong.statements[0].records[2][1] = encode(voider);
  assert.throws(() => validateSnapshot(wrong), /source-void-relationship-incomplete/);
  const noBytes = fixture(12); noBytes.attachments = [];
  assert.throws(() => validateSnapshot(noBytes), /source-attachment-bytes-missing/);
  assert.throws(() => validateSnapshot(fixture(1000)), /primary-import-exceeds-atomic-bound/);
});

test('native representability rejects undefined, null-prototype, negative zero and nonfinite payload loss', () => {
  for (const value of [undefined, Object.assign(Object.create(null), { a: 1 }), -0, Infinity]) {
    const snapshot = fixture(12), original = decodeTagged(snapshot.state[0][1][0][1]); original.content = { x: value };
    snapshot.state[0][1][0][1] = encode(original);
    const db = database(new FakeNativeClient());
    assert.throws(() => buildNativePlan(db, input(snapshot), runtime), /native-value-would-lose-source-fidelity|unsupported-legacy-value-cannot-project/);
  }
});

test('explicit undefined-own-property projection preserves wire JSON, original archive binding and native binary readback', async () => {
  const snapshot = fixture(12), original = decodeTagged(snapshot.statements[0].records[0][1]);
  original.timestampAssignedByLrs = undefined; original.voidingStatementId = undefined;
  original.statement.authority.account.optional = undefined;
  original.statement.context.extensions['https://extension.test/a'].optional = undefined;
  snapshot.statements[0].records[0][1] = encode(original);
  const document = decodeTagged(snapshot.state[0][1][0][1]); document.optional = undefined;
  snapshot.state[0][1][0][1] = encode(document);
  const raw = JSON.stringify(snapshot), encrypted = JSON.stringify(encryptLiveSnapshot(raw, seed, { targetSourceSha256: 'a'.repeat(64) }).envelope);
  assert.throws(() => decryptSnapshot(encrypted, seed), error => {
    assert.equal(error.code, 'native-value-would-lose-source-fidelity');
    assert.equal(error.diagnostics.nonJsonKindCounts.undefinedObjectProperties, 5);
    assert.deepEqual(Object.keys(error.diagnostics), ['nonJsonKindCounts']); return true;
  });
  const source = decryptSnapshot(encrypted, seed, { omitLegacyUndefinedProperties: true });
  assert.equal(source.sourceDigest, sha(raw)); assert.equal(source.archiveDigest, sha(encrypted));
  assert.equal(source.sourceProjection.undefinedPropertiesOmitted, 5); assert.equal(source.sourceProjection.recordsAffected, 2);
  assert.equal(source.sourceProjection.projectPolicy, 'omit-legacy-undefined-own-object-properties/1');
  assert.equal(source.sourceProjection.wireJsonUnchanged, true); assert.equal(source.sourceProjection.taggedObjectIdentityPreserved, false);
  assert.equal(source.sourceProjection.rawArchiveUnchanged, true);
  assert.equal(JSON.stringify(source.records[0].original), JSON.stringify(original));
  assert.equal(Object.hasOwn(source.records[0].original, 'voidingStatementId'), false);
  assert.equal(JSON.stringify(snapshot), raw, 'original tagged snapshot must remain byte-identical');
  assert.deepEqual(source.docs[0].value.content, document.content);
  const client = new FakeNativeClient(), db = database(client), plan = buildNativePlan(db, source, runtime);
  let checkpoint;
  const saveCheckpoint = async value => { checkpoint = decryptCheckpoint(encryptCheckpoint(value, seed), seed); };
  const dry = await executeImport(db, plan, runtime);
  assert.equal(dry.undefinedPropertiesOmitted, 5); assert.equal(dry.recordsAffected, 2); assert.equal(client.writes, 0);
  const restored = await executeImport(db, plan, runtime, { apply: true, saveCheckpoint });
  assert.equal(restored.cutoverReady, true); assert.equal(restored.wireJsonUnchanged, true);
  assert.equal(restored.sourceDigest, sha(raw)); assert.equal(restored.archiveDigest, sha(encrypted));
  assert.equal(checkpoint.bindings.sourceProjection.projectionWireJsonSha256, source.sourceProjection.projectionWireJsonSha256);
  const fresh = database(client);
  assert.equal(JSON.stringify(await fresh.forTenant('default').get(original.id)), JSON.stringify(original));
  assert.deepEqual((await fresh.forTenant('default').getResource('state', source.docs[0].id)).content, document.content);
});

test('projection refuses undefined array/root values and every other non-JSON kind with safe aggregate diagnostics', () => {
  for (const [value, kind] of [[{ a: [undefined] }, 'undefinedArrayElements'], [undefined, 'undefinedObjectProperties'],
    [{ a: -0 }, 'negativeZeroNumbers'], [{ a: Infinity }, 'nonFiniteNumbers'],
    [Object.assign(Object.create(null), { a: 1 }), 'nullPrototypeObjects']]) {
    const snapshot = fixture(12), document = decodeTagged(snapshot.state[0][1][0][1]);
    document.content = value; snapshot.state[0][1][0][1] = encode(document);
    if (value === undefined) {
      // Removing a required document property still fails structural validation.
      assert.throws(() => validateSnapshot(snapshot, { omitLegacyUndefinedProperties: true }), /invalid-source-document/);
    } else assert.throws(() => validateSnapshot(snapshot, { omitLegacyUndefinedProperties: true }), error => {
      assert.equal(error.code, 'unsupported-legacy-value-cannot-project'); assert.equal(error.diagnostics.nonJsonKindCounts[kind], 1);
      assert.equal(JSON.stringify(error.diagnostics).includes('content'), false); return true;
    });
  }
  const root = fixture(12); root.state[0][1][0][1] = encode(undefined);
  assert.throws(() => validateSnapshot(root, { omitLegacyUndefinedProperties: true }), error => {
    assert.equal(error.diagnostics.nonJsonKindCounts.undefinedRootValues, 1); return true;
  });
});

test('projection policy and JSON wire hashes bind checkpoints even when no properties require omission', async () => {
  const snapshot = fixture(12), strict = input(snapshot), projected = input(snapshot, { omitLegacyUndefinedProperties: true });
  assert.equal(strict.sourceProjection.projectionWireJsonSha256, projected.sourceProjection.projectionWireJsonSha256);
  assert.equal(strict.sourceDigest, projected.sourceDigest); assert.equal(projected.sourceProjection.undefinedPropertiesOmitted, 0);
  const client = new FakeNativeClient(), db = database(client); let checkpoint;
  await executeImport(db, buildNativePlan(db, projected, runtime), runtime, { apply: true, saveCheckpoint: async value => { checkpoint = structuredClone(value); } });
  const writes = client.writes;
  await assert.rejects(executeImport(db, buildNativePlan(db, strict, runtime), runtime,
    { apply: true, checkpoint, saveCheckpoint: async () => {} }), /checkpoint-input-or-scope-mismatch/);
  assert.equal(client.writes, writes);
  const changed = fixture(12), document = decodeTagged(changed.state[0][1][0][1]); document.content[0] = 42;
  changed.state[0][1][0][1] = encode(document);
  assert.notEqual(input(changed, { omitLegacyUndefinedProperties: true }).sourceProjection.projectionWireJsonSha256,
    projected.sourceProjection.projectionWireJsonSha256);
});

test('authenticated snapshot decrypt matches exporter format; wrong seed/body tampering and checkpoint tampering fail', () => {
  const snapshot = fixture(12), raw = JSON.stringify(snapshot);
  const exported = encryptLiveSnapshot(raw, seed, { targetSourceSha256: 'a'.repeat(64) });
  const encoded = JSON.stringify(exported.envelope), result = decryptSnapshot(encoded, seed);
  assert.equal(result.counts.statements, 12); assert.equal(result.sourceDigest, sha(raw));
  assert.throws(() => decryptSnapshot(encoded, 'incorrect-seed'), /archive-authentication-failed/);
  const tampered = structuredClone(exported.envelope); tampered.header.targetSourceSha256 = 'b'.repeat(64);
  assert.throws(() => decryptSnapshot(JSON.stringify(tampered), seed), /archive-authentication-failed/);
  const checkpoint = encryptCheckpoint({ schema: 'fixture', key: 'protected' }, seed);
  assert.deepEqual(decryptCheckpoint(checkpoint, seed), { schema: 'fixture', key: 'protected' });
  assert.throws(() => decryptCheckpoint(checkpoint, 'wrong-seed'), /archive-authentication-failed/);
});

test('pre-primary conflict has no publication and a concurrent final-head change refuses readiness', async () => {
  const s = await setup(12), actualCommit = s.client.commit.bind(s.client);
  s.client.commit = async request => { if (request.operationId.endsWith(':primary')) throw new runtime.NativeCommitConflictError(); return actualCommit(request); };
  await assert.rejects(executeImport(s.db, s.plan, runtime, { apply: true, saveCheckpoint: s.saveCheckpoint }));
  assert.equal(s.client.commits, 0); assert.equal(s.client.head.records.size, 0); assert.equal(s.checkpoint().cutoverReady, false);
  const second = await setup(12), ordinaryRead = second.client.readHead.bind(second.client), commit = second.client.commit.bind(second.client);
  let reads = 0;
  second.client.readHead = async () => {
    if (++reads === 2) await commit({ operationId: 'foreign-readiness-write', expected: await ordinaryRead(), changes: [] });
    return ordinaryRead();
  };
  await assert.rejects(executeImport(second.db, second.plan, runtime, { apply: true, saveCheckpoint: second.saveCheckpoint }), /destination-changed-during-verification/);
  assert.equal(second.checkpoint().cutoverReady, false);
  assert.equal(second.checkpoint().stage, 'primary-committed');
});

test('complete idempotent verification also refuses concurrent destination head drift', async () => {
  const s = await setup(12);
  await executeImport(s.db, s.plan, runtime, { apply: true, saveCheckpoint: s.saveCheckpoint });
  const ordinaryRead = s.client.readHead.bind(s.client), commit = s.client.commit.bind(s.client); let reads = 0;
  s.client.readHead = async () => {
    if (++reads === 2) await commit({ operationId: 'foreign-readiness-write', expected: await ordinaryRead(), changes: [] });
    return ordinaryRead();
  };
  await assert.rejects(executeImport(s.db, s.plan, runtime, { apply: true, checkpoint: s.checkpoint(), saveCheckpoint: s.saveCheckpoint }), /destination-changed-during-verification/);
  assert.equal(s.checkpoint().cutoverReady, false);
});

test('restored data is readable through actual native tenant store after a fresh database readiness cycle', async () => {
  const s = await setup(12);
  await executeImport(s.db, s.plan, runtime, { apply: true, saveCheckpoint: s.saveCheckpoint });
  const freshDatabase = database(s.client);
  for (const tenant of s.source.tenants) {
    const store = freshDatabase.forTenant(tenant);
    const originals = s.source.records.filter(row => row.tenant === tenant).map(row => row.original);
    const read = await store.listAll();
    assert.deepEqual(read.sort((a, b) => a.id.localeCompare(b.id)), originals.sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(await store.count(), originals.length);
    const page = await store.query({ ascending: true, limit: 500 });
    assert.equal(page.statements.length, originals.filter(row => !row.voided).length);
    for (const original of originals) assert.deepEqual(await store.get(original.id), original);
  }
  const firstDoc = s.source.docs[0];
  assert.deepEqual(await freshDatabase.forTenant(firstDoc.tenant).getResource(firstDoc.kind, firstDoc.id), firstDoc.value);
  const attachment = s.source.attachments[0];
  assert.deepEqual(await freshDatabase.forTenant(attachment.tenant).getAttachment(attachment.id), attachment.value);
});

test('operator CLI rejects ambiguous arguments and any output path that would replace its archive/runtime/source', () => {
  assert.throws(() => parseArguments(['--archive', '--apply']), /missing-cli-argument-value/);
  assert.throws(() => parseArguments(['--apply', '--apply']), /unknown-or-duplicate-cli-argument/);
  assert.throws(() => validateArtifactPaths('/private/archive.summary.json', '/private/archive', '/private/runtime.mjs', '/private/import.mjs'), /maintenance-artifact-path-collision/);
  assert.throws(() => validateArtifactPaths('/private/archive.json', '/private/runtime.mjs', '/private/runtime.mjs', '/private/import.mjs'), /maintenance-artifact-path-collision/);
});
