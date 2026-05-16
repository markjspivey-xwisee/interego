/**
 * @interego/compliance-overlay
 *
 * Generic agent-action → compliance-descriptor translator. Wraps every
 * tool call the runtime emits as a typed cg:ContextDescriptor with
 * proper Provenance + Temporal + Semiotic facets and dct:conformsTo
 * citations into the framework controls already declared in the
 * substrate's compliance ontologies.
 *
 * The overlay is substrate-pure. It composes:
 *   - existing ContextDescriptor builder + facets
 *   - existing publish() write path
 *   - existing FRAMEWORK_CONTROLS table for control-IRI defaulting
 *   - existing dct:conformsTo / prov:Activity vocab — no new types
 *
 * The runtime decides which actions to record. For runtimes that
 * happen to emit operator-shaped events (deploy, access change, wallet
 * rotation, incident, quarterly review) the existing src/ops/
 * builders are a tighter fit than this overlay; reach for them first
 * when the action has a known operator-event shape, fall back here for
 * the long tail.
 */

export {
  buildAgentActionDescriptor,
  recordAgentAction,
  type AgentActionEvent,
  type ActionOutcome,
  type ComplianceCitation,
  type BuildEventResult,
  type OverlayConfig,
  type RecordAgentActionResult,
} from './overlay.js';

// Aggregate-privacy → compliance-overlay bridge: wrap v3+ aggregate
// bundles as compliance-grade descriptors citing framework controls.
// See aggregate-bridge.ts for the threat-model + control-mapping notes.
export {
  buildAggregateQueryComplianceDescriptor,
  buildMerkleAttestationComplianceDescriptor,
  buildBudgetAuditComplianceDescriptor,
  buildCommitteeReconstructionComplianceDescriptor,
  buildCommitteeAuthorizationComplianceDescriptor,
} from './aggregate-bridge.js';
