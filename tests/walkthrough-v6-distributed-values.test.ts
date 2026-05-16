/**
 * Regression-protection test for tools/walkthrough-v6-distributed-values.ts.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname ?? '', '..');
const WALKTHROUGH = join(REPO_ROOT, 'tools', 'walkthrough-v6-distributed-values.ts');

describe('walkthrough-v6-distributed-values: end-to-end narrative regression protection', () => {
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
    expect(out).toContain('PHASE 2 — Each contributor commits + VSS-splits both value AND blinding');
    expect(out).toContain('PHASE 3 — Each pseudo-aggregator decrypts + verifies + sums BOTH share-types');
    expect(out).toContain('PHASE 4 — Operator requests trueSum via t-of-n committee Lagrange');
    expect(out).toContain('PHASE 5 — Operator builds the bundle');
    expect(out).toContain('PHASE 6 — Auditor verifies via blinding-side committee shares');
    expect(out).toContain('PHASE 7 — Tampering simulation #1: tampered value share at reveal');
    expect(out).toContain('PHASE 8 — Tampering simulation #2: tampered blinding share at audit');
    expect(out).toContain('PHASE 9 — Trust analysis');

    // Headline: operator never sees individual values; only revealed trueSum.
    expect(out).toContain('Operator NEVER saw any individual contributor value');
    // Both tamper sims caught.
    expect(out).toMatch(/3 verified, 1 rejected/);
    // Both honest reveals succeed.
    expect(out).toContain('Audit valid:');
  }, 90_000);
});
