# Architectural Foundations — Holonic Hypergraphics, Polygranular Composition, and the Peircean Substrate

> **Status:** Informative (Layer 3). This document explains the categorical
> interpretation of primitives that already exist in `@interego/core`. It
> does not change the protocol; it gives readers a formal account of why
> the protocol's choices hang together as a single construction.

## TL;DR

Interego is, mathematically, a **fibered presheaf of typed hypergraphs over a poset of holonic levels**, with the following correspondences:

- **GUIDs are holons; content is a representation.** Every entity at every level — character / token / triple / descriptor / amendment / vertical-affordance — is a dereferenceable IRI. Composition is link-traversal, never string concatenation. ([§1](#1-the-thesis-guids-are-the-holons-content-is-a-representation))
- **Hyperedges-as-holons** generalize Koestler's holarchy from a tree to a hypergraph. Each n-ary structure is simultaneously a whole over its members and a vertex in higher structures. The Janus-faced criterion falls out of the restriction/extension adjunction. ([§2](#2-holonic-hypergraphics-koestler-without-the-tree))
- **PGSL is a Grothendieck fibration** `p: E → B` where `B` is the poset of granularity levels and the fiber over each level is the hypergraph at that granularity. Cartesian morphisms are the promotion / decomposition maps between levels. ([§3](#3-the-polygranular-fibration-pgsl-formally))
- **HELA is the topos.** The presheaf `F: H^op → Set` over the category of holons-as-hyperedges; sections over a hyperedge are whole-level data; restriction maps to sub-hyperedges give the part-level view. The Janus property is the restriction/extension adjunction. ([§4](#4-the-presheaf-interpretation-hela-as-topos))
- **Four invariants** govern the construction: identity-by-reference, level-shift functoriality, restriction/extension adjunction, hyperedge composition as colimit. ([§5](#5-the-four-invariants))
- **Peircean correspondence** is encoded in the `sat:` ontology and made operational by `cgh:Affordance`: representation = Firstness, dereference act = Secondness, link relation (Hydra control) = Thirdness. ([§6](#6-the-peircean-correspondence))

The rest of the document spells out each correspondence and points at the file paths where the construction is realized in code or ontology.

---

## 1. The thesis: GUIDs are the holons, content is a representation

A character `m`, the bigram `ma`, the token `mark`, the triple `(mark, isa, human)`, a SCORM lesson, a constitutional amendment, a vertical's affordance manifest — these are not strings or tuples. They are **dereferenceable identities**:

```
urn:pgsl:atom:<sha256-of-content>
https://pod.example/me/context-graphs/<descriptor-slug>.ttl
urn:cg:amendment:<id>
urn:cg:tool:<name>:<hash>
```

Each identity has *representations* — Turtle, JSON-LD, JOSE envelope, prose, audio, glyph image — but the holon is the identity, not any one rendering. This is not a notational convenience. It is what makes everything else in the architecture work:

- **Substructure sharing is free.** Two agents minting the same atom value produce the same atom IRI; the bigram `ma` shared between `mark` and `human` is *literally one resource* with two inclusion morphisms, not two coincidentally-equal strings (Demo 06).
- **Composition is closed under federation.** A descriptor on pod A that references a descriptor on pod B does so by IRI. Cross-pod composition reduces to link-traversal; nothing has to be copied or canonicalized.
- **Provenance is verifiable end-to-end.** Every link is a citation by reference. Following the chain dereferences each step; signature verification at each hop is structural (Demo 09).
- **Identity portability survives infrastructure migration.** A capability passport's `agentIdentity` is an IRI; the identity does not move when the pod does (Demo 10).

This is HATEOAS — Hypermedia As The Engine Of Application State — taken all the way to cognition. A reasoner does not parse `mark is a human` as a string. It dereferences the triple, follows the subject link, follows the predicate link, follows the object link. The composition is a trace through links.

**Operational consequence in the codebase:** [`src/solid/client.ts`](../src/solid/client.ts) `publish()` writes the descriptor as Turtle metadata referencing the graph payload at a separate URL via [`buildDistributionBlock()`](../src/solid/index.ts) — clients follow the link rather than reconstructing URLs by filename convention. [`src/pgsl/lattice.ts`](../src/pgsl/lattice.ts) `mintAtom()` derives the atom IRI from the content hash; identical inputs deduplicate on the IRI itself, with no canonicalization pass required.

## 2. Holonic hypergraphics: Koestler without the tree

Koestler's *holarchy* (1967) frames a holon as Janus-faced — autonomous at its own level, integrated into the level above. Classical holarchies are trees: each holon has one parent. Real systems aren't trees: a heart cell is a part of the cardiovascular system *and* the metabolic system *and* the cellular-respiration system simultaneously. The tree is the weakest part of classical holonics.

**Hypergraphic holonics** replaces the tree with hypergraph connectivity. A holon participates in multiple containing wholes through different hyperedges (different "compositional contexts"). Identity of the holon is invariant; its role is hyperedge-relative.

Interego instantiates this directly:

- A `cg:ContextDescriptor` with multiple facets (Temporal / Provenance / Agent / AccessControl / Semiotic / Trust / Federation) is a typed n-ary hyperedge. Each facet is a constituent; the descriptor is the whole. (Demo 11 demonstrates this — three regulators query the same descriptor with three different framework lenses.)
- A `cg:Person` descriptor on an org pod can simultaneously be a participant in an `owm:Project` hyperedge, a voter in a `cg:Constitutional` amendment, and an attestor in an `amta:` chain — without rewriting the person's identity. The same holon, three hyperedge memberships.
- A PGSL fragment at level *k* is a hyperedge over level *(k-1)* fragments via the pullback span. The same atom can be the overlap of multiple distinct level-2 fragments — same Firstness, multiple semiotic contexts (Demo 06).

**Janus-faced criterion** is realized in the restriction/extension adjunction (§4): every hyperedge restricts to its constituents and extends to higher hyperedges containing it. The two operations are adjoint, which is the formal statement of Koestler's autonomy-and-integration duality.

**No tree assumption.** RDF named graphs and SHACL shapes are first-order over a set of resources. Multiple-membership is the default; exclusive membership requires a constraint. The protocol therefore models hypergraphic holonics natively.

## 3. The polygranular fibration: PGSL formally

The Poly-Granular Sequence Lattice ([`src/pgsl/`](../src/pgsl/)) is, formally, a **Grothendieck fibration** `p: E → B`:

- **Base `B`** is the poset of granularity levels (level 0 = atoms; level 1 = pair-fragments; level *k* = fragments built from two level-(k-1) fragments sharing a level-(k-2) overlap).
- **Total category `E`** has all holons at all levels as objects.
- **Fiber over level *k*** is the hypergraph at that granularity — atoms at level 0, fragments at higher levels.
- **Cartesian morphisms** are the promotion / decomposition maps between levels: `decompose: Fragment_k → (Fragment_{k-1} × Fragment_{k-1})` and the dual promotion via pullback construction.

The pullback square at level *k* (`pullbackSquare(uri)` in [`src/pgsl/category.ts`](../src/pgsl/category.ts) lines 126-174) is the categorical structure that makes this work:

```
                        apex (level k)
                       ↗            ↘
        left (level k-1)            right (level k-1)
                       ↘            ↙
                     overlap (level k-2)
```

The overlap is the shared sub-sequence — the last (k-2) items of `left` are identical to the first (k-2) items of `right`. This is a *real* pullback: the overlap is the universal object such that any other shared substructure factors through it.

**Composition has two directions:**

- **Horizontal** within a level: hyperedges compose operadically. At level 0, atoms concatenate (the operad of strings). At higher levels, fragments compose via shared overlap (RDF-style join through the pullback). At descriptor level, the four operators (union / intersection / restriction / override) are operadic compositions on typed contexts.
- **Vertical** across levels: γ ∘ γ' lifts a level-0 structure all the way up. The composite functor must preserve the holonic invariant.

These together form a **double category** of holons: horizontal arrows are intra-level composition; vertical arrows are granularity shifts. The coherence law is that horizontal-then-vertical equals vertical-then-horizontal up to natural isomorphism. This is the formal expression of "polygranular" — the lattice is closed under composition in both directions, and the directions commute coherently.

**N-gram sharing as the canonical example.** The bigram `ma` in `mark` and `human` is the apex of a span; `mark` and `human` are the legs; the pullback glues them along `ma` while keeping their differing contexts distinct. Because atoms are content-addressed, this is automatic — no algorithm detects the sharing; it falls out of IRI equality at the atom layer. This is essentially BPE (Byte-Pair Encoding) as a colimit operation, with the vocabulary as a generating set of n-gram holons.

## 4. The presheaf interpretation: HELA as topos

The HELA ontology ([`docs/ns/hela.ttl`](ns/hela.ttl)) declares the topos-theoretic structure: `ℰ = Set^(𝒞_xAPI^op)`. Generalizing beyond xAPI, the construction is:

```
F : H^op → Set
```

where:

- **`H`** is the category of holons-as-hyperedges, with morphisms being part-of relations (sub-hyperedge inclusions).
- **Sections** `F(h)` over a hyperedge `h` are the "whole-level" data — the typed descriptor, the constituent atoms, the facets attached to `h`.
- **Restriction maps** `F(h) → F(h')` for `h' ⊆ h` give the "part-level" view — the descriptor restricted to one of its constituent graphs, the fragment restricted to its overlap.
- **The Grothendieck topology** is determined by the hyperedge structure: a covering family of `h` is a set of sub-hyperedges whose union (under colimit) equals `h`.

**Janus-facedness as adjunction.** For each `h' ⊆ h`, the restriction `F(h) → F(h')` and its left adjoint extension `F(h') → F(h)` together encode the Janus property:

- Restriction = the "part" view (autonomy at the lower level).
- Extension = the "whole" view (integration into the upper level).
- The unit `id → ext ∘ res` and counit `res ∘ ext → id` of the adjunction are the coherence between the two views.

**Sheaf condition** is the demand that local data on a covering family glue to global data on the cover. In Interego, this is what makes `cg:supersedes` chains coherent: descriptors on different parts of the manifest combine into a consistent picture of belief without contradiction. The cleartext mirror in `normalizePublishInputs` ([`src/model/publish-preprocess.ts`](../src/model/publish-preprocess.ts)) is what makes the sheaf condition computable across encrypted graphs.

## 5. The four invariants

The architecture obeys four laws. Each is realized by specific code paths.

### Invariant 1 — Identity by reference

Every holon is a dereferenceable IRI. Equality of holons is IRI equality, never structural equality of representations. Operational realizations:

- `mintAtom(pgsl, value)` derives the atom IRI from `sha256(value)` ([`src/pgsl/lattice.ts`](../src/pgsl/lattice.ts)).
- `publish()` writes descriptor metadata at one URL and graph payload at a separate URL; clients follow the `cg:affordance` link, never reconstruct URLs by convention ([`src/solid/client.ts`](../src/solid/client.ts) lines 386-490).
- Cross-pod sharing (`share_with`) resolves recipients by IRI; the envelope's wrapped-key lookup is by IRI-derived public key ([`src/solid/sharing.ts`](../src/solid/sharing.ts)).

### Invariant 2 — Level-shift functoriality

The promotion functor γ: H_n → H_{n+1} preserves structural invariants. A holon promoted to a higher level retains its identity; its old hyperedge memberships at the lower level remain valid; its new memberships at the higher level extend rather than replace.

In code: PGSL's `pullbackSquare` does not mutate the lower-level fragments when constructing a level-*k* apex. The supersedes machinery in `publish()` does not delete the prior descriptor; it adds a `cg:supersedes` link. Capability passport's `recordLifeEvent` appends; it never overwrites ([`src/passport/index.ts`](../src/passport/index.ts) lines 73-79).

### Invariant 3 — Restriction / extension adjunction

For every hyperedge `h` and sub-hyperedge `h' ⊆ h`, restriction `F(h) → F(h')` and extension `F(h') → F(h)` are adjoint. This is the Janus property in mathematical form.

In code: descriptor composition operators (`union`, `intersection`, `restriction`, `override` in [`src/model/derivation.ts`](../src/model/derivation.ts)) form a bounded lattice — the bounded-lattice laws (`verifyBoundedLattice` in `src/index.ts`) are precisely the adjunction laws on the underlying presheaf. The protocol-level test for these laws lives in [`tests/`](../tests/).

### Invariant 4 — Hyperedge composition as colimit

When two hyperedges share a constituent, their composition is the pushout (colimit of the span). This is what makes substructure sharing automatic: no detection algorithm, no canonicalization step.

In code: PGSL pullback construction is the dual operation; descriptor composition by `restriction` is a limit; cross-pod federation merges manifest entries via IRI-equality (`parseManifest` in [`src/solid/client.ts`](../src/solid/client.ts) lines 207-308) which is colimit-on-IRI. The protocol's "no algorithm to detect sharing — it falls out of GUID identity" property is this invariant in operation.

## 6. The Peircean correspondence

Peirce's universal categories — Firstness (qualitative immediacy), Secondness (brute reaction / dyadic existence), Thirdness (mediation / triadic relation) — map onto the substrate's three operational concerns:

| Peircean category | Interego construct |
|---|---|
| **Firstness** — pure qualitative content, possibility, the suchness of a representation | The bytes returned by `GET <iri>` — a Turtle string, a JOSE envelope, an audio rendering. The representation is Firstness; the sign-vehicle. |
| **Secondness** — the dyadic act, the brute fact of *this particular* reference being resolved *now* | The dereference act itself: HTTP GET against an IRI, the cryptographic signature verification, the WebSocket event delivery. The fact-of-resolution is Secondness. |
| **Thirdness** — the triadic mediating relation, the law that brings sign and object into a determinate interpretive relation | The link relation: `cg:supersedes`, `hydra:expects`, `prov:wasDerivedFrom`, `cg:affordance / cg:action`. Each triad of (sign-vehicle, target, relation-type) is a Peircean Third. |

The SAT ontology ([`docs/ns/sat.ttl`](ns/sat.ttl)) makes this explicit: `sat:SemioticFieldFunctor owl:equivalentClass cg:SemioticFacet`. The Semiotic facet on every descriptor is the Peircean field functor on the corresponding semiotic topos. This is not analogy; it is an `owl:equivalentClass` declaration with operational meaning.

**Why this matters.** Dyadic graph models (subject-predicate-object as three separate edges) cannot represent Thirdness without reification. Hypergraphs do — a single 3-ary hyperedge over (sign, object, interpretant) is the natural home. Interego's `cgh:Affordance` is exactly this shape: one hyperedge whose members are the action IRI (sign), the target resource (object), and the typed inputs that mediate invocation (interpretant). Hydra controls *are* Thirdness made operational; following an affordance link enacts the triadic mediation by literal HTTP request.

## 7. CTS as the tuple-store realization

The Compositional Tuple Store ([`docs/ns/cts.ttl`](ns/cts.ttl)) is the operational form of the polygranular structure. `cts:Pattern owl:equivalentClass cg:SyntagmaticPattern` declares that the substrate's syntagmatic-paradigmatic axis is Saussurean / structural-linguistic in nature.

A CTS schema with explicit n-gram sharing would have at minimum:

```
char(c)                          -- atomic character holons
ngram(id, sequence)              -- n-gram types, deduplicated by content
occurs_in(ngram, token, offset)  -- occurrence morphisms
```

This is *constructible* from existing primitives but not currently pre-built as a CTS table layout. A future revision adding it would make sub-token compositional reuse a turnkey query rather than a derivation.

## 8. What this gives us in practice

- **Cross-pod federation reduces to link-traversal.** No data movement; the substructure-sharing relation is the graph topology itself.
- **Substructure sharing is free at every level.** Two pods minting the same content produce the same IRI; the meet operator is set intersection; agreement is structural rather than negotiated (Demo 06).
- **Belief revision is a primitive.** `cg:supersedes` chains are composable and temporally ordered; the head of a chain is the "current" view; older heads remain on the pod as audit trail (Demo 05).
- **Compliance audits compose.** Every regulatory framework with an L3 mapping queries the same descriptors with its own vocabulary; a single pod presents three different audit-ready views (Demo 11).
- **Self-amending governance is constructible.** Constitutional amendments are typed descriptors; ratification is a deterministic function of the vote set; the regime emerging from votes shapes future agent behavior through the same dereferencing chain that delivered the regime (Demo 17).

## 9. Constructions that were previously gestured at and are now exposed explicitly

The first revision of this document listed four constructions the substrate supported implicitly. Each has since been added to either the spec or the ontology:

1. **Double-category formalism.** Documented at [`spec/architecture.md`](../spec/architecture.md) §3.3.1 ("Two directions of composition"). Names the two directions (horizontal = intra-level, vertical = granularity shift), the operadic shape of each, and the coherence law (H-then-V = V-then-H up to natural iso). Cross-references this document for the full categorical account.
2. **Per-occurrence position holons** as Hydra-controlled typed resources. Added to [`docs/ns/cts.ttl`](ns/cts.ttl): `cts:Position` is now promotable to a first-class resource carrying `cts:next` / `cts:previous` link relations and a `cts:withinTuple` parent-pointer. A worked example in the ontology shows the token `mark` decomposed into four `cts:Position` resources; an affordance-walking agent can traverse positions via Hydra controls instead of numerical indexing.
3. **N-gram sharing as a CTS construction.** Added to [`docs/ns/cts.ttl`](ns/cts.ttl) as `cts:CharacterAtom` / `cts:NGram` / `cts:Occurrence` with `cts:ngram` / `cts:within` / `cts:offset` / `cts:length` properties. The worked example demonstrates that the bigram `ma` shared between `mark` and `human` is one IRI with two `cts:Occurrence` morphisms; a SPARQL join through `cts:Occurrence` returns shared-substructure tokens for free, with no canonicalization step. This is the BPE-as-colimit construction made explicit in the ontology.
4. **Holonic hypergraphic interpretation as a documented term.** Added as [`spec/architecture.md`](../spec/architecture.md) §1.3 "Holonic Hypergraphic Structure" — the framing is canonical at the spec level, with this document referenced as the rigorous formal account.

Items 2 and 3 are ontology declarations; runtime adoption (a SPARQL pattern library, a code generator that emits `cts:Position` resources for any tuple, a CTS-aware indexer) is the natural next-build candidate but isn't required for the protocol's expressivity — the new terms are constructions on existing primitives, validated by being expressible in pure RDF.

## 10. Related work

The construction draws on (without depending on):

- **Koestler, *The Ghost in the Machine* (1967)** — the original holarchy framing. Interego replaces the tree with a hypergraph.
- **Peirce, *Collected Papers* §1.328-§1.353** — the universal categories. Realized operationally via the SAT ontology.
- **Grothendieck, SGA** — fibrations, presheaves, sites. The mathematical language for the polygranular structure.
- **Mac Lane & Moerdijk, *Sheaves in Geometry and Logic*** — sheaves on a site as the formal home of distributed-but-coherent local data. HELA's `ℰ = Set^(𝒞_xAPI^op)` is in this tradition.
- **Saussure, *Cours de linguistique générale*** — syntagmatic vs paradigmatic axes. Realized operationally via CTS (`cts:Pattern owl:equivalentClass cg:SyntagmaticPattern`).
- **Fielding, REST dissertation §5** — HATEOAS as the constraint that makes hypermedia work as application state. Interego applies the same constraint to cognition: composition is link-traversal, not parse-of-content.

---

## Appendix — file-path index

The constructions named in this document live at these paths:

| Concept | File |
|---|---|
| Atom minting (content-addressed identity) | [`src/pgsl/lattice.ts`](../src/pgsl/lattice.ts) `mintAtom`, `mintEncryptedAtom`, `resolveAtomValue` |
| Pullback square (categorical pullback at level k) | [`src/pgsl/category.ts`](../src/pgsl/category.ts) `pullbackSquare` |
| Composition operators (union/intersection/restriction/override) | [`src/model/derivation.ts`](../src/model/derivation.ts) |
| Bounded-lattice + adjunction laws as runtime checks | [`src/index.ts`](../src/index.ts) `verifyBoundedLattice`, `verifyAdjunction` |
| Publish + manifest CAS (link-by-IRI; hypermedia distribution) | [`src/solid/client.ts`](../src/solid/client.ts) `publish`, `discover` |
| Cross-pod sharing (federated colimit) | [`src/solid/sharing.ts`](../src/solid/sharing.ts) `resolveRecipients` |
| Capability passport (identity portability) | [`src/passport/index.ts`](../src/passport/index.ts) |
| Constitutional layer (regime-as-emergent-structure) | [`src/constitutional/index.ts`](../src/constitutional/index.ts) |
| HELA ontology (topos declaration) | [`docs/ns/hela.ttl`](ns/hela.ttl) |
| SAT ontology (Peircean correspondence) | [`docs/ns/sat.ttl`](ns/sat.ttl) |
| CTS ontology (syntagmatic-paradigmatic structure) | [`docs/ns/cts.ttl`](ns/cts.ttl) |

The demos ([`demos/scenarios/`](../demos/scenarios/)) realize each invariant operationally; in particular Demos 05 (modal status + supersedes), 06 (PGSL pullback / atom-layer meet), 07 (CAS-safe parallel writes / colimit on the manifest), 09 (cryptographic citation chain), 10 (passport portability), 11 (multi-lens composition), 16 (emergent selection), 17 (regime change with upward + downward causation) each exercise specific invariants from §5 and specific layers of the construction in §3 and §4.
