/**
 * @module crypto/shamir
 * @description Shamir's Secret Sharing over the ristretto255 scalar field.
 *
 * Splits a secret `bigint` (typically a Pedersen blinding factor or
 * the operator's sum-of-blindings) into `n` shares with threshold
 * `t`: any `t` shares reconstruct the secret via Lagrange
 * interpolation; any `t-1` shares reveal nothing.
 *
 * This is the v4 prerequisite for multi-aggregator threshold reveal
 * in the aggregate-privacy ladder. v4 builds on this by:
 *   - distributing the trusted-dealer step via Distributed Key
 *     Generation (DKG) so no single party knows the polynomial
 *     coefficients;
 *   - threshold-decrypting / threshold-signing under a `t-of-k`
 *     committee instead of a single aggregator;
 *   - composing with the Pedersen homomorphic-sum to keep individual
 *     contributions hidden from any sub-`t` subset of aggregators.
 *
 * v4 (full multi-party) is real distributed-crypto engineering;
 * this primitive ships the trusted-dealer half so the algebraic
 * building block is in place + contract-tested.
 *
 * Scope:
 *   - Scalar field: the ristretto255 group order L (matches
 *     pedersen.ts). The same modulus across the crypto stack.
 *   - Polynomial degree: t - 1. The secret is the constant term
 *     (f(0)); shares are evaluations at x = 1, 2, ..., n.
 *   - Reconstruction: Lagrange interpolation at x = 0.
 *   - Trusted dealer: the splitter knows the secret + all
 *     polynomial coefficients. v4 DKG removes this.
 *
 * Numeric correctness notes:
 *   - All scalar arithmetic is mod L; modular inverse via Fermat
 *     (a^(L-2) mod L) for the Lagrange denominators.
 *   - Random coefficients sourced from crypto.getRandomValues;
 *     reduced mod L with rejection bias bounded < 2^-128 by
 *     drawing 512 bits per coefficient.
 */

const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

// ─────────────────────────────────────────────────────────────────────
//  Modular arithmetic primitives
// ─────────────────────────────────────────────────────────────────────

function modL(x: bigint): bigint {
  const r = x % L;
  return r < 0n ? r + L : r;
}

/**
 * Modular inverse via Fermat's little theorem (L is prime).
 * a^(L-2) mod L is the inverse of a mod L for any a coprime to L.
 */
function modInverseL(a: bigint): bigint {
  if (a === 0n) throw new Error('modInverseL: cannot invert 0');
  return modPow(modL(a), L - 2n, L);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = modL(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/**
 * Uniformly random bigint in [0, L). 512-bit draw + mod L keeps the
 * bias below 2^-128 (the bias is bounded by L / 2^512 which is
 * negligible).
 */
function randomScalar(): bigint {
  const buf = new Uint8Array(64);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (let i = 0; i < buf.length; i++) {
    n = (n << 8n) | BigInt(buf[i]!);
  }
  return modL(n);
}

// ─────────────────────────────────────────────────────────────────────
//  Share type + split / reconstruct
// ─────────────────────────────────────────────────────────────────────

export interface ShamirShare {
  /** The x-coordinate (1..n). 0 is reserved for the secret f(0). */
  readonly x: number;
  /** The y-coordinate (the polynomial evaluation at x), in [0, L). */
  readonly y: bigint;
  /** Polynomial degree, equal to threshold - 1. Tells the
   *  reconstructor how many shares are needed. */
  readonly threshold: number;
  /** Total number of shares issued. Optional informational field. */
  readonly totalShares?: number;
}

/**
 * Split a secret into `n` shares with threshold `t`. The trusted
 * dealer picks `t - 1` uniformly random coefficients; the polynomial
 * is `f(x) = secret + a_1·x + a_2·x² + ... + a_{t-1}·x^(t-1)`. Shares
 * are `(i, f(i))` for `i = 1..n`. Reconstruction needs any `t`
 * shares; any `t - 1` is information-theoretically zero.
 *
 * @throws if threshold < 1, totalShares < threshold, or totalShares > L-1.
 */
export function splitSecret(args: {
  secret: bigint;
  totalShares: number;
  threshold: number;
}): ShamirShare[] {
  if (args.threshold < 1) throw new Error('splitSecret: threshold must be >= 1');
  if (args.totalShares < args.threshold) {
    throw new Error(`splitSecret: totalShares (${args.totalShares}) must be >= threshold (${args.threshold})`);
  }
  if (args.totalShares > 255) {
    // Practical safety limit; the field is huge but we cap x at one byte for serialization.
    throw new Error('splitSecret: totalShares must be <= 255');
  }
  const secret = modL(args.secret);
  // Polynomial coefficients: [secret, a_1, a_2, ..., a_{t-1}]
  const coeffs: bigint[] = [secret];
  for (let i = 1; i < args.threshold; i++) coeffs.push(randomScalar());

  const shares: ShamirShare[] = [];
  for (let x = 1; x <= args.totalShares; x++) {
    const xBig = BigInt(x);
    // Horner's method: evaluate polynomial at x mod L
    let y = coeffs[coeffs.length - 1]!;
    for (let i = coeffs.length - 2; i >= 0; i--) {
      y = modL(y * xBig + coeffs[i]!);
    }
    shares.push({
      x,
      y,
      threshold: args.threshold,
      totalShares: args.totalShares,
    });
  }
  return shares;
}

/**
 * Reconstruct the secret from any `threshold` shares via Lagrange
 * interpolation at x = 0. Catches: duplicate x-coordinates;
 * insufficient shares (returns null); shares from different
 * thresholds; out-of-range share values.
 *
 * Returns the secret in [0, L), or null on validation failure.
 */
export function reconstructSecret(shares: readonly ShamirShare[]): bigint | null {
  if (shares.length === 0) return null;
  const t = shares[0]!.threshold;
  // All shares must agree on threshold; mismatches indicate a mix of
  // unrelated splittings (likely a bug or attack).
  for (const s of shares) {
    if (s.threshold !== t) return null;
    if (s.x < 1 || s.x > 255) return null;
    if (s.y < 0n || s.y >= L) return null;
  }
  if (shares.length < t) return null;

  // Use the first `t` shares; dedupe x-coordinates.
  const seen = new Set<number>();
  const used: ShamirShare[] = [];
  for (const s of shares) {
    if (seen.has(s.x)) continue;
    seen.add(s.x);
    used.push(s);
    if (used.length === t) break;
  }
  if (used.length < t) return null;

  // Lagrange interpolation at x = 0:
  //   f(0) = Σ_i  y_i · Π_{j≠i}  (-x_j) / (x_i - x_j)
  // All arithmetic mod L.
  let secret = 0n;
  for (let i = 0; i < used.length; i++) {
    const xi = BigInt(used[i]!.x);
    let num = 1n;
    let den = 1n;
    for (let j = 0; j < used.length; j++) {
      if (i === j) continue;
      const xj = BigInt(used[j]!.x);
      num = modL(num * (-xj));
      den = modL(den * (xi - xj));
    }
    const lagrange = modL(num * modInverseL(den));
    secret = modL(secret + used[i]!.y * lagrange);
  }
  return secret;
}

/**
 * Test helper / sanity: verify a share lies on a known polynomial.
 * Not used in production paths; exported so tests can pin polynomial
 * evaluation correctness.
 */
export function evaluateAt(coeffs: readonly bigint[], x: number): bigint {
  const xBig = BigInt(x);
  let y = coeffs[coeffs.length - 1]!;
  for (let i = coeffs.length - 2; i >= 0; i--) {
    y = modL(y * xBig + coeffs[i]!);
  }
  return y;
}
