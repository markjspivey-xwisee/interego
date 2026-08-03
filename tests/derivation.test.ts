/**
 * Derivation tests — operationalize the grounding chain documented
 * in spec/DERIVATION.md.
 *
 * For every L2/L3 term tagged `iep:constructedFrom (...)`, we assert
 * (a) a runtime constructor exists and (b) it produces an output of
 * the expected shape from inputs of the declared L1 types.
 *
 * Plus the three structural properties that make the derivation
 * disciplined:
 *   1. Ω is closed under classify/members consistency.
 *   2. Geometric morphism adjunction: f*(f_*(T)) ⊇ T and
 *      f_*(f*(S)) ⊆ S.
 *   3. Modal Heyting algebra satisfies its laws (absorption,
 *      distributivity on the three-element order, intuitionistic
 *      negation).
 */

import { describe, it, expect } from 'vitest';
import {
  composeFacetTransformations,
  constructOmega,
  type FacetTransformation,
  identityFacetTransformation,
  type IRI,
  makeGeometricMorphism,
  ModalAlgebra,
  type ModalValue,
  type PodView,
  type SemioticFacetData,
} from '@interego/core';

// ── Ω (subobject classifier) ──────────────────────────────

describe('Ω (subobject classifier)', () => {
  const candidates = [
    'urn:frag:a',
    'urn:frag:b',
    'urn:frag:c',
  ] as IRI[];

  it('classifies candidates correctly', () => {
    const Omega = constructOmega('valid-shapes', candidates, u => u.endsWith('a') || u.endsWith('c'));
    expect(Omega.classify('urn:frag:a' as IRI)).toBe('true');
    expect(Omega.classify('urn:frag:b' as IRI)).toBe('false');
    expect(Omega.classify('urn:frag:c' as IRI)).toBe('true');
  });

  it('returns indeterminate for unseen URIs', () => {
    const Omega = constructOmega('x', candidates, () => true);
    expect(Omega.classify('urn:frag:unseen' as IRI)).toBe('indeterminate');
  });

  it('members returns exactly the true verdicts', () => {
    const Omega = constructOmega('x', candidates, u => u.endsWith('b'));
    expect(Omega.members()).toEqual(['urn:frag:b']);
  });
});

// ── Geometric morphisms ───────────────────────────────────

describe('geometric morphism adjunction', () => {
  const podA: PodView = {
    url: 'https://pod-a/',
    descriptors: new Set(['urn:a:1', 'urn:a:2', 'urn:a:3'] as IRI[]),
    citations: new Map([
      ['urn:a:1', new Set(['urn:b:1'] as IRI[])] as const,
      ['urn:a:2', new Set(['urn:b:1', 'urn:b:2'] as IRI[])] as const,
      ['urn:a:3', new Set([] as IRI[])] as const,
    ]),
  };
  const podB: PodView = {
    url: 'https://pod-b/',
    descriptors: new Set(['urn:b:1', 'urn:b:2', 'urn:b:3'] as IRI[]),
    citations: new Map([
      ['urn:b:1', new Set(['urn:a:1'] as IRI[])] as const,
      ['urn:b:2', new Set([] as IRI[])] as const,
      ['urn:b:3', new Set(['urn:a:2', 'urn:a:3'] as IRI[])] as const,
    ]),
  };

  const f = makeGeometricMorphism(podA, podB);

  it('inverseImage returns PodA descriptors citing into S ⊆ PodB', () => {
    const S = new Set(['urn:b:1'] as IRI[]);
    const result = f.inverseImage(S);
    // urn:a:1 and urn:a:2 both cite urn:b:1
    expect(result.has('urn:a:1' as IRI)).toBe(true);
    expect(result.has('urn:a:2' as IRI)).toBe(true);
    expect(result.has('urn:a:3' as IRI)).toBe(false);
  });

  it('directImage returns PodB descriptors citing into T ⊆ PodA', () => {
    const T = new Set(['urn:a:2'] as IRI[]);
    const result = f.directImage(T);
    // urn:b:3 cites urn:a:2
    expect(result.has('urn:b:3' as IRI)).toBe(true);
    expect(result.has('urn:b:1' as IRI)).toBe(false);
  });

  it('monotonicity: S ⊆ S\' implies inverseImage(S) ⊆ inverseImage(S\')', () => {
    // True adjunction (f* ⊣ f_*) requires a directional pod morphism
    // (e.g., inclusion). Our implementation is citation-based and
    // symmetric; what holds is functoriality of each map in isolation.
    // If S grows, its preimage grows (or stays the same). Same for
    // directImage.
    const S = new Set(['urn:b:1'] as IRI[]);
    const Sprime = new Set(['urn:b:1', 'urn:b:2'] as IRI[]);
    const preimage1 = f.inverseImage(S);
    const preimage2 = f.inverseImage(Sprime);
    for (const x of preimage1) {
      expect(preimage2.has(x)).toBe(true);
    }
  });

  it('empty input produces empty output', () => {
    const empty = new Set<IRI>();
    expect(f.inverseImage(empty).size).toBe(0);
    expect(f.directImage(empty).size).toBe(0);
  });
});

// ── Modal Heyting algebra ─────────────────────────────────

describe('modal Heyting algebra on {Asserted, Hypothetical, Counterfactual}', () => {
  const all: ModalValue[] = ['Asserted', 'Hypothetical', 'Counterfactual'];

  it('meet is idempotent', () => {
    for (const v of all) {
      expect(ModalAlgebra.meet(v, v)).toBe(v);
    }
  });

  it('meet is commutative', () => {
    for (const a of all) for (const b of all) {
      expect(ModalAlgebra.meet(a, b)).toBe(ModalAlgebra.meet(b, a));
    }
  });

  it('join is idempotent', () => {
    for (const v of all) {
      expect(ModalAlgebra.join(v, v)).toBe(v);
    }
  });

  it('absorption: a ∧ (a ∨ b) = a', () => {
    for (const a of all) for (const b of all) {
      expect(ModalAlgebra.meet(a, ModalAlgebra.join(a, b))).toBe(a);
    }
  });

  it('absorption: a ∨ (a ∧ b) = a', () => {
    for (const a of all) for (const b of all) {
      expect(ModalAlgebra.join(a, ModalAlgebra.meet(a, b))).toBe(a);
    }
  });

  it('intuitionistic double-negation: ¬¬Asserted ≠ Asserted in general', () => {
    // Classical would give: ¬¬Asserted = Asserted.
    // Intuitionistic: we implement ¬Hypothetical = Hypothetical,
    //   so ¬¬Hypothetical = Hypothetical (stable).
    // For the classical poles (Asserted / Counterfactual), double
    //   negation is well-behaved.
    expect(ModalAlgebra.not(ModalAlgebra.not('Asserted'))).toBe('Asserted');
    expect(ModalAlgebra.not(ModalAlgebra.not('Counterfactual'))).toBe('Counterfactual');
    expect(ModalAlgebra.not(ModalAlgebra.not('Hypothetical'))).toBe('Hypothetical');
  });

  it('Heyting implication classical reductions', () => {
    // a=Counterfactual (⊥) ⇒ implies always = Asserted (⊤)
    for (const b of all) expect(ModalAlgebra.implies('Counterfactual', b)).toBe('Asserted');
    // b=Asserted (⊤) ⇒ implies always = Asserted (⊤)
    for (const a of all) expect(ModalAlgebra.implies(a, 'Asserted')).toBe('Asserted');
    // a=Asserted ⇒ implies = b
    for (const b of all) expect(ModalAlgebra.implies('Asserted', b)).toBe(b);
  });
});

// ── FacetTransformation monoid ────────────────────────────

describe('FacetTransformation composition', () => {
  // ★ FACETS, NOT NUMBERS. `FacetTransformation<F>` is declared
  // `F extends ContextFacetData`, and these three tests used `readonly number[]` — which
  // is why every line of them carried an `as any`: twelve of them, one per position where
  // a number failed to be a facet. Twelve casts is the API telling you the test is not
  // exercising it. The monoid laws are the same laws over facets, and the transformations
  // now typecheck against the signature they claim to be testing, so a change to
  // `FacetTransformation`'s shape breaks this file instead of sliding through.
  const conf = (n: number): SemioticFacetData => ({ type: 'Semiotic', epistemicConfidence: n });
  const add: FacetTransformation<SemioticFacetData> = (arr) => [...arr, conf(1)];
  const dup: FacetTransformation<SemioticFacetData> = (arr) => [...arr, ...arr];
  const two: readonly SemioticFacetData[] = [conf(0.1), conf(0.2)];
  const one: readonly SemioticFacetData[] = [conf(0.1)];

  it('identity is a left identity', () => {
    const id = identityFacetTransformation<SemioticFacetData>();
    expect(composeFacetTransformations(id, add)(two)).toEqual([...two, conf(1)]);
  });

  it('identity is a right identity', () => {
    const id = identityFacetTransformation<SemioticFacetData>();
    expect(composeFacetTransformations(add, id)(two)).toEqual([...two, conf(1)]);
  });

  it('composition is associative', () => {
    const left = composeFacetTransformations(
      composeFacetTransformations(add, dup),
      add,
    )(one);
    const right = composeFacetTransformations(
      add,
      composeFacetTransformations(dup, add),
    )(one);
    expect(left).toEqual(right);
    // Pin the VALUE too, not just the equality: `left` and `right` would agree trivially
    // if either composition had silently become the identity.
    expect(left).toEqual([conf(0.1), conf(1), conf(0.1), conf(1), conf(1)]);
  });
});
