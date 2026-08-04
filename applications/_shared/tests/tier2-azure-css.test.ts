/**
 * Tier 2 — REAL HTTP roundtrip against the deployed pod (Railway css-gate).
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
 * Pod: the live css-gate (https://gate.interego.xwisee.com by default) — see
 * applications/_shared/tests/pod-target.ts. The Azure host this file used to name was
 * deliberately destroyed in the move to Railway, and probing it timed out and skipped 5 of
 * these 6 tests while the file reported ✓.
 *
 * Skips automatically, ALWAYS STATING WHICH, if:
 *   - INTEREGO_POD_WRITE_SECRET is unset (the gate requires a bearer on every write;
 *     the allow-all CSS these were written against no longer exists)
 *   - The pod is unreachable or absent
 *   - SKIP_POD_TESTS=1 / SKIP_AZURE_TESTS=1 is set (CI without internet)
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import {
  ContextDescriptor,
  toTurtle,
} from '@interego/core';
import {
  parseManifest,
  publish,
} from '@interego/solid';
import type {
  IRI,
} from '@interego/core';

// ── Config ────────────────────────────────────────────────────────────

// ★ The default host used to be the Azure CSS gate, which was deliberately destroyed in the
// move to Railway. Probing it timed out after 8s and skipped 5 of 6 tests while reporting ✓.
// See applications/_shared/tests/pod-target.ts for the full account and the honest skip
// reasons that replaced it.
import { TEST_POD_BASE as TEST_POD, POD_HOST, podWriteHeaders, podFetch, probePod } from './pod-target.js';

// ── Cleanup tracking ─────────────────────────────────────────────────

const cleanupUrls: string[] = [];

async function cleanup() {
  for (const url of cleanupUrls.splice(0)) {
    // DELETE is a write, so it needs the same bearer the gate requires on PUT — without it
    // cleanup silently 401s and leaves every fixture behind.
    try { await fetch(url, { method: 'DELETE', headers: podWriteHeaders() }); } catch { /* best-effort */ }
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
let skipReason = '';

beforeAll(async () => {
  const availability = await probePod();
  podReachable = availability.usable;
  skipReason = availability.reason;
});

afterEach(async () => {
  await cleanup();
});

describe('Tier 2 — real HTTP roundtrip against the live pod', () => {
  it('pod is reachable (otherwise skip the rest)', () => {
    // ★ A skip must STATE ITS CAUSE. This used to print "unreachable" naming a host that had
    // been deliberately deleted — a message that sent anyone reading it to a dead end.
    if (!podReachable) {
      console.warn(`Tier 2 pod tests skipped — ${skipReason} (host: ${POD_HOST})`);
    }
    expect(skipReason).not.toBe('');
  });

  it('publish + fetch back + parse: agent-development-practice probe descriptor', { timeout: 30000 }, async (ctx) => {
    if (!podReachable) return ctx.skip();
    const probe = ContextDescriptor.create('urn:iep:probe:tier2-test:1' as IRI)
      .describes('urn:graph:adp:probe' as IRI)
      .temporal({ validFrom: '2026-04-22T10:00:00Z' })
      .hypothetical(0.5)
      .selfAsserted('did:web:tier2-test.example' as IRI)
      .build();

    const url = uniquePath('adp-probe');
    const turtle = toTurtle(probe);
    const r = await fetch(url, {
      method: 'PUT',
      headers: podWriteHeaders({ 'Content-Type': 'text/turtle' }),
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
    const cred = ContextDescriptor.create('urn:iep:credential:tier2-ob3' as IRI)
      .describes('urn:graph:lpc:credential' as IRI)
      .temporal({ validFrom: '2025-09-15T11:00:00Z' })
      .asserted(0.95)
      .trust({ issuer: 'did:web:acme-training.example' as IRI, trustLevel: 'ThirdPartyAttested' })
      .build();

    const url = uniquePath('lpc-credential');
    const turtle = toTurtle(cred);
    const r = await fetch(url, {
      method: 'PUT',
      headers: podWriteHeaders({ 'Content-Type': 'text/turtle' }),
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
    const descId = `urn:iep:tier2-publish-test:${Date.now()}` as IRI;
    const desc = ContextDescriptor.create(descId)
      .describes('urn:graph:tier2-test' as IRI)
      .temporal({ validFrom: '2026-04-27T10:00:00Z' })
      .asserted(0.9)
      .selfAsserted('did:web:tier2-test.example' as IRI)
      .build();

    const graphContent = '<urn:graph:tier2-test:s1> <urn:p> "test value" .';

    const result = await publish(desc, graphContent, TEST_POD, { fetch: podFetch });

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
    const descId = `urn:iep:tier2-manifest-test:${Date.now()}` as IRI;
    const desc = ContextDescriptor.create(descId)
      .describes('urn:graph:tier2-manifest' as IRI)
      .temporal({ validFrom: '2026-04-27T11:00:00Z' })
      .asserted(0.8)
      .selfAsserted('did:web:tier2-test.example' as IRI)
      .build();

    const graphContent = '<urn:graph:tier2-manifest:s1> <urn:p> "v" .';
    const result = await publish(desc, graphContent, TEST_POD, { fetch: podFetch });

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
    const desc = ContextDescriptor.create('urn:iep:lrs-statement:tier2-stmt' as IRI)
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
      headers: podWriteHeaders({ 'Content-Type': 'text/turtle' }),
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
