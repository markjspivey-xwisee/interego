/**
 * Range-proof contract tests — Chaum-Pedersen OR for {0, 1} +
 * bit-decomposition range proofs.
 *
 * Pins what an adopter relying on these proofs needs to trust:
 *
 *   1. proveBit + verifyBit: honest 0 and 1 commitments accept;
 *      a non-bit commitment (v=2) is rejected; tampered proof
 *      components are rejected.
 *   2. proveRange + verifyRange: honest in-range value accepts;
 *      out-of-range value throws at prove time; tampered bit
 *      commitments rejected at verify time; range-edge values
 *      (min, max) accept.
 *   3. The proof never reveals the value: the proof bytes are the
 *      SAME shape and size regardless of which {0, 1} the bit is,
 *      and contain no information that distinguishes the two
 *      branches.
 */

import { describe, it, expect } from 'vitest';
import {
  proveBit, verifyBit,
  proveRange, verifyRange,
} from '../src/crypto/range-proof.js';
import { commit, randomBlinding } from '../src/crypto/pedersen.js';

describe('range-proof: Chaum-Pedersen OR for {0, 1}', () => {
  it('honest 0: proveBit + verifyBit accepts', () => {
    const b = randomBlinding();
    const c = commit(0n, b);
    const proof = proveBit({ commitment: c, bit: 0n, blinding: b });
    expect(verifyBit({ commitment: c, proof })).toBe(true);
  });

  it('honest 1: proveBit + verifyBit accepts', () => {
    const b = randomBlinding();
    const c = commit(1n, b);
    const proof = proveBit({ commitment: c, bit: 1n, blinding: b });
    expect(verifyBit({ commitment: c, proof })).toBe(true);
  });

  it('REJECTS a forged proof from someone who doesn\'t know the blinding', () => {
    const b = randomBlinding();
    const c = commit(0n, b);
    // Forge: claim bit=1 with a different (made-up) blinding.
    expect(() => proveBit({ commitment: c, bit: 1n, blinding: 999n })).not.toThrow();
    // The forged proof for the WRONG bit-side will not verify against c
    // (the verifier check uses the *real* commitment c).
    const forged = proveBit({ commitment: c, bit: 1n, blinding: 999n });
    expect(verifyBit({ commitment: c, proof: forged })).toBe(false);
  });

  it('throws when proving a non-bit value (v=2)', () => {
    const b = randomBlinding();
    const c = commit(2n, b);
    expect(() => proveBit({ commitment: c, bit: 2n, blinding: b })).toThrow(/bit must be 0 or 1/);
  });

  it('REJECTS verification of an honest proof against a different commitment', () => {
    const b1 = randomBlinding();
    const b2 = randomBlinding();
    const c1 = commit(0n, b1);
    const c2 = commit(1n, b2);
    const proof = proveBit({ commitment: c1, bit: 0n, blinding: b1 });
    expect(verifyBit({ commitment: c2, proof })).toBe(false);
  });

  it('REJECTS verification when a proof component is tampered', () => {
    const b = randomBlinding();
    const c = commit(1n, b);
    const proof = proveBit({ commitment: c, bit: 1n, blinding: b });
    const tampered = { ...proof, z0: (BigInt(proof.z0) + 1n).toString() };
    expect(verifyBit({ commitment: c, proof: tampered })).toBe(false);
  });

  it('proof has identical shape regardless of which bit was committed (zero-knowledge property)', () => {
    const b0 = randomBlinding();
    const b1 = randomBlinding();
    const c0 = commit(0n, b0);
    const c1 = commit(1n, b1);
    const p0 = proveBit({ commitment: c0, bit: 0n, blinding: b0 });
    const p1 = proveBit({ commitment: c1, bit: 1n, blinding: b1 });
    // Each proof field is a hex/decimal string of comparable size.
    expect(Object.keys(p0).sort()).toEqual(Object.keys(p1).sort());
    expect(p0.a0.length).toBe(p1.a0.length);
    expect(p0.a1.length).toBe(p1.a1.length);
  });
});

describe('range-proof: bit-decomposition range proof', () => {
  it('honest in-range value: proveRange + verifyRange accepts', () => {
    const value = 42n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 0n, max: 100n });
    expect(verifyRange({ commitment, proof })).toBe(true);
  });

  it('value = min: edge case accepts', () => {
    const value = 0n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 0n, max: 100n });
    expect(verifyRange({ commitment, proof })).toBe(true);
  });

  it('value = max: edge case accepts', () => {
    const value = 100n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 0n, max: 100n });
    expect(verifyRange({ commitment, proof })).toBe(true);
  });

  it('shifted range [50, 150]: prover proves a value of 100 without revealing it', () => {
    const value = 100n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 50n, max: 150n });
    expect(verifyRange({ commitment, proof })).toBe(true);
  });

  it('value below min: proveRange throws', () => {
    const value = -1n;
    const blinding = randomBlinding();
    const commitment = commit(0n, blinding); // can't commit -1, use 0 for shape
    expect(() => proveRange({ commitment, value, blinding, min: 0n, max: 100n }))
      .toThrow(/outside/);
  });

  it('value above max: proveRange throws', () => {
    const value = 101n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    expect(() => proveRange({ commitment, value, blinding, min: 0n, max: 100n }))
      .toThrow(/outside/);
  });

  it('max < min: proveRange throws', () => {
    const blinding = randomBlinding();
    const commitment = commit(0n, blinding);
    expect(() => proveRange({ commitment, value: 0n, blinding, min: 100n, max: 0n }))
      .toThrow(/max < min/);
  });

  it('REJECTS verification when a bit commitment is tampered', () => {
    const value = 42n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 0n, max: 100n });
    // Swap the last bit commitment for a different value's bit.
    const otherC = commit(7n, randomBlinding());
    const tampered = {
      ...proof,
      bitCommitments: [...proof.bitCommitments.slice(0, -1), otherC.bytes],
    };
    expect(verifyRange({ commitment, proof: tampered })).toBe(false);
  });

  it('REJECTS verification when a bit proof is tampered', () => {
    const value = 42n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 0n, max: 100n });
    const tamperedBitProof = { ...proof.bitProofs[0]!, z0: (BigInt(proof.bitProofs[0]!.z0) + 1n).toString() };
    const tampered = {
      ...proof,
      bitProofs: [tamperedBitProof, ...proof.bitProofs.slice(1)],
    };
    expect(verifyRange({ commitment, proof: tampered })).toBe(false);
  });

  it('REJECTS a proof from one commitment verified against a DIFFERENT commitment', () => {
    const blinding1 = randomBlinding();
    const blinding2 = randomBlinding();
    const c1 = commit(42n, blinding1);
    const c2 = commit(42n, blinding2); // same value, different blinding — different commitment
    const proof = proveRange({ commitment: c1, value: 42n, blinding: blinding1, min: 0n, max: 100n });
    expect(verifyRange({ commitment: c2, proof })).toBe(false);
  });

  it('handles trivial range (min = max): single-bit proof', () => {
    const value = 7n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 7n, max: 7n });
    expect(verifyRange({ commitment, proof })).toBe(true);
    expect(proof.numBits).toBe(1);
  });

  it('handles wider ranges (1000 values, ~10 bits)', () => {
    const value = 333n;
    const blinding = randomBlinding();
    const commitment = commit(value, blinding);
    const proof = proveRange({ commitment, value, blinding, min: 0n, max: 1000n });
    expect(verifyRange({ commitment, proof })).toBe(true);
    expect(proof.numBits).toBeGreaterThanOrEqual(10);
  });
});
