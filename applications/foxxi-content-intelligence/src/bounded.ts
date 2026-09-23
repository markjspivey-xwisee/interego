/**
 * Reading many pod entities, a few at a time.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * The content-judgment loop reads every judgment, outcome and attestation the pod lists before it
 * cross-confirms, queues, calibrates or attests. Read one at a time, a pod that had held five live
 * runs (over a hundred judgments and as many outcomes on 2026-09-23) took the runner's whole
 * 120-second budget inside `foxxi.cross_confirm`, and the runner gave up on a call the bridge then
 * finished on its own. A few reads in flight at once is the difference; the pod serves them.
 */

/**
 * `read` over `items` with at most `limit` in flight, the defined results in the items' order. An
 * item whose read throws or resolves to undefined is left out: a partial read is a shorter list,
 * not a failure, as every caller already treated it.
 */
export async function readEach<T, R>(items: readonly T[], limit: number, read: (item: T) => Promise<R | undefined>): Promise<R[]> {
  const results: (R | undefined)[] = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next;
      next += 1;
      const item = items[i] as T;
      try {
        results[i] = await read(item);
      } catch {
        results[i] = undefined;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results.filter((r): r is R => r !== undefined);
}
