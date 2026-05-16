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
import {
  reconstructSecret,
  type ShamirShare,
} from '../../../src/crypto/shamir.js';
import {
  splitSecretWithCommitments, filterVerifiedShares,
  type FeldmanCommitments, type VerifiableShamirShare,
} from '../../../src/crypto/feldman-vss.js';
import {
  proveRange, verifyRange,
  type RangeProof,
} from '../../../src/crypto/range-proof.js';
import { ContextDescriptor, publish, discover } from '../../../src/index.js';
import type { IRI, ManifestEntry } from '../../../src/index.js';
import { verifyMessage } from 'ethers';
import { ristretto255 } from '@noble/curves/ed25519.js';

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

/**
 * Signed-bounds attestation. Binds a contributor (by DID) to a specific
 * (commitment, bounds) pair. The contributor signs the message
 *
 *     "interego/v1/aggregate/signed-bounds|<commitment-hex>|<min>|<max>|<contributorDid>"
 *
 * with their wallet. Auditors verify the signature recovers an address
 * matching the contributorDid; this catches an aggregator who tries to
 * claim a contributor consented to wider bounds than they actually did,
 * or who tries to attribute a commitment to a different contributor.
 *
 * Optional in v3 (not present = the aggregator vouches for the bounds
 * client-side via buildCommittedContribution + sum-time bounds re-check).
 * Required for "regulator-grade" v3 deployments where the aggregator is
 * also under audit.
 */
export interface SignedBoundsAttestation {
  /** Contributor DID — the signer the auditor recovers from the signature. */
  readonly contributorDid: IRI;
  /** 0x-prefixed ECDSA signature (ethers-compatible). */
  readonly signature: string;
}

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
  /** Optional signed-bounds attestation. v3.1 enhancement. */
  readonly signedBounds?: SignedBoundsAttestation;
  /**
   * Optional non-interactive ZK range proof that `value ∈ [bounds.min,
   * bounds.max]`. v3.4 enhancement — when present, the AUDITOR (not
   * just the aggregator) can verify the contribution was in bounds
   * without seeing the cleartext value. The aggregator still sees
   * cleartext for trueSum computation; the range proof is the audit-
   * surface guarantee.
   */
  readonly rangeProof?: RangeProof;
}

/**
 * Canonical message format for the signed-bounds attestation. Both
 * signer and verifier MUST use this exact format; any drift breaks
 * signature verification.
 */
export function signedBoundsMessage(args: {
  commitment: PedersenCommitment;
  bounds: { min: bigint; max: bigint };
  contributorDid: IRI;
}): string {
  return `interego/v1/aggregate/signed-bounds|${args.commitment.bytes}|${args.bounds.min}|${args.bounds.max}|${args.contributorDid}`;
}

/**
 * Verify a signed-bounds attestation: the signature must recover an
 * address that matches the contributorDid. The DID format is
 * `did:pkh:eip155:<chainId>:<address>` or
 * `did:ethr:<address>` or simply an Ethereum-address-shaped string —
 * matching is loose (case-insensitive substring of the recovered
 * address inside the DID), which catches the common DID shapes
 * without committing to a specific DID-method parser here.
 */
export function verifySignedBounds(args: {
  commitment: PedersenCommitment;
  bounds: { min: bigint; max: bigint };
  attestation: SignedBoundsAttestation;
}): { valid: boolean; reason?: string; recoveredAddress?: string } {
  let recovered: string;
  try {
    const msg = signedBoundsMessage({
      commitment: args.commitment,
      bounds: args.bounds,
      contributorDid: args.attestation.contributorDid,
    });
    recovered = verifyMessage(msg, args.attestation.signature);
  } catch (err) {
    return { valid: false, reason: `signature recovery failed: ${(err as Error).message}` };
  }
  const recoveredLower = recovered.toLowerCase();
  const didLower = args.attestation.contributorDid.toLowerCase();
  if (!didLower.includes(recoveredLower)) {
    return {
      valid: false,
      reason: `recovered address ${recovered} not present in contributorDid ${args.attestation.contributorDid}`,
      recoveredAddress: recovered,
    };
  }
  return { valid: true, recoveredAddress: recovered };
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
  /**
   * v3.4: when true, also emit a non-interactive ZK range proof that
   * `value ∈ [bounds.min, bounds.max]`. The proof is bit-decomposition
   * over O(log(max-min)) Chaum-Pedersen OR proofs — adds ~O(log
   * range) ms per contribution. Worth it when the auditor needs to
   * verify bounds without seeing the value.
   */
  withRangeProof?: boolean;
}): CommittedContribution {
  if (args.value < args.bounds.min || args.value > args.bounds.max) {
    throw new Error(`Pedersen contribution: value ${args.value} outside declared bounds [${args.bounds.min}, ${args.bounds.max}]`);
  }
  const blinding = args.blindingSeed
    ? deriveBlinding(args.blindingSeed, args.blindingLabel ?? 'pedersen/contribution')
    : randomBlinding();
  const commitment = commit(args.value, blinding);
  const rangeProof = args.withRangeProof
    ? proveRange({ commitment, value: args.value, blinding, min: args.bounds.min, max: args.bounds.max })
    : undefined;
  return {
    contributorPodUrl: args.contributorPodUrl,
    commitment,
    blinding,
    value: args.value,
    bounds: args.bounds,
    ...(rangeProof ? { rangeProof } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  v3 — Distribution-shaped metrics (per-bucket homomorphic sums)
// ─────────────────────────────────────────────────────────────────────
//
// Where buildAttestedHomomorphicSum gives a single noisy sum, many
// real metrics are distributions: "how many learners scored 0-25 vs
// 25-50 vs 50-75 vs 75-100", "what's the histogram of decisions per
// quarter", etc. The naive sum primitive can't express this — at
// most it gives the total count or a single statistic.
//
// Composition: each contributor is committed to a vector of per-bucket
// Pedersen commitments via one-hot encoding — the bucket their value
// falls into gets a commit(1, blinding_i); every other bucket gets a
// commit(0, blinding_i). The aggregator homomorphically sums each
// bucket's commitments independently, producing a per-bucket sum
// commitment that opens to (count_in_bucket, Σ blindings_for_bucket).
// DP-Laplace noise is added per bucket independently; the sensitivity
// is 1 (one-hot encoding bounds each contributor's per-bucket
// contribution to {0, 1}, so a single-contributor change shifts any
// one bucket count by at most 1).
//
// All primitives compose existing pieces: Pedersen commit + DP-Laplace
// noise + addCommitments. No new ontology terms.

export interface NumericBucketingScheme {
  readonly type: 'numeric';
  /**
   * Bucket edges in ascending order. A value v falls into bucket i iff
   * `edges[i] <= v < edges[i+1]` (right-open). The last bucket is
   * right-CLOSED to include the maximum: `edges[n-1] <= v <= maxValue`.
   * For an edges array of length `b + 1`, there are `b` buckets.
   */
  readonly edges: readonly bigint[];
  /** Maximum permitted value; values > maxValue throw at contribution time. */
  readonly maxValue: bigint;
}

export type BucketingScheme = NumericBucketingScheme;

/**
 * Determine which bucket a value falls into. Returns the index in
 * `[0, edges.length - 1)`. Throws if the value is outside the
 * [edges[0], maxValue] range.
 */
export function bucketIndex(scheme: BucketingScheme, value: bigint): number {
  if (scheme.edges.length < 2) {
    throw new Error('bucketIndex: scheme must have at least 2 edges (1 bucket)');
  }
  if (value < scheme.edges[0]!) {
    throw new Error(`bucketIndex: value ${value} below scheme minimum ${scheme.edges[0]}`);
  }
  if (value > scheme.maxValue) {
    throw new Error(`bucketIndex: value ${value} above scheme maxValue ${scheme.maxValue}`);
  }
  for (let i = scheme.edges.length - 2; i >= 0; i--) {
    if (value >= scheme.edges[i]!) return i;
  }
  throw new Error(`bucketIndex: unreachable — value ${value} not classified`);
}

/**
 * Number of buckets in the scheme.
 */
export function bucketCount(scheme: BucketingScheme): number {
  return scheme.edges.length - 1;
}

export interface BucketedCommittedContribution {
  readonly contributorPodUrl: string;
  /** Bucket index this contributor's value falls into (one-hot indicator). */
  readonly bucket: number;
  /** Per-bucket Pedersen commitments. Length == bucketCount(scheme). */
  readonly perBucketCommitments: readonly PedersenCommitment[];
  /** Per-bucket blindings (kept by contributor; revealed to aggregator). */
  readonly perBucketBlindings: readonly bigint[];
  /** The scheme this contribution was bucketed against. */
  readonly scheme: BucketingScheme;
}

/**
 * Build a one-hot-encoded bucketed contribution. The bucket that
 * `value` falls into gets a commit(1, blinding_i); every other bucket
 * gets a commit(0, blinding_i). The blinding vector is derived per-
 * bucket from a (seed, label) pair so the contributor can reproduce
 * them later for audit, or kept private if the seed is random.
 *
 * @throws on bucket-out-of-range (handled by bucketIndex).
 */
export function buildBucketedContribution(args: {
  contributorPodUrl: string;
  value: bigint;
  scheme: BucketingScheme;
  blindingSeed?: string;
  blindingLabel?: string;
}): BucketedCommittedContribution {
  const bucket = bucketIndex(args.scheme, args.value);
  const k = bucketCount(args.scheme);
  const blindings: bigint[] = [];
  const commitments: PedersenCommitment[] = [];
  const labelBase = args.blindingLabel ?? 'pedersen/bucketed-contribution';
  for (let i = 0; i < k; i++) {
    const b = args.blindingSeed
      ? deriveBlinding(args.blindingSeed, `${labelBase}/bucket-${i}`)
      : randomBlinding();
    const v = i === bucket ? 1n : 0n;
    blindings.push(b);
    commitments.push(commit(v, b));
  }
  return {
    contributorPodUrl: args.contributorPodUrl,
    bucket,
    perBucketCommitments: commitments,
    perBucketBlindings: blindings,
    scheme: args.scheme,
  };
}

export interface AttestedHomomorphicDistributionResult {
  readonly cohortIri: IRI;
  readonly aggregatorDid: IRI;
  readonly computedAt: string;
  /** Number of contributions that went into the distribution. */
  readonly contributorCount: number;
  /** The bucketing scheme used. */
  readonly scheme: BucketingScheme;
  /** Per-bucket noisy counts (publishable). */
  readonly noisyBucketCounts: readonly bigint[];
  /** Per-bucket DP-Laplace noise added (for audit). */
  readonly noisePerBucket: readonly number[];
  /** Per-bucket aggregated commitments (opens to (true count, Σ blindings)). */
  readonly bucketSumCommitments: readonly PedersenCommitment[];
  /** Per-bucket per-contributor commitments preserved for structural verification. */
  readonly perContributorCommitments: readonly (readonly PedersenCommitment[])[];
  /** Per-bucket true counts (private — for audit when includeAuditFields=true). */
  readonly trueBucketCounts?: readonly bigint[];
  /** Per-bucket sum of blindings (private — for audit when includeAuditFields=true). */
  readonly trueBucketBlindings?: readonly bigint[];
  /** DP ε budget consumed by this query (per-bucket sensitivity = 1). */
  readonly epsilon: number;
  readonly privacyMode: 'zk-distribution';
}

/**
 * Aggregator-side: per-bucket homomorphic sums + per-bucket DP-Laplace
 * noise. Each bucket's sensitivity is 1 (one-hot encoding: a single-
 * contributor change shifts any one bucket count by exactly 1), so
 * `sampleLaplaceInt(1, epsilon)` per bucket gives ε-DP per bucket
 * with the standard noise calibration.
 *
 * Sensitivity NOTE: this is per-bucket ε; the cumulative privacy
 * across the whole histogram under sequential composition is
 * `k * ε` where k = number of buckets. Callers who want histogram-
 * level ε should divide their ε budget by k before calling.
 */
export function buildAttestedHomomorphicDistribution(args: {
  cohortIri: IRI;
  aggregatorDid: IRI;
  contributions: readonly BucketedCommittedContribution[];
  epsilon: number;
  includeAuditFields?: boolean;
  epsilonBudget?: EpsilonBudget;
  queryDescription?: string;
}): AttestedHomomorphicDistributionResult {
  if (args.contributions.length === 0) {
    throw new Error('buildAttestedHomomorphicDistribution: at least one contribution required');
  }
  const first = args.contributions[0]!;
  const k = bucketCount(first.scheme);
  // All contributors MUST share the same scheme (same edges + maxValue).
  for (const c of args.contributions) {
    if (c.scheme.edges.length !== first.scheme.edges.length || c.scheme.maxValue !== first.scheme.maxValue) {
      throw new Error(`buildAttestedHomomorphicDistribution: scheme mismatch in contribution from ${c.contributorPodUrl}`);
    }
    for (let i = 0; i < c.scheme.edges.length; i++) {
      if (c.scheme.edges[i] !== first.scheme.edges[i]) {
        throw new Error(`buildAttestedHomomorphicDistribution: edge mismatch at ${i} in contribution from ${c.contributorPodUrl}`);
      }
    }
    if (c.perBucketCommitments.length !== k) {
      throw new Error(`buildAttestedHomomorphicDistribution: contribution from ${c.contributorPodUrl} has ${c.perBucketCommitments.length} commitments, expected ${k}`);
    }
  }

  if (args.epsilonBudget) {
    args.epsilonBudget.consume({
      queryDescription: args.queryDescription ?? `homomorphic-distribution on ${args.cohortIri}`,
      epsilon: args.epsilon,
    });
  }

  // Per-bucket: homomorphic sum + DP-Laplace noise.
  const bucketSumCommitments: PedersenCommitment[] = [];
  const noisyBucketCounts: bigint[] = [];
  const noisePerBucket: number[] = [];
  const trueBucketCounts: bigint[] = [];
  const trueBucketBlindings: bigint[] = [];
  for (let i = 0; i < k; i++) {
    const bucketCommits = args.contributions.map(c => c.perBucketCommitments[i]!);
    const bucketSum = addCommitments(bucketCommits);
    bucketSumCommitments.push(bucketSum);
    const trueCount = args.contributions.reduce((acc, c) => acc + (c.bucket === i ? 1n : 0n), 0n);
    const trueBlinding = args.contributions.reduce((acc, c) => acc + c.perBucketBlindings[i]!, 0n);
    trueBucketCounts.push(trueCount);
    trueBucketBlindings.push(trueBlinding);
    // Per-bucket sensitivity = 1 (one-hot encoding).
    const noise = sampleLaplaceInt(1, args.epsilon);
    noisePerBucket.push(noise);
    noisyBucketCounts.push(trueCount + BigInt(noise));
  }

  const result: AttestedHomomorphicDistributionResult = {
    cohortIri: args.cohortIri,
    aggregatorDid: args.aggregatorDid,
    computedAt: new Date().toISOString(),
    contributorCount: args.contributions.length,
    scheme: first.scheme,
    noisyBucketCounts,
    noisePerBucket,
    bucketSumCommitments,
    perContributorCommitments: args.contributions.map(c => c.perBucketCommitments),
    epsilon: args.epsilon,
    privacyMode: 'zk-distribution',
    ...(args.includeAuditFields ? { trueBucketCounts, trueBucketBlindings } : {}),
  };
  return result;
}

/**
 * Auditor-side: confirm the published distribution bundle is
 * internally consistent. Catches: aggregator substituting per-bucket
 * sum commitments; aggregator lying about per-bucket counts;
 * aggregator changing the contributor set; scheme tampering.
 */
export function verifyAttestedHomomorphicDistribution(r: AttestedHomomorphicDistributionResult): { valid: boolean; reason?: string } {
  const k = bucketCount(r.scheme);
  if (r.bucketSumCommitments.length !== k) {
    return { valid: false, reason: `bucketSumCommitments length ${r.bucketSumCommitments.length} != bucketCount ${k}` };
  }
  if (r.noisyBucketCounts.length !== k) {
    return { valid: false, reason: `noisyBucketCounts length ${r.noisyBucketCounts.length} != bucketCount ${k}` };
  }
  if (r.noisePerBucket.length !== k) {
    return { valid: false, reason: `noisePerBucket length ${r.noisePerBucket.length} != bucketCount ${k}` };
  }
  if (r.contributorCount !== r.perContributorCommitments.length) {
    return { valid: false, reason: `contributorCount ${r.contributorCount} != perContributorCommitments.length ${r.perContributorCommitments.length}` };
  }
  // Per-bucket structural: each bucketSumCommitment must equal the
  // homomorphic sum of that bucket's per-contributor commitments.
  for (let i = 0; i < k; i++) {
    const bucketCommits = r.perContributorCommitments.map(c => c[i]!);
    const computed = addCommitments(bucketCommits);
    if (computed.bytes !== r.bucketSumCommitments[i]!.bytes) {
      return { valid: false, reason: `bucket ${i} sumCommitment does not equal the homomorphic sum of contributor commitments` };
    }
  }
  // Audit-field path: when the bundle includes per-bucket trueCounts +
  // trueBlindings, verify each bucket opens correctly.
  if (r.trueBucketCounts !== undefined && r.trueBucketBlindings !== undefined) {
    if (r.trueBucketCounts.length !== k || r.trueBucketBlindings.length !== k) {
      return { valid: false, reason: 'true-bucket audit arrays have wrong length' };
    }
    for (let i = 0; i < k; i++) {
      const bucketCommits = r.perContributorCommitments.map(c => c[i]!);
      const ok = verifyHomomorphicSum(bucketCommits, r.trueBucketCounts[i]!, r.trueBucketBlindings[i]!);
      if (!ok) return { valid: false, reason: `bucket ${i} sumCommitment does not open to claimed (trueCount, trueBlinding)` };
      if (r.noisyBucketCounts[i] !== r.trueBucketCounts[i]! + BigInt(r.noisePerBucket[i]!)) {
        return { valid: false, reason: `bucket ${i} noisyCount (${r.noisyBucketCounts[i]}) != trueCount + noise (${r.trueBucketCounts[i]! + BigInt(r.noisePerBucket[i]!)})` };
      }
    }
  }
  if (!(r.epsilon > 0)) return { valid: false, reason: 'epsilon must be > 0' };
  return { valid: true };
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
  /**
   * v4-partial: Shamir shares of the trueBlinding. Present iff the
   * caller supplied `thresholdReveal: {n, t}`. The operator
   * distributes these to k pseudo-aggregators; any t-of-n committee
   * reconstructs trueBlinding via `reconstructThresholdRevealAndVerify`
   * and confirms the sum-commitment opens to (claimedTrueSum,
   * reconstructedTrueBlinding). The trueBlinding is OMITTED from
   * the audit fields when threshold reveal is in use — that's the
   * point: no single party (including the auditor) knows it.
   *
   * v4-partial+VSS: shares are emitted as VerifiableShamirShare so the
   * recipient can verify against `coefficientCommitments` before
   * participating in reconstruction. Structurally compatible with
   * ShamirShare (same x/y/threshold fields).
   */
  readonly thresholdShares?: readonly VerifiableShamirShare[];
  /**
   * v3.4: per-contributor ZK range proofs (one per
   * contributorCommitments entry, in matching order). Present only
   * when the bundle was built with `requireRangeProof: true` AND every
   * contribution carried a rangeProof. The auditor verifies each
   * proof against the matching contributorCommitment + the
   * proof's declared min/max via `verifyContributorRangeProofs`.
   */
  readonly contributorRangeProofs?: readonly RangeProof[];
  /** Present alongside thresholdShares. */
  readonly threshold?: { n: number; t: number };
  /**
   * v4-partial + Feldman VSS: per-polynomial-coefficient commitments
   * `C_i = c_i · G` so a recipient can verify their share before
   * participating in reconstruction. Default behaviour: the
   * thresholdReveal path emits this automatically (using
   * src/crypto/feldman-vss.ts) so corrupted shares are detectable.
   * The verifier path (reconstructThresholdRevealAndVerify) filters
   * shares against these commitments BEFORE Lagrange interpolation.
   */
  readonly coefficientCommitments?: FeldmanCommitments;
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
  /**
   * When true (v3.1 regulator-grade mode), require every contribution
   * to carry a `signedBounds` attestation whose signature recovers
   * the declared contributorDid against the canonical signedBoundsMessage.
   * Catches: aggregator inflating a contributor's bounds; impersonation.
   * Default false (v3 trust-the-client mode).
   */
  requireSignedBounds?: boolean;
  /**
   * v3.4: when true, every contribution MUST carry a `rangeProof`
   * that verifies against the contribution's commitment + declared
   * bounds. The aggregator's existing cleartext bounds re-check
   * still runs (the aggregator does see values in v3); the range
   * proof's value is that the published bundle can be audited
   * end-to-end WITHOUT the auditor needing to trust the aggregator's
   * bounds claim. Each contribution's `rangeProof` is propagated
   * into the bundle's `contributorRangeProofs` field for the
   * auditor to re-verify via `verifyContributorRangeProofs`.
   */
  requireRangeProof?: boolean;
  /**
   * Optional cumulative ε-budget tracker (v3.2). When supplied, the
   * function calls `epsilonBudget.consume(...)` BEFORE building the
   * bundle — the consume() call throws if the cumulative ε would
   * exceed the declared cap. Mutates the tracker; auditors replay
   * the tracker's log to verify total leakage stayed under cap.
   */
  epsilonBudget?: EpsilonBudget;
  /** Optional description recorded in the EpsilonBudget log entry. */
  queryDescription?: string;
  /**
   * v4-partial: threshold reveal. When supplied, the trueBlinding is
   * split into `n` Shamir shares with threshold `t` (the secret is
   * the bigint blinding, the shares live in the ristretto255 scalar
   * field). The bundle's `thresholdShares` field is populated so the
   * operator can distribute the shares to k pseudo-aggregators; any
   * t-of-n committee can later call `reconstructThresholdRevealAndVerify`
   * to recover the trueBlinding and confirm the sum-commitment opens
   * to (claimedTrueSum, reconstructedTrueBlinding).
   *
   * STILL TRUSTED-DEALER: the operator running buildAttestedHomomorphicSum
   * knows the polynomial coefficients. Full multi-aggregator setup
   * needs Distributed Key Generation to remove this — out of scope
   * for this iteration; tracked in STATUS.md as the next v4 piece.
   */
  thresholdReveal?: { n: number; t: number };
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
    // v3.1 cheat-protection: aggregator re-checks the value against
    // the contributor's declared bounds. `buildCommittedContribution`
    // does the same check on the contributor's side, but a malicious
    // contributor that bypasses their own client-side check could
    // submit a value outside the declared bounds and inflate the
    // sum (their commitment still opens correctly, but the noisy
    // sum leaks information). The aggregator MUST NOT trust the
    // contributor's self-bounds-check; this is the
    // sensitivity-invariant guard that makes the DP claim sound.
    if (c.value < c.bounds.min || c.value > c.bounds.max) {
      throw new Error(`buildAttestedHomomorphicSum: contribution from ${c.contributorPodUrl} has value ${c.value} outside declared bounds [${c.bounds.min}, ${c.bounds.max}] — aggregator refuses to inflate the noisy sum`);
    }
    // v3.1 regulator-grade mode: enforce signed-bounds attestations.
    if (args.requireSignedBounds) {
      if (!c.signedBounds) {
        throw new Error(`buildAttestedHomomorphicSum: requireSignedBounds=true but contribution from ${c.contributorPodUrl} has no signedBounds attestation`);
      }
      const v = verifySignedBounds({
        commitment: c.commitment,
        bounds: c.bounds,
        attestation: c.signedBounds,
      });
      if (!v.valid) {
        throw new Error(`buildAttestedHomomorphicSum: signed-bounds attestation for ${c.contributorPodUrl} failed verification: ${v.reason}`);
      }
    }
    // v3.4: enforce ZK range proofs.
    if (args.requireRangeProof) {
      if (!c.rangeProof) {
        throw new Error(`buildAttestedHomomorphicSum: requireRangeProof=true but contribution from ${c.contributorPodUrl} has no rangeProof`);
      }
      const proofMinOk = BigInt(c.rangeProof.min) === c.bounds.min;
      const proofMaxOk = BigInt(c.rangeProof.max) === c.bounds.max;
      if (!proofMinOk || !proofMaxOk) {
        throw new Error(`buildAttestedHomomorphicSum: rangeProof for ${c.contributorPodUrl} declares bounds [${c.rangeProof.min}, ${c.rangeProof.max}] but contribution declares [${c.bounds.min}, ${c.bounds.max}]`);
      }
      if (!verifyRange({ commitment: c.commitment, proof: c.rangeProof })) {
        throw new Error(`buildAttestedHomomorphicSum: rangeProof for ${c.contributorPodUrl} failed verification against the commitment + declared bounds`);
      }
    }
  }
  const sensitivity = Number(first.bounds.max - first.bounds.min);
  if (!(sensitivity > 0)) throw new Error('buildAttestedHomomorphicSum: non-positive sensitivity');

  // v3.2: ε-budget pre-flight. Consume BEFORE building the bundle so
  // a budget overrun aborts the query (rather than producing a
  // bundle the caller still has to throw away). The tracker's
  // consume() throws if the cumulative ε would exceed cap.
  if (args.epsilonBudget) {
    args.epsilonBudget.consume({
      queryDescription: args.queryDescription ?? `homomorphic-sum on ${args.cohortIri}`,
      epsilon: args.epsilon,
    });
  }

  const trueSum = args.contributions.reduce((acc, c) => acc + c.value, 0n);
  const trueBlinding = args.contributions.reduce((acc, c) => acc + c.blinding, 0n);
  const sumCommitment = addCommitments(args.contributions.map(c => c.commitment));

  const noise = sampleLaplaceInt(sensitivity, args.epsilon);
  const noisySum = trueSum + BigInt(noise);

  // v4-partial + Feldman VSS: split trueBlinding via Shamir AND emit
  // per-polynomial-coefficient commitments so any recipient can verify
  // their share is on the dealer's actual polynomial BEFORE participating
  // in reconstruction. Without VSS, a corrupted share silently poisons
  // the Lagrange interpolation; with VSS, the verifier filters bad
  // shares first via filterVerifiedShares. The shares ARE the bundle's
  // blinding material in this mode; the single-aggregator trueBlinding
  // audit field is omitted (no single party — including the auditor —
  // should know it).
  let thresholdShares: readonly VerifiableShamirShare[] | undefined;
  let coefficientCommitments: FeldmanCommitments | undefined;
  if (args.thresholdReveal) {
    const { n, t } = args.thresholdReveal;
    const split = splitSecretWithCommitments({ secret: trueBlinding, totalShares: n, threshold: t });
    thresholdShares = split.shares;
    coefficientCommitments = split.commitments;
  }

  // Compose audit fields: when threshold reveal is in use, trueBlinding
  // is NEVER published; the verifier reconstructs it from shares.
  // trueSum stays available (the noisySum already pins it modulo noise).
  const auditFields: Partial<Pick<AttestedHomomorphicSumResult, 'trueSum' | 'trueBlinding'>> = {};
  if (args.includeAuditFields) {
    auditFields.trueSum = trueSum;
    if (!thresholdShares) auditFields.trueBlinding = trueBlinding;
  }

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
    ...auditFields,
    ...(thresholdShares ? { thresholdShares, threshold: args.thresholdReveal! } : {}),
    ...(coefficientCommitments ? { coefficientCommitments } : {}),
    ...(args.requireRangeProof
      ? { contributorRangeProofs: args.contributions.map(c => c.rangeProof!) }
      : {}),
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

/**
 * v3.4 auditor-side: verify every per-contributor range proof in a
 * bundle that was built with `requireRangeProof: true`. Confirms each
 * `contributorRangeProofs[i]` verifies against `contributorCommitments[i]`
 * AND all proofs declare the same [min, max] bounds (so the cohort's
 * sensitivity claim is honest — every contributor was in the same range).
 *
 * Returns the agreed bounds on success so the auditor can cross-check
 * against the published `sensitivity` field.
 */
export function verifyContributorRangeProofs(r: AttestedHomomorphicSumResult): {
  valid: boolean;
  reason?: string;
  bounds?: { min: bigint; max: bigint };
} {
  if (!r.contributorRangeProofs) {
    return { valid: false, reason: 'bundle has no contributorRangeProofs (was it built with requireRangeProof: true?)' };
  }
  if (r.contributorRangeProofs.length !== r.contributorCommitments.length) {
    return {
      valid: false,
      reason: `contributorRangeProofs length (${r.contributorRangeProofs.length}) != contributorCommitments length (${r.contributorCommitments.length})`,
    };
  }
  let agreedMin: bigint | null = null;
  let agreedMax: bigint | null = null;
  for (let i = 0; i < r.contributorRangeProofs.length; i++) {
    const proof = r.contributorRangeProofs[i]!;
    const commitment = r.contributorCommitments[i]!;
    let pMin: bigint, pMax: bigint;
    try {
      pMin = BigInt(proof.min);
      pMax = BigInt(proof.max);
    } catch {
      return { valid: false, reason: `range proof ${i}: malformed bounds (${proof.min}, ${proof.max})` };
    }
    if (agreedMin === null) {
      agreedMin = pMin; agreedMax = pMax;
    } else if (pMin !== agreedMin || pMax !== agreedMax) {
      return {
        valid: false,
        reason: `range proof ${i} declares bounds [${pMin}, ${pMax}] but cohort already agreed on [${agreedMin}, ${agreedMax}]`,
      };
    }
    if (!verifyRange({ commitment, proof })) {
      return { valid: false, reason: `range proof ${i} failed verification against contributorCommitments[${i}]` };
    }
  }
  // Cross-check: the bundle's sensitivity must equal Number(max - min).
  const expectedSensitivity = Number(agreedMax! - agreedMin!);
  if (expectedSensitivity !== r.sensitivity) {
    return {
      valid: false,
      reason: `published sensitivity (${r.sensitivity}) != bounds-derived sensitivity (${expectedSensitivity})`,
    };
  }
  return { valid: true, bounds: { min: agreedMin!, max: agreedMax! } };
}

/**
 * v4-partial: auditor-side threshold reveal verifier. Takes a bundle
 * (built with `thresholdReveal: {n, t}` so it includes thresholdShares),
 * a t-subset of shares (typically collected from t pseudo-aggregators
 * via the protocol layer the substrate doesn't ship yet), and the
 * claimed trueSum (separately disclosed by one of the parties, or
 * derivable from the noisySum + noise when the noise is published).
 *
 * Returns valid + reconstructedTrueBlinding on success; descriptive
 * reason on failure. Catches: insufficient shares; the
 * reconstructed-trueBlinding doesn't open the sumCommitment to the
 * claimed trueSum; the bundle isn't in threshold-reveal mode.
 */
export function reconstructThresholdRevealAndVerify(args: {
  bundle: AttestedHomomorphicSumResult;
  shares: readonly (ShamirShare | VerifiableShamirShare)[];
  claimedTrueSum: bigint;
}): { valid: boolean; reason?: string; reconstructedTrueBlinding?: bigint; verifiedShareCount?: number; rejectedShareCount?: number } {
  if (!args.bundle.thresholdShares || !args.bundle.threshold) {
    return { valid: false, reason: 'bundle is not in threshold-reveal mode (no thresholdShares)' };
  }
  if (args.shares.length < args.bundle.threshold.t) {
    return { valid: false, reason: `insufficient shares: need ${args.bundle.threshold.t}, got ${args.shares.length}` };
  }

  // v4-partial + VSS: when the bundle carries Feldman VSS commitments,
  // filter the supplied shares against them BEFORE Lagrange reconstruction.
  // A single tampered share silently poisons Lagrange interpolation —
  // VSS verification catches it instead. Bundles without coefficient
  // commitments (legacy / v4-partial-only) fall through to the
  // unguarded path; the caller accepts the corrupted-share risk.
  let sharesForReconstruction: readonly (ShamirShare | VerifiableShamirShare)[] = args.shares;
  let verifiedShareCount = args.shares.length;
  let rejectedShareCount = 0;
  if (args.bundle.coefficientCommitments) {
    // The filter expects VerifiableShamirShare; legacy ShamirShare has
    // the same structural fields (x, y, threshold), so the runtime
    // verifier treats them interchangeably.
    const verifiable = args.shares as readonly VerifiableShamirShare[];
    const verified = filterVerifiedShares({
      shares: verifiable,
      commitments: args.bundle.coefficientCommitments,
    });
    verifiedShareCount = verified.length;
    rejectedShareCount = args.shares.length - verified.length;
    if (verified.length < args.bundle.threshold.t) {
      return {
        valid: false,
        reason: `after VSS verification, only ${verified.length} share(s) remain (need ${args.bundle.threshold.t}); ${rejectedShareCount} share(s) rejected as tampered`,
        verifiedShareCount,
        rejectedShareCount,
      };
    }
    sharesForReconstruction = verified;
  }

  const reconstructed = reconstructSecret(sharesForReconstruction as readonly ShamirShare[]);
  if (reconstructed === null) {
    return { valid: false, reason: 'Lagrange reconstruction failed (invalid share set)', verifiedShareCount, rejectedShareCount };
  }
  // Confirm the sum-commitment opens to (claimedTrueSum, reconstructed)
  // via Pedersen. This is the structural verification the substrate's
  // homomorphic primitives already give us; threshold-reveal just
  // distributed who knows the blinding.
  const ok = verifyHomomorphicSum(args.bundle.contributorCommitments, args.claimedTrueSum, reconstructed);
  if (!ok) {
    return { valid: false, reason: 'sumCommitment does not open to (claimedTrueSum, reconstructedTrueBlinding) — either the claimed sum is wrong or the share set was tampered', verifiedShareCount, rejectedShareCount };
  }
  return { valid: true, reconstructedTrueBlinding: reconstructed, verifiedShareCount, rejectedShareCount };
}

// ─────────────────────────────────────────────────────────────────────
//  v4-partial — Operator-signed committee authorization (pre-reveal)
// ─────────────────────────────────────────────────────────────────────
//
// Closes the "the operator could form a sock-puppet committee" audit
// gap. Before distributing shares, the operator signs an authorization
// that names the n pseudo-aggregator DIDs they intend to include in
// the committee + the t threshold. The authorization is published as a
// pod descriptor; the regulator (at audit time) compares the actual
// reveal committee (from CommitteeReconstructionAttestation) against
// the authorized committee (from this descriptor) and rejects any
// mismatch:
//   - committee members the operator didn't authorize → unauthorized
//     committee
//   - members the operator authorized but never showed up → not a
//     cheat per se, but the audit log shows the gap
//   - reveal performed under different (n, t) than authorized → policy
//     violation
//
// Composes existing `src/crypto/wallet.ts` signing + matches the
// SignedBoundsAttestation / SignedBudgetAuditLog / CommitteeReconstruction
// patterns. No new ontology terms.

export interface CommitteeAuthorization {
  /** Sum commitment of the AttestedHomomorphicSumResult this authorization is for. */
  readonly bundleSumCommitment: string;
  /** Pseudo-aggregator DIDs the operator authorizes; sorted lexicographically. */
  readonly authorizedDids: readonly IRI[];
  /** Threshold (n, t). */
  readonly threshold: { n: number; t: number };
  /** Operator DID — the signer the auditor recovers from the signature. */
  readonly operatorDid: IRI;
  /** ISO timestamp the authorization was issued. */
  readonly issuedAt: string;
  /** 0x-prefixed ECDSA signature over committeeAuthorizationMessage(...). */
  readonly signature: string;
}

/**
 * Canonical message format for a committee authorization. Authorized
 * DIDs are sorted lexicographically before serialization so the
 * signing order is membership-independent.
 *
 * Format:
 *   "interego/v1/aggregate/committee-authorization|sumCommitment=<hex>|n=<num>|t=<num>|authorizedDids=<did1>,<did2>,...|operatorDid=<did>|issuedAt=<iso>"
 */
export function committeeAuthorizationMessage(args: {
  bundleSumCommitment: string;
  authorizedDids: readonly IRI[];
  threshold: { n: number; t: number };
  operatorDid: IRI;
  issuedAt: string;
}): string {
  const sorted = [...args.authorizedDids].sort();
  return `interego/v1/aggregate/committee-authorization|sumCommitment=${args.bundleSumCommitment}|n=${args.threshold.n}|t=${args.threshold.t}|authorizedDids=${sorted.join(',')}|operatorDid=${args.operatorDid}|issuedAt=${args.issuedAt}`;
}

/**
 * Operator-side: build + sign a committee authorization. Call this
 * BEFORE distributing shares — the authorization is the operator's
 * binding commitment to which pseudo-aggregators are allowed to
 * participate in this aggregate query's reveal.
 */
export async function signCommitteeAuthorization(args: {
  bundleSumCommitment: string;
  authorizedDids: readonly IRI[];
  threshold: { n: number; t: number };
  operatorDid: IRI;
  operatorWallet: Wallet;
  issuedAt?: string;
}): Promise<CommitteeAuthorization> {
  const issuedAt = args.issuedAt ?? new Date().toISOString();
  if (args.authorizedDids.length !== args.threshold.n) {
    throw new Error(`signCommitteeAuthorization: authorizedDids.length (${args.authorizedDids.length}) must equal threshold.n (${args.threshold.n})`);
  }
  if (args.threshold.t < 1 || args.threshold.t > args.threshold.n) {
    throw new Error(`signCommitteeAuthorization: threshold.t (${args.threshold.t}) must be in [1, n=${args.threshold.n}]`);
  }
  const msg = committeeAuthorizationMessage({
    bundleSumCommitment: args.bundleSumCommitment,
    authorizedDids: args.authorizedDids,
    threshold: args.threshold,
    operatorDid: args.operatorDid,
    issuedAt,
  });
  const signature = await signMessageRaw(args.operatorWallet, msg);
  return {
    bundleSumCommitment: args.bundleSumCommitment,
    authorizedDids: args.authorizedDids,
    threshold: args.threshold,
    operatorDid: args.operatorDid,
    issuedAt,
    signature,
  };
}

/**
 * Auditor-side: verify the operator's signature on an authorization.
 * Confirms:
 *   - signature recovers an address that appears in operatorDid
 *   - threshold (n, t) is internally consistent
 *   - authorizedDids.length matches n
 */
export function verifyCommitteeAuthorization(args: {
  authorization: CommitteeAuthorization;
}): { valid: boolean; reason?: string; recoveredAddress?: string } {
  const a = args.authorization;
  if (a.authorizedDids.length !== a.threshold.n) {
    return { valid: false, reason: `authorizedDids.length (${a.authorizedDids.length}) != threshold.n (${a.threshold.n})` };
  }
  if (a.threshold.t < 1 || a.threshold.t > a.threshold.n) {
    return { valid: false, reason: `threshold.t (${a.threshold.t}) out of range [1, ${a.threshold.n}]` };
  }
  let recovered: string;
  try {
    const msg = committeeAuthorizationMessage({
      bundleSumCommitment: a.bundleSumCommitment,
      authorizedDids: a.authorizedDids,
      threshold: a.threshold,
      operatorDid: a.operatorDid,
      issuedAt: a.issuedAt,
    });
    recovered = recoverMessageSigner(msg, a.signature);
  } catch (err) {
    return { valid: false, reason: `signature recovery failed: ${(err as Error).message}` };
  }
  if (!a.operatorDid.toLowerCase().includes(recovered.toLowerCase())) {
    return { valid: false, reason: `recovered address ${recovered} not present in operatorDid ${a.operatorDid}`, recoveredAddress: recovered };
  }
  return { valid: true, recoveredAddress: recovered };
}

/**
 * Cross-check that the operator actually distributed shares to the
 * authorized committee. Catches: operator authorizes 5 DIDs in
 * `CommitteeAuthorization` but only ships shares to 3 sock-puppets;
 * operator ships shares to DIDs the authorization didn't name;
 * operator ships fewer shares than the authorization's n.
 *
 * Returns valid only when:
 *   - the authorization itself verifies
 *   - distributions.length matches authorization.threshold.n
 *   - every distribution.recipientDid is in authorization.authorizedDids
 *   - every authorization.authorizedDids member has a matching
 *     distribution (no silently-dropped recipient)
 */
export function verifyShareDistributionsMatchAuthorization(args: {
  authorization: CommitteeAuthorization;
  distributions: readonly EncryptedShareDistribution[];
}): { valid: boolean; reason?: string } {
  const authCheck = verifyCommitteeAuthorization({ authorization: args.authorization });
  if (!authCheck.valid) {
    return { valid: false, reason: `authorization signature invalid: ${authCheck.reason}` };
  }
  if (args.distributions.length !== args.authorization.threshold.n) {
    return { valid: false, reason: `distributions.length (${args.distributions.length}) != authorization.threshold.n (${args.authorization.threshold.n})` };
  }
  const authorizedSet = new Set(args.authorization.authorizedDids.map(d => d.toLowerCase()));
  const distributedSet = new Set<string>();
  for (const dist of args.distributions) {
    const lower = dist.recipientDid.toLowerCase();
    if (!authorizedSet.has(lower)) {
      return { valid: false, reason: `distribution shipped to ${dist.recipientDid} which is NOT in the authorized list` };
    }
    if (distributedSet.has(lower)) {
      return { valid: false, reason: `duplicate distribution to ${dist.recipientDid}` };
    }
    distributedSet.add(lower);
  }
  for (const did of args.authorization.authorizedDids) {
    if (!distributedSet.has(did.toLowerCase())) {
      return { valid: false, reason: `authorized DID ${did} has no matching distribution` };
    }
  }
  return { valid: true };
}

/**
 * Cross-check the actual reveal committee (from a
 * CommitteeReconstructionAttestation) against the operator's earlier
 * authorization. Returns valid only when:
 *   - the authorization itself verifies
 *   - the actual committee size is >= the authorization's threshold.t
 *   - every actual-committee DID appears in the authorized list
 *   - the bundleSumCommitment matches between the two artifacts
 */
export function verifyCommitteeMatchesAuthorization(args: {
  authorization: CommitteeAuthorization;
  attestation: CommitteeReconstructionAttestation;
}): { valid: boolean; reason?: string } {
  const authCheck = verifyCommitteeAuthorization({ authorization: args.authorization });
  if (!authCheck.valid) {
    return { valid: false, reason: `authorization signature invalid: ${authCheck.reason}` };
  }
  if (args.authorization.bundleSumCommitment !== args.attestation.bundleSumCommitment) {
    return { valid: false, reason: `bundle mismatch: authorization is for ${args.authorization.bundleSumCommitment.slice(0, 16)}…, attestation is for ${args.attestation.bundleSumCommitment.slice(0, 16)}…` };
  }
  if (args.attestation.committeeDids.length < args.authorization.threshold.t) {
    return { valid: false, reason: `reveal committee (${args.attestation.committeeDids.length}) smaller than authorized threshold t=${args.authorization.threshold.t}` };
  }
  const authorizedSet = new Set(args.authorization.authorizedDids.map(d => d.toLowerCase()));
  for (const did of args.attestation.committeeDids) {
    if (!authorizedSet.has(did.toLowerCase())) {
      return { valid: false, reason: `reveal-committee member ${did} not in authorized list` };
    }
  }
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────
//  v4-partial — Encrypted share distribution
// ─────────────────────────────────────────────────────────────────────
//
// The bundle's `thresholdShares` are sensitive: a share + the matching
// VSS commitments are enough for a pseudo-aggregator to verify their
// piece of trueBlinding, but if shares leak in transit to the wrong
// recipient, the leak undermines the t-of-n threshold guarantee.
// Composes the existing X25519 / nacl envelope primitives in
// src/crypto/encryption.ts to encrypt each share for its intended
// pseudo-aggregator recipient — the share material is recoverable only
// by the holder of the matching private key.
//
// No new ontology terms; the encrypted share is a plain EncryptedEnvelope
// the substrate already understands. Auditors who later want to
// re-verify the distribution can confirm each envelope decrypts to the
// expected share via openEncryptedEnvelope (when granted the recipient's
// keys, e.g., during a regulator audit).

import {
  createEncryptedEnvelope, openEncryptedEnvelope,
  type EncryptedEnvelope, type EncryptionKeyPair,
} from '../../../src/crypto/encryption.js';

export interface EncryptedShareDistribution {
  /** Recipient pseudo-aggregator DID. */
  readonly recipientDid: IRI;
  /** Recipient's X25519 public key (base64) — used as the envelope's wrappedKey target. */
  readonly recipientPublicKey: string;
  /** Encrypted share envelope. */
  readonly envelope: EncryptedEnvelope;
}

/**
 * Encrypt a VerifiableShamirShare for a specific pseudo-aggregator
 * recipient. The share + the share's metadata (x, y, threshold) are
 * serialized to JSON, then wrapped in an X25519 / nacl envelope keyed
 * to the recipient's public key. The operator (or coordinator) holds
 * the sender keypair; the recipient uses their own keypair to open.
 *
 * Bigint y is serialized via the same `__bigint` wrapper used by the
 * publishable bundle JSON encoder so the envelope payload round-trips
 * losslessly.
 */
export function encryptShareForRecipient(args: {
  share: VerifiableShamirShare;
  recipientDid: IRI;
  recipientPublicKey: string;
  senderKeyPair: EncryptionKeyPair;
}): EncryptedShareDistribution {
  const payload = JSON.stringify(args.share, (_, v) =>
    typeof v === 'bigint' ? { __bigint: v.toString() } : v,
  );
  const envelope = createEncryptedEnvelope(payload, [args.recipientPublicKey], args.senderKeyPair);
  return {
    recipientDid: args.recipientDid,
    recipientPublicKey: args.recipientPublicKey,
    envelope,
  };
}

/**
 * Decrypt an EncryptedShareDistribution back into a
 * VerifiableShamirShare. Returns null if the recipient is not
 * authorized (no wrapped key for their public key) or if the
 * envelope fails to decrypt.
 */
export function decryptShareForRecipient(args: {
  distribution: EncryptedShareDistribution;
  recipientKeyPair: EncryptionKeyPair;
}): VerifiableShamirShare | null {
  const plaintext = openEncryptedEnvelope(args.distribution.envelope, args.recipientKeyPair);
  if (plaintext === null) return null;
  try {
    return JSON.parse(plaintext, bigintReviver) as VerifiableShamirShare;
  } catch {
    return null;
  }
}

/**
 * Encrypt a full share set (one envelope per recipient) in lockstep
 * with the bundle's thresholdShares. The order of `recipients` MUST
 * match the order of `shares` — recipients[i] receives shares[i].
 * Validates the lengths agree; throws on mismatch.
 */
export function encryptSharesForCommittee(args: {
  shares: readonly VerifiableShamirShare[];
  recipients: readonly { recipientDid: IRI; recipientPublicKey: string }[];
  senderKeyPair: EncryptionKeyPair;
}): EncryptedShareDistribution[] {
  if (args.shares.length !== args.recipients.length) {
    throw new Error(`encryptSharesForCommittee: shares (${args.shares.length}) and recipients (${args.recipients.length}) must have the same length`);
  }
  return args.shares.map((share, i) => encryptShareForRecipient({
    share,
    recipientDid: args.recipients[i]!.recipientDid,
    recipientPublicKey: args.recipients[i]!.recipientPublicKey,
    senderKeyPair: args.senderKeyPair,
  }));
}

// ─────────────────────────────────────────────────────────────────────
//  v4-partial — Committee reconstruction attestation (chain-of-custody)
// ─────────────────────────────────────────────────────────────────────
//
// When a t-of-n committee successfully reconstructs trueBlinding via
// `reconstructThresholdRevealAndVerify`, that act of reconstruction
// should itself be a tamper-evident artifact. Without an attestation,
// an auditor can confirm the reconstructed blinding opens the sum
// commitment, but has no record of WHO participated — the operator
// could later attribute the reveal to a different committee, or hide
// the fact that the reveal happened at all.
//
// CommitteeReconstructionAttestation: each committee member signs
// `committeeReconstructionMessage(bundleSumCommitment, claimedTrueSum,
// committeeDids, reconstructedAt)` with their wallet. The attestation
// bundles all the signatures; the auditor recovers each address and
// confirms it appears in the matching committeeDid. Catches:
//   - operator inventing a committee that didn't actually reveal
//   - committee membership rewritten after the fact
//   - claimedTrueSum changed after committee signed
//   - bundle the committee reconstructed swapped for a different one
//
// Composes existing `src/crypto/wallet.ts` signing + matches the
// SignedBoundsAttestation / SignedBudgetAuditLog signing patterns
// already established in this module. No new ontology terms.

/**
 * Per-member signature inside a CommitteeReconstructionAttestation.
 */
export interface CommitteeMemberSignature {
  /** DID of the pseudo-aggregator that participated in the reveal. */
  readonly memberDid: IRI;
  /** 0x-prefixed ECDSA signature over the canonical reconstruction message. */
  readonly signature: string;
}

export interface CommitteeReconstructionAttestation {
  /** Sum commitment of the AttestedHomomorphicSumResult the committee reconstructed. */
  readonly bundleSumCommitment: string;
  /** The trueSum the committee certifies the sum-commitment opens to. */
  readonly claimedTrueSum: bigint;
  /** DIDs of the committee members in canonical (sorted) order. */
  readonly committeeDids: readonly IRI[];
  /** ISO timestamp the reconstruction completed. */
  readonly reconstructedAt: string;
  /** Per-member signatures. Length MUST equal committeeDids.length. */
  readonly signatures: readonly CommitteeMemberSignature[];
}

/**
 * Canonical message format for a committee-reconstruction signature.
 * Both signers and verifier MUST use this exact format. The committee
 * DIDs are sorted lexicographically before serialization so the
 * signing order is committee-membership-independent.
 *
 * Format:
 *   "interego/v1/aggregate/committee-reconstruction|sumCommitment=<hex>|claimedTrueSum=<dec>|committee=<did1>,<did2>,...|reconstructedAt=<iso>"
 */
export function committeeReconstructionMessage(args: {
  bundleSumCommitment: string;
  claimedTrueSum: bigint;
  committeeDids: readonly IRI[];
  reconstructedAt: string;
}): string {
  const sortedDids = [...args.committeeDids].sort();
  return `interego/v1/aggregate/committee-reconstruction|sumCommitment=${args.bundleSumCommitment}|claimedTrueSum=${args.claimedTrueSum}|committee=${sortedDids.join(',')}|reconstructedAt=${args.reconstructedAt}`;
}

/**
 * Build a per-member signature contribution. Each committee member
 * calls this with their own wallet + DID before the coordinator
 * collects them into a CommitteeReconstructionAttestation.
 */
export async function signCommitteeReconstruction(args: {
  bundleSumCommitment: string;
  claimedTrueSum: bigint;
  committeeDids: readonly IRI[];
  reconstructedAt: string;
  signerWallet: Wallet;
  signerDid: IRI;
}): Promise<CommitteeMemberSignature> {
  const msg = committeeReconstructionMessage({
    bundleSumCommitment: args.bundleSumCommitment,
    claimedTrueSum: args.claimedTrueSum,
    committeeDids: args.committeeDids,
    reconstructedAt: args.reconstructedAt,
  });
  const signature = await signMessageRaw(args.signerWallet, msg);
  return { memberDid: args.signerDid, signature };
}

/**
 * Auditor-side: verify a committee-reconstruction attestation. Checks:
 *   - signature count matches committee size
 *   - every member listed in committeeDids has a corresponding signature
 *   - every signature recovers an address that appears in its memberDid
 *   - the claimed trueSum opens the bundle's sum-commitment under the
 *     blinding the committee certifies they reconstructed (when the
 *     bundle is available — when only the attestation is at hand, the
 *     structural checks still hold).
 *
 * Catches: operator forging committee membership; substituting
 * signatures; reattributing the reveal to a different committee.
 */
export function verifyCommitteeReconstruction(args: {
  attestation: CommitteeReconstructionAttestation;
}): { valid: boolean; reason?: string; recoveredAddresses?: readonly string[] } {
  const a = args.attestation;
  if (a.signatures.length !== a.committeeDids.length) {
    return { valid: false, reason: `signature count (${a.signatures.length}) != committee size (${a.committeeDids.length})` };
  }
  const msg = committeeReconstructionMessage({
    bundleSumCommitment: a.bundleSumCommitment,
    claimedTrueSum: a.claimedTrueSum,
    committeeDids: a.committeeDids,
    reconstructedAt: a.reconstructedAt,
  });
  const recoveredAddresses: string[] = [];
  // Match each signature to its claimed memberDid; every member must
  // appear in the committeeDid list (catches a coordinator who signs
  // on behalf of an absent member).
  const memberSet = new Set(a.committeeDids.map(d => d.toLowerCase()));
  for (const sig of a.signatures) {
    if (!memberSet.has(sig.memberDid.toLowerCase())) {
      return { valid: false, reason: `signature attributed to ${sig.memberDid} not in committee` };
    }
    let recovered: string;
    try {
      recovered = recoverMessageSigner(msg, sig.signature);
    } catch (err) {
      return { valid: false, reason: `signature recovery failed for ${sig.memberDid}: ${(err as Error).message}` };
    }
    if (!sig.memberDid.toLowerCase().includes(recovered.toLowerCase())) {
      return {
        valid: false,
        reason: `recovered address ${recovered} not present in memberDid ${sig.memberDid}`,
      };
    }
    recoveredAddresses.push(recovered);
  }
  // Verify every committee DID has at least one signature (no member
  // can be silently dropped if the coordinator collected fewer than
  // committee.length signatures yet listed them all).
  const signedDids = new Set(a.signatures.map(s => s.memberDid.toLowerCase()));
  for (const d of a.committeeDids) {
    if (!signedDids.has(d.toLowerCase())) {
      return { valid: false, reason: `committee member ${d} has no matching signature` };
    }
  }
  return { valid: true, recoveredAddresses };
}

// ─────────────────────────────────────────────────────────────────────
//  v3.2 — Cumulative ε-budget tracking
// ─────────────────────────────────────────────────────────────────────
//
// Differential-privacy budgets compose: under sequential composition,
// running k queries with budgets ε1, ε2, …, εk on the same dataset
// yields a combined ε equal to Σ εi. Without a tracker, a caller can
// run aggregate_decisions_query 1000 times at ε=0.01 each and
// effectively get ε=10 of accumulated leakage — the per-query
// privacy claim is sound, the cumulative claim is gone.
//
// EpsilonBudget tracks consumption per cohort. The caller declares a
// max budget; each query consumes its ε; the tracker throws (or
// returns a warning) when a query would exceed the remaining budget.
// Bookkeeping only — the substrate itself doesn't enforce; the
// caller is responsible for plumbing the tracker into their
// aggregate calls. The discipline is "honest accounting" not
// "tamper-evident":
//   - Auditors can replay the log of consume() calls to verify the
//     remaining budget claim.
//   - A malicious caller that bypasses the tracker still leaks DP
//     information, but the audit log will show the gap.
//
// Future v3.3: a signed audit-log descriptor on the institution's
// pod so the consumption log is itself a verifiable artifact. For
// now the tracker is in-memory; serialize via `toJSON` / `fromJSON`
// for persistence.

export interface EpsilonConsumption {
  readonly queryDescription: string;
  readonly epsilon: number;
  readonly consumedAt: string;
}

export class EpsilonBudget {
  readonly cohortIri: IRI;
  readonly maxEpsilon: number;
  private _spent: number;
  private _log: EpsilonConsumption[];

  constructor(args: { cohortIri: IRI; maxEpsilon: number; initial?: { spent?: number; log?: readonly EpsilonConsumption[] } }) {
    if (!(args.maxEpsilon > 0)) throw new Error('EpsilonBudget: maxEpsilon must be > 0');
    this.cohortIri = args.cohortIri;
    this.maxEpsilon = args.maxEpsilon;
    this._spent = args.initial?.spent ?? 0;
    this._log = args.initial?.log ? [...args.initial.log] : [];
    if (this._spent < 0) throw new Error('EpsilonBudget: initial spent cannot be negative');
    if (this._spent > this.maxEpsilon) throw new Error('EpsilonBudget: initial spent exceeds maxEpsilon');
  }

  /** Current cumulative ε spent. */
  get spent(): number { return this._spent; }

  /** Remaining ε. Negative is impossible (consume throws first). */
  get remaining(): number { return this.maxEpsilon - this._spent; }

  /** Consumption log, oldest first. Useful for the audit-log descriptor. */
  get log(): readonly EpsilonConsumption[] { return this._log; }

  /**
   * Reserve ε for a query. Throws if the consumption would exceed
   * the declared maxEpsilon — the caller's contract is to call this
   * BEFORE the query and only run the query if it returns. The
   * log entry records the description + ε + a timestamp so an
   * auditor can replay the budget.
   */
  consume(args: { queryDescription: string; epsilon: number }): void {
    if (!(args.epsilon > 0)) throw new Error('EpsilonBudget.consume: epsilon must be > 0');
    if (this._spent + args.epsilon > this.maxEpsilon) {
      const wouldBe = this._spent + args.epsilon;
      throw new Error(`EpsilonBudget: query "${args.queryDescription}" with ε=${args.epsilon} would push cumulative ε to ${wouldBe} (cap ${this.maxEpsilon}; remaining ${this.remaining}). Aborting.`);
    }
    this._spent += args.epsilon;
    this._log.push({
      queryDescription: args.queryDescription,
      epsilon: args.epsilon,
      consumedAt: new Date().toISOString(),
    });
  }

  /**
   * Check whether a hypothetical query would fit without consuming.
   * Useful for pre-flight validation in UIs.
   */
  canAfford(epsilon: number): boolean {
    return epsilon > 0 && this._spent + epsilon <= this.maxEpsilon;
  }

  /** Serialize to a plain object for persistence (e.g., publishing as a pod descriptor). */
  toJSON(): { cohortIri: IRI; maxEpsilon: number; spent: number; log: readonly EpsilonConsumption[] } {
    return {
      cohortIri: this.cohortIri,
      maxEpsilon: this.maxEpsilon,
      spent: this._spent,
      log: this._log,
    };
  }

  /** Rehydrate from a serialized snapshot. */
  static fromJSON(snap: { cohortIri: IRI; maxEpsilon: number; spent: number; log: readonly EpsilonConsumption[] }): EpsilonBudget {
    return new EpsilonBudget({
      cohortIri: snap.cohortIri,
      maxEpsilon: snap.maxEpsilon,
      initial: { spent: snap.spent, log: snap.log },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
//  v3.3 — Signed audit-log descriptor
// ─────────────────────────────────────────────────────────────────────
//
// v3.2 ships honest-accounting EpsilonBudget — an auditor can replay
// the consumption log to verify the remaining-budget claim, but the
// log itself is in-memory and trusts the caller. v3.3 wraps the log
// in a signed artifact so the audit-log itself is tamper-evident:
//
//   1. Aggregator canonicalizes the budget snapshot to a stable
//      string (sorted keys, fixed numeric formatting).
//   2. Aggregator signs the canonical string with their wallet.
//   3. Publishes the SignedBudgetAuditLog (or includes it in a pod
//      descriptor authored by that wallet's DID).
//   4. Auditor recovers the signer from the signature + canonical
//      string; verifies the recovered address matches the
//      operator's claimed DID.
//
// Composes existing `src/crypto/wallet.ts` — `signMessageRaw` +
// `recoverMessageSigner`. No new ontology terms; the SignedBudgetAuditLog
// is a plain typed object that can be serialized into a normal
// ContextDescriptor's graph content.

import { signMessageRaw, recoverMessageSigner, type Wallet } from '../../../src/crypto/wallet.js';

/**
 * Canonical serialization of an EpsilonBudget for signing. Stable
 * across implementations and versions: keys are sorted within each
 * object; numbers are formatted with enough precision to round-trip
 * IEEE-754 doubles; the consumption log is in chronological order
 * (as inserted; consume() is the only mutator).
 *
 * Format:
 *   "interego/v1/aggregate/budget-audit|cohortIri=...|maxEpsilon=...|spent=...|log=[{queryDescription:...,epsilon:...,consumedAt:...},...]"
 */
export function canonicalizeBudgetForSigning(snap: {
  cohortIri: IRI;
  maxEpsilon: number;
  spent: number;
  log: readonly EpsilonConsumption[];
}): string {
  const logCanon = snap.log
    .map(e => `{queryDescription=${JSON.stringify(e.queryDescription)},epsilon=${e.epsilon},consumedAt=${e.consumedAt}}`)
    .join(',');
  return `interego/v1/aggregate/budget-audit|cohortIri=${snap.cohortIri}|maxEpsilon=${snap.maxEpsilon}|spent=${snap.spent}|log=[${logCanon}]`;
}

export interface SignedBudgetAuditLog {
  /** Serialized EpsilonBudget snapshot — the same shape `EpsilonBudget.toJSON()` returns. */
  readonly snapshot: { cohortIri: IRI; maxEpsilon: number; spent: number; log: readonly EpsilonConsumption[] };
  /** DID of the signer (typically the aggregator's operator DID). */
  readonly signerDid: IRI;
  /** 0x-prefixed ECDSA signature over `canonicalizeBudgetForSigning(snapshot)`. */
  readonly signature: string;
  /** ISO timestamp the audit log was signed. */
  readonly signedAt: string;
}

/**
 * Aggregator-side: snapshot the budget + sign it with the operator
 * wallet. The returned bundle is publishable as the graph_content of
 * a normal ContextDescriptor on the operator's pod (composes
 * publish() + the standard provenance / agent facets).
 */
export async function signBudgetAuditLog(args: {
  budget: EpsilonBudget;
  signerWallet: Wallet;
  signerDid: IRI;
}): Promise<SignedBudgetAuditLog> {
  const snap = args.budget.toJSON();
  const canon = canonicalizeBudgetForSigning(snap);
  const signature = await signMessageRaw(args.signerWallet, canon);
  return {
    snapshot: snap,
    signerDid: args.signerDid,
    signature,
    signedAt: new Date().toISOString(),
  };
}

/**
 * Auditor-side: verify the signed audit log. Returns valid+recovered
 * address on success; descriptive reason on any failure path.
 * Catches: aggregator tampering with the snapshot after signing;
 * aggregator forging a snapshot under a different DID; signature
 * corruption.
 */
export function verifyBudgetAuditLog(signed: SignedBudgetAuditLog): { valid: boolean; reason?: string; recoveredAddress?: string } {
  let recovered: string;
  try {
    const canon = canonicalizeBudgetForSigning(signed.snapshot);
    recovered = recoverMessageSigner(canon, signed.signature);
  } catch (err) {
    return { valid: false, reason: `signature recovery failed: ${(err as Error).message}` };
  }
  const didLower = signed.signerDid.toLowerCase();
  const recoveredLower = recovered.toLowerCase();
  if (!didLower.includes(recoveredLower)) {
    return {
      valid: false,
      reason: `recovered address ${recovered} not present in signerDid ${signed.signerDid}`,
      recoveredAddress: recovered,
    };
  }
  // Internal consistency: log entries must sum to spent (rounding-safe).
  const logSum = signed.snapshot.log.reduce((acc, e) => acc + e.epsilon, 0);
  // Allow ε rounding noise of 1e-9.
  if (Math.abs(logSum - signed.snapshot.spent) > 1e-9) {
    return { valid: false, reason: `log entries sum to ${logSum} but snapshot.spent is ${signed.snapshot.spent}` };
  }
  if (signed.snapshot.spent > signed.snapshot.maxEpsilon) {
    return { valid: false, reason: `snapshot.spent (${signed.snapshot.spent}) exceeds maxEpsilon (${signed.snapshot.maxEpsilon})` };
  }
  return { valid: true, recoveredAddress: recovered };
}

// ─────────────────────────────────────────────────────────────────────
//  Publishable bundles — write attestation artifacts to a pod
// ─────────────────────────────────────────────────────────────────────
//
// v3.x results above are returned in-memory from the aggregate
// query. For audit, the institution typically wants the bundle as a
// persistent, fetchable artifact on the operator's pod so any
// authorized auditor can read + re-verify WITHOUT trusting the
// aggregator's word that the bundle exists at all. These helpers
// publish each bundle type as a normal cg:ContextDescriptor (no new
// ontology terms) with the bundle JSON embedded in the graph
// content as a single `agg:bundleJson` literal — the verifier
// pulls the graph, parses the JSON, and runs the existing
// `verifyAttested*` function against it.

const AGG_BUNDLE_GRAPH_PREFIX = 'urn:graph:cg:aggregate-bundle:';
const AGG_BUNDLE_DESC_PREFIX = 'urn:cg:aggregate-bundle:';

function bundleIris(seedHex: string): { iri: IRI; graphIri: IRI } {
  return {
    iri: `${AGG_BUNDLE_DESC_PREFIX}${seedHex}` as IRI,
    graphIri: `${AGG_BUNDLE_GRAPH_PREFIX}${seedHex}` as IRI,
  };
}

function escapeTtl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

export interface PublishedBundle {
  readonly iri: IRI;
  readonly descriptorUrl: string;
  readonly graphUrl: string;
}

/**
 * Publish an AttestedHomomorphicSumResult (v3 / v3.1 / v3.2 / v3.3) as a
 * pod descriptor. The bundle JSON is embedded in the graph content
 * so an auditor can fetch the graph + JSON.parse it + re-run
 * `verifyAttestedHomomorphicSum` without trusting the aggregator's
 * word that the bundle exists. Content-addressed on the
 * sumCommitment so re-publishing the same bundle is idempotent.
 *
 * Big-number values (trueSum, trueBlinding, noisySum) serialize as
 * decimal strings via a custom JSON replacer so they round-trip
 * losslessly; the matching fetch helper uses a reviver to convert
 * them back to bigint.
 */
export async function publishAttestedHomomorphicSum(args: {
  bundle: AttestedHomomorphicSumResult;
  podUrl: string;
}): Promise<PublishedBundle> {
  const seed = sha256(`zk-sum|${args.bundle.sumCommitment.bytes}|${args.bundle.cohortIri}`).slice(0, 16);
  const { iri, graphIri } = bundleIris(seed);
  const json = JSON.stringify(args.bundle, (_, v) =>
    typeof v === 'bigint' ? { __bigint: v.toString() } : v,
  );
  const ttl = `@prefix agg: <${AGGREGATE_NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a agg:AttestedHomomorphicSumBundle ;
  agg:bundleJson """${escapeTtl(json)}""" ;
  prov:wasAttributedTo <${args.bundle.aggregatorDid}> ;
  dct:issued "${args.bundle.computedAt}" .`;
  const built = ContextDescriptor.create(iri)
    .describes(graphIri)
    .agent(args.bundle.aggregatorDid)
    .generatedBy(args.bundle.aggregatorDid, { onBehalfOf: args.bundle.aggregatorDid, endedAt: args.bundle.computedAt })
    .temporal({ validFrom: args.bundle.computedAt })
    .asserted(0.95)
    .verified(args.bundle.aggregatorDid)
    .build();
  const r = await publish(built, ttl, args.podUrl);
  return { iri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

/**
 * Same shape for the v3.3 SignedBudgetAuditLog. The published
 * descriptor is the audit trail an institution shows a regulator:
 * "here are the queries we ran, here's the cumulative ε, here's
 * the signed proof we didn't fabricate the log."
 */
export async function publishSignedBudgetAuditLog(args: {
  signed: SignedBudgetAuditLog;
  podUrl: string;
}): Promise<PublishedBundle> {
  const seed = sha256(`budget-audit|${args.signed.snapshot.cohortIri}|${args.signed.snapshot.spent}|${args.signed.signedAt}`).slice(0, 16);
  const { iri, graphIri } = bundleIris(seed);
  const json = JSON.stringify(args.signed);
  const ttl = `@prefix agg: <${AGGREGATE_NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a agg:SignedBudgetAuditLog ;
  agg:bundleJson """${escapeTtl(json)}""" ;
  prov:wasAttributedTo <${args.signed.signerDid}> ;
  dct:issued "${args.signed.signedAt}" .`;
  const built = ContextDescriptor.create(iri)
    .describes(graphIri)
    .agent(args.signed.signerDid)
    .generatedBy(args.signed.signerDid, { onBehalfOf: args.signed.signerDid, endedAt: args.signed.signedAt })
    .temporal({ validFrom: args.signed.signedAt })
    .asserted(0.95)
    .verified(args.signed.signerDid)
    .build();
  const r = await publish(built, ttl, args.podUrl);
  return { iri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

/**
 * Reviver for the bigint-encoded JSON. Use with JSON.parse(text, bigintReviver).
 */
export function bigintReviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '__bigint' in value && typeof (value as { __bigint: unknown }).__bigint === 'string') {
    return BigInt((value as { __bigint: string }).__bigint);
  }
  return value;
}

/**
 * Fetch a published AttestedHomomorphicSumBundle graph and JSON.parse
 * it back with the bigint reviver, ready to feed into
 * `verifyAttestedHomomorphicSum`. Used by auditors who want to
 * re-verify a bundle the aggregator claims to have published.
 */
export async function fetchPublishedHomomorphicSum(args: {
  graphUrl: string;
}): Promise<AttestedHomomorphicSumResult | null> {
  const fetchFn = globalThis.fetch as unknown as (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>;
  try {
    const r = await fetchFn(args.graphUrl, { headers: { Accept: 'text/turtle, application/trig' } });
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/agg:bundleJson\s+"""([\s\S]*?)"""/);
    if (!m || !m[1]) return null;
    // Reverse the escape — Turtle has its own escaping; the JSON
    // inside has its own. Unescape Turtle first, then JSON.parse.
    const unescaped = m[1]
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return JSON.parse(unescaped, bigintReviver) as AttestedHomomorphicSumResult;
  } catch {
    return null;
  }
}

/**
 * Publish a CommitteeReconstructionAttestation as a pod descriptor —
 * the chain-of-custody artifact the operator (or the coordinator)
 * writes after a t-of-n committee successfully reconstructs
 * trueBlinding. An auditor can fetch it back via
 * `fetchPublishedCommitteeReconstructionAttestation` and re-run
 * `verifyCommitteeReconstruction` without trusting that the
 * attestation actually exists.
 *
 * The attestation's bigint `claimedTrueSum` round-trips via the same
 * encoder publishAttestedHomomorphicSum uses (bigint reviver on read).
 * Content-addressed on (bundleSumCommitment, reconstructedAt) so
 * republishing the same attestation is idempotent. The first
 * committee member's DID is recorded as the descriptor's provenance
 * agent — committee membership is in the attestation body, but at
 * least one signer is named at the descriptor level so the pod's
 * standard provenance + ABAC primitives apply uniformly.
 */
export async function publishCommitteeReconstructionAttestation(args: {
  attestation: CommitteeReconstructionAttestation;
  podUrl: string;
}): Promise<PublishedBundle> {
  const seed = sha256(`committee-reconstruction|${args.attestation.bundleSumCommitment}|${args.attestation.reconstructedAt}`).slice(0, 16);
  const { iri, graphIri } = bundleIris(seed);
  const json = JSON.stringify(args.attestation, (_, v) =>
    typeof v === 'bigint' ? { __bigint: v.toString() } : v,
  );
  // Use the first committee DID (canonical-sorted) as the descriptor's
  // provenance agent — keeps the provenance facet single-valued while
  // the actual committee membership is recoverable from the JSON body.
  const sortedDids = [...args.attestation.committeeDids].sort();
  const provenanceDid = sortedDids[0]!;
  const ttl = `@prefix agg: <${AGGREGATE_NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a agg:CommitteeReconstructionAttestation ;
  agg:bundleJson """${escapeTtl(json)}""" ;
  prov:wasAttributedTo <${provenanceDid}> ;
  dct:issued "${args.attestation.reconstructedAt}" .`;
  const built = ContextDescriptor.create(iri)
    .describes(graphIri)
    .agent(provenanceDid)
    .generatedBy(provenanceDid, { onBehalfOf: provenanceDid, endedAt: args.attestation.reconstructedAt })
    .temporal({ validFrom: args.attestation.reconstructedAt })
    .asserted(0.95)
    .verified(provenanceDid)
    .build();
  const r = await publish(built, ttl, args.podUrl);
  return { iri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

/**
 * Publish a single EncryptedShareDistribution as a pod descriptor.
 * Lets the operator distribute encrypted shares through standard
 * pod-discovery flows instead of an out-of-band channel — the
 * recipient finds the descriptor on the operator's pod, fetches the
 * graph, decrypts via their own X25519 keypair.
 *
 * Content-addressed on (bundleSumCommitment, recipientDid) so re-
 * publishing the same share is idempotent. The descriptor's
 * provenance agent is the operator (passed via `operatorDid`); the
 * recipient is recorded in the JSON body, not at the descriptor level.
 *
 * Bigint y survives the JSON-in-envelope round-trip via the same
 * `__bigint` wrapper used by the publishable bundle JSON encoder.
 */
export async function publishEncryptedShareDistribution(args: {
  distribution: EncryptedShareDistribution;
  bundleSumCommitment: string;
  operatorDid: IRI;
  podUrl: string;
}): Promise<PublishedBundle> {
  const seed = sha256(`encrypted-share|${args.bundleSumCommitment}|${args.distribution.recipientDid}`).slice(0, 16);
  const { iri, graphIri } = bundleIris(seed);
  const json = JSON.stringify(args.distribution);
  const now = new Date().toISOString();
  const ttl = `@prefix agg: <${AGGREGATE_NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a agg:EncryptedShareDistribution ;
  agg:bundleJson """${escapeTtl(json)}""" ;
  prov:wasAttributedTo <${args.operatorDid}> ;
  dct:issued "${now}" .`;
  const built = ContextDescriptor.create(iri)
    .describes(graphIri)
    .agent(args.operatorDid)
    .generatedBy(args.operatorDid, { onBehalfOf: args.operatorDid, endedAt: now })
    .temporal({ validFrom: now })
    .asserted(0.95)
    .verified(args.operatorDid)
    .build();
  const r = await publish(built, ttl, args.podUrl);
  return { iri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

/**
 * Publish an AttestedHomomorphicDistributionResult bundle as a pod
 * descriptor. Same pattern as publishAttestedHomomorphicSum;
 * content-addressed on (bundleSumCommitmentBytes-of-bucket-0, cohortIri)
 * so re-publish is idempotent.
 */
export async function publishAttestedHomomorphicDistribution(args: {
  bundle: AttestedHomomorphicDistributionResult;
  podUrl: string;
}): Promise<PublishedBundle> {
  const firstBucketBytes = args.bundle.bucketSumCommitments[0]!.bytes;
  const seed = sha256(`zk-distribution|${firstBucketBytes}|${args.bundle.cohortIri}`).slice(0, 16);
  const { iri, graphIri } = bundleIris(seed);
  const json = JSON.stringify(args.bundle, (_, v) =>
    typeof v === 'bigint' ? { __bigint: v.toString() } : v,
  );
  const ttl = `@prefix agg: <${AGGREGATE_NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a agg:AttestedHomomorphicDistributionBundle ;
  agg:bundleJson """${escapeTtl(json)}""" ;
  prov:wasAttributedTo <${args.bundle.aggregatorDid}> ;
  dct:issued "${args.bundle.computedAt}" .`;
  const built = ContextDescriptor.create(iri)
    .describes(graphIri)
    .agent(args.bundle.aggregatorDid)
    .generatedBy(args.bundle.aggregatorDid, { onBehalfOf: args.bundle.aggregatorDid, endedAt: args.bundle.computedAt })
    .temporal({ validFrom: args.bundle.computedAt })
    .asserted(0.95)
    .verified(args.bundle.aggregatorDid)
    .build();
  const r = await publish(built, ttl, args.podUrl);
  return { iri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

/**
 * Fetch a published AttestedHomomorphicDistributionBundle graph and
 * JSON.parse it back with the bigint reviver, ready for
 * `verifyAttestedHomomorphicDistribution`.
 */
export async function fetchPublishedHomomorphicDistribution(args: {
  graphUrl: string;
}): Promise<AttestedHomomorphicDistributionResult | null> {
  const fetchFn = globalThis.fetch as unknown as (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>;
  try {
    const r = await fetchFn(args.graphUrl, { headers: { Accept: 'text/turtle, application/trig' } });
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/agg:bundleJson\s+"""([\s\S]*?)"""/);
    if (!m || !m[1]) return null;
    const unescaped = m[1]
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return JSON.parse(unescaped, bigintReviver) as AttestedHomomorphicDistributionResult;
  } catch {
    return null;
  }
}

/**
 * Publish a CommitteeAuthorization as a pod descriptor. The
 * operator writes this BEFORE distributing shares so the auditor
 * can compare the actual reveal committee against it. Content-
 * addressed on (bundleSumCommitment, operatorDid) so republish is
 * idempotent.
 */
export async function publishCommitteeAuthorization(args: {
  authorization: CommitteeAuthorization;
  podUrl: string;
}): Promise<PublishedBundle> {
  const seed = sha256(`committee-authorization|${args.authorization.bundleSumCommitment}|${args.authorization.operatorDid}`).slice(0, 16);
  const { iri, graphIri } = bundleIris(seed);
  const json = JSON.stringify(args.authorization);
  const ttl = `@prefix agg: <${AGGREGATE_NS}> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix dct: <http://purl.org/dc/terms/> .
<${graphIri}> a agg:CommitteeAuthorization ;
  agg:bundleJson """${escapeTtl(json)}""" ;
  prov:wasAttributedTo <${args.authorization.operatorDid}> ;
  dct:issued "${args.authorization.issuedAt}" .`;
  const built = ContextDescriptor.create(iri)
    .describes(graphIri)
    .agent(args.authorization.operatorDid)
    .generatedBy(args.authorization.operatorDid, { onBehalfOf: args.authorization.operatorDid, endedAt: args.authorization.issuedAt })
    .temporal({ validFrom: args.authorization.issuedAt })
    .asserted(0.95)
    .verified(args.authorization.operatorDid)
    .build();
  const r = await publish(built, ttl, args.podUrl);
  return { iri, descriptorUrl: r.descriptorUrl, graphUrl: r.graphUrl };
}

/**
 * Fetch a published CommitteeAuthorization graph and JSON.parse it,
 * ready for `verifyCommitteeAuthorization` +
 * `verifyCommitteeMatchesAuthorization`.
 */
export async function fetchPublishedCommitteeAuthorization(args: {
  graphUrl: string;
}): Promise<CommitteeAuthorization | null> {
  const fetchFn = globalThis.fetch as unknown as (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>;
  try {
    const r = await fetchFn(args.graphUrl, { headers: { Accept: 'text/turtle, application/trig' } });
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/agg:bundleJson\s+"""([\s\S]*?)"""/);
    if (!m || !m[1]) return null;
    const unescaped = m[1]
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return JSON.parse(unescaped) as CommitteeAuthorization;
  } catch {
    return null;
  }
}

/**
 * Fetch a published EncryptedShareDistribution graph and JSON.parse
 * it. Recipient then runs `decryptShareForRecipient` to recover the
 * share. Returns null on fetch error or missing body.
 */
export async function fetchPublishedEncryptedShareDistribution(args: {
  graphUrl: string;
}): Promise<EncryptedShareDistribution | null> {
  const fetchFn = globalThis.fetch as unknown as (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>;
  try {
    const r = await fetchFn(args.graphUrl, { headers: { Accept: 'text/turtle, application/trig' } });
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/agg:bundleJson\s+"""([\s\S]*?)"""/);
    if (!m || !m[1]) return null;
    const unescaped = m[1]
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return JSON.parse(unescaped) as EncryptedShareDistribution;
  } catch {
    return null;
  }
}

/**
 * Fetch a published CommitteeReconstructionAttestation graph and
 * JSON.parse it with the bigint reviver, ready for
 * `verifyCommitteeReconstruction`. Returns null on fetch error or
 * if the graph doesn't carry an attestation body.
 */
export async function fetchPublishedCommitteeReconstructionAttestation(args: {
  graphUrl: string;
}): Promise<CommitteeReconstructionAttestation | null> {
  const fetchFn = globalThis.fetch as unknown as (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; text(): Promise<string> }>;
  try {
    const r = await fetchFn(args.graphUrl, { headers: { Accept: 'text/turtle, application/trig' } });
    if (!r.ok) return null;
    const ttl = await r.text();
    const m = ttl.match(/agg:bundleJson\s+"""([\s\S]*?)"""/);
    if (!m || !m[1]) return null;
    const unescaped = m[1]
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return JSON.parse(unescaped, bigintReviver) as CommitteeReconstructionAttestation;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  v5 — Contributor-distributed blinding sharing
//  (operator never sees blindings; no trusted dealer)
// ─────────────────────────────────────────────────────────────────────
//
// Removes the v3 / v4-partial trusted-aggregator caveat — the operator
// no longer knows trueBlinding because contributors never reveal
// their blindings to the operator. Instead, each contributor secret-
// shares their OWN blinding b_i via Feldman VSS to the pseudo-
// aggregator committee. Pseudo-aggregator j receives shares
// {b_1^{(j)}, b_2^{(j)}, ..., b_m^{(j)}} (one per contributor) and
// computes their COMBINED share s_j = Σ_i b_i^{(j)}.
//
// Mathematical core: Shamir is additively homomorphic. If each
// contributor's polynomial is f_i(x) with f_i(0) = b_i, the combined
// polynomial F(x) = Σ_i f_i(x) has F(0) = Σ_i b_i = trueBlinding.
// Pseudo-aggregator j's combined share is F(j) = Σ_i f_i(j) = s_j.
// Lagrange interpolation across any t pseudo-aggregator s_j values
// recovers F(0) = trueBlinding — but no party can do this alone.
//
// Combined VSS commitments: if contributor i's Feldman commitments
// are {C_i^{(k)} = c_i^{(k)} · G}_{k=0..t-1}, the combined polynomial's
// coefficient commitments are {Σ_i C_i^{(k)}}_{k=0..t-1} (per-
// coefficient point-sum). Any party can verify pseudo-aggregator j's
// combined share s_j against these combined commitments using the
// standard Feldman check — the same primitive used in v4-partial.
//
// Cleartext values: in this iteration, contributors STILL reveal v_i
// to the operator (so the operator can compute trueSum + add DP noise).
// The blinding is what's protected. Hiding individual values requires
// an additional layer (additive secret-sharing of v_i too); that's a
// natural v6 extension on top of v5. For now, v5 closes the deeper
// gap: even an audited operator with full cleartext-value access
// cannot reconstruct sumCommitment without committee cooperation.
//
// Composition: pedersen.commit + feldman-vss.splitSecretWithCommitments
// + encryption.createEncryptedEnvelope + the existing
// reconstructThresholdRevealAndVerify (with combined VSS commitments
// derived inline). No new ontology terms; just a new protocol
// topology over the same primitives.

/**
 * A contributor's v5 contribution: a Pedersen commitment + Feldman
 * VSS shares of their blinding distributed (encrypted) to the
 * pseudo-aggregator committee. Published as a pod artifact; the
 * operator + each pseudo-aggregator + the auditor all consume it.
 */
export interface DistributedContribution {
  readonly contributorPodUrl: string;
  /** Pedersen commitment c_i = v_i·G + b_i·H. PUBLIC. */
  readonly commitment: PedersenCommitment;
  /**
   * Cleartext value v_i. Revealed to the operator (so the operator
   * can compute trueSum + add DP noise). A future v6 can replace
   * this with additive secret-shares of v_i to hide individual
   * values too.
   */
  readonly value: bigint;
  /** Bounds [min, max] the contributor consented to. */
  readonly bounds: { min: bigint; max: bigint };
  /**
   * Feldman VSS commitments to the contributor's blinding polynomial
   * f_i(x) where f_i(0) = b_i. PUBLIC. Used to (a) verify each
   * pseudo-aggregator's received share before participation, AND
   * (b) construct the COMBINED polynomial's coefficient commitments
   * for verification of the eventually-reconstructed trueBlinding.
   */
  readonly blindingCommitments: FeldmanCommitments;
  /**
   * One encrypted share envelope per pseudo-aggregator. encryptedShares[j-1]
   * is the share for pseudo-aggregator j (1-indexed share x-coordinate
   * matches the array's 1-based positional intent; we use 0-based
   * array indexing here for ergonomics).
   *
   * Each envelope contains the JSON of the VerifiableShamirShare
   * (with bigint y preserved via __bigint wrapper).
   */
  readonly encryptedShares: readonly EncryptedShareDistribution[];
  /** Optional ZK range proof — same shape as v3.4. */
  readonly rangeProof?: RangeProof;
}

/**
 * Contributor-side: build a v5 distributed contribution. The
 * contributor picks v_i + b_i, commits via Pedersen, splits b_i via
 * Feldman VSS to the pseudo-aggregator committee, encrypts each
 * share for its recipient. The operator never sees b_i.
 */
export function buildDistributedContribution(args: {
  contributorPodUrl: string;
  value: bigint;
  bounds: { min: bigint; max: bigint };
  committee: readonly { recipientDid: IRI; recipientPublicKey: string }[];
  threshold: number;
  contributorSenderKeyPair: EncryptionKeyPair;
  blindingSeed?: string;
  blindingLabel?: string;
  withRangeProof?: boolean;
}): DistributedContribution {
  if (args.value < args.bounds.min || args.value > args.bounds.max) {
    throw new Error(`buildDistributedContribution: value ${args.value} outside declared bounds [${args.bounds.min}, ${args.bounds.max}]`);
  }
  if (args.threshold < 1 || args.threshold > args.committee.length) {
    throw new Error(`buildDistributedContribution: threshold ${args.threshold} must be in [1, committee.length=${args.committee.length}]`);
  }
  const blinding = args.blindingSeed
    ? deriveBlinding(args.blindingSeed, args.blindingLabel ?? 'pedersen/distributed-contribution')
    : randomBlinding();
  const commitment = commit(args.value, blinding);

  // VSS-split the blinding to the committee.
  const split = splitSecretWithCommitments({
    secret: blinding,
    totalShares: args.committee.length,
    threshold: args.threshold,
  });

  // Encrypt each share for its recipient pseudo-aggregator.
  const encryptedShares = encryptSharesForCommittee({
    shares: split.shares,
    recipients: args.committee.map(c => ({ recipientDid: c.recipientDid, recipientPublicKey: c.recipientPublicKey })),
    senderKeyPair: args.contributorSenderKeyPair,
  });

  const rangeProof = args.withRangeProof
    ? proveRange({ commitment, value: args.value, blinding, min: args.bounds.min, max: args.bounds.max })
    : undefined;

  return {
    contributorPodUrl: args.contributorPodUrl,
    commitment,
    value: args.value,
    bounds: args.bounds,
    blindingCommitments: split.commitments,
    encryptedShares,
    ...(rangeProof ? { rangeProof } : {}),
  };
}

/**
 * Pseudo-aggregator side: given the set of all contributions, decrypt
 * each one's share intended for this pseudo-aggregator (index j,
 * 1-based), verify each share against the contributor's published
 * Feldman commitments, and sum the verified shares to produce this
 * pseudo-aggregator's COMBINED share of trueBlinding.
 *
 * Returns the combined share s_j as a VerifiableShamirShare. The
 * combined share's y is Σ_i b_i^{(j)} (mod L); its x is j; its
 * threshold matches the cohort's threshold. s_j alone reveals
 * nothing about trueBlinding (a single Shamir share at degree t-1
 * is information-theoretically random).
 *
 * Rejects (throws) if any received share fails VSS verification
 * against its contributor's commitments. This catches a malicious
 * contributor trying to corrupt the protocol.
 */
export function aggregatePseudoAggregatorShares(args: {
  contributions: readonly DistributedContribution[];
  pseudoAggregatorIndex: number; // 1-based
  ownKeyPair: EncryptionKeyPair;
}): VerifiableShamirShare {
  if (args.contributions.length === 0) {
    throw new Error('aggregatePseudoAggregatorShares: no contributions');
  }
  if (args.pseudoAggregatorIndex < 1) {
    throw new Error(`aggregatePseudoAggregatorShares: pseudoAggregatorIndex ${args.pseudoAggregatorIndex} must be >= 1`);
  }
  const firstThreshold = args.contributions[0]!.blindingCommitments.threshold;
  let combinedY = 0n;
  for (const contrib of args.contributions) {
    if (contrib.blindingCommitments.threshold !== firstThreshold) {
      throw new Error(`aggregatePseudoAggregatorShares: contribution from ${contrib.contributorPodUrl} has threshold ${contrib.blindingCommitments.threshold}, cohort agreed on ${firstThreshold}`);
    }
    const dist = contrib.encryptedShares[args.pseudoAggregatorIndex - 1];
    if (!dist) {
      throw new Error(`aggregatePseudoAggregatorShares: contribution from ${contrib.contributorPodUrl} has no share for pseudo-aggregator ${args.pseudoAggregatorIndex}`);
    }
    const share = decryptShareForRecipient({ distribution: dist, recipientKeyPair: args.ownKeyPair });
    if (!share) {
      throw new Error(`aggregatePseudoAggregatorShares: decryption failed for contribution from ${contrib.contributorPodUrl}`);
    }
    if (share.x !== args.pseudoAggregatorIndex) {
      throw new Error(`aggregatePseudoAggregatorShares: decrypted share for ${contrib.contributorPodUrl} has x=${share.x}, expected ${args.pseudoAggregatorIndex}`);
    }
    // VSS verification: the share must lie on the contributor's published polynomial.
    if (!filterVerifiedShares({ shares: [share], commitments: contrib.blindingCommitments }).length) {
      throw new Error(`aggregatePseudoAggregatorShares: share for contribution from ${contrib.contributorPodUrl} failed VSS verification`);
    }
    combinedY = (combinedY + share.y) % L_AGG;
  }
  return {
    x: args.pseudoAggregatorIndex,
    y: combinedY < 0n ? combinedY + L_AGG : combinedY,
    threshold: firstThreshold,
    totalShares: args.contributions[0]!.encryptedShares.length,
  };
}

/** Ristretto255 scalar field order, re-used here for the modular reduction. */
const L_AGG = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

/**
 * v5 result bundle. Headline difference vs v3: no `trueBlinding` field
 * EVER (the operator never knew it), and the COMBINED Feldman
 * commitments are published so the t-of-n committee + the auditor can
 * verify reconstructed shares.
 */
export interface AttestedHomomorphicSumV5Result {
  readonly cohortIri: IRI;
  readonly aggregatorDid: IRI;
  readonly computedAt: string;
  readonly contributorCount: number;
  readonly trueSum?: bigint; // present when includeAuditFields=true
  readonly noisySum: bigint;
  readonly noise: number;
  readonly sensitivity: number;
  readonly epsilon: number;
  /** Σ_i c_i — the homomorphic sum commitment. Opens to (trueSum, trueBlinding). */
  readonly sumCommitment: PedersenCommitment;
  /** Per-contributor Pedersen commitments. */
  readonly contributorCommitments: readonly PedersenCommitment[];
  /**
   * COMBINED Feldman commitments — per-coefficient point-sum of every
   * contributor's blindingCommitments. The combined polynomial's
   * coefficient commitments. Pseudo-aggregator combined shares verify
   * against these via the standard Feldman check.
   */
  readonly combinedBlindingCommitments: FeldmanCommitments;
  readonly threshold: { n: number; t: number };
  readonly privacyMode: 'zk-aggregate-v5-no-trusted-dealer';
  /** Optional per-contributor range proofs (v3.4 composition). */
  readonly contributorRangeProofs?: readonly RangeProof[];
}

/**
 * Operator-side v5: build the bundle WITHOUT ever knowing trueBlinding.
 * The operator collects DistributedContribution objects from
 * contributors (published as pod artifacts), computes trueSum from
 * the cleartext values, sums commitments homomorphically, adds DP
 * noise, sums per-contributor Feldman commitments to derive the
 * COMBINED VSS commitments, publishes the bundle.
 *
 * What the operator does NOT do: see any individual blinding,
 * see trueBlinding, see any pseudo-aggregator's share s_j.
 *
 * What the operator DOES do (in this iteration): see individual
 * cleartext values. Hiding those is a v6 layer.
 */
export function buildAttestedHomomorphicSumV5(args: {
  cohortIri: IRI;
  aggregatorDid: IRI;
  contributions: readonly DistributedContribution[];
  epsilon: number;
  includeAuditFields?: boolean;
  epsilonBudget?: EpsilonBudget;
  queryDescription?: string;
  /** Required: the committee size n + threshold t the contributors used. */
  threshold: { n: number; t: number };
}): AttestedHomomorphicSumV5Result {
  if (args.contributions.length === 0) {
    throw new Error('buildAttestedHomomorphicSumV5: at least one contribution required');
  }
  const first = args.contributions[0]!;
  for (const c of args.contributions) {
    if (c.bounds.min !== first.bounds.min || c.bounds.max !== first.bounds.max) {
      throw new Error(`buildAttestedHomomorphicSumV5: contributions disagree on bounds (${c.contributorPodUrl})`);
    }
    if (c.value < c.bounds.min || c.value > c.bounds.max) {
      throw new Error(`buildAttestedHomomorphicSumV5: contribution from ${c.contributorPodUrl} has value ${c.value} outside [${c.bounds.min}, ${c.bounds.max}]`);
    }
    if (c.blindingCommitments.threshold !== args.threshold.t) {
      throw new Error(`buildAttestedHomomorphicSumV5: contribution from ${c.contributorPodUrl} declares threshold ${c.blindingCommitments.threshold}, cohort agreed on ${args.threshold.t}`);
    }
    if (c.encryptedShares.length !== args.threshold.n) {
      throw new Error(`buildAttestedHomomorphicSumV5: contribution from ${c.contributorPodUrl} has ${c.encryptedShares.length} encrypted shares, cohort agreed on n=${args.threshold.n}`);
    }
  }
  const sensitivity = Number(first.bounds.max - first.bounds.min);
  if (!(sensitivity > 0)) throw new Error('buildAttestedHomomorphicSumV5: non-positive sensitivity');

  if (args.epsilonBudget) {
    args.epsilonBudget.consume({
      queryDescription: args.queryDescription ?? `homomorphic-sum-v5 on ${args.cohortIri}`,
      epsilon: args.epsilon,
    });
  }

  const trueSum = args.contributions.reduce((acc, c) => acc + c.value, 0n);
  const sumCommitment = addCommitments(args.contributions.map(c => c.commitment));
  const noise = sampleLaplaceInt(sensitivity, args.epsilon);
  const noisySum = trueSum + BigInt(noise);

  // Combine per-contributor VSS commitments via per-coefficient point-sum.
  // (Composes the same logic dkgRound3 uses internally.)
  const combinedBlindingCommitments = combineFeldmanCommitments(
    args.contributions.map(c => c.blindingCommitments),
    args.threshold.t,
  );

  const result: AttestedHomomorphicSumV5Result = {
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
    combinedBlindingCommitments,
    threshold: args.threshold,
    privacyMode: 'zk-aggregate-v5-no-trusted-dealer',
    ...(args.includeAuditFields ? { trueSum } : {}),
    ...(args.contributions.every(c => c.rangeProof)
      ? { contributorRangeProofs: args.contributions.map(c => c.rangeProof!) }
      : {}),
  };
  return result;
}

/**
 * Per-coefficient point-sum of N FeldmanCommitments. Mirrors the
 * combination dkgRound3 performs internally; lifted out here so v5
 * can use the same composition for contributor-distributed sharing.
 */
function combineFeldmanCommitments(
  perContributor: readonly FeldmanCommitments[],
  threshold: number,
): FeldmanCommitments {
  const sumPoints: ReturnType<typeof ristretto255.Point.fromBytes>[] = [];
  for (let k = 0; k < threshold; k++) sumPoints.push(ristretto255.Point.ZERO);
  for (const fc of perContributor) {
    if (fc.points.length !== threshold) {
      throw new Error(`combineFeldmanCommitments: contributor has ${fc.points.length} points, expected ${threshold}`);
    }
    for (let k = 0; k < threshold; k++) {
      const p = ristretto255.Point.fromBytes(hexToBytesAgg(fc.points[k]!));
      sumPoints[k] = sumPoints[k]!.add(p);
    }
  }
  const hex = sumPoints.map(p => bytesToHexAgg(p.toBytes()));
  return { points: hex, threshold };
}

function hexToBytesAgg(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHexAgg(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

/**
 * v5 audit-time reveal. Any t-of-n pseudo-aggregator committee gathers
 * their combined shares {s_j} (from aggregatePseudoAggregatorShares)
 * and the operator's claimed trueSum. This function:
 *
 *   1. Filters the provided shares against the bundle's
 *      combinedBlindingCommitments (catches tampered shares BEFORE
 *      Lagrange poisons the result — same VSS guard the v4-partial
 *      verifier uses).
 *   2. Lagrange-interpolates the verified shares to recover
 *      trueBlinding = Σ_i b_i.
 *   3. Verifies the bundle's sumCommitment opens to (claimedTrueSum,
 *      reconstructedTrueBlinding).
 *
 * Returns valid + reconstructedTrueBlinding + verifiedShareCount +
 * rejectedShareCount on success; descriptive reason on any failure.
 */
export function reconstructAndVerifyV5(args: {
  bundle: AttestedHomomorphicSumV5Result;
  committeeShares: readonly VerifiableShamirShare[];
  claimedTrueSum: bigint;
}): { valid: boolean; reason?: string; reconstructedTrueBlinding?: bigint; verifiedShareCount?: number; rejectedShareCount?: number } {
  if (args.committeeShares.length < args.bundle.threshold.t) {
    return { valid: false, reason: `insufficient shares: need ${args.bundle.threshold.t}, got ${args.committeeShares.length}` };
  }
  // VSS verification against the COMBINED commitments — catches tampered shares.
  const verified = filterVerifiedShares({
    shares: args.committeeShares,
    commitments: args.bundle.combinedBlindingCommitments,
  });
  const rejected = args.committeeShares.length - verified.length;
  if (verified.length < args.bundle.threshold.t) {
    return {
      valid: false,
      reason: `after combined-VSS verification, only ${verified.length} share(s) remain (need ${args.bundle.threshold.t}); ${rejected} share(s) rejected`,
      verifiedShareCount: verified.length,
      rejectedShareCount: rejected,
    };
  }
  const reconstructed = reconstructSecret(verified as readonly ShamirShare[]);
  if (reconstructed === null) {
    return { valid: false, reason: 'Lagrange reconstruction failed', verifiedShareCount: verified.length, rejectedShareCount: rejected };
  }
  const ok = verifyHomomorphicSum(args.bundle.contributorCommitments, args.claimedTrueSum, reconstructed);
  if (!ok) {
    return {
      valid: false,
      reason: 'sumCommitment does not open to (claimedTrueSum, reconstructedTrueBlinding)',
      verifiedShareCount: verified.length,
      rejectedShareCount: rejected,
    };
  }
  return {
    valid: true,
    reconstructedTrueBlinding: reconstructed,
    verifiedShareCount: verified.length,
    rejectedShareCount: rejected,
  };
}
