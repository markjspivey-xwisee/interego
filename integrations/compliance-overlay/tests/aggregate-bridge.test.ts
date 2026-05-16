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
  buildCommitteeReconstructionComplianceDescriptor,
  buildCommitteeAuthorizationComplianceDescriptor,
  buildDistributionQueryComplianceDescriptor,
} from '../src/index.js';
import {
  buildCommittedContribution,
  buildAttestedHomomorphicSum,
  buildBucketedContribution,
  buildAttestedHomomorphicDistribution,
  buildAttestedAggregateResult,
  signBudgetAuditLog,
  signCommitteeReconstruction,
  signCommitteeAuthorization,
  EpsilonBudget,
  participationDescriptorIri,
  participationGraphIri,
  type ParticipationHit,
  type CommitteeReconstructionAttestation,
  type NumericBucketingScheme,
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

describe('compliance-aggregate bridge: v4-partial committee reconstruction attestation → compliance descriptor', () => {
  const bounds = { min: 0n, max: 100n };

  async function mkAttestation(): Promise<CommitteeReconstructionAttestation> {
    const contribs = [
      buildCommittedContribution({ contributorPodUrl: 'https://x/', value: 30n, bounds, blindingSeed: 'cx', blindingLabel: 'l' }),
      buildCommittedContribution({ contributorPodUrl: 'https://y/', value: 40n, bounds, blindingSeed: 'cy', blindingLabel: 'l' }),
    ];
    const bundle = buildAttestedHomomorphicSum({
      cohortIri: COHORT, aggregatorDid: AGGREGATOR,
      contributions: contribs, epsilon: 1.0,
      includeAuditFields: true,
      thresholdReveal: { n: 3, t: 2 },
    });
    const reconstructedAt = new Date().toISOString();
    const w1 = await createWallet('agent', 'comp-bridge-c1');
    const w2 = await createWallet('agent', 'comp-bridge-c2');
    const dids = [`did:ethr:${w1.address.toLowerCase()}` as IRI, `did:ethr:${w2.address.toLowerCase()}` as IRI];
    const sigs = [
      await signCommitteeReconstruction({
        bundleSumCommitment: bundle.sumCommitment.bytes,
        claimedTrueSum: bundle.trueSum!,
        committeeDids: dids,
        reconstructedAt,
        signerWallet: w1 as unknown as import('ethers').Wallet,
        signerDid: dids[0]!,
      }),
      await signCommitteeReconstruction({
        bundleSumCommitment: bundle.sumCommitment.bytes,
        claimedTrueSum: bundle.trueSum!,
        committeeDids: dids,
        reconstructedAt,
        signerWallet: w2 as unknown as import('ethers').Wallet,
        signerDid: dids[1]!,
      }),
    ];
    return {
      bundleSumCommitment: bundle.sumCommitment.bytes,
      claimedTrueSum: bundle.trueSum!,
      committeeDids: dids,
      reconstructedAt,
      signatures: sigs,
    };
  }

  it('embeds committee membership + sum-commitment + reconstructedAt; cites framework defaults', async () => {
    const attestation = await mkAttestation();
    const r = buildCommitteeReconstructionComplianceDescriptor({
      attestation,
      citation: { framework: 'soc2' },
    });
    expect(r.cited).toContain('soc2:CC6.1');
    expect(r.graphContent).toContain(attestation.bundleSumCommitment);
    expect(r.graphContent).toContain(attestation.reconstructedAt);
    expect(r.graphContent).toContain('\\"committeeSize\\":2');
    expect(r.graphContent).toContain('\\"signatureCount\\":2');
    // Both committee DIDs are recorded in the body.
    for (const did of attestation.committeeDids) {
      expect(r.graphContent).toContain(did);
    }
  });

  it('does NOT embed individual signatures in the descriptor body (live in pod artifact)', async () => {
    const attestation = await mkAttestation();
    const r = buildCommitteeReconstructionComplianceDescriptor({
      attestation,
      citation: { framework: 'eu-ai-act' },
    });
    // Signatures are 0x-prefixed 132-char hex; check at least one is absent.
    for (const sig of attestation.signatures) {
      expect(r.graphContent).not.toContain(sig.signature);
    }
  });

  it('default toolName is the committee-reveal tool', async () => {
    const attestation = await mkAttestation();
    const r = buildCommitteeReconstructionComplianceDescriptor({
      attestation,
      citation: { framework: 'nist-rmf' },
    });
    expect(r.graphContent).toContain('aggregate-privacy.committee-threshold-reveal');
  });
});

describe('compliance-aggregate bridge: v4-partial committee authorization → compliance descriptor', () => {
  it('embeds authorized DIDs + threshold + operator + issuedAt; cites framework defaults', async () => {
    const operatorWallet = await createWallet('agent', 'comp-bridge-auth-op');
    const operatorDid = `did:ethr:${operatorWallet.address.toLowerCase()}` as IRI;
    const dids = ['did:test:m1' as IRI, 'did:test:m2' as IRI, 'did:test:m3' as IRI];
    const authorization = await signCommitteeAuthorization({
      bundleSumCommitment: 'abcdef0123456789' + '00'.repeat(24),
      authorizedDids: dids,
      threshold: { n: 3, t: 2 },
      operatorDid,
      operatorWallet: operatorWallet as unknown as import('ethers').Wallet,
    });
    const r = buildCommitteeAuthorizationComplianceDescriptor({
      authorization,
      citation: { framework: 'eu-ai-act' },
    });
    expect(r.cited).toContain('eu-ai-act:Article12');
    expect(r.graphContent).toContain(authorization.bundleSumCommitment);
    expect(r.graphContent).toContain('\\"thresholdN\\":3');
    expect(r.graphContent).toContain('\\"thresholdT\\":2');
    expect(r.graphContent).toContain(operatorDid);
    for (const did of dids) {
      expect(r.graphContent).toContain(did);
    }
  });

  it('does NOT embed the signature in the descriptor body (lives in pod artifact)', async () => {
    const operatorWallet = await createWallet('agent', 'comp-bridge-auth-sig');
    const operatorDid = `did:ethr:${operatorWallet.address.toLowerCase()}` as IRI;
    const authorization = await signCommitteeAuthorization({
      bundleSumCommitment: 'fedcba9876543210' + '00'.repeat(24),
      authorizedDids: ['did:test:x' as IRI, 'did:test:y' as IRI],
      threshold: { n: 2, t: 2 },
      operatorDid,
      operatorWallet: operatorWallet as unknown as import('ethers').Wallet,
    });
    const r = buildCommitteeAuthorizationComplianceDescriptor({
      authorization,
      citation: { framework: 'soc2' },
    });
    expect(r.graphContent).not.toContain(authorization.signature);
  });

  it('default toolName is the committee-authorization tool', async () => {
    const operatorWallet = await createWallet('agent', 'comp-bridge-auth-tool');
    const operatorDid = `did:ethr:${operatorWallet.address.toLowerCase()}` as IRI;
    const authorization = await signCommitteeAuthorization({
      bundleSumCommitment: 'aa' + '00'.repeat(30),
      authorizedDids: ['did:test:p' as IRI, 'did:test:q' as IRI],
      threshold: { n: 2, t: 2 },
      operatorDid,
      operatorWallet: operatorWallet as unknown as import('ethers').Wallet,
    });
    const r = buildCommitteeAuthorizationComplianceDescriptor({
      authorization,
      citation: { framework: 'nist-rmf' },
    });
    expect(r.graphContent).toContain('aggregate-privacy.committee-authorization');
  });
});

describe('compliance-aggregate bridge: v3 zk-distribution → compliance descriptor', () => {
  const scheme: NumericBucketingScheme = {
    type: 'numeric',
    edges: [0n, 25n, 50n, 75n],
    maxValue: 100n,
  };

  const mkBundle = () => {
    const contribs = [10n, 30n, 60n, 70n, 80n].map((v, i) =>
      buildBucketedContribution({ contributorPodUrl: `https://l-${i}/`, value: v, scheme, blindingSeed: `s-${i}` }),
    );
    return buildAttestedHomomorphicDistribution({
      cohortIri: COHORT, aggregatorDid: AGGREGATOR,
      contributions: contribs, epsilon: 1.0, includeAuditFields: true,
    });
  };

  it('embeds per-bucket noisy counts + scheme + bucketSumCommitment bytes for auditor re-verification', () => {
    const bundle = mkBundle();
    const r = buildDistributionQueryComplianceDescriptor({
      bundle,
      queryArgs: { cohort_iri: COHORT, metric: 'score-distribution', privacy_mode: 'zk-distribution' },
      toolName: 'lpc.aggregate_cohort_query',
      citation: { framework: 'soc2' },
    });
    expect(r.cited).toContain('soc2:CC6.1');
    // Per-bucket noisy counts appear as JSON-escaped decimal strings in Turtle.
    for (const n of bundle.noisyBucketCounts) {
      expect(r.graphContent).toContain(n.toString());
    }
    // Scheme edges appear too.
    for (const e of bundle.scheme.edges) {
      expect(r.graphContent).toContain(e.toString());
    }
    // Bucket sum-commitment bytes — what the auditor needs for re-verification.
    for (const c of bundle.bucketSumCommitments) {
      expect(r.graphContent).toContain(c.bytes);
    }
    expect(r.graphContent).toContain('zk-distribution');
  });

  it('does NOT leak per-bucket trueBucketCounts / trueBucketBlindings (privacy boundary)', () => {
    const bundle = mkBundle();
    expect(bundle.trueBucketCounts).toBeDefined();
    const r = buildDistributionQueryComplianceDescriptor({
      bundle,
      queryArgs: { cohort_iri: COHORT, metric: 'score-distribution', privacy_mode: 'zk-distribution' },
      toolName: 'lpc.aggregate_cohort_query',
      citation: { framework: 'eu-ai-act' },
    });
    // Inside Turtle, JSON keys are backslash-escaped.
    expect(r.graphContent).not.toContain('\\"trueBucketCounts\\"');
    expect(r.graphContent).not.toContain('\\"trueBucketBlindings\\"');
  });

  it('all three frameworks have default control mappings for the distribution bridge', () => {
    const bundle = mkBundle();
    for (const framework of ['soc2', 'eu-ai-act', 'nist-rmf'] as const) {
      const r = buildDistributionQueryComplianceDescriptor({
        bundle,
        queryArgs: { cohort_iri: COHORT, metric: 'score-distribution' },
        toolName: 'lpc.aggregate_cohort_query',
        citation: { framework },
      });
      expect(r.cited.length).toBeGreaterThan(0);
    }
  });
});
