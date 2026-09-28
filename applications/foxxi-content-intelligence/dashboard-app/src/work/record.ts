/**
 * A unit of production work as a person records it in the dashboard, and as
 * foxxi.record_performance_signed takes it: what the work was, whether it succeeded, and, when there
 * is one, how it went, step by step (its trajectory). A failed unit sent with its trajectory is
 * answered, unasked, with what the work at its competency implies (work/offer.ts), since the regime
 * of the work is read from how it went. An agent records its own work the same way.
 *
 * Only the shape is made here; the bridge checks each step as the learner record keeps it
 * (workStepsFrom) and says what it refuses. What the page checks first, it checks by the bridge's
 * own rules, loaded from the same modules: how long a step's texts may be (work-step-limits.ts),
 * and what xAPI takes as a duration (xapi-duration.ts, which the LRS's validator reads too). Both
 * import nothing, as every module this page shares with the bridge must: the dashboard's image
 * builds with its own dependencies alone.
 */
import { WORK_STEP_LIMITS } from '../../../src/work-step-limits.js';
import { isXapiDuration } from '../../../src/xapi-duration.js';

/** How sure the performer is a step happened as told. */
export type Certainty = 'Asserted' | 'Hypothetical' | 'Counterfactual';
/** How much of the work a step covers. */
export type Grain = 'task' | 'subtask' | 'tool-call';

export const CERTAINTIES: ReadonlyArray<{ value: Certainty; label: string }> = [
  { value: 'Asserted', label: 'I did this' },
  { value: 'Hypothetical', label: 'I tried this, not knowing whether it would work' },
  { value: 'Counterfactual', label: 'I considered this, and did not do it' },
];
export const GRAINS: ReadonlyArray<{ value: Grain; label: string }> = [
  { value: 'task', label: 'the whole task' },
  { value: 'subtask', label: 'a part of it' },
  { value: 'tool-call', label: 'one action' },
];

/** One step of how the work went, as it is being written. */
export interface StepDraft {
  did: string;
  onWhat: string;
  grain: Grain;
  certainty: Certainty;
  outcome: '' | 'worked' | 'failed';
  note: string;
  /** The earlier step, by place, this one revises: what the performer tried again. */
  revises: number | null;
}

export interface WorkDraft {
  taskName: string;
  outcome: '' | 'succeeded' | 'failed';
  /** The kind of work, an IRI: units of one kind count toward one competency. */
  activityType: string;
  /** The artifact the work produced, as a URL the bridge can fetch, if there is one. */
  taskId: string;
  quality: string;
  duration: string;
  forKind: 'human' | 'agent';
  /** The performer has said they understand that work recorded as an agent's can make their whole record public. */
  publicAsAgent: boolean;
  steps: StepDraft[];
}

/**
 * What recording work as an agent's does to the performer's own record, as the bridge decides it:
 * a subject whose own recorded work all says it was done by an agent classifies as one
 * (subjectKindFromOwnEvidence), and an agent's capability record is public. Said before the choice
 * is sent, and confirmed.
 */
export const AGENT_RECORD_IS_PUBLIC =
  'Recording work as done by an agent is what classifies you as one, unless your record already holds work recorded as done by a person. '
  + "An agent's record is public: anyone who signs a request can then read your competencies, your performance history and your credentials by naming your DID.";

export const newStep = (): StepDraft => ({ did: '', onWhat: '', grain: 'subtask', certainty: 'Asserted', outcome: '', note: '', revises: null });
export const newWork = (forKind: 'human' | 'agent' = 'human'): WorkDraft => ({
  taskName: '', outcome: '', activityType: '', taskId: '', quality: '', duration: '', forKind, publicAsAgent: false, steps: [],
});

/** Who did the work. A change of mind is asked about again: the confirmation belongs to the choice it was given for. */
export function doneBy(d: WorkDraft, forKind: 'human' | 'agent'): WorkDraft {
  return { ...d, forKind, publicAsAgent: false };
}

/** The draft once a unit is recorded: empty again, done by the same kind, of the same kind of work, with what was confirmed for it. */
export function afterRecording(d: WorkDraft): WorkDraft {
  return { ...newWork(d.forKind), activityType: d.activityType, publicAsAgent: d.publicAsAgent };
}

const slug = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'thing';

/** How the work went, as the bridge keeps it with the unit: each step named, a revision naming what it revises. */
export function trajectoryOf(steps: readonly StepDraft[]): { steps: Array<Record<string, unknown>> } | undefined {
  if (!steps.length) return undefined;
  return {
    steps: steps.map((s, i) => {
      const note = s.note.trim();
      const result = { ...(s.outcome ? { success: s.outcome === 'worked' } : {}), ...(note ? { note } : {}) };
      return {
        id: `step-${i + 1}`, modalStatus: s.certainty, granularity: s.grain, verb: s.did.trim(),
        objectId: `urn:foxxi:work-object:${slug(s.onWhat)}`, objectName: s.onWhat.trim(),
        ...(s.revises !== null && s.revises >= 0 && s.revises < i ? { supersedesId: `step-${s.revises + 1}` } : {}),
        ...(Object.keys(result).length ? { result } : {}),
      };
    }),
  };
}

/** The unit as foxxi.record_performance_signed takes it. */
export function workPayload(d: WorkDraft): Record<string, unknown> {
  const trajectory = trajectoryOf(d.steps);
  return {
    task_name: d.taskName.trim(), success: d.outcome === 'succeeded', actor_kind: d.forKind,
    ...(d.activityType.trim() ? { activity_type: d.activityType.trim() } : {}),
    ...(d.taskId.trim() ? { task_id: d.taskId.trim() } : {}),
    ...(d.quality.trim() ? { quality: Number(d.quality) } : {}),
    ...(d.duration.trim() ? { duration_iso: d.duration.trim() } : {}),
    ...(trajectory ? { trajectory } : {}),
  };
}

/** What is still missing before a unit can be sent, one line each; empty when nothing is. */
export function missingFromWork(d: WorkDraft): string[] {
  const out: string[] = [];
  if (!d.taskName.trim()) out.push('Say what the work was.');
  if (!d.outcome) out.push('Say whether it succeeded.');
  if (d.activityType.trim() && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/.test(d.activityType.trim())) {
    out.push('A kind of work is an IRI, such as https://your.example/work/refunds; or leave it out.');
  }
  if (d.quality.trim()) {
    const q = Number(d.quality);
    if (!Number.isFinite(q) || q < -1 || q > 1) out.push('Quality is a number from -1 to 1.');
  }
  if (d.duration.trim() && !isXapiDuration(d.duration.trim())) out.push('A duration is written as ISO 8601, such as PT25M for 25 minutes or PT1H30M; or leave it out.');
  if (d.forKind === 'agent' && !d.publicAsAgent) out.push("Say that you understand recording it as an agent's work can make your record public, or say a person did it.");
  if (d.steps.length > WORK_STEP_LIMITS.steps) out.push(`How it went keeps at most ${WORK_STEP_LIMITS.steps} steps.`);
  d.steps.forEach((s, i) => {
    if (!s.did.trim() || !s.onWhat.trim()) out.push(`Step ${i + 1}: say what was done, and on what.`);
    // As sent: each text trimmed, which is what the bridge measures.
    if ([s.did, s.onWhat, s.note].some(t => t.trim().length > WORK_STEP_LIMITS.text)) out.push(`Step ${i + 1}: keep each text to ${WORK_STEP_LIMITS.text} characters or fewer.`);
  });
  return out;
}

/** Why a failure recorded without how it went cannot be answered: its regime is read from the steps. */
export function answerableFailure(d: WorkDraft): boolean {
  return d.outcome === 'failed' && d.steps.length > 0;
}
