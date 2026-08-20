#!/usr/bin/env node
/**
 * Set ONE Railway service variable from a FILE, without the value ever reaching a terminal.
 *
 * ★ WHY THIS EXISTS BESIDE `railway-set-var.mjs`, WHICH ALREADY SETS VARIABLES. That one prints the
 * before and after values so a change is visible, and its own header says not to use it for
 * secrets. There was no other way to set one — so the only options were "echo a private key into a
 * transcript" or "do not pin the key". The second is what happened: `RELAY_COMPLIANCE_WALLET_JSON`
 * survived the Azure era as a Container Apps secret, was never carried to Railway, and the relay
 * has been minting a FRESH signing wallet on every container start ever since. Six anchor rotations
 * in five hours, every one of them a deploy of mine, and every relay-mediated agent 401'd against
 * its own delegation credential.
 *
 * A missing tool is a reason things do not get done. This is that tool.
 *
 * The value is read from a file, never from argv (which lands in shell history and in process
 * listings). stdout gets a length and a SHA-256 fingerprint of the value — enough to confirm the
 * right thing was written and to compare two environments, and not enough to reconstruct anything.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=... node tools/railway-set-secret-var.mjs <service> <VAR_NAME> <file> [--apply]
 *
 * Dry run is the default, as with its sibling.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EP = 'https://backboard.railway.com/graphql/v2';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const [serviceName, varName, valueFile] = argv.filter(a => a !== '--apply');
if (!serviceName || !varName || !valueFile) {
  console.error('usage: node tools/railway-set-secret-var.mjs <service> <VAR_NAME> <file> [--apply]');
  process.exit(2);
}
if (!existsSync(valueFile)) { console.error(`value file not found: ${valueFile}`); process.exit(2); }
// Trailing newlines are the classic way a pasted secret stops matching. Strip once, deliberately.
const value = readFileSync(valueFile, 'utf8').trim();
if (!value) { console.error('value file is empty'); process.exit(2); }

/** Enough to tell two values apart and to confirm a write; not enough to reconstruct one. */
const fp = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12);

const token = process.env.RAILWAY_PROJECT_TOKEN
  ?? (existsSync(join(REPO, '.interego/railway-token.txt'))
    ? readFileSync(join(REPO, '.interego/railway-token.txt'), 'utf8').trim()
    : null);
if (!token) { console.error('RAILWAY_PROJECT_TOKEN not set'); process.exit(2); }

const H = { 'Content-Type': 'application/json', 'Project-Access-Token': token };
async function gql(query, variables = {}) {
  const r = await fetch(EP, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  // Railway answers HTTP 200 with an `errors` array for every failure, including auth failure.
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

const read = async () => {
  const q = await gql(
    `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
       variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
     }`,
    { projectId, environmentId, serviceId: svc.id },
  );
  return q.variables?.[varName];
};

const old = await read();
console.log(`service : ${serviceName}`);
console.log(`variable: ${varName}`);
console.log(`before  : ${old === undefined || old === '' ? '(unset)' : `${old.length} chars, sha256:${fp(old)}`}`);
console.log(`after   : ${value.length} chars, sha256:${fp(value)}`);
if (old === value) { console.log('\nno change needed — the value is already what was asked for'); process.exit(0); }
if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply'); process.exit(0); }

await gql(
  'mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
  { input: { projectId, environmentId, serviceId: svc.id, name: varName, value } },
);

// Read back rather than trust the mutation's return — a write that reported success and did not
// land is a failure this project has already had once, on an image pin.
const now = await read();
if (now !== value) {
  console.error(`\nVERIFY FAILED — reads back as ${now === undefined ? '(unset)' : `${now.length} chars, sha256:${fp(now)}`}`);
  process.exit(1);
}
console.log('\nwritten and verified. The service keeps running the OLD value until it restarts.');
