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
import {
  buildSecurityTxtFromEnv,
} from '@interego/security-txt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_PORT = parseInt(process.env['PORT'] ?? '4000');
const CSS_URL = (process.env['CSS_URL'] ?? 'http://localhost:3456/').replace(/\/?$/, '/');
const RELAY_URL = (process.env['RELAY_URL'] ?? '').replace(/\/?$/, '');
// PUBLIC_RELAY_URL: the browser-reachable relay origin used for OAuth
// redirects (the /authorize page users sign in on). In Azure Container
// Apps the backend RELAY_URL may be a `.internal` URL; the browser must
// be sent to a public address instead. Defaults to RELAY_URL.
const PUBLIC_RELAY_URL = (process.env['PUBLIC_RELAY_URL'] ?? RELAY_URL).replace(/\/?$/, '');
// PUBLIC_BASE_URL: the browser-reachable dashboard origin, used as the
// OAuth redirect_uri target. Defaults to constructing from the request
// host when unset (fine for local dev).
const PUBLIC_BASE_URL = (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/?$/, '');
// Identity server the dashboard proxies sign-in + account-management
// calls through. Running in Azure Container Apps the dashboard can
// reach the internal `.internal` identity URL but the browser can't —
// so the dashboard's `/api/identity/*` endpoint is a server-side proxy.
const IDENTITY_URL = (process.env['IDENTITY_URL'] ?? '').replace(/\/?$/, '');
const INDEX_HTML = resolve(__dirname, 'index.html');
// Default raised from 3000ms → 30000ms (2026-04-21). At 3s cadence with
// 12 pods the dashboard was hitting CSS's read-write locker with ~480
// requests/min, exhausting its 6s lock pool and causing genuine user
// publish/discover calls to time out. 30s is enough cadence for a
// monitoring dashboard; set POLL_INTERVAL env var explicitly for faster.
const POLL_INTERVAL = parseInt(process.env['POLL_INTERVAL'] ?? '30000');
// Cap on how many pods get polled concurrently. Keeps the burst small
// enough that CSS can service real traffic alongside the dashboard.
const POLL_CONCURRENCY = parseInt(process.env['POLL_CONCURRENCY'] ?? '2');

// DCR-registered OAuth client at the relay. Registered once on startup;
// client_id is reused for every dashboard sign-in.
let DASHBOARD_OAUTH_CLIENT_ID: string | null = null;

function publicBaseUrl(req: IncomingMessage): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  return `${proto}://${host}`;
}

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
    // CSS's file-backed root listing is O(total files); on a long-running
    // pod with lots of accumulated sub-pods it can take tens of seconds.
    // Bail out quickly so a slow root listing doesn't wedge the poller.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    let resp;
    try {
      resp = await fetch(CSS_URL, {
        headers: { 'Accept': 'text/turtle' },
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
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
      if (!block.includes('iep:AuthorizedAgent')) continue;
      const idMatch = block.match(/iep:agentIdentity\s+<([^>]+)>/);
      const scopeMatch = block.match(/iep:scope\s+iep:(\w+)/);
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

// A cap on chain-following, so a malformed or cyclic `iep:manifestArchive` link set cannot
// make one poll of one pod fetch forever and wedge the poller for every other pod.
const MANIFEST_ARCHIVE_MAX_SEGMENTS = 512;

function absolutizeIri(iri: string, baseUrl: string): string {
  try { return new URL(iri, baseUrl).href; } catch { return iri; }
}

/** An archive link turned into a request against the manifest's own origin (see `fetchManifest`). */
function archiveFetchTarget(linkIri: string, manifestUrl: string): string | null {
  let basename: string;
  try { basename = new URL(linkIri, manifestUrl).pathname.split('/').filter(Boolean).pop() ?? ''; }
  catch { return null; }
  if (!/^context-graphs-archive-\d+$/.test(basename)) return null;
  try { return new URL(basename, manifestUrl).href; } catch { return null; }
}

/**
 * The archive segments a manifest — or a segment — says the rest of its index lives in.
 *
 * The objects arrive as a comma-separated list on one line, which is how the manifest header
 * emits them. `hydra:previous` is read too, since a segment links BACKWARD under that
 * predicate; the chain is then walkable from either end.
 */
function parseManifestArchiveLinks(turtle: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const predicate = /(?:iep:manifestArchive|hydra:previous)\s*((?:<[^>]*>\s*,\s*)*<[^>]*>)/g;
  let m: RegExpExecArray | null;
  while ((m = predicate.exec(turtle)) !== null) {
    for (const iri of m[1]!.matchAll(/<([^>]*)>/g)) {
      const abs = absolutizeIri(iri[1]!, baseUrl);
      if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
    }
  }
  return out;
}

/**
 * Parse manifest entry blocks out of one Turtle document. Archive segments repeat the
 * manifest's own entry format verbatim, so the same line scanner reads either kind.
 */
function parseManifestEntries(turtle: string, baseUrl: string): PodState['descriptors'] {
  const descriptors: PodState['descriptors'] = [];

  let current: PodState['descriptors'][0] | null = null;
  for (const rawLine of turtle.split('\n')) {
    const line = rawLine.trim();

    const entryMatch = line.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry/);
    if (entryMatch) {
      if (current) descriptors.push(current);
      current = { url: absolutizeIri(entryMatch[1]!, baseUrl), describes: [], facetTypes: [] };
      continue;
    }
    if (!current) continue;

    const descMatch = line.match(/iep:describes\s+<([^>]+)>/);
    if (descMatch) current.describes.push(descMatch[1]!);

    const facetMatch = line.match(/iep:hasFacetType\s+iep:(\w+)/);
    if (facetMatch) current.facetTypes.push(facetMatch[1]!);

    const fromMatch = line.match(/iep:validFrom\s+"([^"]+)"/);
    if (fromMatch) current.validFrom = fromMatch[1]!;

    const untilMatch = line.match(/iep:validUntil\s+"([^"]+)"/);
    if (untilMatch) current.validUntil = untilMatch[1]!;

    if (line.endsWith('.') && current) {
      descriptors.push(current);
      current = null;
    }
  }
  if (current) descriptors.push(current);

  return descriptors;
}

/**
 * Fetch the context-graphs manifest from a pod — hot document plus every archive segment it
 * advertises.
 *
 * ★ THIS DASHBOARD IS OBSERVATIONAL, SO A PARTIAL READ IS A FALSE OBSERVATION. The list this
 * returns is diffed against `knownDescriptorUrls` to decide what to broadcast. Read only the
 * hot manifest of a pod that has rolled over and every archived descriptor looks like it was
 * REMOVED — the dashboard would emit `descriptor_removed` for entries that are still on the
 * pod, and the pod's descriptor count would collapse to the hot limit. The whole point of a
 * purely observational surface is that what it shows happened, actually happened.
 *
 * ★ WHAT MAKES IT FOLLOW IS THE DOCUMENT, NOT THIS PROCESS'S CONFIGURATION: the
 * `iep:manifestArchive` links present in the body just fetched. Poll a pod that has never
 * rolled over and this is the same single request it always was — no env var decides it, so
 * the dashboard cannot be configured into disagreeing with the pod.
 */
async function fetchManifest(podUrl: string): Promise<PodState['descriptors']> {
  const manifestUrl = `${podUrl}.well-known/context-graphs`;
  const getTurtle = async (url: string): Promise<string | null> => {
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'text/turtle' } });
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  };

  const hot = await getTurtle(manifestUrl);
  if (hot === null) return [];

  // Segments are fetched in PARALLEL — the hot document names them all at once, so the whole
  // chain costs one extra round-trip rather than one per segment. That matters against CSS's
  // read-write locker, which POLL_CONCURRENCY exists to keep headroom in.
  const segments: Array<{ url: string; body: string }> = [];
  const visited = new Set<string>([manifestUrl]);
  // ★ THE LINK IS CANONICAL; THE REQUEST IS A SIBLING. Measured live: the maintainer pod's
  // manifest is written by the relay against the pod's internal CSS URL, so every archive link
  // names `http://css.railway.internal:3456/...`. Fetched verbatim from a process that cannot
  // resolve that host, every segment fails and the pod reads as its hot slice. A segment is
  // always a sibling of its manifest, so the request is built from the manifest's own origin
  // and the stored IRI is left exactly as published.
  const targets = (turtle: string, base: string): string[] =>
    parseManifestArchiveLinks(turtle, base)
      .map(l => archiveFetchTarget(l, manifestUrl))
      .filter((u): u is string => u !== null);
  let frontier = targets(hot, manifestUrl).filter(u => !visited.has(u));
  while (frontier.length > 0 && visited.size < MANIFEST_ARCHIVE_MAX_SEGMENTS) {
    frontier = frontier.slice(0, MANIFEST_ARCHIVE_MAX_SEGMENTS - visited.size);
    for (const u of frontier) visited.add(u);
    const fetched = await Promise.all(
      frontier.map(async (url) => ({ url, body: await getTurtle(url) })),
    );
    const next: string[] = [];
    for (const f of fetched) {
      if (f.body === null) continue;
      segments.push({ url: f.url, body: f.body });
      for (const link of targets(f.body, f.url)) {
        if (!visited.has(link) && !next.includes(link)) next.push(link);
      }
    }
    frontier = next;
  }

  // Roll-over PUTs the archive segment before it shortens the hot document, so an
  // interruption between the two leaves one entry in both. Dedupe by descriptor URL with the
  // HOT copy winning — it is the one the publish path has been maintaining. Archives are
  // merged first so the oldest entries stay first, as they were when the index was one file.
  const byUrl = new Map<string, PodState['descriptors'][0]>();
  for (const s of segments) {
    for (const e of parseManifestEntries(s.body, s.url)) byUrl.set(e.url, e);
  }
  for (const e of parseManifestEntries(hot, manifestUrl)) byUrl.set(e.url, e);
  return [...byUrl.values()];
}

// Rediscovery cadence: the CSS root listing is O(total files across all
// pods) on a file-backed backend — when pods accumulate, it can take
// tens of seconds per call. Previously we hit it every POLL_INTERVAL;
// now we run a fresh discovery at most once per DISCOVER_INTERVAL and
// reuse the cached pod name set in between. Polling known pods stays
// on the fast 3-second cadence.
const DISCOVER_INTERVAL_MS = parseInt(process.env['DISCOVER_INTERVAL'] ?? '60000');
let lastDiscoveredAt = 0;
let discoveredPodNames: string[] = [];

async function getPodNamesCached(): Promise<string[]> {
  const now = Date.now();
  if (discoveredPodNames.length > 0 && (now - lastDiscoveredAt) < DISCOVER_INTERVAL_MS) {
    return discoveredPodNames;
  }
  const fresh = await discoverPods();
  if (fresh.length > 0) {
    discoveredPodNames = fresh;
    lastDiscoveredAt = now;
  } else if (discoveredPodNames.length > 0) {
    // Keep the last known list rather than reverting to empty when a
    // single discovery call times out.
    return discoveredPodNames;
  } else {
    discoveredPodNames = fresh;
    lastDiscoveredAt = now;
  }
  return discoveredPodNames;
}

/**
 * Poll all pods and emit changes.
 */
async function pollOne(name: string): Promise<void> {
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

  for (const d of descriptors) {
    if (!knownDescriptorUrls.has(d.url)) {
      knownDescriptorUrls.add(d.url);
      if (prev) {
        broadcast({ type: 'descriptor_added', pod: name, data: d, timestamp: now });
        log(`New descriptor on ${name}: ${d.url}`);
      }
    }
  }

  if (prev) {
    const prevUrls = new Set(prev.descriptors.map(d => d.url));
    const currUrls = new Set(descriptors.map(d => d.url));
    for (const url of prevUrls) {
      if (!currUrls.has(url)) {
        knownDescriptorUrls.delete(url);
        broadcast({ type: 'descriptor_removed', pod: name, data: { url }, timestamp: now });
      }
    }
    const prevAgentIds = new Set(prev.agents.map(a => a.id));
    for (const a of state.agents) {
      if (!prevAgentIds.has(a.id)) {
        broadcast({ type: 'agent_registered', pod: name, data: a, timestamp: now });
        log(`New agent on ${name}: ${a.id}`);
      }
    }
  }

  pods.set(podUrl, state);
}

async function pollPods(): Promise<void> {
  const podNames = await getPodNamesCached();

  // Poll in chunks of POLL_CONCURRENCY so we don't burst every pod at
  // once — CSS's read-write locker only has a small pool of active
  // slots, and 12+ concurrent reads against /{user}/agents exhausts it
  // within the 6s lock expiry (see commit history for the incident).
  for (let i = 0; i < podNames.length; i += POLL_CONCURRENCY) {
    const batch = podNames.slice(i, i + POLL_CONCURRENCY);
    await Promise.all(
      batch.map(name => pollOne(name).catch(err => log(`pollOne(${name}) failed: ${(err as Error).message}`))),
    );
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

  // ★ HSTS, set ONCE at the top of the handler rather than at each writeHead.
  //
  // Measured 2026-08-03: this origin answered every request with no
  // Strict-Transport-Security while relay, identity and css-gate all sent it — and every
  // one of those three names https://dashboard.interego.xwisee.com in
  // Access-Control-Allow-Origin. So it is an origin three security-relevant services trust,
  // reached over a connection that never asserted HTTPS, and it is the host that receives
  // the OAuth `code` on /oauth/callback and exchanges it for a token.
  //
  // Safe here BECAUSE res.writeHead(status, obj) MERGES with anything already set via
  // setHeader — that covers every exit path at once: the OPTIONS 204, the json() helper,
  // the proxied upstream bodies and the 404 tail. "Remember it at each writeHead" is
  // exactly how it came to be missing here while three sibling services had it.
  //
  // max-age only, deliberately: includeSubDomains would bind every *.interego.xwisee.com
  // including any not fully on HTTPS, and preload is close to irreversible. Separate
  // decisions, guarded by tests/static-sites-404-and-hsts.test.ts.
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── /health ──────────────────────────────────────────────────────────────
  //
  // `build` is the git sha baked into the image, and it is the ONLY field here that can
  // distinguish one deployment from another. Without it this service could not be
  // redeployed verifiably, and so it was not redeployed at all: it carried the oldest pin
  // in the fleet for 22 days. tools/railway-redeploy.mjs polls this URL until `build`
  // equals the sha it just deployed, because Railway reports SUCCESS as soon as the
  // container binds a port, and on a tag that does not exist in the registry the OLD
  // container keeps serving and keeps answering 200. Before this route existed, GET
  // /health fell through to the 404 tail at the bottom of this handler.
  //
  // Side-effect free: reads module consts, touches no pod. It reflects the CSS/relay/
  // identity URLs, which on Railway are `.internal` hostnames — relay's /health already
  // does exactly that at the same trust level, so this is consistent with the fleet
  // rather than a new disclosure class.
  if (url === '/health' && method === 'GET') {
    json(res, {
      status: 'ok',
      css: CSS_URL,
      relay: RELAY_URL || null,
      identity: IDENTITY_URL || null,
      build: process.env['INTEREGO_BUILD_SHA'] ?? 'unset',
    });
    return;
  }

  if (url === '/' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(readFileSync(INDEX_HTML, 'utf-8'));
    return;
  }

  // /.well-known/security.txt — RFC 9116. Body from the shared
  // @interego/core builder (single source of truth across all 5
  // surfaces). See spec/policies/14-vulnerability-management.md §5.3.
  if ((url === '/.well-known/security.txt' || url === '/security.txt') && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(buildSecurityTxtFromEnv(process.env['PUBLIC_BASE_URL']));
    return;
  }

  // OAuth redirect target. The relay redirects back here with
  // ?code=...&state=... after a successful sign-in ceremony. Serve the
  // same index.html — the frontend JS detects the query string and
  // drives the code-for-token exchange against /api/oauth/exchange.
  if (url.startsWith('/oauth/callback') && method === 'GET') {
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

  // API: find the pgsl-stats.json file across any known pod and return
  // its parsed JSON (or null). Moves the polling fanout here so the
  // browser makes one request per tick instead of N, and so transient
  // 404s for pods without PGSL content don't spam the devtools console.
  if (url === '/api/pgsl-stats' && method === 'GET') {
    for (const podUrl of pods.keys()) {
      try {
        const resp = await fetch(`${podUrl}pgsl-stats.json`);
        if (!resp.ok) continue;
        const body = await resp.text();
        try {
          const data = JSON.parse(body);
          if (data && data.totalNodes !== undefined) {
            json(res, { pod: podUrl, stats: data });
            return;
          }
        } catch { /* non-JSON — skip */ }
      } catch { /* network error — skip */ }
    }
    json(res, { pod: null, stats: null });
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

  // API: legacy relay-tool proxy. Renamed from /api/relay/ to
  // /api/relay-tool/ so /api/relay/* can be a generic passthrough to
  // bearer-gated relay endpoints without collisions.
  if (url.startsWith('/api/relay-tool/') && method === 'POST' && RELAY_URL) {
    const toolName = url.slice('/api/relay-tool/'.length);
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

  // API: frontend config — tells the browser where to send identity calls
  if (url === '/api/config' && method === 'GET') {
    json(res, {
      cssUrl: CSS_URL,
      relayUrl: RELAY_URL || null,
      publicRelayUrl: PUBLIC_RELAY_URL || null,
      // Expose the proxy path, NOT the raw identity URL — because
      // the raw URL may be `.internal` and unreachable from browsers.
      identityProxy: IDENTITY_URL ? '/api/identity' : null,
      oauthClientId: DASHBOARD_OAUTH_CLIENT_ID,
      publicBaseUrl: publicBaseUrl(req),
    });
    return;
  }

  // API: OAuth callback token exchange + identity-token retrieval. The
  // browser redirects back to /oauth/callback?code=...&state=... after
  // signing in at the relay. The frontend calls /api/oauth/exchange with
  // the code + its PKCE verifier; we swap code for an MCP token at the
  // relay, then swap that for an identity bearer via /identity-token,
  // and return the identity bearer to the browser for direct use against
  // /api/identity/*.
  if (url === '/api/oauth/exchange' && method === 'POST' && RELAY_URL) {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { code, code_verifier, redirect_uri, client_id } = JSON.parse(body || '{}') as {
        code?: string; code_verifier?: string; redirect_uri?: string; client_id?: string;
      };
      if (!code || !code_verifier || !redirect_uri) {
        json(res, { error: 'code, code_verifier, redirect_uri required' }, 400);
        return;
      }
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier,
        redirect_uri,
        client_id: client_id ?? DASHBOARD_OAUTH_CLIENT_ID ?? '',
      });
      const tokenResp = await fetch(`${RELAY_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        json(res, { error: `Token exchange failed: ${err}` }, tokenResp.status);
        return;
      }
      const tokenJson = await tokenResp.json() as { access_token?: string; expires_in?: number };
      if (!tokenJson.access_token) {
        json(res, { error: 'No access_token in token response' }, 502);
        return;
      }
      // Now fetch the identity bearer token backing this MCP token.
      const idResp = await fetch(`${RELAY_URL}/identity-token`, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (!idResp.ok) {
        const err = await idResp.text();
        json(res, { error: `identity-token fetch failed: ${err}` }, idResp.status);
        return;
      }
      const idJson = await idResp.json() as { identityToken?: string; expiresAt?: number; userId?: string };
      if (!idJson.identityToken) {
        json(res, { error: 'identity-token response missing identityToken' }, 502);
        return;
      }
      json(res, {
        identityToken: idJson.identityToken,
        expiresAt: idJson.expiresAt,
        userId: idJson.userId,
        mcpAccessToken: tokenJson.access_token,
        mcpRefreshToken: (tokenJson as { refresh_token?: string }).refresh_token,
        mcpExpiresIn: tokenJson.expires_in,
      });
    } catch (err) {
      json(res, { error: `OAuth exchange failed: ${(err as Error).message}` }, 502);
    }
    return;
  }

  // API: silent refresh. The browser holds the relay's MCP refresh token
  // (returned from /api/oauth/exchange). When the identity bearer 401s
  // mid-session we swap the refresh token for a new MCP access token, then
  // trade that for a fresh identity bearer via /identity-token. The
  // frontend retries its original request with the new identity bearer.
  if (url === '/api/oauth/refresh' && method === 'POST' && RELAY_URL) {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { refresh_token, client_id } = JSON.parse(body || '{}') as {
        refresh_token?: string; client_id?: string;
      };
      if (!refresh_token) { json(res, { error: 'refresh_token required' }, 400); return; }
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
        client_id: client_id ?? DASHBOARD_OAUTH_CLIENT_ID ?? '',
      });
      const tokenResp = await fetch(`${RELAY_URL}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!tokenResp.ok) {
        json(res, { error: `Refresh failed: ${await tokenResp.text()}` }, tokenResp.status);
        return;
      }
      const tokenJson = await tokenResp.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!tokenJson.access_token) { json(res, { error: 'no access_token returned' }, 502); return; }
      const idResp = await fetch(`${RELAY_URL}/identity-token`, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      if (!idResp.ok) { json(res, { error: `identity-token failed: ${await idResp.text()}` }, idResp.status); return; }
      const idJson = await idResp.json() as { identityToken?: string; expiresAt?: number; userId?: string };
      json(res, {
        identityToken: idJson.identityToken,
        expiresAt: idJson.expiresAt,
        userId: idJson.userId,
        mcpAccessToken: tokenJson.access_token,
        mcpRefreshToken: tokenJson.refresh_token,
        mcpExpiresIn: tokenJson.expires_in,
      });
    } catch (err) {
      json(res, { error: `Refresh exchange failed: ${(err as Error).message}` }, 502);
    }
    return;
  }

  // API: relay passthrough. Forwards the browser's request verbatim
  // (headers + body) to the configured RELAY_URL. Used for calls that
  // require an MCP access token rather than an identity bearer — e.g.
  // the POST /agents/:iri/revoke endpoint which reads + writes the
  // user's pod agent registry via @interego/core.
  if (url.startsWith('/api/relay/') && RELAY_URL) {
    const upstreamPath = url.slice('/api/relay'.length);
    try {
      let reqBody: Buffer | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (chunks.length) reqBody = Buffer.concat(chunks);
      }
      const headers: Record<string, string> = {};
      if (req.headers['authorization']) headers['authorization'] = String(req.headers['authorization']);
      if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
      const upstream = await fetch(`${RELAY_URL}${upstreamPath}`, { method, headers, body: reqBody });
      const ct = upstream.headers.get('content-type') ?? 'application/json';
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    } catch (err) {
      json(res, { error: `Relay proxy failed: ${(err as Error).message}` }, 502);
    }
    return;
  }

  // API: identity-server proxy. Forwards the browser's request verbatim
  // to the configured IDENTITY_URL including Authorization / body, then
  // echoes the response. The dashboard backend runs inside the same
  // Azure environment as identity, so `.internal` hosts are reachable.
  if (url.startsWith('/api/identity/') && IDENTITY_URL) {
    const upstreamPath = url.slice('/api/identity'.length); // includes leading '/'
    try {
      let body: Buffer | undefined;
      if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE' && method !== 'OPTIONS') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        body = Buffer.concat(chunks);
      } else if (method === 'DELETE') {
        // DELETE may still carry a JSON body (e.g. did removal).
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (chunks.length) body = Buffer.concat(chunks);
      }
      const headers: Record<string, string> = {};
      if (req.headers['authorization']) headers['authorization'] = String(req.headers['authorization']);
      if (req.headers['content-type']) headers['content-type'] = String(req.headers['content-type']);
      else if (body && body.length) headers['content-type'] = 'application/json';
      const upstream = await fetch(`${IDENTITY_URL}${upstreamPath}`, {
        method,
        headers,
        body,
      });
      const ct = upstream.headers.get('content-type') ?? 'application/json';
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    } catch (err) {
      json(res, { error: `Identity proxy failed: ${(err as Error).message}` }, 502);
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
  if (PUBLIC_RELAY_URL && PUBLIC_RELAY_URL !== RELAY_URL) log(`Public relay (for browser redirect): ${PUBLIC_RELAY_URL}`);
  if (IDENTITY_URL) log(`Identity: ${IDENTITY_URL} (proxied via /api/identity)`);
  log(`Polling every ${POLL_INTERVAL}ms`);

  // Dynamic-client-registration against the relay so the "Sign in"
  // button can drive a full OAuth 2.1 + PKCE flow without the operator
  // pre-provisioning credentials. Registration is idempotent from the
  // dashboard's perspective — we keep one client_id per container
  // lifetime; a fresh one is minted on restart which is harmless since
  // dynamic clients are intended exactly for this.
  if (RELAY_URL && PUBLIC_BASE_URL) {
    try {
      const redirectUri = `${PUBLIC_BASE_URL}/oauth/callback`;
      const dcr = await fetch(`${RELAY_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Interego Dashboard',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'mcp',
        }),
      });
      if (dcr.ok) {
        const { client_id } = await dcr.json() as { client_id: string };
        DASHBOARD_OAUTH_CLIENT_ID = client_id;
        log(`OAuth client registered with relay: ${client_id}`);
      } else {
        log(`WARN: DCR against relay failed (${dcr.status}) — sign-in will require manual token paste`);
      }
    } catch (err) {
      log(`WARN: DCR threw ${(err as Error).message} — sign-in will require manual token paste`);
    }
  } else if (RELAY_URL && !PUBLIC_BASE_URL) {
    log(`NOTE: set PUBLIC_BASE_URL to enable OAuth sign-in flow (e.g. https://interego-dashboard.<host>).`);
  }

  // Initial poll
  await pollPods().catch(err => log(`Initial poll failed: ${(err as Error).message}`));

  // Start polling loop
  /**
   * ── ★★ ONE SWEEP AT A TIME. THIS TOOK DOWN THE FLEET'S STORAGE GATE ─────────
   *
   * `setInterval` fires on a clock, not on completion. A full sweep is every pod × two documents
   * at POLL_CONCURRENCY 2, so once the pod count grew past what fits in POLL_INTERVAL, each tick
   * started a sweep while the previous one was still running. They stack — and it is
   * self-reinforcing: more overlap makes every request slower, which makes each sweep longer,
   * which stacks more.
   *
   * MEASURED, live: this dashboard was sending 68 requests/second at css-gate, whose upstream pool
   * is 16 connections. 668 requests were queued behind them and the gate stopped answering
   * ENTIRELY — it accepted TLS and never replied. Every Foxxi capability reads pods through that
   * gate, so a performance review that answers in 40 s could not run at all, and the agent asked
   * to run it concluded — reasonably, from what it could see — that the capability did not exist.
   *
   * Restarting this service dropped the gate from 68/s to 4/s, its queue from 668 to 0, and its
   * proxy latency from a 20 s timeout to 1.1 s. That is what identified the cause.
   *
   * ★ AND A SKIPPED TICK IS REPORTED. A sweep that cannot finish inside its own interval is a
   * fact about this deployment — it means POLL_INTERVAL is too short for the number of pods — and
   * silently coalescing it would hide the thing that made the pile-up possible.
   */
  let pollInFlight = false;
  let skipped = 0;
  pollTimer = setInterval(() => {
    if (pollInFlight) {
      skipped += 1;
      // Every tick would be its own noise; the first and then every tenth is enough to see it.
      if (skipped === 1 || skipped % 10 === 0) {
        log(`previous poll still running — skipped ${skipped} tick(s). `
          + `A sweep is taking longer than POLL_INTERVAL (${POLL_INTERVAL}ms); raise it or raise POLL_CONCURRENCY.`);
      }
      return;
    }
    pollInFlight = true;
    if (skipped > 0) { log(`resuming after skipping ${skipped} tick(s)`); skipped = 0; }
    pollPods()
      .catch(err => log(`Poll error: ${(err as Error).message}`))
      .finally(() => { pollInFlight = false; });
  }, POLL_INTERVAL);

  broadcast({
    type: 'system',
    data: { action: 'started', css: CSS_URL },
    timestamp: new Date().toISOString(),
  });
});

process.on('SIGINT', () => { if (pollTimer) clearInterval(pollTimer); process.exit(0); });
process.on('SIGTERM', () => { if (pollTimer) clearInterval(pollTimer); process.exit(0); });
