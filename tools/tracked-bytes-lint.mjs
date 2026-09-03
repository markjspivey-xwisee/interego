/**
 * CI gate — the bytes of every TRACKED file are the bytes CI reads, and none is binary to git.
 *
 * ── ★★ WHY THIS IS A TOOL AND NOT ONLY A TEST ────────────────────────────────────────────────
 *
 * The scan below lives — and lived first — in `tests/line-endings-are-normalised.test.ts`, whose
 * header carries the two defects that produced it: a gate that was green in CI and
 * deterministically red locally because `core.autocrlf` decided the byte after a `>`, and five
 * tracked files holding a raw NUL, which git classifies as binary so `git show` produced no
 * reviewable diff at all.
 *
 * Its subject is `git ls-files` — the whole tree — but it ran only inside `npx vitest run`, which
 * was invoked from a workflow behind a `paths:` list. A control byte in a file type that list does
 * not name would not start the job that would have found it. So a step was added to the ESLint
 * workflow to run that one test file unfiltered.
 *
 * ★★★ AND THAT STEP FAILED CI IMMEDIATELY, FOR A REASON WORTH RECORDING: the ESLint job runs
 * `npm ci` and nothing else, while `npx vitest run` fires vitest's globalSetup — which is the
 * TYPECHECK gate over `tsconfig.check.json`. With no `npm run build`, `@interego/*` resolves to a
 * `dist` that does not exist, and the job reported 1,616 type errors that were all one missing
 * build. A whole-tree byte scan had dragged a compiler into a lint job.
 *
 * The fix is not a build step in that job — that is two minutes of CI to run a scan that needs no
 * compiler — and it is not a second copy of the scan, which is where two implementations drift.
 * It is ONE implementation with two entry points: this module exports the scan, the test imports
 * and drives it (keeping every assertion and every word of its reasoning), and the workflow runs
 * this file directly. Same pattern as `tools/turtle-iri-ratchet.mjs`, for the same reason.
 *
 *   node tools/tracked-bytes-lint.mjs
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions .gitattributes marks `binary`; bytes there mean nothing to these checks. */
export const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|zip|gz|woff2?|ttf|eot|mp4|wasm)$/i;
/** Extensions .gitattributes pins to CRLF on purpose (cmd.exe). */
export const CRLF_BY_DESIGN = /\.(bat|cmd)$/i;

/**
 * Dotfiles read as an "extension" (.gitignore, .nojekyll) and are not a file type.
 *
 * Exported so the two entry points cannot disagree about what counts as a type.
 */
export const DOTFILE_PSEUDO_EXTENSIONS = new Set(['gitignore', 'gitattributes', 'dockerignore',
  'nojekyll', 'example', 'dashboard', 'discord', 'identity', 'relay', 'validator']);

/** Every tracked path, from git rather than a walk — an untracked scratch file is not the tree. */
export function trackedFiles(repo = REPO_ROOT) {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr?.toString() ?? ''}`);
  return r.stdout.toString('utf8').split('\0').filter(Boolean);
}

/**
 * Scan the tracked tree once and report every offender, by class.
 *
 * One pass, because it reads ~2,700 files and each entry point wants all four answers.
 */
export function scanTrackedBytes(repo = REPO_ROOT) {
  const files = trackedFiles(repo);
  const cr = [];
  const controlBytes = [];
  const bom = [];
  const extensionCounts = new Map();

  for (const f of files) {
    const isBinary = BINARY.test(f);
    if (!isBinary) {
      const m = /\.([A-Za-z0-9]+)$/.exec(f);
      if (m) {
        const ext = (m[1] ?? '').toLowerCase();
        extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
      }
    }
    if (isBinary) continue;
    const buf = readFileSync(join(repo, f));

    // A NUL means "git thinks this is binary"; the control-byte class below owns that case.
    if (!buf.includes(0) && !CRLF_BY_DESIGN.test(f) && buf.includes(0x0d)) cr.push(f);

    // ★ EVERY C0 CONTROL BYTE, NOT JUST NUL. This read `indexOf(0)` while its own name said
    // "control byte", and four slipped past: a 0x01 dedup separator, a 0x07 inside a test
    // asserting on control characters, a 0x1b heading an ANSI-strip regex, and five 0x08 bytes
    // generated into a regex, which silently ate its word-boundary escapes and left a pattern
    // that still compiled and matched the wrong thing. TAB / LF / CR are the three that belong.
    const at = buf.findIndex((c) => c < 32 && c !== 9 && c !== 10 && c !== 13);
    if (at !== -1) {
      controlBytes.push(`${f} (0x${buf[at]?.toString(16).padStart(2, '0')} at byte ${at})`);
    }

    // EF BB BF is not a C0 byte, so widening the sweep above left it out. It is invisible in
    // every editor and diff, and not inert: a BOM ahead of the first CSS rule, or ahead of `#!`,
    // changes how the consumer parses the file.
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bom.push(f);
  }

  const attributes = readFileSync(join(repo, '.gitattributes'), 'utf8');
  const declared = new Set([...attributes.matchAll(/^\*\.([A-Za-z0-9]+)/gm)].map((m) => m[1]));
  const undeclaredExtensions = [...extensionCounts.entries()]
    .filter(([ext]) => !declared.has(ext) && !DOTFILE_PSEUDO_EXTENSIONS.has(ext))
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `*.${ext} (${n} tracked file(s))`);

  return { files, cr, controlBytes, bom, undeclaredExtensions, attributes, declared };
}

function main() {
  const r = scanTrackedBytes();
  const problems = [];

  // Guards the guard: an empty listing makes every check below vacuous, which is the failure
  // mode that let the original defect sit on master.
  if (r.files.length < 1000) {
    console.error(`\n★ TRACKED BYTES GATE — THE LISTING IS EMPTY\n`);
    console.error(`  git ls-files reported ${r.files.length} tracked file(s) and this repository has`);
    console.error(`  thousands. Every check below would pass over nothing.\n`);
    process.exit(1);
  }

  if (r.cr.length > 0) {
    problems.push(`${r.cr.length} tracked text file(s) hold CRLF in the working tree while the `
      + 'index is LF. Re-check out the tree so local runs read the bytes CI reads:\n'
      + '    git checkout-index -a -f\n    ' + r.cr.slice(0, 20).join('\n    '));
  }
  if (r.controlBytes.length > 0) {
    problems.push('a raw control byte is invisible in the diff, the terminal and the grep, so the '
      + 'source reads as correct while behaving otherwise — and a raw NUL additionally makes git '
      + 'treat the file as binary (no reviewable diff at all). Spell it as an escape instead; the '
      + 'string is identical:\n    ' + r.controlBytes.join('\n    '));
  }
  if (r.bom.length > 0) {
    problems.push('a UTF-8 BOM at the head of a text file is invisible in review and changes how '
      + 'a CSS or script consumer parses the first line:\n    ' + r.bom.join('\n    '));
  }
  if (r.undeclaredExtensions.length > 0) {
    problems.push('these extensions are tracked and undeclared in .gitattributes, so git gives '
      + 'them `diff: unspecified` and a control byte in one of them is invisible in review:\n    '
      + r.undeclaredExtensions.join('\n    '));
  }

  if (problems.length > 0) {
    console.error(`\n★ TRACKED BYTES GATE FAILED — tools/tracked-bytes-lint.mjs\n`);
    for (const p of problems) console.error('  ' + p + '\n');
    process.exit(1);
  }
  console.log(`✓ tracked bytes: ${r.files.length} file(s) — no CR, no control byte, no BOM, `
    + `every text extension declared (${r.declared.size} in .gitattributes)`);
}

if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1].split('\\').join('/')}`))
  .endsWith('tracked-bytes-lint.mjs')) {
  main();
}
