# Choosing an aggregate-privacy mode

The Interego aggregate-privacy ladder ships twelve layered modes. Each
composes the previous; none replaces it. This page is the adopter's
field guide — which mode to pick for which threat model, and how to
upgrade in place when the threat model shifts.

The implementations all live in
[`applications/_shared/aggregate-privacy/`](../applications/_shared/aggregate-privacy/index.ts)
+ [`src/crypto/pedersen.ts`](../src/crypto/pedersen.ts) +
[`src/crypto/shamir.ts`](../src/crypto/shamir.ts) +
[`src/crypto/feldman-vss.ts`](../src/crypto/feldman-vss.ts); contract
tests pin every cheat path in
[`applications/_shared/tests/aggregate-privacy.test.ts`](../applications/_shared/tests/aggregate-privacy.test.ts)
(106 tests, all green).

Want to see the full v4-partial flow without standing up a pod?
Run `npx tsx tools/walkthrough-v4-partial-vss.ts` — an 8-phase
narrative from contributor commit → operator-signed committee
authorization → encrypted distribution → committee reconstruction
→ chain-of-custody → cross-check vs authorization → tampering
simulation. Regression-protected via
[`tests/walkthrough-v4-partial-vss.test.ts`](../tests/walkthrough-v4-partial-vss.test.ts).

## Which mode to pick

| Your threat model | Pick this mode |
|---|---|
| Trusted operator + cohort participants — you just want a count of decisions / completions / credentials | **v1 `abac`** (default) |
| Operator wants a tamper-evident count an auditor can re-verify; contributors must explicitly opt in | **v2 `merkle-attested-opt-in`** |
| Operator must compute a SUM (or count, or threshold) over private contributor values WITHOUT learning the individual values | **v3 `zk-aggregate`** |
| Operator must compute a HISTOGRAM / DISTRIBUTION over private contributor values (bucketed counts) | **v3 `zk-distribution`** |
| Plus: the operator is also under regulator audit and cannot be trusted to attribute commitments correctly | **v3 + `require_signed_bounds: true`** |
| Plus: cumulative ε-discipline matters (many queries against the same cohort) | **v3 + `epsilon_budget_max: <ε>`** |
| Plus: the audit log itself must be tamper-evident, not just honest accounting | **v3 + `signBudgetAuditLog`** (in-process API) |
| Operator wants no single party (including the auditor) to hold the trueBlinding — distribute across a k-of-n committee | **v4-partial `thresholdReveal: {n, t}`** (trusted-dealer; DKG still future) |
| Plus: detect tampered shares BEFORE Lagrange reconstruction silently poisons the result | **v4-partial+VSS** (automatic when thresholdReveal is requested — bundle ships coefficientCommitments) |
| Plus: tamper-evident chain-of-custody record of WHO actually reconstructed the blinding (regulator wants to see the committee) | **`signCommitteeReconstruction` + `publishCommitteeReconstructionAttestation`** (in-process API) |
| Plus: distribute encrypted shares to pseudo-aggregators via standard pod-discovery flows (not out-of-band) | **`encryptSharesForCommittee` + `publishEncryptedShareDistribution`** (in-process API) |
| Plus: operator signs a pre-reveal commitment to the authorized committee, regulator cross-checks at audit time (catches sock-puppet committees) | **`signCommitteeAuthorization` + `publishCommitteeAuthorization` + `verifyCommitteeMatchesAuthorization`** (in-process API) |
| Full multi-aggregator threshold reveal with no trusted dealer (k-of-n DKG) | **v4 — not yet shipped, multi-week distributed-crypto work** |

## The ladder

| Mode | What it gives | What stops cheating | What it does NOT cover |
|---|---|---|---|
| **v1 `abac`** | Count derived from descriptors the operator's ABAC scope permits reading. Default. | The pod's standard ABAC — descriptors outside scope simply don't appear in the count. | No tamper-evidence; no opt-in primitive; no DP noise; the operator could lie about the count. |
| **v2 `merkle-attested-opt-in`** | Verifiable count of explicitly opted-in participants. Each result includes a Merkle root over the participation descriptor IRIs + per-leaf inclusion proofs so any auditor can verify the count without seeing which participants are in it. | (a) Contributor opt-in is required — institution cannot include a non-consenting contributor. (b) `verifyAttestedAggregateResult` rejects: count inflation, count deflation, inclusion-proof root substitution, leaf tampering. | Doesn't compute sums or distributions, only counts. The individual values are still cleartext on the contributor's pod (just not in the aggregate). |
| **v3 `zk-aggregate`** | Homomorphic Pedersen sum + DP-Laplace noise calibrated to a public ε budget. Operator sums commitments WITHOUT seeing individual values; published sum is `trueSum + Laplace(sensitivity / ε)`. Re-verifiable: sum-commitment equals the homomorphic sum of contributor commitments. | `verifyAttestedHomomorphicSum` rejects: aggregator substituting sumCommitment from a different cohort, lying about reconstructed trueSum, inflating noisySum past consistency with claimed noise. The DP noise itself isn't re-verifiable (random by design); auditors check structural integrity + the ε claim. | (a) Malicious contributor lying about their value is caught only by the aggregator's bounds re-check — see v3.1. (b) Cumulative ε leakage across queries — see v3.2. (c) Single-aggregator trust — see v4. |
| **v3 `zk-distribution`** | Per-bucket homomorphic Pedersen sums + per-bucket DP-Laplace noise. Contributors one-hot encode into a `NumericBucketingScheme` (edges + maxValue); aggregator returns a histogram of `noisyBucketCounts` plus per-bucket sum commitments. Per-bucket sensitivity = 1 (one-hot bounds shift per bucket to ≤1); cumulative histogram ε under sequential composition is `k * ε`. | `verifyAttestedHomomorphicDistribution` rejects: per-bucket sumCommitment substitution; tampered per-bucket counts; scheme mismatch between bundle + contributions; contributor-count mismatch. Each bucket is structurally verified independently. | Same caveats as v3 for individual-bucket privacy: bounds re-check is automatic via one-hot encoding (0 or 1 only); cumulative budget tracking via the same EpsilonBudget; single-aggregator trust model. Histogram-level ε requires the caller to divide their budget by k buckets before calling. |
| **v3.1 `+ requireSignedBounds: true`** | Each contribution carries an ECDSA signature over `signedBoundsMessage(commitment, bounds, contributorDid)`. Aggregator refuses contributions without a valid signature. | Catches: aggregator inflating a contributor's bounds (sensitivity invariant); impersonation (aggregator attributing a commitment to a different contributor); replay across cohorts (each signature is bound to a specific cohort + commitment). | Doesn't catch a contributor that signs their OWN bounds wider than they should — they're free to declare `[0, 1000000]` if they want. Mitigation: institutional policy descriptor on the operator's pod that caps the declared bounds. |
| **v3.2 `+ epsilonBudget`** | `EpsilonBudget` tracker per cohort; declares max ε; `consume()` per query; throws when cumulative consumption would exceed the cap. `buildAttestedHomomorphicSum` accepts the tracker and pre-flight aborts if the request would push over. `toJSON()` / `fromJSON()` for persistence. | Catches: caller running 1000 small-ε queries that effectively reveal everything; budget overrun in the current session (it throws BEFORE producing the bundle). | Honest accounting, not tamper-evident — a malicious caller bypassing the tracker still leaks DP info. Mitigation: v3.3 wraps the log in a signed artifact. |
| **v3.3 `signBudgetAuditLog`** | Wraps `EpsilonBudget.toJSON()` in a SignedBudgetAuditLog whose signature recovers the operator's DID. `verifyBudgetAuditLog` confirms: signature is valid, log entries sum to spent, spent ≤ maxEpsilon. | Catches: tampering with snapshot.spent after signing; silently dropping log entries; impersonated signer; internal consistency violations. The audit log itself is now a verifiable artifact. | A malicious operator that NEVER signs the log at all isn't caught by the verifier; that's an institutional-policy enforcement problem (the institution publishes a policy saying "all aggregate queries MUST publish a signed budget log" and binds operators to it via the existing `passport:` machinery). |
| **v4-partial `thresholdReveal: {n, t}`** | Splits the trueBlinding into n Shamir shares (over the ristretto255 scalar field L) requiring any t to reconstruct. The bundle's `trueBlinding` audit field is OMITTED — no single party including the auditor knows it. `reconstructThresholdRevealAndVerify` takes any t shares + the claimed trueSum and verifies via Pedersen. | Distributes trust over a k-of-n committee: no single committee member can recover trueBlinding alone. Catches: insufficient shares; wrong claimedTrueSum; non-threshold-mode bundle. | Trusted-dealer caveat: the operator running `buildAttestedHomomorphicSum` still knows the polynomial coefficients during the split. Full multi-aggregator DKG (the remaining v4 piece) needs a multi-round protocol that no single party can short-circuit — not yet shipped. |
| **v4-partial+VSS** (automatic) | Same as v4-partial but `buildAttestedHomomorphicSum`'s thresholdReveal path now uses Feldman Verifiable Secret Sharing under the hood. The bundle emits `coefficientCommitments: FeldmanCommitments` (one EC-point per polynomial coefficient). `reconstructThresholdRevealAndVerify` filters shares via `filterVerifiedShares` BEFORE Lagrange. | Catches: a single tampered share BEFORE it silently poisons the Lagrange interpolation. Returns `verifiedShareCount` + `rejectedShareCount` so the caller sees exactly what was rejected. Composition is automatic — opting into thresholdReveal automatically enables VSS. | Doesn't itself remove the trusted-dealer caveat; just makes the share-distribution phase cheat-resistant. Backward-compatible: bundles without `coefficientCommitments` (legacy / stripped) fall through to the unguarded path. |
| **Committee reconstruction attestation** (`signCommitteeReconstruction` + `verifyCommitteeReconstruction`) | When a t-of-n committee successfully reconstructs trueBlinding, each member signs the canonical `committeeReconstructionMessage(bundleSumCommitment, claimedTrueSum, committeeDids, reconstructedAt)`. The coordinator bundles signatures into a `CommitteeReconstructionAttestation`; `publishCommitteeReconstructionAttestation` writes it as a pod descriptor. | Catches: forged committee membership; substituted bundle; tampered claimedTrueSum; impersonated member; silently-dropped member. Regulator can fetch the attestation from the pod and see exactly who participated, when, and on which bundle. | A malicious operator that NEVER signs the committee attestation isn't caught by the verifier — same enforcement story as v3.3 (institutional policy + `passport:` machinery). |
| **Encrypted share distribution** (`encryptSharesForCommittee` + `publishEncryptedShareDistribution`) | Each VerifiableShamirShare is wrapped in an X25519/nacl envelope keyed to its intended pseudo-aggregator recipient. The operator publishes each envelope as a normal `cg:ContextDescriptor`; the recipient discovers it via standard pod-discovery flows and decrypts with their own X25519 keypair. | Catches: share leaking to the wrong recipient; share substitution in transit; replay across recipients. Composes the substrate's existing X25519 / nacl envelope machinery — no new ontology terms. Bigint y survives the JSON-in-envelope round-trip via the same `__bigint` wrapper used by the publishable bundle JSON encoder. | Doesn't prevent the operator from publishing the SAME share to multiple recipients (which would defeat threshold privacy) — that's a per-share auditing problem the recipient discovers when they see another envelope at the same content-addressed slot. |
| **Operator-signed committee authorization** (`signCommitteeAuthorization` + `publishCommitteeAuthorization` + `verifyCommitteeMatchesAuthorization`) | The operator signs a `CommitteeAuthorization` BEFORE distributing shares, naming the n authorized DIDs + the (n, t) threshold. The authorization is published as a pod descriptor; at audit time the regulator cross-checks the actual reveal committee (from the chain-of-custody attestation) against this earlier authorization via `verifyCommitteeMatchesAuthorization`. | Catches: operator forms a sock-puppet committee at reveal time; operator silently changes the threshold; reveal-time committee membership doesn't match the operator's prior commitment; bundleSumCommitment swapped between authorization and reveal. Closes the "operator improvises a committee" cheat that the reveal-side chain-of-custody attestation alone could not catch. | Doesn't prevent the operator from never publishing an authorization at all — that's the same institutional-policy enforcement story as v3.3 (institution publishes a policy saying "all threshold reveals MUST be preceded by a published authorization" + binds operators via `passport:`). |
| **Distribution-vs-authorization cross-check** (`verifyShareDistributionsMatchAuthorization`) | Confirms the actual share distributions match the authorization at the SHARE-SHIPPING phase, not just the reveal phase. Catches: operator authorizes 5 DIDs but ships shares to 3 sock-puppets; operator ships more/fewer shares than authorized; duplicate distribution to the same recipient; authorized DID with no matching distribution. | Composes the existing `CommitteeAuthorization` + `EncryptedShareDistribution` machinery — no new primitives required. The regulator now has full audit coverage across the entire reveal lifecycle: pre-reveal authorization → distribution → reveal → cross-check. | Doesn't address the scenario where the operator never publishes the distributions at all — same institutional-policy enforcement story as the other "publish or be flagged" controls. |

## Upgrading in place

Every mode is a layered enhancement on the same affordance signature.
Upgrading a deployment from v1 → v3.3 doesn't break existing callers:

```ts
// v1 (default)
await aggregateCohortQuery({ cohort_iri, metric: 'completion-count' }, ctx);

// v2 (add opt-in attestation)
await aggregateCohortQuery({
  cohort_iri, metric: 'completion-count',
  privacy_mode: 'merkle-attested-opt-in',
  learner_pods: [/* candidate set */],
}, ctx);

// v3 (homomorphic sum + DP noise)
await aggregateCohortQuery({
  cohort_iri, metric: 'completion-count',
  privacy_mode: 'zk-aggregate',
  epsilon: 1.0,
  learner_pods: [/* candidate set */],
}, ctx);

// v3 distribution (homomorphic histogram + DP noise)
await aggregateCohortQuery({
  cohort_iri, metric: 'score-distribution',
  privacy_mode: 'zk-distribution',
  epsilon: 1.0,                    // per-bucket ε; histogram-level ε = k * epsilon
  distribution_edges: ['0', '25', '50', '75'],  // bigints as decimal strings
  distribution_max_value: '100',
  learner_pods: [/* candidate set */],
}, ctx);

// v3.1 + v3.2 (regulator-grade attribution + ε-budget)
await aggregateCohortQuery({
  cohort_iri, metric: 'completion-count',
  privacy_mode: 'zk-aggregate',
  epsilon: 0.5,
  require_signed_bounds: true,
  epsilon_budget_max: 5.0,
  learner_pods: [/* candidate set */],
}, ctx);

// v3.3 (sign the audit log after running queries)
// In-process API only (not a per-call affordance arg).
import { EpsilonBudget, signBudgetAuditLog } from '@interego/core/applications/_shared/aggregate-privacy';
const budget = new EpsilonBudget({ cohortIri, maxEpsilon: 5.0 });
// ... pass `budget` into multiple aggregate calls via the in-process API ...
const signed = await signBudgetAuditLog({ budget, signerWallet, signerDid });
// Publish `signed` as a normal Context Descriptor on the operator's pod via publish().

// v4-partial (threshold reveal — k-of-n committee holds the blinding)
await aggregateCohortQuery({
  cohort_iri, metric: 'completion-count',
  privacy_mode: 'zk-aggregate',
  epsilon: 0.5,
  threshold_reveal_n: 5,
  threshold_reveal_t: 3,
  learner_pods: [/* candidate set */],
}, ctx);
// The bundle ships `thresholdShares` (already VSS-verified via
// `coefficientCommitments`); distribute shares to 5 pseudo-aggregators.

// Committee reconstruction + chain-of-custody attestation
// In-process API (composes the existing wallet primitives).
import {
  reconstructThresholdRevealAndVerify,
  signCommitteeReconstruction,
  publishCommitteeReconstructionAttestation,
} from '@interego/core/applications/_shared/aggregate-privacy';

// Each pseudo-aggregator signs:
const sig = await signCommitteeReconstruction({
  bundleSumCommitment: bundle.sumCommitment.bytes,
  claimedTrueSum,
  committeeDids: [/* the t DIDs */],
  reconstructedAt: new Date().toISOString(),
  signerWallet, signerDid,
});

// Coordinator bundles + publishes:
await publishCommitteeReconstructionAttestation({
  attestation: { ..., signatures: [/* t signatures */] },
  podUrl: 'https://operator.example/pod/',
});

// Encrypted share distribution (pod-discovery flow)
// In-process API (composes X25519/nacl envelope primitives).
import {
  encryptSharesForCommittee,
  publishEncryptedShareDistribution,
  fetchPublishedEncryptedShareDistribution,
  decryptShareForRecipient,
} from '@interego/core/applications/_shared/aggregate-privacy';

// Operator side:
const distributions = encryptSharesForCommittee({
  shares: bundle.thresholdShares,
  recipients: pseudoAggregatorDids.map((did, i) => ({
    recipientDid: did,
    recipientPublicKey: pseudoAggregatorX25519PublicKeys[i],
  })),
  senderKeyPair: operatorX25519KeyPair,
});
for (const dist of distributions) {
  await publishEncryptedShareDistribution({
    distribution: dist,
    bundleSumCommitment: bundle.sumCommitment.bytes,
    operatorDid: operatorDid,
    podUrl: 'https://operator.example/pod/',
  });
}

// Recipient side (each pseudo-aggregator):
const fetched = await fetchPublishedEncryptedShareDistribution({ graphUrl });
const myShare = decryptShareForRecipient({
  distribution: fetched!,
  recipientKeyPair: myOwnX25519KeyPair,
});

// Operator-signed pre-reveal committee authorization
// In-process API (composes the existing wallet primitives).
import {
  signCommitteeAuthorization,
  publishCommitteeAuthorization,
  fetchPublishedCommitteeAuthorization,
  verifyCommitteeMatchesAuthorization,
} from '@interego/core/applications/_shared/aggregate-privacy';

// Operator side (BEFORE distributing shares):
const authorization = await signCommitteeAuthorization({
  bundleSumCommitment: bundle.sumCommitment.bytes,
  authorizedDids: [/* the n pseudo-aggregator DIDs */],
  threshold: { n: 5, t: 3 },
  operatorDid,
  operatorWallet,
});
await publishCommitteeAuthorization({
  authorization,
  podUrl: 'https://operator.example/pod/',
});

// Auditor side (at audit time, after the reveal has happened):
const fetchedAuth = await fetchPublishedCommitteeAuthorization({ graphUrl });
const cross = verifyCommitteeMatchesAuthorization({
  authorization: fetchedAuth!,
  attestation: revealedAttestation, // from publishCommitteeReconstructionAttestation
});
// cross.valid === false if the reveal committee includes anyone the
// operator didn't authorize, or the bundleSumCommitment differs, or
// the reveal committee was smaller than the authorized threshold t.
```

## What's NOT in the ladder

- **Cross-query DP composition theorems** (advanced composition, RDP,
  zCDP). v3.2 tracks naive sequential composition only. Advanced
  composition would let an operator spend MORE cumulative ε for the
  same effective privacy guarantee at the cost of weaker per-query
  bounds.
- **Full multi-party threshold reveal with no trusted dealer**.
  v4-partial+VSS ships the Shamir + Feldman VSS split + chain-of-
  custody attestation, but the operator running `buildAttestedHomomorphicSum`
  still knows the polynomial coefficients during the split. Removing
  that final trust assumption needs Distributed Key Generation —
  a multi-round protocol where each pseudo-aggregator contributes
  randomness and verifies the others' contributions, so NO party
  (including the operator) ever sees the polynomial. Multi-week
  distributed-crypto work; out of session scope. The protocol-layer
  hooks (thresholdShares + coefficientCommitments + committee
  attestation) are already in place to be wired into a DKG when it ships.
- **Non-interactive ZK range proofs on each contribution** (Bulletproofs
  / similar). v3.1 closes the bounds-lying threat via aggregator-side
  re-check + signed-bounds attestations; a future v3.4 could swap in
  Bulletproofs so the bounds check itself is verifiable without
  revealing the value. (v3 `zk-distribution` does NOT need this — one-
  hot encoding bounds each per-bucket contribution to {0, 1} by
  construction.)

## Honest scoping

The aggregate-privacy ladder is end-to-end for the trust model the
rest of the substrate already assumes (pod owner trusts their identity
server; institution trusts its own operator) and substantially extends
that with v4-partial (committee holds the blinding, no single auditor
knows it) + VSS (corrupted shares caught up-front) + chain-of-custody
attestation (regulator can see who actually reconstructed). The
remaining trust assumption — the operator running
`buildAttestedHomomorphicSum` knows the polynomial coefficients during
the split — needs DKG to fully remove, and DKG is not yet shipped.

For everything from "I want a private count" through "I want a
regulator-grade audited sum with cumulative ε tracking + a
tamper-evident audit log + a t-of-n committee holding the blinding
with chain-of-custody" — pick the lowest layer that meets your threat
model and add layers as the model shifts. Every layer is optional and
additive; the API doesn't force you up the ladder prematurely.
