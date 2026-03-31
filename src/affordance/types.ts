/**
 * @module affordance/types
 * @description Type definitions for the Affordance Engine.
 *
 * Theoretical foundations:
 *   - Gibson: Affordances are relational (agent × environment)
 *   - Norman: Signifiers communicate affordances; anti-affordances block action
 *   - Pearl: Affordances are interventional queries P(Y|do(X))
 *   - Boyd (OODA): Observe → Orient → Decide → Act with IG&C shortcuts
 *   - Endsley (SA): Perception → Comprehension → Projection
 *   - Bratman (BDI): Beliefs → Desires → Intentions
 *   - Friston: Agents minimize surprise (free energy)
 *   - Stigmergy: Indirect coordination through environment modification
 */

import type { IRI, ContextDescriptorData } from '../model/types.js';

// ═════════════════════════════════════════════════════════════
//  Core Affordance Types (Gibson + Norman)
// ═════════════════════════════════════════════════════════════

/**
 * An action an agent can take on a context resource.
 */
export type AffordanceAction =
  | 'read'        // perceive the content
  | 'apply'       // use this context directly in decision-making
  | 'compose'     // merge with local context via union/intersection
  | 'extend'      // grow the pyramid (inner +) — add to existing structure
  | 'beside'      // place beside (outer +) — independent element
  | 'wrap'        // create boundary — turn structure into single element
  | 'cite'        // reference with attribution
  | 'forward'     // share to other agents
  | 'challenge'   // publish a counter-descriptor
  | 'retract'     // mark as no longer valid (owner/delegate only)
  | 'annotate'    // add per-triple annotations
  | 'ingest'      // feed into PGSL lattice
  | 'derive'      // create a new descriptor that supersedes
  | 'intervene'   // perform causal intervention (do-operator)
  | 'project'     // translate via projection/vocabulary mapping
  | 'subscribe'   // watch for changes
  | 'ignore';     // explicitly choose not to act

/**
 * Why an affordance is or isn't available.
 */
export interface AffordanceReason {
  readonly facet: string;           // which facet contributed to this evaluation
  readonly constraint: string;      // what condition was checked
  readonly satisfied: boolean;      // whether the condition was met
  readonly detail?: string;         // human-readable explanation
}

/**
 * A single affordance: an action available (or blocked) for a specific
 * agent-descriptor pair. Gibson's relational property.
 */
export interface Affordance {
  readonly action: AffordanceAction;
  readonly available: boolean;          // true = afforded, false = anti-afforded
  readonly confidence: number;          // 0.0-1.0 — how certain
  readonly reasons: readonly AffordanceReason[];
  readonly causalEffect?: CausalAffordanceEffect;  // Pearl rung 2
}

/**
 * Norman's anti-affordance: an explicit block with explanation.
 */
export interface AntiAffordance {
  readonly action: AffordanceAction;
  readonly blockedBy: string;           // what blocks this action
  readonly reason: string;              // why it's blocked
  readonly overridable: boolean;        // can the agent override with justification?
}

/**
 * The full affordance set for an agent-descriptor pair.
 */
export interface AffordanceSet {
  readonly agent: IRI;
  readonly descriptor: IRI;
  readonly timestamp: string;
  readonly affordances: readonly Affordance[];
  readonly antiAffordances: readonly AntiAffordance[];
  readonly signifiers: readonly Signifier[];
  readonly saLevel: SituationalAwarenessLevel;
}

/**
 * Norman's signifier: a perceivable indicator of an affordance.
 * Facets are signifiers — they communicate what actions are possible.
 */
export interface Signifier {
  readonly facetType: string;
  readonly indicates: AffordanceAction[];
  readonly strength: 'strong' | 'weak' | 'ambiguous';
  readonly detail: string;
}

// ═════════════════════════════════════════════════════════════
//  Agent Profile (Gibson's "effectivities")
// ═════════════════════════════════════════════════════════════

/**
 * An agent's capabilities — Gibson's effectivities.
 * These are properties of the agent that complement environmental
 * affordances to produce actualities.
 */
export interface AgentProfile {
  readonly agentId: IRI;
  readonly ownerWebId?: IRI;
  readonly delegationScope: DelegationScope;
  readonly capabilities: readonly AgentCapability[];
  readonly vocabularies: readonly IRI[];        // ontologies the agent understands
  readonly trustPolicies: readonly TrustPolicy[];
  readonly causalModels: readonly IRI[];        // SCMs the agent has
}

export type DelegationScope = 'ReadWrite' | 'ReadOnly' | 'PublishOnly' | 'DiscoverOnly';

export type AgentCapability =
  | 'discover'      // can fetch manifests
  | 'publish'       // can write descriptors
  | 'compose'       // can run composition operators
  | 'causal'        // has causal reasoning engine
  | 'pgsl'          // has PGSL lattice
  | 'project'       // can do vocabulary translation
  | 'subscribe'     // can hold WebSocket connections
  | 'verify'        // can verify VCs and delegation chains
  | 'challenge'     // can publish counter-descriptors
  | 'retract';      // can retract own descriptors

export interface TrustPolicy {
  readonly minTrustLevel: 'SelfAsserted' | 'DelegatedTrust' | 'CryptographicallyVerified';
  readonly minConfidence: number;
  readonly requiredForAction: AffordanceAction[];
}

// ═════════════════════════════════════════════════════════════
//  Pearl Causal Affordances (Rung 2)
// ═════════════════════════════════════════════════════════════

/**
 * An affordance expressed as an interventional query: P(Y|do(X)).
 * "What would happen if the agent performed this action?"
 */
export interface CausalAffordanceEffect {
  readonly intervention: string;        // do(X = x) description
  readonly expectedOutcome: string;     // predicted Y
  readonly identifiable: boolean;       // can we estimate from observation alone?
  readonly adjustmentSet?: string[];    // backdoor variables if identifiable
  readonly causalConfidence: number;    // confidence in the causal estimate
}

// ═════════════════════════════════════════════════════════════
//  OODA Loop (Boyd)
// ═════════════════════════════════════════════════════════════

export type OODAPhase = 'observe' | 'orient' | 'decide' | 'act';

/**
 * Boyd's Orientation state — the "schwerpunkt."
 * Cached evaluations that enable IG&C (implicit guidance & control).
 */
export interface Orientation {
  readonly trustedSources: ReadonlyMap<IRI, TrustEvaluation>;
  readonly vocabularyCache: ReadonlyMap<IRI, string[]>;  // pod -> known vocabularies
  readonly affordanceCache: ReadonlyMap<string, AffordanceSet>;
  readonly causalModels: ReadonlyMap<IRI, IRI>;    // descriptor -> SCM
  readonly timestamp: string;
  readonly staleness: number;           // seconds since last update
}

export interface TrustEvaluation {
  readonly source: IRI;
  readonly trustLevel: string;
  readonly verified: boolean;
  readonly lastVerified: string;
  readonly confidence: number;
}

/**
 * OODA cycle state for an agent.
 */
export interface OODACycle {
  readonly phase: OODAPhase;
  readonly orientation: Orientation;
  readonly observations: readonly ContextDescriptorData[];
  readonly decisions: readonly CommittedAffordance[];
  readonly actions: readonly CompletedAction[];
  readonly igcAvailable: boolean;       // can skip Decide via cached orientation?
}

export interface CompletedAction {
  readonly action: AffordanceAction;
  readonly target: IRI;
  readonly timestamp: string;
  readonly outcome: 'success' | 'failure' | 'partial';
  readonly environmentChange?: string;  // what changed in the affordance landscape
}

// ═════════════════════════════════════════════════════════════
//  Situational Awareness (Endsley)
// ═════════════════════════════════════════════════════════════

export interface SituationalAwarenessLevel {
  readonly level1_perception: PerceptionState;
  readonly level2_comprehension: ComprehensionState;
  readonly level3_projection: ProjectionState;
}

export interface PerceptionState {
  readonly descriptorsDiscovered: number;
  readonly podsScanned: number;
  readonly facetTypesObserved: string[];
  readonly coverageGaps: string[];      // what we haven't looked at yet
}

export interface ComprehensionState {
  readonly trustEvaluated: number;
  readonly vocabularyMapped: number;
  readonly causalModelsResolved: number;
  readonly conflictsDetected: number;
  readonly coherenceScore: number;      // 0.0-1.0 — how consistent is our understanding?
}

export interface ProjectionState {
  readonly anticipatedChanges: readonly AnticipatedChange[];
  readonly projectedAffordances: readonly Affordance[];
  readonly timeHorizon: string;         // how far ahead we're projecting
  readonly projectionConfidence: number;
}

export interface AnticipatedChange {
  readonly source: IRI;                 // which agent/pod
  readonly expectedAction: AffordanceAction;
  readonly probability: number;
  readonly impact: 'high' | 'medium' | 'low';
}

// ═════════════════════════════════════════════════════════════
//  BDI Agent State (Bratman)
// ═════════════════════════════════════════════════════════════

/**
 * Bratman's BDI: Beliefs, Desires, Intentions.
 */
export interface AgentState {
  readonly beliefs: ReadonlyMap<IRI, BeliefEntry>;
  readonly desires: readonly Desire[];
  readonly intentions: readonly CommittedAffordance[];
  readonly orientation: Orientation;    // Boyd's cached state
}

export interface BeliefEntry {
  readonly descriptor: ContextDescriptorData;
  readonly trustEvaluation: TrustEvaluation;
  readonly surprise: number;            // Friston: how unexpected was this?
  readonly assimilated: boolean;        // has this been integrated into the model?
}

export interface Desire {
  readonly id: string;
  readonly description: string;
  readonly priority: number;            // 0.0-1.0
  readonly satisfiedBy: AffordanceAction[];
  readonly requiredFacets?: string[];   // facets needed to satisfy
}

/**
 * An affordance the agent has committed to executing.
 * Bratman's intention: temporally persistent, resists reconsideration.
 */
export interface CommittedAffordance extends Affordance {
  readonly committedAt: string;
  readonly persistUntil?: string;
  readonly reconsiderIf: readonly ReconsiderationTrigger[];
  readonly desire: string;              // which desire this serves
}

export interface ReconsiderationTrigger {
  readonly condition: string;           // e.g. "descriptor retracted"
  readonly facetType?: string;
  readonly threshold?: number;
}

// ═════════════════════════════════════════════════════════════
//  Active Inference / Free Energy (Friston)
// ═════════════════════════════════════════════════════════════

/**
 * Free energy evaluation for a newly discovered descriptor.
 * Should the agent update beliefs (perception) or act on the world (action)?
 */
export interface FreeEnergyEvaluation {
  readonly descriptor: IRI;
  readonly surprise: number;                // -ln p(o) — how unexpected
  readonly beliefUpdateCost: number;        // KL divergence for perception path
  readonly actionCost: number;              // expected free energy for action path
  readonly pragmaticValue: number;          // does this serve our desires?
  readonly epistemicValue: number;          // does this reduce our uncertainty?
  readonly recommendedResponse: FreeEnergyResponse;
}

export type FreeEnergyResponse =
  | 'accept'        // low surprise, update beliefs
  | 'investigate'   // high epistemic value, seek more information
  | 'challenge'     // high surprise + low trust, push back
  | 'ignore';       // low pragmatic + low epistemic value

// ═════════════════════════════════════════════════════════════
//  Stigmergy
// ═════════════════════════════════════════════════════════════

/**
 * Stigmergic field: the affordance landscape across all known pods.
 * Modified indirectly as agents publish/retract context.
 */
export interface StigmergicField {
  readonly pods: ReadonlyMap<IRI, PodFieldState>;
  readonly totalDescriptors: number;
  readonly totalAgents: number;
  readonly coherenceMetric: number;     // are agents converging or diverging?
  readonly changeRate: number;          // descriptors per unit time
  readonly dominantVocabularies: string[];
  readonly timestamp: string;
}

export interface PodFieldState {
  readonly podUrl: IRI;
  readonly descriptorCount: number;
  readonly agentCount: number;
  readonly lastModified: string;
  readonly modifiedBy: readonly IRI[];
  readonly affordanceDensity: number;   // how many affordances per descriptor
  readonly trustDistribution: TrustDistribution;
}

export interface TrustDistribution {
  readonly selfAsserted: number;
  readonly delegatedTrust: number;
  readonly cryptographicallyVerified: number;
  readonly total: number;
}
