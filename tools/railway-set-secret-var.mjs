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
 * Dry run is the default, as with its sibling. The upsert does not pass `skipDeploys`, whose API
 * default is false, so an --apply makes Railway redeploy the service with the new value
 * (https://docs.railway.com/integrations/api/manage-variables).
 *
 * ★ RAILWAY'S ERROR TEXT IS NEVER PRINTED, because it can quote the value. A GraphQL error about
 * an input it cannot coerce quotes the whole input object, and the upsert's input holds the
 * value; a failed request's message or cause can hold the request body; a body that is not JSON
 * lands in the parse error's message. So a failed request ends in one fixed line that names the
 * step and the kind of failure (`GraphQL:` refused, or `network:`), and nothing from Railway or
 * from the error object; an error this tool did not expect is reported by its name alone. A
 * failure after the upsert was sent says the write's outcome is unknown, and a dry run of the
 * same command then compares what Railway holds with the file.
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

/** A failure described in fixed text only, so it is safe to print. */
class RequestFailed extends Error {}

async function gql(query, variables = {}) {
  let r;
  try {
    // No redirect is followed: fetch drops only Authorization across origins, so a followed 307
    // or 308 would carry the Project-Access-Token and the upsert's body, value included.
    r = await fetch(EP, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }), redirect: 'error' });
  } catch {
    // Not the error's message or cause: either can hold the request body.
    throw new RequestFailed('network: the request failed');
  }
  if (!r.ok) throw new RequestFailed(`network: Railway answered HTTP ${r.status}`);
  let j;
  try {
    j = await r.json();
  } catch {
    // Not the parse error's message: it quotes the start of the body.
    throw new RequestFailed('network: the answer was not JSON');
  }
  // Railway answers HTTP 200 with an `errors` array for every failure, including auth failure.
  if (j?.errors?.length) throw new RequestFailed('GraphQL: Railway refused the request');
  return j?.data;
}

/** What the tool is doing, for the one line a failure prints. */
let step = 'reading the project token';
/** Set once the upsert is sent: from then on a failure leaves the write's outcome unknown. */
let writeSent = false;

async function main() {
  const me = await gql('query { projectToken { projectId environmentId } }');
  const projectId = me.projectToken.projectId;
  const environmentId = me.projectToken.environmentId;

  step = 'listing the services';
  const proj = await gql(
    'query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }',
    { id: projectId },
  );
  const svc = proj.project.services.edges.map(e => e.node).find(n => n.name === serviceName);
  if (!svc) { console.error(`no service "${serviceName}"`); process.exit(1); }

  // Railway returns every variable of the service; only the one asked for is kept.
  const read = async () => {
    const q = await gql(
      `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
         variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
       }`,
      { projectId, environmentId, serviceId: svc.id },
    );
    return q.variables?.[varName];
  };

  step = `reading ${varName} on ${serviceName}`;
  const old = await read();
  console.log(`service : ${serviceName}`);
  console.log(`variable: ${varName}`);
  console.log(`before  : ${old === undefined || old === '' ? '(unset)' : `${old.length} chars, sha256:${fp(old)}`}`);
  console.log(`after   : ${value.length} chars, sha256:${fp(value)}`);
  if (old === value) { console.log('\nno change needed — the value is already what was asked for'); process.exit(0); }
  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply'); process.exit(0); }

  step = `writing ${varName} on ${serviceName}`;
  writeSent = true;
  await gql(
    'mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }',
    { input: { projectId, environmentId, serviceId: svc.id, name: varName, value } },
  );

  // Read back rather than trust the mutation's return — a write that reported success and did not
  // land is a failure this project has already had once, on an image pin.
  step = `reading ${varName} back on ${serviceName}`;
  const now = await read();
  if (now !== value) {
    console.error(`\nVERIFY FAILED — reads back as ${now === undefined ? '(unset)' : `${now.length} chars, sha256:${fp(now)}`}`);
    process.exit(1);
  }
  console.log('\nwritten and verified. This upsert does not pass skipDeploys (API default false), so Railway redeploys the service with it; confirm that deployment in Railway.');
}

main().catch((e) => {
  // Only this tool's own fixed text: an unexpected error's message is not known to be value-free.
  const why = e instanceof RequestFailed ? e.message : `unexpected ${e instanceof Error ? e.name : 'error'}`;
  const next = writeSent
    ? ' Whether the write landed is unknown; rerun the same command without --apply to compare what Railway holds with the file.'
    : '';
  console.error(`FAILED while ${step}: ${why}.${next} Railway's own error text is not printed, because it can quote the value.`);
  process.exitCode = 1;
});
