import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { hashScormAnswer, scormArtifactZip, scormScoHtml } from '../applications/foxxi-content-intelligence/src/scorm-artifacts.js';
import { scormAnswerCandidates, validateScormResponses } from '../applications/foxxi-content-intelligence/src/scorm-assessment.js';
import { generateAuHtml } from '../applications/foxxi-content-intelligence/src/content-package.js';

const questions = [
  { question: 'Bottom-right index?', answerHash: hashScormAnswer('8'), input: { type: 'integer' as const, min: 0, max: 8 } },
  { question: 'Utility of an X win?', answerHash: hashScormAnswer('1'), input: { type: 'integer' as const, min: -1, max: 1 } },
];
const course = { courseId: 'validation-test', title: 'Validation', masteryScore: 1,
  scos: [{ id: 'representation', title: 'Representation', body: '[Native policy](https://policy.example/rules.ttl){rel="describedby" type="text/turtle"}\n\n[Job aid](https://aid.example/?format=markdown){rel="related" type="text/markdown"}', assessment: questions }] };
const rte = readFileSync(new URL('../deploy/foxxi-scorm-player/site/scorm-rte.js', import.meta.url), 'utf8');
const windows: JSDOM[] = [];
afterEach(() => { windows.splice(0).forEach(d => d.window.close()); });
function run(html = scormScoHtml(course, course.scos[0]!), rejectFlush = false) {
  const states: Record<string, unknown>[] = [], sent: Array<{ id: string; verb: { id: string } }> = [];
  const dom = new JSDOM(html, { url: 'https://lms.example/sco.html', runScripts: 'dangerously', beforeParse(w) {
    Object.defineProperties(w, { crypto: { value: webcrypto }, TextEncoder: { value: TextEncoder }, AbortSignal: { value: AbortSignal },
      __foxxiPlayerConfig: { value: { bridge: 'https://lrs.example', courseIri: 'https://course.example', learnerDid: 'did:web:test.example', registration: 'test' } },
      fetch: { value: async (_url: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return { ok: !rejectFlush, status: rejectFlush ? 503 : 204 }; } } });
    w.eval(rte);
    const host = w as unknown as { API_1484_11: { Commit(value: string): string }; __foxxiCmiSnapshot(): { cmi: Record<string, unknown> } };
    const commit = host.API_1484_11.Commit.bind(host.API_1484_11);
    host.API_1484_11.Commit = value => { states.push(JSON.parse(JSON.stringify(host.__foxxiCmiSnapshot().cmi))); return commit(value); };
  } }); windows.push(dom);
  return { dom, states, sent, accept: () => { rejectFlush = false; }, async submit(answers: string[]) {
    dom.window.document.querySelectorAll('input').forEach((input, i) => { input.value = answers[i] ?? ''; });
    dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await expect.poll(() => dom.window.document.getElementById('status')!.textContent).toMatch(/Recorded:|Could not finish|Check the highlighted/);
  } };
}

describe('delivered question form against the shipped SCORM runtime', () => {
  it('renders typed links with their relations and media types', () => {
    const s = run(); const links = s.dom.window.document.querySelectorAll('#body a');
    expect(links).toHaveLength(2); expect(links[0]!.getAttribute('href')).toBe('https://policy.example/rules.ttl');
    expect(links[0]!.getAttribute('rel')).toContain('describedby'); expect(links[0]!.getAttribute('type')).toBe('text/turtle');
    expect(s.dom.window.document.getElementById('body')!.textContent).not.toContain('{rel=');
  });
  it('keeps scripts, HTML and unsafe link protocols inert', () => {
    const c = { ...course, scos: [{ ...course.scos[0]!, body: '</script><script>window.pwned=true</script>\n[bad](javascript:alert%281%29)\n[bad](data:text/html,hello)' }] };
    const s = run(scormScoHtml(c, c.scos[0]!));
    expect(s.dom.window.document.querySelectorAll('#body a')).toHaveLength(0);
    expect((s.dom.window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    expect(s.dom.window.document.getElementById('body')!.textContent).toContain('</script>');
  });
  it.each([['', ''], [' ', '1'], ['8.5', '1'], ['8x', '1'], ['9', '1'], ['8', '5'], ['8', 'Infinity']])('rejects invalid %s / %s before scoring', async (a, b) => {
    const s = run(); await s.submit([a!, b!]);
    expect(s.states).toEqual([]); expect(s.dom.window.document.querySelector('[aria-invalid="true"]')).not.toBeNull();
    expect(s.dom.window.document.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
    expect(s.sent.some(statement => /passed|failed|completed/.test(statement.verb.id))).toBe(false);
  });
  it.each([['4', '0', 0, 'failed'], ['8', '-1', 0.5, 'failed'], ['8', '1', 1, 'passed']])('records %s / %s as %s and %s, with question-level responses', async (a, b, score, success) => {
    const zip = new AdmZip(scormArtifactZip(course)), s = run(zip.readAsText('sco-representation.html'));
    await s.submit([String(a), String(b)]);
    expect(s.states).toHaveLength(1); expect(s.states[0]).toMatchObject({ 'score.scaled': String(score), 'score.raw': String(Number(score) * 2), 'score.min': '0', 'score.max': '2', success_status: success, completion_status: 'completed' });
    const interactions = s.states[0]!.interactions as Array<Record<string, string>>;
    expect(interactions.map(i => i.learner_response)).toEqual([String(a), String(b)]);
    expect(interactions[1]!.result).toBe(b === '1' ? 'correct' : 'incorrect');
    expect(s.dom.window.document.querySelectorAll('.feedback.correct')).toHaveLength(Number(score) * 2);
    expect([...s.dom.window.document.querySelectorAll('input')].every(input => input.disabled)).toBe(true);
    expect(s.dom.window.document.getElementById('status')!.textContent).toContain('Passing score: 100%');
  });
  it('retains the graded answer set and statement IDs across an LRS delivery retry', async () => {
    const s = run(undefined, true); await s.submit(['4', '0']);
    expect(s.dom.window.document.getElementById('status')!.textContent).toContain('Could not finish recording');
    expect(s.dom.window.document.querySelector('button')!.textContent).toBe('Retry recording');
    const firstId = s.sent[0]!.id; s.accept(); await s.submit(['8', '1']);
    expect(s.states).toHaveLength(1); expect(s.states[0]!['score.scaled']).toBe('0');
    expect(s.dom.window.document.getElementById('status')!.textContent).toContain('0/2 correct');
    expect(s.sent[1]!.id).toBe(firstId);
  });
});

describe('shared native and exported answer rules', () => {
  it('never collapses a sign, decimal or numeric punctuation into the expected answer', () => {
    expect(hashScormAnswer('-1')).not.toBe(hashScormAnswer('1'));
    expect(hashScormAnswer('1.0')).not.toBe(hashScormAnswer('10'));
    expect(hashScormAnswer('1+2')).not.toBe(hashScormAnswer('12'));
    expect(hashScormAnswer('+01', { type: 'integer' })).toBe(hashScormAnswer('1'));
    expect(scormAnswerCandidates('The answer is ALPHA!')).toContain('alpha');
  });
  it('rejects missing, extra and non-string native answers without advancing a session', () => {
    for (const answers of [undefined, ['8'], ['8', '1', '0'], ['8', 1], ['8', '1.5']]) expect(validateScormResponses(questions, answers).length).toBeGreaterThan(0);
    expect(validateScormResponses(questions, ['8', '-1'])).toEqual([]);
  });
  it('rejects impossible authored input constraints', () => {
    expect(() => scormArtifactZip({ ...course, scos: [{ ...course.scos[0]!, assessment: [{ ...questions[0]!, input: { type: 'integer', min: 8, max: 0 } }] }] })).toThrow(/minimum/);
  });
  it('the cmi5 export uses the same signed-number grading rule', async () => {
    const sent: Array<{ verb: { id: string }; result?: { success?: boolean } }> = [];
    const html = generateAuHtml('Numbers', { id: 'numbers', title: 'Numbers', competency: 'Signed values', fragments: [{ modality: 'assessment-item', level: 'test', body: 'Value? ::: 1' }] });
    const dom = new JSDOM(html, { url: 'https://lms.example/?fetch=https://lrs.example/token&endpoint=https://lrs.example/&actor=%7B%7D&registration=test', runScripts: 'dangerously', beforeParse(w) {
      Object.defineProperties(w, { crypto: { value: webcrypto }, fetch: { value: async (_url: string, init: { body?: string }) => { if (init.body) sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ 'auth-token': 'test' }) }; } } });
    } }); windows.push(dom);
    await expect.poll(() => dom.window.document.querySelector<HTMLButtonElement>('#go')!.disabled).toBe(false);
    dom.window.document.querySelector<HTMLInputElement>('.answer')!.value = '-1'; dom.window.document.querySelector<HTMLButtonElement>('#go')!.click();
    await expect.poll(() => sent.find(statement => statement.verb.id.endsWith('/failed'))?.result?.success).toBe(false);
    await expect.poll(() => dom.window.document.getElementById('status')!.textContent).toContain('Statements sent to the LRS');
  });
});
