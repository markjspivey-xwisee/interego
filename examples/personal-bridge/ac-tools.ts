/**
 * Personal-bridge MCP tools for the agent-collective vertical.
 *
 *   ac.author_tool                — publish ac:AgentTool (Hypothetical) to pod
 *   ac.attest_tool                — amta:Attestation linked to a tool
 *   ac.promote_tool               — flip Hypothetical → Asserted when threshold met
 *   ac.bundle_teaching_package    — bundle artifact + practice for teaching transfer
 *   ac.record_cross_agent_audit   — audit row in human owner's pod
 *
 * Cross-bridge messaging itself uses the existing share_encrypted +
 * query_my_inbox + decrypt_share tools (same code path as Tier 4-tested
 * cross-bridge p2p). agent-collective adds the descriptor surface that
 * lives in the pod alongside.
 */

import {
  authorTool,
  attestTool,
  promoteTool,
  bundleTeachingPackage,
  recordCrossAgentAudit,
} from '../../applications/agent-collective/src/pod-publisher.js';
import type { IRI } from '@interego/core';

interface AcConfig {
  podUrl: string;
  authoringAgentDid: IRI;
}

function acConfig(args: Record<string, unknown>): AcConfig {
  const podUrl = (args['podUrl'] as string | undefined) ?? process.env['AC_POD_URL'] ?? throwMissing('AC_POD_URL or args.podUrl required');
  const authoringAgentDid = ((args['authoringAgentDid'] as string | undefined) ?? process.env['AC_AGENT_DID'] ?? throwMissing('AC_AGENT_DID or args.authoringAgentDid required')) as IRI;
  return { podUrl, authoringAgentDid };
}

function throwMissing(msg: string): never { throw new Error(msg); }

interface ToolHandler {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function acTools(): Record<string, ToolHandler> {
  return {
    'ac.author_tool': {
      description: 'Author a new agent tool. Published Hypothetical (cg:modalStatus = Hypothetical) — fresh tools are not trusted yet. Source code stored as content-addressed pgsl:Atom; affordance declares the cg:Action invokable.',
      inputSchema: {
        type: 'object',
        properties: {
          toolName: { type: 'string' },
          sourceCode: { type: 'string' },
          affordanceAction: { type: 'string', description: 'IRI of the cg:Action this tool exposes.' },
          affordanceDescription: { type: 'string' },
          podUrl: { type: 'string' },
          authoringAgentDid: { type: 'string' },
        },
        required: ['toolName', 'sourceCode', 'affordanceAction'],
      },
      handler: async (args) => {
        return await authorTool({
          toolName: String(args['toolName']),
          sourceCode: String(args['sourceCode']),
          affordanceAction: String(args['affordanceAction']),
          affordanceDescription: args['affordanceDescription'] as string | undefined,
        }, acConfig(args));
      },
    },

    'ac.attest_tool': {
      description: 'Record an amta:Attestation against a tool. Direction is Self (the tool author attests to their own tool) or Peer (another agent attests after using). Multiple axes possible: correctness / efficiency / safety / generality.',
      inputSchema: {
        type: 'object',
        properties: {
          toolIri: { type: 'string' },
          axis: { type: 'string', enum: ['correctness', 'efficiency', 'safety', 'generality'] },
          rating: { type: 'number', minimum: 0, maximum: 1 },
          direction: { type: 'string', enum: ['Self', 'Peer'] },
          executionEvidence: { type: 'string' },
          podUrl: { type: 'string' },
          authoringAgentDid: { type: 'string' },
        },
        required: ['toolIri', 'axis', 'rating', 'direction'],
      },
      handler: async (args) => {
        return await attestTool({
          toolIri: String(args['toolIri']) as IRI,
          axis: args['axis'] as 'correctness' | 'efficiency' | 'safety' | 'generality',
          rating: Number(args['rating']),
          direction: args['direction'] as 'Self' | 'Peer',
          executionEvidence: args['executionEvidence'] as IRI | undefined,
        }, acConfig(args));
      },
    },

    'ac.promote_tool': {
      description: 'Promote Hypothetical tool to Asserted. REFUSES unless attestation threshold is met (default: ≥5 self + ≥2 peer + ≥2 axes covered). Publishes successor with cg:supersedes pointing at the Hypothetical version.',
      inputSchema: {
        type: 'object',
        properties: {
          toolIri: { type: 'string' },
          selfAttestations: { type: 'number' },
          peerAttestations: { type: 'number' },
          axesCovered: { type: 'array', items: { type: 'string' } },
          thresholdSelf: { type: 'number' },
          thresholdPeer: { type: 'number' },
          thresholdAxes: { type: 'number' },
          podUrl: { type: 'string' },
          authoringAgentDid: { type: 'string' },
        },
        required: ['toolIri', 'selfAttestations', 'peerAttestations', 'axesCovered'],
      },
      handler: async (args) => {
        return await promoteTool({
          toolIri: String(args['toolIri']) as IRI,
          selfAttestations: Number(args['selfAttestations']),
          peerAttestations: Number(args['peerAttestations']),
          axesCovered: args['axesCovered'] as string[],
          thresholdSelf: args['thresholdSelf'] as number | undefined,
          thresholdPeer: args['thresholdPeer'] as number | undefined,
          thresholdAxes: args['thresholdAxes'] as number | undefined,
        }, acConfig(args));
      },
    },

    'ac.bundle_teaching_package': {
      description: 'Bundle a tool with the practice context (narratives + synthesis + constraint + capability-evolution) into an ac:TeachingPackage another agent can fetch. REFUSES if no narrative fragments — partial teaching transfers artifact without practice context.',
      inputSchema: {
        type: 'object',
        properties: {
          toolIri: { type: 'string' },
          narrativeFragmentIris: { type: 'array', items: { type: 'string' }, minItems: 1 },
          synthesisIri: { type: 'string' },
          constraintIri: { type: 'string' },
          capabilityEvolutionIri: { type: 'string' },
          olkeStage: { type: 'string', enum: ['Tacit', 'Articulate', 'Collective', 'Institutional'] },
          podUrl: { type: 'string' },
          authoringAgentDid: { type: 'string' },
        },
        required: ['toolIri', 'narrativeFragmentIris', 'synthesisIri', 'olkeStage'],
      },
      handler: async (args) => {
        return await bundleTeachingPackage({
          toolIri: String(args['toolIri']) as IRI,
          narrativeFragmentIris: (args['narrativeFragmentIris'] as string[]).map(s => s as IRI),
          synthesisIri: String(args['synthesisIri']) as IRI,
          constraintIri: args['constraintIri'] as IRI | undefined,
          capabilityEvolutionIri: args['capabilityEvolutionIri'] as IRI | undefined,
          olkeStage: args['olkeStage'] as 'Tacit' | 'Articulate' | 'Collective' | 'Institutional',
        }, acConfig(args));
      },
    },

    'ac.record_cross_agent_audit': {
      description: 'Record an ac:CrossAgentAuditEntry for a chime-in / response / check-in exchange. The audit lives in the HUMAN OWNER\'s pod (not the agent\'s) so the human can audit what their agent said + received.',
      inputSchema: {
        type: 'object',
        properties: {
          exchangeIri: { type: 'string', description: 'IRI of the AgentRequest / AgentResponse / ChimeIn / CheckIn' },
          auditedAgentDid: { type: 'string' },
          direction: { type: 'string', enum: ['Inbound', 'Outbound'] },
          humanOwnerDid: { type: 'string' },
          podUrl: { type: 'string' },
          authoringAgentDid: { type: 'string' },
        },
        required: ['exchangeIri', 'auditedAgentDid', 'direction', 'humanOwnerDid'],
      },
      handler: async (args) => {
        return await recordCrossAgentAudit({
          exchangeIri: String(args['exchangeIri']) as IRI,
          auditedAgentDid: String(args['auditedAgentDid']) as IRI,
          direction: args['direction'] as 'Inbound' | 'Outbound',
          humanOwnerDid: String(args['humanOwnerDid']) as IRI,
        }, acConfig(args));
      },
    },
  };
}
