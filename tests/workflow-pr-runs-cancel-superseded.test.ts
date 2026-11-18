/**
 * Every workflow a pull request starts cancels its own run on the head that pull request has
 * left behind.
 *
 * Measured over 1000 runs (2026-11-16 03:39Z to 2026-11-17 15:23Z, 1181 jobs read): a job waited
 * a median of 2.5 minutes for a runner, 44 at the 90th percentile and 97 at worst, and between
 * 05:00Z and 09:00Z on the 17th the hourly median was 19 to 35 minutes. One pull request head
 * starts a median of 10 workflows and about 180 runner-minutes, and 29 of the workflows it can
 * start had no concurrency group, Bridge Typecheck and Mutation Gate (66 runner-minutes between
 * them) included. A branch pushed nine times ran all of it nine times, eight of them for a head
 * nothing would ever merge, each in front of the ninth in the queue.
 *
 * A list of 29 files fails silently on the thirtieth, so this reads the directory: a workflow
 * with a `pull_request` trigger and no group that cancels by pull request number fails here, on
 * the pull request that adds it.
 *
 * No YAML dependency, as tests/workflow-header-matches-triggers.test.ts says and for its reason:
 * the questions below are about top-level keys and two-space children, and nothing cleverer.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(REPO, '.github', 'workflows');

const workflows = readdirSync(WORKFLOW_DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

/** The lines of one top-level block: from `key:` at column 0 to the next line at column 0. */
function topLevelBlock(yaml: string, key: string): string[] | undefined {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (start < 0) return undefined;
  const out = [lines[start] ?? ''];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    out.push(line);
  }
  return out;
}

/** Whether a pull request starts this workflow: `pull_request` or `pull_request_target` under `on:`. */
function startedByPullRequest(yaml: string): boolean {
  const on = topLevelBlock(yaml, 'on') ?? topLevelBlock(yaml, "'on'") ?? topLevelBlock(yaml, '"on"');
  if (!on) return false;
  return on.some((l) => /^on:.*\bpull_request(_target)?\b/.test(l) || /^ {2}pull_request(_target)?:/.test(l));
}

/**
 * Workflows a pull request starts that keep the run in flight, each with why. An exemption is a
 * visible, argued line here and not an omission; the last test below fails when one of these
 * starts cancelling, so the list cannot outlive its reasons.
 */
const KEEPS_ITS_RUN: Readonly<Record<string, string>> = {
  'nightly-emergent.yml': 'observational: its own note says a half-finished run still leaves diagnostic artifacts attached',
  // Set by the I2IDL-X lane on 2026-10 and left as found: i2idlx-ui-oracle.yml locates these two
  // workflows' completed outputs for a head, and whether a cancelled build would strand it is
  // that lane's call. They hold a group without cancelling, so a new head queues behind the old.
  'i2idlx-native-diagnostic.yml': 'the UI oracle reads its completed output; left as its owner set it',
  'i2idlx-orchestra-history.yml': 'left as its owner set it, beside the native diagnostic',
};

const startedByPull = workflows.filter((f) => startedByPullRequest(readFileSync(join(WORKFLOW_DIR, f), 'utf8')));
const pullRequestWorkflows = startedByPull.filter((f) => !(f in KEEPS_ITS_RUN));

describe('.github/workflows: a pull request run is cancelled by the next push to its pull request', () => {
  it('finds pull request workflows to check at all', () => {
    // Guards the guard: a trigger parse that matches nothing makes every assertion below vacuous.
    expect(pullRequestWorkflows.length).toBeGreaterThan(20);
    expect(pullRequestWorkflows).toContain('bridge-typecheck.yml');
    expect(pullRequestWorkflows).toContain('mutation-gate.yml');
  });

  for (const file of pullRequestWorkflows) {
    it(`${file} groups its runs by pull request and cancels the one in flight`, () => {
      const block = topLevelBlock(readFileSync(join(WORKFLOW_DIR, file), 'utf8'), 'concurrency');
      expect(block, `${file} is started by pull requests and declares no top-level concurrency group, so a superseded head runs to its end in front of the new one`).toBeDefined();
      const text = (block ?? []).filter((l) => !/^\s*#/.test(l)).join('\n');
      expect(text, `${file}: the group must name the pull request, or two pull requests cancel each other`).toMatch(/^ {2}group:.*github\.(event\.pull_request\.number|ref\b|head_ref\b)/m);
      // `true`, or an expression that is true for pull requests.
      expect(text, `${file}: a group that does not cancel only queues the new head behind the old one`).toMatch(/^ {2}cancel-in-progress:\s*(true\s*$|\$\{\{.*pull_request.*\}\})/m);
    });
  }

  it('every exemption names a pull request workflow that still keeps its run', () => {
    for (const file of Object.keys(KEEPS_ITS_RUN)) {
      expect(startedByPull, `${file} is exempted and is not a pull request workflow here`).toContain(file);
      const block = topLevelBlock(readFileSync(join(WORKFLOW_DIR, file), 'utf8'), 'concurrency') ?? [];
      const cancels = block.some((l) => /^ {2}cancel-in-progress:\s*true\s*$/.test(l));
      expect(cancels, `${file} cancels its run in flight now, so it no longer needs its exemption`).toBe(false);
    }
  });
});
