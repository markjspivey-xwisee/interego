/**
 * The derivation gate must agree with the prose that describes it.
 *
 * ★ WHY. `tools/derivation-lint.mjs` printed "97/97 classes grounded" while
 * `spec/LAYERS.md` said "41/41". That 41/41 was true the day derivation discipline landed
 * and was never touched again; `README.md` carried a second, independently drifting copy
 * (91/91, already wrong on the commit that shipped it) until it was rewritten to send the
 * reader to `npm run lint:derivation` rather than restate a figure. Two self-descriptions
 * of one gate, disagreeing with each other and both wrong, because the count was a
 * hand-typed literal with no producer→consumer link to the thing that computes it.
 *
 * The gate now asserts the claim itself. This test is what puts that assertion inside the
 * suite: `.github/workflows/bridge-typecheck.yml` is the only workflow that runs
 * `npx vitest run`, and ontology-lint.yml is `paths:`-filtered, so without this a change
 * outside those filters could take the gate red with nothing observing it.
 *
 * The REAL script is spawned through its REAL entry point. Re-implementing the scan here
 * would be a double standing in for the thing under test — it could not have caught the
 * drift, because the drift was between the script's output and a file the script never read.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = resolve(REPO, 'tools/derivation-lint.mjs');

function runGate(): { status: number; out: string } {
  const r = spawnSync(process.execPath, [TOOL], { cwd: REPO, encoding: 'utf8' });
  return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('derivation-lint: the gate and the prose state one number', () => {
  it('passes, and says so only after checking the prose', () => {
    const { status, out } = runGate();
    expect(status, out).toBe(0);
    // The PASS line is worded to name what it verified. If it reverts to the bare
    // "every L2/L3 class is grounded", the doc check has been removed and this fails.
    expect(out).toContain('spec/LAYERS.md states the same count');
  });

  it('spec/LAYERS.md states exactly the count the gate measured', () => {
    // Read independently of the gate, so this case fails even if someone deletes the
    // gate's own doc check — the two assertions are not the same assertion twice.
    const { out } = runGate();
    const measured = /Total: (\d+)\/(\d+) classes grounded/.exec(out);
    expect(measured, `no total in gate output:\n${out}`).not.toBeNull();
    const layers = readFileSync(resolve(REPO, 'spec/LAYERS.md'), 'utf8');
    // `\s+`, not a literal space: the sentence wraps mid-claim and this repo checks out
    // CRLF on Windows and LF in CI. A literal space matches in neither reliably.
    const claim = /Current status: \*\*(\d+)\/(\d+)\s+classes grounded\*\*/.exec(layers);
    expect(claim, 'spec/LAYERS.md no longer states a grounding count at all').not.toBeNull();
    expect([claim?.[1], claim?.[2]]).toEqual([measured?.[1], measured?.[2]]);
  });
});
