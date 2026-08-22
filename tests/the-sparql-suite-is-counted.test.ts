/**
 * The W3C SHACL 1.2 SPARQL Extension suite is COUNTED, and the count is 44 of 44 —
 * 26 validation entries and 18 inference entries, with nothing left NOT RUN.
 *
 * ★ THIS GATE EXISTS BECAUSE THE NUMBER IS SMALL, NOT DESPITE IT. 44 approved entries were
 * vendored into `tests/fixtures/shacl12-w3c/sparql/` and read by nothing: the Core runner
 * scans `core/` and `node-expr/constraints/`, the node-expression runner recognises
 * `sht:EvalNodeExpr`, and neither sees this tree. Forty-four files of fixtures sitting in a
 * repo read as coverage to anyone browsing it, while asserting nothing at all.
 *
 * A vendored suite nobody runs is worse than no suite: it is a claim with no check behind it.
 * So the number goes on the record now, at whatever it is, and moves in one direction.
 *
 * ── HOW IT GOT FROM 1 TO 26 ──────────────────────────────────────────────────
 *
 * It opened at 1 of 26: `sh:sparql` was reported as an unsupported construct — honest, and
 * why `fullyChecked` exists — but an unsupported constraint produces no violation, so every
 * entry expecting `sh:conforms false` got `true`.
 *
 * A synchronous SELECT/ASK evaluator now runs them, including the four `sht:Failure` entries
 * where the required behaviour is to REFUSE: SHACL forbids MINUS, VALUES and SERVICE in a
 * constraint query, and forbids re-binding a pre-bound variable, because pre-binding into
 * them is undefined. Executing one anyway returns a plausible answer to a question the spec
 * says must not be asked.
 *
 * ★ AND THE COMPARISON IS THE WHOLE REPORT, ONE-TO-ONE, NOT THE VERDICT. It was verdict-only
 * until a MUTATION proved that too weak: defaulting a missing `sh:function` argument to `""`
 * instead of leaving it unbound stops `COALESCE($arg1, 'en')` reaching its default — it
 * changes what the function computes without changing whether the graph conforms, and 26 of
 * 26 stayed green with the bug installed.
 *
 * Every expected result now has to be matched on component, severity, value, path, message
 * and source shape, and each match CONSUMES one of ours, so a result we invent is a failure
 * too. Turning that on failed 14 of the 26 that had been passing, and each one was a real
 * defect: the constraint's own `sh:severity` ignored (new in 1.2), `sh:value` never
 * defaulting to the value node, `{?param}` message templates left raw, the containing node
 * shape reported instead of the property shape that fired, `$PATH` never substituted, and
 * `sh:sparqlExpr` evaluating to its own blank node. Underneath those were three plain SPARQL
 * bugs: a zero-length path that could not reach a term absent from the graph, an aggregate
 * over an empty group returning no row rather than zero, and MIN/MAX/AVG/SAMPLE/GROUP_CONCAT
 * parsed but computed as `NaN`.
 *
 * ★ THE UNIMPLEMENTED-FEATURE LEDGER IS EMPTY, AND EVERY ENTRY LEFT IT BY BEING BUILT.
 * It held three — SPARQL-based constraint components, user-defined `sh:function`, and
 * SPARQL-based targets. None was reclassified, excused, or quietly absorbed into a floor.
 * A ledger entries cannot leave is a list of excuses; one they can is a work plan, and the
 * only way to tell which you have is to watch one empty.
 *
 * ── AND THE 18 sht:Infer ENTRIES NOW RUN ─────────────────────────────────────
 *
 * They were carried for a long time as NOT RUN, each with its reason, because "we did not
 * attempt this" and "we attempted it and were wrong" are different facts and one number that
 * mixes them hides which is which. That is the right way to carry a gap and no substitute for
 * closing it: `sh:rule` is the inference half of SHACL, and an engine that only validates
 * implements half the vocabulary it advertises.
 *
 * `shacl-rules.ts` runs them — `sh:SPARQLRule` with a real CONSTRUCT, `sh:TripleRule` with
 * three node expressions, shape-bound and global rules, `sh:condition`, `sh:layer`,
 * `sh:order`, `sh:runOnce`, `sh:expectedPredicate` and `sh:tempTriple` — iterating each layer
 * to a fixpoint, because a transitive closure that reads its own output is the whole point and
 * running each rule once gives a plausible, incomplete answer with nothing to mark it as one.
 *
 * ★ THE COMPARISON IS AN ISOMORPHISM, NOT A STRING MATCH. Five expected reifiers labelled
 * `_:b1`.._:b5` are five correct blank nodes under any labels — but five reifiers all
 * pointing at the SAME triple are wrong, and only a bijection tells those apart.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(REPO, 'tools', 'shacl12-w3c', 'sparql.mjs');
const SUITE = join(REPO, 'tests', 'fixtures', 'shacl12-w3c', 'sparql');

/**
 * ★ THE RATCHET. Never lower it. It opened at 1 — which was not an embarrassment to hide
 * but the measurement that made every number after it mean something.
 */
const FLOOR = { validate: 26, infer: 18 };

interface Report {
  total: number;
  validate: number;
  infer: number;
  pass: number;
  passValidate: number;
  passInfer: number;
  fail: number;
  error: number;
  notRun: number;
  unapproved: number;
  failing: string[];
  notRunFiles: string[];
  unexplained: string[];
  features: string[];
}

const report: Report = JSON.parse(
  execFileSync(process.execPath, [RUNNER, '--json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));

function countTtl(dir: string): number {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += countTtl(p);
    else if (name.endsWith('.ttl')) n += 1;
  }
  return n;
}

describe('W3C SHACL 1.2 SPARQL Extensions', () => {
  it('reaches the entries by FOLLOWING mf:include, and reaches all of them', () => {
    // ★ Two bugs in the traversal both reported "0 entries", which is also what a runner
    // over an empty tree reports — so neither announced itself. mf:include is a REPEATED
    // predicate, not an rdf:List, and its values are paths into SUBDIRECTORIES.
    //
    // ★ AND FOLLOWING THE MANIFEST RATHER THAN GLOBBING IS LOAD-BEARING. rules/rdfs/rdfs1.ttl
    // is included by no manifest and declares its entry with the SAME relative IRI as a file
    // that IS included. A glob picks it up as a 45th entry and two files then claim one
    // identity. 44 reached, not 45, is the correct answer.
    expect(countTtl(SUITE)).toBeGreaterThanOrEqual(45);
    expect(report.total, 'the manifest traversal stopped finding entries').toBe(44);
    expect(report.validate).toBe(26);
    expect(report.infer).toBe(18);
  });

  it('never crashes on an entry — a crash is no answer at all', () => {
    expect(report.error, `engine threw on:\n  ${report.failing.join('\n  ')}`).toBe(0);
  });

  it(`passes all ${FLOOR.validate} of the sht:Validate entries, results and all`, () => {
    expect(report.passValidate, `failing:\n  ${report.failing.join('\n  ')}`)
      .toBeGreaterThanOrEqual(FLOOR.validate);
    // No known-divergence list any more: at 26 of 26 there is nothing left to excuse, so
    // a failure is a regression and has nowhere to hide.
    expect(report.fail).toBe(0);
  });

  it(`infers what ${FLOOR.infer} of the sht:Infer entries expect`, () => {
    // ★ A SEPARATE FLOOR, NOT A SHARE OF ONE. Validation and inference move for unrelated
    // reasons; a single total lets a regression in one hide behind progress in the other.
    expect(report.passInfer, `failing:\n  ${report.failing.join('\n  ')}`)
      .toBeGreaterThanOrEqual(FLOOR.infer);
  });

  it('and neither floor is stale', () => {
    // A ratchet nobody tightens is a floor sliding unnoticed.
    expect(report.passValidate - FLOOR.validate,
      `FLOOR.validate is ${FLOOR.validate} but the engine passes ${report.passValidate} — raise it`)
      .toBeLessThan(4);
    expect(report.passInfer - FLOOR.infer,
      `FLOOR.infer is ${FLOOR.infer} but the engine passes ${report.passInfer} — raise it`)
      .toBeLessThan(4);
  });

  it('fails only where the runner names the FEATURE that is missing', () => {
    // ★ The difference between a work plan and a number nobody reads. Every remaining
    // failure belongs to a named, described feature; a failure that does not is a
    // REGRESSION in something already built, and lands here rather than blending into a
    // count that was already non-zero.
    expect(report.unexplained,
      'a SPARQL entry fails with no recorded feature — either it is a regression, or record '
      + 'the feature in KNOWN_UNIMPLEMENTED').toEqual([]);
    expect(report.features.length,
      'the unimplemented-feature ledger is EMPTY - an entry appearing in it is a feature '
      + 'being un-built, not a gap being recorded').toBe(0);
  });

  it('records a REASON for every entry it did not run', () => {
    // An entry skipped with no reason is the one that quietly becomes permanent.
    expect(report.notRunFiles.length).toBe(report.notRun);
    expect(report.notRunFiles.every(r => r.includes(':')), report.notRunFiles.join('\n')).toBe(true);
  });
});
