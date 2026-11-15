/**
 * Trusted-master runner only (.github/workflows/coached-world-guest-provision.yml): turn on the
 * coached world's guests at identity, and the general guest beside them, without any secret
 * reaching a log, a transcript or a person.
 *
 * In this order, each step done only when it is not done already:
 *
 *   1. The Railway token is the fleet's, and there is exactly one service of each name.
 *   2. The service key, CPW_PLAY_SERVICE_PRIVATE_KEY on the coached world. One already set is
 *      used and NEVER overwritten. Otherwise one is generated here and written at once, before
 *      anything is created with it, so a run that stops later is resumed with the same key.
 *   3. The service's identity account and its agent's registration with the relay
 *      (applications/foxxi-content-intelligence/tools/setup-play-service.mjs, steps 3 and 4 of
 *      DURABLE-GUEST.md). The account is created only with `apply`, and where identity states
 *      hosted terms only when the version given is the one it states.
 *   4. The coached world's settings: CPW_IDENTITY_URL, CPW_GENERAL_GUEST,
 *      CPW_GENERAL_GUEST_DOOR_ORIGIN. CPW_PLAY_AUDIENCE is left unset (the audience is the
 *      service's public URL), and CPW_RELAY_URL too (the default is the relay used here).
 *   5. Identity, last: this origin's entry merged into PROVISIONAL_PLAY_CLIENTS, then
 *      GENERAL_GUEST_DOOR_ORIGIN, then PROVISIONAL_GENERAL_GUEST=1.
 *
 * ★ A MALFORMED PROVISIONAL_PLAY_CLIENTS STOPS IDENTITY AT START, and identity is everyone's
 * sign-in. So the value already there is checked before anything is written, every other
 * application's entry is carried over untouched, and the merged value is checked against the
 * rules identity enforces (`parsePlayClients` in deploy/identity/provisional-play.ts, mirrored in
 * `checkPlayClients` below and held to the real one by
 * applications/coached-world/tests/the-guest-entry-is-one-identity-accepts.test.ts) before it is sent.
 *
 * ★ NOTHING IS DEPLOYED. Every write carries `skipDeploys: true`; the run ends by naming the
 * services to redeploy. Without `apply` nothing is written and no key is generated.
 *
 * What is printed: the service wallet's ADDRESS, the agent DID, the pod URL, variable NAMES, and
 * the ORIGINS in the client list. Never a key, a token, or another application's entry.
 */
import { pathToFileURL } from 'node:url';
import { Wallet } from 'ethers';
import { TARGET, ProvisionRefusal, newKey } from './vertical-bridges-provision.mjs';
import { setupPlayService } from '../applications/foxxi-content-intelligence/tools/setup-play-service.mjs';

export { TARGET, ProvisionRefusal };
export const WORLD_ORIGIN = 'https://coached-world-bridge-production.up.railway.app';
export const IDENTITY_URL = 'https://identity.interego.xwisee.com';
export const RELAY_URL = 'https://relay.interego.xwisee.com';
export const DEFAULT_DOOR_ORIGIN = 'https://door.interego.xwisee.com';
/** Railway service names, as tools/railway-services.mjs has them. */
export const WORLD_SERVICE = 'coached-world-bridge';
export const IDENTITY_SERVICE = 'identity';
export const KEY_VAR = 'CPW_PLAY_SERVICE_PRIVATE_KEY';
export const NAMESPACE = 'coached-world';
export const RETURN_PATH = '/play/general/return';

const KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;
const refuse = (message) => { throw new ProvisionRefusal(message); };
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);

// ── Identity's own rules, mirrored (deploy/identity/provisional-play.ts) ─────────────────────────

/** `isGuestReturnPath`. */
export function isGuestReturnPath(value) {
  return typeof value === 'string' && /^\/[A-Za-z0-9._~/-]{0,127}$/.test(value) && !value.includes('//') && !value.split('/').includes('..');
}
const RESERVED_NAMESPACES = new Set(['context-graphs', 'agents', 'profile', 'settings', 'inbox', 'play-budget',
  'play-exchanges', 'play-exchange-limits', 'play-limits', 'auth-methods']);
const isPlayNamespace = (value) => typeof value === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(value) && !RESERVED_NAMESPACES.has(value);
const isPlayOrigin = (value) => {
  if (typeof value !== 'string' || value.length > 256) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
};

/**
 * `parsePlayClients`, as a check: the parsed object where identity would start with `raw`, a
 * refusal where it would not. `what` names the value in the refusal; no part of the value does.
 */
export function checkPlayClients(raw, what = 'PROVISIONAL_PLAY_CLIENTS') {
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return refuse(`${what} is not JSON; identity would not start with it`); }
  if (!record(parsed)) return refuse(`${what} is not a JSON object; identity would not start with it`);
  let n = 0;
  for (const [audience, value] of Object.entries(parsed)) {
    n += 1;
    const bad = (why) => refuse(`${what}: entry ${n} ${why}; identity would not start with it`);
    if (!isPlayOrigin(audience)) bad('is not keyed by an application origin');
    if (!value || typeof value.agentDid !== 'string' || !/^did:web:[^\s]+:agents:[A-Za-z0-9._~-]+$/.test(value.agentDid)) bad('has no valid agentDid');
    let pod;
    try { pod = new URL(value.podUrl); } catch { bad('has no valid podUrl'); }
    if (pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || !pod.pathname.endsWith('/')) bad('has no valid podUrl');
    if (value.namespace !== undefined && !isPlayNamespace(value.namespace)) bad('has an invalid namespace');
    if (value.maxPods !== undefined && (!Number.isInteger(value.maxPods) || value.maxPods < 1 || value.maxPods > 1000)) bad('has an invalid maxPods');
    if (value.generalGuest !== undefined && typeof value.generalGuest !== 'boolean') bad('has an invalid generalGuest');
    if (value.generalGuest === true && !isGuestReturnPath(value.generalGuestReturnPath)) bad('has an invalid generalGuestReturnPath');
  }
  return parsed;
}

/** `parseDoorOrigin` (deploy/identity/provisional-general-guest-routes.ts): an HTTPS origin, no path, not identity's own. */
export function checkDoorOrigin(value, issuer = IDENTITY_URL) {
  if (typeof value !== 'string' || !value) return refuse('door_origin is empty');
  let url;
  try { url = new URL(value); } catch { return refuse('door_origin is not a URL'); }
  // Identity allows http on loopback for its own tests; a production door is HTTPS.
  if (url.origin !== value || url.protocol !== 'https:') return refuse('door_origin must be an HTTPS origin with no path');
  if (url.origin === new URL(issuer).origin) return refuse('door_origin must not be the identity server\'s own origin');
  return url.origin;
}

/**
 * The coached world's entry merged into the client list. Every other entry is the object that was
 * parsed, in its place; an entry already there for this origin keeps whatever else it holds.
 */
export function mergePlayClients(existingRaw, { agentDid, podUrl, maxPods }) {
  const existing = checkPlayClients(existingRaw, 'the PROVISIONAL_PLAY_CLIENTS already on identity');
  const entry = { ...(record(existing[WORLD_ORIGIN]) ?? {}), agentDid, podUrl, namespace: NAMESPACE, maxPods, generalGuest: true, generalGuestReturnPath: RETURN_PATH };
  // An entry already there keeps its place; a new one goes last.
  const merged = Object.hasOwn(existing, WORLD_ORIGIN)
    ? Object.fromEntries(Object.entries(existing).map(([origin, was]) => [origin, origin === WORLD_ORIGIN ? entry : was]))
    : { ...existing, [WORLD_ORIGIN]: entry };
  const value = JSON.stringify(merged);
  checkPlayClients(value, 'the merged PROVISIONAL_PLAY_CLIENTS');
  for (const [origin, was] of Object.entries(existing)) {
    if (origin !== WORLD_ORIGIN && JSON.stringify(merged[origin]) !== JSON.stringify(was)) refuse('the merge would change another application\'s entry');
  }
  return { value, origins: Object.keys(merged), unchanged: !!existingRaw && JSON.stringify(existing) === value };
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────

export async function provisionGuest({ gql, fetch: request, apply = false, acceptTermsVersion, maxPods = 25, doorOrigin = DEFAULT_DOOR_ORIGIN, rand, now, log = () => {} }) {
  // Inputs first: a bad one is refused before any request.
  const door = checkDoorOrigin(doorOrigin);
  if (!Number.isInteger(maxPods) || maxPods < 1 || maxPods > 1000) refuse('max_pods must be a whole number from 1 to 1000');
  const terms = typeof acceptTermsVersion === 'string' && acceptTermsVersion.trim() ? acceptTermsVersion.trim() : undefined;

  // 1. The token and the two services.
  const token = await gql('{projectToken{projectId environmentId}}');
  if (token?.projectToken?.projectId !== TARGET.projectId || token?.projectToken?.environmentId !== TARGET.environmentId) {
    refuse('the token does not belong to the fleet project and environment this tool is pinned to');
  }
  const project = await gql('query($p:String!){project(id:$p){services{edges{node{id name}}}}}', { p: TARGET.projectId });
  const services = (project?.project?.services?.edges ?? []).map((e) => e?.node).filter(Boolean);
  const ids = {};
  for (const name of [WORLD_SERVICE, IDENTITY_SERVICE]) {
    const found = services.filter((s) => s.name === name);
    if (found.length !== 1) refuse(`expected exactly one service named ${name}, found ${found.length}`);
    ids[name] = found[0].id;
  }
  /** The variables of one service: every name, and the values of `wanted` only. The rest are dropped here. */
  const read = async (service, wanted) => {
    const d = await gql('query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}',
      { p: TARGET.projectId, e: TARGET.environmentId, s: ids[service] });
    const all = record(d?.variables) ?? {};
    return { names: new Set(Object.keys(all)), values: Object.fromEntries(wanted.filter((n) => typeof all[n] === 'string').map((n) => [n, all[n]])) };
  };
  const done = { [WORLD_SERVICE]: { set: [], kept: [] }, [IDENTITY_SERVICE]: { set: [], kept: [] } };
  const write = async (service, name, value) => {
    const r = await gql('mutation($input:VariableUpsertInput!){variableUpsert(input:$input)}', {
      input: { projectId: TARGET.projectId, environmentId: TARGET.environmentId, serviceId: ids[service], name, value, skipDeploys: true },
    });
    if (r?.variableUpsert !== true) refuse(`Railway did not confirm writing ${name} on ${service}`);
    const after = await read(service, [name]);
    if (after.values[name] !== value) refuse(`${service}: Railway accepted the write but does not hold ${name} as written`);
    done[service].set.push(name);
  };
  /** Bring one plain setting to `value`: written when it differs, kept when it is already that. */
  const settle = async (service, state, name, value) => {
    if (state.values[name] === value) { done[service].kept.push(name); log(`${service}: keep ${name}  (already as wanted)`); return; }
    log(`${service}: ${apply ? 'set ' : 'would set'} ${name}`);
    if (apply) await write(service, name, value);
  };

  const world = await read(WORLD_SERVICE, [KEY_VAR, 'CPW_IDENTITY_URL', 'CPW_GENERAL_GUEST', 'CPW_GENERAL_GUEST_DOOR_ORIGIN',
    'CPW_PLAY_AUDIENCE', 'CPW_RELAY_URL', 'BRIDGE_DEPLOYMENT_URL', 'CPW_PUBLIC_URL']);
  const identity = await read(IDENTITY_SERVICE, ['PROVISIONAL_PLAY_CLIENTS', 'PROVISIONAL_GENERAL_GUEST', 'GENERAL_GUEST_DOOR_ORIGIN']);

  // Everything that can be refused from what is already there is refused now, before any write.
  checkPlayClients(identity.values.PROVISIONAL_PLAY_CLIENTS, 'the PROVISIONAL_PLAY_CLIENTS already on identity');
  if (world.values.CPW_PLAY_AUDIENCE && world.values.CPW_PLAY_AUDIENCE !== WORLD_ORIGIN) {
    refuse(`${WORLD_SERVICE} has CPW_PLAY_AUDIENCE set to something other than ${WORLD_ORIGIN}; unset it there first`);
  }
  if (world.values.CPW_RELAY_URL && world.values.CPW_RELAY_URL.replace(/\/+$/, '') !== RELAY_URL) {
    refuse(`${WORLD_SERVICE} has CPW_RELAY_URL set to a relay other than ${RELAY_URL}, where this tool registers the agent`);
  }
  const publicUrl = world.values.BRIDGE_DEPLOYMENT_URL ?? world.values.CPW_PUBLIC_URL;
  if (publicUrl === undefined) refuse(`${WORLD_SERVICE} has neither BRIDGE_DEPLOYMENT_URL nor CPW_PUBLIC_URL, so it has no guest audience; set it to ${WORLD_ORIGIN} first`);
  // A reference Railway hands back unresolved cannot be compared here; the service resolves it at start.
  if (publicUrl.includes('${{')) log(`${WORLD_SERVICE}: its public URL is a Railway reference; check that it resolves to ${WORLD_ORIGIN}`);
  else if (publicUrl.replace(/\/+$/, '') !== WORLD_ORIGIN) refuse(`${WORLD_SERVICE}'s public URL is not ${WORLD_ORIGIN}, the origin this tool registers at identity`);
  let key = world.values[KEY_VAR];
  if (key !== undefined && !KEY_SHAPE.test(key)) refuse(`${KEY_VAR} is set on ${WORLD_SERVICE} but is not 0x + 64 hex; it is not replaced here. Fix or remove it there`);

  // 2. The service key.
  if (key !== undefined) {
    done[WORLD_SERVICE].kept.push(KEY_VAR);
    log(`${WORLD_SERVICE}: keep ${KEY_VAR}  (already set; the key is never overwritten)`);
  } else if (!apply) {
    log(`${WORLD_SERVICE}: would set ${KEY_VAR}  (not set; it WOULD BE GENERATED on an applied run. None was generated now)`);
    log('Without the key the service has no wallet yet, so its account, its agent and the entry for identity cannot be looked up. An applied run would then:');
    log(`  create the service's account on ${IDENTITY_URL} (needs accept_terms_version where identity states terms) and register its agent with ${RELAY_URL};`);
    log(`  set CPW_IDENTITY_URL, CPW_GENERAL_GUEST, CPW_GENERAL_GUEST_DOOR_ORIGIN on ${WORLD_SERVICE};`);
    log(`  merge ${WORLD_ORIGIN} into PROVISIONAL_PLAY_CLIENTS and set GENERAL_GUEST_DOOR_ORIGIN, PROVISIONAL_GENERAL_GUEST on ${IDENTITY_SERVICE}.`);
    log('dry run: nothing written.');
    return { applied: false, ready: false, services: done };
  } else {
    // A new key means a new account. Where identity states terms, they are settled before the
    // key is generated, so a run that stops for them has written nothing.
    const stated = await request(`${IDENTITY_URL}/.well-known/hosted-interego-terms`, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!stated.ok) refuse(`identity did not state its terms (${stated.status}); nothing was written`);
    const policy = record(record(await stated.json())?.terms);
    if (policy && typeof policy.version === 'string' && policy.version !== terms) {
      refuse(`identity requires agreement to its hosted terms, version ${policy.version}${typeof policy.url === 'string' ? ` (${policy.url})` : ''}. `
        + `${terms ? 'The version given is not that one. ' : ''}Read them, then run again with accept_terms_version set to that version. Nothing was written`);
    }
    key = `0x${newKey(rand)}`;
    log(`${WORLD_SERVICE}: set  ${KEY_VAR}  (generated now, never shown)`);
    await write(WORLD_SERVICE, KEY_VAR, key);
    log(`Back up ${KEY_VAR} now: Railway → ${WORLD_SERVICE} → Variables. It is the service's account.`);
  }
  const address = new Wallet(key).address;

  // 3. The account and the agent. The script's own closing notes are for Foxxi's operator and are
  // dropped; everything before them is its account of what it found and did.
  let closing = false;
  const outcome = await setupPlayService({
    privateKey: key,
    options: { createAccount: apply, registerAgent: apply, acceptTerms: terms, audience: WORLD_ORIGIN, identityUrl: IDENTITY_URL, relayUrl: RELAY_URL, serviceName: 'Coached world play service' },
    fetch: request,
    log: (line) => { if (line === '') closing = true; if (!closing) log(`  setup: ${line}`); },
    ...(now ? { now } : {}),
  });
  if (outcome.exitCode === 3) refuse('identity\'s hosted terms are not accepted (the version and where to read them are above). Run again with accept_terms_version set to that version. The account was not created and no setting was changed');
  if (!apply && !outcome.ready) {
    log('The account or the agent is not ready (above). An applied run would create and register them, then:');
    log(`  set CPW_IDENTITY_URL, CPW_GENERAL_GUEST, CPW_GENERAL_GUEST_DOOR_ORIGIN on ${WORLD_SERVICE} where they differ;`);
    log(`  merge ${WORLD_ORIGIN} into PROVISIONAL_PLAY_CLIENTS and set GENERAL_GUEST_DOOR_ORIGIN, PROVISIONAL_GENERAL_GUEST on ${IDENTITY_SERVICE}.`);
    log('dry run: nothing written.');
    return { applied: false, ready: false, address, services: done };
  }
  const agentDid = outcome.service?.agentDid, podUrl = outcome.service?.podUrl;
  if (!outcome.ready || !agentDid || !podUrl) refuse('the service\'s account or agent is not ready (identity\'s or the relay\'s answer is above). No further setting was changed; run again once that is resolved');

  // The merged list is worked out, and refused if identity would not take it, before step 4 writes.
  const merged = mergePlayClients(identity.values.PROVISIONAL_PLAY_CLIENTS, { agentDid, podUrl, maxPods });

  // 4. The coached world.
  await settle(WORLD_SERVICE, world, 'CPW_IDENTITY_URL', IDENTITY_URL);
  await settle(WORLD_SERVICE, world, 'CPW_GENERAL_GUEST', '1');
  await settle(WORLD_SERVICE, world, 'CPW_GENERAL_GUEST_DOOR_ORIGIN', door);

  // 5. Identity, last; and the switch that opens the door last of all.
  if (merged.unchanged) {
    done[IDENTITY_SERVICE].kept.push('PROVISIONAL_PLAY_CLIENTS');
    log(`${IDENTITY_SERVICE}: keep PROVISIONAL_PLAY_CLIENTS  (already holds this entry)`);
  } else {
    log(`${IDENTITY_SERVICE}: ${apply ? 'set ' : 'would set'} PROVISIONAL_PLAY_CLIENTS  (this origin's entry merged; the others untouched)`);
    if (apply) await write(IDENTITY_SERVICE, 'PROVISIONAL_PLAY_CLIENTS', merged.value);
  }
  await settle(IDENTITY_SERVICE, identity, 'GENERAL_GUEST_DOOR_ORIGIN', door);
  await settle(IDENTITY_SERVICE, identity, 'PROVISIONAL_GENERAL_GUEST', '1');

  log('');
  log(`Service wallet address: ${address}`);
  log(`Agent the relay signs it as: ${agentDid}`);
  log(`Pod: ${podUrl}`);
  log(`Applications in PROVISIONAL_PLAY_CLIENTS${apply ? '' : ' after an applied run'}: ${merged.origins.join(', ')}`);
  // Both services, always: this run cannot tell whether a setting an EARLIER run wrote (one that
  // then failed part-way) has been deployed since, so a successful run never names fewer.
  const redeploy = [IDENTITY_SERVICE, WORLD_SERVICE];
  const wrote = redeploy.some((s) => done[s].set.length > 0);
  if (!apply) log('dry run: nothing written. Re-run with apply ticked to write the above.');
  else log(`${wrote ? 'Written without deploying' : 'Nothing needed writing in this run'}. Redeploy, in this order: ${redeploy.join(', then ')}: `
    + 'a setting written by this run or an earlier one is in effect only once its service has been deployed since.');
  log(`The door's host (${new URL(door).host}) must be routed to the ${IDENTITY_SERVICE} service; this tool adds no domain.`);
  return { applied: apply, ready: true, address, agentDid, podUrl, origins: merged.origins, services: done, redeploy: apply ? redeploy : [] };
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
  const maxPods = (process.env.MAX_PODS ?? '').trim();
  if (maxPods && !/^[0-9]+$/.test(maxPods)) throw new ProvisionRefusal('max_pods must be a whole number from 1 to 1000');
  await provisionGuest({
    gql,
    fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) }),
    apply: process.env.APPLY === 'true',
    acceptTermsVersion: process.env.ACCEPT_TERMS_VERSION,
    ...(maxPods ? { maxPods: Number(maxPods) } : {}),
    ...((process.env.DOOR_ORIGIN ?? '').trim() ? { doorOrigin: process.env.DOOR_ORIGIN.trim() } : {}),
    log: (line) => console.log(line),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof ProvisionRefusal
      ? `refused: ${e.message}`
      : 'provisioning failed at a request to Railway, identity or the relay; no value or response is logged. Settings already written stay; a re-run continues from them.');
    process.exitCode = 1;
  });
}
