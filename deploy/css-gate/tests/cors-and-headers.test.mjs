#!/usr/bin/env node
/**
 * css-gate — CORS + response-header invariants.
 *
 * ★ WHY THIS FILE EXISTS. A live audit of the deployed gate found three defects that
 * no test could have caught, because the gate had no test for any of this:
 *
 *   1. No `Access-Control-Expose-Headers`. Every LDP control header the gate exists
 *      to serve — Link (rel=type/acl/describedby/storageDescription), WAC-Allow,
 *      Location, Accept-Post — was sent and UNREADABLE from another origin, because
 *      CORS exposes only a short safelist. This is the SAME defect fixed on the relay
 *      one increment earlier; the relay was fixed and the gate never checked, which
 *      is precisely the "fix the class, not the instance" failure this repo has
 *      written down before.
 *
 *   2. Preflight advertised a fixed header list omitting Slug, Link, If-None-Match
 *      and DPoP — so a browser could not name, type, safely-create, or Solid-OIDC
 *      authenticate a write. The request is never sent; the developer sees only an
 *      opaque "failed to fetch".
 *
 *   3. The private upstream host leaked into public Link headers
 *      (`<http://css.railway.internal:3456/...>; rel="acl"`) — an address that
 *      resolves nowhere off the private network, over plain http on an https page.
 *
 * ★ MOVED INTO tests/ FROM THE PACKAGE ROOT. It was the one suite living outside the test
 * directory, which is why `npm test` had to name it by hand — and naming files by hand is
 * what let a file added to tests/ run nowhere while the suite still reported green. With
 * every suite in one place, `node --test "tests/*.test.mjs"` is complete by construction.
 *
 * Run: node --test deploy/css-gate/tests/cors-and-headers.test.mjs
 */

// The module starts its listener at import unless told not to — it already has the
// guard, so use it rather than leaving a socket open behind the test.
process.env.CSS_GATE_AUTOSTART = '0';
process.env.CSS_INTERNAL_URL ??= 'http://css.railway.internal:3456';
process.env.PUBLIC_BASE_URL ??= 'https://gate.interego.xwisee.com';
process.env.WRITE_SECRET ??= 'test-only';

const { corsHeadersFor } = await import('../server.mjs');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\ncss-gate: a pod is only as followable as its headers are readable');

const h = corsHeadersFor('https://dashboard.interego.xwisee.com');
const exposed = String(h['Access-Control-Expose-Headers'] ?? '').toLowerCase();

// The headers a Solid client cannot work without.
for (const needed of ['link', 'etag', 'accept-post', 'location', 'wac-allow']) {
  check(`exposes ${needed} to a cross-origin client`, exposed.includes(needed), exposed || '<unset>');
}

const allowHeaders = String(h['Access-Control-Allow-Headers'] ?? '').toLowerCase();
for (const needed of ['slug', 'link', 'if-none-match', 'dpop', 'authorization']) {
  check(`preflight permits ${needed} (a write needs it)`, allowHeaders.includes(needed), allowHeaders);
}

// Credentials must never be combined with the wildcard fallback.
check('never sends Allow-Credentials (wildcard fallback would be unsafe with it)',
  !('Access-Control-Allow-Credentials' in h), JSON.stringify(Object.keys(h)));
check('an allowlisted origin is echoed, not wildcarded',
  h['Access-Control-Allow-Origin'] === 'https://dashboard.interego.xwisee.com',
  String(h['Access-Control-Allow-Origin']));
check('Vary: Origin is set so caches do not cross origins',
  String(h['Vary']).toLowerCase().includes('origin'), String(h['Vary']));

// The dead Azure environment must not be allowlisted: its registry is deleted and a
// DNS name nobody owns is a name somebody else can claim.
const azure = corsHeadersFor('https://interego-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io');
check('a retired Azure origin is NOT echoed back as allowed',
  azure['Access-Control-Allow-Origin'] !== 'https://interego-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io',
  String(azure['Access-Control-Allow-Origin']));

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\ncss-gate header invariants hold.\n');
