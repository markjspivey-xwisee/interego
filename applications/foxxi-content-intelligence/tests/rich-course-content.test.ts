/**
 * An agent-authored course can be as rich as its readers can take: sections in Markdown, and
 * questions in the xAPI interaction types (fill-in, numeric, choice, true-false, sequencing,
 * matching, likert, long-fill-in), each graded exactly against a verifier rather than by
 * matching one typed word. The same stored question drives the live engine, the LTI pages and
 * the SCORM package, and records as its own interaction type there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { courseMarkdownHtml } from '../src/course-markdown.js';
import { authorQuestion, questionForLearner, questionIsRight } from '../src/course-questions.js';
import { hashScormAnswer, scormScoHtml } from '../src/scorm-artifacts.js';
import { scormAssessmentScript, type ScormAnswerInput } from '../src/scorm-assessment.js';
import { answersFrom, renderScoPage, type LearnerQuestion } from '../src/lti-player.js';

const seed = (i: number) => `rich-course\nSCO-1\n${i}`;
const letter = (i: number) => String.fromCharCode(65 + i);

describe('a section is Markdown, rendered safely', () => {
  it('shows a character a backslash escapes as it is, never as syntax and never as a tag', () => {
    const B = String.fromCharCode(92);
    expect(courseMarkdownHtml(`${B}- item? no`)).toBe('<p>- item? no</p>');
    expect(courseMarkdownHtml(`1${B}. step? no`)).toBe('<p>1. step? no</p>');
    expect(courseMarkdownHtml(`${B}# heading? no`)).toBe('<p># heading? no</p>');
    expect(courseMarkdownHtml(`${B}> quote? no`)).toBe('<p>&gt; quote? no</p>');
    // An escaped asterisk neither opens nor closes emphasis.
    expect(courseMarkdownHtml(`${B}*kept${B}* and *em ${B}* inside*`)).toBe('<p>*kept* and <em>em * inside</em></p>');
    // A held character goes back escaped: text, never markup.
    expect(courseMarkdownHtml(`${B}<script${B}>alert(1)${B}</script${B}>`)).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(courseMarkdownHtml(`[a ${B}] b](https://example.org/x${B}_y)`)).toContain('<a href="https://example.org/x_y" rel="related noopener noreferrer" target="_blank">a ] b</a>');
    // Code shows what it holds as written; a backslash before a letter is no escape.
    expect(courseMarkdownHtml('`a ' + B + '* b`')).toBe(`<p><code>a ${B}* b</code></p>`);
    expect(courseMarkdownHtml(`C:${B}Users${B}file`)).toBe(`<p>C:${B}Users${B}file</p>`);
  });

  it('renders what an author writes: headings, lists, tables, code, quotes, images and links', () => {
    const html = courseMarkdownHtml([
      '# Refund authority', '', 'Agents refund **up to $250**; a *team lead* approves more.', 'Same paragraph, new line.', '',
      '- first `code`', '- [policy](https://policy.example/p){rel="cite" type="text/html"}', '', '2. second step', '3. third step', '',
      '| Tier | Limit |', '|:--|--:|', '| Agent | $250 |', '', '> **Tip:** check the window.', '', '```json', '{"refund": 250}', '```', '',
      '![chart](https://img.example/c.png)', '', '2 * 3 * 4 and snake_case_name stay plain.',
    ].join('\n'));
    expect(html).toContain('<h2>Refund authority</h2>');
    expect(html).toContain('<strong>up to $250</strong>');
    expect(html).toContain('<em>team lead</em> approves more.<br>Same paragraph, new line.');
    expect(html).toContain('<ul><li>first <code>code</code></li>');
    expect(html).toContain('<a href="https://policy.example/p" rel="cite noopener noreferrer" target="_blank" type="text/html">policy</a>');
    expect(html).toContain('<ol start="2"><li>second step</li><li>third step</li></ol>');
    expect(html).toContain('<th style="text-align:left">Tier</th><th style="text-align:right">Limit</th>');
    expect(html).toContain('<blockquote><p><strong>Tip:</strong> check the window.</p></blockquote>');
    expect(html).toContain('<pre><code class="language-json">{&quot;refund&quot;: 250}</code></pre>');
    expect(html).toContain('<img src="https://img.example/c.png" alt="chart" loading="lazy">');
    expect(html).toContain('2 * 3 * 4 and snake_case_name stay plain.');
    // A delimiter row only makes a table under a header of as many cells, as in GFM.
    expect(courseMarkdownHtml('a | b | c\n|---|---|')).toBe('<p>a | b | c<br>|---|---|</p>');
  });

  it('keeps anything that is not Markdown inert: HTML, script, unsafe URLs, attribute breakouts', () => {
    const html = courseMarkdownHtml([
      '<script>alert(1)</script><img src=x onerror=alert(1)>', '[x](javascript:alert(1)) [y](data:text/html,hi) [z](https://u:p@h.example/)',
      '![alt" onerror="alert(1)](https://img.example/a.png)', '[t" onmouseover="x](https://ok.example/)', '```<script>', '</script>', '```',
    ].join('\n'));
    const dom = new JSDOM(`<body>${html}</body>`);
    expect(dom.window.document.querySelectorAll('script')).toHaveLength(0);
    expect(dom.window.document.querySelectorAll('a')).toHaveLength(1); // only the https link with a quote in its text
    expect(dom.window.document.querySelector('a')!.getAttribute('href')).toBe('https://ok.example/');
    for (const el of dom.window.document.querySelectorAll('*')) for (const attr of [...el.attributes]) expect(attr.name.startsWith('on')).toBe(false);
    expect(dom.window.document.querySelector('img')!.getAttribute('alt')).toBe('alt" onerror="alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('each question type is authored into a stored form and graded exactly', () => {
  it('fill-in keeps the old one-word rule and takes other accepted answers', () => {
    const q = authorQuestion({ question: 'Who approves over $250?', answer: 'team lead', accept: ['the team lead', 'lead'] }, seed(0));
    expect(q.answerHash).toBe(hashScormAnswer('team lead'));
    for (const r of ['team lead', 'The team lead.', 'lead']) expect(questionIsRight(r, q)).toBe(true);
    for (const r of ['manager', 'team']) expect(questionIsRight(r, q)).toBe(false);
    expect(JSON.stringify(q)).not.toMatch(/team lead|lead"/i);
  });

  it('numeric keeps its contract, and a typed input with a plain answer still authors', () => {
    const q = authorQuestion({ question: 'Cap?', type: 'numeric', answer: 1000, min: 0 }, seed(1));
    expect(q.input).toEqual({ type: 'integer', min: 0 });
    expect(questionIsRight('1000', q)).toBe(true);
    expect(questionIsRight('999', q)).toBe(false);
    const legacy = authorQuestion({ question: 'Index?', answer: '8', input: { type: 'integer', min: 0, max: 8 } }, seed(2));
    expect(legacy.answerHash).toBe(hashScormAnswer('8', { type: 'integer' }));
  });

  it('keeps a named fill-in as text, even when its answer reads as a number', () => {
    const code = authorQuestion({ question: 'Account code?', type: 'fill-in', answer: '0012', accept: ['twelve'] }, seed(40));
    expect(code.input).toBeUndefined();
    expect(code.answerHash).toBe(hashScormAnswer('0012'));
    expect([questionIsRight('0012', code), questionIsRight('twelve', code), questionIsRight('12', code)]).toEqual([true, true, false]);
    // Unnamed, a number-like answer is still graded as a number, as authors have always written it.
    const unnamed = authorQuestion({ question: 'How many?', answer: '8' }, seed(41));
    expect(unnamed.input).toEqual({ type: 'integer' });
    expect(unnamed.answerHash).toBe(hashScormAnswer('8', { type: 'integer' }));
    expect(questionIsRight('08', unnamed)).toBe(true);
    expect(() => authorQuestion({ question: 'Code?', type: 'fill-in', answer: '5', min: 0 }, seed(42))).toThrow(/only to a numeric question/);
    // A named type and an explicit input must agree; neither silently wins.
    expect(() => authorQuestion({ question: 'Code?', type: 'fill-in', answer: '0012', input: { type: 'integer' } }, seed(43))).toThrow(/type fill-in and input type integer disagree/);
    expect(() => authorQuestion({ question: 'Cap?', type: 'numeric', answer: '8', input: { type: 'text' } }, seed(44))).toThrow(/disagree/);
    expect(() => authorQuestion({ question: 'Pick', type: 'choice', answer: 'A', input: { type: 'text' } }, seed(45))).toThrow(/disagree/);
    const agreed = authorQuestion({ question: 'Code?', type: 'fill-in', answer: '0012', input: { type: 'text' } }, seed(46));
    expect([questionIsRight('0012', agreed), questionIsRight('12', agreed)]).toEqual([true, false]);
    expect(authorQuestion({ question: 'Cap?', type: 'numeric', answer: '8', input: { type: 'integer', min: 0 } }, seed(47)).input).toEqual({ type: 'integer', min: 0 });
  });

  it('grades letter case only where a question says it counts, and keeps every other verifier as it was', () => {
    const q = authorQuestion({ question: 'Capital of France?', type: 'fill-in', answer: 'Paris', accept: ['Paree'], caseSensitive: true }, seed(48));
    expect(q.input).toEqual({ type: 'text', caseSensitive: true });
    expect(['Paris', 'paris', 'Paree', 'The capital is Paris.'].map(r => questionIsRight(r, q))).toEqual([true, false, true, true]);
    // Without it, as before: the same verifier, and letter case is not read.
    const plain = authorQuestion({ question: 'Capital of France?', type: 'fill-in', answer: 'Paris' }, seed(49));
    expect(plain.input).toBeUndefined();
    expect(plain.answerHash).toBe(hashScormAnswer('paris'));
    expect(questionIsRight('PARIS', plain)).toBe(true);
    // An explicit text input keeps it; a number has no letter case to count.
    expect(authorQuestion({ question: 'Code?', answer: 'AbC', input: { type: 'text', caseSensitive: true } }, seed(50)).input).toEqual({ type: 'text', caseSensitive: true });
    expect(() => authorQuestion({ question: 'Cap?', type: 'numeric', answer: 8, caseSensitive: true }, seed(51))).toThrow(/only a typed text answer/);
    expect(() => authorQuestion({ question: 'Cap?', answer: '8', input: { type: 'integer' }, caseSensitive: true }, seed(52))).toThrow(/only a typed text answer/);
    expect(() => authorQuestion({ question: 'Cap?', answerHash: 'a'.repeat(64), input: { type: 'integer', caseSensitive: true } }, seed(53))).toThrow(/only a text input can be case-sensitive/);
  });

  it('grades letter case the same way in a page, whose script is the engine\'s own source', () => {
    const candidates = new Function(`${scormAssessmentScript()}\nreturn scormAnswerCandidates;`)() as (value: string, input?: ScormAnswerInput) => string[];
    expect(candidates('Paris', { type: 'text', caseSensitive: true })[0]).toBe('Paris');
    expect(candidates('Paris')[0]).toBe('paris');
  });

  it('choice takes a letter or the option text, one right or several, and keeps no answer in plaintext', () => {
    const one = authorQuestion({ question: 'Who approves?', options: ['Agent', 'Team lead', 'Manager'], answer: 'B', explanation: 'Leads approve over $250.' }, seed(3));
    expect(one.input).toMatchObject({ type: 'choice', options: ['Agent', 'Team lead', 'Manager'] });
    expect(questionIsRight('B', one)).toBe(true);
    expect(questionIsRight('team lead', one)).toBe(true);
    expect(questionIsRight('A', one)).toBe(false);
    const many = authorQuestion({ question: 'Refundable?', options: ['Fees', 'Duplicates', 'Fraud', 'Returns'], answer: ['Duplicates', 'D'] }, seed(4));
    expect(many.input?.multiple).toBe(true);
    for (const r of ['B, D', 'd b', 'Duplicates; Returns']) expect(questionIsRight(r, many)).toBe(true);
    for (const r of ['B', 'B, C, D']) expect(questionIsRight(r, many)).toBe(false);
  });

  it('true-false, sequencing and matching grade what the author meant, whatever order they are shown in', () => {
    const tf = authorQuestion({ question: 'Refunds need a reason.', answer: true }, seed(5));
    expect([questionIsRight('true', tf), questionIsRight('yes', tf), questionIsRight('false', tf)]).toEqual([true, true, false]);

    const inOrder = ['Verify', 'Refund', 'Log'];
    const seq = authorQuestion({ question: 'Order the steps', type: 'ordering', items: inOrder }, seed(6));
    const shown = seq.input!.items!;
    expect([...shown].sort()).toEqual([...inOrder].sort());
    expect(shown).not.toEqual(inOrder); // shown shuffled, never already in order
    expect(questionIsRight(inOrder.map((it) => letter(shown.indexOf(it))).join(', '), seq)).toBe(true);
    expect(questionIsRight(shown.map((_, k) => letter(k)).join(', '), seq)).toBe(false);

    const pairs: [string, string][] = [['$100', 'Agent'], ['$600', 'Team lead'], ['$5,000', 'Manager']];
    const match = authorQuestion({ question: 'Who approves each?', pairs, distractors: ['Nobody'] }, seed(7));
    const targets = match.input!.targets!;
    expect(targets).toHaveLength(4);
    expect(match.input!.items).toEqual(['$100', '$600', '$5,000']);
    expect(questionIsRight(pairs.map((p) => letter(targets.indexOf(p[1]))).join(', '), match)).toBe(true);
    expect(questionIsRight(pairs.map(() => 'A').join(', '), match)).toBe(false);
  });

  it('likert and long-fill-in are recorded, not graded', () => {
    const likert = authorQuestion({ question: 'Confident?', type: 'likert' }, seed(8));
    const essay = authorQuestion({ question: 'What will you do differently?', type: 'essay' }, seed(9));
    expect(likert.answerHash).toBeUndefined();
    expect(likert.input?.options).toHaveLength(5);
    expect(questionIsRight('C', likert)).toBeNull();
    expect(questionIsRight('I will check the rolling window first.', essay)).toBeNull();
  });

  it('shows a learner what to choose from, never the verifier, salt or explanation', () => {
    const q = authorQuestion({ question: 'Who approves?', options: ['Agent', 'Team lead'], answer: 'B', explanation: 'why' }, seed(10));
    const view = questionForLearner(q, 0);
    expect(view).toEqual({ index: 0, question: 'Who approves?', type: 'choice', input: { type: 'choice', options: ['Agent', 'Team lead'] }, graded: true });
    expect(q.input!.salt).toMatch(/^[0-9a-f]{16}$/);
  });

  it('authors the same course the same way, and salts each question apart', () => {
    const raw = { question: 'Order', items: ['a', 'b', 'c', 'd'] };
    expect(authorQuestion(raw, seed(11))).toEqual(authorQuestion(raw, seed(11)));
    const a = authorQuestion({ question: 'T?', answer: true }, seed(12));
    const b = authorQuestion({ question: 'T?', answer: true }, seed(13));
    expect(a.answerHash).not.toBe(b.answerHash);
  });

  it('refuses what it cannot grade, saying what to fix', () => {
    expect(() => authorQuestion({ question: 'x', options: ['a'], answer: 'A' }, seed(14))).toThrow(/options needs 2 to 26/);
    expect(() => authorQuestion({ question: 'x', options: ['a', 'b'], answer: 'C' }, seed(15))).toThrow(/neither an option's letter nor its exact text/);
    expect(() => authorQuestion({ question: 'x', options: ['a', 'A'], answer: 'A' }, seed(16))).toThrow(/twice/);
    expect(() => authorQuestion({ question: 'x', type: 'weird' }, seed(17))).toThrow(/type must be one of/);
    expect(() => authorQuestion({ question: 'x', pairs: [['a', 'same'], ['b', 'Same']] }, seed(19))).toThrow(/two different answers/);
    expect(() => authorQuestion({ question: 'x', answer: true, type: 'true-false', input: { type: 'choice' } }, seed(18))).toThrow();
  });
});

const rte = readFileSync(new URL('../../../deploy/foxxi-scorm-player/site/scorm-rte.js', import.meta.url), 'utf8');
const windows: JSDOM[] = [];
afterEach(() => { windows.splice(0).forEach((d) => d.window.close()); });

describe('the SCORM package asks each type with its own control and records it as that interaction', () => {
  const asked = [
    authorQuestion({ question: 'Who approves?', options: ['Agent', 'Team lead', 'Manager'], answer: 'B', explanation: 'Leads approve over $250.' }, seed(20)),
    authorQuestion({ question: 'Refundable?', options: ['Fees', 'Duplicates', 'Fraud'], answer: ['A', 'B'] }, seed(21)),
    authorQuestion({ question: 'Refunds need a reason.', answer: false }, seed(22)),
    authorQuestion({ question: 'Order the steps', items: ['Verify', 'Refund', 'Log'] }, seed(23)),
    authorQuestion({ question: 'Who approves each?', pairs: [['$100', 'Agent'], ['$600', 'Team lead']] }, seed(24)),
    authorQuestion({ question: 'Confident?', type: 'likert', scale: ['No', 'Somewhat', 'Yes'] }, seed(25)),
    authorQuestion({ question: 'Reflect.', type: 'long-fill-in' }, seed(26)),
  ];
  const course = { courseId: 'rich-course', title: 'Rich', masteryScore: 0.6, scos: [{ id: 'SCO-1', title: 'Authority', body: '# Limits\n\n- Agent: **$250**\n- Lead: $1,000', assessment: asked }] };

  it('grades the graded ones, records the rest as neutral, and shows why', async () => {
    const states: Array<Record<string, unknown>> = [];
    const dom = new JSDOM(scormScoHtml(course, course.scos[0]!), { url: 'https://lms.example/sco.html', runScripts: 'dangerously', beforeParse(w) {
      Object.defineProperties(w, { crypto: { value: webcrypto }, TextEncoder: { value: TextEncoder }, AbortSignal: { value: AbortSignal },
        __foxxiPlayerConfig: { value: { bridge: 'https://lrs.example', courseIri: 'https://course.example', learnerDid: 'did:web:test.example', registration: 'test' } },
        fetch: { value: async () => ({ ok: true, status: 204 }) } });
      w.eval(rte);
      const host = w as unknown as { API_1484_11: { Commit(value: string): string }; __foxxiCmiSnapshot(): { cmi: Record<string, unknown> } };
      const commit = host.API_1484_11.Commit.bind(host.API_1484_11);
      host.API_1484_11.Commit = (value) => { states.push(JSON.parse(JSON.stringify(host.__foxxiCmiSnapshot().cmi))); return commit(value); };
    } });
    windows.push(dom);
    const doc = dom.window.document;
    expect(doc.querySelector('#body h2')!.textContent).toBe('Limits');
    expect(doc.querySelectorAll('input[name="answer-0"][type=radio]')).toHaveLength(3);
    expect(doc.querySelectorAll('input[name="answer-1"][type=checkbox]')).toHaveLength(3);
    expect(doc.querySelectorAll('select[name^="answer-3-"]')).toHaveLength(3);
    expect(doc.querySelectorAll('select[name^="answer-4-"]')).toHaveLength(2);
    expect(doc.querySelector('textarea[name="answer-6"]')).not.toBeNull();

    const check = (name: string, value: string) => { (doc.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement).checked = true; };
    check('answer-0', 'B');                    // right
    check('answer-1', 'A');                    // wrong: B is also right
    check('answer-2', 'false');                // right
    const seqShown = asked[3]!.input!.items!;
    ['Verify', 'Refund', 'Log'].forEach((it, k) => { (doc.querySelector(`select[name="answer-3-${k}"]`) as HTMLSelectElement).value = letter(seqShown.indexOf(it)); });
    const targets = asked[4]!.input!.targets!;
    (doc.querySelector('select[name="answer-4-0"]') as HTMLSelectElement).value = letter(targets.indexOf('Agent'));
    (doc.querySelector('select[name="answer-4-1"]') as HTMLSelectElement).value = letter(targets.indexOf('Team lead'));
    check('answer-5', 'C');
    (doc.querySelector('textarea[name="answer-6"]') as HTMLTextAreaElement).value = 'Check the window first.';
    doc.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await expect.poll(() => doc.getElementById('status')!.textContent).toMatch(/Recorded:|Could not finish|Check the highlighted/);

    expect(doc.getElementById('status')!.textContent).toContain('4/5 correct (80%)');
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ 'score.raw': '4', 'score.max': '5', 'score.scaled': '0.8', success_status: 'passed', completion_status: 'completed' });
    const interactions = states[0]!.interactions as Array<Record<string, string>>;
    expect(interactions.map((i) => i.type)).toEqual(['choice', 'choice', 'true-false', 'sequencing', 'matching', 'likert', 'long-fill-in']);
    expect(interactions.map((i) => i.result)).toEqual(['correct', 'incorrect', 'correct', 'correct', 'correct', 'neutral', 'neutral']);
    expect(interactions[0]!.learner_response).toBe('b');
    expect(interactions[2]!.learner_response).toBe('false');
    expect(interactions[3]!.learner_response).toMatch(/^[a-c]\[,\][a-c]\[,\][a-c]$/);
    expect(interactions[4]!.learner_response).toMatch(/^1\[\.\][a-b]\[,\]2\[\.\][a-b]$/);
    expect(interactions[6]!.learner_response).toBe('Check the window first.');
    expect(doc.querySelector('.explanation')!.textContent).toBe('Leads approve over $250.');
  });

  it('refuses an incomplete ordering before anything is recorded', async () => {
    const states: unknown[] = [];
    const dom = new JSDOM(scormScoHtml(course, course.scos[0]!), { url: 'https://lms.example/sco.html', runScripts: 'dangerously', beforeParse(w) {
      Object.defineProperties(w, { crypto: { value: webcrypto }, TextEncoder: { value: TextEncoder }, AbortSignal: { value: AbortSignal },
        __foxxiPlayerConfig: { value: { bridge: 'https://lrs.example', courseIri: 'https://course.example', learnerDid: 'did:web:test.example', registration: 'test' } },
        fetch: { value: async () => ({ ok: true, status: 204 }) } });
      w.eval(rte);
      const host = w as unknown as { API_1484_11: { Commit(value: string): string } };
      const commit = host.API_1484_11.Commit.bind(host.API_1484_11);
      host.API_1484_11.Commit = (value) => { states.push(value); return commit(value); };
    } });
    windows.push(dom);
    dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await expect.poll(() => dom.window.document.getElementById('status')!.textContent).toMatch(/Check the highlighted/);
    expect(states).toEqual([]);
    expect(dom.window.document.querySelectorAll('fieldset[aria-invalid="true"]').length).toBe(7);
  });
});

describe('the LTI pages ask each type without script, and read the form back into one reply each', () => {
  const qs: LearnerQuestion[] = [
    questionForLearner(authorQuestion({ question: 'Who?', options: ['Agent', 'Lead'], answer: 'B' }, seed(30)), 0),
    questionForLearner(authorQuestion({ question: 'Which?', options: ['a', 'b', 'c'], answer: ['A', 'C'] }, seed(31)), 1),
    questionForLearner(authorQuestion({ question: 'Order', items: ['x', 'y', 'z'] }, seed(32)), 2),
    questionForLearner(authorQuestion({ question: 'Say more', type: 'essay' }, seed(33)), 3),
  ];

  it('renders radios, checkboxes, a row of selects and a text area, and the body as Markdown', () => {
    const html = renderScoPage({ courseTitle: 'C', sco: { id: 'S', title: 'T', body: '## Heading\n\n**bold**', assessment: qs } });
    expect(html).toContain('<h3>Heading</h3>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('type="radio" name="answer_0" value="B" required');
    expect(html).toContain('type="checkbox" name="answer_1" value="C"');
    expect(html).toContain('<select name="answer_2_2" required>');
    expect(html).toContain('<textarea name="answer_3" maxlength="4000" required>');
  });

  it('joins ticked boxes and a row of selects, and leaves a half-chosen row empty', () => {
    expect(answersFrom({ answer_0: 'B', answer_1: ['A', 'C'], answer_2_0: 'B', answer_2_1: 'C', answer_2_2: 'A', answer_3: 'text' }, qs)).toEqual(['B', 'A, C', 'B, C, A', 'text']);
    expect(answersFrom({ answer_0: 'B', answer_1: 'A', answer_2_0: 'B', answer_2_1: '', answer_3: 'x' }, qs)).toEqual(['B', 'A', '', 'x']);
  });
});

describe('the bridge wires the stored form through authoring, the learner view and grading', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  it('authors each question through authorQuestion, within the course limits', () => {
    const author = src.slice(src.indexOf("app.post('/agent/scorm/author'"), src.indexOf("app.post('/agent/scorm/launch'"));
    expect(author).toContain('authorQuestion(q, `${String(c.courseId)}\\n${String(s.id)}\\n${qi}`)');
    expect(author).toMatch(/c\.scos\.length > COURSE_LIMITS\.sections/);
    expect(author).toMatch(/body\.length > COURSE_LIMITS\.body/);
    expect(author).toMatch(/asked\.length > COURSE_LIMITS\.questions/);
  });
  it('shows the learner view and grades with questionIsRight, over the graded questions only', () => {
    expect(src).toMatch(/assessment: sco\.assessment\.map\(\(q, i\) => questionForLearner\(q, i\)\)/);
    expect(src).toMatch(/bodyHtml: courseMarkdownHtml\(sco\.body\)/);
    expect(src).toMatch(/const ok = questionIsRight\(raw, item\);/);
    expect(src).toMatch(/const score = correct \/ gradedCount;/);
  });
});
