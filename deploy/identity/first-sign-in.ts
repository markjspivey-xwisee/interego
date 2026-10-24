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
 * agent) and the credential is added to it.
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
}

export async function claimFirstSignIn<M extends AuthMethodsLike>(input: FirstSignInInput<M>): Promise<FirstSignInOutcome<M>> {
  const attempts = Math.max(1, input.attempts ?? 3);
  for (let attempt = 0; attempt < attempts; attempt++) {
    let existing: M | null;
    try {
      existing = await input.read();
    } catch (err) {
      return { kind: 'unreadable', reason: (err as Error).message };
    }
    if (existing && hasAnyCredentialLike(existing)) {
      return input.holds(existing) ? { kind: 'returning', methods: existing } : { kind: 'refused' };
    }
    if (input.mayCreate === false) return { kind: 'refused' };
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
