/**
 * Every write of an account's `<pod>/<id>/auth-methods.jsonld`, as one read-modify-write.
 *
 * The identity server keeps a copy of each account's record (10 s cache), and its writers
 * used to save a record built from that copy: a passkey sign-in's counter bump, an added or
 * removed credential, a sign-out-everywhere. A change that reached the pod another way within
 * those 10 s (the other instance while a deploy overlaps the two, an operator's edit, a
 * request this server was still answering) was then overwritten: a removed credential came
 * back, a raised session epoch was undone, a sign counter went backwards. Some of those writes
 * were also deferred, acknowledged before the pod had them, so a failed one left this server
 * believing in a record the pod never held.
 *
 * Here a write is always, under the account's lock:
 *   1. read the record as the pod holds it now (never this server's copy);
 *   2. apply only the change the caller means (a delta over a copy of what was read);
 *   3. write it back conditionally: If-Match on the ETag read, or If-None-Match: * when the
 *      pod had no document. A precondition failure means someone wrote in between, so the read
 *      and the delta run again (`attempts` reads in all, 3 by default: two more after a 412);
 *   4. only then put what was written into this server's copy and indexes (`install`).
 * A read that fails writes nothing. A write that fails is settled, still under the lock
 * (`settle`), and what the pod holds then is installed and handed to the caller with the error
 * (`AuthMethodsWriteError.podRecord`: a write the pod applied before failing has landed). A
 * write the pod answered (a 5xx, a 4xx) is over, so one read settles it. A write the pod never
 * answered (a timeout, a dropped connection) may still be applied after that read: a store keeps
 * working on a request its client gave up on, and a read can overtake a queued write. So while
 * the record is still in a state the write could apply to, settle writes it back as read on the
 * same condition (a fence: the pending write's condition can then never hold), or creates one
 * where there is no document, and reads again; the record it returns is final. A missing
 * document fences nothing: a write sent with If-Match on an ETag is applied to one by Community
 * Solid Server 7.2 (only If-Match: * fails there), as a write sent with If-None-Match: * is.
 * This server's copy and indexes therefore change only from a record read or written under the
 * lock. When settling fails (a request of it fails), the copy is marked stale (`expire`) and
 * kept, with its index entries, and the error carries the condition the pending write was sent
 * with (`AuthMethodsWriteError.pending`): a reader of this account's copy then goes to the pod,
 * but a decision that reads no account's copy (a sign-in with a wallet or DID no indexed
 * account lists) never would, so until something reads the account the indexes can miss a
 * credential the pod lists. For a wallet or DID, the caller settles the account again itself
 * (server.ts credentialAfterFailedAdd and claimFirstSignInOnPod), and when it cannot, the write
 * (an add or a removal) is recorded and the credential's next request, or a background sweep,
 * settles it first (credential-decisions.ts). A passkey whose write stayed unsettled is not
 * recorded that way: its sign-in reads the accounts the index names.
 *
 * No server state and no I/O of its own: everything is injected, as in first-sign-in.ts, so
 * the contract is tested without starting server.ts (tests/auth-methods-writer.test.ts).
 */

/** The top-level keys server.ts reads from an auth-methods document (normaliseAuthMethods). */
export const AUTH_METHODS_KEYS: ReadonlySet<string> = new Set([
  '@context', '@id', '@type', 'userId', 'name', 'agentId', 'walletAddresses', 'webAuthnCredentials', 'didKeys',
  'sessionEpoch', 'provisionalPlayAnchor', 'provisionalPlayReceipts', 'deletedAt',
]);

/**
 * The top-level entries of a document that this server does not read, so that a write built
 * from the normalised record keeps them (something else may have put them there).
 */
export function unknownTopLevelKeys(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (!AUTH_METHODS_KEYS.has(k)) out[k] = v;
  return out;
}

/** An account's record as the pod holds it: null `methods` when it has no document (404). */
export interface LiveRecord<M> {
  methods: M | null;
  /** The document as parsed, for the keys this server does not read. */
  raw: unknown;
  /** The ETag the pod sent with it, when it sent one. */
  etag: string | null;
}

/** The condition a write is sent with. 'none': the pod sent no ETag, so the write is unconditional. */
export type WritePrecondition = { kind: 'absent' } | { kind: 'match'; etag: string } | { kind: 'none' };
export type WriteResult = 'ok' | 'precondition-failed';

export class AccountDeletedError extends Error { override name = 'AccountDeletedError'; }
/** The pod has no auth-methods document for the account (and this write may not create one). */
export class AccountRecordMissingError extends Error { override name = 'AccountRecordMissingError'; }
/** Every attempt met a write by someone else between its read and its write. */
export class AuthMethodsConflictError extends Error { override name = 'AuthMethodsConflictError'; }
/**
 * The pod refused a write, or did not answer it. `unknownOutcome`: it may have applied it all
 * the same (a 5xx, a timeout, a dropped connection), which is why the record is read again.
 * `unanswered`: the pod sent no answer at all (a timeout, a dropped connection), so it may still
 * apply the write later, and a read made after it is final only once settled (`settle`).
 */
export class AuthMethodsWriteError extends Error {
  override name = 'AuthMethodsWriteError';
  /**
   * What the pod holds once the failed write can no longer apply, settled by applyUpdate still
   * under the lock: its record, or null when it has no document. Undefined when it could not be
   * settled (a request of it failed). A caller whose write may have landed decides on this, not
   * on its own request.
   */
  podRecord?: unknown;
  /**
   * Set when podRecord is undefined and the pod never answered the write: the condition it was
   * sent with, which a later `settle` of the account needs (the write may still apply until the
   * record moves off that state).
   */
  pending?: WritePrecondition;
  /**
   * The pod did not answer a request the write sends before its document (a create's container
   * PUT), so the document was never sent: nothing of this write is pending, but the pod is not
   * answering, and a settlement whose fence meets this stops there (`settle`).
   */
  stalled?: true;
  constructor(message: string, readonly unknownOutcome: boolean, readonly unanswered = false) { super(message); }
}
/** A write the pod never answered may still apply, and nothing could stop it (see settle). */
export class UnsettledWriteError extends Error { override name = 'UnsettledWriteError'; }
/** An unclaimed Play owner whose anchor no longer opens to its id: no credential may be added. */
export class PlayOwnerUnavailableError extends Error { override name = 'PlayOwnerUnavailableError'; }
/** A caller asked for an account's lock while already holding it. A bug, never a user error. */
export class PodLockReentryError extends Error { override name = 'PodLockReentryError'; }

export type DeltaOutcome = { readonly kind: 'write' } | { readonly kind: 'no-write'; readonly reason: string; readonly detail?: unknown };
export const Write: DeltaOutcome = Object.freeze({ kind: 'write' });
export function NoWrite(reason: string, detail?: unknown): DeltaOutcome {
  return detail === undefined ? { kind: 'no-write', reason } : { kind: 'no-write', reason, detail };
}

/**
 * The change a writer means, applied to `draft` (a copy of the live record, or of an empty
 * record when the pod has none and the write may create or pass). `live` is what was read,
 * frozen, or null. A delta may run more than once (after a precondition failure), so it
 * resets anything it records outside the draft at its start. It never throws for an expected
 * outcome (it returns NoWrite), never answers an HTTP request, never takes a lock and never
 * reads this server's copy of an account.
 */
export type Delta<M> = (draft: M, live: Readonly<M> | null) => Promise<DeltaOutcome> | DeltaOutcome;

export interface UpdateOptions {
  /** The pod has no document: 'refuse' (AccountRecordMissingError), 'create' it, or 'pass' null to the delta. */
  absent?: 'refuse' | 'create' | 'pass';
  /**
   * The pod holds a deletion tombstone: 'refuse' (AccountDeletedError) or 'replace' it. 'replace'
   * is a deletion's, which writes the tombstone: it may close a Play owner whatever its anchor
   * says, and leave its tombstone where the pod has no document ('create').
   */
  tombstone?: 'refuse' | 'replace';
  /** Reads (and writes) before giving up on a record others keep writing. Default 3. */
  attempts?: number;
}

export type UpdateResult<M> =
  | { readonly written: true; readonly record: M }
  | { readonly written: false; readonly reason: string; readonly detail?: unknown };

export interface WriterDeps<M> {
  /** Run `fn` holding the account's lock (server.ts withIdentityPodMutex). */
  lock<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  /** Throws unless the caller holds the account's lock. */
  assertLockHeld(userId: string): void;
  /** The record as the pod holds it. Throws (PodReadError) when it cannot be read; never creates. */
  readLive(userId: string): Promise<LiveRecord<M>>;
  /** Write a document. Throws AuthMethodsWriteError (or AccountDeletedError) on failure. */
  writeLive(userId: string, doc: M, pre: WritePrecondition, context: string): Promise<WriteResult>;
  /** Make this record this server's copy of the account (cache and indexes together). */
  install(userId: string, methods: M): void;
  /** Mark this server's copy stale, keeping it, so the next reader goes to the pod. */
  expire(userId: string): void;
  /** The account was deleted in this process. */
  isDeleted(userId: string): boolean;
  isTombstone(methods: M): boolean;
  /** An empty record for the account. */
  empty(userId: string): M;
  /**
   * For a Play owner (`u-try-play-`): whether a record may be changed. A claimed owner (one
   * with a credential) always may; an unclaimed one only while its anchor opens to its id.
   */
  playGuard(userId: string, live: M): boolean;
  /** Every attempt met another writer's change: called once, before AuthMethodsConflictError. */
  conflicted?(userId: string, context: string, attempts: number): void;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const isPlayOwner = (userId: string) => userId.startsWith('u-try-play-');

/**
 * The read-modify-write itself, for a caller that already holds the account's lock (an
 * account deletion, which closes the account under the same lock it then clears memory in).
 * Everyone else calls updateAuthMethods, which takes the lock.
 */
export async function applyUpdate<M>(
  deps: WriterDeps<M>,
  userId: string,
  context: string,
  delta: Delta<M>,
  opts: UpdateOptions = {},
): Promise<UpdateResult<M>> {
  deps.assertLockHeld(userId);
  const tombstone = opts.tombstone ?? 'refuse';
  // A Play owner's record is created only by its provisioning (the anchor), or as its deletion's
  // tombstone: no other write re-creates a purged one, and only a deletion ('replace') changes an
  // unclaimed owner whose anchor no longer opens.
  const deletion = tombstone === 'replace';
  const absent = isPlayOwner(userId) && !deletion ? 'refuse' : (opts.absent ?? 'refuse');
  const attempts = Math.max(1, opts.attempts ?? 3);
  if (deps.isDeleted(userId) && tombstone !== 'replace') throw new AccountDeletedError(`${userId}: account deleted`);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const live = await deps.readLive(userId);
    const read = live.methods === null ? null : deepFreeze(live.methods);
    if (read !== null && deps.isTombstone(read) && tombstone === 'refuse') {
      deps.install(userId, read);
      throw new AccountDeletedError(`${userId}: account deleted`);
    }
    if (read === null && absent === 'refuse') {
      deps.install(userId, deps.empty(userId));
      throw new AccountRecordMissingError(`${userId}: no auth-methods document`);
    }
    if (read !== null && isPlayOwner(userId) && !deletion && !deps.playGuard(userId, read)) {
      deps.install(userId, read);
      throw new PlayOwnerUnavailableError(`${userId}: Provisional owner unavailable`);
    }
    const draft = structuredClone(read ?? deps.empty(userId)) as M;
    const outcome = await delta(draft, read);
    if (outcome.kind === 'no-write') {
      deps.install(userId, read ?? deps.empty(userId));
      return outcome.detail === undefined
        ? { written: false, reason: outcome.reason }
        : { written: false, reason: outcome.reason, detail: outcome.detail };
    }
    // A tombstone keeps nothing of the account it replaces.
    const doc = (deps.isTombstone(draft) ? draft : { ...unknownTopLevelKeys(live.raw), ...draft }) as M;
    const pre: WritePrecondition = read === null ? { kind: 'absent' } : live.etag ? { kind: 'match', etag: live.etag } : { kind: 'none' };
    let result: WriteResult;
    try {
      result = await deps.writeLive(userId, doc, pre, context);
    } catch (err) {
      if (err instanceof AccountDeletedError) throw err;
      const failure = err instanceof AuthMethodsWriteError ? err : new AuthMethodsWriteError((err as Error).message, true, true);
      // The pod may hold the new record or the old one, and one it never answered may still
      // apply. Still under the lock, settle it, and tell the caller what the pod holds then: a
      // write the pod applied before answering 500 (or timing out) has landed.
      const pending = failure.unanswered ? pre : undefined;
      try {
        const now = await settle(deps, userId, pending, context);
        deps.install(userId, now.methods ?? deps.empty(userId));
        failure.podRecord = now.methods;
      } catch {
        deps.expire(userId);
        if (pending) failure.pending = pending;
      }
      throw failure;
    }
    if (result === 'precondition-failed') continue;
    deps.install(userId, doc);
    return { written: true, record: doc };
  }
  deps.conflicted?.(userId, context, attempts);
  throw new AuthMethodsConflictError(`${userId}: auth-methods document changed under ${attempts} write(s)`);
}

/** Whether `now` is off every state a write sent on `pending` could apply to, so that write can no longer apply. */
function movedOff<M>(now: LiveRecord<M>, pending: WritePrecondition): boolean {
  if (pending.kind === 'absent') return now.methods !== null;
  // If-Match on an ETag holds where the document has that ETag, and, on Community Solid Server 7.2
  // (BasicConditions.matchesMetadata), where there is no document at all: only If-Match: * fails on
  // a missing one. So only a document with another ETag is off it.
  if (pending.kind === 'match') return now.methods !== null && now.etag !== pending.etag;
  // Sent unconditionally (the pod sends no ETag): nothing can fence it, and a read is all there is.
  return true;
}

/**
 * The record as the pod holds it once a failed write can no longer change it, for a caller that
 * holds the account's lock. `pending`: the condition of a write the pod never answered (undefined
 * when it answered, or when there is none): such a write may still be applied after any read, so
 * long as the record is in a state it can apply to (the ETag it was sent with, or no document at
 * all: a store may apply If-Match to a missing document, movedOff; no document, for
 * If-None-Match: *). Then the record is written back as read, on that same condition, or, where
 * there is no document, an empty record is created (If-None-Match: *), so that the pending
 * write's condition can never hold again, and read once more. Any write since (the pending one,
 * the fence, another writer's) moves the record off that state, and the read that finds it moved
 * is final. It used to take a missing document as off an If-Match write's state, which on CSS 7.2
 * it is not: the write landed on it afterwards, and re-created a record that had been removed.
 *
 * Throws (UnsettledWriteError, or the read's error) when it cannot get there: a read fails, the
 * fence gets no answer (it may still apply too; for a create, its container PUT got none), or the
 * record has not moved after the fence (a store whose ETag does not change on every write).
 * Requests stop at the first that fails, so a pod that never answers holds the lock here for one
 * more timeout at most.
 */
export async function settle<M>(deps: WriterDeps<M>, userId: string, pending: WritePrecondition | undefined, context: string): Promise<LiveRecord<M>> {
  deps.assertLockHeld(userId);
  const now = await deps.readLive(userId);
  if (!pending || movedOff(now, pending)) return now;
  const missing = now.methods === null;
  const fence = (missing ? deps.empty(userId) : { ...unknownTopLevelKeys(now.raw), ...now.methods }) as M;
  try {
    await deps.writeLive(userId, fence, missing ? { kind: 'absent' } : pending, `${context}-settle`);
  } catch (err) {
    // A fence the pod did not answer may apply later, as may the write: neither is over. A fence
    // whose container PUT got no answer was never sent, and the pod is not answering: stop here
    // too rather than read again (that read would add one more timeout to the bound).
    if (!(err instanceof AuthMethodsWriteError) || err.unanswered || err.stalled) {
      throw new UnsettledWriteError(`${userId}: a write the pod did not answer could not be fenced`);
    }
  }
  const after = await deps.readLive(userId);
  if (movedOff(after, pending)) return after;
  throw new UnsettledWriteError(`${userId}: the record did not move off the state a write the pod did not answer was conditional on`);
}

/** applyUpdate under the account's lock. */
export function updateAuthMethods<M>(
  deps: WriterDeps<M>,
  userId: string,
  context: string,
  delta: Delta<M>,
  opts: UpdateOptions = {},
): Promise<UpdateResult<M>> {
  return deps.lock(userId, () => applyUpdate(deps, userId, context, delta, opts));
}
