#!/usr/bin/env tsx
/**
 * MCP Relay — HTTP/SSE bridge for remote AI agents.
 *
 * Exposes the context-graphs MCP tools over HTTP so agents
 * running anywhere (not just localhost) can publish, discover,
 * and subscribe to context on the cloud-hosted Solid server.
 *
 * Endpoints:
 *   GET  /sse              — SSE stream (MCP over SSE transport)
 *   POST /messages         — MCP JSON-RPC messages
 *   GET  /health           — Health check
 *   GET  /tools            — List available tools (convenience)
 *   POST /tool/:name       — Call a tool directly via REST (convenience)
 */

import express from 'express';
import { WebSocket } from 'ws';

import {
  ContextDescriptor,
  toTurtle,
  validate,
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

const PORT = parseInt(process.env['PORT'] ?? '8080');
const CSS_URL = process.env['CSS_URL'] ?? 'http://localhost:3456/';

function log(msg: string): void {
  console.log(`[mcp-relay] ${msg}`);
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

// ── State ───────────────────────────────────────────────────

let subscriptions: Map<string, Subscription> = new Map();
let notificationLog: ContextChangeEvent[] = [];

// ── Tool Handlers ───────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

async function handlePublishContext(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  const agentId = (args.agent_id as string) ?? 'urn:agent:remote:unknown';
  const ownerWebId = (args.owner_webid as string) ?? `https://id.example.com/${podName}/profile#me`;
  const descId = (args.descriptor_id as string ?? `urn:cg:${podName}:${Date.now()}`) as IRI;
  const now = new Date().toISOString();

  // Ensure pod container exists
  await solidFetch(podUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });

  const builder = ContextDescriptor.create(descId)
    .describes((args.graph_iri as string) as IRI)
    .temporal({ validFrom: (args.valid_from as string) ?? now, validUntil: args.valid_until as string })
    .delegatedBy(ownerWebId as IRI, agentId as IRI, { endedAt: now })
    .semiotic({
      modalStatus: ((args.modal_status as string) ?? 'Asserted') as 'Asserted' | 'Hypothetical',
      epistemicConfidence: (args.confidence as number) ?? 0.85,
      groundTruth: ((args.modal_status as string) ?? 'Asserted') === 'Asserted',
    })
    .trust({
      trustLevel: 'SelfAsserted',
      issuer: ownerWebId as IRI,
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
    return JSON.stringify({ error: validation.violations.map(v => v.message) });
  }

  const result = await publish(descriptor, args.graph_content as string, podUrl, { fetch: solidFetch });

  return JSON.stringify({
    published: true,
    owner: ownerWebId,
    agent: agentId,
    pod: podUrl,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    manifestUrl: result.manifestUrl,
  });
}

async function handleDiscoverContext(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const filter: Record<string, unknown> = {};
  if (args.facet_type) filter.facetType = args.facet_type;
  if (args.valid_from) filter.validFrom = args.valid_from;
  if (args.valid_until) filter.validUntil = args.valid_until;

  const entries = await discover(
    podUrl,
    Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
    { fetch: solidFetch },
  );

  // Optionally include registry info
  let registry = null;
  if (args.verify_delegation) {
    const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (profile) {
      registry = {
        owner: profile.webId,
        name: profile.name,
        agents: profile.authorizedAgents.filter(a => !a.revoked).map(a => ({
          id: a.agentId, scope: a.scope, label: a.label,
        })),
      };
    }
  }

  return JSON.stringify({ entries, registry });
}

async function handleGetDescriptor(args: ToolArgs): Promise<string> {
  const resp = await solidFetch(args.url as string, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  });
  if (!resp.ok) {
    return JSON.stringify({ error: `${resp.status} ${resp.statusText}` });
  }
  return JSON.stringify({ url: args.url, turtle: await resp.text() });
}

async function handleGetPodStatus(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  const entries = await discover(podUrl, undefined, { fetch: solidFetch }).catch(() => []);
  const profile = await readAgentRegistry(podUrl, { fetch: solidFetch }).catch(() => null);

  return JSON.stringify({
    pod: podUrl,
    css: CSS_URL,
    registry: profile ? {
      owner: profile.webId,
      name: profile.name,
      agents: profile.authorizedAgents.filter(a => !a.revoked).length,
    } : null,
    descriptors: entries.length,
    entries,
    recentNotifications: notificationLog.slice(-10),
  });
}

async function handleSubscribeToPod(args: ToolArgs): Promise<string> {
  const podUrl = args.pod_url as string;
  if (subscriptions.has(podUrl)) {
    return JSON.stringify({ subscribed: true, message: 'Already subscribed' });
  }

  try {
    const sub = await subscribe(podUrl, (event: ContextChangeEvent) => {
      notificationLog.push(event);
      log(`[notification] ${event.type} on ${event.resource}`);
    }, {
      fetch: solidFetch,
      WebSocket: WebSocket as unknown as WebSocketConstructor,
    });
    subscriptions.set(podUrl, sub);
    return JSON.stringify({ subscribed: true, pod: podUrl });
  } catch (err) {
    return JSON.stringify({ subscribed: false, error: (err as Error).message });
  }
}

async function handleRegisterAgent(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  const ownerWebId = (args.owner_webid as string) as IRI;
  const agentId = (args.agent_id as string) as IRI;

  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (!profile) {
    profile = createOwnerProfile(ownerWebId, args.owner_name as string);
  }

  try {
    profile = addAuthorizedAgent(profile, {
      agentId,
      delegatedBy: ownerWebId,
      label: args.label as string,
      isSoftwareAgent: true,
      scope: (args.scope as 'ReadWrite') ?? 'ReadWrite',
      validFrom: new Date().toISOString(),
    });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }

  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });

  const agent = profile.authorizedAgents.find(a => a.agentId === agentId)!;
  const credential = createDelegationCredential(profile, agent, podUrl as IRI);
  const credUrl = await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });

  return JSON.stringify({ registered: true, agent: agentId, credential: credUrl });
}

async function handleVerifyAgent(args: ToolArgs): Promise<string> {
  const result = await verifyAgentDelegation(
    (args.agent_id as string) as IRI,
    args.pod_url as string,
    { fetch: solidFetch },
  );
  return JSON.stringify(result);
}

// ── Tool Registry ───────────────────────────────────────────

const TOOLS: Record<string, { description: string; handler: (args: ToolArgs) => Promise<string> }> = {
  publish_context: { description: 'Publish a context-annotated knowledge graph', handler: handlePublishContext },
  discover_context: { description: 'Discover descriptors on a pod', handler: handleDiscoverContext },
  get_descriptor: { description: 'Fetch a descriptor\'s Turtle', handler: handleGetDescriptor },
  get_pod_status: { description: 'Check pod status', handler: handleGetPodStatus },
  subscribe_to_pod: { description: 'Subscribe to pod notifications', handler: handleSubscribeToPod },
  register_agent: { description: 'Register an agent on a pod', handler: handleRegisterAgent },
  verify_agent: { description: 'Verify agent delegation', handler: handleVerifyAgent },
};

// ── Express App ─────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS for remote agents
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', css: CSS_URL, tools: Object.keys(TOOLS).length });
});

// List tools
app.get('/tools', (_req, res) => {
  res.json(Object.entries(TOOLS).map(([name, { description }]) => ({ name, description })));
});

// Call a tool directly via REST
app.post('/tool/:name', async (req, res) => {
  const tool = TOOLS[req.params.name];
  if (!tool) {
    res.status(404).json({ error: `Unknown tool: ${req.params.name}` });
    return;
  }

  try {
    const result = await tool.handler(req.body);
    res.json(JSON.parse(result));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// SSE endpoint for MCP-over-SSE
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connection', tools: Object.keys(TOOLS) })}\n\n`);

  // Forward notification events
  const interval = setInterval(() => {
    if (notificationLog.length > 0) {
      const recent = notificationLog.slice(-5);
      res.write(`data: ${JSON.stringify({ type: 'notifications', events: recent })}\n\n`);
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// MCP JSON-RPC over POST (simplified — for tools/list and tools/call)
app.post('/messages', async (req, res) => {
  const { method, params, id } = req.body;

  if (method === 'tools/list') {
    res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: Object.entries(TOOLS).map(([name, { description }]) => ({
          name,
          description,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const tool = TOOLS[params?.name];
    if (!tool) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${params?.name}` } });
      return;
    }

    try {
      const result = await tool.handler(params?.arguments ?? {});
      res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] } });
    } catch (err) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: (err as Error).message } });
    }
    return;
  }

  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`MCP Relay started on port ${PORT}`);
  log(`CSS: ${CSS_URL}`);
  log(`Endpoints:`);
  log(`  GET  /health     — Health check`);
  log(`  GET  /tools      — List tools`);
  log(`  POST /tool/:name — Call a tool via REST`);
  log(`  GET  /sse        — SSE stream`);
  log(`  POST /messages   — MCP JSON-RPC`);
});
