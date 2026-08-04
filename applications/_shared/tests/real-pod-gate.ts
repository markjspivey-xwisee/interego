/**
 * The precondition every real-pod suite passes through before it is allowed to skip.
 *
 * ★ WHAT THIS ADDS TO `pod-target.ts`, AND WHY IT IS A SEPARATE FILE RATHER THAN A COPY.
 * `pod-target.ts` already fixed the WORST half of this: the five suites no longer default to
 * `interego-css-gate.livelysky-8b81abb0...`, a host deliberately destroyed in the Railway
 * move, and a skip now states its cause instead of blaming a dead end. Everything about WHERE
 * to write and WHAT credential to carry still lives there and is imported here — a second
 * copy of that decision is exactly the drift that let one dead hostname sit in five files.
 *
 * What it did NOT fix is that `probePod()` still collapses two different kinds of "no" into
 * one `{ usable: false }`:
 *
 *   DECLARED  — SKIP_POD_TESTS=1, or no INTEREGO_POD_WRITE_SECRET configured. A human said
 *               "not here". Skipping is the correct answer.
 *   DISCOVERED — the pod is unreachable, or the container answers 404, or the gate refuses
 *               the write. Nobody chose this. The evidence has stopped existing.
 *
 * Both routed to `ctx.skip()`, which is green, and the tests guarding that decision could not
 * fail for any value it can take: `expect(typeof reachable).toBe('boolean')` is true of
 * `false` (agent-development-practice, lrs-adapter), and `expect(skipReason).not.toBe('')` is
 * true of every string `probePod()` is capable of returning, since every one of its four
 * return paths sets a non-empty reason (tier2, agent-collective,
 * learner-performer-companion). So the suite that is supposed to notice the pod went away
 * asserted only that a string it always builds is a string it always builds.
 *
 * ★ THE RULE THIS ENFORCES: a real-pod suite may skip ONLY for a reason the operator
 * DECLARED. Every reason DISCOVERED at runtime is a FAILURE, because those are exactly the
 * states in which the round-trip evidence — the only real-HTTP publish/fetch/parse assertions
 * in this repo — has silently stopped existing. `openRealPod()` therefore THROWS on a
 * discovered failure, and a throw in `beforeAll` reds the whole file rather than emptying it.
 *
 * Not collected by vitest (its include is `*.test.ts`); compiled by the typecheck gate, whose
 * tsconfig.check.json includes `applications/**\/tests/**\/*.ts`.
 */

import { POD_HOST, TEST_POD_BASE, podWriteHeaders, probePod } from './pod-target.js';

/** Re-exported so a suite needs one import, not two, to state where it was pointed. */
export { POD_HOST, TEST_POD_BASE, podFetch, podWriteHeaders } from './pod-target.js';

/**
 * The ONLY two reasons a real-pod suite may skip. Both are operator declarations; neither can
 * be produced by the pod behaving badly.
 */
export type DeclaredSkip =
  | 'SKIP_POD_TESTS/SKIP_AZURE_TESTS=1'
  | 'INTEREGO_POD_WRITE_SECRET unset';

export const DECLARED_SKIPS: readonly DeclaredSkip[] = [
  'SKIP_POD_TESTS/SKIP_AZURE_TESTS=1',
  'INTEREGO_POD_WRITE_SECRET unset',
];

export type PodGate =
  | { readonly ok: true }
  | { readonly ok: false; readonly declaredSkip: DeclaredSkip };

/**
 * Did a human opt out?
 *
 * The credential half is detected through `podWriteHeaders()` rather than by re-reading
 * `INTEREGO_POD_WRITE_SECRET` here. `pod-target.ts` accepts that name OR
 * `FOXXI_POD_WRITE_SECRET`; re-reading only the first would make this gate declare "unset"
 * while the suite below it wrote successfully with the second — two files disagreeing about
 * what is configured, which is the class of defect this whole area was built out of.
 */
function declaredSkip(): DeclaredSkip | null {
  if (process.env['SKIP_AZURE_TESTS'] === '1' || process.env['SKIP_POD_TESTS'] === '1') {
    return 'SKIP_POD_TESTS/SKIP_AZURE_TESTS=1';
  }
  if (!('Authorization' in podWriteHeaders())) return 'INTEREGO_POD_WRITE_SECRET unset';
  return null;
}

/**
 * Call from `beforeAll`. Returns a DECLARED skip, or throws.
 *
 * The throw is the whole point and is not defensive coding: with a credential configured, an
 * unreachable host / missing container / refused write means the operator INTENDED to produce
 * round-trip evidence and did not. That is the state the previous `{ usable: false }` turned
 * into a green tick for the entire Azure-to-Railway migration.
 */
export async function openRealPod(): Promise<PodGate> {
  const declared = declaredSkip();
  if (declared !== null) return { ok: false, declaredSkip: declared };

  const availability = await probePod();
  if (!availability.usable) {
    throw new Error(
      `real pod ${TEST_POD_BASE} is configured but not usable: ${availability.reason}. `
      + 'Refusing to skip. A write credential is set, so somebody meant these round-trips to '
      + 'run, and they are the only real-HTTP publish/fetch/parse assertions in this repo. '
      + 'Point INTEREGO_POD_BASE/INTEREGO_TEST_POD at a live container, or declare the skip '
      + 'with SKIP_POD_TESTS=1.',
    );
  }
  return { ok: true };
}
