/**
 * What the lrs-adapter sends to an LRS, run through the specification's statement template
 * validation against the xapi-x profile.
 *
 * The adapter has written four `iep:` keys under `result.extensions` since it first projected a
 * descriptor, and no profile declared them. The xapi-x profile does, and since version 2 it selects
 * a projection by the `xapix:Projection` category the adapter now writes. The statements here are
 * built by the adapter's own builder (applications/lrs-adapter/src/projection-statement.ts), the
 * one `projectDescriptorToLrs` posts, so a change to what the adapter writes is seen here.
 */
import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { buildProjectionStatement, XAPIX_NS as ADAPTER_XAPIX_NS, type ProjectionStatementArgs } from '../../lrs-adapter/src/projection-statement.js';
import { validates, type Json } from '../src/xapi-profile-server/processor.js';
import { whyNotAddable } from '../src/xapi-profile-server/service.js';
import { buildXapixProfileDoc, buildXapixProfileDocV1, XAPIX_PROFILE_V1_ID, XAPIX_PROFILE_VERSION_ID, XAPIX_PROJECTION_TEMPLATE_ID, XAPIX_V1_TEMPLATE_ID } from '../src/xapix/profile.js';
import { IEP_DECORATIONS, XAPIX_NS, XAPIX_PROFILE_ID, xapix } from '../src/xapix/namespace.js';
import { contentDigest, projectionCategory } from '../src/xapix/statement.js';
import { lintProfile } from '../src/xapi-profile-server/lint.js';
import { statementWithoutDecorations } from '../src/xapix/lint.js';
import { XAPIX_GRAPHS, xapixProfileTurtle } from '../src/xapix/publication.js';

type Doc = { id: string; conformsTo: string; versions: Json[]; concepts: Json[]; templates: Json[]; patterns: Json[] };
const doc = buildXapixProfileDoc() as Doc;
const v1 = buildXapixProfileDocV1() as Doc;
/** The templates a processor holds a statement to: a deprecated one is left out, as the profile server leaves it out. */
const current = doc.templates.filter(t => t.deprecated !== true);
const projected = (over: Partial<ProjectionStatementArgs> = {}): Json => buildProjectionStatement({
  descriptorIri: 'https://pod.example/fictional-learner/context-graphs/1790000000000.ttl',
  actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
  verbId: 'https://example.org/verbs/made-up-verb',
  objectId: 'https://example.org/activities/made-up-activity',
  ...over,
}, '6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c', '2026-11-15T12:00:00.000Z');
const narratives = ['A made-up first reading.', 'A made-up second reading.', 'A made-up third reading.'];
const extensionsOf = (statement: Json): Json => (statement.result as Json).extensions as Json;
const withExtension = (statement: Json, key: string, value: unknown): Json =>
  ({ ...statement, result: { ...(statement.result as Json), extensions: { ...extensionsOf(statement), [key]: value } } });
const withoutExtension = (statement: Json, key: string): Json => {
  const { [key]: _dropped, ...rest } = extensionsOf(statement);
  return { ...statement, result: { ...(statement.result as Json), extensions: rest } };
};

describe('the xapi-x profile', () => {
  it('is a document the profile server would hold: an xAPI Profiles 1.0 profile, version 2 revising version 1', () => {
    expect(whyNotAddable(doc)).toBeUndefined();
    expect(doc.conformsTo).toBe('https://w3id.org/xapi/profiles#1.0');
    expect(doc.id).toBe(XAPIX_PROFILE_ID);
    expect(doc.versions).toMatchObject([{ id: XAPIX_PROFILE_VERSION_ID, wasRevisionOf: [XAPIX_PROFILE_V1_ID] }, { id: XAPIX_PROFILE_V1_ID }]);
    expect(XAPIX_PROFILE_VERSION_ID).toBe(`${XAPIX_PROFILE_ID}/v/2`);
  });

  it('declares the four keys as result extensions, and the xapix: keys as context extensions, each with a label, a definition and a schema that parses', () => {
    const typed = (type: string) => doc.concepts.filter(c => c.type === type).map(c => c.id).sort();
    expect(typed('ResultExtension')).toEqual(Object.values(IEP_DECORATIONS).sort());
    expect(typed('ContextExtension')).toEqual((['controls', 'descriptorDigest', 'orderAttestation', 'previous', 'previousDigest', 'supersedesStatement'] as const).map(xapix));
    expect(typed('ActivityType')).toEqual([xapix('Projection')]);
    expect(doc.concepts.length).toBe(11);
    for (const concept of doc.concepts) {
      expect(concept.inScheme, String(concept.id)).toBe(XAPIX_PROFILE_VERSION_ID);
      expect((concept.prefLabel as Json).en, String(concept.id)).toBeTruthy();
      expect((concept.definition as Json).en, String(concept.id)).toBeTruthy();
      if (concept.type !== 'ActivityType') expect(() => JSON.parse(String(concept.inlineSchema)), String(concept.id)).not.toThrow();
      expect(concept.schema, 'at most one of schema and inlineSchema').toBeUndefined();
    }
  });

  it('selects a projection by its category, and keeps version 1\'s template deprecated', () => {
    expect(doc.templates.map(t => [t.id, t.deprecated === true])).toEqual([[XAPIX_PROJECTION_TEMPLATE_ID, false], [XAPIX_V1_TEMPLATE_ID, true]]);
    expect(current[0]!.contextCategoryActivityType).toEqual([xapix('Projection')]);
    for (const t of doc.templates) expect(t.inScheme).toBe(XAPIX_PROFILE_VERSION_ID);
  });

  it('passes the lint a published profile has to pass, with a statement the adapter builds as its example', () => {
    const examples = { statements: [{ id: 'a-projection', follows: [XAPIX_PROJECTION_TEMPLATE_ID], statement: projected({ descriptorDigest: contentDigest('made-up descriptor bytes') }) }], sequences: [] };
    expect(lintProfile(doc, examples)).toEqual([]);
  });

  it('still builds version 1 as it was published: four concepts, one template every statement matches', () => {
    expect(v1.versions.map(v => v.id)).toEqual([XAPIX_PROFILE_V1_ID]);
    expect(v1.concepts.map(c => c.id).sort()).toEqual(Object.values(IEP_DECORATIONS).sort());
    expect(v1.templates.map(t => [t.id, t.inScheme, t.deprecated])).toEqual([[XAPIX_V1_TEMPLATE_ID, XAPIX_PROFILE_V1_ID, undefined]]);
    expect(JSON.stringify(v1)).not.toContain(XAPIX_NS);
    // A statement written before the category existed is judged against version 1, and follows it.
    const { context: _none, ...before } = projected();
    expect(validates(before, v1.templates)).toMatchObject({ outcome: 'success', templates: [XAPIX_V1_TEMPLATE_ID] });
    expect(validates(before, current).outcome).toBe('unmatched');
  });
});

describe('a statement the lrs-adapter projects', () => {
  it('follows the descriptor projection template when the source is asserted', () => {
    expect(validates(projected(), current)).toMatchObject({ outcome: 'success', templates: [XAPIX_PROJECTION_TEMPLATE_ID] });
    expect(validates(projected({ modalStatus: 'Asserted' }), current).outcome).toBe('success');
  });

  it('follows it when the source is hypothetical, and when it keeps several narratives', () => {
    expect(validates(projected({ modalStatus: 'Hypothetical' }), current).outcome).toBe('success');
    const several = projected({ modalStatus: 'Hypothetical', coherentNarratives: narratives });
    expect(validates(several, current)).toMatchObject({ outcome: 'success', templates: [XAPIX_PROJECTION_TEMPLATE_ID] });
    expect(extensionsOf(several)[IEP_DECORATIONS.coherentNarratives]).toEqual(narratives);
    expect(extensionsOf(several)[IEP_DECORATIONS.projectionLossy]).toBe(true);
  });

  it('always says whether it is lossy: false for one asserted reading, true when the source was not asserted', () => {
    expect(extensionsOf(projected())[IEP_DECORATIONS.projectionLossy]).toBe(false);
    expect(extensionsOf(projected({ modalStatus: 'Hypothetical' }))[IEP_DECORATIONS.projectionLossy]).toBe(true);
    expect(extensionsOf(projected({ coherentNarratives: narratives }))[IEP_DECORATIONS.projectionLossy]).toBe(true);
    expect(extensionsOf(projected({ coherentNarratives: narratives.slice(0, 1) }))[IEP_DECORATIONS.projectionLossy]).toBe(false);
  });

  it('carries nothing under result.extensions that the profile does not declare', () => {
    const declared = new Set(doc.concepts.map(c => c.id));
    for (const statement of [projected(), projected({ modalStatus: 'Hypothetical', coherentNarratives: narratives })]) {
      for (const key of Object.keys(extensionsOf(statement))) expect(declared.has(key), key).toBe(true);
    }
  });

  it('carries the projection category, written with the IRI the namespace file has', () => {
    expect(ADAPTER_XAPIX_NS).toBe(XAPIX_NS);
    expect(((projected().context as Json).contextActivities as Json).category).toEqual([projectionCategory()]);
    expect((projected().context as Json).extensions).toBeUndefined();
    expect((projected().context as Json).statement).toBeUndefined();
  });

  it('states the descriptor\'s digest when its caller holds the bytes, and what it supersedes, voiding nothing', () => {
    const digest = contentDigest('made-up descriptor bytes');
    const earlier = ['b2e4a1c0-1111-4222-8333-444455556666', 'c3d5b2e1-aaaa-4bbb-8ccc-ddddeeeeffff'];
    const statement = projected({ descriptorDigest: digest, supersedesStatements: earlier });
    const context = statement.context as Json;
    expect(context.extensions).toEqual({ [xapix('descriptorDigest')]: digest, [xapix('supersedesStatement')]: earlier });
    expect(context.statement).toEqual({ objectType: 'StatementRef', id: earlier[0] });
    expect((statement.verb as Json).id).toBe('https://example.org/verbs/made-up-verb');
    expect(validates(statement, current)).toMatchObject({ outcome: 'success', templates: [XAPIX_PROJECTION_TEMPLATE_ID] });
  });

  it('keeps the decorations where a reader can drop them, and is the plain statement without them', () => {
    const statement = projected({ coherentNarratives: narratives, descriptorDigest: contentDigest('x') });
    const plain = statementWithoutDecorations(statement);
    expect(JSON.stringify(plain)).not.toContain('/ns/iep#');
    expect(JSON.stringify(plain)).not.toContain(XAPIX_NS);
    expect(Object.keys(plain).sort()).toEqual(['actor', 'id', 'object', 'result', 'timestamp', 'verb']);
    expect(plain.result).toEqual({ response: narratives[0] });
  });
});

describe('a statement that is not a well-formed projection', () => {
  it('is invalid, with the reason, when it names no source descriptor', () => {
    const result = validates(withoutExtension(projected(), IEP_DECORATIONS.sourceDescriptor), current);
    expect(result.outcome).toBe('invalid');
    expect(result.findings[0]).toMatchObject({ template: XAPIX_PROJECTION_TEMPLATE_ID, reason: 'presence is included, and the location has no value' });
    expect(result.findings[0]!.location).toContain(IEP_DECORATIONS.sourceDescriptor);
  });

  it('is invalid when it states no modal status, or one that is not a modal status', () => {
    expect(validates(withoutExtension(projected(), IEP_DECORATIONS.modalStatus), current).outcome).toBe('invalid');
    const result = validates(withExtension(projected(), IEP_DECORATIONS.modalStatus, 'Probably'), current);
    expect(result.outcome).toBe('invalid');
    expect(result.findings[0]!.location).toContain(IEP_DECORATIONS.modalStatus);
  });

  it('may be quoted, and may not call itself retracted: a retraction is a voiding statement', () => {
    expect(validates(withExtension(projected(), IEP_DECORATIONS.modalStatus, 'Quoted'), current).outcome).toBe('success');
    expect(validates(withExtension(projected(), IEP_DECORATIONS.modalStatus, 'Retracted'), current).outcome).toBe('invalid');
  });

  it('is invalid when it does not say whether it is lossy, or says so with something that is not a boolean', () => {
    expect(validates(withExtension(projected(), IEP_DECORATIONS.projectionLossy, false), current).outcome).toBe('success');
    expect(validates(withExtension(projected(), IEP_DECORATIONS.projectionLossy, 'yes'), current).outcome).toBe('invalid');
    expect(validates(withoutExtension(projected(), IEP_DECORATIONS.projectionLossy), current).outcome).toBe('invalid');
  });

  it('is invalid when it links to controls: a projection\'s descriptor carries its own', () => {
    const statement = projected();
    const linked = { ...statement, context: { ...(statement.context as Json), extensions: { [xapix('controls')]: 'https://bridge.example/statements/made-up/controls' } } };
    expect(validates(linked, current).outcome).toBe('invalid');
  });

  it('is unmatched, not invalid, when it does not claim to be a projection: version 2 asks only statements that carry the category', () => {
    const plain = { actor: { mbox: 'mailto:fictional-learner@example.org' }, verb: { id: 'https://example.org/verbs/made-up-verb' }, object: { id: 'https://example.org/activities/made-up-activity' } };
    expect(validates(plain, current).outcome).toBe('unmatched');
    // Version 1 asked every statement, and still does.
    expect(validates(plain, v1.templates).outcome).toBe('invalid');
  });
});

describe('the profile as it is published on the pod', () => {
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const PROFILE = 'https://w3id.org/xapi/profiles/ontology#';
  const quads = new Parser().parse(xapixProfileTurtle());
  const typed = (type: string): string[] => quads.filter(q => q.predicate.value === RDF_TYPE && q.object.value === type).map(q => q.subject.value).sort();

  it('is published at its own IRI, beside the ontology', () => {
    expect(XAPIX_GRAPHS.profile).toBe(doc.id);
    expect(XAPIX_GRAPHS.ontology).toBe(XAPIX_NS.replace(/#$/, ''));
  });

  it('states the profile, its versions, the result extensions and the templates the JSON-LD states', () => {
    expect(typed(`${PROFILE}Profile`)).toEqual([doc.id]);
    expect(typed('https://w3id.org/xapi/ontology#ResultExtension')).toEqual(Object.values(IEP_DECORATIONS).sort());
    expect(typed(`${PROFILE}StatementTemplate`)).toEqual([XAPIX_V1_TEMPLATE_ID, XAPIX_PROJECTION_TEMPLATE_ID].sort());
    expect(quads.some(q => q.subject.value === XAPIX_PROFILE_VERSION_ID)).toBe(true);
    expect(quads.some(q => q.subject.value === XAPIX_PROFILE_V1_ID)).toBe(true);
  });

  it('still gives version 1 as the triples first published: four result extensions and its one template', () => {
    const first = new Parser().parse(xapixProfileTurtle(buildXapixProfileDocV1()));
    expect(first.some(q => q.subject.value === XAPIX_PROFILE_VERSION_ID || q.object.value === XAPIX_PROFILE_VERSION_ID)).toBe(false);
    expect(first.filter(q => q.predicate.value === RDF_TYPE && q.object.value === `${PROFILE}StatementTemplate`).map(q => q.subject.value)).toEqual([XAPIX_V1_TEMPLATE_ID]);
  });

  it('gives the same bytes each time', () => {
    expect(xapixProfileTurtle()).toBe(xapixProfileTurtle());
  });
});
