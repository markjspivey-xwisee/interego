/**
 * The gated auto-merge decision: every condition on its own, and all of them together.
 */
import { describe, expect, it } from 'vitest';
import { AUTO_MERGE_POLICY, autoMergeDecision, reviewVerdictEvidence } from '../src/auto-merge.js';

const earned = { cells: [{ kind: 'navigation', liveSamples: 3 }, { kind: 'review-verdict', liveSamples: 25, liveAgreement: { agree: 23, conservative: 1, disagree: 1 } }] };
const all = { verdict: 'auto-ok', selectionResult: 'success', armed: true, tokenPresent: true, calibration: earned };

describe('the evidence', () => {
  it('reads live agreement from the review-verdict cell, null before any person decided', () => {
    expect(reviewVerdictEvidence(earned)).toEqual({ liveSamples: 25, agreeRate: 0.92, disagreeRate: 0.04 });
    expect(reviewVerdictEvidence({ cells: [{ kind: 'review-verdict', liveSamples: 4 }] })).toEqual({ liveSamples: 4, agreeRate: null, disagreeRate: null });
    expect(reviewVerdictEvidence(undefined)).toEqual({ liveSamples: 0, agreeRate: null, disagreeRate: null });
  });
});

describe('the decision', () => {
  it('merges only when every condition holds, and says so five times', () => {
    const d = autoMergeDecision(all);
    expect(d.merge).toBe(true);
    expect(d.reasons).toHaveLength(5);
    expect(d.reasons.every((r) => r.startsWith('holds: '))).toBe(true);
    expect(d.reasons[4]).toContain('25 live review-verdict outcome(s): agreement 0.92 (floor 0.9), disagreement 0.04 (ceiling 0.05)');
  });

  it('refuses when unarmed, without a token, on a red selection, or on any verdict but auto-ok — naming the condition', () => {
    expect(autoMergeDecision({ ...all, armed: false })).toMatchObject({ merge: false });
    expect(autoMergeDecision({ ...all, armed: false }).reasons[0]).toContain('not armed');
    expect(autoMergeDecision({ ...all, tokenPresent: false }).reasons[1]).toContain('ship nothing');
    expect(autoMergeDecision({ ...all, selectionResult: 'failure' }).reasons[2]).toContain('did not pass (job result: failure)');
    expect(autoMergeDecision({ ...all, verdict: 'needs-human-review' }).reasons[3]).toContain('a person decides');
    expect(autoMergeDecision({ ...all, verdict: 'needs-human-review' }).merge).toBe(false);
    const { verdict: _v, ...noVerdict } = all;
    expect(autoMergeDecision(noVerdict).reasons[3]).toContain('verdict is unknown');
  });

  it('refuses until the verdict has earned it: floor, agreement, disagreement, or no calibration at all', () => {
    expect(autoMergeDecision({ ...all, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 19, liveAgreement: { agree: 19 } }] } }).reasons[4]).toContain('19 live outcome(s), below the floor of 20');
    expect(autoMergeDecision({ ...all, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 30, liveAgreement: { agree: 24, conservative: 6 } }] } }).reasons[4]).toContain('fails: 30 live review-verdict outcome(s): agreement 0.8');
    expect(autoMergeDecision({ ...all, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 40, liveAgreement: { agree: 37, disagree: 3 } }] } }).reasons[4]).toContain('disagreement 0.075 (ceiling 0.05)');
    expect(autoMergeDecision({ ...all, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 20 }] } }).reasons[4]).toContain('no live review-verdict outcome carries a human decision');
    const { calibration: _c, ...noCalibration } = all;
    const d = autoMergeDecision({ ...noCalibration, calibrationError: 'connect ECONNREFUSED' });
    expect(d.merge).toBe(false);
    expect(d.reasons[4]).toContain('could not be read (connect ECONNREFUSED)');
  });

  it('applies the policy it is given', () => {
    expect(autoMergeDecision({ ...all, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 5, liveAgreement: { agree: 5 } }] } }, { ...AUTO_MERGE_POLICY, minLiveSamples: 5 }).merge).toBe(true);
  });
});
