/**
 * The css image runs nodemailer 10 under a Community Solid Server whose own range is ^9, and
 * that is safe for one reason this file pins: the deployed config never sends mail.
 *
 * ★ WHY AN OVERRIDE AND NOT AN UPGRADE. npm audit reports nine advisories against nodemailer
 * 9.1.1. The two HIGH ones (quadratic denial of service in addressparser) are fixed in 10.0.6.
 * The seven moderate ones (DKIM header unfolding, malformed envelope recipients, a TLS
 * servername reused across transports, nested recipient arrays, and addressparser releasing
 * comment, group or angle-addr text as a recipient) are fixed between 10.0.2 and 10.1.4, so
 * 10.1.4 is the first release that clears all nine. @solid/community-server 7.2.0, the newest
 * stable release, asks for ^9.0.1, which tops out at 9.1.1; the 8.0.0 alphas ask for even
 * older majors, move to Components.js 6 (the accessor builds against 5) and, from alpha.1,
 * need Node 22 (the image runs 20). No CSS release admits a fixed nodemailer, so
 * integrations/pgsl-css-accessor/package.json overrides it.
 *
 * ★ WHY 10.x UNDER CSS 7 IS SAFE HERE. CSS calls nodemailer from one class, BaseEmailSender,
 * through createTransport(options) and transporter.sendMail({ from, to, subject, text, html }).
 * 10.0.0's only breaking change is the Node >= 20 floor. Driving CSS's own BaseEmailSender
 * with nodemailer 9.1.1 and 10.2.1 produced the same envelope and headers. And the deployed
 * configs never build a BaseEmailSender at all: both import css:config/identity/email/default.json,
 * which binds the EmailSender to an UnsupportedAsyncHandler. A password-reset request against
 * the booted image logs "Problem sending a recovery mail: No email server is configured." with
 * either nodemailer, and nothing reaches the library. If a config ever wires a real
 * mail sender, that is the moment to re-check this override, which is why the import is
 * asserted below rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

/** The first nodemailer release that clears every advisory npm audit reports against it. */
const FIRST_FIXED = [10, 1, 4] as const;

const parse = (v: string): number[] => v.replace(/^[\^~>=\s]+/, '').split('.').map((n) => Number.parseInt(n, 10));
const atLeast = (v: string, floor: readonly number[]): boolean => {
  const got = parse(v);
  for (const [i, want] of floor.entries()) {
    const have = got[i] ?? 0;
    if (have !== want) return have > want;
  }
  return true;
};

const ACCESSOR = 'integrations/pgsl-css-accessor';

describe('the css image carries a patched nodemailer', () => {
  const pkg = json(`${ACCESSOR}/package.json`) as { overrides?: Record<string, string> };
  const lock = json(`${ACCESSOR}/package-lock.json`) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };

  it('overrides nodemailer to a range whose floor is already fixed', () => {
    const range = pkg.overrides?.nodemailer;
    expect(range, 'package.json must keep the nodemailer override').toBeDefined();
    expect(atLeast(range!, FIRST_FIXED), `override ${range} admits a vulnerable nodemailer`).toBe(true);
  });

  it('the lockfile the image installs with `npm ci` resolves that fixed nodemailer', () => {
    const v = lock.packages['node_modules/nodemailer']?.version;
    expect(v).toBeDefined();
    expect(atLeast(v!, FIRST_FIXED), `lockfile resolves nodemailer ${v}`).toBe(true);
  });

  it('the override is still needed: CSS itself still asks for nodemailer 9', () => {
    // When this fails, CSS has started asking for a nodemailer of its own that may already be
    // fixed. Check whether its range starts at or above 10.1.4; if it does, drop the override
    // and let CSS's range decide again.
    const own = lock.packages['node_modules/@solid/community-server']?.dependencies?.nodemailer;
    expect(own).toBe('^9.0.1');
  });
});

describe('the deployed css config never sends mail', () => {
  // docker-entrypoint.sh picks exactly one of these two, on whether REDIS_ADDR is set.
  const CONFIGS = [`${ACCESSOR}/config/pgsl-server.json`, `${ACCESSOR}/config/pgsl-server-redis.json`];

  it('the entrypoint boots only these configs', () => {
    const entry = read(`${ACCESSOR}/docker-entrypoint.sh`);
    const chosen = [...entry.matchAll(/^\s*CONFIG=(config\/[^\s]+)$/gm)].map((m) => `${ACCESSOR}/${m[1]}`);
    expect(chosen.sort()).toEqual([...CONFIGS].sort());
  });

  for (const path of CONFIGS) {
    it(`${path.split('/').pop()} binds the e-mail sender to the unsupported handler`, () => {
      const cfg = json(path) as { import: string[] };
      const text = read(path);
      expect(cfg.import).toContain('css:config/identity/email/default.json');
      expect(cfg.import.filter((i) => i.startsWith('css:config/identity/email/'))).toEqual([
        'css:config/identity/email/default.json',
      ]);
      // Nothing in the file redefines the sender or builds the nodemailer-backed one.
      expect(text).not.toMatch(/BaseEmailSender/);
      expect(text).not.toMatch(/urn:solid-server:default:EmailSender/);
    });
  }
});

describe('the dashboard image does not install the Solid server', () => {
  // The dashboard once spawned its own CSS. It now only fetches from CSS_URL over HTTP, but
  // its package.json still listed @solid/community-server, so the image installed CSS 7's
  // whole dependency tree, nodemailer 9 included, and never loaded any of it.
  it('examples/dashboard/package.json does not depend on it', () => {
    const pkg = json('examples/dashboard/package.json') as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@solid/community-server');
  });

  it('and no dashboard source imports it', () => {
    for (const f of ['examples/dashboard/server.ts', 'examples/dashboard/polling-demand.ts']) {
      expect(read(f)).not.toMatch(/@solid\/community-server/);
    }
  });
});
