/**
 * THE SIX CHECKS, EACH FAILED ON ITS OWN.
 *
 * ★ THE MEASURED FACT THIS FILE DEFENDS: any account on this relay can deliver into any inbox. So
 * every test below is a notice that LOOKS right and is not, and the assertion is that the verifier
 * refuses it AND says which check failed. A verifier that answered a bare `false` would be useless
 * for the thing this is for — a person deciding whether somebody actually asked their agent
 * something, or whether a stranger wrote into their inbox.
 *
 * ★ AND EVERY REFUSAL LEAVES THE ITEM VISIBLE. The verdict carries the checklist rather than the
 * caller dropping the row, because a forged notice and a genuine one looking identical from the
 * outside is how people stop reading their inbox at all.
 */

import { describe, it, expect } from 'vitest';
import {
  admitAnyVerifiedSigner, admitSeatedIn, entryTurtle, readRequests, verifyRequest,
  type AgentPort, type RequestNotice, type Seat,
} from '@interego/workspace-client';

const RELAY = 'https://relay.interego.xwisee.com';
const ASKER = 'u-eth-8f3b8e939600';
const ASKER_WEBID = 'https://identity.interego.xwisee.com/users/' + ASKER + '/profile#me';
const BOT = 'did:web:identity.interego.xwisee.com:agents:interego-discord-u-eth-053ad15f9633';
const ME = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-cafebabe0001';
const WORKSPACE = RELAY + '/ns/' + ASKER + '/d-1234567890';
const STREAM = RELAY + '/ns/' + ASKER + '/' + ASKER + '--d-1234567890-stream';
const ABOUT = 'https://css.internal/' + ASKER + '/context-graphs/entry-7.ttl';

const seats = (pod: string): readonly Seat[] => [
  { graph: WORKSPACE, grantUrl: null, grantCid: null, role: null, grantedTo: ASKER_WEBID, pod, seated: true, why: null, stream: STREAM, podServed: pod },
];

function entryDoc(over: { addressedTo?: readonly string[]; workspace?: string; body?: string } = {}): Record<string, unknown> {
  const ttl = entryTurtle({
    streamIri: STREAM, workspace: over.workspace ?? WORKSPACE, seq: 7,
    body: over.body ?? 'Can you check whether the underlay is dry before we decide?',
    prior: null, author: { kind: 'principal', webId: ASKER_WEBID },
    ...(over.addressedTo === undefined ? {} : { addressedTo: over.addressedTo }),
  });
  return {
    turtle: '<x> iep:describes <' + STREAM + '> .',
    graph: { content: '<' + STREAM + '> {\n' + ttl + '\n}' },
    // The fully-bound case is the DEFAULT so the baseline reads six clean checks. The delegated
    // cross-pod shape — which is what a conduit actually produces — has its own case below,
    // because it is a different answer and not a weaker version of this one.
    authorship: { authorshipVerified: true, signedBy: BOT, contentBinding: 'bound', descriptorBinding: { bound: true, basis: 'slug-and-owner' } },
  };
}

const notice = (over: Partial<RequestNotice> = {}): RequestNotice => ({
  item: {}, about: ABOUT, actor: BOT, summary: 'A request', published: null, ...over,
});

/**
 * A port that answers descriptor reads AND the one registry read admission now makes.
 *
 * ★ THE REGISTRY IS PART OF THE FIXTURE BECAUSE IT IS PART OF THE ANSWER. `admitSeatedIn` resolves
 * the KEY that signed a record to a seat — the asker's own WebID, a seated pod's own surface, or a
 * seated pod's delegation registry — rather than gating on the first path segment of the URL the
 * notice pointed at, which a forger writes. The conduit here is exactly that third case: the bot's
 * own pod is not seated, and what admits it is that the asker's registry lists it.
 */
const clientFor = (d: Record<string, unknown> | Error, registry: readonly Record<string, unknown>[] = [{ agentId: BOT, label: 'delegate discord', scope: 'PublishOnly' }]): AgentPort => ({
  async tool(name: string): Promise<unknown> {
    if (name !== 'get_pod_status') throw new Error('this fixture answers descriptor and registry reads only, not ' + name);
    return { delegationRegistry: { owner: ASKER_WEBID, rows: registry } };
  },
  async descriptor(): Promise<Record<string, unknown>> { if (d instanceof Error) throw d; return d; },
});

const port = (registry: readonly Record<string, unknown>[] = [{ agentId: BOT, label: 'delegate discord', scope: 'PublishOnly' }]) => ({
  tool: (async (name: string) => {
    if (name !== 'get_pod_status') throw new Error('unexpected ' + name);
    return { delegationRegistry: { owner: ASKER_WEBID, rows: registry } };
  }) as never,
});

const args = (over: Partial<Parameters<typeof verifyRequest>[2]> = {}): Parameters<typeof verifyRequest>[2] => ({
  heldAgentIds: [ME], answeredHere: [], derivedFromOnMyPod: [],
  admits: admitSeatedIn({ workspace: WORKSPACE, seats: seats(ASKER), port: port() }),
  ...over,
});

describe('a request that stands', () => {
  it('passes every check and carries what was asked, read from the signed region', async () => {
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(), args());
    expect(v.ok).toBe(true);
    expect(v.forMe).toEqual([ME]);
    expect(v.body).toContain('underlay');
    expect(v.checks.every((c) => c.mark === 'y')).toBe(true);
    expect(v.checks).toHaveLength(6);
  });
});

describe('an agent that belongs to no workspace at all', () => {
  /**
   * ★ THE TEST THE WHOLE LAYERING EXISTS TO PASS. A Codex agent testing a build, reached from a
   * bare script, has no roster, no seats, no convener and no channel — and must still be able to be
   * addressed, verify what arrived, and answer. Before check 5 became a predicate, verification
   * took `seats: readonly Seat[]`, so this was not expressible at all: an agent with no room could
   * not verify a request, which made "a workspace is merely a room agents can talk in" false in the
   * code however often it was true in the comments.
   */
  it('verifies a request with no roster, no seats and no room anywhere', async () => {
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(), {
      heldAgentIds: [ME], answeredHere: [], derivedFromOnMyPod: [], admits: admitAnyVerifiedSigner,
    });
    expect(v.ok).toBe(true);
    expect(v.forMe).toEqual([ME]);
  });

  it('takes an allowlist as its policy just as readily as a roster — keyed on the SIGNER', async () => {
    // ★ AN ALLOWLIST OF KEYS, NOT OF PATH SEGMENTS. The predicate used to be handed a `pod` parsed
    // out of the notice's own `about` URL — a string a forger writes, on a host `get_descriptor`
    // will fetch for anybody. What the relay verified over these bytes is the signer, so that is
    // what a policy is given and `servedFromPath` is named for what it actually is.
    const known = ['did:web:identity.example:agents:somebody-i-know'];
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(), {
      heldAgentIds: [ME], answeredHere: [], derivedFromOnMyPod: [],
      admits: ({ signedBy }) => (known.indexOf(signedBy) >= 0 ? null : signedBy + ' is not on this agent\'s allowlist'),
    });
    expect(v.ok).toBe(false);
    expect(v.why).toContain('not on this agent\'s allowlist');
  });

  it('defaults to any verified signer rather than to nobody, and says whose policy ran', async () => {
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(), {
      heldAgentIds: [ME], answeredHere: [], derivedFromOnMyPod: [],
    });
    expect(v.ok).toBe(true);
    expect(v.checks.some((c) => c.text.includes('by this host\'s own policy'))).toBe(true);
  });
});

describe('each check, failed on its own', () => {
  it('1 — the address points at nothing', async () => {
    const v = await verifyRequest(clientFor(new Error('404')), notice(), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('did not resolve');
  });

  it('2 — the signature does not cover the bytes being served', async () => {
    for (const b of ['unbound', 'declared', 'mismatched', 'unchecked']) {
      // ★ ONLY "bound" MEANS A SIGNATURE WAS VERIFIED AND ITS DIGEST RECOMPUTED OVER WHAT IS BEING
      // SERVED. "declared" is a proof that carries a digest nobody compared; "unbound" is one that
      // carries none. Both used to read as safe-enough beside a `authorshipVerified: true`, and
      // under either the ask inside could be swapped for another and the proof still verify.
      const doc = { ...entryDoc({ addressedTo: [ME] }), authorship: { authorshipVerified: true, signedBy: BOT, contentBinding: b } };
      const v = await verifyRequest(clientFor(doc), notice(), args());
      expect(v.ok, b).toBe(false);
      expect(v.why, b).toContain('Only "bound"');
    }
  });

  it('2 — content bound and NO signer named is refused, because check 3 would have nothing to hold', async () => {
    const doc = { ...entryDoc({ addressedTo: [ME] }), authorship: { authorshipVerified: false, contentBinding: 'bound' } };
    const v = await verifyRequest(clientFor(doc), notice({ actor: BOT }), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('names no signer');
  });

  /**
   * ★ THE MEASUREMENT THAT REWROTE CHECK 2, PINNED SO IT CANNOT SILENTLY COME BACK.
   *
   * Measured live 2026-08-09 on the exact write a conduit makes — a delegate's session appending to
   * its DELEGATOR's pod — the relay answers `authorshipVerified: false` with
   * `descriptorBinding: { bound: false }`, `contentBinding: "bound"`, and a reason that begins "the
   * authorship proof's signature is INTACT". `authorshipVerified` is the conjunction of "signature
   * verified" and "the proof names the URL this was served from", and the second half is false by
   * construction for every delegated cross-pod write.
   *
   * A verifier keyed on it therefore refused EVERY Discord-relayed ask and every desktop delegate's
   * entry — the entire class of record the ask-and-wake path exists for — while reporting
   * "authorship did not verify" about a signature the relay had just called intact.
   */
  it('2 — a DELEGATED cross-pod write is accepted, and its unbound descriptor is reported not hidden', async () => {
    const delegated = {
      ...entryDoc({ addressedTo: [ME] }),
      authorship: {
        authorshipVerified: false,
        signedBy: BOT,
        contentBinding: 'bound',
        descriptorBinding: { bound: false, basis: 'none', note: 'the proof is signed for owner <the delegate> and the pod serving it publishes <the delegator> as its owner' },
        reason: 'the authorship proof\'s signature is intact, but the proof is not about this record: …',
      },
    };
    const v = await verifyRequest(clientFor(delegated), notice(), args());
    expect(v.ok).toBe(true);
    // Reported as an open question — never as a pass, and never silently.
    const q = v.checks.filter((c) => c.mark === 'q');
    expect(q).toHaveLength(1);
    expect(q[0]?.text).toContain('does not bind to the address it was served from');
    // And it names what carries the weight instead, rather than leaving a reader to work it out.
    expect(q[0]?.text).toContain('must BE the signer');
  });

  it('2 — an own-pod write binds fully, and then there is no open question at all', async () => {
    const ownPod = {
      ...entryDoc({ addressedTo: [ME] }),
      authorship: { authorshipVerified: true, signedBy: BOT, contentBinding: 'bound', descriptorBinding: { bound: true, basis: 'slug-and-owner' } },
    };
    const v = await verifyRequest(clientFor(ownPod), notice(), args());
    expect(v.ok).toBe(true);
    expect(v.checks.every((c) => c.mark === 'y')).toBe(true);
  });

  it('3 — somebody else pointed at a record they did not write', async () => {
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice({ actor: 'did:web:x:agents:a-stranger' }), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('somebody else pointing at your record');
  });

  it('3 — a notice with no actor at all establishes nothing', async () => {
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice({ actor: null }), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('names no actor');
  });

  it('4 — addressed to a delegate whose key is on somebody ELSE\'s machine', async () => {
    const other = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-cafebabe0002';
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [other] })), notice(), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('holds no key for any of them');
    expect(v.addressedTo).toEqual([other]);
  });

  it('4 — an entry addressed to nobody is an entry, not a request', async () => {
    const v = await verifyRequest(clientFor(entryDoc()), notice(), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('not a request addressed to anybody');
  });

  it('5 — the asker is not seated in the workspace the entry declares', async () => {
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(),
      args({ admits: admitSeatedIn({ workspace: WORKSPACE, seats: [], port: port() }) }));
    expect(v.ok).toBe(false);
    expect(v.why).toContain('nobody is seated in');
  });

  /**
   * ★ THE FORGERY CHECK 5 USED TO ADMIT, PINNED.
   *
   * The predicate was handed a `pod` derived from the first path segment of the notice's own
   * `about` — measured, `podOfDescriptorUrl('https://attacker.example/u-eth-<seated>/req.ttl')` is
   * `'u-eth-<seated>'`, and `get_descriptor` will fetch a caller-supplied URL on any public host.
   * So a descriptor served from a host that has nothing to do with this fleet satisfied "is the
   * asker seated here". Nothing about the URL is consulted now; the signature is.
   */
  it('★ 5 — a descriptor served from an attacker\'s host whose PATH names a seated pod is refused', async () => {
    const stranger = 'did:web:attacker.example:agents:nobody-u-eth-000000000009';
    const doc = {
      ...entryDoc({ addressedTo: [ME] }),
      authorship: { authorshipVerified: true, signedBy: stranger, contentBinding: 'bound', descriptorBinding: { bound: false, basis: 'none' } },
    };
    const v = await verifyRequest(
      clientFor(doc),
      notice({ about: 'https://attacker.example/' + ASKER + '/req.ttl', actor: stranger }),
      args(),
    );
    expect(v.ok).toBe(false);
    expect(v.why).toContain('resolves to no seat in this workspace');
    // The path segment IS reported — as what it is, so a reader can see the trick that was tried.
    expect(v.servedFromPath).toBe(ASKER);
  });

  it('★ 5 — a registry that would not answer is said so, not read as "not a delegate"', async () => {
    const failing = { tool: (async () => { throw new Error('502 bad gateway'); }) as never };
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(),
      args({ admits: admitSeatedIn({ workspace: WORKSPACE, seats: seats(ASKER), port: failing }) }));
    expect(v.ok).toBe(false);
    expect(v.why).toContain('refusal for lack of an answer');
  });

  it('5 — a record that names no room does not join one by arriving in a member\'s inbox', async () => {
    // `entryTurtle` always writes `wsp:workspace`, so this is a hand-built region — which is the
    // honest fixture, because the document under test is one somebody else wrote.
    const roomless = {
      turtle: '<x> iep:describes <' + STREAM + '> .',
      graph: { content: '<' + STREAM + '> {\n<' + STREAM + '/e/7> a <urn:x> ; <https://markjspivey-xwisee.github.io/interego/ns/iep#addressedTo> <' + ME + '> ; <http://purl.org/dc/terms/description> "do a thing" .\n}' },
      authorship: { authorshipVerified: true, signedBy: BOT, contentBinding: 'bound' },
    };
    const v = await verifyRequest(clientFor(roomless), notice(), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('declares no wsp:workspace');
  });

  it('5 — an ask into another channel is not an ask here', async () => {
    const elsewhere = RELAY + '/ns/' + ASKER + '/some-other-room';
    const v = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME], workspace: elsewhere })), notice(), args());
    expect(v.ok).toBe(false);
    expect(v.why).toContain('is watching');
  });

  it('6 — already answered in this run, and already answered in a previous one', async () => {
    const inRun = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(), args({ answeredHere: [ABOUT] }));
    expect(inRun.why).toContain('already drafted an answer');
    const acrossRuns = await verifyRequest(clientFor(entryDoc({ addressedTo: [ME] })), notice(), args({ derivedFromOnMyPod: [ABOUT] }));
    // The durable one is named as the durable one: an in-run list does not survive a restart and
    // an entry on the pod does.
    expect(acrossRuns.why).toContain('survives a restart');
  });
});

describe('reading the inbox', () => {
  it('keeps only items that point at something, and reports a saturated read', async () => {
    const client = {
      async tool(): Promise<unknown> {
        return { items: [{ about: ABOUT, actor: BOT, type: 'Question', summary: 's' }, { type: 'Question' }] };
      },
    } as unknown as AgentPort;
    const read = await readRequests(client, 2);
    expect(read.notices).toHaveLength(1);
    // Two items came back for a limit of two: the read is full, and "there are no more" is exactly
    // the sentence that cannot be supported here.
    expect(read.saturated).toBe(true);
  });

  it('does not filter on the notification TYPE, which is the sender\'s own word', async () => {
    const client = {
      async tool(): Promise<unknown> { return { items: [{ about: ABOUT, actor: BOT, type: 'Announce', summary: 's' }] }; },
    } as unknown as AgentPort;
    // A forger can put any `type` on a notice, so trusting it to filter would be trusting the one
    // field a forger controls. What decides is the six checks against the signed record.
    expect((await readRequests(client)).notices).toHaveLength(1);
  });
});

describe('iep:addressedTo in the signed region', () => {
  it('is written inside the entry, so a relayer cannot change who it is for', () => {
    const t = entryTurtle({
      streamIri: STREAM, workspace: WORKSPACE, seq: 1, body: 'hi', prior: null,
      author: { kind: 'principal', webId: ASKER_WEBID }, addressedTo: [ME],
    });
    expect(t).toContain('iep:addressedTo <' + ME + '>');
    // Same subject as the entry's own body and author — not a sidecar somebody could drop.
    expect(t.indexOf('iep:addressedTo')).toBeLessThan(t.indexOf('dct:description'));
  });

  it('is `iep:` and NOT `wsp:`, because an agent addressed outside a room reads the same predicate', () => {
    // ★ THE PREDICATE IS THE LAYERING, IN ONE STRING. A Foxxi record, a bare script's record and a
    // channel entry all have to spell "this is for you" the same way, or an agent crossing two of
    // them gets two answers to one question — and the verifier that reads it lives at the substrate
    // precisely so it works for an agent with no room. A `wsp:` term would have put it back out of
    // reach of every such agent while looking identical in this vertical's own tests.
    const t = entryTurtle({
      streamIri: STREAM, workspace: WORKSPACE, seq: 1, body: 'hi', prior: null,
      author: { kind: 'principal', webId: ASKER_WEBID }, addressedTo: [ME],
    });
    expect(t).not.toContain('wsp:addressedTo');
  });

  it('says nothing at all when nobody is addressed', () => {
    const t = entryTurtle({ streamIri: STREAM, workspace: WORKSPACE, seq: 1, body: 'hi', prior: null, author: { kind: 'principal', webId: ASKER_WEBID } });
    expect(t).not.toContain('addressedTo');
  });

  it('refuses an addressee that would close the IRI reference', () => {
    expect(() => entryTurtle({
      streamIri: STREAM, workspace: WORKSPACE, seq: 1, body: 'hi', prior: null,
      author: { kind: 'principal', webId: ASKER_WEBID },
      addressedTo: ['did:x:a> <' + STREAM + '/e/1> <urn:evil'],
    })).toThrow(/not serializable/);
  });

  it('deduplicates, so one addressee twice is not a region a reader has to decide about', () => {
    const t = entryTurtle({
      streamIri: STREAM, workspace: WORKSPACE, seq: 1, body: 'hi', prior: null,
      author: { kind: 'principal', webId: ASKER_WEBID }, addressedTo: [ME, ME],
    });
    expect(t.split('iep:addressedTo').length - 1).toBe(1);
    expect(t.split('<' + ME + '>').length - 1).toBe(1);
  });
});
