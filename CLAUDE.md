# CLAUDE.md — @foxxi/context-graphs

## What is this project?

Reference implementation of **Context Graphs 1.0**, a specification by Mark Spivey / Foxxi Mediums Inc. that defines a compositional framework for typed graph contexts over RDF 1.2 Named Graphs.

**Spec:** `context-graphs-1.0-wd.html` (co-located or at https://spec.foxximediums.com/context-graphs/)

## Architecture

This is a zero-dependency TypeScript library (ESM, Node 20+) with four modules:

```
src/
  model/        Core data model: types, ContextDescriptor builder, composition operators
  rdf/          Namespaces, Turtle serializer, JSON-LD serializer/parser
  validation/   Programmatic SHACL-equivalent validator, SHACL shapes as Turtle export
  sparql/       Parameterized SPARQL 1.2 query pattern builders
```

### Key design decisions

- **Zero runtime dependencies.** Validation is implemented programmatically (no SHACL engine needed). SHACL shapes are exported as Turtle strings for use with external engines.
- **Discriminated union pattern.** All seven facet types use `{ type: 'Temporal' | 'Provenance' | ... }` for exhaustive switch matching.
- **Composition is algebraic.** The four operators (union, intersection, restriction, override) form a bounded lattice. Each facet type defines its own merge semantics per the spec.
- **W3C vocabulary reuse.** Every namespace constant, class IRI, and property IRI is typed and exported. The `expand()`/`compact()` helpers handle prefix ↔ full IRI conversion.

### Related Foxxi Mediums projects

This library is designed to compose with:
- **@foxxi/hela-store** — HELA's topos-theoretic xAPI stack (presheaf category ℰ = Set^(𝒞_xAPI^op))
- **SAT (Semiotic Agent Topos)** — The Semiotic Facet maps directly to SAT's Semiotic Field Functor (Σ)
- **HyprCat × HyprAgent** — Federation Facet aligns with the three-world federation model

## Commands

```bash
npm install          # Install devDependencies
npm run build        # Compile TypeScript → dist/
npm test             # Run vitest test suite
npm run test:watch   # Watch mode
npm run lint         # ESLint
```

## Test expectations

- Tests are in `tests/context-graphs.test.ts`
- All composition operator tests use `resetComposedIdCounter()` in `beforeEach` for deterministic IDs
- Currently 40+ test cases covering: builder, composition, validation, Turtle, JSON-LD, namespaces, SPARQL, SHACL

## Conventions

- Immutable data: all `ContextDescriptorData` fields are `readonly`
- IRI type is a branded string for type safety (no runtime overhead)
- Facet type names match the spec's §5 headings: `Temporal`, `Provenance`, `Agent`, `AccessControl`, `Semiotic`, `Trust`, `Federation`
- Composition operators follow §3.4 naming: `union`, `intersection`, `restriction`, `override`
- The `effectiveContext()` function implements the triple-level inheritance rule from §3.5
