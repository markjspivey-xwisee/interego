/**
 * The W3C SHACL 1.2 Core test suite runs in CI, and the number it produces only goes up.
 *
 * ★ WHY A SECOND CONFORMANCE HARNESS EXISTS. `tools/shacl-agreement` cross-checks us against
 * pySHACL, and for SHACL 1.0 that is the stronger check of the two — an independent engine
 * disagrees with the readings we got wrong, which our own tests cannot do because they
 * encode those readings. It cannot check 1.2 at all:
 *
 *   MEASURED. pySHACL 0.30.1 reads Turtle through rdflib, and rdflib rejects RDF 1.2
 *   annotation syntax outright — `{| … |}` raises BadSyntax before validation begins. Every
 *   1.2 feature written in the new syntax (sh:reifierShape, and the per-constraint
 *   severity/message/deactivated reifiers of §3.1.4) therefore has NO second implementation
 *   available to disagree with us.
 *
 * So for 1.2 the oracle has to be the specification's own suite, where each entry states the
 * verdict it expects and carries `mf:status sht:approved`.
 *
 * ★ AND IT FOUND WHAT OUR OWN TESTS COULD NOT. Before this ran, this repo's SHACL tests were
 * green and reported "28 of 29 features enforced" — measured against a feature list we wrote.
 * Against the suite, 67 of 132 approved entries passed. The gap was not exotic:
 *
 *   - `sh:targetNode "Hello"` selected NOTHING. Node targets were compiled as
 *     `readonly IRI[]`, so a literal or blank-node target was dropped at compile time.
 *   - Node-level constraints covered FOUR components of about twenty, in three separate
 *     hand-written copies, so sh:minLength / sh:pattern / sh:minInclusive / sh:hasValue /
 *     sh:languageIn / sh:node at node level compiled and were silently discarded.
 *   - `sh:conforms` counted only Violations, against §3.6's "any validation results".
 *
 * Each of those is a shape published at a dereferenceable IRI meaning one thing to us and
 * another to every reader. None was findable from inside our own reading of the spec.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(REPO, 'tools', 'shacl12-w3c', 'run.mjs');
const SUITE = join(REPO, 'tests', 'fixtures', 'shacl12-w3c', 'core');

/**
 * ★ THE RATCHET. Raise these when the engine improves; never lower them to make a run pass.
 *
 * A failing entry here is a real divergence from the specification, so the fix is the
 * engine. Lowering the floor converts a known defect into a silent one — and this file's
 * whole reason for existing is that our own green tests hid sixty-five of them.
 */
const FLOOR = {
  /** Verdict AND every expected result matched. */
  exact: 140,
  /** Verdict matched. The number that actually decides whether a publish is refused. */
  verdict: 140,
};

interface Report {
  approvedRunnable: number;
  unexplained: string[];
  unexplainedNotRun: string[];
  siblingInputs: number;
  notRunFiles: string[];
  knownDivergences: string[];
  pass: number;
  verdictOnly: number;
  fail: number;
  error: number;
  notRun: number;
  unapproved: number;
  failing: string[];
  verdictOnlyFiles: string[];
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

describe('W3C SHACL 1.2 Core conformance', () => {
  it('the vendored suite is actually there and actually large', () => {
    // ★ Guards the guard. Every assertion below is over whatever the runner found, so an
    // empty or half-deleted fixture tree reports a clean sweep of nothing. The upstream
    // core suite is 166 files; anything far below that means the vendoring broke.
    expect(countTtl(SUITE)).toBeGreaterThanOrEqual(160);
    expect(report.approvedRunnable).toBeGreaterThanOrEqual(140);
  });

  it('never throws on a spec-conformant shapes graph', () => {
    // An engine that crashes is worse than one that disagrees: a disagreement is a wrong
    // answer, a crash is no answer at a call site that expected one.
    expect(report.error, `engine threw on: ${report.failing.join(', ')}`).toBe(0);
  });

  it(`reaches the right VERDICT on at least ${FLOOR.verdict} approved entries`, () => {
    const verdict = report.pass + report.verdictOnly;
    expect(verdict, 'wrong verdict on:\n  ' + report.failing.join('\n  ')).toBeGreaterThanOrEqual(FLOOR.verdict);
  });

  it(`matches verdict AND results exactly on at least ${FLOOR.exact} approved entries`, () => {
    // The second tier matters on its own: a verdict match with a result mismatch means we
    // refuse the right document for the wrong reason, and a caller reading sh:resultPath or
    // sh:sourceConstraintComponent to explain the refusal is told something untrue.
    expect(report.pass, 'right answer, wrong reason:\n  ' + report.verdictOnlyFiles.join('\n  '))
      .toBeGreaterThanOrEqual(FLOOR.exact);
  });

  it('fails only where the runner records WHY', () => {
    // ★ THE POINT OF THE KNOWN-DIVERGENCE LIST, AND ITS ONLY JOB. It excuses nothing — the
    // two entries on it still run and still fail — but it makes the difference between
    // "two failures we can each account for" and "two failures". A NEW failure lands here
    // rather than blending into a count that was already non-zero.
    //
    // ★ THE LIST IS DOWN TO ONE, and the entry that left it is the interesting half.
    // node/nodeByExpression-001 was on it as "NOT IMPLEMENTED — needs the node-expression
    // sub-language". Writing that down is what made it a task rather than a footnote: the
    // sub-language is now implemented (67/67 on its SPARQL-free entries) and the entry
    // passes. A divergence ledger is only useful if entries can leave it.
    //
    // What remains, in full in tools/shacl12-w3c/run.mjs:
    //   node/in-002 — the entry expects a sh:sourceShape that is not in its own file; the
    //                 behaviour it means to test is implemented and covered by in-001.
    expect(report.unexplained,
      'a suite entry fails with no recorded reason — either fix the engine or record why '
      + 'the entry is disputed, in KNOWN_DIVERGENCES').toEqual([]);
    expect(report.knownDivergences.length,
      'the known-divergence list is growing; it is a ledger, not a bucket')
      .toBeLessThanOrEqual(1);
  });

  it('skips only where the runner records WHY, and counts inputs as inputs', () => {
    // ★ THE SKIP COUNT WAS MISLEADING IN THE SAFE-LOOKING DIRECTION. It read 17, of which
    // SIXTEEN were the sibling data/shapes files that multi-file entries name as INPUTS —
    // not tests at all. Reporting them as "not runnable" understated coverage, and a number
    // that is wrong in the pessimistic direction still teaches a reader to stop reading it.
    // One real skip remains: node/in-003 uses an undeclared `shsh:` prefix and is invalid
    // Turtle, so refusing to parse it is correct.
    expect(report.unexplainedNotRun,
      `an entry is skipped with no recorded reason:\n  ${report.notRunFiles.join('\n  ')}`)
      .toEqual([]);
    expect(report.notRun, 'more entries are being skipped than the one recorded').toBeLessThanOrEqual(1);
    expect(report.siblingInputs).toBeGreaterThanOrEqual(14);
  });

  it('and the floor is not set below what the engine currently does', () => {
    // ★ A ratchet that is never tightened is a floor nobody notices sliding. If the engine
    // is more than a handful of entries above the recorded floor, the floor is stale and
    // this says so rather than waiting for a regression to be absorbed silently.
    expect(report.pass - FLOOR.exact,
      `FLOOR.exact is ${FLOOR.exact} but the engine passes ${report.pass} — raise it`)
      .toBeLessThan(6);
    expect((report.pass + report.verdictOnly) - FLOOR.verdict,
      `FLOOR.verdict is ${FLOOR.verdict} but the engine reaches ${report.pass + report.verdictOnly} — raise it`)
      .toBeLessThan(6);
  });
});
