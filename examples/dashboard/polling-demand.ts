/** Serialize dashboard refreshes and perform no discovery without an SSE viewer. */
export function clientDemandPoller(
  collect: () => Promise<void>,
  viewerCount: () => number,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (viewerCount() === 0) return Promise.resolve();
    if (pending) return pending;
    const task: Promise<void> = Promise.resolve()
      .then(() => { if (viewerCount() > 0) return collect(); })
      .finally(() => { if (pending === task) pending = undefined; });
    pending = task;
    return task;
  };
}
