#!/usr/bin/env node
/**
 * Has the whole-suite workflow concluded on this pull request's head, and how? And has every
 * other check on that head concluded, and none of them red? The gated auto-merge's last two
 * conditions, read in one wait.
 *
 * ── ★★ WHY THE MERGE WAITS FOR A RUN IT DOES NOT START ──────────────────────────────────────
 *
 * bridge-typecheck.yml runs the whole root suite (422 modules, 6,600 tests) on every pull
 * request, ten minutes, and from 2026-09-22 the merge did not wait for it: the judge job merged
 * on its selected tests (the harness picks the modules a change warrants, a minute or two) and
 * the suite concluded eight minutes after the merge, into a check nobody read. From 02:24Z to
 * 16:31Z that day the suite was red on EVERY pull request — two tests about that workflow's own
 * trigger, which the selection never picked because no changed file imported them — and seven
 * pull requests merged automatically over it. The selection is the fast gate; the suite is the
 * slow truth, and a merge that does not wait for the truth is a merge that ships a red suite.
 *
 * So the judge job runs this before its decision: poll the runs listed for the head sha until
 * the suite workflow has concluded, and hand the decision one word. The words, and what the
 * decision does with each (applications/jev-harness/src/auto-merge.ts):
 *
 *   success    the suite passed                                  → holds
 *   absent     no suite run is listed for this head, and the listing holds this job's own run,
 *              so it is a real listing and the suite's paths did not match → holds
 *   untrusted  the listing does not even hold this job's own run: GitHub's eventually
 *              consistent listing answered short (2026-09-21, 0f40814b) → polled again; fails at the deadline
 *   failure / cancelled / timed_out / ...  the suite concluded that way   → fails
 *   timeout    the deadline passed with the suite still running              → fails
 *
 * A run is never read as green because it is missing (the ci-green-for-sha.mjs rule), and a
 * missing listing is distinguished from a missing run by the one run that certainly exists.
 *
 * ── ★★ AND FOR EVERY OTHER CHECK, NOT THE SUITE ALONE (since 2026-10-27) ───────────────────
 *
 * Waiting for one workflow left every other one unread. On 2026-10-27 the decision merged #707
 * and #716 the moment Bridge Typecheck passed, while Mutation Gate and Base without verticals
 * were still running on the same heads (Mutation Gate concluded 24 and 18 minutes after those
 * merges). Both came back green, but a red one would have landed on master with nothing
 * reading it. So the same loop, against the same deadline, also lists every workflow run and
 * every check run GitHub holds for the head, and hands the decision a second word, `checks`:
 *
 *   success    every other check concluded success, neutral or skipped     → holds
 *   failure    one concluded anything else (failure, cancelled, timed_out, action_required,
 *              startup_failure, stale, none)    → fails, and the wait for checks stops there
 *   timeout    the deadline passed with a check still running              → fails
 *   untrusted  the listings never held this run and its own job            → fails at the deadline
 *   error      GitHub could not be asked (a 4xx at once, a 5xx at the deadline, a listing
 *              longer than MAX_PAGES pages, no GITHUB_RUN_ID)             → fails
 *   pending    only when advisory (CHECKS_GATE=false): still running when the suite wait ended
 *
 * with `checks_detail`, one line naming what failed or what was still running. Which checks
 * count, and which attempt of each (`otherChecksState`):
 *
 *   - THIS WORKFLOW'S OWN are left out by workflow id, never by name: every run of this
 *     workflow on the head (this one, one a reopen left, the close-time one) and every check
 *     run whose check suite or run page is one of theirs. A name is a string any workflow can
 *     carry. Counted, this job would wait for itself until the deadline.
 *   - THE LATEST ATTEMPT of each check, by name. A rerun keeps its run id and check suite and
 *     lists its newest attempt (asked with filter=latest), and of the check runs one workflow
 *     made for one event on the head, only the newest of each name is read: a rerun job's
 *     earlier attempt, or the same job in an earlier run that a reopen re-ran, is not the
 *     result. A check of ANOTHER name is another check, whichever run carries it, so an
 *     earlier run is never dropped whole because a newer run of its workflow exists: two
 *     dispatches of "Build & push to GHCR" for different images make jobs `relay` and
 *     `identity`, and reading the newer alone would let a relay build still running, or red,
 *     through. An earlier run is left out only when it has concluded and every check run it
 *     lists lost to a newer one of the same name; one still running, one that lists no check
 *     run, and one with a check of its own still counted are read by their own status too.
 *   - THE SUITE TOO, unless its word is advisory. With SUITE_GATE=false (the repository
 *     variable JEV_MERGE_WAITS_FOR_SUITE=false) the runs named SUITE_WORKFLOW and their check
 *     runs are left out of this word as well, and the detail says so: counted here, a red or
 *     slow suite would refuse the merge that switch lets through.
 *   - BOTH LISTINGS, because neither is enough alone. A workflow run that is queued, or whose
 *     next job has not been created, has no check run to read yet, and one that failed to start
 *     (startup_failure) or waits for approval (action_required) never gets one; a check run
 *     from another app has no workflow run. Check SUITES are not read: GitHub creates one for
 *     every installed app on every push, and four here (claude, railway-app,
 *     cloudflare-workers-and-pages, fly-io) sit queued with no check run, forever.
 *   - EVERY PAGE, 100 at a time, and a listing that runs past MAX_PAGES is refused rather than
 *     read in part.
 *
 * The deadline is the suite's (SUITE_WAIT_MS from the start of this step), not a second one:
 * the checks get no time the suite does not. Mutation Gate runs on every pull request; on
 * 2026-10-26 and 27 its 63 successful runs (of 66) took 18 to 47 minutes from the push,
 * median 29, while this step starts about two minutes after it. A pull request whose Mutation
 * Gate is still running at the deadline is not merged by this run, and the next push decides
 * again. CHECKS_GATE=false (the repository variable JEV_MERGE_WAITS_FOR_CHECKS=false) gives the
 * checks no wait of their own: what they say once the suite's word is in, or that GitHub could
 * not list them then, is printed, not gated on.
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=<this run> \
 *     SELF_WORKFLOW="jev-harness (System One judgments)" SUITE_WORKFLOW="Bridge Typecheck" \
 *     [CHECKS_GATE=false] [SUITE_GATE=false] node tools/wait-for-workflow-run.mjs <40-hex-sha>
 *
 * Writes `result=<word>`, `url=<run page>`, `checks=<word>` and `checks_detail=<line>` to
 * $GITHUB_OUTPUT (and prints them). Exits 0 in every case where the suite's word is known: the
 * words are the decision's to act on, and a red run is already red on the pull request. Exit 2
 * only when this tool could not ask at all; `result` is then left out and `checks` says why.
 */

import { appendFileSync } from 'node:fs';
import { retryable } from './ci-green-for-sha.mjs';

export const SUITE_WORKFLOW = 'Bridge Typecheck';

/** A conclusion that does not stop the merge: the three ci-green-for-sha.mjs forgives. Anything else does, `cancelled` included. */
export const PASSING_CONCLUSIONS = Object.freeze(['success', 'neutral', 'skipped']);

/** Pages of 100 a listing may run to before it is refused rather than read in part. */
export const MAX_PAGES = 10;

const API = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';

/**
 * What the listing says about the suite run on this head. Pure. `runs` is the whole listing
 * (nothing dropped), newest first as GitHub lists it; `self` is the workflow this runs inside,
 * whose presence is what makes the listing trusted.
 */
export function suiteState(runs, { suite = SUITE_WORKFLOW, self }) {
  const trusted = runs.some((r) => r.name === self);
  const mine = runs.filter((r) => r.name === suite);
  if (mine.length === 0) {
    return trusted
      ? { state: 'absent', detail: `no ${suite} run is listed for this head; the listing holds ${self}, so it is trusted and the suite's paths did not match` }
      : { state: 'untrusted', detail: `the listing holds neither ${suite} nor ${self}, so it is not a listing to decide on` };
  }
  const pending = mine.find((r) => r.status !== 'completed');
  if (pending) return { state: 'pending', detail: `${suite} is ${pending.status ?? 'not concluded'}`, ...(pending.url ? { url: pending.url } : {}) };
  const run = mine[0];
  const conclusion = String(run.conclusion ?? 'unknown');
  return { state: conclusion === 'success' ? 'success' : conclusion, detail: `${suite} concluded ${conclusion}`, ...(run.url ? { url: run.url } : {}) };
}

/** Whether the loop asks again: while time remains, a pending or untrusted answer is not final. */
export function keepWaiting(state, expired) {
  return !expired && (state === 'pending' || state === 'untrusted');
}

const RUN_PAGE = /\/actions\/runs\/(\d+)(?:[/?#]|$)/;

/** The workflow run an Actions check run's page names (`.../actions/runs/<id>/job/<id>`), if it names one. */
function runIdOf(checkRun) {
  for (const u of [checkRun?.html_url, checkRun?.details_url]) {
    const m = typeof u === 'string' ? RUN_PAGE.exec(u) : null;
    if (m) return m[1];
  }
  return undefined;
}

function suiteIdOf(checkRun) {
  const id = checkRun?.check_suite?.id;
  return id === undefined || id === null ? undefined : String(id);
}

/** Newest first by the timestamp `at` reads (ISO strings sort as text), then by the larger id. */
const newestFirst = (at) => (a, b) => String(at(b) ?? '').localeCompare(String(at(a) ?? '')) || Number(b?.id ?? 0) - Number(a?.id ?? 0);

const passes = (conclusion) => PASSING_CONCLUSIONS.includes(String(conclusion));

/** At most `max` names, then how many more: a detail that stays one readable line. */
function names(list, max = 8) {
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} and ${list.length - max} more`;
}

/**
 * What the two listings say about every check on this head but this workflow's own. Pure.
 *
 * `runs` is the workflow-run listing for the head and `checkRuns` the check-run listing, both
 * as GitHub returns them (id, name, status, conclusion; a run's workflow_id, event,
 * check_suite_id, created_at; a check run's check_suite.id, app, started_at, html_url).
 * `selfRunId` is this run's id (GITHUB_RUN_ID): its workflow id is what is left out, and its
 * presence in both listings is what makes them trusted. `suiteGates: false` (the suite's word
 * is advisory) leaves the runs named `suite` and their check runs out as well, so that the
 * checks word does not gate on the suite after all.
 *
 * Returns { state: success | failure | pending | untrusted, failed, pending, passed, left, detail }.
 */
export function otherChecksState(runs, checkRuns, { selfRunId, suite = SUITE_WORKFLOW, suiteGates = true }) {
  const selfId = String(selfRunId ?? '');
  const self = selfId ? runs.find((r) => String(r?.id) === selfId) : undefined;
  if (!self) {
    return { state: 'untrusted', failed: [], pending: [], passed: 0, left: 0, detail: `the runs listed for this head do not hold this run (${selfId || 'no run id'}), so they are not a listing to decide on` };
  }
  const own = runs.filter((r) => r?.workflow_id === self.workflow_id);
  const ownSuites = new Set(own.map((r) => String(r.check_suite_id)));
  const ownRuns = new Set(own.map((r) => String(r.id)));
  const ofRuns = (c, suites, ids) => {
    const suiteId = suiteIdOf(c);
    const run = runIdOf(c);
    return (suiteId !== undefined && suites.has(suiteId)) || (run !== undefined && ids.has(run));
  };
  if (!checkRuns.some((c) => suiteIdOf(c) === String(self.check_suite_id) || runIdOf(c) === selfId)) {
    return { state: 'untrusted', failed: [], pending: [], passed: 0, left: 0, detail: 'the check runs listed for this head do not hold this run\'s own job, so they are not a listing to decide on' };
  }

  // An advisory suite is condition 10's to print. Counted here, its red would refuse the merge anyway.
  const advisory = suiteGates ? [] : runs.filter((r) => r?.workflow_id !== self.workflow_id && r?.name === suite);
  const advisorySuites = new Set(advisory.map((r) => String(r.check_suite_id)));
  const advisoryRuns = new Set(advisory.map((r) => String(r.id)));
  const others = runs.filter((r) => r?.workflow_id !== self.workflow_id && !advisory.includes(r));
  const bySuite = new Map(others.map((r) => [String(r.check_suite_id), r]));
  const byId = new Map(others.map((r) => [String(r.id), r]));
  const runOf = (c) => bySuite.get(suiteIdOf(c) ?? '') ?? byId.get(runIdOf(c) ?? '');

  // The newest check run of each NAME, per workflow and event: a rerun job's earlier attempt, or
  // the same job in an earlier run of the same workflow for the same event (a reopen), is not
  // its result. A check of another name is another check, whichever run carries it: two runs
  // dispatched with different inputs are two checks, not one superseding the other. A check run
  // whose workflow run is not listed is keyed by its check suite (or its app) instead.
  const keyOf = (c) => {
    const r = runOf(c);
    if (r) return `wf:${r.workflow_id}|${r.event}|${c?.name}`;
    const suiteId = suiteIdOf(c);
    return `${suiteId !== undefined ? `suite:${suiteId}` : `app:${c?.app?.id ?? c?.app?.slug ?? '?'}`}|${c?.name}`;
  };
  const newest = new Map();
  const listed = new Map();
  let left = own.length;
  let suiteLeft = advisory.length;
  for (const c of [...checkRuns].sort(newestFirst((x) => x?.started_at ?? x?.completed_at))) {
    if (ofRuns(c, ownSuites, ownRuns)) { left++; continue; }
    if (ofRuns(c, advisorySuites, advisoryRuns)) { suiteLeft++; continue; }
    const key = keyOf(c);
    if (!newest.has(key)) newest.set(key, c);
    const r = runOf(c);
    if (r) {
      if (!listed.has(String(r.id))) listed.set(String(r.id), []);
      listed.get(String(r.id)).push(c);
    }
  }
  // A run is superseded only when it has concluded and every check run it lists lost to a newer
  // one of the same name: then its own conclusion says nothing those do not. One still running,
  // one with a check run of its own still counted, and one that lists no check run at all (it
  // never started a job, or its jobs are not listed yet) all count by their own status as well.
  const isSuperseded = (r) => {
    const mine = listed.get(String(r.id)) ?? [];
    return r.status === 'completed' && mine.length > 0 && mine.every((c) => newest.get(keyOf(c)) !== c);
  };
  const superseded = new Set(others.filter(isSuperseded).map((r) => String(r.id)));
  const counted = others.filter((r) => !superseded.has(String(r.id)));

  const label = (c) => {
    const r = runOf(c);
    if (r) return `${r.name} / ${c.name}`;
    const app = c?.app?.slug;
    return app && app !== 'github-actions' ? `${c?.name ?? '(unnamed)'} (${app})` : String(c?.name ?? '(unnamed)');
  };
  const failed = [];
  const pending = [];
  let passed = 0;
  const runsFailing = new Set();
  const runsPending = new Set();
  for (const c of newest.values()) {
    const r = runOf(c);
    if (c?.status !== 'completed') {
      pending.push(label(c));
      if (r) runsPending.add(String(r.id));
    } else if (!passes(c.conclusion)) {
      failed.push(`${label(c)}: ${c.conclusion ?? 'no conclusion'}`);
      if (r) runsFailing.add(String(r.id));
    } else {
      passed++;
    }
  }
  // What a workflow run says that its check runs cannot (yet): queued with no job created, a job
  // not created behind another, or a run that never started one. Named once, not beside its job.
  for (const r of counted) {
    if (r.status !== 'completed') {
      if (!runsPending.has(String(r.id))) pending.push(`${r.name} (${r.status ?? 'not concluded'})`);
    } else if (!passes(r.conclusion) && !runsFailing.has(String(r.id))) {
      failed.push(`${r.name}: ${r.conclusion ?? 'no conclusion'}`);
    }
  }

  const aside = suiteLeft > 0 ? `; ${suite} left out (${suiteLeft} run(s) and job(s)), as its word is advisory` : '';
  if (failed.length > 0) {
    return { state: 'failure', failed, pending, passed, left, detail: `did not pass: ${names(failed)}${pending.length ? `; still running: ${names(pending)}` : ''}${aside}` };
  }
  if (pending.length > 0) {
    return { state: 'pending', failed, pending, passed, left, detail: `still running: ${names(pending)}${aside}` };
  }
  return { state: 'success', failed, pending, passed, left, detail: `${passed} check run(s) from ${counted.length} other workflow run(s) and any other app concluded success, neutral or skipped; ${left} run(s) and job(s) of this workflow left out${aside}` };
}

/**
 * Every item of a paginated GitHub listing (`key` names the array in each answer), 100 a page,
 * to the last page. An answer GitHub refused carries its status, so the loop can tell an outage
 * (5xx, asked again) from a refusal (final). A listing past `maxPages` full pages is refused:
 * read in part, it would leave out exactly the checks it did not reach.
 */
export async function listAll(url, key, { token, fetchFn = fetch, maxPages = MAX_PAGES }) {
  const items = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = `${url}${url.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
    const res = await fetchFn(pageUrl, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub answered ${res.status} for ${pageUrl}`), { status: res.status });
    const body = await res.json();
    const list = body?.[key];
    if (!Array.isArray(list)) throw Object.assign(new Error(`GitHub's answer for ${pageUrl} holds no ${key} list`), { status: 0 });
    // A listing that grows between two pages repeats an item; it is one item, not two.
    for (const item of list) items.set(item?.id === undefined || item?.id === null ? `#${items.size}` : String(item.id), item);
    if (list.length < 100) return [...items.values()];
  }
  throw Object.assign(new Error(`the ${key} for this head run past ${maxPages} pages of 100, and a listing read in part is not one to merge on`), { status: 0 });
}

/** The workflow runs for a head, newest first, every page. */
export function listWorkflowRuns(sha, { repo, ...rest }) {
  return listAll(`${API}/repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs', rest);
}

/** The check runs for a head, from every app, the latest attempt of each, every page. */
export function listCheckRuns(sha, { repo, ...rest }) {
  return listAll(`${API}/repos/${repo}/commits/${sha}/check-runs?filter=latest`, 'check_runs', rest);
}

const named = (r) => ({ name: r?.name ?? '(unnamed)', status: r?.status, conclusion: r?.conclusion, ...(typeof r?.html_url === 'string' ? { url: r.html_url } : {}) });

/**
 * The wait itself, with its clock, its sleep and GitHub injected so the deadline is testable.
 * Polls until the suite's word and the checks' word are both final, or the deadline passes.
 * Returns { suite?: { result, url, detail }, checks: { result, detail }, fatal?: string }:
 * `fatal`, and no `suite`, when the runs could not be listed at all.
 */
export async function waitForHead({
  sha, repo, token, self, suite = SUITE_WORKFLOW, selfRunId, checksGate = true, suiteGate = true,
  timeoutMs, pollMs, fetchFn = fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log,
}) {
  const opts = { repo, token, fetchFn };
  const deadline = now() + timeoutMs;
  let suiteDone;
  let checksDone;
  for (;;) {
    const expired = now() > deadline;
    let runs;
    try {
      runs = await listWorkflowRuns(sha, opts);
    } catch (err) {
      if (retryable(err) && !expired) {
        log(`GitHub is not answering (${err.message}); asking again`);
        await sleep(pollMs);
        continue;
      }
      const checks = checksDone ?? { result: 'error', detail: `the workflow runs for this head could not be listed: ${err.message}` };
      if (suiteDone) return { suite: suiteDone, checks };
      return { checks, fatal: `could not list the runs for ${sha.slice(0, 12)}: ${err.message}` };
    }

    if (!suiteDone) {
      const s = suiteState(runs.map(named), { suite, self });
      if (keepWaiting(s.state, expired)) {
        log(`${s.detail}; asking again in ${Math.round(pollMs / 1000)} s`);
      } else {
        suiteDone = { result: s.state === 'pending' ? 'timeout' : s.state, url: s.url ?? '', detail: s.detail };
        log(`${suite} on ${sha.slice(0, 12)}: ${suiteDone.result} — ${s.detail}`);
      }
    }

    if (!checksDone) {
      if (!selfRunId) {
        checksDone = { result: 'error', detail: 'GITHUB_RUN_ID is not set, so this run cannot tell its own jobs from the checks it waits for' };
      } else {
        let checkRuns;
        try {
          checkRuns = await listCheckRuns(sha, opts);
        } catch (err) {
          // Advisory checks get no time of their own here either: once the suite's word is in, an
          // outage is what they say, not a reason to keep the decision waiting to the deadline.
          if (retryable(err) && !expired && (checksGate || !suiteDone)) log(`GitHub is not answering for the check runs (${err.message}); asking again`);
          else checksDone = { result: 'error', detail: `the check runs for this head could not be listed: ${err.message}` };
        }
        if (checkRuns) {
          const c = otherChecksState(runs, checkRuns, { selfRunId, suite, suiteGates: suiteGate });
          // Advisory checks get no time of their own: what they say once the suite's word is in is what is printed.
          if (keepWaiting(c.state, expired) && (checksGate || !suiteDone)) {
            log(`other checks: ${c.detail}; asking again in ${Math.round(pollMs / 1000)} s`);
          } else {
            checksDone = { result: c.state === 'pending' ? (expired ? 'timeout' : 'pending') : c.state, detail: c.detail };
            log(`other checks on ${sha.slice(0, 12)}: ${checksDone.result} — ${c.detail}`);
          }
        }
      }
    }

    if (suiteDone && checksDone) return { suite: suiteDone, checks: checksDone };
    await sleep(pollMs);
  }
}

function output(fields) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}`);
  console.log(lines.join('\n'));
  const file = process.env['GITHUB_OUTPUT'];
  if (file) appendFileSync(file, lines.join('\n') + '\n');
}

async function main() {
  const sha = process.argv[2];
  const repo = process.env['GITHUB_REPOSITORY'];
  const token = process.env['GITHUB_TOKEN'];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    console.error(`usage: node tools/wait-for-workflow-run.mjs <40-hex-sha> (got: ${sha ?? '(none)'})`);
    process.exit(2);
  }
  if (!repo || !token) {
    console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are both required to list the runs for a commit.');
    process.exit(2);
  }
  const done = await waitForHead({
    sha, repo, token,
    self: process.env['SELF_WORKFLOW'] ?? 'jev-harness (System One judgments)',
    suite: process.env['SUITE_WORKFLOW'] ?? SUITE_WORKFLOW,
    selfRunId: process.env['GITHUB_RUN_ID'],
    checksGate: process.env['CHECKS_GATE'] !== 'false',
    suiteGate: process.env['SUITE_GATE'] !== 'false',
    timeoutMs: Number(process.env['SUITE_WAIT_MS'] ?? 20 * 60 * 1000),
    pollMs: Number(process.env['SUITE_POLL_MS'] ?? 30_000),
  });
  if (!done.suite) {
    console.error(done.fatal);
    output({ checks: done.checks.result, checks_detail: done.checks.detail });
    process.exit(2);
  }
  output({ result: done.suite.result, url: done.suite.url, checks: done.checks.result, checks_detail: done.checks.detail });
}

const invokedDirectly = process.argv[1] && /wait-for-workflow-run\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(2); });
