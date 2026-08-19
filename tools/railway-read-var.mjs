#!/usr/bin/env node
/**
 * Read ONE Railway service variable into a gitignored file, without ever printing it.
 *
 * ★ WHY THIS EXISTS AS A TOOL RATHER THAN AN AD-HOC CALL. Operator maintenance on CSS (deleting
 * disposable pods, retiring superseded descriptors) needs the css-gate's operator bearer, and the
 * one thing that must never happen to that value is landing in a transcript, a log or a commit. So
 * the value goes straight from Railway's API to `.interego/<name>.txt` — which `.gitignore` covers
 * at line 64 — and stdout gets a byte count, never the secret.
 *
 * Usage:
 *   RAILWAY_PROJECT_TOKEN=... node tools/railway-read-var.mjs <service> <VAR_NAME>
 *
 * Writes `.interego/<service>-<var-name-lowercased>.txt` and prints only the path and length.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const EP = 'https://backboard.railway.com/graphql/v2';

const token = process.env.RAILWAY_PROJECT_TOKEN
  ?? (existsSync(join(REPO, '.interego/railway-token.txt'))
    ? readFileSync(join(REPO, '.interego/railway-token.txt'), 'utf8').trim()
    : null);
if (!token) {
  console.error('RAILWAY_PROJECT_TOKEN not set and .interego/railway-token.txt not found');
  process.exit(2);
}

const [serviceName, varName] = process.argv.slice(2);
if (!serviceName || !varName) {
  console.error('usage: node tools/railway-read-var.mjs <service> <VAR_NAME>');
  process.exit(2);
}

const H = { 'Content-Type': 'application/json', 'Project-Access-Token': token };
async function gql(query, variables = {}) {
  const r = await fetch(EP, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map(e => e.message).join('; '));
  return j.data;
}

const me = await gql(`query { projectToken { projectId environmentId } }`);
const projectId = me.projectToken.projectId;
const environmentId = me.projectToken.environmentId;

const proj = await gql(
  `query($id: String!) { project(id: $id) { services { edges { node { id name } } } } }`,
  { id: projectId },
);
const svc = proj.project.services.edges.map(e => e.node).find(n => n.name === serviceName);
if (!svc) {
  console.error(`no service named "${serviceName}". Have: `
    + proj.project.services.edges.map(e => e.node.name).sort().join(', '));
  process.exit(1);
}

const vars = await gql(
  `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
     variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
   }`,
  { projectId, environmentId, serviceId: svc.id },
);

const value = vars.variables?.[varName];
if (value === undefined) {
  console.error(`service "${serviceName}" has no variable "${varName}". `
    + `It defines: ${Object.keys(vars.variables ?? {}).sort().join(', ')}`);
  process.exit(1);
}

mkdirSync(join(REPO, '.interego'), { recursive: true });
const out = join(REPO, '.interego', `${serviceName}-${varName.toLowerCase().replace(/_/g, '-')}.txt`);
writeFileSync(out, value, 'utf8');
// Length only. Never the value.
console.log(`wrote ${out} (${value.length} chars)`);
