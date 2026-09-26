/**
 * An authored answer that explains itself: `a team lead — the $250 would carry the customer past
 * the cap`. The key before the dash is what a reply is graded on. The generated cmi5 page grades
 * it by its content words, and says what the answer was and why once it is submitted. The SCORM
 * package, which grades by hash, holds the key rather than the whole sentence.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { explainedAnswer, matchesAnswerKey } from '../src/scorm-assessment.js';
import { composedScormCourse, generateAuHtml } from '../src/content-package.js';
import { hashScormAnswer } from '../src/scorm-artifacts.js';
import type { Course } from '../src/emergent-content.js';

const windows: JSDOM[] = [];
afterAll(() => { for (const d of windows) d.window.close(); });

describe('an explained answer', () => {
  it('is the key before a spaced dash, and why after it', () => {
    expect(explainedAnswer('a team lead — the $250 would carry the customer past the $1,000 cap')).toEqual({ key: 'a team lead', why: 'the $250 would carry the customer past the $1,000 cap' });
    expect(explainedAnswer('yes – a pattern is reviewed')).toEqual({ key: 'yes', why: 'a pattern is reviewed' });
    expect(explainedAnswer('the amount, the method, and the timing')).toEqual({ key: 'the amount, the method, and the timing', why: '' });
    expect(explainedAnswer('14-day window')).toEqual({ key: '14-day window', why: '' });
  });

  it('is given by a reply with every content word of the key, and not by one missing a word', () => {
    for (const reply of ['a team lead', 'team lead', 'The team lead.', 'it goes to the team lead']) expect(matchesAnswerKey(reply, 'a team lead')).toBe(true);
    for (const reply of ['lead', 'a manager', 'team leader', '']) expect(matchesAnswerKey(reply, 'a team lead')).toBe(false);
    expect(matchesAnswerKey('amount, method, timing', 'the amount, the method, and the timing')).toBe(true);
    expect(matchesAnswerKey('the amount and the method', 'the amount, the method, and the timing')).toBe(false);
    expect(matchesAnswerKey('policy window', 'the policy window')).toBe(true);
    expect(matchesAnswerKey('the window', 'the policy window')).toBe(false);
  });

  it('never lets an opposite answer through: a negation or a number is never dropped for being short', () => {
    // The automated review of #480: these three all used to pass.
    expect(matchesAnswerKey('escalate', 'do not escalate')).toBe(false);
    expect(matchesAnswerKey('fraud', 'no fraud')).toBe(false);
    expect(matchesAnswerKey('limit', 'the $250 limit')).toBe(false);
    // The right answers, in the words people use.
    expect(matchesAnswerKey('not escalate', 'do not escalate')).toBe(true);
    expect(matchesAnswerKey("Don't escalate it", 'do not escalate')).toBe(true);
    expect(matchesAnswerKey('no fraud found', 'no fraud')).toBe(true);
    expect(matchesAnswerKey('a $250 limit', 'the $250 limit')).toBe(true);
    // A reply that negates a key that does not is the opposite answer, whatever else it says.
    expect(matchesAnswerKey('not a team lead', 'a team lead')).toBe(false);
    expect(matchesAnswerKey('never the policy window', 'the policy window')).toBe(false);
    expect(matchesAnswerKey('without fraud', 'fraud')).toBe(false);
    expect(matchesAnswerKey('without a team lead', 'a team lead')).toBe(false);
    expect(matchesAnswerKey('proceed without escalating', 'proceed without escalating')).toBe(true);
    // A key that is itself a negation can be answered in more than one.
    expect(matchesAnswerKey('no, never', 'no')).toBe(true);
  });

  it('keeps the engine\'s own rule for a one-word key, and the numeric contract for a number', () => {
    expect(matchesAnswerKey('The answer is ALPHA!', 'alpha')).toBe(true);
    expect(matchesAnswerKey('wrong', 'alpha')).toBe(false);
    expect(matchesAnswerKey('Yes, escalate it', 'yes')).toBe(true);
    expect(matchesAnswerKey('no', 'yes')).toBe(false);
    expect(matchesAnswerKey('42', '42')).toBe(true);
    expect(matchesAnswerKey('42 days', '42')).toBe(false);
  });
});

describe('the pages and packages a course becomes', () => {
  async function submit(body: string, reply: string): Promise<{ statements: Array<{ verb: { id: string }; result?: { score?: { scaled: number }; success?: boolean } }>; feedback: string }> {
    const statements: Array<{ verb: { id: string }; result?: { score?: { scaled: number }; success?: boolean } }> = [];
    const html = generateAuHtml('Course', { id: 'explained', title: 'Explained', competency: 'Check', fragments: [{ modality: 'assessment-item', level: 'test', body }] });
    const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://foxxi.example/au?fetch=https://foxxi.example/token&endpoint=https://lrs.example/&activityId=https://course.example/explained', beforeParse(w) {
      Object.defineProperty(w, 'fetch', { value: async (url: string, init?: RequestInit) => {
        if (String(url).includes('/token')) return { ok: true, json: async () => ({ 'auth-token': 'test-token' }) };
        statements.push(JSON.parse(String(init?.body))); return { ok: true, status: 204 };
      } });
    } }); windows.push(dom);
    const button = dom.window.document.querySelector('button') as HTMLButtonElement;
    await expect.poll(() => button.disabled).toBe(false);
    (dom.window.document.querySelector('input') as HTMLInputElement).value = reply; button.click();
    await expect.poll(() => dom.window.document.querySelector('#status')!.textContent).toContain('Assessment submitted');
    return { statements, feedback: dom.window.document.querySelector('.feedback')?.textContent ?? '' };
  }

  it('pass a right reply to an explained question in the cmi5 page, and say why', async () => {
    const { statements, feedback } = await submit('Who authorises it? ::: a team lead — the $250 would carry the customer past the $1,000 cap', 'Team lead');
    expect(statements.find(s => s.verb.id.endsWith('/passed'))?.result).toMatchObject({ success: true, score: { scaled: 1 } });
    expect(feedback).toBe('Right. The $250 would carry the customer past the $1,000 cap');
  });

  it('fail a wrong reply, and show the answer and why', async () => {
    const { statements, feedback } = await submit('Who authorises it? ::: a team lead — the $250 would carry the customer past the $1,000 cap', 'a manager');
    expect(statements.find(s => s.verb.id.endsWith('/failed'))?.result).toMatchObject({ success: false, score: { scaled: 0 } });
    expect(feedback).toBe('The answer: a team lead. The $250 would carry the customer past the $1,000 cap');
  });

  it('hash the key in the SCORM package, not the explanation', () => {
    const course = { id: 'explained', title: 'Explained', competency: 'Check', syntagm: [{ paradigm: [{ id: 'module', title: 'Module', syntagm: [{ paradigm: [{ id: 'lesson', title: 'Lesson', competency: 'Check', syntagm: [{ paradigm: [{ modality: 'assessment-item', level: 'test', body: 'Do you escalate? ::: yes — a repeat-dispute pattern is reviewed' }] }] }] }] }] }] } as unknown as Course;
    const [q] = composedScormCourse(course).scos[0]!.assessment!;
    expect(q?.answerHash).toBe(hashScormAnswer('yes'));
  });
});
