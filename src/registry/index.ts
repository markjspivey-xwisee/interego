/**
 * @module registry
 * @description Reference implementation of the `registry:` L2 pattern —
 *   a public agent attestation registry. Builds on:
 *
 *     - cg:ContextDescriptor (the registry IS one)
 *     - amta:Attestation (the reputation inputs)
 *     - cg:AccessControlPolicy (registry-specific governance rules)
 *
 *   No new L1 primitives required. Registries co-exist; each one
 *   is just a typed descriptor that other agents (and other
 *   registries) can fetch + cite.
 */

import type { IRI, ContextDescriptorData } from '../model/types.js';

/**
 * One agent's listing in a registry. Carries identity + pod + declared
 * capabilities + a current reputation snapshot.
 */
export interface RegistryEntry {
  readonly entryId: IRI;
  readonly agentIdentity: IRI;        // DID or WebID
  readonly agentPod: string;           // Pod URL
  readonly capabilities: readonly IRI[]; // cg:Affordance class IRIs
  readonly registeredAt: string;       // ISO 8601
  readonly reputation: ReputationSnapshot | null;
}

/**
 * Aggregated reputation at a point in time. Computed deterministically
 * from a set of contributing attestations + a registry policy. Re-running
 * the aggregation over the same inputs yields the same snapshot — so
 * snapshots are verifiable, not opaque.
 */
export interface ReputationSnapshot {
  readonly score: number;              // [0, 1]
  readonly axes: Readonly<Record<string, number>>; // per-axis breakdown
  readonly contributingAttestations: readonly IRI[];
  readonly computedAt: string;
  readonly policyHash: string;         // identifies the aggregation rule
}

/**
 * One Interego-compliant attestation about an agent. Generic shape;
 * pulls from amta:Attestation in practice. Each attestation carries
 * issuer + per-axis scores + freshness.
 */
export interface AttestationInput {
  readonly id: IRI;
  readonly issuer: IRI;                // attestor's identity
  readonly subject: IRI;               // who the attestation is about
  readonly axes: Readonly<Record<string, number>>; // axis → [0, 1]
  readonly issuedAt: string;
  readonly issuerTrustLevel?: 'HighAssurance' | 'PeerAttested' | 'SelfAsserted';
}

/**
 * The aggregation policy. Configurable per registry. Each registry
 * can have its own — that's the point of multi-registry federation.
 */
export interface AggregationPolicy {
  /** Trust-level weights — how much an attestation counts based on
   *  who issued it. Default: HighAssurance=1, PeerAttested=0.5,
   *  SelfAsserted=0 (you can't vouch for yourself). */
  readonly trustWeights: Readonly<Record<string, number>>;
  /** Recency half-life in days. Older attestations get less weight.
   *  Default: 90 days. */
  readonly recencyHalfLifeDays: number;
  /** Minimum number of contributing attestations to compute a score
   *  at all. Below this, return null (insufficient evidence). */
  readonly minContributingAttestations: number;
  /** Identifier for this policy (so snapshots can name it). */
  readonly policyId: string;
}

export const DEFAULT_AGGREGATION_POLICY: AggregationPolicy = {
  trustWeights: { HighAssurance: 1.0, PeerAttested: 0.5, SelfAsserted: 0.0 },
  recencyHalfLifeDays: 90,
  minContributingAttestations: 1,
  policyId: 'urn:registry:policy:default-v1',
};

// ── Aggregator ──────────────────────────────────────────────

function recencyWeight(issuedAtIso: string, nowIso: string, halfLifeDays: number): number {
  const issued = new Date(issuedAtIso).getTime();
  const now = new Date(nowIso).getTime();
  const ageDays = Math.max(0, (now - issued) / (1000 * 60 * 60 * 24));
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Compute a reputation snapshot from a set of attestations under a
 * given policy. Deterministic for the same inputs.
 */
export function aggregateReputation(
  subject: IRI,
  attestations: readonly AttestationInput[],
  policy: AggregationPolicy = DEFAULT_AGGREGATION_POLICY,
  now: string = new Date().toISOString(),
): ReputationSnapshot | null {
  const relevant = attestations.filter(a => a.subject === subject);
  if (relevant.length < policy.minContributingAttestations) return null;

  // Per-axis weighted sum. Each attestation contributes per axis
  // weighted by (issuer trust × recency).
  const axisSums: Record<string, number> = {};
  const axisWeights: Record<string, number> = {};

  for (const att of relevant) {
    const trustWeight = policy.trustWeights[att.issuerTrustLevel ?? 'PeerAttested'] ?? 0;
    if (trustWeight === 0) continue;
    const recency = recencyWeight(att.issuedAt, now, policy.recencyHalfLifeDays);
    const totalWeight = trustWeight * recency;
    for (const [axis, score] of Object.entries(att.axes)) {
      axisSums[axis] = (axisSums[axis] ?? 0) + score * totalWeight;
      axisWeights[axis] = (axisWeights[axis] ?? 0) + totalWeight;
    }
  }

  const axes: Record<string, number> = {};
  for (const axis of Object.keys(axisSums)) {
    axes[axis] = axisWeights[axis]! > 0 ? axisSums[axis]! / axisWeights[axis]! : 0;
  }
  const axisValues = Object.values(axes);
  const overallScore = axisValues.length > 0
    ? axisValues.reduce((a, b) => a + b, 0) / axisValues.length
    : 0;

  return {
    score: overallScore,
    axes,
    contributingAttestations: relevant.map(a => a.id),
    computedAt: now,
    policyHash: policy.policyId,
  };
}

// ── Registry ────────────────────────────────────────────────

export interface Registry {
  readonly id: IRI;
  readonly description: string;
  readonly policy: AggregationPolicy;
  readonly entries: ReadonlyMap<IRI, RegistryEntry>;
  /** Other registries this one cross-cites. */
  readonly federatedWith: readonly IRI[];
}

export interface RegistryConfig {
  readonly id: IRI;
  readonly description: string;
  readonly policy?: AggregationPolicy;
  readonly federatedWith?: readonly IRI[];
}

export function createRegistry(config: RegistryConfig): Registry {
  return {
    id: config.id,
    description: config.description,
    policy: config.policy ?? DEFAULT_AGGREGATION_POLICY,
    entries: new Map(),
    federatedWith: config.federatedWith ?? [],
  };
}

export function registerAgent(
  registry: Registry,
  args: {
    agentIdentity: IRI;
    agentPod: string;
    capabilities: readonly IRI[];
    now?: string;
  },
): Registry {
  const entryId = `${registry.id}/entries/${args.agentIdentity.replace(/[^A-Za-z0-9]/g, '-')}` as IRI;
  const entry: RegistryEntry = {
    entryId,
    agentIdentity: args.agentIdentity,
    agentPod: args.agentPod,
    capabilities: args.capabilities,
    registeredAt: args.now ?? new Date().toISOString(),
    reputation: null,
  };
  const newEntries = new Map(registry.entries);
  newEntries.set(args.agentIdentity, entry);
  return { ...registry, entries: newEntries };
}

/** Recompute reputation for one agent against an attestation pool. */
export function refreshReputation(
  registry: Registry,
  agentIdentity: IRI,
  attestations: readonly AttestationInput[],
  now?: string,
): Registry {
  const entry = registry.entries.get(agentIdentity);
  if (!entry) return registry;
  const snapshot = aggregateReputation(
    agentIdentity, attestations, registry.policy, now,
  );
  const updated: RegistryEntry = { ...entry, reputation: snapshot };
  const newEntries = new Map(registry.entries);
  newEntries.set(agentIdentity, updated);
  return { ...registry, entries: newEntries };
}

/** List entries in this registry, optionally filtered by capability. */
export function queryEntries(
  registry: Registry,
  filter?: { hasCapability?: IRI; minScore?: number },
): readonly RegistryEntry[] {
  return [...registry.entries.values()].filter(e => {
    if (filter?.hasCapability && !e.capabilities.includes(filter.hasCapability)) return false;
    if (filter?.minScore !== undefined && (e.reputation?.score ?? 0) < filter.minScore) return false;
    return true;
  });
}

/**
 * Cross-registry federation: aggregate an agent's listings across
 * multiple registries this registry cites. Returns the union of
 * entries; reputation is the trust-weighted average of each
 * source registry's snapshot.
 */
export function federateLookup(
  agentIdentity: IRI,
  registries: readonly Registry[],
): {
  listings: readonly { registry: IRI; entry: RegistryEntry }[];
  federatedScore: number | null;
} {
  const listings: { registry: IRI; entry: RegistryEntry }[] = [];
  for (const r of registries) {
    const e = r.entries.get(agentIdentity);
    if (e) listings.push({ registry: r.id, entry: e });
  }
  if (listings.length === 0) return { listings: [], federatedScore: null };
  const scores = listings
    .map(l => l.entry.reputation?.score)
    .filter((s): s is number => typeof s === 'number');
  if (scores.length === 0) return { listings, federatedScore: null };
  return {
    listings,
    federatedScore: scores.reduce((a, b) => a + b, 0) / scores.length,
  };
}

/**
 * Serialize the registry as a cg:ContextDescriptor — a registry IS one.
 * Returns the descriptor data structure; a publish step would convert
 * to Turtle and write to a pod.
 */
export function registryToDescriptor(registry: Registry, ownerWebId: IRI): ContextDescriptorData {
  return {
    id: registry.id,
    describes: [registry.id],
    facets: [
      {
        type: 'Temporal',
        validFrom: new Date().toISOString(),
      },
      {
        type: 'Provenance',
        wasAttributedTo: ownerWebId,
        generatedAtTime: new Date().toISOString(),
      },
      {
        type: 'Agent',
        assertingAgent: { identity: ownerWebId },
      },
      {
        type: 'Semiotic',
        modalStatus: 'Asserted',
        epistemicConfidence: 1.0,
        groundTruth: true,
      },
      {
        type: 'Trust',
        trustLevel: 'SelfAsserted',
        issuer: ownerWebId,
      },
      {
        type: 'Federation',
        origin: registry.id,
        storageEndpoint: registry.id,
        syncProtocol: 'SolidNotifications',
      },
    ],
  };
}
