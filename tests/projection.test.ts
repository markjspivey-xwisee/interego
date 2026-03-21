/**
 * Tests for Projection Facet and RDF 1.2 Triple Annotations
 */

import { describe, it, expect } from 'vitest';
import {
  ContextDescriptor,
  toTurtle,
  toJsonLdString,
  toTripleAnnotationTurtle,
  toTripleAnnotationDocument,
  validate,
} from '../src/index.js';
import type { IRI, TripleContextAnnotation } from '../src/index.js';

// ═════════════════════════════════════════════════════════════
//  Projection Facet Builder
// ═════════════════════════════════════════════════════════════

describe('Projection Facet Builder', () => {
  it('builds with explicit projection()', () => {
    const desc = ContextDescriptor.create('urn:cg:proj' as IRI)
      .describes('urn:graph:data' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .projection({
        targetVocabulary: 'http://schema.org/' as IRI,
        bindings: [
          {
            source: 'urn:internal:Person' as IRI,
            target: 'http://schema.org/Person' as IRI,
            strength: 'Strong',
            confidence: 0.95,
          },
        ],
        vocabularyMappings: [
          {
            source: 'urn:internal:name' as IRI,
            target: 'http://schema.org/name' as IRI,
            mappingType: 'property',
            relationship: 'exact',
          },
        ],
      })
      .build();

    const proj = desc.facets.find(f => f.type === 'Projection');
    expect(proj).toBeDefined();
    if (proj?.type === 'Projection') {
      expect(proj.bindings).toHaveLength(1);
      expect(proj.bindings![0]!.strength).toBe('Strong');
      expect(proj.vocabularyMappings).toHaveLength(1);
      expect(proj.vocabularyMappings![0]!.relationship).toBe('exact');
    }
  });

  it('builds with bindsTo() convenience', () => {
    const desc = ContextDescriptor.create('urn:cg:bind' as IRI)
      .describes('urn:graph:data' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .bindsTo(
        'urn:internal:Vancouver' as IRI,
        'https://sws.geonames.org/6173331/' as IRI,
        'Strong',
        0.97,
      )
      .bindsTo(
        'urn:internal:Vancouver' as IRI,
        'https://www.wikidata.org/entity/Q24639' as IRI,
        'Approximate',
      )
      .build();

    const proj = desc.facets.find(f => f.type === 'Projection');
    expect(proj).toBeDefined();
    if (proj?.type === 'Projection') {
      expect(proj.bindings).toHaveLength(2);
      expect(proj.bindings![0]!.strength).toBe('Strong');
      expect(proj.bindings![1]!.strength).toBe('Approximate');
    }
  });

  it('builds with mapsVocabulary() convenience', () => {
    const desc = ContextDescriptor.create('urn:cg:map' as IRI)
      .describes('urn:graph:data' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .mapsVocabulary(
        'urn:internal:Person' as IRI,
        'http://schema.org/Person' as IRI,
        'class',
        'exact',
      )
      .mapsVocabulary(
        'urn:internal:hasName' as IRI,
        'http://schema.org/name' as IRI,
        'property',
        'broader',
      )
      .build();

    const proj = desc.facets.find(f => f.type === 'Projection');
    expect(proj).toBeDefined();
    if (proj?.type === 'Projection') {
      expect(proj.vocabularyMappings).toHaveLength(2);
      expect(proj.vocabularyMappings![1]!.relationship).toBe('broader');
    }
  });

  it('accumulates bindings and mappings on same facet', () => {
    const desc = ContextDescriptor.create('urn:cg:combo' as IRI)
      .describes('urn:graph:data' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .bindsTo('urn:a' as IRI, 'urn:ext:a' as IRI)
      .mapsVocabulary('urn:p' as IRI, 'urn:ext:p' as IRI, 'property')
      .build();

    const projFacets = desc.facets.filter(f => f.type === 'Projection');
    expect(projFacets).toHaveLength(1); // single facet, not two
    if (projFacets[0]?.type === 'Projection') {
      expect(projFacets[0].bindings).toHaveLength(1);
      expect(projFacets[0].vocabularyMappings).toHaveLength(1);
    }
  });
});

// ═════════════════════════════════════════════════════════════
//  Projection Serialization
// ═════════════════════════════════════════════════════════════

describe('Projection Serialization', () => {
  it('serializes to Turtle', () => {
    const desc = ContextDescriptor.create('urn:cg:proj' as IRI)
      .describes('urn:graph:data' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .bindsTo(
        'urn:internal:City' as IRI,
        'http://schema.org/City' as IRI,
        'Strong',
        0.9,
      )
      .build();

    const turtle = toTurtle(desc);
    expect(turtle).toContain('cg:ProjectionFacet');
    expect(turtle).toContain('cg:ExternalBinding');
    expect(turtle).toContain('cg:bindingStrength cg:Strong');
    expect(turtle).toContain('<http://schema.org/City>');
  });

  it('serializes vocabulary mappings to Turtle', () => {
    const desc = ContextDescriptor.create('urn:cg:map' as IRI)
      .describes('urn:graph:data' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .mapsVocabulary(
        'urn:internal:Person' as IRI,
        'http://schema.org/Person' as IRI,
        'class',
        'exact',
      )
      .build();

    const turtle = toTurtle(desc);
    expect(turtle).toContain('cg:VocabularyMapping');
    expect(turtle).toContain('cg:mappingType "class"');
    expect(turtle).toContain('cg:mappingRelationship "exact"');
  });

  it('serializes to JSON-LD', () => {
    const desc = ContextDescriptor.create('urn:cg:proj' as IRI)
      .describes('urn:graph:data' as IRI)
      .temporal({ validFrom: '2026-01-01T00:00:00Z' })
      .bindsTo('urn:a' as IRI, 'urn:ext:a' as IRI, 'Approximate')
      .build();

    const jsonld = toJsonLdString(desc, { pretty: true });
    expect(jsonld).toContain('cg:ProjectionFacet');
    expect(jsonld).toContain('cg:Approximate');
  });
});

// ═════════════════════════════════════════════════════════════
//  Projection Validation
// ═════════════════════════════════════════════════════════════

describe('Projection Validation', () => {
  it('validates well-formed projection', () => {
    const desc = ContextDescriptor.create('urn:cg:ok' as IRI)
      .describes('urn:graph:data' as IRI)
      .bindsTo('urn:a' as IRI, 'urn:ext:a' as IRI, 'Strong', 0.9)
      .build();
    expect(validate(desc).conforms).toBe(true);
  });

  it('rejects invalid binding strength', () => {
    const desc = {
      id: 'urn:cg:bad' as IRI,
      describes: ['urn:graph:x' as IRI],
      facets: [{
        type: 'Projection' as const,
        bindings: [{
          source: 'urn:a' as IRI,
          target: 'urn:b' as IRI,
          strength: 'Invalid' as never,
        }],
      }],
    };
    const result = validate(desc);
    expect(result.conforms).toBe(false);
    expect(result.violations.some(v => v.message.includes('binding strength'))).toBe(true);
  });

  it('rejects binding confidence > 1', () => {
    const desc = {
      id: 'urn:cg:bad' as IRI,
      describes: ['urn:graph:x' as IRI],
      facets: [{
        type: 'Projection' as const,
        bindings: [{
          source: 'urn:a' as IRI,
          target: 'urn:b' as IRI,
          strength: 'Strong' as const,
          confidence: 1.5,
        }],
      }],
    };
    const result = validate(desc);
    expect(result.conforms).toBe(false);
  });

  it('rejects invalid mapping type', () => {
    const desc = {
      id: 'urn:cg:bad' as IRI,
      describes: ['urn:graph:x' as IRI],
      facets: [{
        type: 'Projection' as const,
        vocabularyMappings: [{
          source: 'urn:a' as IRI,
          target: 'urn:b' as IRI,
          mappingType: 'invalid' as never,
          relationship: 'exact' as const,
        }],
      }],
    };
    const result = validate(desc);
    expect(result.conforms).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════
//  RDF 1.2 Triple Annotations
// ═════════════════════════════════════════════════════════════

describe('RDF 1.2 Triple Annotations', () => {
  it('serializes a triple with annotation', () => {
    const annotation: TripleContextAnnotation = {
      triple: {
        subject: 'urn:entity:vancouver' as IRI,
        predicate: 'http://schema.org/name' as IRI,
        object: { value: 'Vancouver', datatype: 'http://www.w3.org/2001/XMLSchema#string' as IRI },
      },
      facets: [
        {
          type: 'Provenance',
          wasAttributedTo: 'urn:agent:curator' as IRI,
          generatedAtTime: '2026-03-20T00:00:00Z',
        },
        {
          type: 'Semiotic',
          epistemicConfidence: 0.97,
          modalStatus: 'Asserted',
        },
      ],
    };

    const turtle = toTripleAnnotationTurtle(annotation);
    expect(turtle).toContain('{|');
    expect(turtle).toContain('|}');
    expect(turtle).toContain('cg:ProvenanceFacet');
    expect(turtle).toContain('cg:SemioticFacet');
    expect(turtle).toContain('<urn:entity:vancouver>');
  });

  it('serializes a triple with IRI object', () => {
    const annotation: TripleContextAnnotation = {
      triple: {
        subject: 'urn:entity:vancouver' as IRI,
        predicate: 'http://schema.org/containedInPlace' as IRI,
        object: 'urn:entity:bc' as IRI,
      },
      facets: [
        { type: 'Temporal', validFrom: '2026-01-01T00:00:00Z' },
      ],
    };

    const turtle = toTripleAnnotationTurtle(annotation);
    expect(turtle).toContain('<urn:entity:bc>');
    expect(turtle).toContain('{|');
    expect(turtle).toContain('cg:TemporalFacet');
  });

  it('serializes triple without annotation', () => {
    const annotation: TripleContextAnnotation = {
      triple: {
        subject: 'urn:a' as IRI,
        predicate: 'urn:p' as IRI,
        object: 'urn:b' as IRI,
      },
      facets: [],
    };

    const turtle = toTripleAnnotationTurtle(annotation);
    expect(turtle).toContain('<urn:a> <urn:p> <urn:b> .');
    expect(turtle).not.toContain('{|');
  });

  it('serializes multiple annotations as a document', () => {
    const annotations: TripleContextAnnotation[] = [
      {
        triple: { subject: 'urn:a' as IRI, predicate: 'urn:p' as IRI, object: 'urn:b' as IRI },
        facets: [{ type: 'Temporal', validFrom: '2026-01-01T00:00:00Z' }],
      },
      {
        triple: { subject: 'urn:c' as IRI, predicate: 'urn:q' as IRI, object: 'urn:d' as IRI },
        facets: [{ type: 'Semiotic', modalStatus: 'Hypothetical' }],
      },
    ];

    const doc = toTripleAnnotationDocument(annotations);
    expect(doc).toContain('<urn:a>');
    expect(doc).toContain('<urn:c>');
    // Prefixes only once
    const prefixCount = (doc.match(/@prefix cg:/g) || []).length;
    expect(prefixCount).toBe(1);
  });
});
