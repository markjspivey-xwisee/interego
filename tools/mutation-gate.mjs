#!/usr/bin/env node
/**
 * Make every gate FAIL before believing it. Deterministically, in minutes, on every commit.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Four adversarial audits ran against this repository. Their single most valuable finding, over
 * and over, was not a defect in the product — it was a GATE THAT COULD NOT FAIL:
 *
 *   round 2  three of four new gates passed on the exact defect they were written to catch
 *   round 3  the status helpers were unguarded (flip any to 401: 4/4 green); propagateRefusal
 *            hard-coded to 401: green; §C's classifier excused any `{ok:false}` below a
 *            parenthesised property
 *   round 4  the census scanner had no notion of a regex literal, so a planted `forbidden`
 *            denial was not merely missed — the overrun EXCUSED it — and 7/7 stayed green
 *
 * Those cost roughly 30M subagent tokens and several hours each to find. Every one of them is
 * mechanically checkable: apply the defect, run the gate, require red. That is this file.
 *
 * Audits are still worth running — they found things no table anticipates, like three verticals
 * whose declines answered 200 and a status that contradicted its own reason. But they should
 * not be spending their budget rediscovering that a gate is decorative.
 *
 * ── FIVE TRAPS, EACH FROM A REAL LOSS, EACH NOW A HARD FAILURE ───────────────
 *
 *  1. A MUTANT THAT DOES NOT APPLY IS A FAILURE, NOT A SKIP. Twice a mutation silently failed
 *     to match after a refactor and the run reported "DID NOT APPLY" beside a passing gate,
 *     which reads like success. Anchor drift means the table has gone stale and the gate is
 *     unverified — that is exactly when it must shout.
 *  2. THE REVERT NAMES THE FILE. `git checkout -- applications/` inside a mutation loop once
 *     reverted every uncommitted edit in the tree. Restoration here is from an in-memory copy
 *     of the exact files touched, in a `finally`, so it survives a throw and never consults git.
 *  3. A GATE MUST BE GREEN BEFORE IT IS MUTATED. If the clean run is already red, "the mutant
 *     failed it" proves nothing.
 *  4. A NON-ZERO EXIT IS NOT "CAUGHT". A mutation that does not COMPILE makes the typecheck
 *     globalSetup throw before one assertion runs. vitest exits non-zero, and a two-state
 *     harness scores that as a win while the gate stays unverified. That is INCONCLUSIVE.
 *  5. THE HARNESS MUST BE ABLE TO COUNT ITS OWN OUTPUT. The first version of this file reported
 *     nine sound gates as decoration, because vitest colours its summary even without a TTY and
 *     the failure pattern never matched through the escape codes. A parser bug here does not
 *     look like a parser bug; it looks like a catastrophic finding. So the clean run must yield
 *     real COUNTS before any mutant is believed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { MUTANTS } from './mutation-gate.data.mjs';

const only = process.argv.find(a => a.startsWith('--only='))?.slice('--only='.length);
const selected = only ? MUTANTS.filter(m => m.name.includes(only)) : MUTANTS;

/**
 * Run just the named gate files, and distinguish THREE outcomes, not two.
 *
 * ★ A NON-ZERO EXIT IS NOT THE SAME AS "THE GATE CAUGHT IT". A mutation can fail to COMPILE,
 * and the typecheck globalSetup then throws before a single assertion runs — vitest exits
 * non-zero and a two-state harness would score that as caught. The gate would be unverified
 * and reported green. So a run that dies before the assertions is INCONCLUSIVE, which is a
 * problem to report, never a pass.
 *
 * (The typecheck gate has no opt-out by design — "an escape hatch on a gate is the gate" — so
 * this pays ~6s per invocation rather than trying to skip it.)
 */
/**
 * ★ THE RELAY'S GATES ARE NOT VITEST FILES, AND THEY STILL HAVE TO BE MUTABLE.
 *
 * `deploy/mcp-relay/tests/*.ts` are plain tsx scripts that print `ok`/`FAIL` and exit non-zero.
 * They carry some of the sharpest checks in the tree — the OAuth read-scope gate among them —
 * and a harness that could only drive vitest would leave every one of them unverified, which is
 * the same hole as a gate nobody mutates.
 *
 * They report differently, so they are read differently: a `FAIL ` line IS the assertion
 * failing, and the absence of any `ok`/`FAIL` line means the script died before asserting,
 * which stays INCONCLUSIVE exactly as it does for vitest.
 */
function runScriptGate(file) {
  // A `.mjs` tool runs on node directly; a `.ts` relay test needs tsx.
  const argv = file.endsWith('.mjs') ? [file] : ['node_modules/tsx/dist/cli.mjs', file];
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  // eslint-disable-next-line no-control-regex -- stripping ANSI is the point
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
  // Two marker styles in this tree: the relay tests print `ok` / `FAIL `, the tools/ linters
  // print U+2713 / U+2717. Both are read, because a harness that knows only one of them reports
  // a gate as INCONCLUSIVE for the sole reason that it phrases success differently.
  const failed = /^\s*(?:FAIL\s|✗)/m.test(out) || /^★\s/m.test(out);
  const asserted = failed || /^\s*(?:ok\s|✓)/m.test(out);
  const okCount = (out.match(/^\s*(?:ok\s|✓)/gm) ?? []).length;
  const failCount = (out.match(/^\s*(?:FAIL\s|✗)/gm) ?? []).length;
  return {
    exitedNonZero: r.status !== 0,
    assertionsFailed: failed,
    countsParsed: asserted,
    ranAssertions: asserted,
    summary: asserted
      ? `Tests  ${failCount} failed | ${okCount} passed (${okCount + failCount})`
      : '(the script produced no ok/FAIL line)',
  };
}

const isScriptGate = (f) => f.startsWith('deploy/') || f.startsWith('tools/');

function runGates(files) {
  if (files.every(isScriptGate)) {
    // One script per gate entry; combine so the caller's three-state contract is unchanged.
    const each = files.map(runScriptGate);
    return {
      exitedNonZero: each.some(x => x.exitedNonZero),
      assertionsFailed: each.some(x => x.assertionsFailed),
      countsParsed: each.every(x => x.countsParsed),
      ranAssertions: each.every(x => x.ranAssertions),
      summary: each.map(x => x.summary).join('; '),
    };
  }
  const r = spawnSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', ...files, '--reporter=dot'],
    // NO_COLOR because the summary is PARSED here. vitest colours even without a TTY, and
    // `Tests ␛[22m ␛[1m␛[32m1 failed` does not match /Tests\s+\d+\s+failed/ — so the first
    // version of this harness read every caught mutant as "stayed green" and reported that
    // every gate in the table was decorative. Belt and braces: the env var, and the strip below.
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } },
  );
  // eslint-disable-next-line no-control-regex -- stripping ANSI is the point
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
  const summaryLine = /Tests\s+.*$/m.exec(out)?.[0]?.trim();
  const ranAssertions = Boolean(summaryLine);
  return {
    exitedNonZero: r.status !== 0,
    assertionsFailed: ranAssertions && /Tests\s+\d+\s+failed/.test(out),
    // Did the summary parse into COUNTS, not merely match as text? The whole harness reads a
    // failure out of this one line, so a summary it cannot count is a broken parser — and a
    // broken parser here reports every gate as decorative, which is the loudest possible lie.
    countsParsed: /Tests\s+\d+\s+(?:passed|failed)/.test(out),
    ranAssertions,
    summary: summaryLine ?? (out.match(/★ TYPECHECK GATE FAILED[\s\S]{0,160}/)?.[0]?.split('\n')[0] ?? '(run produced no test summary)'),
  };
}

const problems = [];

// ── 0. every gate named by the table must be GREEN first ────────────────────
const allGateFiles = [...new Set(selected.flatMap(m => m.mustFail))];
process.stdout.write(`mutation gate: ${selected.length} mutant(s) over ${allGateFiles.length} gate file(s)\n\n`);
const clean = runGates(allGateFiles);
if (clean.exitedNonZero) {
  console.error('★ THE GATES ARE ALREADY RED before any mutation was applied.');
  console.error(`  ${clean.summary}`);
  console.error('  Nothing below would prove anything. Fix the tree first.');
  process.exit(1);
}
if (!clean.countsParsed) {
  // TRAP 5. The harness could not COUNT its own gate output. Every mutant below would then be
  // reported as "stayed GREEN" - a claim about every gate at once that is really one bug here.
  // Not hypothetical: the first version of this file did exactly that, because vitest colours
  // even without a TTY, and an ANSI-interrupted summary never matches the failure pattern.
  // It reported nine sound gates as decoration.
  console.error('★ THE HARNESS CANNOT READ ITS OWN GATE OUTPUT.');
  console.error(`  summary seen: ${JSON.stringify(clean.summary)}`);
  console.error('  Fix the summary parsing in runGates() before believing anything below.');
  process.exit(1);
}
process.stdout.write(`clean run: ${clean.summary}\n\n`);

// ── 1. each mutant must turn its named gate(s) red ──────────────────────────
for (const m of selected) {
  const originals = new Map();
  try {
    const src = readFileSync(m.file, 'utf8');
    originals.set(m.file, src);

    if (!src.includes(m.find)) {
      // TRAP 1. Stale anchor: the gate this mutant verifies is now UNVERIFIED.
      problems.push(`${m.name}: anchor not found in ${m.file} — the table is stale, so the gate `
        + 'it verifies is unchecked. Re-anchor it; do not delete it.');
      process.stdout.write(`  ✗ ${m.name.padEnd(30)} ANCHOR NOT FOUND\n`);
      continue;
    }
    writeFileSync(m.file, src.replace(m.find, m.replace), 'utf8');

    const res = runGates(m.mustFail);
    if (res.assertionsFailed) {
      process.stdout.write(`  ✓ ${m.name.padEnd(30)} caught  (${res.summary})\n`);
    } else if (!res.ranAssertions) {
      // TRAP 4. The run died before the assertions — almost always because the mutation does
      // not compile, and the typecheck globalSetup threw. The gate is UNVERIFIED, and scoring
      // a non-zero exit as "caught" is exactly how a harness passes for the wrong reason.
      problems.push(`${m.name}: the run never reached the assertions, so the gate is unverified `
        + `— the mutation probably does not compile.\n      ${res.summary}`);
      process.stdout.write(`  ? ${m.name.padEnd(30)} INCONCLUSIVE (no assertions ran)\n`);
    } else {
      problems.push(`${m.name}: ${m.mustFail.join(', ')} stayed GREEN with the defect applied.\n`
        + `      what it should have caught: ${m.why}`);
      process.stdout.write(`  ✗ ${m.name.padEnd(30)} NOT CAUGHT\n`);
    }
  } finally {
    // TRAP 2. Restore exactly what was touched, from memory, whatever happened above.
    for (const [f, text] of originals) writeFileSync(f, text, 'utf8');
  }
}

if (problems.length) {
  console.error(`\n★ MUTATION GATE FAILED — ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  · ${p}\n`);
  console.error('  A gate that stays green on its own defect is decoration. Four audits found');
  console.error('  this class repeatedly; it is cheaper to find here.\n');
  process.exit(1);
}
process.stdout.write(`\nmutation gate: ${selected.length}/${selected.length} defect(s) caught.\n`);
