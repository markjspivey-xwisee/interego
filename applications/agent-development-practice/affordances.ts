/**
 * Affordance declarations for the agent-development-practice vertical.
 *
 * Each capability declared once as an Affordance — bridge derives MCP
 * tool schemas; protocol publishes as cg:Affordance for generic
 * discovery.
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type {
  IRI,
} from '@interego/core';

const ADP_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:adp:define-capability' as IRI,
    toolName: 'adp.define_capability',
    title: 'Declare a capability space',
    description: 'Declare a capability SPACE (not target) with rubric criteria as guides (not gates) and a Cynefin domain. Publishes adp:Capability + adp:RubricCriterion entries.',
    method: 'POST',
    targetTemplate: '{base}/adp/define_capability',
    annotations: { title: 'Declare a capability space', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'name', type: 'string', required: true, description: 'Capability name.' },
      { name: 'cynefin_domain', type: 'string', required: true, description: 'Which Cynefin domain the capability lives in.', enum: ['Clear', 'Complicated', 'Complex', 'Chaotic', 'Confused'] },
      { name: 'rubric_criteria', type: 'array', required: true, description: 'Guides for what we care about. Each is { name: string, description?: string }.', itemType: 'object' },
      { name: 'description', type: 'string', required: false, description: 'Optional description.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'DefineCapabilityResult — IRI of the new adp:Capability + the descriptor/graph URLs.',
      properties: {
        capabilityIri: { type: 'string', description: 'IRI of the new adp:Capability.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload (also contains the adp:RubricCriterion entries).' },
      },
      required: ['capabilityIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:adp:record-probe' as IRI,
    toolName: 'adp.record_probe',
    title: 'Record a safe-to-fail probe',
    description: 'Record a safe-to-fail probe. Always Hypothetical. REQUIRES amplification + dampening triggers stated up-front (prevents retconning).',
    method: 'POST',
    targetTemplate: '{base}/adp/record_probe',
    annotations: { title: 'Record a safe-to-fail probe', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'capability_iri', type: 'string', required: true, description: 'IRI of the adp:Capability this probe explores.' },
      { name: 'variant', type: 'string', required: true, description: 'Variant name (e.g., "explicit-acknowledgment").' },
      { name: 'hypothesis', type: 'string', required: true, description: 'Hypothesis being tested. Always Hypothetical — explicitly NOT a claim about cause-effect.' },
      { name: 'amplification_trigger', type: 'string', required: true, description: 'Pattern that, if observed, increases this probe\'s deployment.' },
      { name: 'dampening_trigger', type: 'string', required: true, description: 'Pattern that, if observed, decreases this probe\'s deployment.' },
      { name: 'time_bound_until', type: 'string', required: false, description: 'When to revisit the probe regardless of triggers (ISO timestamp).' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'RecordProbeResult — IRI of the new adp:Probe (always Hypothetical) + the descriptor/graph URLs.',
      properties: {
        probeIri: { type: 'string', description: 'IRI of the new adp:Probe.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['probeIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:adp:record-narrative-fragment' as IRI,
    toolName: 'adp.record_narrative_fragment',
    title: 'Record a narrative fragment',
    description: 'Record a narrative observation against a probe. Always Hypothetical (observation, not causation claim). Carries situation signifiers + agent response + emergent signifier.',
    method: 'POST',
    targetTemplate: '{base}/adp/record_narrative_fragment',
    annotations: { title: 'Record a narrative fragment', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'probe_iri', type: 'string', required: true, description: 'IRI of the adp:Probe this fragment observes.' },
      { name: 'context_signifiers', type: 'array', required: true, description: 'SenseMaker-style descriptive tags for the situation.', itemType: 'string', minItems: 1 },
      { name: 'response', type: 'string', required: true, description: 'Narrative description of what the agent did and what followed.' },
      { name: 'emergent_signifier', type: 'string', required: true, description: 'Tag for what emerged from the response.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'RecordNarrativeFragmentResult — IRI of the new adp:NarrativeFragment + the descriptor/graph URLs.',
      properties: {
        fragmentIri: { type: 'string', description: 'IRI of the new adp:NarrativeFragment.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['fragmentIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:adp:emerge-synthesis' as IRI,
    toolName: 'adp.emerge_synthesis',
    title: 'Emerge a synthesis from fragments',
    description: 'Compose multiple narrative fragments into a synthesis. Always Hypothetical. REQUIRES ≥2 coherent narratives — silent-collapse prevention.',
    method: 'POST',
    targetTemplate: '{base}/adp/emerge_synthesis',
    annotations: { title: 'Emerge a synthesis from fragments', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'probe_iri', type: 'string', required: true, description: 'IRI of the adp:Probe being synthesized.' },
      { name: 'fragment_iris', type: 'array', required: true, description: 'IRIs of fragments to compose.', itemType: 'string', minItems: 1 },
      { name: 'emergent_pattern', type: 'string', required: true, description: 'Description of the pattern surfaced.' },
      { name: 'coherent_narratives', type: 'array', required: true, description: 'Equally-coherent readings of the synthesis. ≥2 required.', itemType: 'string', minItems: 2 },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'EmergeSynthesisResult — IRI of the new adp:Synthesis + the descriptor/graph URLs.',
      properties: {
        synthesisIri: { type: 'string', description: 'IRI of the new adp:Synthesis.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['synthesisIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:adp:record-evolution-step' as IRI,
    toolName: 'adp.record_evolution_step',
    title: 'Record an amplify/dampen evolution decision',
    description: 'Operator amplify/dampen decision. Asserted (operator commits) BUT REQUIRES explicit_decision_not_made — counter-cultural; forces writing down what is NOT being claimed.',
    method: 'POST',
    targetTemplate: '{base}/adp/record_evolution_step',
    annotations: { title: 'Record an amplify/dampen evolution decision', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'synthesis_iri', type: 'string', required: true, description: 'IRI of the synthesis the decision is based on.' },
      { name: 'amplify_probe_iris', type: 'array', required: false, description: 'IRIs of probes being amplified.', itemType: 'string' },
      { name: 'dampen_probe_iris', type: 'array', required: false, description: 'IRIs of probes being dampened.', itemType: 'string' },
      { name: 'explicit_decision_not_made', type: 'string', required: true, description: 'REQUIRED. Free-text statement of what you are NOT claiming with this decision.' },
      { name: 'next_revisit_at', type: 'string', required: false, description: 'When to re-examine the decision (ISO timestamp).' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'RecordEvolutionStepResult — IRI of the new adp:EvolutionStep (Asserted) + the descriptor/graph URLs.',
      properties: {
        evolutionIri: { type: 'string', description: 'IRI of the new adp:EvolutionStep.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['evolutionIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:adp:refine-constraint' as IRI,
    toolName: 'adp.refine_constraint',
    title: 'Refine a constraint emerged from synthesis cycles',
    description: 'Refine a constraint emerged from synthesis cycles. Boundary (what NOT to do) + exits (when relaxed). REQUIRES emergedFrom — constraints emerge from sensemaking, not from declaration.',
    method: 'POST',
    targetTemplate: '{base}/adp/refine_constraint',
    annotations: { title: 'Refine an emerged constraint', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'capability_iri', type: 'string', required: true, description: 'Capability the constraint applies to.' },
      { name: 'emerged_from_synthesis_iris', type: 'array', required: true, description: 'Synthesis IRIs the constraint emerged from. ≥1 required.', itemType: 'string', minItems: 1 },
      { name: 'boundary', type: 'string', required: true, description: 'What the agent must NOT do (or must operate within).' },
      { name: 'exits_constraint', type: 'string', required: true, description: 'Conditions under which the constraint is relaxed.' },
      { name: 'supersedes', type: 'string', required: false, description: 'IRI of an earlier constraint this supersedes.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'RefineConstraintResult — IRI of the new adp:Constraint + the descriptor/graph URLs.',
      properties: {
        constraintIri: { type: 'string', description: 'IRI of the new adp:Constraint.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['constraintIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:adp:recognize-capability-evolution' as IRI,
    toolName: 'adp.recognize_capability_evolution',
    title: 'Recognize an emergent capability as a passport:LifeEvent',
    description: 'Record a passport:LifeEvent biographical record for an emergent capability. REQUIRES explicit_decision_not_made — humility-forward clauses travel with the agent across deployments.',
    method: 'POST',
    targetTemplate: '{base}/adp/recognize_capability_evolution',
    annotations: { title: 'Recognize a capability evolution', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'capability_iri', type: 'string', required: true, description: 'Capability being recognized.' },
      { name: 'evolution_type', type: 'string', required: true, description: 'Kind of evolution event.', enum: ['EmergentRecognition', 'ConstraintRefinement', 'VariantAmplified', 'VariantDampened'] },
      { name: 'emerged_from_iris', type: 'array', required: false, description: 'Synthesis/constraint IRIs the recognition emerged from.', itemType: 'string' },
      { name: 'olke_stage', type: 'string', required: true, description: 'Knowledge maturity stage (OLKE).', enum: ['Tacit', 'Articulate', 'Collective', 'Institutional'] },
      { name: 'explicit_decision_not_made', type: 'string', required: true, description: 'REQUIRED. Carries humility forward across deployments.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'RecognizeCapabilityEvolutionResult — IRI of the new adp:CapabilityEvolution (also a passport:LifeEvent) + the descriptor/graph URLs.',
      properties: {
        capabilityEvolutionIri: { type: 'string', description: 'IRI of the new adp:CapabilityEvolution / passport:LifeEvent.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['capabilityEvolutionIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:adp:list-cycle' as IRI,
    toolName: 'adp.list_cycle',
    title: 'Load the operator\'s probe cycle state',
    description: 'Load the operator\'s probe cycle state from the pod: capabilities, probes, fragments, syntheses, evolution steps, constraints, capability evolution events.',
    method: 'POST',
    targetTemplate: '{base}/adp/list_cycle',
    annotations: { title: 'List probe cycle state', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: [
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'operator_did', type: 'string', required: false, description: 'Operator DID.' },
    ],
    outputs: {
      description: 'ProbeCycleState — operator\'s full probe cycle snapshot loaded from the pod: CapabilityRecord[], ProbeRecord[], NarrativeFragmentRecord[], SynthesisRecord[], EvolutionStepRecord[], ConstraintRecord[], CapabilityEvolutionRecord[].',
      properties: {
        operatorDid: { type: 'string', description: 'DID of the operator the snapshot is loaded for.' },
        capabilities: { type: 'array', description: 'Declared adp:Capability records (iri, name, cynefinDomain, rubricCriterionCount).', items: { type: 'object', additionalProperties: true } },
        probes: { type: 'array', description: 'adp:Probe records (iri, capabilityIri?, variant, hypothesis, amplificationTrigger, dampeningTrigger, timeBound, modalStatus).', items: { type: 'object', additionalProperties: true } },
        fragments: { type: 'array', description: 'adp:NarrativeFragment records (iri, probeIri?, contextSignifiers, response, emergentSignifier, modalStatus).', items: { type: 'object', additionalProperties: true } },
        syntheses: { type: 'array', description: 'adp:Synthesis records (iri, probeIri?, fragmentsConsidered, emergentPattern, coherentNarratives, modalStatus).', items: { type: 'object', additionalProperties: true } },
        evolutionSteps: { type: 'array', description: 'adp:EvolutionStep records (iri, synthesisIri?, amplifyProbeIris, dampenProbeIris, explicitDecisionNotMade, nextRevisitAt, modalStatus).', items: { type: 'object', additionalProperties: true } },
        constraints: { type: 'array', description: 'adp:Constraint records (iri, capabilityIri?, emergedFromIris, boundary, exitsConstraint, modalStatus).', items: { type: 'object', additionalProperties: true } },
        capabilityEvolutions: { type: 'array', description: 'adp:CapabilityEvolution records (iri, capabilityIri?, evolutionType, olkeStage, emergedFromIris, explicitDecisionNotMade, modalStatus).', items: { type: 'object', additionalProperties: true } },
      },
      required: ['operatorDid', 'capabilities', 'probes', 'fragments', 'syntheses', 'evolutionSteps', 'constraints', 'capabilityEvolutions'],
    },
  },
];

export const adpAffordances = ADP_AFFORDANCES;
