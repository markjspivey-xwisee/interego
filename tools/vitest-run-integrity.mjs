/**
 * The check that the suite actually RAN, because a suite that runs almost nothing already
 * looked exactly like success.
 *
 * ── WHAT HAPPENED ────────────────────────────────────────────────────────────
 *
 * `tests/workspace-adversarial.test.ts`'s AXIS A enumerates 76,800 configurations and used to
 * do it in one uninterrupted synchronous turn — 66,847 ms measured. `vitest.config.ts` pins
 * `singleThread`/`singleFork`, so every file shares that worker, and vitest's birpc request
 * deadline is 60 s. The main process's reply to `onTaskUpdate` sat unread in the blocked
 * worker's queue until the deadline expired, the worker was torn down, and `npx vitest run
 * tests/` printed:
 *
 *   Test Files  2 passed (185)
 *   Tests       169 passed (169)
 *   Errors      1 error
 *
 * 183 files and roughly 2,400 tests never executed. The word beside every number was
 * "passed", and `.github/workflows/bridge-typecheck.yml:158` runs exactly that command — so
 * what CI reads is a summary describing about one percent of the suite.
 *
 * ★ AND IT IS A RACE, WHICH IS THE WORST PART. The same command on the same tree also ran
 * clean at 181/185. AXIS A's block was 66.8 s against a 60 s deadline, so machine load
 * decided the outcome. The three checks below do not depend on losing that race to be worth
 * having: whatever kills a run early, they refuse to let the summary describe it as a pass.
 *
 * The enumeration is fixed at its own site (it yields now; see `YIELD_EVERY` there). This
 * file exists because THE NEXT ONE WILL NOT BE THAT TEST. Any long synchronous loop, any
 * worker that segfaults, any pool that dies half way through produces the same shape, and the
 * shape is what has to be unsurvivable — not the one instance of it.
 *
 * ── THE THREE CHECKS, AND WHY EACH IS SEPARATE ───────────────────────────────
 *
 * 1. UNHANDLED ERRORS FAIL THE RUN. vitest already sets `process.exitCode = 1` for these
 *    (`_checkUnhandledErrors`), so this is belt-and-braces on the exit code — but the exit
 *    code was never the problem. `Errors 1 error` under `169 passed` reads as a footnote. It
 *    is restated here in the loud form, next to the count of what did not run, because the
 *    two facts are one fact and printing them apart is how this was missed.
 *
 * 2. EVERY MODULE VITEST PLANNED MUST HAVE FINISHED. This is the exact defect above and the
 *    only check that catches it. It needs no floor and no configuration: vitest tells us how
 *    many specifications it started with, and `pending`/`queued` at the end means the run
 *    stopped early. It applies to every invocation, narrowed or not — a single-file run that
 *    dies mid-file is the same lie at a smaller scale.
 *
 * 3. A WHOLE-TREE RUN MUST FIND THE WHOLE TREE. Check 2 is blind to a run that never planned
 *    the files at all: if an `include` glob stops matching after a directory move, vitest
 *    plans 3 files, runs 3 files, and every count agrees with itself. So {@link
 *    MIN_TEST_MODULES} is a number written down, in the same spirit as `lint-gate.mjs`'s
 *    `MIN_FILES` and for the same reason — that gate exists because `eslint` exits 0 when it
 *    lints nothing.
 *
 * ── WHY CHECK 3 DOES NOT NEED TO KNOW ABOUT CLI FILTERS ──────────────────────
 *
 * A floor cannot fire on `npx vitest run tests/crypto.test.ts` without making the guard the
 * thing people work around, and reimplementing vitest's filter semantics to find out what a
 * given invocation "should" have selected would be a second copy of `filterFiles` drifting
 * against the first.
 *
 * Neither is necessary. `vitest.globTestSpecifications()` with no arguments returns what the
 * config's globs match across the tree, filters ignored — 185 here. So the run declares
 * itself: if it planned every file in the tree, it is a whole-tree run and the floor applies;
 * if it planned fewer, somebody narrowed it deliberately and it does not. A broken glob is
 * still caught, because it shrinks the tree total and the planned count together, leaving
 * them equal — which is precisely the case the floor is a floor for.
 *
 * ── WIRING ───────────────────────────────────────────────────────────────────
 * Wired in `vitest.config.ts` under `reporters`, so it is present however vitest was
 * invoked. There is no environment variable to switch it off; an escape hatch on a gate is
 * the gate.
 */

import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file lives in `tools/`, so its parent directory is the repo root. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The floor on how many test modules a whole-tree run must plan, and how far below the real
 * tree it is allowed to sit. The allowance absorbs ordinary file deletion without letting a
 * coverage collapse through.
 *
 * Ratcheted 175 → 179 by hand once already: 175 was set when the globs matched 185, and by
 * the time anyone looked the tree was 189, so the untouched floor had silently widened to a
 * 14-module allowance. A glob that stopped matching an entire directory of 12 suites would
 * have planned 177, agreed with itself, cleared the floor, and reported a green whole-tree
 * run over a tree missing a directory.
 *
 * ★ THAT CORRECTION IS NO LONGER SOMETHING ANYONE HAS TO REMEMBER. `treeTotal` was already
 * computed a few lines below and used ONLY to decide whether the run had been narrowed —
 * never compared against this number. So the floor could only ever be corrected by a human
 * noticing, and drift in the safe-looking direction was invisible by construction. The
 * drift check below closes that, in the same spirit as `typecheck-gate.mjs`'s per-file pins
 * and `lint-gate.mjs`'s baseline: a pin that only tightens when somebody remembers is a pin
 * that never tightens. The failure names the number to write, so the fix is a one-line
 * commit.
 */
// ★ EXPORTED SO THE SELF-TEST DERIVES ITS FIXTURES INSTEAD OF RESTATING THESE NUMBERS.
//
// tests/vitest-run-integrity.test.ts used to hard-code 200 / 400 / "to 390" to match the
// floor of the day. Raising the floor 200 -> 205 then turned its own control case red — the
// honest-whole-tree fixture built exactly 200 modules, which is now BELOW the floor — and a
// self-test that fails whenever the thing it tests is legitimately tightened is a self-test
// people edit to match rather than read. Two sources of truth for one number, and the gate's
// whole purpose is to have one.
// 205 -> 206: the ratchet the check above asks for, not a bound raised to make a red go
// away. The tree grew to 216 modules (tests/line-endings-are-normalised.test.ts landed with
// the .gitattributes normalisation), which put the floor 11 below reality and past
// FLOOR_ALLOWANCE, so the reporter failed the run and named the number to write.
export const MIN_TEST_MODULES = 206;
export const FLOOR_ALLOWANCE = 10;

/**
 * States that mean the module was actually taken to a conclusion. `pending` and `queued` are
 * the other two `TestModuleState` values and both mean vitest never got to it — which is the
 * whole finding, so they are named by exclusion rather than by a list that could go stale
 * against a future state vitest adds.
 */
const FINISHED = new Set(['passed', 'failed', 'skipped']);

/** How many unfinished module paths to print before saying "and N more". */
const NAME_LIMIT = 10;

export default class RunIntegrityReporter {
  onInit(vitest) {
    this.vitest = vitest;
  }

  onTestRunStart(specifications) {
    // Captured here rather than counted from `testModules` at the end: a module that was
    // never reached may not be in that array at all, and the count of what was PLANNED is
    // the only number that survives the worker dying.
    this.planned = specifications.length;
  }

  async onTestRunEnd(testModules, unhandledErrors, reason) {
    const failures = [];

    if (unhandledErrors.length > 0) {
      const first = unhandledErrors[0];
      failures.push(
        `${unhandledErrors.length} unhandled error(s) escaped the run. An error outside a test `
        + 'is not a footnote under a green summary — it usually means a worker died, and a '
        + 'dead worker takes every test it had not reached yet with it.\n'
        + `      ${String(first?.message ?? first).split('\n')[0]}`,
      );
    }

    const planned = this.planned ?? testModules.length;
    const unfinished = [];
    const seen = new Set();
    for (const m of testModules) {
      seen.add(m.moduleId);
      if (!FINISHED.has(m.state())) unfinished.push(`${m.moduleId} (${m.state()})`);
    }
    // Modules vitest planned and then never reported on at all. `planned - seen.size` rather
    // than a set difference because `onTestRunStart`'s specifications and `onTestRunEnd`'s
    // modules are different object shapes, and the count is the part that matters.
    const missing = planned - seen.size;

    // ★ Ctrl-C is the one incomplete run that is not a defect. Reported, never failed: a
    // human who stopped the run already knows, and failing here would train people to
    // disbelieve this block.
    if (reason === 'interrupted') {
      if (missing > 0 || unfinished.length > 0) {
        console.error(
          `run integrity: the run was INTERRUPTED with ${missing + unfinished.length} of `
          + `${planned} module(s) unfinished. Not treated as a failure — but nothing below `
          + 'this line was tested.',
        );
      }
      return;
    }

    if (missing > 0 || unfinished.length > 0) {
      const shown = unfinished.slice(0, NAME_LIMIT);
      failures.push(
        `${missing + unfinished.length} of ${planned} planned test module(s) never finished. `
        + 'The summary above counts only the ones that did, so it is reporting on a fraction '
        + 'of the suite and calling it a pass.\n'
        + (shown.length > 0
          ? `      ${shown.join('\n      ')}\n`
          : '')
        + (unfinished.length > NAME_LIMIT ? `      …and ${unfinished.length - NAME_LIMIT} more\n` : '')
        + (missing > 0
          ? `      ${missing} more were planned and never reported on at all — the usual cause `
            + 'is the worker being torn down mid-run.'
          : ''),
      );
    }

    // ★ SCOPED TO THE REPO ROOT, BECAUSE THE FLOOR IS A FACT ABOUT THIS REPO'S TREE AND NOT
    // ABOUT WHATEVER ROOT VITEST RESOLVED. `npx vitest run --root mcp-server` still loads
    // this config — vitest walks up to find it — so the reporter runs with `include`
    // re-resolved against mcp-server/, where `tests/**` matches 2 files and the other three
    // globs match nothing. With no filename that is planned=2, treeTotal=2,
    // `planned >= treeTotal`, and the floor fires claiming a 200-module tree "shrank" to 2.
    // `.github/workflows/bridge-typecheck.yml` escapes that only because the line happens to
    // name a file (planned=1 < treeTotal=2) — deleting that filename would turn CI red for a
    // defect that does not exist.
    const atRepoRoot = resolve(this.vitest.config.root) === resolve(REPO_ROOT);

    let treeSpecs;
    let treeTotal;
    try {
      // No arguments: the config's `include` globs across the whole tree, CLI filters ignored.
      treeSpecs = await this.vitest.globTestSpecifications();
      treeTotal = treeSpecs.length;
    } catch (err) {
      // Fail closed. If the guard cannot establish how big the tree is, it cannot say the run
      // covered it, and "could not check" must not read the same as "checked and fine".
      failures.push(
        'the tree total could not be established, so the floor below could not be applied: '
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      treeSpecs = undefined;
      treeTotal = undefined;
    }

    if (atRepoRoot && treeTotal !== undefined && planned >= treeTotal && planned < MIN_TEST_MODULES) {
      failures.push(
        `this run planned ${planned} test module(s) — the whole tree, so nothing narrowed it — `
        + `and the floor is ${MIN_TEST_MODULES}. Either the tree really did shrink that far, in `
        + 'which case lower MIN_TEST_MODULES in tools/vitest-run-integrity.mjs and say why, or '
        + "an `include` glob in vitest.config.ts stopped matching and most of the suite is no "
        + 'longer being collected at all.',
      );
    }

    // ★ THE RATCHET THE FLOOR NEVER HAD. The number above is hand-written, and until now the
    // only thing keeping it honest was somebody remembering — it reached 14 modules of slack
    // that way, more than the two smallest `include` roots put together. The tree size is
    // already in hand on every whole-tree run, so the staleness is CHECKED rather than
    // trusted, and the message carries the replacement number.
    if (atRepoRoot && treeTotal !== undefined && treeTotal - MIN_TEST_MODULES > FLOOR_ALLOWANCE) {
      failures.push(
        `the tree holds ${treeTotal} test module(s) but MIN_TEST_MODULES is ${MIN_TEST_MODULES} `
        + `— ${treeTotal - MIN_TEST_MODULES} below it, past the ${FLOOR_ALLOWANCE} of slack this `
        + 'floor is allowed. A floor that drifts far below reality stops being a floor. Raise '
        + `MIN_TEST_MODULES in tools/vitest-run-integrity.mjs to ${treeTotal - FLOOR_ALLOWANCE}.`,
      );
    }

    // ★ AND THE CHECK NO SCALAR FLOOR CAN MAKE, AT ANY VALUE. `include` is four globs, and
    // two of them match a handful of modules each. A broken glob shrinks `planned` and
    // `treeTotal` TOGETHER — that is stated in this file's header as the design's strength —
    // so the scalar floor is the only remaining defence, and any floor with enough slack to
    // absorb ordinary deletion carries more slack than the two smallest roots combined.
    // Measured on this reporter: `integrations/**` and `mcp-server/tests/**` could BOTH stop
    // matching entirely and the gate stayed silent. That is exactly the "an `include` glob
    // stopped matching after a directory move" case check 3 names as its whole purpose, so
    // presence is checked per glob, where the signal is unambiguous.
    if (atRepoRoot && treeSpecs !== undefined) {
      for (const pattern of (this.vitest.projects ?? []).flatMap(p => p.config.include ?? [])) {
        // The literal leading segments — everything before the first wildcard — i.e. the
        // directory the glob is rooted at. Matching whole globs would mean a second copy of
        // vitest's glob semantics drifting against the first, which this file already refuses.
        const segments = pattern.split('/');
        const firstWildcard = segments.findIndex(s => s.includes('*'));
        const prefix = (firstWildcard === -1 ? segments.slice(0, -1) : segments.slice(0, firstWildcard)).join('/');
        // A glob rooted at the top of the tree names no directory of its own; the floor and
        // the drift check already cover it, and treating '' as a prefix matches everything.
        if (prefix === '') continue;
        const matched = treeSpecs.some(s => {
          const rel = relative(this.vitest.config.root, s.moduleId).split(sep).join('/');
          return rel === prefix || rel.startsWith(`${prefix}/`);
        });
        if (!matched) {
          failures.push(
            `the \`include\` glob \`${pattern}\` in vitest.config.ts matches no test module at `
            + 'all, so nothing under it is being collected. It is one of the smaller roots, '
            + 'which is why the total can stay above the floor while every test it named is '
            + 'gone — the silent, green coverage loss this file exists to refuse.',
          );
        }
      }
    }

    if (failures.length === 0) return;

    process.exitCode = 1;
    console.error([
      '',
      '★ RUN INTEGRITY GATE FAILED — the numbers above do not describe the whole suite',
      '',
      ...failures.map(f => `  ${f}`),
      '',
      `(${planned} module(s) planned${treeTotal === undefined ? '' : `, ${treeTotal} in the tree`}.)`,
      'See tools/vitest-run-integrity.mjs for what each check is guarding against.',
      '',
    ].join('\n'));
  }
}
