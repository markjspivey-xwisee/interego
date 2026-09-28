// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** The repository root the tool works from. */
export declare const ROOT: string;
/** The trees the base must run without. */
export declare const REMOVED: readonly string[];
/** Tests in base directories that reach a vertical, pinned per runner. */
export declare const REACHING_PINS: Readonly<{ vitest: number; relay: number; program: number }>;
/** Where `--plan` writes the classified set and its tsconfig. */
export declare const PLAN_DIR: string;
export declare const PLAN_FILE: string;

/** Why a test module is not base, or undefined when its closure stays inside the base. */
export declare function reachesVertical(file: string, packages?: Set<string>): string | undefined;

/** The relay's own test chain, as the steps its `test` script runs, `npm run` expanded. */
export declare function relaySteps(): string[];

export interface BaseTestSet {
  /** Repo-relative vitest modules whose closure stays inside the base. */
  vitest: string[];
  reachingVitest: Array<{ file: string; why: string }>;
  /** Relay steps (typechecks and base scripts) to run in `deploy/mcp-relay`. */
  relay: string[];
  reachingRelay: Array<{ step: string; why: string }>;
  /** Files the relay's test program compiles that reach a vertical, relative to the relay. */
  reachingProgram: Array<{ file: string; why: string }>;
}
export declare function baseTestSet(): BaseTestSet;

/** The pins' verdict: empty when both counts are exactly at their pins. */
export declare function judgeReaching(
  set: Pick<BaseTestSet, 'reachingVitest' | 'reachingRelay' | 'reachingProgram'>,
  pins?: Readonly<{ vitest: number; relay: number; program: number }>,
): string[];
