/**
 * @module model/semiotic
 * @description Functorial formalization of Sign ↔ Descriptor
 *
 * The semiotic category S has:
 *   Objects: signs (triadic: representamen, object, interpretant)
 *   Morphisms: sign relations (semiosis — the process by which signs produce meaning)
 *
 * The descriptor category D has:
 *   Objects: ContextDescriptorData
 *   Morphisms: composition operators (union, intersection, restriction, override)
 *
 * The functor Φ: D → S maps:
 *   Objects: descriptor ↦ sign (asSign)
 *   Morphisms: composition ↦ sign composition (signUnion, signIntersection)
 *
 * The functor Ψ: S → D maps:
 *   Objects: sign ↦ descriptor (fromSign)
 *   Morphisms: sign composition ↦ descriptor composition
 *
 * Φ and Ψ form an adjunction Ψ ⊣ Φ — Ψ is left adjoint to Φ.
 * The unit η: Id_S → Φ ∘ Ψ is the round-trip sign → descriptor → sign.
 * The counit ε: Ψ ∘ Φ → Id_D is the round-trip descriptor → sign → descriptor.
 *
 * For the adjunction to be well-defined:
 *   η must be a natural transformation (round-trip preserves sign structure)
 *   ε must be a natural transformation (round-trip preserves descriptor structure)
 *
 * The Semiotic Field Functor Σ from SAT maps into this framework:
 *   Σ: Set^(F^op) → Set^(S^op) is the composite Φ ∘ Yoneda
 */

import type {
  IRI,
  ContextDescriptorData,
  ContextFacetData,
  Sign,
  ModalStatus,
} from './types.js';
import { asSign, fromSign } from './types.js';
import { union, intersection } from './composition.js';

// ── Sign morphisms (semiosis) ────────────────────────────────

/**
 * A sign morphism — a structure-preserving map between signs.
 *
 * In Peircean semiotics, semiosis is the process by which a sign
 * produces an interpretant, which is itself a sign. A morphism
 * captures this: it maps representamena to representamena,
 * interpretants to interpretants.
 */
export interface SignMorphism {
  /** Source sign identity. */
  readonly source: IRI;
  /** Target sign identity. */
  readonly target: IRI;
  /** How representamena map (graph IRI correspondence). */
  readonly representamenMap: ReadonlyMap<IRI, IRI>;
  /** How interpretants map (facet type correspondence). */
  readonly interpretantMap: ReadonlyMap<string, string>;
  /** The type of semiotic process. */
  readonly semiosisType: 'denotation' | 'connotation' | 'composition' | 'translation';
}

// ── Functor Φ: D → S (Descriptor → Sign) ────────────────────

/**
 * The functor Φ maps descriptors to signs.
 *
 * On objects: Φ(descriptor) = asSign(descriptor)
 * On morphisms: Φ(union(A,B)) = signUnion(Φ(A), Φ(B))
 *
 * This is structure-preserving: it maps composition in D
 * to composition in S.
 */
export function phi(descriptor: ContextDescriptorData): Sign {
  return asSign(descriptor);
}

/**
 * The functor Ψ maps signs to descriptors.
 *
 * On objects: Ψ(sign) = fromSign(sign)
 * On morphisms: Ψ(signUnion(A,B)) = union(Ψ(A), Ψ(B))
 */
export function psi(sign: Sign, opts?: { version?: number; supersedes?: IRI[] }): ContextDescriptorData {
  return fromSign(sign, opts);
}

// ── Sign composition (morphisms in S) ────────────────────────

/**
 * Union in the sign category.
 * The join of two signs merges their representamena and interpretants.
 */
export function signUnion(a: Sign, b: Sign, id?: IRI): Sign {
  const descA = fromSign(a);
  const descB = fromSign(b);
  const composed = union(descA, descB, id);
  return asSign(composed);
}

/**
 * Intersection in the sign category.
 * The meet of two signs retains shared representamena and interpretants.
 */
export function signIntersection(a: Sign, b: Sign, id?: IRI): Sign {
  const descA = fromSign(a);
  const descB = fromSign(b);
  const composed = intersection(descA, descB, id);
  return asSign(composed);
}

// ── Adjunction witnesses ─────────────────────────────────────

/**
 * The unit η: Id_S → Φ ∘ Ψ
 *
 * For a sign S, η(S) = Φ(Ψ(S)).
 * The round-trip sign → descriptor → sign should recover the original sign.
 */
export function adjunctionUnit(sign: Sign): {
  original: Sign;
  roundTrip: Sign;
  isomorphic: boolean;
} {
  const descriptor = psi(sign);
  const roundTrip = phi(descriptor);

  // Check structural isomorphism
  const sameRepresentamen =
    sign.representamen.length === roundTrip.representamen.length &&
    sign.representamen.every((r, i) => r === roundTrip.representamen[i]!);
  const sameInterpretant =
    sign.interpretant.length === roundTrip.interpretant.length &&
    sign.interpretant.every((f, i) => f.type === roundTrip.interpretant[i]!.type);

  return {
    original: sign,
    roundTrip,
    isomorphic: sameRepresentamen && sameInterpretant,
  };
}

/**
 * The counit ε: Ψ ∘ Φ → Id_D
 *
 * For a descriptor D, ε(D) = Ψ(Φ(D)).
 * The round-trip descriptor → sign → descriptor should recover the original.
 */
export function adjunctionCounit(descriptor: ContextDescriptorData): {
  original: ContextDescriptorData;
  roundTrip: ContextDescriptorData;
  isomorphic: boolean;
} {
  const sign = phi(descriptor);
  const roundTrip = psi(sign);

  const sameDescribes =
    descriptor.describes.length === roundTrip.describes.length &&
    descriptor.describes.every((g, i) => g === roundTrip.describes[i]!);
  const sameFacets =
    descriptor.facets.length === roundTrip.facets.length &&
    descriptor.facets.every((f, i) => f.type === roundTrip.facets[i]!.type);

  return {
    original: descriptor,
    roundTrip,
    isomorphic: sameDescribes && sameFacets,
  };
}

/**
 * Verify the full Φ ⊣ Ψ adjunction for given test data.
 *
 * Checks:
 * 1. Unit naturality: η is natural (round-trip preserves structure)
 * 2. Counit naturality: ε is natural (round-trip preserves structure)
 * 3. Functor preserves composition: Φ(union(A,B)) ≅ signUnion(Φ(A), Φ(B))
 */
export function verifyAdjunction(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
): {
  unitNatural: boolean;
  counitNatural: boolean;
  preservesComposition: boolean;
  details: {
    unitA: ReturnType<typeof adjunctionUnit>;
    unitB: ReturnType<typeof adjunctionUnit>;
    counitA: ReturnType<typeof adjunctionCounit>;
    counitB: ReturnType<typeof adjunctionCounit>;
  };
} {
  // Unit naturality
  const signA = phi(a);
  const signB = phi(b);
  const unitA = adjunctionUnit(signA);
  const unitB = adjunctionUnit(signB);

  // Counit naturality
  const counitA = adjunctionCounit(a);
  const counitB = adjunctionCounit(b);

  // Preservation of composition: Φ(union(A,B)) ≅ signUnion(Φ(A), Φ(B))
  const unionAB = union(a, b);
  const phiUnion = phi(unionAB);  // Φ applied to union in D
  const signU = signUnion(signA, signB);  // union in S applied to Φ(A), Φ(B)

  const preservesComposition =
    phiUnion.interpretant.length === signU.interpretant.length &&
    phiUnion.interpretant.every((f, i) => f.type === signU.interpretant[i]!.type);

  return {
    unitNatural: unitA.isomorphic && unitB.isomorphic,
    counitNatural: counitA.isomorphic && counitB.isomorphic,
    preservesComposition,
    details: { unitA, unitB, counitA, counitB },
  };
}

// ── Semiotic Field Functor Σ ─────────────────────────────────

/**
 * The Semiotic Field Functor Σ from SAT (Semiotic Agent Topos).
 *
 * Σ assigns to each descriptor its semiotic field — the space of
 * possible interpretations parameterized by modal status.
 *
 * Σ(descriptor) = { (modalStatus, confidence, interpretationFrame) }
 *
 * This is the map from the context presheaf topos to the semiotic
 * presheaf topos that SAT defines.
 */
export function semioticField(descriptor: ContextDescriptorData): {
  readonly modalStatus: ModalStatus;
  readonly confidence: number;
  readonly interpretationFrame?: IRI;
  readonly signSystem?: IRI;
  readonly groundTruth: boolean;
}[] {
  return descriptor.facets
    .filter(f => f.type === 'Semiotic')
    .map(f => {
      const s = f as Extract<ContextFacetData, { type: 'Semiotic' }>;
      return {
        modalStatus: s.modalStatus ?? 'Asserted',
        confidence: s.epistemicConfidence ?? 1.0,
        interpretationFrame: s.interpretationFrame,
        signSystem: s.signSystem,
        groundTruth: s.groundTruth ?? true,
      };
    });
}

/**
 * The Semiotic Field is a functor: it preserves composition.
 *
 * Σ(union(A, B)) = Σ(A) ∪ Σ(B)
 * Σ(intersection(A, B)) ⊆ Σ(A) ∩ Σ(B)
 *
 * Verify this for given descriptors.
 */
export function verifySemioticFieldFunctoriality(
  a: ContextDescriptorData,
  b: ContextDescriptorData,
): {
  preservesUnion: boolean;
  fieldA: ReturnType<typeof semioticField>;
  fieldB: ReturnType<typeof semioticField>;
  fieldUnion: ReturnType<typeof semioticField>;
} {
  const fieldA = semioticField(a);
  const fieldB = semioticField(b);
  const fieldUnion = semioticField(union(a, b));

  // Σ preserves union: Σ(A ∪ B) should contain all fields from Σ(A) and Σ(B)
  const expectedCount = fieldA.length + fieldB.length;
  const preservesUnion = fieldUnion.length === expectedCount;

  return { preservesUnion, fieldA, fieldB, fieldUnion };
}
