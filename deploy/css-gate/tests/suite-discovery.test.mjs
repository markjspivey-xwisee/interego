/**
 * css-gate — every suite in this directory actually runs.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * `npm test` here was `node --test tests/`, which is BROKEN on Node 22:
 *
 *     Error: Cannot find module 'D:\…\deploy\css-gate\tests'
 *     # tests 1 / # pass 0 / # fail 1
 *
 * The repair replaced it with two hard-coded filenames. That fixed the breakage and
 * traded it for something quieter and worse: a third file added to `tests/` ran NOWHERE,
 * and the suite reported GREEN. A loud failure tells you to look; a silent gap does not.
 * This repo has already shipped a commit for exactly that shape — 4fa32e9, "stop the suite
 * reporting success while testing nothing" — and css-gate had no guard against it.
 *
 * `node --test "tests/*.test.mjs"` is discovery again, and correct on this Node (measured:
 * `tests/` → 1 failed, quoted glob → all suites collected). The quotes matter and are not
 * decoration: npm runs scripts through cmd.exe on Windows and sh elsewhere, and NEITHER
 * must expand the pattern — Node's own runner does the globbing, so the same script string
 * works on both.
 *
 * ── WHAT THIS ASSERTS ────────────────────────────────────────────────────────
 *
 * That the script still DISCOVERS rather than enumerates. The realistic regression is
 * somebody quieting one flaky file by listing the others by name, which reintroduces the
 * silent gap in a diff that looks like a fix. Naming any suite individually fails here.
 *
 * Not a tautology: it reads `package.json` off disk, and it fails if the script is
 * rewritten to name files — checked by mutation, both ways.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
const script = String(pkg.scripts?.test ?? '');

test('the test script discovers suites by pattern, it does not enumerate them', () => {
  assert.match(
    script,
    /--test\s+"tests\/\*\.test\.mjs"/,
    `npm test must glob tests/, so a new suite runs without anyone remembering it. Got: ${script}`,
  );
});

test('no suite is named individually in the test script', () => {
  const named = readdirSync(here)
    .filter(f => f.endsWith('.test.mjs'))
    .filter(f => script.includes(f));
  assert.deepEqual(
    named, [],
    'a suite named by hand is a suite the glob no longer has to cover — that is how the '
    + 'gap comes back',
  );
});

test('every suite this directory holds is a file the pattern matches', () => {
  // The pattern is `tests/*.test.mjs`, so a helper deliberately named otherwise
  // (loopback.mjs) is correctly skipped, while anything ending .test.mjs is collected.
  // This fails if a suite is ever added under a nested directory, which the single-star
  // pattern would silently miss.
  const nested = readdirSync(here, { withFileTypes: true }).filter(e => e.isDirectory());
  assert.deepEqual(
    nested.map(d => d.name), [],
    'tests/ has no subdirectories: `tests/*.test.mjs` does not recurse, so a suite in one '
    + 'would not run. Add `tests/**/*.test.mjs` to the script before adding a subdirectory.',
  );
});
