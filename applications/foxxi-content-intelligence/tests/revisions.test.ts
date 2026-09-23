/**
 * Content that grades and revises itself: the weakest claims on a pod, graded from confirmations
 * before judgments and from the lowest judge when they disagree; a revision that must change
 * something; and the grade before and after once the revised claim is judged.
 */
import { describe, expect, it } from 'vitest';
import type { ContentJudgment, ContentJudgmentOutcome } from '../src/content-judgment.js';
import type { ListedJudgment } from '../src/judges.js';
import { CONTENT_REVISION_TYPE, contentRevision, evidenceRank, isContentRevision, revisionJudged, weakestClaims } from '../src/revisions.js';
import { foxxiAdminAffordances } from '../affordances.js';
import { lookupTerm } from '../src/foxxi-vocab.js';

const FOXXI = 'did:web:foxxi.example';
const CLAUDE = 'https://pod.example/u-eth-1/profile/card#me';
const listed = (id: string, judge: string | undefined, claim: string, answer: string, confidence: number, createdAt: string, slideId?: string): ListedJudgment => ({
  judgmentIri: `urn:foxxi:judgment:${id}`,
  judgment: { kind: 'content-judgment', id, graphIri: `urn:graph:foxxi:content-judgment:${id}`, createdAt, model: 'x', confidence, judgmentKind: 'evidence-level', claimText: claim, answer, probabilities: { [answer]: confidence }, evidenceCount: 0, usage: { requests: 1, input_tokens: 0, output_tokens: 0, latencyMs: 0 }, ...(judge ? { judge } : {}), ...(slideId ? { slideId } : {}) } as ContentJudgment,
});
const outcome = (judgmentId: string, answer: string, kind: 'human' | 'agent', by = CLAUDE): ContentJudgmentOutcome => ({
  kind: 'content-judgment-outcome', judgmentId, judgmentIri: `urn:foxxi:judgment:${judgmentId}`, judgmentKind: 'evidence-level', answer: 'x', confirmedAnswer: answer, hit: false, brier: 1, confidence: 0.5, confirmedBy: by, confirmedByKind: kind, createdAt: '2026-09-23T00:00:00.000Z',
});

describe('the weakest claims', () => {
  const j = [
    listed('a1', undefined, 'The 0.96 formula.', 'unsupported', 0.66, '2026-09-23T01:00:00.000Z', 'hcp-calc-handi'),
    listed('a2', CLAUDE, 'The 0.96 formula.', 'asserted-only', 0.8, '2026-09-23T01:30:00.000Z'),
    listed('b1', undefined, 'Honour goes to the low scorer.', 'supported-by-cited-evidence', 0.94, '2026-09-23T01:00:00.000Z'),
    listed('c1', undefined, 'Strokes are tallied.', 'asserted-only', 0.85, '2026-09-23T01:00:00.000Z'),
    listed('c0', undefined, 'Strokes are tallied.', 'corroborated', 0.2, '2026-09-23T00:30:00.000Z'),
  ];
  it('ranks the scale', () => {
    expect(evidenceRank('unsupported')).toBe(0);
    expect(evidenceRank('corroborated')).toBe(4);
    expect(evidenceRank('nope')).toBe(-1);
  });
  it('grades from the newest judgments, lowest judge first when they disagree, weakest claim first', () => {
    const weak = weakestClaims(j, [], FOXXI);
    expect(weak.map((w) => w.claimText)).toEqual(['The 0.96 formula.', 'Strokes are tallied.', 'Honour goes to the low scorer.']);
    expect(weak[0]).toMatchObject({ level: 'unsupported', rank: 0, gradedBy: 'judges', slideId: 'hcp-calc-handi', judgmentIri: 'urn:foxxi:judgment:a2' });
    expect(weak[0]!.judgments.map((x) => x.judge)).toEqual([CLAUDE, FOXXI]);
    // The older, higher judgment of "Strokes are tallied" is superseded by the newer one per judge.
    expect(weak[1]).toMatchObject({ level: 'asserted-only', gradedBy: 'judges' });
  });
  it('a confirmation outranks the judges, and a person\'s outranks an agent\'s', () => {
    const byAgent = weakestClaims(j, [outcome('a1', 'supported-by-context', 'agent')], FOXXI);
    expect(byAgent.find((w) => w.claimText === 'The 0.96 formula.')).toMatchObject({ level: 'supported-by-context', gradedBy: 'agent' });
    const byPerson = weakestClaims(j, [outcome('a1', 'supported-by-context', 'agent'), outcome('a2', 'corroborated', 'human', 'https://id.example/le#me')], FOXXI);
    expect(byPerson.find((w) => w.claimText === 'The 0.96 formula.')).toMatchObject({ level: 'corroborated', gradedBy: 'human' });
    expect(byPerson[0]!.claimText).toBe('Strokes are tallied.');
  });
  it('cuts at the limit', () => {
    expect(weakestClaims(j, [], FOXXI, 2)).toHaveLength(2);
  });
});

describe('a revision', () => {
  const input = { originalClaimText: 'A handicap index is the average of the best differentials, multiplied by 0.96.', originalJudgmentIri: 'urn:foxxi:judgment:a1', originalLevel: 'unsupported', revisedClaimText: 'A Handicap Index is the average of the lowest 8 of the last 20 score differentials under the World Handicap System.', evidence: [{ type: 'rule', id: 'whs-5.2' }], revisedBy: CLAUDE, revisedByKind: 'agent' as const, slideId: 'hcp-calc-handi', note: 'The 0.96 factor left with the 2020 rules.' };
  it('records what changed, who changed it, and the grade it had', () => {
    const r = contentRevision(input, new Date('2026-09-23T05:00:00.000Z'));
    expect(r).toMatchObject({ kind: 'content-revision', type: CONTENT_REVISION_TYPE, original: { claimText: input.originalClaimText, judgmentIri: 'urn:foxxi:judgment:a1', level: 'unsupported' }, revisedBy: CLAUDE, revisedByKind: 'agent', slideId: 'hcp-calc-handi' });
    expect(r.revised.evidence).toHaveLength(1);
    expect(isContentRevision(JSON.parse(JSON.stringify(r)))).toBe(true);
  });
  it('must change the words or add evidence', () => {
    expect(() => contentRevision({ ...input, revisedClaimText: input.originalClaimText, evidence: [] })).toThrow(/changes the words or adds evidence/);
    expect(() => contentRevision({ ...input, revisedClaimText: 'short' })).toThrow(/at least 8/);
  });
  it('carries the grade before and after once the revised claim is judged', () => {
    const r = revisionJudged(contentRevision(input), { answer: 'supported-by-cited-evidence' }, 'urn:foxxi:judgment:r1');
    expect(r.judged).toEqual({ judgmentIri: 'urn:foxxi:judgment:r1', level: 'supported-by-cited-evidence', from: 'unsupported', improved: true });
    const unknownBefore = revisionJudged(contentRevision({ ...input, originalLevel: undefined }), { answer: 'asserted-only' }, 'urn:foxxi:judgment:r2');
    expect(unknownBefore.judged?.improved).toBeNull();
  });
});

describe('the affordances and the vocabulary', () => {
  it('declare the weakest-claims view, the revision, and the entity type', () => {
    const names = foxxiAdminAffordances.map((a) => a.toolName);
    expect(names).toContain('foxxi.weakest_claims');
    expect(names).toContain('foxxi.revise_claim');
    expect(lookupTerm('ContentRevision')?.kind).toBe('Type');
  });
});
