/**
 * WHO A PRIVATE WORKSPACE IS ENCRYPTED TO.
 *
 * ── ★★ THE HANDLE THE PRODUCT TEACHES DOES NOT WORK HERE ────────────────────
 *
 * `composedHandle` is `acct:<pod>@<relay host>` — it is what the invite flow shows people and what
 * every placeholder in the UI says. It resolves against the RELAY's WebFinger, whose JRD carries
 * `self`, `profile-page` and `ldp#inbox` and NO storage link. `resolveWebFinger` therefore returns
 * no pod URL, `resolveHandleToPodUrl` returns null, and the handle contributes ZERO RECIPIENTS —
 * silently, with the publish succeeding.
 *
 * A private workspace built on that handle would be encrypted to nobody but its author, and the
 * only evidence would be `sharedWith[].agentCount === 0` in a response field nothing reads.
 *
 * So recipients are built from each seat's `grantedTo` WebID instead. That is the
 * `https://identity…/users/<pod>/profile` form, the identity server's WebFinger DOES publish a
 * storage link, and `resolveInvitee` already guarantees the shape: it reads the WebID from the
 * invitee's own pod registry and refuses the invite unless `podOfWebid(webId) === pod`. The roster
 * fold already holds it, so this costs no extra round trip.
 *
 * ── ★ AND ENCRYPTING TO A PARTIAL ROSTER IS WORSE THAN REFUSING ─────────────
 *
 * `foldRoster` reads at most `GRANT_READ_CAP` grants. If a workspace has more, the roster it
 * returns is a subset — and a subset is exactly the wrong thing to encrypt to, because the members
 * it omits are locked out of a conversation they are seated in, permanently, with no error
 * anywhere. The recipient list refuses rather than guesses.
 */

import type { Seat } from './seats.js';

/** What to publish with, or why nothing may be published. */
export type RecipientPlan =
  | {
      readonly ok: true;
      readonly shareWith: readonly string[];
      readonly seats: number;
      /**
       * Each seated member's X25519 public key, from their OWN acceptance — for a client that
       * seals before sending.
       *
       * ── ★★ WHY THIS IS SEPARATE FROM `shareWith` AND NOT A REPLACEMENT ────────
       *
       * `shareWith` is a list of WebIDs handed to the RELAY, which resolves each one to a pod and
       * reads that pod's agent registry for keys. That path cannot be end-to-end: the relay is
       * choosing the keys, and it adds its own besides. `keys` is the list a publisher seals to
       * ITSELF, so the relay never chooses and never appears.
       *
       * Both exist because the two publish paths coexist for the rest of these workspaces' lives —
       * an envelope's recipients are fixed at write time, so nothing already written can be moved
       * across, and a client talking to a relay that predates the sealed path still needs the old
       * one.
       *
       * ★ EMPTY WHEN ANY SEATED MEMBER PUBLISHED NO KEY. Not "the subset that has one": sealing to
       * a subset locks out the rest permanently and silently, which is the failure this file was
       * written for. `keysMissing` names them so a caller can say who, and refuse.
       */
      readonly keys: readonly string[];
      /** Seated members whose acceptance carries no key. Non-empty means `keys` is unusable. */
      readonly keysMissing: readonly string[];
      /**
       * WebIDs of people who hold a grant but have not accepted it yet.
       *
       * ── ★★ THEY BELONG IN A RESEAL AND NOWHERE ELSE ─────────────────────────
       *
       * `shareWith` deliberately excludes them: an entry is for the people IN the conversation, and
       * somebody who has not accepted is not one yet.
       *
       * But re-sealing the workspace RECORD is the opposite case, and getting it wrong is what
       * makes an invitation impossible to accept. `verifyGrantIri` reads the record to check the
       * grant; a pending invitee who cannot read it cannot verify their own grant and cannot
       * accept. Since a reseal REPLACES the recipient set, inviting a second person while the first
       * is still pending would evict the first — silently, by the very operation meant to let
       * somebody in, and with the roster still showing them as "granted, not accepted".
       *
       * With N outstanding invitations only the most recent could ever be accepted, one at a time.
       */
      readonly pendingWebIds: readonly string[];
    }
  | { readonly ok: false; readonly why: string };

/**
 * Build the `share_with` list for a private workspace from its roster.
 *
 * `grantsFound`/`grantsRead` come from the same fold that produced the seats — see the header for
 * why a truncated roster is refused rather than used.
 */
export function recipientsFromRoster(args: {
  readonly seats: readonly Seat[];
  readonly grantsFound: number;
  readonly grantsRead: number;
}): RecipientPlan {
  if (args.grantsFound > args.grantsRead) {
    return {
      ok: false,
      why: 'this workspace has ' + args.grantsFound + ' grants and only ' + args.grantsRead
        + ' were read, so the roster is incomplete. Encrypting to an incomplete roster would lock the '
        + 'members it missed out of a conversation they are seated in, with nothing to show for it. '
        + 'Nothing was written.',
    };
  }

  const seated = args.seats.filter((s) => s.seated && !s.revoked);
  // Granted but not yet accepted. Excluded from `shareWith`, included in a reseal — see the field.
  const pendingWebIds = args.seats
    .filter((s) => !s.seated && !s.revoked && s.pending && s.grantedTo)
    .map((s) => s.grantedTo as string);
  const handles: string[] = [];
  const missing: string[] = [];
  const keys: string[] = [];
  const keysMissing: string[] = [];
  for (const s of seated) {
    // Collected alongside the WebID, from the same seat, so the two lists cannot describe
    // different populations. See `RecipientPlan.keys` for why both exist.
    if (s.encryptionKey) { if (!keys.includes(s.encryptionKey)) keys.push(s.encryptionKey); }
    else keysMissing.push(s.pod ?? s.graph);
    /**
     * ★ THE WebID, NEVER THE COMPOSED HANDLE. See the header: the handle the invite flow teaches
     * resolves to zero recipients without erroring.
     */
    if (s.grantedTo) { if (!handles.includes(s.grantedTo)) handles.push(s.grantedTo); }
    else missing.push(s.pod ?? s.graph);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      why: missing.length + ' seated member' + (missing.length === 1 ? '' : 's')
        + ' (' + missing.join(', ') + ') carry no WebID this reader can resolve, so there is no address to '
        + 'encrypt to for them. A private workspace that silently skipped them would read as empty on '
        + 'their side forever. Nothing was written.',
    };
  }
  if (handles.length === 0) {
    return { ok: false, why: 'no seated member of this workspace resolves to an encryption address, so a private write would be readable by nobody. Nothing was written.' };
  }
  return {
    ok: true, shareWith: handles, seats: seated.length,
    // ★ ALL OR NOTHING. A partial key list is the silent lockout this whole file exists to refuse,
    // so the caller gets an empty list plus the names, and decides in the open.
    keys: keysMissing.length > 0 ? [] : keys,
    keysMissing,
    pendingWebIds: [...new Set(pendingWebIds)],
  };
}

/**
 * ── ★ WHAT REVOCATION DOES AND DOES NOT TAKE BACK, AND WHY THAT IS THE ANSWER ─
 *
 * `recipientsFromRoster` skips revoked and unseated rows, so from the moment somebody is revoked
 * they are not a recipient of any NEW entry or canvas revision. That is the part that matters, and
 * it is automatic — every write recomputes the list.
 *
 * Two things it deliberately does NOT do:
 *
 *   · It cannot un-send what was already written. An envelope's recipients are fixed when it is
 *     sealed, and a revoked member keeps whatever they could already open. That is inherent to
 *     encrypting to recipients rather than to a server that can be told to stop answering — it is
 *     the property being bought, not a gap in the implementation.
 *   · The workspace RECORD is not re-sealed on revoke, so a revoked member can still read later
 *     revisions of it. Considered and left: the record carries the title, convener, role profile
 *     and entry shape, and the membership GRANT that names them is published PUBLIC — so nothing
 *     in it is withheld from them by any other means either. Re-sealing it would suggest a
 *     confidentiality the surrounding documents do not have.
 */

/**
 * The `shareWith` to pass a writer, for a workspace of this visibility.
 *
 * ★ THE ONE PLACE THE TWO QUESTIONS ARE JOINED. "Is this workspace private" and "who are its
 * members" are answered in different files from different reads, and every write site needs both.
 * Three call sites each doing the join themselves is three chances to check the first and forget
 * the second — which publishes an entry sealed to its author alone, silently and permanently.
 *
 * A public workspace gets `undefined`, which is not a recipient list and is not an empty one: the
 * writers only send `share_with` when they are actually encrypting.
 */
export function recipientsFor(
  visibility: 'public' | 'private' | 'unknown' | undefined,
  roster: { readonly seats: readonly Seat[]; readonly grantsFound: number; readonly grantsRead: number } | null,
): { readonly ok: true; readonly visibility: 'public' | 'private'; readonly shareWith: readonly string[] | undefined;
      readonly keys: readonly string[]; readonly keysMissing: readonly string[]; readonly pendingWebIds: readonly string[] }
  | { readonly ok: false; readonly why: string } {
  /**
   * ★★ REFUSED, BECAUSE THE ALTERNATIVE IS PUBLISHING IN THE CLEAR. `'unknown'` means the record
   * could not be READ — the reader has no key, or is not in that envelope. It used to arrive here
   * as `'public'`, indistinguishable from a workspace that genuinely is, and every guard
   * downstream keys on `=== 'private'`. So the member who could not read the channel was the one
   * member who would post plaintext into it.
   *
   * This is the same shape as the truncated-roster refusal below: when the answer is not
   * established, nothing is written.
   */
  if (visibility === 'unknown') {
    return {
      ok: false,
      why: 'this workspace\'s record could not be read here, so whether it is private is not established '
        + '— and writing under a guess would publish in the clear if the guess is wrong. Open the workspace '
        + 'in a client signed in with your own key. Nothing was written.',
    };
  }
  // ★ The resolved value is RETURNED rather than left for the caller to re-derive: a caller that
  // asked here and then read `record.visibility` again for the write could get two answers.
  // A public workspace seals nothing, so it has no recipients of either kind.
  if (visibility !== 'private') return { ok: true, visibility: 'public', shareWith: undefined, keys: [], keysMissing: [], pendingWebIds: [] };
  if (!roster) {
    return {
      ok: false,
      why: 'this workspace is private and its roster has not been read here, so there is no way to tell who '
        + 'this should be encrypted to. Open the workspace and let the members list load first. Nothing was written.',
    };
  }
  const plan = recipientsFromRoster(roster);
  return plan.ok
    ? { ok: true, visibility: 'private', shareWith: plan.shareWith, keys: plan.keys, keysMissing: plan.keysMissing, pendingWebIds: plan.pendingWebIds }
    : { ok: false, why: plan.why };
}

/**
 * Check what the relay actually resolved, from the publish response.
 *
 * ★★ THE ONLY EVIDENCE THAT A RECIPIENT WAS REACHED. `resolveRecipient` returns an entry with an
 * EMPTY key list rather than an error when a handle does not resolve or a pod registers no
 * encryption key, and `computePublishRecipients` then adds none. The publish SUCCEEDS. The single
 * signal is `sharedWith[].agentCount`, a field nothing in this package read before now — so a
 * private workspace could be encrypted to nobody and look exactly like one encrypted to everybody.
 */
export function unreachedRecipients(publishResponse: unknown): readonly string[] {
  const r = (publishResponse ?? {}) as { sharedWith?: readonly { handle?: string; agentCount?: number }[] };
  if (!Array.isArray(r.sharedWith)) return [];
  return r.sharedWith.filter((x) => (x?.agentCount ?? 0) === 0).map((x) => String(x?.handle ?? 'an unnamed handle'));
}
