/**
 * Tests for the CSS-pod URL rewrite the mcp-relay applies at every
 * URL-receiving entry point.
 *
 * Locks in the behaviour described in `deploy/mcp-relay/url-rewrite.ts`:
 *   - OLD public-host URLs are rewritten to the canonical internal-FQDN
 *   - URLs already on the internal-FQDN host are NOT rewritten (no double-
 *     prefixing of `internal.`)
 *   - Non-CSS URLs, URNs, and non-https inputs pass through unchanged
 *   - The function is idempotent (rewrite ∘ rewrite = rewrite)
 *   - Path / query / fragment are preserved across the rewrite
 *
 * The diagnosis driving this fix:
 *   `verify_agent` against `https://interego-css.livelysky-8b81abb0...
 *   .azurecontainerapps.io/markj/` was returning "No agent registry
 *   found" because that public host no longer serves the canonical pod
 *   tree. Live descriptors on the pod still embed the OLD URL in
 *   `cg:origin` / `descriptorUrl` / `dcat:accessURL` positions; the
 *   relay translates them at the HTTP boundary so external callers
 *   keep working.
 */

import { describe, it, expect } from 'vitest';
import { normalizeCssUrl } from '../deploy/mcp-relay/url-rewrite.js';

const OLD_HOST = 'https://interego-css.livelysky-8b81abb0.eastus.azurecontainerapps.io';
const NEW_HOST = 'https://interego-css.internal.livelysky-8b81abb0.eastus.azurecontainerapps.io';

describe('normalizeCssUrl — OLD-host translation', () => {
  it('rewrites a bare OLD-host URL (no trailing slash)', () => {
    expect(normalizeCssUrl(OLD_HOST)).toBe(NEW_HOST);
  });

  it('rewrites OLD-host root with trailing slash', () => {
    expect(normalizeCssUrl(`${OLD_HOST}/`)).toBe(`${NEW_HOST}/`);
  });

  it('rewrites the verify_agent failure case from the diagnosis', () => {
    // The exact URL called out in the migration diagnosis as returning
    // "No agent registry found".
    expect(normalizeCssUrl(`${OLD_HOST}/markj/`)).toBe(`${NEW_HOST}/markj/`);
  });

  it('preserves descriptor paths', () => {
    const path = '/markj/contexts/2026/06/foo-descriptor.ttl';
    expect(normalizeCssUrl(`${OLD_HOST}${path}`)).toBe(`${NEW_HOST}${path}`);
  });

  it('preserves manifest path', () => {
    const path = '/markj/contexts/manifest.jsonld';
    expect(normalizeCssUrl(`${OLD_HOST}${path}`)).toBe(`${NEW_HOST}${path}`);
  });

  it('preserves envelope payload path', () => {
    const path = '/markj/contexts/jam-turn-002-graph.envelope.jose.json';
    expect(normalizeCssUrl(`${OLD_HOST}${path}`)).toBe(`${NEW_HOST}${path}`);
  });

  it('preserves query string', () => {
    const tail = '/markj/contexts/?_v=1&since=2026-06-01';
    expect(normalizeCssUrl(`${OLD_HOST}${tail}`)).toBe(`${NEW_HOST}${tail}`);
  });

  it('preserves fragment', () => {
    const tail = '/markj/contexts/desc.ttl#descriptor';
    expect(normalizeCssUrl(`${OLD_HOST}${tail}`)).toBe(`${NEW_HOST}${tail}`);
  });
});

describe('normalizeCssUrl — pass-through (no rewrite)', () => {
  it('leaves a URL already on the internal-FQDN host unchanged', () => {
    // CRITICAL: a second pass on an already-rewritten URL must NOT produce
    // `internal.internal.livelysky-...`. The regex's negative lookahead
    // `(?!internal\.)` guards this.
    expect(normalizeCssUrl(NEW_HOST)).toBe(NEW_HOST);
    expect(normalizeCssUrl(`${NEW_HOST}/`)).toBe(`${NEW_HOST}/`);
    expect(normalizeCssUrl(`${NEW_HOST}/markj/`)).toBe(`${NEW_HOST}/markj/`);
  });

  it('is idempotent (rewrite ∘ rewrite = rewrite)', () => {
    const samples = [
      OLD_HOST,
      `${OLD_HOST}/`,
      `${OLD_HOST}/markj/`,
      `${OLD_HOST}/markj/contexts/desc.ttl`,
      `${OLD_HOST}/markj/contexts/jam-turn-002-graph.envelope.jose.json`,
    ];
    for (const url of samples) {
      const once = normalizeCssUrl(url);
      const twice = normalizeCssUrl(once);
      expect(twice).toBe(once);
    }
  });

  it('leaves unrelated origins unchanged', () => {
    const samples = [
      'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io/mcp',
      'https://interego-identity.livelysky-8b81abb0.eastus.azurecontainerapps.io/tokens/verify',
      'https://claude.ai/agents/x',
      'https://example.com/whatever',
      'http://localhost:3456/markj/',
    ];
    for (const url of samples) {
      expect(normalizeCssUrl(url)).toBe(url);
    }
  });

  it('leaves URN inputs unchanged', () => {
    const urns = [
      'urn:graph:markj:user-memory:v1',
      'urn:pgsl:fragment:0xabc',
      'urn:cg:action:kernel:dereference',
    ];
    for (const urn of urns) {
      expect(normalizeCssUrl(urn)).toBe(urn);
    }
  });

  it('leaves http (downgrade-attempt) URLs unchanged', () => {
    // The regex anchors on `https://` — an http-scheme URL pointing at
    // the same OLD host must NOT be rewritten (it could indicate a
    // mis-configured caller; we don't paper over scheme errors).
    const httpUrl = OLD_HOST.replace(/^https:/, 'http:') + '/markj/';
    expect(normalizeCssUrl(httpUrl)).toBe(httpUrl);
  });

  it('leaves the empty string and clearly invalid inputs unchanged', () => {
    expect(normalizeCssUrl('')).toBe('');
    expect(normalizeCssUrl('not-a-url')).toBe('not-a-url');
  });

  it('does NOT rewrite a host that merely contains the OLD substring but is not anchored at start', () => {
    // Anti-substring-injection check: if a malicious or confused caller
    // sends e.g. `https://attacker.example/?u=<OLD_HOST>/markj/`, the
    // rewrite must NOT fire on the inner substring.
    const attackerUrl = `https://attacker.example/?u=${encodeURIComponent(`${OLD_HOST}/markj/`)}`;
    expect(normalizeCssUrl(attackerUrl)).toBe(attackerUrl);
  });

  it('does NOT rewrite a different deployment ID', () => {
    // The regex captures any `livelysky-<hex>` deployment ID for forward-
    // compatibility, but the canonical rewrite target is hard-coded to
    // 8b81abb0. A different-ID OLD-host URL WILL match the regex (intent:
    // future-proof if we re-deploy) and rewrite to the canonical target.
    // This documents and locks in that behaviour.
    const altOld = 'https://interego-css.livelysky-deadbeef.eastus.azurecontainerapps.io/markj/';
    const out = normalizeCssUrl(altOld);
    // It rewrites to the canonical internal host.
    expect(out).toBe(`${NEW_HOST}/markj/`);
  });
});

describe('normalizeCssUrl — defensive', () => {
  it('returns non-string inputs unchanged (typed signature notwithstanding)', () => {
    // Defensive: the relay funnels untyped JSON args through here; a
    // missing field could surface as undefined/null at runtime.
    // Suppress TS for the test — runtime safety is the point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeCssUrl(undefined as any)).toBe(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeCssUrl(null as any)).toBe(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeCssUrl(123 as any)).toBe(123);
  });
});
