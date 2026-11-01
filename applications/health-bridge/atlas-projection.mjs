import { createHash } from 'node:crypto';
import { DUKE_BASE } from './fhir.mjs';

// This is an allow-list projection, not a FHIR serializer or note deidentifier.
// No private wrapper, raw resource, reference, attachment, or narrative is copied.
const ORIGIN = 'duke-fhir-v1';
const SECTIONS = ['conditions', 'allergies', 'labs', 'molecular', 'treatments', 'diagnostics', 'documents', 'timeline', 'sources'];
const TYPES = new Set(['Patient', 'Condition', 'AllergyIntolerance', 'Observation', 'MedicationRequest', 'Procedure', 'DiagnosticReport', 'DocumentReference']);
const ID = /^[A-Za-z0-9.-]{1,64}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._:+/\-]{0,79}$/;
const STATUS = new Set(['active', 'inactive', 'resolved', 'recurrence', 'relapse', 'remission', 'confirmed', 'unconfirmed', 'provisional', 'differential', 'refuted', 'entered-in-error', 'registered', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'canceled', 'unknown', 'completed', 'in-progress', 'not-done', 'on-hold', 'stopped', 'draft', 'intended', 'current', 'superseded', 'available', 'unavailable']);
const SYSTEMS = new Map([
  ['http://loinc.org', 'LOINC'], ['http://snomed.info/sct', 'SNOMED CT'],
  ['http://www.nlm.nih.gov/research/umls/rxnorm', 'RxNorm'],
  ['http://hl7.org/fhir/sid/icd-10-cm', 'ICD-10-CM'], ['http://hl7.org/fhir/sid/icd-10', 'ICD-10'],
  ['http://hl7.org/fhir/sid/icd-9-cm', 'ICD-9-CM'], ['http://www.ama-assn.org/go/cpt', 'CPT'],
  ['http://unitsofmeasure.org', 'UCUM'],
]);
const UNSAFE_TEXT = /[<>\u0000-\u001f\u007f]|https?:|www\.|mailto:|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\b(?:MRN|DOB|SSN|birth\s*date|date\s*of\s*birth|patient\s*(?:id|number)|medical\s*record|access[ _-]?token|refresh[ _-]?token|bearer|authorization)\b)|(?:\b(?:Patient|Binary|DocumentReference|Practitioner|Encounter)\/)|(?:\+?\d[\d ().-]{7,}\d)|(?:\b\d{1,6}\s+[A-Za-z ]{2,30}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Boulevard|Blvd)\b)|(?:[A-Za-z0-9+/]{48,}={0,2})/i;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex'); }
function publicId(kind, privateId) { return `duke-${kind}-${digest(`${kind}\0${privateId}`).slice(0, 32)}`; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function array(value) { return Array.isArray(value) ? value : []; }
function date(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  // FHIR dates can have year/month precision. Validate the actual calendar day.
  if (/^\d{4}$/.test(value)) return +value >= 1900 && +value <= 2200 ? value : null;
  if (/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return +value.slice(0, 4) >= 1900 && +value.slice(0, 4) <= 2200 ? value : null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match || +value.slice(0, 4) < 1900 || +value.slice(0, 4) > 2200) return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(time) && new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) === match[1] ? value : null;
}
function firstDate(...pairs) {
  for (const [meaning, value, clinical = true] of pairs) { const valid = date(value); if (valid) return { date: valid, dateMeaning: meaning, clinical }; }
  return { date: null, dateMeaning: 'not-supplied', clinical: false };
}
function dates(raw) {
  switch (raw.resourceType) {
    case 'Condition': return firstDate(['onset', raw.onsetDateTime], ['onset-period-start', raw.onsetPeriod?.start], ['condition-recorded', raw.recordedDate]);
    case 'AllergyIntolerance': return firstDate(['allergy-onset', raw.onsetDateTime], ['allergy-recorded', raw.recordedDate]);
    case 'MedicationRequest': return firstDate(['order-authored', raw.authoredOn]);
    case 'Procedure': return firstDate(['procedure-performed', raw.performedDateTime], ['procedure-period-start', raw.performedPeriod?.start]);
    case 'Observation': return firstDate(['observation-effective', raw.effectiveDateTime], ['observation-period-start', raw.effectivePeriod?.start], ['observation-issued', raw.issued]);
    case 'DiagnosticReport': return firstDate(['report-effective', raw.effectiveDateTime], ['report-period-start', raw.effectivePeriod?.start], ['report-issued', raw.issued]);
    case 'DocumentReference': return firstDate(['document-clinical-period-start', raw.context?.period?.start], ['document-indexed', raw.date, false]);
    default: return firstDate();
  }
}
function exactPatientReference(value, patientId) {
  if (typeof value !== 'string') return false;
  const prefix = value.startsWith(`${DUKE_BASE}/`) ? value.slice(DUKE_BASE.length + 1) : value;
  const expected = `Patient/${patientId}`;
  return prefix === expected || (prefix.startsWith(`${expected}/_history/`) && ID.test(prefix.slice(expected.length + 10)));
}
function bound(raw, patientId) {
  if (raw.resourceType === 'Patient') return raw.id === patientId;
  const references = [raw.subject, raw.patient].filter(x => x !== undefined);
  return references.length > 0 && references.every(x => x && exactPatientReference(x.reference, patientId));
}
function modifier(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(modifier);
  if (value.modifierExtension !== undefined && (!Array.isArray(value.modifierExtension) || value.modifierExtension.length)) return true;
  return Object.values(value).some(modifier);
}
function secretValues(records, selectedPatient) {
  const values = new Set([selectedPatient]);
  function add(v) { if (typeof v === 'string' && v.length >= 4 && v.length <= 512) values.add(v); }
  function privateFields(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) privateFields(item); return; }
    for (const [key, item] of Object.entries(value)) {
      if (['id', 'reference', 'url'].includes(key)) add(item);
      if (key === 'identifier') for (const identifier of Array.isArray(item) ? item : [item]) add(identifier?.value);
      if (item && typeof item === 'object') privateFields(item);
    }
  }
  for (const record of records) {
    add(record?.id); add(record?.raw?.id);
    add(record?.parentDocumentId);
    for (const documentId of array(record?.documentIds)) add(documentId);
    const raw = record?.raw;
    privateFields(raw);
    if (raw?.resourceType === 'Patient') {
      for (const name of array(raw.name)) { add(name?.family); for (const given of array(name?.given)) add(given); add(name?.text); }
      add(raw.birthDate);
      for (const address of array(raw.address)) { add(address?.text); for (const line of array(address?.line)) add(line); }
      for (const contact of array(raw.telecom)) add(contact?.value);
    }
    for (const ident of array(raw?.identifier)) add(ident?.value);
  }
  return [...values];
}
function cleaner(secrets) {
  // Index private tokens once. Scanning the bounded candidate substrings avoids
  // a record-count-squared loop over every private identifier for every label.
  // Case folding can expand Unicode, so use folded lengths, as includes() did.
  const tokenLengths = new Map();
  for (const secret of secrets) {
    const folded = secret.toLowerCase();
    if (!folded || folded.length > 320) continue; // Candidate labels are <=160 characters before case folding.
    if (!tokenLengths.has(folded.length)) tokenLengths.set(folded.length, new Set());
    tokenLengths.get(folded.length).add(folded);
  }
  const groups = [...tokenLengths].sort(([a], [b]) => a - b);
  const memo = new Map();
  return (value, limit = 160, clinicalCode = false) => {
    if (typeof value !== 'string') return '';
    const text = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
    // Check the bound before any unanchored regex can inspect provider text.
    if (!text || text.length > limit) return '';
    const key = `${limit}:${clinicalCode ? 'code' : 'label'}:${text}`;
    if (memo.has(key)) return memo.get(key);
    const remember = result => {
      if (memo.size >= 2048) memo.clear();
      memo.set(key, result);
      return result;
    };
    // Numeric clinical codes are not phone numbers. Their syntax is constrained
    // separately; still reject reference-like or credential-like code payloads.
    const unsafe = clinicalCode ? /[<>\u0000-\u001f\u007f]|:\/\/|(?:Patient|Binary|DocumentReference|Practitioner|Encounter)\/|(?:MRN|DOB|SSN|access.token|refresh.token|bearer)/i.test(text) : UNSAFE_TEXT.test(text);
    if (unsafe) return remember('');
    const lower = text.toLowerCase();
    for (const [length, tokens] of groups) {
      if (length > lower.length) break;
      for (let start = 0; start <= lower.length - length; start++) {
        if (tokens.has(lower.slice(start, start + length))) return remember('');
      }
    }
    return remember(text);
  };
}
function concept(value, clean) {
  for (const coding of Array.isArray(value?.coding) ? value.coding : []) {
    const code = typeof coding?.code === 'string' && CODE.test(coding.code) ? clean(coding.code, 80, true) : '';
    const label = clean(coding?.display);
    if (!code || !label) continue;
    const system = SYSTEMS.get(coding.system);
    return { label, code, ...(system ? { system } : {}) };
  }
  return null; // CodeableConcept.text is intentionally never a public fallback.
}
function status(raw, field = 'status') {
  const value = raw[field];
  if (typeof value === 'string') return STATUS.has(value) ? value : 'not-supplied';
  return array(value?.coding).map(x => x?.code).find(x => STATUS.has(x)) ?? 'not-supplied';
}
function quantity(value, clean) {
  if (!value || typeof value.value !== 'number' || !Number.isFinite(value.value) || Math.abs(value.value) > 1e15) return null;
  const unit = clean(value.unit ?? value.code, 32);
  const comparator = ['<', '<=', '>=', '>'].includes(value.comparator) ? value.comparator : '';
  return { value: value.value, unit, ...(comparator ? { comparator } : {}) };
}
function codedList(values, clean) { return (Array.isArray(values) ? values : []).map(v => concept(v, clean)).filter(Boolean); }
function referenceRange(raw, clean) {
  const ranges = [];
  for (const item of (Array.isArray(raw.referenceRange) ? raw.referenceRange : []).slice(0, 8)) {
    const low = quantity(item.low, clean), high = quantity(item.high, clean);
    if (low || high) ranges.push({ ...(low ? { low: low.value } : {}), ...(high ? { high: high.value } : {}), unit: low?.unit || high?.unit || '' });
  }
  return ranges;
}
function prescribedDose(raw, clean) {
  const result = [];
  for (const instruction of (Array.isArray(raw.dosageInstruction) ? raw.dosageInstruction : []).slice(0, 12)) {
    const item = { meaning: 'prescribed-instruction-not-administration' };
    const route = concept(instruction.route, clean); if (route) item.route = route.label;
    for (const amount of (Array.isArray(instruction.doseAndRate) ? instruction.doseAndRate : []).slice(0, 8)) {
      const dose = quantity(amount.doseQuantity, clean); if (dose) (item.doses ??= []).push(dose);
    }
    const repeat = instruction.timing?.repeat;
    if (repeat) {
      const timing = {};
      for (const key of ['frequency', 'frequencyMax', 'period', 'periodMax']) if (typeof repeat[key] === 'number' && Number.isFinite(repeat[key]) && repeat[key] > 0 && repeat[key] <= 1e6) timing[key] = repeat[key];
      if (['s', 'min', 'h', 'd', 'wk', 'mo', 'a'].includes(repeat.periodUnit)) timing.periodUnit = repeat.periodUnit;
      if (Object.keys(timing).length) item.timing = timing;
    }
    if (Object.keys(item).length > 1) result.push(item);
  }
  return result;
}
function observeValue(raw, clean) {
  const numeric = quantity(raw.valueQuantity, clean);
  if (numeric) return { numeric };
  const coded = concept(raw.valueCodeableConcept, clean);
  if (coded) return { coded };
  if (typeof raw.valueBoolean === 'boolean') return { coded: { label: raw.valueBoolean ? 'True' : 'False', code: String(raw.valueBoolean) } };
  if (Number.isSafeInteger(raw.valueInteger)) return { numeric: { value: raw.valueInteger, unit: '' } };
  return null; // Free-text strings, notes, absent-reason narratives and raw attachments remain private.
}

/** Build a deterministic, public-safe Atlas projection from already-owned decrypted records.
 * Caller remains responsible for owner authorization and public publication consent.
 * The source label alone is not a patient binding: each raw Duke resource is rebound.
 */
export function buildAtlasProjection({ baseRecord, records, patientId, publishedAt, revision, sourceSyncAt } = {}) {
  if (!baseRecord || typeof baseRecord !== 'object' || Array.isArray(baseRecord)) throw new TypeError('A curated Atlas base record is required.');
  if (!Array.isArray(records) || records.length > 20_000) throw new TypeError('A bounded owned record list is required.');
  if (typeof patientId !== 'string' || !ID.test(patientId) || patientId === '.' || patientId === '..') throw new TypeError('A valid selected patient identifier is required.');
  // Validate optional publication context without rewriting curated chronology/status.
  if (publishedAt !== undefined && !date(publishedAt)) throw new TypeError('A valid publication date is required.');
  if (sourceSyncAt !== undefined && sourceSyncAt !== null && !date(sourceSyncAt)) throw new TypeError('A valid source synchronization date is required.');
  if (revision !== undefined && !(Number.isSafeInteger(revision) && revision >= 0) && !(typeof revision === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(revision))) throw new TypeError('A bounded publication revision is required.');
  const record = clone(baseRecord);
  for (const section of SECTIONS) record[section] = (Array.isArray(record[section]) ? record[section] : []).filter(x => x?.projectionOrigin !== ORIGIN);
  const clean = cleaner(secretValues(records, patientId));
  const additions = Object.fromEntries(SECTIONS.map(key => [key, []]));
  const counts = new Map(), receivedByResourceType = {}, byResourceType = {};
  let dukeRecords = 0, patientBoundRecords = 0, identityChecked = 0, latestClinicalDate = null;
  const rejected = reason => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const candidates = new Map();
  for (const wrapper of records) {
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) { rejected('malformed-wrapper'); continue; }
    if (wrapper.source !== 'duke') { rejected(wrapper.source === 'apple' ? 'apple-not-in-public-v1' : 'non-duke-source'); continue; }
    dukeRecords++;
    const raw = wrapper.raw;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { rejected('missing-raw-resource'); continue; }
    const type = raw.resourceType;
    if (typeof type !== 'string' || (wrapper.resourceType && type !== wrapper.resourceType)) { rejected('resource-type-mismatch'); continue; }
    const countType = TYPES.has(type) || ['Binary', 'DocumentAttachment', 'MedicationAdministration'].includes(type) ? type : 'Unsupported';
    receivedByResourceType[countType] = (receivedByResourceType[countType] ?? 0) + 1;
    if (!TYPES.has(type)) { rejected(['Binary', 'DocumentAttachment'].includes(type) ? 'private-document-body' : 'unsupported-resource-type'); continue; }
    if (!bound(raw, patientId)) { rejected('patient-binding-failed'); continue; }
    patientBoundRecords++;
    if (modifier(raw)) { rejected('modifier-extension'); continue; }
    if (type === 'Patient') { identityChecked++; rejected('patient-identity-private'); continue; }
    if (typeof raw.id !== 'string' || !ID.test(raw.id)) { rejected('missing-resource-id'); continue; }
    if (status(raw) === 'entered-in-error' || status(raw, 'verificationStatus') === 'entered-in-error') { rejected('entered-in-error'); continue; }
    const key = `${type}\0${raw.id}`;
    // Deduplicate before mapping, choosing a deterministic latest retrieval snapshot.
    const candidate = { wrapper, raw, type, retrievedAt: date(wrapper.retrievedAt), tie: digest(raw) };
    const prior = candidates.get(key);
    if (prior) {
      rejected('duplicate-resource');
      if (`${candidate.retrievedAt ?? ''}\0${candidate.tie}` > `${prior.retrievedAt ?? ''}\0${prior.tie}`) candidates.set(key, candidate);
    } else candidates.set(key, candidate);
  }
  for (const candidate of [...candidates.values()].sort((a, b) => `${a.type}\0${a.raw.id}`.localeCompare(`${b.type}\0${b.raw.id}`))) {
    const { raw, type, retrievedAt } = candidate;
    const d = dates(raw), sourceId = publicId('source', `${type}\0${raw.id}`);
    const shared = { evidence: 'provider-structured', sourceIds: [sourceId], date: d.date, dateMeaning: d.dateMeaning, clinicalDate: d.clinical ? d.date : null, retrievedAt, projectionOrigin: ORIGIN };
    let emitted = 0;
    const push = (section, value) => { additions[section].push({ ...shared, ...value }); emitted++; };
    const event = (label, summary, category) => push('timeline', { id: publicId('event', `${type}\0${raw.id}`), dateLabel: d.date ?? 'Date not supplied', category, title: label, summary, details: '' });
    if (type === 'Condition') {
      const code = concept(raw.code, clean);
      if (code) {
        const clinicalStatus = status(raw, 'clinicalStatus'), verificationStatus = status(raw, 'verificationStatus');
        push('conditions', { id: publicId('condition', raw.id), name: code.label, code, status: clinicalStatus, verificationStatus, description: 'Coded condition in the Duke record; status is the source record status.' });
        event(code.label, `Coded condition. Source clinical status: ${clinicalStatus}; verification status: ${verificationStatus}.`, 'diagnosis');
      }
    } else if (type === 'AllergyIntolerance') {
      const code = concept(raw.code, clean);
      if (code) {
        const reactions = array(raw.reaction).flatMap(x => codedList(x?.manifestation, clean)).map(x => x.label).slice(0, 20);
        const severity = array(raw.reaction).map(x => x?.severity).filter(x => ['mild', 'moderate', 'severe'].includes(x));
        const clinicalStatus = status(raw, 'clinicalStatus');
        push('allergies', { id: publicId('allergy', raw.id), name: code.label, code, status: clinicalStatus, verificationStatus: status(raw, 'verificationStatus'), reactions, severity: [...new Set(severity)], criticality: ['low', 'high', 'unable-to-assess'].includes(raw.criticality) ? raw.criticality : 'not-supplied' });
        event(code.label, `Coded allergy/intolerance record. Source clinical status: ${clinicalStatus}.`, 'allergy');
      }
    } else if (type === 'Observation') {
      const groupCode = concept(raw.code, clean);
      const observations = [{ raw, code: groupCode, key: 'value' }, ...(Array.isArray(raw.component) ? raw.component : []).slice(0, 100).map((component, index) => ({ raw: component, code: concept(component.code, clean), key: `component-${index}` }))];
      for (const item of observations) {
        if (!item.code) continue;
        const value = observeValue(item.raw, clean); if (!value) continue;
        const interpretations = codedList(item.raw.interpretation ?? raw.interpretation, clean).map(x => x.label);
        const statusValue = status(raw);
        const componentId = `${raw.id}\0${item.key}\0${item.code.code}`;
        if (value.numeric) {
          const ranges = referenceRange(item.raw, clean), range = ranges[0];
          const flag = array(item.raw.interpretation ?? raw.interpretation).flatMap(x => array(x?.coding)).map(x => x?.code).find(x => ['H', 'HH', 'L', 'LL', 'A', 'N'].includes(x));
          push('labs', { id: publicId('observation', componentId), name: item.code.label, code: item.code, unit: value.numeric.unit, reference: range && range.low !== undefined && range.high !== undefined ? [range.low, range.high] : null, referenceRanges: ranges, status: statusValue, values: [{ date: d.date, value: value.numeric.value, flag: ['H', 'HH'].includes(flag) ? 'high' : ['L', 'LL'].includes(flag) ? 'low' : flag === 'A' ? 'abnormal' : '', ...(value.numeric.comparator ? { comparator: value.numeric.comparator } : {}), sourceIds: [sourceId], dateMeaning: d.dateMeaning, retrievedAt }], summary: `Structured Duke observation; source status: ${statusValue}.`, interpretations });
        } else {
          push('molecular', { id: publicId('coded-observation', componentId), name: item.code.label, code: item.code, category: 'Coded observation', value: value.coded.label, valueCode: value.coded, specimen: 'Not supplied in public projection', status: statusValue, meaning: 'Structured coded observation; no interpretation inferred.', interpretations });
        }
      }
    } else if (type === 'MedicationRequest') {
      let code = concept(raw.medicationCodeableConcept, clean);
      if (!code && typeof raw.medicationReference?.reference === 'string' && /^#[A-Za-z0-9.-]{1,64}$/.test(raw.medicationReference.reference)) {
        const medication = array(raw.contained).find(x => x?.resourceType === 'Medication' && `#${x.id}` === raw.medicationReference.reference && !modifier(x));
        code = concept(medication?.code, clean);
      }
      if (code) {
        const instructions = prescribedDose(raw, clean), prescribed = instructions.flatMap(x => x.doses ?? []).map(x => `${x.comparator ?? ''}${x.value}${x.unit ? ` ${x.unit}` : ''}`);
        const orderStatus = status(raw);
        push('treatments', { id: publicId('medication-order', raw.id), name: code.label, code, kind: 'Medication order', status: `Order status: ${orderStatus}`, orderStatus, intent: ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'].includes(raw.intent) ? raw.intent : 'not-supplied', start: d.date, dose: prescribed.length ? `Prescribed: ${prescribed.join('; ')}` : 'Prescribed dose not included', prescribedInstructions: instructions, summary: 'MedicationRequest is an order. It does not establish dispensing, administration, adherence, or a current dose taken.', events: ['Date refers to order authoring, not a dose given.'] });
        event(code.label, `Medication order; order status: ${orderStatus}. Administration and use are not established by this record.`, 'medication');
      }
    } else if (type === 'Procedure') {
      const code = concept(raw.code, clean);
      if (code) {
        const procedureStatus = status(raw), bodySites = codedList(raw.bodySite, clean).map(x => x.label);
        push('treatments', { id: publicId('procedure', raw.id), name: code.label, code, kind: 'Procedure record', status: procedureStatus, start: d.date, dose: '', summary: `Coded procedure record; source status: ${procedureStatus}.`, events: [], bodySites });
        event(code.label, `Coded procedure record. Source status: ${procedureStatus}.`, 'procedure');
      }
    } else if (type === 'DiagnosticReport') {
      const code = concept(raw.code, clean);
      if (code) {
        push('diagnostics', { id: publicId('diagnostic-report', raw.id), name: code.label, code, status: status(raw), categories: codedList(raw.category, clean).map(x => x.label), summary: 'Structured report metadata. Narrative conclusions, PDFs, images, and referenced result identifiers are not public.' });
        event(code.label, `Diagnostic report metadata; source status: ${status(raw)}. Narrative report body is excluded.`, 'test');
      }
    } else if (type === 'DocumentReference') {
      const code = concept(raw.type, clean);
      if (code) {
        const documentStatus = status(raw), clinicalStatus = typeof raw.docStatus === 'string' && STATUS.has(raw.docStatus) ? raw.docStatus : 'not-supplied';
        push('documents', { id: publicId('document', raw.id), name: code.label, code, status: documentStatus, documentStatus: clinicalStatus, indexedAt: date(raw.date), summary: 'Coded document metadata only. Provider titles, notes, attachment bytes, and links remain private.' });
        event(code.label, d.clinical ? 'Coded clinical document metadata. Date is the source clinical period start; document body is excluded.' : 'Coded clinical document metadata. Date is an indexing timestamp, not a clinical examination date; document body is excluded.', 'document');
      }
    }
    if (!emitted) { rejected('no-supported-coded-clinical-content'); continue; }
    if (d.clinical && d.date && (!latestClinicalDate || d.date > latestClinicalDate)) latestClinicalDate = d.date;
    byResourceType[type] = (byResourceType[type] ?? 0) + 1;
    additions.sources.push({ id: sourceId, title: `Duke structured ${type}`, date: d.date ?? retrievedAt, clinicalDate: d.clinical ? d.date : null, dateMeaning: d.dateMeaning, retrievedAt, type: 'provider-structured', note: type === 'MedicationRequest' ? 'Order metadata; no administration or adherence inferred.' : type === 'DocumentReference' ? 'Coded metadata; document body and source identifiers excluded.' : 'Allow-listed structured clinical fields; private source identifiers excluded.', excerpt: '', projectionOrigin: ORIGIN });
  }
  for (const section of SECTIONS) record[section].push(...additions[section].sort((a, b) => a.id.localeCompare(b.id)));
  const exclusions = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => ({ reason, count }));
  const sections = Object.fromEntries(SECTIONS.map(section => [section, additions[section].length]));
  const stats = { inputRecords: records.length, dukeRecords, patientBoundRecords, identityChecked, projectedResources: Object.values(byResourceType).reduce((a, b) => a + b, 0), projectedEntries: Object.entries(sections).filter(([key]) => key !== 'sources').reduce((sum, [, count]) => sum + count, 0), byResourceType, receivedByResourceType, sections, excludedRecords: exclusions.reduce((sum, item) => sum + item.count, 0), exclusionCounts: Object.fromEntries(counts), baselinePreserved: true, appleIncluded: false };
  return { record, stats, exclusions, latestClinicalDate, sourceSnapshotDigest: `sha256:${digest(additions)}` };
}
