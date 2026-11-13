/**
 * The Profile Server's dataset (xAPI Profiles, Part Three, section 1): named graphs per version,
 * current versions in the default graph, the required inference, and the specification's own
 * example queries written exactly as it writes them.
 */
import { describe, it, expect } from 'vitest';
import { ProfileDataset, SparqlRefused } from '../src/xapi-profile-server/dataset.js';
import { inferred, profileTriples, versionsOf, PROFILE_NS as NS, type Json } from '../src/xapi-profile-server/rdf.js';

const P = 'https://example.org/profiles/kiln';
const PREFIXES = `PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX xapi: <https://w3id.org/xapi/ontology#>
PREFIX profile: <https://w3id.org/xapi/profiles/ontology#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX schemaorg: <http://schema.org/>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;
const kiln = (version: 1 | 2): Json => ({
  id: P, type: 'Profile', '@context': 'https://w3id.org/xapi/profiles/context',
  conformsTo: 'https://w3id.org/xapi/profiles#1.0',
  prefLabel: { en: 'Kiln firing' }, definition: { en: 'A made-up profile about firing pots.' },
  author: { type: 'Organization', name: 'Fictional Pottery Guild' },
  versions: version === 1
    ? [{ id: `${P}/v1`, generatedAtTime: '2026-01-01T00:00:00Z' }]
    : [{ id: `${P}/v2`, generatedAtTime: '2026-06-01T00:00:00Z', wasRevisionOf: [`${P}/v1`] }, { id: `${P}/v1`, generatedAtTime: '2026-01-01T00:00:00Z' }],
  concepts: [
    { id: `${P}/verbs/fired`, type: 'Verb', inScheme: `${P}/v${version}`, prefLabel: { en: 'fired', fr: 'cuit' }, definition: { en: 'Put through the kiln.' },
      broadMatch: ['https://example.org/profiles/craft/verbs/made'] },
    { id: `${P}/types/pot`, type: 'ActivityType', inScheme: `${P}/v${version}`, prefLabel: { en: 'pot' }, definition: { en: 'A vessel.' } },
    ...(version === 2 ? [{ id: `${P}/verbs/glazed`, type: 'Verb', inScheme: `${P}/v2`, prefLabel: { en: 'glazed' }, definition: { en: 'Coated.' }, deprecated: true,
      broader: [`${P}/verbs/fired`] } as Json] : []),
  ],
  templates: [{ id: `${P}/templates/firing`, type: 'StatementTemplate', inScheme: `${P}/v${version}`, prefLabel: { en: 'firing' }, definition: { en: 'One firing.' },
    verb: `${P}/verbs/fired`, objectActivityType: `${P}/types/pot`,
    rules: [{ location: '$.result.score.raw', presence: 'included', any: [1, 2.5, { cone: 6 }] }] }],
  patterns: [{ id: `${P}/patterns/session`, type: 'Pattern', primary: true, inScheme: `${P}/v${version}`, prefLabel: { en: 'session' }, definition: { en: 'A session.' },
    sequence: [`${P}/templates/firing`, `${P}/templates/firing`] }],
});
const craft: Json = {
  id: 'https://example.org/profiles/craft', type: 'Profile', prefLabel: { en: 'Craft' }, definition: { en: 'A made-up parent profile.' },
  versions: [{ id: 'https://example.org/profiles/craft/v1', generatedAtTime: '2026-02-01T00:00:00Z' }],
  concepts: [{ id: 'https://example.org/profiles/craft/verbs/made', type: 'Verb', inScheme: 'https://example.org/profiles/craft/v1', prefLabel: { en: 'made' }, definition: { en: 'Made.' } }],
};
const values = (a: ReturnType<ProfileDataset['query']>, v: string) => (a.results?.bindings ?? []).map(b => b[v]?.value).sort();

describe('a profile as RDF', () => {
  const triples = profileTriples(kiln(2), `${P}/v2`);
  const has = (s: string, p: string, o: string) => triples.some(t => t.subject === s && t.predicate === p && t.object === o);
  it('reads each property the way the profile context defines it', () => {
    expect(has(P, `${NS.rdf}type`, `${NS.profile}Profile`)).toBe(true);
    expect(has(`${P}/verbs/fired`, `${NS.skos}prefLabel`, '"cuit"@fr')).toBe(true);
    expect(has(`${P}/v2`, `${NS.prov}generatedAtTime`, `"2026-06-01T00:00:00Z"^^${NS.xsd}dateTime`)).toBe(true);
    expect(has(`${P}/v2`, `${NS.prov}wasRevisionOf`, `${P}/v1`)).toBe(true);
    expect(has(`${P}/verbs/glazed`, `${NS.profile}deprecated`, `"true"^^${NS.xsd}boolean`)).toBe(true);
    expect(has(`${P}/templates/firing`, `${NS.profile}verb`, `${P}/verbs/fired`)).toBe(true);
    // A key the context does not define states nothing.
    expect(triples.some(t => t.object.includes('profiles/context'))).toBe(false);
  });
  it('keeps a sequence in order, as an RDF list', () => {
    const head = triples.find(t => t.subject === `${P}/patterns/session` && t.predicate === `${NS.profile}sequence`)!.object;
    const first = triples.find(t => t.subject === head && t.predicate === `${NS.rdf}first`)!, rest = triples.find(t => t.subject === head && t.predicate === `${NS.rdf}rest`)!;
    expect(first.object).toBe(`${P}/templates/firing`);
    expect(triples.find(t => t.subject === rest.object && t.predicate === `${NS.rdf}rest`)!.object).toBe(`${NS.rdf}nil`);
  });
  it('writes rule values as typed literals, and a structured one as JSON', () => {
    const rule = triples.find(t => t.predicate === `${NS.profile}rules`)!.object;
    const any = triples.filter(t => t.subject === rule && t.predicate === `${NS.profile}any`).map(t => t.object);
    expect(any).toEqual([`"1"^^${NS.xsd}integer`, `"2.5"^^${NS.xsd}double`, `"{"cone":6}"^^${NS.rdf}JSON`]);
  });
  it('infers what the specification requires', () => {
    const more = inferred(triples);
    const got = (s: string, p: string, o: string) => more.some(t => t.subject === s && t.predicate === p && t.object === o);
    // concepts, templates and patterns are subproperties of the inverse of skos:inScheme.
    for (const member of ['verbs/fired', 'templates/firing', 'patterns/session']) expect(got(`${P}/${member}`, `${NS.skos}inScheme`, P), member).toBe(true);
    // SKOS: broadMatch is a broader, broader has an inverse, and both reach the transitive forms.
    expect(got(`${P}/verbs/fired`, `${NS.skos}broader`, 'https://example.org/profiles/craft/verbs/made')).toBe(true);
    expect(got('https://example.org/profiles/craft/verbs/made', `${NS.skos}narrowMatch`, `${P}/verbs/fired`)).toBe(true);
    expect(got(`${P}/verbs/fired`, `${NS.skos}narrower`, `${P}/verbs/glazed`)).toBe(true);
    expect(got(`${P}/verbs/glazed`, `${NS.skos}broaderTransitive`, 'https://example.org/profiles/craft/verbs/made')).toBe(true);
    expect(got('https://example.org/profiles/craft/verbs/made', `${NS.skos}narrowerTransitive`, `${P}/verbs/glazed`)).toBe(true);
    expect(got(`${P}/verbs/fired`, `${NS.rdfs}label`, '"fired"@en')).toBe(true);
  });
  it('finds the version a document is from its revision chain, not from the order written', () => {
    expect(versionsOf(kiln(2)).current.id).toBe(`${P}/v2`);
    const reordered = { ...(kiln(2) as { [k: string]: Json }), versions: [...((kiln(2) as { versions: Json[] }).versions)].reverse() };
    expect(versionsOf(reordered).current.id).toBe(`${P}/v2`);
    expect(() => versionsOf({ id: P })).toThrow(/versions/);
  });
});

describe('the dataset', () => {
  const data = new ProfileDataset();
  data.add(kiln(1)); data.add(kiln(2)); data.add(craft);

  it('answers the specification\'s example queries as it writes them', () => {
    const profiles = data.query(`${PREFIXES}
select
    ?profile,
    ?prefLabel,
    ?definition
where {
    ?profile a profile:Profile ;
             skos:prefLabel ?prefLabel ;
             skos:definition ?definition .
}`);
    expect(profiles.head.vars).toEqual(['profile', 'prefLabel', 'definition']);
    expect(values(profiles, 'profile')).toEqual(['https://example.org/profiles/craft', P]);
    expect(profiles.results!.bindings.find(b => b.profile!.value === P)!.prefLabel).toEqual({ type: 'literal', value: 'Kiln firing', 'xml:lang': 'en' });

    const concepts = data.query(`${PREFIXES}
select
    ?concept,
    ?prefLabel,
    ?definition
where {
    (?concept a xapi:Verb || ?concept a xapi:ActivityType) .
    ?concept skos:inScheme <${P}> ;
             skos:prefLabel ?prefLabel ;
             skos:definition ?definition .
}`);
    expect([...new Set(values(concepts, 'concept'))]).toEqual([`${P}/types/pot`, `${P}/verbs/fired`, `${P}/verbs/glazed`]);

    const templates = data.query(`${PREFIXES} select ?t where { ?t a profile:StatementTemplate . ?t skos:inScheme <${P}> }`);
    expect(values(templates, 't')).toEqual([`${P}/templates/firing`]);
  });

  it('keeps only current versions in the default graph, and every version in a graph of its own', () => {
    const glazed = `${PREFIXES} ASK { <${P}/verbs/glazed> a xapi:Verb }`;
    expect(data.query(glazed).boolean).toBe(true);
    expect(data.query(`${PREFIXES} ASK { GRAPH <${P}/v1> { <${P}/verbs/glazed> a xapi:Verb } }`).boolean).toBe(false);
    expect(data.query(`${PREFIXES} ASK FROM <${P}/v1> { <${P}/verbs/glazed> a xapi:Verb }`).boolean).toBe(false);
    expect(data.query(glazed, { defaultGraphUris: [`${P}/v1`] }).boolean).toBe(false);
    expect(data.query(`${PREFIXES} ASK { GRAPH <${P}/v2> { <${P}/verbs/glazed> a xapi:Verb } }`).boolean).toBe(true);
    // v1 states inScheme v1; the default graph must not, or it would not be "current versions only".
    expect(data.query(`${PREFIXES} ASK { ?c skos:inScheme <${P}/v1> }`).boolean).toBe(false);
    const where = data.query(`${PREFIXES} SELECT ?g ?c WHERE { GRAPH ?g { ?c a xapi:Verb . ?c skos:prefLabel "fired"@en } }`);
    expect(values(where, 'g')).toEqual([`${P}/v1`, `${P}/v2`]);
    // The versioning information is in the default graph, so history can be walked from there.
    expect(values(data.query(`${PREFIXES} SELECT ?old WHERE { <${P}> profile:versions ?v . ?v prov:wasRevisionOf ?old }`), 'old')).toEqual([`${P}/v1`]);
  });

  it('infers across profiles in the default graph', () => {
    const narrower = data.query(`${PREFIXES} SELECT ?n WHERE { <https://example.org/profiles/craft/verbs/made> skos:narrowerTransitive ?n }`);
    expect(values(narrower, 'n')).toEqual([`${P}/verbs/fired`, `${P}/verbs/glazed`]);
  });

  it('supports the filters and modifiers people reach for', () => {
    expect(values(data.query(`${PREFIXES} SELECT ?c WHERE { ?c skos:prefLabel ?l . FILTER(REGEX(?l, "^GLAZ", "i")) }`), 'c')).toEqual([`${P}/verbs/glazed`]);
    expect(values(data.query(`${PREFIXES} SELECT ?c WHERE { ?c profile:deprecated "true"^^<http://www.w3.org/2001/XMLSchema#boolean> }`), 'c')).toEqual([`${P}/verbs/glazed`]);
    const paged = data.query(`${PREFIXES} SELECT ?c WHERE { ?c a xapi:Verb } ORDER BY ?c LIMIT 1 OFFSET 1`);
    expect(paged.results!.bindings).toHaveLength(1);
    const optional = data.query(`${PREFIXES} SELECT ?c ?d WHERE { ?c a xapi:Verb . OPTIONAL { ?c profile:deprecated ?d } }`);
    expect(optional.results!.bindings.filter(b => b.d).map(b => b.d!.datatype)).toEqual(['http://www.w3.org/2001/XMLSchema#boolean']);
    // A '#' inside an IRI is not a comment.
    expect(data.query(`ASK { ?p a <https://w3id.org/xapi/profiles/ontology#Profile> } # trailing`).boolean).toBe(true);
  });

  it('refuses, by name, what it cannot evaluate', () => {
    for (const q of [
      `${PREFIXES} SELECT ?x WHERE { ?c skos:broader+ ?x }`,
      `${PREFIXES} SELECT ?x WHERE { ?c skos:broader/skos:broader ?x }`,
      `${PREFIXES} CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }`,
      `${PREFIXES} DELETE WHERE { ?s ?p ?o }`,
      `${PREFIXES} SELECT ?s WHERE { ?s ?p ?o . FILTER NOT EXISTS { ?s a xapi:Verb } }`,
      `${PREFIXES} SELECT ?s WHERE { ?s a xapi:Verb . GRAPH <${P}/v1> { ?s ?p ?o } }`,
      `${PREFIXES} SELECT ?s WHERE { ?s skos:prefLabel ?l . FILTER(LANG(?l) = "en") }`,
      '',
    ]) expect(() => data.query(q), q).toThrow(SparqlRefused);
  });

  it('drops a profile, and what was current before it is not resurrected by accident', () => {
    const d = new ProfileDataset();
    d.add(kiln(1)); d.add(kiln(2));
    expect(d.get(P)!.version).toBe(`${P}/v2`);
    expect(d.remove(`${P}/v2`)).toEqual([`${P}/v2`]);
    expect(d.get(P)!.version).toBe(`${P}/v1`);
    expect(d.remove(P)).toEqual([`${P}/v1`]);
    expect(d.query(`ASK { ?s ?p ?o }`).boolean).toBe(false);
  });
});
