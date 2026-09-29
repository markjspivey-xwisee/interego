/**
 * An authored question, as the engine stores and grades it.
 *
 * An author (a person or an agent) writes questions in the form that is natural to write: the
 * options and which is right, the items in their right order, the pairs that match. This turns
 * each into the stored form the engine, the SCORM package and a learner's view all read: the
 * options, items and targets in the order a learner sees them, and a verifier (SHA-256 of the
 * canonical right answer, see `scormAnswerCandidates`) instead of the answer.
 *
 * The question types are the xAPI interaction types:
 *   fill-in       a typed answer; `accept` lists other accepted answers, and `caseSensitive`
 *                 makes letter case count (it is otherwise read without it)
 *   numeric       a number, with optional min and max
 *   choice        options A…; one right, or several (`multiple`, or an array answer)
 *   true-false
 *   sequencing    items to put in order, written in their right order and shown shuffled
 *   matching      prompts each matched to one answer; extra `distractors` may be offered
 *   likert        a scale; nothing grades it
 *   long-fill-in  a written response; nothing grades it
 *
 * ★ THE ORDER A LEARNER SEES IS SEEDED, NOT RANDOM. A course is authored, stored on a pod and read
 * back, and re-authoring the same course must give the same verifiers. So shuffles and salts come
 * from the course, section and question, not from a random source.
 *
 * ★ A VERIFIER HIDES AN ANSWER FROM A GLANCE, NOT FROM A SEARCH. A choice between four options
 * can be found by hashing four strings, as a one-word answer can by hashing the section's words.
 * The salt keeps a right answer from hashing to a value every course shares, and that is all. An
 * explanation is stored as written, and is shown only once the question has been answered.
 */
import { createHash } from 'node:crypto';
import { inferScormAnswerInput, scormAnswerCandidates, scormInteractionType, scormOptionIndex, type ScormAnswerInput, type ScormAssessmentQuestion } from './scorm-assessment.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Size limits on an authored question. */
export const QUESTION_LIMITS = { question: 1000, label: 300, labels: 26, explanation: 2000, accept: 10, acceptLength: 250 } as const;

const DEFAULT_LIKERT = ['Strongly disagree', 'Disagree', 'Neither agree nor disagree', 'Agree', 'Strongly agree'];

/** An authored question the engine cannot take; the message says what to fix. */
export class QuestionError extends Error {}

type AuthoredType = 'fill-in' | 'numeric' | 'choice' | 'true-false' | 'sequencing' | 'matching' | 'likert' | 'long-fill-in';

const TYPES: Record<string, AuthoredType> = {
  'fill-in': 'fill-in', 'fill-in-the-blank': 'fill-in', text: 'fill-in', 'short-answer': 'fill-in',
  numeric: 'numeric', number: 'numeric', integer: 'numeric',
  choice: 'choice', 'multiple-choice': 'choice', 'multiple-response': 'choice', 'multi-select': 'choice', 'single-choice': 'choice',
  'true-false': 'true-false', boolean: 'true-false',
  sequencing: 'sequencing', ordering: 'sequencing', order: 'sequencing',
  matching: 'matching', match: 'matching',
  likert: 'likert', scale: 'likert', survey: 'likert',
  'long-fill-in': 'long-fill-in', essay: 'long-fill-in', reflection: 'long-fill-in', 'free-response': 'long-fill-in',
};

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new QuestionError(`${what} must be a non-empty string`);
  if (value.length > max) throw new QuestionError(`${what} is longer than ${max} characters`);
  return value.trim();
}

function labels(value: unknown, what: string, min = 2): string[] {
  if (!Array.isArray(value)) throw new QuestionError(`${what} must be an array of strings`);
  const out = value.map((v, i) => text(v, `${what}[${i}]`, QUESTION_LIMITS.label));
  if (out.length < min || out.length > QUESTION_LIMITS.labels) throw new QuestionError(`${what} needs ${min} to ${QUESTION_LIMITS.labels} entries`);
  const seen = new Set<string>();
  for (const label of out) {
    const key = label.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) throw new QuestionError(`${what} has "${label}" twice`);
    seen.add(key);
  }
  return out;
}

/** A shuffle of 0…n-1 drawn from `seed`: the same seed gives the same order. */
function seededOrder(n: number, seed: string): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  let pool = sha256(seed);
  let at = 0;
  for (let i = n - 1; i > 0; i--) {
    if (at + 8 > pool.length) { pool = sha256(pool); at = 0; }
    const j = parseInt(pool.slice(at, at + 8), 16) % (i + 1);
    at += 8;
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

const letter = (i: number): string => String.fromCharCode(65 + i);

function verifier(reply: string, input: ScormAnswerInput | undefined, what: string): string {
  const canonical = scormAnswerCandidates(reply, input)[0];
  if (!canonical) throw new QuestionError(`${what} is not an answer this question can take`);
  return sha256(canonical);
}

/** A stored question (read back from a pod, or re-sent already hashed): its shape checked, nothing recomputed. */
function storedQuestion(q: Record<string, unknown>, question: string, explanation: string | undefined): ScormAssessmentQuestion {
  const input = q.input as ScormAnswerInput | undefined;
  checkStoredInput(input);
  const ungraded = input?.type === 'likert' || input?.type === 'long-fill-in';
  const answerHash = q.answerHash;
  if (ungraded ? answerHash !== undefined : typeof answerHash !== 'string' || !/^[0-9a-f]{64}$/.test(answerHash)) {
    throw new QuestionError(ungraded ? `a ${input!.type} question has no verifier` : 'an assessment question requires a SHA-256 answer verifier');
  }
  const accept = q.acceptHashes;
  if (accept !== undefined && (!Array.isArray(accept) || accept.length > QUESTION_LIMITS.accept || accept.some(h => typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)))) {
    throw new QuestionError('acceptHashes must be up to 10 SHA-256 verifiers');
  }
  return {
    question,
    ...(typeof answerHash === 'string' ? { answerHash } : {}),
    ...(Array.isArray(accept) && accept.length ? { acceptHashes: accept as string[] } : {}),
    ...(input ? { input } : {}),
    ...(explanation ? { explanation } : {}),
  };
}

/** The shape a stored question's input must have; throws with what is wrong. */
export function checkStoredInput(input: ScormAnswerInput | undefined): void {
  if (input === undefined) return;
  if (!input || typeof input !== 'object') throw new QuestionError('input must be an object');
  const types = ['text', 'integer', 'number', 'choice', 'true-false', 'sequencing', 'matching', 'likert', 'long-fill-in'];
  if (!types.includes(input.type)) throw new QuestionError('Invalid assessment input type.');
  for (const bound of [input.min, input.max]) {
    if (bound !== undefined && (!Number.isFinite(bound) || (input.type === 'integer' && !Number.isSafeInteger(bound)))) throw new QuestionError('Invalid assessment input bounds.');
  }
  if (input.type !== 'integer' && input.type !== 'number' && (input.min !== undefined || input.max !== undefined)) throw new QuestionError('Only a numeric input can have numeric bounds.');
  if (input.min !== undefined && input.max !== undefined && input.min > input.max) throw new QuestionError('Assessment minimum exceeds maximum.');
  if (input.type === 'choice' || input.type === 'likert') labels(input.options, 'options');
  else if (input.options !== undefined) throw new QuestionError(`a ${input.type} input has no options`);
  if (input.type === 'sequencing' || input.type === 'matching') labels(input.items, 'items');
  else if (input.items !== undefined) throw new QuestionError(`a ${input.type} input has no items`);
  if (input.type === 'matching') labels(input.targets, 'targets');
  else if (input.targets !== undefined) throw new QuestionError(`a ${input.type} input has no targets`);
  if (input.multiple !== undefined && (input.type !== 'choice' || typeof input.multiple !== 'boolean')) throw new QuestionError('only a choice input can be multiple');
  if (input.caseSensitive !== undefined && (input.type !== 'text' || typeof input.caseSensitive !== 'boolean')) throw new QuestionError('only a text input can be case-sensitive');
  if (input.compare !== undefined && (input.type !== 'text' || (input.compare !== 'exact' && input.compare !== 'letters'))) throw new QuestionError('only a text input compares a reply whole, exact or by its letters');
  if (input.salt !== undefined && (typeof input.salt !== 'string' || !/^[0-9a-f]{8,64}$/.test(input.salt))) throw new QuestionError('input.salt must be 8 to 64 hex characters');
}

/**
 * An authored question in its stored form. `seed` names the question within its course
 * (course, section, index), so re-authoring gives the same order, salt and verifiers.
 */
export function authorQuestion(raw: unknown, seed: string): ScormAssessmentQuestion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QuestionError('each question must be an object');
  const q = raw as Record<string, unknown>;
  const question = text(q.question, 'question', QUESTION_LIMITS.question);
  const explanation = q.explanation === undefined || q.explanation === null ? undefined : text(q.explanation, 'explanation', QUESTION_LIMITS.explanation);
  // Already hashed (a course read back from a pod, or re-sent): kept as it is, its shape checked.
  if (q.answerHash !== undefined || (q.input !== undefined && q.answer === undefined)) return storedQuestion(q, question, explanation);
  // A plain answer with an explicit typed input, as authors have always been able to give
  // (a numeric range, say): hashed under that input.
  if (q.input !== undefined) {
    const input = q.input as ScormAnswerInput;
    checkStoredInput(input);
    if (!['text', 'integer', 'number'].includes(input.type)) throw new QuestionError(`a ${input.type} question is written with its options, items or pairs, not with an input`);
    // A named type and an explicit input must say the same thing; neither silently wins.
    if (q.type !== undefined) {
      const said = TYPES[String(q.type).toLowerCase()];
      if (!said) throw new QuestionError(`type must be one of ${Object.keys(TYPES).join(', ')}`);
      const agrees = said === 'fill-in' ? input.type === 'text' : said === 'numeric' ? input.type !== 'text' : false;
      if (!agrees) throw new QuestionError(`type ${String(q.type)} and input type ${input.type} disagree; give one of them`);
    }
    const answer = typeof q.answer === 'number' ? String(q.answer) : text(q.answer, 'answer', QUESTION_LIMITS.acceptLength);
    if (q.caseSensitive !== undefined && (typeof q.caseSensitive !== 'boolean' || (q.caseSensitive && input.type !== 'text'))) {
      throw new QuestionError('caseSensitive is true or false, and only a typed text answer can be case-sensitive');
    }
    if (q.compare !== undefined && ((q.compare !== 'exact' && q.compare !== 'letters') || input.type !== 'text')) {
      throw new QuestionError('compare is exact or letters, and only a typed text answer is compared so');
    }
    if (q.compare !== undefined && input.compare !== undefined && q.compare !== input.compare) throw new QuestionError('compare and input.compare disagree; give one of them');
    // A text input is the default, and is not kept, unless it makes letter case count or says how
    // a reply is compared (Codex, on #581: an input's own compare was dropped).
    const caseSensitive = input.type === 'text' && (input.caseSensitive === true || q.caseSensitive === true);
    const compare = input.type === 'text' ? input.compare ?? (q.compare as 'exact' | 'letters' | undefined) : undefined;
    const typed: ScormAnswerInput | undefined = input.type !== 'text' ? input
      : caseSensitive || compare ? { type: 'text', ...(caseSensitive ? { caseSensitive: true } : {}), ...(compare ? { compare } : {}) } : undefined;
    return { question, answerHash: verifier(answer, typed, 'answer'), ...(typed ? { input: typed } : {}), ...(explanation ? { explanation } : {}) };
  }

  const named = q.type === undefined ? undefined : TYPES[String(q.type).toLowerCase()];
  if (q.type !== undefined && !named) throw new QuestionError(`type must be one of ${Object.keys(TYPES).join(', ')}`);
  const type: AuthoredType = named
    ?? (Array.isArray(q.options) ? 'choice' : Array.isArray(q.pairs) ? 'matching' : Array.isArray(q.items) ? 'sequencing' : typeof q.answer === 'boolean' ? 'true-false' : 'fill-in');
  const salt = sha256(`${seed}\nsalt`).slice(0, 16);
  // Every authored form is one the package validator takes, so what the engine accepts it can also package.
  const done = (input: ScormAnswerInput | undefined, answerHash: string | undefined, acceptHashes?: string[]): ScormAssessmentQuestion => {
    checkStoredInput(input);
    return {
      question,
      ...(answerHash ? { answerHash } : {}),
      ...(acceptHashes?.length ? { acceptHashes } : {}),
      ...(input ? { input } : {}),
      ...(explanation ? { explanation } : {}),
    };
  };

  switch (type) {
    case 'fill-in':
    case 'numeric': {
      const answer = typeof q.answer === 'number' ? String(q.answer) : text(q.answer, 'answer', QUESTION_LIMITS.acceptLength);
      // A named fill-in stays text, so "0012" keeps its zeros and "twelve" can be accepted beside
      // it. A number-like answer is read as a number only in a numeric question, or when the type
      // is not named (the form authors have always written).
      const inferred = named === 'fill-in' ? undefined : inferScormAnswerInput(answer);
      if (type === 'numeric' && !inferred) throw new QuestionError('a numeric question needs a number as its answer');
      if (!inferred && (q.min !== undefined || q.max !== undefined)) throw new QuestionError('min and max apply only to a numeric question');
      // Letter case counts only where a question says so (`caseSensitive`), as a source it was read
      // from may declare; a typed answer is otherwise read without it.
      if (q.caseSensitive !== undefined && typeof q.caseSensitive !== 'boolean') throw new QuestionError('caseSensitive is true or false');
      if (q.caseSensitive === true && inferred) throw new QuestionError('only a typed text answer can be case-sensitive');
      // A question read from a package compares the whole reply as its source does (`compare`).
      if (q.compare !== undefined && q.compare !== 'exact' && q.compare !== 'letters') throw new QuestionError('compare is exact or letters');
      if (q.compare !== undefined && inferred) throw new QuestionError('only a typed text answer is compared exact or by its letters');
      const compare = q.compare as 'exact' | 'letters' | undefined;
      const input: ScormAnswerInput | undefined = inferred
        ? { ...inferred, ...(q.min !== undefined ? { min: Number(q.min) } : {}), ...(q.max !== undefined ? { max: Number(q.max) } : {}) }
        : q.caseSensitive === true || compare ? { type: 'text', ...(q.caseSensitive === true ? { caseSensitive: true } : {}), ...(compare ? { compare } : {}) } : undefined;
      if (input) checkStoredInput(input);
      const acceptIn = q.accept === undefined ? [] : Array.isArray(q.accept) ? q.accept : [q.accept];
      if (acceptIn.length > QUESTION_LIMITS.accept) throw new QuestionError(`accept lists at most ${QUESTION_LIMITS.accept} answers`);
      const accept = acceptIn.map((a, i) => verifier(typeof a === 'number' ? String(a) : text(a, `accept[${i}]`, QUESTION_LIMITS.acceptLength), input, `accept[${i}]`));
      return done(input, verifier(answer, input, 'answer'), [...new Set(accept)]);
    }
    case 'choice': {
      const options = labels(q.options, 'options');
      const answers = Array.isArray(q.answer) ? q.answer : [q.answer];
      if (!answers.length || answers.some(a => typeof a !== 'string' || !a.trim())) {
        throw new QuestionError('a choice answer names the right option by its letter ("B") or its exact text; a list of them when several are right');
      }
      const multiple = q.multiple === true || answers.length > 1;
      const input: ScormAnswerInput = { type: 'choice', options, ...(multiple ? { multiple: true } : {}), salt };
      // Each named option on its own, so an option's text may hold commas; the reply is their letters.
      const picked = (answers as string[]).map((a, i) => {
        const at = scormOptionIndex(a, options);
        if (at < 0) throw new QuestionError(`answer${answers.length > 1 ? `[${i}]` : ''} "${a}" is neither an option's letter nor its exact text`);
        return letter(at);
      });
      return done(input, verifier(picked.join(', '), input, 'answer'));
    }
    case 'true-false': {
      const said = typeof q.answer === 'boolean' ? String(q.answer) : typeof q.answer === 'string' ? q.answer : '';
      if (!/^(true|false)$/i.test(said.trim())) throw new QuestionError('a true-false answer is true or false');
      const input: ScormAnswerInput = { type: 'true-false', salt };
      return done(input, verifier(said, input, 'answer'));
    }
    case 'sequencing': {
      const inOrder = labels(q.items, 'items');
      let shown = seededOrder(inOrder.length, `${seed}\norder`);
      if (shown.every((v, i) => v === i)) shown = [...shown.slice(1), shown[0]!];
      const input: ScormAnswerInput = { type: 'sequencing', items: shown.map(i => inOrder[i]!), salt };
      // The right reply names the shown items in their right order.
      const right = inOrder.map((_, rank) => letter(shown.indexOf(rank))).join(', ');
      return done(input, verifier(right, input, 'items'));
    }
    case 'matching': {
      if (!Array.isArray(q.pairs)) throw new QuestionError('a matching question needs pairs: [[prompt, answer], …]');
      const pairs = q.pairs.map((p, i) => {
        if (!Array.isArray(p) || p.length !== 2) throw new QuestionError(`pairs[${i}] must be [prompt, answer]`);
        return [text(p[0], `pairs[${i}][0]`, QUESTION_LIMITS.label), text(p[1], `pairs[${i}][1]`, QUESTION_LIMITS.label)] as const;
      });
      const prompts = labels(pairs.map(p => p[0]), 'prompts');
      const distractors = q.distractors === undefined ? [] : labels(q.distractors, 'distractors', 0);
      const answersIn: string[] = [];
      for (const target of [...pairs.map(p => p[1]), ...distractors]) {
        if (!answersIn.some(t => t.toLowerCase() === target.toLowerCase())) answersIn.push(target);
      }
      if (answersIn.length < 2) throw new QuestionError('a matching question needs at least two different answers to choose from; add distractors');
      if (answersIn.length > QUESTION_LIMITS.labels) throw new QuestionError(`a matching question offers at most ${QUESTION_LIMITS.labels} answers`);
      const shown = seededOrder(answersIn.length, `${seed}\norder`).map(i => answersIn[i]!);
      const input: ScormAnswerInput = { type: 'matching', items: prompts, targets: shown, salt };
      const right = pairs.map(p => letter(shown.findIndex(t => t.toLowerCase() === p[1].toLowerCase()))).join(', ');
      return done(input, verifier(right, input, 'pairs'));
    }
    case 'likert':
      return done({ type: 'likert', options: q.scale === undefined ? DEFAULT_LIKERT : labels(q.scale, 'scale') }, undefined);
    case 'long-fill-in':
      return done({ type: 'long-fill-in' }, undefined);
  }
}

/** Is this reply right? null when nothing grades the question. */
export function questionIsRight(reply: string, q: ScormAssessmentQuestion): boolean | null {
  if (!q.answerHash) return null;
  const verifiers = new Set([q.answerHash, ...(q.acceptHashes ?? [])]);
  return scormAnswerCandidates(reply, q.input).some(candidate => verifiers.has(sha256(candidate)));
}

/** A question as a learner may see it: its type and what to choose from, never a verifier, salt or explanation. */
export function questionForLearner(q: ScormAssessmentQuestion, index: number): { index: number; question: string; type: string; input?: ScormAnswerInput; graded: boolean } {
  const input = q.input ? { ...q.input } : undefined;
  if (input) delete input.salt;
  return { index, question: q.question, type: scormInteractionType(q.input), ...(input ? { input } : {}), graded: !!q.answerHash };
}
