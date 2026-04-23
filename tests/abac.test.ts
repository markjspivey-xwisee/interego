/**
 * ABAC evaluator + attribute resolver + cache tests.
 *
 * Covers:
 *   - Permit / Deny / Duty single-policy evaluation
 *   - Deny-overrides-Permit composition
 *   - Duty accumulation
 *   - Action-gating (policy doesn't apply to wrong action)
 *   - Predicate constraint failure → Indeterminate (not Denied)
 *   - Attribute resolver: facets from multiple descriptors
 *   - Attribute resolver: cross-pod AMTA attestations aggregate
 *   - Decision cache: hit, miss, stale-expiry
 */

import { describe, it, expect } from 'vitest';
import type {
  IRI,
  AccessControlPolicyData,
  ContextDescriptorData,
  ContextFacetData,
} from '../src/model/types.js';
import {
  evaluate,
  evaluateSingle,
  resolveAttributes,
  extractAttribute,
  createDecisionCache,
  defaultValidUntil,
  type PolicyContext,
  type PolicyPredicateShape,
  type AttributeGraph,
} from '../src/abac/index.js';

// ── Fixtures ─────────────────────────────────────────────────

const NOW = '2026-04-23T12:00:00Z';
const SUBJECT: IRI = 'urn:agent:alice' as IRI;
const RESOURCE: IRI = 'urn:resource:sensitive-report' as IRI;
const ACTION: IRI = 'urn:action:read' as IRI;

function makeAttributeGraph(facets: ContextFacetData[]): AttributeGraph {
  const sources = new Map<ContextFacetData, IRI>();
  for (const f of facets) sources.set(f, 'urn:src:test' as IRI);
  return { subject: SUBJECT, facets, sources };
}

function makeContext(attrs: AttributeGraph, action: IRI = ACTION): PolicyContext {
  return {
    subject: SUBJECT,
    subjectAttributes: attrs,
    resource: RESOURCE,
    action,
    now: NOW,
  };
}

const highTrustFacet: ContextFacetData = {
  type: 'Trust',
  trustLevel: 'HighAssurance' as IRI,
  issuer: 'urn:agent:authority' as IRI,
};
const lowTrustFacet: ContextFacetData = {
  type: 'Trust',
  trustLevel: 'SelfAsserted' as IRI,
  issuer: 'urn:agent:alice' as IRI,
};
const assertedSemioticFacet: ContextFacetData = {
  type: 'Semiotic',
  modalStatus: 'Asserted',
  groundTruth: true,
  epistemicConfidence: 0.95,
};

// ── Predicate shapes ─────────────────────────────────────────

const highTrustShape: PolicyPredicateShape = {
  iri: 'urn:shape:HighTrust' as IRI,
  constraints: [
    { path: 'cg:trustLevel', minCount: 1, hasValue: 'HighAssurance' },
  ],
};

const confidentShape: PolicyPredicateShape = {
  iri: 'urn:shape:HighConfidence' as IRI,
  constraints: [
    { path: 'cg:epistemicConfidence', minCount: 1, minInclusive: 0.9 },
  ],
};

// ── Policies ─────────────────────────────────────────────────

const permitIfHighTrust: AccessControlPolicyData = {
  id: 'urn:policy:permit-high-trust' as IRI,
  policyPredicateShape: highTrustShape.iri,
  governedAction: ACTION,
  deonticMode: 'Permit',
};

const denyIfHighTrust: AccessControlPolicyData = {
  id: 'urn:policy:deny-high-trust' as IRI,
  policyPredicateShape: highTrustShape.iri,
  governedAction: ACTION,
  deonticMode: 'Deny',
};

const dutyIfConfident: AccessControlPolicyData = {
  id: 'urn:policy:duty-confidence' as IRI,
  policyPredicateShape: confidentShape.iri,
  governedAction: ACTION,
  deonticMode: 'Duty',
  duties: ['log-access', 'notify-owner'],
};

const predicates = new Map<IRI, PolicyPredicateShape>([
  [highTrustShape.iri, highTrustShape],
  [confidentShape.iri, confidentShape],
]);

// ── Tests ────────────────────────────────────────────────────

describe('ABAC evaluator — single policy', () => {
  it('Permit mode → Allowed when predicate satisfied', () => {
    const ctx = makeContext(makeAttributeGraph([highTrustFacet]));
    const r = evaluateSingle(permitIfHighTrust, highTrustShape, ctx);
    expect(r.applies).toBe(true);
    expect(r.verdict).toBe('Allowed');
    expect(r.duties).toEqual([]);
  });

  it('Permit mode → does not apply when predicate fails (not Denied)', () => {
    const ctx = makeContext(makeAttributeGraph([lowTrustFacet]));
    const r = evaluateSingle(permitIfHighTrust, highTrustShape, ctx);
    expect(r.applies).toBe(false);
    expect(r.verdict).toBe('Indeterminate');
    expect(r.reason).toMatch(/did not satisfy/);
  });

  it('Deny mode → Denied when predicate satisfied', () => {
    const ctx = makeContext(makeAttributeGraph([highTrustFacet]));
    const r = evaluateSingle(denyIfHighTrust, highTrustShape, ctx);
    expect(r.verdict).toBe('Denied');
  });

  it('Duty mode → Allowed + duties accumulated', () => {
    const ctx = makeContext(makeAttributeGraph([assertedSemioticFacet]));
    const r = evaluateSingle(dutyIfConfident, confidentShape, ctx);
    expect(r.verdict).toBe('Allowed');
    expect(r.duties).toEqual(['log-access', 'notify-owner']);
  });

  it('policy with non-matching action is skipped', () => {
    const ctx = makeContext(makeAttributeGraph([highTrustFacet]), 'urn:action:write' as IRI);
    const r = evaluateSingle(permitIfHighTrust, highTrustShape, ctx);
    expect(r.applies).toBe(false);
    expect(r.reason).toMatch(/not urn:action:write/);
  });
});

describe('ABAC evaluator — multi-policy composition', () => {
  it('Deny overrides Permit when both match', () => {
    const ctx = makeContext(makeAttributeGraph([highTrustFacet]));
    const r = evaluate([permitIfHighTrust, denyIfHighTrust], predicates, ctx);
    expect(r.verdict).toBe('Denied');
    expect(r.matchedPolicies).toContain(denyIfHighTrust.id);
  });

  it('no matching policies → Indeterminate (not Denied)', () => {
    // Low trust + no confidence facet → neither policy's predicate matches.
    const ctx = makeContext(makeAttributeGraph([lowTrustFacet]));
    const r = evaluate([permitIfHighTrust, dutyIfConfident], predicates, ctx);
    expect(r.verdict).toBe('Indeterminate');
    expect(r.matchedPolicies).toEqual([]);
  });

  it('Permit + Duty accumulate duties', () => {
    const ctx = makeContext(makeAttributeGraph([highTrustFacet, assertedSemioticFacet]));
    const r = evaluate([permitIfHighTrust, dutyIfConfident], predicates, ctx);
    expect(r.verdict).toBe('Allowed');
    expect(r.duties).toEqual(expect.arrayContaining(['log-access', 'notify-owner']));
  });

  it('decidedAt reflects the context timestamp', () => {
    const ctx = makeContext(makeAttributeGraph([highTrustFacet]));
    const r = evaluate([permitIfHighTrust], predicates, ctx);
    expect(r.decidedAt).toBe(NOW);
  });
});

describe('ABAC attribute resolver', () => {
  it('aggregates facets across multiple descriptors about the subject', () => {
    const d1: ContextDescriptorData = {
      id: 'urn:desc:1' as IRI,
      describes: [SUBJECT as unknown as IRI],
      facets: [highTrustFacet],
    };
    const d2: ContextDescriptorData = {
      id: 'urn:desc:2' as IRI,
      describes: [SUBJECT as unknown as IRI],
      facets: [assertedSemioticFacet],
    };
    const graph = resolveAttributes(SUBJECT, [d1, d2]);
    expect(graph.facets).toHaveLength(2);
    expect(graph.sources.get(highTrustFacet)).toBe(d1.id);
    expect(graph.sources.get(assertedSemioticFacet)).toBe(d2.id);
  });

  it('skips descriptors that do not describe or attribute to the subject', () => {
    const unrelated: ContextDescriptorData = {
      id: 'urn:desc:unrelated' as IRI,
      describes: ['urn:other:entity' as IRI],
      facets: [highTrustFacet],
    };
    const graph = resolveAttributes(SUBJECT, [unrelated]);
    expect(graph.facets).toHaveLength(0);
  });

  it('extractAttribute reads semiotic and trust paths correctly', () => {
    const graph = makeAttributeGraph([highTrustFacet, assertedSemioticFacet]);
    expect(extractAttribute(graph, 'cg:trustLevel')).toEqual(['HighAssurance']);
    expect(extractAttribute(graph, 'cg:epistemicConfidence')).toEqual([0.95]);
    expect(extractAttribute(graph, 'cg:modalStatus')).toEqual(['Asserted']);
  });

  it('extractAttribute reads AMTA-style reputation axes from Trust facets', () => {
    const trustWithAmta = {
      ...highTrustFacet,
      amtaAxes: { codeQuality: 0.88, trustworthiness: 0.9 },
    } as ContextFacetData;
    const graph = makeAttributeGraph([trustWithAmta]);
    expect(extractAttribute(graph, 'amta:codeQuality')).toEqual([0.88]);
    expect(extractAttribute(graph, 'amta:trustworthiness')).toEqual([0.9]);
    expect(extractAttribute(graph, 'amta:notAnAxis')).toEqual([]);
  });
});

describe('ABAC decision cache', () => {
  it('returns null on miss', () => {
    const cache = createDecisionCache();
    expect(cache.get(SUBJECT, RESOURCE, ACTION, NOW)).toBeNull();
  });

  it('returns decision on hit within validity window', () => {
    const cache = createDecisionCache();
    const decision = {
      verdict: 'Allowed' as const,
      duties: [],
      reason: 'test',
      matchedPolicies: [],
      decidedAt: NOW,
    };
    cache.set({
      subject: SUBJECT, resource: RESOURCE, action: ACTION,
      decision, issuer: 'urn:agent:evaluator' as IRI,
      validUntil: defaultValidUntil(NOW, 3600),
    });
    const retrieved = cache.get(SUBJECT, RESOURCE, ACTION, NOW);
    expect(retrieved).toEqual(decision);
  });

  it('returns null after validity window expires', () => {
    const cache = createDecisionCache();
    const decision = {
      verdict: 'Allowed' as const,
      duties: [],
      reason: 'test',
      matchedPolicies: [],
      decidedAt: NOW,
    };
    cache.set({
      subject: SUBJECT, resource: RESOURCE, action: ACTION,
      decision, issuer: 'urn:agent:evaluator' as IRI,
      validUntil: '2026-04-23T12:00:01Z', // 1 second later
    });
    const future = '2026-04-23T13:00:00Z';
    expect(cache.get(SUBJECT, RESOURCE, ACTION, future)).toBeNull();
  });

  it('size reflects cached entries', () => {
    const cache = createDecisionCache();
    expect(cache.size()).toBe(0);
    cache.set({
      subject: SUBJECT, resource: RESOURCE, action: ACTION,
      decision: { verdict: 'Allowed', duties: [], reason: '', matchedPolicies: [], decidedAt: NOW },
      issuer: 'urn:agent:x' as IRI,
      validUntil: defaultValidUntil(NOW, 60),
    });
    expect(cache.size()).toBe(1);
  });
});

describe('ABAC — cross-pod attribute scenario', () => {
  it('aggregates AMTA attestations from multiple sources into one subject graph', () => {
    // Scenario: alice's own pod asserts baseline trust.
    // Two peer pods have each issued AMTA-style attestations about
    // alice on the "codeQuality" axis. The resolver aggregates
    // everything that describes alice.
    const aliceSelfAssertion: ContextDescriptorData = {
      id: 'urn:desc:alice-self' as IRI,
      describes: [SUBJECT],
      facets: [lowTrustFacet],
    };
    const bobAttestation: ContextDescriptorData = {
      id: 'urn:desc:bob-attests-alice' as IRI,
      describes: [SUBJECT],
      facets: [{
        type: 'Trust',
        trustLevel: 'PeerAttested' as IRI,
        issuer: 'urn:agent:bob' as IRI,
        amtaAxes: { codeQuality: 0.85 },
      } as ContextFacetData],
    };
    const carolAttestation: ContextDescriptorData = {
      id: 'urn:desc:carol-attests-alice' as IRI,
      describes: [SUBJECT],
      facets: [{
        type: 'Trust',
        trustLevel: 'PeerAttested' as IRI,
        issuer: 'urn:agent:carol' as IRI,
        amtaAxes: { codeQuality: 0.9 },
      } as ContextFacetData],
    };
    const graph = resolveAttributes(SUBJECT, [aliceSelfAssertion, bobAttestation, carolAttestation]);
    expect(graph.facets).toHaveLength(3);
    const qualityScores = extractAttribute(graph, 'amta:codeQuality');
    expect(qualityScores).toEqual(expect.arrayContaining([0.85, 0.9]));

    // A policy requiring codeQuality ≥ 0.8 should match
    const qualityShape: PolicyPredicateShape = {
      iri: 'urn:shape:CodeQualityMin' as IRI,
      constraints: [
        { path: 'amta:codeQuality', minCount: 1, minInclusive: 0.8 },
      ],
    };
    const permit: AccessControlPolicyData = {
      id: 'urn:policy:permit-quality' as IRI,
      policyPredicateShape: qualityShape.iri,
      governedAction: ACTION,
      deonticMode: 'Permit',
    };
    const ctx: PolicyContext = {
      subject: SUBJECT, subjectAttributes: graph,
      resource: RESOURCE, action: ACTION, now: NOW,
    };
    const r = evaluate(
      [permit],
      new Map([[qualityShape.iri, qualityShape]]),
      ctx,
    );
    expect(r.verdict).toBe('Allowed');
  });
});
