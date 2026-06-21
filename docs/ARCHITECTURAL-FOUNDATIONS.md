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
- **Peircean correspondence** is encoded in the `sat:` ontology and made operational by `ieh:Affordance`: representation = Firstness, dereference act = Secondness, link relation (Hydra control) = Thirdness. ([§6](#6-the-peircean-correspondence))
- **Fifth named loop** — agents propose typed affordances → others attest → promoted set is ratified as a versioned `ieh:Protocol` → an agent assembles a `ieh:WorkflowApp` composing the protocol → consumer agents discover + operate the app under typed `ieh:protocolConformance`. The substrate bootstraps its own application surface from agent activity alone. ([§10](#10-the-fifth-named-loop--socio-construction-of-an-emergent-protocol-and-app))

The rest of the document spells out each correspondence and points at the file paths where the construction is realized in code or ontology.

---

## 1. The thesis: GUIDs are the holons, content is a representation

A character `m`, the bigram `ma`, the token `mark`, the triple `(mark, isa, human)`, a SCORM lesson, a constitutional amendment, a vertical's affordance manifest — these are not strings or tuples. They are **dereferenceable identities**:

```
urn:pgsl:atom:<sha256-of-content>
https://pod.example/me/context-graphs/<descriptor-slug>.ttl
urn:iep:amendment:<id>
urn:iep:tool:<name>:<hash>
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

- A `iep:ContextDescriptor` with multiple facets (Temporal / Provenance / Agent / AccessControl / Semiotic / Trust / Federation) is a typed n-ary hyperedge. Each facet is a constituent; the descriptor is the whole. (Demo 11 demonstrates this — three regulators query the same descriptor with three different framework lenses.)
- A `iep:Person` descriptor on an org pod can simultaneously be a participant in an `owm:Project` hyperedge, a voter in a `iep:Constitutional` amendment, and an attestor in an `amta:` chain — without rewriting the person's identity. The same holon, three hyperedge memberships.
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

**Sheaf condition** is the demand that local data on a covering family glue to global data on the cover. In Interego, this is what makes `iep:supersedes` chains coherent: descriptors on different parts of the manifest combine into a consistent picture of belief without contradiction. The cleartext mirror in `normalizePublishInputs` ([`src/model/publish-preprocess.ts`](../src/model/publish-preprocess.ts)) is what makes the sheaf condition computable across encrypted graphs.

## 5. The four invariants

The architecture obeys four laws. Each is realized by specific code paths.

### Invariant 1 — Identity by reference

Every holon is a dereferenceable IRI. Equality of holons is IRI equality, never structural equality of representations. Operational realizations:

- `mintAtom(pgsl, value)` derives the atom IRI from `sha256(value)` ([`src/pgsl/lattice.ts`](../src/pgsl/lattice.ts)).
- `publish()` writes descriptor metadata at one URL and graph payload at a separate URL; clients follow the `iep:affordance` link, never reconstruct URLs by convention ([`src/solid/client.ts`](../src/solid/client.ts) lines 386-490).
- Cross-pod sharing (`share_with`) resolves recipients by IRI; the envelope's wrapped-key lookup is by IRI-derived public key ([`src/solid/sharing.ts`](../src/solid/sharing.ts)).

### Invariant 2 — Level-shift functoriality

The promotion functor γ: H_n → H_{n+1} preserves structural invariants. A holon promoted to a higher level retains its identity; its old hyperedge memberships at the lower level remain valid; its new memberships at the higher level extend rather than replace.

In code: PGSL's `pullbackSquare` does not mutate the lower-level fragments when constructing a level-*k* apex. The supersedes machinery in `publish()` does not delete the prior descriptor; it adds a `iep:supersedes` link. Capability passport's `recordLifeEvent` appends; it never overwrites ([`src/passport/index.ts`](../src/passport/index.ts) lines 73-79).

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
| **Thirdness** — the triadic mediating relation, the law that brings sign and object into a determinate interpretive relation | The link relation: `iep:supersedes`, `hydra:expects`, `prov:wasDerivedFrom`, `iep:affordance / iep:action`. Each triad of (sign-vehicle, target, relation-type) is a Peircean Third. |

The SAT ontology ([`docs/ns/sat.ttl`](ns/sat.ttl)) makes this explicit: `sat:SemioticFieldFunctor owl:equivalentClass iep:SemioticFacet`. The Semiotic facet on every descriptor is the Peircean field functor on the corresponding semiotic topos. This is not analogy; it is an `owl:equivalentClass` declaration with operational meaning.

**Why this matters.** Dyadic graph models (subject-predicate-object as three separate edges) cannot represent Thirdness without reification. Hypergraphs do — a single 3-ary hyperedge over (sign, object, interpretant) is the natural home. Interego's `ieh:Affordance` is exactly this shape: one hyperedge whose members are the action IRI (sign), the target resource (object), and the typed inputs that mediate invocation (interpretant). Hydra controls *are* Thirdness made operational; following an affordance link enacts the triadic mediation by literal HTTP request.

## 7. CTS as the tuple-store realization

The Compositional Tuple Store ([`docs/ns/cts.ttl`](ns/cts.ttl)) is the operational form of the polygranular structure. `cts:Pattern owl:equivalentClass iep:SyntagmaticPattern` declares that the substrate's syntagmatic-paradigmatic axis is Saussurean / structural-linguistic in nature.

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
- **Belief revision is a primitive.** `iep:supersedes` chains are composable and temporally ordered; the head of a chain is the "current" view; older heads remain on the pod as audit trail (Demo 05).
- **Compliance audits compose.** Every regulatory framework with an L3 mapping queries the same descriptors with its own vocabulary; a single pod presents three different audit-ready views (Demo 11).
- **Self-amending governance is constructible.** Constitutional amendments are typed descriptors; ratification is a deterministic function of the vote set; the regime emerging from votes shapes future agent behavior through the same dereferencing chain that delivered the regime (Demo 17).

## 9. Constructions that were previously gestured at and are now exposed explicitly

The first revision of this document listed four constructions the substrate supported implicitly. Each has since been added to either the spec or the ontology:

1. **Double-category formalism.** Documented at [`spec/architecture.md`](../spec/architecture.md) §3.3.1 ("Two directions of composition"). Names the two directions (horizontal = intra-level, vertical = granularity shift), the operadic shape of each, and the coherence law (H-then-V = V-then-H up to natural iso). Cross-references this document for the full categorical account.
2. **Per-occurrence position holons** as Hydra-controlled typed resources. Added to [`docs/ns/cts.ttl`](ns/cts.ttl): `cts:Position` is now promotable to a first-class resource carrying `cts:next` / `cts:previous` link relations and a `cts:withinTuple` parent-pointer. A worked example in the ontology shows the token `mark` decomposed into four `cts:Position` resources; an affordance-walking agent can traverse positions via Hydra controls instead of numerical indexing.
3. **N-gram sharing as a CTS construction.** Added to [`docs/ns/cts.ttl`](ns/cts.ttl) as `cts:CharacterAtom` / `cts:NGram` / `cts:Occurrence` with `cts:ngram` / `cts:within` / `cts:offset` / `cts:length` properties. The worked example demonstrates that the bigram `ma` shared between `mark` and `human` is one IRI with two `cts:Occurrence` morphisms; a SPARQL join through `cts:Occurrence` returns shared-substructure tokens for free, with no canonicalization step. This is the BPE-as-colimit construction made explicit in the ontology.
4. **Holonic hypergraphic interpretation as a documented term.** Added as [`spec/architecture.md`](../spec/architecture.md) §1.3 "Holonic Hypergraphic Structure" — the framing is canonical at the spec level, with this document referenced as the rigorous formal account.

Items 2 and 3 are ontology declarations; runtime adoption (a SPARQL pattern library, a code generator that emits `cts:Position` resources for any tuple, a CTS-aware indexer) is the natural next-build candidate but isn't required for the protocol's expressivity — the new terms are constructions on existing primitives, validated by being expressible in pure RDF.

## 10. The fifth named loop — socio-construction of an emergent protocol-and-app

The four invariants in §5 govern static structure: identity-by-reference, level-shift functoriality, restriction/extension adjunction, hyperedge composition as colimit. They describe what the substrate IS at any moment. There is a fifth pattern that governs how the substrate's *application surface* itself comes into being — a self-bootstrapping loop in which agents propose, attest, ratify, compose, and operate, with each layer recovering the previous from the same pod.

**Phase A — Proposal.** Agents publish typed `iep:Affordance` descriptors that name new actions: action IRI, `hydra:expects` typed inputs, `rdfs:comment` describing intent. Modal status: Hypothetical. The substrate accepts arbitrary affordance descriptors via the standard publish flow; nothing in the protocol distinguishes a proposed affordance from any other Hypothetical claim.

**Phase B — Cross-attestation.** Other agents attest the proposed affordances via `amta:` axes. Aggregate trust scores emerge from arithmetic on the per-attestation ratings, exactly as Demo 16 demonstrates for tools.

**Phase C — Promotion.** Affordances meeting structural thresholds (≥N peer attestations across ≥M axes, aggregate score ≥T) are promoted Hypothetical → Asserted via `iep:supersedes`. The "protocol" at any given moment is *the set of currently-Asserted `iep:Affordance` descriptors on the shared pod*.

**Phase D — Constitutional binding.** A constitutional amendment ratifies the protocol as a versioned `ieh:Protocol` descriptor (added in `docs/ns/harness.ttl`). The protocol bundles the promoted affordances via `ieh:bundlesAffordance`. A `ieh:PromotionConstraint` may further restrict what counts as a valid future addition — substrate-enforced governance for the protocol's ongoing evolution (Demo 19's pattern).

**Phase E — App composition.** A `ieh:WorkflowApp` descriptor composes affordances from the protocol via `ieh:composes`, in calling order, with a human-readable `ieh:appNarrative`. The app pins its `ieh:protocolConformance` to a specific protocol version IRI — the audit-trail integrity guarantee that lets a future reviewer answer "was this app's behavior consistent with the protocol that was in force when it ran?"

**Phase F — Operation under governance.** A consumer agent — different process, no shared memory — discovers the app via standard `discover_descriptors`, dereferences it, walks the composed affordances, and operates each. Operations conform to the affordance shapes; the constitutional layer can refuse promotions or operations that violate active constraints.

**Loop closure.** Operations produce new observations. Cross-attestations shift trust scores. New amendments propose protocol revisions. The protocol updates via `iep:supersedes`. The same app URL renders different behavior because the affordances it composes have evolved underneath — but `ieh:protocolConformance` pins what the app was authored against, so audit remains coherent across versions.

**Demo 20** ([`scenarios/20-socio-constructed-protocol-and-app.ts`](../demos/scenarios/20-socio-constructed-protocol-and-app.ts)) traverses the full loop with eight claude processes plus harness aggregation. It is the most architecturally load-bearing demonstration in the suite, because it shows the substrate doing what no individual demo previously did: bootstrapping its own application surface from agent activity, with governance derived from the constitutional layer over the same artifacts.

**Why this is a distinct loop, not a special case of §5.** The four invariants of §5 are *intra-substrate* — they hold for any sequence of operations on the existing primitives. The fifth loop is *constitutive* — it shows that the substrate's primitive set is itself reachable as an emergent property of agent activity, given a small generative seed (the publish + discover + attest + supersedes operations). The protocol is not a fixed point above the operations; it is the head of a supersedes chain over `ieh:Protocol` descriptors that the operations themselves produce. The loop closes back through itself.

This is the operational answer to the deepest question the substrate raises: *can a community of agents construct, ratify, and live under their own protocol-and-app stack without any external coordinator?* On the evidence of Demo 20, yes. The substrate is sufficient.

## 11. The kernel module — primitives as a first-class API

§3–§5 give the categorical structure: PGSL as a Grothendieck fibration over the level chain, HELA as a topos with composition as colimit, restriction and extension as an adjunction, and the four invariants that hold across the lot. Those constructions are realized in code today (the appendix file-path index lists where), but they are spread across the substrate modules and intermingled with verticals' particular compositions of them.

[`src/kernel/`](../src/kernel/) is the operational realization of §3–§5 as a single coherent surface — the eight verbs every higher-layer operation is built from:

| Verb | Categorical role | Delegates to |
|---|---|---|
| `mint(content)` | Identity-by-reference (Invariant 1) | `mintAtom` / content-addressed hashing |
| `dereference(iri)` | Peircean Secondness — brute resolution | `fetchGraphContent`, `parseManifest`, affordance extraction |
| `compose(holons, op)` | Operadic composition over typed-hyperedge category (the four operators) | `union` / `intersection` / `restriction` / `override` in `src/model/composition.ts` |
| `act(affordance, payload)` | Peircean Thirdness made operational | `followAffordance` in `src/solid/affordance.ts` |
| `restrict(holon, sub)` | Restriction half of the adjunction (Invariant 3) | `restriction` |
| `extend(part, whole)` | Extension half of the adjunction | `union` + witness-preserving `iep:supersedes` back-link |
| `promote(atoms[])` | PGSL fibration vertical movement (level k → k+1) | `ingest` + `pullbackSquare` |
| `decompose(fragment)` | PGSL fibration vertical movement (level k → k-1) | `pullbackSquare` |

The kernel introduces **no new ontology terms** and **no new persistence**. It is code-level surface that names what the substrate already does. Three properties matter:

1. **Categorical structure made visible.** Reading `mint` / `dereference` / `compose` / `act` next to each other recovers the §3 fibration + §5 invariants as one picture, instead of as a list of file paths a reader has to triangulate.
2. **Non-leaky abstraction.** Verticals (foxxi, lpc, adp, ...) and higher-layer operations (publish_context, register_agent, ...) compose the kernel verbs; they no longer reach past it into the substrate's interior. This is what the user-facing principle — "Interego = primitives + composition mechanics for emergence, not a fixed feature set" — looks like in code.
3. **MCP surface re-expressed in kernel terms.** The 27 named MCP tools (publish_context / discover_context / register_agent / pgsl_* / invoke_affordance / ...) are exposed as **compatibility shims** with their descriptions prefixed `Compatibility shim — internally composes kernel(...)`. The wire format of every existing tool is unchanged so existing connectors keep working. The kernel verbs are exposed as additional first-class MCP tools (`mint`, `dereference`, `compose`, `act`, `restrict`, `extend`, `promote`, `decompose`) so new clients can call the substrate directly.

The kernel does not replace the higher-layer surface — it is the surface those layers compose. A vertical that wants pod-grounded action publishes a `iep:Affordance` block; a consumer reaches it by `dereference(podManifest) → find entry → dereference(entry.descriptorUrl) → act(affordance, payload)`. The route through the kernel is the substrate's natural HATEOAS shape (§6), made executable.

## 12. The substrate-vs-vertical line — package layout

The principle that motivates the kernel surface (§11) also draws a
visible line through the source tree. Interego = primitives +
composition mechanics for emergence. Anything that CAN be composed
from the substrate primitives is itself a particular composition, not
substrate. The repo realizes that distinction as a package split.

What stays in `@interego/core`:

| Stays in core | Why |
|---|---|
| `model/` | The typed Context Descriptor + the 7 facets + the composition algebra (HELA's typed-hyperedge category + the 4 limit/colimit operators). This is the substrate's SHAPE. |
| `kernel/` | The 8 categorical verbs (mint / dereference / compose / act / restrict / extend / promote / decompose). This is the substrate's API. |
| `affordance/` shape + runtime | The `iep:Affordance` pattern made operational (Peircean Thirdness). The shape is substrate. The runtime that *computes* per-agent affordance sets (OODA + BDI + Active Inference) currently ships from core too; its planned destination is `@interego/affordance-engine`. |
| `rdf/` | Turtle / TriG / JSON-LD serialization + RDF 1.2 helpers + the TriG subject-extraction parser. The substrate's wire format. |
| `validation/` | Shape conformance / SHACL primitives — substrate algebra over the descriptor model. |
| `sparql/` | SPARQL pattern builders — standards-compliant substrate query layer. |
| `crypto/` primitives | Abstract signing/verification + ZK primitives. The concrete ethers/nacl-backed wallet impls ship here for now; a follow-up `@interego/crypto-impls` split is planned once the abstract surface stabilizes. |
| `naming/` | Naming conventions (URN minting + L2 attestation-based naming). |
| `solid/`, `pgsl/` | Currently still inside core. The kernel composes against both, and `rdf/system-ontology` + `rdf/virtualized-layer` back-reference PGSL. Splitting these into `@interego/solid` and `@interego/pgsl` requires lifting those back-references through dependency-injection points; the split is on the roadmap. |

What's a vertical now lives in its own package:

| Package | What it composes |
|---|---|
| `@interego/abac` | Attribute-Based Access Control over substrate descriptors |
| `@interego/compliance` | EU AI Act / NIST RMF / SOC 2 framework reports + ECDSA-signed lineage walks |
| `@interego/connectors` | Notion / Slack / Web source connectors (composes `@interego/extractors`) |
| `@interego/constitutional` | Self-amending policies via substrate modal algebra |
| `@interego/extractors` | Multi-format content extractors (PDF / JSON / CSV / HTML / plain text) |
| `@interego/ops` | SOC 2 operational evidence event builders (uses `@interego/compliance`) |
| `@interego/p2p` | Nostr-style relay-mediated federation (dual ECDSA + Schnorr signing) |
| `@interego/passport` | Capability-passport biography over substrate descriptors |
| `@interego/privacy` | Pre-publish sensitivity screening (no substrate coupling) |
| `@interego/registry` | Public agent attestation registry (federated reputation) |
| `@interego/security-txt` | RFC 9116 security.txt body builder shared by every service |
| `@interego/skills` | agentskills.io ↔ iep:Affordance bidirectional translator |
| `@interego/transactions` | Federated saga-style transactions over substrate descriptors |

Three properties matter:

1. **The substrate stays minimal.** Every vertical is now visible as a
   particular composition of substrate primitives, in its own package
   with its own `package.json`. The principle ("don't hardcode what
   can be composed") is enforced at the boundary, not just intended.
2. **The kernel verbs work the same.** Wire-level behavior of every
   MCP tool, relay HTTP endpoint, and substrate function is unchanged.
   The package split is purely structural — imports change, behavior
   doesn't. Every consumer imports vertical symbols directly from the
   per-vertical `@interego/<name>` package that owns them; there is no
   compat shim in `@interego/core`.
3. **The line is now contestable.** When a new feature gets proposed,
   the question is no longer "where does it go in `src/`?" but "is it
   substrate or is it a composition?" — and if it's a composition, it
   becomes a new `@interego/<name>` package. Substrate-vs-vertical is
   the actual boundary, not informal labeling inside one source tree.

The workspace is realized via npm workspaces. The root `package.json`
declares `packages/*`, `mcp-server`, every `deploy/*` service, and
every `applications/*/bridge` as workspaces. Cross-package deps use
the npm-classic `*` selector so iteration is local; nothing is
published until the architectural line is independently stabilized.

## 13. Related work

The construction draws on (without depending on):

- **Koestler, *The Ghost in the Machine* (1967)** — the original holarchy framing. Interego replaces the tree with a hypergraph.
- **Peirce, *Collected Papers* §1.328-§1.353** — the universal categories. Realized operationally via the SAT ontology.
- **Grothendieck, SGA** — fibrations, presheaves, sites. The mathematical language for the polygranular structure.
- **Mac Lane & Moerdijk, *Sheaves in Geometry and Logic*** — sheaves on a site as the formal home of distributed-but-coherent local data. HELA's `ℰ = Set^(𝒞_xAPI^op)` is in this tradition.
- **Saussure, *Cours de linguistique générale*** — syntagmatic vs paradigmatic axes. Realized operationally via CTS (`cts:Pattern owl:equivalentClass iep:SyntagmaticPattern`).
- **Fielding, REST dissertation §5** — HATEOAS as the constraint that makes hypermedia work as application state. Interego applies the same constraint to cognition: composition is link-traversal, not parse-of-content.

---

## Appendix — file-path index

The constructions named in this document live at these paths:

| Concept | File |
|---|---|
| Kernel module (the eight categorical verbs as one surface) | [`src/kernel/`](../src/kernel/) `mint`, `dereference`, `compose`, `act`, `restrict`, `extend`, `promote`, `decompose` |
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
