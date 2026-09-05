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
import { verdict, runsForSha, MIN_RUNS } from '../tools/ci-green-for-sha.mjs';

const done = (name: string, conclusion: string) => ({ name, status: 'completed', conclusion });
/** Enough concluded runs to clear the floor, so a leg tests what it says it tests. */
const filler = (n: number) => Array.from({ length: n }, (_, i) => done(`filler-${i}`, 'success'));

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

  it('★ refuses when GitHub does not answer, rather than reporting an empty list', async () => {
    await expect(runsForSha('a'.repeat(40), {
      repo: 'o/r', token: 't', self: 'x',
      fetchFn: async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response,
    })).rejects.toThrow(/403/);
  });
});
