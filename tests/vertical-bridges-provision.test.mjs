import assert from 'node:assert/strict';
import test from 'node:test';
import { TARGET, BRIDGES, newKey, planService, provisionBridges } from '../tools/vertical-bridges-provision.mjs';

const ids = { 'wrd-bridge': 'svc-wrd', 'pev-bridge': 'svc-pev' };
function backend({ project = TARGET.projectId, environment = TARGET.environmentId, services = Object.entries(ids).map(([name, id]) => ({ id, name })), vars = {}, upsert = true, remoteError = null } = {}) {
  const calls = [];
  const store = Object.fromEntries(Object.values(ids).map((id) => [id, { ...(vars[id] ?? {}) }]));
  const gql = async (query, variables) => {
    calls.push({ query, variables });
    if (remoteError) throw Error(remoteError);
    if (query.includes('projectToken')) return { projectToken: { projectId: project, environmentId: environment } };
    if (query.includes('project(id')) return { project: { services: { edges: services.map((node) => ({ node })) } } };
    if (query.includes('variables(')) return { variables: { ...store[variables.s] } };
    if (query.includes('variableUpsert')) { if (upsert) store[variables.input.serviceId][variables.input.name] = variables.input.value; return { variableUpsert: upsert }; }
    throw Error('unexpected query');
  };
  return { calls, gql, store };
}
const writes = (calls) => calls.filter((c) => c.query.includes('variableUpsert')).map((c) => c.variables.input);

test('fresh services get four distinct valid keys, written with skipDeploys, and no value is logged or returned', async () => {
  const b = backend(); const lines = [];
  const result = await provisionBridges({ gql: b.gql, apply: true, log: (l) => lines.push(l) });
  const w = writes(b.calls);
  assert.deepEqual(w.map((x) => x.name).sort(), ['PEV_PLATFORM_KEY', 'PEV_RECORD_KEY', 'WRD_PLATFORM_KEY', 'WRD_RECORD_KEY']);
  assert.ok(w.every((x) => /^[0-9a-f]{64}$/.test(x.value) && x.skipDeploys === true));
  assert.equal(new Set(w.map((x) => x.value)).size, 4);
  const text = JSON.stringify(result) + lines.join('\n');
  for (const x of w) assert.equal(text.includes(x.value), false);
});

test('a key that already exists is never overwritten', async () => {
  const b = backend({ vars: { 'svc-wrd': { WRD_RECORD_KEY: 'existing' }, 'svc-pev': { PEV_PLATFORM_KEY: 'existing', PEV_RECORD_KEY: 'existing' } } });
  await provisionBridges({ gql: b.gql, apply: true });
  assert.deepEqual(writes(b.calls).map((x) => x.name), ['WRD_PLATFORM_KEY']);
  assert.equal(b.store['svc-wrd'].WRD_RECORD_KEY, 'existing');
});

test('a dry run writes nothing', async () => {
  const b = backend();
  const r = await provisionBridges({ gql: b.gql, apply: false });
  assert.equal(r.applied, false);
  assert.equal(writes(b.calls).length, 0);
});

for (const [why, opts] of [
  ['another project', { project: 'not-the-fleet' }],
  ['another environment', { environment: 'not-production' }],
  ['a missing service', { services: [{ id: 'svc-wrd', name: 'wrd-bridge' }] }],
  ['a duplicated service name', { services: [{ id: 'a', name: 'wrd-bridge' }, { id: 'b', name: 'wrd-bridge' }, { id: 'svc-pev', name: 'pev-bridge' }] }],
]) {
  test(`${why} is refused before any write`, async () => {
    const b = backend(opts);
    await assert.rejects(provisionBridges({ gql: b.gql, apply: true }), /refused|expected exactly one|does not belong/);
    assert.equal(writes(b.calls).length, 0);
  });
}

test('the model key is copied only when given, and never shown', async () => {
  const b = backend(); const lines = [];
  await provisionBridges({ gql: b.gql, apply: true, pevApiKey: 'sk-fixture-never-log', log: (l) => lines.push(l) });
  assert.ok(writes(b.calls).some((x) => x.name === 'PEV_LLM_API_KEY' && x.serviceId === 'svc-pev'));
  assert.equal(lines.join('\n').includes('sk-fixture-never-log'), false);
  const c = backend();
  await provisionBridges({ gql: c.gql, apply: true });
  assert.equal(writes(c.calls).some((x) => x.name === 'PEV_LLM_API_KEY'), false);
});

test('a write Railway does not confirm, or does not list afterwards, is a refusal', async () => {
  const b = backend({ upsert: false });
  await assert.rejects(provisionBridges({ gql: b.gql, apply: true }), /did not confirm/);
});

test('newKey redraws a value that is not a valid secp256k1 key', () => {
  let n = 0;
  const rand = () => Buffer.from((n++ === 0 ? 'ff' : '01').repeat(32), 'hex');
  assert.equal(newKey(rand), '01'.repeat(32));
  assert.deepEqual(Object.keys(BRIDGES), ['wrd-bridge', 'pev-bridge']);
  assert.deepEqual(planService('WRD', new Set(['WRD_PLATFORM_KEY', 'WRD_RECORD_KEY'])).writes, []);
});
