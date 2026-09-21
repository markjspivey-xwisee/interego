/**
 * The gated auto-merge, as CI runs it.
 *
 *   npx tsx bin/auto-merge.ts --pr <number> --repo <owner/name> --dir <follower results dir> \
 *     --calibration-url <bridge>/jev-harness/calibration --armed true|false --token-present true|false \
 *     --selection-result success|failure|cancelled|skipped [--require-human-review true|false] [--dry-run]
 *
 * Reads the gate's verdict from the follower's saved results (the artifact the review-gate
 * job uploaded), the calibration from the deployed bridge, and the switches the workflow
 * passes; prints every condition and the decision; labels the pull request AUTO_MERGED_LABEL
 * and merges it with `gh pr merge --merge` only when every condition holds and --dry-run is
 * absent (GH_TOKEN must then be the merge token, not the run's own). The label goes on first,
 * because the close-time job reads it the moment the merge closes the pull request, and an
 * automatic merge must never be scored as a person's approval. Exits 0 unless the merge
 * command itself fails: an unarmed or unearned decision is a green job that says so, not a red
 * one. src/auto-merge.ts is the policy.
 */

import { execFileSync } from 'node:child_process';
import { AUTO_MERGED_LABEL, autoMergeDecision, type AutoMergeInputs } from '../src/auto-merge.js';
import { loadSavedResults } from '../src/pr-comment.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readCalibration(url: string): Promise<{ calibration?: AutoMergeInputs['calibration']; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `${res.status} from ${url}` };
    const body = await res.json() as { cells?: unknown };
    if (!Array.isArray(body.cells)) return { error: `no cells in the answer from ${url}` };
    return { calibration: body as AutoMergeInputs['calibration'] };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<void> {
  const pr = flag('--pr');
  const repo = flag('--repo');
  const dir = flag('--dir');
  const calibrationUrl = flag('--calibration-url');
  if (!pr || !repo || !dir || !calibrationUrl) {
    console.error('usage: --pr <n> --repo <owner/name> --dir <results dir> --calibration-url <url> --armed true|false --token-present true|false --selection-result <result> [--require-human-review true|false] [--dry-run]');
    process.exit(2);
  }
  const gate = loadSavedResults(dir).find((r) => r.verb === 'review-gate');
  const verdict = (gate?.body['judgment'] as { verdict?: string } | undefined)?.verdict;
  const read = await readCalibration(calibrationUrl);
  const decision = autoMergeDecision({
    ...(verdict ? { verdict } : {}),
    ...(flag('--selection-result') ? { selectionResult: flag('--selection-result') } : {}),
    armed: flag('--armed') === 'true',
    tokenPresent: flag('--token-present') === 'true',
    requireHumanReview: flag('--require-human-review') === 'true',
    ...(read.calibration ? { calibration: read.calibration } : {}),
    ...(read.error ? { calibrationError: read.error } : {}),
  });
  console.log(`gated auto-merge for ${repo}#${pr}: ${decision.merge ? 'MERGE' : 'no merge'}`);
  for (const r of decision.reasons) console.log(`  ${r}`);
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
  execFileSync('gh', ['pr', 'merge', pr, '--repo', repo, '--merge'], { stdio: 'inherit' });
  console.log(`  merged, labelled ${AUTO_MERGED_LABEL}`);
}

main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
