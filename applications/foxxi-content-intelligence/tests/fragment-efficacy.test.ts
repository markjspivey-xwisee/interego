/**
 * Alternatives that learn: what has worked where, for learners at each level, decides which of a
 * position's alternatives a learner is shown, while one with no outcome yet still gets its turn. Each
 * learner counts once per cell under a token that names nobody, an explanation is credited with the
 * check that follows it, and a cell is published only once it holds enough outcomes: not on the
 * pod, where the tally is sealed to the bridge's own key, and not in the reason for a choice.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { advancePlay, startPlay } from '../src/composition-play.js';
import { fragmentFrom, type Fragment } from '../src/content-fragments.js';
import { compositionFrom, resolveComposition, type Composition } from '../src/compositions.js';
import { competencyIri } from '../src/competency-identity.js';
import { chooseByEfficacy, EFFICACY_POLICY, EfficacyTally, openTally, outcomeToken, sealTally, wilsonLowerBound, type Outcome } from '../src/fragment-efficacy.js';
import { createEncryptedEnvelope, envelopeToJson, generateKeyPair } from '@interego/core';

const concept = (body: string, level = 'foundational'): Fragment => fragmentFrom({ kind: 'concept', level, competencies: ['refund-authority'], body });
const [a, b, c] = [concept('Explanation A'), concept('Explanation B'), concept('Explanation C')];
const check = fragmentFrom({ kind: 'assessment-item', competencies: ['refund-authority'], body: 'Check.', questions: [{ question: 'Who approves $600?', options: ['Agent', 'Team lead'], answer: 'B' }] });
const store = new Map<string, Fragment | Composition>([a, b, c, check].map(x => [x!['@id'], x!]));
const lookup = (i: string) => store.get(i);
const competency = competencyIri('refund-authority');
const outcome = (fragment: Fragment, success: boolean, level: Outcome['level'] = 'foundational'): Outcome => ({ competency, fragment: fragment['@id'], level, success });
const key = 'k'.repeat(32);

describe('what the record says about a cell', () => {
  it('bounds a success rate from below, and says nothing of a cell with no outcomes', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(10, 10)).toBeCloseTo(0.7225, 4);
    expect(wilsonLowerBound(5, 10)).toBeCloseTo(0.2366, 4);
    expect(wilsonLowerBound(50, 100)).toBeGreaterThan(wilsonLowerBound(5, 10));
  });

  it('counts each learner once per cell, under a token that names nobody and differs from cell to cell', () => {
    const t = new EfficacyTally();
    const alice = outcomeToken(key, 'did:web:alice.example', outcome(a!, true))!;
    expect(t.record(outcome(a!, true), alice)).toBe('counted');
    expect(t.record(outcome(a!, false), alice)).toBe('already-counted');
    expect(t.counts(competency, a!['@id'], 'foundational')).toEqual({ n: 1, successes: 1 });
    expect(alice).not.toContain('alice');
    expect(outcomeToken(key, 'did:web:alice.example', outcome(b!, true))).not.toBe(alice);
    expect(outcomeToken('another key'.padEnd(32, '!'), 'did:web:alice.example', outcome(a!, true))).not.toBe(alice);
    expect(t.record(outcome(a!, false), outcomeToken(key, 'did:web:bob.example', outcome(a!, false))!)).toBe('counted');
    expect(t.counts(competency, a!['@id'], 'foundational')).toEqual({ n: 2, successes: 1 });
    // A learner at another level is another cell.
    expect(t.record(outcome(a!, true, 'advanced'), outcomeToken(key, 'did:web:alice.example', outcome(a!, true, 'advanced'))!)).toBe('counted');
  });

  it('turns Asserted at the policy\'s count, and stops growing once it has heard from enough learners', () => {
    const t = new EfficacyTally();
    for (let i = 0; i < EFFICACY_POLICY.assertAt; i++) {
      t.record(outcome(a!, i % 3 !== 0), outcomeToken(key, `did:web:l${i}.example`, outcome(a!, true))!);
      expect(t.view(competency, a!['@id'], 'foundational')!.modalStatus).toBe(i + 1 >= EFFICACY_POLICY.assertAt ? 'Asserted' : 'Hypothetical');
    }
    const full = new EfficacyTally();
    for (let i = 0; i < EFFICACY_POLICY.learnersPerCell; i++) full.record(outcome(b!, true), outcomeToken(key, `did:web:m${i}.example`, outcome(b!, true))!);
    expect(full.record(outcome(b!, false), outcomeToken(key, 'did:web:late.example', outcome(b!, false))!)).toBe('full');
    expect(full.counts(competency, b!['@id'], 'foundational')).toEqual({ n: EFFICACY_POLICY.learnersPerCell, successes: EFFICACY_POLICY.learnersPerCell });
  });

  it('keeps what it stores, and trusts no stored cell whose counts and tokens disagree', () => {
    const t = new EfficacyTally();
    t.record(outcome(a!, true), outcomeToken(key, 'did:web:x.example', outcome(a!, true))!);
    const round = EfficacyTally.from(JSON.parse(JSON.stringify(t)));
    expect(round.counts(competency, a!['@id'], 'foundational')).toEqual({ n: 1, successes: 1 });
    const [cellKey, cell] = Object.entries(JSON.parse(JSON.stringify(t)) as Record<string, { n: number; successes: number; heard: string[] }>)[0]!;
    expect(EfficacyTally.from({ [cellKey]: { ...cell, n: 50, successes: 50 } }).size).toBe(0);   // 50 counts, 1 learner heard
    expect(EfficacyTally.from({ [cellKey]: { ...cell, successes: 2 } }).size).toBe(0);
    expect(EfficacyTally.from({ 'not a key': cell, [cellKey.replace('foundational', 'expert')]: cell }).size).toBe(0);
  });

  it('seals what it keeps on a pod to the bridge\'s own key, and takes back only what that key sealed', () => {
    const t = new EfficacyTally();
    const token = outcomeToken(key, 'did:web:x.example', outcome(a!, true))!;
    t.record(outcome(a!, true), token);
    const bridge = generateKeyPair();
    const sealed = sealTally(t, bridge);
    for (const clear of [token, a!['@id'], 'foundational', '"successes"']) expect(sealed).not.toContain(clear);
    expect(openTally(sealed, bridge)!.counts(competency, a!['@id'], 'foundational')).toEqual({ n: 1, successes: 1 });
    expect(openTally(sealed, generateKeyPair())).toBeUndefined();
    // Anyone can wrap a key to the bridge's public key; only the bridge can wrap one from it.
    const forged = envelopeToJson(createEncryptedEnvelope(JSON.stringify(t), [bridge.publicKey], generateKeyPair()));
    expect(openTally(forged, bridge)).toBeUndefined();
    expect(openTally(JSON.stringify(t), bridge)).toBeUndefined();
    expect(openTally('not an envelope', bridge)).toBeUndefined();
  });
});

describe('choosing among alternatives by what has worked', () => {
  it('gives an untried alternative its turn, then prefers the better record, the author\'s order breaking ties', () => {
    const counts = new Map<string, { n: number; successes: number }>([[a!['@id'], { n: 10, successes: 9 }], [b!['@id'], { n: 10, successes: 2 }]]);
    expect(chooseByEfficacy([a!['@id'], b!['@id'], c!['@id']], i => counts.get(i))).toEqual({ chosen: c!['@id'], why: 'no outcome here yet for learners at this level, so it gets its turn' });
    const pick = chooseByEfficacy([b!['@id'], a!['@id']], i => counts.get(i));
    expect(pick.chosen).toBe(a!['@id']);
    expect(pick.why).toMatch(/9 of 10 went on to succeed \(lower bound 0\.60, Hypothetical\)/);
    const even = new Map([[a!['@id'], { n: 5, successes: 3 }], [b!['@id'], { n: 5, successes: 3 }]]);
    expect(chooseByEfficacy([b!['@id'], a!['@id']], i => even.get(i)).chosen).toBe(b!['@id']);
  });

  it('says why without quoting a cell too small to publish', () => {
    const few = new Map([[a!['@id'], { n: 3, successes: 3 }], [b!['@id'], { n: 1, successes: 0 }]]);
    const pick = chooseByEfficacy([b!['@id'], a!['@id']], i => few.get(i));
    expect(pick.chosen).toBe(a!['@id']);
    expect(pick.why).toBe(`the most promising here for learners at this level: fewer than ${EFFICACY_POLICY.publishAt} outcomes so far, too few to show (Hypothetical)`);
    expect(pick.why).not.toMatch(/\d+ of \d+/);
  });

  it('decides among the fragments pitched nearest the learner, and records the level they were pitched at', () => {
    const course = compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [a!['@id'], b!['@id']] }] });
    const tally = new EfficacyTally();
    for (let i = 0; i < 12; i++) {
      tally.record(outcome(a!, i < 3), outcomeToken(key, `did:web:a${i}.example`, outcome(a!, true))!);
      tally.record(outcome(b!, i < 10), outcomeToken(key, `did:web:b${i}.example`, outcome(b!, true))!);
    }
    const r = resolveComposition({ composition: course, learner: { id: 'did:web:new.example', kind: 'human' }, lookup, efficacy: (co, fr, lv) => tally.counts(co, fr, lv) });
    expect(r.steps[0]!.fragment['@id']).toBe(b!['@id']);
    expect(r.steps[0]!.pitchedAt).toBe('foundational');
    expect(r.steps[0]!.chosenBecause).toMatch(/pitched at foundational for a learner at foundational; the most promising here for learners at this level: 10 of 12 went on to succeed \(lower bound 0\.55, Asserted\)/);
    // A learner at another level has no record here yet: the author's first gets its turn.
    const working = resolveComposition({ composition: compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [{ competency: 'refund-authority', paradigm: [concept('W1', 'working')['@id'], concept('W2', 'working')['@id']] }] }),
      learner: { id: 'did:web:w.example', kind: 'human' }, lookup: i => lookup(i) ?? [concept('W1', 'working'), concept('W2', 'working')].find(x => x['@id'] === i),
      record: [{ aboutCompetency: competency, modalStatus: 'Hypothetical', basis: 'inferred', proficiencyRank: 2, proficiencyLabel: 'Advanced Beginner' }],
      efficacy: (co, fr, lv) => tally.counts(co, fr, lv) });
    expect(working.steps[0]!.pitchedAt).toBe('working');
    expect(working.steps[0]!.chosenBecause).toMatch(/no outcome here yet for learners at this level/);
  });
});

describe('a play credits each outcome to what prepared it', () => {
  it('credits an explanation with the check that follows it at the same competency, pass or fail', () => {
    const course = compositionFrom({ title: 'Refunds', competency: 'refund-authority', positions: [
      { competency: 'refund-authority', paradigm: [a!['@id']] },
      { competency: 'refund-authority', paradigm: [check['@id']] },
    ] });
    const learner = { id: 'did:web:l.example', kind: 'agent' as const };
    const ctx = { actor: { objectType: 'Agent', account: { homePage: 'did:web:bridge.example', name: learner.id } }, now: '2026-09-26T12:00:00Z', newId: () => crypto.randomUUID() };
    for (const [answer, success] of [['B', true], ['A', false]] as const) {
      const play = startPlay(resolveComposition({ composition: course, learner, lookup }), course.title, learner, { session: 's', registration: 'r' }, ctx.now)!;
      const first = advancePlay(play, undefined, ctx);
      expect(first.ok && first.outcomes).toEqual([]);   // an explanation waits for its check
      const second = advancePlay(play, [answer], ctx);
      if (!second.ok) throw new Error(second.error);
      expect(second.outcomes).toEqual([
        { competency, fragment: check['@id'], level: 'foundational', success },
        { competency, fragment: a!['@id'], level: 'foundational', success },
      ]);
    }
  });
});

describe('the bridge learns from plays and publishes only what is safe to', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const route = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n});', src.indexOf(from)));
  it('reads the record when resolving, counts each outcome once per learner, and keeps it on the tenant pod', () => {
    expect(route('async function resolveForCaller')).toMatch(/efficacy: \(competency, fragment, level\) => fragmentEfficacy\.counts\(competency, fragment, level\)/);
    const next = route("app.post('/agent/content/next'");
    expect(next).toMatch(/outcomeToken\(efficacyKey, auth\.callerDid, o\)/);
    expect(next).toMatch(/fragmentEfficacy\.record\(o, token\) === 'counted'/);
    expect(next).toMatch(/if \(counted\) persistEfficacy\(\);/);
    expect(src).toMatch(/foxxi-lattice\/fragment-efficacy\.envelope\.json/);
  });
  it('counts only against the stored tally, and reads it again when the pod could not be read', () => {
    const fn = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n}\n', src.indexOf(from)));
    expect(route("app.post('/agent/content/next'")).toMatch(/if \(await ensureEfficacy\(\)\) \{\n\s+for \(const o of outcome\.outcomes\)/);
    const load = fn('function ensureEfficacy');
    expect(load).toMatch(/if \(efficacyRead\) return Promise\.resolve\(true\);/);
    expect(load).toMatch(/if \(r\.status === 404\) return \(efficacyRead = true\);/);
    expect(load).toMatch(/if \(!r\.ok\) return false;/);
    expect(load).toMatch(/catch \{ return false; \}/);
    expect(load).toMatch(/finally \{ efficacyLoad = undefined; \}/);
  });
  it('keeps the tally on the pod only sealed, and only with a key to seal it', () => {
    const fn = (from: string): string => src.slice(src.indexOf(from), src.indexOf('\n}\n', src.indexOf(from)));
    expect(src).toMatch(/const EFFICACY_RESOURCE = tenantPodUrl && efficacySeal \?/);
    expect(fn('function ensureEfficacy')).toMatch(/fragmentEfficacy = openTally\(await r\.text\(\), efficacySeal!\) \?\? new EfficacyTally\(\);/);
    const persist = fn('function persistEfficacy');
    expect(persist).toMatch(/body: sealTally\(fragmentEfficacy, efficacySeal!\)/);
    expect(persist).not.toMatch(/JSON\.stringify\(fragmentEfficacy\)/);
    expect(persist).toMatch(/if \(!r\.ok\) throw new Error/);
  });
  it('shows a cell only once it holds enough outcomes', () => {
    const view = route("app.get('/ns/foxxi/fragment/:hash/efficacy'");
    expect(view).toMatch(/counts\.n >= EFFICACY_POLICY\.publishAt/);
    expect(view).toMatch(/n: `fewer than \$\{EFFICACY_POLICY\.publishAt\}`/);
  });
});
