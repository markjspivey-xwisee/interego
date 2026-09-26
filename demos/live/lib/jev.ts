/**
 * Jev, TypeSafe's System One model, choosing among the courses a pod walk discovered for what the
 * learner says they want. One Choice over the courses plus a no-match option, so "none of these"
 * is an answer and not a forced pick; the probabilities are the ranking.
 */
import { jevFromEnv, type ChoiceAnswer } from '../../../applications/_shared/judgment-kit/jev-client.js';

export interface RankableCourse {
  readonly key: string;
  readonly title: string;
  readonly description?: string;
  readonly category?: string;
  readonly provider?: string;
}

export interface Ranking {
  readonly model: string;
  readonly latencyMs: number;
  readonly goal: string;
  readonly choice: string;
  readonly confidence: number;
  readonly options: readonly { readonly key: string; readonly title: string; readonly p: number }[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

export const NONE_FITS = 'none-fits';

/** The question as it is sent, so the page can show exactly what Jev was asked. */
export function rankingQuestion(courses: readonly RankableCourse[]): { type: 'choice'; instructions: string; criteria: Record<string, string> } {
  const criteria: Record<string, string> = {};
  for (const c of courses) criteria[c.key] = `${c.title}${c.description ? `: ${c.description}` : ''}`;
  criteria[NONE_FITS] = 'None of these courses teaches what the learner wants to learn.';
  return {
    type: 'choice',
    instructions: 'The learner has said what they want to learn, in `goal`. Choose the course in `courses` that would best teach it, judging by what each course covers rather than by its title alone. Choose none-fits when no course addresses the goal.',
    criteria,
  };
}

/** What Jev is shown of a learner's record: the decision-shaped part of their IEEE P2997 record. */
export interface RecordForRecommendation {
  readonly learner: string;
  readonly competencies: readonly { readonly label: string; readonly level?: string; readonly basis?: string; readonly status?: string }[];
  readonly credentialsHeld: readonly string[];
  readonly experiences: number;
  readonly performances: number;
}

/**
 * The next course for one learner, decided from their record rather than from a stated goal.
 * The record is the state; the courses are the options; "none fits" stays an answer, because a
 * learner who already holds everything on offer should be told so rather than handed a repeat.
 */
export async function recommendNext(record: RecordForRecommendation, courses: readonly RankableCourse[]): Promise<Ranking> {
  const jev = jevFromEnv();
  const criteria: Record<string, string> = {};
  for (const c of courses) criteria[c.key] = `${c.title}${c.description ? `: ${c.description}` : ''}`;
  criteria[NONE_FITS] = 'None of these courses would add to what this learner\'s record already shows.';
  const question = {
    type: 'choice' as const,
    instructions: 'The learner\'s record is in `record`: the competencies it shows (each with its basis: inferred from learning, or verified by performance at work) and the credentials they already hold. Choose the course in `courses` they should take next to build on that record: prefer one that extends a competency the record shows only as inferred, or opens a closely related one, and never one whose credential they already hold. Choose none-fits when no course would add to the record.',
    criteria,
  };
  const state = { record, courses: courses.map((c) => ({ key: c.key, title: c.title, ...(c.description ? { covers: c.description } : {}), ...(c.provider ? { offeredBy: c.provider } : {}) })) };
  const r = await jev.systemOne(state, { next: question });
  const a = r.answers['next'] as ChoiceAnswer;
  const title = (k: string): string => (k === NONE_FITS ? 'None of these fits' : courses.find((c) => c.key === k)?.title ?? k);
  const options = Object.entries(a.probabilities).map(([key, p]) => ({ key, title: title(key), p })).sort((x, y) => y.p - x.p);
  return { model: r.model, latencyMs: r.latencyMs, goal: `next for ${record.learner}`, choice: a.choice, confidence: a.confidence, options, usage: r.usage };
}

export async function rankCourses(goal: string, courses: readonly RankableCourse[]): Promise<Ranking> {
  const jev = jevFromEnv();
  const question = rankingQuestion(courses);
  const state = { goal, courses: courses.map((c) => ({ key: c.key, title: c.title, ...(c.description ? { covers: c.description } : {}), ...(c.category ? { category: c.category } : {}), ...(c.provider ? { offeredBy: c.provider } : {}) })) };
  const r = await jev.systemOne(state, { course: question });
  const a = r.answers['course'] as ChoiceAnswer;
  const title = (k: string): string => (k === NONE_FITS ? 'None of these fits' : courses.find((c) => c.key === k)?.title ?? k);
  const options = Object.entries(a.probabilities).map(([key, p]) => ({ key, title: title(key), p })).sort((x, y) => y.p - x.p);
  return { model: r.model, latencyMs: r.latencyMs, goal, choice: a.choice, confidence: a.confidence, options, usage: r.usage };
}
