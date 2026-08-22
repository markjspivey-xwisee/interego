/**
 * WHAT THE BOT IS ALLOWED TO SAY.
 *
 * ★ EVERY CASE HERE IS A SENTENCE THAT WOULD BE A LIE. This bot's only product is a claim about
 * what was and was not written, so its formatter is a place a false statement can be introduced
 * with no code change anywhere near a decision. These pin the four that matter: that a signature
 * is never presented as the author's own, that "unlink" is never presented as a revocation, that
 * a check which could not run is never rendered as a finding, and that a clipped message says it
 * was clipped rather than ending mid-sentence.
 */

import { describe, it, expect } from 'vitest';
import type { Check } from '@interego/workspace-client';
import {
  DISCORD_LIMIT, body, bodyParts, renderAttachmentNote, renderChallenge, renderConfirm, renderNews,
  renderRecord, renderShow, renderStart, renderUnlink,
} from '../src/render.js';
import type { Message } from '../src/render.js';
import type { Seat } from '@interego/workspace-client';
import type { RecordOut, ShowOut } from '../src/workspace.js';

/** The bot's own DID in the shape the relay issues: `DISCORD_CLIENT_NAME`, then its pod. */
const AGENT = 'did:web:identity.interego.xwisee.com:agents:interego-discord-u-eth-0123456789ab';
const RELAY_KEY = 'did:ethr:0xd144353a7A2Fa81E126e072AD3b16cD245c83331';
const POD = 'u-eth-0123456789ab';
const WEBID = 'https://identity.interego.xwisee.com/users/' + POD + '/profile#me';
/** A delegate DID in the shape the relay actually issues — surface constant, then the pod. */
const DELEGATE = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-cafebabe0001';

/**
 * Everything a multi-part render would actually put on screen, in order.
 *
 * ★ THE ASSERTIONS BELOW READ THE WHOLE REPLY, NOT PART ONE. A helper that returned `[0].content`
 * would pass every "does it say X" test by accident while parts 2..n were being dropped — which
 * is the failure this whole change exists to end, reproduced inside its own test file.
 */
const whole = (m: readonly Message[]): string => m.map((p) => p.content).join('\n');

describe('body', () => {
  it('says when it clipped', () => {
    const m = body([`${'x'.repeat(DISCORD_LIMIT * 2)}`], false);
    expect(m.content.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(m.content).toContain('clipped');
  });
  it('leaves a short message alone', () => {
    expect(body(['a', 'b'], true)).toEqual({ content: 'a\nb', ephemeral: true });
  });
});

/**
 * ★ THE SPLITTER, AND THE PROPERTY IT EXISTS FOR.
 *
 * `body` clips. `bodyParts` does not, and the reason it is a separate function rather than a
 * smarter `body` is the seam: it may only cut BETWEEN the elements it was handed, because each
 * element is one record's attribution and the words that attribution is about.
 */
describe('bodyParts', () => {
  it('★★ the live case: a 2,722-character delegate reply, which Discord rejected outright', () => {
    /**
     * MEASURED, from a real channel. A delegate answered a question asked FROM Discord; the reply
     * landed on the pod at 2,722 characters and Discord refused the relay with
     * `50035 BASE_TYPE_MAX_LENGTH: Must be 2000 or fewer in length` — twice, because the fallback
     * posted the same over-long body. The person saw nothing and concluded their agent had not
     * answered. It had, in 91 seconds, for $0.93.
     *
     * The persona path was posting the body WHOLE while this splitter sat unused in the same file.
     * `DRAFT_MAX` is 16,000, so every reply between 2,001 and 16,000 characters was lost on that
     * leg — and the delegate had already written 2,722 on its second real question.
     */
    const reply = 'Not as things stand, and I went and checked rather than guessing. '
      + Array.from({ length: 30 }, (_, i) => 'Paragraph ' + i + ': ' + 'w'.repeat(80)).join('\n\n');
    expect(reply.length).toBeGreaterThan(DISCORD_LIMIT);
    const parts = bodyParts(reply.split('\n'), false);
    expect(parts.length).toBeGreaterThan(1);
    // ★ THE PROPERTY DISCORD ENFORCES, asserted on every part rather than on the total.
    for (const p of parts) expect(p.content.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    // ★ AND NOTHING IS LOST — the failure this replaces delivered zero characters, and a splitter
    // that quietly dropped the tail would be a worse version of the same lie.
    const rejoined = whole(parts);
    for (const line of reply.split('\n').filter((l) => l.trim())) expect(rejoined).toContain(line);
    // Each part says which it is, so a reader can see a missing followup rather than infer one.
    expect(parts[0]?.content).toContain('(1/' + parts.length + ')');
  });

  it('never exceeds the limit and never drops a line', () => {
    const lines = Array.from({ length: 40 }, (_, i) => 'line ' + i + ' ' + 'y'.repeat(200));
    const parts = bodyParts(lines, false);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.content.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    for (const l of lines) expect(whole(parts)).toContain(l);
  });

  it('★ never separates an element from itself — an attribution keeps its text', () => {
    // Each element here is "header\n    body", the shape renderShow pushes per entry. A splitter
    // that cut at the last newline that fits would land the body in a message with no author.
    const entries = Array.from({ length: 12 }, (_, i) =>
      '  `pod-' + i + '` [written by X, speaking **for itself**] #' + i + '\n    ' + 'z'.repeat(300));
    const parts = bodyParts(entries, false);
    expect(parts.length).toBeGreaterThan(1);
    for (const e of entries) {
      // The whole element must appear inside ONE part, not merely somewhere across the join.
      expect(parts.some((p) => p.content.includes(e))).toBe(true);
    }
  });

  it('marks every part so a reader can tell one never arrived', () => {
    const parts = bodyParts(Array.from({ length: 30 }, () => 'w'.repeat(200)), false);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => { expect(p.content.startsWith('`(' + (i + 1) + '/' + parts.length + ')`')).toBe(true); });
  });

  it('does not mark a single message — there is nothing there to miss', () => {
    const parts = bodyParts(['short'], true);
    expect(parts).toEqual([{ content: 'short', ephemeral: true }]);
  });

  it('★ carries the ephemeral flag onto EVERY part, not just the first', () => {
    // Discord does not inherit `flags` from the deferral, so a private reply whose later parts
    // forgot the flag would publish them into the channel.
    const parts = bodyParts(Array.from({ length: 30 }, () => 'v'.repeat(200)), true);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.ephemeral).toBe(true);
  });

  it('cuts inside one element only when that element alone cannot fit, and says so', () => {
    const parts = bodyParts(['q'.repeat(DISCORD_LIMIT * 2)], false);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]?.content).toContain('(continued)');
  });
});

describe('the link instruction', () => {
  const out = renderChallenge({ kind: 'challenge', agentId: AGENT, label: 'discord-link 1100000000000000001', existing: null });

  it('is private, names the real agent, and gives the exact label', () => {
    expect(out.ephemeral).toBe(true);
    expect(out.content).toContain(AGENT);
    expect(out.content).toContain('discord-link 1100000000000000001');
    expect(out.content).toContain('PublishOnly');
  });

  it('says the label is not a password, because a delegation row is world-readable', () => {
    // A user who believed the label were a secret would treat leaking it as harmless, or treat
    // publishing it as dangerous. Both readings are wrong and both are the bot's fault if it
    // does not say which.
    expect(out.content).toContain('not a password');
    expect(out.content).toContain('world-readable');
  });

  it('tells the truth about what PublishOnly grants, rather than implying it is scoped', () => {
    // The substrate has no per-graph delegation scope. A bot that let a participant believe
    // otherwise would be describing a boundary that does not exist.
    expect(out.content).toContain('pod-wide');
    expect(out.content).toContain('not only workspace entries');
    expect(out.content).toContain('revoke_agent');
  });

  it('says nothing has happened yet', () => {
    expect(out.content).toContain('Nothing has happened yet');
  });
});

describe('unlink', () => {
  it('refuses to present itself as a revocation, and names what the user must do instead', () => {
    const m = renderUnlink({ kind: 'unlinked', had: { discordUserId: 'u', pod: POD, webId: 'w', boundAt: '', scopeAtBinding: null, basisAtBinding: null }, agentId: AGENT });
    expect(m.content).toContain('did **not** revoke');
    expect(m.content).toContain('revoke_agent');
    expect(m.content).toContain(AGENT);
    // ★ AND IT MUST NOT VOUCH FOR ITSELF. "this bot will no longer be able to" would be the bot
    // asserting its own restraint, which is the one thing the delegation model exists to replace.
    expect(m.content).not.toMatch(/no longer able|can no longer write/i);
  });
});

describe('the record notice', () => {
  const accepted = (over: Partial<Extract<RecordOut, { kind: 'recorded' }>> = {}): RecordOut => ({
    kind: 'recorded', pod: POD, streamIri: 'https://relay.interego.xwisee.com/ns/' + POD + '/x-stream', seated: 'already',
    outcome: {
      kind: 'accepted', descriptorUrl: 'http://css.railway.internal:3456/' + POD + '/context-graphs/1.ttl',
      committed: true, seq: 3, shapeSent: 'https://relay.interego.xwisee.com/ns/' + POD + '/x-shapes',
      ifMatch: 'bafkreiabc', ifMatchKind: "the prior entry's content CID", response: {}, unreached: [],
    },
    authorship: {
      present: true, signerAgent: AGENT, verificationMethod: RELAY_KEY, contentBinding: 'bound-at-signing',
      proves: ['The relay signed a statement that the caller it had authenticated as ' + AGENT + ' published this descriptor.'],
      doesNotProve: ['The signature verifies against ' + RELAY_KEY + " — the relay's own delegation key. It is NOT the author's wallet."],
    },
    ...over,
  });

  it('never says the author signed it', () => {
    const m = renderRecord(accepted());
    expect(m?.content).toContain('entry #3');
    expect(m?.content).toContain(RELAY_KEY);
    expect(m?.content).toMatch(/NOT the author's wallet/);
    // The sentence this whole file exists to keep out.
    expect(m?.content).not.toMatch(/signed by you|your signature/i);
  });

  it('★★ names the members an encrypted entry could not reach', () => {
    /**
     * `resolveRecipient` returns an EMPTY key list rather than erroring when a member's pod
     * registers no key — one 502 from the identity server on a cold start is enough. The publish
     * succeeds and the entry is encrypted to fewer people than it named. This renderer read every
     * field on the outcome EXCEPT that one, so the desktop turned amber and named the member while
     * Discord said "Recorded" with no caveat. It cannot be undone afterwards, which is why it has
     * to be said now.
     */
    const m = renderRecord(accepted({
      outcome: {
        kind: 'accepted', descriptorUrl: 'u', committed: true, seq: 4, shapeSent: null,
        ifMatch: null, ifMatchKind: null, response: {},
        unreached: ['https://identity.interego.xwisee.com/users/u-eth-bbbb/profile#me'],
      },
    }));
    expect(m?.content).toContain('could not be reached with a key');
    expect(m?.content).toContain('u-eth-bbbb');
    // And it says the part that decides what to do about it.
    expect(m?.content).toContain('cannot be changed');
  });

  it('★ and says nothing of the sort when everybody was reached', () => {
    // The opposite failure: a caveat on every ordinary message would train people to ignore it.
    expect(renderRecord(accepted())?.content).not.toContain('could not be reached');
  });

  it('says nothing validated an entry when the workspace names no shape', () => {
    const m = renderRecord(accepted({ outcome: { kind: 'accepted', descriptorUrl: null, committed: true, seq: 0, shapeSent: null, ifMatch: null, ifMatchKind: null, response: {}, unreached: [] } }));
    expect(m?.content).toContain('Nothing validated this entry');
    expect(m?.content).toContain('First entry in this log');
  });

  it('distinguishes "the relay refused" from "the relay did not answer"', () => {
    const refused = renderRecord({ ...accepted(), outcome: { kind: 'refused', code: 422, body: { error: 'shape_violation' } } } as RecordOut);
    expect(refused?.content).toContain('The relay refused');
    const silent = renderRecord({ ...accepted(), outcome: { kind: 'unreachable', error: new Error('x'), relayAnswered: false } } as RecordOut);
    expect(silent?.content).toContain('did not answer');
    expect(silent?.content).toContain('not being retried');
    const answered = renderRecord({ ...accepted(), outcome: { kind: 'unreachable', error: new Error('x'), relayAnswered: true } } as RecordOut);
    expect(answered?.content).toContain('reported a failure');
  });

  it('tells an unlinked person they were not recorded, rather than ignoring them silently', () => {
    const m = renderRecord({ kind: 'unlinked', discordUserId: '1100000000000000003' });
    expect(m?.content).toContain('<@1100000000000000003>');
    expect(m?.content).toContain('not recorded');
    expect(m?.content).toContain('has been written anywhere');
  });

  it('says nothing at all in a channel that is not a workspace', () => {
    expect(renderRecord({ kind: 'not-a-workspace' })).toBeNull();
    expect(renderRecord({ kind: 'empty' })).toBeNull();
  });
});

describe('the composed view', () => {
  const seat = (pod: string, seated: boolean, why: string | null): Seat => ({
    graph: 'g', grantUrl: null, grantCid: null, role: null, grantedTo: null, pod, seated, why, podServed: pod, stream: 'https://x/' + pod,
  });
  const view = (over: Record<string, unknown> = {}): ShowOut => ({
    kind: 'view',
    binding: { threadId: '1', convenerPod: POD, workspace: 'https://relay.interego.xwisee.com/ns/' + POD + '/d-1', slug: 'd-1', title: 'T', startedAt: '', startedBy: '' },
    record: { head: { forked: false, url: 'u', cid: null, headError: null, message: null }, regionFound: true, withheld: false, sealedReadFailed: null, visibility: 'public' as const, convener: 'w', roleProfile: null, entryShape: null, grantCapability: null, title: 'design review', authorship: null, convenerPod: POD, servedFrom: POD },
    fold: { seats: [seat(POD, true, null), seat('u-eth-ffffffffffff', false, 'granted, but no acceptance published on their pod yet')], grantPod: POD, grantPodDerivedFrom: 'wsp:convener in the record', grantScanSaturated: false, grantLimit: 400, grantsFound: 2, grantsRead: 2, grantReadCap: 25 },
    streams: [{ pod: POD, stream: 's', total: 1, forked: false, partial: false, why: null }],
    entries: [{ pod: POD, seq: 0, created: '2026-08-07T00:00:00.000Z', body: 'hello', descriptorUrl: 'u', author: { kind: 'principal', webId: WEBID, signer: { kind: 'the-author', signedBy: WEBID } }, derivedFrom: null, addressedTo: [], why: null }],
    truncated: false, totalEntries: 1,
    ...over,
  } as ShowOut);

  it('publishes the IRI as the thing that outlives the bot', () => {
    const m = renderShow(view());
    expect(whole(m)).toContain('<https://relay.interego.xwisee.com/ns/' + POD + '/d-1>');
    expect(whole(m)).toContain('with or without this bot');
  });

  it('carries a non-seat\'s own reason rather than dropping the row', () => {
    const m = renderShow(view());
    expect(whole(m)).toContain('granted, but no acceptance published on their pod yet');
  });

  it('says the cross-pod interleaving is a clock and not a finding', () => {
    const m = renderShow(view());
    expect(whole(m)).toContain('is a presentation, not a finding');
    expect(whole(m)).toContain('supersession chain');
  });

  it('renders an entry whose region could not be located as a question, not as an empty message', () => {
    const m = renderShow(view({ entries: [{ pod: POD, seq: null, created: null, body: null, descriptorUrl: 'u', author: null, why: 'the signed region of this entry could not be located, so nothing was read from bytes anybody signed' }] }));
    expect(whole(m)).toContain('? `' + POD + '` — the signed region');
  });

  /**
   * ★ THE SCAN WARNING IS GONE WITH THE CAP THAT CAUSED IT; THE READ BOUND IS NOT, AND MUST STILL
   * BE REPORTED. Two different truncations lived here and only one of them was fixed: the
   * ENUMERATION is now complete (no `limit` on `discover_context`), but how many of the grants
   * found this client will DEREFERENCE is still bounded, and a roster short for that reason is
   * still a roster that is not the whole one.
   */
  it('reports a bounded READ rather than presenting a short roster as the whole one', () => {
    const m = renderShow(view({
      fold: { ...(view() as { fold: unknown }).fold as Record<string, unknown>, grantsFound: 40, grantsRead: 25, grantReadCap: 25 },
    }));
    expect(whole(m)).toContain('40 grants found, 25 read (cap 25)');
    // And the sentence it replaced must not come back: nothing here truncates at 400 any more.
    expect(whole(m)).not.toContain('came back full');
  });

  // ── who wrote it, which the pod does not answer ────────────────────────────

  /**
   * One shown entry.
   *
   * ★ THE SIGNER IS FILLED IN FROM THE AUTHOR, because `judgeAuthorship` only ever produces a
   * `delegate` verdict where the agent named as the author is the party whose key signed the bytes,
   * and a `principal` whose carrier is their own key. A fixture that omitted it would be exercising
   * a value the judge cannot return.
   */
  const entry = (author: Record<string, unknown>, body = 'hello'): unknown => ({
    pod: POD, seq: 0, created: '2026-08-07T00:00:00.000Z', body, descriptorUrl: 'u', derivedFrom: null, why: null,
    author: author['kind'] === 'delegate' ? { signer: { kind: 'the-author', signedBy: author['agentId'] }, ...author }
      : author['kind'] === 'principal' ? { signer: { kind: 'the-author', signedBy: author['webId'] }, ...author }
        : author,
  });

  /** The per-act footing of a delegate speaking FOR the pod owner. */
  const FOR_THEM = { kind: 'on-behalf-of', principal: WEBID } as const;
  const FOR_ITSELF = { kind: 'own-account' } as const;

  it('★ names a delegate as the author, and says whose pod authorises it', () => {
    const m = renderShow(view({ entries: [entry({ kind: 'delegate', agentId: DELEGATE, footing: FOR_THEM, name: 'Research assistant', authorised: true, scope: 'PublishOnly' })] }));
    expect(whole(m)).toContain('written by **Research assistant**');
    expect(whole(m)).toContain('a delegate of the pod owner');
    expect(whole(m)).toContain('own registry authorises it with scope PublishOnly');
  });

  /**
   * ★ THE SECOND CONSUMER. This conduit renders authorship with its own copy, from the same
   * substrate value, and it is where most readers other than the pod owner meet these records. A
   * distinction that survives in the desktop shell and quietly dies here is not a distinction the
   * system has — so the two footings are asserted to produce different text, and the one a skimming
   * reader would get backwards is asserted to say so in words.
   */
  it('★ speaking FOR the owner and speaking FOR ITSELF are two different clauses here too', () => {
    const d = (footing: unknown): string => whole(renderShow(view({
      entries: [entry({ kind: 'delegate', agentId: DELEGATE, footing, name: 'Claude side', authorised: true, scope: 'PublishOnly' })],
    })));
    const forThem = d(FOR_THEM);
    const forItself = d(FOR_ITSELF);
    expect(forThem).toContain('speaking **for them** here — they share responsibility for it');
    expect(forItself).toContain('speaking **for itself** here');
    expect(forItself).toContain('the pod owner is NOT answerable for');
    expect(forThem).not.toBe(forItself);
    // Standing is reported SEPARATELY and identically in both: an agent speaking for itself is
    // still that person's delegate, and a reader must not conclude otherwise.
    expect(forThem).toContain('separately, that pod\'s own registry authorises it');
    expect(forItself).toContain('separately, that pod\'s own registry authorises it');
  });

  it('★ a delegate entry stating no footing says so, and is not read as either', () => {
    const m = renderShow(view({
      entries: [entry({ kind: 'delegate', agentId: DELEGATE, footing: { kind: 'not-stated', why: 'x' }, name: 'Claude side', authorised: true, scope: 'PublishOnly' })],
    }));
    expect(whole(m)).toContain('**footing not stated**');
    expect(whole(m)).toContain('neither reading is being assumed');
    // Neither of the two positive clauses may appear. (The closing explainer legitimately uses the
    // words in describing what the three answers ARE, so this checks the author clause's wording.)
    expect(whole(m)).not.toContain('speaking **for them**');
    expect(whole(m)).not.toContain('speaking **for itself**');
  });

  it('★ two delegates of one person are two authors in one log, not one', () => {
    const m = renderShow(view({
      entries: [
        entry({ kind: 'principal', webId: WEBID }, 'the human speaking'),
        entry({ kind: 'delegate', agentId: DELEGATE, footing: FOR_THEM, name: 'Claude side', authorised: true, scope: 'PublishOnly' }, 'first delegate'),
        entry({ kind: 'delegate', agentId: DELEGATE + '-2', footing: FOR_THEM, name: 'Codex side', authorised: true, scope: 'PublishOnly' }, 'second delegate'),
      ],
    }));
    expect(whole(m)).toContain('written by the pod owner');
    expect(whole(m)).toContain('written by **Claude side**');
    expect(whole(m)).toContain('written by **Codex side**');
  });

  it('★ an unstated author never renders as the pod owner', () => {
    const m = renderShow(view({ entries: [entry({ kind: 'unstated', why: 'this entry names no prov:wasAttributedTo' })] }));
    expect(whole(m)).toContain('**author not stated**');
    expect(whole(m)).toContain('not the same as the pod owner having written it');
    expect(whole(m)).not.toContain('written by the pod owner');
  });

  it('★ a delegation the pod does not record is a finding; one that was not checked is not', () => {
    const notListed = renderShow(view({ entries: [entry({ kind: 'delegate', agentId: DELEGATE, footing: FOR_THEM, name: null, authorised: false, scope: null })] }));
    expect(whole(notListed)).toContain('does NOT list this agent');
    const notRead = renderShow(view({ entries: [entry({ kind: 'delegate', agentId: DELEGATE, footing: FOR_THEM, name: null, authorised: null, scope: null })] }));
    expect(whole(notRead)).toContain('was not read here');
    expect(whole(notRead)).not.toContain('does NOT list this agent');
  });

  it('★ a disputed attribution carries its own reason rather than a shrug', () => {
    const m = renderShow(view({ entries: [entry({ kind: 'disputed', why: 'this entry says X acted on behalf of Y, and the pod belongs to Z' })] }));
    expect(whole(m)).toContain('**authorship disputed**');
    expect(whole(m)).toContain('acted on behalf of Y');
  });

  it('★ says the pod is the log and the name beside it is the author', () => {
    const m = renderShow(view());
    expect(whole(m)).toContain('The pod is whose LOG an entry is in');
    expect(whole(m)).toContain('prov:wasAttributedTo');
  });
});

describe('marks', () => {
  it('renders a check that could not run as "?", never as a failure', () => {
    const checks: readonly Check[] = [{ mark: 'q', text: 'the signed chain did not anchor' }];
    const m = renderStart({ kind: 'not-delegated', pod: POD, checks, why: 'nope' });
    expect(m.content).toContain('? the signed chain did not anchor');
    expect(m.content).not.toContain('✗ the signed chain did not anchor');
  });

  it('never claims a pod was written to when the check itself failed to complete', () => {
    const m = renderConfirm({ kind: 'error', error: new Error('the relay did not answer') });
    expect(m.content).toContain('Nothing was written');
    expect(m.content).toContain('nothing is claimed about your pod');
  });
});

/**
 * A DELEGATE'S WORDS UNDER ITS OWN NAME — AND EVERYTHING ELSE STILL THE BOT'S.
 *
 * ★ THE SPLIT IS THE SAFETY PROPERTY, NOT THE FEATURE. Posting under a chosen name reads as
 * presence, and Discord cannot verify a webhook name — so the name is the one part of such a
 * message that establishes nothing. It may therefore only be used where the record already proves
 * who wrote the bytes: `EntryAuthorship`'s `delegate` variant types its signer as `the-author` and
 * nothing else, so reaching that branch IS the proof. A disputed entry, an unstated author, or a
 * person's own words relayed by a conduit must keep the bot's quoted format, because those are
 * exactly the cases where a confident display name would be a claim nobody checked.
 */
describe('renderNews: who appears to be speaking', () => {
  const entry = (author: unknown, over: Record<string, unknown> = {}): unknown => ({
    pod: POD, seq: 7, created: '2026-08-12T01:46:12.346Z', body: 'the quote looks high',
    descriptorUrl: 'u7', author, derivedFrom: null, addressedTo: [], why: null, ...over,
  });
  const news = (entries: unknown[]): never => ({
    kind: 'entries', binding: { title: 'T' }, entries,
  } as never);

  const DELEGATE_AUTHOR = {
    kind: 'delegate', agentId: DELEGATE, signer: { kind: 'the-author', signedBy: DELEGATE },
    name: 'Claude Desktop', authorised: true, scope: 'PublishOnly',
    footing: { kind: 'own-account' },
  };

  /**
   * ★★ WHEN EVERYTHING CHECKS OUT, THE MESSAGE CARRIES NOTHING BUT THE MESSAGE.
   *
   * This used to assert the three claims appeared on every post. They did, and the person reading
   * the channel called it noise — twice. The first fix put them behind a `||spoiler||`, which is
   * still DISPLAYED: three fat grey blocks under every message, arguably louder than the small
   * grey text they replaced. "Behind a click" and "not shown" are different things and the ask was
   * the second.
   *
   * Nothing is lost by dropping them. The authorship is a property of the entry on the pod, which
   * is where it is authoritative; this line was only ever a rendering of it, and the desktop client
   * still shows it per message. What must never be dropped is a FINDING — see the test below.
   */
  it('★★ posts a delegate\'s entry under its own name, and adds NOTHING when it all checks out', () => {
    const posts = renderNews(news([entry(DELEGATE_AUTHOR)])) ?? [];
    expect(posts).toHaveLength(1);
    const p = posts[0] as { kind: string; who?: string; content?: string };
    expect(p.kind).toBe('agent');
    expect(p.who).toBe('Claude Desktop');
    expect(p.content).toContain('the quote looks high');
    expect(p.content).not.toContain('its own key signed these bytes');
    expect(p.content).not.toContain('not something Discord can verify');
    // ★ And no spoiler markers, which is the thing that was actually visible on screen.
    expect(p.content).not.toContain('||');
  });

  it('★★ but an agent its delegator does NOT authorise still says so, in plain text', () => {
    // This is the case the footer exists for, and the one the reassurance was drowning out. It
    // must not be hidden, spoilered, or dropped — a finding behind a click is a finding nobody
    // reads, and a finding nobody prints is worse.
    const unlisted = { ...DELEGATE_AUTHOR, authorised: false as const };
    const posts = renderNews(news([entry(unlisted)])) ?? [];
    const p = posts[0] as { kind: string; content?: string };
    expect(p.content).toContain('its own key signed these bytes');
    expect(p.content).toContain('does NOT list it');
    expect(p.content).not.toContain('||');
  });

  it('★ and so does one that stated no footing', () => {
    const noFooting = { ...DELEGATE_AUTHOR, footing: { kind: 'unstated' as const, why: 'none given' } };
    const posts = renderNews(news([entry(noFooting)])) ?? [];
    const p = posts[0] as { kind: string; content?: string };
    expect(p.content).toContain('footing not stated');
  });

  it.each([
    ['a disputed entry', { kind: 'disputed', why: 'the key that signed it is not the agent it names' }],
    ['an unstated author', { kind: 'unstated', why: 'this entry names nobody' }],
    ['the pod owner\'s own words', { kind: 'principal', webId: WEBID, signer: { kind: 'the-author', signedBy: WEBID } }],
    ['words relayed by a conduit', { kind: 'principal', webId: WEBID, signer: { kind: 'a-conduit', signedBy: AGENT, listed: true, scope: 'PublishOnly' } }],
  ])('★ never posts %s under a name', (_what, author) => {
    const posts = renderNews(news([entry(author)])) ?? [];
    expect(posts.every((p) => p.kind === 'bot')).toBe(true);
  });

  it('keeps channel order when agents and other entries interleave', () => {
    // An agent's answer arriving before the entry it answers would be a conversation reordered by
    // an implementation detail of how each message is transmitted.
    const posts = renderNews(news([
      entry({ kind: 'principal', webId: WEBID, signer: { kind: 'the-author', signedBy: WEBID } }, { body: 'first', descriptorUrl: 'u1' }),
      entry(DELEGATE_AUTHOR, { body: 'second', descriptorUrl: 'u2' }),
    ])) ?? [];
    expect(posts).toHaveLength(2);
    expect(posts[0]?.kind).toBe('bot');
    expect(posts[1]?.kind).toBe('agent');
  });

  it('★ falls back to the bot when the name cannot be a Discord username', () => {
    // A label Discord refuses would make every post from that agent fail with a 400 that reads
    // like a bot outage. Better the old format than no message.
    const posts = renderNews(news([entry({ ...DELEGATE_AUTHOR, name: 'discord helper' })])) ?? [];
    expect(posts.every((p) => p.kind === 'bot')).toBe(true);
  });
});

describe('★★ what the channel is told about a file somebody posted', () => {
  /**
   * ── THE SENTENCE THAT WAS SAID BEFORE ANYTHING CHECKED IT ──────────────────
   *
   * The notice used to be assembled in `main.ts` behind `res.kind === 'recorded'`. That reads
   * like "it was recorded" and is not: `read-failed`, `forked`, `refused` and `unreachable` all
   * arrive under `kind: 'recorded'`, and `renderRecord` prints every one of them as
   * **Not recorded.**
   *
   * So posting a picture into a forked log produced, in this order, in front of the whole thread:
   *
   *     **The attachment is on the record as a file** — plan.png — …
   *     **Not recorded.** Your log has 2 unresolved heads …
   *
   * The false one came first, and it was deliberately non-ephemeral, so everybody read it.
   */
  const rec = (over: Partial<Extract<RecordOut, { kind: 'recorded' }>> = {}): RecordOut => ({
    kind: 'recorded', pod: POD, streamIri: 'https://relay.interego.xwisee.com/ns/' + POD + '/x-stream',
    seated: 'already',
    outcome: {
      kind: 'accepted', descriptorUrl: null, committed: true, seq: 1, shapeSent: null,
      ifMatch: null, ifMatchKind: null, response: {}, unreached: [],
    },
    authorship: null,
    ...over,
  });
  const files = [{ name: 'plan.png' }];

  it('says what the record holds when the append was accepted', () => {
    const m = renderAttachmentNote(rec(), files);
    expect(m?.content).toContain('plan.png');
    expect(m?.content).toContain('on the record');
    // The limit, stated rather than implied.
    expect(m?.content).toContain('The bytes are not.');
    // Everybody in the thread, not only the poster.
    expect(m?.ephemeral).toBe(false);
  });

  const notWritten: readonly Extract<RecordOut, { kind: 'recorded' }>['outcome'][] = [
    { kind: 'forked', heads: 2, anyLinks: false },
    { kind: 'refused', code: 422, body: { error: 'shape_violation' } },
    { kind: 'read-failed', error: new Error('502') },
    { kind: 'unreachable', error: new Error('socket hang up'), relayAnswered: false },
  ];
  for (const outcome of notWritten) {
    it('★ says NOTHING when the append came back ' + outcome.kind, () => {
      // ★ THE LOAD-BEARING ASSERTION. Silence, not a softer sentence: `renderRecord` already
      // explains this outcome in full, and a second message about files that were not written
      // could only contradict it or repeat it.
      expect(renderAttachmentNote(rec({ outcome }), files),
        'the channel was told a file was on the record after a ' + outcome.kind + ' append')
        .toBeNull();
    });
  }

  it('says nothing about a message that carried no files', () => {
    expect(renderAttachmentNote(rec(), [])).toBeNull();
  });

  it('says nothing when the person was never seated, so nothing was even attempted', () => {
    expect(renderAttachmentNote({ kind: 'unseated', pod: POD, why: 'no', seating: [] }, files)).toBeNull();
  });

  it('names at most five and counts the rest, so a bulk upload does not fill the channel', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: 'f' + i + '.png' }));
    const m = renderAttachmentNote(rec(), many);
    expect(m?.content).toContain('f4.png');
    expect(m?.content).not.toContain('f5.png');
    expect(m?.content).toContain('and 3 more');
  });
});
