/**
 * @module model/registry
 * @description Open Facet Registry with Merge Strategies
 *
 * Composition operators read merge behavior from this registry
 * instead of hardcoding per-type logic. Third-party facet types
 * can register themselves at module load time.
 */

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
  unionMerge?: (facets: any[]) => any[];
  /** Optional custom intersection merge function. */
  intersectionMerge?: (facets: any[]) => any[];
}

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
function facetFingerprint(f: any): string {
  if (!f || typeof f !== 'object') return JSON.stringify(f);
  switch (f.type) {
    case 'Agent': {
      const ag = f.assertingAgent ?? {};
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
function dedupeByFingerprint(facets: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
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
export function executeMerge(
  strategy: MergeStrategy,
  facets: any[],
  customMerge?: (facets: any[]) => any[],
): any[] {
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
      // In override context: take the last (overriding) facets
      return facets.length > 0 ? [facets[facets.length - 1]] : [];
    case 'flatten-set':
      // For access control: merge all authorizations into one facet
      if (facets.length === 0) return [];
      return [facets.reduce((acc, f) => ({
        ...acc,
        authorizations: [...(acc.authorizations ?? []), ...(f.authorizations ?? [])],
      }))];
    case 'chain':
      // For provenance: concatenate chains
      if (facets.length === 0) return [];
      {
        const derivedFrom = new Set<string>();
        for (const f of facets) {
          if (f.wasDerivedFrom) for (const d of f.wasDerivedFrom) derivedFrom.add(d);
        }
        const times = facets.map((f: any) => f.generatedAtTime).filter(Boolean).sort().reverse();
        return [{
          type: 'Provenance',
          wasGeneratedBy: facets[0]?.wasGeneratedBy,
          wasDerivedFrom: [...derivedFrom],
          generatedAtTime: times[0],
          provenanceChain: facets,
        }];
      }
    case 'convex-hull':
      if (facets.length === 0) return [];
      {
        const froms = facets.map((f: any) => f.validFrom).filter(Boolean);
        const untils = facets.map((f: any) => f.validUntil).filter(Boolean);
        return [{
          type: 'Temporal',
          validFrom: froms.length > 0 ? froms.sort()[0] : undefined,
          validUntil: untils.length > 0 ? untils.sort().reverse()[0] : undefined,
          temporalResolution: facets[0]?.temporalResolution,
        }];
      }
    case 'intersect-range':
      if (facets.length === 0) return [];
      {
        const iFroms = facets.map((f: any) => f.validFrom).filter(Boolean);
        const iUntils = facets.map((f: any) => f.validUntil).filter(Boolean);
        const latestFrom = iFroms.length > 0 ? iFroms.sort().reverse()[0] : undefined;
        const earliestUntil = iUntils.length > 0 ? iUntils.sort()[0] : undefined;
        if (latestFrom && earliestUntil && latestFrom > earliestUntil) return [];
        return [{
          type: 'Temporal',
          validFrom: latestFrom,
          validUntil: earliestUntil,
        }];
      }
    case 'highest-confidence':
      if (facets.length === 0) return [];
      return [facets.reduce((best: any, f: any) =>
        (f.causalConfidence ?? 0) > (best.causalConfidence ?? 0) ? f : best
      )];
    case 'merge-bindings':
      if (facets.length === 0) return [];
      {
        const allBindings = facets.flatMap((f: any) => f.bindings ?? []);
        const allMappings = facets.flatMap((f: any) => f.vocabularyMappings ?? []);
        const allExposed = facets.flatMap((f: any) => f.exposedEntities ?? []);
        return [{
          type: 'Projection',
          bindings: allBindings.length > 0 ? allBindings : undefined,
          vocabularyMappings: allMappings.length > 0 ? allMappings : undefined,
          exposedEntities: allExposed.length > 0 ? [...new Set(allExposed)] : undefined,
          selective: facets.some((f: any) => f.selective),
        }];
      }
    default:
      return facets;
  }
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
