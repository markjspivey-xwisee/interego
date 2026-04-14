#!/usr/bin/env tsx
/**
 * Multi-Agent Interego — Real End-to-End Demo
 *
 * Starts a real Community Solid Server (in-memory, open access),
 * then runs two agents that communicate context-annotated knowledge
 * graphs through that server over plain HTTP and WebSocket.
 *
 * Agent A (Alice): Publishes an architectural knowledge graph with
 *   full context metadata — temporal validity, provenance, semiotic
 *   frame, trust credentials, and federation facet pointing at her pod.
 *
 * Agent B (Bob): Subscribes to Alice's pod for live notifications,
 *   discovers her published context descriptors, fetches them,
 *   composes them with his own local context using the intersection
 *   operator, and prints the merged result.
 *
 * No mocks. No simulations. Real HTTP PUT/GET, real WebSocket,
 * real Solid pod, real RDF serialization.
 */

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
  publish,
  discover,
  subscribe,
} from '@interego/core';

import type {
  IRI,
  ContextDescriptorData,
  ManifestEntry,
  ContextChangeEvent,
  FetchFn,
  WebSocketConstructor,
} from '@interego/core';

// ── Configuration ───────────────────────────────────────────

const CSS_PORT = 3456;
const BASE_URL = `http://localhost:${CSS_PORT}/`;
const ALICE_POD = `${BASE_URL}alice/`;
const BOB_POD = `${BASE_URL}bob/`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_CONFIG = resolve(__dirname, 'css-config.json');
const CSS_BIN = resolve(__dirname, 'node_modules/.bin/community-solid-server');

// ── Utility ─────────────────────────────────────────────────

function log(agent: string, msg: string): void {
  const tag = agent === 'Alice' ? '\x1b[35m[Alice]\x1b[0m' :
              agent === 'Bob'   ? '\x1b[36m[Bob]\x1b[0m'   :
                                  '\x1b[33m[System]\x1b[0m';
  console.log(`${tag} ${msg}`);
}

/** Wrap Node fetch as FetchFn for our library's interface. */
const solidFetch: FetchFn = async (url, init) => {
  const resp = await fetch(url, init as RequestInit);
  return {
    ok: resp.ok,
    status: resp.status,
    statusText: resp.statusText,
    headers: {
      get: (name: string) => resp.headers.get(name),
    },
    text: () => resp.text(),
    json: () => resp.json(),
  };
};

// ── CSS Lifecycle ───────────────────────────────────────────

function startCSS(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    log('System', `Starting Community Solid Server on port ${CSS_PORT}...`);

    const proc = spawn(CSS_BIN, [
      '-c', CSS_CONFIG,
      '-p', String(CSS_PORT),
      '-l', 'warn',
      '--baseUrl', BASE_URL,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    let started = false;

    proc.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      if (!started && text.includes('Listening')) {
        started = true;
        log('System', `CSS running at ${BASE_URL}`);
        resolve(proc);
      }
    });

    proc.stderr!.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (text && !started) {
        // CSS logs info to stderr sometimes
        if (text.includes('Listening')) {
          started = true;
          log('System', `CSS running at ${BASE_URL}`);
          resolve(proc);
        }
      }
    });

    proc.on('error', (err) => {
      if (!started) reject(err);
    });

    proc.on('exit', (code) => {
      if (!started) reject(new Error(`CSS exited with code ${code}`));
    });

    // Fallback: poll for readiness
    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try {
        const resp = await fetch(BASE_URL);
        if (resp.ok || resp.status < 500) {
          clearInterval(poll);
          if (!started) {
            started = true;
            log('System', `CSS running at ${BASE_URL}`);
            resolve(proc);
          }
        }
      } catch {
        // Not ready yet
      }
    }, 500);

    // Hard timeout
    setTimeout(() => {
      clearInterval(poll);
      if (!started) reject(new Error('CSS did not start within 30s'));
    }, 30_000);
  });
}

async function ensurePodContainer(podUrl: string): Promise<void> {
  // Create the pod root container via PUT
  const resp = await fetch(podUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/turtle',
      'Link': '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    },
    body: '',
  });
  // 201 Created or 205 Reset Content or 409 Already Exists — all fine
  if (!resp.ok && resp.status !== 409) {
    // Container might already exist or be auto-created
    const existing = await fetch(podUrl);
    if (!existing.ok) {
      throw new Error(`Failed to ensure pod at ${podUrl}: ${resp.status}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════
//  AGENT A — Alice (Publisher)
// ═════════════════════════════════════════════════════════════

async function agentAlice(): Promise<ContextDescriptorData> {
  log('Alice', 'Building architectural knowledge graph...');

  // The graph content — Alice's Claude Code agent produced this
  // analysis of a microservice architecture.
  const graphContent = [
    '@prefix schema: <https://schema.org/>.',
    '@prefix arch: <https://example.org/architecture#>.',
    '',
    '<urn:arch:api-gateway> a arch:Service ;',
    '    schema:name "API Gateway" ;',
    '    arch:dependsOn <urn:arch:auth-service>, <urn:arch:user-service> ;',
    '    arch:protocol "gRPC" ;',
    '    arch:healthEndpoint "/healthz".',
    '',
    '<urn:arch:auth-service> a arch:Service ;',
    '    schema:name "Authentication Service" ;',
    '    arch:dependsOn <urn:arch:user-service> ;',
    '    arch:protocol "gRPC" ;',
    '    arch:usesDatabase <urn:arch:redis-session-store>.',
    '',
    '<urn:arch:user-service> a arch:Service ;',
    '    schema:name "User Service" ;',
    '    arch:protocol "REST" ;',
    '    arch:usesDatabase <urn:arch:postgres-users>.',
    '',
    '<urn:arch:redis-session-store> a arch:Database ;',
    '    schema:name "Session Store" ;',
    '    arch:engine "Redis 7".',
    '',
    '<urn:arch:postgres-users> a arch:Database ;',
    '    schema:name "Users DB" ;',
    '    arch:engine "PostgreSQL 16".',
  ].join('\n');

  // Build the Context Descriptor with full metadata
  const descriptor = ContextDescriptor.create('urn:cg:alice:arch-review-2026-Q1' as IRI)
.describes('urn:graph:alice:architecture-v3' as IRI)
.temporal({
      validFrom: '2026-01-15T10:00:00Z',
      validUntil: '2026-06-30T23:59:59Z',
      temporalResolution: 'P1D',
    })
.provenance({
      wasGeneratedBy: {
        agent: 'urn:agent:claude-code:alice-instance' as IRI,
        startedAt: '2026-01-15T10:00:00Z',
        endedAt: '2026-01-15T10:02:37Z',
      },
      wasAttributedTo: 'did:web:alice.example.org' as IRI,
      generatedAtTime: '2026-01-15T10:02:37Z',
    })
.agent('did:web:alice.example.org' as IRI, 'Author')
.semiotic({
      modalStatus: 'Asserted',
      epistemicConfidence: 0.92,
      groundTruth: true,
    })
.trust({
      trustLevel: 'SelfAsserted',
      issuer: 'did:web:alice.example.org' as IRI,
    })
.federation({
      origin: ALICE_POD as IRI,
      storageEndpoint: ALICE_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(1)
.build();

  // Validate
  const result = validate(descriptor);
  log('Alice', `Descriptor valid: ${result.conforms} (${descriptor.facets.length} facets)`);

  // Show the Turtle
  log('Alice', 'Serialized descriptor (Turtle):');
  console.log(toTurtle(descriptor));

  // Publish to Alice's pod — real HTTP PUT
  log('Alice', `Publishing to Solid pod at ${ALICE_POD}...`);
  const pubResult = await publish(descriptor, graphContent, ALICE_POD, {
    fetch: solidFetch,
  });

  log('Alice', `Descriptor written to: ${pubResult.descriptorUrl}`);
  log('Alice', `TriG graph written to: ${pubResult.graphUrl}`);
  log('Alice', `Manifest updated at: ${pubResult.manifestUrl}`);

  // Verify by reading back
  log('Alice', 'Verifying: fetching descriptor back from pod...');
  const verifyResp = await fetch(pubResult.descriptorUrl, {
    headers: { 'Accept': 'text/turtle' },
  });
  log('Alice', `GET ${pubResult.descriptorUrl} → ${verifyResp.status} ${verifyResp.statusText}`);
  const body = await verifyResp.text();
  log('Alice', `Got ${body.length} bytes of Turtle back`);

  return descriptor;
}

// ═════════════════════════════════════════════════════════════
//  AGENT B — Bob (Consumer)
// ═════════════════════════════════════════════════════════════

async function agentBob(aliceDescriptor: ContextDescriptorData): Promise<void> {
  log('Bob', 'Discovering context descriptors on Alice\'s pod...');

  // Discover all published descriptors — real HTTP GET
  const allEntries = await discover(ALICE_POD, undefined, { fetch: solidFetch });
  log('Bob', `Found ${allEntries.length} descriptor(s) in Alice's manifest`);

  for (const entry of allEntries) {
    log('Bob', `  → ${entry.descriptorUrl}`);
    log('Bob', `    Describes: ${entry.describes.join(', ')}`);
    log('Bob', `    Facets: ${entry.facetTypes.join(', ')}`);
    if (entry.validFrom) log('Bob', `    Valid: ${entry.validFrom} — ${entry.validUntil ?? '∞'}`);
  }

  // Filter by facet type — real HTTP GET + filtering
  log('Bob', 'Filtering for descriptors with Temporal facet...');
  const temporalEntries = await discover(ALICE_POD, { facetType: 'Temporal' }, { fetch: solidFetch });
  log('Bob', `Found ${temporalEntries.length} descriptor(s) with Temporal facet`);

  // Filter by temporal range
  log('Bob', 'Filtering for descriptors valid in March 2026...');
  const marchEntries = await discover(ALICE_POD, {
    validFrom: '2026-03-01T00:00:00Z',
    validUntil: '2026-03-31T23:59:59Z',
  }, { fetch: solidFetch });
  log('Bob', `Found ${marchEntries.length} descriptor(s) valid in March 2026`);

  // Fetch the actual TriG content — real HTTP GET
  if (allEntries.length > 0) {
    const entry = allEntries[0]!;
    log('Bob', `Fetching full descriptor from ${entry.descriptorUrl}...`);
    const descResp = await fetch(entry.descriptorUrl, {
      headers: { 'Accept': 'text/turtle' },
    });
    const descTurtle = await descResp.text();
    log('Bob', `Got ${descTurtle.length} bytes — this is Alice's context descriptor`);
  }

  // Bob builds his own local context
  log('Bob', 'Building Bob\'s local context descriptor...');
  const bobDescriptor = ContextDescriptor.create('urn:cg:bob:review-notes' as IRI)
.describes('urn:graph:alice:architecture-v3' as IRI)  // Same graph!
.temporal({
      validFrom: '2026-03-01T00:00:00Z',
      validUntil: '2026-03-31T23:59:59Z',
    })
.semiotic({
      modalStatus: 'Hypothetical',
      epistemicConfidence: 0.7,
      groundTruth: false,
    })
.trust({
      trustLevel: 'SelfAsserted',
      issuer: 'did:web:bob.example.org' as IRI,
    })
.agent('did:web:bob.example.org' as IRI, 'Curator')
.version(1)
.build();

  log('Bob', `Bob's descriptor valid: ${validate(bobDescriptor).conforms}`);

  // Compose: intersection of Alice + Bob's context
  log('Bob', 'Composing Alice ∩ Bob context (intersection)...');
  const composed = intersection(aliceDescriptor, bobDescriptor);

  log('Bob', `Composed descriptor has ${composed.facets.length} facet(s)`);
  log('Bob', `Composition operator: ${composed.compositionOp}`);
  log('Bob', `Operands: ${composed.operands.join(', ')}`);

  // Show the composed result
  log('Bob', 'Composed context (JSON-LD):');
  console.log(toJsonLdString(composed, { pretty: true }));

  // Check what facets survived intersection
  const facetTypes = composed.facets.map(f => f.type);
  log('Bob', `Surviving facet types: ${facetTypes.join(', ')}`);

  // Temporal intersection should show the overlap
  const temporalFacets = composed.facets.filter(f => f.type === 'Temporal');
  if (temporalFacets.length > 0) {
    const tf = temporalFacets[0]!;
    if (tf.type === 'Temporal') {
      log('Bob', `Temporal overlap: ${tf.validFrom} — ${tf.validUntil}`);
    }
  }

  // Semiotic intersection preserves both — shows disagreement
  const semioticFacets = composed.facets.filter(f => f.type === 'Semiotic');
  log('Bob', `Semiotic facets in composition: ${semioticFacets.length} (both agents' views preserved)`);
}

// ═════════════════════════════════════════════════════════════
//  AGENT B — Subscribe (WebSocket Notifications)
// ═════════════════════════════════════════════════════════════

async function agentBobSubscribe(): Promise<{ unsubscribe: () => void } | null> {
  log('Bob', 'Attempting to subscribe to Alice\'s pod for live notifications...');

  try {
    const events: ContextChangeEvent[] = [];

    const subscription = await subscribe(ALICE_POD, (event) => {
      events.push(event);
      log('Bob', `[LIVE] ${event.type} on ${event.resource} at ${event.timestamp}`);
    }, {
      fetch: solidFetch,
      WebSocket: WebSocket as unknown as WebSocketConstructor,
    });

    log('Bob', 'WebSocket subscription active — listening for changes');
    return subscription;
  } catch (err) {
    // WebSocket notifications may not be fully available depending on CSS config
    log('Bob', `Subscribe attempt: ${(err as Error).message}`);
    log('Bob', '(WebSocket subscription is optional — publish/discover work without it)');
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
//  SECOND PUBLISH — Alice updates, Bob should see it
// ═════════════════════════════════════════════════════════════

async function alicePublishUpdate(): Promise<void> {
  log('Alice', 'Publishing updated descriptor (version 2)...');

  const updatedDescriptor = ContextDescriptor.create('urn:cg:alice:arch-review-2026-Q1-v2' as IRI)
.describes('urn:graph:alice:architecture-v3' as IRI)
.temporal({
      validFrom: '2026-03-19T00:00:00Z',
      validUntil: '2026-09-30T23:59:59Z',
    })
.asserted(0.97)
.selfAsserted('did:web:alice.example.org' as IRI)
.federation({
      origin: ALICE_POD as IRI,
      storageEndpoint: ALICE_POD as IRI,
      syncProtocol: 'SolidNotifications',
    })
.version(2)
.supersedes('urn:cg:alice:arch-review-2026-Q1' as IRI)
.build();

  const graphContent = '<urn:arch:api-gateway> <https://schema.org/name> "API Gateway v2".';

  const pubResult = await publish(updatedDescriptor, graphContent, ALICE_POD, {
    fetch: solidFetch,
  });
  log('Alice', `Update published: ${pubResult.descriptorUrl}`);

  // Verify manifest now has two entries
  const entries = await discover(ALICE_POD, undefined, { fetch: solidFetch });
  log('Alice', `Manifest now has ${entries.length} descriptor(s)`);
}

// ═════════════════════════════════════════════════════════════
//  Main Orchestrator
// ═════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Interego 1.0 — Real Multi-Agent Federation Demo');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  let cssProc: ChildProcess | null = null;

  try {
    // 1. Start real Solid server
    cssProc = await startCSS();
    console.log('');

    // 2. Ensure pod containers exist
    log('System', 'Creating pod containers...');
    await ensurePodContainer(ALICE_POD);
    await ensurePodContainer(BOB_POD);
    log('System', 'Pods ready');
    console.log('');

    // 3. Bob subscribes FIRST (before Alice publishes)
    console.log('─── Phase 1: Bob subscribes to Alice\'s pod ────────────');
    const sub = await agentBobSubscribe();
    console.log('');

    // Small delay to let WebSocket settle
    await new Promise(r => setTimeout(r, 500));

    // 4. Alice publishes her knowledge graph
    console.log('─── Phase 2: Alice publishes context-annotated graph ───');
    const aliceDesc = await agentAlice();
    console.log('');

    // Let notification propagate
    await new Promise(r => setTimeout(r, 1000));

    // 5. Bob discovers and composes
    console.log('─── Phase 3: Bob discovers and composes context ────────');
    await agentBob(aliceDesc);
    console.log('');

    // 6. Alice publishes an update
    console.log('─── Phase 4: Alice publishes an update ─────────────────');
    await alicePublishUpdate();
    console.log('');

    // Let notification propagate
    await new Promise(r => setTimeout(r, 1000));

    // 7. Bob re-discovers to see the update
    console.log('─── Phase 5: Bob re-discovers updated manifest ─────────');
    const updatedEntries = await discover(ALICE_POD, undefined, { fetch: solidFetch });
    log('Bob', `After update: ${updatedEntries.length} descriptor(s) on Alice's pod`);
    for (const entry of updatedEntries) {
      log('Bob', `  → ${entry.descriptorUrl}`);
      log('Bob', `    Facets: ${entry.facetTypes.join(', ')}`);
    }
    console.log('');

    // Cleanup subscription
    if (sub) {
      sub.unsubscribe();
      log('Bob', 'WebSocket subscription closed');
    }

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Demo complete. All operations used real HTTP and WebSocket');
    console.log('  against a live Community Solid Server.');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');

  } finally {
    if (cssProc) {
      log('System', 'Shutting down CSS...');
      cssProc.kill('SIGTERM');
      // Give it a moment to clean up
      await new Promise(r => setTimeout(r, 500));
      log('System', 'Done');
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
