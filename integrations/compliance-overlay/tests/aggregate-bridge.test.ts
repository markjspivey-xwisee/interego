/**
 * Compliance-overlay × aggregate-privacy bridge — contract tests.
 *
 * Pins the composition so a regression in either layer (the
 * aggregate-privacy bundle shape OR the compliance-overlay
 * descriptor shape) surfaces as a failing test, not as a silent
 * compliance hole.
 *
 * The bridge ships three wrappers (v3+ homomorphic sum / v2 Merkle /
 * v3.3 signed budget log → compliance-grade descriptor). For each:
 *
 *   1. The descriptor cites the framework's default controls when
 *      the caller doesn't override.
 *   2. The descriptor cites the caller's explicit controls when
 *      supplied.
 *   3. The resultSummary embeds the privacy attestation material
 *      (sum-commitment / Merkle root / signedAt) so an auditor can
 *      re-verify against the published bundle.
 *   4. The resultSummary does NOT leak trueSum / trueBlinding /
 *      individual contributor commitments — those are the values
 *      the privacy ladder explicitly hides.
 */

import { describe, it, expect } from 'vitest';
import {
  buildAggregateQueryComplianceDescriptor,
  buildMerkleAttestationComplianceDescriptor,
  buildBudgetAuditComplianceDescriptor,
} from '../src/index.js';
import {
  buildCommittedContribution,
  buildAttestedHomomorphicSum,
  buildAttestedAggregateResult,
  signBudgetAuditLog,
  EpsilonBudget,
  participationDescriptorIri,
  participationGraphIri,
  type ParticipationHit,
} from '../../../applications/_shared/aggregate-privacy/index.js';
import { createWallet } from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';

const COHORT = 'urn:test:cohort:bridge' as IRI;
const AGGREGATOR = 'did:web:operator.example' as IRI;

describe('compliance-aggregate bridge: v3 homomorphic sum → compliance descriptor', () => {
  const bounds = { min: 0n, max: 100n };
  const mkBundle = () => {
    const contribs = [
      buildCommittedContribution({ contributorPodUrl: 'https://a/', value: 30n, bounds, blindingSeed: 'a', blindingLabel: 'l' }),
      buildCommittedContribution({ contributorPodUrl: 'https://b/', value: 40n, bounds, blindingSeed: 'b', blindingLabel: 'l' }),
    ];
    return buildAttestedHomomorphicSum({
      cohortIri: COHORT, aggregatorDid: AGGREGATOR,
      contributions: contribs, epsilon: 1.0, includeAuditFields: true,
    });
  };

  it('cites framework default controls when caller does not override', () => {
    const bundle = mkBundle();
    const r = buildAggregateQueryComplianceDescriptor({
      bundle,
      queryArgs: { cohort_iri: COHORT, metric: 'completion-count' },
      toolName: 'lpc.aggregate_cohort_query',
      citation: { framework: 'soc2' },
    });
    expect(r.cited).toContain('soc2:CC6.1');
    expect(r.cited).toContain('soc2:CC6.7');
  });

  it('cites caller-supplied controls when present', () => {
    const bundle = mkBundle();
    const r = buildAggregateQueryComplianceDescriptor({
      bundle,
      queryArgs: { cohort_iri: COHORT, metric: 'completion-count' },
      toolName: 'lpc.aggregate_cohort_query',
      citation: { framework: 'eu-ai-act', controls: ['eu-ai-act:Article15'] as readonly IRI[] },
    });
    expect(r.cited).toEqual(['eu-ai-act:Article15']);
  });

  it('embeds the attestation material in the descriptor for auditor re-verification', () => {
    const bundle = mkBundle();
    const r = buildAggregateQueryComplianceDescriptor({
      bundle,
      queryArgs: { cohort_iri: COHORT, metric: 'completion-count' },
      toolName: 'lpc.aggregate_cohort_query',
      citation: { framework: 'soc2' },
    });
    // The graph TTL carries the resultSummary inline; check for the
    // material an auditor would need.
    expect(r.graphContent).toContain(bundle.sumCommitment.bytes);
    expect(r.graphContent).toContain(String(bundle.contributorCount));
    expect(r.graphContent).toContain(bundle.noisySum.toString());
  });

  it('does NOT leak trueSum / trueBlinding (privacy boundary)', () => {
    const bundle = mkBundle();
    expect(bundle.trueSum).toBe(70n); // sanity — bundle DOES contain it
    const r = buildAggregateQueryComplianceDescriptor({
      bundle,
      queryArgs: { cohort_iri: COHORT, metric: 'completion-count' },
      toolName: 'lpc.aggregate_cohort_query',
      citation: { framework: 'soc2' },
    });
    // The descriptor's graph must not contain trueSum / trueBlinding
    // — those are the private aggregator-side values; the descriptor
    // is the audit record + must publish only the noisy aggregate.
    // Inside Turtle, JSON keys appear as escaped \"…\".
    expect(r.graphContent).not.toContain('\\"trueSum\\"');
    expect(r.graphContent).not.toContain('\\"trueBlinding\\"');
    // The graph SHOULD contain the noisy sum — that's the publishable
    // value.
    expect(r.graphContent).toContain(bundle.noisySum.toString());
  });

  it('all three frameworks have default control mappings', () => {
    const bundle = mkBundle();
    for (const framework of ['soc2', 'eu-ai-act', 'nist-rmf'] as const) {
      const r = buildAggregateQueryComplianceDescriptor({
        bundle,
        queryArgs: { cohort_iri: COHORT, metric: 'completion-count' },
        toolName: 'lpc.aggregate_cohort_query',
        citation: { framework },
      });
      expect(r.cited.length).toBeGreaterThan(0);
    }
  });
});

describe('compliance-aggregate bridge: v2 Merkle attestation → compliance descriptor', () => {
  const mkParticipations = (): ParticipationHit[] => ([
    { podUrl: 'https://x/', descriptorIri: participationDescriptorIri(COHORT, 'did:test:x' as IRI), descriptorUrl: 'https://x/d.ttl', graphIri: participationGraphIri(COHORT, 'did:test:x' as IRI), modalStatus: 'Asserted' },
    { podUrl: 'https://y/', descriptorIri: participationDescriptorIri(COHORT, 'did:test:y' as IRI), descriptorUrl: 'https://y/d.ttl', graphIri: participationGraphIri(COHORT, 'did:test:y' as IRI), modalStatus: 'Asserted' },
  ]);

  it('embeds the Merkle root + count in the resultSummary', () => {
    const attestation = buildAttestedAggregateResult({
      cohortIri: COHORT, aggregatorDid: AGGREGATOR, participations: mkParticipations(), value: 2,
    });
    const r = buildMerkleAttestationComplianceDescriptor({
      attestation,
      queryArgs: { cohort_iri: COHORT, metric: 'completion-count', privacy_mode: 'merkle-attested-opt-in' },
      toolName: 'lpc.aggregate_cohort_query',
      citation: { framework: 'eu-ai-act' },
    });
    expect(r.graphContent).toContain(attestation.merkleRoot);
    // Inside Turtle, JSON quotes are backslash-escaped.
    expect(r.graphContent).toContain('\\"count\\":2');
  });
});

describe('compliance-aggregate bridge: v3.3 signed budget audit log → compliance descriptor', () => {
  it('embeds the budget snapshot + signer DID; cites the framework defaults', async () => {
    const budget = new EpsilonBudget({ cohortIri: COHORT, maxEpsilon: 1.0 });
    budget.consume({ queryDescription: 'q1', epsilon: 0.3 });
    budget.consume({ queryDescription: 'q2', epsilon: 0.4 });
    const wallet = await createWallet('agent', 'audit-bridge');
    const signerDid = `did:ethr:${wallet.address}` as IRI;
    const signed = await signBudgetAuditLog({ budget, signerWallet: wallet, signerDid });
    const r = buildBudgetAuditComplianceDescriptor({
      signed,
      citation: { framework: 'soc2' },
    });
    expect(r.graphContent).toContain('\\"spent\\":0.7');
    expect(r.graphContent).toContain('\\"queriesRecorded\\":2');
    expect(r.graphContent).toContain(signerDid);
    expect(r.cited).toContain('soc2:CC6.1');
  });

  it('default toolName is the budget-audit tool', () => {
    const budget = new EpsilonBudget({ cohortIri: COHORT, maxEpsilon: 1.0 });
    budget.consume({ queryDescription: 'q', epsilon: 0.1 });
    // Don't need a real signature for the descriptor structure test —
    // construct a minimal signed bundle manually.
    const signed = {
      snapshot: budget.toJSON(),
      signerDid: 'did:test:operator' as IRI,
      signature: '0x' + '00'.repeat(65),
      signedAt: new Date().toISOString(),
    };
    const r = buildBudgetAuditComplianceDescriptor({
      signed,
      citation: { framework: 'nist-rmf' },
    });
    expect(r.graphContent).toContain('aggregate-privacy.epsilon-budget-audit');
  });
});
