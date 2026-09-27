/**
 * What a performer's recorded work offers them, without their asking.
 *
 * A plan used to be made only when somebody described a situation to the practice
 * (POST /agent/contextualize-and-plan). But a performer who records their own work
 * (POST /agent/record-performance) has already said what the situation is: the work, at a
 * competency, and how it came out. When a unit of it fails, the work recorded at that competency
 * is the situation, and the trajectories kept with it are the signal its regime is read from. So
 * the failure is answered with the plan that work implies, and the admission that plan implies,
 * offered to the performer to keep (foxxi.content_admit) or not. Nothing is kept from it.
 *
 * ★ ONLY A FAILURE IS ANSWERED. Work that came out well, or asserted no outcome, needs no plan.
 *
 * ★ THE REGIME IS READ FROM THE WORK, OR NOT AT ALL. Only the trajectories kept with the latest
 * units of work at this competency (WORK_OFFER_WINDOW) are read. Work kept without one leaves the
 * regime unread, and then nothing is offered: the practice refuses to assume a regime, and the
 * answer says what would let it read one.
 *
 * ★ A SELF-REPORT IS HYPOTHETICAL. The situation is Asserted only when someone other than the
 * performer observed the failure. A performer's own report is a claim to measure first, and in
 * Knowable work that is what the plan does.
 *
 * ★ NOTHING IS OFFERED FOR NOTHING, OR TWICE. A plan that selects only no-intervention leaves
 * nothing to keep, and an admission the performer already keeps here is not offered again.
 *
 * The same holds for a person and for an agent: the rules read the work, not the performer.
 */
import { createHash } from 'node:crypto';
import type { Admission } from '../../foxxi-content-intelligence/src/compositions.js';
import type { WorkStep } from '../../foxxi-content-intelligence/src/learner-record.js';
import { buildTrajectory } from './agent-trajectory.js';
import { admissionOffer } from './content-admission.js';
import { diagnose, recommendInterventions, type PerformanceSituation, type Performer } from './performance-architecture.js';

/** How much work at a competency is read: its latest units, the one just recorded first. */
export const WORK_OFFER_WINDOW = 20;

/** A unit of work at the competency, as the performer's record holds it. */
export interface WorkUnit {
  /** The statement that records it. */
  id: string;
  success?: boolean;
  timestamp: string;
  /** Who attested it; the performer, when they recorded it themselves. */
  observedBy?: string;
  /** How it went, when the performer kept that with it. */
  steps?: readonly WorkStep[];
}

export type WorkOffer =
  | { offered: true; offer: Record<string, unknown> }
  | { offered: false; because: string };

const sameKinds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every(k => b.includes(k));

export function offerFromWork(input: {
  performer: Performer;
  /** The competency the work counts toward, as a competency IRI. */
  competency: string;
  /** What a person reads it as. */
  label: string;
  /** The work recorded there, newest first: the unit just recorded is the first. */
  work: readonly WorkUnit[];
  /** The admission the performer keeps at this competency, if any. */
  standing?: Admission;
  base: string;
}): WorkOffer {
  const window = input.work.slice(0, WORK_OFFER_WINDOW);
  const latest = window[0];
  if (!latest) return { offered: false, because: `no work is recorded at ${input.label}` };
  if (latest.success !== false) return { offered: false, because: `the latest work at ${input.label} did not fail, so there is nothing to answer` };

  const assessed = window.filter(u => u.success !== undefined);
  const failed = assessed.filter(u => u.success === false);
  const traced = window.filter(u => u.steps?.length);
  const trajectories = traced.map(u => buildTrajectory(input.performer.id, undefined,
    u.steps!.map(s => ({ ...s, recordedAt: s.recordedAt ?? u.timestamp }))));
  const situation: PerformanceSituation = {
    id: `urn:foxxi:work-situation:${createHash('sha256').update(`${input.performer.id}\n${input.competency}\n${latest.id}`).digest('hex').slice(0, 32)}`,
    performer: input.performer,
    workContext: `production work recorded at ${input.label}`,
    competency: input.competency,
    observed: `${failed.length} of the latest ${assessed.length} recorded units of work at ${input.label} failed, the latest at ${latest.timestamp}`,
    frequency: 'frequent',
    criticality: 'moderate',
    modalStatus: latest.observedBy && latest.observedBy !== input.performer.id ? 'Asserted' : 'Hypothetical',
    provenance: `the performer's recorded production work at ${input.label}: ${window.length} units, ${traced.length} with a trajectory`,
  };
  const diagnosis = diagnose({ situation, ...(trajectories.length ? { trajectories } : {}) });
  if (diagnosis.method === 'classify-first') {
    return { offered: false, because: `no trajectory was kept with the work at ${input.label}, so its regime cannot be read. Send how the work went (trajectory) with it, and a failure can be answered.` };
  }
  const plan = recommendInterventions({ diagnosis, situation });
  const selected = plan.selected.map(o => o.type);
  if (selected.every(t => t === 'no-intervention')) {
    return { offered: false, because: `the plan for this ${diagnosis.domain} work selected no intervention, so there is nothing to keep` };
  }
  const offer = admissionOffer(plan, diagnosis, situation, input.base);
  if (!offer) return { offered: false, because: `${input.label} names no competency content can be resolved against` };
  if (input.standing && sameKinds(input.standing.kinds, offer.kinds as string[])) {
    return { offered: false, because: `you already keep this admission at ${input.label}` };
  }
  return {
    offered: true,
    offer: {
      ...offer,
      situation: { observed: situation.observed, modalStatus: situation.modalStatus },
      diagnosis: { regime: diagnosis.domain, regimeSource: diagnosis.regimeSource, method: diagnosis.method },
      plan: { selected, summary: plan.summary },
      evidence: { work: window.map(u => u.id), failed: failed.length, assessed: assessed.length, withTrajectory: traced.length },
    },
  };
}
