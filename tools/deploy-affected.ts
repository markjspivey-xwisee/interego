/**
 * Which services does THIS commit actually need deployed — and which images must exist first.
 *
 * ── ★★ WHY AUTO-DEPLOY NEEDED A SCOPE AT ALL ─────────────────────────────────────────────────
 *
 * `deploy-railway.yml`'s header explains why deploying was manual: "Building is safe and
 * repeatable; deploying is neither." That reasoning is sound and it had a cost this repository
 * kept paying — measured twice in two days: sixteen services 65 commits behind on 2026-08-27, and
 * nine commits behind again on 2026-09-04, with seven of them genuinely shipping changed code
 * while the relay alone had been moved. Nothing was broken; nothing was current either.
 *
 * Auto-deploy is the maintainer's decision, and it does NOT mean "deploy everything on every
 * merge". Most merges touch `tools/`, `tests/` and `.github/` — paths no image bundles. Deploying
 * seventeen services for those is seventeen chances for a rollout to go wrong in exchange for
 * nothing, and `tools/deploy-bundle-scope.ts` already exists because that exact mistake made a
 * gate red on a schedule set by unrelated merges, which is how a check stops being read.
 *
 * So the question this answers is the one that file established as the right one: not "is the pin
 * the tip of master" but "would master build this service a DIFFERENT image than the one it runs".
 *
 * ── ★ THE UNDETERMINED CASE DEPLOYS, IT DOES NOT SKIP ────────────────────────────────────────
 *
 * `bundleDriftFor` reports `confident: false` when it cannot parse a service's bundle scope. The
 * tempting reading — "we could not tell, so leave it alone" — makes every unparseable Dockerfile a
 * silent deploy hole, and the drift it hides is invisible precisely because nothing reported it.
 * An unnecessary deploy is verified and reversible (the redeploy tool restores the pin on failure
 * and asserts the health endpoint names the new build); a skipped one is neither. So unknown means
 * INCLUDE, and the reason is printed.
 *
 * ── COMPARED AGAINST THE LIVE PIN, NOT THE PREVIOUS COMMIT ───────────────────────────────────
 *
 * The range is `<what this service is running> .. HEAD`, read from Railway. That makes the answer
 * self-healing: a service missed by an earlier run — because a deploy failed, or because
 * auto-deploy did not exist yet — is picked up by the next merge instead of drifting forever.
 * Diffing `before..after` of the push alone would carry the gap indefinitely.
 *
 *   RAILWAY_PROJECT_TOKEN=... npx tsx tools/deploy-affected.ts            # human summary
 *   RAILWAY_PROJECT_TOKEN=... npx tsx tools/deploy-affected.ts --github   # + GITHUB_OUTPUT
 */
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Typed by tools/railway-pins.d.mts and tools/railway-services.d.mts - no suppression needed.
import { railwayGql, collectPins, splitImage } from './railway-pins.mjs';
import { bundleDriftFor } from './deploy-bundle-scope.js';
import * as services from './railway-services.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** One service that must be rebuilt and redeployed, with the reason it is in the list. */
export interface AffectedService {
  readonly service: string;
  /** The GHCR image name, from the tracked table — `css` runs `interego-css-pgsl`. */
  readonly image: string;
  /** What the service runs right now. */
  readonly pin: string;
  /** Why it is included, in one line, for the workflow log. */
  readonly reason: string;
}

/**
 * A pin that is not a 40-hex commit is an upstream image (`postgres:16`, `redis:7-alpine`) that
 * this repository does not build. It cannot be "behind master" and must never be repointed.
 */
const isCommitPin = (tag: string): boolean => /^[0-9a-f]{40}$/.test(tag);

export function affectedServices(
  rows: readonly { service: string; tag: string; repo?: string }[],
  head = 'HEAD',
  root = ROOT,
): { affected: AffectedService[]; skipped: string[] } {
  const affected: AffectedService[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const image = imageFor(row.service);
    if (image === null) {
      skipped.push(`${row.service}: upstream image this repository does not build`);
      continue;
    }
    if (!isCommitPin(row.tag)) {
      skipped.push(`${row.service}: upstream image (${row.tag}) — this repository does not build it`);
      continue;
    }
    if (row.tag === headSha(root, head)) {
      skipped.push(`${row.service}: already running this commit`);
      continue;
    }

    const drift = bundleDriftFor(row.service, row.tag, root, head);

    if (!drift.confident) {
      // See the header: unknown INCLUDES. A scope this tool cannot read is not evidence of
      // "nothing changed", and treating it as such is a deploy hole with no symptom.
      affected.push({
        service: row.service, image, pin: row.tag,
        reason: `bundle scope could not be determined (${drift.reason ?? 'no reason given'}) — `
          + 'deploying rather than guessing',
      });
      continue;
    }
    if (drift.equivalent) {
      skipped.push(`${row.service}: behind, but ships nothing that changed`
        + `${drift.reason ? ` (${drift.reason})` : ''}`);
      continue;
    }
    affected.push({
      service: row.service, image, pin: row.tag,
      reason: `${drift.changed.length} shipped file(s) changed since ${row.tag.slice(0, 12)}`
        + `, e.g. ${drift.changed.slice(0, 3).join(', ')}`,
    });
  }
  return { affected, skipped };
}

/**
 * The GHCR image leg a service runs, from the tracked table.
 *
 * ★ ASKED, NEVER DERIVED. `interego-${service}` is right for sixteen rows and wrong for `css`
 * (`interego-css-pgsl`), and that inline derivation is precisely what railway-services.mjs was
 * created to delete. `repo: null` marks an upstream image this repository does not build.
 */
export function imageFor(service: string): string | null {
  const table = (services as { SERVICES: Record<string, { repo?: string | null }> }).SERVICES;
  return table[service]?.repo ?? null;
}

function headSha(root: string, head: string): string {
  return execFileSync('git', ['rev-parse', head], { cwd: root, encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const token = process.env['RAILWAY_PROJECT_TOKEN'];
  if (!token) {
    console.error('RAILWAY_PROJECT_TOKEN is not set — the live pins decide the scope, so this '
      + 'cannot be answered without it. Refusing rather than reporting an empty scope.');
    process.exit(2);
  }

  // `collectPins` answers { project, projectId, environmentId, rows }, and each row carries the
  // FULL image reference rather than a tag — `splitImage` is the one place that is taken apart,
  // because a digest pin (`repo@sha256:…`) and a tag pin are different shapes and deriving either
  // by hand is how `css` gets called `interego-css`.
  const pins = await collectPins(railwayGql(token)) as {
    rows?: { service: string; image: string | null }[];
  };
  const live = pins.rows ?? [];
  if (live.length === 0) {
    console.error('Railway returned no services. An empty scope would deploy NOTHING and look '
      + 'exactly like "nothing needed deploying", so this is a failure, not a quiet pass.');
    process.exit(2);
  }
  const rows = live.map((r) => ({ service: r.service, tag: splitImage(r.image).tag as string }));

  const head = headSha(ROOT, 'HEAD');
  const { affected, skipped } = affectedServices(rows, 'HEAD', ROOT);

  console.log(`head ${head}`);
  console.log(`\n${affected.length} service(s) need this commit:`);
  for (const a of affected) console.log(`  ${a.service.padEnd(20)} ${a.reason}`);
  console.log(`\n${skipped.length} service(s) do not:`);
  for (const s of skipped) console.log(`  ${s}`);

  if (process.argv.includes('--github')) {
    const out = process.env['GITHUB_OUTPUT'];
    if (!out) {
      console.error('--github was passed with no GITHUB_OUTPUT to write to.');
      process.exit(2);
    }
    // Two matrices from ONE decision: the images that must be built and the services that must be
    // deployed are the same set, and computing them separately is how a deploy reaches for a tag
    // no build produced — measured on 2026-09-04, when four bridges failed to repin because only
    // the relay leg had been built at that sha.
    const buildMatrix = { include: affected.map((a) => ({ image: a.image })) };
    const deployMatrix = { include: affected.map((a) => ({ service: a.service })) };
    appendFileSync(out, `count=${affected.length}\n`);
    appendFileSync(out, `build_matrix=${JSON.stringify(buildMatrix)}\n`);
    appendFileSync(out, `deploy_matrix=${JSON.stringify(deployMatrix)}\n`);
  }
}

if (process.argv[1] && fileURLToPath(new URL(`file://${process.argv[1].split('\\').join('/')}`))
  .endsWith('deploy-affected.ts')) {
  void main();
}
