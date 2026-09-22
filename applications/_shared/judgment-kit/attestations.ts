/**
 * Attestations as the registry aggregates them: the record a vertical reads off its pod, the
 * mapping to the registry's input, and the policy that weighs a grounded self-attestation at a
 * quarter of a peer's word. Moved here from the harness on 2026-09-22 so Foxxi's content
 * judgments earn a reputation the same way. Each vertical keeps its own reader (the harness
 * parses amta triples out of TriG, Foxxi decodes a JSON entity) and its own policy id.
 */
import type { IRI } from '@interego/core';
import { aggregateReputation, type AggregationPolicy, type AttestationInput, type ReputationSnapshot } from '@interego/registry';

export const RATED_AXES = ['competence', 'accuracy', 'relevance', 'honesty', 'recency'] as const;

export interface Attestation {
  readonly descriptorUrl: string;
  readonly attestor: string;
  readonly subject: string;
  /** Self (the agent rating its own work, grounded) or Peer (another party). */
  readonly direction: string;
  readonly axes: Readonly<Record<string, number>>;
  readonly attestedAt: string;
  /** The execution evidence the ratings were derived from; required for the attestation to count. */
  readonly fromExecution: string;
  readonly samples?: number;
}

/** The weights every vertical uses: a grounded self-attestation counts at a quarter of a peer's word, a high-assurance one in full. */
export function reputationPolicy(policyId: string): AggregationPolicy {
  return { trustWeights: { HighAssurance: 1, PeerAttested: 0.5, SelfAsserted: 0.25 }, recencyHalfLifeDays: 30, minContributingAttestations: 1, policyId };
}

/** The registry's input for an attestation: a self-attestation is SelfAsserted, anything else a peer's word. */
export function toAttestationInput(a: Attestation): AttestationInput {
  return {
    id: a.descriptorUrl as IRI,
    issuer: a.attestor as IRI,
    subject: a.subject as IRI,
    axes: a.axes,
    issuedAt: a.attestedAt,
    issuerTrustLevel: a.direction === 'Self' ? 'SelfAsserted' : 'PeerAttested',
  };
}

/** The snapshot the registry computes for `subject` from the attestations about it, or null when none contributes. */
export function reputationOf(subject: string, attestations: readonly Attestation[], policy: AggregationPolicy, now?: string): ReputationSnapshot | null {
  return aggregateReputation(subject as IRI, attestations.map(toAttestationInput), policy, now ?? new Date().toISOString());
}
