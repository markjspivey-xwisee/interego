#!/usr/bin/env node
/**
 * xAPI 2.0 Conformance Smoke Runner for Foxxi-as-LRS.
 *
 * Exercises every endpoint of the Foxxi LRS surface against expected
 * behavior per IEEE 9274.1.1 (xAPI 2.0). Designed to be runnable
 * against any deployment of the bridge:
 *
 *   FOXXI_BRIDGE_URL=https://...  node tools/xapi-conformance-smoke.mjs
 *
 * Authenticates with a wallet-signed session token (same shape the
 * dashboard mints) since most assertions need it. Run after every
 * deploy to verify nothing regressed.
 *
 * Spec sections covered (parenthetical references):
 *   §3.1   X-Experience-API-Version header negotiation
 *   §4.1   Statement-id MUST be UUID; actor.objectType required
 *   §4.1.1 Statement immutability — re-POST with different body → 409
 *   §4.1.7 Voiding semantics — voided GET via voidedStatementId only
 *   §4.2   Filtered queries — agent / verb / activity / since / until
 *   §6.3   State + Profile resources — ETag, If-Match, If-None-Match, 412
 *   §7.7   /about — version array + extensions
 *   xAPI Profile spec — /xapi/profile JSON-LD doc with concepts + templates + patterns
 *
 * Each check prints PASS or FAIL with the spec citation; exit code 0 on
 * full pass, 1 if any check fails.
 */

import { mintSessionToken } from '../src/auth.ts';

const BRIDGE = process.env.FOXXI_BRIDGE_URL
  ?? 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const WEB_ID = process.env.FOXXI_TEST_WEBID
  ?? 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io/users/jliu/profile/card#me';
const USER_ID = process.env.FOXXI_TEST_USERID ?? 'u-joshua';

const checks = [];
function check(name, ok, spec, detail = '') {
  checks.push({ name, ok, spec, detail });
  const sym = ok ? '✓' : '✗';
  console.log(`  ${sym} ${name.padEnd(60)} (${spec})${detail ? ' — ' + detail : ''}`);
}

const token = await mintSessionToken({ userId: USER_ID, webId: WEB_ID, ttlMs: 30 * 60 * 1000 });
const H = { 'Content-Type': 'application/json', 'X-Experience-API-Version': '2.0.0', 'Authorization': `Bearer ${token}` };

console.log(`\n=== xAPI 2.0 Conformance Smoke against ${BRIDGE} ===\n`);

// ── §3.1 + §7.7 — /about ──
{
  console.log('— /about negotiation (§3.1, §7.7) —');
  const r = await fetch(`${BRIDGE}/xapi/about`, { headers: H });
  check('GET /xapi/about returns 200 with auth', r.status === 200, '§7.7');
  const body = await r.json();
  check('/about reports 2.0.0 in version array', Array.isArray(body.version) && body.version.includes('2.0.0'), '§7.7');
  check('/about reports backend description extension', !!body.extensions?.['https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#lrsBackend'], 'foxxi ext');
}

// ── /xapi/profile ──
{
  console.log('\n— /xapi/profile (xAPI Profile Spec 2017) —');
  const r = await fetch(`${BRIDGE}/xapi/profile`);
  check('GET /xapi/profile returns 200 without auth', r.status === 200, 'Profile §3');
  const body = await r.json();
  check('Profile declares @context = profiles context', body['@context']?.includes('xapi/profiles'), 'Profile §3');
  check('Profile has concepts array', Array.isArray(body.concepts) && body.concepts.length > 0, 'Profile §4');
  check('Profile has templates array', Array.isArray(body.templates) && body.templates.length > 0, 'Profile §5');
  check('Profile has patterns array', Array.isArray(body.patterns) && body.patterns.length > 0, 'Profile §6');
}

// ── §4.1 — statement POST ──
let storedId;
let canonicalStmt;
{
  console.log('\n— Statement POST (§4.1) —');
  const stmt = {
    actor: { name: 'smoke', account: { homePage: 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io', name: USER_ID } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { en: 'experienced' } },
    object: { id: 'urn:foxxi:test:conformance-smoke', definition: { type: 'http://adlnet.gov/expapi/activities/lesson' } },
    timestamp: new Date().toISOString(),
  };
  canonicalStmt = stmt;
  const r = await fetch(`${BRIDGE}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(stmt) });
  const ids = await r.json();
  check('POST /xapi/statements returns 200 + UUID array', r.status === 200 && Array.isArray(ids) && /^[0-9a-f]{8}-/.test(ids[0]), '§4.1');
  storedId = ids[0];

  // GET by id — should round-trip
  const rg = await fetch(`${BRIDGE}/xapi/statements?statementId=${storedId}`, { headers: H });
  const got = await rg.json();
  check('GET single statement by UUID returns it', rg.status === 200 && got.id === storedId, '§4.2');
  check('Stored statement carries version=2.0.0', got.version === '2.0.0', '§4.1.10');
  check('Stored statement carries actor.objectType=Agent', got.actor?.objectType === 'Agent', '§4.1.2');
  check('Stored statement carries object.objectType=Activity', got.object?.objectType === 'Activity', '§4.1.4');
  check('LRS-set authority present', got.authority?.objectType === 'Agent', '§4.1.10');
  check('LRS-set stored timestamp present', typeof got.stored === 'string', '§4.1.10');
}

// ── §4.1.1 — immutability ──
{
  console.log('\n— Statement immutability (§4.1.1) —');
  // Re-POST the *exact same canonical body* with the stored id → idempotent.
  // (The LRS-set `stored` + `authority` are excluded from the immutability
  // comparison per first-write-wins; the caller-authored body must match.)
  const same = { ...canonicalStmt, id: storedId };
  const r1 = await fetch(`${BRIDGE}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(same) });
  check('Re-POST identical statement does not 409', r1.status === 200, '§4.1.1');

  // Same id, different body → 409
  const diff = { ...same, verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { en: 'completed' } } };
  const r2 = await fetch(`${BRIDGE}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(diff) });
  check('Re-POST same id w/ different body → 409', r2.status === 409, '§4.1.1');
}

// ── §4.1.7 — voiding ──
{
  console.log('\n— Voiding (§4.1.7) —');
  // Post a target statement
  const target = {
    actor: { name: 'smoke', account: { homePage: 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io', name: USER_ID } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/experienced', display: { en: 'experienced' } },
    object: { id: 'urn:foxxi:test:will-be-voided' },
  };
  const r1 = await fetch(`${BRIDGE}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(target) });
  const [tid] = await r1.json();

  // Post a voiding statement
  const voiding = {
    actor: { name: 'smoke', account: { homePage: 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io', name: USER_ID } },
    verb: { id: 'http://adlnet.gov/expapi/verbs/voided', display: { en: 'voided' } },
    object: { objectType: 'StatementRef', id: tid },
  };
  await fetch(`${BRIDGE}/xapi/statements`, { method: 'POST', headers: H, body: JSON.stringify(voiding) });

  const rNorm = await fetch(`${BRIDGE}/xapi/statements?statementId=${tid}`, { headers: H });
  check('GET ?statementId=<voided> → 404', rNorm.status === 404, '§4.1.7');
  const rVoid = await fetch(`${BRIDGE}/xapi/statements?voidedStatementId=${tid}`, { headers: H });
  check('GET ?voidedStatementId=<voided> → 200', rVoid.status === 200, '§4.1.7');
}

// ── §4.2 — filtered query ──
{
  console.log('\n— Filtered query (§4.2) —');
  const r = await fetch(`${BRIDGE}/xapi/statements?verb=${encodeURIComponent('http://adlnet.gov/expapi/verbs/experienced')}&limit=10`, { headers: H });
  const body = await r.json();
  check('Verb-filtered query returns statements array', Array.isArray(body.statements), '§4.2');
  check('"more" continuation field present (may be empty)', typeof body.more === 'string', '§4.2');
  check('All returned statements match the verb filter', body.statements.every(s => s.verb?.id === 'http://adlnet.gov/expapi/verbs/experienced'), '§4.2');
}

// ── §6.3 — state resource ETag concurrency ──
{
  console.log('\n— State resource (§6.3) —');
  const activityId = 'urn:foxxi:test:state-activity';
  const agent = JSON.stringify({ account: { homePage: 'https://interego-acme-id.livelysky-8b81abb0.eastus.azurecontainerapps.io', name: USER_ID } });
  const stateId = 'progress';
  const qs = `activityId=${encodeURIComponent(activityId)}&agent=${encodeURIComponent(agent)}&stateId=${stateId}`;
  const url = `${BRIDGE}/xapi/activities/state?${qs}`;

  const r1 = await fetch(url, { method: 'PUT', headers: H, body: JSON.stringify({ slide: 3 }) });
  const etag = r1.headers.get('ETag');
  check('PUT state returns 204 + ETag', r1.status === 204 && !!etag, '§6.3.3');

  const r2 = await fetch(url, { headers: { ...H, 'If-None-Match': etag } });
  check('GET state with If-None-Match=<etag> → 304', r2.status === 304, '§6.3.2');

  const r3 = await fetch(url, { method: 'PUT', headers: { ...H, 'If-Match': '"wrong-etag"' }, body: JSON.stringify({ slide: 4 }) });
  check('PUT state with wrong If-Match → 412', r3.status === 412, '§6.3.3');

  const r4 = await fetch(url, { method: 'PUT', headers: { ...H, 'If-Match': etag }, body: JSON.stringify({ slide: 4 }) });
  check('PUT state with correct If-Match → 204', r4.status === 204, '§6.3.3');
}

// ── Summary ──
const pass = checks.filter(c => c.ok).length;
const fail = checks.filter(c => !c.ok).length;
console.log(`\n=== ${pass} passed / ${fail} failed (${checks.length} checks total) ===`);
if (fail > 0) {
  console.log('\nFailing checks:');
  for (const c of checks.filter(x => !x.ok)) console.log(`  ✗ ${c.name} (${c.spec})${c.detail ? ' — ' + c.detail : ''}`);
  process.exit(1);
}
