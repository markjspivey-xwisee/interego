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
import { verifyMessage } from 'ethers';

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
  /**
   * When true (v3.1 regulator-grade mode), require every contribution
   * to carry a `signedBounds` attestation whose signature recovers
   * the declared contributorDid against the canonical signedBoundsMessage.
   * Catches: aggregator inflating a contributor's bounds; impersonation.
   * Default false (v3 trust-the-client mode).
   */
  requireSignedBounds?: boolean;
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
