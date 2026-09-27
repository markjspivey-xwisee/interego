/**
 * Playing a composition: a learner, person or agent, steps through what resolution chose for them,
 * graded against the stored questions, and each step is recorded as xAPI naming the fragment, its
 * position and the alternatives it was chosen from. Every statement follows the Foxxi xAPI
 * profile, and no interaction activity carries its correct responses. A step counts only once its
 * record is kept: until then it stays answered but pending, and taking it again keeps the very
 * same statements.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { advancePlay, currentView, interactionDefinition, PLAY_EXT, PLAY_TYPES, startPlay, takeStep, type PlayInProgress, type Statement } from '../src/composition-play.js';
import { getStatementStore, storeStatementDurably } from '../src/xapi-lrs.js';
import type { TenantId } from '../src/tenant-context.js';
import { fragmentFrom, publicFragment, type Fragment } from '../src/content-fragments.js';
import { compositionFrom, resolveComposition, type Composition } from '../src/compositions.js';
import { validateAgainstProfileTemplates } from '../src/xapi-profile.js';

const lesson = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: ['refund-authority'], title: 'Who approves', body: 'Agents refund up to $250.' });
const check = fragmentFrom({
  kind: 'assessment-item', competencies: ['refund-authority'], title: 'Check', body: 'Check yourself.',
  questions: [
    { question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B', explanation: 'Leads approve above $250.' },
    { question: 'Order the steps', items: ['Verify', 'Refund', 'Log'] },
    { question: 'Match each amount', pairs: [['$100', 'Agent'], ['$600', 'Team lead']] },
    { question: 'How sure are you?', type: 'likert' },
  ],
});
const store = new Map<string, Fragment | Composition>([lesson, check].map(x => [x['@id'], x]));
const course = compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [
  { competency: 'refund-authority', paradigm: [lesson['@id']] },
  { competency: 'refund-authority', paradigm: [check['@id']] },
] });
const learner = { id: 'did:web:learner.example', kind: 'human' as const };
const actor = { objectType: 'Agent', account: { homePage: 'did:web:bridge.example', name: learner.id } };
let n = 0;
const ctx = { actor, now: '2026-09-26T12:00:00.000Z', newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, platform: 'Foxxi' };
const play = () => startPlay(resolveComposition({ composition: course, learner, lookup: i => store.get(i) }), course.title, learner,
  { session: 'session-1', registration: '11111111-2222-4333-8444-555555555555' }, ctx.now)!;
/** The answers the check takes to be right, from its shown order. */
const rightAnswers = (): string[] => {
  const q = check.questions!;
  const shown = q[1]!.input!.items!;
  const targets = q[2]!.input!.targets!;
  return ['B', ['Verify', 'Refund', 'Log'].map(i => String.fromCharCode(65 + shown.indexOf(i))).join(', '),
    [targets.indexOf('Agent'), targets.indexOf('Team lead')].map(k => String.fromCharCode(65 + k)).join(', '), 'D'];
};
const follows = (s: Statement): string[] => {
  const r = validateAgainstProfileTemplates(s);
  expect(r.violations, JSON.stringify(r.violations)).toEqual([]);
  return r.matchedTemplates;
};

describe('a play steps through what resolution chose, in order', () => {
  it('starts on the first step, shown as the learner receives it, and has nothing to play when nothing was chosen', () => {
    const p = play();
    expect(currentView(p)).toMatchObject({ step: 1, of: 2, competency: course.positions[0]!.competency, fragment: { '@id': lesson['@id'] } });
    expect(JSON.stringify(currentView(p))).not.toMatch(/answerHash|salt|blind/);
    const empty = resolveComposition({ composition: course, learner, lookup: () => undefined });
    expect(startPlay(empty, course.title, learner, { session: 's', registration: 'r' }, ctx.now)).toBeUndefined();
  });

  it('records a step without questions as the fragment experienced, with where it sat and why', () => {
    const p = play();
    const r = advancePlay(p, undefined, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.done).toBe(false);
    expect(r.statements).toHaveLength(1);
    const [s] = r.statements;
    expect(s).toMatchObject({ verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' }, object: { id: lesson['@id'], definition: { type: PLAY_TYPES.fragment } }, result: { completion: true } });
    const c = s!.context as { registration: string; contextActivities: { parent: Array<{ id: string }> }; extensions: Record<string, unknown> };
    expect(c.registration).toBe(p.registration);
    expect(c.contextActivities.parent[0]!.id).toBe(course['@id']);
    expect(c.extensions).toMatchObject({ [PLAY_EXT.position]: 0, [PLAY_EXT.alternatives]: [lesson['@id']], [PLAY_EXT.chosenBecause]: 'the only alternative', [PLAY_EXT.actorKind]: 'human', [PLAY_EXT.contextKind]: 'training' });
    expect(follows(s!)).toContain('https://foxxi-bridge.interego.xwisee.com/xapi/profile/templates/fragment-experienced');
    expect(currentView(p)).toMatchObject({ step: 2, of: 2 });
  });

  it('refuses answers it cannot take without moving on', () => {
    const p = play();
    advancePlay(p, undefined, ctx);
    const r = advancePlay(p, ['B'], ctx);
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(currentView(p)).toMatchObject({ step: 2 });
  });
});

describe('answers are graded by the bridge and recorded as interactions without their answers', () => {
  it('grades each answer against its stored question, and records it in the profile\'s own shape', () => {
    const p = play();
    advancePlay(p, undefined, ctx);
    const answers = rightAnswers();
    answers[0] = 'A';   // one wrong
    const r = advancePlay(p, answers, ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.graded).toMatchObject({ correct: 2, total: 3 });
    expect(r.graded!.detail.map(d => d.correct)).toEqual([false, true, true, null]);
    expect(r.graded!.detail[0]!.explanation).toBe('Leads approve above $250.');
    const answered = r.statements.filter(s => (s.verb as { id: string }).id.endsWith('/answered'));
    expect(answered).toHaveLength(4);
    for (const s of answered) {
      expect(follows(s)).toContain('https://foxxi-bridge.interego.xwisee.com/xapi/profile/templates/question-answered');
      expect(JSON.stringify(s)).not.toMatch(/correctResponsesPattern|answerHash|salt|blind|Leads approve/);
    }
    const defs = answered.map(s => (s.object as { definition: Record<string, unknown> }).definition);
    expect(defs.map(d => d.interactionType)).toEqual(['choice', 'sequencing', 'matching', 'likert']);
    expect(defs[0]!.choices).toEqual([{ id: 'a', description: { en: 'Agent' } }, { id: 'b', description: { en: 'Team lead' } }]);
    expect(defs[2]!.source).toEqual([{ id: '1', description: { en: '$100' } }, { id: '2', description: { en: '$600' } }]);
    expect(defs[3]!.scale).toHaveLength(5);
    expect(answered.map(s => (s.result as { response: string }).response)[0]).toBe('a');
    expect(answered.map(s => (s.result as { success?: boolean }).success)).toEqual([false, true, true, undefined]);
    expect((answered[0]!.object as { id: string }).id).toBe(`${check['@id']}#question-1`);
  });

  it('scores the fragment and, on the last step, completes the composition over every graded question', () => {
    const p = play();
    advancePlay(p, undefined, ctx);
    const r = advancePlay(p, rightAnswers(), ctx);
    if (!r.ok) throw new Error(r.error);
    expect(r.done).toBe(true);
    const experienced = r.statements.find(s => (s.verb as { id: string }).id.endsWith('/experienced'))!;
    expect(experienced.result).toEqual({ completion: true, score: { raw: 3, max: 3, min: 0, scaled: 1 }, success: true });
    const completed = r.statements.at(-1)!;
    expect(completed).toMatchObject({ verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: course['@id'], definition: { type: PLAY_TYPES.composition } }, result: { completion: true, score: { raw: 3, max: 3, scaled: 1 } } });
    expect(follows(completed)).toContain('https://foxxi-bridge.interego.xwisee.com/xapi/profile/templates/composition-completed');
    expect(new Set(r.statements.map(s => (s.context as { registration: string }).registration))).toEqual(new Set([p.registration]));
    expect(p.endedAt).toBe(ctx.now);
    expect(advancePlay(p, [], ctx)).toMatchObject({ ok: false, status: 409 });
  });

  it('records the same way for an agent learner', () => {
    const agent = { id: 'did:web:agent.example', kind: 'agent' as const };
    const p = startPlay(resolveComposition({ composition: course, learner: agent, lookup: i => store.get(i) }), course.title, agent, { session: 's2', registration: 'r2' }, ctx.now)!;
    const r = advancePlay(p, undefined, ctx);
    if (!r.ok) throw new Error(r.error);
    expect((r.statements[0]!.context as { extensions: Record<string, unknown> }).extensions[PLAY_EXT.actorKind]).toBe('agent');
  });

  it('builds an interaction from the public view alone', () => {
    const view = publicFragment(check).questions![0]!;
    expect(interactionDefinition(view)).toEqual({
      type: PLAY_TYPES.interaction, interactionType: 'choice', description: { en: 'Who approves $600?' },
      choices: [{ id: 'a', description: { en: 'Agent' } }, { id: 'b', description: { en: 'Team lead' } }],
    });
  });

  it('keys every language map by the fragment\'s language, not by English', () => {
    const pt = fragmentFrom({
      kind: 'assessment-item', language: 'pt-BR', competencies: ['refund-authority'], title: 'Verificação', body: 'Verifique.',
      questions: [{ question: 'Quem aprova R$600?', options: ['Agente', 'Líder'], answer: 'B' }, { question: 'Ordene', items: ['Verificar', 'Reembolsar'] }],
    });
    const c = compositionFrom({ title: 'Reembolsos', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [pt['@id']] }] });
    const p = startPlay(resolveComposition({ composition: c, learner, lookup: i => (i === pt['@id'] ? pt : undefined) }), c.title, learner, { session: 's3', registration: 'r3' }, ctx.now)!;
    const shown = pt.questions![1]!.input!.items!;
    const r = advancePlay(p, ['B', ['Verificar', 'Reembolsar'].map(i => String.fromCharCode(65 + shown.indexOf(i))).join(', ')], ctx);
    if (!r.ok) throw new Error(r.error);
    const [choice, order, experienced] = r.statements.map(x => (x.object as { definition: Record<string, unknown> }).definition);
    expect(choice).toMatchObject({ description: { 'pt-BR': 'Quem aprova R$600?' }, choices: [{ id: 'a', description: { 'pt-BR': 'Agente' } }, { id: 'b', description: { 'pt-BR': 'Líder' } }] });
    expect(order!.choices).toEqual(shown.map((x, i) => ({ id: String.fromCharCode(97 + i), description: { 'pt-BR': x } })));
    expect(experienced!.name).toEqual({ 'pt-BR': 'Verificação' });
    for (const d of [choice, order, experienced]) expect(JSON.stringify(d)).not.toMatch(/"en"/);
    expect(interactionDefinition(publicFragment(check).questions![2]!, 'fr')).toMatchObject({
      source: [{ id: '1', description: { fr: '$100' } }, { id: '2', description: { fr: '$600' } }],
      target: expect.arrayContaining([expect.objectContaining({ description: { fr: 'Agent' } })]),
    });
  });
});

describe('a step counts only once its record is kept', () => {
  const keepAll = async (st: readonly Statement[]): Promise<string[]> => st.map(x => String(x.id));

  it('keeps a step answered but pending when its record cannot be kept, and keeps the very same statements next time', async () => {
    const entry: PlayInProgress = { play: play() };
    expect(await takeStep(entry, undefined, ctx, keepAll)).toMatchObject({ ok: true, resumed: false, step: { done: false } });
    const offered: Statement[][] = [];
    const flaky = async (st: readonly Statement[]): Promise<string[] | null> => { offered.push([...st]); return offered.length === 1 ? null : st.map(x => String(x.id)); };
    expect(await takeStep(entry, rightAnswers(), ctx, flaky)).toMatchObject({ ok: false, status: 503 });
    expect(entry.pending).toBeDefined();
    // Answers sent with the retry are not taken: the step was answered, only its record is outstanding.
    const other = rightAnswers();
    other[0] = 'A';
    const retried = await takeStep(entry, other, ctx, flaky);
    if (!retried.ok) throw new Error(retried.error);
    expect(retried.resumed).toBe(true);
    expect(offered[1]).toEqual(offered[0]);
    expect(retried.recorded).toEqual(offered[0]!.map(x => x.id));
    expect(retried.step).toMatchObject({ done: true, graded: { correct: 3, total: 3 } });
    expect(retried.step.outcomes.map(o => [o.fragment, o.success])).toEqual([[check['@id'], true], [lesson['@id'], true]]);
    expect(entry.pending).toBeUndefined();
    expect(await takeStep(entry, [], ctx, keepAll)).toMatchObject({ ok: false, status: 409 });   // the play is done
  });

  it('fixes each statement\'s final form once, before the first attempt to keep it', async () => {
    const entry: PlayInProgress = { play: play() };
    let marks = 0;
    const mark = (st: Statement): Statement => ({ ...st, context: { ...(st.context as object), extensions: { ...((st.context as { extensions?: object }).extensions), 'https://example.org/mark': ++marks } } });
    let attempts = 0;
    const keep = async (st: readonly Statement[]): Promise<string[] | null> => (++attempts === 1 ? null : st.map(x => String(x.id)));
    await takeStep(entry, undefined, ctx, keep, mark);
    expect(marks).toBe(1);
    const r = await takeStep(entry, undefined, ctx, keep, mark);
    expect(marks).toBe(1);
    expect(r).toMatchObject({ ok: true, resumed: true });
  });

  it('takes one step at a time for a play, and a refused answer leaves nothing pending', async () => {
    const entry: PlayInProgress = { play: play() };
    let release: (ids: string[] | null) => void = () => undefined;
    const slow = (): Promise<string[] | null> => new Promise(r => { release = r; });
    const first = takeStep(entry, undefined, ctx, slow);
    expect(await takeStep(entry, rightAnswers(), ctx, keepAll)).toMatchObject({ ok: false, status: 409 });
    release(['kept']);
    expect(await first).toMatchObject({ ok: true, recorded: ['kept'] });
    expect(currentView(entry.play)).toMatchObject({ step: 2 });
    expect(await takeStep(entry, ['B'], ctx, keepAll)).toMatchObject({ ok: false, status: 422 });
    expect(entry.pending).toBeUndefined();
    expect(entry.busy).toBe(false);
  });

  it('leaves the step pending, and the play free, when keeping it throws', async () => {
    const entry: PlayInProgress = { play: play() };
    await expect(takeStep(entry, undefined, ctx, async () => { throw new Error('pod unreachable'); })).rejects.toThrow('pod unreachable');
    expect(entry.busy).toBe(false);
    expect(entry.pending).toBeDefined();
    expect(await takeStep(entry, undefined, ctx, keepAll)).toMatchObject({ ok: true, resumed: true });
  });

  it('waits for the store to hold a statement, and says so only when it does', async () => {
    const tenant = 'lens:kept-statements-test' as TenantId;
    const statement = {
      id: '0f0e0d0c-0b0a-4009-8008-070605040302', actor,
      verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { en: 'experienced' } },
      object: { objectType: 'Activity', id: 'https://example.org/fragment' }, timestamp: ctx.now,
    };
    expect(await storeStatementDurably(statement, tenant)).toBe(statement.id);
    expect((await getStatementStore(tenant).get(statement.id))?.statement).toMatchObject({ id: statement.id });
    expect(await storeStatementDurably(statement, tenant)).toBe(statement.id);   // the same statement again: held once
    expect(await storeStatementDurably({ ...statement, object: { objectType: 'Activity', id: 'https://example.org/other' } }, tenant)).toBeNull();   // the write is refused
    expect(await storeStatementDurably({ ...statement, id: '1f0e0d0c-0b0a-4009-8008-070605040302', verb: { id: 'not an IRI' } }, tenant)).toBeNull();   // not conformant
    expect(await getStatementStore(tenant).get('1f0e0d0c-0b0a-4009-8008-070605040302')).toBeNull();
  });
});

describe('the bridge launches and steps a play for its own learner', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n});', src.indexOf(from)));

  it('launches from the same resolution resolve uses, and only the learner can step it', () => {
    const shared = route('async function resolveForCaller');
    expect(shared).toMatch(/contentStore\.gather\(root\)/);
    expect(shared).toMatch(/learnerCompetencies\(callerDid, kind\)/);
    expect(shared).toMatch(/admissionFrom\(p\.admission\)/);
    expect(route("app.post('/agent/content/resolve'")).toMatch(/resolveForCaller\(auth\.callerDid, auth\.signer, auth\.payload\)/);
    const launch = route("app.post('/agent/content/launch'");
    expect(launch).toMatch(/resolveForCaller\(auth\.callerDid, auth\.signer, auth\.payload\)/);
    expect(launch).toMatch(/startPlay\(r\.resolution/);
    expect(launch).toMatch(/keepPlay\(play, wayInBy\(r\.kind, r\.admit\)\)/);
    const next = route("app.post('/agent/content/next'");
    expect(next.indexOf('entry.play.learner.id !== auth.callerDid')).toBeGreaterThan(0);
    expect(next.indexOf('entry.play.learner.id !== auth.callerDid')).toBeLessThan(next.indexOf('takeStep('));
    expect(next).toMatch(/res\.status\(403\)/);
    expect(next).toMatch(/statements => recordPlayStatements\(auth\.callerDid, statements\), markIfGraded\)/);
    // Nothing is counted, and a finished play is not let go, before the step's record is kept.
    const refused = next.indexOf('if (!taken.ok)');
    expect(refused).toBeGreaterThan(next.indexOf('takeStep('));
    for (const after of ['fragmentEfficacy.record(', 'contentPlays.delete(']) expect(next.indexOf(after), after).toBeGreaterThan(refused);
  });

  it('marks what it graded, and keeps every statement in the learner\'s lens and on their pod before it answers', () => {
    const fn = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n}\n', src.indexOf(from)));
    expect(fn('function markIfGraded')).toMatch(/withGradedTag\(raw, gradedKey\)/);
    const record = fn('async function recordPlayStatements');
    expect(record).toMatch(/lensTenantFor\(label\)/);
    expect(record).toMatch(/const id = await storeStatementDurably\(s, lens\);\n\s+if \(!id\) return null;/);
    expect(record).toMatch(/const composed = await composeIntoSharedLattice\(/);
    expect(record).toMatch(/if \(onPods && composed\?\.persisted !== true\) return null;/);
    expect(record).toMatch(/const onPods = bridgeEncryptionKeypair\(\) !== null;/);
    // Forwarded only once kept, one statement after another.
    expect(record.indexOf('forwardInOrder(lens, kept)')).toBeGreaterThan(record.indexOf('composed?.persisted'));
    expect(fn('function forwardInOrder')).toMatch(/for \(const s of statements\) await forwardToTargets\(lens, s\)/);
    expect(fn('function forwardInOrder')).toMatch(/\(forwardQueues\.get\(lens\) \?\? Promise\.resolve\(\)\)\.then\(/);
    const limit = route('function contentRateLimited');
    expect(limit).not.toMatch(/checkAgenticRateLimit/);
    expect(src).toMatch(/const RL_CONTENT_MAX = parseInt\(process\.env\.FOXXI_CONTENT_RATE_LIMIT_PER_IP \?\? '120', 10\);/);
    for (const path of ['/agent/content/launch', '/agent/content/next']) {
      const r = route(`app.post('${path}'`);
      expect(r.indexOf('contentRateLimited(req, res)'), path).toBeLessThan(r.indexOf('verifyDelegatedCaller'));
    }
  });
});
