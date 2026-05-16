/**
 * Regression-protection test for tools/walkthrough-v4-partial-vss.ts.
 *
 * The walkthrough is living documentation for the v4-partial+VSS +
 * committee + encrypted-distribution + authorization audit chain.
 * Adopters run it to see the end-to-end flow in a single process;
 * the team uses it as the executable narrative when explaining how
 * the primitives compose. Catching a regression in any of those
 * primitives via the walkthrough would mean an adopter clones the
 * repo, runs the script, and hits a confusing error — that's the
 * worst-case experience.
 *
 * This test runs the walkthrough as a child process and asserts:
 *   1. Exit code 0 (no thrown errors).
 *   2. The 7 phase headers are present in stdout (no phase silently
 *      collapsed).
 *   3. Critical cheat-protection signals are present: VSS reject,
 *      authorization cross-check, cross-decrypt rejection.
 *
 * The walkthrough is intentionally narrative + verbose; the test
 * is intentionally narrow and pinpoints regressions without
 * brittling on copy.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '', '..');
const WALKTHROUGH = join(REPO_ROOT, 'tools', 'walkthrough-v4-partial-vss.ts');

describe('walkthrough-v4-partial-vss: end-to-end narrative regression protection', () => {
  it('runs to completion and exercises every phase + every cheat-protection signal', () => {
    const result = spawnSync('npx', ['tsx', WALKTHROUGH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 60_000,
    });

    expect(result.status, `walkthrough exit code (stderr: ${result.stderr})`).toBe(0);

    const out = result.stdout;

    // Phase headers — the narrative skeleton.
    expect(out).toContain('PHASE 1 — Three contributors commit to private values');
    expect(out).toContain('PHASE 2 — Operator runs buildAttestedHomomorphicSum with thresholdReveal');
    expect(out).toContain('PHASE 3 — Encrypt + distribute 5 shares to 5 pseudo-aggregators');
    expect(out).toContain('PHASE 4 — Committee of 3 reconstructs trueBlinding from DECRYPTED shares');
    expect(out).toContain('PHASE 5 — Committee signs the chain-of-custody attestation');
    expect(out).toContain('PHASE 6 — Auditor verifies the chain-of-custody attestation');
    expect(out).toContain('PHASE 7 — Tampering simulation: VSS catches a corrupted share');

    // VSS catches the tampered share BEFORE Lagrange poisons the result.
    expect(out).toContain('Tampered share REJECTED by VSS before Lagrange');
    expect(out).toContain('Reconstruction still succeeded from the 3 verified shares');

    // Pre-reveal authorization + cross-check.
    expect(out).toContain('signed authorization');
    expect(out).toContain('Cross-check valid: true');

    // Cross-decrypt attempt is rejected.
    expect(out).toContain('Cross-decrypt rejected: YES');

    // Reconstruction itself succeeds with 0 rejected shares from the honest committee.
    expect(out).toContain('3 shares verified, 0 rejected');

    // trueBlinding properly omitted from the bundle's audit fields when threshold reveal is in use.
    expect(out).toContain('trueBlinding in bundle? NO (omitted, as required)');
  }, 90_000);
});
