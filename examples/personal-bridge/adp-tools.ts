/**
 * Personal-bridge MCP tools for the agent-development-practice vertical.
 *
 * Production-grade tools any MCP client can call to manage a probe cycle
 * against the user's real pod:
 *   adp.define_capability
 *   adp.record_probe
 *   adp.record_narrative_fragment
 *   adp.emerge_synthesis
 *   adp.record_evolution_step
 *   adp.refine_constraint
 *   adp.recognize_capability_evolution
 *   adp.list_cycle
 *
 * Honesty discipline enforced at the publisher layer:
 *   - Probes are always Hypothetical
 *   - Fragments are always Hypothetical
 *   - Syntheses are always Hypothetical AND require ≥2 coherent narratives
 *   - Evolution steps require explicitDecisionNotMade
 *   - Constraints must have emergedFrom + boundary + exits
 *   - Capability evolution events require explicitDecisionNotMade
 */

import {
  defineCapability,
  recordProbe,
  recordNarrativeFragment,
  emergeSynthesis,
  recordEvolutionStep,
  refineConstraint,
  recognizeCapabilityEvolution,
} from '../../applications/agent-development-practice/src/pod-publisher.js';
import {
  loadProbeCycle,
} from '../../applications/agent-development-practice/src/pod-loader.js';
import type { IRI } from '@interego/core';

interface AdpConfig {
  podUrl: string;
  operatorDid: IRI;
}

function adpConfig(args: Record<string, unknown>): AdpConfig {
  const podUrl = (args['podUrl'] as string | undefined)
              ?? process.env['ADP_POD_URL']
              ?? throwMissing('ADP_POD_URL or args.podUrl required');
  const operatorDid = ((args['operatorDid'] as string | undefined)
              ?? process.env['ADP_OPERATOR_DID']
              ?? throwMissing('ADP_OPERATOR_DID or args.operatorDid required')) as IRI;
  return { podUrl, operatorDid };
}

function throwMissing(msg: string): never { throw new Error(msg); }

interface ToolHandler {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function adpTools(): Record<string, ToolHandler> {
  return {
    'adp.define_capability': {
      description: 'Declare a capability SPACE (not target) with rubric criteria as guides (not gates) and a Cynefin domain. Publishes adp:Capability + adp:RubricCriterion entries to the user\'s pod.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          cynefinDomain: { type: 'string', enum: ['Clear', 'Complicated', 'Complex', 'Chaotic', 'Confused'] },
          rubricCriteria: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name'] },
          },
          description: { type: 'string' },
          podUrl: { type: 'string' },
          operatorDid: { type: 'string' },
        },
        required: ['name', 'cynefinDomain', 'rubricCriteria'],
      },
      handler: async (args) => {
        return await defineCapability({
          name: String(args['name']),
          cynefinDomain: args['cynefinDomain'] as DefineCapabilityCynefin,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rubricCriteria: args['rubricCriteria'] as any,
          description: args['description'] as string | undefined,
        }, adpConfig(args));
      },
    },

    'adp.record_probe': {
      description: 'Record a safe-to-fail probe. Always Hypothetical. REQUIRES amplification + dampening triggers stated up-front (prevents retconning).',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityIri: { type: 'string' },
          variant: { type: 'string' },
          hypothesis: { type: 'string' },
          amplificationTrigger: { type: 'string' },
          dampeningTrigger: { type: 'string' },
          timeBoundUntil: { type: 'string' },
          podUrl: { type: 'string' },
          operatorDid: { type: 'string' },
        },
        required: ['capabilityIri', 'variant', 'hypothesis', 'amplificationTrigger', 'dampeningTrigger'],
      },
      handler: async (args) => {
        return await recordProbe({
          capabilityIri: String(args['capabilityIri']) as IRI,
          variant: String(args['variant']),
          hypothesis: String(args['hypothesis']),
          amplificationTrigger: String(args['amplificationTrigger']),
          dampeningTrigger: String(args['dampeningTrigger']),
          timeBoundUntil: args['timeBoundUntil'] as string | undefined,
        }, adpConfig(args));
      },
    },

    'adp.record_narrative_fragment': {
      description: 'Record a narrative observation against a probe. Always Hypothetical (observation, not causation claim). Carries situation signifiers + agent response + an emergent signifier.',
      inputSchema: {
        type: 'object',
        properties: {
          probeIri: { type: 'string' },
          contextSignifiers: { type: 'array', items: { type: 'string' } },
          response: { type: 'string' },
          emergentSignifier: { type: 'string' },
          podUrl: { type: 'string' },
          operatorDid: { type: 'string' },
        },
        required: ['probeIri', 'contextSignifiers', 'response', 'emergentSignifier'],
      },
      handler: async (args) => {
        return await recordNarrativeFragment({
          probeIri: String(args['probeIri']) as IRI,
          contextSignifiers: args['contextSignifiers'] as string[],
          response: String(args['response']),
          emergentSignifier: String(args['emergentSignifier']),
        }, adpConfig(args));
      },
    },

    'adp.emerge_synthesis': {
      description: 'Compose multiple narrative fragments into a synthesis. Always Hypothetical. REQUIRES ≥2 coherent narratives — prevents silent collapse to single root cause.',
      inputSchema: {
        type: 'object',
        properties: {
          probeIri: { type: 'string' },
          fragmentIris: { type: 'array', items: { type: 'string' } },
          emergentPattern: { type: 'string' },
          coherentNarratives: { type: 'array', items: { type: 'string' }, minItems: 2 },
          podUrl: { type: 'string' },
          operatorDid: { type: 'string' },
        },
        required: ['probeIri', 'fragmentIris', 'emergentPattern', 'coherentNarratives'],
      },
      handler: async (args) => {
        return await emergeSynthesis({
          probeIri: String(args['probeIri']) as IRI,
          fragmentIris: (args['fragmentIris'] as string[]).map(s => s as IRI),
          emergentPattern: String(args['emergentPattern']),
          coherentNarratives: args['coherentNarratives'] as string[],
        }, adpConfig(args));
      },
    },

    'adp.record_evolution_step': {
      description: 'Operator amplify/dampen decision. Asserted (operator commits) BUT REQUIRES explicitDecisionNotMade — counter-cultural by design; forces writing down what is NOT being claimed.',
      inputSchema: {
        type: 'object',
        properties: {
          synthesisIri: { type: 'string' },
          amplifyProbeIris: { type: 'array', items: { type: 'string' } },
          dampenProbeIris: { type: 'array', items: { type: 'string' } },
          explicitDecisionNotMade: { type: 'string', description: 'REQUIRED. What you are NOT claiming with this decision.' },
          nextRevisitAt: { type: 'string' },
          podUrl: { type: 'string' },
          operatorDid: { type: 'string' },
        },
        required: ['synthesisIri', 'explicitDecisionNotMade'],
      },
      handler: async (args) => {
        return await recordEvolutionStep({
          synthesisIri: String(args['synthesisIri']) as IRI,
          amplifyProbeIris: ((args['amplifyProbeIris'] as string[] | undefined) ?? []).map(s => s as IRI),
          dampenProbeIris: ((args['dampenProbeIris'] as string[] | undefined) ?? []).map(s => s as IRI),
          explicitDecisionNotMade: String(args['explicitDecisionNotMade']),
          nextRevisitAt: args['nextRevisitAt'] as string | undefined,
        }, adpConfig(args));
      },
    },

    'adp.refine_constraint': {
      description: 'Refine a constraint emerged from synthesis cycles. Boundary (what NOT to do) + exits (when relaxed). REQUIRES emergedFrom (constraints emerge from sensemaking, not from declaration).',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityIri: { type: 'string' },
          emergedFromSynthesisIris: { type: 'array', items: { type: 'string' }, minItems: 1 },
          boundary: { type: 'string' },
          exitsConstraint: { type: 'string' },
          supersedes: { type: 'string' },
          podUrl: { type: 'string' },
          operatorDid: { type: 'string' },
        },
        required: ['capabilityIri', 'emergedFromSynthesisIris', 'boundary', 'exitsConstraint'],
      },
      handler: async (args) => {
        return await refineConstraint({
          capabilityIri: String(args['capabilityIri']) as IRI,
          emergedFromSynthesisIris: (args['emergedFromSynthesisIris'] as string[]).map(s => s as IRI),
          boundary: String(args['boundary']),
          exitsConstraint: String(args['exitsConstraint']),
          supersedes: args['supersedes'] as IRI | undefined,
        }, adpConfig(args));
      },
    },

    'adp.recognize_capability_evolution': {
      description: 'Recognize an emergent capability pattern as a passport:LifeEvent biographical record. REQUIRES explicitDecisionNotMade — the humility-forward clauses travel with the agent across deployments.',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityIri: { type: 'string' },
          evolutionType: { type: 'string', enum: ['EmergentRecognition', 'ConstraintRefinement', 'VariantAmplified', 'VariantDampened'] },
          emergedFromIris: { type: 'array', items: { type: 'string' } },
          olkeStage: { type: 'string', enum: ['Tacit', 'Articulate', 'Collective', 'Institutional'] },
          explicitDecisionNotMade: { type: 'string', description: 'REQUIRED. Carries humility forward across deployments.' },
          podUrl: { type: 'string' },
          operatorDid: { type: 'string' },
        },
        required: ['capabilityIri', 'evolutionType', 'olkeStage', 'explicitDecisionNotMade'],
      },
      handler: async (args) => {
        return await recognizeCapabilityEvolution({
          capabilityIri: String(args['capabilityIri']) as IRI,
          evolutionType: args['evolutionType'] as RecognizeEvolutionType,
          emergedFromIris: ((args['emergedFromIris'] as string[] | undefined) ?? []).map(s => s as IRI),
          olkeStage: args['olkeStage'] as OlkeStage,
          explicitDecisionNotMade: String(args['explicitDecisionNotMade']),
        }, adpConfig(args));
      },
    },

    'adp.list_cycle': {
      description: 'Load the operator\'s probe cycle state from the pod: capabilities, probes, fragments, syntheses, evolution steps, constraints, capability evolution events.',
      inputSchema: {
        type: 'object',
        properties: { podUrl: { type: 'string' }, operatorDid: { type: 'string' } },
      },
      handler: async (args) => {
        const cfg = adpConfig(args);
        return await loadProbeCycle({ podUrl: cfg.podUrl, operatorDid: cfg.operatorDid });
      },
    },
  };
}

type DefineCapabilityCynefin = 'Clear' | 'Complicated' | 'Complex' | 'Chaotic' | 'Confused';
type RecognizeEvolutionType = 'EmergentRecognition' | 'ConstraintRefinement' | 'VariantAmplified' | 'VariantDampened';
type OlkeStage = 'Tacit' | 'Articulate' | 'Collective' | 'Institutional';
