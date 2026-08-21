/**
 * The W3C SHACL 1.2 node-expression tests run in CI, at 67 of 67.
 *
 * ★ WHAT THIS IS 67 OF, SAID BEFORE THE NUMBER CAN MISLEAD. The upstream area has 106
 * entries in 29 files. SEVENTY-SIX of those entries live under `shnex-sparql/` and evaluate
 * a SPARQL expression; SHACL-SPARQL is a separate specification and a SPARQL engine is a
 * different project. They are NOT vendored and NOT counted. 67 is every approved entry in
 * the 29 SPARQL-free files, and this file says so rather than reporting a fraction whose
 * denominator has been quietly chosen.
 *
 * ★ WHY THE SUB-LANGUAGE WAS WORTH IMPLEMENTING RATHER THAN RECORDING AS A GAP. It started
 * as one line on the Core suite's known-divergence ledger — `node/nodeByExpression-001`,
 * "needs the node-expression sub-language". Writing the reason down instead of the symptom
 * is what turned it into a task with a visible size: about twenty operators, none of them
 * hard, all of them measurable against an oracle. The ledger is now one entry shorter, which
 * is the only thing that makes a divergence ledger different from a list of excuses.
 *
 * ★ AND THE ORDER MATTERS, WHICH IS EASY TO GET WRONG. Everywhere else this engine speaks in
 * SETS — §2.3 value nodes are a set, evaluatePath deduplicates. Node expressions are
 * SEQUENCES, and `shnex:limit`, `shnex:offset`, `shnex:orderBy` and `shnex:findFirst` are
 * all statements about position. A harness comparing sets would pass an implementation that
 * ignored every one of them, so the comparison below is ordered except where the suite
 * itself marks `sht:ignoreOrder`.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseTrig, evaluateExpression, evaluateNodeExpression } from '@interego/core';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(REPO, 'tools', 'shacl12-w3c', 'node-expr.mjs');
const SUITE = join(REPO, 'tests', 'fixtures', 'shacl12-w3c', 'node-expr');

interface Report {
  total: number;
  pass: number;
  fail: number;
  error: number;
  unapproved: number;
  failing: string[];
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

describe('W3C SHACL 1.2 node expressions', () => {
  it('the vendored files and the entries in them are both there', () => {
    // Guards the guard: an empty fixture tree reports a clean sweep of nothing, and so does
    // a runner that stopped recognising sht:EvalNodeExpr.
    expect(countTtl(SUITE)).toBeGreaterThanOrEqual(29);
    expect(report.total - report.unapproved).toBeGreaterThanOrEqual(65);
  });

  it('passes every approved entry', () => {
    expect(report.failing, 'node-expression entries failing:\n  ' + report.failing.join('\n  '))
      .toEqual([]);
    expect(report.error).toBe(0);
    expect(report.pass).toBe(report.total - report.unapproved);
  });
});

describe('the distinctions the suite exists to enforce', () => {
  // Pinned by name so a regression says WHAT broke. Each of these was wrong on the first
  // pass, and each is a place where two things that look identical in Turtle are not.
  const evalExpr = (ttl: string): readonly unknown[] => {
    const d = parseTrig(`@prefix shnex: <http://www.w3.org/ns/shacl-node-expr#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix ex: <https://example.org/> .
ex:probe ex:expr ${ttl} .
`);
    const subj = d.subjects.find(s => s.subject === 'https://example.org/probe');
    const expr = subj!.properties.get('https://example.org/expr' as never)![0];
    return evaluateExpression(d, expr);
  };

  it('[] is the empty sequence but () is a sequence of one — rdf:nil is a term', () => {
    // ★ The trap. Collapsing "the empty list" and "the empty expression" gets one of them
    // wrong whichever way you choose: `shnex:count []` is 0 and `shnex:count ()` is 1.
    expect(evalExpr('[ ]')).toHaveLength(0);
    expect(evalExpr('( )')).toHaveLength(1);
    expect(evalExpr('( 1 2 3 )')).toHaveLength(3);
  });

  it('a shape-valued operator takes its argument UNEVALUATED', () => {
    // `[ sh:minInclusive 3 ]` is a blank node whether it is a shape or an expression, and
    // evaluated as an expression it comes back as itself — so shnex:findFirst returned the
    // shape node rather than the first conforming input.
    const out = evalExpr('[ shnex:findFirst [ sh:minInclusive 3 ] ; shnex:nodes ( 2 1 4 3 5 ) ]');
    expect(out).toHaveLength(1);
    expect((out[0] as { value: string }).value).toBe('4');
  });

  it('orderBy puts a node with NO sort key first, rather than leaving it in place', () => {
    // Returning 0 for a missing key means "equivalent", which leaves the node wherever the
    // input happened to put it — so the same data in a different document order sorts
    // differently. That is not an ordering.
    //
    // The expression and the data are ONE document on purpose: a node expression is
    // evaluated against a graph, and splitting them is how the first version of this test
    // asserted an ordering over a graph that had nothing in it.
    const d = parseTrig(`@prefix shnex: <http://www.w3.org/ns/shacl-node-expr#> .
@prefix ex: <https://example.org/> .
ex:a ex:n 3 . ex:b ex:n 1 . ex:c ex:other 9 .
ex:q ex:e [ shnex:nodes ( ex:a ex:b ex:c ) ; shnex:orderBy [ shnex:pathValues ex:n ] ] .
`);
    const expr = d.subjects.find(x => x.subject === 'https://example.org/q')!
      .properties.get('https://example.org/e' as never)![0];
    const out = evaluateExpression(d, expr);
    expect(out.map(t => (t as { iri: string }).iri)).toEqual([
      'https://example.org/c', 'https://example.org/b', 'https://example.org/a',
    ]);
  });

  it('the bare evaluator answers NOTHING for shape operators, which is why the wrapper exists', () => {
    // ★ Pins the reason evaluateExpression is not a convenience. The shape-valued operators
    // need a conformance check, node-expression.ts cannot import the validator without a
    // cycle, so the check is injected — and a caller reaching past the wrapper gets five
    // operators that silently return the empty sequence.
    const d = parseTrig(`@prefix shnex: <http://www.w3.org/ns/shacl-node-expr#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <https://example.org/> .
ex:q ex:e [ shnex:findFirst [ sh:minInclusive 3 ] ; shnex:nodes ( 2 4 ) ] .
`);
    const expr = d.subjects.find(s => s.subject === 'https://example.org/q')!
      .properties.get('https://example.org/e' as never)![0];
    expect(evaluateNodeExpression(d, expr)).toHaveLength(0);
    expect(evaluateExpression(d, expr)).toHaveLength(1);
  });
});
