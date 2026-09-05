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
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node tools/ci-green-for-sha.mjs <40-hex-sha>
 *
 * Exit 0 = every other workflow concluded successfully. 1 = something failed or never finished.
 * 2 = this tool could not find out, which is never treated as green.
 */

const API = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';

/** How many concluded runs must exist before "nothing failed" is allowed to mean anything. */
export const MIN_RUNS = 4;

/** A conclusion that does not stop a deploy. `cancelled` is absent on purpose — see the header. */
const PASSING = new Set(['success', 'skipped', 'neutral']);

/**
 * Runs for `sha`, excluding this workflow's own.
 *
 * ★ EXCLUDING SELF IS NOT OPTIONAL: this tool runs INSIDE one of the runs it would otherwise wait
 * for, so counting itself deadlocks until the timeout and then reports a failure that is only the
 * gate waiting for the gate.
 */
export async function runsForSha(sha, { repo, token, self, fetchFn = fetch }) {
  const url = `${API}/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`;
  const res = await fetchFn(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub answered ${res.status} for ${url} — a deploy gate that cannot read `
      + 'the check results must refuse, not assume');
  }
  const body = await res.json();
  const all = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  return all
    .filter((r) => r?.name !== self)
    .map((r) => ({ name: r?.name ?? '(unnamed)', status: r?.status, conclusion: r?.conclusion }));
}

/** Green / not-yet / red, given a snapshot of runs. Pure, so the states are testable. */
export function verdict(runs, minRuns = MIN_RUNS) {
  const pending = runs.filter((r) => r.status !== 'completed');
  if (pending.length > 0) {
    return { state: 'pending', pending: pending.map((r) => r.name), failed: [] };
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
    let runs;
    try {
      runs = await runsForSha(sha, { repo, token, self });
    } catch (err) {
      console.error(`could not read workflow runs: ${err.message}`);
      process.exit(2);
    }
    const v = verdict(runs);

    if (v.state === 'green') {
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
    if (v.state === 'too-few') {
      console.error(`\n★ CI RESULTS FOR ${sha.slice(0, 12)} CANNOT BE TRUSTED — NOT DEPLOYING\n`);
      console.error(`  ${v.detail}\n`);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.error(`\n★ CI DID NOT FINISH within ${Math.round(timeoutMs / 60000)} minutes — NOT DEPLOYING\n`);
      for (const p of v.pending) console.error(`    still running: ${p}`);
      console.error('\n  A deploy that gives up waiting and ships anyway is not gated at all.\n');
      process.exit(1);
    }
    console.log(`waiting for ${v.pending.length} run(s): ${v.pending.slice(0, 6).join(', ')}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (process.argv[1] && process.argv[1].split('\\').join('/').endsWith('ci-green-for-sha.mjs')) {
  void main();
}
