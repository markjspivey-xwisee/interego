/**
 * Registry tests — L2 public agent attestation registry.
 *
 * Covers:
 *   - createRegistry / registerAgent / queryEntries
 *   - aggregateReputation: trust-weighted, recency-decayed, axis breakdown
 *   - Self-asserted attestations don't count (default policy)
 *   - federateLookup: cross-registry agent lookup + reputation averaging
 *   - registryToDescriptor produces a valid iep:ContextDescriptor shape
 */

import { describe, it, expect } from 'vitest';
import type {
  IRI,
} from '@interego/core';
import {
  aggregateReputation,
  type AggregationPolicy,
  type AttestationInput,
  createRegistry,
  DEFAULT_AGGREGATION_POLICY,
  federateLookup,
  queryEntries,
  refreshReputation,
  registerAgent,
  registryToDescriptor,
} from '@interego/registry';

const NOW = '2026-04-24T12:00:00Z';

describe('registry — basic ops', () => {
  it('creates a registry with default policy', () => {
    const r = createRegistry({ id: 'urn:registry:test' as IRI, description: 'test' });
    expect(r.entries.size).toBe(0);
    expect(r.policy).toBe(DEFAULT_AGGREGATION_POLICY);
  });

  it('registers an agent + queries return them', () => {
    let r = createRegistry({ id: 'urn:registry:test' as IRI, description: 'test' });
    r = registerAgent(r, {
      agentIdentity: 'urn:agent:alice' as IRI,
      agentPod: 'https://pod.example/alice/',
      capabilities: ['iep:canReviewCode' as IRI],
      now: NOW,
    });
    expect(r.entries.size).toBe(1);
    const entries = queryEntries(r);
    expect(entries[0]?.agentIdentity).toBe('urn:agent:alice');
  });

  it('queryEntries filters by capability', () => {
    let r = createRegistry({ id: 'urn:registry:test' as IRI, description: 'test' });
    r = registerAgent(r, {
      agentIdentity: 'urn:agent:alice' as IRI,
      agentPod: 'p1',
      capabilities: ['iep:canReviewCode' as IRI],
    });
    r = registerAgent(r, {
      agentIdentity: 'urn:agent:bob' as IRI,
      agentPod: 'p2',
      capabilities: ['iep:canTranslate' as IRI],
    });
    expect(queryEntries(r, { hasCapability: 'iep:canReviewCode' as IRI })).toHaveLength(1);
    expect(queryEntries(r, { hasCapability: 'iep:canTranslate' as IRI })).toHaveLength(1);
  });
});

describe('registry — reputation aggregation', () => {
  const ALICE = 'urn:agent:alice' as IRI;

  it('returns null below minContributingAttestations', () => {
    const snapshot = aggregateReputation(ALICE, [], DEFAULT_AGGREGATION_POLICY, NOW);
    expect(snapshot).toBeNull();
  });

  it('aggregates per-axis weighted average', () => {
    const attestations: AttestationInput[] = [
      {
        id: 'urn:att:1' as IRI, issuer: 'urn:agent:bob' as IRI, subject: ALICE,
        axes: { honesty: 0.8, competence: 0.9 }, issuedAt: NOW,
        issuerTrustLevel: 'HighAssurance',
      },
      {
        id: 'urn:att:2' as IRI, issuer: 'urn:agent:carol' as IRI, subject: ALICE,
        axes: { honesty: 0.9, competence: 0.7 }, issuedAt: NOW,
        issuerTrustLevel: 'HighAssurance',
      },
    ];
    const s = aggregateReputation(ALICE, attestations, DEFAULT_AGGREGATION_POLICY, NOW);
    expect(s).not.toBeNull();
    expect(s!.axes.honesty).toBeCloseTo(0.85);
    expect(s!.axes.competence).toBeCloseTo(0.8);
    expect(s!.contributingAttestations).toHaveLength(2);
  });

  it('SelfAsserted attestations are excluded by default policy', () => {
    const attestations: AttestationInput[] = [
      {
        id: 'urn:att:self' as IRI, issuer: ALICE, subject: ALICE,
        axes: { honesty: 1.0 }, issuedAt: NOW,
        issuerTrustLevel: 'SelfAsserted',
      },
    ];
    const s = aggregateReputation(ALICE, attestations, DEFAULT_AGGREGATION_POLICY, NOW);
    // The attestation IS counted as "contributing" (passes minCount) but
    // its trust weight is 0 → no axis values populated.
    expect(s).not.toBeNull();
    expect(Object.keys(s!.axes)).toHaveLength(0);
  });

  it('PeerAttested counts at half weight; recency decays older attestations', () => {
    const oldDate = '2025-04-24T12:00:00Z'; // ~365 days ago
    const newDate = NOW;
    const attestations: AttestationInput[] = [
      {
        id: 'urn:att:old' as IRI, issuer: 'urn:agent:bob' as IRI, subject: ALICE,
        axes: { honesty: 0.5 }, issuedAt: oldDate, issuerTrustLevel: 'PeerAttested',
      },
      {
        id: 'urn:att:new' as IRI, issuer: 'urn:agent:carol' as IRI, subject: ALICE,
        axes: { honesty: 0.95 }, issuedAt: newDate, issuerTrustLevel: 'PeerAttested',
      },
    ];
    const s = aggregateReputation(ALICE, attestations, DEFAULT_AGGREGATION_POLICY, NOW);
    // The old attestation is heavily decayed (~365 days, 90-day half-life
    // means weight ≈ 0.5^4 = 0.0625), so the result skews toward 0.95.
    expect(s!.axes.honesty).toBeGreaterThan(0.85);
    expect(s!.axes.honesty).toBeLessThan(0.95);
  });
});

describe('registry — the aggregate is exact where arithmetic can make it so', () => {
  // The jev-harness policy (applications/_shared/judgment-kit/attestations.ts, reputationPolicy):
  // trust weights 1 / 0.5 / 0.25 and a 30-day half-life.
  const HARNESS: AggregationPolicy = { trustWeights: { HighAssurance: 1, PeerAttested: 0.5, SelfAsserted: 0.25 }, recencyHalfLifeDays: 30, minContributingAttestations: 1, policyId: 'urn:test:harness-reputation' };
  const AGENT = 'urn:agent:harness' as IRI;
  const ISSUED = '2026-09-21T05:00:00Z';
  type Trust = NonNullable<AttestationInput['issuerTrustLevel']>;
  const att = (id: string, axes: Record<string, number>, issuedAt = ISSUED, issuerTrustLevel: Trust = 'PeerAttested'): AttestationInput =>
    ({ id: `urn:att:${id}` as IRI, issuer: 'urn:agent:peer' as IRI, subject: AGENT, axes, issuedAt, issuerTrustLevel });
  /** The weight the aggregator gives an attestation: trust times 0.5^(age in days / 30). */
  const weight = (issuedAt: string, now: string, trust: Trust): number =>
    HARNESS.trustWeights[trust]! * Math.pow(0.5, ((Date.parse(now) - Date.parse(issuedAt)) / (1000 * 60 * 60 * 24)) / HARNESS.recencyHalfLifeDays);
  /** The per-axis arithmetic before this change: Σ(score × w) / Σw, unheld. */
  const plainMean = (terms: ReadonlyArray<readonly [number, number]>): number =>
    terms.reduce((sum, [s, w]) => sum + s * w, 0) / terms.reduce((sum, [, w]) => sum + w, 0);

  it('gives one attestation its own scores, at a moment the plain arithmetic does not', () => {
    const now = '2026-09-26T08:15:09Z';
    // The moment is one the old code got wrong, so the test cannot pass by the clock's luck.
    expect(plainMean([[0.8, weight(ISSUED, now, 'PeerAttested')]])).toBe(0.8000000000000002);
    const s = aggregateReputation(AGENT, [att('one', { competence: 0.8, honesty: 0.8, recency: 1 })], HARNESS, now)!;
    expect(s.axes).toEqual({ competence: 0.8, honesty: 0.8, recency: 1 });
  });

  it('keeps an accuracy of exactly 0.9 at a 0.9 floor, not a hair under it', () => {
    const now = '2026-09-26T08:00:06Z';
    expect(plainMean([[0.9, weight(ISSUED, now, 'PeerAttested')]])).toBe(0.8999999999999999);
    const s = aggregateReputation(AGENT, [att('floor', { accuracy: 0.9 })], HARNESS, now)!;
    expect(s.axes.accuracy).toBe(0.9);
    expect(s.axes.accuracy! >= 0.9).toBe(true);
    expect(s.score).toBe(0.9);
  });

  it('gives attestations that agree their shared score, whatever their ages and trust', () => {
    const now = '2026-09-26T08:00:00Z';
    const older = '2026-09-11T00:00:00Z';
    expect(plainMean([[0.9, weight(ISSUED, now, 'PeerAttested')], [0.9, weight(older, now, 'HighAssurance')]])).toBe(0.8999999999999999);
    const s = aggregateReputation(AGENT, [att('a', { accuracy: 0.9 }), att('b', { accuracy: 0.9 }, older, 'HighAssurance')], HARNESS, now)!;
    expect(s.axes.accuracy).toBe(0.9);
  });

  it('holds the overall score within its axes: three axes of 0.7 average to 0.7', () => {
    expect((0.7 + 0.7 + 0.7) / 3).toBe(0.6999999999999998);
    const s = aggregateReputation(AGENT, [att('three', { accuracy: 0.7, competence: 0.7, honesty: 0.7 })], HARNESS, '2026-09-26T08:15:09Z')!;
    expect(s.score).toBe(0.7);
  });

  it('takes an attestation with any number of axes, without spreading them into arguments (the review of #494)', () => {
    // Past the engine's argument limit (~125,000 in Node): Math.min(...axes) would throw a RangeError.
    const axes = Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`axis-${i}`, 0.5]));
    const s = aggregateReputation(AGENT, [att('wide', axes)], HARNESS, '2026-09-26T08:15:09Z')!;
    expect(Object.keys(s.axes)).toHaveLength(300_000);
    expect(s.score).toBe(0.5);
  });

  it('does not let an attestation too old to weigh anything widen the range', () => {
    const now = '2026-09-26T08:00:06Z';
    const ancient = '1900-01-01T00:00:00Z';
    expect(weight(ancient, now, 'PeerAttested')).toBe(0);
    const s = aggregateReputation(AGENT, [att('floor', { accuracy: 0.9 }), att('ancient', { accuracy: 0.2 }, ancient)], HARNESS, now)!;
    expect(s.axes.accuracy).toBe(0.9);
  });

  it('leaves a mixed mean where it was, between its scores, and gives the same inputs the same snapshot', () => {
    const now = '2026-09-26T08:15:09Z';
    const older = '2026-09-11T00:00:00Z';
    const inputs = [att('lo', { accuracy: 0.7 }), att('hi', { accuracy: 0.95 }, older, 'HighAssurance')];
    const s = aggregateReputation(AGENT, inputs, HARNESS, now)!;
    expect(s.axes.accuracy).toBe(plainMean([[0.7, weight(ISSUED, now, 'PeerAttested')], [0.95, weight(older, now, 'HighAssurance')]]));
    expect(s.axes.accuracy).toBeGreaterThan(0.7);
    expect(s.axes.accuracy).toBeLessThan(0.95);
    expect(aggregateReputation(AGENT, inputs, HARNESS, now)).toEqual(s);
  });
});

describe('registry — refreshReputation', () => {
  it('attaches snapshot to the registered entry', () => {
    let r = createRegistry({ id: 'urn:registry:test' as IRI, description: 'test' });
    const ALICE = 'urn:agent:alice' as IRI;
    r = registerAgent(r, {
      agentIdentity: ALICE, agentPod: 'p',
      capabilities: ['iep:canReviewCode' as IRI],
    });
    const att: AttestationInput = {
      id: 'urn:att:1' as IRI, issuer: 'urn:agent:bob' as IRI, subject: ALICE,
      axes: { honesty: 0.9 }, issuedAt: NOW, issuerTrustLevel: 'HighAssurance',
    };
    r = refreshReputation(r, ALICE, [att], NOW);
    expect(r.entries.get(ALICE)?.reputation?.score).toBeCloseTo(0.9);
  });
});

describe('registry — cross-registry federation', () => {
  it('aggregates an agent\'s listings across multiple registries', () => {
    const ALICE = 'urn:agent:alice' as IRI;
    const att1: AttestationInput = {
      id: 'urn:att:1' as IRI, issuer: 'urn:agent:bob' as IRI, subject: ALICE,
      axes: { honesty: 0.9 }, issuedAt: NOW, issuerTrustLevel: 'HighAssurance',
    };
    const att2: AttestationInput = {
      id: 'urn:att:2' as IRI, issuer: 'urn:agent:carol' as IRI, subject: ALICE,
      axes: { honesty: 0.7 }, issuedAt: NOW, issuerTrustLevel: 'HighAssurance',
    };

    let r1 = createRegistry({ id: 'urn:registry:r1' as IRI, description: 'r1' });
    r1 = registerAgent(r1, { agentIdentity: ALICE, agentPod: 'p', capabilities: [] });
    r1 = refreshReputation(r1, ALICE, [att1], NOW);

    let r2 = createRegistry({ id: 'urn:registry:r2' as IRI, description: 'r2' });
    r2 = registerAgent(r2, { agentIdentity: ALICE, agentPod: 'p', capabilities: [] });
    r2 = refreshReputation(r2, ALICE, [att2], NOW);

    const result = federateLookup(ALICE, [r1, r2]);
    expect(result.listings).toHaveLength(2);
    expect(result.federatedScore).toBeCloseTo(0.8);
  });

  it('returns null score if no listing has reputation', () => {
    const ALICE = 'urn:agent:alice' as IRI;
    let r = createRegistry({ id: 'urn:registry:r' as IRI, description: 'r' });
    r = registerAgent(r, { agentIdentity: ALICE, agentPod: 'p', capabilities: [] });
    const result = federateLookup(ALICE, [r]);
    expect(result.listings).toHaveLength(1);
    expect(result.federatedScore).toBeNull();
  });
});

describe('registry — descriptor serialization', () => {
  it('produces a valid iep:ContextDescriptor shape with all 6 facets', () => {
    const r = createRegistry({ id: 'urn:registry:r' as IRI, description: 'r' });
    const desc = registryToDescriptor(r, 'urn:agent:owner' as IRI);
    expect(desc.id).toBe(r.id);
    expect(desc.facets).toHaveLength(6);
    const facetTypes = desc.facets.map(f => f.type).sort();
    expect(facetTypes).toEqual(['Agent', 'Federation', 'Provenance', 'Semiotic', 'Temporal', 'Trust']);
  });

  it('attributes the registry to the identity that published it, and to nobody else', () => {
    // ★ THE DECISION, NOT JUST THE SHAPE. Four sibling writers were found naming a pod owner as
    // the author of records an agent had composed, and this one was audited alongside them and
    // judged correct: `Registry` carries no operator and no agent, and the single identity this
    // function takes IS whoever is publishing the document. Nothing was asserting that value, so
    // a later sweep could have repointed it at an agent no caller supplies and no test would
    // have noticed. It is asserted now.
    const publisher = 'https://alice.example/profile#me' as IRI;
    const r = createRegistry({ id: 'urn:registry:r' as IRI, description: 'r' });
    const desc = registryToDescriptor(r, publisher);
    const prov = desc.facets.find(f => f.type === 'Provenance') as { wasAttributedTo?: IRI };
    const agent = desc.facets.find(f => f.type === 'Agent') as { assertingAgent?: { identity?: IRI }; onBehalfOf?: IRI };
    expect(prov.wasAttributedTo).toBe(publisher);
    expect(agent.assertingAgent?.identity).toBe(publisher);
    // And no standing delegation is invented for a document that declares none.
    expect(agent.onBehalfOf).toBeUndefined();
  });
});
