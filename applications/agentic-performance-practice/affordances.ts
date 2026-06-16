/**
 * Affordance declarations for the agentic-performance-practice vertical.
 *
 * Single source of truth: the bridge derives MCP tool schemas AND the Hydra
 * Turtle manifest from these; the protocol publishes them as cg:Affordance for
 * generic discovery. (These are L0 cg:Affordances — followable REST actions —
 * NOT the agp:PerformanceAffordance of the ontology, which is the ecological
 * action-possibility a situation offers a performer. The two are deliberately
 * distinct; see the ontology comment on agp:PerformanceAffordance.)
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';

const POD_INPUTS = [
  { name: 'pod_url', type: 'string' as const, required: false, description: 'Pod URL to write to / read from.' },
  { name: 'operator_did', type: 'string' as const, required: false, description: 'Operator / performer DID.' },
];

const AGP_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:agp:contextualize-situation' as IRI,
    toolName: 'agp.contextualize_situation',
    title: 'Contextualize a performance situation (regime-first)',
    description: 'Publish an agp:PerformanceSituation and place its work regime BEFORE choosing any method. Records regimeSource (derived|asserted|default|unclassified); only a derived regime may later gap-analyse or accrue calibration. Routes to the regime-appropriate method (apply-practice/gap-analysis/dispositional-read/stabilise-first/classify-first).',
    method: 'POST',
    targetTemplate: '{base}/agp/contextualize_situation',
    annotations: { title: 'Contextualize a performance situation', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'situation_statement', type: 'string', required: true, description: 'What the performer is to perform, in context.' },
      { name: 'performer_iri', type: 'string', required: false, description: 'IRI of the agp:Performer (human, agent, or team).' },
      { name: 'direction', type: 'string', required: false, description: 'Performance direction.', enum: ['H2H', 'H2A', 'A2H', 'A2A'] },
      { name: 'regime', type: 'string', required: false, description: 'Work regime, if asserted. Prefer leaving unset so it is derived from evidence.', enum: ['Evident', 'Knowable', 'Emergent', 'Turbulent'] },
      { name: 'regime_source', type: 'string', required: false, description: 'Provenance of the regime placement.', enum: ['derived', 'asserted', 'default', 'unclassified'] },
      ...POD_INPUTS,
    ],
    outputs: {
      description: 'ContextualizeResult — the new agp:PerformanceSituation IRI, placed regime, regimeSource, and routed method.',
      properties: {
        situationIri: { type: 'string' }, regime: { type: 'string' }, regimeSource: { type: 'string' }, method: { type: 'string' },
        descriptorUrl: { type: 'string' }, graphUrl: { type: 'string' },
      },
      required: ['situationIri', 'regime', 'method'],
    },
  },
  {
    action: 'urn:cg:action:agp:define-capability' as IRI,
    toolName: 'agp.define_capability',
    title: 'Compose a capability from skills + tools + knowledge',
    description: 'Publish an agp:Capability composed of its constituent skills, tools, and knowledge (agp:composedOf). A capability with no constituents is rejected by SHACL — an empty capability is not productive. Knowledge components carry a codifiability kind (Recorded/Trained/Judged/Lived/Innate).',
    method: 'POST',
    targetTemplate: '{base}/agp/define_capability',
    annotations: { title: 'Compose a capability', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'name', type: 'string', required: true, description: 'Capability name.' },
      { name: 'skill_iris', type: 'array', required: false, description: 'IRIs of constituent agp:Skill descriptors.', itemType: 'string' },
      { name: 'tool_iris', type: 'array', required: false, description: 'IRIs of constituent agp:Tool descriptors (may skos:closeMatch ac:AgentTool).', itemType: 'string' },
      { name: 'knowledge', type: 'array', required: false, description: 'Knowledge components, each { name: string, kind: Recorded|Trained|Judged|Lived|Innate }.', itemType: 'object' },
      ...POD_INPUTS,
    ],
    outputs: {
      description: 'DefineCapabilityResult — the new agp:Capability IRI and the constituent IRIs it composes.',
      properties: { capabilityIri: { type: 'string' }, composedOf: { type: 'array', items: { type: 'string' } }, descriptorUrl: { type: 'string' }, graphUrl: { type: 'string' } },
      required: ['capabilityIri'],
    },
  },
  {
    action: 'urn:cg:action:agp:map-affordance' as IRI,
    toolName: 'agp.map_affordance',
    title: 'Declare a performance affordance a situation offers',
    description: 'Publish an agp:PerformanceAffordance — an action-possibility a situation offers a performer — and the agp:Capability it requires to be actualized. This is the ECOLOGICAL affordance (what the situation affords given capability), DISTINCT from the L0 cg:Affordance REST transition.',
    method: 'POST',
    targetTemplate: '{base}/agp/map_affordance',
    annotations: { title: 'Map a performance affordance', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'situation_iri', type: 'string', required: true, description: 'IRI of the agp:PerformanceSituation that affords this.' },
      { name: 'affordance_statement', type: 'string', required: true, description: 'The action-possibility offered.' },
      { name: 'requires_capability_iri', type: 'string', required: true, description: 'IRI of the agp:Capability this affordance requires (SHACL: required).' },
      ...POD_INPUTS,
    ],
    outputs: {
      description: 'MapAffordanceResult — the new agp:PerformanceAffordance IRI.',
      properties: { affordanceIri: { type: 'string' }, requiresCapability: { type: 'string' }, descriptorUrl: { type: 'string' }, graphUrl: { type: 'string' } },
      required: ['affordanceIri'],
    },
  },
  {
    action: 'urn:cg:action:agp:actualize' as IRI,
    toolName: 'agp.actualize',
    title: 'Record an actualization (capability x situation x affordance -> performance)',
    description: 'Record an agp:Actualization — a capability engaging a situation\'s affordance to yield agp:Performance — and project the performance to a single xAPI `performed` statement in Foxxi\'s LRS (with capability / actualizedAffordance / regime as context extensions, per the vertical\'s custom xAPI Profile). SHACL requires the actualization to reference capability, situation, affordance, AND the yielded performance.',
    method: 'POST',
    targetTemplate: '{base}/agp/actualize',
    annotations: { title: 'Record an actualization', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'situation_iri', type: 'string', required: true, description: 'IRI of the agp:PerformanceSituation.' },
      { name: 'capability_iri', type: 'string', required: true, description: 'IRI of the agp:Capability engaged.' },
      { name: 'affordance_iri', type: 'string', required: true, description: 'IRI of the agp:PerformanceAffordance actualized.' },
      { name: 'performance_statement', type: 'string', required: true, description: 'What was performed.' },
      { name: 'success', type: 'boolean', required: false, description: 'Outcome, if observed. Omit if not actually known (never fabricated).' },
      { name: 'score_scaled', type: 'number', required: false, description: 'Scaled score in [-1,1], if observed.' },
      ...POD_INPUTS,
    ],
    outputs: {
      description: 'ActualizeResult — the agp:Actualization + agp:Performance IRIs and the projected xAPI statement id.',
      properties: { actualizationIri: { type: 'string' }, performanceIri: { type: 'string' }, xapiStatementId: { type: 'string' }, descriptorUrl: { type: 'string' }, graphUrl: { type: 'string' } },
      required: ['actualizationIri', 'performanceIri'],
    },
  },
  {
    action: 'urn:cg:action:agp:diagnose' as IRI,
    toolName: 'agp.diagnose',
    title: 'Diagnose a performance situation (regime-routed)',
    description: 'Read a situation\'s regime and route to the regime-appropriate method. For the Knowable regime ONLY (and only when the regime is derived), run the six-factor cause analysis and name the dominant factor. Never surfaces gap-analysis for a non-Knowable or non-derived situation.',
    method: 'POST',
    targetTemplate: '{base}/agp/diagnose',
    annotations: { title: 'Diagnose a situation', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'situation_iri', type: 'string', required: true, description: 'IRI of the agp:PerformanceSituation to diagnose.' },
      ...POD_INPUTS,
    ],
    outputs: {
      description: 'DiagnoseResult — the agp:Diagnosis IRI, regime, method, and (Knowable only) the dominant performance factor.',
      properties: { diagnosisIri: { type: 'string' }, regime: { type: 'string' }, method: { type: 'string' }, factor: { type: 'string' }, descriptorUrl: { type: 'string' } },
      required: ['diagnosisIri', 'regime', 'method'],
    },
  },
  {
    action: 'urn:cg:action:agp:plan-intervention' as IRI,
    toolName: 'agp.plan_intervention',
    title: 'Emit a regime-appropriate intervention plan',
    description: 'Emit an agp:InterventionPlan from a diagnosis. Instruction (a course) is warranted only when the dominant cause is a knowledge/skill deficiency in a Knowable situation; otherwise the plan targets environment factors (information, instrumentation, incentives) or routes to probes (Emergent) / stabilisation (Turbulent).',
    method: 'POST',
    targetTemplate: '{base}/agp/plan_intervention',
    annotations: { title: 'Plan interventions', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'diagnosis_iri', type: 'string', required: true, description: 'IRI of the agp:Diagnosis to plan from.' },
      ...POD_INPUTS,
    ],
    outputs: {
      description: 'PlanResult — the agp:InterventionPlan IRI and its interventions.',
      properties: { planIri: { type: 'string' }, interventions: { type: 'array', items: { type: 'object', additionalProperties: true } }, descriptorUrl: { type: 'string' } },
      required: ['planIri'],
    },
  },
  {
    action: 'urn:cg:action:agp:evaluate-intervention' as IRI,
    toolName: 'agp.evaluate_intervention',
    title: 'Evaluate an intervention (four levels) and calibrate',
    description: 'Publish an agp:InterventionEvaluation (reaction / capability / transfer / outcome) attesting whether an intervention worked, closing the loop via cg:supersedes and feeding the reflexive calibration profile. Only derived-Knowable outcomes accrue calibration authority.',
    method: 'POST',
    targetTemplate: '{base}/agp/evaluate_intervention',
    annotations: { title: 'Evaluate an intervention', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'intervention_iri', type: 'string', required: true, description: 'IRI of the agp:Intervention being evaluated.' },
      { name: 'outcome_success', type: 'boolean', required: false, description: 'Whether the targeted performance outcome improved, if observed.' },
      { name: 'note', type: 'string', required: false, description: 'Evaluation note; may include an explicit-claim-not-made statement.' },
      ...POD_INPUTS,
    ],
    outputs: {
      description: 'EvaluateResult — the agp:InterventionEvaluation IRI.',
      properties: { evaluationIri: { type: 'string' }, descriptorUrl: { type: 'string' } },
      required: ['evaluationIri'],
    },
  },
  {
    action: 'urn:cg:action:agp:list-practice' as IRI,
    toolName: 'agp.list_practice',
    title: 'Load the operator\'s performance-practice state',
    description: 'Read the operator\'s agp: state from the pod: situations + regimes, capabilities + constituents, performance affordances, actualizations + performances, diagnoses, intervention plans + evaluations, and the calibration profile.',
    method: 'POST',
    targetTemplate: '{base}/agp/list_practice',
    annotations: { title: 'List performance-practice state', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [...POD_INPUTS],
    outputs: {
      description: 'PracticeState — the operator\'s full agp: snapshot loaded from the pod.',
      properties: {
        operatorDid: { type: 'string' },
        situations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        capabilities: { type: 'array', items: { type: 'object', additionalProperties: true } },
        affordances: { type: 'array', items: { type: 'object', additionalProperties: true } },
        actualizations: { type: 'array', items: { type: 'object', additionalProperties: true } },
        diagnoses: { type: 'array', items: { type: 'object', additionalProperties: true } },
        calibration: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['operatorDid'],
    },
  },
];

export const agpAffordances = AGP_AFFORDANCES;
