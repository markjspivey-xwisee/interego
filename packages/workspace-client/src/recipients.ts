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
  | { readonly ok: true; readonly shareWith: readonly string[]; readonly seats: number }
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
  const handles: string[] = [];
  const missing: string[] = [];
  for (const s of seated) {
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
  return { ok: true, shareWith: handles, seats: seated.length };
}

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
  visibility: 'public' | 'private' | undefined,
  roster: { readonly seats: readonly Seat[]; readonly grantsFound: number; readonly grantsRead: number } | null,
): { readonly ok: true; readonly shareWith: readonly string[] | undefined } | { readonly ok: false; readonly why: string } {
  if (visibility !== 'private') return { ok: true, shareWith: undefined };
  if (!roster) {
    return {
      ok: false,
      why: 'this workspace is private and its roster has not been read here, so there is no way to tell who '
        + 'this should be encrypted to. Open the workspace and let the members list load first. Nothing was written.',
    };
  }
  const plan = recipientsFromRoster(roster);
  return plan.ok ? { ok: true, shareWith: plan.shareWith } : { ok: false, why: plan.why };
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
