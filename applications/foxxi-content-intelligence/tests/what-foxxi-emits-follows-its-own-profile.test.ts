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
import { validates, type Json } from '../src/xapi-profile-server/processor.js';
import { projectMeshEntry } from '../src/mesh-event-projector.js';
import { ingestExternalRun } from '../src/agent-run-ingest.js';
import { buildPerformanceStatement, momOutcomeVerb, recordedActivityType } from '../src/performance-statement.js';

const doc = buildFoxxiProfileDoc({ generatedAt: '2026-07-22T00:00:00.000Z' }) as { id: string; templates: Json[] };
const T = (name: string) => `${doc.id}/templates/${name}`;
const check = (statement: unknown) => validates(statement as Json, doc.templates);
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
    // One rule is left to say no: a failed lesson states its score, whoever records it.
    const scoreless = check(recorded(lesson, false));
    expect(scoreless.outcome).toBe('invalid');
    expect(scoreless.templates).toEqual([T('lesson-failed')]);
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
