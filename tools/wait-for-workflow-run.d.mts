// See railway-services.d.mts for why these declarations exist at all: TS7016 in a test that
// imports a .mjs tool fails the typecheck globalSetup, which takes down the whole suite rather
// than one file.
import type { RunSnapshot } from './ci-green-for-sha.mjs';

/** The workflow that runs the whole root suite on a pull request. */
export declare const SUITE_WORKFLOW: string;

/** Conclusions that do not stop the merge: success, neutral, skipped. */
export declare const PASSING_CONCLUSIONS: readonly string[];

/** Pages of 100 a listing may run to before it is refused rather than read in part. */
export declare const MAX_PAGES: number;

/** What a whole listing says about the suite run on a head: success, absent, untrusted, pending, or the run's conclusion. */
export declare function suiteState(
  runs: readonly RunSnapshot[],
  opts: { suite?: string; self: string },
): { state: string; detail: string; url?: string };

/** Whether the loop asks again: pending or untrusted, while time remains. */
export declare function keepWaiting(state: string, expired: boolean): boolean;

/** A workflow run as GitHub's runs listing gives it, as far as the checks wait reads it. */
export interface WorkflowRunLike {
  readonly id: number | string;
  readonly name?: string;
  readonly workflow_id?: number | string;
  readonly event?: string;
  readonly check_suite_id?: number | string;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly created_at?: string;
  readonly html_url?: string;
}

/** A check run as GitHub's check-runs listing gives it, as far as the checks wait reads it. */
export interface CheckRunLike {
  readonly id: number | string;
  readonly name?: string;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly html_url?: string | null;
  readonly details_url?: string | null;
  readonly check_suite?: { readonly id?: number | string | null } | null;
  readonly app?: { readonly id?: number | string; readonly slug?: string } | null;
}

/** What the two listings say about every check on the head but this workflow's own. */
export declare function otherChecksState(
  runs: readonly WorkflowRunLike[],
  checkRuns: readonly CheckRunLike[],
  opts: { selfRunId: string | number | undefined },
): { state: 'success' | 'failure' | 'pending' | 'untrusted'; failed: string[]; pending: string[]; passed: number; left: number; detail: string };

/** Every item of a paginated GitHub listing; throws with `status` on a refused answer. */
export declare function listAll(
  url: string,
  key: string,
  opts: { token: string; fetchFn?: typeof fetch; maxPages?: number },
): Promise<unknown[]>;

export declare function listWorkflowRuns(sha: string, opts: { repo: string; token: string; fetchFn?: typeof fetch; maxPages?: number }): Promise<unknown[]>;
export declare function listCheckRuns(sha: string, opts: { repo: string; token: string; fetchFn?: typeof fetch; maxPages?: number }): Promise<unknown[]>;

/** The wait: the suite's word and the other checks' word, within one deadline. */
export declare function waitForHead(opts: {
  sha: string;
  repo: string;
  token: string;
  self: string;
  suite?: string;
  selfRunId?: string | number;
  checksGate?: boolean;
  timeoutMs: number;
  pollMs: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<{
  suite?: { result: string; url: string; detail: string };
  checks: { result: string; detail: string };
  fatal?: string;
}>;
