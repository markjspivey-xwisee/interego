/**
 * Which mutants one shard of the mutation gate applies. Pure, and apart from the harness, because
 * tools/mutation-gate.mjs runs when it is imported and a test has to prove the cut without it.
 *
 * ── WHY THE GATE IS CUT AT ALL ───────────────────────────────────────────────
 *
 * The harness applies one defect, runs the gate that names it, restores the file, and moves on:
 * one mutant at a time, about half a minute each, because every vitest run pays the typecheck
 * globalSetup. With 55 mutants that was one job of 30.0 minutes (measured over 20 runs,
 * 2026-11-16 and 17), on every pull request, with no path filter. It is the longest check on a
 * pull request, so it is what the gated auto-merge waits for.
 *
 * Mutants are independent of one another: each run starts from the pristine tree. So the table is
 * dealt across runners and nothing about any one mutant changes: the same defect, the same gate,
 * the same three-state verdict. The gate's header argues against a `paths:` filter because its
 * subject is a relationship between files; a cut by POSITION narrows nothing. Every mutant still
 * runs on every pull request.
 *
 * ── DEALT BY POSITION, NOT BY NAME OR BY GATE ────────────────────────────────
 *
 * `index % count`. A mutant added to the table lands in a shard without anyone choosing one, and
 * neighbours in the table (which tend to share a gate file, so cost about the same) are spread
 * across shards instead of piled into one. tests/mutation-gate-shards.test.ts holds the cut exact:
 * the shards the workflow names must be 1/n … n/n once each, and together they must be the table.
 */

/** `"2/5"` → `{ index: 2, count: 5 }`, or throws: a shard nobody can name runs nothing. */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text));
  if (!m) throw new Error(`--shard=${text} is not <index>/<count> (for example 2/5)`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 1 || index < 1 || index > count) {
    throw new Error(`--shard=${text}: the index must be from 1 to the count`);
  }
  return { index, count };
}

/** The mutants shard `index` of `count` applies: every `count`-th, starting at `index` (1-based). */
export function shardOf(mutants, { index, count }) {
  return mutants.filter((_, i) => i % count === index - 1);
}
