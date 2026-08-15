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
