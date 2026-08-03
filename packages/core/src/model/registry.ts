/**
 * @module model/registry
 * @description Open Facet Registry with Merge Strategies
 *
 * Composition operators read merge behavior from this registry
 * instead of hardcoding per-type logic. Third-party facet types
 * can register themselves at module load time.
 *
 * ── WHY EVERY FACET READ BELOW IS GUARDED BY `in` ────────────────────────────
 *
 * Every signature and every field read here was `any` — 23 of them, the largest single
 * cluster left in the repo — with the standing justification that the registry is OPEN, so
 * `executeMerge` and `facetFingerprint` cannot assume the closed `ContextFacetData` union.
 *
 * The openness is real; the conclusion was not. `registerFacetType('MyThing', {
 * unionStrategy: 'convex-hull' })` genuinely routes a foreign facet into the branch written
 * for `TemporalFacetData`, and that facet may carry none of `validFrom` / `validUntil` /
 * `temporalResolution`. But that is exactly what `'validFrom' in f` says, and unlike `any`
 * it says it to the compiler: a field the union does not declare anywhere narrows to
 * `never` and fails to compile, and a field misspelt against the RDF predicate name rather
 * than the TypeScript one is reported at the read. That second case is not hypothetical
 * here — `affordance/engine.ts` reached for `assertingAgent.agentIdentity` (the predicate
 * `iep:agentIdentity`; the property is `identity`) behind exactly this kind of cast, and
 * the branch it guarded had never once been true.
 *
 * The `in` guards are semantics-preserving and not merely type-shaped: `('x' in f ? f.x :
 * undefined)` and `('x' in f ? f.x ?? [] : [])` evaluate identically to the `f.x` and
 * `f.x ?? []` they replace, including for a foreign facet that has no `x`. Nothing here
 * filters by type — a foreign facet still reaches the reducer, still contributes nothing,
 * and still keeps `facets.length` non-zero, so the `length === 0` early-outs behave as
 * before.
 *
 * None of that was under test: `executeMerge` and `registerFacetType` appeared in no test
 * file at all (`tests/registry.test.ts` is the unrelated L2 attestation registry), and the
 * lattice suite reaches these branches only through `union()`/`intersection()` over the
 * nine built-ins. `tests/facet-registry.test.ts` is that suite, written against this
 * refactor and mutation-checked: 33 mutants of the arithmetic and the early-outs below —
 * including "filter the input to the facet type this branch expects", the change the
 * compiler would most like you to make — are each killed by a named assertion.
 */
import type {
  AccessControlFacetData,
  AgentDescription,
  Authorization,
  ContextFacetData,
  IRI,
  ProvenanceFacetData,
} from './types.js';

/**
 * Merge strategies that facets can declare.
 * Composition operators read this from the registry instead of hardcoding per-type logic.
 */
export type MergeStrategy =
  | 'convex-hull'       // temporal: widen to cover both (union)
  | 'intersect-range'   // temporal: narrow to overlap (intersection)
  | 'chain'             // provenance: concatenate chains, merge derivations
  | 'preserve-all'      // keep all facets from both sides (agents, semiotic, federation)
  | 'flatten-set'       // merge into a single facet with combined sets (access control)
  | 'left-wins'         // override: take the overriding value
  | 'highest-confidence' // causal: keep the one with highest causal confidence
  | 'merge-bindings'    // projection: union of bindings and vocabulary mappings
  | 'custom';           // escape hatch for user-defined facets

export interface FacetRegistryEntry {
  /** How this facet merges under union. */
  unionStrategy: MergeStrategy;
  /** How this facet merges under intersection. */
  intersectionStrategy: MergeStrategy;
  /** Optional custom union merge function. */
  unionMerge?: FacetMerge;
  /** Optional custom intersection merge function. */
  intersectionMerge?: FacetMerge;
}

/**
 * The shape of a `'custom'` merge. Named rather than inlined twice because
 * {@link executeMerge}'s `customMerge` parameter has to be the same type as the two fields
 * above and previously was not: all three said `(facets: any[]) => any[]`, which is
 * bivariantly compatible with anything at all, so a registrant whose merge took an argument
 * the operators never pass would have compiled.
 */
export type FacetMerge = (facets: readonly ContextFacetData[]) => ContextFacetData[];

// The global registry — maps facet type name -> merge behavior
const _registry = new Map<string, FacetRegistryEntry>();

export function registerFacetType(type: string, entry: FacetRegistryEntry): void {
  _registry.set(type, entry);
}

export function getFacetEntry(type: string): FacetRegistryEntry | undefined {
  return _registry.get(type);
}

export function getRegisteredTypes(): string[] {
  return [..._registry.keys()];
}

/**
 * Structural fingerprint of a facet for deduplication purposes.
 *
 * Two facets that produce the same fingerprint are treated as the same
 * sign-instance for the purpose of lattice idempotence. This is keyed
 * off the facet `type` plus the substantive identity fields per type:
 *   - Agent:      identity / role / onBehalfOf
 *   - Semiotic:   modalStatus / epistemicConfidence / groundTruth / sign-system
 *   - Trust:      trustLevel / issuer / verifiableCredential / proofMechanism
 *   - Federation: origin / storageEndpoint / endpointURL / syncProtocol / replicaOf
 *   - Causal:     causalModel / causalRole / parentObservation / parentIntervention
 *
 * Falls back to JSON of the full facet for any other shape — so
 * unknown / extension facets dedupe conservatively (structurally-identical
 * payloads collapse; anything else stays distinct).
 */
export function facetFingerprint(f: ContextFacetData): string {
  if (!f || typeof f !== 'object') return JSON.stringify(f);
  switch (f.type) {
    case 'Agent': {
      const ag: AgentDescription = f.assertingAgent ?? {};
      return [
        'Agent',
        ag.id ?? '',
        ag.identity ?? '',
        ag.label ?? '',
        ag.isSoftwareAgent ?? '',
        f.onBehalfOf ?? '',
        f.agentRole ?? '',
      ].join('|');
    }
    case 'Semiotic':
      return [
        'Semiotic',
        f.modalStatus ?? '',
        f.epistemicConfidence ?? '',
        f.groundTruth ?? '',
        f.interpretationFrame ?? '',
        f.signSystem ?? '',
        f.languageTag ?? '',
      ].join('|');
    case 'Trust':
      return [
        'Trust',
        f.trustLevel ?? '',
        f.issuer ?? '',
        f.verifiableCredential ?? '',
        f.proofMechanism ?? '',
        f.revocationStatus ?? '',
      ].join('|');
    case 'Federation':
      return [
        'Federation',
        f.origin ?? '',
        f.storageEndpoint ?? '',
        f.endpointURL ?? '',
        f.syncProtocol ?? '',
        f.replicaOf ?? '',
      ].join('|');
    case 'Causal':
      return [
        'Causal',
        f.causalModel ?? '',
        f.causalRole ?? '',
        f.parentObservation ?? '',
        f.parentIntervention ?? '',
        f.effectSize ?? '',
        f.causalConfidence ?? '',
      ].join('|');
    default:
      return JSON.stringify(f);
  }
}

/**
 * Deduplicate facets by structural fingerprint. Preserves first
 * occurrence order so that union(A, B) keeps A's facets in front.
 *
 * Required for lattice idempotence: union(A, A) must collapse the two
 * copies of each preserve-all facet back to a single instance.
 */
function dedupeByFingerprint(facets: readonly ContextFacetData[]): ContextFacetData[] {
  const seen = new Set<string>();
  const out: ContextFacetData[] = [];
  for (const f of facets) {
    const key = facetFingerprint(f);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

/**
 * Execute the merge strategy for a facet type.
 * Returns the merged facets (may be 0, 1, or many).
 */
// `facets` is deliberately NOT `readonly` here even though nothing in the body mutates it:
// the `default:` arm returns the caller's array by reference, and a `readonly` parameter
// would force a `[...facets]` copy that changes identity for every strategy this switch does
// not name — including `'custom'` registered without a merge function.
export function executeMerge(
  strategy: MergeStrategy,
  facets: ContextFacetData[],
  customMerge?: FacetMerge,
): ContextFacetData[] {
  if (strategy === 'custom' && customMerge) {
    return customMerge(facets);
  }
  switch (strategy) {
    case 'preserve-all':
      // Structural dedupe — facets with identical sign-identity collapse
      // back to one instance. This is what makes union(A, A) ≅ A hold
      // for the preserve-all family (Agent / Semiotic / Trust / Federation /
      // Causal). Distinct facets (different DIDs, different confidences,
      // different storage endpoints) still survive as siblings — modal
      // polyphony is preserved.
      return dedupeByFingerprint(facets);
    case 'left-wins':
      // In override context: take the last (overriding) facets.
      // The `!` is what the length check already established. Written as an assertion
      // rather than as `const last = …; return last ? [last] : []` because those differ:
      // a list whose final element is null or undefined would silently become `[]` under
      // the truthiness form, where this — like the `any` it replaces — still returns it.
      return facets.length > 0 ? [facets[facets.length - 1]!] : [];
    case 'flatten-set':
      // For access control: merge all authorizations into one facet
      if (facets.length === 0) return [];
      // No seed value, deliberately: with a single facet `reduce` never invokes the
      // callback and returns that facet BY REFERENCE, uncopied. Seeding with an empty
      // AccessControl facet would quietly start copying, which changes what callers holding
      // the original object observe.
      return [facets.reduce((acc, f) => ({
        // Cast, not a guard: the spread must carry whatever the accumulated facet actually
        // holds (`consentBasis`, `policyRefs`, and any fields a foreign registrant added),
        // and narrowing it would drop them from the result.
        ...(acc as AccessControlFacetData),
        authorizations: [...authorizationsOf(acc), ...authorizationsOf(f)],
      }))];
    case 'chain':
      // For provenance: concatenate chains
      if (facets.length === 0) return [];
      {
        const derivedFrom = new Set<IRI>();
        for (const f of facets) {
          if ('wasDerivedFrom' in f && f.wasDerivedFrom) {
            for (const d of f.wasDerivedFrom) derivedFrom.add(d);
          }
        }
        const times = facets
          .map(f => ('generatedAtTime' in f ? f.generatedAtTime : undefined))
          .filter(Boolean).sort().reverse();
        const head = facets[0];
        return [{
          type: 'Provenance',
          wasGeneratedBy: head && 'wasGeneratedBy' in head ? head.wasGeneratedBy : undefined,
          wasDerivedFrom: [...derivedFrom],
          generatedAtTime: times[0],
          // The whole input list, unfiltered — a foreign facet routed here by
          // `registerFacetType(t, { unionStrategy: 'chain' })` stays in the chain it was
          // merged into, exactly as before. The assertion admits that and nothing more.
          provenanceChain: facets as readonly ProvenanceFacetData[],
        }];
      }
    case 'convex-hull':
      if (facets.length === 0) return [];
      {
        const froms = facets.map(f => ('validFrom' in f ? f.validFrom : undefined)).filter(Boolean);
        const untils = facets.map(f => ('validUntil' in f ? f.validUntil : undefined)).filter(Boolean);
        const head = facets[0];
        return [{
          type: 'Temporal',
          validFrom: froms.length > 0 ? froms.sort()[0] : undefined,
          validUntil: untils.length > 0 ? untils.sort().reverse()[0] : undefined,
          temporalResolution:
            head && 'temporalResolution' in head ? head.temporalResolution : undefined,
        }];
      }
    case 'intersect-range':
      if (facets.length === 0) return [];
      {
        const iFroms = facets.map(f => ('validFrom' in f ? f.validFrom : undefined)).filter(Boolean);
        const iUntils = facets.map(f => ('validUntil' in f ? f.validUntil : undefined)).filter(Boolean);
        const latestFrom = iFroms.length > 0 ? iFroms.sort().reverse()[0] : undefined;
        const earliestUntil = iUntils.length > 0 ? iUntils.sort()[0] : undefined;
        // ★ The empty-interval test, and the reason none of this may be "tidied" into a
        // typed comparison. `validFrom`/`validUntil` are xsd:dateTime STRINGS and both the
        // sorts above and this `>` are lexicographic on them; swapping in a Date or numeric
        // comparison changes which intervals come back empty. The `&&` chain already
        // narrows both operands to `string`, so this needs no cast at all — the previous
        // `any` bought nothing here and hid that fact.
        if (latestFrom && earliestUntil && latestFrom > earliestUntil) return [];
        return [{
          type: 'Temporal',
          validFrom: latestFrom,
          validUntil: earliestUntil,
        }];
      }
    case 'highest-confidence':
      if (facets.length === 0) return [];
      // Strictly greater-than, so ties keep the EARLIER facet — `reduce` without a seed
      // starts at facets[0] and only replaces `best` on a strict improvement. Preserved
      // verbatim: flipping to `>=` would make union order-dependent among equal
      // confidences and break commutativity in tests/lattice-laws.test.ts.
      return [facets.reduce((best, f) =>
        confidenceOf(f) > confidenceOf(best) ? f : best
      )];
    case 'merge-bindings':
      if (facets.length === 0) return [];
      {
        const allBindings = facets.flatMap(f => ('bindings' in f ? f.bindings ?? [] : []));
        const allMappings =
          facets.flatMap(f => ('vocabularyMappings' in f ? f.vocabularyMappings ?? [] : []));
        const allExposed =
          facets.flatMap(f => ('exposedEntities' in f ? f.exposedEntities ?? [] : []));
        return [{
          type: 'Projection',
          bindings: allBindings.length > 0 ? allBindings : undefined,
          vocabularyMappings: allMappings.length > 0 ? allMappings : undefined,
          exposedEntities: allExposed.length > 0 ? [...new Set(allExposed)] : undefined,
          selective: facets.some(f => 'selective' in f && !!f.selective),
        }];
      }
    default:
      return facets;
  }
}

/**
 * A facet's `authorizations`, or none.
 *
 * `'authorizations' in f ? f.authorizations ?? [] : []` rather than a truthiness test,
 * because those disagree on a facet whose `authorizations` is present but not an array:
 * `?? []` leaves the non-array in place and the spread at the call site throws, which is
 * what the `any` version did. A truthiness test would swallow it and silently merge an
 * access-control facet as if it granted nothing — the failure direction that matters.
 */
function authorizationsOf(f: ContextFacetData): readonly Authorization[] {
  return 'authorizations' in f ? f.authorizations ?? [] : [];
}

/** A facet's `causalConfidence`, defaulting to 0 exactly as `(f.causalConfidence ?? 0)` did. */
function confidenceOf(f: ContextFacetData): number {
  return 'causalConfidence' in f ? f.causalConfidence ?? 0 : 0;
}

// ── Register built-in facets ─────────────────────────────────

registerFacetType('Temporal', {
  unionStrategy: 'convex-hull',
  intersectionStrategy: 'intersect-range',
});
registerFacetType('Provenance', {
  unionStrategy: 'chain',
  intersectionStrategy: 'chain',
});
registerFacetType('Agent', {
  unionStrategy: 'preserve-all',
  intersectionStrategy: 'preserve-all',
});
registerFacetType('AccessControl', {
  unionStrategy: 'flatten-set',
  intersectionStrategy: 'flatten-set',
});
registerFacetType('Semiotic', {
  unionStrategy: 'preserve-all',
  intersectionStrategy: 'preserve-all',
});
registerFacetType('Trust', {
  unionStrategy: 'preserve-all',
  intersectionStrategy: 'preserve-all',
});
registerFacetType('Federation', {
  unionStrategy: 'preserve-all',
  intersectionStrategy: 'preserve-all',
});
registerFacetType('Causal', {
  unionStrategy: 'preserve-all',
  intersectionStrategy: 'preserve-all',
});
registerFacetType('Projection', {
  unionStrategy: 'merge-bindings',
  intersectionStrategy: 'merge-bindings',
});
