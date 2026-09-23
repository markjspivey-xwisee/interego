/**
 * The judgment loop on a decision kind neither vertical has: an incident's severity, judged by
 * an agent and by a model, confirmed by a person and by each other, calibrated, attested,
 * ranked, and finally allowed or refused to act alone. Every step is the kit's; nothing here
 * knows about code or content.
 */
import { describe, expect, it } from 'vitest';
import {
  attestation, autonomy, awaitingAPerson, calibration, crossConfirmations, judgment, outcome, rankJudges, reputations,
  type DecisionKind, type LoopAttestation, type LoopJudgment, type LoopOutcome,
} from '../judgment-kit/loop.js';

const SEVERITY: DecisionKind = { kind: 'incident-severity', alternatives: ['sev1', 'sev2', 'sev3', 'sev4'], axis: 'accuracy' };
const OWNER: DecisionKind = { kind: 'incident-owner-team', alternatives: ['platform', 'payments', 'identity'], axis: 'competence' };
const KINDS = [SEVERITY, OWNER];
const AGENT = 'https://pod.example/u-eth-1/profile/card#me';
const MODEL = 'urn:typesafe:model:jev-1.13.0';
const PERSON = 'https://id.example/on-call#me';
const AT = '2026-09-23T10:00:00.000Z';
const POLICY = 'urn:example:policy:incident-judgment-reputation-v1';

describe('a judgment', () => {
  it('normalises the weights it is given over the kind\'s alternatives', () => {
    const j = judgment(SEVERITY, { id: 'j1', subject: 'INC-1', answer: 'sev2', probabilities: { sev1: 1, sev2: 3 }, judge: AGENT, createdAt: AT });
    expect(j.probabilities).toEqual({ sev1: 0.25, sev2: 0.75, sev3: 0, sev4: 0 });
    expect(j.confidence).toBe(0.75);
  });
  it('spreads what the confidence leaves over the other alternatives', () => {
    const j = judgment(SEVERITY, { id: 'j2', subject: 'INC-1', answer: 'sev1', confidence: 0.7, judge: MODEL, createdAt: AT });
    expect(Object.values(j.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(j.probabilities['sev1']).toBe(0.7);
    expect(j.probabilities['sev4']).toBeCloseTo(0.1, 12);
  });
  it('refuses an answer outside the kind and weights that carry nothing', () => {
    expect(() => judgment(SEVERITY, { id: 'x', subject: 'INC-1', answer: 'sev9', judge: AGENT })).toThrow(/must be one of sev1/);
    expect(() => judgment(SEVERITY, { id: 'x', subject: 'INC-1', answer: 'sev1', probabilities: { sev1: 0 }, judge: AGENT })).toThrow(/at least one alternative/);
  });
});

describe('an outcome', () => {
  const j = judgment(SEVERITY, { id: 'j1', subject: 'INC-1', answer: 'sev2', confidence: 0.7, judge: AGENT, createdAt: AT });
  it('is a hit with a small Brier when the person agrees, a miss with a large one when not', () => {
    const hit = outcome(j, 'sev2', { did: PERSON }, new Date(AT));
    expect(hit).toMatchObject({ judgmentId: 'j1', kind: 'incident-severity', judge: AGENT, hit: true, confirmedByKind: 'human', createdAt: AT });
    expect(hit.brier).toBeCloseTo(0.12, 4);
    expect(hit).not.toHaveProperty('confirmedFrom');
    const miss = outcome(j, 'sev1', { did: MODEL, kind: 'agent', from: 'j2' });
    expect(miss).toMatchObject({ hit: false, confirmedByKind: 'agent', confirmedFrom: 'j2' });
    expect(miss.brier).toBeGreaterThan(hit.brier);
  });
  it('refuses a confirmed answer the judgment never weighed', () => {
    expect(() => outcome(j, 'sev9', { did: PERSON })).toThrow(/must be one of/);
  });
});

/** The agent judges six incidents' severity, right five times, and three owners, right twice; the person confirms them all. */
function agentsRecord(): { judgments: LoopJudgment[]; outcomes: LoopOutcome[] } {
  const truth: Record<string, string> = { 'INC-1': 'sev2', 'INC-2': 'sev1', 'INC-3': 'sev3', 'INC-4': 'sev3', 'INC-5': 'sev4', 'INC-6': 'sev2' };
  const said: Record<string, string> = { ...truth, 'INC-6': 'sev1' };
  const judgments = Object.keys(truth).map((inc, i) => judgment(SEVERITY, { id: `s${i}`, subject: inc, answer: said[inc]!, confidence: 0.8, judge: AGENT, createdAt: AT }));
  const owners = ['INC-1', 'INC-2', 'INC-3'].map((inc, i) => judgment(OWNER, { id: `o${i}`, subject: inc, answer: i === 2 ? 'identity' : 'payments', confidence: 0.6, judge: AGENT, createdAt: AT }));
  const outcomes = [
    ...judgments.map((j) => outcome(j, truth[j.subject]!, { did: PERSON }, new Date(AT))),
    ...owners.map((j) => outcome(j, 'payments', { did: PERSON }, new Date(AT))),
  ];
  return { judgments: [...judgments, ...owners], outcomes };
}

describe('calibration', () => {
  const { outcomes } = agentsRecord();
  it('holds a cell per kind, Asserted from the floor, counting people and agents apart', () => {
    const cells = calibration(outcomes, KINDS, 5);
    expect(cells.map((c) => [c.kind, c.samples, c.hitRate, c.status])).toEqual([
      ['incident-severity', 6, 0.833, 'Asserted'],
      ['incident-owner-team', 3, 0.667, 'Hypothetical'],
    ]);
    expect(cells[0]).toMatchObject({ humanSamples: 6, agentSamples: 0 });
    const withAgent = calibration([...outcomes, outcome(judgment(OWNER, { id: 'o9', subject: 'INC-9', answer: 'platform', judge: AGENT }), 'platform', { did: MODEL, kind: 'agent', from: 'm9' })], KINDS, 5);
    expect(withAgent[1]).toMatchObject({ samples: 4, humanSamples: 3, agentSamples: 1 });
  });
});

describe('an attestation', () => {
  const { outcomes } = agentsRecord();
  const who = { attestor: AGENT, subject: AGENT, descriptorUrl: 'https://pod.example/u-eth-1/attestations/a1', fromExecution: 'https://pod.example/u-eth-1/calibration', attestedAt: AT };
  it('is nothing until a cell reaches its floor', () => {
    expect(attestation(calibration(outcomes, KINDS, 7), KINDS, who)).toBeUndefined();
  });
  it('puts each Asserted kind\'s hit rate on its axis, honesty from the Brier, and is Self when the judge attests itself', () => {
    const a = attestation(calibration(outcomes, KINDS, 5), KINDS, who);
    expect(a).toMatchObject({ direction: 'Self', samples: 6, kinds: ['incident-severity'], confirmers: { human: 6, agent: 0 } });
    expect(a?.axes['accuracy']).toBe(0.833);
    expect(a?.axes).not.toHaveProperty('competence');
    expect(a?.axes['honesty']).toBeGreaterThan(0.8);
    expect(a?.axes['recency']).toBe(1);
    expect(attestation(calibration(outcomes, KINDS, 3), KINDS, who)).toMatchObject({ kinds: ['incident-severity', 'incident-owner-team'], samples: 9 });
    expect(attestation(calibration(outcomes, KINDS, 5), KINDS, { ...who, attestor: PERSON })?.direction).toBe('Peer');
  });
  it('pools kinds that report on the same axis by sample', () => {
    const OWNER_ON_ACCURACY: DecisionKind = { ...OWNER, axis: 'accuracy' };
    const a = attestation(calibration(outcomes, [SEVERITY, OWNER_ON_ACCURACY], 3), [SEVERITY, OWNER_ON_ACCURACY], who);
    expect(a?.axes['accuracy']).toBe(0.778); // (5 + 2) / 9
  });
});

describe('reputation, the best judge, and autonomy', () => {
  const { outcomes } = agentsRecord();
  const cells = calibration(outcomes, KINDS, 5);
  const self = attestation(cells, KINDS, { attestor: AGENT, subject: AGENT, descriptorUrl: 'urn:att:self', fromExecution: 'urn:cal:agent', attestedAt: AT }) as LoopAttestation;
  const modelCells = calibration(
    Array.from({ length: 5 }, (_, i) => outcome(judgment(SEVERITY, { id: `m${i}`, subject: `INC-${i}`, answer: 'sev2', confidence: 0.9, judge: MODEL, createdAt: AT }), 'sev2', { did: PERSON }, new Date(AT))),
    KINDS, 5,
  );
  const aboutModel = attestation(modelCells, KINDS, { attestor: AGENT, subject: MODEL, descriptorUrl: 'urn:att:peer', fromExecution: 'urn:cal:model', attestedAt: AT }) as LoopAttestation;
  const snapshots = reputations([self, aboutModel], POLICY, AT);

  it('gives every attested judge a snapshot on the kind\'s axis', () => {
    expect(snapshots.get(AGENT)?.axes['accuracy']).toBeCloseTo(0.833, 6);
    expect(snapshots.get(MODEL)?.axes['accuracy']).toBeCloseTo(1, 6);
  });
  it('ranks the judges for a kind by that axis, the unrated last', () => {
    const ranked = rankJudges(new Map([...snapshots, ['urn:nobody', null]]), SEVERITY);
    expect(ranked.map((r) => [r.judge, r.value === null ? null : Math.round(r.value * 1000) / 1000])).toEqual([[MODEL, 1], [AGENT, 0.833], ['urn:nobody', null]]);
    expect(ranked[0]?.axis).toBe('accuracy');
  });
  it('refuses autonomy in the order the rule fails, and grants it when nothing does', () => {
    const rule = { kind: 'incident-severity', floor: 0.8, minSamples: 5, minHumanConfirmers: 3 };
    expect(autonomy(rule, SEVERITY, null, undefined)).toMatchObject({ granted: false, why: /no attestation rates/ });
    expect(autonomy({ ...rule, floor: 0.9 }, SEVERITY, snapshots.get(AGENT) ?? null, self)).toMatchObject({ granted: false, why: /below the floor 0.9/ });
    expect(autonomy({ ...rule, minSamples: 10 }, SEVERITY, snapshots.get(AGENT) ?? null, self)).toMatchObject({ granted: false, why: /6 outcome\(s\) of incident-severity, below 10/ });
    expect(autonomy(rule, OWNER, snapshots.get(AGENT) ?? null, self)).toMatchObject({ granted: false, why: /no attestation rates the judge on competence/ });
    const onlyAgents: LoopAttestation = { ...self, confirmers: { human: 0, agent: 6 } };
    expect(autonomy(rule, SEVERITY, snapshots.get(AGENT) ?? null, onlyAgents)).toMatchObject({ granted: false, why: /0 of those were confirmed by a person, below 3/ });
    expect(autonomy(rule, SEVERITY, snapshots.get(AGENT) ?? null, self)).toMatchObject({ granted: true, why: /accuracy 0.833 clears 0.8 over 6 outcome\(s\), 6 confirmed by a person/ });
  });
});

describe('what a person still owes, and what judges owe each other', () => {
  const a1 = judgment(SEVERITY, { id: 'a1', subject: 'INC-1', answer: 'sev2', judge: AGENT, createdAt: '2026-09-23T09:00:00.000Z' });
  const a1b = judgment(SEVERITY, { id: 'a1b', subject: 'INC-1', answer: 'sev1', judge: AGENT, createdAt: '2026-09-23T09:30:00.000Z' });
  const m1 = judgment(SEVERITY, { id: 'm1', subject: 'INC-1', answer: 'sev2', judge: MODEL, createdAt: AT });
  const m2 = judgment(SEVERITY, { id: 'm2', subject: 'INC-2', answer: 'sev3', judge: MODEL, createdAt: AT });
  it('an agent\'s confirmation counts but only a person\'s retires a judgment', () => {
    const byAgent = outcome(a1b, 'sev2', { did: MODEL, kind: 'agent', from: 'm1' });
    expect(awaitingAPerson([a1b, m1], [byAgent]).map((j) => j.id)).toEqual(['a1b', 'm1']);
    expect(awaitingAPerson([a1b, m1], [byAgent, outcome(m1, 'sev2', { did: PERSON })]).map((j) => j.id)).toEqual(['a1b']);
  });
  it('pairs each judge\'s newest judgment of a subject with every other judge\'s, once each way, never alone', () => {
    const pairs = crossConfirmations([a1, a1b, m1, m2], []);
    expect(pairs.map((p) => `${p.judgment.id}<${p.peer.id}`).sort()).toEqual(['a1b<m1', 'm1<a1b']);
    const done = outcome(a1b, m1.answer, { did: MODEL, kind: 'agent', from: 'm1' });
    expect(crossConfirmations([a1, a1b, m1, m2], [done]).map((p) => `${p.judgment.id}<${p.peer.id}`)).toEqual(['m1<a1b']);
  });
});
