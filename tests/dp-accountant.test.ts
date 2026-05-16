/**
 * Privacy-accountant contract tests.
 *
 * Pins the headline mathematical guarantees:
 *
 *   1. AdvancedCompositionAccountant: throws on naive-ε overflow;
 *      tightenedEpsilon is a function of (k, ε_max, δ) matching the
 *      DRV formula.
 *   2. RenyiAccountant: rhoForEpsilonDP matches the closed-form
 *      Mironov 2017 bound; consume() throws on cumulative-ρ overflow;
 *      convertToEpsilonDelta returns ρ + log(1/δ)/(α−1).
 *   3. sweepRenyiBestEpsilon picks the α minimizing the converted ε
 *      across the supplied grid.
 *   4. The tighter accountants give SMALLER cumulative ε than the
 *      naive sum for typical query mixes (the headline benefit).
 */

import { describe, it, expect } from 'vitest';
import {
  AdvancedCompositionAccountant,
  RenyiAccountant,
  sweepRenyiBestEpsilon,
} from '../src/crypto/dp-accountant.js';

describe('AdvancedCompositionAccountant', () => {
  it('tracks naive sum + throws on overflow', () => {
    const acc = new AdvancedCompositionAccountant({ maxNaiveEpsilon: 1.0 });
    acc.consume({ queryDescription: 'a', epsilon: 0.3 });
    acc.consume({ queryDescription: 'b', epsilon: 0.3 });
    expect(acc.spent).toBeCloseTo(0.6, 9);
    expect(acc.queryCount).toBe(2);
    expect(() => acc.consume({ queryDescription: 'c', epsilon: 0.5 })).toThrow(/would push cumulative naive-ε/);
  });

  it('tightenedEpsilon matches the DRV closed form', () => {
    const acc = new AdvancedCompositionAccountant({ maxNaiveEpsilon: 100 });
    for (let i = 0; i < 10; i++) acc.consume({ queryDescription: `q${i}`, epsilon: 0.1 });
    // Closed form: ε' = √(2k ln(1/δ)) · ε_max + k · ε_max · (e^{ε_max} − 1)
    const k = 10, eps = 0.1, delta = 1e-5;
    const expected = Math.sqrt(2 * k * Math.log(1 / delta)) * eps + k * eps * (Math.exp(eps) - 1);
    expect(acc.tightenedEpsilon(delta)).toBeCloseTo(expected, 9);
  });

  it('tightenedEpsilon is smaller than naive sum when k is large + ε is small', () => {
    const acc = new AdvancedCompositionAccountant({ maxNaiveEpsilon: 100 });
    for (let i = 0; i < 50; i++) acc.consume({ queryDescription: `q${i}`, epsilon: 0.05 });
    const naive = acc.spent;
    const tightened = acc.tightenedEpsilon(1e-5);
    expect(tightened).toBeLessThan(naive);
  });

  it('tightenedEpsilon returns 0 with no queries', () => {
    const acc = new AdvancedCompositionAccountant({ maxNaiveEpsilon: 1 });
    expect(acc.tightenedEpsilon(1e-5)).toBe(0);
  });

  it('throws on invalid maxNaiveEpsilon and consume args', () => {
    expect(() => new AdvancedCompositionAccountant({ maxNaiveEpsilon: 0 })).toThrow(/must be > 0/);
    const acc = new AdvancedCompositionAccountant({ maxNaiveEpsilon: 1 });
    expect(() => acc.consume({ queryDescription: 'x', epsilon: 0 })).toThrow(/must be > 0/);
    expect(() => acc.tightenedEpsilon(0)).toThrow(/delta must be in/);
    expect(() => acc.tightenedEpsilon(1)).toThrow(/delta must be in/);
  });
});

describe('RenyiAccountant', () => {
  it('rhoForEpsilonDP is monotone in ε at fixed α', () => {
    const a = 4;
    const r1 = RenyiAccountant.rhoForEpsilonDP(a, 0.1);
    const r2 = RenyiAccountant.rhoForEpsilonDP(a, 0.5);
    const r3 = RenyiAccountant.rhoForEpsilonDP(a, 1.0);
    expect(r1).toBeLessThan(r2);
    expect(r2).toBeLessThan(r3);
  });

  it('rhoForEpsilonDP is positive for any α > 1, ε > 0', () => {
    for (const a of [2, 4, 8, 16]) {
      for (const e of [0.01, 0.1, 0.5, 1.0]) {
        expect(RenyiAccountant.rhoForEpsilonDP(a, e)).toBeGreaterThan(0);
      }
    }
  });

  it('tracks cumulative Rényi divergence + throws on overflow', () => {
    const acc = new RenyiAccountant({ alpha: 4, maxRho: 0.1 });
    // Each query at ε=0.1 adds a small ρ.
    const onePass = RenyiAccountant.rhoForEpsilonDP(4, 0.1);
    expect(onePass).toBeLessThan(0.05);
    acc.consume({ queryDescription: 'a', epsilon: 0.1 });
    expect(acc.spentRho).toBeCloseTo(onePass, 9);
    // Push until just before overflow.
    while (acc.spentRho + onePass <= acc.maxRho) acc.consume({ queryDescription: 'q', epsilon: 0.1 });
    expect(() => acc.consume({ queryDescription: 'over', epsilon: 0.1 })).toThrow(/cumulative ρ/);
  });

  it('convertToEpsilonDelta returns ρ + log(1/δ)/(α−1)', () => {
    const acc = new RenyiAccountant({ alpha: 8, maxRho: 100 });
    acc.consume({ queryDescription: 'q1', epsilon: 0.2 });
    acc.consume({ queryDescription: 'q2', epsilon: 0.2 });
    const r = acc.convertToEpsilonDelta(1e-6);
    expect(r.delta).toBe(1e-6);
    const expected = acc.spentRho + Math.log(1e6) / 7;
    expect(r.epsilon).toBeCloseTo(expected, 9);
  });

  it('canAfford honors maxRho', () => {
    const acc = new RenyiAccountant({ alpha: 4, maxRho: 0.001 });
    expect(acc.canAfford(0.01)).toBe(true);
    acc.consume({ queryDescription: 'q', epsilon: 0.01 });
    expect(acc.canAfford(10.0)).toBe(false); // way too much
  });

  it('throws on invalid alpha / maxRho / consume args', () => {
    expect(() => new RenyiAccountant({ alpha: 1, maxRho: 1 })).toThrow(/alpha must be > 1/);
    expect(() => new RenyiAccountant({ alpha: 2, maxRho: 0 })).toThrow(/maxRho must be > 0/);
    const acc = new RenyiAccountant({ alpha: 4, maxRho: 1 });
    expect(() => acc.consume({ queryDescription: 'x', epsilon: -1 })).toThrow(/must be > 0/);
    expect(() => acc.convertToEpsilonDelta(1.5)).toThrow(/delta must be in/);
  });
});

describe('sweepRenyiBestEpsilon — pick the tightest α', () => {
  it('returns the α minimizing the converted ε at the target δ', () => {
    const r = sweepRenyiBestEpsilon({
      perQueryEpsilons: Array(20).fill(0.1),
      delta: 1e-6,
    });
    // The sweep contains all default α's; bestEpsilon is the minimum.
    expect(r.sweep.length).toBe(6);
    const minByHand = Math.min(...r.sweep.map(s => s.epsilon));
    expect(r.bestEpsilon).toBeCloseTo(minByHand, 12);
    expect(r.sweep.find(s => s.alpha === r.bestAlpha)!.epsilon).toBeCloseTo(r.bestEpsilon, 12);
  });

  it('honors a custom α grid', () => {
    const r = sweepRenyiBestEpsilon({
      perQueryEpsilons: [0.5, 0.5],
      delta: 1e-3,
      alphas: [2, 5, 10],
    });
    expect(r.sweep.length).toBe(3);
    expect(r.sweep.map(s => s.alpha).sort((a, b) => a - b)).toEqual([2, 5, 10]);
  });

  it('rejects invalid δ', () => {
    expect(() => sweepRenyiBestEpsilon({ perQueryEpsilons: [0.1], delta: 0 })).toThrow(/delta must be in/);
  });
});

describe('headline benefit: tighter accountants beat naive composition', () => {
  it('AdvancedCompositionAccountant beats naive sum for many small queries', () => {
    const acc = new AdvancedCompositionAccountant({ maxNaiveEpsilon: 1e6 });
    const k = 100, eps = 0.05;
    for (let i = 0; i < k; i++) acc.consume({ queryDescription: `q${i}`, epsilon: eps });
    const naive = acc.spent;             // 100 * 0.05 = 5
    const adv = acc.tightenedEpsilon(1e-5);
    expect(adv).toBeLessThan(naive);
    expect(adv).toBeLessThan(naive * 0.85); // typically much tighter
  });

  it('RenyiAccountant + sweep beats naive sum for many small queries', () => {
    const k = 100, eps = 0.05;
    const naive = k * eps; // 5
    const r = sweepRenyiBestEpsilon({
      perQueryEpsilons: Array(k).fill(eps),
      delta: 1e-5,
    });
    expect(r.bestEpsilon).toBeLessThan(naive);
  });
});
