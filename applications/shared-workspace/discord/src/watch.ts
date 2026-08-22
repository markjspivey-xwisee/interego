/**
 * THE PRODUCER THIS BOT DID NOT HAVE.
 *
 * ★ NOTHING PUSHED WORKSPACE ACTIVITY INTO DISCORD. The only `setInterval` in the whole bot was the
 * gateway heartbeat, and `/workspace show` pulled on demand. So a delegate could read the channel,
 * think on its human's own subscription and append a signed answer to its human's own pod — and
 * Discord would never show it. Somebody would have to type `/workspace show` and happen to look.
 * A channel where half the participants are agents and the agents are invisible is not a channel
 * they are in.
 *
 * ── COMPOSED OUT OF THE TWO THINGS THAT ALREADY EXIST ────────────────────────
 *
 *   · `pollingWatch` — a 45-second re-read that fires ONLY WHEN THE ANSWER CHANGES. The desktop
 *     shell already drives its entire stream view off it, one watch per seated participant. This
 *     registers the same watches. It is a poll and that is not a disguise: the measurement behind
 *     `RelayMcpTransport.watchTool` establishes there is nothing to subscribe to on this relay.
 *   · `showWorkspace` — the SAME function `/workspace show` calls. A change fires the watch and the
 *     watch calls that, so the pushed line and the pulled line can never disagree about what the
 *     record says. A second reader written for pushing would drift from the first one the day
 *     somebody fixed a bug in either.
 *
 * ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────
 *
 * ★ IT NEVER POSTS A BACKLOG. The first read of a thread SEEDS what has been seen without posting
 * any of it. A bot restarted at lunchtime that replayed the morning into the channel would be
 * writing a second copy of a conversation into the place people are having it.
 *
 * ★ IT NEVER SAYS AN AGENT IS THINKING, OR REFUSED, OR IS ABOUT TO ANSWER. It reads pods. Every
 * sentence it produces is a fact about a document or a constant of its own behaviour — the rule
 * `render.ts` already sets, and the reason the silence notice below is phrased as a statement about
 * the RECORD rather than about anybody's agent.
 */

import { pollingWatch, type Unsubscribe } from '@interego/workspace-client';
import type { LinkStore, ThreadBinding } from './links.js';
import { showWorkspace, type Deps, type ShowOut, type ShownEntry } from './workspace.js';
import { askCandidates, type CandidatesOut } from './ask.js';

/**
 * The watch cadence, matched to the desktop's so two readers of one channel see the same news.
 *
 * ★ THIS IS NOW THE SWEEP CADENCE, NOT THE READ CADENCE. `pollingWatch` owns how often a channel
 * is READ — a quiet ceiling that drops to seconds while a conversation is live — because a number
 * pinned here would freeze the bot at one speed while the desktop adapted, and the two ends of a
 * conversation polling at different rates is how one of them looks broken.
 *
 * What this still governs is `adopt()`: how often the bot looks for THREADS it should be watching
 * at all, which is a different question and does not need to be fast.
 */
export const WATCH_INTERVAL_MS = 45_000;

/**
 * How long after a fired watch the composed read runs.
 *
 * Several members' logs change within a second of each other all the time — an ask and its answer,
 * two people typing. Reading once per fire would fold the same workspace three times and post the
 * same three entries in three messages.
 */
export const COALESCE_MS = 1_500;

/** How often the roster is re-folded even when nothing fired: how a NEW member gets watched. */
export const REFOLD_EVERY = 8;

/** The most entries pushed into one thread in one window before they are collapsed into a count. */
export const BURST_MAX = 3;
export const BURST_WINDOW_MS = 60_000;

/**
 * How long an addressed ask may sit with nothing written in answer before the channel is told.
 *
 * ★ THE WORST OUTCOME IS SILENCE AND IT IS HANDLED EXPLICITLY. `decideTurn` refuses by writing
 * NOTHING — correctly; a delegate that posted "I have decided not to answer" would be appending
 * noise to somebody's permanent log — and an agent that read the ask and judged there was nothing
 * to add also writes nothing. From here those are the same, so the notice says exactly that and
 * makes no claim about the agent.
 */
export const SILENCE_MS = 10 * 60_000;

/** One new entry the channel has not been shown yet. */
export interface PushedEntry { readonly entry: ShownEntry; readonly workspaceTitle: string }

/** An ask this bot wrote and is waiting to see answered. */
export interface PendingAsk {
  readonly threadId: string;
  readonly descriptorUrl: string;
  readonly seq: number;
  /** The DELEGATOR's pod. Reported in the notice; NOT what decides whether it was answered. */
  readonly targetPod: string;
  /** The agent the ask was addressed to. An answer is one of ITS entries, or one derived from it. */
  readonly targetAgentId: string;
  readonly targetName: string;
  readonly askedAtMs: number;
  /** What the target's presence said at the moment of asking. Reported verbatim, never re-derived. */
  readonly presenceAtAsk: string;
  reported: boolean;
}

/** What the watcher decided to say about one thread on one pass. Rendered elsewhere. */
export type WatchNews =
  | { readonly kind: 'entries'; readonly binding: ThreadBinding; readonly entries: readonly ShownEntry[] }
  | { readonly kind: 'burst'; readonly binding: ThreadBinding; readonly count: number }
  | { readonly kind: 'forked'; readonly binding: ThreadBinding; readonly pod: string; readonly why: string }
  | { readonly kind: 'unreadable-entry'; readonly binding: ThreadBinding; readonly why: string }
  | { readonly kind: 'silence'; readonly binding: ThreadBinding; readonly ask: PendingAsk; readonly waitedMs: number };

export interface WatchDeps {
  readonly store: LinkStore;
  /** Builds the substrate deps for a live client. `main` supplies `session.call` around it. */
  readonly withClient: <T>(fn: (deps: Deps) => Promise<T>) => Promise<T>;
  /** Registers a change-only watch. `main` binds the session's transport. */
  readonly watch: (
    name: string, input: Record<string, unknown>, onChange: () => void,
    onError?: (why: string) => void,
  ) => Unsubscribe | null;
  readonly emit: (channelId: string, news: WatchNews) => void | Promise<void>;
  readonly out: (line: string) => void;
  readonly now?: () => number;
  readonly interval?: number;
}

/**
 * The picker's candidates as of one background pass, with the moment they were read.
 *
 * Narrowed to the `candidates` variant on purpose: only a pass that actually produced a list is
 * stored, so a caller never has to re-handle "not a workspace" from a stale snapshot of a thread
 * that plainly is one.
 */
export interface CandidateSnapshot {
  readonly at: number;
  readonly out: Extract<CandidatesOut, { kind: 'candidates' }>;
}

interface ThreadState {
  seeded: boolean;
  /**
   * The last candidate list this thread's background pass computed, for the Ask picker.
   *
   * ★ BECAUSE THE PICKER HAS THREE SECONDS AND NO DEFERRAL, AND THE LIVE READ TAKES SIX.
   * Measured 2026-08-11 on a real workspace: `discover_context` 1820 ms for 769 descriptors,
   * `foldRoster` 4298 ms, one registry read 500 ms, one presence read 1827 ms — 6625 ms against a
   * 3000 ms budget, which Discord renders as "loading options failed" with no explanation. The
   * scan grew when its 400-descriptor cap was removed; the cap was hiding members, so it is not
   * coming back.
   *
   * ★ AND A SNAPSHOT IS SAFE HERE FOR A REASON THAT IS NOT "it is probably fresh enough". `ask()`
   * RE-RESOLVES the typed value against the delegator's own pod before it writes anything, and
   * refuses a delegate that has been revoked or is no longer write-eligible. The picker is a
   * convenience; the authority is re-read at the moment of the ask. So the worst a stale snapshot
   * can do is offer a name that is then refused with a reason — never write a wrong ask.
   */
  candidates: CandidateSnapshot | null;
  /** Descriptor URLs already shown in this thread. Bounded — see `remember`. */
  readonly posted: Set<string>;
  /** Stream keys currently watched, so a re-fold adds and removes rather than re-registering all. */
  readonly watches: Map<string, Unsubscribe>;
  /** Timestamps of pushes in this thread, for the burst bound. */
  pushes: number[];
  /** Findings already reported once, so a persistent fork is not shouted every 45 seconds. */
  readonly told: Set<string>;
  ticks: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  /** A change arrived while a read was in flight: read again when it finishes. */
  dirty: boolean;
}

/** Keep the seen-set from growing without bound in a channel that runs for months. */
const REMEMBER_MAX = 500;

/**
 * One watcher for every thread this bot has been told about.
 *
 * ★ THREADS ARE ENUMERATED FROM THE STORE ON EVERY SWEEP, so a `/workspace start` in a new thread
 * is picked up without anything having to call in here. The store is the bot's own index and losing
 * all of it loses nothing — which is exactly why the watcher reads it rather than holding its own
 * copy of which threads exist.
 */
export class ChannelWatcher {
  private readonly deps: WatchDeps;
  private readonly threads = new Map<string, ThreadState>();
  private readonly asks: PendingAsk[] = [];
  private sweep: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly interval: number;

  constructor(deps: WatchDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.interval = deps.interval ?? WATCH_INTERVAL_MS;
  }

  start(): void {
    if (this.sweep) return;
    this.adopt();
    this.sweep = setInterval(() => { this.adopt(); }, this.interval);
    this.sweep.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweep) { clearInterval(this.sweep); this.sweep = null; }
    for (const st of this.threads.values()) {
      if (st.timer) clearTimeout(st.timer);
      for (const un of st.watches.values()) un();
      st.watches.clear();
    }
    this.threads.clear();
  }

  /**
   * Record an ask so the channel can be told if nothing is ever written in answer.
   *
   * Held in memory only, and deliberately: it is a courtesy notice, not a record. The record is the
   * entry, which is on a pod and outlives every process here.
   */
  noteAsk(ask: Omit<PendingAsk, 'reported'>): void {
    this.asks.push({ ...ask, reported: false });
    // Bounded the same way the seen-set is: an unbounded list of courtesies is a leak.
    if (this.asks.length > REMEMBER_MAX) this.asks.splice(0, this.asks.length - REMEMBER_MAX);
  }

  /** Threads currently watched. Exported for the operator log and for tests. */
  watching(): readonly string[] { return [...this.threads.keys()]; }

  /**
   * Asks still waiting to be seen answered.
   *
   * Read-only, and a copy: this list is a courtesy the watcher owns, and a caller that could
   * mutate it could silence a notice about somebody's unanswered request from outside the one
   * place that decides whether to send one.
   */
  pending(): readonly PendingAsk[] { return this.asks.filter((a) => !a.reported).map((a) => ({ ...a })); }

  private adopt(): void {
    if (this.stopped) return;
    for (const b of this.deps.store.allThreads()) {
      if (this.threads.has(b.threadId)) continue;
      this.threads.set(b.threadId, {
        seeded: false, candidates: null, posted: new Set(), watches: new Map(), pushes: [], told: new Set(),
        ticks: 0, timer: null, running: false, dirty: false,
      });
      this.deps.out('watch: following thread ' + b.threadId + ' (' + b.workspace + ')');
      this.schedule(b.threadId, 0);
    }
    // A thread whose binding is gone is dropped, and its watches with it.
    const live = new Set(this.deps.store.allThreads().map((b) => b.threadId));
    for (const [id, st] of this.threads) {
      if (live.has(id)) continue;
      if (st.timer) clearTimeout(st.timer);
      for (const un of st.watches.values()) un();
      this.threads.delete(id);
    }
    // The slow tick, so a member who joins is watched without anything having changed on a log this
    // bot is already looking at — the one case a change-only watch cannot see by construction.
    for (const [id, st] of this.threads) {
      st.ticks++;
      if (st.ticks % REFOLD_EVERY === 0) this.schedule(id, 0);
    }
    this.reportSilence();
  }

  private schedule(threadId: string, delay: number): void {
    const st = this.threads.get(threadId);
    if (!st || this.stopped) return;
    if (st.running) { st.dirty = true; return; }
    if (st.timer) return;
    st.timer = setTimeout(() => { st.timer = null; void this.pass(threadId); }, delay);
    st.timer.unref?.();
  }

  private async pass(threadId: string): Promise<void> {
    const st = this.threads.get(threadId);
    const binding = this.deps.store.threadOf(threadId);
    if (!st || !binding || this.stopped) return;
    st.running = true;
    let view: ShowOut;
    try { view = await this.deps.withClient((d) => showWorkspace(d, threadId)); }
    catch (e) {
      // ★ REPORTED TO THE OPERATOR AND NOT TO THE CHANNEL. A read that failed says nothing about
      // the record, and a bot that announced every transient 502 into a conversation would be
      // noise nobody could act on. The next pass is the retry.
      this.deps.out('watch: reading ' + threadId + ' failed — ' + ((e as Error)?.message ?? String(e)));
      st.running = false;
      if (st.dirty) { st.dirty = false; this.schedule(threadId, COALESCE_MS); }
      return;
    }
    st.running = false;
    if (view.kind === 'view') {
      this.rewatch(threadId, st, view);
      this.announce(threadId, st, binding, view);
      // ★ AFTER THE PUSH, NEVER BEFORE IT. Refreshing the picker is a convenience; getting an
      // entry into the channel is the job, and one must not delay the other.
      void this.refreshCandidates(threadId, st);
    } else if (view.kind === 'unreadable' && !st.told.has('unreadable')) {
      st.told.add('unreadable');
      this.deps.out('watch: ' + threadId + ' is bound to a workspace that does not read — ' + view.why);
    }
    if (st.dirty) { st.dirty = false; this.schedule(threadId, COALESCE_MS); }
  }

  /**
   * The picker's candidates as of the last background pass, or null if none has completed.
   *
   * Null is a real answer and the caller must render it as one — "still reading this channel" is
   * different from "nobody here has an agent", and a picker that collapsed them would tell
   * somebody their delegate does not exist thirty seconds after they authorised it.
   */
  candidatesFor(threadId: string): CandidateSnapshot | null {
    return this.threads.get(threadId)?.candidates ?? null;
  }

  /**
   * Re-read who could be asked something here, off the critical path.
   *
   * ★ THE READS ARE THE SAME ONES THE PICKER USED TO DO INLINE. Nothing is cheaper or weaker
   * here; it has simply moved to a place with a 45-second budget instead of a three-second one.
   * A failure is swallowed deliberately: the previous snapshot stays, and its age is carried so
   * the caller can say how old it is rather than presenting it as current.
   */
  private async refreshCandidates(threadId: string, st: ThreadState): Promise<void> {
    try {
      const out = await this.deps.withClient((d) => askCandidates(d, { threadId, discordUserId: '' }));
      if (out.kind === 'candidates') st.candidates = { at: this.now(), out };
    } catch (e) {
      this.deps.out('watch: could not refresh the ask picker for ' + threadId + ' — '
        + ((e as Error)?.message ?? String(e)));
    }
  }

  /**
   * Register a change-only watch on every seated member's log, and drop the ones that left.
   *
   * ★ THE WATCH IS THE TRIGGER AND `showWorkspace` IS THE READER. The payload a watch delivers is
   * not rendered — it is a manifest, and rendering one would be a second, weaker version of the
   * fold. All it is used for is knowing that something moved.
   */
  private rewatch(threadId: string, st: ThreadState, view: Extract<ShowOut, { kind: 'view' }>): void {
    const wanted = new Map<string, { pod: string; stream: string }>();
    for (const s of view.fold.seats) {
      if (!s.seated || !s.stream || !s.pod) continue;
      const pod = s.podServed ?? s.pod;
      wanted.set(pod + ' ' + s.stream, { pod, stream: s.stream });
    }
    for (const [key, un] of st.watches) if (!wanted.has(key)) { un(); st.watches.delete(key); }
    for (const [key, w] of wanted) {
      if (st.watches.has(key)) continue;
      const un = this.deps.watch(
        'discover_context',
        { pod_name: w.pod, graph_iri: w.stream, sort: 'oldest-first' },
        () => { this.schedule(threadId, COALESCE_MS); },
        // ★ A FAILING WATCH IS A REASON TO LOOK, NOT A REASON TO WAIT. Said once per stream so a
        // persistent outage is not shouted every 45 seconds, and a read is scheduled anyway: the
        // alternative — what this did before — is a watch that fails forever in silence while the
        // channel falls back to the six-minute re-fold with nothing anywhere saying why.
        (why) => {
          const key = 'watcherr ' + w.stream;
          if (!st.told.has(key)) {
            st.told.add(key);
            this.deps.out('watch: the live watch on ' + w.stream + ' is failing (' + why
              + '); this thread is falling back to the periodic re-fold until it recovers');
          }
          this.schedule(threadId, COALESCE_MS);
        },
      );
      // A transport that registers no watch is not a failure to shout about — the sweep above
      // re-folds every REFOLD_EVERY ticks regardless, so the thread still catches up. It is said
      // once so an operator knows why the channel is slower than it should be.
      if (un) st.watches.set(key, un);
      else if (!st.told.has('nowatch')) { st.told.add('nowatch'); this.deps.out('watch: this transport registered no live watch for ' + w.stream + '; the slow re-fold is the only producer'); }
    }
  }

  private announce(threadId: string, st: ThreadState, binding: ThreadBinding, view: Extract<ShowOut, { kind: 'view' }>): void {
    const fresh = view.entries.filter((e) => !st.posted.has(e.descriptorUrl));
    for (const e of fresh) this.remember(st, e.descriptorUrl);
    if (!st.seeded) {
      // ★ THE FIRST PASS SEEDS AND SAYS NOTHING. See the header.
      st.seeded = true;
      this.deps.out('watch: ' + threadId + ' seeded with ' + view.entries.length + ' entr' + (view.entries.length === 1 ? 'y' : 'ies') + ' already in the record');
      return;
    }
    // Findings about a log, said once each rather than every 45 seconds.
    for (const s of view.streams) {
      if (!s.why) continue;
      const key = 'stream:' + s.pod + ':' + s.why;
      if (st.told.has(key)) continue;
      st.told.add(key);
      void this.deps.emit(threadId, { kind: 'forked', binding, pod: s.pod, why: s.why });
    }
    const unreadable = fresh.filter((e) => e.why);
    const readable = fresh.filter((e) => !e.why && (e.body ?? '').trim());
    for (const u of unreadable) void this.deps.emit(threadId, { kind: 'unreadable-entry', binding, why: u.why as string });
    if (!readable.length) return;
    /**
     * ★★ WHETHER AN ASK WAS ANSWERED IS DECIDED BEFORE ANYTHING IS PRINTED, AND USED NOT TO BE.
     *
     * This pass lived at the END of the method, below a `return` in the burst branch. So in a
     * busy thread — the only situation a burst exists for — an answer that arrived in the same
     * round was never matched, the ask stayed `reported: false`, and `reportSilence` later told
     * the channel the agent had not answered. About an ask it HAD answered, in a round where the
     * answering entry was in this very list.
     *
     * ★ AND THE BURST CHANGES NOTHING ABOUT THE FACT. `readable` is the same list either way;
     * bursting only changes how it is PRINTED — a count instead of the messages. Rate-limiting
     * output is not a reason to stop reading it.
     */
    this.markAnswered(threadId, readable);
    const now = this.now();
    st.pushes = st.pushes.filter((t) => now - t < BURST_WINDOW_MS);
    if (st.pushes.length + readable.length > BURST_MAX) {
      st.pushes.push(now);
      void this.deps.emit(threadId, { kind: 'burst', binding, count: readable.length });
      return;
    }
    for (const _ of readable) st.pushes.push(now);
    void this.deps.emit(threadId, { kind: 'entries', binding, entries: readable });
  }

  /**
   * End the wait on any ask these entries answer.
   *
   * ★ AN ASK IS ANSWERED BY AN ENTRY THAT SAYS SO, NOT BY ITS TARGET'S POD BEING ALIVE. This used
   * to cancel on ANY readable entry from `a.targetPod` — the DELEGATOR's pod — so the person
   * typing "back from lunch" permanently silenced the notice about their own agent's unanswered
   * ask. That is precisely the case the notice exists for: an agent's host being off is exactly
   * when its human is the one still talking. Two things end the wait, and both are statements
   * about the ask:
   *
   *   · an entry declaring `prov:wasDerivedFrom` the ask's own descriptor — the same derivation
   *     `verifyRequest`'s sixth check reads, so "answered" means one thing in both places; or
   *   · an entry composed by the ADDRESSED AGENT, which is a claim held down by that agent's own
   *     signature — see `judgeAuthorship`, which returns `delegate` only where the key that
   *     signed the bytes is the agent the entry names.
   */
  private markAnswered(threadId: string, readable: readonly ShownEntry[]): void {
    for (const a of this.asks) {
      if (a.threadId !== threadId) continue;
      const answered = readable.some((e) => e.derivedFrom === a.descriptorUrl
        || (e.author?.kind === 'delegate' && e.author.agentId === a.targetAgentId));
      if (answered) a.reported = true;
    }
  }

  private remember(st: ThreadState, url: string): void {
    st.posted.add(url);
    if (st.posted.size > REMEMBER_MAX) {
      // Sets iterate in insertion order, so the oldest go first — and the ones being dropped are
      // by construction the ones furthest below the render cap, which cannot come back as "new".
      const drop = st.posted.size - REMEMBER_MAX;
      let i = 0;
      for (const k of st.posted) { if (i++ >= drop) break; st.posted.delete(k); }
    }
  }

  private reportSilence(): void {
    const now = this.now();
    for (const a of this.asks) {
      if (a.reported || now - a.askedAtMs < SILENCE_MS) continue;
      a.reported = true;
      const binding = this.deps.store.threadOf(a.threadId);
      if (!binding) continue;
      void this.deps.emit(a.threadId, { kind: 'silence', binding, ask: a, waitedMs: now - a.askedAtMs });
    }
  }
}

/**
 * Bind `pollingWatch` to a client, for `main` to hand to the watcher.
 *
 * ★ THE PAYLOAD IS DISCARDED HERE ON PURPOSE. What the watcher wants is the EDGE — `pollingWatch`
 * fires only when `JSON.stringify(payload)` changes, and that is the whole of the signal. Passing
 * the payload on would invite a caller to render it, which is the second reader this file exists
 * to not have.
 */
/**
 * ★ THE CLIENT IS FETCHED PER POLL, AND AN ERROR IS REPORTED RATHER THAN DROPPED.
 *
 * Both halves of this were wrong and together they cost the push its whole point.
 *
 * MEASURED 2026-08-11: an entry written at 01:46:12 reached the channel at 01:51:28 — 5m16s,
 * against a 45-second watch cadence. The read itself is not slow (86 ms, payload stable across
 * repeats), and 316s sits just under `REFOLD_EVERY × WATCH_INTERVAL_MS` = 360s. So the change
 * watch never fired at all and the SIX-MINUTE safety re-fold is what delivered it.
 *
 *   1. THE CLIENT WAS CAPTURED AT REGISTRATION — `watchVia(session.current.client)` binds one
 *      client for the life of the watch. The bot re-mints its session (bearer expiry, or a relay
 *      that restarted underneath it, which happened at 21:50 the same evening). Every poll after
 *      that used a client whose session was gone. It now takes a READ FUNCTION, so each poll goes
 *      wherever the caller sends it and a re-mint heals the watch instead of orphaning it.
 *
 *      ★★ AND THAT READ NOW GOES THROUGH `session.call`, WHICH IS WHY THE BOT USED TO BE REJECTED
 *      ONCE AN HOUR. A getter returns whatever bearer is current; it does not RENEW one. The
 *      pre-emptive re-mint lives in `call()`, and only Discord commands went through it — while
 *      the watches poll every 45 s and are therefore, in any quiet channel, always the first
 *      caller after the hour is up. So the reliable sequence was: bearer expires, a watch poll
 *      401s, the transport's reauthorizer re-mints and logs "session token was rejected", every
 *      hour, forever. Nothing was broken — the reactive path was doing its job because the
 *      pre-emptive one was never consulted. Routing the read through `call()` means expiry is
 *      noticed BEFORE the request, and the 401 path goes back to being what it is for: a relay
 *      that was replaced underneath us.
 *
 *      ★ It also means every watch can trigger a re-mint at the same instant, which is why
 *      `BotSession.open()` is single-flight.
 *
 *   2. ERROR EVENTS WERE DISCARDED — `if (ev.type === 'data') onChange()` and nothing else. A
 *      watch failing every 45 seconds forever is then indistinguishable from a channel where
 *      nothing is happening: no push, no log, no signal of any kind. `pollingWatch` faithfully
 *      reports each failure and this threw them away.
 *
 * A failure now reaches the caller, which says so ONCE per watch and schedules a read anyway —
 * because "I could not tell whether anything changed" is a reason to look, not a reason to wait
 * six minutes.
 */
export const watchVia = (read: (name: string, input: Record<string, unknown>) => Promise<unknown>) =>
  (
    name: string, input: Record<string, unknown>, onChange: () => void,
    onError?: (why: string) => void,
  ): Unsubscribe | null =>
    pollingWatch(
      read,
      name, input,
      (ev) => {
        if (ev.type === 'data') onChange();
        else onError?.(ev.error?.message ?? ev.error?.code ?? 'no reason reported');
      },
      // ★ The shared default owns the read cadence — see WATCH_INTERVAL_MS above. Pinning the
      // sweep interval here froze the bot at 45 s while the desktop adapted.
    );
