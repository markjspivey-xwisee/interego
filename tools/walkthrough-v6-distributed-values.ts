#!/usr/bin/env node
/**
 * Walkthrough: v6 distributed values + distributed blindings.
 *
 * Single-process narrative for the substrate's protocol where the
 * operator sees neither individual values nor individual blindings.
 *
 * v5 distributed blindings; the operator still saw cleartext values
 * for trueSum + DP noise. v6 doubles the construction: contributors
 * VSS-share their VALUES too. The operator gets trueSum via a t-of-n
 * committee Lagrange reveal — never sees any individual v_i.
 *
 * Same emergent composition as v5, applied twice:
 *   - Shamir's additive homomorphism gives combined-share-of-sum on
 *     BOTH the value polynomial and the blinding polynomial
 *   - Per-coefficient point-sum of Feldman commitments gives the
 *     COMBINED VSS commitments for both
 *
 * The only new piece is `revealTrueSumFromCommittee`: the operator
 * Lagrange-interpolates trueSum from t pseudo-aggregator combined
 * VALUE shares. Audit-time blinding reveal works identically.
 */

/* eslint-disable no-console */

import {
  buildDistributedContributionV6,
  aggregatePseudoAggregatorSharesV6,
  revealTrueSumFromCommittee,
  buildAttestedHomomorphicSumV6,
  verifyAttestedHomomorphicSumV6,
  type DistributedContributionV6,
} from '../applications/_shared/aggregate-privacy/index.js';
import { generateKeyPair } from '../src/crypto/encryption.js';
import type { IRI } from '../src/index.js';

const COHORT = 'urn:demo:cohort:v6-walkthrough' as IRI;
const AGGREGATOR = 'did:web:operator.v6-demo' as IRI;
const L_V6 = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

function header(t: string): void { console.log('\n' + '─'.repeat(72)); console.log(t); console.log('─'.repeat(72)); }
function step(n: number, t: string): void { console.log(`\n  [${n}] ${t}`); }
function ok(t: string): void { console.log(`      ✓ ${t}`); }
function info(t: string): void { console.log(`      · ${t}`); }

function main(): void {
  header('v6 distributed values + distributed blindings — walkthrough');
  info(`Cohort: ${COHORT}`);
  info(`Operator: ${AGGREGATOR}`);
  info('Headline guarantee: operator sees neither individual values nor individual blindings.');

  header('PHASE 1 — Define cohort: 4 contributors + 5-aggregator committee (t=3)');
  const committee = [1, 2, 3, 4, 5].map(j => ({
    index: j,
    recipientDid: `did:demo:v6-pseudo-${j}` as IRI,
    keyPair: generateKeyPair(),
  }));
  for (const m of committee) {
    ok(`Committee member ${m.index}: ${m.recipientDid} (X25519 pub ${m.keyPair.publicKey.slice(0, 16)}…)`);
  }
  const bounds = { min: 0n, max: 100n };
  const values = [25n, 35n, 45n, 55n];
  const n = committee.length, t = 3;
  info(`True sum (private from operator throughout): ${values.reduce((a, b) => a + b, 0n)}`);

  header('PHASE 2 — Each contributor commits + VSS-splits both value AND blinding');
  const contributions: DistributedContributionV6[] = values.map((v, i) =>
    buildDistributedContributionV6({
      contributorPodUrl: `https://v6-contributor-${i + 1}.demo/`,
      value: v, bounds,
      committee: committee.map(m => ({ recipientDid: m.recipientDid, recipientPublicKey: m.keyPair.publicKey })),
      threshold: t,
      contributorSenderKeyPair: generateKeyPair(),
      blindingSeed: `walk-v6-b-${i}`, valueSeed: `walk-v6-v-${i}`,
    }),
  );
  for (let i = 0; i < contributions.length; i++) {
    const c = contributions[i]!;
    ok(`Contributor ${i + 1}: commitment=${c.commitment.bytes.slice(0, 16)}…, valueVSS pts=${c.valueCommitments.points.length}, blindingVSS pts=${c.blindingCommitments.points.length}, value envelopes=${c.encryptedValueShares.length}, blinding envelopes=${c.encryptedBlindingShares.length}`);
    info(`  (cleartext value never published — contributor keeps it locally)`);
  }

  header('PHASE 3 — Each pseudo-aggregator decrypts + verifies + sums BOTH share-types');
  const allShares = committee.map(m => aggregatePseudoAggregatorSharesV6({
    contributions, pseudoAggregatorIndex: m.index, ownKeyPair: m.keyPair,
  }));
  for (let i = 0; i < allShares.length; i++) {
    const s = allShares[i]!;
    ok(`Pseudo-aggregator ${committee[i]!.index}: combined value share y=${String(s.combinedValueShare.y).slice(0, 28)}…, combined blinding share y=${String(s.combinedBlindingShare.y).slice(0, 28)}…`);
  }
  info('Each pseudo-aggregator sees ONLY their own combined shares — information-theoretically random alone.');

  header('PHASE 4 — Operator requests trueSum via t-of-n committee Lagrange');
  const committeeSubset = [allShares[0]!, allShares[2]!, allShares[4]!];
  const reveal = revealTrueSumFromCommittee({
    contributions,
    committeeValueShares: committeeSubset.map(s => s.combinedValueShare),
    threshold: t,
  });
  if (!reveal.valid) { console.error(`      ✗ reveal failed: ${reveal.reason}`); process.exit(1); }
  ok(`Reveal valid: ${reveal.verifiedShareCount} verified, ${reveal.rejectedShareCount} rejected`);
  ok(`Operator now knows trueSum = ${reveal.trueSum} (publishable as noisy sum)`);
  info('Operator NEVER saw any individual contributor value. Only the aggregate.');

  header('PHASE 5 — Operator builds the bundle + adds DP noise');
  const bundle = buildAttestedHomomorphicSumV6({
    cohortIri: COHORT, aggregatorDid: AGGREGATOR,
    contributions, revealedTrueSum: reveal.trueSum!,
    epsilon: 1.0, includeAuditFields: true, threshold: { n, t },
  });
  ok(`sumCommitment = ${bundle.sumCommitment.bytes.slice(0, 32)}…`);
  ok(`trueSum=${bundle.trueSum} + noise=${bundle.noise} → noisySum=${bundle.noisySum} (publishable)`);
  ok(`combinedValueCommitments.points.length = ${bundle.combinedValueCommitments.points.length}`);
  ok(`combinedBlindingCommitments.points.length = ${bundle.combinedBlindingCommitments.points.length}`);
  ok(`privacyMode = ${bundle.privacyMode}`);

  header('PHASE 6 — Auditor verifies via blinding-side committee shares');
  const auditCommittee = [allShares[0]!, allShares[2]!, allShares[4]!];
  const audit = verifyAttestedHomomorphicSumV6({
    bundle,
    committeeBlindingShares: auditCommittee.map(s => s.combinedBlindingShare),
    claimedTrueSum: reveal.trueSum!,
  });
  if (!audit.valid) { console.error(`      ✗ audit failed: ${audit.reason}`); process.exit(1); }
  ok(`Audit valid: ${audit.verifiedShareCount} verified, ${audit.rejectedShareCount} rejected`);
  ok(`Reconstructed trueBlinding = ${String(audit.reconstructedTrueBlinding).slice(0, 28)}…`);
  ok('sumCommitment opens to (claimedTrueSum, reconstructedTrueBlinding) ✓');

  header('PHASE 7 — Tampering simulation #1: tampered value share at reveal');
  const honest4Values = [0, 1, 2, 3].map(i => allShares[i]!.combinedValueShare);
  const tamperedValue = { ...honest4Values[1]!, y: (honest4Values[1]!.y + 1n) % L_V6 };
  const mixedValues = [honest4Values[0]!, tamperedValue, honest4Values[2]!, honest4Values[3]!];
  const tamperReveal = revealTrueSumFromCommittee({
    contributions, committeeValueShares: mixedValues, threshold: t,
  });
  ok(`Submit 4 value shares (3 honest + 1 tampered): ${tamperReveal.verifiedShareCount} verified, ${tamperReveal.rejectedShareCount} rejected`);
  ok(`Reveal still valid? ${tamperReveal.valid} (3 verified meets threshold)`);
  info('Combined-VSS catches the tampered share BEFORE Lagrange poisons the trueSum.');

  header('PHASE 8 — Tampering simulation #2: tampered blinding share at audit');
  const honest4Blindings = [0, 1, 2, 3].map(i => allShares[i]!.combinedBlindingShare);
  const tamperedBlinding = { ...honest4Blindings[2]!, y: (honest4Blindings[2]!.y + 1n) % L_V6 };
  const mixedBlindings = [honest4Blindings[0]!, honest4Blindings[1]!, tamperedBlinding, honest4Blindings[3]!];
  const tamperAudit = verifyAttestedHomomorphicSumV6({
    bundle, committeeBlindingShares: mixedBlindings, claimedTrueSum: reveal.trueSum!,
  });
  ok(`Submit 4 blinding shares (3 honest + 1 tampered): ${tamperAudit.verifiedShareCount} verified, ${tamperAudit.rejectedShareCount} rejected`);
  ok(`Audit still valid? ${tamperAudit.valid}`);

  header('PHASE 9 — Trust analysis');
  info('Contributor i: sees own value v_i, own blinding b_i. Never sees other contributors\' state.');
  info('Operator:');
  info('  · sees: per-contributor commitments c_i, per-contributor VSS commitments (value + blinding),');
  info('    encrypted-share envelopes (unopenable), revealed trueSum (via committee), noisySum');
  info('  · NEVER sees: individual values v_i, individual blindings b_i, individual pseudo-aggregator shares');
  info('Pseudo-aggregator j:');
  info('  · sees: one value-share + one blinding-share PER contributor (decrypted from envelopes)');
  info('  · NEVER sees: other pseudo-aggregators\' shares, trueSum / trueBlinding (until t-of-n)');
  info('Auditor:');
  info('  · sees: the published bundle');
  info('  · verifies: at audit time, t-of-n pseudo-aggregators submit combined blinding shares;');
  info('    auditor confirms sumCommitment opens to (revealedTrueSum, reconstructedTrueBlinding)');

  header('Walkthrough complete');
  info('Emergent property: the operator\'s trust assumption is reduced to honest-but-curious about TRUESUM ONLY.');
  info('No party (operator, any single pseudo-aggregator, auditor) sees any individual value or blinding.');
  info('Closest the v3-family can get to zero-trust without distributed noise generation.');
  console.log();
}

main();
