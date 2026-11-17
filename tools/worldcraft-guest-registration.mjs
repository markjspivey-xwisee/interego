import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkDoorOrigin, checkPlayClients, ProvisionRefusal, TARGET } from './coached-world-guest-provision.mjs';

const IDENTITY_SERVICE = '9f813936-9df0-4ec9-894c-63c4b09c7eb7';
const WORLDCRAFT_ORIGIN = 'https://worldcraft-meetup.markjspivey.workers.dev';
const VARIABLE = 'PROVISIONAL_PLAY_CLIENTS';

function refuse(reason) {
  throw new ProvisionRefusal(reason);
}

export async function registerWorldCraft({ gql, agentDid, podUrl, apply = false, log = console.log }) {
  const entry = {
    agentDid,
    podUrl,
    namespace: 'worldcraft-meetup',
    maxPods: 25,
    generalGuest: true,
    generalGuestReturnPath: '/guest/return',
  };
  checkPlayClients(JSON.stringify({ [WORLDCRAFT_ORIGIN]: entry }), 'WorldCraft entry');

  const scope = {
    projectId: TARGET.projectId,
    environmentId: TARGET.environmentId,
    serviceId: IDENTITY_SERVICE,
  };
  const owner = (await gql('{projectToken{projectId environmentId}}'))?.projectToken;
  if (owner?.projectId !== scope.projectId || owner?.environmentId !== scope.environmentId) {
    refuse('Railway token scope does not match the production Interego identity environment');
  }
  const project = await gql('query($id:String!){project(id:$id){services{edges{node{id name}}}}}', { id: scope.projectId });
  const targets = (project?.project?.services?.edges ?? []).filter(edge => edge?.node?.name === 'identity');
  if (targets.length !== 1 || targets[0].node.id !== IDENTITY_SERVICE) {
    refuse('Railway identity service does not match the production Interego identity service');
  }
  const readVariables = async () => {
    const response = await gql('query($projectId:String!,$environmentId:String!,$serviceId:String!){variables(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)}', scope);
    const variables = response?.variables;
    return {
      clients: variables?.[VARIABLE],
      guestEnabled: variables?.PROVISIONAL_GENERAL_GUEST,
      door: variables?.GENERAL_GUEST_DOOR_ORIGIN,
    };
  };

  const before = await readVariables();
  if (before.guestEnabled !== '1') refuse('the identity service has not enabled its general guest door');
  checkDoorOrigin(before.door);
  if (typeof before.clients !== 'string' || !before.clients.trim()) refuse('cannot read the existing client list');
  const existing = checkPlayClients(before.clients, 'existing client list');
  if (Object.hasOwn(existing, WORLDCRAFT_ORIGIN)) {
    if (isDeepStrictEqual(existing[WORLDCRAFT_ORIGIN], entry)) {
      log('The WorldCraft entry already matches.');
      return { changed: false, applied: false };
    }
    refuse('WorldCraft already has a different entry. Review it before changing it.');
  }
  const updated = JSON.stringify({ ...existing, [WORLDCRAFT_ORIGIN]: entry });
  const checked = checkPlayClients(updated, 'merged client list');
  const { [WORLDCRAFT_ORIGIN]: added, ...otherApps } = checked;
  if (!isDeepStrictEqual(added, entry) || !isDeepStrictEqual(otherApps, existing)) {
    refuse('the merge changed an entry outside its scope');
  }

  log(`${apply ? 'Adding' : 'Would add'} ${WORLDCRAFT_ORIGIN} to ${VARIABLE}. Preserving ${Object.keys(existing).length} existing apps.`);
  if (!apply) return { changed: true, applied: false };

  const current = await readVariables();
  if (!isDeepStrictEqual(current, before)) refuse('the identity configuration changed during this run. Dispatch again.');
  const write = await gql('mutation($input:VariableUpsertInput!){variableUpsert(input:$input)}', {
    input: { ...scope, name: VARIABLE, value: updated, skipDeploys: true },
  });
  if (write?.variableUpsert !== true) refuse('Railway did not confirm writing the registration');
  const after = await readVariables();
  if (after.clients !== updated || after.guestEnabled !== before.guestEnabled || after.door !== before.door) {
    refuse('Railway did not return the expected configuration after the write');
  }
  log('Registration saved and verified. Redeploy only the identity service to activate it.');
  return { changed: true, applied: true };
}

async function main() {
  const token = process.env.RAILWAY_PROJECT_TOKEN;
  if (!token) refuse('the Railway project token is unavailable to this workflow');
  const gql = async (query, variables = {}) => {
    const response = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({ query, variables }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    if (!response.ok || body.errors?.length) refuse('Railway refused a request');
    return body.data;
  };
  await registerWorldCraft({
    gql,
    agentDid: process.env.WORLDCRAFT_AGENT_DID,
    podUrl: process.env.WORLDCRAFT_POD_URL,
    apply: process.env.APPLY === 'true',
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof ProvisionRefusal ? error.message : 'Registration failed. Recheck the workflow and Railway state.');
    process.exitCode = 1;
  });
}
