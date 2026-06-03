/**
 * @module passport/heartbeat
 * @description Heartbeat-tick → Passport bridge. A long-running agent
 *   runtime (OODA loop, saga coordinator, p2p relay) ticks continuously,
 *   but most ticks are uneventful — nothing publishable, no transaction
 *   crossed a boundary, no delegation moved, no infrastructure changed.
 *
 *   Without this helper, runtimes tend to fail in one of two directions:
 *     1. record every tick as a LifeEvent → biography becomes noise,
 *        version bumps lose meaning, value-drift detection drowns;
 *     2. record nothing automatically → biographically significant
 *        moments (a saga that finally committed, a delegation that
 *        got revoked, a pod migration triggered mid-tick) silently
 *        vanish from the passport.
 *
 *   This module is the predicate + appender pair that resolves that:
 *   significant outcomes get one honest LifeEvent describing what
 *   actually happened in the tick; everything else is dropped on the
 *   floor. It is pure composition over the existing
 *   {@link recordLifeEvent} primitive — no new LifeEventKind, no new
 *   ontology term.
 */

import type { IRI } from '@interego/core';
import {
  recordLifeEvent,
  type LifeEvent,
  type LifeEventKind,
  type Passport,
} from './index.js';

/** Result of {@link detectValueDrift} entries — re-exported here so callers
 *  passing drift through the heartbeat don't have to import it twice. */
export type ValueDriftFinding = {
  readonly event: LifeEvent;
  readonly possibleViolation: { readonly statement: string };
};

/** Outcomes a single tick of the runtime loop produced. Every field is
 *  optional; the empty object means "uneventful tick". */
export interface HeartbeatOutcomes {
  /** Descriptor IRIs the tick wrote (publish_context, share, etc.). */
  readonly publishedDescriptors?: readonly IRI[];
  /** Saga transaction descriptors that reached the Committed state. */
  readonly transactionsExecuted?: readonly IRI[];
  /** Saga transactions picked up mid-flight and resumed (replay). */
  readonly transactionsResumed?: readonly IRI[];
  /** The agent's delegation was revoked by a registry during this tick. */
  readonly delegationRevoked?: boolean;
  /** Infrastructure migration occurred during this tick. */
  readonly podMigrated?: { readonly from: IRI; readonly to: IRI };
  /** Value drift the tick noticed (e.g. via detectValueDrift). */
  readonly valueDriftDetected?: ValueDriftFinding;
}

/**
 * Cheap predicate — true iff at least one outcome field is set to a
 * non-empty, non-falsy value. Exposed so callers can short-circuit
 * before allocating IRIs / timestamps / publishing.
 */
export function heartbeatOutcomesAreSignificant(outcomes: HeartbeatOutcomes): boolean {
  if (outcomes.publishedDescriptors && outcomes.publishedDescriptors.length > 0) return true;
  if (outcomes.transactionsExecuted && outcomes.transactionsExecuted.length > 0) return true;
  if (outcomes.transactionsResumed && outcomes.transactionsResumed.length > 0) return true;
  if (outcomes.delegationRevoked === true) return true;
  if (outcomes.podMigrated) return true;
  if (outcomes.valueDriftDetected) return true;
  return false;
}

/**
 * Append one LifeEvent to the passport iff the tick produced
 * biographically significant outcomes; otherwise return the passport
 * unchanged (no version bump).
 *
 * Biographically significant means at least one of:
 *   - a descriptor was published,
 *   - a saga transaction committed or was resumed,
 *   - delegation was revoked,
 *   - the agent migrated infrastructure,
 *   - value drift was detected against an active stated value.
 *
 * Kind selection (reuses existing {@link LifeEventKind} values — this
 * helper deliberately does NOT introduce a new kind, per the
 * no-new-primitives discipline + the ontology-lint check):
 *
 *   - `infrastructure-migration` if `podMigrated` is set — the closest
 *     existing kind for "the agent's runtime substrate changed";
 *   - `registry-registration` if `delegationRevoked` is true — the
 *     registry-facing kind covers both joining and being removed from
 *     the registry surface (the description records which);
 *   - `milestone` for all other significant ticks (a commit, a publish,
 *     a noticed drift). `milestone` is the existing free-form kind
 *     specifically reserved for "notable event that doesn't fit a more
 *     specific kind", which is exactly the heartbeat case.
 *
 * Evidence carries the descriptor IRIs the tick wrote + the transaction
 * descriptors it touched, so the LifeEvent is verifiable from the
 * pod, not just the passport.
 */
export function recordHeartbeatTickIfChanged(
  passport: Passport,
  outcomes: HeartbeatOutcomes,
): Passport {
  if (!heartbeatOutcomesAreSignificant(outcomes)) return passport;

  const at = new Date().toISOString();
  const kind: LifeEventKind = outcomes.podMigrated
    ? 'infrastructure-migration'
    : outcomes.delegationRevoked
      ? 'registry-registration'
      : 'milestone';

  const parts: string[] = [];
  if (outcomes.podMigrated) {
    parts.push(`pod migrated ${outcomes.podMigrated.from} → ${outcomes.podMigrated.to}`);
  }
  if (outcomes.delegationRevoked) {
    parts.push('delegation revoked by registry');
  }
  if (outcomes.transactionsExecuted && outcomes.transactionsExecuted.length > 0) {
    parts.push(`${outcomes.transactionsExecuted.length} transaction(s) committed`);
  }
  if (outcomes.transactionsResumed && outcomes.transactionsResumed.length > 0) {
    parts.push(`${outcomes.transactionsResumed.length} transaction(s) resumed`);
  }
  if (outcomes.publishedDescriptors && outcomes.publishedDescriptors.length > 0) {
    parts.push(`${outcomes.publishedDescriptors.length} descriptor(s) published`);
  }
  if (outcomes.valueDriftDetected) {
    parts.push(
      `value drift detected against "${outcomes.valueDriftDetected.possibleViolation.statement}"`,
    );
  }
  const description = parts.length > 0 ? `heartbeat tick: ${parts.join('; ')}` : 'heartbeat tick';

  const evidence: IRI[] = [
    ...(outcomes.publishedDescriptors ?? []),
    ...(outcomes.transactionsExecuted ?? []),
    ...(outcomes.transactionsResumed ?? []),
  ];

  const event: LifeEvent = {
    id: `urn:passport:event:heartbeat:${Date.now()}` as IRI,
    kind,
    at,
    description,
    evidence,
  };

  return recordLifeEvent(passport, event);
}
