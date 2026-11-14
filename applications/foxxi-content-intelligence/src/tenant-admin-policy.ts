/**
 * The tenant-administrator gate, with the substrate's policy decision beside it in SHADOW.
 *
 * The bridge's admin-only operations (issuing a credential, the audit trail, a backup, a tenant
 * owner's write to the configured tenant, ...) are guarded by one fixed rule: the caller that
 * `resolveCaller` resolved has the role `admin`. That rule still decides. `mayAdministerTenant`
 * states the same rule as DATA (`TENANT_ADMIN_POLICIES`: a Permit on `TENANT_ADMIN_ACTION` for a
 * subject whose `passport:role` is `admin`), evaluates it with `@interego/abac/portable` over the
 * caller as a subject, and logs one bounded record when the two answers differ.
 *
 * This is the same subject model and the same evaluator that decide for a provisional guest
 * (`applications/_shared/guest-access/door.ts`), here for a registered principal: a tenant member
 * is a subject whose attributes say `provisional: false` and a role.
 *
 * What the shadow evaluation may never do, and how that is held:
 *   - change the answer: in any mode but the exact string `enforce`, the fixed rule's answer is
 *     returned, whatever the policy said;
 *   - throw into the request: everything here is inside a try, and a failure returns the fixed
 *     rule's answer (or, when enforcing, a refusal);
 *   - log what it read: the record is `decideInShadow`'s (point, action, subject, both answers,
 *     matching policy ids). No attribute value, credential or request content is in it.
 *
 * The subject's facts come from `CallerContext`, which `resolveCaller` builds from the tenant
 * directory's own row for the wallet that authenticated and the operator's configuration. Nothing
 * a request sent is read here.
 */
import { decideInShadow, subjectAttributeGraph, SUBJECT,
  type PolicySet, type ShadowDisagreement, type SubjectFacts } from '@interego/abac/portable';
import type { CallerContext, CallerRole } from './policy.js';

/** The action the admin-only gates guard: administering the configured tenant. */
export const TENANT_ADMIN_ACTION = 'urn:foxxi:action:administer-tenant';

const ADMIN_SHAPE = 'urn:foxxi:abac:tenant-admin#is-admin';

/**
 * The rule as data. One Permit: a subject the directory resolves to the role `admin`.
 * `minCount: 1` because a constraint over no values holds vacuously; a subject with no stated role
 * must not satisfy it. There is no Deny: default-deny is in the decision, not in a policy.
 */
export const TENANT_ADMIN_POLICIES: PolicySet = Object.freeze({
  policies: Object.freeze([Object.freeze({
    id: 'urn:foxxi:abac:tenant-admin#permit-admin',
    policyPredicateShape: ADMIN_SHAPE,
    governedAction: TENANT_ADMIN_ACTION,
    deonticMode: 'Permit',
  })]),
  predicates: new Map([[ADMIN_SHAPE, Object.freeze({
    iri: ADMIN_SHAPE,
    constraints: Object.freeze([Object.freeze({ path: SUBJECT.role, minCount: 1, hasValue: 'admin' satisfies CallerRole })]),
  })]]),
}) as unknown as PolicySet;

/** The fixed rule the bridge has always had: only the role `admin`. A delegated admin is not one. */
export function isTenantAdmin(ctx: Pick<CallerContext, 'role'> | null | undefined): boolean {
  return !!ctx && ctx.role === 'admin';
}

/**
 * The subject facts of a resolved caller: who the directory says they are and the one role it
 * resolved them to. A registered member is not provisional.
 */
export function callerSubjectFacts(ctx: Pick<CallerContext, 'webId' | 'role'>): SubjectFacts {
  return { subject: ctx.webId, provisional: false, roles: [ctx.role] };
}

/** `enforce` only for the exact string; anything else, unset included, is shadow. */
export function abacMode(value: string | undefined): 'shadow' | 'enforce' {
  return value === 'enforce' ? 'enforce' : 'shadow';
}

export interface TenantAdminGateOptions {
  /** Where the gate stands, for the disagreement record (a tool name). */
  readonly point: string;
  /** `enforce` lets the policy decide. Anything else is shadow: the fixed rule decides. */
  readonly mode?: string;
  /** Receives the bounded disagreement record. A logger that throws changes nothing. */
  readonly log?: (record: ShadowDisagreement) => void;
  /** The policy set to evaluate. Tests pass another to show a disagreement; the bridge does not. */
  readonly policySet?: PolicySet;
}

/**
 * May this caller administer the tenant? `ctx` is what `resolveCaller` resolved, or null when it
 * refused (no credential, an expired or malformed one, a signer who is not a member): no caller
 * is no subject, and both the fixed rule and the policy refuse.
 */
export function mayAdministerTenant(ctx: Pick<CallerContext, 'webId' | 'role'> | null | undefined, options: TenantAdminGateOptions): boolean {
  const existing = isTenantAdmin(ctx);
  const enforce = options?.mode === 'enforce';
  try {
    let graph = null;
    // A caller whose facts cannot be stated (no IRI to name it by) has no graph; the policy refuses.
    try { if (ctx) graph = subjectAttributeGraph(callerSubjectFacts(ctx)); } catch { graph = null; }
    return decideInShadow({
      point: options.point, mode: enforce ? 'enforce' : 'shadow', existing, action: TENANT_ADMIN_ACTION,
      policySet: options.policySet ?? TENANT_ADMIN_POLICIES, graph, log: options.log,
    });
  } catch {
    // The shadow evaluation is never a reason a request fails. Enforcing, a failure is a refusal.
    return enforce ? false : existing;
  }
}
