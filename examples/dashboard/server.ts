#!/usr/bin/env tsx
/**
 * Interego — Real-time Observation Dashboard
 *
 * A purely observational dashboard that monitors actual Solid pods
 * and displays real-time agent activity. No simulations, no demos.
 *
 * Connects to a live CSS (local or Azure-hosted) and:
 *   - Polls all known pods for descriptors, registries, and manifests
 *   - Subscribes to pod notifications via the relay's SSE stream
 *   - Streams every observed change to the browser
 *
 * Environment:
 *   CSS_URL   — Solid server base URL (default: http://localhost:3456/)
 *   RELAY_URL — MCP relay URL for SSE notifications (optional)
 *   PORT      — Dashboard port (default: 4000)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_PORT = parseInt(process.env['PORT'] ?? '4000');
const CSS_URL = (process.env['CSS_URL'] ?? 'http://localhost:3456/').replace(/\/?$/, '/');
const RELAY_URL = process.env['RELAY_URL'] ?? '';
const INDEX_HTML = resolve(__dirname, 'index.html');
const POLL_INTERVAL = parseInt(process.env['POLL_INTERVAL'] ?? '3000');

// ── Types ───────────────────────────────────────────────────

interface PodState {
  url: string;
  name: string;
  owner?: { webId: string; name?: string };
  agents: { id: string; scope: string; label?: string }[];
  descriptors: {
    url: string;
    describes: string[];
    facetTypes: string[];
    validFrom?: string;
    validUntil?: string;
  }[];
  lastSeen: string;
}

interface DashEvent {
  type: 'pod_update' | 'descriptor_added' | 'descriptor_removed' | 'agent_registered' | 'agent_revoked' | 'system' | 'error';
  pod?: string;
  data: unknown;
  timestamp: string;
}

// ── State ───────────────────────────────────────────────────

const pods = new Map<string, PodState>();
const sseClients = new Set<ServerResponse>();
let knownDescriptorUrls = new Set<string>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function log(msg: string): void {
  console.log(`[dashboard] ${msg}`);
}

// ── SSE ─────────────────────────────────────────────────────

function broadcast(event: DashEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ── Pod Discovery & Polling ─────────────────────────────────

/**
 * Discover pods by listing the CSS root as an LDP container.
 * CSS returns child containers — each is a potential pod.
 */
async function discoverPods(): Promise<string[]> {
  try {
    const resp = await fetch(CSS_URL, {
      headers: { 'Accept': 'text/turtle' },
    });
    if (!resp.ok) return [...pods.keys()];

    const turtle = await resp.text();
    const podNames: string[] = [];

    // Parse LDP contains links from Turtle
    const containsMatches = turtle.matchAll(/<([^>]+)>/g);
    for (const match of containsMatches) {
      const url = match[1]!;
      // Child containers that look like pods (relative URLs ending with /)
      if (url.endsWith('/') && !url.startsWith('http') && !url.startsWith('.')) {
        podNames.push(url.replace(/\/$/, ''));
      }
    }

    // Also check for full URLs
    const fullUrlMatches = turtle.matchAll(/ldp:contains\s+<([^>]+)>/g);
    for (const match of fullUrlMatches) {
      const url = match[1]!;
      if (url.startsWith(CSS_URL)) {
        const name = url.slice(CSS_URL.length).replace(/\/$/, '');
        if (name && !name.includes('/')) podNames.push(name);
      }
    }

    return [...new Set(podNames)];
  } catch {
    return [...pods.keys()].map(u => u.replace(CSS_URL, '').replace(/\/$/, ''));
  }
}

/**
 * Fetch the agent registry from a pod.
 */
async function fetchRegistry(podUrl: string): Promise<PodState['owner'] & { agents: PodState['agents'] } | null> {
  try {
    const resp = await fetch(`${podUrl}agents`, {
      headers: { 'Accept': 'text/turtle' },
    });
    if (!resp.ok) return null;

    const turtle = await resp.text();

    // Parse owner
    let ownerWebId: string | undefined;
    let ownerName: string | undefined;
    const ownerMatch = turtle.match(/<([^>]+)>\s+a\s+foaf:Person/);
    if (ownerMatch) ownerWebId = ownerMatch[1]!;
    const nameMatch = turtle.match(/foaf:name\s+"([^"]+)"/);
    if (nameMatch) ownerName = nameMatch[1]!;

    // Parse agents
    const agents: PodState['agents'] = [];
    const agentBlocks = turtle.split(/(?=<#agent-)/);
    for (const block of agentBlocks) {
      if (!block.includes('cg:AuthorizedAgent')) continue;
      const idMatch = block.match(/cg:agentIdentity\s+<([^>]+)>/);
      const scopeMatch = block.match(/cg:scope\s+cg:(\w+)/);
      const labelMatch = block.match(/foaf:name\s+"([^"]+)"/);
      if (idMatch && scopeMatch) {
        agents.push({
          id: idMatch[1]!,
          scope: scopeMatch[1]!,
          label: labelMatch?.[1],
        });
      }
    }

    return ownerWebId ? { webId: ownerWebId, name: ownerName, agents } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the context-graphs manifest from a pod.
 */
async function fetchManifest(podUrl: string): Promise<PodState['descriptors']> {
  try {
    const resp = await fetch(`${podUrl}.well-known/context-graphs`, {
      headers: { 'Accept': 'text/turtle' },
    });
    if (!resp.ok) return [];

    const turtle = await resp.text();
    const descriptors: PodState['descriptors'] = [];

    let current: PodState['descriptors'][0] | null = null;
    for (const rawLine of turtle.split('\n')) {
      const line = rawLine.trim();

      const entryMatch = line.match(/^<([^>]+)>\s+a\s+cg:ManifestEntry/);
      if (entryMatch) {
        if (current) descriptors.push(current);
        current = { url: entryMatch[1]!, describes: [], facetTypes: [] };
        continue;
      }
      if (!current) continue;

      const descMatch = line.match(/cg:describes\s+<([^>]+)>/);
      if (descMatch) current.describes.push(descMatch[1]!);

      const facetMatch = line.match(/cg:hasFacetType\s+cg:(\w+)/);
      if (facetMatch) current.facetTypes.push(facetMatch[1]!);

      const fromMatch = line.match(/cg:validFrom\s+"([^"]+)"/);
      if (fromMatch) current.validFrom = fromMatch[1]!;

      const untilMatch = line.match(/cg:validUntil\s+"([^"]+)"/);
      if (untilMatch) current.validUntil = untilMatch[1]!;

      if (line.endsWith('.') && current) {
        descriptors.push(current);
        current = null;
      }
    }
    if (current) descriptors.push(current);

    return descriptors;
  } catch {
    return [];
  }
}

/**
 * Poll all pods and emit changes.
 */
async function pollPods(): Promise<void> {
  const podNames = await discoverPods();

  for (const name of podNames) {
    const podUrl = `${CSS_URL}${name}/`;

    const [registry, descriptors] = await Promise.all([
      fetchRegistry(podUrl),
      fetchManifest(podUrl),
    ]);

    const prev = pods.get(podUrl);
    const now = new Date().toISOString();

    const state: PodState = {
      url: podUrl,
      name,
      owner: registry ? { webId: registry.webId, name: registry.name } : prev?.owner,
      agents: registry?.agents ?? prev?.agents ?? [],
      descriptors,
      lastSeen: now,
    };

    // Detect new descriptors
    for (const d of descriptors) {
      if (!knownDescriptorUrls.has(d.url)) {
        knownDescriptorUrls.add(d.url);
        if (prev) { // Only emit if we've seen this pod before (avoid flood on startup)
          broadcast({
            type: 'descriptor_added',
            pod: name,
            data: d,
            timestamp: now,
          });
          log(`New descriptor on ${name}: ${d.url}`);
        }
      }
    }

    // Detect removed descriptors
    if (prev) {
      const prevUrls = new Set(prev.descriptors.map(d => d.url));
      const currUrls = new Set(descriptors.map(d => d.url));
      for (const url of prevUrls) {
        if (!currUrls.has(url)) {
          knownDescriptorUrls.delete(url);
          broadcast({
            type: 'descriptor_removed',
            pod: name,
            data: { url },
            timestamp: now,
          });
        }
      }

      // Detect new agents
      const prevAgentIds = new Set(prev.agents.map(a => a.id));
      for (const a of state.agents) {
        if (!prevAgentIds.has(a.id)) {
          broadcast({
            type: 'agent_registered',
            pod: name,
            data: a,
            timestamp: now,
          });
          log(`New agent on ${name}: ${a.id}`);
        }
      }
    }

    pods.set(podUrl, state);
  }

  // Broadcast full state update
  broadcast({
    type: 'pod_update',
    data: Object.fromEntries([...pods.entries()].map(([k, v]) => [k, v])),
    timestamp: new Date().toISOString(),
  });
}

// ── HTTP Server ─────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(INDEX_HTML, 'utf-8'));
    return;
  }

  if (url === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    // Send current state immediately
    res.write(`data: ${JSON.stringify({
      type: 'system',
      data: {
        action: 'connected',
        css: CSS_URL,
        relay: RELAY_URL || null,
        pods: Object.fromEntries([...pods.entries()]),
      },
      timestamp: new Date().toISOString(),
    })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // API: current state snapshot
  if (url === '/api/state' && method === 'GET') {
    json(res, {
      css: CSS_URL,
      relay: RELAY_URL || null,
      pods: Object.fromEntries([...pods.entries()]),
      connectedClients: sseClients.size,
    });
    return;
  }

  // API: fetch a specific resource from the CSS (proxy)
  if (url.startsWith('/api/resource/') && method === 'GET') {
    const resourcePath = decodeURIComponent(url.slice('/api/resource/'.length));
    try {
      const resp = await fetch(`${CSS_URL}${resourcePath}`, {
        headers: { 'Accept': 'application/json, text/turtle, application/ld+json' },
      });
      const body = await resp.text();
      const ct = resp.headers.get('content-type') ?? 'text/plain';
      res.writeHead(resp.status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    } catch (err) {
      json(res, { error: (err as Error).message }, 502);
    }
    return;
  }

  // API: proxy relay tool calls
  if (url.startsWith('/api/relay/') && method === 'POST' && RELAY_URL) {
    const toolName = url.slice('/api/relay/'.length);
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const args = body ? JSON.parse(body) : {};
      const resp = await fetch(`${RELAY_URL}/tool/${toolName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      const result = await resp.text();
      res.writeHead(resp.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(result);
    } catch (err) {
      json(res, { error: (err as Error).message }, 502);
    }
    return;
  }

  // API: fetch descriptor turtle and parse facets for detail view
  if (url.startsWith('/api/descriptor/') && method === 'GET') {
    const descPath = decodeURIComponent(url.slice('/api/descriptor/'.length));
    try {
      const resp = await fetch(`${CSS_URL}${descPath}`, {
        headers: { 'Accept': 'text/turtle' },
      });
      const turtle = await resp.text();
      // Also fetch the companion graph
      const graphPath = descPath.replace(/\.ttl$/, '-graph.trig');
      const graphResp = await fetch(`${CSS_URL}${graphPath}`, {
        headers: { 'Accept': 'application/trig' },
      }).catch(() => null);
      const graphContent = graphResp?.ok ? await graphResp.text() : null;
      json(res, { turtle, graphContent, descriptorUrl: `${CSS_URL}${descPath}` });
    } catch (err) {
      json(res, { error: (err as Error).message }, 502);
    }
    return;
  }

  // API: relay info (tools, health)
  if (url === '/api/relay' && method === 'GET' && RELAY_URL) {
    try {
      const [health, tools] = await Promise.all([
        fetch(`${RELAY_URL}/health`).then(r => r.json()).catch(() => null),
        fetch(`${RELAY_URL}/tools`).then(r => r.json()).catch(() => []),
      ]);
      json(res, { relay: RELAY_URL, health, tools });
    } catch (err) {
      json(res, { error: (err as Error).message }, 502);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── Start ───────────────────────────────────────────────────

server.listen(DASH_PORT, async () => {
  log(`Dashboard: http://localhost:${DASH_PORT}/`);
  log(`CSS: ${CSS_URL}`);
  if (RELAY_URL) log(`Relay: ${RELAY_URL}`);
  log(`Polling every ${POLL_INTERVAL}ms`);

  // Initial poll
  await pollPods().catch(err => log(`Initial poll failed: ${(err as Error).message}`));

  // Start polling loop
  pollTimer = setInterval(() => {
    pollPods().catch(err => log(`Poll error: ${(err as Error).message}`));
  }, POLL_INTERVAL);

  broadcast({
    type: 'system',
    data: { action: 'started', css: CSS_URL },
    timestamp: new Date().toISOString(),
  });
});

process.on('SIGINT', () => { if (pollTimer) clearInterval(pollTimer); process.exit(0); });
process.on('SIGTERM', () => { if (pollTimer) clearInterval(pollTimer); process.exit(0); });
