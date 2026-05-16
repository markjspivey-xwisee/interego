#!/usr/bin/env node
/**
 * Walkthrough: v4-partial + Feldman VSS + committee-reconstruction
 * chain-of-custody attestation.
 *
 * Single-process narrative that exercises the full v4-partial
 * aggregate-privacy ladder end-to-end. Prints each step so a reader
 * can clone the repo, run `npx tsx tools/walkthrough-v4-partial-vss.ts`,
 * and see exactly what the substrate does when you opt into threshold
 * reveal.
 *
 * What the script demonstrates, in order:
 *
 *   1. Three contributors build CommittedContributions (Pedersen
 *      commitments to their private values + bounds + blindings).
 *   2. The operator runs `buildAttestedHomomorphicSum` with
 *      `thresholdReveal: {n: 5, t: 3}`. The returned bundle has:
 *        - `noisySum` (the publishable DP-protected aggregate)
 *        - `coefficientCommitments` (Feldman VSS — public proof of
 *          the polynomial)
 *        - `thresholdShares` (5 verifiable Shamir shares; trueBlinding
 *          is OMITTED from audit fields)
 *   3. The 5 shares are distributed to 5 "pseudo-aggregators"
 *      (simulated as 5 wallets in this process).
 *   4. A committee of 3 (the threshold t) reconstructs the trueBlinding
 *      via `reconstructThresholdRevealAndVerify`. The verifier filters
 *      shares against the VSS commitments BEFORE Lagrange; a tampered
 *      share would be caught here.
 *   5. Each committee member signs a CommitteeReconstructionAttestation;
 *      the coordinator bundles the signatures.
 *   6. `verifyCommitteeReconstruction` confirms the attestation is
 *      well-formed + every signature recovers correctly.
 *   7. A tampering simulation: corrupt one share, retry reconstruction.
 *      The VSS verifier rejects the bad share BEFORE it can poison
 *      Lagrange interpolation; the remaining 4 verified shares still
 *      meet the threshold, so reconstruction succeeds.
 *
 * No network calls; no pod required. Pure protocol-layer demonstration.
 * The publishable variants (publishCommitteeReconstructionAttestation,
 * publishAttestedHomomorphicSum) are exercised in the test suite with
 * a mock fetch; running them here would need a live pod.
 */

/* eslint-disable no-console */

import {
  buildCommittedContribution,
  buildAttestedHomomorphicSum,
  reconstructThresholdRevealAndVerify,
  signCommitteeReconstruction,
  verifyCommitteeReconstruction,
  signCommitteeAuthorization,
  verifyCommitteeAuthorization,
  verifyCommitteeMatchesAuthorization,
  encryptSharesForCommittee,
  decryptShareForRecipient,
  type CommitteeReconstructionAttestation,
} from '../applications/_shared/aggregate-privacy/index.js';
import { createWallet } from '../src/index.js';
import { generateKeyPair } from '../src/crypto/encryption.js';
import type { IRI } from '../src/index.js';
import type { Wallet } from 'ethers';

const COHORT = 'urn:demo:cohort:v4-walkthrough' as IRI;
const AGGREGATOR = 'did:web:operator.demo' as IRI;
const L = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;

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

async function main(): Promise<void> {
  header('v4-partial + Feldman VSS + committee attestation — walkthrough');
  info(`Cohort: ${COHORT}`);
  info(`Operator: ${AGGREGATOR}`);
  info(`Threshold reveal config: n=5, t=3`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 1 — Contributors build their Pedersen commitments.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 1 — Three contributors commit to private values');
  const bounds = { min: 0n, max: 100n };
  const contribs = [
    buildCommittedContribution({ contributorPodUrl: 'https://alice/', value: 25n, bounds, blindingSeed: 'alice', blindingLabel: 'demo' }),
    buildCommittedContribution({ contributorPodUrl: 'https://bob/',   value: 40n, bounds, blindingSeed: 'bob',   blindingLabel: 'demo' }),
    buildCommittedContribution({ contributorPodUrl: 'https://carol/', value: 35n, bounds, blindingSeed: 'carol', blindingLabel: 'demo' }),
  ];
  for (const c of contribs) {
    ok(`${c.contributorPodUrl} committed to value ${c.value} (Pedersen commit ${c.commitment.bytes.slice(0, 16)}…)`);
  }
  info(`True sum (private — operator never publishes this): ${contribs.reduce((a, c) => a + c.value, 0n)}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 2 — Operator builds the bundle with thresholdReveal.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 2 — Operator runs buildAttestedHomomorphicSum with thresholdReveal');
  const bundle = buildAttestedHomomorphicSum({
    cohortIri: COHORT,
    aggregatorDid: AGGREGATOR,
    contributions: contribs,
    epsilon: 1.0,
    includeAuditFields: true,
    thresholdReveal: { n: 5, t: 3 },
  });
  step(1, 'Pedersen sum-commitment computed homomorphically');
  ok(`sumCommitment.bytes = ${bundle.sumCommitment.bytes.slice(0, 32)}…`);
  step(2, 'DP-Laplace noise added to true sum');
  ok(`noisySum (publishable) = ${bundle.noisySum} (true sum was ${bundle.trueSum}, noise = ${bundle.noise})`);
  step(3, 'trueBlinding Shamir-split into 5 verifiable shares');
  ok(`thresholdShares.length = ${bundle.thresholdShares!.length}`);
  ok(`trueBlinding in bundle? ${bundle.trueBlinding === undefined ? 'NO (omitted, as required)' : 'YES (BUG)'}`);
  step(4, 'Feldman VSS commitments emitted alongside shares');
  ok(`coefficientCommitments.points.length = ${bundle.coefficientCommitments!.points.length} (one per polynomial coefficient = t)`);
  ok(`coefficientCommitments.threshold = ${bundle.coefficientCommitments!.threshold}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 3 — Distribute encrypted shares to pseudo-aggregator wallets.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 3 — Encrypt + distribute 5 shares to 5 pseudo-aggregators');
  const wallets: Wallet[] = [];
  const dids: IRI[] = [];
  const encKeyPairs = [];
  for (let i = 0; i < 5; i++) {
    const w = await createWallet('agent', `pseudo-aggregator-${i}`);
    wallets.push(w as unknown as Wallet);
    dids.push(`did:ethr:${w.address.toLowerCase()}` as IRI);
    encKeyPairs.push(generateKeyPair());
    ok(`Member ${i}: ${dids[i]!.slice(0, 32)}… (X25519 pub ${encKeyPairs[i]!.publicKey.slice(0, 16)}…)`);
  }

  step(1, 'Operator signs CommitteeAuthorization BEFORE distributing shares (pre-reveal binding)');
  const operatorWallet = await createWallet('agent', 'walkthrough-operator');
  const operatorDid = `did:ethr:${operatorWallet.address.toLowerCase()}` as IRI;
  const authorization = await signCommitteeAuthorization({
    bundleSumCommitment: bundle.sumCommitment.bytes,
    authorizedDids: dids,
    threshold: { n: 5, t: 3 },
    operatorDid,
    operatorWallet: operatorWallet as unknown as Wallet,
  });
  const authCheck = verifyCommitteeAuthorization({ authorization });
  ok(`Operator ${operatorDid.slice(0, 32)}… signed authorization (verifies: ${authCheck.valid})`);
  ok(`Authorized committee: 5 DIDs, threshold (n=5, t=3)`);
  ok(`The regulator will cross-check the actual reveal committee against this authorization.`);

  step(2, 'Operator encrypts each share for its recipient via X25519/nacl envelopes');
  const senderKeyPair = generateKeyPair();
  const distributions = encryptSharesForCommittee({
    shares: bundle.thresholdShares!,
    recipients: dids.map((did, i) => ({ recipientDid: did, recipientPublicKey: encKeyPairs[i]!.publicKey })),
    senderKeyPair,
  });
  ok(`${distributions.length} encrypted share envelopes produced (one per recipient)`);

  step(3, 'Each pseudo-aggregator decrypts their own share (and ONLY their own)');
  const decryptedShares = distributions.map((dist, i) => {
    const share = decryptShareForRecipient({ distribution: dist, recipientKeyPair: encKeyPairs[i]! });
    if (share === null) throw new Error(`Member ${i} failed to decrypt their share`);
    return share;
  });
  for (let i = 0; i < decryptedShares.length; i++) {
    ok(`Member ${i} decrypted share x=${decryptedShares[i]!.x} (y bigint preserved)`);
  }

  step(4, 'Cross-decrypt attempt: member 0 tries to read member 1\'s envelope');
  const crossAttempt = decryptShareForRecipient({ distribution: distributions[1]!, recipientKeyPair: encKeyPairs[0]! });
  ok(`Cross-decrypt rejected: ${crossAttempt === null ? 'YES (no wrapped key for member 0)' : 'NO (BUG)'}`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 4 — A committee of 3 reconstructs trueBlinding.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 4 — Committee of 3 reconstructs trueBlinding from DECRYPTED shares');
  const committeeIdx = [0, 2, 4];
  const committeeShares = committeeIdx.map(i => decryptedShares[i]!);
  const committeeDids = committeeIdx.map(i => dids[i]!);
  const committeeWallets = committeeIdx.map(i => wallets[i]!);
  ok(`Committee members: ${committeeIdx.map(i => `#${i}`).join(', ')} (any t=3 of n=5)`);

  const reconstruction = reconstructThresholdRevealAndVerify({
    bundle,
    shares: committeeShares,
    claimedTrueSum: bundle.trueSum!,
  });
  if (!reconstruction.valid) {
    console.error(`      ✗ Reconstruction failed: ${reconstruction.reason}`);
    process.exit(1);
  }
  ok(`Reconstruction valid: ${reconstruction.verifiedShareCount} shares verified, ${reconstruction.rejectedShareCount} rejected`);
  ok(`reconstructedTrueBlinding (private) = ${String(reconstruction.reconstructedTrueBlinding).slice(0, 32)}…`);

  // ────────────────────────────────────────────────────────────────
  // PHASE 5 — Each committee member signs the chain-of-custody record.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 5 — Committee signs the chain-of-custody attestation');
  const reconstructedAt = new Date().toISOString();
  const signatures = await Promise.all(committeeDids.map((did, i) =>
    signCommitteeReconstruction({
      bundleSumCommitment: bundle.sumCommitment.bytes,
      claimedTrueSum: bundle.trueSum!,
      committeeDids,
      reconstructedAt,
      signerWallet: committeeWallets[i]!,
      signerDid: did,
    }),
  ));
  for (const sig of signatures) {
    ok(`${sig.memberDid.slice(0, 32)}… signed (sig ${sig.signature.slice(0, 16)}…)`);
  }

  const attestation: CommitteeReconstructionAttestation = {
    bundleSumCommitment: bundle.sumCommitment.bytes,
    claimedTrueSum: bundle.trueSum!,
    committeeDids,
    reconstructedAt,
    signatures,
  };

  // ────────────────────────────────────────────────────────────────
  // PHASE 6 — Auditor verifies the attestation.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 6 — Auditor verifies the chain-of-custody attestation');
  const auditResult = verifyCommitteeReconstruction({ attestation });
  if (!auditResult.valid) {
    console.error(`      ✗ Audit verification failed: ${auditResult.reason}`);
    process.exit(1);
  }
  ok('Every signature recovers an address inside its claimed memberDid');
  ok(`Recovered addresses: ${auditResult.recoveredAddresses!.length}`);
  ok('No committee member silently dropped; no outsider signature');

  step(1, 'Cross-check: actual reveal committee MATCHES the operator\'s earlier authorization');
  const cross = verifyCommitteeMatchesAuthorization({ authorization, attestation });
  ok(`Cross-check valid: ${cross.valid} (every reveal-committee member appears in the authorized list; bundleSumCommitment matches)`);
  info('In a real deployment, the operator would now call:');
  info('  publishCommitteeAuthorization({ authorization, podUrl })   // BEFORE distributing shares');
  info('  publishCommitteeReconstructionAttestation({ attestation, podUrl })   // AFTER reveal');
  info('and the auditor would fetch both back via:');
  info('  fetchPublishedCommitteeAuthorization({ graphUrl })');
  info('  fetchPublishedCommitteeReconstructionAttestation({ graphUrl })');

  // ────────────────────────────────────────────────────────────────
  // PHASE 7 — Tampering simulation: VSS catches a corrupted share.
  // ────────────────────────────────────────────────────────────────
  header('PHASE 7 — Tampering simulation: VSS catches a corrupted share');
  const tampered = { ...bundle.thresholdShares![1]!, y: (bundle.thresholdShares![1]!.y + 1n) % L };
  info('Adversary flips one share\'s y by 1. Submit 4 shares (3 honest + 1 tampered) to reconstruction.');
  const mixed = [bundle.thresholdShares![0]!, tampered, bundle.thresholdShares![2]!, bundle.thresholdShares![3]!];
  const tampering = reconstructThresholdRevealAndVerify({
    bundle,
    shares: mixed,
    claimedTrueSum: bundle.trueSum!,
  });
  if (!tampering.valid) {
    console.error(`      ✗ Unexpected failure (should have recovered from 3 honest): ${tampering.reason}`);
    process.exit(1);
  }
  ok(`Tampered share REJECTED by VSS before Lagrange: ${tampering.verifiedShareCount} verified, ${tampering.rejectedShareCount} rejected`);
  ok('Reconstruction still succeeded from the 3 verified shares — threshold met.');
  info('Without VSS, the tampered share would silently poison Lagrange interpolation.');
  info('The sum-commitment verification would catch the poisoning AFTER reconstruction,');
  info('but only because the sum-commitment is also publicly checkable. VSS is the up-front guard.');

  header('Walkthrough complete');
  info('Every primitive composed cleanly:');
  info('  Pedersen commit → homomorphic sum → DP noise → Shamir split');
  info('  → Feldman VSS commitments → operator-signed committee authorization');
  info('  → X25519/nacl share encryption → per-recipient decryption');
  info('  → committee reconstruction → chain-of-custody attestation');
  info('  → cross-check vs authorization → auditor verification');
  info('No new ontology terms introduced; all building blocks pre-existed in src/crypto/.');
  console.log();
}

main().catch(err => {
  console.error('Walkthrough failed:', err);
  process.exit(1);
});
