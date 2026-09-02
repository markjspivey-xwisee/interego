/**
 * The working tree is the tree CI checks out, and no source file is binary.
 *
 * ── WHY, (1): A GATE THAT ONLY PASSED ON ONE PLATFORM'S CHECKOUT ─────────────
 *
 * `tests/engagement-report-mirror.test.ts` extracted the embedded markdown with a bare
 * LF anchored immediately after `<script id="md-source" …>`. The index stores
 * ENGAGEMENT-REPORT.html LF; git's Windows default `core.autocrlf=true` writes CRLF into
 * the working tree; the repo had no .gitattributes to pin either. So the byte after `>`
 * was CR on the maintainer's clean checkout and LF on the Linux runner: the gate was
 * green in CI and DETERMINISTICALLY RED locally, on master, with `git status` empty.
 * Measured — `git ls-files --eol ENGAGEMENT-REPORT.html` reported `i/lf w/crlf attr/`.
 *
 * That is the same class as the house rule about CI's Node version, inverted: a verdict
 * that is a property of the HOST is not a verdict about the tree. Fixing the one regex
 * fixes one test; what closes the class is that the bytes on disk are the bytes CI reads,
 * and this file is what asserts it. `.gitattributes` alone cannot — attributes apply on
 * checkout, so a tree that predates the file keeps its old endings and stays silently
 * divergent until someone re-checks-out.
 *
 * ── WHY, (2): A GATE THAT LANDED WITH NO REVIEWABLE DIFF ─────────────────────
 *
 * `tools/docs-claim-lint.mjs` shipped with a raw NUL byte in a template literal used as
 * a Set key, so git classified the whole file as binary: `Bin 0 -> 10308 bytes`, no diff
 * on GitHub, no diff locally, and `grep` answering only "Binary file … matches". A
 * repo-wide scan found four more. The instruction for this project is to read `git show`
 * line by line; for those files that was impossible. All five now spell the character as
 * an escape, and this gate is what keeps the sixth from arriving unnoticed.
 *
 * ── SCOPE, STATED ────────────────────────────────────────────────────────────
 *
 * Tracked files only, via `git ls-files` — an untracked scratch file is not the tree.
 * `.bat`/`.cmd` are exempt from the CR check because .gitattributes pins them to CRLF on
 * purpose (cmd.exe). Binary extensions are exempt from both checks by the same list, so
 * the two files stay in agreement rather than drifting.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions .gitattributes marks `binary`; bytes there mean nothing to these checks. */
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|woff2?|ttf|eot|mp4|wasm)$/i;
/** Extensions .gitattributes pins to CRLF on purpose. */
const CRLF_BY_DESIGN = /\.(bat|cmd)$/i;

function trackedFiles(): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr?.toString() ?? ''}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

describe('the working tree matches the index CI checks out', () => {
  const files = trackedFiles();

  it('finds tracked files at all', () => {
    // Guards the guard: an empty listing makes both scans below vacuous, which is the
    // failure mode that let the original defect sit on master.
    expect(files.length).toBeGreaterThan(1000);
  });

  it('pins line endings in .gitattributes rather than leaving them to core.autocrlf', () => {
    const attrs = readFileSync(join(REPO, '.gitattributes'), 'utf8');
    expect(attrs).toMatch(/^\*\s+text=auto\s+eol=lf\s*$/m);
    // The extensions whose bytes the suite compares directly, plus `diff` so a stray
    // control byte cannot make one of them undiffable again.
    for (const ext of ['html', 'md', 'ts', 'mjs']) {
      expect(attrs, `.gitattributes does not pin *.${ext} to text eol=lf diff`)
        .toMatch(new RegExp(`^\\*\\.${ext}\\s+text\\s+eol=lf\\s+diff\\s*$`, 'm'));
    }
  });

  /**
   * ★★ THESE TWO READ THE WHOLE TRACKED TREE, AND 5,000 ms WAS NEVER A BUDGET ANYONE CHOSE FOR
   * THAT. vitest.config.ts sets no `testTimeout`, so all 331 modules inherit vitest's default.
   * Measured on this machine: the file runs in ~2.6 s ALONE and the CR scan took 5,862 ms inside a
   * full `npx vitest run` — it failed by 862 ms, on a tree that was perfectly clean, while the
   * pool was busy. A whole-tree scan is not slow because something is wrong; it is slow because
   * it reads ~2,700 files, and it gets slower when the machine is loaded.
   *
   * ★ THIS IS NOT RELAXING AN ASSERTION. Neither check is weakened: every tracked file is still
   * read and a single CR or control byte still fails. What changed is that the deadline now
   * reflects the work, so a green tree cannot be reported as a defect because another suite was
   * running — which is the failure that trains people to re-run instead of read.
   */
  it('holds no CR in any tracked text file', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (BINARY.test(f) || CRLF_BY_DESIGN.test(f)) continue;
      const buf = readFileSync(join(REPO, f));
      // A NUL means "git thinks this is binary"; the next check owns that case.
      if (buf.includes(0)) continue;
      if (buf.includes(0x0d)) offenders.push(f);
    }
    expect(
      offenders.slice(0, 20),
      `${offenders.length} tracked text file(s) hold CRLF in the working tree while the index `
        + 'is LF. Re-check out the tree so local runs read the bytes CI reads:\n'
        + '  git checkout-index -a -f\n  ' + offenders.slice(0, 20).join('\n  '),
    ).toEqual([]);
  }, 30_000);

  it('holds no control byte that would make a source file binary to git', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (BINARY.test(f)) continue;
      const buf = readFileSync(join(REPO, f));
      // ★ EVERY C0 CONTROL BYTE, NOT JUST NUL. This read `buf.indexOf(0)` while its own
      // name said "control byte", and three slipped past it: a 0x01 dedup separator in
      // kernel/affordance-extraction.ts, a 0x07 inside a test asserting on control characters,
      // and a 0x1b heading an ANSI-strip regex. A fourth arrived the day this was widened -
      // five 0x08 bytes generated into the isTransientNetworkError pattern, which silently
      // ate its word-boundary escapes and left a regex that still compiled and matched the
      // wrong thing. NUL is the only one git calls binary; the rest are worse in a different
      // way, because they are invisible in the diff, the terminal and the grep, so the file
      // reads as correct while behaving otherwise. TAB / LF / CR are the three that belong.
      const at = buf.findIndex((c) => c < 32 && c !== 9 && c !== 10 && c !== 13);
      if (at !== -1) {
        offenders.push(`${f} (0x${buf[at]?.toString(16).padStart(2, '0')} at byte ${at})`);
      }
    }
    expect(
      offenders,
      'a raw control byte is invisible in the diff, the terminal and the grep, so the source '
        + 'reads as correct while behaving otherwise - and a raw NUL additionally makes git '
        + 'treat the file as binary (`Bin 0 -> N bytes`, no reviewable diff, "Binary file ... '
        + 'matches"). Spell it as an escape instead - the string is identical:\n  '
        + offenders.join('\n  '),
    ).toEqual([]);
  }, 30_000);
});
