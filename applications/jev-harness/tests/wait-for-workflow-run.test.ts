/**
 * The wait before the gated auto-merge: what a listing means for the whole suite and for every
 * other check on the head, when to ask again, how the deadline ends it, and that the judge
 * workflow runs it with the names the tool expects and hands both words to the decision.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_PAGES, PASSING_CONCLUSIONS, SUITE_WORKFLOW, keepWaiting, listAll, otherChecksState, suiteState, waitForHead,
  type CheckRunLike, type WorkflowRunLike,
} from '../../../tools/wait-for-workflow-run.mjs';
import { retryable } from '../../../tools/ci-green-for-sha.mjs';
import { autoMergeDecision } from '../src/auto-merge.js';

const SELF = 'jev-harness (System One judgments)';
const self = { name: SELF, status: 'in_progress', conclusion: null };
const run = (status: string, conclusion: string | null, url = 'https://github.com/o/r/actions/runs/1') => ({ name: SUITE_WORKFLOW, status, conclusion, url });

describe('what a listing says about the suite on this head', () => {
  it('success when the suite concluded success, with its page', () => {
    expect(suiteState([self, run('completed', 'success')], { self: SELF })).toEqual({ state: 'success', detail: 'Bridge Typecheck concluded success', url: 'https://github.com/o/r/actions/runs/1' });
  });
  it('the conclusion itself when it was anything else — failure, cancelled, timed_out are all refusals', () => {
    expect(suiteState([self, run('completed', 'failure')], { self: SELF }).state).toBe('failure');
    expect(suiteState([self, run('completed', 'cancelled')], { self: SELF }).state).toBe('cancelled');
    expect(suiteState([self, run('completed', null)], { self: SELF }).state).toBe('unknown');
  });
  it('pending while the suite runs, even when an older run of it already concluded', () => {
    const s = suiteState([self, run('in_progress', null, 'https://github.com/o/r/actions/runs/2'), run('completed', 'failure')], { self: SELF });
    expect(s).toMatchObject({ state: 'pending', url: 'https://github.com/o/r/actions/runs/2' });
  });
  it('★ absent only when the listing holds this job\'s own run; a listing without it is untrusted, not green', () => {
    // 2026-09-21, 0f40814b: GitHub answered a run listing with an empty list mid-run. Read as
    // "no suite for this head", that would merge without the suite; the job's own run is the one
    // run that certainly exists, so its absence means the listing is short, not the suite.
    expect(suiteState([self, { name: 'ESLint', status: 'completed', conclusion: 'success' }], { self: SELF }).state).toBe('absent');
    expect(suiteState([{ name: 'ESLint', status: 'completed', conclusion: 'success' }], { self: SELF }).state).toBe('untrusted');
    expect(suiteState([], { self: SELF }).state).toBe('untrusted');
  });
  it('reads the newest run first, as GitHub lists them', () => {
    expect(suiteState([self, run('completed', 'success', 'new'), run('completed', 'failure', 'old')], { self: SELF })).toMatchObject({ state: 'success', url: 'new' });
  });
});

describe('when the loop asks again', () => {
  it('pending and untrusted wait while time remains; nothing waits past the deadline; a conclusion never waits', () => {
    expect(keepWaiting('pending', false)).toBe(true);
    expect(keepWaiting('untrusted', false)).toBe(true);
    expect(keepWaiting('pending', true)).toBe(false);
    expect(keepWaiting('untrusted', true)).toBe(false);
    for (const s of ['success', 'failure', 'absent', 'cancelled']) expect(keepWaiting(s, false)).toBe(false);
  });
});

describe('the judge workflow runs the wait with the names the tool expects', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
  it('names the suite workflow as bridge-typecheck.yml names itself, and its own name as SELF_WORKFLOW', () => {
    const suite = /^name:\s*(.+?)\s*$/m.exec(read('.github/workflows/bridge-typecheck.yml'))?.[1];
    expect(suite).toBe(SUITE_WORKFLOW);
    const judge = read('.github/workflows/jev-harness.yml');
    const judgeName = /^name:\s*(.+?)\s*$/m.exec(judge)?.[1];
    expect(judgeName).toBeDefined();
    expect(judge).toContain('node tools/wait-for-workflow-run.mjs');
    expect(judge).toContain(`SELF_WORKFLOW: ${judgeName}`);
    expect(judge, 'the decision must read the word the wait wrote').toContain('--suite-result');
  });
  it('★ hands the decision the checks word too, passes the run\'s own id, and may read what it lists', () => {
    const judge = read('.github/workflows/jev-harness.yml');
    expect(judge, 'the decision must read the checks word the wait wrote').toContain('CHECKS_RESULT: ${{ steps.suite.outputs.checks }}');
    expect(judge).toContain('CHECKS_DETAIL: ${{ steps.suite.outputs.checks_detail }}');
    expect(judge).toContain('--checks-result "$CHECKS_RESULT" --checks-gates "$CHECKS_GATES" --checks-detail "$CHECKS_DETAIL"');
    expect(judge, 'the switch gates unless it is exactly false, in both places').toContain("CHECKS_GATE: ${{ env.JEV_MERGE_WAITS_FOR_CHECKS != 'false' }}");
    expect(judge).toContain("CHECKS_GATES: ${{ env.JEV_MERGE_WAITS_FOR_CHECKS != 'false' }}");
    expect(judge, 'an advisory suite is left out of the checks word, or it gates there after all').toContain("SUITE_GATE: ${{ env.JEV_MERGE_WAITS_FOR_SUITE != 'false' }}");
    // GITHUB_RUN_ID is the runner's own default variable; setting it in env: would be a second, wrong id.
    expect(judge).not.toMatch(/^\s+GITHUB_RUN_ID:/m);
  });
  it('★ grants the two reads to the judge job alone: the close-time job lists neither runs nor check runs', () => {
    const judge = read('.github/workflows/jev-harness.yml');
    const block = (text: string, indent: string) => new RegExp(`^${indent}permissions:\\n((?:${indent}  .+\\n)+)`, 'm').exec(text)?.[1] ?? '';
    const workflow = block(judge, '');
    expect(workflow).toMatch(/^ {2}contents: read\b/m);
    expect(workflow).toMatch(/^ {2}pull-requests: write\b/m);
    expect(workflow).not.toMatch(/actions:|checks:/);
    const judgeJob = /^ {2}judge:\n([\s\S]*?)^ {2}outcomes-on-close:/m.exec(judge)?.[1] ?? '';
    const own = block(judgeJob, '    ');
    // A job's block replaces the workflow's, so the two the judge still needs are restated beside the reads.
    for (const scope of ['contents: read', 'pull-requests: write', 'actions: read', 'checks: read']) expect(own, scope).toMatch(new RegExp(`^ {6}${scope}\\b`, 'm'));
    const close = judge.slice(judge.search(/^ {2}outcomes-on-close:/m));
    expect(close).toContain('bin/outcomes-on-close.ts');
    expect(close).not.toMatch(/^\s+permissions:/m);
  });
});

// ── every other check on the head ──────────────────────────────────────────────────────────
//
// Shaped on the listings GitHub gave for #716's head (c91c2e71) on 2026-10-27: one workflow run
// per workflow, one check suite per run, a check run per job whose page names its run.

const JEV = 362411169;
const SELF_RUN = 40509213061;
const wfRun = (id: number, name: string, workflowId: number, over: Partial<WorkflowRunLike> = {}): WorkflowRunLike => ({
  id, name, workflow_id: workflowId, event: 'pull_request', check_suite_id: id + 1, status: 'completed', conclusion: 'success',
  created_at: '2026-10-27T13:06:52Z', html_url: `https://github.com/o/r/actions/runs/${id}`, ...over,
});
let jobIds = 1000;
// A completed job concludes a minute after it started unless the fixture says when.
const aMinuteAfter = (at: string | null | undefined) => (at ? new Date(Date.parse(at) + 60_000).toISOString().replace('.000Z', 'Z') : null);
const job = (r: WorkflowRunLike, name: string, over: Partial<CheckRunLike> = {}): CheckRunLike => {
  const id = jobIds++;
  const c: CheckRunLike = {
    id, name, status: 'completed', conclusion: 'success', started_at: '2026-10-27T13:07:00Z',
    check_suite: { id: r.check_suite_id ?? null }, app: { id: 15368, slug: 'github-actions' },
    html_url: `https://github.com/o/r/actions/runs/${r.id}/job/${id}`, ...over,
  };
  return 'completed_at' in over || c.status !== 'completed' ? c : { ...c, completed_at: aMinuteAfter(c.started_at) };
};
const selfRun = wfRun(SELF_RUN, 'jev-harness (System One judgments)', JEV, { status: 'in_progress', conclusion: null });
const suite = wfRun(40509213003, 'Bridge Typecheck', 314585613);
const mutation = wfRun(40509213085, 'Mutation Gate', 348733029);
const base = wfRun(40509212952, 'Base without verticals', 369488824);
const MUTANT = 'Every refusal gate fails on its own defect';
const ownJobs = [job(selfRun, 'select tests → run → gate → decide', { status: 'in_progress', conclusion: null }), job(selfRun, 'score the judgments when the pull request closes', { conclusion: 'skipped' })];
const green = () => ({
  runs: [selfRun, suite, mutation, base],
  checkRuns: [...ownJobs, job(suite, 'The whole root test suite: everything else, first half'), job(suite, 'MCP surface typecheck'), job(mutation, MUTANT), job(base, 'Emergence with the verticals; the base without them')],
});
// GitHub concludes a run from the jobs of its latest try. These fixtures give each job its
// conclusion and leave most runs at the default success, so a completed run left at success
// takes the conclusion of the first of its jobs (a github-actions check run whose page is a job
// of it) that did not pass, as GitHub would. A job that may fail (continue-on-error) is the
// exception: the tests that need one call otherChecksState directly, as this would read it into
// the run. A run re-run is concluded from its latest try alone, so its fixture states its conclusion.
const concluded = (runs: readonly WorkflowRunLike[], checkRuns: readonly CheckRunLike[]): WorkflowRunLike[] => runs.map((r) => {
  if (r.status !== 'completed' || r.conclusion !== 'success' || Number(r.run_attempt ?? 1) > 1) return r;
  const red = checkRuns.find((c) => c.app?.slug === 'github-actions' && String(c.html_url ?? '').includes(`/actions/runs/${r.id}/job/`) && c.status === 'completed' && !['success', 'neutral', 'skipped'].includes(String(c.conclusion)));
  return red ? { ...r, conclusion: red.conclusion ?? 'failure' } : r;
});
const state = (runs: readonly WorkflowRunLike[], checkRuns: readonly CheckRunLike[]) => otherChecksState(concluded(runs, checkRuns), checkRuns, { selfRunId: String(SELF_RUN) });
// A reopen: jev-harness runs on `reopened`, and so does every pull_request workflow with the
// default activity types, so the head gets a second run of each for the same event. The ESLint
// run from `opened` concluded red (the usual reason to close and reopen).
const ESLINT = 311111111;
const lintOld = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:41:30Z' });
const lintOldJob = () => job(lintOld, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' });
const lintNew = (over: Partial<WorkflowRunLike> = {}) => wfRun(40509213300, 'ESLint', ESLINT, { status: 'queued', conclusion: null, ...over });

describe('★ every other check on the head: what the two listings say', () => {
  it('success when every other check concluded, with this workflow\'s own jobs (one still running) left out', () => {
    const { runs, checkRuns } = green();
    const s = state(runs, checkRuns);
    expect(s.state).toBe('success');
    expect(s.passed).toBe(4);
    expect(s.left).toBe(3); // the run itself and its two jobs
    expect(s.detail).toBe('4 check run(s) from 3 other workflow run(s) and any other app concluded success, neutral or skipped; 3 run(s) and job(s) of this workflow left out');
  });

  it('success, neutral and skipped pass, and nothing else does', () => {
    expect([...PASSING_CONCLUSIONS]).toEqual(['success', 'neutral', 'skipped']);
    for (const conclusion of ['neutral', 'skipped']) {
      const { runs, checkRuns } = green();
      expect(state(runs, [...checkRuns, job(base, `a job this pull request skips (${conclusion})`, { conclusion })]).state).toBe('success');
    }
  });

  it('★ refuses each red conclusion, naming the workflow, the job and how it ended', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', null]) {
      const { runs, checkRuns } = green();
      const s = state(runs, [...checkRuns.filter((c) => c.name !== MUTANT), job(mutation, MUTANT, { conclusion })]);
      expect(s.state, String(conclusion)).toBe('failure');
      expect(s.failed).toEqual([`Mutation Gate / ${MUTANT}: ${conclusion ?? 'no conclusion'}`]);
      expect(s.detail).toBe(`did not pass: Mutation Gate / ${MUTANT}: ${conclusion ?? 'no conclusion'}`);
    }
  });

  it('★ refuses a workflow run that never made a job: startup_failure, or action_required before approval', () => {
    for (const conclusion of ['startup_failure', 'action_required']) {
      const { runs, checkRuns } = green();
      const broken = wfRun(40509212999, 'Deploy Surface Tests', 322557169, { conclusion });
      expect(state([...runs, broken], checkRuns)).toMatchObject({ state: 'failure', failed: [`Deploy Surface Tests: ${conclusion}`] });
    }
  });

  it('a failed job and its failed run are named once, by the job', () => {
    const { runs, checkRuns } = green();
    const s = state(runs.map((r) => (r === mutation ? { ...r, conclusion: 'failure' } : r)), [...checkRuns.filter((c) => c.name !== MUTANT), job(mutation, MUTANT, { conclusion: 'failure' })]);
    expect(s.failed).toEqual([`Mutation Gate / ${MUTANT}: failure`]);
  });

  it('pending while a job runs, while a run is queued with no job yet, and while a run has its next job still to make', () => {
    const { runs, checkRuns } = green();
    const running = state(runs.map((r) => (r === mutation ? { ...r, status: 'in_progress', conclusion: null } : r)), [...checkRuns.filter((c) => c.name !== MUTANT), job(mutation, MUTANT, { status: 'in_progress', conclusion: null })]);
    expect(running).toMatchObject({ state: 'pending', pending: [`Mutation Gate / ${MUTANT}`], detail: `still running: Mutation Gate / ${MUTANT}` });
    const queued = wfRun(40509213100, 'Identity Server Tests', 326672477, { status: 'queued', conclusion: null });
    expect(state([...runs, queued], checkRuns)).toMatchObject({ state: 'pending', pending: ['Identity Server Tests (queued)'] });
    // Base's only listed job concluded, but the run has not: a job behind it is not created yet.
    expect(state(runs.map((r) => (r === base ? { ...r, status: 'in_progress', conclusion: null } : r)), checkRuns)).toMatchObject({ state: 'pending', pending: ['Base without verticals (in_progress)'] });
  });

  it('a red check is final even while others still run: nothing they conclude can make the merge', () => {
    const { runs, checkRuns } = green();
    const s = state(runs.map((r) => (r === mutation ? { ...r, status: 'in_progress', conclusion: null } : r)), [
      ...checkRuns.filter((c) => c.name !== MUTANT), job(mutation, MUTANT, { status: 'in_progress', conclusion: null }),
      job(base, 'Base on Node 22', { conclusion: 'failure' }),
    ]);
    expect(s.state).toBe('failure');
    expect(s.detail).toBe(`did not pass: Base without verticals / Base on Node 22: failure; still running: Mutation Gate / ${MUTANT}`);
    expect(keepWaiting(s.state, false)).toBe(false);
  });

  it('★ leaves out this workflow\'s own by workflow id, not by name: renamed, earlier on the head, or matched by its page alone', () => {
    const { runs, checkRuns } = green();
    // Renamed: still this workflow, still left out.
    expect(state(runs.map((r) => (r === selfRun ? { ...r, name: 'renamed' } : r)), checkRuns).state).toBe('success');
    // An earlier run of this workflow on the same head (a reopen; cancelled by the concurrency group) and its jobs.
    const earlier = wfRun(40509100000, 'jev-harness (System One judgments)', JEV, { conclusion: 'cancelled', created_at: '2026-10-27T13:00:00Z' });
    expect(state([...runs, earlier], [...checkRuns, job(earlier, 'select tests → run → gate → decide', { conclusion: 'cancelled' })]).state).toBe('success');
    // A check run of this run with no check suite in the listing is still known by its page ...
    expect(state(runs, [...checkRuns, { ...job(selfRun, 'select tests → run → gate → decide', { conclusion: 'failure' }), check_suite: null }]).state).toBe('success');
    // ... and, the only one of this run listed, it is enough to trust the listing.
    const others = checkRuns.filter((c) => !ownJobs.includes(c));
    expect(state(runs, [...others, { ...job(selfRun, 'select tests → run → gate → decide', { status: 'in_progress', conclusion: null }), check_suite: null }])).toMatchObject({ state: 'success', left: 2 });
  });

  it('★ ... and by its check suite alone: a job of this run whose listing names no run page is left out, and trusts the listing on its own', () => {
    const { runs, checkRuns } = green();
    const noPage = (over: Partial<CheckRunLike>) => ({ ...job(selfRun, 'select tests → run → gate → decide', over), html_url: null, details_url: null });
    const others = checkRuns.filter((c) => !ownJobs.includes(c));
    const s = state(runs, [...others, noPage({ status: 'in_progress', conclusion: null })]);
    expect(s.state).toBe('success');
    expect(s.left).toBe(2); // the run and that one job
    expect(state(runs, [...others, noPage({ status: 'in_progress', conclusion: null }), noPage({ conclusion: 'failure' })])).toMatchObject({ state: 'success', left: 3 });
  });

  it('★ counts another workflow that merely carries this workflow\'s name', () => {
    const { runs, checkRuns } = green();
    const impostor = wfRun(40509213200, 'jev-harness (System One judgments)', 999, { conclusion: 'failure' });
    expect(state([...runs, impostor], [...checkRuns, job(impostor, 'select tests → run → gate → decide', { conclusion: 'failure' })])).toMatchObject({
      state: 'failure', failed: ['jev-harness (System One judgments) / select tests → run → gate → decide: failure'],
    });
  });

  it('★ reads the latest attempt of a rerun job, whichever way it went', () => {
    const { runs, checkRuns } = green();
    const others = checkRuns.filter((c) => c.name !== MUTANT);
    // A re-run makes the run's latest try, and GitHub concludes the run from it: the run's own
    // conclusion is the latest attempt's. The listing (filter=latest) holds the re-run job's new
    // check run; listed beside the first try's, the order decides nothing.
    const rerunRun = (conclusion: string) => ({ ...mutation, conclusion, run_attempt: 2, run_started_at: '2026-10-27T13:39:00Z' });
    const withRerun = (conclusion: string) => runs.map((r) => (r === mutation ? rerunRun(conclusion) : r));
    const attempts = (first: string, rerun: string) => {
      const a = job(mutation, MUTANT, { conclusion: first, started_at: '2026-10-27T13:07:00Z' });
      const b = job(mutation, MUTANT, { conclusion: rerun, started_at: '2026-10-27T13:40:00Z' });
      return [b, a];
    };
    for (const order of [(l: CheckRunLike[]) => l, (l: CheckRunLike[]) => [...l].reverse()]) {
      expect(state(withRerun('success'), order([...others, ...attempts('failure', 'success')])).state).toBe('success');
      expect(state(withRerun('failure'), order([...others, ...attempts('success', 'failure')])).state).toBe('failure');
    }
    // Two check runs of one name in one try (matrix legs that share a name), one red: GitHub
    // concludes the run failure, and so does the wait.
    expect(state(runs, [...others, ...attempts('failure', 'success')])).toMatchObject({ state: 'failure', failed: [`Mutation Gate / ${MUTANT}: failure`] });
    // A re-run still going: the run has not concluded, so it is pending, whatever its first try said.
    const runningAgain = { ...mutation, status: 'in_progress', conclusion: null, run_attempt: 2, run_started_at: '2026-10-27T13:30:00Z' };
    const red = job(mutation, MUTANT, { conclusion: 'failure', started_at: '2026-10-27T13:07:00Z' });
    const queued = job(mutation, MUTANT, { status: 'queued', conclusion: null, started_at: null });
    for (const order of [(l: CheckRunLike[]) => l, (l: CheckRunLike[]) => [...l].reverse()]) {
      const s = state(runs.map((r) => (r === mutation ? runningAgain : r)), order([...others, red, queued]));
      expect(s).toMatchObject({ state: 'pending', failed: [] });
      expect(s.pending).toContain(`Mutation Gate / ${MUTANT}`);
    }
  });

  it('★ reads the newest run of a workflow for an event, and leaves the superseded one out with its jobs', () => {
    const { runs, checkRuns } = green();
    const old = wfRun(40509000000, 'Mutation Gate', 348733029, { conclusion: 'cancelled', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, old], [...checkRuns, job(old, MUTANT, { conclusion: 'cancelled', started_at: '2026-10-27T12:50:30Z' })]).state).toBe('success');
    // A run for another event is not superseded by this one: both checked the head.
    const push = wfRun(40509000001, 'Mutation Gate', 348733029, { event: 'push', conclusion: 'failure', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, push], [...checkRuns, job(push, MUTANT, { conclusion: 'failure', started_at: '2026-10-27T12:50:30Z' })])).toMatchObject({ state: 'failure', failed: [`Mutation Gate / ${MUTANT}: failure`] });
  });

  // build-ghcr.yml has no concurrency group and names each leg `${{ matrix.image }}`, and #673,
  // #675 and #676 each had a dispatch of it on their heads: two dispatches for two images are
  // two runs of one workflow for one event, with jobs of different names.
  const GHCR = 330000001;
  const relayRun = (over: Partial<WorkflowRunLike> = {}) => wfRun(40509300000, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', created_at: '2026-10-27T13:01:00Z', ...over });
  const identityRun = wfRun(40509300100, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', created_at: '2026-10-27T13:03:00Z' });
  const identityJob = () => job(identityRun, 'identity', { started_at: '2026-10-27T13:03:30Z' });

  it('★ a newer run of a workflow does not hide an older run\'s check of another name: two GHCR dispatches, relay still running', () => {
    const { runs, checkRuns } = green();
    const relay = relayRun({ status: 'in_progress', conclusion: null });
    const s = state([...runs, relay, identityRun], [...checkRuns, job(relay, 'relay', { status: 'in_progress', conclusion: null, started_at: '2026-10-27T13:01:30Z' }), identityJob()]);
    expect(s).toMatchObject({ state: 'pending', pending: ['Build & push to GHCR / relay'] });
    // Queued, before its job exists: the run's own status says it.
    const queued = relayRun({ status: 'queued', conclusion: null });
    expect(state([...runs, queued, identityRun], [...checkRuns, identityJob()])).toMatchObject({ state: 'pending', pending: ['Build & push to GHCR (queued)'] });
  });

  it('★ two dispatches for the same image that overlapped: a red from either stands, whichever started or finished first', () => {
    const { runs, checkRuns } = green();
    // The older dispatch waited for a runner, so its job started after the newer one's, and its
    // check run was created after the newer one's too (the larger id). Neither makes it newer,
    // and neither run was made after the other's result was in: the two disagree, so no merge.
    const older = (conclusion: string) => relayRun({ conclusion });
    const newer = (conclusion: string) => wfRun(40509300100, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', created_at: '2026-10-27T13:02:00Z', conclusion });
    const both = (olderWent: string, newerWent: string, order: (l: CheckRunLike[]) => CheckRunLike[] = (l) => l) => {
      const o = older(olderWent);
      const n = newer(newerWent);
      const newerJob = job(n, 'relay', { conclusion: newerWent, started_at: '2026-10-27T13:02:30Z' });
      const olderJob = job(o, 'relay', { conclusion: olderWent, started_at: '2026-10-27T13:10:00Z' });
      return state([...runs, o, n], order([...checkRuns, olderJob, newerJob]));
    };
    for (const order of [(l: CheckRunLike[]) => l, (l: CheckRunLike[]) => [...l].reverse()]) {
      // The newer run's red refuses, though the older run's job passed after it.
      expect(both('success', 'failure', order)).toMatchObject({ state: 'failure', failed: ['Build & push to GHCR / relay: failure'] });
      // The older run's red concluded after the newer run was made: the newer green cannot answer it.
      expect(both('failure', 'success', order)).toMatchObject({ state: 'failure', failed: ['Build & push to GHCR / relay: failure'] });
      expect(both('success', 'success', order)).toMatchObject({ state: 'success', failed: [], pending: [] });
    }
  });

  it('★ a newer run answers a red when it tried again after the red run finished: made after that, or each try at the red job started after; a skip, or a try that overlapped it, does not', () => {
    const { runs, checkRuns } = green();
    // The older run's job went red at 12:41:30 (a minute after it started), when the run finished.
    const red = () => job(lintOld, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' });
    // A newer run made after it, all green: it answers the red.
    const after = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, lintOld, after], [...checkRuns, red(), job(after, 'lint', { started_at: '2026-10-27T12:50:30Z' })]).state).toBe('success');
    // A newer run made after it whose job was skipped (an event its condition leaves out): a skip is not a result.
    const skipped = lintNew({ status: 'completed', conclusion: 'skipped', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, lintOld, skipped], [...checkRuns, red(), job(skipped, 'lint', { conclusion: 'skipped', started_at: '2026-10-27T12:50:05Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
    // A newer run made while the red was still running (12:41:00), whose lint started then too, green:
    // the two overlapped and disagree. The detail names the remedy.
    const during = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:41:00Z' });
    expect(state([...runs, lintOld, during], [...checkRuns, red(), job(during, 'lint', { started_at: '2026-10-27T12:41:10Z' })])).toMatchObject({
      state: 'failure', failed: ['ESLint / lint: failure'],
      detail: 'did not pass: ESLint / lint: failure (ESLint run 40509000100 is not answered by the newer run 40509213300, which started lint before the red run finished: re-run 40509000100, or reopen)',
    });
    // ... and while that newer run is still going, with its lint already started then, the red refuses at once.
    const duringOpen = lintNew({ status: 'in_progress', conclusion: null, created_at: '2026-10-27T12:41:00Z' });
    expect(state([...runs, lintOld, duringOpen], [...checkRuns, red(), job(duringOpen, 'lint', { status: 'in_progress', conclusion: null, started_at: '2026-10-27T12:41:10Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
    // A newer run made while the red ran but held (a concurrency group with cancel-in-progress
    // false holds it, with no job, until the red run ends): it may yet try lint after the red, so it
    // answers for now ...
    expect(state([...runs, lintOld, duringOpen], [...checkRuns, red()])).toMatchObject({ state: 'pending', failed: [], pending: ['ESLint (in_progress)'] });
    // ... its lint queued and not started yet, the same ...
    expect(state([...runs, lintOld, duringOpen], [...checkRuns, red(), job(duringOpen, 'lint', { status: 'queued', conclusion: null, started_at: null })]))
      .toMatchObject({ state: 'pending', failed: [], pending: ['ESLint / lint'] });
    // ... and once it ran lint after the red run finished and went green, it answers it, like a re-run.
    const held = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:41:00Z' });
    expect(state([...runs, lintOld, held], [...checkRuns, red(), job(held, 'lint', { started_at: '2026-10-27T12:41:40Z' })]).state).toBe('success');
    // GitHub's times are whole seconds: a try started in the second the red run finished is after it.
    expect(state([...runs, lintOld, held], [...checkRuns, red(), job(held, 'lint', { started_at: '2026-10-27T12:41:30Z' })]).state).toBe('success');
    // Every try of it counts: a second leg of lint that started during the red overlapped it.
    expect(state([...runs, lintOld, held], [...checkRuns, red(), job(held, 'lint', { started_at: '2026-10-27T12:41:40Z' }), job(held, 'lint', { started_at: '2026-10-27T12:41:20Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
    // A cancel is answered the same way. A concurrency group's cancel-in-progress, landing as a
    // reopen starts the newer run, lands before that run's job starts: the newer run answers it.
    const cancelled = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:40:00Z' });
    const cancelledJob = () => job(cancelled, 'lint', { conclusion: 'cancelled', started_at: '2026-10-27T12:40:30Z', completed_at: '2026-10-27T12:41:02Z' });
    const during2 = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:41:00Z' });
    expect(state([...runs, cancelled, during2], [...checkRuns, cancelledJob(), job(during2, 'lint', { started_at: '2026-10-27T12:41:10Z' })]).state).toBe('success');
    // One that landed after the newer run's lint had started (a cancel by hand of the stale run, or
    // a job that timed out, which GitHub lists as cancelled too) is not: the newer run's try may
    // never have answered a hang. No merge; re-run it, or reopen.
    expect(state([...runs, cancelled, during2], [...checkRuns, cancelledJob(), job(during2, 'lint', { started_at: '2026-10-27T12:41:01Z' })])).toMatchObject({
      state: 'failure', failed: ['ESLint / lint: cancelled'],
      detail: 'did not pass: ESLint / lint: cancelled (ESLint run 40509000100 is not answered by the newer run 40509213300, which started lint before the red run finished: re-run 40509000100, or reopen)',
    });
    // A run made after the cancel landed answers it.
    const after2 = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:42:00Z' });
    expect(state([...runs, cancelled, after2], [...checkRuns, cancelledJob(), job(after2, 'lint', { started_at: '2026-10-27T12:42:10Z' })]).state).toBe('success');
    // An older run's job still running is replaced by nothing: what it concludes may be red.
    const stillRunning = wfRun(40509000100, 'ESLint', ESLINT, { status: 'in_progress', conclusion: null, created_at: '2026-10-27T12:40:00Z' });
    expect(state([...runs, stillRunning, after], [...checkRuns,
      job(stillRunning, 'lint', { status: 'in_progress', conclusion: null, started_at: '2026-10-27T12:40:30Z' }),
      job(after, 'lint', { started_at: '2026-10-27T12:50:30Z' })])).toMatchObject({ state: 'pending', pending: ['ESLint / lint'] });
  });

  it('★ a re-run of an older run tests the merge commit of its own event: it never answers a newer run, and its red after the newer run refuses', () => {
    const { runs, checkRuns } = green();
    // The older run went red at 12:41:30, the reopen made the newer run at 13:06:52, and then, at
    // 13:29, the older run's lint was re-run. A re-run keeps its event's GITHUB_SHA, which for
    // pull_request is the merge commit with the base as it was then.
    const older = (conclusion: string) => wfRun(40509000100, 'ESLint', ESLINT, { conclusion, created_at: '2026-10-27T12:40:00Z', run_attempt: 2, run_started_at: '2026-10-27T13:29:00Z', updated_at: '2026-10-27T13:31:00Z' });
    const listing = (newerWent: string, rerunWent: string) => {
      const o = older(rerunWent);
      const n = lintNew({ status: 'completed', conclusion: newerWent });
      const newerJob = job(n, 'lint', { conclusion: newerWent, started_at: '2026-10-27T13:07:00Z' });
      const rerun = job(o, 'lint', { conclusion: rerunWent, started_at: '2026-10-27T13:30:00Z' });
      return state([...runs, o, n], [...checkRuns, rerun, newerJob]);
    };
    // The re-run's red finished after the newer run was made: nothing made after it answers it.
    expect(listing('success', 'failure')).toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
    // The newer run's red is answered only by a run made after it, and the re-run's run was made before it.
    expect(listing('failure', 'success')).toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
    expect(listing('success', 'success').state).toBe('success');
  });

  it('★ a cancelled re-run of a red does not hide it: the newer run made before the re-run cannot answer what the re-run left', () => {
    const { runs, checkRuns } = green();
    // The older run's lint went red at 12:45, after the newer run was made at 12:43 (they
    // overlapped), and the newer run went green. At 13:00 the older lint was re-run and the re-run
    // was cancelled. The listing (filter=latest) holds only the cancelled try.
    const older = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:40:00Z', run_attempt: 2, run_started_at: '2026-10-27T13:00:00Z' });
    const newer = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:43:00Z' });
    const redTry = () => job(older, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z', completed_at: '2026-10-27T12:45:00Z' });
    const cancelledTry = () => job(older, 'lint', { conclusion: 'cancelled', started_at: '2026-10-27T13:00:10Z', completed_at: '2026-10-27T13:02:00Z' });
    const newerLint = () => job(newer, 'lint', { started_at: '2026-10-27T12:43:30Z', completed_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, older, newer], [...checkRuns, cancelledTry(), newerLint()])).toMatchObject({ state: 'failure', failed: ['ESLint / lint: cancelled'] });
    // Every try listed: the red stands, and the cancel answers nothing.
    expect(state([...runs, older, newer], [...checkRuns, redTry(), cancelledTry(), newerLint()])).toMatchObject({ state: 'failure' });
    // A matrix leg cancelled by fail-fast beside a red leg of the same name: the cancel does not replace the red.
    const leg = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z' });
    const overlap = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:43:00Z' });
    expect(state([...runs, leg, overlap], [...checkRuns,
      job(leg, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z', completed_at: '2026-10-27T12:45:00Z' }),
      job(leg, 'lint', { conclusion: 'cancelled', started_at: '2026-10-27T12:40:30Z', completed_at: '2026-10-27T12:45:01Z' }),
      job(overlap, 'lint', { started_at: '2026-10-27T12:43:30Z' })])).toMatchObject({ state: 'failure' });
  });

  it('★ an older run that did not pass is answered by a newer run made after it that ran its red jobs again: a reopen still merges', () => {
    const { runs, checkRuns } = green();
    // A reopen after a red, in a workflow with a job that runs only when a pull request is opened
    // (or a reporter that runs only on failure): the newer run skips it.
    const r1 = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z' });
    const r2 = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:55:00Z' });
    expect(state([...runs, r1, r2], [...checkRuns,
      job(r1, 'size-label', { started_at: '2026-10-27T12:40:20Z' }), job(r1, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:10Z' }),
      job(r2, 'size-label', { conclusion: 'skipped', started_at: '2026-10-27T12:55:05Z' }), job(r2, 'lint', { started_at: '2026-10-27T12:55:10Z' })])).toMatchObject({
      state: 'success', failed: [],
      // The older run is answered, so it is not read: six checks from the four other runs read.
      detail: '6 check run(s) from 4 other workflow run(s) and any other app concluded success, neutral or skipped; 3 run(s) and job(s) of this workflow left out',
    });
    // A run cancelled, then a run made after the cancel landed: the older run's lint passed and its
    // test was cancelled; the newer run skipped lint and ran test, green. It ran again what did not
    // pass in the older run, so it answers it.
    const c1 = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:40:00Z' });
    const c2 = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:41:00Z' });
    expect(state([...runs, c1, c2], [...checkRuns,
      job(c1, 'lint', { started_at: '2026-10-27T12:40:05Z', completed_at: '2026-10-27T12:40:20Z' }), job(c1, 'test', { conclusion: 'cancelled', started_at: '2026-10-27T12:40:10Z', completed_at: '2026-10-27T12:40:33Z' }),
      job(c2, 'lint', { conclusion: 'skipped', started_at: '2026-10-27T12:41:05Z' }), job(c2, 'test', { started_at: '2026-10-27T12:41:10Z' })]).state).toBe('success');
    // The same, but the cancel landed as the newer run started (a concurrency group's cancel on one
    // head): the newer run was made before it concluded, and its test started after it landed, so
    // it answers it too ...
    const c2early = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:40:30Z' });
    const c1Jobs = () => [job(c1, 'lint', { started_at: '2026-10-27T12:40:05Z', completed_at: '2026-10-27T12:40:20Z' }), job(c1, 'test', { conclusion: 'cancelled', started_at: '2026-10-27T12:40:10Z', completed_at: '2026-10-27T12:40:33Z' })];
    expect(state([...runs, c1, c2early], [...checkRuns, ...c1Jobs(),
      job(c2early, 'lint', { conclusion: 'skipped', started_at: '2026-10-27T12:40:35Z' }), job(c2early, 'test', { started_at: '2026-10-27T12:40:40Z' })]).state).toBe('success');
    // ... while one whose test started before the cancel landed overlapped it, and does not.
    expect(state([...runs, c1, c2early], [...checkRuns, ...c1Jobs(),
      job(c2early, 'lint', { conclusion: 'skipped', started_at: '2026-10-27T12:40:35Z' }), job(c2early, 'test', { started_at: '2026-10-27T12:40:31Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / test: cancelled'] });
    // A matrix job skipped behind a red job keeps its unexpanded name, which no newer run repeats.
    const m1 = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z' });
    const m2 = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:55:00Z' });
    expect(state([...runs, m1, m2], [...checkRuns,
      job(m1, 'build', { conclusion: 'failure', started_at: '2026-10-27T12:40:10Z' }), job(m1, 'Deploy ${{ matrix.service }}', { conclusion: 'skipped', started_at: '2026-10-27T12:41:20Z' }),
      job(m2, 'build', { started_at: '2026-10-27T12:55:10Z' }), job(m2, 'Deploy relay', { started_at: '2026-10-27T12:56:10Z' })]).state).toBe('success');
    // A red, a pass and a skip in the older run; the newer run made after it ran lint again, green.
    const p1 = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z' });
    const p2 = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:45:00Z' });
    expect(state([...runs, p1, p2], [...checkRuns,
      job(p1, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' }), job(p1, 'types', { started_at: '2026-10-27T12:40:30Z' }), job(p1, 'publish', { conclusion: 'skipped', started_at: '2026-10-27T12:40:31Z' }),
      job(p2, 'lint', { started_at: '2026-10-27T12:45:30Z' }), job(p2, 'types', { started_at: '2026-10-27T12:45:30Z' }), job(p2, 'publish', { conclusion: 'skipped', started_at: '2026-10-27T12:45:31Z' })]).state).toBe('success');
  });

  it('★ a run made in the second the red concluded is not made after it; with no red job listed, only a run made after it answers; a try started before a cancel landed refuses at once', () => {
    const { runs, checkRuns } = green();
    // The red concluded at 12:41:30 (a minute after it started). A newer run made in that same
    // second, queued, has not tried lint yet: it answers for now, and decides by its own try ...
    const red = () => job(lintOld, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' });
    const same = (over: Partial<WorkflowRunLike>) => lintNew({ created_at: '2026-10-27T12:41:30Z', ...over });
    expect(state([...runs, lintOld, same({})], [...checkRuns, red()])).toMatchObject({ state: 'pending', failed: [], pending: ['ESLint (queued)'] });
    const sameGreen = same({ status: 'completed', conclusion: 'success' });
    expect(state([...runs, lintOld, sameGreen], [...checkRuns, red(), job(sameGreen, 'lint', { started_at: '2026-10-27T12:41:40Z' })]).state).toBe('success');
    // ... but a run that lists no red job (cancelled before it made the rest, here) has no try to
    // time, so only a run made strictly after it finished answers it: one made in that second does not.
    const cancelledEarly = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:41:00Z' });
    const built = () => job(cancelledEarly, 'build', { started_at: '2026-10-27T12:40:05Z', completed_at: '2026-10-27T12:40:50Z' });
    expect(state([...runs, cancelledEarly, lintNew({ created_at: '2026-10-27T12:41:00Z' })], [...checkRuns, built()])).toMatchObject({
      state: 'failure', failed: ['ESLint: cancelled'],
      detail: 'did not pass: ESLint: cancelled (ESLint run 40509000100 is not answered by the newer run 40509213300, which was made before the red run finished: re-run 40509000100, or reopen); still running: ESLint (queued)',
    });
    expect(state([...runs, cancelledEarly, lintNew({ created_at: '2026-10-27T12:41:01Z' })], [...checkRuns, built()])).toMatchObject({ state: 'pending', pending: ['ESLint (queued)'] });
    // A cancel waits for a queued newer run made after it landed, which answers it for now and
    // decides by what it concludes ...
    const cancelledRun = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:40:00Z' });
    const cancelledLint = () => job(cancelledRun, 'lint', { conclusion: 'cancelled', started_at: '2026-10-27T12:40:30Z', completed_at: '2026-10-27T12:41:02Z' });
    expect(state([...runs, cancelledRun, lintNew({ created_at: '2026-10-27T12:42:00Z' })], [...checkRuns, cancelledLint()]))
      .toMatchObject({ state: 'pending', failed: [], pending: ['ESLint (queued)'] });
    // ... and refuses at once beside one whose lint started before it landed, which cannot.
    const startedFirst = lintNew({ status: 'in_progress', created_at: '2026-10-27T12:41:00Z' });
    expect(state([...runs, cancelledRun, startedFirst], [...checkRuns, cancelledLint(), job(startedFirst, 'lint', { status: 'in_progress', conclusion: null, started_at: '2026-10-27T12:41:01Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / lint: cancelled'] });
    // The older run re-running that job: a run still going, so its own conclusion decides.
    const rerunning = wfRun(40509000100, 'ESLint', ESLINT, { status: 'in_progress', conclusion: null, created_at: '2026-10-27T12:40:00Z', run_attempt: 2, run_started_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, rerunning], [...checkRuns, job(rerunning, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' })]))
      .toMatchObject({ state: 'pending', failed: [], pending: ['ESLint / lint (failure; its run has not concluded)'] });
  });

  it('★ a job that timed out is listed as cancelled; a newer run whose try at it started before it concluded does not answer it', () => {
    const { runs, checkRuns } = green();
    // Base without verticals on 2026-10-27 (run 40446993015): "The job has exceeded the maximum
    // execution time of 45m0s", listed with conclusion cancelled, as was its run. A reopen five
    // minutes into the hang made a newer run, which passed long before the hang concluded.
    const hung = wfRun(40509000100, 'Base without verticals', 369488824, { conclusion: 'cancelled', created_at: '2026-10-27T13:00:00Z' });
    const reopened = wfRun(40509000200, 'Base without verticals', 369488824, { conclusion: 'success', created_at: '2026-10-27T13:05:00Z' });
    const BASE = 'Emergence with the verticals; the base without them';
    const others = checkRuns.filter((c) => c.name !== BASE);
    const hang = job(hung, BASE, { conclusion: 'cancelled', started_at: '2026-10-27T13:00:02Z', completed_at: '2026-10-27T13:45:02Z' });
    const pass = job(reopened, BASE, { started_at: '2026-10-27T13:05:03Z', completed_at: '2026-10-27T13:30:00Z' });
    expect(state([...runs.filter((r) => r !== base), hung, reopened], [...others, hang, pass])).toMatchObject({
      state: 'failure', failed: [`Base without verticals / ${BASE}: cancelled`],
      detail: `did not pass: Base without verticals / ${BASE}: cancelled (Base without verticals run 40509000100 is not answered by the newer run 40509000200, which started ${BASE} before the red run finished: re-run 40509000100, or reopen)`,
    });
  });

  it('★ a run that did not pass is read by its own conclusion when none of the check runs it lists says so (the listing lags)', () => {
    const { runs, checkRuns } = green();
    const red = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T13:00:00Z' });
    expect(state([...runs, red], [...checkRuns, job(red, 'types', { started_at: '2026-10-27T13:00:30Z' })])).toMatchObject({ state: 'failure', failed: ['ESLint: failure'] });
    // With its red job listed, the job says it, once.
    expect(state([...runs, red], [...checkRuns, job(red, 'types', { started_at: '2026-10-27T13:00:30Z' }), job(red, 'lint', { conclusion: 'failure', started_at: '2026-10-27T13:00:30Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
  });

  it('★ two checks that share a label (one workflow, a push run and a pull_request run) are both named', () => {
    const { runs, checkRuns } = green();
    const pr = wfRun(40509000100, 'ESLint', ESLINT, { status: 'in_progress', conclusion: null });
    const push = wfRun(40509000101, 'ESLint', ESLINT, { event: 'push', status: 'in_progress', conclusion: null });
    const s = state([...runs, pr, push], [...checkRuns, job(pr, 'lint', { status: 'in_progress', conclusion: null }), job(push, 'lint', { status: 'in_progress', conclusion: null })]);
    expect(s).toMatchObject({ state: 'pending', pending: ['ESLint / lint', 'ESLint / lint'] });
  });

  it('★ another app\'s red is answered only by a later check of its name that is a result: a skip is not; a re-request still queued waits', () => {
    const { runs, checkRuns } = green();
    const red: CheckRunLike = { id: 77, name: 'deploy preview', status: 'completed', conclusion: 'failure', started_at: '2026-10-27T13:00:00Z', completed_at: '2026-10-27T13:10:00Z', check_suite: { id: 5 }, app: { id: 9, slug: 'railway-app' }, html_url: 'https://railway.app/x' };
    expect(state(runs, [...checkRuns, red, { ...red, id: 78, conclusion: 'skipped', started_at: '2026-10-27T13:15:00Z', completed_at: '2026-10-27T13:15:01Z' }]))
      .toMatchObject({ state: 'failure', failed: ['deploy preview (railway-app): failure'] });
    expect(state(runs, [...checkRuns, red, { ...red, id: 78, status: 'queued', conclusion: null, started_at: null, completed_at: null }]))
      .toMatchObject({ state: 'pending', failed: [], pending: ['deploy preview (railway-app)'] });
  });

  it('★ an Actions job whose run the runs listing does not hold yet waits for its run, whatever it concluded', () => {
    const { runs, checkRuns } = green();
    const lateRun = wfRun(40509555555, 'Late workflow', 377777777);
    expect(state(runs, [...checkRuns, job(lateRun, 'late', { conclusion: 'failure' })])).toMatchObject({ state: 'pending', failed: [], pending: ['late (its run is not listed yet)'] });
    // A job that passed says nothing of the jobs behind it (needs), which get their check runs
    // only when their turn comes. The run decides, and it is not listed yet.
    expect(state(runs, [...checkRuns, job(lateRun, 'late', {})])).toMatchObject({ state: 'pending', failed: [], pending: ['late (its run is not listed yet)'] });
  });

  it('★ a check run created through the API in another workflow\'s check suite is its own check, not that run\'s job', () => {
    const { runs, checkRuns } = green();
    // A test reporter's red report lands in Base without verticals' suite; that run passed.
    const report: CheckRunLike = { id: 901, name: 'Test Results', status: 'completed', conclusion: 'failure', check_suite: { id: base.check_suite_id ?? null }, app: { id: 15368, slug: 'github-actions' }, html_url: 'https://github.com/o/r/runs/901' };
    expect(state(runs, [...checkRuns, report])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
  });

  it('★ a check run a workflow creates through the API in this run\'s check suite is another check, not this workflow\'s own', () => {
    const { runs, checkRuns } = green();
    const report: CheckRunLike = { id: 900, name: 'Test Results', status: 'completed', conclusion: 'failure', check_suite: { id: selfRun.check_suite_id ?? null }, app: { id: 15368, slug: 'github-actions' }, html_url: 'https://github.com/o/r/runs/900' };
    expect(state(runs, [...checkRuns, report])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
  });

  it('★ a check run is filed under a workflow run only as an Actions job of it (app github-actions, html_url its job page); details_url is never read', () => {
    const { runs, checkRuns } = green();
    // A report created through the API (a step posting results with checks.create) has a page of
    // its own, and links back to the run that made it with whatever details_url its creator set.
    const report = (over: Partial<CheckRunLike>): CheckRunLike => ({
      id: 901, name: 'Test Results', status: 'completed', conclusion: 'failure', started_at: '2026-10-27T13:08:00Z', completed_at: '2026-10-27T13:08:30Z',
      check_suite: { id: base.check_suite_id ?? null }, app: { id: 15368, slug: 'github-actions' }, html_url: 'https://github.com/o/r/runs/901', ...over,
    });
    // Its details_url names Base without verticals, which passed: it is still a check of its own, red ...
    const toBase = `https://github.com/o/r/actions/runs/${base.id}`;
    expect(state(runs, [...checkRuns, report({ details_url: toBase })])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
    expect(state(runs, [...checkRuns, report({ details_url: `${toBase}?pr=1` })])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
    expect(state(runs, [...checkRuns, report({ details_url: `${toBase}/job/1` })])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
    // ... or still running ...
    expect(state(runs, [...checkRuns, report({ details_url: toBase, status: 'in_progress', conclusion: null, completed_at: null })])).toMatchObject({ state: 'pending', failed: [], pending: ['Test Results'] });
    // ... and the same when it names a run not listed for this head, or this workflow's own.
    expect(state(runs, [...checkRuns, report({ details_url: 'https://github.com/o/r/actions/runs/40400000000' })])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
    expect(state(runs, [...checkRuns, report({ details_url: `https://github.com/o/r/actions/runs/${SELF_RUN}/job/1` })])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
    // Another app's report linking to Base's run page: its own check too.
    const otherApp = { app: { id: 9, slug: 'some-ci-app' }, check_suite: { id: 777000 } };
    expect(state(runs, [...checkRuns, report({ ...otherApp, details_url: toBase })])).toMatchObject({ state: 'failure', failed: ['Test Results (some-ci-app): failure'] });
    // A page that names a run but no job of it (a bare run page) files nothing under that run ...
    expect(state(runs, [...checkRuns, report({ html_url: toBase })])).toMatchObject({ state: 'failure', failed: ['Test Results: failure'] });
    // ... nor does a job page on another app's check run: only GitHub Actions makes a run's jobs.
    expect(state(runs, [...checkRuns, report({ ...otherApp, html_url: `${toBase}/job/9001` })])).toMatchObject({ state: 'failure', failed: ['Test Results (some-ci-app): failure'] });
  });

  it('★ a report created through the API by GitHub Actions is one check per name, whichever check suite GitHub filed it in; another app\'s stay one per suite', () => {
    const { runs, checkRuns } = green();
    // r failed and n, a reopen made after it, ran its test again green. Each run posted a 'Jest
    // Results' report through the API, and GitHub filed each in a suite of its own pick.
    const r = wfRun(40509000100, 'CI', 355555555, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:45:00Z' });
    const n = wfRun(40509213300, 'CI', 355555555, { created_at: '2026-10-27T13:06:52Z' });
    const ciJobs = [job(r, 'test', { conclusion: 'failure', started_at: '2026-10-27T12:41:00Z' }), job(n, 'test', { started_at: '2026-10-27T13:07:10Z' })];
    const report = (id: number, conclusion: string, inSuiteOf: WorkflowRunLike, at: string): CheckRunLike => ({
      id, name: 'Jest Results', status: 'completed', conclusion, started_at: at, completed_at: at,
      check_suite: { id: inSuiteOf.check_suite_id ?? null }, app: { id: 15368, slug: 'github-actions' }, html_url: `https://github.com/o/r/runs/${id}`,
    });
    for (const newerIn of [n, r, selfRun]) {
      expect(state([...runs, r, n], [...checkRuns, ...ciJobs, report(8000, 'failure', r, '2026-10-27T12:44:00Z'), report(8001, 'success', newerIn, '2026-10-27T13:09:00Z')]).state, String(newerIn.id))
        .toBe('success');
    }
    // Two apps' checks that share a name are two checks: one app's green does not answer the other's red.
    const railway: CheckRunLike = { id: 7000, name: 'deploy', status: 'completed', conclusion: 'failure', started_at: '2026-10-27T13:00:00Z', completed_at: '2026-10-27T13:05:00Z', check_suite: { id: 5 }, app: { id: 9, slug: 'railway-app' }, html_url: 'https://github.com/o/r/runs/7000' };
    const vercel: CheckRunLike = { ...railway, id: 7001, conclusion: 'success', started_at: '2026-10-27T13:06:00Z', completed_at: '2026-10-27T13:07:00Z', check_suite: { id: 6 }, app: { id: 10, slug: 'vercel' }, html_url: 'https://github.com/o/r/runs/7001' };
    expect(state(runs, [...checkRuns, railway, vercel])).toMatchObject({ state: 'failure', failed: ['deploy (railway-app): failure'] });
  });

  it('★ a run listed as concluded while a job of it is still going, or went red after the run concluded, waits: the runs listing has not caught up', () => {
    const { runs, checkRuns } = green();
    const BASE = 'Emergence with the verticals; the base without them';
    const others = checkRuns.filter((c) => c.name !== BASE);
    // Base without verticals passed (updated 13:20), and someone re-ran it during the wait: the runs
    // listing, read first, still shows attempt 1; the check runs already hold attempt 2's job.
    // Called directly, since concluded() would read the red job into the run's conclusion.
    const listed = runs.map((r) => (r === base ? { ...r, updated_at: '2026-10-27T13:20:00Z' } : r));
    const direct = (cs: readonly CheckRunLike[]) => otherChecksState(listed, cs, { selfRunId: String(SELF_RUN) });
    expect(direct([...others, job(base, BASE, { status: 'in_progress', conclusion: null, started_at: '2026-10-27T13:40:00Z' })])).toMatchObject({
      state: 'pending', failed: [], pending: [`Base without verticals / ${BASE} (its run is listed as concluded success; the listings have not caught up)`],
    });
    expect(direct([...others, job(base, BASE, { status: 'queued', conclusion: null, started_at: null })])).toMatchObject({ state: 'pending', failed: [] });
    expect(direct([...others, job(base, BASE, { conclusion: 'failure', started_at: '2026-10-27T13:40:00Z', completed_at: '2026-10-27T13:41:00Z' })])).toMatchObject({
      state: 'pending', failed: [], pending: [`Base without verticals / ${BASE} (failure after its run concluded; the listings have not caught up)`],
    });
    // A job that may fail (continue-on-error), red before its run concluded green: the run's own conclusion stands.
    expect(direct([...others, job(base, BASE, { started_at: '2026-10-27T13:07:00Z' }), job(base, 'an advisory leg', { conclusion: 'failure', started_at: '2026-10-27T13:08:00Z' })]))
      .toMatchObject({ state: 'success', failed: [], pending: [] });
  });

  it('★ the detail says why a newer run left a red standing: it skipped the red job (a reporter that runs only on failure), or has no job of that name (renamed on the base)', () => {
    const { runs, checkRuns } = green();
    const r = wfRun(40509000100, 'CI', 355555555, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:46:00Z' });
    const n = wfRun(40509213300, 'CI', 355555555, { created_at: '2026-10-27T13:06:52Z' });
    expect(state([...runs, r, n], [...checkRuns,
      job(r, 'test', { conclusion: 'failure', started_at: '2026-10-27T12:41:00Z' }), job(r, 'report failure', { conclusion: 'failure', started_at: '2026-10-27T12:44:00Z' }),
      job(n, 'test', { started_at: '2026-10-27T13:07:00Z' }), job(n, 'report failure', { conclusion: 'skipped', started_at: '2026-10-27T13:08:01Z' })])).toMatchObject({
      state: 'failure', failed: ['CI / test: failure', 'CI / report failure: failure'],
      detail: 'did not pass: CI / test: failure, CI / report failure: failure (CI run 40509000100 is not answered by the newer run 40509213300, which skipped report failure: re-run 40509000100)',
    });
    // Mutation Gate's job renamed on master between the two runs: a pull_request run reads the
    // workflow file of the merge commit, which a reopen builds against the base as it is now.
    const old = wfRun(40509000002, 'Mutation Gate', 348733029, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T13:05:00Z' });
    expect(state([...runs, old], [...checkRuns, job(old, 'Every refusal gate fails', { conclusion: 'failure', started_at: '2026-10-27T12:41:00Z' })])).toMatchObject({
      state: 'failure', failed: ['Mutation Gate / Every refusal gate fails: failure'],
      detail: `did not pass: Mutation Gate / Every refusal gate fails: failure (Mutation Gate run 40509000002 is not answered by the newer run ${mutation.id}, which has no job named Every refusal gate fails: re-run 40509000002)`,
    });
  });

  it('★ two dispatches are two checks even where their jobs share a name: one red refuses, whatever the other did after it', () => {
    const { runs, checkRuns } = green();
    // build-ghcr.yml's validate-input job has one name in every dispatch. The relay dispatch's
    // went red; the identity dispatch, made after it, passed its own and built.
    const relay = relayRun({ conclusion: 'failure', updated_at: '2026-10-27T13:01:45Z' });
    const identity = wfRun(40509300100, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', created_at: '2026-10-27T13:03:00Z' });
    const VALIDATE = 'Requested image must exist (a no-op build must not report success)';
    expect(state([...runs, relay, identity], [...checkRuns,
      job(relay, VALIDATE, { conclusion: 'failure', started_at: '2026-10-27T13:01:05Z', completed_at: '2026-10-27T13:01:40Z' }),
      job(relay, 'matrix.image', { conclusion: 'skipped', started_at: '2026-10-27T13:01:41Z' }),
      job(identity, VALIDATE, { started_at: '2026-10-27T13:03:05Z' }), job(identity, 'interego-identity', { started_at: '2026-10-27T13:04:00Z' })]))
      .toMatchObject({ state: 'failure', failed: [`Build & push to GHCR / ${VALIDATE}: failure`] });
    // The same image dispatched again after a red one, and green: a new dispatch does not answer it
    // (it carries its own inputs), so the detail says to re-run the red one.
    const d1 = wfRun(40509300000, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', conclusion: 'failure', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:46:00Z' });
    const d2 = wfRun(40509300100, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', created_at: '2026-10-27T12:50:00Z', updated_at: '2026-10-27T12:58:00Z' });
    const ghcrJobs = [
      job(d1, VALIDATE, { started_at: '2026-10-27T12:40:05Z' }), job(d1, 'interego-relay', { conclusion: 'failure', started_at: '2026-10-27T12:41:00Z', completed_at: '2026-10-27T12:45:50Z' }),
      job(d2, VALIDATE, { started_at: '2026-10-27T12:50:05Z' }), job(d2, 'interego-relay', { started_at: '2026-10-27T12:51:00Z', completed_at: '2026-10-27T12:57:50Z' }),
    ];
    expect(state([...runs, d1, d2], [...checkRuns, ...ghcrJobs])).toMatchObject({
      state: 'failure', failed: ['Build & push to GHCR / interego-relay: failure'],
      detail: 'did not pass: Build & push to GHCR / interego-relay: failure (Build & push to GHCR run 40509300000 is a dispatch, answered only by its own re-run (a new dispatch does not answer it): re-run 40509300000)',
    });
    // A repository_dispatch is a dispatch too.
    const fromRepo = (r: WorkflowRunLike): WorkflowRunLike => ({ ...r, event: 'repository_dispatch' });
    expect(state([...runs, fromRepo(d1), fromRepo(d2)], [...checkRuns, ...ghcrJobs])).toMatchObject({ state: 'failure', failed: ['Build & push to GHCR / interego-relay: failure'] });
  });

  it('★ a run is read by its own conclusion, which covers its latest try: a re-run that left a same-named leg red refuses', () => {
    const { runs, checkRuns } = green();
    const others = checkRuns.filter((c) => c.name !== MUTANT);
    // Two legs named alike; the re-run of one went green, the other kept its red, and GitHub
    // concluded the run failure.
    const rerun = { ...mutation, conclusion: 'failure', run_attempt: 2, run_started_at: '2026-10-27T13:30:00Z' };
    expect(state(runs.map((r) => (r === mutation ? rerun : r)), [...others,
      job(mutation, MUTANT, { conclusion: 'failure', started_at: '2026-10-27T13:07:00Z' }), job(mutation, MUTANT, { started_at: '2026-10-27T13:31:00Z' })]))
      .toMatchObject({ state: 'failure', failed: [`Mutation Gate / ${MUTANT}: failure`] });
  });

  it('★ a cancelled run that lists no red job (what it had not finished was never created) is answered by a newer run made after the cancel', () => {
    const { runs, checkRuns } = green();
    const cancelled = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:41:00Z' });
    const newer = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:45:00Z' });
    expect(state([...runs, cancelled, newer], [...checkRuns,
      job(cancelled, 'build', { started_at: '2026-10-27T12:40:05Z', completed_at: '2026-10-27T12:40:50Z' }),
      job(newer, 'build', { started_at: '2026-10-27T12:45:05Z' }), job(newer, 'test', { started_at: '2026-10-27T12:46:00Z' })]).state).toBe('success');
    // Only a newer run that ran something answers it: not one cancelled before it made any job (held
    // by a concurrency group and replaced), and not the run that replaced it when that one was
    // skipped whole. Nothing ran its test after it.
    const build = () => job(cancelled, 'build', { started_at: '2026-10-27T12:40:05Z', completed_at: '2026-10-27T12:40:50Z' });
    const heldOut = lintNew({ status: 'completed', conclusion: 'cancelled', created_at: '2026-10-27T12:42:00Z', updated_at: '2026-10-27T12:42:30Z' });
    const skippedWhole = wfRun(40509213400, 'ESLint', ESLINT, { conclusion: 'skipped', created_at: '2026-10-27T12:42:30Z' });
    expect(state([...runs, cancelled, heldOut, skippedWhole], [...checkRuns, build(),
      job(skippedWhole, 'build', { conclusion: 'skipped', started_at: '2026-10-27T12:42:31Z' }), job(skippedWhole, 'test', { conclusion: 'skipped', started_at: '2026-10-27T12:42:31Z' })])).toMatchObject({
      state: 'failure', failed: ['ESLint: cancelled'],
      detail: 'did not pass: ESLint: cancelled (ESLint run 40509000100 is not answered by the newer run 40509213400, which was skipped whole: re-run 40509000100)',
    });
    expect(state([...runs, cancelled, heldOut], [...checkRuns, build()]).detail)
      .toContain('ESLint run 40509000100 is not answered by the newer run 40509213300, which ran nothing: re-run 40509000100, or reopen');
    // A failed run that lists no red job (the listing has not caught up) is answered by no run that has concluded.
    const failedRun = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:41:00Z' });
    expect(state([...runs, failedRun, newer], [...checkRuns,
      job(failedRun, 'build', { started_at: '2026-10-27T12:40:05Z', completed_at: '2026-10-27T12:40:50Z' }),
      job(newer, 'build', { started_at: '2026-10-27T12:45:05Z' })])).toMatchObject({ state: 'failure', failed: ['ESLint: failure'] });
  });

  it('★ a newer run answers only what it ran again: a job it skipped, or a run it skipped whole, answers nothing', () => {
    const { runs, checkRuns } = green();
    // The older run's lint went red; the newer run, made after it, passed but skipped lint.
    const red = () => job(lintOld, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' });
    const newer = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, lintOld, newer], [...checkRuns, red(), job(newer, 'lint', { conclusion: 'skipped', started_at: '2026-10-27T12:50:05Z' }), job(newer, 'types', { started_at: '2026-10-27T12:50:05Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
    // A cancelled run that lists no red job is answered by a newer run's own conclusion, but not
    // by a newer run that was skipped whole.
    const cancelled = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:41:00Z' });
    const skipped = lintNew({ status: 'completed', conclusion: 'skipped', created_at: '2026-10-27T12:45:00Z' });
    expect(state([...runs, cancelled, skipped], [...checkRuns, job(cancelled, 'build', { started_at: '2026-10-27T12:40:05Z', completed_at: '2026-10-27T12:40:50Z' }),
      job(skipped, 'build', { conclusion: 'skipped', started_at: '2026-10-27T12:45:05Z' })])).toMatchObject({ state: 'failure', failed: ['ESLint: cancelled'] });
    // Two jobs went red; the newer run, made after, ran one again and skipped the other: the other stands.
    const twoRed = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z', updated_at: '2026-10-27T12:42:00Z' });
    const halfAgain = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, twoRed, halfAgain], [...checkRuns,
      job(twoRed, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' }), job(twoRed, 'test', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' }),
      job(halfAgain, 'lint', { started_at: '2026-10-27T12:50:30Z' }), job(halfAgain, 'test', { conclusion: 'skipped', started_at: '2026-10-27T12:50:31Z' })])).toMatchObject({
      state: 'failure', failed: ['ESLint / lint: failure', 'ESLint / test: failure'],
      detail: 'did not pass: ESLint / lint: failure, ESLint / test: failure (ESLint run 40509000100 is not answered by the newer run 40509213300, which skipped test: re-run 40509000100)',
    });
    // A job that timed out (listed as cancelled) in a cancelled run; the newer run, made after it,
    // passed but skipped that job: the cancel is a red job of it, and nothing ran it again.
    const timedOut = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'cancelled', created_at: '2026-10-27T12:00:00Z', updated_at: '2026-10-27T12:46:00Z' });
    const skippedE2e = lintNew({ status: 'completed', conclusion: 'success', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, timedOut, skippedE2e], [...checkRuns,
      job(timedOut, 'build', { started_at: '2026-10-27T12:00:30Z' }), job(timedOut, 'e2e', { conclusion: 'cancelled', started_at: '2026-10-27T12:01:00Z', completed_at: '2026-10-27T12:46:00Z' }),
      job(skippedE2e, 'build', { started_at: '2026-10-27T12:50:30Z' }), job(skippedE2e, 'e2e', { conclusion: 'skipped', started_at: '2026-10-27T12:51:00Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / e2e: cancelled'] });
  });

  it('★ ... and relay red, beside a green identity run', () => {
    const { runs, checkRuns } = green();
    const relay = relayRun({ conclusion: 'failure' });
    expect(state([...runs, relay, identityRun], [...checkRuns, job(relay, 'relay', { conclusion: 'failure', started_at: '2026-10-27T13:01:30Z' }), identityJob()]))
      .toMatchObject({ state: 'failure', failed: ['Build & push to GHCR / relay: failure'] });
  });

  it('★ an earlier run is answered only once it has concluded, by a newer run that ran each of its red jobs again: a leg only it made does not matter', () => {
    const { runs, checkRuns } = green();
    const early = (over: Partial<WorkflowRunLike>) => wfRun(40509000002, 'Mutation Gate', 348733029, { created_at: '2026-10-27T12:50:00Z', ...over });
    const earlyJob = (r: WorkflowRunLike, name: string, over: Partial<CheckRunLike>) => job(r, name, { started_at: '2026-10-27T12:50:30Z', ...over });
    // Cancelled, and its one job re-ran by name in the newer run: superseded.
    const cancelled = early({ conclusion: 'cancelled' });
    expect(state([...runs, cancelled], [...checkRuns, earlyJob(cancelled, MUTANT, { conclusion: 'cancelled' })]).state).toBe('success');
    // A leg only this run made passed, and the newer run, made after the cancel, ran the cancelled
    // job again: the run is answered. (What the cancel never let it create, the newer run of the
    // same workflow made, and its own conclusion covers.)
    const partly = early({ conclusion: 'cancelled' });
    expect(state([...runs, partly], [...checkRuns, earlyJob(partly, MUTANT, { conclusion: 'cancelled' }), earlyJob(partly, 'A leg only this run made', {})]).state).toBe('success');
    // A newer run that did not run the cancelled job again (it skipped it) does not answer it.
    const skippedIt = runs.map((r) => (r === mutation ? { ...r, conclusion: 'skipped' } : r));
    expect(state([...skippedIt, partly], [...checkRuns.filter((c) => c.name !== MUTANT), job(mutation, MUTANT, { conclusion: 'skipped' }), earlyJob(partly, MUTANT, { conclusion: 'cancelled' })]))
      .toMatchObject({ state: 'failure', failed: [`Mutation Gate / ${MUTANT}: cancelled`] });
    // Still running: a job not created yet is not re-run by anything.
    const running = early({ status: 'in_progress', conclusion: null });
    expect(state([...runs, running], [...checkRuns, earlyJob(running, MUTANT, {})])).toMatchObject({ state: 'pending', pending: ['Mutation Gate (in_progress)'] });
    // It lists no check run at all: nothing shows that a newer run re-ran what it would have run.
    const empty = early({ conclusion: 'startup_failure' });
    expect(state([...runs, empty], checkRuns)).toMatchObject({ state: 'failure', failed: ['Mutation Gate: startup_failure'] });
  });

  it('★ an earlier run\'s red waits while a newer run of its workflow for the same event has not concluded (a reopen): pending, and the newer run decides', () => {
    const { runs, checkRuns } = green();
    // The newer run, made after the red, is queued and has no check run yet: it answers the red
    // for now, and decides by what it concludes.
    const queued = lintNew();
    expect(state([...runs, lintOld, queued], [...checkRuns, lintOldJob()])).toMatchObject({ state: 'pending', failed: [], pending: ['ESLint (queued)'] });
    // Its `lint` is queued, not started: it is the newer run's, so it is the attempt read, and it is still running.
    const running = lintNew({ status: 'in_progress' });
    const queuedLint = job(running, 'lint', { status: 'queued', conclusion: null, started_at: null });
    expect(state([...runs, lintOld, running], [...checkRuns, lintOldJob(), queuedLint])).toMatchObject({ state: 'pending', failed: [], pending: ['ESLint / lint'] });
    // The older run's own red, with no check run of its own listed, waits the same way ...
    expect(state([...runs, lintOld, queued], checkRuns)).toMatchObject({ state: 'pending', pending: ['ESLint (queued)'] });
    // ... and, once the newer run has concluded, refuses: nothing shows it ran again what went red.
    const passedAlone = lintNew({ status: 'completed', conclusion: 'success' });
    expect(state([...runs, lintOld, passedAlone], [...checkRuns, job(passedAlone, 'lint', { started_at: '2026-10-27T13:07:30Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint: failure'] });
    // The newer run concluded green: the older one is superseded, and it holds.
    const passed = lintNew({ status: 'completed', conclusion: 'success' });
    expect(state([...runs, lintOld, passed], [...checkRuns, lintOldJob(), job(passed, 'lint', { started_at: '2026-10-27T13:07:30Z' })]).state).toBe('success');
    // ... or red too: refused, named once.
    const red = lintNew({ status: 'completed', conclusion: 'failure' });
    expect(state([...runs, lintOld, red], [...checkRuns, lintOldJob(), job(red, 'lint', { conclusion: 'failure', started_at: '2026-10-27T13:07:30Z' })]))
      .toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'], pending: [] });
    // A newer run for ANOTHER event checks something else: the older red refuses at once.
    expect(state([...runs, lintOld, lintNew({ event: 'push' })], [...checkRuns, lintOldJob()])).toMatchObject({ state: 'failure', failed: ['ESLint / lint: failure'] });
  });

  it('★ an earlier run cancelled before it made any job is replaced by a newer run of its workflow for the same event (a concurrency group); without one it still refuses', () => {
    const { runs, checkRuns } = green();
    const cancelled = wfRun(40509000003, 'Mutation Gate', 348733029, { conclusion: 'cancelled', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, cancelled], checkRuns)).toMatchObject({ state: 'success', failed: [] });
    // No newer run of the workflow for that event: nothing replaced it.
    expect(state([...runs, { ...cancelled, event: 'push' }], checkRuns)).toMatchObject({ state: 'failure', failed: ['Mutation Gate: cancelled'] });
    // Newer than every run of its workflow: nothing replaced it either.
    expect(state([...runs, { ...cancelled, created_at: '2026-10-27T13:30:00Z' }], checkRuns)).toMatchObject({ state: 'failure', failed: ['Mutation Gate: cancelled'] });
    // Made in the same second as the newer run: the larger id is the newer one.
    expect(state([...runs, { ...cancelled, created_at: mutation.created_at }], checkRuns)).toMatchObject({ state: 'success', failed: [] });
    // A dispatch's group is its own run, so another dispatch, newer and green, never replaces it.
    const dA = wfRun(40509300000, 'Build & push to GHCR', 330000001, { event: 'workflow_dispatch', conclusion: 'cancelled', created_at: '2026-10-27T12:50:00Z', updated_at: '2026-10-27T12:52:05Z' });
    const dB = wfRun(40509300100, 'Build & push to GHCR', 330000001, { event: 'workflow_dispatch', created_at: '2026-10-27T12:52:00Z' });
    expect(state([...runs, dA, dB], [...checkRuns, job(dB, 'interego-relay', { started_at: '2026-10-27T12:52:30Z' })])).toMatchObject({
      state: 'failure', failed: ['Build & push to GHCR: cancelled'],
      detail: 'did not pass: Build & push to GHCR: cancelled (Build & push to GHCR run 40509300000 is a dispatch, answered only by its own re-run (a new dispatch does not answer it): re-run 40509300000)',
    });
  });

  it('★ leaves an advisory suite out (JEV_MERGE_WAITS_FOR_SUITE=false), and says so; a gating suite counts', () => {
    const { runs, checkRuns } = green();
    const red = runs.map((r) => (r === suite ? { ...r, conclusion: 'failure' } : r));
    const redJobs = checkRuns.map((c) => (c.name === 'MCP surface typecheck' ? { ...c, conclusion: 'failure' } : c));
    expect(state(red, redJobs)).toMatchObject({ state: 'failure', failed: ['Bridge Typecheck / MCP surface typecheck: failure'] });
    const advisory = otherChecksState(red, redJobs, { selfRunId: String(SELF_RUN), suiteGates: false });
    expect(advisory.state).toBe('success');
    expect(advisory.passed).toBe(2);
    expect(advisory.detail).toBe('2 check run(s) from 2 other workflow run(s) and any other app concluded success, neutral or skipped; 3 run(s) and job(s) of this workflow left out; Bridge Typecheck left out (3 run(s) and job(s)), as its word is advisory');
    // Still running is left out the same way: a slow advisory suite is no timeout here.
    const slow = runs.map((r) => (r === suite ? { ...r, status: 'in_progress', conclusion: null } : r));
    expect(otherChecksState(slow, checkRuns, { selfRunId: String(SELF_RUN), suiteGates: false }).state).toBe('success');
    // Only the suite: another red check still refuses.
    const baseRed = red.map((r) => (r === base ? { ...r, conclusion: 'failure' } : r));
    expect(otherChecksState(baseRed, [...redJobs, job(base, 'Base on Node 22', { conclusion: 'failure' })], { selfRunId: String(SELF_RUN), suiteGates: false }))
      .toMatchObject({ state: 'failure', failed: ['Base without verticals / Base on Node 22: failure'] });
  });

  it('counts a check run from another app, which has no workflow run, and names the app', () => {
    const { runs, checkRuns } = green();
    const deploy: CheckRunLike = { id: 77, name: 'deploy preview', status: 'completed', conclusion: 'failure', check_suite: { id: 5 }, app: { id: 9, slug: 'railway-app' }, html_url: 'https://railway.app/x' };
    expect(state(runs, [...checkRuns, deploy])).toMatchObject({ state: 'failure', failed: ['deploy preview (railway-app): failure'] });
  });

  it('★ another app\'s check still running is not replaced by a later check run of its name: it may still go red', () => {
    const { runs, checkRuns } = green();
    const running: CheckRunLike = { id: 77, name: 'deploy preview', status: 'in_progress', conclusion: null, check_suite: { id: 5 }, app: { id: 9, slug: 'railway-app' }, html_url: 'https://railway.app/x' };
    const later: CheckRunLike = { ...running, id: 78, status: 'completed', conclusion: 'success', started_at: '2026-10-27T13:15:00Z', completed_at: '2026-10-27T13:20:00Z' };
    expect(state(runs, [...checkRuns, later, running])).toMatchObject({ state: 'pending', pending: ['deploy preview (railway-app)'] });
    // Once it concludes red, a later one that started after that replaces it ...
    const red = { ...running, status: 'completed', conclusion: 'failure', started_at: '2026-10-27T13:00:00Z', completed_at: '2026-10-27T13:10:00Z' };
    expect(state(runs, [...checkRuns, later, red]).state).toBe('success');
    // ... and one that started before it concluded does not: the red stands.
    expect(state(runs, [...checkRuns, { ...later, started_at: '2026-10-27T13:05:00Z' }, red])).toMatchObject({ state: 'failure', failed: ['deploy preview (railway-app): failure'] });
    // GitHub's times are whole seconds: one that started in the very second it concluded is after it.
    expect(state(runs, [...checkRuns, { ...later, started_at: '2026-10-27T13:10:00Z' }, red]).state).toBe('success');
    // A green with a smaller id than the red came before it, though it started after the red concluded: the red stands.
    const red78 = { ...red, id: 78, completed_at: '2026-10-27T13:05:00Z' };
    const green77 = { ...later, id: 77, started_at: '2026-10-27T13:06:00Z', completed_at: '2026-10-27T13:07:00Z' };
    expect(state(runs, [...checkRuns, green77, red78])).toMatchObject({ state: 'failure', failed: ['deploy preview (railway-app): failure'] });
    // A later green that concluded with no start time says nothing of when it ran.
    expect(state(runs, [...checkRuns, red, { ...later, started_at: null }])).toMatchObject({ state: 'failure', failed: ['deploy preview (railway-app): failure'] });
    // A later green of another name in the same suite is another check.
    expect(state(runs, [...checkRuns, red, { ...later, name: 'deploy production' }])).toMatchObject({ state: 'failure', failed: ['deploy preview (railway-app): failure'] });
    // An app that starts the replacement before it closes the old check as cancelled: the cancel
    // landed after the replacement started, so the replacement does not answer it, and it refuses.
    const superseded: CheckRunLike = { ...running, id: 70, name: 'ci', app: { id: 11, slug: 'buildkite' }, status: 'completed', conclusion: 'cancelled', started_at: '2026-10-27T12:30:00Z', completed_at: '2026-10-27T12:42:05Z' };
    const replacement: CheckRunLike = { ...superseded, id: 71, conclusion: 'success', started_at: '2026-10-27T12:42:00Z', completed_at: '2026-10-27T12:50:00Z' };
    expect(state(runs, [...checkRuns, superseded, replacement])).toMatchObject({ state: 'failure', failed: ['ci (buildkite): cancelled'] });
  });

  it('★ untrusted unless both listings hold this run: GitHub\'s listings answer short (2026-09-21, 0f40814b)', () => {
    const { runs, checkRuns } = green();
    expect(state(runs.filter((r) => r !== selfRun), checkRuns).state).toBe('untrusted');
    expect(state(runs, checkRuns.filter((c) => !ownJobs.includes(c))).state).toBe('untrusted');
    expect(state([], []).state).toBe('untrusted');
    expect(otherChecksState(runs, checkRuns, { selfRunId: undefined }).state).toBe('untrusted');
  });
});

// ── the listings: every page, and a refusal kept as one ───────────────────────────────────

type Answer = { status?: number; body?: unknown };
const fakeFetch = (answer: (url: string) => Answer) => {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const a = answer(url);
    const status = a.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => a.body } as Response;
  }) as typeof fetch;
  return { fn, urls };
};
const items = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i }));

describe('★ the listings are read to the last page, and a refusal is kept as one', () => {
  it('reads every page of 100 and stops at the short one, keeping the query it was given', async () => {
    const pages: Record<string, unknown[]> = { '1': items(0, 100), '2': items(100, 100), '3': items(200, 5) };
    const f = fakeFetch((url) => ({ body: { total_count: 205, check_runs: pages[new URL(url).searchParams.get('page') ?? ''] ?? [] } }));
    const all = await listAll('https://api.github.com/repos/o/r/commits/abc/check-runs?filter=latest', 'check_runs', { token: 't', fetchFn: f.fn });
    expect(all).toHaveLength(205);
    expect(f.urls).toEqual([1, 2, 3].map((p) => `https://api.github.com/repos/o/r/commits/abc/check-runs?filter=latest&per_page=100&page=${p}`));
  });
  it('counts an item a growing listing repeats across two pages once', async () => {
    const f = fakeFetch((url) => ({ body: { workflow_runs: new URL(url).searchParams.get('page') === '1' ? items(0, 100) : [{ id: 99 }, { id: 100 }] } }));
    expect(await listAll('https://x/runs?head_sha=abc', 'workflow_runs', { token: 't', fetchFn: f.fn })).toHaveLength(101);
  });
  it(`refuses a listing past MAX_PAGES (${MAX_PAGES}) full pages rather than read it in part`, async () => {
    let n = 0;
    const f = fakeFetch(() => ({ body: { check_runs: items((n++) * 100, 100) } }));
    const err = await listAll('https://x/check-runs?filter=latest', 'check_runs', { token: 't', fetchFn: f.fn }).catch((e: unknown) => e);
    expect(String(err)).toContain(`run past ${MAX_PAGES} pages of 100`);
    expect(retryable(err)).toBe(false);
    expect(f.urls).toHaveLength(MAX_PAGES);
  });
  it('carries GitHub\'s status, so an outage is asked again and a refusal is final; an answer without the list is a refusal', async () => {
    const outage = await listAll('https://x/r?a=1', 'check_runs', { token: 't', fetchFn: fakeFetch(() => ({ status: 503 })).fn }).catch((e: unknown) => e);
    expect(retryable(outage)).toBe(true);
    const refused = await listAll('https://x/r?a=1', 'check_runs', { token: 't', fetchFn: fakeFetch(() => ({ status: 403 })).fn }).catch((e: unknown) => e);
    expect(String(refused)).toContain('GitHub answered 403');
    expect(retryable(refused)).toBe(false);
    const empty = await listAll('https://x/r?a=1', 'check_runs', { token: 't', fetchFn: fakeFetch(() => ({ body: { message: 'Not Found' } })).fn }).catch((e: unknown) => e);
    expect(String(empty)).toContain('holds no check_runs list');
    expect(retryable(empty)).toBe(false);
  });
});

// ── the wait: one deadline, both words ────────────────────────────────────────────────────

const SHA = 'c91c2e71ffbbfa7f30b8197057020d68ca0af687';
const POLL = 30_000;
const DEADLINE = 20 * 60_000;
/** A clock that moves only when the wait sleeps, and GitHub answering by poll number. */
function harness(answer: (poll: number, url: string) => Answer, over: { checksGate?: boolean; suiteGate?: boolean; selfRunId?: string } = {}) {
  let t = 0;
  let poll = 0;
  const f = fakeFetch((url) => answer(poll, url));
  const done = waitForHead({
    sha: SHA, repo: 'o/r', token: 't', self: 'jev-harness (System One judgments)', selfRunId: String(SELF_RUN),
    timeoutMs: DEADLINE, pollMs: POLL, fetchFn: f.fn, now: () => t, sleep: async (ms) => { t += ms; poll++; }, log: () => {},
    ...over,
  });
  return { done, polls: () => poll, urls: f.urls };
}
const listings = (runs: readonly WorkflowRunLike[], checkRuns: readonly CheckRunLike[]) => (_poll: number, url: string): Answer =>
  (url.includes('/check-runs') ? { body: { check_runs: checkRuns } } : { body: { workflow_runs: concluded(runs, checkRuns) } });
const mutationRunning = () => {
  const { runs, checkRuns } = green();
  return {
    runs: runs.map((r) => (r === mutation ? { ...r, status: 'in_progress', conclusion: null } : r)),
    checkRuns: [...checkRuns.filter((c) => c.name !== MUTANT), job(mutation, MUTANT, { status: 'in_progress', conclusion: null })],
  };
};

describe('★ the wait: one deadline for the suite and the checks', () => {
  it('returns both words at once when everything has concluded', async () => {
    const { runs, checkRuns } = green();
    const h = harness(listings(runs, checkRuns));
    expect(await h.done).toMatchObject({ suite: { result: 'success' }, checks: { result: 'success' } });
    expect(h.polls()).toBe(0);
  });

  it('★ a check still running at the deadline is a timeout, not a pass, and the wait ends there (bounded)', async () => {
    const { runs, checkRuns } = mutationRunning();
    const h = harness(listings(runs, checkRuns));
    const done = await h.done;
    expect(done.suite?.result).toBe('success');
    expect(done.checks).toEqual({ result: 'timeout', detail: `still running: Mutation Gate / ${MUTANT}` });
    expect(h.polls()).toBe(DEADLINE / POLL + 1);
    expect(autoMergeDecision({ ...decisionInputs, checks: { ...done.checks, gates: true } }).merge).toBe(false);
  });

  it('waits for a check that concludes before the deadline, and then holds', async () => {
    const running = mutationRunning();
    const { runs, checkRuns } = green();
    const h = harness((poll, url) => listings(poll < 3 ? running.runs : runs, poll < 3 ? running.checkRuns : checkRuns)(poll, url));
    expect((await h.done).checks.result).toBe('success');
    expect(h.polls()).toBe(3);
  });

  it('stops waiting for checks on the first red one, and still waits for the suite', async () => {
    const { runs, checkRuns } = green();
    const suitePending = runs.map((r) => (r === suite ? { ...r, status: 'in_progress', conclusion: null } : r));
    const red = [...checkRuns, job(base, 'Base on Node 22', { conclusion: 'failure' })];
    let checkListings = 0;
    const h = harness((poll, url) => {
      if (url.includes('/check-runs')) checkListings++;
      return listings(poll < 2 ? suitePending : runs, red)(poll, url);
    });
    const done = await h.done;
    expect(done).toMatchObject({ suite: { result: 'success' }, checks: { result: 'failure' } });
    expect(checkListings).toBe(1);
  });

  it('★ advisory (JEV_MERGE_WAITS_FOR_CHECKS=false): no wait of their own; what they say when the suite is in is printed', async () => {
    const { runs, checkRuns } = mutationRunning();
    const h = harness(listings(runs, checkRuns), { checksGate: false });
    const done = await h.done;
    expect(done.checks.result).toBe('pending');
    expect(h.polls()).toBe(0);
    expect(autoMergeDecision({ ...decisionInputs, checks: { ...done.checks, gates: false } }).merge).toBe(true);
  });

  it('★ advisory: the word printed is the one read on the poll the suite concluded on, not the first poll\'s', async () => {
    // The suite runs for three polls while Mutation Gate runs; on the third both conclude, the gate red.
    const running = mutationRunning();
    const { runs, checkRuns } = green();
    const suitePending = running.runs.map((r) => (r.id === suite.id ? { ...r, status: 'in_progress', conclusion: null } : r));
    const red = [...checkRuns.filter((c) => c.name !== MUTANT), job(mutation, MUTANT, { conclusion: 'failure' })];
    const redRuns = runs.map((r) => (r === mutation ? { ...r, conclusion: 'failure' } : r));
    const h = harness((poll, url) => listings(poll < 3 ? suitePending : redRuns, poll < 3 ? running.checkRuns : red)(poll, url), { checksGate: false });
    const done = await h.done;
    expect(h.polls()).toBe(3);
    expect(done.suite?.result).toBe('success');
    expect(done.checks).toEqual({ result: 'failure', detail: `did not pass: Mutation Gate / ${MUTANT}: failure` });
    const d = autoMergeDecision({ ...decisionInputs, checks: { ...done.checks, gates: false } });
    expect(d.merge).toBe(true);
    expect(d.reasons.at(-1)).toContain(`advisory (JEV_MERGE_WAITS_FOR_CHECKS is false): failure (did not pass: Mutation Gate / ${MUTANT}: failure)`);
  });

  it('★ advisory: an outage once the suite is in ends the wait there, with the word error, not at the deadline', async () => {
    const { runs } = green();
    const checksDown = harness((_p, url) => (url.includes('/check-runs') ? { status: 502 } : { body: { workflow_runs: runs } }), { checksGate: false });
    const r = await checksDown.done;
    expect(r.suite?.result).toBe('success');
    expect(r.checks).toMatchObject({ result: 'error', detail: expect.stringContaining('GitHub answered 502') });
    expect(checksDown.polls()).toBe(0);
    // The runs listing failing after the first poll changes nothing: the wait already ended on it.
    const bothDown = harness((poll, url) => (url.includes('/check-runs') || poll > 0 ? { status: 502 } : { body: { workflow_runs: runs } }), { checksGate: false });
    expect((await bothDown.done).checks.result).toBe('error');
    expect(bothDown.polls()).toBe(0);
    // Before the suite is in, an outage is still asked again: the suite is what the wait is for.
    const suitePending = runs.map((r) => (r === suite ? { ...r, status: 'in_progress', conclusion: null } : r));
    const early = harness((poll, url) => (url.includes('/check-runs') ? { status: 502 } : { body: { workflow_runs: poll < 2 ? suitePending : runs } }), { checksGate: false });
    expect((await early.done).checks.result).toBe('error');
    expect(early.polls()).toBe(2);
    expect(autoMergeDecision({ ...decisionInputs, checks: { ...r.checks, gates: false } }).merge).toBe(true);
  });

  it('★ two GHCR dispatches: an older relay run still running times out, and red refuses, whatever the newer identity run says', async () => {
    const { runs, checkRuns } = green();
    const GHCR = 330000001;
    const relay = wfRun(40509300000, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', created_at: '2026-10-27T13:01:00Z', status: 'in_progress', conclusion: null });
    const identity = wfRun(40509300100, 'Build & push to GHCR', GHCR, { event: 'workflow_dispatch', created_at: '2026-10-27T13:03:00Z' });
    const identityJob = job(identity, 'identity', { started_at: '2026-10-27T13:03:30Z' });
    const relayJob = (over: Partial<CheckRunLike>) => job(relay, 'relay', { started_at: '2026-10-27T13:01:30Z', ...over });
    const running = harness(listings([...runs, relay, identity], [...checkRuns, relayJob({ status: 'in_progress', conclusion: null }), identityJob]));
    expect((await running.done).checks).toEqual({ result: 'timeout', detail: 'still running: Build & push to GHCR / relay' });
    expect(running.polls()).toBe(DEADLINE / POLL + 1);
    const red = harness(listings([...runs, { ...relay, status: 'completed', conclusion: 'failure' }, identity], [...checkRuns, relayJob({ conclusion: 'failure' }), identityJob]));
    const done = await red.done;
    expect(done.checks).toEqual({ result: 'failure', detail: 'did not pass: Build & push to GHCR / relay: failure (Build & push to GHCR run 40509300000 is a dispatch, answered only by its own re-run (a new dispatch does not answer it): re-run 40509300000)' });
    expect(red.polls()).toBe(0);
    expect(autoMergeDecision({ ...decisionInputs, checks: { ...done.checks, gates: true } }).merge).toBe(false);
  });

  it('★ JEV_MERGE_WAITS_FOR_SUITE=false with the checks gating: a red or slow suite merges, as that switch says, and another red check does not', async () => {
    const { runs, checkRuns } = green();
    const redRuns = runs.map((r) => (r === suite ? { ...r, conclusion: 'failure' } : r));
    const redJobs = checkRuns.map((c) => (c.name === 'MCP surface typecheck' ? { ...c, conclusion: 'failure' } : c));
    const advisorySuite = { ...decisionInputs, suite: { result: 'failure', gates: false } };
    const red = await harness(listings(redRuns, redJobs), { suiteGate: false }).done;
    expect(red.suite?.result).toBe('failure');
    expect(red.checks.result).toBe('success');
    expect(red.checks.detail).toContain('Bridge Typecheck left out (3 run(s) and job(s)), as its word is advisory');
    const d = autoMergeDecision({ ...advisorySuite, checks: { ...red.checks, gates: true } });
    expect(d.merge).toBe(true);
    expect(d.reasons.filter((r) => r.startsWith('fails:'))).toEqual([]);
    // The suite still running at the deadline: the suite's word is timeout, the checks' is not.
    const slowRuns = runs.map((r) => (r === suite ? { ...r, status: 'in_progress', conclusion: null } : r));
    const slowJobs = checkRuns.map((c) => (c.name === 'MCP surface typecheck' ? { ...c, status: 'in_progress', conclusion: null } : c));
    const slow = await harness(listings(slowRuns, slowJobs), { suiteGate: false }).done;
    expect(slow).toMatchObject({ suite: { result: 'timeout' }, checks: { result: 'success' } });
    expect(autoMergeDecision({ ...decisionInputs, suite: { result: 'timeout', gates: false }, checks: { ...slow.checks, gates: true } }).merge).toBe(true);
    // Gating, the same red suite is refused twice over; and advisory, another red check still refuses.
    expect((await harness(listings(redRuns, redJobs)).done).checks.result).toBe('failure');
    const other = await harness(listings(redRuns, [...redJobs, job(base, 'Base on Node 22', { conclusion: 'failure' })]), { suiteGate: false }).done;
    expect(other.checks.result).toBe('failure');
    expect(autoMergeDecision({ ...advisorySuite, checks: { ...other.checks, gates: true } }).merge).toBe(false);
  });

  describe('★ JEV_MERGE_WAITS_FOR_SUITE=false: the checks are read again on every poll while the advisory suite runs', () => {
    // The suite is left out of the checks, so its running does not keep their word open: a green
    // word read on the first poll must not be the one returned once the suite concludes.
    const BASE_JOB = 'Emergence with the verticals; the base without them';
    const suiteRunning = (rs: readonly WorkflowRunLike[]) => rs.map((r) => (r.id === suite.id ? { ...r, status: 'in_progress', conclusion: null } : r));
    const suiteJobsRunning = (cs: readonly CheckRunLike[]) => cs.map((c) => (c.name === 'MCP surface typecheck' ? { ...c, status: 'in_progress', conclusion: null } : c));

    it('a check re-run red after a green first poll refuses, though the suite concludes green after it', async () => {
      const { runs, checkRuns } = green();
      const baseRed = (rs: readonly WorkflowRunLike[]) => rs.map((r) => (r.id === base.id ? { ...r, conclusion: 'failure' } : r));
      const rerunRed = (cs: readonly CheckRunLike[]) => [...cs.filter((c) => c.name !== BASE_JOB), job(base, BASE_JOB, { conclusion: 'failure', started_at: '2026-10-27T13:20:00Z' })];
      // Poll 0: the suite runs, everything else green. Poll 1: Base's job re-ran and failed. Poll 2: the suite concludes; Base is still red.
      const h = harness((poll, url) => {
        if (poll === 0) return listings(suiteRunning(runs), suiteJobsRunning(checkRuns))(poll, url);
        if (poll === 1) return listings(baseRed(suiteRunning(runs)), rerunRed(suiteJobsRunning(checkRuns)))(poll, url);
        return listings(baseRed(runs), rerunRed(checkRuns))(poll, url);
      }, { suiteGate: false });
      const done = await h.done;
      expect(h.polls()).toBe(2);
      expect(done.suite?.result).toBe('success');
      expect(done.checks.result).toBe('failure');
      expect(done.checks.detail).toContain(`did not pass: Base without verticals / ${BASE_JOB}: failure`);
      expect(autoMergeDecision({ ...decisionInputs, suite: { result: 'success', gates: false }, checks: { ...done.checks, gates: true } }).merge).toBe(false);
    });

    it('a run that starts on the head after a green first poll is waited for: it decides when it concludes, and times out when it does not', async () => {
      const { runs, checkRuns } = green();
      const ghcr = wfRun(40509300200, 'Build & push to GHCR', 330000001, { event: 'workflow_dispatch', status: 'queued', conclusion: null, created_at: '2026-10-27T13:10:00Z' });
      const ghcrDone = { ...ghcr, status: 'completed', conclusion: 'success' };
      // Poll 0: the suite runs, everything else green. Polls 1-3: a GHCR dispatch is queued, and the
      // suite concludes on poll 2. Poll 4 (when it concludes at all): the dispatch passed.
      const answer = (concludes: boolean) => (poll: number, url: string) => {
        if (poll === 0) return listings(suiteRunning(runs), suiteJobsRunning(checkRuns))(poll, url);
        if (poll < 2) return listings([...suiteRunning(runs), ghcr], suiteJobsRunning(checkRuns))(poll, url);
        if (poll < 4 || !concludes) return listings([...runs, ghcr], checkRuns)(poll, url);
        return listings([...runs, ghcrDone], [...checkRuns, job(ghcrDone, 'interego-relay', { started_at: '2026-10-27T13:11:00Z' })])(poll, url);
      };
      const concluded = harness(answer(true), { suiteGate: false });
      expect((await concluded.done).checks.result).toBe('success');
      expect(concluded.polls()).toBe(4);
      const stuck = harness(answer(false), { suiteGate: false });
      expect((await stuck.done).checks).toMatchObject({ result: 'timeout', detail: expect.stringContaining('still running: Build & push to GHCR (queued)') });
      expect(stuck.polls()).toBe(DEADLINE / POLL + 1);
    });
  });

  it('★ a reopen: an older run\'s red waits for the newer run of its workflow, and the newer run decides', async () => {
    const { runs, checkRuns } = green();
    const passed = lintNew({ status: 'completed', conclusion: 'success' });
    // Poll 0: the reopen's ESLint run is queued beside the red one from `opened`. Poll 1: it passed.
    const h = harness((poll, url) => (poll === 0
      ? listings([...runs, lintOld, lintNew()], [...checkRuns, lintOldJob()])
      : listings([...runs, lintOld, passed], [...checkRuns, lintOldJob(), job(passed, 'lint', { started_at: '2026-10-27T13:07:30Z' })]))(poll, url));
    expect((await h.done).checks.result).toBe('success');
    expect(h.polls()).toBe(1);
    // Still queued at the deadline: a timeout that names both, not a pass.
    const stuck = harness(listings([...runs, lintOld, lintNew()], [...checkRuns, lintOldJob()]));
    expect((await stuck.done).checks).toEqual({ result: 'timeout', detail: 'still running: ESLint (queued)' });
  });

  it('★ fails closed when GitHub refuses the check runs: error at once on a 4xx, at the deadline on a 5xx; the suite is still read', async () => {
    const { runs } = green();
    const refused = harness((_p, url) => (url.includes('/check-runs') ? { status: 403 } : { body: { workflow_runs: runs } }));
    const r = await refused.done;
    expect(r.suite?.result).toBe('success');
    expect(r.checks.result).toBe('error');
    expect(r.checks.detail).toContain('GitHub answered 403');
    expect(refused.polls()).toBe(0);
    const outage = harness((_p, url) => (url.includes('/check-runs') ? { status: 502 } : { body: { workflow_runs: runs } }));
    expect((await outage.done).checks.result).toBe('error');
    expect(outage.polls()).toBe(DEADLINE / POLL + 1);
    expect(autoMergeDecision({ ...decisionInputs, checks: { ...r.checks, gates: true } }).merge).toBe(false);
  });

  it('fails closed when the runs cannot be listed at all: no suite word, and the checks word says why', async () => {
    const h = harness(() => ({ status: 404 }));
    const done = await h.done;
    expect(done.suite).toBeUndefined();
    expect(done.fatal).toContain('could not list the runs');
    expect(done.checks.result).toBe('error');
  });

  it('fails closed without the run\'s own id, which is how its own jobs are told from the rest', async () => {
    const { runs, checkRuns } = green();
    const h = harness(listings(runs, checkRuns), { selfRunId: '' });
    expect((await h.done).checks).toMatchObject({ result: 'error', detail: expect.stringContaining('GITHUB_RUN_ID is not set') });
  });

  it('a listing that never holds this run is untrusted at the deadline, not green', async () => {
    const { runs, checkRuns } = green();
    const h = harness(listings(runs, checkRuns.filter((c) => !ownJobs.includes(c))));
    expect((await h.done).checks.result).toBe('untrusted');
    expect(h.polls()).toBe(DEADLINE / POLL + 1);
  });
});

/** Everything but the checks condition holds, so the checks word alone decides. */
const decisionInputs = {
  verdict: 'auto-ok', selectionResult: 'success', armed: true, tokenPresent: true, mergeable: 'MERGEABLE',
  base: { tested: 'a', current: 'a' }, suite: { result: 'success', gates: true },
};

describe('every word the wait writes is one the decision reads', () => {
  it('success holds; failure, timeout, untrusted and error refuse with their own reasons, never the catch-all', () => {
    expect(autoMergeDecision({ ...decisionInputs, checks: { result: 'success', gates: true } }).merge).toBe(true);
    for (const result of ['failure', 'timeout', 'untrusted', 'error']) {
      const d = autoMergeDecision({ ...decisionInputs, checks: { result, gates: true } });
      expect(d.merge, result).toBe(false);
      expect(d.reasons.at(-1), result).not.toContain('have not all concluded');
    }
  });
});
