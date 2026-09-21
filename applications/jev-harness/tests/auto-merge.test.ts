/**
 * The gated auto-merge decision: every condition on its own, all of them together, and the
 * two modes — a person required, or not.
 */
import { describe, expect, it } from 'vitest';
import { AUTO_MERGE_POLICY, AUTO_MERGED_LABEL, autoMergeDecision, reviewVerdictEvidence } from '../src/auto-merge.js';

const earned = { cells: [{ kind: 'navigation', liveSamples: 3 }, { kind: 'review-verdict', liveSamples: 25, liveAgreement: { agree: 23, conservative: 1, disagree: 1 } }] };
const all = { verdict: 'auto-ok', selectionResult: 'success', armed: true, tokenPresent: true, calibration: earned };
const withPerson = { ...all, requireHumanReview: true, reputation: { axes: { accuracy: 0.92, competence: 0.7 }, contributing: 1 } };

describe('the evidence', () => {
  it('reads live agreement from the review-verdict cell, null before any person decided', () => {
    expect(reviewVerdictEvidence(earned)).toEqual({ liveSamples: 25, agreeRate: 0.92, disagreeRate: 0.04 });
    expect(reviewVerdictEvidence({ cells: [{ kind: 'review-verdict', liveSamples: 4 }] })).toEqual({ liveSamples: 4, agreeRate: null, disagreeRate: null });
    expect(reviewVerdictEvidence(undefined)).toEqual({ liveSamples: 0, agreeRate: null, disagreeRate: null });
  });
});

describe('without a person required (the default)', () => {
  it('merges on armed, token, green tests and any verdict but block — four conditions, no calibration bar', () => {
    const d = autoMergeDecision(all);
    expect(d.merge).toBe(true);
    expect(d.reasons).toHaveLength(4);
    expect(d.reasons[3]).toContain('needs-human-review is advisory');
    const advisory = autoMergeDecision({ ...all, verdict: 'needs-human-review', calibration: undefined });
    expect(advisory.merge).toBe(true);
    expect(advisory.reasons[3]).toContain('verdict needs-human-review');
  });
  it('never merges on a secret in the diff, or with no verdict to read', () => {
    expect(autoMergeDecision({ ...all, verdict: 'block' })).toMatchObject({ merge: false });
    expect(autoMergeDecision({ ...all, verdict: 'block' }).reasons[3]).toContain('found a secret in the diff (block)');
    const { verdict: _v, ...noVerdict } = all;
    expect(autoMergeDecision(noVerdict).reasons[3]).toContain('no verdict to read');
    expect(autoMergeDecision(noVerdict).merge).toBe(false);
  });
  it('refuses when unarmed, without a token, or on a red selection — naming the condition', () => {
    expect(autoMergeDecision({ ...all, armed: false }).merge).toBe(false);
    expect(autoMergeDecision({ ...all, armed: false }).reasons[0]).toContain('not armed');
    expect(autoMergeDecision({ ...all, tokenPresent: false }).reasons[1]).toContain('ship nothing');
    expect(autoMergeDecision({ ...all, selectionResult: 'failure' }).reasons[2]).toContain('did not pass (job result: failure)');
  });
  it('names the label an automatic merge carries', () => {
    expect(AUTO_MERGED_LABEL).toBe('jev-harness:auto-merged');
  });
});

describe('with a person required', () => {
  it('merges only when every condition holds, and says so six times', () => {
    const d = autoMergeDecision(withPerson);
    expect(d.merge).toBe(true);
    expect(d.reasons).toHaveLength(6);
    expect(d.reasons.every((r) => r.startsWith('holds: '))).toBe(true);
    expect(d.reasons[4]).toContain('25 live review-verdict outcome(s): agreement 0.92 (floor 0.9), disagreement 0.04 (ceiling 0.05)');
    expect(d.reasons[5]).toContain('the reputation from 1 attestation(s) rates accuracy 0.92 (floor 0.9)');
  });

  it('refuses when no published attestation vouches for the verdict', () => {
    const { reputation: _r, ...unread } = withPerson;
    const d = autoMergeDecision({ ...unread, reputationError: 'the bridge holds no reputation snapshot yet' });
    expect(d.merge).toBe(false);
    expect(d.reasons[5]).toContain('no attestation-based reputation could be read (the bridge holds no reputation snapshot yet)');
    expect(autoMergeDecision({ ...withPerson, reputation: { axes: { accuracy: 0.6 }, contributing: 2 } }).reasons[5]).toContain('fails: the reputation from 2 attestation(s) rates accuracy 0.6');
    expect(autoMergeDecision({ ...withPerson, reputation: { axes: { competence: 0.9 }, contributing: 1 } }).reasons[5]).toContain('rate no accuracy axis');
  });

  it('refuses any verdict but auto-ok', () => {
    const d = autoMergeDecision({ ...withPerson, verdict: 'needs-human-review' });
    expect(d.merge).toBe(false);
    expect(d.reasons[3]).toContain('a person is required');
  });

  it('refuses until the verdict has earned it: floor, agreement, disagreement, or no calibration at all', () => {
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 19, liveAgreement: { agree: 19 } }] } }).reasons[4]).toContain('19 live outcome(s), below the floor of 20');
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 30, liveAgreement: { agree: 24, conservative: 6 } }] } }).reasons[4]).toContain('fails: 30 live review-verdict outcome(s): agreement 0.8');
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 40, liveAgreement: { agree: 37, disagree: 3 } }] } }).reasons[4]).toContain('disagreement 0.075 (ceiling 0.05)');
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 20 }] } }).reasons[4]).toContain('no live review-verdict outcome carries a human decision');
    const { calibration: _c, ...noCalibration } = withPerson;
    const d = autoMergeDecision({ ...noCalibration, calibrationError: 'connect ECONNREFUSED' });
    expect(d.merge).toBe(false);
    expect(d.reasons[4]).toContain('could not be read (connect ECONNREFUSED)');
  });

  it('applies the policy it is given', () => {
    expect(autoMergeDecision({ ...withPerson, calibration: { cells: [{ kind: 'review-verdict', liveSamples: 5, liveAgreement: { agree: 5 } }] } }, { ...AUTO_MERGE_POLICY, minLiveSamples: 5 }).merge).toBe(true);
  });
});
