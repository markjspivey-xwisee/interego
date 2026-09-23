/**
 * A network of judges: judgments name their judge, outcomes group by judge, attestations are
 * Self for the bridge's own judge and Peer for others, judges rank per kind of question, and
 * two judges' newest judgments of one claim make a cross-confirmation pair each way, once.
 */
import { describe, expect, it } from 'vitest';
import { recordedContentJudgment, type ContentJudgment, type ContentJudgmentOutcome } from '../src/content-judgment.js';
import { bestJudges, claimKey, crossConfirmPairs, disagreementsFor, judgeAttestations, judgeOf, latestJudgmentsByClaim, outcomesByJudge, type ListedJudgment } from '../src/judges.js';
import { foxxiAdminAffordances } from '../affordances.js';

const FOXXI = 'did:web:foxxi.example';
const CLAUDE = 'https://pod.example/u-eth-1/profile/card#me';

const listed = (id: string, judge: string | undefined, kind: 'evidence-level' | 'work-regime', claim: string, answer: string, createdAt: string): ListedJudgment => ({
  judgmentIri: `urn:foxxi:judgment:${id}`,
  judgment: {
    kind: 'content-judgment', id, graphIri: `urn:graph:foxxi:content-judgment:${id}`, createdAt, model: judge ? 'claude' : 'jev', confidence: 0.8, judgmentKind: kind, claimText: claim,
    answer, probabilities: { [answer]: 0.8 }, evidenceCount: 1, usage: { requests: 1, input_tokens: 0, output_tokens: 0, latencyMs: 0 }, ...(judge ? { judge } : {}),
  } as ContentJudgment,
});
const outcome = (id: string, judge: string | undefined, kind: 'evidence-level' | 'work-regime', hit: boolean, from?: string): ContentJudgmentOutcome => ({
  kind: 'content-judgment-outcome', judgmentId: id, judgmentIri: `urn:foxxi:judgment:${id}`, judgmentKind: kind, answer: 'a', confirmedAnswer: hit ? 'a' : 'b', hit, brier: hit ? 0.1 : 1.2,
  confidence: 0.8, confirmedBy: CLAUDE, confirmedByKind: 'agent', createdAt: '2026-09-23T00:00:00.000Z', ...(judge ? { judge } : {}), ...(from ? { confirmedFrom: from } : {}),
});

describe('who judged', () => {
  it('a judgment names its judge, and one from before the field is the bridge\'s own', () => {
    expect(judgeOf({ judge: CLAUDE }, FOXXI)).toBe(CLAUDE);
    expect(judgeOf({}, FOXXI)).toBe(FOXXI);
  });
  it('outcomes group by the judge they score', () => {
    const by = outcomesByJudge([outcome('a', undefined, 'work-regime', true), outcome('b', CLAUDE, 'work-regime', false), outcome('c', CLAUDE, 'evidence-level', true)], FOXXI);
    expect([...by.keys()]).toEqual([FOXXI, CLAUDE]);
    expect(by.get(CLAUDE)).toHaveLength(2);
  });
  it('an agent records its own judgment with a valid answer and concentrated probabilities', () => {
    const j = recordedContentJudgment({ judgmentKind: 'work-regime', claimText: 'Make friends on the course by talking between shots.', answer: 'Emergent', model: 'claude-fable-5-1', judge: CLAUDE });
    expect(j.judge).toBe(CLAUDE);
    expect(j.answer).toBe('Emergent');
    expect(j.probabilities['Emergent']).toBe(0.8);
    expect(Object.values(j.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(j.model).toBe('claude-fable-5-1');
    expect(() => recordedContentJudgment({ judgmentKind: 'work-regime', claimText: 'A claim long enough to judge.', answer: 'Obvious', model: 'x', judge: CLAUDE })).toThrow(/must be one of/);
    const scored = recordedContentJudgment({ judgmentKind: 'evidence-level', claimText: 'A claim long enough to judge.', answer: 'corroborated', confidence: 0.6, model: 'x', judge: CLAUDE });
    // A Score is the probability-weighted position on the scale, as the bridge's model reports it: 0.6 on level 4 and 0.1 on each of the other four is 3.0, not 4.
    expect(scored.score).toBe(3);
    expect(scored.confidence).toBe(0.6);
  });
});

describe('attestations per judge', () => {
  it('are Self for the bridge\'s own judge and Peer for another, each from that judge\'s outcomes only', () => {
    const outcomes = [
      ...Array.from({ length: 5 }, (_, i) => outcome(`f${i}`, undefined, 'work-regime', i < 4)),
      ...Array.from({ length: 5 }, (_, i) => outcome(`c${i}`, CLAUDE, 'work-regime', i < 2)),
    ];
    const per = judgeAttestations(outcomes, FOXXI, { fromExecution: 'https://pod.example/x/foxxi/judgments/' });
    expect(per.map((p) => p.judge)).toEqual([FOXXI, CLAUDE]);
    expect(per[0]!.attestation).toMatchObject({ attestor: FOXXI, subject: FOXXI, direction: 'Self', axes: { competence: 0.8 } });
    expect(per[1]!.attestation).toMatchObject({ attestor: FOXXI, subject: CLAUDE, direction: 'Peer', axes: { competence: 0.4 } });
  });
  it('rank judges for a kind by that kind\'s axis, unrated ones last', () => {
    const snap = (accuracy: number | undefined, competence: number | undefined, n: number) => ({ axes: { ...(accuracy !== undefined ? { accuracy } : {}), ...(competence !== undefined ? { competence } : {}) }, contributingAttestations: Array.from({ length: n }, () => ({})), score: 0.5 }) as unknown as import('@interego/registry').ReputationSnapshot;
    const ranked = bestJudges([{ subject: FOXXI, snapshot: snap(0.4, 0.9, 2) }, { subject: CLAUDE, snapshot: snap(0.8, 0.3, 1) }, { subject: 'did:web:new', snapshot: null }], 'evidence-level');
    expect(ranked.map((r) => r.subject)).toEqual([CLAUDE, FOXXI, 'did:web:new']);
    expect(ranked[0]).toMatchObject({ axis: 'accuracy', value: 0.8, contributing: 1 });
    expect(bestJudges([{ subject: FOXXI, snapshot: snap(0.4, 0.9, 2) }, { subject: CLAUDE, snapshot: snap(0.8, 0.3, 1) }], 'work-regime')[0]!.subject).toBe(FOXXI);
  });
});

describe('the same claim, judged twice', () => {
  const claim = 'Make friends on the course by talking between shots.';
  const jevOld = listed('j0', undefined, 'work-regime', claim, 'Evident', '2026-09-23T01:00:00.000Z');
  const jevNew = listed('j1', undefined, 'work-regime', claim, 'Evident', '2026-09-23T02:00:00.000Z');
  const claude = listed('c1', CLAUDE, 'work-regime', claim, 'Emergent', '2026-09-23T02:30:00.000Z');
  const other = listed('o1', CLAUDE, 'evidence-level', 'Another claim entirely.', 'asserted-only', '2026-09-23T02:30:00.000Z');

  it('keys a claim by kind and text, ignoring case and spacing', () => {
    expect(claimKey({ judgmentKind: 'work-regime', claimText: '  Make FRIENDS   on the course by talking between shots. ' })).toBe(claimKey(jevNew.judgment));
  });
  it('keeps the newest judgment per judge per claim', () => {
    const by = latestJudgmentsByClaim([jevOld, jevNew, claude, other], FOXXI);
    expect(by.get(claimKey(jevNew.judgment))?.get(FOXXI)?.judgmentIri).toBe('urn:foxxi:judgment:j1');
    expect(by.get(claimKey(jevNew.judgment))?.size).toBe(2);
  });
  it('names the other judges that answered differently', () => {
    const by = latestJudgmentsByClaim([jevOld, jevNew, claude, other], FOXXI);
    expect(disagreementsFor(jevNew, by, FOXXI)).toEqual([{ judge: CLAUDE, answer: 'Emergent', judgmentIri: 'urn:foxxi:judgment:c1' }]);
    expect(disagreementsFor(other, by, FOXXI)).toEqual([]);
  });
  it('★ makes one cross-confirmation each way, never against itself, never twice, never for a lone judge', () => {
    const pairs = crossConfirmPairs([jevOld, jevNew, claude, other], [], FOXXI);
    expect(pairs.map((p) => `${p.judgmentIri}<${p.peerJudgmentIri}`).sort()).toEqual(['urn:foxxi:judgment:c1<urn:foxxi:judgment:j1', 'urn:foxxi:judgment:j1<urn:foxxi:judgment:c1']);
    expect(pairs.find((p) => p.judgmentIri === 'urn:foxxi:judgment:j1')).toMatchObject({ judge: FOXXI, peerJudge: CLAUDE, peerAnswer: 'Emergent' });
    const done = [outcome('j1', undefined, 'work-regime', false, 'urn:foxxi:judgment:c1')];
    expect(crossConfirmPairs([jevOld, jevNew, claude, other], done, FOXXI).map((p) => p.judgmentIri)).toEqual(['urn:foxxi:judgment:c1']);
  });
});

describe('the affordances', () => {
  it('declare recording a judgment, cross-confirming, and asking for the best judge', () => {
    const names = foxxiAdminAffordances.map((a) => a.toolName);
    for (const t of ['foxxi.record_content_judgment', 'foxxi.cross_confirm', 'foxxi.best_judge']) expect(names).toContain(t);
    for (const t of ['foxxi.record_content_judgment', 'foxxi.cross_confirm', 'foxxi.best_judge']) {
      expect(foxxiAdminAffordances.find((a) => a.toolName === t)?.inputs.map((i) => i.name)).toContain('tenant_pod_url');
    }
  });
});
