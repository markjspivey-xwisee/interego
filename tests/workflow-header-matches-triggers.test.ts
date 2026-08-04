/**
 * Two things about `.github/workflows/` that nothing in this repo checked, and one of them
 * had already cost a whole workflow.
 *
 * ★ (1) A JOB-LEVEL `if:` CANNOT READ `matrix`. `jobs.<job_id>.if` is evaluated BEFORE the
 * strategy matrix is expanded, so the available contexts are github, inputs, needs and vars
 * — not matrix. This is not a predicate that quietly evaluates false and skips a job:
 * GitHub refuses to compile the entire workflow file, and every trigger produces a
 * startup_failure with zero jobs, zero seconds, no logs and no check runs. That is invisible
 * in any UI that shows you test results.
 *
 * `nightly-emergent.yml` did exactly this. Its only two runs ever were startup_failures;
 * someone read the red as an environment problem, disabled the workflow, and wrote a banner
 * attributing the hold to "revival against Railway" — so a file that could not parse looked
 * like a deliberate, reversible decision, and further commits edited it without anyone
 * finding out. `timeout-minutes:` and `continue-on-error:` DO accept `matrix`, which is what
 * made the mistake easy: `if:` is the one job-level key that does not.
 *
 * ★ (2) A BANNER CANNOT ASSERT A STATE THAT LIVES IN THE GITHUB API. The enabled/disabled
 * bit is not in the file, so a comment claiming "DISABLED" is unverifiable by construction
 * and can disagree with reality indefinitely. What CAN be checked is the file against
 * itself: a workflow whose prose says it is disabled while it still declares a live
 * `schedule:` is telling a reader something the file itself contradicts.
 *
 * No YAML dependency: `js-yaml` resolves here but is transitive, not declared, and a gate
 * that stops resolving is a gate that stops gating. The parse below is deliberately
 * indentation-based and only as clever as these two questions need.
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

/**
 * Every `if:` that sits at JOB level — i.e. indented exactly one step under `jobs:`'s child
 * key, which in this repo's style is 4 spaces. A step-level `if:` is deeper (8+) and is
 * legal with `matrix`, so the indentation is the whole discriminator and getting it wrong
 * in either direction makes this useless. The block value may continue onto later lines
 * (`if: >-`), so continuation lines are gathered until the indentation drops back.
 */
function jobLevelIfBlocks(yaml: string): Array<{ line: number; text: string }> {
  const lines = yaml.split(/\r?\n/);
  const out: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^ {4}if:(.*)$/.exec(line);
    if (!m) continue;
    let text = m[1] ?? '';
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (next.trim() === '') continue;
      if (!/^ {5,}/.test(next)) break;
      if (/^ {4}\S/.test(next)) break;
      text += `\n${next}`;
    }
    out.push({ line: i + 1, text });
  }
  return out;
}

describe('.github/workflows: a job-level `if:` never reads the matrix context', () => {
  it('finds workflows to check at all', () => {
    // Guards the guard: an empty listing makes every assertion below vacuous, which is the
    // same shape of failure as the startup_failure it exists to catch.
    expect(workflows.length).toBeGreaterThan(10);
  });

  it.each(workflows)('%s', (file) => {
    const yaml = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    const offenders = jobLevelIfBlocks(yaml)
      .filter((b) => /\bmatrix\./.test(b.text))
      .map((b) => `${file}:${b.line} job-level \`if:\` reads \`matrix.\``);
    expect(
      offenders,
      offenders.length
        ? `${offenders.join('\n')}\n  GitHub refuses to compile the whole file: the job-level `
          + '`if` is evaluated before the matrix expands. Move the predicate onto the step '
          + '(`steps.<id>.if`), where the matrix context IS in scope. The symptom is a '
          + 'startup_failure — 0 jobs, 0 seconds, no logs — not a skipped job.'
        : '',
    ).toEqual([]);
  });
});

describe('.github/workflows: a status banner does not contradict the file it sits in', () => {
  it.each(workflows)('%s', (file) => {
    const yaml = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    // Only comment lines, and only ones asserting the workflow is off right now. Prose
    // EXPLAINING a past disable ("was disabled", "ran `gh workflow disable`") is history
    // and must not match, or the guard flags the sentence that records the fix.
    const claimsDisabled = yaml
      .split(/\r?\n/)
      .filter((l) => /^\s*#/.test(l))
      .some((l) => /\bSTATUS:\s*DISABLED\b/i.test(l) || /\bthis workflow is (currently )?disabled\b/i.test(l));
    if (!claimsDisabled) return;
    const hasLiveSchedule = /^\s*schedule:\s*$/m.test(yaml)
      && /^\s*-\s*cron:/m.test(yaml);
    expect(
      hasLiveSchedule,
      `${file}: a comment says the workflow is DISABLED while the file still declares a live `
      + '`schedule:`. The enabled bit lives in the GitHub API, so the banner cannot be '
      + 'verified from here — but the file can be made to agree with itself. Either comment '
      + 'out the cron, or delete the banner and let the API be the single source.',
    ).toBe(false);
  });
});
