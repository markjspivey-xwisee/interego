#!/usr/bin/env node
/**
 * Does an INDEPENDENT SHACL implementation agree with ours?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * We publish SHACL shapes at dereferenceable URLs and invite anyone to validate against
 * them. That invitation is only worth something if our engine and a conformant one reach
 * the same verdict — otherwise a published shape means one thing to us and something else
 * to every reader, and the disagreement is discovered by whoever it lets through.
 *
 * ★ This is not hypothetical. `sh:pattern` was applied only to literals here, while
 * §4.6.3 applies it to IRIs too and pySHACL implements it that way. THREE published a2a
 * constraints were inert as a result — including one whose own message reads "every
 * advertised capability id MUST be a dereferenceable http(s) URL". Our own tests could not
 * find it, because they encoded our reading of the spec. Only a second implementation
 * could, and there wasn't one in the loop.
 *
 * So: same shapes, same data, two engines, compared. Ours (@interego/core) and pySHACL,
 * the reference-grade Python implementation.
 *
 * ── WHAT AGREEMENT MEANS HERE ────────────────────────────────────────────────
 *
 * Agreement is on the VERDICT — conforms or not — and not on the number or wording of
 * results. Two conformant implementations may legitimately report a different count for
 * the same violation (one result per value versus one per constraint), and demanding they
 * match would make the check fail for reasons that are nobody's bug.
 *
 * ★ Each fixture also declares the verdict it EXPECTS. Without that, two engines that are
 * wrong in the same direction agree perfectly and the harness reports success — the exact
 * failure mode of a test that cannot fail. A fixture whose expectation both engines miss
 * is reported separately from a disagreement, because it means something different.
 *
 * ── AND WHY THE COVERAGE GATE BELOW EXISTS ───────────────────────────────────
 *
 * ★★ THIS HARNESS USED TO ENUMERATE THE FIXTURE DIRECTORY AND ASK NOTHING OF THE SHAPE, so
 * how much of the published contract a second engine had ever seen was whatever somebody
 * last remembered to write a file for. Three of wsp-shapes.ttl's eight `sh:pattern` terms
 * were pinned (wsp:grantedTo, wsp:member, wsp:references); wsp:convener, wsp:roleProfile,
 * wsp:role, wsp:workspace and wsp:accepts had never been put in front of pySHACL, and adding
 * a ninth pattern to the shape would have added a ninth unchecked one in silence. Measured
 * by reintroducing PR #231's defect in the engine (sh:pattern applied to literals only): with
 * the old fixture set it produced 3 disagreements, with this one it produces 8. That is the
 * same defect one level up — there a published constraint was inert, here the CHECK for it
 * was — and the count was being maintained by re-reading prose, which is why the ledger row
 * tracking it went wrong twice.
 *
 * So the shape is now the denominator: `patternedTerms()` reads the pattern constraints out
 * of the shape file itself, and an unpinned one fails the run. `# pins:` is what a fixture
 * declares it covers — and because a declaration nobody checks is the thing this file keeps
 * being burnt by, the second loop verifies the claim against the fixture's own data: a
 * `violates` fixture pinning a term must actually carry a value on that term that the
 * published pattern refuses. Without that half, a fixture that violates for a missing
 * `dct:title` could claim to pin `wsp:role` and the harness would print "all fixtures agree"
 * and exit 0 — measured with the gate stubbed out, not supposed.
 *
 * Usage:
 *   node tools/shacl-agreement/run.mjs           # ours only, writes ours.json
 *   node tools/shacl-agreement/run.mjs --compare # compares against theirs.json
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstShape } from '@interego/core';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures');

/**
 * Load every fixture. A fixture is a Turtle file whose first lines declare, in comments:
 *   # shape: <file in fixtures/>
 *   # expect: conforms | violates
 *   # pins:  <prefixed term>[, ...]   (every patterned term needs one; see the gate below)
 *   # why: <one line, for the failure message>
 */
function loadFixtures() {
  return readdirSync(FIXTURES)
    .filter(f => f.endsWith('.data.ttl'))
    .sort()
    .map(name => {
      const text = readFileSync(join(FIXTURES, name), 'utf8');
      const shape = text.match(/^#\s*shape:\s*(\S+)/m)?.[1];
      const expect = text.match(/^#\s*expect:\s*(conforms|violates)/m)?.[1];
      const why = text.match(/^#\s*why:\s*(.+)$/m)?.[1]?.trim() ?? '';
      const pins = (text.match(/^#\s*pins:\s*(.+)$/m)?.[1] ?? '')
        .split(',').map(t => t.trim()).filter(t => t.length > 0);
      if (!shape || !expect) {
        throw new Error(`${name}: every fixture must declare "# shape:" and "# expect:" — an `
          + 'undeclared expectation lets two engines be wrong together and still pass.');
      }
      return { name, shape, expect, why, pins, data: text };
    });
}

/**
 * Every `sh:pattern` the shape file puts on a path, keyed by the prefixed term.
 *
 * Read out of the shape rather than restated, for the same reason the drift test in
 * tests/workspace-membership.test.ts parses the deployed file: a hand-kept list of "terms we
 * ought to cover" is a second source of truth and goes stale on the first edit to the shape —
 * which is the staleness this gate exists to end, not to reproduce.
 *
 * Regex scan, not a parser, with two named limits. `indexOf(']')` assumes no nested `]` inside
 * a `sh:property [ ... ]` block — the same assumption the drift test already makes, so this is
 * not a new second source of truth. And the `terms.size === 0` floor below is what turns a
 * reformat this scan stops understanding into a loud failure instead of a silent report of
 * full coverage.
 */
function patternedTerms(shapeFile) {
  const text = readFileSync(join(FIXTURES, shapeFile), 'utf8');
  const found = new Map();
  for (const block of text.split('sh:property [').slice(1)) {
    const body = block.slice(0, block.indexOf(']'));
    const path = /sh:path\s+(\w+:\w+)/.exec(body);
    const pattern = /sh:pattern\s+"([^"]*)"/.exec(body);
    if (path === null || pattern === null) continue;
    found.set(path[1], pattern[1]);
  }
  return found;
}

/**
 * Every constraint component a shapes file actually carries.
 *
 * The floor below used to be spelled `sh:pattern`, because sh:pattern was the only constraint
 * any shape here used. That made a legitimately pattern-free shape (subclass-shapes.ttl, which
 * constrains with sh:class) indistinguishable from a shape that had stopped constraining
 * anything. The invariant was never "uses sh:pattern" — it is "constrains something a fixture
 * can disagree about", so that is what this counts.
 */
function constraintComponents(shapeFile) {
  const text = readFileSync(join(FIXTURES, shapeFile), 'utf8');
  const body = text.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
  return new Set([...body.matchAll(
    /\bsh:(pattern|class|datatype|nodeKind|minCount|maxCount|in|hasValue|minInclusive|maxInclusive|minLength|maxLength|languageIn|node|not|or|and|xone|equals|disjoint|lessThan)\b/g,
  )].map(m => m[1]));
}

/**
 * The IRI objects a fixture states on one term. Comment lines are stripped first, so a term
 * NAMED in a `# why:` line cannot be mistaken for a term the data actually carries.
 *
 * Matches `term<whitespace><IRI>`, which is why `wsp:role` does not collide with
 * `wsp:roleProfile` — the latter is followed by `P`, not whitespace.
 */
function iriObjectsOf(dataText, term) {
  const triples = dataText.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n');
  return [...triples.matchAll(new RegExp(`${term}\\s+<([^>]*)>`, 'g'))].map(m => m[1]);
}

const fixtures = loadFixtures();

// ── the shape is the denominator ────────────────────────────────────────────
const shapeFiles = [...new Set(fixtures.map(f => f.shape))].sort();
const patterns = new Map(shapeFiles.map(s => [s, patternedTerms(s)]));

let gaps = 0;
for (const shapeFile of shapeFiles) {
  const terms = patterns.get(shapeFile);
  // A floor first: a scan that matched nothing would report full coverage while checking
  // nothing, which is the failure mode this gate is here to prevent rather than to have.
  if (constraintComponents(shapeFile).size === 0) {
    console.error(`${shapeFile}: no constraint component found at all. Either the shape stopped `
      + 'constraining anything or this scan stopped seeing it; both are failures.');
    gaps++;
  }
  for (const [term, pattern] of terms) {
    const pinned = fixtures.some(
      f => f.shape === shapeFile && f.expect === 'violates' && f.pins.includes(term));
    if (!pinned) {
      console.error(`${shapeFile}: sh:pattern "${pattern}" on ${term} is published and NO fixture `
        + `pins it. Add a "# pins: ${term}" fixture that violates it, or a second engine has `
        + 'never once been asked what this constraint means.');
      gaps++;
    }
  }
}

// ── and a pin has to be earned ──────────────────────────────────────────────
for (const f of fixtures) {
  for (const term of f.pins) {
    const pattern = patterns.get(f.shape)?.get(term);
    if (pattern === undefined) {
      console.error(`${f.name}: pins ${term}, which carries no sh:pattern in ${f.shape}.`);
      gaps++;
      continue;
    }
    const values = iriObjectsOf(f.data, term);
    if (values.length === 0) {
      console.error(`${f.name}: pins ${term} and states no ${term}. A fixture cannot be `
        + 'exercising a constraint on a term it does not carry.');
      gaps++;
      continue;
    }
    const offending = values.filter(v => !new RegExp(pattern).test(v));
    if (f.expect === 'violates' && offending.length === 0) {
      console.error(`${f.name}: pins ${term} and expects "violates", but every ${term} value it `
        + `states satisfies "${pattern}". It violates for some OTHER reason, so ${term} is still `
        + 'unpinned — the fixture claims coverage it does not have.');
      gaps++;
    }
    if (f.expect === 'conforms' && offending.length > 0) {
      console.error(`${f.name}: pins ${term} and expects "conforms", but states `
        + `<${offending[0]}>, which "${pattern}" refuses.`);
      gaps++;
    }
  }
}

if (gaps > 0) {
  console.error(`\n${gaps} coverage gap(s) between the published shape and the fixtures.\n`);
  process.exit(1);
}

if (!process.argv.includes('--compare')) {
  const ours = {};
  for (const f of fixtures) {
    const shapeTurtle = readFileSync(join(FIXTURES, f.shape), 'utf8');
    const report = validateAgainstShape(f.data, shapeTurtle);
    ours[f.name] = { conforms: report.conforms, results: report.results.length };
  }
  writeFileSync(join(here, 'ours.json'), JSON.stringify(ours, null, 2));
  console.log(`@interego/core validated ${fixtures.length} fixture(s) -> ours.json`);
  process.exit(0);
}

// ── comparison ──────────────────────────────────────────────────────────────
const ours = JSON.parse(readFileSync(join(here, 'ours.json'), 'utf8'));
const theirs = JSON.parse(readFileSync(join(here, 'theirs.json'), 'utf8'));

let disagreements = 0;
let wrongTogether = 0;

console.log('\n fixture                              expected   ours   pySHACL');
console.log(' ' + '-'.repeat(70));
for (const f of fixtures) {
  const o = ours[f.name];
  const t = theirs[f.name];
  if (!o || !t) {
    console.log(` ${f.name.padEnd(36)} MISSING RESULT`);
    disagreements++;
    continue;
  }
  const want = f.expect === 'conforms';
  const agree = o.conforms === t.conforms;
  const correct = agree && o.conforms === want;

  const mark = !agree ? 'DISAGREE' : correct ? 'ok' : 'BOTH WRONG';
  console.log(
    ` ${f.name.padEnd(36)} ${f.expect.padEnd(10)} ${String(o.conforms).padEnd(6)} `
    + `${String(t.conforms).padEnd(8)} ${mark}`,
  );
  if (!agree) {
    disagreements++;
    console.log(`     ↳ ${f.why}`);
    console.log('     ↳ ★ our published shape means different things to us and to a conformant reader.');
  } else if (!correct) {
    wrongTogether++;
    console.log(`     ↳ ${f.why}`);
    console.log('     ↳ ★ both engines agree and both are WRONG — the fixture is what caught it.');
  }
}

console.log('');
if (disagreements > 0) {
  console.error(`${disagreements} disagreement(s) between @interego/core and pySHACL.\n`);
}
if (wrongTogether > 0) {
  console.error(`${wrongTogether} fixture(s) where both engines missed the declared expectation.\n`);
}
if (disagreements + wrongTogether > 0) process.exit(1);
console.log(`All ${fixtures.length} fixtures: both engines agree, and agree with what the fixture expects.\n`);
