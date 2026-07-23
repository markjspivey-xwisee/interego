/**
 * Runtime-managed xAPI Statement Forwarding + inbound forwarding control
 * for the Foxxi LRS. Three concerns, one cohesive module, all tenant-
 * partitioned (a single-tenant deployment resolves everything to
 * DEFAULT_TENANT and behaves byte-identically):
 *
 *   1. OUTBOUND forwarding targets — downstream LRSes this LRS forwards
 *      every accepted Statement to. Previously env-only
 *      (FOXXI_LRS_FORWARDING_TARGETS); now a mutable registry with
 *      per-target delivery metrics + a dead-letter queue for manual retry.
 *      The env value seeds the DEFAULT_TENANT registry on first use, so
 *      existing deployments keep their configured targets.
 *
 *   2. INBOUND credentials — the Basic-auth principals upstream systems
 *      use to forward Statements *into* this LRS. Seeded from
 *      FOXXI_LRS_BASIC_AUTH_PAIRS; mutable at runtime so an operator can
 *      mint/revoke a forwarding credential without a redeploy. The auth
 *      gate consults the live credential map, so additions take effect
 *      immediately.
 *
 *   3. INBOUND receipts — a bounded ring buffer recording which credential
 *      delivered which Statement and when, so the operator can SEE what
 *      arrived by forwarding (the inbound counterpart to outbound metrics).
 *      Receipts never mutate the Statement itself (xAPI immutability +
 *      conformance), they live entirely in this side-channel.
 *
 * Secrets (target credentials, inbound secrets) are stored here but NEVER
 * echoed in full by the read APIs — only a principal + a secret-length
 * hint, the same discipline as the existing /xapi/admin/config handler.
 */

import { withTransientRetry } from '@interego/solid';
import { assertSafeFetchTarget } from './ssrf-guard.js';
import { TenantPartition, DEFAULT_TENANT, tenantIdOf, type TenantId } from './tenant-context.js';
import type { ForwardingConfigBlob, RawForwardingTarget, RawInboundCredential } from './forwarding-persist.js';

// ── Outbound forwarding targets ─────────────────────────────────────

export interface ForwardingTarget {
  id: string;
  label: string;
  /** Base xAPI endpoint — the LRS POSTs to `<endpoint>/statements`. */
  endpoint: string;
  /** Basic-auth credentials `user:pass` for the downstream LRS. */
  credentials: string;
  /** X-Experience-API-Version sent to the downstream LRS. */
  version: string;
  enabled: boolean;
  createdAt: string;
}

export interface ForwardingMetrics {
  delivered: number;
  failed: number;
  lastStatus: number | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  lastDeliveredAt: string | null;
  /** Cumulative successful-delivery latency, for an average. */
  totalLatencyMs: number;
  deadLetterDepth: number;
}

interface DeadLetter {
  statementId: string;
  statement: Record<string, unknown>;
  error: string;
  at: string;
}

interface TargetState {
  target: ForwardingTarget;
  metrics: ForwardingMetrics;
  deadLetter: DeadLetter[];
}

/** Public, redaction-safe view of a target (no raw credentials). */
export interface ForwardingTargetView {
  id: string;
  label: string;
  endpoint: string;
  version: string;
  enabled: boolean;
  createdAt: string;
  principal: string;
  secretHint: string;
  metrics: ForwardingMetrics & { avgLatencyMs: number | null };
}

const MAX_DEAD_LETTER = 200;

const targetsByTenant = new TenantPartition<Map<string, TargetState>>(() => new Map());
const seededTenants = new Set<TenantId>();

// ── Durable hydration (lazy, once per tenant) ───────────────────────
// The registry is in-memory; the bridge registers a hydrator that loads +
// imports an owner's encrypted config from their pod, so per-user forwarding
// survives a restart. ensureForwardingHydrated runs the hydrator at most once
// per tenant, and (importantly) BEFORE the first forward to that tenant, so a
// statement arriving right after a restart isn't silently dropped.
type ForwardingHydrator = (tenant: TenantId) => Promise<void>;
let _hydrator: ForwardingHydrator | null = null;
const _hydrated = new Set<TenantId>();
export function registerForwardingHydrator(fn: ForwardingHydrator): void { _hydrator = fn; }
/** Mark a tenant already hydrated (e.g. the affordance handler loaded it with a known pod). */
export function markForwardingHydrated(tenant: TenantId): void { _hydrated.add(tenant); }
export async function ensureForwardingHydrated(tenant: TenantId): Promise<void> {
  if (_hydrated.has(tenant)) return;
  _hydrated.add(tenant); // mark first so a failed/slow load doesn't re-loop
  if (_hydrator) { try { await _hydrator(tenant); } catch { /* best-effort */ } }
}

function freshMetrics(): ForwardingMetrics {
  return {
    delivered: 0, failed: 0, lastStatus: null, lastError: null,
    lastAttemptAt: null, lastDeliveredAt: null, totalLatencyMs: 0, deadLetterDepth: 0,
  };
}

function principalOf(credentials: string): string {
  return credentials.split(':')[0] ?? '';
}
function secretHintOf(credentials: string): string {
  const secret = credentials.split(':').slice(1).join(':');
  return `(secret length ${secret.length})`;
}

function stableTargetId(endpoint: string, credentials: string): string {
  // Deterministic so re-seeding the same env value is idempotent.
  const key = `${endpoint}|${principalOf(credentials)}`;
  return 'fwd-' + Buffer.from(key).toString('base64url').slice(0, 24);
}

/**
 * Seed a tenant's target registry from a `FOXXI_LRS_FORWARDING_TARGETS`
 * string (`endpoint||user:pass||version`, comma-separated). Idempotent:
 * a target with the same endpoint+principal is not duplicated. Runs once
 * per tenant (first forward / first admin read).
 */
export function seedForwardingTargets(tenant: TenantId, envValue: string): void {
  if (seededTenants.has(tenant)) return;
  seededTenants.add(tenant);
  const map = targetsByTenant.for(tenant);
  for (const raw of envValue.split(',').map(s => s.trim()).filter(Boolean)) {
    const [endpoint, credentials, version] = raw.split('||');
    if (!endpoint || !credentials) continue;
    const id = stableTargetId(endpoint, credentials);
    if (map.has(id)) continue;
    map.set(id, {
      target: {
        id, label: principalOf(credentials) || endpoint,
        endpoint: endpoint.replace(/\/$/, ''), credentials,
        version: version || '2.0.0', enabled: true, createdAt: new Date().toISOString(),
      },
      metrics: freshMetrics(), deadLetter: [],
    });
  }
}

function viewOf(st: TargetState): ForwardingTargetView {
  const avg = st.metrics.delivered > 0 ? Math.round(st.metrics.totalLatencyMs / st.metrics.delivered) : null;
  return {
    id: st.target.id, label: st.target.label, endpoint: st.target.endpoint,
    version: st.target.version, enabled: st.target.enabled, createdAt: st.target.createdAt,
    principal: principalOf(st.target.credentials), secretHint: secretHintOf(st.target.credentials),
    metrics: { ...st.metrics, avgLatencyMs: avg },
  };
}

export function listForwardingTargets(tenant: TenantId): ForwardingTargetView[] {
  return [...targetsByTenant.for(tenant).values()].map(viewOf);
}

export function addForwardingTarget(tenant: TenantId, input: {
  label?: string; endpoint: string; credentials: string; version?: string; enabled?: boolean;
}): ForwardingTargetView {
  const endpoint = input.endpoint.replace(/\/$/, '');
  const id = stableTargetId(endpoint, input.credentials);
  const map = targetsByTenant.for(tenant);
  const existing = map.get(id);
  const st: TargetState = existing ?? { target: {
    id, label: '', endpoint, credentials: input.credentials, version: '2.0.0',
    enabled: true, createdAt: new Date().toISOString(),
  }, metrics: freshMetrics(), deadLetter: [] };
  st.target.label = input.label?.trim() || principalOf(input.credentials) || endpoint;
  st.target.endpoint = endpoint;
  st.target.credentials = input.credentials;
  st.target.version = input.version?.trim() || st.target.version || '2.0.0';
  st.target.enabled = input.enabled ?? st.target.enabled;
  map.set(id, st);
  return viewOf(st);
}

export function updateForwardingTarget(tenant: TenantId, id: string, patch: {
  label?: string; endpoint?: string; credentials?: string; version?: string; enabled?: boolean;
}): ForwardingTargetView | null {
  const map = targetsByTenant.for(tenant);
  const st = map.get(id);
  if (!st) return null;
  if (patch.label !== undefined) st.target.label = patch.label;
  if (patch.endpoint !== undefined) st.target.endpoint = patch.endpoint.replace(/\/$/, '');
  if (patch.credentials !== undefined && patch.credentials.includes(':')) st.target.credentials = patch.credentials;
  if (patch.version !== undefined) st.target.version = patch.version || '2.0.0';
  if (patch.enabled !== undefined) st.target.enabled = patch.enabled;
  return viewOf(st);
}

export function deleteForwardingTarget(tenant: TenantId, id: string): boolean {
  return targetsByTenant.for(tenant).delete(id);
}

export function forwardingMetrics(tenant: TenantId): ForwardingTargetView[] {
  return listForwardingTargets(tenant);
}

async function deliver(st: TargetState, stmt: Record<string, unknown>): Promise<boolean> {
  const started = Date.now();
  st.metrics.lastAttemptAt = new Date().toISOString();
  try {
    // SSRF guard: a forwarding target endpoint can be registered by a self-sovereign
    // (non-operator) caller, so reject a private/loopback/link-local target before POSTing
    // statements to it (an internal endpoint would turn each forward into a blind SSRF).
    await assertSafeFetchTarget(`${st.target.endpoint.replace(/\/$/, '')}/statements`);
    const r = await withTransientRetry(async () => {
      const resp = await fetch(`${st.target.endpoint.replace(/\/$/, '')}/statements`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${Buffer.from(st.target.credentials).toString('base64')}`,
          'X-Experience-API-Version': st.target.version || '2.0.0',
        },
        body: JSON.stringify(stmt),
      });
      if (resp.status >= 500) throw new Error(`forward POST ${resp.status} ${resp.statusText}`);
      return resp;
    });
    st.metrics.lastStatus = r.status;
    if (r.ok) {
      st.metrics.delivered++;
      st.metrics.totalLatencyMs += Date.now() - started;
      st.metrics.lastDeliveredAt = new Date().toISOString();
      st.metrics.lastError = null;
      return true;
    }
    recordFailure(st, stmt, `HTTP ${r.status} ${r.statusText}`);
    return false;
  } catch (err) {
    recordFailure(st, stmt, (err as Error).message);
    return false;
  }
}

function recordFailure(st: TargetState, stmt: Record<string, unknown>, error: string): void {
  st.metrics.failed++;
  st.metrics.lastError = error;
  st.deadLetter.push({ statementId: String(stmt.id ?? ''), statement: stmt, error, at: new Date().toISOString() });
  if (st.deadLetter.length > MAX_DEAD_LETTER) st.deadLetter.shift();
  st.metrics.deadLetterDepth = st.deadLetter.length;
}

/**
 * Forward an accepted Statement to every enabled downstream target for the
 * tenant. Fire-and-forget from the caller's perspective: a forwarding
 * failure is recorded in the dead-letter queue, never propagated back to
 * the inbound POST (which already succeeded).
 */
export async function forwardStatement(tenant: TenantId, stmt: Record<string, unknown>): Promise<void> {
  await ensureForwardingHydrated(tenant);
  const map = targetsByTenant.for(tenant);
  if (map.size === 0) return;
  for (const st of map.values()) {
    if (!st.target.enabled) continue;
    await deliver(st, stmt);
  }
}

/**
 * Replay the dead-letter queue for one target (or every target when `id`
 * is omitted). Statements that deliver successfully are removed from the
 * queue; the rest stay for the next retry. Returns a per-target summary.
 */
export async function retryDeadLetter(tenant: TenantId, id?: string): Promise<Array<{ id: string; retried: number; delivered: number; remaining: number }>> {
  const map = targetsByTenant.for(tenant);
  const states = id ? (map.has(id) ? [map.get(id)!] : []) : [...map.values()];
  const out: Array<{ id: string; retried: number; delivered: number; remaining: number }> = [];
  for (const st of states) {
    const pending = st.deadLetter.splice(0, st.deadLetter.length);
    st.metrics.deadLetterDepth = 0;
    let delivered = 0;
    for (const dl of pending) {
      const ok = await deliver(st, dl.statement);
      if (ok) delivered++;
    }
    out.push({ id: st.target.id, retried: pending.length, delivered, remaining: st.deadLetter.length });
  }
  return out;
}

export function deadLetterFor(tenant: TenantId, id: string): DeadLetter[] {
  return targetsByTenant.for(tenant).get(id)?.deadLetter ?? [];
}

// ── Durable export / import (raw, includes secrets — for own-pod persistence) ──

/** A tenant's full config (targets + inbound credentials, WITH secrets) for encrypted persistence. */
export function exportForwardingConfig(tenant: TenantId): ForwardingConfigBlob {
  const targets: RawForwardingTarget[] = [...targetsByTenant.for(tenant).values()].map(st => ({
    id: st.target.id, label: st.target.label, endpoint: st.target.endpoint,
    credentials: st.target.credentials, version: st.target.version,
    enabled: st.target.enabled, createdAt: st.target.createdAt,
  }));
  return { targets, credentials: inboundCredentials.exportForTenant(tenant), updatedAt: new Date().toISOString() };
}

/** Replace a tenant's in-memory targets + inbound credentials from a decrypted blob (ids/createdAt preserved). */
export function importForwardingConfig(tenant: TenantId, blob: ForwardingConfigBlob): void {
  const map = targetsByTenant.for(tenant);
  map.clear();
  for (const t of blob.targets ?? []) {
    map.set(t.id, {
      target: { id: t.id, label: t.label, endpoint: t.endpoint, credentials: t.credentials, version: t.version, enabled: t.enabled, createdAt: t.createdAt },
      metrics: freshMetrics(), deadLetter: [],
    });
  }
  for (const c of blob.credentials ?? []) inboundCredentials.importRaw(c);
}

// ── Inbound credentials ─────────────────────────────────────────────

export interface InboundCredential {
  id: string;
  principal: string;
  secret: string;
  tenant: TenantId;
  label: string;
  createdAt: string;
}

export interface InboundCredentialView {
  id: string;
  principal: string;
  secretHint: string;
  tenant: string;
  label: string;
  createdAt: string;
}

/**
 * The live credential→tenant map the auth gate consults. Keyed by the
 * decoded `user:pass` Basic-auth string — exactly the lookup
 * `basicAuthTenant` already performs, so wiring this map into the gate is
 * a drop-in for the previously-static map and runtime additions take
 * effect immediately.
 */
class InboundCredentialRegistry {
  readonly liveMap = new Map<string, TenantId>();
  private readonly meta = new Map<string, InboundCredential>();
  private seeded = false;

  seedFromEnv(pairs: string): void {
    if (this.seeded) return;
    this.seeded = true;
    for (const raw of pairs.split(',').map(s => s.trim()).filter(Boolean)) {
      const parts = raw.split(':');
      if (parts.length < 2) continue;
      const principal = parts[0]!;
      const secret = parts[1]!;
      const tenant = parts.length > 2 ? tenantIdOf(parts.slice(2).join(':')) : DEFAULT_TENANT;
      this.put(principal, secret, tenant, `${principal} (env)`);
    }
  }

  private put(principal: string, secret: string, tenant: TenantId, label: string): InboundCredential {
    const id = 'cred-' + Buffer.from(`${principal}:${tenant}`).toString('base64url').slice(0, 24);
    const cred: InboundCredential = { id, principal, secret, tenant, label, createdAt: new Date().toISOString() };
    this.meta.set(id, cred);
    this.liveMap.set(`${principal}:${secret}`, tenant);
    return cred;
  }

  add(input: { principal: string; secret: string; tenant?: string; label?: string }): InboundCredentialView {
    const tenant = tenantIdOf(input.tenant);
    const cred = this.put(input.principal, input.secret, tenant, input.label?.trim() || input.principal);
    return this.view(cred);
  }

  remove(id: string): boolean {
    const cred = this.meta.get(id);
    if (!cred) return false;
    this.meta.delete(id);
    this.liveMap.delete(`${cred.principal}:${cred.secret}`);
    return true;
  }

  /** Raw export (WITH secrets) for a tenant — for encrypted own-pod persistence. */
  exportForTenant(tenant: TenantId): RawInboundCredential[] {
    return [...this.meta.values()]
      .filter(c => c.tenant === tenant)
      .map(c => ({ id: c.id, principal: c.principal, secret: c.secret, tenant: String(c.tenant), label: c.label, createdAt: c.createdAt }));
  }

  /** Restore a credential from a decrypted blob, preserving id + createdAt. */
  importRaw(c: RawInboundCredential): void {
    const tenant = tenantIdOf(c.tenant);
    this.meta.set(c.id, { id: c.id, principal: c.principal, secret: c.secret, tenant, label: c.label, createdAt: c.createdAt });
    this.liveMap.set(`${c.principal}:${c.secret}`, tenant);
  }

  /** Resolve a decoded `user:pass` to its credential + tenant (gate uses this for the principal label). */
  resolve(decoded: string): { tenant: TenantId; principal: string } | null {
    const tenant = this.liveMap.get(decoded);
    if (tenant === undefined) return null;
    return { tenant, principal: decoded.split(':')[0] ?? '' };
  }

  list(): InboundCredentialView[] {
    return [...this.meta.values()].map(c => this.view(c));
  }

  private view(c: InboundCredential): InboundCredentialView {
    return {
      id: c.id, principal: c.principal, secretHint: `(secret length ${c.secret.length})`,
      tenant: String(c.tenant), label: c.label, createdAt: c.createdAt,
    };
  }
}

export const inboundCredentials = new InboundCredentialRegistry();

// ── Inbound receipts (forwarded-IN visibility) ──────────────────────

export interface InboundReceipt {
  statementId: string;
  principal: string;
  verb: string | null;
  actor: string | null;
  at: string;
}

const MAX_RECEIPTS = 500;
const receiptsByTenant = new TenantPartition<InboundReceipt[]>(() => []);

/**
 * Record that a Statement was accepted via an inbound forwarding
 * credential. Called from the POST/PUT handlers only when the request
 * authenticated with Basic auth (i.e. an upstream system, not a launched
 * learner session). Pure side-channel — the Statement is untouched.
 */
export function recordInbound(tenant: TenantId, principal: string, stmt: Record<string, unknown>): void {
  const buf = receiptsByTenant.for(tenant);
  const verb = (stmt.verb as { id?: string } | undefined)?.id ?? null;
  const actor = (stmt.actor as { name?: string; account?: { name?: string }; mbox?: string } | undefined);
  buf.push({
    statementId: String(stmt.id ?? ''),
    principal,
    verb,
    actor: actor?.name ?? actor?.account?.name ?? actor?.mbox ?? null,
    at: new Date().toISOString(),
  });
  if (buf.length > MAX_RECEIPTS) buf.shift();
}

export function listInboundReceipts(tenant: TenantId, limit = 100): { total: number; receipts: InboundReceipt[] } {
  const buf = receiptsByTenant.for(tenant);
  return { total: buf.length, receipts: [...buf].reverse().slice(0, limit) };
}
