/**
 * A change to `deploy/images.json` marks a service stale only when THAT service's row moved.
 *
 * ── WHY, AND WHY THE FIRST FIX WAS WRONG ─────────────────────────────────────
 *
 * Registering one new image marked ALL SIXTEEN existing services BEHIND, each citing this
 * one file, because every service's bundle scope includes it and the audit diffs the files a
 * service ships. Acting on that reading meant sixteen rebuilds and redeploys for a row that
 * belonged to none of them.
 *
 * ★ THE FIRST ATTEMPT EXCLUDED THE FILE WHOLESALE, on the grounds that nothing which RUNS
 * ever opens it. That is true and it is the wrong reason. `deploy/images.json` decides WHICH
 * DOCKERFILE BUILDS AN IMAGE and whether its leg carries a prebuild — it is a recipe input,
 * deliberately in scope, and excluding it would have re-opened the exact miss it was added to
 * catch: an image repointed at a different Dockerfile passing as `equivalent`. The right unit
 * is the ROW, not the file.
 *
 * ★ AND THE ORACLE TEST IS WHAT CAUGHT IT. `the derived css scope agrees with a hand-written
 * oracle over 120 real merges` went red on exactly one commit — the one that added the agp
 * row — with `derived=true oracle=false`. css's Dockerfile copies pgsl-store and the accessor
 * and nothing else, so the hand-written list was right that css does not SHIP this file; the
 * derivation counts it because it shapes the build. Two true statements that look like a
 * contradiction until the unit is fixed.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDriftFor } from '../tools/deploy-bundle-scope.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The commit that registered `interego-agp-bridge` — one new row, nobody else's changed. */
const ADDED_A_ROW = '6ec15abfb6fd7512433920155bd2400fe7ff0912';

function has(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

describe('deploy/images.json is judged per row, not per file', () => {
  it.runIf(has(ADDED_A_ROW))('a row that is not yours does not make you stale', () => {
    // css genuinely does not ship this file — its Dockerfile copies packages/pgsl-store and
    // integrations/pgsl-css-accessor. It is in scope only because the file is a recipe input.
    const parent = execFileSync('git', ['rev-parse', `${ADDED_A_ROW}^`], { cwd: ROOT, encoding: 'utf8' }).trim();
    const drift = bundleDriftFor('css', parent, ROOT, ADDED_A_ROW);
    expect(drift.confident, drift.reason ?? '').toBe(true);
    // Reported as changed-AND-equivalent: the file did move, and a reader comparing this
    // against `git diff` must not be told otherwise.
    expect(drift.changed, 'the change should still be REPORTED').toContain('deploy/images.json');
    expect(drift.equivalent, `css was marked stale by somebody else's row: ${drift.reason}`).toBe(true);
    expect(drift.reason ?? '').toMatch(/not this image's row/);
  });

  it.runIf(has(ADDED_A_ROW))('★ your own row moving is NOT waved through', () => {
    // The direction that matters. This is the same commit and the same file; the only
    // difference is whose row it is. If this ever passes as equivalent, an image repointed
    // at a different Dockerfile would deploy as "no change".
    const parent = execFileSync('git', ['rev-parse', `${ADDED_A_ROW}^`], { cwd: ROOT, encoding: 'utf8' }).trim();
    const drift = bundleDriftFor('agp-bridge', parent, ROOT, ADDED_A_ROW);
    if (!drift.confident) return;   // scope not derivable at that commit; nothing to assert
    expect(drift.changed).toContain('deploy/images.json');
    expect(
      drift.equivalent,
      'the row that was ADDED belongs to agp-bridge — waving that through is the repointing miss',
    ).toBe(false);
  });

  it('fails closed when the file cannot be read at one end', () => {
    // A bogus revision makes `git show` throw at both ends; the rule must then assume the
    // row changed rather than silently treat an unreadable file as unchanged.
    const drift = bundleDriftFor('css', '0'.repeat(40), ROOT, 'HEAD');
    expect(drift.equivalent).toBe(false);
  });
});
