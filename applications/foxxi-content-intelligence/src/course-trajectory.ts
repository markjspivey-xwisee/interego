/**
 * An agent's course record, read as trajectory steps.
 *
 * ★ WHY. The agent-performance layer reads trajectories, which an agent records of its own work.
 * An agent that learns beside its person (src/learning-beside.ts) has a different record: the xAPI
 * statements of its cmi5 registrations. Until 2026-11-25 nothing joined the two, so a person's
 * delegates were named as a team to consult and the consult had nothing to read for an agent that
 * had only taken courses.
 *
 * This projects the one toward the other, on read. Nothing is stored: the statements are the
 * record and stay it, and the steps are rebuilt from them each time, so this adds nothing to the
 * process's memory that a restart could lose (docs/operations/primary-state-rollout-hold.md lists
 * recorded trajectories among the stores that live only there).
 *
 * ★ WHICH WAY THE DEPENDENCY RUNS. Foxxi is the standards vertical, and the theory of performance
 * composes it, not the reverse (tests/the-layer-below-may-not-grow-a-dependency-upward.test.ts at
 * the repository root; the first draft of this file imported the trajectory builder from that
 * layer and that ratchet refused it, rightly). So this file imports nothing from it. A step here
 * is plain data in the shape that layer's trajectory builder takes as input, and a test, which may
 * look upward, pins that the builder accepts these steps unchanged.
 *
 * ★ WHAT A COURSE RECORD CAN AND CANNOT SAY. Every step here is `Asserted`: a statement says a
 * thing happened. A course record holds no intentions and no rejected alternatives, so it cannot
 * show how much an agent plans before it acts or how widely it explores. The disposition read
 * derives exactly those from the share of `Hypothetical` and `Counterfactual` steps, and run over
 * a course record alone it would call any agent execution-biased and exploitative: a fact about
 * the source, reported as a trait of the agent. So `courseRecordRead` reports only what the record
 * supports (what was taken, what was answered and how, what was retried, what was passed or
 * failed) and names the two signals it cannot give. The steps are returned for composing with
 * work the agent did record, where those signals come from that work.
 */

/** A step of a course record: plain data, in the shape a trajectory builder takes as input. */
export interface CourseStep {
  id: string;
  modalStatus: 'Asserted';
  granularity: 'task' | 'subtask';
  verb: string;
  objectId: string;
  objectName: string;
  parentId?: string;
  supersedesId?: string;
  result?: { success?: boolean; quality?: number };
  recordedAt?: string;
}

/** One registration of an agent on a unit, with the statements kept for it. */
export interface CourseRegistrationRecord {
  registration: string;
  auId: string;
  auTitle?: string;
  statements: readonly unknown[];
  /** The registration has more statements than were read; what is said of it is of the part read. */
  truncated?: boolean;
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
 * The steps of an agent's course record: a task for each registration, and under it a step for
 * each statement the agent itself made, in the order they were made.
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
export function courseSteps(agentDid: string, registrations: readonly CourseRegistrationRecord[]): CourseStep[] {
  const steps: CourseStep[] = [];
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
  return steps;
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

/** The read of the steps `courseSteps` made for one agent. */
export function courseRecordRead(agentDid: string, steps: readonly CourseStep[]): CourseRecordRead {
  const tasks = steps.filter(s => s.granularity === 'task');
  const answers = steps.filter(s => s.granularity === 'subtask' && s.verb === 'answered');
  return {
    agent: agentDid,
    taken: tasks.length,
    passed: tasks.filter(s => s.result?.success === true).length,
    failed: tasks.filter(s => s.result?.success === false).length,
    answered: { total: answers.length, correct: answers.filter(s => s.result?.success === true).length },
    retries: steps.filter(s => s.supersedesId).length,
    notReadable: [
      { signal: 'deliberation', why: 'a course record holds what was done, not what was intended first; record the agent\'s plans with foxxi.record_agent_trajectory to read it' },
      { signal: 'exploration', why: 'a course record holds no alternatives the agent considered and rejected; record them with foxxi.record_agent_trajectory to read it' },
    ],
  };
}

/** One page of a statement query, as far as the read below needs one. */
export interface StatementPage { statements: readonly { statement: unknown }[]; more: string | null }

/**
 * Every statement of a registration, following the store's continuation.
 *
 * ★ ONE PAGE IS NOT THE REGISTRATION. A query returns at most 500 statements, and the native store
 * can hand back a continuation after scanning its limit of records even when fewer matched, so a
 * first page can be short, or empty, for a registration that has statements (found by Codex in
 * review of #1004, which read one page and called it the record). This follows `more` until there
 * is none. It stops after `maxPages` and says so (`truncated`), so a very long registration is
 * reported as partly read, not as shorter than it is.
 */
export async function statementsOfRegistration(
  query: (filter: { registration: string; limit: number; ascending: boolean; cursor?: string }) => Promise<StatementPage>,
  registration: string,
  maxPages = 20,
): Promise<{ statements: unknown[]; truncated: boolean }> {
  const statements: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const r = await query({ registration, limit: 500, ascending: true, ...(cursor ? { cursor } : {}) });
    for (const row of r.statements) statements.push(row.statement);
    if (!r.more) return { statements, truncated: false };
    cursor = r.more;
  }
  return { statements, truncated: true };
}
