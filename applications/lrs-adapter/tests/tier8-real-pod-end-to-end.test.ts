/**
 * Tier 8 — production end-to-end for the lrs-adapter vertical.
 *
 * Real flow against:
 *   - Real Lrsql (xAPI 2.0.0) running locally in Docker
 *   - Real Azure CSS pod for descriptor persistence
 *   - Optionally real SCORM Cloud (xAPI 1.0.3) when env creds set
 *
 * What this verifies end-to-end:
 *   1. POST a Statement to a real LRS to seed it
 *   2. ingestStatementFromLrs() — fetch back, project as cg:ContextDescriptor
 *      in the user's pod, audit row created
 *   3. projectDescriptorToLrs() with Asserted descriptor — POSTed to LRS,
 *      version-negotiated, audit row written
 *   4. projectDescriptorToLrs() with Hypothetical descriptor (no opt-in)
 *      — SKIPPED with explicit skipReason; audit row written
 *   5. projectDescriptorToLrs() with Counterfactual — ALWAYS SKIPPED
 *   6. projectDescriptorToLrs() multi-narrative — lossy with audit-loud
 *      lossNote rows; result.extensions preserves all narratives
 *   7. Cross-LRS version negotiation: same code path works against both
 *      Lrsql (2.0.0) and SCORM Cloud (1.0.3) when both available
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  ingestStatementFromLrs,
  projectDescriptorToLrs,
} from '../src/pod-publisher.js';
import { LrsClient } from '../src/lrs-client.js';
import type { IRI } from '../../../src/index.js';

// ── Config ────────────────────────────────────────────────────────────

const LRSQL_ENDPOINT = 'http://localhost:8080/xapi';
const LRSQL_AUTH = { username: 'testapikey', password: 'testapisecret' };

const SCORM_CLOUD_ENDPOINT = process.env['SCORM_CLOUD_ENDPOINT'];
const SCORM_CLOUD_KEY = process.env['SCORM_CLOUD_KEY'];
const SCORM_CLOUD_SECRET = process.env['SCORM_CLOUD_SECRET'];

const AZURE_CSS_BASE = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const TEST_POD_BASE = `${AZURE_CSS_BASE}/u-pk-6e3bc2f9723c/`;

const USER_DID = 'did:web:lrs-tier8.example' as IRI;

function uniquePodUrl(): string {
  return `${TEST_POD_BASE}lrs-tier8-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;
}

// ── Reachability + cleanup ───────────────────────────────────────────

async function lrsqlReachable(): Promise<boolean> {
  if (process.env.SKIP_LRSQL_TESTS === '1') return false;
  try {
    const r = await fetch(`${LRSQL_ENDPOINT}/about`, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${LRSQL_AUTH.username}:${LRSQL_AUTH.password}`).toString('base64'),
        'X-Experience-API-Version': '2.0.0',
      },
    });
    return r.ok;
  } catch { return false; }
}

async function podReachable(): Promise<boolean> {
  if (process.env.SKIP_AZURE_TESTS === '1') return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(TEST_POD_BASE, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

const cleanupUrls: string[] = [];
function track(...urls: (string | undefined)[]): void {
  for (const u of urls) if (u) cleanupUrls.push(u);
}
async function cleanup(): Promise<void> {
  const containerRoots = new Set<string>();
  for (const url of cleanupUrls) {
    const m = /^(.*\/lrs-tier8-[^/]+\/)/.exec(url);
    if (m) containerRoots.add(m[1]!);
  }
  for (const url of cleanupUrls.splice(0)) {
    try { await fetch(url, { method: 'DELETE' }); } catch {}
  }
  for (const root of containerRoots) {
    try { await fetch(`${root}.well-known/context-graphs`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}context-graphs/`, { method: 'DELETE' }); } catch {}
    try { await fetch(`${root}.well-known/`, { method: 'DELETE' }); } catch {}
    try { await fetch(root, { method: 'DELETE' }); } catch {}
  }
}

let canRun = false;
beforeAll(async () => {
  canRun = (await lrsqlReachable()) && (await podReachable());
});

// ── Helper: seed an xAPI Statement directly into Lrsql ──────────────

async function seedStatement(stmt: Record<string, unknown>): Promise<string> {
  const r = await fetch(`${LRSQL_ENDPOINT}/statements`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${LRSQL_AUTH.username}:${LRSQL_AUTH.password}`).toString('base64'),
      'X-Experience-API-Version': '2.0.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(stmt),
  });
  if (!r.ok) throw new Error(`failed to seed statement: ${r.status}`);
  const ids = await r.json() as string[];
  return ids[0]!;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Tier 8 — lrs-adapter production end-to-end', () => {
  it('reachability probe (skips when LRS or pod down)', () => {
    if (!canRun) console.warn('Tier 8 LRS skipped: Lrsql or Azure pod unreachable');
    expect(typeof canRun).toBe('boolean');
  });

  it('ingest single Statement: real LRS → real pod → audit', { timeout: 60000 }, async (ctx) => {
    if (!canRun) return ctx.skip();
    try {
      const podUrl = uniquePodUrl();

      // Seed a Statement in the LRS first
      const stmtId = randomUUID();
      const seeded = await seedStatement({
        id: stmtId,
        actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-lrs-user' } },
        verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
        object: { objectType: 'Activity', id: `https://courses.example/lrs-tier8-${stmtId}` },
        result: { completion: true, score: { scaled: 0.92 } },
        timestamp: new Date().toISOString(),
      });
      expect(seeded).toBe(stmtId);

      // Ingest from LRS into pod
      const result = await ingestStatementFromLrs(
        { endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' },
        stmtId,
        { podUrl, userDid: USER_DID },
      );
      track(result.descriptorUrl, result.auditUrl);

      expect(result.statementDescriptorIri).toContain(stmtId);
      expect(result.descriptorUrl).toContain(podUrl);
      expect(result.auditUrl).toContain(podUrl);
      expect(result.xapiVersion).toBe('2.0.0');

      // Verify the descriptor file is reachable in the pod
      const fetched = await fetch(result.descriptorUrl, { headers: { Accept: 'application/trig, text/turtle;q=0.5' } });
      expect(fetched.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('project Asserted descriptor → real LRS, version-negotiated, audit written', { timeout: 60000 }, async (ctx) => {
    if (!canRun) return ctx.skip();
    try {
      const podUrl = uniquePodUrl();
      const result = await projectDescriptorToLrs(
        { endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' },
        {
          descriptorIri: 'urn:cg:lrs-tier8-test:asserted' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-projector' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:cg:lrs-tier8-asserted-test',
          modalStatus: 'Asserted',
        },
        { podUrl, userDid: USER_DID },
      );
      track(result.auditUrl);

      expect(result.skipped).toBe(false);
      expect(result.statementId).toBeTruthy();
      expect(result.lossy).toBe(false);
      expect(result.lossNotes).toHaveLength(0);
      expect(result.xapiVersion).toBe('2.0.0');

      // Verify the Statement actually landed in the LRS
      const lrs = new LrsClient({ endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' });
      const stored = await lrs.getStatement(result.statementId!);
      expect(stored).not.toBeNull();
      expect((stored as Record<string, { id?: string }>).verb.id).toBe('http://adlnet.gov/expapi/verbs/observed');
    } finally {
      await cleanup();
    }
  });

  it('project Hypothetical descriptor (no opt-in): SKIPPED with audit row', { timeout: 60000 }, async (ctx) => {
    if (!canRun) return ctx.skip();
    try {
      const podUrl = uniquePodUrl();
      const result = await projectDescriptorToLrs(
        { endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' },
        {
          descriptorIri: 'urn:cg:fragment:lrs-tier8:hypothetical' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-observer' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:cg:lrs-tier8-hypothetical-test',
          modalStatus: 'Hypothetical',
        },
        { podUrl, userDid: USER_DID },
      );
      track(result.auditUrl);

      expect(result.skipped).toBe(true);
      expect(result.statementId).toBeUndefined();
      expect(result.lossy).toBe(true);
      expect(result.skipReason).toContain('Hypothetical');
      expect(result.skipReason).toContain('committed claims');
      expect(result.auditUrl).toBeTruthy();
    } finally {
      await cleanup();
    }
  });

  it('project Counterfactual: ALWAYS skipped, even with allowHypothetical=true', { timeout: 60000 }, async (ctx) => {
    if (!canRun) return ctx.skip();
    try {
      const podUrl = uniquePodUrl();
      const result = await projectDescriptorToLrs(
        { endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' },
        {
          descriptorIri: 'urn:cg:counterfactual:lrs-tier8' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-cf' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:cg:lrs-tier8-counterfactual',
          modalStatus: 'Counterfactual',
          allowHypothetical: true,  // even with opt-in
        },
        { podUrl, userDid: USER_DID },
      );
      track(result.auditUrl);

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain('Counterfactual');
    } finally {
      await cleanup();
    }
  });

  it('project multi-narrative: lossy=true, all narratives in result.extensions', { timeout: 60000 }, async (ctx) => {
    if (!canRun) return ctx.skip();
    try {
      const podUrl = uniquePodUrl();
      const narratives = [
        'Reading 1: explicit-acknowledgment scaffold creates space',
        'Reading 2: it is the SIGNAL not the words',
        'Reading 3: noise; sample too small',
      ];
      const result = await projectDescriptorToLrs(
        { endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' },
        {
          descriptorIri: 'urn:cg:synthesis:lrs-tier8-multi-narrative' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-synth' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:cg:lrs-tier8-multi-narrative',
          modalStatus: 'Asserted',  // org committed to projecting it as Asserted
          coherentNarratives: narratives,
        },
        { podUrl, userDid: USER_DID },
      );
      track(result.auditUrl);

      expect(result.skipped).toBe(false);
      expect(result.lossy).toBe(true);
      expect(result.lossNotes.some(n => n.includes('coherent narratives'))).toBe(true);

      // Verify the Statement landed with extensions
      const lrs = new LrsClient({ endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' });
      const stored = await lrs.getStatement(result.statementId!);
      expect(stored).not.toBeNull();
      const extensions = (stored as Record<string, { extensions: Record<string, unknown> }>).result.extensions;
      expect(extensions['urn:cg:coherent-narratives']).toEqual(narratives);
      expect(extensions['urn:cg:projection-lossy']).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('LRS version negotiation: 2.0.0 against Lrsql', { timeout: 30000 }, async (ctx) => {
    if (!canRun) return ctx.skip();
    const lrs = new LrsClient({ endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' });
    const v = await lrs.negotiateVersion();
    expect(v).toBe('2.0.0');
  });

  // SCORM Cloud-specific: cross-LRS version negotiation against the
  // proprietary LRS that ONLY supports 1.0.3. Gated on env creds.
  const scormCloudAvailable = SCORM_CLOUD_ENDPOINT && SCORM_CLOUD_KEY && SCORM_CLOUD_SECRET;
  (scormCloudAvailable ? it : it.skip)('LRS version negotiation: falls back to 1.0.3 against SCORM Cloud (proprietary)', { timeout: 30000 }, async (ctx) => {
    if (!canRun || !scormCloudAvailable) return ctx.skip();
    const lrs = new LrsClient({
      endpoint: SCORM_CLOUD_ENDPOINT!,
      auth: { username: SCORM_CLOUD_KEY!, password: SCORM_CLOUD_SECRET! },
      preferredVersion: '2.0.0',  // try 2.0.0; SCORM Cloud should fall back to 1.0.3
    });
    const v = await lrs.negotiateVersion();
    expect(v).toBe('1.0.3');  // SCORM Cloud only supports 1.0.3
  });

  (scormCloudAvailable ? it : it.skip)('cross-LRS: same Asserted descriptor projects against BOTH Lrsql (2.0.0) and SCORM Cloud (1.0.3)', { timeout: 90000 }, async (ctx) => {
    if (!canRun || !scormCloudAvailable) return ctx.skip();
    try {
      const podUrl = uniquePodUrl();
      const projection = {
        descriptorIri: `urn:cg:lrs-tier8-cross-lrs:${randomUUID()}` as IRI,
        actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `tier8-cross-${Date.now()}` } },
        verbId: 'http://adlnet.gov/expapi/verbs/observed',
        objectId: `urn:cg:cross-lrs-test-${Date.now()}`,
        modalStatus: 'Asserted' as const,
      };

      const lrsqlResult = await projectDescriptorToLrs(
        { endpoint: LRSQL_ENDPOINT, auth: LRSQL_AUTH, preferredVersion: '2.0.0' },
        projection,
        { podUrl, userDid: USER_DID },
      );
      track(lrsqlResult.auditUrl);

      const scResult = await projectDescriptorToLrs(
        { endpoint: SCORM_CLOUD_ENDPOINT!, auth: { username: SCORM_CLOUD_KEY!, password: SCORM_CLOUD_SECRET! }, preferredVersion: '2.0.0' },
        projection,
        { podUrl, userDid: USER_DID },
      );
      track(scResult.auditUrl);

      expect(lrsqlResult.skipped).toBe(false);
      expect(scResult.skipped).toBe(false);
      expect(lrsqlResult.xapiVersion).toBe('2.0.0');
      expect(scResult.xapiVersion).toBe('1.0.3');
      // Same shape, two different LRSes, both work
    } finally {
      await cleanup();
    }
  });
});
