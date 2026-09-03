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
 * ── ★★ AND IT NOW ASKS THE SERVICES, BECAUSE IT USED TO REPORT THE PIN ───────
 *
 * OBSERVED during the 2026-08-29 rollout: this tool printed "Every service is running the
 * image master would build for it." and exited 0 while `bridge` was serving the PREVIOUS
 * commit — and the new axis was then DRIVEN against the live fleet with that row's tag
 * rewritten in memory, where the real /health answer made it NOT-RUNNING.
 *
 * Every axis above is a statement about the POINTER — `tools/railway-pins.mjs` showed
 * bridge as DEPLOYING with FRESH=current, and "current" means Railway is pointed at the
 * right image, not that a container built from it is answering. Nothing here had ever
 * asked a service what it was running, and the headline claimed the answer.
 *
 * `tools/railway-running-build.ts` adds that axis, using the SAME derivation and the SAME
 * predicate `tools/railway-redeploy.mjs` §7a uses at deploy time — the service's own
 * /health `build` field, at a URL derived by `verifyUrlFor()` from Railway's `domains`
 * answer, never typed. It distinguishes three live states, which the pin axis alone cannot:
 *
 *     running     · asked, and it answered with the build its pin names
 *     ROLLING     · asked, answered with something else, and a deploy is IN FLIGHT
 *     NOT-RUNNING · asked, answered with something else, and the deployment has settled —
 *                   the pointer moved and the container did not
 *
 * plus `unaskable` for the four services that have no such surface at all (`css` and
 * `discord` bind no reachable health path; `postgres` and `redis` are upstream images).
 * Those are named, are excluded from the green sentence rather than folded into it, and
 * are NOT disagreements — four rows that can never go green is the permanent red this
 * workflow was split out to escape.
 *
 * ★ IT IS DELIBERATELY NOT IN `hasDisagreement`, AND `tools/railway-deploy-check.ts` DOES
 * NOT GAIN IT. `hasDisagreement` is a PURE fold over a row that several callers apply with
 * no network at all (`railway-pins.mjs --check` holds no health URL and makes no HTTP
 * request), and `tests/railway-scoped-check-is-not-weaker.test.ts` pins it as exactly the
 * disjunction of its per-row verdicts. Reaching out to a service from inside it would break
 * both. The scoped deploy gate does not need it either: `railway-redeploy.mjs` §7a has just
 * polled that one service's /health until it reported the sha, or §7b its boot line, and
 * refused to exit 0 otherwise. Adding a second copy of that poll to the gate that runs
 * immediately after it would assert the same thing twice, which is how one of the two
 * quietly becomes the weaker one.
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
import type { PinRow } from './railway-pins.mjs';
import { askRunningBuilds, isRunningDisagreement, runningHeadline } from './railway-running-build.js';
import type { RunningReport } from './railway-running-build.js';
import { singletonViolations } from './railway-services.mjs';
import { verifyByDigest, isDigestDisagreement, digestHeadline } from './railway-image-digest.js';
import type { DigestReport } from './railway-image-digest.js';

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

/**
 * The hosts Railway reports for ONE service.
 *
 * `projectId` is REQUIRED on this query — omitting it returns a GraphQL error rather than
 * an empty list — and the custom domain comes first because `verifyUrlFor` takes hosts[0],
 * which is the same order tools/railway-redeploy.mjs §1b builds.
 *
 * It THROWS rather than returning [] on a failed query, and that distinction is the point:
 * an empty list means "this service has no domain", which is a real and different finding
 * from "Railway would not tell us". Collapsing them prints a confident wrong reason.
 */
async function domainsFor(row: PinRow): Promise<string[]> {
  const d = await gql(
    'query($p:String!,$s:String!,$e:String!){ domains(projectId:$p,serviceId:$s,environmentId:$e){'
    + ' serviceDomains{ domain } customDomains{ domain } } }',
    { p: result.projectId, s: row.serviceId, e: result.environmentId }) as {
      domains?: { serviceDomains?: { domain?: string }[]; customDomains?: { domain?: string }[] };
    };
  return [
    ...(d?.domains?.customDomains ?? []),
    ...(d?.domains?.serviceDomains ?? []),
  ].map((x) => String(x?.domain ?? '')).filter(Boolean);
}

const running: RunningReport[] = await askRunningBuilds(rows, domainsFor);
const runningOf = new Map(running.map((r) => [r.service, r]));

/**
 * ★ THE THIRD AXIS, FOR THE SERVICES THE SECOND ONE CANNOT REACH.
 *
 * `askRunningBuilds` reports `unaskable` for css and discord, which bind no reachable health
 * path, and that was previously the end of it: two rows permanently outside every claim this
 * tool makes. They can still be checked, just not by asking them - Railway records the digest
 * it resolved for the live container, and GHCR serves the digest for the pinned tag.
 *
 * Only rows pinned to a sha of an image THIS repository builds are eligible. postgres and
 * redis are upstream images with no build of ours to compare against and stay `n/a`; a mutable
 * tag would compare a moving target and is left alone for the reason its own block already
 * gives. Everything else - no token, no digest, an unreachable registry - reports
 * `digest-unavailable` WITH the reason and is never counted as covered.
 */
// ★ `tagKind`, NOT `kind`. The first version of this filter read `row.kind`, which no row
// carries, so every service failed the test and the pass silently checked NOTHING while the
// audit printed a clean run - the exact fail-open this file exists to catch, in the code added
// to close a hole. The `eligibleButUnchecked` line below is why that cannot recur silently.
const digestEligible = rows.filter((row) =>
  runningOf.get(row.service)?.verdict === 'unaskable'
  && row.tagKind === 'sha'
  && row.builtHere !== false);
const digests: DigestReport[] = [];
for (const row of digestEligible) {
  digests.push(await verifyByDigest(
    gql,
    { service: row.service, deployId: row.deployId, repo: row.repo, tag: row.tag, kind: row.tagKind },
    process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'],
  ));
}
const digestOf = new Map(digests.map((d) => [d.service, d]));


const pad = (s: string, n: number): string => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n));
process.stdout.write(`project ${result.project}\n\n`);
process.stdout.write(
  `${pad('SERVICE', 20)}${pad('PIN', 14)}${pad('FRESH', 14)}${pad('RUNNING', 18)}SHIPPED-FILES-CHANGED\n`);

const bad: RefinedRow[] = [];
for (const row of rows) {
  const changed = row.bundleChanged?.length ?? 0;
  const note = row.freshness === 'equivalent'
    ? `none (${row.behind} commit(s) behind, none of them its own)`
    : row.freshness === 'current' ? '—'
      : row.freshness === 'BEHIND' ? `${changed}${row.bundleReason && changed === 0 ? ' (unresolved)' : ''}`
        : '';
  const run = runningOf.get(row.service);
  // An unaskable row prints what the digest axis found instead of `unaskable`, so the column
  // never reads as "nothing is known" about a service something IS known about.
  const dig = digestOf.get(row.service);
  const verdict = (run?.verdict === 'unaskable' && dig) ? dig.verdict : (run?.verdict ?? '?');
  process.stdout.write(
    `${pad(row.service, 20)}${pad((row.tag ?? 'none').slice(0, 12), 14)}${pad(row.freshness ?? '?', 14)}`
    + `${pad(verdict, 18)}${note}\n`);
  if (hasDisagreement([row])
    || (run !== undefined && isRunningDisagreement(run))
    || (dig !== undefined && isDigestDisagreement(dig))) bad.push(row);
}

/**
 * WHY EACH UNASKABLE SERVICE COULD NOT BE ASKED — printed on BOTH exit paths.
 *
 * Naming them is not enough on its own. An operator who reads "css and discord were not
 * asked" and is not told WHY has to go and find out, and the finding-out is where somebody
 * decides to give one of them a health path and reintroduces a documented outage (css 500s
 * on any Host but its internal one). The reason travels with the name.
 */
function writeUnasked(write: (s: string) => void): void {
  const unasked = running.filter((r) => r.verdict === 'unaskable');
  if (!unasked.length) return;
  write(`\n${unasked.length} service(s) could not be asked what they are running:\n`);
  for (const r of unasked) {
    // ★ SAY WHAT DID COVER IT. Listing a service here under "could not be asked" while the
    // digest axis has just verified it reads as an open hole, and an operator who believes
    // that goes looking for one. The reason for not being ASKABLE still travels with the
    // name - that is why this block exists - but it is no longer the last word.
    const d = digestOf.get(r.service);
    write(`  ${pad(r.service, 12)}${r.reason}\n`);
    if (d) write(`  ${pad('', 12)}└ ${d.verdict}: ${d.reason}\n`);
  }
}

if (bad.length === 0) {
  // ★ TWO SENTENCES, ONE PER AXIS THAT ACTUALLY CHECKED SOMETHING. The old single line —
  // "Every service is running the image master would build for it." — was one claim
  // covering two questions, and the tool had only ever asked the first of them. The pin
  // sentence is what `hasDisagreement` + `refineFreshness` established over every row; the
  // running sentence is built by runningHeadline() from the reports themselves and names
  // the services it could not ask rather than absorbing them.
  process.stdout.write(
    '\nEvery pin is master, or differs from master only in files that service does not ship.\n');
  process.stdout.write(`${runningHeadline(running, new Set(digests.filter((d) => d.verdict !== 'digest-unavailable').map((d) => d.service)))}\n`);
  const dh = digestHeadline(digests);
  if (dh) process.stdout.write(`${dh}\n`);
  writeUnasked((s) => process.stdout.write(s));
  process.exit(0);
}

process.stderr.write(`\n★ ${bad.length} service(s) disagree with what this repository asserts:\n\n`);
for (const row of bad) {
  process.stderr.write(`  ${row.service}\n`);
  if (row.error) process.stderr.write(`    unreadable: ${row.error}\n`);
  // A row can be here BECAUSE of the digest axis, and a failure that does not name its
  // own reason sends the reader to the wrong check.
  const dg = digestOf.get(row.service);
  if (dg && isDigestDisagreement(dg)) process.stderr.write(`    ${dg.verdict}: ${dg.reason}\n`);
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
  const run = runningOf.get(row.service);
  if (run !== undefined && isRunningDisagreement(run)) {
    process.stderr.write(`    ${run.verdict}: ${run.reason}\n`);
    if (run.verdict === 'NOT-RUNNING') {
      process.stderr.write(
        `    fix: confirm ${row.tag?.slice(0, 12)} was actually PUSHED, then\n`
        + `         node tools/railway-redeploy.mjs ${row.service} ${row.tag}\n`);
    }
    if (run.verdict === 'UNREACHABLE') {
      process.stderr.write('    a service that cannot be asked cannot be reported as fine. Check whether it is\n'
        + '    answering at all: node tools/fleet-liveness.mjs\n');
    }
  }
  if (row.limitVerdict && row.limitVerdict !== 'ok' && row.limitVerdict !== 'none') {
    process.stderr.write(`    limits ${row.limitVerdict}: ${row.limitReason ?? ''}\n`);
  }
  for (const v of singletonViolations([row])) {
    process.stderr.write(`    singleton: ${v.setting} = ${v.live ?? '(unset)'}, want ${v.want ?? 'unset'} — ${v.why}\n`);
    process.stderr.write('    fix: npx tsx tools/railway-singleton-settings.ts --apply\n');
  }
}

// An operator reading a failure still needs to know which services this run could NOT ask:
// they are not covered by the findings above any more than they were by the green sentence.
writeUnasked((s) => process.stderr.write(s));
process.stderr.write('\nFull live table: node tools/railway-pins.mjs\n');
process.exit(1);
