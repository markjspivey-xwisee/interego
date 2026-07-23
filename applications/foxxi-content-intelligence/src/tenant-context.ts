/**
 * Multi-tenancy for the Foxxi vertical.
 *
 * One Foxxi bridge can serve many customer organisations. A TENANT is
 * one such org, identified by its tenant pod URL (equivalently, its
 * authoritative-source DID). Every in-memory store the bridge holds —
 * the xAPI statement store, the State / Activity-Profile / Agent-Profile
 * document stores, the attachment store, the agent-trajectory and
 * performance-probe stores, the evaluation registry — is partitioned by
 * tenant through `TenantPartition`, so tenant A can never see, collide
 * with, or overwrite tenant B's data.
 *
 * Tenant resolution:
 *   · affordance handlers — the tenant is the `tenant_pod_url` argument,
 *     already resolved per request by resolveCaller / autoFetchAdmin;
 *   · the xAPI LRS — the tenant is carried by the auth credential. A
 *     Basic-auth pair may be `user:pass` (→ the default tenant) or
 *     `user:pass:tenantId` (→ a named tenant). Each upstream LMS / LRS
 *     integration is issued its own credential, which is the standard
 *     multi-tenant LRS pattern.
 *
 * Single-tenant deployments need no change: with no tenant named, every
 * request resolves to DEFAULT_TENANT and behaviour is byte-identical to
 * the single-tenant build. Multi-tenancy is opt-in, per request, and
 * additive — never a breaking change.
 *
 * Layer: L3 vertical. No new ontology term — a tenant is just the pod
 * the substrate already addresses.
 */

/** The stable key everything partitions by. */
export type TenantId = string;

/** The tenant a request resolves to when none is named. */
export const DEFAULT_TENANT: TenantId = 'default';

/**
 * Normalise a tenant pod URL or authoritative-source DID to a stable
 * tenant key. Empty / missing → the default tenant.
 */
export function tenantIdOf(podUrlOrDid: string | undefined | null): TenantId {
  if (!podUrlOrDid || !podUrlOrDid.trim()) return DEFAULT_TENANT;
  return podUrlOrDid.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * A lazily-populated registry of per-tenant store instances. The store
 * for a tenant is created on first touch by the factory; tenants that
 * never appear cost nothing.
 *
 *   const statements = new TenantPartition(() => createStatementStore());
 *   statements.for(tenant).put(record);
 */
export class TenantPartition<T> {
  private readonly byTenant = new Map<TenantId, T>();
  /** Cap the number of distinct tenant partitions — each distinct signed wallet mints a
   *  distinct lens:<eth-…> tenant, so an attacker cycling throwaway wallets would otherwise
   *  create per-tenant stores without limit (round-38 DoS). Evict the oldest partition past
   *  the cap (partitions are derived, rebuildable views; the durable data is the pod). */
  private static readonly MAX = 20_000;

  constructor(private readonly factory: (tenant: TenantId) => T) {}

  /** The store for one tenant — created on first use. */
  for(tenant: TenantId): T {
    let store = this.byTenant.get(tenant);
    if (store === undefined) {
      if (this.byTenant.size >= TenantPartition.MAX) {
        const oldest = this.byTenant.keys().next().value;
        if (oldest !== undefined) this.byTenant.delete(oldest);
      }
      store = this.factory(tenant);
      this.byTenant.set(tenant, store);
    }
    return store;
  }

  has(tenant: TenantId): boolean {
    return this.byTenant.has(tenant);
  }

  /** Every tenant currently holding state. */
  tenants(): TenantId[] {
    return [...this.byTenant.keys()];
  }

  /** Every tenant's store — for cross-tenant ops / metrics only. */
  all(): Array<[TenantId, T]> {
    return [...this.byTenant.entries()];
  }
}

/**
 * Parse a `FOXXI_LRS_BASIC_AUTH_PAIRS` entry. Each comma-separated entry
 * is `user:pass` (the default tenant) or `user:pass:tenantId` (a named
 * tenant). Returns the credential→tenant map keyed by `user:pass`.
 */
export function parseTenantCredentials(pairs: string): Map<string, TenantId> {
  const out = new Map<string, TenantId>();
  for (const raw of pairs.split(',').map(s => s.trim()).filter(Boolean)) {
    const parts = raw.split(':');
    if (parts.length < 2) continue;
    const user = parts[0]!;
    const pass = parts[1]!;
    // Anything after the second colon is the tenant id (a pod URL may
    // itself contain colons, so re-join the remainder).
    const tenant = parts.length > 2 ? tenantIdOf(parts.slice(2).join(':')) : DEFAULT_TENANT;
    out.set(`${user}:${pass}`, tenant);
  }
  return out;
}
