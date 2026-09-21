/**
 * The gated auto-merge, as CI runs it.
 *
 *   npx tsx bin/auto-merge.ts --pr <number> --repo <owner/name> --dir <follower results dir> \
 *     --calibration-url <bridge>/jev-harness/calibration --reputation-url <bridge>/jev-harness/reputation \
 *     --armed true|false --token-present true|false --selection-result success|failure|cancelled|skipped \
 *     [--require-human-review true|false] [--dry-run]
 *
 * Reads the gate's verdict from the follower's saved results (the artifact the review-gate
 * job uploaded), the calibration and the attestation-based reputation from the deployed
 * bridge, the pull request's mergeability from GitHub, and the switches the workflow passes; prints every condition and the decision;
 * labels the pull request AUTO_MERGED_LABEL and merges it with `gh pr merge --merge` only when
 * every condition holds and --dry-run is absent (GH_TOKEN must then be the merge token, not
 * the run's own). The label goes on first, because the close-time job reads it the moment the
 * merge closes the pull request, and an automatic merge must never be scored as a person's
 * approval. Exits 0 unless the merge command itself fails: an unarmed or unearned decision is
 * a green job that says so, not a red one — and a conflicting branch is one of those, read
 * before the label goes on. If the merge command still fails, the label is taken back first, so
 * the merge that follows, a person's, is scored as one. src/auto-merge.ts is the policy.
 */

import { execFileSync } from 'node:child_process';
import { AUTO_MERGED_LABEL, autoMergeDecision, type AutoMergeInputs } from '../src/auto-merge.js';
import { loadSavedResults } from '../src/pr-comment.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readJson(url: string): Promise<{ body?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `${res.status} from ${url}` };
    return { body: await res.json() as Record<string, unknown> };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GitHub's mergeability for the pull request. Computed asynchronously after a push, so an UNKNOWN
 * is asked again a few times before it is handed to the decision as what it is.
 */
async function readMergeable(pr: string, repo: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let answer: string | undefined;
    try {
      answer = execFileSync('gh', ['pr', 'view', pr, '--repo', repo, '--json', 'mergeable', '--jq', '.mergeable'], { encoding: 'utf8' }).trim() || undefined;
    } catch {
      return undefined;
    }
    if (answer !== 'UNKNOWN') return answer;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return 'UNKNOWN';
}

async function main(): Promise<void> {
  const pr = flag('--pr');
  const repo = flag('--repo');
  const dir = flag('--dir');
  const calibrationUrl = flag('--calibration-url');
  const reputationUrl = flag('--reputation-url');
  if (!pr || !repo || !dir || !calibrationUrl) {
    console.error('usage: --pr <n> --repo <owner/name> --dir <results dir> --calibration-url <url> [--reputation-url <url>] --armed true|false --token-present true|false --selection-result <result> [--require-human-review true|false] [--dry-run]');
    process.exit(2);
  }
  const gate = loadSavedResults(dir).find((r) => r.verb === 'review-gate');
  const verdict = (gate?.body['judgment'] as { verdict?: string } | undefined)?.verdict;
  const calibration = await readJson(calibrationUrl);
  const cells = Array.isArray(calibration.body?.['cells']) ? calibration.body as AutoMergeInputs['calibration'] : undefined;
  const reputation = reputationUrl ? await readJson(reputationUrl) : { error: 'no --reputation-url was given' };
  const snapshot = reputation.body?.['snapshot'] as { axes?: Record<string, number>; contributingAttestations?: unknown[] } | null | undefined;
  const mergeable = process.argv.includes('--dry-run') ? 'MERGEABLE' : await readMergeable(pr, repo);
  const decision = autoMergeDecision({
    ...(verdict ? { verdict } : {}),
    ...(flag('--selection-result') ? { selectionResult: flag('--selection-result') } : {}),
    armed: flag('--armed') === 'true',
    tokenPresent: flag('--token-present') === 'true',
    requireHumanReview: flag('--require-human-review') === 'true',
    ...(cells ? { calibration: cells } : {}),
    ...(!cells ? { calibrationError: calibration.error ?? `no cells in the answer from ${calibrationUrl}` } : {}),
    ...(snapshot ? { reputation: { axes: snapshot.axes ?? {}, contributing: Array.isArray(snapshot.contributingAttestations) ? snapshot.contributingAttestations.length : 0 } } : {}),
    ...(!snapshot ? { reputationError: reputation.error ?? 'the bridge holds no reputation snapshot yet' } : {}),
    ...(mergeable ? { mergeable } : {}),
  });
  console.log([`gated auto-merge for ${repo}#${pr}: ${decision.merge ? 'MERGE' : 'no merge'}`, ...decision.reasons.map((r) => `  ${r}`)].join('\n'));
  if (!decision.merge) return;
  if (process.argv.includes('--dry-run')) { console.log('  dry run: the label and the merge command were not run'); return; }
  try {
    execFileSync('gh', ['pr', 'edit', pr, '--repo', repo, '--add-label', AUTO_MERGED_LABEL], { stdio: 'inherit' });
  } catch (err) {
    // Without the label the close-time job would score this merge as a person's approval, so
    // the merge is refused rather than recorded wrongly.
    console.error(`  the label ${AUTO_MERGED_LABEL} could not be added, so the merge was not made: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  try {
    execFileSync('gh', ['pr', 'merge', pr, '--repo', repo, '--merge'], { stdio: 'inherit' });
  } catch (err) {
    // The label went on for a merge that did not happen. Take it back, so the merge that follows
    // — a person's, or the next run's — is scored as what it is.
    let undone = `so the label ${AUTO_MERGED_LABEL} was taken back`;
    try {
      execFileSync('gh', ['pr', 'edit', pr, '--repo', repo, '--remove-label', AUTO_MERGED_LABEL], { stdio: 'inherit' });
    } catch (undo) {
      undone = `and the label ${AUTO_MERGED_LABEL} could not be taken back either (${undo instanceof Error ? undo.message : String(undo)})`;
    }
    console.error(`  the merge command failed, ${undone}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`  merged, labelled ${AUTO_MERGED_LABEL}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
