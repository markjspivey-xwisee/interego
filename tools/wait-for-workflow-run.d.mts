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
  /** For pull_request and pull_request_target, the pull request a run is a try of: runs of one
   *  workflow for one event are tries of one check only for the same pull request (a head can be
   *  the head of two, to two bases). A run that lists none (GitHub lists none for a fork's branch)
   *  or more than one stands alone, like a dispatch: only its own re-run answers it. */
  readonly pull_requests?: readonly { readonly number?: number | null; readonly base?: { readonly ref?: string } | null }[] | null;
  readonly check_suite_id?: number | string;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  /** When the run was made (a re-run keeps it): only a run of its group made after it can answer it. */
  readonly created_at?: string;
  /** When the run last changed: once it has concluded, when it finished (a re-run moves it on).
   *  What did not pass is answered only by a newer run of its group made after this, or whose
   *  every try at each job that went red in it started in the second its tries ended or later:
   *  when the last of the run's listed jobs ended, unless that is more than a second before this,
   *  and then the second before this. GitHub usually writes it in the second the last job ended,
   *  but not always: jev-harness run 40517341630 reads 14:07:56, while its last job ended at
   *  14:03:03, because a skipped job was created at 14:07:10. And the check runs carry no attempt,
   *  so a listing behind a re-run still shows the try before it. A job of a concluded run that
   *  started after this, or concluded red after it, means the listings have not caught up. */
  readonly updated_at?: string;
  /** Which try of the run the listing shows. Its own conclusion is its latest try's, which is what
   *  the wait reads; this is read only to tell, of a run an earlier poll read red, whether it has
   *  been re-run since (a larger number). */
  readonly run_attempt?: number;
  /** Not read. */
  readonly run_started_at?: string;
  readonly html_url?: string;
}

/** A check run as GitHub's check-runs listing gives it, as far as the checks wait reads it. */
export interface CheckRunLike {
  readonly id: number | string;
  readonly name?: string;
  readonly status?: string | null;
  readonly conclusion?: string | null;
  /** Whether a try started after something else finished: a newer run's try at a job that went
   *  red in an older run, after that run's tries ended, and another app's later check run of a
   *  name, after a red one concluded; and whether a job of a concluded run started after the run's
   *  updated_at. Whole seconds: for the first two, the same second counts as after, though the try
   *  may have begun up to a second before; for the third, a job that started (or went red) in the
   *  run's updated_at second is not counted as after it, since a run's last job usually ends in
   *  that second. */
  readonly started_at?: string | null;
  /** When it concluded: read for another app's check, to say when a run's tries ended (and when
   *  it finished, when its listing gives no updated_at), and to tell a red that concluded after
   *  its run did. */
  readonly completed_at?: string | null;
  /** GitHub's page for it. Only a github-actions check run whose page is a job of a workflow run
   *  (`/actions/runs/<run>/job/<job>`) is that run's job; any other github-actions check run was
   *  created through the API (its page is `/<owner>/<repo>/runs/<id>`). */
  readonly html_url?: string | null;
  /** Whatever the check's creator set: never read to say which run a check run belongs to. A
   *  check run with neither page is matched to this workflow's own runs (or an advisory suite's)
   *  by its check suite. */
  readonly details_url?: string | null;
  /** Another app's checks are one per name in their check suite. */
  readonly check_suite?: { readonly id?: number | string | null } | null;
  /** `github-actions` for a workflow's jobs, and for a report a workflow created with GITHUB_TOKEN.
   *  A report is answered by nothing: no later report of its name can be shown to be the same
   *  check tried again, so a red one refuses until the next push. */
  readonly app?: { readonly id?: number | string; readonly slug?: string } | null;
}

/** A run an earlier poll read red, as otherChecksState returned it in `kept`. */
export interface KeptRun {
  readonly id: number | string;
  readonly name?: string;
  /** The try read red: the run listed with a larger one has been re-run since. */
  readonly run_attempt: number;
  /** What it was refused with, as `failed` named it then. */
  readonly failed: readonly string[];
  /** The check runs listed as its jobs when it was read. Until a listing shows it re-run, it is read
   *  with these beside the ones listed now, so a listing that leaves one out does not take that job
   *  out of it: a newer run must still have run each of its red jobs again, its last job's end
   *  still times a newer try, and a run with a job listed is never read as one that ran nothing. */
  readonly jobs: readonly CheckRunLike[];
}

/** What earlier polls read red, carried from one reading to the next by identity, not as a word. */
export interface KeptReds {
  readonly runs: readonly KeptRun[];
  /** Another app's check runs and reports, as they were read red. */
  readonly checks: readonly CheckRunLike[];
}

/**
 * What the two listings say about every check on the head but this workflow's own (and the
 * suite's, when `suiteGates` is false: its word is then advisory, and counted here it would gate).
 * `detail` names what failed or was still running, and for a red that a newer run of its group
 * left standing, why, and what answers it. `kept` is what the previous poll's call returned in
 * `kept`: a run's red stands until a listing shows that run re-run and passed (a larger
 * run_attempt) or answered by a newer run of its group that has concluded (or, for a run that
 * ran nothing, until a newer run of its group has concluded), another app's until a later check
 * run of its name answers it, and a report's always. A newer run still going answers a red only
 * for now: the red is not refused, but it is kept, as is a red first read beside such a run. A
 * listing that leaves it out, that leaves out a job it was read with, or that cannot be trusted
 * does not let it go.
 */
export declare function otherChecksState(
  runs: readonly WorkflowRunLike[],
  checkRuns: readonly CheckRunLike[],
  opts: { selfRunId: string | number | undefined; suite?: string; suiteGates?: boolean; kept?: KeptReds },
): { state: 'success' | 'failure' | 'pending' | 'untrusted'; failed: string[]; pending: string[]; passed: number; left: number; detail: string; kept: KeptReds };

/** Every item of a paginated GitHub listing; throws with `status` on a refused answer. */
export declare function listAll(
  url: string,
  key: string,
  opts: { token: string; fetchFn?: typeof fetch; maxPages?: number },
): Promise<unknown[]>;

export declare function listWorkflowRuns(sha: string, opts: { repo: string; token: string; fetchFn?: typeof fetch; maxPages?: number }): Promise<unknown[]>;
export declare function listCheckRuns(sha: string, opts: { repo: string; token: string; fetchFn?: typeof fetch; maxPages?: number }): Promise<unknown[]>;

/**
 * The wait: the suite's word and the other checks' word, within one deadline. The checks are read
 * again on every poll until the wait returns, with what earlier polls read red carried by identity
 * (`kept`), so a red re-run and passed during the wait is let go, and one a listing leaves out is
 * not; a red read once the suite's word is in ends the wait there.
 */
export declare function waitForHead(opts: {
  sha: string;
  repo: string;
  token: string;
  self: string;
  suite?: string;
  selfRunId?: string | number;
  checksGate?: boolean;
  suiteGate?: boolean;
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
