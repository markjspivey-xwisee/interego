/**
 * The examples the deployment keeps with its built-in profiles: for each statement template one
 * statement that follows it, and for each primary pattern one run that is a complete pass.
 *
 * A profile published from a draft is refused unless the lint finds an example for every template
 * and every primary pattern, and its examples are then served with it. A built-in profile is never
 * published, so it had none to serve. These are held to the same lint
 * (tests/the-built-in-profiles-are-kept-with-their-examples.test.ts) and served at the same address.
 *
 * Where an emitter builds the statement, the example is what the emitter builds, not a copy:
 * `projectMeshEntry` for a descriptor projection, `ingestExternalRun` for an ingested run, and the
 * lrs-adapter's `buildProjectionStatement` for the xapi-x profile. The rest are written by hand,
 * for the statements no single function emits.
 *
 * Every actor, address and identifier is made up.
 *
 * This file is in src/ and not beside the profile server because it imports the lrs-adapter's
 * builder: the bridge image's own check (tests/a-bridge-image-carries-what-it-imports.test.ts)
 * reads an import of another vertical as two directories up.
 */
import { FOXXI_NS, FOXXI_PROFILE_ID } from './xapi-profile.js';
import { projectMeshEntry, type MeshDiscoverEntry } from './mesh-event-projector.js';
import { ingestExternalRun } from './agent-run-ingest.js';
import { XAPIX_PROJECTION_TEMPLATE_ID } from './xapix/profile.js';
import { buildProjectionStatement } from '../../lrs-adapter/src/projection-statement.js';
import type { ExampleSequence, ExampleStatement, ProfileExamples } from './xapi-profile-server/lint.js';
import type { Json } from './xapi-profile-server/processor.js';

const ADL = 'http://adlnet.gov/expapi', W3 = 'https://w3id.org/xapi/adl/verbs';
const json = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

/** Foxxi's own profile: an example for each of its templates and each of its primary patterns. */
export function foxxiProfileExamples(): ProfileExamples {
  const T = (name: string) => `${FOXXI_PROFILE_ID}/templates/${name}`;
  const C = 'https://example.org/courses/made-up';
  const learner = { mbox: 'mailto:fictional-learner@example.org' };
  const registration = '33333333-3333-4333-8333-333333333333';
  const st = (v: string, type: string | undefined, more: object = {}) => ({ actor: learner, verb: { id: v }, object: { id: `${C}/thing`, ...(type ? { definition: { type } } : {}) }, ...more });
  const ext = (name: string, value: unknown) => ({ extensions: { [`${FOXXI_NS}${name}`]: value } });
  const parent = (type: string) => ({ contextActivities: { parent: [{ id: C, definition: { type } }] } });
  const lesson = `${ADL}/activities/lesson`, course = `${ADL}/activities/course`;
  const projected = (entry: Partial<MeshDiscoverEntry>) => projectMeshEntry({
    descriptorUrl: 'https://pod.example/fictional-agent/context-graphs/1790000000000.ttl', describes: ['urn:graph:made-up-1790000000000'],
    conformsTo: ['https://example.org/types/RefundDecision'], modalStatus: 'Asserted', ...entry }, 'https://pod.example/fictional-agent/')!.statement;
  // An ingested run names its task and its time from the clock; the example is given both.
  const run = { ...ingestExternalRun({ agentDid: 'did:web:example.org:agents:fictional', task: { id: 'urn:made-up:task:sort-the-invoices', name: 'Sort the made-up invoices' },
    toolCalls: [{ tool: 'made_up_tool', success: true }], outcome: { success: true, quality: 0.9 } }).statements[0], timestamp: '2026-11-15T12:00:00.000Z' };

  // One template each.
  const alone: Record<string, unknown> = {
    launched: st(`${ADL}/verbs/launched`, course, { context: { registration, contextActivities: { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] } } }),
    initialized: st(`${ADL}/verbs/initialized`, lesson),
    terminated: st(`${ADL}/verbs/terminated`, lesson),
    satisfied: st(`${W3}/satisfied`, course), abandoned: st(`${W3}/abandoned`, lesson), waived: st(`${W3}/waived`, lesson),
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
    'lesson-completed': st(`${ADL}/verbs/completed`, lesson, { result: { completion: true } }),
    'lesson-failed': st(`${ADL}/verbs/failed`, lesson, { result: { success: false, score: { scaled: 0.2 } } }),
    'experienced-activity': st(`${ADL}/verbs/experienced`, course),
    'experienced-performance': st(`${ADL}/verbs/experienced`, `${ADL}/activities/performance`),
    // And what the emitters build.
    'performed-descriptor': projected({ verb: `${FOXXI_NS}performed` }),
    'intended-descriptor': projected({ modalStatus: 'Hypothetical' }),
    'considered-descriptor': projected({ modalStatus: 'Counterfactual' }),
    'production-performance-completed': projected({ success: true }),
    'production-performance-failed': projected({ success: false }),
    'performed-production': run,
    'voided-statement': { actor: learner, verb: { id: `${ADL}/verbs/voided` }, object: { objectType: 'StatementRef', id: '11111111-1111-4111-8111-111111111111' } },
  };
  const example = (id: string, follows: string[], statement: unknown): ExampleStatement => ({ id, follows, statement: json(statement) });
  const statements: ExampleStatement[] = [
    ...Object.entries(alone).map(([name, statement]) => example(name, [T(name)], statement)),
    // A descriptor that revises another is a descriptor too, and a retracted one is a voiding too:
    // these two templates add a determining property to another's, so their examples claim both.
    example('superseding-descriptor', [T('performed-descriptor'), T('superseding-descriptor')],
      projected({ verb: `${FOXXI_NS}performed`, supersedes: ['https://pod.example/fictional-agent/context-graphs/1780000000000.ttl'] })),
    example('voided-descriptor', [T('voided-descriptor'), T('voided-statement')], projected({ modalStatus: 'Retracted' })),
  ];
  const sequence = (pattern: string, ...members: string[]): ExampleSequence => ({ id: pattern, pattern: `${FOXXI_PROFILE_ID}/patterns/${pattern}`, statements: members });
  const sequences = [
    sequence('course-session', 'launched', 'initialized', 'slide-viewed', 'asked', 'retrieved', 'scene-completed', 'slide-viewed', 'passed', 'terminated'),
    sequence('composition-attempt', 'question-answered', 'fragment-experienced', 'fragment-experienced', 'composition-completed'),
    sequence('credentialing', 'passed', 'credentialed'),
    sequence('agent-performance-stream', 'performed-descriptor', 'intended-descriptor', 'considered-descriptor'),
    sequence('revision-arc', 'performed-descriptor', 'superseding-descriptor'),
  ];
  return { statements, sequences };
}

/** The xapi-x profile: the statement the lrs-adapter posts for a descriptor it projects. */
export function xapixProfileExamples(): ProfileExamples {
  const statement = buildProjectionStatement({
    descriptorIri: 'https://pod.example/fictional-learner/context-graphs/1790000000000.ttl',
    actor: { account: { homePage: 'https://example.org', name: 'fictional-learner' } },
    verbId: 'https://example.org/verbs/made-up-verb',
    objectId: 'https://example.org/activities/made-up-activity',
    coherentNarratives: ['A made-up first reading.', 'A made-up second reading.'],
  }, '6f1d2c9a-3b4e-4f5a-8b6c-7d8e9f0a1b2c', '2026-11-15T12:00:00.000Z');
  return { statements: [{ id: 'a-projection', follows: [XAPIX_PROJECTION_TEMPLATE_ID], statement: json(statement) }], sequences: [] };
}
