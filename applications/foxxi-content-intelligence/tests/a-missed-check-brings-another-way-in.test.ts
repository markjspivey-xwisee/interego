/**
 * A missed check brings another way in: each position that taught the competency since the last
 * check there, and offers more than the learner met, gives them another of its alternatives, chosen
 * as resolution chose and never one already shown, then another check from the missed check's
 * position. Each position does this once per play, and one with nothing else to offer adds nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { advancePlay, currentView, PLAY_EXT, startPlay, WAY_IN_LIMIT, type AnotherWayIn, type CompositionPlay } from '../src/composition-play.js';
import { fragmentFrom, type Fragment } from '../src/content-fragments.js';
import { anotherAlternative, compositionFrom, resolveComposition, type Admission, type Composition } from '../src/compositions.js';

const c = 'refund-authority';
const explain = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'Who approves', body: 'Agents refund up to $250.' });
const example = fragmentFrom({ kind: 'worked-example', level: 'foundational', competencies: [c], title: 'A $600 request', body: 'A $600 request goes to the team lead.' });
const deeper = fragmentFrom({ kind: 'concept', level: 'advanced', competencies: [c], title: 'Why the threshold', body: 'The threshold caps what one person can approve alone.' });
const forAgents = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'For agents', body: 'Route refunds over $250 to a lead.', audience: 'agent' });
const check = (title: string, answer: 'A' | 'B') => fragmentFrom({ kind: 'assessment-item', competencies: [c], title, body: 'Check yourself.', questions: [{ question: `${title}: who approves $600?`, options: ['Agent', 'Team lead'], answer }] });
const check1 = check('Check', 'B');
const check2 = check('Check again', 'B');
const store = new Map<string, Fragment | Composition>([explain, example, deeper, forAgents, check1, check2].map(x => [x['@id'], x]));
const course = (teaching: string[], checks: string[] = [check1['@id'], check2['@id']]) => {
  const comp = compositionFrom({ title: 'Refunds', competency: c, positions: [{ competency: c, paradigm: teaching }, { competency: c, paradigm: checks }] });
  store.set(comp['@id'], comp);
  return comp;
};
const learner = { id: 'did:web:learner.example', kind: 'human' as const };
let n = 0;
const ctx = { actor: { objectType: 'Agent', account: { homePage: 'did:web:bridge.example', name: learner.id } }, now: '2026-09-27T12:00:00.000Z', newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` };
const chooser = (admission?: (competency: string) => Admission | null | undefined, kind: 'human' | 'agent' = 'human'): AnotherWayIn =>
  (step, exclude) => anotherAlternative(step, { lookup: i => store.get(i), ...(admission ? { admission } : {}), learnerKind: kind, exclude });
const playOf = (comp: Composition): CompositionPlay =>
  startPlay(resolveComposition({ composition: comp, learner, lookup: i => store.get(i) }), comp.title, learner, { session: 's', registration: 'r' }, ctx.now)!;
const titles = (play: CompositionPlay): string[] => play.steps.map(s => s.fragment.title!);

describe('a missed check brings another way in', () => {
  it('from the position that taught it, then another check, before the play is done', () => {
    const play = playOf(course([explain['@id'], example['@id'], deeper['@id']]));
    expect(titles(play)).toEqual(['Who approves', 'Check']);
    const choose = chooser();
    advancePlay(play, undefined, ctx, choose);
    const missed = advancePlay(play, ['A'], ctx, choose);
    expect(missed).toMatchObject({ ok: true, done: false, graded: { correct: 0, total: 1 } });
    // The foundational example is nearest the level the learner met the position at.
    expect(titles(play)).toEqual(['Who approves', 'Check', 'A $600 request', 'Check again']);
    expect(currentView(play)).toMatchObject({ step: 3, of: 4, chosenBecause: 'another way in: the check "Check" was missed, so this worked-example comes before trying again' });
    const taught = advancePlay(play, undefined, ctx, choose);
    if (!taught.ok) throw new Error(taught.error);
    const experienced = taught.statements.at(-1) as unknown as { context: { extensions: Record<string, unknown> } };
    expect(experienced.context.extensions).toMatchObject({ [PLAY_EXT.position]: 0, [PLAY_EXT.chosenBecause]: expect.stringMatching(/^another way in/) });
    const passed = advancePlay(play, ['B'], ctx, choose);
    expect(passed).toMatchObject({ ok: true, done: true });
    // The new way in is judged by the check that follows it, as any teaching is.
    expect((passed as { outcomes: Array<{ fragment: string; success: boolean }> }).outcomes).toEqual([
      expect.objectContaining({ fragment: check2['@id'], success: true }), expect.objectContaining({ fragment: example['@id'], success: true }),
    ]);
  });

  it('comes right after the missed check, before the rest, and leaves the resolution as it was', () => {
    const after = fragmentFrom({ kind: 'reflection', competencies: ['refund-disputes'], title: 'Looking back', body: 'What would you do differently?' });
    store.set(after['@id'], after);
    const comp = compositionFrom({ title: 'Refunds, then disputes', competency: c, positions: [
      { competency: c, paradigm: [explain['@id'], example['@id']] }, { competency: c, paradigm: [check1['@id'], check2['@id']] },
      { competency: 'refund-disputes', paradigm: [after['@id']] },
    ] });
    const resolution = resolveComposition({ composition: comp, learner, lookup: i => store.get(i) });
    const play = startPlay(resolution, comp.title, learner, { session: 's', registration: 'r' }, ctx.now)!;
    advancePlay(play, undefined, ctx, chooser());
    advancePlay(play, ['A'], ctx, chooser());
    expect(titles(play)).toEqual(['Who approves', 'Check', 'A $600 request', 'Check again', 'Looking back']);
    expect(resolution.steps.map(s => s.fragment.title)).toEqual(['Who approves', 'Check', 'Looking back']);
  });

  it('can bring in what the play would show later, since the learner has not met it yet', () => {
    const comp = compositionFrom({ title: 'Refunds, and an example later', competency: c, positions: [
      { competency: c, paradigm: [explain['@id'], example['@id']] }, { competency: c, paradigm: [check1['@id'], check2['@id']] },
      { competency: c, paradigm: [example['@id']] },
    ] });
    const play = playOf(comp);
    expect(titles(play)).toEqual(['Who approves', 'Check', 'A $600 request']);
    advancePlay(play, undefined, ctx, chooser());
    advancePlay(play, ['A'], ctx, chooser());
    expect(titles(play)).toEqual(['Who approves', 'Check', 'A $600 request', 'Check again', 'A $600 request']);
  });

  it('gives each position the miss was credited to its way in, even where one fragment taught at two', () => {
    const comp = compositionFrom({ title: 'Refunds, told twice', competency: c, positions: [
      { competency: c, paradigm: [explain['@id'], example['@id']] }, { competency: c, paradigm: [explain['@id'], deeper['@id']] },
      { competency: c, paradigm: [check1['@id'], check2['@id']] },
    ] });
    const play = playOf(comp);
    expect(titles(play)).toEqual(['Who approves', 'Who approves', 'Check']);
    advancePlay(play, undefined, ctx, chooser());
    advancePlay(play, undefined, ctx, chooser());
    advancePlay(play, ['A'], ctx, chooser());
    expect(titles(play)).toEqual(['Who approves', 'Who approves', 'Check', 'A $600 request', 'Why the threshold', 'Check again']);
  });

  it('brings nothing for a check that was passed', () => {
    const play = playOf(course([explain['@id'], example['@id']]));
    advancePlay(play, undefined, ctx, chooser());
    expect(advancePlay(play, ['B'], ctx, chooser())).toMatchObject({ ok: true, done: true });
    expect(titles(play)).toEqual(['Who approves', 'Check']);
  });

  it('comes once from a position, and never repeats what was shown', () => {
    const play = playOf(course([explain['@id'], example['@id'], deeper['@id']]));
    const choose = chooser();
    advancePlay(play, undefined, ctx, choose);
    advancePlay(play, ['A'], ctx, choose);
    advancePlay(play, undefined, ctx, choose);
    const again = advancePlay(play, ['A'], ctx, choose);
    // The position has an advanced explanation left, but it has had its other way in.
    expect(again).toMatchObject({ ok: true, done: true });
    expect(titles(play)).toEqual(['Who approves', 'Check', 'A $600 request', 'Check again']);
  });

  it('adds nothing, not even the same explanation again, where the position has nothing else', () => {
    const play = playOf(course([explain['@id']]));
    advancePlay(play, undefined, ctx, chooser());
    expect(advancePlay(play, ['A'], ctx, chooser())).toMatchObject({ ok: true, done: true });
    expect(titles(play)).toEqual(['Who approves', 'Check']);
  });

  it('brings another way in without another check when the missed check\'s position has none', () => {
    const play = playOf(course([explain['@id'], example['@id']], [check1['@id']]));
    advancePlay(play, undefined, ctx, chooser());
    advancePlay(play, ['A'], ctx, chooser());
    expect(titles(play)).toEqual(['Who approves', 'Check', 'A $600 request']);
  });

  it('comes at no more than its limit of positions in one play', () => {
    const many = Array.from({ length: WAY_IN_LIMIT + 1 }, (_, i) => [
      fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: `Part ${i}`, body: `Part ${i}.` }),
      fragmentFrom({ kind: 'worked-example', level: 'foundational', competencies: [c], title: `Part ${i}, shown`, body: `Part ${i}, shown.` }),
    ]);
    for (const x of many.flat()) store.set(x['@id'], x);
    const comp = compositionFrom({ title: 'Long', competency: c, positions: [...many.map(([a, b]) => ({ competency: c, paradigm: [a!['@id'], b!['@id']] })), { competency: c, paradigm: [check1['@id']] }] });
    const play = playOf(comp);
    for (let i = 0; i < many.length; i++) advancePlay(play, undefined, ctx, chooser());
    advancePlay(play, ['A'], ctx, chooser());
    expect(play.wayIn).toHaveLength(WAY_IN_LIMIT);
    expect(play.steps.length).toBe(many.length + 1 + WAY_IN_LIMIT);
  });
});

describe('another alternative is chosen by the rules resolution chose by', () => {
  // A nested composition among the alternatives, and the author's order putting the advanced one first.
  const nested = compositionFrom({ title: 'Nested', competency: c, positions: [{ competency: c, paradigm: [explain['@id']] }] });
  store.set(nested['@id'], nested);
  const comp = course([explain['@id'], forAgents['@id'], nested['@id'], deeper['@id'], example['@id']]);
  const step = playOf(comp).steps[0]!;

  it('meant for this learner, not already shown, nearest their level, then in the author\'s order, and never a composition', () => {
    expect(anotherAlternative(step, { lookup: i => store.get(i), learnerKind: 'human', exclude: new Set([explain['@id']]) })?.title).toBe('A $600 request');
    expect(anotherAlternative(step, { lookup: i => store.get(i), learnerKind: 'agent', exclude: new Set([explain['@id']]) })?.title).toBe('For agents');
    expect(anotherAlternative(step, { lookup: i => store.get(i), learnerKind: 'human', exclude: new Set([explain['@id'], example['@id']]) })?.title).toBe('Why the threshold');
    expect(anotherAlternative(step, { lookup: i => store.get(i), learnerKind: 'human', exclude: new Set([explain['@id'], example['@id'], deeper['@id']]) })).toBeUndefined();
  });

  it('in a form admitted at the position\'s competency, or else at its composition\'s', () => {
    const onlyConcepts: Admission = { kinds: ['concept'], because: 'the plan selected instruction' };
    const exclude = new Set([explain['@id']]);
    expect(anotherAlternative(step, { lookup: i => store.get(i), admission: () => onlyConcepts, learnerKind: 'human', exclude })?.title).toBe('Why the threshold');
    // A position in a composition toward another competency, whose admission differs from its own.
    const within = compositionFrom({ title: 'Disputes', competency: 'refund-disputes', positions: [{ competency: c, paradigm: [explain['@id'], example['@id'], deeper['@id']] }, { competency: c, paradigm: [check1['@id']] }] });
    store.set(within['@id'], within);
    const inner = playOf(within).steps[0]!;
    // Nothing said at the position: its composition's competency decides.
    const byComposition = (k: string) => (k === within.competency ? onlyConcepts : undefined);
    expect(anotherAlternative(inner, { lookup: i => store.get(i), admission: byComposition, learnerKind: 'human', exclude })?.title).toBe('Why the threshold');
    // Withdrawn at the position (null): nothing limits it, whatever the composition's says.
    const withdrawnHere = (k: string) => (k === inner.competency ? null : onlyConcepts);
    expect(anotherAlternative(inner, { lookup: i => store.get(i), admission: withdrawnHere, learnerKind: 'human', exclude })?.title).toBe('A $600 request');
  });

  it('and only content that is what its IRI says', () => {
    const tampered = new Map(store);
    tampered.set(example['@id'], { ...example, body: 'Agents refund anything.' });
    expect(anotherAlternative(step, { lookup: i => tampered.get(i), learnerKind: 'human', exclude: new Set([explain['@id']]) })?.title).toBe('Why the threshold');
  });
});

describe('the bridge keeps the rules a play was resolved by, for its ways in', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');

  it('for a learner\'s own play and for a play an LMS launched', () => {
    expect(src).toMatch(/const admit = admission \? \(\) => admission : kept\?\.ok && kept\.standing\.size \? fromKept : undefined;\s+const resolution = resolveComposition\(\{\s+composition: root, learner: \{ id: callerDid, kind \}, record,\s+\.\.\.\(admit \? \{ admission: admit \} : \{\}\)/);
    expect(src).toMatch(/keepPlay\(play, wayInBy\(r\.kind, r\.admit\)\);/);
    expect(src).toMatch(/projectedPlays\.set\(play\.id, \{ play, attempt, choose: wayInBy\(learner\.kind\),/);
    expect(src).toMatch(/return \(step, exclude\) => anotherAlternative\(step, \{ lookup: iri => contentStore\.get\(iri\), \.\.\.\(admit \? \{ admission: admit \} : \{\}\), learnerKind: kind, exclude \}\);/);
  });
});
