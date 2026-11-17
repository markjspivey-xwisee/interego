/**
 * Trusted-master runner only (.github/workflows/general-guest-opt-in.yml): opt an application that
 * identity ALREADY admits guests for into the general guest, without any value reaching a log.
 *
 * tools/coached-world-guest-provision.mjs sets an application up from nothing (key, account,
 * agent, entry). This one is for an application whose entry and service key exist already: it
 * adds `generalGuest` and `generalGuestReturnPath` to that entry and turns the application's own
 * switch on. It creates no key, no account and no entry, and it refuses where any is missing.
 *
 *   1. The Railway token is the fleet's, and there is exactly one service of each name.
 *   2. Identity already has the general guest on (PROVISIONAL_GENERAL_GUEST=1) and states a door.
 *      The door the application is given is the one identity states, so the two cannot disagree.
 *   3. Identity's PROVISIONAL_PLAY_CLIENTS already holds this application's origin, and the
 *      application's service already holds its guest key (the NAME is checked, never the value).
 *   4. Identity first: the entry gains the two fields, every other field and entry untouched.
 *      Until the application's switch is on this shows nothing to anyone.
 *   5. The application: its door origin, then its switch.
 *
 * ★ A MALFORMED PROVISIONAL_PLAY_CLIENTS STOPS IDENTITY AT START. The value there is checked
 * before anything is written and the merged value is checked by the same rules before it is sent
 * (`checkPlayClients`, held to identity's own parser by
 * applications/coached-world/tests/the-guest-entry-is-one-identity-accepts.test.ts).
 *
 * ★ NOTHING IS DEPLOYED (`skipDeploys: true`). Without `apply` nothing is written.
 *
 * Printed: variable NAMES and the application's own origin. Never a value or another entry.
 */
import { pathToFileURL } from 'node:url';
import { TARGET, ProvisionRefusal, IDENTITY_SERVICE, checkPlayClients, checkDoorOrigin, isGuestReturnPath } from './coached-world-guest-provision.mjs';

export { TARGET, ProvisionRefusal, IDENTITY_SERVICE };

/**
 * The applications this tool knows. `returnPath` is the route the application serves for the
 * door's return; `needs` is the variable that holds its guest service key; `doorVar` and
 * `switchVar` are its own settings.
 */
export const APPLICATIONS = Object.freeze({
  // applications/foxxi-content-intelligence/src/i2idlx-learning-auth.ts (GENERAL_GUEST_RETURN_PATH)
  // and src/i2idlx-general-guest.ts.
  'foxxi-workbench': Object.freeze({
    origin: 'https://foxxi-bridge.interego.xwisee.com',
    service: 'foxxi-bridge',
    returnPath: '/i2idlx/learning/guest/general/return',
    needs: 'FOXXI_I2IDLX_GUEST_SERVICE_PRIVATE_KEY',
    doorVar: 'FOXXI_I2IDLX_GENERAL_GUEST_DOOR_ORIGIN',
    switchVar: 'FOXXI_I2IDLX_GENERAL_GUEST',
  }),
});

const refuse = (message) => { throw new ProvisionRefusal(message); };
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : undefined);

/** The entry for `origin` with the two fields added; everything else the object that was parsed. */
export function optInPlayClients(existingRaw, origin, returnPath) {
  if (!isGuestReturnPath(returnPath)) refuse('the return path is not one identity accepts');
  const existing = checkPlayClients(existingRaw, 'the PROVISIONAL_PLAY_CLIENTS already on identity');
  if (!Object.hasOwn(existing, origin)) refuse(`identity admits no guests for ${origin} yet; this tool only opts in an application that is already set up`);
  const merged = Object.fromEntries(Object.entries(existing).map(([o, was]) => [o, o === origin ? { ...was, generalGuest: true, generalGuestReturnPath: returnPath } : was]));
  const value = JSON.stringify(merged);
  checkPlayClients(value, 'the merged PROVISIONAL_PLAY_CLIENTS');
  for (const [o, was] of Object.entries(existing)) {
    if (o !== origin && JSON.stringify(merged[o]) !== JSON.stringify(was)) refuse('the merge would change another application\'s entry');
  }
  const before = existing[origin];
  for (const [k, v] of Object.entries(before)) {
    if (k !== 'generalGuest' && k !== 'generalGuestReturnPath' && JSON.stringify(merged[origin][k]) !== JSON.stringify(v)) refuse('the merge would change a field of the entry other than the two it adds');
  }
  return { value, unchanged: JSON.stringify(existing) === value };
}

export async function optIn({ gql, application, apply = false, log = () => {} }) {
  const app = Object.hasOwn(APPLICATIONS, application) ? APPLICATIONS[application] : refuse(`application must be one of: ${Object.keys(APPLICATIONS).join(', ')}`);

  // 1. The token and the two services.
  const token = await gql('{projectToken{projectId environmentId}}');
  if (token?.projectToken?.projectId !== TARGET.projectId || token?.projectToken?.environmentId !== TARGET.environmentId) {
    refuse('the token does not belong to the fleet project and environment this tool is pinned to');
  }
  const project = await gql('query($p:String!){project(id:$p){services{edges{node{id name}}}}}', { p: TARGET.projectId });
  const services = (project?.project?.services?.edges ?? []).map((e) => e?.node).filter(Boolean);
  const ids = {};
  for (const name of [app.service, IDENTITY_SERVICE]) {
    const found = services.filter((s) => s.name === name);
    if (found.length !== 1) refuse(`expected exactly one service named ${name}, found ${found.length}`);
    ids[name] = found[0].id;
  }
  /** Every variable NAME of one service, and the values of `wanted` only. */
  const read = async (service, wanted) => {
    const d = await gql('query($p:String!,$e:String!,$s:String!){variables(projectId:$p,environmentId:$e,serviceId:$s)}',
      { p: TARGET.projectId, e: TARGET.environmentId, s: ids[service] });
    const all = record(d?.variables) ?? {};
    return { names: new Set(Object.keys(all)), values: Object.fromEntries(wanted.filter((n) => typeof all[n] === 'string').map((n) => [n, all[n]])) };
  };
  const done = { [app.service]: { set: [], kept: [] }, [IDENTITY_SERVICE]: { set: [], kept: [] } };
  const write = async (service, name, value) => {
    const r = await gql('mutation($input:VariableUpsertInput!){variableUpsert(input:$input)}', {
      input: { projectId: TARGET.projectId, environmentId: TARGET.environmentId, serviceId: ids[service], name, value, skipDeploys: true },
    });
    if (r?.variableUpsert !== true) refuse(`Railway did not confirm writing ${name} on ${service}`);
    const after = await read(service, [name]);
    if (after.values[name] !== value) refuse(`${service}: Railway accepted the write but does not hold ${name} as written`);
    done[service].set.push(name);
  };
  const settle = async (service, state, name, value) => {
    if (state.values[name] === value) { done[service].kept.push(name); log(`${service}: keep ${name}  (already as wanted)`); return; }
    log(`${service}: ${apply ? 'set ' : 'would set'} ${name}`);
    if (apply) await write(service, name, value);
  };

  const identity = await read(IDENTITY_SERVICE, ['PROVISIONAL_PLAY_CLIENTS', 'PROVISIONAL_GENERAL_GUEST', 'GENERAL_GUEST_DOOR_ORIGIN']);
  const mine = await read(app.service, [app.doorVar, app.switchVar]);

  // 2 and 3. Everything that can be refused is refused before any write.
  if (identity.values.PROVISIONAL_GENERAL_GUEST !== '1') refuse('identity does not have the general guest on (PROVISIONAL_GENERAL_GUEST); turn it on there first');
  const door = checkDoorOrigin(identity.values.GENERAL_GUEST_DOOR_ORIGIN ?? '');
  if (door === new URL(app.origin).origin) refuse('the door identity states is this application\'s own origin');
  if (!mine.names.has(app.needs)) refuse(`${app.service} has no ${app.needs}; its own guests are not set up, and this tool creates no key`);
  const merged = optInPlayClients(identity.values.PROVISIONAL_PLAY_CLIENTS, app.origin, app.returnPath);

  // 4. Identity.
  if (merged.unchanged) {
    done[IDENTITY_SERVICE].kept.push('PROVISIONAL_PLAY_CLIENTS');
    log(`${IDENTITY_SERVICE}: keep PROVISIONAL_PLAY_CLIENTS  (${app.origin} is already opted in)`);
  } else {
    log(`${IDENTITY_SERVICE}: ${apply ? 'set ' : 'would set'} PROVISIONAL_PLAY_CLIENTS  (${app.origin} opted in; nothing else changed)`);
    if (apply) await write(IDENTITY_SERVICE, 'PROVISIONAL_PLAY_CLIENTS', merged.value);
  }
  // 5. The application: the door before the switch, since the switch without a door stops it at start.
  await settle(app.service, mine, app.doorVar, door);
  await settle(app.service, mine, app.switchVar, '1');

  const redeploy = [IDENTITY_SERVICE, app.service];
  if (!apply) log('dry run: nothing written. Re-run with apply ticked to write the above.');
  else log(`${redeploy.some((s) => done[s].set.length > 0) ? 'Written without deploying' : 'Nothing needed writing in this run'}. Redeploy, in this order: ${redeploy.join(', then ')}.`);
  return { applied: apply, services: done, redeploy: apply ? redeploy : [] };
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
  await optIn({ gql, application: (process.env.APPLICATION ?? '').trim(), apply: process.env.APPLY === 'true', log: (line) => console.log(line) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof ProvisionRefusal
      ? `refused: ${e.message}`
      : 'opting in failed at a request to Railway; no value or response is logged. Settings already written stay; a re-run continues from them.');
    process.exitCode = 1;
  });
}
