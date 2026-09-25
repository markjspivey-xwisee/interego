/**
 * The follower's run decisions: which files a run log says failed (through color codes, and from
 * the per-file summary), a chain that saw a run fail ends 1 (the judge step it runs in is red when
 * the tests are), and a full-mode selection is left to the suite workflow when the caller says so.
 */
import { describe, expect, it } from 'vitest';
import { chainExitCode, failingTestFiles, fullRunLeftToTheSuite, runEnvironment, runNeedsTriage, stripAnsi } from '../src/follower.js';

const E = '\u001b';

describe('the failing files a run log names', () => {
  it('are found through the color codes, as vitest wrote them on 2026-09-25', () => {
    // FORCE_COLOR=0 and CI both ask vitest's color library for color, so this is what the log held
    // when the follower printed "0 failing test file(s)" for a run that failed one.
    const log = `${E}[41m${E}[1m FAIL ${E}[22m${E}[49m tests/core-polling-cadence.test.ts${E}[2m > ${E}[22mthe cadence follows the conversation${E}[2m > ${E}[22m★★ and a QUIET channel is still read within the ceiling`;
    expect(failingTestFiles(log)).toEqual(['tests/core-polling-cadence.test.ts']);
  });

  it('include a file named only in the per-file summary, so a failed run is not scored as clean', () => {
    const log = [
      ` ${E}[32m✓${E}[39m tests/a-refusal.test.ts ${E}[2m(${E}[22m${E}[2m5 tests${E}[22m${E}[2m)${E}[22m${E}[33m 3042${E}[2mms${E}[22m${E}[39m`,
      ` ${E}[31m❯${E}[39m tests/core-polling-cadence.test.ts ${E}[2m(${E}[22m${E}[2m6 tests${E}[22m${E}[2m | ${E}[22m${E}[31m1 failed${E}[39m${E}[2m)${E}[22m${E}[33m 66976${E}[2mms${E}[22m${E}[39m`,
      `${E}[2m Test Files ${E}[22m ${E}[1m${E}[31m1 failed${E}[39m${E}[22m${E}[2m | ${E}[22m${E}[1m${E}[32m430 passed${E}[39m${E}[22m`,
    ].join('\n');
    const failedTests = failingTestFiles(log);
    expect(failedTests).toEqual(['tests/core-polling-cadence.test.ts']);
    expect(runNeedsTriage({ exitCode: 1, failedTests })).toBe(true);
    expect(chainExitCode([{ exitCode: 1, failedTests }])).toBe(1);
  });

  it('are not read from a passing file, a skipped test, or a test whose title says it failed', () => {
    const log = [
      ' ✓ tests/scorm-artifact-integrity.test.ts (30 tests) 3950ms',
      ' ❯ tests/b.test.ts (4 tests | 1 skipped) 12ms',
      '   ✓ a read that FAILED is not a seat that is missing > and a genuinely ABSENT acceptance is still answered',
      '   ✓ a message arriving in a channel > a failed append is logged and does not stop the next message',
      ' Test Files  431 passed (431)',
    ].join('\n');
    expect(failingTestFiles(log)).toEqual([]);
  });

  it('are found in a plain log too, each file once', () => {
    const log = [' FAIL  tests/x.test.ts > a > b', ' FAIL  tests/x.test.ts > a > c', ' ❯ tests/x.test.ts (3 tests | 2 failed) 5ms', ' × apps/y.spec.tsx'].join('\n');
    expect(failingTestFiles(log)).toEqual(['tests/x.test.ts', 'apps/y.spec.tsx']);
  });
});

describe('the run asks vitest for plain text', () => {
  it('sends NO_COLOR, the one switch vitest\'s colors obey, beside FORCE_COLOR=0 for supports-color', () => {
    expect(runEnvironment({ PATH: '/bin', FORCE_COLOR: '3' })).toEqual({ PATH: '/bin', CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' });
  });

  it('and strips what color gets through anyway', () => {
    expect(stripAnsi(`${E}[31mred${E}[39m and ${E}[1;4mbold${E}[0m, ${E}[2Kcleared`)).toBe('red and bold, cleared');
  });
});

describe('the exit code of a chain that performed runs', () => {
  it('is 1 when any run exited non-zero or reported a failing file, else 0 — and 0 when nothing ran', () => {
    expect(chainExitCode([])).toBe(0);
    expect(chainExitCode([{ exitCode: 0, failedTests: [] }])).toBe(0);
    // #454, 2026-09-22: the whole suite exited 1 with no failing file parsed (the run-integrity
    // gate), and the chain ended 0, so the step passed and the merge read "the selected tests passed".
    expect(chainExitCode([{ exitCode: 1, failedTests: [] }])).toBe(1);
    expect(chainExitCode([{ exitCode: 0, failedTests: ['tests/x.test.ts'] }])).toBe(1);
    expect(chainExitCode([{ exitCode: 0, failedTests: [] }, { exitCode: 2, failedTests: [] }])).toBe(1);
  });
  it('agrees with what triage considers worth explaining', () => {
    for (const run of [{ exitCode: 0, failedTests: [] }, { exitCode: 1, failedTests: [] }, { exitCode: 0, failedTests: ['a'] }]) {
      expect(chainExitCode([run])).toBe(runNeedsTriage(run) ? 1 : 0);
    }
  });
});

describe('a full-mode selection is left to the suite workflow only when the caller says so', () => {
  it('skips only full mode, and only under --skip-full-run', () => {
    expect(fullRunLeftToTheSuite({ mode: 'full', tests: [] }, true)).toBe(true);
    expect(fullRunLeftToTheSuite({ mode: 'full', tests: [] }, false)).toBe(false);
    expect(fullRunLeftToTheSuite({ mode: 'subset', tests: ['tests/a.test.ts'] }, true)).toBe(false);
    expect(fullRunLeftToTheSuite({}, true)).toBe(false);
  });
});
