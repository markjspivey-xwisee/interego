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

  it('★ and nothing else claims to be always-public, which would silently leak a private channel', () => {
    // The opposite failure: quietly exempting entries would publish the words in the clear while
    // the record said private. Stated as an exact set so adding an exemption is a deliberate edit.
    expect(ALL.filter(alwaysPublic)).toEqual(['shape', 'roles']);
  });
});

describe('everything else follows the workspace', () => {
  it('a public workspace publishes everything in the clear, exactly as today', () => {
    for (const doc of ALL) expect(visibilityFor(doc, 'public')).toBe('public');
  });

  it('★ a private workspace encrypts the record, grants, acceptances, entries and canvas', () => {
    for (const doc of ['record', 'grant', 'acceptance', 'entry', 'canvas'] as const) {
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
