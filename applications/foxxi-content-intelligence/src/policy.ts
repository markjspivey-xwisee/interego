/**
 * Foxxi bridge AuthZ filters.
 *
 * Once the auth middleware has resolved `caller_did` + `callerUserId`,
 * these helpers decide what the caller can see and trim the
 * FoxxiAdminPayload to a caller-scoped view before passing it down to
 * the existing handlers.
 *
 * Three principal roles, resolved from the directory + the admin DID
 * declared in the tenant config:
 *   - admin    — sees everything
 *   - manager  — sees direct reports' enrollments + their own
 *   - learner  — sees own enrollments + own audit entries
 *
 * The role check is intentionally simple: the admin webId is configured
 * via FOXXI_ADMIN_WEB_ID (or read from the tenant directory's `meta`
 * once published); manager status is detected by the `manager_user_id`
 * back-references in the user records. No role flag on users — derived.
 *
 * Filtering is conservative: when the policy doesn't permit access, the
 * field is replaced with [] / null, not omitted, so callers see an
 * unambiguous "no records" rather than a missing field.
 */

import type {
  AdminPayload,
  AdminUser,
  AdminAuditEntry,
  AdminEvent,
  AdminPolicy,
  AdminGroup,
  CatalogEntry,
  AdminConnection,
  AdminCoverageEntry,
} from '../dashboard-app/src/types.js';

export type CallerRole = 'admin' | 'delegated-admin' | 'learning-engineer' | 'manager' | 'learner';

/** A delegated-admin is admin-equivalent for read/scoping filters, but is a
 *  DISTINCT, attributable, revocable role in audit traces (never conflated
 *  with the configured tenant owner). See bug #2b hardened delegated-admin. */
export function isAdminEquivalent(role: CallerRole): boolean {
  return role === 'admin' || role === 'delegated-admin';
}

export interface CallerContext {
  webId: string;
  userId: string;
  role: CallerRole;
  /** user_ids the caller has manager authority over (transitive disabled — direct reports only). */
  directReports: ReadonlySet<string>;
}

export function resolveCallerContext(args: {
  callerWebId: string;
  callerUserId: string;
  users: readonly AdminUser[];
  adminWebId?: string;
  /** Set of WebIDs designated as learning engineers (env-driven, comma-separated FOXXI_LEARNING_ENGINEER_WEB_IDS). LEs have read-only access to cohort + content analytics, no credential issuance. */
  learningEngineerWebIds?: ReadonlySet<string>;
}): CallerContext {
  if (args.adminWebId && args.callerWebId === args.adminWebId) {
    return {
      webId: args.callerWebId,
      userId: args.callerUserId,
      role: 'admin',
      directReports: new Set(),
    };
  }
  if (args.learningEngineerWebIds && args.learningEngineerWebIds.has(args.callerWebId)) {
    // LEs may also be managers of their own cohort; preserve directReports for downstream filters.
    const directReports = new Set<string>();
    for (const u of args.users) {
      if (u.manager_user_id === args.callerUserId) directReports.add(u.user_id);
    }
    return {
      webId: args.callerWebId,
      userId: args.callerUserId,
      role: 'learning-engineer',
      directReports,
    };
  }
  const directReports = new Set<string>();
  for (const u of args.users) {
    if (u.manager_user_id === args.callerUserId) directReports.add(u.user_id);
  }
  const role: CallerRole = directReports.size > 0 ? 'manager' : 'learner';
  return {
    webId: args.callerWebId,
    userId: args.callerUserId,
    role,
    directReports,
  };
}

// ── Per-section filters ───────────────────────────────────────

export function filterEnrollmentEvents(
  events: readonly AdminEvent[],
  ctx: CallerContext,
): AdminEvent[] {
  if (isAdminEquivalent(ctx.role) || ctx.role === 'learning-engineer') return [...events];
  return events.filter(e =>
    e.user_id === ctx.userId
    || ctx.directReports.has(e.user_id),
  );
}

export function filterAuditEntries(
  audit: readonly AdminAuditEntry[],
  ctx: CallerContext,
  args?: { targetUserIds?: readonly string[] },
): AdminAuditEntry[] {
  if (isAdminEquivalent(ctx.role) || ctx.role === 'learning-engineer') return [...audit];
  const allowedActors = new Set<string>([ctx.userId, ...ctx.directReports]);
  const targetSet = args?.targetUserIds ? new Set(args.targetUserIds) : null;
  return audit.filter(e => {
    if (allowedActors.has(e.actor_user_id)) return true;
    // Learners + managers can also see audit entries whose TARGET is
    // someone they have authority over (e.g. an admin assigning a course
    // to Joshua is visible to Joshua).
    if (targetSet && targetSet.has(e.target_id)) return true;
    return false;
  });
}

export function filterPolicies(
  policies: readonly AdminPolicy[],
  ctx: CallerContext,
  args: { learnerAudienceTags: readonly string[]; learnerGroupIds: readonly string[] },
): AdminPolicy[] {
  if (isAdminEquivalent(ctx.role) || ctx.role === 'learning-engineer') return [...policies];
  // A learner/manager sees a policy iff it targets their audience-tag
  // group OR a group they're a member of. (The bridge's
  // discoverAssignedCourses already does this filtering implicitly;
  // we trim the response so the structure visible to the caller
  // matches what they're entitled to know about.)
  const allowedGroups = new Set<string>(args.learnerGroupIds);
  for (const tag of args.learnerAudienceTags) allowedGroups.add(`tag-${tag}`);
  return policies.filter(p => allowedGroups.has(p.audience_group_id));
}

export function filterUsers(
  users: readonly AdminUser[],
  ctx: CallerContext,
): AdminUser[] {
  if (isAdminEquivalent(ctx.role)) return [...users];
  // Manager sees self + direct reports; learner sees only self.
  const allowed = new Set<string>([ctx.userId, ...ctx.directReports]);
  return users.filter(u => allowed.has(u.user_id));
}

export function filterGroups(
  groups: readonly AdminGroup[],
  ctx: CallerContext,
): AdminGroup[] {
  if (isAdminEquivalent(ctx.role)) return [...groups];
  // Non-admins see only groups they're members of.
  return groups
    .filter(g => g.member_ids.includes(ctx.userId))
    .map(g => ({
      ...g,
      // Hide other members from non-admins; redact to just self.
      member_ids: [ctx.userId],
      member_count: 1,
    }));
}

export function filterCatalog(
  catalog: readonly CatalogEntry[],
  ctx: CallerContext,
): CatalogEntry[] {
  // Catalog is public-tenant-visible — every authenticated user sees it.
  // Admin sees stub/parsed both; learners get the same view (helps
  // course-browsing UX). No filter.
  return [...catalog];
}

export function filterConnections(
  connections: readonly AdminConnection[],
  ctx: CallerContext,
): AdminConnection[] {
  // Connector registry is admin-only.
  if (isAdminEquivalent(ctx.role)) return [...connections];
  return [];
}

export function filterCoverage(
  coverage: readonly AdminCoverageEntry[],
  ctx: CallerContext,
): AdminCoverageEntry[] {
  // Coverage is aggregate over the tenant — admin-only.
  if (isAdminEquivalent(ctx.role) || ctx.role === 'learning-engineer') return [...coverage];
  return [];
}

/**
 * Apply every filter to produce a caller-scoped view of the admin payload.
 * Returns a NEW object — does not mutate the input.
 */
export function filterAdminPayload(
  admin: AdminPayload,
  ctx: CallerContext,
): AdminPayload {
  const learnerSelf = admin.users.find(u => u.user_id === ctx.userId);
  const learnerAudienceTags = learnerSelf?.audience_tags ?? [];
  const learnerGroupIds = admin.groups
    .filter(g => g.member_ids.includes(ctx.userId))
    .map(g => g.group_id);

  return {
    meta: admin.meta,
    catalog: filterCatalog(admin.catalog, ctx),
    users: filterUsers(admin.users, ctx),
    groups: filterGroups(admin.groups, ctx),
    policies: filterPolicies(admin.policies, ctx, { learnerAudienceTags, learnerGroupIds }),
    events: filterEnrollmentEvents(admin.events, ctx),
    audit: filterAuditEntries(admin.audit, ctx, { targetUserIds: [ctx.userId, ...ctx.directReports] }),
    coverage: filterCoverage(admin.coverage, ctx),
    connections: filterConnections(admin.connections, ctx),
  };
}

// ── Access-decision descriptor (substrate-purity: every filter emits an audit trace) ──

export interface AccessDecisionTrace {
  iri: string;
  type: 'fxa:AccessDecision';
  callerWebId: string;
  callerRole: CallerRole;
  tool: string;
  decision: 'allow' | 'allow-filtered' | 'deny';
  appliedPolicies: readonly string[];
  recordedAt: string;
}

export function emitAccessDecision(args: {
  ctx: CallerContext;
  tool: string;
  decision: 'allow' | 'allow-filtered' | 'deny';
  appliedPolicies: readonly string[];
}): AccessDecisionTrace {
  const recordedAt = new Date().toISOString();
  const iri = `urn:foxxi:access:${args.ctx.userId}:${args.tool}:${recordedAt}`;
  return {
    iri,
    type: 'fxa:AccessDecision',
    callerWebId: args.ctx.webId,
    callerRole: args.ctx.role,
    tool: args.tool,
    decision: args.decision,
    appliedPolicies: args.appliedPolicies,
    recordedAt,
  };
}
