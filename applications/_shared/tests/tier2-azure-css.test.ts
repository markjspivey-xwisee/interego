/**
 * Tier 2 — REAL HTTP roundtrip against the deployed Azure CSS.
 *
 * Where Tier 1 (per-vertical integration.test.ts) verifies builder + Turtle
 * + validate in-process, Tier 2 actually:
 *   1. Builds a real ContextDescriptor for each vertical
 *   2. Calls the production publish() function (HTTP PUT against the pod)
 *   3. Fetches the descriptor back via HTTP GET
 *   4. Parses the returned Turtle with parseManifest
 *   5. Asserts the round-trip preserves descriptor IRI + facets
 *   6. Cleans up by DELETEing the test descriptor
 *
 * Pod: https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io
 * Test container: u-pk-6e3bc2f9723c (publicly writable for demos)
 *
 * Skips automatically if:
 *   - The CSS is unreachable (network failure)
 *   - The env var SKIP_AZURE_TESTS=1 is set (CI without internet)
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  ContextDescriptor,
  publish,
  parseManifest,
  toTurtle,
} from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';

// ── Config ────────────────────────────────────────────────────────────

const AZURE_CSS_BASE = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TEST_POD = `${AZURE_CSS_BASE}/u-pk-6e3bc2f9723c/`;
const REACHABILITY_TIMEOUT_MS = 8000;

// ── Reachability probe (skips test suite if pod is down) ─────────────

async function isPodReachable(): Promise<boolean> {
  if (process.env.SKIP_AZURE_TESTS === '1') return false;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REACHABILITY_TIMEOUT_MS);
    const r = await fetch(TEST_POD, { method: 'GET', signal: ac.signal });
    clearTimeout(timer);
    return r.ok;
  } catch (e) {
    console.warn('Azure CSS unreachable:', (e as Error).message);
    return false;
  }
}

// ── Cleanup tracking ─────────────────────────────────────────────────

const cleanupUrls: string[] = [];

async function cleanup() {
  for (const url of cleanupUrls.splice(0)) {
    try { await fetch(url, { method: 'DELETE' }); } catch { /* best-effort */ }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function uniquePath(prefix: string): string {
  return `${TEST_POD}${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ttl`;
}

async function fetchTurtle(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { Accept: 'text/turtle' } });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Tier 2 — real HTTP roundtrip
// ═════════════════════════════════════════════════════════════════════

let podReachable = false;

beforeAll(async () => {
  podReachable = await isPodReachable();
});

afterEach(async () => {
  await cleanup();
});

describe('Tier 2 — Azure CSS real HTTP roundtrip', () => {
  it('pod is reachable (otherwise skip the rest)', () => {
    if (!podReachable) {
      console.warn(`Azure CSS at ${AZURE_CSS_BASE} is unreachable; remaining Tier 2 tests skipped`);
    }
    expect(typeof podReachable).toBe('boolean');
  });

  it('publish + fetch back + parse: agent-development-practice probe descriptor', { timeout: 30000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    const probe = ContextDescriptor.create('urn:cg:probe:tier2-test:1' as IRI)
      .describes('urn:graph:adp:probe' as IRI)
      .temporal({ validFrom: '2026-04-22T10:00:00Z' })
      .hypothetical(0.5)
      .selfAsserted('did:web:tier2-test.example' as IRI)
      .build();

    const url = uniquePath('adp-probe');
    const turtle = toTurtle(probe);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: turtle,
    });
    cleanupUrls.push(url);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(201);

    const fetched = await fetchTurtle(url);
    expect(fetched).not.toBeNull();
    expect(fetched).toContain(probe.id);
    expect(fetched).toContain('Hypothetical');
  });

  it('publish + fetch back: learner-performer-companion credential', { timeout: 30000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    const cred = ContextDescriptor.create('urn:cg:credential:tier2-ob3' as IRI)
      .describes('urn:graph:lpc:credential' as IRI)
      .temporal({ validFrom: '2025-09-15T11:00:00Z' })
      .asserted(0.95)
      .trust({ issuer: 'did:web:acme-training.example' as IRI, trustLevel: 'ThirdPartyAttested' })
      .build();

    const url = uniquePath('lpc-credential');
    const turtle = toTurtle(cred);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: turtle,
    });
    cleanupUrls.push(url);
    expect(r.ok).toBe(true);

    const fetched = await fetchTurtle(url);
    expect(fetched).toContain(cred.id);
    expect(fetched).toContain('ThirdPartyAttested');
    expect(fetched).toContain('did:web:acme-training.example');
  });

  it('production publish() function: full publish path against real CSS', { timeout: 30000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    // This exercises the actual src/solid/publish() — same code that
    // production code calls. It writes the descriptor + (separately) the
    // graph content + a manifest entry.
    const descId = `urn:cg:tier2-publish-test:${Date.now()}` as IRI;
    const desc = ContextDescriptor.create(descId)
      .describes('urn:graph:tier2-test' as IRI)
      .temporal({ validFrom: '2026-04-27T10:00:00Z' })
      .asserted(0.9)
      .selfAsserted('did:web:tier2-test.example' as IRI)
      .build();

    const graphContent = '<urn:graph:tier2-test:s1> <urn:p> "test value" .';

    const result = await publish(desc, graphContent, TEST_POD);

    // Track cleanup — publish() writes multiple files
    if (result?.descriptorUrl) cleanupUrls.push(result.descriptorUrl);
    if (result?.graphUrl)      cleanupUrls.push(result.graphUrl);
    if (result?.manifestUrl)   cleanupUrls.push(result.manifestUrl);

    expect(result.descriptorUrl).toBeTruthy();
    expect(result.descriptorUrl).toContain(TEST_POD);

    // Verify descriptor came back with the expected IRI
    const fetchedDescriptor = await fetchTurtle(result.descriptorUrl);
    expect(fetchedDescriptor).not.toBeNull();
    expect(fetchedDescriptor).toContain(descId);
  });

  it('manifest fetch + parse: round-trips through parseManifest()', { timeout: 30000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    // First publish a descriptor so the manifest has at least one entry
    const descId = `urn:cg:tier2-manifest-test:${Date.now()}` as IRI;
    const desc = ContextDescriptor.create(descId)
      .describes('urn:graph:tier2-manifest' as IRI)
      .temporal({ validFrom: '2026-04-27T11:00:00Z' })
      .asserted(0.8)
      .selfAsserted('did:web:tier2-test.example' as IRI)
      .build();

    const graphContent = '<urn:graph:tier2-manifest:s1> <urn:p> "v" .';
    const result = await publish(desc, graphContent, TEST_POD);

    if (result?.descriptorUrl) cleanupUrls.push(result.descriptorUrl);
    if (result?.graphUrl)      cleanupUrls.push(result.graphUrl);
    if (result?.manifestUrl)   cleanupUrls.push(result.manifestUrl);

    // Now read the manifest at the well-known location
    const manifestUrl = `${TEST_POD}.well-known/context-graphs`;
    const manifestTtl = await fetchTurtle(manifestUrl);
    expect(manifestTtl).not.toBeNull();

    const entries = parseManifest(manifestTtl!);
    expect(entries.length).toBeGreaterThan(0);

    // The just-published descriptor should be discoverable in the manifest
    const ours = entries.find(e => e.descriptorUrl === result.descriptorUrl);
    expect(ours).toBeDefined();
  });

  it('cross-vertical: publish lrs-adapter ingested descriptor + verify roundtrip', { timeout: 30000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    const desc = ContextDescriptor.create('urn:cg:lrs-statement:tier2-stmt' as IRI)
      .describes('urn:graph:lrs:statement' as IRI)
      .temporal({ validFrom: '2026-04-15T14:32:00Z' })
      .asserted(0.95)
      .trust({
        issuer: 'https://acme.lrs.example' as IRI,
        trustLevel: 'ThirdPartyAttested',
      })
      .build();

    const url = uniquePath('lrs-statement');
    const turtle = toTurtle(desc);
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: turtle,
    });
    cleanupUrls.push(url);
    expect(r.ok).toBe(true);

    const fetched = await fetchTurtle(url);
    expect(fetched).toContain(desc.id);
    expect(fetched).toContain('Asserted');
    expect(fetched).toContain('acme.lrs.example');
  });
});
