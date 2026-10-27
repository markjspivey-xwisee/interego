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
const job = (r: WorkflowRunLike, name: string, over: Partial<CheckRunLike> = {}): CheckRunLike => {
  const id = jobIds++;
  return {
    id, name, status: 'completed', conclusion: 'success', started_at: '2026-10-27T13:07:00Z',
    check_suite: { id: r.check_suite_id ?? null }, app: { id: 15368, slug: 'github-actions' },
    html_url: `https://github.com/o/r/actions/runs/${r.id}/job/${id}`, ...over,
  };
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
const state = (runs: readonly WorkflowRunLike[], checkRuns: readonly CheckRunLike[]) => otherChecksState(runs, checkRuns, { selfRunId: String(SELF_RUN) });
// A reopen: jev-harness runs on `reopened`, and so does every pull_request workflow with the
// default activity types, so the head gets a second run of each for the same event. The ESLint
// run from `opened` concluded red (the usual reason to close and reopen).
const ESLINT = 311111111;
const lintOld = wfRun(40509000100, 'ESLint', ESLINT, { conclusion: 'failure', created_at: '2026-10-27T12:40:00Z' });
const lintOldJob = () => job(lintOld, 'lint', { conclusion: 'failure', started_at: '2026-10-27T12:40:30Z' });
const lintNew = (over: Partial<WorkflowRunLike> = {}) => wfRun(40509213300, 'ESLint', ESLINT, { status: 'queued', conclusion: null, ...over });
const DEFERRED = 'ESLint / lint (failure in an earlier run; the newer run decides)';

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
    // A check run of this run with no check suite in the listing is still known by its page.
    expect(state(runs, [...checkRuns, { ...job(selfRun, 'select tests → run → gate → decide', { conclusion: 'failure' }), check_suite: null }]).state).toBe('success');
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
    const first = (conclusion: string) => job(mutation, MUTANT, { conclusion, started_at: '2026-10-27T13:07:00Z' });
    const rerun = (conclusion: string) => job(mutation, MUTANT, { conclusion, started_at: '2026-10-27T13:40:00Z' });
    expect(state(runs, [...others, first('failure'), rerun('success')]).state).toBe('success');
    expect(state(runs, [...others, rerun('failure'), first('success')]).state).toBe('failure');
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

  it('★ ... and relay red, beside a green identity run', () => {
    const { runs, checkRuns } = green();
    const relay = relayRun({ conclusion: 'failure' });
    expect(state([...runs, relay, identityRun], [...checkRuns, job(relay, 'relay', { conclusion: 'failure', started_at: '2026-10-27T13:01:30Z' }), identityJob()]))
      .toMatchObject({ state: 'failure', failed: ['Build & push to GHCR / relay: failure'] });
  });

  it('★ an earlier run is superseded only when it has concluded and every check it lists was re-run under the same name', () => {
    const { runs, checkRuns } = green();
    const early = (over: Partial<WorkflowRunLike>) => wfRun(40509000002, 'Mutation Gate', 348733029, { created_at: '2026-10-27T12:50:00Z', ...over });
    const earlyJob = (r: WorkflowRunLike, name: string, over: Partial<CheckRunLike>) => job(r, name, { started_at: '2026-10-27T12:50:30Z', ...over });
    // Cancelled, and its one job re-ran by name in the newer run: superseded.
    const cancelled = early({ conclusion: 'cancelled' });
    expect(state([...runs, cancelled], [...checkRuns, earlyJob(cancelled, MUTANT, { conclusion: 'cancelled' })]).state).toBe('success');
    // A job of its own that no newer run made still counts, so the run's own conclusion is read too.
    const partly = early({ conclusion: 'cancelled' });
    expect(state([...runs, partly], [...checkRuns, earlyJob(partly, MUTANT, { conclusion: 'cancelled' }), earlyJob(partly, 'A leg only this run made', {})]))
      .toMatchObject({ state: 'failure', failed: ['Mutation Gate: cancelled'] });
    // Still running: a job not created yet is not re-run by anything.
    const running = early({ status: 'in_progress', conclusion: null });
    expect(state([...runs, running], [...checkRuns, earlyJob(running, MUTANT, {})])).toMatchObject({ state: 'pending', pending: ['Mutation Gate (in_progress)'] });
    // It lists no check run at all: nothing shows that a newer run re-ran what it would have run.
    const empty = early({ conclusion: 'startup_failure' });
    expect(state([...runs, empty], checkRuns)).toMatchObject({ state: 'failure', failed: ['Mutation Gate: startup_failure'] });
  });

  it('★ an earlier run\'s red waits while a newer run of its workflow for the same event has not concluded (a reopen): pending, and the newer run decides', () => {
    const { runs, checkRuns } = green();
    // The newer run is queued and has no check run yet.
    const queued = lintNew();
    expect(state([...runs, lintOld, queued], [...checkRuns, lintOldJob()])).toMatchObject({ state: 'pending', failed: [], pending: [DEFERRED, 'ESLint (queued)'] });
    // Its `lint` is queued with no started_at, so it sorts behind the older red one: still the newer run's to decide.
    const running = lintNew({ status: 'in_progress' });
    const queuedLint = job(running, 'lint', { status: 'queued', conclusion: null, started_at: null });
    expect(state([...runs, lintOld, running], [...checkRuns, lintOldJob(), queuedLint])).toMatchObject({ state: 'pending', failed: [], pending: [DEFERRED, 'ESLint (in_progress)'] });
    // The older run's own red, with no check run of its own listed, waits the same way.
    expect(state([...runs, lintOld, queued], checkRuns)).toMatchObject({ state: 'pending', pending: ['ESLint (failure in an earlier run; the newer run decides)', 'ESLint (queued)'] });
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
    expect(otherChecksState(red, [...redJobs, job(base, 'Base on Node 22', { conclusion: 'failure' })], { selfRunId: String(SELF_RUN), suiteGates: false }))
      .toMatchObject({ state: 'failure', failed: ['Base without verticals / Base on Node 22: failure'] });
  });

  it('counts a check run from another app, which has no workflow run, and names the app', () => {
    const { runs, checkRuns } = green();
    const deploy: CheckRunLike = { id: 77, name: 'deploy preview', status: 'completed', conclusion: 'failure', check_suite: { id: 5 }, app: { id: 9, slug: 'railway-app' }, html_url: 'https://railway.app/x' };
    expect(state(runs, [...checkRuns, deploy])).toMatchObject({ state: 'failure', failed: ['deploy preview (railway-app): failure'] });
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
  (url.includes('/check-runs') ? { body: { check_runs: checkRuns } } : { body: { workflow_runs: runs } });
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
    expect(done.checks).toEqual({ result: 'failure', detail: 'did not pass: Build & push to GHCR / relay: failure' });
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
    expect((await stuck.done).checks).toEqual({ result: 'timeout', detail: `still running: ${DEFERRED}, ESLint (queued)` });
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
