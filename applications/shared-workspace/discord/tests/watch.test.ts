/**
 * THE PRODUCER, AND THE THREE THINGS IT MUST NOT DO.
 *
 * ★ IT MUST NOT REPLAY A BACKLOG. A bot restarted at lunchtime that pushed the morning back into
 * the channel would be writing a second copy of a conversation into the place people are having it.
 * The first pass seeds and says nothing; that is the first test and the most important one.
 *
 * ★ IT MUST NOT SHOUT A PERSISTENT CONDITION EVERY 45 SECONDS. A forked log stays forked, and a
 * channel told about it once a minute forever is a channel people mute.
 *
 * ★ AND IT MUST NOT INVENT A CLAIM ABOUT AN AGENT. The silence notice is the one place the bot
 * says anything about an ask going unanswered, and every sentence in it is about the RECORD.
 */

import { describe, it, expect, vi } from 'vitest';
import { ChannelWatcher, BURST_MAX, SILENCE_MS, type WatchNews } from '../src/watch.js';
import { LinkStore } from '../src/links.js';
import type { ShowOut, ShownEntry } from '../src/workspace.js';

const RELAY = 'https://relay.interego.xwisee.com';
const POD = 'u-eth-8f3b8e939600';
const THREAD = '1400000000000000001';
const SLUG = 'd-' + THREAD;
const WORKSPACE = RELAY + '/ns/' + POD + '/' + SLUG;

const binding = {
  threadId: THREAD, convenerPod: POD, workspace: WORKSPACE, slug: SLUG,
  title: 'Roof decision', startedAt: 'now', startedBy: '1',
};

const AGENT = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-429728ca2933';

const entry = (n: number, over: Partial<ShownEntry> = {}): ShownEntry => ({
  pod: POD, seq: n, created: '2026-08-08T1' + n + ':00:00Z', body: 'entry ' + n,
  descriptorUrl: 'https://css.internal/' + POD + '/e' + n + '.ttl', author: null,
  derivedFrom: null, addressedTo: [], why: null, ...over,
});

/** An entry the ADDRESSED delegate composed, with its own key — the only thing that ends a wait. */
const byTheAgent = (n: number, over: Partial<ShownEntry> = {}): ShownEntry => entry(n, {
  author: {
    kind: 'delegate', agentId: AGENT, signer: { kind: 'the-author', signedBy: AGENT },
    footing: { kind: 'own-account' }, name: 'sam-scribe', authorised: true, scope: 'PublishOnly',
  },
  ...over,
});

const view = (entries: readonly ShownEntry[], streams: { pod: string; why: string | null }[] = []): ShowOut => ({
  kind: 'view', binding, entries,
  record: { head: { url: 'u', cid: null } as never, regionFound: true, withheld: false, sealedReadFailed: null, visibility: 'public' as const, convener: null, roleProfile: null, entryShape: null, grantCapability: null, title: 'Roof decision', authorship: null, convenerPod: POD, servedFrom: POD },
  fold: {
    seats: [{ graph: WORKSPACE, grantUrl: null, grantCid: null, role: null, grantedTo: null, pod: POD, seated: true, why: null, stream: RELAY + '/ns/' + POD + '/s' }],
    grantPod: POD, grantPodDerivedFrom: null, grantsFound: 1, grantsRead: 1, grantReadCap: 25,
  },
  streams: streams.map((s) => ({ pod: s.pod, stream: RELAY + '/ns/' + s.pod + '/s', total: 0, forked: !!s.why, partial: false, why: s.why })),
  truncated: false, totalEntries: entries.length,
});

/** Whatever the current test started, torn down in its `finally`. */
let stopper: (() => void) | null = null;
const stopAll = (): void => { stopper?.(); stopper = null; };

/**
 * A watcher whose sweep timer is effectively off, so every pass is driven by the test.
 *
 * ★ THE VIEW IS SUPPLIED, NOT FOLDED. What is under test is what the watcher DOES with a composed
 * view — seed, diff, bound, report once — and folding a real roster to get one would make these
 * tests fail for reasons that have nothing to do with any of that. `showWorkspace` has its own
 * coverage; this stubs at the seam between the two.
 */
function rig(views: readonly ShowOut[]): {
  watcher: ChannelWatcher; news: { channelId: string; news: WatchNews }[]; now: { ms: number };
} {
  const store = new LinkStore('C:\\nonexistent\\watch-test-' + Math.random().toString(36).slice(2) + '.json');
  (store as unknown as { save(): void }).save = (): void => { /* not persisted in a test */ };
  store.bindThread(binding);
  const news: { channelId: string; news: WatchNews }[] = [];
  const now = { ms: Date.parse('2026-08-08T12:00:00Z') };
  let i = 0;
  const watcher = new ChannelWatcher({
    store,
    withClient: (async () => views[Math.min(i++, views.length - 1)]) as never,
    watch: () => () => { /* the rig drives passes directly */ },
    emit: (channelId, n) => { news.push({ channelId, news: n }); },
    out: () => { /* the operator log is not what these assert */ },
    now: () => now.ms,
    interval: 10_000_000,
  });
  stopper = () => { watcher.stop(); };
  return { watcher, news, now };
}

/** Drive one pass and let its microtasks settle. */
async function pass(w: ChannelWatcher): Promise<void> {
  (w as unknown as { schedule(id: string, d: number): void }).schedule(THREAD, 0);
  await vi.advanceTimersByTimeAsync(3000);
}

describe('the first pass', () => {
  it('seeds without posting a single entry', async () => {
    vi.useFakeTimers();
    try {
      const r = rig([view([entry(1), entry(2), entry(3)])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(r.news).toHaveLength(0);
      expect(r.watcher.watching()).toEqual([THREAD]);
    } finally { vi.useRealTimers(); stopAll(); }
  });
});

describe('after it is seeded', () => {
  it('pushes only what is new, and pushes it once', async () => {
    vi.useFakeTimers();
    try {
      const r = rig([view([entry(1)]), view([entry(1), entry(2)]), view([entry(1), entry(2)])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);       // seed
      await pass(r.watcher);                          // entry 2 arrives
      await pass(r.watcher);                          // nothing new
      const pushed = r.news.filter((n) => n.news.kind === 'entries');
      expect(pushed).toHaveLength(1);
      const first = pushed[0]?.news;
      expect(first?.kind === 'entries' && first.entries.map((e) => e.seq)).toEqual([2]);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  it('collapses a burst into a count rather than shouting each one', async () => {
    vi.useFakeTimers();
    try {
      const many = [entry(2), entry(3), entry(4), entry(5), entry(6)];
      const r = rig([view([entry(1)]), view([entry(1), ...many])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      await pass(r.watcher);
      const kinds = r.news.map((n) => n.news.kind);
      expect(kinds).toContain('burst');
      expect(kinds).not.toContain('entries');
      const b = r.news.find((n) => n.news.kind === 'burst')?.news;
      expect(b?.kind === 'burst' && b.count).toBe(many.length);
      expect(many.length).toBeGreaterThan(BURST_MAX);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  it('reports an unreadable entry rather than skipping it silently', async () => {
    vi.useFakeTimers();
    try {
      const bad = entry(2, { body: null, why: 'this entry could not be read' });
      const r = rig([view([entry(1)]), view([entry(1), bad])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      await pass(r.watcher);
      expect(r.news.map((n) => n.news.kind)).toContain('unreadable-entry');
    } finally { vi.useRealTimers(); stopAll(); }
  });

  it('says a log is forked once, not every pass', async () => {
    vi.useFakeTimers();
    try {
      const forked = view([entry(1)], [{ pod: POD, why: 'has 2 unresolved heads' }]);
      const r = rig([view([entry(1)]), forked, forked]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      await pass(r.watcher);
      await pass(r.watcher);
      expect(r.news.filter((n) => n.news.kind === 'forked')).toHaveLength(1);
    } finally { vi.useRealTimers(); stopAll(); }
  });
});

describe('the silence notice', () => {
  it('fires only after the wait, and not at all once something lands from that pod', async () => {
    vi.useFakeTimers();
    try {
      const r = rig([view([entry(1)]), view([entry(1)])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      r.watcher.noteAsk({
        threadId: THREAD, descriptorUrl: 'https://css.internal/' + POD + '/ask.ttl', seq: 12,
        targetPod: POD, targetAgentId: AGENT, targetName: 'sam-scribe', askedAtMs: r.now.ms,
        presenceAtAsk: 'said it was running 41s ago',
      });
      // Not yet: the wait has not elapsed.
      (r.watcher as unknown as { reportSilence(): void }).reportSilence();
      expect(r.news.filter((n) => n.news.kind === 'silence')).toHaveLength(0);
      r.now.ms += SILENCE_MS + 1;
      (r.watcher as unknown as { reportSilence(): void }).reportSilence();
      const said = r.news.find((n) => n.news.kind === 'silence')?.news;
      expect(said?.kind === 'silence' && said.ask.seq).toBe(12);
      // And exactly once — `reported` is set, so a still-silent ask is not re-announced.
      (r.watcher as unknown as { reportSilence(): void }).reportSilence();
      expect(r.news.filter((n) => n.news.kind === 'silence')).toHaveLength(1);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  const ASK = 'https://css.internal/' + POD + '/ask.ttl';
  const noteAsk = (r: ReturnType<typeof rig>): void => {
    r.watcher.noteAsk({
      threadId: THREAD, descriptorUrl: ASK, seq: 12,
      targetPod: POD, targetAgentId: AGENT, targetName: 'sam-scribe', askedAtMs: r.now.ms,
      presenceAtAsk: 'running',
    });
  };
  const silences = (r: ReturnType<typeof rig>): number => r.news.filter((n) => n.news.kind === 'silence').length;
  const waitPastIt = (r: ReturnType<typeof rig>): void => {
    r.now.ms += SILENCE_MS + 1;
    (r.watcher as unknown as { reportSilence(): void }).reportSilence();
  };

  it('is cancelled by an entry that declares it was derived from the ask', async () => {
    vi.useFakeTimers();
    try {
      const answer = entry(2, { derivedFrom: ASK });
      const r = rig([view([entry(1)]), view([entry(1), answer])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      noteAsk(r);
      await pass(r.watcher);
      waitPastIt(r);
      expect(silences(r)).toBe(0);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  it('is cancelled by an entry the ADDRESSED agent composed, under its own key', async () => {
    vi.useFakeTimers();
    try {
      const r = rig([view([entry(1)]), view([entry(1), byTheAgent(2)])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      noteAsk(r);
      await pass(r.watcher);
      waitPastIt(r);
      expect(silences(r)).toBe(0);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  /**
   * ★ THE REGRESSION. This used to cancel on ANY readable entry from `targetPod` — the DELEGATOR's
   * pod — so the human typing "back from lunch" permanently suppressed the notice about their own
   * agent's unanswered ask. That is the exact case the notice exists for: an agent's host being off
   * is precisely when its human is the one still talking. Driven end to end through `announce`.
   */
  /**
   * ★★ AND A BUSY CHANNEL DID NOT COUNT AS AN ANSWER AT ALL.
   *
   * The ask-answered pass sat at the END of `announce`, BELOW the `return` in the burst branch.
   * A burst is what happens in a busy thread — which is the only kind of thread where several
   * things land in one round — so exactly there, the answer was never matched. The ask stayed
   * `reported: false`, and `reportSilence` went on to tell the channel that the agent had not
   * answered. About an ask it HAD answered, in a round where the answering entry was in the very
   * list being counted.
   *
   * ★ AND THE BURST CHANGES NOTHING ABOUT THE FACT. Bursting is a decision about OUTPUT — print
   * a count instead of the messages. Rate-limiting what is printed is not a reason to stop
   * reading what arrived.
   */
  it('★ is cancelled by an answer that arrived inside a BURST', async () => {
    vi.useFakeTimers();
    try {
      // Enough at once to trip the burst, with the real answer among them.
      const answer = entry(6, { derivedFrom: ASK });
      const many = [entry(2), entry(3), entry(4), entry(5), answer];
      const r = rig([view([entry(1)]), view([entry(1), ...many])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      noteAsk(r);
      await pass(r.watcher);

      // It really did burst — otherwise this asserts nothing about the branch it is about.
      expect(r.news.map((n) => n.news.kind), 'this round did not burst, so the case was not exercised')
        .toContain('burst');
      expect(many.length).toBeGreaterThan(BURST_MAX);

      // ★ THE LOAD-BEARING ASSERTION.
      waitPastIt(r);
      expect(silences(r), 'the channel was told the agent never answered, in the round it answered in').toBe(0);
      expect(r.watcher.pending()).toHaveLength(0);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  it('★ and a burst carrying no answer still reaches the silence notice', async () => {
    // The other half: hoisting the pass must not mark everything answered just because a lot
    // arrived. Same burst, same count, nothing in it derived from the ask or written by the agent.
    vi.useFakeTimers();
    try {
      const many = [entry(2), entry(3), entry(4), entry(5), entry(6)];
      const r = rig([view([entry(1)]), view([entry(1), ...many])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      noteAsk(r);
      await pass(r.watcher);
      expect(r.news.map((n) => n.news.kind)).toContain('burst');
      waitPastIt(r);
      expect(silences(r), 'a busy channel silenced a notice about an ask nobody answered').toBe(1);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  it('★ is NOT cancelled by their HUMAN saying something unrelated in the same channel', async () => {
    vi.useFakeTimers();
    try {
      const chat = entry(2, {
        body: 'unrelated: back from lunch',
        author: { kind: 'principal', webId: 'https://identity.example/users/' + POD + '/profile#me', signer: { kind: 'not-established', why: 'x' } },
      });
      const r = rig([view([entry(1)]), view([entry(1), chat])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      noteAsk(r);
      await pass(r.watcher);                          // the HUMAN speaks, from the target's pod
      expect(r.news.some((n) => n.news.kind === 'entries')).toBe(true);
      expect(r.watcher.pending()).toHaveLength(1);
      waitPastIt(r);
      expect(silences(r)).toBe(1);
    } finally { vi.useRealTimers(); stopAll(); }
  });

  /**
   * ★ AND NOT BY A DIFFERENT AGENT ON THAT POD EITHER. A person may authorise several delegates;
   * one of them answering says nothing about the one that was asked.
   */
  it('★ is NOT cancelled by a DIFFERENT delegate of the same person answering', async () => {
    vi.useFakeTimers();
    try {
      const other = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-000000000001';
      const bySomeoneElse = entry(2, {
        author: {
          kind: 'delegate', agentId: other, signer: { kind: 'the-author', signedBy: other },
          footing: { kind: 'own-account' }, name: 'other-scribe', authorised: true, scope: 'PublishOnly',
        },
      });
      const r = rig([view([entry(1)]), view([entry(1), bySomeoneElse])]);
      r.watcher.start();
      await vi.advanceTimersByTimeAsync(3000);
      noteAsk(r);
      await pass(r.watcher);
      waitPastIt(r);
      expect(silences(r)).toBe(1);
    } finally { vi.useRealTimers(); stopAll(); }
  });
});

describe('the store', () => {
  it('enumerates threads so a watcher can find what to follow without being told', () => {
    const s = new LinkStore('C:\\nonexistent\\watch-store-' + Math.random().toString(36).slice(2) + '.json');
    (s as unknown as { save(): void }).save = (): void => { /* not persisted in a test */ };
    expect(s.allThreads()).toHaveLength(0);
    s.bindThread(binding);
    expect(s.allThreads().map((t) => t.threadId)).toEqual([THREAD]);
    s.unbindThread(THREAD);
    expect(s.allThreads()).toHaveLength(0);
  });
});
