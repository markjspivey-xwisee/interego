/**
 * An xAPI statement, read into RDF through the context the xAPI ontology publishes (/ns/xapi/context),
 * gets the same verdict from a SHACL processor running the published shapes as the statement gets from
 * the Foxxi validator reading its JSON.
 *
 * ★ WHY. A review showed the shapes checked nothing: no context read a statement into the ontology's
 * terms, `objectType` was a literal property, a statement and most of its parts are never typed in
 * xAPI, and the shapes were written for typed nodes only — so an invalid statement, read as RDF,
 * conformed. Meanwhile the documents said the LRS validated every statement against the shapes. Now
 * the context reads a statement into the ontology (objectType as rdf:type; each `id` as what it is),
 * the shapes select what that reading produces — by class where xAPI types a node, by the property
 * that reaches it where it does not — and this test holds the two readings to one verdict.
 *
 * ★ WHAT EACH READING IS. The JSON verdict is validateXapiStatement — the shapes run on the JSON, and
 * the LRS's own statement validator. The RDF verdict is the substrate's SHACL processor
 * (@interego/core) on the statement's reading in JSON-LD safe mode. A statement safe mode refuses has
 * no reading — an unknown property, a verb whose id is not an IRI — and both readings reject it.
 * Some rules have no RDF statement at all (no property beyond those xAPI defines; a Group as a
 * statement's authority is an OAuth pair): those the LRS validator checks alone, and they are listed
 * here as what they are.
 */
import { describe, it, expect } from 'vitest';
import jsonld from 'jsonld';
import { validateAgainstShape as shacl } from '@interego/core';
import { renderShacl, ns, shapesIri } from '../src/spec-ontology.js';
import { XAPI_MODEL } from '../src/spec/xapi.model.js';
import { validateXapiStatement } from '../src/spec/index.js';
import { XAPI_CONTEXT_URL, xapiJsonLdContext } from '../src/spec/xapi-context.js';
import { utcTimestamp } from '../src/xapi-validate.js';
import { turtleQuads, RDF_TYPE } from './support/ns-graph.js';

const X = ns(XAPI_MODEL);
const SHAPES = renderShacl(XAPI_MODEL);
type Json = Record<string, unknown>;

const documentLoader = async (url: string) => {
  if (url !== XAPI_CONTEXT_URL) throw new Error(`the test fetches nothing: ${url}`);
  return { contextUrl: undefined, documentUrl: url, document: xapiJsonLdContext() };
};
/** The statement's RDF reading as N-Quads, or why safe mode refused it. */
async function reading(stmt: Json): Promise<{ nq: string } | { refused: string }> {
  try {
    const nq = await jsonld.toRDF({ '@context': XAPI_CONTEXT_URL, ...stmt } as jsonld.JsonLdDocument,
      { format: 'application/n-quads', documentLoader, safe: true } as unknown as jsonld.Options.ToRdf) as unknown as string;
    return { nq };
  } catch (e) {
    const code = (e as { details?: { event?: { code?: string } } }).details?.event?.code;
    if (!code) throw e;
    return { refused: code };
  }
}

// ── Statements ────────────────────────────────────────────────────────────────────────────
const AGENT = { mbox: 'mailto:ada@example.org', name: 'Ada' };
const VERB = { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } };
const ACTIVITY = { id: 'https://example.org/courses/refunds', definition: { name: { en: 'Refunds 101' }, type: 'http://adlnet.gov/expapi/activities/course' } };
const base = (extra: Json = {}): Json => ({
  id: '6b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a', actor: AGENT, verb: VERB, object: ACTIVITY, timestamp: '2026-10-01T12:00:00.000Z', ...extra,
});
const RICH = base({
  verb: { id: 'http://adlnet.gov/expapi/verbs/answered', display: { 'en-US': 'answered', fr: 'a répondu' } },
  object: {
    objectType: 'Activity', id: 'https://example.org/q/1',
    definition: {
      name: { en: 'Q1' }, description: { en: 'Pick one.' }, type: 'http://adlnet.gov/expapi/activities/cmi.interaction',
      moreInfo: 'https://example.org/q/1/about', interactionType: 'choice', correctResponsesPattern: ['a'],
      choices: [{ id: 'a', description: { en: 'A' } }, { id: 'b', description: { en: 'B' } }],
      extensions: { 'https://example.org/ext/difficulty': 3 },
    },
  },
  result: { score: { scaled: 0.5, raw: 5, min: 0, max: 10 }, success: true, completion: true, response: 'a', duration: 'PT1M30.5S', extensions: { 'https://example.org/ext/attempt': 'second' } },
  context: {
    registration: 'ec2a3c1b-0a5e-4d3c-9b2a-1f0e9d8c7b6a',
    instructor: { objectType: 'Agent', account: { homePage: 'https://lms.example.org', name: 'teacher-7' } },
    team: { objectType: 'Group', name: 'Blue', mbox: 'mailto:blue@example.org' },
    contextActivities: { parent: [{ id: 'https://example.org/quiz/1' }], grouping: [{ id: 'https://example.org/courses/refunds' }], category: [{ id: 'https://w3id.org/xapi/cmi5/v1.0' }] },
    contextAgents: [{ objectType: 'contextAgent', agent: { mbox: 'mailto:t@example.org' }, relevantTypes: ['https://example.org/roles/assessor'] }],
    contextGroups: [{ objectType: 'contextGroup', group: { objectType: 'Group', member: [{ mbox: 'mailto:p@example.org' }] }, relevantTypes: ['https://example.org/roles/cohort'] }],
    revision: 'r2', platform: 'Example LMS', language: 'en-US',
    statement: { objectType: 'StatementRef', id: '1b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a' },
    extensions: { 'https://example.org/ext/session': 'abc' },
  },
  stored: '2026-10-01T12:00:01.000Z',
  authority: { objectType: 'Agent', account: { homePage: 'https://lrs.example.org', name: 'client-1' } },
  version: '2.0.0',
  attachments: [{ usageType: 'https://example.org/attachments/certificate', display: { en: 'Certificate' }, description: { en: 'The certificate' }, contentType: 'application/pdf', length: 1024, sha2: 'a'.repeat(64), fileUrl: 'https://example.org/c.pdf' }],
});

/** `fault`: the shape each reading names for the violation — the same, unless an untyped node is held
 *  to a shape by the shape that selects it (an Agent left untyped, by ActorShape) or the LRS
 *  validator, which reports under StatementShape, is the one that sees the fault in JSON. */
interface Case { stmt: Json; conforms: boolean; refused?: string; jsonOnly?: string; fault?: string | { json: string; rdf: string } }
const CASES: Record<string, Case> = {
  // Valid
  'a minimal statement: an Agent left untyped, an Activity left untyped': { stmt: base(), conforms: true },
  'a statement using every part of the data model': { stmt: RICH, conforms: true },
  'an Identified Group that lists its members': { stmt: base({ actor: { objectType: 'Group', openid: 'https://id.example.org/team-a', member: [{ mbox: 'mailto:a@example.org' }, { account: { homePage: 'https://lms.example.org', name: 'b' } }] } }), conforms: true },
  'an Anonymous Group': { stmt: base({ actor: { objectType: 'Group', member: [{ mbox: 'mailto:a@example.org' }, { mbox_sha1sum: 'f'.repeat(40) }] } }), conforms: true },
  'a statement voiding another': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/voided', display: { en: 'voided' } }, object: { objectType: 'StatementRef', id: '1b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a' } }), conforms: true },
  'an Agent as the object': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/mentored' }, object: { objectType: 'Agent', account: { homePage: 'https://lms.example.org', name: 'learner-9' } } }), conforms: true },
  'a Sub-Statement as the object': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/planned' }, object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: ACTIVITY, timestamp: '2026-10-08T12:00:00.000Z' } }), conforms: true },
  // Invalid in both readings
  'an Agent with two identifiers': { stmt: base({ actor: { ...AGENT, openid: 'https://id.example.org/ada' } }), conforms: false, fault: { json: 'AgentShape', rdf: 'ActorShape' } },
  'an Agent with no identifier': { stmt: base({ actor: { name: 'Ada' } }), conforms: false, fault: { json: 'AgentShape', rdf: 'ActorShape' } },
  'a Group with neither an identifier nor members': { stmt: base({ actor: { objectType: 'Group', name: 'Nobody' } }), conforms: false, fault: 'GroupShape' },
  'an mbox that is not a mailto IRI': { stmt: base({ actor: { mbox: 'https://example.org/ada' } }), conforms: false, fault: { json: 'AgentShape', rdf: 'ActorShape' } },
  'a statement id that is not a UUID': { stmt: base({ id: 'statement-1' }), conforms: false, fault: 'StatementShape' },
  'a timestamp not in UTC': { stmt: base({ timestamp: '2026-10-01T08:00:00.000-04:00' }), conforms: false, fault: 'StatementShape' },
  'a statement with no verb': { stmt: (({ verb: _v, ...rest }) => rest)(base()), conforms: false, fault: 'StatementShape' },
  'a scaled score above 1': { stmt: base({ result: { score: { scaled: 1.5 } } }), conforms: false, fault: 'ScoreShape' },
  'a score whose min is not below its max': { stmt: base({ result: { score: { min: 10, max: 5 } } }), conforms: false, fault: 'ScoreShape' },
  'a raw score above its max': { stmt: base({ result: { score: { raw: 11, min: 0, max: 10 } } }), conforms: false, fault: 'ScoreShape' },
  'a duration that is not ISO 8601': { stmt: base({ result: { duration: '90 seconds' } }), conforms: false, fault: 'ResultShape' },
  'an interaction type outside the vocabulary': { stmt: base({ object: { id: 'https://example.org/q/2', definition: { interactionType: 'essay' } } }), conforms: false, fault: 'InteractionDefinitionShape' },
  'a registration that is not a UUID': { stmt: base({ context: { registration: 'reg-1' } }), conforms: false, fault: { json: 'StatementShape', rdf: 'ContextShape' } },
  'an attachment without its SHA-2': { stmt: base({ attachments: [{ usageType: 'https://example.org/a', display: { en: 'A' }, contentType: 'text/plain', length: 3 }] }), conforms: false, fault: 'AttachmentShape' },
  'a voiding statement whose object is an Activity': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/voided' } }), conforms: false, fault: 'StatementShape' },
  'a Sub-Statement nesting a Sub-Statement': { stmt: base({ object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: ACTIVITY } } }), conforms: false, fault: 'SubStatementShape' },
  'a Sub-Statement carrying a version': { stmt: base({ object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: ACTIVITY, version: '2.0.0' } }), conforms: false, fault: 'SubStatementShape' },
  'a context statement that is not a Statement Reference': { stmt: base({ context: { statement: { id: '1b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a' } } }), conforms: false, fault: { json: 'StatementShape', rdf: 'ContextShape' } },
  // Refused in safe mode: no reading, and the JSON validator rejects them too
  'a verb whose id is not an IRI': { stmt: base({ verb: { id: 'completed' } }), conforms: false, refused: 'relative @id reference' },
  'a property xAPI does not define': { stmt: base({ mood: 'happy' }), conforms: false, refused: 'invalid property' },
  'an extension value keyed by plain names': { stmt: base({ result: { extensions: { 'https://example.org/ext/geo': { lat: 1, lon: 2 } } } }), conforms: true, refused: 'invalid property' },
  // Rules with no RDF statement: the LRS validator checks them alone
  'an authority Group that is not an OAuth pair': { stmt: base({ authority: { objectType: 'Group', mbox: 'mailto:g@example.org' } }), conforms: false, jsonOnly: 'an authority Group must be anonymous, of exactly two Agents (§5.2.2.1)' },
};

describe('the context a statement is read through', () => {
  it('is published beside the ontology, and every term it reads a statement into is the ontology\'s', async () => {
    // ★ REVISED: the context of the ontology's own version, which never changes (ns/releases.ts),
    // where this read the unversioned /context — which answers with whichever version is current.
    expect(XAPI_CONTEXT_URL).toBe(`${X.slice(0, -1)}/context/${XAPI_MODEL.version}`);
    const ontology = turtleQuads((await import('../src/spec-ontology.js')).renderOwl(XAPI_MODEL));
    const declared = new Set(ontology.filter(t => t.predicate.value === RDF_TYPE).map(t => t.subject.value));
    const r = await reading(RICH);
    expect('nq' in r).toBe(true);
    const used = new Set<string>();
    for (const line of (r as { nq: string }).nq.trim().split('\n')) {
      const [, p, o] = /^\S+ <([^>]+)> (<([^>]+)>)?/.exec(line)! as unknown as [string, string, string, string];
      if (p.startsWith(X)) used.add(p);
      const typed = /^\S+ <http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#type> <([^>]+)>/.exec(line)?.[1];
      if (typed?.startsWith(X)) used.add(typed);
      void o;
    }
    expect(used.size).toBeGreaterThan(40);
    expect([...used].filter(t => !declared.has(t))).toEqual([]);
  });
});

for (const [name, c] of Object.entries(CASES)) {
  describe(name, () => {
    const fromJson = validateXapiStatement(c.stmt);
    it(`the Foxxi validator ${c.conforms && !c.refused ? 'accepts' : c.refused && c.conforms ? 'accepts' : 'rejects'} it`, () => {
      expect(fromJson.conforms, JSON.stringify(fromJson.results, null, 1)).toBe(c.conforms);
    });
    it(c.refused ? `has no RDF reading: safe mode refuses it (${c.refused})`
      : c.jsonOnly ? `its RDF reading conforms: ${c.jsonOnly} has no RDF statement`
        : `a SHACL processor ${c.conforms ? 'accepts' : 'rejects'} its RDF reading`, async () => {
      const r = await reading(c.stmt);
      if (c.refused) { expect(r).toEqual({ refused: c.refused }); return; }
      expect('nq' in r, JSON.stringify(r)).toBe(true);
      const report = shacl((r as { nq: string }).nq, SHAPES);
      expect(report.fullyChecked).toBe(true);
      expect(report.conforms, JSON.stringify(report.results, null, 1)).toBe(c.jsonOnly ? true : c.conforms);
      for (const x of report.results) expect(x.sourceShape?.startsWith(`${shapesIri(XAPI_MODEL)}#`), x.sourceShape).toBe(true);
      if (c.fault) {
        const { json, rdf } = typeof c.fault === 'string' ? { json: c.fault, rdf: c.fault } : c.fault;
        const shapes = turtleQuads(SHAPES);
        const owner = (src: string): string => (shapes.find(t => t.predicate.value === 'http://www.w3.org/ns/shacl#property' && t.object.value === src)?.subject.value ?? src).split('#')[1]!;
        expect(report.results.map(x => owner(x.sourceShape!))).toContain(rdf);
        expect(fromJson.results.map(x => owner(x.sourceShape))).toContain(json);
      }
    });
  });
}

describe('the LRS stores a statement\'s time as the shapes require', () => {
  it('converts a timestamp to UTC rather than rejecting it (xAPI 2.0, LRS part: Timestamps)', () => {
    expect(utcTimestamp('2026-10-01T08:00:00.000-04:00')).toBe('2026-10-01T12:00:00.000Z');
    expect(utcTimestamp('2008-09-15 15:53:00.601+00:00')).toBe('2008-09-15T15:53:00.601Z');
    expect(utcTimestamp('2023-05-04T12:00-05:00')).toBe('2023-05-04T17:00:00.000Z');
    expect(utcTimestamp('2026-10-01T12:00:00Z')).toBe('2026-10-01T12:00:00Z');
  });
  it('and the converted statement reads as one the shapes accept', async () => {
    const stmt = base({ timestamp: utcTimestamp('2023-05-04T12:00-05:00') });
    const r = await reading(stmt) as { nq: string };
    expect(shacl(r.nq, SHAPES).conforms).toBe(true);
    expect(validateXapiStatement(stmt).conforms).toBe(true);
  });
});
