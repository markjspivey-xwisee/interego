#!/usr/bin/env node
// Smoke test for the /try → claim flow contract.
//
// Validates the four guarantees the /try endpoint makes against a live
// identity-server deployment:
//
//   1. POST /try returns a signed bearer + a working MCP snippet.
//   2. The bearer authenticates against /me (token survives the
//      stateless-tokens pipeline end-to-end).
//   3. POST /auth/webauthn/register-options with that bearer is
//      accepted as the add-device path — i.e. the existing u-try-*
//      userId is the binding target, not a fresh-derive.
//   4. The /health endpoint reports the signing key as 'env' (so
//      tokens survive deploys) rather than 'ephemeral' (which would
//      re-break the original "wiped on every deploy" complaint).
//
// Not a load test, not a security audit — a contract check. Run after
// a deploy that touches deploy/identity/server.ts to catch drift.
//
// Usage:
//   node tools/smoke-try-flow.mjs                       # hits the prod identity FQDN
//   IDENTITY_BASE=http://localhost:8081 node tools/smoke-try-flow.mjs
//
// Exits 0 on all-pass, non-zero on any failure.

const IDENTITY_BASE = process.env.IDENTITY_BASE
  ?? 'https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io';

let failed = 0;
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); failed++; }
function head(msg) { console.log(`\n${msg}`); }

async function json(path, init = {}) {
  const r = await fetch(IDENTITY_BASE + path, init);
  const txt = await r.text();
  let body;
  try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, ok: r.ok, body };
}

async function main() {
  console.log(`Smoke test: ${IDENTITY_BASE}`);

  // 1. /try mints an ephemeral identity with a signed bearer + snippet.
  head('1. POST /try');
  const tryResp = await json('/try', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!tryResp.ok) { fail(`HTTP ${tryResp.status}: ${JSON.stringify(tryResp.body)}`); return finish(); }
  const { token, userId, podUrl, ephemeral, mcpConfigSnippet, ttlNote } = tryResp.body;
  if (typeof token === 'string' && token.startsWith('cg2_')) ok('token has cg2_ stateless-signed prefix');
  else                                                       fail(`token shape wrong: ${String(token).slice(0,20)}…`);
  if (typeof userId === 'string' && userId.startsWith('u-try-')) ok(`userId is u-try-* (${userId})`);
  else                                                            fail(`userId shape wrong: ${userId}`);
  if (ephemeral === true)                                         ok('ephemeral flag set');
  else                                                            fail('ephemeral flag missing/false');
  if (typeof podUrl === 'string' && podUrl.includes(userId))     ok('pod URL contains userId');
  else                                                            fail(`pod URL shape wrong: ${podUrl}`);
  if (typeof mcpConfigSnippet === 'string' && mcpConfigSnippet.includes('Bearer ' + token))
    ok('mcpConfigSnippet embeds the bearer correctly');
  else
    fail('mcpConfigSnippet missing the bearer');
  if (typeof ttlNote === 'string' && /claim|keep it|addDeviceToken/i.test(ttlNote))
    ok('ttlNote documents the claim-it path');
  else
    fail(`ttlNote does not describe the claim path: ${ttlNote}`);

  // 2. /me with that bearer round-trips identity.
  head('2. GET /me with the issued bearer');
  const meResp = await json('/me', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!meResp.ok) { fail(`HTTP ${meResp.status}: ${JSON.stringify(meResp.body)}`); }
  else if (meResp.body.userId === userId) ok(`/me returns matching userId (${userId})`);
  else                                    fail(`/me userId mismatch: got ${meResp.body.userId}, expected ${userId}`);

  // 3. /auth/webauthn/register-options with that bearer is the add-device path.
  //    We don't complete the ceremony (that needs a real authenticator);
  //    we just check the server ACCEPTED the bearer and bound the
  //    challenge to the same userId via the addDeviceUserId path.
  head('3. POST /auth/webauthn/register-options with bearer (add-device contract)');
  const optsResp = await json('/auth/webauthn/register-options', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ name: 'smoke-test claim' }),
  });
  if (!optsResp.ok) { fail(`HTTP ${optsResp.status}: ${JSON.stringify(optsResp.body)}`); }
  else if (typeof optsResp.body.challenge === 'string') {
    ok('challenge issued');
    // Verify the ceremony is bound to the EXISTING u-try-* userId rather
    // than freshly deriving one. The WebAuthn user handle (options.user.id)
    // is opaque random bytes per spec, but options.user.name carries the
    // userName the server passed to generateRegistrationOptions — and
    // /auth/webauthn/register-options sets userName = sessionUserId,
    // which equals addDeviceUserId for the add-device path. So
    // options.user.name === our userId proves the binding.
    const userName = optsResp.body.user?.name;
    if (typeof userName === 'string' && userName === userId) {
      ok(`ceremony bound to the existing u-try-* userId (add-device path, no new userId minted)`);
    } else if (typeof userName === 'string' && userName.startsWith('u-pend-')) {
      fail(`ceremony went down the derive path (userName=${userName}) — bearer was ignored`);
    } else {
      fail(`options.user.name unexpected: ${userName}`);
    }
    // Also assert excludeCredentials handling — for an add-device call
    // against a freshly-/try-minted user with NO credentials yet, the
    // excludeCredentials list should be empty.
    const excludeLen = Array.isArray(optsResp.body.excludeCredentials) ? optsResp.body.excludeCredentials.length : -1;
    if (excludeLen === 0) ok('excludeCredentials is empty (fresh u-try-* user, no prior credentials)');
    else                  fail(`excludeCredentials should be [] for a fresh u-try-* user; got ${excludeLen}`);
  } else {
    fail('no challenge in response');
  }

  // 4. /health reports the signing key as durable (env), not ephemeral.
  head('4. GET /health (tokens survive deploys)');
  const healthResp = await json('/health');
  if (!healthResp.ok) { fail(`HTTP ${healthResp.status}: ${JSON.stringify(healthResp.body)}`); }
  else if (healthResp.body.tokenSigningKeyOrigin === 'env') {
    ok('tokenSigningKeyOrigin = env — tokens survive deploys');
  } else if (healthResp.body.tokenSigningKeyOrigin === 'ephemeral') {
    fail('tokenSigningKeyOrigin = ephemeral — TOKEN_SIGNING_KEY is missing and every deploy will wipe sessions');
  } else {
    fail(`tokenSigningKeyOrigin unexpected: ${healthResp.body.tokenSigningKeyOrigin}`);
  }

  finish();
}

function finish() {
  if (failed === 0) {
    console.log(`\n✓ All checks passed.`);
    process.exit(0);
  }
  console.log(`\n✗ ${failed} check(s) failed.`);
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(2); });
