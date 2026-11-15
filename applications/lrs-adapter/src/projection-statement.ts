/**
 * The xAPI Statement a context descriptor is projected to, built and nothing else.
 *
 * This was the middle of `projectDescriptorToLrs` in pod-publisher.ts, between the modal-status
 * checks and the POST. It is a function of its own so that what the adapter sends to an LRS can
 * be checked against a profile without an LRS or a pod: the xapi-x profile's test
 * (applications/foxxi-content-intelligence/tests/an-lrs-adapter-statement-follows-the-xapi-x-profile.test.ts)
 * runs this, not a copy of it.
 *
 * It imports nothing, on purpose, so a test of the statement's shape loads no substrate package.
 */

/** The published `iep:` vocabulary. The four keys below are declared in docs/ns/iep.ttl. */
export const IEP_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

export interface ProjectionStatementArgs {
  readonly descriptorIri: string;
  /** An xAPI Agent. */
  readonly actor: Record<string, unknown>;
  readonly verbId: string;
  readonly objectId: string;
  readonly verbDisplay?: string;
  readonly objectName?: string;
  /** Every coherent narrative of a synthesis; the first becomes `result.response`. */
  readonly coherentNarratives?: readonly string[];
  readonly modalStatus?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
}

/** True when the projection keeps more than one narrative, so `result.response` is only the first. */
export const keepsSeveralNarratives = (args: Pick<ProjectionStatementArgs, 'coherentNarratives'>): boolean =>
  args.coherentNarratives !== undefined && args.coherentNarratives.length > 1;

/**
 * True when the statement says less than the descriptor it is projected from: the source was not
 * asserted, which an xAPI statement cannot say outside an extension, or it held several
 * narratives and `result.response` carries one. The audit row on the pod has always used this
 * test; the statement now states the same answer.
 */
export const projectionIsLossy = (args: Pick<ProjectionStatementArgs, 'coherentNarratives' | 'modalStatus'>): boolean =>
  (args.modalStatus !== undefined && args.modalStatus !== 'Asserted') || keepsSeveralNarratives(args);

/** Build the statement. `id` and `timestamp` are the caller's, so the result is a function of its arguments. */
export function buildProjectionStatement(args: ProjectionStatementArgs, id: string, timestamp: string): Record<string, unknown> {
  // xAPI extension KEYS are dereferenceable predicate IRIs under the published iep:
  // vocabulary (…/ns/iep#<term>), not opaque urns — each GETs its definition.
  const extensions: Record<string, unknown> = {
    [`${IEP_NS}sourceDescriptor`]: args.descriptorIri,
    [`${IEP_NS}modalStatus`]: args.modalStatus ?? 'Asserted',
    // Always stated, `false` included. It used to be written only alongside several narratives,
    // so a Hypothetical projection the audit row called lossy said nothing here, and a reader
    // could not tell "faithful" from "not stated".
    [`${IEP_NS}projectionLossy`]: projectionIsLossy(args),
  };
  if (keepsSeveralNarratives(args)) extensions[`${IEP_NS}coherentNarratives`] = args.coherentNarratives;
  return {
    id,
    actor: args.actor,
    verb: { id: args.verbId, display: { 'en-US': args.verbDisplay ?? args.verbId.split('/').pop() ?? 'observed' } },
    object: {
      objectType: 'Activity',
      id: args.objectId,
      definition: { name: { 'en-US': args.objectName ?? args.descriptorIri } },
    },
    result: {
      response: args.coherentNarratives?.[0] ?? '',
      extensions,
    },
    timestamp,
  };
}
