/**
 * Registry tests — L2 public agent attestation registry.
 *
 * Covers:
 *   - createRegistry / registerAgent / queryEntries
 *   - aggregateReputation: trust-weighted, recency-decayed, axis breakdown
 *   - Self-asserted attestations don't count (default policy)
 *   - federateLookup: cross-registry agent lookup + reputation averaging
 *   - registryToDescriptor produces a valid cg:ContextDescriptor shape
 */

import { describe, it, expect } from 'vitest';
import type { IRI } from '../src/model/types.js';
import {
  createRegistry,
  registerAgent,
  refreshReputation,
  queryEntries,
  federateLookup,
  aggregateReputation,
  registryToDescriptor,
  DEFAULT_AGGREGATION_POLICY,
  type AttestationInput,
} from '../src/registry/index.js';

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
      capabilities: ['cg:canReviewCode' as IRI],
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
      capabilities: ['cg:canReviewCode' as IRI],
    });
    r = registerAgent(r, {
      agentIdentity: 'urn:agent:bob' as IRI,
      agentPod: 'p2',
      capabilities: ['cg:canTranslate' as IRI],
    });
    expect(queryEntries(r, { hasCapability: 'cg:canReviewCode' as IRI })).toHaveLength(1);
    expect(queryEntries(r, { hasCapability: 'cg:canTranslate' as IRI })).toHaveLength(1);
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

describe('registry — refreshReputation', () => {
  it('attaches snapshot to the registered entry', () => {
    let r = createRegistry({ id: 'urn:registry:test' as IRI, description: 'test' });
    const ALICE = 'urn:agent:alice' as IRI;
    r = registerAgent(r, {
      agentIdentity: ALICE, agentPod: 'p',
      capabilities: ['cg:canReviewCode' as IRI],
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
  it('produces a valid cg:ContextDescriptor shape with all 6 facets', () => {
    const r = createRegistry({ id: 'urn:registry:r' as IRI, description: 'r' });
    const desc = registryToDescriptor(r, 'urn:agent:owner' as IRI);
    expect(desc.id).toBe(r.id);
    expect(desc.facets).toHaveLength(6);
    const facetTypes = desc.facets.map(f => f.type).sort();
    expect(facetTypes).toEqual(['Agent', 'Federation', 'Provenance', 'Semiotic', 'Temporal', 'Trust']);
  });
});
