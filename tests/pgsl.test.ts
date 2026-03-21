/**
 * Tests for Poly-Granular Sequence Lattice (PGSL)
 *
 * Covers:
 *   - Set-theoretic foundation (atoms, fragments, canonicity)
 *   - Monad operations (MintAtom, Ingest, Resolve)
 *   - Presheaf structure (fiber, constituents, pullback squares)
 *   - Lattice operations (meet, sub-fragment)
 *   - Geometric morphism (embed, lift, coherence, provenance naturality)
 *   - RDF ecosystem (Turtle, OWL, SHACL, SPARQL)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPGSL,
  mintAtom,
  ingest,
  pgslResolve,
  queryNeighbors,
  latticeStats,
  fiber,
  maxLevel,
  constituents,
  pullbackSquare,
  ancestorFragments,
  descendantNodes,
  latticeMeet,
  isSubFragment,
  pgslToTurtle,
  pgslOwlOntology,
  pgslShaclShapes,
  sparqlFragmentsAtLevel,
  sparqlFragmentsContaining,
  sparqlPullbackOf,
  sparqlNeighbors,
  liftToDescriptor,
  embedInPGSL,
  verifyIntersectionCoherence,
  verifyProvenanceNaturality,
  ContextDescriptor,
} from '../src/index.js';
import type { IRI, PGSLInstance, NodeProvenance } from '../src/index.js';

const TEST_PROV: NodeProvenance = {
  wasAttributedTo: 'did:web:test.example' as IRI,
  generatedAtTime: '2026-03-20T00:00:00Z',
};

let pgsl: PGSLInstance;
beforeEach(() => {
  pgsl = createPGSL(TEST_PROV);
});

// ═════════════════════════════════════════════════════════════
//  Atoms (Level 0)
// ═════════════════════════════════════════════════════════════

describe('Atoms', () => {
  it('mints an atom with canonical URI', () => {
    const uri = mintAtom(pgsl, 'hello');
    expect(uri).toContain('urn:pgsl:atom:');
    expect(pgsl.nodes.get(uri)?.kind).toBe('Atom');
  });

  it('returns same URI for same value (canonicity invariant)', () => {
    const a = mintAtom(pgsl, 'hello');
    const b = mintAtom(pgsl, 'hello');
    expect(a).toBe(b);
  });

  it('different values get different URIs', () => {
    const a = mintAtom(pgsl, 'A');
    const b = mintAtom(pgsl, 'B');
    expect(a).not.toBe(b);
  });

  it('atom has provenance', () => {
    const uri = mintAtom(pgsl, 'test');
    const node = pgsl.nodes.get(uri)!;
    expect(node.provenance.wasAttributedTo).toBe('did:web:test.example');
    expect(node.provenance.generatedAtTime).toBe('2026-03-20T00:00:00Z');
  });

  it('atom has level 0', () => {
    const uri = mintAtom(pgsl, 'x');
    const node = pgsl.nodes.get(uri)!;
    expect(node.kind === 'Atom' && node.level).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════
//  Ingest (Monad Multiplication)
// ═════════════════════════════════════════════════════════════

describe('Ingest', () => {
  it('ingests "A B C" and builds the lattice', () => {
    const top = ingest(pgsl, ['A', 'B', 'C']);
    expect(top).toBeDefined();

    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBe(3);          // A, B, C
    expect(stats.levels[1]).toBe(3);      // L1 wrappers: (A), (B), (C)
    expect(stats.levels[2]).toBe(2);      // L2: (A,B), (B,C)
    expect(stats.levels[3]).toBe(1);      // L3: (A,B,C)
  });

  it('reuses atoms across ingestions (structural sharing)', () => {
    ingest(pgsl, ['A', 'B', 'C']);
    ingest(pgsl, ['B', 'C', 'D']);

    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBe(4);  // A, B, C, D — not 6

    // The "B C" fragment should be shared
    // Both sequences create L2 fragment for (B,C)
    expect(stats.levels[2]).toBe(3); // (A,B), (B,C), (C,D)
  });

  it('single value produces level-1 fragment', () => {
    const top = ingest(pgsl, ['X']);
    const node = pgsl.nodes.get(top);
    expect(node?.kind).toBe('Fragment');
    if (node?.kind === 'Fragment') {
      expect(node.level).toBe(1);
    }
  });

  it('structural determinism: same sequence → same URI', () => {
    const pgsl2 = createPGSL(TEST_PROV);
    const a = ingest(pgsl, ['A', 'B', 'C']);
    const b = ingest(pgsl2, ['A', 'B', 'C']);
    expect(a).toBe(b);
  });

  it('rejects empty sequence', () => {
    expect(() => ingest(pgsl, [])).toThrow('empty');
  });
});

// ═════════════════════════════════════════════════════════════
//  Resolve (Counit)
// ═════════════════════════════════════════════════════════════

describe('Resolve', () => {
  it('resolves atom to its value', () => {
    const uri = mintAtom(pgsl, 'hello');
    expect(pgslResolve(pgsl, uri)).toBe('hello');
  });

  it('resolves top fragment to full sequence', () => {
    const top = ingest(pgsl, ['A', 'B', 'C']);
    const resolved = pgslResolve(pgsl, top);
    expect(resolved).toBe('A B C');
  });
});

// ═════════════════════════════════════════════════════════════
//  Presheaf Structure
// ═════════════════════════════════════════════════════════════

describe('Presheaf Structure', () => {
  it('fiber(0) returns atoms', () => {
    ingest(pgsl, ['A', 'B']);
    const atoms = fiber(pgsl, 0);
    expect(atoms.length).toBe(2);
    expect(atoms.every(n => n.kind === 'Atom')).toBe(true);
  });

  it('fiber(1) returns level-1 wrappers', () => {
    ingest(pgsl, ['A', 'B']);
    const l1 = fiber(pgsl, 1);
    expect(l1.length).toBe(2);
  });

  it('maxLevel returns correct top level', () => {
    ingest(pgsl, ['A', 'B', 'C', 'D']);
    expect(maxLevel(pgsl)).toBe(4);
  });

  it('constituents returns left/right for level-2 fragment', () => {
    ingest(pgsl, ['A', 'B']);
    const l2 = fiber(pgsl, 2);
    expect(l2.length).toBe(1);
    const morphisms = constituents(pgsl, l2[0]!.kind === 'Fragment' ? (l2[0] as any).uri : '');
    expect(morphisms.length).toBe(2);
    expect(morphisms[0]!.position).toBe('left');
    expect(morphisms[1]!.position).toBe('right');
  });
});

// ═════════════════════════════════════════════════════════════
//  Pullback Squares
// ═════════════════════════════════════════════════════════════

describe('Pullback Squares', () => {
  it('extracts pullback for level-3 fragment', () => {
    const top = ingest(pgsl, ['A', 'B', 'C']);
    const pb = pullbackSquare(pgsl, top);
    expect(pb).not.toBeNull();
    expect(pb!.level).toBe(3);
    expect(pb!.left).toBeDefined();
    expect(pb!.right).toBeDefined();
    expect(pb!.overlap).toBeDefined();
  });

  it('no pullback for level-1 fragment', () => {
    const top = ingest(pgsl, ['X']);
    expect(pullbackSquare(pgsl, top)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════
//  Lattice Operations
// ═════════════════════════════════════════════════════════════

describe('Lattice Operations', () => {
  it('latticeMeet finds shared sub-fragment', () => {
    const abc = ingest(pgsl, ['A', 'B', 'C']);
    const bcd = ingest(pgsl, ['B', 'C', 'D']);
    const meet = latticeMeet(pgsl, abc, bcd);
    expect(meet).not.toBeNull();
    // The meet should be the (B,C) fragment
    const resolved = pgslResolve(pgsl, meet!);
    expect(resolved).toBe('B C');
  });

  it('latticeMeet returns null for disjoint sequences', () => {
    const ab = ingest(pgsl, ['A', 'B']);
    const cd = ingest(pgsl, ['C', 'D']);
    const meet = latticeMeet(pgsl, ab, cd);
    expect(meet).toBeNull();
  });

  it('isSubFragment detects containment', () => {
    const abc = ingest(pgsl, ['A', 'B', 'C']);
    // Find the (A,B) fragment at level 2
    const l2 = fiber(pgsl, 2);
    const ab = l2.find(n => n.kind === 'Fragment' && pgslResolve(pgsl, (n as any).uri) === 'A B');
    expect(ab).toBeDefined();
    expect(isSubFragment(pgsl, (ab as any).uri, abc)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════
//  Neighbors
// ═════════════════════════════════════════════════════════════

describe('QueryNeighbors', () => {
  it('finds right neighbor', () => {
    ingest(pgsl, ['A', 'B', 'C']);
    const l1 = fiber(pgsl, 1);
    const wrapperA = l1.find(n =>
      n.kind === 'Fragment' && pgslResolve(pgsl, (n as any).uri) === 'A'
    );
    expect(wrapperA).toBeDefined();
    const neighbors = queryNeighbors(pgsl, (wrapperA as any).uri, 'right');
    expect(neighbors.size).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════
//  RDF Ecosystem
// ═════════════════════════════════════════════════════════════

describe('RDF Serialization', () => {
  it('serializes PGSL to Turtle', () => {
    ingest(pgsl, ['A', 'B', 'C']);
    const turtle = pgslToTurtle(pgsl);
    expect(turtle).toContain('pgsl:Atom');
    expect(turtle).toContain('pgsl:Fragment');
    expect(turtle).toContain('pgsl:level');
    expect(turtle).toContain('prov:wasAttributedTo');
    expect(turtle).toContain('pgsl:leftConstituent');
    expect(turtle).toContain('pgsl:itemList');
  });

  it('generates OWL ontology', () => {
    const owl = pgslOwlOntology();
    expect(owl).toContain('owl:Class');
    expect(owl).toContain('pgsl:Atom');
    expect(owl).toContain('pgsl:Fragment');
    expect(owl).toContain('owl:disjointWith');
    expect(owl).toContain('owl:TransitiveProperty');
  });

  it('generates SHACL shapes', () => {
    const shacl = pgslShaclShapes();
    expect(shacl).toContain('sh:NodeShape');
    expect(shacl).toContain('pgsl:AtomShape');
    expect(shacl).toContain('pgsl:FragmentShape');
    expect(shacl).toContain('sh:minCount');
  });

  it('generates SPARQL queries', () => {
    expect(sparqlFragmentsAtLevel(2)).toContain('pgsl:level');
    expect(sparqlFragmentsContaining('urn:test')).toContain('pgsl:item');
    expect(sparqlPullbackOf('urn:test')).toContain('pgsl:overlap');
    expect(sparqlNeighbors('urn:test')).toContain('pgsl:leftConstituent');
  });
});

// ═════════════════════════════════════════════════════════════
//  Geometric Morphism
// ═════════════════════════════════════════════════════════════

describe('Geometric Morphism', () => {
  it('embeds content into PGSL (inverse image f*)', () => {
    const uri = embedInPGSL(pgsl, 'hello world from PGSL');
    expect(uri).toBeDefined();
    expect(pgslResolve(pgsl, uri)).toBe('hello world from PGSL');
  });

  it('lifts PGSL fragment to Context Descriptor (direct image f_*)', () => {
    const fragmentUri = ingest(pgsl, ['A', 'B', 'C']);
    const desc = liftToDescriptor(
      pgsl,
      fragmentUri,
      'urn:cg:lifted' as IRI,
      [{ type: 'Temporal', validFrom: '2026-01-01T00:00:00Z' }],
    );
    expect(desc.id).toBe('urn:cg:lifted');
    expect(desc.describes).toContain(fragmentUri);
    expect(desc.facets).toHaveLength(1);
  });

  it('verifies intersection coherence', () => {
    const result = verifyIntersectionCoherence(pgsl, 'A B C', 'B C D');
    expect(result.coherent).toBe(true);
    expect(result.pgslMeet).not.toBeNull();
  });

  it('verifies provenance naturality', () => {
    const top = ingest(pgsl, ['A', 'B', 'C']);
    const result = verifyProvenanceNaturality(pgsl, top);
    expect(result.natural).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════
//  The ADT Example from the Spec: "A B C" then "B C D"
// ═════════════════════════════════════════════════════════════

describe('Spec Example: "A B C" then "B C D"', () => {
  it('reproduces the exact lattice from the ADT specification', () => {
    // First ingestion
    const abc = ingest(pgsl, ['A', 'B', 'C']);

    // Second ingestion — should reuse f23 (the B,C fragment)
    const bcd = ingest(pgsl, ['B', 'C', 'D']);

    // Verify atoms: 4 unique (A, B, C, D)
    const stats = latticeStats(pgsl);
    expect(stats.atoms).toBe(4);

    // Verify L1: 4 wrappers
    expect(stats.levels[1]).toBe(4);

    // Verify L2: 3 fragments (A B), (B C), (C D)
    expect(stats.levels[2]).toBe(3);

    // Verify L3: 2 top fragments (A B C), (B C D)
    expect(stats.levels[3]).toBe(2);

    // Verify structural sharing: the (B C) L2 fragment is the same node
    const meet = latticeMeet(pgsl, abc, bcd);
    expect(meet).not.toBeNull();
    expect(pgslResolve(pgsl, meet!)).toBe('B C');

    // Verify resolve
    expect(pgslResolve(pgsl, abc)).toBe('A B C');
    expect(pgslResolve(pgsl, bcd)).toBe('B C D');
  });
});
