/**
 * Spec-ontology engine + xAPI model: the OWL/SHACL projections render, and the
 * model-driven validator accepts a conformant statement / rejects a malformed one
 * citing the dereferenceable sh:NodeShape IRIs (the LRS's ontology-driven path).
 */
import { describe, it, expect } from 'vitest';
import { renderOwl, renderShacl, renderJsonLd, ontologyIri, shapesIri, ns } from '../src/spec-ontology.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import { validateXapiStatement } from '../src/spec/index.js';
import { turtleQuads, iriObjectsOf, objectsOf, subjectsOfType, RDFS, OWL, SKOS } from './support/ns-graph.js';

// ★ REVISED: read as triples. These checks matched Turtle text (`xapi:Statement a owl:Class`), which
// stopped meaning anything when the document's own prefix became `foxxi-xapi:` and `xapi:` began to
// mean ADL's ontology. What the document SAYS is the same; how it is spelled is not the test.
const SH = 'http://www.w3.org/ns/shacl#';
const X = ns(XAPI_MODEL);

describe('xAPI ontology OWL projection', () => {
  const q = turtleQuads(renderOwl(XAPI_MODEL));
  it('declares the ontology + core classes + properties', () => {
    expect(subjectsOfType(q, `${OWL}Ontology`)).toContain(ontologyIri(XAPI_MODEL));
    expect(subjectsOfType(q, `${OWL}Class`)).toEqual(expect.arrayContaining([`${X}Statement`, `${X}Verb`]));
    expect(subjectsOfType(q, `${OWL}ObjectProperty`)).toContain(`${X}actor`);
    expect(subjectsOfType(q, `${OWL}DatatypeProperty`)).toContain(`${X}scaled`);
    expect(iriObjectsOf(q, `${X}scaled`, `${RDFS}domain`)).toEqual([`${X}Score`]);
  });
  it('emits the interactionType SKOS vocabulary', () => {
    expect(subjectsOfType(q, `${SKOS}ConceptScheme`)).toContain(`${X}InteractionType`);
    // Member IRIs are scheme-scoped (InteractionType-choice) so members from different
    // schemes with the same enum value do not collide onto one IRI.
    expect(subjectsOfType(q, `${SKOS}Concept`)).toContain(`${X}InteractionType-choice`);
  });
});

describe('xAPI ontology SHACL projection', () => {
  const q = turtleQuads(renderShacl(XAPI_MODEL));
  const statementShape = `${shapesIri(XAPI_MODEL)}#StatementShape`;
  /** The property shapes (blank nodes) of a node shape. */
  const props = (shape: string): string[] => q.filter(t => t.subject.value === shape && t.predicate.value === `${SH}property`).map(t => t.object.value);
  it('emits node shapes targeting the classes with constraints', () => {
    expect(subjectsOfType(q, `${SH}NodeShape`)).toContain(statementShape);
    expect(iriObjectsOf(q, statementShape, `${SH}targetClass`)).toEqual([`${X}Statement`]);
    const actor = props(statementShape).find(p => iriObjectsOf(q, p, `${SH}path`).includes(`${X}actor`));
    expect(actor).toBeDefined();
    expect(objectsOf(q, actor!, `${SH}minCount`)).toEqual(['1']);
    // Score.scaled is bounded below by -1.
    const scaled = props(`${shapesIri(XAPI_MODEL)}#ScoreShape`).find(p => iriObjectsOf(q, p, `${SH}path`).includes(`${X}scaled`));
    expect(objectsOf(q, scaled!, `${SH}minInclusive`)).toEqual(['-1']);
  });
});

describe('renderJsonLd', () => {
  // ★ REVISED. This held the document to HAL `_links` beside its @graph (shapes, validate). JSON-LD
  // processing drops such members, and a processor in safe mode — the bar this vertical sets for its
  // own records — refused every ontology for them. The links are in the graph now (rdfs:seeAlso the
  // shapes, whose description names the validator) and in the response's Link header.
  it('is JSON-LD alone: a flat @graph, and the shapes and the validator reached through the graph', () => {
    const j = renderJsonLd(XAPI_MODEL) as any;
    // Nodes live in a flat @graph (so JSON-LD expansion yields real class/property triples).
    expect(j['@graph'][0]['@id']).toBe(ontologyIri(XAPI_MODEL));
    expect(j['@graph'].some((n: any) => n['@type'] === 'owl:Class')).toBe(true);
    expect(Object.keys(j).sort()).toEqual(['@context', '@graph']);
    expect(iriObjectsOf(turtleQuads(renderOwl(XAPI_MODEL)), ontologyIri(XAPI_MODEL), `${RDFS}seeAlso`)).toContain(shapesIri(XAPI_MODEL));
    expect(turtleQuads(renderShacl(XAPI_MODEL)).find(t => t.subject.value === shapesIri(XAPI_MODEL) && t.predicate.value === 'http://purl.org/dc/terms/description')?.object.value)
      .toContain(`POST ${ontologyIri(XAPI_MODEL)}/validate`);
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

  it('enforces the Agent single-IFI rule (§4.1.2.1)', () => {
    const base = { verb: { id: 'http://adlnet.gov/expapi/verbs/x' }, object: { id: 'http://x/1', objectType: 'Activity' } };
    const oneIfi = validateXapiStatement({ ...base, actor: { objectType: 'Agent', mbox: 'mailto:a@x.org' } });
    expect(oneIfi.results.some(r => /one of/.test(r.message))).toBe(false); // exactly one IFI → ok
    const zeroIfi = validateXapiStatement({ ...base, actor: { objectType: 'Agent', name: 'No IFI' } });
    expect(zeroIfi.results.some(r => /exactly one of/.test(r.message))).toBe(true);
    const twoIfi = validateXapiStatement({ ...base, actor: { objectType: 'Agent', mbox: 'mailto:a@x.org', openid: 'http://x/openid' } });
    expect(twoIfi.results.some(r => /exactly one of/.test(r.message))).toBe(true);
  });

  // ★ REVISED: this asserted that a Group with members AND an IFI is rejected. xAPI says otherwise —
  // an Identified Group may list its members (2.0 §5.2.2.1, Actor as Identified Group:
  // member Optional; 1.0.3 §4.1.2.2 the same) — and the LRS's own validator always accepted one, so
  // the public oracle refused statements the LRS stored. GroupShape now states the rule: an
  // Identified Group (exactly one IFI, members optional) or an Anonymous Group (members, no IFI).
  it('allows an anonymous Group and an Identified Group that lists its members; rejects a Group with neither (§5.2.2.1)', () => {
    const base = { verb: { id: 'http://adlnet.gov/expapi/verbs/x' }, object: { id: 'http://x/1', objectType: 'Activity' } };
    const anon = validateXapiStatement({ ...base, actor: { objectType: 'Group', member: [{ objectType: 'Agent', mbox: 'mailto:a@x.org' }] } });
    expect(anon.results.some(r => /Group/.test(r.message) || /GroupShape/.test(r.sourceShape))).toBe(false);
    const identified = validateXapiStatement({ ...base, actor: { objectType: 'Group', mbox: 'mailto:g@x.org', member: [{ mbox: 'mailto:a@x.org' }] } });
    expect(identified.results.some(r => /GroupShape/.test(r.sourceShape))).toBe(false);
    const neither = validateXapiStatement({ ...base, actor: { objectType: 'Group', name: 'Nobody' } });
    expect(neither.results.some(r => r.sourceShape.endsWith('#GroupShape') && /IdentifiedGroupShape, AnonymousGroupShape/.test(r.message))).toBe(true);
  });
});
