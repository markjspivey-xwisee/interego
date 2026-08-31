/**
 * Winnow a `discover_all` fan-out: keep the rows that carry information, count the rest.
 *
 * ── WHY THIS IS ITS OWN FILE ─────────────────────────────────────────────────
 *
 * server.ts calls `app.listen()` at module scope, so nothing can import from it — every
 * testable rule in that file has to live somewhere a test can reach, and this is the pattern
 * pod-writers.ts and conformance-gate.ts already follow.
 *
 * ── WHAT IT DECIDES ──────────────────────────────────────────────────────────
 *
 * Measured against the live federation: 578 pods, and `discover_all` with `limit: 3` returned
 * 849,399 characters — sized by the POD count, not the result count. Filtered to a graph_iri
 * matching nothing, still 578 rows of `entries: []`. A federation-scan tool no agent could
 * afford to call: the recorded "a tool too big to call" class.
 *
 * A pod that found nothing carries no information the `pods` count does not already give, so it
 * is dropped. But a pod with an ERROR is KEPT — an unreachable or refused pod is a different
 * answer from an empty one, and folding the two would hide a federation fault. And the number
 * dropped is returned, so a caller can tell "scanned 578, 3 matched" from "scanned 3": a
 * silently shorter list is the same "a read that failed is not a thing that is missing" defect,
 * pointing the other way.
 */
export interface DiscoverRow {
  readonly pod: string;
  readonly entries: ReadonlyArray<unknown>;
  readonly error?: string;
}

export function winnowDiscoverResults(
  results: ReadonlyArray<DiscoverRow>,
): { material: DiscoverRow[]; omittedEmpty: number } {
  const material = results.filter((r) => r.entries.length > 0 || r.error !== undefined);
  return { material: [...material], omittedEmpty: results.length - material.length };
}
