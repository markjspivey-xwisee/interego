/** Method profiles are published data. This module projects and checks evidence coverage;
 * it neither selects an intervention nor certifies the quality of a referenced artifact. */
import { findSubjectsOfType, parseTrig, readIntegerValue, readStringValue,
  type IRI, type ParsedSubject } from '@interego/core';
import { AGP_NS, readMethodsTurtle } from './ontology.js';

const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const DCT = 'http://purl.org/dc/terms/';
export const METHOD_CONTEXT = {
  agp: AGP_NS, rdfs: RDFS, dct: DCT,
  token: 'agp:profileToken', intervention: 'agp:interventionToken',
  title: 'rdfs:label', description: 'rdfs:comment', version: 'dct:hasVersion',
  appliesWhen: 'agp:appliesWhen', sequence: 'agp:sequence', workProduct: 'agp:workProduct',
  entryStep: { '@id': 'agp:entryStep', '@type': '@id' },
  next: { '@id': 'agp:nextStep', '@type': '@id', '@container': '@set' },
  revisits: { '@id': 'agp:revisitsStep', '@type': '@id', '@container': '@set' },
  branches: { '@id': 'agp:branchesToMethod', '@type': '@id', '@container': '@set' },
  requires: { '@id': 'agp:requiresCriterion', '@type': '@id', '@container': '@set' },
  consultingProcess: { '@id': 'agp:consultingProcess', '@type': '@id' },
  source: { '@id': 'dct:source', '@type': '@id', '@container': '@set' },
  steps: { '@id': 'agp:hasStep', '@container': '@set' },
  criteria: { '@id': 'agp:requiresCriterion', '@container': '@set' },
  criterionResults: { '@id': 'agp:hasCriterionReview', '@container': '@set' },
  method: { '@id': 'agp:methodology', '@type': '@id' },
  status: 'agp:reviewStatus', coverage: 'agp:evidenceCoverage', verified: 'agp:qualityVerified',
  evidence: { '@id': 'agp:hasEvidence', '@container': '@set' },
  criterion: { '@id': 'agp:forCriterion', '@type': '@id' },
  artifact: { '@id': 'agp:evidenceArtifact', '@type': '@id' }, note: 'rdfs:comment',
};

export interface MethodCriterion {
  '@id': string; '@type': string; title: string; description: string;
  workProduct: string; source: string[];
}
export interface MethodStep {
  '@id': string; '@type': string; title: string; description: string; sequence: number;
  next: string[]; revisits: string[]; branches: string[]; requires: string[];
}
export interface InterventionMethod {
  '@id': string; '@type': string; token: string; intervention?: string;
  title: string; version: string; appliesWhen: string; entryStep: string;
  consultingProcess?: string; steps: MethodStep[]; criteria: MethodCriterion[];
}
export interface MethodReference { '@id': string; token: string; version: string }

const values = (s: ParsedSubject, predicate: string): string[] =>
  (s.properties.get(predicate as IRI) ?? []).flatMap(t => t.kind === 'iri' ? [String(t.iri)] : []);
const literal = (s: ParsedSubject, predicate: string): string => {
  const value = readStringValue(s, predicate as IRI);
  if (!value?.trim()) throw new Error(`Method data is missing ${predicate} on ${String(s.subject)}`);
  return value;
};

/** Strict loader: missing or ambiguous method data is a deployment defect, never a
 * reason to silently revert to a second, hidden table in code. */
export function loadInterventionMethods(turtle = readMethodsTurtle()): InterventionMethod[] {
  const doc = parseTrig(turtle);
  const subjects = new Map(doc.subjects.filter(s => typeof s.subject === 'string').map(s => [String(s.subject), s]));
  const resolve = (iri: string): ParsedSubject => {
    const s = subjects.get(iri);
    if (!s) throw new Error(`Unresolved method data link: ${iri}`);
    return s;
  };
  const criteria = (iri: string): MethodCriterion => {
    const s = resolve(iri);
    return { '@id': iri, '@type': 'agp:QualityCriterion', title: literal(s, `${RDFS}label`),
      description: literal(s, `${RDFS}comment`), workProduct: literal(s, `${AGP_NS}workProduct`),
      source: values(s, `${DCT}source`) };
  };
  const step = (iri: string): MethodStep => {
    const s = resolve(iri);
    const sequence = readIntegerValue(s, `${AGP_NS}sequence` as IRI);
    if (sequence === undefined || sequence < 1) throw new Error(`Invalid method step sequence: ${iri}`);
    const next = values(s, `${AGP_NS}nextStep`);
    const revisits = values(s, `${AGP_NS}revisitsStep`);
    const requires = values(s, `${AGP_NS}requiresCriterion`);
    [...next, ...revisits, ...requires].forEach(resolve);
    return { '@id': iri, '@type': 'agp:MethodStep', title: literal(s, `${RDFS}label`),
      description: literal(s, `${RDFS}comment`), sequence, next, revisits, requires,
      branches: values(s, `${AGP_NS}branchesToMethod`) };
  };
  const result = findSubjectsOfType(doc, `${AGP_NS}Methodology` as IRI).map(s => {
    const entryStep = values(s, `${AGP_NS}entryStep`)[0];
    const steps = values(s, `${AGP_NS}hasStep`).map(step).sort((a, b) => a.sequence - b.sequence);
    const requiredCriteria = values(s, `${AGP_NS}requiresCriterion`).map(criteria);
    if (!entryStep || !steps.some(x => x['@id'] === entryStep) || !requiredCriteria.length) {
      throw new Error(`Method needs an entry step and criteria: ${String(s.subject)}`);
    }
    const intervention = readStringValue(s, `${AGP_NS}interventionToken` as IRI);
    const consultingProcess = values(s, `${AGP_NS}consultingProcess`)[0];
    if (consultingProcess) resolve(consultingProcess);
    return { '@id': String(s.subject), '@type': intervention ? 'agp:InterventionMethodology' : 'agp:Methodology',
      token: literal(s, `${AGP_NS}profileToken`), title: literal(s, `${RDFS}label`),
      version: literal(s, `${DCT}hasVersion`), appliesWhen: literal(s, `${AGP_NS}appliesWhen`),
      entryStep, steps, criteria: requiredCriteria,
      ...(intervention ? { intervention } : {}), ...(consultingProcess ? { consultingProcess } : {}) };
  });
  if (!result.length || new Set(result.map(m => m.token)).size !== result.length) {
    throw new Error('Method data must contain unique method tokens');
  }
  const interventions = result.flatMap(m => m.intervention ? [m.intervention] : []);
  if (new Set(interventions).size !== interventions.length) throw new Error('Duplicate intervention method mapping');
  return result;
}

let cached: InterventionMethod[] | undefined;
/** Return a copy so a consumer cannot change future plans by mutating a response. */
export function interventionMethods(): InterventionMethod[] {
  cached ??= loadInterventionMethods();
  return structuredClone(cached);
}
export function findInterventionMethod(tokenOrIri: string): InterventionMethod | undefined {
  return interventionMethods().find(m => m.token === tokenOrIri || m['@id'] === tokenOrIri);
}
export function methodologyFor(intervention: string): MethodReference {
  const method = interventionMethods().find(m => m.intervention === intervention);
  if (!method) throw new Error(`No published methodology for intervention: ${intervention}`);
  return { '@id': method['@id'], token: method.token, version: method.version };
}
export function consultingMethodology(): MethodReference {
  const method = findInterventionMethod('consulting');
  if (!method) throw new Error('No published performance consulting process');
  return { '@id': method['@id'], token: method.token, version: method.version };
}

export class MethodEvidenceInputError extends Error {}
interface EvidencePointer { '@type': string; criterion: string; artifact: string; note: string }
function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new MethodEvidenceInputError(`${label} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}
function artifactIri(value: unknown): string {
  const iri = boundedString(value, 'artifact', 2048);
  let url: URL;
  try { url = new URL(iri); } catch { throw new MethodEvidenceInputError('artifact must be an absolute http, https or urn IRI'); }
  if (!['http:', 'https:', 'urn:'].includes(url.protocol) || url.username || url.password || /\s/.test(iri)) {
    throw new MethodEvidenceInputError('artifact must be an absolute http, https or urn IRI without credentials');
  }
  return iri;
}

/** A pointer with a note is documented evidence, not inspected evidence. Never fetches
 * URLs, writes records, authenticates an author or turns caller booleans into a pass. */
export function reviewMethodEvidence(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MethodEvidenceInputError('Expected { method, evidence }');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !['method', 'evidence'].includes(k))) throw new MethodEvidenceInputError('Only method and evidence are accepted; quality status is computed');
  const method = findInterventionMethod(boundedString(body.method, 'method', 2048));
  if (!method) throw new MethodEvidenceInputError('Unknown methodology; discover /performance/methods');
  const rows = body.evidence ?? [];
  if (!Array.isArray(rows) || rows.length > 200) throw new MethodEvidenceInputError('evidence must be an array with at most 200 entries');
  const evidence: EvidencePointer[] = rows.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new MethodEvidenceInputError('Each evidence entry must be an object');
    const e = row as Record<string, unknown>;
    if (Object.keys(e).some(k => !['criterion', 'artifact', 'note'].includes(k))) throw new MethodEvidenceInputError('Evidence accepts criterion, artifact and note only');
    const criterion = boundedString(e.criterion, 'criterion', 2048);
    if (!method.criteria.some(c => c['@id'] === criterion)) throw new MethodEvidenceInputError(`Unknown criterion for this method: ${criterion}`);
    return { '@type': 'agp:EvidenceItem', criterion, artifact: artifactIri(e.artifact), note: boundedString(e.note, 'note', 2000) };
  });
  const criterionResults = method.criteria.map(c => ({ '@type': 'agp:CriterionEvidenceReview', criterion: c['@id'],
    status: evidence.some(e => e.criterion === c['@id']) ? 'documented-unverified' : 'missing-evidence',
    evidence: evidence.filter(e => e.criterion === c['@id']) }));
  const documented = criterionResults.filter(c => c.status === 'documented-unverified').length;
  return { '@context': METHOD_CONTEXT, '@type': 'agp:MethodEvidenceReview', method: method['@id'], version: method.version,
    status: documented === criterionResults.length ? 'documented-unverified' : 'missing-evidence',
    coverage: Math.round(documented / criterionResults.length * 100), verified: false, criteria: method.criteria, criterionResults,
    note: 'Coverage checks evidence pointers and notes only. Artifact contents, method suitability, authorship, quality and performance effects have not been verified.' };
}
