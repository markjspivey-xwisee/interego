import { describe, expect, it } from 'vitest';
import { validateAgainstShape } from '@interego/core';
import { parseSignedJsonDocument } from '../../../integrations/application-runtime/application-lab-runtime.js';
import { createAgpHandlers } from '../bridge/handlers.js';
import { readShapesTurtle } from '../src/ontology.js';
import {
  preparePerformanceReadiness,
  verifyPerformanceReadinessDocument,
  type PerformanceReadinessDocument,
} from '../src/readiness-attestation.js';

const CANDIDATE = 'a'.repeat(64);
const SUITE = 'b'.repeat(64);
const base = {
  candidateDigest: CANDIDATE,
  regime: 'Knowable' as const,
  evaluationSuiteDigest: SUITE,
  totalCases: 8,
  passedCases: 8,
  diagnosisDescriptorUrl: 'https://pod.example/context-graphs/diagnosis.ttl',
  evaluationDescriptorUrls: ['https://pod.example/context-graphs/evaluation.ttl'],
  xapiStatementIds: ['urn:uuid:2d3f4f6e-23ec-4d03-9a40-516e36f8ed9e'],
  portableRecordDescriptorUrl: 'https://pod.example/context-graphs/learner-record.ttl',
  issuedAt: '2026-09-03T12:00:00.000Z',
};

describe('AGP performance-readiness evidence', () => {
  it('derives a ready, shape-valid document consumable by the generic Application Lab', () => {
    const prepared = preparePerformanceReadiness(base);
    expect(prepared.document.ready).toBe(true);
    expect(prepared.document.modalStatus).toBe('Asserted');
    expect(verifyPerformanceReadinessDocument(prepared.document).verified).toBe(true);
    const parsed = parseSignedJsonDocument(prepared.graphContent);
    expect(parsed.digestVerified).toBe(true);
    expect(parsed.documentType).toBe('agp-performance-readiness');
    expect(parsed.graphIri).toBe(`urn:graph:agp:performance-readiness:${CANDIDATE}`);
    expect(parsed.document).toEqual(prepared.document);
    const shacl = validateAgainstShape(prepared.graphContent, readShapesTurtle(), { entailment: 'rdfs' });
    expect(shacl.conforms, shacl.results.map(r => r.message).join(' | ')).toBe(true);
  });

  it('cannot be told that a failing candidate is ready', async () => {
    const handlers = createAgpHandlers();
    const out = await handlers['agp.prepare_readiness_evidence']!({
      candidate_digest: CANDIDATE,
      regime: 'Knowable',
      evaluation_suite_digest: SUITE,
      total_cases: 8,
      passed_cases: 7,
      issued_at: base.issuedAt,
      diagnosis_descriptor_url: base.diagnosisDescriptorUrl,
      evaluation_descriptor_urls: base.evaluationDescriptorUrls,
      xapi_statement_ids: base.xapiStatementIds,
      portable_record_descriptor_url: base.portableRecordDescriptorUrl,
      // Not a declared input and deliberately ignored by the decision function.
      ready: true,
    }) as Record<string, unknown>;
    expect(out.ready).toBe(false);
    expect(out.persisted).toBe(false);
    expect(out.publishRequired).toBe(true);
  });

  it('detects a decision bit changed after derivation', () => {
    const prepared = preparePerformanceReadiness(base);
    const tampered = { ...prepared.document, ready: false } as PerformanceReadinessDocument;
    expect(verifyPerformanceReadinessDocument(tampered)).toEqual({
      verified: false,
      reason: 'readiness decision was not derived from the declared rule',
    });
  });

  it('rejects a malformed rule even if its arithmetic would say ready', () => {
    const prepared = preparePerformanceReadiness(base);
    const malformed = {
      ...prepared.document,
      decisionRule: { minimumCases: -1, allowedFailures: 0 },
    } as PerformanceReadinessDocument;
    expect(verifyPerformanceReadinessDocument(malformed)).toEqual({
      verified: false,
      reason: 'minimumCases is not a positive integer',
    });
  });

  it('keeps the no-causality and no-infrastructure boundary inside the verified artifact', () => {
    const prepared = preparePerformanceReadiness(base);
    expect(prepared.graphContent).toContain('agp:explicitClaimNotMade');
    const overclaimed = {
      ...prepared.document,
      explicitClaimNotMade: 'Training caused the result and deployed the candidate.',
    } as PerformanceReadinessDocument;
    expect(verifyPerformanceReadinessDocument(overclaimed)).toEqual({
      verified: false,
      reason: 'required causal and infrastructure non-claim is missing or changed',
    });
  });
});
