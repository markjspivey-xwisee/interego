# Interego — Ontology Reference

This directory contains the **canonical, versioned, hand-authored OWL/RDFS/SHACL ontologies** that define the Interego 1.0 system. These files are the single source of truth for every class, property, and SKOS concept scheme in the three co-designed layers of the system.

**Namespace root:** `https://markjspivey-xwisee.github.io/interego/ns/`

## Twelve ontologies, twelve prefixes

Interego is a five-core-layer system (substrate → typed context → interrogatives → agent harness → cross-layer alignment) plus seven adjacent-framework ontologies that model how Interego composes with systems the project was designed to interoperate with.

### Core layers (emitted by runtime code)

| File | Prefix | Kind | Terms | What it defines |
|---|---|---|---|---|
| [`pgsl.ttl`](pgsl.ttl) | `pgsl:` | OWL | 35 | **Substrate.** Poly-Granular Sequence Lattice — atoms, fragments, pullback squares, transitive containment, SHACL shapes (Atom, Fragment, PullbackSquare, ConstituentIntegrity, LevelConsistency, OverlapValidity, Acyclicity, Canonicality). |
| [`cg.ttl`](cg.ttl) | `cg:` | OWL | 284 | **Typed-context.** ContextDescriptor with seven facet types + Causal + Projection, composition operators, federation, data products (cg:DataProduct), affordances (cg:Affordance + individuals canPublish/canDiscover/canSubscribe/canFetchPayload/canDecrypt), encryption classes (EncryptedGraphEnvelope, EncryptedValue, GraphPayload), auth-methods (AuthMethods, WebAuthnCredential, DIDKey, EthereumWallet), coherence (CoherenceCertificate + enum Equal/Divergent/Subset/Intersect/Union/Exclude), paradigm / persistence / causal / pod-catalog / session-log types. |
| [`interego.ttl`](interego.ttl) | `ie:` | OWL | 34 | **Interrogatives.** User-facing grammar of eleven canonical interrogatives (Who/What/Where/When/Why/How/Which/WhatKind/HowMuch/Whose/Whether) with typed cross-layer mapping. |
| [`harness.ttl`](harness.ttl) | `cgh:` | OWL | 138 | **Agent harness.** Abstract Agent Types (AAT), ODRL policy engine, PROV traces, runtime evaluation with confidence scoring, decision functor, affordance decorators. `cgh:Affordance rdfs:subClassOf hydra:Operation`. |
| [`alignment.ttl`](alignment.ttl) | `align:` | OWL | 22 | **Cross-layer glue.** Equivalences, SKOS matches, and W3C vocabulary alignments (Hydra, ODRL, ACL, VC 2.0, DCAT, DPROD, OWL-Time) across all twelve namespaces. |

### Federation mesh ontologies

| File | Prefix | Terms | What it defines |
|---|---|---|---|
| [`hyprcat.ttl`](hyprcat.ttl) | `hyprcat:` | 15 | **Federated data-product catalog.** Decorates DCAT + DPROD with distributed identity, affordance-bearing distributions, and the three-world federation boundary (UserWorld / AgentWorld / ServiceWorld). `hyprcat:FederatedDistribution` is simultaneously `dcat:Distribution`, `cg:Affordance`, `cgh:Affordance`, and `hydra:Operation`. |
| [`hypragent.ttl`](hypragent.ttl) | `hypragent:` | 16 | **Agent machinery for HyprCat.** Cross-world delegation via W3C Verifiable Credentials chains, capability typing (canDecryptEnvelope, canPublishContext, canVerifyDelegation, canSubscribe), dispatch-time policy evaluation. `hypragent:Agent` is simultaneously `prov:SoftwareAgent`, `cg:AuthorizedAgent`, and `cgh:Agent`. |

### Adjacent-framework ontologies

| File | Prefix | Terms | What it defines |
|---|---|---|---|
| [`hela.ttl`](hela.ttl) | `hela:` | 7 | **Topos-theoretic xAPI.** Statements as a presheaf category ℰ = Set^(𝒞_xAPI^op). Statement / Actor / Verb / LearningObject / Trace / SubobjectClassifier. Aligned with `cg:ProvenanceFacet`. |
| [`sat.ttl`](sat.ttl) | `sat:` | 10 | **Semiotic Agent Topos.** Semiotic Field Functor Σ : Situations → SemioticFields. `sat:SemioticFieldFunctor owl:equivalentClass cg:SemioticFacet`. |
| [`cts.ttl`](cts.ttl) | `cts:` | 11 | **Compositional Tuple Store.** Usage-based linguistic substrate — meaning is usage, structure emerges from usage. `cts:Pattern owl:equivalentClass cg:SyntagmaticPattern`. |
| [`olke.ttl`](olke.ttl) | `olke:` | 11 | **Organizational Learning & Knowledge Evolution.** Four-stage ladder Tacit → Articulate → Collective → Institutional; annotates `cg:ContextDescriptor` with current stage. |
| [`amta.ttl`](amta.ttl) | `amta:` | 13 | **Agent-Mediated Trust Attestation.** Multi-axis trust (competence / honesty / relevance / recency). `amta:Attestation rdfs:subClassOf cg:TrustFacet`. |

### SHACL shape files

| File | Prefix | Kind |
|---|---|---|
| [`pgsl-shapes.ttl`](pgsl-shapes.ttl) | `pgsl:` | Shape file for PGSL invariants |
| [`interego-shapes.ttl`](interego-shapes.ttl) | `ie:` | Shape file for interrogative bindings |
| [`harness-shapes.ttl`](harness-shapes.ttl) | `cgh:` | Shape file for harness structures |

**Totals:** 12 ontology files, 1 alignment file, 3 SHACL shape files — **607 defined terms** across all twelve namespaces.

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

All ontology files are licensed **CC-BY-4.0**. You are free to reuse, extend, and redistribute them with attribution.
