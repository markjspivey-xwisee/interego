#!/usr/bin/env node
/**
 * Is every OTHER workflow for this commit finished and green? Auto-deploy's gate.
 *
 * ── ★★ WHY A DEPLOY MUST WAIT FOR CI, NOT JUST FOR A BUILD ───────────────────────────────────
 *
 * A built image is not a tested one. `build-ghcr.yml` compiles and pushes; it runs no test, no
 * typecheck, no mutation gate. Deploying on "the image exists" would ship whatever compiled — and
 * this repository has already paid for skipping the wait once: the note in its own memory reads
 * "CI is a DEPLOY GATE; skipping it took the bridge down."
 *
 * So auto-deploy blocks here until every other workflow run for the same sha has CONCLUDED, and
 * refuses unless all of them succeeded.
 *
 * ── ★ WHY IT COUNTS RUNS AND REFUSES A SMALL NUMBER ──────────────────────────────────────────
 *
 * The dangerous answer is not "red" — red stops the deploy, which is the point. It is an EMPTY
 * list: a mistyped sha, a token without `actions:read`, or a query made before any workflow has
 * registered all return "nothing is failing", which reads as green and deploys unverified code.
 * That is the same shape as every census floor in this repo, so there is one here: fewer than
 * MIN_RUNS concluded runs is a refusal, not a pass.
 *
 * ── WHAT COUNTS AS SUCCESS ───────────────────────────────────────────────────────────────────
 *
 * `success`, and `skipped` / `neutral` — a job a `paths:` filter correctly declined to run has not
 * failed. Anything else (`failure`, `cancelled`, `timed_out`, `action_required`, `stale`) stops the
 * deploy. Cancelled is deliberately NOT forgiven: a cancelled test run is a test that did not
 * report, and "it was probably fine" is the reasoning this gate exists to replace.
 *
 * ── ★ WHY A SHORT LISTING IS A WAIT, NOT A VERDICT ──────────────────────────────────────────
 *
 * GitHub's runs listing is eventually consistent. On 2026-09-21 this gate watched the five runs
 * for 0f40814b narrow to two still going, and the next poll answered 200 with an EMPTY list; the
 * floor read that as "too few" and refused a commit whose CI concluded green four minutes later.
 * So below the floor is now a reason to poll again while time remains, and a refusal only when
 * the listing is still short at the deadline: a mistyped sha or a token without actions:read is
 * still never read as green, it is refused at the end of the wait instead of at the start. A
 * 5xx from GitHub is retried the same way; a 4xx is refused at once, because a token without
 * permission does not fix itself. `nextStep` and `retryable` are those two decisions, pure and
 * tested beside `verdict`.
 *
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node tools/ci-green-for-sha.mjs <40-hex-sha>
 *
 * Exit 0 = every other workflow concluded successfully. 1 = something failed or never finished.
 * 2 = this tool could not find out, which is never treated as green.
 */

const API = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';

/**
 * How many concluded runs must exist before "nothing failed" is allowed to mean anything.
 *
 * 4 -> 2 (2026-09-22): the floor was calibrated while the mutation gate ran on every master
 * push with no path filter, so four runs always existed. Once that gate moved to pull
 * requests only, a merge touching only workflows and the changelog produced three (ESLint,
 * Bridge Typecheck, pages) and the gate refused c24a74a8 after waiting half an hour for a
 * fourth that nothing would ever start. Counting was always a proxy for "is this listing
 * real"; REQUIRED_RUNS asks that directly, and the count only has to exceed the empty list.
 */
export const MIN_RUNS = 2;

/**
 * Workflows that run on EVERY push to master with no path filter. Their presence in the listing
 * is what proves the listing is real: a mistyped sha, a token without actions:read and a query
 * made too early all return a list without them. Keep this in step with lint.yml.
 */
export const REQUIRED_RUNS = ['ESLint'];

/**
 * Workflows that run AFTER a deploy, about that deploy, and never gate one. auto-deploy.yml
 * dispatches the live client-signature check once the fleet is rolled out, and a dispatched run
 * lands on the branch head of that moment — possibly the next merge. It takes as long as its
 * synthetic approval test takes (18 minutes on 2026-09-22); counted here it would hold that next
 * commit's deploy for the whole of it, the wait the dispatch removed, moved rather than removed.
 * So these are dropped from the listing like the gate's own run; their result is read in the
 * Actions tab, not by this gate. Keep the names in step with the workflows' `name:`.
 */
export const POST_DEPLOY_WORKFLOWS = ['Client signature live check'];

/** A conclusion that does not stop a deploy. `cancelled` is absent on purpose — see the header. */
const PASSING = new Set(['success', 'skipped', 'neutral']);

/**
 * Runs for `sha`, excluding this workflow's own and the post-deploy checks it dispatches.
 *
 * ★ EXCLUDING SELF IS NOT OPTIONAL: this tool runs INSIDE one of the runs it would otherwise wait
 * for, so counting itself deadlocks until the timeout and then reports a failure that is only the
 * gate waiting for the gate.
 */
export async function runsForSha(sha, { repo, token, self, ignore = POST_DEPLOY_WORKFLOWS, fetchFn = fetch }) {
  const url = `${API}/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`;
  const res = await fetchFn(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    // The status rides along so the loop can tell an outage (retried) from a refusal (final).
    throw Object.assign(new Error(`GitHub answered ${res.status} for ${url} — a deploy gate that cannot read `
      + 'the check results must refuse, not assume'), { status: res.status });
  }
  const body = await res.json();
  const all = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  return all
    .filter((r) => r?.name !== self && !ignore.includes(r?.name))
    .map((r) => ({ name: r?.name ?? '(unnamed)', status: r?.status, conclusion: r?.conclusion, ...(typeof r?.html_url === 'string' ? { url: r.html_url } : {}) }));
}

/** Green / not-yet / red, given a snapshot of runs. Pure, so the states are testable. */
export function verdict(runs, minRuns = MIN_RUNS, required = REQUIRED_RUNS) {
  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length > 0) {
    return { state: 'pending', pending: pending.map((r) => r.name), failed: [] };
  }
  const missing = required.filter((name) => !runs.some((r) => r.name === name));
  if (missing.length > 0) {
    return {
      state: 'too-few',
      pending: [],
      failed: [],
      detail: `the listing for this commit has no ${missing.join(', ')} run, which every push to master starts. `
        + 'A list without it is not this commit\'s CI (a mistyped sha, a token without actions:read, or a '
        + 'query made before the runs registered), so it is refused rather than deployed on.',
    };
  }
  if (runs.length < minRuns) {
    return {
      state: 'too-few',
      pending: [],
      failed: [],
      detail: `only ${runs.length} concluded run(s) for this commit, below the floor of ${minRuns}. `
        + 'An empty or short list reads exactly like "nothing failed", so it is refused rather '
        + 'than deployed on.',
    };
  }
  const failed = runs.filter((r) => !PASSING.has(String(r.conclusion)));
  return {
    state: failed.length === 0 ? 'green' : 'red',
    pending: [],
    failed: failed.map((r) => `${r.name}: ${r.conclusion}`),
  };
}

/**
 * What the loop does with a verdict once the clock is known: deploy, refuse, or poll again.
 * Pure, like `verdict`, so the wait-versus-refuse line is testable without a clock. Green deploys
 * whatever the time; red refuses at once; pending and too-few wait until the deadline and are
 * refused there.
 */
export function nextStep(v, expired) {
  if (v.state === 'green') return 'deploy';
  if (v.state === 'red') return 'refuse';
  return expired ? 'refuse' : 'wait';
}

/** A GitHub outage (5xx) is polled again until the deadline; any other answer is final. */
export function retryable(err) {
  return Number(err?.status) >= 500;
}

async function main() {
  const sha = process.argv[2];
  const repo = process.env['GITHUB_REPOSITORY'];
  const token = process.env['GITHUB_TOKEN'];
  const self = process.env['SELF_WORKFLOW'] ?? 'Auto-deploy master';
  const timeoutMs = Number(process.env['CI_GATE_TIMEOUT_MS'] ?? 30 * 60 * 1000);
  const pollMs = Number(process.env['CI_GATE_POLL_MS'] ?? 30_000);

  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    console.error(`usage: node tools/ci-green-for-sha.mjs <40-hex-sha> (got: ${sha ?? '(none)'})`);
    process.exit(2);
  }
  if (!repo || !token) {
    console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are both required — without them this '
      + 'cannot read the check results, and a gate that cannot read them must refuse.');
    process.exit(2);
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const expired = Date.now() > deadline;
    let runs;
    try {
      runs = await runsForSha(sha, { repo, token, self });
    } catch (err) {
      if (retryable(err) && !expired) {
        console.log(`GitHub is not answering (${err.message}); polling again`);
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      console.error(`could not read workflow runs: ${err.message}`);
      process.exit(2);
    }
    const v = verdict(runs);
    const step = nextStep(v, expired);

    if (step === 'deploy') {
      console.log(`✓ ${runs.length} workflow run(s) for ${sha.slice(0, 12)} all concluded successfully`);
      for (const r of runs) console.log(`    ${r.conclusion.padEnd(9)} ${r.name}`);
      process.exit(0);
    }
    if (v.state === 'red') {
      console.error(`\n★ CI IS NOT GREEN FOR ${sha.slice(0, 12)} — NOT DEPLOYING\n`);
      for (const f of v.failed) console.error(`    ${f}`);
      console.error('\n  A built image is not a tested one. Fix the failure and merge again;\n'
        + '  the next push re-runs this gate.\n');
      process.exit(1);
    }
    if (step === 'refuse' && v.state === 'too-few') {
      console.error(`\n★ CI RESULTS FOR ${sha.slice(0, 12)} CANNOT BE TRUSTED — NOT DEPLOYING\n`);
      console.error(`  ${v.detail}\n`);
      console.error(`  The listing stayed short for ${Math.round(timeoutMs / 60000)} minutes, so this is not one`
        + ' eventually-consistent answer: check the sha, and that the token has actions:read.\n');
      process.exit(1);
    }
    if (step === 'refuse') {
      console.error(`\n★ CI DID NOT FINISH within ${Math.round(timeoutMs / 60000)} minutes — NOT DEPLOYING\n`);
      for (const p of v.pending) console.error(`    still running: ${p}`);
      console.error('\n  A deploy that gives up waiting and ships anyway is not gated at all.\n');
      process.exit(1);
    }
    if (v.state === 'too-few') {
      console.log(`${runs.length} run(s) listed for ${sha.slice(0, 12)}, below the floor of ${MIN_RUNS}; `
        + 'the listing is eventually consistent, so polling again');
    } else {
      console.log(`waiting for ${v.pending.length} run(s): ${v.pending.slice(0, 6).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (process.argv[1] && process.argv[1].split('\\').join('/').endsWith('ci-green-for-sha.mjs')) {
  void main();
}
