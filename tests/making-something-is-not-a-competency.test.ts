/**
 * What an IEEE P2997 learner record may infer a competency from.
 *
 * Found live on 2026-09-26: a person who authored a SCORM course and read their own record got
 * "Inferred: course" beside the competencies from courses they passed. The bridge stamps an
 * authored statement (and a credential issuer's `credentialed` one) as production work, and the
 * work leg keyed a competency on its object type, which names the thing made, not a skill. The
 * issuer's statement asserts success, so it came out Asserted: "Demonstrated: credential".
 *
 * Making something stays in the work leg, since it is what the subject did, and keys no
 * competency. A `completed` still feeds a Hypothetical inference, except for an activity the record
 * shows failed and never passed: the SCORM engine writes `completed` beside `failed` for an attempt
 * that did not pass, the reason the credential gate leaves `completed` out altogether.
 */
import { describe, it, expect } from 'vitest';
import { assembleEnterpriseLearnerRecord, AUTHORED_VERB, CREDENTIALED_VERB } from '../applications/foxxi-content-intelligence/src/learner-record.js';
import type { StoredStatement } from '../applications/foxxi-content-intelligence/src/statement-store.js';

const LRS = 'https://foxxi-bridge.interego.xwisee.com';
const FOXXI = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#';
const ADL = 'http://adlnet.gov/expapi/verbs/';
const COURSE_TYPE = 'http://adlnet.gov/expapi/activities/course';
const ME = 'did:web:identity.interego.xwisee.com:users:u-pk-000000000001';

let n = 0;
function stmt(verb: string, objectId: string, opts: { name?: string; type?: string; result?: Record<string, unknown>; contextKind?: string; at?: string } = {}): StoredStatement {
  const id = `s-${++n}`;
  const at = opts.at ?? `2026-09-26T00:00:${String(n).padStart(2, '0')}Z`;
  return {
    id, stored: at, voided: false,
    statement: {
      id,
      actor: { objectType: 'Agent', account: { homePage: LRS, name: ME } },
      verb: { id: verb },
      object: { objectType: 'Activity', id: objectId, definition: { ...(opts.name ? { name: { en: opts.name } } : {}), ...(opts.type ? { type: opts.type } : {}) } },
      ...(opts.result ? { result: opts.result } : {}),
      context: { extensions: { [`${FOXXI}contextKind`]: opts.contextKind ?? 'training' } },
      timestamp: at,
    },
  } as unknown as StoredStatement;
}

/** What `/agent/scorm/author` records: the authored verb, the ADL course type, production context. */
const authored = (courseId: string, title: string): StoredStatement =>
  stmt(AUTHORED_VERB, `${LRS}/agent/scorm/course/${courseId}`, { name: title, type: COURSE_TYPE, result: { completion: true }, contextKind: 'production' });

const assemble = (statements: readonly StoredStatement[]) => assembleEnterpriseLearnerRecord({
  learnerDid: ME,
  learnerPodUrl: 'https://gate.example/u-pk-000000000001/',
  tenantDid: 'did:web:x:tenant',
  lrsEndpoint: LRS,
  statements,
  fetch: (async () => { throw new Error('no network in this test'); }) as unknown as typeof globalThis.fetch,
});
const labels = (elr: Awaited<ReturnType<typeof assemble>>): string[] => elr.competencies.map((c) => c.label).sort();

describe('making something is work, not a competency', () => {
  it('a course the learner authored is in their work, and names no competency', async () => {
    const elr = await assemble([
      authored('LIVE-A', 'Reading a learner record'),
      authored('LIVE-B', 'Checking a badge'),
      stmt(`${ADL}completed`, `${LRS}/course/taken`, { name: 'Verify the record behind every badge', type: COURSE_TYPE, result: { completion: true } }),
      stmt(`${ADL}passed`, `${LRS}/course/taken`, { name: 'Verify the record behind every badge', type: COURSE_TYPE, result: { success: true, completion: true, score: { scaled: 1 } } }),
    ]);
    expect(labels(elr)).toEqual(['Inferred: Verify the record behind every badge']);
    expect(elr.performanceRecords.map((p) => p.taskName).sort()).toEqual(['Checking a badge', 'Reading a learner record']);
    expect(elr.summary).toMatchObject({ performanceCount: 2, competencyCount: 1, performanceVerifiedCompetencies: 0 });
  });

  it('a credential the learner issued is in their work, and asserts no competency', async () => {
    const elr = await assemble([
      stmt(CREDENTIALED_VERB, 'urn:uuid:credential-1', { name: 'Refund authority → did:ethr:0x1', type: `${FOXXI}activities/credential`, result: { completion: true, success: true }, contextKind: 'production' }),
    ]);
    expect(elr.competencies).toEqual([]);
    expect(elr.performanceRecords).toHaveLength(1);
    expect(elr.summary.assertedCompetencies).toBe(0);
  });

  it('an authored statement filed as an experience infers nothing either', async () => {
    const elr = await assemble([stmt(AUTHORED_VERB, `${LRS}/agent/scorm/course/LIVE-C`, { name: 'Anything', type: COURSE_TYPE, result: { completion: true } })]);
    expect(elr.experiences).toHaveLength(1);
    expect(elr.competencies).toEqual([]);
  });

  it('teaching recorded as a skill still demonstrates one', async () => {
    const TEACHING = `${LRS}/ns/foxxi/competency/instructional-design`;
    const elr = await assemble([
      authored('LIVE-D', 'A course'),
      stmt(`${ADL}completed`, `${LRS}/agent/scorm/course/LIVE-D`, { name: 'Taught “A course” to an AI agent', type: TEACHING, result: { success: true, score: { scaled: 1 } }, contextKind: 'production' }),
    ]);
    expect(labels(elr)).toEqual(['Demonstrated: instructional-design']);
  });
});

describe('a completion predicts a competency, unless the record shows it failed', () => {
  it('a lesson with nothing to pass, completed, is a Hypothetical inference', async () => {
    const elr = await assemble([stmt(`${ADL}completed`, `${LRS}/lesson/reading`, { name: 'Reading only', result: { completion: true } })]);
    expect(elr.competencies).toEqual([expect.objectContaining({ label: 'Inferred: Reading only', basis: 'inferred', modalStatus: 'Hypothetical' })]);
  });

  it('a failed attempt\'s completion infers nothing, and a later pass restores it', async () => {
    const course = `${LRS}/course/hard`;
    const attempt = [
      stmt(`${ADL}completed`, course, { name: 'A hard course', result: { completion: true } }),
      stmt(`${ADL}failed`, course, { name: 'A hard course', result: { success: false, completion: true, score: { scaled: 0.3 } } }),
    ];
    expect((await assemble(attempt)).competencies).toEqual([]);
    const passedLater = await assemble([
      ...attempt,
      stmt(`${ADL}completed`, course, { name: 'A hard course', result: { completion: true } }),
      stmt(`${ADL}passed`, course, { name: 'A hard course', result: { success: true, completion: true, score: { scaled: 0.9 } } }),
    ]);
    expect(passedLater.competencies).toEqual([expect.objectContaining({ label: 'Inferred: A hard course', evidenceSummary: expect.objectContaining({ trainingCompletions: 3 }) })]);
  });
});
