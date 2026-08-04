/**
 * The lint gate's public label has to describe the gate.
 *
 * ★ WHY. `.github/workflows/lint.yml`'s job name carried a count of 47 long after the
 * baseline was emptied, and GitHub published it on every run — "(47 files pinned) ->
 * success" — while that same job's log printed "0 errors, 0 baselined files". 47 was true
 * the day the pin list was written; emptying BASELINE changed the code and not the label,
 * and nothing read the label, so nothing could notice. The number UNDERSTATED a gate that
 * is at its STRICTEST with nothing pinned, to every reviewer who reads a status line and
 * not a log.
 *
 * The repair that followed deleted the number instead of correcting it, which is better
 * prose and equally unchecked. The gate now accepts either form and checks whichever is
 * there; what it refuses is a label that claims nothing at all, because a label with no
 * claim in it is one nothing can contradict.
 *
 * The live case calls `baselineClaimFailure` with no second argument, so it runs against
 * the real workflow file and the real BASELINE. A fixture standing in for either could not
 * have caught the drift that actually happened — only the two real values disagreeing can.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineClaimFailure, frontierFailures, frontierTolerance } from '../tools/lint-gate.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'lint.yml');

describe('the ESLint job name describes the real baseline', () => {
  it('the workflow in the tree agrees with the BASELINE in the tree', () => {
    const failure = baselineClaimFailure(readFileSync(WORKFLOW, 'utf8'));
    expect(failure, failure ?? '').toBeNull();
  });

  it('refuses a numeric count that disagrees with the baseline', () => {
    const stale = 'jobs:\n  eslint:\n    name: "Flat-config lint + ratcheted baseline (47 files pinned)"\n';
    const failure = baselineClaimFailure(stale, 0);
    expect(failure).toContain('47 files pinned');
    expect(failure).toContain('BASELINE pins 0 file(s)');
  });

  it('accepts a count that agrees, and refuses one that does not, at any size', () => {
    expect(baselineClaimFailure('    name: "x (0 files pinned)"\n', 0)).toBeNull();
    expect(baselineClaimFailure('    name: "x (3 files pinned)"\n', 3)).toBeNull();
    expect(baselineClaimFailure('    name: "x (3 files pinned)"\n', 4)).toContain('pins 4 file(s)');
  });

  it('refuses an "empty baseline" label while the baseline is not empty', () => {
    const label = '    name: "Flat-config lint + ratcheted baseline (zero-error, empty baseline)"\n';
    expect(baselineClaimFailure(label, 0)).toBeNull();
    expect(baselineClaimFailure(label, 2)).toContain('calls the baseline EMPTY');
  });

  it('refuses deleting the claim instead of correcting it', () => {
    const noClaim = '    name: "Flat-config lint + ratcheted baseline"\n';
    expect(baselineClaimFailure(noClaim, 0)).toContain('states nothing about the baseline');
  });

  it('★ reads the job NAME, not the whole file — a historical note is not a live claim', () => {
    // lint.yml's own comment RECORDS that the name once said "47 files pinned". A
    // whole-file scan failed the gate on that accurate sentence about a fixed defect;
    // measured, before the scan was scoped. Without this case the scoping is untested and
    // the next person to "simplify" it reintroduces a gate that punishes its own history.
    const withHistory = '# It said "47 files pinned" long after the baseline was emptied.\n'
      + '    name: "Flat-config lint + ratcheted baseline (zero-error, empty baseline)"\n';
    expect(baselineClaimFailure(withHistory, 0)).toBeNull();
  });
});

/**
 * ★ THE UN-LINTED FRONTIER — the expansion item, closed as a ceiling instead of as ~185
 * per-file pins.
 *
 * `deploy/` and `applications/` were named in the item; the census in lint-gate.mjs found
 * five more nobody had named (`benchmarks/`, `demos/`, `mcp-server/`, `scripts/`, `spec/`),
 * for 2,505 lint errors across 571 files that no gate had ever looked at. The pins are one
 * number per root, ratcheted BOTH ways with a proportional tolerance, because a per-file
 * baseline over a concurrently-edited tree reds master on the first incidental cleanup —
 * which is exactly why the expansion was declined the last time it came up.
 *
 * Every fixture below is DERIVED from `frontierTolerance`, never a literal chosen to sit
 * beside today's value. `tests/vitest-run-integrity.test.ts` had to be rescued from exactly
 * that mistake: hard-coded fixtures turn the self-test red whenever the thing it guards is
 * legitimately tightened, and then it gets edited to match instead of read.
 */
describe('the un-linted frontier ratchet', () => {
  const pin = { errors: 1000, files: 300 };
  const slackErr = frontierTolerance(pin.errors);
  const slackFiles = frontierTolerance(pin.files);

  it('★ is silent inside the tolerance, in both directions — the control', () => {
    // Without this, a checker that always fails passes every case below.
    expect(frontierFailures('x', pin, { errors: pin.errors, files: pin.files })).toEqual([]);
    expect(frontierFailures('x', pin, {
      errors: pin.errors + slackErr, files: pin.files + slackFiles,
    })).toEqual([]);
    expect(frontierFailures('x', pin, {
      errors: pin.errors - slackErr, files: pin.files - slackFiles,
    })).toEqual([]);
  });

  it('★ fails when the debt grows past the tolerance, and refuses to suggest raising the pin', () => {
    const out = frontierFailures('applications', pin, {
      errors: pin.errors + slackErr + 1, files: pin.files,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/lint error\(s\), pinned at 1000/);
    expect(out[0]).toMatch(/Fix what you added — do not raise the pin/);
  });

  it('★ fails when it IMPROVES past the tolerance, and names the number to write', () => {
    // A gain nobody banks is a gain that can be silently lost again — the same reasoning as
    // the per-file baseline's improvement branch above.
    const now = { errors: pin.errors - slackErr - 1, files: pin.files };
    const out = frontierFailures('deploy', pin, now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(new RegExp(`write errors: ${now.errors} into UNLINTED_FRONTIER`));
  });

  it('★★ fails when the root falls out of the scan — the case zero errors cannot distinguish', () => {
    // A root eslint stops examining reports 0 errors, which passes the ceiling and reads
    // exactly like a root that was cleaned. The file count is the only thing that can tell
    // them apart, which is why it is checked separately and first.
    const out = frontierFailures('mcp-server', pin, { errors: 0, files: 0 });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]).toMatch(/that is a root falling out of the scan/);
    // And the improvement branch does NOT get to claim this as a win.
    expect(out.join('\n')).not.toMatch(/It IMPROVED/);
  });

  it('★ scales the tolerance with the pin, so a small root is not given a meaningless ceiling', () => {
    // A fixed tolerance of 30 was the first design and it is larger than the whole of
    // `scripts/` (7 errors), which would have let that root grow fivefold unobserved.
    expect(frontierTolerance(7)).toBeLessThan(7 + 5);
    expect(frontierTolerance(1380)).toBeGreaterThan(frontierTolerance(7));
    // The floor: never zero, or a one-line change reds the gate.
    expect(frontierTolerance(0)).toBeGreaterThan(0);
  });
});
