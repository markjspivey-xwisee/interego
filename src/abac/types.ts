/**
 * @module abac/types
 * @description Runtime types for the ABAC (attribute-based access control)
 *   evaluator. Implements the L2 pattern declared in docs/ns/abac.ttl
 *   over L1 primitives in cg.ttl.
 *
 *   - Policies are `cg:AccessControlPolicy` descriptors (L1).
 *   - The pattern for how to evaluate, resolve, cache, audit is `abac:` (L2).
 *   - This module is the reference implementation of that pattern (L3).
 */

import type {
  IRI,
  AccessControlPolicyData,
  ContextFacetData,
} from '../model/types.js';

/**
 * The attribute graph for one subject at one point in time. The
 * `abac:AttributeResolver` builds this by federating over the
 * subject's own descriptor, cited attestations, and any reachable
 * trust signals (e.g. `amta:Attestation`).
 *
 * Represented as a flat facet list rather than an RDF graph because
 * evaluation is pure-function over facets and every predicate we
 * support at this layer is expressible as a SHACL property-path on
 * a known facet type. A production deployment may swap this for an
 * n3 / rdflib graph without changing the evaluator's contract.
 */
export interface AttributeGraph {
  readonly subject: IRI;
  readonly facets: readonly ContextFacetData[];
  /** Provenance of each facet: where (which pod / descriptor) it came from. */
  readonly sources: ReadonlyMap<ContextFacetData, IRI>;
}

/**
 * Everything an evaluator needs to decide one request:
 * who is asking (subject + attributes), what they want to do
 * (action), what they want to do it to (resource), and the
 * ambient environmental state (time, etc.).
 */
export interface PolicyContext {
  readonly subject: IRI;
  readonly subjectAttributes: AttributeGraph;
  readonly resource: IRI;
  readonly action: IRI;
  readonly now: string; // ISO 8601
  /** Optional: facets attached to the resource itself (e.g. its SemioticFacet). */
  readonly resourceFacets?: readonly ContextFacetData[];
}

/**
 * The verdict returned by an evaluation. `abac:Allowed` /
 * `abac:Denied` / `abac:Indeterminate` — distinct-from-Denied
 * because at the federation layer, missing attributes under an
 * open-world assumption are not false.
 */
export type AbacVerdict = 'Allowed' | 'Denied' | 'Indeterminate';

export interface PolicyDecision {
  readonly verdict: AbacVerdict;
  readonly duties: readonly string[];
  readonly reason: string;
  readonly matchedPolicies: readonly IRI[];
  readonly decidedAt: string;
}

/**
 * A SHACL-shaped predicate the subject's attribute graph must
 * satisfy for a policy to apply. This mini-shape language matches
 * the mini-SHACL validator the rest of the repo already uses — a
 * superset extending it with path types isn't needed at L1, but
 * deployments that want full SHACL 1.2 can substitute a real
 * engine; the evaluator API doesn't change.
 */
export interface PolicyPredicateShape {
  readonly iri: IRI;
  readonly constraints: readonly PredicateConstraint[];
}

export interface PredicateConstraint {
  /** SHACL-style path on the subject's attribute graph. */
  readonly path: string;
  /** Datatype constraint (xsd:*). */
  readonly datatype?: string;
  /** Closed-set membership. */
  readonly inValues?: readonly string[];
  /** Minimum numeric value (inclusive). */
  readonly minInclusive?: number;
  /** Maximum numeric value (inclusive). */
  readonly maxInclusive?: number;
  /** Minimum cardinality. */
  readonly minCount?: number;
  /** Required-value literal. */
  readonly hasValue?: string;
  /** Pattern (regex) on string value. */
  readonly pattern?: string;
  /** Human message on violation. */
  readonly message?: string;
}

/**
 * A cached decision, stored with the same shape a `cg:TrustFacet`
 * carries so that it's verifiable: who decided (issuer), when
 * (validity window), what was decided (verdict). Stale entries are
 * verifiable stale — not silent drift.
 */
export interface DecisionCacheEntry {
  readonly subject: IRI;
  readonly resource: IRI;
  readonly action: IRI;
  readonly decision: PolicyDecision;
  readonly issuer: IRI;
  readonly validUntil: string;
}

export interface PolicyRegistry {
  readonly policies: ReadonlyMap<IRI, AccessControlPolicyData>;
  readonly predicates: ReadonlyMap<IRI, PolicyPredicateShape>;
}
