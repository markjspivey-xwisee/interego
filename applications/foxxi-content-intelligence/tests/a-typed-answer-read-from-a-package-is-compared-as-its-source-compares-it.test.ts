/**
 * A TYPED ANSWER READ FROM A PACKAGE IS COMPARED AS ITS SOURCE COMPARES IT.
 *
 * A typed answer used to be read the lenient way an authored course's always has been: its ASCII
 * letters and digits, and any word of four letters or more. So "C" was right for "C++", "Grüße" for
 * "Größe", and "not legs" for "legs" (a review of #578). A question read from a package compares
 * the whole reply as its source does (`compare`): every character (`exact`, as Rise, Storyline,
 * H5P, QTI and Adapt compare), or the letters and digits of every script (`letters`, Adapt where its
 * author allows punctuation). A question stored or authored here reads as it always has.
 *
 * Here: exact, letters, the reply taken whole, one Unicode form, the legacy rule kept, a stored
 * input checked, and the page a package plays grading the same way.
 */
import { describe, expect, it } from 'vitest';
import { authorQuestion, checkStoredInput, questionIsRight, QuestionError } from '../src/course-questions.js';
import { normalizeScormAnswer, scormAnswerCandidates, scormAssessmentScript, type ScormAnswerInput } from '../src/scorm-assessment.js';

const fillIn = (answer: string, extra: Record<string, unknown> = {}) => authorQuestion({ question: 'Q?', type: 'fill-in', answer, ...extra }, 'seed');
const u = (code: number): string => String.fromCharCode(code);

describe('a typed answer compared exact, as its tool compares it', () => {
  it('keeps every character a reply has, and folds letter case unless it counts', () => {
    const cpp = fillIn('C++', { compare: 'exact' });
    expect(cpp.input).toEqual({ type: 'text', compare: 'exact' });
    expect(questionIsRight('C++', cpp)).toBe(true);
    expect(questionIsRight('c++', cpp)).toBe(true);
    expect(questionIsRight('C', cpp)).toBe(false);
    const size = fillIn('Größe', { compare: 'exact' });
    expect(questionIsRight('größe', size)).toBe(true);
    expect(questionIsRight('Grüße', size)).toBe(false);
    const cased = fillIn('Größe', { compare: 'exact', caseSensitive: true });
    expect(cased.input).toEqual({ type: 'text', caseSensitive: true, compare: 'exact' });
    expect(questionIsRight('Größe', cased)).toBe(true);
    expect(questionIsRight('größe', cased)).toBe(false);
  });

  it('takes the whole reply, never one of its words', () => {
    const legs = fillIn('legs', { compare: 'exact' });
    expect(questionIsRight('legs', legs)).toBe(true);
    expect(questionIsRight('not legs', legs)).toBe(false);
    expect(scormAnswerCandidates('not your legs', { type: 'text', compare: 'exact' })).toEqual(['not your legs']);
  });

  it('reads a reply in one Unicode form, without zero-width marks, its spaces collapsed and trimmed', () => {
    const cafe = fillIn('café', { compare: 'exact' });
    expect(questionIsRight(`cafe${u(0x301)}`, cafe)).toBe(true);
    expect(questionIsRight(`ca${u(0x200b)}fé`, cafe)).toBe(true);
    expect(questionIsRight('  CAFÉ ', cafe)).toBe(true);
    expect(questionIsRight('New   York', fillIn('New York', { compare: 'exact' }))).toBe(true);
  });
});

describe('a typed answer compared by its letters (Adapt, where its author allows punctuation)', () => {
  it('drops punctuation and symbols, and keeps the letters and digits of every script', () => {
    const usa = fillIn('U.S.A.', { compare: 'letters' });
    expect(questionIsRight('USA', usa)).toBe(true);
    expect(questionIsRight('u s a', usa)).toBe(false);
    expect(questionIsRight("don't", fillIn('dont', { compare: 'letters' }))).toBe(true);
    const size = fillIn('Größe', { compare: 'letters' });
    expect(questionIsRight('Größe!', size)).toBe(true);
    expect(questionIsRight('Grüße', size)).toBe(false);
    expect(questionIsRight('Москва', fillIn('Москва.', { compare: 'letters' }))).toBe(true);
    expect(questionIsRight('not legs', fillIn('legs', { compare: 'letters' }))).toBe(false);
  });
});

describe('an answer stored or authored here reads as it always has', () => {
  it('keeps the lenient rule: ASCII letters and digits, and a word of the reply', () => {
    expect(normalizeScormAnswer('C++')).toBe('c');
    expect(normalizeScormAnswer('Größe')).toBe('gre');
    expect(scormAnswerCandidates('not your legs')).toEqual(['not your legs', 'your', 'legs']);
    const legs = fillIn('legs');
    expect(legs.input).toBeUndefined();
    expect(questionIsRight('not legs', legs)).toBe(true);
  });

  it('checks the rule a stored input names, and takes it only for a typed text answer', () => {
    expect(() => checkStoredInput({ type: 'text', compare: 'fuzzy' } as unknown as ScormAnswerInput)).toThrow(QuestionError);
    expect(() => checkStoredInput({ type: 'choice', options: ['a', 'b'], compare: 'exact' })).toThrow(/only a text input compares/);
    expect(() => fillIn('x', { compare: 'loose' })).toThrow(/compare is exact or letters/);
    expect(() => authorQuestion({ question: 'Q?', answer: '42', compare: 'exact' }, 'seed')).toThrow(/only a typed text answer is compared/);
  });
});

describe('the page a package plays', () => {
  it('grades a reply the same way the bridge does', () => {
    const candidates = new Function(`${scormAssessmentScript()}\nreturn scormAnswerCandidates;`)() as (value: string, input?: ScormAnswerInput) => string[];
    for (const [reply, input] of [
      ['  C++ ', { type: 'text', compare: 'exact' }],
      ['Größe!', { type: 'text', compare: 'letters' }],
      [`cafe${u(0x301)}`, { type: 'text', compare: 'exact', caseSensitive: true }],
      ['not your legs', { type: 'text' }],
    ] as Array<[string, ScormAnswerInput]>) {
      expect(candidates(reply, input)).toEqual(scormAnswerCandidates(reply, input));
    }
  });
});
