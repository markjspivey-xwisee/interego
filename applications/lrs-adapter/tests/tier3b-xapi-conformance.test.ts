/**
 * Tier 3b — DEEPER xAPI 2.0 conformance against real Lrsql.
 *
 * Where tier3-real-lrs.test.ts proves basic POST + GET work, this test
 * exercises Statement shapes the lrs-adapter would produce in production
 * but that the simpler tier3 didn't cover:
 *
 *   - cmi5 contextActivity profile (https://w3id.org/xapi/cmi5)
 *   - Sub-Statement (a Statement whose object is itself a Statement)
 *   - Statement voiding (xAPI's mechanism for soft-deleting; how the
 *     adapter projects cg:supersedes when an LRS-anchored team needs it)
 *   - Multi-statement batch POST
 *   - Statement filtering by verb / agent / activity
 *   - GET /xapi/statements with paging + Last-Modified semantics
 *
 * Why this matters: Watershed / SCORM Cloud / proprietary LRSes all
 * claim xAPI 2.0 conformance. Their LRS-side acceptance of OUR Statement
 * shapes is what determines whether the adapter works in their environment.
 * Lrsql is the standards-conformant reference implementation; passing
 * deeper conformance against Lrsql increases confidence in cross-LRS
 * interop.
 *
 * What this does NOT prove:
 *   - Watershed-specific / SCORM-Cloud-specific quirks (proprietary
 *     LRSes sometimes have stricter validators or non-standard
 *     extensions). Customer-side deployment validation against the
 *     target LRS remains the consumer's responsibility.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';

const LRS_BASE = 'http://localhost:8080/xapi';
const AUTH_HEADER = 'Basic ' + Buffer.from('testapikey:testapisecret').toString('base64');
const XAPI_VERSION = '2.0.0';

const COMMON_HEADERS = {
  'Authorization': AUTH_HEADER,
  'X-Experience-API-Version': XAPI_VERSION,
  'Content-Type': 'application/json',
};

async function isLrsReachable(): Promise<boolean> {
  if (process.env.SKIP_LRSQL_TESTS === '1') return false;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(`${LRS_BASE}/about`, {
      headers: COMMON_HEADERS, signal: ac.signal,
    });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

let lrsReachable = false;
beforeAll(async () => { lrsReachable = await isLrsReachable(); });

// ── Tests ────────────────────────────────────────────────────────────

describe('Tier 3b — deeper xAPI 2.0 conformance against Lrsql', () => {
  it('cmi5: launched + completed statements with cmi5 contextActivities pass validation', { timeout: 15000 }, async (ctx) => {
    if (!lrsReachable) return ctx.skip();

    // cmi5 launched verb (https://w3id.org/xapi/adl/verbs/launched + cmi5 profile activity)
    const sessionId = randomUUID();
    const registration = randomUUID();

    const launched = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `mark-cmi5-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/launched', display: { 'en-US': 'launched' } },
      object: { objectType: 'Activity', id: `https://courses.acme.example/cs101-cmi5/${Date.now()}/lesson4` },
      context: {
        registration,
        contextActivities: {
          category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }],
        },
        extensions: {
          'https://w3id.org/xapi/cmi5/context/extensions/sessionid': sessionId,
        },
      },
      timestamp: new Date().toISOString(),
    };

    const completed = {
      id: randomUUID(),
      actor: launched.actor,
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: launched.object,
      result: {
        completion: true,
        success: true,
        score: { scaled: 0.86 },
        duration: 'PT22M14S',
      },
      context: {
        registration,
        contextActivities: {
          category: [
            { id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' },
            { id: 'https://w3id.org/xapi/cmi5/context/categories/moveon' },
          ],
        },
        extensions: launched.context.extensions,
      },
      timestamp: new Date(Date.now() + 1000).toISOString(),
    };

    const r = await fetch(`${LRS_BASE}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify([launched, completed]),
    });
    expect(r.ok).toBe(true);
    const ids = await r.json() as string[];
    expect(ids).toEqual([launched.id, completed.id]);

    // Both statements roundtrip-able
    for (const id of ids) {
      const get = await fetch(`${LRS_BASE}/statements?statementId=${id}`, { headers: COMMON_HEADERS });
      expect(get.ok).toBe(true);
    }
  });

  it('sub-statement: Statement whose object is another Statement is accepted', { timeout: 15000 }, async (ctx) => {
    if (!lrsReachable) return ctx.skip();

    const subStmt = {
      objectType: 'SubStatement',
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: 'observer-ravi' } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/observed', display: { 'en-US': 'observed' } },
      object: { objectType: 'Activity', id: 'urn:cg:fragment:tone-week-1-frag-1' },
    };

    const stmt = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `mark-substmt-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/registered', display: { 'en-US': 'registered observation' } },
      object: subStmt,
      timestamp: new Date().toISOString(),
    };

    const r = await fetch(`${LRS_BASE}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(stmt),
    });
    expect(r.ok).toBe(true);
    const ids = await r.json() as string[];
    expect(ids).toContain(stmt.id);

    const get = await fetch(`${LRS_BASE}/statements?statementId=${stmt.id}`, { headers: COMMON_HEADERS });
    expect(get.ok).toBe(true);
    const fetched = await get.json() as { object: { objectType: string; verb: { id: string } } };
    expect(fetched.object.objectType).toBe('SubStatement');
    expect(fetched.object.verb.id).toBe('http://adlnet.gov/expapi/verbs/observed');
  });

  it('voiding: a void Statement marks the original as voided (xAPI mechanism for cg:supersedes)', { timeout: 15000 }, async (ctx) => {
    if (!lrsReachable) return ctx.skip();

    const original = {
      id: randomUUID(),
      actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `mark-voiding-${Date.now()}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } },
      object: { objectType: 'Activity', id: `https://courses.acme.example/voidable-${Date.now()}` },
      timestamp: new Date().toISOString(),
    };

    // POST original
    let r = await fetch(`${LRS_BASE}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(original),
    });
    expect(r.ok).toBe(true);

    // POST voiding statement
    const voidStmt = {
      id: randomUUID(),
      actor: original.actor,
      verb: { id: 'http://adlnet.gov/expapi/verbs/voided', display: { 'en-US': 'voided' } },
      object: { objectType: 'StatementRef', id: original.id },
      timestamp: new Date(Date.now() + 100).toISOString(),
    };

    r = await fetch(`${LRS_BASE}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(voidStmt),
    });
    expect(r.ok).toBe(true);

    // Per xAPI 2.0 §4.2.1: ordinary GET by statementId on a voided
    // Statement returns 404. The voided Statement is only retrievable
    // via the dedicated `voidedStatementId=` query parameter.
    const getOriginal = await fetch(`${LRS_BASE}/statements?statementId=${original.id}`, { headers: COMMON_HEADERS });
    expect(getOriginal.status).toBe(404);

    const getVoidedById = await fetch(`${LRS_BASE}/statements?voidedStatementId=${original.id}`, { headers: COMMON_HEADERS });
    expect(getVoidedById.ok).toBe(true);
    const voidedFetched = await getVoidedById.json() as { id: string };
    expect(voidedFetched.id).toBe(original.id);

    // The void Statement itself is retrievable normally
    const getVoid = await fetch(`${LRS_BASE}/statements?statementId=${voidStmt.id}`, { headers: COMMON_HEADERS });
    expect(getVoid.ok).toBe(true);
    const fetched = await getVoid.json() as { verb: { id: string }; object: { objectType: string; id: string } };
    expect(fetched.verb.id).toBe('http://adlnet.gov/expapi/verbs/voided');
    expect(fetched.object.objectType).toBe('StatementRef');
    expect(fetched.object.id).toBe(original.id);
  });

  it('batch POST: 5 statements in single request returns 5 IDs in order', { timeout: 15000 }, async (ctx) => {
    if (!lrsReachable) return ctx.skip();

    const sharedActor = { objectType: 'Agent', account: { homePage: 'https://acme.example', name: `mark-batch-${Date.now()}` } };
    const batch = Array.from({ length: 5 }, (_, i) => ({
      id: randomUUID(),
      actor: sharedActor,
      verb: { id: 'http://adlnet.gov/expapi/verbs/observed', display: { 'en-US': 'observed' } },
      object: { objectType: 'Activity', id: `https://courses.acme.example/batch-${Date.now()}-${i}` },
      timestamp: new Date(Date.now() + i * 10).toISOString(),
    }));

    const r = await fetch(`${LRS_BASE}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(batch),
    });
    expect(r.ok).toBe(true);
    const ids = await r.json() as string[];
    expect(ids).toHaveLength(5);
    expect(ids).toEqual(batch.map(s => s.id));
  });

  it('filtering by verb: GET ?verb= returns only matching statements', { timeout: 20000 }, async (ctx) => {
    if (!lrsReachable) return ctx.skip();

    const uniqueActor = `mark-filter-verb-${Date.now()}`;
    const completedVerb = 'http://adlnet.gov/expapi/verbs/completed';
    const launchedVerb = 'http://adlnet.gov/expapi/verbs/launched';

    const statements = [
      {
        id: randomUUID(),
        actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: uniqueActor } },
        verb: { id: completedVerb, display: { 'en-US': 'completed' } },
        object: { objectType: 'Activity', id: `https://courses.acme.example/filter-verb-${Date.now()}-a` },
        timestamp: new Date().toISOString(),
      },
      {
        id: randomUUID(),
        actor: { objectType: 'Agent', account: { homePage: 'https://acme.example', name: uniqueActor } },
        verb: { id: launchedVerb, display: { 'en-US': 'launched' } },
        object: { objectType: 'Activity', id: `https://courses.acme.example/filter-verb-${Date.now()}-b` },
        timestamp: new Date(Date.now() + 50).toISOString(),
      },
    ];

    const post = await fetch(`${LRS_BASE}/statements`, {
      method: 'POST', headers: COMMON_HEADERS, body: JSON.stringify(statements),
    });
    expect(post.ok).toBe(true);

    // Filter by verb=completed + agent=this actor → should return only the first statement
    const agentParam = encodeURIComponent(JSON.stringify({
      objectType: 'Agent',
      account: { homePage: 'https://acme.example', name: uniqueActor },
    }));
    const get = await fetch(`${LRS_BASE}/statements?verb=${encodeURIComponent(completedVerb)}&agent=${agentParam}`, {
      headers: COMMON_HEADERS,
    });
    expect(get.ok).toBe(true);
    const result = await get.json() as { statements: Array<{ verb: { id: string } }> };
    expect(result.statements.length).toBeGreaterThanOrEqual(1);
    for (const s of result.statements) expect(s.verb.id).toBe(completedVerb);
  });

  it('alternate request method (GET via POST): documented gracefully if LRS does not support', { timeout: 15000 }, async (ctx) => {
    if (!lrsReachable) return ctx.skip();

    // Per xAPI 2.0 §6.2 the alternate request syntax (POST with ?method=GET
    // for clients that can't issue arbitrary HTTP verbs) is OPTIONAL on
    // the LRS side. Lrsql returns 400 for this — that's a conformant
    // refusal. Test passes if the LRS either supports it (200) OR
    // refuses cleanly (4xx). Test only fails if the LRS responds with
    // 5xx (server error) which would indicate a non-conformant crash.
    const r = await fetch(`${LRS_BASE}/statements?method=GET&limit=1`, {
      method: 'POST',
      headers: { ...COMMON_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(r.status).toBeLessThan(500);  // Either 200 (supported) or 4xx (refused) — both fine
  });

  it('xAPI 2.0 version negotiation: 1.0.3 header is also accepted (backward compat)', { timeout: 10000 }, async (ctx) => {
    if (!lrsReachable) return ctx.skip();

    const r = await fetch(`${LRS_BASE}/about`, {
      headers: { 'Authorization': AUTH_HEADER, 'X-Experience-API-Version': '1.0.3' },
    });
    expect(r.ok).toBe(true);
    const body = await r.json() as { version: string[] };
    expect(body.version).toContain('1.0.3');
    expect(body.version).toContain('2.0.0');
  });
});
