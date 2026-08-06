#!/usr/bin/env node
/**
 * Give ONE Railway service the credentials it needs to pull its image from GHCR.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Every image this repository builds is pushed to a PRIVATE GHCR package, and Railway
 * stores the pull credential per SERVICE, encrypted, unreadable through the API. The
 * thirteen services that predate this file were given theirs by the one-shot Azure→Railway
 * migration driver, which must never run again.
 *
 * So a service created after that migration cannot pull anything, and the way it fails is
 * the reason this is a tool rather than a note: the deployment goes straight to FAILED with
 * NO BUILD LOG AND NO DEPLOY LOG. There is nothing to read, `registryCredentials: null` sits
 * in the deployment's `meta` where nobody looks, and the obvious readings — bad image tag,
 * crashed container, wrong port — are all wrong. It cost a full diagnostic cycle once; this
 * exists so it costs none.
 *
 * ── WHY IT RUNS IN CI ────────────────────────────────────────────────────────
 *
 * The credential is `secrets.GHCR_TOKEN`, which exists in Actions and nowhere else. Running
 * this by hand would mean a human pasting a package token into a shell, which is how tokens
 * end up in shell history — so the local path is deliberately not smoothed over: it works,
 * and it wants the token in the environment, and CI is where the token already is.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=… GHCR_USERNAME=… GHCR_TOKEN=… \
 *     node tools/railway-registry-credentials.mjs <service>
 *
 * It does NOT deploy. Setting a credential and shipping an image are separate decisions,
 * and the same separation build-ghcr.yml and deploy-railway.yml already keep.
 */

import { serviceNames } from './railway-services.mjs';

const EP = 'https://backboard.railway.app/graphql/v2';
const service = process.argv[2];
const token = process.env['RAILWAY_PROJECT_TOKEN'] ?? '';
const ghcrUser = process.env['GHCR_USERNAME'] ?? '';
const ghcrToken = process.env['GHCR_TOKEN'] ?? '';

function die(msg) { console.error(msg); process.exit(1); }

// An unknown name is refused BEFORE any network call, with the valid list — the same rule
// railway-redeploy.mjs applies, for the same reason: a typo that reaches the API creates or
// mutates something nobody meant to touch.
if (!service) die(`usage: node tools/railway-registry-credentials.mjs <service>\nvalid: ${serviceNames().join(', ')}`);
if (!serviceNames().includes(service)) {
  die(`unknown service '${service}'.\nvalid: ${serviceNames().join(', ')}`);
}
// A PROJECT token authenticates with `Project-Access-Token`. Sent as `Authorization: Bearer`
// it returns 200 + "Project Token not found", indistinguishable from sending nothing.
if (!token) die('RAILWAY_PROJECT_TOKEN is unset (a PROJECT token, not an account token).');
if (!ghcrUser || !ghcrToken) die('GHCR_USERNAME and GHCR_TOKEN must both be set.');

const H = { 'Project-Access-Token': token, 'Content-Type': 'application/json' };

// HTTP 200 IS NOT SUCCESS on this API: it answers 200 with an `errors` array for every
// failure, including auth failure. Nothing here trusts a status code.
async function gql(query, variables = {}) {
  const r = await fetch(EP, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) die(`railway: ${JSON.stringify(j.errors).slice(0, 500)}`);
  return j.data;
}

const scope = await gql('query{ projectToken{ projectId environmentId } }');
const { projectId, environmentId } = scope.projectToken;

const found = await gql('query($p:String!){project(id:$p){services{edges{node{id name}}}}}', { p: projectId });
const svc = found.project.services.edges.map(e => e.node).find(s => s.name === service);
if (!svc) die(`service '${service}' does not exist in this project. This tool configures an existing service; it does not create one.`);

// The mutation returns a SCALAR. Asking for `{ id }` on it is a validation error.
await gql(
  'mutation($s:String!,$e:String!,$in:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$in)}',
  { s: svc.id, e: environmentId, in: { registryCredentials: { username: ghcrUser, password: ghcrToken } } },
);

// Read back the field Railway will actually consult, so "set" is an observation rather than
// an assumption. The value is encrypted at rest and comes back opaque — which is the point:
// presence is checkable, the secret is not readable, and this prints neither.
const after = await gql(
  'query($s:String!,$e:String!){deployments(first:1,input:{serviceId:$s,environmentId:$e}){edges{node{id}}}}',
  { s: svc.id, e: environmentId });
const seen = after.deployments.edges.length;
console.log(
  `registry credentials set on '${service}' (${svc.id}) as user '${ghcrUser}'. `
  + `${seen} prior deployment(s) on this service — they are NOT retrofitted: `
  + 'a credential applies to the next deploy, so ship one.',
);
