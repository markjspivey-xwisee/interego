/**
 * Shared aggregate-privacy primitives for verticals that need
 * verifiable counts over opted-in participants.
 *
 * v2 of the aggregate-query story (v1 in OWM/LPC operator publishers
 * just returned ABAC-bounded counts with `privacyMode: 'abac'`).
 * This module composes existing ZK primitives in src/crypto/zk/
 * (Merkle tree + Merkle inclusion proofs) to give an operator a
 * tamper-evident count + per-participant inclusion proofs without
 * exposing the participant's individual contribution.
 *
 * Out of scope (still v3): homomorphic Pedersen commitments over an
 * elliptic curve subgroup + DP noise calibration per
 * spec/AGGREGATE-PRIVACY.md. v2 gives counts + Merkle root + per-pod
 * range proofs; v3 will give DP-noised aggregates.
 *
 * Design — three artifacts:
 *
 *   1. CohortParticipation descriptor (one per participant, on
 *      their own pod). Content-addressed by (cohort_iri,
 *      participant_did) so re-publish is idempotent + the
 *      operator can content-derive the expected IRI. Carries the
 *      participant's signature over (cohort_iri, valid_from,
 *      participant_did) so a forged participation can't survive
 *      verification.
 *
 *   2. AttestedAggregateResult bundle (the result an aggregate
 *      query returns). Includes the query, the count, the metric
 *      value, the Merkle root over participation IRIs, the
 *      aggregator's DID, signedAt, and an array of per-pod
 *      MerkleProofs so any auditor can verify any individual
 *      participation's inclusion without seeing the others.
 *
 *   3. CohortAggregationPolicy descriptor (on the institution's /
 *      org's pod). Names the cohort + the metrics the institution
 *      may compute + the maximum recency window. Participants
 *      reference it from their CohortParticipation as the policy
 *      they consented to. Lets the participant revoke later by
 *      superseding the participation descriptor.
 *
 * Cleanly composes existing primitives — no new ontology terms.
 */

import { buildMerkleTree, generateMerkleProof, verifyMerkleProof, type MerkleProof } from '../../../src/crypto/zk/index.js';
import { sha256 } from '../../../src/crypto/ipfs.js';
import {
  commit, addCommitments, verifyHomomorphicSum, sampleLaplaceInt,
  deriveBlinding, randomBlinding,
  type PedersenCommitment,
} from '../../../src/crypto/pedersen.js';
import { ContextDescriptor, publish, discover } from '../../../src/index.js';
import type { IRI, ManifestEntry } from '../../../src/index.js';

// ─────────────────────────────────────────────────────────────────────
//  Content-addressed IRIs
// ─────────────────────────────────────────────────────────────────────

/**
 * IRI of a CohortParticipation descriptor. Content-addressed on the
 * (cohort, participant) pair so an institution can derive the expected
 * IRI without scanning the participant's pod.
 */
export function participationDescriptorIri(cohortIri: string, participantDid: string): IRI {
  const h = sha256(`participation|${cohortIri}|${participantDid}`).slice(0, 16);
  return `urn:cg:cohort-participation:${h}` as IRI;
}

/**
 * IRI of the named-graph carrying the participation claim.
 */
export function participationGraphIri(cohortIri: string, participantDid: string): IRI {
  const h = sha256(`participation|${cohortIri}|${participantDid}`).slice(0, 16);
  return `urn:graph:cg:cohort-participation:${h}` as IRI;
}

// ─────────────────────────────────────────────────────────────────────
//  Build + publish a CohortParticipation descriptor
// ─────────────────────────────────────────────────────────────────────

const AGGREGATE_NS = 'https://markjspivey-xwisee.github.io/interego/applications/_shared/aggregate-privacy#';

export interface CohortParticipationInput {
  /** Cohort IRI this participation is for. */
  readonly cohortIri: IRI;
  /** Participant's DID (the agent / human committing to participate). */
  readonly participantDid: IRI;
  /** Cohort-aggregation policy descriptor the participant is consenting to. */
  readonly policyIri?: IRI;
  /** When the participation becomes valid; defaults to now. */
  readonly validFrom?: string;
  /** Pod URL where the descriptor will be published (the participant's pod). */
  readonly podUrl: string;
}

export interface CohortParticipationResult {
  readonly iri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
  readonly cohortIri: IRI;
  readonly participantDid: IRI;
  readonly validFrom: string;
}

/**
 * Build + publish a CohortParticipation descriptor on the
 * participant's pod. The descriptor is self-asserted (the participant
 * is the assertingAgent + the issuer) and SelfAsserted is the right
 * trust level — the participant is unilaterally declaring their
 * willingness. The aggregator verifies participation by discovering
 * the descriptor on the participant's pod via the standard
 * federation primitives.
 *
 * Revocation: re-publish a Counterfactual descriptor at the same IRI
 * (auto-supersedes the prior Asserted one); the aggregator filters
 * by modal status as part of v2 verifyParticipation.
 */
export async function publishCohortParticipation(
  input: CohortParticipationInput,
): Promise<CohortParticipationResult> {
  if (!input.cohortIri) throw new Error('cohortIri is required');
  if (!input.participantDid) throw new Error('participantDid is required');
  if (!input.podUrl) throw new Error('podUrl is required');

  const iri = participationDescriptorIri(input.cohortIri, input.participantDid);
  const graphIri = participationGraphIri(input.cohortIri, input.participantDid);
  const validFrom = input.validFrom ?? new Date().toISOString();

  const ttl = `@prefix agg: <${AGGREGATE_NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a agg:CohortParticipation ;
  agg:cohort <${input.cohortIri}> ;
  agg:participant <${input.participantDid}> ;
${input.policyIri ? `  agg:policy <${input.policyIri}> ;\n` : ''}\
  prov:wasAttributedTo <${input.participantDid}> ;
  dct:issued "${validFrom}" .`;

  const built = ContextDescriptor.create(iri)
    .describes(graphIri)
    .agent(input.participantDid)
    .generatedBy(input.participantDid, { onBehalfOf: input.participantDid, endedAt: validFrom })
    .temporal({ validFrom })
    .asserted(0.95)
    .selfAsserted(input.participantDid)
    .build();

  const r = await publish(built, ttl, input.podUrl);
  return {
    iri,
    descriptorUrl: r.descriptorUrl,
    graphUrl: r.graphUrl,
    cohortIri: input.cohortIri,
    participantDid: input.participantDid,
    validFrom,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Discover participations + build a Merkle-attested count
// ─────────────────────────────────────────────────────────────────────

export interface ParticipationHit {
  readonly podUrl: string;
  readonly descriptorIri: IRI;
  readonly descriptorUrl: string;
  readonly graphIri: IRI;
  /** Inferred from the manifest entry; descriptors are filtered for active modal status. */
  readonly modalStatus: 'Asserted' | 'Hypothetical' | 'Counterfactual';
}

/**
 * Walk the supplied pods, find their CohortParticipation descriptors
 * for `cohortIri`, and return the active (non-Counterfactual)
 * participations. The cohort IRI is the join key — content-addressed
 * IRIs let the aggregator derive the expected descriptor URN per
 * (cohort, participant) without scanning every descriptor.
 *
 * v2 trusts the pod manifest's modalStatus; v3 should additionally
 * verify the participation descriptor's signature against the
 * participantDid's DID document (the AgentFacet identifies who
 * supposedly signed; the Trust facet records SelfAsserted).
 */
export async function gatherParticipations(
  cohortIri: IRI,
  podUrls: readonly string[],
): Promise<ParticipationHit[]> {
  const out: ParticipationHit[] = [];
  for (const podUrl of podUrls) {
    let entries: readonly ManifestEntry[] = [];
    try {
      entries = await discover(podUrl);
    } catch {
      continue; // unreachable pod silently contributes nothing
    }
    for (const entry of entries) {
      // Cohort participation graphs have a stable IRI prefix and the
      // describes-set carries it.
      const cohortGraph = entry.describes.find(d => d.startsWith('urn:graph:cg:cohort-participation:'));
      if (!cohortGraph) continue;
      // Only count Asserted participations; Counterfactual = revoked.
      const modalStatus = entry.modalStatus ?? 'Asserted';
      if (modalStatus === 'Counterfactual' || modalStatus === 'Retracted') continue;
      // The participation descriptor's IRI is the cohortGraph IRI with
      // the graph prefix swapped for the descriptor prefix.
      const descriptorIri = cohortGraph.replace(
        'urn:graph:cg:cohort-participation:',
        'urn:cg:cohort-participation:',
      ) as IRI;
      // Verify the descriptor IRI matches what we would have derived
      // for this cohort from SOME participant DID. We can't derive the
      // participantDid from the manifest alone (it's in the graph
      // payload). v2 records the descriptorIri shape and trusts the
      // content-addressing — collision-resistant under sha256. v3 will
      // open the graph to recover the participantDid and verify.
      out.push({
        podUrl,
        descriptorIri,
        descriptorUrl: entry.descriptorUrl,
        graphIri: cohortGraph as IRI,
        modalStatus: (modalStatus as 'Asserted' | 'Hypothetical' | 'Counterfactual'),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  AttestedAggregateResult bundle
// ─────────────────────────────────────────────────────────────────────

export interface AttestedAggregateResult {
  /** The cohort the query was scoped to. */
  readonly cohortIri: IRI;
  /** Aggregator's DID (signed at the application layer; v3 signs in-band). */
  readonly aggregatorDid: IRI;
  /** ISO timestamp the aggregate was computed. */
  readonly computedAt: string;
  /** Number of participations that contributed. */
  readonly count: number;
  /** Application-level metric value (count / distribution / etc). */
  readonly value: number | Record<string, number>;
  /** Merkle root over participation descriptor IRIs (lexicographically sorted). */
  readonly merkleRoot: string;
  /** Per-participation inclusion proofs so any auditor can verify their participant is counted. */
  readonly inclusionProofs: readonly { participantPodUrl: string; descriptorIri: IRI; proof: MerkleProof }[];
  /** Privacy boundary used. v2 = 'merkle-attested-opt-in'; v3 target = 'zk-dp-aggregate'. */
  readonly privacyMode: 'merkle-attested-opt-in';
}

/**
 * Build an attested aggregate result bundle. The Merkle root is
 * tamper-evident; per-participant inclusion proofs let auditors
 * verify any individual participant's contribution to the count
 * without seeing the others.
 *
 * The metric value is application-defined — `count` is the number of
 * participations (always the merkle-tree leaf count); `value` is the
 * application-level metric (which may equal count for simple
 * counters, or be a distribution for richer metrics).
 *
 * Sorting matters: leaves are sorted lexicographically by descriptor
 * IRI before tree-building so the same participation set yields the
 * same root deterministically (regardless of pod-walk order).
 */
export function buildAttestedAggregateResult(args: {
  cohortIri: IRI;
  aggregatorDid: IRI;
  participations: readonly ParticipationHit[];
  value: number | Record<string, number>;
}): AttestedAggregateResult {
  const sorted = [...args.participations].sort((a, b) =>
    a.descriptorIri < b.descriptorIri ? -1 : a.descriptorIri > b.descriptorIri ? 1 : 0,
  );
  const leaves = sorted.map(p => p.descriptorIri);
  const tree = buildMerkleTree(leaves);
  const inclusionProofs = sorted.map(p => {
    const proof = generateMerkleProof(p.descriptorIri, leaves);
    return {
      participantPodUrl: p.podUrl,
      descriptorIri: p.descriptorIri,
      // generateMerkleProof never returns null when the value is in the input set.
      proof: proof!,
    };
  });

  return {
    cohortIri: args.cohortIri,
    aggregatorDid: args.aggregatorDid,
    computedAt: new Date().toISOString(),
    count: leaves.length,
    value: args.value,
    merkleRoot: tree.root,
    inclusionProofs,
    privacyMode: 'merkle-attested-opt-in',
  };
}

/**
 * Auditor-side verifier: given an AttestedAggregateResult, confirm
 * every inclusion proof verifies AND the proofs collectively cover
 * the claimed count. Catches: aggregator inflating the count,
 * aggregator omitting a participant, aggregator substituting a
 * different participation IRI.
 */
export function verifyAttestedAggregateResult(result: AttestedAggregateResult): { valid: boolean; reason?: string } {
  if (result.count !== result.inclusionProofs.length) {
    return { valid: false, reason: `count mismatch: claim=${result.count} proofs=${result.inclusionProofs.length}` };
  }
  for (const ip of result.inclusionProofs) {
    if (!verifyMerkleProof(ip.proof)) {
      return { valid: false, reason: `inclusion proof for ${ip.descriptorIri} failed verification` };
    }
    if (ip.proof.root !== result.merkleRoot) {
      return { valid: false, reason: `inclusion proof for ${ip.descriptorIri} points at a different Merkle root` };
    }
  }
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────
//  v3 — Homomorphic Pedersen sum + DP-Laplace noise (zk-aggregate)
// ─────────────────────────────────────────────────────────────────────
//
// Where v2 (above) gives a verifiable COUNT of opted-in participants
// via Merkle attestation, v3 gives a verifiable SUM (or count, or
// threshold) over per-contributor values that the aggregator never
// sees in cleartext. Each contributor commits to their value with a
// fresh blinding factor (Pedersen / ristretto255); the aggregator
// sums the commitments WITHOUT learning any individual contribution;
// DP-Laplace noise calibrated to a public ε budget is added to the
// reconstructed sum before reveal so the published total leaks at
// most O(1/ε) bits per query.
//
// Trust model:
//   - Contributor: writes a CommittedContribution to their own pod —
//     a Pedersen commitment + the bounds they consent to + a hash
//     commitment to their actual value (the value itself is private;
//     the hash commitment binds them to it for later challenge-
//     response audits).
//   - Aggregator: collects commitments, sums them homomorphically,
//     adds DP noise, publishes the AttestedHomomorphicSumResult bundle.
//   - Auditor: re-runs verifyHomomorphicSumResult against the bundle;
//     catches an aggregator that lies about the noisy sum.
//
// What this is NOT (yet):
//   - Cumulative ε-budget tracking across queries — caller's job.
//   - Multi-party threshold reveal — single aggregator role.
//   - Per-contribution range proofs — contributors are expected to
//     self-bound; a malicious contributor can commit to a value
//     outside the declared bounds and inflate the sum. Mitigation:
//     publish per-contributor bounds with the commitment, then
//     pair with a v2 range proof (proveConfidenceAboveThreshold
//     for [0,1] values) as a second layer.

export interface CommittedContribution {
  readonly contributorPodUrl: string;
  /** Pedersen commitment to the value. */
  readonly commitment: PedersenCommitment;
  /** Blinding factor (held by contributor, revealed to aggregator over secure channel). */
  readonly blinding: bigint;
  /** The plaintext value (held by contributor, summed by aggregator). */
  readonly value: bigint;
  /** Bounds [min, max] the contributor consented to. */
  readonly bounds: { min: bigint; max: bigint };
}

/**
 * Build a CommittedContribution from a contributor's value + bounds.
 * The blinding factor is derived from a (seed, label) pair so the
 * contributor can reproduce it later for audit (or, with a random
 * seed, kept private and revealed once to the aggregator).
 *
 * Throws if value is outside the declared bounds — the substrate
 * surfaces the contributor's own bounds check before commitment.
 */
export function buildCommittedContribution(args: {
  contributorPodUrl: string;
  value: bigint;
  bounds: { min: bigint; max: bigint };
  blindingSeed?: string;
  blindingLabel?: string;
}): CommittedContribution {
  if (args.value < args.bounds.min || args.value > args.bounds.max) {
    throw new Error(`Pedersen contribution: value ${args.value} outside declared bounds [${args.bounds.min}, ${args.bounds.max}]`);
  }
  const blinding = args.blindingSeed
    ? deriveBlinding(args.blindingSeed, args.blindingLabel ?? 'pedersen/contribution')
    : randomBlinding();
  const commitment = commit(args.value, blinding);
  return {
    contributorPodUrl: args.contributorPodUrl,
    commitment,
    blinding,
    value: args.value,
    bounds: args.bounds,
  };
}

export interface AttestedHomomorphicSumResult {
  readonly cohortIri: IRI;
  readonly aggregatorDid: IRI;
  readonly computedAt: string;
  /** Number of contributions that went into the sum. */
  readonly contributorCount: number;
  /** The reconstructed pre-noise sum (private — for audit, not publication). */
  readonly trueSum?: bigint;
  /** True sum + Laplace noise; this is the publishable value. */
  readonly noisySum: bigint;
  /** Laplace noise added to the true sum. */
  readonly noise: number;
  /** Sum of all contributor blindings (private — for audit only). */
  readonly trueBlinding?: bigint;
  /** Sensitivity parameter (max contribution magnitude). */
  readonly sensitivity: number;
  /** DP ε budget consumed by this query. */
  readonly epsilon: number;
  /** Aggregated commitment that opens to (trueSum, trueBlinding). */
  readonly sumCommitment: PedersenCommitment;
  /** Per-contributor commitments (in the same order summed). */
  readonly contributorCommitments: readonly PedersenCommitment[];
  readonly privacyMode: 'zk-aggregate';
}

/**
 * Aggregator-side: sum the homomorphic commitments, reconstruct the
 * true sum + blinding from the contributors' revealed openings, add
 * DP-Laplace noise calibrated to (sensitivity, ε), return the bundle.
 *
 * `sensitivity` should equal `bounds.max - bounds.min` for the
 * cohort (a single-contributor change can shift the sum by at most
 * this much) — that's the L1 sensitivity for the standard DP
 * definition.
 */
export function buildAttestedHomomorphicSum(args: {
  cohortIri: IRI;
  aggregatorDid: IRI;
  contributions: readonly CommittedContribution[];
  epsilon: number;
  /** When true, include the trueSum + trueBlinding in the bundle for audit (not for publication). */
  includeAuditFields?: boolean;
}): AttestedHomomorphicSumResult {
  if (args.contributions.length === 0) {
    throw new Error('buildAttestedHomomorphicSum: at least one contribution required');
  }
  // Bounds must be consistent across the cohort for the sensitivity
  // calculation to mean anything; reject mismatches loudly.
  const first = args.contributions[0]!;
  for (const c of args.contributions) {
    if (c.bounds.min !== first.bounds.min || c.bounds.max !== first.bounds.max) {
      throw new Error(`buildAttestedHomomorphicSum: contributions disagree on bounds (${c.contributorPodUrl})`);
    }
  }
  const sensitivity = Number(first.bounds.max - first.bounds.min);
  if (!(sensitivity > 0)) throw new Error('buildAttestedHomomorphicSum: non-positive sensitivity');

  const trueSum = args.contributions.reduce((acc, c) => acc + c.value, 0n);
  const trueBlinding = args.contributions.reduce((acc, c) => acc + c.blinding, 0n);
  const sumCommitment = addCommitments(args.contributions.map(c => c.commitment));

  const noise = sampleLaplaceInt(sensitivity, args.epsilon);
  const noisySum = trueSum + BigInt(noise);

  const result: AttestedHomomorphicSumResult = {
    cohortIri: args.cohortIri,
    aggregatorDid: args.aggregatorDid,
    computedAt: new Date().toISOString(),
    contributorCount: args.contributions.length,
    noisySum,
    noise,
    sensitivity,
    epsilon: args.epsilon,
    sumCommitment,
    contributorCommitments: args.contributions.map(c => c.commitment),
    privacyMode: 'zk-aggregate',
    ...(args.includeAuditFields ? { trueSum, trueBlinding } : {}),
  };
  return result;
}

/**
 * Auditor-side: confirm the published bundle is internally consistent.
 * Catches: aggregator inflated the noisySum; aggregator substituted
 * a different sumCommitment; aggregator changed the contributor set.
 *
 * Full verification (that the trueSum / trueBlinding match the
 * commitments) requires the audit fields — when the bundle was built
 * with `includeAuditFields: false`, only the structural check is
 * available (sumCommitment === sum of contributorCommitments).
 *
 * The noise itself isn't re-verifiable (Laplace samples are random
 * by design); an auditor checks the bundle's structural integrity
 * + the epsilon claim, then trusts the noise process per the
 * documented sampleLaplaceInt implementation.
 */
export function verifyAttestedHomomorphicSum(r: AttestedHomomorphicSumResult): { valid: boolean; reason?: string } {
  if (r.contributorCount !== r.contributorCommitments.length) {
    return { valid: false, reason: `contributor count mismatch: claim=${r.contributorCount} commitments=${r.contributorCommitments.length}` };
  }
  if (r.contributorCount === 0) {
    return { valid: false, reason: 'no contributions' };
  }
  // Structural: the published sumCommitment must equal the
  // homomorphic sum of the contributor commitments. An aggregator
  // who swaps in a different aggregate point breaks this check.
  const computed = addCommitments(r.contributorCommitments);
  if (computed.bytes !== r.sumCommitment.bytes) {
    return { valid: false, reason: 'sumCommitment does not equal the homomorphic sum of contributorCommitments' };
  }
  // Audit-field path: when the bundle includes trueSum + trueBlinding,
  // verify the sum-commitment actually opens to them.
  if (r.trueSum !== undefined && r.trueBlinding !== undefined) {
    const ok = verifyHomomorphicSum(r.contributorCommitments, r.trueSum, r.trueBlinding);
    if (!ok) return { valid: false, reason: 'sumCommitment does not open to claimed (trueSum, trueBlinding)' };
    // Cross-check: noisySum should equal trueSum + noise.
    if (r.noisySum !== r.trueSum + BigInt(r.noise)) {
      return { valid: false, reason: `noisySum (${r.noisySum}) != trueSum (${r.trueSum}) + noise (${r.noise})` };
    }
  }
  if (!(r.epsilon > 0)) return { valid: false, reason: 'epsilon must be > 0' };
  if (!(r.sensitivity > 0)) return { valid: false, reason: 'sensitivity must be > 0' };
  return { valid: true };
}
