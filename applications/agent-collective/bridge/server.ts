/**
 * agent-collective bridge — opinionated MCP-named-tool surface over
 * the agent-collective vertical.
 *
 * Generic agents discover via cg:Affordance manifest at /affordances;
 * this bridge is just the named-MCP-tool ergonomic.
 *
 * Run:
 *   PORT=6040 BRIDGE_DEPLOYMENT_URL=https://ac.example/ \
 *     AC_DEFAULT_POD_URL=https://your-pod.example/me/ \
 *     AC_DEFAULT_AGENT_DID=did:web:agent.example \
 *     node dist/server.js
 */

import { createVerticalBridge } from '../../_shared/vertical-bridge/index.js';
import { acAffordances } from '../affordances.js';
import {
  authorTool,
  attestTool,
  promoteTool,
  bundleTeachingPackage,
  recordCrossAgentAudit,
} from '../src/pod-publisher.js';
import type { IRI } from '../../../src/index.js';

interface Ctx { podUrl: string; authoringAgentDid: IRI }
function ctx(args: Record<string, unknown>): Ctx {
  const podUrl = (args.pod_url as string | undefined) ?? process.env.AC_DEFAULT_POD_URL;
  const authoringAgentDid = ((args.authoring_agent_did as string | undefined) ?? process.env.AC_DEFAULT_AGENT_DID) as IRI | undefined;
  if (!podUrl) throw new Error('pod_url is required (or set AC_DEFAULT_POD_URL)');
  if (!authoringAgentDid) throw new Error('authoring_agent_did is required (or set AC_DEFAULT_AGENT_DID)');
  return { podUrl, authoringAgentDid };
}

const handlers = {
  'ac.author_tool': async (args: Record<string, unknown>) => authorTool({
    toolName: String(args.tool_name),
    sourceCode: String(args.source_code),
    affordanceAction: String(args.affordance_action),
    affordanceDescription: args.affordance_description as string | undefined,
  }, ctx(args)),

  'ac.attest_tool': async (args: Record<string, unknown>) => attestTool({
    toolIri: String(args.tool_iri) as IRI,
    axis: args.axis as 'correctness' | 'efficiency' | 'safety' | 'generality',
    rating: Number(args.rating),
    direction: args.direction as 'Self' | 'Peer',
    executionEvidence: args.execution_evidence as IRI | undefined,
  }, ctx(args)),

  'ac.promote_tool': async (args: Record<string, unknown>) => promoteTool({
    toolIri: String(args.tool_iri) as IRI,
    selfAttestations: Number(args.self_attestations),
    peerAttestations: Number(args.peer_attestations),
    axesCovered: args.axes_covered as string[],
    thresholdSelf: args.threshold_self as number | undefined,
    thresholdPeer: args.threshold_peer as number | undefined,
    thresholdAxes: args.threshold_axes as number | undefined,
    enforceConstitutionalConstraints: args.enforce_constitutional_constraints as boolean | undefined,
  }, ctx(args)),

  'ac.bundle_teaching_package': async (args: Record<string, unknown>) => bundleTeachingPackage({
    toolIri: String(args.tool_iri) as IRI,
    narrativeFragmentIris: (args.narrative_fragment_iris as string[]).map(s => s as IRI),
    synthesisIri: String(args.synthesis_iri) as IRI,
    constraintIri: args.constraint_iri as IRI | undefined,
    capabilityEvolutionIri: args.capability_evolution_iri as IRI | undefined,
    olkeStage: args.olke_stage as 'Tacit' | 'Articulate' | 'Collective' | 'Institutional',
  }, ctx(args)),

  'ac.record_cross_agent_audit': async (args: Record<string, unknown>) => recordCrossAgentAudit({
    exchangeIri: String(args.exchange_iri) as IRI,
    auditedAgentDid: String(args.audited_agent_did) as IRI,
    direction: args.direction as 'Inbound' | 'Outbound',
    humanOwnerDid: String(args.human_owner_did) as IRI,
  }, ctx(args)),
};

const PORT = parseInt(process.env.PORT ?? '6040', 10);
const app = createVerticalBridge({ verticalName: 'agent-collective', affordances: acAffordances, handlers, defaultPodUrl: process.env.AC_DEFAULT_POD_URL });
app.listen(PORT, () => {
  console.log(`agent-collective bridge on http://localhost:${PORT}`);
  console.log(`  MCP: http://localhost:${PORT}/mcp  |  Manifest: http://localhost:${PORT}/affordances`);
});
