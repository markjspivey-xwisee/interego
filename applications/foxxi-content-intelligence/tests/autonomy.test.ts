/**
 * Autonomy granted by calibration: the standing a judge has on a kind, the decision a policy
 * makes of it, and the amendment that changes the policy through the constitutional machinery.
 */
import { describe, expect, it } from 'vitest';
import type { ReputationSnapshot } from '@interego/registry';
import { AUTONOMY_POLICY_TYPE, DEFAULT_AUTONOMY_POLICY, amendAutonomyPolicy, autonomyDecision, isAutonomyPolicy, parseRules, ruleFor, standingOf } from '../src/autonomy.js';
import type { ContentJudgmentAttestation } from '../src/content-reputation.js';
import { foxxiAdminAffordances } from '../affordances.js';
import { lookupTerm } from '../src/foxxi-vocab.js';

const JUDGE = 'did:web:foxxi.example';
const snapshot = (axes: Record<string, number>, n = 1): ReputationSnapshot => ({ score: 0.5, axes, contributingAttestations: Array.from({ length: n }, (_, i) => `urn:a:${i}` as never), computedAt: '2026-09-23T00:00:00.000Z', policyHash: 'x' });
const attestation = (samples: number, human: number, kinds: string[] = ['evidence-level', 'work-regime']): ContentJudgmentAttestation => ({
  type: 'x', attestor: JUDGE, subject: JUDGE, direction: 'Self', axes: { accuracy: 0.95 }, attestedAt: '2026-09-23T00:00:00.000Z', fromExecution: 'https://pod.example/x/foxxi/judgments/', samples, kinds, confirmers: { human, agent: samples - human },
});

describe('the default policy', () => {
  it('asks the harness\'s bar of every kind, and answers any kind it does not name with it', () => {
    expect(DEFAULT_AUTONOMY_POLICY.rules.map((r) => r.kind)).toEqual(['evidence-level', 'work-regime']);
    expect(ruleFor(DEFAULT_AUTONOMY_POLICY, 'work-regime')).toMatchObject({ axis: 'competence', floor: 0.9, minSamples: 20, minHumanConfirmers: 5 });
    expect(ruleFor({ ...DEFAULT_AUTONOMY_POLICY, rules: [] }, 'evidence-level').axis).toBe('accuracy');
    expect(isAutonomyPolicy(DEFAULT_AUTONOMY_POLICY)).toBe(true);
    expect(isAutonomyPolicy({ type: AUTONOMY_POLICY_TYPE })).toBe(false);
  });
});

describe('a judge\'s standing on a kind', () => {
  it('reads the rating from the registry and the grounding from the latest attestation, only when it covers the kind', () => {
    const s = standingOf(JUDGE, 'evidence-level', snapshot({ accuracy: 0.95, competence: 0.4 }, 2), attestation(30, 7));
    expect(s).toMatchObject({ axis: 'accuracy', rating: 0.95, contributing: 2, samples: 30, humanConfirmers: 7 });
    expect(standingOf(JUDGE, 'work-regime', snapshot({ accuracy: 0.95 }), attestation(30, 7, ['evidence-level']))).toMatchObject({ rating: null, samples: 0, humanConfirmers: 0 });
    expect(standingOf(JUDGE, 'evidence-level', null, undefined)).toMatchObject({ rating: null, contributing: 0, samples: 0 });
  });
});

describe('the decision', () => {
  it('grants only when the rating, the samples and the human confirmers all clear the rule, and says which did not', () => {
    const ok = autonomyDecision(DEFAULT_AUTONOMY_POLICY, standingOf(JUDGE, 'evidence-level', snapshot({ accuracy: 0.95 }), attestation(30, 7)));
    expect(ok.granted).toBe(true);
    expect(ok.reason).toContain('clears 0.9 over 30');
    expect(autonomyDecision(DEFAULT_AUTONOMY_POLICY, standingOf(JUDGE, 'evidence-level', null, undefined)).reason).toContain('nothing vouches');
    expect(autonomyDecision(DEFAULT_AUTONOMY_POLICY, standingOf(JUDGE, 'evidence-level', snapshot({ accuracy: 0.5 }), attestation(30, 7))).reason).toContain('below the floor 0.9');
    expect(autonomyDecision(DEFAULT_AUTONOMY_POLICY, standingOf(JUDGE, 'evidence-level', snapshot({ accuracy: 0.95 }), attestation(11, 7))).reason).toContain('below the 20');
    // 2026-09-23 on the Claude Code agent's pod: 22 outcomes, every one confirmed by an agent.
    const agentsOnly = autonomyDecision(DEFAULT_AUTONOMY_POLICY, standingOf(JUDGE, 'evidence-level', snapshot({ accuracy: 0.95 }), attestation(22, 0)));
    expect(agentsOnly.granted).toBe(false);
    expect(agentsOnly.reason).toContain('0 of those outcomes were confirmed by a person');
  });
});

describe('amending the policy', () => {
  const rules = parseRules([{ kind: 'evidence-level', axis: 'accuracy', floor: 0.4, minSamples: 10, minHumanConfirmers: 0 }]);
  it('checks the rules it is given', () => {
    expect(() => parseRules([])).toThrow(/non-empty/);
    expect(() => parseRules([{ kind: 'nope', axis: 'accuracy', floor: 0.5, minSamples: 5, minHumanConfirmers: 0 }])).toThrow(/kind must be one of/);
    expect(() => parseRules([{ kind: 'work-regime', axis: 'competence', floor: 1.5, minSamples: 5, minHumanConfirmers: 0 }])).toThrow(/within 0..1/);
    expect(() => parseRules([{ kind: 'work-regime', axis: 'competence', floor: 0.5, minSamples: 5, minHumanConfirmers: 9 }])).toThrow(/minHumanConfirmers/);
  });
  it('★ at tier 4 the owner\'s single vote ratifies at once; at tier 3 the amendment waits for a quorum and the policy is not in force', () => {
    const own = amendAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, rules, { did: 'did:ethr:0xabc', tier: 4, previousIri: 'urn:foxxi:policy:autonomy:p0' }, new Date('2026-09-23T04:00:00.000Z'));
    expect(own.inForce).toBe(true);
    expect(own.amendment.status).toBe('Ratified');
    expect(own.policy).toMatchObject({ type: AUTONOMY_POLICY_TYPE, tier: 4, supersedes: 'urn:foxxi:policy:autonomy:p0', proposedBy: 'did:ethr:0xabc', rules });
    expect(own.policy.ratifiedAt).toBe('2026-09-23T04:00:00.000Z');
    expect(ruleFor(own.policy, 'work-regime')).toMatchObject({ floor: 0.9 });
    const shared = amendAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, rules, { did: 'did:ethr:0xabc', tier: 3 });
    expect(shared.inForce).toBe(false);
    expect(shared.amendment.status).toBe('PendingQuorum');
    expect(shared.policy.ratifiedAt).toBeUndefined();
  });
  it('the amended rule then grants what the default refused', () => {
    const { policy } = amendAutonomyPolicy(DEFAULT_AUTONOMY_POLICY, rules, { did: 'did:ethr:0xabc', tier: 4 });
    const standing = standingOf(JUDGE, 'evidence-level', snapshot({ accuracy: 0.417 }), attestation(12, 0, ['evidence-level']));
    expect(autonomyDecision(DEFAULT_AUTONOMY_POLICY, standing).granted).toBe(false);
    expect(autonomyDecision(policy, standing).granted).toBe(true);
  });
});

describe('the affordances and the vocabulary', () => {
  it('declare the policy amendment, the status view and the entity type', () => {
    const names = foxxiAdminAffordances.map((a) => a.toolName);
    expect(names).toContain('foxxi.set_autonomy_policy');
    expect(names).toContain('foxxi.autonomy_status');
    expect(lookupTerm('AutonomyPolicy')?.kind).toBe('Type');
  });
});
