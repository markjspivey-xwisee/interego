/** A service may be running without a human or agent asking for a federation sweep. */
export type PollingMode = 'off' | 'demand' | 'continuous';

export function pollingMode(value: string | undefined): PollingMode {
  if (value === undefined || value === 'demand') return 'demand';
  if (value === 'off' || value === 'continuous') return value;
  throw new Error('polling mode must be off, demand or continuous');
}

export class PollingDemand {
  private lastActivityAt = Number.NEGATIVE_INFINITY;
  constructor(readonly mode: PollingMode, readonly idleMs = 300_000,
    private readonly now: () => number = Date.now) {
    if (!Number.isFinite(idleMs) || idleMs <= 0) throw new Error('polling idle window must be positive');
  }
  /** Call only after signature/delegation verification succeeds, never on health checks. */
  authenticatedActivity(): void { this.lastActivityAt = this.now(); }
  shouldPoll(): boolean {
    return this.mode === 'continuous'
      || (this.mode === 'demand' && this.now() - this.lastActivityAt < this.idleMs);
  }
}

/** Coalesce on-demand refreshes and apply a retry interval even when a source fails. */
export function onDemandRefresh(work: () => Promise<void>, ttlMs = 60_000,
  now: () => number = Date.now): () => Promise<void> {
  let active: Promise<void> | undefined;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  return () => {
    if (active) return active;
    if (now() - lastAttempt < ttlMs) return Promise.resolve();
    lastAttempt = now();
    active = Promise.resolve().then(work).finally(() => { active = undefined; });
    return active;
  };
}
