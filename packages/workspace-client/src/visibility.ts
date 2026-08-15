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
  return workspace === 'private' ? 'shared' : 'public';
}

/** True when this document class can never be encrypted, whatever the workspace says. */
export function alwaysPublic(doc: WorkspaceDoc): boolean {
  return visibilityFor(doc, 'private') === 'public';
}
