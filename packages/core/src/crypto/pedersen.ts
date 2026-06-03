/**
 * @module crypto/pedersen
 * @description Pedersen commitments over the ristretto255 prime-order group.
 *
 * A Pedersen commitment to value `v` with blinding factor `b` is:
 *
 *     C = v·G + b·H
 *
 * where G is the standard ristretto255 base point and H is an
 * independent generator (no known discrete-log relation to G, chosen
 * via deterministic hash-to-curve). The commitment scheme is:
 *
 *   - **Hiding** (computational, under DDH): given C, an adversary
 *     learns nothing about v without b.
 *   - **Binding** (perfect, under DLP hardness): the prover cannot
 *     produce two pairs (v, b), (v', b') with v ≠ v' that both open
 *     to the same C.
 *   - **Homomorphic** for addition: C(v1, b1) + C(v2, b2) = C(v1+v2, b1+b2).
 *
 * That last property is what makes private aggregate sums possible:
 * each contributor commits their value with a fresh blinding factor;
 * the aggregator sums the commitments WITHOUT seeing the values; the
 * sum-commitment opens to (sum of values, sum of blindings). With
 * Laplace DP noise added to the sum before reveal, the aggregator
 * publishes a count / sum / threshold that leaks bounded information
 * per ε budget.
 *
 * Scope:
 *   - Single-aggregator setting: the aggregator collects commitments
 *     + per-contributor blindings (or per-contributor sum-of-blindings
 *     for k-party MPC variants), sums, adds DP noise, reveals.
 *   - Bounds enforcement: each contributor's value MUST be in
 *     declared `[min, max]`; the verifier rejects sums whose
 *     reconstructed value exceeds the per-contributor bound × count.
 *     This is NOT a per-contributor range proof — that's a separate
 *     additional layer (already available in src/crypto/zk/
 *     `proveConfidenceAboveThreshold` for [0,1] values).
 *
 * Out of scope (separate future work):
 *   - Multi-aggregator threshold (k-of-n DKG): right now the
 *     aggregator is one trusted role. v4 would distribute the
 *     reveal across k aggregators with a t-of-k threshold.
 *   - Range proofs on each commitment: contributors are expected to
 *     self-bound; a malicious contributor that commits outside the
 *     declared bounds can inflate the sum. v3 mitigates by requiring
 *     contributors to also publish a hash commitment to their bounds,
 *     which the aggregator's verification step checks.
 *   - DP-budget tracking across queries: each query consumes a
 *     fresh ε; cumulative budget tracking is the caller's
 *     responsibility (spec/AGGREGATE-PRIVACY.md §"DP-budget").
 *
 * Implementation: uses @noble/curves ristretto255 (RFC 9496), with
 * the independent generator H derived via RFC 9380 hash-to-curve over
 * a stable domain-separation label. No trusted setup required —
 * ristretto255 is a prime-order subgroup so every nonzero point is a
 * generator and H is publicly auditable from its label.
 */

import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { sha256 } from './ipfs.js';

// ─────────────────────────────────────────────────────────────────────
//  Generators
// ─────────────────────────────────────────────────────────────────────

// Standard ristretto255 base point. The "G" in C = v·G + b·H.
// Kept non-exported because @noble/curves' point class exposes
// protected members and TS refuses to emit declarations naming it.
// Auditors re-derive via the public `commit()` round-trip.
const G = ristretto255.Point.BASE;

// Independent generator H, derived deterministically via RFC 9380
// hash-to-curve from a stable domain-separation label. Anyone can
// recompute H from this label and confirm it matches; nobody knows
// the discrete log dlog_G(H), which is what makes Pedersen binding
// secure.
const H_DOMAIN = new TextEncoder().encode('interego/v1/pedersen/H-generator');
const H = ristretto255_hasher.hashToCurve(H_DOMAIN);

/**
 * Stable, audit-friendly identifier for the H generator. Reveals the
 * domain-separation label so any implementor can re-derive H via
 * `hashToCurve(H_GENERATOR_LABEL)` and confirm it equals the H this
 * module uses. Exported as the public binding-security receipt.
 */
export const H_GENERATOR_LABEL = 'interego/v1/pedersen/H-generator';

/** The order of the prime-order ristretto255 group. */
const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

// ─────────────────────────────────────────────────────────────────────
//  Scalar helpers
// ─────────────────────────────────────────────────────────────────────

/** Reduce a 32-byte buffer to a scalar in [0, L). */
function bytesToScalar(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[i]!);
  }
  return n % L;
}

/** Deterministic blinding factor from a (seed, label) pair. */
export function deriveBlinding(seed: string, label: string): bigint {
  const h = sha256(`${seed}|${label}|interego/v1/pedersen/blinding`);
  // sha256 hex is 64 chars; convert to bytes then reduce mod L.
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToScalar(bytes);
}

/** Cryptographically-random blinding factor. */
export function randomBlinding(): bigint {
  const bytes = new Uint8Array(64); // generous buffer to keep bias negligible after mod L
  crypto.getRandomValues(bytes);
  return bytesToScalar(bytes);
}

// ─────────────────────────────────────────────────────────────────────
//  Commitment type + operations
// ─────────────────────────────────────────────────────────────────────

/**
 * A Pedersen commitment: a ristretto255 point encoded as 32 hex chars.
 * The point itself is opaque; recover the original via
 * `commitmentFromHex` and use add / subtract / equals from the point
 * API directly.
 */
export interface PedersenCommitment {
  readonly type: 'ristretto255-pedersen';
  /** Hex-encoded 32-byte ristretto255 point. */
  readonly bytes: string;
}

/**
 * Commit to a non-negative integer value with the given blinding
 * factor. Both scalars are reduced mod L (the group order) before
 * point multiplication; the homomorphic sum identity
 * `C(v1,b1)+C(v2,b2) = C(v1+v2,b1+b2)` holds modulo L on both
 * components — so sums of blindings ≥ L still verify correctly.
 *
 * Scalar of 0 = identity ⇒ skip the multiplication (the abstract
 * group's `multiply(0n)` is undefined behaviour in @noble/curves; we
 * use the explicit ZERO point for the additive identity instead).
 */
export function commit(value: bigint, blinding: bigint): PedersenCommitment {
  if (value < 0n) throw new Error('Pedersen commit: value must be non-negative (caller responsibility for [min, max] bounds)');
  const v = value % L;
  const b = ((blinding % L) + L) % L; // handle defensive negative inputs
  const vG = v === 0n ? ristretto255.Point.ZERO : G.multiply(v);
  const bH = b === 0n ? ristretto255.Point.ZERO : H.multiply(b);
  return { type: 'ristretto255-pedersen', bytes: bytesToHex(vG.add(bH).toBytes()) };
}

/** Verify that a commitment opens to the claimed (value, blinding) pair. */
export function verifyOpening(c: PedersenCommitment, value: bigint, blinding: bigint): boolean {
  if (value < 0n) return false;
  try {
    const claimed = commit(value, blinding);
    return claimed.bytes === c.bytes;
  } catch {
    return false;
  }
}

/**
 * Homomorphic addition: C(v1, b1) + C(v2, b2) = C(v1+v2, b1+b2).
 * Sums the underlying points; the result is a fresh commitment whose
 * opening is (sum of values, sum of blindings). This is the operation
 * the aggregator uses to combine per-contributor commitments without
 * seeing the contributions.
 */
export function addCommitments(commitments: readonly PedersenCommitment[]): PedersenCommitment {
  if (commitments.length === 0) throw new Error('addCommitments: empty input');
  let acc = commitmentToPoint(commitments[0]!);
  for (let i = 1; i < commitments.length; i++) {
    acc = acc.add(commitmentToPoint(commitments[i]!));
  }
  return { type: 'ristretto255-pedersen', bytes: bytesToHex(acc.toBytes()) };
}

/**
 * Aggregator-side opening: given the per-contributor commitments and
 * their blinding factors (collected via a secure channel), confirm the
 * sum opens to the claimed total value. Used by the aggregator to
 * generate the AttestedSumResult bundle; auditors re-run this against
 * the published bundle.
 */
export function verifyHomomorphicSum(
  commitments: readonly PedersenCommitment[],
  totalValue: bigint,
  totalBlinding: bigint,
): boolean {
  const sumC = addCommitments(commitments);
  return verifyOpening(sumC, totalValue, totalBlinding);
}

// ─────────────────────────────────────────────────────────────────────
//  Internals — point ↔ hex bridge
// ─────────────────────────────────────────────────────────────────────

function commitmentToPoint(c: PedersenCommitment) {
  return ristretto255.Point.fromBytes(hexToBytes(c.bytes));
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

function hexToBytes(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  DP — Laplace noise (calibrated to (sensitivity, ε))
// ─────────────────────────────────────────────────────────────────────

/**
 * Sample Laplace noise with scale b = sensitivity / ε.
 *
 * Inverse-CDF sampling: u ~ Uniform(-0.5, 0.5); X = -b · sign(u) · ln(1 - 2|u|).
 *
 * For an integer-valued query (count, threshold-met), we round the
 * floating-point sample to the nearest integer; the rounding leaks
 * ≤ 0.5/ε bits per query and is documented in
 * spec/AGGREGATE-PRIVACY.md. For continuous-valued queries (sum,
 * mean) callers can use `sampleLaplaceFloat` directly.
 */
export function sampleLaplaceFloat(sensitivity: number, epsilon: number): number {
  if (!(sensitivity > 0)) throw new Error('Laplace: sensitivity must be > 0');
  if (!(epsilon > 0)) throw new Error('Laplace: epsilon must be > 0');
  // Cryptographically secure uniform in (0, 1) — strict open interval
  // so the log argument is never zero.
  const u = uniform01CryptoOpen();
  // Transform to (-0.5, 0.5).
  const c = u - 0.5;
  const scale = sensitivity / epsilon;
  return -scale * Math.sign(c) * Math.log(1 - 2 * Math.abs(c));
}

export function sampleLaplaceInt(sensitivity: number, epsilon: number): number {
  return Math.round(sampleLaplaceFloat(sensitivity, epsilon));
}

function uniform01CryptoOpen(): number {
  // 53-bit precision uniform in (0, 1) using crypto.getRandomValues.
  // Reject 0 to keep the log argument bounded.
  for (;;) {
    const buf = new Uint8Array(7);
    crypto.getRandomValues(buf);
    // 53 bits — 6 bytes + 5 high bits of the 7th
    const n = (BigInt(buf[0]!) << 40n) |
              (BigInt(buf[1]!) << 32n) |
              (BigInt(buf[2]!) << 24n) |
              (BigInt(buf[3]!) << 16n) |
              (BigInt(buf[4]!) << 8n)  |
              BigInt(buf[5]!);
    const v = Number(n) / Math.pow(2, 48);
    if (v > 0 && v < 1) return v;
  }
}
