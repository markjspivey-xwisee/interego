/**
 * Print the exact image reference a Railway service is running RIGHT NOW.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Because "roll it back" is a sentence, not a plan, until somebody can name the artefact.
 * `tools/railway-redeploy.mjs` restores the PIN automatically when a deployment reaches a
 * terminal failure, and that is the case it covers well. The case it cannot cover is the
 * one that matters on `css`: a deploy that Railway calls SUCCESS, that prints its boot
 * line, and whose new code is nonetheless wrong. Undoing that means deploying the previous
 * sha by hand — and the previous sha is held by exactly one system, Railway, in a field
 * nobody prints before they start.
 *
 * ── WHY IT IS SEPARATE FROM railway-redeploy.mjs ─────────────────────────────
 *
 * That tool mutates. This one is called BEFORE it, by a step that must be able to refuse,
 * and mixing a read-only mode into a deploy script means a `--dry-run` flag one typo away
 * from a real rollout. It is also what `.github/workflows/deploy-railway.yml` needs in
 * order to check the OUTGOING image against the registry, which is a `docker` call this
 * process has no credential for and no business making.
 *
 * ── WHY NOT collectPins() ────────────────────────────────────────────────────
 *
 * It answers this and eighteen other questions, over several round trips per service, and
 * a pre-deploy gate that takes half a minute is a gate people route around. The two
 * primitives it is built from — `railwayGql` and the tracked service table — are reused
 * here directly.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=... npx tsx tools/railway-current-image.ts css
 *
 * Prints one line: the full image reference, e.g.
 *   ghcr.io/markjspivey-xwisee/interego-css-pgsl:559eae5c06d448d8fc51226142caf70dda56346f
 *
 * Exit codes: 0 printed · 1 the service runs no image yet · 2 usage/auth/unknown service.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { railwayGql } from './railway-pins.mjs';
import { resolveImageRepo, serviceNames } from './railway-services.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const service = process.argv[2];

if (!service) {
  process.stderr.write(`usage: railway-current-image.ts <service>\nvalid: ${serviceNames().join(', ')}\n`);
  process.exit(2);
}
// Refused before any network call, with the list of valid names — the same rule
// railway-redeploy.mjs applies, because a name that merely LOOKS right is the whole
// population of names that get typed by mistake.
const declared = resolveImageRepo(service);
if (!declared.ok) {
  process.stderr.write(`${declared.reason}\n`);
  process.exit(2);
}

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
const matches = (proj?.project?.services?.edges ?? []).map((e) => e.node).filter((n) => n.name === service);
// Exactly one, insisted on rather than assumed: a filter that matches nothing yields
// undefined, and querying with an empty serviceId is a confusing runtime error instead of
// a clean refusal.
if (matches.length !== 1 || !matches[0]) {
  process.stderr.write(`expected exactly 1 service named "${service}", found ${matches.length}\n`);
  process.exit(2);
}

const si = await gql(
  'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ source{ image } } }',
  { s: matches[0].id, e: environmentId }) as { serviceInstance?: { source?: { image?: string | null } | null } };
const image = si?.serviceInstance?.source?.image;

if (!image) {
  // A first deploy, not an error state. The caller decides what that means: there is
  // nothing to roll back to because nothing is running, which is not the same as a
  // rollback target having gone missing.
  process.stderr.write(`"${service}" has no source image set — nothing is pinned yet.\n`);
  process.exit(1);
}

// ★ Reported, never silently accepted. A redeploy changes the TAG; it must never change
// which IMAGE runs, so a live repository that disagrees with the tracked table means one
// of the two is wrong and the caller is about to check the registry for the wrong package.
const liveRepo = String(image).replace(/:[^:/]*$/, '');
if (liveRepo !== declared.repo) {
  process.stderr.write(
    `★ "${service}" runs ${liveRepo}, but tools/railway-services.mjs declares ${declared.repo}.\n`);
  process.exit(2);
}

process.stdout.write(`${image}\n`);
