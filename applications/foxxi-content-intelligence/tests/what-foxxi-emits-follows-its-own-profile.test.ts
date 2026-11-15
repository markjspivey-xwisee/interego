/**
 * Statements Foxxi itself emits, run through the specification's own statement template
 * validation against Foxxi's own profile.
 *
 * The specification matches on determining properties and a statement must follow every template
 * it matches. Templates that shared a verb and took any object type therefore failed each other's
 * statements: a production run failed the descriptor templates, a course completion failed the
 * performance template, a plain voiding failed the descriptor voiding. Each kind now carries a
 * typed context activity the templates select on (src/xapi-profile.ts).
 */
import { describe, it, expect } from 'vitest';
import { buildFoxxiProfileDoc, descriptorProjectionCategory, performanceRecordCategory, performanceCategoriesFor, outcomeResultFor, isLearningActivityType, FOXXI_NS } from '../src/xapi-profile.js';
import { elementsOf, follows, matches, validates, type Json } from '../src/xapi-profile-server/processor.js';
import { projectMeshEntry } from '../src/mesh-event-projector.js';
import { ingestExternalRun } from '../src/agent-run-ingest.js';
import { buildPerformanceStatement, momOutcomeVerb, recordedActivityType } from '../src/performance-statement.js';

const doc = buildFoxxiProfileDoc({ generatedAt: '2026-07-22T00:00:00.000Z' }) as { id: string; concepts: Json[]; templates: Json[]; patterns: Json[] };
const T = (name: string) => `${doc.id}/templates/${name}`;
/** Every template some statement in this file followed, and every statement checked: the last tests read them. */
const followed = new Set<string>(), checked: Json[] = [];
const check = (statement: unknown) => {
  const result = validates(statement as Json, doc.templates);
  checked.push(statement as Json);
  if (result.outcome === 'success') for (const t of result.templates) followed.add(t);
  return result;
};
const POD = 'https://pod.example/fictional-agent/';
const projected = (entry: Partial<Parameters<typeof projectMeshEntry>[0]>) => projectMeshEntry({
  descriptorUrl: 'https://pod.example/fictional-agent/context-graphs/1790000000000.ttl', describes: ['urn:graph:made-up-1790000000000'],
  conformsTo: ['https://example.org/types/RefundDecision'], modalStatus: 'Asserted', ...entry }, POD)!.statement;
const ADL = 'http://adlnet.gov/expapi';
const learner = { mbox: 'mailto:fictional-learner@example.org' };

describe('a descriptor projection', () => {
  it('follows the descriptor template for its verb, and the performance template when it is an outcome', () => {
    expect(check(projected({ verb: `${FOXXI_NS}performed` }))).toMatchObject({ outcome: 'success', templates: [T('performed-descriptor')] });
    expect(check(projected({ success: true }))).toMatchObject({ outcome: 'success', templates: [T('production-performance-completed')] });
    expect(check(projected({ success: false }))).toMatchObject({ outcome: 'success', templates: [T('production-performance-failed')] });
    expect(check(projected({ modalStatus: 'Hypothetical' })).outcome).toBe('success');
    expect(check(projected({ modalStatus: 'Counterfactual' })).outcome).toBe('success');
  });

  it('that revises another follows both the descriptor and the superseding template', () => {
    const r = check(projected({ verb: `${FOXXI_NS}performed`, supersedes: ['https://pod.example/fictional-agent/context-graphs/1780000000000.ttl'] }));
    expect(r.outcome).toBe('success');
    expect([...r.templates].sort()).toEqual([T('performed-descriptor'), T('superseding-descriptor')].sort());
  });

  it('that is retracted follows both voiding templates', () => {
    const r = check(projected({ modalStatus: 'Retracted' }));
    expect(r.outcome).toBe('success');
    expect([...r.templates].sort()).toEqual([T('voided-descriptor'), T('voided-statement')].sort());
  });
});

describe('what is not a descriptor projection', () => {
  it('an ingested production run follows the production template and no descriptor template', () => {
    const run = ingestExternalRun({ agentDid: 'did:web:example.org:agents:fictional', task: { name: 'Sort the made-up invoices' },
      toolCalls: [{ tool: 'made_up_tool', success: true }], outcome: { success: true, quality: 0.9 } });
    expect(run.statements.length).toBeGreaterThan(0);
    for (const s of run.statements) expect(check(s), JSON.stringify(s.verb)).toMatchObject({ outcome: 'success', templates: [T('performed-production')] });
  });

  it('a course or lesson completion or failure follows its own template, with no performance context asked of it', () => {
    const about = (verb: string, type: string, result: object) => ({ actor: learner, verb: { id: `${ADL}/verbs/${verb}` },
      object: { id: 'https://example.org/courses/made-up', definition: { type: `${ADL}/activities/${type}` } }, result });
    expect(check(about('completed', 'course', { completion: true }))).toMatchObject({ outcome: 'success', templates: [T('completed')] });
    expect(check(about('completed', 'lesson', { completion: true }))).toMatchObject({ outcome: 'success', templates: [T('lesson-completed')] });
    expect(check(about('failed', 'course', { success: false }))).toMatchObject({ outcome: 'success', templates: [T('course-failed')] });
    expect(check(about('failed', 'lesson', { success: false, score: { scaled: 0.2 } }))).toMatchObject({ outcome: 'success', templates: [T('lesson-failed')] });
  });

  it('a plain voiding follows the statement template alone', () => {
    const plain = { actor: learner, verb: { id: `${ADL}/verbs/voided` }, object: { objectType: 'StatementRef', id: '11111111-1111-4111-8111-111111111111' } };
    expect(check(plain)).toMatchObject({ outcome: 'success', templates: [T('voided-statement')] });
  });

  it('a recorded performance carries the performance category, and is held to that template', () => {
    const recorded = (extensions: object) => ({ actor: learner, verb: { id: `${ADL}/verbs/completed` },
      object: { id: 'https://example.org/tasks/made-up', definition: { type: 'https://example.org/types/Move' } }, result: { success: true },
      context: { contextActivities: { category: [{ id: `${doc.id}`, objectType: 'Activity' }, performanceRecordCategory()] }, extensions } });
    expect(check(recorded({ [`${FOXXI_NS}contextKind`]: 'production', [`${FOXXI_NS}actorKind`]: 'human' })))
      .toMatchObject({ outcome: 'success', templates: [T('production-performance-completed')] });
    // Marked as a performance and missing what a performance must say: invalid, not unmatched.
    const bare = check(recorded({}));
    expect(bare.outcome).toBe('invalid');
    expect(bare.templates).toEqual([T('production-performance-completed')]);
  });

  it('a performance recorded against a course or a lesson is that course\'s or lesson\'s outcome, and matches one template', () => {
    // As the bridge's record_performance builds it: the object type decides the kind.
    const recorded = (type: string, success: boolean, quality?: number) => ({ actor: learner, verb: { id: `${ADL}/verbs/${success ? 'completed' : 'failed'}` },
      object: { id: 'https://example.org/things/made-up', definition: { type } },
      result: { success, ...outcomeResultFor(type, success), ...(quality !== undefined ? { score: { scaled: quality } } : {}) },
      context: { contextActivities: { category: [{ id: doc.id, objectType: 'Activity' }, ...performanceCategoriesFor(type)] },
        extensions: { [`${FOXXI_NS}contextKind`]: 'production', [`${FOXXI_NS}actorKind`]: 'human' } } });
    const course = `${ADL}/activities/course`, lesson = `${ADL}/activities/lesson`;
    expect(isLearningActivityType(course)).toBe(true);
    expect(isLearningActivityType('https://example.org/types/Move')).toBe(false);
    // It used to match both the course template and the performance template, and fail the first for want of result.completion.
    expect(check(recorded(course, true))).toMatchObject({ outcome: 'success', templates: [T('completed')] });
    expect(check(recorded(lesson, true))).toMatchObject({ outcome: 'success', templates: [T('lesson-completed')] });
    expect(check(recorded(course, false))).toMatchObject({ outcome: 'success', templates: [T('course-failed')] });
    expect(check(recorded(lesson, false, 0.3))).toMatchObject({ outcome: 'success', templates: [T('lesson-failed')] });
    // Anything else is a performance record, as before.
    expect(check(recorded('https://example.org/types/Move', true))).toMatchObject({ outcome: 'success', templates: [T('production-performance-completed')] });
    expect(check(recorded(`${FOXXI_NS}ProductionTask`, false))).toMatchObject({ outcome: 'success', templates: [T('production-performance-failed')] });
    // A failed lesson nobody scored is still that lesson's failure: the score is recommended, not required.
    expect(check(recorded(lesson, false))).toMatchObject({ outcome: 'success', templates: [T('lesson-failed')] });
  });

  it('no outcome Foxxi records can match a learning template and the performance template together', () => {
    for (const type of [`${ADL}/activities/course`, `${ADL}/activities/lesson`, 'https://example.org/types/Move', `${FOXXI_NS}ProductionTask`, undefined]) {
      const marked = performanceCategoriesFor(type).length > 0;
      expect(marked, String(type)).toBe(!isLearningActivityType(type));
    }
    // A descriptor typed as a course and projected as an outcome carries the descriptor marker only.
    const cats = ((projected({ success: true, conformsTo: [`${ADL}/activities/course`] }).context as { contextActivities: { category: Array<{ definition: { type: string } }> } }).contextActivities.category).map(c => c.definition.type);
    expect(cats).toEqual([descriptorProjectionCategory().definition.type]);
  });

  it('what record_performance builds follows the profile, for every kind of thing a performance is recorded against', () => {
    // The statement the bridge's record_performance and its signed form now build, by the function they call.
    const built = (activityType: unknown, success: boolean, more: Partial<Parameters<typeof buildPerformanceStatement>[0]> = {}) => buildPerformanceStatement({
      id: '11111111-1111-4111-8111-111111111111', registration: '22222222-2222-4222-8222-222222222222', timestamp: '2026-11-14T00:00:00.000Z',
      homePage: 'https://bridge.example', performer: 'did:web:example.org:agents:fictional',
      taskId: 'https://bridge.example/tasks/made-up', taskName: 'Sort the made-up invoices', activityType, success,
      profileUrl: doc.id, observedBy: 'did:web:example.org:observers:fictional', actorKind: 'agent',
      evidence: { binding: 'self-reported' }, ...more });
    const course = `${ADL}/activities/course`, lesson = `${ADL}/activities/lesson`;
    expect(check(built(undefined, true))).toMatchObject({ outcome: 'success', templates: [T('production-performance-completed')] });
    expect(check(built('  ', false))).toMatchObject({ outcome: 'success', templates: [T('production-performance-failed')] });
    expect(check(built('urn:made-up:Move', true, { quality: 0.8, durationIso: 'PT5M', costUsd: 0.02 }))).toMatchObject({ outcome: 'success', templates: [T('production-performance-completed')] });
    expect(check(built(course, true))).toMatchObject({ outcome: 'success', templates: [T('completed')] });
    expect(check(built(course, false))).toMatchObject({ outcome: 'success', templates: [T('course-failed')] });
    expect(check(built(lesson, true))).toMatchObject({ outcome: 'success', templates: [T('lesson-completed')] });
    expect(check(built(lesson, false, { quality: 0.3 }))).toMatchObject({ outcome: 'success', templates: [T('lesson-failed')] });
    // A failure nobody scored: the routes keep quality optional, so the statement states no score,
    // and the lesson template recommends one without requiring it.
    const unscored = built(lesson, false);
    expect(check(unscored)).toMatchObject({ outcome: 'success', templates: [T('lesson-failed')] });
    expect((unscored as { result: unknown }).result).toEqual({ success: false });
    // Every kind of thing, each outcome, scored and not: none is refused by the profile.
    for (const type of [course, lesson, undefined, 'urn:made-up:Move'])
      for (const success of [true, false])
        for (const quality of [undefined, 0.4])
          expect(check(built(type, success, quality === undefined ? {} : { quality })).outcome, `${String(type)} ${success} ${String(quality)}`).toBe('success');

    // The shape itself, where the two routes used to spell it out separately.
    const s = built('urn:made-up:Move', true, { quality: 0.8, evidence: { binding: 'shape-validated', shapeIri: 'https://example.org/shapes/made-up' }, workTrajectory: [{ step: 1 }] }) as {
      verb: { id: string }; object: { definition: { type: string } }; result: Record<string, unknown>;
      context: { registration: string; contextActivities: { category: Array<{ id: string }> }; extensions: Record<string, unknown> } };
    expect(s.verb).toEqual(momOutcomeVerb(true));
    expect(s.object.definition.type).toBe('urn:made-up:Move');
    expect(s.result).toEqual({ success: true, score: { scaled: 0.8 } });
    expect(s.context.contextActivities.category[0]!.id).toBe(doc.id);
    expect(s.context.extensions[`${FOXXI_NS}contextKind`]).toBe('production');
    expect(s.context.extensions[`${FOXXI_NS}evidenceShape`]).toBe('https://example.org/shapes/made-up');
    expect(Object.values(s.context.extensions)).toContainEqual([{ step: 1 }]);
    expect((built(course, true) as { result: unknown }).result).toEqual({ success: true, completion: true });
    expect(recordedActivityType(undefined)).toBe(`${FOXXI_NS}ProductionTask`);
    expect(recordedActivityType(' urn:made-up:Move ')).toBe('urn:made-up:Move');
  });

  it('the two categories are distinct typed activities', () => {
    expect(descriptorProjectionCategory().definition.type).not.toBe(performanceRecordCategory().definition.type);
    expect(descriptorProjectionCategory().id).not.toBe(performanceRecordCategory().id);
  });
});

// The templates above are reached through the functions that emit. The ones below have no single
// builder to call from a test, so each is given the smallest statement that should follow it,
// written by hand: an example of the template, not evidence about an emitter.
describe('every template has a statement that follows it, and only it', () => {
  const C = 'https://example.org/courses/made-up';
  const registration = '33333333-3333-4333-8333-333333333333';
  const st = (verb: string, type: string | undefined, more: Json = {}): Json => ({ actor: learner, verb: { id: verb },
    object: { id: `${C}/thing`, ...(type ? { definition: { type } } : {}) }, ...more });
  const ext = (name: string, value: unknown) => ({ extensions: { [`${FOXXI_NS}${name}`]: value } });
  const parent = (type: string) => ({ contextActivities: { parent: [{ id: C, definition: { type } }] } });
  const lesson = `${ADL}/activities/lesson`, course = `${ADL}/activities/course`, W3 = 'https://w3id.org/xapi/adl/verbs';
  const examples: Record<string, Json> = {
    launched: st(`${ADL}/verbs/launched`, course, { context: { registration, contextActivities: { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] } } }),
    initialized: st(`${ADL}/verbs/initialized`, lesson),
    terminated: st(`${ADL}/verbs/terminated`, lesson),
    satisfied: st(`${W3}/satisfied`, course),
    abandoned: st(`${W3}/abandoned`, lesson),
    waived: st(`${W3}/waived`, lesson),
    'slide-viewed': st(`${ADL}/verbs/experienced`, lesson, { context: { ...parent(course), ...ext('slideId', 'slide-3') } }),
    'scene-completed': st(`${FOXXI_NS}verbs/scene-completed`, `${FOXXI_NS}activities/scene`),
    interacted: st(`${ADL}/verbs/interacted`, `${ADL}/activities/interaction`),
    passed: st(`${ADL}/verbs/passed`, course, { result: { success: true, score: { scaled: 0.9 } } }),
    'lesson-passed': st(`${ADL}/verbs/passed`, lesson, { result: { success: true, score: { scaled: 0.9 } } }),
    asked: st(`${FOXXI_NS}verbs/asked`, `${FOXXI_NS}activities/concept-graph-node`),
    retrieved: st(`${FOXXI_NS}verbs/retrieved`, `${FOXXI_NS}activities/concept-graph-node`),
    enrolled: st(`${FOXXI_NS}verbs/enrolled`, course),
    credentialed: st(`${FOXXI_NS}verbs/credentialed`, `${FOXXI_NS}activities/credential`),
    'wallet-exported': st(`${FOXXI_NS}verbs/wallet-exported`, `${FOXXI_NS}activities/credential`),
    'framework-aligned': st(`${FOXXI_NS}verbs/framework-aligned`, `${FOXXI_NS}activities/framework`),
    'affordance-invoked': st(`${FOXXI_NS}verbs/affordance-invoked`, `${FOXXI_NS}activities/affordance`, { context: ext('affordanceTool', 'foxxi.made_up_tool') }),
    'policy-decided': st(`${FOXXI_NS}verbs/policy-decided`, undefined, { context: ext('policyId', 'https://pod.example/policies/made-up') }),
    authored: st(`${FOXXI_NS}verbs/authored`, course),
    asserted: st(`${FOXXI_NS}verbs/asserted`, undefined, { context: ext('substrateDescriptorIri', 'https://pod.example/fictional-agent/context-graphs/1.ttl') }),
    'fragment-experienced': st(`${ADL}/verbs/experienced`, `${FOXXI_NS}activities/fragment`, { context: { registration, ...parent(`${FOXXI_NS}activities/composition`),
      extensions: { [`${FOXXI_NS}competency`]: 'https://example.org/competencies/made-up', [`${FOXXI_NS}compositionPosition`]: 0, [`${FOXXI_NS}alternativesOffered`]: ['urn:made-up:fragment'] } } }),
    'question-answered': { ...st(`${ADL}/verbs/answered`, undefined, { result: { response: 'true' }, context: { registration, ...parent(`${FOXXI_NS}activities/fragment`) } }),
      object: { id: `${C}/question`, definition: { type: `${ADL}/activities/cmi.interaction`, interactionType: 'true-false' } } },
    'composition-completed': st(`${ADL}/verbs/completed`, `${FOXXI_NS}activities/composition`, { result: { completion: true }, context: { registration } }),
    completed: st(`${ADL}/verbs/completed`, course, { result: { completion: true } }),
    'course-failed': st(`${ADL}/verbs/failed`, course, { result: { success: false } }),
    'experienced-activity': st(`${ADL}/verbs/experienced`, course),
    'experienced-performance': st(`${ADL}/verbs/experienced`, `${ADL}/activities/performance`),
  };

  it.each(Object.keys(examples))('%s', name => {
    expect(check(examples[name]), name).toMatchObject({ outcome: 'success', templates: [T(name)], findings: [] });
  });

  it('leaves no template of the profile without one', () => {
    // Runs after every other test in the file, so it reads what they all followed.
    expect(doc.templates.map(t => String(t['id'])).filter(id => !followed.has(id))).toEqual([]);
  });

  it('follows each primary pattern, and a failed course session is a course session', () => {
    const P = (name: string) => `${doc.id}/patterns/${name}`;
    const e = (...names: string[]) => names.map(n => examples[n]!);
    const session = (outcome: string) => e('launched', 'initialized', 'slide-viewed', 'asked', 'retrieved', 'scene-completed', 'slide-viewed', outcome, 'terminated');
    for (const outcome of ['completed', 'passed', 'course-failed'])
      expect(follows(session(outcome), doc.templates, doc.patterns), outcome).toEqual({ follows: true, pattern: P('course-session'), reasons: [] });
    // A question with no retrieval after it, and a session with no outcome, are not one.
    expect(follows(e('launched', 'initialized', 'asked', 'completed', 'terminated'), doc.templates, doc.patterns).follows).toBe(false);
    expect(follows(e('launched', 'initialized', 'slide-viewed', 'terminated'), doc.templates, doc.patterns).follows).toBe(false);
    expect(follows(e('question-answered', 'fragment-experienced', 'fragment-experienced', 'question-answered', 'question-answered', 'fragment-experienced', 'composition-completed'), doc.templates, doc.patterns))
      .toEqual({ follows: true, pattern: P('composition-attempt'), reasons: [] });
    expect(follows(e('passed', 'credentialed'), doc.templates, doc.patterns)).toEqual({ follows: true, pattern: P('credentialing'), reasons: [] });
    const first = projected({ verb: `${FOXXI_NS}performed` });
    const acts = [first, projected({ modalStatus: 'Hypothetical' }), projected({ modalStatus: 'Counterfactual' })];
    expect(follows(acts as Json[], doc.templates, doc.patterns)).toEqual({ follows: true, pattern: P('agent-performance-stream'), reasons: [] });
    // A revision is also a stream of acts, and `follows` names the first primary pattern that fits,
    // so the revision arc is matched directly: the first act, then what supersedes it, nothing left over.
    const revision = [first, projected({ verb: `${FOXXI_NS}performed`, supersedes: ['https://pod.example/fictional-agent/context-graphs/1780000000000.ttl'] })] as Json[];
    const judged = revision.map(statement => ({ statement, templates: validates(statement, doc.templates).templates }));
    const [outcome, left] = matches(judged, P('revision-arc'), elementsOf(doc.templates, doc.patterns));
    expect([outcome, left.length]).toEqual(['success', 0]);
    expect(matches(judged.slice(0, 1), P('revision-arc'), elementsOf(doc.templates, doc.patterns))[0]).not.toBe('success');
    expect(doc.patterns.filter(p => p['primary'] === true).map(p => String(p['id'])).sort())
      .toEqual(['agent-performance-stream', 'composition-attempt', 'course-session', 'credentialing', 'revision-arc'].map(P).sort());
  });

  it('defines every term a statement carries and every part of the profile', () => {
    const declared = new Set(doc.concepts.map(c => String(c['id'])));
    const run = ingestExternalRun({ agentDid: 'did:web:example.org:agents:fictional', task: { name: 'Sort the made-up invoices' }, evaluationId: 'made-up-eval', candidateId: 'made-up-candidate',
      toolCalls: [{ tool: 'made_up_tool', success: true }], outcome: { success: true, quality: 0.9, costUsd: 0.01 } });
    const carried = new Set<string>();
    for (const s of [...checked, ...(run.statements as unknown as Json[])]) {
      for (const key of Object.keys(((s['context'] as Json | undefined)?.['extensions'] as Json | undefined) ?? {})) if (key.startsWith(FOXXI_NS)) carried.add(key);
      const verb = (s['verb'] as { id: string }).id; if (verb.startsWith(FOXXI_NS)) carried.add(verb);
    }
    expect(carried.size).toBeGreaterThan(20);
    expect([...carried].filter(id => !declared.has(id))).toEqual([]);
    for (const part of [...doc.concepts, ...doc.templates, ...doc.patterns]) {
      expect((part['prefLabel'] as { en?: string } | undefined)?.en, String(part['id'])).toBeTruthy();
      expect((part['definition'] as { en?: string } | undefined)?.en, String(part['id'])).toBeTruthy();
    }
  });
});
