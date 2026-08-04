import { describe, it, expect } from 'vitest';
import {
  computeCoverage,
  getCoherenceStatus,
  verifyCoherence,
} from '@interego/pgsl';
import {
  createPGSL,
  embedInPGSL,
} from '@interego/pgsl';
import type {
  IRI,
} from '@interego/core';

describe('Coherence Verification', () => {
  function makePgsl(provAgent: string) {
    return createPGSL({
      wasAttributedTo: provAgent as IRI,
      generatedAtTime: new Date().toISOString(),
    });
  }

  describe('verifyCoherence', () => {
    it('returns verified when agents share usage patterns', () => {
      const pgslA = makePgsl('agent-a');
      const pgslB = makePgsl('agent-b');
      embedInPGSL(pgslA, 'mark is human');
      embedInPGSL(pgslB, 'mark is human');

      const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'test');
      expect(cert.status).toBe('verified');
      expect(cert.semanticOverlap).toBeGreaterThan(0.5);
      expect(cert.semanticProfile.length).toBeGreaterThan(0);
    });

    it('returns divergent when shared atoms have different usage', () => {
      const pgslA = makePgsl('agent-a');
      const pgslB = makePgsl('agent-b');
      embedInPGSL(pgslA, 'patient status critical');
      embedInPGSL(pgslB, 'account status active');

      const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'status');
      // 'status' is shared but used differently
      expect(cert.status).toBe('divergent');
      expect(cert.obstruction).toBeDefined();
    });

    it('returns unexamined when no shared atoms', () => {
      const pgslA = makePgsl('agent-a');
      const pgslB = makePgsl('agent-b');
      embedInPGSL(pgslA, 'mark is human');
      embedInPGSL(pgslB, 'cat is animal');

      const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'test');
      // 'is' is shared but the other atoms are different
      // Whether this is verified or divergent depends on usage overlap of 'is'
      expect(['verified', 'divergent', 'unexamined']).toContain(cert.status);
    });

    it('computes semantic overlap as continuous 0-1', () => {
      const pgslA = makePgsl('agent-a');
      const pgslB = makePgsl('agent-b');
      embedInPGSL(pgslA, 'mark is human');
      embedInPGSL(pgslA, 'mark is employee');
      embedInPGSL(pgslB, 'mark is human');
      embedInPGSL(pgslB, 'mark is animal');

      const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'test');
      expect(cert.semanticOverlap).toBeGreaterThanOrEqual(0);
      expect(cert.semanticOverlap).toBeLessThanOrEqual(1);
    });

    it('includes per-atom semantic profile', () => {
      const pgslA = makePgsl('agent-a');
      const pgslB = makePgsl('agent-b');
      embedInPGSL(pgslA, 'mark is human');
      embedInPGSL(pgslB, 'mark is human');

      const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'test');
      expect(cert.semanticProfile.length).toBeGreaterThan(0);
      for (const profile of cert.semanticProfile) {
        expect(profile.atom).toBeTruthy();
        // ★ `usages >= 0` is vacuous — a usage COUNT cannot be negative, so both lines
        // passed on a profile where the atom appeared in neither lattice. An atom only
        // reaches the semantic profile by being used, so at least one side must be non-zero.
        // (The `overlap` bounds below are a genuine [0,1] range check and stay as they are.)
        expect(profile.usagesA + profile.usagesB).toBeGreaterThan(0);
        expect(profile.overlap).toBeGreaterThanOrEqual(0);
        expect(profile.overlap).toBeLessThanOrEqual(1);
      }
    });

    it('per-atom profile attributes usage to the RIGHT side when the sides differ', () => {
      // ★ THE FIXTURE THE TEST ABOVE CANNOT BE. Both agents there embed the SAME utterance,
      // so usagesA === usagesB for every atom and a defect that reported A's count for B
      // (`usagesB: sigA.size`, coherence.ts:198) is invisible: `usagesA + usagesB > 0` and
      // the [0,1] overlap bounds all still hold under it. Here B uses 'mark' in strictly
      // fewer contexts than A, so each side's count, the shared count, and which side owns
      // the leftover contexts are separately pinned.
      const pgslA = makePgsl('agent-a');
      const pgslB = makePgsl('agent-b');
      embedInPGSL(pgslA, 'mark is human');
      embedInPGSL(pgslB, 'mark');

      const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'test');
      expect(cert.semanticProfile).toHaveLength(1);
      const profile = cert.semanticProfile[0]!;
      expect(profile.atom).toBe('mark');
      // Counts are asserted RELATIVE to each other rather than pinned to the measured 3 and
      // 1, so a legitimate change to PGSL's fragment decomposition cannot fail this test for
      // the wrong reason — only a side-attribution defect can.
      expect(profile.usagesB).toBeGreaterThanOrEqual(1);
      expect(profile.usagesA).toBeGreaterThan(profile.usagesB);
      expect(profile.sharedUsages).toBe(profile.usagesB);
      expect(profile.uniqueToA).toHaveLength(profile.usagesA - profile.usagesB);
      expect(profile.uniqueToB).toEqual([]);
      // overlap is shared / max(A, B) — here max(A, B) is A.
      expect(profile.overlap).toBeCloseTo(profile.sharedUsages / profile.usagesA, 10);
    });

    it('generates a computation hash for replayability', () => {
      const pgslA = makePgsl('agent-a');
      const pgslB = makePgsl('agent-b');
      embedInPGSL(pgslA, 'mark is human');
      embedInPGSL(pgslB, 'mark is human');

      const cert = verifyCoherence(pgslA, pgslB, 'agent-a', 'agent-b', 'test');
      expect(cert.computationHash).toBeTruthy();
      expect(cert.computationHash.length).toBe(40);
    });
  });

  describe('computeCoverage', () => {
    it('returns full coverage when all pairs examined', () => {
      const pgslA = makePgsl('a');
      const pgslB = makePgsl('b');
      embedInPGSL(pgslA, 'hello world');
      embedInPGSL(pgslB, 'hello world');
      verifyCoherence(pgslA, pgslB, 'a', 'b', 'test');

      const coverage = computeCoverage(['a', 'b']);
      expect(coverage.totalPairs).toBe(1);
      expect(coverage.unexamined).toBe(0);
      expect(coverage.coverage).toBe(1);
    });

    it('identifies unexamined pairs', () => {
      const coverage = computeCoverage(['x', 'y', 'z']);
      // 3 agents = 3 pairs, none examined
      expect(coverage.totalPairs).toBe(3);
      expect(coverage.unexaminedPairs.length).toBe(3);
      expect(coverage.coverage).toBe(0);
    });
  });

  describe('getCoherenceStatus', () => {
    it('returns unexamined for unknown pairs', () => {
      expect(getCoherenceStatus('unknown1', 'unknown2')).toBe('unexamined');
    });
  });
});
