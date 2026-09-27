/**
 * A learner record read only in part is not classified, or served, for anyone but its subject.
 *
 * Whether a record is private (a person's) or public (an agent's capability record) is read from
 * all of its own work: it is an agent's only when none of it says a person did it (the bridge's
 * classifySubjectKind). The bridge reads a record from three places, and two of them are
 * best-effort: the shared lattice's pod copy, and the durable records on the pod. Neither said
 * anything when it fell short. So during a pod outage, a person's record whose person-kind work lived
 * only on the pod read as all agent's work, was classified public, and was served to any signed
 * caller. That is fail-open, against the rule these gates keep: no evidence means private.
 *
 * So a gate asks whether it read the record whole (latticeReadWhole and
 * readDurableRecordedStatementsDetailed), and refuses a reader it would have to classify the record
 * for while it did not.
 *
 * ★ A REFUSAL, NOT A PRIVATE CLASSIFICATION. Classifying a partly read record as a person's would
 * keep it from a stranger too. But it would say something false whenever the record is in fact an
 * agent's (a public capability record answered as "a human learner record is private"), and the
 * reader could not tell a pod outage from a policy. A 503 says what happened and serves nothing
 * partial. A retry once the pod answers is then decided by the whole record.
 *
 * The subject reads their own record as before, whole or not. So does a reader the gate lets read
 * a record whatever it is (an admin, at the gate that has one): for them, the classification
 * decides nothing.
 */

/** Who is reading a record, as far as its gate is concerned. */
export interface RecordReader {
  /** The reader is the record's subject. */
  isSelf: boolean;
  /** The gate lets this reader read the record whatever it is. */
  unconditional: boolean;
}

/** Whether a record read only in part may still be served to this reader. */
export function servedInPart(reader: RecordReader): boolean {
  return reader.isSelf || reader.unconditional;
}

/** The refusal a reader gets when a record the gate must classify for them was not read whole. */
export function recordNotReadWhole(): {
  kind: 'refusal';
  'iep:refusalStatus': 503;
  'iep:refusalReason': string;
  error: string;
  hint: string;
} {
  return {
    kind: 'refusal',
    'iep:refusalStatus': 503,
    'iep:refusalReason': 'the record could not be read whole, so whether it is private cannot be told',
    error: 'the learner record could not be read whole: part of it is on a pod that did not answer, and whether a record is private is decided from all of it. Nothing was served.',
    hint: 'Try again once the pod answers. The record\'s subject can still read their own record meanwhile.',
  };
}
