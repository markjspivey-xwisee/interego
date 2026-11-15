/**
 * The diff a selection and a gate read, when the job's checkout comes after the merge.
 *
 * On 2026-11-14 three pull requests (#899, #901, #905) merged before their judge job reached its
 * checkout. The job compared `origin/master...HEAD`; master by then held the pull request, the
 * three-dot diff was empty, the selection fell back to the whole suite and the gate answered 400
 * with no verdict recorded. The fixture below is that history, in a repository about a ledger:
 *
 *   A ── B ────────────── M          master: M merges the pull request (refs/remotes/origin/master)
 *    \    \              /
 *     \    ├──── P ─────┤            P: what the late job checks out (GitHub's merge ref, H into B)
 *      \   │    /       │
 *       H1 ┴── H ───────┘            the branch: H1 the change, H the branch with master merged in
 *
 * The event's own SHAs, B and H, still name the change after M exists. A moving base does not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness } from '../src/service.js';
import { changedFiles, describeDiffRange, diffRange, unifiedDiff } from '../src/repo.js';
import { HarnessStore } from '../src/store.js';
import { scripted } from './helpers.js';

let scratch: string;
let root: string;
/** The pull request event's base.sha and head.sha, and the master that later merged it. */
let eventBase: string;
let eventHead: string;
let mergedMaster: string;
let mergeRef: string;

const CHANGED = ['src/ledger.ts', 'src/rounding.ts'];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'jev-diff-range-'));
  root = join(scratch, 'ledger');
  mkdirSync(root);
  const git = (...args: string[]): string => execFileSync('git', [
    '-C', root, '-c', `core.hooksPath=${join(scratch, 'no-hooks')}`, '-c', 'user.name=Jev Test', '-c', 'user.email=jev-test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const commit = (message: string): string => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };

  git('init', '-q', '--initial-branch=master');
  write('src/ledger.ts', '/** Sums the entries of a ledger. */\nexport const total = (entries: number[]): number => entries.reduce((a, b) => a + b, 0);\n');
  write('tests/ledger.test.ts', "// the ledger total\nimport { total } from '../src/ledger.js';\nexport const t = total;\n");
  commit('A: a ledger and its test');

  git('checkout', '-q', '-b', 'round-the-total');
  write('src/rounding.ts', '/** Rounds an amount to cents. */\nexport const toCents = (amount: number): number => Math.round(amount * 100) / 100;\n');
  write('src/ledger.ts', "/** Sums the entries of a ledger. */\nimport { toCents } from './rounding.js';\nexport const total = (entries: number[]): number => toCents(entries.reduce((a, b) => a + b, 0));\n");
  commit('H1: round the total to cents');

  git('checkout', '-q', 'master');
  write('README.md', '# Ledger\n\nA fixture repository.\n');
  eventBase = commit('B: a README, on master while the branch was open');

  // The branch takes master in, as every branch in this repository does before it merges.
  git('checkout', '-q', 'round-the-total');
  git('merge', '-q', '--no-ff', '-m', 'H: merge master into round-the-total', 'master');
  eventHead = git('rev-parse', 'HEAD');

  // GitHub's merge ref for the pull request: the head merged into the base it was opened against.
  git('checkout', '-q', '--detach', eventBase);
  git('merge', '-q', '--no-ff', '-m', `P: merge ${eventHead} into ${eventBase}`, eventHead);
  mergeRef = git('rev-parse', 'HEAD');

  // The pull request merges. Only then does the job fetch: origin/master is M.
  git('checkout', '-q', 'master');
  git('merge', '-q', '--no-ff', '-m', 'M: merge pull request round-the-total', eventHead);
  mergedMaster = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/master', mergedMaster);
  git('checkout', '-q', '--detach', mergeRef);
});

afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const lowRisk = () => scripted({
  'authorization-change': { type: 'noul', noul: 0.05 }, 'validation-weakened': { type: 'noul', noul: 0.05 }, 'assertions-removed': { type: 'noul', noul: 0.05 },
  'new-external-effect': { type: 'noul', noul: 0.05 }, 'behaviour-beyond-description': { type: 'noul', noul: 0.1 },
  description_match: { type: 'score', score: 1.9, legend: {}, probabilities: {}, confidence: 0.9 },
  risk: { type: 'choice', choice: 'low', probabilities: { low: 0.9, medium: 0.08, high: 0.02 }, confidence: 0.9 },
});

describe('a checkout that comes after the pull request merged', () => {
  it('★ reproduces the fault: the moving base contains the head, and its three-dot diff is empty', () => {
    expect(changedFiles(root, 'origin/master', 'HEAD')).toEqual([]);
    expect(unifiedDiff(root, 'origin/master', 'HEAD')).toBe('');
    const range = diffRange(root, 'origin/master', 'HEAD');
    expect(range).toMatchObject({ base: mergedMaster, head: mergeRef, mergeBase: eventHead, nothingToReview: true });
    expect(describeDiffRange(range)).toContain('the diff between them is empty');
  });

  it("★ the event's own base and head SHAs still yield the pull request's diff", () => {
    expect(changedFiles(root, eventBase, eventHead).sort()).toEqual(CHANGED);
    const diff = unifiedDiff(root, eventBase, eventHead);
    expect(diff).toContain('+export const toCents');
    expect(diff).toContain("+import { toCents } from './rounding.js';");
    expect(diff, 'the README is master\'s change, not the pull request\'s').not.toContain('README.md');
    const range = diffRange(root, eventBase, eventHead);
    expect(range).toMatchObject({ base: eventBase, head: eventHead, nothingToReview: false });
    expect(range.mergeBase).not.toBe(eventHead);
    // The line the follower prints in the job log names both commits in full.
    const line = describeDiffRange(range);
    expect(line).toContain(`base ${eventBase}`);
    expect(line).toContain(`head ${eventHead}`);
    expect(line).not.toContain('empty');
  });

  it('★ the gate records a verdict from the event SHAs, and refuses the moving base by naming what it compared', async () => {
    const harness = new Harness({ jev: lowRisk(), repoRoot: root, base: 'http://localhost:1', store: new HarnessStore(scratch) });
    const gated = await harness.reviewGate({ baseRef: eventBase, headRef: eventHead, title: 'Round the total to cents', description: 'total() now rounds its sum to cents with toCents.' });
    expect(gated.judgment.kind).toBe('review-verdict');
    expect([...gated.judgment.changedFiles].sort()).toEqual(CHANGED);

    const refused = harness.reviewGate({ baseRef: 'origin/master', headRef: 'HEAD', title: 'Round the total to cents' });
    await expect(refused).rejects.toMatchObject({ status: 400 });
    await expect(refused).rejects.toThrow(`base ${mergedMaster} (origin/master)`);
    await expect(refused).rejects.toThrow(`head ${mergeRef} (HEAD)`);
  });

  it('★ the selection reads the changed files from the event SHAs, not "no changed files were given"', async () => {
    const harness = new Harness({ jev: scripted({}), repoRoot: root, base: 'http://localhost:1', store: new HarnessStore(scratch) });
    const selected = await harness.selectTests({ changedFiles: [], baseRef: eventBase, headRef: eventHead });
    expect([...selected.judgment.changedFiles].sort()).toEqual(CHANGED);
    expect(selected.judgment.tests.map((t) => t.path)).toContain('tests/ledger.test.ts');
    expect(selected.judgment.reasons.join(' ')).not.toContain('no changed files were given');

    const moving = await harness.selectTests({ changedFiles: [], baseRef: 'origin/master', headRef: 'HEAD' });
    expect(moving.judgment.changedFiles).toEqual([]);
  });

  it('describes a ref that does not resolve, and a working-tree comparison', () => {
    expect(describeDiffRange(diffRange(root, 'origin/no-such-branch', 'HEAD'))).toContain('origin/no-such-branch (does not resolve)');
    const tree = diffRange(root, eventBase);
    expect(tree.nothingToReview).toBe(false);
    expect(describeDiffRange(tree)).toContain(`the working tree at ${mergeRef}`);
  });
});

describe('the judge workflow names the diff by the event', () => {
  const judge = readFileSync(fileURLToPath(new URL('../../../.github/workflows/jev-harness.yml', import.meta.url)), 'utf8');
  it('★ passes the pull request event\'s base and head SHAs to the selection and to the gate, never a moving origin/<base>', () => {
    const follows = judge.split('\n').filter((line) => line.includes('--arg base_ref='));
    expect(follows).toHaveLength(2);
    for (const line of follows) expect(line).toContain('--arg base_ref="$DIFF_BASE" --arg head_ref="$DIFF_HEAD"');
    expect(judge.match(/DIFF_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \|\| /g)).toHaveLength(2);
    expect(judge.match(/DIFF_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \|\| 'HEAD' \}\}/g)).toHaveLength(2);
    expect(judge).not.toContain('origin/${{ github.base_ref }}');
  });
});
