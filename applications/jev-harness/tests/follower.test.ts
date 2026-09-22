/**
 * The follower's two run decisions: a chain that saw a run fail ends 1 (the judge step it runs
 * in is red when the tests are), and a full-mode selection is left to the suite workflow when
 * the caller says so.
 */
import { describe, expect, it } from 'vitest';
import { chainExitCode, fullRunLeftToTheSuite, runNeedsTriage } from '../src/follower.js';

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
