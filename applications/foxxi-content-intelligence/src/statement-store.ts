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
 *   memory                 ← default (no persistence; lost on restart)
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

export function paginate(arr: StoredStatement[], filter: QueryFilter): QueryResult {
  const ascending = !!filter.ascending;
  arr.sort((a, b) => ascending ? a.stored.localeCompare(b.stored) : b.stored.localeCompare(a.stored));
  const limit = Math.min(filter.limit ?? 100, 500);

  let offset = 0;
  if (filter.cursor) {
    try {
      const decoded = Buffer.from(filter.cursor, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as { offset: number };
      if (typeof parsed.offset === 'number') offset = parsed.offset;
    } catch { /* ignore bad cursor */ }
  }

  const page = arr.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const more = nextOffset < arr.length
    ? Buffer.from(JSON.stringify({ offset: nextOffset, ts: Date.now() }), 'utf8').toString('base64url')
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

export class InMemoryStatementStore implements StatementStore {
  private readonly store = new Map<string, StoredStatement>();

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
  async clear(): Promise<void> { this.store.clear(); }
  backendDescription(): string { return 'in-memory (single-replica; lost on restart)'; }
}

// ── File-backed implementation ───────────────────────────────────────
//
// Each statement is one JSONL line in `<dir>/statements.jsonl`; voiding
// is tracked in `<dir>/voided.json`. On boot the store reads the JSONL
// stream once into memory; subsequent writes append + update the in-
// memory snapshot. Survives restarts; cheap; single-process.

export class FileStatementStore implements StatementStore {
  private readonly memory = new InMemoryStatementStore();
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
  // from the inside every statement is a real cg:ContextDescriptor in
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
