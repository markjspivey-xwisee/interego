/**
 * Voids kept with the record they void.
 *
 * A lens tenant's store is a view: the process-wide budget evicts its oldest records, a dropped
 * partition takes all of them, and a restart takes everything, while a voided statement's copies in
 * its owner's lattice and on their pod outlive it. So once the LRS applies a void (onVoidApplied,
 * xapi-lrs.ts), the bridge keeps the fact beside the owner's statements, as a small record of its
 * own (foxxi:AppliedVoid), and every merge of the owner's record reads those records
 * (mergeStatementsById, durable-records.ts).
 *
 * Only a void that took effect is ever kept: whether a voiding statement voids anything is decided
 * once, by the store, from things its body does not say.
 */

/** The content type the owner's lattice keeps an applied void under. */
export const APPLIED_VOID_TYPE = 'foxxi:AppliedVoid';

/** A statement's owner, as a play or a performance names them: the DID its actor's account carries. */
export function ownerDidOf(statement: Record<string, unknown>): string | undefined {
  const name = (statement.actor as { account?: { name?: unknown } } | undefined)?.account?.name;
  return typeof name === 'string' && /^did:[a-z0-9]+:\S+$/i.test(name) ? name : undefined;
}

/** An applied void as the owner's lattice keeps it: the voided statement, and the statement that voided it. */
export function appliedVoidRecord(statementId: string, voidedBy: string): { statementId: string; voidedBy: string } {
  return { statementId, voidedBy };
}

/** The statements a void was applied to, from the applied voids a lattice keeps; anything else is passed over. */
export function appliedVoidsIn(kept: ReadonlyArray<{ content: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const k of kept) {
    const id = (k.content as { statementId?: unknown } | null | undefined)?.statementId;
    if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}
