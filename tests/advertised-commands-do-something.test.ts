/**
 * A command a document tells you to run must actually check something.
 *
 * ── THE FALSE GREEN THIS EXISTS FOR ─────────────────────────────────────────
 *
 * STATUS.md's "Test + validation hygiene" section advertised
 *
 *     npx tsc -p tsconfig.json --noEmit   — currently clean across the repo + each sub-project
 *
 * and that command compiles NOTHING. The root `tsconfig.json` is `{"files": [], "references":
 * [...]}`; without `--build`, project references contribute no files, so the program is empty
 * and `tsc` exits 0 having read nothing. Measured: `--listFilesOnly` printed 0 lines for it and
 * 1,514 for `tsconfig.check.json`. Neither sub-project the sentence named — `mcp-server`,
 * `deploy/identity` — was in the references list at all.
 *
 * A maintainer who runs the advertised command before pushing gets a green tick over an empty
 * program. That is the exact pre-push false green `tsconfig.check.json`'s own header says took
 * this tree red, being handed out by the document that tells people how to check their work.
 *
 * `tools/docs-claim-lint.mjs` verifies that LINKS in these documents resolve. Nothing verified
 * that the COMMANDS do anything, which is a different question about the same files.
 *
 * ── WHY IT READS tsconfig RATHER THAN RUNNING tsc ───────────────────────────
 *
 * Running `tsc --listFilesOnly` per advertised config would add ~10s to every suite run for a
 * property that is decidable from the config itself: a program is empty when it names no
 * `files`, no `include`, and inherits neither. That is what made the root config vacuous, and
 * it is what this reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `tsc -p <config>` this document tells a reader to run. */
function advertisedTsconfigs(doc: string): string[] {
  const text = readFileSync(join(ROOT, doc), 'utf8');
  const out = new Set<string>();
  // ★ ONLY A BOLD-CODE SPAN. These documents use `- **`command`**` to mean RUN THIS, and a
  // plain backtick span to MENTION a command — including, in STATUS.md, the vacuous one this
  // gate exists for, quoted inside its own correction. Matching every mention made the gate
  // fail on the sentence explaining the defect: a permanent false positive, which is how a
  // gate gets deleted instead of heeded.
  for (const m of text.matchAll(/\*\*`([^`]*)`\*\*/g)) {
    const cmd = m[1] ?? '';
    if (!/\btsc\b/.test(cmd)) continue;
    const cfg = /-p\s+([A-Za-z0-9._/-]+\.json)/.exec(cmd);
    if (cfg?.[1]) out.add(cfg[1]);
  }
  return [...out];
}

/** JSON with comments — these configs carry them, and JSON.parse does not. */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Does this config name any input at all, following `extends`?
 *
 * `files: []` with only `references` is the empty program that started this. A config that
 * inherits `include` from a parent is fine, so `extends` is followed rather than assumed.
 */
function namesInputs(configPath: string, seen = new Set<string>()): boolean {
  if (seen.has(configPath) || !existsSync(configPath)) return false;
  seen.add(configPath);
  const cfg = readJsonc(configPath);
  const files = cfg['files'];
  const include = cfg['include'];
  if (Array.isArray(files) && files.length > 0) return true;
  if (Array.isArray(include) && include.length > 0) return true;
  const ext = cfg['extends'];
  if (typeof ext === 'string') {
    return namesInputs(join(dirname(configPath), ext.endsWith('.json') ? ext : `${ext}.json`), seen);
  }
  return false;
}

describe('a command a document tells you to run checks something', () => {
  const DOCS = ['STATUS.md', 'README.md', 'CLAUDE.md'];

  it('finds the advertised typecheck commands at all', () => {
    // Guards the guard: a regex that stopped matching would pass every assertion below
    // vacuously — the same failure shape as the empty program it is looking for.
    const all = DOCS.flatMap(advertisedTsconfigs);
    expect(all.length, `no \`tsc -p <config>\` found in ${DOCS.join(', ')} — the scan is broken`)
      .toBeGreaterThan(0);
  });

  it('★ every advertised `tsc -p <config>` compiles a non-empty program', () => {
    const vacuous: string[] = [];
    for (const doc of DOCS) {
      for (const cfg of advertisedTsconfigs(doc)) {
        const abs = join(ROOT, cfg);
        if (!existsSync(abs)) { vacuous.push(`${doc} → ${cfg} (does not exist)`); continue; }
        if (!namesInputs(abs)) vacuous.push(`${doc} → ${cfg} (names no files and no include)`);
      }
    }
    expect(
      vacuous,
      'these documents tell a reader to run a typecheck over an EMPTY program, which exits 0 '
        + 'having read nothing and is indistinguishable from a clean tree:\n  '
        + vacuous.join('\n  '),
    ).toEqual([]);
  });
});
