/**
 * @module constitutional
 * @description Constitutional Layer per spec/CONSTITUTIONAL-LAYER.md.
 *
 *   Self-amending policy machinery: a community publishes
 *   ConstitutionalPolicies that govern which other policies can be
 *   enacted, amended, or retracted. Built on existing
 *   iep:AccessControlPolicy + ModalAlgebra + iep:supersedes — no new
 *   L1 protocol primitives.
 *
 *   Reference runtime — single-coordinator vote tallying. Production
 *   use needs adversarial sybil-resistance via filterAttributeGraph.
 */

import type { IRI } from '@interego/core';
import { ModalAlgebra, type ModalValue } from '@interego/core';

export type Tier = 0 | 1 | 2 | 3 | 4;

export interface ConstitutionalPolicy {
  readonly id: IRI;
  readonly tier: Tier;
  readonly description: string;
  readonly ratifyRule: RatificationRule;
  /** The ConstitutionalPolicy that governs amendments to THIS policy. */
  readonly amendmentProcess?: IRI;
}

export interface RatificationRule {
  readonly minQuorum: number;            // min total votes
  readonly threshold: number;             // [0, 1] proportion of for-votes
  readonly coolingPeriodDays: number;    // wait between proposal and ratification
}

export const DEFAULT_RULES: Record<Tier, RatificationRule> = {
  0: { minQuorum: 99999, threshold: 1.0, coolingPeriodDays: 365 }, // bedrock = practically immutable
  1: { minQuorum: 20, threshold: 0.67, coolingPeriodDays: 14 },     // supermajority + 2-week cool
  2: { minQuorum: 10, threshold: 0.51, coolingPeriodDays: 7 },      // majority + 1-week cool
  3: { minQuorum: 3, threshold: 0.51, coolingPeriodDays: 0 },       // any quorum, no wait
  4: { minQuorum: 1, threshold: 1.0, coolingPeriodDays: 0 },        // individual setting
};

export interface Amendment {
  readonly id: IRI;
  readonly proposedBy: IRI;
  readonly proposedAt: string;
  readonly amends: IRI;        // policy IRI being amended
  readonly tier: Tier;
  readonly diff: AmendmentDiff;
  readonly votes: Vote[];      // mutable in this reference impl
  status: 'Proposed' | 'Ratified' | 'Rejected' | 'PendingQuorum' | 'PendingCooling';
  ratifiedAt?: string;
}

export interface AmendmentDiff {
  readonly summary: string;
  readonly addedRules?: readonly string[];
  readonly removedRules?: readonly string[];
  readonly modifiedRules?: readonly { from: string; to: string }[];
}

export interface Vote {
  readonly voter: IRI;
  readonly modalStatus: ModalValue; // Asserted=for, Counterfactual=against, Hypothetical=abstain
  readonly votedAt: string;
  readonly weight?: number;          // optional trust-weighted vote
}

export function proposeAmendment(args: {
  id: IRI;
  proposedBy: IRI;
  amends: IRI;
  tier: Tier;
  diff: AmendmentDiff;
  proposedAt?: string;
}): Amendment {
  return {
    id: args.id,
    proposedBy: args.proposedBy,
    proposedAt: args.proposedAt ?? new Date().toISOString(),
    amends: args.amends,
    tier: args.tier,
    diff: args.diff,
    votes: [],
    status: 'Proposed',
  };
}

export function vote(amendment: Amendment, voter: IRI, modalStatus: ModalValue, weight?: number, votedAt?: string): Amendment {
  // Deduplicate: a voter's last vote wins.
  const existing = amendment.votes.findIndex(v => v.voter === voter);
  const newVote: Vote = {
    voter,
    modalStatus,
    weight,
    votedAt: votedAt ?? new Date().toISOString(),
  };
  if (existing >= 0) amendment.votes[existing] = newVote;
  else amendment.votes.push(newVote);
  return amendment;
}

/**
 * Try to ratify an amendment. Returns the (mutated) amendment with
 * status updated. Idempotent — calling repeatedly is safe.
 */
export function tryRatify(amendment: Amendment, rules?: RatificationRule, now?: string): Amendment {
  const r = rules ?? DEFAULT_RULES[amendment.tier];
  const t = now ?? new Date().toISOString();

  // Check cooling period.
  const proposedMs = new Date(amendment.proposedAt).getTime();
  const nowMs = new Date(t).getTime();
  const ageDays = (nowMs - proposedMs) / (1000 * 60 * 60 * 24);
  if (ageDays < r.coolingPeriodDays) {
    amendment.status = 'PendingCooling';
    return amendment;
  }

  // Check quorum.
  const nonAbstain = amendment.votes.filter(v => v.modalStatus !== 'Hypothetical');
  if (nonAbstain.length < r.minQuorum) {
    amendment.status = 'PendingQuorum';
    return amendment;
  }

  // Check threshold (weighted if weights provided).
  const totalWeight = nonAbstain.reduce((s, v) => s + (v.weight ?? 1), 0);
  const forWeight = nonAbstain
    .filter(v => v.modalStatus === 'Asserted')
    .reduce((s, v) => s + (v.weight ?? 1), 0);
  const proportion = totalWeight > 0 ? forWeight / totalWeight : 0;

  if (proportion >= r.threshold) {
    amendment.status = 'Ratified';
    amendment.ratifiedAt = t;
  } else {
    amendment.status = 'Rejected';
  }
  return amendment;
}

/** Modal aggregation of votes — for narrative reports of "where the
 *  community is." Distinct from formal ratification rules. */
export function communityModal(amendment: Amendment): ModalValue {
  if (amendment.votes.length === 0) return 'Hypothetical';
  return amendment.votes
    .map(v => v.modalStatus)
    .reduce((a, b) => ModalAlgebra.meet(a, b));
}

export interface ConstitutionalFork {
  readonly id: IRI;
  readonly parentConstitution: IRI;
  readonly forkedAt: string;
  readonly dissenters: readonly IRI[];
  readonly newConstitution: ConstitutionalPolicy;
  readonly reason: string;
}

/**
 * Record a constitutional fork. Dissenters who couldn't ratify
 * their amendment may publish a fork constitution + migrate.
 * The fork is itself a recognized protocol move with audit trail.
 */
export function forkConstitution(args: {
  id: IRI;
  parentConstitution: IRI;
  dissenters: readonly IRI[];
  newConstitution: ConstitutionalPolicy;
  reason: string;
  forkedAt?: string;
}): ConstitutionalFork {
  return {
    id: args.id,
    parentConstitution: args.parentConstitution,
    forkedAt: args.forkedAt ?? new Date().toISOString(),
    dissenters: args.dissenters,
    newConstitution: args.newConstitution,
    reason: args.reason,
  };
}
