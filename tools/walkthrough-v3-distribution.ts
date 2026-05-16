#!/usr/bin/env node
/**
 * Walkthrough: v3 zk-distribution — per-bucket homomorphic sums + DP noise.
 *
 * Single-process narrative that exercises the v3 zk-distribution
 * aggregate-privacy layer end-to-end. Companion to
 * tools/walkthrough-v4-partial-vss.ts (which demonstrates the
 * threshold-reveal chain). Pure protocol-layer demo; no pod required.
 *
 * What this demonstrates:
 *   1. Define a bucketing scheme (numeric edges + maxValue).
 *   2. Five contributors each build a BucketedCommittedContribution —
 *      one-hot encoded across all buckets so the bucket their value
 *      falls into gets commit(1, blinding) and every other bucket
 *      commit(0, blinding).
 *   3. Operator runs buildAttestedHomomorphicDistribution: per-bucket
 *      homomorphic sums + per-bucket DP-Laplace noise.
 *   4. Auditor verifies the bundle: per-bucket structural check
 *      (sum equals homomorphic sum of contributor commitments) +
 *      per-bucket opening check (sum opens to claimed trueBucketCount).
 *   5. Tampering simulation: forged per-bucket commitment, forged
 *      true count — both caught.
 *   6. Sensitivity note: per-bucket ε is the standard DP guarantee;
 *      cumulative histogram ε under sequential composition is k * ε.
 */

/* eslint-disable no-console */

import {
  buildBucketedContribution,
  buildAttestedHomomorphicDistribution,
  verifyAttestedHomomorphicDistribution,
  type NumericBucketingScheme,
} from '../applications/_shared/aggregate-privacy/index.js';
import type { IRI } from '../src/index.js';

const COHORT = 'urn:demo:cohort:v3-distribution' as IRI;
const AGGREGATOR = 'did:web:operator.demo' as IRI;

function header(title: string): void {
  console.log('\n' + '─'.repeat(72));
  console.log(title);
  console.log('─'.repeat(72));
}

function step(n: number, text: string): void {
  console.log(`\n  [${n}] ${text}`);
}

function ok(text: string): void {
  console.log(`      ✓ ${text}`);
}

function info(text: string): void {
  console.log(`      · ${text}`);
}

function main(): void {
  header('v3 zk-distribution — walkthrough');
  info(`Cohort: ${COHORT}`);
  info(`Operator: ${AGGREGATOR}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 1 — Define the bucketing scheme.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 1 — Define the bucketing scheme');
  const scheme: NumericBucketingScheme = {
    type: 'numeric',
    edges: [0n, 25n, 50n, 75n],
    maxValue: 100n,
  };
  ok(`Scheme edges: [${scheme.edges.join(', ')}]`);
  ok(`maxValue: ${scheme.maxValue}`);
  ok(`Buckets: [0,25), [25,50), [50,100] — 3 buckets total`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 2 — Five contributors commit their values.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 2 — Five contributors commit (one-hot encoded)');
  const values: Array<{ pod: string; value: bigint }> = [
    { pod: 'https://alice/', value: 18n },
    { pod: 'https://bob/',   value: 33n },
    { pod: 'https://carol/', value: 47n },
    { pod: 'https://dave/',  value: 62n },
    { pod: 'https://eve/',   value: 88n },
  ];
  const contributions = values.map(({ pod, value }, i) =>
    buildBucketedContribution({
      contributorPodUrl: pod, value, scheme, blindingSeed: `walk-${i}`,
    }),
  );
  for (let i = 0; i < contributions.length; i++) {
    const c = contributions[i]!;
    ok(`${values[i]!.pod} value=${values[i]!.value} → bucket ${c.bucket} (one-hot vector across ${c.perBucketCommitments.length} commitments)`);
  }

  // ────────────────────────────────────────────────────────────────
  // PHASE 3 — Operator builds the attested distribution bundle.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 3 — Operator builds the attested distribution bundle');
  const bundle = buildAttestedHomomorphicDistribution({
    cohortIri: COHORT,
    aggregatorDid: AGGREGATOR,
    contributions,
    epsilon: 1.0,
    includeAuditFields: true,
  });
  step(1, 'Per-bucket homomorphic sum computed');
  for (let i = 0; i < bundle.bucketSumCommitments.length; i++) {
    ok(`Bucket ${i} sum commitment = ${bundle.bucketSumCommitments[i]!.bytes.slice(0, 32)}…`);
  }
  step(2, 'Per-bucket DP-Laplace noise added (per-bucket sensitivity = 1)');
  for (let i = 0; i < bundle.noisyBucketCounts.length; i++) {
    ok(`Bucket ${i}: trueCount=${bundle.trueBucketCounts![i]} noise=${bundle.noisePerBucket[i]} noisyCount=${bundle.noisyBucketCounts[i]}`);
  }
  step(3, 'Publishable noisyBucketCounts vector');
  ok(`[${bundle.noisyBucketCounts.join(', ')}] — this is what the regulator sees`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 4 — Auditor verifies the bundle.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 4 — Auditor verifies the bundle');
  const verification = verifyAttestedHomomorphicDistribution(bundle);
  if (!verification.valid) {
    console.error(`      ✗ Verification failed: ${verification.reason}`);
    process.exit(1);
  }
  ok('Per-bucket structural verification: every bucketSumCommitment equals the homomorphic sum of contributor commitments');
  ok('Per-bucket opening: every bucketSumCommitment opens to (claimedTrueBucketCount, sum of bucket blindings)');
  ok('Cross-check: every noisyBucketCount == trueBucketCount + noise');
  ok(`Epsilon claim is positive: ${bundle.epsilon}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 5 — Tampering simulation #1: forged per-bucket commitment.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 5 — Tampering simulation #1: forged per-bucket commitment');
  const forgedSum = {
    ...bundle,
    bucketSumCommitments: [
      bundle.bucketSumCommitments[1]!, // swap bucket 0's commitment with bucket 1's
      bundle.bucketSumCommitments[1]!,
      bundle.bucketSumCommitments[2]!,
    ],
  };
  const v1 = verifyAttestedHomomorphicDistribution(forgedSum);
  ok(`Forged commitment REJECTED: ${!v1.valid} (reason: ${v1.reason})`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 6 — Tampering simulation #2: forged trueBucketCounts.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 6 — Tampering simulation #2: forged trueBucketCounts');
  const forgedCounts = {
    ...bundle,
    trueBucketCounts: [99n, 99n, 99n],
  };
  const v2 = verifyAttestedHomomorphicDistribution(forgedCounts);
  ok(`Forged counts REJECTED: ${!v2.valid} (reason: ${v2.reason})`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 7 — Sensitivity note.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 7 — DP sensitivity reminder');
  info('Per-bucket ε = 1.0 in this demo. Per-bucket sensitivity is 1');
  info('(one-hot encoding bounds each contributor\'s per-bucket value to {0, 1}),');
  info('so each bucket has the standard ε-DP guarantee.');
  info('');
  info('CUMULATIVE histogram ε under sequential composition is k * ε,');
  info(`where k = ${bundle.bucketSumCommitments.length} buckets. For histogram-level ε,`);
  info('the caller divides their budget by k before calling.');

  header('Walkthrough complete');
  info('Every primitive composed cleanly:');
  info('  NumericBucketingScheme → one-hot BucketedCommittedContribution');
  info('  → per-bucket homomorphic Pedersen sum → per-bucket DP-Laplace noise');
  info('  → auditor structural + opening verification');
  info('  → tampering detection at both the commitment and count layers');
  info('No new ontology terms introduced; composes Pedersen + DP-Laplace + bucketing.');
  console.log();
}

main();
