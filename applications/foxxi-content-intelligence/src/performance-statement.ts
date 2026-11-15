/**
 * The xAPI statement a recorded performance becomes.
 *
 * `foxxi.record_performance` and its signed form each built this statement inline in the bridge
 * server, the same shape twice, where no test could call it. It is one function here, so what the
 * bridge records is what the tests check against the profile.
 *
 * Nothing here decides who may record or whether the evidence holds; the routes do that first and
 * pass what they found.
 */
import { PERF_EXT } from './learner-record.js';
import { EVIDENCE_BINDING_EXT, EVIDENCE_SHAPE_EXT } from './performance-evidence.js';
import { FOXXI_NS } from './foxxi-vocab.js';
import { outcomeResultFor, performanceCategoriesFor } from './xapi-profile.js';

const ADL_VERBS = 'http://adlnet.gov/expapi/verbs';

/**
 * The outcome verb of a unit of performance (ADL / MOM Level 1): a successful one is `completed`,
 * an unsuccessful one `failed`. The domain of the work stays in the object's activity type.
 */
export function momOutcomeVerb(success: boolean): { id: string; display: { en: string } } {
  return success
    ? { id: `${ADL_VERBS}/completed`, display: { en: 'completed' } }
    : { id: `${ADL_VERBS}/failed`, display: { en: 'failed' } };
}

/** The activity type a performance is recorded under: the caller's own, or the generic production task. */
export const recordedActivityType = (declared: unknown): string =>
  typeof declared === 'string' && declared.trim() ? declared.trim() : `${FOXXI_NS}ProductionTask`;

export interface PerformanceStatementInput {
  /** The statement's id, its registration and its timestamp are the caller's: minted per record. */
  readonly id: string;
  readonly registration: string;
  readonly timestamp: string;
  /** The actor's account: the bridge as home page, the performer's DID as name. */
  readonly homePage: string;
  readonly performer: string;
  readonly taskId: string;
  readonly taskName: string;
  /** As the caller declared it; absent or blank records a generic production task. */
  readonly activityType?: unknown;
  readonly success: boolean;
  /** result.score.scaled, already checked to lie in [-1, 1]. */
  readonly quality?: number;
  readonly durationIso?: string;
  /** The published xAPI Profile, named as a category on every record. */
  readonly profileUrl: string;
  readonly observedBy: string;
  readonly actorKind: 'human' | 'agent';
  readonly evidence: { readonly binding: unknown; readonly shapeIri?: string };
  readonly costUsd?: number;
  readonly workTrajectory?: unknown;
}

export function buildPerformanceStatement(input: PerformanceStatementInput): Record<string, unknown> {
  const type = recordedActivityType(input.activityType);
  return {
    id: input.id,
    version: '2.0.0',
    actor: { objectType: 'Agent', account: { homePage: input.homePage, name: input.performer } },
    verb: momOutcomeVerb(input.success),
    object: {
      objectType: 'Activity',
      id: input.taskId,
      // A creator-declared DOMAIN activity type (e.g. urn:ttt:Move) is what the learner record
      // aggregates a competency by across instances. Absent one it is the generic production
      // task, and the competency keys off the task's name.
      definition: { name: { en: input.taskName }, type },
    },
    result: {
      success: input.success,
      ...outcomeResultFor(type, input.success),
      ...(input.quality !== undefined ? { score: { scaled: input.quality } } : {}),
      ...(input.durationIso ? { duration: input.durationIso } : {}),
    },
    context: {
      registration: input.registration,
      // The profile it conforms to, and what kind of statement it is (xapi-profile.ts).
      contextActivities: { category: [{ id: input.profileUrl, objectType: 'Activity' }, ...performanceCategoriesFor(type)] },
      extensions: {
        [PERF_EXT.observedBy]: input.observedBy,
        [PERF_EXT.contextKind]: 'production',
        [PERF_EXT.actorKind]: input.actorKind,
        // How strongly the claim is tied to an artifact anybody can check, on the statement itself.
        [EVIDENCE_BINDING_EXT]: input.evidence.binding,
        ...(input.evidence.shapeIri ? { [EVIDENCE_SHAPE_EXT]: input.evidence.shapeIri } : {}),
        ...(typeof input.costUsd === 'number' ? { [PERF_EXT.costUsd]: input.costUsd } : {}),
        ...(input.workTrajectory ? { [PERF_EXT.workTrajectory]: input.workTrajectory } : {}),
      },
    },
    timestamp: input.timestamp,
  };
}
