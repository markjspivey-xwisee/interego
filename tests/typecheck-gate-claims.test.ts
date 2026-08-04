/**
 * The two places that record what the typecheck gate found the day it was first turned on,
 * held to ONE number.
 *
 * The concrete failure this prevents, measured: from the commit that shipped the gate until
 * this test, `tools/typecheck-gate.mjs` said "58 pre-existing errors in 18 files" while
 * `applications/shared-workspace/README.md` said 60 in 20 for the same event — and the gate's
 * own LEGACY register, in that same commit, was 20 keys summing to 60. Those two files are
 * exactly what a future round reads to decide whether the gate earns its ~6 s per vitest
 * invocation, and they disagreed.
 *
 * This cannot RE-DERIVE the count: the register is empty now (the debt is zero), and no
 * workflow sets `fetch-depth`, so actions/checkout is shallow and `git show <sha>:` is not
 * available in CI. What it can do, with no git and no network, is refuse to let one recorded
 * number drift into two — and pin the value, so agreeing on a wrong number is not a pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Markdown bold and JSDoc bullets are both `*`; dropping them lets one regex read both files. */
function firstTurnOnClaim(relPath: string): { errors: number; files: number } {
  const text = readFileSync(join(ROOT, relPath), 'utf8').replace(/\*/g, ' ').replace(/\s+/g, ' ');
  const m = /surfaced (\d+) pre-existing errors in (\d+) files/.exec(text);
  expect(m, `no first-turn-on claim found in ${relPath}`).not.toBeNull();
  const errors = m?.[1];
  const files = m?.[2];
  expect(errors, `no error count parsed from ${relPath}`).toBeDefined();
  expect(files, `no file count parsed from ${relPath}`).toBeDefined();
  return { errors: Number(errors), files: Number(files) };
}

describe('typecheck gate: the first-turn-on count is recorded once', () => {
  it('agrees between tools/typecheck-gate.mjs and the shared-workspace README', () => {
    const gate = firstTurnOnClaim('tools/typecheck-gate.mjs');
    const readme = firstTurnOnClaim('applications/shared-workspace/README.md');
    expect(gate).toEqual(readme);
    // The value itself, pinned to the register the gate shipped with: 20 keys summing to 60.
    // Without this line the two documents could agree on anything, which is how they got here.
    expect(gate).toEqual({ errors: 60, files: 20 });
  });
});
