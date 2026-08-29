/**
 * The recent-activity ring, KEYED BY POD — because the one it replaced was not keyed by
 * anything, and every reader of it broadcast one pod's write activity to whoever asked.
 *
 * ── WHAT WAS MEASURED, ON THE DEPLOYED RELAY ─────────────────────────────────
 *
 * `server.ts` held `let notificationLog: ContextChangeEvent[] = []` — ONE process-global
 * array that `emitNotification` appended to for EVERY pod the relay served. Two surfaces
 * read it, and neither had any notion of who was asking:
 *
 *   GET /sse                              `notificationLog.slice(-5)`, every 2 s
 *   get_pod_status → recentNotifications  `notificationLog.slice(-10)`
 *
 * Reproduced against https://relay.interego.xwisee.com with two disposable wallets minted
 * for the run, neither with any relationship to the other or to any existing pod
 * (`tools/probe-notification-scope-live.ts`). Identity A opened `/sse`; identity B
 * published to B's own pod; within the window A received:
 *
 *   data: {"type":"notifications","events":[
 *     {"resource":"http://css.railway.internal:3456/u-eth-8f3b8e939600/context-graphs/1786071717527.ttl","type":"Add","timestamp":"2026-08-07T03:02:10.490Z"},
 *     {"resource":"http://css.railway.internal:3456/u-eth-0cd4999f1344/context-graphs/1786072701170.ttl","type":"Add","timestamp":"2026-08-07T03:18:29.200Z"},
 *     {"resource":"http://css.railway.internal:3456/u-eth-0cd4999f1344/context-graphs/1786072764993.ttl","type":"Add","timestamp":"2026-08-07T03:19:30.230Z"},
 *     {"resource":"http://css.railway.internal:3456/u-eth-5621a5679a75/context-graphs/1786075302489.ttl","type":"Add","timestamp":"2026-08-07T04:01:48.715Z"},
 *     {"resource":"http://css.railway.internal:3456/u-eth-feaf7d324ae7/context-graphs/1786075370620.ttl","type":"Add","timestamp":"2026-08-07T04:02:55.649Z"}]}
 *
 * Five writes on four pods, none of them A's — including the maintainer's and including B's,
 * live, as it happened. A's own `get_pod_status` carried the same population. On a substrate
 * whose proposition is that your work lives on your own storage under your own authority,
 * that is an unrelated party enumerating your write activity.
 *
 * ── WHY A KEYED STORE AND NOT A FILTER AT EACH READER ────────────────────────
 *
 * A `.filter()` bolted onto `/sse` would have closed `/sse`. The array behind it would still
 * have held every pod's activity, and `get_pod_status` — the second reader, which nobody had
 * counted — would have gone on returning `slice(-10)` of it. The defect is not that a reader
 * forgot to filter; it is that the STORE had no notion of who may see an entry, so every
 * reader had to remember, and the next one will not.
 *
 * So the store is keyed and there is deliberately NO function here that returns everything.
 * {@link recentForPod} is the only read, and it cannot be called without naming a pod. A
 * future consumer that wants "all recent activity" has to add such a function, which is a
 * visible act in a diff rather than a `.slice()` that looks like every other `.slice()`.
 *
 * ── WHAT A CALLER IS ENTITLED TO ─────────────────────────────────────────────
 *
 * Their own pod's activity, and nothing else. Not "pods they are a seated member of":
 * MEASURED, no consumer needs it. `@interego/workspace-client` does not use `/sse` — it
 * polls, and its `watchTool` documents the measurement behind that choice — so a
 * membership-aware fan-out would be a channel built for nobody, widening a hole to serve a
 * caller that does not exist. This module keys by pod; if a seated-member channel is ever
 * genuinely needed, it is a second reader with its own authorization, not a looser key here.
 *
 * The event still carries its descriptor URL, because for your OWN pod that URL is the
 * handle you would pass to `get_descriptor` — it is the useful part, not the leaking part.
 * The leak was never the field; it was the delivery.
 */

/**
 * One recent change. Structurally the `ContextChangeEvent` of `@interego/solid`, restated
 * here so this module can be unit-tested without pulling the Solid client's build into the
 * test process — the same reason `amep-session-bridge.ts` was extracted from `server.ts`.
 */
export interface RecentChange {
  /** The resource IRI that changed. */
  readonly resource: string;
  /** The type of change. */
  readonly type: 'Add' | 'Update' | 'Remove';
  /** ISO 8601 timestamp of the notification. */
  readonly timestamp: string;
}

/**
 * Entries kept per pod. The readers ask for 5 (`/sse`) and 10 (`get_pod_status`); 32 leaves
 * headroom for a burst between two polls without letting one busy pod hold an unbounded
 * history the owner never reads.
 */
export const MAX_ENTRIES_PER_POD = 32;

/**
 * Pods tracked before the least-recently-written one is dropped.
 *
 * The array this replaced was capped globally at 1024 entries. Keying by pod removes that
 * ceiling — one Map entry per pod the relay has ever emitted for — so the cap has to move to
 * the number of KEYS or the fix trades a disclosure defect for a slow leak.
 *
 * MEASURED, not assumed: `list_known_pods` reports 326 pods in the federation registry
 * (293 hydrated from the persisted store) on 2026-08-07. 512 is that with headroom. The
 * worst case is therefore 512 × 32 ≈ 16k entries of three short strings each — a few MB
 * against the relay's 2 GiB floor, and larger than the 1024-entry array it replaces. That
 * is the honest trade: the old ceiling was low because one ring served everyone, which is
 * the same property that made it a disclosure.
 */
export const MAX_PODS_TRACKED = 512;

/**
 * Canonical key for a pod URL.
 *
 * The path, lowercased, with a trailing slash — so the gate-host form
 * (`https://css-gate.example/u-eth-abc/`) and the internal form
 * (`http://css.railway.internal:3456/u-eth-abc/`) of ONE pod land on ONE key. Without that,
 * a caller authenticated under one host form would read an empty ring while their events
 * accumulated under the other, and the fix would present as "notifications stopped working".
 *
 * ★ IT AGREES WITH `canonicalPodKey` IN `server.ts` — the key every ownership gate in the relay
 * compares with, and the key the read gate on this log's own reader uses — FOR EVERY URL EITHER
 * OF THEM SEES HERE. A store that keyed pods differently from the gates that authorize them is a
 * store whose scoping is decided by URL spelling.
 *
 * ★ WHERE THEY NOW DIFFER, AND WHY THAT IS NOT A DIVERGENCE IN PRACTICE. `canonicalPodKey` was
 * narrowed so that only THIS DEPLOYMENT'S store origins collapse to one bucket and every other
 * origin keys separately; it needs `STORE_ORIGINS`, which is relay config this module
 * deliberately does not import (it is a store, not a gate). They now differ TWICE, not once:
 * `canonicalPodKey` is origin-qualified AND no longer folds case, while this key is the
 * lower-cased path alone. Both divergences are invisible here for the same reason — this module
 * never sees a url the relay did not derive: the four
 * producers of `record()` all pass a pod the relay itself derived, and the two readers pass a
 * pod that `canonicalPodKey` has already had to match against `callerOwnPod`, which is always
 * `${CSS_URL}${userId}/`. If a producer of a foreign-origin pod url is ever added, this key must
 * take the origin too — two foreign pods sharing a path would otherwise share one ring.
 */
export function podKey(podUrl: string): string {
  try {
    const path = new URL(podUrl).pathname;
    return (path.endsWith('/') ? path : path + '/').toLowerCase();
  } catch {
    return podUrl.toLowerCase();
  }
}

/**
 * Per-pod recent-change rings.
 *
 * A `Map` and not a plain object: a pod key is derived from a URL path, and `__proto__` as
 * an object key is a prototype-pollution seat. Insertion order is also load-bearing here —
 * it is what makes the eviction below least-recently-written.
 */
export class NotificationLog {
  private readonly byPod = new Map<string, RecentChange[]>();
  private readonly maxPerPod: number;
  private readonly maxPods: number;

  constructor(opts?: { maxPerPod?: number; maxPods?: number }) {
    this.maxPerPod = opts?.maxPerPod ?? MAX_ENTRIES_PER_POD;
    this.maxPods = opts?.maxPods ?? MAX_PODS_TRACKED;
  }

  /** Record a change against the pod it happened on. */
  record(podUrl: string, change: RecentChange): void {
    const key = podKey(podUrl);
    // Delete-then-set so the freshly written pod moves to the END of the Map's insertion
    // order. Eviction below takes from the FRONT, which is therefore the pod that has gone
    // longest without a write — not merely the one that was seen first. Without the delete,
    // a pod that writes every second would be evicted ahead of one that wrote once at boot.
    const existing = this.byPod.get(key);
    if (existing) this.byPod.delete(key);
    const entries = existing ?? [];
    entries.push(change);
    if (entries.length > this.maxPerPod) entries.splice(0, entries.length - this.maxPerPod);
    this.byPod.set(key, entries);

    while (this.byPod.size > this.maxPods) {
      const oldest = this.byPod.keys().next();
      if (oldest.done) break;
      this.byPod.delete(oldest.value);
    }
  }

  /**
   * The most recent `limit` changes ON ONE POD, oldest-first.
   *
   * ★ THE ONLY READ THIS MODULE OFFERS, and it takes a pod. There is no `all()`, no
   * `entries()`, no iterator — see the header. A caller cannot obtain another pod's activity
   * from here by forgetting a filter, because there is nothing to forget: the pod is an
   * argument, and an unknown pod returns an empty array rather than a fallback.
   *
   * Returns a COPY. Handing out the live array would let a reader that mutates what it was
   * given (a `.sort()`, a `.reverse()`) reorder another caller's history.
   */
  recentForPod(podUrl: string, limit: number): readonly RecentChange[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const entries = this.byPod.get(podKey(podUrl));
    if (!entries || entries.length === 0) return [];
    return entries.slice(-Math.floor(limit));
  }

  /** How many pods currently hold entries. Operational visibility; carries no pod identity. */
  get podCount(): number {
    return this.byPod.size;
  }

  /** Drop everything. Tests only — the relay never clears this in normal operation. */
  clear(): void {
    this.byPod.clear();
  }
}
