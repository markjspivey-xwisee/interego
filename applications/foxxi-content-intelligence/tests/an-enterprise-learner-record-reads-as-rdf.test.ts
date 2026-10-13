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
import { readFileSync } from 'node:fs';
import jsonld from 'jsonld';
import { Parser, Writer, type Quad } from 'n3';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderShacl, shapesIri } from '../src/spec-ontology.js';
import { LER_MODEL, validateLerInstance } from '../src/spec/ler.model.js';
import { turtleQuads, OWL, RDF_TYPE } from './support/ns-graph.js';
import { assembleEnterpriseLearnerRecord, PERF_EXT, PERFORMED_VERB } from '../src/learner-record.js';
import type { StoredStatement } from '../src/statement-store.js';
import { FOXXI_NS } from '../src/foxxi-vocab.js';
import { ELR_CONTEXT_URL, LER_NS, elrJsonLdContext, renderSemOntologyTurtle } from '../src/ler-tla-vocab.js';

const CONTEXTS = new URL('./support/contexts/', import.meta.url);
const VC2 = 'https://www.w3.org/ns/credentials/v2';
const UNDEFINED_TERMS = 'https://www.w3.org/ns/credentials/undefined-terms/v2';
const read = (f: string): string => readFileSync(new URL(f, CONTEXTS), 'utf8');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Answers only the three contexts a record names; anything else is an error, never a fetch. */
const documentLoader = async (url: string) => {
  const doc = url === VC2 ? JSON.parse(read('credentials-v2.jsonld'))
    : url === UNDEFINED_TERMS ? JSON.parse(read('credentials-undefined-terms-v2.jsonld'))
      : url === ELR_CONTEXT_URL ? elrJsonLdContext() : undefined;
  if (!doc) throw new Error(`the test fetches nothing: ${url}`);
  return { contextUrl: undefined, documentUrl: url, document: doc };
};

const at = (n: number): string => `2026-10-0${n}T10:00:00Z`;
const statement = (id: string, verb: string, extra: Record<string, unknown>, ts: string): StoredStatement => ({
  id, stored: ts, voided: false,
  statement: {
    id, verb: { id: verb }, timestamp: ts,
    actor: { objectType: 'Agent', account: { homePage: 'https://bridge.example', name: 'did:web:p.example' } },
    ...extra,
  },
});
const performed = (id: string, ts: string, success: boolean): StoredStatement => statement(id, PERFORMED_VERB, {
  object: { objectType: 'Activity', id: `urn:task:${id}`, definition: { name: { en: 'Refund a disputed order' }, type: `${FOXXI_NS}ProductionTask` } },
  result: { success },
  context: { extensions: { [PERF_EXT.contextKind]: 'production' } },
}, ts);
const completed = statement('c1', 'http://adlnet.gov/expapi/verbs/completed', {
  object: { objectType: 'Activity', id: 'https://bridge.example/course/refunds', definition: { name: { en: 'Refunds 101' } } },
}, at(1));

async function record() {
  return assembleEnterpriseLearnerRecord({
    learnerDid: 'did:web:p.example', learnerPodUrl: 'https://pod.example/p/', tenantDid: 'did:web:tenant.example', lrsEndpoint: 'https://bridge.example',
    statements: [completed, performed('p1', at(2), true), performed('p2', at(3), true), performed('p3', at(4), true)],
    subjectKind: 'agent', fetch: (async () => { throw new Error('no pod here'); }) as never,
  });
}
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

  it('only presentation is left to issuer-dependent terms: the display names and the summary counts', async () => {
    const q = await triplesOf(await record());
    const UT = 'https://www.w3.org/ns/credentials/undefined-term#';
    const undefinedTerms = [...new Set(q.map(t => t.predicate.value).filter(p => p.startsWith(UT)).map(p => p.slice(UT.length)))].sort();
    // Every one is a display name of something the record names by IRI, or a count derived from the
    // entries: VC 2.0 §5.2 reads them as issuer-dependent terms rather than dropping them.
    expect(undefinedTerms).toEqual([
      'activityName', 'assertedCompetencies', 'competencyCount', 'conformsToLabel', 'credentialCount', 'evidenceSummary',
      'experienceCount', 'inferredCompetencies', 'label', 'performanceCount', 'performanceExecutions', 'performanceSuccessRate',
      'performanceVerifiedCompetencies', 'proficiencyLabel', 'proficiencyRank', 'summary', 'taskName', 'trainingCompletions',
      'verbDisplay', 'verifiedCredentialCount',
    ]);
  });
});
