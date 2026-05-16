/**
 * Regression-protection test for tools/walkthrough-v5-distributed-blinding.ts.
 *
 * Companion to the v3-distribution + v4-partial walkthrough tests.
 * Spawns the v5 walkthrough as a child process and asserts:
 *   1. exit 0
 *   2. all 7 phase headers present
 *   3. trueBlinding NOT in bundle (the headline privacy guarantee)
 *   4. tampered share rejected by combined-VSS
 *   5. reveal succeeds from honest committee
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '', '..');
const WALKTHROUGH = join(REPO_ROOT, 'tools', 'walkthrough-v5-distributed-blinding.ts');

describe('walkthrough-v5-distributed-blinding: end-to-end narrative regression protection', () => {
  it('runs to completion and exercises every phase + every cheat-protection signal', () => {
    const result = spawnSync('npx', ['tsx', WALKTHROUGH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 60_000,
    });
    expect(result.status, `walkthrough exit code (stderr: ${result.stderr})`).toBe(0);

    const out = result.stdout;
    expect(out).toContain('PHASE 1 — Define cohort');
    expect(out).toContain('PHASE 2 — Each contributor commits + VSS-splits their OWN blinding');
    expect(out).toContain('PHASE 3 — Operator builds the bundle (NEVER sees any blinding)');
    expect(out).toContain('PHASE 4 — Each pseudo-aggregator decrypts + verifies + sums their received shares');
    expect(out).toContain('PHASE 5 — t-of-n committee');
    expect(out).toContain('PHASE 6 — Tampering simulation: VSS catches corrupted combined share');
    expect(out).toContain('PHASE 7 — What each party sees');

    // Headline guarantee: trueBlinding never in bundle.
    expect(out).toContain('trueBlinding in bundle? NO');
    // Tampering rejected.
    expect(out).toContain('1 rejected');
    // Honest reveal works.
    expect(out).toContain('3 verified, 0 rejected');
    // sumCommitment opens.
    expect(out).toContain('sumCommitment opens to (claimedTrueSum');
  }, 90_000);
});
