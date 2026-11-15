/**
 * xapi-x past its first slice: emitters write the decorations, an order can be chained and its
 * basis named, and the rules of xapix/README.md section 7 are code.
 *
 * The statements are built by the lrs-adapter's own builder. Whether a statement follows a
 * template is the profile processor's answer throughout.
 */
import { describe, it, expect } from 'vitest';
import { buildProjectionStatement } from '../../lrs-adapter/src/projection-statement.js';
import type { Json } from '../src/xapi-profile-server/processor.js';
import { buildXapixProfileDoc } from '../src/xapix/profile.js';
import { IEP_DECORATIONS, xapix } from '../src/xapix/namespace.js';
import { canonicalJson, chained, contentDigest, orderBasis, projectionCategory, statementDigest } from '../src/xapix/statement.js';
import { lintXapixProfile, lintXapixStatements, outcomeVerbsOf, schemaFailure, statementWithoutDecorations, withoutDecorations } from '../src/xapix/lint.js';

const POD = 'https://pod.example/fictional-agent/';
const D1 = `${POD}context-graphs/1790000000000.ttl`;
const xapixDoc = buildXapixProfileDoc() as Json;
const result = (s: Json): Json => s.result as Json;
const context = (s: Json): Json => s.context as Json;
const codes = (findings: Array<{ code: string }>): string[] => [...new Set(findings.map(f => f.code))].sort();

describe('an order and what stands behind it', () => {
  const step = (id: string, n: number): Json => ({ id, actor: { mbox: 'mailto:fictional-agent@example.org' }, verb: { id: 'https://example.org/verbs/made-up-step' },
    object: { id: `https://example.org/tasks/made-up-task/${n}` }, context: { registration: '0a1b2c3d-0000-4000-8000-000000000001' }, timestamp: `2026-11-15T12:00:0${n}.000Z` });
  const run = [step('aaaaaaaa-0000-4000-8000-000000000001', 1), step('aaaaaaaa-0000-4000-8000-000000000002', 2), step('aaaaaaaa-0000-4000-8000-000000000003', 3)];

  it('writes canonical JSON as RFC 8785 does: sorted members, no whitespace', () => {
    expect(canonicalJson({ b: [1, 'two', null, true], a: { z: 1.5, y: 'é' } })).toBe('{"a":{"y":"é","z":1.5},"b":[1,"two",null,true]}');
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });

  it('digests a statement as its emitter sent it: what the LRS sets does not change the digest, and what the emitter wrote does', () => {
    const sent = run[0]!;
    expect(statementDigest({ ...sent, stored: '2026-11-15T12:00:09.000Z', authority: { name: 'made-up LRS' }, version: '2.0.0' })).toBe(statementDigest(sent));
    expect(statementDigest({ ...sent, timestamp: '2026-11-15T12:00:02.000Z' })).not.toBe(statementDigest(sent));
    expect(statementDigest(sent)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is only the emitter\'s claim until something backs it', () => {
    expect(orderBasis(run)).toMatchObject({ basis: 'ProviderClaimed', iri: xapix('ProviderClaimed') });
  });

  it('is the store\'s when every statement has the time the LRS stored it, in that order', () => {
    const stored = run.map((s, i) => ({ ...s, stored: `2026-11-15T12:01:0${i}.000Z` }));
    expect(orderBasis(stored).basis).toBe('StoreAssigned');
    expect(orderBasis([stored[1]!, stored[0]!, stored[2]!]).basis).toBe('ProviderClaimed');
  });

  it('is chained when each statement carries the digest of the one before, and a change or a reorder breaks it', () => {
    const chain = chained(run);
    expect(context(chain[0]!).extensions).toBeUndefined();
    expect(context(chain[1]!).extensions).toEqual({ [xapix('previous')]: run[0]!.id, [xapix('previousDigest')]: statementDigest(chain[0]!) });
    expect(orderBasis(chain).basis).toBe('Chained');
    const altered = [{ ...chain[0]!, timestamp: '2026-11-14T00:00:00.000Z' }, chain[1]!, chain[2]!];
    expect(orderBasis(altered)).toMatchObject({ basis: 'ProviderClaimed' });
    expect(orderBasis([chain[0]!, chain[2]!, chain[1]!]).basis).toBe('ProviderClaimed');
    // The chain's keys are declared, and the chained statements pass the rules.
    expect(lintXapixStatements(chain, [xapixDoc])).toEqual([]);
  });

  it('is attested only when the reader verified the signature and the list is these statements in this order', () => {
    const chain = chained(run), digests = chain.map(statementDigest);
    expect(orderBasis(chain, { digests, signatureVerified: true, signer: 'did:example:fictional-observer' })).toMatchObject({ basis: 'Attested', signer: 'did:example:fictional-observer' });
    expect(orderBasis(chain, { digests, signatureVerified: false }).basis).toBe('Chained');
    expect(orderBasis(chain, { digests: digests.slice(0, 2), signatureVerified: true }).basis).toBe('Chained');
  });
});

describe('the xapi-x rules over statements', () => {
  const adapter = (over: Json = {}): Json => buildProjectionStatement({
    descriptorIri: D1, actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
    verbId: 'https://example.org/verbs/made-up-verb', objectId: 'https://example.org/activities/made-up-activity', ...over,
  } as never, '6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c', '2026-11-15T12:00:00.000Z');
  const withResult = (s: Json, over: Json, extensions: Json = {}): Json => ({ ...s, result: { ...result(s), ...over, extensions: { ...(result(s).extensions as Json), ...extensions } } });
  const withContext = (s: Json, extensions: Json, over: Json = {}): Json => ({ ...s, context: { ...context(s), ...over, extensions: { ...(context(s).extensions as Json ?? {}), ...extensions } } });
  const lint = (s: Json, options = {}) => lintXapixStatements([s], [xapixDoc], options);

  it('finds nothing in what the adapter sends', () => {
    expect(lint(adapter())).toEqual([]);
    expect(lint(adapter({ modalStatus: 'Hypothetical', coherentNarratives: ['A made-up reading.', 'Another.'] }))).toEqual([]);
  });

  it('X1: a decoration no profile declares, or one in the wrong place', () => {
    expect(codes(lint(withResult(adapter(), {}, { [`${xapix('Projection')}Extra`]: 1 })))).toEqual(['xapix-undeclared']);
    expect(codes(lint(withResult(adapter(), {}, { [xapix('descriptorDigest')]: contentDigest('x') })))).toEqual(['xapix-misplaced']);
  });

  it('X2: a value the key\'s schema does not allow', () => {
    expect(codes(lint(withResult(adapter(), {}, { [IEP_DECORATIONS.sourceDescriptor]: 'not an iri' })))).toEqual(['xapix-value']);
    expect(codes(lint(withContext(adapter(), { [xapix('descriptorDigest')]: 'sha256:short' })))).toEqual(['xapix-value']);
    expect(schemaFailure(['a'], { type: 'array', items: { type: 'string' }, minItems: 2 })).toContain('at least 2');
    expect(schemaFailure('x', { enum: ['x', 'y'] })).toBeNull();
  });

  it('X3: a source descriptor without a modal status, and the reverse', () => {
    const { [IEP_DECORATIONS.modalStatus]: _m, ...noStatus } = result(adapter()).extensions as Json;
    expect(codes(lint({ ...adapter(), result: { extensions: noStatus } }))).toEqual(['xapix-source-and-status']);
    expect(codes(lint({ ...adapter(), result: { extensions: { [IEP_DECORATIONS.modalStatus]: 'Asserted' } } }))).toEqual(['xapix-source-and-status']);
  });

  it('X4: an outcome on a statement that is not asserted, in a member or in the verb', () => {
    const hypothetical = adapter({ modalStatus: 'Hypothetical' });
    expect(lint(withResult(hypothetical, { success: true, score: { scaled: 1 } })).map(f => [f.code, f.path])).toEqual([
      ['xapix-outcome-not-asserted', 'statements[0].result.success'], ['xapix-outcome-not-asserted', 'statements[0].result.score']]);
    expect(lint(withResult(adapter(), { success: true }))).toEqual([]);
    expect(codes(lint(hypothetical, { outcomeVerbs: ['https://example.org/verbs/made-up-verb'] }))).toEqual(['xapix-outcome-not-asserted']);
    // A profile shows a verb to be an outcome verb by a template that requires an outcome with it.
    const profile: Json = { templates: [{ id: 'https://example.org/profile/templates/passed', verb: 'https://example.org/verbs/passed', rules: [{ location: '$.result.success', presence: 'included' }] },
      { id: 'https://example.org/profile/templates/proposed', verb: 'https://example.org/verbs/proposed', rules: [{ location: '$.result.response', presence: 'included' }] }] };
    expect([...outcomeVerbsOf([profile])]).toEqual(['https://example.org/verbs/passed']);
  });

  it('X5 and X6: several narratives or a status that is not asserted, called faithful; and a projection that does not say', () => {
    expect(codes(lint(withResult(adapter({ coherentNarratives: ['a', 'b'] }), {}, { [IEP_DECORATIONS.projectionLossy]: false })))).toEqual(['xapix-lossy']);
    expect(codes(lint(withResult(adapter({ modalStatus: 'Hypothetical' }), {}, { [IEP_DECORATIONS.projectionLossy]: false })))).toEqual(['xapix-lossy']);
    const { [IEP_DECORATIONS.projectionLossy]: _l, ...silent } = result(adapter()).extensions as Json;
    const unsaid = { ...adapter(), result: { extensions: silent } };
    expect(codes(lint(unsaid))).toEqual(['xapix-lossy']);
    // Before the adapter always stated it, absent meant not stated.
    expect(lint({ ...unsaid, timestamp: '2026-11-14T23:59:59.000Z' })).toEqual([]);
  });

  it('X7: a statement that supersedes itself, or refers a plain LRS to a statement it does not supersede', () => {
    const earlier = 'b2e4a1c0-1111-4222-8333-444455556666';
    expect(lint(adapter({ supersedesStatements: [earlier] }))).toEqual([]);
    expect(codes(lint(adapter({ supersedesStatements: ['6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c'] })))).toEqual(['xapix-supersedes']);
    expect(codes(lint(withContext(adapter({ supersedesStatements: [earlier] }), {}, { statement: { objectType: 'StatementRef', id: 'c3d5b2e1-aaaa-4bbb-8ccc-ddddeeeeffff' } })))).toEqual(['xapix-supersedes']);
    expect(codes(lint(withContext(adapter(), { [xapix('supersedesStatement')]: [earlier] })))).toEqual(['xapix-supersedes']);
  });

  it('X8: a bare number that claims a place in a sequence, under any namespace', () => {
    expect(codes(lint(withContext(adapter(), { 'https://example.org/ext/sequenceNumber': 4 })))).toEqual(['xapix-bare-position']);
    expect(codes(lint(withContext(adapter(), { 'https://example.org/ext/step-index': 4 })))).toEqual(['xapix-bare-position']);
    expect(lint(withContext(adapter(), { 'https://example.org/ext/attemptCount': 4, 'https://example.org/ext/sequence': 'a label, not a number' }))).toEqual([]);
  });

  it('a digest of a statement it does not name, and controls on a statement that names its descriptor', () => {
    expect(codes(lint(withContext(adapter(), { [xapix('previousDigest')]: contentDigest('x') })))).toEqual(['xapix-chain']);
    expect(codes(lint(withContext(adapter(), { [xapix('controls')]: 'https://bridge.example/statements/made-up/controls' })))).toEqual(['xapix-controls']);
  });
});

describe('the xapi-x rules over a profile', () => {
  const P = 'https://example.org/profile', V = `${P}/v/1`;
  const idea = 'https://id.i2idl.org/concept/formative-assessment', offer = 'https://bridge.example/affordances/request-remediation';
  const part = (id: string, type: string, more: Json = {}): Json => ({ id: `${P}/${id}`, type, inScheme: V, prefLabel: { en: id }, definition: { en: `A made-up ${type}.` }, ...more });
  const profile = (conceptMore: Json = {}, templateMore: Json = {}): Json => ({
    '@context': 'https://w3id.org/xapi/profiles/context', id: P, type: 'Profile', conformsTo: 'https://w3id.org/xapi/profiles#1.0',
    prefLabel: { en: 'made-up profile' }, definition: { en: 'A made-up profile.' }, author: { type: 'Organization', name: 'Made-up Org' }, versions: [{ id: V }],
    concepts: [part('verbs/checked-understanding', 'Verb', conceptMore)],
    templates: [part('templates/checked', 'StatementTemplate', { verb: `${P}/verbs/checked-understanding`, ...templateMore })],
    patterns: [],
  });
  const statement: Json = { actor: { mbox: 'mailto:fictional-learner@example.org' }, verb: { id: `${P}/verbs/checked-understanding` }, object: { id: 'https://example.org/lessons/made-up/check-2' } };
  const examples = (s: Json) => ({ statements: [{ id: 'checked', follows: [`${P}/templates/checked`], statement: s }], sequences: [] });
  const linked = profile({ [xapix('evidences')]: [{ '@id': idea }] }, { [xapix('offers')]: [{ '@id': offer }] });

  it('X9: an evidence link and an offer written as links, to targets that exist', () => {
    expect(lintXapixProfile(linked, examples(statement), { designIdea: iri => iri === idea, affordance: iri => iri === offer })).toEqual([]);
    expect(lintXapixProfile(linked, examples(statement), { designIdea: () => false, affordance: () => false }).map(f => f.code)).toEqual(['xapix-link-target', 'xapix-link-target']);
    expect(codes(lintXapixProfile(profile({ [xapix('evidences')]: [idea] })))).toEqual(['xapix-link-shape']);
    expect(codes(lintXapixProfile(profile({ [xapix('offers')]: [{ '@id': offer }] })))).toEqual(['xapix-link-shape']);
  });

  it('X10: without its decorations the profile is the profile a plain processor reads', () => {
    expect(JSON.stringify(withoutDecorations(linked))).not.toContain(xapix('evidences').slice(0, -9));
    expect(withoutDecorations(linked)).toEqual(profile());
    expect(lintXapixProfile(linked, examples(statement))).toEqual([]);
  });

  it('X10: a template that asks for no decoration is still followed by its example with the decorations removed', () => {
    const decorated: Json = { ...statement, result: { extensions: { [IEP_DECORATIONS.sourceDescriptor]: D1, [IEP_DECORATIONS.modalStatus]: 'Asserted', [IEP_DECORATIONS.projectionLossy]: false } },
      context: { contextActivities: { category: [projectionCategory()] } } };
    expect(statementWithoutDecorations(decorated)).toEqual(statement);
    expect(lintXapixProfile(profile(), examples(decorated))).toEqual([]);
    // A template that depends on a decoration without saying so in a way the rule can see: it hides the key behind a wildcard.
    const hidden = profile({}, { rules: [{ location: '$.result.extensions.*', presence: 'included' }] });
    expect(codes(lintXapixProfile(hidden, examples(decorated)))).toEqual(['xapix-not-a-superset']);
    // An offer asks nothing of a statement, so a template that carries one is still checked.
    const offering = profile({}, { rules: [{ location: '$.result.extensions.*', presence: 'included' }], [xapix('offers')]: [{ '@id': offer }] });
    expect(codes(lintXapixProfile(offering, examples(decorated)))).toEqual(['xapix-not-a-superset']);
  });
});
