#!/usr/bin/env tsx
/**
 * Every suite in this package is actually invoked by `npm test`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * The `test` script here is a long &&-chain naming every suite ONE BY ONE. Writing a
 * suite and forgetting its segment is a diff that looks complete, passes review, and adds
 * zero coverage — the suite reports green while the new file has never executed.
 *
 * That is not hypothetical. `.github/workflows/relay-tests.yml` records the instance:
 * `tests/publish-gates.test.ts` — 30 assertions over the publish scope gate — was written,
 * committed, and silently left out of the `test` script, so it had stopped running entirely
 * while still looking like coverage. Nothing detected it; a human noticed.
 *
 * deploy/css-gate has had a guard against exactly this since its own near-miss
 * (`tests/suite-discovery.test.mjs`). This package, with many times the suites and the
 * substrate's security boundary behind them, had none.
 *
 * ── WHY A GUARD AND NOT A GLOB ───────────────────────────────────────────────
 *
 * css-gate fixed its version by switching to discovery: `node --test "tests/*.test.mjs"`.
 * That repair does NOT transfer here, and reaching for it is the wrong instinct:
 *
 *   - the runner is `tsx <file>` — one process per suite, each an ordinary script that
 *     ends in `process.exit(failures === 0 ? 0 : 1)`. tsx takes an entry point; it has no
 *     test discovery and does no globbing of its own.
 *   - npm runs scripts through cmd.exe on Windows and sh elsewhere. cmd.exe does not
 *     expand globs at all, so `tsx tests/*.test.ts` would hand tsx the literal string on
 *     one of the two platforms this repo is developed and shipped on.
 *
 * So enumeration stays, and this file makes the enumeration CHECKABLE: the invariant is
 * asserted rather than remembered.
 *
 * ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
 *
 * It reads package.json off disk, walks from `test` through every `npm run …` it reaches
 * (so `test:amep` counts only while `test` still calls it), collects every runnable path
 * those scripts name, and compares that set against the suites on disk — BOTH directions.
 * A suite nobody runs is the recorded defect; a segment naming a file that no longer
 * exists is its mirror image, left behind by a rename.
 *
 * ── THE RESIDUAL, STATED PLAINLY ─────────────────────────────────────────────
 *
 * This guard runs from inside the chain it guards, so deleting its own segment disables
 * it. Nothing here can close that — the check would have to live in a runner this package
 * does not own, and the repo's vitest `include` deliberately does not reach `deploy/**`.
 * What it can do is make the removal loud rather than quiet, which is why the last check
 * names the exact segment that must be present.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const relayDir = join(dirname(selfPath), '..');
const pkg = JSON.parse(readFileSync(join(relayDir, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const scripts = pkg.scripts ?? {};

let failures = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('\nEvery suite in deploy/mcp-relay is invoked by `npm test`');

/**
 * Which scripts does `npm test` actually REACH?
 *
 * Not "which scripts exist". `test:e2e` exists and is Playwright, run by its own workflow;
 * a hypothetical `test:extra` that nothing calls is a script whose suites never run. Only
 * scripts transitively reachable from `test` count, which is what makes deleting
 * `&& npm run test:amep` a detected regression rather than a cosmetic one.
 */
const reached: string[] = [];
const reachScript = (name: string): void => {
  if (reached.includes(name)) return;
  const body = scripts[name];
  if (typeof body !== 'string') return;
  reached.push(name);
  for (const m of body.matchAll(/npm\s+run\s+([\w:-]+)/g)) reachScript(m[1]!);
};
reachScript('test');

/**
 * Every runnable path those scripts name, normalised to a relay-relative POSIX path.
 *
 * Split on shell separators rather than pattern-matching filenames, so a segment is seen
 * however it is written — the chain currently contains both `tsx tests/x.test.ts` and
 * `node ../../deploy/mcp-relay/tool-args-hygiene.test.mjs` (an absolute-ish path back into
 * this same directory), and one segment is `&&tsx …` with no space after the operator.
 * `resolve` collapses all three forms to the same key; substring matching would not.
 */
const invoked = new Set<string>();
for (const name of reached) {
  for (const token of scripts[name]!.split(/[\s;&|]+/)) {
    if (!/\.(ts|mjs)$/.test(token)) continue;
    invoked.add(relative(relayDir, resolve(relayDir, token)).split(sep).join('/'));
  }
}

/**
 * Every suite on disk.
 *
 * Three naming conventions are in use and all three are real suites: `tests/*.test.ts`,
 * `tool-args-hygiene.test.mjs` at the package root, and the `_*-test.ts` scripts
 * (AMEP, note-view, hmd-app) that predate the tests/ directory.
 *
 * NOT collected, each for a reason:
 *   node_modules   — dependencies ship their own *.test.* files; walking it would report
 *                    other people's suites as ours, and it is thousands of entries.
 *   dist           — tsc output; a compiled copy is not a second suite.
 *   test-results,
 *   playwright-report — Playwright artefacts, not sources.
 *   *.spec.ts      — Playwright's convention. playwright.config.ts sets `testDir: './tests'`
 *                    and e2e-passkey.yml runs it, so tests/passkey-oauth.spec.ts HAS a
 *                    runner; it is simply not this chain's. Claiming it here would demand a
 *                    `tsx` segment that would boot a browser fixture under the wrong runner.
 *   tests/listen-loopback.ts, tests/tck-sut.ts — helpers, deliberately named so the
 *                    conventions above skip them.
 */
const skipDirs = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);
const onDisk = new Set<string>();
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) { walk(abs); continue; }
    if (/\.test\.(?:ts|mjs)$/.test(entry.name) || /^_[\w-]*-test\.ts$/.test(entry.name)) {
      onDisk.add(relative(relayDir, abs).split(sep).join('/'));
    }
  }
};
walk(relayDir);

const unrun = [...onDisk].filter(f => !invoked.has(f)).sort();
ok(unrun.length === 0,
  `all ${onDisk.size} suites on disk are invoked by \`npm test\``,
  unrun.length
    ? `NEVER RUN: ${unrun.join(', ')} — add a \`&& tsx <file>\` segment to the "test" script`
    : '');

const dangling = [...invoked].filter(f => !onDisk.has(f)).sort();
ok(dangling.length === 0,
  'every path `npm test` invokes is a suite that exists',
  dangling.length
    ? `NAMED BUT ABSENT: ${dangling.join(', ')} — a rename left the segment behind`
    : '');

const self = relative(relayDir, selfPath).split(sep).join('/');
ok(invoked.has(self),
  'this guard is itself in the chain',
  `the "test" script must contain \`tsx ${self}\`; without it nothing above runs`);

console.log(failures === 0
  ? `\n${'-'.repeat(60)}\n${onDisk.size} suites, ${invoked.size} invocations, no gap.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
