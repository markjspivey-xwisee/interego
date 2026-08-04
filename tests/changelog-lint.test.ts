/**
 * The changelog gate, driven through the real function.
 *
 * ★ WHY. CHANGELOG.md's preamble said "Commit hashes link back to the git history" and cited
 * 78 short hashes in backticks. `git cat-file -e` fails on ALL 78 — they were written against
 * a history this repository does not have. A false sentence in the second paragraph of the
 * file, surviving because nobody ever tried to follow a citation.
 *
 * The item that was carried instead was "the changelog needs a 235-commit backfill", and that
 * number was itself stale: measured on this tree, 433 commits sit after the point the file is
 * continuously current through. A figure in a pull request body decayed by ~200 with nothing
 * able to notice, which is precisely the argument for this being a gate.
 *
 * Every case drives `changelogFailures` with injected lookups rather than a real repository,
 * so each branch is exercised deterministically — including the ones that cannot be reached
 * from the current tree, like a citation that DOES resolve.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Dynamic import through a URL expression: the gate is untyped `.mjs` and a static specifier
// would be TS7016 under tsconfig.check.json, which runs in vitest's globalSetup and would
// fail the suite before collection. The module's body is behind a direct-invocation guard, so
// importing it does not run the gate or call process.exit.
const load = async (): Promise<(
  text: string,
  resolves: (sha: string) => boolean,
  countSince: (sha: string) => number | null,
) => string[]> => {
  const m = await import(new URL('../tools/changelog-lint.mjs', import.meta.url).href) as {
    changelogFailures?: (
      text: string,
      resolves: (sha: string) => boolean,
      countSince: (sha: string) => number | null,
    ) => string[];
  };
  expect(typeof m.changelogFailures, 'changelog-lint.mjs stopped exporting changelogFailures')
    .toBe('function');
  return m.changelogFailures as (
    text: string,
    resolves: (sha: string) => boolean,
    countSince: (sha: string) => number | null,
  ) => string[];
};

/** The live file, so the pins in the gate are checked against the real document too. */
const live = readFileSync(resolve(REPO, 'CHANGELOG.md'), 'utf8');

/** 78 citations — the pinned count — none resolving, plus the marker and honest sentence. */
const seventyEight = Array.from({ length: 78 }, (_, i) => `\`${i.toString(16).padStart(7, 'a')}\``);
const wellFormed = (extra = ''): string => [
  '# Changelog',
  'The cited hashes do not resolve against this repository.',
  '<!-- documented-through: 2a4f2bb -->',
  ...seventyEight,
  extra,
].join('\n');

describe('the changelog gate', () => {
  it('★ is silent on a file whose claims are all true — the control', async () => {
    const failures = await load();
    const out = failures(wellFormed(), () => false, () => 10);
    expect(out, out.join('\n')).toEqual([]);
  });

  it('★★ fails on a NEW citation that does not resolve, and refuses to suggest raising the pin', async () => {
    // The forward-looking half. The 78 pre-rewrite citations are unrepairable; a 79th is a
    // hash somebody wrote today against a commit that does not exist — a typo, or a local
    // branch — and it is caught the same day.
    const failures = await load();
    const out = failures(wellFormed('`deadbee`'), () => false, () => 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/79 commit hashes that do not resolve/);
    expect(out[0]).toMatch(/1 of them are NEW/);
    expect(out[0]).toMatch(/Do not raise the pin/);
  });

  it('★ fails when the citations IMPROVE without the pin moving, and names the number', async () => {
    const failures = await load();
    // One of the 78 now resolves: a gain nobody banks is a gain that can be lost again.
    const first = 'aaaaaa0';
    const out = failures(wellFormed(), sha => sha === first, () => 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/only 77 unresolvable hashes, pinned at 78/);
    expect(out[0]).toMatch(/write 77 into UNRESOLVABLE_PIN/);
  });

  it('★★ fails when the backlog passes the ceiling — the number that went 235 -> 431 unobserved', async () => {
    const failures = await load();
    const out = failures(wellFormed(), () => false, () => 100_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/100000 commits have landed since/);
    expect(out[0]).toMatch(/quietly went from 235\s*\n?\s*to 431/);
  });

  it('★ fails when the marker is gone, because then the backlog is unmeasurable again', async () => {
    const failures = await load();
    const noMarker = wellFormed().replace(/<!-- documented-through: [0-9a-f]+ -->/, '');
    const out = failures(noMarker, () => false, () => 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no `<!-- documented-through: <sha> -->` marker/);
  });

  it('★ fails when the marker names a commit this repository does not have', async () => {
    const failures = await load();
    const out = failures(wellFormed(), () => false, () => null);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/which this repository\s*\n?\s*cannot resolve/);
  });

  it('★★ fails when the honest sentence is deleted — removing a false claim is not stating the true one', async () => {
    // "Commit hashes link back to the git history" was the false form. Deleting it silently
    // leaves a reader assuming the usual, which is exactly what the false sentence traded on.
    const failures = await load();
    const silent = wellFormed().replace('The cited hashes do not resolve against this repository.', '');
    const out = failures(silent, () => false, () => 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no longer says that its cited hashes do not resolve/);
  });

  it('★ refuses a file it can find no citation in at all', async () => {
    // A pin over an empty set is a check that cannot fail — the shape every gate here guards.
    const failures = await load();
    const out = failures(
      '# Changelog\nThe cited hashes do not resolve against this repository.\n'
      + '<!-- documented-through: 2a4f2bb -->\n',
      () => false, () => 10,
    );
    expect(out.some(f => /cites no commit hash this gate can find/.test(f))).toBe(true);
  });

  it('★ does not count `ed25519` or an Azure revision suffix as a commit citation', async () => {
    // Measured: a `\b`-bounded hex search over the real file finds 86 tokens, 8 of which are
    // not citations — `ed25519`, and the `--0000010` revision suffixes in the Azure-era
    // entries. Pinning those would be pinning eight numbers that can only ever read
    // "unresolvable", about the wrong thing.
    const failures = await load();
    const out = failures(
      `${wellFormed()}\n- ed25519 signing, revision --0000010, sha256:931076ca\n`,
      () => false, () => 10,
    );
    expect(out, out.join('\n')).toEqual([]);
  });

  it('★ the LIVE CHANGELOG.md still carries the marker and the honest sentence', () => {
    // The fixtures above prove the checker works; this proves it is pointed at a document
    // that still satisfies it, which is the assertion the fixtures cannot make.
    expect(live).toMatch(/<!--\s*documented-through:\s*[0-9a-f]{7,40}\s*-->/);
    expect(live).toMatch(/do not resolve against this repository/i);
    // ★ And the claim that was false must not come back — ASSERTED, not merely mentioned.
    // The preamble now QUOTES the old sentence in order to say it was wrong, and a scan that
    // cannot tell a correction from the claim it corrects fails on the correction. Same
    // distinction `tools/docs-drift-lint.mjs` had to make between a historical note and a
    // present-tense liveness claim. Restoring the sentence in the assertive voice — outside
    // quotes, which is how it was written — still fails here.
    expect(live.replace(/"[^"]*"/g, ''))
      .not.toMatch(/Commit hashes link back to the git history/);
  });
});
