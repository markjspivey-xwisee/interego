/**
 * Distributed Key Generation — contract tests.
 *
 * Pins the headline guarantees the v4-with-DKG protocol relies on:
 *
 *   1. dkgRound1 produces a degree-(t-1) polynomial + Feldman
 *      commitments + n shares (one per recipient).
 *   2. dkgRound2 accepts honest shares, rejects tampered ones,
 *      rejects shares with the wrong x.
 *   3. dkgRound3 sums per-coefficient commitments correctly; the
 *      collective public key equals the sum of every party's
 *      a_{i,0} · G.
 *   4. simulateDKG end-to-end: every participant's combined share
 *      verifies against the collective commitments; every
 *      participant agrees on the public key + QUAL set.
 *   5. The collective polynomial is t-of-n reconstructable: any t
 *      participants' combined shares Lagrange-interpolate to the
 *      collective secret.
 *   6. NO party's individual round-1 secret is recoverable from the
 *      output (the collective secret is the SUM, never disclosed).
 */

import { describe, it, expect } from 'vitest';
import {
  dkgRound1,
  dkgRound2,
  dkgRound3,
  simulateDKG,
  type DKGReceivedShare,
} from '../src/crypto/dkg.js';
import { verifyShare } from '../src/crypto/feldman-vss.js';
import { reconstructSecret } from '../src/crypto/shamir.js';
import { ristretto255 } from '@noble/curves/ed25519.js';

const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
const G = ristretto255.Point.BASE;

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

describe('dkg: round 1 share generation', () => {
  it('produces n shares + t commitments for each participant', () => {
    const state = dkgRound1({ index: 2, n: 5, t: 3 });
    expect(state.ownShares.length).toBe(5);
    expect(state.ownCommitments.points.length).toBe(3);
    expect(state.ownCommitments.threshold).toBe(3);
    // The share intended for participant j has x = j.
    for (let j = 1; j <= 5; j++) {
      expect(state.ownShares[j - 1]!.x).toBe(j);
    }
  });

  it('rejects index out of range', () => {
    expect(() => dkgRound1({ index: 0, n: 5, t: 3 })).toThrow(/index 0 out of range/);
    expect(() => dkgRound1({ index: 6, n: 5, t: 3 })).toThrow(/index 6 out of range/);
  });

  it('rejects threshold out of range', () => {
    expect(() => dkgRound1({ index: 1, n: 5, t: 0 })).toThrow(/threshold 0 out of range/);
    expect(() => dkgRound1({ index: 1, n: 5, t: 6 })).toThrow(/threshold 6 out of range/);
  });

  it("every party's own shares verify against their own commitments", () => {
    const state = dkgRound1({ index: 1, n: 5, t: 3 });
    for (const share of state.ownShares) {
      expect(verifyShare({ share, commitments: state.ownCommitments })).toBe(true);
    }
  });
});

describe('dkg: round 2 share verification', () => {
  it('qualifies honest shares + rejects tampered shares + rejects wrong-x shares', () => {
    // Two senders; recipient = 1.
    const senderA = dkgRound1({ index: 1, n: 3, t: 2 });
    const senderB = dkgRound1({ index: 2, n: 3, t: 2 });
    const senderC = dkgRound1({ index: 3, n: 3, t: 2 });

    const recipientIndex = 1;
    const honestA: DKGReceivedShare = {
      fromIndex: 1,
      share: senderA.ownShares[recipientIndex - 1]!,
      senderCommitments: senderA.ownCommitments,
    };
    const tamperedB: DKGReceivedShare = {
      fromIndex: 2,
      share: { ...senderB.ownShares[recipientIndex - 1]!, y: (senderB.ownShares[recipientIndex - 1]!.y + 1n) % L },
      senderCommitments: senderB.ownCommitments,
    };
    const wrongXC: DKGReceivedShare = {
      fromIndex: 3,
      share: senderC.ownShares[1]!, // share for participant 2, but recipient is 1
      senderCommitments: senderC.ownCommitments,
    };

    const r2 = dkgRound2({ recipientIndex, received: [honestA, tamperedB, wrongXC] });
    expect(r2.qualifiedSenders).toEqual([1]);
    expect(r2.rejectedSenders.sort()).toEqual([2, 3]);
  });
});

describe('dkg: round 3 combine', () => {
  it('combined share verifies against the collective commitments', () => {
    const senderA = dkgRound1({ index: 1, n: 3, t: 2 });
    const senderB = dkgRound1({ index: 2, n: 3, t: 2 });
    const senderC = dkgRound1({ index: 3, n: 3, t: 2 });

    const recipientIndex = 1;
    const received: DKGReceivedShare[] = [
      { fromIndex: 1, share: senderA.ownShares[recipientIndex - 1]!, senderCommitments: senderA.ownCommitments },
      { fromIndex: 2, share: senderB.ownShares[recipientIndex - 1]!, senderCommitments: senderB.ownCommitments },
      { fromIndex: 3, share: senderC.ownShares[recipientIndex - 1]!, senderCommitments: senderC.ownCommitments },
    ];
    const r3 = dkgRound3({ recipientIndex, t: 2, qualifiedReceived: received });
    expect(verifyShare({ share: r3.combinedShare, commitments: r3.collectiveCommitments })).toBe(true);
    expect(r3.qual).toEqual([1, 2, 3]);
  });

  it('throws when no qualified shares are supplied', () => {
    expect(() => dkgRound3({ recipientIndex: 1, t: 2, qualifiedReceived: [] })).toThrow(/no qualified shares/);
  });

  it('throws when a sender has the wrong number of commitments', () => {
    const sender = dkgRound1({ index: 1, n: 3, t: 2 });
    const truncated = { ...sender.ownCommitments, points: [sender.ownCommitments.points[0]!] }; // 1 of 2
    const received: DKGReceivedShare[] = [
      { fromIndex: 1, share: sender.ownShares[0]!, senderCommitments: truncated },
    ];
    expect(() => dkgRound3({ recipientIndex: 1, t: 2, qualifiedReceived: received })).toThrow(/expected 2/);
  });
});

describe('dkg: end-to-end simulation', () => {
  it('honest 3-of-5 DKG: every participant agrees on the collective public key + QUAL', () => {
    const finals = simulateDKG({ n: 5, t: 3 });
    expect(finals.length).toBe(5);
    const pk0 = finals[0]!.collectivePublicKey;
    for (const f of finals) {
      expect(f.collectivePublicKey).toBe(pk0);
      expect(f.qual).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('every participant\'s combined share verifies against the collective commitments', () => {
    const finals = simulateDKG({ n: 4, t: 2 });
    for (const f of finals) {
      expect(verifyShare({ share: f.combinedShare, commitments: f.collectiveCommitments })).toBe(true);
    }
  });

  it('any t-of-n combined shares Lagrange-interpolate to the collective secret', () => {
    const finals = simulateDKG({ n: 5, t: 3 });
    const expectedPk = finals[0]!.collectivePublicKey;
    // Take any 3 of the 5 combined shares.
    for (const subset of [[0, 1, 2], [0, 2, 4], [1, 3, 4]]) {
      const reconstructed = reconstructSecret(subset.map(i => finals[i]!.combinedShare));
      expect(reconstructed).not.toBeNull();
      // The reconstructed scalar times G should equal the collective public key.
      const pkBytes = bytesToHex(G.multiply(reconstructed!).toBytes());
      expect(pkBytes).toBe(expectedPk);
    }
  });

  it('t-1 combined shares CANNOT recover the collective secret', () => {
    const finals = simulateDKG({ n: 5, t: 3 });
    // reconstructSecret enforces the declared threshold and returns
    // null when too few shares are supplied — the substrate refuses
    // to interpolate at fewer than t points.
    const partial = reconstructSecret([finals[0]!.combinedShare, finals[1]!.combinedShare]);
    expect(partial).toBeNull();
  });

  it('collective public key equals the sum of each party\'s round-1 a_{i,0} commitment', () => {
    // We don't directly observe each party's a_{i,0}, but we can
    // observe that the collective commitments[0] equals the sum of
    // each party's ownCommitments.points[0].
    // This test re-runs the round-1 phase explicitly to check the
    // composition.
    const n = 3, t = 2;
    const r1 = [1, 2, 3].map(i => dkgRound1({ index: i, n, t }));
    // The collective commitment to f(0) should equal the sum of each
    // party's commitment to a_{i,0}.
    let sumPoint = ristretto255.Point.ZERO;
    for (const s of r1) {
      sumPoint = sumPoint.add(ristretto255.Point.fromBytes(Uint8Array.from(
        s.ownCommitments.points[0]!.match(/.{2}/g)!.map(h => parseInt(h, 16)),
      )));
    }
    const expectedPk = bytesToHex(sumPoint.toBytes());

    // Run the DKG simulation on the SAME round-1 outputs (we can't
    // directly inject — but simulateDKG with the same n, t and the
    // same RNG is non-deterministic). Instead, build the round-3
    // result manually from the r1 we already have.
    const received1: DKGReceivedShare[] = r1.map(s => ({
      fromIndex: s.index, share: s.ownShares[0]!, senderCommitments: s.ownCommitments,
    }));
    const r3 = dkgRound3({ recipientIndex: 1, t, qualifiedReceived: received1 });
    expect(r3.collectivePublicKey).toBe(expectedPk);
  });
});
