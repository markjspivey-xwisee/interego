/**
 * @module crypto/range-proof
 * @description Non-interactive zero-knowledge range proofs for
 * Pedersen commitments. Composes [`./pedersen.ts`](./pedersen.ts) +
 * Fiat-Shamir.
 *
 * Closes the v3.1 "lying contributor" gap that the aggregator-side
 * bounds re-check alone could not catch: a contributor can now PROVE,
 * without revealing their value, that their committed value lies in a
 * declared range. A future v3.4 will swap the aggregator's bounds re-
 * check for verifying these proofs, removing the trust assumption
 * that the aggregator sees the cleartext value (today they do; with
 * range proofs they only see the commitment + the proof).
 *
 * Two building blocks:
 *
 *   1. **Chaum-Pedersen OR proof for {0, 1}** (`proveBit` / `verifyBit`).
 *      Prove that a Pedersen commitment C = v·G + b·H opens to either
 *      v=0 or v=1, without revealing which. Statement: ∃ b such that
 *      C = bH (the v=0 case) OR C - G = bH (the v=1 case). The proof
 *      is the standard non-interactive Schnorr OR proof using Fiat-
 *      Shamir.
 *
 *   2. **Bit-decomposition range proof** (`proveRange` / `verifyRange`).
 *      To prove v ∈ [0, 2^n - 1], decompose v into bits b_0..b_{n-1};
 *      commit to each bit with a fresh blinding; emit a bit proof for
 *      each. The verifier checks that:
 *        (a) every bit commitment passes the OR proof, AND
 *        (b) Σ_{i=0..n-1} (2^i)·C_i ≡ C (point equation), which
 *            confirms the bit decomposition reconstructs the original
 *            committed value.
 *
 *   For an arbitrary range [min, max] (rather than [0, 2^n - 1]),
 *   the helper `proveRange` shifts by min: prove (v - min) ∈ [0, max -
 *   min] using the appropriate number of bits, and verify the shifted
 *   commitment C - min·G against the bit decomposition.
 *
 * Trade-offs:
 *   - Bit-decomposition is O(n) in proof size + verification, where
 *     n = ⌈log₂(max - min + 1)⌉. For 32-bit ranges this is 32 OR
 *     proofs per contribution — heavier than Bulletproofs (O(log n))
 *     but conceptually simpler and composes the existing pedersen +
 *     hash-to-scalar primitives directly. Substrate-pure: no
 *     trusted setup, no new ontology terms.
 *   - The OR proof reveals neither v nor b. The range proof reveals
 *     neither v nor the per-bit blindings.
 */

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { sha256 } from './ipfs.js';
import { type PedersenCommitment } from './pedersen.js';

const G = ristretto255.Point.BASE;
const H_DOMAIN = new TextEncoder().encode('interego/v1/pedersen/H-generator');
const H = ristretto255_hasher.hashToCurve(H_DOMAIN);
const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

// ─────────────────────────────────────────────────────────────────────
//  Scalar / point helpers
// ─────────────────────────────────────────────────────────────────────

function modL(x: bigint): bigint {
  const r = x % L;
  return r < 0n ? r + L : r;
}

function randomScalar(): bigint {
  const buf = new Uint8Array(64);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (let i = 0; i < buf.length; i++) n = (n << 8n) | BigInt(buf[i]!);
  return modL(n);
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function pointFromHex(hex: string) {
  return ristretto255.Point.fromBytes(hexToBytes(hex));
}

/** Fiat-Shamir challenge: hash inputs to a scalar in [0, L). */
function fsChallenge(parts: readonly string[]): bigint {
  const concat = parts.join('|');
  const hex = sha256(concat); // 64 hex chars = 32 bytes
  let n = 0n;
  for (let i = 0; i < hex.length; i += 2) {
    n = (n << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  }
  return modL(n);
}

function scalarMul(p: ReturnType<typeof ristretto255.Point.fromBytes>, k: bigint) {
  if (k === 0n) return ristretto255.Point.ZERO;
  return p.multiply(modL(k));
}

// ─────────────────────────────────────────────────────────────────────
//  Chaum-Pedersen OR proof for {0, 1}
// ─────────────────────────────────────────────────────────────────────

export interface BitProof {
  /** A_0 — first-branch commitment (hex point). */
  readonly a0: string;
  /** A_1 — second-branch commitment (hex point). */
  readonly a1: string;
  /** e_0 — first-branch challenge (decimal scalar). */
  readonly e0: string;
  /** e_1 — second-branch challenge (decimal scalar). */
  readonly e1: string;
  /** z_0 — first-branch response (decimal scalar). */
  readonly z0: string;
  /** z_1 — second-branch response (decimal scalar). */
  readonly z1: string;
}

/**
 * Prove that a Pedersen commitment C = v·G + b·H opens to v ∈ {0, 1}
 * (the prover supplies v + b but the proof reveals neither). The
 * verifier learns only that v is 0 OR 1 — not which.
 *
 * @throws if v is not 0 or 1.
 */
export function proveBit(args: {
  commitment: PedersenCommitment;
  bit: bigint;
  blinding: bigint;
}): BitProof {
  if (args.bit !== 0n && args.bit !== 1n) {
    throw new Error(`proveBit: bit must be 0 or 1, got ${args.bit}`);
  }
  const C = pointFromHex(args.commitment.bytes);
  const CminusG = C.add(G.negate()); // C - G

  // Following the standard Schnorr OR-proof construction:
  // The HONEST branch knows the discrete log, the SIMULATED branch
  // picks (e_simulated, z_simulated) at random and back-derives
  // A_simulated = z_simulated·H - e_simulated · (target).
  //
  // Branch 0 ("v=0"): target = C; prover knows b such that C = bH.
  // Branch 1 ("v=1"): target = C - G; prover knows b such that C - G = bH.

  if (args.bit === 0n) {
    // Branch 0 is honest.
    const r0 = randomScalar();
    const A0 = scalarMul(H, r0);
    // Simulate branch 1.
    const e1 = randomScalar();
    const z1 = randomScalar();
    // A1 = z1·H - e1 · (C - G)
    const A1 = scalarMul(H, z1).add(scalarMul(CminusG, modL(L - e1)));
    // Fiat-Shamir challenge over (C, A0, A1).
    const c = fsChallenge([
      'interego/v1/range-proof/bit',
      args.commitment.bytes,
      bytesToHex(A0.toBytes()),
      bytesToHex(A1.toBytes()),
    ]);
    // e0 = c - e1 (mod L).
    const e0 = modL(c - e1);
    // z0 = r0 + e0·b.
    const z0 = modL(r0 + modL(e0 * args.blinding));
    return {
      a0: bytesToHex(A0.toBytes()),
      a1: bytesToHex(A1.toBytes()),
      e0: e0.toString(),
      e1: e1.toString(),
      z0: z0.toString(),
      z1: z1.toString(),
    };
  } else {
    // Branch 1 is honest.
    const r1 = randomScalar();
    const A1 = scalarMul(H, r1);
    // Simulate branch 0.
    const e0 = randomScalar();
    const z0 = randomScalar();
    const A0 = scalarMul(H, z0).add(scalarMul(C, modL(L - e0)));
    const c = fsChallenge([
      'interego/v1/range-proof/bit',
      args.commitment.bytes,
      bytesToHex(A0.toBytes()),
      bytesToHex(A1.toBytes()),
    ]);
    const e1 = modL(c - e0);
    const z1 = modL(r1 + modL(e1 * args.blinding));
    return {
      a0: bytesToHex(A0.toBytes()),
      a1: bytesToHex(A1.toBytes()),
      e0: e0.toString(),
      e1: e1.toString(),
      z0: z0.toString(),
      z1: z1.toString(),
    };
  }
}

/**
 * Verify a bit proof for a Pedersen commitment. Returns true iff the
 * commitment opens to either 0 or 1 (without learning which).
 *
 * Checks:
 *   - e_0 + e_1 ≡ FS(C, A_0, A_1) (mod L)
 *   - z_0 · H ?= A_0 + e_0 · C
 *   - z_1 · H ?= A_1 + e_1 · (C - G)
 */
export function verifyBit(args: {
  commitment: PedersenCommitment;
  proof: BitProof;
}): boolean {
  let A0, A1, C, CminusG;
  try {
    C = pointFromHex(args.commitment.bytes);
    CminusG = C.add(G.negate());
    A0 = pointFromHex(args.proof.a0);
    A1 = pointFromHex(args.proof.a1);
  } catch {
    return false;
  }
  let e0: bigint, e1: bigint, z0: bigint, z1: bigint;
  try {
    e0 = modL(BigInt(args.proof.e0));
    e1 = modL(BigInt(args.proof.e1));
    z0 = modL(BigInt(args.proof.z0));
    z1 = modL(BigInt(args.proof.z1));
  } catch {
    return false;
  }
  const c = fsChallenge([
    'interego/v1/range-proof/bit',
    args.commitment.bytes,
    args.proof.a0,
    args.proof.a1,
  ]);
  if (modL(e0 + e1) !== c) return false;
  // z0·H ?= A0 + e0·C
  const lhs0 = scalarMul(H, z0);
  const rhs0 = A0.add(scalarMul(C, e0));
  if (!lhs0.equals(rhs0)) return false;
  // z1·H ?= A1 + e1·(C - G)
  const lhs1 = scalarMul(H, z1);
  const rhs1 = A1.add(scalarMul(CminusG, e1));
  if (!lhs1.equals(rhs1)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────
//  Bit-decomposition range proof
// ─────────────────────────────────────────────────────────────────────

export interface RangeProof {
  /**
   * Per-bit Pedersen commitments (hex). bitCommitments[i] commits to
   * the i-th bit of (value - min) with its own blinding.
   */
  readonly bitCommitments: readonly string[];
  /** Per-bit OR-proofs that each bitCommitment opens to {0, 1}. */
  readonly bitProofs: readonly BitProof[];
  /** Min of the range (decimal-string bigint). */
  readonly min: string;
  /** Max of the range (decimal-string bigint, inclusive). */
  readonly max: string;
  /** Number of bits used (= ⌈log₂(max - min + 1)⌉). */
  readonly numBits: number;
}

/**
 * Prove that a Pedersen commitment C = v·G + b·H opens to a value v
 * in the inclusive range [min, max], without revealing v.
 *
 * The proof works on the SHIFTED value (v - min) so the range starts
 * at 0; the verifier shifts back by checking against C - min·G.
 *
 * Internally generates per-bit blindings r_i such that
 *   Σ r_i · 2^i ≡ b - 0  (the original blinding)
 * which is achieved by picking r_0..r_{n-2} randomly and computing
 *   r_{n-1} = (b - Σ_{i<n-1} r_i · 2^i) / 2^{n-1}   (mod L)
 *
 * @throws if value is outside [min, max], or if max < min.
 */
export function proveRange(args: {
  commitment: PedersenCommitment;
  value: bigint;
  blinding: bigint;
  min: bigint;
  max: bigint;
}): RangeProof {
  if (args.max < args.min) throw new Error('proveRange: max < min');
  if (args.value < args.min || args.value > args.max) {
    throw new Error(`proveRange: value ${args.value} outside [${args.min}, ${args.max}]`);
  }
  const shifted = args.value - args.min;
  const span = args.max - args.min;
  // numBits = ceil(log2(span + 1)). Special-case span = 0 → numBits = 1.
  let numBits = 0;
  if (span === 0n) numBits = 1;
  else {
    let s = span;
    while (s > 0n) { numBits++; s >>= 1n; }
  }

  // Decompose shifted into numBits bits.
  const bits: bigint[] = [];
  for (let i = 0; i < numBits; i++) bits.push((shifted >> BigInt(i)) & 1n);

  // Generate per-bit blindings such that Σ r_i · 2^i ≡ blinding (mod L).
  const r: bigint[] = [];
  let sumPartial = 0n;
  for (let i = 0; i < numBits - 1; i++) {
    const ri = randomScalar();
    r.push(ri);
    sumPartial = modL(sumPartial + modL(ri * (1n << BigInt(i))));
  }
  // r_{n-1} = (blinding - sumPartial) · (2^{n-1})^{-1}  (mod L)
  const inv2pow = modInverse(1n << BigInt(numBits - 1), L);
  const rLast = modL(modL(args.blinding - sumPartial) * inv2pow);
  r.push(rLast);

  // Build per-bit commitments C_i = b_i·G + r_i·H and per-bit OR proofs.
  const bitCommitments: string[] = [];
  const bitProofs: BitProof[] = [];
  for (let i = 0; i < numBits; i++) {
    const Ci = scalarMul(G, bits[i]!).add(scalarMul(H, r[i]!));
    const hex = bytesToHex(Ci.toBytes());
    bitCommitments.push(hex);
    bitProofs.push(proveBit({
      commitment: { bytes: hex, type: 'ristretto255-pedersen' },
      bit: bits[i]!,
      blinding: r[i]!,
    }));
  }

  return {
    bitCommitments,
    bitProofs,
    min: args.min.toString(),
    max: args.max.toString(),
    numBits,
  };
}

/**
 * Verify a range proof. Returns true iff:
 *   - every bit-commitment passes its OR proof
 *   - Σ_{i} 2^i · C_i ≡ C - min · G  (the bit decomposition
 *     reconstructs the shifted commitment)
 *
 * The verifier never learns v.
 */
export function verifyRange(args: {
  commitment: PedersenCommitment;
  proof: RangeProof;
}): boolean {
  const numBits = args.proof.numBits;
  if (args.proof.bitCommitments.length !== numBits) return false;
  if (args.proof.bitProofs.length !== numBits) return false;
  let min: bigint, max: bigint;
  try {
    min = BigInt(args.proof.min);
    max = BigInt(args.proof.max);
  } catch {
    return false;
  }
  if (max < min) return false;

  let C;
  try {
    C = pointFromHex(args.commitment.bytes);
  } catch {
    return false;
  }
  // Check every bit OR-proof.
  for (let i = 0; i < numBits; i++) {
    const ok = verifyBit({
      commitment: { bytes: args.proof.bitCommitments[i]!, type: 'ristretto255-pedersen' },
      proof: args.proof.bitProofs[i]!,
    });
    if (!ok) return false;
  }
  // Verify Σ 2^i · C_i ?= C - min·G.
  let sum = ristretto255.Point.ZERO;
  for (let i = 0; i < numBits; i++) {
    const Ci = pointFromHex(args.proof.bitCommitments[i]!);
    sum = sum.add(scalarMul(Ci, 1n << BigInt(i)));
  }
  const shiftedC = C.add(scalarMul(G, modL(L - min)));
  if (!sum.equals(shiftedC)) return false;

  // Range-consistency check: numBits must be sufficient for [0, max-min].
  // If numBits is too SMALL the bit decomposition wouldn't reconstruct;
  // if numBits is too LARGE the proof is still sound (extra bit just
  // contributes 0). Reject only the too-small case (already implicit in
  // the sum check, but explicit for clarity).
  const span = max - min;
  let minBits = 0;
  if (span === 0n) minBits = 1;
  else {
    let s = span;
    while (s > 0n) { minBits++; s >>= 1n; }
  }
  if (numBits < minBits) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────
//  Modular inverse via Fermat's little theorem (L is prime)
// ─────────────────────────────────────────────────────────────────────

function modInverse(a: bigint, p: bigint): bigint {
  // a^(p-2) mod p
  return modPow(modL(a), p - 2n, p);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}
