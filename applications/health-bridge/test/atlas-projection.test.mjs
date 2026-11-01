import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtlasProjection } from '../atlas-projection.mjs';

const patientId = 'chart-A';
const publishedAt = '2026-11-01T12:00:00.000Z';
const retrievedAt = '2026-11-01T10:00:00.000Z';
const sourceSyncAt = '2026-11-01T09:59:00.000Z';
const code = (display, value = '718-7', system = 'http://loinc.org') => ({ coding: [{ system, code: value, display }] });
const baseRecord = () => ({
  meta: { title: 'Health Atlas', subject: 'Publicly chosen subject', version: '1.0.1', updated: '2026-10-31', limitations: ['Available-source compilation.'] },
  overview: [{ label: 'Diagnosis', value: 'Historical curated diagnosis' }],
  conditions: [{ id: 'curated-condition', name: 'Curated condition', sourceIds: ['curated-source'] }],
  treatments: [{ id: 'curated-drug', name: 'Curated treatment', dose: 'Historical family report', events: [], sourceIds: ['curated-source'] }],
  timeline: [{ id: 'curated-event', date: '2025-06-17', title: 'Curated historical event', sourceIds: ['curated-source'] }],
  molecular: [],
  labs: [{ id: 'curated-lab', name: 'Historical lab', unit: 'g/dL', reference: [10, 15], values: [{ date: '2026-01-01', value: 12 }], sourceIds: ['curated-source'] }],
  sources: [{ id: 'curated-source', title: 'Curated family history', type: 'family-reported' }],
  symptoms: [], faq: [], uncertainties: [{ title: 'Historical limits', detail: 'Some records unavailable.' }], careTeam: [], glossary: [],
});
const wrap = (resourceType, id, raw = {}, extras = {}) => ({
  id: `duke:${resourceType}:${id}`,
  source: 'duke', resourceType, clinicalDate: '2026-10-30', retrievedAt,
  raw: { resourceType, id, subject: { reference: `Patient/${patientId}` }, ...raw },
  ...extras,
});
const observation = (id = 'private-observation-1', extras = {}) => wrap('Observation', id, {
  status: 'final', code: code('Hemoglobin'), effectiveDateTime: '2026-10-30T08:00:00Z',
  valueQuantity: { value: 10.1, unit: 'g/dL', system: 'http://unitsofmeasure.org', code: 'g/dL' },
  referenceRange: [{ low: { value: 11.7, unit: 'g/dL' }, high: { value: 15.5, unit: 'g/dL' } }],
  ...extras,
});
const project = (records = [], overrides = {}) => buildAtlasProjection({ baseRecord: baseRecord(), records, patientId, publishedAt, revision: 2, sourceSyncAt, ...overrides });
const byName = (rows, name) => (rows ?? []).find(row => row.name === name);
const publicJson = result => JSON.stringify(result);
const sourceFor = (record, entry) => record.sources.find(source => source.id === entry.sourceIds[0]);
const projectionRows = record => ['conditions', 'treatments', 'timeline', 'molecular', 'labs', 'allergies', 'diagnostics', 'documents'].flatMap(section => record[section] ?? []).filter(row => !String(row.id).startsWith('curated-'));

test('publishes only the selected chart when a private cache contains mixed patients and providers', () => {
  const valid = observation();
  const foreign = observation('private-foreign-observation', { subject: { reference: 'Patient/chart-B' }, code: code('Foreign chart condition') });
  const unbound = observation('private-unbound-observation', { subject: undefined, code: code('Unbound condition') });
  const forgedWrapper = observation('private-forged-observation', { resourceType: 'Condition', code: code('Forged resource') });
  const untrustedAbsolute = observation('private-host-observation', { subject: { reference: `https://attacker.example/Patient/${patientId}` }, code: code('Untrusted-host condition') });
  const apple = { ...observation('private-apple-observation', { code: code('Apple-only finding') }), source: 'apple' };
  const result = project([valid, foreign, unbound, forgedWrapper, untrustedAbsolute, apple]);
  assert.equal(byName(result.record.labs, 'Hemoglobin').values[0].value, 10.1);
  for (const forbidden of ['Foreign chart condition', 'Unbound condition', 'Forged resource', 'Untrusted-host condition', 'Apple-only finding', 'chart-B']) assert.equal(publicJson(result).includes(forbidden), false);
  assert.ok(result.stats.excludedRecords >= 5);
  assert.ok(Array.isArray(result.exclusions) && result.exclusions.length);
  assert.ok(result.exclusions.every(entry => typeof entry.reason === 'string' && Number.isInteger(entry.count) && entry.count > 0 && !('id' in entry)));
});

test('patient demographics, raw notes, bodies, private references and document titles never become public content', () => {
  const patient = wrap('Patient', patientId, {
    subject: undefined, name: [{ family: 'PRIVATE-FAMILY-NAME', given: ['PRIVATE-GIVEN-NAME'] }], birthDate: '1980-04-02',
    identifier: [{ system: 'urn:mrn', value: 'PRIVATE-MRN-881199' }],
    address: [{ line: ['PRIVATE-HOME-ADDRESS'] }], telecom: [{ value: 'private-patient@example.com' }],
  });
  const lab = observation('private-source-id-sensitive', {
    text: { div: '<div>PRIVATE-NARRATIVE-TEXT</div>' }, note: [{ text: 'PRIVATE-NOTE-TEXT' }],
    performer: [{ reference: 'Practitioner/PRIVATE-PRACTITIONER-ID', display: 'PRIVATE-PROVIDER-NAME' }],
    identifier: [{ value: 'PRIVATE-LAB-IDENTIFIER' }],
  });
  const document = wrap('DocumentReference', 'private-document-id', {
    type: code('Progress note', '11506-3'), date: '2026-10-31T12:00:00Z', status: 'current',
    description: 'PRIVATE-DOCUMENT-DESCRIPTION', author: [{ display: 'PRIVATE-AUTHOR-NAME' }],
    content: [{ attachment: { title: 'PRIVATE-DOCUMENT-TITLE', url: 'https://private.example/Binary/secret', data: 'UFJJVkFURS1CT0RZLUJBU0U2NA==' } }],
  }, { documentIds: ['PRIVATE-DOCUMENT-LINK-ID'], parentDocumentId: 'PRIVATE-PARENT-ID' });
  const binary = wrap('Binary', 'private-binary-id', { data: 'UFJJVkFURS1CT0RZLUJBU0U2NA==', contentType: 'text/plain' });
  const attachment = wrap('DocumentAttachment', 'private-attachment-id', { text: 'PRIVATE-ATTACHMENT-BODY' });
  const result = project([patient, lab, document, binary, attachment]);
  const serialized = publicJson(result);
  for (const forbidden of ['PRIVATE-', 'private-source-id-sensitive', 'private-document-id', 'private-patient@example.com', '1980-04-02', 'https://private.example', 'UFJJVkFURS1CT0RZLUJBU0U2NA==', patientId, 'Patient/', 'Practitioner/']) assert.equal(serialized.includes(forbidden), false, `Leaked ${forbidden}`);
  assert.equal(byName(result.record.labs, 'Hemoglobin').values[0].value, 10.1);
  assert.ok(result.record.documents?.some(row => JSON.stringify(row).includes('Progress note')));
});

test('labels require coded clinical data; text-only narratives and contact or HTML payloads are not silently published', () => {
  const records = [
    wrap('Condition', 'private-text-only', { code: { text: 'TEXT-ONLY-PRIVATE-DIAGNOSIS' } }),
    observation('private-value-string', { code: code('Unstructured result', '1234-5'), valueQuantity: undefined, valueString: 'VALUE-STRING-PRIVATE-NOTE' }),
    observation('private-html', { code: code('<script>UNSAFE-HTML</script>', '1111-1') }),
    observation('private-email', { code: code('Contact hidden-contact@example.com', '2222-2') }),
    observation('private-phone', { code: code('Call 919-555-1234', '3333-3') }),
    observation('private-url', { code: code('See https://private.example/medical', '4444-4') }),
    observation(),
  ];
  const result = project(records);
  for (const forbidden of ['TEXT-ONLY-PRIVATE-DIAGNOSIS', 'VALUE-STRING-PRIVATE-NOTE', '<script>', 'UNSAFE-HTML', 'hidden-contact@example.com', '919-555-1234', 'https://private.example']) assert.equal(publicJson(result).includes(forbidden), false);
  assert.ok(byName(result.record.labs, 'Hemoglobin'));
  assert.ok(result.stats.excludedRecords >= 2);
});

test('projects structured observations and panel components with units, reference intervals and source dates', () => {
  const panel = wrap('Observation', 'private-panel-id', {
    status: 'final', code: code('Blood pressure panel', '85354-9'), effectiveDateTime: '2026-10-29T08:30:00Z',
    component: [
      { code: code('Systolic blood pressure', '8480-6'), valueQuantity: { value: 118, unit: 'mmHg' } },
      { code: code('Diastolic blood pressure', '8462-4'), valueQuantity: { value: 73, unit: 'mmHg' } },
    ],
  });
  const result = project([observation(), panel]);
  const hemoglobin = byName(result.record.labs, 'Hemoglobin');
  assert.equal(hemoglobin.unit, 'g/dL');
  assert.deepEqual(hemoglobin.reference, [11.7, 15.5]);
  assert.equal(hemoglobin.values[0].value, 10.1);
  assert.equal(hemoglobin.values[0].date.slice(0, 10), '2026-10-30');
  assert.equal(byName(result.record.labs, 'Systolic blood pressure').values[0].value, 118);
  assert.equal(byName(result.record.labs, 'Diastolic blood pressure').values[0].value, 73);
  for (const row of [hemoglobin, byName(result.record.labs, 'Systolic blood pressure'), byName(result.record.labs, 'Diastolic blood pressure')]) {
    assert.ok(Array.isArray(row.sourceIds) && row.sourceIds.length);
    const source = sourceFor(result.record, row);
    assert.equal(source.retrievedAt, retrievedAt);
    assert.ok(source.clinicalDate?.startsWith('2026-10-'));
    assert.ok(source.dateMeaning && source.dateMeaning !== 'document-indexed');
  }
  assert.equal(result.latestClinicalDate.slice(0, 10), '2026-10-30');
});

test('keeps medication orders distinct from administration and ignores unstructured dosing instructions', () => {
  const order = wrap('MedicationRequest', 'private-order-id', {
    status: 'active', intent: 'order', authoredOn: '2026-10-28',
    medicationCodeableConcept: code('Lorlatinib', '2049167', 'http://www.nlm.nih.gov/research/umls/rxnorm'),
    requester: { display: 'PRIVATE-REQUESTER-NAME', reference: 'Practitioner/PRIVATE-REQUESTER-ID' },
    dosageInstruction: [{ text: 'PRIVATE-DOSING-NARRATIVE', doseAndRate: [{ doseQuantity: { value: 50, unit: 'mg' } }], timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } } }],
  });
  const administration = wrap('MedicationAdministration', 'private-admin-id', {
    status: 'completed', effectiveDateTime: '2026-10-29', medicationCodeableConcept: code('Admin-only drug', '12345', 'http://www.nlm.nih.gov/research/umls/rxnorm'),
  });
  const result = project([order, administration]);
  const treatment = byName(result.record.treatments, 'Lorlatinib');
  assert.equal(treatment.kind, 'Medication order');
  assert.equal(treatment.dateMeaning, 'order-authored');
  assert.equal(treatment.start, '2026-10-28');
  assert.match(String(treatment.dose), /50/);
  assert.match(JSON.stringify(treatment), /order/i);
  assert.equal(JSON.stringify(treatment).includes('PRIVATE-'), false);
  assert.equal(byName(result.record.treatments, 'Admin-only drug'), undefined);
  assert.notEqual(treatment.status, 'Current medication');
});

test('preserves clinical versus indexed document dates and never treats indexing as a new clinical encounter', () => {
  const indexed = wrap('DocumentReference', 'private-indexed-document', {
    status: 'current', type: code('Progress note', '11506-3'), date: '2026-11-01T09:00:00Z',
    content: [{ attachment: { creation: '2026-10-01', title: 'PRIVATE-TITLE-NOT-A-CLINICAL-DATE' } }],
  });
  const clinical = wrap('DocumentReference', 'private-clinical-document', {
    status: 'current', type: code('Discharge summary', '18842-5'), date: '2026-10-31T09:00:00Z',
    context: { period: { start: '2026-10-25T08:00:00Z', end: '2026-10-25T09:00:00Z' } },
  });
  const result = project([observation(), indexed, clinical]);
  const indexedRow = result.record.documents.find(row => JSON.stringify(row).includes('Progress note'));
  const clinicalRow = result.record.documents.find(row => JSON.stringify(row).includes('Discharge summary'));
  assert.equal(indexedRow.dateMeaning, 'document-indexed');
  assert.equal(clinicalRow.dateMeaning, 'document-clinical-period-start');
  assert.equal(result.latestClinicalDate.slice(0, 10), '2026-10-30');
  assert.equal(sourceFor(result.record, indexedRow).clinicalDate, null);
  assert.ok(sourceFor(result.record, clinicalRow).clinicalDate.startsWith('2026-10-25'));
});

test('coded conditions, allergies, procedures and diagnostic metadata retain source links without free report conclusions', () => {
  const records = [
    wrap('Condition', 'private-condition-id', { code: code('Lung adenocarcinoma', '254637007', 'http://snomed.info/sct'), onsetDateTime: '2025-05-11', clinicalStatus: code('Active', 'active', 'http://terminology.hl7.org/CodeSystem/condition-clinical') }),
    wrap('AllergyIntolerance', 'private-allergy-id', { subject: undefined, patient: { reference: `Patient/${patientId}` }, code: code('Penicillin allergy', '91936005', 'http://snomed.info/sct'), recordedDate: '2026-10-01', note: [{ text: 'PRIVATE-ALLERGY-NOTE' }] }),
    wrap('Procedure', 'private-procedure-id', { status: 'completed', code: code('Thoracentesis', '91602002', 'http://snomed.info/sct'), performedDateTime: '2026-10-04' }),
    wrap('DiagnosticReport', 'private-report-id', { status: 'final', code: code('CT chest', '24627-2'), effectiveDateTime: '2026-10-20', issued: '2026-10-21T08:00:00Z', conclusion: 'PRIVATE-FREE-TEXT-REPORT', presentedForm: [{ data: 'PRIVATE-BASE64-REPORT' }], result: [{ reference: 'Observation/PRIVATE-OBS-REF' }] }),
  ];
  const result = project(records);
  assert.ok(byName(result.record.conditions, 'Lung adenocarcinoma'));
  assert.ok(result.record.allergies?.some(row => JSON.stringify(row).includes('Penicillin allergy')));
  assert.ok(byName(result.record.treatments, 'Thoracentesis'));
  assert.ok(result.record.diagnostics?.some(row => JSON.stringify(row).includes('CT chest')));
  for (const row of projectionRows(result.record)) assert.ok(row.sourceIds?.length, `Missing source link in ${row.id}`);
  for (const forbidden of ['PRIVATE-', 'private-condition-id', 'private-allergy-id', 'private-procedure-id', 'private-report-id']) assert.equal(publicJson(result).includes(forbidden), false);
});

test('public IDs and sanitized snapshot digest are stable across permutations, retries and reused projected baselines', () => {
  const rows = [observation(), wrap('Condition', 'private-stable-condition', { code: code('Stable coded condition', '123456', 'http://snomed.info/sct'), onsetDateTime: '2026-10-02' })];
  const first = project(rows);
  const permuted = project([...rows].reverse());
  assert.ok(typeof first.sourceSnapshotDigest === 'string' && first.sourceSnapshotDigest.length >= 32);
  assert.equal(first.sourceSnapshotDigest, permuted.sourceSnapshotDigest);
  const ids = record => projectionRows(record).map(row => row.id).sort();
  assert.deepEqual(ids(first.record), ids(permuted.record));
  const repeated = project([...rows, ...rows], { baseRecord: first.record });
  assert.deepEqual(ids(first.record), ids(repeated.record));
  for (const section of ['conditions', 'labs', 'sources', 'timeline']) {
    const values = repeated.record[section].map(row => row.id);
    assert.equal(new Set(values).size, values.length);
  }
  for (const id of ids(first.record)) assert.ok(!id.includes('private-') && !id.includes(patientId));
});

test('projection leaves curated baseline and inputs untouched and does not infer negative findings from absent data', () => {
  const baseline = baseRecord();
  const baselineBefore = structuredClone(baseline);
  const rows = [observation()];
  const rowsBefore = structuredClone(rows);
  const result = project(rows, { baseRecord: baseline });
  assert.deepEqual(baseline, baselineBefore);
  assert.deepEqual(rows, rowsBefore);
  for (const section of ['overview', 'conditions', 'treatments', 'timeline', 'labs', 'sources', 'uncertainties']) for (const old of baseline[section]) assert.ok(result.record[section].some(row => JSON.stringify(row) === JSON.stringify(old)), `Lost curated ${section}`);
  assert.equal(result.record.molecular.some(row => /HLA/.test(JSON.stringify(row))), false);
  const empty = project([]);
  assert.equal(/no (known )?allergies|no cancer|disease.free|complete hospital/i.test(publicJson(empty)), false);
});

test('invalid or missing selected patient context fails closed', () => {
  for (const selected of [undefined, '', '../other', 'chart-A?secret=1']) assert.throws(() => project([observation()], { patientId: selected }));
});

test('unknown modifier extensions fail closed without mutating curated chronology', () => {
  const rootModifier = observation('private-modifier-root', { modifierExtension: [{ url: 'https://private.example/reinterpret', valueBoolean: true }] });
  const componentModifier = observation('private-modifier-child', { component: [{ modifierExtension: [{ url: 'https://private.example/meaning', valueBoolean: true }], code: code('Unsafe component'), valueQuantity: { value: 1, unit: 'mg' } }] });
  const emptyModifier = observation('private-empty-modifier', { modifierExtension: [] });
  const result = project([rootModifier, componentModifier, emptyModifier]);
  assert.equal(result.stats.exclusionCounts['modifier-extension'], 2);
  assert.equal(result.record.labs.filter(row => row.projectionOrigin).length, 1);
  assert.equal(result.record.meta.updated, '2026-10-31');
  assert.equal(result.record.meta.subject, 'Publicly chosen subject');
});

test('supported absolute versioned patient references bind while conflicting references do not', () => {
  const valid = observation('private-history-bound', { subject: { reference: `https://health-apis.duke.edu/FHIR/api/FHIR/R4/Patient/${patientId}/_history/version-1` } });
  const conflict = observation('private-conflicting-bound', { patient: { reference: 'Patient/chart-B' } });
  const result = project([valid, conflict]);
  assert.equal(result.stats.byResourceType.Observation, 1);
  assert.equal(result.stats.exclusionCounts['patient-binding-failed'], 1);
});

test('unsupported private resource type labels cannot leak through diagnostic counts', () => {
  const rawType = 'PRIVATE-PATIENT-TEXT';
  const result = project([wrap(rawType, 'private-resource-id', { text: { div: 'PRIVATE-NOTE' } })]);
  assert.equal(publicJson(result).includes(rawType), false);
  assert.equal(result.stats.receivedByResourceType.Unsupported, 1);
  assert.equal(result.stats.exclusionCounts['unsupported-resource-type'], 1);
});
