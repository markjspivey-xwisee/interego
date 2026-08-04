/**
 * Pluggable xAPI Statement storage backend.
 *
 * Foxxi-as-LRS doesn't lock you into in-memory storage. The
 * `StatementStore` interface is the swap-point — ship in-memory for
 * demo / dev, file-backed JSON-lines for low-volume production, and
 * the "primary-forward" variant that treats an external LRS (SCORM
 * Cloud / Watershed / Yet Analytics / Veracity / Learning Locker) as
 * the source of truth and Foxxi as the read-through cache.
 *
 * Pick which one runs at boot via `FOXXI_LRS_BACKEND`:
 *   memory                 ← default AND what production currently sets (deploy/railway/
 *                            services.json). No persistence, lost on restart, and bounded
 *                            by a process-wide statement budget that EVICTS — so a
 *                            statement id already published as a credential's
 *                            rawDataLocation can stop resolving. Durable deployments use
 *                            file: or pod.
 *   file:/path/to/dir      ← append-only JSONL with index file
 *   forward:<endpoint>     ← every write forwarded; reads from local cache
 *
 * Per-store guarantees regardless of backend:
 *   - get-by-id returns the exact stored object
 *   - voided statements are returned only via the `voidedStatementId`
 *     query path (per xAPI 2.0 §4.1.7); ordinary queries omit them
 *   - statement immutability — re-storing the same UUID with a different
 *     body throws (caller turns into HTTP 409); identical body is
 *     idempotent (caller turns into HTTP 204)
 *
 * This is the "anyone can swap in their own systems" extension point
 * — implement the 4-method interface and you're done.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import {
  withTransientRetry,
} from '@interego/solid';
import { PodStatementStore } from './pod-statement-store.js';

export interface StoredStatement {
  id: string;
  statement: Record<string, unknown>;
  stored: string;
  voided: boolean;
  voidingStatementId?: string;
}

export interface QueryFilter {
  statementId?: string;
  voidedStatementId?: string;
  agent?: Record<string, unknown>;
  verb?: string;
  activity?: string;
  registration?: string;
  since?: string;
  until?: string;
  ascending?: boolean;
  limit?: number;
  cursor?: string;
}

export interface QueryResult {
  statements: StoredStatement[];
  more: string | null;
}

export interface StatementStore {
  /** Persist (or no-op-if-identical) a statement keyed by its UUID. */
  put(record: StoredStatement): Promise<void>;
  /** Single get by id. Returns the record even if voided (caller decides). */
  get(id: string): Promise<StoredStatement | null>;
  /** Mark `id` voided + record which voiding-statement caused it. */
  markVoided(id: string, voidingStatementId: string): Promise<void>;
  /** Filtered query with pagination (returns continuation cursor when more results exist). */
  query(filter: QueryFilter): Promise<QueryResult>;
  /** Snapshot all statements (for admin browser, aggregates, conformance). */
  listAll(): Promise<StoredStatement[]>;
  /** Best-effort total count. */
  count(): Promise<number>;
  /** Drop everything (testing only — should never be called in production). */
  clear(): Promise<void>;
  /** Free-form backend identity for /xapi/about + admin/config. */
  backendDescription(): string;
}

// ── Filter / paginate helper ─────────────────────────────────────────

export function matchesFilter(rec: StoredStatement, f: QueryFilter): boolean {
  const s = rec.statement;
  if (f.agent) {
    const a = s.actor as { mbox?: string; openid?: string; account?: { name?: string; homePage?: string } } | undefined;
    const fa = f.agent as typeof a;
    const same = JSON.stringify(a) === JSON.stringify(fa)
      || (fa?.mbox && a?.mbox === fa.mbox)
      || (fa?.openid && a?.openid === fa.openid)
      || (fa?.account?.name && a?.account?.name === fa.account.name && a?.account?.homePage === fa.account.homePage);
    if (!same) return false;
  }
  if (f.verb && (s.verb as { id?: string } | undefined)?.id !== f.verb) return false;
  if (f.activity && (s.object as { id?: string } | undefined)?.id !== f.activity) return false;
  if (f.registration && (s.context as { registration?: string } | undefined)?.registration !== f.registration) return false;
  if (f.since && Date.parse(rec.stored) <= Date.parse(f.since)) return false;
  if (f.until && Date.parse(rec.stored) > Date.parse(f.until)) return false;
  return true;
}

/** The query context a continuation token carries forward, so page N applies the
 *  same filter as page 1. `statementId`/`voidedStatementId` are excluded: those
 *  return a single statement and never paginate. */
export type CursorQuery = Pick<QueryFilter,
  'agent' | 'verb' | 'activity' | 'registration' | 'since' | 'until' | 'ascending' | 'limit'>;

export interface DecodedCursor { offset: number; ts?: number; q?: CursorQuery }

/** Read a continuation token. Returns null for anything unparseable — a bad token
 *  must not silently degrade into "page 1 of everything". */
export function decodeCursor(token: string | undefined): DecodedCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as DecodedCursor;
    return typeof parsed?.offset === 'number' ? parsed : null;
  } catch { return null; }
}

export function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** The filter fields a token carries. Undefined entries are dropped so the token
 *  stays small and round-trips to an equivalent filter. */
export function cursorQueryOf(f: QueryFilter): CursorQuery {
  const q: CursorQuery = {};
  if (f.agent !== undefined) q.agent = f.agent;
  if (f.verb !== undefined) q.verb = f.verb;
  if (f.activity !== undefined) q.activity = f.activity;
  if (f.registration !== undefined) q.registration = f.registration;
  if (f.since !== undefined) q.since = f.since;
  if (f.until !== undefined) q.until = f.until;
  if (f.ascending !== undefined) q.ascending = f.ascending;
  if (f.limit !== undefined) q.limit = f.limit;
  return q;
}

/**
 * Page a filtered, sorted result set and mint the continuation token for the next
 * page.
 *
 * ★ THE TOKEN CARRIES THE QUERY. It used to carry only `{offset, ts}`, and the
 * `more` IRL was built as `/xapi/statements?continuationToken=<tok>` with the
 * original parameters dropped. Following it therefore re-ran an UNFILTERED query
 * and applied the offset to that, so page 2 was a different — broader — result set.
 * Reproduced live before this change: a 3-statement `?activity=ALPHA&limit=2` query
 * returned page 1 correctly, then page 2 contained a BETA statement the filter
 * excludes plus both of page 1's statements again.
 *
 * xAPI requires the `more` IRL to return the next results of THE SAME query, and
 * treats it as opaque to the client — so the query context belongs inside the
 * token, not in parameters a caller has to remember to resend.
 *
 * ★ AND `ts` NOW DOES SOMETHING. It was written into every token and never read.
 * Offset paging over a store that is still accepting writes is unstable: statements
 * arriving between pages shift every later offset, so rows repeat or get skipped.
 * Pinning the page to statements stored at or before the token's timestamp makes a
 * continuation a view of the result set as it stood when paging began.
 */
/** Newest `stored` in a result set, as epoch ms — the horizon a page sequence pins to. */
function horizonOf(rows: readonly StoredStatement[]): number {
  let max = 0;
  for (const r of rows) {
    const t = Date.parse(r.stored);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max || Date.now();
}

export function paginate(arr: StoredStatement[], filter: QueryFilter): QueryResult {
  const cursor = decodeCursor(filter.cursor);

  // Pin to the horizon the token was minted at, so later writes cannot shift the
  // offsets of a page sequence already in progress.
  let rows = arr;
  if (cursor?.ts) {
    const horizon = new Date(cursor.ts).toISOString();
    rows = rows.filter(r => r.stored <= horizon);
  }

  const ascending = !!filter.ascending;
  rows = [...rows].sort((a, b) => ascending ? a.stored.localeCompare(b.stored) : b.stored.localeCompare(a.stored));
  const limit = Math.min(filter.limit ?? 100, 500);
  const offset = cursor?.offset ?? 0;

  const page = rows.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const more = nextOffset < rows.length
    ? encodeCursor({
        offset: nextOffset,
        // Keep the ORIGINAL horizon across the whole sequence; re-stamping it each
        // page would let writes leak in partway through and reintroduce the drift.
        //
        // The horizon comes from the DATA — the newest row in the result set as it
        // stands right now — not from the wall clock. Clock-based pinning only works
        // while `stored` tracks real time, so it silently does nothing for imported
        // or backdated statements, and nothing at all under a clock skew. The newest
        // row is the honest definition of "the result set as it stood when paging
        // began", whatever the timestamps mean.
        ts: cursor?.ts ?? horizonOf(rows),
        q: cursorQueryOf(filter),
      })
    : null;
  return { statements: page, more };
}

// ── In-memory implementation ─────────────────────────────────────────
//
// Default backend. Statements live in a Map keyed by UUID. Lost on
// restart — for demos + dev only. The cluster sticks around inside a
// single replica; under multi-replica scale-out you'll get
// inconsistent views, which is why production deployments swap in
// the file or forward backend.

/**
 * Compare two statements for immutability purposes (xAPI 2.0 §4.1.1).
 * LRS-set fields (`stored`, `authority`, the auto-stamped `version`,
 * `authority` when added because the caller didn't supply it) MUST
 * NOT count toward inequality — re-POSTing the same caller-authored
 * payload after a roundtrip would otherwise spuriously 409.
 */
function statementBodyEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const drop = (s: Record<string, unknown>) => {
    const out = { ...s };
    delete out.stored;
    delete out.authority;
    return out;
  };
  return JSON.stringify(drop(a)) === JSON.stringify(drop(b));
}

// ── Process-wide resident-statement budget ───────────────────────────
//
// ★ WHY THE BOUND IS GLOBAL AND NOT PER-STORE.
// Two earlier rounds each capped one axis, and the two caps do not compose:
//   round-36  InMemoryStatementStore.MAX = 50_000  statements PER TENANT
//   round-38  TenantPartition.MAX        = 20_000  tenant partitions
// What exhausts the heap is the PRODUCT — 20_000 × 50_000 = 1_000_000_000 resident
// statements. Measured against these exact classes a representative xAPI 2.0 statement
// costs ~845 B of heap, so the bridge's 3072 MiB heap (NODE_OPTIONS
// --max-old-space-size=3072) is gone at ~3.8 M statements: 262x BELOW what the caps
// allow. Neither cap can fire first — 20_000 tenants x 191 statements OOMs the process
// with the per-tenant cap untouched, and 77 tenants x 50_000 OOMs it with the tenant cap
// untouched. Both guards were unreachable on the path they were written for, which is why
// a bridge OOM has only ever surfaced as an unrelated-looking boot failure.
//
// The bound therefore has to be on the total, shared by every in-memory store alive in the
// process. Eviction takes from the LARGEST live store: under the abuse shape (many
// throwaway lens:<wallet> tenants) that spreads pressure evenly instead of letting a
// per-tenant cap shield each one, and under a single hot tenant it takes from the hog
// rather than from a quiet tenant's records.
//
// Registry entries are WeakRefs: a store dropped without dispose() — or held only by a
// finished test, since vitest runs every file in ONE realm here — must not be pinned alive
// by the budget that is supposed to be protecting memory.
const liveMemoryStores = new Set<WeakRef<InMemoryStatementStore>>();
let residentStatements = 0;

/** Statements the process may hold across ALL in-memory stores. Derived from the real heap
 *  limit rather than a hand-picked constant — a constant with no relationship to the heap
 *  it protects is exactly what failed above. 1 KiB/statement is the measured ~845 B plus
 *  Map-entry overhead; 40 % of the heap leaves room for everything else the bridge holds. */
function defaultResidentBudget(): number {
  const override = Number(process.env.FOXXI_LRS_MEMORY_MAX_STATEMENTS ?? '');
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  return Math.max(10_000, Math.floor((getHeapStatistics().heap_size_limit * 0.4) / 1024));
}
let residentBudget = defaultResidentBudget();

/** The budget and the count charged against it. Exported for /xapi/about and for tests,
 *  which must be able to pin a small budget instead of allocating a real heap's worth. */
export function residentStatementBudget(): number { return residentBudget; }
export function residentStatementCount(): number { return residentStatements; }
export function setResidentStatementBudget(n?: number): void {
  residentBudget = n === undefined ? defaultResidentBudget() : n;
}
/** Test seam: forget every registered store. vitest runs all files in one realm, so a store
 *  left registered by an earlier file is otherwise a candidate victim for a later file's
 *  eviction, and that file's assertions would depend on run order. Fix the polluter. */
export function resetResidentBudgetRegistryForTest(): void {
  liveMemoryStores.clear();
  residentStatements = 0;
}

/** Live stores with their sizes, pruning dead WeakRefs as it walks. */
function liveStoresWithSizes(): Array<{ store: InMemoryStatementStore; size: number }> {
  const out: Array<{ store: InMemoryStatementStore; size: number }> = [];
  for (const ref of liveMemoryStores) {
    const store = ref.deref();
    if (store === undefined) { liveMemoryStores.delete(ref); continue; }
    out.push({ store, size: store.residentSize() });
  }
  return out;
}

function evictToBudget(): void {
  if (residentStatements <= residentBudget) return;
  // RESYNC BEFORE EVICTING. `residentStatements` is maintained incrementally, so it drifts
  // upward whenever a store is collected or dropped without dispose(). Uncorrected drift
  // would eventually make every put evict something. Recomputing from the live registry is
  // O(live stores) and runs only while we are over budget.
  const live = liveStoresWithSizes();
  residentStatements = live.reduce((n, e) => n + e.size, 0);
  while (residentStatements > residentBudget) {
    let victim: { store: InMemoryStatementStore; size: number } | null = null;
    for (const e of live) if (victim === null || e.size > victim.size) victim = e;
    // Nothing left to take — a budget smaller than the live-store count cannot be met by
    // eviction. Stop rather than spin.
    if (victim === null || victim.size === 0) return;
    victim.store.evictOldest();
    victim.size--;
    residentStatements--;
  }
}

export class InMemoryStatementStore implements StatementStore {
  private readonly store = new Map<string, StoredStatement>();
  /** Whether this instance draws on the process-wide budget. A FileStatementStore's
   *  snapshot opts OUT: it is the read path for data that IS on disk, so evicting from it
   *  would make get() answer null for a statement the file still holds. Stores that are
   *  themselves the only copy (the LRS backend, the primary-forward cache) opt in. */
  private readonly budgeted: boolean;
  private readonly selfRef: WeakRef<InMemoryStatementStore>;

  constructor(opts: { budgeted?: boolean } = {}) {
    this.budgeted = opts.budgeted !== false;
    this.selfRef = new WeakRef(this);
    if (this.budgeted) liveMemoryStores.add(this.selfRef);
  }

  /** Entries held right now — the budget's unit of account. */
  residentSize(): number { return this.store.size; }

  /** Drop the oldest entry (insertion order). Only evictToBudget calls this; it settles
   *  `residentStatements` itself so the count and the loop stay consistent. */
  evictOldest(): void {
    const oldest = this.store.keys().next().value;
    if (oldest !== undefined) this.store.delete(oldest);
  }

  /** Leave the process-wide budget. TenantPartition calls this when it drops a partition —
   *  without it the budget keeps charging every later write for statements that nothing can
   *  read again, and the bridge throttles itself to death on phantom occupancy. */
  dispose(): void {
    liveMemoryStores.delete(this.selfRef);
    // Return the entries EAGERLY. evictToBudget() resyncs from the live registry, but only
    // once already over budget — so without this the counter stays inflated by every
    // dropped partition until the next over-budget write, and the first thing that write
    // does is evict a LIVE tenant's oldest records to pay for statements nothing can read.
    if (this.budgeted) residentStatements = Math.max(0, residentStatements - this.store.size);
    this.store.clear();
  }

  async put(record: StoredStatement): Promise<void> {
    const prior = this.store.get(record.id);
    if (prior && !statementBodyEqual(prior.statement, record.statement)) {
      throw new ConflictError(`statement id ${record.id} already stored with different content (xAPI 2.0 §4.1.1)`);
    }
    // First-write wins on the LRS-set fields — keep the original `stored`
    // + `authority` so the canonical statement stays stable through
    // re-POSTs. Caller's idempotent re-POSTs return 200 / 204 without
    // mutating the stored body.
    if (prior) return;
    this.store.set(record.id, record);
    if (this.budgeted) { residentStatements++; evictToBudget(); }
  }
  async get(id: string): Promise<StoredStatement | null> { return this.store.get(id) ?? null; }
  async markVoided(id: string, voidingStatementId: string): Promise<void> {
    const r = this.store.get(id);
    if (r) { r.voided = true; r.voidingStatementId = voidingStatementId; }
  }
  async query(filter: QueryFilter): Promise<QueryResult> {
    if (filter.statementId) {
      const r = this.store.get(filter.statementId);
      if (!r || r.voided) return { statements: [], more: null };
      return { statements: [r], more: null };
    }
    if (filter.voidedStatementId) {
      const r = this.store.get(filter.voidedStatementId);
      if (!r || !r.voided) return { statements: [], more: null };
      return { statements: [r], more: null };
    }
    const all = [...this.store.values()].filter(r => !r.voided && matchesFilter(r, filter));
    return paginate(all, filter);
  }
  async listAll(): Promise<StoredStatement[]> { return [...this.store.values()]; }
  async count(): Promise<number> { return this.store.size; }
  async clear(): Promise<void> {
    // Return the entries to the budget, or a clear() leaves the process permanently
    // charged for statements that no longer exist.
    if (this.budgeted) residentStatements = Math.max(0, residentStatements - this.store.size);
    this.store.clear();
  }
  /** Reports the budget, not just the backend name: an evicted statement is indistinguishable
   *  from a fabricated one to anyone following a rawDataLocation pointer, so /xapi/about has
   *  to say how close this LRS is to dropping records. */
  backendDescription(): string {
    return `in-memory (single-replica; lost on restart; ${residentStatements}/${residentBudget} statements resident process-wide)`;
  }
}

// ── File-backed implementation ───────────────────────────────────────
//
// Each statement is one JSONL line in `<dir>/statements.jsonl`; voiding
// is tracked in `<dir>/voided.json`. On boot the store reads the JSONL
// stream once into memory; subsequent writes append + update the in-
// memory snapshot. Survives restarts; cheap; single-process.

export class FileStatementStore implements StatementStore {
  // Opts out of the process-wide budget: this snapshot is the READ PATH for statements the
  // JSONL file still holds, so evicting from it would make get() answer null for durable data.
  private readonly memory = new InMemoryStatementStore({ budgeted: false });
  private loaded = false;

  constructor(private readonly dir: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(join(this.dir, 'statements.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const rec = JSON.parse(line) as StoredStatement;
        // Bypass put()'s conflict check — file is the source of truth.
        await this.memory['store' as keyof InMemoryStatementStore as 'store'].set?.(rec.id, rec);
        (this.memory as unknown as { store: Map<string, StoredStatement> }).store.set(rec.id, rec);
      }
    } catch { /* file may not exist yet */ }
    this.loaded = true;
  }

  async put(record: StoredStatement): Promise<void> {
    await this.ensureLoaded();
    await this.memory.put(record);
    await fs.appendFile(join(this.dir, 'statements.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  }
  async get(id: string): Promise<StoredStatement | null> {
    await this.ensureLoaded();
    return this.memory.get(id);
  }
  async markVoided(id: string, voidingStatementId: string): Promise<void> {
    await this.ensureLoaded();
    await this.memory.markVoided(id, voidingStatementId);
    // Append-only marker; on reload, replay reapplies (would need a rewrite
    // pass in production — file backend is best for low-volume tenants).
    await fs.appendFile(join(this.dir, 'voided.jsonl'), JSON.stringify({ id, voidingStatementId, at: new Date().toISOString() }) + '\n');
  }
  async query(filter: QueryFilter): Promise<QueryResult> { await this.ensureLoaded(); return this.memory.query(filter); }
  async listAll(): Promise<StoredStatement[]> { await this.ensureLoaded(); return this.memory.listAll(); }
  async count(): Promise<number> { await this.ensureLoaded(); return this.memory.count(); }
  async clear(): Promise<void> {
    await this.memory.clear();
    try { await fs.rm(join(this.dir, 'statements.jsonl')); } catch { /* ignore */ }
    try { await fs.rm(join(this.dir, 'voided.jsonl')); } catch { /* ignore */ }
  }
  backendDescription(): string { return `file:${this.dir} (append-only JSONL; survives restart)`; }
}

// ── Primary-forward implementation ───────────────────────────────────
//
// The external LRS is the source of truth; Foxxi-as-LRS keeps a local
// read-through cache for the dashboard. Use this when you've already
// got Watershed / Yet Analytics / SCORM Cloud LRS and just want Foxxi
// to be a peer write surface that decorates statements with Foxxi
// context. Writes block on the external LRS POST (status returned to
// the caller); reads still hit the local cache for speed.

export class PrimaryForwardStatementStore implements StatementStore {
  private readonly cache = new InMemoryStatementStore();
  constructor(
    private readonly endpoint: string,
    private readonly auth: { user: string; pass: string },
    private readonly version: string = '2.0.0',
  ) {}
  async put(record: StoredStatement): Promise<void> {
    await this.cache.put(record);
    // Transient-network retry: the external primary LRS is the source of
    // truth; a 5xx or socket blip should retry rather than silently
    // diverging the local cache from the primary. 4xx (incl. 409
    // immutability) surfaces immediately as the spec requires.
    const r = await withTransientRetry(async () => {
      const resp = await fetch(`${this.endpoint.replace(/\/$/, '')}/statements`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Experience-API-Version': this.version,
          'Authorization': `Basic ${Buffer.from(`${this.auth.user}:${this.auth.pass}`).toString('base64')}`,
        },
        body: JSON.stringify(record.statement),
      });
      if (resp.status >= 500) {
        throw new Error(`primary LRS failed: ${resp.status} ${resp.statusText}`);
      }
      return resp;
    }).catch(err => { throw new Error(`primary LRS unreachable: ${(err as Error).message}`); });
    if (!r.ok && r.status !== 204 && r.status !== 409) {
      throw new Error(`primary LRS rejected statement (HTTP ${r.status})`);
    }
  }
  async get(id: string): Promise<StoredStatement | null> { return this.cache.get(id); }
  async markVoided(id: string, voidingStatementId: string): Promise<void> { return this.cache.markVoided(id, voidingStatementId); }
  async query(filter: QueryFilter): Promise<QueryResult> { return this.cache.query(filter); }
  async listAll(): Promise<StoredStatement[]> { return this.cache.listAll(); }
  async count(): Promise<number> { return this.cache.count(); }
  async clear(): Promise<void> { return this.cache.clear(); }
  backendDescription(): string { return `primary-forward → ${this.endpoint} (external LRS as source of truth; local read-through cache)`; }
}

export class ConflictError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ConflictError'; }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createStatementStore(spec: string = 'memory'): StatementStore {
  if (!spec || spec === 'memory') return new InMemoryStatementStore();
  if (spec.startsWith('file:')) return new FileStatementStore(spec.slice(5));
  if (spec.startsWith('forward:')) {
    // forward:https://lrs.example/xapi||user||password
    const inner = spec.slice('forward:'.length);
    const [endpoint, user, pass, version] = inner.split('||');
    if (!endpoint || !user || pass === undefined) {
      throw new Error('FOXXI_LRS_BACKEND=forward:<endpoint>||<user>||<password>[||<version>]');
    }
    return new PrimaryForwardStatementStore(endpoint, { user, pass }, version || '2.0.0');
  }
  // pod-backed projection: from the outside this is an xAPI 2.0 LRS;
  // from the inside every statement is a real iep:ContextDescriptor in
  // the tenant pod. Reads from FOXXI_TENANT_POD_URL +
  // FOXXI_AUTHORITATIVE_SOURCE env vars.
  if (spec === 'pod' || spec.startsWith('pod:')) {
    const podUrl = process.env.FOXXI_TENANT_POD_URL;
    const authoritativeSource = process.env.FOXXI_AUTHORITATIVE_SOURCE;
    if (!podUrl) throw new Error('FOXXI_LRS_BACKEND=pod requires FOXXI_TENANT_POD_URL to be set');
    if (!authoritativeSource) throw new Error('FOXXI_LRS_BACKEND=pod requires FOXXI_AUTHORITATIVE_SOURCE to be set');
    // Per-spec container override: pod:foxxi/learning-record/ -> foxxi/learning-record/
    const containerPath = spec.startsWith('pod:') ? spec.slice('pod:'.length) : 'foxxi/lrs/';
    return new PodStatementStore({ podUrl, authoritativeSource: authoritativeSource as unknown as never, containerPath });
  }
  throw new Error(`unknown FOXXI_LRS_BACKEND=${spec}; accepted: memory | file:<dir> | forward:<endpoint>||<user>||<password>[||<version>] | pod[:container-path]`);
}

export { randomUUID };
