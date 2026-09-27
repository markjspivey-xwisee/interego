/**
 * Content as a composition resolved per learner, rather than a package every learner gets alike.
 *
 * A fragment is identified by its content, so it cannot be swapped under a learner and a copy
 * from anywhere can be checked. A composition is a path of positions holding alternatives, by
 * reference. Resolving it for a learner reads their own record (skip what they have demonstrated,
 * pitch at their level) and an admission (only the forms said to suit the competency). Where the
 * admissions come from, a performance plan, is tested with the practice that makes it
 * (tests/a-plan-admits-only-the-content-that-delivers-it.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { competencyIri } from '../src/competency-identity.js';
import {
  ContentError, contentRefOf, FRAGMENT_KINDS, fragmentForLearner, fragmentFrom, fragmentIsIntact, sameContent, type Fragment,
} from '../src/content-fragments.js';
import {
  compositionFrom, compositionIsIntact, resolveComposition, type Composition, type RecordedCompetency,
} from '../src/compositions.js';
import { questionIsRight } from '../src/course-questions.js';
import type { FragmentModality } from '../src/emergent-content.js';

const lesson = (over: Record<string, unknown> = {}) => fragmentFrom({
  kind: 'concept', level: 'foundational', competencies: ['refund-authority'], title: 'Who approves a refund',
  body: '## Limits\n\nAgents refund **up to $250**. A team lead approves more.', ...over,
});

describe('a fragment is identified by its content', () => {
  it('gives the same content the same IRI, however its competencies are named, and any change a new one', () => {
    const a = lesson();
    expect(contentRefOf(a['@id'])?.type).toBe('fragment');
    expect(lesson()['@id']).toBe(a['@id']);
    expect(lesson({ competencies: ['https://other-bridge.example/ns/foxxi/competency/refund-authority', 'urn:foxxi:competency:refund-authority'] })['@id']).toBe(a['@id']);
    expect(lesson({ body: 'Agents refund up to $300.' })['@id']).not.toBe(a['@id']);
    expect(lesson({ level: 'working' })['@id']).not.toBe(a['@id']);
    const two = lesson({ competencies: ['refund-authority', 'https://skills.example/ns#Escalation'] });
    expect(lesson({ competencies: ['https://skills.example/ns#Escalation', 'refund-authority'] })['@id']).toBe(two['@id']);
    expect(two.competencies).toContain(competencyIri('https://skills.example/ns#Escalation'));
  });

  it('checks a copy by hashing it: a changed body or verifier no longer matches its IRI', () => {
    const f = fragmentFrom({ kind: 'assessment-item', competencies: ['refund-authority'], body: 'Check.', questions: [{ question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B' }] });
    expect(fragmentIsIntact(f)).toBe(true);
    expect(fragmentIsIntact(JSON.parse(JSON.stringify(f)) as Fragment)).toBe(true);
    // Another bridge serves the same fragment under its own host, competency URLs included, and it still checks.
    const mirror = (iri: string) => iri.replace(/^https:\/\/[^/]+/, 'https://mirror.example');
    expect(fragmentIsIntact({ ...f, '@id': mirror(f['@id']), competencies: f.competencies.map(mirror) })).toBe(true);
    expect(fragmentIsIntact({ ...f, body: 'Changed.' })).toBe(false);
    expect(fragmentIsIntact({ ...f, questions: [{ ...f.questions![0]!, answerHash: '0'.repeat(64) }] })).toBe(false);
    expect(sameContent(f['@id'], f['@id'].replace(/^https:\/\/[^/]+/, 'https://mirror.example'))).toBe(true);
  });

  it('stores questions with verifiers, never answers, salted from the fragment itself', () => {
    const raw = { kind: 'practice-task', competencies: ['refund-authority'], body: 'Try these.', questions: [
      { question: 'Who approves $600?', options: ['Agent', 'Team lead', 'Manager'], answer: 'Team lead' },
      { question: 'Order the steps', items: ['Verify', 'Refund', 'Log'] },
    ] };
    const f = fragmentFrom(raw);
    // A graded fragment carries a random blinding value: sent back in its stored form it keeps its
    // IRI, and the same quiz authored afresh is a different fragment with its own.
    expect(f.blind).toMatch(/^[0-9a-f]{64}$/);
    expect(fragmentFrom(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(fragmentFrom(raw)['@id']).not.toBe(f['@id']);
    expect(JSON.stringify(f)).not.toMatch(/"answer"/);
    expect(questionIsRight('B', f.questions![0]!)).toBe(true);
    expect(questionIsRight('A', f.questions![0]!)).toBe(false);
    const shown = f.questions![1]!.input!.items!;
    expect(questionIsRight(['Verify', 'Refund', 'Log'].map(i => String.fromCharCode(65 + shown.indexOf(i))).join(', '), f.questions![1]!)).toBe(true);
    const view = fragmentForLearner(f) as { questions: Array<Record<string, unknown>>; bodyHtml: string };
    expect(JSON.stringify(view)).not.toMatch(/answerHash|acceptHashes|salt/);
    expect(view.bodyHtml).toBe('<p>Try these.</p>');
    expect(view.questions.map(q => q.type)).toEqual(['choice', 'sequencing']);
  });

  it('holds each kind to what it is for: a check needs a graded question, a probe or reflection takes none', () => {
    expect(() => fragmentFrom({ kind: 'assessment-item', competencies: ['x'], body: 'b' })).toThrow(/needs at least one graded question/);
    expect(() => fragmentFrom({ kind: 'probe', competencies: ['x'], body: 'b', questions: [{ question: 'q', answer: 'a' }] })).toThrow(/a probe is not graded/);
    const probe = fragmentFrom({ kind: 'probe', competencies: ['x'], body: 'Try routing one queue by urgency for a week. Stop if waits exceed a day.', questions: [{ question: 'What did you notice?', type: 'long-fill-in' }] });
    expect(probe.questions![0]!.answerHash).toBeUndefined();
    expect(fragmentFrom({ kind: 'reflection', competencies: ['x'], body: 'b', questions: [{ question: 'How sure are you?', type: 'likert' }] }).kind).toBe('reflection');
  });

  it('refuses what it cannot store, saying what to fix', () => {
    expect(() => fragmentFrom({ kind: 'slide', competencies: ['x'], body: 'b' })).toThrow(/kind must be one of/);
    expect(() => fragmentFrom({ kind: 'concept', level: 'expert', competencies: ['x'], body: 'b' })).toThrow(/level must be one of/);
    expect(() => fragmentFrom({ kind: 'concept', body: 'b' })).toThrow(/names the competencies/);
    expect(() => fragmentFrom({ kind: 'concept', competencies: ['Refund authority!'], body: 'b' })).toThrow(/competency IRI, a term IRI, or a slug/);
    expect(() => fragmentFrom({ kind: 'concept', competencies: ['x'], body: 'b'.repeat(20_001) })).toThrow(/longer than 20000/);
    expect(() => fragmentFrom({ kind: 'concept', competencies: ['x'], body: 'b', language: 'english please' })).toThrow(/BCP 47/);
    expect(() => fragmentFrom({ kind: 'concept', competencies: ['x'], body: 'b', questions: [{ question: 'q', options: ['a'], answer: 'A' }] })).toThrow(ContentError);
  });

  it('defines every form a fragment can take, and only probes and reflections refuse grading', () => {
    const kinds: FragmentModality[] = ['concept', 'worked-example', 'video', 'simulation', 'job-aid', 'assessment-item', 'reference', 'practice-task', 'context-descriptor', 'probe', 'reflection'];
    expect(FRAGMENT_KINDS.map(k => k.kind).sort()).toEqual([...kinds].sort());
    expect(FRAGMENT_KINDS.filter(k => k.questions === 'ungraded-only').map(k => k.kind).sort()).toEqual(['probe', 'reflection']);
    expect(FRAGMENT_KINDS.filter(k => k.questions === 'required').map(k => k.kind)).toEqual(['assessment-item']);
  });
});

// ── Compositions and their resolution ─────────────────────────────

const f = {
  intro: lesson(),
  introWorking: lesson({ level: 'working', title: 'Refund limits in practice', body: 'A $600 refund goes to a team lead; log the approval.' }),
  introAdvanced: lesson({ level: 'advanced', title: 'Edge cases', body: 'Split refunds, partial credits and chargebacks.' }),
  agentContext: fragmentFrom({ kind: 'context-descriptor', level: 'foundational', competencies: ['refund-authority'], audience: 'agent', body: 'POLICY: refund <= 250 USD; else escalate to team lead.' }),
  check: fragmentFrom({ kind: 'assessment-item', level: 'working', competencies: ['refund-authority'], body: 'Check yourself.', questions: [{ question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B' }] }),
  jobAid: fragmentFrom({ kind: 'job-aid', level: 'applied', competencies: ['refund-authority'], body: '- Up to $250: approve\n- Above: escalate to a team lead' }),
  sop: fragmentFrom({ kind: 'reference', level: 'working', competencies: ['refund-authority'], title: 'Refund procedure', body: '1. Verify the order\n2. Refund up to $250\n3. Escalate the rest' }),
  probe: fragmentFrom({ kind: 'probe', competencies: ['queue-triage'], body: 'Route one queue by urgency for a week; stop if waits pass a day.', questions: [{ question: 'What changed?', type: 'long-fill-in' }] }),
  triageLesson: fragmentFrom({ kind: 'concept', competencies: ['queue-triage'], body: 'Triage means ordering work by urgency.' }),
};
const store = new Map<string, Fragment | Composition>(Object.values(f).map(x => [x['@id'], x]));
const lookup = (iri: string) => store.get(iri);
const add = <T extends Fragment | Composition>(x: T): T => { store.set(x['@id'], x); return x; };

const refunds = add(compositionFrom({
  title: 'Refund authority', competency: 'refund-authority',
  positions: [
    { competency: 'refund-authority', paradigm: [f.intro['@id'], f.introWorking['@id'], f.introAdvanced['@id'], f.agentContext['@id']] },
    { competency: 'refund-authority', demonstratedAt: 4, paradigm: [f.check['@id']] },
  ],
}));

const human = { id: 'did:web:learner.example', kind: 'human' as const };
const agent = { id: 'did:web:agent.example', kind: 'agent' as const };
const at = (rank: number, label: string, asserted: boolean, basis: RecordedCompetency['basis'] = asserted ? 'performance' : 'inferred'): RecordedCompetency => ({
  aboutCompetency: competencyIri('refund-authority'), modalStatus: asserted ? 'Asserted' : 'Hypothetical', basis, proficiencyRank: rank, proficiencyLabel: label,
});

describe('a composition is a path of positions holding alternatives, by reference', () => {
  it('is identified by its content, and a revision names what it supersedes', () => {
    expect(contentRefOf(refunds['@id'])?.type).toBe('composition');
    expect(compositionIsIntact(refunds)).toBe(true);
    expect(compositionIsIntact({ ...refunds, title: 'Other' })).toBe(false);
    const mirror = (iri: string) => iri.replace(/^https:\/\/[^/]+/, 'https://mirror.example');
    expect(compositionIsIntact({
      ...refunds, '@id': mirror(refunds['@id']), competency: mirror(refunds.competency),
      positions: refunds.positions.map(p => ({ ...p, competency: mirror(p.competency), paradigm: p.paradigm.map(mirror) })),
    })).toBe(true);
    const again = compositionFrom({ title: 'Refund authority', competency: competencyIri('refund-authority'), positions: refunds.positions });
    expect(again['@id']).toBe(refunds['@id']);
    const v2 = compositionFrom({ title: 'Refund authority', competency: 'refund-authority', positions: refunds.positions.slice(0, 1), supersedes: refunds['@id'] });
    expect(v2.supersedes).toBe(refunds['@id']);
    expect(v2['@id']).not.toBe(refunds['@id']);
  });

  it('refuses what it cannot hold', () => {
    expect(() => compositionFrom({ title: 't', competency: 'x', positions: [] })).toThrow(/at least one position/);
    expect(() => compositionFrom({ title: 't', competency: 'x', positions: [{ competency: 'x', paradigm: ['https://example.com/page'] }] })).toThrow(/not a fragment or composition IRI/);
    expect(() => compositionFrom({ title: 't', competency: 'x', positions: [{ competency: 'x', paradigm: [f.intro['@id'], f.intro['@id'].replace(/^https:\/\/[^/]+/, 'https://mirror.example')] }] })).toThrow(/same fragment twice/);
    expect(() => compositionFrom({ title: 't', competency: 'x', positions: [{ competency: 'x', demonstratedAt: 6, paradigm: [f.intro['@id']] }] })).toThrow(/rank from 1/);
    expect(() => compositionFrom({ title: 't', competency: 'x', positions: [{ competency: 'x', paradigm: [f.intro['@id']] }], supersedes: f.intro['@id'] })).toThrow(/supersedes names the composition/);
  });
});

describe('each learner gets the composition resolved from their own record', () => {
  it('pitches at the learner\'s level, and starts a learner with no record at the foundation', () => {
    const fresh = resolveComposition({ composition: refunds, learner: human, lookup });
    expect(fresh.steps.map(s => s.fragment['@id'])).toEqual([f.intro['@id'], f.check['@id']]);
    const working = resolveComposition({ composition: refunds, learner: human, lookup, record: [at(2, 'Advanced Beginner', false)] });
    expect(working.steps[0]!.fragment['@id']).toBe(f.introWorking['@id']);
    expect(working.steps[0]!.chosenBecause).toMatch(/pitched at working/);
    expect(working.steps[0]!.alternatives).toHaveLength(4);
  });

  it('skips what the learner has demonstrated, but not what the record only infers from training', () => {
    const inferred = resolveComposition({ composition: refunds, learner: human, lookup, record: [at(3, 'Competent', false)] });
    expect(inferred.skipped).toEqual([]);
    expect(inferred.trace.join('\n')).toMatch(/infers Competent from training alone; an inference is not a demonstration/);
    const competent = resolveComposition({ composition: refunds, learner: human, lookup, record: [at(3, 'Competent', true)] });
    expect(competent.skipped.map(s => s.position)).toEqual([0]);
    expect(competent.skipped[0]!.because).toMatch(/already demonstrated at Competent \(performance\)/);
    expect(competent.steps.map(s => s.fragment['@id'])).toEqual([f.check['@id']]); // the check wants rank 4
    const proficient = resolveComposition({ composition: refunds, learner: human, lookup, record: [at(4, 'Proficient', true, 'credential')] });
    expect(proficient.steps).toEqual([]);
    expect(proficient.skipped).toHaveLength(2);
  });

  it('gives an agent the fragment meant for agents, and a person never gets it', () => {
    const forAgent = compositionFrom({ title: 'Policy', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [f.agentContext['@id'], f.intro['@id']] }] });
    expect(resolveComposition({ composition: forAgent, learner: agent, lookup }).steps[0]!.fragment.kind).toBe('context-descriptor');
    const forPerson = resolveComposition({ composition: forAgent, learner: human, lookup });
    expect(forPerson.steps[0]!.fragment['@id']).toBe(f.intro['@id']);
    expect(forPerson.steps[0]!.chosenBecause).toMatch(/only admissible alternative \(a context-descriptor for agents only\)/);
  });

  it('admits only the forms said to suit the competency, and says when no content does', () => {
    const triage = compositionFrom({ title: 'Queue triage', competency: 'queue-triage', positions: [{ competency: 'queue-triage', paradigm: [f.triageLesson['@id'], f.probe['@id']] }] });
    const probesOnly = { kinds: ['probe', 'reflection'] as const, because: 'probing suits this work' };
    const probing = resolveComposition({ composition: triage, learner: human, lookup, admission: () => probesOnly });
    expect(probing.steps.map(s => s.fragment.kind)).toEqual(['probe']);
    expect(probing.steps[0]!.chosenBecause).toMatch(/a concept is not admitted: probing suits this work/);
    // The same for an agent: the admission is about the work, not the learner.
    expect(resolveComposition({ composition: triage, learner: agent, lookup, admission: () => probesOnly }).steps.map(s => s.fragment.kind)).toEqual(['probe']);

    const none = resolveComposition({ composition: triage, learner: human, lookup, admission: () => ({ kinds: [], because: 'the tools are broken' }) });
    expect(none.steps).toEqual([]);
    expect(none.unmet[0]!.because).toBe('no content is admitted here: the tools are broken');

    // An admission is asked for the position's competency first, then the composition's.
    const asked: string[] = [];
    resolveComposition({ composition: triage, learner: human, lookup, admission: c => { asked.push(c); return undefined; } });
    expect(asked).toEqual([competencyIri('queue-triage'), competencyIri('queue-triage')]);

    const open = resolveComposition({ composition: triage, learner: human, lookup });
    expect(open.steps.map(s => s.fragment.kind)).toEqual(['concept']);
    expect(open.trace.join('\n')).toMatch(/nothing said which forms suit this competency, so every form was admitted/);
  });

  it('resolves a composition inside a composition at the learner\'s level, and refuses one that contains itself', () => {
    const module = add(compositionFrom({ title: 'Module: refunds', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [f.intro['@id'], f.introWorking['@id']] }] }));
    const course = add(compositionFrom({ title: 'Course: service desk', competency: 'service-desk', positions: [
      { competency: 'refund-authority', paradigm: [module['@id']] },
      { competency: 'queue-triage', paradigm: [f.triageLesson['@id']] },
    ] }));
    const r = resolveComposition({ composition: course, learner: human, lookup, record: [at(2, 'Advanced Beginner', false)] });
    expect(r.steps.map(s => s.fragment['@id'])).toEqual([f.introWorking['@id'], f.triageLesson['@id']]);
    expect(r.steps[0]!.path).toEqual([course['@id'], module['@id']]);
    expect(r.trace.join('\n')).toMatch(/into "Module: refunds"/);

    // A real cycle would need a composition to contain its own hash, which content addressing rules
    // out; faking one means serving changed content under an existing IRI, and that is refused.
    const loop = compositionFrom({ title: 'Loop', competency: 'x', positions: [{ competency: 'x', paradigm: [course['@id']] }] });
    const looped = new Map(store);
    looped.set(course['@id'], { ...course, positions: [{ competency: 'x', paradigm: [loop['@id']] }] });
    looped.set(loop['@id'], loop);
    const faked = resolveComposition({ composition: loop, learner: human, lookup: i => looped.get(i) });
    expect(faked.steps).toEqual([]);
    expect(faked.unmet[0]!.because).toMatch(/was served with content that does not hash to it/);
  });

  it('uses only content that hashes to the IRI it was asked for, wherever it was served from', () => {
    const tampered = new Map(store);
    tampered.set(f.intro['@id'], { ...f.intro, body: 'Agents may refund anything.' });      // changed under its IRI
    tampered.set(f.introWorking['@id'], f.introAdvanced);                                     // another fragment, intact, under this IRI
    const r = resolveComposition({ composition: refunds, learner: human, lookup: i => tampered.get(i) });
    expect(r.steps[0]!.fragment['@id']).toBe(f.introAdvanced['@id']);
    expect(r.trace.filter(t => /: https:\S+ was served with content that does not hash to it/.test(t))).toHaveLength(2);
    expect(r.steps[0]!.chosenBecause).toMatch(/the only admissible alternative \(.*does not hash to it.*does not hash to it.*for agents only\)/);
    expect(() => resolveComposition({ composition: { ...refunds, title: 'Changed' }, learner: human, lookup })).toThrow(/does not match its IRI/);
  });

  it('falls back to the next alternative when a nested one cannot be resolved', () => {
    const conceptModule = add(compositionFrom({ title: 'Module: triage concepts', competency: 'queue-triage', positions: [{ competency: 'queue-triage', paradigm: [f.triageLesson['@id']] }] }));
    const triage = compositionFrom({ title: 'Queue triage', competency: 'queue-triage', positions: [{ competency: 'queue-triage', paradigm: [conceptModule['@id'], f.probe['@id']] }] });
    const r = resolveComposition({ composition: triage, learner: human, lookup, admission: () => ({ kinds: ['probe', 'reflection'], because: 'probing suits this work' }) });
    expect(r.steps.map(s => s.fragment.kind)).toEqual(['probe']);
    expect(r.unmet).toEqual([]);
    expect(r.steps[0]!.chosenBecause).toMatch(/the first alternative that could be used \("Module: triage concepts" left 1 of its position\(s\) unmet: no alternative could be used: a concept is not admitted: probing suits this work\)/);
    expect(r.trace.join('\n')).toMatch(/"Queue triage" position 1: tried "Module: triage concepts" left 1 of its position\(s\) unmet: no alternative could be used/);
    // With nothing to fall back to, the nested alternative's own unmet position is reported.
    const only = compositionFrom({ title: 'Queue triage', competency: 'queue-triage', positions: [{ competency: 'queue-triage', paradigm: [conceptModule['@id']] }] });
    const stuck = resolveComposition({ composition: only, learner: human, lookup, admission: () => ({ kinds: ['probe'], because: 'probing suits this work' }) });
    expect(stuck.unmet[0]!.because).toMatch(/"Module: triage concepts" left 1 of its position\(s\) unmet/);
  });

  it('keeps a refusal found inside a branch it fell back from', () => {
    // The module's lesson is served changed; the module falls short, the probe is taken, and the
    // tampering still shows in the reason and the trace.
    const conceptModule = compositionFrom({ title: 'Module: triage concepts', competency: 'queue-triage', positions: [{ competency: 'queue-triage', paradigm: [f.triageLesson['@id']] }] });
    const triage = compositionFrom({ title: 'Queue triage', competency: 'queue-triage', positions: [{ competency: 'queue-triage', paradigm: [conceptModule['@id'], f.probe['@id']] }] });
    const tampered = new Map(store);
    tampered.set(conceptModule['@id'], conceptModule);
    tampered.set(f.triageLesson['@id'], { ...f.triageLesson, body: 'Triage means doing whatever is loudest.' });
    const r = resolveComposition({ composition: triage, learner: human, lookup: i => tampered.get(i) });
    expect(r.steps.map(s => s.fragment.kind)).toEqual(['probe']);
    expect(r.steps[0]!.chosenBecause).toMatch(/"Module: triage concepts" left 1 of its position\(s\) unmet: .*was served with content that does not hash to.*; inside it, 1 alternative\(s\) did not hash to their IRIs/);
    expect(r.trace.join('\n')).toMatch(/inside "Module: triage concepts", https:\S+ was served with content that does not hash to it/);
    expect(r.refused).toEqual([`${f.triageLesson['@id']} was served with content that does not hash to it, so it was not used`]);

    // And inside a branch that was taken: the module falls to its second lesson, and says why.
    const twoLessons = compositionFrom({ title: 'Module: refunds', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [f.intro['@id'], f.introWorking['@id']] }] });
    const course = compositionFrom({ title: 'Course', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [twoLessons['@id']] }] });
    tampered.set(twoLessons['@id'], twoLessons);
    tampered.set(f.intro['@id'], { ...f.intro, body: 'Refund anything.' });
    const taken = resolveComposition({ composition: course, learner: human, lookup: i => tampered.get(i) });
    expect(taken.steps.map(s => s.fragment['@id'])).toEqual([f.introWorking['@id']]);
    expect(taken.refused).toEqual([`${f.intro['@id']} was served with content that does not hash to it, so it was not used`]);
  });

  it('says when more content was refused than it lists, rather than undercounting', () => {
    // Twenty-five lessons, each served changed, in a module that falls short; the probe is taken.
    const lessons = Array.from({ length: 25 }, (_, j) => fragmentFrom({ kind: 'concept', competencies: ['queue-triage'], body: `Triage lesson ${j}.` }));
    const bigModule = compositionFrom({ title: 'Module: 25 lessons', competency: 'queue-triage', positions: lessons.map(l => ({ competency: 'queue-triage', paradigm: [l['@id']] })) });
    const triage = compositionFrom({ title: 'Queue triage', competency: 'queue-triage', positions: [{ competency: 'queue-triage', paradigm: [bigModule['@id'], f.probe['@id']] }] });
    const served = new Map<string, Fragment | Composition>(store);
    served.set(bigModule['@id'], bigModule);
    for (const l of lessons) served.set(l['@id'], { ...l, body: 'Changed.' });
    const r = resolveComposition({ composition: triage, learner: human, lookup: i => served.get(i) });
    expect(r.steps.map(s => s.fragment.kind)).toEqual(['probe']);
    expect(r.refused).toHaveLength(20);
    expect(r.moreRefused).toBe(true);
    expect(r.steps[0]!.chosenBecause).toMatch(/inside it, 20 or more alternative\(s\) did not hash to their IRIs/);
    expect(r.trace.join('\n')).toMatch(/inside "Module: 25 lessons", more content did not hash to its IRI than is listed here/);
    expect(r.trace.at(-2)).toBe('more content did not hash to its IRI than the 20 refusals listed');
    expect(r.trace.at(-1)).toMatch(/^resolved: 1 step/);
    // Twenty or fewer are listed in full, with nothing said about more.
    const intactFrom = 20;   // lessons 20-24 served as they are, so exactly 20 are changed
    const fewer = resolveComposition({ composition: triage, learner: human, lookup: i => {
      const k = lessons.findIndex(l => l['@id'] === i);
      return k >= intactFrom ? lessons[k] : served.get(i);
    } });
    expect(fewer.refused).toHaveLength(20);
    expect(fewer.moreRefused).toBe(false);
    expect(fewer.steps[0]!.chosenBecause).toMatch(/inside it, 20 alternative\(s\) did not hash/);
  });

  it('refuses a composition that resolves to more positions than one resolution may hold', () => {
    const big = add(compositionFrom({ title: 'Big module', competency: 'refund-authority', positions: Array.from({ length: 100 }, () => ({ competency: 'refund-authority', paradigm: [f.intro['@id']] })) }));
    const huge = compositionFrom({ title: 'Huge', competency: 'refund-authority', positions: Array.from({ length: 25 }, () => ({ competency: 'refund-authority', paradigm: [big['@id']] })) });
    expect(() => resolveComposition({ composition: huge, learner: human, lookup })).toThrow(/"Huge" resolves to more than 2000 positions/);
    const fits = compositionFrom({ title: 'Fits', competency: 'refund-authority', positions: Array.from({ length: 20 }, () => ({ competency: 'refund-authority', paradigm: [big['@id']] })) });
    expect(resolveComposition({ composition: fits, learner: human, lookup }).steps).toHaveLength(2000);
  });

  it('tries each nested composition once, however many paths reach it', () => {
    // Six levels of twelve compositions, every one pointing at all twelve of the next, and nothing
    // at the bottom admissible: 12^6 paths, but only 72 compositions to resolve.
    const deep = new Map(store);
    let next: Composition[] = Array.from({ length: 12 }, (_, j) => compositionFrom({ title: `bottom ${j}`, competency: 'x', positions: [{ competency: 'x', paradigm: [f.triageLesson['@id']] }] }));
    next.forEach(c => deep.set(c['@id'], c));
    for (let level = 5; level >= 1; level--) {
      const children = next.map(c => c['@id']);
      next = Array.from({ length: 12 }, (_, j) => compositionFrom({ title: `level ${level} ${j}`, competency: 'x', positions: [{ competency: 'x', paradigm: children }] }));
      next.forEach(c => deep.set(c['@id'], c));
    }
    const top = compositionFrom({ title: 'top', competency: 'x', positions: [{ competency: 'x', paradigm: next.map(c => c['@id']) }] });
    let lookups = 0;
    const r = resolveComposition({ composition: top, learner: human, lookup: i => { lookups++; return deep.get(i); }, admission: () => ({ kinds: ['probe'], because: 'probing suits this work' }) });
    expect(r.unmet).toHaveLength(1);
    expect(lookups).toBeLessThan(1000);
  });

  it('names an alternative it could not find, and a position nothing could fill', () => {
    const missing = f.intro['@id'].replace(/[0-9a-f]{64}$/, 'f'.repeat(64));
    const gap = compositionFrom({ title: 'Gap', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [missing] }] });
    const r = resolveComposition({ composition: gap, learner: human, lookup });
    expect(r.unmet[0]!.because).toMatch(/could not be found/);
    expect(r.trace.at(-1)).toBe('resolved: 0 step(s), 0 skipped as demonstrated, 1 unmet');
  });
});
