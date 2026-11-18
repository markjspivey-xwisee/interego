/**
 * The mutation gate is cut across runners, and the cut loses no mutant.
 *
 * One job applied every mutant in turn: 30.0 minutes on average over 20 runs (2026-11-16 and 17),
 * the longest check on a pull request and so the one the gated auto-merge waits for.
 * mutation-gate.yml now runs the table as a matrix of `--shard=i/n`, and a matrix is a list: a
 * list fails silently. Drop `'3/5'` from it and a fifth of the gates are never made to fail,
 * with four green ticks beside the check's name. So this reads the workflow's own list and the
 * table and requires that the shards named are 1/n … n/n once each, that together they are the
 * table with nothing twice, and that none is empty.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShard, shardOf } from '../tools/mutation-gate.shard.mjs';

// ★ THE TABLE ITSELF IS NOT IMPORTED. tools/mutation-gate.data.mjs names files under
// applications/, so a test in tests/ that imports it reaches a vertical, and
// tests/the-base-runs-without-verticals.test.ts pins how many base tests may (the first version
// of this file was the 122nd against a pin of 121). The cut is by position, so it is proven
// here for a table of any size, and the one fact that needs the real table (no shard past its
// end, against the real table) is asserted beside the table, in
// tests/a-gate-arrives-with-a-mutant.test.ts. The harness is not read here either: it imports
// the table, so naming it is naming a tool that reaches a vertical.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(REPO, '.github/workflows/mutation-gate.yml'), 'utf8');

/** The matrix's shard list, as written: `shard: ['1/5', '2/5', …]`. */
function shardsInWorkflow(): string[] {
  const line = /^ {8}shard:\s*\[(.*)\]\s*$/m.exec(workflow)?.[1];
  if (line === undefined) return [];
  return line.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
}

describe('mutation gate: the shards the workflow runs are the whole table', () => {
  const named = shardsInWorkflow();

  it('the workflow names shards at all, and passes each to the harness', () => {
    expect(named.length).toBeGreaterThan(1);
    expect(workflow).toContain('npm run mutation-gate -- --shard=${{ matrix.shard }}');
    // A shard's red must not cancel the others: their mutants are not its mutants.
    expect(workflow).toMatch(/^ {6}fail-fast: false$/m);
  });

  it('names 1/n … n/n once each, for one n', () => {
    const parsed = named.map((s) => parseShard(s));
    const counts = new Set(parsed.map((s) => s.count));
    expect([...counts], 'every shard must be of the same count').toHaveLength(1);
    const n = parsed[0]!.count;
    expect(parsed.map((s) => s.index).sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it('together the shards are the table, whatever its size: every mutant once, none twice', () => {
    // From a table shorter than the shard count to one far longer than today's.
    for (const size of [named.length, named.length + 1, 55, 56, 57, 58, 59, 200]) {
      const table = Array.from({ length: size }, (_, i) => `mutant-${i}`);
      const seen = new Map<string, number>();
      for (const s of named) {
        const part = shardOf(table, parseShard(s));
        expect(part.length, `shard ${s} of a table of ${size} holds no mutant`).toBeGreaterThan(0);
        for (const m of part) seen.set(m, (seen.get(m) ?? 0) + 1);
      }
      expect([...seen.keys()].sort(), `a table of ${size}`).toEqual([...table].sort());
      expect([...seen.values()].every((count) => count === 1), `a table of ${size}`).toBe(true);
    }
    // And the shards are near the same size, so no runner is the long pole by construction.
    const sizes = named.map((s) => shardOf(Array.from({ length: 55 }), parseShard(s)).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it('a shard that is not <index>/<count> is refused, not read as "no shard"', () => {
    for (const bad of ['', '0/5', '6/5', '5', 'a/b', '1/0', '-1/5', '1/5/2']) expect(() => parseShard(bad), bad).toThrow();
    expect(parseShard('2/5')).toEqual({ index: 2, count: 5 });
  });
});
