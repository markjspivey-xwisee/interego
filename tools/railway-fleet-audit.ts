/**
 * The fleet-wide audit: is every service running the image master would build for it?
 *
 * ── WHY THIS EXISTS RATHER THAN `railway-pins.mjs --check` ───────────────────
 *
 * `--check` asks "is every pin the tip of master". In a repository that merges far more
 * often than it deploys, that question has no green answer, and a check with no green
 * answer stops being read. Measured twice on 2026-08-09, an hour apart:
 *
 *   · as the last step of a single-service deploy it failed a `discord` rollout because
 *     `css` was 46 commits behind, and had been dismissed twice in one session as "the
 *     documented always-red step" — while underneath that dismissal the relay was three
 *     commits of its own bundled code behind and fifteen services were pinned to images
 *     that had never been built at master at all;
 *
 *   · ★ and after the fleet was brought current and the audit was moved here to run on a
 *     schedule, commit 2ecd003 — which changed `.github/workflows/`, `tools/` and
 *     `tests/`, paths NO service bundles — turned all sixteen rows red again. Nothing was
 *     running stale code. The relocation had not cured the disease; it had moved it.
 *
 * So this asks the question that has an achievable green: for each service, does the
 * drift between its pin and master touch anything that service actually SHIPS?
 * `tools/deploy-bundle-scope.ts` answers that from the service's own Dockerfile, and its
 * `refineFreshness` is the SAME per-row function the scoped deploy gate uses — the two
 * cannot disagree about a service.
 *
 * ── THIS IS NOT A SOFTENING ──────────────────────────────────────────────────
 *
 * No axis is dropped and no threshold is introduced. `hasDisagreement` is called
 * unmodified, on every row, and reports MISMATCH, MISSING, UNTRACKED, ERROR, DIVERGED,
 * UNKNOWN-COMMIT, STALE-DEPLOY, UNVERIFIED, BELOW-FLOOR, UNKNOWN-FLOOR, UNPARSED and
 * every singleton violation exactly as before. The single change is that a `BEHIND` row
 * whose shipped files are byte-identical to master's reads `equivalent` — and that
 * downgrade requires a CONFIDENT parse of the Dockerfile plus an EMPTY diff, with every
 * uncertainty (an unreadable Dockerfile, an unrecognised COPY form, an untracked COPY
 * source, a failed git command, a pin that is DIVERGED or UNKNOWN) resolving to "still
 * behind". It can only ever turn a red green when the image would be identical, and it
 * fails closed in every other case.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=... npx tsx tools/railway-fleet-audit.ts
 *
 * Exit codes: 0 the fleet agrees · 1 some service disagrees · 2 usage/auth.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refineFreshness } from './deploy-bundle-scope.js';
import type { RefinedRow } from './deploy-bundle-scope.js';
import { collectPins, gitFacts, hasDisagreement, railwayGql } from './railway-pins.mjs';
import { singletonViolations } from './railway-services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function token(): string {
  const fromEnv = process.env['RAILWAY_PROJECT_TOKEN'];
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(ROOT, '.interego', 'railway-token.txt'), 'utf8').trim();
  } catch {
    process.stderr.write('RAILWAY_PROJECT_TOKEN is not set and .interego/railway-token.txt is unreadable.\n');
    process.exit(2);
  }
}

const gql = railwayGql(token());
const result = await collectPins(gql, gitFacts(ROOT));
const rows: RefinedRow[] = result.rows.map((r) => refineFreshness(r, ROOT));

const pad = (s: string, n: number): string => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n));
process.stdout.write(`project ${result.project}\n\n`);
process.stdout.write(`${pad('SERVICE', 20)}${pad('PIN', 14)}${pad('FRESH', 14)}SHIPPED-FILES-CHANGED\n`);

const bad: RefinedRow[] = [];
for (const row of rows) {
  const changed = row.bundleChanged?.length ?? 0;
  const note = row.freshness === 'equivalent'
    ? `none (${row.behind} commit(s) behind, none of them its own)`
    : row.freshness === 'current' ? '—'
      : row.freshness === 'BEHIND' ? `${changed}${row.bundleReason && changed === 0 ? ' (unresolved)' : ''}`
        : '';
  process.stdout.write(
    `${pad(row.service, 20)}${pad((row.tag ?? 'none').slice(0, 12), 14)}${pad(row.freshness ?? '?', 14)}${note}\n`);
  if (hasDisagreement([row])) bad.push(row);
}

if (bad.length === 0) {
  process.stdout.write('\nEvery service is running the image master would build for it.\n');
  process.exit(0);
}

process.stderr.write(`\n★ ${bad.length} service(s) disagree with what this repository asserts:\n\n`);
for (const row of bad) {
  process.stderr.write(`  ${row.service}\n`);
  if (row.error) process.stderr.write(`    unreadable: ${row.error}\n`);
  if (row.agreement && row.agreement !== 'ok') process.stderr.write(`    repo agreement: ${row.agreement}\n`);
  if (row.freshness === 'BEHIND') {
    const changed = row.bundleChanged ?? [];
    process.stderr.write(
      `    BEHIND by ${row.behind} commit(s), and ${changed.length} file(s) it ships have changed:\n`);
    for (const f of changed.slice(0, 10)) process.stderr.write(`      ${f}\n`);
    if (changed.length > 10) process.stderr.write(`      … +${changed.length - 10} more\n`);
    if (changed.length === 0 && row.bundleReason) {
      process.stderr.write(`      (could not be cleared: ${row.bundleReason})\n`);
    }
    process.stderr.write(`    fix: build the image at master, then node tools/railway-redeploy.mjs ${row.service} <sha>\n`);
  }
  if (row.freshness === 'DIVERGED' || row.freshness === 'UNKNOWN-COMMIT') {
    process.stderr.write(
      `    ${row.freshness} — the pin's place in history could not be established, so no bundle\n`
      + '    comparison can clear it. A shallow checkout does this; so does a rewritten history.\n');
  }
  if (row.deployAgreement === 'STALE-DEPLOY') {
    process.stderr.write('    the live deployment PREDATES the pinned commit — the pin was written but never shipped\n');
  }
  if (row.deployAgreement === 'UNVERIFIED') process.stderr.write('    the deploy axis could not be verified\n');
  if (row.limitVerdict && row.limitVerdict !== 'ok' && row.limitVerdict !== 'none') {
    process.stderr.write(`    limits ${row.limitVerdict}: ${row.limitReason ?? ''}\n`);
  }
  for (const v of singletonViolations([row])) {
    process.stderr.write(`    singleton: ${v.setting} = ${v.live ?? '(unset)'}, want ${v.want ?? 'unset'} — ${v.why}\n`);
    process.stderr.write('    fix: npx tsx tools/railway-singleton-settings.ts --apply\n');
  }
}
process.stderr.write('\nFull live table: node tools/railway-pins.mjs\n');
process.exit(1);
