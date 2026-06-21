# Name provenance: from "Context Graphs" to the Interego Protocol — and how we relate to the W3C work

*Status: informative. Last updated 2026-06-21.*

This note records why Interego's L1 protocol was renamed from **"Context Graphs 1.0"** to the
**Interego Protocol 1.0** (`iep:`), documents the independent lineage of the old name so there is no
appearance of derivation in either direction, and sets out — honestly — how Interego relates to two
contemporaneous W3C efforts: the **Context Graphs Community Group** and the **Holon Community Group**.

It is deliberately plain and does not claim priority. Where Interego is ahead we say so; where a W3C
effort does something Interego does not, or got there first, we say that too.

---

## 1. Summary

- Interego's L1 protocol used the name **"Context Graphs"** as a *data-model* label — typed context
  descriptors over RDF 1.2 named graphs. It is **not** derived from, and does not extend, the W3C
  Context Graphs Community Group, whose "Context Graphs" is a *problem* label (contextual misalignment
  at interpretation boundaries).
- The two names are an **independent, near-contemporaneous convergence** on a generic pair of words
  ("context" + "graphs") common across the knowledge-graph field. We make **no priority claim** — the
  W3C group's public proposal slightly predates this repository's first public commit (see §3).
- To remove the collision and because "Context Graphs" undersold the substrate (which is fundamentally
  a usage-based-semiotic, holonic, content-addressed lattice — not "graphs"), the L1 protocol is now the
  **Interego Protocol** (`iep:`, `…/ns/iep#`). The former `cg:` namespace is retained as a deprecated,
  dereferenceable read-alias so prior signed/persisted data keeps verifying and resolving.
- Much of what both W3C efforts set out to standardize is, for Interego, an **emergent property of the
  existing substrate** rather than new machinery (see §5–§6). That is a statement about technical
  subsumption, not about who should own a standard.

---

## 2. What "Context Graphs" meant in Interego (the data-model lineage)

Interego's L1 protocol is a typed-context substrate. Its intellectual lineage is documented in
[`docs/ARCHITECTURAL-FOUNDATIONS.md`](ARCHITECTURAL-FOUNDATIONS.md) and
[the spec](spec/interego-protocol-1.0-wd.html): Peircean triadic semiotics + usage-based linguistics,
holonic hypergraphics, and the PGSL content-addressed lattice (a Grothendieck-fibration realization).
The concrete L1 constructs are:

- the typed **Context Descriptor** over RDF 1.2 **named graphs**, with seven facets (Temporal,
  Provenance, Agent, AccessControl, Semiotic, Trust, Federation);
- a **composition algebra** — union / intersection / restriction / override forming a bounded lattice;
- **modal status** (Asserted / Hypothetical / Counterfactual) and `supersedes` chains;
- the **PGSL** atom/fragment lattice underneath.

"Context Graphs" named *this construction*. It was always a technical/data-model term, and the design
predates any awareness of the W3C group's framing. The substrate's distinctive ideas — the lattice
composition algebra, the tree→hypergraph holarchy, verifiable belief-revision (`supersedes` →
content-addressed replay proof), wallet-rooted identity + E2EE, and a shipped agent runtime — have no
counterpart in the W3C Context Graphs CG's deliverables and are not borrowed from it.

---

## 3. The timeline (stated honestly)

| Date | Event |
|---|---|
| 2026-02-23 | **W3C Context Graphs Community Group** proposed (Ron Itelman, proposer; CfP 2026-02-24). Mission: representing/resolving **contextual misalignment** between global knowledge models and local interpretation in decision/AI systems. |
| 2026-03-17 | Interego's L1 ontology file authored (`docs/ns/iep.ttl`, formerly `cg.ttl`; `dct:created 2026-03-17`). |
| 2026-03-20 | This repository's first public commit (`@foxxi/context-graphs 0.1.0`). |
| 2026-06 (proposed) | **W3C Holon Community Group** (Kurt Cagle, Semantical LLC) — Holon Core Ontology, SHACL shape libraries, and the **DataBook** specification. |
| 2026-06-21 | Interego renames its L1 protocol to **Interego Protocol** (`iep:`); vacates "Context Graphs". |

The W3C Context Graphs CG's public proposal **precedes** this repository's first public commit. We do
**not** assert that Interego's use of the name came first. The defensible claim is **independence**: a
different meaning (data model vs. problem), a different intellectual lineage, and no shared authorship —
plus the fact that we are now renaming away from the term rather than contesting it.

---

## 4. The W3C Context Graphs Community Group — relationship

**What it is.** A W3C Community Group developing (per its Call for Participation) a core data model for
*contextual prerequisites and their resolution state*, a vocabulary of *contextual-mismatch categories*,
and optional protocol guidance for *structured clarification and safe stopping* when context cannot be
resolved. Its object of study is the **context gap** — the residue when terms or assumptions fail to
carry meaning across an organizational/temporal/operational boundary. Founding supporters include
Kurt Cagle and Holger Knublauch (a SHACL co-author). (Its chair status was, at the time of writing,
inconsistent across primary sources; treat specifics as provisional.)

**How Interego relates.** Different goal, same two words. Interego's L1 names the *graph payload*; the
W3C CG names the *gap between interpretations*. Interego does not currently ship a named context-gap
primitive, a mismatch-category taxonomy, or a resolution-trace format — those are the CG's actual
product, and the taxonomy/detection semantics are the hard part. **However**, the *reconciliation* the CG
targets is, for Interego, an emergent property of the existing usage-based-semiotic layer (see §6), not a
new vocabulary to declare. Interego can also *carry* the CG's artifacts once they are defined: a
context-gap record + resolution trace serialize cleanly onto a Context Descriptor + provenance trace +
content-addressed replay proof, and a SHACL-expressed CG vocabulary would slot directly into Interego's
shapes.

**Stance.** Engage as a peer and as a carry-layer; conform Interego *to* the CG's published vocabulary
when it lands (a neutral, multi-vendor vocabulary is upstream of any one implementation), rather than
claim Interego "is" that work.

---

## 5. The W3C Holon Community Group + DataBooks — relationship

**What it is.** The Holon Graph Architecture (Koestler-rooted holons: each node simultaneously a whole
and a part of a holarchy) grounded in RDF 1.2 / SHACL, with a Holon Core Ontology, SHACL shape
libraries, and the **DataBook** spec — Markdown + YAML frontmatter + fenced Turtle/SHACL/SPARQL blocks
as a self-describing, executable knowledge artifact.

**How Interego relates.** Strong independent convergence on the *representational move* Interego already
ships: a typed envelope over named graphs with a payload/boundary split and SHACL validation, the holon
concept (Interego generalizes the holarchy from a tree to a hypergraph with categorical foundations), and
a Markdown-carrier-of-semantics (Interego's `SKILL.md ↔ iep:Affordance` bridge). On the substrate axis,
Interego's primitives subsume and exceed HGA. The **one** genuinely distinct DataBook idea is *the
document is the executable unit* — Interego instead puts logic in kernel verbs and content-addressed
reducers referenced *by* descriptors (a deliberate choice for replayability), so a DataBook *authoring
profile* over Interego is emergent while the inline-execution stance is not adopted.

**Honest concessions.** The Holon CG has things Interego does not: a community-owned namespace and the
**legitimacy of multi-vendor W3C consensus** (which a single-authority project cannot self-generate), a
ready-to-run DataBook toolchain, and a named upper ontology of domain holons. We do not claim parity on
governance.

---

## 6. Why "context gap / mismatch categories" is emergent in Interego (the semiotic account)

A first reflex is to standardize a *catalog* of context-mismatch types. Under Interego's foundations that
would be the wrong layer. Interego is built on **usage-based semiotics**: meaning is use, the shared
semantic space is *assumed* to be partial and contested, and interpretation is agent-relative (the
Peircean interpretant). Consequently:

- A **context gap is not a declared primitive** — it is the *reified residue of a failed reconciliation*
  in a shared usage space. It surfaces when two agents (or a human and an agent) attempt to act on the
  same descriptor and their interpretants diverge. Interego already represents this: a divergence shows
  up as conflicting facets, a `Hypothetical`/`Counterfactual` modal status, or an interrogative the router
  cannot resolve — and the resolution history is carried by `supersedes` chains + provenance traces.
- **Mismatch categories are paradigmatic/syntagmatic patterns that crystallize over participants and
  time** — they are *learned from usage* (the compositional-tuple-store layer), not authored up front. A
  category like "the term meant X locally but Y globally" is a recurring pattern across reconciliation
  episodes; naming it is a downstream observation, not an axiom.
- The CG's **safe-stop** ("don't act when required context is unresolved") maps onto Interego's existing
  evaluation outcomes (abstain / escalate) — what is genuinely missing is only the *gap-detection
  predicate* that triggers them, and even that is better *derived* from interpretant divergence than
  hand-specified.

So the CG's product is, in Interego's terms, largely **downstream of the usage-based-semiotic substrate**
— an emergent property of attempted communication between participants, reconciled after the fact, rather
than a static taxonomy bolted on. This is the honest, stronger version of "could this be an emergent
property of Interego": for the gap/mismatch problem, yes — via semiotics, not via a new vocabulary.

---

## 7. References

- W3C Context Graphs Community Group — Call for Participation:
  <https://www.w3.org/community/context-graph/2026/02/24/call-for-participation-in-context-graphs-community-group/>
- W3C Context Graphs Community Group — proposal:
  <https://www.w3.org/community/blog/2026/02/23/proposed-group-context-graphs-community-group/>
- W3C Holon Community Group: <https://github.com/w3c-cg/holon/blob/main/README.md>
- DataBooks (Kurt Cagle): <https://ontologist.substack.com/p/databooks-markdown-as-semantic-infrastructure>
- Interego Protocol spec: [`spec/interego-protocol-1.0-wd.html`](spec/interego-protocol-1.0-wd.html)
- Interego architectural foundations: [`ARCHITECTURAL-FOUNDATIONS.md`](ARCHITECTURAL-FOUNDATIONS.md)
- The `cg:` → `iep:` migration: [`ns/cg.ttl`](ns/cg.ttl) (deprecated alias) → [`ns/iep.ttl`](ns/iep.ttl)
