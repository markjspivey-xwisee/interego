/**
 * @module affordance
 * @description Affordance engine for autonomous agents.
 *
 * Integrates eight theoretical frameworks:
 *   Gibson (relational affordances) + Norman (signifiers/anti-affordances) +
 *   Pearl (causal interventions) + Boyd (OODA) + Endsley (SA) +
 *   Bratman (BDI) + Friston (active inference) + Stigmergy
 */

// Types
export type {
  AffordanceAction,
  AffordanceReason,
  Affordance,
  AntiAffordance,
  AffordanceSet,
  Signifier,
  AgentProfile,
  DelegationScope,
  AgentCapability,
  TrustPolicy,
  CausalAffordanceEffect,
  OODAPhase,
  Orientation,
  TrustEvaluation,
  OODACycle,
  CompletedAction,
  SituationalAwarenessLevel,
  PerceptionState,
  ComprehensionState,
  ProjectionState,
  AnticipatedChange,
  AgentState,
  BeliefEntry,
  Desire,
  CommittedAffordance,
  ReconsiderationTrigger,
  FreeEnergyEvaluation,
  FreeEnergyResponse,
  StigmergicField,
  PodFieldState,
  TrustDistribution,
} from './types.js';

// Core computation (Gibson + Norman)
export { computeAffordances } from './compute.js';
// `computeCognitiveStrategy` + `CognitiveStrategy` moved to `@interego/pgsl`
// (cognitive-strategy module) — they consult PGSL retrieval primitives.

// Engine (OODA + BDI + Active Inference + Stigmergy)
export {
  createAgentState,
  assimilateDescriptor,
  addDesire,
  commitToAffordance,
  createOODACycle,
  observe,
  orient,
  decide,
  act,
  evaluateSurprise,
  createStigmergicField,
  updateStigmergicField,
} from './engine.js';

// Generic affordance follower (binding-agnostic Path A reach-anywhere primitive)
export {
  followAffordance,
  DescriptorNotFoundError,
  AffordanceNotFoundError,
} from './follow.js';
export type {
  FollowAffordanceOptions,
  FollowAffordanceResult,
  ResolvedAffordance,
  AffordanceMethod,
} from './follow.js';
