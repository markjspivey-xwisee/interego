/**
 * Make the singleton invariant a SETTING instead of a platform default.
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 *
 * `tools/railway-services.mjs` declares `css` a singleton: exactly one container may
 * exist, because two containers run two independent process-local resource lockers over
 * one shared Postgres-backed store, so CSS's If-Match read-modify-write (the relay's
 * manifest compare-and-swap) can have BOTH pass the precondition and both write — a lost
 * update that answers 200.
 *
 * `singletonViolations()` has reported `css.numReplicas = (unset)` and
 * `css.overlapSeconds = (unset)` since the declaration was written, and it was RIGHT to:
 * unset means the invariant is upheld by Railway's default of one replica rather than by
 * anybody's decision, and no reader can tell a decision from an accident. But nothing in
 * this repository could WRITE the setting — `railway-pins.mjs` mutates nothing on
 * purpose, and `railway-redeploy.mjs` only writes the image pin — so the report was a
 * permanent red with no path to green. A finding with no remedy is how a check stops
 * being read; measured on 2026-08-09, this one had been part of a deploy step dismissed
 * twice in a single session as "the documented always-red step".
 *
 * This closes it from the correct end: the value gets SET, rather than the check being
 * taught to accept unset.
 *
 * ── WHY THIS IS NOT A DEPLOY ─────────────────────────────────────────────────
 *
 * `serviceInstanceUpdate` is a CONFIG write. Shipping an image needs
 * `serviceInstanceDeployV2` as well — see the "REDEPLOY ≠ DEPLOY" section of
 * tools/railway-redeploy.mjs — and that mutation is deliberately absent from this file.
 * ★ That matters most for the one service this tool is for: `css` holds every pod's data,
 * and a css deploy opens Railway's start-new-before-stopping-old window, which is exactly
 * the two-container state the invariant exists to prevent. Writing `overlapSeconds: 0`
 * SHRINKS that window on the next deploy; triggering a deploy to write it would open it.
 *
 * ── WHY IT REFUSES EVERYTHING NOT DECLARED A SINGLETON ───────────────────────
 *
 * The service list and the wanted values are read from `SERVICES`, never from argv. A
 * `--num-replicas` flag on a tool holding a project token is a scale-down of the wrong
 * service one typo away, and the values here are not preferences — `numReplicas: 1` is a
 * correctness requirement with a written reason next to it.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=... npx tsx tools/railway-singleton-settings.ts          # plan
 *   RAILWAY_PROJECT_TOKEN=... npx tsx tools/railway-singleton-settings.ts --apply  # write
 *
 * Exit codes: 0 nothing to do, or applied · 1 drift found while planning · 2 usage/auth.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { railwayGql } from './railway-pins.mjs';
import { SERVICES, singletonViolations } from './railway-services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

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

const pt = await gql('{ projectToken { projectId environmentId } }') as {
  projectToken?: { projectId?: string; environmentId?: string };
};
const projectId = pt?.projectToken?.projectId;
const environmentId = pt?.projectToken?.environmentId;
if (!projectId || !environmentId) {
  process.stderr.write('projectToken returned no project/environment — is this an ACCOUNT token rather than a PROJECT token?\n');
  process.exit(2);
}

const proj = await gql(
  'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }',
  { id: projectId }) as { project?: { services?: { edges?: { node: { id: string; name: string } }[] } } };
const byName = new Map<string, string>();
for (const e of proj?.project?.services?.edges ?? []) byName.set(e.node.name, e.node.id);

/** The services this repository declares must be held to exactly one container. */
const singletons = Object.keys(SERVICES).filter((s) => SERVICES[s]?.singleton === true);
if (singletons.length === 0) {
  process.stdout.write('no service is declared `singleton` in tools/railway-services.mjs — nothing to enforce.\n');
  process.exit(0);
}

let drift = 0;
let wrote = 0;

for (const service of singletons) {
  const decl = SERVICES[service];
  const serviceId = byName.get(service);
  if (!serviceId || !decl) {
    process.stderr.write(`★ ${service}: declared a singleton here but Railway does not report it.\n`);
    drift += 1;
    continue;
  }

  const d = await gql(
    'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ numReplicas overlapSeconds drainingSeconds } }',
    { s: serviceId, e: environmentId }) as {
      serviceInstance?: { numReplicas?: number | null; overlapSeconds?: number | null; drainingSeconds?: number | null };
    };
  const si = d?.serviceInstance;
  const live = {
    service,
    numReplicas: si?.numReplicas ?? null,
    overlapSeconds: si?.overlapSeconds ?? null,
    drainingSeconds: si?.drainingSeconds ?? null,
  };

  // ★ THE SAME PREDICATE THE REPORT USES, not a second opinion about what is wrong.
  const violations = singletonViolations([live]);
  process.stdout.write(
    `${service}: numReplicas=${live.numReplicas ?? '(unset)'} `
    + `overlapSeconds=${live.overlapSeconds ?? '(unset)'} `
    + `drainingSeconds=${live.drainingSeconds ?? '(unset)'}\n`);

  if (violations.length === 0) {
    process.stdout.write('  already a setting, not a default — nothing to write.\n');
    continue;
  }
  drift += violations.length;

  // Only the two settings that HAVE a wanted value are writable. `drainingMustBeUnset` is
  // a violation this tool reports and refuses to fix: Railway's API has no "unset", so
  // clearing it means writing some number, and every number LENGTHENS the two-container
  // window on a singleton. Reporting it and stopping is the honest move.
  const input: Record<string, number> = {};
  for (const v of violations) {
    process.stdout.write(`  ★ ${v.setting} = ${v.live ?? '(unset)'}, want ${v.want ?? 'unset'} — ${v.why}\n`);
    if (v.setting === 'numReplicas') input['numReplicas'] = 1;
    if (v.setting === 'overlapSeconds' && typeof decl.maxOverlapSeconds === 'number') {
      input['overlapSeconds'] = decl.maxOverlapSeconds;
    }
    if (v.setting === 'drainingSeconds') {
      process.stdout.write('    (not writable here — see the comment in this file: no value is safe to write)\n');
    }
  }

  if (Object.keys(input).length === 0) continue;
  if (!apply) {
    process.stdout.write(`  would write ${JSON.stringify(input)} (re-run with --apply)\n`);
    continue;
  }

  await gql(
    'mutation($s:String!,$e:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$in) }',
    { s: serviceId, e: environmentId, in: input });

  // Read it back. A Railway mutation answers 200 for a field it silently ignored, and an
  // unverified write to the invariant that protects every pod's data is worth nothing.
  const after = await gql(
    'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ numReplicas overlapSeconds drainingSeconds } }',
    { s: serviceId, e: environmentId }) as {
      serviceInstance?: { numReplicas?: number | null; overlapSeconds?: number | null; drainingSeconds?: number | null };
    };
  const back = {
    service,
    numReplicas: after?.serviceInstance?.numReplicas ?? null,
    overlapSeconds: after?.serviceInstance?.overlapSeconds ?? null,
    drainingSeconds: after?.serviceInstance?.drainingSeconds ?? null,
  };
  const still = singletonViolations([back]).filter((v) => v.setting !== 'drainingSeconds');
  process.stdout.write(
    `  wrote ${JSON.stringify(input)} → numReplicas=${back.numReplicas ?? '(unset)'} `
    + `overlapSeconds=${back.overlapSeconds ?? '(unset)'}\n`);
  if (still.length > 0) {
    process.stderr.write('  ★ Railway accepted the mutation but the value did not change — the write did NOT take.\n');
    process.exit(1);
  }
  wrote += Object.keys(input).length;
  drift -= Object.keys(input).length;
}

if (apply) {
  process.stdout.write(`\napplied ${wrote} setting(s).\n`);
  process.exit(drift > 0 ? 1 : 0);
}
process.exit(drift > 0 ? 1 : 0);
