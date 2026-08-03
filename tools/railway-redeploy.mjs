#!/usr/bin/env node
/**
 * Repoint ONE Railway service at a new image tag, ship it, and verify it landed.
 *
 * NOT deploy/railway/deploy.mjs — that is the one-time Azure→Railway migration
 * driver (local-only, gitignored alongside the deploy credentials). Its PHASE D
 * resets every service's image source to the DELETED Azure registry and PHASE B
 * rewrites all env vars from Azure. Running it today would take the stack down.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=... node tools/railway-redeploy.mjs <service> <40-hex-sha>
 *   ... --verify-url https://relay.interego.xwisee.com/health
 *
 * Valid service names, and the image each one runs: `node tools/railway-services.mjs list`.
 * What every service is pinned to RIGHT NOW: `node tools/railway-pins.mjs`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY GUARD BELOW EXISTS BECAUSE AN ADVERSARIAL REVIEW FOUND THE FAILURE IT
 * PREVENTS. None of them are defensive habit; each is a specific way this deploy
 * goes wrong silently.
 *
 *   THE IMAGE NAME IS NOT THE SERVICE NAME. This used to compute `interego-${service}`,
 *   which is right for thirteen of the sixteen services and wrong for three — and the
 *   day it mattered it blocked a legitimate `css` pin for a naming reason wearing a
 *   safety reason's clothes. The mapping is now enumerated data in
 *   tools/railway-services.mjs, an unknown name is refused with the valid list before
 *   any network call, and the two datastores are refused by name rather than by luck.
 *
 *   HTTP 200 IS NOT SUCCESS. Railway's GraphQL API answers 200 with an `errors`
 *   array for every failure, including auth failure. A shell step using `curl -f`
 *   and `set -e` sees success, deploys nothing, and goes green. So every call
 *   checks `.errors` and nothing trusts a status code.
 *
 *   HEADER BY TOKEN TYPE. A project token authenticates with `Project-Access-Token`.
 *   Sent as `Authorization: Bearer` it returns 200 + "Project Token not found",
 *   which is indistinguishable from sending no credential at all. The env var is
 *   named for the token type so the two cannot be confused.
 *
 *   REDEPLOY ≠ DEPLOY. `serviceInstanceRedeploy` re-ships the PREVIOUS deployment,
 *   i.e. the OLD image tag, ignoring the update you just made. Only
 *   serviceInstanceUpdate + serviceInstanceDeployV2 actually ships a new image.
 *
 *   THE MUTATIONS RETURN SCALARS. Writing `{ id }` on them is a validation error.
 *
 *   latestDeployment CAN BE THE PREVIOUS ONE. Right after triggering it may still
 *   report the prior SUCCESS, so a loop watching it exits instantly and green
 *   against the deploy it just replaced. We poll the id deployV2 hands back.
 *
 *   SOME TERMINAL STATES ARE NOT "FAILED". CRASHED, SKIPPED, REMOVED are terminal,
 *   and NEEDS_APPROVAL never resolves without a human. Waiting only for
 *   SUCCESS-or-FAILED hangs until the CI runner is killed hours later.
 *
 *   DO NOT RETRY. Re-triggering while a deploy is in flight SIGTERMs the healthy
 *   container and the successors die before logging. On timeout this says so.
 *
 *   SUCCESS DOES NOT MEAN SERVING. No healthcheckPath is configured, so Railway
 *   calls it SUCCESS once the container binds a port — this stack has shipped a
 *   SUCCESS whose app 502'd on every request. And if the tag does not exist in the
 *   registry, the PREVIOUS container keeps serving and its /health keeps returning
 *   200. --verify-url polls until /health reports the sha we deployed, which is the
 *   only assertion that distinguishes the new container from the old one.
 */

import { resolveImageRepo } from './railway-services.mjs';

const EP = 'https://backboard.railway.com/graphql/v2';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [service, tag] = positional;
const verifyUrl = flag('--verify-url');

const TOKEN = process.env.RAILWAY_PROJECT_TOKEN;
if (!TOKEN) die('RAILWAY_PROJECT_TOKEN is not set (a Railway PROJECT token — not an account token)');
if (!service) die('usage: railway-redeploy.mjs <service> <40-hex-sha> [--verify-url URL]');
// Constrained deliberately: the tag is interpolated into an image reference, and a
// full image ref taken from input would let a dispatcher point production at any
// registry. Only a commit sha from this repo is accepted.
if (!/^[0-9a-f]{40}$/.test(tag ?? '')) die(`tag must be a 40-hex commit sha, got: ${tag}`);

/**
 * The service name is resolved to an image repository from the tracked table, before any
 * network call, so an unrecognised name is refused with the list of valid ones rather
 * than after two round trips.
 *
 * This REPLACES a `/^[a-z0-9-]{1,40}$/` plausibility check. That check let through every
 * wrong name that merely looked like a right one — which is the whole population of names
 * that get typed by mistake — and the derivation it protected (`interego-${service}`) was
 * itself wrong for three of the sixteen services. See tools/railway-services.mjs.
 */
const resolved = resolveImageRepo(service);
if (!resolved.ok) die(resolved.reason);

function die(msg) { console.error(`error: ${msg}`); process.exit(2); }

const H = { 'Content-Type': 'application/json', 'Project-Access-Token': TOKEN };

async function gql(query, variables = {}, { tolerant = false } = {}) {
  let j;
  try {
    const r = await fetch(EP, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
    j = await r.json();
  } catch (e) {
    if (tolerant) return { _transient: e.message };
    throw new Error(`network: ${e.message}`);
  }
  if (j?.errors?.length) {
    const msg = j.errors.map(e => e.message).join('; ');
    if (tolerant) return { _transient: msg };
    throw new Error(`GraphQL: ${msg}`);
  }
  return j.data;
}

// ── 0. Preflight. This is also the auth check: a wrong token type or a revoked
//       token fails HERE, before anything has been mutated.
const pt = await gql('{ projectToken { projectId environmentId } }');
const { projectId, environmentId } = pt.projectToken;
console.log(`auth ok — project ${projectId}, environment ${environmentId}`);

// ── 1. Resolve the service id by name, insisting on EXACTLY one match. A filter
//       that matches nothing yields undefined, and mutating with an empty
//       serviceId is a confusing runtime error rather than a clean refusal.
const proj = await gql(
  'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }',
  { id: projectId });
const matches = proj.project.services.edges.map(e => e.node).filter(n => n.name === service);
if (matches.length !== 1) {
  die(`expected exactly 1 service named "${service}", found ${matches.length}` +
      ` (available: ${proj.project.services.edges.map(e => e.node.name).join(', ')})`);
}
const serviceId = matches[0].id;

const image = `${resolved.repo}:${tag}`;

// ── 2. Snapshot, so we can tell OUR deployment from the one already running.
const q = 'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ source{image} latestDeployment{ id status } } }';
const before = await gql(q, { s: serviceId, e: environmentId });
console.log(`before: ${before.serviceInstance.source?.image}`);
console.log(`target: ${image}`);
if (before.serviceInstance.source?.image === image) {
  console.log('already pinned to this tag — deploying anyway to pick up a rebuilt image.');
}

/**
 * ★ THE TABLE IS NOT EVIDENCE. THE RUNNING SERVICE IS.
 *
 * tools/railway-services.mjs now supplies the image repository, which removes the
 * `interego-${service}` derivation that was wrong for three of the sixteen services. It
 * does NOT remove the need for this check, and deleting it as "already handled upstream"
 * would be the mistake: the table is a tracked file, it is maintained by hand, and it can
 * be wrong in precisely the way the derivation was — by being plausible. A service
 * renamed in Railway, a row copied from the wrong line, a new service added to the table
 * with a guessed image name all produce a confident, well-formatted, wrong pin.
 *
 * And a wrong name does not fail loudly. Railway accepts the pin, cannot pull the image,
 * and leaves the PREVIOUS container serving — /health keeps answering 200 from the old
 * code while the service is pinned to something that does not exist, exactly the landmine
 * `restorePin` below was written for. Here it is prevented instead of cleaned up.
 *
 * The invariant is what makes this checkable without a registry lookup: a redeploy
 * changes the TAG, never which image is being run. So if the repository we resolved is
 * not the repository already deployed, something is wrong regardless of which of the two
 * is right, and the answer is never "proceed and find out".
 *
 * Deliberately not overridable. An escape hatch on this guard is the same command
 * typed with one more flag, at the moment somebody is already sure they are right.
 *
 * ★ IT DOES NOT FIRE ON A FIRST PIN. `currentRepo` is empty for a service that has never
 * had a source image, and there is nothing to contradict then. That is why the css repoint
 * from `interego-css-pgsl:redis6` to a sha is allowed today: the repository matches and
 * only the tag moves, which is the one thing a redeploy is for.
 */
const repoOf = (ref) => String(ref ?? '').replace(/:[^:/]*$/, '');
const currentRepo = repoOf(before.serviceInstance.source?.image);
if (currentRepo && currentRepo !== repoOf(image)) {
  die(`"${service}" currently runs ${currentRepo}, but this script derived ${repoOf(image)} from its name.\n` +
      `       A redeploy retags the SAME image; it must not change which image runs.\n` +
      `       Nothing has been changed. Repoint it by hand if the move is intended:\n` +
      `         serviceInstanceUpdate(${serviceId}, ${environmentId}, { source: { image: "<repo>:<tag>" } })`);
}

// ── 3. Repoint. No registryCredentials: omitting them preserves the stored
//       private-registry credentials rather than clearing them.
await gql(
  'mutation($s:String!,$e:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$in) }',
  { s: serviceId, e: environmentId, in: { source: { image } } });
console.log('image repointed');

// ── 4. Ship it.
const dep = await gql(
  'mutation($s:String!,$e:String!){ serviceInstanceDeployV2(serviceId:$s,environmentId:$e) }',
  { s: serviceId, e: environmentId });
const deployId = dep.serviceInstanceDeployV2;
console.log(`deploy triggered: ${deployId}`);

/**
 * A FAILED DEPLOY IS USUALLY NOT A BROKEN IMAGE — IT IS AN ABSENT ONE.
 *
 * Railway resolves the image reference to a digest before it starts anything. When that
 * resolution fails — the tag was never pushed, or this service's stored registry
 * credential can no longer read the package — the deployment goes FAILED in about two
 * seconds with no build logs, no deploy logs, and no `imageDigest` in its meta. Empty
 * logs read like "the container died before it could say anything", which sends the
 * reader looking for a runtime cause that does not exist. The absent digest is what
 * distinguishes the two, and it is the only thing that does.
 *
 * ★ THE MISLEADING SIGNAL IS NOT RAILWAY'S — IT IS THE BUILD'S. This was diagnosed the
 * long way once: `css` was pinned to a sha whose image had never been pushed, while
 * build-ghcr.yml's `interego-css-pgsl` job for that exact commit was GREEN. That run had
 * been dispatched with `-f image=interego-relay`, and every other matrix leg gates itself
 * out in a step-level `if` — so it reports SUCCESS having built and pushed nothing. A
 * green job proves a leg RAN, never that it PUSHED. Tell them apart by duration (a real
 * build is minutes, a gated one is ~4 seconds) or by its log line
 * "skipping <image> (only building <other>)".
 *
 * This only ever explains; it never decides. It is wrapped so that a diagnosis which
 * throws cannot stop the rollback below, which is the part that protects production.
 */
async function diagnoseFailure() {
  try {
    const d = await gql('query($id:String!){ deployment(id:$id){ meta } }', { id: deployId }, { tolerant: true });
    const meta = d?._transient ? null : d?.deployment?.meta;
    // A resolved digest means the image WAS pulled, so the failure is the application's
    // and the deploy logs are the right place to look. Say nothing rather than guess.
    if (!meta || meta.imageDigest) return;
    console.error(`
Railway never resolved ${image} to a digest, so nothing was ever pulled: the
failure is BEFORE the container, which is why the deploy logs are empty. Either the
tag does not exist in the registry, or this service's stored registry credential
cannot read that package.

  Check that the image was actually PUSHED. In build-ghcr.yml, a matrix leg skipped
  by \`-f image=<a different image>\` still reports SUCCESS — look at the job's
  duration (seconds means it skipped) or its log line "skipping ...".`);
  } catch {
    // A diagnosis that fails must never mask the failure it was explaining, and must
    // never come between a FAILED deploy and the rollback that un-pins it.
  }
}

/**
 * A FAILED DEPLOY MUST NOT LEAVE THE SERVICE PINNED TO THE IMAGE THAT FAILED.
 *
 * ★ Learned by doing it. I repointed a service at a commit sha for which that
 * image had never been built. Railway kept the PREVIOUS container serving, so
 * there was no outage and nothing looked wrong from outside — but the service was
 * left pinned to an image that does not exist. The next restart, redeploy, or node
 * migration would have tried to pull it and the service would have died then,
 * detached in time from the change that caused it.
 *
 * So on any terminal failure the pin goes back to whatever was running before.
 * The deploy still exits non-zero; it just does not leave a landmine behind.
 */
async function restorePin(why) {
  const previous = before.serviceInstance.source?.image;
  if (!previous || previous === image) return;
  try {
    await gql(
      'mutation($s:String!,$e:String!,$in:ServiceInstanceUpdateInput!){ serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$in) }',
      { s: serviceId, e: environmentId, in: { source: { image: previous } } });
    console.error(`
${why} — image pin ROLLED BACK to ${previous}`);
    console.error('The previous container kept serving throughout; nothing was pinned to a broken image.');
  } catch (e) {
    console.error(`
${why} — and the rollback ALSO failed: ${e.message}`);
    console.error(`The service is still pinned to ${image}. Repoint it manually to ${previous}.`);
  }
}

// ── 5. Watch to a terminal state.
const GOOD = new Set(['SUCCESS']);
const BAD = new Set(['FAILED', 'CRASHED', 'SKIPPED', 'REMOVED', 'REMOVING']);
const deadline = Date.now() + 12 * 60_000;
let status = '(unknown)';

while (Date.now() < deadline) {
  await sleep(7000);
  const d = await gql('query($id:String!){ deployment(id:$id){ status } }', { id: deployId }, { tolerant: true });
  if (d?._transient) { console.log(`  … transient: ${d._transient}`); continue; }
  status = d.deployment.status;
  console.log(`  ${status}`);
  if (GOOD.has(status)) break;
  if (status === 'NEEDS_APPROVAL') {
    await restorePin('NEEDS_APPROVAL — a human must approve this deploy in the Railway UI');
    die('NEEDS_APPROVAL — a human must approve this deploy in the Railway UI');
  }
  if (BAD.has(status)) {
    await diagnoseFailure();
    await restorePin(`deployment ${status}`);
    die(`deployment ${status}${status === 'REMOVED' ? ' — a newer deploy superseded it' : ''}`);
  }
}
if (!GOOD.has(status)) {
  console.error(`\nTIMEOUT at ${status} after 12 minutes.`);
  console.error('Do NOT re-run: re-triggering while a deploy is in flight SIGTERMs the');
  console.error(`healthy container. Inspect deployment ${deployId} in Railway first.`);
  process.exit(1);
}

// ── 6. Confirm the pin took and that OUR deployment is the live one.
const after = await gql(q, { s: serviceId, e: environmentId });
const okImage = after.serviceInstance.source?.image === image;
const okDeploy = after.serviceInstance.latestDeployment?.id === deployId;
console.log(`\nimage pinned as requested : ${okImage}`);
console.log(`our deployment is live    : ${okDeploy}`);
if (!okImage || !okDeploy) die('post-deploy state does not match what we asked for');

// ── 7. Prove the NEW code is answering. Everything above is Railway's opinion;
//       this is the application's.
if (verifyUrl) {
  console.log(`\nverifying ${verifyUrl} reports build ${tag.slice(0, 12)}…`);
  const until = Date.now() + 3 * 60_000;
  let seen = '(none)';
  while (Date.now() < until) {
    try {
      const r = await fetch(verifyUrl, { headers: { 'cache-control': 'no-cache' } });
      const j = await r.json();
      seen = j.build ?? '(no build field)';
      if (seen === tag) { console.log(`  serving ${seen} — verified`); process.exit(0); }
      console.log(`  still ${String(seen).slice(0, 12)}… (rolling replace)`);
    } catch (e) {
      console.log(`  … ${e.message}`);
    }
    await sleep(6000);
  }
  console.error(`\n${verifyUrl} never reported build ${tag}. Last saw: ${seen}`);
  console.error('Railway called the deploy SUCCESS, so the container bound a port —');
  console.error('but the running code is not the code you deployed. Check the image');
  console.error('tag exists in the registry and read the deployment logs.');
  process.exit(1);
}

console.log('\n(no --verify-url given: Railway reports success, but nothing has confirmed');
console.log(' the new code is actually serving)');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
