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
 *              (the one word kept from poll to poll, with error: any other is read again on
 *              every poll until the wait returns, so a green read while an advisory suite
 *              still runs is not what is returned once a check has gone red or a run started)
 *   timeout    the deadline passed with a check still running              → fails
 *   untrusted  the listings never held this run and its own job            → fails at the deadline
 *   error      GitHub could not be asked (a 4xx at once, a 5xx at the deadline, a listing
 *              longer than MAX_PAGES pages, no GITHUB_RUN_ID)             → fails
 *   pending    only when advisory (CHECKS_GATE=false): still running when the suite wait ended
 *
 * with `checks_detail`, one line naming what failed or what was still running (and, for a red
 * that a newer run of its group left standing, why, and the remedy that applies: re-run that
 * run, and reopen where a run made after it would answer it; for a red report created through
 * the API, that only the next push decides again). Which checks count, and which try of each
 * (`otherChecksState`):
 *
 *   - THIS WORKFLOW'S OWN are left out by workflow id, never by name: every run of this
 *     workflow on the head (this one, one a reopen left, the close-time one), every Actions
 *     job of one of them, and a check run that names no page at all (neither html_url nor
 *     details_url) whose check suite is one of theirs. A name is a string any workflow can
 *     carry, and a check run created through the API in their suite has a page of its own and
 *     is another check. Counted, this job would wait for itself until the deadline.
 *   - AN ACTIONS JOB is a check run of the github-actions app whose html_url is a job page,
 *     `/actions/runs/<run>/job/<job>`, and only that files a check run under a workflow run.
 *     GitHub sets html_url; details_url is whatever a check's creator sets (a report created
 *     through the API may link back to the run that made it), so it never decides which run a
 *     check run belongs to, and a page that names a run but no job of it files nothing.
 *   - A WORKFLOW RUN DECIDES FOR ITS JOBS. GitHub concludes a run from every job of its latest
 *     try (a job its re-run kept, two legs that share a name, a job never created behind
 *     another, a job that timed out, which its check run lists as cancelled), so each run is
 *     read by its own conclusion and its check runs only name what it says. A run still going
 *     is pending whatever its jobs said so far: a job that may fail (continue-on-error) leaves
 *     its run green. So is a run listed as concluded while a job of it is still going, started
 *     after the run's updated_at, or concluded red after it: the runs listing, read first, has
 *     not caught up with the check runs (a re-run of a concluded run gives each job a new check
 *     run, and a new try that passed says nothing of the job behind it, whose old try still
 *     stands in the listing until its new check run is created).
 *   - TRIES OF ONE CHECK. Runs of one workflow for one event are tries of the same check (a
 *     reopen starts every pull_request workflow again); a dispatch is its own, since two carry
 *     their own inputs (two GHCR builds), so only its own re-run answers it. A run that did not
 *     pass is answered only by a newer run of its group (made after it, so a re-run of an older
 *     run, which tests the merge commit of its own event, never answers a newer one) that tried
 *     again after it finished: made after it last finished (updated_at, which a re-run moves on),
 *     or whose every try at each job that went red in it started in the second the last of its
 *     listed jobs ended or later, or has not started yet (a run a concurrency group held until
 *     this one ended; one whose cancel-in-progress landed before the newer run's job started).
 *     The start is timed against the jobs, not updated_at: GitHub writes a run's updated_at up to
 *     a second after its last job ends, and the run that took a cancel-in-progress slot can start
 *     its job in that second. Whole seconds cut both ways: a try started in the very second the
 *     red run's last job ended counts as after it, though it may have begun up to a second
 *     before. It must also have run each of those jobs again, without skipping it; one still
 *     going answers for now and decides by its own conclusion. So two runs that overlapped and
 *     disagree refuse; so does a cancel that landed in a later second than the newer run's try at
 *     that job started (a cancel by hand, or a job that timed out, which GitHub lists as
 *     cancelled: the newer run's try may never have answered the hang; one that landed in the
 *     second that try started reads as answered); and so does a red job the newer run skipped (a
 *     reporter that runs only on failure) or has no job of that name for (a job the base
 *     renamed). Each says so in the detail, with its remedy. A cancelled run that lists no red
 *     job has no try to time: a newer run made after it finished answers it by its own
 *     conclusion, if that run ran something (a job it did not skip), and one made before it
 *     finished refuses at once. Any other run whose red jobs are not listed is answered by no run
 *     that has concluded, and a run cancelled before it made any job ran nothing and is left out
 *     once a newer run of its group exists (a dispatch's group is itself, so never). The next
 *     push decides again.
 *   - EVERY OTHER CHECK RUN BY ITSELF: another app's, a report a workflow created through the
 *     API, and an Actions job whose run the runs listing does not hold yet (it waits for that
 *     run, whatever it concluded: a job that passed says nothing of the jobs behind it). Another
 *     app re-runs a check by creating a new check run of its name, so a red one is answered only
 *     by a later one of its name in its check suite (a larger id) that is a result (not a skip or
 *     a cancel) and that started in the second it concluded or later (GitHub's times are whole
 *     seconds), or has not started yet. An app that starts the replacement before it closes the
 *     old check as cancelled is not answered: the cancel landed after the replacement started. A
 *     report (a github-actions check run that is no run's job: one a workflow created through the
 *     API with GITHUB_TOKEN) is answered by nothing. The suite it lands in is GitHub's pick, and
 *     nothing it carries names the workflow, dispatch or leg that posted it, so a later report of
 *     its name cannot be shown to be the same check tried again (another workflow's, dispatch's
 *     or leg's did not run the tests behind it). A red one refuses until the next push, and the
 *     detail says so.
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
 * median 29, so jev-harness.yml sets SUITE_WAIT_MS to fifty minutes (and the job's
 * timeout-minutes to 70). A check still running at the deadline means no merge; the next push
 * decides again, and Mutation Gate starts over with it. CHECKS_GATE=false (the repository variable
 * JEV_MERGE_WAITS_FOR_CHECKS=false) gives the checks no wait of their own: what they say once
 * the suite's word is in, or that GitHub could not list them then, is printed, not gated on.
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

// GitHub sets a check run's html_url: an Actions job's is its page in its workflow run,
// `.../actions/runs/<run>/job/<job>`, and a check run created through the API gets a page of its
// own, `.../<owner>/<repo>/runs/<id>`. Its details_url is whatever its creator set (a report
// created through the API may link the run that made it), so it never says which run a check
// run belongs to.
const JOB_PAGE = /\/actions\/runs\/(\d+)\/job\/\d+(?:[/?#]|$)/;
const ACTIONS = 'github-actions';

/** The workflow run an Actions job belongs to: named only by a github-actions check run whose html_url is a job page. */
function jobRunOf(checkRun) {
  if (checkRun?.app?.slug !== ACTIONS || typeof checkRun?.html_url !== 'string') return undefined;
  return JOB_PAGE.exec(checkRun.html_url)?.[1];
}

function suiteIdOf(checkRun) {
  const id = checkRun?.check_suite?.id;
  return id === undefined || id === null ? undefined : String(id);
}


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
 * check_suite_id, created_at, updated_at; a check run's check_suite.id, app, started_at,
 * completed_at, html_url).
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
  // An Actions job is matched by the run its page names. Only a check run that names no page at
  // all (neither html_url nor details_url) is matched by its check suite alone: one a workflow creates through the API (a test
  // reporter) can land in any suite on the head and has a page of its own, so it is another check.
  const ofRuns = (c, suites, ids) => {
    const run = jobRunOf(c);
    if (run !== undefined) return ids.has(run);
    const suiteId = suiteIdOf(c);
    return suiteId !== undefined && suites.has(suiteId) && !c?.html_url && !c?.details_url;
  };
  if (!checkRuns.some((c) => suiteIdOf(c) === String(self.check_suite_id) || jobRunOf(c) === selfId)) {
    return { state: 'untrusted', failed: [], pending: [], passed: 0, left: 0, detail: 'the check runs listed for this head do not hold this run\'s own job, so they are not a listing to decide on' };
  }

  // An advisory suite is condition 10's to print. Counted here, its red would refuse the merge anyway.
  const advisory = suiteGates ? [] : runs.filter((r) => r?.workflow_id !== self.workflow_id && r?.name === suite);
  const advisorySuites = new Set(advisory.map((r) => String(r.check_suite_id)));
  const advisoryRuns = new Set(advisory.map((r) => String(r.id)));
  const others = runs.filter((r) => r?.workflow_id !== self.workflow_id && !advisory.includes(r));
  const byId = new Map(others.map((r) => [String(r.id), r]));

  // A workflow run decides for its jobs. GitHub's conclusion of a run covers every job of its
  // latest try: a job its re-run kept, two legs that share a name, a job that timed out (which
  // its check run lists as cancelled), a job behind another that was never created. So the
  // check runs of a run only name what it says. A check run is filed under a run only when it is
  // an Actions job of it: app github-actions, html_url that run's job page. Every other check run
  // is read by itself: one from another app, one a workflow created through the API (it has a
  // page of its own, whatever its details_url links), and an Actions job whose run is not
  // listed yet.
  const jobsOf = new Map();
  const byName = new Map();
  const reports = [];
  const unlisted = [];
  const seen = new Set();
  let left = own.length;
  let suiteLeft = advisory.length;
  for (const c of checkRuns) {
    if (ofRuns(c, ownSuites, ownRuns)) { left++; continue; }
    if (ofRuns(c, advisorySuites, advisoryRuns)) { suiteLeft++; continue; }
    if (c?.id !== undefined && c?.id !== null) {
      if (seen.has(String(c.id))) continue;
      seen.add(String(c.id));
    }
    const page = jobRunOf(c);
    if (page !== undefined) {
      const r = byId.get(page);
      if (!r) { unlisted.push(c); continue; }
      if (!jobsOf.has(String(r.id))) jobsOf.set(String(r.id), []);
      jobsOf.get(String(r.id)).push(c);
      continue;
    }
    // A github-actions check run that is not a job of a run was created through the API by a
    // workflow: a report. The suite it lands in is GitHub's pick, and nothing it carries says which
    // workflow, dispatch or leg posted it, so a later report of its name cannot be shown to be the
    // same check tried again (another workflow's, dispatch's or leg's did not run the tests behind
    // it). Each is read alone.
    if (c?.app?.slug === ACTIONS) { reports.push(c); continue; }
    // Another app's check is one per name in its check suite.
    const suiteId = suiteIdOf(c);
    const key = `${suiteId !== undefined ? `suite:${suiteId}` : `app:${c?.app?.id ?? c?.app?.slug ?? '?'}`}|${c?.name}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }

  // Runs of one workflow for one event on one head are tries of the same thing: a reopen starts
  // every pull_request workflow again. A dispatch is its own: two dispatches carry their own
  // inputs (two GHCR builds for two images), so only its own re-run answers it. A run that did
  // not pass is answered only by a newer run of its group (made after it, so a re-run of an
  // older run, which tests the merge commit of its own event, never answers a newer one) that
  // tried again after it finished: made after it last finished (its updated_at, which a re-run
  // moves on, as does anything else that touches the run: later is the safe side), or whose
  // every try at each job that went red in it started in the second its last listed job ended or
  // later, or has not started yet (a run a concurrency group held until this one ended, or one
  // whose cancel-in-progress landed before the newer run's job started). The start is timed
  // against the jobs, not updated_at: GitHub writes a run's updated_at up to a second after its
  // last job ends, and the run that took a cancel-in-progress slot can start its job in that
  // second. So two runs that overlapped and disagree refuse, and so does a cancel that landed in
  // a later second than the newer run's try at that job started: GitHub lists a job that timed
  // out as cancelled, and the newer run's try may never have answered the hang. Whole seconds cut
  // both ways: a try started in the very second the red run's last job ended counts as after it,
  // though it may have begun up to a second before, so a cancel by hand or a timeout that landed
  // in that same second reads as answered.
  const dispatch = (e) => e === 'workflow_dispatch' || e === 'repository_dispatch';
  const groupOf = (r) => (dispatch(r?.event) ? `run:${r.id}` : `wf:${r.workflow_id}|${r.event}`);
  const groups = new Map();
  for (const r of others) {
    if (!groups.has(groupOf(r))) groups.set(groupOf(r), []);
    groups.get(groupOf(r)).push(r);
  }
  const madeAt = (r) => Date.parse(String(r?.created_at));
  const after = (a, b) => (madeAt(a) !== madeAt(b) ? madeAt(a) > madeAt(b) : Number(a?.id ?? 0) > Number(b?.id ?? 0));
  // When the last of a run's listed jobs ended, or NaN when none says.
  const lastJobEnded = (r) => {
    const times = (jobsOf.get(String(r?.id)) ?? []).map((c) => Date.parse(String(c?.completed_at))).filter((t) => !Number.isNaN(t));
    return times.length ? Math.max(...times) : NaN;
  };
  const finishedAt = (r) => (r?.updated_at ? Date.parse(String(r.updated_at)) : lastJobEnded(r));
  const triesEnded = (r) => (Number.isNaN(lastJobEnded(r)) ? finishedAt(r) : lastJobEnded(r));
  // A try that started in the second `t` or later (GitHub's times are whole seconds, so one that
  // started in the second `t` counts as after it); one that has neither started nor concluded can
  // only start later still. One concluded with no start time says nothing of when it ran.
  const startedFrom = (c, t) => (c?.started_at ? Date.parse(String(c.started_at)) >= t : c?.status !== 'completed');
  const tries = (n, name) => (jobsOf.get(String(n.id)) ?? []).filter((c) => c?.name === name);
  const redNames = (r) => [...new Set((jobsOf.get(String(r.id)) ?? []).filter((c) => c?.status === 'completed' && !passes(c.conclusion)).map((c) => c?.name))];
  // Why the newer run n does not answer r, or undefined when it does. Beyond trying again after r
  // finished, it must have run again what went red in r: a job of each red job's name that was not
  // skipped (a newer run whose condition skipped that job never tested it; one it cancelled is the
  // newer run's own red, read as such). A newer run still going may yet run it, so it answers for
  // now and decides by its own conclusion. A cancelled run that lists no red job (its unfinished
  // jobs were never created) has no try to time: a newer run made after it finished answers it by
  // its own conclusion, which covers them, if that run ran something. Any other run whose red jobs
  // are not listed (the listing lags) is answered by no run that has concluded, so a reopen would
  // not answer it either. `reopen`: a reopen, which makes a run after it, would answer it.
  const notAnswer = (n, r) => {
    const red = redNames(r);
    const done = finishedAt(r);
    if (n.conclusion === 'skipped') return { cause: 'was skipped whole' };
    if (!(madeAt(n) > done)) {
      if (!red.length) return { cause: 'was made before the red run finished', reopen: r.conclusion === 'cancelled' };
      const ended = triesEnded(r);
      const early = red.find((name) => !tries(n, name).every((c) => startedFrom(c, ended)));
      if (early !== undefined) return { cause: `started ${early} before the red run finished`, reopen: true };
    }
    if (n.status !== 'completed') return undefined;
    for (const name of red) {
      const t = tries(n, name);
      if (!t.length) return { cause: `has no job named ${name}` };
      if (t.every((c) => c?.conclusion === 'skipped')) return { cause: `skipped ${name}` };
    }
    if (red.length) return undefined;
    if (r.conclusion !== 'cancelled') return { cause: 'cannot be shown to have run again what went red, as the red run lists no red job' };
    if (!(jobsOf.get(String(n.id)) ?? []).some((c) => c?.conclusion !== 'skipped')) return { cause: 'ran nothing', reopen: true };
    return undefined;
  };
  const newer = (r) => (groups.get(groupOf(r)) ?? []).filter((n) => n !== r && after(n, r));
  const answered = (r) => newer(r).some((n) => notAnswer(n, r) === undefined);
  // What a refusal that a newer run left standing needs: its cause, from the newest of them, and
  // the remedy. A dispatch is told to re-run, since another dispatch does not answer it.
  const remedy = (r) => {
    if (dispatch(r?.event)) return `${r.name} run ${r.id} is a dispatch, answered only by its own re-run (a new dispatch does not answer it): re-run ${r.id}`;
    const ns = newer(r);
    if (!ns.length) return undefined;
    const n = ns.reduce((a, b) => (after(b, a) ? b : a));
    const why = notAnswer(n, r);
    return why && `${r.name} run ${r.id} is not answered by the newer run ${n.id}, which ${why.cause}: re-run ${r.id}${why.reopen ? ', or reopen' : ''}`;
  };
  // A run cancelled before it made any job (a concurrency group's cancel of a queued run) ran
  // nothing, so it hides no result: a newer run of its group is what replaced it.
  const ranNothing = (r) => r?.status === 'completed' && r?.conclusion === 'cancelled' && !(jobsOf.get(String(r.id))?.length)
    && (groups.get(groupOf(r)) ?? []).some((n) => n !== r && after(n, r));

  const failed = [];
  const pending = [];
  const notes = [];
  let passed = 0;
  const counted = [];
  for (const r of others) {
    if (ranNothing(r)) continue;
    const jobs = jobsOf.get(String(r.id)) ?? [];
    // Listed as concluded, while a job of it is still going, started after the run concluded, or
    // went red after it: the runs listing has not caught up with the check runs (they are read one
    // after the other, and a re-run of a concluded run gives each job a new check run). A new try
    // that passed says nothing of the jobs behind it, which get their new check runs only when their
    // turn comes, so their old tries still stand for them in the listing. Its conclusion is not
    // yet the one to read, so it waits. A red that started and concluded before its run did
    // (continue-on-error) follows the run's conclusion.
    const late = (t) => Date.parse(String(t)) > Date.parse(String(r.updated_at));
    const lateRed = (c) => !passes(c?.conclusion) && late(c?.completed_at);
    const lagging = r.status === 'completed' ? jobs.filter((c) => c?.status !== 'completed' || late(c?.started_at) || lateRed(c)) : [];
    if (r.status !== 'completed') {
      // Still going: its own conclusion decides, and a job of it already red does not yet, since
      // a job that may fail (continue-on-error, as nightly-emergent's advisory legs) leaves its
      // run green. It names what is still running, and what has gone red so far.
      counted.push(r);
      const running = jobs.filter((c) => c?.status !== 'completed');
      const red = jobs.filter((c) => c?.status === 'completed' && !passes(c.conclusion));
      for (const c of running) pending.push(`${r.name} / ${c.name}`);
      for (const c of red) pending.push(`${r.name} / ${c.name} (${c.conclusion ?? 'no conclusion'}; its run has not concluded)`);
      if (!running.length && !red.length) pending.push(`${r.name} (${r.status ?? 'not concluded'})`);
    } else if (lagging.length) {
      counted.push(r);
      for (const c of lagging) {
        if (c?.status !== 'completed') pending.push(`${r.name} / ${c.name} (its run is listed as concluded ${r.conclusion ?? 'with no conclusion'}; the listings have not caught up)`);
        else if (lateRed(c)) pending.push(`${r.name} / ${c.name} (${c.conclusion ?? 'no conclusion'} after its run concluded; the listings have not caught up)`);
        else pending.push(`${r.name} / ${c.name} (${c.conclusion ?? 'no conclusion'}, a try started after its run concluded; the listings have not caught up)`);
      }
    } else if (passes(r.conclusion)) {
      counted.push(r);
      passed += jobs.filter((c) => c?.status === 'completed' && passes(c.conclusion)).length;
    } else if (!answered(r)) {
      counted.push(r);
      const red = jobs.filter((c) => c?.status === 'completed' && !passes(c.conclusion));
      if (red.length) for (const c of red) failed.push(`${r.name} / ${c.name}: ${c.conclusion ?? 'no conclusion'}`);
      else failed.push(`${r.name}: ${r.conclusion ?? 'no conclusion'}`);
      const note = remedy(r);
      if (note) notes.push(note);
    }
  }
  // Another app re-runs its check by creating a new check run of its name: what did not pass is
  // answered only by a later one of its name in its check suite (a larger id) that is a result
  // (not a skip, not a cancel) and started in the second it concluded or later, or that has not
  // started.
  const answers = (c, than) => {
    if (c === than || than?.status !== 'completed' || passes(than.conclusion) || Number(c?.id ?? 0) <= Number(than?.id ?? 0)) return false;
    if (c?.conclusion === 'skipped' || (c?.status === 'completed' && c?.conclusion === 'cancelled')) return false;
    return startedFrom(c, Date.parse(String(than.completed_at)));
  };
  const label = (c) => {
    const app = c?.app?.slug;
    return app && app !== ACTIONS ? `${c?.name ?? '(unnamed)'} (${app})` : String(c?.name ?? '(unnamed)');
  };
  for (const group of byName.values()) {
    for (const c of group) {
      if (group.some((o) => answers(o, c))) continue;
      if (c?.status !== 'completed') pending.push(label(c));
      else if (!passes(c.conclusion)) failed.push(`${label(c)}: ${c.conclusion ?? 'no conclusion'}`);
      else passed++;
    }
  }
  // A report a workflow created through the API is read alone: nothing answers its red but the
  // next push, and the detail says so.
  for (const c of reports) {
    if (c?.status !== 'completed') pending.push(label(c));
    else if (passes(c.conclusion)) passed++;
    else {
      failed.push(`${label(c)}: ${c.conclusion ?? 'no conclusion'}`);
      notes.push(`${label(c)} is a report a workflow created through the API, which no later report can be shown to try again (nothing it carries names the run that posted it): only the next push decides again`);
    }
  }
  // An Actions job whose run the runs listing does not hold yet (GitHub's listings catch up with
  // each other): its run decides, and a job of it that passed says nothing of the jobs behind it
  // that are not created yet, so it waits for its run whatever it concluded.
  for (const c of unlisted) pending.push(`${c?.name ?? '(unnamed)'} (its run is not listed yet)`);

  const aside = suiteLeft > 0 ? `; ${suite} left out (${suiteLeft} run(s) and job(s)), as its word is advisory` : '';
  if (failed.length > 0) {
    const why = notes.length ? ` (${notes.length <= 3 ? notes.join('; ') : `${notes.slice(0, 3).join('; ')}; and ${notes.length - 3} more`})` : '';
    return { state: 'failure', failed, pending, passed, left, detail: `did not pass: ${names(failed)}${why}${pending.length ? `; still running: ${names(pending)}` : ''}${aside}` };
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
 * Polls until the suite's word is final and the checks' word read on that same poll is too (a
 * red check, or a refused listing, is kept from the poll it was read on), or the deadline passes.
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
  // Only a red check or a listing GitHub refused is kept from one poll to the next: nothing a
  // later poll reads can make either a merge. Any other word is this poll's alone, and the checks
  // are read again on every poll until the wait returns. While an advisory suite (left out of the
  // checks) still runs, a green word read early would otherwise be returned at the end over a check
  // that went red, or a run that started, in between.
  let checksFinal;
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
      const checks = checksFinal ?? { result: 'error', detail: `the workflow runs for this head could not be listed: ${err.message}` };
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

    let checksNow = checksFinal;
    if (!checksNow) {
      if (!selfRunId) {
        checksNow = checksFinal = { result: 'error', detail: 'GITHUB_RUN_ID is not set, so this run cannot tell its own jobs from the checks it waits for' };
      } else {
        let checkRuns;
        try {
          checkRuns = await listCheckRuns(sha, opts);
        } catch (err) {
          // Advisory checks get no time of their own here either: once the suite's word is in, an
          // outage is what they say, not a reason to keep the decision waiting to the deadline.
          if (retryable(err) && !expired && (checksGate || !suiteDone)) log(`GitHub is not answering for the check runs (${err.message}); asking again`);
          else checksNow = checksFinal = { result: 'error', detail: `the check runs for this head could not be listed: ${err.message}` };
        }
        if (checkRuns) {
          const c = otherChecksState(runs, checkRuns, { selfRunId, suite, suiteGates: suiteGate });
          // Advisory checks get no time of their own: what they say once the suite's word is in is what is printed.
          if (keepWaiting(c.state, expired) && (checksGate || !suiteDone)) {
            log(`other checks: ${c.detail}; asking again in ${Math.round(pollMs / 1000)} s`);
          } else {
            checksNow = { result: c.state === 'pending' ? (expired ? 'timeout' : 'pending') : c.state, detail: c.detail };
            if (c.state === 'failure') checksFinal = checksNow;
            log(`other checks on ${sha.slice(0, 12)}: ${checksNow.result} — ${c.detail}${suiteDone || checksFinal ? '' : '; read again until the suite\'s word is in'}`);
          }
        }
      }
    }

    if (suiteDone && checksNow) return { suite: suiteDone, checks: checksNow };
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
