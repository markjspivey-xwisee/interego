/**
 * The injection ratchet counts what the code EMITS, not what the file mentions.
 *
 * ── ★★ WHY THIS FILE EXISTS: A GATE THAT COULD NOT BE DOCUMENTED, AND PAID IN PROSE ─────────
 *
 * `tools/turtle-iri-ratchet.mjs` banks the number of raw `<${expr}>` interpolations in production
 * TypeScript and fails when it rises. It counted by running the pattern over the whole file, so a
 * COMMENT explaining the rule counted as a breach of it — a docblock added to
 * `packages/workspace-client/src/sealer.ts`, saying its subject IRI was unscreened, took the gate
 * red at 675/674 without changing a line of emitted Turtle.
 *
 * ★★ THE LOOPHOLE IS THE HALF THAT MATTERS. Comments only ever inflate the count, so part of the
 * allowance was prose — and a new caller-reachable site could be paid for by DELETING a comment
 * that happened to mention the pattern, leaving the total flat while the population the gate
 * exists to shrink grew.
 *
 * ── ★★★ AND THE FIRST FIX FOR IT WAS WRONG IN THE LOOSENING DIRECTION ────────────────────────
 *
 * Blanking comments with `ts.createScanner` passed every shape tried in isolation. Over the tree it
 * reported 668 where the parser reports 673: it had blanked five lines of real code. A bare scanner
 * has no parser context, so it cannot know `/` begins a regular expression — and
 * `packages/core/src/rdf/escape.ts` holds one containing a double quote and a backtick. The scanner
 * read those as opening a string and a template, consumed the rest of the file, and reported the
 * code after them as "inside a comment". Banking 668 would have moved five live sites out of view.
 *
 * So the counter parses, and asks the inverted question: it looks ONLY inside `TemplateExpression`
 * nodes, the sole construct in which `${…}` is interpolation at all. Comments, regular expressions,
 * template-literal TYPES and ordinary strings are out of scope because they are not that node —
 * not because something tried to erase them first.
 *
 * Every case below is one of the shapes that misled the scanner, plus the two that would let the
 * parser over- or under-count. The regex case is the regression: it fails against the scanner
 * implementation and passes against the parser.
 */
import { describe, it, expect } from 'vitest';
import { countSitesIn, testRunFiles, countRawIriInterpolations, MAX_RAW_IRI_INTERPOLATIONS }
  from '../tools/turtle-iri-ratchet.mjs';

/** A backtick, so fixtures can hold template literals without ending this file's own. */
const B = String.fromCharCode(96);
/** The site the gate counts, assembled rather than written, for the same reason. */
const SITE = '<' + '${x}' + '>';
/** `/[\s<>"{}|\\^`]/` — the real regex in escape.ts that desynchronised the scanner. */
const NASTY_REGEX = 'const R = /[\\s<>"{}|\\\\^' + B + ']/;';

describe('a raw IRI site is counted where it is emitted', () => {
  it('counts a site a template literal actually emits', () => {
    expect(countSitesIn('const s = ' + B + SITE + ' a <urn:y> .' + B + ';')).toBe(1);
  });

  it('does not count a line comment that mentions the pattern', () => {
    expect(countSitesIn('// the shape counted is ' + B + SITE + B + ', for the record')).toBe(0);
  });

  it('does not count a block comment that mentions the pattern', () => {
    expect(countSitesIn('/** the shape counted is ' + B + SITE + B + ' */')).toBe(0);
  });

  /**
   * ★ THE REGRESSION. Against the scanner implementation this returned 1 for the comment and 0 for
   * the code below it. Both legs are here because the bug swapped them: it is not enough for the
   * comment to be ignored if the code after it is ignored too.
   */
  it('★ is not blinded by a regular expression holding a quote and a backtick', () => {
    expect(countSitesIn(NASTY_REGEX + '\n// a mention of ' + B + SITE + B + '\n'))
      .toBe(0);
    expect(countSitesIn(NASTY_REGEX + '\nconst s = ' + B + SITE + B + ';\n'))
      .toBe(1);
  });

  it('does not count a template-literal TYPE, which emits nothing', () => {
    expect(countSitesIn('type Iri = ' + B + '<${string}>' + B + ';')).toBe(0);
  });

  it('counts each site in nested templates exactly once', () => {
    // The outer node's text contains the inner one, so a counter that recursed would say 4.
    const src = 'const s = ' + B + SITE + ' ${a ? ' + B + SITE + B + ' : y}' + B + ';';
    expect(countSitesIn(src)).toBe(2);
  });

  it('counts a site in a tagged template, which emits like any other', () => {
    expect(countSitesIn('const s = tag' + B + SITE + B + ';')).toBe(1);
  });
});

describe('the test-file set is derived from what runs, not from filenames', () => {
  const testRun = testRunFiles();

  it('finds test files at all', () => {
    // Guards the guard: an empty set silently re-scopes live test scripts as production. The gate
    // itself fails loudly below 20 — this is the same floor, asserted where the cause is legible.
    expect(testRun.size, 'no workspace test script yielded a file — the derivation is broken')
      .toBeGreaterThan(20);
  });

  it('★ finds the relay scripts whose names end -test.ts rather than .test.ts', () => {
    // These are why the derivation exists: run by the relay's own `npm test`, sitting beside the
    // server rather than under tests/, and missed by both filename exclusions.
    const named = [...testRun].filter((p) => p.endsWith('/_note-view-test.ts')
      || p.endsWith('/_hmd-app-test.ts') || p.endsWith('/_application-lab-test.ts'));
    expect(named.length, 'the underscore-prefixed relay test scripts are not in the derived set:\n  '
      + [...testRun].slice(0, 10).join('\n  ')).toBe(3);
  });
});

describe('the whole-tree count is a measurement, not a constant', () => {
  const { total, perFile, excluded, testRunCount } = countRawIriInterpolations();

  it('reads a substantial population', () => {
    // A walk that quietly matched nothing would report 0 and pass every comparison below it.
    expect(total, 'the tree walk found almost nothing — the count is not measuring the repo')
      .toBeGreaterThan(500);
    expect(perFile.length).toBeGreaterThan(50);
  });

  it('does not exceed the banked allowance', () => {
    expect(
      total,
      `${total} raw interpolation(s) against a budget of ${MAX_RAW_IRI_INTERPOLATIONS}. The `
        + 'heaviest files are:\n  '
        + perFile.slice(0, 5).map((f) => `${f.count}  ${f.file}`).join('\n  '),
    ).toBeLessThanOrEqual(MAX_RAW_IRI_INTERPOLATIONS);
  });

  it('★ excludes only a handful of files, and names them', () => {
    // Every exclusion is allowance removed from the gate's view, which is the direction that
    // loosens it. The gate caps this too; asserting it here is what makes a silent widening loud.
    expect(
      excluded.map((f) => f.file),
      'more files are excluded than the reviewed set — a runner is being invoked on real source, '
        + 'or the derivation is over-matching',
    ).toHaveLength(2);
    expect(testRunCount).toBeGreaterThan(20);
  });
});
