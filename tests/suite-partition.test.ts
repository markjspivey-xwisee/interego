/**
 * bridge-typecheck.yml runs the whole root suite as two parts on two runners: the slowest
 * modules named on one, everything else on the other via `--exclude`. That is a list, and a
 * list fails silently — a module named on neither side, or on the exclude side only, would
 * simply never run, green. So the cut is checked: the named modules and the excluded modules
 * are the same set, every one of them exists, and exactly one part is the complement.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const workflow = readFileSync(`${ROOT}.github/workflows/bridge-typecheck.yml`, 'utf8');

/** The `files:` value of every matrix part, in order. */
function parts(yaml: string): string[] {
  return [...yaml.matchAll(/^\s+files:\s*(.+?)\s*$/gm)].map((m) => m[1] ?? '');
}

describe('the suite is cut exactly once, and nothing falls between the parts', () => {
  const all = parts(workflow);
  const complement = all.filter((p) => p.includes('--exclude'));
  const named = all.filter((p) => !p.includes('--exclude'));

  it('has one complement part and at least one named part', () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(complement).toHaveLength(1);
    expect(named.length).toBeGreaterThanOrEqual(1);
  });

  it('★ excludes exactly the modules the named parts run — a module on one side only would never run, green', () => {
    const excluded = [...(complement[0] ?? '').matchAll(/--exclude\s+(\S+)/g)].map((m) => m[1] ?? '').sort();
    const tokens = (complement[0] ?? '').split(/\s+/).filter(Boolean);
    expect(tokens.length, 'the complement part carries only --exclude <module> pairs').toBe(excluded.length * 2);
    const run = named.flatMap((p) => p.split(/\s+/).filter(Boolean)).sort();
    expect(run).toEqual(excluded);
    expect(new Set(run).size, 'no module is named twice').toBe(run.length);
  });

  it('names modules that exist, under a root vitest.config.ts collects from', () => {
    for (const p of named) for (const file of p.split(/\s+/).filter(Boolean)) {
      expect(existsSync(`${ROOT}${file}`), `${file} is named in the partition and does not exist`).toBe(true);
      expect(file).toMatch(/\.test\.ts$/);
    }
  });

  it('runs every part through the same command, so an exclusion is never also an inclusion list', () => {
    expect(workflow).toContain('run: npx vitest run ${{ matrix.part.files }}');
    expect(workflow, 'the old single whole-suite step would double-run the parts').not.toMatch(/run: npx vitest run\s*$/m);
  });
});
