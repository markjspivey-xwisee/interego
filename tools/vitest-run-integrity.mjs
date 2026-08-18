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

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
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
// 206 -> 208: the same ratchet, fired twice more by the same check as this round's two new
// self-tests landed — tests/modal-lattice-spec.test.ts (the TLA+ spec's theorems, previously
// evaluated by nothing) and tests/changelog-lint.test.ts (CHANGELOG.md's claims about itself,
// checked by nothing). The tree reached 218 and the reporter named 208 both times.
// 212 -> 214: the same ratchet, fired twice by the two files that closed the shared-workspace
// client's largest gaps — tests/workspace-desktop-renderer.test.ts (the desktop renderer, which
// until it landed had NO automated test at all and was named as the gap most likely to let a
// defect through) and tests/workspace-client-membership.test.ts (the create/invite/accept/canvas
// half of the module, which had just moved out of the published artifact's hand-written script).
// The tree reached 224 and the reporter named 214.
// 214 -> 218: the same ratchet, fired by the round that added the Discord bot — one root suite
// for the delegation half of the workspace client and three under
// applications/shared-workspace/discord/tests (the gateway protocol client, the link index, and
// what the bot is allowed to SAY about what it wrote). The tree reached 228.
// 220 -> 222: the round that made an agent a DELEGATE rather than a second name for the person
// added two suites. tests/workspace-client-delegates.test.ts covers the identity, the two-sided
// ceiling, the triples an entry carries, and the reader that tells a delegate's entry from its
// delegator's. applications/shared-workspace/discord/tests/record.test.ts covers the line that
// had to NOT move in the same round: a chat conduit relays words a person typed, so the entry is
// theirs, and that is driven through the real record path rather than asserted on a sentence.
// The tree reached 232.
// 222 -> 223: the round that moved the delegate down out of the shared-workspace vertical into
// `@interego/core`, where the delegation model it belongs to already lived. `tests/core-delegate.
// test.ts` is the one new suite: it asserts function IDENTITY across the two import paths — which
// a re-implementation cannot satisfy however closely it agrees — and covers the read-back pair
// (`publishDelegation` / `revokeDelegation`) that had no coverage at all before the move.
// The tree reached 233.
// 223 -> 224: the round that judged five writers naming a pod OWNER in the author position and
// changed four of them. `applications/agent-collective/tests/pod-publisher-attribution.test.ts`
// is the one new suite, and it exists because `recordCrossAgentAudit` had NO coverage of the
// value it wrote: its only caller in the suite is a live-pod test that skips when the pod is
// unreachable and asserts nothing about attribution, so the defect was invisible.
// The tree reached 234.
// 224 -> 225: bounding the pod manifest with a linked archive chain.
// `tests/bounded-manifest.test.ts` is the one new suite. It exists because the property the
// design turns on — every existing reader still works, and a reader that sees a short view can
// TELL — is not observable from any single function's unit test: it is a claim about the write
// staying bounded, the roll-over itself staying bounded, the chain reading back whole, and
// recovery producing the same count twice. Those are four different call paths agreeing.
// The tree reached 235.
// 225 -> 226: putting the Discord bot's `src/main.ts` under test.
// `applications/shared-workspace/discord/tests/main-wiring.test.ts` is the one new suite. It
// exists because the WIRING between the Discord half and the substrate half was covered by
// nothing: the gateway suite drives frames into a class that has no substrate, the record suite
// drives the substrate with no gateway, and the file deciding which frame reaches which
// substrate call — with what deps, at which ephemerality, delivered where — sat between them
// untested. It could not be tested at all until `main` stopped being module-private and
// self-invoking, because importing it WAS launching the bot.
// The tree reached 236.
// 226 -> 227: pinning the OAuth client name the Discord bot signs in under.
// `applications/shared-workspace/discord/tests/identity.test.ts` is the one new suite. The relay
// bakes the OAuth `client_name` into the agent DID it issues, so the bot's permanent identity —
// the string every participant pastes into `register_agent` and stores world-readably on their
// own pod — was decided by an argument `BotSession.open()` did not pass, and it therefore shipped
// under `mintBearer`'s default: the name of the disposable drivers in the sibling `tools/`
// directory. Nothing failed, which is why nothing caught it. The new suite drives the real SIWE
// ceremony over an injected `fetch` and reads the name off the `/register` body, because that is
// the only copy of it the relay ever sees.
// The tree reached 237.
// 232 -> 233: pinning the law that lets the deploy gate be SCOPED to one service.
// `tests/railway-scoped-check-is-not-weaker.test.ts` is the new suite. The deploy path used to
// end with a FLEET-WIDE `railway-pins.mjs --check`, so a `discord` rollout failed because `css`
// was behind, and the step — red by design after any merge — was twice dismissed in one session
// as "the documented always-red step" while the relay was genuinely behind on its own bundled
// code. The gate now asks the same predicate about the one service it deployed. The new suite
// pins `hasDisagreement(rows) === rows.some(r => hasDisagreement([r]))` over the power set of a
// mixed fleet, because a cross-row rule added later would pass both a single-row and a
// whole-fleet test while making the scoped gate blind to it.
// ★ The floor was ALSO 10 behind a tree of 242 before this suite existed — at exactly the
// allowance, so the next test file added anywhere was going to trip it regardless of what it was.
// The tree reached 243.
// 233 -> 234: the one thing allowed to turn a red pin green.
// `tests/deploy-bundle-scope.test.ts` is the new suite. Scoping the deploy gate did not cure
// the always-red disease, it moved it: the very commit that shipped the scoped gate touched
// only `.github/`, `tools/` and `tests/` — paths no service bundles — and turned all sixteen
// rows of the new scheduled audit red. `refineFreshness` rewrites BEHIND to `equivalent` when
// the drift touches nothing the service copies into its image, which makes the audit passable
// and also makes it, structurally, a false-green generator if it errs permissively. Every test
// in the suite is about the DIRECTION of a mistake. It was written after one: `tracked()` used
// `existsSync`, so css's gitignored `packages/pgsl-store/dist` passed the untracked-source
// guard because a local build had created it, and every change under `pgsl-store/src` went
// unseen.
// The tree reached 245 — `applications/shared-workspace/discord/tests/gateway-liveness.test.ts`,
// which spawns a real child process to prove the bot survives a gateway close.
// The tree reached 247 — `applications/shared-workspace/discord/tests/spoken-by.test.ts`, which
// pins the two things `MESSAGE_CREATE` carried and the bot discarded: the reply reference, so a
// person can address an agent the way Discord means it, and the attachment names, so posting a
// picture stops writing nothing and saying nothing.
// 237 -> 238: `applications/shared-workspace/discord/tests/mentions.test.ts`, which pins the form
// of addressing Discord actually has — `@agent <name>`, carried by a role that grants nothing and
// contains nobody.
// 238 -> 239: `applications/shared-workspace/discord/tests/drawing.test.ts`. An agent asked for a
// picture said it had no such capability; it has one — a model DRAWS, SVG is text, and writing
// text needs no permission. That file pins the projection into Discord and what will not render.
export const MIN_TEST_MODULES = 265;
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

/**
 * ── ★ THE README'S "Test Suites" TABLE, CHECKED AGAINST THE RUN THAT PRODUCES IT ──────
 *
 * README.md ships a nineteen-row table of `| suite | Tests | Coverage |`, and the middle
 * column is a hand-typed count. NINE OF THE NINETEEN WERE FALSE at the commit this check
 * landed on — measured, not suspected:
 *
 *   solid.test.ts          20 -> 44     encryption-zk.test.ts   30 -> 50
 *   crypto.test.ts         25 -> 32     pgsl.test.ts            31 -> 34
 *   affordance.test.ts     23 -> 26     federation.test.ts      21 -> 24
 *   context-graphs.test.ts 44 -> 46     sdk-extractors.test.ts  17 -> 19
 *   pgsl-coherence.test.ts  9 -> 10
 *
 * Nobody mis-edited anything. Every one of those suites simply GREW a test and the table
 * did not, which is what a hand-maintained number does — the same decay that produced
 * `lint-gate.mjs`'s "(47 files pinned)" job label and `derivation-lint.mjs`'s 41/41. The
 * repair for those two was the same as this one: the thing that PRODUCES the number is the
 * only thing that can honestly assert it, so it asserts it.
 *
 * This is the cheapest possible home for the check. The counts exist in `testModules`
 * already; reading them costs nothing, and this reporter is wired into `vitest.config.ts`
 * so it runs however vitest was invoked — including `.github/workflows/bridge-typecheck.yml`,
 * which runs the whole tree and therefore checks every row.
 *
 * ★ TWO CHECKS, BECAUSE THEY FAIL FOR DIFFERENT REASONS AND ONE IS BLIND WITHOUT THE OTHER.
 *
 *   1. COUNT, for rows whose module actually ran. A narrowed run (`npx vitest run
 *      tests/crypto.test.ts`) checks the one row it can and says nothing about the rest —
 *      the same principle as the tree floor above, which declines to fire on a run somebody
 *      narrowed deliberately. Anything else makes the guard the thing people work around.
 *
 *   2. EXISTENCE, for EVERY row, run or not. A suite that is deleted or renamed leaves a
 *      phantom row that check 1 can never see, because a module that does not exist is a
 *      module that never runs — the row would sit there being wrong forever, and the run
 *      would stay green. This is an `fs` stat, so it costs nothing and applies always.
 *
 * And the shape check: if the table stops matching the row pattern entirely, that is
 * reported too. A claim this gate cannot find is a claim nobody checks, which is the state
 * that produced the nine stale numbers. Reword the table and update `SUITE_ROW` in the same
 * commit — or delete the column, which is also an honest answer.
 */
const README = 'README.md';

/**
 * A `| `name.test.ts` | 44 | description |` row. Anchored on the backticked filename and a
 * bare integer so it cannot match the Specifications table further down, whose second cell
 * is prose. `m` because a markdown table is line-oriented.
 *
 * `g` is safe HERE only because the single reader below uses `matchAll`, which clones the
 * regex. Do not add a `.test()` or `.exec()` caller: a module-level /g regex carries
 * `lastIndex` between those calls and would silently skip every other row.
 */
const SUITE_ROW = /^\|\s*`([A-Za-z0-9._-]+\.test\.ts)`\s*\|\s*(\d+)\s*\|/gm;

/**
 * The failure paragraphs for the README table, given the rows it states and what the run
 * measured.
 *
 * Text and callbacks in, so `tests/vitest-run-integrity.test.ts` can hand it a stale table
 * without running nineteen suites; the live call passes the real README and the real module
 * counts, so the tested function and the running function are the same one rather than a
 * copy. A double that stood in for this could not express a stale count at all.
 *
 * @param {string} readmeText          contents of README.md
 * @param {Map<string,number>} measured  basename -> tests collected, for modules that ran
 * @param {(file: string) => boolean} suiteExists  does `tests/<file>` exist on disk
 * @returns {string[]} failure paragraphs, empty when the table is true
 */
export function readmeSuiteFailures(readmeText, measured, suiteExists) {
  const rows = [...readmeText.matchAll(SUITE_ROW)];
  if (rows.length === 0) {
    return [
      `${README} no longer contains a "Test Suites" table this gate can read (no `
      + '`| `x.test.ts` | <n> |` row matched). Either the table was reworded — update '
      + 'SUITE_ROW in tools/vitest-run-integrity.mjs in the same commit — or the counts '
      + 'were deleted, which is fine, but then delete the rest of this check too. What is '
      + 'refused is a table of numbers with nothing able to contradict them.',
    ];
  }
  const failures = [];
  for (const [, file, claimed] of rows) {
    if (!suiteExists(file)) {
      failures.push(
        `${README}'s Test Suites table lists \`${file}\`, and tests/${file} does not exist. `
        + 'A renamed or deleted suite leaves a row that no run can ever check, because a '
        + 'module that does not exist is a module that never runs. Fix the row or drop it.',
      );
      continue;
    }
    const actual = measured.get(file);
    // Not run in this invocation: existence is all this run can honestly assert.
    if (actual === undefined) continue;
    if (actual !== Number(claimed)) {
      failures.push(
        `${README} says \`${file}\` has ${claimed} tests; this run collected ${actual}. `
        + `Write ${actual} in the table. The number is not decoration — nine of these `
        + 'nineteen rows were stale before this check existed, and every one of them went '
        + 'stale by a suite growing a test.',
      );
    }
  }
  return failures;
}

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

    // ★ THE README'S TEST-SUITES TABLE. See readmeSuiteFailures above for what was measured.
    //
    // NOT gated on `atRepoRoot`: the claim is about `tests/*.test.ts` in THIS repo, and a
    // module that ran is a module whose count is known no matter which root vitest resolved.
    // A run under `--root mcp-server` simply measures none of them and the loop checks
    // existence only, which is the honest answer for that invocation.
    const measured = new Map();
    const TESTS_DIR = join(REPO_ROOT, 'tests');
    for (const m of testModules) {
      // `children.allTests()` is the collected-test generator. Guarded because the reporter
      // is also driven by tests/vitest-run-integrity.test.ts with minimal module doubles, and
      // because a module vitest never reached has no collection to report — neither is a
      // README defect and neither may throw out of a reporter.
      if (typeof m.moduleId !== 'string' || !FINISHED.has(m.state())) continue;
      if (resolve(dirname(m.moduleId)) !== resolve(TESTS_DIR)) continue;
      const all = m.children?.allTests?.();
      if (!all) continue;
      measured.set(basename(m.moduleId), [...all].length);
    }
    try {
      const readmeText = readFileSync(join(REPO_ROOT, README), 'utf8');
      failures.push(...readmeSuiteFailures(
        readmeText,
        measured,
        file => existsSync(join(TESTS_DIR, file)),
      ));
    } catch (err) {
      // Fail closed, like the tree-total branch above: "could not check" must not read the
      // same as "checked and fine".
      failures.push(
        `${README} could not be read, so its Test Suites table could not be checked: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
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
