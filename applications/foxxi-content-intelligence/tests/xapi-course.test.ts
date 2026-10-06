import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { authorXapiCourse, xapiCourseArtifact, xapiCourseLinks } from '../src/xapi-course.js';
import { ContentError, fragmentIsIntact } from '../src/content-fragments.js';
import { isCompositionItem, ContentStore } from '../src/content-store.js';
import { compositionIsIntact, resolveComposition } from '../src/compositions.js';
import { currentView, PLAY_EXT, startPlay, takeStep, type PlayInProgress, type Statement } from '../src/composition-play.js';

interface FixtureCourse { title: string; competency: string; modules: Array<{ title: string; competency?: string; lessons: Array<{ title: string; competency?: string; fragments: Array<{ kind: string; body: string; competencies?: string[]; questions?: Array<{ question: string; type: string; answer: string }> }> }> }> }
const raw = (): FixtureCourse => ({ title: 'Native xAPI authoring', competency: 'native-authoring', modules: [{
  title: 'Make and verify', lessons: [{ title: 'Learn and check', fragments: [
    { kind: 'concept', body: 'Read the lesson and answer the check.' },
    { kind: 'assessment-item', body: 'Check your understanding.', questions: [{ question: 'Verification marker?', type: 'fill-in', answer: 'private-marker-74391' }] },
  ] }],
}] });
const authored = () => {
  const built = authorXapiCourse(raw());
  const store = new ContentStore();
  for (const item of built.items) store.put(item);
  return { ...built, store };
};
const learner = { id: 'urn:learner:synthetic', kind: 'agent' as const };
const actor = { objectType: 'Agent', account: { homePage: 'https://example.test', name: learner.id } };
const playOf = (course: ReturnType<typeof authored>): PlayInProgress => ({ play: startPlay(
  resolveComposition({ composition: course.root, learner, lookup: iri => course.store.get(iri) }),
  course.root.title, learner, { session: randomUUID(), registration: randomUUID() }, '2026-10-06T12:00:00Z',
)! });
const ctx = () => ({ actor, now: '2026-10-06T12:01:00Z', newId: randomUUID });
const verb = (s: Statement) => String((s.verb as { id: string }).id).split('/').at(-1);

describe('native xAPI course authoring', () => {
  it('authors modules and lessons as intact format-neutral compositions with actual fragments', () => {
    const course = authored();
    expect(course.modules).toBe(1); expect(course.lessons).toBe(1); expect(course.items).toHaveLength(5);
    expect(course.items.every(x => isCompositionItem(x) ? compositionIsIntact(x) : fragmentIsIntact(x))).toBe(true);
    const resolved = resolveComposition({ composition: course.root, learner, lookup: iri => course.store.get(iri) });
    expect(resolved.steps.map(s => s.fragment.kind)).toEqual(['concept', 'assessment-item']);
    expect(JSON.stringify(course.items)).not.toContain('private-marker-74391');
  });

  it('exports readable public content and native launch without answer verifiers or credentials', () => {
    const course = authored();
    const artifact = xapiCourseArtifact(course.root, iri => course.store.get(iri), 'https://bridge.test');
    expect(artifact).toMatchObject({ format: 'foxxi-native-xapi-course/v1', tracking: { version: '2.0.0' }, launch: { tool: 'foxxi.content_launch', payload: { composition: course.root['@id'] } } });
    expect((artifact.content as unknown[])).toHaveLength(5);
    const json = JSON.stringify(artifact);
    for (const secret of ['private-marker-74391', 'answerHash', 'salt', '"blind"', 'auth-token', 'Authorization']) expect(json).not.toContain(secret);
    expect(xapiCourseLinks(course.root, 'https://bridge.test/').xapi).toMatch(/^https:\/\/bridge\.test\/ns\/foxxi\/composition\/[0-9a-f]{64}\/xapi\.json$/);
  });

  it('rejects contradictory fragment competencies and credits an explicit lesson override correctly', async () => {
    const contradictory = raw(); contradictory.modules[0]!.lessons[0]!.fragments[1]!.competencies = ['other-competency'];
    expect(() => authorXapiCourse(contradictory)).toThrow(/must include its lesson competency/);
    contradictory.modules[0]!.lessons[0]!.competency = 'other-competency';
    const built = authorXapiCourse(contradictory), store = new ContentStore(); built.items.forEach(x => store.put(x));
    const entry = playOf({ ...built, store }), statements: Statement[] = [];
    const keep = async (ss: readonly Statement[]) => { statements.push(...ss); return ss.map(s => String(s.id)); };
    await takeStep(entry, [], ctx(), keep); await takeStep(entry, ['private-marker-74391'], ctx(), keep);
    const answered = statements.find(s => verb(s) === 'answered')!;
    const competency = (answered.context as { extensions: Record<string, string> }).extensions[PLAY_EXT.competency];
    expect(competency).toMatch(/other-competency$/);
  });

  it.each([['private-marker-74391', true], ['wrong', false]])('grades %s through the existing native composition player', async (answer, success) => {
    const course = authored(), entry = playOf(course), statements: Statement[] = [];
    const keep = async (ss: readonly Statement[]) => { statements.push(...ss); return ss.map(s => String(s.id)); };
    const first = await takeStep(entry, [], ctx(), keep);
    expect(first.ok).toBe(true); expect(currentView(entry.play)).toBeTruthy();
    const checked = await takeStep(entry, [answer], ctx(), keep);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.step.done).toBe(true);
    expect(checked.step.graded).toMatchObject({ correct: success ? 1 : 0, total: 1 });
    expect(statements.map(verb)).toEqual(['experienced', 'answered', 'experienced', 'completed']);
    expect((statements.find(s => verb(s) === 'answered')!.result as { success: boolean }).success).toBe(success);
    expect(statements.every(s => (s.context as { registration: string }).registration === entry.play.registration)).toBe(true);
    expect(statements.every(s => s.version === '2.0.0')).toBe(true);
    expect(JSON.stringify(statements.map(s => s.object))).not.toContain('correctResponsesPattern');
  });

  it('keeps a failed record pending and retries identical statement IDs without grading changed answers', async () => {
    const entry = playOf(authored());
    await takeStep(entry, [], ctx(), async ss => ss.map(s => String(s.id)));
    const attempted: Statement[][] = [];
    const failed = await takeStep(entry, ['private-marker-74391'], { ...ctx(), expectedStep: 2 }, async ss => { attempted.push([...ss]); return null; });
    expect(failed).toMatchObject({ ok: false, status: 503 });
    const retried = await takeStep(entry, ['wrong'], { ...ctx(), expectedStep: 2 }, async ss => { attempted.push([...ss]); return ss.map(s => String(s.id)); });
    expect(retried).toMatchObject({ ok: true, resumed: true, step: { graded: { correct: 1, total: 1 }, done: true } });
    expect(attempted[1]).toEqual(attempted[0]);
  });

  it('replays a guarded successful receipt after a lost acknowledgement without advancing or writing again', async () => {
    const entry = playOf(authored());
    let writes = 0;
    const keep = async (ss: readonly Statement[]) => { writes++; return ss.map(s => String(s.id)); };
    const first = await takeStep(entry, [], { ...ctx(), expectedStep: 1 }, keep);
    const retry = await takeStep(entry, ['wrong'], { ...ctx(), expectedStep: 1 }, keep);
    expect(retry).toMatchObject({ ...first, replayed: true });
    expect(writes).toBe(1); expect(entry.play.at).toBe(1);
    const checked = await takeStep(entry, ['private-marker-74391'], { ...ctx(), expectedStep: 2 }, keep);
    const finalRetry = await takeStep(entry, ['wrong'], { ...ctx(), expectedStep: 2 }, keep);
    expect(finalRetry).toMatchObject({ ...checked, replayed: true, step: { done: true, graded: { correct: 1 } } });
    expect(writes).toBe(2); expect(entry.play.graded).toEqual({ correct: 1, total: 1 });
  });

  it('refuses stale and invalid guarded steps before grading or recording', async () => {
    const input = raw(); input.modules[0]!.lessons[0]!.fragments.push({ kind: 'concept', body: 'Finish reading.' });
    const built = authorXapiCourse(input), store = new ContentStore(); built.items.forEach(x => store.put(x));
    const entry = playOf({ ...built, store });
    let writes = 0;
    const keep = async (ss: readonly Statement[]) => { writes++; return ss.map(s => String(s.id)); };
    await takeStep(entry, [], { ...ctx(), expectedStep: 1 }, keep);
    await takeStep(entry, ['private-marker-74391'], { ...ctx(), expectedStep: 2 }, keep);
    expect(await takeStep(entry, [], { ...ctx(), expectedStep: 1 }, keep)).toMatchObject({ ok: false, status: 409 });
    expect(await takeStep(entry, [], { ...ctx(), expectedStep: 0 }, keep)).toMatchObject({ ok: false, status: 400 });
    expect(writes).toBe(2); expect(entry.play.at).toBe(2);
  });

  it('does not turn unassessed reading into a passing score', async () => {
    const input = raw(); input.modules[0]!.lessons[0]!.fragments.splice(1);
    const built = authorXapiCourse(input), store = new ContentStore(); built.items.forEach(x => store.put(x));
    const entry = playOf({ ...built, store });
    const statements: Statement[] = [];
    const done = await takeStep(entry, [], ctx(), async ss => { statements.push(...ss); return ss.map(s => String(s.id)); });
    expect(done).toMatchObject({ ok: true, step: { done: true } });
    expect(statements.map(verb)).toEqual(['experienced', 'completed']);
    expect(statements.every(s => !(s.result as { score?: unknown }).score && (s.result as { success?: unknown }).success === undefined)).toBe(true);
  });

  it('rejects malformed content before anything can be kept and reports an incomplete export', () => {
    for (const input of [null, {}, { ...raw(), modules: [] }, { ...raw(), modules: [{ title: 'Empty', lessons: [] }] }]) expect(() => authorXapiCourse(input)).toThrow(ContentError);
    const bad = raw(); bad.modules[0]!.lessons[0]!.fragments[1]!.questions![0]!.answer = '';
    expect(() => authorXapiCourse(bad)).toThrow(ContentError);
    const course = authored(); expect(() => xapiCourseArtifact(course.root, () => undefined, 'https://bridge.test')).toThrow(/unavailable/);
  });

  it('bounds the total hierarchy, not just each module', () => {
    const input = raw(); input.modules = Array.from({ length: 2 }, (_, i) => ({ title: `Module ${i}`, lessons: Array.from({ length: 51 }, (_, j) => ({ title: `Lesson ${j}`, fragments: [{ kind: 'concept', body: 'Read.' }] })) }));
    expect(() => authorXapiCourse(input)).toThrow(/100 lessons in total/);
  });

  it('wires a distinct signed author capability and preserves existing SCORM routes', () => {
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    const route = server.slice(server.indexOf("app.post('/agent/xapi/author'"), server.indexOf("app.post('/agent/content/composition'"));
    expect(route).toContain('verifyDelegatedCaller(req.body)'); expect(route).toContain('keepContentBundle(');
    expect(route.indexOf('keepContentBundle(')).toBeLessThan(route.indexOf('sendActionResult('));
    for (const forbidden of ['parseManifest(', 'buildAgentScormManifest(', 'startAttempt(', 'commitTracking(', '/agent/scorm/author']) expect(route).not.toContain(forbidden);
    expect(server).toContain("app.post('/agent/scorm/author'"); expect(server).toContain("app.post('/agent/content/launch'");
    expect(server).toContain('if (!taken.replayed && await ensureEfficacy())');
    expect(server).toContain('if (outcome.done && p.expected_step === undefined) contentPlays.delete(entry.play.id)');
    const manifest = readFileSync(new URL('../affordances.ts', import.meta.url), 'utf8');
    expect(manifest).toContain("toolName: 'foxxi.xapi_author'"); expect(manifest).toContain("targetTemplate: '{base}/agent/xapi/author'");
    const hmd = readFileSync(new URL('../src/hypermedia.ts', import.meta.url), 'utf8');
    expect(hmd).toContain('...affordanceControl(launch, base)'); expect(hmd).toContain("id: 'launch-native'");
  });
});
