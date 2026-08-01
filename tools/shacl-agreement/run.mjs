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
      if (!shape || !expect) {
        throw new Error(`${name}: every fixture must declare "# shape:" and "# expect:" — an `
          + 'undeclared expectation lets two engines be wrong together and still pass.');
      }
      return { name, shape, expect, why, data: text };
    });
}

const fixtures = loadFixtures();

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
