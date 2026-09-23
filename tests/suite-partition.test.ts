/**
 * bridge-typecheck.yml runs the whole root suite as parts on separate runners: the slowest
 * modules named on some, everything else on the complement parts via `--exclude` — and the
 * complement itself in `--shard`s. That is a list, and a list fails silently — a module named
 * on neither side, or on the exclude side only, or a shard nobody runs, would simply never run,
 * green. So every cut is checked: the named modules and the excluded modules are the same set,
 * every one of them exists, every complement part excludes the same set, and their shards are
 * exactly 1/n … n/n, once each.
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

  it('has at least one complement part and at least one named part', () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(complement.length).toBeGreaterThanOrEqual(1);
    expect(named.length).toBeGreaterThanOrEqual(1);
  });

  /** A complement part's excludes (sorted) and its shard, if any; anything else on the line is refused. */
  const readComplement = (p: string) => {
    const excluded = [...p.matchAll(/--exclude\s+(\S+)/g)].map((m) => m[1] ?? '').sort();
    const shard = /--shard=(\d+)\/(\d+)/.exec(p);
    const tokens = p.split(/\s+/).filter(Boolean).length;
    expect(tokens, `the complement part carries only --exclude <module> pairs and at most one --shard: ${p}`).toBe(excluded.length * 2 + (shard ? 1 : 0));
    return { excluded, shard: shard ? { index: Number(shard[1]), count: Number(shard[2]) } : undefined };
  };

  it('★ excludes exactly the modules the named parts run — a module on one side only would never run, green', () => {
    const run = named.flatMap((p) => p.split(/\s+/).filter(Boolean)).sort();
    for (const p of complement) expect(readComplement(p).excluded).toEqual(run);
    expect(new Set(run).size, 'no module is named twice').toBe(run.length);
  });

  it('★ the complement parts are one whole: the same excludes, and shards 1/n … n/n once each, or a single unsharded part', () => {
    const shards = complement.map((p) => readComplement(p).shard);
    if (complement.length === 1 && shards[0] === undefined) return;
    const counts = new Set(shards.map((s) => s?.count));
    expect(counts.size, 'every complement part names the same shard count').toBe(1);
    const n = [...counts][0];
    expect(n, 'the shard count is the number of complement parts').toBe(complement.length);
    expect(shards.map((s) => s?.index).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: complement.length }, (_, i) => i + 1));
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
