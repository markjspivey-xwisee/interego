/**
 * @module crypto/dkg
 * @description Distributed Key Generation (Pedersen 1991 / Gennaro et
 * al 1999 variant) over the ristretto255 scalar field. Composes
 * [`./feldman-vss.ts`](./feldman-vss.ts) directly — each participant
 * runs Feldman VSS as the dealer for their own randomly-generated
 * polynomial; the COLLECTIVE polynomial is the sum, and no single
 * participant ever sees the collective secret.
 *
 * Removes the trusted-dealer caveat from the
 * [`applications/_shared/aggregate-privacy/`](../../applications/_shared/aggregate-privacy/index.ts)
 * v4-partial threshold-reveal protocol: where v4-partial+VSS still
 * has the operator running the split (and therefore knowing every
 * polynomial coefficient), DKG ensures NO party — not the operator,
 * not any single pseudo-aggregator — learns the collective polynomial.
 *
 * Protocol (3 rounds, simplified for single-process composition):
 *
 *   Round 1 (Share Generation):
 *     Each participant i ∈ {1..n} picks a random degree-(t-1)
 *     polynomial f_i(x) = a_{i,0} + a_{i,1} · x + ... + a_{i,t-1} · x^{t-1}.
 *     Publishes per-coefficient commitments C_{i,k} = a_{i,k} · G
 *     (Feldman VSS). Generates per-recipient shares
 *     s_{i,j} = f_i(j) for j ∈ {1..n}.
 *
 *   Round 2 (Share Verification):
 *     Each recipient j verifies each s_{i,j} against participant i's
 *     commitments via the standard Feldman VSS check:
 *       s_{i,j} · G  ?=  Σ_{k=0..t-1}  (j^k) · C_{i,k}
 *     Returns the set of participants whose shares verified
 *     (the QUAL set, after the optional complaint round).
 *
 *   Round 3 (Output):
 *     Each j computes their share of the collective polynomial:
 *       s_j = Σ_{i ∈ QUAL} s_{i,j}
 *     Anyone can compute the collective public key:
 *       Y = f(0) · G = Σ_{i ∈ QUAL} C_{i,0}
 *     The collective secret f(0) = Σ_{i ∈ QUAL} a_{i,0} is NEVER
 *     materialized by any single party.
 *
 * The result is functionally equivalent to a single trusted dealer
 * producing the same Shamir/Feldman split, except the dealer doesn't
 * exist — every party contributes randomness and verifies the others.
 *
 * For the v4-partial composition: the operator's
 * `buildAttestedHomomorphicSum`'s thresholdReveal path can be wired
 * to use DKG-derived shares + commitments instead of the dealer's
 * Shamir split. The bundle's `coefficientCommitments` is then the
 * SUM of all parties' published commitments; the per-party shares
 * are the sum of received per-party shares.
 *
 * What this ships is the PROTOCOL primitive — a single-process
 * simulation that proves the composition works end-to-end. A
 * production multi-node deployment needs the round-2 broadcast layer
 * (any transport — pod descriptors via `agg:DKGRound1Broadcast`
 * works) and the optional round-3 complaint resolution. Both compose
 * existing substrate primitives without new ontology terms.
 */

import { ristretto255 } from '@noble/curves/ed25519.js';
import {
  splitSecretWithCommitments,
  verifyShare,
  type FeldmanCommitments,
  type VerifiableShamirShare,
} from './feldman-vss.js';

const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

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

// ─────────────────────────────────────────────────────────────────────
//  Round 1: Each party generates their polynomial + commitments
// ─────────────────────────────────────────────────────────────────────

export interface DKGParticipantState {
  /** Participant index (1..n; 0 reserved for the secret). */
  readonly index: number;
  /** Total participants. */
  readonly n: number;
  /** Threshold. */
  readonly t: number;
  /** The party's own polynomial commitments (PUBLIC — broadcast to everyone). */
  readonly ownCommitments: FeldmanCommitments;
  /**
   * The shares this party generated for every recipient. shares[j-1] is
   * the share to give to participant j (over a confidential channel).
   * shares[index-1] is this party's own share of their own polynomial.
   */
  readonly ownShares: readonly VerifiableShamirShare[];
}

/**
 * Round 1: a participant generates a random degree-(t-1) polynomial,
 * publishes per-coefficient commitments, and generates per-recipient
 * shares. Returns the participant's complete round-1 state.
 *
 * Composes `splitSecretWithCommitments` from feldman-vss.ts — the
 * "secret" of this party's local polynomial is a random scalar (the
 * a_{i,0} coefficient, which contributes to the collective secret
 * f(0) without ever being individually revealed).
 */
export function dkgRound1(args: {
  index: number;
  n: number;
  t: number;
}): DKGParticipantState {
  if (args.index < 1 || args.index > args.n) {
    throw new Error(`dkgRound1: index ${args.index} out of range [1, ${args.n}]`);
  }
  if (args.t < 1 || args.t > args.n) {
    throw new Error(`dkgRound1: threshold ${args.t} out of range [1, ${args.n}]`);
  }
  // Pick a random "secret" — this becomes a_{i,0}, the constant term
  // of this party's polynomial. The collective secret f(0) is the sum.
  const secret = randomScalar();
  const split = splitSecretWithCommitments({
    secret,
    totalShares: args.n,
    threshold: args.t,
  });
  return {
    index: args.index,
    n: args.n,
    t: args.t,
    ownCommitments: split.commitments,
    ownShares: split.shares,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Round 2: Verify received shares against published commitments
// ─────────────────────────────────────────────────────────────────────

export interface DKGReceivedShare {
  /** Index of the participant who SENT this share. */
  readonly fromIndex: number;
  /** Share itself (the sender ran feldman-vss; the share's x = recipientIndex). */
  readonly share: VerifiableShamirShare;
  /** The sender's published commitments (everyone has these after Round 1 broadcast). */
  readonly senderCommitments: FeldmanCommitments;
}

export interface DKGRound2Result {
  /** Participants whose shares verified (the QUAL set). */
  readonly qualifiedSenders: readonly number[];
  /** Participants whose shares failed verification (would trigger complaints in the full protocol). */
  readonly rejectedSenders: readonly number[];
}

/**
 * Round 2: this participant verifies each share they received from
 * other parties. Returns the set of qualified senders + the set
 * whose shares failed verification (a real deployment would trigger
 * a complaint round — see protocol docstring).
 *
 * The recipient's own share (received from themselves) is also
 * checked for consistency.
 */
export function dkgRound2(args: {
  recipientIndex: number;
  received: readonly DKGReceivedShare[];
}): DKGRound2Result {
  const qualified: number[] = [];
  const rejected: number[] = [];
  for (const r of args.received) {
    // Sanity: the share's x must equal this recipient's index.
    if (r.share.x !== args.recipientIndex) {
      rejected.push(r.fromIndex);
      continue;
    }
    const ok = verifyShare({ share: r.share, commitments: r.senderCommitments });
    if (ok) qualified.push(r.fromIndex);
    else rejected.push(r.fromIndex);
  }
  return { qualifiedSenders: qualified, rejectedSenders: rejected };
}

// ─────────────────────────────────────────────────────────────────────
//  Round 3: Compute combined share + collective public key
// ─────────────────────────────────────────────────────────────────────

export interface DKGFinalState {
  /** This participant's share of the COLLECTIVE polynomial. */
  readonly combinedShare: VerifiableShamirShare;
  /** The collective polynomial's coefficient commitments (sum of per-party commitments). */
  readonly collectiveCommitments: FeldmanCommitments;
  /** The collective public key Y = f(0) · G (== collectiveCommitments.points[0]). */
  readonly collectivePublicKey: string;
  /** The set of participants whose contributions are included. */
  readonly qual: readonly number[];
}

/**
 * Round 3: combine the verified shares + commitments into the final
 * state.
 *
 * combinedShare.y = Σ_{i ∈ QUAL} received[i].share.y (mod L) — this
 *   is this participant's share of the collective polynomial f, where
 *   f = Σ_{i ∈ QUAL} f_i.
 *
 * collectiveCommitments is computed by adding (per-coefficient-index)
 *   the points from each qualified sender's commitments. The result is
 *   a valid FeldmanCommitments object that any of the n participants
 *   can verify their combinedShare against.
 *
 * collectivePublicKey is hex-encoded collectiveCommitments.points[0]
 *   (the commitment to f(0), i.e., the collective secret).
 */
export function dkgRound3(args: {
  recipientIndex: number;
  t: number;
  qualifiedReceived: readonly DKGReceivedShare[];
}): DKGFinalState {
  if (args.qualifiedReceived.length === 0) {
    throw new Error('dkgRound3: no qualified shares to combine');
  }
  const t = args.t;
  // Per-coefficient sum of points.
  let combinedY = 0n;
  const collectivePoints: ReturnType<typeof ristretto255.Point.fromBytes>[] = [];
  for (let k = 0; k < t; k++) collectivePoints.push(ristretto255.Point.ZERO);

  for (const r of args.qualifiedReceived) {
    combinedY = modL(combinedY + r.share.y);
    if (r.senderCommitments.points.length !== t) {
      throw new Error(`dkgRound3: sender ${r.fromIndex} has ${r.senderCommitments.points.length} commitments, expected ${t}`);
    }
    for (let k = 0; k < t; k++) {
      const senderPoint = ristretto255.Point.fromBytes(hexToBytes(r.senderCommitments.points[k]!));
      collectivePoints[k] = collectivePoints[k]!.add(senderPoint);
    }
  }

  const collectiveHex = collectivePoints.map(p => bytesToHex(p.toBytes()));
  const qual = [...args.qualifiedReceived].map(r => r.fromIndex).sort((a, b) => a - b);
  return {
    combinedShare: {
      x: args.recipientIndex,
      y: combinedY,
      threshold: t,
      totalShares: args.qualifiedReceived.length, // each share holder counts the n contributing parties
    },
    collectiveCommitments: { points: collectiveHex, threshold: t },
    collectivePublicKey: collectiveHex[0]!,
    qual,
  };
}

/**
 * Convenience: drive an end-to-end n-party DKG within a single process
 * (suitable for tests + the walkthrough). Returns each participant's
 * final state. In a real multi-node deployment the rounds are wire
 * messages between separate processes; the substrate primitive is the
 * same.
 */
export function simulateDKG(args: { n: number; t: number }): DKGFinalState[] {
  const { n, t } = args;
  // Round 1: each party generates their polynomial + commitments + shares.
  const r1: DKGParticipantState[] = [];
  for (let i = 1; i <= n; i++) {
    r1.push(dkgRound1({ index: i, n, t }));
  }

  // Round 2 (implicit in this honest simulation): every party verifies
  // every received share. With all honest parties the QUAL set is
  // {1..n}; bury Round 2 here for the test walkthrough — the
  // documented function is exposed separately for adversarial-case
  // tests.
  const allParticipants = Array.from({ length: n }, (_, k) => k + 1);

  // Round 3: combine.
  const finals: DKGFinalState[] = [];
  for (let j = 1; j <= n; j++) {
    const receivedForJ: DKGReceivedShare[] = r1.map(state => ({
      fromIndex: state.index,
      share: state.ownShares[j - 1]!,
      senderCommitments: state.ownCommitments,
    }));
    // In an honest run, Round 2 qualifies everyone.
    const r2 = dkgRound2({ recipientIndex: j, received: receivedForJ });
    if (r2.qualifiedSenders.length !== n) {
      throw new Error(`simulateDKG: honest run failed — recipient ${j} only qualified ${r2.qualifiedSenders.length} of ${n} senders`);
    }
    const finalState = dkgRound3({
      recipientIndex: j,
      t,
      qualifiedReceived: receivedForJ,
    });
    finals.push(finalState);
  }

  // Cross-check: every participant must agree on the collective public key.
  const pk0 = finals[0]!.collectivePublicKey;
  for (const f of finals) {
    if (f.collectivePublicKey !== pk0) {
      throw new Error(`simulateDKG: participants disagree on collectivePublicKey`);
    }
  }
  // Cross-check: QUAL must be identical across participants.
  const qual0 = finals[0]!.qual.join(',');
  for (const f of finals) {
    if (f.qual.join(',') !== qual0) {
      throw new Error(`simulateDKG: participants disagree on QUAL`);
    }
  }
  // Sanity: every combined share verifies against the collective
  // commitments (this is the headline guarantee — the substrate's
  // existing verifyShare works on the collective polynomial too).
  for (const f of finals) {
    if (!verifyShare({ share: f.combinedShare, commitments: f.collectiveCommitments })) {
      throw new Error(`simulateDKG: combined share for participant ${f.combinedShare.x} fails verification against collective commitments`);
    }
  }

  void allParticipants; // referenced for future symmetric-difference logic
  return finals;
}
