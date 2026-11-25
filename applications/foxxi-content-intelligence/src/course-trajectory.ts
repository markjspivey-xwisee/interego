/**
 * An agent's course record, read as a trajectory.
 *
 * ★ WHY. The agent-performance tools read trajectories (agentic-performance-practice,
 * `AgentTrajectory`), which an agent records of its own work. An agent that learns beside its
 * person (src/learning-beside.ts) has a different record: the xAPI statements of its cmi5
 * registrations. Until 2026-11-25 nothing joined the two, so a person's delegates were named as a
 * team to consult and the consult had nothing to read for an agent that had only taken courses.
 *
 * This projects the one into the other, on read. Nothing is stored: the statements are the record
 * and stay it, and the trajectory is rebuilt from them each time, so it adds nothing to the
 * process's memory that a restart could lose (docs/operations/primary-state-rollout-hold.md lists
 * recorded trajectories among the stores that live only there).
 *
 * ★ WHAT A COURSE RECORD CAN AND CANNOT SAY. Every step here is `Asserted`: a statement says a
 * thing happened. A course record holds no intentions and no rejected alternatives, so it cannot
 * show how much an agent plans before it acts or how widely it explores. The disposition read
 * (`assessDisposition`) derives exactly those from the share of `Hypothetical` and
 * `Counterfactual` steps, and run over a course record alone it would call any agent
 * "execution-biased" and "exploitative": a fact about the source, reported as a trait of the
 * agent. So `courseRecordRead` reports only what the record supports (what was taken, what was
 * answered and how, what was retried, what was passed or failed) and names the two signals it
 * cannot give. The trajectory itself is returned for composing with work the agent did record
 * (`composeTrajectories`), where those signals come from that work.
 */
import { buildTrajectory, type AgentTrajectory, type TrajectoryStepInput } from '../../agentic-performance-practice/src/agent-trajectory.js';

/** One registration of an agent on a unit, with the statements kept for it. */
export interface CourseRegistrationRecord {
  registration: string;
  auId: string;
  auTitle?: string;
  statements: readonly unknown[];
}

/** Verbs the LMS says of a registration; they are not something the learner did. */
const LMS_VERBS = new Set([
  'http://adlnet.gov/expapi/verbs/launched',
  'https://w3id.org/xapi/adl/verbs/satisfied',
  'https://w3id.org/xapi/adl/verbs/abandoned',
  'https://w3id.org/xapi/adl/verbs/waived',
]);
const PASSED = 'http://adlnet.gov/expapi/verbs/passed';
const FAILED = 'http://adlnet.gov/expapi/verbs/failed';
const ANSWERED = 'http://adlnet.gov/expapi/verbs/answered';
/** Verbs a later statement can redo an earlier one of, on the same object. */
const RETRIABLE = new Set([ANSWERED, PASSED, FAILED]);

interface Read {
  id: string;
  verb: string;
  objectId: string;
  objectName: string;
  actor?: string;
  success?: boolean;
  scaled?: number;
  at: string;
}

function readStatement(s: unknown): Read | undefined {
  const st = s as { id?: unknown; timestamp?: unknown; stored?: unknown; actor?: { account?: { name?: unknown } }; verb?: { id?: unknown }; object?: { id?: unknown; definition?: { name?: Record<string, unknown> } }; result?: { success?: unknown; score?: { scaled?: unknown } } } | null;
  const verb = st?.verb?.id, objectId = st?.object?.id, id = st?.id;
  if (typeof verb !== 'string' || typeof objectId !== 'string' || typeof id !== 'string') return undefined;
  const names = st?.object?.definition?.name;
  const name = names && typeof names === 'object' ? Object.values(names).find((v): v is string => typeof v === 'string') : undefined;
  const at = typeof st?.timestamp === 'string' ? st.timestamp : typeof st?.stored === 'string' ? st.stored : '';
  const actor = st?.actor?.account?.name;
  const success = st?.result?.success, scaled = st?.result?.score?.scaled;
  return {
    id, verb, objectId, objectName: name ?? objectId, at,
    ...(typeof actor === 'string' ? { actor } : {}),
    ...(typeof success === 'boolean' ? { success } : {}),
    ...(typeof scaled === 'number' && Number.isFinite(scaled) ? { scaled } : {}),
  };
}

const stepId = (registration: string, statement?: string): string =>
  `urn:foxxi:course-trajectory:${registration}${statement ? `:${statement}` : ''}`;

/**
 * The trajectory of an agent's course record: a task for each registration, and under it a step
 * for each statement the agent itself made, in the order they were made.
 *
 * - Only statements whose actor is this agent are steps. What the LMS said of the registration
 *   (launched, satisfied, abandoned, waived) is not the agent's doing, and a statement by anyone
 *   else is not the agent's at all.
 * - A step that answers, passes or fails what an earlier step of the same registration failed
 *   supersedes that step: a retry, which is the one kind of revision a course record shows.
 * - Step ids are made from the registration and the statement id, so the same record always
 *   projects to the same steps.
 * - A registration with no statement of the agent's is not a task: nothing was done on it.
 */
export function courseTrajectory(agentDid: string, registrations: readonly CourseRegistrationRecord[]): AgentTrajectory {
  const steps: TrajectoryStepInput[] = [];
  for (const reg of registrations) {
    const own = reg.statements.map(readStatement)
      .filter((r): r is Read => !!r && r.actor === agentDid && !LMS_VERBS.has(r.verb))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    if (own.length === 0) continue;
    const taskId = stepId(reg.registration);
    const outcome = [...own].reverse().find(r => r.verb === PASSED || r.verb === FAILED);
    steps.push({
      id: taskId, modalStatus: 'Asserted', granularity: 'task', verb: 'took',
      objectId: reg.auId, objectName: reg.auTitle ?? reg.auId,
      ...(outcome ? { result: { success: outcome.verb === PASSED, ...(outcome.scaled !== undefined ? { quality: outcome.scaled } : {}) } } : {}),
      ...(own[0]!.at ? { recordedAt: own[0]!.at } : {}),
    });
    const lastFailed = new Map<string, string>();
    for (const r of own) {
      const id = stepId(reg.registration, r.id);
      const retried = RETRIABLE.has(r.verb) ? lastFailed.get(r.objectId) : undefined;
      steps.push({
        id, modalStatus: 'Asserted', granularity: 'subtask', verb: r.verb.slice(r.verb.lastIndexOf('/') + 1),
        objectId: r.objectId, objectName: r.objectName, parentId: taskId,
        ...(retried ? { supersedesId: retried } : {}),
        ...(r.success !== undefined || r.scaled !== undefined ? { result: { ...(r.success !== undefined ? { success: r.success } : {}), ...(r.scaled !== undefined ? { quality: r.scaled } : {}) } } : {}),
        ...(r.at ? { recordedAt: r.at } : {}),
      });
      if (RETRIABLE.has(r.verb)) {
        const failed = r.verb === FAILED || (r.verb !== PASSED && r.success === false);
        if (failed) lastFailed.set(r.objectId, id); else lastFailed.delete(r.objectId);
      }
    }
  }
  return buildTrajectory(agentDid, undefined, steps);
}

/** What a course record supports saying of an agent, and what it does not. */
export interface CourseRecordRead {
  agent: string;
  /** Registrations the agent did something on. */
  taken: number;
  passed: number;
  failed: number;
  answered: { total: number; correct: number };
  /** Steps that redid something an earlier step failed. */
  retries: number;
  /** Signals the disposition read derives that a course record cannot give, and why. */
  notReadable: { signal: 'deliberation' | 'exploration'; why: string }[];
}

/** The read of a trajectory made by `courseTrajectory`. */
export function courseRecordRead(t: AgentTrajectory): CourseRecordRead {
  const tasks = t.steps.filter(s => s.granularity === 'task');
  const answers = t.steps.filter(s => s.granularity === 'subtask' && s.verb === 'answered');
  return {
    agent: t.agentDid,
    taken: tasks.length,
    passed: tasks.filter(s => s.result?.success === true).length,
    failed: tasks.filter(s => s.result?.success === false).length,
    answered: { total: answers.length, correct: answers.filter(s => s.result?.success === true).length },
    retries: t.steps.filter(s => s.supersedesId).length,
    notReadable: [
      { signal: 'deliberation', why: 'a course record holds what was done, not what was intended first; record the agent\'s plans with foxxi.record_agent_trajectory to read it' },
      { signal: 'exploration', why: 'a course record holds no alternatives the agent considered and rejected; record them with foxxi.record_agent_trajectory to read it' },
    ],
  };
}

/** A step as it is handed on for composing: what it was, without the descriptor built around it. */
export function plainSteps(t: AgentTrajectory): Array<Pick<AgentTrajectory['steps'][number], 'id' | 'modalStatus' | 'granularity' | 'verb' | 'objectId' | 'objectName' | 'parentId' | 'supersedesId' | 'result' | 'recordedAt'>> {
  return t.steps.map(s => ({
    id: s.id, modalStatus: s.modalStatus, granularity: s.granularity, verb: s.verb, objectId: s.objectId, objectName: s.objectName,
    ...(s.parentId ? { parentId: s.parentId } : {}), ...(s.supersedesId ? { supersedesId: s.supersedesId } : {}),
    ...(s.result ? { result: s.result } : {}), recordedAt: s.recordedAt,
  }));
}
