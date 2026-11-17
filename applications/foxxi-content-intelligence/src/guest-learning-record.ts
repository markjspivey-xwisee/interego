/**
 * A general guest's learning record: one plain JSON document on the GUEST'S OWN pod.
 *
 * Where: `<pod origin>/<u-try-guest-…>/foxxi-dashboard/learning-record.json`. The address is
 * built here from the guest's admission and checked every time (`guestRecordUrl`): it is on the
 * tenant pod's origin, its first path segment is the guest's own id, and it is never the tenant
 * pod. Nothing in a request names it.
 *
 * Who writes: the bridge, with the gate's operator bearer (the `fetch` it is given attaches it to
 * writes on the pod origin). A guest's own token cannot write here. The document is plain JSON,
 * not sealed, and the gate serves pod reads anonymously: whoever knows the guest's id can read it.
 *
 * What the gate may answer a write with (deploy/css-gate, "What an application's bridge may write
 * into a guest's pod"), and what is done about each:
 *
 *   410  the guest is closed or expired   -> `GuestPodError.gone`: never retried here; the caller ends the session
 *   409  no open account behind the pod   -> refused, not retried here
 *   503  the gate could not read the pod's state -> unavailable; the caller may ask again
 *   413 / 507  the gate's bound for this pod is spent -> refused, not retried here
 *
 * Writes are kept small and few, well inside the gate's bound for a guest's pod (4096 writes,
 * 128 MiB, 8 MiB each, per gate process): one PUT of the whole document per kept step, at most
 * `GUEST_RECORD_MAX_BYTES` each, at most `GUEST_RECORD_MAX_WRITES` per guest per process. A step
 * whose statements are all kept already writes nothing.
 */
import { guardSubjectPod, type SubjectPodGuardRefusal } from './subject-pod-url.js';

export const GUEST_RECORD_PATH = 'foxxi-dashboard/learning-record.json';
export const GUEST_RECORD_KIND = 'foxxi-dashboard-guest-learning-record';
/** The whole document, as written. 256 KiB. */
export const GUEST_RECORD_MAX_BYTES = 256 * 1024;
export const GUEST_RECORD_MAX_STATEMENTS = 2000;
/** Writes per guest, per bridge process. With the byte bound: at most 64 MiB per guest per process. */
export const GUEST_RECORD_MAX_WRITES = 256;
const MAX_TRACKED_GUESTS = 5000;

export type GuestPodErrorCode =
  | 'general_guest_gone'
  | 'general_guest_pod_not_open'
  | 'general_guest_pod_unavailable'
  | 'general_guest_storage_full'
  | 'general_guest_record_full'
  | 'general_guest_record_unreadable'
  | 'general_guest_pod_refused';

export class GuestPodError extends Error {
  constructor(readonly status: number, readonly code: GuestPodErrorCode, readonly detail?: string) { super(code); this.name = 'GuestPodError'; }
  /** The gate said the guest is closed or expired. The session ends; nothing is retried. */
  get gone(): boolean { return this.code === 'general_guest_gone'; }
}

/** The guest whose record this is: what the bridge checked at the door. */
export interface GuestRecordOwner {
  readonly userId: string;
  readonly guestDid: string;
  readonly podUrl: string;
}

export interface GuestLearningRecord {
  readonly kind: typeof GUEST_RECORD_KIND;
  readonly version: 1;
  /** The guest's DID. */
  readonly subject: string;
  readonly updatedAt: string;
  readonly statements: ReadonlyArray<Record<string, unknown>>;
}

export type GuestRecordFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: 'error' | 'manual'; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface GuestRecordStoreOptions {
  readonly tenantPodUrl: string;
  /** The identity service's host, as the pod resolver is given it. */
  readonly identityHost: string;
  /** Reads go as they are; the bridge's fetch attaches the operator bearer to writes on the pod origin. */
  readonly fetch: GuestRecordFetch;
  readonly now?: () => number;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The address of a guest's record, or a refusal. The pod must pass `guardSubjectPod` for this
 * guest (its own pod, on the tenant pod's origin, never the tenant pod) and be exactly
 * `<origin>/<userId>/`.
 */
export function guestRecordUrl(owner: GuestRecordOwner, tenantPodUrl: string, identityHost: string): { ok: true; url: string } | { ok: false; reason: SubjectPodGuardRefusal | 'not-a-guest' } {
  if (!/^u-try-guest-[0-9a-f]{32}$/.test(owner.userId) || !owner.guestDid.endsWith(`:users:${owner.userId}`)) return { ok: false, reason: 'not-a-guest' };
  const guard = guardSubjectPod({ subject: owner.guestDid, podUrl: owner.podUrl, tenantPodUrl, identityHost });
  if (!guard.ok) return { ok: false, reason: guard.reason };
  let origin: string;
  try { origin = new URL(tenantPodUrl).origin; } catch { return { ok: false, reason: 'pod-unreadable' }; }
  // The guard compares pod roots; the record is written under the exact root and nothing looser.
  if (owner.podUrl !== `${origin}/${owner.userId}/`) return { ok: false, reason: 'not-own-pod' };
  return { ok: true, url: `${origin}/${owner.userId}/${GUEST_RECORD_PATH}` };
}

export class GuestLearningRecordStore {
  private readonly now: () => number;
  /** One write at a time per guest: a second step waits for the first to be kept. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly writes = new Map<string, number>();

  constructor(private readonly options: GuestRecordStoreOptions) { this.now = options.now ?? Date.now; }

  /** How many writes this process has made for a guest. */
  writesFor(userId: string): number { return this.writes.get(userId) ?? 0; }

  private url(owner: GuestRecordOwner): string {
    const at = guestRecordUrl(owner, this.options.tenantPodUrl, this.options.identityHost);
    if (!at.ok) throw new GuestPodError(403, 'general_guest_pod_refused', at.reason);
    return at.url;
  }

  private empty(owner: GuestRecordOwner): GuestLearningRecord {
    return { kind: GUEST_RECORD_KIND, version: 1, subject: owner.guestDid, updatedAt: new Date(this.now()).toISOString(), statements: [] };
  }

  /** The guest's record. A pod with no record yet answers an empty one. */
  async read(owner: GuestRecordOwner): Promise<GuestLearningRecord> {
    const url = this.url(owner);
    let response: { ok: boolean; status: number; text(): Promise<string> };
    let body = '';
    try {
      response = await this.options.fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.ok) body = await response.text();
    } catch { throw new GuestPodError(503, 'general_guest_pod_unavailable'); }
    if (response.status === 404) return this.empty(owner);
    if (response.status === 410) throw new GuestPodError(410, 'general_guest_gone');
    if (!response.ok) throw new GuestPodError(503, 'general_guest_pod_unavailable', `read answered ${response.status}`);
    if (body.length > GUEST_RECORD_MAX_BYTES * 2) throw new GuestPodError(502, 'general_guest_record_unreadable');
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new GuestPodError(502, 'general_guest_record_unreadable'); }
    // A document that is not this guest's record is not read as one, and is not written over.
    if (!record(parsed) || parsed['kind'] !== GUEST_RECORD_KIND || parsed['version'] !== 1 || parsed['subject'] !== owner.guestDid
      || !Array.isArray(parsed['statements']) || !parsed['statements'].every(record)) throw new GuestPodError(502, 'general_guest_record_unreadable');
    return { kind: GUEST_RECORD_KIND, version: 1, subject: owner.guestDid,
      updatedAt: typeof parsed['updatedAt'] === 'string' ? parsed['updatedAt'] : '', statements: parsed['statements'] as Array<Record<string, unknown>> };
  }

  /**
   * Keep these statements in the guest's record and answer their ids. Each needs a string `id`;
   * one already in the record is not added twice, so keeping the same step again is harmless and
   * writes nothing. Throws `GuestPodError`; nothing is retried here.
   */
  append(owner: GuestRecordOwner, statements: ReadonlyArray<Record<string, unknown>>): Promise<string[]> {
    const ids = statements.map(s => s['id']);
    if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)) return Promise.reject(new GuestPodError(400, 'general_guest_record_unreadable', 'a statement has no id'));
    const run = (this.queues.get(owner.userId) ?? Promise.resolve()).catch(() => undefined).then(() => this.appendNow(owner, statements, ids));
    this.queues.set(owner.userId, run);
    void run.catch(() => undefined).finally(() => { if (this.queues.get(owner.userId) === run) this.queues.delete(owner.userId); });
    return run;
  }

  private async appendNow(owner: GuestRecordOwner, statements: ReadonlyArray<Record<string, unknown>>, ids: string[]): Promise<string[]> {
    const url = this.url(owner);
    const current = await this.read(owner);
    const have = new Set(current.statements.map(s => s['id']));
    const added = statements.filter(s => !have.has(s['id']));
    if (!added.length) return ids;
    const next: GuestLearningRecord = { kind: GUEST_RECORD_KIND, version: 1, subject: owner.guestDid,
      updatedAt: new Date(this.now()).toISOString(), statements: [...current.statements, ...added] };
    const body = JSON.stringify(next);
    if (next.statements.length > GUEST_RECORD_MAX_STATEMENTS || Buffer.byteLength(body, 'utf8') > GUEST_RECORD_MAX_BYTES) throw new GuestPodError(507, 'general_guest_record_full');
    const made = this.writes.get(owner.userId) ?? 0;
    if (made >= GUEST_RECORD_MAX_WRITES) throw new GuestPodError(507, 'general_guest_record_full', 'write allowance spent');
    if (!this.writes.has(owner.userId) && this.writes.size >= MAX_TRACKED_GUESTS) {
      const oldest = this.writes.keys().next().value;
      if (oldest !== undefined) this.writes.delete(oldest);
    }
    // Counted before it is sent: a write that failed at the gate may still have been counted there.
    this.writes.set(owner.userId, made + 1);
    let response: { ok: boolean; status: number; text(): Promise<string> };
    try {
      response = await this.options.fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch { throw new GuestPodError(503, 'general_guest_pod_unavailable'); }
    if (response.ok) return ids;
    switch (response.status) {
      case 410: throw new GuestPodError(410, 'general_guest_gone');
      case 409: throw new GuestPodError(409, 'general_guest_pod_not_open');
      case 413: case 507: throw new GuestPodError(507, 'general_guest_storage_full');
      default: throw new GuestPodError(503, 'general_guest_pod_unavailable', `write answered ${response.status}`);
    }
  }
}
