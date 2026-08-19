#!/usr/bin/env node
/**
 * Set ONE Railway service variable, showing the before/after diff first.
 *
 * ★ ONE VARIABLE, NEVER A COLLECTION. Railway also exposes `variableCollectionUpsert`, which
 * REPLACES a service's whole environment — and a caller that means "change this one value" and
 * reaches for the collection mutation silently deletes every variable it did not restate. This
 * tool only ever calls `variableUpsert`, so the blast radius is the named variable and nothing
 * else. It does not redeploy: a variable change and the restart that picks it up are separate
 * decisions, and the restart is the one with the outage risk.
 *
 * Dry run is the default; `--apply` performs the write. The old and new values are printed so the
 * change is visible before and after — do not use this for secrets, which must never be echoed
 * (read those with tools/railway-read-var.mjs, which prints only a length).
 *
 * Usage:
 *   node tools/railway-set-var.mjs <service> <VAR_NAME> <value>
 *   node tools/railway-set-var.mjs <service> <VAR_NAME> <value> --apply
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EP = 'https://backboard.railway.com/graphql/v2';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const [serviceName, varName, value] = argv.filter(a => a !== '--apply');
if (!serviceName || !varName || value === undefined) {
  console.error('usage: node tools/railway-set-var.mjs <service> <VAR_NAME> <value> [--apply]');
  process.exit(2);
}

const token = process.env.RAILWAY_PROJECT_TOKEN
  ?? (existsSync(join(REPO, '.interego/railway-token.txt'))
    ? readFileSync(join(REPO, '.interego/railway-token.txt'), 'utf8').trim()
    : null);
if (!token) { console.error('RAILWAY_PROJECT_TOKEN not set'); process.exit(2); }

const H = { 'Content-Type': 'application/json', 'Project-Access-Token': token };
async function gql(query, variables = {}) {
  const r = await fetch(EP, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join('; '));
  return j.data;
}

const me = await gql('query { projectToken { projectId environmentId } }');
const projectId = me.projectToken.projectId;
const environmentId = me.projectToken.environmentId;

const proj = await gql(
  'query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }',
  { id: projectId },
);
const svc = proj.project.services.edges.map(e => e.node).find(n => n.name === serviceName);
if (!svc) { console.error(`no service "${serviceName}"`); process.exit(1); }

const before = await gql(
  `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
     variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
   }`,
  { projectId, environmentId, serviceId: svc.id },
);
const old = before.variables?.[varName];

console.log(`service : ${serviceName}`);
console.log(`variable: ${varName}`);
console.log(`before  : ${old === undefined ? '(unset)' : old}`);
console.log(`after   : ${value}`);
if (old === value) { console.log('\nno change needed — value is already what was asked for'); process.exit(0); }

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply'); process.exit(0); }

await gql(
  `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
  { input: { projectId, environmentId, serviceId: svc.id, name: varName, value } },
);

const after = await gql(
  `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
     variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
   }`,
  { projectId, environmentId, serviceId: svc.id },
);
const now = after.variables?.[varName];
// Read back rather than trust the mutation's return: a write that reported success and did not
// land is exactly the failure that made a deploy silently serve the old image once already.
if (now !== value) {
  console.error(`\nVERIFY FAILED — variable reads back as: ${now}`);
  process.exit(1);
}
console.log('\nwritten and verified. The service keeps running the OLD value until it restarts.');
