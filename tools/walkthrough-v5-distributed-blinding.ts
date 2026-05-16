#!/usr/bin/env node
/**
 * Walkthrough: v5 contributor-distributed blinding sharing.
 *
 * Single-process narrative for the substrate's first protocol that
 * removes the trusted-aggregator caveat. NO single party (operator,
 * any pseudo-aggregator, the auditor) ever sees trueBlinding before
 * a t-of-n committee reveal.
 *
 * Why this is different from v4-partial:
 *   v4-partial: operator computes trueBlinding (contributors revealed
 *               blindings to the operator), then Shamir-splits it.
 *               Trust assumption: operator hadn't already exfiltrated
 *               trueBlinding before splitting.
 *   v5:         contributors split their OWN blindings via Feldman
 *               VSS to the pseudo-aggregator committee. Operator
 *               never sees blindings. Each pseudo-aggregator sees
 *               only their own combined share (sum of received
 *               per-contributor shares). The combined polynomial
 *               F(x) = Σ_i f_i(x) has F(0) = trueBlinding, and a
 *               t-of-n committee can Lagrange-interpolate F(0)
 *               from {F(j)}_j = {s_j}_j.
 *
 * The emergence: Shamir is additively homomorphic. Contributors
 * each VSS-share their blinding to the SAME committee using the
 * SAME (n, t) parameters; each pseudo-aggregator sums their received
 * shares; the sums ARE shares of the sum of blindings. The combined
 * VSS commitments (per-coefficient point-sum) are exactly the
 * commitments to F's coefficients, so the standard Feldman check
 * verifies combined shares without any new primitive.
 *
 * Phases:
 *   1. Define cohort: contributors + committee (n pseudo-aggregators).
 *   2. Each contributor i: commit v_i + VSS-split b_i to the
 *      committee + encrypt each share for its recipient.
 *   3. Operator: collect DistributedContributions, compute trueSum
 *      (from cleartext v_i — hiding values is v6 work), homomorphic
 *      sumCommitment, DP noise, COMBINED VSS commitments. Operator
 *      never sees any b_i.
 *   4. Each pseudo-aggregator: decrypt + verify received shares,
 *      sum to get combined share s_j. The combined share verifies
 *      against the COMBINED VSS commitments (without revealing
 *      anything about trueBlinding).
 *   5. Reveal: t-of-n committee submits their s_j; verifier filters
 *      via VSS, Lagrange-interpolates trueBlinding, confirms
 *      sumCommitment opens.
 *   6. Tampering simulation: corrupt one combined share, VSS
 *      catches it before Lagrange.
 *   7. Sensitivity / what each party sees: explicit print-out.
 */

/* eslint-disable no-console */

import {
  buildDistributedContribution,
  aggregatePseudoAggregatorShares,
  buildAttestedHomomorphicSumV5,
  reconstructAndVerifyV5,
  type DistributedContribution,
} from '../applications/_shared/aggregate-privacy/index.js';
import { generateKeyPair } from '../src/crypto/encryption.js';
import { verifyShare } from '../src/crypto/feldman-vss.js';
import type { IRI } from '../src/index.js';

const COHORT = 'urn:demo:cohort:v5-walkthrough' as IRI;
const AGGREGATOR = 'did:web:operator.v5-demo' as IRI;
const L_V5 = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

function header(t: string): void { console.log('\n' + '─'.repeat(72)); console.log(t); console.log('─'.repeat(72)); }
function step(n: number, t: string): void { console.log(`\n  [${n}] ${t}`); }
function ok(t: string): void { console.log(`      ✓ ${t}`); }
function info(t: string): void { console.log(`      · ${t}`); }

function main(): void {
  header('v5 contributor-distributed blinding sharing — walkthrough');
  info(`Cohort: ${COHORT}`);
  info(`Operator: ${AGGREGATOR}`);
  info('Headline guarantee: NO single party (operator, any single pseudo-aggregator, the auditor) ever sees trueBlinding before t-of-n reveal.');

  // ────────────────────────────────────────────────────────────────
  // PHASE 1 — Define cohort: 4 contributors + 5-of-3 committee.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 1 — Define cohort: 4 contributors + 5-aggregator committee (t=3)');
  const committee = [1, 2, 3, 4, 5].map(j => ({
    index: j,
    recipientDid: `did:demo:pseudo-${j}` as IRI,
    keyPair: generateKeyPair(),
  }));
  for (const m of committee) {
    ok(`Committee member ${m.index}: ${m.recipientDid} (X25519 pub ${m.keyPair.publicKey.slice(0, 16)}…)`);
  }
  const bounds = { min: 0n, max: 100n };
  const values = [25n, 35n, 45n, 55n];
  const t = 3, n = committee.length;

  // ────────────────────────────────────────────────────────────────
  // PHASE 2 — Each contributor: commit + VSS-split blinding + encrypt shares.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 2 — Each contributor commits + VSS-splits their OWN blinding');
  const contributions: DistributedContribution[] = values.map((v, i) =>
    buildDistributedContribution({
      contributorPodUrl: `https://contributor-${i + 1}.demo/`,
      value: v,
      bounds,
      committee: committee.map(m => ({ recipientDid: m.recipientDid, recipientPublicKey: m.keyPair.publicKey })),
      threshold: t,
      contributorSenderKeyPair: generateKeyPair(),
      blindingSeed: `walk-v5-${i}`,
    }),
  );
  for (let i = 0; i < contributions.length; i++) {
    const c = contributions[i]!;
    ok(`Contributor ${i + 1}: value=${c.value}, commitment=${c.commitment.bytes.slice(0, 16)}…, VSS pts=${c.blindingCommitments.points.length}, encrypted shares=${c.encryptedShares.length}`);
  }
  info(`True sum (private from operator at this phase): ${values.reduce((a, b) => a + b, 0n)}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 3 — Operator builds the bundle WITHOUT ever seeing blindings.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 3 — Operator builds the bundle (NEVER sees any blinding)');
  const bundle = buildAttestedHomomorphicSumV5({
    cohortIri: COHORT,
    aggregatorDid: AGGREGATOR,
    contributions,
    epsilon: 1.0,
    includeAuditFields: true,
    threshold: { n, t },
  });
  step(1, 'Homomorphic sum-commitment');
  ok(`sumCommitment = ${bundle.sumCommitment.bytes.slice(0, 32)}…`);
  step(2, 'DP-Laplace noise added (operator sees cleartext values for trueSum + noise; that\'s v6 to remove)');
  ok(`trueSum=${bundle.trueSum}, noise=${bundle.noise}, noisySum=${bundle.noisySum} (publishable)`);
  step(3, 'COMBINED VSS commitments (per-coefficient point-sum of contributor VSS commitments)');
  ok(`combinedBlindingCommitments.points.length = ${bundle.combinedBlindingCommitments.points.length}`);
  ok(`combinedBlindingCommitments.threshold = ${bundle.combinedBlindingCommitments.threshold}`);
  step(4, 'What the bundle does NOT contain');
  ok(`trueBlinding in bundle? ${(bundle as unknown as Record<string, unknown>).trueBlinding === undefined ? 'NO (as required)' : 'YES (BUG)'}`);
  ok('Per-contributor blindings? Never visible to anyone except their contributor.');

  // ────────────────────────────────────────────────────────────────
  // PHASE 4 — Each pseudo-aggregator decrypts + verifies + sums.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 4 — Each pseudo-aggregator decrypts + verifies + sums their received shares');
  const combinedShares = committee.map(m => {
    const s = aggregatePseudoAggregatorShares({
      contributions,
      pseudoAggregatorIndex: m.index,
      ownKeyPair: m.keyPair,
    });
    // Verify each combined share against the COMBINED VSS commitments (the
    // operator-published artifact — the auditor can do this check too).
    const verified = verifyShare({ share: s, commitments: bundle.combinedBlindingCommitments });
    return { member: m, share: s, verified };
  });
  for (const cs of combinedShares) {
    ok(`Pseudo-aggregator ${cs.member.index} combined share: x=${cs.share.x}, y=${String(cs.share.y).slice(0, 32)}…, verifies-against-combined-VSS: ${cs.verified}`);
  }
  info('Each pseudo-aggregator sees ONLY their own combined share. A single combined share is information-theoretically random — reveals nothing about trueBlinding.');

  // ────────────────────────────────────────────────────────────────
  // PHASE 5 — t-of-n committee reveals trueBlinding.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 5 — t-of-n committee (members #1, #3, #5) reconstructs trueBlinding');
  const committeeSubset = [combinedShares[0]!.share, combinedShares[2]!.share, combinedShares[4]!.share];
  const reveal = reconstructAndVerifyV5({
    bundle,
    committeeShares: committeeSubset,
    claimedTrueSum: bundle.trueSum!,
  });
  if (!reveal.valid) { console.error(`      ✗ reveal failed: ${reveal.reason}`); process.exit(1); }
  ok(`Reveal valid: ${reveal.verifiedShareCount} verified, ${reveal.rejectedShareCount} rejected`);
  ok(`Reconstructed trueBlinding = ${String(reveal.reconstructedTrueBlinding).slice(0, 32)}…`);
  ok('sumCommitment opens to (claimedTrueSum, reconstructedTrueBlinding) ✓');

  // ────────────────────────────────────────────────────────────────
  // PHASE 6 — Tampering: VSS catches a corrupted combined share before Lagrange.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 6 — Tampering simulation: VSS catches corrupted combined share');
  const honest4 = [0, 1, 2, 3].map(i => combinedShares[i]!.share);
  const tampered = { ...honest4[1]!, y: (honest4[1]!.y + 1n) % L_V5 };
  const mixed = [honest4[0]!, tampered, honest4[2]!, honest4[3]!];
  const tamperReveal = reconstructAndVerifyV5({
    bundle,
    committeeShares: mixed,
    claimedTrueSum: bundle.trueSum!,
  });
  ok(`Submit 4 shares (3 honest + 1 tampered) → ${tamperReveal.verifiedShareCount} verified, ${tamperReveal.rejectedShareCount} rejected`);
  ok(`Reveal still valid? ${tamperReveal.valid} (3 verified still meets threshold t=3)`);
  info('Without combined-VSS, the tampered share would silently poison Lagrange. The substrate filters it BEFORE reconstruction.');

  // ────────────────────────────────────────────────────────────────
  // PHASE 7 — What each party sees.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 7 — What each party sees (trust analysis)');
  info('Contributor i:');
  info('  · sees own value v_i, own blinding b_i — kept locally');
  info('  · sends commitment c_i (PUBLIC), VSS commitments {C_i^{(k)}} (PUBLIC), encrypted shares (per-recipient)');
  info('  · NEVER sees any other contributor\'s value or blinding');
  info('Operator:');
  info('  · sees: cleartext values v_i, commitments c_i, VSS commitments {C_i^{(k)}}, encrypted-share envelopes (unopenable)');
  info('  · computes: trueSum, sumCommitment (homomorphic), DP noise, combined VSS commitments');
  info('  · NEVER sees: any contributor blinding, any pseudo-aggregator share, trueBlinding');
  info('Pseudo-aggregator j:');
  info('  · sees: one share b_i^{(j)} per contributor (verifies via VSS), own combined share s_j');
  info('  · NEVER sees: other pseudo-aggregators\' shares, contributor blindings, trueBlinding (until t-of-n cooperation)');
  info('Auditor:');
  info('  · sees: the published bundle (contributorCommitments, sumCommitment, combinedBlindingCommitments, noisySum, ε, etc.)');
  info('  · verifies: at audit time, t-of-n pseudo-aggregators reveal combined shares; auditor confirms sumCommitment opens');
  info('  · NEVER sees: any single blinding without committee cooperation');

  header('Walkthrough complete');
  info('Emergent property: the operator\'s trust assumption is reduced to honest-but-curious about CLEARTEXT VALUES only.');
  info('The blinding-side of the privacy boundary is now distributed across the committee — no trusted dealer anywhere.');
  info('Hiding cleartext values from the operator (additive secret-sharing of v_i too) is the natural v6 layer.');
  console.log();
}

main();
