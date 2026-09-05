/**
 * Auto-deploy's scope: which services does a commit actually need shipped to?
 *
 * ── ★★ WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────
 *
 * Deploying used to be manual here, and `deploy-railway.yml`'s header says why: "Building is safe
 * and repeatable; deploying is neither." The cost was measured twice in two days — sixteen
 * services 65 commits behind on 2026-08-27, and nine behind again on 2026-09-04 with seven of them
 * genuinely shipping changed code. The maintainer chose auto-deploy, and the whole question then
 * becomes WHAT to deploy: most merges touch `tools/`, `tests/` and `.github/`, which no image
 * bundles, and deploying seventeen services for those is seventeen rollouts risked for nothing.
 *
 * `tools/deploy-affected.ts` answers it by asking the question `deploy-bundle-scope.ts` was written
 * to establish — "would master build this service a DIFFERENT image than the one it runs" — against
 * each service's LIVE pin.
 *
 * ── WHAT EACH LEG PINS, AND WHY IT COULD GO WRONG SILENTLY ───────────────────────────────────
 *
 * A scope tool has two failure modes and only one of them is loud. Deploying too much is visible
 * and merely wasteful. Deploying too LITTLE looks exactly like "nothing needed deploying" — which
 * is the state this repository was already in — so the legs below are weighted towards proving it
 * cannot silently return an empty set: the undetermined case, the upstream case, and a real
 * drifted pin taken from this repository's own history.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { affectedServices, imageFor } from '../tools/deploy-affected.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * A commit from this session that changed `packages/core`, `deploy/mcp-relay` and two verticals —
 * so a service pinned to it is genuinely stale in a way every bundle scope can see.
 *
 * Read from git rather than hard-coded as a string that might not exist in a shallow clone: if it
 * is unreachable the legs using it are skipped loudly rather than asserting about nothing.
 */
const STALE = '229a3ec6b30516d5a65d3b9a8a643d1da9474915';
const staleIsReachable = (() => {
  try {
    execFileSync('git', ['cat-file', '-e', `${STALE}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
})();

describe('the image a service runs is asked, never derived', () => {
  it('maps css to interego-css-pgsl, which no derivation would produce', () => {
    // `interego-${service}` is right for sixteen rows and wrong for exactly this one.
    expect(imageFor('css')).toBe('interego-css-pgsl');
    expect(imageFor('relay')).toBe('interego-relay');
  });

  it('★ returns null for an upstream image this repository does not build', () => {
    // postgres and redis must never be repointed at a commit sha. Returning a plausible-looking
    // name here would put them in a deploy matrix and pin production Postgres to an image that
    // does not exist.
    expect(imageFor('postgres')).toBeNull();
    expect(imageFor('redis')).toBeNull();
  });

  it('returns null for a service that is not in the tracked table at all', () => {
    expect(imageFor('not-a-service')).toBeNull();
  });
});

describe('scope: a service running HEAD is not redeployed', () => {
  it('skips every service already on this commit', () => {
    const { affected, skipped } = affectedServices(
      [{ service: 'relay', tag: HEAD }, { service: 'agp-bridge', tag: HEAD }], 'HEAD', ROOT);
    expect(affected).toEqual([]);
    expect(skipped.join(' ')).toContain('already running this commit');
  });
});

describe('scope: an upstream image is never a deploy target', () => {
  it('★ skips postgres and redis whatever their tag looks like', () => {
    const { affected, skipped } = affectedServices(
      [{ service: 'postgres', tag: '16' }, { service: 'redis', tag: '7-alpine' }], 'HEAD', ROOT);
    expect(affected, 'an upstream image was put in the deploy matrix').toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('★ skips one even if its tag were a 40-hex sha, because the TABLE decides', () => {
    // The tag shape is a hint; `repo: null` is the fact. A service this repo does not build must
    // be excluded by identity, not by how its current tag happens to be spelled.
    const { affected } = affectedServices(
      [{ service: 'postgres', tag: HEAD.replace(/.$/, '0') }], 'HEAD', ROOT);
    expect(affected).toEqual([]);
  });
});

describe('scope: a genuinely stale pin IS deployed', () => {
  it.skipIf(!staleIsReachable)('★ reports drift for a service pinned to an older commit', () => {
    const { affected } = affectedServices([{ service: 'relay', tag: STALE }], 'HEAD', ROOT);
    expect(
      affected.map((a) => a.service),
      'a relay pinned to a commit that changed packages/core and deploy/mcp-relay was reported '
        + 'as needing nothing — the scope has stopped seeing drift, which looks identical to a '
        + 'clean fleet',
    ).toEqual(['relay']);
    expect(affected[0]?.image).toBe('interego-relay');
    expect(affected[0]?.pin).toBe(STALE);
    expect(affected[0]?.reason).toMatch(/shipped file\(s\) changed/);
  });

  it.skipIf(!staleIsReachable)('names the changed files in the reason, so the log explains itself', () => {
    const { affected } = affectedServices([{ service: 'relay', tag: STALE }], 'HEAD', ROOT);
    expect(affected[0]?.reason).toMatch(/e\.g\. \S+/);
  });
});

describe('scope: what cannot be determined is DEPLOYED, not skipped', () => {
  it('★ includes a service whose bundle scope cannot be read', () => {
    // The tempting reading — "we could not tell, so leave it alone" — makes every unparseable
    // Dockerfile a deploy hole with no symptom. `bundleDriftFor` reports `confident: false` for a
    // pin that is not a commit it can diff, which is the reachable form of that case here.
    const notACommit = 'f'.repeat(40);
    const { affected, skipped } = affectedServices(
      [{ service: 'relay', tag: notACommit }], 'HEAD', ROOT);
    expect(
      affected.length + skipped.length,
      'the service vanished from both lists — a scope that drops a service silently is worse '
        + 'than one that gets it wrong',
    ).toBe(1);
    if (affected.length === 1) {
      expect(affected[0]?.reason).toMatch(/could not be determined|shipped file/);
    }
  });
});
