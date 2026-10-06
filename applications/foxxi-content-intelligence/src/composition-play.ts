/**
 * Playing a resolved composition: one learner, person or agent, stepping through the fragments
 * resolution chose for them, graded by the bridge, and recorded step by step.
 *
 * ★ THE RECORD NAMES THE FRAGMENT, NOT JUST THE COURSE. Each step is an xAPI statement about the
 * fragment itself (`experienced`, object type foxxi:activities/fragment), carrying the competency
 * its position develops, the position, the alternatives it was chosen from and why. Each answer is
 * an `answered` statement about the question as an xAPI interaction activity. So the record says
 * which explanation, example or probe a learner met at which point and how they did after it,
 * which is what choosing among alternatives by what has worked needs. A statement that only named
 * the course could never say that.
 *
 * ★ AN INTERACTION ACTIVITY NEVER CARRIES ITS ANSWER. xAPI lets an interaction definition list
 * `correctResponsesPattern`. These leave it out: the definition is built from the question's
 * public view, and the profile template for `answered` requires the pattern's absence.
 *
 * ★ EACH STEP'S OUTCOME IS CREDITED TO WHAT PREPARED IT. A graded step's result (every graded
 * question right, or not) is an outcome for its own fragment and for each teaching fragment at the
 * same competency the learner met since the last check: an explanation is judged by the check that
 * follows it. The outcomes carry no learner (fragment-efficacy.ts tallies them).
 *
 * ★ A STEP COUNTS ONLY ONCE ITS RECORD IS KEPT. takeStep hands a step's statements to whoever
 * keeps them and returns the step's outcome only once they are kept. Until then the step stays
 * answered but pending, and taking it again keeps the very same statements, so a retry never
 * grades new answers or writes a second copy of what an earlier attempt managed to keep.
 *
 * ★ A MISSED CHECK BRINGS ANOTHER WAY IN. When a check is missed, each position that taught its
 * competency since the last check there, and offers more than the learner met, gives them another
 * of its alternatives: chosen as resolution chose (anotherAlternative), and never one they have
 * already met (one the play would show them later still may be). Another check from the missed check's position follows, when it offers one. Each position
 * does this once per play, and one with nothing else to offer adds nothing: the same explanation
 * twice is not another way in. The steps go in before the play decides it is done, so a play
 * ends only when there is nothing more to take.
 *
 * The statements are built here and nothing is stored. The bridge marks the results it graded
 * (graded-evidence.ts), stores them in the learner's own lens and composes them into their lattice.
 */
import { FOXXI_NS } from './foxxi-vocab.js';
import { fragmentForLearner, publicFragment, type Fragment, type PublicQuestion } from './content-fragments.js';
import type { Resolution, ResolvedStep } from './compositions.js';
import { questionIsRight } from './course-questions.js';
import { scormInteractionResponse, validateScormResponses } from './scorm-assessment.js';
import type { Outcome } from './fragment-efficacy.js';

const ADL = 'http://adlnet.gov/expapi';

/** The context extensions a play's statements carry. */
export const PLAY_EXT = {
  competency: `${FOXXI_NS}competency`,
  position: `${FOXXI_NS}compositionPosition`,
  alternatives: `${FOXXI_NS}alternativesOffered`,
  chosenBecause: `${FOXXI_NS}chosenBecause`,
  contextKind: `${FOXXI_NS}contextKind`,
  actorKind: `${FOXXI_NS}actorKind`,
} as const;

export const PLAY_TYPES = {
  fragment: `${FOXXI_NS}activities/fragment`,
  composition: `${FOXXI_NS}activities/composition`,
  interaction: `${ADL}/activities/cmi.interaction`,
} as const;

export interface CompositionPlay {
  id: string;
  /** The xAPI registration every statement of this play carries. */
  registration: string;
  learner: { id: string; kind: 'human' | 'agent' };
  composition: { iri: string; title: string };
  steps: ResolvedStep[];
  /** The step the learner is on; equals steps.length once the play is done. */
  at: number;
  graded: { correct: number; total: number };
  /** Teaching fragments met since the last check at their competency, waiting to be credited with it, and the step each was met at. */
  waiting: Record<string, Array<{ fragment: string; level: ResolvedStep['pitchedAt']; at: number }>>;
  /** The positions a missed check has brought another way in at, each once. */
  wayIn: string[];
  startedAt: string;
  endedAt?: string;
}

export type Statement = Record<string, unknown>;

/** Another alternative at a position already met, none of `exclude` (compositions.ts: anotherAlternative). */
export type AnotherWayIn = (step: ResolvedStep, exclude: ReadonlySet<string>) => Fragment | undefined;

/** How many positions a play brings another way in at, at most. */
export const WAY_IN_LIMIT = 12;

/** Start a play over a resolution. A resolution with no steps has nothing to play. */
export function startPlay(resolution: Resolution, title: string, learner: CompositionPlay['learner'],
  ids: { session: string; registration: string }, now: string): CompositionPlay | undefined {
  if (!resolution.steps.length) return undefined;
  return {
    id: ids.session, registration: ids.registration, learner,
    composition: { iri: resolution.composition, title }, steps: [...resolution.steps],
    at: 0, graded: { correct: 0, total: 0 }, waiting: {}, wayIn: [], startedAt: now,
  };
}

/**
 * The steps a missed check brings in: for each position that taught its competency since the last
 * check there (the steps the miss was just credited to), another of its alternatives, then another
 * check from the missed one's position. None when no teaching position has anything else.
 *
 * What the learner has met is what they have reached: a fragment the play has yet to show them,
 * even one scheduled later, can still be their way in now. And each step credited stands for its own
 * position, so a fragment taught at two positions gives each of them its way in.
 */
function anotherWayIn(play: CompositionPlay, missed: ResolvedStep, credited: readonly number[], choose: AnotherWayIn): ResolvedStep[] {
  const shown = new Set(play.steps.slice(0, play.at + 1).map(s => s.fragment['@id']));
  const taught = credited.map(i => play.steps[i]).filter((s): s is ResolvedStep => !!s);
  const name = missed.fragment.title ? `"${missed.fragment.title}"` : `the ${missed.fragment.kind}`;
  const brought: ResolvedStep[] = [];
  for (const t of taught) {
    const key = `${t.path.join(' ')}#${t.position}`;
    if (play.wayIn.includes(key) || play.wayIn.length >= WAY_IN_LIMIT) continue;
    const other = choose(t, shown);
    if (!other) continue;
    play.wayIn.push(key);
    shown.add(other['@id']);
    brought.push({ ...t, fragment: other, wayIn: 'teaching', chosenBecause: `another way in: the check ${name} was missed, so this ${other.kind} comes before trying again` });
  }
  if (!brought.length) return [];
  const check = choose(missed, shown);
  if (check) brought.push({ ...missed, fragment: check, wayIn: 'check', chosenBecause: `another check at this competency, after another way in` });
  return brought;
}

/** The step a learner is on, as they receive it; undefined once the play is done. */
export function currentView(play: CompositionPlay): Record<string, unknown> | undefined {
  const step = play.steps[play.at];
  if (!step) return undefined;
  return {
    step: play.at + 1, of: play.steps.length, competency: step.competency, chosenBecause: step.chosenBecause,
    ...(step.wayIn ? { wayIn: step.wayIn } : {}),
    fragment: fragmentForLearner(step.fragment),
  };
}

/**
 * A question as an xAPI interaction activity: its type, words and choices, never its correct
 * responses. Its language maps are keyed by the fragment's language, so a question authored in
 * Portuguese is not declared English downstream.
 */
export function interactionDefinition(q: PublicQuestion, language = 'en'): Record<string, unknown> {
  const def: Record<string, unknown> = { type: PLAY_TYPES.interaction, interactionType: q.type, description: { [language]: q.question } };
  const input = q.input;
  const letters = (xs: readonly string[] | undefined): Array<{ id: string; description: Record<string, string> }> =>
    (xs ?? []).map((x, i) => ({ id: String.fromCharCode(97 + i), description: { [language]: x } }));
  if (input?.type === 'choice' || input?.type === 'sequencing') def.choices = letters(input.type === 'choice' ? input.options : input.items);
  if (input?.type === 'likert') def.scale = letters(input.options);
  if (input?.type === 'matching') {
    def.source = (input.items ?? []).map((x, i) => ({ id: String(i + 1), description: { [language]: x } }));
    def.target = letters(input.targets);
  }
  return def;
}

export type Advance =
  | { ok: true; statements: Statement[]; outcomes: Outcome[]; graded?: { correct: number; total: number; detail: Array<{ question: string; correct: boolean | null; explanation?: string }> }; done: boolean }
  | { ok: false; status: number; error: string; validationErrors?: Array<{ index: number; message: string }> };

/**
 * Take the learner's answers to the step they are on, grade them against the stored questions,
 * build the statements that record it, and move on. On the last step the composition is completed.
 */
/** What a step's statements are made with: who the learner is to xAPI, the time, and fresh statement ids. */
export interface AdvanceContext {
  actor: Record<string, unknown>; now: string; newId: () => string; platform?: string;
  /** Optional signed, one-based step from currentView: guards retries against advancing another step. */
  expectedStep?: number;
}

export function advancePlay(play: CompositionPlay, answers: unknown, ctx: AdvanceContext, choose?: AnotherWayIn): Advance {
  const step = play.steps[play.at];
  if (!step) return { ok: false, status: 409, error: 'this play is done; launch the composition again to replay it' };
  const questions = step.fragment.questions ?? [];
  if (questions.length) {
    const validationErrors = validateScormResponses(questions, answers);
    if (validationErrors.length) return { ok: false, status: 422, error: 'these answers cannot be taken; the step has not advanced', validationErrors };
  }
  const replies = (questions.length ? answers : []) as string[];
  const fragmentIri = step.fragment['@id'];
  const views = publicFragment(step.fragment).questions ?? [];
  const context = (parent: Array<{ id: string; type: string }>, grouping: readonly string[], extensions: Record<string, unknown>): Record<string, unknown> => ({
    registration: play.registration,
    ...(ctx.platform ? { platform: ctx.platform } : {}),
    contextActivities: {
      parent: parent.map(p => ({ objectType: 'Activity', id: p.id, definition: { type: p.type } })),
      ...(grouping.length ? { grouping: grouping.map(iri => ({ objectType: 'Activity', id: iri, definition: { type: PLAY_TYPES.composition } })) } : {}),
    },
    extensions: { [PLAY_EXT.contextKind]: 'training', [PLAY_EXT.actorKind]: play.learner.kind, ...extensions },
  });
  const statement = (verb: string, object: Record<string, unknown>, result: Record<string, unknown>, ctxt: Record<string, unknown>): Statement => ({
    id: ctx.newId(), version: '2.0.0', actor: ctx.actor,
    verb: { id: `${ADL}/verbs/${verb}`, display: { en: verb } }, object: { objectType: 'Activity', ...object }, result, context: ctxt,
    timestamp: ctx.now,
  });

  const statements: Statement[] = [];
  const detail: Array<{ question: string; correct: boolean | null; explanation?: string }> = [];
  let correct = 0; let total = 0;
  questions.forEach((q, i) => {
    const reply = String(replies[i] ?? '');
    const right = questionIsRight(reply, q);
    if (right !== null) { total++; if (right) correct++; }
    detail.push({ question: q.question, correct: right, ...(q.explanation ? { explanation: q.explanation } : {}) });
    statements.push(statement('answered',
      { id: `${fragmentIri}#question-${i + 1}`, definition: interactionDefinition(views[i]!, step.fragment.language) },
      { response: scormInteractionResponse(reply, q.input).slice(0, 4000), completion: true, ...(right !== null ? { success: right } : {}) },
      context([{ id: fragmentIri, type: PLAY_TYPES.fragment }], step.path, { [PLAY_EXT.competency]: step.competency })));
  });
  statements.push(statement('experienced',
    { id: fragmentIri, definition: { type: PLAY_TYPES.fragment, name: { [step.fragment.language ?? 'en']: step.fragment.title ?? `${step.fragment.kind} fragment` } } },
    { completion: true, ...(total ? { score: { raw: correct, max: total, min: 0, scaled: Number((correct / total).toFixed(4)) }, success: correct === total } : {}) },
    context([{ id: step.path[step.path.length - 1] ?? play.composition.iri, type: PLAY_TYPES.composition }], step.path.slice(0, -1), {
      [PLAY_EXT.competency]: step.competency, [PLAY_EXT.position]: step.position,
      [PLAY_EXT.alternatives]: step.alternatives, [PLAY_EXT.chosenBecause]: step.chosenBecause,
    })));

  // Credit the outcome: a graded step to itself and to what taught it since the last check; a
  // step with nothing graded waits for the next check at its competency.
  const outcomes: Outcome[] = [];
  const credited: number[] = [];
  if (total) {
    const success = correct === total;
    outcomes.push({ competency: step.competency, fragment: fragmentIri, level: step.pitchedAt, success });
    for (const w of play.waiting[step.competency] ?? []) {
      outcomes.push({ competency: step.competency, fragment: w.fragment, level: w.level, success });
      credited.push(w.at);
    }
    delete play.waiting[step.competency];
  } else {
    (play.waiting[step.competency] ??= []).push({ fragment: fragmentIri, level: step.pitchedAt, at: play.at });
  }
  // A missed check brings another way in, before the play decides whether it is done.
  if (total && correct < total && choose) play.steps.splice(play.at + 1, 0, ...anotherWayIn(play, step, credited, choose));
  play.graded.correct += correct;
  play.graded.total += total;
  play.at++;
  const done = play.at >= play.steps.length;
  if (done) {
    play.endedAt = ctx.now;
    const g = play.graded;
    statements.push(statement('completed',
      { id: play.composition.iri, definition: { type: PLAY_TYPES.composition, name: { en: play.composition.title } } },
      { completion: true, ...(g.total ? { score: { raw: g.correct, max: g.total, min: 0, scaled: Number((g.correct / g.total).toFixed(4)) } } : {}) },
      { registration: play.registration, ...(ctx.platform ? { platform: ctx.platform } : {}), extensions: { [PLAY_EXT.contextKind]: 'training', [PLAY_EXT.actorKind]: play.learner.kind } }));
  }
  return { ok: true, statements, outcomes, ...(questions.length ? { graded: { correct, total, detail } } : {}), done };
}

/** A play in progress: the step whose record is not kept yet, if any, and whether a step is being taken now. */
export interface PlayInProgress {
  play: CompositionPlay;
  /** A step answered and graded whose statements could not be kept yet: taking a step keeps these very statements first. */
  pending?: Extract<Advance, { ok: true }>;
  /** One-based step whose record is pending; advancePlay has already moved the play onward. */
  pendingAt?: number;
  /** Latest successful receipt, for a guarded retry after its HTTP acknowledgement was lost. */
  lastTaken?: { at: number; taken: Extract<Taken, { ok: true }> };
  /** A step is being taken; another request for this play waits its turn. */
  busy?: boolean;
  /** Where a missed check finds another way in: the rules this play was resolved by. */
  choose?: AnotherWayIn;
}

export type Taken =
  | { ok: true; recorded: string[]; step: Extract<Advance, { ok: true }>; resumed: boolean; replayed?: true }
  | Extract<Advance, { ok: false }>;

/**
 * Take the learner's next step and keep its record. `keep` stores the statements, in order, and
 * answers their ids once every write has settled, or null when any could not be kept; `mark`
 * fixes each statement's final form (the bridge's mark on what it graded) once, before the first
 * attempt. The step's outcome is returned only once its record is kept. Until then it stays
 * pending: the answers given stand, nothing is credited, and the next take keeps the same
 * statements before anything else. One take at a time per play. With expectedStep, the latest
 * successful receipt can be replayed without writes; a stale step is refused before grading.
 * The receipt lives only as long as this in-process play session. Unguarded calls cannot safely
 * retry a successful write whose HTTP acknowledgement was lost.
 */
export async function takeStep(entry: PlayInProgress, answers: unknown, ctx: AdvanceContext,
  keep: (statements: readonly Statement[]) => Promise<string[] | null>,
  mark: (s: Statement) => Statement = s => s): Promise<Taken> {
  if (entry.busy) return { ok: false, status: 409, error: 'a step of this play is still being recorded; send it again in a moment' };
  const expected = ctx.expectedStep;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 1)) return { ok: false, status: 400, error: 'expected_step is a positive one-based integer from the step you received' };
  const at = entry.pendingAt ?? entry.play.at + 1;
  if (expected !== undefined) {
    if (!entry.pending && entry.lastTaken?.at === expected) return { ...entry.lastTaken.taken, replayed: true };
    if (expected !== at) return { ok: false, status: 409, error: 'expected_step does not name the current step; do not apply an earlier answer to a later step' };
  }
  entry.busy = true;
  try {
    const resumed = !!entry.pending;
    if (!entry.pending) {
      const advanced = advancePlay(entry.play, answers, ctx, entry.choose);
      if (!advanced.ok) return advanced;
      entry.pendingAt = at;
      entry.pending = { ...advanced, statements: advanced.statements.map(mark) };
    }
    const step = entry.pending;
    const recorded = await keep(step.statements);
    if (!recorded) return { ok: false, status: 503, error: 'your answers to this step were taken but could not be kept in your record yet; take the step again to keep them (the answers already given stand)' };
    const taken: Extract<Taken, { ok: true }> = { ok: true, recorded, step, resumed };
    entry.lastTaken = { at, taken };
    delete entry.pending;
    delete entry.pendingAt;
    return taken;
  } finally { entry.busy = false; }
}
