import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET, credentialsFromConfig, continuationUrl, inventory, main, readScopedConfig } from './lrs-safe-inventory.mjs';

const HORIZON = '2026-10-15T05:10:00.000Z';
const NS = `${TARGET.origin}/ns/foxxi#`;
const SECRET = 'PRIVATE-test-fixture-password';
const PII = 'PRIVATE-learner-name-and-email@example.invalid';
const config = {
  BRIDGE_DEPLOYMENT_URL: TARGET.origin, FOXXI_LRS_BACKEND: 'memory',
  FOXXI_LRS_BASIC_AUTH_PAIRS: `test:${SECRET}`,
  FOXXI_LRS_MEMORY_TENANTS: `agent-mesh,${PII}`, FOXXI_LRS_MEMORY_TENANT_PREFIXES: 'lens:',
};
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const statement = (n = 1, extra = {}) => ({
  id: uuid(n), stored: '2026-10-14T04:00:00.000Z',
  actor: { name: PII, mbox: `mailto:${PII}` },
  verb: { id: 'http://adlnet.gov/expapi/verbs/completed', display: { en: PII } },
  object: { id: `https://private.invalid/${PII}`, definition: { name: { en: PII }, type: 'http://adlnet.gov/expapi/activities/course' } },
  context: { extensions: { secret: SECRET }, instructor: { name: PII } },
  result: { response: SECRET }, authority: { objectType: 'Agent', name: PII }, ...extra,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const about = () => json({ extensions: { [`${NS}lrsBackend`]: 'in-memory (single-replica; lost on restart; 779/1277952 statements resident process-wide)', [`${NS}pod`]: PII } });
const cursor = (offset = 500, q = { until: HORIZON, ascending: true, limit: 500 }, extra = {}) =>
  `/xapi/statements?continuationToken=${Buffer.from(JSON.stringify({ offset, ts: Date.parse('2026-10-14T04:00:00.000Z'), q, ...extra })).toString('base64url')}`;
const options = fetchImpl => ({ fetchImpl, now: new Date(HORIZON) });
function scripted(responses) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    calls.push({ url, init });
    assert.ok(responses.length, 'fixture transport exhausted');
    const next = responses.shift();
    return typeof next === 'function' ? next(url, init) : next;
  } };
}
function railwayResponses(vars = config) {
  return [json({ data: { projectToken: { projectId: TARGET.project, environmentId: TARGET.environment } } }),
    json({ data: { project: { services: { edges: [{ node: { id: TARGET.service, name: TARGET.serviceName } }] } } } }),
    json({ data: { variables: { ...vars, FOXXI_ADMIN_KEY_SEED: SECRET, UNRELATED_PRIVATE_KEY: SECRET } } })];
}
function assertRedacted(value) {
  const text = JSON.stringify(value);
  for (const secret of [PII, SECRET, 'private.invalid', uuid(1), 'continuationToken', 'UNRELATED_PRIVATE_KEY']) {
    assert.equal(text.includes(secret), false, `output contains forbidden fixture marker: ${secret}`);
  }
}

test('count-only aggregate drops learner data, arbitrary verbs/types and backend paths', async () => {
  const t = scripted([about(), json({ statements: [statement(), statement(2, {
    verb: { id: `https://private.invalid/${SECRET}` }, object: { objectType: PII },
    authority: { objectType: PII },
  })], more: '' })]);
  const report = await inventory({ ...config, FOXXI_LRS_BACKEND: `file:/private/${SECRET}` }, options(t.fetch));
  assertRedacted(report);
  assert.equal(report.observedProcessResidentStatements, 779);
  assert.equal(report.configuration.backendKind, 'file');
  assert.equal(report.aggregateAcrossQueriedScopes.count, 2);
  assert.deepEqual(report.aggregateAcrossQueriedScopes.verbs, { 'adl:completed': 1, other_unrecognized: 1 });
  assert.equal(report.aggregateAcrossQueriedScopes.familiesInferred.course_or_lesson_inferred, 1);
  assert.equal(report.scopes[0].reachedLastPage, true);
  assert.equal(report.backupCreated, false);
  assert.equal(t.calls[0].init.headers.Authorization, undefined);
  assert.equal(t.calls[1].init.headers.Authorization, `Basic ${Buffer.from(`test:${SECRET}`).toString('base64')}`);
  assert.ok(t.calls.every(c => c.init.method === 'GET' && c.init.redirect === 'manual'));
});

test('fixed-horizon continuation is validated and repeated UUIDs are counted once', async () => {
  const t = scripted([about(), json({ statements: [statement()], more: cursor(1) }),
    json({ statements: [statement(), statement(2), statement(3, { stored: '2026-10-16T04:00:00.000Z' })], more: '' })]);
  const report = await inventory(config, options(t.fetch));
  assert.equal(report.aggregateAcrossQueriedScopes.count, 2);
  assert.equal(report.duplicateRowsSkipped, 1);
  assert.equal(report.excludedAfterHorizon, 1);
  assert.equal(report.pagesRead, 2);
  assert.equal(new URL(t.calls[1].url).searchParams.get('until'), HORIZON);
  assert.equal(new URL(t.calls[2].url).pathname, '/xapi/statements');
  assertRedacted(report);
});

test('existing credentials map to their real scopes, duplicate scope credentials do not double-read', async () => {
  const raw = `first:one:https://tenant.invalid/u-PII/,second:two:https://tenant.invalid/u-PII,third:three:lens:PRIVATE`;
  const parsed = credentialsFromConfig(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].tenant, 'https://tenant.invalid/u-pii');
  // UUIDs are tenant-scoped: this is different content with the SAME UUID in another scope.
  const t = scripted([about(), json({ statements: [statement()], more: '' }), json({ statements: [statement(1, {
    verb: { id: `${TARGET.origin}/llm-telemetry/verbs/tool-started` },
  })], more: '' })]);
  const report = await inventory({ ...config, FOXXI_LRS_BASIC_AUTH_PAIRS: raw }, options(t.fetch));
  assert.equal(report.basicMappedTenantScopesAvailable, 2);
  assert.equal(report.aggregateAcrossQueriedScopes.count, 2);
  assert.equal(report.distinctStatementIdsAcrossQueriedScopes, 1);
  assert.equal(report.crossScopeRepeatedIds, 1);
  assert.equal(report.aggregateAcrossQueriedScopes.verbs['adl:completed'], 1);
  assert.equal(report.aggregateAcrossQueriedScopes.verbs['llm:tool-started'], 1);
  assert.equal(report.scopes[1].configuredDerivedMemoryScope, true);
  assert.equal(JSON.stringify(report).includes('tenant.invalid'), false);
  assert.equal(t.calls[1].url.includes('tenant'), false);
  assert.equal(t.calls[2].url.includes('tenant'), false);
});

test('credential replay matches existing registry secret rotation and truncated ID collisions', () => {
  const rotated = credentialsFromConfig('same:old:scope,same:new:scope');
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].authorization, `Basic ${Buffer.from('same:new').toString('base64')}`);
  const principal = 'long-principal-same-prefix';
  const collision = credentialsFromConfig(`${principal}:old:scope-one,${principal}:new:scope-two`);
  assert.equal(collision.length, 1);
  assert.equal(collision[0].tenant, 'scope-two');
  assert.equal(collision[0].authorization, `Basic ${Buffer.from(`${principal}:new`).toString('base64')}`);
});

test('canonical cmi5, Foxxi, mesh projection and LLM telemetry IRIs receive fixed labels', async () => {
  const t = scripted([about(), json({ statements: [
    statement(1, { verb: { id: 'https://w3id.org/xapi/adl/verbs/satisfied' } }),
    statement(2, { verb: { id: `${NS}performed` }, context: { extensions: { [`${NS}substrateDescriptorIri`]: PII } } }),
    statement(3, { verb: { id: `${TARGET.origin}/llm-telemetry/verbs/tool-completed` } }),
    statement(4, { verb: { id: `${TARGET.origin}/llm-telemetry/verbs/model-failed` } }),
    statement(5, { verb: { id: `https://private.invalid/llm-telemetry/verbs/model-failed` } }),
    statement(6, { verb: { id: `${NS}verbs/authored` } }),
  ], more: '' })]);
  const report = await inventory(config, options(t.fetch));
  assert.deepEqual(report.aggregateAcrossQueriedScopes.verbs, {
    'cmi5:satisfied': 1, 'foxxi:performed': 1, 'llm:tool-completed': 1, 'llm:model-failed': 1,
    other_unrecognized: 1, 'foxxi:authored': 1,
  });
  assert.equal(report.aggregateAcrossQueriedScopes.familiesInferred.pod_projection_inferred, 1);
  assert.equal(report.aggregateAcrossQueriedScopes.familiesInferred.llm_telemetry_inferred, 2);
  assert.equal(report.aggregateAcrossQueriedScopes.familiesInferred.learning_artifact_authorship_inferred, 1);
  assertRedacted(report);
});

test('host/path/query/cursor manipulations are rejected before credentials leave the fixed endpoint', async () => {
  const unsafe = ['https://attacker.invalid/xapi/statements?cursor=SECRET',
    '//attacker.invalid/xapi/statements?cursor=SECRET', '/xapi/admin/statements?cursor=SECRET',
    `${TARGET.origin}/xapi/statements?tenant=PRIVATE`, '/xapi/statements?cursor=abc&cursor=abc',
    '/xapi/statements?cursor=abc#PRIVATE', '/xapi/statements?cursor=abc\\PRIVATE',
    cursor(1, { until: HORIZON, ascending: true, limit: 500, agent: PII }),
    cursor(1, { until: '2099-01-01T00:00:00.000Z', ascending: true, limit: 500 }),
    cursor(1, { until: HORIZON, ascending: false, limit: 500 }),
    cursor(1, { until: HORIZON, ascending: true, limit: 10 }), cursor(0), cursor(1, undefined, { ts: Date.parse('2099-01-01') })];
  for (const more of unsafe) {
    const t = scripted([about(), json({ statements: [statement()], more })]);
    await assert.rejects(inventory(config, options(t.fetch)), { message: 'unsafe-continuation' });
    assert.equal(t.calls.length, 2);
  }
});

test('continuation cannot repeat an offset or append arbitrary selectors', () => {
  assert.throws(() => continuationUrl(cursor(1), HORIZON, 1), /unsafe-continuation/);
  assert.throws(() => continuationUrl(cursor(1) + '&attachments=true', HORIZON), /unsafe-continuation/);
  assert.equal(continuationUrl(cursor(1), HORIZON).offset, 1);
});

test('Railway token and service assertions precede variable reads; no mutation query', async () => {
  const t = scripted(railwayResponses());
  const result = await readScopedConfig(SECRET, t.fetch);
  assert.equal(result.FOXXI_ADMIN_KEY_SEED, undefined);
  assert.equal(result.UNRELATED_PRIVATE_KEY, undefined);
  assert.equal(t.calls.length, 3);
  for (const call of t.calls) {
    assert.equal(call.url, TARGET.railway);
    const body = JSON.parse(call.init.body);
    assert.ok(body.query.startsWith('query'));
    assert.equal(call.init.redirect, 'manual');
  }
  assert.deepEqual(JSON.parse(t.calls[2].init.body).variables, {
    projectId: TARGET.project, environmentId: TARGET.environment, serviceId: TARGET.service,
  });
});

test('wrong project or environment never reads service variables', async () => {
  for (const wrong of [{ projectId: 'wrong', environmentId: TARGET.environment }, { projectId: TARGET.project, environmentId: 'wrong' }]) {
    const t = scripted([json({ data: { projectToken: wrong } })]);
    await assert.rejects(readScopedConfig(SECRET, t.fetch), /railway-scope-mismatch/);
    assert.equal(t.calls.length, 1);
  }
});

test('service ID/name mismatch never reads service variables', async () => {
  const responses = railwayResponses();
  responses[1] = json({ data: { project: { services: { edges: [{ node: { id: TARGET.service, name: 'other-service' } }] } } } });
  const t = scripted(responses);
  await assert.rejects(readScopedConfig(SECRET, t.fetch), /railway-scope-mismatch/);
  assert.equal(t.calls.length, 2);
});

test('configured deployment origin cannot redirect inventory to another service', async () => {
  const t = scripted(railwayResponses({ ...config, BRIDGE_DEPLOYMENT_URL: `https://${SECRET}.invalid` }));
  await assert.rejects(readScopedConfig(SECRET, t.fetch), /foxxi-origin-mismatch/);
  assert.equal(t.calls.length, 3);
});

test('raw platform errors, fetch exceptions and auth bodies never appear in CLI output', async () => {
  for (const failure of [json({ errors: [{ message: `${SECRET} ${PII} private/path` }] }),
    () => { throw new Error(`${SECRET} ${PII} private/path`); }]) {
    const t = scripted([failure]);
    const lines = [];
    assert.equal(await main({ GITHUB_REPOSITORY: TARGET.repository, GITHUB_REF: TARGET.ref, RAILWAY_PROJECT_TOKEN: SECRET }, t.fetch, x => lines.push(x)), 1);
    assertRedacted(lines);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('railway-read-failed'));
  }
  const t = scripted([...railwayResponses(), about(), json({ error: `${SECRET} ${PII}` }, 401)]);
  const lines = [];
  assert.equal(await main({ GITHUB_REPOSITORY: TARGET.repository, GITHUB_REF: TARGET.ref, RAILWAY_PROJECT_TOKEN: SECRET }, t.fetch, x => lines.push(x)), 1);
  assertRedacted(lines);
  assert.ok(lines[0].includes('statement-read-failed'));
});

test('redirects never forward Basic credentials or follow a new destination', async () => {
  const t = scripted([about(), new Response('', { status: 302, headers: { Location: `https://${PII}/` } })]);
  await assert.rejects(inventory(config, options(t.fetch)), /statement-read-failed/);
  assert.equal(t.calls.length, 2);
});

test('bounded response reader refuses oversized or non-JSON content', async () => {
  for (const response of [new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    new Response(PII, { headers: { 'content-type': 'text/html' } })]) {
    const t = scripted([about(), response]);
    await assert.rejects(inventory(config, options(t.fetch)), /statement-read-failed/);
  }
});

test('metadata corruption fails closed without exposing the offending record', async () => {
  for (const bad of [statement(1, { id: PII }), statement(1, { stored: PII })]) {
    const t = scripted([about(), json({ statements: [bad], more: '' })]);
    await assert.rejects(inventory(config, options(t.fetch)), /invalid-statement-metadata/);
  }
});

test('pagination is bounded even if the server never ends and repeats records', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    if (String(url).endsWith('/about')) return about();
    calls++;
    return json({ statements: [statement()], more: cursor(calls) });
  };
  await assert.rejects(inventory(config, options(fetchImpl)), /page-limit/);
  assert.equal(calls, 256);
});

test('isolated branch/repository gate refuses all network calls elsewhere', async () => {
  const lines = [];
  let requests = 0;
  const fetchImpl = () => { requests++; throw new Error(SECRET); };
  assert.equal(await main({ GITHUB_REPOSITORY: TARGET.repository, GITHUB_REF: 'refs/heads/master' }, fetchImpl, x => lines.push(x)), 1);
  assert.equal(requests, 0);
  assertRedacted(lines);
});

test('absent credentials report unknown coverage without reading statements', async () => {
  const t = scripted([about()]);
  const report = await inventory({ ...config, FOXXI_LRS_BASIC_AUTH_PAIRS: '' }, options(t.fetch));
  assert.equal(report.basicMappedTenantScopesAvailable, 0);
  assert.equal(report.aggregateAcrossQueriedScopes.count, 0);
  assert.equal(t.calls.length, 1);
  assert.ok(report.unknowns.includes('ordinary_queries_exclude_voided_target_records'));
  assertRedacted(report);
});
