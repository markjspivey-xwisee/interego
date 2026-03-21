#!/usr/bin/env tsx
/**
 * @foxxi/context-graphs-mcp v0.3.0
 *
 * MCP server for federated context-annotated knowledge graphs.
 *
 * Identity model:
 *   Pod belongs to the OWNER (human/org, identified by WebID).
 *   Agent is a DELEGATE acting on the owner's behalf.
 *   Descriptors carry: wasAttributedTo → owner, wasAssociatedWith → agent.
 *
 * Federation:
 *   Supports multiple pods across multiple CSS instances.
 *   Three discovery approaches: known pods list, directory graphs, WebFinger.
 *
 * Config (env vars, all backwards compatible):
 *   CG_HOME_POD      — Full URL of the agent's home pod (takes precedence)
 *   CG_BASE_URL      — CSS base URL (fallback, combined with CG_POD_NAME)
 *   CG_POD_NAME      — Pod name on the CSS (fallback)
 *   CG_AGENT_ID      — Agent identity IRI
 *   CG_OWNER_WEBID   — Owner's WebID
 *   CG_OWNER_NAME    — Owner's display name
 *   CG_DID           — Agent's DID
 *   CG_KNOWN_PODS    — Comma-separated pod URLs for auto-discovery
 *   CG_DIRECTORY_URL  — URL of a PodDirectory graph to auto-load
 *   CG_PORT          — CSS port for local startup (default 3456)
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
  fetchPodDirectory,
  publishPodDirectory,
  resolveWebFinger,
  // PGSL
  createPGSL,
  mintAtom,
  ingest,
  pgslResolve,
  queryNeighbors,
  latticeStats,
  pgslToTurtle,
  embedInPGSL,
  liftToDescriptor,
  latticeMeet,
  isSubFragment,
  pullbackSquare,
} from '@foxxi/context-graphs';

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
  PGSLInstance,
  NodeProvenance,
} from '@foxxi/context-graphs';

import { PodRegistry, type KnownPod } from './pod-registry.js';

// ── Config ──────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PORT = parseInt(process.env['CG_PORT'] ?? '3456');
const POD_NAME = process.env['CG_POD_NAME'] ?? 'agent';

// Home pod: explicit CG_HOME_POD, or computed from CG_BASE_URL + CG_POD_NAME
const BASE_URL = process.env['CG_BASE_URL'] ?? `http://localhost:${CSS_PORT}/`;
const HOME_POD = process.env['CG_HOME_POD'] ?? `${BASE_URL}${POD_NAME}/`;

const MY_AGENT_ID = (process.env['CG_AGENT_ID'] ?? 'urn:agent:claude-code:local') as IRI;
const MY_OWNER_WEBID = (process.env['CG_OWNER_WEBID'] ?? `https://id.example.com/${POD_NAME}/profile#me`) as IRI;
const MY_OWNER_NAME = process.env['CG_OWNER_NAME'] ?? undefined;
const MY_DID = (process.env['CG_DID'] ?? `did:web:${POD_NAME}.local`) as IRI;

const KNOWN_PODS_RAW = process.env['CG_KNOWN_PODS'] ?? '';
const DIRECTORY_URL = process.env['CG_DIRECTORY_URL'] ?? undefined;
const IDENTITY_SERVER_URL = process.env['CG_IDENTITY_URL']
  ?? 'https://context-graphs-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io';

const CSS_CONFIG = resolve(__dirname, '..', 'examples', 'multi-agent', 'css-config.json');
const CSS_BIN = resolve(__dirname, 'node_modules', '.bin', 'community-solid-server');

// ── State ───────────────────────────────────────────────────

const podRegistry = new PodRegistry();
let cssProcess: ChildProcess | null = null;
let cssReady = false;
let registryInitialized = false;
let notificationLog: ContextChangeEvent[] = [];
let lastPublishedDescriptor: ContextDescriptorData | null = null;

// PGSL state — the lattice persists across tool calls
const pgslProvenance: NodeProvenance = {
  wasAttributedTo: MY_OWNER_WEBID,
  generatedAtTime: new Date().toISOString(),
};
const pgslInstance: PGSLInstance = createPGSL(pgslProvenance);

// Initialize pod registry from config
podRegistry.add({ url: HOME_POD, isHome: true, discoveredVia: 'config' });
if (KNOWN_PODS_RAW) {
  for (const raw of KNOWN_PODS_RAW.split(',')) {
    const url = raw.trim();
    if (url) podRegistry.add({ url, isHome: false, discoveredVia: 'config' });
  }
}

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

  const homePod = podRegistry.getHome()!;
  const homeUrl = new URL(homePod.url);

  // Check if CSS is already running
  try {
    const resp = await fetch(homePod.url);
    if (resp.ok || resp.status < 500) {
      cssReady = true;
      log(`CSS reachable at ${homePod.url}`);
      await ensurePod();
      return;
    }
  } catch { /* not running */ }

  // Only start local CSS if home pod is localhost
  if (homeUrl.hostname !== 'localhost' && homeUrl.hostname !== '127.0.0.1') {
    throw new Error(`Cannot reach CSS at ${homePod.url} — remote server must be started independently`);
  }

  log(`Starting local CSS on port ${CSS_PORT}...`);

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
        const resp = await fetch(homePod.url);
        if (resp.ok || resp.status < 500) {
          clearInterval(poll);
          started = true;
          cssReady = true;
          log(`CSS ready at ${homePod.url}`);
          await ensurePod();
          res();
        }
      } catch { /* not ready */ }
    }, 400);

    setTimeout(() => { clearInterval(poll); if (!started) rej(new Error('CSS startup timeout')); }, 30_000);
  });
}

async function ensurePod(): Promise<void> {
  const homePod = podRegistry.getHome()!;
  await fetch(homePod.url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });
  log(`Pod ready: ${homePod.url}`);
}

async function ensureRegistry(): Promise<void> {
  if (registryInitialized) return;
  const homePod = podRegistry.getHome()!;

  let profile = await readAgentRegistry(homePod.url, { fetch: solidFetch });

  if (!profile) {
    log(`Creating agent registry for owner ${MY_OWNER_WEBID}`);
    profile = createOwnerProfile(MY_OWNER_WEBID, MY_OWNER_NAME);
  }

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

    await writeAgentRegistry(profile, homePod.url, { fetch: solidFetch });

    const agent = profile.authorizedAgents.find(a => a.agentId === MY_AGENT_ID)!;
    const credential = createDelegationCredential(profile, agent, homePod.url as IRI);
    await writeDelegationCredential(credential, homePod.url, { fetch: solidFetch });
    log(`Delegation credential written for ${MY_AGENT_ID}`);
  }

  registryInitialized = true;
  log(`Agent registry initialized — ${profile.authorizedAgents.filter(a => !a.revoked).length} active agent(s)`);
}

function stopCSS(): void {
  podRegistry.unsubscribeAll();
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

  const homePod = podRegistry.getHome()!;
  const podUrl = args.target_pod ?? homePod.url;
  const descId = (args.descriptor_id ?? `urn:cg:${POD_NAME}:${Date.now()}`) as IRI;
  const now = new Date().toISOString();

  const builder = ContextDescriptor.create(descId)
    .describes(args.graph_iri as IRI)
    .temporal({
      validFrom: args.valid_from ?? now,
      validUntil: args.valid_until,
    })
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
      lines.push('  No agent registry found — delegation unverifiable');
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

  // Touch the pod in registry
  podRegistry.touch(args.pod_url);

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

  const homePod = podRegistry.getHome()!;
  const podUrl = args.pod_url ?? homePod.url;
  const isHome = podUrl === homePod.url;

  const lines: string[] = [
    `Pod: ${podUrl}`,
    `Owner: ${isHome ? MY_OWNER_WEBID : '(check registry)'}`,
    `Agent: ${isHome ? MY_AGENT_ID : '(remote pod)'}`,
    `CSS: ${cssReady ? 'running' : 'stopped'}`,
    '',
  ];

  try {
    const profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
    if (profile) {
      lines.push(`Registry:`);
      lines.push(`  Owner: ${profile.webId}${profile.name ? ` (${profile.name})` : ''}`);
      const active = profile.authorizedAgents.filter(a => !a.revoked);
      lines.push(`  Agents: ${active.length} active`);
      for (const a of active) {
        lines.push(`    ${a.agentId} [${a.scope}]${a.label ? ` — ${a.label}` : ''}`);
      }
    } else {
      lines.push('Registry: not found');
    }
  } catch (err) {
    lines.push(`Registry: ${(err as Error).message}`);
  }

  lines.push('');

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

  const existing = podRegistry.get(args.pod_url);
  if (existing?.subscription) {
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

    podRegistry.setSubscription(args.pod_url, sub);
    return `Subscribed to ${args.pod_url} via WebSocket.`;
  } catch (err) {
    return `Failed to subscribe to ${args.pod_url}: ${(err as Error).message}`;
  }
}

async function toolRegisterAgent(args: {
  agent_id: string;
  label?: string;
  scope?: string;
  valid_until?: string;
  pod_url?: string;
}): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const homePod = podRegistry.getHome()!;
  const podUrl = args.pod_url ?? homePod.url;

  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
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

  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });

  const agent = profile.authorizedAgents.find(a => a.agentId === args.agent_id)!;
  const credential = createDelegationCredential(profile, agent, podUrl as IRI);
  const credUrl = await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });

  return [
    `Registered agent ${args.agent_id}`,
    `  Delegated by: ${MY_OWNER_WEBID}`,
    `  Scope: ${scope}`,
    `  Credential: ${credUrl}`,
    `  Registry: ${podUrl}agents`,
  ].join('\n');
}

async function toolRevokeAgent(args: { agent_id: string; pod_url?: string }): Promise<string> {
  await ensureCSS();

  const homePod = podRegistry.getHome()!;
  const podUrl = args.pod_url ?? homePod.url;

  let profile = await readAgentRegistry(podUrl, { fetch: solidFetch });
  if (!profile) {
    return 'No agent registry found on this pod.';
  }

  profile = removeAuthorizedAgent(profile, args.agent_id as IRI);
  await writeAgentRegistry(profile, podUrl, { fetch: solidFetch });

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

// ── NEW: Multi-pod federation tools ──────────────────────────

async function toolDiscoverAll(args: {
  facet_type?: string;
  valid_from?: string;
  valid_until?: string;
  verify_delegation?: boolean;
}): Promise<string> {
  await ensureCSS();

  const pods = podRegistry.list();
  const allResults: Array<{ pod: KnownPod; entries: ManifestEntry[]; error?: string }> = [];

  await Promise.allSettled(pods.map(async (pod) => {
    try {
      const filter: Record<string, unknown> = {};
      if (args.facet_type) filter.facetType = args.facet_type;
      if (args.valid_from) filter.validFrom = args.valid_from;
      if (args.valid_until) filter.validUntil = args.valid_until;

      const entries = await discover(
        pod.url,
        Object.keys(filter).length > 0 ? filter as Parameters<typeof discover>[1] : undefined,
        { fetch: solidFetch },
      );
      podRegistry.touch(pod.url);
      allResults.push({ pod, entries });
    } catch (err) {
      allResults.push({ pod, entries: [], error: (err as Error).message });
    }
  }));

  const totalEntries = allResults.reduce((sum, r) => sum + r.entries.length, 0);
  const lines: string[] = [
    `Discovered ${totalEntries} descriptor(s) across ${pods.length} pod(s):`,
    '',
  ];

  for (const r of allResults) {
    const tag = r.pod.isHome ? ' [HOME]' : '';
    const label = r.pod.label ? ` (${r.pod.label})` : '';
    lines.push(`${r.pod.url}${tag}${label}`);

    if (r.error) {
      lines.push(`  Error: ${r.error}`);
    } else if (r.entries.length === 0) {
      lines.push(`  (no descriptors)`);
    } else {
      for (const entry of r.entries) {
        lines.push(`  ${entry.descriptorUrl}`);
        lines.push(`    Describes: ${entry.describes.join(', ')}`);
        lines.push(`    Facets: ${entry.facetTypes.join(', ')}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function toolSubscribeAll(_args: Record<string, never>): Promise<string> {
  await ensureCSS();

  const pods = podRegistry.list();
  const results: string[] = [];
  let subscribed = 0;
  let skipped = 0;
  let failed = 0;

  for (const pod of pods) {
    if (pod.subscription) {
      skipped++;
      continue;
    }

    try {
      const sub = await subscribe(pod.url, (event: ContextChangeEvent) => {
        notificationLog.push(event);
        log(`[notification] ${event.type} on ${event.resource}`);
      }, {
        fetch: solidFetch,
        WebSocket: WebSocket as unknown as WebSocketConstructor,
      });
      podRegistry.setSubscription(pod.url, sub);
      subscribed++;
    } catch (err) {
      results.push(`  Failed: ${pod.url} — ${(err as Error).message}`);
      failed++;
    }
  }

  return [
    `Subscribe all: ${subscribed} new, ${skipped} already subscribed, ${failed} failed`,
    ...results,
  ].join('\n');
}

async function toolListKnownPods(_args: Record<string, never>): Promise<string> {
  const pods = podRegistry.list();
  if (pods.length === 0) return 'No known pods.';

  const lines: string[] = [`Known pods (${pods.length}):`, ''];

  for (const pod of pods) {
    const flags: string[] = [];
    if (pod.isHome) flags.push('HOME');
    if (pod.subscription) flags.push('SUBSCRIBED');
    const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const label = pod.label ? ` — ${pod.label}` : '';

    lines.push(`  ${pod.url}${flagStr}${label}`);
    lines.push(`    Via: ${pod.discoveredVia}${pod.owner ? ` | Owner: ${pod.owner}` : ''}`);
    if (pod.lastSeen) lines.push(`    Last seen: ${pod.lastSeen}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function toolAddPod(args: {
  pod_url: string;
  label?: string;
  owner?: string;
}): Promise<string> {
  podRegistry.add({
    url: args.pod_url,
    label: args.label,
    owner: args.owner as IRI | undefined,
    isHome: false,
    discoveredVia: 'manual',
  });
  return `Added ${args.pod_url} to pod registry (${podRegistry.size} pods total)`;
}

async function toolRemovePod(args: { pod_url: string }): Promise<string> {
  const removed = podRegistry.remove(args.pod_url);
  if (removed) {
    return `Removed ${args.pod_url} from pod registry (${podRegistry.size} pods remaining)`;
  }
  const pod = podRegistry.get(args.pod_url);
  if (pod?.isHome) {
    return `Cannot remove home pod ${args.pod_url}`;
  }
  return `Pod ${args.pod_url} not found in registry`;
}

async function toolDiscoverDirectory(args: { directory_url: string }): Promise<string> {
  const directory = await fetchPodDirectory(args.directory_url, { fetch: solidFetch });
  let added = 0;
  for (const entry of directory.entries) {
    if (!podRegistry.get(entry.podUrl)) added++;
    podRegistry.add({
      url: entry.podUrl,
      label: entry.label,
      owner: entry.owner,
      isHome: false,
      discoveredVia: 'directory',
    });
  }
  return `Imported ${directory.entries.length} pod(s) from directory (${added} new). Registry: ${podRegistry.size} pods.`;
}

async function toolPublishDirectory(args: {
  directory_id?: string;
}): Promise<string> {
  await ensureCSS();
  await ensureRegistry();

  const homePod = podRegistry.getHome()!;
  const entries: PodDirectoryEntry[] = podRegistry.list().map(p => ({
    podUrl: p.url as IRI,
    owner: p.owner,
    label: p.label,
  }));

  const directory: PodDirectoryData = {
    id: (args.directory_id ?? `urn:directory:${POD_NAME}`) as IRI,
    entries,
  };

  const url = await publishPodDirectory(directory, homePod.url, { fetch: solidFetch });
  return `Published directory with ${entries.length} pod(s) to ${url}`;
}

async function toolResolveWebfinger(args: { resource: string }): Promise<string> {
  const result = await resolveWebFinger(args.resource, { fetch: solidFetch });

  if (result.podUrl) {
    podRegistry.add({
      url: result.podUrl,
      isHome: false,
      discoveredVia: 'webfinger',
    });
  }

  return [
    `WebFinger resolution for ${args.resource}:`,
    `  Subject: ${result.subject}`,
    result.podUrl ? `  Pod URL: ${result.podUrl} (added to registry)` : '  Pod URL: not found in JRD links',
    result.webId ? `  WebID: ${result.webId}` : '',
    `  Links: ${result.links.length}`,
    ...result.links.map(l => `    ${l.rel} -> ${l.href}`),
  ].filter(Boolean).join('\n');
}

// ── Onboarding Tool Implementation ──────────────────────────

/**
 * setup_identity — first-time onboarding for a human.
 * Creates their identity on the identity server, provisions their pod,
 * registers their first agent, and gets a bearer token.
 */
async function toolSetupIdentity(args: {
  name: string;
  user_id?: string;
  agent_name?: string;
}): Promise<string> {
  const userId = args.user_id ?? args.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const agentId = `claude-code-${userId}`;
  const agentName = args.agent_name ?? `Claude Code (${args.name})`;

  // 1. Register on identity server
  let registerResult: any;
  try {
    const resp = await fetch(`${IDENTITY_SERVER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: args.name,
        userId,
        agentId,
        agentName,
        scope: 'ReadWrite',
      }),
    });
    registerResult = await resp.json();
    if (!resp.ok) {
      return [
        `Registration failed: ${registerResult.error}`,
        registerResult.error?.includes('already exists')
          ? `User '${userId}' is already registered. Use your existing token.`
          : '',
      ].filter(Boolean).join('\n');
    }
  } catch (err) {
    return `Cannot reach identity server at ${IDENTITY_SERVER_URL}: ${(err as Error).message}`;
  }

  // 2. Provision pod on CSS
  await ensureCSS();
  const podUrl = `${BASE_URL}${userId}/`;
  await solidFetch(podUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });

  // 3. Write agent registry on the pod
  const profile = createOwnerProfile(registerResult.webId as IRI, args.name);
  const profileWithAgent = addAuthorizedAgent(profile, {
    agentId: `urn:agent:anthropic:${agentId}` as IRI,
    delegatedBy: registerResult.webId as IRI,
    label: agentName,
    isSoftwareAgent: true,
    scope: 'ReadWrite',
    validFrom: new Date().toISOString(),
  });
  await writeAgentRegistry(profileWithAgent, podUrl, { fetch: solidFetch });

  // 4. Write delegation credential
  const agent = profileWithAgent.authorizedAgents.find(a => a.agentId === `urn:agent:anthropic:${agentId}`)!;
  const credential = createDelegationCredential(profileWithAgent, agent, podUrl as IRI);
  await writeDelegationCredential(credential, podUrl, { fetch: solidFetch });

  return [
    `Identity created successfully!`,
    ``,
    `  Name: ${args.name}`,
    `  User ID: ${userId}`,
    `  WebID: ${registerResult.webId}`,
    `  DID: ${registerResult.did}`,
    `  Pod: ${registerResult.podUrl}`,
    `  Agent: ${agentId}`,
    `  Agent DID: ${registerResult.agentDid}`,
    `  Token: ${registerResult.token}`,
    `  Expires: ${registerResult.expiresAt}`,
    ``,
    `To configure another Claude Code instance:`,
    `  CG_POD_NAME="${userId}"`,
    `  CG_AGENT_ID="urn:agent:anthropic:${agentId}"`,
    `  CG_OWNER_WEBID="${registerResult.webId}"`,
    `  CG_OWNER_NAME="${args.name}"`,
    `  CG_BASE_URL="${BASE_URL}"`,
    ``,
    `Your pod is ready. Other agents can discover your context at:`,
    `  ${registerResult.podUrl}.well-known/context-graphs`,
  ].join('\n');
}

// ── PGSL Tool Implementations ───────────────────────────────

async function toolPgslIngest(args: {
  content: string;
  publish_to_pod?: boolean;
}): Promise<string> {
  const topUri = embedInPGSL(pgslInstance, args.content);
  const stats = latticeStats(pgslInstance);
  const resolved = pgslResolve(pgslInstance, topUri);

  const lines = [
    `Ingested into PGSL lattice`,
    `  Top fragment: ${topUri}`,
    `  Resolved: "${resolved}"`,
    `  Atoms: ${stats.atoms}`,
    `  Fragments: ${stats.fragments}`,
    `  Max level: ${stats.maxLevel}`,
    `  Levels: ${Object.entries(stats.levels).map(([k, v]) => `L${k}=${v}`).join(', ')}`,
  ];

  // Always write PGSL stats to the pod so the dashboard can observe
  try {
    await ensureCSS();
    const statsJson = JSON.stringify({ ...stats, lastIngested: resolved, lastTopUri: topUri, updatedAt: new Date().toISOString() });
    await solidFetch(`${HOME_POD}pgsl-stats.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: statsJson,
    });
  } catch { /* best effort */ }

  if (args.publish_to_pod) {
    await ensureCSS();
    const desc = liftToDescriptor(
      pgslInstance,
      topUri,
      `urn:cg:${POD_NAME}:pgsl:${Date.now()}` as IRI,
      [{
        type: 'Temporal',
        validFrom: new Date().toISOString(),
      }, {
        type: 'Provenance',
        wasAttributedTo: MY_OWNER_WEBID,
        generatedAtTime: new Date().toISOString(),
        wasGeneratedBy: { agent: MY_AGENT_ID, endedAt: new Date().toISOString() },
      }],
    );
    const turtle = pgslToTurtle(pgslInstance);
    const result = await publish(desc, turtle, HOME_POD, { fetch: solidFetch });
    lines.push(`  Published to: ${result.descriptorUrl}`);
  }

  return lines.join('\n');
}

async function toolPgslResolve(args: { uri: string }): Promise<string> {
  const resolved = pgslResolve(pgslInstance, args.uri as IRI);
  const node = pgslInstance.nodes.get(args.uri as IRI);
  if (!node) return `Not found: ${args.uri}`;

  const lines = [`Resolved: "${resolved}"`];
  if (node.kind === 'Atom') {
    lines.push(`  Type: Atom (level 0)`);
    lines.push(`  Value: ${node.value}`);
  } else {
    lines.push(`  Type: Fragment (level ${node.level})`);
    lines.push(`  Items: ${node.items.length}`);
    if (node.left) lines.push(`  Left: ${node.left}`);
    if (node.right) lines.push(`  Right: ${node.right}`);
    const pb = pullbackSquare(pgslInstance, args.uri as IRI);
    if (pb) lines.push(`  Overlap: ${pb.overlap}`);
  }
  lines.push(`  Agent: ${node.provenance.wasAttributedTo}`);
  lines.push(`  Created: ${node.provenance.generatedAtTime}`);
  return lines.join('\n');
}

async function toolPgslLatticeStatus(_args: Record<string, never>): Promise<string> {
  const stats = latticeStats(pgslInstance);
  const lines = [
    `PGSL Lattice Status`,
    `  Total nodes: ${stats.totalNodes}`,
    `  Atoms: ${stats.atoms}`,
    `  Fragments: ${stats.fragments}`,
    `  Max level: ${stats.maxLevel}`,
    `  By level:`,
    ...Object.entries(stats.levels).map(([k, v]) => `    L${k}: ${v} nodes`),
  ];
  return lines.join('\n');
}

async function toolPgslMeet(args: { uri_a: string; uri_b: string }): Promise<string> {
  const meet = latticeMeet(pgslInstance, args.uri_a as IRI, args.uri_b as IRI);
  if (!meet) return `No shared sub-fragment between ${args.uri_a} and ${args.uri_b}`;
  const resolved = pgslResolve(pgslInstance, meet);
  return [
    `Lattice meet (greatest lower bound):`,
    `  Fragment: ${meet}`,
    `  Content: "${resolved}"`,
    `  A: ${args.uri_a}`,
    `  B: ${args.uri_b}`,
  ].join('\n');
}

async function toolPgslToTurtle(_args: Record<string, never>): Promise<string> {
  return pgslToTurtle(pgslInstance);
}

// ── MCP Server ──────────────────────────────────────────────

const mcpServer = new Server(
  { name: '@foxxi/context-graphs-mcp', version: '0.4.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// ── Tool Definitions ────────────────────────────────────────

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ── Core tools ──
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
          target_pod: { type: 'string', description: 'Pod URL to publish to (default: home pod)' },
        },
        required: ['graph_iri', 'graph_content'],
      },
    },
    {
      name: 'discover_context',
      description: 'Discover context descriptors on a specific Solid pod. Optionally verify the agent delegation chain.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to discover from' },
          facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
          valid_from: { type: 'string', description: 'Filter: valid at or after this datetime' },
          valid_until: { type: 'string', description: 'Filter: valid at or before this datetime' },
          verify_delegation: { type: 'boolean', description: 'If true, also fetch the agent registry to verify delegation' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'get_descriptor',
      description: 'Fetch the full Turtle content of a specific context descriptor.',
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
      description: 'Subscribe to live WebSocket notifications from a Solid pod.',
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
      description: 'Check a Solid pod — owner, agents, descriptors, notifications.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Pod URL (default: home pod)' },
        },
      },
    },
    // ── Delegation tools ──
    {
      name: 'register_agent',
      description: 'Register an AI agent as authorized to act on behalf of the pod owner.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent identity IRI' },
          label: { type: 'string', description: 'Human-readable label' },
          scope: { type: 'string', enum: ['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'], description: 'Delegation scope (default: ReadWrite)' },
          valid_until: { type: 'string', description: 'ISO 8601 expiration (optional)' },
          pod_url: { type: 'string', description: 'Pod URL (default: home pod)' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'revoke_agent',
      description: "Revoke an agent's delegation.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent identity IRI to revoke' },
          pod_url: { type: 'string', description: 'Pod URL (default: home pod)' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'verify_agent',
      description: "Verify an agent is authorized on a pod by checking the agent registry.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          agent_id: { type: 'string', description: 'Agent identity IRI to verify' },
          pod_url: { type: 'string', description: 'Pod URL to check' },
        },
        required: ['agent_id', 'pod_url'],
      },
    },
    // ── Multi-pod federation tools ──
    {
      name: 'discover_all',
      description: 'Fan out discovery across ALL known pods in the registry. Returns aggregated results from every pod.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          facet_type: { type: 'string', enum: ['Temporal', 'Provenance', 'Agent', 'Semiotic', 'Trust', 'Federation'], description: 'Filter by facet type' },
          valid_from: { type: 'string', description: 'Filter: valid at or after this datetime' },
          valid_until: { type: 'string', description: 'Filter: valid at or before this datetime' },
        },
      },
    },
    {
      name: 'subscribe_all',
      description: 'Subscribe to WebSocket notifications from ALL known pods.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'list_known_pods',
      description: 'List all pods in the federation registry — home pod, configured pods, directory-discovered pods, WebFinger-resolved pods.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'add_pod',
      description: 'Manually add a Solid pod URL to the federation registry.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Solid pod URL to add' },
          label: { type: 'string', description: 'Human-readable label' },
          owner: { type: 'string', description: "Pod owner's WebID" },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'remove_pod',
      description: 'Remove a pod from the federation registry (cannot remove home pod).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          pod_url: { type: 'string', description: 'Pod URL to remove' },
        },
        required: ['pod_url'],
      },
    },
    {
      name: 'discover_directory',
      description: 'Fetch a PodDirectory graph from a URL and import all listed pods into the registry. Directories are RDF graphs listing known pods.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          directory_url: { type: 'string', description: 'URL of the PodDirectory resource' },
        },
        required: ['directory_url'],
      },
    },
    {
      name: 'publish_directory',
      description: 'Publish the current pod registry as a PodDirectory graph on your home pod. Other agents can fetch this to discover your known pods.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          directory_id: { type: 'string', description: 'IRI for the directory (default: auto-generated)' },
        },
      },
    },
    {
      name: 'resolve_webfinger',
      description: 'Resolve a WebFinger identifier (acct:user@domain or WebID URL) to discover a Solid pod URL via RFC 7033. Adds the discovered pod to the registry.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          resource: { type: 'string', description: 'WebFinger resource (e.g. "acct:markj@context-graphs-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io" or a WebID URL)' },
        },
        required: ['resource'],
      },
    },
    // ── Onboarding ──
    {
      name: 'setup_identity',
      description: 'First-time onboarding: creates your identity (WebID, DID, Ed25519 keys), provisions your Solid pod, registers your agent with delegation credentials, and returns a bearer token. Run this once when setting up a new human user.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Human-readable name (e.g. "Sarah Chen")' },
          user_id: { type: 'string', description: 'Short identifier (e.g. "sarah") — auto-derived from name if omitted' },
          agent_name: { type: 'string', description: 'Label for the agent (e.g. "Claude Code (Sarah)")' },
        },
        required: ['name'],
      },
    },
    // ── PGSL tools ──
    {
      name: 'pgsl_ingest',
      description: 'Ingest content into the PGSL lattice. Tokenizes the content, builds the overlapping-pair lattice bottom-up, and returns the top fragment URI. Optionally publishes the lattice as a context descriptor to the pod.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          content: { type: 'string', description: 'Text content to ingest into the lattice' },
          publish_to_pod: { type: 'boolean', description: 'Also publish as a context descriptor to the pod (default: false)' },
        },
        required: ['content'],
      },
    },
    {
      name: 'pgsl_resolve',
      description: 'Resolve a PGSL URI to its content. For atoms: returns the value. For fragments: returns the full reconstructed text. Also shows node metadata (level, constituents, pullback, provenance).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          uri: { type: 'string', description: 'PGSL URI to resolve (urn:pgsl:atom:... or urn:pgsl:fragment:...)' },
        },
        required: ['uri'],
      },
    },
    {
      name: 'pgsl_lattice_status',
      description: 'Show the current state of the PGSL lattice — atom count, fragment count, levels, total nodes.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'pgsl_meet',
      description: 'Compute the lattice meet (greatest lower bound) of two fragments — the largest shared sub-sequence. This is the categorical intersection in the presheaf topos.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          uri_a: { type: 'string', description: 'First PGSL fragment URI' },
          uri_b: { type: 'string', description: 'Second PGSL fragment URI' },
        },
        required: ['uri_a', 'uri_b'],
      },
    },
    {
      name: 'pgsl_to_turtle',
      description: 'Serialize the entire PGSL lattice as RDF Turtle. Includes atoms, fragments, pullback structures, and provenance — all as typed RDF resources with the pgsl: vocabulary.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
  ],
}));

// ── Tool Dispatch ───────────────────────────────────────────

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
      // Multi-pod federation
      case 'discover_all':
        result = await toolDiscoverAll(args as Parameters<typeof toolDiscoverAll>[0]);
        break;
      case 'subscribe_all':
        result = await toolSubscribeAll(args as Record<string, never>);
        break;
      case 'list_known_pods':
        result = await toolListKnownPods(args as Record<string, never>);
        break;
      case 'add_pod':
        result = await toolAddPod(args as Parameters<typeof toolAddPod>[0]);
        break;
      case 'remove_pod':
        result = await toolRemovePod(args as Parameters<typeof toolRemovePod>[0]);
        break;
      case 'discover_directory':
        result = await toolDiscoverDirectory(args as Parameters<typeof toolDiscoverDirectory>[0]);
        break;
      case 'publish_directory':
        result = await toolPublishDirectory(args as Parameters<typeof toolPublishDirectory>[0]);
        break;
      case 'resolve_webfinger':
        result = await toolResolveWebfinger(args as Parameters<typeof toolResolveWebfinger>[0]);
        break;
      // Onboarding
      case 'setup_identity':
        result = await toolSetupIdentity(args as Parameters<typeof toolSetupIdentity>[0]);
        break;
      // PGSL
      case 'pgsl_ingest':
        result = await toolPgslIngest(args as Parameters<typeof toolPgslIngest>[0]);
        break;
      case 'pgsl_resolve':
        result = await toolPgslResolve(args as Parameters<typeof toolPgslResolve>[0]);
        break;
      case 'pgsl_lattice_status':
        result = await toolPgslLatticeStatus(args as Record<string, never>);
        break;
      case 'pgsl_meet':
        result = await toolPgslMeet(args as Parameters<typeof toolPgslMeet>[0]);
        break;
      case 'pgsl_to_turtle':
        result = await toolPgslToTurtle(args as Record<string, never>);
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

// ── Resources ───────────────────────────────────────────────

mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: `solid://${POD_NAME}/manifest`,
      name: 'Home Pod Manifest',
      description: `Context descriptors on ${HOME_POD}`,
      mimeType: 'text/turtle',
    },
    {
      uri: `solid://${POD_NAME}/agents`,
      name: 'Agent Registry',
      description: `Authorized agents for ${MY_OWNER_WEBID}`,
      mimeType: 'text/turtle',
    },
    {
      uri: 'solid://registry/pods',
      name: 'Pod Registry',
      description: 'All known pods in the federation',
      mimeType: 'application/json',
    },
  ],
}));

mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const homePod = podRegistry.getHome()!;

  if (request.params.uri === `solid://${POD_NAME}/manifest`) {
    try {
      await ensureCSS();
      const resp = await fetch(`${homePod.url}.well-known/context-graphs`, { headers: { 'Accept': 'text/turtle' } });
      const body = resp.ok ? await resp.text() : '# No manifest yet';
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: body }] };
    } catch {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: '# Solid server not reachable' }] };
    }
  }

  if (request.params.uri === `solid://${POD_NAME}/agents`) {
    try {
      await ensureCSS();
      const resp = await fetch(`${homePod.url}agents`, { headers: { 'Accept': 'text/turtle' } });
      const body = resp.ok ? await resp.text() : '# No agent registry yet';
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: body }] };
    } catch {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/turtle', text: '# Solid server not reachable' }] };
    }
  }

  if (request.params.uri === 'solid://registry/pods') {
    const pods = podRegistry.list();
    const json = JSON.stringify(pods.map(p => ({
      url: p.url,
      label: p.label,
      owner: p.owner,
      isHome: p.isHome,
      discoveredVia: p.discoveredVia,
      subscribed: !!p.subscription,
      lastSeen: p.lastSeen,
    })), null, 2);
    return { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: json }] };
  }

  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// ── Start ───────────────────────────────────────────────────

async function main(): Promise<void> {
  log('Starting Context Graphs MCP server v0.3.0...');
  log(`Owner: ${MY_OWNER_WEBID}${MY_OWNER_NAME ? ` (${MY_OWNER_NAME})` : ''}`);
  log(`Agent: ${MY_AGENT_ID}`);
  log(`Home pod: ${HOME_POD}`);
  log(`Known pods: ${podRegistry.size}`);

  // Auto-load directory if configured
  if (DIRECTORY_URL) {
    try {
      const directory = await fetchPodDirectory(DIRECTORY_URL, { fetch: solidFetch });
      for (const entry of directory.entries) {
        podRegistry.add({
          url: entry.podUrl,
          label: entry.label,
          owner: entry.owner,
          isHome: false,
          discoveredVia: 'directory',
        });
      }
      log(`Loaded ${directory.entries.length} pod(s) from directory ${DIRECTORY_URL}`);
    } catch (err) {
      log(`Warning: could not load directory ${DIRECTORY_URL}: ${(err as Error).message}`);
    }
  }

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
