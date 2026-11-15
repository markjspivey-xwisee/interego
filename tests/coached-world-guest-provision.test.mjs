/**
 * tools/coached-world-guest-provision.mjs, offline: Railway, identity and the relay are stood in
 * for. Every name, key, token and origin here is made up for the test.
 *
 * That the merged PROVISIONAL_PLAY_CLIENTS is one identity's own `parsePlayClients` accepts is
 * applications/coached-world/tests/the-guest-entry-is-one-identity-accepts.test.ts (it needs the TypeScript).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Wallet, verifyMessage } from 'ethers';
import {
  TARGET, WORLD_ORIGIN, IDENTITY_URL, RELAY_URL, DEFAULT_DOOR_ORIGIN, WORLD_SERVICE, IDENTITY_SERVICE, KEY_VAR,
  checkDoorOrigin, checkPlayClients, mergePlayClients, provisionGuest,
} from '../tools/coached-world-guest-provision.mjs';

const KEY = `0x${'5'.repeat(64)}`;
const TOKEN = 'cg2_fixture-service-token-never-logged';
const TERMS = { version: '2031-01-01-r1', statement: 'I agree to the Hosted Interego Terms of Service, version 2031-01-01-r1.' };
const OTHER = 'https://lanternfall.example';
const OTHER_ENTRY = { agentDid: 'did:web:identity.example:agents:lanternfall-service', podUrl: 'https://pods.example/lanternfall/', maxPods: 40, note: 'kept as written' };
const userOf = (address) => `u-eth-${address.slice(2, 14).toLowerCase()}`;
const agentOf = (address) => `did:web:identity.interego.xwisee.com:agents:mcp-client-${userOf(address)}`;
const podOf = (address) => `https://pods.example/${userOf(address)}/`;
const SVC = { [WORLD_SERVICE]: 'svc-world', [IDENTITY_SERVICE]: 'svc-identity' };

/** Railway, identity and the relay in one place, with every call in one ordered list. */
function fleet({ world = {}, identity = {}, terms = true, accounts = [], registered = [], failWrite, registerRefused = false,
  project = TARGET.projectId, services = Object.entries(SVC).map(([name, id]) => ({ id, name })) } = {}) {
  const store = { 'svc-world': { BRIDGE_DEPLOYMENT_URL: WORLD_ORIGIN, ...world }, 'svc-identity': { SIGNING_SEED: 'fixture-identity-secret', ...identity } };
  const state = { accounts: new Set(accounts), registered: new Set(registered), failWrite, registerRefused };
  const events = [];
  const gql = async (query, variables) => {
    if (query.includes('projectToken')) return { projectToken: { projectId: project, environmentId: TARGET.environmentId } };
    if (query.includes('project(id')) return { project: { services: { edges: services.map((node) => ({ node })) } } };
    if (query.includes('variables(')) return { variables: { ...store[variables.s] } };
    if (query.includes('variableUpsert')) {
      const { serviceId, name, value, skipDeploys } = variables.input;
      if (state.failWrite === name) throw Error(`remote said no, echoing ${value}`);
      events.push(`write ${serviceId} ${name}`);
      assert.equal(skipDeploys, true);
      store[serviceId][name] = value;
      return { variableUpsert: true };
    }
    throw Error('unexpected query');
  };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const challenges = new Map();
  let n = 0;
  const fetch = async (url, init) => {
    if (url === `${IDENTITY_URL}/.well-known/hosted-interego-terms`) {
      return reply(200, { terms: terms ? { version: TERMS.version, url: 'https://terms.example/hosted' } : null, privacyUrl: null });
    }
    const body = JSON.parse(init.body);
    if (url === `${IDENTITY_URL}/challenges`) {
      const nonce = `nonce${String(++n).padStart(27, '0')}`;
      const agreed = terms && body.termsVersion === TERMS.version;
      challenges.set(nonce, agreed);
      return reply(200, { nonce, address: body.address, ...(agreed ? { termsStatement: TERMS.statement } : {}) });
    }
    if (url === `${IDENTITY_URL}/auth/siwe`) {
      const address = verifyMessage(body.message, body.signature);
      if (!challenges.has(body.nonce) || !body.message.includes(address)) return reply(401, { error: 'bad sign-in' });
      if (!state.accounts.has(address)) {
        if (body.existingOnly === true) return reply(401, { error: 'Invalid credentials' });
        if (terms && !(challenges.get(body.nonce) && body.message.includes(TERMS.statement))) {
          return reply(428, { error: 'Review the terms', code: 'hosted_terms_required', termsVersion: TERMS.version, termsUrl: 'https://terms.example/hosted' });
        }
        state.accounts.add(address);
        events.push(`account ${body.name}`);
      }
      return reply(200, { token: `${TOKEN}-${address}`, userId: userOf(address), agentDid: agentOf(address), podUrl: podOf(address) });
    }
    const bearer = (init.headers.Authorization ?? '').replace(`Bearer ${TOKEN}-`, '');
    if (url === `${RELAY_URL}/tool/verify_agent`) {
      const known = [...state.registered].some((a) => agentOf(a) === body.agent_id);
      return reply(200, known ? { verified: true, signing: { canSignDelegatedRequests: true } }
        : { verified: false, signing: { canSignDelegatedRequests: false, note: 'No delegation credential was readable on this pod.' } });
    }
    if (url === `${RELAY_URL}/tool/register_agent`) {
      if (!state.accounts.has(bearer)) return reply(401, { error: 'Authentication required for write operations' });
      if (state.registerRefused) return reply(200, { error: 'register_agent: forbidden' });
      state.registered.add(bearer);
      events.push(`agent ${body.label}`);
      return reply(200, { registered: true });
    }
    if (url === `${RELAY_URL}/tool/sign_request`) {
      if (!state.accounts.has(bearer)) return reply(401, { error: 'unauthenticated' });
      return reply(200, { _signature: `0x${'12'.repeat(65)}`, _signed_payload: JSON.stringify({ ...body, agent_id: agentOf(bearer), subject_pod_url: podOf(bearer), timestamp: 't' }) });
    }
    return reply(404, {});
  };
  return { gql, fetch, store, state, events };
}
async function run(f, input = {}) {
  const lines = [];
  const result = await provisionGuest({ gql: f.gql, fetch: f.fetch, log: (l) => lines.push(l), ...input });
  return { result, out: `${lines.join('\n')}\n${JSON.stringify(result)}` };
}
const writes = (f) => f.events.filter((e) => e.startsWith('write '));
const noSecret = (out, f) => {
  const key = f.store['svc-world'][KEY_VAR];
  if (key) { assert.equal(out.includes(key), false, 'the key is in the output'); assert.equal(out.includes(key.slice(2)), false); }
  assert.equal(out.includes(TOKEN), false, 'a token is in the output');
  assert.equal(out.includes('fixture-identity-secret'), false, 'another variable\'s value is in the output');
  assert.equal(out.includes(OTHER_ENTRY.agentDid), false, 'another application\'s entry is in the output');
};
const ADDRESS = new Wallet(KEY).address;

test('a fresh applied run does every step in the stated order, and prints no key, token or other entry', async () => {
  const f = fleet({ identity: { PROVISIONAL_PLAY_CLIENTS: JSON.stringify({ [OTHER]: OTHER_ENTRY }) } });
  const { result, out } = await run(f, { apply: true, acceptTermsVersion: TERMS.version, maxPods: 30 });
  assert.deepEqual(f.events, [
    `write svc-world ${KEY_VAR}`,
    'account Coached world play service',
    'agent Coached world play service',
    'write svc-world CPW_IDENTITY_URL',
    'write svc-world CPW_GENERAL_GUEST',
    'write svc-world CPW_GENERAL_GUEST_DOOR_ORIGIN',
    'write svc-identity PROVISIONAL_PLAY_CLIENTS',
    'write svc-identity GENERAL_GUEST_DOOR_ORIGIN',
    'write svc-identity PROVISIONAL_GENERAL_GUEST',
  ]);
  const world = f.store['svc-world'], key = world[KEY_VAR];
  assert.match(key, /^0x[0-9a-f]{64}$/);
  const address = new Wallet(key).address;
  assert.deepEqual({ ...world, [KEY_VAR]: undefined }, { BRIDGE_DEPLOYMENT_URL: WORLD_ORIGIN, [KEY_VAR]: undefined,
    CPW_IDENTITY_URL: IDENTITY_URL, CPW_GENERAL_GUEST: '1', CPW_GENERAL_GUEST_DOOR_ORIGIN: DEFAULT_DOOR_ORIGIN });
  assert.equal('CPW_PLAY_AUDIENCE' in world || 'CPW_RELAY_URL' in world, false);
  const identity = f.store['svc-identity'];
  assert.deepEqual(JSON.parse(identity.PROVISIONAL_PLAY_CLIENTS), {
    [OTHER]: OTHER_ENTRY,
    [WORLD_ORIGIN]: { agentDid: agentOf(address), podUrl: podOf(address), namespace: 'coached-world', maxPods: 30, generalGuest: true, generalGuestReturnPath: '/play/general/return' },
  });
  assert.equal(identity.PROVISIONAL_GENERAL_GUEST, '1');
  assert.equal(identity.GENERAL_GUEST_DOOR_ORIGIN, DEFAULT_DOOR_ORIGIN);
  assert.equal(identity.SIGNING_SEED, 'fixture-identity-secret');
  // What it says: the address, the DID, the pod, the origins, and what to redeploy.
  for (const said of [address, agentOf(address), podOf(address), OTHER, WORLD_ORIGIN, 'Redeploy, in this order: identity, then coached-world-bridge']) assert.ok(out.includes(said), said);
  assert.deepEqual(result.redeploy, [IDENTITY_SERVICE, WORLD_SERVICE]);
  noSecret(out, f);
  // The Foxxi operator's closing notes are not passed on.
  assert.equal(/FOXXI_|"namespace":"foxxi"/.test(out), false);
});

test('a dry run with no key writes nothing, creates nothing, generates nothing, and says a key would be generated', async () => {
  let drawn = 0;
  const f = fleet();
  const { result, out } = await run(f, { rand: (n) => { drawn += 1; return Buffer.alloc(n, 1); } });
  assert.deepEqual(f.events, []);
  assert.equal(drawn, 0);
  assert.equal(result.applied, false);
  assert.match(out, /WOULD BE GENERATED/);
  assert.match(out, /dry run: nothing written/);
});

test('a dry run with the key already there looks, reports what an applied run would do, and changes nothing', async () => {
  const f = fleet({ world: { [KEY_VAR]: KEY } });
  const first = await run(f);
  assert.deepEqual(f.events, []);
  assert.equal(first.result.ready, false);
  assert.match(first.out, /would create and register/);
  noSecret(first.out, f);
  // With the account and agent in place it can say exactly what it would write.
  const g = fleet({ world: { [KEY_VAR]: KEY }, accounts: [ADDRESS], registered: [ADDRESS] });
  const second = await run(g);
  assert.deepEqual(g.events, []);
  assert.match(second.out, /coached-world-bridge: would set CPW_IDENTITY_URL/);
  assert.match(second.out, /identity: would set PROVISIONAL_PLAY_CLIENTS/);
  assert.equal(g.store['svc-identity'].PROVISIONAL_PLAY_CLIENTS, undefined);
  noSecret(second.out, g);
});

test('a key already on the service is used, never overwritten and never printed', async () => {
  const f = fleet({ world: { [KEY_VAR]: KEY } });
  const { out, result } = await run(f, { apply: true, acceptTermsVersion: TERMS.version, rand: () => { throw Error('no key may be drawn'); } });
  assert.equal(f.store['svc-world'][KEY_VAR], KEY);
  assert.equal(writes(f).some((w) => w.includes(KEY_VAR)), false);
  assert.equal(result.address, ADDRESS);
  assert.ok(result.services[WORLD_SERVICE].kept.includes(KEY_VAR));
  assert.equal(JSON.parse(f.store['svc-identity'].PROVISIONAL_PLAY_CLIENTS)[WORLD_ORIGIN].agentDid, agentOf(ADDRESS));
  noSecret(out, f);
});

test('terms not accepted stop the run before any write, with the version identity asks for', async () => {
  for (const [world, given] of [[{}, undefined], [{}, '1999-wrong'], [{ [KEY_VAR]: KEY }, undefined], [{ [KEY_VAR]: KEY }, '1999-wrong']]) {
    const f = fleet({ world });
    const lines = [];
    await assert.rejects(provisionGuest({ gql: f.gql, fetch: f.fetch, apply: true, acceptTermsVersion: given, log: (l) => lines.push(l) }),
      (e) => /terms/.test(e.message) && (lines.join('\n') + e.message).includes(TERMS.version));
    assert.deepEqual(f.events, []);
  }
  // Where identity states no terms, none are needed.
  const open = fleet({ terms: false });
  await run(open, { apply: true });
  assert.equal(open.events.length, 9);
});

for (const [why, identity] of [
  ['not JSON', '{"https://lanternfall.example":'],
  ['an array', '[]'],
  ['an entry whose pod has no trailing slash', JSON.stringify({ [OTHER]: { ...OTHER_ENTRY, podUrl: 'https://pods.example/lanternfall' } })],
  ['an entry with a bad agent', JSON.stringify({ [OTHER]: { ...OTHER_ENTRY, agentDid: 'did:key:z6Mkfixture' } })],
  ['an entry keyed by a URL with a path', JSON.stringify({ [`${OTHER}/app`]: OTHER_ENTRY })],
  ['a general guest with no return path', JSON.stringify({ [OTHER]: { ...OTHER_ENTRY, generalGuest: true } })],
]) {
  test(`an existing PROVISIONAL_PLAY_CLIENTS that is ${why} is refused before any write, without being echoed`, async () => {
    const f = fleet({ identity: { PROVISIONAL_PLAY_CLIENTS: identity } });
    await assert.rejects(provisionGuest({ gql: f.gql, fetch: f.fetch, apply: true, acceptTermsVersion: TERMS.version }),
      (e) => /identity would not start/.test(e.message) && !e.message.includes('lanternfall'));
    assert.deepEqual(f.events, []);
  });
}

for (const [why, input] of [
  ['a door origin with a path', { doorOrigin: 'https://door.example/guest' }],
  ['a door origin with a trailing slash', { doorOrigin: 'https://door.example/' }],
  ['a door origin over http', { doorOrigin: 'http://door.example' }],
  ['identity\'s own origin as the door', { doorOrigin: IDENTITY_URL }],
  ['a door origin that is not a URL', { doorOrigin: 'door' }],
  ['max_pods of 0', { maxPods: 0 }],
  ['max_pods over 1000', { maxPods: 1001 }],
  ['a fractional max_pods', { maxPods: 2.5 }],
]) {
  test(`${why} is refused before any request`, async () => {
    let asked = 0;
    const f = fleet();
    await assert.rejects(provisionGuest({ gql: (...a) => { asked += 1; return f.gql(...a); }, fetch: f.fetch, apply: true, acceptTermsVersion: TERMS.version, ...input }),
      /door_origin|max_pods/);
    assert.equal(asked, 0);
    assert.deepEqual(f.events, []);
  });
}

for (const [why, opts, pattern] of [
  ['another project', { project: 'not-the-fleet' }, /does not belong/],
  ['a missing identity service', { services: [{ id: 'svc-world', name: WORLD_SERVICE }] }, /expected exactly one service named identity/],
  ['a duplicated service name', { services: [{ id: 'a', name: WORLD_SERVICE }, { id: 'b', name: WORLD_SERVICE }, { id: 'svc-identity', name: IDENTITY_SERVICE }] }, /expected exactly one/],
  ['a CPW_PLAY_AUDIENCE that is not the public URL', { world: { CPW_PLAY_AUDIENCE: 'https://elsewhere.example' } }, /CPW_PLAY_AUDIENCE/],
  ['a CPW_RELAY_URL naming another relay', { world: { CPW_RELAY_URL: 'https://relay.elsewhere.example' } }, /CPW_RELAY_URL/],
  ['a public URL that is not the registered origin', { world: { BRIDGE_DEPLOYMENT_URL: 'https://elsewhere.example' } }, /public URL/],
  ['a stored key of the wrong shape', { world: { [KEY_VAR]: 'not-a-key-fixture' } }, /not 0x \+ 64 hex/],
]) {
  test(`${why} is refused before any write`, async () => {
    const f = fleet(opts);
    await assert.rejects(provisionGuest({ gql: f.gql, fetch: f.fetch, apply: true, acceptTermsVersion: TERMS.version }),
      (e) => pattern.test(e.message) && !e.message.includes('not-a-key-fixture'));
    assert.deepEqual(f.events, []);
  });
}

test('a run that fails part-way is completed by the next, with the same key and nothing done twice', async () => {
  for (const failing of ['CPW_GENERAL_GUEST', 'PROVISIONAL_PLAY_CLIENTS', 'PROVISIONAL_GENERAL_GUEST']) {
    const f = fleet({ identity: { PROVISIONAL_PLAY_CLIENTS: JSON.stringify({ [OTHER]: OTHER_ENTRY }) }, failWrite: failing });
    const error = await provisionGuest({ gql: f.gql, fetch: f.fetch, apply: true, acceptTermsVersion: TERMS.version }).then(() => null, (e) => e);
    assert.ok(error, failing);
    const key = f.store['svc-world'][KEY_VAR];
    assert.match(key, /^0x[0-9a-f]{64}$/);
    // Identity's switch is never on before its client list holds the entry.
    if (failing !== 'PROVISIONAL_GENERAL_GUEST') assert.equal(f.store['svc-identity'].PROVISIONAL_GENERAL_GUEST, undefined);
    const before = f.events.length;
    f.state.failWrite = undefined;
    // The second run is given no terms version: the account exists, so none is needed.
    const { out } = await run(f, { apply: true });
    assert.equal(f.store['svc-world'][KEY_VAR], key);
    const second = f.events.slice(before);
    assert.equal(second.some((e) => e.startsWith('account') || e.startsWith('agent') || e.includes(KEY_VAR)), false);
    assert.equal(new Set(f.events).size, f.events.length, 'a step ran twice');
    assert.equal(f.events.length, 9);
    assert.equal(f.store['svc-identity'].PROVISIONAL_GENERAL_GUEST, '1');
    assert.deepEqual(JSON.parse(f.store['svc-identity'].PROVISIONAL_PLAY_CLIENTS)[OTHER], OTHER_ENTRY);
    noSecret(out, f);
  }
  // A relay that refuses the registration: the key and the account stay, no setting is changed.
  const f = fleet({ registerRefused: true });
  await assert.rejects(provisionGuest({ gql: f.gql, fetch: f.fetch, apply: true, acceptTermsVersion: TERMS.version }), /not ready/);
  assert.deepEqual(f.events, [`write svc-world ${KEY_VAR}`, 'account Coached world play service']);
  f.state.registerRefused = false;
  await run(f, { apply: true });
  assert.deepEqual(f.events.slice(2, 4), ['agent Coached world play service', 'write svc-world CPW_IDENTITY_URL']);
  assert.equal(f.events.length, 9);
});

test('a second applied run writes nothing and says so', async () => {
  const f = fleet();
  await run(f, { apply: true, acceptTermsVersion: TERMS.version });
  const before = f.events.length, value = f.store['svc-identity'].PROVISIONAL_PLAY_CLIENTS;
  const { result, out } = await run(f, { apply: true });
  assert.equal(f.events.length, before);
  assert.equal(f.store['svc-identity'].PROVISIONAL_PLAY_CLIENTS, value);
  // It still names both services: it cannot know whether what the first run wrote was deployed.
  assert.deepEqual(result.redeploy, [IDENTITY_SERVICE, WORLD_SERVICE]);
  assert.match(out, /Nothing needed writing in this run\. Redeploy, in this order: identity, then coached-world-bridge/);
});

test('the merge keeps every other entry as it was, and updates an entry for this origin only in its own fields', () => {
  const service = { agentDid: 'did:web:identity.example:agents:world-service', podUrl: 'https://pods.example/world/', maxPods: 25 };
  const before = { [OTHER]: OTHER_ENTRY, [WORLD_ORIGIN]: { agentDid: 'did:web:identity.example:agents:old', podUrl: 'https://pods.example/old/', maxPods: 3, kept: 'yes' }, 'https://third.example': { agentDid: 'did:web:identity.example:agents:third', podUrl: 'https://pods.example/third/', generalGuest: false } };
  const merged = mergePlayClients(JSON.stringify(before), service);
  const after = JSON.parse(merged.value);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(after[OTHER], OTHER_ENTRY);
  assert.deepEqual(after['https://third.example'], before['https://third.example']);
  assert.deepEqual(after[WORLD_ORIGIN], { ...service, kept: 'yes', namespace: 'coached-world', generalGuest: true, generalGuestReturnPath: '/play/general/return' });
  assert.deepEqual(merged.origins, Object.keys(before));
  assert.equal(mergePlayClients(merged.value, service).unchanged, true);
  assert.deepEqual(JSON.parse(mergePlayClients(undefined, service).value), { [WORLD_ORIGIN]: { ...service, namespace: 'coached-world', generalGuest: true, generalGuestReturnPath: '/play/general/return' } });
  // What the relay signs as is checked too: a value identity would not start with is never produced.
  assert.throws(() => mergePlayClients(undefined, { ...service, podUrl: 'https://pods.example/world' }), /identity would not start/);
  assert.throws(() => mergePlayClients(undefined, { ...service, agentDid: 'did:ethr:0xfixture' }), /identity would not start/);
  assert.deepEqual(checkPlayClients(''), {});
  assert.equal(checkDoorOrigin('https://door.example'), 'https://door.example');
});

test('the workflow is dispatch-only from master, hands the tool no other secret, and has no comment inside a list', () => {
  const workflow = readFileSync(new URL('../.github/workflows/coached-world-guest-provision.yml', import.meta.url), 'utf8');
  assert.match(workflow, /if: github\.repository == 'markjspivey-xwisee\/interego' && github\.ref == 'refs\/heads\/master'/);
  assert.equal(/pull_request|push:|schedule:/.test(workflow), false);
  assert.deepEqual(workflow.match(/secrets\.[A-Z_]+/g), ['secrets.RAILWAY_PROJECT_TOKEN']);
  assert.match(workflow, /default: false/);
  const lines = workflow.split('\n');
  lines.forEach((line, i) => { if (/^\s*#/.test(line)) assert.equal(/^\s*- /.test(lines[i - 1] ?? '') || /^\s*- /.test(lines[i + 1] ?? ''), false, `comment inside a list at line ${i + 1}`); });
});
