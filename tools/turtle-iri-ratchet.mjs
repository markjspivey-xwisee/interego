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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The current population of raw `<${expr}>` interpolations.
 *
 * ★ MEASURED, NOT CHOSEN. Lower it whenever sites are fixed — the gate prints the number to write.
 */
export const MAX_RAW_IRI_INTERPOLATIONS = 691;

/** How far below the budget the real count may sit before the budget is stale and must be lowered. */
const SLACK = 10;

const ROOTS = ['applications', 'packages', 'deploy'];
/** `<${foo}>`, `<${a.b}>`, `<${x?.y}>` — an IRI reference built by interpolation. */
const RAW_IRI = /<\$\{[A-Za-z_][A-Za-z0-9_.?[\]']*\}>/g;

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
      if (s.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function countRawIriInterpolations(root = REPO_ROOT) {
  let total = 0;
  const perFile = [];
  for (const r of ROOTS) {
    for (const f of tsFilesUnder(join(root, r))) {
      const n = (readFileSync(f, 'utf8').match(RAW_IRI) ?? []).length;
      if (n > 0) { total += n; perFile.push({ file: f.slice(root.length), count: n }); }
    }
  }
  perFile.sort((a, b) => b.count - a.count);
  return { total, perFile };
}

function main() {
  const { total, perFile } = countRawIriInterpolations();
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
