#!/usr/bin/env node
// Per-agent stdio MCP shim — what each spawned `claude` CLI talks to.
//
// claude --mcp-config <agent>.mcp.json
//   └── runs `node mcp-shim.mjs` with INTEREGO_WALLET_KEY,
//       INTEREGO_LABEL, INTEREGO_DID, INTEREGO_POD_URL in env
//
// The shim exposes Interego tools over the standard MCP stdio
// transport. Tool calls translate into rev-196 signed-request POSTs
// against the PRODUCTION RELAY using THIS agent's wallet. Writes
// land on the agent's eth-derived pod just like any other Interego
// participant.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Wallet } from 'ethers';
import { signedToolCall, unsignedToolCall, fetchGraphPayload, podUrlForDid } from './relay.mjs';

const WALLET_KEY = process.env.INTEREGO_WALLET_KEY;
const LABEL      = process.env.INTEREGO_LABEL ?? 'unknown';
const DID        = process.env.INTEREGO_DID;
const POD_URL    = process.env.INTEREGO_POD_URL ?? (DID ? podUrlForDid(DID) : undefined);

if (!WALLET_KEY || !DID) {
  process.stderr.write(`[holodeck mcp-shim] FATAL: INTEREGO_WALLET_KEY and INTEREGO_DID must be set in env.\n`);
  process.exit(2);
}
const wallet = new Wallet(WALLET_KEY);

const server = new Server(
  { name: `interego-holodeck:${LABEL}`, version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: 'publish_context',
    description: `Publish a signed ContextDescriptor to your own pod. Use this whenever you want to record something on the Interego substrate — a memory, an observation, a proposal, an attestation, a decision. The descriptor is signed by your wallet (${LABEL}, ${DID}) and lands on your pod at ${POD_URL}. Other agents (and you, in future sessions) can discover it via discover_context.`,
    inputSchema: {
      type: 'object',
      properties: {
        graph_iri:    { type: 'string', description: 'The graph IRI this descriptor describes. Use a unique URN per descriptor (e.g., urn:holodeck:<your-label>:<topic>:<n>) so it is addressable.' },
        graph_content: { type: 'string', description: 'Turtle content of the graph. Include @prefix lines + RDF statements describing what you are recording. Wrap structured data as `ttt:payloadJson "<escaped-json>"` if you want to serialise a JSON object.' },
        modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'], description: 'Modal status — Asserted means you commit to truth; Hypothetical means tentative; Counterfactual means an alternative scenario.' },
        visibility:   { type: 'string', enum: ['public', 'private', 'shared'], description: 'public = anyone with your pod URL can read; shared = encrypted to specific recipients; private = encrypted to yourself only.' },
        descriptor_id:  { type: 'string', description: 'Optional explicit IRI for the descriptor itself. If absent, the relay generates one.' },
      },
      required: ['graph_iri', 'graph_content'],
    },
  },
  {
    name: 'discover_context',
    description: 'Read published descriptors from any pod on the Interego federation. Filter by pod_url (whose pod to look at — yours or a peer\'s) and optionally graph_iri (which graph). Returns recent descriptors newest-first. Use this to find out what other agents have done, or to recall your own prior writes.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url:   { type: 'string', description: 'Pod URL to query. Yours is ' + POD_URL + '. Peer pods follow the same eth-<addr> pattern.' },
        graph_iri: { type: 'string', description: 'Optional graph IRI filter (returns only descriptors describing this graph).' },
        limit:     { type: 'integer', description: 'Max entries to return (default 25).' },
        sort:      { type: 'string', enum: ['newest-first', 'oldest-first'], description: 'Sort order.' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'get_descriptor',
    description: 'Fetch a specific descriptor by its URL — returns the full JSON-LD envelope including all facets (provenance, trust, signature, etc).',
    inputSchema: {
      type: 'object',
      properties: { descriptor_url: { type: 'string' } },
      required: ['descriptor_url'],
    },
  },
  {
    name: 'record_trajectory_step',
    description: 'Record one step of your trajectory — what verb you applied to what object. Substrate-native dogfood that turns your action into discoverable evidence. Other agents can read your trajectory to understand what you have been doing.',
    inputSchema: {
      type: 'object',
      properties: {
        verb:         { type: 'string', description: 'A short verb describing the action (e.g., "decided", "proposed", "verified", "shipped").' },
        object_name:  { type: 'string', description: 'What the verb applied to.' },
        modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'] },
        granularity:  { type: 'string', enum: ['task', 'subtask', 'tool-call'] },
        result_success: { type: 'boolean' },
        result_note:  { type: 'string' },
      },
      required: ['verb', 'object_name'],
    },
  },
  {
    name: 'pgsl_decide',
    description: `Ask the substrate's OODA decision functor for what to do next, given what is currently known on your pod. Returns one of {exploit, explore, delegate, abstain} with a brief rationale.`,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'whoami',
    description: 'Return your own identity (label, DID, pod URL). Useful when you are unsure which holodeck agent you are.',
    inputSchema: { type: 'object', properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  try {
    let resultText;
    if (name === 'whoami') {
      resultText = JSON.stringify({ label: LABEL, did: DID, podUrl: POD_URL });
    } else if (name === 'publish_context') {
      const j = await signedToolCall({
        wallet, did: DID, toolName: 'publish_context',
        args: {
          graph_iri:    args.graph_iri,
          graph_content: args.graph_content,
          modal_status: args.modal_status ?? 'Asserted',
          visibility:   args.visibility ?? 'public',
          descriptor_id: args.descriptor_id,
          sign_authorship: false,
          auto_supersede_prior: false,
        },
      });
      resultText = JSON.stringify(stripEnvelope(j), null, 2);
    } else if (name === 'discover_context') {
      const j = await unsignedToolCall({
        toolName: 'discover_context',
        args: {
          pod_url:   args.pod_url ?? POD_URL,
          graph_iri: args.graph_iri,
          limit:     args.limit ?? 25,
          sort:      args.sort ?? 'newest-first',
        },
      });
      resultText = JSON.stringify(stripEnvelope(j), null, 2);
    } else if (name === 'get_descriptor') {
      // Relay's handleGetDescriptor expects `url`, not `descriptor_url`.
      const j = await unsignedToolCall({ toolName: 'get_descriptor', args: { url: args.descriptor_url } });
      resultText = JSON.stringify(stripEnvelope(j), null, 2);
    } else if (name === 'record_trajectory_step') {
      const j = await signedToolCall({
        wallet, did: DID, toolName: 'record_trajectory_step',
        args: {
          verb: args.verb,
          object_name: args.object_name,
          modal_status: args.modal_status ?? 'Asserted',
          granularity: args.granularity ?? 'tool-call',
          result_success: args.result_success,
          result_note: args.result_note,
          sign_authorship: false,
        },
      });
      resultText = JSON.stringify(stripEnvelope(j), null, 2);
    } else if (name === 'pgsl_decide') {
      const j = await unsignedToolCall({ toolName: 'pgsl_decide', args: { agent_id: DID, certificates: [] } });
      resultText = JSON.stringify(stripEnvelope(j), null, 2);
    } else {
      resultText = JSON.stringify({ error: `unknown tool: ${name}` });
    }
    return { content: [{ type: 'text', text: resultText }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
  }
});

function stripEnvelope(j) {
  if (!j || typeof j !== 'object') return j;
  // JSON-LD envelopes are noisy; trim @context and large affordance
  // arrays so the agent's context window doesn't get hammered.
  const { '@context': _ctx, affordances: _aff, ...rest } = j;
  return rest;
}

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[holodeck mcp-shim] ${LABEL} (${DID}) ready\n`);
