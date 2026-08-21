/**
 * The W3C SHACL 1.2 SPARQL Extension suite is COUNTED, and the count is currently 1 of 26.
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
 * ── WHAT THE 1 AND THE 25 ARE ────────────────────────────────────────────────
 *
 * `sh:sparql` is not implemented. The engine reports it as an unsupported construct — which
 * is the honest behaviour and is why `fullyChecked` exists — but an unsupported constraint
 * produces no violation, so an entry expecting `sh:conforms false` gets `true`. Those are
 * the 25. Five of the 26 additionally expect validation to ABORT (`sht:Failure`): SHACL
 * requires an implementation to REFUSE a query whose pre-binding it cannot honour, rather
 * than execute it and return a plausible answer.
 *
 * The 18 `sht:Infer` entries are recorded as NOT RUN with their reason rather than as
 * failures. "We did not attempt this" and "we attempted it and were wrong" are different
 * facts, and one number that mixes them hides which is which.
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
 * ★ THE RATCHET. Raise as the engine improves; never lower it. A floor of 1 is not an
 * embarrassment to be hidden — it is the measurement that makes the next commit's number
 * mean something.
 */
const FLOOR = { pass: 1 };

interface Report {
  total: number;
  validate: number;
  infer: number;
  pass: number;
  fail: number;
  error: number;
  notRun: number;
  unapproved: number;
  failing: string[];
  notRunFiles: string[];
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

  it(`passes at least ${FLOOR.pass} of the 26 sht:Validate entries`, () => {
    expect(report.pass, 'failing:\n  ' + report.failing.join('\n  '))
      .toBeGreaterThanOrEqual(FLOOR.pass);
  });

  it('and the floor is not stale', () => {
    // A ratchet nobody tightens is a floor sliding unnoticed.
    expect(report.pass - FLOOR.pass,
      `FLOOR.pass is ${FLOOR.pass} but the engine passes ${report.pass} — raise it`)
      .toBeLessThan(4);
  });

  it('records a REASON for every entry it did not run', () => {
    // The 18 sht:Infer entries are not attempted; each says so. An entry skipped with no
    // reason is the one that quietly becomes permanent.
    expect(report.notRunFiles.length).toBe(report.notRun);
    expect(report.notRunFiles.every(r => r.includes(':')), report.notRunFiles.join('\n')).toBe(true);
  });
});
