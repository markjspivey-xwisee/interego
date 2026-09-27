/**
 * The author tools speak the bridge's language: what an author writes in the dashboard, the engine
 * takes as it is; what they compose, the engine composes; what a composition has learned, the
 * tools say as the engine said it.
 *
 * The round trip is the test that matters: a fragment written in the editor with every kind of
 * question goes through the engine's own fragmentFrom and compositionFrom, is played as the
 * bridge serves it, and is answered through the learner portal's drafts, and every answer the
 * author marked right is graded right by advancePlay.
 */
import { describe, expect, it } from 'vitest';
import { FRAGMENT_KINDS, fragmentFrom } from '../src/content-fragments.js';
import { compositionFrom, resolveComposition } from '../src/compositions.js';
import { advancePlay, currentView, startPlay } from '../src/composition-play.js';
import { EFFICACY_POLICY, EfficacyTally } from '../src/fragment-efficacy.js';
import { compositionEfficacy } from '../src/composition-efficacy.js';
import {
  COGNITIVE_LEVELS, FRAGMENT_KIND_LIST, fragmentPayload, missingFrom, missingFromFragment, moved, newFragment, newQuestion,
  policyOf, questionPayload, withoutOption, type FragmentDraft, type QuestionDraft,
} from '../dashboard-app/src/author/draft.js';
import { compositionPayload, contentKeyOf, contentKindOf, missingFromComposition, newComposition, offer } from '../dashboard-app/src/author/compose.js';
import { readFileSync } from 'node:fs';
import { SHELF_MAX, readShelf, shelfKey, shelve, unshelve, type ShelfItem } from '../dashboard-app/src/author/shelf.js';
import { cellLine, hasOutcomes, leaningLine, type CompositionEfficacy } from '../dashboard-app/src/author/efficacy.js';
import { exportFileNames, exportLinks, resolutionLine, stepLine, type ResolvedStepView } from '../dashboard-app/src/author/resolution.js';
import { fragmentForLearner } from '../src/content-fragments.js';
import { draftFor, matchTo, move, pick, repliesFor, type Draft, type LearnerQuestion } from '../dashboard-app/src/learn/answers.js';

const as = <K extends Draft['kind']>(d: Draft, kind: K): Extract<Draft, { kind: K }> => {
  if (d.kind !== kind) throw new Error(`a ${kind} draft was expected, not ${d.kind}`);
  return d as Extract<Draft, { kind: K }>;
};
const q = <T extends QuestionDraft['type']>(d: Extract<QuestionDraft, { type: T }>): QuestionDraft => d;

describe('the forms an author is offered are the engine’s own', () => {
  it('offers the very list the engine builds fragments from, and levels it takes', () => {
    expect(FRAGMENT_KINDS).toBe(FRAGMENT_KIND_LIST);
    for (const level of COGNITIVE_LEVELS) {
      expect(fragmentFrom({ kind: 'concept', level, competencies: ['x'], body: 'b' }).level).toBe(level);
    }
    expect(policyOf('assessment-item')).toBe('required');
    expect(policyOf('reflection')).toBe('ungraded-only');
    expect(policyOf('concept')).toBe('optional');
  });
});

describe('a fragment written in the editor, played in the portal, graded as its author meant', () => {
  const c = 'refund-authority';
  const written: FragmentDraft = {
    ...newFragment(), kind: 'assessment-item', level: 'foundational', competencies: `${c}\n${c}, refund-limits`,
    title: '  Every kind of question  ', body: 'Answer these.', suits: 'desk, phone', language: 'en',
    questions: [
      q<'choice'>({ type: 'choice', question: 'Who approves a $600 refund?', options: ['Agent', 'Team lead', 'Director'], right: [1], explanation: 'Above $250 goes to the team lead.' }),
      q<'choice'>({ type: 'choice', question: 'Which return money?', options: ['Chargeback', 'Store credit', 'Cash back'], right: [2, 0], explanation: '' }),
      q<'true-false'>({ type: 'true-false', question: 'An agent refuses above their limit.', answer: false, explanation: 'They escalate.' }),
      q<'sequencing'>({ type: 'sequencing', question: 'Put the steps in order.', items: ['Verify', 'Approve', 'Refund'], explanation: '' }),
      q<'matching'>({ type: 'matching', question: 'Who approves each?', pairs: [['$100', 'Agent'], ['$600', 'Team lead']], distractors: ['Customer', ' '], explanation: '' }),
      q<'fill-in'>({ type: 'fill-in', question: 'Above your limit, you…', answer: 'escalate', accept: ['escalation', ''], explanation: '' }),
      q<'numeric'>({ type: 'numeric', question: "An agent's limit?", answer: '250', min: '0', max: '', explanation: '' }),
      q<'likert'>({ type: 'likert', question: 'How sure are you?', scale: [] }),
      q<'long-fill-in'>({ type: 'long-fill-in', question: 'Tell us about a hard one.' }),
    ],
  };

  it('is taken by the engine as written, composed, and every answer marked right is graded right', () => {
    expect(missingFromFragment(written)).toEqual([]);
    const fragment = fragmentFrom(fragmentPayload(written));
    expect(fragment).toMatchObject({ kind: 'assessment-item', level: 'foundational', title: 'Every kind of question', suits: ['desk', 'phone'], language: 'en' });
    expect(fragment.competencies).toHaveLength(2);
    expect(fragment.questions).toHaveLength(9);

    const draft = offer({ ...newComposition(), title: 'Refunds', competency: c }, 0, fragment['@id']);
    expect(missingFromComposition(draft)).toEqual([]);
    const composition = compositionFrom(compositionPayload(draft));
    expect(composition.positions).toEqual([{ competency: composition.competency, paradigm: [fragment['@id']] }]);

    const store = new Map<string, unknown>([[fragment['@id'], fragment], [composition['@id'], composition]]);
    const learner = { id: 'did:ethr:0x0000000000000000000000000000000000000001', kind: 'human' as const };
    const now = '2026-09-27T12:00:00Z';
    const play = startPlay(resolveComposition({ composition, learner, lookup: i => store.get(i) as never }), composition.title, learner, { session: 's', registration: 'r' }, now)!;
    const served = (currentView(play)!.fragment as { questions: LearnerQuestion[] }).questions;
    const at = (i: number) => served[i]!;
    const picking = (i: number, ...labels: string[]) => labels.reduce<Draft>((d, l) => pick(as(d, 'pick'), at(i).input!.options!.indexOf(l)), draftFor(at(i)));
    let order = as(draftFor(at(3)), 'order');
    ['Verify', 'Approve', 'Refund'].forEach((label, place) => { order = as(move(order, order.order.findIndex(k => at(3).input!.items![k] === label), place), 'order'); });
    const matched = (['$100', '$600'] as const).reduce<Draft>((d, prompt, p) => matchTo(as(d, 'match'), p, at(4).input!.targets!.indexOf(prompt === '$100' ? 'Agent' : 'Team lead')), draftFor(at(4)));
    const drafts: Draft[] = [
      picking(0, 'Team lead'), picking(1, 'Chargeback', 'Cash back'), { ...as(draftFor(at(2)), 'truth'), value: false }, order, matched,
      { ...as(draftFor(at(5)), 'text'), text: 'Escalation' }, { ...as(draftFor(at(6)), 'text'), text: '250' },
      picking(7, at(7).input!.options![0]!), { ...as(draftFor(at(8)), 'text'), text: 'A gift card.' },
    ];
    const r = advancePlay(play, repliesFor(served, drafts), { actor: { objectType: 'Agent' }, now, newId: () => crypto.randomUUID() });
    expect(r.ok && r.graded).toMatchObject({ correct: 7, total: 7 });
    expect(r.ok && r.graded!.detail.map(d => d.explanation)).toEqual(['Above $250 goes to the team lead.', undefined, 'They escalate.', undefined, undefined, undefined, undefined, undefined, undefined]);
  });

  it('writes each kind of question in the form the engine takes, leaving out what was left blank', () => {
    expect(questionPayload(written.questions[0]!)).toEqual({ type: 'choice', question: 'Who approves a $600 refund?', options: ['Agent', 'Team lead', 'Director'], answer: 'B', explanation: 'Above $250 goes to the team lead.' });
    expect(questionPayload(written.questions[1]!)).toMatchObject({ answer: ['A', 'C'] });
    expect(questionPayload(written.questions[4]!)).toMatchObject({ distractors: ['Customer'] });
    expect(questionPayload(written.questions[5]!)).toMatchObject({ accept: ['escalation'] });
    expect(questionPayload(written.questions[6]!)).toEqual({ type: 'numeric', question: "An agent's limit?", answer: 250, min: 0 });
    expect(questionPayload(written.questions[7]!)).toEqual({ type: 'likert', question: 'How sure are you?' });
    expect(fragmentPayload(newFragment())).toEqual({ kind: 'concept', level: 'working', competencies: [], body: '' });
  });
});

describe('what is missing, said before anything is sent', () => {
  it('names what each kind of question still needs', () => {
    expect(missingFrom(newQuestion('choice'))).toMatch(/Write the question/);
    expect(missingFrom({ ...q<'choice'>({ type: 'choice', question: 'Q', options: ['a', ''], right: [0], explanation: '' }) })).toMatch(/every option/);
    expect(missingFrom(q<'choice'>({ type: 'choice', question: 'Q', options: ['a', 'b'], right: [], explanation: '' }))).toMatch(/which option is right/);
    expect(missingFrom(q<'true-false'>({ type: 'true-false', question: 'Q', answer: null, explanation: '' }))).toMatch(/true or false/);
    expect(missingFrom(q<'sequencing'>({ type: 'sequencing', question: 'Q', items: ['a'], explanation: '' }))).toMatch(/at least two/);
    expect(missingFrom(q<'matching'>({ type: 'matching', question: 'Q', pairs: [['a', 'b'], ['c', '']], distractors: [], explanation: '' }))).toMatch(/every pair/);
    expect(missingFrom(q<'fill-in'>({ type: 'fill-in', question: 'Q', answer: ' ', accept: [], explanation: '' }))).toMatch(/Write the answer/);
    expect(missingFrom(q<'numeric'>({ type: 'numeric', question: 'Q', answer: 'ten', min: '', max: '', explanation: '' }))).toMatch(/a number/);
    expect(missingFrom(q<'numeric'>({ type: 'numeric', question: 'Q', answer: '10', min: 'low', max: '', explanation: '' }))).toMatch(/least or a most/);
    expect(missingFrom(q<'likert'>({ type: 'likert', question: 'Q', scale: [] }))).toBeNull();
  });

  it('holds a kind to what it asks of its questions', () => {
    const base = { ...newFragment(), competencies: 'x', body: 'b' };
    expect(missingFromFragment({ ...base, kind: 'assessment-item' })).toEqual(['An assessment item measures, so it needs at least one graded question.']);
    expect(missingFromFragment({ ...base, kind: 'probe', questions: [newQuestion('likert')] }).filter(m => /graded/.test(m))).toEqual([]);
    expect(missingFromFragment({ ...base, kind: 'reflection', questions: [q<'true-false'>({ type: 'true-false', question: 'Q', answer: true, explanation: '' })] }))
      .toEqual(['Nothing in a probe or a reflection is graded: use scale or written-response questions.']);
    expect(missingFromFragment(newFragment())).toEqual(['Name at least one competency it develops.', 'Write its body.']);
  });

  it('keeps a choice’s marks on their options when one is removed, and a move inside its list', () => {
    const choice = q<'choice'>({ type: 'choice', question: 'Q', options: ['a', 'b', 'c', 'd'], right: [0, 3], explanation: '' });
    expect(withoutOption(choice as Extract<QuestionDraft, { type: 'choice' }>, 1)).toMatchObject({ options: ['a', 'c', 'd'], right: [0, 2] });
    expect(withoutOption(choice as Extract<QuestionDraft, { type: 'choice' }>, 0)).toMatchObject({ options: ['b', 'c', 'd'], right: [2] });
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('says what a composition still needs, and takes each alternative once', () => {
    const iri = `https://any.example/ns/foxxi/fragment/${'a'.repeat(64)}`;
    expect(missingFromComposition(newComposition())).toEqual(['Give it a title.', 'Name the competency it develops.', 'Position 1: add at least one fragment or composition that can fill it.']);
    const d = { title: 'T', competency: 'c', positions: [{ competency: '', alternatives: [iri, 'nonsense', iri] }] };
    expect(missingFromComposition(d)).toEqual(['Position 1: "nonsense" is not a fragment\'s or a composition\'s IRI.', 'Position 1: an alternative is listed twice.']);
    expect(offer(offer({ title: 'T', competency: 'c', positions: [{ competency: '', alternatives: [] }] }, 0, iri), 0, ` ${iri} `).positions[0]!.alternatives).toEqual([iri]);
    expect(compositionPayload({ title: ' T ', competency: ' c ', positions: [{ competency: '', alternatives: [iri] }, { competency: 'd', alternatives: [iri] }] }))
      .toEqual({ title: 'T', competency: 'c', positions: [{ competency: 'c', paradigm: [iri] }, { competency: 'd', paradigm: [iri] }] });
    expect(contentKindOf(`https://b.example/ns/foxxi/composition/${'b'.repeat(64)}`)).toBe('composition');
    // The same content under another bridge's IRI is the same alternative, as the engine holds it.
    const elsewhere = `https://elsewhere.example/ns/foxxi/fragment/${'a'.repeat(64)}`;
    expect(contentKeyOf(elsewhere)).toBe(contentKeyOf(iri));
    expect(missingFromComposition({ title: 'T', competency: 'c', positions: [{ competency: '', alternatives: [iri, elsewhere] }] }))
      .toEqual(['Position 1: an alternative is listed twice.']);
    expect(() => compositionFrom(compositionPayload({ title: 'T', competency: 'c', positions: [{ competency: '', alternatives: [iri, elsewhere] }] }))).toThrow(/same fragment twice/);
    expect(offer({ title: 'T', competency: 'c', positions: [{ competency: '', alternatives: [iri] }] }, 0, elsewhere).positions[0]!.alternatives).toEqual([iri]);
    expect(contentKindOf(`https://b.example/ns/foxxi/competency/x`)).toBeUndefined();
  });
});

describe('picking content up by its IRI', () => {
  it('shelves nothing the bridge refused to give, whatever the refusal', () => {
    const panel = readFileSync(new URL('../dashboard-app/src/components/AuthorPanel.tsx', import.meta.url), 'utf8');
    const pickUp = panel.slice(panel.indexOf('async function pickUp'), panel.indexOf('onPut({', panel.indexOf('async function pickUp')));
    expect(pickUp).toMatch(/if \(r\.status === 404\)/);
    expect(pickUp).toMatch(/if \(!r\.ok\) \{/);
    expect(pickUp.indexOf('if (!r.ok)')).toBeLessThan(pickUp.indexOf('await r.json() as { title?: string'));
  });
});

describe("an author's shelf", () => {
  const f = (n: number): ShelfItem => ({ iri: `https://b.example/ns/foxxi/fragment/${String(n).padStart(64, '0')}`, type: 'fragment', at: `2026-09-27T0${n % 10}:00:00Z` });
  it('puts the newest first, each once, keeping what an item already said', () => {
    let shelf = shelve([], { ...f(1), title: 'Refunds', kind: 'concept' });
    shelf = shelve(shelf, f(2));
    shelf = shelve(shelf, { ...f(1), title: undefined, level: 'working' });
    expect(shelf.map(s => s.iri)).toEqual([f(1).iri, f(2).iri]);
    expect(shelf[0]).toMatchObject({ title: 'Refunds', kind: 'concept', level: 'working' });
    expect(unshelve(shelf, f(1).iri).map(s => s.iri)).toEqual([f(2).iri]);
    for (let n = 3; n < SHELF_MAX + 10; n++) shelf = shelve(shelf, f(n));
    expect(shelf).toHaveLength(SHELF_MAX);
  });
  it('reads back only what is one, a type its IRI agrees with, and a shelf per identity', () => {
    const stored = JSON.stringify([f(1), f(1), { ...f(2), type: 'composition' }, { ...f(3), title: 'x'.repeat(201) }, { iri: 'nope', type: 'fragment', at: 'x' }, null]);
    expect(readShelf(stored)).toEqual([f(1)]);
    expect(readShelf('{')).toEqual([]);
    expect(readShelf('{"a":1}')).toEqual([]);
    expect(shelfKey('did:ethr:0xA')).not.toBe(shelfKey('did:ethr:0xB'));
  });
});

describe('what a composition has learned, as the engine says it', () => {
  const c = 'refund-authority';
  const one = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'Told', body: 'Told.' });
  const two = fragmentFrom({ kind: 'worked-example', level: 'foundational', competencies: [c], title: 'Shown', body: 'Shown.' });
  const comp = compositionFrom({ title: 'Refunds', competency: c, positions: [{ competency: c, paradigm: [one['@id'], two['@id']] }] });
  const store = new Map<string, unknown>([[one['@id'], one], [two['@id'], two]]);
  const lookup = (iri: string) => store.get(iri) as never;

  it('says nothing has been learned where nothing has', () => {
    const view = compositionEfficacy(comp, new EfficacyTally(), lookup) as unknown as CompositionEfficacy;
    expect(hasOutcomes(view)).toBe(false);
  });

  it('says what a cell holds once it may be shown, only that it is too small before, and what it leans to', () => {
    const tally = new EfficacyTally();
    for (let i = 0; i < EFFICACY_POLICY.assertAt; i++) tally.record({ competency: comp.competency, fragment: one['@id'], level: 'foundational', success: i % 4 !== 0 }, String(i).padStart(64, '0'));
    for (let i = 0; i < EFFICACY_POLICY.publishAt - 1; i++) tally.record({ competency: comp.competency, fragment: two['@id'], level: 'foundational', success: true }, String(i).padStart(64, '0'));
    const view = compositionEfficacy(comp, tally, lookup) as unknown as CompositionEfficacy;
    expect(hasOutcomes(view)).toBe(true);
    const [told, shown] = view.positions[0]!.alternatives;
    expect(cellLine(told!.cells[0]!)).toMatch(/^foundational: 9 of 12 went on to succeed, at least \d+%$/);
    expect(cellLine(shown!.cells[0]!)).toBe(`foundational: fewer than ${EFFICACY_POLICY.publishAt} outcomes, too few to show`);
    const titles = new Map([[one['@id'], 'Told'], [two['@id'], 'Shown']]);
    const lines = view.positions[0]!.leansTo.map(l => leaningLine(l, iri => titles.get(iri) ?? iri));
    expect(lines).toEqual([expect.stringMatching(/^At foundational, for any learner: not said, /)]);
  });

  it('reads a leaning chosen, gone into, and withheld', () => {
    const name = (iri: string) => iri.toUpperCase();
    expect(leaningLine({ level: 'working', for: 'human', chosen: 'a', why: 'It worked best.' }, name)).toBe('At working, for people: A. It worked best.');
    expect(leaningLine({ level: 'applied', for: 'agent', into: 'c', otherwise: ['a', 'b'], why: 'It resolves.' }, name)).toBe('At applied, for agents: goes into C, otherwise A, then B. It resolves.');
    expect(leaningLine({ level: 'advanced', for: 'anyone', withheld: 'a cell is too small' }, name)).toBe('At advanced, for any learner: not said, a cell is too small');
    expect(cellLine({ level: 'working', n: 20, successes: 10, lowerBound: 0.29, modalStatus: 'Hypothetical', competency: 'c', fragment: 'f' })).toBe('working: 10 of 20 went on to succeed, at least 29% (still hypothetical)');
  });
});

describe("a composition's page: how it resolves, and where it can be taken", () => {
  const c = 'refund-authority';
  const told = fragmentFrom({ kind: 'concept', level: 'foundational', competencies: [c], title: 'Told', body: 'Told.' });
  const forAgents = fragmentFrom({ kind: 'context-descriptor', level: 'foundational', competencies: [c], title: 'Doctrine', body: 'Policy.', audience: 'agent' });
  const comp = compositionFrom({ title: 'Refunds', competency: c, positions: [{ competency: c, paradigm: [told['@id']] }, { competency: c, paradigm: [forAgents['@id']] }] });
  const store = new Map<string, unknown>([[told['@id'], told], [forAgents['@id'], forAgents]]);
  // As foxxi.content_resolve serves it: each step's fragment in the form a learner receives.
  const served = (kind: 'human' | 'agent') => {
    const r = resolveComposition({ composition: comp, learner: { id: 'did:ethr:0x0000000000000000000000000000000000000001', kind }, lookup: i => store.get(i) as never });
    return { ...r, steps: r.steps.map(s => ({ ...s, fragment: fragmentForLearner(s.fragment) })) as unknown as ResolvedStepView[] };
  };

  it('says what it resolves to for a person, and what nothing could fill', () => {
    const r = served('human');
    expect(resolutionLine(r)).toBe('one step, 1 that nothing could fill');
    expect(stepLine(r.steps[0]!)).toBe('Told (concept, pitched foundational)');
  });

  it('says what it resolves to for an agent, where the fragment meant for agents fills the position', () => {
    const r = served('agent');
    expect(resolutionLine(r)).toBe('2 steps');
    expect(stepLine(r.steps[1]!)).toBe('Doctrine (context-descriptor, pitched foundational)');
    expect(resolutionLine({ steps: [], skipped: [{ competency: c, path: [], position: 0, because: 'shown' }], unmet: [] })).toBe('nothing to play, 1 position skipped');
  });

  it('does not change whom it resolves for while a resolution is under way, so an answer is never shown under the other kind', () => {
    const panel = readFileSync(new URL('../dashboard-app/src/components/EfficacyPanel.tsx', import.meta.url), 'utf8');
    const card = panel.slice(panel.indexOf('function ResolveCard'), panel.indexOf('function ExportCard'));
    expect(card).toMatch(/<select value=\{kind\} disabled=\{state === 'resolving'\}/);
  });

  it('takes a composition elsewhere by the bridge\'s own routes for it', () => {
    const hash = 'a'.repeat(64);
    expect(exportLinks('https://bridge.example/', hash)).toEqual({
      cmi5: `https://bridge.example/ns/foxxi/composition/${hash}/cmi5.xml`,
      scorm: `https://bridge.example/ns/foxxi/composition/${hash}/scorm.zip`,
    });
    const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(server).toContain("app.get('/ns/foxxi/composition/:hash/cmi5.xml'");
    expect(server).toContain("app.get('/ns/foxxi/composition/:hash/scorm.zip'");
    // Saved under the name the bridge gives the package it serves.
    expect(exportFileNames(hash)).toEqual({ cmi5: `composition-${'a'.repeat(12)}-cmi5.xml`, scorm: `composition-${'a'.repeat(12)}-scorm.zip` });
    expect(server).toContain('attachment; filename="composition-${hash.slice(0, 12)}-scorm.zip"');
  });

  it('saves each export from the page, so following it never takes the tab, and a pasted key, away', () => {
    const panel = readFileSync(new URL('../dashboard-app/src/components/EfficacyPanel.tsx', import.meta.url), 'utf8');
    const card = panel.slice(panel.indexOf('function ExportCard'));
    expect(card).toContain("<a href={links.cmi5} onClick={save('cmi5')}>");
    expect(card).toContain("<a href={links.scorm} onClick={save('scorm')}>");
    expect(card).not.toMatch(/\sdownload>/);
    const save = card.slice(card.indexOf('const save ='), card.indexOf('return (', card.indexOf('const save =')));
    // A click meant for another tab or window is left to the browser; a plain one is taken here, before anything is fetched.
    expect(save).toMatch(/if \(e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey\) return;/);
    expect(save.indexOf('e.preventDefault();')).toBeGreaterThan(-1);
    expect(save.indexOf('e.preventDefault();')).toBeLessThan(save.indexOf('await fetch(links[which])'));
    expect(save).toMatch(/if \(!r\.ok\) throw new Error/);
    expect(save).toMatch(/a\.href = url; a\.download = names\[which\];/);
  });

  it('resolves and exports while what it has learned is being read, or cannot be read', () => {
    const panel = readFileSync(new URL('../dashboard-app/src/components/EfficacyPanel.tsx', import.meta.url), 'utf8');
    // Made once the bridge's base is known, which their links are made from.
    expect(panel).toMatch(/const actions = base \? <><ResolveCard session=\{session\} iri=\{compositionIriOn\(base, hash\)\} \/><ExportCard base=\{base\} hash=\{hash\} \/><\/> : null;/);
    // Offered while the tally is read, however long that takes, and when it cannot be.
    expect(panel).not.toMatch(/if \(read\.at === 'loading'\) return/);
    const pending = panel.slice(panel.indexOf("if (read.at === 'loading' || read.at === 'failed') {"), panel.indexOf('const view = read.view;'));
    expect(pending).toContain("{read.at === 'loading' ? <div style={{ color: 'var(--text-dim)' }}>Reading…</div> : <div role=\"alert\" style={{ color: 'var(--bad)' }}>{read.why}</div>}</Card>");
    expect(pending).toMatch(/<\/Card>\s+\{actions\}\s+<\/div>/);
    expect(panel.slice(panel.indexOf('const view = read.view;'))).toMatch(/<\/Card>\s+\{actions\}\s+\{view\.positions\.map/);
    // Only a composition the bridge does not hold goes without them.
    expect(panel.indexOf("if (read.at === 'absent')")).toBeLessThan(panel.indexOf('const actions ='));
  });
});
