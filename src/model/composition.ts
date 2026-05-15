/**
 * @module model/composition
 * @description Algebraic composition operators for Context Descriptors (§3.4)
 *
 * Implements the four operators that form a bounded lattice over
 * the set of Context Descriptors:
 *   - Union (§3.4.1): join — merge all facets
 *   - Intersection (§3.4.2): meet — common facets only
 *   - Restriction (§3.4.3): projection to facet type subset
 *   - Override (§3.4.4): left-biased facet replacement
 *
 * Each facet type defines its own merge semantics per §5.
 */

import type {
  IRI,
  ContextDescriptorData,
  ContextFacetData,
  ContextTypeName,
  ComposedDescriptorData,
} from './types.js';
import { getFacetEntry, executeMerge } from './registry.js';

// ── Helpers ──────────────────────────────────────────────────

type FacetsByType = Map<ContextTypeName, ContextFacetData[]>;

function groupByType(facets: readonly ContextFacetData[]): FacetsByType {
  const map: FacetsByType = new Map();
  for (const f of facets) {
    const existing = map.get(f.type) ?? [];
    existing.push(f);
    map.set(f.type, existing);
  }
  return map;
}

function allDescribedGraphs(descriptors: readonly ContextDescriptorData[]): IRI[] {
  const set = new Set<IRI>();
  for (const d of descriptors) {
    for (const g of d.describes) set.add(g);
  }
  return [...set];
}

// ── Composition Operators ────────────────────────────────────

let _composedIdCounter = 0;
function nextComposedId(): IRI {
  return `urn:cg:composed:${++_composedIdCounter}` as IRI;
}

/**
 * Reset the composed ID counter (for testing).
 */
export function resetComposedIdCounter(): void {
  _composedIdCounter = 0;
}

/**
 * Union (§3.4.1)
 *
 * Merge all facets from both operands. Same-type facets use
 * type-specific merge semantics.
 */
export function union(
  d1: ContextDescriptorData,
  d2: ContextDescriptorData,
  id?: IRI
): ComposedDescriptorData {
  const g1 = groupByType(d1.facets);
  const g2 = groupByType(d2.facets);
  const allTypes = new Set<ContextTypeName>([...g1.keys(), ...g2.keys()]);
  const resultFacets: ContextFacetData[] = [];

  for (const type of allTypes) {
    const f1 = g1.get(type) ?? [];
    const f2 = g2.get(type) ?? [];
    const all = [...f1, ...f2];
    const entry = getFacetEntry(type);
    if (entry) {
      resultFacets.push(...executeMerge(entry.unionStrategy, all, entry.unionMerge));
    } else {
      // Unknown facet type — preserve all (open extension)
      resultFacets.push(...all);
    }
  }

  // Compute shared boundary (facet types in both operands)
  const sharedTypes = [...g1.keys()].filter(t => g2.has(t));
  const sharedBoundary: ContextFacetData[] = [];
  for (const type of sharedTypes) {
    const f1 = g1.get(type)!;
    const f2 = g2.get(type)!;
    const entry = getFacetEntry(type);
    if (entry) {
      sharedBoundary.push(...executeMerge(entry.intersectionStrategy, [...f1, ...f2], entry.intersectionMerge));
    }
  }

  return {
    id: id ?? nextComposedId(),
    compositionOp: 'union',
    operands: [d1.id, d2.id],
    describes: allDescribedGraphs([d1, d2]),
    facets: resultFacets,
    // PGSL structural metadata:
    // Union = extend the pyramid. The shared boundary is where the two
    // operands overlap (like the shared middle atom in (0,0,0)).
    structuralOp: sharedBoundary.length > 0 ? 'extend' : 'beside',
    sharedBoundary: sharedBoundary.length > 0 ? sharedBoundary : undefined,
  };
}

/**
 * Intersection (§3.4.2)
 *
 * Retain only facet types present in BOTH operands.
 * For each shared type, compute type-specific intersection.
 */
export function intersection(
  d1: ContextDescriptorData,
  d2: ContextDescriptorData,
  id?: IRI
): ComposedDescriptorData {
  const g1 = groupByType(d1.facets);
  const g2 = groupByType(d2.facets);
  const sharedTypes = [...g1.keys()].filter(t => g2.has(t));
  const resultFacets: ContextFacetData[] = [];

  for (const type of sharedTypes) {
    const f1 = g1.get(type)!;
    const f2 = g2.get(type)!;
    const all = [...f1, ...f2];
    const entry = getFacetEntry(type);
    if (entry) {
      resultFacets.push(...executeMerge(entry.intersectionStrategy, all, entry.intersectionMerge));
    } else {
      resultFacets.push(...all);
    }
  }

  // Intersection of described graphs — meet is the GREATEST LOWER BOUND, so
  // when there is no overlap the result IS the empty set. Falling back to
  // `allDescribedGraphs([d1, d2])` (the union) used to violate the lattice
  // property `d1 ∧ d2 ≤ d1`, which the §3.4 composition algebra relies on.
  const graphs1 = new Set(d1.describes);
  const commonGraphs = d2.describes.filter(g => graphs1.has(g));

  return {
    id: id ?? nextComposedId(),
    compositionOp: 'intersection',
    operands: [d1.id, d2.id],
    describes: commonGraphs,
    facets: resultFacets,
    // PGSL structural metadata:
    // Intersection = the shared boundary itself (lattice meet).
    // The result IS the overlap — the deduped middle of the overlapping pair.
    structuralOp: 'meet',
    sharedBoundary: resultFacets,
  };
}

/**
 * Restriction (§3.4.3)
 *
 * Project a descriptor to a subset of facet types.
 */
export function restriction(
  d: ContextDescriptorData,
  types: readonly ContextTypeName[],
  id?: IRI
): ComposedDescriptorData {
  const typeSet = new Set(types);
  const resultFacets = d.facets.filter(f => typeSet.has(f.type));

  return {
    id: id ?? nextComposedId(),
    compositionOp: 'restriction',
    operands: [d.id],
    restrictToTypes: types,
    describes: [...d.describes],
    facets: resultFacets,
    // PGSL structural metadata:
    // Restriction = wrap/project. Collapses the structure to a subset,
    // like viewing only certain levels of the pyramid.
    structuralOp: 'wrap',
  };
}

/**
 * Override (§3.4.4)
 *
 * Facets from `override` replace same-typed facets in `base`.
 * Facets unique to either operand are preserved.
 */
export function override(
  base: ContextDescriptorData,
  overrideDesc: ContextDescriptorData,
  id?: IRI
): ComposedDescriptorData {
  const baseByType = groupByType(base.facets);
  const overrideByType = groupByType(overrideDesc.facets);
  const allTypes = new Set<ContextTypeName>([...baseByType.keys(), ...overrideByType.keys()]);
  const resultFacets: ContextFacetData[] = [];

  for (const type of allTypes) {
    // Override takes priority for shared types
    if (overrideByType.has(type)) {
      resultFacets.push(...overrideByType.get(type)!);
    } else {
      resultFacets.push(...baseByType.get(type)!);
    }
  }

  // Compute what was replaced (the shared types where override took priority)
  const replacedTypes = [...overrideByType.keys()].filter(t => baseByType.has(t));
  const sharedBoundary: ContextFacetData[] = [];
  for (const type of replacedTypes) {
    sharedBoundary.push(...baseByType.get(type)!);
  }

  return {
    id: id ?? nextComposedId(),
    compositionOp: 'override',
    operands: [base.id, overrideDesc.id],
    describes: allDescribedGraphs([base, overrideDesc]),
    facets: resultFacets,
    // PGSL structural metadata:
    // Override = replace inner element, preserve outer structure.
    // The base structure is preserved, but specific inner elements
    // (shared-type facets) are replaced by the override's versions.
    structuralOp: 'extend',
    sharedBoundary: sharedBoundary.length > 0 ? sharedBoundary : undefined,
  };
}

// ── Effective Context (§3.5) ─────────────────────────────────

/**
 * Compute the effective context for a triple within a Named Graph,
 * applying the inheritance rule from §3.5:
 *
 *   effectiveContext(triple) = override(tripleContext, graphContext)
 *
 * Triple-level facets override graph-level facets of the same type;
 * graph-level facets not overridden are inherited.
 */
export function effectiveContext(
  graphDescriptor: ContextDescriptorData,
  tripleFacets: readonly ContextFacetData[],
  id?: IRI
): ContextDescriptorData {
  if (tripleFacets.length === 0) return graphDescriptor;

  const tripleDesc: ContextDescriptorData = {
    id: `${graphDescriptor.id}:triple-override` as IRI,
    describes: graphDescriptor.describes,
    facets: tripleFacets,
  };

  return override(graphDescriptor, tripleDesc, id);
}
