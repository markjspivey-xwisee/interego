/**
 * @module crypto/feldman-vss
 * @description Feldman Verifiable Secret Sharing — pairs Shamir
 * shares with publicly-verifiable commitments to the polynomial
 * coefficients so a recipient can confirm their share is on the
 * dealer's actual polynomial, not a forged one.
 *
 * Where plain Shamir (`src/crypto/shamir.ts`) only gives `t-of-n`
 * reconstruction (and a corrupted share silently poisons the
 * Lagrange interpolation), Feldman VSS adds:
 *
 *   - The dealer publishes commitments C_i = c_i · G for each
 *     polynomial coefficient c_i (i = 0..t-1). C_0 = secret · G is
 *     the commitment to the secret itself.
 *   - A recipient with share (x, y) checks
 *       y · G  ?=  Σ_{i=0..t-1}  (x^i) · C_i
 *     If the equation holds, the share is on the dealer's
 *     polynomial; if it fails, the share was tampered or corrupted.
 *
 * Trade-off: Feldman VSS is computationally hiding (anyone with C_0
 * can recover the secret only via discrete-log, which is hard) but
 * NOT information-theoretically hiding (Pedersen VSS gives
 * information-theoretic hiding at the cost of needing an independent
 * second generator). For our use case — the secret IS already a
 * blinding factor that's been used in a Pedersen commitment, so the
 * extra hiding from Pedersen-VSS is moot — Feldman is the right
 * pick.
 *
 * All point arithmetic over ristretto255 (matches `src/crypto/pedersen.ts`).
 * Polynomial coefficients live in the ristretto255 scalar field L
 * (matches `src/crypto/shamir.ts`). Composition is clean.
 *
 * Future v4-with-VSS: when buildAttestedHomomorphicSum's
 * thresholdReveal mode is upgraded to VSS, the dealer publishes the
 * coefficient commitments alongside the shares; pseudo-aggregators
 * verify their share before participating; reconstruction at the
 * auditor level uses only verified shares — corrupted-share poisoning
 * is detected, not silent.
 */

import { ristretto255 } from '@noble/curves/ed25519.js';

const G = ristretto255.Point.BASE;
const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

// ─────────────────────────────────────────────────────────────────────
//  Modular arithmetic (matches src/crypto/shamir.ts)
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

function evaluateAt(coeffs: readonly bigint[], x: number): bigint {
  const xBig = BigInt(x);
  let y = coeffs[coeffs.length - 1]!;
  for (let i = coeffs.length - 2; i >= 0; i--) {
    y = modL(y * xBig + coeffs[i]!);
  }
  return y;
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
//  Types
// ─────────────────────────────────────────────────────────────────────

export interface VerifiableShamirShare {
  /** Same shape as a Shamir share — x in [1, 255], y in [0, L). */
  readonly x: number;
  readonly y: bigint;
  readonly threshold: number;
  readonly totalShares?: number;
}

export interface FeldmanCommitments {
  /**
   * Hex-encoded ristretto255 points c_i · G for i = 0..t-1, in order.
   * commitments[0] = secret · G — public.
   * commitments[i] = a_i · G for i > 0 — public; reveals each
   * polynomial coefficient as an EC point.
   */
  readonly points: readonly string[];
  /** Polynomial degree + 1 (= threshold). */
  readonly threshold: number;
}

// ─────────────────────────────────────────────────────────────────────
//  Split + commitments
// ─────────────────────────────────────────────────────────────────────

/**
 * Split a secret with Feldman VSS: produces both the Shamir shares
 * AND the public commitments to the polynomial coefficients. The
 * dealer publishes the commitments alongside the shares; each
 * recipient verifies their share before trusting it.
 *
 * @throws on invalid threshold / totalShares (same shape as splitSecret).
 */
export function splitSecretWithCommitments(args: {
  secret: bigint;
  totalShares: number;
  threshold: number;
}): { shares: VerifiableShamirShare[]; commitments: FeldmanCommitments } {
  if (args.threshold < 1) throw new Error('Feldman VSS: threshold must be >= 1');
  if (args.totalShares < args.threshold) {
    throw new Error(`Feldman VSS: totalShares (${args.totalShares}) must be >= threshold (${args.threshold})`);
  }
  if (args.totalShares > 255) throw new Error('Feldman VSS: totalShares must be <= 255');

  // Build the polynomial: [secret, a_1, a_2, ..., a_{t-1}]
  const secret = modL(args.secret);
  const coeffs: bigint[] = [secret];
  for (let i = 1; i < args.threshold; i++) coeffs.push(randomScalar());

  // Coefficient commitments: c_i · G. The first one is secret · G
  // (the commitment to the secret itself); the rest are commitments
  // to the random polynomial coefficients.
  const commitmentPoints = coeffs.map(c => {
    // c may be 0 for a freshly-generated random coefficient; G.multiply(0n)
    // is undefined behaviour, so use the explicit ZERO identity element.
    if (c === 0n) return ristretto255.Point.ZERO;
    return G.multiply(c);
  });
  const commitmentHex = commitmentPoints.map(p => bytesToHex(p.toBytes()));

  // Shares: (i, f(i)) for i in 1..n
  const shares: VerifiableShamirShare[] = [];
  for (let x = 1; x <= args.totalShares; x++) {
    shares.push({
      x,
      y: evaluateAt(coeffs, x),
      threshold: args.threshold,
      totalShares: args.totalShares,
    });
  }
  return {
    shares,
    commitments: { points: commitmentHex, threshold: args.threshold },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Per-share verification
// ─────────────────────────────────────────────────────────────────────

/**
 * Verify a single Shamir share against the dealer's published
 * commitments. The check is:
 *
 *   y · G  ?=  Σ_{i=0..t-1}  (x^i mod L) · C_i
 *
 * (point-multiplication of each commitment by the scalar x^i,
 * summed). If the equation holds, the share is on the polynomial
 * the dealer committed to; if not, the share was tampered, the
 * commitments were tampered, or the dealer cheated.
 *
 * @returns true if the share verifies; false otherwise.
 */
export function verifyShare(args: {
  share: VerifiableShamirShare;
  commitments: FeldmanCommitments;
}): boolean {
  const { share, commitments } = args;
  if (share.threshold !== commitments.threshold) return false;
  if (commitments.points.length !== commitments.threshold) return false;
  if (share.x < 1 || share.x > 255) return false;
  if (share.y < 0n || share.y >= L) return false;

  // Decode the dealer's coefficient commitments.
  let commitPts;
  try {
    commitPts = commitments.points.map(hex => ristretto255.Point.fromBytes(hexToBytes(hex)));
  } catch {
    return false;
  }

  // Left side: y · G
  const lhs = share.y === 0n ? ristretto255.Point.ZERO : G.multiply(share.y);

  // Right side: Σ (x^i · C_i) — multiply each C_i by x^i mod L and sum
  let rhs = ristretto255.Point.ZERO;
  let xPow = 1n;
  const x = BigInt(share.x);
  for (let i = 0; i < commitPts.length; i++) {
    const term = xPow === 0n ? ristretto255.Point.ZERO : commitPts[i]!.multiply(xPow);
    rhs = rhs.add(term);
    xPow = modL(xPow * x);
  }

  return lhs.equals(rhs);
}

/**
 * Filter a share set down to those that verify against the
 * commitments. Use BEFORE running Lagrange reconstruction so
 * corrupted shares don't silently poison the result. Returns the
 * verified subset (may be shorter than the input); the caller
 * compares its length against the required threshold to decide
 * whether reconstruction is possible.
 */
export function filterVerifiedShares(args: {
  shares: readonly VerifiableShamirShare[];
  commitments: FeldmanCommitments;
}): VerifiableShamirShare[] {
  return args.shares.filter(s => verifyShare({ share: s, commitments: args.commitments }));
}

/**
 * Public secret commitment — the dealer's commitment to the secret
 * itself. Equal to `commitments.points[0]`. Useful when the caller
 * has another path to know `secret · G` (e.g., the secret is a
 * Pedersen blinding and the matching `bH` term anchors verification
 * at a higher level).
 */
export function secretCommitment(commitments: FeldmanCommitments): string {
  return commitments.points[0]!;
}
