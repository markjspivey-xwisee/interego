/**
 * CI gate — the number of RAW IRI interpolations into Turtle may go down, never up.
 *
 * ── ★★ WHY A RATCHET AND NOT A BAN ──────────────────────────────────────────────────────────
 *
 * `packages/core/src/rdf/escape.ts` exports `turtleIriRef()`: it refuses a value containing the
 * characters that would break out of an IRI reference, and returns null rather than emitting one.
 * A system audit found it adopted by three of eight verticals and ignored by the rest, which
 * interpolate caller-influenced values straight into `<${...}>`. Turtle injection has already been a
 * finding in this repo, in three separate positions.
 *
 * ★ AND YET BANNING IT OUTRIGHT WOULD BE THE WRONG MOVE TODAY. There are ~691 such sites and the
 * great majority interpolate values that cannot be caller-controlled — namespace constants, hashes,
 * URLs the process just minted. Rewriting all of them in one change would be a very large diff whose
 * risky edits are indistinguishable from its noisy ones, which is how a genuinely dangerous site gets
 * waved through in review. A ratchet stops the population growing while the real ones are fixed
 * deliberately, and it is the mechanism this repo already trusts for exactly this shape (MIN_FILES,
 * MIN_TEST_MODULES, the typecheck pins).
 *
 * ★ IT ALSO RATCHETS DOWNWARD BY ITSELF: fix some sites and the gate demands the new, lower number,
 * so the budget can never silently drift back up. A pin that only tightens when somebody remembers
 * is a pin that never tightens.
 *
 *   node tools/turtle-iri-ratchet.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The current population of raw `<${expr}>` interpolations.
 *
 * ★ MEASURED, NOT CHOSEN. Lower it whenever sites are fixed — the gate prints the number to write.
 */
export const MAX_RAW_IRI_INTERPOLATIONS = 652;

/** How far below the budget the real count may sit before the budget is stale and must be lowered. */
const SLACK = 10;

/**
 * ★★ TEST FILES ARE NOT IN SCOPE, AND THIS IS A CORRECTION RATHER THAN A CONCESSION.
 *
 * The population this gate exists to shrink is Turtle built from values a CALLER can influence —
 * see the header. A fixture interpolating a literal constant into `<${…}>` to build an input for
 * an assertion is not that, and never becomes that.
 *
 * ★ THE TOOL ALREADY BELIEVED THIS AND APPLIED IT INCONSISTENTLY. The repository's own `tests/`
 * tree has never been counted — it is simply not in ROOTS below. But `deploy/mcp-relay/tests/`
 * WAS counted, purely because it lives under a root that is. So one test tree was in scope and
 * another was not, for no reason anybody chose. Measured 2026-08-26: 706 sites, of which 32 were
 * in test files and 674 were production.
 *
 * ★★ AND THE BUDGET WENT DOWN, NOT UP. The occasion for this was a new relay test file carrying
 * 22 fixture interpolations, which pushed the total past the budget. Raising the budget by 22 to
 * admit them would have been exactly the laundering this file's own header warns against — the
 * ratchet would then have had 22 sites of slack for real ones. Scoping to production and banking
 * the measured production count instead makes the gate STRICTER on the code that matters: the
 * effective allowance for caller-reachable sites falls from 691 to 674.
 *
 * ── ★★ THE THIRD INSTANCE OF THAT SAME INCONSISTENCY, AND A LOOPHOLE IT LEFT OPEN ────────────
 *
 * The section above is the second time this file recorded "one test tree was in scope and another
 * was not, for no reason anybody chose". It happened twice more, and both were found the same way
 * — by a comment tripping the gate:
 *
 * 1. PROSE COUNTED AS CODE. The scan was `readFileSync(f).match(RAW_IRI)` over the whole file, so
 *    a COMMENT describing the rule counted as a violation of it. The run that found this failed at
 *    675/674 purely because a docblock added to `packages/workspace-client/src/sealer.ts` —
 *    explaining that its subject IRI was unscreened — spelled the pattern out. The gate could not
 *    be documented in the files it governs.
 *
 *    ★★ AND IT WAS ALSO A LOOPHOLE, WHICH IS THE HALF THAT MATTERS. Comments only ever INFLATE
 *    the count, so part of the 674-site allowance was prose: a new caller-reachable site could be
 *    paid for by DELETING a comment that happened to mention `<${…}>`, and the gate would report a
 *    flat count while the population it exists to shrink grew.
 *
 *    ★★★ THE FIRST FIX FOR THIS WAS ITSELF WRONG, IN THE LOOSENING DIRECTION, AND ONLY AN
 *    EMPIRICAL FAIL-TEST CAUGHT IT. Blanking comments with `ts.createScanner` looked right and
 *    passed in isolation on every shape tried. Run over the tree it reported 668 where the parser
 *    reports 673: it had blanked five lines of REAL CODE. A bare scanner has no parser context, so
 *    it cannot know a `/` begins a regular expression — and `packages/core/src/rdf/escape.ts`, of
 *    all files, holds `/[\s<>"{}|\\^`]/`. The scanner read that `"` as opening a string and the
 *    backtick as opening a template literal, and from there consumed the rest of the file, so the
 *    trailing comment was "inside a template" and the real sites after it were "inside a comment".
 *    Had that 668 been banked as the budget, five live sites would have left the gate's view.
 *
 *    So the count is taken from the PARSER, and inverted while we are here: instead of removing
 *    comments and searching what is left, it searches only inside `TemplateExpression` nodes —
 *    which is the sole construct a raw `<${…}>` can exist in. Comments, regular expressions,
 *    template literal TYPES and ordinary strings are then out of scope because they are not that
 *    node, rather than because something tried to erase them first.
 *
 * 2. THREE LIVE TEST SCRIPTS COUNTED AS PRODUCTION, ON THE STRENGTH OF THEIR FILENAMES.
 *    `deploy/mcp-relay/_note-view-test.ts` (19 sites) and `_hmd-app-test.ts` (2) are run by the
 *    relay's own `npm test`, alongside `_application-lab-test.ts`. They sit beside the server
 *    rather than under `tests/`, and their names end `-test.ts` rather than `.test.ts`, so both
 *    exclusions above missed them. 21 more sites of the allowance were fixtures.
 *
 *    ★ THE TEST SET IS DERIVED, NOT LISTED. Adding `_note-view-test` to a hand-written name list
 *    would be the narrow-filter mistake this repo keeps paying for — the next such file would be
 *    invisible again. `testRunFiles()` below parses every workspace's own `scripts.test` and takes
 *    the files a RUNNER is invoked on, so a file is a test here because something runs it as one.
 *
 * Together these take the allowance from 674 to 652 — 22 sites of slack a real injection site
 * could have hidden in, removed without touching a line of product code.
 */
const ROOTS = ['applications', 'packages', 'deploy'];
/** Every workspace root that can carry a `package.json` with a `test` script. */
const PACKAGE_ROOTS = ['applications', 'packages', 'deploy', 'integrations', 'mcp-server'];
/** `<${foo}>`, `<${a.b}>`, `<${x?.y}>` — an IRI reference built by interpolation. */
const RAW_IRI = /<\$\{[A-Za-z_][A-Za-z0-9_.?[\]']*\}>/g;
/** A runner followed by the file it executes: `tsx a.ts`, `&&tsx b.ts`, `node c.mts`. */
const RUNNER_INVOCATION = /(?:tsx|ts-node|vitest|node)\s+([\w./_-]+\.(?:ts|mts|cts))\b/g;

/**
 * How many raw `<${…}>` sites the file actually EMITS.
 *
 * Searches inside `TemplateExpression` nodes and nowhere else — see the header for why this is a
 * parse and not a comment-strip. A template literal is the only construct in which `${…}` is
 * interpolation at all, so this is the whole population by construction rather than by exclusion.
 *
 * Nested templates are not descended into: the outer node's text already contains the inner one,
 * and recursing would count everything inside it twice.
 */
export function countSitesIn(text, fileName = 'file.ts') {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  /**
   * ★★ A FILE THAT DOES NOT PARSE MUST NOT COUNT AS ZERO SITES.
   *
   * The parser RECOVERS from a syntax error rather than throwing, dropping the nodes it could not
   * make sense of — so a file with one bad token silently contributes 0 and the total FALLS. That
   * is the direction that loosens the gate, and it would then invite lowering the budget, banking
   * the loss as if sites had been fixed. It is the same failure the census floors exist for, one
   * file at a time instead of all of them.
   *
   * `parseDiagnostics` is not on the public SourceFile type, which is why `syntaxErrors` is
   * reported to the caller rather than asserted here: `countRawIriInterpolations` fails the run if
   * the property ever stops existing, so a TypeScript upgrade that removed it could not quietly
   * disarm this.
   */
  const diagnostics = /** @type {{ parseDiagnostics?: readonly unknown[] }} */ (source).parseDiagnostics;
  countSitesIn.lastDiagnosticsSeen = Array.isArray(diagnostics);
  countSitesIn.lastSyntaxErrors = Array.isArray(diagnostics) ? diagnostics.length : 0;
  let found = 0;
  const visit = (node) => {
    if (ts.isTemplateExpression(node)) {
      found += (node.getText(source).match(RAW_IRI) ?? []).length;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/**
 * Absolute paths of files some workspace's own `test` script runs, lower-cased for comparison.
 *
 * Derived from `package.json`, so "is this a test?" is answered by whether anything runs it as one
 * rather than by how it was named. `existsSync` keeps a stale script entry from excluding nothing.
 */
export function testRunFiles(root = REPO_ROOT) {
  const found = new Set();
  for (const r of PACKAGE_ROOTS) {
    for (const pj of filesUnder(join(root, r), (p) => p.endsWith('package.json'))) {
      let script;
      try { script = JSON.parse(readFileSync(pj, 'utf8')).scripts?.test; } catch { continue; }
      if (typeof script !== 'string') continue;
      for (const m of script.matchAll(RUNNER_INVOCATION)) {
        const abs = resolve(dirname(pj), m[1]);
        if (existsSync(abs)) found.add(abs.split(sep).join('/').toLowerCase());
      }
    }
  }
  return found;
}

/** Every file under `dir` matching `pick`; `tests/` is descended into, callers filter. */
function filesUnder(dir, pick) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
      const p = join(d, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { walk(p); continue; }
      if (pick(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function tsFilesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
      const p = join(d, e);
      let s;
      try { s = statSync(p); } catch { continue; }
      if (s.isDirectory()) { if (e !== 'tests') walk(p); continue; }
      if (p.endsWith('.ts') && !p.endsWith('.d.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function countRawIriInterpolations(root = REPO_ROOT) {
  let total = 0;
  const perFile = [];
  const excluded = [];
  /** Files the parser could not fully read - a silent zero, in the loosening direction. */
  const syntaxErrors = [];
  /** Whether `parseDiagnostics` was observable at all; false means the guard above is disarmed. */
  let diagnosticsSeen = false;
  const testRun = testRunFiles(root);
  for (const r of ROOTS) {
    for (const f of tsFilesUnder(join(root, r))) {
      // Template literals only: prose describing the rule is not an instance of it, and counting
      // it both blocked documenting the gate and left the allowance payable in deleted comments.
      const n = countSitesIn(readFileSync(f, 'utf8'), f);
      if (countSitesIn.lastDiagnosticsSeen) diagnosticsSeen = true;
      if (countSitesIn.lastSyntaxErrors > 0) {
        syntaxErrors.push({ file: f.slice(root.length), count: countSitesIn.lastSyntaxErrors });
      }
      if (n === 0) continue;
      const entry = { file: f.slice(root.length), count: n };
      if (testRun.has(resolve(f).split(sep).join('/').toLowerCase())) { excluded.push(entry); continue; }
      total += n;
      perFile.push(entry);
    }
  }
  perFile.sort((a, b) => b.count - a.count);
  excluded.sort((a, b) => b.count - a.count);
  return { total, perFile, excluded, testRunCount: testRun.size, syntaxErrors, diagnosticsSeen };
}

/**
 * How many production-tree files a workspace test script may claim before the exclusion is
 * reviewed rather than trusted.
 *
 * ★ THIS IS A CEILING ON WHAT THE GATE STOPS LOOKING AT, WHICH IS THE DANGEROUS DIRECTION.
 * Every excluded file is allowance removed from the gate's view. If `RUNNER_INVOCATION` ever
 * over-matches — a `node` in a comment inside a test script, a token that happens to end `.ts` —
 * real source silently leaves scope, the total FALLS, and the SLACK check below then invites
 * somebody to lower the budget, which would bank the loosening as if it were progress. Measured
 * 2026-09-03: 2 files, both in deploy/mcp-relay.
 */
const MAX_EXCLUDED_TEST_FILES = 4;

function main() {
  const { total, perFile, excluded, testRunCount, syntaxErrors, diagnosticsSeen }
    = countRawIriInterpolations();
  if (!diagnosticsSeen) {
    console.error(`
★ TURTLE IRI RATCHET - THE PARSE-FAILURE GUARD IS DISARMED
`);
    console.error(`  ts.SourceFile no longer exposes parseDiagnostics, so a file with a syntax`);
    console.error(`  error would silently count as ZERO sites and lower the total. Find the`);
    console.error(`  replacement before trusting another run - do not lower the budget.
`);
    process.exit(1);
  }
  if (syntaxErrors.length > 0) {
    console.error(`
★ TURTLE IRI RATCHET - ${syntaxErrors.length} FILE(S) DID NOT PARSE
`);
    console.error(`  The parser recovers rather than throwing, so each of these contributed FEWER`);
    console.error(`  sites than it holds and the total below is an undercount - the direction that`);
    console.error(`  loosens this gate. Fix the syntax; do not lower the budget.
`);
    for (const { file, count } of syntaxErrors.slice(0, 10)) {
      console.error(`    ${String(count).padStart(4)} error(s)  ${file}`);
    }
    console.error('');
    process.exit(1);
  }
  // Printed every run, passing or failing: an exclusion nobody sees is an exclusion nobody checks.
  if (excluded.length > 0) {
    console.log(`  (not counted — run by a workspace's own \`npm test\`:`);
    for (const { file, count } of excluded) console.log(`    ${String(count).padStart(4)}  ${file}`);
    console.log('  )');
  }
  if (testRunCount < 20) {
    console.error(`\n★ TURTLE IRI RATCHET — THE TEST-FILE DERIVATION IS BROKEN\n`);
    console.error(`  Only ${testRunCount} test file(s) were found across every workspace's \`scripts.test\`,`);
    console.error(`  and there are dozens. RUNNER_INVOCATION has stopped matching, so live test`);
    console.error(`  scripts are being counted as production and the total below is not comparable`);
    console.error(`  to the budget. Fix the derivation — do not adjust the budget.\n`);
    process.exit(1);
  }
  if (excluded.length > MAX_EXCLUDED_TEST_FILES) {
    console.error(`\n★ TURTLE IRI RATCHET — TOO MUCH IS BEING EXCLUDED\n`);
    console.error(`  ${excluded.length} production-tree files were claimed by a workspace test script,`);
    console.error(`  above the reviewed ceiling of ${MAX_EXCLUDED_TEST_FILES}. Either a runner is being invoked on real`);
    console.error(`  source, or RUNNER_INVOCATION is over-matching and the gate has stopped looking at`);
    console.error(`  code it is meant to police. Check the list above before raising the ceiling.\n`);
    process.exit(1);
  }
  if (total > MAX_RAW_IRI_INTERPOLATIONS) {
    console.error(`\n★ TURTLE IRI RATCHET FAILED — tools/turtle-iri-ratchet.mjs\n`);
    // Plain concatenation: the pattern being reported contains the very delimiters a template
    // literal treats specially, and escaping it inline was itself a syntax error.
    console.error('  ' + total + ' raw interpolations of the form <${expr}>, but the budget is ' + MAX_RAW_IRI_INTERPOLATIONS + '.');
    console.error(`  A new one was added. Use turtleIriRef() from @interego/core instead — it returns`);
    console.error(`  null for a value that would break out of the IRI, so the caller must decide what`);
    console.error(`  to do rather than emitting a broken or hostile graph.\n`);
    console.error(`  Heaviest files:`);
    for (const { file, count } of perFile.slice(0, 5)) console.error(`    ${String(count).padStart(4)}  ${file}`);
    process.exit(1);
  }
  if (total < MAX_RAW_IRI_INTERPOLATIONS - SLACK) {
    console.error(`\n★ TURTLE IRI RATCHET — LOWER THE BUDGET\n`);
    console.error(`  Only ${total} raw interpolations remain but the budget is still`);
    console.error(`  ${MAX_RAW_IRI_INTERPOLATIONS}. Set MAX_RAW_IRI_INTERPOLATIONS to ${total} in`);
    console.error(`  tools/turtle-iri-ratchet.mjs — a budget that drifts above reality stops being one.\n`);
    process.exit(1);
  }
  console.log(`✓ turtle IRI ratchet: ${total} raw interpolation(s), budget ${MAX_RAW_IRI_INTERPOLATIONS} (never rises)`);
}

if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1].replace(/\\/g, '/')}`)).endsWith('turtle-iri-ratchet.mjs')) {
  main();
}
