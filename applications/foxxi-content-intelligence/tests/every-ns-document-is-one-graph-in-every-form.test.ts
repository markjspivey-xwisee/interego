/**
 * Every Foxxi /ns document is one graph in every form it is served in, and says who made it and
 * which version it is.
 *
 * ★ WHY. The documents are served by content negotiation as Turtle, N-Triples, RDF/XML and JSON-LD,
 * from one graph — a claim nothing checked, and the kind of thing that breaks quietly (a Turtle
 * writer that once wrote `sh:path a`, a JSON-LD context that drops a term). Each document's header
 * also says that the content at a version IRI never changes and that a test pins it: this is that
 * test. Every representation is read back with an independent processor (n3, jsonld,
 * rdfxml-streaming-parser) and compared as RDF (RDFC-1.0 canonical form), never as text.
 *
 * ★ REVISED. This file also held each version's content to a pin: the SHA-256 of the document's
 * RDFC-1.0 canonical form, kept per version in tests/support/ns-version-pins.json. A pin could say
 * that a version's content had changed, but not what the content had been, and the bridge could not
 * serve a version from a hash. Released versions are now archived whole in ns-releases/, and
 * tests/every-released-version-stays-resolvable.test.ts holds the documents to their archived
 * graphs and the archive to its SHA256SUMS; the pins are gone.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Quad } from 'n3';
import { turtleQuads, ntriplesQuads, jsonLdQuads, rdfXmlQuads, canonical, OWL, RDFS, DCT, RDF_TYPE } from './support/ns-graph.js';
import { portablePattern, xsdRegex } from '../src/spec-ontology.js';
import { isXapiDuration } from '../src/xapi-duration.js';
import { publishedArtifacts } from '../src/ns/published.js';

interface Doc {
  readonly iri: string; readonly version: string; readonly kind: 'ontology' | 'shapes';
  readonly turtle: () => string; readonly ntriples: () => string; readonly rdfxml: () => string; readonly jsonld: () => unknown;
}
/** The documents the bridge publishes (src/ns/published.ts), each with its four forms. */
const DOCS: Doc[] = publishedArtifacts().flatMap((a): Doc[] => (a.kind === 'ontology' || a.kind === 'shapes') && a.forms
  ? [{ iri: a.iri, version: a.version, kind: a.kind, turtle: a.render, ...a.forms }] : []);
const CALVER = /^(\d{4})\.(\d{1,2})\.(\d+)$/;

it('covers all fourteen ontologies and their twelve shapes graphs', () => {
  expect(DOCS.filter(d => d.kind === 'ontology')).toHaveLength(14);
  expect(DOCS.filter(d => d.kind === 'shapes')).toHaveLength(12);
  expect(new Set(DOCS.map(d => d.iri)).size).toBe(DOCS.length);
});

for (const doc of DOCS) {
  describe(doc.iri.replace('https://foxxi-bridge.interego.xwisee.com/ns/', '/ns/'), () => {
    let quads: Quad[] = [];
    let canon = '';
    beforeAll(async () => {
      quads = turtleQuads(doc.turtle());
      canon = await canonical(quads);
    });

    it('is the same graph as Turtle, N-Triples, RDF/XML and JSON-LD', async () => {
      expect(quads.length).toBeGreaterThan(20);
      expect(await canonical(ntriplesQuads(doc.ntriples())), 'N-Triples').toBe(canon);
      expect(await canonical(await rdfXmlQuads(doc.rdfxml(), doc.iri)), 'RDF/XML').toBe(canon);
      expect(await canonical(await jsonLdQuads(doc.jsonld())), 'JSON-LD').toBe(canon);
    });

    it('says what it is, whose it is, under what licence and which version this is', () => {
      const of = (p: string): string[] => quads.filter(q => q.subject.value === doc.iri && q.predicate.value === p).map(q => q.object.value);
      expect(of(RDF_TYPE)).toContain(`${OWL}Ontology`);
      expect(doc.version).toMatch(CALVER);
      expect(of(`${OWL}versionIRI`)).toEqual([`${doc.iri}/${doc.version}`]);
      expect(of(`${OWL}versionInfo`)).toEqual([doc.version]);
      expect(of(`${DCT}license`)).toEqual(['https://opensource.org/licenses/MIT']);
      expect(of(`${DCT}creator`)).toEqual(['Mark Spivey']);
      expect(of(`${DCT}publisher`)).toEqual(['Foxxi Mediums Inc.']);
      expect(of(`${DCT}title`).length).toBe(1);
      expect(of(`${DCT}description`).length).toBe(1);
      expect(of(`${RDFS}comment`).some(c => /affiliated with or endors/.test(c)), 'carries its non-affiliation notice').toBe(true);
      if (doc.kind === 'ontology') expect(of('http://purl.org/vocab/vann/preferredNamespacePrefix')[0]).toMatch(/^foxxi(-[a-z0-9-]+)?$/);
      else expect(of(`${OWL}imports`).length).toBe(1);
    });

    it('names nothing on foxximediums.com, which is not a website', () => {
      expect(quads.filter(q => [q.subject, q.predicate, q.object].some(t => t.termType === 'NamedNode' && /foxximediums\.com/i.test(t.value)))).toEqual([]);
    });
  });
}

describe('patterns are written once, in the regex every reader shares', () => {
  const ontologyQuads = DOCS.filter(d => d.kind === 'ontology').flatMap(d => turtleQuads(d.turtle()));
  const shapeQuads = DOCS.filter(d => d.kind === 'shapes').flatMap(d => turtleQuads(d.turtle()));
  const facets = ontologyQuads.filter(q => q.predicate.value === 'http://www.w3.org/2001/XMLSchema#pattern').map(q => q.object.value);
  const shPatterns = shapeQuads.filter(q => q.predicate.value === 'http://www.w3.org/ns/shacl#pattern').map(q => q.object.value);

  it('an OWL facet is unanchored: XML Schema regexes match the whole value and read ^ and $ as characters', () => {
    expect(facets.length).toBeGreaterThan(5);
    for (const f of facets) {
      expect(f.startsWith('^') || /(^|[^\\])\$$/.test(f), f).toBe(false);
      expect(() => portablePattern(`^${f}$`), f).not.toThrow();
    }
  });

  it('a SHACL pattern is anchored: SPARQL regex finds a match anywhere unless told otherwise', () => {
    expect(shPatterns.length).toBeGreaterThan(10);
    for (const p of shPatterns) {
      // Anchored at the start always (a prefix test such as ^mailto: is a pattern of its own); a
      // datatype's pattern at both ends, and those are the same text as its OWL facet.
      expect(p.startsWith('^'), p).toBe(true);
      expect(() => portablePattern(p), p).not.toThrow();
    }
    const whole = shPatterns.filter(p => /(^|[^\\])\$$/.test(p)).map(p => p.slice(1, -1));
    for (const f of facets) expect(whole, `the facet ${f} is also a SHACL pattern`).toContain(f);
  });

  it('read as XML Schema reads them, the facets accept what the standards allow and nothing else', () => {
    const xsd = (f: string): RegExp => new RegExp(`^(?:${f})$`, 'u');
    const facetOf = (doc: string, name: string): RegExp => {
      const q = turtleQuads(DOCS.find(d => d.iri.endsWith(`/ns/${doc}`))!.turtle());
      const dt = `https://foxxi-bridge.interego.xwisee.com/ns/${doc}#${name}`;
      // DatatypeDefinition: dt owl:equivalentClass [ owl:onDatatype …; owl:withRestrictions ( [ xsd:pattern "…" ] ) ],
      // read by following the blank nodes from the datatype.
      const reachable = new Set<string>([dt]);
      for (let grew = true; grew;) {
        grew = false;
        for (const t of q) if (reachable.has(t.subject.value) && t.object.termType === 'BlankNode' && !reachable.has(t.object.value)) { reachable.add(t.object.value); grew = true; }
      }
      const p = q.find(t => reachable.has(t.subject.value) && t.predicate.value === 'http://www.w3.org/2001/XMLSchema#pattern');
      expect(p, `${doc}#${name} has a pattern facet`).toBeDefined();
      return xsd(p!.object.value);
    };
    const uuid = facetOf('xapi', 'UUID');
    expect(uuid.test('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
    expect(uuid.test('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true);
    expect(uuid.test('f47ac10b58cc4372a5670e02b2c3d479')).toBe(false);
    const duration = facetOf('xapi', 'Duration');
    // Only the lowest-order component present may carry a fraction (ISO 8601:2004 §4.4.3.2) — and
    // the LRS's own check (xapi-duration.ts) takes exactly what the published facet takes.
    const goodDurations = ['PT1H30M', 'P1D', 'P1W', 'PT0.5S', 'P1Y2M3DT4H5M6S', 'P1Y2.5M', 'PT1.5H', 'P1DT0.5S', 'P0.5Y'];
    const badDurations = ['P', 'PT', 'P1W2D', '1H', 'P1H', 'P1.5Y2M', 'PT1.5H30M', 'P0.5DT1H', 'PT1H0.5M2S'];
    for (const ok of goodDurations) { expect(duration.test(ok), ok).toBe(true); expect(isXapiDuration(ok), ok).toBe(true); }
    for (const bad of badDurations) { expect(duration.test(bad), bad).toBe(false); expect(isXapiDuration(bad), bad).toBe(false); }
    const snDuration = facetOf('scorm-sn', 'Duration');
    expect(snDuration.test('PT30M')).toBe(true);
    expect(snDuration.test('P2W')).toBe(false);
  });

  it('the portable subset refuses what one of the readers would read differently', () => {
    for (const bad of ['^\\d+$', '^\\w+$', '^(?:a|b)$', '^a(?=b)$', '^a\\b$', 'a^b', '^a$b$']) expect(() => portablePattern(bad), bad).toThrow();
    expect(xsdRegex('^[0-9]{4}$')).toBe('[0-9]{4}');
    expect(() => xsdRegex('[0-9]{4}')).toThrow();
  });
});
