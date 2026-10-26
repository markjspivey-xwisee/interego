/**
 * Trusted-master runner only (.github/workflows/vertical-bridges-provision.yml): give the
 * work-redesign and practice-evidence bridges their signing and record keys without any value
 * reaching a log, a transcript or a person.
 *
 * Each bridge needs two 32-byte keys: `<P>_PLATFORM_KEY` signs its records and `<P>_RECORD_KEY`
 * seals their graphs. Nothing else is set here — the public URL and the pod credential reference
 * are plain configuration, set on the service like any other.
 *
 * ★ A KEY IS WRITTEN ONLY WHEN ABSENT, AND NEVER OVERWRITTEN. A record key that changes makes
 * every graph sealed to the old one unreadable, and a platform key that changes makes every
 * record signed with the old one untrusted — silently, in both cases. So the variable NAMES are
 * read first (Railway's API returns the values with them; they are dropped on the spot) and a
 * key already set is kept. Generated values go straight to Railway with `skipDeploys: true`; the
 * operator backs them up from the dashboard.
 *
 * Optionally copies PEV_LLM_API_KEY from the GitHub secret of that name, when it is present.
 */
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** The fleet's project and environment, as tools/pgsl-sweep-provision.mjs pins them. */
export const TARGET = Object.freeze({
  projectId: 'b88ceabb-7461-4949-81d7-3d29132e7806',
  environmentId: '449996a2-3533-462f-98c6-4ab4c05dd777',
});
export const BRIDGES = Object.freeze({ 'wrd-bridge': 'WRD', 'pev-bridge': 'PEV' });

/** A refusal this tool wrote itself; any other failure is reported without its text. */
export class ProvisionRefusal extends Error {}

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

/** 32 random bytes as hex, redrawn in the (astronomically unlikely) case it is not a valid secp256k1 key. */
export function newKey(rand = randomBytes) {
  for (;;) {
    const hex = rand(32).toString('hex');
    const n = BigInt(`0x${hex}`);
    if (n > 0n && n < SECP256K1_N) return hex;
  }
}

/** What to write to one service, given the names already set. Never a key that exists. */
export function planService(prefix, existing, { pevApiKey, rand } = {}) {
  const writes = [];
  const kept = [];
  for (const k of ['PLATFORM_KEY', 'RECORD_KEY']) {
    const name = `${prefix}_${k}`;
    if (existing.has(name)) kept.push(name);
    else writes.push({ name, value: newKey(rand), kind: 'generated' });
  }
  if (prefix === 'PEV' && pevApiKey) writes.push({ name: 'PEV_LLM_API_KEY', value: pevApiKey, kind: 'secret' });
  return { writes, kept };
}

export async function provisionBridges({ gql, pevApiKey, apply = false, rand, log = () => {} }) {
  const identity = await gql('{projectToken{projectId environmentId}}');
  if (identity?.projectToken?.projectId !== TARGET.projectId || identity?.projectToken?.environmentId !== TARGET.environmentId) {
    throw new ProvisionRefusal('the token does not belong to the fleet project and environment this tool is pinned to');
  }
  const project = await gql('query($p:String!){project(id:$p){services{edges{node{id name}}}}}', { p: TARGET.projectId });
  const services = (project?.project?.services?.edges ?? []).map((e) => e?.node).filter(Boolean);
  const ids = {};
  for (const name of Object.keys(BRIDGES)) {
    const found = services.filter((s) => s.name === name);
    if (found.length !== 1) throw new ProvisionRefusal(`expected exactly one service named ${name}, found ${found.length}`);
    ids[name] = found[0].id;
  }
  const namesOf = async (serviceId) => {
    const d = await gql('query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}',
      { p: TARGET.projectId, e: TARGET.environmentId, s: serviceId });
    // Names only. The values are dropped here and go nowhere.
    return new Set(Object.keys(d?.variables ?? {}));
  };

  const plans = {};
  for (const [name, prefix] of Object.entries(BRIDGES)) {
    plans[name] = planService(prefix, await namesOf(ids[name]), { pevApiKey, rand });
    for (const w of plans[name].writes) log(`${name}: set  ${w.name}  (${w.kind === 'generated' ? 'generated now, never shown' : 'copied from the GitHub secret, never shown'})`);
    for (const k of plans[name].kept) log(`${name}: keep ${k}  (already set; keys are never overwritten)`);
  }
  if (!apply) {
    log('dry run: nothing written. Re-run with apply ticked to write the above.');
    return { applied: false, services: summarise(plans) };
  }
  for (const [name, p] of Object.entries(plans)) {
    for (const w of p.writes) {
      const r = await gql('mutation($input:VariableUpsertInput!){variableUpsert(input:$input)}', {
        input: { projectId: TARGET.projectId, environmentId: TARGET.environmentId, serviceId: ids[name], name: w.name, value: w.value, skipDeploys: true },
      });
      if (r?.variableUpsert !== true) throw new ProvisionRefusal(`Railway did not confirm writing ${w.name} on ${name}`);
    }
    const now = await namesOf(ids[name]);
    const absent = p.writes.map((w) => w.name).filter((n) => !now.has(n));
    if (absent.length > 0) throw new ProvisionRefusal(`${name}: Railway accepted the writes but does not list ${absent.join(', ')}`);
  }
  const generated = Object.values(plans).flatMap((p) => p.writes.filter((w) => w.kind === 'generated').map((w) => w.name));
  if (generated.length > 0) log(`Back up ${generated.join(', ')} now: Railway → the service → Variables. A lost record key makes every record sealed to it unreadable.`);
  return { applied: true, services: summarise(plans) };
}

function summarise(plans) {
  return Object.fromEntries(Object.entries(plans).map(([n, p]) => [n, { set: p.writes.map((w) => w.name), kept: p.kept }]));
}

async function main() {
  const token = process.env.RAILWAY_PROJECT_TOKEN;
  if (!token) throw new ProvisionRefusal('RAILWAY_PROJECT_TOKEN is not set');
  const gql = async (query, variables = {}) => {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    // Railway answers 200 with an `errors` array for most failures. Its text is not logged.
    if (!response.ok || body.errors?.length) throw new Error('Railway refused a request');
    return body.data;
  };
  await provisionBridges({
    gql,
    pevApiKey: (process.env.PEV_LLM_API_KEY ?? '').trim() || undefined,
    apply: process.env.APPLY === 'true',
    log: (line) => console.log(line),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof ProvisionRefusal
      ? `refused: ${e.message}`
      : 'provisioning failed at a Railway request; no value or API response is logged.');
    process.exitCode = 1;
  });
}
