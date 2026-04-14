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
  fetchPodDirectory,
  publishPodDirectory,
  resolveWebFinger,
  pinToIpfs,
  cryptoComputeCid,
  toTurtle,
} from '@interego/core';

import type {
  IRI,
  ContextDescriptorData,
  OwnerProfileData,
  PodDirectoryData,
  PodDirectoryEntry,
  FetchFn,
  WebSocketConstructor,
  Subscription,
  ContextChangeEvent,
  ManifestEntry,
} from '@interego/core';

// ── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env['PORT'] ?? '8080');
const CSS_URL = process.env['CSS_URL'] ?? 'http://localhost:3456/';
const IDENTITY_URL = process.env['IDENTITY_URL'] ?? 'http://localhost:8090';

// Org-level IPFS/CDP keys — used as defaults when users don't provide their own
const ORG_IPFS_PROVIDER = (process.env['IPFS_PROVIDER'] ?? 'local') as 'pinata' | 'web3storage' | 'local';
const ORG_IPFS_API_KEY = process.env['IPFS_API_KEY'] ?? '';
const ORG_CDP_API_KEY_NAME = process.env['CDP_API_KEY_NAME'] ?? '';
const ORG_CDP_API_KEY_PRIVATE = process.env['CDP_API_KEY_PRIVATE'] ?? '';

/**
 * Resolve IPFS config: user override (from request headers) > org default > local
 */
function resolveIpfsConfig(req: any): { provider: 'pinata' | 'web3storage' | 'local'; apiKey: string } {
  const userProvider = req.headers?.['x-ipfs-provider'] as string | undefined;
  const userKey = req.headers?.['x-ipfs-api-key'] as string | undefined;

  if (userProvider && userKey) {
    return { provider: userProvider as any, apiKey: userKey };
  }
  return { provider: ORG_IPFS_PROVIDER, apiKey: ORG_IPFS_API_KEY };
}

function log(msg: string): void {
  console.log(`[mcp-relay] ${msg}`);
}

// ── Auth Middleware ──────────────────────────────────────────

// Tools that require authentication (write operations)
const AUTH_REQUIRED_TOOLS = new Set([
  'publish_context', 'register_agent', 'revoke_agent',
  'publish_directory',
]);

// Tools that are public (read operations)
const PUBLIC_TOOLS = new Set([
  'discover_context', 'get_descriptor', 'get_pod_status',
  'subscribe_to_pod', 'discover_all', 'list_known_pods',
  'add_pod', 'remove_pod', 'discover_directory', 'resolve_webfinger',
  'verify_agent',
]);

interface AuthResult {
  authenticated: boolean;
  userId?: string;
  agentId?: string;
  scope?: string;
  error?: string;
}

async function verifyBearerToken(authHeader: string | undefined): Promise<AuthResult> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { authenticated: false, error: 'Bearer token required' };
  }
  const token = authHeader.slice(7);

  try {
    const resp = await fetch(`${IDENTITY_URL}/tokens/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) return { authenticated: false, error: `Identity server error: ${resp.status}` };
    const data = await resp.json() as { valid: boolean; userId?: string; agentId?: string; scope?: string; reason?: string };
    if (data.valid) {
      return { authenticated: true, userId: data.userId, agentId: data.agentId, scope: data.scope };
    }
    return { authenticated: false, error: data.reason ?? 'Invalid token' };
  } catch (err) {
    return { authenticated: false, error: `Cannot reach identity server: ${(err as Error).message}` };
  }
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

  // Pin to IPFS if configured (org-level or user override)
  const ipfsConfig = resolveIpfsConfig(args._req ?? {});
  let ipfs: { cid?: string; url?: string; provider?: string } = {};
  if (ipfsConfig.provider !== 'local' && ipfsConfig.apiKey) {
    try {
      const turtle = toTurtle(descriptor);
      const pinResult = await pinToIpfs(turtle, `descriptor-${descriptor.id}`, ipfsConfig, solidFetch);
      ipfs = { cid: pinResult.cid, url: pinResult.url, provider: pinResult.provider };
    } catch (err) {
      ipfs = { cid: `error: ${(err as Error).message}` };
    }
  } else {
    const turtle = toTurtle(descriptor);
    ipfs = { cid: cryptoComputeCid(turtle), provider: 'local' };
  }

  return JSON.stringify({
    published: true,
    owner: ownerWebId,
    agent: agentId,
    pod: podUrl,
    descriptorUrl: result.descriptorUrl,
    graphUrl: result.graphUrl,
    manifestUrl: result.manifestUrl,
    ipfs,
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

// ── Federation Tool Handlers ────────────────────────────────

// Simple in-memory pod registry for the relay
const knownPods: Map<string, { url: string; label?: string; owner?: string; via: string }> = new Map();

async function handleDiscoverAll(args: ToolArgs): Promise<string> {
  const pods = [...knownPods.values()];
  if (pods.length === 0) {
    return JSON.stringify({ message: 'No known pods. Use add_pod or discover_directory first.' });
  }

  const results: Array<{ pod: string; entries: ManifestEntry[]; error?: string }> = [];
  await Promise.allSettled(pods.map(async (pod) => {
    try {
      const filter: Record<string, unknown> = {};
      if (args.facet_type) filter.facetType = args.facet_type;
      const entries = await discover(
        pod.url,
        Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
        { fetch: solidFetch },
      );
      results.push({ pod: pod.url, entries });
    } catch (err) {
      results.push({ pod: pod.url, entries: [], error: (err as Error).message });
    }
  }));

  return JSON.stringify({ pods: results.length, results });
}

async function handleListKnownPods(_args: ToolArgs): Promise<string> {
  return JSON.stringify([...knownPods.values()]);
}

async function handleAddPod(args: ToolArgs): Promise<string> {
  const url = args.pod_url as string;
  knownPods.set(url, {
    url,
    label: args.label as string | undefined,
    owner: args.owner as string | undefined,
    via: 'manual',
  });
  return JSON.stringify({ added: true, url, total: knownPods.size });
}

async function handleRemovePod(args: ToolArgs): Promise<string> {
  const url = args.pod_url as string;
  const removed = knownPods.delete(url);
  return JSON.stringify({ removed, url, total: knownPods.size });
}

async function handleDiscoverDirectory(args: ToolArgs): Promise<string> {
  const directory = await fetchPodDirectory(args.directory_url as string, { fetch: solidFetch });
  let added = 0;
  for (const entry of directory.entries) {
    if (!knownPods.has(entry.podUrl)) added++;
    knownPods.set(entry.podUrl, {
      url: entry.podUrl,
      label: entry.label,
      owner: entry.owner,
      via: 'directory',
    });
  }
  return JSON.stringify({ imported: directory.entries.length, added, total: knownPods.size });
}

async function handlePublishDirectory(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  const entries: PodDirectoryEntry[] = [...knownPods.values()].map(p => ({
    podUrl: p.url as IRI,
    owner: p.owner as IRI | undefined,
    label: p.label,
  }));
  const directory: PodDirectoryData = {
    id: (args.directory_id as string ?? `urn:directory:${podName}`) as IRI,
    entries,
  };
  const url = await publishPodDirectory(directory, podUrl, { fetch: solidFetch });
  return JSON.stringify({ published: true, url, entries: entries.length });
}

async function handleResolveWebfinger(args: ToolArgs): Promise<string> {
  const result = await resolveWebFinger(args.resource as string, { fetch: solidFetch });
  if (result.podUrl) {
    knownPods.set(result.podUrl, {
      url: result.podUrl,
      via: 'webfinger',
    });
  }
  return JSON.stringify(result);
}

async function handleRevokeAgent(args: ToolArgs): Promise<string> {
  const podName = (args.pod_name as string) ?? 'default';
  const podUrl = `${CSS_URL}${podName}/`;
  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (!profile) return JSON.stringify({ error: 'No registry found' });
  profile = removeAuthorizedAgent(profile, (args.agent_id as string) as IRI);
  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });
  return JSON.stringify({ revoked: true, agent: args.agent_id });
}

// ── Tool Registry ───────────────────────────────────────────

const TOOLS: Record<string, { description: string; handler: (args: ToolArgs) => Promise<string> }> = {
  // Core tools
  publish_context: { description: 'Publish a context-annotated knowledge graph', handler: handlePublishContext },
  discover_context: { description: 'Discover descriptors on a pod', handler: handleDiscoverContext },
  get_descriptor: { description: 'Fetch a descriptor\'s Turtle', handler: handleGetDescriptor },
  get_pod_status: { description: 'Check pod status', handler: handleGetPodStatus },
  subscribe_to_pod: { description: 'Subscribe to pod notifications', handler: handleSubscribeToPod },
  register_agent: { description: 'Register an agent on a pod', handler: handleRegisterAgent },
  revoke_agent: { description: 'Revoke an agent delegation', handler: handleRevokeAgent },
  verify_agent: { description: 'Verify agent delegation', handler: handleVerifyAgent },
  // Federation tools
  discover_all: { description: 'Discover across all known pods', handler: handleDiscoverAll },
  list_known_pods: { description: 'List pods in the federation registry', handler: handleListKnownPods },
  add_pod: { description: 'Add a pod to the registry', handler: handleAddPod },
  remove_pod: { description: 'Remove a pod from the registry', handler: handleRemovePod },
  discover_directory: { description: 'Import pods from a directory graph', handler: handleDiscoverDirectory },
  publish_directory: { description: 'Publish pod registry as a directory', handler: handlePublishDirectory },
  resolve_webfinger: { description: 'Resolve WebFinger to find a pod', handler: handleResolveWebfinger },
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
  res.json({ status: 'ok', css: CSS_URL, tools: Object.keys(TOOLS).length, auth: 'bearer-token', x402: true });
});

// ── X402 Payment Required ───────────────────────────────────
// Descriptors can optionally require payment. The relay returns
// HTTP 402 with X-Payment-Required headers per the X402 spec.

const PAYMENT_REQUIRED_PODS = new Map<string, { amount: string; currency: string; address: string }>();

app.post('/x402/set-price', async (req, res) => {
  const auth = await verifyBearerToken(req.headers.authorization);
  if (!auth.authenticated) { res.status(401).json({ error: auth.error }); return; }

  const { pod_url, amount, currency, address } = req.body;
  if (!pod_url || !amount || !currency || !address) {
    res.status(400).json({ error: 'pod_url, amount, currency, and address are required' });
    return;
  }
  PAYMENT_REQUIRED_PODS.set(pod_url, { amount, currency, address });
  res.json({ set: true, pod: pod_url, amount, currency });
});

app.get('/x402/price/:podName', (req, res) => {
  const podUrl = `${CSS_URL}${req.params.podName}/`;
  const price = PAYMENT_REQUIRED_PODS.get(podUrl);
  if (!price) {
    res.json({ paymentRequired: false, pod: podUrl });
  } else {
    res.status(402).json({
      paymentRequired: true,
      pod: podUrl,
...price,
      x402: {
        version: '1',
        accepts: [{ network: 'ethereum', token: price.currency, amount: price.amount, address: price.address }],
      },
    });
  }
});

// List tools
app.get('/tools', (_req, res) => {
  res.json(Object.entries(TOOLS).map(([name, { description }]) => ({ name, description })));
});

// Call a tool directly via REST (auth enforced on write operations)
app.post('/tool/:name', async (req, res) => {
  const toolName = req.params.name;
  const tool = TOOLS[toolName];
  if (!tool) {
    res.status(404).json({ error: `Unknown tool: ${toolName}` });
    return;
  }

  // Auth check for write operations
  if (AUTH_REQUIRED_TOOLS.has(toolName)) {
    const auth = await verifyBearerToken(req.headers.authorization);
    if (!auth.authenticated) {
      res.status(401).json({
        error: 'Authentication required for write operations',
        detail: auth.error,
        hint: `POST ${IDENTITY_URL}/register to create an account and get a token`,
      });
      return;
    }
    // Inject authenticated identity into args if not provided
    if (!req.body.agent_id) req.body.agent_id = auth.agentId;
    if (!req.body.owner_webid) req.body.owner_webid = `${IDENTITY_URL}/users/${auth.userId}/profile#me`;
    if (!req.body.pod_name) req.body.pod_name = auth.userId;
  }

  try {
    const result = await tool.handler({...req.body, _req: req });
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
