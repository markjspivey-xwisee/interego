/**
 * Foxxi's content judgments earn a reputation: the calibration becomes a Self attestation with
 * only the axes it has earned, the entity round-trips as JSON, the registry weighs it at a quarter
 * and a peer's word at a half, and the affordances and the vocabulary declare it.
 */
import { describe, expect, it } from 'vitest';
import { foxxiAdminAffordances } from '../affordances.js';
import { contentJudgmentCalibration, type ContentJudgmentOutcome } from '../src/content-judgment.js';
import { CONTENT_JUDGMENT_ATTESTATION_TYPE, CONTENT_REPUTATION_POLICY, attestationFromEntity, contentAttestationAxes, contentJudgmentAttestation, contentJudgmentReputation, isContentJudgmentAttestation } from '../src/content-reputation.js';
import { lookupTerm } from '../src/foxxi-vocab.js';

const AGENT = 'did:web:foxxi.example';
const CONTAINER = 'https://pod.example/t/foxxi/judgments/';
const outcome = (kind: 'evidence-level' | 'work-regime', hit: boolean, brier: number, i: number): ContentJudgmentOutcome => ({
  kind: 'content-judgment-outcome', judgmentId: `j${i}`, judgmentIri: `urn:foxxi:judgment:j${i}`, judgmentKind: kind, answer: 'a',
  confirmedAnswer: hit ? 'a' : 'b', hit, brier, confidence: 0.7, confirmedBy: 'https://id.example/le#me', createdAt: '2026-09-22T12:00:00.000Z',
});
const rows = [...Array.from({ length: 5 }, (_, i) => outcome('evidence-level', i < 4, 0.2, i)), outcome('work-regime', true, 0.1, 9), outcome('work-regime', false, 1.2, 10)];
const calibration = contentJudgmentCalibration(rows, 5, new Date('2026-09-22T13:00:00.000Z'));

describe('the axes a calibration supports', () => {
  it('rates accuracy from the evidence-level hit rate and honesty from the Brier, from Asserted cells only', () => {
    const a = contentAttestationAxes(calibration)!;
    expect(a.axes).toEqual({ accuracy: 0.8, honesty: 0.9 });
    expect(a.samples).toBe(5);
    expect(a.kinds).toEqual(['evidence-level']);
    expect(contentAttestationAxes(contentJudgmentCalibration(rows.slice(5), 5))).toBeUndefined();
  });
});

describe('the attestation entity', () => {
  it('is Self by the judging agent about itself, grounded where the outcomes live, and round-trips as JSON', () => {
    const att = contentJudgmentAttestation(calibration, AGENT, { fromExecution: CONTAINER, attestedAt: '2026-09-22T13:00:00.000Z' })!;
    expect(att.type).toBe(CONTENT_JUDGMENT_ATTESTATION_TYPE);
    expect(att.attestor).toBe(AGENT);
    expect(att.subject).toBe(AGENT);
    expect(att.direction).toBe('Self');
    expect(att.axes).toEqual({ accuracy: 0.8, honesty: 0.9 });
    expect(att.samples).toBe(5);
    expect(att.fromExecution).toBe(CONTAINER);
    expect(isContentJudgmentAttestation(JSON.parse(JSON.stringify(att)))).toBe(true);
    expect(isContentJudgmentAttestation({ ...att, type: 'x' })).toBe(false);
    expect(contentJudgmentAttestation(contentJudgmentCalibration([], 5), AGENT, { fromExecution: CONTAINER })).toBeUndefined();
  });
});

describe('the reputation', () => {
  it('weighs the self-attestation at a quarter, and a peer word at a half moves it toward the peer', () => {
    const att = contentJudgmentAttestation(calibration, AGENT, { fromExecution: CONTAINER, attestedAt: '2026-09-22T13:00:00.000Z' })!;
    const self = attestationFromEntity(att, `${CONTAINER}judgment-attestation-1-graph.trig`);
    expect(self.axes).toEqual({ accuracy: 0.8, honesty: 0.9, recency: 1 });
    const alone = contentJudgmentReputation(AGENT, [self], '2026-09-22T14:00:00.000Z')!;
    expect(alone.contributingAttestations).toHaveLength(1);
    expect(alone.axes['accuracy']).toBe(0.8);
    const peer = attestationFromEntity({ ...att, attestor: 'https://id.example/le#me', direction: 'Peer', axes: { accuracy: 0.4 } }, `${CONTAINER}judgment-attestation-2-graph.trig`);
    const both = contentJudgmentReputation(AGENT, [self, peer], '2026-09-22T14:00:00.000Z')!;
    expect(both.contributingAttestations).toHaveLength(2);
    expect(both.axes['accuracy']).toBeLessThan(0.8);
    expect(both.axes['accuracy']).toBeGreaterThan(0.4);
    expect(contentJudgmentReputation(AGENT, [])).toBeNull();
    expect(CONTENT_REPUTATION_POLICY.policyId).toBe('urn:foxxi:policy:content-judgment-reputation-v1');
  });
});

describe('the affordances and the vocabulary', () => {
  it('declare the two tools and the attestation type', () => {
    const names = foxxiAdminAffordances.map((a) => a.toolName);
    expect(names).toContain('foxxi.attest_content_judgments');
    expect(names).toContain('foxxi.content_judgment_reputation');
    expect(lookupTerm('ContentJudgmentAttestation')?.kind).toBe('Type');
  });
});
