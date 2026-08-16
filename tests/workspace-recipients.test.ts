/**
 * WHO A PRIVATE WORKSPACE IS ENCRYPTED TO, AND THE TWO WAYS IT SILENTLY IS NOT.
 *
 * Both failures here succeed. A publish encrypted to nobody returns 200, writes a descriptor, and
 * looks exactly like one encrypted to everybody — the difference only shows up later, as a channel
 * that reads as empty for people who are seated in it. So these are pinned as tests rather than
 * left to be noticed.
 */

import { describe, it, expect } from 'vitest';
import { recipientsFromRoster, unreachedRecipients } from '../packages/workspace-client/src/recipients.js';
import type { Seat } from '../packages/workspace-client/src/seats.js';

const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const seat = (pod: string, over: Partial<Seat> = {}): Seat => ({
  graph: 'urn:graph:' + pod, grantUrl: null, grantCid: null, role: 'Contributor',
  grantedTo: WEBID(pod), pod, seated: true, why: null, ...over,
} as Seat);

describe('recipients come from the roster', () => {
  it('uses each seated member\'s WebID', () => {
    const plan = recipientsFromRoster({ seats: [seat('u-a'), seat('u-b')], grantsFound: 2, grantsRead: 2 });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.shareWith).toEqual([WEBID('u-a'), WEBID('u-b')]);
  });

  it('skips a revoked or unseated row', () => {
    const plan = recipientsFromRoster({
      seats: [seat('u-a'), seat('u-b', { revoked: true }), seat('u-c', { seated: false, why: 'never accepted' })],
      grantsFound: 3, grantsRead: 3,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.shareWith).toEqual([WEBID('u-a')]);
  });

  it('★★ REFUSES a truncated roster rather than encrypting to a subset', () => {
    /**
     * `foldRoster` reads at most GRANT_READ_CAP grants. Encrypting to what it managed to read
     * locks the members it missed out of a conversation they are seated in — permanently, since
     * the envelope's recipient set is fixed at write time, and with no error anywhere.
     */
    const plan = recipientsFromRoster({ seats: [seat('u-a')], grantsFound: 40, grantsRead: 25 });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.why).toContain('roster is incomplete');
      expect(plan.why).toContain('Nothing was written');
    }
  });

  it('★ refuses when a seated member carries no resolvable WebID', () => {
    const plan = recipientsFromRoster({
      seats: [seat('u-a'), seat('u-b', { grantedTo: null })], grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toContain('no WebID');
  });

  it('★ and refuses a private write that would reach nobody at all', () => {
    const plan = recipientsFromRoster({ seats: [], grantsFound: 0, grantsRead: 0 });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toContain('readable by nobody');
  });
});

describe('★★ the keys a client seals to itself', () => {
  /**
   * ── WHY THESE ARE NOT JUST `shareWith` BY ANOTHER NAME ──────────────────────
   *
   * `shareWith` is WebIDs handed to the RELAY, which resolves each to a pod and reads that pod's
   * agent registry for keys. That path cannot be end-to-end — the relay chooses the keys, and adds
   * its own besides. `keys` is what a publisher seals to ITSELF, read from each member's own
   * acceptance, so the relay neither chooses nor appears.
   */
  const withKey = (pod: string, key: string | null): Seat =>
    seat(pod, key === null ? {} : { encryptionKey: key } as Partial<Seat>);

  it('collects each seated member\'s key from their own acceptance', () => {
    const plan = recipientsFromRoster({
      seats: [withKey('u-a', 'KEY-A'), withKey('u-b', 'KEY-B')], grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.keys).toEqual(['KEY-A', 'KEY-B']);
      expect(plan.keysMissing).toEqual([]);
    }
  });

  it('★★ withholds the WHOLE list when any seated member published no key', () => {
    /**
     * Not "the subset that has one". Sealing to a subset locks the rest out permanently and
     * silently — the failure this file exists for — so the caller gets nothing to seal with and
     * the names of who is missing, and has to decide in the open.
     */
    const plan = recipientsFromRoster({
      seats: [withKey('u-a', 'KEY-A'), withKey('u-b', null)], grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.keys, 'a partial key list is the silent lockout').toEqual([]);
      expect(plan.keysMissing).toEqual(['u-b']);
      // ★ And `shareWith` is UNAFFECTED: the relay-sealed path still works for this roster, which
      // is what a workspace whose members have not all upgraded still runs on.
      expect(plan.shareWith).toHaveLength(2);
    }
  });

  it('★ a revoked member contributes no key, exactly as they contribute no WebID', () => {
    const plan = recipientsFromRoster({
      seats: [withKey('u-a', 'KEY-A'), seat('u-b', { revoked: true, encryptionKey: 'KEY-B' } as Partial<Seat>)],
      grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.keys).toEqual(['KEY-A']);
      expect(plan.keysMissing).toEqual([]);
    }
  });
});

describe('★★ people who hold a grant but have not accepted yet', () => {
  /**
   * ── THE EVICTION THIS PREVENTS ──────────────────────────────────────────────
   *
   * Re-sealing the workspace record REPLACES its recipient set. Invite B, then invite C before B
   * has opened their client, and a recipient list built only from SEATED members re-seals to
   * {A, C} — dropping B from the record they must read in order to verify the grant written for
   * them. Nothing warns: the roster still shows B as "granted, not accepted", every named
   * recipient resolves, and B's client then refuses B's own invitation with "this identity is not
   * among them". With N outstanding invitations only the most recent could ever be accepted.
   */
  const pendingSeat = (pod: string): Seat =>
    seat(pod, { seated: false, pending: true, why: 'granted, but no acceptance published on their pod yet' } as Partial<Seat>);

  it('are reported separately from the seated ones', () => {
    const plan = recipientsFromRoster({
      seats: [seat('u-a'), pendingSeat('u-b')], grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // ★ NOT in shareWith: an entry is for the people IN the conversation, and somebody who has not
    // accepted is not one of them yet.
    expect(plan.shareWith).toEqual([WEBID('u-a')]);
    // ★ But named, so a RESEAL can include them.
    expect(plan.pendingWebIds).toEqual([WEBID('u-b')]);
  });

  it('★ a revoked grantee is not pending, they are gone', () => {
    const plan = recipientsFromRoster({
      seats: [seat('u-a'), seat('u-b', { seated: false, pending: true, revoked: true } as Partial<Seat>)],
      grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.pendingWebIds).toEqual([]);
  });

  it('★ and an unseated row that is NOT pending is not either — it never got a grant it could accept', () => {
    // `pending` is set only when the acceptance was genuinely absent, never when the read FAILED.
    // A row whose acceptance could not be resolved is unknown, not waiting, and re-sealing to
    // somebody on the strength of a failed read would be guessing.
    const plan = recipientsFromRoster({
      seats: [seat('u-a'), seat('u-b', { seated: false, why: 'their acceptance could not be resolved: 502' } as Partial<Seat>)],
      grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.pendingWebIds).toEqual([]);
  });
});

describe('★★ what the relay actually reached', () => {
  it('reports a handle that resolved to zero recipients', () => {
    /**
     * The silent failure this exists for: `resolveRecipient` returns an EMPTY key list rather than
     * an error when a handle does not resolve or a pod registers no encryption key, and the
     * publish then succeeds having encrypted to nobody. `agentCount` is the only evidence, and
     * nothing in this package read it before.
     */
    const unreached = unreachedRecipients({
      sharedWith: [
        { handle: WEBID('u-a'), agentCount: 1 },
        { handle: 'acct:u-b@relay.interego.xwisee.com', agentCount: 0 },
      ],
    });
    expect(unreached).toEqual(['acct:u-b@relay.interego.xwisee.com']);
  });

  it('says nothing when every handle resolved', () => {
    expect(unreachedRecipients({ sharedWith: [{ handle: WEBID('u-a'), agentCount: 2 }] })).toEqual([]);
  });

  it('★ and treats a response with no sharedWith as nothing to report, not as a failure', () => {
    // A public publish carries no `sharedWith`. Reading that as "everybody unreachable" would
    // refuse every ordinary write in the system.
    expect(unreachedRecipients({})).toEqual([]);
    expect(unreachedRecipients(null)).toEqual([]);
  });
});
