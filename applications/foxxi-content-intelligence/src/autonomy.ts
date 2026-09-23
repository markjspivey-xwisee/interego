/**
 * Autonomy granted by calibration, written as a constitutional policy.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * A judgment is Hypothetical until a person asserts it. That is the right default for a judge
 * nobody has measured, and the wrong one for a judge whose registry reputation on that kind of
 * question, earned against people's confirmations, already clears a floor the pod's owner wrote
 * down. The harness's gated auto-merge made this call for one decision kind with constants in
 * code (applications/jev-harness/src/auto-merge.ts, conditions 6 and 7). Here the floors are a
 * policy entity on the pod — per kind of question, which axis, how high, over how many samples,
 * confirmed by how many people — amended through @interego/constitutional's propose / vote /
 * ratify, each policy superseding the last, so "when may an agent act without a person" is a
 * measured, per-kind, amendable fact with a chain, not a switch.
 *
 * ── WHAT IS DECIDED ────────────────────────────────────────────────────────────────────────
 *
 * For a judge and a kind of question: the registry's rating on the kind's axis (accuracy for
 * evidence, competence for regimes), how many samples the latest attestation about the judge
 * rests on, and how many of those a person confirmed. Autonomy is granted when all three clear
 * the rule for that kind. The judgment is then published Asserted, with the decision and the
 * policy it applied beside it; otherwise Hypothetical, as before, with the reason.
 *
 * Tier 4 is an individual setting (@interego/constitutional DEFAULT_RULES): one vote, no wait —
 * the owner of a self-sovereign pod amends their own policy in one call. Lower tiers need a
 * quorum, and an amendment that has not reached it is published Hypothetical and applies to
 * nothing until it does.
 */
import { DEFAULT_RULES, proposeAmendment, tryRatify, vote, type Amendment, type Tier } from '@interego/constitutional';
import type { IRI } from '@interego/core';
import type { ReputationSnapshot } from '@interego/registry';
import { CONTENT_JUDGMENT_KINDS } from './content-judgment.js';
import type { ContentJudgmentAttestation } from './content-reputation.js';
import { FOXXI_NS } from './foxxi-vocab.js';
import { axisForKind } from './judges.js';

export const AUTONOMY_POLICY_TYPE = `${FOXXI_NS}AutonomyPolicy`;

export interface AutonomyRule {
  readonly kind: string;
  readonly axis: 'accuracy' | 'competence';
  /** The registry rating on the axis the judge must reach. */
  readonly floor: number;
  /** Outcomes the latest attestation about the judge must rest on. */
  readonly minSamples: number;
  /** Of those, how many a person must have confirmed. */
  readonly minHumanConfirmers: number;
}

export interface AutonomyPolicy {
  readonly type: string;
  readonly id: string;
  readonly tier: Tier;
  readonly description: string;
  readonly rules: readonly AutonomyRule[];
  readonly ratifiedAt?: string;
  readonly proposedBy?: string;
  readonly amendment?: { readonly id: string; readonly status: Amendment['status']; readonly summary: string; readonly votes: number };
  /** The policy this one supersedes, when it amends one. */
  readonly supersedes?: string;
}

/** The floors a pod starts with: the harness's bar for merging without a person, per kind. */
export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  type: AUTONOMY_POLICY_TYPE,
  id: 'urn:foxxi:policy:autonomy:default',
  tier: 4,
  description: 'The default until the pod publishes its own: a judge acts alone on a kind of question once its rating on that kind\'s axis is at least 0.9 over at least 20 outcomes, at least 5 of them confirmed by a person.',
  rules: CONTENT_JUDGMENT_KINDS.map((kind) => ({ kind, axis: axisForKind(kind), floor: 0.9, minSamples: 20, minHumanConfirmers: 5 })),
};

export function isAutonomyPolicy(v: unknown): v is AutonomyPolicy {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o['type'] === AUTONOMY_POLICY_TYPE && typeof o['id'] === 'string' && Array.isArray(o['rules']) && typeof o['tier'] === 'number';
}

/** The rule for a kind, or the default rule when the policy names none for it. */
export function ruleFor(policy: AutonomyPolicy, kind: string): AutonomyRule {
  return policy.rules.find((r) => r.kind === kind) ?? DEFAULT_AUTONOMY_POLICY.rules.find((r) => r.kind === kind) ?? { kind, axis: axisForKind(kind), floor: 0.9, minSamples: 20, minHumanConfirmers: 5 };
}

export interface Standing {
  readonly judge: string;
  readonly kind: string;
  readonly axis: 'accuracy' | 'competence';
  readonly rating: number | null;
  readonly contributing: number;
  readonly samples: number;
  readonly humanConfirmers: number;
}

/** Where a judge stands on a kind: the registry's rating, and what the latest attestation about it rests on. */
export function standingOf(judge: string, kind: string, snapshot: ReputationSnapshot | null, latest: ContentJudgmentAttestation | undefined): Standing {
  const axis = axisForKind(kind);
  const rating = snapshot?.axes?.[axis];
  const grounded = latest && latest.kinds.includes(kind);
  return {
    judge,
    kind,
    axis,
    rating: typeof rating === 'number' ? rating : null,
    contributing: snapshot?.contributingAttestations?.length ?? 0,
    samples: grounded ? latest.samples : 0,
    humanConfirmers: grounded ? (latest.confirmers?.human ?? latest.samples) : 0,
  };
}

export interface AutonomyDecision {
  readonly granted: boolean;
  readonly reason: string;
  readonly rule: AutonomyRule;
  readonly policyId: string;
  readonly standing: Standing;
}

/** Whether the judge may assert on this kind without a person, and why. */
export function autonomyDecision(policy: AutonomyPolicy, standing: Standing): AutonomyDecision {
  const rule = ruleFor(policy, standing.kind);
  const base = { rule, policyId: policy.id, standing };
  if (standing.rating === null) return { ...base, granted: false, reason: `no attestation on the pod rates ${standing.judge} on ${rule.axis}, so nothing vouches for it on ${standing.kind}` };
  if (standing.rating < rule.floor) return { ...base, granted: false, reason: `${rule.axis} ${standing.rating} is below the floor ${rule.floor} for ${standing.kind}` };
  if (standing.samples < rule.minSamples) return { ...base, granted: false, reason: `the latest attestation rests on ${standing.samples} outcome(s), below the ${rule.minSamples} the policy asks for ${standing.kind}` };
  if (standing.humanConfirmers < rule.minHumanConfirmers) return { ...base, granted: false, reason: `${standing.humanConfirmers} of those outcomes were confirmed by a person, below the ${rule.minHumanConfirmers} the policy asks` };
  return { ...base, granted: true, reason: `${rule.axis} ${standing.rating} clears ${rule.floor} over ${standing.samples} outcome(s), ${standing.humanConfirmers} confirmed by a person` };
}

const isRule = (v: unknown): v is AutonomyRule => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['kind'] === 'string' && (o['axis'] === 'accuracy' || o['axis'] === 'competence') && typeof o['floor'] === 'number' && typeof o['minSamples'] === 'number' && typeof o['minHumanConfirmers'] === 'number';
};

/** The rules a caller proposes, checked: every kind the loop asks about, sane bounds. */
export function parseRules(v: unknown): AutonomyRule[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error('rules must be a non-empty array of { kind, axis, floor, minSamples, minHumanConfirmers }');
  const rules = v.map((r) => {
    if (!isRule(r)) throw new Error('each rule needs kind, axis (accuracy | competence), floor, minSamples and minHumanConfirmers');
    if (!(CONTENT_JUDGMENT_KINDS as readonly string[]).includes(r.kind)) throw new Error(`kind must be one of ${CONTENT_JUDGMENT_KINDS.join(', ')}`);
    if (r.floor < 0 || r.floor > 1) throw new Error('floor must be within 0..1');
    if (r.minSamples < 1 || r.minHumanConfirmers < 0 || r.minHumanConfirmers > r.minSamples) throw new Error('minSamples must be at least 1 and minHumanConfirmers within 0..minSamples');
    return { kind: r.kind, axis: r.axis, floor: r.floor, minSamples: Math.floor(r.minSamples), minHumanConfirmers: Math.floor(r.minHumanConfirmers) };
  });
  return rules;
}

/**
 * Amend the policy in force: propose the change, cast the proposer's vote, try to ratify under
 * the tier's rules. At tier 4 that ratifies at once; lower tiers wait for a quorum, and the
 * returned policy is then not yet in force.
 */
export function amendAutonomyPolicy(previous: AutonomyPolicy, rules: readonly AutonomyRule[], by: { readonly did: string; readonly tier?: Tier; readonly description?: string; readonly previousIri?: string }, now: Date = new Date()): { policy: AutonomyPolicy; amendment: Amendment; inForce: boolean } {
  const tier: Tier = by.tier ?? previous.tier ?? 4;
  const at = now.toISOString();
  const id = `urn:foxxi:policy:autonomy:${now.getTime().toString(36)}`;
  const summary = rules.map((r) => `${r.kind}: ${r.axis} ≥ ${r.floor} over ≥ ${r.minSamples} outcomes, ≥ ${r.minHumanConfirmers} by a person`).join('; ');
  let amendment = proposeAmendment({ id: `${id}#amendment` as IRI, proposedBy: by.did as IRI, amends: previous.id as IRI, tier, diff: { summary, modifiedRules: [{ from: previous.rules.map((r) => `${r.kind}: ${r.axis} ≥ ${r.floor} / ${r.minSamples} / ${r.minHumanConfirmers}`).join('; '), to: summary }] }, proposedAt: at });
  amendment = vote(amendment, by.did as IRI, 'Asserted', undefined, at);
  amendment = tryRatify(amendment, DEFAULT_RULES[tier], at);
  const inForce = amendment.status === 'Ratified';
  const policy: AutonomyPolicy = {
    type: AUTONOMY_POLICY_TYPE,
    id,
    tier,
    description: by.description ?? `Amended by ${by.did}: ${summary}`,
    rules,
    proposedBy: by.did,
    ...(inForce ? { ratifiedAt: amendment.ratifiedAt ?? at } : {}),
    amendment: { id: amendment.id, status: amendment.status, summary, votes: amendment.votes.length },
    ...(by.previousIri ? { supersedes: by.previousIri } : {}),
  };
  return { policy, amendment, inForce };
}
