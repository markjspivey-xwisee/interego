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
 *   - `trustedTenantOf(req)` honors `?tenant_pod_url` ONLY for a
 *     cryptographically-verified OPERATOR (admin or learning-engineer);
 *     every other caller is pinned to DEFAULT_TENANT and can never select
 *     a victim tenant. Default-tenant reads keep working (conformance).
 *   - `callerIsOperator(req)` gates the write / token-mint endpoints.
 *
 * Verification is the SAME real-ECDSA path the dashboard already uses
 * (verifySessionToken against the published directory's wallet_address
 * map) — not a decode of an unverified `sub` claim. The directory MUST be
 * the pod-published one (it carries wallet_address); the bundled
 * admin_payload.json does not, so callers must supply `loadUsers`.
 */

import type { Request } from 'express';
import { verifySessionToken, buildAddressMap } from './auth.js';
import { DEFAULT_TENANT, tenantIdOf, type TenantId } from './tenant-context.js';

export interface OperatorAuthConfig {
  adminWebId?: string;
  learningEngineerWebIds?: ReadonlySet<string>;
  /**
   * The published tenant directory users (each with wallet_address) used
   * to verify a session token's signer. Omit → no caller is ever an
   * operator (endpoints stay locked / DEFAULT-scoped).
   */
  loadUsers?: () => ReadonlyArray<{ user_id: string; web_id: string; wallet_address?: string }>;
}

function bearerOf(req: Request): string | null {
  const h = (req.headers['authorization'] ?? req.headers['Authorization']) as string | undefined;
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/** True only for a signature-verified session token whose subject is the admin or a learning-engineer. */
export function callerIsOperator(req: Request, cfg: OperatorAuthConfig): boolean {
  const token = bearerOf(req);
  if (!token || !cfg.loadUsers) return false;
  let users: ReadonlyArray<{ user_id: string; web_id: string; wallet_address?: string }>;
  try { users = cfg.loadUsers(); } catch { return false; }
  const verified = verifySessionToken(token, buildAddressMap(users));
  if (!verified.ok) return false;
  const adminWebId = cfg.adminWebId ?? '';
  const le = cfg.learningEngineerWebIds ?? new Set<string>();
  return (!!adminWebId && verified.callerDid === adminWebId) || le.has(verified.callerDid);
}

/**
 * The tenant a request may act on. Honors `?tenant_pod_url` only for a
 * verified operator; everyone else (including anonymous) is pinned to
 * DEFAULT_TENANT so they cannot reach a victim tenant's data.
 */
export function trustedTenantOf(req: Request, cfg: OperatorAuthConfig): TenantId {
  if (!callerIsOperator(req, cfg)) return DEFAULT_TENANT;
  return tenantIdOf(req.query.tenant_pod_url as string | undefined);
}
