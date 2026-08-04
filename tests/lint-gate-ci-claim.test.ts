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
import { baselineClaimFailure } from '../tools/lint-gate.mjs';

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
