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
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY GUARD BELOW EXISTS BECAUSE AN ADVERSARIAL REVIEW FOUND THE FAILURE IT
 * PREVENTS. None of them are defensive habit; each is a specific way this deploy
 * goes wrong silently.
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

const EP = 'https://backboard.railway.com/graphql/v2';
const IMAGE_PREFIX = 'ghcr.io/markjspivey-xwisee';

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
if (!/^[a-z0-9-]{1,40}$/.test(service)) die(`implausible service name: ${service}`);

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

const image = `${IMAGE_PREFIX}/interego-${service}:${tag}`;

// ── 2. Snapshot, so we can tell OUR deployment from the one already running.
const q = 'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ source{image} latestDeployment{ id status } } }';
const before = await gql(q, { s: serviceId, e: environmentId });
console.log(`before: ${before.serviceInstance.source?.image}`);
console.log(`target: ${image}`);
if (before.serviceInstance.source?.image === image) {
  console.log('already pinned to this tag — deploying anyway to pick up a rebuilt image.');
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
