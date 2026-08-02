/**
 * Composing many members' streams into one workspace view.
 *
 * The properties worth pinning here are all about what the view REFUSES to claim. A
 * composed feed is very easy to make look authoritative: sort everything by timestamp,
 * skip whatever failed to load, render. Each of those shortcuts produces a view that is
 * confidently wrong in a way nobody can see, so each has a test that fails if it comes
 * back.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  composeWorkspace,
  resolveCitations,
  describeCoverage,
  type ComposableMember,
} from '../applications/shared-workspace/src/compose.js';
import type { StreamDeps } from '../applications/shared-workspace/src/stream.js';

const WS = 'https://relay.test/ws/alpha';

const alice: ComposableMember = {
  principal: 'https://alice.test/profile#me',
  stream: 'https://alice.test/ws/alpha/stream',
  podUrl: 'https://alice.test/',
};
// ★ A DIFFERENT pod. The whole design exists so this is possible.
const bot: ComposableMember = {
  principal: 'did:web:agents.test:bot-7',
  stream: 'https://agents.test/ws/alpha/stream',
  podUrl: 'https://agents.test/',
};

interface Entry { url: string; at: string; prior?: string; cid?: string }

/** Build a manifest response for one pod, from a linear list of entries. */
const manifest = (stream: string, es: Entry[]) => ({
  entries: es.map(e => ({
    descriptorUrl: e.url,
    cid: e.cid ?? `cid-${e.url.slice(-3)}`,
    validFrom: e.at,
    supersedes: e.prior ? [e.prior] : [],
    describes: [stream],
  })),
});

/** Deps that answer per-pod, and can be told to fail for a given pod. */
function makeDeps(byPod: Record<string, unknown | Error>): StreamDeps {
  return {
    publish: vi.fn(),
    sleep: vi.fn(async () => {}),
    discover: vi.fn(async (args: Record<string, unknown>) => {
      const v = byPod[String(args.pod_url)];
      if (v instanceof Error) throw v;
      return (v ?? { entries: [] }) as Record<string, unknown>;
    }),
  };
}

const A = [
  { url: 'https://alice.test/c/a0.ttl', at: '2026-08-01T10:00:00Z' },
  { url: 'https://alice.test/c/a1.ttl', at: '2026-08-01T12:00:00Z', prior: 'https://alice.test/c/a0.ttl' },
];
const B = [
  { url: 'https://agents.test/c/b0.ttl', at: '2026-08-01T11:00:00Z' },
];

describe('composing across pods', () => {
  it('merges two members held on two different pods', async () => {
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': manifest(bot.stream, B),
    }));

    expect(view.complete).toBe(true);
    expect(view.entries).toHaveLength(3);
    // Advisory merge on validFrom: a0 (10:00), b0 (11:00), a1 (12:00).
    expect(view.entries.map(e => e.descriptorUrl)).toEqual([
      'https://alice.test/c/a0.ttl',
      'https://agents.test/c/b0.ttl',
      'https://alice.test/c/a1.ttl',
    ]);
    // Attribution survives the merge — an entry never loses whose stream it came from.
    expect(view.entries[1]!.principal).toBe(bot.principal);
  });

  it('★ position within the member\'s OWN stream is kept, because that order is verified', async () => {
    // The merged index is advisory; seqInStream is not. Keeping both lets a reader show
    // the feed while still being able to say what a member actually did, in order.
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': manifest(bot.stream, B),
    }));
    const mine = view.entries.filter(e => e.principal === alice.principal);
    expect(mine.map(e => e.seqInStream)).toEqual([0, 1]);
  });

  it('★ the view states that cross-stream order is advisory, unconditionally', async () => {
    // Not omittable. Anything consuming `entries` has to have seen the claim, because two
    // members' clocks can disagree and no merge fixes that.
    const view = await composeWorkspace({ workspace: WS, members: [alice] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
    }));
    expect(view.crossStreamOrderIsAdvisory).toBe(true);
  });

  it('the merge is deterministic when timestamps collide', async () => {
    // Without a tie-break the same inputs render differently on each read, and a feed that
    // reshuffles between refreshes is one people stop trusting without being able to say why.
    const sameTime = [
      { url: 'https://agents.test/c/z.ttl', at: '2026-08-01T10:00:00Z', cid: 'cid-zzz' },
    ];
    const deps = makeDeps({
      'https://alice.test/': manifest(alice.stream, [A[0]!]),
      'https://agents.test/': manifest(bot.stream, sameTime),
    });
    const first = await composeWorkspace({ workspace: WS, members: [alice, bot] }, deps);
    const second = await composeWorkspace({ workspace: WS, members: [bot, alice] }, deps);
    expect(first.entries.map(e => e.descriptorUrl)).toEqual(second.entries.map(e => e.descriptorUrl));
  });

  it('an undated entry sorts LAST, not first', async () => {
    // Missing is not early. Putting an undated entry at the top of a feed asserts a
    // recency nothing supports.
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': {
        entries: [{
          descriptorUrl: 'https://agents.test/c/undated.ttl', cid: 'c', validFrom: null,
          supersedes: [], describes: [bot.stream],
        }],
      },
    }));
    expect(view.entries[view.entries.length - 1]!.descriptorUrl).toBe('https://agents.test/c/undated.ttl');
  });
});

describe('★ partial availability is visible, never silent', () => {
  it('one unreachable pod costs that member\'s entries and nothing else', async () => {
    // The competitive property: when the single relay is down, a one-relay workspace is
    // entirely gone. Here it is one member's worth of gone.
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': new Error('ECONNREFUSED'),
    }));

    expect(view.entries).toHaveLength(2);
    expect(view.unavailable).toHaveLength(1);
    expect(view.unavailable[0]!.member.principal).toBe(bot.principal);
    expect(view.unavailable[0]!.reason).toMatch(/ECONNREFUSED/);
  });

  it('★ and the view is NOT complete, so a caller cannot render it as whole by accident', async () => {
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': new Error('gone'),
    }));
    expect(view.complete).toBe(false);
    expect(describeCoverage(view)).toMatch(/unreachable/);
  });

  it('★ an unreachable stream is not merged as an EMPTY one', async () => {
    // The subtle version of the same bug: catch the error, return [], carry on. The view
    // then says "this member has written nothing", which is a different claim entirely
    // and is false.
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': new Error('gone'),
    }));
    expect(view.streams.map(s => s.member.principal)).toEqual([alice.principal]);
  });

  it('a member who has genuinely written nothing IS complete', async () => {
    // The opposite direction: empty must not be mistaken for broken either.
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': { entries: [] },
    }));
    expect(view.complete).toBe(true);
    expect(view.streams).toHaveLength(2);
  });

  // ★ EVERY OTHER TEST IN THIS FILE BUILDS ITS MANIFEST WITH `manifest()`, WHICH SYNTHESISES
  // `describes` FROM THE STREAM IT WAS ASKED FOR — so the filter that drops foreign rows can
  // never fail there, and the gap below survived the whole suite. These build the response by
  // hand, which is the only way to make the filter discard everything.
  describe('★ a read that returns records, none of them this stream\'s, is not an idle member', () => {
    /** A manifest whose rows describe a DIFFERENT graph — the read landed on another stream. */
    const otherStream = {
      entries: [
        {
          descriptorUrl: 'https://agents.test/c/x0.ttl', cid: 'cid-x0', validFrom: '2026-08-01T11:00:00Z',
          supersedes: [], describes: ['https://agents.test/ws/BETA/stream'],
        },
        {
          descriptorUrl: 'https://agents.test/c/x1.ttl', cid: 'cid-x1', validFrom: '2026-08-01T11:30:00Z',
          supersedes: ['https://agents.test/c/x0.ttl'], describes: ['https://agents.test/ws/BETA/stream'],
        },
      ],
    };

    it('reports it, rather than folding it in as a member who has written nothing', async () => {
      const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
        'https://alice.test/': manifest(alice.stream, A),
        'https://agents.test/': otherStream,
      }));

      expect(view.unmatched).toHaveLength(1);
      expect(view.unmatched[0]!.member.principal).toBe(bot.principal);
      // The count is the discriminator: 2 records served, 0 of them this stream's.
      expect(view.unmatched[0]!.served).toBe(2);
      expect(view.unmatched[0]!.reason).toMatch(/written nothing/);
    });

    it('★ and the view is NOT complete, so it cannot be rendered as whole', async () => {
      // The defect exactly: reachable pod, successful read, every row filtered out, and the
      // view previously said complete: true with "0 entries from 1 of 1 streams".
      const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
        'https://alice.test/': manifest(alice.stream, A),
        'https://agents.test/': otherStream,
      }));
      expect(view.complete).toBe(false);
      expect(describeCoverage(view)).toMatch(/not idle/i);
    });

    it('★ a manifest with no `describes` at all is the same fault, not an empty stream', async () => {
      // The likelier shape in practice: the substrate answers with rows that carry no
      // `describes` key. Every row is discarded, and the member looks idle.
      const view = await composeWorkspace({ workspace: WS, members: [bot] }, makeDeps({
        'https://agents.test/': {
          entries: [{
            descriptorUrl: 'https://agents.test/c/b0.ttl', cid: 'c', validFrom: '2026-08-01T11:00:00Z',
            supersedes: [],
          }],
        },
      }));
      expect(view.unmatched).toHaveLength(1);
      expect(view.complete).toBe(false);
    });

    it('★ a trailing-slash mismatch on the stream IRI is reported, not silently empty', async () => {
      // `describes` is compared by exact string, so one slash is the difference between a
      // member's whole history and a member who appears to have written nothing.
      const view = await composeWorkspace({ workspace: WS, members: [bot] }, makeDeps({
        'https://agents.test/': {
          entries: [{
            descriptorUrl: 'https://agents.test/c/b0.ttl', cid: 'c', validFrom: '2026-08-01T11:00:00Z',
            supersedes: [], describes: [`${bot.stream}/`],
          }],
        },
      }));
      expect(view.unmatched).toHaveLength(1);
      expect(view.unmatched[0]!.served).toBe(1);
      expect(view.complete).toBe(false);
    });

    it('a genuinely empty pod is still NOT reported — the flag has to stay meaningful', async () => {
      // The other direction, and the one that decides whether this is worth having. If zero
      // records also flagged, `complete` would be false for every workspace with a member
      // who has not written yet, and a flag that is always false is a flag nobody reads.
      const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
        'https://alice.test/': manifest(alice.stream, A),
        'https://agents.test/': { entries: [] },
      }));
      expect(view.unmatched).toHaveLength(0);
      expect(view.complete).toBe(true);
    });

    it('an UNREACHABLE pod stays unavailable and is not double-reported as unmatched', async () => {
      // The read threw, so there is no served count to reason from. Naming the member in
      // both places would say two different things happened when one did.
      const view = await composeWorkspace({ workspace: WS, members: [bot] }, makeDeps({
        'https://agents.test/': new Error('ECONNREFUSED'),
      }));
      expect(view.unavailable).toHaveLength(1);
      expect(view.unmatched).toHaveLength(0);
    });

    it('entries served from ANOTHER pod stay misattributed, and are not also unmatched', async () => {
      // rows survived the stream filter and were dropped by the containment check instead.
      // That fact is already named once; naming it twice makes the report unreadable.
      const view = await composeWorkspace({ workspace: WS, members: [bot] }, makeDeps({
        'https://agents.test/': {
          entries: [{
            descriptorUrl: 'https://elsewhere.test/c/z.ttl', cid: 'c', validFrom: '2026-08-01T11:00:00Z',
            supersedes: [], describes: [bot.stream],
          }],
        },
      }));
      expect(view.misattributed).toHaveLength(1);
      expect(view.unmatched).toHaveLength(0);
      // nothing was stripped from the middle of a chain, so no consequential break
      expect(view.misattributed[0]!.brokeTheChain).toBe(false);
    });

    it('★ a foreign row in the MIDDLE is one fault, and the second report says it is a consequence', async () => {
      // Stripping the foreign row leaves its neighbours pointing at something no longer
      // present, so the member landed in `misattributed` AND `unverified` and the coverage
      // line read "1 read but NOT verified" — which says this member's log is forked. It is
      // not; the composer's own containment filter broke it. Reporting one fault twice, with
      // the second one mislabelled, makes the count of what is wrong unreadable.
      const view = await composeWorkspace({ workspace: WS, members: [bot] }, makeDeps({
        'https://agents.test/': {
          entries: [
            { descriptorUrl: 'https://agents.test/c/e0.ttl', cid: 'c0', validFrom: '2026-08-01T10:00:00Z', supersedes: [], describes: [bot.stream] },
            { descriptorUrl: 'https://elsewhere.test/c/e1.ttl', cid: 'c1', validFrom: '2026-08-01T11:00:00Z', supersedes: ['https://agents.test/c/e0.ttl'], describes: [bot.stream] },
            { descriptorUrl: 'https://agents.test/c/e2.ttl', cid: 'c2', validFrom: '2026-08-01T12:00:00Z', supersedes: ['https://elsewhere.test/c/e1.ttl'], describes: [bot.stream] },
          ],
        },
      }));
      expect(view.misattributed).toHaveLength(1);
      expect(view.unverified).toHaveLength(1);
      expect(view.misattributed[0]!.brokeTheChain).toBe(true);
      expect(view.misattributed[0]!.reason).toMatch(/the member's own log is not forked/);
    });

    it('★ the pod is read exactly ONCE — the count must not cost a second manifest read', async () => {
      // Catch-up is costed at one manifest read per member; buying this distinction with a
      // second read would spend the number the README publishes as the design's price.
      const deps = makeDeps({ 'https://agents.test/': otherStream });
      await composeWorkspace({ workspace: WS, members: [bot] }, deps);
      expect(vi.mocked(deps.discover)).toHaveBeenCalledTimes(1);
    });
  });

  it('every member unreachable yields an empty, explicitly incomplete view', async () => {
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': new Error('a'),
      'https://agents.test/': new Error('b'),
    }));
    expect(view.entries).toHaveLength(0);
    expect(view.complete).toBe(false);
    expect(view.unavailable).toHaveLength(2);
  });
});

describe('★ a stream that does not verify is withheld from the feed', () => {
  const FORKED = [
    { url: 'https://agents.test/c/b0.ttl', at: '2026-08-01T09:00:00Z' },
    { url: 'https://agents.test/c/b1.ttl', at: '2026-08-01T09:30:00Z', prior: 'https://agents.test/c/b0.ttl' },
    { url: 'https://agents.test/c/b2.ttl', at: '2026-08-01T09:40:00Z', prior: 'https://agents.test/c/b0.ttl' },
  ];

  it('a fork contributes nothing to the merged feed', async () => {
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': manifest(bot.stream, FORKED),
    }));
    expect(view.entries.every(e => e.principal === alice.principal)).toBe(true);
  });

  it('★ nor does a TRUNCATED stream, whose entries do order cleanly', async () => {
    // The discriminating case. A fork produces no ordering at all, so withholding it takes
    // no effort — an implementation with no guard would look correct here. A stream whose
    // first entry is missing orders perfectly and covers every row it has, and is still
    // not the member's history. Only an explicit intactness check keeps it out, and this
    // is the test that fails when that check is removed.
    const TRUNCATED = [
      { url: 'https://agents.test/c/b1.ttl', at: '2026-08-01T09:30:00Z', prior: 'https://agents.test/c/b0.ttl' },
      { url: 'https://agents.test/c/b2.ttl', at: '2026-08-01T09:40:00Z', prior: 'https://agents.test/c/b1.ttl' },
    ];
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': manifest(bot.stream, TRUNCATED),
    }));
    expect(view.unverified).toHaveLength(1);
    expect(view.unverified[0]!.report.danglingLinks).toHaveLength(1);
    expect(view.unverified[0]!.report.ordered).toHaveLength(2); // it DID order — and is still withheld
    expect(view.entries.every(e => e.principal === alice.principal)).toBe(true);
    expect(view.complete).toBe(false);
  });

  it('but it IS reported, with its heads, so someone can repair it', async () => {
    // Withholding silently would be the same failure as dropping an unreachable pod.
    const view = await composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps({
      'https://alice.test/': manifest(alice.stream, A),
      'https://agents.test/': manifest(bot.stream, FORKED),
    }));
    expect(view.unverified).toHaveLength(1);
    expect(view.unverified[0]!.report.heads).toHaveLength(2);
    expect(view.complete).toBe(false);
    expect(describeCoverage(view)).toMatch(/NOT verified/);
  });
});

describe('★ the two grades of ATTRIBUTION, and what the second one costs', () => {
  // `ComposedEntry.principal` was a label attached from the members list. Nothing in the read
  // path derived it, so the confident name beside every entry rested on whoever assembled the
  // inputs. These pin both grades — including the cheap one, because an honest label on a
  // cheap read is a result and not a failure, and it has to keep saying what it is.

  const aliceAgent = 'did:web:agents.test:alice-1';
  const botAgent = 'did:web:agents.test:bot-7';
  const signerOf = (s: string) =>
    ({ [aliceAgent]: alice.principal, [botAgent]: bot.principal } as Record<string, string>)[s] ?? null;

  /**
   * Deps that also answer get_descriptor, per descriptor URL, with the authorship block the
   * relay would return. `null` means the descriptor carries no proof at all.
   */
  function withDescriptors(
    byPod: Record<string, unknown>,
    signers: Record<string, string | null>,
  ): StreamDeps {
    return {
      ...makeDeps(byPod),
      getDescriptor: vi.fn(async (args: Record<string, unknown>) => {
        const url = String(args.url);
        const signedBy = signers[url];
        if (signedBy === undefined || signedBy === null) {
          return { url, turtle: '<> a iep:ContextDescriptor .' };
        }
        return {
          url,
          // Bound by the relay's own naming convention: the proof's urn terminal segment is
          // the descriptor's slug. Built the way the substrate builds it, not the way the
          // check reads it, so a check that only ever sees exact equality would fail here.
          turtle: '<> iep:authorshipProof [ iep:descriptorId '
            + `<urn:iep:pod:${url.split('/').pop()!.replace(/\.ttl$/, '')}> ] .`,
          authorship: { authorshipVerified: true, signedBy },
        };
      }),
    };
  }

  const allSigned = {
    'https://alice.test/c/a0.ttl': aliceAgent,
    'https://alice.test/c/a1.ttl': aliceAgent,
    'https://agents.test/c/b0.ttl': botAgent,
  };
  const bothPods = {
    'https://alice.test/': manifest(alice.stream, A),
    'https://agents.test/': manifest(bot.stream, B),
  };

  it('the default grade is ASSERTED, and it costs nothing extra', () => {
    return composeWorkspace({ workspace: WS, members: [alice, bot] }, makeDeps(bothPods)).then(view => {
      expect(view.attributionGrade).toBe('asserted');
      expect(view.descriptorReads).toBe(0);
      expect(view.unattested).toEqual([]);
      expect(describeCoverage(view)).toMatch(/attribution is ASSERTED/);
    });
  });

  it('★ verifying admits the entries and reports the grade AND the bill', async () => {
    // One get_descriptor per entry, on top of one manifest read per member. Asserted here
    // rather than described, because this is the number the README publishes as the design's
    // price and it is the one a caller has to decide about.
    const deps = withDescriptors(bothPods, allSigned);
    const view = await composeWorkspace(
      { workspace: WS, members: [alice, bot], verifyAuthorship: true, signerOf }, deps,
    );
    expect(view.attributionGrade).toBe('attested');
    expect(view.entries).toHaveLength(3);
    expect(view.descriptorReads).toBe(3);
    expect(vi.mocked(deps.getDescriptor!)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(deps.discover)).toHaveBeenCalledTimes(2); // still one manifest per member
    expect(view.complete).toBe(true);
  });

  it('★ an entry signed by SOMEONE ELSE is withheld and reported, never admitted', async () => {
    // The escalation in its post-containment form: the record really is served from alice's
    // pod, and alice did not publish it.
    const view = await composeWorkspace(
      { workspace: WS, members: [alice], verifyAuthorship: true, signerOf },
      withDescriptors(bothPods, { ...allSigned, 'https://alice.test/c/a1.ttl': botAgent }),
    );
    expect(view.entries.map(e => e.descriptorUrl)).toEqual(['https://alice.test/c/a0.ttl']);
    expect(view.unattested).toHaveLength(1);
    expect(view.unattested[0]!.entries[0]!.because).toMatch(new RegExp(`acts for ${bot.principal}`));
    expect(view.complete).toBe(false);
    expect(describeCoverage(view)).toMatch(/NOT attributable to the member named/);
  });

  it('★ an UNSIGNED entry is withheld too — every pre-existing entry is in this state', async () => {
    // Turning verification on for a workspace written before entries were signed withholds
    // all of it. That is the correct answer and an operationally violent one, which is
    // exactly why the grade is asked for rather than assumed.
    const view = await composeWorkspace(
      { workspace: WS, members: [alice], verifyAuthorship: true, signerOf },
      withDescriptors(bothPods, {}),
    );
    expect(view.entries).toHaveLength(0);
    expect(view.unattested[0]!.entries).toHaveLength(2);
    expect(view.unattested[0]!.entries[0]!.because).toMatch(/without sign_authorship/);
  });

  it('★ a withheld entry keeps its position, so the gap in the chain stays visible', async () => {
    // Renumbering the survivors would close the hole over a record the reader is entitled to
    // know is missing: alice's log would read 0,1 with entry 0 forged.
    const view = await composeWorkspace(
      { workspace: WS, members: [alice], verifyAuthorship: true, signerOf },
      withDescriptors(bothPods, { ...allSigned, 'https://alice.test/c/a0.ttl': botAgent }),
    );
    expect(view.unattested[0]!.entries[0]!.seqInStream).toBe(0);
    expect(view.entries[0]!.seqInStream).toBe(1);
  });

  it('a stream that does not verify is NOT also charged a descriptor read per entry', async () => {
    // It is withheld whole either way, so paying the expensive check on it spends the budget
    // on records that were never going to be admitted — and reports one fault twice.
    const FORKED = [
      { url: 'https://agents.test/c/b0.ttl', at: '2026-08-01T09:00:00Z' },
      { url: 'https://agents.test/c/b1.ttl', at: '2026-08-01T09:30:00Z', prior: 'https://agents.test/c/b0.ttl' },
      { url: 'https://agents.test/c/b2.ttl', at: '2026-08-01T09:40:00Z', prior: 'https://agents.test/c/b0.ttl' },
    ];
    const view = await composeWorkspace(
      { workspace: WS, members: [bot], verifyAuthorship: true, signerOf },
      withDescriptors({ 'https://agents.test/': manifest(bot.stream, FORKED) }, allSigned),
    );
    expect(view.descriptorReads).toBe(0);
    expect(view.unverified).toHaveLength(1);
    expect(view.unattested).toEqual([]);
  });

  it('★ asking to verify without a getDescriptor REJECTS — there is no half-verified view', async () => {
    // Deliberately not isolated per-stream like an unreachable pod. A missing dependency is a
    // programming error affecting every member equally, and reporting it as "these members
    // were unavailable" would let a caller carry on with a view whose remaining entries look
    // attested and were never checked.
    await expect(composeWorkspace(
      { workspace: WS, members: [alice], verifyAuthorship: true }, makeDeps(bothPods),
    )).rejects.toThrow(/one call per entry/);
  });
});

describe('citations into other verticals', () => {
  const cites = [
    { from: 'https://alice.test/c/a1.ttl', iri: 'https://foxxi.test/credential/7' },
    { from: 'https://alice.test/c/a1.ttl', iri: 'https://agp.test/plan/3' },
  ];

  it('reports what a cited record says it is, without copying it', async () => {
    const resolved = await resolveCitations(cites, async iri =>
      iri.includes('foxxi') ? { types: ['https://foxxi.test/ns#Credential'] } : { types: [] });
    expect(resolved[0]).toMatchObject({ resolved: true, types: ['https://foxxi.test/ns#Credential'] });
    // The result carries the IRI and the type — not the record. A copy would have no
    // authorship of its own and would drift the moment the source is superseded.
    expect(Object.keys(resolved[0]!).sort()).toEqual(['from', 'iri', 'resolved', 'types']);
  });

  it('★ an unresolvable citation is reported, never dropped', async () => {
    // Dropping makes an entry that cited something indistinguishable from one that cited
    // nothing — and "references a credential nobody can currently read" is the fact a
    // reader needs.
    const resolved = await resolveCitations(cites, async iri => {
      if (iri.includes('agp')) throw new Error('403 from the other vertical');
      return { types: [] };
    });
    expect(resolved).toHaveLength(2);
    expect(resolved[1]).toMatchObject({ resolved: false });
    expect(resolved[1]!.reason).toMatch(/403/);
  });

  it('one dead citation does not cost the others', async () => {
    const resolved = await resolveCitations(cites, async iri => {
      if (iri.includes('agp')) throw new Error('boom');
      return { types: ['x'] };
    });
    expect(resolved[0]!.resolved).toBe(true);
  });

  it('a record that reads as nothing is unresolved, not resolved-with-no-types', async () => {
    // null means "could not be read". Reporting that as a successful resolution with an
    // empty type list would claim the record exists and is untyped.
    const resolved = await resolveCitations([cites[0]!], async () => null);
    expect(resolved[0]!.resolved).toBe(false);
  });
});
