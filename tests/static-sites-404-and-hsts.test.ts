/**
 * Every nginx-served site must 404 a missing asset, and must send HSTS.
 *
 * ★ WHY. Measured live before the fix:
 *
 *     GET https://interego.xwisee.com/definitely-not-a-real-asset.js  ->  200 text/html
 *
 * `try_files $uri $uri/ /index.html` is the standard SPA fallback, and applied to every
 * path it hands out the HTML shell for missing files with a 200. That is not cosmetic: a
 * broken deploy looks healthy to a browser and to any uptime check reading only the status
 * code, a bad `import` receives HTML and fails as `Unexpected token '<'` far from its
 * cause, and caches store the wrong body under the asset's URL. Five of six nginx images
 * had it — the config had been copy-pasted, so the bug had been copy-pasted.
 *
 * ★ WHY A STATIC TEST. The behaviour lives in nginx config, which cannot be exercised
 * without running the container. This asserts on the config text instead, which is weaker
 * but real: it fails if someone reintroduces a bare SPA fallback or drops HSTS. The
 * complementary half is `RUN nginx -t` in each image, which turns a syntax error into a
 * failed build rather than a crash-looping service.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');

/** Every Dockerfile whose runtime stage is nginx. */
const NGINX_IMAGES = [
  'deploy/Dockerfile.interego-main',
  'deploy/Dockerfile.interego-microsite',
  'deploy/Dockerfile.foxxi-dashboard',
  'deploy/Dockerfile.foxxi-microsite',
  'deploy/Dockerfile.foxxi-scorm-player',
  'deploy/Dockerfile.acme-id',
] as const;

/** The four that share one real config file rather than an escaped printf. */
const SHARED_CONF = 'deploy/nginx-spa.conf';

describe('nginx images are validated at build time', () => {
  for (const df of NGINX_IMAGES) {
    it(`${df} runs nginx -t during the build`, () => {
      expect(existsSync(join(REPO, df)), `${df} is missing`).toBe(true);
      expect(
        /^RUN nginx -t$/m.test(read(df)),
        'without `RUN nginx -t` a config error builds green and crash-loops on deploy',
      ).toBe(true);
    });
  }
});

describe('a missing asset must 404, never fall back to the SPA shell', () => {
  it('the shared config 404s asset-like paths', () => {
    const conf = read(SHARED_CONF);
    expect(conf).toMatch(/try_files\s+\$uri\s+=404;/);
    // The regex location is what distinguishes an asset from a History-API route.
    expect(conf).toMatch(/location\s+~\*\s+\\\.\(\?:js\|/);
  });

  it('the shared config STILL serves the shell for extensionless deep links', () => {
    // Over-correcting is the other failure: 404ing /substrate would break the site.
    expect(read(SHARED_CONF)).toMatch(/try_files\s+\$uri\s+\$uri\/\s+\/index\.html;/);
  });

  it('/assets/ keeps immutable caching and is not stolen by the regex block', () => {
    // nginx tries `^~` prefixes before regexes. Without `^~`, /assets/app.js would match
    // the regex location and silently lose `Cache-Control: immutable`.
    expect(read(SHARED_CONF)).toMatch(/location\s+\^~\s+\/assets\//);
  });

  for (const df of NGINX_IMAGES) {
    it(`${df} has no unguarded SPA fallback`, () => {
      const src = read(df);
      const fallsBack = /try_files[^;]*\/index\.html/.test(src) || src.includes(SHARED_CONF.split('/').pop()!);
      if (!fallsBack) return; // not an SPA (acme-id serves files directly)
      const guards = src.includes('nginx-spa.conf') || /try_files\s+\$uri\s+=404;/.test(src);
      expect(guards, `${df} falls back to index.html with no =404 rule for assets`).toBe(true);
    });
  }
});

describe('HSTS is served by every public surface', () => {
  it('the shared nginx config sets it in EVERY location block', () => {
    const conf = read(SHARED_CONF);
    // ★ add_header does not inherit: a location defining any add_header discards the
    // enclosing scope's. Declaring HSTS once on the server would silently omit it from
    // exactly the blocks that set Cache-Control.
    const locations = conf.match(/location[^{]*\{[^}]*\}/g) ?? [];
    expect(locations.length).toBeGreaterThan(2);
    for (const block of locations) {
      expect(
        block,
        `a location block lacks HSTS — add_header does not inherit:\n${block}`,
      ).toMatch(/Strict-Transport-Security/);
    }
  });

  it('the relay sets it', () => {
    expect(read('deploy/mcp-relay/server.ts')).toMatch(
      /setHeader\('Strict-Transport-Security', 'max-age=\d+'\)/,
    );
  });

  it('the css gate sets it', () => {
    expect(read('deploy/css-gate/server.mjs')).toMatch(/Strict-Transport-Security/);
  });

  it('identity still sets it', () => {
    expect(read('deploy/identity/server.ts')).toMatch(/Strict-Transport-Security/);
  });

  it('nobody has quietly added includeSubDomains or preload', () => {
    // Both are deliberate, separate decisions with blast radius: includeSubDomains binds
    // every *.interego.xwisee.com including any not fully on HTTPS, and preload is close
    // to irreversible. If this ever fails, it should be because someone chose it.
    for (const p of [SHARED_CONF, 'deploy/mcp-relay/server.ts', 'deploy/css-gate/server.mjs']) {
      expect(read(p)).not.toMatch(/Strict-Transport-Security[^;\n]*(includeSubDomains|preload)/);
    }
  });
});
