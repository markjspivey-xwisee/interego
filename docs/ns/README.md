# Interego — Ontology Reference

This directory contains the **canonical, versioned, hand-authored OWL/RDFS/SHACL ontologies** that define the Interego 1.0 system.

**Namespace root:** `https://markjspivey-xwisee.github.io/interego/ns/`

## Layer classification (see [`../../spec/LAYERS.md`](../../spec/LAYERS.md))

Not every ontology here has the same normative weight. They sit on three distinct layers of the protocol stack; treating them identically is the drift that layer discipline exists to prevent.

| Layer | Meaning for ontologies in this directory |
|---|---|
| **Layer 1 — Core protocol** | Normative. Terms MUST NOT carry domain-specific semantics. Changes require a protocol version bump and conformance-suite update. |
| **Layer 2 — Federation pattern** | Informative pattern ontologies that describe how Interego composes with federated data-product architectures. Useful; not required for protocol conformance. |
| **Layer 3 — Adjacent framework** | Domain-adjacent or cross-framework ontologies that happen to live alongside the protocol in this repository for convenience. They MAY be spun out to separate repositories with separate governance. |

Every namespace below is tagged with its current layer. The transplant test (§2 of [`LAYERS.md`](../../spec/LAYERS.md)) is the discriminator: if an ontology's terms only make sense in a specific domain or stack, it belongs in Layer 3, not Layer 1.

## Nineteen ontologies, nineteen prefixes

Interego is a five-core-layer system (substrate → typed context → interrogatives → agent harness → cross-layer alignment) plus five Layer-2 federation pattern ontologies plus eight Layer-3 adjacent / domain / regulatory mapping ontologies that model how Interego composes with the wider world.

### Core layers (Layer 1 — Protocol, normative)

These ontologies define terms that conforming implementations MUST honor. Terms here MUST NOT encode domain-specific meaning; domain semantics belong in a Layer 3 ontology with its own namespace.

| File | Prefix | Kind | Terms | What it defines |
|---|---|---|---|---|
| [`pgsl.ttl`](pgsl.ttl) | `pgsl:` | OWL | 35 | **Substrate.** Poly-Granular Sequence Lattice — atoms, fragments, pullback squares, transitive containment, SHACL shapes (Atom, Fragment, PullbackSquare, ConstituentIntegrity, LevelConsistency, OverlapValidity, Acyclicity, Canonicality). |
| [`cg.ttl`](cg.ttl) | `cg:` | OWL | 284 | **Typed-context.** ContextDescriptor with seven facet types + Causal + Projection, composition operators, federation, data products (cg:DataProduct), affordances (cg:Affordance + individuals canPublish/canDiscover/canSubscribe/canFetchPayload/canDecrypt), encryption classes (EncryptedGraphEnvelope, EncryptedValue, GraphPayload), auth-methods (AuthMethods, WebAuthnCredential, DIDKey, EthereumWallet), coherence (CoherenceCertificate + enum Equal/Divergent/Subset/Intersect/Union/Exclude), paradigm / persistence / causal / pod-catalog / session-log types. |
| [`interego.ttl`](interego.ttl) | `ie:` | OWL | 34 | **Interrogatives.** User-facing grammar of eleven canonical interrogatives (Who/What/Where/When/Why/How/Which/WhatKind/HowMuch/Whose/Whether) with typed cross-layer mapping. |
| [`harness.ttl`](harness.ttl) | `cgh:` | OWL | 138 | **Agent harness.** Abstract Agent Types (AAT), ODRL policy engine, PROV traces, runtime evaluation with confidence scoring, decision functor, affordance decorators. `cgh:Affordance rdfs:subClassOf hydra:Operation`. |
| [`alignment.ttl`](alignment.ttl) | `align:` | OWL | 22 | **Cross-layer glue.** Equivalences, SKOS matches, and W3C vocabulary alignments (Hydra, ODRL, ACL, VC 2.0, DCAT, DPROD, OWL-Time) across all nineteen namespaces. |

### Federation mesh ontologies (Layer 2 — Architecture, informative)

Applicability-note ontologies describing patterns that implementations tend to adopt but which the protocol does not mandate. A conformant implementation MAY use different federation shapes and still satisfy Layer 1.

| File | Prefix | Terms | What it defines |
|---|---|---|---|
| [`hyprcat.ttl`](hyprcat.ttl) | `hyprcat:` | 18 | **Federated data-product catalog.** Decorates DCAT + DPROD with distributed identity, affordance-bearing distributions, and the three-world federation boundary (UserWorld / AgentWorld / ServiceWorld). `hyprcat:FederatedDistribution` is simultaneously `dcat:Distribution`, `cg:Affordance`, `cgh:Affordance`, and `hydra:Operation`. |
| [`hypragent.ttl`](hypragent.ttl) | `hypragent:` | 18 | **Agent machinery for HyprCat.** Cross-world delegation via W3C Verifiable Credentials chains, capability typing (canDecryptEnvelope, canPublishContext, canVerifyDelegation, canSubscribe), dispatch-time policy evaluation. `hypragent:Agent` is simultaneously `prov:SoftwareAgent`, `cg:AuthorizedAgent`, and `cgh:Agent`. |
| [`abac.ttl`](abac.ttl) | `abac:` | 16 | **Attribute-based access control.** `abac:Policy` as a typed context descriptor with SHACL predicates; `abac:Evaluator`, `abac:AttributeResolver`, `abac:DecisionCache`, `abac:PolicyContext`, `abac:EvaluationRecord`. Reference runtime in [`src/abac/`](../../src/abac/). |
| [`registry.ttl`](registry.ttl) | `registry:` | 17 | **Public agent attestation registry.** Federated NPM-for-AI-agents primitive: multiple registries co-exist, reputation aggregates cross-registry. Reference runtime in [`src/registry/`](../../src/registry/). |
| [`passport.ttl`](passport.ttl) | `passport:` | 15 | **Capability passport.** Persistent agent biographical identity that survives infrastructure migration (framework / pod / model changes) — life events, demonstrated values. Reference runtime in [`src/passport/`](../../src/passport/). |

### Adjacent-framework ontologies (Layer 3 — Domain-adjacent, non-normative)

These ontologies live here for convenience while the project is early, but they are conceptually independent of the core protocol. Each one could be spun out to a separate repository with its own governance without affecting conformance to Interego 1.0. None of these are required for protocol conformance; any of them MAY be omitted by an implementation that does not target the domain.

**When to write a new ontology under this section rather than extending a core layer:** if the claim the ontology expresses would not transplant into a different domain with the same semantics (medical research, coding agents, finance, organizational learning), it belongs here, not in `cg:`/`cgh:`/`pgsl:`/`ie:`/`align:`.

| File | Prefix | Terms | What it defines |
|---|---|---|---|
| [`hela.ttl`](hela.ttl) | `hela:` | 7 | **Topos-theoretic xAPI.** Statements as a presheaf category ℰ = Set^(𝒞_xAPI^op). Statement / Actor / Verb / LearningObject / Trace / SubobjectClassifier. Aligned with `cg:ProvenanceFacet`. |
| [`sat.ttl`](sat.ttl) | `sat:` | 10 | **Semiotic Agent Topos.** Semiotic Field Functor Σ : Situations → SemioticFields. `sat:SemioticFieldFunctor owl:equivalentClass cg:SemioticFacet`. |
| [`cts.ttl`](cts.ttl) | `cts:` | 11 | **Compositional Tuple Store.** Usage-based linguistic substrate — meaning is usage, structure emerges from usage. `cts:Pattern owl:equivalentClass cg:SyntagmaticPattern`. |
| [`olke.ttl`](olke.ttl) | `olke:` | 11 | **Organizational Learning & Knowledge Evolution.** Four-stage ladder Tacit → Articulate → Collective → Institutional; annotates `cg:ContextDescriptor` with current stage. |
| [`amta.ttl`](amta.ttl) | `amta:` | 14 | **Agent-Mediated Trust Attestation.** Multi-axis trust (competence / honesty / relevance / recency). `amta:Attestation rdfs:subClassOf cg:TrustFacet`. |
| [`code.ttl`](code.ttl) | `code:` | 35 | **Source-code domain.** Repository, Commit, Branch, PullRequest, Review, Defect, TestRun, BuildResult. Commits are `pgsl:Fragment`; branches are `cg:ParadigmSet`; reviews `cg:constructedFrom (cg:SemioticFacet cg:ProvenanceFacet)`. First L3 domain example. |
| [`eu-ai-act.ttl`](eu-ai-act.ttl) | `eu-ai-act:` | 17 | **EU AI Act mapping.** Articles 6, 9, 10, 12, 13, 14, 15, 50. Lets compliance teams query an Interego pod using the regulation's own vocabulary. |
| [`nist-rmf.ttl`](nist-rmf.ttl) | `nist-rmf:` | 20 | **NIST AI Risk Management Framework.** Govern / Map / Measure / Manage four-function model. Used together with `compliance: true` publishes for L4 conformance. |
| [`soc2.ttl`](soc2.ttl) | `soc2:` | 63 | **AICPA SOC 2 Trust Services Criteria.** Common Criteria + Availability + Processing Integrity + Confidentiality + Privacy. Operational event subtypes (DeployEvent, AccessChangeEvent, KeyRotationEvent, IncidentEvent, QuarterlyReviewEvent) emitted by [`src/ops/`](../../src/ops/) — Interego eats its own dog food as the SOC 2 evidence substrate. |

### SHACL shape files

| File | Prefix | Kind |
|---|---|---|
| [`pgsl-shapes.ttl`](pgsl-shapes.ttl) | `pgsl:` | Shape file for PGSL invariants |
| [`interego-shapes.ttl`](interego-shapes.ttl) | `ie:` | Shape file for interrogative bindings |
| [`harness-shapes.ttl`](harness-shapes.ttl) | `cgh:` | Shape file for harness structures |

**Totals (2026-04-26):** 19 ontology files, 1 alignment file, 3 SHACL shape files (cg-shapes-1.2.ttl is a draft tracking the SHACL 1.2 CR). Term count by namespace — `cg:` 336, `cgh:` 138, `pgsl:` 35, `ie:` 34, `align:` 22, `hyprcat:` 18, `hypragent:` 18, `abac:` 16, `registry:` 17, `passport:` 15, `hela:` 9, `sat:` 12, `cts:` 13, `olke:` 12, `amta:` 14, `code:` 35, `eu-ai-act:` 17, `nist-rmf:` 20, `soc2:` 63. CI lint enforces every term used in TS code has a matching declaration here.

## Ontology-lint CI gate

Every push touching TypeScript source is checked by `tools/ontology-lint.mjs`, which scans code for `<prefix>:<Term>` emissions and verifies each term exists in the corresponding `docs/ns/<prefix>.ttl` file. Known-external prefixes (rdf, rdfs, xsd, owl, sh, skos, vann, dct, dcat, dprod, prov, time, foaf, vc, hydra, acl, solid, ldp, odrl, did, schema, oa, as) are exempt. See [`tools/ontology-lint.mjs`](../../tools/ontology-lint.mjs) and [`.github/workflows/ontology-lint.yml`](../../.github/workflows/ontology-lint.yml).

Any new code that emits `cg:NewType` without a matching declaration in `cg.ttl` **fails CI** — the forcing function that keeps the ontology in sync with runtime.

## Layering philosophy

The three layers are **independent but co-designed**:

```
┌─────────────────────────────────────────────────────────────────┐
│                         cgh: (harness)                          │
│    agents, policies, eval, decorators, PROV traces              │
│    — operates ON pgsl state, produces cg descriptors —          │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      cg: (context descriptors)                  │
│    typed metadata ABOUT named graphs                            │
│    — describes pgsl fragments + atoms —                         │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       pgsl: (substrate)                         │
│    content-addressed lattice of atoms + fragments               │
│    — aligned with PROV-O —                                      │
└─────────────────────────────────────────────────────────────────┘
```

**You can use each layer independently.** `pgsl.ttl` is a complete ontology for the lattice substrate with no dependency on `cg:` or `cgh:`. `context-graphs.ttl` describes typed metadata that can be applied to any Named Graph, with or without a PGSL substrate. `harness.ttl` models the agent framework and could wrap any RDF store, not just a PGSL one.

**When you want them to work together,** import [`alignment.ttl`](alignment.ttl). It imports all three layer ontologies and adds the cross-layer axioms, SKOS matches, and named integration patterns that tie them into a single coherent system.

## Design principles

Every file in this directory follows these principles:

1. **Reuse W3C vocabularies.** We lean on PROV-O for provenance, Hydra for HATEOAS operations, ODRL for deontic rules, ACL for access control, Verifiable Credentials for trust, DCAT for federation, OWL-Time for temporal reasoning, SKOS for controlled vocabularies. New IRIs are minted only when no existing vocabulary fits.

2. **Every controlled vocabulary is a SKOS concept scheme.** Deontic modes, confidence levels, eval actions, trust levels, decision strategies, question types, presence statuses, suggestion kinds — all modeled as `skos:ConceptScheme` with `skos:hasTopConcept` and `skos:exactMatch`/`skos:closeMatch` alignments to external vocabularies.

3. **Full rdfs:comment coverage.** Every class, property, individual, and SKOS concept has a rdfs:comment explaining what it is, when to use it, and what it aligns with. These comments are written for ontology consumers, not system authors — they travel with the ontology forever.

4. **Functional properties where appropriate.** `owl:FunctionalProperty` is applied wherever the code actually guarantees single-valuedness, so OWL reasoners can detect cardinality violations.

5. **Disjointness assertions.** Where two classes must never coincide (atom vs. fragment, context facet vs. PGSL node, affordance vs. node), we assert `owl:disjointWith`. This catches common mis-modelings at validation time.

6. **SHACL shapes mirror OWL axioms.** For every cardinality/type constraint declared informally in the OWL ontology, there is a corresponding SHACL property shape that enforces it programmatically.

7. **Alignment ontology keeps layers decoupled.** Cross-layer axioms live in [`alignment.ttl`](alignment.ttl), never in the individual layer files. This means each layer ontology can be versioned independently without breaking the others.

## Runtime access

The library ships the Turtle files with the npm package (see `"files"` in `package.json`) and exposes loaders from `@interego/core`:

```ts
import {
  loadOntology,
  loadFullOntology,
  loadFullShapes,
  ONTOLOGY_MANIFEST,
} from '@interego/core';

// Load one named ontology file as a Turtle string
const pgslTtl = loadOntology('pgsl');
const harnessTtl = loadOntology('harness');
const alignmentTtl = loadOntology('alignment');

// Load the full four-layer ontology as a concatenated Turtle string
const fullTtl = loadFullOntology();

// Load both SHACL shape files concatenated
const shapesTtl = loadFullShapes();

// Enumerate the manifest programmatically
for (const entry of ONTOLOGY_MANIFEST) {
  console.log(entry.name, entry.prefix, entry.namespace);
}
```

**Node-only** — the loaders use `readFileSync`. Browser consumers should bundle the `.ttl` files via their build tool. See [`src/pgsl/static-ontology.ts`](../../src/pgsl/static-ontology.ts) for the implementation.

## Publication and resolution

The canonical URLs resolve to this directory via GitHub Pages:

- `https://markjspivey-xwisee.github.io/interego/ns/cg.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/pgsl.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/pgsl-shapes.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/harness.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/harness-shapes.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/interego.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/interego-shapes.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/alignment.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/hyprcat.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/hypragent.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/hela.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/sat.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/cts.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/olke.ttl`
- `https://markjspivey-xwisee.github.io/interego/ns/amta.ttl`

Each ontology's `vann:preferredNamespaceUri` matches the hashed namespace URI in its `owl:Ontology` declaration.

## Testing

The tests at [`tests/static-ontology.test.ts`](../../tests/static-ontology.test.ts) verify:

1. Every ontology named in `ONTOLOGY_MANIFEST` loads successfully from disk.
2. Every `.ttl` file parses as syntactically valid Turtle (using N3.js).
3. Every ontology contains the key concepts its module claims — for example, `pgsl.ttl` contains Atom/Fragment/PullbackSquare, `harness.ttl` contains all six built-in AATs and all four eval actions, `alignment.ttl` contains all five integration patterns.
4. `loadFullOntology()` and `loadFullShapes()` return parseable, well-formed concatenations.

Run with:

```bash
npm test                                # all 642 tests across the library
npx vitest run tests/static-ontology    # just the ontology tests (34 tests)
```

## Related documents

- **Spec:** [`../spec/context-graphs-1.0-wd.html`](../spec/context-graphs-1.0-wd.html) — the prose specification
- **Architecture overview:** [`../architecture-context-layer-and-harness.md`](../architecture-context-layer-and-harness.md) — how the substrate + harness fit together conceptually
- **Developer guide:** [`../developer-guide.md`](../developer-guide.md) — using the TypeScript API

## License

All ontology files are licensed **MIT**. Free to reuse, extend, redistribute, relicense, and use commercially; see [LICENSE](../../LICENSE) for the full text.
