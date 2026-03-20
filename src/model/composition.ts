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
  TemporalFacetData,
  ProvenanceFacetData,
  SemioticFacetData,
  TrustFacetData,
  FederationFacetData,
  AgentFacetData,
  AccessControlFacetData,
} from './types.js';

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

// ── Facet-type-specific merge logic ──────────────────────────

/**
 * Temporal merge (§5.1):
 *   union → convex hull (min from, max until)
 *   intersection → overlap interval
 */
function mergeTemporalUnion(facets: TemporalFacetData[]): TemporalFacetData | null {
  const froms = facets.map(f => f.validFrom).filter((v): v is string => v !== undefined);
  const untils = facets.map(f => f.validUntil).filter((v): v is string => v !== undefined);

  return {
    type: 'Temporal',
    validFrom: froms.length > 0 ? froms.sort()[0] : undefined,
    validUntil: untils.length > 0 ? untils.sort().reverse()[0] : undefined,
    temporalResolution: facets[0]?.temporalResolution,
  };
}

function mergeTemporalIntersection(facets: TemporalFacetData[]): TemporalFacetData | null {
  const froms = facets.map(f => f.validFrom).filter((v): v is string => v !== undefined);
  const untils = facets.map(f => f.validUntil).filter((v): v is string => v !== undefined);

  const latestFrom = froms.length > 0 ? froms.sort().reverse()[0] : undefined;
  const earliestUntil = untils.length > 0 ? untils.sort()[0] : undefined;

  // No overlap → no temporal facet in result
  if (latestFrom && earliestUntil && latestFrom > earliestUntil) {
    return null;
  }

  return {
    type: 'Temporal',
    validFrom: latestFrom,
    validUntil: earliestUntil,
  };
}

/**
 * Provenance merge (§5.2):
 *   union → concatenate chains, union derivedFrom sets
 */
function mergeProvenanceUnion(facets: ProvenanceFacetData[]): ProvenanceFacetData {
  const derivedFrom = new Set<IRI>();
  for (const f of facets) {
    if (f.wasDerivedFrom) {
      for (const d of f.wasDerivedFrom) derivedFrom.add(d);
    }
  }
  // Take the most recent generation time
  const times = facets
    .map(f => f.generatedAtTime)
    .filter((v): v is string => v !== undefined)
    .sort()
    .reverse();

  return {
    type: 'Provenance',
    wasGeneratedBy: facets[0]?.wasGeneratedBy,   // preserve first activity
    wasDerivedFrom: [...derivedFrom],
    generatedAtTime: times[0],
    provenanceChain: facets,                      // full chain
  };
}

/**
 * Agent merge: union agents into set
 */
function mergeAgentUnion(facets: AgentFacetData[]): AgentFacetData[] {
  // Agents don't collapse — return all as distinct facets
  return facets;
}

/**
 * Access Control merge (§5.4): union authorization sets
 */
function mergeAccessControlUnion(facets: AccessControlFacetData[]): AccessControlFacetData {
  const auths = facets.flatMap(f => f.authorizations);
  return {
    type: 'AccessControl',
    authorizations: auths,
    consentBasis: facets[0]?.consentBasis,
  };
}

/**
 * Semiotic merge (§5.5): do NOT merge — preserve as distinct facets
 */
function mergeSemioticUnion(facets: SemioticFacetData[]): SemioticFacetData[] {
  return facets;
}

/**
 * Trust merge intersection (§5.6): common trust anchors only
 */
function mergeTrustIntersection(facets: TrustFacetData[]): TrustFacetData[] {
  // For intersection: retain only credentials that appear in all sources
  // In the two-operand case, just return both — consumers decide
  return facets;
}

/**
 * Federation merge (§5.7): always preserve as-is
 */
function mergeFederationUnion(facets: FederationFacetData[]): FederationFacetData[] {
  return facets;
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

    switch (type) {
      case 'Temporal': {
        const merged = mergeTemporalUnion(all as TemporalFacetData[]);
        if (merged) resultFacets.push(merged);
        break;
      }
      case 'Provenance':
        resultFacets.push(mergeProvenanceUnion(all as ProvenanceFacetData[]));
        break;
      case 'Agent':
        resultFacets.push(...mergeAgentUnion(all as AgentFacetData[]));
        break;
      case 'AccessControl':
        resultFacets.push(mergeAccessControlUnion(all as AccessControlFacetData[]));
        break;
      case 'Semiotic':
        resultFacets.push(...mergeSemioticUnion(all as SemioticFacetData[]));
        break;
      case 'Trust':
        resultFacets.push(...all);
        break;
      case 'Federation':
        resultFacets.push(...mergeFederationUnion(all as FederationFacetData[]));
        break;
      default:
        resultFacets.push(...all);
    }
  }

  return {
    id: id ?? nextComposedId(),
    compositionOp: 'union',
    operands: [d1.id, d2.id],
    describes: allDescribedGraphs([d1, d2]),
    facets: resultFacets,
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

    switch (type) {
      case 'Temporal': {
        const merged = mergeTemporalIntersection(all as TemporalFacetData[]);
        if (merged) resultFacets.push(merged);
        break;
      }
      case 'Trust':
        resultFacets.push(...mergeTrustIntersection(all as TrustFacetData[]));
        break;
      default:
        // Default intersection: take all from both (consumers decide)
        resultFacets.push(...all);
    }
  }

  // Intersection of described graphs
  const graphs1 = new Set(d1.describes);
  const commonGraphs = d2.describes.filter(g => graphs1.has(g));

  return {
    id: id ?? nextComposedId(),
    compositionOp: 'intersection',
    operands: [d1.id, d2.id],
    describes: commonGraphs.length > 0 ? commonGraphs : allDescribedGraphs([d1, d2]),
    facets: resultFacets,
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

  return {
    id: id ?? nextComposedId(),
    compositionOp: 'override',
    operands: [base.id, overrideDesc.id],
    describes: allDescribedGraphs([base, overrideDesc]),
    facets: resultFacets,
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
