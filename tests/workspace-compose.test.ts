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
