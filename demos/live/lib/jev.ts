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
