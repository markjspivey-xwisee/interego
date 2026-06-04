/**
 * Foxxi content-intelligence vertical — contract tests.
 *
 * Pins the substrate-composition guarantees this vertical relies on:
 *
 *   1. The two affordance arrays parse cleanly via the substrate's
 *      affordance-mcp derivation (the bridge derives MCP schemas from
 *      these declarations; CI failure here = adopter's MCP client
 *      can't see Foxxi tools).
 *   2. Affordance action IRIs follow the urn:cg:action:foxxi:<verb>
 *      convention.
 *   3. The dual-audience split is correct — both arrays are
 *      non-empty + disjoint.
 *   4. coverageQuery composes cleanly with the three privacy modes:
 *      abac (plain count), merkle-attested-opt-in (bundle verifies),
 *      zk-distribution (bundle verifies + per-bucket noise).
 */

import { describe, it, expect } from 'vitest';
import { foxxiAffordances, foxxiAdminAffordances } from '../affordances.js';
import { coverageQuery, type FoxxiConfig } from '../src/publisher.js';
import {
  verifyAttestedAggregateResult,
  verifyAttestedHomomorphicDistribution,
} from '../../_shared/aggregate-privacy/index.js';
import { affordanceToMcpToolSchema } from '../../_shared/affordance-mcp/index.js';
import type {
  IRI,
} from '@interego/core';

const TENANT_POD = 'https://interego-css.example/acme-training/';
const AUTH_DID = 'did:web:acme-training.example' as IRI;

const cfg: FoxxiConfig = {
  tenantPodUrl: TENANT_POD,
  authoritativeSource: AUTH_DID,
};

describe('foxxi affordances: shape + naming', () => {
  it('learner-side affordance array is non-empty', () => {
    expect(foxxiAffordances.length).toBeGreaterThan(0);
  });

  it('admin-side affordance array is non-empty', () => {
    expect(foxxiAdminAffordances.length).toBeGreaterThan(0);
  });

  it('learner + admin arrays are disjoint by action IRI', () => {
    const learnerIris = new Set(foxxiAffordances.map(a => a.action));
    for (const a of foxxiAdminAffordances) {
      expect(learnerIris.has(a.action)).toBe(false);
    }
  });

  it('every action IRI follows the urn:cg:action:foxxi:<verb> convention', () => {
    for (const a of [...foxxiAffordances, ...foxxiAdminAffordances]) {
      expect(a.action).toMatch(/^urn:cg:action:foxxi:[a-z0-9-]+$/);
    }
  });

  it('every toolName follows the foxxi.<verb> convention', () => {
    for (const a of [...foxxiAffordances, ...foxxiAdminAffordances]) {
      expect(a.toolName).toMatch(/^foxxi\.[a-z0-9_]+$/);
    }
  });

  it('every affordance derives a valid MCP tool schema (no derivation throw)', () => {
    for (const a of [...foxxiAffordances, ...foxxiAdminAffordances]) {
      const tool = affordanceToMcpToolSchema(a);
      expect(tool.name).toBe(a.toolName);
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('foxxi coverageQuery — composes the aggregate-privacy ladder', () => {
  const sampleCoverage = [
    { concept: 'handicap', taughtIn: ['golf-explained', 'a', 'b', 'c'], mentionedIn: ['golf-explained', 'a', 'b', 'c'] },
    { concept: 'golf', taughtIn: ['golf-fundamentals', 'golf-explained'], mentionedIn: ['golf-fundamentals', 'golf-explained', 'd'] },
    { concept: 'course par', taughtIn: ['golf-explained'], mentionedIn: ['golf-explained', 'e'] },
    { concept: 'fault response', taughtIn: ['golf-explained', 'a', 'b', 'c', 'd', 'e'], mentionedIn: ['golf-explained', 'a', 'b', 'c', 'd', 'e'] },
  ];

  it('abac mode returns plain count', () => {
    const r = coverageQuery({ config: cfg, coverage: sampleCoverage, privacyMode: 'abac' });
    expect(r.mode).toBe('abac');
    if (r.mode === 'abac') expect(r.coverageCount).toBe(4);
  });

  it('merkle-attested-opt-in mode produces a verifiable bundle', () => {
    const r = coverageQuery({ config: cfg, coverage: sampleCoverage, privacyMode: 'merkle-attested-opt-in' });
    expect(r.mode).toBe('merkle-attested-opt-in');
    if (r.mode === 'merkle-attested-opt-in') {
      const v = verifyAttestedAggregateResult(r.bundle);
      expect(v.valid).toBe(true);
      expect(r.bundle.count).toBe(4);
    }
  });

  it('zk-distribution mode produces a verifiable distribution bundle', () => {
    const r = coverageQuery({
      config: cfg,
      coverage: sampleCoverage,
      privacyMode: 'zk-distribution',
      epsilon: 1.0,
      // edges [0, 2, 5, 10] + maxValue 100 → buckets:
      //   [0, 2)
      //   [2, 5)
      //   [5, 100]   (right-closed at maxValue)
      distributionEdges: [0n, 2n, 5n, 10n],
      distributionMaxValue: 100n,
    });
    expect(r.mode).toBe('zk-distribution');
    if (r.mode === 'zk-distribution') {
      const v = verifyAttestedHomomorphicDistribution(r.bundle);
      expect(v.valid).toBe(true);
      // 3 buckets (edges.length - 1 = 4 - 1 = 3)
      expect(r.bundle.bucketSumCommitments.length).toBe(3);
      // Concept-taught counts are [4, 2, 1, 6]. Bucketing:
      //   [0, 2): 1   (course par=1)
      //   [2, 5): 2   (golf=2, handicap=4)
      //   [5, 100]: 1 (fault response=6)
      expect(r.bundle.trueBucketCounts).toEqual([1n, 2n, 1n]);
    }
  });

  it('zk-distribution throws when epsilon missing', () => {
    expect(() => coverageQuery({
      config: cfg, coverage: sampleCoverage, privacyMode: 'zk-distribution',
      distributionEdges: [0n, 5n], distributionMaxValue: 100n,
    })).toThrow(/epsilon is required/);
  });

  it('zk-distribution throws when distributionEdges missing', () => {
    expect(() => coverageQuery({
      config: cfg, coverage: sampleCoverage, privacyMode: 'zk-distribution',
      epsilon: 1.0, distributionMaxValue: 100n,
    })).toThrow(/distributionEdges/);
  });
});
