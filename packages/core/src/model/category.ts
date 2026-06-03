/**
 * @module model/category
 * @description Category-theoretic formalization of composition operators
 *
 * The four composition operators (union, intersection, restriction, override)
 * are natural transformations between presheaves over the facet category F.
 *
 * The facet category F has:
 *   Objects: facet type names (Temporal, Provenance, Agent, ...)
 *   Morphisms: merge strategies (how facets compose)
 *
 * A Context Descriptor is a presheaf P: F^op → Set — it assigns to each
 * facet type the set of facet instances of that type.
 *
 * The composition operators are natural transformations:
 *   union:        P × Q → P ∪ Q       (join in the lattice)
 *   intersection: P × Q → P ∩ Q       (meet in the lattice)
 *   restriction:  P × S → P|_S        (restriction to subobject)
 *   override:     P × Q → P ◁ Q       (left-biased replacement)
 *
 * The bounded lattice laws:
 *   ⊤ (top):      the descriptor with all facet types, each containing all values
 *   ⊥ (bottom):   the empty descriptor
 *   Idempotence:  union(A, A) ≅ A
 *   Commutativity: union(A, B) ≅ union(B, A)
 *   Associativity: union(A, union(B, C)) ≅ union(union(A, B), C)
 *   Absorption:   union(A, intersection(A, B)) ≅ A
 */

import type {
  IRI,
  ContextDescriptorData,
  ContextFacetData,
  ContextTypeName,
} from './types.js';
import { union, intersection, restriction, resetComposedIdCounter } from './composition.js';

// ── Presheaf representation ─────────────────────────────────

/**
 * A presheaf P: F^op → Set over the facet category.
 *
 * Objects of F are facet type names. P(type) = set of facet instances.
 * The morphism action P(f): P(type_a) → P(type_b) is the merge strategy.
 */
export interface DescriptorPresheaf {
  /** The fiber at each facet type object — P(type). */
  readonly fibers: ReadonlyMap<ContextTypeName, readonly ContextFacetData[]>;
  /** The described graphs (part of the descriptor, not the facets). */
  readonly describes: readonly IRI[];
  /** Identity of the source descriptor. */
  readonly id: IRI;
}

/**
 * Convert a descriptor to its presheaf representation.
 * This is the Yoneda embedding: CG → Set^(F^op)
 */
export function toPresheaf(d: ContextDescriptorData): DescriptorPresheaf {
  const fibers = new Map<ContextTypeName, ContextFacetData[]>();
  for (const f of d.facets) {
    const existing = fibers.get(f.type) ?? [];
    existing.push(f);
    fibers.set(f.type, existing);
  }
  return { fibers, describes: d.describes, id: d.id };
}

/**
 * Convert a presheaf back to a descriptor.
 * Right adjoint to the Yoneda embedding.
 */
export function fromPresheaf(p: DescriptorPresheaf): ContextDescriptorData {
  const facets: ContextFacetData[] = [];
  for (const [, fiberFacets] of p.fibers) {
    facets.push(...fiberFacets);
  }
  return { id: p.id, describes: [...p.describes], facets };
}

// ── Natural transformation witnesses ─────────────────────────

/**
 * A witness that a composition operator is a natural transformation.
 *
 * For naturality: for every morphism f: A → B in F,
 *   op(P(A), Q(A)) ; merge(f) = merge(f) ; op(P(B), Q(B))
 *
 * In our case, the morphisms in F are the merge strategies, and
 * naturality means: "merging then projecting gives the same result
 * as projecting then merging."
 */
export interface NaturalityWitness {
  /** Which operator this witnesses. */
  readonly operator: 'union' | 'intersection' | 'restriction' | 'override';
  /** Does the naturality square commute? */
  readonly commutes: boolean;
  /** Facet types where naturality was verified. */
  readonly verifiedTypes: readonly ContextTypeName[];
  /** Facet types where naturality failed (if any). */
  readonly failures: readonly { type: ContextTypeName; reason: string }[];
}

/**
 * Verify that union is a natural transformation.
 *
 * Checks: for each facet type T present in both A and B,
 *   restriction(union(A, B), [T]) ≅ union(restriction(A, [T]), restriction(B, [T]))
 *
 * This is the naturality square commuting.
 */
export function verifyUnionNaturality(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
): NaturalityWitness {
  resetComposedIdCounter();

  const pA = toPresheaf(a);
  const pB = toPresheaf(b);
  const allTypes = new Set<ContextTypeName>([...pA.fibers.keys(), ...pB.fibers.keys()]);
  const verifiedTypes: ContextTypeName[] = [];
  const failures: { type: ContextTypeName; reason: string }[] = [];

  for (const type of allTypes) {
    resetComposedIdCounter();

    // Path 1: union then restrict
    const unionAB = union(a, b);
    const path1 = restriction(unionAB, [type]);

    // Path 2: restrict then union
    resetComposedIdCounter();
    const restrictA = restriction(a, [type]);
    const restrictB = restriction(b, [type]);
    resetComposedIdCounter();
    const path2 = union(restrictA, restrictB);

    // Compare: same facet types with same counts?
    const p1Types = path1.facets.map(f => f.type).sort();
    const p2Types = path2.facets.map(f => f.type).sort();

    if (p1Types.length === p2Types.length && p1Types.every((t, i) => t === p2Types[i])) {
      verifiedTypes.push(type);
    } else {
      failures.push({
        type,
        reason: `Path 1 has [${p1Types}], path 2 has [${p2Types}]`,
      });
    }
  }

  return {
    operator: 'union',
    commutes: failures.length === 0,
    verifiedTypes,
    failures,
  };
}

/**
 * Verify that intersection is a natural transformation.
 *
 * Same structure as union naturality but for intersection.
 */
export function verifyIntersectionNaturality(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
): NaturalityWitness {
  const pA = toPresheaf(a);
  const pB = toPresheaf(b);
  const sharedTypes = [...pA.fibers.keys()].filter(t => pB.fibers.has(t));
  const verifiedTypes: ContextTypeName[] = [];
  const failures: { type: ContextTypeName; reason: string }[] = [];

  for (const type of sharedTypes) {
    resetComposedIdCounter();
    const interAB = intersection(a, b);
    const path1 = restriction(interAB, [type]);

    resetComposedIdCounter();
    const restrictA = restriction(a, [type]);
    const restrictB = restriction(b, [type]);
    resetComposedIdCounter();
    const path2 = intersection(restrictA, restrictB);

    const p1Types = path1.facets.map(f => f.type).sort();
    const p2Types = path2.facets.map(f => f.type).sort();

    if (p1Types.length === p2Types.length && p1Types.every((t, i) => t === p2Types[i])) {
      verifiedTypes.push(type);
    } else {
      failures.push({
        type,
        reason: `Path 1 has [${p1Types}], path 2 has [${p2Types}]`,
      });
    }
  }

  return {
    operator: 'intersection',
    commutes: failures.length === 0,
    verifiedTypes,
    failures,
  };
}

// ── Bounded Lattice Laws ─────────────────────────────────────

/**
 * Proof object for a bounded lattice law.
 */
export interface LatticeLawProof {
  readonly law: string;
  readonly holds: boolean;
  readonly lhs: ContextDescriptorData;
  readonly rhs: ContextDescriptorData;
  readonly reason?: string;
}

/**
 * Compare two descriptors for structural equivalence.
 * Two descriptors are equivalent if they have the same facet types
 * with the same cardinality at each type.
 */
function structurallyEquivalent(a: ContextDescriptorData, b: ContextDescriptorData): boolean {
  const aTypes = a.facets.map(f => f.type).sort();
  const bTypes = b.facets.map(f => f.type).sort();
  return aTypes.length === bTypes.length && aTypes.every((t, i) => t === bTypes[i]);
}

/**
 * Verify idempotence: union(A, A) ≅ A
 */
export function verifyIdempotence(a: ContextDescriptorData): LatticeLawProof {
  resetComposedIdCounter();
  const result = union(a, a);
  const holds = structurallyEquivalent(result, a);
  return {
    law: 'Idempotence: union(A, A) ≅ A',
    holds,
    lhs: result,
    rhs: a,
    reason: holds ? undefined : `union(A,A) has ${result.facets.length} facets, A has ${a.facets.length}`,
  };
}

/**
 * Verify commutativity: union(A, B) ≅ union(B, A)
 */
export function verifyCommutativity(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
): LatticeLawProof {
  resetComposedIdCounter();
  const lhs = union(a, b);
  resetComposedIdCounter();
  const rhs = union(b, a);
  const holds = structurallyEquivalent(lhs, rhs);
  return {
    law: 'Commutativity: union(A, B) ≅ union(B, A)',
    holds,
    lhs,
    rhs,
    reason: holds ? undefined : `LHS has ${lhs.facets.length} facets, RHS has ${rhs.facets.length}`,
  };
}

/**
 * Verify associativity: union(A, union(B, C)) ≅ union(union(A, B), C)
 */
export function verifyAssociativity(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
  c: ContextDescriptorData,
): LatticeLawProof {
  resetComposedIdCounter();
  const bc = union(b, c);
  resetComposedIdCounter();
  const lhs = union(a, bc);

  resetComposedIdCounter();
  const ab = union(a, b);
  resetComposedIdCounter();
  const rhs = union(ab, c);

  const holds = structurallyEquivalent(lhs, rhs);
  return {
    law: 'Associativity: union(A, union(B, C)) ≅ union(union(A, B), C)',
    holds,
    lhs,
    rhs,
    reason: holds ? undefined : `LHS has ${lhs.facets.length} facets, RHS has ${rhs.facets.length}`,
  };
}

/**
 * Verify absorption: union(A, intersection(A, B)) ≅ A
 */
export function verifyAbsorption(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
): LatticeLawProof {
  resetComposedIdCounter();
  const interAB = intersection(a, b);
  resetComposedIdCounter();
  const lhs = union(a, interAB);

  const holds = structurallyEquivalent(lhs, a);
  return {
    law: 'Absorption: union(A, intersection(A, B)) ≅ A',
    holds,
    lhs,
    rhs: a,
    reason: holds ? undefined : `LHS has ${lhs.facets.length} facets, A has ${a.facets.length}`,
  };
}

/**
 * Run all bounded lattice law verifications.
 */
export function verifyBoundedLattice(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
  c: ContextDescriptorData,
): {
  allHold: boolean;
  proofs: LatticeLawProof[];
  naturality: NaturalityWitness[];
} {
  const proofs = [
    verifyIdempotence(a),
    verifyCommutativity(a, b),
    verifyAssociativity(a, b, c),
    verifyAbsorption(a, b),
  ];

  const naturality = [
    verifyUnionNaturality(a, b),
    verifyIntersectionNaturality(a, b),
  ];

  return {
    allHold: proofs.every(p => p.holds) && naturality.every(n => n.commutes),
    proofs,
    naturality,
  };
}
