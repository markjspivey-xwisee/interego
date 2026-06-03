/**
 * Affordance declarations for the agent-collective vertical.
 *
 * Multi-agent federation: tool authoring + attestation + teaching
 * packages + cross-agent audit. Capabilities declared once; bridge
 * derives MCP tool schemas; protocol publishes as cg:Affordance for
 * generic discovery.
 */

import type { Affordance } from '../_shared/affordance-mcp/index.js';
import type { IRI } from '../../src/index.js';

const AC_AFFORDANCES: ReadonlyArray<Affordance> = [
  {
    action: 'urn:cg:action:ac:author-tool' as IRI,
    toolName: 'ac.author_tool',
    title: 'Author a new agent tool',
    description: 'Author a new agent tool. Published Hypothetical (cg:modalStatus = Hypothetical) — fresh tools are not trusted yet. Source code stored as content-addressed pgsl:Atom.',
    method: 'POST',
    targetTemplate: '{base}/ac/author_tool',
    inputs: [
      { name: 'tool_name', type: 'string', required: true, description: 'Tool name.' },
      { name: 'source_code', type: 'string', required: true, description: 'Source code string. Stored as content-addressed atom.' },
      { name: 'affordance_action', type: 'string', required: true, description: 'IRI of the cg:Action this tool exposes.' },
      { name: 'affordance_description', type: 'string', required: false, description: 'Free-text description of the affordance.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'authoring_agent_did', type: 'string', required: false, description: 'Authoring agent DID.' },
    ],
    outputs: {
      description: 'AuthorToolResult — IRIs of the new ac:AgentTool + its content-addressed pgsl:Atom source + the descriptor/graph URLs the tool was published to.',
      properties: {
        toolIri: { type: 'string', description: 'IRI of the new ac:AgentTool (Hypothetical until promoted).' },
        atomIri: { type: 'string', description: 'IRI of the content-addressed pgsl:Atom holding the source code.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['toolIri', 'atomIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:ac:attest-tool' as IRI,
    toolName: 'ac.attest_tool',
    title: 'Record an attestation against a tool',
    description: 'Record an amta:Attestation against a tool. Direction is Self (the tool author attests to their own tool) or Peer (another agent attests after using). Multiple axes possible.',
    method: 'POST',
    targetTemplate: '{base}/ac/attest_tool',
    inputs: [
      { name: 'tool_iri', type: 'string', required: true, description: 'IRI of the ac:AgentTool being attested.' },
      { name: 'axis', type: 'string', required: true, description: 'amta: axis being attested.', enum: ['correctness', 'efficiency', 'safety', 'generality'] },
      { name: 'rating', type: 'number', required: true, description: 'Rating in [0, 1].', minimum: 0, maximum: 1 },
      { name: 'direction', type: 'string', required: true, description: 'Self vs Peer.', enum: ['Self', 'Peer'] },
      { name: 'execution_evidence', type: 'string', required: false, description: 'IRI of evidence event.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'authoring_agent_did', type: 'string', required: false, description: 'Attesting agent DID.' },
    ],
    outputs: {
      description: 'AttestToolResult — IRI of the recorded amta:Attestation + the descriptor/graph URLs.',
      properties: {
        attestationIri: { type: 'string', description: 'IRI of the new amta:Attestation.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['attestationIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:ac:promote-tool' as IRI,
    toolName: 'ac.promote_tool',
    title: 'Promote a Hypothetical tool to Asserted',
    description: 'Promote Hypothetical tool to Asserted. REFUSES unless attestation threshold is met (default: ≥5 self + ≥2 peer + ≥2 axes covered). Publishes successor with cg:supersedes.',
    method: 'POST',
    targetTemplate: '{base}/ac/promote_tool',
    inputs: [
      { name: 'tool_iri', type: 'string', required: true, description: 'IRI of the Hypothetical ac:AgentTool to promote.' },
      { name: 'self_attestations', type: 'integer', required: true, description: 'Verified self-attestation count.' },
      { name: 'peer_attestations', type: 'integer', required: true, description: 'Verified peer-attestation count.' },
      { name: 'axes_covered', type: 'array', required: true, description: 'amta axes covered by accumulated attestations.', itemType: 'string', minItems: 1 },
      { name: 'threshold_self', type: 'integer', required: false, description: 'Override default self-attestation threshold.' },
      { name: 'threshold_peer', type: 'integer', required: false, description: 'Override default peer-attestation threshold.' },
      { name: 'threshold_axes', type: 'integer', required: false, description: 'Override default axes-covered threshold.' },
      { name: 'enforce_constitutional_constraints', type: 'boolean', required: false, description: 'When true, the publisher consults active cgh:PromotionConstraint descriptors on the pod and enforces them in addition to the threshold policy. Substrate-enforced downward causation rather than agent-mediated.' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'authoring_agent_did', type: 'string', required: false, description: 'Promoting agent DID.' },
    ],
    outputs: {
      description: 'PromoteToolResult — IRI of the new Asserted successor (with cg:supersedes back to the Hypothetical original) + the descriptor/graph URLs + which active PromotionConstraints were enforced (empty unless enforce_constitutional_constraints was true).',
      properties: {
        promotedToolIri: { type: 'string', description: 'IRI of the Asserted successor tool.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
        constraintsApplied: {
          type: 'array',
          description: 'IRIs of active cgh:PromotionConstraint descriptors that were enforced. Empty when enforce_constitutional_constraints was false.',
          items: { type: 'string' },
        },
      },
      required: ['promotedToolIri', 'descriptorUrl', 'graphUrl', 'constraintsApplied'],
    },
  },
  {
    action: 'urn:cg:action:ac:bundle-teaching-package' as IRI,
    toolName: 'ac.bundle_teaching_package',
    title: 'Bundle a teaching package (artifact + practice)',
    description: 'Bundle a tool with the practice context (narratives + synthesis + constraint + capability-evolution) into an ac:TeachingPackage another agent can fetch. REFUSES if no narrative fragments — partial teaching transfers artifact without practice context.',
    method: 'POST',
    targetTemplate: '{base}/ac/bundle_teaching_package',
    inputs: [
      { name: 'tool_iri', type: 'string', required: true, description: 'IRI of the ac:AgentTool being taught.' },
      { name: 'narrative_fragment_iris', type: 'array', required: true, description: 'IRIs of narrative fragments. ≥1 required.', itemType: 'string', minItems: 1 },
      { name: 'synthesis_iri', type: 'string', required: true, description: 'IRI of the synthesis included.' },
      { name: 'constraint_iri', type: 'string', required: false, description: 'IRI of an associated constraint.' },
      { name: 'capability_evolution_iri', type: 'string', required: false, description: 'IRI of a capability-evolution event.' },
      { name: 'olke_stage', type: 'string', required: true, description: 'OLKE knowledge maturity stage.', enum: ['Tacit', 'Articulate', 'Collective', 'Institutional'] },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'authoring_agent_did', type: 'string', required: false, description: 'Authoring agent DID.' },
    ],
    outputs: {
      description: 'BundleTeachingPackageResult — IRI of the new ac:TeachingPackage + the descriptor/graph URLs.',
      properties: {
        teachingIri: { type: 'string', description: 'IRI of the new ac:TeachingPackage.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor.' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload.' },
      },
      required: ['teachingIri', 'descriptorUrl', 'graphUrl'],
    },
  },
  {
    action: 'urn:cg:action:ac:record-cross-agent-audit' as IRI,
    toolName: 'ac.record_cross_agent_audit',
    title: 'Record a cross-agent audit entry in the human owner\'s pod',
    description: 'Record an ac:CrossAgentAuditEntry for a chime-in / response / check-in exchange. The audit lives in the HUMAN OWNER\'s pod (not the agent\'s) so the human can audit what their agent said + received.',
    method: 'POST',
    targetTemplate: '{base}/ac/record_cross_agent_audit',
    inputs: [
      { name: 'exchange_iri', type: 'string', required: true, description: 'IRI of the AgentRequest / AgentResponse / ChimeIn / CheckIn.' },
      { name: 'audited_agent_did', type: 'string', required: true, description: 'DID of the agent whose action is being audited.' },
      { name: 'direction', type: 'string', required: true, description: 'Inbound (received) or Outbound (sent).', enum: ['Inbound', 'Outbound'] },
      { name: 'human_owner_did', type: 'string', required: true, description: 'DID of the human owner (audit target).' },
      { name: 'pod_url', type: 'string', required: false, description: 'Pod URL.' },
      { name: 'authoring_agent_did', type: 'string', required: false, description: 'Authoring agent DID.' },
    ],
    outputs: {
      description: 'RecordCrossAgentAuditResult — IRI of the new ac:CrossAgentAuditEntry written into the human owner\'s pod + the descriptor/graph URLs.',
      properties: {
        auditIri: { type: 'string', description: 'IRI of the new ac:CrossAgentAuditEntry.' },
        descriptorUrl: { type: 'string', description: 'URL of the published .ttl descriptor (in the human owner\'s pod).' },
        graphUrl: { type: 'string', description: 'URL of the published .trig graph payload (in the human owner\'s pod).' },
      },
      required: ['auditIri', 'descriptorUrl', 'graphUrl'],
    },
  },
];

export const acAffordances = AC_AFFORDANCES;
