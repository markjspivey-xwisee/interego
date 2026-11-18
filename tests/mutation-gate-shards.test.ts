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
import { MUTANTS } from '../tools/mutation-gate.data.mjs';
import { parseShard, shardOf } from '../tools/mutation-gate.shard.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(resolve(REPO, '.github/workflows/mutation-gate.yml'), 'utf8');
const harness = readFileSync(resolve(REPO, 'tools/mutation-gate.mjs'), 'utf8');

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

  it('together the shards are the table: every mutant once, none twice, no shard empty', () => {
    const seen = new Map<string, number>();
    for (const s of named) {
      const part = shardOf(MUTANTS, parseShard(s));
      expect(part.length, `shard ${s} holds no mutant, so its runner verifies nothing`).toBeGreaterThan(0);
      for (const m of part) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);
    }
    // Names are how a mutant is counted here, so two mutants sharing one would hide a loss.
    expect(new Set(MUTANTS.map((m) => m.name)).size).toBe(MUTANTS.length);
    expect([...seen.keys()].sort()).toEqual(MUTANTS.map((m) => m.name).sort());
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
  });

  it('a shard that is not <index>/<count> is refused, not read as "no shard"', () => {
    for (const bad of ['', '0/5', '6/5', '5', 'a/b', '1/0', '-1/5', '1/5/2']) expect(() => parseShard(bad), bad).toThrow();
    expect(parseShard('2/5')).toEqual({ index: 2, count: 5 });
    // The harness exits on a shard it cannot parse and on one that holds no mutant.
    expect(harness).toContain("import { parseShard, shardOf } from './mutation-gate.shard.mjs';");
    expect(harness).toMatch(/if \(shard && pool\.length === 0\) \{[\s\S]{0,400}process\.exit\(1\);/);
  });
});
