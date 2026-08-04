/**
 * CORS allowlist regression tests.
 *
 * Locks in the fix for issue `cors`: the deployed Express services
 * (deploy/mcp-relay/server.ts and deploy/identity/server.ts) and the
 * stdlib css-gate (deploy/css-gate/server.mjs) MUST NOT reflect arbitrary
 * origins as `Access-Control-Allow-Origin`, MUST NOT emit
 * `Access-Control-Allow-Credentials: true`, and MUST NOT treat
 * `Origin: null` as a valid origin.
 *
 * The relay's own tsconfig already includes `cors-allowlist.ts`; this
 * test exercises that module directly because the same logic is mirrored
 * into the identity and css-gate copies (kept in sync by structural
 * inspection — see `it('keeps sibling deployment list in sync')` below).
 *
 * Probe pattern: for every off-list origin (`https://evil.example`,
 * `null`, `http://attacker.localdomain`), assert that the computed
 * Access-Control-Allow-Origin is the SERVICE'S OWN ORIGIN (not the
 * request origin), and that no credentials header is emitted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildCorsAllowlist,
  computeCorsHeaders,
  corsMiddleware,
  isAllowedOrigin,
} from '../deploy/mcp-relay/cors-allowlist.js';
import { stripComments } from '../deploy/mcp-relay/tests/strip-comments.js';

// The services' own origins on the LIVE stack. These were Azure FQDNs, which quietly
// weakened several assertions below: buildCorsAllowlist always adds `ownOrigin`, so
// passing a retired host made the suite prove things about a deployment that no longer
// exists — and kept proving them after the real allowlist had moved on.
const RELAY_OWN = 'https://relay.interego.xwisee.com';
const IDENTITY_OWN = 'https://identity.interego.xwisee.com';
const CSS_GATE_OWN = 'https://gate.interego.xwisee.com';

const OFF_LIST_ORIGINS = [
  'https://evil.example',
  'https://evil.example:8443',
  'http://localhost.evil.example',
  'https://claude.ai.evil.example',
  // Trailing dot trick (same host, different string).
  'https://evil.example.',
  // Scheme downgrade against a real allowlisted host.
  'http://claude.ai',
  // Subdomain hijack against a real allowlisted host.
  'https://attacker.claude.ai',
];

describe('CORS allowlist — module', () => {
  it('treats Origin: null as off-list, never reflects it', () => {
    const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
    expect(isAllowedOrigin('null', list)).toBe(false);
    expect(isAllowedOrigin(null, list)).toBe(false);
    expect(isAllowedOrigin(undefined, list)).toBe(false);
    expect(isAllowedOrigin('', list)).toBe(false);
  });

  it('allows the known browser-MCP-client origins', () => {
    const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
    for (const known of [
      'https://claude.ai',
      'https://chatgpt.com',
      'https://chat.openai.com',
    ]) {
      expect(isAllowedOrigin(known, list)).toBe(true);
    }
  });

  it('allows the sibling deployment FQDNs', () => {
    const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
    for (const sibling of [
      RELAY_OWN, IDENTITY_OWN, CSS_GATE_OWN,
      'https://dashboard.interego.xwisee.com',
      'https://gate.interego.xwisee.com',
      'https://pgsl-browser.interego.xwisee.com',
    ]) {
      expect(isAllowedOrigin(sibling, list)).toBe(true);
    }
  });

  // The other half of the same invariant, behaviourally: the retired environment's
  // origins are not merely absent from the source, they are actually refused.
  it('refuses the retired Azure environment it used to trust', () => {
    const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
    // NB: not via ownOrigin — buildCorsAllowlist always trusts its own origin by
    // construction, so an assertion routed through it could never fail.
    for (const gone of [
      'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io',
      'https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io',
      'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io',
      'https://interego-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io',
    ]) {
      expect(isAllowedOrigin(gone, list), `${gone} is still trusted`).toBe(false);
    }
  });

  it('allows localhost dev ports for both 127.0.0.1 and localhost', () => {
    const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
    for (const port of [3000, 4000, 5000, 9999]) {
      expect(isAllowedOrigin(`http://localhost:${port}`, list)).toBe(true);
      expect(isAllowedOrigin(`http://127.0.0.1:${port}`, list)).toBe(true);
    }
  });

  it('rejects off-list origins exactly', () => {
    const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
    for (const origin of OFF_LIST_ORIGINS) {
      expect(isAllowedOrigin(origin, list)).toBe(false);
    }
  });

  it('honours RELAY_CORS_ALLOWLIST extension', () => {
    const prev = process.env['RELAY_CORS_ALLOWLIST'];
    process.env['RELAY_CORS_ALLOWLIST'] = 'https://partner.example, https://staging.partner.example:8443';
    try {
      const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
      expect(isAllowedOrigin('https://partner.example', list)).toBe(true);
      expect(isAllowedOrigin('https://staging.partner.example:8443', list)).toBe(true);
      expect(isAllowedOrigin('https://other.partner.example', list)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['RELAY_CORS_ALLOWLIST'];
      else process.env['RELAY_CORS_ALLOWLIST'] = prev;
    }
  });

  it('REFUSES to allow Origin: null even via env override (anti-footgun)', () => {
    const prev = process.env['RELAY_CORS_ALLOWLIST'];
    process.env['RELAY_CORS_ALLOWLIST'] = 'null';
    try {
      const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });
      // "null" is rejected by normalizeOrigin since it isn't a valid URL,
      // but even if it sneaks in, isAllowedOrigin short-circuits.
      expect(isAllowedOrigin('null', list)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['RELAY_CORS_ALLOWLIST'];
      else process.env['RELAY_CORS_ALLOWLIST'] = prev;
    }
  });
});

describe('CORS allowlist — computeCorsHeaders', () => {
  const list = buildCorsAllowlist({ ownOrigin: RELAY_OWN });

  it('echoes the origin only for allowlisted callers', () => {
    const h = computeCorsHeaders('https://claude.ai', list, RELAY_OWN);
    expect(h['Access-Control-Allow-Origin']).toBe('https://claude.ai');
    expect(h['Vary']).toBe('Origin');
    expect(h).not.toHaveProperty('Access-Control-Allow-Credentials');
  });

  it('serves the service own origin (not the attacker origin) for off-list callers', () => {
    for (const origin of OFF_LIST_ORIGINS) {
      const h = computeCorsHeaders(origin, list, RELAY_OWN);
      expect(h['Access-Control-Allow-Origin']).toBe(RELAY_OWN);
      // Critical: the off-list attacker origin MUST NOT appear in ACAO.
      expect(h['Access-Control-Allow-Origin']).not.toBe(origin);
      expect(h).not.toHaveProperty('Access-Control-Allow-Credentials');
    }
  });

  it('treats Origin: null as off-list', () => {
    const h = computeCorsHeaders('null', list, RELAY_OWN);
    expect(h['Access-Control-Allow-Origin']).toBe(RELAY_OWN);
    expect(h['Access-Control-Allow-Origin']).not.toBe('null');
    expect(h['Access-Control-Allow-Origin']).not.toBe('*');
  });

  it('serves the service own origin when no Origin header is present', () => {
    const h = computeCorsHeaders(undefined, list, RELAY_OWN);
    expect(h['Access-Control-Allow-Origin']).toBe(RELAY_OWN);
    expect(h['Access-Control-Allow-Origin']).not.toBe('*');
  });

  it('never serves the wildcard "*"', () => {
    for (const origin of [...OFF_LIST_ORIGINS, 'null', undefined, '', 'https://claude.ai']) {
      const h = computeCorsHeaders(origin as string | undefined, list, RELAY_OWN);
      expect(h['Access-Control-Allow-Origin']).not.toBe('*');
    }
  });
});

describe('CORS allowlist — corsMiddleware (integration)', () => {
  it('writes the expected headers via setHeader', () => {
    const mw = corsMiddleware({ ownOrigin: RELAY_OWN });
    const sent: Record<string, string> = {};
    const req = { headers: { origin: 'https://evil.example' } };
    const res = { setHeader: (k: string, v: string) => { sent[k] = v; } };
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(sent['Access-Control-Allow-Origin']).toBe(RELAY_OWN);
    expect(sent['Access-Control-Allow-Origin']).not.toBe('https://evil.example');
    expect(sent['Vary']).toBe('Origin');
    expect(sent).not.toHaveProperty('Access-Control-Allow-Credentials');
  });

  it('echoes the origin for a known browser-MCP-client', () => {
    const mw = corsMiddleware({ ownOrigin: RELAY_OWN });
    const sent: Record<string, string> = {};
    const req = { headers: { origin: 'https://claude.ai' } };
    const res = { setHeader: (k: string, v: string) => { sent[k] = v; } };
    mw(req, res, () => { /* ignore */ });
    expect(sent['Access-Control-Allow-Origin']).toBe('https://claude.ai');
  });
});

// ── Cross-file invariants ──────────────────────────────────────────
//
// The fix duplicates the allowlist into three places (the relay TS module,
// the identity TS module, and the css-gate JS file). These three copies
// MUST stay in sync — if one of them grows a new sibling FQDN, the others
// must too. This test asserts that by reading the files and confirming
// the canonical literal set appears verbatim in all three.

const REPO_ROOT = process.cwd();
const RELAY_FILE = join(REPO_ROOT, 'deploy', 'mcp-relay', 'cors-allowlist.ts');
const IDENTITY_FILE = join(REPO_ROOT, 'deploy', 'identity', 'cors-allowlist.ts');
const CSS_GATE_FILE = join(REPO_ROOT, 'deploy', 'css-gate', 'server.mjs');

/**
 * The LIVE stack's sibling FQDNs.
 *
 * ★ This list used to name the Azure environment (`*.livelysky-8b81abb0.eastus.
 * azurecontainerapps.io`). The stack moved to Railway, css-gate was written fresh and
 * never carried those hosts, and this assertion had been failing on master ever since —
 * a red that said nothing true, which is worse than no test, because it trains everyone
 * to ignore the suite.
 *
 * The Azure origins have now been removed from the allowlists themselves too. They were
 * commented as "inert legacy", but an entry here is not inert: it is an origin these
 * services grant cross-origin trust to, and that environment is deleted. See the
 * no-released-hostnames assertion below.
 */
const CANONICAL_SIBLINGS = [
  'relay.interego.xwisee.com',
  'identity.interego.xwisee.com',
  'dashboard.interego.xwisee.com',
  'gate.interego.xwisee.com',
  'pgsl-browser.interego.xwisee.com',
];

const CANONICAL_BROWSER_HOSTS = [
  'https://claude.ai',
  'https://chatgpt.com',
  'https://chat.openai.com',
];

describe('CORS allowlist — sync across mcp-relay / identity / css-gate', () => {
  const relaySrc = readFileSync(RELAY_FILE, 'utf8');
  const identitySrc = readFileSync(IDENTITY_FILE, 'utf8');
  const cssGateSrc = readFileSync(CSS_GATE_FILE, 'utf8');

  /**
   * ★ THE STRIPPER THESE GUARDS READ THROUGH, AND WHY IT IS NO LONGER LOCAL.
   *
   * Two checks below matched against source with comments removed, each with its own
   * `src.replace(/\/\*[\s\S]*?\*\//g, '')` over RAW text. Those two characters are
   * ordinary characters, and `deploy/mcp-relay/server.ts` contains them inside `//`
   * comments (`// ── /amep/* — AMEP engine …`, `// CORS (ACAO:*) via the /ns/* carve-out`)
   * and inside string literals. Each one opened a phantom block comment that ran to the
   * next real star-slash and took the code between with it — six spans, ~596 lines.
   *
   * MEASURED, not argued: a real
   * `app.use((_req,res,next)=>{res.setHeader('Access-Control-Allow-Credentials','true');
   * next();});` inserted at server.ts:12264 (inside one of those spans) left
   * "does NOT enable Access-Control-Allow-Credentials in any deploy server" GREEN with
   * three occurrences of the header literal in the file. The identical line at :883 —
   * outside every span — failed it correctly. The guard worked everywhere except where a
   * comment had blinded it.
   *
   * `stripComments` now parses instead of pattern-matching, is shared with the two relay
   * suites that had the same copy, and has its own gate
   * (deploy/mcp-relay/tests/strip-comments.test.ts) that reconstructs that exploit and
   * requires the OLD implementation to fail it.
   */
  const codeOf = (src: string, file: string): string => stripComments(src, file);

  it('lists the canonical sibling FQDNs in every copy', () => {
    for (const sibling of CANONICAL_SIBLINGS) {
      expect(relaySrc, `relay missing ${sibling}`).toContain(sibling);
      expect(identitySrc, `identity missing ${sibling}`).toContain(sibling);
      expect(cssGateSrc, `css-gate missing ${sibling}`).toContain(sibling);
    }
  });

  /**
   * ★ An allowlist may only name origins we still control.
   *
   * Six `*.eastus.azurecontainerapps.io` origins sat in SIBLING_DEPLOYMENT_ORIGINS long
   * after that environment was deleted, carrying a comment calling them inert. An entry
   * in a CORS allowlist is never inert — it is standing cross-origin trust extended to a
   * hostname, and a hostname we have released is one whose future occupant we do not
   * choose. Cheap to remove, and nothing good comes of keeping it.
   *
   * Matched against code with comments stripped, because the removal's own note names
   * the pattern to explain it, and a guard that fires on its own explanation gets deleted.
   */
  it('grants cross-origin trust to no hostname we have released', () => {
    const RELEASED = /azurecontainerapps\.io|azurewebsites\.net|\.azureedge\.net/;
    for (const [name, src, file] of [
      ['relay', relaySrc, RELAY_FILE], ['identity', identitySrc, IDENTITY_FILE],
      ['css-gate', cssGateSrc, CSS_GATE_FILE],
    ] as const) {
      const offending = codeOf(src, file)
        .split('\n')
        .filter(l => RELEASED.test(l));
      expect(offending, `${name} still trusts a released hostname:\n  ${offending.join('\n  ')}`)
        .toEqual([]);
    }
  });

  it('lists the canonical browser MCP client hosts in every copy', () => {
    for (const host of CANONICAL_BROWSER_HOSTS) {
      expect(relaySrc, `relay missing ${host}`).toContain(host);
      expect(identitySrc, `identity missing ${host}`).toContain(host);
      expect(cssGateSrc, `css-gate missing ${host}`).toContain(host);
    }
  });

  it('does NOT contain Access-Control-Allow-Origin: * in any deploy server', () => {
    // Spot-check the actual server files (not the allowlist module
    // itself, which legitimately mentions the wildcard in a comment).
    const relayServer = readFileSync(join(REPO_ROOT, 'deploy', 'mcp-relay', 'server.ts'), 'utf8');
    const identityServer = readFileSync(join(REPO_ROOT, 'deploy', 'identity', 'server.ts'), 'utf8');

    // Public-discovery endpoints (RFC 7033 WebFinger, did.json, JWKS) are
    // unauthenticated, read-only and carry no credentials, so ACAO:* on them is
    // correct — NOT the reflected-origin CSRF risk this guard exists for. Such
    // lines are exempt ONLY when explicitly tagged `cors-public-discovery`; any
    // UNMARKED wildcard still fails, so the guard against the general handler
    // reflecting arbitrary origins stays intact.
    const stripPublicDiscovery = (src: string): string =>
      src.split('\n').filter(line => !line.includes('cors-public-discovery')).join('\n');

    // The literal wildcard middleware line MUST NOT appear (unmarked) in either server file.
    expect(stripPublicDiscovery(relayServer)).not.toMatch(/setHeader\(['"]Access-Control-Allow-Origin['"],\s*['"]\*['"]\)/);
    expect(stripPublicDiscovery(identityServer)).not.toMatch(/setHeader\(['"]Access-Control-Allow-Origin['"],\s*['"]\*['"]\)/);
    // And the css-gate must not literally write the wildcard either.
    expect(cssGateSrc).not.toMatch(/['"]Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/);
  });

  it('does NOT enable Access-Control-Allow-Credentials in any deploy server', () => {
    // Comments are stripped before scanning so that warnings like "// Deliberately no
    // Access-Control-Allow-Credentials." in our own rationale don't trip the check. The
    // header literal is forbidden anywhere in executable code. See `codeOf` above for the
    // measured reason this no longer uses a regex to do it.
    // ★ THE SERVERS, NOT THE ALLOWLIST MODULES. `RELAY_FILE`/`IDENTITY_FILE` above are
    // `cors-allowlist.ts`; this check is about what the Express apps actually write, and
    // pointing it at the allowlist module would leave server.ts unscanned while staying
    // green (the allowlist module names the header only in prose).
    const relayServerFile = join(REPO_ROOT, 'deploy', 'mcp-relay', 'server.ts');
    const identityServerFile = join(REPO_ROOT, 'deploy', 'identity', 'server.ts');
    const relayServer = codeOf(readFileSync(relayServerFile, 'utf8'), relayServerFile);
    const identityServer = codeOf(readFileSync(identityServerFile, 'utf8'), identityServerFile);
    const cssGateCode = codeOf(cssGateSrc, CSS_GATE_FILE);
    // A stripper that returned '' would satisfy the assertion below and report nothing.
    // These three files are 30-40% comment, so a view under a third of the source is a
    // stripper eating code — which is exactly what the regex version did. The precise
    // guard against that is deploy/mcp-relay/tests/strip-comments.test.ts; this is the
    // vacuity floor that keeps THIS assertion from passing on an empty string.
    for (const [name, code, src] of [
      ['relay', relayServer, readFileSync(relayServerFile, 'utf8')],
      ['identity', identityServer, readFileSync(identityServerFile, 'utf8')],
      ['css-gate', cssGateCode, cssGateSrc],
    ] as const) {
      expect(code.length, `${name}: stripped view is ${code.length} of ${src.length} chars — the stripper is eating code`)
        .toBeGreaterThan(src.length * 0.33);
      expect(code, `${name}: the stripped view lost the express/http app entirely`)
        .toMatch(/createServer|express\(\)|http\.createServer/);
    }
    // ★ THE ONE PLACE THE NAME MAY APPEAR, AND IT IS A DEFENCE, NOT AN EMISSION.
    //
    // server.ts:10394 holds `FROZEN_CORS_HEADERS`, a Set the relay consults to make
    // `res.setHeader()` a NO-OP for those names, so the MCP SDK's own `router.use(cors())`
    // cannot re-open the wildcard. It sits at line 10,394 — inside the span the old regex
    // stripper ate (10,382-10,437) — so this assertion has never seen it. Un-blinding the
    // stripper surfaced it immediately.
    //
    // Elided by MATCHING THE SET rather than by a name-based skip, and the elision is
    // paired with a positive requirement: the set must exist and must still freeze the
    // credentials header. Deleting the freeze does not quietly satisfy the scan.
    const FROZEN = /const FROZEN_CORS_HEADERS = new Set\(\[[^\]]*\]\)/;
    const frozen = FROZEN.exec(relayServer)?.[0];
    expect(frozen, 'relay no longer freezes the CORS response headers against the SDK router')
      .toBeDefined();
    expect(frozen, 'FROZEN_CORS_HEADERS stopped freezing the credentials header')
      .toContain('access-control-allow-credentials');
    const relayScan = relayServer.replace(FROZEN, 'FROZEN_CORS_HEADERS_ELIDED');

    for (const src of [relayScan, identityServer, cssGateCode]) {
      expect(src).not.toMatch(/Access-Control-Allow-Credentials/i);
    }
  });
});
