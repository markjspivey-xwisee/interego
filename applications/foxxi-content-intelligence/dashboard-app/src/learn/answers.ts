/**
 * A learner's answers, as the portal holds them while they are put, and as the bridge takes them.
 *
 * A step's questions come as fragmentForLearner serves them: words, a type and what to choose from,
 * never an answer or a verifier. What a person puts is kept as a draft that fits the question (the
 * options picked, the items in the order they arranged them, a target for each prompt, the words
 * written). A draft becomes the reply the engine grades in the grammar of scorm-assessment.ts: the
 * letters of what was chosen, in order where order matters, or the words as written. An agent
 * sends the same replies to foxxi.content_next without any of this.
 *
 * Whether a reply can be sent is judged by the engine's own check (validateScormAnswer), so the
 * portal never refuses what the bridge would take, and says what the bridge would say.
 */
import { validateScormAnswer, type ScormAnswerInput } from '../../../src/scorm-assessment.js';

/** A question as a step serves it. */
export interface LearnerQuestion {
  index: number;
  question: string;
  type: string;
  input?: Omit<ScormAnswerInput, 'salt'>;
  graded: boolean;
}

/** What a learner has put so far, in the form that fits the question. */
export type Draft =
  /** choice and likert: the options picked, by their place as shown. */
  | { kind: 'pick'; picked: number[]; many: boolean }
  | { kind: 'truth'; value: boolean | null }
  /** sequencing: the items as shown, in the order the learner arranged them. */
  | { kind: 'order'; order: number[] }
  /** matching: for each prompt, the target it was matched to. */
  | { kind: 'match'; matched: Array<number | null> }
  /** fill-in, numeric and long-fill-in. */
  | { kind: 'text'; text: string; long: boolean; numeric: boolean };

/** The letter a reply names the option, item or target at `i` by. */
export const letter = (i: number): string => String.fromCharCode(65 + i);

/** A draft with nothing put yet; the items of a sequence start in the order shown. */
export function draftFor(q: LearnerQuestion): Draft {
  const input = q.input;
  switch (input?.type) {
    case 'choice': return { kind: 'pick', picked: [], many: !!input.multiple };
    case 'likert': return { kind: 'pick', picked: [], many: false };
    case 'true-false': return { kind: 'truth', value: null };
    case 'sequencing': return { kind: 'order', order: (input.items ?? []).map((_, i) => i) };
    case 'matching': return { kind: 'match', matched: (input.items ?? []).map(() => null) };
    case 'long-fill-in': return { kind: 'text', text: '', long: true, numeric: false };
    case 'integer':
    case 'number': return { kind: 'text', text: '', long: false, numeric: true };
    default: return { kind: 'text', text: '', long: false, numeric: false };
  }
}

/** The reply a draft makes, as the engine grades it; empty while nothing has been put. */
export function replyOf(draft: Draft): string {
  switch (draft.kind) {
    case 'pick': return [...draft.picked].sort((a, b) => a - b).map(letter).join(', ');
    case 'truth': return draft.value === null ? '' : String(draft.value);
    case 'order': return draft.order.map(letter).join(', ');
    case 'match': return draft.matched.some(m => m === null) ? '' : draft.matched.map(m => letter(m ?? 0)).join(', ');
    case 'text': return draft.text;
  }
}

/** What stops a draft being sent, in the engine's own words, or null when it can be. */
export function problemWith(q: LearnerQuestion, draft: Draft): string | null {
  return validateScormAnswer(replyOf(draft), q.input);
}

/** Pick or unpick the option at `i`: one of several, or the only one. */
export function pick(draft: Extract<Draft, { kind: 'pick' }>, i: number): Draft {
  if (!draft.many) return { ...draft, picked: [i] };
  return { ...draft, picked: draft.picked.includes(i) ? draft.picked.filter(p => p !== i) : [...draft.picked, i] };
}

/** Move the item at place `from` to place `to`, the others keeping their order. */
export function move(draft: Extract<Draft, { kind: 'order' }>, from: number, to: number): Draft {
  if (from === to || from < 0 || to < 0 || from >= draft.order.length || to >= draft.order.length) return draft;
  const order = [...draft.order];
  const [item] = order.splice(from, 1);
  if (item === undefined) return draft;
  order.splice(to, 0, item);
  return { ...draft, order };
}

/** Match the prompt at `prompt` to the target at `target`, or clear it. */
export function matchTo(draft: Extract<Draft, { kind: 'match' }>, prompt: number, target: number | null): Draft {
  if (prompt < 0 || prompt >= draft.matched.length) return draft;
  return { ...draft, matched: draft.matched.map((m, i) => (i === prompt ? target : m)) };
}

/** The replies for a step, one per question, in order: what foxxi.content_next takes as `answers`. */
export function repliesFor(questions: readonly LearnerQuestion[], drafts: readonly Draft[]): string[] {
  return questions.map((q, i) => replyOf(drafts[i] ?? draftFor(q)));
}
