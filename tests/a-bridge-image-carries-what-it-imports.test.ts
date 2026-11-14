/**
 * Every cross-vertical import a deployed bridge makes resolves to a file its image copies.
 *
 * ── WHY THIS IS NOT ALREADY COVERED ──────────────────────────────────────────
 *
 * `deploy/mcp-relay/tests/image-copies-every-source.test.ts` does this for the relay, and
 * its header says exactly why the relay was the urgent case and also why it is the LESS
 * dangerous one: the relay is tsc-compiled, so a source missing from the image is a BUILD
 * error that stops the deploy. Its words —
 *
 *   "A tsx-run service (every vertical bridge) would instead have started, served traffic,
 *    and thrown at the first request touching that import."
 *
 * Every vertical bridge runs under tsx. So the bridges have the worse failure mode and no
 * gate: the container boots, /health answers 200, the fleet audit reports it running the
 * right build, and one endpoint throws MODULE_NOT_FOUND the first time somebody calls it.
 *
 * ── WHY CROSS-VERTICAL IMPORTS SPECIFICALLY ──────────────────────────────────
 *
 * A bridge's own vertical is copied wholesale, so an import inside it cannot be missing. The
 * reachable-and-uncopied case is an import that LEAVES the directory — `../../<other>/src/x.js`
 * — because those are copied selectively: Dockerfile.foxxi-bridge copies all of
 * agentic-performance-practice, but only `src/` of learner-performer-companion and lrs-adapter.
 *
 * That selectivity is the trap. Checking it by eye, a `COPY applications/<name>/ ` pattern
 * reported both of those as NOT COPIED and produced a false report of a live production
 * defect — the pattern wanted a space where the real line has `/src/`. This resolves each
 * import path against the actual COPY prefixes instead of pattern-matching the Dockerfile.
 *
 * ── AND IMPORTS THAT LEAVE `applications/` ALTOGETHER, AND WHAT THOSE FILES IMPORT ───────────
 *
 * The coached-world bridge copies FILES, not directories, from two places outside itself: two
 * Foxxi sources and identity's `provisional-play.ts` (`../../../deploy/identity/…`). Both shapes
 * were invisible here: the import pattern stopped at `../../<vertical>/`, and a COPY of exactly
 * the imported file did not count as copying it. And a file copied alone brings its own imports
 * with it as obligations — `provisional-play.ts` imports `./hosted-terms.js`, which nothing in
 * the vertical names. So the walk follows every runtime import of a file reached from outside
 * the vertical, and each one has to be under a COPY too. `import type` is skipped: tsx erases it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The deployed bridges and the Dockerfile that builds each. */
const BRIDGES: readonly { vertical: string; dockerfile: string }[] = [
  { vertical: 'foxxi-content-intelligence', dockerfile: 'deploy/Dockerfile.foxxi-bridge' },
  { vertical: 'agentic-performance-practice', dockerfile: 'deploy/Dockerfile.agp-bridge' },
  { vertical: 'shared-workspace', dockerfile: 'deploy/Dockerfile.wsp-bridge' },
  { vertical: 'work-redesign', dockerfile: 'deploy/Dockerfile.wrd-bridge' },
  { vertical: 'practice-evidence', dockerfile: 'deploy/Dockerfile.pev-bridge' },
  { vertical: 'coached-world', dockerfile: 'deploy/Dockerfile.coached-world-bridge' },
];

/** COPY sources naming repo paths, normalised to directory prefixes. */
function copyPrefixes(dockerfile: string): string[] {
  const text = readFileSync(join(ROOT, dockerfile), 'utf8');
  return [...text.matchAll(/^COPY\s+(?:--\S+\s+)*(\S+)\s/gm)]
    .map(m => m[1] ?? '')
    .filter(p => ['applications/', 'packages/', 'docs/', 'deploy/', 'integrations/'].some(top => p.startsWith(top)));
}

/** Under a copied directory, or exactly a copied file. */
function isCopied(source: string, prefixes: readonly string[]): boolean {
  return prefixes.some(p => source === p || source.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/** The repo path of the TypeScript source a `.js` specifier names. */
const sourceOf = (path: string): string => path.replace(/\.js$/, '.ts');

/** Every `../../<other-vertical>/…` import made from this vertical's shipped source. */
function crossVerticalImports(vertical: string): string[] {
  const dirs = [`applications/${vertical}/src`, `applications/${vertical}/bridge`]
    .filter(d => existsSync(join(ROOT, d)));
  if (!dirs.length) return [];
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-hoE', String.raw`from '\.\./\.\./[a-z-]+/[^']+'`, '--', ...dirs],
      { cwd: ROOT, encoding: 'utf8' });
  } catch { return []; }
  return [...new Set(out.split('\n').filter(Boolean)
    .map(s => s.replace(/^from '\.\.\/\.\.\//, '').replace(/'$/, '')))];
}

/**
 * Every `../../../<top>/…` import made from this vertical's shipped source: one that leaves
 * `applications/` for another part of the repository. Returned as repo paths.
 */
function repoRootImports(vertical: string): string[] {
  const dirs = [`applications/${vertical}/src`, `applications/${vertical}/bridge`]
    .filter(d => existsSync(join(ROOT, d)));
  if (!dirs.length) return [];
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-hoE', String.raw`from '\.\./\.\./\.\./[a-z-]+/[^']+'`, '--', ...dirs],
      { cwd: ROOT, encoding: 'utf8' });
  } catch { return []; }
  return [...new Set(out.split('\n').filter(Boolean)
    .map(s => s.replace(/^from '\.\.\/\.\.\/\.\.\//, '').replace(/'$/, '')))];
}

/**
 * The runtime imports a source file makes of its neighbours, as repo paths, followed to the end.
 * Statements that begin `import type` or `export type` are left out: nothing loads them.
 */
function runtimeClosure(start: readonly string[]): string[] {
  const seen = new Set<string>();
  const todo = [...start];
  while (todo.length) {
    const file = todo.pop() as string;
    if (seen.has(file) || !existsSync(join(ROOT, file))) continue;
    seen.add(file);
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/^(?:import|export)\b(?!\s+type\b)[^;]*?\bfrom\s+'(\.{1,2}\/[^']+)'/gms)) {
      todo.push(sourceOf(join(dirname(file), m[1] ?? '').split('\\').join('/')));
    }
  }
  return [...seen].filter(f => !start.includes(f)).sort();
}

describe.each(BRIDGES.map(b => [b.vertical, b] as const))(
  '%s image carries what it imports', (vertical, bridge) => {
  it('has a Dockerfile with repo-path COPY lines', () => {
    expect(existsSync(join(ROOT, bridge.dockerfile)), `${bridge.dockerfile} is missing`).toBe(true);
    expect(copyPrefixes(bridge.dockerfile).length).toBeGreaterThan(0);
  });

  it('every cross-vertical import resolves to a copied file', () => {
    const prefixes = copyPrefixes(bridge.dockerfile);
    const missing: string[] = [];
    for (const rel of crossVerticalImports(vertical)) {
      const source = `applications/${rel.replace(/\.js$/, '.ts')}`;
      // The file must EXIST in the tree and fall under a COPY. An import of something that
      // is not there at all is a different bug, and this must not report it as copied.
      const onDisk = existsSync(join(ROOT, source));
      const copied = isCopied(source, prefixes);
      if (!onDisk || !copied) missing.push(`${source} (onDisk=${onDisk}, copied=${copied})`);
    }
    // The same question for an import that leaves `applications/`.
    for (const rel of repoRootImports(vertical)) {
      const source = sourceOf(rel);
      const onDisk = existsSync(join(ROOT, source));
      const copied = isCopied(source, prefixes);
      if (!onDisk || !copied) missing.push(`${source} (onDisk=${onDisk}, copied=${copied})`);
    }
    expect(
      missing,
      `${vertical} imports these from another vertical, and ${bridge.dockerfile} does not put `
        + `them in the image. Under tsx the container BOOTS and throws at the first request `
        + `that reaches the import: ${missing.join('; ')}`,
    ).toEqual([]);
  });

  it('and so does everything those files import in turn', () => {
    const prefixes = copyPrefixes(bridge.dockerfile);
    const outside = [
      ...crossVerticalImports(vertical).map(rel => sourceOf(`applications/${rel}`)),
      ...repoRootImports(vertical).map(sourceOf),
    ];
    const missing = runtimeClosure(outside).filter(source => !isCopied(source, prefixes));
    expect(
      missing,
      `${vertical} imports files from outside its own directory, and these are what THEY import `
        + `at run time. ${bridge.dockerfile} copies none of them, so the import that reaches `
        + `them throws: ${missing.join('; ')}`,
    ).toEqual([]);
  });
});

describe('the checks above can fail', () => {
  it('a COPY of exactly the imported file counts, and a COPY of its neighbour does not', () => {
    expect(isCopied('deploy/identity/provisional-play.ts', ['deploy/identity/provisional-play.ts'])).toBe(true);
    expect(isCopied('deploy/identity/provisional-play.ts', ['deploy/identity/package.json'])).toBe(false);
    expect(isCopied('deploy/identity/provisional-play.ts', ['deploy/identity/'])).toBe(true);
    expect(isCopied('deploy/identity-extra/x.ts', ['deploy/identity'])).toBe(false);
  });

  it('the coached-world bridge really does reach outside applications/, and through a file it never names', () => {
    // If these stop being true the two loops above pass by finding nothing.
    expect(repoRootImports('coached-world')).toContain('deploy/identity/provisional-play.js');
    expect(crossVerticalImports('coached-world')).toContain('foxxi-content-intelligence/src/play-grant.js');
    expect(runtimeClosure(['deploy/identity/provisional-play.ts'])).toContain('deploy/identity/hosted-terms.ts');
    // A type-only import is not followed.
    expect(runtimeClosure(['applications/coached-world/src/lrs.ts'])).toEqual(['applications/coached-world/src/bounded.ts']);
  });
});
