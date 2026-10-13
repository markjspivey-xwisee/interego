/**
 * An Enterprise Learner Record is JSON-LD that a JSON-LD processor reads, in safe mode, into triples
 * the IEEE LER ontology defines.
 *
 * ★ WHY. The record listed the IEEE P2997 web page as its second @context: a processor fetched it,
 * found HTML and stopped, so no RDF reading of any record existed, and the shapes published for
 * records constrained data nothing could produce. It also carried `type` and `@type` together, which
 * JSON-LD 1.1 rejects as colliding keywords. The record is now read through the W3C VC 2.0 context,
 * the record context the bridge serves at /ns/ieee-ler/context (elrJsonLdContext), and VC 2.0's
 * undefined-terms context last (VC 2.0 §5.2), and this reads one the way a verifier would: with the
 * W3C contexts from static copies checked against their published digests, nothing fetched, and
 * jsonld's safe mode, which refuses a document that would silently drop a term.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import jsonld from 'jsonld';
import { Parser, Writer, type Quad } from 'n3';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderShacl, shapesIri } from '../src/spec-ontology.js';
import { LER_MODEL, validateLerInstance } from '../src/spec/ler.model.js';
import { turtleQuads, OWL, RDF_TYPE } from './support/ns-graph.js';
import { assembleEnterpriseLearnerRecord, PERF_EXT, PERFORMED_VERB } from '../src/learner-record.js';
import type { StoredStatement } from '../src/statement-store.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';
import { ELR_CONTEXT_URL, LER_NS, renderSemOntologyTurtle } from '../src/ler-tla-vocab.js';
import { VC2, UNDEFINED_TERMS, read, documentLoader, at, statement, performed, completed, record } from './support/elr-records.js';

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** A performance with everything a statement can say of it: a scaled score, a duration, a cost and the
 *  observer who attested it. */
const performedFully = (id: string, ts: string): StoredStatement => statement(id, PERFORMED_VERB, {
  object: { objectType: 'Activity', id: `urn:task:${id}`, definition: { name: { en: 'Refund a disputed order' }, type: `${FOXXI_NS}ProductionTask` } },
  result: { success: true, score: { scaled: 0.8 }, duration: 'PT12M' },
  context: { extensions: { [PERF_EXT.contextKind]: 'production', [PERF_EXT.costUsd]: 1.25, [PERF_EXT.observedBy]: 'did:web:reviewer.example' } },
}, ts);
async function triplesOf(doc: unknown): Promise<Quad[]> {
  const nq = await jsonld.toRDF(doc as jsonld.JsonLdDocument, { format: 'application/n-quads', documentLoader, safe: true } as unknown as jsonld.Options.ToRdf) as unknown as string;
  return new Parser({ format: 'application/n-quads' }).parse(nq);
}

describe('the W3C contexts the tests read are W3C\'s', () => {
  it('match the digests published for them', () => {
    expect(sha256(read('credentials-v2.jsonld'))).toBe('59955ced6697d61e03f2b2556febe5308ab16842846f5b586d7f1f7adec92734');
    expect(sha256(read('credentials-undefined-terms-v2.jsonld'))).toBe('82dab514ba44eb18f5d1b0f638c5e140c6a556fbfb5089601bdc0fa5eb8b2581');
  });
});

describe('an Enterprise Learner Record', () => {
  it('names the VC 2.0 context first, the record context, and the undefined-terms context last; no colliding @type', async () => {
    const elr = await record();
    expect(elr['@context']).toEqual([VC2, ELR_CONTEXT_URL, UNDEFINED_TERMS]);
    expect(Object.keys(elr)).not.toContain('@type');
    expect(elr.competencies.length).toBeGreaterThan(0);
  });

  it('reads into RDF in safe mode, and every LER term it uses is one the LER ontology defines', async () => {
    const q = await triplesOf(await record());
    expect(q.length).toBeGreaterThan(30);
    const ontology = turtleQuads(renderSemOntologyTurtle('ler'));
    const declared = new Set(ontology.filter(t => t.predicate.value === RDF_TYPE
      && [`${OWL}Class`, `${OWL}ObjectProperty`, `${OWL}DatatypeProperty`, `${OWL}AnnotationProperty`].includes(t.object.value)).map(t => t.subject.value));
    const lerTerms = new Set([...q.map(t => t.predicate.value), ...q.filter(t => t.predicate.value === RDF_TYPE).map(t => t.object.value)].filter(v => v.startsWith(LER_NS)));
    expect(lerTerms.size).toBeGreaterThan(8);
    expect([...lerTerms].filter(t => !declared.has(t))).toEqual([]);
  });

  it('says what a verifier needs, on the terms the shapes constrain', async () => {
    const elr = await record();
    const q = await triplesOf(elr);
    const of = (s: string, p: string): Quad[] => q.filter(t => t.subject.value === s && t.predicate.value === p);
    expect(of(elr.id, RDF_TYPE).map(t => t.object.value)).toEqual(expect.arrayContaining([`${LER_NS}EnterpriseLearnerRecord`, 'https://www.w3.org/2018/credentials#VerifiablePresentation']));
    expect(of(elr.id, 'http://purl.org/dc/terms/conformsTo').map(t => t.object.termType)).toEqual(['NamedNode']);
    const generated = of(elr.id, 'http://www.w3.org/ns/prov#generatedAtTime')[0]!.object as { datatype: { value: string } };
    expect(generated.datatype.value).toBe('http://www.w3.org/2001/XMLSchema#dateTime');
    // ★ REVISED: ler:aboutLearner, where this read ler:holder — deprecated, because the name read as a
    // Verifiable Credential's holder (whoever presents it), a different relation from whom it is about.
    expect(of(elr.id, `${LER_NS}aboutLearner`).map(t => t.object.value)).toEqual(['did:web:p.example']);
    expect(of(elr.id, `${LER_NS}holder`)).toEqual([]);
    const assertions = of(elr.id, `${LER_NS}hasAssertion`).map(t => t.object.value);
    expect(assertions).toHaveLength(elr.competencies.length);
    for (const a of assertions) {
      expect(of(a, RDF_TYPE).map(t => t.object.value)).toContain(`${LER_NS}CompetencyAssertion`);
      expect(of(a, `${LER_NS}aboutCompetency`).map(t => t.object.termType)).toEqual(['NamedNode']);
      expect(of(a, 'https://markjspivey-xwisee.github.io/interego/ns/iep#modalStatus').map(t => t.object.value)[0])
        .toMatch(/^https:\/\/markjspivey-xwisee\.github\.io\/interego\/ns\/iep#(Asserted|Hypothetical)$/);
      for (const c of of(a, `${LER_NS}successConfidence`)) {
        const n = Number(c.object.value);
        expect(n >= 0 && n <= 1, `confidence ${c.object.value}`).toBe(true);
      }
    }
  });

  it('an entry\'s statement id is its identifier, not a relative IRI the record would resolve wherever it was fetched', async () => {
    const elr = await record();
    const q = await triplesOf(elr);
    const ids = q.filter(t => t.predicate.value === 'http://purl.org/dc/terms/identifier').map(t => t.object.value).sort();
    expect(ids).toEqual(['c1', 'p1', 'p2', 'p3']);
    expect(q.filter(t => t.predicate.value === `${LER_NS}recordEntry`).every(t => t.object.termType === 'BlankNode')).toBe(true);
  });

  it('the links projection the bridge serves by default reads as Hydra collections', async () => {
    // The shape bridge/server.ts (elrAsLinks) puts in place of the two entry lists.
    const asLinks = (n: number) => ({ '@type': 'hydra:Collection', 'hydra:totalItems': n,
      'hydra:view': { '@type': 'hydra:PartialCollectionView', target: 'https://bridge.example/agent/lattice/self', method: 'POST' } });
    const elr = await record();
    const q = await triplesOf({ ...elr, experiences: asLinks(1), performanceRecords: asLinks(3) });
    const HYDRA = 'http://www.w3.org/ns/hydra/core#';
    const collections = q.filter(t => t.predicate.value === RDF_TYPE && t.object.value === `${HYDRA}Collection`).map(t => t.subject.value);
    expect(collections).toHaveLength(2);
    expect(q.filter(t => t.predicate.value === `${HYDRA}totalItems`).map(t => Number(t.object.value)).sort()).toEqual([1, 3]);
    expect(q.some(t => t.object.value.startsWith('hydra:') || t.predicate.value.startsWith('hydra:'))).toBe(false);
  });

  it('a step of the organisation path is a node of its own: the role is the step\'s, not the organisation\'s, and the order is kept', async () => {
    const elr = await record();
    const q = await triplesOf(elr);
    const of = (s: string, p: string): Quad[] => q.filter(t => t.subject.value === s && t.predicate.value === p);
    const steps = of(elr.id, `${LER_NS}organizationPath`).map(t => t.object);
    expect(steps.length).toBe(elr.organizationPath.length);
    const read = steps.map(st => ({
      kind: st.termType,
      org: of(st.value, `${LER_NS}pathOrganization`).map(t => t.object.value),
      role: of(st.value, `${LER_NS}pathRole`).map(t => t.object.value),
      position: of(st.value, `${LER_NS}pathPosition`).map(t => `${t.object.value}^^${(t.object as { datatype: { value: string } }).datatype.value}`),
    })).sort((a, b) => a.position[0]!.localeCompare(b.position[0]!));
    expect(read).toEqual(elr.organizationPath.map(o => ({ kind: 'BlankNode', org: [o.id], role: [o.role], position: [`${o.position}^^http://www.w3.org/2001/XMLSchema#positiveInteger`] })));
    expect(elr.organizationPath.map(o => o.position)).toEqual(elr.organizationPath.map((_, i) => i + 1));
    // Nothing is said of an organisation's DID itself: its role in this record is not a fact about it.
    expect(q.filter(t => t.subject.value === 'did:web:tenant.example')).toEqual([]);
  });

  it('an entry says what it says about its statement on terms of its own, and an IRI is an IRI', async () => {
    const elr = await record();
    const q = await triplesOf(elr);
    const entries = q.filter(t => t.predicate.value === `${LER_NS}recordEntry`).map(t => t.object.value);
    expect(entries).toHaveLength(4);
    for (const e of entries) {
      const of = (p: string): Quad[] => q.filter(t => t.subject.value === e && t.predicate.value === p);
      expect(of(`${LER_NS}aboutActivity`).map(t => t.object.termType)).toEqual(['NamedNode']);
      expect(of(`${LER_NS}occurredAt`).map(t => (t.object as { datatype: { value: string } }).datatype.value)).toEqual(['http://www.w3.org/2001/XMLSchema#dateTime']);
    }
    // A learning experience names its statement's verb; a performance record, its task's type and outcome.
    const experienced = entries.filter(e => q.some(t => t.subject.value === e && t.predicate.value === `${LER_NS}entryVerb`));
    expect(experienced).toHaveLength(1);
    expect(q.filter(t => t.subject.value === experienced[0] && t.predicate.value === `${LER_NS}entryVerb`).map(t => t.object.value)).toEqual(['http://adlnet.gov/expapi/verbs/completed']);
    const performed = entries.filter(e => q.some(t => t.subject.value === e && t.predicate.value === `${LER_NS}activityType`));
    expect(performed).toHaveLength(3);
    for (const e of performed) {
      expect(q.filter(t => t.subject.value === e && t.predicate.value === `${LER_NS}activityType`).map(t => t.object.termType)).toEqual(['NamedNode']);
      expect(q.filter(t => t.subject.value === e && t.predicate.value === `${LER_NS}succeeded`).map(t => t.object.value)).toEqual(['true']);
    }
    // ★ An entry is not an xAPI Statement: nothing in the record uses the xAPI ontology's verb or
    // timestamp, whose domain would make it one (and the xAPI shapes would take it for a Statement).
    expect(q.filter(t => t.predicate.value.startsWith('https://foxxi-bridge.interego.xwisee.com/ns/xapi#'))).toEqual([]);
  });

  it('meets the IEEE LER shapes in both readings — and a path step without its role fails both, at the same shape', async () => {
    const elr = await record() as unknown as Record<string, unknown> & { organizationPath: Array<Record<string, unknown>> };
    const nt = (quads: Quad[]): string => new Writer({ format: 'N-Triples' }).quadsToString(quads);
    const shapes = renderShacl(LER_MODEL);
    const fromJson = validateLerInstance(elr);
    expect(fromJson.conforms, JSON.stringify(fromJson.results)).toBe(true);
    const report = shacl(nt(await triplesOf(elr)), shapes);
    expect(report.fullyChecked).toBe(true);
    expect(report.conforms, JSON.stringify(report.results)).toBe(true);
    // A step that does not say what role its organisation plays.
    const broken = { ...elr, organizationPath: elr.organizationPath.map((o, i) => (i === 0 ? { id: o.id, position: o.position } : o)) };
    const jsonFault = validateLerInstance(broken);
    const rdfFault = shacl(nt(await triplesOf(broken)), shapes);
    const step = `${shapesIri(LER_MODEL)}#OrganizationPathStepShape-role`;
    expect(jsonFault.results.map(r => r.sourceShape)).toEqual([step]);
    expect(rdfFault.results.filter(r => r.severity === 'Violation').map(r => r.sourceShape)).toEqual([step]);
  });

  // ★ REVISED. This listed twenty fields left to VC 2.0's undefined-terms context as presentation:
  // the display names and the summary counts. A second review held them to be facts — a name given
  // beside an IRI, an evidence figure, a count — and found a record that lists credentials left
  // their issuer, the link to them and whether their proof verified there too. Each has a term now.
  it('leaves nothing to issuer-dependent terms: names, figures, counts and listed credentials all have terms', async () => {
    const UT = 'https://www.w3.org/ns/credentials/undefined-term#';
    const elr = await assembleEnterpriseLearnerRecord({
      learnerDid: 'did:web:p.example', learnerPodUrl: 'https://pod.example/p/', tenantDid: 'did:web:tenant.example', lrsEndpoint: 'https://bridge.example',
      learnerName: 'Ada',
      statements: [completed, performedFully('p1', at(2)), performedFully('p2', at(3)), performed('p3', at(4), true)],
      subjectKind: 'agent', fetch: (async () => { throw new Error('no pod here'); }) as never,
    });
    // A listed credential, as the record lists one it found in the learner's wallet.
    const withCredential = { ...elr, credentials: [{ id: 'urn:uuid:7d8c1f2e-1111-4222-8333-944455556666', achievementName: 'Refunds 101', issuer: 'did:web:tenant.example', verified: true, rawDataLocation: 'https://pod.example/p/cred-1' }] };
    const q = await triplesOf(withCredential);
    expect([...new Set(q.map(t => t.predicate.value).filter(p => p.startsWith(UT)))]).toEqual([]);
    const of = (s: string, p: string): Quad[] => q.filter(t => t.subject.value === s && t.predicate.value === p);
    // The credential is a node of the record's, its issuer an IRI.
    const cred = 'urn:uuid:7d8c1f2e-1111-4222-8333-944455556666';
    expect(of(elr.id, `${LER_NS}hasCredential`).map(t => t.object.value)).toEqual([cred]);
    expect(of(cred, `${LER_NS}issuedBy`).map(t => t.object.termType)).toEqual(['NamedNode']);
    expect(of(cred, `${LER_NS}proofVerified`).map(t => t.object.value)).toEqual(['true']);
    expect(of(cred, `${LER_NS}achievementName`).map(t => t.object.value)).toEqual(['Refunds 101']);
    // The summary's counts are said of the record, as integers.
    const count = of(elr.id, `${LER_NS}experienceCount`)[0]!.object as { value: string; datatype: { value: string } };
    expect([count.value, count.datatype.value]).toEqual(['1', 'http://www.w3.org/2001/XMLSchema#integer']);
    // A performance's quality, duration, cost and observer.
    const entries = of(elr.id, `${LER_NS}recordEntry`).map(t => t.object.value);
    const full = entries.filter(e => of(e, `${LER_NS}costUSD`).length);
    expect(full).toHaveLength(2);
    for (const e of full) {
      expect(of(e, `${LER_NS}outcomeQuality`).map(t => t.object.value)).toEqual(['8.0E-1']);
      expect(of(e, `${LER_NS}duration`).map(t => t.object.value)).toEqual(['PT12M']);
      expect(of(e, 'http://www.w3.org/ns/prov#wasAttributedTo').map(t => t.object.value)).toEqual(['did:web:reviewer.example']);
    }
    // An assertion's name, its level's rank and its evidence figures are said of the assertion.
    for (const a of of(elr.id, `${LER_NS}hasAssertion`).map(t => t.object.value)) {
      expect(of(a, 'http://www.w3.org/2000/01/rdf-schema#label')).toHaveLength(1);
      expect(of(a, `${LER_NS}proficiencyRank`)).toHaveLength(1);
      expect(of(a, `${LER_NS}trainingCompletionCount`)).toHaveLength(1);
    }
    // Every LER term the record uses is one the LER ontology defines.
    const ontology = turtleQuads(renderSemOntologyTurtle('ler'));
    const declared = new Set(ontology.filter(t => t.predicate.value === RDF_TYPE).map(t => t.subject.value));
    expect([...new Set(q.map(t => t.predicate.value).filter(p => p.startsWith(LER_NS)))].filter(p => !declared.has(p))).toEqual([]);
  });
});
