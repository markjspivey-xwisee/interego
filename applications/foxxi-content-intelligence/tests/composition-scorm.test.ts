/**
 * A composition projected as a SCORM 2004 package: one SCO, a wrapper that frames the bridge's
 * player and records what the bridge posts it through the LMS's SCORM API. The package holds no
 * content and no answers, the wrapper believes only the bridge's origin, and the player, under
 * SCORM, posts only to its wrapper.
 */
import { afterAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { currentView, startPlay, takeStep, type CompositionPlay, type PlayInProgress, type Statement } from '../src/composition-play.js';
import { compositionAuPage } from '../src/composition-au-page.js';
import { attemptStatements, closingStatements, cmi5AttemptFrom, definedStatement, type Cmi5Attempt } from '../src/composition-cmi5.js';
import { compositionScormManifest, compositionScormWrapper, compositionScormZip, scoIdOf } from '../src/composition-scorm.js';
import { compositionFrom, resolveComposition, type Composition } from '../src/compositions.js';
import { fragmentFrom, type Fragment } from '../src/content-fragments.js';
import { parseManifest } from '../src/scorm-sequencing.js';

const lesson = fragmentFrom({ kind: 'concept', competencies: ['refund-authority'], title: 'Who approves', body: 'Agents refund up to $250.' });
const check = fragmentFrom({
  kind: 'assessment-item', competencies: ['refund-authority'], title: 'Check', body: 'Check yourself.',
  questions: [{ question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B', explanation: 'Leads approve above $250.' }, { question: 'Refunds are logged.', answer: true }],
});
const course = compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [
  { competency: 'refund-authority', paradigm: [lesson['@id']] },
  { competency: 'refund-authority', paradigm: [check['@id']] },
] });
const store = new Map<string, Fragment | Composition>([lesson, check, course].map(x => [x['@id'], x]));
const player = 'https://bridge.example/ns/foxxi/composition/abc/au';
const windows: JSDOM[] = [];
afterAll(() => { for (const w of windows) w.window.close(); });

describe('the package', () => {
  const zip = new AdmZip(compositionScormZip(course, player));

  it('is one SCO, the wrapper, that any SCORM 2004 system can import', () => {
    expect(zip.getEntries().map(e => e.entryName).sort()).toEqual(['README.txt', 'imsmanifest.xml', 'index.html']);
    const tree = parseManifest(zip.readAsText('imsmanifest.xml'));
    expect(tree.courseTitle).toBe('Refunds');
    expect(tree.preorder.filter(a => a.href)).toHaveLength(1);
    expect(tree.preorder.find(a => a.href)!.href).toBe('index.html');
    expect(zip.readAsText('imsmanifest.xml')).toBe(compositionScormManifest(course));
  });

  it('holds no content and no answers, and is the same bytes each time it is built', () => {
    const everything = zip.getEntries().map(e => e.getData().toString('utf8')).join('\n');
    for (const secret of ['answerHash', 'acceptHashes', 'salt', 'blind', 'Leads approve', 'Who approves $600?', 'Agents refund up to']) expect(everything).not.toContain(secret);
    expect(compositionScormZip(course, player).equals(compositionScormZip(course, player))).toBe(true);
  });
});

describe('the wrapper, inside an LMS', () => {
  function lms(passingScore = '') {
    const calls: Array<[string, ...string[]]> = [];
    const values = new Map<string, string>([['cmi.learner_id', 'learner-7'], ['cmi.interactions._count', '0'], ['cmi.scaled_passing_score', passingScore]]);
    const API = {
      Initialize: (a: string) => { calls.push(['Initialize', a]); return 'true'; },
      GetValue: (k: string) => values.get(k) ?? '',
      SetValue: (k: string, v: string) => { calls.push(['SetValue', k, v]); values.set(k, v); return 'true'; },
      Commit: (a: string) => { calls.push(['Commit', a]); return 'true'; },
      Terminate: (a: string) => { calls.push(['Terminate', a]); return 'true'; },
      GetLastError: () => '0',
    };
    const dom = new JSDOM(compositionScormWrapper({ title: course.title, playerUrl: player, activityId: scoIdOf(course['@id']) }), {
      runScripts: 'dangerously', url: 'https://lms.example/content/pkg/index.html',
      beforeParse(w) { Object.defineProperty(w, 'API_1484_11', { value: API }); },
    });
    windows.push(dom);
    const post = (data: unknown, origin = 'https://bridge.example') => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, origin }));
    return { dom, calls, values, post };
  }
  const answered = (n: number, success?: boolean, type = 'choice'): Statement => ({
    id: randomUUID(), verb: { id: 'http://adlnet.gov/expapi/verbs/answered' },
    object: { id: `${check['@id']}#question-${n}`, definition: { interactionType: type, description: { en: `Question ${n}` } } },
    result: { response: 'b', completion: true, ...(success === undefined ? {} : { success }) },
  });

  it('opens the player for the LMS\'s learner, telling it where to post', () => {
    const { dom, calls } = lms();
    expect(calls[0]).toEqual(['Initialize', '']);
    const src = new URL((dom.window.document.querySelector('iframe') as HTMLIFrameElement).src);
    expect(src.origin + src.pathname).toBe(player);
    expect(src.searchParams.get('transport')).toBe('scorm');
    expect(src.searchParams.get('parentOrigin')).toBe('https://lms.example');
    expect(src.searchParams.get('activityId')).toBe(scoIdOf(course['@id']));
    expect(JSON.parse(src.searchParams.get('actor')!)).toEqual({ objectType: 'Agent', account: { homePage: 'https://lms.example', name: 'learner-7' } });
  });

  it('records each answer as an interaction, and the score, success and completion when the play ends', () => {
    const { calls, values, post } = lms();
    post({ type: 'foxxi.scorm', statements: [answered(1, true), answered(2, false, 'true-false'), { verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' } }], done: false });
    expect(values.get('cmi.interactions.0.id')).toBe(`${check['@id']}#question-1`);
    expect(values.get('cmi.interactions.0.result')).toBe('correct');
    expect(values.get('cmi.interactions.1.type')).toBe('true-false');
    expect(values.get('cmi.interactions.1.result')).toBe('incorrect');
    expect(values.get('cmi.interactions.0.learner_response')).toBe('b');
    expect(values.has('cmi.interactions.2.id')).toBe(false);   // only answers become interactions
    expect(calls.at(-1)).toEqual(['Commit', '']);
    post({ type: 'foxxi.scorm', statements: [], done: true, summary: { graded: { correct: 1, total: 2 } } });
    expect(values.get('cmi.score.scaled')).toBe('0.5');
    expect(values.get('cmi.success_status')).toBe('failed');   // no passing score set: every graded question right
    expect(values.get('cmi.completion_status')).toBe('completed');
    expect(calls.slice(-2).map(c => c[0])).toEqual(['Commit', 'Terminate']);
    const after = calls.length;
    post({ type: 'foxxi.scorm', statements: [answered(3, true)], done: false });
    expect(calls.length).toBe(after);   // nothing after Terminate
  });

  it('judges success by the LMS\'s passing score when it sets one', () => {
    const { values, post } = lms('0.5');
    post({ type: 'foxxi.scorm', statements: [], done: true, summary: { graded: { correct: 1, total: 2 } } });
    expect(values.get('cmi.success_status')).toBe('passed');
  });

  it('believes nothing that is not from the bridge', () => {
    const { calls, post } = lms();
    const before = calls.length;
    post({ type: 'foxxi.scorm', statements: [answered(1, true)], done: true, summary: { graded: { correct: 2, total: 2 } } }, 'https://attacker.example');
    post({ type: 'something else', done: true });
    expect(calls.length).toBe(before);
  });
});

describe('the player, under SCORM', () => {
  it('needs no token or LRS, and posts each step and then the summary to its wrapper only', async () => {
    const posted: Array<{ message: { type: string; statements: Statement[]; done: boolean; summary?: { graded: { correct: number; total: number } } }; origin: string }> = [];
    const fetched: string[] = [];
    let entry: PlayInProgress & { attempt?: Cmi5Attempt } = { play: undefined as unknown as CompositionPlay };
    const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    const fetchFn = async (url: string, init: RequestInit = {}) => {
      fetched.push(url);
      const b = JSON.parse(String(init.body ?? '{}'));
      if (url.endsWith('/session')) {
        const a = cmi5AttemptFrom(b);
        if (typeof a === 'string') return json(400, { error: a });
        const learner = { id: 'urn:foxxi:lms-learner:t', kind: 'human' as const };
        entry = { play: startPlay(resolveComposition({ composition: course, learner, lookup: i => store.get(i) }), course.title, learner, { session: randomUUID(), registration: a.registration }, new Date().toISOString())!, attempt: a };
        return json(200, { session: entry.play.id, step: currentView(entry.play), statements: [definedStatement('initialized', a, { now: new Date().toISOString(), newId: randomUUID })] });
      }
      const taken = await takeStep(entry, b.answers, { actor: entry.attempt!.actor, now: new Date().toISOString(), newId: randomUUID }, async st => st.map(x => String(x.id)));
      if (!taken.ok) return json(taken.status, { error: taken.error });
      const statements = attemptStatements(taken.step.statements, entry.attempt!);
      if (taken.step.done) statements.push(...closingStatements(entry.attempt!, entry.play.graded, { now: new Date().toISOString(), newId: randomUUID }, 0));
      return json(200, { done: taken.step.done, statements, ...(taken.step.graded ? { graded: taken.step.graded } : {}), ...(taken.step.done ? { summary: { graded: entry.play.graded } } : { step: currentView(entry.play) }) });
    };
    const url = new URL(player);
    for (const [k, v] of Object.entries({ transport: 'scorm', parentOrigin: 'https://lms.example', activityId: scoIdOf(course['@id']), actor: JSON.stringify({ objectType: 'Agent', account: { homePage: 'https://lms.example', name: 'learner-7' } }) })) url.searchParams.set(k, v);
    const dom = new JSDOM(compositionAuPage({ title: course.title, sessionBase: player }), {
      runScripts: 'dangerously', url: url.toString(),
      beforeParse(w) {
        Object.defineProperty(w, 'fetch', { value: fetchFn });
        Object.defineProperty(w, 'postMessage', { value: (message: never, origin: string) => { posted.push({ message, origin }); } });
      },
    });
    windows.push(dom);
    const doc = dom.window.document;
    const go = () => doc.getElementById('go') as HTMLButtonElement;
    await expect.poll(() => go().disabled).toBe(false);
    go().click();
    await expect.poll(() => doc.querySelectorAll('input[name="q0"]').length).toBe(2);
    (doc.querySelector('input[name="q0"][value="B"]') as HTMLInputElement).checked = true;
    (doc.querySelector('input[name="q1"][value="false"]') as HTMLInputElement).checked = true;
    await expect.poll(() => go().disabled).toBe(false);
    go().click();
    await expect.poll(() => posted.some(p => p.message.done)).toBe(true);
    expect(fetched.every(u => u.startsWith(player))).toBe(true);   // no token, LaunchData or LRS
    expect(posted.every(p => p.origin === 'https://lms.example' && p.message.type === 'foxxi.scorm')).toBe(true);
    const last = posted.at(-1)!.message;
    expect(last.summary!.graded).toEqual({ correct: 1, total: 2 });
    expect(posted.flatMap(p => p.message.statements).filter(s => String((s.verb as { id: string }).id).endsWith('/answered'))).toHaveLength(2);
  });
});

describe('the bridge serves the package', () => {
  it('builds it for the composition, framing this bridge\'s player', () => {
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const route = src.slice(src.indexOf("app.get('/ns/foxxi/composition/:hash/scorm.zip'"), src.indexOf('\n});', src.indexOf("app.get('/ns/foxxi/composition/:hash/scorm.zip'")));
    expect(route).toMatch(/compositionScormZip\(item, `\$\{bridgeBaseUrl\}\/ns\/foxxi\/composition\/\$\{hash\}\/au`\)/);
    expect(route).toMatch(/if \(!\/\^\[0-9a-f\]\{64\}\$\/\.test\(hash\)\)/);
  });
});
