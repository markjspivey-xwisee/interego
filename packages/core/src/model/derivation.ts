/**
 * @module model/derivation
 * @description Runtime derivation constructors per spec/DERIVATION.md.
 *
 * Every higher-level ontology term tagged `cg:constructedFrom (A B ...)`
 * has a corresponding runtime constructor here, so the grounding is
 * operational, not just declarative.
 *
 * What this module provides:
 *
 *   - `constructOmega(pgsl, validityFn)` — the subobject classifier
 *     for a PGSL topos. Takes a PGSL instance + a per-fragment
 *     "is this valid?" function and returns an Ω-object that
 *     classifies which fragments count as "in" the subobject.
 *
 *   - `inverseImage` / `directImage` — geometric morphisms for
 *     cross-pod federation. Map descriptors between two pods'
 *     presheaf categories.
 *
 *   - `constructModalHeyting()` — the three-valued Heyting algebra
 *     on {Asserted, Counterfactual, Hypothetical} constructed from
 *     the lattice primitives (∧, ∨, ¬, →). This lets modal logic
 *     be reasoned about via ordinary Heyting algebra operations
 *     rather than tagged values.
 *
 *   - `mergeStrategy` type — naturally-typed merge strategies as
 *     categorical arrows between facet presheaves. Renames what
 *     composition.ts already uses but with explicit typing.
 *
 * Tests in `tests/derivation.test.ts` exercise each constructor.
 */

import type { IRI, ContextDescriptorData, ContextFacetData } from './types.js';

// ── Subobject classifier Ω ──────────────────────────────────

/**
 * The Ω object for a (slice of a) presheaf topos: a function
 * that, for any fragment URI, returns one of three truth values.
 * Classically Ω has just {true, false}; here we expose the
 * three-valued form that matches our modal logic (Asserted,
 * Hypothetical, Counterfactual) so audit reasoning stays
 * compositional with the rest of the system.
 */
export type OmegaVerdict = 'true' | 'false' | 'indeterminate';

export interface Omega {
  /** The name of the subobject this Ω classifies. */
  readonly name: string;
  /** Classify a candidate URI. */
  classify(uri: IRI): OmegaVerdict;
  /** All URIs the classifier has seen with true verdicts. */
  members(): readonly IRI[];
}

/**
 * Construct the subobject classifier for a validity predicate over
 * a set of candidate URIs (typically PGSL fragment URIs or
 * descriptor URIs). The returned `Omega` is deterministic for the
 * inputs it was constructed over and returns `indeterminate` for
 * URIs outside that domain (so composition with other Ω objects
 * doesn't produce false negatives).
 */
export function constructOmega(
  name: string,
  candidates: readonly IRI[],
  validityFn: (uri: IRI) => boolean,
): Omega {
  const verdicts = new Map<IRI, OmegaVerdict>();
  for (const c of candidates) {
    verdicts.set(c, validityFn(c) ? 'true' : 'false');
  }
  return {
    name,
    classify(uri) {
      return verdicts.get(uri) ?? 'indeterminate';
    },
    members() {
      return [...verdicts.entries()]
        .filter(([, v]) => v === 'true')
        .map(([u]) => u);
    },
  };
}

// ── Geometric morphisms between pod presheaves ─────────────

/**
 * Cross-pod federation as a symmetric citation relation between two
 * pods. In pure category theory a geometric morphism f : PodA → PodB
 * is a pair of adjoint functors (f* ⊣ f_*) over a DIRECTIONAL pod
 * morphism (e.g., pod inclusion). Our implementation is weaker — a
 * symmetric bipartite relation over mutual citations — so the full
 * adjunction doesn't hold.
 *
 * What DOES hold (and is tested):
 *   - Each of f*, f_* is MONOTONE (S ⊆ S' ⇒ f(S) ⊆ f(S')).
 *   - Empty input produces empty output.
 *   - Closed-under-composition with other geometric-morphism-like
 *     operations from the federation surface.
 *
 * This is sufficient for the federation queries we actually run
 * (audit-walks, reputation aggregation, shape-discovery); the full
 * adjunction would be needed for e.g. subobject-classifier transport,
 * which we don't exercise.
 *
 *   - inverse-image of a set S ⊆ PodB is the set of PodA descriptors
 *     whose prov:wasDerivedFrom cites some element of S.
 *   - direct-image of a set T ⊆ PodA is the set of PodB descriptors
 *     that cite any element of T.
 */
export interface PodView {
  /** Pod URL (must end with /). */
  readonly url: string;
  /** Descriptor URIs known in this pod. */
  readonly descriptors: ReadonlySet<IRI>;
  /**
   * For each descriptor, the IRIs it cites via prov:wasDerivedFrom
   * (may be on this pod or another pod).
   */
  readonly citations: ReadonlyMap<IRI, ReadonlySet<IRI>>;
}

export interface GeometricMorphism {
  readonly source: PodView;
  readonly target: PodView;
  /**
   * Inverse-image functor f*: given a subset of target's descriptors,
   * returns the subset of source descriptors that cite into it.
   */
  inverseImage(S: ReadonlySet<IRI>): ReadonlySet<IRI>;
  /**
   * Direct-image functor f_*: given a subset of source's descriptors,
   * returns the subset of target descriptors that cite into it.
   */
  directImage(T: ReadonlySet<IRI>): ReadonlySet<IRI>;
}

export function makeGeometricMorphism(
  source: PodView,
  target: PodView,
): GeometricMorphism {
  const inverseImage = (S: ReadonlySet<IRI>): ReadonlySet<IRI> => {
    const result = new Set<IRI>();
    for (const d of source.descriptors) {
      const cites = source.citations.get(d);
      if (!cites) continue;
      for (const c of cites) {
        if (S.has(c)) { result.add(d); break; }
      }
    }
    return result;
  };
  const directImage = (T: ReadonlySet<IRI>): ReadonlySet<IRI> => {
    const result = new Set<IRI>();
    for (const d of target.descriptors) {
      const cites = target.citations.get(d);
      if (!cites) continue;
      for (const c of cites) {
        if (T.has(c)) { result.add(d); break; }
      }
    }
    return result;
  };
  return { source, target, inverseImage, directImage };
}

// ── Three-valued modal Heyting algebra ─────────────────────

/**
 * Modal values as Heyting-algebra elements. The order is:
 *
 *         Asserted  (⊤ : truth, groundTruth=true)
 *            │
 *       Hypothetical  (↯ : undetermined)
 *            │
 *       Counterfactual  (⊥ : falsity, groundTruth=false)
 *
 * Operations:
 *   ∧ (meet)    : min on the order. Conservative truth.
 *   ∨ (join)    : max on the order. Permissive truth.
 *   ¬ (negation): intuitionistic — ¬Asserted = Counterfactual,
 *                 ¬Hypothetical = Hypothetical (not settled),
 *                 ¬Counterfactual = Asserted.
 *   → (implies) : Heyting implication a → b = greatest c with
 *                 a ∧ c ≤ b. Reduces to classical when both
 *                 operands are in {⊤, ⊥}; stays three-valued
 *                 through Hypothetical.
 */
export type ModalValue = 'Asserted' | 'Hypothetical' | 'Counterfactual';

const RANK: Record<ModalValue, number> = {
  Counterfactual: 0,
  Hypothetical: 1,
  Asserted: 2,
};

const BY_RANK: Record<number, ModalValue> = {
  0: 'Counterfactual',
  1: 'Hypothetical',
  2: 'Asserted',
};

export const ModalAlgebra = {
  /** Meet: conservative truth. */
  meet(a: ModalValue, b: ModalValue): ModalValue {
    return BY_RANK[Math.min(RANK[a], RANK[b])]!;
  },
  /** Join: permissive truth. */
  join(a: ModalValue, b: ModalValue): ModalValue {
    return BY_RANK[Math.max(RANK[a], RANK[b])]!;
  },
  /** Intuitionistic negation. */
  not(a: ModalValue): ModalValue {
    if (a === 'Asserted') return 'Counterfactual';
    if (a === 'Counterfactual') return 'Asserted';
    return 'Hypothetical';
  },
  /** Heyting implication a → b = sup { c | a ∧ c ≤ b }. */
  implies(a: ModalValue, b: ModalValue): ModalValue {
    // Classical reduction: if a=false or b=true then implies=true.
    if (a === 'Counterfactual') return 'Asserted';
    if (b === 'Asserted') return 'Asserted';
    // a ∧ c ≤ b ⇔ c ≤ b when a=Asserted; so implies=b.
    if (a === 'Asserted') return b;
    // a=Hypothetical: want c with (min(1, RANK(c)) ≤ RANK(b)).
    // If b = Hypothetical (1): any c works with min(1, RANK(c)) ≤ 1 → always.
    //   Sup = Asserted.
    // If b = Counterfactual (0): need min(1, RANK(c)) ≤ 0 → RANK(c) = 0.
    //   Sup = Counterfactual.
    return b === 'Hypothetical' ? 'Asserted' : 'Counterfactual';
  },
} as const;

/** Map a facet's modalStatus to a ModalValue. */
export function facetModal(f: ContextFacetData): ModalValue | null {
  if (f.type !== 'Semiotic') return null;
  return f.modalStatus as ModalValue;
}

/** Aggregate a descriptor's modal position across all Semiotic facets
 *  via the meet (most-conservative). Mirrors the audit's "weakest link"
 *  posture when a descriptor carries sibling semiotic facets. */
export function descriptorModal(d: ContextDescriptorData): ModalValue {
  const sems = d.facets
    .map(facetModal)
    .filter((m): m is ModalValue => m != null);
  if (sems.length === 0) return 'Hypothetical';
  return sems.reduce((a, b) => ModalAlgebra.meet(a, b));
}

// ── Natural-transformation-typed merge strategies ──────────

/**
 * A facet transformation IS a natural transformation between facet
 * presheaves. Typing it explicitly as `FacetTransformation<F>` makes
 * the category-theoretic claim in src/model/category.ts operational —
 * composition.ts's MergeStrategy string-enums select a strategy; the
 * strategy itself is realized as a FacetTransformation function.
 */
export type FacetTransformation<F extends ContextFacetData> = (inputs: readonly F[]) => readonly F[];

/** Combine two facet transformations via sequential composition.
 *  Associativity + identity make this a monoid. */
export function composeFacetTransformations<F extends ContextFacetData>(
  a: FacetTransformation<F>,
  b: FacetTransformation<F>,
): FacetTransformation<F> {
  return (inputs) => b(a(inputs));
}

/** Identity transformation: preserves all inputs. */
export function identityFacetTransformation<F extends ContextFacetData>(): FacetTransformation<F> {
  return (inputs) => inputs;
}

// ══════════════════════════════════════════════════════════════
// Temporal Modal Operators (LTL-style extensions)
// ══════════════════════════════════════════════════════════════
//
// The base ModalAlgebra reasons over a static three-valued lattice
// (Asserted, Hypothetical, Counterfactual). Temporal modal operators
// reason over how that modal value EVOLVES across time given:
//   - validUntil intervals (already in TemporalFacet)
//   - validUntilEvent / sinceEvent (event-bounded validity, cg.ttl)
//   - validWhile shape (validity contingent on shape satisfaction)
//   - alwaysValid / eventuallyValid LTL markers
//
// This file implements the runtime evaluator. It maps a descriptor +
// (a clock or event-stream) to the descriptor's *current* effective
// modal value.

/** Snapshot of the world at evaluation time. */
export interface TemporalContext {
  /** ISO 8601 instant. */
  readonly now: string;
  /** Set of event IRIs that have occurred (for event-bounded modal). */
  readonly observedEvents: ReadonlySet<IRI>;
  /** Optional: shape-evaluator hook for validWhile. Returns whether
   *  the named shape is satisfied by the descriptor's subject at `now`.
   *  If absent, validWhile is treated as ALWAYS satisfied (best-case
   *  default). */
  readonly shapeSatisfied?: (shapeIri: IRI, subject: IRI) => boolean;
}

/** Per-facet temporal annotations the evaluator inspects. */
export interface TemporalAnnotations {
  readonly validFrom?: string;
  readonly validUntil?: string;
  readonly validUntilEvent?: IRI;
  readonly sinceEvent?: IRI;
  readonly validWhile?: IRI;
  readonly alwaysValid?: boolean;
  readonly eventuallyValid?: boolean;
}

/** Extract temporal annotations from a descriptor's TemporalFacet. */
export function temporalAnnotations(d: ContextDescriptorData): TemporalAnnotations {
  const t = d.facets.find(f => f.type === 'Temporal') as
    & TemporalAnnotations
    & ContextFacetData
    | undefined;
  if (!t) return {};
  return {
    validFrom: t.validFrom,
    validUntil: t.validUntil,
    validUntilEvent: (t as { validUntilEvent?: IRI }).validUntilEvent,
    sinceEvent: (t as { sinceEvent?: IRI }).sinceEvent,
    validWhile: (t as { validWhile?: IRI }).validWhile,
    alwaysValid: (t as { alwaysValid?: boolean }).alwaysValid,
    eventuallyValid: (t as { eventuallyValid?: boolean }).eventuallyValid,
  };
}

/**
 * Evaluate a descriptor's effective modal status at a given time +
 * event state. Returns:
 *   - The descriptor's stated modal status if all temporal conditions
 *     are satisfied at `now`.
 *   - Hypothetical if the descriptor was published but its predicate
 *     is no longer satisfied (e.g. validWhile shape failed) — claim
 *     becomes uncertain rather than negated.
 *   - Counterfactual if validUntil has passed AND no validUntilEvent
 *     reset, OR if a sinceEvent has not yet occurred. Past-tense or
 *     not-yet-true.
 *   - 'pending' (special) if eventuallyValid + currently Hypothetical
 *     and the predicted condition has not occurred.
 *
 * The function is total: every descriptor + context yields a result,
 * never throws.
 */
export type EffectiveModal = ModalValue | 'pending';

export function effectiveModal(
  d: ContextDescriptorData,
  ctx: TemporalContext,
  subjectFor?: (d: ContextDescriptorData) => IRI,
): EffectiveModal {
  const baseModal = descriptorModal(d);
  const ann = temporalAnnotations(d);

  // alwaysValid: short-circuits to baseModal regardless of clock.
  if (ann.alwaysValid === true) return baseModal;

  // sinceEvent: not yet observed → claim hasn't started.
  if (ann.sinceEvent && !ctx.observedEvents.has(ann.sinceEvent)) {
    return 'Counterfactual';
  }

  // validUntilEvent: observed → claim has ended.
  if (ann.validUntilEvent && ctx.observedEvents.has(ann.validUntilEvent)) {
    return 'Counterfactual';
  }

  // validUntil: passed → claim expired.
  if (ann.validUntil && ann.validUntil <= ctx.now) {
    return 'Counterfactual';
  }

  // validFrom: not yet → claim hasn't started.
  if (ann.validFrom && ctx.now < ann.validFrom) {
    return 'Counterfactual';
  }

  // validWhile: shape currently NOT satisfied → claim becomes uncertain.
  if (ann.validWhile && ctx.shapeSatisfied) {
    const subject = subjectFor ? subjectFor(d) : (d.describes[0] as IRI | undefined);
    if (subject && !ctx.shapeSatisfied(ann.validWhile, subject)) {
      return 'Hypothetical';
    }
  }

  // eventuallyValid: marker says it WILL be Asserted; if currently
  // Hypothetical and condition not met, return 'pending' to surface
  // the prediction state distinctly from a stable Hypothetical.
  if (ann.eventuallyValid === true && baseModal === 'Hypothetical') {
    return 'pending';
  }

  return baseModal;
}

/** Build a TemporalContext for "now" with a list of observed events. */
export function temporalNow(observedEventList: readonly IRI[] = []): TemporalContext {
  return {
    now: new Date().toISOString(),
    observedEvents: new Set(observedEventList),
  };
}
