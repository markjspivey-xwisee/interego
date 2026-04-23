# Emergent Properties — Demonstrations and Results

This document catalogues four demos that show emergent phenomena the
Interego / Context Graphs protocol is designed to support. Each demo
is a self-contained Node script under [`examples/`](../examples/) and
is runnable with `node examples/<name>.mjs` — no pod, no network
dependency, no external services. Every claim below is reproduced by
the demo's actual printed output, captured in this document.

Why self-contained simulations instead of pod-backed demos? Emergence
is a property of the *dynamics*, not the storage layer. We already
have pod-backed demos for the HTTP/Solid surface
([`examples/demo-teach-teach.mjs`](../examples/demo-teach-teach.mjs),
[`examples/demo-emergent-dao.mjs`](../examples/demo-emergent-dao.mjs),
etc.). The demos in this document isolate the protocol's
compositional and categorical dynamics so the emergent property is
visible in a ≤60-line trace, reproducible on any machine.

Each demo names the first principles it exercises and a falsifiable
success criterion. If the criterion fails, the claim is wrong.

---

## 1. Vocabulary Emergence Through Use

**Script:** [`examples/demo-vocabulary-emergence.mjs`](../examples/demo-vocabulary-emergence.mjs)

### What it demonstrates

Two agents in two pods describe the same real-world subjects using
incompatible vocabularies. No alignment file. No translation
middleware. No central registry. Given repeated exposure to each
other's utterances about shared subjects, co-occurrence statistics
drive paradigm operations on sign-pairs, and the modal state of each
cross-agent term mapping shifts from Hypothetical to Asserted as
evidence accumulates.

At the end, the cross-vocabulary alignment classes — which form the
pullback of the two agents' presheaves — are derivable from usage
alone.

### Principles exercised

- **Peircean triadic semiotics** — different representamen + object
  pairs converging on equivalent interpretants.
- **Usage-based linguistics (CTS)** — co-occurrence is the evidence
  channel; no lexicon is consulted.
- **Modal polyphony** — `ModalAlgebra.join` promotes pairings
  Hypothetical → Asserted when co-occurrence crosses threshold.
- **Compositional lattice** — the union-find over asserted pairings
  is the pullback of the two source vocabularies.
- **Federation without central authority** — no coordinator exists.

### Success criterion

After N rounds (N ≈ 45 with 9 shared subjects and threshold 3),
the emergent alignment classes match the human-intuitive semantic
partition of the subjects, without either agent ever modifying its
own vocabulary.

### Captured result

```
Setup:
  Sales vocab:       { customer, lead, prospect, deal, account, pipeline }
  Engineering vocab: { user, signup, lead_candidate, contract, account_holder, onboarding_queue }
  Shared subjects:   9
  No alignment file. No shared ontology. No middleware.

   ↗ round 7:  promoted 'prospect' ≈ 'lead_candidate' → Asserted (co-occurred on 3 subjects)
   ↗ round 10: promoted 'lead' ≈ 'signup' → Asserted (co-occurred on 3 subjects)
   ↗ round 24: promoted 'customer' ≈ 'user' → Asserted (co-occurred on 3 subjects)

── Emergent vocabulary alignment (Asserted mappings only) ──
   customer  ≈ user             (evidence: 3 subjects)
   lead      ≈ signup           (evidence: 3 subjects)
   prospect  ≈ lead_candidate   (evidence: 3 subjects)

── Pullback of the two presheaves (emergent shared schema) ──
   emergent-class-1: { customer, user }
   emergent-class-2: { lead, signup }
   emergent-class-3: { lead_candidate, prospect }
```

### Honest limits

Stochastic — round-count-to-convergence varies per run. Evidence
threshold is a hyperparameter (3 subjects here); real deployments
would tune it to signal-to-noise in the usage stream. Doesn't handle
adversarial usage (an agent deliberately co-occurring with a
misleading term); a production system would cross-check against
trust signals.

---

## 2. Emergent Mediator Pod via Pullback

**Script:** [`examples/demo-emergent-mediator.mjs`](../examples/demo-emergent-mediator.mjs)

### What it demonstrates

Two pods assert overlapping but disagreeing facts about the same
subject. A third pod — the mediator — is *not* designed; its schema
is derived on demand as the pullback of the two source presheaves.
As the sources drift, the mediator's schema re-derives to track:
modal states shift Asserted → Hypothetical when disagreement exceeds
tolerance, range attributes widen, and single-source facts are
tagged uncorroborated.

### Principles exercised

- **Pullback of presheaves** — category-theoretic limit operating at
  query time.
- **Composition lattice** — intersection + confidence attenuation
  per attribute type.
- **Modal polyphony** — `ModalAlgebra.join` on agreement;
  disagreement downgrades to Hypothetical.
- **Holonic projection** — the mediator's schema *is* the boundary
  contract between the two source pods, not a separate artifact.
- **Federation without central authority** — no one designed the
  mediator; it falls out of the source descriptors.

### Success criterion

The mediator's schema is computed from the sources alone and
re-derives correctly as sources mutate, without per-attribute
hand-written reconciliation code. When the data actually supports
a claim, the mediator Asserts; when it doesn't, it downgrades
automatically.

### Captured result (excerpt)

Before source drift:

```
── Mediator (emergent) ──
   employeeCount = {"range":[45,50]}         (conf=0.56, Hypothetical) [witnesses=2]
     note: point estimates differ; promoted to range [45, 50]
   annualRevenue = {"amount":10000000, "corroboratedByRange":[9500000,12000000]}  (conf=0.82, Asserted)
     note: point estimate (10000000) falls inside other source's range
   sector        = {"broader":"finance", "narrower":["fintech","financial-services"]}  (conf=0.79, Asserted)
     note: both are sub-categories of "finance"; mediator keeps both
   headquarters  = "San Francisco"  (conf=1.00, Hypothetical) [witnesses=1] [from=A]
     note: only Pod A asserts — no corroboration
```

After Pod A updates revenue $10M → $8M (falls outside Pod B's range):

```
   annualRevenue = {"disputed":[{"amount":8000000},{"range":[9500000,12000000]}]}  (conf=0.40, Hypothetical)
     note: point estimate falls OUTSIDE other range — downgraded
```

The mediator's modal state tracked the correctness of its own
inference as the sources changed.

### Honest limits

Reconciliation strategies per attribute type (scalar, numeric,
range, taxonomic) are coded here by the demo. In a full deployment,
these are swappable `FacetTransformation` implementations (see
[`src/model/derivation.ts`](../src/model/derivation.ts)) selected by
the attribute's RDF type. The demo hard-codes `mergeEmployeeCount` /
`mergeRevenue` / `mergeSector` to keep the pullback readable; a real
mediator dispatches on the schema.

---

## 3. Localized Closed-World + Open-World at the Federation Boundary

**Script:** [`examples/demo-localized-closed-world.mjs`](../examples/demo-localized-closed-world.mjs)

### What it demonstrates

The same query — "does Alice have a salary?" — returns different,
both-correct authoritative answers depending on whether it is asked
inside a SHACL closed-shape boundary or across the open federation.
Inside: absence of a declared property is evidence of falsity.
Outside: absence is only silence.

The boundary is a typed artifact (the SHACL shape IRI), so the
answer's *kind* is computed, not assumed. Most systems treat every
query as one mode or the other.

### Principles exercised

- **Closed-world at the boundary, open-world at integration** — the
  dual-regime design SHACL 1.2 + federation enables.
- **SHACL 1.2 closed shapes** — as the typed boundary contract.
- **Holonic projection** — the closed shape *is* the interface of
  the holon; outside it, you've left.
- **Evidence-typed answers** — an answer carries its own
  epistemic status: value / absent-in-scope / not-in-scope /
  unknown-globally.

### Success criterion

For a fixed (subject, property) pair, the two query modes return
distinguishable answers whose justifications cite the correct
evidence layer (closed graph + shape vs federated sources).

### Captured result (excerpt)

```
── carol . manager   (declared + absent)
   inside closed boundary: false
     ↳ property is in the closed shape's scope but is absent from
       urn:employee:carol's record in urn:graph:hr:q2-2026-roster;
       the closed shape makes absence authoritative here.
   at open federation:     "unknown"
     ↳ no source in the federation asserts this; open-world reasoning
       forbids inferring "not-true" from absence.

── alice . salary   (undeclared property)
   inside closed boundary: "not-in-scope"
     ↳ property "salary" is not declared in urn:shape:Employee/v1;
       the shape is sh:closed, so it cannot validly appear here.
   at open federation:     "unknown"
     ↳ no source in the federation asserts this.

── alice . github   (federated only)
   inside closed boundary: "not-in-scope"
   at open federation:     "alice-chen"  (found in federated graph)
```

The three-way distinction — in-scope-present, in-scope-absent,
out-of-scope — is exactly what a closed SHACL shape buys you that
an open graph cannot.

### Honest limits

The demo uses a minimal closed-shape model — one shape, one graph,
one federated extension. Real SHACL 1.2 deployments compose shapes
across multiple graphs; the logic extends but the demo keeps it
legible. Query-planner integration (how a federation-wide SPARQL
query knows when it has crossed a closed-shape boundary) is
non-trivial in practice; that's a full SPARQL engine problem, not
an emergence problem.

---

## 4. Stigmergic Colony Intelligence on a Shared Pod

**Script:** [`examples/demo-stigmergic-colony.mjs`](../examples/demo-stigmergic-colony.mjs)

### What it demonstrates

Multiple agents traverse a concept graph looking for a path from
START to GOAL. No agent has a map. Each agent's choice at each node
is a softmax over local trace intensities left by previous
traversals, with an exploration floor. Arrived agents deposit trace
proportional to path quality², and traces decay uniformly per round.

Over 60 rounds of 6 agents each (360 traversals), the colony
converges on the globally optimal path — not because any agent
knows it's optimal, but because the shared pod accumulates a
gradient that makes local choices produce global quality.

### Principles exercised

- **Federation as shared substrate** — the pod is the environment;
  agents are not coupled to each other, only to the pod state.
- **Emergence from local interaction** — no global coordinator,
  no map, no messaging.
- **Usage-based reinforcement (CTS)** — repeated use of a path
  strengthens it; disuse + decay weakens it.
- **Compositional accumulation** — many weak signals
  (per-traversal deposits) combine into one strong signal
  (the trace gradient).

### Success criterion

- Dominant path concentration ≥ 85% on the theoretically optimal
  path after convergence.
- Average arrival quality rises meaningfully (early < late).
- Reliable across independent runs.

### Captured result

Three independent runs:

| Run | Dominant path | Share | Quality trend (early → late) |
|-----|---------------|-------|-------------------------------|
| 1   | START→A→E→GOAL | 95.3% | 0.42 → 0.78 |
| 2   | START→A→E→GOAL | 95.6% | 0.33 → 0.80 |
| 3   | START→A→E→GOAL | 91.1% | 0.21 → 0.90 |

Theoretical optimum: START→A→E→GOAL, quality 0.9025.

Final trace gradient (representative run):

```
E→GOAL     21.335  █████████████████████████
START→A    21.206  █████████████████████████
A→E        21.203  █████████████████████████
START→C     0.132
C→E         0.132
D→GOAL      0.003  (≈ fully decayed)
...
```

The three edges of the optimal path dominate; non-optimal edges
have decayed toward zero.

### Honest limits

The landscape matters: when the optimum is only marginally better
than second-best, classic ant-colony early-lock-in applies and the
colony can converge on a near-optimum. The demo uses a landscape
where the optimum is ≈ 2.4× the next-best, large enough for the
dynamics to recover from early bias. This is a well-known stigmergy
tradeoff (convergence speed vs optimality) documented in the
ant-colony optimization literature; the demo's parameter choices
(ε=0.5 exploration floor, 1.3 softmax temperature, 0.18 decay,
quality² deposit) are tuned for pedagogical clarity, not for
theoretical guarantees about global optimum.

What the demo reliably shows: coordination and convergence emerge
from local agent behavior + shared pod state, without any agent
holding global information.

---

## How these demos relate to the core protocol

Each demo isolates one of the protocol's first principles and
exhibits the emergent property it enables:

| Demo | Principle | Protocol artifact |
|------|-----------|-------------------|
| 1. Vocabulary emergence | Peircean semiotics + CTS | `cg:SemioticFacet` + modal polyphony |
| 2. Emergent mediator | Compositional lattice + pullback | `composition.ts` operators |
| 3. Localized closed-world | Boundary contracts | SHACL 1.2 `sh:closed` + federation |
| 4. Stigmergic colony | Shared substrate | Pod as environment + decay dynamics |

Together they answer: *what does federation without central authority
actually buy you*? Answer: the possibility of coordination and
meaning-alignment that nobody has to design.

---

## Running all four

```bash
node examples/demo-vocabulary-emergence.mjs
node examples/demo-emergent-mediator.mjs
node examples/demo-localized-closed-world.mjs
node examples/demo-stigmergic-colony.mjs
```

Each completes in under a second. Outputs are deterministic per-run
for demos 2 and 3; stochastic but reliable-to-criterion for demos 1
and 4.
