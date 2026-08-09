/**
 * The post-deploy assertion, scoped to the service that was just deployed.
 *
 * ── THE PROBLEM THIS FIXES ───────────────────────────────────────────────────
 *
 * `.github/workflows/deploy-railway.yml` ended with `node tools/railway-pins.mjs --check`,
 * a FLEET-WIDE audit, as the last step of a SINGLE-SERVICE deploy. Two things followed
 * from that shape, and both of them happened.
 *
 * 1. It failed deploys for reasons that had nothing to do with the deploy. A rollout of
 *    `discord` went red because `css` was 46 commits behind. The step's own comment
 *    conceded the point — "Expect it to be red whenever master has moved past the tag
 *    just deployed … That is the tool working" — which is an accurate description of a
 *    fleet audit and a disqualifying one for a gate. `--check` asks "is production
 *    running master"; one commit after any merge the honest answer is no, so the step was
 *    red on a schedule set by other people's merges.
 *
 * 2. ★ A step that is EXPECTED to be red is not read. Measured on 2026-08-09: this step
 *    had been failing on every deploy for at least two runs and was dismissed twice in
 *    one session as "the documented always-red step". Underneath that dismissal the relay
 *    was genuinely three commits of its own bundled code behind master, and fifteen
 *    services were pinned to images that had never been built at master at all — the
 *    exact condition the check exists to surface, invisible because the check was already
 *    red for a reason everyone had agreed to ignore.
 *
 * ── WHY THIS IS NOT A WEAKENING ──────────────────────────────────────────────
 *
 * It applies the SAME predicate to a SUBSET. `hasDisagreement` and `singletonViolations`
 * are imported from tools/railway-pins.mjs and tools/railway-services.mjs and called on a
 * one-row array; there is no second copy of the rule here that could drift from the
 * fleet's, and no axis is dropped, softened or thresholded. A service that would fail the
 * fleet audit fails this too, whenever it is the service being deployed.
 *
 * What changes is WHOSE deploy a given service's drift can stop: its own. The fleet-wide
 * question did not go away and did not get easier — it moved to
 * `.github/workflows/railway-fleet-audit.yml`, where it runs on a schedule, is allowed to
 * be red about the fleet, and blocks nobody's rollout. Two different questions, asked
 * separately, each able to be answered honestly.
 *
 * ── WHY IT STILL COLLECTS THE WHOLE FLEET ────────────────────────────────────
 *
 * `collectPins` reads every service and this then filters to one. Asking Railway for a
 * single service would be fewer round trips and would lose the two cross-service facts
 * the row-level verdicts are built from: `agreement` compares Railway's service list
 * against tools/railway-services.mjs, so a service that exists in one and not the other is
 * only visible from the full list. Filtering after the fact keeps those verdicts intact.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=... npx tsx tools/railway-deploy-check.ts <service>
 *
 * Exit codes: 0 agrees · 1 this service disagrees · 2 usage/auth/unknown service.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refineFreshness } from './deploy-bundle-scope.js';
import type { RefinedRow } from './deploy-bundle-scope.js';
import { collectPins, gitFacts, hasDisagreement, railwayGql } from './railway-pins.mjs';
import { serviceNames, singletonViolations } from './railway-services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const service = process.argv[2];
if (!service || service.startsWith('-')) {
  process.stderr.write(
    `usage: railway-deploy-check.ts <service>\nvalid: ${serviceNames().join(', ')}\n`);
  process.exit(2);
}

// Object.hasOwn rather than a plain read, for the reason railway-services.mjs gives:
// `constructor` is a plausible-looking service name that a property read answers with a
// function, and an unknown service must be a refusal rather than a pass.
if (!serviceNames().includes(service)) {
  process.stderr.write(
    `unknown Railway service "${service}".\nvalid: ${serviceNames().join(', ')}\n`);
  process.exit(2);
}

/**
 * Same precedence as tools/railway-pins.mjs: the env var first so CI needs no file, the
 * checked-in token path second so a local run needs no export.
 */
function token(): string {
  const fromEnv = process.env['RAILWAY_PROJECT_TOKEN'];
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(join(ROOT, '.interego', 'railway-token.txt'), 'utf8').trim();
  } catch {
    process.stderr.write(
      'RAILWAY_PROJECT_TOKEN is not set and .interego/railway-token.txt is unreadable.\n'
      + 'A Railway PROJECT token is required (not an account token: an account token '
      + 'answers 200 with "Project Token not found", which looks like sending nothing).\n');
    process.exit(2);
  }
}

/** Every reason this row disagrees, in the words the fleet report uses. */
function reasons(row: RefinedRow): string[] {
  const out: string[] = [];
  if (row.error) out.push(`could not be read from Railway: ${row.error}`);
  if (row.agreement && row.agreement !== 'ok') {
    out.push(`repo agreement ${row.agreement} (expected ${row.expectedRepo ?? '?'}, live ${row.repo ?? 'none'})`);
  }
  if (row.freshness === 'BEHIND') {
    const n = row.bundleChanged?.length ?? 0;
    out.push(
      `pinned commit is BEHIND master by ${row.behind} commit(s) — production is not running the code that was merged`
      + (row.bundleReason && n === 0
        ? `\n      (and the bundle comparison could not clear it: ${row.bundleReason})`
        : `\n      files this service ships that changed since the pin (${n}): `
          + `${(row.bundleChanged ?? []).slice(0, 8).join(', ')}${n > 8 ? `, +${n - 8} more` : ''}`));
  }
  if (row.freshness === 'DIVERGED') out.push('pinned commit is not an ancestor of master');
  if (row.freshness === 'UNKNOWN-COMMIT') {
    out.push('pinned commit is not in this clone — the deploy checkout needs full history (fetch-depth: 0)');
  }
  if (row.deployAgreement === 'STALE-DEPLOY') {
    out.push('the live deployment PREDATES the pinned commit, so the container cannot be running it — the pin was written but never shipped');
  }
  if (row.deployAgreement === 'UNVERIFIED') out.push('the deploy axis could not be verified');
  if (row.limitVerdict && row.limitVerdict !== 'ok' && row.limitVerdict !== 'none') {
    out.push(`resource limits ${row.limitVerdict}: ${row.limitReason ?? 'no reason given'}`);
  }
  for (const v of singletonViolations([row])) {
    out.push(`singleton invariant: ${v.service}.${v.setting} = ${v.live ?? '(unset)'}, want ${v.want ?? 'unset'} — ${v.why}`);
  }
  return out;
}

const gql = railwayGql(token());
const result = await collectPins(gql, gitFacts(ROOT));
const found = result.rows.find((r) => r.service === service);

// ★ "BEHIND master" is not the same question as "running stale code", and asking the
// first one turned this check red on every merge — see refineFreshness. The refinement
// can only ever DOWNGRADE a red, and only on a confident, empty diff of the paths this
// service's own Dockerfile copies.
const row: RefinedRow | undefined = found ? refineFreshness(found, ROOT) : undefined;

if (!row) {
  process.stderr.write(
    `"${service}" is declared in tools/railway-services.mjs but Railway did not report it.\n`
    + 'That is itself a disagreement — the service was renamed or deleted.\n');
  process.exit(1);
}

const tag = row.tag ? `${row.tagKind === 'sha' ? '' : '★'}${row.tag}` : '(none)';
process.stdout.write(
  `${service}: ${row.repo ?? '(no image)'} @ ${tag}\n`
  + `  deployed ${row.status ?? '?'} ${(row.deployedAt ?? '').slice(0, 10)}`
  + `  freshness ${row.freshness ?? '?'}  agreement ${row.agreement ?? '?'}`
  + `  deploy ${row.deployAgreement ?? '?'}  limits ${row.limitVerdict ?? '?'}\n`);

// ★ THE FLEET'S OWN PREDICATE, ON A ONE-ROW ARRAY. Not a reimplementation of it. If
// hasDisagreement gains an axis, this gains it too, with no edit here — which is the
// property that makes scoping safe rather than a quiet exemption.
if (hasDisagreement([row])) {
  process.stderr.write(`\n★ ${service} disagrees with what this repository asserts:\n`);
  for (const r of reasons(row)) process.stderr.write(`  - ${r}\n`);
  process.stderr.write(
    '\nThis is scoped to the service just deployed. For the whole fleet run\n'
    + '  node tools/railway-pins.mjs --check\n'
    + 'or read the latest .github/workflows/railway-fleet-audit.yml run.\n');
  process.exit(1);
}

if (row.freshness === 'equivalent') {
  process.stdout.write(`  ${row.bundleReason}\n`);
}
process.stdout.write(`\n${service} agrees with master on every axis.\n`);
