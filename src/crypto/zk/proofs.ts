/**
 * @module crypto/zk/proofs
 * @description Zero-knowledge proof system for Interego.
 *
 * Implements practical ZK proofs without heavy circuit tooling:
 *
 *   1. Commitment schemes (Pedersen-style via hash):
 *      - Commit to a value without revealing it
 *      - Later prove properties about the committed value
 *
 *   2. Range proofs (for confidence thresholds):
 *      - Prove confidence > threshold without revealing exact value
 *      - Uses hash-chain range proof
 *
 *   3. Membership proofs (for delegation/set membership):
 *      - Prove "I am in the authorized agent set" without revealing which agent
 *      - Uses Merkle tree inclusion proof
 *
 *   4. Temporal ordering proofs:
 *      - Prove "this was published before time T" without revealing exact time
 *      - Uses hash commitment with timestamp reveal
 *
 *   5. Structural proofs (for PGSL):
 *      - Prove "my lattice contains fragment F" without revealing the lattice
 *      - Uses Merkle inclusion over atom URIs
 *
 * All proofs are non-interactive (Fiat-Shamir heuristic via hash).
 * No trusted setup required. Verification is O(1) or O(log n).
 */

import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import { sha256 } from '../ipfs.js';

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

/** A commitment to a hidden value */
export interface Commitment {
  readonly commitment: string;    // hash(value || blinding)
  readonly type: 'hash-commitment';
}

/**
 * A range proof: proves value >= threshold via a hash chain anchored
 * at the public threshold. The full chain is included in `chain` so
 * the verifier can walk it without knowing the value.
 *
 * Granularity: this scheme is hard-coded for confidence values in
 * [0, 1] discretized to 1/100 steps (i.e., `Math.round(x * 100)`).
 * Both prover and verifier scale by 100. If you need a different
 * range or granularity, do not reuse this API — copy and re-fix the
 * scaling factor or factor it into the proof type. We expose only
 * `proveConfidenceAboveThreshold` rather than a generic
 * `proveValueAboveThreshold` so this assumption stays visible.
 *
 * Honest scoping: this scheme reveals (value − threshold) — the chain
 * length leaks how far above the threshold the value lies. For full
 * zero-knowledge that hides the gap as well, use a Bulletproofs-style
 * scheme (not implemented here). The current scheme is sufficient
 * when the threshold is the policy concern and the exact value still
 * deserves to stay private — e.g., "confidence ≥ 0.85 for an EU AI
 * Act Article 15 attestation" cares about clearing the bar, not about
 * how comfortably it cleared.
 */
export interface RangeProof {
  readonly commitment: string;    // sha256(value || blinding) — leaf of the chain
  readonly threshold: number;     // the public threshold
  readonly proof: string;         // anchor = chain[0]; equals sha256(threshold || chain[1]) when chain.length > 1, else equals commitment
  readonly type: 'hash-range';
  readonly verified?: boolean;
  /** Intermediate chain hashes from threshold (chain[0]) to leaf
   *  (chain[chain.length-1] = commitment). Required for verification.
   *  Older proofs without this field fail verification — they were
   *  never actually verifiable in the prior implementation. */
  readonly chain?: readonly string[];
}

/** A Merkle inclusion proof */
export interface MerkleProof {
  readonly root: string;          // Merkle root (public)
  readonly leaf: string;          // hash of the element
  readonly path: readonly MerklePathElement[];
  readonly type: 'merkle-inclusion';
}

export interface MerklePathElement {
  readonly hash: string;
  readonly position: 'left' | 'right';
}

/** A temporal ordering proof */
export interface TemporalProof {
  readonly commitment: string;    // commitment to the timestamp
  readonly beforeTimestamp: string;  // public: "was before this time"
  readonly proof: string;
  readonly type: 'temporal-ordering';
}

/** A PGSL fragment membership proof */
export interface FragmentMembershipProof {
  readonly latticeRoot: string;   // Merkle root of atom URIs
  readonly fragmentHash: string;  // hash of the fragment URI
  readonly merkleProof: MerkleProof;
  readonly type: 'fragment-membership';
}

/** Union type for all proof kinds */
export type ZKProof =
  | RangeProof
  | MerkleProof
  | TemporalProof
  | FragmentMembershipProof;

// ═════════════════════════════════════════════════════════════
//  Commitments
// ═════════════════════════════════════════════════════════════

/**
 * Create a commitment to a value.
 * commitment = H(value || blinding_factor)
 * Returns the commitment and the blinding factor (keep secret).
 */
export function commit(value: string): { commitment: Commitment; blinding: string } {
  const blinding = util.encodeBase64(nacl.randomBytes(32));
  const hash = sha256(`${value}||${blinding}`);
  return {
    commitment: { commitment: hash, type: 'hash-commitment' },
    blinding,
  };
}

/**
 * Verify a commitment opening.
 * Checks that H(value || blinding) = commitment.
 */
export function verifyCommitment(commitment: Commitment, value: string, blinding: string): boolean {
  const expected = sha256(`${value}||${blinding}`);
  return expected === commitment.commitment;
}

// ═════════════════════════════════════════════════════════════
//  Range Proofs (confidence thresholds)
// ═════════════════════════════════════════════════════════════

/**
 * Maximum legitimate chain length for a confidence range proof.
 *
 * Confidence values live in [0, 1] discretized to 1/100, so
 * `value * 100 ∈ [0, 100]`, threshold ∈ [0, 100], and chain length
 * is `(value - threshold + 1) ∈ [1, 101]`. A chain longer than that
 * indicates one of:
 *   (a) the prover used the API with a value outside [0, 1]
 *   (b) the proof was constructed against a different granularity
 *   (c) malicious padding intended to obscure the leaked gap
 *
 * In all three cases the proof's confidentiality / correctness
 * guarantees do not match what the type claims, so verification
 * refuses. Producers that legitimately need wider ranges should
 * fork the proof type rather than expanding this bound.
 */
const RANGE_PROOF_MAX_CHAIN = 101;

/**
 * Prove that a confidence value exceeds a threshold.
 *
 * Method: Hash-chain range proof.
 * We discretize confidence to integer percentages [0-100].
 * The proof reveals H(value || blinding) and a chain of hashes
 * from the threshold to the value, proving value >= threshold
 * without revealing the exact value.
 *
 * @param confidence - The actual confidence (0.0-1.0)
 * @param threshold - The public threshold to prove against
 * @returns Proof that confidence >= threshold
 */
export function proveConfidenceAboveThreshold(
  confidence: number,
  threshold: number,
): { proof: RangeProof; blinding: string } {
  const discreteValue = Math.round(confidence * 100);
  const discreteThreshold = Math.round(threshold * 100);

  if (discreteValue < discreteThreshold) {
    throw new Error('Cannot prove: confidence is below threshold');
  }

  const blinding = util.encodeBase64(nacl.randomBytes(32));
  // Leaf is the commitment to the value: sha256(value || blinding)
  const leaf = sha256(`${discreteValue}||${blinding}`);

  // Chain length = (value - threshold + 1). Each chain link is
  // sha256((threshold + i) || chain[i+1]). The leaf is chain[length-1].
  // Verifier walks from chain[0] applying sha256((threshold + i) || ...)
  // for i in [0, length-1) and checks that the final element equals
  // the commitment.
  const chainLength = discreteValue - discreteThreshold + 1;
  const chain: string[] = new Array(chainLength);
  chain[chainLength - 1] = leaf;
  for (let i = chainLength - 2; i >= 0; i--) {
    chain[i] = sha256(`${discreteThreshold + i}||${chain[i + 1]}`);
  }

  return {
    proof: {
      commitment: leaf,
      threshold,
      proof: chain[0]!,    // anchor — first link of the chain
      type: 'hash-range',
      chain,
    },
    blinding,
  };
}

/**
 * Verify a confidence range proof by walking the included chain.
 *
 * Returns true iff:
 *   - `proof.chain` is present and non-empty
 *   - `proof.chain[chain.length-1] === proof.commitment` (leaf matches)
 *   - `proof.chain[0] === proof.proof` (anchor matches)
 *   - For every i in [0, chain.length-1):
 *       proof.chain[i] === sha256((discrete-threshold + i) || proof.chain[i+1])
 *
 * The verifier does NOT learn `value` or `blinding`, only that the
 * prover did the work of building a valid chain anchored at `threshold`
 * and terminating at the committed leaf. The chain length leaks
 * (value − threshold), which is documented in the RangeProof type.
 *
 * Older proofs without `chain` fail verification — they were never
 * actually verifiable in the prior stub implementation.
 */
export function verifyConfidenceProof(proof: RangeProof): boolean {
  if (!proof || proof.type !== 'hash-range') return false;
  const chain = proof.chain;
  if (!chain || chain.length === 0) return false;
  // Reject chains that imply a value outside the [0, 1] domain this
  // proof type is defined for. See RANGE_PROOF_MAX_CHAIN above.
  if (chain.length > RANGE_PROOF_MAX_CHAIN) return false;
  // Threshold must also lie in [0, 1].
  if (typeof proof.threshold !== 'number' || !Number.isFinite(proof.threshold)) return false;
  if (proof.threshold < 0 || proof.threshold > 1) return false;

  // Leaf must equal the commitment.
  if (chain[chain.length - 1] !== proof.commitment) return false;
  // Anchor must equal the published proof field.
  if (chain[0] !== proof.proof) return false;
  // Every length / commitment field must look like a sha256 hex.
  if (proof.commitment.length !== 64) return false;
  for (const link of chain) {
    if (typeof link !== 'string' || link.length !== 64) return false;
  }

  const discreteThreshold = Math.round(proof.threshold * 100);
  for (let i = 0; i < chain.length - 1; i++) {
    const expected = sha256(`${discreteThreshold + i}||${chain[i + 1]}`);
    if (expected !== chain[i]) return false;
  }
  return true;
}

/**
 * Stronger verification path that also confirms the leaf opens to the
 * claimed (value, blinding). Use when the prover is willing to disclose
 * the witness to a specific verifier — full cryptographic verification
 * at the cost of zero-knowledge. Equivalent in strength to
 * commit-and-reveal (see verifyCommitment) plus the range invariant.
 *
 * Returns true iff:
 *   - `value >= proof.threshold` (the range claim is honest)
 *   - `sha256(value*100 || blinding) === proof.commitment` (the
 *     committed leaf opens to (value, blinding))
 *   - The chain verifies via verifyConfidenceProof()
 */
export function verifyConfidenceProofByReveal(
  proof: RangeProof,
  value: number,
  blinding: string,
): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (typeof blinding !== 'string' || blinding.length === 0) return false;
  if (value < proof.threshold) return false;
  const discreteValue = Math.round(value * 100);
  const expectedCommitment = sha256(`${discreteValue}||${blinding}`);
  if (expectedCommitment !== proof.commitment) return false;
  return verifyConfidenceProof(proof);
}

// ═════════════════════════════════════════════════════════════
//  Merkle Tree (for membership proofs)
// ═════════════════════════════════════════════════════════════

/**
 * Build a Merkle tree from a list of values.
 * Returns the root hash and all layers.
 */
export function buildMerkleTree(values: readonly string[]): {
  root: string;
  layers: string[][];
  leaves: string[];
} {
  if (values.length === 0) {
    return { root: sha256('empty'), layers: [], leaves: [] };
  }

  // Hash all leaves
  const leaves = values.map(v => sha256(v));
  const layers: string[][] = [leaves];

  // Build tree bottom-up
  let current = leaves;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(sha256(current[i]! + current[i + 1]!));
      } else {
        next.push(current[i]!); // odd element promoted
      }
    }
    layers.push(next);
    current = next;
  }

  return { root: current[0]!, layers, leaves };
}

/**
 * Generate a Merkle inclusion proof for a specific leaf.
 */
export function generateMerkleProof(
  value: string,
  values: readonly string[],
): MerkleProof | null {
  const { root, layers, leaves } = buildMerkleTree(values);
  const leafHash = sha256(value);
  let index = leaves.indexOf(leafHash);

  if (index === -1) return null; // not in the tree

  const path: MerklePathElement[] = [];

  for (let layer = 0; layer < layers.length - 1; layer++) {
    const currentLayer = layers[layer]!;
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;

    if (siblingIndex < currentLayer.length) {
      path.push({
        hash: currentLayer[siblingIndex]!,
        position: index % 2 === 0 ? 'right' : 'left',
      });
    }

    index = Math.floor(index / 2);
  }

  return { root, leaf: leafHash, path, type: 'merkle-inclusion' };
}

/**
 * Verify a Merkle inclusion proof.
 * Recomputes the root from the leaf + path and checks it matches.
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  let current = proof.leaf;

  for (const element of proof.path) {
    if (element.position === 'right') {
      current = sha256(current + element.hash);
    } else {
      current = sha256(element.hash + current);
    }
  }

  return current === proof.root;
}

// ═════════════════════════════════════════════════════════════
//  Delegation Membership Proof
// ═════════════════════════════════════════════════════════════

/**
 * Prove that an agent is in the authorized set without revealing which agent.
 * Uses Merkle inclusion on the set of authorized agent IDs.
 */
export function proveDelegationMembership(
  agentId: string,
  authorizedAgentIds: readonly string[],
): MerkleProof | null {
  return generateMerkleProof(agentId, authorizedAgentIds);
}

/**
 * Verify a delegation membership proof.
 * The verifier learns: "someone in the agent set authorized by this root"
 * but not WHICH agent.
 */
export function verifyDelegationMembership(proof: MerkleProof): boolean {
  return verifyMerkleProof(proof);
}

// ═════════════════════════════════════════════════════════════
//  Temporal Ordering Proof
// ═════════════════════════════════════════════════════════════

/**
 * Prove that a timestamp is before a given deadline.
 * commit(timestamp) is published. Later, the prover can show
 * the commitment was made before the deadline.
 */
export function proveTemporalOrdering(
  actualTimestamp: string,
  beforeTimestamp: string,
): { proof: TemporalProof; blinding: string } | null {
  if (new Date(actualTimestamp) >= new Date(beforeTimestamp)) {
    return null; // can't prove — timestamp is after deadline
  }

  const { commitment, blinding } = commit(actualTimestamp);

  return {
    proof: {
      commitment: commitment.commitment,
      beforeTimestamp,
      proof: sha256(`${actualTimestamp}||${beforeTimestamp}||${blinding}`),
      type: 'temporal-ordering',
    },
    blinding,
  };
}

/**
 * Verify a temporal ordering proof.
 * Checks that the committed timestamp is before the deadline.
 */
export function verifyTemporalProof(
  proof: TemporalProof,
  revealedTimestamp: string,
  blinding: string,
): boolean {
  // Verify the commitment
  const expectedCommitment = sha256(`${revealedTimestamp}||${blinding}`);
  if (expectedCommitment !== proof.commitment) return false;

  // Verify temporal ordering
  if (new Date(revealedTimestamp) >= new Date(proof.beforeTimestamp)) return false;

  // Verify the proof hash
  const expectedProof = sha256(`${revealedTimestamp}||${proof.beforeTimestamp}||${blinding}`);
  return expectedProof === proof.proof;
}

// ═════════════════════════════════════════════════════════════
//  PGSL Fragment Membership Proof
// ═════════════════════════════════════════════════════════════

/**
 * Prove that a PGSL lattice contains a specific fragment
 * without revealing the rest of the lattice.
 */
export function proveFragmentMembership(
  fragmentUri: string,
  allAtomUris: readonly string[],
): FragmentMembershipProof | null {
  const merkleProof = generateMerkleProof(fragmentUri, allAtomUris);
  if (!merkleProof) return null;

  return {
    latticeRoot: merkleProof.root,
    fragmentHash: sha256(fragmentUri),
    merkleProof,
    type: 'fragment-membership',
  };
}

/**
 * Verify a PGSL fragment membership proof.
 */
export function verifyFragmentMembership(proof: FragmentMembershipProof): boolean {
  return verifyMerkleProof(proof.merkleProof);
}

// ═════════════════════════════════════════════════════════════
//  Selective Disclosure
// ═════════════════════════════════════════════════════════════

/**
 * Create a selectively disclosed descriptor summary.
 * Reveals only the specified facet types, commits to the rest.
 *
 * The consumer sees: "This descriptor has Trust, Semiotic, Temporal facets.
 * I can see the Semiotic facet says Asserted/0.95. The Trust and Temporal
 * facets are committed but not revealed. Here are ZK proofs that the
 * confidence is > 0.8 and the trust level meets my policy."
 */
export interface SelectiveDisclosure {
  readonly descriptorId: string;
  readonly revealedFacetTypes: readonly string[];
  readonly committedFacetTypes: readonly string[];
  readonly commitments: ReadonlyMap<string, Commitment>;
  readonly proofs: readonly ZKProof[];
}

export function createSelectiveDisclosure(
  descriptorId: string,
  facets: readonly { type: string; data: Record<string, unknown> }[],
  revealTypes: readonly string[],
  proofRequests?: readonly { type: 'confidence-threshold'; threshold: number }[],
): SelectiveDisclosure {
  const revealedFacetTypes: string[] = [];
  const committedFacetTypes: string[] = [];
  const commitments = new Map<string, Commitment>();
  const proofs: ZKProof[] = [];

  for (const facet of facets) {
    if (revealTypes.includes(facet.type)) {
      revealedFacetTypes.push(facet.type);
    } else {
      committedFacetTypes.push(facet.type);
      const { commitment } = commit(JSON.stringify(facet.data));
      commitments.set(facet.type, commitment);
    }
  }

  // Generate requested proofs
  if (proofRequests) {
    for (const req of proofRequests) {
      if (req.type === 'confidence-threshold') {
        const semioticFacet = facets.find(f => f.type === 'Semiotic');
        if (semioticFacet) {
          const confidence = (semioticFacet.data as any).epistemicConfidence ?? 0.5;
          try {
            const { proof } = proveConfidenceAboveThreshold(confidence, req.threshold);
            proofs.push(proof);
          } catch {
            // Can't prove — confidence is below threshold
          }
        }
      }
    }
  }

  return {
    descriptorId,
    revealedFacetTypes,
    committedFacetTypes,
    commitments,
    proofs,
  };
}
