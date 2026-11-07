import { createHash } from 'node:crypto';

const VERSION = '1.0.0';
const ORIGIN = 'duke-fhir-v1';
const SECTIONS = ['conditions', 'allergies', 'labs', 'molecular', 'treatments', 'diagnostics', 'documents', 'timeline'];
const SYSTEMS = new Set(['LOINC', 'SNOMED CT', 'RxNorm', 'ICD-10-CM', 'ICD-10', 'ICD-9-CM', 'CPT', 'UCUM']);
const EFFECTIVE_MEANINGS = new Set(['observation-effective', 'observation-period-start']);
const NON_CLINICAL_MEANINGS = new Set(['document-indexed', 'not-supplied', 'retrieved', 'retrieval']);
const MAX_ROWS = 100_000, MAX_POINTS = 100_000, MAX_GROUPS = 100, MAX_NOTICES = 20, MAX_REFS = 20;
const array = value => Array.isArray(value) ? value : [];
const structured = row => row?.projectionOrigin === ORIGIN || row?.evidence === 'provider-structured';
const publicId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null;
const safeText = (value, limit = 160) => typeof value === 'string' && value.length <= limit && !/[<>\u0000-\u001f]|https?:|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(value) ? value : '';

function temporal(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^(?:19|20|21)\d{2}(?:-(?:0[1-9]|1[0-2])(?:-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?)?)?$/.test(value)) return null;
  const date = value.slice(0, 10), precision = value.includes('T') ? 'instant' : value.length === 10 ? 'day' : value.length === 7 ? 'month' : 'year';
  const start = Date.parse(precision === 'instant' ? value : `${date}${precision === 'year' ? '-01-01' : precision === 'month' ? '-01' : ''}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  if (value.length >= 10 && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return null;
  let end = start;
  if (precision === 'year') end = Date.UTC(+value + 1, 0, 1) - 1;
  else if (precision === 'month') end = Date.UTC(+value.slice(0, 4), +value.slice(5, 7), 1) - 1;
  else if (precision === 'day') end = start + 86_400_000 - 1;
  return { value, start, end, key: precision === 'instant' ? new Date(start).toISOString() : value, precision };
}
function later(value, boundary) {
  const current = temporal(value), before = temporal(boundary);
  return !!current && !!before && current.start > before.end;
}
function latest(values) {
  let result = null, time = -Infinity;
  for (const value of values) { const item = temporal(value); if (item && (item.start > time || (item.start === time && item.value > result))) { result = item.value; time = item.start; } }
  return result;
}
function references(rows, sourceIds) {
  const entryIds = new Set(), sources = new Set();
  for (const row of rows) {
    const id = publicId(row?.id); if (id) entryIds.add(id);
    for (const ref of array(row?.sourceIds)) if (publicId(ref) && sourceIds.has(ref)) sources.add(ref);
  }
  const entries = [...entryIds].sort(), refs = [...sources].sort();
  return { entryIds: entries.slice(0, MAX_REFS), sourceIds: refs.slice(0, MAX_REFS), omittedEntryIds: Math.max(0, entries.length - MAX_REFS), omittedSourceIds: Math.max(0, refs.length - MAX_REFS) };
}

/** Derive bounded source/date/coherence checks from an already-public Atlas.
 * Pure and deterministic: no private records, clock, model, or medical inference.
 * This block describes its own method/version; it is not a clinician sign-off.
 */
export function reconcileAtlasRecord(record, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('A public Atlas record is required.');
  const meta = record.meta ?? {}, publication = meta.publication ?? {};
  const checkedAt = temporal(options.checkedAt ?? publication.publishedAt ?? publication.preparedAt)?.value ?? null;
  const sourceSyncValue = Object.hasOwn(options, 'sourceSyncAt') ? options.sourceSyncAt : publication.sourceSyncAt;
  const sourceSyncAt = temporal(sourceSyncValue)?.value ?? null;
  const curatedAsOf = temporal(meta.updated)?.value ?? null;
  const medicationHistoryAsOf = temporal(meta.lastMedicationUpdate)?.value ?? null;
  const sources = array(record.sources).slice(0, MAX_ROWS), sourceIds = new Set(sources.map(x => publicId(x?.id)).filter(Boolean));
  const structuredSources = sources.filter(x => x?.projectionOrigin === ORIGIN || x?.type === 'provider-structured');
  const rows = [], sectionCounts = {};
  let remaining = MAX_ROWS, omittedRows = 0;
  for (const section of SECTIONS) {
    const entries = array(record[section]);
    sectionCounts[section] = { total: entries.length, structured: 0, curated: 0 };
    const selected = entries.slice(0, remaining); omittedRows += entries.length - selected.length; remaining -= selected.length;
    for (const row of selected) {
      if (!row || typeof row !== 'object') continue;
      const imported = structured(row);
      sectionCounts[section][imported ? 'structured' : 'curated']++;
      rows.push({ section, row, imported });
    }
  }
  const imported = rows.filter(x => x.imported), curated = rows.filter(x => !x.imported);
  const clinicalRows = imported.filter(({ row }) => !NON_CLINICAL_MEANINGS.has(row.dateMeaning) && temporal(row.clinicalDate));
  const latestStructuredClinicalDate = latest(clinicalRows.map(({ row }) => row.clinicalDate));
  const newer = curatedAsOf ? clinicalRows.filter(({ row }) => later(row.clinicalDate, curatedAsOf)) : [];
  const orders = imported.filter(x => x.section === 'treatments' && x.row.kind === 'Medication order' && x.row.dateMeaning === 'order-authored');
  const newerOrders = medicationHistoryAsOf ? orders.filter(({ row }) => later(row.date ?? row.start, medicationHistoryAsOf)) : [];
  const diagnosticRows = imported.filter(x => x.section === 'diagnostics'), documentRows = imported.filter(x => x.section === 'documents');
  const allergyRows = imported.filter(x => x.section === 'allergies');
  const hla = rows.filter(x => x.section === 'molecular' && /\bHLA(?:\b|[- ])/.test(String(x.row.name ?? '').toUpperCase()) && typeof x.row.value === 'string' && x.row.value.trim() && array(x.row.sourceIds).some(id => sourceIds.has(id)));
  const missingProvenance = imported.filter(({ row }) => !array(row.sourceIds).length || array(row.sourceIds).some(ref => !sourceIds.has(ref)));
  const measurements = new Map();
  let measurementPoints = 0, ungroupedMeasurementPoints = 0, omittedMeasurementPoints = 0;
  for (const { section, row, imported: isImported } of rows) {
    if (section !== 'labs') continue;
    const points = array(row.values);
    for (const value of points) {
      if (measurementPoints >= MAX_POINTS) { omittedMeasurementPoints++; continue; }
      measurementPoints++;
      const code = row.code;
      const dateMeaning = value?.dateMeaning ?? row.dateMeaning;
      const effective = temporal(value?.date);
      // No fuzzy label matching, unit conversions, issued dates, or inferred sample identity.
      if (!code || !SYSTEMS.has(code.system) || !safeText(code.code, 80) || !effective || !EFFECTIVE_MEANINGS.has(dateMeaning) || typeof value.value !== 'number' || !Number.isFinite(value.value) || typeof row.unit !== 'string' || row.unit.length > 32 || !publicId(row.id)) { ungroupedMeasurementPoints++; continue; }
      const key = JSON.stringify([code.system, code.code, effective.key, dateMeaning, row.unit]);
      let group = measurements.get(key);
      if (!group) {
        group = { key, code: { system: code.system, code: code.code }, date: effective.key, dateMeaning, unit: safeText(row.unit, 32), name: safeText(row.name) || 'Coded measurement', members: [], variants: new Map(), hasStructured: false };
        measurements.set(key, group);
      }
      group.hasStructured ||= isImported;
      const label = safeText(row.name); if (label && label < group.name) group.name = label;
      group.members.push({ id: row.id, sourceIds: [...array(row.sourceIds), ...array(value.sourceIds)] });
      const comparator = ['<', '<=', '>', '>='].includes(value.comparator) ? value.comparator : '';
      const variantKey = JSON.stringify([value.value, comparator]);
      const variant = group.variants.get(variantKey) ?? { value: value.value, comparator, count: 0 };
      variant.count++; group.variants.set(variantKey, variant);
    }
  }
  const allGroups = [];
  for (const group of measurements.values()) {
    if (!group.hasStructured || group.members.length < 2) continue;
    const ref = references(group.members, sourceIds);
    const values = [...group.variants.values()].sort((a, b) => a.value - b.value || a.comparator.localeCompare(b.comparator));
    allGroups.push({ id: `atlas-measurements-${createHash('sha256').update(group.key).digest('hex').slice(0, 24)}`, kind: values.length > 1 ? 'multiple-reported-values' : 'duplicate-measurement', name: group.name, code: group.code, date: group.date, dateMeaning: group.dateMeaning, unit: group.unit, memberCount: group.members.length, distinctValueCount: values.length, values: values.slice(0, MAX_REFS), omittedValues: Math.max(0, values.length - MAX_REFS), ...ref });
  }
  allGroups.sort((a, b) => (a.kind === 'multiple-reported-values' ? 0 : 1) - (b.kind === 'multiple-reported-values' ? 0 : 1) || a.id.localeCompare(b.id));
  const duplicateMeasurementGroups = allGroups.filter(x => x.kind === 'duplicate-measurement').length, multipleValueGroups = allGroups.length - duplicateMeasurementGroups;
  const counts = { curatedEntries: curated.length, structuredEntries: imported.length, structuredSourceRecords: structuredSources.length, structuredAllergies: allergyRows.length, medicationOrders: orders.length, ordersAfterMedicationHistory: newerOrders.length, diagnosticMetadata: diagnosticRows.length, documentMetadata: documentRows.length, measurementPoints, ungroupedMeasurementPoints, duplicateMeasurementGroups, multipleValueGroups, omittedMeasurementGroups: Math.max(0, allGroups.length - MAX_GROUPS), omittedMeasurementPoints, omittedRows, sections: sectionCounts };
  const notices = [];
  const notice = (code, title, detail, requiresReview, entries = []) => notices.push({ code, title, detail, requiresReview, ...references(entries, sourceIds) });
  if (imported.length || structuredSources.length) notice('new-source-coverage-needs-review', 'Structured records supplement the dated narrative', 'Imported structured entries may include historical facts absent from the curated source set even when their clinical dates are older. Compare dated baseline answers with the structured entries and the source-bound editorial review when present. This coverage check does not determine whether an editorial review is pending.', true, allergyRows.length ? allergyRows.map(x => x.row) : imported.slice(0, MAX_REFS).map(x => x.row));
  if ((imported.length || structuredSources.length) && !sourceSyncAt) notice('source-sync-not-established', 'Complete source sync is not established', 'No complete source synchronization timestamp is available in this public snapshot. Record retrieval timestamps do not establish a complete chart import.', true);
  if (newer.length) notice('curated-summary-date-needs-review', 'Source entries are dated after the curated summary', `${newer.length} structured entries have dates later than the curated narrative date. They require comparison with the summary; a later recorded date does not establish newly developed disease.`, true, newer.slice(0, MAX_REFS).map(x => x.row));
  if (orders.length) notice('medication-use-not-reconciled', 'Orders do not establish the current regimen', `${orders.length} medication orders are retained separately. Active order status does not establish dispensing, a dose administered, adherence, or current use. The curated medication history has not been automatically replaced.`, true, orders.slice(0, MAX_REFS).map(x => x.row));
  if (newerOrders.length || (orders.length && !medicationHistoryAsOf)) notice('medication-history-date-needs-review', 'Medication history needs a dated comparison', medicationHistoryAsOf ? `${newerOrders.length} orders were authored after the last dated medication-history update. This is a reconciliation prompt, not evidence that the patient took them.` : 'Medication orders are available, but the curated medication-history date is not established.', true, newerOrders.slice(0, MAX_REFS).map(x => x.row));
  if (diagnosticRows.length || documentRows.length) notice('report-bodies-needed', 'Report metadata does not establish findings', 'Coded diagnostic and document metadata can identify report dates and types. Narrative findings and document bodies are excluded from the public projection; response, progression, radiation completion, and treatment decisions cannot be inferred from this metadata.', true, [...diagnosticRows, ...documentRows].slice(0, MAX_REFS).map(x => x.row));
  if (multipleValueGroups) notice('multiple-reported-measurement-values', 'Some coded measurements have multiple reported values', `${multipleValueGroups} groups contain differing values for the same recognized code, exact reported effective date, and unit. They may represent different samples, revisions, or contexts. No result has been selected as correct and no clinical contradiction is inferred.`, true);
  if (duplicateMeasurementGroups) notice('duplicate-reported-measurements', 'Repeated coded measurements are grouped for inspection', `${duplicateMeasurementGroups} groups repeat the same value and comparator for the same recognized code, exact reported effective date, and unit. Every original entry and source is retained.`, false);
  if (missingProvenance.length) notice('missing-public-provenance', 'Some structured entries lack complete public source links', `${missingProvenance.length} structured entries have absent or unresolved public source references.`, true, missingProvenance.slice(0, MAX_REFS).map(x => x.row));
  if (omittedRows || omittedMeasurementPoints || counts.omittedMeasurementGroups) notice('bounded-check-output', 'Check details are bounded', 'The check has explicit row, measurement, and finding limits. Omitted-detail counts describe this check block; the underlying public facts have not been removed.', true);
  const coverage = [
    { id: 'curated-summary', title: 'Curated narrative', status: curatedAsOf ? 'dated-snapshot' : 'date-unknown', asOf: curatedAsOf, detail: 'Summary, FAQ, and historical treatment prose retain their original dated scope; these checks do not rewrite them.' },
    { id: 'structured-data', title: 'Structured source records', status: imported.length || structuredSources.length ? 'available' : 'none-in-snapshot', count: structuredSources.length, detail: 'Counts describe available public structured records; they do not establish EHR completeness.' },
    { id: 'medication-use', title: 'Medication use reconciliation', status: 'not-clinically-reconciled', count: orders.length, asOf: medicationHistoryAsOf, detail: 'Orders and a dated curated medication history are separate kinds of evidence. No current regimen is inferred.' },
    { id: 'report-bodies', title: 'Diagnostic narrative coverage', status: diagnosticRows.length || documentRows.length ? 'metadata-only' : 'not-established', count: diagnosticRows.length + documentRows.length, detail: 'Public structured metadata does not contain the excluded report narratives or establish their findings.' },
    { id: 'hla', title: 'HLA source coverage', status: hla.length ? 'cited-entries-present' : 'unknown', count: hla.length, detail: hla.length ? 'Cited HLA-related entries remain available. Import absence does not invalidate earlier HLA results; this is not a completeness check for allele typing.' : 'No cited HLA result is established by the entries checked here. Missing data does not mean negative typing.', ...references(hla.map(x => x.row), sourceIds) },
    { id: 'source-sync', title: 'Source synchronization', status: sourceSyncAt ? 'timestamp-supplied' : 'not-established', asOf: sourceSyncAt, detail: sourceSyncAt ? 'A synchronization timestamp is supplied; it does not establish exhaustive EHR coverage.' : 'Retrieval timestamps do not establish completion of source synchronization.' },
  ];
  const summary = {
    title: 'A dated narrative with structured source facts',
    items: [
      { label: 'Curated narrative as of', value: curatedAsOf ?? 'Not established' },
      { label: 'Latest structured clinical date checked', value: latestStructuredClinicalDate ?? 'Not established' },
      { label: 'Structured source records', value: structuredSources.length },
      { label: 'Medication orders, not confirmed use', value: orders.length },
      { label: 'Diagnostic and document metadata entries', value: diagnosticRows.length + documentRows.length },
    ],
    limits: ['These are deterministic source, date, and value checks, not a clinical review.', 'A new source can add historical facts without a newer clinical date.', 'No disease response, treatment decision, negative finding, or current regimen is inferred.'],
  };
  return { version: VERSION, method: 'deterministic-public-fact-checks', scope: 'derived-from-public-record', status: notices.some(x => x.requiresReview) ? 'review-needed' : 'checks-complete', checkedAt, curatedAsOf, medicationHistoryAsOf, sourceSyncAt, latestStructuredClinicalDate, counts, notices: notices.slice(0, MAX_NOTICES), measurementGroups: allGroups.slice(0, MAX_GROUPS), coverage, summary };
}
