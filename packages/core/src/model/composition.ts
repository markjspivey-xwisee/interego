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
import { createHash } from 'node:crypto';
import { getFacetEntry, executeMerge, facetFingerprint } from './registry.js';
import { canonicalJson } from '../canonical-json.js';
import { assertDescriptor } from './descriptor-shape.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

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

/**
 * Compute the lattice meet of two facet-lists of the SAME type.
 *
 * For preserve-all facet types this is a true set intersection on the
 * structural fingerprint (an instance survives only if it appears in both
 * operands). For arithmetic strategies (convex-hull / intersect-range / chain /
 * etc.) we call executeMerge on the concatenated list, since those strategies
 * already compute a meet-style result (e.g. intersect-range narrows a temporal
 * interval).
 */
function meetFacetsOfType(
  type: ContextTypeName,
  f1: readonly ContextFacetData[],
  f2: readonly ContextFacetData[],
): ContextFacetData[] {
  const entry = getFacetEntry(type);
  if (!entry) {
    // Unknown facet type — fall back to structural set-meet on JSON shape so
    // open-extension facets still respect lattice meet.
    const fp2 = new Set(f2.map(f => JSON.stringify(f)));
    const seen = new Set<string>();
    const out: ContextFacetData[] = [];
    for (const f of f1) {
      const fp = JSON.stringify(f);
      if (fp2.has(fp) && !seen.has(fp)) {
        seen.add(fp);
        out.push(f);
      }
    }
    return out;
  }
  if (entry.intersectionStrategy === 'preserve-all') {
    // Sign-instance level set intersection. Two facets are the "same instance"
    // iff facetFingerprint() collapses them. This is what makes A ∧ B ≤ A and
    // therefore makes the absorption law union(A, A ∧ B) ≅ A hold for
    // operands with disjoint preserve-all instances (different DIDs, different
    // confidences, different storage endpoints, etc.).
    const fp2 = new Set(f2.map(facetFingerprint));
    const seen = new Set<string>();
    const out: ContextFacetData[] = [];
    for (const f of f1) {
      const fp = facetFingerprint(f);
      if (fp2.has(fp) && !seen.has(fp)) {
        seen.add(fp);
        out.push(f);
      }
    }
    return out;
  }
  // Arithmetic strategies (convex-hull / intersect-range / chain / flatten-set /
  // highest-confidence / merge-bindings / left-wins / custom) already compute
  // a meet-style result over the concatenated list.
  return executeMerge(entry.intersectionStrategy, [...f1, ...f2], entry.intersectionMerge);
}

// ── Composition Operators ────────────────────────────────────

/**
 * A composed descriptor's identity, derived from its content.
 *
 * ★ THIS WAS A PROCESS-LOCAL SEQUENTIAL COUNTER — `urn:iep:composed:${++n}` — which is
 * the worst identity scheme available here, because it fails in BOTH directions at once:
 *
 *   - Same content, DIFFERENT id. Compose A∪B twice in one process and you get
 *     `…:1` and `…:2`. Nothing is idempotent, and the lattice laws in category.ts had to
 *     call resetComposedIdCounter() between every path just to compare two results.
 *   - Different content, SAME id. Two unrelated compositions in two processes are both
 *     `…:1`. Restart the relay and `urn:iep:composed:1` names something else entirely.
 *
 * In a substrate whose first invariant is identity-by-reference, an id that is neither
 * reproducible nor unique is not an identifier at all. It is now a hash over the composed
 * descriptor's whole defining content — the operator, its operands, the graphs it
 * describes and the resulting facets — so composing the same things always yields the
 * same id, everywhere, forever.
 *
 * Deliberately still `urn:` and not a URL: a composed descriptor is not stored anywhere
 * and has no resolution story, so spelling it as a URL would promise a fetch that cannot
 * succeed — the exact defect fixed for PGSL node ids. Give it somewhere to live first.
 */
function composedId(body: Omit<ComposedDescriptorData, 'id'>): IRI {
  return `urn:iep:composed:${sha256Hex(canonicalJson(body)).slice(0, 40)}` as IRI;
}

/**
 * No longer necessary, and kept only so existing callers keep compiling.
 *
 * It existed because sequential ids made every composition unequal to its own repeat.
 * Content-addressed ids are stable by construction, so there is nothing to reset — the
 * lattice-law checks in category.ts now compare naturally.
 *
 * @deprecated Composed ids are content-addressed; this is a no-op.
 */
export function resetComposedIdCounter(): void {
  /* intentionally empty — see composedId() */
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
  assertDescriptor(d1, 'union() operand 1');
  assertDescriptor(d2, 'union() operand 2');
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

  // Compute shared boundary (facet types in both operands) — uses the same
  // lattice-meet semantics as intersection() so the PGSL structural marker
  // stays consistent across operators.
  const sharedTypes = [...g1.keys()].filter(t => g2.has(t));
  const sharedBoundary: ContextFacetData[] = [];
  for (const type of sharedTypes) {
    const f1 = g1.get(type)!;
    const f2 = g2.get(type)!;
    sharedBoundary.push(...meetFacetsOfType(type, f1, f2));
  }

  const body = {
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
  return { id: id ?? composedId(body as Omit<ComposedDescriptorData, 'id'>), ...body } as ComposedDescriptorData;
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
  assertDescriptor(d1, 'intersection() operand 1');
  assertDescriptor(d2, 'intersection() operand 2');
  const g1 = groupByType(d1.facets);
  const g2 = groupByType(d2.facets);
  const sharedTypes = [...g1.keys()].filter(t => g2.has(t));
  const resultFacets: ContextFacetData[] = [];

  for (const type of sharedTypes) {
    const f1 = g1.get(type)!;
    const f2 = g2.get(type)!;
    // Lattice meet at the sign-instance level for preserve-all types
    // (Agent / Semiotic / Trust / Federation / Causal) and arithmetic meet
    // for the others — see meetFacetsOfType().
    resultFacets.push(...meetFacetsOfType(type, f1, f2));
  }

  // Intersection of described graphs — meet is the GREATEST LOWER BOUND, so
  // when there is no overlap the result IS the empty set. Falling back to
  // `allDescribedGraphs([d1, d2])` (the union) used to violate the lattice
  // property `d1 ∧ d2 ≤ d1`, which the §3.4 composition algebra relies on.
  const graphs1 = new Set(d1.describes);
  const commonGraphs = d2.describes.filter(g => graphs1.has(g));

  const body = {
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
  return { id: id ?? composedId(body as Omit<ComposedDescriptorData, 'id'>), ...body } as ComposedDescriptorData;
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
  assertDescriptor(d, 'restriction() operand');
  const typeSet = new Set(types);
  const resultFacets = d.facets.filter(f => typeSet.has(f.type));

  const body = {
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
  return { id: id ?? composedId(body as Omit<ComposedDescriptorData, 'id'>), ...body } as ComposedDescriptorData;
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
  assertDescriptor(base, 'override() base');
  assertDescriptor(overrideDesc, 'override() operand');
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

  const body = {
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
  return { id: id ?? composedId(body as Omit<ComposedDescriptorData, 'id'>), ...body } as ComposedDescriptorData;
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
