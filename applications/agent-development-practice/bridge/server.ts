/**
 * agent-development-practice bridge — opinionated MCP-named-tool
 * surface over the ADP vertical.
 *
 * Generic agents discover via cg:Affordance manifest at GET /affordances;
 * this bridge is just the named-MCP-tool ergonomic.
 *
 * Run:
 *   PORT=6020 BRIDGE_DEPLOYMENT_URL=https://adp.example/ \
 *     ADP_DEFAULT_POD_URL=https://your-pod.example/me/ \
 *     ADP_DEFAULT_OPERATOR_DID=did:web:you.example \
 *     node dist/server.js
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { adpAffordances } from '../affordances.js';
import {
  defineCapability,
  recordProbe,
  recordNarrativeFragment,
  emergeSynthesis,
  recordEvolutionStep,
  refineConstraint,
  recognizeCapabilityEvolution,
} from '../src/pod-publisher.js';
import { loadProbeCycle } from '../src/pod-loader.js';
import type { IRI } from '../../../src/index.js';

interface Ctx { podUrl: string; operatorDid: IRI }
function ctx(args: Record<string, unknown>): Ctx {
  const podUrl = (args.pod_url as string | undefined) ?? process.env.ADP_DEFAULT_POD_URL;
  const operatorDid = ((args.operator_did as string | undefined) ?? process.env.ADP_DEFAULT_OPERATOR_DID) as IRI | undefined;
  if (!podUrl) throw new Error('pod_url is required (or set ADP_DEFAULT_POD_URL)');
  if (!operatorDid) throw new Error('operator_did is required (or set ADP_DEFAULT_OPERATOR_DID)');
  return { podUrl, operatorDid };
}

const handlers = {
  'adp.define_capability': async (args: Record<string, unknown>) => defineCapability({
    name: String(args.name),
    cynefinDomain: args.cynefin_domain as 'Clear' | 'Complicated' | 'Complex' | 'Chaotic' | 'Confused',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rubricCriteria: args.rubric_criteria as any,
    description: args.description as string | undefined,
  }, ctx(args)),

  'adp.record_probe': async (args: Record<string, unknown>) => recordProbe({
    capabilityIri: String(args.capability_iri) as IRI,
    variant: String(args.variant),
    hypothesis: String(args.hypothesis),
    amplificationTrigger: String(args.amplification_trigger),
    dampeningTrigger: String(args.dampening_trigger),
    timeBoundUntil: args.time_bound_until as string | undefined,
  }, ctx(args)),

  'adp.record_narrative_fragment': async (args: Record<string, unknown>) => recordNarrativeFragment({
    probeIri: String(args.probe_iri) as IRI,
    contextSignifiers: args.context_signifiers as string[],
    response: String(args.response),
    emergentSignifier: String(args.emergent_signifier),
  }, ctx(args)),

  'adp.emerge_synthesis': async (args: Record<string, unknown>) => emergeSynthesis({
    probeIri: String(args.probe_iri) as IRI,
    fragmentIris: (args.fragment_iris as string[]).map(s => s as IRI),
    emergentPattern: String(args.emergent_pattern),
    coherentNarratives: args.coherent_narratives as string[],
  }, ctx(args)),

  'adp.record_evolution_step': async (args: Record<string, unknown>) => recordEvolutionStep({
    synthesisIri: String(args.synthesis_iri) as IRI,
    amplifyProbeIris: ((args.amplify_probe_iris as string[] | undefined) ?? []).map(s => s as IRI),
    dampenProbeIris: ((args.dampen_probe_iris as string[] | undefined) ?? []).map(s => s as IRI),
    explicitDecisionNotMade: String(args.explicit_decision_not_made),
    nextRevisitAt: args.next_revisit_at as string | undefined,
  }, ctx(args)),

  'adp.refine_constraint': async (args: Record<string, unknown>) => refineConstraint({
    capabilityIri: String(args.capability_iri) as IRI,
    emergedFromSynthesisIris: (args.emerged_from_synthesis_iris as string[]).map(s => s as IRI),
    boundary: String(args.boundary),
    exitsConstraint: String(args.exits_constraint),
    supersedes: args.supersedes as IRI | undefined,
  }, ctx(args)),

  'adp.recognize_capability_evolution': async (args: Record<string, unknown>) => recognizeCapabilityEvolution({
    capabilityIri: String(args.capability_iri) as IRI,
    evolutionType: args.evolution_type as 'EmergentRecognition' | 'ConstraintRefinement' | 'VariantAmplified' | 'VariantDampened',
    emergedFromIris: ((args.emerged_from_iris as string[] | undefined) ?? []).map(s => s as IRI),
    olkeStage: args.olke_stage as 'Tacit' | 'Articulate' | 'Collective' | 'Institutional',
    explicitDecisionNotMade: String(args.explicit_decision_not_made),
  }, ctx(args)),

  'adp.list_cycle': async (args: Record<string, unknown>) => loadProbeCycle(ctx(args)),
};

const PORT = parseInt(process.env.PORT ?? '6020', 10);
const app = createVerticalBridge({ verticalName: 'agent-development-practice', affordances: adpAffordances, handlers });
app.listen(PORT, () => {
  console.log(`agent-development-practice bridge on http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp  |  Manifest: http://localhost:${PORT}/affordances`);
});
