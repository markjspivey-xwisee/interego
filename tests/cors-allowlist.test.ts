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

const RELAY_OWN = 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const IDENTITY_OWN = 'https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const CSS_GATE_OWN = 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io';

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
      'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io',
      'https://interego-dashboard.livelysky-8b81abb0.eastus.azurecontainerapps.io',
      'https://interego-pgsl-browser.livelysky-8b81abb0.eastus.azurecontainerapps.io',
    ]) {
      expect(isAllowedOrigin(sibling, list)).toBe(true);
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

const CANONICAL_SIBLINGS = [
  'interego-relay.livelysky-8b81abb0',
  'interego-identity.livelysky-8b81abb0',
  'interego-dashboard.livelysky-8b81abb0',
  'interego-css.internal.livelysky-8b81abb0',
  'interego-css-gate.livelysky-8b81abb0',
  'interego-pgsl-browser.livelysky-8b81abb0',
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

  it('lists the canonical sibling FQDNs in every copy', () => {
    for (const sibling of CANONICAL_SIBLINGS) {
      expect(relaySrc, `relay missing ${sibling}`).toContain(sibling);
      expect(identitySrc, `identity missing ${sibling}`).toContain(sibling);
      expect(cssGateSrc, `css-gate missing ${sibling}`).toContain(sibling);
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
    // Strip JS/TS comments before scanning so that warnings like
    // "// Deliberately no Access-Control-Allow-Credentials." in our own
    // rationale don't trip the check. We forbid the header literal
    // appearing anywhere in executable code paths.
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/^\s*\*.*$/gm, '')          // jsdoc continuation lines
        .replace(/\/\/.*$/gm, '');           // line comments

    const relayServer = stripComments(readFileSync(join(REPO_ROOT, 'deploy', 'mcp-relay', 'server.ts'), 'utf8'));
    const identityServer = stripComments(readFileSync(join(REPO_ROOT, 'deploy', 'identity', 'server.ts'), 'utf8'));
    const cssGateCode = stripComments(cssGateSrc);
    for (const src of [relayServer, identityServer, cssGateCode]) {
      expect(src).not.toMatch(/Access-Control-Allow-Credentials/i);
    }
  });
});
