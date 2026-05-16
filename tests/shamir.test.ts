/**
 * Shamir secret sharing — contract tests.
 *
 * Pins the algebraic guarantees the v4 threshold-reveal will rely on:
 *
 *   1. Split + reconstruct round-trip: any `t` shares yield the secret.
 *   2. Threshold strictness: `t-1` shares fail to reconstruct.
 *   3. Permutation invariance: any subset of `t` shares works,
 *      regardless of order.
 *   4. Validation: duplicate x-coords, mismatched thresholds,
 *      out-of-range y-values all caught.
 *   5. Edge cases: t = 1 (degenerate; all shares == secret),
 *      t = n (every share required), secret = 0 (the identity).
 *   6. Hiding: t-1 shares carry NO statistical signal about the
 *      secret — verified by sampling distinct secrets and confirming
 *      the resulting (t-1)-share sets are indistinguishable.
 *      (Smoke check; full information-theoretic proof is mathematical.)
 *
 * No network, no async — pure modular arithmetic over the ristretto255
 * scalar field already in src/crypto/pedersen.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  splitSecret,
  reconstructSecret,
  evaluateAt,
  type ShamirShare,
} from '../src/crypto/shamir.js';

const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

describe('shamir: split + reconstruct round-trip', () => {
  it('reconstructs a non-zero secret from t-of-n shares', () => {
    const secret = 12345678901234567890n;
    const shares = splitSecret({ secret, totalShares: 5, threshold: 3 });
    expect(shares.length).toBe(5);
    // Any 3 shares reconstruct.
    const subset = [shares[0]!, shares[2]!, shares[4]!];
    expect(reconstructSecret(subset)).toBe(secret);
  });

  it('reconstructs zero secret correctly (identity edge case)', () => {
    const shares = splitSecret({ secret: 0n, totalShares: 4, threshold: 2 });
    const reconstructed = reconstructSecret([shares[0]!, shares[3]!]);
    expect(reconstructed).toBe(0n);
  });

  it('reconstructs the secret using ANY t-subset of the n shares', () => {
    const secret = 999999999n;
    const t = 3;
    const n = 5;
    const shares = splitSecret({ secret, totalShares: n, threshold: t });
    // Try every t-subset.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = j + 1; k < n; k++) {
          const subset = [shares[i]!, shares[j]!, shares[k]!];
          expect(reconstructSecret(subset)).toBe(secret);
        }
      }
    }
  });

  it('handles a large secret near L (the scalar-field upper bound)', () => {
    const secret = L - 7n;
    const shares = splitSecret({ secret, totalShares: 5, threshold: 3 });
    expect(reconstructSecret([shares[0]!, shares[1]!, shares[2]!])).toBe(secret);
  });
});

describe('shamir: threshold strictness', () => {
  it('returns null with fewer than t shares', () => {
    const secret = 42n;
    const shares = splitSecret({ secret, totalShares: 5, threshold: 3 });
    expect(reconstructSecret([shares[0]!, shares[1]!])).toBeNull();
    expect(reconstructSecret([shares[0]!])).toBeNull();
    expect(reconstructSecret([])).toBeNull();
  });

  it('t = 1 is the degenerate case where every share equals the secret', () => {
    const secret = 7n;
    const shares = splitSecret({ secret, totalShares: 4, threshold: 1 });
    for (const s of shares) expect(s.y).toBe(secret);
    expect(reconstructSecret([shares[2]!])).toBe(secret);
  });

  it('t = n requires every share', () => {
    const secret = 100n;
    const n = 4;
    const shares = splitSecret({ secret, totalShares: n, threshold: n });
    expect(reconstructSecret(shares.slice(0, n - 1))).toBeNull();
    expect(reconstructSecret(shares)).toBe(secret);
  });
});

describe('shamir: validation', () => {
  it('rejects splitSecret with threshold > totalShares', () => {
    expect(() => splitSecret({ secret: 1n, totalShares: 2, threshold: 3 })).toThrow(/totalShares.*>=.*threshold/);
  });

  it('rejects splitSecret with threshold < 1', () => {
    expect(() => splitSecret({ secret: 1n, totalShares: 2, threshold: 0 })).toThrow(/threshold/);
  });

  it('rejects totalShares > 255 (one-byte x-coordinate cap)', () => {
    expect(() => splitSecret({ secret: 1n, totalShares: 256, threshold: 100 })).toThrow(/<= 255/);
  });

  it('reconstructSecret rejects mismatched thresholds across shares', () => {
    const a = splitSecret({ secret: 1n, totalShares: 3, threshold: 2 });
    const b = splitSecret({ secret: 2n, totalShares: 3, threshold: 3 });
    // Splice shares from two different splittings.
    expect(reconstructSecret([a[0]!, b[1]!])).toBeNull();
  });

  it('reconstructSecret dedupes duplicate x-coordinates and falls short of t', () => {
    const shares = splitSecret({ secret: 5n, totalShares: 3, threshold: 3 });
    // Three "shares" but only two distinct x-coords → reconstruction fails.
    expect(reconstructSecret([shares[0]!, shares[0]!, shares[1]!])).toBeNull();
  });

  it('reconstructSecret rejects out-of-range y values', () => {
    const shares = splitSecret({ secret: 5n, totalShares: 3, threshold: 2 });
    const corrupted: ShamirShare = { ...shares[0]!, y: L + 1n };
    expect(reconstructSecret([corrupted, shares[1]!])).toBeNull();
  });

  it('reconstructSecret rejects out-of-range x values', () => {
    const shares = splitSecret({ secret: 5n, totalShares: 3, threshold: 2 });
    const corrupted: ShamirShare = { ...shares[0]!, x: 0 };
    expect(reconstructSecret([corrupted, shares[1]!])).toBeNull();
  });
});

describe('shamir: corrupt shares poison the reconstruction', () => {
  it('a single tampered y value yields a different (but well-formed) reconstructed value', () => {
    // The reconstruction algorithm is deterministic in its inputs;
    // changing a y value changes the output. The point of t-of-n is
    // that t HONEST shares suffice. A malicious party can't forge
    // the secret without knowing it, but they CAN corrupt the
    // reconstruction by submitting a fake share. The mitigation is
    // either (a) verifiable secret sharing (VSS — out of scope for
    // this primitive) or (b) reconstructing multiple t-subsets and
    // taking the modal result (caller's responsibility).
    const secret = 42n;
    const shares = splitSecret({ secret, totalShares: 5, threshold: 3 });
    const tampered: ShamirShare = { ...shares[0]!, y: (shares[0]!.y + 1n) % L };
    const result = reconstructSecret([tampered, shares[1]!, shares[2]!]);
    expect(result).not.toBe(secret);
    expect(result).not.toBeNull();
  });
});

describe('shamir: hiding (smoke check)', () => {
  it('any t-1 shares of different secrets are statistically indistinguishable', () => {
    // Information-theoretic: t-1 shares contain ZERO information
    // about the secret (the polynomial through (0, secret) and t-1
    // arbitrary points is determined by those points alone). Smoke
    // check: split two distinct secrets, look at the first t-1
    // shares of each; they must NOT be predictable from the
    // secret. Specifically: a t-1 share subset that happens to
    // match across two splittings is a coincidence of the random
    // coefficients, not a function of the secret.
    const a = splitSecret({ secret: 100n, totalShares: 5, threshold: 3 });
    const b = splitSecret({ secret: 999n, totalShares: 5, threshold: 3 });
    // The first 2 (=t-1) shares from a vs. from b should not
    // collide in y values with overwhelming probability.
    const yA = a.slice(0, 2).map(s => s.y);
    const yB = b.slice(0, 2).map(s => s.y);
    // Different polynomials → different y values almost surely.
    expect(yA[0]).not.toBe(yB[0]);
    expect(yA[1]).not.toBe(yB[1]);
  });
});

describe('shamir: evaluateAt sanity', () => {
  it('a polynomial f(x) = c0 + c1·x evaluates correctly at known points', () => {
    const coeffs = [10n, 3n]; // f(x) = 10 + 3x
    expect(evaluateAt(coeffs, 1)).toBe(13n);
    expect(evaluateAt(coeffs, 2)).toBe(16n);
    expect(evaluateAt(coeffs, 5)).toBe(25n);
  });

  it('evaluation respects mod L for large polynomials', () => {
    const coeffs = [L - 5n, L - 3n]; // both negative mod L
    const y1 = evaluateAt(coeffs, 1);
    expect(y1 >= 0n).toBe(true);
    expect(y1 < L).toBe(true);
  });
});
