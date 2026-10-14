/**
 * SCORM dispatch: a course authored on the bridge, played inside another organization's LMS through
 * a stub package (SCORM 2004 or 1.2). The stub holds no content, never tells the bridge who the
 * learner is, believes only the bridge, and reports the outcome through the LMS's own API. The
 * author makes, lists and withdraws dispatches; a withdrawn, expired or exhausted dispatch stops
 * every copy of its stub.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import type { Express } from 'express';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
import {
  DispatchRegistry, answeredFor, attachScormDispatchRoutes, dispatchManifest, dispatchState, dispatchWrapper, dispatchZip, mergeDispatch,
  perAddressLimiter, registryWriter, reportScript, stubOrigin, type DispatchCourse, type DispatchEngine, type DispatchRecord, type DispatchStep, type ScormVersion,
} from '../src/scorm-dispatch.js';
import { conceptMatcher, parseI2idlGlossary, parseI2idlxDecorations } from '../src/i2idl-glossary.js';
import { parseManifest } from '../src/scorm-sequencing.js';
import type { GradedView, LearnerQuestion, ScoView } from '../src/lti-player.js';
import { glossaryJsonLd, i2idlxGraphs } from './support/i2idl-glossary-fixture.js';

const windows: JSDOM[] = [];
/** A dispatch the registry made, not a refusal. */
function made(d: DispatchRecord | { refused: string }): DispatchRecord {
  if ('refused' in d) throw new Error(d.refused);
  return d;
}
afterAll(() => { for (const w of windows) w.window.close(); });

// ── The registry ──
describe('the dispatch registry', () => {
  it('knows each dispatch\'s state: live, revoked, expired, exhausted', () => {
    const r = new DispatchRegistry();
    const now = Date.parse('2026-10-01T00:00:00Z');
    const d = made(r.create({ courseId: 'c', title: 'C', owner: 'did:a', expiresAt: '2026-10-02T00:00:00Z', launchLimit: 2 }, now));
    expect(d.id).toMatch(/^d-[A-Za-z0-9_-]{24}$/);
    expect(dispatchState(d, now)).toBe('live');
    expect(dispatchState(d, Date.parse('2026-10-02T00:00:00Z'))).toBe('expired');
    r.countLaunch(d.id, now); r.countLaunch(d.id, now);
    expect(dispatchState(d, now)).toBe('exhausted');
    r.revoke(d.id, now);
    expect(dispatchState(d, now)).toBe('revoked');
    expect(r.ownedBy('did:a')).toEqual([d]);
    expect(r.ownedBy('did:b')).toEqual([]);
  });

  it('merges a durable copy: the larger counts, the earlier withdrawal, malformed entries skipped', () => {
    const r = new DispatchRegistry();
    const d = made(r.create({ courseId: 'c', title: 'C', owner: 'did:a' }, 0));
    r.countLaunch(d.id, 0);
    const durable = { [d.id]: { ...d, usage: { launches: 5, completed: 3, passed: 1 }, revokedAt: '2026-01-01T00:00:00.000Z' }, junk: { id: 'nope' } };
    expect(r.load(JSON.parse(JSON.stringify(durable)))).toBe(1);
    expect(r.get(d.id)).toMatchObject({ revokedAt: '2026-01-01T00:00:00.000Z', usage: { launches: 5, completed: 3, passed: 1 } });
    expect(mergeDispatch({ ...d, usage: { launches: 9, completed: 0, passed: 0 } }, { ...d, usage: { launches: 1, completed: 1, passed: 1 } }).usage).toMatchObject({ launches: 9, completed: 1, passed: 1 });
    expect(new DispatchRegistry().load(JSON.parse(JSON.stringify(r)))).toBe(1);
  });

  it('refuses a new dispatch when full, or when one author holds as many as one may: it never evicts one', () => {
    const r = new DispatchRegistry(3, 2);
    const first = made(r.create({ courseId: 'c', title: 'C', owner: 'did:a' }, 0));
    made(r.create({ courseId: 'c', title: 'C', owner: 'did:a' }, 0));
    expect(r.create({ courseId: 'c', title: 'C', owner: 'did:a' }, 0)).toEqual({ refused: 'an author may hold 2 dispatches; withdraw one you no longer need' });
    made(r.create({ courseId: 'c', title: 'C', owner: 'did:b' }, 0));
    expect(r.create({ courseId: 'c', title: 'C', owner: 'did:c' }, 0)).toEqual({ refused: 'this bridge holds as many dispatches as it can' });
    expect(r.get(first.id)).toBe(first);
  });

  it('takes a launch only from a live dispatch, in one step, and gives back one that did not start', () => {
    const r = new DispatchRegistry();
    const d = made(r.create({ courseId: 'c', title: 'C', owner: 'did:a', launchLimit: 1 }, 0));
    expect(r.reserveLaunch(d.id, 0)).toBe('live');
    expect(r.reserveLaunch(d.id, 0)).toBe('exhausted');
    expect(d.usage.launches).toBe(1);
    r.releaseLaunch(d.id);
    expect(r.reserveLaunch(d.id, 0)).toBe('live');
    expect(r.reserveLaunch('d-nonexistentnonexistent', 0)).toBeUndefined();
  });

  it('keeps trying a durable write that fails, later each time, until one succeeds', async () => {
    vi.useFakeTimers();
    try {
      const outcomes = [false, false, true];
      const at: number[] = [];
      const persist = registryWriter(async () => { at.push(Date.now()); return outcomes.shift() ?? true; }, { debounceMs: 2_000, firstRetryMs: 5_000, maxRetryMs: 60_000 });
      const start = Date.now();
      persist(); persist();   // changes close together share one write
      await vi.advanceTimersByTimeAsync(2_000);
      expect(at.map(t => t - start)).toEqual([2_000]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(at.map(t => t - start)).toEqual([2_000, 7_000]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(at.map(t => t - start)).toEqual([2_000, 7_000, 17_000]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(at).toHaveLength(3);   // succeeded: nothing more until the next change
      const thrown = registryWriter(async () => { throw new Error('pod down'); }, { debounceMs: 1, firstRetryMs: 10 });
      thrown();
      await vi.advanceTimersByTimeAsync(1);   // a write that throws is retried too, not lost
    } finally { vi.useRealTimers(); }
  });

  it('limits a learner\'s address by a window wider than an agent\'s', () => {
    let t = 0;
    const limit = perAddressLimiter(2, 60_000, () => t);
    expect([limit('a'), limit('a'), limit('b'), limit('a')]).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false, retryAfterSeconds: 60 }]);
    t += 60_001;
    expect(limit('a')).toEqual({ ok: true });
  });
});

// ── The stub package ──
const d0 = { id: 'd-AAAAAAAAAAAAAAAAAAAAAAAA', title: 'Refund authority' };
const launchUrl = `https://bridge.example/scorm/dispatch/${d0.id}/launch`;

describe('the stub package', () => {
  it('is one SCO for SCORM 2004, carrying the course\'s mastery score as the passing score', () => {
    const xml = dispatchManifest(d0, '2004', 0.8);
    const tree = parseManifest(xml);
    expect(tree.courseTitle).toBe('Refund authority');
    const sco = tree.preorder.filter(a => a.href);
    expect(sco.map(a => a.href)).toEqual(['index.html']);
    expect(sco[0]!.sequencing.primaryObjective).toMatchObject({ satisfiedByMeasure: true, minNormalizedMeasure: 0.8 });
    expect(dispatchManifest(d0, '2004', 80)).toContain('<imsss:minNormalizedMeasure>0.8</imsss:minNormalizedMeasure>');   // a percentage reads the same
  });

  it('is one SCO for SCORM 1.2, in the 1.2 namespaces, with the mastery score as a percentage', () => {
    const xml = dispatchManifest(d0, '1.2', 0.8);
    const doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.namespaceURI).toBe('http://www.imsproject.org/xsd/imscp_rootv1p1p2');
    expect(doc.getElementsByTagName('schemaversion')[0]!.textContent).toBe('1.2');
    expect(doc.getElementsByTagName('adlcp:masteryscore')[0]!.textContent).toBe('80');
    expect(doc.getElementsByTagName('resource')[0]!.getAttribute('adlcp:scormtype')).toBe('sco');
  });

  it('holds no content and no answers, only the dispatch\'s address, and is the same bytes each time', () => {
    for (const version of ['2004', '1.2'] as const) {
      const bytes = dispatchZip(d0, { baseUrl: 'https://bridge.example/', version, masteryScore: 0.8 });
      const zip = new AdmZip(bytes);
      expect(zip.getEntries().map(e => e.entryName).sort()).toEqual(['README.txt', 'imsmanifest.xml', 'index.html']);
      expect(zip.readAsText('index.html')).toContain(JSON.stringify(launchUrl));
      expect(zip.readAsText('README.txt')).toContain(`https://bridge.example/scorm/dispatch/${d0.id}/ask`);
      expect(bytes.equals(dispatchZip(d0, { baseUrl: 'https://bridge.example', version, masteryScore: 0.8 }))).toBe(true);
    }
  });
});

// ── The stub, inside an LMS ──
describe('the stub, inside an LMS', () => {
  function lms(version: ScormVersion, opts: { passing?: string; suspend?: string; noInteractions?: boolean; title?: string } = {}) {
    const calls: Array<[string, ...string[]]> = [];
    const reads: string[] = [];
    const v12 = version === '1.2';
    const values = new Map<string, string>([
      ['cmi.interactions._count', '0'], [v12 ? 'cmi.student_data.mastery_score' : 'cmi.scaled_passing_score', opts.passing ?? ''],
      ['cmi.suspend_data', opts.suspend ?? ''], [v12 ? 'cmi.core.lesson_status' : 'cmi.completion_status', v12 ? 'not attempted' : 'unknown'],
    ]);
    const name = (n: string) => (v12 ? `LMS${n}` : n);
    const API: Record<string, (...a: string[]) => string> = {
      [name('Initialize')]: (a) => { calls.push([name('Initialize'), a]); return 'true'; },
      [name('GetValue')]: (k) => { reads.push(k); return values.get(k) ?? ''; },
      [name('SetValue')]: (k, val) => {
        if (opts.noInteractions && k.startsWith('cmi.interactions.')) return 'false';
        calls.push([name('SetValue'), k, val]); values.set(k, val); return 'true';
      },
      [name('Commit')]: (a) => { calls.push([name('Commit'), a]); return 'true'; },
      [v12 ? 'LMSFinish' : 'Terminate']: (a) => { calls.push([v12 ? 'LMSFinish' : 'Terminate', a]); return 'true'; },
      [name('GetLastError')]: () => (opts.noInteractions ? '401' : '0'),
    };
    const dom = new JSDOM(dispatchWrapper({ title: opts.title ?? d0.title, launchUrl, version }), {
      runScripts: 'dangerously', url: 'https://lms.example/content/pkg/index.html',
      beforeParse(w) { Object.defineProperty(w, v12 ? 'API' : 'API_1484_11', { value: API }); },
    });
    windows.push(dom);
    const post = (data: unknown, origin = 'https://bridge.example') => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, origin }));
    const frame = () => new URL((dom.window.document.querySelector('iframe') as HTMLIFrameElement).src);
    return { dom, calls, reads, values, post, frame };
  }
  const graded: GradedView = { score: 0.5, correct: 1, total: 2, passed: false, detail: [
    { question: 'Who approves $600?', your: 'B', correct: true }, { question: 'Refunds are logged.', your: 'false', correct: false },
  ] };
  const answered = answeredFor('check-section', graded);

  it('opens the course on the bridge, telling it only where to post: never who the learner is', () => {
    for (const version of ['2004', '1.2'] as const) {
      const { frame, reads, calls } = lms(version);
      expect(calls[0]![0]).toBe(version === '2004' ? 'Initialize' : 'LMSInitialize');
      const src = frame();
      expect(src.origin + src.pathname).toBe(launchUrl);
      expect([...src.searchParams.keys()].sort()).toEqual(['parentOrigin', 'scorm']);
      expect(src.searchParams.get('scorm')).toBe(version);
      expect(src.searchParams.get('parentOrigin')).toBe('https://lms.example');
      expect(reads.some(k => /learner_id|student_id|student_name|learner_name/.test(k))).toBe(false);
    }
  });

  it('SCORM 2004: records answers as interactions, keeps the attempt to resume, and reports the outcome', () => {
    const { calls, values, post } = lms('2004');
    expect(values.get('cmi.completion_status')).toBe('incomplete');
    post({ type: 'foxxi.scorm', play: 'p1', statements: answered, done: false });
    expect(values.get('cmi.suspend_data')).toBe('foxxi-play:p1');
    expect(values.get('cmi.interactions.0.id')).toBe('q-check-section-1');
    expect(values.get('cmi.interactions.0.type')).toBe('other');
    expect(values.get('cmi.interactions.0.description')).toBe('Who approves $600?');
    expect(values.get('cmi.interactions.0.learner_response')).toBe('B');
    expect(values.get('cmi.interactions.0.result')).toBe('correct');
    expect(values.get('cmi.interactions.1.result')).toBe('incorrect');
    expect(calls.at(-1)).toEqual(['Commit', '']);
    post({ type: 'foxxi.scorm', play: 'p1', statements: [], done: true, summary: { completed: true, passed: false, score: 0.5, graded: { correct: 1, total: 2 } } });
    expect(Object.fromEntries(['cmi.score.raw', 'cmi.score.min', 'cmi.score.max', 'cmi.score.scaled', 'cmi.success_status', 'cmi.completion_status', 'cmi.exit', 'cmi.suspend_data'].map(k => [k, values.get(k)])))
      .toEqual({ 'cmi.score.raw': '50', 'cmi.score.min': '0', 'cmi.score.max': '100', 'cmi.score.scaled': '0.5', 'cmi.success_status': 'failed', 'cmi.completion_status': 'completed', 'cmi.exit': 'normal', 'cmi.suspend_data': '' });
    expect(values.get('cmi.session_time')).toMatch(/^PT\d+H\d+M\d+S$/);
    expect(calls.slice(-2).map(c => c[0])).toEqual(['Commit', 'Terminate']);
    const after = calls.length;
    post({ type: 'foxxi.scorm', statements: answered, done: false });
    expect(calls.length).toBe(after);   // nothing after Terminate
  });

  it('SCORM 1.2: the same, in 1.2\'s data model', () => {
    const { calls, values, post } = lms('1.2');
    expect(values.get('cmi.core.lesson_status')).toBe('incomplete');
    post({ type: 'foxxi.scorm', play: 'p2', statements: answered, done: false });
    expect(values.get('cmi.interactions.0.type')).toBe('performance');
    expect(values.get('cmi.interactions.0.student_response')).toBe('B');
    expect(values.get('cmi.interactions.1.result')).toBe('wrong');
    expect(values.has('cmi.interactions.0.description')).toBe(false);   // 1.2 has none
    expect(calls.at(-1)).toEqual(['LMSCommit', '']);
    post({ type: 'foxxi.scorm', play: 'p2', statements: [], done: true, summary: { completed: true, passed: true, score: 0.9, graded: { correct: 9, total: 10 } } });
    expect(values.get('cmi.core.score.raw')).toBe('90');
    expect(values.get('cmi.core.lesson_status')).toBe('passed');
    expect(values.get('cmi.core.session_time')).toMatch(/^\d{4}:\d\d:\d\d$/);
    expect(calls.slice(-2).map(c => c[0])).toEqual(['LMSCommit', 'LMSFinish']);
  });

  it('judges success by the LMS\'s passing score when it sets one', () => {
    const a = lms('2004', { passing: '0.4' });
    a.post({ type: 'foxxi.scorm', statements: [], done: true, summary: { passed: false, score: 0.5, graded: { correct: 1, total: 2 } } });
    expect(a.values.get('cmi.success_status')).toBe('passed');
    const b = lms('1.2', { passing: '60' });
    b.post({ type: 'foxxi.scorm', statements: [], done: true, summary: { passed: true, score: 0.5, graded: { correct: 1, total: 2 } } });
    expect(b.values.get('cmi.core.lesson_status')).toBe('failed');
  });

  it('completes, with no score, a course nothing in which is graded', () => {
    const { values, post } = lms('1.2');
    post({ type: 'foxxi.scorm', statements: [], done: true, summary: { passed: true, score: 0, graded: { correct: 0, total: 0 } } });
    expect(values.get('cmi.core.lesson_status')).toBe('completed');
    expect(values.has('cmi.core.score.raw')).toBe(false);
  });

  it('resumes an attempt the LMS kept, and suspends one left mid-way', () => {
    const { frame, dom, values, calls, post } = lms('2004', { suspend: 'foxxi-play:p9' });
    expect(frame().searchParams.get('resume')).toBe('p9');
    post({ type: 'foxxi.scorm', play: 'p9', statements: [], done: false });
    dom.window.dispatchEvent(new dom.window.Event('beforeunload'));
    expect(values.get('cmi.exit')).toBe('suspend');
    expect(calls.slice(-2).map(c => c[0])).toEqual(['Commit', 'Terminate']);
  });

  it('goes on without interactions in an LMS that does not keep them', () => {
    const { values, post } = lms('1.2', { noInteractions: true });
    post({ type: 'foxxi.scorm', play: 'p3', statements: answered, done: false });
    post({ type: 'foxxi.scorm', statements: [], done: true, summary: { passed: true, score: 1, graded: { correct: 2, total: 2 } } });
    expect(values.get('cmi.core.lesson_status')).toBe('passed');
  });

  it('believes nothing that is not from the bridge, and runs nothing in an author\'s title', () => {
    const { calls, post } = lms('2004');
    const before = calls.length;
    post({ type: 'foxxi.scorm', statements: answered, done: true, summary: { score: 1, graded: { correct: 2, total: 2 } } }, 'https://attacker.example');
    post({ type: 'something else', done: true });
    expect(calls.length).toBe(before);
    const title = 'Refunds </script ><script>window.pwned = 1</script><!-- <script>';
    const { dom } = lms('1.2', { title });
    const scripts = dom.window.document.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(() => new Script(scripts[0]!.textContent!)).not.toThrow();
    expect((dom.window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(dom.window.document.title).toBe(title);
  });
});

describe('what the bridge posts to the stub', () => {
  it('posts to the stub\'s origin only, and only an origin it can name', () => {
    expect(stubOrigin('https://lms.example')).toBe('https://lms.example');
    for (const bad of ['https://lms.example/', 'https://lms.example/path', 'javascript:alert(1)', '*', 'null', 7]) expect(stubOrigin(bad)).toBeUndefined();
    expect(reportScript(undefined, { type: 'foxxi.scorm' })).toBe('');
    const posted: Array<[unknown, string]> = [];
    const code = /<script>([\s\S]*)<\/script>/.exec(reportScript('https://lms.example', { type: 'foxxi.scorm', statements: [{ note: '</script><script>x()' }] }))![1]!;
    new Script(code).runInNewContext({ window: { parent: { postMessage: (m: unknown, o: string) => posted.push([m, o]) } } });
    expect(posted).toEqual([[{ type: 'foxxi.scorm', statements: [{ note: '</script><script>x()' }] }, 'https://lms.example']]);
  });
});

// ── The routes, end to end, over a fake engine ──
interface FakePlay { course: DispatchCourse; at: number }
const course: DispatchCourse & { owner: string } = {
  courseId: 'refunds', title: 'Refund authority', masteryScore: 0.8, owner: 'did:web:author.example',
  scos: [
    { id: 'intro', title: 'Who approves', body: 'Formative assessment shows where you are. Agents refund up to $250.' },
    { id: 'check', title: 'Check yourself', body: 'Two questions.' },
  ],
};
const questions: LearnerQuestion[] = [
  { index: 0, question: 'Who approves $600?', type: 'choice', input: { type: 'choice', options: ['Agent', 'Team lead'] }, graded: true },
  { index: 1, question: 'Refunds are logged.', type: 'true-false', input: { type: 'true-false' }, graded: true },
];
const view = (i: number): ScoView => ({ id: course.scos[i]!.id, title: course.scos[i]!.title, body: course.scos[i]!.body, ...(i === 1 ? { assessment: questions } : {}) });
const engine: DispatchEngine<FakePlay> = {
  start: (c) => ({ ok: true, play: { course: c, at: 0 } }),
  current: (p) => (p.at < 2 ? { sco: view(p.at), questions: p.at === 1 ? questions : [] } : null),
  async advance(p, answers): Promise<DispatchStep> {
    if (p.at === 0) { p.at = 1; return { ok: true, done: false, sco: view(1) }; }
    if (!Array.isArray(answers) || answers.length !== 2 || answers.some(a => typeof a !== 'string' || !a)) return { ok: false, status: 422, error: 'Answer every question.' };
    const right = [answers[0] === 'B', answers[1] === 'true'];
    const correct = right.filter(Boolean).length;
    const g: GradedView = { score: correct / 2, correct, total: 2, passed: correct / 2 >= 0.8, detail: questions.map((q, i) => ({ question: q.question, your: String(answers[i]), correct: right[i]! })) };
    p.at = 2;
    return { ok: true, done: true, graded: g, completed: true, passed: g.passed, score: g.score };
  },
  courseTitle: (p) => p.course.title,
};

describe('the dispatch routes', () => {
  let server: Server;
  let base = '';
  let clock = Date.parse('2026-10-13T12:00:00Z');
  let limitNext = false;
  const registry = new DispatchRegistry();
  const durable = new DispatchRegistry();
  let persisted = 0;
  const glossary = parseI2idlGlossary(glossaryJsonLd);
  const sign = (as: string | undefined, payload: Record<string, unknown> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ as, ...payload }) });
  const html = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init, headers: { Accept: 'text/html', ...(init.headers ?? {}) } });
  const json = (url: string, init: RequestInit = {}) => fetch(url, { redirect: 'manual', ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } });
  const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  const reportOf = (page: string) => {
    const m = /window\.parent\.postMessage\((\{[\s\S]*?\}),("[^"]*")\)/.exec(page);
    return m ? { message: JSON.parse(m[1]!.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')), origin: JSON.parse(m[2]!) } : null;
  };
  async function dispatch(payload: Record<string, unknown> = {}): Promise<string> {
    const r = await json(`${base}/agent/scorm/dispatch`, sign(course.owner, { course_id: 'refunds', ...payload }));
    expect(r.status).toBe(201);
    return ((await r.json()) as { dispatch: { id: string } }).dispatch.id;
  }
  async function launch(id: string, query = 'scorm=2004&parentOrigin=https%3A%2F%2Flms.example'): Promise<string> {
    const r = await html(`${base}/scorm/dispatch/${id}/launch?${query}`);
    expect(r.status).toBe(303);
    return r.headers.get('location')!;
  }

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The bridge's app is the shared vertical bridge's, on its own express (a different major from
    // this vertical's), with its JSON parser in front: the same here, so a route that parsed JSON a
    // second time would fail as it did on the bridge.
    const sharedExpress = createRequire(new URL('../../_shared/vertical-bridge/index.ts', import.meta.url))('express') as { (): Express; json(o: object): never };
    const app = sharedExpress();
    app.use(sharedExpress.json({ limit: '50mb' }));
    attachScormDispatchRoutes(app, {
      baseUrl: base, registry, engine,
      verifyCaller: async (body) => {
        const b = body as Record<string, unknown>;
        return typeof b.as === 'string' ? { ok: true, callerDid: b.as, payload: b } : { ok: false, status: 401, error: 'agent signature required' };
      },
      // 'slow' is the same course, resolved after a pause, so two launches can overlap.
      resolveCourse: async (id) => (id === 'refunds' ? course : id === 'slow' ? new Promise(r => setTimeout(() => r({ ...course, courseId: 'slow' }), 50)) : null),
      ownerOf: async (c) => (c as typeof course).owner,
      rateLimit: () => (limitNext ? (limitNext = false, { ok: false, retryAfterSeconds: 9 }) : { ok: true }),
      persist: () => { persisted++; },
      reload: async () => { registry.load(JSON.parse(JSON.stringify(durable))); },
      glossary: async () => ({ glossary, matcher: conceptMatcher(glossary.concepts), decorations: parseI2idlxDecorations(i2idlxGraphs), loadedAt: 0 }),
      now: () => clock,
    });
    server.on('request', app);
  });
  afterAll(() => new Promise<void>((r) => { server.close(() => r()); }));

  it('lets only the course\'s author dispatch it, within bounds', async () => {
    expect((await json(`${base}/agent/scorm/dispatch`, sign(undefined, { course_id: 'refunds' }))).status).toBe(401);
    expect((await json(`${base}/agent/scorm/dispatch`, sign('did:web:someone-else.example', { course_id: 'refunds' }))).status).toBe(403);
    expect((await json(`${base}/agent/scorm/dispatch`, sign(course.owner, { course_id: 'nope' }))).status).toBe(404);
    expect((await json(`${base}/agent/scorm/dispatch`, sign(course.owner, { course_id: 'refunds', expires_at: '2020-01-01T00:00:00Z' }))).status).toBe(400);
    expect((await json(`${base}/agent/scorm/dispatch`, sign(course.owner, { course_id: 'refunds', launch_limit: 0 }))).status).toBe(400);
    const before = persisted;
    const r = await json(`${base}/agent/scorm/dispatch`, sign(course.owner, { course_id: 'refunds', title: 'Refunds for Acme' }));
    expect(r.status).toBe(201);
    const body = await r.json() as { dispatch: Record<string, unknown> };
    expect(body.dispatch).toMatchObject({ courseId: 'refunds', title: 'Refunds for Acme', owner: course.owner, state: 'live', usage: { launches: 0, completed: 0, passed: 0 } });
    expect(body.dispatch.packages).toEqual({ '2004': `${base}/scorm/dispatch/${body.dispatch.id}/package.zip?scorm=2004`, '1.2': `${base}/scorm/dispatch/${body.dispatch.id}/package.zip?scorm=1.2` });
    expect(persisted).toBe(before + 1);
  });

  it('serves the stub, which holds none of the course', async () => {
    const id = await dispatch();
    const r = await fetch(`${base}/scorm/dispatch/${id}/package.zip?scorm=1.2`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="refund-authority-scorm-12.zip"');
    const zip = new AdmZip(Buffer.from(await r.arrayBuffer()));
    expect(zip.readAsText('imsmanifest.xml')).toContain('<adlcp:masteryscore>80</adlcp:masteryscore>');
    const everything = zip.getEntries().map(e => e.getData().toString('utf8')).join('\n');
    for (const secret of ['Agents refund up to', 'Who approves $600?', 'Team lead', 'Two questions']) expect(everything).not.toContain(secret);
  });

  it('plays an attempt a section at a time, reporting each page to the stub once, and counts it for the author', async () => {
    const id = await dispatch();
    const play = await launch(id);
    expect(play).toMatch(new RegExp(`^${base}/scorm/dispatch/play/[A-Za-z0-9_-]{32}$`));
    const first = await (await html(play)).text();
    expect(first).toContain('Who approves');
    expect(first).toContain(`action="${base}/scorm/dispatch/${id}/ask"`);
    const playId = play.split('/').pop()!;
    expect(reportOf(first)).toEqual({ message: { type: 'foxxi.scorm', play: playId, statements: [], done: false }, origin: 'https://lms.example' });
    const second = await (await html(play, form({}))).text();
    expect(second).toContain('Check yourself');
    const bad = await html(play, form({ answer_0: 'B' }));
    expect(bad.status).toBe(422);
    const end = await (await html(play, form({ answer_0: 'B', answer_1: 'false' }))).text();
    expect(end).toContain('Not passed yet: 50%');
    const report = reportOf(end)!;
    expect(report.message).toMatchObject({ type: 'foxxi.scorm', play: playId, done: true, summary: { completed: true, passed: false, score: 0.5, graded: { correct: 1, total: 2 } } });
    expect(report.message.statements.map((s: { object: { id: string }; result: { success?: boolean } }) => [s.object.id, s.result.success])).toEqual([['q-check-1', true], ['q-check-2', false]]);
    // Reported once: the same page again carries the outcome, not the answers a second time.
    expect(reportOf(await (await html(play)).text())!.message.statements).toEqual([]);
    const listed = await (await json(`${base}/agent/scorm/dispatches`, sign(course.owner, { course_id: 'refunds' }))).json() as { dispatches: Array<{ id: string; usage: unknown }> };
    expect(listed.dispatches.find(x => x.id === id)!.usage).toMatchObject({ launches: 1, completed: 1, passed: 0 });
    expect((await (await json(`${base}/agent/scorm/dispatches`, sign('did:web:someone-else.example'))).json() as { count: number }).count).toBe(0);
  });

  it('plays as JSON for a client without a browser', async () => {
    const play = await launch(await dispatch());
    const step = await (await json(play)).json() as Record<string, unknown>;
    expect(step).toMatchObject({ kind: 'dispatch-play', done: false, sco: { id: 'intro' }, submit: { method: 'POST', href: play } });
    await json(play, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const done = await (await json(play, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: ['B', 'true'] }) })).json() as Record<string, unknown>;
    expect(done).toMatchObject({ kind: 'dispatch-play', done: true, outcome: { completed: true, passed: true, score: 1 } });
  });

  it('resumes an attempt under way instead of starting another, and reports to no origin it cannot name', async () => {
    const id = await dispatch();
    const play = await launch(id);
    const playId = play.split('/').pop()!;
    expect(await launch(id, `scorm=2004&parentOrigin=https%3A%2F%2Flms.example&resume=${playId}`)).toBe(play);
    const elsewhere = await launch(id, 'scorm=1.2&parentOrigin=javascript%3Aalert(1)');
    expect(elsewhere).not.toBe(play);
    expect(reportOf(await (await html(elsewhere)).text())).toBeNull();
    expect(registry.get(id)!.usage.launches).toBe(2);
  });

  it('answers a question about the course from the stub, grounded in I2IDL', async () => {
    const id = await dispatch();
    const playId = (await launch(id)).split('/').pop()!;
    const a = await (await json(`${base}/scorm/dispatch/${id}/ask?q=${encodeURIComponent('What is formative assessment?')}`)).json() as Record<string, unknown>;
    expect(a).toMatchObject({ kind: 'course-answer', grounding: 'glossary-and-course', concepts: [{ label: 'Formative assessment', origin: 'I2IDL' }] });
    const page = await (await html(`${base}/scorm/dispatch/${id}/ask?q=${encodeURIComponent('What is formative assessment?')}&play=${playId}`)).text();
    expect(page).toContain('Assessment used during learning to guide what comes next.');
    expect(page).toContain(`href="${base}/scorm/dispatch/play/${playId}">Back to the course`);
    expect(page).not.toContain('Who approves $600?');
    expect((await json(`${base}/scorm/dispatch/${id}/ask`)).status).toBe(400);
  });

  it('stops every copy of the stub once withdrawn, expired or exhausted; attempts under way finish', async () => {
    const id = await dispatch();
    const play = await launch(id);
    expect((await json(`${base}/agent/scorm/dispatch/revoke`, sign('did:web:someone-else.example', { dispatch_id: id }))).status).toBe(404);
    const r = await json(`${base}/agent/scorm/dispatch/revoke`, sign(course.owner, { dispatch_id: id }));
    expect(await r.json()).toMatchObject({ dispatch: { state: 'revoked' } });
    for (const path of ['launch?scorm=2004', 'package.zip?scorm=2004', 'ask?q=refunds']) {
      const g = await json(`${base}/scorm/dispatch/${id}/${path}`);
      expect(g.status).toBe(410);
      expect(await g.json()).toEqual({ error: 'Its author has withdrawn this course from this learning system.' });
    }
    expect((await html(play)).status).toBe(200);

    const capped = await dispatch({ launch_limit: 1 });
    await launch(capped);
    expect((await json(`${base}/scorm/dispatch/${capped}/launch`)).status).toBe(410);

    const brief = await dispatch({ expires_at: new Date(clock + 60_000).toISOString() });
    await launch(brief);
    clock += 120_000;
    expect(await (await json(`${base}/scorm/dispatch/${brief}/launch`)).json()).toEqual({ error: 'This course\'s dispatch has expired. Ask whoever runs your learning system to renew it.' });
  });

  it('resumes an attempt under way after the dispatch has used its last launch, and starts no new one', async () => {
    const id = await dispatch({ launch_limit: 1 });
    const play = await launch(id);
    const playId = play.split('/').pop()!;
    expect(registry.get(id)!.usage.launches).toBe(1);
    expect(await launch(id, `scorm=2004&parentOrigin=https%3A%2F%2Flms.example&resume=${playId}`)).toBe(play);
    expect((await json(`${base}/scorm/dispatch/${id}/launch`)).status).toBe(410);
    expect(registry.get(id)!.usage.launches).toBe(1);
  });

  it('gives a dispatch\'s last launch to one of two launches that race for it', async () => {
    const r = await json(`${base}/agent/scorm/dispatch`, sign(course.owner, { course_id: 'slow', launch_limit: 1 }));
    const id = ((await r.json()) as { dispatch: { id: string } }).dispatch.id;
    const both = await Promise.all([1, 2].map(() => fetch(`${base}/scorm/dispatch/${id}/launch?scorm=2004`, { redirect: 'manual', headers: { Accept: 'application/json' } })));
    expect(both.map(x => x.status).sort()).toEqual([303, 410]);
    expect(registry.get(id)!.usage.launches).toBe(1);
  });

  it('finds a dispatch another process made in the durable copy, and limits the author\'s calls', async () => {
    const elsewhere = made(durable.create({ courseId: 'refunds', title: 'Made elsewhere', owner: course.owner }, clock));
    expect(registry.get(elsewhere.id)).toBeUndefined();
    await launch(elsewhere.id);
    expect(registry.get(elsewhere.id)!.usage.launches).toBe(1);
    expect((await json(`${base}/scorm/dispatch/d-nonexistentnonexistent/launch`)).status).toBe(404);
    limitNext = true;
    expect((await json(`${base}/agent/scorm/dispatch`, sign(course.owner, { course_id: 'refunds' }))).status).toBe(429);
  });
});
