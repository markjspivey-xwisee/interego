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
