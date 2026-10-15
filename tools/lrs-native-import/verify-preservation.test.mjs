import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateSnapshot, buildNativePlan } from './import.mjs';
import { verifyPreservation, createArtifactReadMemoizer } from './verify-preservation.mjs';
import * as runtime from './runtime.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const time = '2026-10-15T19:40:00.000Z';
const scope = { pod: 'https://native.test/tenant/', owner: 'did:web:tenant.test',
  headUrl: 'https://native.test/tenant/native/head', artifactContainer: 'https://native.test/tenant/native/artifacts/' };
function encode(value) {
  if (value === null) return { t: 'null' };
  if (Buffer.isBuffer(value)) return { t: 'Buffer', n: value.length, v: value.toString('base64') };
  if (['string', 'boolean', 'number'].includes(typeof value)) return { t: typeof value, v: value };
  if (Array.isArray(value)) return { t: 'array', v: value.map(encode) };
  return { t: 'object', v: Object.entries(value).map(([key, child]) => [key, encode(child)]) };
}
function fixture() {
  const id = '00000000-0000-4000-8000-000000000001';
  const original = { id, statement: { id, actor: { account: { homePage: 'https://subject.test', name: 'fixture' } },
    verb: { id: 'https://verbs.test/observed' }, object: { id: 'https://tasks.test/1' },
    stored: time, timestamp: time, authority: { account: { homePage: 'https://old-lrs.test', name: 'original' } } },
    stored: time, voided: false };
  const document = { content: Buffer.from([0, 255, 1]), contentType: 'application/octet-stream', etag: '"original"', updated: time };
  const snapshot = { schema: 'interego-live-lrs-map-snapshot-v1',
    statements: [{ tenant: 'default', storageField: 'store', records: [[id, encode(original)]] }],
    state: [['default', [['original opaque key', encode(document)]]]], activityProfile: [], agentProfile: [], attachments: [] };
  const input = { snapshot, ...validateSnapshot(snapshot), sourceDigest: sha('plaintext'), archiveDigest: sha('ciphertext'),
    provenanceTime: time, targetSourceSha256: 'a'.repeat(64) };
  const artifacts = new Map();
  let commits = 0, readinessWrites = 0;
  const client = {
    ready: async () => {}, readHead: async () => ({ ...client.current, records: new Map(client.current.records) }),
    readSnapshotAt: async () => ({ ...client.historical, records: new Map(client.historical.records) }),
    readArtifact: async reference => { const value = artifacts.get(reference.resourceUrl); if (!value) throw new Error('missing artifact'); return value; },
    commit: async () => { commits++; throw new Error('verification attempted a commit'); },
  };
  const database = new runtime.NativeInteregoLrsDatabase({ client, owner: scope.owner,
    scopeIdentity: JSON.stringify(scope), cursorSecret: 'c'.repeat(32), verifyReadiness: async () => { readinessWrites++; } });
  const plan = buildNativePlan(database, input, runtime);
  const putArtifact = artifact => {
    const uri = 'https://native.test/tenant/artifact/' + artifacts.size;
    const reference = { resourceUrl: uri, topUri: artifact.topUri };
    artifacts.set(uri, { topUri: artifact.topUri, nodes: new Map(artifact.pgsl.nodes) }); return reference;
  };
  const records = new Map([...plan.primary, ...plan.queries].map(change => [change.key, putArtifact(change.artifact)]));
  const reference = { revision: 'sha256:' + sha('imported-head'), commitUrl: 'https://native.test/tenant/commit/1', topUri: 'urn:test:head' };
  client.historical = { scope, records: new Map(records), reference, revision: reference.revision, operationId: 'queries' };
  client.current = { ...client.historical, records: new Map(records) };
  const binding = sha(JSON.stringify({ ...plan.bindings, scope }));
  const checkpoint = { schema: 'interego-native-lrs-import-checkpoint-v1', binding, bindings: plan.bindings, scope,
    primaryOperation: 'foxxi-lrs-restore:' + binding + ':primary', queryOperation: 'foxxi-lrs-restore:' + binding + ':queries',
    stage: 'complete', cutoverReady: true, finalHead: reference };
  return { database, plan, checkpoint, client, putArtifact,
    untouched: () => { assert.equal(commits, 0); assert.equal(readinessWrites, 0); } };
}

test('fixed historical and current heads verify every original with no native write', async () => {
  const f = fixture();
  const report = await verifyPreservation(f.database, f.plan, runtime, f.checkpoint);
  assert.equal(report.checkpointHeadOriginalsExact, true); assert.equal(report.fixedCurrentHeadOriginalsExact, true);
  assert.equal(report.statements, 1); assert.equal(report.stateDocuments, 1); assert.equal(report.extraNativeRecords, 0);
  assert.equal(report.latestHeadUnchangedDuringVerification, true); f.untouched();
  assert.ok(report.artifactReadMemoization.cacheHits > 0);
});
test('additional background native record is counted separately without hiding original preservation', async () => {
  const f = fixture();
  const extra = f.database.artifact('default', 'state', 'new background key', { content: 'new', contentType: 'text/plain', etag: '"new"', updated: time });
  f.client.current.records.set(f.database.key('default', 'state', 'new background key'), f.putArtifact(extra));
  f.client.current.reference = { ...f.client.current.reference, revision: 'sha256:' + sha('new head') };
  const report = await verifyPreservation(f.database, f.plan, runtime, f.checkpoint);
  assert.equal(report.extraNativeRecords, 1); assert.equal(report.extraNativeRecordsByKind.state, 1);
  assert.equal(report.extrasClassifiedAsLegitimate, false); assert.equal(report.fixedCurrentHeadOriginalsExact, true); f.untouched();
});
test('missing current original fails even though the complete checkpoint head remains readable', async () => {
  const f = fixture(); f.client.current.records.delete(f.plan.primary[1].key);
  await assert.rejects(verifyPreservation(f.database, f.plan, runtime, f.checkpoint), /preservation-original-record-missing/); f.untouched();
});
test('changed current document fidelity fails even with matching current record count', async () => {
  const f = fixture(), doc = f.plan.source.docs[0];
  const replacement = f.database.artifact(doc.tenant, doc.kind, doc.id, { ...doc.value, content: Buffer.from([0, 255, 2]) });
  f.client.current.records.set(f.database.key(doc.tenant, doc.kind, doc.id), f.putArtifact(replacement));
  await assert.rejects(verifyPreservation(f.database, f.plan, runtime, f.checkpoint), /native-import-readback-mismatch/); f.untouched();
});
test('new void edge for an original is not concealed as an unrelated extra key', async () => {
  const f = fixture(), row = f.plan.source.records[0];
  const value = { target: row.id, voidingStatementId: '00000000-0000-4000-8000-000000000002' };
  f.client.current.records.set(f.database.key(row.tenant, 'void', row.id), f.putArtifact(f.database.artifact(row.tenant, 'void', row.id, value)));
  await assert.rejects(verifyPreservation(f.database, f.plan, runtime, f.checkpoint), /preservation-original-void-state-changed/); f.untouched();
});
test('changed checkpoint source or projection binding fails before a preservation claim', async () => {
  const f = fixture();
  const checkpoint = { ...f.checkpoint, bindings: { ...f.checkpoint.bindings, sourceProjection: { projectPolicy: 'changed' } } };
  await assert.rejects(verifyPreservation(f.database, f.plan, runtime, checkpoint), /preservation-checkpoint-binding-mismatch/); f.untouched();
});
test('artifact memoization deduplicates concurrent full-reference reads and isolates returned mutable data', async () => {
  let network = 0;
  const memo = createArtifactReadMemoizer(async () => {
    network++; return { topUri: 'urn:test:top', nodes: new Map([['urn:test:node', { level: 0, value: 'original' }]]) };
  }, scope);
  const reference = { resourceUrl: 'https://native.test/artifact/1', bodyDigest: 'sha256:first', topUri: 'urn:test:top' };
  const [first, concurrent] = await Promise.all([memo.readArtifact(reference), memo.readArtifact(reference)]);
  first.nodes.get('urn:test:node').value = 'consumer mutation'; first.nodes.set('urn:new', {});
  const again = await memo.readArtifact({ topUri: reference.topUri, bodyDigest: reference.bodyDigest, resourceUrl: reference.resourceUrl });
  assert.equal(network, 1); assert.equal(concurrent.nodes.get('urn:test:node').value, 'original');
  assert.equal(again.nodes.get('urn:test:node').value, 'original'); assert.equal(again.nodes.has('urn:new'), false);
  assert.equal(memo.statistics().inFlightDedupeHits, 1); assert.equal(memo.statistics().cacheHits, 2);
});
test('changed artifact digest or any full-reference field causes a new SDK fetch', async () => {
  let network = 0;
  const memo = createArtifactReadMemoizer(async () => ({ read: ++network }), scope);
  const reference = { resourceUrl: 'https://native.test/artifact/1', bodyDigest: 'sha256:first', topUri: 'urn:test:top', scope: 'one' };
  await memo.readArtifact(reference);
  await memo.readArtifact({ ...reference, bodyDigest: 'sha256:changed' });
  await memo.readArtifact({ ...reference, topUri: 'urn:test:other' });
  await memo.readArtifact({ ...reference, scope: 'two' });
  assert.equal(network, 4); assert.equal(memo.statistics().cacheHits, 0);
});
test('failed and missing artifact reads are never retained', async () => {
  let attempts = 0;
  const memo = createArtifactReadMemoizer(async () => {
    attempts++; if (attempts === 1) throw new Error('temporary SDK refusal');
    if (attempts === 2) return null; return { ok: true };
  }, scope);
  const reference = { resourceUrl: 'https://native.test/artifact/1', bodyDigest: 'sha256:first' };
  await assert.rejects(memo.readArtifact(reference), /temporary SDK refusal/);
  assert.equal(await memo.readArtifact(reference), null);
  assert.deepEqual(await memo.readArtifact(reference), { ok: true });
  assert.deepEqual(await memo.readArtifact(reference), { ok: true });
  assert.equal(attempts, 3); assert.equal(memo.statistics().networkReadCount, 3);
  assert.equal(memo.statistics().uniqueSuccessfulReferences, 1);
});
