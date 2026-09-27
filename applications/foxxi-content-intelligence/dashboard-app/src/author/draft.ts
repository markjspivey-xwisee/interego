/**
 * A fragment as an author writes it in the dashboard, and as foxxi.content_fragment takes it.
 *
 * The author writes in the form natural to write (course-questions.ts): the options and which are
 * right, the items in their right order, the pairs that match. The bridge turns that into the stored
 * form, salts and hashes each answer, and names the fragment by its content. So this module only
 * shapes what the author put into what the bridge takes; nothing here grades or hashes. An agent
 * sends the same JSON.
 *
 * The kinds and levels offered are the engine's own list (src/fragment-kinds.ts), not a copy.
 */
import { COGNITIVE_LEVELS, FRAGMENT_KIND_LIST, type QuestionPolicy } from '../../../src/fragment-kinds.js';

export type KindName = typeof FRAGMENT_KIND_LIST[number]['kind'];
export type Level = typeof COGNITIVE_LEVELS[number];
export { COGNITIVE_LEVELS, FRAGMENT_KIND_LIST };

/** A question as it is being written, one shape per kind of question. */
export type QuestionDraft =
  | { type: 'choice'; question: string; options: string[]; right: number[]; explanation: string }
  | { type: 'true-false'; question: string; answer: boolean | null; explanation: string }
  /** Written in their right order; learners see them shuffled. */
  | { type: 'sequencing'; question: string; items: string[]; explanation: string }
  | { type: 'matching'; question: string; pairs: Array<[string, string]>; distractors: string[]; explanation: string }
  | { type: 'fill-in'; question: string; answer: string; accept: string[]; explanation: string }
  | { type: 'numeric'; question: string; answer: string; min: string; max: string; explanation: string }
  /** A scale nothing grades; an empty scale is the five-point one from disagree to agree. */
  | { type: 'likert'; question: string; scale: string[] }
  | { type: 'long-fill-in'; question: string };

export type QuestionType = QuestionDraft['type'];

/** What each kind of question is called, and whether anything grades it. */
export const QUESTION_TYPES: ReadonlyArray<{ type: QuestionType; label: string; graded: boolean }> = [
  { type: 'choice', label: 'Choice', graded: true },
  { type: 'true-false', label: 'True or false', graded: true },
  { type: 'sequencing', label: 'Put in order', graded: true },
  { type: 'matching', label: 'Match', graded: true },
  { type: 'fill-in', label: 'Short answer', graded: true },
  { type: 'numeric', label: 'Number', graded: true },
  { type: 'likert', label: 'Scale (not graded)', graded: false },
  { type: 'long-fill-in', label: 'Written response (not graded)', graded: false },
];

export const isGraded = (d: QuestionDraft): boolean => QUESTION_TYPES.find(t => t.type === d.type)?.graded ?? false;

/** A new question of a type, with nothing written yet. */
export function newQuestion(type: QuestionType): QuestionDraft {
  switch (type) {
    case 'choice': return { type, question: '', options: ['', ''], right: [], explanation: '' };
    case 'true-false': return { type, question: '', answer: null, explanation: '' };
    case 'sequencing': return { type, question: '', items: ['', ''], explanation: '' };
    case 'matching': return { type, question: '', pairs: [['', ''], ['', '']], distractors: [], explanation: '' };
    case 'fill-in': return { type, question: '', answer: '', accept: [], explanation: '' };
    case 'numeric': return { type, question: '', answer: '', min: '', max: '', explanation: '' };
    case 'likert': return { type, question: '', scale: [] };
    case 'long-fill-in': return { type, question: '' };
  }
}

const letter = (i: number): string => String.fromCharCode(65 + i);
const filled = (xs: readonly string[]): string[] => xs.map(x => x.trim()).filter(Boolean);
const withExplanation = (explanation: string): { explanation?: string } => (explanation.trim() ? { explanation: explanation.trim() } : {});

/** A question as the bridge takes it (course-questions.ts, authorQuestion). */
export function questionPayload(d: QuestionDraft): Record<string, unknown> {
  const question = d.question.trim();
  switch (d.type) {
    case 'choice': {
      const letters = [...new Set(d.right)].sort((a, b) => a - b).map(letter);
      return { type: 'choice', question, options: d.options.map(o => o.trim()), answer: letters.length === 1 ? letters[0] : letters, ...withExplanation(d.explanation) };
    }
    case 'true-false': return { type: 'true-false', question, answer: d.answer, ...withExplanation(d.explanation) };
    case 'sequencing': return { type: 'sequencing', question, items: d.items.map(i => i.trim()), ...withExplanation(d.explanation) };
    case 'matching': {
      const distractors = filled(d.distractors);
      return { type: 'matching', question, pairs: d.pairs.map(([p, a]) => [p.trim(), a.trim()]), ...(distractors.length ? { distractors } : {}), ...withExplanation(d.explanation) };
    }
    case 'fill-in': {
      const accept = filled(d.accept);
      return { type: 'fill-in', question, answer: d.answer.trim(), ...(accept.length ? { accept } : {}), ...withExplanation(d.explanation) };
    }
    case 'numeric': return {
      type: 'numeric', question, answer: Number(d.answer),
      ...(d.min.trim() ? { min: Number(d.min) } : {}), ...(d.max.trim() ? { max: Number(d.max) } : {}),
      ...withExplanation(d.explanation),
    };
    case 'likert': {
      const scale = filled(d.scale);
      return { type: 'likert', question, ...(scale.length ? { scale } : {}) };
    }
    case 'long-fill-in': return { type: 'long-fill-in', question };
  }
}

/** What is still missing from a question before it can be sent; the bridge checks the rest and says so. */
export function missingFrom(d: QuestionDraft): string | null {
  if (!d.question.trim()) return 'Write the question.';
  switch (d.type) {
    case 'choice':
      if (filled(d.options).length < d.options.length || d.options.length < 2) return 'Fill in every option; there are at least two.';
      return d.right.length ? null : 'Mark which option is right.';
    case 'true-false': return d.answer === null ? 'Say whether it is true or false.' : null;
    case 'sequencing': return filled(d.items).length < Math.max(d.items.length, 2) ? 'Fill in every item, in its right order; there are at least two.' : null;
    case 'matching': return d.pairs.length < 2 || d.pairs.some(([p, a]) => !p.trim() || !a.trim()) ? 'Fill in every pair; there are at least two.' : null;
    case 'fill-in': return d.answer.trim() ? null : 'Write the answer.';
    case 'numeric':
      if (!d.answer.trim() || !Number.isFinite(Number(d.answer))) return 'The answer is a number.';
      return [d.min, d.max].some(x => x.trim() && !Number.isFinite(Number(x))) ? 'A least or a most is a number, when there is one.' : null;
    case 'likert':
    case 'long-fill-in': return null;
  }
}

/** A fragment as it is being written. Competencies and suits are written one to a line, or separated by commas. */
export interface FragmentDraft {
  kind: KindName;
  level: Level;
  competencies: string;
  title: string;
  body: string;
  audience: '' | 'human' | 'agent';
  suits: string;
  language: string;
  questions: QuestionDraft[];
}

export function newFragment(): FragmentDraft {
  return { kind: 'concept', level: 'working', competencies: '', title: '', body: '', audience: '', suits: '', language: '', questions: [] };
}

const listOf = (text: string): string[] => [...new Set(text.split(/[\n,]/).map(s => s.trim()).filter(Boolean))];

/** A fragment as the bridge takes it (content-fragments.ts, fragmentFrom). */
export function fragmentPayload(d: FragmentDraft): Record<string, unknown> {
  const suits = listOf(d.suits);
  return {
    kind: d.kind, level: d.level, competencies: listOf(d.competencies), body: d.body,
    ...(d.title.trim() ? { title: d.title.trim() } : {}),
    ...(d.questions.length ? { questions: d.questions.map(questionPayload) } : {}),
    ...(d.audience ? { audience: d.audience } : {}),
    ...(suits.length ? { suits } : {}),
    ...(d.language.trim() ? { language: d.language.trim() } : {}),
  };
}

/** What a kind asks of its questions. */
export function policyOf(kind: KindName): QuestionPolicy {
  return FRAGMENT_KIND_LIST.find(k => k.kind === kind)?.questions ?? 'optional';
}

/** What is still missing from a fragment before it can be sent, one line each; empty when nothing is. */
export function missingFromFragment(d: FragmentDraft): string[] {
  const out: string[] = [];
  if (!listOf(d.competencies).length) out.push('Name at least one competency it develops.');
  if (!d.body.trim()) out.push('Write its body.');
  const policy = policyOf(d.kind);
  if (policy === 'required' && !d.questions.some(isGraded)) out.push('An assessment item measures, so it needs at least one graded question.');
  if (policy === 'ungraded-only' && d.questions.some(isGraded)) out.push('Nothing in a probe or a reflection is graded: use scale or written-response questions.');
  d.questions.forEach((q, i) => { const m = missingFrom(q); if (m) out.push(`Question ${i + 1}: ${m}`); });
  return out;
}

/** A choice without the option at `i`, the marks on the options after it moving with them. */
export function withoutOption(d: Extract<QuestionDraft, { type: 'choice' }>, i: number): QuestionDraft {
  return { ...d, options: d.options.filter((_, k) => k !== i), right: d.right.filter(r => r !== i).map(r => (r > i ? r - 1 : r)) };
}

/** A list with the entry at `from` moved to `to`, the rest keeping their order; unchanged when either is outside it. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}
