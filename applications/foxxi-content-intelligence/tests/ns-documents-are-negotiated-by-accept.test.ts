/**
 * A /ns document is served in the representation the client's Accept header asks for, by RFC 9110
 * §12.5.1 proactive negotiation — q-values, the most specific matching range, the document's own
 * order for ties — and 406 when nothing it offers is acceptable.
 *
 * ★ WHY. The routes used to pick by `accept.includes('text/turtle')`: `text/turtle;q=0` got Turtle,
 * a client asking only for RDF/XML (OWL API, ROBOT, Protégé ask for it first) got JSON-LD, no
 * response said Vary: Accept, and nothing was ever refused. src/ns/conneg.ts is the one place that
 * decides now; this pins its decisions and the headers every answer carries.
 */
import { describe, it, expect } from 'vitest';
import { chooseRepresentation, sendNegotiated, ontologyRepresentations, shapesRepresentations, isVersionSegment, latestVersionLink, type Representation } from '../src/ns/conneg.js';

const ONTOLOGY: Representation[] = ontologyRepresentations({
  jsonld: () => ({ '@id': 'x' }), turtle: () => 'ttl', rdfxml: () => 'xml', ntriples: () => 'nt', html: () => 'html',
});
const SHAPES: Representation[] = shapesRepresentations({ turtle: () => 'ttl', jsonld: () => ({}), rdfxml: () => 'xml', ntriples: () => 'nt' });
const pick = (accept: string | undefined, reps = ONTOLOGY): string | null => chooseRepresentation(accept, reps)?.mediaType ?? null;

describe('which representation an Accept header gets', () => {
  it('no Accept, or */*, gets the document\'s default (JSON-LD for an ontology, Turtle for shapes)', () => {
    expect(pick(undefined)).toBe('application/ld+json');
    expect(pick('*/*')).toBe('application/ld+json');
    expect(pick(undefined, SHAPES)).toBe('text/turtle');
  });

  it('a reasoner asking for RDF/XML first gets RDF/XML', () => {
    expect(pick('application/rdf+xml, text/turtle;q=0.5, */*;q=0.1')).toBe('application/rdf+xml');
    expect(pick('application/rdf+xml')).toBe('application/rdf+xml');
  });

  it('q=0 means not acceptable, and the most specific matching range sets the quality', () => {
    expect(pick('text/turtle;q=0, */*;q=0.1')).toBe('application/ld+json');
    expect(pick('text/*;q=0.9, text/turtle;q=0')).toBe('text/html');
    expect(pick('text/turtle;q=0')).toBeNull();
  });

  it('a browser gets HTML; text/* ties go to the document\'s order', () => {
    expect(pick('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe('text/html');
    expect(pick('text/*')).toBe('text/turtle');
  });

  it('a client that accepts only application/json gets the JSON-LD, labelled as what it asked for', () => {
    const r = chooseRepresentation('application/json', ONTOLOGY)!;
    expect(r.mediaType).toBe('application/json');
    expect(r.rep.type).toBe('application/ld+json');
  });

  it('nothing acceptable on offer is a refusal, not a guess', () => {
    expect(pick('application/pdf')).toBeNull();
    expect(pick('text/csv', SHAPES)).toBeNull();
  });
});

describe('what every answer says', () => {
  const answer = (accept?: string) => {
    const sent: { status: number; headers: Record<string, string>; type?: string; body?: string } = { status: 200, headers: {} };
    const res = {
      setHeader(n: string, v: string) { sent.headers[n.toLowerCase()] = v; return res; },
      status(c: number) { sent.status = c; return res; },
      type(t: string) { sent.type = t; return res; },
      send(b: string) { sent.body = b; return res; },
    };
    sendNegotiated({ headers: accept === undefined ? {} : { accept } }, res, 'https://foxxi-bridge.interego.xwisee.com/ns/xapi', ONTOLOGY,
      [latestVersionLink('https://foxxi-bridge.interego.xwisee.com/ns/xapi/2026.10.0')]);
    return sent;
  };

  it('Vary: Accept, the alternates and the current version in Link, and CORS that exposes them', () => {
    const r = answer('text/turtle');
    expect(r.status).toBe(200);
    expect(r.type).toBe('text/turtle');
    expect(r.body).toBe('ttl');
    expect(r.headers.vary).toBe('Accept');
    for (const t of ['application/ld+json', 'text/turtle', 'application/rdf+xml', 'application/n-triples', 'text/html']) {
      expect(r.headers.link).toContain(`<https://foxxi-bridge.interego.xwisee.com/ns/xapi>; rel="alternate"; type="${t}"`);
    }
    expect(r.headers.link).toContain('<https://foxxi-bridge.interego.xwisee.com/ns/xapi/2026.10.0>; rel="latest-version"');
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['access-control-expose-headers']).toMatch(/Link/);
  });

  it('406 names what is available', () => {
    const r = answer('application/pdf');
    expect(r.status).toBe(406);
    expect(r.body).toMatch(/available as: application\/ld\+json, text\/turtle, application\/rdf\+xml, application\/n-triples, text\/html/);
    expect(r.headers.vary).toBe('Accept');
  });

  it('a version segment is a calendar or semantic version, nothing else', () => {
    expect(isVersionSegment('2026.10.0')).toBe(true);
    expect(isVersionSegment('1.0.0')).toBe(true);
    for (const s of ['shapes', 'mappings', 'term', '2026.10', 'v1.0.0', '../x']) expect(isVersionSegment(s), s).toBe(false);
  });
});
