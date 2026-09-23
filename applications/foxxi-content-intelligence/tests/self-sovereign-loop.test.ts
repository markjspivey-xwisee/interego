/**
 * The content-judgment loop for a self-sovereign pod: the six affordances take tenant_pod_url,
 * an outcome records who confirmed it, the calibration counts people and agents apart, and the
 * attestation says which grounded it.
 */
import { describe, expect, it } from 'vitest';
import { foxxiAdminAffordances } from '../affordances.js';
import { contentJudgmentCalibration, contentJudgmentOutcome, type ContentJudgment, type ContentJudgmentOutcome } from '../src/content-judgment.js';
import { contentAttestationAxes, contentJudgmentAttestation } from '../src/content-reputation.js';

const judgment: ContentJudgment = {
  kind: 'content-judgment', id: 'j1', graphIri: 'urn:graph:foxxi:content-judgment:j1', createdAt: '2026-09-23T00:00:00.000Z', model: 'jev-test', confidence: 0.7,
  judgmentKind: 'work-regime', claimText: 'claim', answer: 'Evident', probabilities: { Evident: 0.7, Knowable: 0.2, Emergent: 0.1 }, evidenceCount: 1,
  usage: { requests: 1, input_tokens: 0, output_tokens: 0, latencyMs: 0 },
};
const outcome = (id: string, kind: 'evidence-level' | 'work-regime', hit: boolean, by: 'human' | 'agent' | undefined): ContentJudgmentOutcome => ({
  kind: 'content-judgment-outcome', judgmentId: id, judgmentIri: `urn:foxxi:judgment:${id}`, judgmentKind: kind, answer: 'a', confirmedAnswer: hit ? 'a' : 'b', hit, brier: hit ? 0.1 : 1.2,
  confidence: 0.7, confirmedBy: 'https://pod.example/x/profile/card#me', createdAt: '2026-09-23T00:00:00.000Z', ...(by ? { confirmedByKind: by } : {}),
});

describe('who confirmed', () => {
  it('is a person unless declared otherwise, and an agent when it is', () => {
    expect(contentJudgmentOutcome(judgment, 'urn:foxxi:judgment:j1', 'Evident', { did: 'did:web:x' }).confirmedByKind).toBe('human');
    expect(contentJudgmentOutcome(judgment, 'urn:foxxi:judgment:j1', 'Knowable', { did: 'did:ethr:0xabc', kind: 'agent' }).confirmedByKind).toBe('agent');
  });
  it('is counted apart in the calibration, with a record from before the field as a person\'s', () => {
    const cal = contentJudgmentCalibration([outcome('a', 'work-regime', true, 'agent'), outcome('b', 'work-regime', false, 'agent'), outcome('c', 'work-regime', true, 'human'), outcome('d', 'work-regime', true, undefined)], 5);
    const cell = cal.cells.find((c) => c.judgmentKind === 'work-regime')!;
    expect(cell.samples).toBe(4);
    expect(cell.humanSamples).toBe(2);
    expect(cell.agentSamples).toBe(2);
  });
  it('reaches the attestation as confirmers, so a reader can weigh an agent-grounded one apart', () => {
    const cal = contentJudgmentCalibration(Array.from({ length: 5 }, (_, i) => outcome(`e${i}`, 'evidence-level', i < 4, i < 3 ? 'agent' : 'human')), 5);
    expect(contentAttestationAxes(cal)?.confirmers).toEqual({ human: 2, agent: 3 });
    expect(contentJudgmentAttestation(cal, 'did:web:judge', { fromExecution: 'https://pod.example/x/foxxi/judgments/' })?.confirmers).toEqual({ human: 2, agent: 3 });
  });
});

describe('the loop is self-sovereign', () => {
  it('every loop affordance takes tenant_pod_url, and the confirmation takes confirmed_by_kind', () => {
    const loop = ['foxxi.judge_content_claim', 'foxxi.confirm_content_judgment', 'foxxi.content_judgment_calibration', 'foxxi.attest_content_judgments', 'foxxi.content_judgment_reputation', 'foxxi.confirm_next'];
    for (const tool of loop) {
      const a = foxxiAdminAffordances.find((x) => x.toolName === tool);
      expect(a?.inputs.map((i) => i.name), `${tool} takes tenant_pod_url`).toContain('tenant_pod_url');
    }
    expect(foxxiAdminAffordances.find((x) => x.toolName === 'foxxi.confirm_content_judgment')?.inputs.map((i) => i.name)).toContain('confirmed_by_kind');
  });
});
