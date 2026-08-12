/**
 * HOW MUCH OF A POD'S MANIFEST `get_pod_status` MAY RETURN.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
 *
 * ★ SO A TEST CAN RUN THE REAL FUNCTION. `server.ts` is self-starting and cannot be imported, so
 * everything about it is asserted over its source text — which pins the shape of a call site and
 * cannot execute the logic inside it. MEASURED: with this function living in `server.ts` and the
 * test carrying its own copy of the algorithm, deleting the budget check from the server produced
 * ZERO failures. The test agreed with itself about a function it never called.
 *
 * `notification-log.ts` is here for the same reason and its suite says so in as many words:
 * exercising the real class is what caught an eviction bug a re-implementation could not.
 *
 * ── THE DEFECT THIS BOUNDS ───────────────────────────────────────────────────
 *
 * `get_pod_status` returned the pod's entire descriptor manifest. MEASURED 2026-08-12 against the
 * live relay: 56,450,477 bytes on pod u-eth-03f52e15b9df, growing 1.4 MB over one afternoon. A
 * `fetch` buffers that without complaint — which is why every direct probe passed and misled — and
 * a real MCP client drops the connection and reports `MCP session expired during tool call`. That
 * names a session problem, so it sends you to auth, where everything checks out. The tool was
 * unreachable from every MCP client, including the pod owner's own claude.ai connector.
 *
 * ── AND WHY THE BOUND IS IN BYTES ────────────────────────────────────────────
 *
 * ★ A COUNT CANNOT BOUND A PAYLOAD WHOSE ITEMS VARY BY 13x, and the first fix shipped as a count.
 * It was sized from a 741-byte mean measured on one pod; MEASURED on the next pod after deploying
 * it, 100 entries came to 989,903 bytes, because that pod's entries average 9.9 KB. It sat a hair
 * under the ceiling it was meant to keep the response far below, and would have gone over for any
 * pod whose entries ran larger still. The 56 MB case was fixed by luck.
 *
 * The budget is the real constraint. The count is a cheap upper bound on top of it, so a pod of
 * tiny entries does not return ten thousand of them just because they fit.
 */

/** The most entries returned, however small they are. */
export const POD_STATUS_ENTRY_CAP = 100;

/** The most bytes those entries may occupy. Well inside what every MCP client carries. */
export const POD_STATUS_ENTRY_BUDGET_BYTES = 256 * 1024;

export interface EntryPage {
  /** The newest entries that fit, in manifest order. */
  readonly page: readonly unknown[];
  /** How many the caller is NOT being shown. Zero when the whole manifest fits. */
  readonly omitted: number;
}

/**
 * The newest entries that fit in the budget, and how many were left out.
 *
 * ★ ALWAYS RETURNS AT LEAST ONE ENTRY WHEN THERE IS ONE. A pod whose single latest descriptor
 * exceeds the entire budget should answer with it and say the rest were omitted — an empty array
 * on a pod that has descriptors reads as "this pod has nothing", which is the same class of
 * false-negative this whole bound exists to prevent: a wrong answer wearing the shape of a healthy
 * one.
 */
export function podStatusEntryPage(entries: readonly unknown[]): EntryPage {
  const page: unknown[] = [];
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0 && page.length < POD_STATUS_ENTRY_CAP; i--) {
    const size = JSON.stringify(entries[i] ?? null).length;
    if (page.length > 0 && bytes + size > POD_STATUS_ENTRY_BUDGET_BYTES) break;
    page.unshift(entries[i]);
    bytes += size;
  }
  return { page, omitted: entries.length - page.length };
}
