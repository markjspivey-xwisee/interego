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
 *   ... [--verify-url <url on a host Railway reports for THIS service>]
 *
 * The verify URL is DERIVED from the service being deployed — Railway's own `domains`
 * answer plus that service's health path from tools/railway-services.mjs. `--verify-url`
 * is an OVERRIDE for the unusual case (a *.up.railway.app host, a custom domain not yet in
 * DNS) and is refused unless its host is one Railway reports for this service. See §1b.
 * A PORTLESS service (`discord`, `css`) has no URL to derive and takes the log-based proof
 * at §1c/§7b instead; `--verify-url` is refused for it outright. A service declared a
 * SINGLETON (`css`) is additionally refused unless its live replica settings hold it to one
 * container — see §2b.
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
 *   200. The verify poll waits until /health reports the sha we deployed, which is
 *   the only assertion that distinguishes the new container from the old one.
 *
 *   VERIFYING THE WRONG SERVICE PASSES. The verify URL used to be a free-text flag,
 *   and deploy-railway.yml pre-filled it with RELAY's /health for every service.
 *   Deploying identity at a sha relay already ran polled relay, matched, and printed
 *   "verified" without ever contacting identity. The URL is now derived from the
 *   service being deployed and an override is refused unless Railway reports its host
 *   for that service. See §1b.
 *
 *   NOT EVERY SERVICE ANSWERS HTTP, AND THIS USED TO REFUSE THE ONES THAT DON'T.
 *   `discord` is a worker: it dials out to the Discord gateway and binds no port, so
 *   Railway reports no domain and there is nothing to poll. The URL derivation refused
 *   it — which meant the sanctioned deploy path could not deploy it AT ALL, while its
 *   runbook said it would deploy without an HTTP probe. Portless services now declare
 *   the line they print when they finish booting, and are verified against the logs of
 *   the deployment THIS run triggered. See §1c and §7b.
 *
 *   A CHATTY SERVICE TURNS THE LOG PROOF INTO A RACE. That proof searched a 500-line
 *   tail. For the silent discord bot the boot line is still in it minutes later; for
 *   `css` — which logs a line per HTTP request while the whole fleet polls it — a
 *   500-line tail spans 12.7 SECONDS, measured, so the boot line survives an unfiltered
 *   tail only for the first seconds of a container's life. §7b does not begin until §5
 *   has seen SUCCESS, and nothing bounds when that is. Losing that race reports "never
 *   printed" about a container that booted perfectly, and the reflex after a red css
 *   deploy is to run it again, which SIGTERMs the healthy container. The needle is now
 *   passed to Railway as a log FILTER and re-counted here. See §7b.
 *
 *   A ROLLOUT IS WHEN A SINGLETON STOPS BEING ONE. `css` holds every pod's data behind a
 *   PROCESS-LOCAL lock, so two containers mean two lockers over one store and a lost
 *   update that answers 200 — and a deploy is the one moment Railway deliberately runs
 *   two. Its replica settings were reported by the scheduled audit and written by a
 *   separate tool, but nothing checked them on the path that opens the window. §2b does,
 *   before anything is mutated.
 */

import { bootProofFor, healthPathFor, resolveImageRepo, singletonViolations, verifyUrlFor } from './railway-services.mjs';

const EP = 'https://backboard.railway.com/graphql/v2';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const [service, tag] = positional;
// NOT the verify URL — only an OVERRIDE for it. The URL itself is DERIVED from the service
// being deployed, at §1b below, once Railway has told us that service's own domains.
const verifyUrlOverride = flag('--verify-url');

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

// Declared up here, not next to its two callers at the bottom of the file. `verifyFromLogs`
// is invoked from §7b, which executes BEFORE module evaluation reaches the end of the file;
// a `const` down there would still be in its temporal dead zone at that point and the
// portless verification would die with a ReferenceError instead of verifying anything.
const LOGS = 'query($id:String!,$limit:Int!,$filter:String){ deploymentLogs(deploymentId:$id,limit:$limit,filter:$filter){ timestamp message } }';

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

/**
 * ── 1b. THE VERIFY TARGET IS DERIVED FROM THE DEPLOY TARGET, NEVER TYPED ──────
 *
 * ★ THE FALSE-GREEN THIS KILLS, measured 2026-08-03. `.github/workflows/deploy-railway.yml`
 * declared `verify_url` as a free-text dispatch input pre-filled with RELAY's /health — for
 * every service. Dispatching `service=identity tag=7c9124af…` with that default left in
 * place polls RELAY, reads relay's build (which really was 7c9124af…), finds it EQUAL to
 * the tag, prints "serving … — verified" and exits 0, while identity is still running an
 * older image. The one assertion this repository has that a rollout landed could pass for a
 * service it never contacted. It is the same class of defect tools/railway-services.mjs was
 * created to kill — except here the derivation was not merely wrong, it was ABSENT, so a
 * human typed the coupling and could type it wrong.
 *
 * `projectId` is REQUIRED on this query; omitting it returns a GraphQL error rather than an
 * empty list, so it is passed explicitly.
 */
const dom = await gql(
  'query($p:String!,$s:String!,$e:String!){ domains(projectId:$p,serviceId:$s,environmentId:$e){ serviceDomains{ domain } customDomains{ domain } } }',
  { p: projectId, s: serviceId, e: environmentId });
const hosts = [
  ...(dom?.domains?.customDomains ?? []),
  ...(dom?.domains?.serviceDomains ?? []),
].map((d) => d.domain).filter(Boolean);

/**
 * ── 1c. A PORTLESS SERVICE IS VERIFIED FROM ITS OWN DEPLOYMENT'S LOGS ─────────
 *
 * ★ THE BLOCKER THIS REMOVES, measured 2026-08-08 on the first ever dispatch for `discord`.
 * Everything above assumed the deployed thing answers HTTP. It does not always: `discord` is
 * a WORKER — it dials OUT to the Discord gateway and the relay and binds no inbound port, so
 * Railway gives it no domain and there is nothing to poll. tools/railway-services.mjs records
 * `health: null` for it and healthPathFor() therefore refuses it, and the line below used to
 * treat that refusal as fatal — so the service could not be deployed through the sanctioned
 * path AT ALL, while DEPLOY.md told operators it "deploys without an HTTP probe". The
 * exclusion was never a decision; it was the HTTP assumption showing through.
 *
 * The answer is not to skip verification for workers — that is the "Railway reports success,
 * but nothing has confirmed the new code is actually serving" branch this file already
 * deleted once. It is to verify on the surface a portless process HAS. `deploymentLogs` are
 * scoped to a DEPLOYMENT ID and we poll the id deployV2 handed back, so a line found there
 * was written by the container THIS deploy started — the same claim /health makes.
 */
const health = healthPathFor(service);
/** Exactly one of these is set. `verifyUrl` polls HTTP at §7a; `bootNeedle` polls logs at §7b. */
let verifyUrl = null;
let bootNeedle = null;
if (health.ok) {
  const verify = verifyUrlFor(service, hosts, verifyUrlOverride);
  if (!verify.ok) die(verify.reason);
  verifyUrl = verify.url;
  console.log(`verify target: ${verifyUrl}${verifyUrlOverride ? ' (override accepted — host belongs to this service)' : ' (derived)'}`);
} else {
  const proof = bootProofFor(service);
  // BOTH reasons, because they are different facts: why there is no URL, and why there is no
  // log needle either. Printing only the second reads like the service is merely unconfigured.
  if (!proof.ok) die(`${health.reason}\n       ${proof.reason}`);
  // Refused rather than ignored. An override here cannot be checked against anything — §1b's
  // guard is "the host must be one Railway reports for THIS service", and Railway reports
  // none — so accepting it would reinstate exactly the free-text verify target that let a
  // deploy of one service report "verified" from another.
  if (verifyUrlOverride) {
    die(`"${service}" binds no port, so --verify-url has nothing to point at and no host of ` +
        'this service to be checked against. It is verified from its own deployment logs.');
  }
  bootNeedle = proof.needle;
  console.log(`verify target: deployment logs must report ${JSON.stringify(bootNeedle)} (portless worker — no port to probe)`);
  // A worker with a public domain is a misconfiguration, not a fact to swallow: it means
  // somebody generated a domain for a service that will never answer it.
  if (hosts.length) console.log(`  note: Railway reports domain(s) for this portless service: ${hosts.join(', ')}`);
}

const image = `${resolved.repo}:${tag}`;

// ── 2. Snapshot, so we can tell OUR deployment from the one already running.
//       The replica settings ride along on the same query because §2b has to read them
//       before anything is mutated, and a second round trip for three scalars is a second
//       place for the auth to be wrong.
const q = 'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ source{image} numReplicas overlapSeconds drainingSeconds latestDeployment{ id status } } }';
const before = await gql(q, { s: serviceId, e: environmentId });
console.log(`before: ${before.serviceInstance.source?.image}`);
console.log(`target: ${image}`);

/**
 * ── 2b. A DECLARED SINGLETON IS NOT DEPLOYED UNTIL ITS SETTINGS SAY SO ────────
 *
 * ★ THE FAILURE THIS PREVENTS. `css` is the only service in the fleet whose CORRECTNESS
 * depends on exactly one container existing: its store is one shared Postgres-backed PGSL
 * lattice and its resource locker is PROCESS-LOCAL, so two containers run two independent
 * lockers over one store and CSS's If-Match read-modify-write — the relay's manifest
 * compare-and-swap — can have BOTH pass the precondition and both write. A lost update
 * that answers 200, in the store that holds every pod's data.
 *
 * A deploy is exactly when that becomes possible, because a rollout is the one moment
 * Railway is deliberately running the old container and the new one. So the replica
 * settings are a PRECONDITION of deploying this service, not a background tidiness item —
 * and until now they were enforced nowhere on this path. `tools/railway-fleet-audit.ts`
 * reports them on a schedule and `tools/railway-singleton-settings.ts` writes them, but a
 * deploy dispatched between the drift and the fix would have proceeded, and the audit that
 * would have caught it runs after the damage.
 *
 * The same predicate both of those use, on the row we just read, before §3 mutates
 * anything. Deliberately not overridable: an escape hatch here is one more flag typed by
 * somebody who is already sure, at the only moment it matters.
 */
const singleton = singletonViolations([{
  service,
  numReplicas: before.serviceInstance.numReplicas ?? null,
  overlapSeconds: before.serviceInstance.overlapSeconds ?? null,
  drainingSeconds: before.serviceInstance.drainingSeconds ?? null,
}]);
if (singleton.length) {
  console.error(`error: "${service}" is declared a singleton and its live settings do not hold it to one container.`);
  for (const v of singleton) console.error(`       ${v.setting} = ${v.live ?? '(unset)'}, want ${v.want ?? 'unset'} — ${v.why}`);
  console.error('       Nothing has been changed. Fix it first: npx tsx tools/railway-singleton-settings.ts --apply');
  process.exit(2);
}
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
//
// NOT optional any more, and not skippable: §1b/§1c either derived a probe or died. The old
// shape was `if (verifyUrl) { … }` followed by a printed caveat — "Railway reports
// success, but nothing has confirmed the new code is actually serving" — and exit 0. A
// deploy step that can report success without a single request to the deployed thing is
// how a stale image goes unnoticed, and the caveat was the branch people took, because
// most services had no `build` field to poll and the loop could only ever time out.
//
// A portless service takes §7b instead. It is the SAME assertion — "the container this
// deploy started is the one that got through its own boot" — read off the only surface it
// has. It is not a relaxation: a worker that never boots fails here just as loudly.
if (bootNeedle !== null) await verifyFromLogs(bootNeedle);

// ── 7a. Services that answer HTTP.
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
console.error('If it says "(no build field)", the image predates this service consuming');
console.error('the GIT_SHA build-arg: rebuild it before deploying, do not blank the check.');
process.exit(1);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * ── 7b. Prove a PORTLESS service booted, from the logs of THIS deployment.
 *
 * Always exits; it never returns to the HTTP path above.
 *
 * ★ IT COUNTS THE LINE, IT DOES NOT JUST FIND IT. A container that prints its boot line
 * TWICE inside one deployment did not boot twice — it RESTARTED, which is what a crash loop
 * looks like from here, and Railway will still be calling the deployment SUCCESS while it
 * happens. "SUCCESS then crash-loop" is the specific false-green a worker has instead of
 * "SUCCESS but 502": there is no request to fail, so nothing else would ever notice.
 *
 * ★ ON FAILURE IT PRINTS THE LOG TAIL. The reasons a worker does not boot are all IN the
 * logs it did write — a refused credential, a gateway close code, an unhandled throw — and
 * an operator told only "the needle never appeared" would go and fetch exactly this.
 */
async function verifyFromLogs(needle) {
  console.log(`\nverifying deployment ${deployId} logs report ${JSON.stringify(needle)}…`);
  const until = Date.now() + 4 * 60_000;
  while (Date.now() < until) {
    const found = await bootLines(needle);
    if (found === null) {
      console.log('  … transient: log query unavailable, retrying');
    } else if (found.length === 1) {
      console.log(`  booted — ${JSON.stringify(needle)} appears once in this deployment's logs`);
      // Railway's own opinion, read AFTER the app's: a container that has already died
      // again by now is not a successful rollout however green the deploy looked.
      const st = await gql('query($id:String!){ deployment(id:$id){ status } }', { id: deployId }, { tolerant: true });
      const now = st?._transient ? '(unreadable)' : st.deployment.status;
      if (now !== 'SUCCESS') {
        console.error(`\nIt booted, and the deployment is now ${now}. The container did not stay up.`);
        process.exit(1);
      }
      console.log('  deployment still SUCCESS — verified');
      process.exit(0);
    } else if (found.length > 1) {
      console.error(`\n${JSON.stringify(needle)} appears ${found.length} times in ONE deployment's logs.`);
      console.error('The container RESTARTED — it boots, exits, and Railway starts it again.');
      console.error('Railway calls that deployment SUCCESS; it is a crash loop. The cause is in');
      console.error('the tail below, at the end of the first boot.');
      printTail(await recentLines());
      process.exit(1);
    } else {
      console.log('  … no boot line in this deployment yet');
    }
    await sleep(6000);
  }
  console.error(`\nDeployment ${deployId} never printed ${JSON.stringify(needle)} within 4 minutes.`);
  console.error('Railway called the deploy SUCCESS, which for a portless service means only');
  console.error('that the container started — not that it got through its own boot.');
  printTail(await recentLines());
  process.exit(1);
}

/**
 * Every occurrence of the boot line in THIS deployment, or null if the query was transient.
 *
 * ★ THE `filter` ARGUMENT REMOVES A RACE. NOT AN OPTIMISATION, AND NOT A CERTAIN FAILURE
 * EITHER — the honest version, because the first css deploy through this path produced the
 * evidence against the stronger claim.
 *
 * This used to ask for a 500-line tail and search it in JS. That is unconditionally fine
 * for `discord`, which is silent between boots. For `css` it is a race, because css logs a
 * line for every HTTP request while the whole fleet polls it: MEASURED 2026-08-09, a
 * 500-line tail of css's steady-state output spans 12.7 SECONDS. `deploymentLogs` is scoped
 * to one deployment, so the tail holds the boot line only until that container has written
 * ~500 lines of its own — measured at 149 lines in its first 8.6 seconds, i.e. somewhere
 * around the first 15–25 seconds of its life.
 *
 * ★ AND THE RACE WAS WON ON THE RUN THAT PROVED THIS PATH: deployment 0a7c0a0c, boot line
 * at 14:39:34.845, found by the second poll at 14:39:37.24 with the container only 149 lines
 * old. An unfiltered tail would have contained it. What decides the race is how long §5
 * waits for SUCCESS before this function is called at all — 7.1 seconds that time, and
 * bounded by nothing. A pull that takes longer, a busier fleet, or one transient retry moves
 * the first poll past the window, and then the tool reports "never printed" about a
 * container that booted perfectly. The reflex after a red css deploy is to run it again,
 * which SIGTERMs the healthy container holding every pod's data. Turning a race the deploy
 * usually wins into an answer that does not depend on timing is worth one query argument.
 *
 * Railway's `filter` is a case-INSENSITIVE substring match evaluated over the deployment's
 * whole retained history, not a recent shard — verified by asking a 23-day-old css
 * deployment for this needle and getting its single boot line from day one. The hits are
 * then re-counted case-SENSITIVELY here, so the count that decides crash-loop-or-not is
 * this file's own comparison and not the platform's looser one.
 *
 * ★★ THE NEEDLE IS QUOTED, AND WITHOUT THE QUOTES THIS NEVER MATCHED ANYTHING FOR `discord`.
 * Railway's filter is not a plain substring: it is a small query language, and a bare word
 * ending in a COLON is read as a FIELD SELECTOR rather than as text. `discord`'s needle has
 * always begun `discord: `, so every poll asked for a field named `discord` and got nothing —
 * for the four minutes the loop allows — and the tool then reported "never printed … within 4
 * minutes" about a container whose logs contained the line, and exited 1. It is the mirror of
 * the outage this needle was strengthened for: a RED that means nothing, on every single
 * deploy of this service, which is precisely how an operator learns to disregard it.
 *
 * Measured against the live project on 2026-08-09, same deployment, same line:
 *
 *     filter `discord:`               → 0 lines
 *     filter `discord`                → 5 lines
 *     filter `discord: bot online`    → 0 lines      ← what this function used to send
 *     filter `"discord: bot online"`  → 1 line       ← what it sends now
 *     filter `discord\: bot online`   → 0 lines      (backslash escaping is not the syntax)
 *
 * Quoting is a no-op for a needle that has no colon — `"Listening to server at"` returns css's
 * boot line exactly as the bare form does, checked the same way — so this is one rule for both
 * services rather than a special case keyed on punctuation. And it stays an EXACT PHRASE, so it
 * narrows as tightly as before and the css race the filter exists to close stays closed.
 * `JSON.stringify` rather than string concatenation because it also escapes a quote or
 * backslash inside a future needle, which hand-built quoting would smuggle into the syntax.
 */
async function bootLines(needle) {
  const d = await gql(LOGS, { id: deployId, limit: 500, filter: JSON.stringify(needle) }, { tolerant: true });
  if (d?._transient) return null;
  return (d.deploymentLogs ?? []).map(l => String(l.message ?? '')).filter(m => m.includes(needle));
}

/**
 * An UNFILTERED tail, for the failure paths only. The reasons a worker does not boot are in
 * the lines it DID write — a refused credential, a gateway close code, an unhandled throw —
 * and none of them contain the needle, so the filtered query above would show an operator
 * nothing. Fetched on failure rather than on every poll so the diagnosis costs one extra
 * request instead of forty.
 */
async function recentLines() {
  const d = await gql(LOGS, { id: deployId, limit: 500, filter: null }, { tolerant: true });
  if (d?._transient) return [`(log tail unavailable: ${d._transient})`];
  return (d.deploymentLogs ?? []).map(l => String(l.message ?? ''));
}

function printTail(lines) {
  const tail = lines.slice(-30);
  console.error(`\n── last ${tail.length} log line(s) ──`);
  for (const l of tail) console.error('  ' + l);
}
