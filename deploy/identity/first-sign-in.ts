/**
 * A first-time wallet (SIWE) or DID sign-in, checked against what the account's pod holds.
 *
 * A wallet or DID that the in-memory indexes do not know takes the first-time path: the
 * account id is derived from the credential (`u-eth-<addr>`, `u-did-<hash>`) or claimed with a
 * bootstrap invite, and the account is created holding that one credential. That path used
 * to write `<pod>/auth-methods.jsonld` without reading it. The indexes miss a credential for
 * reasons that say nothing about the pod: the pod was unreadable when the container started,
 * or had not been loaded yet, or the owner removed this wallet or DID earlier. Each time, the
 * blind write replaced the account's passkeys, other wallets and DIDs with the single
 * credential being presented, and for a removed one it quietly gave back the access its owner
 * had taken away.
 *
 * Here the pod is read first, and the answer decides:
 *   - the pod cannot be read → 'unreadable' (the caller says "try again"; nothing written);
 *   - it lists this credential → 'returning': a sign-in to an account the indexes missed;
 *   - it lists other credentials only → 'refused': this credential is not on that account,
 *     and it is added only by signing in with one that is;
 *   - it has no document, or one without credentials → the account is created. A missing
 *     document is created with a write that fails when one has appeared since the read
 *     (`If-None-Match: *`); on that failure the pod is read again and the decision taken
 *     again, so a concurrent creator is never overwritten.
 * A document without credentials is kept (its session epoch and name; the caller sets the
 * agent) and the credential is added to it, unless it is the tombstone a deleted account
 * leaves (`closed`): then the answer is 'deleted' and nothing is written. Deleting an account
 * leaves its pod container and files behind, so re-creating its derived id would hand them,
 * and its did:web name, to whoever presents one of its old credentials. A write that meets
 * a document under it reads again, so a tombstone written meanwhile is seen.
 *
 * Accounts deleted before deletions left a tombstone have none: their pod has no document, or
 * one without credentials, and still holds the rest. So before creating, the caller may ask
 * `vacated` whether the pod is such an account's: true answers 'deleted' and creates nothing
 * (`retire` is then called once to leave the tombstone, so the next attempt reads it); a pod
 * the question could not be answered for is 'unreadable'. It is asked at most once per claim,
 * and never about a pod that lists credentials, a tombstone, or a credential that may not
 * create, so a live account is never asked and never written by it.
 *
 * The caller runs this under the per-user pod mutex. No server state and no I/O: the read,
 * the record to write and the write are injected, so it is tested without starting server.ts.
 */

import type { AuthMethodsLike } from './resolve-target-userid.js';
import { hasAnyCredentialLike } from './resolve-target-userid.js';

export type FirstSignInOutcome<M> =
  | { readonly kind: 'created'; readonly methods: M }
  | { readonly kind: 'returning'; readonly methods: M }
  | { readonly kind: 'refused' }
  | { readonly kind: 'deleted' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'unconfirmed'; readonly reason: string };

export interface FirstSignInInput<M extends AuthMethodsLike> {
  /** The pod's record, or null when it has no auth-methods document. Throws when unreadable. */
  read: () => Promise<M | null>;
  /** Whether a record lists the credential being presented. */
  holds: (methods: M) => boolean;
  /** The record to write: `existing` (a document without credentials) or a new one, plus the credential. */
  build: (existing: M | null) => M;
  /**
   * Write the record. `ifAbsent`: only if no document exists yet. Resolves false when that
   * precondition failed (someone else wrote first); throws on any other failure.
   */
  create: (methods: M, ifAbsent: boolean) => Promise<boolean>;
  /** Reads before giving up on a document that keeps appearing under the write. Default 3. */
  attempts?: number;
  /**
   * False when the credential may sign in to an account that holds it but cannot open one
   * (nothing proves it belongs to its holder): a pod without credentials is then 'refused'
   * and nothing is written. Default true.
   */
  mayCreate?: boolean;
  /** Whether a record is a deleted account's tombstone, which no sign-in may re-open. */
  closed?: (methods: M) => boolean;
  /**
   * Asked only when the pod holds no credentials (no document, or one without credentials
   * that is not a tombstone) and the account could otherwise be created, at most once per
   * claim: whether the pod belonged to an account deleted before deletions left a tombstone.
   * True answers 'deleted' and nothing is created; a throw (the pod could not be read)
   * answers 'unreadable'.
   */
  vacated?: (existing: M | null) => Promise<boolean>;
  /** Called once when `vacated` said true, to leave the tombstone; a failure still refuses. */
  retire?: (existing: M | null) => Promise<void>;
}

export async function claimFirstSignIn<M extends AuthMethodsLike>(input: FirstSignInInput<M>): Promise<FirstSignInOutcome<M>> {
  const attempts = Math.max(1, input.attempts ?? 3);
  // What `vacated` said, asked once per claim: what a concurrent creator wrote after the first
  // read is not a deleted account's leftovers.
  let vacated: boolean | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let existing: M | null;
    try {
      existing = await input.read();
    } catch (err) {
      return { kind: 'unreadable', reason: (err as Error).message };
    }
    if (existing && input.closed?.(existing)) return { kind: 'deleted' };
    if (existing && hasAnyCredentialLike(existing)) {
      return input.holds(existing) ? { kind: 'returning', methods: existing } : { kind: 'refused' };
    }
    if (input.mayCreate === false) return { kind: 'refused' };
    if (input.vacated && vacated === undefined) {
      try {
        vacated = await input.vacated(existing);
      } catch (err) {
        return { kind: 'unreadable', reason: (err as Error).message };
      }
      if (vacated) {
        try { await input.retire?.(existing); } catch { /* still refused; the next attempt asks again */ }
        return { kind: 'deleted' };
      }
    }
    const methods = input.build(existing);
    let written: boolean;
    try {
      written = await input.create(methods, existing === null);
    } catch (err) {
      return { kind: 'unconfirmed', reason: (err as Error).message };
    }
    if (written) return { kind: 'created', methods };
  }
  return { kind: 'unconfirmed', reason: `auth-methods document changed under ${attempts} write(s)` };
}
