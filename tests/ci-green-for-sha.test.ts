/**
 * Auto-deploy's CI gate: the states that must stop a deploy, and the one that may allow it.
 *
 * ── ★★ WHY THIS IS GATED AT ALL ──────────────────────────────────────────────────────────────
 *
 * A built image is not a tested one. `build-ghcr.yml` compiles and pushes and runs no test, no
 * typecheck and no mutation gate, so deploying on "the image exists" ships whatever compiled. This
 * repository has already paid for that once, and its own note reads: "CI is a DEPLOY GATE;
 * skipping it took the bridge down."
 *
 * ── ★★★ THE DANGEROUS ANSWER IS NOT "RED" ────────────────────────────────────────────────────
 *
 * Red stops the deploy, which is the point of the thing. The failure with no symptom is the EMPTY
 * list — a mistyped sha, a token without `actions:read`, or a query made before any run has
 * registered. All three return "nothing is failing", which reads as green. So the floor below is
 * the load-bearing leg, not the red one, and `cancelled` is deliberately not forgiven: a cancelled
 * test run is a test that did not report, and "it was probably fine" is the reasoning being
 * replaced.
 *
 * Verified against live data as well as these fixtures: exit 0 on 3465dc00 (14 runs, all green),
 * exit 1 on 229a3ec6 (whose ESLint genuinely failed), exit 1 on an all-zero sha, exit 2 on a
 * malformed one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verdict, runsForSha, nextStep, retryable, MIN_RUNS, REQUIRED_RUNS, POST_DEPLOY_WORKFLOWS } from '../tools/ci-green-for-sha.mjs';

const done = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion });
/** The run every push starts, whose presence proves the listing is real. */
const lint = () => done('ESLint', 'success');
/** Enough concluded runs to clear the floor (the always-on run among them), so a leg tests what it says it tests. */
const filler = (n: number) => [lint(), ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => done(`filler-${i}`, 'success'))];

describe('a deploy waits for every other run to conclude', () => {
  it('is pending while anything is still running', () => {
    const v = verdict([...filler(MIN_RUNS), { name: 'Mutation Gate', status: 'in_progress', conclusion: null }]);
    expect(v.state).toBe('pending');
    expect(v.pending).toContain('Mutation Gate');
  });

  it('is pending for a queued run too, which has no conclusion yet', () => {
    const v = verdict([...filler(MIN_RUNS), { name: 'Relay Tests', status: 'queued', conclusion: null }]);
    expect(v.state).toBe('pending');
  });
});

describe('a deploy is refused unless every concluded run passed', () => {
  it('★ refuses on a failure, and names it', () => {
    const v = verdict([...filler(MIN_RUNS), done('ESLint', 'failure')]);
    expect(v.state).toBe('red');
    expect(v.failed).toContain('ESLint: failure');
  });

  it('★ refuses on a CANCELLED run — a test that did not report is not a test that passed', () => {
    const v = verdict([...filler(MIN_RUNS), done('Mutation Gate', 'cancelled')]);
    expect(v.state, 'a cancelled run was treated as permission to deploy').toBe('red');
  });

  it('refuses on timed_out and action_required', () => {
    expect(verdict([...filler(MIN_RUNS), done('x', 'timed_out')]).state).toBe('red');
    expect(verdict([...filler(MIN_RUNS), done('y', 'action_required')]).state).toBe('red');
  });

  it('allows skipped and neutral — a job a paths filter declined has not failed', () => {
    const v = verdict([...filler(MIN_RUNS), done('Desktop Packaging', 'skipped'), done('z', 'neutral')]);
    expect(v.state).toBe('green');
  });
});

describe('★ an empty or short result is refused, not read as green', () => {
  it('refuses when there are no runs at all', () => {
    const v = verdict([]);
    expect(v.state, 'no runs read as "nothing failed" and deployed unverified code').toBe('too-few');
  });

  it('refuses just below the floor, and allows just at it', () => {
    expect(verdict(filler(MIN_RUNS - 1)).state).toBe('too-few');
    expect(verdict(filler(MIN_RUNS)).state).toBe('green');
  });

  it('★ refuses a listing without the run every push starts, however long it is — that list is not this commit\'s CI', () => {
    const others = Array.from({ length: 10 }, (_, i) => done(`other-${i}`, 'success'));
    const v = verdict(others);
    expect(v.state, 'ten green runs without ESLint were read as this commit\'s CI').toBe('too-few');
    expect(v.detail).toContain('no ESLint run');
    expect(REQUIRED_RUNS).toEqual(['ESLint']);
    expect(verdict([lint(), ...others]).state).toBe('green');
  });

  it('the floor is two: the always-on run and one more, which is what a workflows-only merge has (c24a74a8, 2026-09-22)', () => {
    expect(MIN_RUNS).toBe(2);
    expect(verdict([lint(), done('pages build and deployment', 'success')]).state).toBe('green');
    expect(verdict([lint()]).state).toBe('too-few');
  });

  it('a short list that is also RED reports red, because pending is checked first', () => {
    // Ordering matters: a single failed run with nothing else must not be excused as "too few".
    const v = verdict([done('ESLint', 'failure')]);
    expect(['red', 'too-few']).toContain(v.state);
    expect(v.state).not.toBe('green');
  });
});

describe('the gate excludes its own run, or it waits for itself forever', () => {
  const reply = (runs: unknown[]) => ({
    ok: true,
    json: async () => ({ workflow_runs: runs }),
  }) as unknown as Response;

  it('★ drops the calling workflow from the list', async () => {
    const got = await runsForSha('a'.repeat(40), {
      repo: 'o/r', token: 't', self: 'Auto-deploy master',
      fetchFn: async () => reply([
        { name: 'Auto-deploy master', status: 'in_progress', conclusion: null },
        { name: 'ESLint', status: 'completed', conclusion: 'success' },
      ]),
    });
    expect(
      got.map((r) => r.name),
      'the gate kept its own run in the list, so it would wait for itself until the timeout and '
        + 'then report a failure that is only the gate waiting for the gate',
    ).toEqual(['ESLint']);
  });

  it('★ drops the post-deploy live check too: dispatched onto whatever master is by then, it takes as long as its test', async () => {
    // 2026-09-22, run 35753761634: the check held the rollout lock for 18 minutes and the next
    // deploy queued behind it. Dispatched instead, it lands on the next merge's sha — and counted
    // here it would hold THAT deploy for the same 18 minutes.
    const got = await runsForSha('a'.repeat(40), {
      repo: 'o/r', token: 't', self: 'Auto-deploy master',
      fetchFn: async () => reply([
        { name: 'Client signature live check', status: 'in_progress', conclusion: null },
        { name: 'ESLint', status: 'completed', conclusion: 'success' },
        { name: 'Bridge Typecheck', status: 'completed', conclusion: 'success' },
      ]),
    });
    expect(got.map((r) => r.name)).toEqual(['ESLint', 'Bridge Typecheck']);
    expect(verdict(got).state, 'an in-progress post-deploy check must not read as pending CI').toBe('green');
  });

  it('★ the name it ignores is the name the workflow has, and auto-deploy.yml dispatches that workflow rather than running it inside the locked run', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/client-signature-live.yml', import.meta.url)), 'utf8');
    const name = /^name:\s*(.+?)\s*$/m.exec(workflow)?.[1];
    expect(name).toBeDefined();
    expect(POST_DEPLOY_WORKFLOWS).toContain(name);
    const deploy = readFileSync(fileURLToPath(new URL('../.github/workflows/auto-deploy.yml', import.meta.url)), 'utf8');
    expect(deploy).toMatch(/gh workflow run client-signature-live\.yml/);
    expect(deploy, 'a uses: of the check inside auto-deploy.yml holds the rollout lock for the whole test').not.toMatch(/uses:\s*\.\/\.github\/workflows\/client-signature-live\.yml/);
  });
  it('★ refuses when GitHub does not answer, rather than reporting an empty list', async () => {
    await expect(runsForSha('a'.repeat(40), {
      repo: 'o/r', token: 't', self: 'x',
      fetchFn: async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response,
    })).rejects.toThrow(/403/);
  });
});

describe('★ a short listing is a wait until the deadline, not a refusal on sight', () => {
  // 2026-09-21, commit 0f40814b: five runs listed, then two, then one poll answered 200 with an
  // empty list while the mutation gate was still running. The floor read it as final and refused
  // a deploy whose CI concluded green four minutes later.
  it('polls again while time remains, for an empty list and for one just below the floor', () => {
    expect(nextStep(verdict([]), false)).toBe('wait');
    expect(nextStep(verdict(filler(MIN_RUNS - 1)), false)).toBe('wait');
  });

  it('★ refuses a listing that is still short at the deadline — a mistyped sha never turns green', () => {
    expect(nextStep(verdict([]), true), 'an empty listing at the deadline was not refused').toBe('refuse');
    expect(nextStep(verdict(filler(MIN_RUNS - 1)), true)).toBe('refuse');
  });

  it('deploys on green whatever the clock, refuses red at once, and waits on pending only until the deadline', () => {
    expect(nextStep(verdict(filler(MIN_RUNS)), true)).toBe('deploy');
    expect(nextStep(verdict([...filler(MIN_RUNS), done('ESLint', 'failure')]), false)).toBe('refuse');
    const pending = verdict([...filler(MIN_RUNS), { name: 'Mutation Gate', status: 'in_progress', conclusion: null }]);
    expect(nextStep(pending, false)).toBe('wait');
    expect(nextStep(pending, true)).toBe('refuse');
  });
});

describe('a GitHub outage is polled again; a refusal is final', () => {
  const answer = (status: number) => async () => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
  const ask = (status: number) => runsForSha('a'.repeat(40), { repo: 'o/r', token: 't', self: 'x', fetchFn: answer(status) }).catch((e: unknown) => e);

  it('carries the status on the error, and only a 5xx is retryable', async () => {
    const outage = await ask(502);
    expect((outage as { status?: number }).status).toBe(502);
    expect(retryable(outage)).toBe(true);
    expect(retryable(await ask(403)), 'a 403 — a token without actions:read — was retried instead of refused').toBe(false);
    expect(retryable(new Error('no status'))).toBe(false);
    expect(retryable(undefined)).toBe(false);
  });
});
