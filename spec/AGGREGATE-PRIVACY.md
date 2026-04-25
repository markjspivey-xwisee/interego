# Privacy-Preserving Aggregate Queries (DP + ZK)

A protocol for computing aggregates across N pods without revealing
individual contributions. Combines differential privacy (DP) for
output noise + zero-knowledge proofs (ZK) for per-contribution
proof-of-validity. Use cases: federated learning at the descriptor
layer, regulatory aggregate reporting without exposing line-items,
research pooling of sensitive data.

## Status

**Design doc — Layer 2 pattern (forthcoming as `aggregate:` ontology).**
Sketch of how this composes existing ZK primitives in
`src/crypto/zk/` with new aggregation rules. Reference runtime is a
follow-up.

## The problem

A query asks "what's the average codeQuality across the N agents on
pods P1...PN?" The pods are willing to contribute aggregate
participation but not their individual values. Today: every agent
hand-picks what to share. We want: a single protocol step that
yields a DP-noised aggregate plus a ZK proof that each contribution
was valid (bounded, signed, fresh).

## Approach

A **federated aggregate query** is itself a `cg:ContextDescriptor`:

```turtle
<urn:agg:q-42> a aggregate:Query ;
    aggregate:overGraph <urn:set:participating-pods> ;
    aggregate:operation aggregate:Mean ;
    aggregate:targetPath "amta:codeQuality" ;
    aggregate:bounds [ aggregate:min 0.0 ; aggregate:max 1.0 ] ;
    aggregate:dpEpsilon 1.0 ;
    aggregate:requestedBy <urn:agent:auditor> .
```

Each pod responds with:
1. A ZK range proof that its contribution is in `aggregate:bounds`.
2. A commitment to the contribution.
3. Optionally, a Merkle inclusion proof that the contribution is
   one of the pod's valid (signed, fresh) attestations.

The aggregator:
1. Verifies every ZK proof.
2. Sums the commitments using a homomorphic commitment scheme
   (Pedersen commitments over an elliptic curve subgroup — out of
   scope of the current `src/crypto/zk/` runtime; future).
3. Adds DP noise calibrated to ε.
4. Returns the noised aggregate + a proof bundle for the requester
   to re-verify.

## Vocabulary additions (`aggregate:` namespace, planned)

```turtle
aggregate:Query a owl:Class ;
    rdfs:subClassOf cg:ContextDescriptor ;
    rdfs:comment "A federated aggregate query specification." .

aggregate:Operation a owl:Class ;
    rdfs:comment "Aggregation function. aggregate:Mean, aggregate:Sum, aggregate:Count, aggregate:Variance, aggregate:Quantile." .

aggregate:Mean      a aggregate:Operation .
aggregate:Sum       a aggregate:Operation .
aggregate:Count     a aggregate:Operation .

aggregate:Result a owl:Class ;
    rdfs:subClassOf cg:ContextDescriptor ;
    rdfs:comment "The DP-noised aggregate result + per-contribution ZK proof bundle. Re-verifiable by the requester." .

aggregate:dpEpsilon a owl:DatatypeProperty ;
    rdfs:comment "Differential-privacy budget for this query. Lower ε = more privacy, more noise." ;
    rdfs:range xsd:double .

aggregate:bounds a owl:ObjectProperty ;
    rdfs:comment "[min, max] bounds on the per-pod contribution. Required for noise calibration + ZK proof." .

aggregate:targetPath a owl:DatatypeProperty ;
    rdfs:comment "SHACL-style path naming the per-pod attribute being aggregated." .

aggregate:proofBundle a owl:ObjectProperty ;
    rdfs:domain aggregate:Result ;
    rdfs:comment "Proofs for each contribution: ZK range proof + commitment. Re-verifiable." .
```

## Differential privacy

- **Laplace mechanism:** for sum/count/mean of bounded values, add
  Laplace noise with scale `(max - min) / ε`. Standard.
- **Composition:** queries compose under DP — answering N queries
  with budget ε each costs Nε total. Implementations MUST track
  cumulative ε per pod to prevent budget exhaustion.
- **Per-pod opt-in:** each pod can refuse a query that would
  consume more than its remaining budget.

## Zero-knowledge proofs

The existing `src/crypto/zk/` already provides:
- `proveConfidenceAboveThreshold(value, threshold)` — proves
  `value >= threshold` without revealing `value`.
- `commit(value)` — Pedersen-style commitment.

For aggregate, we need:
- **Range proofs** for `min ≤ value ≤ max` (extension of
  `proveConfidenceAboveThreshold` with an upper bound)
- **Homomorphic sum proofs** — proving `sum(c_i) = c_sum` where
  `c_i` are commitments (this is what Pedersen commitments natively
  support; the existing impl uses hash commitments, which are NOT
  homomorphic, so this requires a primitive upgrade)

## The honest gap

Our existing ZK primitives are hash-based. They don't compose
homomorphically. So today's runtime can prove individual
contributions but can't sum them privately — the aggregator either
sees the values (defeats the purpose) or the protocol degrades to
"per-contributor count only."

**Path to full implementation:**
1. Add Pedersen commitments to `src/crypto/zk/` (built on
   `@noble/secp256k1` or similar, ~500 LoC).
2. Implement range proofs via Bulletproofs (an off-the-shelf library
   like `bulletproofs-js`, ~few-hundred LoC of integration).
3. Wire homomorphic sum + DP noise into the aggregator.

This is a substantial body of work but NOT speculative — every
piece has known good implementations in adjacent ecosystems
(particularly the Zcash and Privacy Pass research).

## Composition with other primitives

- **ABAC:** an aggregate query is gated by a `cg:AccessControlPolicy`
  that the requester must satisfy (e.g., "only auditors can request
  aggregates over health data").
- **Capability passport:** a successful aggregate participation is a
  `passport:LifeEvent` for the contributing pod (audit trail of
  what data the pod has contributed to which queries, with budgets).
- **Constitutional layer:** the query parameters (which operations
  are permitted, ε floor, default bounds) can themselves be
  governed by community-ratified constitutional policies.

## What this enables

- **Federated learning at the descriptor layer:** train a model on
  the aggregate distributions of attestations across pods without
  any pod sharing its individual attestations.
- **Regulatory reporting:** tax authorities aggregate financial
  metrics across companies without seeing individual filings.
- **Research data pooling:** medical studies pool patient-cohort
  aggregates across institutions; no institution shares per-patient
  data.
- **Reputation auditing without exposure:** prove a population's
  average competence is ≥ X without exposing individual scores.

## Honest limits

- **DP isn't free:** every query consumes the participants' privacy
  budgets. A community can be "queried out" if implementations
  don't enforce budgets carefully.
- **Sybil aggregation attacks:** an adversary running 1000 pods can
  poison aggregates. Use `filterAttributeGraph`-style sybil
  resistance to pre-filter participating pods.
- **Real-time vs batch:** computing aggregates over many pods is
  slow under the proof-verification overhead. Most real
  deployments will use this for batch reporting, not live queries.

## Implementation roadmap

1. **Phase 1:** Pedersen commitments + range proofs in
   `src/crypto/zk/`.
2. **Phase 2:** `aggregate:Query` ontology + reference aggregator
   handling SUM/COUNT/MEAN over bounded scalars.
3. **Phase 3:** DP-budget tracking per pod with refusal semantics.
4. **Phase 4:** Sybil pre-filter + multi-coordinator aggregation
   for fault-tolerance.
