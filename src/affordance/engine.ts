/**
 * @module affordance/engine
 * @description Unified affordance engine integrating:
 *   - OODA loop (Boyd): observe/orient/decide/act with IG&C
 *   - Active Inference (Friston): surprise evaluation, free energy minimization
 *   - BDI (Bratman): beliefs/desires/intentions state management
 *   - Stigmergy: affordance landscape tracking across pods
 *   - Pearl: causal affordances as interventional queries
 */

import type { ContextDescriptorData, IRI } from '../model/types.js';
import type {
  AgentProfile,
  AgentState,
  BeliefEntry,
  Desire,
  CommittedAffordance,
  Affordance,
  AffordanceAction,
  Orientation,
  TrustEvaluation,
  OODACycle,
  CompletedAction,
  FreeEnergyEvaluation,
  FreeEnergyResponse,
  StigmergicField,
  PodFieldState,
  TrustDistribution,
  ReconsiderationTrigger,
} from './types.js';
import { computeAffordances } from './compute.js';

// ═════════════════════════════════════════════════════════════
//  Agent State Management (BDI)
// ═════════════════════════════════════════════════════════════

/**
 * Create an initial agent state.
 */
export function createAgentState(_profile: AgentProfile): AgentState {
  return {
    beliefs: new Map(),
    desires: [],
    intentions: [],
    orientation: createOrientation(),
  };
}

/**
 * Update beliefs with a newly discovered descriptor.
 * Returns new state + free energy evaluation.
 */
export function assimilateDescriptor(
  state: AgentState,
  descriptor: ContextDescriptorData,
  profile: AgentProfile,
): { state: AgentState; evaluation: FreeEnergyEvaluation } {
  // Compute surprise (Friston)
  const evaluation = evaluateSurprise(state, descriptor, profile);

  // Create belief entry
  const entry: BeliefEntry = {
    descriptor,
    trustEvaluation: evaluateTrust(descriptor),
    surprise: evaluation.surprise,
    assimilated: evaluation.recommendedResponse === 'accept',
  };

  // Update beliefs
  const beliefs = new Map(state.beliefs);
  beliefs.set(descriptor.id, entry);

  // Check if any intentions need reconsideration
  const intentions = reconsiderIntentions(state.intentions, descriptor);

  // Update orientation cache
  const orientation = updateOrientation(state.orientation, descriptor, entry.trustEvaluation);

  return {
    state: { ...state, beliefs, intentions, orientation },
    evaluation,
  };
}

/**
 * Add a desire (goal) to the agent state.
 */
export function addDesire(state: AgentState, desire: Desire): AgentState {
  return { ...state, desires: [...state.desires, desire] };
}

/**
 * Commit to an affordance, creating an intention (Bratman).
 */
export function commitToAffordance(
  state: AgentState,
  affordance: Affordance,
  desire: string,
  reconsiderIf: readonly ReconsiderationTrigger[] = [],
): AgentState {
  const committed: CommittedAffordance = {
    ...affordance,
    committedAt: new Date().toISOString(),
    reconsiderIf,
    desire,
  };
  return { ...state, intentions: [...state.intentions, committed] };
}

// ═════════════════════════════════════════════════════════════
//  OODA Loop (Boyd)
// ═════════════════════════════════════════════════════════════

/**
 * Create an initial OODA cycle.
 */
export function createOODACycle(): OODACycle {
  return {
    phase: 'observe',
    orientation: createOrientation(),
    observations: [],
    decisions: [],
    actions: [],
    igcAvailable: false,
  };
}

/**
 * Observe phase: ingest discovered descriptors.
 */
export function observe(
  cycle: OODACycle,
  descriptors: readonly ContextDescriptorData[],
): OODACycle {
  return {
    ...cycle,
    phase: 'orient',
    observations: [...cycle.observations, ...descriptors],
  };
}

/**
 * Orient phase: evaluate observations against prior knowledge.
 * This is Boyd's "schwerpunkt" — the most important phase.
 * Produces the orientation that enables IG&C.
 */
export function orient(
  cycle: OODACycle,
  profile: AgentProfile,
  _state: AgentState,
): OODACycle {
  // Evaluate trust for all new observations
  const trustedSources = new Map(cycle.orientation.trustedSources);
  for (const desc of cycle.observations) {
    const trust = evaluateTrust(desc);
    const agentFacet = desc.facets.find(f => f.type === 'Agent') as any;
    if (agentFacet?.assertingAgent?.agentIdentity) {
      trustedSources.set(agentFacet.assertingAgent.agentIdentity as IRI, trust);
    }
  }

  // Build affordance cache
  const affordanceCache = new Map(cycle.orientation.affordanceCache);
  for (const desc of cycle.observations) {
    const key = `${profile.agentId}:${desc.id}`;
    if (!affordanceCache.has(key)) {
      affordanceCache.set(key, computeAffordances(profile, desc));
    }
  }

  // Check if IG&C is available (can skip Decide)
  // IG&C fires when all observations match cached orientation
  const allCached = cycle.observations.every(desc => {
    const key = `${profile.agentId}:${desc.id}`;
    return affordanceCache.has(key);
  });

  const newOrientation: Orientation = {
    trustedSources,
    vocabularyCache: cycle.orientation.vocabularyCache,
    affordanceCache,
    causalModels: cycle.orientation.causalModels,
    timestamp: new Date().toISOString(),
    staleness: 0,
  };

  return {
    ...cycle,
    phase: allCached ? 'act' : 'decide', // IG&C: skip decide if orientation is fresh
    orientation: newOrientation,
    igcAvailable: allCached,
  };
}

/**
 * Decide phase: select actions based on orientation and desires.
 * Uses affordance computation + BDI desire filtering.
 */
export function decide(
  cycle: OODACycle,
  profile: AgentProfile,
  desires: readonly Desire[],
): OODACycle {
  const decisions: CommittedAffordance[] = [];

  for (const desc of cycle.observations) {
    const key = `${profile.agentId}:${desc.id}`;
    const affordanceSet = cycle.orientation.affordanceCache.get(key);
    if (!affordanceSet) continue;

    const available = affordanceSet.affordances.filter(a => a.available);

    // Match available affordances to desires (BDI filter)
    for (const desire of desires) {
      const matching = available.filter(a =>
        desire.satisfiedBy.includes(a.action) && a.confidence > 0.5
      );

      if (matching.length > 0) {
        // Select highest confidence affordance
        const best = matching.reduce((a, b) => a.confidence > b.confidence ? a : b);
        decisions.push({
          ...best,
          committedAt: new Date().toISOString(),
          desire: desire.id,
          reconsiderIf: [{
            condition: 'descriptor retracted or superseded',
            facetType: 'Semiotic',
          }],
        });
      }
    }
  }

  return {
    ...cycle,
    phase: 'act',
    decisions,
  };
}

/**
 * Act phase: record completed actions and their environmental effects.
 */
export function act(
  cycle: OODACycle,
  action: AffordanceAction,
  target: IRI,
  outcome: 'success' | 'failure' | 'partial',
  environmentChange?: string,
): OODACycle {
  const completed: CompletedAction = {
    action,
    target,
    timestamp: new Date().toISOString(),
    outcome,
    environmentChange,
  };

  return {
    ...cycle,
    phase: 'observe', // loop back
    actions: [...cycle.actions, completed],
  };
}

// ═════════════════════════════════════════════════════════════
//  Active Inference / Free Energy (Friston)
// ═════════════════════════════════════════════════════════════

/**
 * Evaluate surprise for a newly discovered descriptor.
 * High surprise → the agent's model doesn't predict this.
 * Returns recommendation: accept, investigate, challenge, or ignore.
 */
export function evaluateSurprise(
  state: AgentState,
  descriptor: ContextDescriptorData,
  _profile: AgentProfile,
): FreeEnergyEvaluation {
  let surprise = 0;
  let beliefUpdateCost = 0;
  const actionCost = 0.3; // fixed cost baseline
  let pragmaticValue = 0;
  let epistemicValue = 0;

  const semiotic = descriptor.facets.find(f => f.type === 'Semiotic') as any;
  const trust = descriptor.facets.find(f => f.type === 'Trust') as any;
  const confidence = semiotic?.epistemicConfidence ?? 0.5;
  const trustLevel = trust?.trustLevel ?? 'SelfAsserted';

  // Surprise factors:

  // 1. Does this contradict existing beliefs?
  for (const [, belief] of state.beliefs) {
    if (belief.descriptor.describes.some(g => descriptor.describes.includes(g))) {
      // Same graph described — check for conflict
      const existingConf = (belief.descriptor.facets.find(f => f.type === 'Semiotic') as any)?.epistemicConfidence ?? 0.5;
      const confDelta = Math.abs(confidence - existingConf);
      surprise += confDelta * 2; // confidence disagreement is surprising

      const existingModal = (belief.descriptor.facets.find(f => f.type === 'Semiotic') as any)?.modalStatus ?? 'Asserted';
      const newModal = semiotic?.modalStatus ?? 'Asserted';
      if (existingModal !== newModal) {
        surprise += 0.5; // modal disagreement is moderately surprising
      }
    }
  }

  // 2. Unknown source?
  const agentFacet = descriptor.facets.find(f => f.type === 'Agent') as any;
  const sourceAgent = agentFacet?.assertingAgent?.agentIdentity as IRI | undefined;
  if (sourceAgent && !state.orientation.trustedSources.has(sourceAgent)) {
    surprise += 0.3; // unknown source is mildly surprising
    epistemicValue += 0.4; // but high epistemic value — new information source
  }

  // 3. Low trust + high confidence is suspicious
  if (trustLevel === 'SelfAsserted' && confidence > 0.9) {
    surprise += 0.4;
  }

  // Normalize surprise to [0, 1]
  surprise = Math.min(1, surprise);

  // Belief update cost: how much would accepting this change our model?
  beliefUpdateCost = surprise * 0.5; // proportional to surprise

  // Pragmatic value: does this serve any desires?
  for (const desire of state.desires) {
    const hasFacets = desire.requiredFacets
      ? desire.requiredFacets.every(ft => descriptor.facets.some(f => f.type === ft))
      : true;
    if (hasFacets) {
      pragmaticValue += desire.priority * 0.3;
    }
  }
  pragmaticValue = Math.min(1, pragmaticValue);

  // Epistemic value: does this reduce uncertainty?
  const newFacetTypes = descriptor.facets
    .map(f => f.type)
    .filter(t => !state.beliefs.size || ![...state.beliefs.values()].some(b =>
      b.descriptor.facets.some(f => f.type === t)
    ));
  epistemicValue += newFacetTypes.length * 0.1;
  epistemicValue = Math.min(1, epistemicValue);

  // Decision: minimize free energy
  let recommendedResponse: FreeEnergyResponse;

  if (surprise < 0.2) {
    recommendedResponse = 'accept'; // low surprise, just update beliefs
  } else if (epistemicValue > pragmaticValue && epistemicValue > 0.5) {
    recommendedResponse = 'investigate'; // high epistemic value, learn more
  } else if (surprise > 0.6 && trustLevel === 'SelfAsserted') {
    recommendedResponse = 'challenge'; // high surprise + low trust
  } else {
    recommendedResponse = 'ignore'; // not worth the energy
  }

  return {
    descriptor: descriptor.id,
    surprise,
    beliefUpdateCost,
    actionCost,
    pragmaticValue,
    epistemicValue,
    recommendedResponse,
  };
}

// ═════════════════════════════════════════════════════════════
//  Stigmergic Field
// ═════════════════════════════════════════════════════════════

/**
 * Create an initial stigmergic field.
 */
export function createStigmergicField(): StigmergicField {
  return {
    pods: new Map(),
    totalDescriptors: 0,
    totalAgents: 0,
    coherenceMetric: 1.0,
    changeRate: 0,
    dominantVocabularies: [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Update the stigmergic field when a pod's state changes.
 * Tracks how the affordance landscape evolves as agents publish.
 */
export function updateStigmergicField(
  field: StigmergicField,
  podUrl: IRI,
  descriptors: readonly ContextDescriptorData[],
  agents: readonly IRI[],
): StigmergicField {
  const pods = new Map(field.pods);

  // Compute trust distribution
  let selfAsserted = 0;
  let delegatedTrust = 0;
  let cryptographicallyVerified = 0;
  for (const desc of descriptors) {
    const trust = desc.facets.find(f => f.type === 'Trust') as any;
    if (trust?.trustLevel === 'CryptographicallyVerified') cryptographicallyVerified++;
    else if (trust?.trustLevel === 'DelegatedTrust') delegatedTrust++;
    else selfAsserted++;
  }
  const trustDist: TrustDistribution = {
    selfAsserted,
    delegatedTrust,
    cryptographicallyVerified,
    total: descriptors.length,
  };

  const podState: PodFieldState = {
    podUrl,
    descriptorCount: descriptors.length,
    agentCount: agents.length,
    lastModified: new Date().toISOString(),
    modifiedBy: agents,
    affordanceDensity: descriptors.length > 0
      ? descriptors.reduce((sum, d) => sum + d.facets.length, 0) / descriptors.length
      : 0,
    trustDistribution: trustDist,
  };

  pods.set(podUrl, podState);

  // Compute aggregate metrics
  let totalDescriptors = 0;
  const allAgents = new Set<string>();
  for (const [, pod] of pods) {
    totalDescriptors += pod.descriptorCount;
    for (const a of pod.modifiedBy) allAgents.add(a);
  }

  // Coherence: ratio of verified trust to total
  let totalVerified = 0;
  let total = 0;
  for (const [, pod] of pods) {
    totalVerified += pod.trustDistribution.cryptographicallyVerified + pod.trustDistribution.delegatedTrust;
    total += pod.trustDistribution.total;
  }
  const coherenceMetric = total > 0 ? totalVerified / total : 1.0;

  return {
    pods,
    totalDescriptors,
    totalAgents: allAgents.size,
    coherenceMetric,
    changeRate: field.changeRate, // TODO: compute from timestamps
    dominantVocabularies: [], // TODO: compute from projection facets
    timestamp: new Date().toISOString(),
  };
}

// ═════════════════════════════════════════════════════════════
//  Helpers
// ═════════════════════════════════════════════════════════════

function createOrientation(): Orientation {
  return {
    trustedSources: new Map(),
    vocabularyCache: new Map(),
    affordanceCache: new Map(),
    causalModels: new Map(),
    timestamp: new Date().toISOString(),
    staleness: 0,
  };
}

function evaluateTrust(descriptor: ContextDescriptorData): TrustEvaluation {
  const trust = descriptor.facets.find(f => f.type === 'Trust') as any;
  const provenance = descriptor.facets.find(f => f.type === 'Provenance') as any;

  return {
    source: provenance?.wasAttributedTo ?? ('unknown' as IRI),
    trustLevel: trust?.trustLevel ?? 'SelfAsserted',
    verified: trust?.trustLevel === 'CryptographicallyVerified',
    lastVerified: new Date().toISOString(),
    confidence: trust?.trustLevel === 'CryptographicallyVerified' ? 1.0
      : trust?.trustLevel === 'DelegatedTrust' ? 0.85
      : 0.7,
  };
}

function updateOrientation(
  orientation: Orientation,
  descriptor: ContextDescriptorData,
  trust: TrustEvaluation,
): Orientation {
  const trustedSources = new Map(orientation.trustedSources);
  trustedSources.set(trust.source, trust);

  const causalModels = new Map(orientation.causalModels);
  const causalFacet = descriptor.facets.find(f => f.type === 'Causal') as any;
  if (causalFacet?.causalModel) {
    causalModels.set(descriptor.id, causalFacet.causalModel as IRI);
  }

  return {
    ...orientation,
    trustedSources,
    causalModels,
    timestamp: new Date().toISOString(),
    staleness: 0,
  };
}

function reconsiderIntentions(
  intentions: readonly CommittedAffordance[],
  newDescriptor: ContextDescriptorData,
): readonly CommittedAffordance[] {
  const semiotic = newDescriptor.facets.find(f => f.type === 'Semiotic') as any;
  const isRetraction = semiotic?.modalStatus === 'Retracted';

  if (!isRetraction) return intentions;

  // If the new descriptor is a retraction, drop intentions that depend on
  // the retracted graph
  return intentions.filter(intention => {
    const shouldReconsider = intention.reconsiderIf.some(trigger =>
      trigger.condition.includes('retract') && trigger.facetType === 'Semiotic'
    );
    return !shouldReconsider;
  });
}
