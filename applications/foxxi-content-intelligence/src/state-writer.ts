/**
 * Keeping one piece of state written: the latest of it, one write at a time.
 *
 * ★ A CHANGE IS NEVER LEFT WAITING FOR ANOTHER. The bridge keeps a few small resources on the
 * tenant pod that change as it works: the efficacy tally, and where authored content lives. Each
 * used to be written when it changed, and a write that failed was tried again "after the next
 * change". So the last change before a quiet spell stayed unwritten, and was lost on a restart,
 * whenever its write failed or overlapped one that did. A writer here retries on its own.
 *
 * ★ A FAILING POD IS NOT HAMMERED. A failed write is tried again after a pause that doubles while
 * writes keep failing (policy.minRetryMs up to policy.maxRetryMs), and a change asked for during
 * the pause waits for it: the retry writes the latest state anyway. After a write lands, the next
 * failure starts from the shortest pause again.
 *
 * There is at most one write under way and one retry waiting. `write` writes the whole current
 * state, and throws when the store did not take it.
 */

export const STATE_WRITER_RETRY = { minRetryMs: 5_000, maxRetryMs: 5 * 60_000 } as const;

export interface StateWriter {
  /** The state has changed: write it now, after the write under way, or at the retry already waiting. */
  request(): void;
  /** Resolves once no write is under way (a retry may still be waiting). */
  settled(): Promise<void>;
}

export function stateWriter(write: () => Promise<void>,
  policy: { minRetryMs: number; maxRetryMs: number } = STATE_WRITER_RETRY): StateWriter {
  let dirty = false;
  let running: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let pause = 0;
  const start = (): void => {
    running = (async () => {
      while (dirty) {
        dirty = false;
        try { await write(); pause = 0; }
        catch { dirty = true; break; }
      }
    })().finally(() => {
      running = undefined;
      if (!dirty) return;
      pause = Math.min(Math.max(pause * 2, policy.minRetryMs), policy.maxRetryMs);
      retry = setTimeout(() => { retry = undefined; start(); }, pause);
      // A pending retry does not keep the process alive on its own.
      (retry as { unref?: () => void }).unref?.();
    });
  };
  return {
    request(): void {
      dirty = true;
      if (!running && !retry) start();
    },
    async settled(): Promise<void> {
      while (running) await running;
    },
  };
}
