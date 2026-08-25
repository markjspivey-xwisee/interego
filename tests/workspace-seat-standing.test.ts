/**
 * THE ABSENCE DISCRIMINANT: a conclusion is not the absence of one.
 *
 * ── ★★ WHY THIS SUITE IS ABOUT ONE FIELD AND NOT ABOUT ONE BUG ──────────────
 *
 * `seated: false` was produced by an authoritative answer AND by every read the fold could not
 * complete, and nothing on the row said which. Three rounds of fixes each closed the sites their
 * brief named and re-committed the same defect at sibling sites nobody named, because every
 * consumer re-derived the judgement privately from whichever optional fields it happened to know
 * about. So the unit here is the CLASS: one field set at the exit the fold actually took, one
 * exported reader, and a case per exit.
 *
 * ★ THE RULE THE FIELD EXISTS TO ENFORCE, quoted here because the tests below are its cases:
 * nothing may DROP a row, DELETE a stream, UNSUBSCRIBE a watch, EXCLUDE somebody from an ENVELOPE,
 * or WRITE a membership document on `'unestablished'`.
 *
 * ★ EVERY EXIT IS DRIVEN THROUGH THE REAL `foldRoster` AGAINST A SCRIPTED RELAY, never by handing
 * `recipientsFromRoster` a seat somebody typed. A hand-built roster cannot tell whether the FOLD
 * classifies its exits correctly, which is the half that was wrong.
 */
import { describe, it, expect } from 'vitest';
import { foldRoster, seatStanding, type Seat } from '../packages/workspace-client/src/seats.js';
import { recipientsFromRoster, recipientsFor } from '../packages/workspace-client/src/recipients.js';
import { WorkspaceClient } from '../packages/workspace-client/src/substrate.js';
import { verifyGrantIri, findSeat, listWorkspaces, readInbox } from '../packages/workspace-client/src/membership.js';

const RELAY = 'https://relay.example';
const CONV = 'u-eth-c0ffee';
const SLUG = 'room';
const WS = RELAY + '/ns/' + CONV + '/' + SLUG;
const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const grantIri = (pod: string): string => WS + '-grant-' + pod;
const acceptIri = (pod: string): string => RELAY + '/ns/' + pod + '/' + CONV + '--' + SLUG + '-acceptance';
const legacyAcceptIri = (pod: string): string => RELAY + '/ns/' + pod + '/' + SLUG + '-acceptance';
const streamIri = (pod: string): string => RELAY + '/ns/' + pod + '/' + CONV + '--' + SLUG + '-stream';
const podUrl = (pod: string): string => 'http://css.internal:3456/' + pod + '/';

const PRE = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n';

const grantDoc = (pod: string, extra = ''): string => PRE
  + '<' + grantIri(pod) + '> {\n<' + grantIri(pod) + '> a wsp:Grant ; wsp:workspace <' + WS + '> ;\n'
  + '  wsp:grantedTo <' + WEBID(pod) + '> ; wsp:role <' + WS + '-roles#Contributor>' + extra + ' .\n}\n';

const acceptDoc = (pod: string, extra = '', key = true): string => PRE
  + '<' + acceptIri(pod) + '> {\n<' + acceptIri(pod) + '> a wsp:Acceptance ; wsp:workspace <' + WS + '> ;\n'
  + '  wsp:accepts <' + grantIri(pod) + '> ; wsp:acceptsCid "cid-grant-' + pod + '" ;\n'
  + '  wsp:stream <' + streamIri(pod) + '>'
  // ★ OPTIONAL, BECAUSE IT IS OPTIONAL IN THE PRODUCT. `acceptGrant` and `createWorkspace` both
  // take `encryptionKey` as an optional argument, and a client that holds no private key — the
  // published artifact installs no opener at all — accepts without one. That population is what
  // separates "no key was published" from "no key was read".
  + (key ? ' ; wsp:encryptionKey "KEY-' + pod + '"' : '') + extra + ' .\n}\n';

/** How each pod's two documents should answer. One name per exit `foldRoster` can take. */
type Mode =
  | 'seated'
  /** Seated, and their own acceptance publishes NO `wsp:encryptionKey`. An answer, and permanent. */
  | 'seated-nokey'
  /** The convener revoked them: `wsp:revoked true` in the grant's own signed region. */
  | 'revoked'
  /** The grant's author retired the record: `iep:modalStatus "Retracted"`. */
  | 'retracted'
  /** Granted, and the relay states there is no acceptance under EITHER candidate name. */
  | 'pending'
  /** The acceptance's descriptor answers 502 — the case the whole class was found through. */
  | 'accept-502'
  /** `get_current_head` for the acceptance carries neither a head nor a reason. */
  | 'accept-unreadable'
  /** The grant's own chain has two undecided heads. */
  | 'grant-forked'
  /** The grant's head is published and its body could not be fetched — `headError`. */
  | 'grant-head-error'
  /** The grant descriptor is served and the block inside it is named something else. */
  | 'grant-misfiled'
  /** The scan enumerates the grant graph and `get_current_head` says nothing is published. */
  | 'grant-absent';

interface Doc { url: string; cid: string; content: string }

/**
 * A relay serving one grant per pod from the convener's pod and one acceptance from each member's
 * own, with a per-pod failure mode. Deliberately answers in the shapes the LIVE relay answers in —
 * a resolved body carrying `error` for a 502, a `message` with no `head` for a stated absence,
 * `head.error` beside a `descriptorUrl` for a head whose body could not be fetched.
 */
const fleet = (modes: Readonly<Record<string, Mode>>, over: {
  /** Answer `discover_context` with no `entries` key at all. */
  readonly noEntries?: boolean;
  /** Echo a different pod than the one asked for. */
  readonly echoPod?: string;
} = {}): WorkspaceClient => {
  const pods = Object.keys(modes);
  const store = new Map<string, Doc>();
  const forked = new Set<string>();
  const absent = new Set<string>();
  const unreadable = new Set<string>();
  const headErrors = new Map<string, string>();
  const dead = new Set<string>();

  for (const pod of pods) {
    const mode = modes[pod] as Mode;
    const grantExtra = mode === 'revoked' ? ' ; wsp:revoked true'
      : mode === 'retracted' ? ' ; iep:modalStatus "Retracted"' : '';
    const body = grantDoc(pod, grantExtra);
    const gUrl = 'http://css.internal:3456/' + CONV + '/context-graphs/grant-' + pod + '.ttl';
    if (mode === 'grant-absent') absent.add(grantIri(pod));
    else if (mode === 'grant-forked') forked.add(grantIri(pod));
    else {
      store.set(grantIri(pod), {
        url: gUrl, cid: 'cid-grant-' + pod,
        content: mode === 'grant-misfiled'
          ? body.replace('<' + grantIri(pod) + '> {', '<' + grantIri(pod) + '-elsewhere> {')
          : body,
      });
      if (mode === 'grant-head-error') headErrors.set(grantIri(pod), 'the pod answered 502 for the body');
    }

    if (mode === 'pending' || mode === 'revoked' || mode === 'retracted'
      || mode === 'grant-forked' || mode === 'grant-absent' || mode === 'grant-misfiled'
      || mode === 'grant-head-error') continue;
    if (mode === 'accept-unreadable') { unreadable.add(acceptIri(pod)); unreadable.add(legacyAcceptIri(pod)); continue; }
    const aUrl = 'http://css.internal:3456/' + pod + '/context-graphs/accept-' + pod + '.ttl';
    store.set(acceptIri(pod), {
      url: aUrl, cid: 'cid-accept-' + pod, content: acceptDoc(pod, '', mode !== 'seated-nokey'),
    });
    if (mode === 'accept-502') dead.add(aUrl);
  }

  const answer = (name: string, input: Record<string, unknown>): unknown => {
    switch (name) {
      case 'discover_context': {
        const asked = String(input['pod_name']);
        const pod = { pod: podUrl(over.echoPod ?? asked) };
        return over.noEntries ? pod : { ...pod, entries: pods.map((p) => ({ describes: [grantIri(p)] })) };
      }
      case 'get_current_head': {
        const urn = String(input['urn']);
        const at = podUrl(String(input['pod_name']));
        if (forked.has(urn)) return { urn, podUrl: at, forked: true, heads: ['cid-a', 'cid-b'], message: 'two unresolved heads' };
        // Neither a head nor a reason: `currentHead`'s `unreadable` variant.
        if (unreadable.has(urn)) return { urn, podUrl: at };
        const d = store.get(urn);
        if (!d || absent.has(urn)) return { urn, podUrl: at, message: 'No descriptor on this pod describes the requested urn.' };
        const err = headErrors.get(urn);
        return err
          ? { urn, podUrl: at, head: { descriptorUrl: d.url, error: err } }
          : { urn, podUrl: at, head: { descriptorUrl: d.url, cid: d.cid } };
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

const fold = (modes: Readonly<Record<string, Mode>>, over: { readonly noEntries?: boolean; readonly echoPod?: string } = {}, readCap?: number) =>
  foldRoster(fleet(modes, over), {
    workspace: WS, iriOwner: CONV, slug: SLUG, convener: WEBID(CONV), convenerPod: CONV, readCap,
  });
const rowFor = (seats: readonly Seat[], pod: string): Seat =>
  seats.find((s) => s.graph === grantIri(pod)) as Seat;

describe('★★ `basis` is set at the exit the fold took, and every exit has one', () => {
  it('a seat that folded is answered, and stands as seated', async () => {
    const r = await fold({ [CONV]: 'seated' });
    const row = rowFor(r.seats, CONV);
    expect(row.seated).toBe(true);
    expect(row.basis).toBe('answered');
    expect(seatStanding(row)).toBe('seated');
  });

  /**
   * Each of these was decided by somebody entitled to decide it, out of bytes this fold read. A
   * consumer may act on them — that is what separates them from the block below.
   */
  it.each([
    ['revoked' as const, 'revoked'],
    ['retracted' as const, 'withdrawn it as an assertion'],
    ['pending' as const, 'no acceptance published on their pod yet'],
    ['grant-absent' as const, 'no current head'],
  ])('%s is ANSWERED, and stands as out', async (mode, why) => {
    const r = await fold({ [CONV]: 'seated', 'u-eth-aa01': mode });
    const row = rowFor(r.seats, 'u-eth-aa01');
    expect(row.seated).toBe(false);
    expect(row.why).toContain(why);
    expect(row.basis).toBe('answered');
    expect(seatStanding(row)).toBe('out');
  });

  /**
   * ★ AND NONE OF THESE IS AN ANSWER. Each is a read that did not complete, and the row says so in
   * a field rather than only in a sentence — prose being the one thing on a `Seat` that is free to
   * change, and the thing five consumers were matching on instead.
   */
  it.each([
    ['accept-502' as const, 'the acceptance could not be read'],
    ['accept-unreadable' as const, 'could not be resolved'],
    ['grant-forked' as const, 'unresolved heads'],
    ['grant-head-error' as const, 'body could not be fetched'],
    ['grant-misfiled' as const, 'could not be located'],
  ])('%s is UNESTABLISHED, and stands as such', async (mode, why) => {
    const r = await fold({ [CONV]: 'seated', 'u-eth-aa01': mode });
    const row = rowFor(r.seats, 'u-eth-aa01');
    expect(row.seated).toBe(false);
    expect(row.why).toContain(why);
    expect(row.basis).toBe('unestablished');
    expect(seatStanding(row)).toBe('unestablished');
  });

  it('★★ `grantsFound` counts what the SCAN found, not what the cap let this fold reach for', async () => {
    /**
     * The other operand of the completeness guard, and nothing pinned it: a reviewer changed it to
     * `Math.min(grantRows.length, readCap)` and it survived 243 tests, making the two numbers equal
     * for a truncated fold and sealing a three-member workspace to the two it happened to read.
     */
    const r = await fold({ [CONV]: 'seated', 'u-eth-bb02': 'seated' }, {}, 1);
    expect(r.grantsFound, 'the scan enumerated two grants and the cap is not part of that count').toBe(2);
    expect(r.grantsRead).toBe(1);
    expect(r.grantReadCap).toBe(1);
    // ★ AND A GRANT THE CAP NEVER REACHED HAS NO ROW AT ALL — the pair above is the only evidence
    // of it. `basis` classifies rows, so it cannot speak for a member this fold never looked at.
    expect(r.seats).toHaveLength(1);
  });

  it('★ a row nobody classified reads as unestablished, because that is the side that refuses', () => {
    // Hand-built rows — shell fixtures and test doubles — carry no `basis`. The reading of a
    // missing one is the reading that forbids dropping, evicting and writing.
    const bare = { graph: 'g', grantUrl: null, grantCid: null, role: null, grantedTo: null, pod: 'u-eth-aa01', seated: false, why: null } as Seat;
    expect(seatStanding(bare)).toBe('unestablished');
  });

  it('★★ `pending` is set only where the relay STATED an absence, not where an error was falsy', async () => {
    // `m.pending = !found.error` let an `Error('')` from either candidate probe read as "waiting
    // to accept" — a positive claim about somebody's pod from a read that established nothing.
    const answered = await fold({ [CONV]: 'seated', 'u-eth-aa01': 'pending' });
    expect(rowFor(answered.seats, 'u-eth-aa01').pending).toBe(true);
    const notAnswered = await fold({ [CONV]: 'seated', 'u-eth-aa01': 'accept-unreadable' });
    expect(rowFor(notAnswered.seats, 'u-eth-aa01').pending).toBe(false);
  });
});

describe('★★ the envelope: nothing may exclude somebody on `unestablished`', () => {
  it('★★ a member whose acceptance 502\'d is IN shareWith, and is named', async () => {
    /**
     * ── THE HIGHEST-SEVERITY SITE IN THE CENSUS ──────────────────────────────
     *
     * `seats.filter((s) => s.seated && !s.revoked)` decided who a private entry is ENCRYPTED TO
     * from `seated` alone. Reproduced: a member whose acceptance read returned 502 was silently
     * absent from `share_with` on every private entry, the plan came back `ok: true`, and no
     * surface on either side said anything. An envelope's recipients are fixed at write time, so
     * every entry written during that outage is unreadable to them forever.
     */
    const r = await fold({ [CONV]: 'seated', 'u-eth-bb02': 'accept-502' });
    const plan = recipientsFromRoster(r);
    expect(plan.ok, 'the fold read every grant, so no completeness refusal is in play here').toBe(true);
    if (!plan.ok) return;
    expect(plan.shareWith, 'a member whose acceptance merely 502\'d was dropped from the envelope')
      .toEqual([WEBID(CONV), WEBID('u-eth-bb02')]);
    expect(plan.unestablishedWebIds).toEqual([WEBID('u-eth-bb02')]);
    /**
     * ── ★★ AND THE SEALING DECISION IS NOT THEIRS TO MAKE, WHICH IS A PRIVACY FIX ────
     *
     * They were counted in `keysMissing` for a round, which empties the whole key list, which
     * makes the desktop's `sealerFor` return no sealer — so ONE member's transient 502 turned
     * end-to-end sealing OFF for every entry, canvas save and merge written afterwards, for
     * everybody, silently and for the life of those bytes. Their acceptance was not READ; nothing
     * about their key was established; ignorance may not decide it.
     *
     * `keysMissing` is now the ANSWERED population only — a seated member whose own acceptance
     * publishes no key — and this row is carried in `keysUnestablished` with the permanence of the
     * read that failed, for `recipientsFor` to judge per verb.
     */
    expect(plan.keysMissing, 'ignorance was counted as an answer, and it empties the key list').toEqual([]);
    expect(plan.keysUnestablished.map((u) => u.pod)).toEqual(['u-eth-bb02']);
    expect(plan.keysUnestablished[0]?.kind, 'a 502 reaches this reader as tool_error').toBe('unknown');
    expect(plan.keys, 'the seated member\'s own key is still read').toEqual(['KEY-' + CONV]);
    // The count of SEATS is not the length of the recipient list, and must not become it.
    expect(plan.seats).toBe(1);
  });

  it('★★ and a write that WOULD have sealed is refused rather than quietly relay-encrypted', async () => {
    /**
     * ── ★★ THE RULE: SEALING MUST NEVER SILENTLY DEGRADE ─────────────────────
     *
     * Sealing to the members whose keys WERE read leaves this one out of an envelope on a read
     * that established nothing — the act the rule beside `Seat.basis` forbids. NOT sealing hands
     * the relay every private write in the workspace for as long as their pod is unwell, in a
     * workspace whose whole claim is that the relay is not a recipient. Neither is available on
     * ignorance, so nothing is written and the fold is told to look again.
     */
    const r = await fold({ [CONV]: 'seated', 'u-eth-bb02': 'accept-502' });
    for (const verb of ['entry', 'canvas'] as const) {
      const out = recipientsFor(verb, 'private', r);
      expect(out.ok, verb + ' was published under the relay\'s key without saying so').toBe(false);
      if (!out.ok) {
        expect(out.why).toContain('u-eth-bb02');
        expect(out.why).toContain('Read the members list again');
        expect(out.retryable).toBe(true);
      }
    }
    // ★ AND THE RESEAL IS UNTOUCHED BY IT: the record is published relay-shared by design, so
    // there is no sealing decision for this row to spoil, and the invite path stays open.
    expect(recipientsFor('reseal', 'private', r).ok, 'the invite path was closed by a sealing question').toBe(true);
  });

  it('★★ a seated member who published NO key is escrowed and SAID, never refused', async () => {
    /**
     * The other population, and it must not refuse. Their own signed acceptance says they publish
     * no sealing key: an answer, permanent, and a supported state — `createWorkspace`'s
     * `encryptionKey` is optional and a client holding no private key (the published artifact
     * installs no opener at all) accepts without one. A workspace whose CONVENER joined that way
     * has this for ever, so refusing over it would be an outage with no act in the product to end
     * it. What was missing is that anybody could tell it had happened.
     */
    const r = await fold({ [CONV]: 'seated', 'u-eth-cc03': 'seated-nokey' });
    const out = recipientsFor('entry', 'private', r);
    expect(out.ok, 'a keyless member closed the workspace').toBe(true);
    if (!out.ok) return;
    expect(out.sealing.mode).toBe('escrow');
    if (out.sealing.mode !== 'escrow') return;
    expect(out.sealing.keysMissing).toEqual(['u-eth-cc03']);
    expect(out.sealing.why).toContain('NOT end-to-end encrypted');
    expect(out.sealing.why).toContain('u-eth-cc03');
    // ★ AND `keys` IS EMPTY, which is exactly why it cannot be the signal: it is the same value a
    // PUBLIC workspace returns. The mode is what says which of the two this is.
    expect(out.keys).toEqual([]);
    const pub = recipientsFor('entry', 'public', r);
    expect(pub.ok && pub.keys).toEqual([]);
    expect(pub.ok && pub.sealing.mode, 'the same empty key list, and only the mode tells them apart').toBe('unsealed');
  });

  it('★ and when every member published one, the mode says so and carries the keys', async () => {
    const r = await fold({ [CONV]: 'seated', 'u-eth-dd04': 'seated' });
    const out = recipientsFor('entry', 'private', r);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sealing.mode).toBe('seal');
    if (out.sealing.mode !== 'seal') return;
    expect(out.sealing.keys).toEqual(['KEY-' + CONV, 'KEY-u-eth-dd04']);
    // The two views of one list, so nothing can disagree with itself.
    expect(out.keys).toEqual(out.sealing.keys);
  });

  it('an answered non-seat stays out of the envelope — the exclusion is somebody\'s decision', async () => {
    const r = await fold({ [CONV]: 'seated', 'u-eth-9011': 'revoked', 'u-eth-7012': 'retracted', 'u-eth-4013': 'pending' });
    const plan = recipientsFromRoster(r);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.shareWith).toEqual([WEBID(CONV)]);
    expect(plan.unestablishedWebIds).toEqual([]);
    // The pending invitee is still in the reseal audience, which is a different question.
    expect(plan.pendingWebIds).toEqual([WEBID('u-eth-4013')]);
    expect(plan.keys).toEqual(['KEY-' + CONV]);
  });

  it('★ and a withdrawn row is never carried in on the unestablished path', async () => {
    // A revoked or retracted grant whose ACCEPTANCE also failed to read: the withdrawal is the
    // answer, and it is on the half the convener owns. Including such a row would re-admit
    // somebody to the envelope by way of a failed read of the half they own themselves.
    const r = await fold({ [CONV]: 'seated', 'u-eth-9011': 'revoked' });
    const row = rowFor(r.seats, 'u-eth-9011');
    expect(row.revoked).toBe(true);
    const plan = recipientsFromRoster(r);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.shareWith).toEqual([WEBID(CONV)]);
  });
});

describe('★★ a failed read is not an empty one', () => {
  it('foldRoster THROWS when the scan carries no entries array', async () => {
    // It was `?? []`, so a response with no index folded as a workspace with zero grants:
    // `grantsFound 0 / grantsRead 0`, which the completeness guard cannot fire on, and every
    // surface then stated the absence — an empty member list, zero invite targets, every live
    // watch dropped.
    await expect(fold({ [CONV]: 'seated' }, { noEntries: true }))
      .rejects.toThrow(/returned no entries array/);
  });

  it('★ and it checks WHOSE pod answered, on the one cross-pod read it makes', async () => {
    // A read that quietly fell back to the caller's own pod is invisible when the caller is also
    // the convener and catastrophic when they are not.
    await expect(fold({ [CONV]: 'seated' }, { echoPod: 'u-eth-dead99' }))
      .rejects.toThrow(/answered for pod/);
  });

  it('listWorkspaces THROWS rather than answering "you are in no workspace"', async () => {
    await expect(listWorkspaces(fleet({ [CONV]: 'seated' }, { noEntries: true }), RELAY, CONV))
      .rejects.toThrow(/returned no entries array/);
  });
});

describe('★★ the GRANT half: `basis` and `repairable` on a verdict', () => {
  const viewer = (pod: string) => ({ podName: pod, webId: WEBID(pod) } as Parameters<typeof verifyGrantIri>[1]['viewer']);
  const verify = (modes: Readonly<Record<string, Mode>>, pod: string) =>
    verifyGrantIri(fleet(modes), { relay: RELAY, viewer: viewer(pod), grantIri: grantIri(pod) });

  it('a stated absence is an ANSWER, and publishing is the answer to it', async () => {
    // The join flow rests on this: "no grant is published at that IRI" is exactly the state
    // `seat()` exists to repair, and a discriminant that refused it would let nobody in.
    const v = await verify({ [CONV]: 'seated', 'u-eth-1114': 'grant-absent' }, 'u-eth-1114');
    expect(v.ok).toBe(false);
    expect(v.basis).toBe('answered');
    expect(v.repairable).toBe(true);
  });

  it('★★ a head whose body could not be fetched establishes nothing, and is not repairable', async () => {
    const v = await verify({ [CONV]: 'seated', 'u-eth-aa01': 'grant-head-error' }, 'u-eth-aa01');
    expect(v.ok).toBe(false);
    expect(v.why).toContain('body could not be fetched');
    expect(v.basis).toBe('unestablished');
    expect(v.repairable).toBe(false);
  });

  it('a forked grant chain establishes nothing either', async () => {
    const v = await verify({ [CONV]: 'seated', 'u-eth-aa01': 'grant-forked' }, 'u-eth-aa01');
    expect(v.basis).toBe('unestablished');
    expect(v.repairable).toBe(false);
  });

  it('★ a REVOKED grant was read in full and is still not repairable — that is a third case', async () => {
    // Read bytes, so `answered`; and republishing the grant is precisely the
    // revoked-member-re-seats-by-typing bypass, so not repairable. The two fields say different
    // things about the same verdict, which is why there are two of them.
    const v = await verify({ [CONV]: 'seated', 'u-eth-9011': 'revoked' }, 'u-eth-9011');
    expect(v.revoked).toBe(true);
    expect(v.basis).toBe('answered');
    expect(v.repairable).toBe(false);
  });

  it('findSeat: a scan that returned no index does not report "none of them names you"', async () => {
    const v = await findSeat(fleet({ [CONV]: 'seated' }, { noEntries: true }),
      { relay: RELAY, viewer: viewer('u-eth-1114'), workspace: WS });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('could not be enumerated');
    expect(v.basis).toBe('unestablished');
    expect(v.repairable).toBe(false);
  });

  it('★ findSeat: an unread grant in the scan makes "none names you" unestablished', async () => {
    // One grant on the pod could not be read at all. It might be the one that names — or revokes —
    // this viewer, and the caller's next act is a WRITE.
    const v = await findSeat(fleet({ [CONV]: 'seated', 'u-eth-aa01': 'grant-forked' }),
      { relay: RELAY, viewer: viewer('u-eth-1114'), workspace: WS });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('could not be read at all');
    expect(v.basis).toBe('unestablished');
    expect(v.repairable).toBe(false);
  });

  it('findSeat: a complete scan naming nobody IS an answer, and is repairable', async () => {
    const v = await findSeat(fleet({ [CONV]: 'seated' }),
      { relay: RELAY, viewer: viewer('u-eth-1114'), workspace: WS });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('none of them names you');
    expect(v.basis).toBe('answered');
    expect(v.repairable).toBe(true);
  });
});

describe('★★ `resolveMemberDoc` answers per candidate', () => {
  it('★★ a head with a URL and an error is not a found document', async () => {
    // It returned `{found: true, error: null}` for exactly this shape, so callers went straight to
    // `descriptor(head.url)` and took the throw — with the lookup's own contract carrying a field
    // for saying so, set to null.
    const tx = {
      accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
      connect: async () => ({ granted: [] }),
      callTool: async (n: string, i: Record<string, unknown>) => {
        if (n !== 'get_current_head') return {};
        const urn = String(i['urn']);
        return urn === acceptIri('u-eth-aa01')
          ? { urn, podUrl: podUrl('u-eth-aa01'), head: { descriptorUrl: 'http://css.internal:3456/u-x/a.ttl', error: 'the pod answered 502 for the body' } }
          : { urn, podUrl: podUrl('u-eth-aa01'), message: 'No descriptor on this pod describes the requested urn.' };
      },
    } as unknown as ConstructorParameters<typeof WorkspaceClient>[1];
    const found = await new WorkspaceClient(RELAY, tx).resolveMemberDoc('u-eth-aa01', CONV, SLUG, 'acceptance');
    expect(found.found).toBe(false);
    expect(found.head).toBeNull();
    expect(found.error).toContain('502');
    expect(found.primary.outcome).toBe('head-unreadable');
    // ★ AND IT STOPS THERE. Something IS published at the qualified name; a legacy document found
    // afterwards would be the older one, and returning it as `found` would seat a member off a
    // record their own pod has superseded.
    expect(found.candidates).toHaveLength(1);
  });

  it('★★ "is anything published at the WRITE name" is answerable apart from "did anything fail"', async () => {
    /**
     * A failure on the LEGACY name — which `acceptGrant` never writes to — used to be the whole of
     * `error`, so a genuinely un-accepted invitee came back with `pending: false` and `ownHalf`
     * reported `repairable: false`: refused with "try again", forever, over an unrelated probe.
     * `error` stays conservative on purpose (a legacy document may hold their whole log), and the
     * narrower question is now answerable beside it.
     */
    const tx = {
      accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
      connect: async () => ({ granted: [] }),
      callTool: async (n: string, i: Record<string, unknown>) => {
        if (n !== 'get_current_head') return {};
        const urn = String(i['urn']);
        if (urn === legacyAcceptIri('u-eth-1114')) throw new Error('the pod answered 502');
        return { urn, podUrl: podUrl('u-eth-1114'), message: 'No descriptor on this pod describes the requested urn.' };
      },
    } as unknown as ConstructorParameters<typeof WorkspaceClient>[1];
    const found = await new WorkspaceClient(RELAY, tx).resolveMemberDoc('u-eth-1114', CONV, SLUG, 'acceptance');
    expect(found.found).toBe(false);
    expect(found.error, 'the legacy probe failed and the conservative signal must still carry it').toContain('502');
    expect(found.primary.naming).toBe('qualified');
    expect(found.primary.iri).toBe(acceptIri('u-eth-1114'));
    expect(found.primary.outcome, 'the name a write would use answered a clean absence').toBe('absent');
    expect(found.candidates.map((c) => c.outcome)).toEqual(['absent', 'error']);
  });
});

/**
 * ── ★★ THE UNESTABLISHED-READ CLASS AT THE THREE SITES THE ROUND LEFT OPEN ──
 *
 * Every case below is the same shape as the ones above — an answer that established nothing, read
 * as a positive fact — at a site the `Seat.basis` work did not reach. Each is driven through the
 * real module against a scripted relay, because the defect in each was that nothing looked.
 */
describe('★★ a read that established nothing, at the sites the class was still open at', () => {
  /** A relay that answers exactly one tool, so the case under test is the only thing in play. */
  const only = (name: string, reply: (input: Record<string, unknown>) => unknown): WorkspaceClient => {
    const tx = {
      accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
      connect: async () => ({ granted: [] }),
      callTool: async (n: string, i: Record<string, unknown>) => (n === name ? reply(i) : {}),
    } as unknown as ConstructorParameters<typeof WorkspaceClient>[1];
    return new WorkspaceClient(RELAY, tx);
  };

  it('★★ readInbox THROWS rather than answering "you have no invitations" from no list', async () => {
    /**
     * `read_inbox` answering `{inbox, count: 0}` with no `items` key used to resolve as
     * `{invitations: [], saturated: false}` — the empty-inbox screen, stated from an answer that
     * enumerated nothing. It is the invitee-facing instance of the shape closed at three sibling
     * sites this round, two of them in the same file.
     */
    await expect(readInbox(only('read_inbox', () => ({ inbox: 'https://relay.example/inbox', count: 0 }))))
      .rejects.toThrow(/could not be enumerated at all/);
    // ★ THE CONTROL: a real empty list is still an answer, and still answers.
    const empty = await readInbox(only('read_inbox', () => ({ inbox: 'x', count: 0, items: [] })));
    expect(empty.invitations).toEqual([]);
    expect(empty.saturated).toBe(false);
  });

  it('★★ readWorkspaceRecord treats a head with a URL and an ERROR as unread, not as a record', async () => {
    /**
     * ── THE D2 DEFECT AT THE THIRD `currentHead` CALL IN THE FILE D2 NAMES ───
     *
     * `if (h.url === null) …; const d = await this.descriptor(h.url)` took a head the relay had
     * already reported unfetchable as readable. Two outcomes and both wrong: with the body dead it
     * THREW out of a method whose own return type has a `{kind:'missing', unreadable:true}` arm —
     * and `resealRecord`, `sendInvite` and the desktop's `invite()` catch none of it, so the
     * Invite button stayed disabled with nothing said — while with the body still in
     * `descriptor`'s own cache it returned `regionFound: true` and `verifyGrantIri` validated a
     * grant against bytes the relay had just said it could not fetch.
     */
    let descriptorCalls = 0;
    const client = only('get_current_head', () => ({
      urn: WS, podUrl: podUrl(CONV),
      head: { descriptorUrl: 'http://css.internal:3456/' + CONV + '/context-graphs/rec.ttl', error: 'the pod answered 502 for the body' },
    }));
    // Any `get_descriptor` at all is the defect: the head was already reported unfetchable.
    const tx = (client as unknown as { transport: { callTool: (n: string, i: Record<string, unknown>) => Promise<unknown> } }).transport;
    const inner = tx.callTool.bind(tx);
    tx.callTool = async (n: string, i: Record<string, unknown>) => {
      if (n === 'get_descriptor') descriptorCalls++;
      return inner(n, i);
    };
    const out = await client.readWorkspaceRecord(WS, CONV);
    expect(out.kind, 'a head the relay could not deliver was read as a record').toBe('missing');
    if (out.kind === 'missing') {
      expect(out.unreadable, 'an unfetchable body is not a stated absence').toBe(true);
      expect(out.message).toContain('502');
    }
    expect(descriptorCalls, 'it dereferenced a head the relay had already explained').toBe(0);
  });

  it('★ and a clean head is still read, so the guard is not the whole door', async () => {
    const url = 'http://css.internal:3456/' + CONV + '/context-graphs/rec.ttl';
    const content = PRE + '<' + WS + '> {\n<' + WS + '> a wsp:Workspace ; wsp:convener <' + WEBID(CONV) + '> .\n}\n';
    const tx = {
      accepts: 'relay-oauth-bearer', label: 'stub', watchDescription: 'not watched',
      connect: async () => ({ granted: [] }),
      callTool: async (n: string) => (n === 'get_current_head'
        ? { urn: WS, podUrl: podUrl(CONV), head: { descriptorUrl: url, cid: 'cid-rec' } }
        : n === 'get_descriptor' ? { graph: { content } } : {}),
    } as unknown as ConstructorParameters<typeof WorkspaceClient>[1];
    const out = await new WorkspaceClient(RELAY, tx).readWorkspaceRecord(WS, CONV);
    expect(out.kind).toBe('record');
    if (out.kind === 'record') expect(out.record.convener).toBe(WEBID(CONV));
  });
});
