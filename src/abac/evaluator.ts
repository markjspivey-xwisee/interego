/**
 * @module abac/evaluator
 * @description Reference implementation of `abac:Evaluator`. Maps
 *   (policy, context) → decision by running the policy's SHACL
 *   predicate against the subject's attribute graph.
 *
 *   Multi-policy composition follows the L1 deontic semantics
 *   declared in `docs/ns/cg.ttl`:
 *     - Deny overrides Permit.
 *     - Duties accumulate from all matching Duty-mode policies.
 *     - If no policy matches, verdict is Indeterminate
 *       (open-world default at the federation layer; deployments
 *       that want closed-world behaviour supply an explicit
 *       default-deny policy).
 */

import type {
  IRI,
  AccessControlPolicyData,
} from '../model/types.js';
import type {
  PolicyContext,
  PolicyDecision,
  PolicyPredicateShape,
  AbacVerdict,
  AttributeGraph,
  PredicateConstraint,
} from './types.js';
import { extractAttribute } from './attribute-resolver.js';

/**
 * Evaluate a single policy against a context. Returns
 * (allowed, duties, reason).
 *
 * Algorithm:
 *   1. Run the policy's SHACL predicate against the subject's graph.
 *   2. If the predicate is satisfied, the policy applies.
 *      - mode=Permit → verdict=Allowed, no duties
 *      - mode=Deny   → verdict=Denied
 *      - mode=Duty   → verdict=Allowed, duties accumulated
 *   3. If the predicate fails, the policy doesn't apply — skip.
 */
export function evaluateSingle(
  policy: AccessControlPolicyData,
  predicate: PolicyPredicateShape,
  context: PolicyContext,
): {
  applies: boolean;
  verdict: AbacVerdict;
  duties: readonly string[];
  reason: string;
} {
  if (context.action !== policy.governedAction) {
    return {
      applies: false, verdict: 'Indeterminate', duties: [],
      reason: `policy governs ${policy.governedAction}, not ${context.action}`,
    };
  }

  const violations = validateAgainstShape(context.subjectAttributes, predicate);
  if (violations.length > 0) {
    return {
      applies: false, verdict: 'Indeterminate', duties: [],
      reason: `subject did not satisfy policy predicate (${violations[0]})`,
    };
  }

  switch (policy.deonticMode) {
    case 'Permit':
      return {
        applies: true, verdict: 'Allowed', duties: [],
        reason: `Permit: subject satisfies predicate ${predicate.iri}`,
      };
    case 'Deny':
      return {
        applies: true, verdict: 'Denied', duties: [],
        reason: `Deny: subject satisfies predicate ${predicate.iri}`,
      };
    case 'Duty':
      return {
        applies: true, verdict: 'Allowed', duties: policy.duties ?? [],
        reason: `Duty: subject satisfies predicate ${predicate.iri}; duties attached`,
      };
  }
}

/**
 * Evaluate multiple policies and compose per deontic semantics.
 * Returns a single PolicyDecision.
 */
export function evaluate(
  policies: readonly AccessControlPolicyData[],
  predicates: ReadonlyMap<IRI, PolicyPredicateShape>,
  context: PolicyContext,
): PolicyDecision {
  let anyPermit = false;
  let anyDeny = false;
  let denyReason = '';
  let permitReason = '';
  const duties: string[] = [];
  const matched: IRI[] = [];

  for (const p of policies) {
    const pred = predicates.get(p.policyPredicateShape);
    if (!pred) continue; // predicate unresolved; skip with no verdict
    const r = evaluateSingle(p, pred, context);
    if (!r.applies) continue;
    matched.push(p.id);
    if (r.verdict === 'Denied') { anyDeny = true; denyReason = r.reason; }
    if (r.verdict === 'Allowed') {
      anyPermit = true;
      if (!permitReason) permitReason = r.reason;
      duties.push(...r.duties);
    }
  }

  // Deny overrides Permit.
  if (anyDeny) {
    return {
      verdict: 'Denied', duties: [],
      reason: `Denied by policy: ${denyReason}`,
      matchedPolicies: matched,
      decidedAt: context.now,
    };
  }

  if (anyPermit) {
    return {
      verdict: 'Allowed', duties,
      reason: duties.length > 0
        ? `Allowed with ${duties.length} dut${duties.length === 1 ? 'y' : 'ies'}: ${permitReason}`
        : `Allowed: ${permitReason}`,
      matchedPolicies: matched,
      decidedAt: context.now,
    };
  }

  return {
    verdict: 'Indeterminate', duties: [],
    reason: 'No matching policy',
    matchedPolicies: [],
    decidedAt: context.now,
  };
}

// ── SHACL predicate evaluation ──────────────────────────────

export function validateAgainstShape(
  graph: AttributeGraph,
  shape: PolicyPredicateShape,
): readonly string[] {
  const violations: string[] = [];
  for (const c of shape.constraints) {
    const viols = checkConstraint(graph, c);
    violations.push(...viols);
  }
  return violations;
}

function checkConstraint(graph: AttributeGraph, c: PredicateConstraint): string[] {
  const violations: string[] = [];
  const values = extractAttribute(graph, c.path);
  if (c.minCount !== undefined && values.length < c.minCount) {
    violations.push(c.message ?? `minCount ${c.minCount} at ${c.path}: got ${values.length}`);
    return violations;
  }
  if (c.hasValue !== undefined && !values.some(v => String(v) === c.hasValue)) {
    violations.push(c.message ?? `hasValue ${c.hasValue} required at ${c.path}`);
  }
  if (c.inValues !== undefined) {
    for (const v of values) {
      if (!c.inValues.includes(String(v))) {
        violations.push(c.message ?? `${v} not in allowed set at ${c.path}`);
      }
    }
  }
  if (c.minInclusive !== undefined) {
    for (const v of values) {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (Number.isFinite(n) && n < c.minInclusive) {
        violations.push(c.message ?? `${n} < minInclusive ${c.minInclusive} at ${c.path}`);
      }
    }
  }
  if (c.maxInclusive !== undefined) {
    for (const v of values) {
      const n = typeof v === 'number' ? v : parseFloat(String(v));
      if (Number.isFinite(n) && n > c.maxInclusive) {
        violations.push(c.message ?? `${n} > maxInclusive ${c.maxInclusive} at ${c.path}`);
      }
    }
  }
  if (c.pattern !== undefined) {
    const re = new RegExp(c.pattern);
    for (const v of values) {
      if (!re.test(String(v))) {
        violations.push(c.message ?? `value at ${c.path} does not match pattern`);
      }
    }
  }
  return violations;
}
