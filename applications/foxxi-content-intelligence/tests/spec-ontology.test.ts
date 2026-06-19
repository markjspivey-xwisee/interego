/**
 * Spec-ontology engine + xAPI model: the OWL/SHACL projections render, and the
 * model-driven validator accepts a conformant statement / rejects a malformed one
 * citing the dereferenceable sh:NodeShape IRIs (the LRS's ontology-driven path).
 */
import { describe, it, expect } from 'vitest';
import { renderOwl, renderShacl, renderJsonLd, ontologyIri, shapesIri } from '../src/spec-ontology.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import { validateXapiStatement } from '../src/spec/index.js';

describe('xAPI ontology OWL projection', () => {
  const ttl = renderOwl(XAPI_MODEL);
  it('declares the ontology + core classes + properties', () => {
    expect(ttl).toContain(`<${ontologyIri(XAPI_MODEL)}> a owl:Ontology`);
    expect(ttl).toContain('xapi:Statement a owl:Class');
    expect(ttl).toContain('xapi:Verb a owl:Class');
    expect(ttl).toContain('xapi:actor a owl:ObjectProperty');
    expect(ttl).toContain('xapi:scaled a owl:DatatypeProperty');
    expect(ttl).toContain('rdfs:domain xapi:Score');
  });
  it('emits the interactionType SKOS vocabulary', () => {
    expect(ttl).toContain('xapi:InteractionType a skos:ConceptScheme');
    expect(ttl).toContain('xapi:choice a skos:Concept');
  });
});

describe('xAPI ontology SHACL projection', () => {
  const sh = renderShacl(XAPI_MODEL);
  it('emits node shapes targeting the classes with constraints', () => {
    expect(sh).toContain('a sh:NodeShape');
    expect(sh).toContain('sh:targetClass xapi:Statement');
    expect(sh).toContain('sh:path xapi:actor');
    expect(sh).toContain('sh:minCount 1');
    expect(sh).toContain('sh:minInclusive -1'); // Score.scaled bound
  });
});

describe('renderJsonLd', () => {
  it('carries HATEOAS _links incl shapes + validate', () => {
    const j = renderJsonLd(XAPI_MODEL) as any;
    expect(j['@id']).toBe(ontologyIri(XAPI_MODEL));
    expect(j._links.shapes.href).toBe(shapesIri(XAPI_MODEL));
    expect(j._links.validate.method).toBe('POST');
  });
});

describe('validateXapiStatement (ontology-driven)', () => {
  it('accepts a conformant statement', () => {
    const good = {
      id: '12345678-1234-1234-1234-1234567890ab',
      actor: { objectType: 'Agent', mbox: 'mailto:a@example.org' },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { en: 'completed' } },
      object: { id: 'http://example.org/course/1', objectType: 'Activity', definition: { interactionType: 'choice' } },
      result: { success: true, completion: true, duration: 'PT1H', score: { scaled: 0.9 } },
      timestamp: '2026-06-19T10:00:00Z', version: '2.0.0',
    };
    const r = validateXapiStatement(good);
    expect(r.conforms).toBe(true);
    expect(r.results).toHaveLength(0);
  });

  it('rejects a malformed statement and cites the shape IRIs', () => {
    const bad = {
      id: 'not-a-uuid',
      actor: { objectType: 'Agent', mbox: 'mailto:a@example.org' },
      // verb missing → StatementShape violation; object missing → violation
      object: { objectType: 'Activity' }, // Activity missing id → ActivityShape violation
      result: { success: 'yes', score: { scaled: 2 } }, // success not boolean; scaled > 1
      timestamp: 'yesterday',
      version: '9.9',
    };
    const r = validateXapiStatement(bad);
    expect(r.conforms).toBe(false);
    const paths = r.results.map(x => x.path);
    expect(paths).toContain('verb');        // missing required verb
    expect(paths).toContain('id');          // bad UUID
    expect(paths).toContain('scaled');      // out of [-1,1]
    expect(paths).toContain('timestamp');   // bad dateTime
    expect(r.results.every(x => x.sourceShape.startsWith(shapesIri(XAPI_MODEL) + '#'))).toBe(true);
  });
});
