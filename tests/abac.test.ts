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
  AccessControlPolicyData,
  ContextDescriptorData,
  ContextFacetData,
  TrustFacetData,
  IRI,
} from '@interego/core';
// ABAC primitives now live in `@interego/abac`; importing directly
// keeps the unprefixed names (`evaluate`, `PolicyContext`) in scope
// without colliding with the PGSL agent-framework's same-named
// exports that `@interego/core` surfaces.
import {
  evaluate,
  evaluateSingle,
  resolveAttributes,
  extractAttribute,
  filterAttributeGraph,
  createDecisionCache,
  defaultValidUntil,
  type PolicyContext,
  type PolicyPredicateShape,
  type AttributeGraph,
  type AmtaTrustFacetData,
} from '@interego/abac';

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

// ★ THESE READ `CryptographicallyVerified`, NOT `HighAssurance`, AND THAT IS THE FIX.
//
// Every fixture below used to carry the registry's ISSUER-STANDING vocabulary
// (`HighAssurance` / `PeerAttested`) in `TrustFacetData.trustLevel`, which holds
// `@interego/core`'s CLAIM-BACKING vocabulary and is pinned by the published SHACL
// shape's `sh:in`. The `as IRI` on each value is what let it through: `IRI` is
// `string & { … }`, so the cast does not convert the literal, it only widens it back to
// `string` — enough to stop tsc comparing it against `TrustLevel`. Four of the seven
// sites were still caught (tsc's assignment check is stricter than its `as`
// comparability check); the other three sat behind a wider `as ContextFacetData[]` on
// the enclosing array and were invisible even to the gate that pinned this file.
//
// The translation is meaning-preserving on both axes: `HighAssurance` → the strongest
// tier the substrate has, `CryptographicallyVerified`; `PeerAttested` on a facet where
// bob or carol vouches for alice → `ThirdPartyAttested`, which spec/architecture.md
// defines as exactly "another agent vouches". Nothing about what these tests exercise
// changes — the evaluator compares strings — but the fixtures are now descriptors the
// system could actually publish. See the note on `TrustLevel` in
// `packages/core/src/model/types.ts` for why this vocabulary is the canonical one.
const highTrustFacet: TrustFacetData = {
  type: 'Trust',
  trustLevel: 'CryptographicallyVerified',
  issuer: 'urn:agent:authority' as IRI,
};
const lowTrustFacet: TrustFacetData = {
  type: 'Trust',
  trustLevel: 'SelfAsserted',
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
    { path: 'iep:trustLevel', minCount: 1, hasValue: 'CryptographicallyVerified' },
  ],
};

const confidentShape: PolicyPredicateShape = {
  iri: 'urn:shape:HighConfidence' as IRI,
  constraints: [
    { path: 'iep:epistemicConfidence', minCount: 1, minInclusive: 0.9 },
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

  // ★ CLAUSE (b) OF `resolveAttributes`, WHICH HAD NEVER RUN. The resolver reads the
  // asserting agent off `AgentDescription.identity`; it used to read `.agentIdentity` —
  // the RDF predicate name — through an inline cast, so the property was always
  // `undefined` and this whole branch was dead. Nothing here failed, because a descriptor
  // skipped by clause (b) is indistinguishable from one that was never eligible.
  //
  // Both directions are pinned. The positive case is the one that was broken; the negative
  // case is what stops a future "simplification" of the identity read from turning the
  // clause into "any descriptor with any Agent facet contributes to anyone's graph".
  it('includes a descriptor because its AgentFacet attributes it to the subject', () => {
    const authoredByAlice: ContextDescriptorData = {
      id: 'urn:desc:alice-authored' as IRI,
      // Deliberately describes something OTHER than alice: clause (a) must not be what
      // admits this, or the test would pass with the resolver still broken.
      describes: ['urn:graph:unrelated' as IRI],
      facets: [
        { type: 'Agent', assertingAgent: { identity: SUBJECT } },
        highTrustFacet,
      ],
    };
    const graph = resolveAttributes(SUBJECT, [authoredByAlice]);
    expect(graph.facets).toHaveLength(2);
    expect(extractAttribute(graph, 'iep:agentIdentity')).toEqual([SUBJECT]);
    expect(extractAttribute(graph, 'iep:trustLevel')).toEqual(['CryptographicallyVerified']);
  });

  it('does NOT include a descriptor whose AgentFacet names a different agent', () => {
    const authoredByMallory: ContextDescriptorData = {
      id: 'urn:desc:mallory-authored' as IRI,
      describes: ['urn:graph:unrelated' as IRI],
      facets: [
        { type: 'Agent', assertingAgent: { identity: 'urn:agent:mallory' as IRI } },
        highTrustFacet,
      ],
    };
    expect(resolveAttributes(SUBJECT, [authoredByMallory]).facets).toHaveLength(0);
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
    expect(extractAttribute(graph, 'iep:trustLevel')).toEqual(['CryptographicallyVerified']);
    expect(extractAttribute(graph, 'iep:epistemicConfidence')).toEqual([0.95]);
    expect(extractAttribute(graph, 'iep:modalStatus')).toEqual(['Asserted']);
  });

  it('extractAttribute reads AMTA-style reputation axes from Trust facets', () => {
    // No cast: `AmtaTrustFacetData` is `TrustFacetData & { amtaAxes? }`, which IS a
    // `ContextFacetData`. The `as ContextFacetData` this replaces was rejected outright
    // by tsc — a fresh literal with an undeclared property is not comparable to the
    // union — and the field it was smuggling in is the one `extractAttribute` reads.
    const trustWithAmta: AmtaTrustFacetData = {
      ...highTrustFacet,
      amtaAxes: { codeQuality: 0.88, trustworthiness: 0.9 },
    };
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

describe('ABAC — filterAttributeGraph (sybil resistance)', () => {
  it('drops facets whose source does not satisfy the predicate', () => {
    const trusted: TrustFacetData = { type: 'Trust', trustLevel: 'CryptographicallyVerified', issuer: 'urn:agent:bob' as IRI };
    const untrusted: TrustFacetData = { type: 'Trust', trustLevel: 'SelfAsserted', issuer: 'urn:agent:sybil' as IRI };
    const trustedSrc = 'urn:desc:bob-signed' as IRI;
    const untrustedSrc = 'urn:desc:sybil-signed' as IRI;
    const graph: AttributeGraph = {
      subject: SUBJECT,
      facets: [trusted, untrusted],
      sources: new Map<ContextFacetData, IRI>([[trusted, trustedSrc], [untrusted, untrustedSrc]]),
    };
    const filtered = filterAttributeGraph(graph, (_f, src) => src === trustedSrc);
    expect(filtered.facets).toHaveLength(1);
    expect(filtered.facets[0]).toBe(trusted);
    expect(filtered.sources.get(trusted)).toBe(trustedSrc);
  });

  it('sybil-flood attack is blocked by issuer-trust filter', () => {
    // Make 5 sybil attestations + 0 real — policy fires without filter,
    // fails with filter.
    // ★ One of the three sites the pinned typecheck error UNDERCOUNTED. `as IRI` on the
    // value plus `as ContextFacetData[]` on the array was two casts deep, and tsc's
    // comparability check passes on the outer one because `TrustLevel` is comparable to
    // the widened `string`. So these carried `PeerAttested` — an issuer-standing token
    // that is not a legal `iep:trustLevel` — with no diagnostic at all.
    const sybilFacets: AmtaTrustFacetData[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'Trust' as const,
      trustLevel: 'ThirdPartyAttested' as const,
      issuer: `urn:agent:sybil${i}` as IRI,
      amtaAxes: { codeQuality: 0.95 + i * 0.005 },
    }));
    const sybilDescs = sybilFacets.map((f, i) => ({
      id: `urn:desc:sybil${i}->alice` as IRI,
      describes: [SUBJECT],
      facets: [f],
    }));
    const highTrustIssuers = new Set<string>(); // empty — no issuer is high-trust
    const graph = resolveAttributes(SUBJECT, sybilDescs);
    expect(graph.facets).toHaveLength(5);

    const qualityShape: PolicyPredicateShape = {
      iri: 'urn:shape:Quality' as IRI,
      constraints: [{ path: 'amta:codeQuality', minCount: 2, minInclusive: 0.8 }],
    };
    const permit: AccessControlPolicyData = {
      id: 'urn:policy:p' as IRI,
      policyPredicateShape: qualityShape.iri,
      governedAction: ACTION,
      deonticMode: 'Permit',
    };
    const preds = new Map([[qualityShape.iri, qualityShape]]);

    // Without filter: attack succeeds
    const attackDecision = evaluate([permit], preds, {
      subject: SUBJECT, subjectAttributes: graph,
      resource: RESOURCE, action: ACTION, now: NOW,
    });
    expect(attackDecision.verdict).toBe('Allowed');

    // With issuer-trust filter: attack blocked
    const filtered = filterAttributeGraph(graph, (f) => {
      const issuer = (f as { issuer?: string }).issuer;
      return issuer ? highTrustIssuers.has(issuer) : false;
    });
    expect(filtered.facets).toHaveLength(0);
    const defendedDecision = evaluate([permit], preds, {
      subject: SUBJECT, subjectAttributes: filtered,
      resource: RESOURCE, action: ACTION, now: NOW,
    });
    expect(defendedDecision.verdict).toBe('Indeterminate');
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
    // Bound to a named `AmtaTrustFacetData` rather than written inline: inside
    // `facets: [...]` the contextual type is `ContextFacetData`, so an object literal
    // there is excess-property-checked against a union that has no `amtaAxes` and a
    // trailing `satisfies` cannot rescue it. Naming the value first is also what makes
    // the assignment into `facets` cast-free — the old `as ContextFacetData` here was
    // erasing the very field the assertions below read back out.
    const bobAxes: AmtaTrustFacetData = {
      type: 'Trust',
      trustLevel: 'ThirdPartyAttested',
      issuer: 'urn:agent:bob' as IRI,
      amtaAxes: { codeQuality: 0.85 },
    };
    const carolAxes: AmtaTrustFacetData = {
      type: 'Trust',
      trustLevel: 'ThirdPartyAttested',
      issuer: 'urn:agent:carol' as IRI,
      amtaAxes: { codeQuality: 0.9 },
    };
    const bobAttestation: ContextDescriptorData = {
      id: 'urn:desc:bob-attests-alice' as IRI,
      describes: [SUBJECT],
      facets: [bobAxes],
    };
    const carolAttestation: ContextDescriptorData = {
      id: 'urn:desc:carol-attests-alice' as IRI,
      describes: [SUBJECT],
      facets: [carolAxes],
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
