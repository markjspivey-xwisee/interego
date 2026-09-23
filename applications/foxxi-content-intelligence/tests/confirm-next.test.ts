/**
 * Which judgment a person should confirm next: pending means unconfirmed, the three factors
 * mean what the module says, the queue orders by priority then age, and the affordance exists.
 */
import { describe, expect, it } from 'vitest';
import { foxxiAdminAffordances } from '../affordances.js';
import { contentJudgmentCalibration, type ContentJudgment, type ContentJudgmentOutcome } from '../src/content-judgment.js';
import { CONFIRM_NEXT_WEIGHTS, cellNeedOf, confirmNext, evidenceWeaknessOf, pendingJudgments, priorityOf, uncertaintyOf, type PendingJudgment } from '../src/confirm-next.js';

const judgment = (id: string, kind: 'evidence-level' | 'work-regime', confidence: number, evidenceCount: number, createdAt: string, claim = `claim ${id}`): PendingJudgment => ({
  judgmentIri: `urn:foxxi:judgment:${id}`,
  judgment: {
    kind: 'content-judgment', id, graphIri: `urn:graph:foxxi:content-judgment:${id}`, createdAt, model: 'jev-test', confidence, judgmentKind: kind, claimText: claim,
    answer: kind === 'work-regime' ? 'Evident' : 'supported-by-context', probabilities: { a: confidence }, evidenceCount, usage: { requests: 1, input_tokens: 0, output_tokens: 0, latencyMs: 0 },
  } as ContentJudgment,
});
const outcome = (id: string, kind: 'evidence-level' | 'work-regime', hit: boolean): ContentJudgmentOutcome => ({
  kind: 'content-judgment-outcome', judgmentId: id, judgmentIri: `urn:foxxi:judgment:${id}`, judgmentKind: kind, answer: 'a', confirmedAnswer: hit ? 'a' : 'b', hit, brier: hit ? 0.1 : 1.2,
  confidence: 0.7, confirmedBy: 'https://id.example/le#me', createdAt: '2026-09-22T12:00:00.000Z',
});
const empty = contentJudgmentCalibration([], 5);

describe('pending means no outcome names the judgment', () => {
  it('drops the ones a person confirmed and keeps the rest — an agent\'s confirmation does not retire a judgment', () => {
    const js = [judgment('a', 'work-regime', 0.9, 1, '2026-09-22T10:00:00.000Z'), judgment('b', 'work-regime', 0.4, 0, '2026-09-22T11:00:00.000Z')];
    expect(pendingJudgments(js, [outcome('a', 'work-regime', true)]).map((p) => p.judgmentIri)).toEqual(['urn:foxxi:judgment:b']);
    expect(pendingJudgments(js, [{ ...outcome('a', 'work-regime', true), confirmedByKind: 'agent' }])).toHaveLength(2);
    expect(pendingJudgments(js, [])).toHaveLength(2);
  });
});

describe('the three factors', () => {
  it('uncertainty is one minus confidence, clamped', () => {
    expect(uncertaintyOf({ confidence: 0.75 })).toBe(0.25);
    expect(uncertaintyOf({ confidence: 1.4 })).toBe(0);
    expect(uncertaintyOf({ confidence: Number.NaN })).toBe(0);
  });
  it('cell need is 1 with no cell, above a half below the floor, a quarter of the miss rate once Asserted', () => {
    expect(cellNeedOf(empty, 'work-regime')).toEqual({ need: 1, status: 'none', samples: 0 });
    const two = contentJudgmentCalibration([outcome('x', 'work-regime', true), outcome('y', 'work-regime', false)], 5);
    expect(cellNeedOf(two, 'work-regime')).toEqual({ need: 0.8, status: 'Hypothetical', samples: 2 });
    const asserted = contentJudgmentCalibration(Array.from({ length: 5 }, (_, i) => outcome(`e${i}`, 'evidence-level', i < 4)), 5);
    const c = cellNeedOf(asserted, 'evidence-level');
    expect(c.status).toBe('Asserted');
    expect(c.need).toBeCloseTo(0.05, 5);
  });
  it('evidence weakness falls with every item cited', () => {
    expect(evidenceWeaknessOf({ evidenceCount: 0 })).toBe(1);
    expect(evidenceWeaknessOf({ evidenceCount: 1 })).toBe(0.5);
    expect(evidenceWeaknessOf({ evidenceCount: 3 })).toBe(0.25);
  });
  it('combines them with the stated weights, which sum to one', () => {
    expect(CONFIRM_NEXT_WEIGHTS.uncertainty + CONFIRM_NEXT_WEIGHTS.cellNeed + CONFIRM_NEXT_WEIGHTS.evidenceWeakness + CONFIRM_NEXT_WEIGHTS.disagreement).toBeCloseTo(1, 10);
    const { priority, why } = priorityOf(judgment('p', 'work-regime', 0.6, 1, '2026-09-22T10:00:00.000Z').judgment, empty);
    expect(why).toEqual({ uncertainty: 0.4, cellNeed: 1, evidenceWeakness: 0.5, disagreement: 0, disagreesWith: [], cellStatus: 'none', cellSamples: 0 });
    expect(priority).toBe(0.41);
    const contested = priorityOf(judgment('p', 'work-regime', 0.6, 1, '2026-09-22T10:00:00.000Z').judgment, empty, [{ judge: 'did:web:other', answer: 'Emergent', judgmentIri: 'urn:foxxi:judgment:x' }]);
    expect(contested.priority).toBe(0.71);
    expect(contested.why.disagreement).toBe(1);
  });
});

describe('the queue', () => {
  it('puts the least certain, least measured, least evidenced judgment first, and breaks ties oldest first', () => {
    const pending = [
      judgment('sure', 'evidence-level', 0.95, 3, '2026-09-22T09:00:00.000Z'),
      judgment('unsure-new', 'work-regime', 0.4, 0, '2026-09-22T11:00:00.000Z'),
      judgment('unsure-old', 'work-regime', 0.4, 0, '2026-09-22T10:00:00.000Z'),
    ];
    const q = confirmNext(pending, empty, { now: new Date('2026-09-22T12:00:00.000Z'), confirmed: 0 });
    expect(q.queue.map((e) => e.judgmentIri)).toEqual(['urn:foxxi:judgment:unsure-old', 'urn:foxxi:judgment:unsure-new', 'urn:foxxi:judgment:sure']);
    expect(q.queue[0]!.priority).toBeGreaterThan(q.queue[2]!.priority);
    expect(q.queue[0]!.confirm).toEqual({ tool: 'foxxi.confirm_content_judgment', arguments: { judgment_iri: 'urn:foxxi:judgment:unsure-old', confirmed_answer: 'Evident' } });
    expect(q.pending).toBe(3);
    expect(q.computedAt).toBe('2026-09-22T12:00:00.000Z');
    expect(q.weights).toEqual(CONFIRM_NEXT_WEIGHTS);
  });
  it('a kind whose cell is Asserted and accurate drops behind a kind with no cell', () => {
    const asserted = contentJudgmentCalibration(Array.from({ length: 5 }, (_, i) => outcome(`e${i}`, 'evidence-level', true)), 5);
    const pending = [judgment('ev', 'evidence-level', 0.5, 1, '2026-09-22T09:00:00.000Z'), judgment('wr', 'work-regime', 0.5, 1, '2026-09-22T09:00:00.000Z')];
    expect(confirmNext(pending, asserted).queue.map((e) => e.why.cellStatus)).toEqual(['none', 'Asserted']);
  });
  it('cuts at the limit, reports the whole pending count, and excerpts a long claim', () => {
    const pending = Array.from({ length: 15 }, (_, i) => judgment(`j${i}`, 'work-regime', 0.5, 0, `2026-09-22T10:${String(i).padStart(2, '0')}:00.000Z`, 'x'.repeat(300)));
    const q = confirmNext(pending, empty);
    expect(q.queue).toHaveLength(12);
    expect(q.pending).toBe(15);
    expect(q.queue[0]!.claim.length).toBe(200);
    expect(confirmNext(pending, empty, { limit: 3 }).queue).toHaveLength(3);
  });
});

describe('the affordance', () => {
  it('is declared as a read-only GET beside the calibration', () => {
    const a = foxxiAdminAffordances.find((x) => x.toolName === 'foxxi.confirm_next');
    expect(a).toBeDefined();
    expect(a?.method).toBe('GET');
    expect(a?.annotations?.readOnlyHint).toBe(true);
  });
});
