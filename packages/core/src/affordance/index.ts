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
export { computeAffordances, computeCognitiveStrategy } from './compute.js';
export type { CognitiveStrategy } from './compute.js';

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
