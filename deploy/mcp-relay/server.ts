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
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InteregoOAuthProvider } from './oauth-provider.js';

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
  generateKeyPair,
  fetchGraphContent,
  type EncryptionKeyPair,
  resolveRecipients,
  parseDistributionFromDescriptorTurtle,
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

// OAuth 2.1 auth config for /mcp. This is the real auth path used by
// claude.ai custom connectors and any MCP client that speaks OAuth.
// RELAY_MCP_API_KEY still works as a legacy fallback for tooling that can
// set an Authorization header directly (local curl, scripts).
const RELAY_MCP_API_KEY = process.env['RELAY_MCP_API_KEY'] ?? '';

// Public base URL of THIS relay (used as the OAuth issuer + resource URL).
// Must be set in production so the OAuth metadata advertises the correct
// externally-reachable URL. Falls back to constructing from request host.
const PUBLIC_BASE_URL = process.env['PUBLIC_BASE_URL'] ?? '';

// Surface-agent prefix this relay uses when minting per-user agents on
// identity. Every user who authenticates through this relay gets a
// distinct `<surface>-<userId>` agent on their pod (own DID, own X25519
// key, own revocation point).
//
// By default the surface is auto-detected from the OAuth client's
// DCR-registered `client_name` (see `surfaceAgentFromClient` below).
// RELAY_DEFAULT_SURFACE_AGENT overrides the fallback used when the
// client name matches nothing known — set it per-deployment if you want
// a fixed label (e.g. a dedicated mobile relay). Previous deployments
// set this to `claude-mobile`; the new default is the generic
// `mcp-client` so unknown clients don't masquerade as Claude.
const RELAY_DEFAULT_SURFACE_AGENT = process.env['RELAY_DEFAULT_SURFACE_AGENT']
  ?? process.env['RELAY_SURFACE_AGENT']   // legacy env name
  ?? 'mcp-client';

// Best-effort client-name → surface-slug mapping. We match on a
// lowercased, trimmed version of `client_name` so small spelling
// variations all collapse to the same slug. Keep the slug in the
// `^[a-z][a-z0-9-]*$` shape so it's safe as part of an agent IRI path.
// Ordering matters: first substring match wins. Fall back to
// RELAY_DEFAULT_SURFACE_AGENT if no pattern matches.
const SURFACE_PATTERNS: Array<[RegExp, string]> = [
  // Anthropic Claude surfaces — leave room to split further by platform
  // hint words ("mobile", "desktop", "web", "code", "vscode", "cli").
  [/claude.*code.*(vscode|vs\s*code)/i, 'claude-code-vscode'],
  [/claude.*code/i, 'claude-code'],
  [/claude.*(desktop|mac|windows)/i, 'claude-desktop'],
  [/claude.*(mobile|ios|android|phone)/i, 'claude-mobile'],
  [/claude/i, 'claude'],
  // OpenAI surfaces
  [/chatgpt/i, 'chatgpt'],
  [/openai.*codex/i, 'openai-codex'],
  [/\bcodex\b/i, 'codex'],
  [/openai/i, 'openai'],
  // Other popular MCP clients
  [/\bcursor\b/i, 'cursor'],
  [/\bwindsurf\b/i, 'windsurf'],
  [/\bcline\b/i, 'cline'],
  [/\bzed\b/i, 'zed'],
  [/continue\b/i, 'continue'],
];

function surfaceAgentFromClient(clientName: string | undefined): string {
  if (!clientName) return RELAY_DEFAULT_SURFACE_AGENT;
  const name = clientName.trim();
  if (!name) return RELAY_DEFAULT_SURFACE_AGENT;
  for (const [re, slug] of SURFACE_PATTERNS) {
    if (re.test(name)) return slug;
  }
  // Unknown client: slugify the name if it's reasonable, otherwise fall
  // back to the generic default. We don't want arbitrary attacker-
  // controlled client_name strings landing as pod-path components.
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug && /^[a-z][a-z0-9-]{1,31}$/.test(slug)) return slug;
  return RELAY_DEFAULT_SURFACE_AGENT;
}

// Singleton OAuth provider. Auth is delegated to the identity server — the
// provider's login form collects userId+password, server.ts /oauth/login
// forwards to ${IDENTITY_URL}/login, and the returned identity is baked into
// the OAuth access token. Per-user, fully federated, no shared admin secret.
const oauthProvider = new InteregoOAuthProvider({
  identityUrl: IDENTITY_URL,
  tokenTtlSec: 3600,
});

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

// Per-process X25519 keypair used to encrypt content the relay publishes on
// behalf of the authenticated mobile agent. Persisted to disk so container
// restarts preserve the same identity (matters for recipient membership on
// previously-encrypted envelopes). Generated fresh on first run.
const RELAY_AGENT_KEY_FILE = process.env['RELAY_AGENT_KEY_FILE'] ?? '/app/relay-agent-key.json';
const relayAgentKey: EncryptionKeyPair = (() => {
  try {
    if (existsSync(RELAY_AGENT_KEY_FILE)) {
      const parsed = JSON.parse(readFileSync(RELAY_AGENT_KEY_FILE, 'utf8'));
      if (parsed?.publicKey && parsed?.secretKey && parsed?.algorithm === 'X25519-XSalsa20-Poly1305') {
        return parsed as EncryptionKeyPair;
      }
    }
  } catch { /* fall through */ }
  const kp = generateKeyPair();
  try { writeFileSync(RELAY_AGENT_KEY_FILE, JSON.stringify(kp, null, 2), { mode: 0o600 }); } catch { /* best-effort */ }
  return kp;
})();

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

  // Ensure the calling agent is registered on this pod with the relay's
  // encryption public key. Three cases:
  //   1. No registry yet        -> create profile + register this agent
  //   2. Registry present, this agent missing   -> register it (auto-provision)
  //   3. Agent present but encryption key stale -> patch the key
  // Without (1) and (2), OAuth clients whose agent identity wasn't already on
  // the pod would silently piggyback on whatever agent *was* registered,
  // breaking per-agent attribution and recipient-set growth. After this
  // block, every new OAuth-authenticated session adds its own did:web agent
  // with its own X25519 key as a first-class authorized agent on the pod.
  try {
    let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (!profile) {
      profile = createOwnerProfile(ownerWebId as IRI, args.owner_name as string | undefined);
    }
    const me = profile.authorizedAgents.find(a => a.agentId === agentId && !a.revoked);
    if (!me) {
      // Auto-register: this agent authenticated against identity server (so
      // the OAuth token proves key-possession). Safe to add to the pod's
      // authorized-agent list automatically.
      profile = addAuthorizedAgent(profile, {
        agentId: agentId as IRI,
        delegatedBy: ownerWebId as IRI,
        label: (args.label as string) ?? `Agent ${agentId}`,
        isSoftwareAgent: true,
        scope: 'ReadWrite',
        validFrom: new Date().toISOString(),
        encryptionPublicKey: relayAgentKey.publicKey,
      });
      await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });
      try {
        const newAgent = profile.authorizedAgents.find(a => a.agentId === agentId)!;
        const credential = createDelegationCredential(profile, newAgent, podUrl as IRI);
        await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });
      } catch { /* delegation credential is nice-to-have; registry is authoritative */ }
    } else if (me.encryptionPublicKey !== relayAgentKey.publicKey) {
      const updated = {
        ...profile,
        authorizedAgents: Object.freeze(
          profile.authorizedAgents.map(a =>
            a.agentId === agentId && !a.revoked
              ? { ...a, encryptionPublicKey: relayAgentKey.publicKey }
              : a,
          ),
        ),
      };
      await writeAgentRegistry(updated, podUrl, { fetch: solidFetch });
    }
  } catch (err) {
    log(`WARN: could not ensure agent registration: ${(err as Error).message}`);
  }

  const currentProfile = await readAgentRegistry(podUrl, { fetch: solidFetch }).catch(() => null);
  const recipients = (currentProfile?.authorizedAgents ?? [])
    .filter(a => !a.revoked && a.encryptionPublicKey)
    .map(a => a.encryptionPublicKey!) as string[];
  if (!recipients.includes(relayAgentKey.publicKey)) recipients.push(relayAgentKey.publicKey);

  // Cross-pod selective sharing: resolve each share_with handle to their
  // pod's authorized agents, union their keys into recipients. Their
  // agents can then decrypt THIS graph without any pod-level ACL change.
  const shareWith = (args.share_with as string[] | undefined) ?? [];
  const shareResolved: { handle: string; podUrl: string; agentCount: number }[] = [];
  if (shareWith.length > 0) {
    const resolved = await resolveRecipients(shareWith, { fetch: solidFetch });
    for (const r of resolved) {
      shareResolved.push({ handle: r.handle, podUrl: r.podUrl, agentCount: r.agentEncryptionKeys.length });
      for (const key of r.agentEncryptionKeys) {
        if (!recipients.includes(key)) recipients.push(key);
      }
    }
  }

  const publishOptions: Parameters<typeof publish>[3] = recipients.length > 0
    ? { fetch: solidFetch, encrypt: { recipients, senderKeyPair: relayAgentKey } }
    : { fetch: solidFetch };
  const result = await publish(descriptor, args.graph_content as string, podUrl, publishOptions);

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
    encrypted: result.encrypted ?? false,
    recipients: recipients.length,
    sharedWith: shareResolved.length > 0 ? shareResolved : undefined,
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
  const url = args.url as string;
  // Route envelope / TriG URLs through fetchGraphContent so encrypted
  // payloads are transparently decrypted for this relay's agent key (the
  // recipients registered on the pod include us when we published, so
  // round-tripping is seamless).
  if (url.endsWith('.envelope.jose.json') || url.endsWith('.trig')) {
    const { content, encrypted, mediaType } = await fetchGraphContent(url, {
      fetch: solidFetch,
      recipientKeyPair: relayAgentKey,
    });
    if (content === null && encrypted) {
      return JSON.stringify({
        url,
        encrypted: true,
        error: 'Relay agent key is not a recipient of this envelope; cannot decrypt.',
      });
    }
    return JSON.stringify({ url, encrypted, mediaType, content });
  }

  const resp = await solidFetch(url, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  });
  if (!resp.ok) {
    return JSON.stringify({ error: `${resp.status} ${resp.statusText}` });
  }
  const turtle = await resp.text();

  // Hypermedia follow-your-nose: the descriptor Turtle includes
  // cg:hasDistribution [ dcat:accessURL <...> ; dcat:mediaType "..." ;
  // cg:encrypted <bool> ; ... ]. We parse that instead of reconstructing
  // the URL by naming convention, so clients and this handler alike
  // stay decoupled from the relay's internal filename scheme. Matches
  // the REST / HATEOAS / DCAT / Hydra principles the project builds on.
  let graph: { url: string; mediaType: string; encrypted: boolean; content: string | null } | undefined;
  const link = parseDistributionFromDescriptorTurtle(turtle);
  if (link) {
    try {
      const { content, encrypted } = await fetchGraphContent(link.accessURL, {
        fetch: solidFetch,
        recipientKeyPair: relayAgentKey,
      });
      graph = { url: link.accessURL, mediaType: link.mediaType, encrypted, content };
    } catch { /* link present but fetch/decrypt failed; return descriptor only */ }
  }

  return JSON.stringify({ url, turtle, ...(graph ? { graph } : {}) });
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
      // The relay registers its own X25519 public key alongside the agent
      // so content encrypted to "this agent" lands decryptable here. Clients
      // that call register_agent explicitly get the same wiring they'd get
      // from the auto-registration path in publish_context.
      encryptionPublicKey: relayAgentKey.publicKey,
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

// ── MCP Tool Schemas ────────────────────────────────────────
// Input schemas for each tool. Claude's LLM uses these to know how to call
// each tool; empty inputSchema means the model can never pick the right args.
// Property names match what each handler reads off args.

const TOOL_SCHEMAS = [
  {
    name: 'publish_context',
    description: 'Publish a context-annotated knowledge graph (Turtle) to your Solid pod with the full 6-facet descriptor (Temporal, Provenance, Agent, Semiotic, Trust, Federation). Attributes the descriptor to the pod owner and associates it with the calling agent.',
    inputSchema: {
      type: 'object',
      properties: {
        graph_iri: { type: 'string', description: 'IRI for the named graph, e.g. urn:graph:markj:session:20260418' },
        graph_content: { type: 'string', description: 'RDF Turtle content of the knowledge graph' },
        pod_name: { type: 'string', description: 'Pod name (default: the authenticated user\'s pod)' },
        descriptor_id: { type: 'string', description: 'Optional descriptor IRI (auto-generated if omitted)' },
        valid_from: { type: 'string', description: 'ISO 8601 start of validity (default: now)' },
        valid_until: { type: 'string', description: 'ISO 8601 end of validity (optional)' },
        modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'], description: 'Semiotic modal status (default: Asserted)' },
        confidence: { type: 'number', description: 'Epistemic confidence 0.0-1.0 (default: 0.85)' },
        share_with: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of external identity handles (did:web:..., WebID URLs, or acct:user@host). Each is resolved to its pod, and their authorized agents\' X25519 keys are added as recipients on the envelope — per-graph cross-pod sharing without any pod-level ACL change. Use to share a specific graph with another person while keeping your other graphs private.',
        },
      },
      required: ['graph_iri', 'graph_content'],
    },
  },
  {
    name: 'discover_context',
    description: 'Discover context descriptors on a specific Solid pod. Optionally verify the agent delegation chain.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Solid pod URL to discover from (e.g. https://pod.example.com/agent/)' },
        facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
        valid_from: { type: 'string', description: 'Filter: valid at or after this ISO datetime' },
        valid_until: { type: 'string', description: 'Filter: valid at or before this ISO datetime' },
        verify_delegation: { type: 'boolean', description: 'If true, also fetch the agent registry to verify delegation' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'get_descriptor',
    description: 'Fetch the full Turtle content of a specific context descriptor.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL of the descriptor resource (ends in .ttl)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_pod_status',
    description: 'Check a Solid pod — owner, authorized agents, descriptor count, recent notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL (default: home pod for authenticated user)' },
      },
    },
  },
  {
    name: 'subscribe_to_pod',
    description: 'Subscribe to a pod\'s Solid Notifications channel; incoming changes accumulate in the relay\'s notification log.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to subscribe to' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'register_agent',
    description: 'Register an agent (delegate) on a pod on behalf of an owner. Creates the owner profile if missing, adds the agent with a delegation credential.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI, e.g. urn:agent:anthropic:claude-mobile:markj' },
        pod_name: { type: 'string', description: 'Pod name (default: authenticated user\'s pod)' },
        owner_webid: { type: 'string', description: 'Owner WebID (default: authenticated user)' },
        owner_name: { type: 'string', description: 'Owner display name' },
        label: { type: 'string', description: 'Human-readable label for this agent' },
        scope: { type: 'string', enum: ['ReadWrite', 'Read'], description: 'Authorization scope (default: ReadWrite)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'revoke_agent',
    description: 'Revoke an agent\'s delegation on a pod.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI to revoke' },
        pod_name: { type: 'string', description: 'Pod name (default: authenticated user\'s pod)' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'verify_agent',
    description: 'Verify an agent\'s delegation chain on a pod — checks registry, credential, and non-revocation.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent IRI to verify' },
        pod_url: { type: 'string', description: 'Pod URL where the agent is registered' },
      },
      required: ['agent_id', 'pod_url'],
    },
  },
  {
    name: 'discover_all',
    description: 'Discover context descriptors across all pods currently in the relay\'s federation registry. Use add_pod or discover_directory first to populate.',
    inputSchema: {
      type: 'object',
      properties: {
        facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
      },
    },
  },
  {
    name: 'list_known_pods',
    description: 'List pods in the relay\'s in-memory federation registry (home pod, manually added, directory-discovered, WebFinger-resolved).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_pod',
    description: 'Manually add a pod to the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to add' },
        label: { type: 'string', description: 'Human-readable label' },
        owner: { type: 'string', description: 'Owner WebID or name' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'remove_pod',
    description: 'Remove a pod from the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_url: { type: 'string', description: 'Pod URL to remove' },
      },
      required: ['pod_url'],
    },
  },
  {
    name: 'discover_directory',
    description: 'Import a PodDirectory graph and merge its entries into the federation registry.',
    inputSchema: {
      type: 'object',
      properties: {
        directory_url: { type: 'string', description: 'URL of a Turtle-encoded PodDirectory graph' },
      },
      required: ['directory_url'],
    },
  },
  {
    name: 'publish_directory',
    description: 'Publish the current federation registry as a PodDirectory graph on a pod.',
    inputSchema: {
      type: 'object',
      properties: {
        pod_name: { type: 'string', description: 'Pod name to publish to (default: authenticated user)' },
        directory_id: { type: 'string', description: 'Optional directory IRI' },
      },
    },
  },
  {
    name: 'resolve_webfinger',
    description: 'Resolve a WebFinger resource identifier (acct:user@host) to its pod URL. Adds the pod to the registry on success.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'WebFinger resource, e.g. acct:alice@example.com' },
      },
      required: ['resource'],
    },
  },
] as const;

// ── MCP Server Factory ──────────────────────────────────────
// One Server instance per /mcp request (stateless mode). Wires ListTools
// and CallTool to the same handler registry used by the REST routes.

function buildMcpServer(authContext: { agentId: string; ownerWebId?: string; userId?: string } | null): Server {
  const server = new Server(
    { name: '@interego/mcp-relay', version: '0.2.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SCHEMAS.map((t) => ({...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const tool = TOOLS[name];
    if (!tool) {
      return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    const args: ToolArgs = { ...(rawArgs ?? {}) };
    // Inject identity from auth context so the authenticated user's default
    // pod / agent / WebID fill in when the caller doesn't specify them.
    // Applies to ALL tools, not just writes — lets reads like get_pod_status
    // and discover_context default to "your home pod".
    if (authContext) {
      if (!args.agent_id) args.agent_id = authContext.agentId;
      if (!args.owner_webid && authContext.ownerWebId) args.owner_webid = authContext.ownerWebId;
      if (!args.pod_name && authContext.userId) args.pod_name = authContext.userId;
      if (!args.pod_url && authContext.userId) args.pod_url = `${CSS_URL}${authContext.userId}/`;
    }
    try {
      const text = await tool.handler(args);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  });

  return server;
}

// Timing-safe string compare to prevent auth-key length leakage
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkMcpApiKey(req: express.Request): { ok: true; authContext: { agentId: string; ownerWebId: string; userId: string } | null } | { ok: false; error: string } {
  // If no key is configured, /mcp is open. Writes still require the relay's
  // existing AUTH_REQUIRED_TOOLS gate downstream.
  if (!RELAY_MCP_API_KEY) return { ok: true, authContext: null };

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return { ok: false, error: 'Missing Authorization: Bearer <key> header' };
  }
  const token = auth.slice(7).trim();
  if (!safeEqual(token, RELAY_MCP_API_KEY)) {
    return { ok: false, error: 'Invalid MCP API key' };
  }
  // Legacy API-key path carries the default markj identity. Keep the agent
  // ID distinct from per-user OAuth-issued tokens so attributions stay
  // readable in prov:wasAssociatedWith.
  return {
    ok: true,
    authContext: {
      agentId: 'urn:agent:anthropic:relay-apikey:markj',
      ownerWebId: `${IDENTITY_URL}/users/markj/profile#me`,
      userId: 'markj',
    },
  };
}

// Suppress randomBytes lint: it's used by ops to generate a RELAY_MCP_API_KEY
// at deploy time (az containerapp update --set-env-vars RELAY_MCP_API_KEY=...),
// but leaving the import in keeps the tsc-strict "unused" warning quiet.
void randomBytes;

// ── Express App ─────────────────────────────────────────────

const app = express();
// Azure Container Apps sits behind Envoy, which sets X-Forwarded-For.
// The SDK's mcpAuthRouter applies express-rate-limit, which throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR unless Express trusts the proxy.
// Trust a single hop of proxy (Envoy) so the real client IP is preserved
// without opening up header-spoofing from arbitrary callers.
app.set('trust proxy', 1);

app.use(express.json());
// Login form POSTs x-www-form-urlencoded; OAuth token endpoint does too.
app.use(express.urlencoded({ extended: false }));

// CORS for remote agents + claude.ai connector discovery. Expose
// Authorization so browser-based MCP clients can send Bearer tokens.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id, mcp-protocol-version');
  next();
});

// ── OAuth Routes ────────────────────────────────────────────
// mcpAuthRouter wires: /.well-known/oauth-authorization-server,
// /.well-known/oauth-protected-resource, /authorize, /token, /register,
// /revoke (optional). Uses our InteregoOAuthProvider for the business logic.
//
// issuerUrl must be the externally-reachable URL of this relay. If unset,
// we fall back to localhost (useful for local dev); deployments MUST set
// PUBLIC_BASE_URL to the true public URL.
const DEFAULT_ISSUER = new URL(PUBLIC_BASE_URL || `http://localhost:${PORT}`);
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: DEFAULT_ISSUER,
  scopesSupported: ['mcp'],
  resourceName: 'Interego MCP',
}));

/**
 * POST /oauth/verify — single endpoint the authorize-page JS posts to.
 *
 * Accepts a `method` discriminator ('siwe' | 'webauthn-register' |
 * 'webauthn-authenticate' | 'did') plus the method-specific proof body,
 * forwards to the matching /auth/* endpoint on the identity server, and
 * on success returns { redirect } pointing at the OAuth client's
 * redirect_uri with the authorization code + state.
 *
 * No shared secrets — every successful call is backed by a cryptographic
 * signature verified by identity against the user's public key.
 */
app.post('/oauth/verify', async (req, res) => {
  const { pending_id, method, ...proofBody } = req.body as {
    pending_id?: string;
    method?: 'siwe' | 'webauthn-register' | 'webauthn-authenticate' | 'did';
    [k: string]: unknown;
  };
  if (!pending_id || !method) {
    res.status(400).json({ error: 'pending_id and method are required' });
    return;
  }

  const endpointByMethod: Record<typeof method, string> = {
    'siwe': '/auth/siwe',
    'webauthn-register': '/auth/webauthn/register',
    'webauthn-authenticate': '/auth/webauthn/authenticate',
    'did': '/auth/did',
  };
  const endpoint = endpointByMethod[method];
  if (!endpoint) {
    res.status(400).json({ error: `Unknown method: ${method}` });
    return;
  }

  let authResp: {
    userId?: string;
    agentId?: string;
    agentDid?: string;
    token?: string;
    webId?: string;
    did?: string;
    podUrl?: string;
    error?: string;
  };
  // Detect the calling MCP client from its DCR-registered client_name so
  // identity mints a surface-specific agent (chatgpt-<userId>,
  // codex-<userId>, cursor-<userId>, etc.) instead of a single relay-wide
  // default. Falls back to RELAY_DEFAULT_SURFACE_AGENT when the
  // client_name is missing / unrecognised — which defaults to the
  // generic `mcp-client`, deliberately NOT `claude-*`, so an unknown
  // client isn't silently attributed to Claude.
  const pending = oauthProvider.getPendingAuthorization(pending_id);
  const clientName = pending?.client?.client_name;
  const surfaceAgent = surfaceAgentFromClient(clientName);

  try {
    const bodyWithSurface = { ...proofBody, surfaceAgent };
    const r = await fetch(`${IDENTITY_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyWithSurface),
    });
    authResp = await r.json() as typeof authResp;
    if (!r.ok || !authResp.userId || !authResp.token) {
      res.status(r.status || 401).json({ error: authResp.error ?? `Identity /auth returned ${r.status}` });
      return;
    }
  } catch (err) {
    res.status(503).json({ error: `Identity server unreachable: ${(err as Error).message}` });
    return;
  }

  // Prefer the agent's did:web form as the agent IRI — bare strings like
  // "claude-code-vscode" aren't valid IRIs for prov:wasAssociatedWith and
  // would render as relative refs in the descriptor's Turtle. did:web IRIs
  // are resolvable via DID resolution and align with the W3C DID core spec.
  const agentIri = authResp.agentDid ?? authResp.agentId!;

  const result = oauthProvider.completePendingAuthorization(pending_id, {
    userId: authResp.userId,
    agentId: agentIri,
    ownerWebId: authResp.webId!,
    podUrl: authResp.podUrl!,
    identityToken: authResp.token,
  });
  if (!result) {
    res.status(400).json({ error: 'Authorization request expired or unknown. Retry from your MCP client.' });
    return;
  }

  const redirect = new URL(result.redirectUri);
  redirect.searchParams.set('code', result.code);
  if (result.state) redirect.searchParams.set('state', result.state);
  res.json({ redirect: redirect.toString() });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', css: CSS_URL, tools: Object.keys(TOOLS).length, auth: 'bearer-token', x402: true });
});

/**
 * GET /identity-token — exchange a valid MCP access token for the
 * underlying identity-server bearer token stored in the token's extra
 * field. Used by the dashboard so it can call identity's /auth-methods/*
 * endpoints directly on the user's behalf after OAuth sign-in.
 *
 * Auth: Bearer <MCP access token> (issued by this relay's OAuth).
 * Returns: { identityToken, expiresAt }.
 *
 * The identity token itself is bearer-bound to the user, so once the
 * dashboard has it, identity's own authorization checks apply.
 */
app.get('/identity-token', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  try {
    const info = await oauthProvider.verifyAccessToken(authHeader.slice(7));
    const identityToken = (info as { extra?: { identityToken?: string } }).extra?.identityToken;
    if (!identityToken) {
      res.status(404).json({ error: 'No identity token associated with this access token' });
      return;
    }
    res.json({
      identityToken,
      expiresAt: info.expiresAt,
      userId: (info as { extra?: { userId?: string } }).extra?.userId,
    });
  } catch (err) {
    res.status(401).json({ error: `Invalid access token: ${(err as Error).message}` });
  }
});

/**
 * POST /agents/:agentIri/revoke — remove a non-revoked agent from the
 * calling user's pod agent registry. Bearer-gated via MCP access token;
 * the agent IRI in the path must belong to the token's user's pod.
 *
 * `agentIri` is URL-encoded (typically a did:web IRI). Returns 404 if
 * the agent doesn't appear in the current registry, 403 if the agent
 * belongs to a different user's pod (owner IRI mismatch), 200 on
 * success with `{ revoked: true, agentIri, remaining: <count> }`.
 *
 * After revocation, the agent no longer appears as a recipient on
 * future envelope writes; already-encrypted envelopes keep their
 * previous recipient sets (true of all E2EE systems).
 */
app.post('/agents/:agentIri/revoke', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Bearer token required' });
    return;
  }
  let authInfo: { extra?: { userId?: string; ownerWebId?: string; identityToken?: string } };
  try {
    authInfo = await oauthProvider.verifyAccessToken(authHeader.slice(7)) as typeof authInfo;
  } catch (err) {
    res.status(401).json({ error: `Invalid access token: ${(err as Error).message}` });
    return;
  }
  const tokenUserId = authInfo.extra?.userId;
  const tokenOwnerWebId = authInfo.extra?.ownerWebId;
  if (!tokenUserId || !tokenOwnerWebId) {
    res.status(403).json({ error: 'Token has no identity binding' });
    return;
  }

  const agentIri = decodeURIComponent(req.params['agentIri'] ?? '') as IRI;
  if (!agentIri) { res.status(400).json({ error: 'agentIri path param required' }); return; }

  const podUrl = `${CSS_URL}${tokenUserId}/`;
  try {
    const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (!profile) {
      res.status(404).json({ error: 'No agent registry on this pod' });
      return;
    }
    if (profile.webId !== tokenOwnerWebId) {
      res.status(403).json({ error: `Agent registry owner ${profile.webId} does not match token user's WebID` });
      return;
    }
    const found = profile.authorizedAgents.find(a => a.agentId === agentIri && !a.revoked);
    if (!found) {
      res.status(404).json({ error: `Agent ${agentIri} not present (or already revoked) in this pod's registry` });
      return;
    }
    const updated = removeAuthorizedAgent(profile, agentIri);
    await writeAgentRegistry(updated, podUrl, { fetch: solidFetch });
    const remaining = updated.authorizedAgents.filter(a => !a.revoked).length;
    res.json({ revoked: true, agentIri, remaining });
  } catch (err) {
    res.status(500).json({ error: `Revoke failed: ${(err as Error).message}` });
  }
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

// ── MCP Streamable HTTP Endpoint (/mcp) ─────────────────────
// This is the real MCP transport — what claude.ai custom connectors and
// any modern MCP client will use. Handles initialize + tools/list + tools/call
// with proper JSON-RPC framing and SSE streaming.

// Extract the auth context for this request. Three valid paths:
//   1. req.auth populated by requireBearerAuth (OAuth token verified by provider)
//   2. Authorization: Bearer <RELAY_MCP_API_KEY> (legacy API key, for curl/scripts)
//   3. Unauthenticated (if RELAY_MCP_API_KEY unset AND no OAuth token) — open mode
function resolveAuthContext(req: express.Request): { agentId: string; ownerWebId: string; userId: string } | null {
  // OAuth-verified request: bearerAuth middleware already set req.auth
  const reqAuth = (req as express.Request & { auth?: { extra?: { agentId?: string; ownerWebId?: string; userId?: string } } }).auth;
  if (reqAuth?.extra?.agentId && reqAuth.extra.ownerWebId && reqAuth.extra.userId) {
    return {
      agentId: reqAuth.extra.agentId,
      ownerWebId: reqAuth.extra.ownerWebId,
      userId: reqAuth.extra.userId,
    };
  }
  // Legacy API-key path: Authorization: Bearer <RELAY_MCP_API_KEY>
  const legacy = checkMcpApiKey(req);
  if (legacy.ok && legacy.authContext) return legacy.authContext;
  return null;
}

async function handleMcp(req: express.Request, res: express.Response): Promise<void> {
  const authContext = resolveAuthContext(req);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildMcpServer(authContext);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, (req as express.Request & { body?: unknown }).body);
  } catch (err) {
    log(`[/mcp] transport error: ${(err as Error).message}`);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  } finally {
    await server.close().catch(() => {});
  }
}

// Bearer-auth middleware for the OAuth path. Requires 'mcp' scope on the
// token. When a request arrives WITHOUT an Authorization header, the
// middleware returns 401 with a WWW-Authenticate header that points MCP
// clients at the OAuth discovery metadata — so claude.ai can discover the
// authorization server and kick off the DCR + code+PKCE flow.
const resourceMetadataUrl = PUBLIC_BASE_URL
  ? `${PUBLIC_BASE_URL.replace(/\/$/, '')}/.well-known/oauth-protected-resource`
  : undefined;

const oauthBearer = requireBearerAuth({
  verifier: oauthProvider,
  requiredScopes: ['mcp'],
  ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
});

// Custom /mcp gate: if the request has an Authorization header starting with
// the legacy API key, short-circuit past OAuth. Otherwise run the OAuth
// bearer middleware, which will either validate the token or return 401 with
// proper WWW-Authenticate so clients know to start the OAuth flow.
const mcpGate: express.RequestHandler = (req, res, next) => {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && RELAY_MCP_API_KEY) {
    const token = auth.slice(7).trim();
    if (safeEqual(token, RELAY_MCP_API_KEY)) {
      // Legacy API key — skip OAuth, handleMcp will pick up via resolveAuthContext
      next();
      return;
    }
  }
  oauthBearer(req, res, next);
};

app.post('/mcp', mcpGate, handleMcp);
app.get('/mcp', mcpGate, handleMcp);
app.delete('/mcp', mcpGate, handleMcp);

// ── Start ───────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`MCP Relay started on port ${PORT}`);
  log(`CSS: ${CSS_URL}`);
  log(`/mcp auth: OAuth 2.1 + legacy Bearer <RELAY_MCP_API_KEY> fallback (${RELAY_MCP_API_KEY ? 'enabled' : 'disabled'})`);
  log(`OAuth issuer: ${PUBLIC_BASE_URL || `http://localhost:${PORT}`}`);
  log(`Identity server: ${IDENTITY_URL}`);
  log(`Endpoints:`);
  log(`  GET  /health                                  Health check`);
  log(`  GET  /tools  |  POST /tool/:name              REST convenience`);
  log(`  POST /mcp                                     MCP Streamable HTTP (OAuth-gated)`);
  log(`  GET  /.well-known/oauth-authorization-server  OAuth metadata`);
  log(`  GET  /.well-known/oauth-protected-resource    Resource metadata`);
  log(`  */authorize /token /register /revoke           OAuth endpoints (SDK)`);
});
