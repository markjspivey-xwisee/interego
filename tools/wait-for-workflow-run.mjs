#!/usr/bin/env node
/**
 * Has the whole-suite workflow concluded on this pull request's head, and how? The gated
 * auto-merge's last condition.
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
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo SELF_WORKFLOW="jev-harness (System One judgments)" \
 *     SUITE_WORKFLOW="Bridge Typecheck" node tools/wait-for-workflow-run.mjs <40-hex-sha>
 *
 * Writes `result=<word>` and `url=<run page>` to $GITHUB_OUTPUT (and prints them). Exits 0 in
 * every case: the word is the decision's to act on, and the suite's own run is already red on
 * the pull request when it failed. Exit 2 only when this tool could not ask at all.
 */

import { appendFileSync } from 'node:fs';
import { retryable, runsForSha } from './ci-green-for-sha.mjs';

export const SUITE_WORKFLOW = 'Bridge Typecheck';

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

function output(result, url) {
  const lines = [`result=${result}`, `url=${url ?? ''}`];
  console.log(lines.join('\n'));
  const file = process.env['GITHUB_OUTPUT'];
  if (file) appendFileSync(file, lines.join('\n') + '\n');
}

async function main() {
  const sha = process.argv[2];
  const repo = process.env['GITHUB_REPOSITORY'];
  const token = process.env['GITHUB_TOKEN'];
  const self = process.env['SELF_WORKFLOW'] ?? 'jev-harness (System One judgments)';
  const suite = process.env['SUITE_WORKFLOW'] ?? SUITE_WORKFLOW;
  const timeoutMs = Number(process.env['SUITE_WAIT_MS'] ?? 20 * 60 * 1000);
  const pollMs = Number(process.env['SUITE_POLL_MS'] ?? 30_000);
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    console.error(`usage: node tools/wait-for-workflow-run.mjs <40-hex-sha> (got: ${sha ?? '(none)'})`);
    process.exit(2);
  }
  if (!repo || !token) {
    console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are both required to list the runs for a commit.');
    process.exit(2);
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const expired = Date.now() > deadline;
    let runs;
    try {
      runs = await runsForSha(sha, { repo, token, self: '', ignore: [] });
    } catch (err) {
      if (retryable(err) && !expired) {
        console.log(`GitHub is not answering (${err.message}); asking again`);
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      console.error(`could not list the runs for ${sha.slice(0, 12)}: ${err.message}`);
      process.exit(2);
    }
    const s = suiteState(runs, { suite, self });
    if (keepWaiting(s.state, expired)) {
      console.log(`${s.detail}; asking again in ${Math.round(pollMs / 1000)} s`);
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    const result = s.state === 'pending' ? 'timeout' : s.state;
    console.log(`${suite} on ${sha.slice(0, 12)}: ${result} — ${s.detail}`);
    output(result, s.url);
    return;
  }
}

const invokedDirectly = process.argv[1] && /wait-for-workflow-run\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(2); });
