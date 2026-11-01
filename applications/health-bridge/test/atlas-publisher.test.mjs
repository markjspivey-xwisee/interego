import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAtlasPublisher, AtlasError } from '../atlas-publisher.mjs';
import { createEncryptedStore } from '../security.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const ownerPrincipal = 'did:web:identity.example:users:duke-browser-owner';
const adminPrincipal = 'did:web:identity.example:users:old-mark-mcp';
const patientId = 'PRIVATE-DUKE-PATIENT-1';
const START = Date.parse('2026-11-01T14:00:00Z');
const STATE = 'atlas:mayya:publication-state:v1';
const samplePatient = { resourceType: 'Patient', id: patientId, name: [{ use: 'official', given: ['Mayya', 'M'], family: 'Grinberg' }], birthDate: '1986-04-02', identifier: [{ value: 'PRIVATE-MRN-123456' }], telecom: [{ value: 'person@example.test' }] };
const observation = (id = 'PRIVATE-OBS-1', value = 12) => ({ resourceType: 'Observation', id, subject: { reference: `Patient/${patientId}` }, status: 'final', effectiveDateTime: '2026-10-31T08:00:00Z', code: { coding: [{ system: 'http://loinc.org', code: '718-7', display: 'Hemoglobin' }] }, valueQuantity: { value, unit: 'g/dL', system: 'http://unitsofmeasure.org', code: 'g/dL' }, text: { div: '<div>PRIVATE-NOTE-SECRET bearer credential-xyz</div>' } });

async function fixture(t) {
  let time = START;
  const directory = await mkdtemp(join(tmpdir(), 'atlas-publisher-'));
  const store = createEncryptedStore({ directory, keyHex: 'ab'.repeat(32) });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rawRecords = new Map(), owners = new Map();
  const owner = { principal: ownerPrincipal, userId: 'browser-owner', consent: { enabled: true }, sources: { duke: { connected: true, patientId, lastAttempt: '2026-11-01T13:00:00Z', lastSync: '2026-11-01T13:00:00Z', token: { access_token: 'PRIVATE-ACCESS-CREDENTIAL', refresh_token: 'PRIVATE-REFRESH-CREDENTIAL' } } }, records: [] };
  owners.set(ownerPrincipal, owner);
  const counts = { owner: 0, record: 0 };
  let onRecord;
  const insert = (raw, source = 'duke', principal = ownerPrincipal) => {
    const id = `${source}:${raw.resourceType}:${raw.id}`;
    rawRecords.set(principal + ':' + id, { id, source, resourceType: raw.resourceType, retrievedAt: '2026-11-01T13:00:00Z', raw: copy(raw) });
    const account = owners.get(principal);
    const indexed = { id, source, resourceType: raw.resourceType, digest: hash(raw), clinicalDate: raw.effectiveDateTime ?? null };
    const prior = account.records.findIndex(item => item.id === id);
    if (prior === -1) account.records.push(indexed); else account.records[prior] = indexed;
    return id;
  };
  insert(samplePatient); insert(observation());
  const config = { store, now: () => time, adminPrincipal, publicBase: 'https://health.example', atlasUrl: 'https://atlas.example/', expectedSubject: { name: 'Mayya Grinberg', birthDate: '1986-04-02' }, baseRecord: { meta: { subject: 'Mayya Grinberg', scope: 'Curated family history and separately labeled structured provider records.' }, timeline: [{ id: 'curated-1', title: 'Previously shared history', sourceIds: ['curated-source'] }], sources: [{ id: 'curated-source', title: 'Family update' }] }, loadOwner: async actor => { counts.owner++; return copy(owners.get(actor.principal) ?? { principal: actor.principal, consent: { enabled: false }, sources: {}, records: [] }); }, loadRecord: async (actor, id) => { counts.record++; const result = copy(rawRecords.get(actor.principal + ':' + id)); if (onRecord) await onRecord(actor, id); return result; } };
  const actor = () => ({ principal: ownerPrincipal, transport: 'browser', authenticatedAt: time });
  const publisher = createAtlasPublisher(config);
  const link = async () => {
    const grant = await publisher.createLink({ principal: adminPrincipal });
    return { grant, token: new URL(grant.url).hash.slice('#atlas-link='.length) };
  };
  const claim = async () => { const { token } = await link(); return publisher.claim(actor(), { token }); };
  const publish = async (autoPublish = false) => { const draft = await publisher.preview(actor()); const receipt = await publisher.publish(actor(), { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision, autoPublish }); return { draft, receipt }; };
  return { directory, store, config, publisher, owner, owners, rawRecords, counts, insert, actor, link, claim, publish, setOnRecord: callback => { onRecord = callback; }, advance: milliseconds => { time += milliseconds; } };
}
const rejects = (promise, code, status) => assert.rejects(promise, error => error instanceof AtlasError && error.code === code && (!status || error.status === status));

test('only an administrator can issue a hash-only one-time grant; browser and chart matching are required', async t => {
  const f = await fixture(t);
  await rejects(f.publisher.claim(f.actor(), { token: 'x'.repeat(43) }), 'atlas_link_invalid');
  await rejects(f.publisher.createLink(f.actor()), 'atlas_admin_required', 403);
  const { grant, token } = await f.link();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(Date.parse(grant.expiresAt) - START, 30 * 60_000);
  const saved = await f.store.get(STATE);
  assert.equal(JSON.stringify(saved).includes(token), false);
  assert.equal(saved.grant.tokenHash.length, 64);
  await rejects(f.publisher.claim({ principal: ownerPrincipal }, { token }), 'atlas_browser_required');
  const stale = { ...f.actor(), authenticatedAt: START - 3600001 };
  await rejects(f.publisher.claim(stale, { token }), 'atlas_browser_required');
  f.insert({ ...samplePatient, birthDate: '1980-01-01' });
  await rejects(f.publisher.claim(f.actor(), { token }), 'atlas_subject_mismatch');
  f.insert(samplePatient);
  assert.equal((await f.publisher.claim(f.actor(), { token })).linked, true);
  await rejects(f.publisher.claim(f.actor(), { token }), 'atlas_already_linked');
  await rejects(f.publisher.createLink({ principal: adminPrincipal }), 'atlas_already_linked');
  for (const name of await readdir(f.directory)) {
    const encrypted = await readFile(join(f.directory, name), 'utf8');
    assert.equal(JSON.parse(encrypted).alg, 'A256GCM'); assert.equal(encrypted.includes(token), false); assert.equal(encrypted.includes(ownerPrincipal), false);
  }
});

test('expired grants and changed or missing selected Patient imports cannot claim the fixed Atlas', async t => {
  const f = await fixture(t), { token } = await f.link();
  f.advance(1800001);
  await rejects(f.publisher.claim(f.actor(), { token }), 'atlas_link_invalid');
  const second = await f.link();
  f.owner.sources.duke.patientId = 'OTHER-PATIENT';
  await rejects(f.publisher.claim(f.actor(), { token: second.token }), 'atlas_patient_import_required');
  f.insert({ ...samplePatient, id: 'OTHER-PATIENT', name: [{ given: ['Someone'], family: 'Else' }] });
  await rejects(f.publisher.claim(f.actor(), { token: second.token }), 'atlas_subject_mismatch');
});

test('MCP administrator cannot publish a linked browser owner, and status never leaks the bound identity', async t => {
  const f = await fixture(t); await f.claim();
  const admin = { principal: adminPrincipal };
  const status = await f.publisher.status(admin);
  assert.equal(status.linked, true); assert.equal(status.ownerAllowed, false); assert.equal(status.recordCount, 0); assert.equal(status.sourceSyncAt, null);
  assert.equal(JSON.stringify(status).includes(ownerPrincipal), false); assert.equal(JSON.stringify(status).includes(patientId), false);
  await rejects(f.publisher.preview({ ...f.actor(), principal: adminPrincipal }), 'atlas_owner_forbidden');
  await rejects(f.publisher.publish(admin, {}), 'atlas_browser_required');
  await rejects(f.publisher.autoPublish(admin), 'atlas_owner_forbidden');
});

test('preview excludes mixed-chart cache and notes, then publishes exactly the reviewed projection', async t => {
  const f = await fixture(t); await f.claim();
  f.insert({ ...observation('PRIVATE-FOREIGN-OBS', 99), subject: { reference: 'Patient/OTHER-CHART' } });
  f.insert({ ...samplePatient, id: 'OTHER-CHART', name: [{ given: ['Other'], family: 'Person' }] });
  f.insert({ resourceType: 'DocumentAttachment', id: 'PRIVATE-NOTE-ID', subject: { reference: `Patient/${patientId}` }, text: 'UNAPPROVED-FREE-TEXT' });
  const draft = await f.publisher.preview(f.actor());
  assert.deepEqual(draft.subject, { name: 'Mayya Grinberg', birthDate: '1986-04-02' });
  assert.equal(draft.stats.exclusionCounts['patient-binding-failed'], 2);
  assert.ok(draft.exclusions.some(item => item.reason === 'private-document-body'));
  assert.equal(draft.projection.labs[0].values[0].value, 12);
  const reviewBytes = JSON.stringify(draft.projection);
  assert.doesNotMatch(reviewBytes, /PRIVATE-|1986-04-02|UNAPPROVED|credential-xyz|ownerPrincipal|OTHER-CHART/);
  draft.projection.meta.subject = 'CLIENT-FORGED-RECORD';
  const receipt = await f.publisher.publish(f.actor(), { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision, autoPublish: false });
  const publicResult = await f.publisher.getPublic('json');
  assert.equal(publicResult.body, reviewBytes); assert.equal(receipt.revision, 1);
  assert.equal(JSON.parse(publicResult.body).meta.publication.publicRecordUrl, 'https://health.example/public/atlas/mayya/record.json');
  assert.equal(JSON.parse(publicResult.body).meta.publication.preparedAt, new Date(START).toISOString());
  assert.equal(JSON.parse(publicResult.body).meta.publication.managementUrl, 'https://health.example');
});

test('forged, expired, stale-source and stale-revision previews are refused', async t => {
  const f = await fixture(t); await f.claim();
  let draft = await f.publisher.preview(f.actor());
  const params = () => ({ draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision });
  await rejects(f.publisher.publish(f.actor(), { ...params(), digest: '0'.repeat(64) }), 'atlas_draft_invalid');
  await rejects(f.publisher.publish(f.actor(), { ...params(), draftId: 'x'.repeat(32) }), 'atlas_draft_invalid');
  f.owner.sources.duke.lastAttempt = '2026-11-01T14:01:00Z';
  await rejects(f.publisher.publish(f.actor(), params()), 'atlas_source_changed');
  draft = await f.publisher.preview(f.actor()); f.advance(1800001);
  await rejects(f.publisher.publish(f.actor(), params()), 'atlas_draft_expired');
  const older = await f.publisher.preview(f.actor()); await f.publish();
  await rejects(f.publisher.publish(f.actor(), { draftId: older.draftId, digest: older.digest, baseRevision: older.baseRevision }), 'atlas_revision_conflict');
});

test('source mutation during preparation or immediately before commit is detected', async t => {
  const f = await fixture(t); await f.claim();
  let changed = false;
  f.setOnRecord(() => { if (!changed) { changed = true; f.owner.sources.duke.lastAttempt = '2026-11-01T14:01:00Z'; } });
  await rejects(f.publisher.preview(f.actor()), 'atlas_source_changed');
  f.setOnRecord(null);
  const draft = await f.publisher.preview(f.actor());
  f.owner.sources.duke.patientId = 'DIFFERENT-CHART';
  await rejects(f.publisher.publish(f.actor(), { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision }), 'atlas_chart_changed');
  await rejects(f.publisher.preview(f.actor()), 'atlas_chart_changed');
});

test('concurrent retries install one version, while competing drafts use revision CAS', async t => {
  const f = await fixture(t); await f.claim();
  const first = await f.publisher.preview(f.actor()), other = await f.publisher.preview(f.actor());
  const input = { draftId: first.draftId, digest: first.digest, baseRevision: first.baseRevision, autoPublish: true };
  const copies = await Promise.all([f.publisher.publish(f.actor(), input), f.publisher.publish(f.actor(), input)]);
  assert.deepEqual(copies.map(item => item.revision), [1, 1]); assert.equal(copies.filter(item => item.duplicate).length, 1);
  await rejects(f.publisher.publish(f.actor(), { ...input, autoPublish: false }), 'atlas_receipt_conflict');
  await rejects(f.publisher.publish(f.actor(), { draftId: other.draftId, digest: other.digest, baseRevision: other.baseRevision }), 'atlas_revision_conflict');
  assert.equal((await f.publisher.status(f.actor())).revision, 1);
});

test('approved public copies and retry receipts survive new publisher/store instances; every format has the same revision', async t => {
  const f = await fixture(t); await f.claim(); const { draft, receipt } = await f.publish();
  const freshStore = createEncryptedStore({ directory: f.directory, keyHex: 'ab'.repeat(32) });
  const fresh = createAtlasPublisher({ ...f.config, store: freshStore, loadOwner: async () => { throw new Error('Public must not read private owners'); }, loadRecord: async () => { throw new Error('Public must not read private source records'); } });
  const expected = (await f.publisher.getPublic()).body;
  for (const format of ['json', 'md', 'jsonld', 'ttl']) {
    const result = await fresh.getPublic(format); assert.equal(result.revision, receipt.revision); assert.equal(typeof result.body, 'string');
    if (format === 'json') assert.equal(result.body, expected);
    if (format === 'jsonld') assert.equal(JSON.parse(result.body)['schema:encoding']['schema:text'], expected);
    if (format === 'ttl') assert.ok(result.body.includes(JSON.stringify(expected) + '^^rdf:JSON'));
    if (format === 'md') { assert.match(result.body, /Publication revision: 1/); assert.match(result.body, /Curated family history/); }
  }
  const restarted = createAtlasPublisher({ ...f.config, store: freshStore });
  const duplicate = await restarted.publish(f.actor(), { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.revision, 1);
});

test('automatic publication requires explicit opt-in and never includes unapproved note text', async t => {
  const f = await fixture(t);
  await rejects(f.publisher.getPublic(), 'atlas_not_published', 404);
  await f.claim();
  assert.equal((await f.publisher.autoPublish({ principal: ownerPrincipal })).updated, false);
  await rejects(f.publisher.setAutomatic(f.actor(), { enabled: true }), 'atlas_initial_publication_required');
  const initial = await f.publish(false); f.insert(observation('PRIVATE-OBS-2', 13));
  assert.equal((await f.publisher.autoPublish({ principal: ownerPrincipal })).updated, false);
  assert.equal((await f.publisher.getPublic()).revision, 1);
  await f.publisher.setAutomatic(f.actor(), { enabled: true });
  const auto = await f.publisher.autoPublish({ principal: ownerPrincipal });
  assert.equal(auto.updated, true); assert.equal(auto.revision, 2);
  const retry = await f.publisher.publish(f.actor(), { draftId: initial.draft.draftId, digest: initial.draft.digest, baseRevision: initial.draft.baseRevision });
  assert.equal(retry.duplicate, true); assert.equal(retry.revision, 1); assert.equal((await f.publisher.getPublic()).revision, 2);
  f.insert({ resourceType: 'DocumentAttachment', id: 'PRIVATE-AUTONOTE', subject: { reference: `Patient/${patientId}` }, text: 'UNAPPROVED-NEW-NOTE-FREE-TEXT' });
  const ignored = await f.publisher.autoPublish({ principal: ownerPrincipal });
  assert.equal(ignored.updated, false); assert.equal(ignored.reason, 'atlas_public_content_unchanged'); assert.equal(ignored.revision, 2);
  assert.doesNotMatch((await f.publisher.getPublic()).body, /UNAPPROVED-NEW-NOTE/);
  f.owner.sources.duke.connected = false;
  assert.equal((await f.publisher.setAutomatic(f.actor(), { enabled: false })).autoPublish, false);
  assert.equal((await f.publisher.autoPublish({ principal: ownerPrincipal })).updated, false);
});


test('preview counts private document-body exclusions without reading or decrypting body records', async t => {
  const f = await fixture(t); await f.claim();
  const binaryId = f.insert({ resourceType: 'Binary', id: 'PRIVATE-BINARY-ID', contentType: 'application/pdf', data: 'PRIVATE-ENCRYPTED-BODY' });
  const documentId = f.insert({ resourceType: 'DocumentAttachment', id: 'PRIVATE-ATTACHMENT-ID', data: 'PRIVATE-ATTACHMENT-BODY' });
  const bodyIds = new Set([binaryId, documentId]);
  let bodyReads = 0;
  const publisher = createAtlasPublisher({ ...f.config, loadRecord: async (actor, id) => {
    if (bodyIds.has(id)) { bodyReads++; throw new Error('Body records must never be read for publication.'); }
    return f.config.loadRecord(actor, id);
  } });
  const draft = await publisher.preview(f.actor());
  assert.equal(bodyReads, 0);
  assert.equal(draft.stats.exclusionCounts['private-document-body'], 2);
  assert.equal(draft.stats.receivedByResourceType.Binary, 1);
  assert.equal(draft.stats.receivedByResourceType.DocumentAttachment, 1);
  assert.equal(draft.projection.labs[0].values[0].value, 12);
  assert.doesNotMatch(JSON.stringify(draft.projection), /PRIVATE-BINARY|PRIVATE-ATTACHMENT|PRIVATE-ENCRYPTED-BODY/);
  await publisher.publish(f.actor(), { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision });
  assert.equal(bodyReads, 0);
  assert.equal((await publisher.getPublic()).revision, 1);
});


test('commit and unchanged automatic checks read only Patient while pinning every source-index digest', async t => {
  const f = await fixture(t); await f.claim();
  const draft = await f.publisher.preview(f.actor());
  let patientReads = 0, clinicalReads = 0;
  const publisher = createAtlasPublisher({ ...f.config, loadRecord: async (actor, id) => {
    if (!id.startsWith('duke:Patient:')) { clinicalReads++; throw new Error('Commit must use the reviewed projection, not clinical reloads.'); }
    patientReads++; return f.config.loadRecord(actor, id);
  } });
  await publisher.publish(f.actor(), { draftId: draft.draftId, digest: draft.digest, baseRevision: draft.baseRevision, autoPublish: true });
  assert.equal(clinicalReads, 0); assert.equal(patientReads, 1);
  assert.equal((await publisher.autoPublish({ principal: ownerPrincipal })).reason, 'atlas_source_unchanged');
  assert.equal(clinicalReads, 0); assert.equal(patientReads, 2);
  const before = await publisher.getPublic();
  // A drift in a non-Patient digest still invalidates review, even though the
  // private clinical resource is deliberately not reloaded on commit.
  const freshDraft = await f.publisher.preview(f.actor());
  f.setOnRecord(() => { f.owner.records.find(item => item.resourceType === 'Observation').digest = '1'.repeat(64); });
  await rejects(publisher.publish(f.actor(), { draftId: freshDraft.draftId, digest: freshDraft.digest, baseRevision: freshDraft.baseRevision }), 'atlas_source_changed');
  assert.equal(clinicalReads, 0); assert.equal((await publisher.getPublic()).body, before.body);
});
