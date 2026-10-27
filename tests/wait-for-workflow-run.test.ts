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
} from '../tools/wait-for-workflow-run.mjs';
import { retryable } from '../tools/ci-green-for-sha.mjs';
import { autoMergeDecision } from '../applications/jev-harness/src/auto-merge.js';

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
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
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
    // GITHUB_RUN_ID is the runner's own default variable; setting it in env: would be a second, wrong id.
    expect(judge).not.toMatch(/^\s+GITHUB_RUN_ID:/m);
    const permissions = /^permissions:\n((?:\s+.+\n)+)/m.exec(judge)?.[1] ?? '';
    expect(permissions).toMatch(/^\s+actions: read\b/m);
    expect(permissions).toMatch(/^\s+checks: read\b/m);
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
    expect(state([...runs, old], [...checkRuns, job(old, MUTANT, { conclusion: 'cancelled' })]).state).toBe('success');
    // A run for another event is not superseded by this one: both checked the head.
    const push = wfRun(40509000001, 'Mutation Gate', 348733029, { event: 'push', conclusion: 'failure', created_at: '2026-10-27T12:50:00Z' });
    expect(state([...runs, push], [...checkRuns, job(push, MUTANT, { conclusion: 'failure' })])).toMatchObject({ state: 'failure', failed: [`Mutation Gate / ${MUTANT}: failure`] });
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
function harness(answer: (poll: number, url: string) => Answer, over: { checksGate?: boolean; selfRunId?: string } = {}) {
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
