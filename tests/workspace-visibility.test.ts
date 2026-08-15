/**
 * WHICH DOCUMENTS A PRIVATE WORKSPACE MAY ENCRYPT.
 *
 * Two of these are not a preference, and getting one wrong is unrecoverable rather than merely
 * wrong: encrypting a workspace's SHACL shape contract makes every subsequent write to that
 * workspace a 422, including the convener's, and the fix would itself be a write. The chain is
 * mechanical — every write passes the shape as `conforms_to_shapes`, the relay fetches its body
 * over plain HTTP from `/ns`, `/ns` answers 409 for an encrypted graph, and the conformance gate
 * fails closed.
 *
 * So this is the one place that decides, and these are the tests that keep it deciding correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  visibilityFor, alwaysPublic, type WorkspaceDoc,
} from '../packages/workspace-client/src/visibility.js';

const ALL: readonly WorkspaceDoc[] = ['shape', 'roles', 'record', 'grant', 'acceptance', 'entry', 'canvas'];

describe('★★ the two documents that must never be encrypted', () => {
  it('the shape contract stays public even when the workspace is private', () => {
    // Encrypt this one and the workspace refuses every subsequent write — permanently.
    expect(visibilityFor('shape', 'private')).toBe('public');
    expect(alwaysPublic('shape')).toBe(true);
  });

  it('the role profile stays public too', () => {
    // Read through `fetchProfileTurtle` on the same 409-ing `/ns` route; the bot refuses to seat
    // anybody when it does not resolve.
    expect(visibilityFor('roles', 'private')).toBe('public');
    expect(alwaysPublic('roles')).toBe(true);
  });

  it('★★ the membership documents stay public too, or the roster unseats the people in it', () => {
    /**
     * ── WHY THIS CHANGED, AND WHAT THE OLD ASSERTION WAS HIDING ───────────────
     *
     * This file used to assert grants and acceptances were ENCRYPTED in a private workspace. That
     * was the intent, and it was wrong twice over:
     *
     *  · It disagreed with the code. `sendInvite`, `acceptGrant` and `revokeGrant` all hardcode
     *    `visibility: 'public'`. Only `createWorkspace`'s founding pair reached this function, so
     *    the convener's own grant and acceptance were the ONLY sealed membership documents in the
     *    system — an inconsistency no test could see, because the three hardcoded writers never
     *    call this.
     *  · And sealing them is self-defeating. Measured live: B folds the roster, cannot open A's
     *    founding grant, `foldRoster` reports "the signed region of this grant could not be
     *    located", A comes back NOT SEATED with a null pod — so the convener vanishes from every
     *    other member's roster, their stream is never read, and `recipientsFromRoster` drops them
     *    from every recipient list without any refusal. Only the convener's own screen looked
     *    right.
     *
     * The roster is how a member discovers who to encrypt TO. A roster readable only by those who
     * can already decrypt is circular.
     */
    expect(visibilityFor('grant', 'private')).toBe('public');
    expect(visibilityFor('acceptance', 'private')).toBe('public');
    expect(alwaysPublic('grant')).toBe(true);
    expect(alwaysPublic('acceptance')).toBe(true);
  });

  it('★ and nothing else claims to be always-public, which would silently leak a private channel', () => {
    // The opposite failure: quietly exempting ENTRIES would publish the words in the clear while
    // the record said private. Stated as an exact set so adding an exemption is a deliberate edit.
    // `record`, `entry` and `canvas` — the three that carry what people actually wrote — are the
    // ones that must never appear here.
    expect(ALL.filter(alwaysPublic)).toEqual(['shape', 'roles', 'grant', 'acceptance']);
    for (const doc of ['record', 'entry', 'canvas'] as const) expect(alwaysPublic(doc)).toBe(false);
  });
});

describe('everything else follows the workspace', () => {
  it('a public workspace publishes everything in the clear, exactly as today', () => {
    for (const doc of ALL) expect(visibilityFor(doc, 'public')).toBe('public');
  });

  it('★ a private workspace encrypts the record, the entries and the canvas — what was actually written', () => {
    // Grants and acceptances are NOT in this list any more; see the membership-documents case
    // above for the defect that removed them.
    for (const doc of ['record', 'entry', 'canvas'] as const) {
      expect(visibilityFor(doc, 'private')).toBe('shared');
    }
  });

  it('★★ and it is "shared", never "private" — the relay treats those very differently', () => {
    /**
     * `computePublishRecipients` reads `'private'` as "encrypt to the AUTHOR alone" and DROPS any
     * `share_with` with a warning. A workspace published that way would be readable by its
     * convener and by nobody else — which is not a shared workspace, it is a diary. `'shared'` is
     * the only value that unions the author with a recipient list.
     */
    for (const doc of ALL) expect(visibilityFor(doc, 'private')).not.toBe('private');
  });
});
