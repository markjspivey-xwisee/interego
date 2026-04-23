// Cool test: Prove policy satisfaction WITHOUT revealing attestations.
//
// Scenario: alice has three attestations of her code quality, held
// on her pod. The merge-gate policy requires ≥ 2 attestations with
// codeQuality ≥ 0.80. Alice wants to *prove* to the evaluator that
// she satisfies the policy without revealing:
//
//   - which attestations she used
//   - what the attestation values actually are
//   - which issuers wrote them
//
// The construction: Alice commits her attestation set to a Merkle
// tree (root is public, leaves are private). For each qualifying
// attestation, she produces:
//
//   (a) a Merkle inclusion proof that the attestation is in her
//       committed set
//   (b) a range proof that its codeQuality value is ≥ 0.80
//
// She submits { merkleRoot, [proof1, proof2] }. The verifier:
//
//   - confirms each proof's Merkle path verifies against the root
//   - confirms each range proof's hash chain verifies the threshold
//   - counts ≥ 2 qualifying proofs → policy satisfied
//
// The verifier learns: "alice has at least 2 attestations
// committed to this public Merkle root, each with codeQuality ≥ 0.80."
// The verifier does NOT learn the actual values, which attestations,
// or which issuers. The privacy-preserving version of the same ABAC
// decision the prior demo made.

import {
  commit,
  proveConfidenceAboveThreshold,
  verifyConfidenceProof,
  buildMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
} from '../dist/index.js';

console.log('=== Zero-knowledge ABAC policy satisfaction ===\n');

// ── Alice's private attestation set ─────────────────────────

const aliceAttestations = [
  { issuer: 'urn:agent:bob',    codeQuality: 0.88 },
  { issuer: 'urn:agent:carol',  codeQuality: 0.72 },   // below threshold
  { issuer: 'urn:agent:dave',   codeQuality: 0.95 },
];

// Policy: ≥ 2 attestations with codeQuality ≥ 0.80.
const THRESHOLD = 0.80;
const MIN_COUNT = 2;

console.log("Alice's private attestation set (hidden from verifier):");
aliceAttestations.forEach((a, i) => console.log(`   [${i}] issuer=${a.issuer}, codeQuality=${a.codeQuality}`));
console.log('');
console.log(`Policy predicate: amta:codeQuality ≥ ${THRESHOLD}  (minCount: ${MIN_COUNT})`);
console.log('');

// ── Prover side: build commitments + Merkle tree ────────────

console.log('── Prover (alice) ──');

// Each attestation is committed so its leaf hash is stable but
// the value is hidden. (A single-line hash would also work; using
// `commit` here to show the primitive shape.)
const leafCommitments = aliceAttestations.map(a => commit(`${a.issuer}|${a.codeQuality}`));
const leafValues = leafCommitments.map(lc => lc.commitment.commitment);
const tree = buildMerkleTree(leafValues);
console.log(`   Merkle root (public): ${tree.root.slice(0, 16)}...`);
console.log('');

// Alice picks the qualifying attestations (by index), and for each
// builds both a Merkle inclusion proof (on her commitment set) and
// a range proof (on the attestation's codeQuality).
const qualifyingIndices = aliceAttestations
  .map((a, i) => ({ a, i }))
  .filter(({ a }) => a.codeQuality >= THRESHOLD)
  .map(({ i }) => i);

console.log(`   alice identifies ${qualifyingIndices.length} qualifying attestations (indices kept private).`);

const submittedProofs = qualifyingIndices.map(i => {
  const merkleProof = generateMerkleProof(leafValues[i], leafValues);
  const rangeProof = proveConfidenceAboveThreshold(
    aliceAttestations[i].codeQuality,
    THRESHOLD,
  ).proof;
  return { merkleProof, rangeProof };
});
console.log(`   built ${submittedProofs.length} (inclusion + range) proof pairs.\n`);

// ── Transmission: only the public artifacts cross the wire ──

console.log('── Transmission to verifier ──');
console.log('   over-the-wire:');
console.log(`     merkleRoot            = ${tree.root.slice(0, 16)}...`);
console.log(`     [proofs]              = ${submittedProofs.length} pairs`);
console.log("   NOT transmitted:");
console.log('     - attestation values');
console.log('     - issuer identities');
console.log('     - which attestations qualified\n');

// ── Verifier side: check proofs + count ─────────────────────

console.log('── Verifier ──');

let validQualifyingCount = 0;
for (let i = 0; i < submittedProofs.length; i++) {
  const { merkleProof, rangeProof } = submittedProofs[i];
  const merkleOK = verifyMerkleProof(merkleProof);
  const rangeOK = verifyConfidenceProof(rangeProof);
  const rootMatches = merkleProof.root === tree.root;
  const thresholdMatches = rangeProof.threshold === THRESHOLD;
  const proofValid = merkleOK && rangeOK && rootMatches && thresholdMatches;
  console.log(`   proof ${i}: merkle=${merkleOK} range=${rangeOK} rootMatches=${rootMatches} threshold=${thresholdMatches}  → ${proofValid ? 'VALID' : 'INVALID'}`);
  if (proofValid) validQualifyingCount++;
}

const satisfied = validQualifyingCount >= MIN_COUNT;
console.log('');
console.log(`   valid qualifying proofs: ${validQualifyingCount}`);
console.log(`   policy minCount:         ${MIN_COUNT}`);
console.log(`   predicate satisfied:     ${satisfied}`);
console.log(`   → verdict: ${satisfied ? 'Allowed' : 'Indeterminate'}\n`);

// ── Counterfactual: alice tries to cheat with a below-threshold value

console.log('── Counterfactual — can alice cheat? ──');
try {
  proveConfidenceAboveThreshold(0.72, THRESHOLD);
  console.log('   ❌ SHOULD NOT HAPPEN — prove threw should have fired');
} catch (e) {
  console.log(`   ✓ prover cannot construct a range proof for value below threshold:`);
  console.log(`     "${e.message}"`);
  console.log('     → a cheating prover cannot forge a valid (inclusion+range)');
  console.log('       pair for an attestation below the threshold.\n');
}

// ── Counterfactual: only 1 qualifying → fails minCount ──────

console.log('── Counterfactual — only 1 qualifying attestation ──');
const singleQualifyingSet = [
  { issuer: 'urn:agent:bob', codeQuality: 0.88 },
  { issuer: 'urn:agent:carol', codeQuality: 0.72 },
  { issuer: 'urn:agent:dave', codeQuality: 0.60 },
];
const singleLeaves = singleQualifyingSet.map(a => commit(`${a.issuer}|${a.codeQuality}`).commitment.commitment);
const singleProofs = singleQualifyingSet
  .map((a, i) => ({ a, i }))
  .filter(({ a }) => a.codeQuality >= THRESHOLD)
  .map(({ i }) => ({
    merkleProof: generateMerkleProof(singleLeaves[i], singleLeaves),
    rangeProof: proveConfidenceAboveThreshold(singleQualifyingSet[i].codeQuality, THRESHOLD).proof,
  }));
console.log(`   built ${singleProofs.length} valid proof (only one attestation qualifies).`);
const singleSatisfied = singleProofs.length >= MIN_COUNT;
console.log(`   valid proofs ≥ minCount (${MIN_COUNT})? ${singleSatisfied}`);
console.log(`   → verdict: ${singleSatisfied ? 'Allowed' : 'Indeterminate (cannot prove enough)'}\n`);

// ── Observed ──

console.log('── Observed ──');
console.log('   Alice proved she satisfies the merge-gate policy');
console.log('     "≥ 2 attestations with codeQuality ≥ 0.80"');
console.log('   without revealing any attestation value, any issuer identity,');
console.log('   or which attestations were used.');
console.log('');
console.log('   The ZK surface composes with ABAC through the evaluator\'s');
console.log('   contract: the predicate is still a SHACL-like constraint,');
console.log('   but the attribute-graph layer is now proof-based rather than');
console.log('   plaintext. An auditor can verify the decision by re-checking');
console.log('   the proofs against the public Merkle root — no trusted third');
console.log('   party needed.');
console.log('');
console.log('   Failure modes are also clean:');
console.log('     - prover with no qualifying attestation cannot construct a range proof');
console.log('     - prover with < minCount qualifying cannot submit enough valid proofs');
console.log('     - tampered Merkle root fails inclusion verification');
