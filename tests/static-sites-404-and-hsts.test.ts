/**
 * Every nginx-served site must 404 a missing asset, and every public surface must send
 * HSTS and be able to say which build it is.
 *
 * ★ WHY THE 404 HALF. Measured live before that fix:
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
 * ★ WHY THE HSTS HALF WAS REWRITTEN, AND THIS IS THE LOAD-BEARING PART. The describe below
 * is titled "every public surface" and used to assert against FOUR hard-coded paths:
 * deploy/nginx-spa.conf plus three named Node servers. That list was written to match the
 * commit that made the fix, not derived from the fleet. Measured live 2026-08-03, SIX
 * further public surfaces served no Strict-Transport-Security and were invisible here
 * because they were simply not in the list — dashboard, pgsl-browser, bridge, foxxi-bridge,
 * validator, and acme-id. A hand-maintained list CANNOT fail for the surface it omits, so
 * adding six more `it()` blocks would have repeated the mistake in its own shape. The
 * inventory is now derived: nginx images off disk, and every built image checked in BOTH
 * directions against .github/workflows/build-ghcr.yml's matrix — the one place a deployed
 * service must be registered or it is never built at all.
 *
 * ★ AND THE HSTS ASSERTION IS NO LONGER "the string appears in the file". Two things decide
 * whether the header actually ships and neither is visible to a grep:
 *   (a) FOR NGINX, add_header DOES NOT INHERIT — a location declaring any add_header of its
 *       own discards the enclosing scope's entire set. acme-id declared four such blocks
 *       and served no HSTS anywhere; foxxi-scorm-player's `location /course/` lost it while
 *       its `/` kept it. A whole-file grep passes both.
 *   (b) FOR EXPRESS, POSITION. Registered after express.json(), the middleware is skipped on
 *       exactly the path that matters: body-parser throws on a malformed body and express
 *       jumps straight to the error handler. Measured live — identity, the host that mints
 *       bearer tokens, answered `POST / {not json` with 400 and NO header, while the relay
 *       (which registers HSTS before its parser) answered 400 WITH it. identity passed the
 *       old string-in-file assertion the whole time.
 *
 * ★ WHY A STATIC TEST AT ALL. nginx behaviour cannot be exercised without running the
 * container. This asserts on config TEXT, which is weaker but real. The complementary half
 * is `RUN nginx -t` in each image, which turns a syntax error into a failed build rather
 * than a crash-looping service. Said plainly: nothing here proves a container emits a
 * header — it proves both halves of each mechanism are present.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICES } from '../tools/railway-services.mjs';

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

/** The build matrix: the one place a deployed image must be registered or it is never built. */
const BUILD_MATRIX = '.github/workflows/build-ghcr.yml';

/**
 * The `location { … }` blocks of an nginx config, comment lines removed FIRST.
 *
 * ★ Stripping comments is not tidiness, it is the assertion working at all. The bare word
 * "location" appears in the PROSE of both deploy/nginx-spa.conf ("If a location defines any
 * add_header of its own…") and of the inline configs, and `location[^{]*\{[^}]*\}` starts a
 * match there and runs on to the NEXT block's braces. Measured before this change: the
 * first "block" returned for nginx-spa.conf was comment text, and `location ^~ /assets/`
 * was therefore never scored on its own — it was passing on a neighbouring block's header,
 * so losing HSTS there would have read as green.
 */
const locationBlocks = (conf: string): string[] =>
  conf
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .match(/location[^{]*\{[^}]*\}/g) ?? [];

/** Read `- { image: X, dockerfile: Y }` out of the build matrix. */
function builtImages(): { image: string; dockerfile: string }[] {
  const re = /^\s*- \{\s*image:\s*([a-z0-9-]+),\s*dockerfile:\s*([^\s,}]+)/gm;
  return [...read(BUILD_MATRIX).matchAll(re)].map((m) => ({ image: m[1]!, dockerfile: m[2]! }));
}

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

describe('HSTS is served by every nginx image, in EVERY location block', () => {
  it('NGINX_IMAGES names every image whose runtime is nginx', () => {
    // ★ Everything below is only as strong as this list, and the failure it stops has a
    // mirror image: a NEW nginx image nobody adds here would be silently exempt forever —
    // exactly as acme-id was exempt WHILE BEING LISTED, because the assertion below it read
    // a config file rather than the image. Derive the list from the directory.
    const runtimeIsNginx = readdirSync(join(REPO, 'deploy'))
      .filter((f) => f.startsWith('Dockerfile.'))
      .map((p) => `deploy/${p}`)
      .filter((p) => /^FROM\s+\S*nginx[:@]/m.test(read(p)))
      .sort();
    expect(runtimeIsNginx).toEqual([...NGINX_IMAGES].sort());
  });

  for (const df of NGINX_IMAGES) {
    it(`${df} sends HSTS from EVERY location block`, () => {
      // ★ Per IMAGE, not per config file. This used to read SHARED_CONF plus three Node
      // servers and nothing else, so the four images that COPY the shared file were covered
      // twice while the two that inline their own server block into a `RUN printf` —
      // foxxi-scorm-player and acme-id — were covered by nothing. Those two are the ONLY
      // ones whose HSTS can regress independently. acme-id consequently served did:web
      // documents, which other services dereference as identity assertions, with no HSTS at
      // all, measured live, while this file reported 20/20 green.
      const src = read(df);
      // ★ A COPY LINE, NOT `src.includes(SHARED_CONF)`. Substring-matching the path is how
      // this assertion silently read the WRONG FILE: a prose comment inside
      // Dockerfile.acme-id explaining that the shared config is where the HSTS fix landed
      // contains the string `deploy/nginx-spa.conf`, so the image that inlines its own
      // server block was scored against the shared file instead — and a mutant deleting
      // HSTS from acme-id's did.json block passed. Only an actual COPY puts the shared
      // config in the image.
      const usesShared = /^COPY\s+\S*nginx-spa\.conf/m.test(src);
      const conf = usesShared ? read(SHARED_CONF) : src;
      const blocks = locationBlocks(conf);
      expect(blocks.length, `${df}: no location blocks parsed — extractor broken`).toBeGreaterThan(2);
      for (const block of blocks) {
        expect(block, `${df}: match started inside a comment:\n${block}`).toMatch(/^location\s+[=~^/@]/);
        // `always` is load-bearing: without it add_header skips 4xx/5xx, so the 404 that
        // `try_files … =404` exists to produce would ship with no HSTS.
        expect(
          block,
          `${df}: a location block lacks HSTS — add_header does not inherit:\n${block}`,
        ).toMatch(/add_header\s+Strict-Transport-Security\s+"max-age=\d+"\s+always;/);
      }
    });
  }
});

/**
 * ★ THE INVENTORY IS DERIVED, NOT TYPED OUT.
 *
 * The map below still names, per image, the file that decides whether its responses carry
 * HSTS — that pairing genuinely cannot be derived. What IS derived is the set of images
 * that must appear in it, read out of the build matrix and checked in BOTH directions. So
 * a new deployed service cannot be silently exempt (the matrix has it, this map does not →
 * red), and a deleted one cannot linger as a comforting entry nothing builds (→ red).
 */
const NOT_PUBLIC = Symbol('not a public HTTPS surface');

const HSTS_SOURCE: Record<string, string | typeof NOT_PUBLIC> = {
  'interego-relay': 'deploy/mcp-relay/server.ts',
  'interego-identity': 'deploy/identity/server.ts',
  'interego-css-gate': 'deploy/css-gate/server.mjs',
  'interego-dashboard': 'examples/dashboard/server.ts',
  'interego-pgsl-browser': 'examples/pgsl-browser/server.ts',
  'interego-bridge': 'demos/interego-bridge/server.ts',
  // Seven vertical bridges share this factory; foxxi-bridge is the deployed one, so fixing
  // it in the vertical would have fixed one of seven.
  'interego-foxxi-bridge': 'applications/_shared/vertical-bridge/index.ts',
  // The eighth, and the second to be DEPLOYED — the runtime a shared-workspace member that
  // is an agent runs in. Same factory, same header, and it is named here rather than
  // inheriting the row above because this table is keyed by IMAGE: an image that shares a
  // source file still has to be listed, which is exactly the check that caught it.
  'interego-wsp-bridge': 'applications/_shared/vertical-bridge/index.ts',
  'interego-microsite': SHARED_CONF,
  'interego-main': SHARED_CONF,
  'interego-foxxi-dashboard': SHARED_CONF,
  'interego-foxxi-microsite': SHARED_CONF,
  // These two write their own inline nginx config rather than using the shared one, which
  // is precisely why the old file-keyed assertion could not see them.
  'interego-acme-id': 'deploy/Dockerfile.acme-id',
  'interego-foxxi-scorm-player': 'deploy/Dockerfile.foxxi-scorm-player',
  // css is reached only over Railway private networking, and from outside only through
  // css-gate, which sends HSTS. It also 500s on any Host other than css.railway.internal,
  // so it has no public surface to protect.
  'interego-css-pgsl': NOT_PUBLIC,
  // The Discord bot is a WORKER: it dials out to the Discord gateway and the relay and binds
  // no inbound port, so it has no public HTTPS surface to send HSTS from. See
  // deploy/Dockerfile.discord and tools/railway-services.mjs (health: null).
  'interego-discord': NOT_PUBLIC,
};

describe('HSTS is served by every public surface', () => {
  it('the build matrix is readable and non-trivial', () => {
    // A reflowed matrix leg would silently shrink the derived list and every assertion
    // below would vacuously pass. This is the floor that catches that.
    expect(builtImages().length).toBeGreaterThan(10);
  });

  it('every built image is accounted for here', () => {
    expect(
      builtImages().map((b) => b.image).filter((i) => !(i in HSTS_SOURCE)),
      'a new deployed image must name the file that gives it HSTS, or be marked NOT_PUBLIC with a reason',
    ).toEqual([]);
  });

  it('nothing is listed here that the matrix no longer builds', () => {
    const built = new Set(builtImages().map((b) => b.image));
    expect(Object.keys(HSTS_SOURCE).filter((i) => !built.has(i))).toEqual([]);
  });

  for (const [image, source] of Object.entries(HSTS_SOURCE)) {
    if (source === NOT_PUBLIC) continue;
    it(`${image} sends HSTS (${source})`, () => {
      // ★ AN ACTUAL HEADER-SETTING CALL, not the mere presence of the string. A bare
      // /Strict-Transport-Security/ is satisfied by a COMMENT — including the comments this
      // very change added explaining why the header is there. Measured: deleting the
      // `res.setHeader(...)` line from examples/dashboard/server.ts left the surrounding
      // rationale comment behind and the assertion stayed green, so the mutant survived and
      // the surface would have shipped with no HSTS and a paragraph about how it has some.
      expect(
        read(source),
        `${image} is deployed as a public origin and its surface never SETS ` +
          'Strict-Transport-Security (a comment mentioning it is not the header)',
      ).toMatch(/(setHeader\(\s*'Strict-Transport-Security'|add_header\s+Strict-Transport-Security)/);
    });
  }

  it('every express surface registers HSTS BEFORE its body parser', () => {
    // ★ THE ASSERTION A STRING GREP CANNOT MAKE, AND IT WAS WRONG IN IDENTITY.
    // Measured against real express: with express.json() registered first, a malformed body
    // makes body-parser throw, express jumps to the error handler, and every middleware
    // after the parser is skipped — the 400 ships with no header. Confirmed live before the
    // fix: POST https://identity.interego.xwisee.com/ with `{ not json` returned 400 and no
    // HSTS, while the relay returned 400 WITH it. A smoke test never sees this, because a
    // smoke test always sends valid JSON.
    const EXPRESS_SURFACES = [
      'deploy/mcp-relay/server.ts',
      'deploy/identity/server.ts',
      'examples/pgsl-browser/server.ts',
      'demos/interego-bridge/server.ts',
      'applications/_shared/vertical-bridge/index.ts',
      'deploy/validator/server.ts',
    ] as const;
    for (const p of EXPRESS_SURFACES) {
      const src = read(p);
      const hsts = src.indexOf("res.setHeader('Strict-Transport-Security'");
      const parser = src.indexOf('use(express.json(');
      expect(hsts, `${p}: no HSTS setHeader found`).toBeGreaterThan(-1);
      expect(parser, `${p}: no express.json() found`).toBeGreaterThan(-1);
      expect(
        hsts,
        `${p} registers express.json() before HSTS — a malformed-body 400 ships without the header`,
      ).toBeLessThan(parser);
    }
  });

  it('nobody has quietly added includeSubDomains or preload', () => {
    // Both are deliberate, separate decisions with blast radius: includeSubDomains binds
    // every *.interego.xwisee.com including any not fully on HTTPS, and preload is close
    // to irreversible. If this ever fails, it should be because someone chose it.
    //
    // Scoped to the DERIVED set, not to the three files it used to read — the same
    // omission, in the same shape, one assertion further down.
    //
    // ★ PER LINE, not `Strict-Transport-Security[^;\n]*(includeSubDomains|preload)`. That
    // form only ever worked for nginx (`add_header Strict-Transport-Security
    // "max-age=…; includeSubDomains"` — no semicolon before the directive). In the JS form
    // the value is a separate argument, `setHeader('Strict-Transport-Security',
    // 'max-age=31536000; includeSubDomains')`, and the `;` inside the value stops `[^;\n]*`
    // dead. Measured: adding includeSubDomains to examples/pgsl-browser/server.ts left this
    // guard green, so it was watching only the four nginx-shaped files it was born with.
    for (const source of Object.values(HSTS_SOURCE)) {
      if (source === NOT_PUBLIC) continue;
      const offending = read(source)
        .split('\n')
        .filter((l) => /Strict-Transport-Security/.test(l) && /includeSubDomains|preload/.test(l));
      expect(offending, `${source} asserts includeSubDomains or preload`).toEqual([]);
    }
  });
});

/**
 * A deploy nobody can confirm is a deploy that does not get made.
 *
 * tools/railway-redeploy.mjs polls a service's health URL until `j.build` equals the sha it
 * just deployed, because Railway calls a deploy SUCCESS as soon as the container binds a
 * port and — on a tag that does not exist in the registry — leaves the PREVIOUS container
 * serving and answering 200. build-ghcr.yml has ALWAYS appended `GIT_SHA=${{ github.sha }}`
 * to every matrix leg; only Dockerfile.relay declared a matching ARG, so thirteen images
 * were handed their own commit sha at build time and dropped it on the floor — an
 * unconsumed build-arg is a warning, never an error, so every one of them built green.
 *
 * The observable cost: the dashboard carried the oldest pin in the fleet for 22 days
 * because it was the one public Node service whose rollout could not be proven.
 */
describe('every built image can say which commit it is', () => {
  /**
   * An image must consume GIT_SHA iff a tracked Railway service running it has a health
   * path to report the sha FROM. Derived from tools/railway-services.mjs rather than
   * exempted by name here, so the exemption cannot outlive its reason.
   *
   * Today that excludes exactly one image, `interego-css-pgsl`: css has `health: null`
   * because Railway reports no domain for it and it 500s on any Host other than
   * css.railway.internal:3456, so there is nowhere for a build sha to be read from. Give
   * css a health path and this loop starts demanding the ARG on the next run.
   */
  const reportsItsBuild = new Set(
    Object.values(SERVICES).filter((s) => s.repo && s.health).map((s) => s.repo as string),
  );

  for (const { image, dockerfile } of builtImages()) {
    if (!reportsItsBuild.has(image)) continue;
    it(`${dockerfile} consumes the GIT_SHA build-arg (${image})`, () => {
      expect(
        read(dockerfile),
        `${dockerfile} discards the GIT_SHA build-arg that build-ghcr.yml already passes it; ` +
          'Docker treats an unconsumed build-arg as a warning, so the image builds green',
      ).toMatch(/^ARG GIT_SHA=unset$/m);
    });
  }

  for (const [image, source] of Object.entries(HSTS_SOURCE)) {
    if (source === NOT_PUBLIC) continue;
    // The nginx images carry the sha in a served document, not in an env var a served
    // response can read, so they are asserted through their own config below instead.
    if (source === SHARED_CONF || source.startsWith('deploy/Dockerfile.')) continue;
    it(`${image} surfaces the baked sha at its health path (${source})`, () => {
      expect(read(source), `${source} bakes a sha it never surfaces`).toMatch(/INTEREGO_BUILD_SHA/);
    });
  }

  it('the shared nginx config serves a build sha, substituted at image build time', () => {
    const conf = read(SHARED_CONF);
    const block = /location\s+=\s+\/health\s*\{[^}]*\}/.exec(conf)?.[0];
    expect(block, 'no exact-match `location = /health`: /health falls through to the SPA shell').toBeTruthy();
    // ★ The contract is JSON-carrying-a-sha and NOT merely status 200. Under an SPA
    // fallback, 200 is a property of the fallback rather than of the service: every
    // extensionless path answered 200 with the shell, measured live and byte-identical to
    // `/`. Only a document the shell cannot impersonate makes the check falsifiable.
    expect(block!).toMatch(/__BUILD_SHA__/);
  });

  for (const df of ['deploy/Dockerfile.acme-id', 'deploy/Dockerfile.foxxi-scorm-player'] as const) {
    it(`${df} bakes a health document gated on the site tree existing`, () => {
      const src = read(df);
      // A file, not a `return 200` literal: a literal answers 200 with an EMPTY docroot,
      // which is the same unfalsifiable check as the SPA fallback it replaces.
      expect(src, 'no exact-match `location = /health`').toMatch(/location = \/health \{/);
      expect(src, '/health must be backed by a file so it 404s when the image lacks it').toMatch(
        /try_files \/health\.json =404;/,
      );
      expect(src, 'without `test -f index.html` an empty build ships an image whose /health says ok').toMatch(
        /test -f \/usr\/share\/nginx\/html\/index\.html/,
      );
      expect(src, 'the document must land where `location = /health` looks for it').toMatch(
        /> \/usr\/share\/nginx\/html\/health\.json/,
      );
      expect(src, 'no build sha means --verify-url can never tell the new container from the old').toMatch(
        /"build":"%s"/,
      );
    });
  }
});
