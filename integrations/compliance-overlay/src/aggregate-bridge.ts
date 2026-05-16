/**
 * Aggregate-privacy → compliance-overlay bridge.
 *
 * Composes the v3+ aggregate-privacy ladder (homomorphic Pedersen sum
 * + DP-Laplace noise + signed audit logs) with the compliance-overlay
 * AgentAction-shape so an operator's aggregate query becomes a
 * compliance-grade descriptor citing the relevant regulatory controls
 * — without leaking the underlying contributor values into the audit
 * trail.
 *
 * Substrate-pure: no new ontology terms; reuses the existing
 * FRAMEWORK_CONTROLS table for control IRIs and the existing
 * buildAgentActionDescriptor for the descriptor shape.
 *
 * Threat model the resulting descriptor addresses:
 *   - Regulator asks "show me that aggregate query you ran on Q2 2026
 *     learners". Operator points at the published compliance descriptor.
 *   - Auditor verifies the cited controls match the framework, the
 *     timestamps make sense, and the embedded sum-commitment / Merkle
 *     root / signed-audit-log match what was on the operator's pod
 *     at the time.
 *   - The descriptor body intentionally omits trueSum / individual
 *     contributions; the published value is the noisySum (the
 *     DP-protected aggregate) + structural attestation fields.
 */

import {
  buildAgentActionDescriptor,
  type ComplianceCitation,
  type BuildEventResult,
} from './overlay.js';
import type {
  AttestedHomomorphicSumResult,
  AttestedHomomorphicDistributionResult,
  AttestedAggregateResult,
  SignedBudgetAuditLog,
  CommitteeReconstructionAttestation,
  CommitteeAuthorization,
} from '../../../applications/_shared/aggregate-privacy/index.js';

/**
 * Map aggregate-privacy concerns onto canonical compliance controls.
 *
 *   - SOC 2 CC6.1 (Logical and Physical Access Controls): aggregate
 *     query is an access path; the privacy controls bound the
 *     information disclosure.
 *   - SOC 2 CC6.7 (Restriction of Transmission of Data): DP noise
 *     + opt-in restrict what crosses the trust boundary to the
 *     operator.
 *   - EU AI Act Article 10 (Data and data governance): documents
 *     how aggregate data is collected and processed.
 *   - EU AI Act Article 12 (Record-keeping): the descriptor IS the
 *     record.
 *   - NIST RMF MG-3.1 (Risk responses): the privacy boundary on the
 *     query is the operator's documented risk mitigation.
 *
 * Operators can override via the citation arg; this is the default
 * shape when only `framework` is supplied.
 */
function defaultAggregateControls(framework: ComplianceCitation['framework']): readonly string[] {
  switch (framework) {
    case 'soc2':       return ['soc2:CC6.1', 'soc2:CC6.7'];
    case 'eu-ai-act':  return ['eu-ai-act:Article10', 'eu-ai-act:Article12'];
    case 'nist-rmf':   return ['nist-rmf:MG-3.1'];
  }
}

/**
 * Wrap a v3+ AttestedHomomorphicSumResult as a compliance-grade
 * agent-action descriptor. The resulting descriptor cites the
 * framework's relevant controls, records the query's privacy mode
 * + epsilon + noisySum (the publishable value), and embeds the
 * sum-commitment + merkle root + signature material the auditor
 * needs to re-verify. trueSum + trueBlinding + individual
 * contributor commitments are NOT included — the descriptor is the
 * audit record, not the leakage surface.
 *
 * Composes with the rest of the compliance-overlay surface: the
 * descriptor flows through buildAgentActionDescriptor's standard
 * privacy preflight (which will block on HIGH-severity content in
 * the args / resultSummary — extra defense in depth).
 */
export function buildAggregateQueryComplianceDescriptor(args: {
  bundle: AttestedHomomorphicSumResult;
  queryArgs: Record<string, unknown>;
  toolName: string;
  citation: ComplianceCitation;
  startedAt?: string;
}): BuildEventResult {
  const cited: ComplianceCitation = {
    framework: args.citation.framework,
    controls: (args.citation.controls && args.citation.controls.length > 0
      ? args.citation.controls
      : defaultAggregateControls(args.citation.framework)) as ComplianceCitation['controls'],
  };

  // Redacted result summary — what an auditor needs to know without
  // any leakage of individual contributions. Specifically: count of
  // contributors, sensitivity, epsilon, noisySum, sumCommitment bytes
  // (the verifier can re-derive the rest from the published bundle).
  const resultSummary = JSON.stringify({
    privacyMode: args.bundle.privacyMode,
    contributorCount: args.bundle.contributorCount,
    noisySum: args.bundle.noisySum.toString(),
    sensitivity: args.bundle.sensitivity,
    epsilon: args.bundle.epsilon,
    sumCommitmentBytes: args.bundle.sumCommitment.bytes,
    cohortIri: args.bundle.cohortIri,
    computedAt: args.bundle.computedAt,
  });

  return buildAgentActionDescriptor({
    toolName: args.toolName,
    args: args.queryArgs,
    resultSummary,
    outcome: 'success',
    startedAt: args.startedAt ?? args.bundle.computedAt,
    endedAt: args.bundle.computedAt,
  }, cited);
}

/**
 * Wrap a v2 Merkle attestation (without homomorphic sum) as a
 * compliance descriptor. Less stringent privacy controls in the
 * citation defaults (the operator IS seeing per-contributor
 * descriptor URLs in a v2 bundle; the privacy boundary is opt-in
 * + Merkle attestation, not the homomorphic sum boundary).
 */
export function buildMerkleAttestationComplianceDescriptor(args: {
  attestation: AttestedAggregateResult;
  queryArgs: Record<string, unknown>;
  toolName: string;
  citation: ComplianceCitation;
  startedAt?: string;
}): BuildEventResult {
  const cited: ComplianceCitation = {
    framework: args.citation.framework,
    controls: (args.citation.controls && args.citation.controls.length > 0
      ? args.citation.controls
      : defaultAggregateControls(args.citation.framework)) as ComplianceCitation['controls'],
  };

  const resultSummary = JSON.stringify({
    privacyMode: args.attestation.privacyMode,
    count: args.attestation.count,
    merkleRoot: args.attestation.merkleRoot,
    cohortIri: args.attestation.cohortIri,
    computedAt: args.attestation.computedAt,
  });

  return buildAgentActionDescriptor({
    toolName: args.toolName,
    args: args.queryArgs,
    resultSummary,
    outcome: 'success',
    startedAt: args.startedAt ?? args.attestation.computedAt,
    endedAt: args.attestation.computedAt,
  }, cited);
}

/**
 * Wrap a v3.3 SignedBudgetAuditLog as a compliance descriptor. This is
 * the "we kept honest accounting on cumulative ε" audit record — the
 * operator can publish it alongside (or with cg:supersedes links from)
 * the aggregate-query descriptors so a regulator can replay the budget
 * consumption across the audit window.
 */
export function buildBudgetAuditComplianceDescriptor(args: {
  signed: SignedBudgetAuditLog;
  citation: ComplianceCitation;
  toolName?: string;
}): BuildEventResult {
  const cited: ComplianceCitation = {
    framework: args.citation.framework,
    controls: (args.citation.controls && args.citation.controls.length > 0
      ? args.citation.controls
      : defaultAggregateControls(args.citation.framework)) as ComplianceCitation['controls'],
  };

  const resultSummary = JSON.stringify({
    cohortIri: args.signed.snapshot.cohortIri,
    maxEpsilon: args.signed.snapshot.maxEpsilon,
    spent: args.signed.snapshot.spent,
    queriesRecorded: args.signed.snapshot.log.length,
    signerDid: args.signed.signerDid,
    signedAt: args.signed.signedAt,
  });

  return buildAgentActionDescriptor({
    toolName: args.toolName ?? 'aggregate-privacy.epsilon-budget-audit',
    args: { cohortIri: args.signed.snapshot.cohortIri, maxEpsilon: args.signed.snapshot.maxEpsilon },
    resultSummary,
    outcome: 'success',
    startedAt: args.signed.signedAt,
    endedAt: args.signed.signedAt,
  }, cited);
}

/**
 * Wrap a v4-partial CommitteeReconstructionAttestation as a compliance
 * descriptor. This is the "we kept chain-of-custody on the threshold
 * reveal" audit record — the operator publishes it alongside the
 * underlying AttestedHomomorphicSumBundle so a regulator can see WHO
 * participated in the reveal, WHEN, and on WHICH bundle.
 *
 * The descriptor body carries the committee composition + reconstructedAt
 * timestamp + the bundle's sum-commitment bytes (so the regulator can
 * link this attestation to a specific aggregate query) + the count
 * of signatures collected. Individual signatures are intentionally
 * NOT embedded in the descriptor body — they live in the published
 * CommitteeReconstructionAttestation pod artifact, which the regulator
 * can fetch separately via fetchPublishedCommitteeReconstructionAttestation.
 *
 * Default compliance citation pairs with the SOC 2 / EU AI Act / NIST
 * RMF controls already in defaultAggregateControls, since chain-of-
 * custody is part of the same access-and-record-keeping story as
 * the underlying aggregate query.
 */
export function buildCommitteeReconstructionComplianceDescriptor(args: {
  attestation: CommitteeReconstructionAttestation;
  citation: ComplianceCitation;
  toolName?: string;
}): BuildEventResult {
  const cited: ComplianceCitation = {
    framework: args.citation.framework,
    controls: (args.citation.controls && args.citation.controls.length > 0
      ? args.citation.controls
      : defaultAggregateControls(args.citation.framework)) as ComplianceCitation['controls'],
  };

  const resultSummary = JSON.stringify({
    bundleSumCommitment: args.attestation.bundleSumCommitment,
    claimedTrueSum: args.attestation.claimedTrueSum.toString(),
    committeeDids: [...args.attestation.committeeDids].sort(),
    committeeSize: args.attestation.committeeDids.length,
    signatureCount: args.attestation.signatures.length,
    reconstructedAt: args.attestation.reconstructedAt,
  });

  return buildAgentActionDescriptor({
    toolName: args.toolName ?? 'aggregate-privacy.committee-threshold-reveal',
    args: {
      bundleSumCommitment: args.attestation.bundleSumCommitment,
      reconstructedAt: args.attestation.reconstructedAt,
    },
    resultSummary,
    outcome: 'success',
    startedAt: args.attestation.reconstructedAt,
    endedAt: args.attestation.reconstructedAt,
  }, cited);
}

/**
 * Wrap a v4-partial CommitteeAuthorization as a compliance descriptor.
 * The operator's pre-reveal binding to a specific committee + threshold
 * is the audit record a regulator compares the actual reveal committee
 * against. Embeds bundleSumCommitment + sorted authorizedDids + (n, t)
 * + operatorDid + issuedAt; the signature itself is NOT embedded in the
 * descriptor body (it lives in the published pod artifact for
 * cryptographic re-verification — same pattern as the reconstruction
 * attestation bridge).
 *
 * Default toolName: `aggregate-privacy.committee-authorization`.
 */
export function buildCommitteeAuthorizationComplianceDescriptor(args: {
  authorization: CommitteeAuthorization;
  citation: ComplianceCitation;
  toolName?: string;
}): BuildEventResult {
  const cited: ComplianceCitation = {
    framework: args.citation.framework,
    controls: (args.citation.controls && args.citation.controls.length > 0
      ? args.citation.controls
      : defaultAggregateControls(args.citation.framework)) as ComplianceCitation['controls'],
  };

  const resultSummary = JSON.stringify({
    bundleSumCommitment: args.authorization.bundleSumCommitment,
    authorizedDids: [...args.authorization.authorizedDids].sort(),
    authorizedCount: args.authorization.authorizedDids.length,
    thresholdN: args.authorization.threshold.n,
    thresholdT: args.authorization.threshold.t,
    operatorDid: args.authorization.operatorDid,
    issuedAt: args.authorization.issuedAt,
  });

  return buildAgentActionDescriptor({
    toolName: args.toolName ?? 'aggregate-privacy.committee-authorization',
    args: {
      bundleSumCommitment: args.authorization.bundleSumCommitment,
      thresholdN: args.authorization.threshold.n,
      thresholdT: args.authorization.threshold.t,
    },
    resultSummary,
    outcome: 'success',
    startedAt: args.authorization.issuedAt,
    endedAt: args.authorization.issuedAt,
  }, cited);
}

/**
 * Wrap a v3 zk-distribution AttestedHomomorphicDistributionResult as
 * a compliance-grade descriptor. Same shape as the sum-bundle wrapper:
 * cites the framework's relevant controls, embeds the publishable
 * fields (per-bucket noisy counts + per-bucket sum-commitments +
 * scheme + epsilon + cohort + contributor count), explicitly OMITS
 * the trueBucketCounts / trueBucketBlindings audit fields from the
 * descriptor body (they're private — published only when the
 * operator's full bundle JSON is opened by an authorized auditor).
 *
 * Default toolName: `aggregate-privacy.distribution-query`.
 */
export function buildDistributionQueryComplianceDescriptor(args: {
  bundle: AttestedHomomorphicDistributionResult;
  queryArgs: Record<string, unknown>;
  toolName: string;
  citation: ComplianceCitation;
  startedAt?: string;
}): BuildEventResult {
  const cited: ComplianceCitation = {
    framework: args.citation.framework,
    controls: (args.citation.controls && args.citation.controls.length > 0
      ? args.citation.controls
      : defaultAggregateControls(args.citation.framework)) as ComplianceCitation['controls'],
  };

  const resultSummary = JSON.stringify({
    privacyMode: args.bundle.privacyMode,
    contributorCount: args.bundle.contributorCount,
    bucketCount: args.bundle.bucketSumCommitments.length,
    noisyBucketCounts: args.bundle.noisyBucketCounts.map(n => n.toString()),
    schemeEdges: args.bundle.scheme.edges.map(e => e.toString()),
    schemeMaxValue: args.bundle.scheme.maxValue.toString(),
    bucketSumCommitmentBytes: args.bundle.bucketSumCommitments.map(c => c.bytes),
    epsilon: args.bundle.epsilon,
    cohortIri: args.bundle.cohortIri,
    computedAt: args.bundle.computedAt,
  });

  return buildAgentActionDescriptor({
    toolName: args.toolName,
    args: args.queryArgs,
    resultSummary,
    outcome: 'success',
    startedAt: args.startedAt ?? args.bundle.computedAt,
    endedAt: args.bundle.computedAt,
  }, cited);
}
