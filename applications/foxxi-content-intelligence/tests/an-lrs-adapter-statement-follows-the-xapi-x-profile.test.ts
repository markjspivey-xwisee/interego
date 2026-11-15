/**
 * What the lrs-adapter sends to an LRS, run through the specification's statement template
 * validation against the xapi-x profile.
 *
 * The adapter has written four `iep:` keys under `result.extensions` since it first projected a
 * descriptor, and no profile declared them. The xapi-x profile does. The statements here are
 * built by the adapter's own builder (applications/lrs-adapter/src/projection-statement.ts), the
 * one `projectDescriptorToLrs` posts, so a change to what the adapter writes is seen here.
 */
import { describe, it, expect } from 'vitest';
import { buildProjectionStatement, type ProjectionStatementArgs } from '../../lrs-adapter/src/projection-statement.js';
import { validates, type Json } from '../src/xapi-profile-server/processor.js';
import { whyNotAddable } from '../src/xapi-profile-server/service.js';
import { buildXapixProfileDoc, XAPIX_PROFILE_VERSION_ID, XAPIX_PROJECTION_TEMPLATE_ID } from '../src/xapix/profile.js';
import { IEP_DECORATIONS, XAPIX_NS, XAPIX_PROFILE_ID } from '../src/xapix/namespace.js';

const doc = buildXapixProfileDoc() as { id: string; conformsTo: string; versions: Json[]; concepts: Json[]; templates: Json[]; patterns: Json[] };
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
  it('is a document the profile server would hold: an xAPI Profiles 1.0 profile with one version', () => {
    expect(whyNotAddable(doc)).toBeUndefined();
    expect(doc.conformsTo).toBe('https://w3id.org/xapi/profiles#1.0');
    expect(doc.id).toBe(XAPIX_PROFILE_ID);
    expect(doc.versions.map(v => v.id)).toEqual([XAPIX_PROFILE_VERSION_ID]);
  });

  it('declares the four keys, each as a result extension with a label, a definition and a schema that parses', () => {
    expect(doc.concepts.map(c => c.id).sort()).toEqual(Object.values(IEP_DECORATIONS).sort());
    for (const concept of doc.concepts) {
      expect(concept.type, String(concept.id)).toBe('ResultExtension');
      expect(concept.inScheme, String(concept.id)).toBe(XAPIX_PROFILE_VERSION_ID);
      expect((concept.prefLabel as Json).en, String(concept.id)).toBeTruthy();
      expect((concept.definition as Json).en, String(concept.id)).toBeTruthy();
      expect(() => JSON.parse(String(concept.inlineSchema)), String(concept.id)).not.toThrow();
      expect(concept.schema, 'at most one of schema and inlineSchema').toBeUndefined();
    }
  });

  it('mints no xapi-x term yet: every concept is an iep: term the adapter already writes', () => {
    expect(JSON.stringify(doc.concepts)).not.toContain(XAPIX_NS);
  });
});

describe('a statement the lrs-adapter projects', () => {
  it('follows the descriptor projection template when the source is asserted', () => {
    expect(validates(projected(), doc.templates)).toMatchObject({ outcome: 'success', templates: [XAPIX_PROJECTION_TEMPLATE_ID] });
    expect(validates(projected({ modalStatus: 'Asserted' }), doc.templates).outcome).toBe('success');
  });

  it('follows it when the source is hypothetical, and when it keeps several narratives', () => {
    expect(validates(projected({ modalStatus: 'Hypothetical' }), doc.templates).outcome).toBe('success');
    const several = projected({ modalStatus: 'Hypothetical', coherentNarratives: narratives });
    expect(validates(several, doc.templates)).toMatchObject({ outcome: 'success', templates: [XAPIX_PROJECTION_TEMPLATE_ID] });
    expect(extensionsOf(several)[IEP_DECORATIONS.coherentNarratives]).toEqual(narratives);
    expect(extensionsOf(several)[IEP_DECORATIONS.projectionLossy]).toBe(true);
  });

  it('carries nothing under result.extensions that the profile does not declare', () => {
    const declared = new Set(doc.concepts.map(c => c.id));
    for (const statement of [projected(), projected({ modalStatus: 'Hypothetical', coherentNarratives: narratives })]) {
      for (const key of Object.keys(extensionsOf(statement))) expect(declared.has(key), key).toBe(true);
    }
  });

  it('keeps the decorations in one place, so a reader that drops them is left with the plain statement', () => {
    const statement = projected({ coherentNarratives: narratives });
    const { extensions: _decorations, ...plainResult } = statement.result as Json;
    const plain = { ...statement, result: plainResult };
    expect(JSON.stringify(plain)).not.toContain('/ns/iep#');
    expect(Object.keys(plain).sort()).toEqual(['actor', 'id', 'object', 'result', 'timestamp', 'verb']);
  });
});

describe('a statement that is not a well-formed projection', () => {
  it('is invalid, with the reason, when it names no source descriptor', () => {
    const result = validates(withoutExtension(projected(), IEP_DECORATIONS.sourceDescriptor), doc.templates);
    expect(result.outcome).toBe('invalid');
    expect(result.findings[0]).toMatchObject({ template: XAPIX_PROJECTION_TEMPLATE_ID, reason: 'presence is included, and the location has no value' });
    expect(result.findings[0]!.location).toContain(IEP_DECORATIONS.sourceDescriptor);
  });

  it('is invalid when it states no modal status, or one that is not a modal status', () => {
    expect(validates(withoutExtension(projected(), IEP_DECORATIONS.modalStatus), doc.templates).outcome).toBe('invalid');
    const result = validates(withExtension(projected(), IEP_DECORATIONS.modalStatus, 'Probably'), doc.templates);
    expect(result.outcome).toBe('invalid');
    expect(result.findings[0]!.location).toContain(IEP_DECORATIONS.modalStatus);
  });

  it('is invalid when it says whether it is lossy with something that is not a boolean', () => {
    expect(validates(withExtension(projected(), IEP_DECORATIONS.projectionLossy, false), doc.templates).outcome).toBe('success');
    expect(validates(withExtension(projected(), IEP_DECORATIONS.projectionLossy, 'yes'), doc.templates).outcome).toBe('invalid');
  });

  it('is invalid when it carries no decoration at all: within this profile every statement is asked', () => {
    const plain = { actor: { mbox: 'mailto:fictional-learner@example.org' }, verb: { id: 'https://example.org/verbs/made-up-verb' }, object: { id: 'https://example.org/activities/made-up-activity' } };
    expect(validates(plain, doc.templates).outcome).toBe('invalid');
  });
});
