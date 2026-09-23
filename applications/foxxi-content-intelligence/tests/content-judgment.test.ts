/**
 * The content judgment: what the model is asked, what its typed answer becomes, and what a
 * person can do next — driven with the shared kit's fake client, never the network.
 */
import { describe, expect, it } from 'vitest';
import { FakeJevClient, choiceAnswer, type Answer } from '../../_shared/judgment-kit/jev-client.js';
import {
  CONTENT_JUDGMENT_GRAPH_PREFIX, CONTENT_JUDGMENT_OUTCOME_TYPE, EVIDENCE_LEVELS, WORK_REGIMES, contentJudgmentCalibration, contentJudgmentControls,
  contentJudgmentMarkdown, contentJudgmentOutcome, decodeBundleJson, entityGraphUrl, findEntityEntry, isContentJudgment, isContentJudgmentOutcome,
  judgeContentClaim, judgmentQuestion, judgmentState, scoreContentJudgment, type ContentJudgment,
} from '../src/content-judgment.js';
import { foxxiAdminAffordances } from '../affordances.js';
import { lookupTerm } from '../src/foxxi-vocab.js';

const claim = { claimText: 'A block is satisfied once every one of its assignable units is satisfied.', context: 'Slide 12 walks through the rollup: each AU reports satisfied, the block rolls up.', evidence: [{ type: 'slide', id: 'slide-12' }], slideId: 'slide-12', conceptIds: ['rollup'] };

describe('the questions', () => {
  it('asks a Score over the evidence scale, with every level defined as a situation', () => {
    const q = judgmentQuestion('evidence-level');
    expect(q.type).toBe('score');
    expect((q as { criteria: readonly string[] }).criteria).toHaveLength(EVIDENCE_LEVELS.length);
    expect(String(q.instructions)).toContain('`claim.text`');
  });
  it('asks a Choice among the four work regimes', () => {
    const q = judgmentQuestion('work-regime');
    expect(q.type).toBe('choice');
    expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual([...WORK_REGIMES]);
  });
  it('sends the smallest state: the claim, the context, the evidence, bounded', () => {
    const s = judgmentState({ ...claim, judgmentKind: 'evidence-level', context: 'x'.repeat(10000) });
    expect((s['context'] as string).length).toBe(6000);
    expect(s['claim']).toEqual({ text: claim.claimText, slideId: 'slide-12', conceptIds: ['rollup'] });
    expect(s['evidence']).toEqual([{ type: 'slide', id: 'slide-12' }]);
  });
});

describe('judging', () => {
  it('an evidence-level judgment relabels the Score distribution with the level names and keeps the scale position', async () => {
    const jev = new FakeJevClient(() => ({
      judgment: { type: 'score', score: 2.6, legend: {}, probabilities: { '0': 0.05, '1': 0.1, '2': 0.25, '3': 0.5, '4': 0.1 }, confidence: 0.5 } as Answer,
    }));
    const j = await judgeContentClaim(jev, { ...claim, judgmentKind: 'evidence-level' });
    expect(j.kind).toBe('content-judgment');
    expect(j.graphIri.startsWith(CONTENT_JUDGMENT_GRAPH_PREFIX)).toBe(true);
    expect(j.answer).toBe('supported-by-cited-evidence');
    expect(j.probabilities).toEqual({ 'unsupported': 0.05, 'asserted-only': 0.1, 'supported-by-context': 0.25, 'supported-by-cited-evidence': 0.5, 'corroborated': 0.1 });
    expect(j.score).toBe(2.6);
    expect(j.confidence).toBe(0.5);
    expect(j.evidenceCount).toBe(1);
    expect(j.slideId).toBe('slide-12');
    expect(jev.calls[0]!.questions['judgment']!.type).toBe('score');
  });

  it('a work-regime judgment carries the Choice as it was answered', async () => {
    const jev = new FakeJevClient((_state, questions) => ({
      judgment: choiceAnswer(Object.keys((questions['judgment'] as { criteria: Record<string, string> }).criteria), 'Emergent', 0.7),
    }));
    const j = await judgeContentClaim(jev, { claimText: 'Design a new onboarding flow for a product nobody has used yet', judgmentKind: 'work-regime' });
    expect(j.answer).toBe('Emergent');
    expect(j.probabilities['Emergent']).toBe(0.7);
    expect(j.score).toBeUndefined();
  });

  it('refuses an unknown kind and a claim too short to judge, before calling the model', async () => {
    const jev = new FakeJevClient(() => ({}));
    await expect(judgeContentClaim(jev, { claimText: 'x', judgmentKind: 'evidence-level' })).rejects.toThrow(/too short/);
    await expect(judgeContentClaim(jev, { ...claim, judgmentKind: 'strategy' as 'evidence-level' })).rejects.toThrow(/judgment kind/);
    expect(jev.calls).toHaveLength(0);
  });
});

describe('what a person can do next', () => {
  const base = { kind: 'content-judgment' as const, id: 'j1', graphIri: `${CONTENT_JUDGMENT_GRAPH_PREFIX}j1`, createdAt: '2026-09-21T03:00:00.000Z', model: 'jev-fake', confidence: 0.6, claimText: claim.claimText, evidenceCount: 0, usage: { requests: 1, input_tokens: 10, output_tokens: 0, latencyMs: 1 } };

  it('an unsupported claim offers citing evidence; every judgment offers confirm-or-refute', () => {
    const weak = contentJudgmentControls({ ...base, judgmentKind: 'evidence-level', answer: 'asserted-only', probabilities: { 'asserted-only': 0.6 } });
    expect(weak.map((c) => c.name)).toEqual(['cite-evidence', 'confirm-or-refute']);
    expect(weak.every((c) => c.declarative && c.action.startsWith('urn:iep:action:foxxi:'))).toBe(true);
    const strong = contentJudgmentControls({ ...base, judgmentKind: 'evidence-level', answer: 'corroborated', probabilities: { corroborated: 0.6 } });
    expect(strong.map((c) => c.name)).toEqual(['confirm-or-refute']);
    const turbulent = contentJudgmentControls({ ...base, judgmentKind: 'work-regime', answer: 'Turbulent', probabilities: { Turbulent: 0.6 } });
    expect(turbulent.map((c) => c.name)).toEqual(['choose-method-for-regime', 'confirm-or-refute']);
  });

  it('renders the viewer document through the shared kit, typed in the Foxxi namespace', () => {
    const j = { ...base, judgmentKind: 'work-regime' as const, answer: 'Knowable', probabilities: { Knowable: 0.6, Evident: 0.4 } };
    const md = contentJudgmentMarkdown(j, contentJudgmentControls(j), 'https://foxxi.example/');
    expect(md).toContain('"@type": ["foxxi:ContentJudgment", "hmd:Document"]');
    expect(md).toContain('"@id": "https://foxxi.example/foxxi/judgments/j1"');
    expect(md).toContain('state: "hypothetical"');
    expect(md).toContain('# Content judgment (work-regime): Knowable');
    expect(md).toContain('| Knowable | 0.6 |');
    expect(md).toContain(':::control confirm-or-refute');
  });
});

describe('the affordance and the vocabulary', () => {
  it('is declared for admins and learning engineers, factory-routed, with typed inputs, and its type dereferences', () => {
    const a = foxxiAdminAffordances.find((x) => x.toolName === 'foxxi.judge_content_claim');
    expect(a).toBeTruthy();
    expect(a!.action).toBe('urn:iep:action:foxxi:judge-content-claim');
    expect(a!.targetTemplate).toBe('{base}/foxxi/judge_content_claim');
    expect(a!.externallyRouted).toBeFalsy();
    expect(a!.inputs.filter((i) => i.required).map((i) => i.name).sort()).toEqual(['claim_text', 'judgment_kind']);
    expect(lookupTerm('ContentJudgment')?.kind).toBe('Type');
    expect(lookupTerm('judgmentKind')?.kind).toBe('Extension');
  });
});

describe('what a person says is true', () => {
  const judgment: ContentJudgment = { kind: 'content-judgment', id: 'j9', graphIri: `${CONTENT_JUDGMENT_GRAPH_PREFIX}j9`, createdAt: '2026-09-21T06:00:00.000Z', model: 'jev-fake', confidence: 0.6, judgmentKind: 'work-regime', claimText: claim.claimText, answer: 'Knowable', probabilities: { Knowable: 0.6, Evident: 0.3, Emergent: 0.1 }, evidenceCount: 0, usage: { requests: 1, input_tokens: 10, output_tokens: 0, latencyMs: 1 } };

  it('scores the model against the confirmed answer with a hit and a multiclass Brier', () => {
    expect(scoreContentJudgment(judgment, 'Knowable')).toEqual({ hit: true, brier: 0.26 });
    expect(scoreContentJudgment(judgment, 'Evident')).toEqual({ hit: false, brier: 0.86 });
  });

  it('makes an outcome that names the judgment, the person and the answer, and refuses an answer the judgment never weighed', () => {
    const o = contentJudgmentOutcome(judgment, 'urn:foxxi:judgment:abc12345', 'Evident', { did: 'did:web:x:le', note: 'the SOP covers it' }, new Date('2026-09-21T07:00:00.000Z'));
    expect(o).toEqual({ kind: 'content-judgment-outcome', judgmentId: 'j9', judgmentIri: 'urn:foxxi:judgment:abc12345', judgmentKind: 'work-regime', answer: 'Knowable', confirmedAnswer: 'Evident', hit: false, brier: 0.86, confidence: 0.6, confirmedBy: 'did:web:x:le', confirmedByKind: 'human', createdAt: '2026-09-21T07:00:00.000Z', note: 'the SOP covers it' });
    expect(isContentJudgmentOutcome(o)).toBe(true);
    expect(() => contentJudgmentOutcome(judgment, 'urn:foxxi:judgment:abc12345', 'Turbulent', { did: 'did:web:x:le' })).toThrow(/must be one of Knowable, Evident, Emergent/);
  });

  it('reads an entity back from the graph the pod serves, by the manifest or by the slug convention', () => {
    const b64 = Buffer.from(JSON.stringify(judgment), 'utf8').toString('base64');
    const graph = `<urn:foxxi:judgment:abc12345> a <${CONTENT_JUDGMENT_OUTCOME_TYPE}> ;\n  foxxi:bundleJson "${b64}"^^xsd:base64Binary ;\n  foxxi:payloadByteLength "10"^^xsd:integer .`;
    const back = decodeBundleJson(graph);
    expect(isContentJudgment(back)).toBe(true);
    expect((back as ContentJudgment).answer).toBe('Knowable');
    expect(decodeBundleJson('no bundle here')).toBeUndefined();
    const entries = [{ descriptorUrl: 'https://pod.example/foxxi/judgments/judgment-abc12345.ttl', describes: ['urn:foxxi:judgment:abc12345'], graphUrl: 'https://pod.example/foxxi/judgments/judgment-abc12345-graph.trig' }];
    expect(findEntityEntry(entries, 'urn:foxxi:judgment:abc12345')).toBe(entries[0]);
    expect(findEntityEntry(entries, 'urn:foxxi:judgment:other')).toBeUndefined();
    expect(entityGraphUrl('https://pod.example/', 'urn:foxxi:judgment:abc12345', entries[0])).toBe('https://pod.example/foxxi/judgments/judgment-abc12345-graph.trig');
    expect(entityGraphUrl('https://pod.example', 'urn:foxxi:judgment-outcome:9f9f9f9f')).toBe('https://pod.example/foxxi/judgments/judgment-outcome-9f9f9f9f-graph.trig');
    expect(entityGraphUrl('https://pod.example/', 'urn:elsewhere:x')).toBeUndefined();
  });

  it('calibrates per question kind, Asserted from five outcomes', () => {
    const mk = (kind: 'evidence-level' | 'work-regime', hit: boolean, brier: number) => ({ kind: 'content-judgment-outcome' as const, judgmentId: 'j', judgmentIri: 'urn:foxxi:judgment:j', judgmentKind: kind, answer: 'a', confirmedAnswer: hit ? 'a' : 'b', hit, brier, confidence: 0.5, confirmedBy: 'did:web:x', createdAt: '2026-09-21T07:00:00.000Z' });
    const outcomes = [...Array.from({ length: 5 }, (_, i) => mk('work-regime', i < 4, i < 4 ? 0.2 : 1.2)), mk('evidence-level', true, 0.1)];
    const c = contentJudgmentCalibration(outcomes, 5, new Date('2026-09-21T08:00:00.000Z'));
    expect(c.samples).toBe(6);
    expect(c.cells).toEqual([
      { judgmentKind: 'evidence-level', samples: 1, hitRate: 1, meanBrier: 0.1, status: 'Hypothetical', humanSamples: 1, agentSamples: 0 },
      { judgmentKind: 'work-regime', samples: 5, hitRate: 0.8, meanBrier: 0.4, status: 'Asserted', humanSamples: 5, agentSamples: 0 },
    ]);
  });

  it('declares the outcome affordance, the calibration affordance and the outcome type', () => {
    const confirm = foxxiAdminAffordances.find((x) => x.toolName === 'foxxi.confirm_content_judgment');
    expect(confirm?.inputs.filter((i) => i.required).map((i) => i.name).sort()).toEqual(['confirmed_answer', 'judgment_iri']);
    expect(foxxiAdminAffordances.find((x) => x.toolName === 'foxxi.content_judgment_calibration')?.method).toBe('GET');
    expect(lookupTerm('ContentJudgmentOutcome')?.kind).toBe('Type');
  });
});
