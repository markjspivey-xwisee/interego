/** A service may be running without a human or agent asking for a federation sweep. */
export type PollingMode = 'off' | 'demand' | 'continuous';

export function pollingMode(value: string | undefined): PollingMode {
  if (value === undefined || value === 'demand') return 'demand';
  if (value === 'off' || value === 'continuous') return value;
  throw new Error('polling mode must be off, demand or continuous');
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

/** Only explicit mesh consumers or operator-selected continuous mode may scan. */
export function meshPollingAllowed(mode: PollingMode, explicitRead = false): boolean {
  return mode !== 'off' && (explicitRead || mode === 'continuous');
}

/** Node turns zero, NaN and overflowing intervals into a 1ms loop; reject them. */
export function pollingInterval(value: string | undefined): number {
  const interval = value === undefined ? 60_000 : Number(value);
  if (!Number.isInteger(interval) || interval < 1000 || interval > 2_147_483_647) {
    throw new Error('mesh polling interval must be an integer from 1000 to 2147483647ms');
  }
  return interval;
}
