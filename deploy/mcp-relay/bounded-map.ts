/**
 * `Array.map` with a ceiling on how many are in flight at once.
 *
 * ★★ THE OUTAGE THIS CLOSES. Every pod-backed store hydrated with
 * `await Promise.allSettled(urls.map(...))` — an UNBOUNDED fan-out. On
 * 2026-08-28 the relay's own service pod held 292 federation entries, 104
 * refresh tokens and the OAuth client set, so a single boot opened ~400
 * simultaneous reads against a Community Solid Server that runs as ONE
 * replica over a shared volume. Every read then died on the relay's own
 * 15,000 ms deadline:
 *
 *   [federation-store] failed to read .../federation/0162….jsonld: this relay
 *   stopped waiting for … after 15000 ms.
 *
 * The store was not failing to FIND its data — the container listing worked and
 * returned all 292 URLs. It was stampeding the pod and timing out on every one,
 * and `loadEntries` reports a read failure by skipping the entry, so the whole
 * directory came back EMPTY. Observable effect: the agent directory dropped to
 * near-nothing on every restart, `hydrateSourceCount` read 0, and WebFinger and
 * the ActivityPub actor 404'd for agents that had not re-authenticated since.
 *
 * ★ WHY A BOUND AND NOT A LONGER DEADLINE. Raising the timeout makes each read
 * wait longer for a server that is slow BECAUSE of the fan-out — it treats the
 * symptom and lengthens the outage. 400 requests do not become servable by
 * being more patient. The deadline is a real backstop and stays as it is.
 *
 * ★ WHY IT IS SHARED WHERE `listContainer` IS DELIBERATELY NOT.
 * `federation-store.ts` carries a copy of `listContainer` with a note saying the
 * stores are "intentionally decoupled — sharing the helper would couple their
 * lifecycles", and that reasoning is right: `listContainer` takes a store's
 * config and speaks its container conventions. This does neither. It has no
 * config, no store semantics and no lifecycle — it is `map` with a ceiling, and
 * four copies of it would be four places to fix the next time the ceiling is
 * wrong.
 */

/**
 * Runs `task` over `items`, at most `limit` at a time, and resolves when all
 * have settled. Never rejects: a task that throws is swallowed exactly as
 * `Promise.allSettled` would, because every caller here already reports its own
 * per-item failure and must not lose the items that succeeded.
 *
 * ★ ORDER IS NOT PRESERVED and no results are returned, matching the callers,
 * which push into an array from inside the task. A result-returning variant
 * would invite someone to depend on ordering that the workers do not provide.
 */
export async function mapBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  // ★ A ceiling below 1 would deadlock: no worker would ever start and the
  // returned promise would never settle. Clamp rather than throw — a bad
  // ceiling must not be able to hang a boot, which is the failure mode this
  // whole module exists to remove.
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  if (items.length === 0) return;

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { await task(items[i]!); } catch { /* caller reports; see the note above */ }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
}

/**
 * The ceiling every pod-backed store hydrates with.
 *
 * ★ SIX, AND THE NUMBER IS AN ARGUMENT RATHER THAN A GUESS. The far end is one
 * CSS replica over a shared volume (see the single-replica requirement in the
 * deploy notes), so the useful width is "enough to hide per-request latency,
 * few enough that the server is never the queue". At 292 entries this is ~49
 * sequential rounds; each read is a small JSON-LD document on an internal
 * hostname, so the boot cost is seconds rather than the current never.
 *
 * It is deliberately ONE number for all four call sites: they hydrate
 * CONCURRENTLY at boot, so a per-store ceiling would multiply — four stores at
 * six is already 24 in flight, and tuning them independently would hide that.
 */
export const POD_HYDRATE_CONCURRENCY = 6;
