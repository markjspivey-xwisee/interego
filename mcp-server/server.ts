#!/usr/bin/env tsx
/**
 * @foxxi/context-graphs-mcp
 *
 * MCP server that gives AI coding agents (Claude Code, Codex, etc.)
 * the ability to publish, discover, and compose context-annotated
 * knowledge graphs through decentralized Solid pods.
 *
 * Identity model:
 *   The pod belongs to the OWNER (a human or org, identified by WebID).
 *   The agent is a DELEGATE that acts on the owner's behalf.
 *   The agent registry on the pod declares which agents are authorized.
 *   Descriptors carry: wasAttributedTo → owner, wasAssociatedWith → agent.
 *
 * Tools:
 *   publish_context     — Write a context descriptor + graph to your pod
 *   discover_context    — Find descriptors on any pod, with filters
 *   get_descriptor      — Fetch a specific descriptor's full Turtle
 *   subscribe_to_pod    — Watch a pod for changes via WebSocket
 *   get_pod_status      — Check what's on a pod
 *   register_agent      — Add an agent to the owner's registry
 *   revoke_agent        — Revoke an agent's delegation
 *   verify_agent        — Check if an agent is authorized on a pod
 *
 * Lifecycle:
 *   On first tool call, auto-starts a local Community Solid Server
 *   and provisions the owner's pod + agent registry.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import {
  ContextDescriptor,
  toTurtle,
  toJsonLdString,
  validate,
  intersection,
  union,
  publish,
  discover,
  subscribe,
  writeAgentRegistry,
  readAgentRegistry,
  writeDelegationCredential,
  verifyAgentDelegation,
  createOwnerProfile,
  addAuthorizedAgent,
  removeAuthorizedAgent,
  createDelegationCredential,
} from '@foxxi/context-graphs';

import type {
  IRI,
  ContextDescriptorData,
  OwnerProfileData,
  FetchFn,
  WebSocketConstructor,
  Subscription,
  ContextChangeEvent,
} from '@foxxi/context-graphs';

// ── Config ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PORT = parseInt(process.env['CG_PORT'] ?? '3456');
const BASE_URL = process.env['CG_BASE_URL'] ?? `http://localhost:${CSS_PORT}/`;
const MY_POD_NAME = process.env['CG_POD_NAME'] ?? 'agent';
const MY_POD = `${BASE_URL}${MY_POD_NAME}/`;
const MY_AGENT_ID = (process.env['CG_AGENT_ID'] ?? 'urn:agent:claude-code:local') as IRI;
const MY_OWNER_WEBID = (process.env['CG_OWNER_WEBID'] ?? `https://id.example.com/${MY_POD_NAME}/profile#me`) as IRI;
const MY_OWNER_NAME = process.env['CG_OWNER_NAME'] ?? undefined;
const MY_DID = (process.env['CG_DID'] ?? `did:web:${MY_POD_NAME}.local`) as IRI;
const CSS_CONFIG = resolve(__dirname, '..', 'examples', 'multi-agent', 'css-config.json');
const CSS_BIN = resolve(__dirname, 'node_modules', '.bin', 'community-solid-server');

// ── State ───────────────────────────────────────────────────

let cssProcess: ChildProcess | null = null;
let cssReady = false;
let registryInitialized = false;
let mySubscriptions: Map<string, Subscription> = new Map();
let notificationLog: ContextChangeEvent[] = [];
let lastPublishedDescriptor: ContextDescriptorData | null = null;

// ── Logging (stderr only — stdout is MCP protocol) ──────────

function log(msg: string): void {
  process.stderr.write(`[context-graphs-mcp] ${msg}\n`);
}

// ── Fetch wrapper ───────────────────────────────────────────

const solidFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: { get: (n: string) => resp.headers.get(n) },
    text: () => resp.text(),
    json: () => resp.json(),
  };
};

// ── CSS Lifecycle ───────────────────────────────────────────

async function ensureCSS(): Promise<void> {
  if (cssReady) return;

  // Check if CSS is already running externally
  try {
    const resp = await fetch(BASE_URL);
    if (resp.ok || resp.status < 500) {
      cssReady = true;
      log(`CSS already running at ${BASE_URL}`);
      await ensurePod();
      return;
    }
  } catch { /* not running */ }

  log(`Starting CSS on port ${CSS_PORT}...`);

  return new Promise((res, rej) => {
    const proc = spawn(CSS_BIN, [
      '-c', CSS_CONFIG,
      '-p', String(CSS_PORT),
      '-l', 'warn',
      '--baseUrl', BASE_URL,
    ], { stdio: ['ignore', 'pipe', 'pipe'], shell: true });

    cssProcess = proc;
    let started = false;

    proc.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) log(`[css] ${text}`);
    });

    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try {
        const resp = await fetch(BASE_URL);
        if (resp.ok || resp.status < 500) {
          clearInterval(poll);
          started = true;
          cssReady = true;
          log(`CSS ready at ${BASE_URL}`);
          await ensurePod();
          res();
        }
      } catch { /* not ready */ }
    }, 400);

    setTimeout(() => { clearInterval(poll); if (!started) rej(new Error('CSS startup timeout')); }, 30_000);
  });
}

async function ensurePod(): Promise<void> {
  await fetch(MY_POD, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });
  log(`Pod ready: ${MY_POD}`);
}

/**
 * Ensure the agent registry exists on the pod and this agent is registered.
 */
async function ensureRegistry(): Promise<void> {
  if (registryInitialized) return;

  let profile = await readAgentRegistry(MY_POD, { fetch: solidFetch });

  if (!profile) {
    log(`Creating agent registry for owner ${MY_OWNER_WEBID}`);
    profile = createOwnerProfile(MY_OWNER_WEBID, MY_OWNER_NAME);
  }

  // Check if this agent is already registered
  const existing = profile.authorizedAgents.find(a => a.agentId === MY_AGENT_ID && !a.revoked);
  if (!existing) {
    log(`Registering agent ${MY_AGENT_ID} on behalf of ${MY_OWNER_WEBID}`);
    profile = addAuthorizedAgent(profile, {
      agentId: MY_AGENT_ID,
      delegatedBy: MY_OWNER_WEBID,
      label: MY_AGENT_ID.includes('vscode') ? 'Claude Code (VS Code)' :
             MY_AGENT_ID.includes('desktop') ? 'Claude Code (Desktop)' :
             MY_AGENT_ID.includes('codex') ? 'Codex CLI' :
             'AI Agent',
      isSoftwareAgent: true,
      scope: 'ReadWrite',
      validFrom: new Date().toISOString(),
    });

    await writeAgentRegistry(profile, MY_POD, { fetch: solidFetch });

    // Also write a delegation credential
    const agent = profile.authorizedAgents.find(a => a.agentId === MY_AGENT_ID)!;
    const credential = createDelegationCredential(profile, agent, MY_POD as IRI);
    await writeDelegationCredential(credential, MY_POD, { fetch: solidFetch });
    log(`Delegation credential written for ${MY_AGENT_ID}`);
  }

  registryInitialized = true;
  log(`Agent registry initialized — ${profile.authorizedAgents.filter(a => !a.revoked).length} active agent(s)`);
}

function stopCSS(): void {
  for (const [, sub] of mySubscriptions) sub.unsubscribe();
  mySubscriptions.clear();
  if (cssProcess) {
    cssProcess.kill('SIGTERM');
    cssProcess = null;
    cssReady = false;
  }
}

// ── Tool implementations ────────────────────────────────────

async function toolPublishContext(args: {
  graph_iri: string;
  graph_content: string;
  descriptor_id?: string;
  confidence?: number;
  modal_status?: string;
  task_description?: string;
  valid_from?: string;
  valid_until?: string;
  target_pod?: string;
}): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const podUrl = args.target_pod ?? MY_POD;
  const descId = (args.descriptor_id ?? `urn:cg:${MY_POD_NAME}:${Date.now()}`) as IRI;
  const now = new Date().toISOString();

  // Build descriptor with proper owner/agent delegation
  const builder = ContextDescriptor.create(descId)
    .describes(args.graph_iri as IRI)
    .temporal({
      validFrom: args.valid_from ?? now,
      validUntil: args.valid_until,
    })
    // Owner attribution: wasAttributedTo → owner, wasAssociatedWith → agent
    .delegatedBy(MY_OWNER_WEBID, MY_AGENT_ID, { endedAt: now })
    .semiotic({
      modalStatus: (args.modal_status as 'Asserted' | 'Hypothetical') ?? 'Asserted',
      epistemicConfidence: args.confidence ?? 0.85,
      groundTruth: (args.modal_status ?? 'Asserted') === 'Asserted',
    })
    .trust({
      trustLevel: 'SelfAsserted',
      issuer: MY_OWNER_WEBID,
      verifiableCredential: `${podUrl}credentials/${encodeURIComponent(MY_AGENT_ID)}.jsonld` as IRI,
    })
    .federation({
      origin: podUrl as IRI,
      storageEndpoint: podUrl as IRI,
      syncProtocol: 'SolidNotifications',
    })
    .version(1);

  const descriptor = builder.build();
  const validation = validate(descriptor);
  if (!validation.conforms) {
    return `Validation failed: ${validation.violations.map(v => v.message).join('; ')}`;
  }

  const result = await publish(descriptor, args.graph_content, podUrl, { fetch: solidFetch });
  lastPublishedDescriptor = descriptor;

  return [
    `Published to ${podUrl}`,
    `  Owner: ${MY_OWNER_WEBID}`,
    `  Agent: ${MY_AGENT_ID}`,
    `  Descriptor: ${result.descriptorUrl}`,
    `  Graph: ${result.graphUrl}`,
    `  Manifest: ${result.manifestUrl}`,
    `  Facets: ${descriptor.facets.map(f => f.type).join(', ')}`,
    `  Confidence: ${args.confidence ?? 0.85}`,
    args.task_description ? `  Task: ${args.task_description}` : '',
    '',
    'Turtle:',
    toTurtle(descriptor),
  ].filter(Boolean).join('\n');
}

async function toolDiscoverContext(args: {
  pod_url: string;
  facet_type?: string;
  valid_from?: string;
  valid_until?: string;
  verify_delegation?: boolean;
}): Promise<string> {
  await ensureCSS();

  const filter: Record<string, unknown> = {};
  if (args.facet_type) filter.facetType = args.facet_type;
  if (args.valid_from) filter.validFrom = args.valid_from;
  if (args.valid_until) filter.validUntil = args.valid_until;

  const entries = await discover(
    args.pod_url,
    Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
    { fetch: solidFetch },
  );

  if (entries.length === 0) {
    return `No context descriptors found on ${args.pod_url}`;
  }

  const lines: string[] = [`Found ${entries.length} descriptor(s) on ${args.pod_url}:`, ''];

  // Check delegation if requested
  if (args.verify_delegation) {
    const profile = await readAgentRegistry(args.pod_url, { fetch: solidFetch });
    if (profile) {
      lines.push(`  Pod owner: ${profile.webId}${profile.name ? ` (${profile.name})` : ''}`);
      lines.push(`  Authorized agents: ${profile.authorizedAgents.filter(a => !a.revoked).length}`);
      for (const a of profile.authorizedAgents.filter(a => !a.revoked)) {
        lines.push(`    - ${a.agentId} [${a.scope}]${a.label ? ` — ${a.label}` : ''}`);
      }
      lines.push('');
    } else {
      lines.push('  ⚠ No agent registry found — delegation unverifiable');
      lines.push('');
    }
  }

  for (const entry of entries) {
    lines.push(`  ${entry.descriptorUrl}`);
    lines.push(`    Describes: ${entry.describes.join(', ')}`);
    lines.push(`    Facets: ${entry.facetTypes.join(', ')}`);
    if (entry.validFrom) lines.push(`    Valid: ${entry.validFrom} — ${entry.validUntil ?? '...'}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function toolGetDescriptor(args: { url: string }): Promise<string> {
  await ensureCSS();

  const resp = await fetch(args.url, { headers: { 'Accept': 'text/turtle' } });
  if (!resp.ok) {
    return `Failed to fetch ${args.url}: ${resp.status} ${resp.statusText}`;
  }

  const turtle = await resp.text();
  return `Descriptor at ${args.url} (${turtle.length} bytes):\n\n${turtle}`;
}

async function toolGetPodStatus(args: { pod_url?: string }): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const podUrl = args.pod_url ?? MY_POD;
  const isMyPod = podUrl === MY_POD;

  const lines: string[] = [
    `Pod: ${podUrl}`,
    `Owner: ${isMyPod ? MY_OWNER_WEBID : '(check registry)'}`,
    `Agent: ${isMyPod ? MY_AGENT_ID : '(this is a remote pod)'}`,
    `CSS: ${cssReady ? 'running' : 'stopped'} at ${BASE_URL}`,
    '',
  ];

  // Check agent registry
  try {
    const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (profile) {
      lines.push(`Registry:`);
      lines.push(`  Owner: ${profile.webId}${profile.name ? ` (${profile.name})` : ''}`);
      const active = profile.authorizedAgents.filter(a => !a.revoked);
      lines.push(`  Agents: ${active.length} active`);
      for (const a of active) {
        const label = a.label ? ` — ${a.label}` : '';
        lines.push(`    ${a.agentId} [${a.scope}]${label}`);
      }
    } else {
      lines.push('Registry: not found');
    }
  } catch (err) {
    lines.push(`Registry: ${(err as Error).message}`);
  }

  lines.push('');

  // Descriptors
  try {
    const entries = await discover(podUrl, undefined, { fetch: solidFetch });
    lines.push(`Descriptors: ${entries.length}`);
    for (const e of entries) {
      lines.push(`  ${e.descriptorUrl}`);
      lines.push(`    Graphs: ${e.describes.join(', ')}`);
      lines.push(`    Facets: ${e.facetTypes.join(', ')}`);
    }
  } catch (err) {
    lines.push(`Manifest: ${(err as Error).message}`);
  }

  if (notificationLog.length > 0) {
    lines.push('');
    lines.push(`Recent notifications (${notificationLog.length}):`);
    for (const n of notificationLog.slice(-5)) {
      lines.push(`  [${n.type}] ${n.resource} at ${n.timestamp}`);
    }
  }

  return lines.join('\n');
}

async function toolSubscribeToPod(args: { pod_url: string }): Promise<string> {
  await ensureCSS();

  if (mySubscriptions.has(args.pod_url)) {
    return `Already subscribed to ${args.pod_url}`;
  }

  try {
    const sub = await subscribe(args.pod_url, (event: ContextChangeEvent) => {
      notificationLog.push(event);
      log(`[notification] ${event.type} on ${event.resource}`);
    }, {
      fetch: solidFetch,
      WebSocket: WebSocket as unknown as WebSocketConstructor,
    });

    mySubscriptions.set(args.pod_url, sub);
    return `Subscribed to ${args.pod_url} via WebSocket. Will receive live notifications when context changes.`;
  } catch (err) {
    return `Failed to subscribe to ${args.pod_url}: ${(err as Error).message}`;
  }
}

async function toolRegisterAgent(args: {
  agent_id: string;
  label?: string;
  scope?: string;
  valid_until?: string;
}): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  let profile = await readAgentRegistry(MY_POD, { fetch: solidFetch });
  if (!profile) {
    profile = createOwnerProfile(MY_OWNER_WEBID, MY_OWNER_NAME);
  }

  const scope = (args.scope ?? 'ReadWrite') as 'ReadWrite' | 'ReadOnly' | 'PublishOnly' | 'DiscoverOnly';

  try {
    profile = addAuthorizedAgent(profile, {
      agentId: args.agent_id as IRI,
      delegatedBy: MY_OWNER_WEBID,
      label: args.label,
      isSoftwareAgent: true,
      scope,
      validFrom: new Date().toISOString(),
      validUntil: args.valid_until,
    });
  } catch (err) {
    return (err as Error).message;
  }

  await writeAgentRegistry(profile, MY_POD, { fetch: solidFetch });

  // Write delegation credential
  const agent = profile.authorizedAgents.find(a => a.agentId === args.agent_id)!;
  const credential = createDelegationCredential(profile, agent, MY_POD as IRI);
  const credUrl = await writeDelegationCredential(credential, MY_POD, { fetch: solidFetch });

  return [
    `Registered agent ${args.agent_id}`,
    `  Delegated by: ${MY_OWNER_WEBID}`,
    `  Scope: ${scope}`,
    `  Credential: ${credUrl}`,
    `  Registry: ${MY_POD}agents`,
  ].join('\n');
}

async function toolRevokeAgent(args: { agent_id: string }): Promise<string> {
  await ensureCSS();

  let profile = await readAgentRegistry(MY_POD, { fetch: solidFetch });
  if (!profile) {
    return 'No agent registry found on this pod.';
  }

  profile = removeAuthorizedAgent(profile, args.agent_id as IRI);
  await writeAgentRegistry(profile, MY_POD, { fetch: solidFetch });

  return `Revoked delegation for ${args.agent_id}. Agent can no longer act on behalf of ${MY_OWNER_WEBID}.`;
}

async function toolVerifyAgent(args: {
  agent_id: string;
  pod_url: string;
}): Promise<string> {
  await ensureCSS();

  const result = await verifyAgentDelegation(
    args.agent_id as IRI,
    args.pod_url,
    { fetch: solidFetch },
  );

  if (result.valid) {
    return [
      `VALID — Agent ${result.agent} is authorized`,
      `  Owner: ${result.owner}`,
      `  Scope: ${result.scope}`,
      `  Pod: ${args.pod_url}`,
    ].join('\n');
  } else {
    return [
      `INVALID — ${result.reason}`,
      `  Agent: ${result.agent}`,
      result.owner ? `  Owner: ${result.owner}` : '',
      `  Pod: ${args.pod_url}`,
    ].filter(Boolean).join('\n');
  }
}

// ── MCP Server ──────────────────────────────────────────────

const mcpServer = new Server(
  { name: '@foxxi/context-graphs-mcp', version: '0.2.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// Tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'publish_context',
      description: 'Publish a context-annotated knowledge graph to your Solid pod on behalf of the pod owner. The descriptor includes owner attribution (wasAttributedTo → owner, wasAssociatedWith → agent), semiotic frame, trust with delegation credential, and federation metadata.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          graph_iri: { type: 'string', description: 'IRI for the named graph (e.g. urn:graph:project:arch-v1)' },
          graph_content: { type: 'string', description: 'RDF Turtle content of the knowledge graph' },
          descriptor_id: { type: 'string', description: 'Optional IRI for the descriptor (auto-generated if omitted)' },
          confidence: { type: 'number', description: 'Epistemic confidence 0.0-1.0 (default 0.85)' },
          modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'], description: 'Semiotic modal status (default: Asserted)' },
          task_description: { type: 'string', description: 'What task produced this context (for provenance)' },
          valid_from: { type: 'string', description: 'ISO 8601 start of validity (default: now)' },
          valid_until: { type: 'string', description: 'ISO 8601 end of validity (optional)' },
          target_pod: { type: 'string', description: 'Pod URL to publish to (default: your own pod)' },
        },
        required: ['graph_iri', 'graph_content'],
      },
    },
    {
      name: 'discover_context',
      description: 'Discover context descriptors published on any Solid pod. Optionally verify the agent delegation chain to confirm the pod owner authorized the publishing agent.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to discover from' },
          facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
          valid_from: { type: 'string', description: 'Filter: valid at or after this datetime' },
          valid_until: { type: 'string', description: 'Filter: valid at or before this datetime' },
          verify_delegation: { type: 'boolean', description: 'If true, also fetch and display the agent registry to verify delegation' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'get_descriptor',
      description: 'Fetch the full Turtle content of a specific context descriptor from a Solid pod.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Full URL of the descriptor resource' },
        },
        required: ['url'],
      },
    },
    {
      name: 'subscribe_to_pod',
      description: 'Subscribe to live notifications from a Solid pod via WebSocket.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to subscribe to' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'get_pod_status',
      description: 'Check the current status of a Solid pod — owner, authorized agents, descriptors, and recent notifications.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Pod URL to check (default: your own pod)' },
        },
      },
    },
    {
      name: 'register_agent',
      description: 'Register a new AI agent as authorized to act on behalf of the pod owner. Writes to the agent registry and creates a delegation credential.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'The agent identity IRI (e.g. urn:agent:anthropic:claude-code:desktop)' },
          label: { type: 'string', description: 'Human-readable label (e.g. "Claude Code (Desktop)")' },
          scope: { type: 'string', enum: ['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'], description: 'Delegation scope (default: ReadWrite)' },
          valid_until: { type: 'string', description: 'ISO 8601 expiration date (optional)' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'revoke_agent',
      description: 'Revoke an agent\'s delegation. The agent will no longer be authorized to act on the pod owner\'s behalf.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'The agent identity IRI to revoke' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'verify_agent',
      description: 'Verify that a specific agent is authorized on a pod by checking the pod\'s agent registry. Use this before trusting context from another pod.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'The agent identity IRI to verify' },
          pod_url: { type: 'string', description: 'The pod URL to check against' },
        },
        required: ['agent_id', 'pod_url'],
      },
    },
  ],
}));

// Tool dispatch
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: string;

    switch (name) {
      case 'publish_context':
        result = await toolPublishContext(args as Parameters<typeof toolPublishContext>[0]);
        break;
      case 'discover_context':
        result = await toolDiscoverContext(args as Parameters<typeof toolDiscoverContext>[0]);
        break;
      case 'get_descriptor':
        result = await toolGetDescriptor(args as Parameters<typeof toolGetDescriptor>[0]);
        break;
      case 'subscribe_to_pod':
        result = await toolSubscribeToPod(args as Parameters<typeof toolSubscribeToPod>[0]);
        break;
      case 'get_pod_status':
        result = await toolGetPodStatus(args as Parameters<typeof toolGetPodStatus>[0]);
        break;
      case 'register_agent':
        result = await toolRegisterAgent(args as Parameters<typeof toolRegisterAgent>[0]);
        break;
      case 'revoke_agent':
        result = await toolRevokeAgent(args as Parameters<typeof toolRevokeAgent>[0]);
        break;
      case 'verify_agent':
        result = await toolVerifyAgent(args as Parameters<typeof toolVerifyAgent>[0]);
        break;
      default:
        result = `Unknown tool: ${name}`;
    }

    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// Resources
mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: `solid://${MY_POD_NAME}/manifest`,
      name: 'My Pod Manifest',
      description: `Context descriptors published to ${MY_POD}`,
      mimeType: 'text/turtle',
    },
    {
      uri: `solid://${MY_POD_NAME}/agents`,
      name: 'Agent Registry',
      description: `Authorized agents for ${MY_OWNER_WEBID}`,
      mimeType: 'text/turtle',
    },
  ],
}));

mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === `solid://${MY_POD_NAME}/manifest`) {
    try {
      await ensureCSS();
      const resp = await fetch(`${MY_POD}.well-known/context-graphs`, { headers: { 'Accept': 'text/turtle' } });
      const body = resp.ok ? await resp.text() : '# No manifest yet';
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: body }] };
    } catch {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: '# Solid server not running' }] };
    }
  }
  if (request.params.uri === `solid://${MY_POD_NAME}/agents`) {
    try {
      await ensureCSS();
      const resp = await fetch(`${MY_POD}agents`, { headers: { 'Accept': 'text/turtle' } });
      const body = resp.ok ? await resp.text() : '# No agent registry yet';
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: body }] };
    } catch {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: '# Solid server not running' }] };
    }
  }
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// ── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log('Starting Context Graphs MCP server v0.2.0...');
  log(`Owner: ${MY_OWNER_WEBID}${MY_OWNER_NAME ? ` (${MY_OWNER_NAME})` : ''}`);
  log(`Agent: ${MY_AGENT_ID}`);
  log(`DID: ${MY_DID}`);
  log(`Pod: ${MY_POD}`);

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log('MCP server connected via stdio');
}

process.on('SIGINT', () => { stopCSS(); process.exit(0); });
process.on('SIGTERM', () => { stopCSS(); process.exit(0); });
process.on('exit', () => { stopCSS(); });

main().catch((err) => {
  log(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
