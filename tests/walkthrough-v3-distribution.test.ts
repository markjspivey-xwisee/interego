/**
 * Regression-protection test for tools/walkthrough-v3-distribution.ts.
 *
 * Companion to tests/walkthrough-v4-partial-vss.test.ts. Spawns the
 * distribution walkthrough as a child process and asserts:
 *   1. exit code 0
 *   2. all phases present in stdout
 *   3. both tampering simulations are rejected (forged commitment +
 *      forged trueBucketCounts)
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '', '..');
const WALKTHROUGH = join(REPO_ROOT, 'tools', 'walkthrough-v3-distribution.ts');

describe('walkthrough-v3-distribution: end-to-end narrative regression protection', () => {
  it('runs to completion and exercises every phase + every tampering rejection', () => {
    const result = spawnSync('npx', ['tsx', WALKTHROUGH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 60_000,
    });

    expect(result.status, `walkthrough exit code (stderr: ${result.stderr})`).toBe(0);

    const out = result.stdout;

    expect(out).toContain('PHASE 1 — Define the bucketing scheme');
    expect(out).toContain('PHASE 2 — Five contributors commit (one-hot encoded)');
    expect(out).toContain('PHASE 3 — Operator builds the attested distribution bundle');
    expect(out).toContain('PHASE 4 — Auditor verifies the bundle');
    expect(out).toContain('PHASE 5 — Tampering simulation #1: forged per-bucket commitment');
    expect(out).toContain('PHASE 6 — Tampering simulation #2: forged trueBucketCounts');
    expect(out).toContain('PHASE 7 — DP sensitivity reminder');

    // Both tampering attempts are rejected.
    expect(out).toContain('Forged commitment REJECTED: true');
    expect(out).toContain('Forged counts REJECTED: true');

    // The publishable noisyBucketCounts vector is shown.
    // Each bucket count is a bigint after Laplace noise — may be negative if noise underflows.
    expect(out).toMatch(/\[-?\d+(?:, -?\d+)+\] — this is what the regulator sees/);
  }, 90_000);
});
