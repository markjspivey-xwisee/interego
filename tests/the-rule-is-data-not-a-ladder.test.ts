/**
 * A JUDGEMENT RULE THAT DECIDES CREDENTIALS WAS AN `if` LADDER PUBLISHING ITS OWN DESCRIPTION.
 *
 * `evaluateProficiency` was three lines of thresholds in TypeScript, beside a hand-maintained prose
 * constant claiming what those lines did. Two sources for one fact, nothing keeping them in step,
 * and — verified before this change — ZERO references to `evaluateProficiency`, `wilsonLower`,
 * `proficiencyRank` or the rule text anywhere in the test tree.
 *
 * This project's stated position is a general engine reading published rule DATA, never `if (x)`.
 * The rule now lives in `docs/ns/adl-tla-proficiency.ttl`, is parsed at runtime, and the published
 * sentence is generated from the same triples the evaluator walks.
 *
 * ── ★★ AND THE LADDER WAS WRONG, WHICH NO TEST WOULD HAVE CAUGHT ────────────────────────────
 *
 * Measured against the shipped function, mean quality 0.89 throughout:
 *
 *     5 executions, 5 successes  ->  rank 3 Competent,  confidence 0.566
 *     6 executions, 6 successes  ->  rank 4 Proficient, confidence 0.610
 *     6 executions, 5 successes  ->  rank 4 Proficient, confidence 0.436   <-- FAILING PROMOTED YOU
 *     12 executions, no quality  ->  rank 5 EXPERT                          <-- on volume alone
 *
 * n was counted twice: as the sample-size term inside the Wilson bound, and again as a bare
 * `executions >=` gate. So rank and confidence — two outputs of one function — moved in OPPOSITE
 * directions on the same new evidence.
 *
 * Found by perturbing an input nobody had perturbed, after a delegate reported the transition from
 * the outside with no access to the source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateProficiency,
  parseProficiencyBands,
  loadProficiencyRuleTurtle,
  performanceProficiencyBands,
  perfRollupRuleText,
} from '../applications/foxxi-content-intelligence/src/ler-tla-vocab.js';

const RULE_TTL = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'ns', 'adl-tla-proficiency.ttl');
const perf = (executions: number, successes: number, avgQuality?: number): ReturnType<typeof evaluateProficiency> =>
  evaluateProficiency({ basis: 'performance', executions, successes, ...(avgQuality !== undefined ? { avgQuality } : {}) });

describe('★★ the defect: a failure must not promote you', () => {
  it('six executions with one FAILURE ranks BELOW six successes', () => {
    const allGood = perf(6, 6, 0.89);
    const oneFailed = perf(6, 5, 0.89);
    expect(allGood.rank).toBe(4);
    expect(oneFailed.rank, 'adding a failed record used to promote to rank 4').toBe(3);
    expect(oneFailed.rank).toBeLessThan(allGood.rank);
  });

  it('★ rank and confidence move in the SAME direction on the same evidence', () => {
    // The structural statement of the bug: they used to diverge. Rank must never rise while the
    // confidence attached to that rank falls.
    const before = perf(5, 5, 0.89);
    const worse = perf(6, 5, 0.89);
    expect(worse.confidence).toBeLessThan(before.confidence);
    expect(worse.rank, 'confidence fell, so rank must not rise').toBeLessThanOrEqual(before.rank);
  });

  it('and an honest track record is untouched — every previous transition holds', () => {
    // The thresholds were chosen to preserve these exactly, so nobody is demoted for succeeding.
    expect(perf(3, 3, 0.9).rank, '3/3 promotes to Competent as before').toBe(3);
    expect(perf(6, 6, 0.9).rank, '6/6 promotes to Proficient as before').toBe(4);
    expect(perf(12, 12, 0.9).rank, '12/12 promotes to Expert as before').toBe(5);
    expect(perf(2, 2, 0.9).rank, 'two successes is still Advanced Beginner').toBe(2);
  });

  it('★ and a quality band cannot be won with no quality recorded', () => {
    // Twelve entirely unscored executions used to reach EXPERT, whose published definition speaks
    // of "high-quality production performance".
    expect(perf(12, 12).rank, 'no quality recorded at all').toBe(3);
    expect(perf(6, 6).rank).toBe(3);
    expect(perf(12, 12, 0.9).rank, 'with quality, Expert is still reachable').toBe(5);
  });
});

describe('★★★ the rule is DATA — the engine reads a graph it does not embody', () => {
  it('the bands come from docs/ns/adl-tla-proficiency.ttl, parsed at runtime', () => {
    const bands = parseProficiencyBands(loadProficiencyRuleTurtle());
    expect(bands.map((b) => b.name)).toEqual(['Expert', 'Proficient', 'Competent']);
    expect(bands[0]?.minReliability).toBe(0.75);
    expect(bands[1]?.requiresQuality).toBe(true);
    expect(bands[2]?.minQuality, 'Competent asks nothing of quality').toBeUndefined();
  });

  it('★ CHANGING ONLY THE GRAPH CHANGES THE JUDGEMENT — no code edit', () => {
    // This is the whole claim, and the only way to demonstrate it is to do it. If this ever fails,
    // the rule has quietly moved back into the source.
    const original = readFileSync(RULE_TTL, 'utf8');
    // ★ NOTHING IS WRITTEN TO DISK, AND THAT IS DELIBERATE. This used to read the file, write a
    // MUTATED copy over it, assert, and restore in a `finally`. The mutation moved in-memory long
    // ago — `stricter` is only ever parsed as a string — but the restoring write stayed behind,
    // rewriting a TRACKED file with its own identical content on every run. It restored a change
    // that no longer happens.
    //
    // Removing it is right under the current single-fork pool, where it was merely pointless I/O
    // on a file more than ten other modules read. It matters more if file parallelism is ever
    // enabled (measured, and parked on wip/parallel-test-pool): a whole-file write is not atomic,
    // so a concurrent reader could catch the truncated window.
    //
    // ★ SCOPE OF WHAT WAS CHECKED, because the first version of this note overstated it. A scan
    // for writeFileSync/mkdirSync/renameSync/appendFileSync found 7 writers and called this the
    // ONLY one touching a path another test reads. A widened scan found 11 — the first missed
    // modules whose only removal verb is unlinkSync — and NO source-level scan can see through
    // the 20 modules that spawn a child process, one of which reaches a tracked file via
    // tools/build-workspace-artifact.mjs (safe only because its --check branch exits first).
    // So: this was the only in-repo write THAT SCAN COULD SEE. Treat that as the claim.
    // The demonstration is unchanged — a different graph still yields a different judgement.
    expect(parseProficiencyBands(original).find((b) => b.name === 'Proficient')?.minReliability).toBe(0.60);
    const stricter = original.replace(
      'tla:awardsLevel tla:LevelProficient ;\n    tla:minReliability "0.60"^^xsd:decimal ;',
      'tla:awardsLevel tla:LevelProficient ;\n    tla:minReliability "0.90"^^xsd:decimal ;',
    );
    expect(stricter, 'the substitution must actually apply').not.toBe(original);
    const bands = parseProficiencyBands(stricter);
    expect(bands.find((b) => b.name === 'Proficient')?.minReliability).toBe(0.90);
  });

  it('the published sentence is GENERATED from those triples, so it cannot drift', () => {
    const text = perfRollupRuleText();
    for (const b of performanceProficiencyBands()) {
      expect(text, `${b.name}'s threshold must appear in the published text`)
        .toContain(String(b.minReliability));
    }
    expect(text, 'the floor-not-a-scale limitation must be stated').toMatch(/FLOOR, not a scale/);
    expect(text, 'and the reader must be told where the rule lives').toContain('adl-tla-proficiency.ttl');
  });

  it('★ and it REFUSES to rank rather than fall back to a hidden ladder', () => {
    // A silent built-in fallback would restore exactly what this removes: a rule in force that
    // nobody can see. Every silent fallback in this system has cost a defect that survived because
    // the caller got a plausible answer.
    expect(() => parseProficiencyBands('@prefix tla: <x:> .\n')).not.toThrow();
    expect(parseProficiencyBands('@prefix tla: <x:> .\n')).toEqual([]);
    const src = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      '..', 'applications', 'foxxi-content-intelligence', 'src', 'ler-tla-vocab.ts',
    ), 'utf8');
    expect(src).toMatch(/Refusing to rank rather than fall back/);
  });

  it('and no `if` ladder over raw execution counts survives in the evaluator', () => {
    const src = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      '..', 'applications', 'foxxi-content-intelligence', 'src', 'ler-tla-vocab.ts',
    ), 'utf8');
    const at = src.indexOf('export function evaluateProficiency');
    const fn = src.slice(at, src.indexOf('\n}\n', at) + 3);
    expect(fn, 'the rank must not be gated on a raw execution count').not.toMatch(/executions >= ?\d/);
    expect(fn, 'it must walk the parsed bands').toMatch(/performanceProficiencyBands\(\)/);
  });
});
