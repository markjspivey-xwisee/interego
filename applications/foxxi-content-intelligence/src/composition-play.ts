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
 * The statements are built here and nothing is stored. The bridge marks the results it graded
 * (graded-evidence.ts), stores them in the learner's own lens and composes them into their lattice.
 */
import { FOXXI_NS } from './foxxi-vocab.js';
import { fragmentForLearner, publicFragment, type PublicQuestion } from './content-fragments.js';
import type { Resolution, ResolvedStep } from './compositions.js';
import { questionIsRight } from './course-questions.js';
import { scormInteractionResponse, validateScormResponses } from './scorm-assessment.js';

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
  startedAt: string;
  endedAt?: string;
}

export type Statement = Record<string, unknown>;

/** Start a play over a resolution. A resolution with no steps has nothing to play. */
export function startPlay(resolution: Resolution, title: string, learner: CompositionPlay['learner'],
  ids: { session: string; registration: string }, now: string): CompositionPlay | undefined {
  if (!resolution.steps.length) return undefined;
  return {
    id: ids.session, registration: ids.registration, learner,
    composition: { iri: resolution.composition, title }, steps: resolution.steps,
    at: 0, graded: { correct: 0, total: 0 }, startedAt: now,
  };
}

/** The step a learner is on, as they receive it; undefined once the play is done. */
export function currentView(play: CompositionPlay): Record<string, unknown> | undefined {
  const step = play.steps[play.at];
  if (!step) return undefined;
  return {
    step: play.at + 1, of: play.steps.length, competency: step.competency, chosenBecause: step.chosenBecause,
    fragment: fragmentForLearner(step.fragment),
  };
}

/** A question as an xAPI interaction activity: its type, words and choices, never its correct responses. */
export function interactionDefinition(q: PublicQuestion): Record<string, unknown> {
  const def: Record<string, unknown> = { type: PLAY_TYPES.interaction, interactionType: q.type, description: { en: q.question } };
  const input = q.input;
  const letters = (xs: readonly string[] | undefined): Array<{ id: string; description: { en: string } }> =>
    (xs ?? []).map((x, i) => ({ id: String.fromCharCode(97 + i), description: { en: x } }));
  if (input?.type === 'choice' || input?.type === 'sequencing') def.choices = letters(input.type === 'choice' ? input.options : input.items);
  if (input?.type === 'likert') def.scale = letters(input.options);
  if (input?.type === 'matching') {
    def.source = (input.items ?? []).map((x, i) => ({ id: String(i + 1), description: { en: x } }));
    def.target = letters(input.targets);
  }
  return def;
}

export type Advance =
  | { ok: true; statements: Statement[]; graded?: { correct: number; total: number; detail: Array<{ question: string; correct: boolean | null; explanation?: string }> }; done: boolean }
  | { ok: false; status: number; error: string; validationErrors?: Array<{ index: number; message: string }> };

/**
 * Take the learner's answers to the step they are on, grade them against the stored questions,
 * build the statements that record it, and move on. On the last step the composition is completed.
 */
export function advancePlay(play: CompositionPlay, answers: unknown, ctx: {
  actor: Record<string, unknown>; now: string; newId: () => string; platform?: string;
}): Advance {
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
      { id: `${fragmentIri}#question-${i + 1}`, definition: interactionDefinition(views[i]!) },
      { response: scormInteractionResponse(reply, q.input).slice(0, 4000), completion: true, ...(right !== null ? { success: right } : {}) },
      context([{ id: fragmentIri, type: PLAY_TYPES.fragment }], step.path, { [PLAY_EXT.competency]: step.competency })));
  });
  statements.push(statement('experienced',
    { id: fragmentIri, definition: { type: PLAY_TYPES.fragment, name: { en: step.fragment.title ?? `${step.fragment.kind} fragment` } } },
    { completion: true, ...(total ? { score: { raw: correct, max: total, min: 0, scaled: Number((correct / total).toFixed(4)) }, success: correct === total } : {}) },
    context([{ id: step.path[step.path.length - 1] ?? play.composition.iri, type: PLAY_TYPES.composition }], step.path.slice(0, -1), {
      [PLAY_EXT.competency]: step.competency, [PLAY_EXT.position]: step.position,
      [PLAY_EXT.alternatives]: step.alternatives, [PLAY_EXT.chosenBecause]: step.chosenBecause,
    })));

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
  return { ok: true, statements, ...(questions.length ? { graded: { correct, total, detail } } : {}), done };
}
