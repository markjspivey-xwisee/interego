import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TARGET } from '../tools/coached-world-guest-provision.mjs';
import { registerWorldCraft } from '../tools/worldcraft-guest-registration.mjs';

const app = 'https://worldcraft-meetup.markjspivey.workers.dev';
const agentDid = 'did:web:identity.example:agents:worldcraft';
const podUrl = 'https://gate.example/worldcraft/';
const identity = '9f813936-9df0-4ec9-894c-63c4b09c7eb7';
const variable = 'PROVISIONAL_PLAY_CLIENTS';
const before = {
  'https://other.example': {
    agentDid: 'did:web:identity.example:agents:other', podUrl: 'https://gate.example/other/',
    generalGuest: true, generalGuestReturnPath: '/guest/preserve-this', maxPods: 39,
  },
};
const worldcraft = {
  agentDid, podUrl, namespace: 'worldcraft-meetup', maxPods: 25,
  generalGuest: true, generalGuestReturnPath: '/guest/return',
};

function railway(initial, { scope = TARGET, concurrentChange = false } = {}) {
  const writes = [];
  const variables = {
    [variable]: JSON.stringify(initial),
    PROVISIONAL_GENERAL_GUEST: '1',
    GENERAL_GUEST_DOOR_ORIGIN: 'https://door.example',
  };
  let reads = 0;
  const gql = async (query, input) => {
    if (query.startsWith('{projectToken')) return { projectToken: scope };
    if (query.includes('project(id:')) return { project: { services: { edges: [{ node: { id: identity, name: 'identity' } }] } } };
    if (query.includes('variables(projectId:')) {
      if (concurrentChange && ++reads === 2) variables[variable] = JSON.stringify({ ...before, [app]: worldcraft });
      return { variables };
    }
    if (query.startsWith('mutation')) {
      writes.push(input.input);
      variables[variable] = input.input.value;
      return { variableUpsert: true };
    }
    throw new Error('Unexpected request');
  };
  const register = (apply) => registerWorldCraft({ gql, agentDid, podUrl, apply, log() {} });
  return { register, writes };
}

test('previews without writes, then adds only the meetup and leaves redeploy pending', async () => {
  const { register, writes } = railway(before);
  assert.deepEqual(await register(false), { changed: true, applied: false });
  assert.deepEqual(writes, []);
  assert.deepEqual(await register(true), { changed: true, applied: true });
  assert.deepEqual(writes, [{
    ...TARGET, serviceId: identity, name: variable,
    value: JSON.stringify({ ...before, [app]: worldcraft }), skipDeploys: true,
  }]);
  assert.deepEqual(await register(true), { changed: false, applied: false });
  assert.equal(writes.length, 1);
});

test('refuses different existing entries, concurrent edits, or a different token scope', async () => {
  const fixtures = [
    [railway({ ...before, [app]: { ...worldcraft, maxPods: 30 } }), /already has a different entry/],
    [railway(before, { concurrentChange: true }), /changed during this run/],
    [railway(before, { scope: { ...TARGET, environmentId: 'wrong' } }), /token scope does not match/],
  ];
  for (const [{ register, writes }, reason] of fixtures) {
    await assert.rejects(register(true), reason);
    assert.deepEqual(writes, []);
  }
});
