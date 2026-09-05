// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** How many concluded runs must exist before "nothing failed" is allowed to mean anything. */
export declare const MIN_RUNS: number;

/** One workflow run's state, as this gate reads it. */
export interface RunSnapshot {
  readonly name: string;
  readonly status: string | null | undefined;
  readonly conclusion: string | null | undefined;
}

/** Workflow runs for `sha`, excluding the calling workflow's own run. */
export declare function runsForSha(
  sha: string,
  opts: { repo: string; token: string; self: string; fetchFn?: typeof fetch },
): Promise<RunSnapshot[]>;

/** Green / not-yet / red / cannot-be-trusted, given a snapshot of runs. */
export declare function verdict(
  runs: readonly RunSnapshot[],
  minRuns?: number,
): {
  state: 'green' | 'red' | 'pending' | 'too-few';
  pending: string[];
  failed: string[];
  detail?: string;
};
