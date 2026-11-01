import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { reconcileAtlasRecord } from '../atlas-reconciliation.mjs';

const at = '2026-11-01T21:48:22.075Z';
const origin = 'duke-fhir-v1';
function base() {
  return { meta: { updated: '2026-10-31', lastMedicationUpdate: '2026-10-30', latestStatus: 'Dated curated narrative', publication: { publishedAt: at, sourceSyncAt: null } }, sources: [{ id: 'curated-source', type: 'report-confirmed' }, { id: 'duke-source-test', type: 'provider-structured', projectionOrigin: origin }], labs: [], molecular: [], treatments: [], allergies: [], diagnostics: [], documents: [], conditions: [], timeline: [], faq: [{ q: 'What is known?', a: 'Older curated answer.' }] };
}
function lab(id, value, extras = {}) {
  return { id, name: 'Hemoglobin', code: { system: 'LOINC', code: '718-7' }, unit: 'g/dL', projectionOrigin: origin, evidence: 'provider-structured', sourceIds: ['duke-source-test'], clinicalDate: '2026-10-20T08:00:00Z', dateMeaning: 'observation-effective', values: [{ date: '2026-10-20T08:00:00Z', value, dateMeaning: 'observation-effective' }], ...extras };
}
const notice = (result, code) => result.notices.find(item => item.code === code);

test('historical structured coverage prompts comparison even without newer clinical dates', () => {
  const record = base();
  record.allergies.push({ id: 'duke-allergy-one', name: 'Adhesive', projectionOrigin: origin, sourceIds: ['duke-source-test'], dateMeaning: 'allergy-onset', clinicalDate: '2026-02-02' });
  const before = structuredClone(record);
  const result = reconcileAtlasRecord(record);
  assert.equal(result.status, 'review-needed');
  assert.ok(notice(result, 'new-source-coverage-needs-review'));
  assert.equal(notice(result, 'curated-summary-date-needs-review'), undefined);
  assert.equal(result.counts.structuredAllergies, 1);
  assert.equal(result.curatedAsOf, '2026-10-31');
  assert.equal(result.latestStructuredClinicalDate, '2026-02-02');
  assert.deepEqual(record, before);
});

test('sync completion remains unknown when only retrieval timestamps exist', () => {
  const record = base();
  record.labs.push(lab('lab-one', 10.1, { retrievedAt: '2026-11-02T12:00:00Z' }));
  const result = reconcileAtlasRecord(record);
  assert.equal(result.sourceSyncAt, null);
  assert.ok(notice(result, 'source-sync-not-established'));
  assert.equal(result.coverage.find(item => item.id === 'source-sync').status, 'not-established');
  const synced = reconcileAtlasRecord(record, { sourceSyncAt: '2026-11-01T20:00:00Z' });
  assert.equal(notice(synced, 'source-sync-not-established'), undefined);
  assert.equal(synced.sourceSyncAt, '2026-11-01T20:00:00Z');
  assert.equal(reconcileAtlasRecord(record, { sourceSyncAt: null }).sourceSyncAt, null);
});

test('indexing, retrieval and issue dates are not interpreted as examination dates', () => {
  const record = base();
  record.documents.push({ id: 'document-index', projectionOrigin: origin, date: '2026-11-02T12:00:00Z', clinicalDate: null, dateMeaning: 'document-indexed', sourceIds: ['duke-source-test'] });
  record.labs.push(lab('lab-old', 10.1));
  const result = reconcileAtlasRecord(record);
  assert.equal(result.latestStructuredClinicalDate, '2026-10-20T08:00:00Z');
  assert.equal(notice(result, 'curated-summary-date-needs-review'), undefined);
  assert.ok(notice(result, 'report-bodies-needed'));
  const issued = lab('issued-only', 5, { dateMeaning: 'observation-issued', values: [{ date: '2026-10-20T08:00:00Z', value: 5, dateMeaning: 'observation-issued' }] });
  record.labs.push(issued);
  assert.equal(reconcileAtlasRecord(record).measurementGroups.length, 0);
});

test('newer dated source entries trigger review while same-day precision does not invent ordering', () => {
  const record = base();
  record.conditions.push({ id: 'condition-same-day', projectionOrigin: origin, clinicalDate: '2026-10-31T15:00:00Z', dateMeaning: 'condition-recorded', sourceIds: ['duke-source-test'] });
  assert.equal(notice(reconcileAtlasRecord(record), 'curated-summary-date-needs-review'), undefined);
  record.conditions.push({ id: 'condition-new-date', projectionOrigin: origin, clinicalDate: '2026-11-01', dateMeaning: 'condition-recorded', sourceIds: ['duke-source-test'] });
  assert.ok(notice(reconcileAtlasRecord(record), 'curated-summary-date-needs-review'));
  assert.equal(reconcileAtlasRecord(record).latestStructuredClinicalDate, '2026-11-01');
});

test('groups duplicate and differing values without selecting a winner or losing original rows', () => {
  const record = base();
  record.labs.push(lab('lab-one', 10.1), lab('lab-two', 10.1));
  const before = structuredClone(record);
  const duplicate = reconcileAtlasRecord(record);
  assert.equal(duplicate.counts.duplicateMeasurementGroups, 1);
  assert.equal(duplicate.measurementGroups[0].kind, 'duplicate-measurement');
  assert.equal(duplicate.measurementGroups[0].memberCount, 2);
  assert.deepEqual(duplicate.measurementGroups[0].entryIds, ['lab-one', 'lab-two']);
  assert.deepEqual(record, before);
  record.labs.push(lab('lab-three', 9.8));
  const different = reconcileAtlasRecord(record);
  assert.equal(different.counts.multipleValueGroups, 1);
  assert.equal(different.measurementGroups[0].kind, 'multiple-reported-values');
  assert.deepEqual(different.measurementGroups[0].values, [{ value: 9.8, comparator: '', count: 1 }, { value: 10.1, comparator: '', count: 2 }]);
  assert.match(notice(different, 'multiple-reported-measurement-values').detail, /different samples/);
  assert.equal('preferredValue' in different.measurementGroups[0], false);
});

test('requires exact recognized coding, effective date, unit and comparator semantics', () => {
  const record = base();
  record.labs.push(lab('lab-first', 10.1), lab('lab-different-unit', 10.1, { unit: 'g/L' }), lab('lab-unknown-system', 10.1, { code: { code: '718-7' } }), lab('lab-date-only', 10.1, { values: [{ date: '2026-10-20', value: 10.1 }] }), lab('lab-uncoded-curated', 10.1, { code: undefined, projectionOrigin: undefined, evidence: 'report-confirmed' }));
  assert.equal(reconcileAtlasRecord(record).measurementGroups.length, 0);
  record.labs.push(lab('lab-same-instant', 10.1, { values: [{ date: '2026-10-20T03:00:00-05:00', value: 10.1 }] }));
  assert.equal(reconcileAtlasRecord(record).measurementGroups[0].memberCount, 2);
  record.labs.push(lab('lab-comparator', 10.1, { values: [{ date: '2026-10-20T08:00:00Z', value: 10.1, comparator: '<' }] }));
  assert.equal(reconcileAtlasRecord(record).measurementGroups[0].distinctValueCount, 2);
});

test('medication orders do not overwrite dated current-use history', () => {
  const record = base();
  record.treatments.push({ id: 'curated-regimen', name: 'Historical regimen', status: 'Current per family update' }, { id: 'duke-order-one', name: 'Coded drug', kind: 'Medication order', dateMeaning: 'order-authored', date: '2026-11-01', clinicalDate: '2026-11-01', status: 'Order status: active', projectionOrigin: origin, sourceIds: ['duke-source-test'] });
  const result = reconcileAtlasRecord(record);
  assert.equal(result.counts.medicationOrders, 1);
  assert.equal(result.counts.ordersAfterMedicationHistory, 1);
  assert.ok(notice(result, 'medication-use-not-reconciled'));
  assert.ok(notice(result, 'medication-history-date-needs-review'));
  assert.equal(record.treatments[0].status, 'Current per family update');
  assert.equal(result.coverage.find(item => item.id === 'medication-use').status, 'not-clinically-reconciled');
});

test('retains cited HLA coverage and treats missing results as unknown rather than negative', () => {
  const record = base();
  record.molecular.push({ id: 'curated-hla', name: 'HLA class I', value: 'Previously reported alleles', sourceIds: ['curated-source'] });
  const result = reconcileAtlasRecord(record);
  assert.equal(result.coverage.find(item => item.id === 'hla').status, 'cited-entries-present');
  assert.deepEqual(result.coverage.find(item => item.id === 'hla').sourceIds, ['curated-source']);
  record.molecular = [];
  const absent = reconcileAtlasRecord(record);
  assert.equal(absent.coverage.find(item => item.id === 'hla').status, 'unknown');
  assert.match(absent.coverage.find(item => item.id === 'hla').detail, /does not mean negative/);
  assert.equal(JSON.stringify(absent).includes('A*'), false);
});

test('uses a stable existing check timestamp and is a separate method-labelled derived block', () => {
  const record = base();
  const first = reconcileAtlasRecord(record), second = reconcileAtlasRecord(record);
  assert.deepEqual(first, second);
  assert.equal(first.checkedAt, at);
  assert.equal(first.method, 'deterministic-public-fact-checks');
  assert.equal(first.scope, 'derived-from-public-record');
  assert.equal(reconcileAtlasRecord({ meta: {} }).checkedAt, null);
  const empty = reconcileAtlasRecord({ meta: {} });
  assert.equal(empty.status, 'checks-complete');
  assert.match(empty.summary.limits[0], /not a clinical review/);
});

test('large cohorts remain linear to inspect and bounded to display', { timeout: 10_000 }, () => {
  const record = base();
  for (let group = 0; group < 150; group++) for (let repeat = 0; repeat < 40; repeat++) record.labs.push(lab(`lab-g${group}-r${repeat}`, 10.1, { code: { system: 'LOINC', code: `test-${group}` } }));
  const beforeLength = record.labs.length, started = performance.now();
  const result = reconcileAtlasRecord(record);
  assert.equal(result.counts.duplicateMeasurementGroups, 150);
  assert.equal(result.measurementGroups.length, 100);
  assert.equal(result.counts.omittedMeasurementGroups, 50);
  assert.ok(result.measurementGroups.every(group => group.entryIds.length <= 20 && group.memberCount === 40 && group.omittedEntryIds === 20));
  assert.ok(result.notices.length <= 20);
  assert.equal(record.labs.length, beforeLength);
  assert.ok(performance.now() - started < 5000);
});
