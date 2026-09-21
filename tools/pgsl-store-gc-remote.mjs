/**
 * Run tools/pgsl-store-gc.ts against the Railway Postgres from anywhere: open a temporary TCP
 * route to the database with the project token, hand the tool a connection string built from
 * the postgres service's own variables, close the route again whatever happens.
 *
 *   RAILWAY_PROJECT_TOKEN=... node tools/pgsl-store-gc-remote.mjs                  # dry run
 *   RAILWAY_PROJECT_TOKEN=... node tools/pgsl-store-gc-remote.mjs --rebuild        # swap the live rows in
 *   RAILWAY_PROJECT_TOKEN=... node tools/pgsl-store-gc-remote.mjs --drop <table>   # drop the previous table
 *   RAILWAY_PROJECT_TOKEN=... node tools/pgsl-store-gc-remote.mjs --tune
 *
 * ── WHY A ROUTE THAT EXISTS ONLY WHILE THE TOOL RUNS ──────────────────────────────────────
 *
 * The database is reachable on Railway's private network only, which the runners that would
 * schedule this cannot see. A permanent public route to Postgres is an attack surface nobody
 * asked for; a route that exists for the minutes a run takes and is deleted in `finally` is
 * the smallest thing that works, and it is how the store was measured and rebuilt by hand on
 * 2026-09-20. The credentials never reach a log: they are read from the API in-process and
 * passed to the child as an environment variable.
 *
 * Exit code is the tool's own; 2 when the route or the credentials could not be obtained.
 */

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { railwayGql } from './railway-pins.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function token() {
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
const { projectToken: { projectId, environmentId } } = await gql('{ projectToken { projectId environmentId } }');
const svc = await gql('query($p:String!){ project(id:$p){ services{ edges{ node{ id name } } } } }', { p: projectId });
const pg = svc.project.services.edges.find((e) => e.node.name === 'postgres');
if (!pg) { process.stderr.write('no service named postgres in this project\n'); process.exit(2); }
const vars = await gql('query($p:String!,$e:String!,$s:String!){ variables(projectId:$p, environmentId:$e, serviceId:$s) }', { p: projectId, e: environmentId, s: pg.node.id });
const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = vars.variables;
if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) { process.stderr.write('the postgres service does not carry POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB\n'); process.exit(2); }

const existing = await gql('query($e:String!,$s:String!){ tcpProxies(environmentId:$e, serviceId:$s){ id domain proxyPort applicationPort } }', { e: environmentId, s: pg.node.id });
let proxy = existing.tcpProxies.find((p) => p.applicationPort === 5432);
let createdId = null;
if (!proxy) {
  const r = await gql('mutation($in:TCPProxyCreateInput!){ tcpProxyCreate(input:$in){ id domain proxyPort applicationPort } }', { in: { environmentId, serviceId: pg.node.id, applicationPort: 5432 } });
  proxy = r.tcpProxyCreate;
  createdId = proxy.id;
  process.stdout.write(`opened a temporary route to postgres for this run\n`);
  await new Promise((res) => setTimeout(res, 8000));
} else {
  process.stdout.write(`a route to postgres already existed; it is left as found\n`);
}
const conn = `postgres://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@${proxy.domain.replace(/\.$/, '')}:${proxy.proxyPort}/${POSTGRES_DB}`;
let code = 1;
try {
  code = await new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'tools/pgsl-store-gc.ts', ...process.argv.slice(2)], {
      cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, PGSL_PG_CONNSTR: conn },
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
} finally {
  if (createdId) {
    try { await gql('mutation($id:String!){ tcpProxyDelete(id:$id) }', { id: createdId }); process.stdout.write('temporary route removed\n'); }
    catch (e) { process.stderr.write(`COULD NOT REMOVE the temporary route ${createdId}: ${e.message}\n`); code = code || 2; }
  }
}
process.exit(code);
