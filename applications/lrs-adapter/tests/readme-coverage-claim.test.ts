/**
 * The README said two opposite things about the same tests, thirty lines apart.
 *
 * `## Tested against`'s deferred column said "No actual POST to a real LRS endpoint" while the
 * Tier 3 / 3b / 3c sections below it recorded POST results, voiding semantics and a
 * "Real-world finding" about SCORM Cloud's xAPI version as settled fact. A reader who stopped
 * at the table under-rated the adapter; a reader who skipped to the tiers believed a
 * conformance run was gating this code. Neither was true: the real-LRS code EXISTED and
 * NOTHING PROVISIONED IT, so those files reported `skipped` on every automated run — and
 * `skipped` is a state `tools/vitest-run-integrity.mjs` deliberately counts as FINISHED, so no
 * gate in this repo would have noticed.
 *
 * ★ WHY THIS IS BIDIRECTIONAL. A one-way check ("the warning is present") rots the moment
 * somebody does the good thing and wires an LRS up, leaving the warning behind as a fresh
 * stale claim in the opposite direction — which is the same mechanism that produced the
 * contradiction above. That is not hypothetical here: `lrs-adapter-conformance.yml` now DOES
 * provision Lrsql, so this file is currently exercising its else-branch, and the assertion
 * that would have been correct a commit ago is the one that must now fail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ★ `fileURLToPath`, never `new URL(...).pathname`. On win32 the latter yields `/D:/…`, which
// every fs call then rejects — and this suite runs on Windows locally and Linux in CI, so the
// broken form would pass CI and fail only on a developer's machine.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');
const README_PATH = join(HERE, '..', 'README.md');

/**
 * A workflow naming any of these is standing an LRS up or handing one credentials. Checked
 * against the three shapes that would actually appear: a `yetanalytics/lrsql` service
 * container, a `docker run … yetanalytics/lrsql` step, and a `SCORM_CLOUD_KEY` secret in `env:`.
 */
const PROVISIONING_MARKERS = /lrsql|yetanalytics|SCORM_CLOUD/i;

/**
 * Matched as a literal substring, not a regex over prose. A fuzzy match would keep passing
 * against a rewrite that quietly dropped the word "No" — and that word is the entire claim.
 */
const UNPROVISIONED_WARNING = 'No workflow under `.github/workflows/` provisions an LRS';

/** Claims the tier files disprove: this directory does contain a real GET and a real POST. */
const RETRACTED_CLAIMS = [
  'No actual GET against a real LRS endpoint',
  'No actual POST to a real LRS endpoint',
];

function workflowsProvisioningAnLrs(): string[] {
  return readdirSync(WORKFLOWS_DIR)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .filter(f => PROVISIONING_MARKERS.test(readFileSync(join(WORKFLOWS_DIR, f), 'utf8')));
}

describe('lrs-adapter README vs. what CI actually provisions', () => {
  it('carries the unprovisioned warning while — and only while — no workflow stands an LRS up', () => {
    const provisioning = workflowsProvisioningAnLrs();
    const readme = readFileSync(README_PATH, 'utf8');
    const hasWarning = readme.includes(UNPROVISIONED_WARNING);

    if (provisioning.length === 0) {
      expect(
        hasWarning,
        'No workflow provisions an LRS, so applications/lrs-adapter/README.md must say so '
        + `verbatim: "${UNPROVISIONED_WARNING}".`,
      ).toBe(true);
    } else {
      expect(
        hasWarning,
        `${provisioning.join(', ')} now provisions an LRS. Remove the unprovisioned warning `
        + 'from applications/lrs-adapter/README.md and state what the run now actually covers — '
        + 'a warning left in place after it stopped being true is the same defect in reverse.',
      ).toBe(false);
    }
  });

  it('names the workflow that provisions the LRS, whenever one exists', () => {
    // Without this, the else-branch above is satisfiable by saying NOTHING — the absence of a
    // stale warning is not the presence of an accurate claim, and a reader still could not
    // find out what a run covers. This is what stops the bidirectional check from degrading
    // into "delete the sentence and move on".
    const provisioning = workflowsProvisioningAnLrs();
    if (provisioning.length === 0) return;
    const readme = readFileSync(README_PATH, 'utf8');
    const named = provisioning.filter(f => readme.includes(f));
    expect(
      named.length,
      `${provisioning.join(', ')} provisions an LRS, but applications/lrs-adapter/README.md `
      + 'names none of them. Say which workflow runs which bodies, or the doc has replaced a '
      + 'false claim with no claim.',
    ).toBeGreaterThan(0);
  });

  it('never reprints the retracted "no such call exists" claims', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    for (const claim of RETRACTED_CLAIMS) {
      expect(
        readme,
        `"${claim}" is false: tests/tier3-real-lrs.test.ts contains exactly that call. What is `
        + 'true is which of those calls a workflow actually runs — say that instead.',
      ).not.toContain(claim);
    }
  });
});
