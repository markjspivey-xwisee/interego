/**
 * @module pgsl/static-ontology
 * @description Loaders for the static, canonical ontology files in docs/ns/.
 *
 * Interego has five co-designed ontology layers, all authored by hand in
 * Turtle under `docs/ns/`:
 *
 *   - interego.ttl        — the interrogatives core (ie:)
 *                           the user-facing grammar of the system
 *   - pgsl.ttl            — the substrate lattice layer (pgsl:)
 *   - cg.ttl              — the typed context descriptor layer (cg:)
 *   - harness.ttl         — the agent/eval/decorator harness layer (cgh:)
 *   - alignment.ttl       — cross-layer mappings (align:)
 *
 * Each lower layer has a matching SHACL shapes file:
 *
 *   - interego-shapes.ttl
 *   - pgsl-shapes.ttl
 *   - harness-shapes.ttl
 *
 * These static files are the canonical, versioned definitions.
 * The functions in this module load them at runtime
 * (Node only — browser consumers should bundle the .ttl files
 * themselves via their build tool).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Named ontology files available for loading.
 */
export type OntologyName =
  | 'interego'
  | 'interego-shapes'
  | 'pgsl'
  | 'pgsl-shapes'
  | 'cg'
  | 'cg-shapes'
  | 'harness'
  | 'harness-shapes'
  | 'alignment';

/**
 * Resolve the docs/ns/ directory relative to this module's location.
 *
 * Works whether the library is run from source (src/pgsl/) or
 * compiled (dist/pgsl/) — both are two levels deep inside the
 * package root.
 */
function resolveNsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'docs', 'ns');
}

/**
 * Load a static ontology file by name and return it as a Turtle string.
 *
 * Throws if the file doesn't exist. Node-only.
 *
 * @example
 * ```ts
 * import { loadOntology } from '@interego/core';
 *
 * const interegoTtl = loadOntology('interego');  // interrogatives core
 * const pgslTtl = loadOntology('pgsl');          // substrate layer
 * const cgTtl = loadOntology('cg');              // typed-context layer
 * const harnessTtl = loadOntology('harness');    // agent harness
 * const alignmentTtl = loadOntology('alignment'); // cross-layer axioms
 * ```
 */
export function loadOntology(name: OntologyName): string {
  const path = resolve(resolveNsDir(), `${name}.ttl`);
  return readFileSync(path, 'utf-8');
}

/**
 * Load ALL five ontologies (interego + pgsl + cg + harness + alignment)
 * as a single concatenated Turtle document. Useful when you want to
 * load the full system into a triple store in one pass.
 *
 * Note that the five files each declare their own prefix list; the
 * concatenated output repeats them, which most Turtle parsers handle
 * correctly (later declarations simply redeclare the same prefixes).
 * If your parser is strict, load each file individually.
 */
export function loadFullOntology(): string {
  const parts: string[] = [
    '# ═══════════════════════════════════════════════════════════',
    '# Interego 1.0 — Full Ontology',
    '# (interego + pgsl + cg + harness + alignment)',
    '# ═══════════════════════════════════════════════════════════',
    '',
    loadOntology('interego'),
    '',
    loadOntology('pgsl'),
    '',
    loadOntology('cg'),
    '',
    loadOntology('harness'),
    '',
    loadOntology('alignment'),
  ];
  return parts.join('\n');
}

/**
 * Load all SHACL shape files (interego + pgsl + harness) concatenated.
 * Use this to validate an RDF graph against the full system's constraints.
 */
export function loadFullShapes(): string {
  const parts: string[] = [
    '# ═══════════════════════════════════════════════════════════',
    '# Interego 1.0 — Full SHACL Shapes',
    '# (interego + pgsl + cg + harness)',
    '# ═══════════════════════════════════════════════════════════',
    '',
    loadOntology('interego-shapes'),
    '',
    loadOntology('pgsl-shapes'),
    '',
    loadOntology('cg-shapes'),
    '',
    loadOntology('harness-shapes'),
  ];
  return parts.join('\n');
}

/**
 * Enumerate the named ontology files shipped with the library.
 * Each entry includes the name, namespace, and a brief description.
 */
export interface OntologyManifestEntry {
  readonly name: OntologyName;
  readonly namespace: string;
  readonly prefix: string;
  readonly kind: 'ontology' | 'shapes';
  readonly description: string;
}

/**
 * The manifest of every ontology file shipped with the library.
 * A programmatic index that mirrors the `docs/ns/README.md` documentation.
 */
export const ONTOLOGY_MANIFEST: readonly OntologyManifestEntry[] = [
  {
    name: 'interego',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/interego#',
    prefix: 'ie',
    kind: 'ontology',
    description:
      'Interrogatives core. The user-facing grammar of Interego: eleven canonical interrogatives (Who, What, Where, When, Why, How, Which, WhatKind, HowMuch, Whose, Whether) as a SKOS concept scheme, plus Acts, Responses, the Peircean sign/object/interpretant triad, and Signification as the unit of emergent meaning.',
  },
  {
    name: 'interego-shapes',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/interego#',
    prefix: 'ie',
    kind: 'shapes',
    description:
      'SHACL shapes for the interrogatives core: Act well-formedness, Response confidence bounds, Interpretant agent-relativity, Signification emergent-antecedent requirement.',
  },
  {
    name: 'pgsl',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#',
    prefix: 'pgsl',
    kind: 'ontology',
    description:
      'Poly-Granular Sequence Lattice substrate. Atoms, fragments, pullback squares, constituent morphisms, transitive containment. Aligned with PROV-O.',
  },
  {
    name: 'pgsl-shapes',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#',
    prefix: 'pgsl',
    kind: 'shapes',
    description:
      'SHACL shapes that validate PGSL serializations: atom/fragment invariants, pullback commutativity, PROV-O provenance triples.',
  },
  {
    name: 'cg',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/cg#',
    prefix: 'cg',
    kind: 'ontology',
    description:
      'Typed context descriptor layer. Seven facet types (Temporal, Provenance, Agent, AccessControl, Semiotic, Trust, Federation), composition operators (union, intersection, restriction, override), and federation primitives. The technical machinery that answers the ie:When / ie:Who / ie:Where / ie:Why / ie:Whose / ie:WhatKind / ie:Whether interrogatives.',
  },
  {
    name: 'cg-shapes',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/cg#',
    prefix: 'cg',
    kind: 'shapes',
    description:
      'Normative SHACL shapes for the cg: core namespace. Modal-truth consistency (Asserted/Counterfactual/Hypothetical ↔ groundTruth), future-validFrom warning, revocation self-reference rejection, six-facet invariant, and agent-identity consistency across AgentFacet and ProvenanceFacet. Used as oracles by the conformance test suite.',
  },
  {
    name: 'harness',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/harness#',
    prefix: 'cgh',
    kind: 'ontology',
    description:
      'Agent harness layer. Abstract Agent Types (AAT), policy engine with ODRL alignment, PROV traces, runtime evaluation with confidence scoring, decision functor, and affordance decorators. Answers ie:Who (what AAT am I?), ie:Which (which action to take?), and ie:Whether (permitted? reliable?).',
  },
  {
    name: 'harness-shapes',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/harness#',
    prefix: 'cgh',
    kind: 'shapes',
    description:
      'SHACL shapes for the harness layer: AAT invariants, policy rule well-formedness, PROV trace completeness, runtime eval bounds.',
  },
  {
    name: 'alignment',
    namespace: 'https://markjspivey-xwisee.github.io/interego/ns/alignment#',
    prefix: 'align',
    kind: 'ontology',
    description:
      'Cross-layer alignment ontology tying interego, pgsl, cg, and cgh together. Includes the interrogative-to-layer mapping (which layer answers which ie: interrogative), SKOS concept-scheme matches, external W3C vocabulary alignments (PROV-O, Hydra, ODRL, ACL, VC, DCAT, OWL-Time), and named integration patterns.',
  },
];

/**
 * Get the manifest entry for a named ontology file.
 */
export function getOntologyManifest(name: OntologyName): OntologyManifestEntry {
  const entry = ONTOLOGY_MANIFEST.find(e => e.name === name);
  if (!entry) {
    throw new Error(`Unknown ontology: ${name}`);
  }
  return entry;
}
