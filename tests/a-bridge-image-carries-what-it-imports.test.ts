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
];

/** COPY sources naming repo paths, normalised to directory prefixes. */
function copyPrefixes(dockerfile: string): string[] {
  const text = readFileSync(join(ROOT, dockerfile), 'utf8');
  return [...text.matchAll(/^COPY\s+(?:--\S+\s+)*(\S+)\s/gm)]
    .map(m => m[1] ?? '')
    .filter(p => p.startsWith('applications/') || p.startsWith('packages/') || p.startsWith('docs/'));
}

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
      const copied = prefixes.some(p => source.startsWith(p.endsWith('/') ? p : `${p}/`));
      if (!onDisk || !copied) missing.push(`${source} (onDisk=${onDisk}, copied=${copied})`);
    }
    expect(
      missing,
      `${vertical} imports these from another vertical, and ${bridge.dockerfile} does not put `
        + `them in the image. Under tsx the container BOOTS and throws at the first request `
        + `that reaches the import: ${missing.join('; ')}`,
    ).toEqual([]);
  });
});
