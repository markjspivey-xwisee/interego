/**
 * Every file vitest collects is actually a vitest suite.
 *
 * ★ WHY. Three standalone tsx assertion scripts — `ok()` / `failures` /
 * `process.exit(1)`, run by `bridge-typecheck.yml` via `npx tsx` — were named
 * `*.test.ts` and sat under `applications/**\/tests/`, which vitest globs. Vitest
 * collected them, found no `describe`/`it`, and reported:
 *
 *     Error: No test suite found in file …/credential-issuer-binding.test.ts
 *
 * So `npx vitest run` had been exiting non-zero for three files that were not broken and
 * not even vitest's to run. A suite that is permanently red for reasons nobody intends is
 * worse than a smaller green one: it trains everyone to read "3 failed" as normal, which
 * is exactly how a genuinely stale assertion (the Azure CORS hostnames) sat unnoticed
 * beside them.
 *
 * They now live in `checks/` as `*.check.ts`, outside the glob. This keeps them out.
 *
 * A `process.exit(1)` inside a vitest worker is the sharper version of the same hazard:
 * it would tear down the runner mid-suite rather than fail one test.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The directories vitest.config.ts actually collects from. */
const COLLECTED_ROOTS = ['tests', 'applications', 'integrations', 'mcp-server'];
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'scratchpad']);

function collectedTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.test.ts')) continue;
      // Mirror the config's globs: root `tests/`, and `**/tests/**` elsewhere.
      const rel = relative(REPO, p).replace(/\\/g, '/');
      const inRootTests = rel.startsWith('tests/');
      const inNestedTests = /(^|\/)tests\//.test(rel);
      if (inRootTests || inNestedTests) out.push(p);
    }
  };
  for (const root of COLLECTED_ROOTS) {
    const abs = join(REPO, root);
    try { if (statSync(abs).isDirectory()) walk(abs); } catch { /* absent */ }
  }
  return out;
}

describe('files vitest collects are vitest suites', () => {
  const files = collectedTestFiles();

  it('finds a non-trivial number of collected test files', () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(50);
  });

  it('every collected *.test.ts declares a suite', () => {
    const offenders = files.filter(p => {
      const src = readFileSync(p, 'utf8');
      const importsVitest = /from ['"]vitest['"]/.test(src);
      const declaresSuite = /^\s*(describe|it|test)\s*[.(]/m.test(src);
      return !(importsVitest && declaresSuite);
    }).map(p => relative(REPO, p).replace(/\\/g, '/'));

    expect(offenders, offenders.length
      ? `not vitest suites — rename to *.check.ts outside a tests/ dir:\n  ${offenders.join('\n  ')}`
      : '').toEqual([]);
  });

  it('no collected test calls process.exit, which would kill the runner', () => {
    const offenders = files.filter(p => {
      // This file states the pattern in order to search for it, so it always matches
      // itself. A guard that fails on its own definition gets deleted rather than heeded.
      if (p.endsWith('test-files-are-runnable.test.ts')) return false;
      const src = readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return /process\.exit\s*\(/.test(src);
    }).map(p => relative(REPO, p).replace(/\\/g, '/'));

    expect(offenders, offenders.length
      ? `process.exit() inside a vitest worker tears down the run:\n  ${offenders.join('\n  ')}`
      : '').toEqual([]);
  });
});
