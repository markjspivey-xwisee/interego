import type { PlatformSnapshot } from './lti-platform.js';
import type { StrictSnapshotResult, SnapshotUnavailableReason } from './pod-snapshot-publisher.js';

type LoadState = 'pending' | 'loaded' | 'absent' | 'unavailable';
export interface PlatformLoadDiagnostics {
  state: LoadState;
  lastAttemptAt?: string;
  lastLoadedAt?: string;
  reason?: SnapshotUnavailableReason;
  serviceStatus?: number;
  revision?: { sha256: string; version?: number };
  counts: { lineItems: number; results: number; members: number };
}

/** Validate before restore: a wrong JSON type must not turn into a loaded empty gradebook. */
export function isPlatformSnapshot(value: unknown): value is PlatformSnapshot {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (!Array.isArray(s.lineItems) || !Array.isArray(s.results) || !Array.isArray(s.members)
    || s.lineItems.length > 5000 || s.members.length > 50_000 || s.results.length > 5000) return false;
  const strings = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const ids = new Set<string>();
  for (const item of s.lineItems) {
    if (!item || typeof item !== 'object') return false;
    const li = item as Record<string, unknown>;
    if (!strings(li.id) || ids.has(li.id) || !strings(li.resourceId) || !strings(li.resourceLinkId)
      || !strings(li.tag) || typeof li.label !== 'string' || typeof li.scoreMaximum !== 'number'
      || !Number.isFinite(li.scoreMaximum) || li.scoreMaximum <= 0) return false;
    ids.add(li.id);
  }
  if (s.members.some((m) => !strings(m)) || new Set(s.members).size !== s.members.length) return false;
  const members = new Set(s.members);
  const resultItems = new Set<string>();
  for (const entry of s.results) {
    if (!Array.isArray(entry) || entry.length !== 2 || !strings(entry[0]) || !ids.has(entry[0])
      || resultItems.has(entry[0]) || !Array.isArray(entry[1]) || entry[1].length > 10_000) return false;
    resultItems.add(entry[0]);
    const users = new Set<string>();
    for (const row of entry[1]) {
      if (!row || typeof row !== 'object') return false;
      const r = row as Record<string, unknown>;
      if (!strings(r.userId) || !members.has(r.userId) || users.has(r.userId)
        || !['Initialized', 'Started', 'InProgress', 'Submitted', 'Completed'].includes(String(r.activityProgress))
        || !['FullyGraded', 'Pending', 'PendingManual', 'Failed', 'NotReady'].includes(String(r.gradingProgress))
        || typeof r.timestamp !== 'string' || !Number.isFinite(Date.parse(r.timestamp))
        || (r.comment !== undefined && typeof r.comment !== 'string')) return false;
      if (r.scoreGiven !== undefined || r.scoreMaximum !== undefined) {
        if (typeof r.scoreGiven !== 'number' || !Number.isFinite(r.scoreGiven) || r.scoreGiven < 0
          || typeof r.scoreMaximum !== 'number' || !Number.isFinite(r.scoreMaximum) || r.scoreMaximum <= 0) return false;
      }
      users.add(r.userId);
    }
  }
  return true;
}

/** One cache, one hydration attempt at a time. Retry unavailable reads on later requests;
 * never merge an untrusted/partial snapshot or publish the initial empty cache.
 */
export class LtiPlatformReadiness {
  private state: LoadState = 'pending';
  private inFlight: Promise<boolean> | undefined;
  private nextAttemptAt = 0;
  private details: Omit<PlatformLoadDiagnostics, 'state' | 'counts'> = {};

  constructor(private readonly options: {
    load: () => Promise<StrictSnapshotResult<PlatformSnapshot>>;
    restore: (snapshot: PlatformSnapshot) => void;
    collect: () => PlatformSnapshot;
    now?: () => number;
    retryMs?: number;
    onState?: (diagnostics: PlatformLoadDiagnostics) => void;
  }) {}

  isReady(): boolean { return this.state === 'loaded' || this.state === 'absent'; }

  snapshotForPublish(): PlatformSnapshot | null { return this.isReady() ? this.options.collect() : null; }

  diagnostics(): PlatformLoadDiagnostics {
    const snap = this.options.collect();
    return { state: this.state, ...this.details, counts: { lineItems: snap.lineItems.length,
      results: snap.results.reduce((n, [, rows]) => n + rows.length, 0), members: snap.members.length } };
  }

  ensureReady(): Promise<boolean> {
    if (this.isReady()) return Promise.resolve(true);
    if (this.inFlight) return this.inFlight;
    const now = this.options.now?.() ?? Date.now();
    if (now < this.nextAttemptAt) return Promise.resolve(false);
    this.state = 'pending';
    this.details = { lastAttemptAt: new Date(now).toISOString() };
    this.inFlight = this.hydrate().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async hydrate(): Promise<boolean> {
    let result: StrictSnapshotResult<PlatformSnapshot>;
    try { result = await this.options.load(); }
    catch { result = { state: 'unavailable', reason: 'transport' }; }
    try {
      if (result.state === 'loaded') {
        if (!isPlatformSnapshot(result.snapshot)) result = { state: 'unavailable', reason: 'invalid-snapshot' };
        else this.options.restore(result.snapshot);
      }
    } catch { result = { state: 'unavailable', reason: 'invalid-snapshot' }; }
    this.state = result.state;
    if (result.state === 'loaded') this.details = { ...this.details,
      lastLoadedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      revision: { sha256: result.revision.sha256, ...(result.revision.version !== undefined ? { version: result.revision.version } : {}) } };
    if (result.state === 'unavailable') {
      this.details = { ...this.details, reason: result.reason, ...(result.status ? { serviceStatus: result.status } : {}) };
      this.nextAttemptAt = (this.options.now?.() ?? Date.now()) + (this.options.retryMs ?? 1000);
    }
    this.options.onState?.(this.diagnostics());
    return this.isReady();
  }
}
