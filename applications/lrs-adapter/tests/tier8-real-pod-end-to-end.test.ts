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
 *   2. ingestStatementFromLrs() — fetch back, project as iep:ContextDescriptor
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
import type {
  IRI,
} from '@interego/core';

// ── Config ────────────────────────────────────────────────────────────

const LRSQL_ENDPOINT = 'http://localhost:8080/xapi';
const LRSQL_AUTH = { username: 'testapikey', password: 'testapisecret' };

const SCORM_CLOUD_ENDPOINT = process.env['SCORM_CLOUD_ENDPOINT'];
const SCORM_CLOUD_KEY = process.env['SCORM_CLOUD_KEY'];
const SCORM_CLOUD_SECRET = process.env['SCORM_CLOUD_SECRET'];

// CSS is no longer publicly reachable; route through the public css-gate FQDN.
// ★ The default host was the Azure CSS gate, deliberately destroyed in the Railway move.
// See applications/_shared/tests/pod-target.ts.
// ★ Gated through real-pod-gate.ts rather than probePod() directly: probePod() folded a
// DECLARED opt-out and a DISCOVERED failure (unreachable, 404 container, refused write) into
// one `usable: false` and both reached ctx.skip(), which is green. openRealPod() throws on the
// discovered kind, so a pod that has stopped existing reds this file instead of emptying it.
import { envFlag } from '../../_shared/tests/env-flag.js';
import {
  TEST_POD_BASE, POD_HOST as AZURE_CSS_BASE, podWriteHeaders,
  openRealPod, DECLARED_SKIPS, type PodGate,
} from '../../_shared/tests/real-pod-gate.js';

const USER_DID = 'did:web:lrs-tier8.example' as IRI;

function uniquePodUrl(): string {
  return `${TEST_POD_BASE}lrs-tier8-${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;
}

// ── Reachability + cleanup ───────────────────────────────────────────

async function lrsqlReachable(): Promise<boolean> {
  // Through `envFlag` for the same reason as everywhere else: the warning this file prints
  // advertises SKIP_LRSQL_TESTS by name and states no value, so `=true` has to mean what it
  // plainly means. See env-flag.ts.
  if (envFlag('SKIP_LRSQL_TESTS', process.env.SKIP_LRSQL_TESTS)) return false;
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
  // DELETE is a write, and the css-gate answers an unauthenticated write with
  // `401 anonymous writes denied`. Without the bearer every one of these silently 401s inside
  // the `catch {}` and the run leaves its fixtures on a real pod.
  for (const url of cleanupUrls.splice(0)) {
    try { await fetch(url, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
  }
  for (const root of containerRoots) {
    try { await fetch(`${root}.well-known/context-graphs`, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
    try { await fetch(`${root}context-graphs/`, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
    try { await fetch(`${root}.well-known/`, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
    try { await fetch(root, { method: 'DELETE', headers: podWriteHeaders() }); } catch {}
  }
}

// ★ TWO SERVICES, TWO SEPARATE DECISIONS. These used to be `&&`-ed into one `canRun`, so
// "no Lrsql on this laptop" and "the pod stopped existing" were the same value — and the one
// test guarding it asserted `typeof canRun === 'boolean'`, true of `false`. Lrsql is a
// genuine localhost dependency whose absence is a legitimate skip; the pod is not, once a
// write credential says somebody meant these round-trips to run. Keeping them apart is what
// lets the pod half fail loudly while the LRS half still skips honestly.
let pod: PodGate = { ok: false, declaredSkip: 'SKIP_POD_TESTS/SKIP_AZURE_TESTS declared' };
let lrsUp = false;
let canRun = false;
beforeAll(async () => {
  lrsUp = await lrsqlReachable();
  // Throws when a credential is configured and the pod is not usable.
  pod = await openRealPod();
  canRun = lrsUp && pod.ok;
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
  it('real-pod precondition: skipping is allowed only for a DECLARED reason', () => {
    // Was `expect(typeof canRun).toBe('boolean')` — true of `false`, so the only test in this
    // file that ever "passed" passed for every possible state of both dependencies.
    // ★★ THE POD HALF FIRST, AND WITH NO `return` ABOVE IT. This used to bail out on `!lrsUp`
    // before reaching the pod assertion — and `!lrsUp` is the NORMAL state, since nothing in CI
    // and no laptop without Docker has an Lrsql on 8080. So the one assertion in this file that
    // constrains WHY the pod may be skipped had never been evaluated on any run anybody has
    // seen. Visible in the output rather than deduced: on 471b7497 the other four pod suites
    // each printed "INTEREGO_POD_WRITE_SECRET unset" and this file printed only its LRS line.
    //
    // The two dependencies are deliberately kept as separate values (see the note above
    // `let pod`), so an early return for one of them disarming the check on the other is
    // exactly the coupling that separation exists to prevent. Neither branch returns now.
    if (!pod.ok) {
      console.warn(`Tier 8 LRS skipped — ${pod.declaredSkip} (pod host: ${AZURE_CSS_BASE})`);
      expect(DECLARED_SKIPS).toContain(pod.declaredSkip);
    }
    if (!lrsUp) {
      console.warn(`Tier 8 LRS skipped: no Lrsql at ${LRSQL_ENDPOINT} `
        + '(a localhost dependency — set SKIP_LRSQL_TESTS to 1/true/yes/on to say so explicitly)');
    }
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
          descriptorIri: 'urn:iep:lrs-tier8-test:asserted' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-projector' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:iep:lrs-tier8-asserted-test',
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
      // Cast to the shape being read, not to `Record<string, …>` — an index signature makes
      // every lookup optional, so `.verb` was `{ id?: string } | undefined` and the property
      // access after it was unchecked.
      expect((stored as { verb: { id?: string } }).verb.id).toBe('http://adlnet.gov/expapi/verbs/observed');
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
          descriptorIri: 'urn:iep:fragment:lrs-tier8:hypothetical' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-observer' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:iep:lrs-tier8-hypothetical-test',
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
          descriptorIri: 'urn:iep:counterfactual:lrs-tier8' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-cf' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:iep:lrs-tier8-counterfactual',
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
          descriptorIri: 'urn:iep:synthesis:lrs-tier8-multi-narrative' as IRI,
          actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'tier8-synth' } },
          verbId: 'http://adlnet.gov/expapi/verbs/observed',
          objectId: 'urn:iep:lrs-tier8-multi-narrative',
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
      const extensions = (stored as { result: { extensions: Record<string, unknown> } }).result.extensions;
      expect(extensions['https://markjspivey-xwisee.github.io/interego/ns/iep#coherentNarratives']).toEqual(narratives);
      expect(extensions['https://markjspivey-xwisee.github.io/interego/ns/iep#projectionLossy']).toBe(true);
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
        descriptorIri: `urn:iep:lrs-tier8-cross-lrs:${randomUUID()}` as IRI,
        actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `tier8-cross-${Date.now()}` } },
        verbId: 'http://adlnet.gov/expapi/verbs/observed',
        objectId: `urn:iep:cross-lrs-test-${Date.now()}`,
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
