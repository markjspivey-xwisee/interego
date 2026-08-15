/**
 * WHICH DOCUMENTS A PRIVATE WORKSPACE MAY ENCRYPT, AND WHICH IT MUST NOT.
 *
 * ── ★★ TWO OF THESE ARE NOT A PREFERENCE ────────────────────────────────────
 *
 * Encrypting the SHACL shape contract locks a workspace out of itself, permanently, including the
 * convener. The chain is mechanical and every link is in this repository:
 *
 *   1. every workspace write passes the shape IRI as `conforms_to_shapes`
 *   2. the relay fetches that shape's BODY by a plain HTTP GET on its `/ns` IRI
 *   3. `/ns` answers 409 for an encrypted graph
 *   4. the conformance gate fails closed — a shape it cannot read is a shape nothing conforms to
 *
 * So the first encrypted shape makes every subsequent write to that workspace a 422, with no way
 * back: the fix would itself be a write. The role profile is the same story through
 * `fetchProfileTurtle`, and the Discord bot refuses to seat anybody when it does not resolve.
 *
 * These two are therefore PUBLIC-ALWAYS, and this function is the one place that says so. A
 * per-call-site `visibility:` literal is exactly how one of them eventually gets flipped by
 * somebody doing a careful global replace.
 *
 * ── ★★ AND SO ARE GRANTS AND ACCEPTANCES, FOR A DIFFERENT REASON ────────────
 *
 * The roster is how a member discovers who to encrypt TO. A roster readable only by people who can
 * already decrypt is circular, and sealing it unseats the very members it describes — see the note
 * on the branch below, and the defect it documents. `sendInvite`, `acceptGrant` and `revokeGrant`
 * already hardcoded `'public'`; this function disagreed with them, and only `createWorkspace`'s
 * founding pair went through here to find out.
 *
 * ── ★ AND OMITTING THE ARGUMENT MEANS ENCRYPT, WHICH IS THE TRAP ────────────
 *
 * `computePublishRecipients` treats any value that is not `public`/`private`/`shared` — INCLUDING
 * undefined — as `'shared'`. So a refactor that drops a `visibility:` argument does not fall back
 * to the old behaviour; it silently starts encrypting. Every publish in this package passes an
 * explicit value, and it comes from here.
 */

/** The kinds of document a workspace is made of, for the purpose of deciding visibility. */
export type WorkspaceDoc =
  /** The SHACL shape contract. Public always — see the header. */
  | 'shape'
  /** The role profile. Public always — see the header. */
  | 'roles'
  /** The workspace record itself. */
  | 'record'
  /** A membership grant, or its revocation. */
  | 'grant'
  /** A member's acceptance of a grant. */
  | 'acceptance'
  /** One entry in the channel — what people actually say. */
  | 'entry'
  /** The shared canvas document. */
  | 'canvas';

/** What a workspace declares about itself. */
export type WorkspaceVisibility = 'public' | 'private';

/**
 * The `visibility` value to publish one document with.
 *
 * ★ 'shared' RATHER THAN 'private' FOR THE ENCRYPTED CASE, and the difference is not cosmetic.
 * `computePublishRecipients` treats `'private'` as "encrypt to the AUTHOR alone" and DROPS any
 * `share_with` with a warning — so a workspace published `'private'` would be readable by its
 * convener and by nobody else, which is not a shared workspace. `'shared'` is the only value that
 * unions the author with a recipient list.
 */
export function visibilityFor(doc: WorkspaceDoc, workspace: WorkspaceVisibility): 'public' | 'shared' {
  if (doc === 'shape' || doc === 'roles') return 'public';
  /**
   * ── ★★ GRANTS AND ACCEPTANCES ARE PUBLIC-ALWAYS TOO, AND THIS WAS WRONG ─────
   *
   * This mapped them to `'shared'`, which disagreed with the code that actually writes them:
   * `sendInvite`, `acceptGrant` and `revokeGrant` all hardcode `visibility: 'public'`. Only
   * `createWorkspace`'s founding pair went through this function — so in a PRIVATE workspace the
   * convener's own grant and acceptance were sealed to the convener alone, and every other
   * member's client then:
   *
   *   · read them, could not open them, and `foldRoster` reported "the signed region of this
   *     grant could not be located" — the accusation-of-unsignedness this vertical forbids making
   *     about a merely-encrypted record;
   *   · marked the convener NOT SEATED, so the convener vanished from everyone else's roster and
   *     their stream was never read — the channel looked empty;
   *   · and `recipientsFromRoster` filters on `seated` BEFORE it checks `grantedTo`, so the
   *     convener was dropped from every recipient list without landing in `missing` and without
   *     any refusal. Nobody encrypted to them, and `unreached` was empty because they were never
   *     named.
   *
   * Only the convener's own screen looked correct.
   *
   * ★ AND PUBLIC IS THE RIGHT ANSWER, not merely the consistent one. The roster is how a member
   * discovers who to encrypt to; a roster readable only by people who can already decrypt is
   * circular. `wsp:visibility` says in as many words that private hides the WORDS and not the
   * membership, the timestamps, or who wrote when — and `recipients.ts` builds its whole recipient
   * list out of these documents' `grantedTo` WebIDs.
   */
  if (doc === 'grant' || doc === 'acceptance') return 'public';
  return workspace === 'private' ? 'shared' : 'public';
}

/** True when this document class can never be encrypted, whatever the workspace says. */
export function alwaysPublic(doc: WorkspaceDoc): boolean {
  return visibilityFor(doc, 'private') === 'public';
}
