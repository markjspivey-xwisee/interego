// Types for `tools/lint-gate.mjs`, which is plain ESM with no build step.
//
// ★ WHY THIS FILE EXISTS. `tsconfig.check.json` compiles `tests/**/*.ts` under `strict` with
// no `allowJs`, so `import { baselineClaimFailure } from '../tools/lint-gate.mjs'` is TS7016
// — "implicitly has an 'any' type" — and the typecheck gate that runs in vitest's
// globalSetup fails the whole suite before a single test collects. A sibling `.d.mts` is
// reached through the import and joins the program even though `tools/` is outside the
// `include` globs.
//
// It declares the module's real surface rather than only the one export a test needs, so a
// second importer does not discover a half-written contract. `skipLibCheck` means nothing
// verifies these signatures against the .mjs — `tests/lint-gate-ci-claim.test.ts` is what
// pins the behaviour of the function it names, and a rename in the .mjs alone shows up
// there as "undefined is not a function".

export interface LintGateResult {
  ok: boolean;
  failures: string[];
  files: number;
  total: number;
  fatal?: string | null;
}

export declare function baselineClaimFailure(workflowText: string, pinned?: number): string | null;
export declare function runLintGate(): Promise<LintGateResult>;
export declare function lintGateReport(result: LintGateResult): string;
