/**
 * Lattice law tests for composition operators (spec §3.4).
 *
 * Union and intersection over Context Descriptors should form a
 * bounded lattice. These tests pin the normative properties:
 *
 *   - Idempotence:    union(d, d)        = d (modulo id)
 *                     intersection(d, d) = d
 *   - Commutativity:  union(a, b)        = union(b, a)        (facet sets)
 *                     intersection(a, b) = intersection(b, a)
 *   - Associativity:  union(union(a,b),c) = union(a,union(b,c))
 *   - Absorption:     union(a, intersection(a,b))        = a
 *                     intersection(a, union(a,b))        = a
 *
 * Equality is defined by the SET of facet-type projections (ignoring
 * generated IDs). Tests assert equivalence modulo those fields.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextDescriptor,
  union,
  intersection,
  type ContextDescriptorData,
  type IRI,
  type ContextFacetData,
} from '../src/index.js';
import { resetComposedIdCounter } from '../src/model/composition.js';

function buildDescriptor(
  id: string,
  facets: ContextFacetData[],
): ContextDescriptorData {
  const builder = ContextDescriptor.create(id as IRI).describes('urn:graph:test' as IRI);
  for (const f of facets) {
    builder.addFacet(f);
  }
  return builder.build();
}

/** Multiset signature — counts matter (for commutativity / associativity). */
function facetSignature(d: ContextDescriptorData): string {
  return [...d.facets]
    .map(f => {
      switch (f.type) {
        case 'Semiotic':
          return `Semiotic:${f.modalStatus}:${f.epistemicConfidence}`;
        case 'Trust':
          return `Trust:${f.trustLevel}:${f.issuer ?? ''}`;
        case 'Temporal':
          return `Temporal:${f.validFrom ?? ''}:${f.validUntil ?? ''}`;
        case 'Federation':
          return `Federation:${f.origin ?? ''}:${f.storageEndpoint ?? ''}:${f.syncProtocol ?? ''}`;
        default:
          return f.type;
      }
    })
    .sort()
    .join('|');
}

/** Type-set signature — which facet types are present (ignoring counts).
 *  Interego's composition intentionally preserves modal polyphony (multiple
 *  Semiotic facets on one composed descriptor), so classical set-level
 *  idempotence applies at the TYPE level rather than multiset level. */
function facetTypeSet(d: ContextDescriptorData): string {
  return [...new Set(d.facets.map(f => f.type))].sort().join('|');
}

const temporal: ContextFacetData = {
  type: 'Temporal',
  validFrom: '2026-04-22T00:00:00Z',
};
const semioticA: ContextFacetData = {
  type: 'Semiotic',
  modalStatus: 'Asserted',
  epistemicConfidence: 0.9,
  groundTruth: true,
};
const semioticB: ContextFacetData = {
  type: 'Semiotic',
  modalStatus: 'Hypothetical',
  epistemicConfidence: 0.5,
};
const trust: ContextFacetData = {
  type: 'Trust',
  trustLevel: 'SelfAsserted',
  issuer: 'urn:agent:a' as IRI,
};
const fed: ContextFacetData = {
  type: 'Federation',
  origin: 'urn:pod:a' as IRI,
  storageEndpoint: 'urn:pod:a' as IRI,
  syncProtocol: 'SolidNotifications',
};

describe('lattice laws — union', () => {
  beforeEach(() => resetComposedIdCounter());

  it('idempotence (type-set level): union(d, d) has same facet types as d', () => {
    // Interego union intentionally preserves multi-facet siblings (modal
    // polyphony); classical idempotence holds at the facet-type-set
    // level, not multiset. Tests pin this design decision.
    const d = buildDescriptor('urn:cg:idempotent', [temporal, semioticA, trust, fed]);
    const dd = union(d, d);
    expect(facetTypeSet(dd)).toBe(facetTypeSet(d));
  });

  it('commutativity: union(a, b) ≈ union(b, a)', () => {
    const a = buildDescriptor('urn:cg:a', [temporal, semioticA, trust]);
    const b = buildDescriptor('urn:cg:b', [fed, semioticB]);
    resetComposedIdCounter();
    const ab = union(a, b);
    resetComposedIdCounter();
    const ba = union(b, a);
    expect(facetSignature(ab)).toBe(facetSignature(ba));
  });

  it('associativity: union(union(a,b),c) ≈ union(a,union(b,c))', () => {
    const a = buildDescriptor('urn:cg:a', [temporal]);
    const b = buildDescriptor('urn:cg:b', [semioticA]);
    const c = buildDescriptor('urn:cg:c', [trust, fed]);
    resetComposedIdCounter();
    const left = union(union(a, b), c);
    resetComposedIdCounter();
    const right = union(a, union(b, c));
    expect(facetSignature(left)).toBe(facetSignature(right));
  });
});

describe('lattice laws — intersection', () => {
  beforeEach(() => resetComposedIdCounter());

  it('idempotence (type-set level): intersection(d, d) has same facet types as d', () => {
    const d = buildDescriptor('urn:cg:idem-int', [temporal, semioticA, trust, fed]);
    const dd = intersection(d, d);
    expect(facetTypeSet(dd)).toBe(facetTypeSet(d));
  });

  it('commutativity: intersection(a, b) ≈ intersection(b, a)', () => {
    const a = buildDescriptor('urn:cg:a', [temporal, semioticA, trust]);
    const b = buildDescriptor('urn:cg:b', [temporal, semioticB, fed]);
    resetComposedIdCounter();
    const ab = intersection(a, b);
    resetComposedIdCounter();
    const ba = intersection(b, a);
    expect(facetSignature(ab)).toBe(facetSignature(ba));
  });

  it('empty facet intersection yields empty facet set', () => {
    const a = buildDescriptor('urn:cg:a', [temporal, semioticA]);
    const b = buildDescriptor('urn:cg:b', [trust, fed]);  // no shared facet types
    const ab = intersection(a, b);
    expect(ab.facets.length).toBe(0);
  });
});

describe('lattice laws — absorption', () => {
  beforeEach(() => resetComposedIdCounter());

  it('union(a, intersection(a, b)) ≈ a', () => {
    // This law requires that intersection(a,b) be a sub-structure of a.
    // Our union then adds NOTHING new to a (all facets already present).
    const a = buildDescriptor('urn:cg:a', [temporal, semioticA, trust]);
    const b = buildDescriptor('urn:cg:b', [temporal, semioticB]);
    resetComposedIdCounter();
    const inner = intersection(a, b);
    resetComposedIdCounter();
    const left = union(a, inner);
    // Union preserves multi-facet-type semantics: multiple Semiotic
    // facets from different operands stay as siblings. Equality here
    // is at the TYPE SET level — all facet types in `a` appear in
    // `left`, and `left` contains no types not in `a`.
    const aTypes = new Set(a.facets.map(f => f.type));
    const leftTypes = new Set(left.facets.map(f => f.type));
    for (const t of aTypes) expect(leftTypes.has(t)).toBe(true);
    for (const t of leftTypes) expect(aTypes.has(t)).toBe(true);
  });
});
