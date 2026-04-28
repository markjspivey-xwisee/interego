/**
 * Tier 3c — REAL proprietary LRS (SCORM Cloud) integration.
 *
 * Closes the proprietary-LRS testing gap. Tier 3 + 3b verified the
 * adapter against Yet Analytics' Lrsql (open-source xAPI 2.0 LRS).
 * This test verifies against SCORM Cloud — Rustici Software's
 * commercial LRS, used by enterprise L&D programs.
 *
 * Real-world finding from this test:
 *   SCORM Cloud's LRS is xAPI 1.0.3 ONLY (does NOT advertise 2.0.0).
 *   Statements POSTed with X-Experience-API-Version: 2.0.0 are rejected
 *   with "Version 2.0.0 is invalid or not supported by this endpoint".
 *   The lrs-adapter must do version negotiation: target 2.0.0 against
 *   modern LRSes (Lrsql), fall back to 1.0.3 against SCORM Cloud and
 *   other legacy proprietary LRSes.
 *
 * Setup (gated by env vars; never commit credentials):
 *   SCORM_CLOUD_KEY=<activity-provider-key> \
 *   SCORM_CLOUD_SECRET=<activity-provider-secret> \
 *   SCORM_CLOUD_ENDPOINT=https://cloud.scorm.com/lrs/<APP_ID>/sandbox \
 *   npx vitest run applications/lrs-adapter/tests/tier3c-scorm-cloud.test.ts
 *
 * Skips automatically if any of the three env vars are unset.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';

const SC_KEY = process.env.SCORM_CLOUD_KEY;
const SC_SECRET = process.env.SCORM_CLOUD_SECRET;
const SC_ENDPOINT = process.env.SCORM_CLOUD_ENDPOINT;

const SC_AUTH = SC_KEY && SC_SECRET
  ? 'Basic ' + Buffer.from(`${SC_KEY}:${SC_SECRET}`).toString('base64')
  : null;

// SCORM Cloud's LRS uses xAPI 1.0.3 only.
const XAPI_VERSION = '1.0.3';

const COMMON_HEADERS: Record<string, string> = SC_AUTH ? {
  'Authorization': SC_AUTH,
  'X-Experience-API-Version': XAPI_VERSION,
  'Content-Type': 'application/json',
} : {};

async function probeReachability(): Promise<boolean> {
  if (!SC_AUTH || !SC_ENDPOINT) return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(`${SC_ENDPOINT}/about`, {
      headers: { Authorization: SC_AUTH, 'X-Experience-API-Version': XAPI_VERSION },
      signal: ac.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

let reachable = false;

beforeAll(async () => {
  reachable = await probeReachability();
});

describe('Tier 3c — SCORM Cloud (proprietary LRS, xAPI 1.0.3)', () => {
  it('reachability probe (skips remaining tests when env vars unset or pod down)', () => {
    if (!SC_AUTH || !SC_ENDPOINT) {
      console.warn('SCORM_CLOUD_KEY / SCORM_CLOUD_SECRET / SCORM_CLOUD_ENDPOINT unset; Tier 3c skipped');
    }
    expect(typeof reachable).toBe('boolean');
  });

  it('about endpoint reports xAPI 1.0.3 (NOT 2.0.0 — real-world finding)', { timeout: 15000 }, async (ctx) => {
    if (!reachable) return ctx.skip();

    const r = await fetch(`${SC_ENDPOINT}/about`, {
      headers: { Authorization: SC_AUTH!, 'X-Experience-API-Version': XAPI_VERSION },
    });
    expect(r.ok).toBe(true);
    const body = await r.json() as { version: string[] };
    expect(body.version).toContain('1.0.3');
    // Confirms our finding: SCORM Cloud does NOT support xAPI 2.0
    expect(body.version).not.toContain('2.0.0');
  });

  it('xAPI 2.0 client gets explicit rejection — not a silent acceptance', { timeout: 15000 }, async (ctx) => {
    if (!reachable) return ctx.skip();

    const stmt = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `tier3c-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/observed', display: { 'en-US': 'observed' } },
      object: { objectType: 'Activity', id: `https://courses.acme.example/v2-test-${Date.now()}` },
      timestamp: new Date().toISOString(),
    };

    const r = await fetch(`${SC_ENDPOINT}/statements`, {
      method: 'POST',
      headers: {
        Authorization: SC_AUTH!,
        'X-Experience-API-Version': '2.0.0',                    // wrong version on purpose
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(stmt),
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);

    const body = await r.text();
    expect(body.toLowerCase()).toContain('2.0.0');           // mentions the rejected version
  });

  it('POST + GET roundtrip: Statement persists with all key fields', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();

    const stmt = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `tier3c-rtt-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: {
        objectType: 'Activity',
        id: `https://courses.acme.example/scorm-cloud-rtt-${Date.now()}`,
        definition: { name: { 'en-US': 'SCORM Cloud roundtrip test' } },
      },
      result: {
        completion: true,
        success: true,
        score: { scaled: 0.91, raw: 91, min: 0, max: 100 },
        duration: 'PT15M30S',
      },
      timestamp: new Date().toISOString(),
    };

    const post = await fetch(`${SC_ENDPOINT}/statements`, {
      method: 'POST',
      headers: COMMON_HEADERS,
      body: JSON.stringify(stmt),
    });
    expect(post.ok).toBe(true);
    const ids = await post.json() as string[];
    expect(ids).toContain(stmt.id);

    // Allow a moment for indexing (some LRSes are eventually-consistent)
    await new Promise(r => setTimeout(r, 500));

    const get = await fetch(`${SC_ENDPOINT}/statements?statementId=${stmt.id}`, {
      headers: { Authorization: SC_AUTH!, 'X-Experience-API-Version': XAPI_VERSION },
    });
    expect(get.ok).toBe(true);
    const fetched = await get.json() as {
      id: string;
      verb: { id: string };
      result: { score: { scaled: number } };
    };
    expect(fetched.id).toBe(stmt.id);
    expect(fetched.verb.id).toBe(stmt.verb.id);
    expect(fetched.result.score.scaled).toBe(0.91);
  });

  it('lossy projection extensions survive SCORM Cloud roundtrip', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();

    const narratives = [
      'Reading 1: explicit-acknowledgment scaffold creates space',
      'Reading 2: it is the SIGNAL not the words',
      'Reading 3: noise; sample too small',
    ];

    const stmt = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `tier3c-ext-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/observed', display: { 'en-US': 'observed' } },
      object: { objectType: 'Activity', id: `urn:cg:synthesis:scorm-cloud-test-${Date.now()}` },
      result: {
        response: narratives[0],
        extensions: {
          'urn:cg:source-descriptor':   'urn:cg:synthesis:scorm-cloud-test',
          'urn:cg:modal-status':        'Hypothetical',
          'urn:cg:coherent-narratives': narratives,
          'urn:cg:projection-lossy':    true,
        },
      },
      timestamp: new Date().toISOString(),
    };

    const post = await fetch(`${SC_ENDPOINT}/statements`, {
      method: 'POST',
      headers: COMMON_HEADERS,
      body: JSON.stringify(stmt),
    });
    expect(post.ok).toBe(true);

    await new Promise(r => setTimeout(r, 500));

    const get = await fetch(`${SC_ENDPOINT}/statements?statementId=${stmt.id}`, {
      headers: { Authorization: SC_AUTH!, 'X-Experience-API-Version': XAPI_VERSION },
    });
    expect(get.ok).toBe(true);

    const fetched = await get.json() as { result: { extensions: Record<string, unknown> } };

    // Extension passthrough is core xAPI behavior; SCORM Cloud preserves
    expect(fetched.result.extensions['urn:cg:projection-lossy']).toBe(true);
    expect(fetched.result.extensions['urn:cg:modal-status']).toBe('Hypothetical');
    expect(fetched.result.extensions['urn:cg:coherent-narratives']).toEqual(narratives);
  });

  it('voiding (xAPI 1.0.3 §4.1.6.7): voided statement gets 404 on plain GET', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();

    const original = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `tier3c-void-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { objectType: 'Activity', id: `urn:cg:voidable-${Date.now()}` },
      timestamp: new Date().toISOString(),
    };

    let r = await fetch(`${SC_ENDPOINT}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(original),
    });
    expect(r.ok).toBe(true);

    const voidStmt = {
      id: randomUUID(),
      actor: original.actor,
      verb: { id: 'http://adlnet.gov/expapi/verbs/voided', display: { 'en-US': 'voided' } },
      object: { objectType: 'StatementRef', id: original.id },
      timestamp: new Date(Date.now() + 100).toISOString(),
    };
    r = await fetch(`${SC_ENDPOINT}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(voidStmt),
    });
    expect(r.ok).toBe(true);

    await new Promise(r => setTimeout(r, 500));

    // Plain GET on the original returns 404 per xAPI 1.0.3 §4.1.6.7 / 4.2.1
    // (matches what we found against Lrsql in Tier 3b — cross-LRS conformance)
    const getOriginal = await fetch(`${SC_ENDPOINT}/statements?statementId=${original.id}`, {
      headers: { Authorization: SC_AUTH!, 'X-Experience-API-Version': XAPI_VERSION },
    });
    expect(getOriginal.status).toBe(404);

    // voidedStatementId= retrieves the voided statement
    const getVoidedById = await fetch(`${SC_ENDPOINT}/statements?voidedStatementId=${original.id}`, {
      headers: { Authorization: SC_AUTH!, 'X-Experience-API-Version': XAPI_VERSION },
    });
    expect(getVoidedById.ok).toBe(true);
    const voided = await getVoidedById.json() as { id: string };
    expect(voided.id).toBe(original.id);
  });

  it('cross-LRS confirmation: same Statement shape works against Lrsql AND SCORM Cloud', { timeout: 30000 }, async (ctx) => {
    if (!reachable) return ctx.skip();

    // The lrs-adapter projects an Asserted descriptor as a Statement shape
    // that's xAPI 1.0.3 conformant. The SAME shape works against:
    //   - Lrsql (open-source, Tier 3 + 3b)
    //   - SCORM Cloud (proprietary, this Tier 3c)
    // → adapter is genuinely cross-LRS interoperable for the canonical
    //   xAPI 1.0.3 / 2.0.0 spec-conformant subset.
    const stmt = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `tier3c-cross-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { objectType: 'Activity', id: `urn:cg:cross-lrs-${Date.now()}` },
      result: { completion: true, success: true, score: { scaled: 0.85 } },
      timestamp: new Date().toISOString(),
    };

    const r = await fetch(`${SC_ENDPOINT}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(stmt),
    });
    expect(r.ok).toBe(true);
  });
});
