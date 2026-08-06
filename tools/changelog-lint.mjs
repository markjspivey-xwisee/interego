#!/usr/bin/env node
/**
 * The changelog's two claims about itself, checked against git.
 *
 * ── ★ WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * "The changelog needs a 235-commit backfill" was carried as an open item, with the reason
 * recorded in a PR body. Two things were wrong with that, and the second one is the point.
 *
 * 1. THE NUMBER IN THE PR BODY WAS ALREADY STALE WHEN IT WAS WRITTEN, AND GOT WORSE WHILE
 *    NOBODY LOOKED. Measured on this tree: 431 commits sit between the entry dated
 *    2026-06-14 and the next one, not 235. A backlog figure typed into a pull request is the
 *    same artifact as the counts this repo keeps having to correct — the ESLint job label
 *    that said "47 files pinned", spec/LAYERS.md's "41/41 classes grounded", README's
 *    nineteen-row suite table with nine wrong numbers. A reason in a PR body is not a
 *    mechanism, and this file is what that sentence means in practice.
 *
 * 2. ★★ AND THE BACKFILL WAS NEVER THE DEFECT. CHANGELOG.md's own preamble says
 *
 *        "Commit hashes link back to the git history"
 *
 *    and it cites 78 short hashes in backticks. NONE OF THE 78 RESOLVE — `git cat-file -e`
 *    fails on every one, because the history they were written against is not the history
 *    this repository has. That is a false statement at HEAD, in the second paragraph of the
 *    file, and no amount of backfilling would have found it. Writing 431 more entries would
 *    have added 431 more citations to a convention that does not work.
 *
 * ── WHAT IS CHECKED, AND WHAT IS DELIBERATELY NOT ────────────────────────────
 *
 * NOT checked: that every commit has an entry. CHANGELOG.md says "Notable changes", which is
 * a curated document by design, and a gate demanding an entry per commit would either be
 * ignored or turn the file into a mechanical `git log` — which is what `git log` is for.
 *
 * Checked: the file's own factual claims, both of which are things it asserts about itself
 * and neither of which anything could previously contradict.
 *
 *   A. UNRESOLVABLE HASH CITATIONS may not grow. The 78 that predate the history rewrite are
 *      pinned and cannot be repaired; a 79th means someone has just written a citation that
 *      does not resolve, which is the convention failing forward rather than historically.
 *      Ratcheted downward too: if the count falls, bank it.
 *
 *   B. THE UNDOCUMENTED BACKLOG has a number, and the number is in the file, and git decides
 *      whether it is true. `<!-- documented-through: <sha> -->` names the newest commit the
 *      newest entry describes; everything after it is undocumented. The ceiling below is what
 *      turns "we are behind" from a note somebody wrote once into a value that goes red.
 *
 * ── SHALLOW CLONES ───────────────────────────────────────────────────────────
 *
 * Both checks need real history. `actions/checkout` defaults to `fetch-depth: 1`, under which
 * every hash fails to resolve and the backlog is uncountable — i.e. the gate would report the
 * worst possible result for a reason that has nothing to do with the changelog. So a shallow
 * clone is REFUSED with the fix named, never skipped: "could not check" must not read the
 * same as "checked and fine", which is the rule every other gate in this directory follows.
 *
 * Run: node tools/changelog-lint.mjs
 * Exit: 0 clean, 1 on any failure.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

/**
 * How many cited short hashes do not resolve to a commit in this repository.
 *
 * 78 as measured 2026-08-04, which is ALL of them: the citations were written against a
 * history that no longer exists (a rewrite, or an earlier repository), and they cannot be
 * recovered — the mapping from old sha to new is gone. They are pinned rather than deleted
 * because deleting them would erase which change the entry is about, and the prose around
 * each one is still the record.
 *
 * ★ THE PIN IS A CEILING FOR NEW CITATIONS, NOT AN ACCEPTANCE OF THE OLD ONES. A 79th
 * unresolvable hash is a citation written TODAY against a commit that does not exist, which
 * is a typo or a hash from someone's local branch, and it is caught the same day.
 */
const UNRESOLVABLE_PIN = 78;

/**
 * The most commits that may sit undocumented after `documented-through` before this fails.
 *
 * Set at 450 against a measured 433, which is deliberately close: the backlog is 431 commits
 * between the 2026-06-14 and 2026-08-04 entries plus 2 since. The slack is small on purpose —
 * a ceiling with room for another year of drift is the "235" figure again with extra steps.
 * Raising it is a decision somebody makes in a diff, which is the whole difference between
 * this and a note in a pull request.
 */
// 450 -> 470, and the honest reason is that NOTHING WAS DOCUMENTED TO EARN IT. The backlog
// reached 454 by ordinary commit traffic, not by this round's work: the marker still names
// the commit through which the file is continuously current, and moving it would claim
// coverage of 454 commits nobody wrote entries for. So the ceiling moves and the marker does
// not, which is the gate working as designed — it forced the raise to be a visible line in a
// diff with a reason attached, instead of a number in a pull request body drifting unread.
// The 20 of headroom is deliberately small: this is due again soon, on purpose.
const BACKLOG_CEILING = 470;

/**
 * `<!-- documented-through: <sha> -->` — the newest commit through which the file is
 * CONTINUOUSLY current.
 *
 * Not "the newest commit any entry mentions", which is a different and much less useful
 * number: the newest entry here is dated 2026-08-04 and describes work in PR #260, while the
 * 431 commits between it and the 2026-06-14 entry are undocumented. Anchoring on the newest
 * entry would have reported a backlog of 2 over a gap of 433 — a measurement that agrees with
 * itself and describes nothing.
 */
const MARKER = /<!--\s*documented-through:\s*([0-9a-f]{7,40})\s*-->/;

/**
 * A citation: a backtick-delimited span that is ENTIRELY hex, 7–40 characters.
 *
 * Whole-span, not a `\b`-bounded search inside prose, because the loose form matches
 * `ed25519` (seven hex characters, a cipher name) and the `--0000010` revision suffixes in
 * the Azure-era deployment entries. Measured: the loose form finds 86 tokens, 8 of which are
 * not commit citations at all, so a gate built on it would pin 8 numbers that can never be
 * anything but "unresolvable" and would be reporting on the wrong thing.
 *
 * `g` is safe only because every reader uses `matchAll`, which clones the regex. Do not add a
 * `.test()` or `.exec()` caller: a module-level /g regex carries `lastIndex` between those
 * calls and would silently skip every other citation.
 */
const CITATION = /`([0-9a-f]{7,40})`/g;

/** The honest sentence that replaced the false one. Asserted positively — see below. */
const HONEST_CLAIM = /do not resolve against this repository/i;

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status ?? -1, out: (r.stdout ?? '').trim() };
}

/**
 * The failure paragraphs, given the changelog text and two lookups.
 *
 * Callbacks in, so `tests/changelog-lint.test.ts` can drive every branch without a git
 * repository — and so the live call and the tested call are the same function rather than a
 * copy of it. A double standing in for this could not express a stale pin.
 *
 * @param {string} text                     contents of CHANGELOG.md
 * @param {(sha: string) => boolean} resolves  does this sha name a commit here
 * @param {(sha: string) => number|null} countSince  commits after `sha`, or null if unknown
 * @returns {string[]} failure paragraphs
 */
export function changelogFailures(text, resolves, countSince) {
  const failures = [];

  const cited = [...new Set([...text.matchAll(CITATION)].map(m => m[1]))];
  if (cited.length === 0) {
    // The shape check every gate here carries: a claim this tool cannot find is a claim
    // nobody checks. If the citation convention is abandoned, delete the pin in the same
    // commit rather than leaving a checker looking at nothing.
    failures.push(
      'CHANGELOG.md cites no commit hash this gate can find (no wholly-hex backticked span).\n'
      + '      Either the convention changed — update CITATION in tools/changelog-lint.mjs —\n'
      + '      or the citations are gone, in which case set UNRESOLVABLE_PIN to 0 in the same\n'
      + '      commit. A pin over an empty set is a check that cannot fail.',
    );
  }
  const unresolvable = cited.filter(h => !resolves(h));
  if (unresolvable.length > UNRESOLVABLE_PIN) {
    const fresh = unresolvable.length - UNRESOLVABLE_PIN;
    failures.push(
      `CHANGELOG.md cites ${unresolvable.length} commit hashes that do not resolve; `
      + `${UNRESOLVABLE_PIN} are pinned as pre-rewrite history.\n`
      + `      ${fresh} of them are NEW. A citation written today against a commit that does\n`
      + '      not exist here is a typo or a hash from a local branch — fix the citation.\n'
      + '      Do not raise the pin: it exists to make exactly this visible.',
    );
  } else if (unresolvable.length < UNRESOLVABLE_PIN) {
    failures.push(
      `CHANGELOG.md now cites only ${unresolvable.length} unresolvable hashes, pinned at `
      + `${UNRESOLVABLE_PIN}.\n`
      + `      It IMPROVED — write ${unresolvable.length} into UNRESOLVABLE_PIN in\n`
      + '      tools/changelog-lint.mjs so the gain cannot be quietly lost again.',
    );
  }

  // ★ THE POSITIVE HALF. Deleting the false sentence is not the same as stating the true
  // one, and a reader who finds neither assumes the usual — which is what "Commit hashes
  // link back to the git history" was trading on for 78 citations.
  if (!HONEST_CLAIM.test(text)) {
    failures.push(
      'CHANGELOG.md no longer says that its cited hashes do not resolve against this\n'
      + `      repository. ${unresolvable.length} of ${cited.length} do not. Restore the\n`
      + '      sentence, or — if the citations have been repaired — update HONEST_CLAIM in\n'
      + '      tools/changelog-lint.mjs in the same commit.',
    );
  }

  const marker = MARKER.exec(text);
  if (!marker) {
    failures.push(
      'CHANGELOG.md has no `<!-- documented-through: <sha> -->` marker, so the size of the\n'
      + '      undocumented backlog cannot be computed and is back to being whatever somebody\n'
      + '      last typed into a pull request. That is the state this gate exists to end.',
    );
  } else {
    const behind = countSince(marker[1]);
    if (behind === null) {
      failures.push(
        `CHANGELOG.md's documented-through marker names ${marker[1]}, which this repository\n`
        + '      cannot resolve. Point it at a commit that exists — it is the anchor the whole\n'
        + '      backlog measurement hangs off.',
      );
    } else if (behind > BACKLOG_CEILING) {
      failures.push(
        `${behind} commits have landed since CHANGELOG.md's documented-through marker; the\n`
        + `      ceiling is ${BACKLOG_CEILING}. Write an entry and move the marker, or raise\n`
        + '      BACKLOG_CEILING in tools/changelog-lint.mjs and say why in the same diff.\n'
        + '      The point is not that the number is small; it is that it is a number that\n'
        + '      goes red, rather than a figure in a pull request that quietly went from 235\n'
        + '      to 431 with nothing able to notice.',
      );
    }
  }

  return failures;
}

function main() {
  const text = readFileSync(CHANGELOG, 'utf8');

  // Refused, not skipped. Under `fetch-depth: 1` every hash fails to resolve and the backlog
  // is uncountable, so the gate would report catastrophe for a reason that has nothing to do
  // with the changelog — and somebody would then "fix" it by raising the pin.
  const shallow = git(['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0) {
    console.error('\nFAIL: not a git repository (or git is unavailable), so neither of this\n'
      + '      gate\'s checks can run. Both are claims about git history; there is no\n'
      + '      degraded mode that would still mean anything.');
    process.exit(1);
  }
  if (shallow.out === 'true') {
    console.error('\nFAIL: this is a SHALLOW clone. Every cited hash would fail to resolve and\n'
      + '      the backlog would be uncountable, for reasons that have nothing to do with\n'
      + '      CHANGELOG.md. Set `fetch-depth: 0` on the actions/checkout step that precedes\n'
      + '      this gate. Skipping instead would make "could not check" read as "fine".');
    process.exit(1);
  }

  const resolves = sha => git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  const countSince = (sha) => {
    if (!resolves(sha)) return null;
    const r = git(['rev-list', '--count', `${sha}..HEAD`]);
    return r.status === 0 ? Number(r.out) : null;
  };

  const failures = changelogFailures(text, resolves, countSince);

  const cited = [...new Set([...text.matchAll(CITATION)].map(m => m[1]))];
  const unresolvable = cited.filter(h => !resolves(h)).length;
  const marker = MARKER.exec(text);
  const behind = marker ? countSince(marker[1]) : null;
  console.log('Changelog-lint — the file\'s claims about itself, checked against git\n');
  console.log(`  cited commit hashes: ${cited.length}, of which ${unresolvable} do not resolve `
    + `(pinned at ${UNRESOLVABLE_PIN})`);
  console.log(`  undocumented backlog: ${behind === null ? 'UNKNOWN' : behind} commit(s) since `
    + `${marker ? marker[1] : 'no marker'} (ceiling ${BACKLOG_CEILING})`);

  if (failures.length === 0) {
    console.log('\nPASS: no new unresolvable citation, the file states the truth about the old '
      + 'ones, and the backlog is inside its ceiling.');
    return;
  }
  console.error(['', '★ CHANGELOG GATE FAILED', '', ...failures.map(f => `  ${f}`), ''].join('\n'));
  process.exit(1);
}

// Direct invocation only. Importing this module for `changelogFailures` must not run the gate
// or call process.exit — see tools/derivation-lint.mjs for what that costs inside a vitest
// worker under this repo's pinned singleFork pool.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
