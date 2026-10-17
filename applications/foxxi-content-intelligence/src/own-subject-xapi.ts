/** Runtime write and request throttles for the private own-subject activity window.
 * The encrypted rolling profile, supplied by own-subject-activity-store, is authoritative.
 */
export class OwnSubjectXapiBudgetError extends Error {
  readonly status = 429;
  constructor() { super('Private activity runtime write budget reached; confirmed records are preserved.'); this.name = 'OwnSubjectXapiBudgetError'; }
}
/** A conservative runtime throttle supplements the authoritative CAS capacity.
 * Reservations are never refunded after uncertainty and entries are never evicted
 * within their hour. This throttle resets on process restart; the encrypted profile and receipt bounds do not. */
export class OwnSubjectXapiWriteBudget {
  private readonly windows = new Map<string, { since: number; input: number; written: number; active: number }>();
  private active = 0;
  begin(owner: string, bytes: number, now = Date.now()) {
    let window = this.windows.get(owner);
    if (window && now - window.since >= 3600000 && window.active === 0) { this.windows.delete(owner); window = undefined; }
    if (!window) {
      if (this.windows.size >= 1024) for (const [key, row] of this.windows) if (now - row.since >= 3600000 && row.active === 0) this.windows.delete(key);
      if (this.windows.size >= 1024) throw new OwnSubjectXapiBudgetError();
      window = { since: now, input: 0, written: 0, active: 0 }; this.windows.set(owner, window);
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || window.input + bytes > 4 * 1024 * 1024 || window.active >= 2 || this.active >= 32) throw new OwnSubjectXapiBudgetError();
    window.input += bytes; window.active++; this.active++;
    let released = false, written = 0;
    return {
      reserveWrite: (size: number) => {
        if (released || !Number.isSafeInteger(size) || size < 0 || written + size > 4 * 1024 * 1024 || window!.written + size > 16 * 1024 * 1024) throw new OwnSubjectXapiBudgetError();
        written += size; window!.written += size;
      },
      release: () => { if (!released) { released = true; window!.active--; this.active--; } },
    };
  }
}
/** The native xAPI transport is not an LLM planning call. Reconciliation of a
 * 20-statement batch must fit within one subject's read window even when many
 * callers share the relay's ingress IP. */
export class OwnSubjectXapiRequestBudget {
  private readonly windows = new Map<string, { since: number; requests: number }>();
  allow(key: string, limit: number, now = Date.now()): boolean {
    let row = this.windows.get(key);
    if (row && now - row.since >= 60000) { this.windows.delete(key); row = undefined; }
    if (!row) {
      if (this.windows.size >= 8192) for (const [owner, value] of this.windows) if (now - value.since >= 60000) this.windows.delete(owner);
      if (this.windows.size >= 8192) return false;
      row = { since: now, requests: 0 }; this.windows.set(key, row);
    }
    if (row.requests >= limit) return false;
    row.requests++; return true;
  }
}
