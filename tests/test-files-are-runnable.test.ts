/**
 * Every file vitest collects is actually a vitest suite.
 *
 * ★ WHY. Three standalone tsx assertion scripts — `ok()` / `failures` /
 * `process.exit(1)`, run by `bridge-typecheck.yml` via `npx tsx` — were named
 * `*.test.ts` and sat under `applications/**\/tests/`, which vitest globs. Vitest
 * collected them, found no `describe`/`it`, and reported:
 *
 *     Error: No test suite found in file …/credential-issuer-binding.test.ts
 *
 * So `npx vitest run` had been exiting non-zero for three files that were not broken and
 * not even vitest's to run. A suite that is permanently red for reasons nobody intends is
 * worse than a smaller green one: it trains everyone to read "3 failed" as normal, which
 * is exactly how a genuinely stale assertion (the Azure CORS hostnames) sat unnoticed
 * beside them.
 *
 * They now live in `checks/` as `*.check.ts`, outside the glob. This keeps them out.
 *
 * A `process.exit(1)` inside a vitest worker is the sharper version of the same hazard:
 * it would tear down the runner mid-suite rather than fail one test.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The directories vitest.config.ts actually collects from. */
const COLLECTED_ROOTS = ['tests', 'applications', 'integrations', 'mcp-server'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'scratchpad']);

function collectedTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.test.ts')) continue;
      // Mirror the config's globs: root `tests/`, and `**/tests/**` elsewhere.
      const rel = relative(REPO, p).replace(/\\/g, '/');
      const inRootTests = rel.startsWith('tests/');
      const inNestedTests = /(^|\/)tests\//.test(rel);
      if (inRootTests || inNestedTests) out.push(p);
    }
  };
  for (const root of COLLECTED_ROOTS) {
    const abs = join(REPO, root);
    try { if (statSync(abs).isDirectory()) walk(abs); } catch { /* absent */ }
  }
  return out;
}

describe('files vitest collects are vitest suites', () => {
  const files = collectedTestFiles();

  it('finds a non-trivial number of collected test files', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(50);
  });

  it('every collected *.test.ts declares a suite', () => {
    const offenders = files.filter(p => {
      const src = readFileSync(p, 'utf8');
      const importsVitest = /from ['"]vitest['"]/.test(src);
      const declaresSuite = /^\s*(describe|it|test)\s*[.(]/m.test(src);
      return !(importsVitest && declaresSuite);
    }).map(p => relative(REPO, p).replace(/\\/g, '/'));

    expect(offenders, offenders.length
      ? `not vitest suites — rename to *.check.ts outside a tests/ dir:\n  ${offenders.join('\n  ')}`
      : '').toEqual([]);
  });

  it('no collected test calls process.exit, which would kill the runner', () => {
    const offenders = files.filter(p => {
      // This file states the pattern in order to search for it, so it always matches
      // itself. A guard that fails on its own definition gets deleted rather than heeded.
      if (p.endsWith('test-files-are-runnable.test.ts')) return false;
      const src = readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return /process\.exit\s*\(/.test(src);
    }).map(p => relative(REPO, p).replace(/\\/g, '/'));

    expect(offenders, offenders.length
      ? `process.exit() inside a vitest worker tears down the run:\n  ${offenders.join('\n  ')}`
      : '').toEqual([]);
  });
});

/**
 * ★ THE rev195 FIXTURES ARE `*.test.mjs` OUTSIDE EVERY GLOB, AND THAT WAS DOCUMENTATION
 * WITH NOTHING BEHIND IT.
 *
 * The three `modalDistribution.test.mjs` under `examples/rev195-self-improving/` (in
 * `workspace/tests/`, `workspace-alpha/tests/` and `workspace-beta/tests/`) are copies of
 * one spec. They are NOT repo gates — `vitest.config.ts` collects only `*.test.ts` under
 * four roots, none of which is `examples/` — and routing them in would gate master on a
 * demo agent's LLM-rewritten scratch output. They are the spec the demo codes against:
 * `task.json` names the file as `tests.file` and `verifiers.mjs` spawns `node --test` on
 * it as the inner-loop green light.
 *
 * A header comment saying all of that was added to each copy, and four mutants were then
 * run against it. ALL FOUR SURVIVED, for one reason — nothing checked:
 *
 *   M1  mark only `workspace/`, leave `-alpha` and `-beta` unmarked  → silent
 *   M2  mark all three, reword one line in the `-beta` copy          → silent
 *   M3  change the marker wording in all three at once               → silent
 *   M4  delete or move any one of the three fixtures                 → silent
 *
 * The three assertions below are one per independent property, because they really are
 * independent: M4 needs EXISTENCE, M1/M3 need the MARKER, and M2 needs BYTE-IDENTITY — and
 * M2 is the proof that marker-presence and byte-identity do not imply each other. Identity
 * matters because `collective.mjs` overwrites the `-alpha` and `-beta` copies from the
 * `workspace/` original verbatim on every run, so an edit to one copy silently reverts and
 * resurfaces later as an unexplained dirty tree.
 */
describe('the rev195 demo fixtures are marked as fixtures, and stay identical', () => {
  const REV195 = join(REPO, 'examples/rev195-self-improving');
  // Named rather than destructured: `const [original, ...copies]` gives `string | undefined`
  // under noUncheckedIndexedAccess, and a non-null assertion here would hide a typo in the
  // path as an "undefined is not a string" three lines down.
  const ORIGINAL = join(REV195, 'workspace/tests/modalDistribution.test.mjs');
  const COPIES = [
    join(REV195, 'workspace-alpha/tests/modalDistribution.test.mjs'),
    join(REV195, 'workspace-beta/tests/modalDistribution.test.mjs'),
  ];
  const ALL = [ORIGINAL, ...COPIES];

  /** The load-bearing phrase. Reworded here and in the files together, or not at all. */
  const MARKER = '★ FIXTURE, NOT A REPO GATE';

  it('all three fixtures exist', () => {
    // M4. Without this the other two assertions would pass over a two-file set — or a
    // one-file set — and report full agreement across whatever happened to survive.
    const missing = ALL.filter(p => !existsSync(p)).map(p => relative(REPO, p).replace(/\\/g, '/'));
    expect(missing, missing.length
      ? `rev195 fixture(s) gone. They are the spec verifiers.mjs runs; if this was a `
        + `deliberate move, update this test:\n  ${missing.join('\n  ')}`
      : '').toEqual([]);
  });

  it('every copy carries the fixture marker', () => {
    // M1 and M3. Checked per file, so marking one and not the others fails naming the
    // unmarked ones; checked against a literal, so rewording all three at once also fails.
    const unmarked = ALL
      .filter(p => !readFileSync(p, 'utf8').includes(MARKER))
      .map(p => relative(REPO, p).replace(/\\/g, '/'));
    expect(unmarked, unmarked.length
      ? `missing "${MARKER}" — without it the next reachability audit re-derives from `
        + `scratch why these are not wired into vitest:\n  ${unmarked.join('\n  ')}`
      : '').toEqual([]);
  });

  it('the copies are byte-identical to the original', () => {
    // M2. Marker-presence cannot see a reworded body, and this cannot see a marker that
    // was changed in all three at once — which is why both assertions exist.
    const original = readFileSync(ORIGINAL);
    const diverged = COPIES
      .filter(p => !readFileSync(p).equals(original))
      .map(p => relative(REPO, p).replace(/\\/g, '/'));
    expect(diverged, diverged.length
      ? `collective.mjs rewrites these from workspace/tests/ verbatim on every run, so an `
        + `edit here silently reverts. Edit the original:\n  ${diverged.join('\n  ')}`
      : '').toEqual([]);
  });
});
