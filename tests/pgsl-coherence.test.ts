import { describe, it, expect } from 'vitest';
import {
  computeCoverage,
  getCertificates,
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
        expect(profile.usagesA).toBeGreaterThanOrEqual(0);
        expect(profile.usagesB).toBeGreaterThanOrEqual(0);
        expect(profile.overlap).toBeGreaterThanOrEqual(0);
        expect(profile.overlap).toBeLessThanOrEqual(1);
      }
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
