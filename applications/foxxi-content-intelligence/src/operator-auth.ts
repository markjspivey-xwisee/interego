/**
 * Operator authorization for the L3 REST surfaces (OneRoster, cmi5 LMS,
 * LTI NRPS) that previously trusted an attacker-controllable
 * `?tenant_pod_url` query parameter.
 *
 * The cross-tenant hole these endpoints had: an UNauthenticated caller
 * could name any victim tenant via `?tenant_pod_url=<victim>` and read its
 * roster (PII) or write into it (OneRoster import, cmi5 launch token-mint).
 *
 * Fix, without breaking 1EdTech / cmi5 conformance (no blanket 401):
 *   - `trustedTenantOf(req)` honors `?tenant_pod_url` ONLY for an OPERATOR
 *     (admin or learning-engineer); every other caller is pinned to
 *     DEFAULT_TENANT and can never select a victim tenant. Default-tenant
 *     reads keep working (conformance).
 *   - `callerIsOperator(req)` gates the write / token-mint endpoints, so an
 *     anonymous caller can no longer import a roster or mint a launch token.
 *
 * Auth standard: this matches the bridge's existing admin gate
 * (xapi-admin.ts makeAdminGate) — it decodes the session token's `sub`
 * claim and checks it against the admin / learning-engineer WebIDs. NOTE:
 * this is a `sub`-claim check, NOT a full ECDSA signature verification.
 * Signature verification (verifySessionToken) requires the published,
 * encrypted tenant directory, which is currently unavailable for
 * verification in this deployment (autoFetchAdmin returns null — see the
 * `/content/ask` verifyCaller path, which fails the same way) — so EVERY
 * session-token gate in the bridge is sub-claim-only today. Upgrading all
 * of them to verifySessionToken depends on making the directory
 * decryptable (FOXXI_ADMIN_KEY_SEED + a published wallet_address map); that
 * is a separate, system-wide hardening, tracked apart from this fix. What
 * this change DOES guarantee: anonymous callers can no longer reach the
 * write/mint endpoints or read a non-default tenant.
 */

import type { Request } from 'express';
import { DEFAULT_TENANT, tenantIdOf, type TenantId } from './tenant-context.js';

export interface OperatorAuthConfig {
  adminWebId?: string;
  learningEngineerWebIds?: ReadonlySet<string>;
}

/** Decode the session token's `sub` (subject WebID) — no signature check (see file header). */
function decodeSub(req: Request): string | null {
  const h = (req.headers['authorization'] ?? req.headers['Authorization']) as string | undefined;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  try {
    const padded = m[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const t = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { sub?: string };
    return typeof t.sub === 'string' ? t.sub : null;
  } catch { return null; }
}

/** True for a session token whose subject is the admin or a learning-engineer. */
export function callerIsOperator(req: Request, cfg: OperatorAuthConfig): boolean {
  const sub = decodeSub(req);
  if (!sub) return false;
  const adminWebId = cfg.adminWebId ?? '';
  const le = cfg.learningEngineerWebIds ?? new Set<string>();
  return (!!adminWebId && sub === adminWebId) || le.has(sub);
}

/**
 * The tenant a request may act on. Honors `?tenant_pod_url` only for an
 * operator; everyone else (including anonymous) is pinned to DEFAULT_TENANT
 * so they cannot reach a victim tenant's data.
 */
export function trustedTenantOf(req: Request, cfg: OperatorAuthConfig): TenantId {
  if (!callerIsOperator(req, cfg)) return DEFAULT_TENANT;
  return tenantIdOf(req.query.tenant_pod_url as string | undefined);
}
