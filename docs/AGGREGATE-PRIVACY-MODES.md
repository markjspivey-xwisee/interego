# Choosing an aggregate-privacy mode

The Interego aggregate-privacy ladder ships five layered modes. Each
composes the previous; none replaces it. This page is the adopter's
field guide — which mode to pick for which threat model, and how to
upgrade in place when the threat model shifts.

The implementations all live in
[`applications/_shared/aggregate-privacy/`](../applications/_shared/aggregate-privacy/index.ts)
+ [`src/crypto/pedersen.ts`](../src/crypto/pedersen.ts); contract tests
pin every cheat path in
[`applications/_shared/tests/aggregate-privacy.test.ts`](../applications/_shared/tests/aggregate-privacy.test.ts)
(44 tests, all green).

## Which mode to pick

| Your threat model | Pick this mode |
|---|---|
| Trusted operator + cohort participants — you just want a count of decisions / completions / credentials | **v1 `abac`** (default) |
| Operator wants a tamper-evident count an auditor can re-verify; contributors must explicitly opt in | **v2 `merkle-attested-opt-in`** |
| Operator must compute a SUM (or count, or threshold) over private contributor values WITHOUT learning the individual values | **v3 `zk-aggregate`** |
| Plus: the operator is also under regulator audit and cannot be trusted to attribute commitments correctly | **v3 + `require_signed_bounds: true`** |
| Plus: cumulative ε-discipline matters (many queries against the same cohort) | **v3 + `epsilon_budget_max: <ε>`** |
| Plus: the audit log itself must be tamper-evident, not just honest accounting | **v3 + `signBudgetAuditLog`** (in-process API) |
| Multi-aggregator threshold reveal (k-of-n DKG + Shamir on blindings) | **v4 — not yet shipped, multi-day crypto work** |

## The ladder

| Mode | What it gives | What stops cheating | What it does NOT cover |
|---|---|---|---|
| **v1 `abac`** | Count derived from descriptors the operator's ABAC scope permits reading. Default. | The pod's standard ABAC — descriptors outside scope simply don't appear in the count. | No tamper-evidence; no opt-in primitive; no DP noise; the operator could lie about the count. |
| **v2 `merkle-attested-opt-in`** | Verifiable count of explicitly opted-in participants. Each result includes a Merkle root over the participation descriptor IRIs + per-leaf inclusion proofs so any auditor can verify the count without seeing which participants are in it. | (a) Contributor opt-in is required — institution cannot include a non-consenting contributor. (b) `verifyAttestedAggregateResult` rejects: count inflation, count deflation, inclusion-proof root substitution, leaf tampering. | Doesn't compute sums or distributions, only counts. The individual values are still cleartext on the contributor's pod (just not in the aggregate). |
| **v3 `zk-aggregate`** | Homomorphic Pedersen sum + DP-Laplace noise calibrated to a public ε budget. Operator sums commitments WITHOUT seeing individual values; published sum is `trueSum + Laplace(sensitivity / ε)`. Re-verifiable: sum-commitment equals the homomorphic sum of contributor commitments. | `verifyAttestedHomomorphicSum` rejects: aggregator substituting sumCommitment from a different cohort, lying about reconstructed trueSum, inflating noisySum past consistency with claimed noise. The DP noise itself isn't re-verifiable (random by design); auditors check structural integrity + the ε claim. | (a) Malicious contributor lying about their value is caught only by the aggregator's bounds re-check — see v3.1. (b) Cumulative ε leakage across queries — see v3.2. (c) Single-aggregator trust — see v4. |
| **v3.1 `+ requireSignedBounds: true`** | Each contribution carries an ECDSA signature over `signedBoundsMessage(commitment, bounds, contributorDid)`. Aggregator refuses contributions without a valid signature. | Catches: aggregator inflating a contributor's bounds (sensitivity invariant); impersonation (aggregator attributing a commitment to a different contributor); replay across cohorts (each signature is bound to a specific cohort + commitment). | Doesn't catch a contributor that signs their OWN bounds wider than they should — they're free to declare `[0, 1000000]` if they want. Mitigation: institutional policy descriptor on the operator's pod that caps the declared bounds. |
| **v3.2 `+ epsilonBudget`** | `EpsilonBudget` tracker per cohort; declares max ε; `consume()` per query; throws when cumulative consumption would exceed the cap. `buildAttestedHomomorphicSum` accepts the tracker and pre-flight aborts if the request would push over. `toJSON()` / `fromJSON()` for persistence. | Catches: caller running 1000 small-ε queries that effectively reveal everything; budget overrun in the current session (it throws BEFORE producing the bundle). | Honest accounting, not tamper-evident — a malicious caller bypassing the tracker still leaks DP info. Mitigation: v3.3 wraps the log in a signed artifact. |
| **v3.3 `signBudgetAuditLog`** | Wraps `EpsilonBudget.toJSON()` in a SignedBudgetAuditLog whose signature recovers the operator's DID. `verifyBudgetAuditLog` confirms: signature is valid, log entries sum to spent, spent ≤ maxEpsilon. | Catches: tampering with snapshot.spent after signing; silently dropping log entries; impersonated signer; internal consistency violations. The audit log itself is now a verifiable artifact. | A malicious operator that NEVER signs the log at all isn't caught by the verifier; that's an institutional-policy enforcement problem (the institution publishes a policy saying "all aggregate queries MUST publish a signed budget log" and binds operators to it via the existing `passport:` machinery). |

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
```

## What's NOT in the ladder

- **Cross-query DP composition theorems** (advanced composition, RDP,
  zCDP). v3.2 tracks naive sequential composition only. Advanced
  composition would let an operator spend MORE cumulative ε for the
  same effective privacy guarantee at the cost of weaker per-query
  bounds.
- **Multi-party threshold reveal**. Right now the aggregator is a
  single trusted role. v4 would distribute the reveal across k
  aggregators with a t-of-k DKG + Shamir secret sharing on the
  blindings. Real distributed-crypto work, multi-day implementation;
  out of session scope.
- **Non-interactive ZK range proofs on each contribution** (Bulletproofs
  / similar). v3.1 closes the bounds-lying threat via aggregator-side
  re-check + signed-bounds attestations; a future v3.4 could swap in
  Bulletproofs so the bounds check itself is verifiable without
  revealing the value.

## Honest scoping

The aggregate-privacy ladder is end-to-end for the single-aggregator
trust model that the rest of the substrate already assumes (pod owner
trusts their identity server; institution trusts its own operator).
For multi-aggregator setups where no single party is trusted with
the reveal, you want v4 — and v4 isn't shipped yet.

For everything from "I want a private count" through "I want a
regulator-grade audited sum with cumulative ε tracking + a
tamper-evident audit log" — pick the lowest layer that meets your
threat model and add layers as the model shifts. Every layer is
optional and additive; the API doesn't force you up the ladder
prematurely.
