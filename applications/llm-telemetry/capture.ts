import { createHash } from 'node:crypto';
import { normalizeEvent, type TelemetryEvent } from './events.js';

export interface CapturePreferences {
  observer: string;
  revision: number;
  server_enabled: boolean;
  client_enabled: boolean;
  updated_at: string | null;
}
export interface CaptureStore {
  load(): Promise<unknown[] | null>;
  persist(value: CapturePreferences): Promise<boolean>;
  now(): string;
}
export class CaptureError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function captureResource(actor: string): string {
  return `llm-capture-${createHash('sha256').update(actor).digest('hex').slice(0,32)}`;
}
const locks = new Map<string, Promise<unknown>>();
async function locked<T>(actor: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(actor) ?? Promise.resolve()).catch(() => {}).then(work);
  locks.set(actor, next);
  try { return await next; } finally { if (locks.get(actor) === next) locks.delete(actor); }
}
export async function readCapturePreferences(actor: string, store: CaptureStore): Promise<CapturePreferences> {
  const records = await store.load();
  if (records === null) throw new CaptureError(503, 'capture preferences unavailable; automatic reporting is not authorized');
  let current: CapturePreferences = { observer: actor, revision: 0, server_enabled: false, client_enabled: false, updated_at: null };
  const revisions = new Map<number, CapturePreferences>();
  for (const value of records) {
    const r = value as Partial<CapturePreferences> | null;
    if (!r || r.observer !== actor || !Number.isSafeInteger(r.revision) || r.revision! < 1
      || typeof r.server_enabled !== 'boolean' || typeof r.client_enabled !== 'boolean'
      || typeof r.updated_at !== 'string' || !Number.isFinite(Date.parse(r.updated_at))) {
      throw new CaptureError(503, 'invalid capture preference history; reporting is not authorized');
    }
    const record = r as CapturePreferences;
    const prior = revisions.get(record.revision);
    if (prior && (prior.server_enabled !== record.server_enabled || prior.client_enabled !== record.client_enabled || prior.updated_at !== record.updated_at)) {
      throw new CaptureError(503, 'conflicting capture preference revisions; reporting is not authorized');
    }
    revisions.set(record.revision, record);
    if (record.revision > current.revision) current = record;
  }
  return current;
}
export async function updateCapturePreferences(actor: string, input: unknown, store: CaptureStore): Promise<CapturePreferences> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CaptureError(400, 'capture settings must be an object');
  const patch = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'expected_revision') {
      if (!Number.isSafeInteger(value) || (value as number) < 0) throw new CaptureError(400, 'expected_revision must be a nonnegative integer');
    } else if (!['server_enabled','client_enabled'].includes(key) || typeof value !== 'boolean') throw new CaptureError(400, `invalid capture setting: ${key}`);
  }
  if (!Object.hasOwn(patch, 'server_enabled') && !Object.hasOwn(patch, 'client_enabled')) throw new CaptureError(400, 'choose server_enabled or client_enabled, or both');
  return locked(actor, async () => {
    const previous = await readCapturePreferences(actor, store);
    const next = { ...previous, ...patch, observer: actor } as CapturePreferences & { expected_revision?: number };
    delete next.expected_revision;
    // An exact retry of the desired settings is harmless, even after the revision advanced.
    if (next.server_enabled === previous.server_enabled && next.client_enabled === previous.client_enabled) return previous;
    if (patch.expected_revision !== undefined && patch.expected_revision !== previous.revision) throw new CaptureError(409, 'capture settings changed; refresh before changing them');
    next.revision = previous.revision + 1; next.updated_at = store.now();
    if (!await store.persist(next)) throw new CaptureError(502, 'capture preferences were not durably confirmed; read settings before retrying');
    const confirmed = await readCapturePreferences(actor, store);
    if (confirmed.revision !== next.revision || confirmed.server_enabled !== next.server_enabled || confirmed.client_enabled !== next.client_enabled) throw new CaptureError(409, 'capture settings changed during persistence; refresh settings');
    return confirmed;
  });
}
export type CaptureChannel = 'server' | 'client' | 'manual';
/** Authenticated metadata traffic must not consume the public LLM-call budget.
 * Keep settings separate so intake/query saturation cannot block revocation. */
export function createTelemetryRateLimit(now: () => number = Date.now) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const limits = { ingest: 120, query: 60, settings: 60 };
  return (actor: string, lane: keyof typeof limits): { ok: true } | { ok: false; retryAfterSeconds: number } => {
    const time = now(); const key = JSON.stringify([actor, lane]);
    let window = windows.get(key);
    if (!window || time >= window.resetAt) {
      if (windows.size >= 10_000) {
        for (const [k, value] of windows) if (time >= value.resetAt) windows.delete(k);
        if (!windows.has(key) && windows.size >= 10_000) return { ok: false, retryAfterSeconds: 60 };
      }
      window = { count: 0, resetAt: time + 60_000 }; windows.set(key, window);
    }
    window.count++;
    return window.count <= limits[lane] ? { ok: true } : { ok: false, retryAfterSeconds: Math.ceil((window.resetAt - time) / 1000) };
  };
}
export function captureChannel(event: Pick<TelemetryEvent, 'coverage'>): CaptureChannel {
  return event.coverage === 'server-observation' ? 'server' : event.coverage === 'manual-observation' ? 'manual' : 'client';
}
/** Both toggles are acceptance gates, re-read before every automatic delivery.
 * Manual ingestion remains an explicit signed action; it never starts a collector. */
export async function withCaptureConsent<T>(actor: string, input: unknown, revision: unknown, store: CaptureStore,
  work: (events: TelemetryEvent[]) => Promise<T>): Promise<T> {
  let events: TelemetryEvent[];
  try {
    if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw new Error('events must contain 1 to 20 observations');
    events = input.map(normalizeEvent);
  } catch (e) { throw new CaptureError(400, (e as Error).message); }
  if (events.every(e => captureChannel(e) === 'manual')) return work(events);
  return locked(actor, async () => {
    const preferences = await readCapturePreferences(actor, store);
    for (const event of events) {
      const channel = captureChannel(event);
      if ((channel === 'server' && !preferences.server_enabled) || (channel === 'client' && !preferences.client_enabled)) throw new CaptureError(403, `${channel} reporting is disabled; opt in through Capture settings`);
      if (channel === 'server' && revision !== preferences.revision) throw new CaptureError(409, 'server capture consent changed during the operation; refresh settings');
    }
    return work(events);
  });
}
