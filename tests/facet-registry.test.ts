/**
 * Facet registry merge semantics — `registerFacetType` / `getFacetEntry` / `executeMerge`.
 *
 * ★ WHY THIS FILE EXISTS. `packages/core/src/model/registry.ts` carried 23 `any`s, more
 * than any other file in the repo, and the standing argument for keeping them was that
 * the registry is OPEN: a third-party facet type registers its own merge behaviour, so a
 * strategy branch can receive a facet shape that branch was never written for. Replacing
 * the `any`s with `in`-guarded reads over `ContextFacetData` is only safe if that open
 * path keeps behaving identically, and NOTHING exercised it — `grep -rn 'executeMerge'
 * tests/` returned nothing, and `tests/registry.test.ts` is a different registry entirely
 * (the L2 agent attestation one). The lattice-law suite reaches these strategies only
 * through `union()`/`intersection()` over the nine built-in facets, so every foreign-facet
 * path and every early-out below was uncovered.
 *
 * The tests are written as behaviour, not as type assertions: each one fails if the merge
 * arithmetic changes, and several were chosen specifically because the obvious "tidy-up"
 * of the corresponding line changes an answer.
 */

import { describe, it, expect } from 'vitest';
import type {
  AccessControlFacetData,
  ContextFacetData,
  IRI,
  ProjectionFacetData,
  ProvenanceFacetData,
  TemporalFacetData,
} from '@interego/core';
import { executeMerge, getFacetEntry, registerFacetType, getRegisteredTypes } from '@interego/core';

/**
 * A facet type the closed `ContextFacetData` union knows nothing about, registered against
 * the strategies written for the built-ins. This is the whole point of the "open registry"
 * argument, so it is the thing under test rather than a footnote: `foreign()` carries none
 * of `validFrom` / `wasDerivedFrom` / `authorizations` / `bindings` / `causalConfidence`,
 * and the double-cast is how a third-party facet reaches these operators in real code.
 */
function foreign(extra: Record<string, unknown> = {}): ContextFacetData {
  return { type: 'ForeignThing', foreignField: 'x', ...extra } as unknown as ContextFacetData;
}

const temporal = (validFrom?: string, validUntil?: string, res?: string): TemporalFacetData =>
  ({ type: 'Temporal', validFrom, validUntil, temporalResolution: res });

describe('facet registry — registration', () => {
  it('registers a foreign facet type and hands its entry back', () => {
    registerFacetType('ForeignThing', {
      unionStrategy: 'convex-hull',
      intersectionStrategy: 'intersect-range',
    });
    expect(getFacetEntry('ForeignThing')?.unionStrategy).toBe('convex-hull');
    expect(getRegisteredTypes()).toContain('ForeignThing');
    // The nine built-ins registered at module load are still there.
    expect(getRegisteredTypes()).toEqual(expect.arrayContaining([
      'Temporal', 'Provenance', 'Agent', 'AccessControl',
      'Semiotic', 'Trust', 'Federation', 'Causal', 'Projection',
    ]));
  });

  it('reports undefined for a type nobody registered', () => {
    expect(getFacetEntry('NeverRegistered')).toBeUndefined();
  });
});

describe('facet registry — convex-hull (union of temporal intervals)', () => {
  it('widens to cover both intervals and keeps the first resolution', () => {
    const out = executeMerge('convex-hull', [
      temporal('2026-03-01T00:00:00Z', '2026-03-10T00:00:00Z', 'P1D'),
      temporal('2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z', 'PT1H'),
    ]) as TemporalFacetData[];
    expect(out).toHaveLength(1);
    expect(out[0]?.validFrom).toBe('2026-02-01T00:00:00Z');   // earliest
    expect(out[0]?.validUntil).toBe('2026-04-01T00:00:00Z');  // latest
    expect(out[0]?.temporalResolution).toBe('P1D');           // facets[0], not the widest
  });

  it('returns [] for an empty list, and a bounds-free facet for a foreign one', () => {
    expect(executeMerge('convex-hull', [])).toEqual([]);
    // ★ NOT []. A foreign facet contributes no bounds but still makes the list non-empty,
    // so the hull is a Temporal facet with everything undefined. Filtering the input by
    // facet type — the tempting way to satisfy the compiler — would collapse this to []
    // and silently drop a facet from the composition.
    const out = executeMerge('convex-hull', [foreign()]) as TemporalFacetData[];
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('Temporal');
    expect(out[0]?.validFrom).toBeUndefined();
    expect(out[0]?.validUntil).toBeUndefined();
  });

  it('ignores a foreign facet mixed in with a real one rather than throwing', () => {
    const out = executeMerge('convex-hull', [
      temporal('2026-03-01T00:00:00Z', '2026-03-10T00:00:00Z'),
      foreign(),
    ]) as TemporalFacetData[];
    expect(out[0]?.validFrom).toBe('2026-03-01T00:00:00Z');
    expect(out[0]?.validUntil).toBe('2026-03-10T00:00:00Z');
  });

  it('drops a half-open bound instead of letting undefined win the sort', () => {
    const out = executeMerge('convex-hull', [
      temporal('2026-03-01T00:00:00Z', undefined),
      temporal('2026-02-01T00:00:00Z', '2026-04-01T00:00:00Z'),
    ]) as TemporalFacetData[];
    expect(out[0]?.validFrom).toBe('2026-02-01T00:00:00Z');
    expect(out[0]?.validUntil).toBe('2026-04-01T00:00:00Z');
  });
});

describe('facet registry — intersect-range (meet of temporal intervals)', () => {
  it('narrows to the overlap', () => {
    const out = executeMerge('intersect-range', [
      temporal('2026-02-01T00:00:00Z', '2026-03-10T00:00:00Z'),
      temporal('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'),
    ]) as TemporalFacetData[];
    expect(out[0]?.validFrom).toBe('2026-03-01T00:00:00Z');   // latest start
    expect(out[0]?.validUntil).toBe('2026-03-10T00:00:00Z');  // earliest end
  });

  it('★ returns NO facet when the intervals do not overlap', () => {
    // The empty-interval test is a lexicographic `>` on two xsd:dateTime STRINGS. It is the
    // one comparison in the file whose result changes if the strings are parsed into Dates
    // or compared numerically, which is why it is pinned by value.
    expect(executeMerge('intersect-range', [
      temporal('2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z'),
      temporal('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    ])).toEqual([]);
  });

  it('keeps a zero-width interval — the bound is inclusive', () => {
    const out = executeMerge('intersect-range', [
      temporal('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z'),
      temporal('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'),
    ]) as TemporalFacetData[];
    expect(out).toHaveLength(1);
    expect(out[0]?.validFrom).toBe('2026-03-01T00:00:00Z');
    expect(out[0]?.validUntil).toBe('2026-03-01T00:00:00Z');
  });

  it('returns [] for an empty list and an unbounded facet for a foreign one', () => {
    expect(executeMerge('intersect-range', [])).toEqual([]);
    const out = executeMerge('intersect-range', [foreign()]) as TemporalFacetData[];
    expect(out).toHaveLength(1);
    expect(out[0]?.validFrom).toBeUndefined();
  });
});

describe('facet registry — chain (provenance)', () => {
  const prov = (
    derived: string[], at?: string, by?: { id?: string },
  ): ProvenanceFacetData => ({
    type: 'Provenance',
    wasDerivedFrom: derived as IRI[],
    generatedAtTime: at,
    wasGeneratedBy: by as ProvenanceFacetData['wasGeneratedBy'],
  });

  it('unions wasDerivedFrom, takes the LATEST time, and the FIRST activity', () => {
    const a = prov(['urn:a', 'urn:b'], '2026-01-01T00:00:00Z', { id: 'urn:act:first' });
    const b = prov(['urn:b', 'urn:c'], '2026-05-01T00:00:00Z', { id: 'urn:act:second' });
    const out = executeMerge('chain', [a, b]) as ProvenanceFacetData[];
    expect(out).toHaveLength(1);
    expect([...out[0]!.wasDerivedFrom!].sort()).toEqual(['urn:a', 'urn:b', 'urn:c']);
    expect(out[0]?.generatedAtTime).toBe('2026-05-01T00:00:00Z');
    expect(out[0]?.wasGeneratedBy?.id).toBe('urn:act:first');
    expect(out[0]?.provenanceChain).toEqual([a, b]);
  });

  it('★ keeps a foreign facet IN the chain it was merged into', () => {
    const a = prov(['urn:a'], '2026-01-01T00:00:00Z');
    const f = foreign();
    const out = executeMerge('chain', [a, f]) as ProvenanceFacetData[];
    expect(out[0]?.wasDerivedFrom).toEqual(['urn:a']);
    expect(out[0]?.generatedAtTime).toBe('2026-01-01T00:00:00Z');
    // The chain records what was merged, not what was understood.
    expect(out[0]?.provenanceChain).toHaveLength(2);
    expect(out[0]?.provenanceChain?.[1]).toBe(f);
  });

  it('takes wasGeneratedBy from facets[0] even when facets[0] has none', () => {
    const out = executeMerge('chain', [
      prov(['urn:a'], '2026-01-01T00:00:00Z'),
      prov(['urn:b'], '2026-02-01T00:00:00Z', { id: 'urn:act:later' }),
    ]) as ProvenanceFacetData[];
    expect(out[0]?.wasGeneratedBy).toBeUndefined();
  });

  it('returns [] for an empty list', () => {
    expect(executeMerge('chain', [])).toEqual([]);
  });
});

describe('facet registry — flatten-set (access control)', () => {
  const acl = (...agents: string[]): AccessControlFacetData => ({
    type: 'AccessControl',
    authorizations: agents.map(a => ({ agent: a as IRI, mode: ['Read' as const] })),
  });

  it('concatenates authorizations across facets, preserving duplicates', () => {
    const out = executeMerge('flatten-set', [
      acl('urn:alice'), acl('urn:bob'), acl('urn:alice'),
    ]) as AccessControlFacetData[];
    expect(out).toHaveLength(1);
    expect(out[0]?.authorizations.map(a => a.agent))
      .toEqual(['urn:alice', 'urn:bob', 'urn:alice']);
  });

  it('★ returns the SINGLE input facet by reference, uncopied', () => {
    // `reduce` with no seed never invokes the callback for a one-element list. Seeding it
    // with an empty AccessControl facet — the natural way to make the accumulator typed —
    // would start returning a copy, and callers comparing facet identity (composition.ts
    // dedupes on it) would stop seeing a match.
    const only = acl('urn:alice');
    expect(executeMerge('flatten-set', [only])[0]).toBe(only);
  });

  it('carries non-authorization fields through from the accumulated facet', () => {
    const withConsent: AccessControlFacetData = {
      type: 'AccessControl',
      authorizations: [{ agent: 'urn:alice' as IRI, mode: ['Read'] }],
      consentBasis: 'urn:consent:gdpr-6-1-a' as IRI,
    };
    const out = executeMerge('flatten-set', [withConsent, acl('urn:bob')]) as AccessControlFacetData[];
    expect(out[0]?.consentBasis).toBe('urn:consent:gdpr-6-1-a');
    expect(out[0]?.authorizations).toHaveLength(2);
  });

  it('★ treats a foreign facet as granting nothing, without dropping the others', () => {
    const out = executeMerge('flatten-set', [acl('urn:alice'), foreign()]) as AccessControlFacetData[];
    expect(out).toHaveLength(1);
    expect(out[0]?.authorizations.map(a => a.agent)).toEqual(['urn:alice']);
  });

  it('returns [] for an empty list', () => {
    expect(executeMerge('flatten-set', [])).toEqual([]);
  });
});

describe('facet registry — highest-confidence', () => {
  const causal = (c?: number, tag?: string): ContextFacetData =>
    ({ type: 'Causal', causalRole: 'Observation', causalConfidence: c, causalModel: tag as IRI });

  it('keeps the most confident facet', () => {
    const best = causal(0.9, 'urn:m:best');
    const out = executeMerge('highest-confidence', [causal(0.2, 'urn:m:a'), best, causal(0.5, 'urn:m:b')]);
    expect(out).toEqual([best]);
  });

  it('★ a tie keeps the EARLIER facet', () => {
    // Strictly `>`, so equal confidences never displace the incumbent. Relaxing it to `>=`
    // makes the result depend on operand order, which breaks union commutativity.
    const first = causal(0.7, 'urn:m:first');
    const second = causal(0.7, 'urn:m:second');
    expect(executeMerge('highest-confidence', [first, second])).toEqual([first]);
    expect(executeMerge('highest-confidence', [second, first])).toEqual([second]);
  });

  it('treats a missing or foreign confidence as 0', () => {
    const scored = causal(0.1, 'urn:m:scored');
    expect(executeMerge('highest-confidence', [causal(undefined), scored])).toEqual([scored]);
    expect(executeMerge('highest-confidence', [foreign(), scored])).toEqual([scored]);
    // …and with nothing to beat 0, the first facet still comes back.
    const f = foreign();
    expect(executeMerge('highest-confidence', [f, causal(undefined)])).toEqual([f]);
  });

  it('returns [] for an empty list', () => {
    expect(executeMerge('highest-confidence', [])).toEqual([]);
  });
});

describe('facet registry — merge-bindings (projection)', () => {
  const proj = (over: Partial<ProjectionFacetData> = {}): ProjectionFacetData =>
    ({ type: 'Projection', ...over });

  it('unions bindings and mappings, DEDUPES exposed entities, ORs selective', () => {
    const out = executeMerge('merge-bindings', [
      proj({
        bindings: [{ source: 'urn:s1' as IRI, target: 'urn:t1' as IRI, strength: 'Exact' }],
        vocabularyMappings: [{
          source: 'urn:p1' as IRI, target: 'urn:q1' as IRI,
          mappingType: 'property', relationship: 'exact',
        }],
        exposedEntities: ['urn:e1', 'urn:e2'] as IRI[],
        selective: false,
      }),
      proj({
        bindings: [{ source: 'urn:s2' as IRI, target: 'urn:t2' as IRI, strength: 'Weak' }],
        exposedEntities: ['urn:e2', 'urn:e3'] as IRI[],
        selective: true,
      }),
    ]) as ProjectionFacetData[];
    expect(out[0]?.bindings).toHaveLength(2);
    expect(out[0]?.vocabularyMappings).toHaveLength(1);
    // Bindings are NOT deduped; exposed entities are.
    expect(out[0]?.exposedEntities).toEqual(['urn:e1', 'urn:e2', 'urn:e3']);
    expect(out[0]?.selective).toBe(true);
  });

  it('leaves empty collections undefined rather than emitting empty arrays', () => {
    const out = executeMerge('merge-bindings', [proj(), foreign()]) as ProjectionFacetData[];
    expect(out).toHaveLength(1);
    expect(out[0]?.bindings).toBeUndefined();
    expect(out[0]?.vocabularyMappings).toBeUndefined();
    expect(out[0]?.exposedEntities).toBeUndefined();
    expect(out[0]?.selective).toBe(false);
  });

  it('returns [] for an empty list', () => {
    expect(executeMerge('merge-bindings', [])).toEqual([]);
  });
});

describe('facet registry — preserve-all, left-wins, custom, fallthrough', () => {
  const agent = (identity: string, label?: string): ContextFacetData =>
    ({ type: 'Agent', assertingAgent: { identity: identity as IRI, label } });

  it('preserve-all collapses fingerprint-identical facets and keeps distinct ones', () => {
    const out = executeMerge('preserve-all', [
      agent('did:ex:alice'), agent('did:ex:alice'), agent('did:ex:bob'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('★ preserve-all keys on identity, not on object identity or on unrelated fields', () => {
    // The fingerprint reads `assertingAgent.identity` — the TypeScript property. The RDF
    // predicate is `iep:agentIdentity`, and reaching for THAT name behind a cast is exactly
    // the defect that sat unnoticed in affordance/engine.ts. Two agents differing only in
    // identity must not collapse.
    expect(executeMerge('preserve-all', [agent('did:ex:alice'), agent('did:ex:bob')]))
      .toHaveLength(2);
    // …while a purely cosmetic difference outside the fingerprint fields does collapse.
    expect(executeMerge('preserve-all', [
      { type: 'Trust', issuer: 'did:ex:ca' as IRI, trustLevel: 'CryptographicallyVerified' },
      { type: 'Trust', issuer: 'did:ex:ca' as IRI, trustLevel: 'CryptographicallyVerified' },
    ])).toHaveLength(1);
  });

  it('preserve-all dedupes foreign facets structurally via the JSON fallback', () => {
    expect(executeMerge('preserve-all', [foreign(), foreign()])).toHaveLength(1);
    expect(executeMerge('preserve-all', [foreign(), foreign({ foreignField: 'y' })]))
      .toHaveLength(2);
  });

  it('left-wins takes the LAST facet', () => {
    const last = temporal('2026-09-01T00:00:00Z');
    expect(executeMerge('left-wins', [temporal('2026-01-01T00:00:00Z'), last])).toEqual([last]);
    expect(executeMerge('left-wins', [])).toEqual([]);
  });

  it('custom delegates to the supplied merge function', () => {
    const only = temporal('2026-01-01T00:00:00Z');
    const out = executeMerge('custom', [only, temporal('2026-02-01T00:00:00Z')], () => [only]);
    expect(out).toEqual([only]);
  });

  it("★ 'custom' with NO merge function returns the input array itself, by reference", () => {
    // The fallthrough arm. Returning `[...facets]` instead would be invisible to every
    // assertion above and still change what a caller holding the array observes.
    const input: ContextFacetData[] = [temporal('2026-01-01T00:00:00Z'), foreign()];
    expect(executeMerge('custom', input)).toBe(input);
  });
});
