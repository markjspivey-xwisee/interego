/**
 * Gated auto-merge: the policy that lets a pull request merge without a person, and what it
 * takes to earn that.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────────────────────
 *
 * A merge to master rolls the fleet, so it is taken by a machine only when the conditions
 * below hold at once, each printed as a reason whether it held or not:
 *
 *   1. the operator armed it: the repository variable JEV_AUTO_MERGE is `true`
 *   2. a token that triggers auto-deploy is present: the secret JEV_MERGE_TOKEN. A merge made
 *      with the run's own GITHUB_TOKEN starts no workflows (GitHub's rule against recursive
 *      runs), so it would land the commit and ship nothing — the one state the deploy path was
 *      built to make impossible.
 *   3. the selection ran green: the tests the change warranted passed
 *   4. the gate found no secret: a `block` verdict never merges
 *
 * and, only when the operator requires a person (repository variable JEV_REQUIRE_HUMAN_REVIEW
 * is `true`):
 *
 *   5. the verdict is auto-ok: the gate itself asked for no person
 *   6. the verdict has earned it: the calibration the bridge publishes from the pod shows the
 *      review verdict agreeing with people at least MIN_AGREEMENT of the time over at least
 *      MIN_LIVE_SAMPLES live outcomes, disagreeing (auto-ok where a person then asked for
 *      changes or blocked) at most MAX_DISAGREEMENT. Replayed history does not count.
 *   7. the attestation says so too: the reputation the bridge serves (every attestation about
 *      the agent on the pod, aggregated by the registry under the harness policy) rates
 *      accuracy at least MIN_AGREEMENT with at least one contributing attestation. This is the
 *      published evidence being consumed, not recomputed.
 *
 * and, in both modes, last:
 *
 *   8. GitHub reports the pull request mergeable. A branch that conflicts with master merges for
 *      nobody, and bin/auto-merge.ts labels BEFORE it merges (so the close-time job never scores
 *      an automatic merge as a person's), so a merge command that then failed would leave the
 *      label on a pull request a person merges next — which is what #436 did on 2026-09-21 when
 *      the Foxxi merge landed a changelog conflict under it. Mergeability is read at decision
 *      time; UNKNOWN (GitHub still computing) is refused like a conflict, and the next push
 *      decides again.
 *   9. The run tested the branch against master's CURRENT head. A pull_request run builds its
 *      merge ref from the base as it was when the run started; if master moved since, what
 *      passed is not what would land. Rather than test master again after the merge (which
 *      held every deploy for ten to twenty minutes on 2026-09-21), the decision refuses and
 *      bin/auto-merge.ts updates the branch, so the next run tests exactly what merges. With
 *      this, the workflows that test on master pushes are redundant and run on pull requests
 *      only.
 *
 * The operator turned the person off on 2026-09-21 ("i dont need human review"), so by default
 * needs-human-review is advisory: the gate still judges every diff and records its verdict,
 * and calibration keeps scoring it, but nothing waits. An automatic merge is labelled
 * AUTO_MERGED_LABEL so the close-time job never scores it as a person's approval.
 *
 * Unarmed, the CI job prints the decision it would have taken and exits green. This module is
 * the pure decision; bin/auto-merge.ts reads the inputs and, when the decision is merge, runs
 * the merge.
 */

export const AUTO_MERGE_POLICY = {
  /** Live review-verdict outcomes (a person decided) before an auto-ok may merge in place of a person. */
  minLiveSamples: 20,
  /** Share of those where the verdict agreed with the person. */
  minAgreement: 0.9,
  /** Share where auto-ok met changes-requested or blocked: the costly miss. */
  maxDisagreement: 0.05,
} as const;

/** The label an automatic merge carries, so the close-time job records no human decision for it. */
export const AUTO_MERGED_LABEL = 'jev-harness:auto-merged';

export type AutoMergePolicy = { readonly minLiveSamples: number; readonly minAgreement: number; readonly maxDisagreement: number };

export interface CalibrationCellLike {
  readonly kind: string;
  readonly liveSamples?: number;
  readonly liveAgreement?: Readonly<Record<string, number>>;
}

export interface AutoMergeInputs {
  /** The gate's verdict for this pull request, from its saved result. */
  readonly verdict?: string;
  /** The select-and-run job's result: success, failure, cancelled, skipped. */
  readonly selectionResult?: string;
  readonly armed: boolean;
  readonly tokenPresent: boolean;
  /** Whether the operator requires a person (JEV_REQUIRE_HUMAN_REVIEW is true). Default: no. */
  readonly requireHumanReview?: boolean;
  /** The calibration view (GET /jev-harness/calibration of the deployed bridge), when it could be read. */
  readonly calibration?: { readonly cells: readonly CalibrationCellLike[] };
  /** Why the calibration could not be read, when it could not. */
  readonly calibrationError?: string;
  /** The reputation snapshot (GET /jev-harness/reputation): per-axis ratings and how many attestations contributed. */
  readonly reputation?: { readonly axes: Readonly<Record<string, number>>; readonly contributing: number };
  readonly reputationError?: string;
  /** GitHub's mergeability of the pull request at decision time: MERGEABLE, CONFLICTING or UNKNOWN. */
  readonly mergeable?: string;
  /** The base sha this run's merge ref was built from, and master's head at decision time. */
  readonly base?: { readonly tested: string; readonly current: string };
}

export interface AutoMergeEvidence {
  readonly liveSamples: number;
  readonly agreeRate: number | null;
  readonly disagreeRate: number | null;
}

export interface AutoMergeDecision {
  readonly merge: boolean;
  /** One line per condition, held or not, in the order they are checked. */
  readonly reasons: readonly string[];
  readonly evidence: AutoMergeEvidence;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** What the review-verdict cell says about live agreement. */
export function reviewVerdictEvidence(calibration: AutoMergeInputs['calibration']): AutoMergeEvidence {
  const cell = calibration?.cells.find((c) => c.kind === 'review-verdict');
  const live = cell?.liveSamples ?? 0;
  const agreement = cell?.liveAgreement ?? {};
  const decided = Object.values(agreement).reduce((a, b) => a + b, 0);
  if (decided === 0) return { liveSamples: live, agreeRate: null, disagreeRate: null };
  return { liveSamples: live, agreeRate: round((agreement['agree'] ?? 0) / decided), disagreeRate: round((agreement['disagree'] ?? 0) / decided) };
}

export function autoMergeDecision(input: AutoMergeInputs, policy: AutoMergePolicy = AUTO_MERGE_POLICY): AutoMergeDecision {
  const reasons: string[] = [];
  const holds: boolean[] = [];
  const check = (ok: boolean, reason: string): void => { holds.push(ok); reasons.push(`${ok ? 'holds' : 'fails'}: ${reason}`); };

  check(input.armed, input.armed ? 'the operator armed auto-merge (JEV_AUTO_MERGE is true)' : 'auto-merge is not armed (set the repository variable JEV_AUTO_MERGE to true)');
  check(input.tokenPresent, input.tokenPresent ? 'a merge token that triggers auto-deploy is present (JEV_MERGE_TOKEN)' : 'no merge token: a merge with GITHUB_TOKEN would start no workflows and ship nothing (set the secret JEV_MERGE_TOKEN to a token with contents and pull-requests write)');
  check(input.selectionResult === 'success', `the selected tests ${input.selectionResult === 'success' ? 'passed' : `did not pass (job result: ${input.selectionResult ?? 'unknown'})`}`);

  const evidence = reviewVerdictEvidence(input.calibration);
  if (input.verdict === 'block') {
    check(false, 'the gate found a secret in the diff (block): nothing merges until it is removed');
  } else if (input.verdict === undefined) {
    check(false, 'the gate left no verdict to read');
  } else if (!input.requireHumanReview) {
    check(true, `the gate found no secret (verdict ${input.verdict}); no person is required (JEV_REQUIRE_HUMAN_REVIEW is not true), so needs-human-review is advisory`);
  } else {
    check(input.verdict === 'auto-ok', input.verdict === 'auto-ok' ? 'the gate asked for no person (auto-ok)' : `the gate's verdict is ${input.verdict}, and a person is required (JEV_REQUIRE_HUMAN_REVIEW is true)`);
    if (!input.calibration) {
      check(false, `the calibration could not be read${input.calibrationError ? ` (${input.calibrationError})` : ''}, so the verdict has not shown it has earned this`);
    } else if (evidence.liveSamples < policy.minLiveSamples) {
      check(false, `the review verdict has ${evidence.liveSamples} live outcome(s), below the floor of ${policy.minLiveSamples}`);
    } else if (evidence.agreeRate === null) {
      check(false, 'no live review-verdict outcome carries a human decision yet');
    } else {
      const earned = evidence.agreeRate >= policy.minAgreement && (evidence.disagreeRate ?? 0) <= policy.maxDisagreement;
      check(earned, `${evidence.liveSamples} live review-verdict outcome(s): agreement ${evidence.agreeRate} (floor ${policy.minAgreement}), disagreement ${evidence.disagreeRate} (ceiling ${policy.maxDisagreement})`);
    }
    if (!input.reputation) {
      check(false, `no attestation-based reputation could be read${input.reputationError ? ` (${input.reputationError})` : ''}, so no published evidence vouches for the verdict`);
    } else {
      const accuracy = input.reputation.axes['accuracy'];
      const vouched = input.reputation.contributing > 0 && accuracy !== undefined && accuracy >= policy.minAgreement;
      check(vouched, accuracy === undefined
        ? `the ${input.reputation.contributing} attestation(s) on the pod rate no accuracy axis`
        : `the reputation from ${input.reputation.contributing} attestation(s) rates accuracy ${accuracy} (floor ${policy.minAgreement})`);
    }
  }

  const mergeable = input.mergeable ?? 'UNKNOWN';
  check(mergeable === 'MERGEABLE', mergeable === 'MERGEABLE'
    ? 'GitHub reports the pull request mergeable'
    : mergeable === 'CONFLICTING'
      ? 'the pull request conflicts with master (merge master in and push; the next run decides again)'
      : `GitHub has not settled whether the pull request is mergeable (mergeable: ${mergeable}); the next run decides again`);

  if (!input.base) {
    check(false, 'the base sha this run tested was not given (--base-sha), so whether master moved since is unknown');
  } else if (input.base.tested === input.base.current) {
    check(true, `the run tested the branch against master's current head (${input.base.current.slice(0, 8)})`);
  } else {
    check(false, `master moved from ${input.base.tested.slice(0, 8)} to ${input.base.current.slice(0, 8)} since this run's merge ref was built; the branch is updated and the next run decides again`);
  }

  return { merge: holds.every(Boolean), reasons, evidence };
}
