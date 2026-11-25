/**
 * An agent that learns for itself, and what an agent's course record says of it.
 *
 * ★ WHY. Two things were written down as designed and not built when agents were first made
 * learners (AGENT-COLLABORATION.md section 6, 2026-11-25):
 * - **an agent with no person.** `learner_kind: "agent"` was refused from a wallet signing for
 *   itself, so an agent that works for nobody was recorded as a person, and nothing could be
 *   assigned to it as what it is;
 * - **a course as a trajectory.** The agent-performance tools read trajectories an agent records of
 *   its own work. An agent that had only taken courses had none, so the team a person's delegates
 *   form had nothing to be consulted on.
 *
 * The rules for both are pure and pinned here (src/learning-beside.ts, src/course-trajectory.ts).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { companionsOn, kindOfLaunch, learnerFor, pairStandings, peersOn, type BesideLaunch } from '../src/learning-beside.js';
import { buildCmi5Launch, inspectRegistration, launchesOfPair } from '../src/cmi5-lms.js';
import { courseRecordRead, courseTrajectory, plainSteps } from '../src/course-trajectory.js';
import { assessDisposition } from '../../agentic-performance-practice/src/agent-disposition.js';
import type { TenantId } from '../src/tenant-context.js';

const LONE = 'did:ethr:0xa11ce';
const ANA = 'https://identity.example/users/ana#me';
const ANA_AGENT = 'did:web:identity.example:agents:claude-ana';
const HOME = 'https://lms.example';

const row = (registration: string, learner: string, o: Partial<BesideLaunch> = {}): BesideLaunch =>
  ({ registration, auId: 'au-1', courseId: 'course-1', learner: { id: learner }, satisfied: false, ...o });

describe('an agent with no person', () => {
  it('is a wallet that says it is an agent: itself, beside nobody', () => {
    const l = learnerFor({ callerDid: LONE, direct: true, delegation: null, kind: 'agent' });
    expect(l).toEqual({ ok: true, did: LONE, kind: 'agent' });
    expect(l).not.toHaveProperty('beside');
    // Saying nothing still makes a wallet a person.
    expect(learnerFor({ callerDid: LONE, direct: true, delegation: null })).toMatchObject({ kind: 'human' });
  });

  it('does not let a delegate drop its person by saying it', () => {
    // A delegate is beside the person its delegation names, or refused: never quietly alone.
    expect(learnerFor({ callerDid: ANA_AGENT, direct: false, delegation: null, kind: 'agent' })).toMatchObject({ ok: false, status: 401 });
    expect(learnerFor({ callerDid: ANA_AGENT, direct: false, delegation: 'unreadable', kind: 'agent' })).toMatchObject({ ok: false, status: 503 });
    expect(learnerFor({ callerDid: ANA_AGENT, direct: false, delegation: { person: ANA }, kind: 'agent' })).toMatchObject({ kind: 'agent', beside: ANA });
  });

  it('is an agent by what its launch says, since no person says it', () => {
    expect(kindOfLaunch({})).toBe('human');
    expect(kindOfLaunch({ learnerKind: 'agent' })).toBe('agent');
    expect(kindOfLaunch({ beside: { id: ANA } })).toBe('agent');
    expect(companionsOn([{ ...row('r1', LONE, { learnerKind: 'agent' }) }], LONE)).toMatchObject([{ learner: LONE, kind: 'agent' }]);
    const both = [row('r1', LONE, { learnerKind: 'agent', visibleToPeers: true }), row('r2', ANA, { visibleToPeers: true })];
    expect(peersOn(both, ANA)).toMatchObject([{ learner: LONE, kind: 'agent' }]);
    expect(peersOn(both, ANA)[0]).not.toHaveProperty('beside');
  });

  it('is launched with no team, and its registration says it is an agent', () => {
    const tenant = 'tenant-lone-agent' as TenantId;
    const launch = buildCmi5Launch({
      au: { id: 'https://lms.example/au/1', url: 'https://content.example/au/index.html', moveOn: 'Completed', title: 'Unit 1' },
      learner: { id: LONE }, lrsEndpoint: `${HOME}/xapi`, fetchBaseUrl: `${HOME}/cmi5/fetch`, authoritativeSource: HOME,
      tenant, courseId: 'course-lone', learnerKind: 'agent',
    });
    expect(JSON.stringify(launch.launched ?? {})).not.toContain('"team"');
    expect(inspectRegistration(launch.registration)).toMatchObject({ learner: LONE, learnerKind: 'agent' });
    expect(inspectRegistration(launch.registration)).not.toHaveProperty('beside');
    expect(launchesOfPair(tenant, LONE).map(l => l.registration)).toEqual([launch.registration]);
  });

  it('is assigned what is assigned to it, through nobody, and is listed as an agent', () => {
    const [c] = pairStandings({
      person: LONE, alone: true, reader: { kind: 'agent', id: LONE },
      assignments: [{ courseId: 'course-1', courseTitle: 'Confined space entry' }],
      launches: [row('r1', LONE, { learnerKind: 'agent', satisfied: true })],
    });
    expect(c).toMatchObject({ courseId: 'course-1', assigned: true, agents: [{ learner: LONE, satisfied: true, launched: true }] });
    expect(c).not.toHaveProperty('person');
    expect(c).not.toHaveProperty('assignedThrough');
  });

  it('is told apart from a delegate, whose assignment still comes through its person', () => {
    const [c] = pairStandings({ person: ANA, agents: [ANA_AGENT], reader: { kind: 'agent', id: ANA_AGENT }, assignments: [{ courseId: 'course-1' }], launches: [] });
    expect(c).toMatchObject({ assignedThrough: ANA, person: { learner: ANA }, agents: [{ learner: ANA_AGENT }] });
  });
});

const V = 'http://adlnet.gov/expapi/verbs/';
let n = 0;
const st = (actor: string, verb: string, object: string, at: string, result?: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  actor: { objectType: 'Agent', account: { homePage: HOME, name: actor } },
  verb: { id: verb.includes(':') ? verb : V + verb },
  object: { id: object, definition: { name: { 'en-US': `name of ${object}` } } },
  ...(result ? { result } : {}), timestamp: at,
});

describe('an agent\'s course record, read as a trajectory', () => {
  const Q1 = 'https://lms.example/au/1/q1', AU = 'https://lms.example/au/1';
  const record = [{
    registration: 'reg-1', auId: AU, auTitle: 'Unit 1',
    statements: [
      st(ANA_AGENT, 'launched', AU, '2026-11-25T10:00:00Z'),
      st(ANA_AGENT, 'initialized', AU, '2026-11-25T10:00:01Z'),
      st(ANA_AGENT, 'answered', Q1, '2026-11-25T10:00:05Z', { success: false }),
      st(ANA_AGENT, 'answered', Q1, '2026-11-25T10:00:09Z', { success: true }),
      st(ANA_AGENT, 'passed', AU, '2026-11-25T10:00:12Z', { success: true, score: { scaled: 0.9 } }),
      st(ANA_AGENT, 'https://w3id.org/xapi/adl/verbs/satisfied', AU, '2026-11-25T10:00:13Z'),
      st(ANA, 'answered', Q1, '2026-11-25T10:00:06Z', { success: true }),
      { not: 'a statement' },
    ],
  }];

  it('is a task for the registration and a step for each thing the agent itself did', () => {
    const t = courseTrajectory(ANA_AGENT, record);
    expect(t.agentDid).toBe(ANA_AGENT);
    expect(t.steps.map(s => `${s.granularity}:${s.verb}`)).toEqual(['task:took', 'subtask:initialized', 'subtask:answered', 'subtask:answered', 'subtask:passed']);
    expect(t.steps.every(s => s.modalStatus === 'Asserted')).toBe(true);
    const [task, , wrong, right] = t.steps;
    expect(task).toMatchObject({ objectId: AU, objectName: 'Unit 1', result: { success: true, quality: 0.9 } });
    expect(wrong!.parentId).toBe(task!.id);
    // The second answer redoes the one that was wrong: the one revision a course record shows.
    expect(right!.supersedesId).toBe(wrong!.id);
    expect(wrong!.supersedesId).toBeUndefined();
  });

  it('leaves out what the LMS said and what anyone else did', () => {
    const verbs = courseTrajectory(ANA_AGENT, record).steps.map(s => s.verb);
    expect(verbs).not.toContain('launched');
    expect(verbs).not.toContain('satisfied');
    // The person's own answer in the same registration is not the agent's step.
    expect(verbs.filter(v => v === 'answered')).toHaveLength(2);
    expect(courseTrajectory(ANA, record).steps.map(s => s.verb)).toEqual(['took', 'answered']);
  });

  it('makes the same steps of the same record, and no task of a registration nothing was done on', () => {
    expect(courseTrajectory(ANA_AGENT, record).steps.map(s => s.id)).toEqual(courseTrajectory(ANA_AGENT, [...record].reverse()).steps.map(s => s.id));
    const launchedOnly = [{ registration: 'reg-2', auId: AU, statements: [st(ANA_AGENT, 'launched', AU, '2026-11-25T11:00:00Z')] }];
    expect(courseTrajectory(ANA_AGENT, launchedOnly).steps).toEqual([]);
  });

  it('does not call a pass after a pass a retry, and does call a pass after a fail one', () => {
    const t = courseTrajectory(ANA_AGENT, [{ registration: 'reg-3', auId: AU, statements: [
      st(ANA_AGENT, 'failed', AU, '2026-11-25T12:00:00Z', { success: false, score: { scaled: 0.4 } }),
      st(ANA_AGENT, 'passed', AU, '2026-11-25T12:05:00Z', { success: true, score: { scaled: 0.8 } }),
      st(ANA_AGENT, 'passed', AU, '2026-11-25T12:06:00Z', { success: true, score: { scaled: 0.8 } }),
    ] }]);
    const [task, failed, passed, again] = t.steps;
    expect(passed!.supersedesId).toBe(failed!.id);
    expect(again!.supersedesId).toBeUndefined();
    // The task's outcome is the last one reported.
    expect(task!.result).toEqual({ success: true, quality: 0.8 });
  });

  it('reads what the record supports and names what it cannot say', () => {
    const read = courseRecordRead(courseTrajectory(ANA_AGENT, record));
    expect(read).toMatchObject({ agent: ANA_AGENT, taken: 1, passed: 1, failed: 0, answered: { total: 2, correct: 1 }, retries: 1 });
    expect(read.notReadable.map(x => x.signal)).toEqual(['deliberation', 'exploration']);
    // Nothing was taken: zeros, not a verdict.
    expect(courseRecordRead(courseTrajectory(ANA_AGENT, []))).toMatchObject({ taken: 0, passed: 0, failed: 0, answered: { total: 0, correct: 0 }, retries: 0 });
  });

  it('is why the read is not the disposition read: that one would call the source a trait', () => {
    // Every step of a course record is Asserted. The disposition read derives deliberation and
    // exploration from the share of Hypothetical and Counterfactual steps, so over a course record
    // alone both are zero whatever the agent is like. This pins the reason courseRecordRead exists.
    const d = assessDisposition([courseTrajectory(ANA_AGENT, record)]);
    const one = JSON.stringify(d);
    expect(one).toMatch(/"deliberationRatio":0[,}]/);
    expect(one).toMatch(/"explorationRatio":0[,}]/);
  });

  it('hands the steps on plainly, for composing with work the agent did record', () => {
    const steps = plainSteps(courseTrajectory(ANA_AGENT, record));
    expect(steps).toHaveLength(5);
    expect(Object.keys(steps[0]!).sort()).toEqual(['granularity', 'id', 'modalStatus', 'objectId', 'objectName', 'recordedAt', 'result', 'verb']);
  });
});

describe('the bridge', () => {
  const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  it('reads the course experience on the pair read and stores none of it', () => {
    expect(server).toContain('courseExperience.push({ ...courseRecordRead(t)');
    // The trajectory store is the tenant directory's and lives in memory; the projection never enters it.
    expect(server).not.toMatch(/agentTrajectoriesByTenant[^\n]*courseTrajectory|courseTrajectory[^\n]*agentTrajectoriesByTenant/);
  });
  it('marks a lone agent\'s launch, and only a lone agent\'s', () => {
    expect(server).toContain("...(learner.kind === 'agent' && !learner.beside ? { learnerKind: 'agent' as const } : {})");
  });
});
