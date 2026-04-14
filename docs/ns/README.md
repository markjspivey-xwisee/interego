# Interego — Ontology Reference

This directory contains the **canonical, versioned, hand-authored OWL/RDFS/SHACL ontologies** that define the Interego 1.0 system. These files are the single source of truth for every class, property, and SKOS concept scheme in the three co-designed layers of the system.

**Namespace root:** `https://interego.dev/ns/`

## The four layers

Interego is a three-layer system (substrate → typed context → agent harness) plus a cross-layer alignment ontology that ties them together.

| File | Prefix | Kind | Lines | Triples | What it defines |
|---|---|---|---|---|---|
| [`pgsl.ttl`](pgsl.ttl) | `pgsl:` | OWL Ontology | 249 | 161 | **Substrate layer.** The Poly-Granular Sequence Lattice — atoms (level 0), fragments (level ≥ 1), pullback squares, constituent morphisms, transitive containment. Aligned with PROV-O. |
| [`context-graphs.ttl`](context-graphs.ttl) | `cg:` | OWL Ontology | 542 | 376 | **Typed-context layer.** Context descriptors with seven facet types (Temporal, Provenance, Agent, AccessControl, Semiotic, Trust, Federation), composition operators (union/intersection/restriction/override), and federation primitives. |
| [`harness.ttl`](harness.ttl) | `cgh:` | OWL Ontology | 982 | 810 | **Agent harness layer.** Abstract Agent Types (AAT), ODRL-aligned policy engine, PROV traces, runtime evaluation with confidence scoring, decision functor, and affordance decorators. |
| [`alignment.ttl`](alignment.ttl) | `align:` | OWL Ontology | 383 | 204 | **Cross-layer glue.** Axioms, SKOS matches, and W3C vocabulary alignments (Hydra, ODRL, ACL, VC, DCAT, OWL-Time) that tie `pgsl:`, `cg:`, and `cgh:` together. Plus five named integration patterns. |
| [`pgsl-shapes.ttl`](pgsl-shapes.ttl) | `pgsl:` | SHACL Shapes | 247 | 151 | Validation shapes for PGSL serializations: atom/fragment invariants, pullback commutativity, required PROV-O triples. |
| [`harness-shapes.ttl`](harness-shapes.ttl) | `cgh:` | SHACL Shapes | 546 | 358 | Validation shapes for the harness layer: AAT capability requirements, policy rule well-formedness, PROV trace completeness, runtime eval confidence bounds. |

**Totals:** 6 files, ~3,000 lines of Turtle, **2,060 triples**, 0 lint errors, 100% coverage by the test suite.

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

- `https://interego.dev/ns/cg.ttl`
- `https://interego.dev/ns/pgsl.ttl`
- `https://interego.dev/ns/pgsl-shapes.ttl`
- `https://interego.dev/ns/harness.ttl`
- `https://interego.dev/ns/harness-shapes.ttl`
- `https://interego.dev/ns/alignment.ttl`

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
