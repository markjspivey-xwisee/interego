/**
 * @module affordance/engine
 * @description Unified affordance engine integrating:
 *   - OODA loop (Boyd): observe/orient/decide/act with IG&C
 *   - Active Inference (Friston): surprise evaluation, free energy minimization
 *   - BDI (Bratman): beliefs/desires/intentions state management
 *   - Stigmergy: affordance landscape tracking across pods
 *   - Pearl: causal affordances as interventional queries
 */

import type { ContextDescriptorData, ContextFacetData, ContextTypeName, IRI } from '../model/types.js';
import { DEFAULT_EPISTEMIC_CONFIDENCE } from '../model/types.js';
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
  TrustEvidence,
  ReconsiderationTrigger,
} from './types.js';
// ★ `evaluateTrust` LIVES IN compute.ts, not here, because the trust POLICY evaluator is
// there and the two must not be able to disagree about what a descriptor warrants. It used
// to be a private function in this file computing `verified` off the descriptor's own
// `iep:trustLevel` string while `evaluateTrustPolicy` ranked that same string independently
// — two readings of one forgeable field, in two modules, with nothing tying them together.
import { computeAffordances, evaluateTrust } from './compute.js';

/**
 * Pull one facet out of a descriptor, narrowed to that facet's own interface.
 *
 * `Array.prototype.find` with an ordinary predicate returns the whole union, so every one
 * of the eleven call sites this replaces ended `as any` — and an `as any` on a facet is not
 * a small thing here. Every property this file reads off a facet drives a number that ends
 * up in a trust evaluation or a surprise score: `trustLevel`, `epistemicConfidence`,
 * `modalStatus`, `causalModel`, `wasAttributedTo`. Under `as any` a typo in any of those
 * reads `undefined` and silently takes the default branch — 0.7 confidence, 'Asserted',
 * 'unknown' source — which is indistinguishable from a descriptor that genuinely said so.
 *
 * The `f is` predicate is what makes the narrowing real rather than asserted; `Extract`
 * keeps it tied to the union, so a facet type added to `ContextFacetData` is reachable here
 * with no change and a facet type removed breaks the call site rather than the reads.
 */
type FacetOf<T extends ContextTypeName> = Extract<ContextFacetData, { type: T }>;

function facetOf<T extends ContextTypeName>(
  descriptor: ContextDescriptorData,
  type: T,
): FacetOf<T> | undefined {
  return descriptor.facets.find((f): f is FacetOf<T> => f.type === type);
}

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
  /** What this reader checked for itself. Absent = nothing checked; see {@link TrustEvidence}. */
  evidence?: TrustEvidence,
): { state: AgentState; evaluation: FreeEnergyEvaluation } {
  // Compute surprise (Friston)
  const evaluation = evaluateSurprise(state, descriptor, profile, evidence);

  // Create belief entry
  const entry: BeliefEntry = {
    descriptor,
    trustEvaluation: evaluateTrust(descriptor, evidence),
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
  /**
   * What this reader checked, keyed by descriptor IRI. A descriptor with no entry was not
   * checked, and its trust verdict is capped at `SelfAsserted` accordingly.
   *
   * ★ KEYED BY DESCRIPTOR BECAUSE `orient` FOLDS MANY, and one observation's proof says
   * nothing about another's. A single shared evidence value here would let one verified
   * descriptor launder the whole batch, which is a fresh instance of the defect this
   * argument exists to close rather than a shortcut.
   */
  evidence?: ReadonlyMap<IRI, TrustEvidence>,
): OODACycle {
  // Evaluate trust for all new observations
  const trustedSources = new Map(cycle.orientation.trustedSources);
  for (const desc of cycle.observations) {
    const trust = evaluateTrust(desc, evidence?.get(desc.id));
    const agentFacet = facetOf(desc, 'Agent');
    // ★ `.identity`, NOT `.agentIdentity` — AND THIS IS A DEFECT THE `as any` WAS HIDING,
    // not a rename. `agentIdentity` is the RDF PREDICATE (`iep:agentIdentity`, emitted by
    // rdf/serializer.ts FROM this field); the TypeScript property has always been
    // `identity`. Read through `as any` it was `undefined` at every one of the three sites
    // in this file, so this `if` never once fired: the orient phase's `trustedSources` map
    // was populated only by `updateOrientation`, never by an observation's own asserting
    // agent, for as long as the affordance engine has existed. Nothing was red, because
    // "no Agent facet" and "Agent facet whose identity I misspelt" are the same `undefined`.
    if (agentFacet?.assertingAgent?.identity) {
      trustedSources.set(agentFacet.assertingAgent.identity, trust);
    }
  }

  // Build affordance cache
  const affordanceCache = new Map(cycle.orientation.affordanceCache);
  for (const desc of cycle.observations) {
    const key = `${profile.agentId}:${desc.id}`;
    if (!affordanceCache.has(key)) {
      affordanceCache.set(key, computeAffordances(profile, desc, evidence?.get(desc.id)));
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
  /** What this reader checked for itself. Absent = nothing checked; see {@link TrustEvidence}. */
  evidence?: TrustEvidence,
): FreeEnergyEvaluation {
  let surprise = 0;
  let beliefUpdateCost = 0;
  const actionCost = 0.3; // fixed cost baseline
  let pragmaticValue = 0;
  let epistemicValue = 0;

  const semiotic = facetOf(descriptor, 'Semiotic');
  const confidence = semiotic?.epistemicConfidence ?? DEFAULT_EPISTEMIC_CONFIDENCE;
  // ★ THE WARRANTED RUNG, NOT `trust?.trustLevel`, AND THE OLD READ WAS BACKWARDS. Factor 3
  // below scores "low trust asserted with high confidence" as suspicious — so keying it on
  // the descriptor's own string handed a publisher the suspicion switch: typing
  // `CryptographicallyVerified` into their own Trust facet turned the check OFF, and typing
  // the honest `SelfAsserted` left it on. `?? 'SelfAsserted'` is unchanged and still covers
  // the no-Trust-facet case — and now also an off-ladder level, which warrants no rung.
  //
  // ★ WHAT THIS DOES AND DOES NOT BUY, stated because the obvious reading is too generous.
  // The factor no longer DISCRIMINATES BY CLAIM, which is the fix. It does not discriminate
  // by warrant either until a caller supplies `evidence`: with none, every descriptor warrants
  // at most `SelfAsserted`, so factor 3 fires for every high-confidence descriptor including
  // one whose chain the relay verified. The heuristic is uniform rather than well-aimed today;
  // aiming it needs the ingestion wiring that would pass `trustEvidenceFromAuthorship(...)`
  // down from the fetch that has the served bytes.
  const trustLevel = evaluateTrust(descriptor, evidence).trustLevel ?? 'SelfAsserted';

  // Surprise factors:

  // 1. Does this contradict existing beliefs?
  for (const [, belief] of state.beliefs) {
    if (belief.descriptor.describes.some(g => descriptor.describes.includes(g))) {
      // Same graph described — check for conflict
      const existingConf = (facetOf(belief.descriptor, 'Semiotic'))?.epistemicConfidence ?? DEFAULT_EPISTEMIC_CONFIDENCE;
      const confDelta = Math.abs(confidence - existingConf);
      surprise += confDelta * 2; // confidence disagreement is surprising

      const existingModal = (facetOf(belief.descriptor, 'Semiotic'))?.modalStatus ?? 'Asserted';
      const newModal = semiotic?.modalStatus ?? 'Asserted';
      if (existingModal !== newModal) {
        surprise += 0.5; // modal disagreement is moderately surprising
      }
    }
  }

  // 2. Unknown source?
  const agentFacet = facetOf(descriptor, 'Agent');
  // Same misspelling as in `orient()` above: `sourceAgent` was permanently `undefined`, so
  // this whole factor was dead. Every descriptor scored as though it had no asserting agent
  // at all — never "unknown source", and never the +0.4 epistemic value for meeting one.
  const sourceAgent = agentFacet?.assertingAgent?.identity;
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

  // Compute trust distribution.
  //
  // ★ THIS IS A CENSUS OF WHAT PODS DECLARE, NOT A TALLY OF VERDICTS, and it is the one
  // reader of `iep:trustLevel` in this file that is allowed to be. It counts claims because
  // "what does this pod say about itself" is the question a stigmergic field is asking, and
  // the field has no evidence channel to check them against. Nothing may gate on it:
  // `coherenceMetric` below is verified-share OF THE CLAIMS, so a pod full of self-declared
  // `CryptographicallyVerified` descriptors scores 1.0 while warranting nothing. Trust
  // decisions go through `evaluateTrust`, where no rung above `SelfAsserted` is reachable
  // except through evidence the reader checked for itself.
  let selfAsserted = 0;
  let delegatedTrust = 0;
  let cryptographicallyVerified = 0;
  for (const desc of descriptors) {
    const trust = facetOf(desc, 'Trust');
    if (trust?.trustLevel === 'CryptographicallyVerified') cryptographicallyVerified++;
    else if (trust?.trustLevel === 'ThirdPartyAttested') delegatedTrust++;
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
    vocabularyCounts: countVocabularies(descriptors),
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

  // Change rate: net descriptors per second since the field was last updated.
  // A non-positive elapsed interval (clock skew, sub-millisecond updates)
  // carries the prior rate forward rather than producing a spike.
  const now = new Date();
  const prevMs = Date.parse(field.timestamp);
  const elapsedSec = Number.isFinite(prevMs) ? (now.getTime() - prevMs) / 1000 : 0;
  const changeRate = elapsedSec > 0
    ? (totalDescriptors - field.totalDescriptors) / elapsedSec
    : field.changeRate;

  // Dominant vocabularies: sum each pod's Projection-facet vocabulary counts,
  // ranked most-referenced first.
  const vocabTotals = new Map<string, number>();
  for (const [, pod] of pods) {
    for (const [vocab, count] of Object.entries(pod.vocabularyCounts)) {
      vocabTotals.set(vocab, (vocabTotals.get(vocab) ?? 0) + count);
    }
  }
  const dominantVocabularies = [...vocabTotals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([vocab]) => vocab);

  return {
    pods,
    totalDescriptors,
    totalAgents: allAgents.size,
    coherenceMetric,
    changeRate,
    dominantVocabularies,
    timestamp: now.toISOString(),
  };
}

/**
 * Count the target vocabularies referenced by a set of descriptors'
 * Projection facets — the facet-level `targetVocabulary`, each external
 * binding's `targetVocabulary`, and the namespace of each vocabulary
 * mapping's target term.
 */
function countVocabularies(
  descriptors: readonly ContextDescriptorData[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (vocab: string | undefined): void => {
    if (!vocab) return;
    counts[vocab] = (counts[vocab] ?? 0) + 1;
  };
  for (const desc of descriptors) {
    for (const facet of desc.facets) {
      if (facet.type !== 'Projection') continue;
      bump(facet.targetVocabulary);
      for (const binding of facet.bindings ?? []) bump(binding.targetVocabulary);
      for (const mapping of facet.vocabularyMappings ?? []) bump(namespaceOf(mapping.target));
    }
  }
  return counts;
}

/**
 * Extract the namespace IRI from a term IRI by trimming the local name
 * after the last `#` or `/`.
 */
function namespaceOf(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash >= 0) return iri.slice(0, hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash >= 0) return iri.slice(0, slash + 1);
  return iri;
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

function updateOrientation(
  orientation: Orientation,
  descriptor: ContextDescriptorData,
  trust: TrustEvaluation,
): Orientation {
  const trustedSources = new Map(orientation.trustedSources);
  trustedSources.set(trust.source, trust);

  const causalModels = new Map(orientation.causalModels);
  const causalFacet = facetOf(descriptor, 'Causal');
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
  const semiotic = facetOf(newDescriptor, 'Semiotic');
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
