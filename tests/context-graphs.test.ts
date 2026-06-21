/**
 * Test suite for @interego/core
 *
 * Covers: descriptor builder, composition operators, serialization,
 *         validation, and SPARQL pattern generation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  askHasContextType,
  assertValid,
  CG,
  CGClass,
  CGProp,
  compact,
  ContextDescriptor,
  effectiveContext,
  expand,
  fromJsonLd,
  getShaclShapesTurtle,
  intersection,
  override,
  PROV,
  queryContextForGraph,
  queryGraphsAtTime,
  queryGraphsByModalStatus,
  restriction,
  toJsonLd,
  toJsonLdString,
  toTurtle,
  union,
  validate,
} from '@interego/core';
import {
  resetComposedIdCounter,
} from '@interego/core';

import type {
  ContextDescriptorData,
  IRI,
  SemioticFacetData,
  TemporalFacetData,
} from '@interego/core';

// ── Helpers ──────────────────────────────────────────────────

function makeSimpleDescriptor(id: string, graph: string): ContextDescriptorData {
  return ContextDescriptor.create(id as IRI)
.describes(graph as IRI)
.temporal({
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: '2026-06-30T23:59:59Z',
    })
.build();
}

// ═════════════════════════════════════════════════════════════
//  Descriptor Builder
// ═════════════════════════════════════════════════════════════

describe('ContextDescriptor Builder', () => {
  it('creates a minimal valid descriptor', () => {
    const desc = ContextDescriptor.create('urn:iep:test-1' as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({ validFrom: '2026-01-01T00:00:00Z' })
.build();

    expect(desc.id).toBe('urn:iep:test-1');
    expect(desc.describes).toEqual(['urn:graph:g1']);
    expect(desc.facets).toHaveLength(1);
    expect(desc.facets[0]!.type).toBe('Temporal');
  });

  it('supports multiple facets via fluent API', () => {
    const desc = ContextDescriptor.create('urn:iep:test-2' as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2026-12-31T23:59:59Z',
        temporalResolution: 'P1D',
      })
.asserted(0.95)
.selfAsserted('did:web:interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io' as IRI)
.generatedBy('urn:agent:etl' as IRI, {
        derivedFrom: ['urn:data:raw.csv' as IRI],
      })
.federation({
        origin: 'https://pod.example.org/data' as IRI,
        syncProtocol: 'SolidNotifications',
      })
.version(1)
.build();

    expect(desc.facets).toHaveLength(5); // temporal, semiotic, trust, provenance, federation
    expect(desc.version).toBe(1);
  });

  it('supports multiple graphs per descriptor', () => {
    const desc = ContextDescriptor.create('urn:iep:multi' as IRI)
.describes('urn:graph:a' as IRI, 'urn:graph:b' as IRI, 'urn:graph:c' as IRI)
.temporal({ validFrom: '2026-01-01T00:00:00Z' })
.build();

    expect(desc.describes).toHaveLength(3);
  });

  it('throws on empty describes', () => {
    expect(() =>
      ContextDescriptor.create('urn:iep:bad' as IRI)
.temporal({ validFrom: '2026-01-01T00:00:00Z' })
.build()
    ).toThrow('must describe at least one Named Graph');
  });

  it('throws on empty facets', () => {
    expect(() =>
      ContextDescriptor.create('urn:iep:bad' as IRI)
.describes('urn:graph:g1' as IRI)
.build()
    ).toThrow('must have at least one facet');
  });

  it('validates epistemicConfidence range', () => {
    expect(() =>
      ContextDescriptor.create('urn:iep:bad' as IRI)
.describes('urn:graph:g1' as IRI)
.semiotic({ epistemicConfidence: 1.5 })
    ).toThrow('must be in [0.0, 1.0]');
  });

  it('reconstructs from data via.from()', () => {
    const original = makeSimpleDescriptor('urn:iep:orig', 'urn:graph:g1');
    const rebuilt = ContextDescriptor.from(original);
    expect(rebuilt.id).toBe(original.id);
    expect(rebuilt.build().facets).toEqual(original.facets);
  });

  it('introspection methods work', () => {
    const builder = ContextDescriptor.create('urn:iep:intro' as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({ validFrom: '2026-01-01T00:00:00Z' })
.asserted(0.9);

    expect(builder.hasFacetType('Temporal')).toBe(true);
    expect(builder.hasFacetType('Trust')).toBe(false);
    expect(builder.getFacets('Semiotic')).toHaveLength(1);
    expect(builder.facetCount).toBe(2);
    expect(builder.graphCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════
//  Composition Operators
// ═════════════════════════════════════════════════════════════

describe('Composition Operators', () => {
  beforeEach(() => resetComposedIdCounter());

  const d1: ContextDescriptorData = {
    id: 'urn:iep:d1' as IRI,
    describes: ['urn:graph:shared' as IRI],
    facets: [
      { type: 'Temporal', validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-06-30T23:59:59Z' },
      { type: 'Trust', trustLevel: 'CryptographicallyVerified', issuer: 'did:web:alice' as IRI },
    ],
  };

  const d2: ContextDescriptorData = {
    id: 'urn:iep:d2' as IRI,
    describes: ['urn:graph:shared' as IRI],
    facets: [
      { type: 'Temporal', validFrom: '2026-03-01T00:00:00Z', validUntil: '2026-12-31T23:59:59Z' },
      { type: 'Trust', trustLevel: 'ThirdPartyAttested', issuer: 'did:web:bob' as IRI },
      { type: 'Semiotic', modalStatus: 'Asserted', epistemicConfidence: 0.88 },
    ],
  };

  describe('union', () => {
    it('produces convex hull of temporal intervals', () => {
      const result = union(d1, d2);
      const tf = result.facets.find(f => f.type === 'Temporal') as TemporalFacetData;
      expect(tf.validFrom).toBe('2026-01-01T00:00:00Z');
      expect(tf.validUntil).toBe('2026-12-31T23:59:59Z');
    });

    it('includes all facet types from both operands', () => {
      const result = union(d1, d2);
      const types = new Set(result.facets.map(f => f.type));
      expect(types.has('Temporal')).toBe(true);
      expect(types.has('Trust')).toBe(true);
      expect(types.has('Semiotic')).toBe(true);
    });

    it('preserves both trust facets', () => {
      const result = union(d1, d2);
      const trusts = result.facets.filter(f => f.type === 'Trust');
      expect(trusts).toHaveLength(2);
    });

    it('sets compositionOp to union', () => {
      const result = union(d1, d2);
      expect(result.compositionOp).toBe('union');
      expect(result.operands).toEqual(['urn:iep:d1', 'urn:iep:d2']);
    });
  });

  describe('intersection', () => {
    it('computes overlap of temporal intervals', () => {
      const result = intersection(d1, d2);
      const tf = result.facets.find(f => f.type === 'Temporal') as TemporalFacetData;
      expect(tf.validFrom).toBe('2026-03-01T00:00:00Z');
      expect(tf.validUntil).toBe('2026-06-30T23:59:59Z');
    });

    it('excludes facet types not in both operands', () => {
      const result = intersection(d1, d2);
      const types = new Set(result.facets.map(f => f.type));
      // Temporal is in both operands AND uses an arithmetic meet
      // (intersect-range) that always yields a non-empty result when the
      // intervals overlap. d1 [2026-01..2026-06] ∩ d2 [2026-03..2026-12]
      // = [2026-03..2026-06] — so Temporal survives.
      expect(types.has('Temporal')).toBe(true);
      // Semiotic is only on d2 — excluded by type-level meet.
      expect(types.has('Semiotic')).toBe(false);
      // Trust is on both operands BUT d1.Trust(alice, CryptographicallyVerified)
      // and d2.Trust(bob, ThirdPartyAttested) are distinct sign-instances.
      // Lattice meet at the instance level requires A ∧ B ≤ A, so disjoint
      // preserve-all instances drop out. (This is what makes absorption hold —
      // see verifyAbsorption + concurrent-cartographers ACT 9.)
      expect(types.has('Trust')).toBe(false);
    });

    it('keeps preserve-all instances that share a structural fingerprint', () => {
      const sharedIssuer = 'did:web:shared' as IRI;
      const a: ContextDescriptorData = {
        id: 'urn:iep:a' as IRI,
        describes: ['urn:graph:g' as IRI],
        facets: [
          { type: 'Trust', trustLevel: 'CryptographicallyVerified', issuer: sharedIssuer },
          { type: 'Trust', trustLevel: 'SelfAsserted', issuer: 'did:web:alice' as IRI },
        ],
      };
      const b: ContextDescriptorData = {
        id: 'urn:iep:b' as IRI,
        describes: ['urn:graph:g' as IRI],
        facets: [
          { type: 'Trust', trustLevel: 'CryptographicallyVerified', issuer: sharedIssuer },
          { type: 'Trust', trustLevel: 'ThirdPartyAttested', issuer: 'did:web:bob' as IRI },
        ],
      };
      const result = intersection(a, b);
      const trusts = result.facets.filter(f => f.type === 'Trust');
      expect(trusts).toHaveLength(1);
      expect((trusts[0] as { issuer: IRI }).issuer).toBe(sharedIssuer);
    });

    it('returns null temporal facet for non-overlapping intervals', () => {
      const d3: ContextDescriptorData = {
        id: 'urn:iep:d3' as IRI,
        describes: ['urn:graph:g' as IRI],
        facets: [
          { type: 'Temporal', validFrom: '2025-01-01T00:00:00Z', validUntil: '2025-06-30T23:59:59Z' },
        ],
      };
      const d4: ContextDescriptorData = {
        id: 'urn:iep:d4' as IRI,
        describes: ['urn:graph:g' as IRI],
        facets: [
          { type: 'Temporal', validFrom: '2026-01-01T00:00:00Z', validUntil: '2026-06-30T23:59:59Z' },
        ],
      };
      const result = intersection(d3, d4);
      const tf = result.facets.find(f => f.type === 'Temporal');
      expect(tf).toBeUndefined(); // no overlap
    });
  });

  describe('restriction', () => {
    it('projects to specified facet types only', () => {
      const result = restriction(d2, ['Temporal', 'Semiotic']);
      expect(result.facets).toHaveLength(2);
      const types = result.facets.map(f => f.type);
      expect(types).toContain('Temporal');
      expect(types).toContain('Semiotic');
      expect(types).not.toContain('Trust');
    });

    it('includes restrictToTypes metadata', () => {
      const result = restriction(d2, ['Temporal']);
      expect(result.restrictToTypes).toEqual(['Temporal']);
    });
  });

  describe('override', () => {
    it('replaces same-type facets from override descriptor', () => {
      const result = override(d1, d2);
      // d2's Temporal should override d1's Temporal
      const tf = result.facets.find(f => f.type === 'Temporal') as TemporalFacetData;
      expect(tf.validFrom).toBe('2026-03-01T00:00:00Z'); // from d2
    });

    it('preserves unique facets from both operands', () => {
      const result = override(d1, d2);
      const types = new Set(result.facets.map(f => f.type));
      expect(types.has('Semiotic')).toBe(true); // unique to d2
    });
  });

  describe('effectiveContext', () => {
    it('applies triple-level override to graph-level context', () => {
      const graphCtx = d1;
      const tripleFacets: SemioticFacetData[] = [
        { type: 'Semiotic', modalStatus: 'Hypothetical', epistemicConfidence: 0.3 },
      ];
      const result = effectiveContext(graphCtx, tripleFacets);
      const sf = result.facets.find(f => f.type === 'Semiotic') as SemioticFacetData;
      expect(sf.modalStatus).toBe('Hypothetical');
    });

    it('inherits graph-level facets not overridden', () => {
      const graphCtx = d1;
      const tripleFacets: SemioticFacetData[] = [
        { type: 'Semiotic', modalStatus: 'Quoted' },
      ];
      const result = effectiveContext(graphCtx, tripleFacets);
      const tf = result.facets.find(f => f.type === 'Temporal');
      expect(tf).toBeDefined(); // inherited from graph
    });

    it('returns graph context unchanged if no triple facets', () => {
      const result = effectiveContext(d1, []);
      expect(result).toBe(d1);
    });
  });
});

// ═════════════════════════════════════════════════════════════
//  Validation
// ═════════════════════════════════════════════════════════════

describe('Validation', () => {
  it('passes for a valid descriptor', () => {
    const desc = makeSimpleDescriptor('urn:iep:valid', 'urn:graph:g1');
    const result = validate(desc);
    expect(result.conforms).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('fails for missing facets', () => {
    const bad: ContextDescriptorData = {
      id: 'urn:iep:bad' as IRI,
      describes: ['urn:graph:g1' as IRI],
      facets: [],
    };
    const result = validate(bad);
    expect(result.conforms).toBe(false);
    expect(result.violations.some(v => v.path === 'facets')).toBe(true);
  });

  it('fails for missing describes', () => {
    const bad: ContextDescriptorData = {
      id: 'urn:iep:bad' as IRI,
      describes: [],
      facets: [{ type: 'Temporal', validFrom: '2026-01-01T00:00:00Z' }],
    };
    const result = validate(bad);
    expect(result.conforms).toBe(false);
  });

  it('validates temporal facet ordering', () => {
    const bad: ContextDescriptorData = {
      id: 'urn:iep:bad' as IRI,
      describes: ['urn:graph:g1' as IRI],
      facets: [{
        type: 'Temporal',
        validFrom: '2026-12-31T23:59:59Z',
        validUntil: '2026-01-01T00:00:00Z',
      }],
    };
    const result = validate(bad);
    expect(result.conforms).toBe(false);
    expect(result.violations.some(v => v.message.includes('after validFrom'))).toBe(true);
  });

  it('validates epistemicConfidence range', () => {
    const bad: ContextDescriptorData = {
      id: 'urn:iep:bad' as IRI,
      describes: ['urn:graph:g1' as IRI],
      facets: [{
        type: 'Semiotic',
        epistemicConfidence: -0.5,
      }],
    };
    const result = validate(bad);
    expect(result.conforms).toBe(false);
  });

  it('validates modal status enum', () => {
    const bad: ContextDescriptorData = {
      id: 'urn:iep:bad' as IRI,
      describes: ['urn:graph:g1' as IRI],
      facets: [{
        type: 'Semiotic',
        modalStatus: 'InvalidStatus' as any,
      }],
    };
    const result = validate(bad);
    expect(result.conforms).toBe(false);
  });

  it('assertValid throws with descriptive message', () => {
    const bad: ContextDescriptorData = {
      id: 'urn:iep:bad' as IRI,
      describes: [],
      facets: [],
    };
    expect(() => assertValid(bad)).toThrow('validation failed');
  });
});

// ═════════════════════════════════════════════════════════════
//  Turtle Serialization
// ═════════════════════════════════════════════════════════════

describe('Turtle Serialization', () => {
  it('produces valid Turtle with prefixes', () => {
    const desc = makeSimpleDescriptor('urn:iep:ttl-test', 'urn:graph:g1');
    const ttl = toTurtle(desc);

    expect(ttl).toContain('@prefix iep:');
    expect(ttl).toContain('@prefix prov:');
    expect(ttl).toContain('a iep:ContextDescriptor');
    expect(ttl).toContain('iep:describes <urn:graph:g1>');
    expect(ttl).toContain('a iep:TemporalFacet');
    expect(ttl).toContain('iep:validFrom');
  });

  it('serializes composed descriptors', () => {
    const d1 = makeSimpleDescriptor('urn:iep:d1', 'urn:graph:g1');
    const d2 = makeSimpleDescriptor('urn:iep:d2', 'urn:graph:g1');
    resetComposedIdCounter();
    const composed = union(d1, d2);
    const ttl = toTurtle(composed);

    expect(ttl).toContain('a iep:ComposedDescriptor');
    expect(ttl).toContain('iep:compositionOp iep:union');
    expect(ttl).toContain('iep:operand <urn:iep:d1>');
  });

  it('can skip prefix declarations', () => {
    const desc = makeSimpleDescriptor('urn:iep:no-prefix', 'urn:graph:g1');
    const ttl = toTurtle(desc, { prefixes: false });
    expect(ttl).not.toContain('@prefix');
  });
});

// ═════════════════════════════════════════════════════════════
//  JSON-LD Serialization
// ═════════════════════════════════════════════════════════════

describe('JSON-LD Serialization', () => {
  it('produces valid compact JSON-LD', () => {
    const desc = makeSimpleDescriptor('urn:iep:jsonld-test', 'urn:graph:g1');
    const json = toJsonLd(desc);

    expect(json['@context']).toBeDefined();
    expect(json['@id']).toBe('urn:iep:jsonld-test');
    expect(json['@type']).toBe('ContextDescriptor');
    expect(json.describes).toBe('urn:graph:g1');
    expect(json.hasFacet).toHaveLength(1);
  });

  it('round-trips through fromJsonLd', () => {
    const desc = ContextDescriptor.create('urn:iep:roundtrip' as IRI)
.describes('urn:graph:g1' as IRI)
.temporal({
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2026-06-30T23:59:59Z',
      })
.semiotic({
        modalStatus: 'Asserted',
        epistemicConfidence: 0.9,
      })
.build();

    const json = toJsonLd(desc);
    const parsed = fromJsonLd(json);

    expect(parsed.id).toBe(desc.id);
    expect(parsed.describes).toEqual(desc.describes);
    expect(parsed.facets).toHaveLength(2);
  });

  it('serializes to string', () => {
    const desc = makeSimpleDescriptor('urn:iep:str', 'urn:graph:g1');
    const str = toJsonLdString(desc);
    expect(() => JSON.parse(str)).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════
//  Namespaces
// ═════════════════════════════════════════════════════════════

describe('Namespaces', () => {
  it('expand resolves prefixed names', () => {
    expect(expand('iep:ContextDescriptor'))
.toBe('https://markjspivey-xwisee.github.io/interego/ns/iep#ContextDescriptor');
    expect(expand('prov:Entity'))
.toBe('http://www.w3.org/ns/prov#Entity');
  });

  it('compact produces prefixed names', () => {
    expect(compact(`${CG}ContextDescriptor`)).toBe('iep:ContextDescriptor');
    expect(compact(`${PROV}Entity`)).toBe('prov:Entity');
  });

  it('CGClass contains all class IRIs', () => {
    expect(CGClass.ContextDescriptor).toBe(`${CG}ContextDescriptor`);
    expect(CGClass.SemioticFacet).toBe(`${CG}SemioticFacet`);
  });

  it('CGProp contains all property IRIs', () => {
    expect(CGProp.describes).toBe(`${CG}describes`);
    expect(CGProp.epistemicConfidence).toBe(`${CG}epistemicConfidence`);
  });
});

// ═════════════════════════════════════════════════════════════
//  SPARQL Patterns
// ═════════════════════════════════════════════════════════════

describe('SPARQL Patterns', () => {
  it('generates context query for a graph', () => {
    const q = queryContextForGraph('urn:graph:g1');
    expect(q).toContain('PREFIX iep:');
    expect(q).toContain('iep:describes <urn:graph:g1>');
    expect(q).toContain('SELECT');
  });

  it('generates temporal filter query', () => {
    const q = queryGraphsAtTime('2026-03-17T12:00:00Z');
    expect(q).toContain('FILTER');
    expect(q).toContain('2026-03-17T12:00:00Z');
  });

  it('generates modal status query', () => {
    const q = queryGraphsByModalStatus('Asserted');
    expect(q).toContain('iep:modalStatus iep:Asserted');
    expect(q).toContain('ORDER BY DESC(?confidence)');
  });

  it('generates ASK query', () => {
    const q = askHasContextType('urn:graph:g1', 'Temporal');
    expect(q).toContain('ASK');
    expect(q).toContain('iep:TemporalFacet');
  });
});

// ═════════════════════════════════════════════════════════════
//  SHACL Shapes
// ═════════════════════════════════════════════════════════════

describe('SHACL Shapes', () => {
  it('exports valid Turtle shapes', () => {
    const shapes = getShaclShapesTurtle();
    expect(shapes).toContain('sh:targetClass iep:ContextDescriptor');
    expect(shapes).toContain('sh:minCount 1');
    expect(shapes).toContain('iep:SemioticFacetShape');
    expect(shapes).toContain('sh:minInclusive 0.0');
    expect(shapes).toContain('sh:maxInclusive 1.0');
  });
});
