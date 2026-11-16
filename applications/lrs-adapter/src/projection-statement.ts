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
/**
 * The xapi-x vocabulary (applications/foxxi-content-intelligence/xapix/xapix.ttl). Written out
 * here because this file imports nothing; the xapi-x profile's test fails if it drifts from the
 * namespace file.
 */
export const XAPIX_NS = 'https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/xapix#';

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
  /**
   * `sha256:` and 64 hex characters, over the descriptor's bytes as served. The caller states it
   * when it holds those bytes; this builder fetches nothing, so it never makes one up.
   */
  readonly descriptorDigest?: string;
  /**
   * The ids of the statements this one replaces as the current account, most recent first,
   * because the descriptor supersedes the descriptors they were projected from. It voids none of
   * them: a caller correcting a wrong statement sends xAPI's own voiding statement as well.
   */
  readonly supersedesStatements?: readonly string[];
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
  const superseded = args.supersedesStatements ?? [];
  const contextExtensions: Record<string, unknown> = {
    ...(args.descriptorDigest ? { [`${XAPIX_NS}descriptorDigest`]: args.descriptorDigest } : {}),
    ...(superseded.length > 0 ? { [`${XAPIX_NS}supersedesStatement`]: [...superseded] } : {}),
  };
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
    context: {
      // The marker a profile's template selects on: this statement is a projection of a signed
      // descriptor. Its id and its type are the one IRI.
      contextActivities: { category: [{ id: `${XAPIX_NS}Projection`, objectType: 'Activity', definition: { type: `${XAPIX_NS}Projection` } }] },
      // What a plain LRS can follow to the statement this one replaces.
      ...(superseded.length > 0 ? { statement: { objectType: 'StatementRef', id: superseded[0] } } : {}),
      ...(Object.keys(contextExtensions).length > 0 ? { extensions: contextExtensions } : {}),
    },
    timestamp,
  };
}
