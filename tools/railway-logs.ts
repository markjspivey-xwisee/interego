/**
 * Read a Railway service's live deployment logs, filtered.
 *
 * Written because a live failure on this fleet is diagnosed from the relay's own log lines and
 * there was no way to read them without the dashboard. Same auth rule as
 * `tools/railway-redeploy.mjs`: a PROJECT token authenticates with the `Project-Access-Token`
 * header — sent as `Authorization: Bearer` Railway answers 200 with "Project Token not found",
 * which is indistinguishable from sending no credential at all. And HTTP 200 is not success:
 * every Railway GraphQL failure, auth included, arrives as 200 with an `errors` array.
 *
 *   RAILWAY_PROJECT_TOKEN=$(cat .interego/railway-token.txt) \
 *     npx tsx tools/railway-logs.ts relay [--filter <substring>] [--limit 500]
 */

import { resolveImageRepo } from './railway-services.mjs';

const EP = 'https://backboard.railway.com/graphql/v2';
const token = process.env['RAILWAY_PROJECT_TOKEN'];
if (!token) { process.stderr.write('RAILWAY_PROJECT_TOKEN is required\n'); process.exit(2); }

const argv = process.argv.slice(2);
const service = argv[0];
if (!service) { process.stderr.write('usage: railway-logs.ts <service> [--filter s] [--limit n]\n'); process.exit(2); }
const flag = (n: string): string | undefined => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const filter = flag('--filter') ?? '';
const limit = Number(flag('--limit') ?? '400');

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(EP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token as string },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json() as { data?: T; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error('railway: ' + j.errors.map(e => e.message).join('; '));
  if (!j.data) throw new Error('railway: no data (HTTP ' + r.status + ')');
  return j.data;
}

// Refuses an unknown service name before any network call, for the reason redeploy does.
resolveImageRepo(service);

const pt = await gql<{ projectToken: { projectId: string; environmentId: string } }>(
  '{ projectToken { projectId environmentId } }');
const { projectId, environmentId } = pt.projectToken;

const proj = await gql<{ project: { services: { edges: { node: { id: string; name: string } }[] } } }>(
  'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }', { id: projectId });
const node = proj.project.services.edges.map(e => e.node).find(n => n.name === service);
if (!node) throw new Error('no service named ' + service);

const si = await gql<{ serviceInstance: { latestDeployment: { id: string; status: string } | null } }>(
  'query($s:String!,$e:String!){ serviceInstance(serviceId:$s,environmentId:$e){ latestDeployment{ id status } } }',
  { s: node.id, e: environmentId });
const dep = si.serviceInstance.latestDeployment;
if (!dep) throw new Error('no deployment for ' + service);

const logs = await gql<{ deploymentLogs: { timestamp: string; message: string }[] }>(
  'query($id:String!,$limit:Int!,$filter:String){ deploymentLogs(deploymentId:$id,limit:$limit,filter:$filter){ timestamp message } }',
  { id: dep.id, limit, filter: filter || null });
for (const l of logs.deploymentLogs) process.stdout.write(l.timestamp + '  ' + l.message + '\n');
process.stdout.write('-- ' + logs.deploymentLogs.length + ' lines from ' + service + ' deployment ' + dep.id + ' (' + dep.status + ')\n');
