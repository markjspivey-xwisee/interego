/**
 * Performance-readiness evidence prepared by the AGP vertical.
 *
 * This is deliberately a PREPARER, not a publisher and not a signer. AGP owns
 * the performance decision; the Interego agent that accepts it must publish the
 * returned graph through the ordinary signed descriptor path. The Application
 * Lab then verifies that descriptor, its signer, current head, JSON digest and
 * replay binding without importing AGP or FOXXI.
 */
import { createHash } from 'node:crypto';
import { canonicalJson, turtleIriRef } from '@interego/core';
import type { WorkRegime } from './agent-disposition.js';

export const AGP_READINESS_DOCUMENT_TYPE = 'agp-performance-readiness';
export const AGP_READINESS_SCHEMA = 'agp.performance-readiness/v1';
export const AGP_READINESS_SHAPE = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp/shapes#PerformanceReadinessAttestationShape';
export const AGP_READINESS_EXPLICIT_NON_CLAIM = 'This attestation does not deploy infrastructure and does not claim that training caused the observed result.';

const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const PROV = 'http://www.w3.org/ns/prov#';
const DCT = 'http://purl.org/dc/terms/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export interface PrepareReadinessInput {
  readonly candidateDigest: string;
  readonly regime: WorkRegime;
  readonly evaluationSuiteDigest: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly diagnosisDescriptorUrl: string;
  readonly evaluationDescriptorUrls: readonly string[];
  readonly xapiStatementIds: readonly string[];
  readonly portableRecordDescriptorUrl: string;
  readonly issuedAt: string;
  readonly minimumCases?: number;
  readonly allowedFailures?: number;
}

export interface PerformanceReadinessDocument {
  readonly schema: typeof AGP_READINESS_SCHEMA;
  readonly subjectDigest: string;
  readonly ready: boolean;
  readonly modalStatus: 'Hypothetical' | 'Asserted';
  readonly regime: WorkRegime;
  readonly issuedAt: string;
  readonly decisionRule: { readonly minimumCases: number; readonly allowedFailures: number };
  readonly heldOutEvaluation: {
    readonly suiteDigest: string;
    readonly totalCases: number;
    readonly passedCases: number;
    readonly failedCases: number;
  };
  readonly consultingEvidence: {
    readonly diagnosisDescriptorUrl: string;
    readonly evaluationDescriptorUrls: readonly string[];
  };
  readonly standardsEvidence: {
    readonly xapiStatementIds: readonly string[];
    readonly lerDescriptorUrl: string;
  };
  readonly explicitClaimNotMade: string;
}

export interface PreparedReadinessEvidence {
  readonly graphIri: string;
  readonly documentType: typeof AGP_READINESS_DOCUMENT_TYPE;
  readonly document: PerformanceReadinessDocument;
  readonly canonical: string;
  readonly documentDigest: string;
  readonly graphContent: string;
}

const HEX_256 = /^[0-9a-f]{64}$/i;
const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function requireDigest(value: string, field: string): string {
  if (!HEX_256.test(value)) throw new Error(`${field} must be a 64-hex SHA-256 digest`);
  return value.toLowerCase();
}

function requireIri(value: string, field: string): string {
  if (!ABSOLUTE_IRI.test(value) || turtleIriRef(value) === null) throw new Error(`${field} must be a safe absolute IRI`);
  return value;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

function iri(value: string): string {
  const ref = turtleIriRef(value);
  if (ref === null) throw new Error(`unsafe IRI: ${value}`);
  return ref;
}

/** Build a deterministic, typed evidence graph. `ready` is always derived. */
export function preparePerformanceReadiness(input: PrepareReadinessInput): PreparedReadinessEvidence {
  const candidateDigest = requireDigest(input.candidateDigest, 'candidateDigest');
  const suiteDigest = requireDigest(input.evaluationSuiteDigest, 'evaluationSuiteDigest');
  const minimumCases = input.minimumCases ?? 4;
  const allowedFailures = input.allowedFailures ?? 0;
  if (!['Evident', 'Knowable', 'Emergent', 'Turbulent'].includes(input.regime)) throw new Error('regime must be Evident, Knowable, Emergent, or Turbulent');
  if (!Number.isSafeInteger(minimumCases) || minimumCases < 1) throw new Error('minimumCases must be a positive integer');
  if (!Number.isSafeInteger(allowedFailures) || allowedFailures < 0) throw new Error('allowedFailures must be a non-negative integer');
  if (!Number.isSafeInteger(input.totalCases) || input.totalCases < 0) throw new Error('totalCases must be a non-negative integer');
  if (!Number.isSafeInteger(input.passedCases) || input.passedCases < 0 || input.passedCases > input.totalCases) {
    throw new Error('passedCases must be an integer between zero and totalCases');
  }
  if (!Number.isFinite(Date.parse(input.issuedAt))) throw new Error('issuedAt must be an ISO-8601 timestamp');
  const diagnosisDescriptorUrl = requireIri(input.diagnosisDescriptorUrl, 'diagnosisDescriptorUrl');
  if (input.evaluationDescriptorUrls.length === 0) throw new Error('at least one evaluation descriptor is required');
  const evaluationDescriptorUrls = input.evaluationDescriptorUrls.map((x, i) => requireIri(x, `evaluationDescriptorUrls[${i}]`));
  if (input.xapiStatementIds.length === 0) throw new Error('at least one xAPI statement IRI is required');
  const xapiStatementIds = input.xapiStatementIds.map((x, i) => requireIri(x, `xapiStatementIds[${i}]`));
  const lerDescriptorUrl = requireIri(input.portableRecordDescriptorUrl, 'portableRecordDescriptorUrl');
  const failedCases = input.totalCases - input.passedCases;
  const enoughEvidence = input.totalCases >= minimumCases;
  const ready = enoughEvidence && failedCases <= allowedFailures;
  const document: PerformanceReadinessDocument = {
    schema: AGP_READINESS_SCHEMA,
    subjectDigest: candidateDigest,
    ready,
    modalStatus: enoughEvidence ? 'Asserted' : 'Hypothetical',
    regime: input.regime,
    issuedAt: new Date(input.issuedAt).toISOString(),
    decisionRule: { minimumCases, allowedFailures },
    heldOutEvaluation: {
      suiteDigest,
      totalCases: input.totalCases,
      passedCases: input.passedCases,
      failedCases,
    },
    consultingEvidence: { diagnosisDescriptorUrl, evaluationDescriptorUrls },
    standardsEvidence: { xapiStatementIds, lerDescriptorUrl },
    explicitClaimNotMade: AGP_READINESS_EXPLICIT_NON_CLAIM,
  };
  const canonical = canonicalJson(document);
  const documentDigest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const graphIri = `urn:graph:agp:performance-readiness:${candidateDigest}`;
  const subject = `${graphIri}#attestation`;
  const jsonBase64 = Buffer.from(canonical, 'utf8').toString('base64');
  const derivedFrom = [diagnosisDescriptorUrl, ...evaluationDescriptorUrls, ...xapiStatementIds, lerDescriptorUrl];
  const graphContent = [
    '@prefix ia: <urn:interego:application:> .',
    `@prefix agp: ${iri(AGP)} .`,
    `@prefix iep: ${iri(IEP)} .`,
    `@prefix dct: ${iri(DCT)} .`,
    `@prefix prov: ${iri(PROV)} .`,
    `@prefix xsd: ${iri(XSD)} .`,
    '',
    `${iri(graphIri)} {`,
    `  ${iri(graphIri)} a ia:SignedJsonDocument ;`,
    '    ia:format "canonical-json/v1" ;',
    `    ia:documentType ${literal(AGP_READINESS_DOCUMENT_TYPE)} ;`,
    `    ia:sha256 ${literal(documentDigest)} ;`,
    `    ia:jsonBase64 ${literal(jsonBase64)} .`,
    '',
    `  ${iri(subject)} a agp:PerformanceReadinessAttestation ;`,
    `    dct:conformsTo ${iri(AGP_READINESS_SHAPE)} ;`,
    `    agp:subjectDigest ${literal(candidateDigest)} ;`,
    `    agp:readinessDecision ${literal(String(ready))}^^xsd:boolean ;`,
    `    agp:evaluatedRegime ${iri(`${AGP}${input.regime}`)} ;`,
    `    agp:evaluationSuiteDigest ${literal(suiteDigest)} ;`,
    `    agp:heldOutCases ${literal(String(input.totalCases))}^^xsd:nonNegativeInteger ;`,
    `    agp:passedCases ${literal(String(input.passedCases))}^^xsd:nonNegativeInteger ;`,
    `    agp:failedCases ${literal(String(failedCases))}^^xsd:nonNegativeInteger ;`,
    `    agp:minimumCases ${literal(String(minimumCases))}^^xsd:nonNegativeInteger ;`,
    `    agp:allowedFailures ${literal(String(allowedFailures))}^^xsd:nonNegativeInteger ;`,
    `    agp:portableRecord ${iri(lerDescriptorUrl)} ;`,
    `    agp:explicitClaimNotMade ${literal(AGP_READINESS_EXPLICIT_NON_CLAIM)} ;`,
    `    iep:modalStatus ${iri(`${IEP}${document.modalStatus}`)} ;`,
    `    prov:generatedAtTime ${literal(document.issuedAt)}^^xsd:dateTime ;`,
    `    prov:wasDerivedFrom ${derivedFrom.map(iri).join(', ')} .`,
    '}',
    '',
  ].join('\n');
  return { graphIri, documentType: AGP_READINESS_DOCUMENT_TYPE, document, canonical, documentDigest, graphContent };
}

/** Re-derive the decision in an independently parsed document. */
export function verifyPerformanceReadinessDocument(document: PerformanceReadinessDocument): { verified: boolean; reason: string } {
  try {
    if (document.schema !== AGP_READINESS_SCHEMA) return { verified: false, reason: 'schema mismatch' };
    requireDigest(document.subjectDigest, 'subjectDigest');
    requireDigest(document.heldOutEvaluation.suiteDigest, 'heldOutEvaluation.suiteDigest');
    if (!['Evident', 'Knowable', 'Emergent', 'Turbulent'].includes(document.regime)) {
      return { verified: false, reason: 'regime is not recognized' };
    }
    if (!Number.isFinite(Date.parse(document.issuedAt))) return { verified: false, reason: 'issuedAt is not an ISO-8601 timestamp' };
    if (!Number.isSafeInteger(document.decisionRule.minimumCases) || document.decisionRule.minimumCases < 1) {
      return { verified: false, reason: 'minimumCases is not a positive integer' };
    }
    if (!Number.isSafeInteger(document.decisionRule.allowedFailures) || document.decisionRule.allowedFailures < 0) {
      return { verified: false, reason: 'allowedFailures is not a non-negative integer' };
    }
    if (!Number.isSafeInteger(document.heldOutEvaluation.totalCases) || document.heldOutEvaluation.totalCases < 0
      || !Number.isSafeInteger(document.heldOutEvaluation.passedCases) || document.heldOutEvaluation.passedCases < 0
      || document.heldOutEvaluation.passedCases > document.heldOutEvaluation.totalCases
      || !Number.isSafeInteger(document.heldOutEvaluation.failedCases) || document.heldOutEvaluation.failedCases < 0) {
      return { verified: false, reason: 'held-out case counts are invalid' };
    }
    const expectedFailures = document.heldOutEvaluation.totalCases - document.heldOutEvaluation.passedCases;
    const enough = document.heldOutEvaluation.totalCases >= document.decisionRule.minimumCases;
    const expectedReady = enough && expectedFailures <= document.decisionRule.allowedFailures;
    if (expectedFailures !== document.heldOutEvaluation.failedCases) return { verified: false, reason: 'failed-case arithmetic mismatch' };
    if (document.ready !== expectedReady) return { verified: false, reason: 'readiness decision was not derived from the declared rule' };
    if (document.modalStatus !== (enough ? 'Asserted' : 'Hypothetical')) return { verified: false, reason: 'modal status does not match evidence sufficiency' };
    if (document.explicitClaimNotMade !== AGP_READINESS_EXPLICIT_NON_CLAIM) {
      return { verified: false, reason: 'required causal and infrastructure non-claim is missing or changed' };
    }
    requireIri(document.consultingEvidence.diagnosisDescriptorUrl, 'diagnosisDescriptorUrl');
    if (!document.consultingEvidence.evaluationDescriptorUrls.length || !document.standardsEvidence.xapiStatementIds.length) {
      return { verified: false, reason: 'evidence references are incomplete' };
    }
    for (const x of document.consultingEvidence.evaluationDescriptorUrls) requireIri(x, 'evaluationDescriptorUrl');
    for (const x of document.standardsEvidence.xapiStatementIds) requireIri(x, 'xapiStatementId');
    requireIri(document.standardsEvidence.lerDescriptorUrl, 'lerDescriptorUrl');
    return { verified: true, reason: expectedReady ? 'readiness rule passes' : 'valid evidence states not ready' };
  } catch (err) {
    return { verified: false, reason: (err as Error).message };
  }
}
