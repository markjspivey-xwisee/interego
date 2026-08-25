/**
 * WHO A PRIVATE WORKSPACE IS ENCRYPTED TO, AND THE TWO WAYS IT SILENTLY IS NOT.
 *
 * Both failures here succeed. A publish encrypted to nobody returns 200, writes a descriptor, and
 * looks exactly like one encrypted to everybody — the difference only shows up later, as a channel
 * that reads as empty for people who are seated in it. So these are pinned as tests rather than
 * left to be noticed.
 */

import { describe, it, expect } from 'vitest';
import { recipientsFromRoster, recipientsFor, unreachedRecipients, recipientReach } from '../packages/workspace-client/src/recipients.js';
import { foldRoster, podOfGrantGraph, unreadGrants } from '../packages/workspace-client/src/seats.js';
import { sendInvite } from '../packages/workspace-client/src/membership.js';
import { WorkspaceClient } from '../packages/workspace-client/src/substrate.js';
import type { RosterFold, Seat, UnreadGrant } from '../packages/workspace-client/src/seats.js';

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

  it('skips a revoked row and one somebody ANSWERED, and carries an unclassified one', () => {
    /**
     * ★ THE THIRD ROW USED TO SAY `seated: false` AND NOTHING ELSE, AND THAT WAS THE DEFECT.
     * `seated: false` is produced by an authoritative answer AND by every read the fold could not
     * complete, so a row carrying only that says which of the two only by accident. `basis` is
     * what says it, and a hand-built row that omits it reads as `'unestablished'` — the side that
     * refuses to drop somebody — so expressing "they are out" now takes stating it.
     */
    const plan = recipientsFromRoster({
      seats: [
        seat('u-a'),
        seat('u-b', { revoked: true }),
        seat('u-c', { seated: false, basis: 'answered', why: 'never accepted' }),
        seat('u-d', { seated: false, why: 'nobody said' }),
      ],
      grantsFound: 4, grantsRead: 4,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.shareWith).toEqual([WEBID('u-a'), WEBID('u-d')]);
    expect(plan.unestablishedWebIds).toEqual([WEBID('u-d')]);
  });

  it('★★ CARRIES a truncated roster rather than refusing over it — the verb decides', () => {
    /**
     * ── WHAT MOVED, AND WHY THE ASSERTION IS THE OPPOSITE OF WHAT IT WAS ────────
     *
     * This used to be the whole guard: `grantsFound > grantsRead` -> `ok: false`, computed before
     * every other branch, returned to every caller of every verb. Measured, it was an outage —
     * `recipientsFor` is the single join for entries, canvas saves, canvas merges and invitations,
     * three of the four ways a grant goes unread are PERMANENT, and the one act that repairs a
     * permanently unreadable grant is an invitation. One forked grant took a workspace read-only
     * for everybody, for good, under a sentence telling them to try again.
     *
     * So the shortfall is carried, not judged, and `recipientsFor` applies the policy the verb
     * earns. The four rows of that table are pinned in their own block below.
     */
    const plan = recipientsFromRoster({ seats: [seat('u-a')], grantsFound: 40, grantsRead: 25 });
    expect(plan.ok, 'the audience builder still refuses over a count').toBe(true);
    if (!plan.ok) return;
    expect(plan.shareWith).toEqual([WEBID('u-a')]);
    // 15 rows, because the counters say 15 are missing and no fold named them.
    expect(plan.partial).toHaveLength(15);
    expect(plan.partial.every((u) => u.kind === 'unknown' && u.pod === null)).toBe(true);
  });

  it('★ refuses when a seated member carries no resolvable WebID', () => {
    // The one refusal left in the audience builder, and the one the census rated correct: this row
    // is not a gap in the roster, it is a contradiction in it — somebody the fold seated and
    // cannot address.
    const plan = recipientsFromRoster({
      seats: [seat('u-a'), seat('u-b', { grantedTo: null })], grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.why).toContain('no WebID');
  });

  it('★★ an empty audience is not refused HERE any more, because the reseal does not use it', () => {
    /**
     * ── THE INVITE PATH THIS UNBLOCKED ─────────────────────────────────────────
     *
     * "no seated member of this workspace resolves to an encryption address" was computed from the
     * SEATED set and answered every caller. But `sendInvite` never uses `shareWith` for its own
     * document — the grant it writes is public — and what its reseal needs is
     * `shareWith ∪ pendingWebIds ∪ grantedWebIds ∪ the invitee`. So a private workspace whose
     * seated set is empty (a convener whose own acceptance was retracted; every other member still
     * pending) had a perfectly good reseal audience and could invite nobody.
     */
    const plan = recipientsFromRoster({ seats: [], grantsFound: 0, grantsRead: 0 });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.shareWith).toEqual([]);
    // And the question it was right about is still asked, by the verbs that have it — with the
    // claim corrected: `'shared'` unions the AUTHOR with the recipient list, so an empty list is a
    // conversation with one participant rather than a document nobody can open.
    const entry = recipientsFor('entry', 'private', { seats: [], grantsFound: 0, grantsRead: 0 });
    expect(entry.ok).toBe(false);
    if (!entry.ok) {
      expect(entry.why).toContain('readable by nobody but you');
      // Nothing about this shortfall could clear: there is no shortfall, the roster is just empty.
      expect(entry.retryable).toBe(false);
    }
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

  /**
   * ── ★★ AND "NOTHING WAS REPORTED" IS NOT "EVERYBODY WAS REACHED" ───────────
   *
   * The line above is the right answer for the projection and the WRONG answer for a gate, and
   * `sendInvite` used it as a gate: `recordUnreached.indexOf(who.webId) >= 0`, before writing a
   * grant, over a list that is empty both when everyone resolved and when the relay said nothing
   * at all. The function's own docblock called itself THE ONLY EVIDENCE THAT A RECIPIENT WAS
   * REACHED and answered "everybody was" from none.
   */
  it('★★ recipientReach separates "the relay said nothing" from "the relay said everyone"', () => {
    const silent = recipientReach({});
    expect(silent.established, 'no per-handle resolution is not an answer about anybody').toBe(false);
    expect(silent.why).toContain('not established');
    expect(silent.named).toEqual([]);

    const spoke = recipientReach({ sharedWith: [{ handle: WEBID('u-a'), agentCount: 2 }] });
    expect(spoke.established).toBe(true);
    expect(spoke.unreached).toEqual([]);
    expect(spoke.named).toEqual([WEBID('u-a')]);
    expect(spoke.why).toBeNull();
  });

  it('★★ and a handle echoed with NO agentCount is unstated, not a stated zero', () => {
    /**
     * `agentCount` is optional in the relay's published output schema
     * (`deploy/mcp-relay/server.ts`, the `sharedWith` items block lists it as a property and
     * requires nothing). `(x?.agentCount ?? 0) === 0` therefore reported "the relay resolved no
     * agent for them" about a relay that had reported nothing about them — a false statement in
     * shipped user-facing copy, and one the invite gate would have refused on.
     */
    const r = recipientReach({
      sharedWith: [
        { handle: WEBID('u-a'), agentCount: 0 },
        { handle: WEBID('u-b') },
        { handle: WEBID('u-c'), agentCount: 3 },
      ],
    });
    expect(r.established).toBe(true);
    expect(r.unreached, 'only a STATED zero is a statement that nobody was resolved').toEqual([WEBID('u-a')]);
    expect(r.unstated).toEqual([WEBID('u-b')]);
    expect(r.named).toEqual([WEBID('u-a'), WEBID('u-b'), WEBID('u-c')]);
    // The projection reports the stated half only, which is what the two writers that merely
    // REPORT it want. The three-state answer is for the one caller that gates on it.
    expect(unreachedRecipients({ sharedWith: [{ handle: WEBID('u-b') }] })).toEqual([]);
  });
});

describe('★★ everybody a standing grant names, whatever their acceptance says', () => {
  /**
   * ── THE ONE-WAY DOOR THIS CLOSES ────────────────────────────────────────────
   *
   * `pending` is set only when the acceptance was genuinely ABSENT, never when the read failed —
   * and that rule is right, because "waiting to accept" would otherwise be a claim about
   * somebody's pod made from a read that established nothing. The block above pins it.
   *
   * But a reseal is not asking about acceptances. It asks who must be able to READ THE RECORD, and
   * between those two questions sat a whole population: the member whose acceptance pins a grant
   * revision the convener has since superseded, whose pod returned 502 while the roster was
   * folded, whose acceptance chain is forked. Each is `seated: false` and `pending: false`, so
   * each was dropped by the next reseal — from the very document `verifyGrantIri` reads. They
   * then cannot accept, cannot re-accept, and cannot be told why.
   *
   * ★ AND NOBODY REVOKED THEM. It is triggered by a transient 502 during somebody ELSE's
   * invitation, and the roster goes on showing only why their seat did not fold.
   */
  const seatedRow = (pod: string): Seat => seat(pod);

  it('★ includes a member whose acceptance could not be READ — the case `pending` excludes', () => {
    const plan = recipientsFromRoster({
      seats: [
        seatedRow('u-a'),
        // A read that did not complete, and a conclusion drawn from bytes that were read. The two
        // rows are spelled apart by `basis` because that is the only thing that tells them apart.
        seat('u-b', { seated: false, basis: 'unestablished', why: 'their acceptance could not be resolved: 502' } as Partial<Seat>),
        seat('u-c', { seated: false, basis: 'answered', why: 'their acceptance pins revision cid-1, and the head is cid-2' } as Partial<Seat>),
      ],
      grantsFound: 3, grantsRead: 3,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // ★ THE 502'd ROW IS IN THE ENVELOPE and the stale-pin row is not: nothing may exclude
    // somebody on a read that established nothing, and a stale pin is an answer somebody's own
    // bytes gave. Neither is `pending` — that word is reserved for an absence the relay stated.
    expect(plan.shareWith).toEqual([WEBID('u-a'), WEBID('u-b')]);
    expect(plan.unestablishedWebIds).toEqual([WEBID('u-b')]);
    expect(plan.pendingWebIds).toEqual([]);
    // ★ THE LOAD-BEARING ASSERTION. Both still hold a grant nobody withdrew, so both must keep
    // the record — or the next invitation locks them out of this workspace for good.
    expect(plan.grantedWebIds, 'a member whose acceptance merely could not be read was dropped from the reseal')
      .toEqual([WEBID('u-a'), WEBID('u-b'), WEBID('u-c')]);
  });

  it('excludes a revoked grant — that is a withdrawal, by the person entitled to make it', () => {
    const plan = recipientsFromRoster({
      seats: [seatedRow('u-a'), seat('u-b', { seated: false, revoked: true } as Partial<Seat>)],
      grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.grantedWebIds).toEqual([WEBID('u-a')]);
  });

  it('excludes a grant its own author retracted, and case does not decide it', () => {
    // `isRetracted` compares case-insensitively, and that is what set `grantStatus`. A status
    // differing only in case must not be a withdrawal in one file and not one in the other.
    const plan = recipientsFromRoster({
      seats: [
        seatedRow('u-a'),
        seat('u-b', { seated: false, grantStatus: 'Retracted' } as Partial<Seat>),
        seat('u-c', { seated: false, grantStatus: 'retracted' } as Partial<Seat>),
      ],
      grantsFound: 3, grantsRead: 3,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.grantedWebIds).toEqual([WEBID('u-a')]);
  });

  it('★★ leaves a row whose grant named no readable grantee OUT of the audience, and does NOT refuse over it', () => {
    /**
     * ── WHY THIS ASSERTION HAS MOVED TWICE, AND WHERE IT LANDED ───────────
     *
     * It first pinned the row as simply ABSENT from `grantedWebIds`. A round of the eviction fix
     * then made the plan REFUSE over it, reasoning that absence from all three lists is what the
     * next reseal turns into a lockout. That refusal is gone and the absence is pinned again, for
     * two reasons that were measured rather than argued:
     *
     *  · IT WAS A CHANNEL-WIDE FAIL-CLOSED WITH NO EXIT. `recipientsFor` is the one join every
     *    entry, canvas save and invite passes through, so a single such row refused every write in
     *    the workspace for as long as it existed — and neither way out the refusal named exists:
     *    `revokeGrant` returns `{kind:'incomplete'}` for exactly `!grantedTo`, and nothing in this
     *    package writes `iep:modalStatus "Retracted"` onto a grant.
     *  · IT FIRED ON CORRECT RDF. `grantedTo === null` is not a fact about the grant; it is
     *    `readIri` matching neither spelling it knows. The fold-driven cases at the bottom of this
     *    file produce it from grants whose triples are all correct.
     *
     * ★ AND THE ABSENCE IS SAFE HERE IN A WAY IT IS NOT FOR THE REST OF `grantedWebIds`.
     * Accepting runs through `verifyGrantIri`, which reads the grantee with THIS SAME reader and
     * refuses at "the grant names no wsp:grantedTo" before it ever reaches the record — so the
     * holder of this grant could not have accepted it with the record in hand either. It becomes
     * acceptable only once the grant is rewritten to name them, and the only call that rewrites a
     * grant that way is `sendInvite`, which re-seals the record to them first.
     */
    const plan = recipientsFromRoster({
      seats: [seatedRow('u-a'), seat('u-b', { seated: false, grantedTo: null, why: 'no wsp:grantedTo was read out of the signed region' } as Partial<Seat>)],
      grantsFound: 2, grantsRead: 2,
    });
    expect(plan.ok, 'a grant with no readable grantee held the whole workspace shut').toBe(true);
    if (plan.ok) {
      // There is no address to put in the list, and inventing one would be this client deciding
      // who the grant names.
      expect(plan.grantedWebIds).toEqual([WEBID('u-a')]);
      expect(plan.shareWith).toEqual([WEBID('u-a')]);
      expect(plan.pendingWebIds).toEqual([]);
    }
  });

  it('★ and the same for a revoked or retracted row that names nobody — those are answers, not holes', () => {
    // A withdrawal is stated by somebody entitled to state it, so a withdrawn grant is out of the
    // audience on purpose. Kept as its own case because the three exclusions have three different
    // reasons and a filter that collapsed them would still pass the test above.
    const plan = recipientsFromRoster({
      seats: [
        seatedRow('u-a'),
        seat('u-b', { seated: false, grantedTo: null, revoked: true } as Partial<Seat>),
        seat('u-c', { seated: false, grantedTo: null, grantStatus: 'Retracted' } as Partial<Seat>),
        seat('u-d', { seated: false, grantedTo: null, grantStatus: 'retracted' } as Partial<Seat>),
      ],
      grantsFound: 4, grantsRead: 4,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.grantedWebIds).toEqual([WEBID('u-a')]);
  });

  it('★★ so the READ COUNT is the only thing between a failed read and a RESEAL, and it is not belt-and-braces', () => {
    /**
     * ★ THE REASON THE BOUNDARY SUITE BELOW EXISTS. There used to be a second guard here that
     * caught a row with no grantee whatever the count said, and while it stood, `grantsRead`
     * regressing to the number of grants ATTEMPTED was invisible — the write refused anyway, for
     * the wrong reason. It is gone, so a fold that counts attempts re-seals: this is that state,
     * spelled out, and every exit of the counter is pinned against a real fold at the bottom.
     *
     * ★ IT IS THE RESEAL THAT ASKS, NOT EVERY WRITE. An entry supersedes nothing and cannot evict,
     * so the honest count below stops the one write whose omission costs somebody their
     * membership, and no others. That is the whole of the per-verb change, in two lines.
     */
    const seats = [seatedRow('u-a'), seat('u-b', { seated: false, grantedTo: null } as Partial<Seat>)];
    // Honest count, and nothing said which grant went unread — so it might still clear, and the
    // one write that can evict waits.
    expect(recipientsFor('reseal', 'private', { seats, grantsFound: 2, grantsRead: 1 }).ok).toBe(false);
    // The same roster with the count restored to attempts: nothing stops the reseal.
    expect(recipientsFor('reseal', 'private', { seats, grantsFound: 2, grantsRead: 2 }).ok).toBe(true);
    // And the entry goes out either way, which it could not before.
    expect(recipientsFor('entry', 'private', { seats, grantsFound: 2, grantsRead: 1 }).ok).toBe(true);
  });
});

describe('★★ grants ATTEMPTED are not grants read', () => {
  /**
   * ── THE COUNT THE REFUSAL AT THE TOP OF THE PLAN RESTS ON ───────────────────
   *
   * Everything above builds a plan from seats handed to it. This drives the real `foldRoster`
   * against a relay, because the number it reports is what decides whether the truncation refusal
   * can fire at all — and it used to report `toRead.length`, the count of grants the fold REACHED
   * FOR. `grantsFound > grantsRead` was then false however many of those reads had failed, so the
   * one completeness guard in the system was unreachable by the failure it was written for.
   *
   * Measured, and reproduced twice independently: three grants on the convener's pod, with
   * `get_descriptor` answering 502 for exactly one of them. `grantsFound 3 / grantsRead 3`, plan
   * `ok: true`, and the 502'd member simply gone from `share_with` on the bytes that were
   * published — dropped from the record `verifyGrantIri` reads, so they could never accept again,
   * by an operation carried out on somebody else's behalf.
   */
  const RELAY = 'https://relay.example';
  const CONV = 'u-conv';
  const SLUG = 'room';
  const WS = RELAY + '/ns/' + CONV + '/' + SLUG;
  const grantIri = (pod: string): string => WS + '-grant-' + pod;
  const acceptIri = (pod: string): string => RELAY + '/ns/' + pod + '/' + CONV + '--' + SLUG + '-acceptance';
  const streamIri = (pod: string): string => RELAY + '/ns/' + pod + '/' + CONV + '--' + SLUG + '-stream';
  const PRE = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
    + '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n';

  const grantDoc = (pod: string, extra: string): string => PRE
    + '<' + grantIri(pod) + '> {\n<' + grantIri(pod) + '> a wsp:Grant ; wsp:workspace <' + WS + '> ;\n'
    + '  wsp:grantedTo <' + WEBID(pod) + '> ; wsp:role <' + WS + '-roles#Contributor>' + extra + ' .\n}\n';

  /**
   * ★★ THE SAME TRIPLES, WITH THE wsp NAMESPACE BOUND TO THE PREFIX LABEL `w:`. Legal Turtle,
   * identical meaning, and `readIri` matches the literal `wsp:grantedTo` and the full IRI form
   * only — so this is what "correct RDF that reads as naming nobody" actually looks like. It is a
   * fixture rather than a hypothetical because a refusal keyed on `grantedTo === null` took a
   * whole workspace read-only over exactly this document.
   */
  const altPrefixDoc = (pod: string): string =>
    '@prefix w: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
    + '<' + grantIri(pod) + '> {\n<' + grantIri(pod) + '> a w:Grant ; w:workspace <' + WS + '> ;\n'
    + '  w:grantedTo <' + WEBID(pod) + '> ; w:role <' + WS + '-roles#Contributor> .\n}\n';

  /** The other legal spelling: the grantee written as a PrefixedName rather than an IRIREF. */
  const prefixedObjectDoc = (pod: string): string => PRE
    + '@prefix id: <https://identity.interego.xwisee.com/users/> .\n'
    + '<' + grantIri(pod) + '> {\n<' + grantIri(pod) + '> a wsp:Grant ; wsp:workspace <' + WS + '> ;\n'
    + '  wsp:grantedTo id:' + pod + ' ; wsp:role <' + WS + '-roles#Contributor> .\n}\n';

  /** A grantee this reader reads perfectly well and cannot map to a pod on this relay. */
  const didWebDoc = (pod: string): string => PRE
    + '<' + grantIri(pod) + '> {\n<' + grantIri(pod) + '> a wsp:Grant ; wsp:workspace <' + WS + '> ;\n'
    + '  wsp:grantedTo <did:web:example.com:' + pod + '> ; wsp:role <' + WS + '-roles#Contributor> .\n}\n';
  const acceptDoc = (pod: string): string => PRE
    + '<' + acceptIri(pod) + '> {\n<' + acceptIri(pod) + '> a wsp:Acceptance ; wsp:workspace <' + WS + '> ;\n'
    + '  wsp:accepts <' + grantIri(pod) + '> ; wsp:acceptsCid "cid-grant-' + pod + '" ;\n'
    + '  wsp:stream <' + streamIri(pod) + '> ; wsp:encryptionKey "KEY-' + pod + '" .\n}\n';

  /**
   * A relay serving one grant per pod from the convener's pod and one acceptance from each
   * member's own — plus a named set of grants whose descriptor answers the way a pod mid-redeploy
   * does: a RESOLVED body carrying `error`, which is the shape `client.descriptor` turns into a
   * throw and the shape this fleet actually returns.
   */
  const fleet = (pods: readonly string[], opts: {
    readonly unread?: readonly string[];
    readonly revoked?: readonly string[];
    readonly retracted?: readonly string[];
    readonly noAcceptance?: readonly string[];
    /** Enumerated by the scan with nothing published at that IRI — `get_current_head` says so. */
    readonly noGrantDoc?: readonly string[];
    /** `get_current_head` answers with an unresolved fork instead of a head. */
    readonly forked?: readonly string[];
    /**
     * The head resolves and carries an `error` instead of a CID — the shape a pod mid-redeploy
     * returns. `RelayClient.currentHead` surfaces it as `headError` on an otherwise readable head.
     */
    readonly headError?: readonly string[];
    /**
     * `get_current_head` answers with neither a head NOR a message — the one shape the relay
     * client reserves for `unreadable`, which establishes nothing about the pod.
     */
    readonly headSilent?: readonly string[];
    /** The descriptor is served and the block inside it is named something else. */
    readonly misfiled?: readonly string[];
    /** A grant document written some other legal way — see the three writers above. */
    readonly doc?: Readonly<Record<string, (pod: string) => string>>;
  } = {}): WorkspaceClient => {
    const has = (l: readonly string[] | undefined, p: string): boolean => (l ?? []).indexOf(p) >= 0;
    const store = new Map<string, { url: string; cid: string; content: string }>();
    const forkedUrns = new Set<string>((opts.forked ?? []).map(grantIri));
    const errorUrns = new Set<string>((opts.headError ?? []).map(grantIri));
    const silentUrns = new Set<string>((opts.headSilent ?? []).map(grantIri));
    for (const p of pods) {
      const extra = (has(opts.revoked, p) ? ' ; wsp:revoked true' : '')
        + (has(opts.retracted, p) ? ' ; iep:modalStatus "Retracted"' : '');
      const write = opts.doc?.[p];
      const body = write ? write(p) : grantDoc(p, extra);
      if (!has(opts.noGrantDoc, p)) {
        store.set(grantIri(p), {
          url: 'http://css.internal:3456/' + CONV + '/context-graphs/grant-' + p + '.ttl',
          cid: 'cid-grant-' + p,
          // Misfiled: the bytes are served, and the block inside them is named something this
          // reader is not asking about, so `graphRegion` locates nothing.
          content: has(opts.misfiled, p)
            ? body.replace('<' + grantIri(p) + '> {', '<' + grantIri(p) + '-elsewhere> {')
            : body,
        });
      }
      if (has(opts.noAcceptance, p)) continue;
      store.set(acceptIri(p), {
        url: 'http://css.internal:3456/' + p + '/context-graphs/accept-' + p + '.ttl',
        cid: 'cid-accept-' + p, content: acceptDoc(p),
      });
    }
    const dead = new Set<string>((opts.unread ?? []).map((p) => String(store.get(grantIri(p))?.url)));
    const answer = (name: string, input: Record<string, unknown>): unknown => {
      switch (name) {
        case 'discover_context':
          return {
            pod: 'http://css.internal:3456/' + String(input['pod_name']) + '/',
            entries: pods.map((p) => ({ describes: [grantIri(p)] })),
          };
        case 'get_current_head': {
          const urn = String(input['urn']);
          const d = store.get(urn);
          const podUrl = 'http://css.internal:3456/' + String(input['pod_name']) + '/';
          if (forkedUrns.has(urn)) return { urn, podUrl, forked: true, heads: ['cid-a', 'cid-b'], message: 'two unresolved heads' };
          if (silentUrns.has(urn)) return { urn, podUrl };
          if (d && errorUrns.has(urn)) return { urn, podUrl, head: { descriptorUrl: d.url, error: 'the pod did not return the body' } };
          return d
            ? { urn, podUrl, head: { descriptorUrl: d.url, cid: d.cid } }
            : { urn, podUrl, message: 'No descriptor on this pod describes the requested urn.' };
        }
        case 'get_descriptor': {
          const url = String(input['url']);
          if (dead.has(url)) return { error: 'upstream_error', message: 'the pod answered 502' };
          for (const d of store.values()) if (d.url === url) return { graph: { content: d.content } };
          return { error: 'not_found' };
        }
        default: return {};
      }
    };
    const tx = {
      accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
      connect: async () => ({ granted: [] }),
      callTool: async (n: string, i: Record<string, unknown>) => answer(n, i),
    } as unknown as ConstructorParameters<typeof WorkspaceClient>[1];
    return new WorkspaceClient(RELAY, tx);
  };

  const folded = (client: WorkspaceClient, readCap?: number) => foldRoster(client, {
    workspace: WS, iriOwner: CONV, slug: SLUG, convener: WEBID(CONV), convenerPod: CONV,
    ...(readCap === undefined ? {} : { readCap }),
  });

  it('★★ a grant whose descriptor 502s is NOT a grant that was read', async () => {
    const r = await folded(fleet([CONV, 'u-stuck', 'u-third'], { unread: ['u-stuck'] }));
    expect(r.grantsFound).toBe(3);
    expect(r.grantsRead, 'a read that threw still counted itself as a read').toBe(2);

    // The row itself: no grantee, not seated, not pending — in none of the three lists a reseal
    // audience is unioned from, which is why the count has to be honest about it.
    const stuck = r.seats.find((s) => s.graph === grantIri('u-stuck'));
    expect(stuck?.grantedTo).toBeNull();
    expect(stuck?.seated).toBe(false);
    expect(stuck?.pending).toBeUndefined();

    // ★ AND THE ROW IS CLASSIFIED, WHICH IS WHAT LETS A VERB DECIDE. A 502 arrives through
    // `client.descriptor` as a `tool_error` — the relay answered ABOUT this graph and reported a
    // failure — so this reader will not call it transient. Either way it is not permanent, so the
    // reseal waits and the entry does not.
    expect(r.unread).toHaveLength(1);
    expect(r.unread?.[0]?.pod).toBe('u-stuck');
    expect(r.unread?.[0]?.kind).toBe('unknown');
    expect(r.unread?.[0]?.why).toContain('the grant record could not be read');

    const reseal = recipientsFor('reseal', 'private', r);
    expect(reseal.ok, 'the fold read 2 of 3 grants and the reseal went ahead anyway').toBe(false);
    if (!reseal.ok) {
      expect(reseal.why).toContain('u-stuck');
      expect(reseal.retryable, 'a read that may still clear was reported as terminal').toBe(true);
    }
    // ★ AND THE ENTRY IS NOT REFUSED. It supersedes nothing and evicts nobody; the hole is
    // reported instead.
    const entry = recipientsFor('entry', 'private', r);
    expect(entry.ok, 'an entry was refused over a member it cannot evict').toBe(true);
    if (entry.ok) expect(entry.partial.map((u) => u.pod)).toEqual(['u-stuck']);
  });

  it('★★ and NOTHING ELSE holds that row — restore the count to attempts and the write goes through', async () => {
    /**
     * ★ WHY THIS IS PINNED AS A DANGER RATHER THAN AS A SAFETY NET. A second guard used to catch
     * this row whatever the count said, which made the count untestable: `grantsRead` could
     * regress to the number ATTEMPTED and the write refused anyway, for the wrong reason. That
     * guard is gone, so the real 502'd member is dropped from `share_with` the moment the counter
     * is wrong. This is that state, driven from the same real fold — and it is the reason every
     * exit of the counter is pinned below rather than just the one that was easy to reach.
     */
    const r = await folded(fleet([CONV, 'u-stuck', 'u-third'], { unread: ['u-stuck'] }));
    const honest = recipientsFor('reseal', 'private', r);
    expect(honest.ok, 'the honest count did not stop the reseal').toBe(false);
    // ★ THE COUNT AND THE ROWS ARE MUTATED TOGETHER, because either one alone would leave the
    // other holding the row and the mutant would be invisible again. This is the fold's own
    // invariant `grantsRead === grantsFound - unread.length` seen from the wrong side.
    const regressed = recipientsFor('reseal', 'private', { seats: r.seats, grantsFound: r.grantsFound, grantsRead: r.grantsFound, unread: [] });
    expect(regressed.ok, 'something other than the count is holding this row').toBe(true);
    // And the 502'd member is simply not in the audience — the eviction, in full.
    if (regressed.ok) {
      expect(regressed.grantedWebIds).toEqual([WEBID(CONV), WEBID('u-third')]);
      expect(regressed.repairBy, 'nothing was left to put them back with').toEqual([]);
    }
    // ★ AND THE ROWS ALONE ARE ENOUGH: put the honest count back beside a fold that named no rows
    // and the shortfall is still seen, as `unknown`. A count that under-reports and a row list
    // that under-reports have to BOTH be wrong for the reseal to proceed.
    const rowsDropped = recipientsFor('reseal', 'private', { seats: r.seats, grantsFound: r.grantsFound, grantsRead: r.grantsRead, unread: [] });
    expect(rowsDropped.ok, 'dropping the rows disarmed the reseal guard on its own').toBe(false);
  });

  it('★★ a REVOKED grant and a RETRACTED one were both READ, and counting them otherwise is an outage', async () => {
    /**
     * The boundary that matters more than the fix itself. Both are read perfectly and are left
     * out of the audience on purpose — a withdrawal stated by somebody entitled to state one. If
     * either counted as unread, `grantsFound > grantsRead` would be permanently true for every
     * workspace that has ever removed a member, and the refusal written to prevent a silent
     * eviction would instead block every post in it, forever.
     */
    const r = await folded(fleet([CONV, 'u-gone', 'u-tomb'], {
      revoked: ['u-gone'], retracted: ['u-tomb'], noAcceptance: ['u-gone', 'u-tomb'],
    }));
    expect(r.grantsFound).toBe(3);
    expect(r.grantsRead, 'a withdrawn grant was counted as one this fold could not read').toBe(3);

    const plan = recipientsFromRoster(r);
    expect(plan.ok, 'a workspace with a revoked member refused to post').toBe(true);
    if (!plan.ok) return;
    expect(plan.shareWith).toEqual([WEBID(CONV)]);
    // Both are out of the reseal audience, and neither made the plan refuse.
    expect(plan.grantedWebIds).toEqual([WEBID(CONV)]);
  });

  /**
   * ── ★★ THE BOUNDARY, PINNED AT EVERY EXIT RATHER THAN AT ONE ─────────────
   *
   * `foldRoster` declares one line as the boundary between "this fold could not read the grant"
   * and "it read the grant and the grant says something else". Only the 502 exit was ever tested,
   * and a reviewer moved the counter across the OTHER three exits and across the unresolvable-pod
   * inclusion without failing a single one of 301 tests in 8 suites. Each of the seven clauses now
   * has a case, because the count is the only thing standing between a failed read and a write.
   */
  it('★★ a grant whose signed region could not be LOCATED is not a grant that was read', async () => {
    // The exit a reviewer moved the counter across. It is also not hypothetical: publishing a
    // grant with the wrong docClass seals it to the convener alone, and every other member's fold
    // reports exactly this row — see `createWorkspace`'s note on `'grant'`.
    const r = await folded(fleet([CONV, 'u-elsewhere', 'u-third'], { misfiled: ['u-elsewhere'] }));
    expect(r.grantsFound).toBe(3);
    expect(r.grantsRead, 'a region that was never located was counted as one that parsed').toBe(2);
    const row = r.seats.find((s) => s.graph === grantIri('u-elsewhere'));
    expect(row?.why).toContain('could not be located');
    expect(row?.grantedTo).toBeNull();
    /**
     * ★★ PERMANENT, AND THAT IS THE LIVE-FLEET CASE RATHER THAN A FAULT CASE. A descriptor served
     * in full with no signed block for this graph never reads differently, however long anybody
     * waits — and `graphRegion` answers the same way for content that is EMPTY, which is what a
     * sealed payload this reader cannot open looks like. Every workspace created while grants
     * mapped to `'shared'` folds this way for every member except the convener.
     */
    expect(r.unread?.[0]).toMatchObject({ pod: 'u-elsewhere', kind: 'permanent' });
    // ★ SO THE RESEAL PROCEEDS AND PUTS THEM BACK BY POD. Refusing would refuse the invitation,
    // and the invitation is the only act that republishes the grant this row needs rewritten.
    const reseal = recipientsFor('reseal', 'private', r);
    expect(reseal.ok, 'a permanently unreadable grant held the invite path shut').toBe(true);
    if (reseal.ok) {
      expect(reseal.repairBy.map((x) => x.pod)).toEqual(['u-elsewhere']);
      expect(reseal.repairBy[0]?.why).toContain('could not be located');
    }
  });

  it('★ nor is one whose chain is FORKED, nor one with NO HEAD at all — and both are permanent', async () => {
    const forked = await folded(fleet([CONV, 'u-split', 'u-third'], { forked: ['u-split'] }));
    expect(forked.grantsFound).toBe(3);
    expect(forked.grantsRead, 'a chain with no decided head was counted as read').toBe(2);
    expect(forked.seats.find((s) => s.graph === grantIri('u-split'))?.why).toContain('unresolved heads');
    // A fork is collapsed by one act only — a republish with `auto_supersede_prior` — and in this
    // package that act is an invitation or a revoke. Refusing them is refusing the repair.
    expect(forked.unread?.[0]).toMatchObject({ pod: 'u-split', kind: 'permanent' });
    const forkedReseal = recipientsFor('reseal', 'private', forked);
    expect(forkedReseal.ok, 'a forked grant bricked the workspace').toBe(true);
    if (forkedReseal.ok) expect(forkedReseal.repairBy.map((x) => x.pod)).toEqual(['u-split']);

    const headless = await folded(fleet([CONV, 'u-nothing', 'u-third'], { noGrantDoc: ['u-nothing'] }));
    expect(headless.grantsFound).toBe(3);
    expect(headless.grantsRead, 'a grant with nothing published at its IRI was counted as read').toBe(2);
    expect(headless.seats.find((s) => s.graph === grantIri('u-nothing'))?.why).toContain('no current head');
    // The relay STATED the absence, which is an answer: nothing is published at that name until
    // something publishes it.
    expect(headless.unread?.[0]).toMatchObject({ pod: 'u-nothing', kind: 'permanent' });
    expect(recipientsFor('reseal', 'private', headless).ok).toBe(true);
  });

  it('★★ but a grantee whose WebID resolves to NO POD was read, and the workspace still writes', async () => {
    /**
     * The other clause the boundary comment states and nothing pinned: gating the counter on
     * `podOfWebid()` survived the whole file, and under that mutant a workspace holding one
     * did:web grantee — or one revoked member — refuses every write with "the roster is
     * incomplete". The grant said who it names; only this reader's mapping came up short.
     */
    const r = await folded(fleet([CONV, 'u-did'], { doc: { 'u-did': didWebDoc } }));
    expect(r.grantsFound).toBe(2);
    expect(r.grantsRead, "this reader's own mapping came up short and it counted that as a failed read").toBe(2);
    const row = r.seats.find((s) => s.graph === grantIri('u-did'));
    expect(row?.grantedTo).toBe('did:web:example.com:u-did');
    expect(row?.why).toContain('cannot resolve to a pod');
    const plan = recipientsFromRoster(r);
    expect(plan.ok, 'a workspace holding one did:web grantee refused to write').toBe(true);
    // ★ AND THEY KEEP THE RECORD. The grant names them and nobody withdrew it, so a reseal that
    // dropped them would be the eviction this whole file is about.
    if (plan.ok) expect(plan.grantedWebIds).toEqual([WEBID(CONV), 'did:web:example.com:u-did']);
  });

  /**
   * ── ★★ CORRECT RDF THAT USED TO READ AS NAMING NOBODY ──────────────────────
   *
   * These two documents state the same triple as every other grant here, spelled two other legal
   * ways: the namespace bound to a different prefix label, and the grantee written as a
   * PrefixedName rather than an IRIREF. `readIri` matched the literal `wsp:grantedTo` and the full
   * `<…wsp#grantedTo>` with an IRIREF object and nothing else, so both read as null — and a
   * refusal keyed on that null took a whole private workspace read-only on correct RDF.
   *
   * ★★ AND THE READER STILL DOES NOT RESOLVE THEM, WHICH IS THE STATE THESE NOW PIN. A prefix-aware
   * region reader landed in `packages/core/src/rdf/turtle-region.ts` and was reverted by the
   * maintainer for shipping a fail-OPEN read into shared substrate, so `readIri` matches the
   * literal `wsp:grantedTo` and the full `<…wsp#grantedTo>` with an IRIREF object, and nothing
   * else. Both documents therefore still read as naming nobody.
   *
   * ★ WHAT MATTERS IS THAT NOTHING KEYED ON THE NULL REFUSES ANY MORE. That is the half this file
   * owns and it is unaffected by the revert: the grant is READ (so it is not in `unread`, and no
   * per-verb policy has a shortfall to act on), the row says in its own words that a different
   * prefix label reads exactly like this, and every write in the workspace goes out.
   */
  it('★★ a grant binding the same namespace to another PREFIX LABEL is READ, and refuses nothing', async () => {
    const r = await folded(fleet([CONV, 'u-alt'], { doc: { 'u-alt': altPrefixDoc } }));
    // Nothing failed: the head resolved, the descriptor was served, the region parsed.
    expect(r.grantsFound).toBe(2);
    expect(r.grantsRead).toBe(2);
    expect(r.unread, 'a grant that was read in full was counted as unread').toEqual([]);
    const row = r.seats.find((s) => s.graph === grantIri('u-alt'));
    // The revert's own consequence, stated rather than smoothed over.
    expect(row?.grantedTo, 'the prefix-aware reader is reverted; this must read as null').toBeNull();
    expect(row?.seated).toBe(false);
    expect(row?.why).toContain('another prefix label reads exactly like this');
    // ★ AND IT IS AN ANSWER, NOT A HOLE: the bytes were read, so no consumer may treat this row as
    // a read that did not complete.
    expect(row?.basis).toBe('answered');
    const plan = recipientsFromRoster(r);
    expect(plan.ok, 'a roster whose triples are all correct was refused outright').toBe(true);
    if (plan.ok) expect(plan.grantedWebIds).toEqual([WEBID(CONV)]);
    // And no verb has anything to withhold: there is no shortfall to have a policy about.
    expect(recipientsFor('reseal', 'private', r).ok).toBe(true);
    expect(recipientsFor('entry', 'private', r).ok).toBe(true);
  });

  it('★★ and one writing the grantee as a PrefixedName reads the same way, and refuses nothing', async () => {
    /**
     * `@prefix id: <https://identity…/users/>` + `id:u-pname` states the same triple as every
     * other grant here. `readIri` accepts only an IRIREF object, so it reads as null — the same
     * outcome as the alt-prefix document above and for the same reverted reason.
     */
    const r = await folded(fleet([CONV, 'u-pname'], { doc: { 'u-pname': prefixedObjectDoc } }));
    expect(r.grantsRead).toBe(2);
    expect(r.unread).toEqual([]);
    const row = r.seats.find((s) => s.graph === grantIri('u-pname'));
    expect(row?.grantedTo).toBeNull();
    expect(row?.basis).toBe('answered');
    const plan = recipientsFromRoster(r);
    expect(plan.ok, 'a roster whose triples are all correct was refused outright').toBe(true);
    if (plan.ok) expect(plan.grantedWebIds).toEqual([WEBID(CONV)]);
  });

  it('★ a grant this reader could read but not seat still counts, and still keeps the record', async () => {
    // The grant states who it names and this fold read it; the member simply published no
    // acceptance yet. Counting a row like that as unread would refuse a write over a member the
    // grant addresses perfectly well.
    const r = await folded(fleet([CONV, 'u-waiting'], { noAcceptance: ['u-waiting'] }));
    const odd = r.seats.find((s) => s.graph === grantIri('u-waiting'));
    expect(odd?.grantedTo).toBe(WEBID('u-waiting'));
    expect(r.grantsRead).toBe(2);
    const plan = recipientsFromRoster(r);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.grantedWebIds).toEqual([WEBID(CONV), WEBID('u-waiting')]);
  });

  /**
   * ── ★★ THE OTHER TWO EXITS, AND THE ONE WITH NO ROW AT ALL ─────────────────
   *
   * The suite above pins four of the six ways `grantsRead` comes up short. These are the two it
   * did not reach — a head that resolves and reports an error instead of a body, and an answer
   * carrying neither a head nor a reason — plus the grants a truncated read never asks for, which
   * have no seat and were therefore invisible to anything that read rows rather than counters.
   */
  it('★★ a head that resolves and cannot deliver a body is TRANSIENT, and the reseal waits', async () => {
    const r = await folded(fleet([CONV, 'u-cold'], { headError: ['u-cold'] }));
    expect(r.grantsRead, 'a head with an error and no CID was counted as a grant that was read').toBe(1);
    expect(r.seats.find((s) => s.graph === grantIri('u-cold'))?.why).toContain('body could not be fetched');
    // The relay FOUND the head, so the chain is decided and something is published at that name.
    // Only the fetch came up short, which is what a cold pod looks like.
    expect(r.unread?.[0]).toMatchObject({ pod: 'u-cold', kind: 'transient' });
    const reseal = recipientsFor('reseal', 'private', r);
    expect(reseal.ok, 'a reseal ran while a grant was still being read').toBe(false);
    if (!reseal.ok) expect(reseal.retryable).toBe(true);
    // ★ AND THE ENTRY GOES OUT — the whole point of asking per verb.
    expect(recipientsFor('entry', 'private', r).ok).toBe(true);
  });

  it('★★ an answer carrying neither a head nor a reason is UNKNOWN, not an absence', async () => {
    // `absent` and `unreadable` are separated one layer down and were collapsed by the counter.
    // A stated absence is permanent; an answer this client cannot interpret says nothing at all,
    // so nothing is claimed about repeating it and the reseal waits.
    const r = await folded(fleet([CONV, 'u-mute'], { headSilent: ['u-mute'] }));
    expect(r.grantsRead).toBe(1);
    expect(r.seats.find((s) => s.graph === grantIri('u-mute'))?.why).toContain('could not be resolved');
    expect(r.unread?.[0]).toMatchObject({ pod: 'u-mute', kind: 'unknown' });
    expect(recipientsFor('reseal', 'private', r).ok).toBe(false);
  });

  it('★★ a grant the READ CAP never reached is unread too, and it is the half with no row', async () => {
    /**
     * `grantsFound > grantsRead` has always been true for a truncated fold as well as a failed
     * one. A consumer that read the rows instead of the counters would have seen nothing here —
     * the absence of a finding read as a finding, one more time — so the cap contributes rows of
     * its own, carrying the pod its name gives.
     */
    const r = await folded(fleet([CONV, 'u-far', 'u-further']), 1);
    expect(r.grantsFound).toBe(3);
    expect(r.grantsRead).toBe(1);
    expect(r.seats, 'the cap produced seats it should not have').toHaveLength(1);
    expect((r.unread ?? []).map((u) => u.pod).sort()).toEqual(['u-far', 'u-further']);
    expect((r.unread ?? []).every((u) => u.kind === 'transient')).toBe(true);
    expect(r.unread?.[0]?.why).toContain('stopped before this one');
    // ★ AND `clears` SAYS WHICH ACT, WHICH `kind` CANNOT. Both cap rows are `'transient'` — the
    // same read with a bigger budget succeeds — and repeating THIS call cannot reach them.
    expect((r.unread ?? []).every((u) => u.clears === 'fold-more')).toBe(true);
    // A fold that did not look must not republish a recipient set; raising the cap is a real exit.
    const reseal = recipientsFor('reseal', 'private', r);
    expect(reseal.ok).toBe(false);
    if (!reseal.ok) {
      /**
       * ★★ THE REFUSAL SAYS WHAT IS TRUE OF THESE ROWS. It used to say "This one does clear: read
       * the members list again and retry", which was DRIVEN false — re-folding at the same cap
       * truncates in the same place, for ever, and no shell exposes `readCap` — so a workspace
       * past its shell's cap could not be invited to under a sentence promising it would clear.
       */
      expect(reseal.why).toContain('read cap');
      expect(reseal.why).toContain('at least 3');
      expect(reseal.why, 'the remedy that is a measured no-op came back').not.toContain('read the members list again');
      expect(reseal.retryable, 'repeating this same call truncates in the same place').toBe(false);
    }
    // ★ AND RE-FOLDING AT A CAP THAT REACHES THEM IS THE ACT THE SENTENCE NAMES, so it works.
    const whole = await folded(fleet([CONV, 'u-far', 'u-further']), 3);
    expect(recipientsFor('reseal', 'private', whole).ok, 'the named exit did not clear the refusal').toBe(true);
  });

  it('★★ THE INVARIANT: `grantsRead === grantsFound - unread.length`, at every exit separately', async () => {
    /**
     * ── WHY EACH EXIT GETS ITS OWN ROW HERE ────────────────────────────────────
     *
     * The whole per-verb policy rests on this identity: every existing surface still renders the
     * COUNTER PAIR, and every new consumer reads the ROWS, so the moment they disagree one of the
     * two is lying. The previous round established that pinning one exit leaves the others free —
     * a reviewer moved the counter across three of them and across the unresolvable-pod inclusion
     * without failing a test — so the table is exhaustive by construction rather than by care.
     */
    const cases: readonly (readonly [string, Parameters<typeof fleet>[1], number | undefined])[] = [
      ['everything read', {}, undefined],
      ['descriptor throws', { unread: ['u-x'] }, undefined],
      ['region not located', { misfiled: ['u-x'] }, undefined],
      ['chain forked', { forked: ['u-x'] }, undefined],
      ['no head published', { noGrantDoc: ['u-x'] }, undefined],
      ['head reports an error', { headError: ['u-x'] }, undefined],
      ['head answers nothing', { headSilent: ['u-x'] }, undefined],
      ['revoked, and READ', { revoked: ['u-x'], noAcceptance: ['u-x'] }, undefined],
      ['retracted, and READ', { retracted: ['u-x'], noAcceptance: ['u-x'] }, undefined],
      ['grantee resolves to no pod', { doc: { 'u-x': didWebDoc } }, undefined],
      ['grantee unreadable, and READ', { doc: { 'u-x': altPrefixDoc } }, undefined],
      ['acceptance absent', { noAcceptance: ['u-x'] }, undefined],
      ['read cap bites', {}, 1],
    ];
    for (const [name, opts, cap] of cases) {
      const r = await folded(fleet([CONV, 'u-x'], opts), cap);
      expect(r.unread, name + ': the fold produced no rows at all').toBeDefined();
      expect(r.grantsFound - (r.unread ?? []).length, name).toBe(r.grantsRead);
      // And `unreadGrants` agrees with the fold rather than padding it, which is what says the
      // reconciliation is inert for a real fold and only speaks for a hand-built one.
      expect(unreadGrants(r), name).toEqual(r.unread);
    }
  });
});

describe('★★ the pod a grant IRI names, recovered without reading the grant', () => {
  /**
   * ── ★★ THE ONE PRIMITIVE THAT MAKES INCLUSION POSSIBLE ─────────────────────
   *
   * A reseal facing a grant it cannot read used to have two options, and both were bad: drop the
   * member (a one-way door out of the workspace, since the record is what a grant is verified
   * against) or refuse the write (which also refuses the only act that repairs the grant). This is
   * the third: the grant's NAME says whose it is, so the member goes back into the audience with
   * nothing read out of the document at all.
   */
  const WS = 'https://relay.example/ns/u-conv/room';

  it('is the exact inverse of the composition the fold performs', () => {
    expect(podOfGrantGraph(WS + '-grant-u-eth-aa01', WS)).toBe('u-eth-aa01');
  });

  it('★ answers null rather than guessing for a name that is not this workspace\'s grant', () => {
    // A name from another workspace, and a name that is the bare prefix with nothing after it.
    expect(podOfGrantGraph('https://relay.example/ns/u-other/room-grant-u-eth-aa01', WS)).toBeNull();
    expect(podOfGrantGraph(WS + '-grant-', WS)).toBeNull();
    expect(podOfGrantGraph(WS, WS)).toBeNull();
  });
});

describe('★★ the four-row policy table: the refusal is per VERB, and permanence decides', () => {
  /**
   * ── WHAT THIS BLOCK IS FOR ─────────────────────────────────────────────────
   *
   * `recipientsFor` is the single join every entry, canvas save, canvas merge and invitation
   * passes through, and for a round it answered all four with one comparison of two integers.
   * Exactly one of the four can produce the eviction that comparison was written for. These are
   * the four rows of the table that replaced it, each pinned against the harm it names.
   */
  const WS = 'https://relay.example/ns/u-conv/room';
  const seat = (pod: string, over: Partial<Seat> = {}): Seat => ({
    graph: WS + '-grant-' + pod, grantUrl: null, grantCid: null, role: 'Contributor',
    grantedTo: WEBID(pod), pod, seated: true, why: null, basis: 'answered', encryptionKey: 'KEY-' + pod, ...over,
  } as Seat);
  const unread = (pod: string, kind: UnreadGrant['kind'], clears: UnreadGrant['clears'] = 'read-again'): UnreadGrant =>
    ({ graph: WS + '-grant-' + pod, pod, kind, clears, why: 'the grant for ' + pod + ' was not read' });
  const roster = (unreadRows: readonly UnreadGrant[], seats: readonly Seat[] = [seat('u-a')]): RosterFold => ({
    seats, grantPod: 'u-conv', grantPodDerivedFrom: null, grantReadCap: 25,
    grantsFound: seats.length + unreadRows.length, grantsRead: seats.length, unread: unreadRows,
  });

  it('row 1 — `visibility: unknown` refuses for EVERY verb, and that refusal keeps its exit', () => {
    // The one refusal the census rated correct and asked to keep: the condition is a property of
    // the READER, not of the workspace, and it clears the moment the reader changes.
    for (const verb of ['entry', 'canvas', 'reseal'] as const) {
      const out = recipientsFor(verb, 'unknown', roster([]));
      expect(out.ok, verb).toBe(false);
      if (!out.ok) {
        expect(out.why).toContain('signed in with your own key');
        expect(out.retryable, 'a sign-in is an act, not a retry').toBe(false);
      }
    }
  });

  it('row 2 — `entry` NEVER refuses over completeness, whatever the shortfall is made of', () => {
    /**
     * ★ THE ARGUMENT, IN ONE LINE OF PRODUCT BEHAVIOUR: `entry.ts` publishes with
     * `auto_supersede_prior: false`. An entry replaces no recipient set and cannot evict anybody,
     * so refusing it buys nothing and costs the channel. The hole is reported instead.
     */
    for (const kind of ['transient', 'permanent', 'unknown'] as const) {
      const out = recipientsFor('entry', 'private', roster([unread('u-gap', kind)]));
      expect(out.ok, kind).toBe(true);
      if (!out.ok) continue;
      expect(out.shareWith).toEqual([WEBID('u-a')]);
      expect(out.partial.map((u) => u.pod), kind).toEqual(['u-gap']);
      // Never for an entry: repairing an audience is a reseal's job.
      expect(out.repairBy).toEqual([]);
    }
  });

  it('row 3 — `canvas` has NO completeness refusal of its own, and the one it had was inert', () => {
    /**
     * ── ★★ WHY THIS ROW IS NOW EMPTY ─────────────────────────────────────────
     *
     * The rule was: refuse a canvas save when an unread grant's pod is one the envelope already
     * names. It could not fire for any fold `foldRoster` produces, and structurally rather than by
     * luck — a pod has exactly ONE grant in a workspace (`<workspace>-grant-<pod>`), so a pod
     * whose grant went unread has no seat, no `grantedTo`, and no WebID in `shareWith`. "Unread"
     * and "already addressed" are mutually exclusive under that naming, so the D5 canvas policy
     * was decoration and every reader of the table believed the verb was guarded.
     *
     * The harm it named is real and now lands on the population that IS both addressed and
     * unreadable — a member whose GRANT was read and whose ACCEPTANCE was not. That is the sealing
     * rule, pinned in its own block below.
     */
    // The state the old rule claimed to catch, built the only way it could be: a seated row and an
    // unread grant naming the same pod. It proceeds, because there is nothing contradictory in it
    // — the seat came from a grant that WAS read, so the unread row is a different grant.
    const addressed = recipientsFor('canvas', 'private', roster([unread('u-a', 'transient')]));
    expect(addressed.ok, 'the inert rule was left armed').toBe(true);
    if (addressed.ok) expect(addressed.partial).toHaveLength(1);

    // And a shortfall the envelope does not name proceeds too, reported through `partial`.
    const clear = recipientsFor('canvas', 'private', roster([unread('u-gap', 'transient')]));
    expect(clear.ok).toBe(true);
    if (clear.ok) expect(clear.partial).toHaveLength(1);

    // ★ THE TWO VERBS NOW ANSWER IDENTICALLY, which is what the harm analysis says: neither can
    // evict anybody. Kept as an assertion so a future divergence is deliberate.
    for (const rows of [[unread('u-a', 'transient')], [unread('u-gap', 'permanent')], []]) {
      const c = recipientsFor('canvas', 'private', roster(rows));
      const e = recipientsFor('entry', 'private', roster(rows));
      expect(c.ok).toBe(e.ok);
    }
  });

  it('row 4a — `reseal` refuses while a shortfall could still clear, and says so is retryable', () => {
    for (const kind of ['transient', 'unknown'] as const) {
      const out = recipientsFor('reseal', 'private', roster([unread('u-gap', kind)]));
      expect(out.ok, kind).toBe(false);
      if (!out.ok) {
        expect(out.why).toContain('u-gap');
        expect(out.why).toContain('read the members list again');
        expect(out.retryable).toBe(true);
      }
    }
  });

  it('★★ row 4b — when every unread grant is PERMANENT the reseal does NOT refuse, it repairs', () => {
    /**
     * ── THE UN-BRICKING, IN ONE ASSERTION ──────────────────────────────────────
     *
     * Three of the four ways a grant goes unread are permanent, and the only act that repairs one
     * is `sendInvite` republishing it — which was behind this very refusal. So "wait and retry"
     * was an outage with a misleading sentence attached, and the way out is not a better sentence:
     * it is to stop needing one. The member goes back into the audience by POD, recovered from the
     * grant's own IRI, and the eviction the guard was written for cannot happen.
     */
    const out = recipientsFor('reseal', 'private', roster([unread('u-gap', 'permanent')]));
    expect(out.ok, 'a permanently unreadable grant still holds the whole workspace shut').toBe(true);
    if (!out.ok) return;
    expect(out.repairBy).toEqual([{ pod: 'u-gap', why: 'the grant for u-gap was not read' }]);
    // The seated audience is untouched — `repairBy` is additive, and `sendInvite` unions it.
    expect(out.shareWith).toEqual([WEBID('u-a')]);
    expect(out.partial.map((u) => u.pod)).toEqual(['u-gap']);
  });

  it('★ one row that can still clear is enough to make the reseal wait, alongside permanent ones', () => {
    // Mixed: the permanent row is repairable, the other is not yet known, and re-sealing now would
    // drop whoever the second one turns out to be.
    const out = recipientsFor('reseal', 'private', roster([unread('u-gone', 'permanent'), unread('u-slow', 'transient')]));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.why).toContain('u-slow');
      expect(out.why, 'a repairable row was named as a reason to wait').not.toContain('u-gone');
    }
  });

  it('★ a permanently unreadable grant whose IRI names no pod is the one row inclusion cannot reach', () => {
    // There is no address to keep them at, so this refuses — and it names the act that fixes it
    // rather than telling anybody to wait, because waiting cannot.
    const out = recipientsFor('reseal', 'private', roster([{ graph: WS + '-grant-', pod: null, kind: 'permanent', clears: 'republish', why: 'unreadable' }]));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.why).toContain('Republish those grants');
      expect(out.retryable, 'a republish is an act, not a retry').toBe(false);
    }
  });

  it('★★ the un-verbed call applies every verb\'s refusal — ASKED OF THAT VERB\'S OWN AUDIENCE', () => {
    /**
     * The two-argument form exists so the shells keep compiling while they are converted, and it
     * is deprecated: an un-verbed caller cannot pass `repairBy` on to `sendInvite`, so the pods a
     * reseal would put back are put back by nobody. It stays only because deleting it breaks nine
     * call sites inside `tsconfig.check.json`, two of them owned by no unit, and a failing gate
     * aborts every vitest run in the repo.
     *
     * ★★ AND IT ASKS EACH RULE OF THE RIGHT SET. It used to apply the ENTRY's empty-audience
     * question to every caller, so an INVITE on a private workspace whose members all hold live
     * grants and none has accepted came back "no member … resolves to an encryption address",
     * `retryable: false`, no exit named — while `recipientsFor('reseal', …)` on the same fold
     * returned a perfectly good audience. That is the one act that repairs a workspace, refused
     * over the emptiness of a list it does not use.
     */
    // Strict where any verb is strict, for a shortfall any verb would refuse.
    expect(recipientsFor('private', roster([unread('u-gap', 'transient')])).ok, 'reseal rule').toBe(false);
    // ★ THE REGRESSION: nobody seated, everybody granted and pending. The entry audience is empty
    // and the reseal audience is not, so the un-verbed form must NOT refuse.
    const pendingOnly = roster([], [seat('u-b', { seated: false, pending: true, basis: 'answered' })]);
    const invite = recipientsFor('private', pendingOnly);
    expect(invite.ok, 'the invite path was refused over the ENTRY audience being empty').toBe(true);
    if (invite.ok) {
      expect(invite.shareWith, 'nobody is seated, so the entry audience really is empty').toEqual([]);
      expect(invite.grantedWebIds, 'and the reseal audience really is not').toEqual([WEBID('u-b')]);
    }
    // Still refused when NO verb has anybody at all.
    expect(recipientsFor('private', roster([], [])).ok, 'nobody for any verb').toBe(false);
    // ★ AND STILL LESS REFUSING THAN THE COUNT COMPARISON IT REPLACES: a roster short only by
    // permanently unreadable grants no longer holds the workspace shut for anybody.
    const permanent = recipientsFor('private', roster([unread('u-gap', 'permanent')]));
    expect(permanent.ok, 'the un-verbed form still bricks on a permanent shortfall').toBe(true);
    if (permanent.ok) expect(permanent.repairBy.map((r) => r.pod)).toEqual(['u-gap']);
  });

  it('★ a public workspace is answered without any of it, as before', () => {
    const out = recipientsFor('reseal', 'public', roster([unread('u-gap', 'transient')]));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.visibility).toBe('public');
      expect(out.shareWith).toBeUndefined();
      expect(out.repairBy).toEqual([]);
    }
  });

  it('★ and a private workspace with no roster names the state rather than a remedy that is a no-op', () => {
    // "Open the workspace and let the members list load first" was false in the state that
    // produces it: the desktop leaves its fold null when the roster read has already FAILED.
    const out = recipientsFor('entry', 'private', null);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.why).toContain('or the read failed');
      expect(out.retryable).toBe(true);
    }
  });
});

describe('★★ who the re-seal of the RECORD actually reached', () => {
  /**
   * ── THE SAME EVICTION, ONE LAYER BELOW THE RECIPIENT LIST ─────────────
   *
   * Everything above decides WHO the record should be sealed to. Whether the relay then resolved a
   * key for each of them is a separate answer, and nothing on this write path asked for it:
   * `resolveRecipient` returns an entry with an EMPTY key list rather than an error, so the publish
   * succeeds, `auto_supersede_prior` retires the revision the unreached member could read, and
   * `sharedWith[].agentCount` is the only evidence there is. `postEntry` and `saveCanvas` have both
   * read it for a while; the re-seal inside `sendInvite` did not.
   *
   * ★ AND THE INVITEE IS THE ONE CASE THAT MUST STOP THE WRITE. The re-seal runs FIRST precisely
   * so an invitee can read the record `verifyGrantIri` checks their grant against. Publishing the
   * grant to somebody the record did not reach produces exactly the state that ordering exists to
   * prevent — a grant nobody can use, with nothing saying so.
   */
  const RELAY = 'https://relay.example';
  const CONV = 'u-conv';
  const NEW = 'u-new';
  const OLD = 'u-old';
  const WS = RELAY + '/ns/' + CONV + '/room';
  const ROLES = WS + '-roles';
  const SHAPE = WS + '-shapes';
  const RECORD_URL = 'http://css.internal:3456/' + CONV + '/context-graphs/rec.ttl';
  const RECORD = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
    + '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '<' + WS + '> {\n<' + WS + '> a wsp:Workspace ; dct:title "Room" ; wsp:convener <' + WEBID(CONV) + '> ;\n'
    + '  wsp:roleProfile <' + ROLES + '> ; wsp:entryShape <' + SHAPE + '> ; wsp:visibility "private" .\n}\n';

  /**
   * A relay that commits every write and reports, per named recipient, how many agents it resolved.
   * `agentsFor` undefined means the response carries no `sharedWith` at all — which is what a
   * public write looks like and is NOT "nobody was reached".
   */
  const fleet = (
    /** Per handle: the agent count the relay reports, or `undefined` to echo it with NO count. */
    agentsFor?: (webId: string) => number | undefined,
    /** Pods whose WebFinger answers with no profile-page link, so no WebID can be resolved. */
    unknownPods: readonly string[] = [],
    /**
     * A `get_pod_status` that ANSWERS about the wrong party when asked about `askedPod`. Not a
     * failure and not a refusal — the shape a misdirecting or confused relay actually has, and the
     * one the repair path took as authoritative.
     *
     *   · `answersFor` — the response's own `pod` field names a different pod (the ECHO is wrong).
     *   · `ownerIs`    — the echo is right and `registry.owner` is somebody else's WebID (the
     *                    OWNERSHIP is wrong). Two independent failures, so they are driven apart.
     */
    misdirect?: { readonly askedPod: string; readonly answersFor?: string; readonly ownerIs?: string },
  ): { client: WorkspaceClient; published: Record<string, unknown>[] } => {
    const published: Record<string, unknown>[] = [];
    // Mutable: `publishAndConfirm` reads the head back and waits until it moves, so a store that
    // never changed would spin for the whole confirm budget rather than fail an assertion.
    const store = new Map<string, { url: string; cid: string; content: string }>([
      [WS, { url: RECORD_URL, cid: 'cid-rec', content: RECORD }],
    ]);
    let n = 0;
    const answer = (name: string, input: Record<string, unknown>): unknown => {
      switch (name) {
        case 'resolve_webfinger': {
          const pod = String(input['resource'] ?? '').replace(/^acct:/, '').split('@')[0] ?? NEW;
          // The shape a handle that resolves to nothing takes: an answer with no storage link.
          if (unknownPods.indexOf(pod) >= 0) return { links: [] };
          return { links: [{ rel: 'http://webfinger.net/rel/profile-page', href: 'http://css.internal:3456/' + pod + '/' }] };
        }
        case 'get_pod_status': {
          const asked = input['pod_name'] ? String(input['pod_name'])
            : String(input['pod_url'] ?? '').replace(/[/]$/, '').split('/').pop() ?? CONV;
          const bent = misdirect && misdirect.askedPod === asked ? misdirect : null;
          return {
            pod: 'http://css.internal:3456/' + (bent?.answersFor ?? asked) + '/',
            registry: { owner: WEBID(bent?.ownerIs ?? bent?.answersFor ?? asked) },
          };
        }
        case 'get_current_head': {
          const d = store.get(String(input['urn']));
          return d ? { urn: input['urn'], head: { descriptorUrl: d.url, cid: d.cid } }
            : { urn: input['urn'], message: 'No descriptor on this pod describes the requested urn.' };
        }
        case 'get_descriptor': {
          for (const d of store.values()) if (d.url === String(input['url'])) return { graph: { content: d.content } };
          return { error: 'not_found' };
        }
        case 'publish_context': {
          published.push(input);
          n++;
          const iri = String(input['graph_iri']);
          const url = 'http://css.internal:3456/' + String(input['pod_name']) + '/context-graphs/' + (100 + n) + '.ttl';
          store.set(iri, { url, cid: 'cid-' + n, content: '<' + iri + '> {\n' + String(input['graph_content']) + '\n}\n' });
          const to = input['share_with'];
          return {
            status: 'committed', descriptorUrl: url, cid: 'cid-' + n,
            ...(agentsFor && Array.isArray(to)
              ? {
                  sharedWith: (to as readonly string[]).map((h) => {
                    const n = agentsFor(h);
                    // ★ THE KEY IS OMITTED, not set to zero: `agentCount` is optional in the
                    // relay's published output schema, and the two shapes are different answers.
                    return n === undefined ? { handle: h } : { handle: h, agentCount: n };
                  }),
                }
              : {}),
          };
        }
        case 'notify_agent': return { delivered: true, channels: [{ type: 'ldn', status: 'delivered' }] };
        default: return {};
      }
    };
    const tx = {
      accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
      connect: async () => ({ granted: [] }),
      callTool: async (nm: string, i: Record<string, unknown>) => answer(nm, i),
    } as unknown as ConstructorParameters<typeof WorkspaceClient>[1];
    return { client: new WorkspaceClient(RELAY, tx), published };
  };

  const viewer = { podName: CONV, webId: WEBID(CONV), podUrl: 'http://css.internal:3456/' + CONV + '/' } as never;
  const invite = (client: WorkspaceClient, granted: readonly string[], repairBy?: readonly { pod: string; why: string }[]) =>
    sendInvite(client, {
      viewer, workspace: WS, workspaceTitle: 'Room', handle: 'acct:' + NEW + '@relay.example',
      role: ROLES + '#Contributor', entryShape: SHAPE, visibility: 'private',
      shareWith: [WEBID(CONV)], pendingWebIds: [], grantedWebIds: granted,
      ...(repairBy ? { repairBy } : {}),
    });

  it('★★ refuses to write the grant when the re-seal did not reach the INVITEE', async () => {
    const run = fleet((w) => (w === WEBID(NEW) ? 0 : 1));
    const out = await invite(run.client, [WEBID(CONV)]);
    expect(out.kind, 'a grant was published for somebody who cannot read the record it is checked against').toBe('error');
    if (out.kind !== 'error') return;
    expect(String((out.error as Error).message)).toContain(WEBID(NEW));
    expect(String((out.error as Error).message)).toContain('resolved no agent');
    // ★ THE LOAD-BEARING HALF: the record was re-published, and the grant was NOT.
    expect(run.published.map((x) => String(x['graph_iri']))).toEqual([WS]);
  });

  it('★ and REPORTS — without refusing — an existing member the re-seal did not reach', async () => {
    /**
     * A member the relay resolves no key for has just lost the revision of the record they could
     * read, and refusing here would not give it back: the supersession already happened. What was
     * missing is that anybody could tell. Blocking every invite over one member whose pod
     * registers no key would be a second read-only workspace, which is the failure this round
     * removed.
     */
    const run = fleet((w) => (w === WEBID(OLD) ? 0 : 1));
    const out = await invite(run.client, [WEBID(CONV), WEBID(OLD)]);
    expect(out.kind).toBe('invited');
    if (out.kind !== 'invited') return;
    expect(out.recordUnreached, 'a member dropped from the record by this write was not reported').toEqual([WEBID(OLD)]);
    // The invite itself completed: the grant is on the pod.
    expect(run.published.map((x) => String(x['graph_iri']))).toEqual([WS, WS + '-grant-' + NEW]);
  });

  it('★★ refuses the grant when the re-seal reported the invitee with NO agent count', async () => {
    /**
     * The relay ANSWERED about the recipients and stated nothing about this one. `(agentCount ??
     * 0) === 0` would have called that "the relay resolved no agent for them", which is a claim
     * the relay never made; ignoring it would write a grant against a record whose readability by
     * its own invitee is unestablished. Both are wrong, and the third answer is the true one.
     */
    const run = fleet((w) => (w === WEBID(NEW) ? undefined : 1));
    const out = await invite(run.client, [WEBID(CONV)]);
    expect(out.kind, 'the grant went out on an answer that established nothing about the invitee').toBe('error');
    if (out.kind === 'error') {
      expect(String((out.error as Error).message)).toContain('without an agent count');
      expect(String((out.error as Error).message)).toContain('not established');
    }
    // The record was re-published and the grant was NOT — the same ordering the stated-zero case has.
    expect(run.published.map((x) => String(x['graph_iri']))).toEqual([WS]);
  });

  it('★ a response reporting no sharedWith at all is "nothing reported", not "nobody reached"', async () => {
    // Reading a missing field as zero would refuse every invite against a relay that does not
    // report the field — the same false-negative the recipient reader is careful about.
    const run = fleet();
    const out = await invite(run.client, [WEBID(CONV), WEBID(OLD)]);
    expect(out.kind).toBe('invited');
    if (out.kind === 'invited') expect(out.recordUnreached).toEqual([]);
    expect(run.published.map((x) => String(x['graph_iri']))).toEqual([WS, WS + '-grant-' + NEW]);
  });

  /**
   * ── ★★ THE OTHER HALF OF THE UN-BRICKING: THE POD GOES BACK IN ─────────────
   *
   * `recipientsFor('reseal', …)` hands back `repairBy` — pods whose grant is permanently
   * unreadable, so no WebID for them exists in any of the three lists this call unions. Without
   * this the reseal republishes the record without them and retires the revision they can read,
   * and `verifyGrantIri` reads that record before anybody can accept: a one-way door out of the
   * workspace for somebody nobody revoked. The refusal that used to stand in front of it also
   * refused THIS call, which is the only act that could repair their grant.
   */
  const GHOST = 'u-ghost';

  it('★★ resolves a repair pod to a WebID and unions it into the record\'s recipients', async () => {
    const run = fleet();
    const out = await invite(run.client, [WEBID(CONV)], [{ pod: GHOST, why: 'the signed region of this grant could not be located' }]);
    expect(out.kind).toBe('invited');
    const reseal = run.published.find((x) => String(x['graph_iri']) === WS);
    expect(reseal, 'the record was not re-sealed at all').toBeDefined();
    // ★ THE LOAD-BEARING ASSERTION: the member whose grant will not read is IN the recipient set
    // of the superseding write, addressed by a WebID nothing in the grant supplied.
    expect(reseal?.['share_with']).toEqual([WEBID(CONV), WEBID(GHOST), WEBID(NEW)]);
    // And the invite itself completed.
    expect(run.published.map((x) => String(x['graph_iri']))).toEqual([WS, WS + '-grant-' + NEW]);
  });

  it('★★ and STOPS before the reseal when a repair pod cannot be resolved at all', async () => {
    /**
     * A pod lookup that did not complete is a read that established nothing, and the rule stated
     * beside `Seat.basis` is quoted here unchanged: nothing may WRITE a membership document on
     * one. Proceeding would retire the revision that member can read and they could never accept
     * again; refusing costs an invitation that can be sent again, and the sentence says so.
     *
     * ★ IT IS NARROW BY CONSTRUCTION — it needs a permanently unreadable grant AND a pod whose
     * WebFinger fails in the same moment. Everything whose grant read could still clear on its own
     * has already been refused one layer up, by `recipientsFor`.
     */
    const run = fleet(undefined, ['u-nowhere']);
    const out = await invite(run.client, [WEBID(CONV)], [{ pod: 'u-nowhere', why: 'this grant has no current head' }]);
    expect(out.kind, 'a member was evicted from the record by a lookup that failed').toBe('error');
    if (out.kind === 'error') {
      expect(String((out.error as Error).message)).toContain('u-nowhere');
      expect(String((out.error as Error).message)).toContain('could never accept again');
    }
    // ★ AND NOTHING WAS WRITTEN — not the record, not the grant.
    expect(run.published).toEqual([]);
  });

  it('★★ and STOPS when the pod status ANSWERS — about a different pod', async () => {
    /**
     * ── ★★ A READ THAT ESTABLISHED NOTHING ABOUT u-ghost, TAKEN AS AN ANSWER ABOUT u-ghost ──
     *
     * The repair loop resolves each pod through `resolveInvitee`, whose `get_pod_status` was not
     * echo-checked, and the one downstream consequence that would have caught it — `blocked`,
     * whose only assignment is `podOfWebid(webId) !== pod` — was explicitly not consulted, under a
     * comment saying it asked a different question. DRIVEN before the fix: the relay answers about
     * the convener when asked about u-ghost, the convener's WebID is unioned into `share_with`,
     * deduplicated away to nothing, `auto_supersede_prior` retires the revision u-ghost can read,
     * and the invite returns `invited`. Silent eviction, reported as success, on the one write
     * that costs somebody their membership.
     *
     * Two independent checks now stop it and this pins both: the echo (`assertPod` on the status
     * call, the same check `readMember` calls universal in this package) and the ownership test
     * read out of the WebID itself. `wrongPod` trips both at once, which is the shape a
     * misdirecting relay actually has.
     */
    const echo = fleet(undefined, [], { askedPod: GHOST, answersFor: CONV });
    const bad = await invite(echo.client, [WEBID(CONV)], [{ pod: GHOST, why: 'the signed region of this grant could not be located' }]);
    expect(bad.kind, 'a status answering for another pod was taken as an answer about this one').toBe('error');
    if (bad.kind === 'error') expect(String((bad.error as Error).message)).toContain(GHOST);
    // ★ AND NOTHING WAS WRITTEN — the eviction is in the reseal, so stopping before it is the fix.
    expect(echo.published).toEqual([]);

    // ★★ THE SECOND CHECK, DRIVEN ON ITS OWN: the echo is right and the WebID handed back belongs
    // to somebody else. That is exactly what `blocked` reads (`podOfWebid(webId) !== pod`) and it
    // was the consequence the repair path stopped consulting.
    const owner = fleet(undefined, [], { askedPod: GHOST, ownerIs: CONV });
    const wrong = await invite(owner.client, [WEBID(CONV)], [{ pod: GHOST, why: 'this grant has no current head' }]);
    expect(wrong.kind, 'a WebID belonging to another pod was unioned into the record\'s recipients').toBe('error');
    if (wrong.kind === 'error') expect(String((wrong.error as Error).message)).toContain('does not resolve back to that pod');
    expect(owner.published).toEqual([]);
  });

  it('★★ the same misdirection stops an ordinary invite, not only a repair', async () => {
    // The echo check lives in `resolveInvitee`, so the invitee's own lookup gets it too: a grant
    // written from a WebID belonging to somebody else seats the wrong person.
    const run = fleet(undefined, [], { askedPod: NEW, answersFor: CONV });
    const out = await invite(run.client, [WEBID(CONV)]);
    expect(out.kind, 'the invitee resolved to somebody else\'s WebID').toBe('resolve-failed');
    expect(run.published).toEqual([]);
  });

  it('★ an absent repairBy re-seals exactly as it did before', async () => {
    const run = fleet();
    const out = await invite(run.client, [WEBID(CONV)]);
    expect(out.kind).toBe('invited');
    expect(run.published.find((x) => String(x['graph_iri']) === WS)?.['share_with'])
      .toEqual([WEBID(CONV), WEBID(NEW)]);
  });
});
