#!/usr/bin/env tsx
/**
 * The stripper every source-text gate reads through cannot delete code.
 *
 * ★ WHY THIS FILE EXISTS AT ALL. `stripComments` is not a subject of any gate — it is the
 * LENS three gates look through, so a defect in it does not turn anything red: it turns
 * assertions vacuous. The regex version it replaced deleted ~596 lines of server.ts from
 * the view, and the guard "does NOT enable Access-Control-Allow-Credentials in any deploy
 * server" passed with a real credentials middleware live in the file. Nothing reported it.
 *
 * So the last check here does not test the fixture — it reconstructs the EXPLOIT: it
 * inserts a real middleware line into the exact region the old stripper ate, and requires
 * the new stripper to still show it. And it requires the OLD stripper to lose it, because
 * a fixture that both implementations pass proves nothing about the change.
 *
 * Run from deploy/mcp-relay/:  npx tsx tests/strip-comments.test.ts
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, STRIPPER_FIXTURE, STRIPPER_EXPECTATIONS } from './strip-comments.js';

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (cond: boolean, name: string, detail = ''): void => {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures++; console.error(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
};

console.log('\nstripComments removes comments and NOTHING else');

// ── 1. the shared fixture ────────────────────────────────────────────────────
{
  const out = stripComments(STRIPPER_FIXTURE);
  for (const [label, predicate] of STRIPPER_EXPECTATIONS) ok(predicate(out), label);
}

// ── 2. the real file the gates read ──────────────────────────────────────────
//
// Measured before the fix: server.ts 14,442 lines -> 9,068 through the regex stripper.
// Both probes below sit inside spans a `//` comment containing `/*` opened.
{
  const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
  const code = stripComments(SERVER, 'server.ts');
  for (const probe of ['const RELAY_POD_HOST_ALLOWLIST', 'const vertical = String(req.params.vertical)']) {
    ok(SERVER.includes(probe) && code.includes(probe),
      `server.ts keeps \`${probe.slice(0, 40)}…\` after stripping`,
      `in source: ${SERVER.includes(probe)}, in stripped: ${code.includes(probe)}`);
  }
  // A stripper that returns its input unchanged would pass everything above.
  ok(code.length < SERVER.length * 0.85,
    'server.ts actually got shorter (the stripper is not a no-op)',
    `${SERVER.length} -> ${code.length}`);
  // …and it must still be the CODE, not a fraction of it. The regex version cut 37% of
  // the LINES; anything near that is the old defect returning.
  const lines = (s: string): number => s.split('\n').length;
  ok(lines(code) > lines(SERVER) * 0.55,
    'server.ts kept the code lines (only comment lines went)',
    `${lines(SERVER)} -> ${lines(code)}`);
  ok(!code.includes('AMEP engine (Interego is the reference implementation)'),
    'the comment banners themselves ARE gone');
}

// ── 3. the exploit, reconstructed ────────────────────────────────────────────
//
// This is the check that would have failed before the fix. `MIDDLEWARE` is the line that
// was inserted into server.ts at 12,264 during the audit; the CORS guard passed with it
// live in the file, and failed when the same line was placed 11,000 lines earlier.
{
  const SERVER = readFileSync(join(here, '..', 'server.ts'), 'utf8');
  const MIDDLEWARE =
    "app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Credentials', 'true'); next(); });\n";
  // The opener the audit used: a `//` comment whose text contains the two characters that
  // start a block comment. Anchored on the real text so a rewrite of that banner makes
  // this check fail loudly rather than silently stop testing anything.
  const OPENER = '// ── /amep/* — AMEP engine';
  const at = SERVER.indexOf(OPENER);
  ok(at > 0, `the phantom opener \`${OPENER}\` is still in server.ts`,
    'if the banner was reworded, re-anchor this check on another `//` line containing the two characters');
  if (at > 0) {
    const lineEnd = SERVER.indexOf('\n', at) + 1;
    const mutant = SERVER.slice(0, lineEnd) + MIDDLEWARE + SERVER.slice(lineEnd);

    ok(stripComments(mutant, 'server.ts').includes('Access-Control-Allow-Credentials'),
      '★ a real header line inserted after that comment SURVIVES stripping (the guard can see it)');

    // The old implementation, verbatim, kept here as the control. A fixture both
    // implementations pass would prove nothing about the change.
    const oldStripper = (src: string): string => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    ok(!oldStripper(mutant).includes('Access-Control-Allow-Credentials'),
      '★ …and the REGEX stripper loses it — which is the defect this file pins');
  }
}

console.log(failures === 0
  ? `\n${'-'.repeat(60)}\nstripComments: all checks passed.\n`
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
