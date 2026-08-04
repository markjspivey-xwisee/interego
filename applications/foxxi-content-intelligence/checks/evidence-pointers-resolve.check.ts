/**
 * A learner record may not cite evidence that cannot be fetched.
 *
 * ★ WHY. `record_performance` answered `recorded: true` with an xAPI statement id for
 * a statement the LRS had REFUSED. Confirmed against the deployed bridge:
 *
 *   activity_type "production-incident-command"   (a bare slug)
 *     -> recorded: true, statementId: 2a7ea855…
 *     -> GET /xapi/statements?statementId=2a7ea855…  ->  404 "statement not found"
 *
 *   activity_type "<bridge>/ns/foxxi/competency/production-incident-command"  (an IRI)
 *     -> recorded: true
 *     -> GET /xapi/statements?statementId=266e0956…  ->  200
 *
 * xAPI requires object.definition.type to be an IRI. A bare slug produced a
 * non-conformant statement, storeStatementInternal correctly refused to store it —
 * and then returned the id anyway, so the refusal was invisible at every layer a
 * caller can see. The assembled IEEE P2997 record went on to advertise
 *
 *   rawDataLocation = <bridge>/xapi/statements?statementId=<that id>
 *
 * as the evidence for the performance it counted. A relying party following that
 * pointer during due diligence gets a 404 and cannot distinguish "fabricated" from
 * "stored somewhere else" — the one question the pointer exists to settle. That is
 * the same dangling-reference class as the acme-id pim:storage fix, but sitting in
 * the evidence chain of a credential.
 *
 * Source-level assertions: a pull request must not fail because production has not
 * yet received the fix it contains, and the property — "a refused statement yields
 * no id, and an invalid activity_type is rejected before anything is minted" — is
 * visible here. It is also the layer that would have caught it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(join(ROOT, 'bridge', 'server.ts'), 'utf8');
const lrs = readFileSync(join(ROOT, 'src', 'xapi-lrs.ts'), 'utf8');

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('\nevidence pointers: a record may not cite what a verifier cannot fetch');

// ── 1. The enabler ─────────────────────────────────────────────────────────
const storeFn = lrs.slice(
  lrs.indexOf('export function storeStatementInternal'),
  lrs.indexOf('export function storeStatementInternal') + 2200,
);
check('storeStatementInternal can signal refusal', /:\s*string \| null/.test(storeFn));
check('a refused statement returns null, not its id',
  /REJECTED non-conformant statement[\s\S]{0,260}return null;/.test(storeFn),
  'returning the id is what made the refusal invisible');

// ── 2. Callers must not report a refused statement as recorded ─────────────
// ★ PER SURFACE, NOT PER REPO. This loop counted the marker across the WHOLE of
// server.ts and asserted `count >= 1` once per label — and both rows carried the
// SAME marker string, so the two iterations read the identical number and neither
// could tell the two surfaces apart. Measured against the real sources: deleting the
// refusal from ONE surface left every line of this file green, which is the exact
// failure the sibling check below ("fixing one surface leaves the other minting
// dangling pointers") exists to name. Each surface is now sliced out by its own
// anchor, so the assertion is about that surface's body and nothing else.
//
// `as const` is load-bearing under noUncheckedIndexedAccess: without it TypeScript widens
// these rows to `string[]`, destructuring yields `string | undefined`, and `indexOf(open)`
// has no matching overload.
for (const [label, open, close] of [
  ['foxxi.record_performance', "'foxxi.record_performance': async", "\n  'foxxi."],
  ['/agent/record-performance', "app.post('/agent/record-performance'", '\napp.'],
] as const) {
  const from = server.indexOf(open);
  const to = server.indexOf(close, from + open.length);
  const body = from === -1 ? '' : server.slice(from, to === -1 ? undefined : to);
  // A slicing check whose anchor drifts silently degrades to an empty string and then
  // passes nothing. This makes anchor rot fail loudly instead of emptying the check.
  check(`${label} is present to be checked`, body.length > 0, `anchor ${open} not found`);
  check(`${label} refuses to claim success when nothing was stored`,
    body.includes('the performance was not recorded'));
}
check('both record-performance surfaces check the store result',
  (server.split('if (!statementId)').length - 1) >= 2,
  'fixing one surface leaves the other minting dangling pointers');

// ── 3. The invalid input is rejected BEFORE anything is minted ─────────────
// The published contract already says activity_type is an IRI. The defect was
// accepting a non-IRI silently, not documenting it wrongly.
const iriGuards = server.split('activity_type must be an IRI').length - 1;
check('both surfaces reject a non-IRI activity_type', iriGuards >= 2, `found ${iriGuards}`);
check('the rejection names a usable replacement',
  /ns\/foxxi\/competency\/\$\{/.test(server),
  'an error that does not say what to send instead just moves the guessing');

// ── 4. Other internal emitters must not push a null id ─────────────────────
// cmi5 traces and SCORM completion both collect ids into arrays that are handed
// back to callers; a null in those arrays is the same lie in a different shape.
check('the cmi5 trace only collects stored ids', /if \(cmi5Id\) statementIds\.push\(cmi5Id\)/.test(server));
check('SCORM completion only collects stored ids', /if \(sid\) ids\.push\(sid\)/.test(server));

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nA statement that was refused yields no id, and no record cites one.\n');
