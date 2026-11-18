/**
 * tools/general-guest-opt-in.mjs, offline: Railway is stood in for. Every name, key and origin
 * that is not the tool's own constant is made up for the test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { TARGET, IDENTITY_SERVICE, APPLICATIONS, ProvisionRefusal, optIn, optInPlayClients } from '../tools/general-guest-opt-in.mjs';
import { checkPlayClients } from '../tools/coached-world-guest-provision.mjs';

const APP = APPLICATIONS['foxxi-workbench'];
const DOOR = 'https://door.example';
const OTHER = 'https://lanternfall.example';
const OTHER_ENTRY = { agentDid: 'did:web:identity.example:agents:lanternfall-service', podUrl: 'https://pods.example/lanternfall/', maxPods: 40, note: 'kept as written' };
const MINE = { agentDid: 'did:web:identity.example:agents:workbench-service', podUrl: 'https://pods.example/workbench/', namespace: 'workbench', maxPods: 12 };
const LIST = JSON.stringify({ [OTHER]: OTHER_ENTRY, [APP.origin]: MINE });
const SECRET = 'fixture-key-never-logged';

function fleet({ identity = {}, mine = {}, project = TARGET.projectId, failWrite } = {}) {
  const store = {
    'svc-identity': { PROVISIONAL_GENERAL_GUEST: '1', GENERAL_GUEST_DOOR_ORIGIN: DOOR, PROVISIONAL_PLAY_CLIENTS: LIST, ...identity },
    'svc-app': { [APP.needs]: SECRET, ...mine },
  };
  for (const s of Object.values(store)) for (const [k, v] of Object.entries(s)) if (v === undefined) delete s[k];
  const writes = [];
  const gql = async (query, variables) => {
    if (query.includes('projectToken')) return { projectToken: { projectId: project, environmentId: TARGET.environmentId } };
    if (query.includes('project(id')) return { project: { services: { edges: [{ node: { id: 'svc-identity', name: IDENTITY_SERVICE } }, { node: { id: 'svc-app', name: APP.service } }] } } };
    if (query.includes('variables(')) return { variables: { ...store[variables.s] } };
    if (query.includes('variableUpsert')) {
      const { serviceId, name, value, skipDeploys } = variables.input;
      assert.equal(skipDeploys, true);
      if (failWrite === name) throw Error(`remote said no, echoing ${value}`);
      writes.push(`${serviceId} ${name}`);
      store[serviceId][name] = value;
      return { variableUpsert: true };
    }
    throw Error('unexpected query');
  };
  const lines = [];
  return { gql, store, writes, lines, log: (l) => lines.push(l) };
}
const refused = (pattern) => (e) => e instanceof ProvisionRefusal && pattern.test(e.message);

test('a dry run writes nothing and says what it would write', async () => {
  const f = fleet();
  const out = await optIn({ gql: f.gql, application: 'foxxi-workbench', log: f.log });
  assert.deepEqual(f.writes, []);
  assert.equal(out.applied, false);
  assert.ok(f.lines.some((l) => l.includes('would set PROVISIONAL_PLAY_CLIENTS')));
  assert.ok(f.lines.some((l) => l.includes(`would set ${APP.switchVar}`)));
});

test('an applied run opts the entry in, identity first, the switch last, and changes nothing else', async () => {
  const f = fleet();
  const out = await optIn({ gql: f.gql, application: 'foxxi-workbench', apply: true, log: f.log });
  assert.deepEqual(f.writes, ['svc-identity PROVISIONAL_PLAY_CLIENTS', `svc-app ${APP.doorVar}`, `svc-app ${APP.switchVar}`]);
  const list = checkPlayClients(f.store['svc-identity'].PROVISIONAL_PLAY_CLIENTS);
  assert.deepEqual(Object.keys(list), [OTHER, APP.origin]);
  assert.deepEqual(list[OTHER], OTHER_ENTRY);
  assert.deepEqual(list[APP.origin], { ...MINE, generalGuest: true, generalGuestReturnPath: APP.returnPath });
  assert.equal(f.store['svc-app'][APP.doorVar], DOOR);
  assert.equal(f.store['svc-app'][APP.switchVar], '1');
  assert.deepEqual(out.redeploy, [IDENTITY_SERVICE, APP.service]);
});

test('a second applied run writes nothing', async () => {
  const f = fleet();
  await optIn({ gql: f.gql, application: 'foxxi-workbench', apply: true, log: f.log });
  f.writes.length = 0;
  await optIn({ gql: f.gql, application: 'foxxi-workbench', apply: true, log: f.log });
  assert.deepEqual(f.writes, []);
});

test('nothing printed holds a value or another application\'s entry', async () => {
  const f = fleet();
  await optIn({ gql: f.gql, application: 'foxxi-workbench', apply: true, log: f.log });
  const all = f.lines.join('\n');
  for (const secret of [SECRET, OTHER, OTHER_ENTRY.agentDid, MINE.agentDid, MINE.podUrl, DOOR]) assert.ok(!all.includes(secret), secret);
});

test('refused before any write', async (t) => {
  const cases = [
    ['an application it does not know', { application: 'lanternfall' }, {}, /must be one of/],
    ['a token for another project', {}, { project: 'another-project' }, /does not belong/],
    ['the general guest off at identity', {}, { identity: { PROVISIONAL_GENERAL_GUEST: undefined } }, /general guest on/],
    ['no door stated at identity', {}, { identity: { GENERAL_GUEST_DOOR_ORIGIN: undefined } }, /door_origin/],
    ['a door that is the application itself', {}, { identity: { GENERAL_GUEST_DOOR_ORIGIN: APP.origin } }, /own origin/],
    ['no entry for the application', {}, { identity: { PROVISIONAL_PLAY_CLIENTS: JSON.stringify({ [OTHER]: OTHER_ENTRY }) } }, /admits no guests/],
    ['a list identity would not start with', {}, { identity: { PROVISIONAL_PLAY_CLIENTS: '{not json' } }, /not JSON/],
    ['no guest key on the application', {}, { mine: { [APP.needs]: undefined } }, /creates no key/],
  ];
  for (const [name, args, shape, pattern] of cases) {
    await t.test(name, async () => {
      const f = fleet(shape);
      await assert.rejects(optIn({ gql: f.gql, application: 'foxxi-workbench', apply: true, log: f.log, ...args }), refused(pattern));
      assert.deepEqual(f.writes, []);
    });
  }
});

test('a failed write does not echo what Railway said', async () => {
  const f = fleet({ failWrite: APP.switchVar });
  await assert.rejects(optIn({ gql: f.gql, application: 'foxxi-workbench', apply: true, log: f.log }), (e) => !(e instanceof ProvisionRefusal));
  assert.deepEqual(f.writes, ['svc-identity PROVISIONAL_PLAY_CLIENTS', `svc-app ${APP.doorVar}`]);
});

test('the merge keeps an entry\'s own fields and its place', () => {
  const { value, unchanged } = optInPlayClients(LIST, APP.origin, APP.returnPath);
  assert.equal(unchanged, false);
  assert.equal(optInPlayClients(value, APP.origin, APP.returnPath).unchanged, true);
  assert.throws(() => optInPlayClients(LIST, APP.origin, '//elsewhere'), refused(/return path/));
});

// ── An application served from another Railway project (Hallowmarch): identity's half only ────────

const HM_ENTRY = { agentDid: 'did:web:identity.example:agents:march-service', podUrl: 'https://pods.example/march/' };
const hmList = (origin) => JSON.stringify({ [OTHER]: OTHER_ENTRY, [origin]: HM_ENTRY, [APP.origin]: MINE });

/** A fleet that fails the test if the application's own service is ever looked at. */
function fleetElsewhere(name, shape = {}) {
  const f = fleet({ ...shape, identity: { PROVISIONAL_PLAY_CLIENTS: hmList(APPLICATIONS[name].origin), ...(shape.identity ?? {}) } });
  const inner = f.gql;
  f.touched = [];
  f.gql = async (query, variables) => {
    const service = variables?.s ?? variables?.input?.serviceId;
    if (service !== undefined && service !== 'svc-identity') { f.touched.push(service); throw Error('a service other than identity was touched'); }
    return inner(query, variables);
  };
  return f;
}

for (const name of ['hallowmarch-preview', 'hallowmarch']) {
  const HM = APPLICATIONS[name];

  test(`${name}: the entry is one the tool knows, with nothing of a fleet service in it`, () => {
    assert.equal(HM.returnPath, '/guest/general/return');
    assert.equal(new URL(HM.origin).origin, HM.origin);
    for (const k of ['service', 'needs', 'doorVar', 'switchVar']) assert.equal(HM[k], undefined, k);
    assert.equal(HM.elsewhere.doorVar, 'HM_GENERAL_GUEST_DOOR_ORIGIN');
    assert.equal(HM.elsewhere.switchVar, 'HM_GENERAL_GUEST');
  });

  test(`${name}: a dry run writes nothing, touches only identity, and says what is set elsewhere`, async () => {
    const f = fleetElsewhere(name);
    const out = await optIn({ gql: f.gql, application: name, log: f.log });
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.touched, []);
    assert.equal(out.applied, false);
    assert.deepEqual(out.redeploy, []);
    assert.deepEqual(Object.keys(out.services), [IDENTITY_SERVICE]);
    assert.deepEqual(out.operator.set, [['HM_GENERAL_GUEST_DOOR_ORIGIN', DOOR], ['HM_GENERAL_GUEST', '1']]);
    assert.ok(f.lines.some((l) => l.includes('would set PROVISIONAL_PLAY_CLIENTS')));
    assert.ok(f.lines.some((l) => l.includes(`HM_GENERAL_GUEST_DOOR_ORIGIN=${DOOR}`)));
    assert.ok(f.lines.some((l) => l.includes('HM_GENERAL_GUEST=1')));
    assert.ok(f.lines.some((l) => l.includes('not served from this Railway project')));
  });

  test(`${name}: an applied run writes identity's entry and nothing else anywhere`, async () => {
    const f = fleetElsewhere(name);
    const out = await optIn({ gql: f.gql, application: name, apply: true, log: f.log });
    assert.deepEqual(f.writes, ['svc-identity PROVISIONAL_PLAY_CLIENTS']);
    assert.deepEqual(f.touched, []);
    const list = checkPlayClients(f.store['svc-identity'].PROVISIONAL_PLAY_CLIENTS);
    assert.deepEqual(Object.keys(list), [OTHER, HM.origin, APP.origin]);
    assert.deepEqual(list[OTHER], OTHER_ENTRY);
    assert.deepEqual(list[APP.origin], MINE);
    assert.deepEqual(list[HM.origin], { ...HM_ENTRY, generalGuest: true, generalGuestReturnPath: '/guest/general/return' });
    assert.deepEqual(f.store['svc-app'], { [APP.needs]: SECRET });
    assert.deepEqual(out.redeploy, [IDENTITY_SERVICE]);
    f.writes.length = 0;
    await optIn({ gql: f.gql, application: name, apply: true, log: f.log });
    assert.deepEqual(f.writes, []);
  });

  test(`${name}: the door is the only value printed`, async () => {
    const f = fleetElsewhere(name);
    await optIn({ gql: f.gql, application: name, apply: true, log: f.log });
    const all = f.lines.join('\n');
    for (const secret of [SECRET, OTHER, OTHER_ENTRY.agentDid, HM_ENTRY.agentDid, HM_ENTRY.podUrl, MINE.agentDid, APP.origin]) assert.ok(!all.includes(secret), secret);
    assert.ok(all.includes(DOOR));
  });

  test(`${name}: refused before any write`, async (t) => {
    const cases = [
      ['a token for another project', { project: 'another-project' }, /does not belong/],
      ['the general guest off at identity', { identity: { PROVISIONAL_GENERAL_GUEST: undefined } }, /general guest on/],
      ['no door stated at identity', { identity: { GENERAL_GUEST_DOOR_ORIGIN: undefined } }, /door_origin/],
      ['a door that is the application itself', { identity: { GENERAL_GUEST_DOOR_ORIGIN: HM.origin } }, /own origin/],
      ['no entry for the application', { identity: { PROVISIONAL_PLAY_CLIENTS: LIST } }, /admits no guests/],
      ['a list identity would not start with', { identity: { PROVISIONAL_PLAY_CLIENTS: '{not json' } }, /not JSON/],
    ];
    for (const [what, shape, pattern] of cases) {
      await t.test(what, async () => {
        const f = fleetElsewhere(name, shape);
        await assert.rejects(optIn({ gql: f.gql, application: name, apply: true, log: f.log }), refused(pattern));
        assert.deepEqual(f.writes, []);
        assert.deepEqual(f.touched, []);
      });
    }
  });
}

test('an application elsewhere needs no service of its name in the fleet, and one that happens to be there is left alone', async () => {
  const f = fleetElsewhere('hallowmarch');
  const inner = f.gql;
  // A fleet with a stray service called `march`: never resolved, read or written.
  f.gql = async (query, variables) => (query.includes('project(id')
    ? { project: { services: { edges: [{ node: { id: 'svc-identity', name: IDENTITY_SERVICE } }, { node: { id: 'svc-stray', name: 'march' } }] } } }
    : inner(query, variables));
  await optIn({ gql: f.gql, application: 'hallowmarch', apply: true, log: f.log });
  assert.deepEqual(f.writes, ['svc-identity PROVISIONAL_PLAY_CLIENTS']);
  assert.deepEqual(f.touched, []);
});

test('the workflow offers exactly the applications the tool knows', async () => {
  const { readFile } = await import('node:fs/promises');
  const yml = await readFile(new URL('../.github/workflows/general-guest-opt-in.yml', import.meta.url), 'utf8');
  const options = yml.slice(yml.indexOf('options:'), yml.indexOf('apply:')).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  assert.deepEqual(options, Object.keys(APPLICATIONS));
});
