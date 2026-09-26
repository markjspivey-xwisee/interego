/**
 * A cmi5 activity (an AU) played without a browser, the way the agent takes one. What the
 * bridge's generated AU page does in your browser, done here:
 *
 *   1. read the page for its lesson;
 *   2. hand the learner the lesson and its questions, never the answers the page carries to score
 *      itself (a cmi5 AU scores itself; that is why its results are experience, not evidence);
 *   3. score the replies with the page's own rule (`matchesAnswerKey`, the function the page embeds);
 *   4. the AU's side of cmi5: trade the one-time fetch URL for an auth-token, then report
 *      initialized, the result, completed and terminated to the LRS the launch named.
 */
import { explainedAnswer, matchesAnswerKey } from '../../../applications/foxxi-content-intelligence/src/scorm-assessment.js';
import type { DeliveredSection } from './learner.js';

export interface AuLesson {
  readonly id: string;
  readonly title: string;
  readonly competency: string;
  readonly fragments: readonly { readonly modality: string; readonly level: string; readonly body: string }[];
}

export interface AuScore {
  readonly correct: number;
  readonly total: number;
  readonly scaled: number;
  readonly passed: boolean;
  readonly detail: readonly { readonly question: string; readonly reply: string; readonly right: boolean; readonly key: string; readonly why: string }[];
}

const isQuestion = (f: { modality: string }): boolean => f.modality === 'assessment-item';

/** The lesson a generated AU page carries, as it declares it: `const LESSON = {…};`. */
export function lessonOfAuPage(html: string): AuLesson {
  const m = /const LESSON = (\{[\s\S]*?\});\s*\nconst IS_ASSESSMENT/.exec(html);
  if (!m?.[1]) throw new Error('the activity page carries no lesson this player can read');
  return JSON.parse(m[1]) as AuLesson;
}

/** The lesson as the learner meets it: its text, and each question without its answer. */
export function lessonForLearner(lesson: AuLesson): DeliveredSection {
  const questions = lesson.fragments.filter(isQuestion).map((f, index) => ({ question: (f.body.split(':::')[0] ?? '').trim(), index }));
  return {
    id: lesson.id.split(':').pop() ?? lesson.id,
    title: lesson.title,
    body: lesson.fragments.filter((f) => !isQuestion(f)).map((f) => f.body).join('\n\n'),
    ...(questions.length ? { assessment: questions } : {}),
  };
}

/** Score replies the way the page does: the same rule, and the page's own pass mark (0.6). */
export function scoreLesson(lesson: AuLesson, replies: readonly string[]): AuScore {
  const detail = lesson.fragments.filter(isQuestion).map((f, i) => {
    const [question = '', authored = ''] = f.body.split(':::');
    const { key, why } = explainedAnswer(authored.trim());
    const reply = replies[i] ?? '';
    return { question: question.trim(), reply, right: matchesAnswerKey(reply, key), key, why };
  });
  const correct = detail.filter((d) => d.right).length;
  const scaled = detail.length ? correct / detail.length : 0;
  return { correct, total: detail.length, scaled, passed: scaled >= 0.6, detail };
}

/** The AU's side of cmi5: the auth-token, then each statement the page would send, in its order. */
export async function reportAu(launchUrl: string, lesson: AuLesson, score: AuScore | null): Promise<{ sent: string[] }> {
  const q = new URL(launchUrl).searchParams;
  const endpoint = (q.get('endpoint') ?? '').replace(/\/?$/, '/');
  const fetchUrl = q.get('fetch') ?? '';
  const actor = JSON.parse(q.get('actor') ?? '{}') as Record<string, unknown>;
  const activityId = q.get('activityId') ?? lesson.id;
  const registration = q.get('registration') ?? '';
  const fr = await fetch(fetchUrl, { method: 'POST' });
  if (!fr.ok) throw new Error(`the fetch URL answered ${fr.status}`);
  const token = (await fr.json() as Record<string, unknown>)['auth-token'];
  if (typeof token !== 'string' || !token) throw new Error('the fetch URL gave no auth-token');
  const sent: string[] = [];
  const send = async (verb: string, result?: Record<string, unknown>): Promise<void> => {
    const r = await fetch(`${endpoint}statements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: crypto.randomUUID(), actor,
        verb: { id: `http://adlnet.gov/expapi/verbs/${verb}`, display: { 'en-US': verb } },
        object: { objectType: 'Activity', id: activityId, definition: { name: { 'en-US': lesson.title }, type: 'http://adlnet.gov/expapi/activities/lesson' } },
        context: { registration, contextActivities: { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] } },
        timestamp: new Date().toISOString(),
        ...(result ? { result } : {}),
      }),
    });
    if (!r.ok) throw new Error(`the LRS answered ${r.status} to ${verb}`);
    sent.push(verb);
  };
  await send('initialized');
  if (score) await send(score.passed ? 'passed' : 'failed', { score: { scaled: score.scaled }, success: score.passed, completion: true });
  await send('completed', { completion: true });
  await send('terminated');
  return { sent };
}
