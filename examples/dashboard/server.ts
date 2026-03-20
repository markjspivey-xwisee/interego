#!/usr/bin/env tsx
/**
 * Context Graphs Federation Dashboard
 *
 * Observation dashboard for autonomous AI coding agents sharing
 * context-annotated knowledge graphs through decentralized Solid pods.
 *
 * On launch:
 *   1. Starts a real Community Solid Server (in-memory, open access)
 *   2. Provisions two pods — one per agent
 *   3. Runs a multi-agent scenario autonomously on a timed schedule
 *   4. Streams every event to the browser via SSE for observation
 *
 * The agents:
 *   Claude Code (developer: Alice)  — pod /alice/
 *   Codex (developer: Bob)          — pod /bob/
 *
 * The scenario (runs automatically):
 *   Phase 1 — Codex subscribes to Alice's pod for live context updates
 *   Phase 2 — Claude Code analyzes a microservice architecture and
 *             publishes the knowledge graph + context descriptor
 *   Phase 3 — Codex discovers and fetches Alice's published context,
 *             builds its own local context, composes them (intersection)
 *   Phase 4 — Claude Code publishes a revised analysis (v2)
 *   Phase 5 — Codex re-discovers the updated manifest
 *
 * The dashboard is read-only observation — agents drive themselves.
 * A "Replay" button re-runs the scenario from scratch.
 */

import { createServer, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
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
} from '@foxxi/context-graphs';

import type {
  IRI,
  ContextDescriptorData,
  FetchFn,
  WebSocketConstructor,
  ContextChangeEvent,
  Subscription,
} from '@foxxi/context-graphs';

// ── Config ──────────────────────────────────────────────────

const DASH_PORT = 4000;
const CSS_PORT = 3456;
const BASE_URL = `http://localhost:${CSS_PORT}/`;
const ALICE_POD = `${BASE_URL}alice/`;
const BOB_POD = `${BASE_URL}bob/`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_CONFIG = resolve(__dirname, '..', 'multi-agent', 'css-config.json');
const CSS_BIN = resolve(__dirname, 'node_modules/.bin/community-solid-server');
const INDEX_HTML = resolve(__dirname, 'index.html');

// Agent identities
const AGENTS = {
  claude: {
    name: 'Claude Code',
    developer: 'Alice',
    did: 'did:web:alice.dev' as IRI,
    pod: ALICE_POD,
    isSoftwareAgent: true,
    identity: 'urn:agent:anthropic:claude-code' as IRI,
  },
  codex: {
    name: 'Codex CLI',
    developer: 'Bob',
    did: 'did:web:bob.dev' as IRI,
    pod: BOB_POD,
    isSoftwareAgent: true,
    identity: 'urn:agent:openai:codex-cli' as IRI,
  },
} as const;

// ── State ───────────────────────────────────────────────────

let cssProcess: ChildProcess | null = null;
let claudeDescriptor: ContextDescriptorData | null = null;
let codexSubscription: Subscription | null = null;
let scenarioRunning = false;
const sseClients: Set<ServerResponse> = new Set();

// ── SSE ─────────────────────────────────────────────────────

interface DashEvent {
  type: 'system' | 'claude' | 'codex' | 'notification' | 'error';
  agent?: string;
  action: string;
  data: unknown;
  timestamp: string;
}

function broadcast(event: DashEvent): void {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function emit(type: DashEvent['type'], action: string, data: unknown = null): void {
  const agent = type === 'claude' ? AGENTS.claude.name
              : type === 'codex'  ? AGENTS.codex.name
              : undefined;
  broadcast({ type, agent, action, data, timestamp: new Date().toISOString() });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

async function startCSS(): Promise<void> {
  if (cssProcess) return;

  emit('system', 'css-starting', { port: CSS_PORT });

  return new Promise((resolve, reject) => {
    const proc = spawn(CSS_BIN, [
      '-c', CSS_CONFIG,
      '-p', String(CSS_PORT),
      '-l', 'warn',
      '--baseUrl', BASE_URL,
    ], { stdio: ['ignore', 'pipe', 'pipe'], shell: true });

    let started = false;
    cssProcess = proc;

    proc.on('error', (err) => { if (!started) reject(err); });

    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try {
        const resp = await fetch(BASE_URL);
        if (resp.ok || resp.status < 500) {
          clearInterval(poll);
          started = true;
          emit('system', 'css-ready', { baseUrl: BASE_URL });

          for (const agent of Object.values(AGENTS)) {
            await fetch(agent.pod, {
              method: 'PUT',
              headers: {
                'Content-Type': 'text/turtle',
                'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
              },
              body: '',
            });
          }
          emit('system', 'pods-ready', {
            pods: Object.values(AGENTS).map(a => ({ agent: a.name, developer: a.developer, pod: a.pod })),
          });
          resolve();
        }
      } catch { /* not ready */ }
    }, 400);

    setTimeout(() => { clearInterval(poll); if (!started) reject(new Error('CSS startup timeout')); }, 30_000);
  });
}

function stopCSS(): void {
  if (codexSubscription) {
    codexSubscription.unsubscribe();
    codexSubscription = null;
  }
  if (cssProcess) {
    cssProcess.kill('SIGTERM');
    cssProcess = null;
    emit('system', 'css-stopped');
  }
  claudeDescriptor = null;
  scenarioRunning = false;
}

// ═════════════════════════════════════════════════════════════
//  AUTONOMOUS SCENARIO
// ═════════════════════════════════════════════════════════════

async function runScenario(): Promise<void> {
  if (scenarioRunning) return;
  scenarioRunning = true;

  try {
    // ── Infrastructure ──────────────────────────────────────
    emit('system', 'scenario-start');
    await startCSS();
    await sleep(500);

    // ── Phase 1: Codex subscribes to Claude Code's pod ──────
    emit('system', 'phase', { phase: 1, title: 'Codex subscribes to Claude Code\'s pod' });
    await sleep(600);

    try {
      const sub = await subscribe(AGENTS.claude.pod, (event: ContextChangeEvent) => {
        emit('notification', 'ws-event', {
          ...event,
          subscribedBy: AGENTS.codex.name,
          watchingPod: AGENTS.claude.pod,
        });
      }, {
        fetch: solidFetch,
        WebSocket: WebSocket as unknown as WebSocketConstructor,
      });
      codexSubscription = sub;
      emit('codex', 'subscribed', {
        topic: `${AGENTS.claude.pod}.well-known/context-graphs`,
        protocol: 'WebSocketChannel2023',
      });
    } catch (err) {
      emit('codex', 'subscribe-failed', { error: (err as Error).message });
    }

    await sleep(800);

    // ── Phase 2: Claude Code publishes architectural context ─
    emit('system', 'phase', { phase: 2, title: 'Claude Code publishes architectural analysis' });
    await sleep(600);

    // Claude Code analyzed Alice's microservice architecture
    const graphContent = [
      '@prefix schema: <https://schema.org/> .',
      '@prefix arch: <https://example.org/architecture#> .',
      '@prefix dep: <https://example.org/dependency#> .',
      '',
      '# Claude Code analyzed this architecture during a refactoring session',
      '<urn:arch:api-gateway> a arch:Service ;',
      '    schema:name "API Gateway" ;',
      '    arch:dependsOn <urn:arch:auth-service>, <urn:arch:user-service> ;',
      '    arch:protocol "gRPC" ;',
      '    arch:healthEndpoint "/healthz" ;',
      '    dep:riskLevel "low" .',
      '',
      '<urn:arch:auth-service> a arch:Service ;',
      '    schema:name "Authentication Service" ;',
      '    arch:dependsOn <urn:arch:user-service> ;',
      '    arch:protocol "gRPC" ;',
      '    arch:usesDatabase <urn:arch:redis-session-store> ;',
      '    dep:riskLevel "high" ;',
      '    dep:reason "Session store migration pending" .',
      '',
      '<urn:arch:user-service> a arch:Service ;',
      '    schema:name "User Service" ;',
      '    arch:protocol "REST" ;',
      '    arch:usesDatabase <urn:arch:postgres-users> ;',
      '    dep:riskLevel "medium" .',
      '',
      '<urn:arch:redis-session-store> a arch:Database ;',
      '    schema:name "Session Store" ;',
      '    arch:engine "Redis 7" .',
      '',
      '<urn:arch:postgres-users> a arch:Database ;',
      '    schema:name "Users DB" ;',
      '    arch:engine "PostgreSQL 16" .',
    ].join('\n');

    emit('claude', 'analyzing', {
      task: 'Microservice architecture analysis during refactoring session',
      graph: 'urn:graph:alice:architecture-v3',
    });
    await sleep(400);

    claudeDescriptor = ContextDescriptor.create('urn:cg:claude-code:arch-analysis:alice-repo' as IRI)
      .describes('urn:graph:alice:architecture-v3' as IRI)
      .temporal({
        validFrom: '2026-01-15T10:00:00Z',
        validUntil: '2026-06-30T23:59:59Z',
        temporalResolution: 'P1D',
      })
      .provenance({
        wasGeneratedBy: {
          id: 'urn:activity:claude-code:session-2026-01-15' as IRI,
          agent: AGENTS.claude.identity,
          startedAt: '2026-01-15T10:00:00Z',
          endedAt: '2026-01-15T10:02:37Z',
        },
        wasAttributedTo: AGENTS.claude.did,
        generatedAtTime: '2026-01-15T10:02:37Z',
      })
      .agent(AGENTS.claude.did, 'Author')
      .semiotic({
        modalStatus: 'Asserted',
        epistemicConfidence: 0.92,
        groundTruth: true,
      })
      .trust({
        trustLevel: 'SelfAsserted',
        issuer: AGENTS.claude.did,
      })
      .federation({
        origin: AGENTS.claude.pod as IRI,
        storageEndpoint: AGENTS.claude.pod as IRI,
        syncProtocol: 'SolidNotifications',
      })
      .version(1)
      .build();

    const validation = validate(claudeDescriptor);
    emit('claude', 'descriptor-built', {
      id: claudeDescriptor.id,
      facetCount: claudeDescriptor.facets.length,
      facetTypes: claudeDescriptor.facets.map(f => f.type),
      valid: validation.conforms,
      turtle: toTurtle(claudeDescriptor),
      jsonld: JSON.parse(toJsonLdString(claudeDescriptor)),
      graphContent,
    });

    await sleep(300);

    const pubResult = await publish(claudeDescriptor, graphContent, AGENTS.claude.pod, { fetch: solidFetch });
    emit('claude', 'published', {
      descriptorUrl: pubResult.descriptorUrl,
      graphUrl: pubResult.graphUrl,
      manifestUrl: pubResult.manifestUrl,
    });

    // Verify round-trip
    const verifyResp = await fetch(pubResult.descriptorUrl, { headers: { 'Accept': 'text/turtle' } });
    const verifyBody = await verifyResp.text();
    emit('claude', 'verified', { url: pubResult.descriptorUrl, status: verifyResp.status, bytes: verifyBody.length });

    await sleep(1200);

    // ── Phase 3: Codex discovers and composes ───────────────
    emit('system', 'phase', { phase: 3, title: 'Codex discovers context, builds local view, composes' });
    await sleep(600);

    // Codex discovers what's on Claude Code's pod
    emit('codex', 'discovering', { pod: AGENTS.claude.pod });
    await sleep(300);

    const allEntries = await discover(AGENTS.claude.pod, undefined, { fetch: solidFetch });
    emit('codex', 'discovered', { count: allEntries.length, entries: allEntries });

    await sleep(400);

    // Codex filters by temporal range
    const currentEntries = await discover(AGENTS.claude.pod, {
      validFrom: '2026-03-01T00:00:00Z',
      validUntil: '2026-03-31T23:59:59Z',
    }, { fetch: solidFetch });
    emit('codex', 'filtered', {
      filter: 'valid in March 2026',
      count: currentEntries.length,
      entries: currentEntries,
    });

    await sleep(400);

    // Codex fetches the full descriptor
    if (allEntries.length > 0) {
      const entry = allEntries[0]!;
      const descResp = await fetch(entry.descriptorUrl, { headers: { 'Accept': 'text/turtle' } });
      const descTurtle = await descResp.text();
      emit('codex', 'fetched-descriptor', { url: entry.descriptorUrl, bytes: descTurtle.length, turtle: descTurtle });
    }

    await sleep(600);

    // Codex builds its own context — a code review it performed on the same repo
    emit('codex', 'analyzing', {
      task: 'Dependency audit and security review of same architecture',
      graph: 'urn:graph:alice:architecture-v3',
    });
    await sleep(400);

    const codexDescriptor = ContextDescriptor.create('urn:cg:codex:dep-audit:alice-repo' as IRI)
      .describes('urn:graph:alice:architecture-v3' as IRI)
      .temporal({
        validFrom: '2026-03-01T00:00:00Z',
        validUntil: '2026-03-31T23:59:59Z',
      })
      .provenance({
        wasGeneratedBy: {
          id: 'urn:activity:codex:audit-2026-03-19' as IRI,
          agent: AGENTS.codex.identity,
          startedAt: '2026-03-19T14:00:00Z',
          endedAt: '2026-03-19T14:05:12Z',
        },
        wasAttributedTo: AGENTS.codex.did,
        generatedAtTime: '2026-03-19T14:05:12Z',
      })
      .agent(AGENTS.codex.did, 'Curator')
      .semiotic({
        modalStatus: 'Hypothetical',
        epistemicConfidence: 0.7,
        groundTruth: false,
      })
      .trust({
        trustLevel: 'SelfAsserted',
        issuer: AGENTS.codex.did,
      })
      .federation({
        origin: AGENTS.codex.pod as IRI,
        storageEndpoint: AGENTS.codex.pod as IRI,
        syncProtocol: 'SolidNotifications',
      })
      .version(1)
      .build();

    emit('codex', 'descriptor-built', {
      id: codexDescriptor.id,
      facetCount: codexDescriptor.facets.length,
      facetTypes: codexDescriptor.facets.map(f => f.type),
      turtle: toTurtle(codexDescriptor),
      jsonld: JSON.parse(toJsonLdString(codexDescriptor)),
    });

    await sleep(600);

    // Compose: intersection of both agents' context
    emit('codex', 'composing', {
      op: 'intersection',
      left: { agent: AGENTS.claude.name, descriptor: claudeDescriptor.id },
      right: { agent: AGENTS.codex.name, descriptor: codexDescriptor.id },
    });
    await sleep(400);

    const composed = intersection(claudeDescriptor, codexDescriptor);
    emit('codex', 'composed', {
      id: composed.id,
      op: composed.compositionOp,
      operands: composed.operands,
      facetCount: composed.facets.length,
      facetTypes: composed.facets.map(f => f.type),
      turtle: toTurtle(composed),
      jsonld: JSON.parse(toJsonLdString(composed)),
      temporalOverlap: composed.facets.find(f => f.type === 'Temporal'),
      semioticFacets: composed.facets.filter(f => f.type === 'Semiotic'),
    });

    // Codex publishes its context to its own pod too
    await sleep(600);
    emit('codex', 'publishing', { pod: AGENTS.codex.pod });
    const codexGraph = '<urn:arch:auth-service> <https://example.org/dependency#cveCount> "3" .';
    const codexPub = await publish(codexDescriptor, codexGraph, AGENTS.codex.pod, { fetch: solidFetch });
    emit('codex', 'published', codexPub);

    await sleep(1000);

    // ── Phase 4: Claude Code publishes revision ─────────────
    emit('system', 'phase', { phase: 4, title: 'Claude Code revises analysis after discovering Codex\'s audit' });
    await sleep(600);

    // Claude Code discovers Codex's pod
    emit('claude', 'discovering', { pod: AGENTS.codex.pod });
    await sleep(300);
    const codexEntries = await discover(AGENTS.codex.pod, undefined, { fetch: solidFetch });
    emit('claude', 'discovered', { count: codexEntries.length, entries: codexEntries, fromAgent: AGENTS.codex.name });

    await sleep(600);

    // Claude Code publishes v2 incorporating Codex's findings
    const updatedDesc = ContextDescriptor.create('urn:cg:claude-code:arch-analysis:alice-repo:v2' as IRI)
      .describes('urn:graph:alice:architecture-v3' as IRI)
      .temporal({
        validFrom: '2026-03-19T15:00:00Z',
        validUntil: '2026-09-30T23:59:59Z',
      })
      .provenance({
        wasGeneratedBy: {
          id: 'urn:activity:claude-code:revision-2026-03-19' as IRI,
          agent: AGENTS.claude.identity,
          startedAt: '2026-03-19T15:00:00Z',
          endedAt: '2026-03-19T15:01:44Z',
        },
        wasDerivedFrom: ['urn:cg:codex:dep-audit:alice-repo' as IRI],
        wasAttributedTo: AGENTS.claude.did,
        generatedAtTime: '2026-03-19T15:01:44Z',
      })
      .agent(AGENTS.claude.did, 'Author')
      .asserted(0.97)
      .trust({
        trustLevel: 'SelfAsserted',
        issuer: AGENTS.claude.did,
      })
      .federation({
        origin: AGENTS.claude.pod as IRI,
        storageEndpoint: AGENTS.claude.pod as IRI,
        syncProtocol: 'SolidNotifications',
      })
      .version(2)
      .supersedes('urn:cg:claude-code:arch-analysis:alice-repo' as IRI)
      .build();

    emit('claude', 'revision-built', {
      id: updatedDesc.id,
      version: 2,
      supersedes: 'urn:cg:claude-code:arch-analysis:alice-repo',
      derivedFrom: 'urn:cg:codex:dep-audit:alice-repo',
      turtle: toTurtle(updatedDesc),
      jsonld: JSON.parse(toJsonLdString(updatedDesc)),
    });
    await sleep(300);

    const updGraph = [
      '<urn:arch:auth-service> <https://example.org/dependency#riskLevel> "critical" .',
      '<urn:arch:auth-service> <https://example.org/dependency#reason> "3 CVEs found by Codex audit" .',
    ].join('\n');
    const updPub = await publish(updatedDesc, updGraph, AGENTS.claude.pod, { fetch: solidFetch });
    emit('claude', 'revision-published', updPub);

    await sleep(1200);

    // ── Phase 5: Codex re-discovers updated manifest ────────
    emit('system', 'phase', { phase: 5, title: 'Codex re-discovers Claude Code\'s updated manifest' });
    await sleep(600);

    const updatedEntries = await discover(AGENTS.claude.pod, undefined, { fetch: solidFetch });
    emit('codex', 'rediscovered', { count: updatedEntries.length, entries: updatedEntries });

    await sleep(400);

    // ── Done ────────────────────────────────────────────────
    emit('system', 'scenario-complete', {
      totalDescriptors: {
        [AGENTS.claude.name]: 2,
        [AGENTS.codex.name]: 1,
      },
      compositionsPerformed: 1,
      liveNotificationsReceived: true,
    });

  } catch (err) {
    emit('error', 'scenario-failed', (err as Error).message);
  } finally {
    scenarioRunning = false;
  }
}

// ── HTTP Server ─────────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
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
    res.write(`data: ${JSON.stringify({ type: 'system', action: 'connected', data: null, timestamp: new Date().toISOString() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url === '/run' && method === 'POST') {
    if (scenarioRunning) {
      json(res, { ok: false, error: 'Scenario already running' });
      return;
    }
    // Stop any previous run
    stopCSS();
    await sleep(500);
    json(res, { ok: true });
    // Fire and forget — events stream via SSE
    runScenario().catch(err => emit('error', 'scenario-crashed', (err as Error).message));
    return;
  }

  if (url === '/stop' && method === 'POST') {
    stopCSS();
    json(res, { ok: true });
    return;
  }

  // Proxy pod reads
  if (url.startsWith('/pod/') && method === 'GET') {
    const podPath = url.slice(5);
    try {
      const resp = await fetch(`${BASE_URL}${podPath}`, { headers: { 'Accept': 'text/turtle' } });
      const body = await resp.text();
      res.writeHead(resp.status, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    } catch (err) {
      json(res, { error: (err as Error).message }, 502);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(DASH_PORT, () => {
  console.log(`\n  Context Graphs Dashboard: http://localhost:${DASH_PORT}/\n`);
  console.log(`  Agents: ${AGENTS.claude.name} (${AGENTS.claude.developer}'s pod)`);
  console.log(`          ${AGENTS.codex.name} (${AGENTS.codex.developer}'s pod)\n`);
});

process.on('SIGINT', () => { stopCSS(); process.exit(0); });
process.on('SIGTERM', () => { stopCSS(); process.exit(0); });
