// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.

/** How many concluded runs must exist before "nothing failed" is allowed to mean anything. */
export declare const MIN_RUNS: number;

/** Workflows that run on every push to master; their presence proves the listing is real. */
export declare const REQUIRED_RUNS: readonly string[];

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
  required?: readonly string[],
): {
  state: 'green' | 'red' | 'pending' | 'too-few';
  pending: string[];
  failed: string[];
  detail?: string;
};

/** What the loop does with a verdict once the clock is known: deploy, refuse, or poll again. */
export declare function nextStep(
  v: { state: 'green' | 'red' | 'pending' | 'too-few' },
  expired: boolean,
): 'deploy' | 'refuse' | 'wait';

/** Whether a failed listing (a 5xx from GitHub) is polled again rather than refused. */
export declare function retryable(err: unknown): boolean;
