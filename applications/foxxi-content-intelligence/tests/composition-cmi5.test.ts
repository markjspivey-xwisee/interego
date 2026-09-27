/**
 * A composition projected as a cmi5 course: one course, one AU whose page is the bridge's player,
 * resolved per learner and graded on the bridge, with every statement in the attempt carrying the
 * LMS's actor, registration and context template, the cmi5 category only on cmi5 defined ones,
 * initialized first and terminated last.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseCmi5Course } from '../src/cmi5-course.js';
import { currentView, PLAY_EXT, startPlay, takeStep, type CompositionPlay, type PlayInProgress, type Statement } from '../src/composition-play.js';
import { compositionAuPage, compositionAuPageCsp } from '../src/composition-au-page.js';
import { createHash } from 'node:crypto';
import {
  attemptContext, attemptStatements, auIdOf, closingStatements, CMI5_IRIS, cmi5AttemptFrom, compositionCourseStructure, definedStatement, type Cmi5Attempt,
} from '../src/composition-cmi5.js';
import { compositionFrom, resolveComposition, type Composition } from '../src/compositions.js';
import { fragmentFrom, type Fragment } from '../src/content-fragments.js';

const lesson = fragmentFrom({ kind: 'concept', competencies: ['refund-authority'], title: 'Who approves', body: 'Agents refund up to **$250**.' });
const check = fragmentFrom({
  kind: 'assessment-item', competencies: ['refund-authority'], title: 'Check', body: 'Check yourself.',
  questions: [{ question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B', explanation: 'Leads approve above $250.' }, { question: 'Refunds are logged.', answer: true }],
});
const course = compositionFrom({ title: 'Refunds & <limits>', competency: 'refund-authority', positions: [
  { competency: 'refund-authority', paradigm: [lesson['@id']] },
  { competency: 'refund-authority', paradigm: [check['@id']] },
] });
const store = new Map<string, Fragment | Composition>([lesson, check, course].map(x => [x['@id'], x]));
const sessionId = randomUUID();
const attempt: Cmi5Attempt = {
  actor: { objectType: 'Agent', account: { homePage: 'https://lms.example', name: 'learner-7' } },
  registration: randomUUID(),
  activityId: 'https://lms.example/au/refunds',
  contextTemplate: {
    contextActivities: { grouping: [{ id: 'https://lms.example/publisher/acme', objectType: 'Activity' }] },
    extensions: { [CMI5_IRIS.sessionId]: sessionId },
  },
};
const at = () => ({ now: new Date().toISOString(), newId: randomUUID });
const verbOf = (s: Statement): string => String((s.verb as { id: string }).id).split('/').at(-1)!;
const categories = (s: Statement): string[] => (((s.context as { contextActivities?: { category?: Array<{ id: string }> } }).contextActivities?.category) ?? []).map(c => c.id);

/** A play for the attempt, as the bridge's session route starts one: no record, resolved for anyone new. */
function attemptPlay(a: Cmi5Attempt = attempt): PlayInProgress {
  const learner = { id: 'urn:foxxi:lms-learner:test', kind: 'human' as const };
  return { play: startPlay(resolveComposition({ composition: course, learner, lookup: i => store.get(i) }), course.title, learner, { session: randomUUID(), registration: a.registration }, new Date().toISOString())! };
}
const keepNothing = async (st: readonly Statement[]): Promise<string[]> => st.map(x => String(x.id));

describe('a composition projects as a cmi5 course', () => {
  it('as one course and one AU that an LMS can import, its page the bridge\'s player', () => {
    const xml = compositionCourseStructure(course, 'https://bridge.example/ns/foxxi/composition/abc/au');
    expect(xml).toContain('Refunds &amp; &lt;limits&gt;');
    const parsed = parseCmi5Course(xml);
    expect(parsed).toMatchObject({ id: course['@id'], title: 'Refunds & <limits>' });
    expect(parsed.structure).toHaveLength(1);
    expect(parsed.structure[0]).toMatchObject({ kind: 'au', id: `${course['@id']}#au`, url: 'https://bridge.example/ns/foxxi/composition/abc/au', moveOn: 'Completed', launchMethod: 'AnyWindow' });
    // The course and its one AU are two activities, so the LMS can tell the course's record from the attempt's.
    expect(parsed.structure[0]!.id).not.toBe(parsed.id);
    expect(auIdOf(course['@id'])).toBe(parsed.structure[0]!.id);
  });

  it('takes a launch only as an attempt it can describe', () => {
    expect(cmi5AttemptFrom({ ...attempt })).toMatchObject({ registration: attempt.registration, activityId: attempt.activityId });
    expect(cmi5AttemptFrom({ ...attempt, actor: { objectType: 'Agent', mbox: 'mailto:learner@lms.example' } })).not.toBeTypeOf('string');
    for (const [bad, why] of [
      [{ ...attempt, actor: { objectType: 'Agent' } }, /actor/],
      [{ ...attempt, actor: { mbox: 'learner@lms.example' } }, /actor/],
      [{ ...attempt, registration: 'r1' }, /registration/],
      [{ ...attempt, activityId: 'javascript:alert(1)' }, /activityId/],
      [{ ...attempt, contextTemplate: 'nope' }, /contextTemplate/],
      [{ ...attempt, masteryScore: 1.5 }, /masteryScore/],
      [{ ...attempt, moveOn: 'Whenever' }, /moveOn/],
      [{ ...attempt, launchMode: 'Preview' }, /launchMode/],
    ] as const) expect(cmi5AttemptFrom(bad as Record<string, unknown>), JSON.stringify(bad).slice(0, 80)).toMatch(why);
  });
});

describe('every statement in the attempt is the LMS\'s', () => {
  it('starts from the context template, keeps its own parents and extensions, and takes the registration', () => {
    const own = { registration: 'play-registration', contextActivities: { parent: [{ id: course['@id'] }] }, extensions: { [PLAY_EXT.competency]: 'x', [CMI5_IRIS.sessionId]: 'not-the-lms-one' } };
    const ctx = attemptContext(attempt, own) as { registration: string; contextActivities: Record<string, Array<{ id: string }>>; extensions: Record<string, unknown> };
    expect(ctx.registration).toBe(attempt.registration);
    expect(ctx.contextActivities.parent![0]!.id).toBe(course['@id']);
    expect(ctx.contextActivities.grouping![0]!.id).toBe('https://lms.example/publisher/acme');
    expect(ctx.extensions[CMI5_IRIS.sessionId]).toBe(sessionId);   // the template's, not the statement's
    expect(ctx.extensions[PLAY_EXT.competency]).toBe('x');
    expect(ctx.contextActivities.category).toBeUndefined();
    expect((attemptContext(attempt, undefined, true) as { contextActivities: { category: Array<{ id: string }> } }).contextActivities.category.map(c => c.id)).toEqual([CMI5_IRIS.category]);
    // A template that names the cmi5 category does not lend it to a cmi5 allowed statement.
    const withCategory = { ...attempt, contextTemplate: { contextActivities: { category: [{ id: CMI5_IRIS.category }] } } };
    expect((attemptContext(withCategory, own) as { contextActivities: Record<string, unknown> }).contextActivities.category).toBeUndefined();
  });

  it('runs initialized, the play at the fragment grain, completed and terminated, in that order', async () => {
    const entry = attemptPlay();
    const stream: Statement[] = [definedStatement('initialized', attempt, at())];
    const ctx = { actor: attempt.actor, now: new Date().toISOString(), newId: randomUUID };
    for (const answers of [undefined, ['B', 'true']]) {
      const taken = await takeStep(entry, answers, ctx, keepNothing);
      if (!taken.ok) throw new Error(taken.error);
      stream.push(...attemptStatements(taken.step.statements, attempt));
      if (taken.step.done) stream.push(...closingStatements(attempt, entry.play.graded, at(), 1234));
    }
    expect(stream.map(verbOf)).toEqual(['initialized', 'experienced', 'answered', 'answered', 'experienced', 'completed', 'terminated']);
    for (const s of stream) {
      expect(s.actor).toEqual(attempt.actor);
      expect((s.context as { registration: string }).registration).toBe(attempt.registration);
      expect((s.context as { extensions: Record<string, unknown> }).extensions[CMI5_IRIS.sessionId]).toBe(sessionId);
      expect(s).not.toHaveProperty('version');   // left for the LMS's LRS, which may speak xAPI 1.0.3
    }
    const defined = stream.filter(s => ['initialized', 'completed', 'terminated'].includes(verbOf(s)));
    for (const s of defined) {
      expect(categories(s)).toEqual([CMI5_IRIS.category]);
      expect((s.object as { id: string }).id).toBe(attempt.activityId);
    }
    for (const s of stream.filter(s => !defined.includes(s))) expect(categories(s)).not.toContain(CMI5_IRIS.category);
    // One completion, the AU's: the play's own completion of the composition is left out.
    expect(stream.filter(s => verbOf(s) === 'completed')).toHaveLength(1);
    expect(stream.at(-2)!.result).toMatchObject({ completion: true, duration: 'PT1.23S' });
  });

  it('judges a pass by the LMS\'s mastery score when it gives one, and by every graded question right when it asks for a pass without one', () => {
    const graded = { correct: 1, total: 2 };
    const verbs = (a: Cmi5Attempt, g = graded) => closingStatements(a, g, at(), 0).map(verbOf);
    expect(verbs(attempt)).toEqual(['completed', 'terminated']);   // moveOn Completed: no judgment asked for
    const withMastery = { ...attempt, masteryScore: 0.5 };
    expect(verbs(withMastery)).toEqual(['completed', 'passed', 'terminated']);
    const passed = closingStatements(withMastery, graded, at(), 0)[1]!;
    expect(passed.result).toMatchObject({ score: { scaled: 0.5, raw: 1, min: 0, max: 2 }, success: true });
    expect((passed.context as { extensions: Record<string, unknown> }).extensions[CMI5_IRIS.masteryScore]).toBe(0.5);
    expect(verbs({ ...attempt, masteryScore: 0.8 })).toEqual(['completed', 'failed', 'terminated']);
    expect(verbs({ ...attempt, moveOn: 'CompletedAndPassed' })).toEqual(['completed', 'failed', 'terminated']);
    expect(verbs({ ...attempt, moveOn: 'CompletedAndPassed' }, { correct: 2, total: 2 })).toEqual(['completed', 'passed', 'terminated']);
    expect(verbs(withMastery, { correct: 0, total: 0 })).toEqual(['completed', 'terminated']);   // nothing graded, nothing to judge
  });

  it('does not judge a Browse or Review launch: only terminated closes it', () => {
    for (const launchMode of ['Browse', 'Review'] as const) {
      expect(closingStatements({ ...attempt, masteryScore: 0.5, launchMode }, { correct: 2, total: 2 }, at(), 0).map(verbOf)).toEqual(['terminated']);
    }
    expect(closingStatements({ ...attempt, launchMode: 'Normal' }, { correct: 2, total: 2 }, at(), 0).map(verbOf)).toEqual(['completed', 'terminated']);
  });
});

describe('the AU page an LMS launches', () => {
  const windows: JSDOM[] = [];
  afterAll(() => { for (const w of windows) w.window.close(); });

  /** An LMS with an LRS, and a bridge built from the modules its routes use, behind one fetch. */
  function world(opts: { refuseFirstStatements?: boolean; returnURL?: string; launchMode?: string } = {}) {
    const lrs: Array<{ auth: string; version: string; statements: Statement[] }> = [];
    let refused = !opts.refuseFirstStatements;
    let play: PlayInProgress & { attempt?: Cmi5Attempt; startedAt?: number } = { play: undefined as unknown as CompositionPlay };
    const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    const fetchFn = async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const headers = (init.headers ?? {}) as Record<string, string>;
      if (u.pathname === '/cmi5/fetch/one') return json(200, { 'auth-token': 'launch-token' });
      if (u.pathname === '/xapi/activities/state') return json(200, { contextTemplate: attempt.contextTemplate, launchMode: opts.launchMode ?? 'Normal', moveOn: 'Completed', ...(opts.returnURL ? { returnURL: opts.returnURL } : {}) });
      if (u.pathname === '/xapi/statements') {
        if (!refused) { refused = true; return json(503, {}); }
        lrs.push({ auth: headers.Authorization!, version: headers['X-Experience-API-Version']!, statements: JSON.parse(String(init.body)) });
        return json(200, []);
      }
      const b = JSON.parse(String(init.body ?? '{}'));
      if (u.pathname.endsWith('/au/session')) {
        const a = cmi5AttemptFrom(b);
        if (typeof a === 'string') return json(400, { error: a });
        play = { ...attemptPlay(a), attempt: a, startedAt: Date.now() };
        return json(200, { session: play.play.id, step: currentView(play.play), statements: [definedStatement('initialized', a, at())] });
      }
      if (u.pathname.endsWith('/au/next')) {
        const taken = await takeStep(play, b.answers, { actor: play.attempt!.actor, now: new Date().toISOString(), newId: randomUUID }, keepNothing);
        if (!taken.ok) return json(taken.status, { error: taken.error });
        const statements = attemptStatements(taken.step.statements, play.attempt!);
        if (taken.step.done) statements.push(...closingStatements(play.attempt!, play.play.graded, at(), Date.now() - play.startedAt!));
        return json(200, { done: taken.step.done, statements, ...(taken.step.graded ? { graded: taken.step.graded } : {}),
          ...(taken.step.done ? { summary: { graded: play.play.graded } } : { step: currentView(play.play) }) });
      }
      return json(404, {});
    };
    const launch = new URL('https://bridge.example/ns/foxxi/composition/abc/au');
    for (const [k, v] of Object.entries({ endpoint: 'https://lms.example/xapi/', fetch: 'https://lms.example/cmi5/fetch/one', actor: JSON.stringify(attempt.actor), registration: attempt.registration, activityId: attempt.activityId })) launch.searchParams.set(k, v);
    const dom = new JSDOM(compositionAuPage({ title: course.title, sessionBase: 'https://bridge.example/ns/foxxi/composition/abc/au' }), {
      runScripts: 'dangerously', url: launch.toString(),
      beforeParse(w) { Object.defineProperty(w, 'fetch', { value: fetchFn }); },
    });
    windows.push(dom);
    const doc = dom.window.document;
    return { lrs, doc, go: () => (doc.getElementById('go') as HTMLButtonElement), status: () => doc.getElementById('status')!.textContent ?? '' };
  }

  it('plays the attempt through, sending every statement to the LMS under Basic, in order, with no answer on the page', async () => {
    const w = world({ returnURL: 'https://lms.example/return' });
    await expect.poll(() => w.go().disabled).toBe(false);
    expect(w.doc.getElementById('step')!.innerHTML).toContain('<strong>$250</strong>');
    expect(w.doc.documentElement.outerHTML).not.toMatch(/answerHash|verifier|salt|blind|Leads approve/);
    w.go().click();
    await expect.poll(() => w.doc.querySelectorAll('input[name="q0"]').length).toBe(2);
    expect(w.doc.documentElement.outerHTML).not.toMatch(/answerHash|verifier|salt|blind|Leads approve/);
    (w.doc.querySelector('input[name="q0"][value="B"]') as HTMLInputElement).checked = true;
    (w.doc.querySelector('input[name="q1"][value="true"]') as HTMLInputElement).checked = true;
    await expect.poll(() => w.go().disabled).toBe(false);
    w.go().click();
    await expect.poll(() => w.status()).toContain('Done: 2 of 2 graded questions right.');
    expect(w.doc.getElementById('feedback')!.textContent).toContain('Leads approve above $250.');   // an explanation, once answered
    expect((w.doc.querySelector('#status a') as HTMLAnchorElement).href).toBe('https://lms.example/return');
    const sent = w.lrs.flatMap(x => x.statements);
    expect(sent.map(verbOf)).toEqual(['initialized', 'experienced', 'answered', 'answered', 'experienced', 'completed', 'terminated']);
    expect(w.lrs.every(x => x.auth === 'Basic launch-token' && x.version === '1.0.3')).toBe(true);
  });

  it('offers no way back that is not a web address, and plays a Browse launch without judging it', async () => {
    const w = world({ returnURL: 'javascript:alert(document.cookie)', launchMode: 'Browse' });
    await expect.poll(() => w.go().disabled).toBe(false);
    w.go().click();
    await expect.poll(() => w.doc.querySelectorAll('input[name="q0"]').length).toBe(2);
    (w.doc.querySelector('input[name="q0"][value="B"]') as HTMLInputElement).checked = true;
    (w.doc.querySelector('input[name="q1"][value="true"]') as HTMLInputElement).checked = true;
    await expect.poll(() => w.go().disabled).toBe(false);
    w.go().click();
    await expect.poll(() => w.status()).toContain('Done');
    expect(w.doc.querySelector('#status a')).toBeNull();
    expect(w.lrs.flatMap(x => x.statements).map(verbOf)).toEqual(['initialized', 'experienced', 'answered', 'answered', 'experienced', 'terminated']);
  });

  it('is served with a policy that lets its one script run and no other', () => {
    const html = compositionAuPage({ title: course.title, sessionBase: 'https://bridge.example/ns/foxxi/composition/abc/au' });
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    const csp = compositionAuPageCsp(html);
    const scriptSrc = csp.split('; ').find(d => d.startsWith('script-src '))!;
    expect(scriptSrc).toBe(`script-src 'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-ancestors *');   // an LMS frames it
    expect((html.match(/<script>/g) ?? []).length).toBe(1);
  });

  it('sends again what the LMS refused, before anything more is taken', async () => {
    const w = world({ refuseFirstStatements: true });
    await expect.poll(() => w.status()).toMatch(/did not take the record \(503\)/);
    expect(w.go().disabled).toBe(true);
    (w.doc.getElementById('retry') as HTMLButtonElement).click();
    await expect.poll(() => w.go().disabled).toBe(false);
    expect(w.lrs.flatMap(x => x.statements).map(verbOf)).toEqual(['initialized']);
  });
});

describe('the bridge serves the projection and plays an attempt without keeping it', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n});', src.indexOf(from)));

  it('resolves for a learner it cannot verify with no record, and counts and keeps nothing', () => {
    const session = route("app.post('/ns/foxxi/composition/:hash/au/session'");
    expect(session.indexOf('contentRateLimited(req, res)')).toBeGreaterThan(0);
    expect(session.indexOf('contentRateLimited(req, res)')).toBeLessThan(session.indexOf('cmi5AttemptFrom('));
    expect(session).toMatch(/const resolution = resolveComposition\(\{ composition: root, learner, lookup: iri => contentStore\.get\(iri\) \}\);/);
    const next = route("app.post('/ns/foxxi/composition/:hash/au/next'");
    expect(next.indexOf('contentRateLimited(req, res)')).toBeGreaterThan(0);
    expect(next).toMatch(/async statements => statements\.map\(x => String\(x\.id\)\)\);/);
    for (const r of [session, next]) {
      expect(r).not.toMatch(/fragmentEfficacy|outcomeToken|persistEfficacy|recordPlayStatements|storeStatement|composeIntoSharedLattice|learnerCompetencies|learnerAdmissions/);
    }
    // An attempt is played only under the composition it was launched for.
    expect(next).toMatch(/!entry\.play\.composition\.iri\.endsWith\(`\/\$\{String\(req\.params\.hash\)\}`\)/);
    expect(route("app.get('/ns/foxxi/composition/:hash/cmi5.xml'")).toMatch(/compositionCourseStructure\(item, `\$\{bridgeBaseUrl\}\/ns\/foxxi\/composition\/\$\{hash\}\/au`\)/);
    expect(route("app.get('/ns/foxxi/composition/:hash/au'")).toMatch(/res\.setHeader\('Content-Security-Policy', compositionAuPageCsp\(page\)\);/);
  });
});
