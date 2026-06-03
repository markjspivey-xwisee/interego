/**
 * @module abac
 * @description Attribute-Based Access Control — reference
 *   implementation of the `abac:` L2 pattern over L1
 *   `cg:AccessControlPolicy` descriptors.
 *
 * Entry points:
 *   - `evaluate(policies, predicates, context)` → PolicyDecision
 *   - `resolveAttributes(subject, descriptors)` → AttributeGraph
 *   - `createDecisionCache()` → DecisionCache
 *
 * Usage pattern:
 *
 *   const attrs = resolveAttributes(subjectIri, [subjectDesc, attestation1, attestation2]);
 *   const context = { subject: subjectIri, subjectAttributes: attrs,
 *                     resource: resourceIri, action: actionIri, now: nowIso };
 *   const decision = evaluate(policies, predicates, context);
 *   if (decision.verdict === 'Allowed') { doAction(); fulfillDuties(decision.duties); }
 */

export { evaluate, evaluateSingle, validateAgainstShape } from './evaluator.js';
export { resolveAttributes, extractAttribute, filterAttributeGraph } from './attribute-resolver.js';
export { createDecisionCache, defaultValidUntil } from './cache.js';
export type {
  AttributeGraph,
  PolicyContext,
  PolicyDecision,
  PolicyPredicateShape,
  PredicateConstraint,
  AbacVerdict,
  DecisionCacheEntry,
  PolicyRegistry,
} from './types.js';
export type { DecisionCache } from './cache.js';
