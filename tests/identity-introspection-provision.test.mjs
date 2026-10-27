// tools/identity-introspection-provision.mjs against a stand-in Railway API and stand-in
// health endpoints. Each stage's refusals, no-ops and writes, the preflight's refusals, the
// deploy it starts and waits for, what a failed write says to do next, and that no value
// reaches anything it prints, returns or throws.
//
// The stand-in models what the tool relies on: a variable write changes what Railway STORES; a
// deployment that reaches SUCCESS makes the service RUN what is stored; health endpoints report
// what runs; identity accepts a caller only when the caller runs its value (or identity is open).
// A fake clock drives every wait.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { triggerWithRetry } from '../tools/railway-deploy-trigger.mjs';
import {
  TARGET, SECRET_VAR, OPEN_VAR, STAGES, CALLERS, ProvisionRefusal, StageFailure,
  newSecret, usableSecret, cliRefusal, planStage, runStage, describeFailure, railwayGql, httpClient,
} from '../tools/identity-introspection-provision.mjs';

const SVCS = ['relay', 'css-gate', 'identity'];
const TAG = { relay: 'a1'.repeat(20), 'css-gate': 'b2'.repeat(20), identity: 'c3'.repeat(20) };
const image = (svc, tag = TAG[svc]) => `ghcr.io/markjspivey-xwisee/interego-${svc}:${tag}`;
const V1 = '0123456789abcdef'.repeat(4);
const V2 = 'fedcba9876543210'.repeat(4);
const HEALTH = { relay: '/health', 'css-gate': '/healthz', identity: '/health' };

/** The stand-in: Railway's API, the three services' health, the relay and gate, GitHub's runs list. */
function world(o = {}) {
  const clock = { t: 1_000_000 };
  const events = [];
  const stored = {
    relay: { ...(o.stored?.relay ?? {}) },
    'css-gate': { ...(o.stored?.['css-gate'] ?? {}) },
    identity: { [OPEN_VAR]: '1', ...(o.stored?.identity ?? {}) },
  };
  for (const svc of SVCS) for (const [k, v] of Object.entries(stored[svc])) if (v === undefined) delete stored[svc][k];
  const running = Object.fromEntries(SVCS.map((s) => [s, { ...stored[s], ...(o.running?.[s] ?? {}) }]));
  for (const svc of SVCS) for (const [k, v] of Object.entries(running[svc])) if (v === undefined) delete running[svc][k];
  const pins = { relay: image('relay'), 'css-gate': image('css-gate'), identity: image('identity'), ...(o.pins ?? {}) };
  const serving = { ...TAG, ...(o.serving ?? {}) };
  const deployments = Object.fromEntries(SVCS.map((s) => [s, [{ id: `dep-${s}-0`, status: o.newestStatus?.[s] ?? 'SUCCESS' }]]));
  const scripts = {};
  const successAt = {};
  const counters = { accepted: 0, refused: 0, other: 0 };
  const probes = [];
  let n = 0;
  const svcOf = (id) => SVCS.find((s) => `id-${s}` === id);
  const newDeployment = (svc) => {
    const id = `dep-${svc}-${++n}`;
    deployments[svc].unshift({ id, status: 'DEPLOYING' });
    scripts[id] = { svc, statuses: [...(o.statuses?.[svc] ?? ['DEPLOYING', 'SUCCESS'])] };
    return id;
  };
  const modeOf = () => (running.identity[SECRET_VAR] ? 'enforced' : running.identity[OPEN_VAR] === '1' ? 'open' : 'disabled');
  const accepts = (svc) => {
    const mode = modeOf();
    if (mode === 'open') return true;
    if (mode === 'disabled') return false;
    return running[svc][SECRET_VAR] === running.identity[SECRET_VAR];
  };

  const gql = async (query, v = {}) => {
    events.push({ gql: query, v });
    if (o.gqlThrows?.(query)) throw new Error(o.gqlThrows(query));
    if (query.includes('projectToken')) return { projectToken: { projectId: o.project ?? TARGET.projectId, environmentId: o.environment ?? TARGET.environmentId } };
    if (query.includes('project(id')) {
      const services = o.services ?? SVCS.map((s) => ({ id: `id-${s}`, name: s }));
      return { project: { services: { edges: services.map((node) => ({ node })) } } };
    }
    const svc = svcOf(v.s ?? v.input?.serviceId ?? scripts[v.id]?.svc);
    if (query.includes('variables(')) {
      const copy = { ...stored[svc] };
      if (o.sealed?.includes(svc)) delete copy[SECRET_VAR];
      return { variables: copy };
    }
    if (query.includes('domains(')) {
      return { domains: { serviceDomains: o.noDomain?.includes(svc) ? [] : [{ domain: `${svc}.example.test` }], customDomains: [] } };
    }
    if (query.includes('serviceInstance(')) {
      return { serviceInstance: { source: { image: pins[svc] }, numReplicas: o.numReplicas?.[svc] ?? 1,
        overlapSeconds: o.overlapSeconds ?? null, drainingSeconds: null, latestDeployment: deployments[svc][0] } };
    }
    if (query.includes('deployments(')) return { deployments: { edges: [{ node: { ...deployments[svc][0] } }] } };
    if (query.includes('variableUpsert')) {
      if (o.upsertResult !== undefined) return { variableUpsert: o.upsertResult };
      stored[svc][v.input.name] = o.upsertStores ? o.upsertStores(v.input.value) : v.input.value;
      if (o.upsertAutoDeploys) newDeployment(svc);
      return { variableUpsert: true };
    }
    if (query.includes('variableDelete')) {
      if (o.deleteResult !== undefined) return { variableDelete: o.deleteResult };
      if (!o.deleteKeeps) delete stored[svc][v.input.name];
      if (o.deleteAutoDeploys) newDeployment(svc);
      return { variableDelete: true };
    }
    if (query.includes('serviceInstanceDeployV2')) return { serviceInstanceDeployV2: o.deployResult !== undefined ? o.deployResult : newDeployment(svc) };
    if (query.includes('deployment(id')) {
      const script = scripts[v.id];
      const status = script.statuses.length > 1 ? script.statuses.shift() : script.statuses[0];
      const dep = deployments[script.svc].find((d) => d.id === v.id);
      if (dep.status !== 'SUCCESS' && status === 'SUCCESS') {
        if (!o.noCarry?.includes(script.svc)) running[script.svc] = { ...stored[script.svc] };
        serving[script.svc] = pins[script.svc].split(':').pop();
        successAt[script.svc] = clock.t;
        if (o.repointOnSuccess === script.svc) pins[script.svc] = image(script.svc, 'd4'.repeat(20));
      }
      dep.status = status;
      return { deployment: { status } };
    }
    throw new Error(`unexpected query ${query}`);
  };

  const healthOf = (svc) => {
    if (svc === 'identity') {
      const body = { status: 'ok', build: serving.identity, introspection: modeOf(), allowOpenIntrospection: running.identity[OPEN_VAR] === '1' };
      return o.healthOverride?.(svc, body) ?? body;
    }
    const body = { status: 'ok', build: serving[svc], identityVerifyAuth: Boolean(running[svc][SECRET_VAR]) };
    if (svc === 'css-gate') body.identityVerifyResults = { ...counters };
    return o.healthOverride?.(svc, body) ?? body;
  };
  const http = {
    async getJson(url, opts = {}) {
      events.push({ http: url });
      const u = new URL(url);
      if (u.hostname === 'api.github.com') {
        const file = /workflows\/([^/]+)\/runs/.exec(u.pathname)[1];
        if (o.githubThrows) throw new Error('socket hang up');
        if (o.githubStatus) return { status: o.githubStatus, body: {} };
        return { status: 200, body: { workflow_runs: o.githubRuns?.[file] ?? [{ id: 1, status: 'completed' }] } };
      }
      const svc = SVCS.find((s) => u.hostname === `${s}.example.test`);
      if (u.pathname === HEALTH[svc]) {
        if (o.healthStatus?.[svc]) return { status: o.healthStatus[svc], body: null };
        return { status: 200, body: healthOf(svc) };
      }
      if (svc === 'css-gate' && u.pathname.endsWith('/auth-methods.jsonld')) {
        probes.push({ side: 'gate', at: clock.t });
        assert.match(opts.headers.Authorization, /^Bearer introspection-rollout-probe-[0-9a-f]{16}$/);
        if (!o.gateInconclusive) {
          if (modeOf() === 'disabled' || !accepts('css-gate')) counters.refused++;
          else counters.accepted++;
        }
        return { status: 401, body: { error: 'invalid bearer' } };
      }
      return { status: 404, body: null };
    },
    async send(url, { method, headers }) {
      events.push({ http: url, method });
      const u = new URL(url);
      if (u.hostname === 'relay.example.test' && u.pathname === '/tool/publish_context' && method === 'POST') {
        probes.push({ side: 'relay', at: clock.t });
        assert.equal(headers.Authorization, 'Bearer introspection-rollout-probe');
        if (o.relayInconclusive) return { status: 502, body: null };
        return { status: 401, body: { detail: accepts('relay') ? 'Token not found' : 'Identity server error: 401' } };
      }
      return { status: 404, body: null };
    },
  };
  const masks = [];
  return {
    clock, events, stored, running, pins, deployments, successAt, probes, masks, counters, gql, http,
    sleep: async (ms) => { clock.t += ms; },
    now: () => clock.t,
    mask: (v) => { masks.push(v); events.push({ mask: true }); },
  };
}

const upserts = (w) => w.events.filter((e) => e.gql?.includes('variableUpsert')).map((e) => e.v.input);
const deletes = (w) => w.events.filter((e) => e.gql?.includes('variableDelete')).map((e) => e.v.input);
const deploysTriggered = (w) => w.events.filter((e) => e.gql?.includes('serviceInstanceDeployV2')).map((e) => e.v.s.replace(/^id-/, ''));
const writeCount = (w) => upserts(w).length + deletes(w).length;

/** What the CLI passes inside GitHub Actions; an applied run needs it. `null` passes none. */
const GH = Object.freeze({ repository: 'markjspivey-xwisee/interego', token: 'gh-token', runId: '77' });

/** Run one stage and capture everything it says, returns or throws. */
async function run(w, stage, { apply = false, rand, github = apply ? GH : undefined } = {}) {
  const lines = [];
  const captured = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return out(chunk, ...rest); };
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return err(chunk, ...rest); };
  let summary;
  let error;
  try {
    summary = await runStage({ gql: w.gql, http: w.http, stage, apply, rand, log: (l) => lines.push(l), mask: w.mask, sleep: w.sleep, now: w.now, github });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  const text = [lines.join('\n'), captured.join(''), JSON.stringify(summary ?? null), error ? `${error.message} ${String(error.cause ?? '')}` : '',
    error ? describeFailure(error) : ''].join('\n');
  return { summary, error, lines, text };
}

function assertNoValue(r, ...values) {
  for (const v of values) {
    assert.equal(r.text.includes(v), false, 'a value reached the output');
    assert.equal(r.text.includes(v.slice(0, 12)), false, 'part of a value reached the output');
  }
}

const both = { relay: { [SECRET_VAR]: V1 }, 'css-gate': { [SECRET_VAR]: V1 } };

// ── callers ───────────────────────────────────────────────────────────────────

test('callers, fresh, dry run: nothing written, generated, masked or deployed', async () => {
  const w = world();
  let drawn = 0;
  const r = await run(w, 'callers', { rand: (n) => { drawn++; return Buffer.alloc(n, 1); } });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.summary.applied, false);
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), []);
  assert.equal(drawn, 0);
  assert.deepEqual(w.masks, []);
  assert.match(r.text, /relay: IDENTITY_INTROSPECTION_SECRET unset/);
  assert.match(r.text, /relay and css-gate equal: n\/a/);
  assert.match(r.text, /plan: write IDENTITY_INTROSPECTION_SECRET on relay \(generated now, never shown\)/);
  assert.match(r.text, /dry run: nothing written or deployed/);
});

test('callers, fresh, apply: one generated value on both callers, masked first, both deployed, never shown', async () => {
  const w = world();
  const r = await run(w, 'callers', { apply: true });
  assert.equal(r.error, undefined, r.error && describeFailure(r.error));
  const u = upserts(w);
  assert.deepEqual(u.map((x) => x.serviceId), ['id-relay', 'id-css-gate']);
  assert.ok(u.every((x) => x.name === SECRET_VAR && x.skipDeploys === true));
  const value = u[0].value;
  assert.match(value, /^[0-9a-f]{64}$/);
  assert.equal(u[1].value, value);
  assert.deepEqual(w.masks, [value]);
  const maskAt = w.events.findIndex((e) => e.mask);
  const upsertAt = w.events.findIndex((e) => e.gql?.includes('variableUpsert'));
  assert.ok(maskAt >= 0 && maskAt < upsertAt, 'masked before the first write');
  assert.deepEqual(deploysTriggered(w), ['relay', 'css-gate']);
  assert.equal(w.running.relay[SECRET_VAR], value);
  assert.equal(w.running['css-gate'][SECRET_VAR], value);
  assert.deepEqual(r.summary, { stage: 'callers', applied: true, wrote: [`relay:${SECRET_VAR}`, `css-gate:${SECRET_VAR}`], deployed: ['relay', 'css-gate'] });
  assertNoValue(r, value);
});

test('callers rerun: both equal and running, nothing written or deployed', async () => {
  const w = world({ stored: both });
  const r = await run(w, 'callers', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), []);
  assert.match(r.text, /relay and css-gate equal: yes/);
  assert.deepEqual(w.masks, [V1]);
  assertNoValue(r, V1);
});

test('callers converge: a caller stored but not running is deployed, not written', async () => {
  const w = world({ stored: both, running: { 'css-gate': { [SECRET_VAR]: undefined } } });
  const r = await run(w, 'callers', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), ['css-gate']);
  assert.deepEqual(r.summary.deployed, ['css-gate']);
});

test('a deployment Railway starts after the write is followed, not triggered over', async () => {
  const w = world({ upsertAutoDeploys: true });
  const r = await run(w, 'callers', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.deepEqual(deploysTriggered(w), []);
  assert.match(r.text, /Railway started deployment dep-relay-\d+ after the write; following it/);
  assert.deepEqual(r.summary.deployed, ['relay', 'css-gate']);
});

const UNUSABLE = /the callers' IDENTITY_INTROSPECTION_SECRET is not usable \(it must be at least 32 printable ASCII characters with no spaces\)/;
for (const [why, opts, pattern] of [
  ['only one caller set', { stored: { relay: { [SECRET_VAR]: V1 } } }, /only relay holds .*delete it from relay in Railway, then rerun$/],
  ['the callers differ', { stored: { relay: { [SECRET_VAR]: V1 }, 'css-gate': { [SECRET_VAR]: V2 } } }, /different values/],
  ['both equal but padded', { stored: { relay: { [SECRET_VAR]: ` ${V1}` }, 'css-gate': { [SECRET_VAR]: ` ${V1}` } } }, UNUSABLE],
  ['both equal but short', { stored: { relay: { [SECRET_VAR]: 'short' }, 'css-gate': { [SECRET_VAR]: 'short' } } }, UNUSABLE],
  // Long enough, no whitespace and no control character: refused for the non-ASCII character,
  // which the message has to name.
  ['both equal but not ASCII', { stored: { relay: { [SECRET_VAR]: `${V1}\u00e9` }, 'css-gate': { [SECRET_VAR]: `${V1}\u00e9` } } }, UNUSABLE],
  ['identity set while the callers are not', { stored: { identity: { [SECRET_VAR]: V1 } } }, /^identity holds .* relay and css-gate do not, so identity refuses them now\. .*a new value would not match identity's$/],
  ['a sealed caller (running a value Railway does not show)', { stored: both, sealed: ['css-gate'] }, /css-gate runs with a value Railway does not show/],
]) {
  test(`callers refuses, before any write: ${why}`, async () => {
    const w = world(opts);
    const r = await run(w, 'callers', { apply: true });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
    assert.match(r.error.message, pattern);
    assert.equal(writeCount(w), 0);
    assert.deepEqual(deploysTriggered(w), []);
    assertNoValue(r, V1, V2);
  });
}

// A Railway Rollback restores a deployment's variables with its image, so rolling css-gate back
// past the deployment stage=callers made leaves only the relay holding the value while identity
// enforces it. Before identity holds the value, the way out is to delete the relay's copy; here
// that would get the relay refused too, so every stage refuses and says to undo the rollback.
for (const stage of STAGES) {
  test(`${stage} refuses, before any write, when identity holds the value and a caller lost it`, async () => {
    const w = world({ stored: { relay: { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1 } } });
    const r = await run(w, stage, { apply: true });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
    assert.match(r.error.message, /^identity holds IDENTITY_INTROSPECTION_SECRET and css-gate does not, so identity refuses it now\. A Railway Rollback past the deployment stage=callers made unsets the variable: in Railway, roll css-gate back again to the deployment that was active before that rollback, and do not delete relay's copy\./);
    assert.doesNotMatch(r.error.message, /delete it from relay/);
    assert.equal(writeCount(w), 0);
    assert.deepEqual(deploysTriggered(w), []);
    assertNoValue(r, V1);
  });
}

// The same Rollback, to a deployment that ran an older image: the pin and health-field refusals
// would send the operator to deploy-railway.yml, which keeps the restored (unset) variable, so
// the roll-back-again advice goes first. Without identity holding the value they still apply.
for (const [why, opts, otherwise] of [
  ['is pinned to a mutable tag', { pins: { 'css-gate': 'ghcr.io/markjspivey-xwisee/interego-css-gate:latest' } }, /css-gate is not pinned to ghcr\.io\/markjspivey-xwisee\/interego-css-gate:<40-hex sha>/],
  ['serves a build other than its pin', { serving: { 'css-gate': 'e5'.repeat(20) } }, /css-gate is pinned to b2b2b2b2 but serving e5e5e5e5; a redeploy would change running code/],
  ['serves an image without the health fields', { healthOverride: (svc, body) => (svc === 'css-gate' ? { status: 'ok', build: body.build } : undefined) }, /css-gate serves an image without the introspection health fields; deploy master first/],
  ['does not answer its health check', { healthStatus: { 'css-gate': 503 } }, /css-gate: GET https:\/\/css-gate\.example\.test\/healthz did not answer 200 with JSON/],
]) {
  for (const stage of STAGES) {
    test(`${stage}: a caller rolled back to an older image that ${why} is told to roll back again`, async () => {
      const w = world({ ...opts, stored: { relay: { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1 } } });
      const r = await run(w, stage, { apply: true });
      assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
      assert.match(r.error.message, /^identity holds IDENTITY_INTROSPECTION_SECRET and css-gate does not, so identity refuses it now\. .*roll css-gate back again to the deployment that was active before that rollback, and do not delete relay's copy\./);
      assert.doesNotMatch(r.error.message, /deploy master first|reconcile with deploy-railway/);
      assert.equal(writeCount(w), 0);
      assert.deepEqual(deploysTriggered(w), []);
      assertNoValue(r, V1);
    });
  }
  test(`a caller that ${why} while identity holds nothing is refused for that`, async () => {
    const w = world({ ...opts, stored: { relay: { [SECRET_VAR]: V1 } } });
    const r = await run(w, 'callers', { apply: true });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
    assert.match(r.error.message, otherwise);
    assert.equal(writeCount(w), 0);
  });
}

test('a caller lost while identity holds the value but does not run it yet', () => {
  const st = { relay: { stored: undefined, running: false }, 'css-gate': { stored: V1, running: true },
    identity: { stored: V1, running: false, openStored: true, openRunning: true } };
  assert.throws(() => planStage('callers', st), /relay does not, so identity refuses it from its next deploy\. .*roll relay back again .*do not delete css-gate's copy/);
});

// identity running 'enforced' while Railway shows its variable unset: the sealed-or-undeployed
// guard refuses before the callers rule is reached.
test('callers refuses when identity runs enforced but Railway shows it unset (sealed)', async () => {
  const w = world({ stored: { identity: { [SECRET_VAR]: V1 } }, sealed: ['identity'] });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /identity runs with a value Railway does not show/);
  assert.equal(writeCount(w), 0);
});

// ── identity ──────────────────────────────────────────────────────────────────

test('identity refuses while the callers are unset', async () => {
  const w = world();
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /run stage=callers with apply first/);
  assert.equal(writeCount(w), 0);
});

test('identity refuses when a caller does not report presenting the bearer', async () => {
  const w = world({ stored: both, running: { relay: { [SECRET_VAR]: undefined } } });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /relay does not report presenting a bearer/);
  assert.equal(writeCount(w), 0);
});

test('identity refuses when identity serves an image without the health fields', async () => {
  const w = world({ stored: both, healthOverride: (svc, body) => (svc === 'identity' ? { status: 'ok', build: body.build } : undefined) });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /deploy master first/);
  assert.equal(writeCount(w), 0);
});

// ALLOW_OPEN_INTROSPECTION=1 is the identity stage's rollback: deleting the secret again leaves
// identity open only while it is stored. Running it is not enough (removed without a deploy).
for (const [why, running] of [['runs it', { identity: { [OPEN_VAR]: '1' } }], ['does not run it either', {}]]) {
  test(`identity refuses to write when ALLOW_OPEN_INTROSPECTION is not stored and identity ${why}`, async () => {
    for (const apply of [false, true]) {
      const w = world({ stored: { ...both, identity: { [OPEN_VAR]: undefined } }, running });
      const r = await run(w, 'identity', { apply });
      assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
      assert.match(r.error.message, /^identity does not hold ALLOW_OPEN_INTROSPECTION=1, this stage's rollback: .*Set ALLOW_OPEN_INTROSPECTION=1 on identity and deploy identity, then rerun$/);
      assert.equal(writeCount(w), 0);
      assert.deepEqual(deploysTriggered(w), []);
      assertNoValue(r, V1);
    }
  });
}

test('identity refuses when the check before the write is not accepted', async () => {
  const w = world({ stored: both, relayInconclusive: true });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /does not accept both callers now/);
  assert.equal(writeCount(w), 0);
});

test('identity: copies the callers\' value, deploys, waits out the overlap, and checks both callers', async () => {
  const w = world({ stored: both, overlapSeconds: 30 });
  const r = await run(w, 'identity', { apply: true });
  assert.equal(r.error, undefined, r.error && describeFailure(r.error));
  const u = upserts(w);
  assert.equal(u.length, 1);
  assert.equal(u[0].serviceId, 'id-identity');
  assert.equal(u[0].value, V1);
  assert.equal(u[0].skipDeploys, true);
  assert.deepEqual(deploysTriggered(w), ['identity']);
  assert.equal(w.running.identity[SECRET_VAR], V1);
  const after = w.probes.filter((p) => p.at > w.successAt.identity);
  assert.ok(after.some((p) => p.side === 'relay') && after.some((p) => p.side === 'gate'));
  assert.ok(Math.min(...after.map((p) => p.at)) - w.successAt.identity >= 40_000, 'probed inside the overlap');
  assert.match(r.text, /check after the deploy: identity accepts relay: accepted; accepts css-gate: accepted/);
  assertNoValue(r, V1);
});

test('identity rerun: identity equal and enforcing, nothing written or deployed', async () => {
  const w = world({ stored: { ...both, identity: { [SECRET_VAR]: V1 } } });
  const r = await run(w, 'identity', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), []);
});

test('identity refuses when identity holds a different value', async () => {
  const w = world({ stored: { ...both, identity: { [SECRET_VAR]: V2 } }, running: { identity: { [SECRET_VAR]: undefined } } });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /different/);
  assert.equal(writeCount(w), 0);
  assertNoValue(r, V1, V2);
});

test('identity: a caller running a stale value fails the stage and names the rollback', async () => {
  const w = world({ stored: both, running: { relay: { [SECRET_VAR]: V2 } } });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message);
  assert.match(r.error.message, /identity refuses the relay/);
  assert.match(r.error.message, /delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION is still set\) and redeploy identity/);
  assertNoValue(r, V1, V2);
});

test('identity: the gate refused after the deploy fails the stage', async () => {
  const w = world({ stored: both, running: { 'css-gate': { [SECRET_VAR]: V2 } } });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message);
  assert.match(r.error.message, /identity refuses css-gate/);
});

test('identity: an inconclusive check after the deploy fails the stage with the manual checks', async () => {
  const w = world({ stored: both });
  let calls = 0;
  const http = { ...w.http, async send(url, opts) { calls++; return calls === 1 ? w.http.send(url, opts) : { status: 502, body: null }; } };
  const r = await run({ ...w, http }, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message);
  assert.match(r.error.message, /inconclusive for the relay.*Check by hand/);
});

// ── finalize ──────────────────────────────────────────────────────────────────

const enforcing = { ...both, identity: { [SECRET_VAR]: V1 } };

test('finalize refuses while identity does not enforce', async () => {
  const w = world({ stored: enforcing, running: { identity: { [SECRET_VAR]: undefined } } });
  const r = await run(w, 'finalize', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /run stage=identity first/);
  assert.equal(writeCount(w), 0);
});

test('finalize with ALLOW_OPEN_INTROSPECTION gone and not running: nothing to do', async () => {
  const w = world({ stored: { ...enforcing, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } } });
  const r = await run(w, 'finalize', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), []);
});

test('finalize converge: removed but still running with it, so one deploy and no write', async () => {
  const w = world({ stored: { ...enforcing, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } }, running: { identity: { [OPEN_VAR]: '1' } } });
  const r = await run(w, 'finalize', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), ['identity']);
  assert.equal(w.running.identity[OPEN_VAR], undefined);
});

for (const caller of CALLERS) {
  test(`finalize refuses, and keeps the rollback, while identity refuses ${caller}`, async () => {
    const w = world({ stored: enforcing, running: { [caller]: { [SECRET_VAR]: V2 } } });
    const r = await run(w, 'finalize', { apply: true });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
    assert.match(r.error.message, /identity does not accept both callers; do not remove ALLOW_OPEN_INTROSPECTION \(the rollback\)/);
    assert.match(r.text, caller === 'relay' ? /accepts relay: rejected; accepts css-gate: accepted/ : /accepts relay: accepted; accepts css-gate: rejected/);
    assert.deepEqual(deletes(w), []);
    assert.equal(writeCount(w), 0);
    assert.deepEqual(deploysTriggered(w), []);
    assert.equal(w.stored.identity[OPEN_VAR], '1');
    assertNoValue(r, V1, V2);
  });
}

test('finalize deletes ALLOW_OPEN_INTROSPECTION and follows the deployment Railway starts', async () => {
  const w = world({ stored: enforcing, deleteAutoDeploys: true });
  const r = await run(w, 'finalize', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.deepEqual(deletes(w).map((d) => [d.serviceId, d.name]), [['id-identity', OPEN_VAR]]);
  assert.deepEqual(deploysTriggered(w), []);
  assert.equal(w.running.identity[OPEN_VAR], undefined);
  assert.equal(w.running.identity[SECRET_VAR], V1);
});

test('finalize deletes and, when Railway starts nothing within the grace window, deploys once', async () => {
  const w = world({ stored: enforcing });
  const r = await run(w, 'finalize', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(deletes(w).length, 1);
  assert.deepEqual(deploysTriggered(w), ['identity']);
  const deleteAt = w.events.findIndex((e) => e.gql?.includes('variableDelete'));
  const graceChecks = w.events.slice(deleteAt).filter((e) => e.gql?.includes('deployments(')).length;
  assert.ok(graceChecks >= 10, `the grace window was not waited (${graceChecks} checks)`);
  assert.match(r.text, /allowOpenIntrospection=false/);
});

// ── deploy outcomes ───────────────────────────────────────────────────────────

test('a FAILED deployment fails the stage and says what is stored', async () => {
  const w = world({ stored: both, statuses: { identity: ['DEPLOYING', 'FAILED'] } });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure);
  assert.match(r.error.message, /ended FAILED/);
  assert.match(r.error.message, /next identity deploy \(an auto-deploy included\) will enforce it\. Rerun stage=identity, or delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION is still set\) to stay open\.$/);
  assert.doesNotMatch(r.error.message, /Deployment dep-identity/);
});

// Identity already holds the secret but runs open, and ALLOW_OPEN_INTROSPECTION is no longer
// stored: the stage only deploys. Deleting the secret alone would then leave identity disabled.
test('a failed identity deploy without ALLOW_OPEN_INTROSPECTION stored says to set it before deleting the secret', async () => {
  const w = world({
    stored: { ...both, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } },
    running: { identity: { [SECRET_VAR]: undefined, [OPEN_VAR]: '1' } },
    statuses: { identity: ['DEPLOYING', 'FAILED'] },
  });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), ['identity']);
  assert.match(r.error.message, /ended FAILED\. .*Rerun stage=identity, or set ALLOW_OPEN_INTROSPECTION=1 on identity, then delete IDENTITY_INTROSPECTION_SECRET from identity to stay open\.$/);
  assertNoValue(r, V1);
});

// Once a deployment carrying the secret exists, deleting the stored variable does not change
// it: the text names the deployment and says how to check and how to reopen.
for (const [why, opts, pattern] of [
  ['is still in flight at the deadline', { statuses: { identity: ['DEPLOYING'] } }, /^deployment dep-identity-1 of identity is still DEPLOYING; do not rerun while it is in flight/],
  ['succeeds, and the service is repointed', { repointOnSuccess: 'identity' }, /^identity was repointed during this run/],
]) {
  test(`an identity deployment that ${why} is named, with how to check and reopen`, async () => {
    const w = world({ stored: both, ...opts });
    const r = await run(w, 'identity', { apply: true });
    assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
    assert.match(r.error.message, pattern);
    assert.match(r.error.message, /Deployment dep-identity-1 of identity was created with IDENTITY_INTROSPECTION_SECRET stored, so identity enforces it from that deployment if it carries the change, and otherwise from its next deploy\. Rerun stage=identity once no identity deployment is in flight: its check before any write tells whether identity accepts both callers/);
    assert.match(r.error.message, /To reopen instead, delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION is still set\), and deploy identity again\.$/);
    assert.doesNotMatch(r.error.message, /next identity deploy \(an auto-deploy included\)|to stay open/);
    assertNoValue(r, V1);
  });
}

// stage=callers also deploys a caller that holds the value and does not run it, whatever
// identity does, so its failure text reads identity's mode rather than assuming it is open.
for (const [why, identity, pattern] of [
  ['enforces the value', { stored: { [SECRET_VAR]: V1 } }, /IDENTITY_INTROSPECTION_SECRET is stored on relay and css-gate; identity enforces IDENTITY_INTROSPECTION_SECRET, so a caller that does not run it yet is refused until a deployment of it succeeds\. Rerun stage=callers/],
  ['holds the value without running it', { stored: { [SECRET_VAR]: V1 }, running: { [SECRET_VAR]: undefined } }, /identity holds IDENTITY_INTROSPECTION_SECRET and enforces it from its next deploy \(an auto-deploy included\), refusing a caller that does not run it by then\. Rerun stage=callers/],
  ['runs disabled', { stored: { [OPEN_VAR]: undefined } }, /identity does not hold IDENTITY_INTROSPECTION_SECRET, so nothing enforces it yet\. Rerun stage=callers/],
]) {
  for (const [how, more, failure] of [
    ['its deployment fails', { statuses: { 'css-gate': ['DEPLOYING', 'FAILED'] } }, /^deployment dep-css-gate-1 of css-gate ended FAILED\. /],
    ['its deployment does not carry the change', { noCarry: ['css-gate'] }, /^css-gate reached SUCCESS but still reports identityVerifyAuth=false/],
  ]) {
    test(`callers: a caller deploy while identity ${why}, and ${how}, says what identity does`, async () => {
      const w = world({
        stored: { ...both, identity: identity.stored },
        running: { 'css-gate': { [SECRET_VAR]: undefined }, identity: identity.running ?? {} },
        ...more,
      });
      const r = await run(w, 'callers', { apply: true });
      assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
      assert.equal(writeCount(w), 0);
      assert.deepEqual(deploysTriggered(w), ['css-gate']);
      assert.match(r.error.message, failure);
      assert.match(r.error.message, pattern);
      assert.doesNotMatch(r.error.message, /still open/);
      assertNoValue(r, V1);
    });
  }
}

test('a deployment that never finishes times out and says not to rerun', async () => {
  const w = world({ statuses: { relay: ['DEPLOYING'] } });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure);
  assert.match(r.error.message, /do not rerun while it is in flight/);
  assert.equal(r.text.includes(w.stored.relay[SECRET_VAR]), false);
});

test('a pin that moves during the run fails the stage', async () => {
  const w = world({ repointOnSuccess: 'relay' });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure);
  assert.match(r.error.message, /repointed/);
});

test('SUCCESS without the health field changing fails the stage', async () => {
  const w = world({ noCarry: ['relay'] });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure);
  assert.match(r.error.message, /staged changes/);
  assert.equal(r.text.includes(w.stored.relay[SECRET_VAR]), false);
});

// Railway keeps the old container answering for overlapSeconds after SUCCESS, so one reading
// from the new container can be followed by readings from the old one. One good reading is not
// enough; the field must read the same twice in a row.
test('one health reading with the change, then stale ones, fails the stage', async () => {
  let w;
  let afterSuccess = 0;
  w = world({
    healthOverride: (svc, body) => {
      if (svc !== 'relay' || w?.successAt.relay === undefined) return undefined;
      afterSuccess++;
      return afterSuccess === 1 ? body : { ...body, identityVerifyAuth: false };
    },
  });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.match(r.error.message, /relay reached SUCCESS but still reports identityVerifyAuth=false/);
  assert.ok(afterSuccess > 2, 'the tool kept reading');
  assert.deepEqual(deploysTriggered(w), ['relay']);
});

test('a write Railway does not confirm fails the stage', async () => {
  const w = world({ upsertResult: false });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure);
  assert.match(r.error.message, /did not confirm/);
});

test('a write that reads back as something else fails the stage before any deploy', async () => {
  const w = world({ upsertStores: (v) => `${v}-changed` });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.match(r.error.message, /IDENTITY_INTROSPECTION_SECRET on relay does not read back as written\. Whether IDENTITY_INTROSPECTION_SECRET landed on relay is unknown/);
  assert.equal(upserts(w).length, 1, 'css-gate is not written after relay failed');
  assert.deepEqual(deploysTriggered(w), []);
  assertNoValue(r, w.stored.relay[SECRET_VAR]);
});

for (const [why, opts, pattern] of [
  ['Railway does not confirm the delete', { deleteResult: false }, /Railway did not confirm deleting ALLOW_OPEN_INTROSPECTION on identity/],
  ['the variable is still listed after the delete', { deleteKeeps: true }, /ALLOW_OPEN_INTROSPECTION is still listed on identity after the delete/],
]) {
  test(`finalize fails, before any deploy, when ${why}`, async () => {
    const w = world({ stored: enforcing, ...opts });
    const r = await run(w, 'finalize', { apply: true });
    assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
    assert.match(r.error.message, pattern);
    assert.match(r.error.message, /ALLOW_OPEN_INTROSPECTION may be removed from identity/);
    assert.deepEqual(deploysTriggered(w), []);
  });
}

test('a deploy request that fails, or that returns no deployment id, fails the stage and says what is stored', async () => {
  const lost = world({ gqlThrows: (q) => (q.includes('serviceInstanceDeployV2') ? 'network: request failed' : null) });
  const r1 = await run(lost, 'callers', { apply: true });
  assert.ok(r1.error instanceof StageFailure, r1.error?.message ?? 'no failure');
  assert.match(r1.error.message, /the deploy of relay failed at a Railway or HTTP request \(network\)\. IDENTITY_INTROSPECTION_SECRET is stored on relay and css-gate; identity is still open, so nothing enforces yet\./);
  assertNoValue(r1, lost.stored.relay[SECRET_VAR]);
  const empty = world({ deployResult: null });
  const r2 = await run(empty, 'callers', { apply: true });
  assert.ok(r2.error instanceof StageFailure, r2.error?.message ?? 'no failure');
  assert.match(r2.error.message, /Railway returned no deployment id for relay\. IDENTITY_INTROSPECTION_SECRET is stored on relay and css-gate/);
});

test('a write that half-lands (relay written, css-gate refused): rerun first, and the rerun names the copy to delete', async () => {
  let upsertsSeen = 0;
  let refuse = true;
  const w = world({ gqlThrows: (q) => (refuse && q.includes('variableUpsert') && ++upsertsSeen === 2 ? 'GraphQL: Railway refused the request' : null) });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message);
  assert.match(r.error.message, /Whether IDENTITY_INTROSPECTION_SECRET landed on css-gate is unknown \(relay holds it\)\..*Rerun stage=callers before changing anything in Railway/);
  assert.doesNotMatch(r.error.message, /delete it from/);
  assert.doesNotMatch(r.error.message, /by hand/);
  assert.deepEqual(deploysTriggered(w), []);
  refuse = false;
  const again = await run(w, 'callers', { apply: true });
  assert.ok(again.error instanceof ProvisionRefusal, again.error?.message);
  assert.match(again.error.message, /only relay holds IDENTITY_INTROSPECTION_SECRET.*delete it from relay in Railway, then rerun$/);
  assertNoValue(r, w.stored.relay[SECRET_VAR]);
  assertNoValue(again, w.stored.relay[SECRET_VAR]);
});

// A write Railway applied but whose outcome the tool could not confirm: the answer was lost, or
// the read-back failed. Both callers then hold the same value, so the advice must not be to
// delete the one copy the tool confirmed, and a plain rerun finishes the stage.
for (const [why, lose] of [
  ['the read-back fails', (q, v, landed) => landed && q.includes('variables(') && v.s === 'id-css-gate'],
  ['the answer to the upsert is lost', (q, v) => q.includes('variableUpsert') && v.input.serviceId === 'id-css-gate'],
]) {
  test(`css-gate's write lands but ${why}: the message says rerun first, and the rerun finishes`, async () => {
    const w = world();
    let landed = false;
    let failing = true;
    const gql = async (q, v) => {
      const answer = await w.gql(q, v);
      if (failing && lose(q, v, landed)) { failing = false; throw new Error('network: request failed'); }
      if (q.includes('variableUpsert') && v.input.serviceId === 'id-css-gate') landed = true;
      return answer;
    };
    const r = await run({ ...w, gql }, 'callers', { apply: true });
    assert.ok(r.error instanceof StageFailure, r.error?.message);
    const value = w.stored.relay[SECRET_VAR];
    assert.equal(w.stored['css-gate'][SECRET_VAR], value, 'the stand-in applied the write');
    assert.match(r.error.message, /failed at a Railway request \(network\)/);
    assert.match(r.error.message, /Whether IDENTITY_INTROSPECTION_SECRET landed on css-gate is unknown \(relay holds it\)/);
    assert.match(r.error.message, /Rerun stage=callers before changing anything in Railway/);
    assert.doesNotMatch(r.error.message, /delete it from relay/);
    assertNoValue(r, value);
    const again = await run(w, 'callers', { apply: true });
    assert.equal(again.error, undefined, again.error && describeFailure(again.error));
    assert.match(again.text, /relay and css-gate equal: yes/);
    assert.equal(writeCount(w), 2, 'the rerun writes nothing');
    assert.deepEqual(again.summary.deployed, ['relay', 'css-gate']);
    assertNoValue(again, value);
  });
}

// ── preflight ─────────────────────────────────────────────────────────────────

for (const [why, opts, pattern] of [
  ['another project', { project: 'not-the-fleet' }, /does not belong/],
  ['another environment', { environment: 'not-production' }, /does not belong/],
  ['a missing service', { services: [{ id: 'id-relay', name: 'relay' }, { id: 'id-identity', name: 'identity' }] }, /exactly one service named css-gate/],
  ['a duplicated service', { services: [...SVCS.map((s) => ({ id: `id-${s}`, name: s })), { id: 'x', name: 'relay' }] }, /exactly one service named relay, found 2/],
  ['a mutable tag', { pins: { relay: 'ghcr.io/markjspivey-xwisee/interego-relay:latest' } }, /not pinned/],
  ['a repository the table does not name', { pins: { identity: `ghcr.io/markjspivey-xwisee/interego-relay:${TAG.identity}` } }, /not pinned/],
  ['a build other than the pin', { serving: { 'css-gate': 'e5'.repeat(20) } }, /pinned to b2b2b2b2 but serving e5e5e5e5/],
  ['a deployment in flight', { newestStatus: { identity: 'BUILDING' } }, /dep-identity-0 BUILDING/],
  ['a caller image without the health field', { healthOverride: (svc, body) => (svc === 'relay' ? { status: 'ok', build: body.build } : undefined) }, /deploy master first/],
  ['a css-gate image without identityVerifyResults', { healthOverride: (svc, body) => (svc === 'css-gate' ? { ...body, identityVerifyResults: undefined } : undefined) }, /css-gate serves an image without the introspection health fields; deploy master first/],
  ['an identity image without allowOpenIntrospection', { healthOverride: (svc, body) => (svc === 'identity' ? { ...body, allowOpenIntrospection: undefined } : undefined) }, /identity serves an image without the introspection health fields/],
  ['a service Railway reports no domain for', { noDomain: ['identity'] }, /identity: no health URL \(Railway reports no domain/],
  ['a health endpoint that does not answer 200', { healthStatus: { 'css-gate': 503 } }, /css-gate: GET https:\/\/css-gate\.example\.test\/healthz did not answer 200 with JSON/],
]) {
  test(`preflight refuses: ${why}`, async () => {
    const w = world({ ...opts, stored: both });
    const r = await run(w, 'callers', { apply: true });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
    assert.match(r.error.message, pattern);
    assert.equal(writeCount(w), 0);
    assert.deepEqual(deploysTriggered(w), []);
  });
}

test('preflight refuses while a deploy workflow run has not finished, and skips the check outside Actions', async () => {
  const github = { repository: 'markjspivey-xwisee/interego', token: 'gh-token', runId: '77' };
  const busy = world({ githubRuns: { 'auto-deploy.yml': [{ id: 76, status: 'in_progress' }] } });
  const r = await run(busy, 'callers', { apply: true, github });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /auto-deploy\.yml has a run that has not finished \(76\)/);
  assert.equal(writeCount(busy), 0);
  const self = world({ githubRuns: { 'identity-introspection-provision.yml': [{ id: 77, status: 'in_progress' }, { id: 70, status: 'completed' }] } });
  assert.equal((await run(self, 'callers', { apply: true, github })).error, undefined, 'its own run does not count');
  // Another run of this workflow: the concurrency group keeps it apart today, and this keeps
  // that true if the group changes. A queued run counts too.
  for (const other of [{ id: 78, status: 'in_progress' }, { id: 79, status: 'queued' }]) {
    const twice = world({ githubRuns: { 'identity-introspection-provision.yml': [{ id: 77, status: 'in_progress' }, other] } });
    const r3 = await run(twice, 'callers', { apply: true, github });
    assert.ok(r3.error instanceof ProvisionRefusal, r3.error?.message ?? 'no refusal');
    assert.equal(r3.error.message, `identity-introspection-provision.yml has a run that has not finished (${other.id}); rerun when it has`);
    assert.equal(writeCount(twice), 0);
    assert.equal(twice.events.some((e) => e.gql?.includes('variables(')), false, 'no variable was read');
  }
  const denied = world({ githubStatus: 403 });
  assert.match((await run(denied, 'callers', { github })).error.message, /could not list the runs of auto-deploy\.yml \(HTTP 403\)/);
  const unreachable = world({ githubThrows: true });
  const r2 = await run(unreachable, 'callers', { apply: true, github });
  assert.ok(r2.error instanceof ProvisionRefusal, r2.error?.message ?? 'no refusal');
  assert.match(r2.error.message, /could not list the runs of auto-deploy\.yml$/);
  assert.equal(writeCount(unreachable), 0);
  const local = world();
  assert.match((await run(local, 'callers')).text, /not in GitHub Actions/);
  for (const partial of [{ repository: GH.repository, runId: '77' }, { token: GH.token, runId: '77' }, { repository: GH.repository, token: GH.token }]) {
    const w = world();
    const r = await run(w, 'callers', { apply: true, github: partial });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
    assert.match(r.error.message, /GITHUB_TOKEN, GITHUB_REPOSITORY or GITHUB_RUN_ID is not set/);
    assert.equal(writeCount(w), 0);
  }
});

test('an applied run outside GitHub Actions is refused before any variable is read or anything written', async () => {
  const w = world();
  const r = await run(w, 'callers', { apply: true, github: null });
  assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
  assert.match(r.error.message, /apply runs only inside GitHub Actions/);
  assert.equal(writeCount(w), 0);
  assert.deepEqual(deploysTriggered(w), []);
  assert.equal(w.events.some((e) => e.gql?.includes('variables(')), false, 'no variable was read');
});

test('css-gate with more than one replica is noted', async () => {
  const w = world({ stored: both, numReplicas: { 'css-gate': 2 } });
  const r = await run(w, 'callers');
  assert.match(r.text, /per replica/);
});

// ── the live wrappers and failure text ───────────────────────────────────────

test('Railway error text never reaches a message; a non-2xx answer is "network:" and is not retried', async () => {
  const leaky = railwayGql('tok', async () => new Response(JSON.stringify({ errors: [{ message: `bad value ${V1}` }] }), { status: 200 }));
  const e1 = await leaky('{x}').catch((e) => e);
  assert.equal(e1.message, 'GraphQL: Railway refused the request');
  assert.equal(e1.cause, undefined);
  assert.equal(describeFailure(e1), 'provisioning failed at a Railway or HTTP request; no value or API response is logged.');
  let calls = 0;
  const bad = railwayGql('tok', async () => { calls++; return new Response(`upstream said ${V1}`, { status: 502 }); });
  const e2 = await triggerWithRetry(() => bad('mutation{x}'), { sleep: async () => {} }).catch((e) => e);
  assert.equal(e2.message, 'network: request failed');
  assert.equal(calls, 1, 'an ambiguous failure is not retried');
  const lost = railwayGql('tok', async () => { throw new Error(`socket ${V1}`); });
  assert.equal((await lost('{x}').catch((e) => e)).message, 'network: request failed');
  const ok = railwayGql('tok', async (url, init) => {
    assert.equal(url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(init.headers['Project-Access-Token'], 'tok');
    return new Response(JSON.stringify({ data: { y: 1 } }), { status: 200 });
  });
  assert.deepEqual(await ok('{y}'), { y: 1 });
  const http = httpClient(async (url, init) => {
    assert.equal(init.redirect, 'error');
    return new Response(url.endsWith('/json') ? '{"a":1}' : 'plain', { status: 201 });
  });
  assert.deepEqual(await http.getJson('https://x.test/json'), { status: 201, body: { a: 1 } });
  assert.deepEqual(await http.send('https://x.test/text', { method: 'POST' }), { status: 201, body: null });
  assert.equal(describeFailure(new ProvisionRefusal('x')), 'refused: x');
  assert.equal(describeFailure(new StageFailure('y')), 'failed: y');
});

test('an unknown stage is refused before any Railway request', async () => {
  const w = world();
  const r = await run(w, 'all', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
  assert.match(r.error.message, /stage must be one of callers, identity, finalize/);
  assert.equal(w.events.length, 0);
});

// The CLI itself, as the workflow runs it. fetch is replaced before the tool loads, so the tool
// cannot reach Railway or GitHub from here even if its refusal were removed.
test('the CLI refuses an applied run outside the master workflow before any request', () => {
  const tool = fileURLToPath(new URL('../tools/identity-introspection-provision.mjs', import.meta.url));
  const noNetwork = 'data:text/javascript,globalThis.fetch=async()=>{throw new Error("no network in this test")}';
  const cli = (env) => spawnSync(process.execPath, ['--import', noNetwork, tool], {
    env: { PATH: process.env.PATH, RAILWAY_PROJECT_TOKEN: 'not-a-token', STAGE: 'callers', ...env }, encoding: 'utf8',
  });
  for (const [env, message] of [
    [{ APPLY: 'true' }, 'refused: apply runs only from the master workflow (identity-introspection-provision.yml); a dry run works locally'],
    [{ APPLY: 'true', GITHUB_REF: 'refs/heads/master' }, 'refused: apply runs only from the master workflow (identity-introspection-provision.yml); a dry run works locally'],
    [{ APPLY: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature' }, 'refused: this runs only from master'],
    [{ APPLY: 'true', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/master', GITHUB_WORKFLOW_REF: 'markjspivey-xwisee/interego/.github/workflows/other.yml@refs/heads/master' },
      'refused: apply runs only from the master workflow (identity-introspection-provision.yml); a dry run works locally'],
  ]) {
    const r = cli(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.equal(r.stderr.trim(), message, JSON.stringify(env));
    assert.equal(r.stdout, '', 'nothing ran');
  }
});

// ── unit tables ───────────────────────────────────────────────────────────────

test('planStage, usableSecret, newSecret and cliRefusal', () => {
  const st = (relay, gate, identity, more = {}) => ({
    relay: { stored: relay, running: false }, 'css-gate': { stored: gate, running: false },
    identity: { stored: identity, running: false, openStored: true, openRunning: true, ...more },
  });
  assert.deepEqual(planStage('callers', st(undefined, '', undefined), { generate: () => V1 }).writes.map((w) => [w.service, w.value]), [['relay', V1], ['css-gate', V1]]);
  assert.deepEqual(planStage('callers', st(undefined, undefined, undefined)).writes.map((w) => Object.hasOwn(w, 'value')), [false, false]);
  assert.deepEqual(planStage('callers', st(V1, V1, V2)).notes.length, 1);
  assert.equal(planStage('callers', st(V1, V1, V2)).identityEqual, 'no');
  assert.deepEqual(planStage('identity', st(V1, V1, undefined)).writes, [{ service: 'identity', op: 'upsert', name: SECRET_VAR, value: V1 }]);
  assert.deepEqual(planStage('identity', st(V1, V1, V1)).writes, []);
  assert.throws(() => planStage('identity', st(V1, V2, undefined)), /different values/);
  assert.deepEqual(planStage('finalize', st(V1, V1, V1)).writes, [{ service: 'identity', op: 'delete', name: OPEN_VAR }]);
  assert.deepEqual(planStage('finalize', st(V1, V1, V1, { openStored: false })).writes, []);
  assert.throws(() => planStage('finalize', st(V1, V1, undefined)), /run stage=identity first/);
  assert.throws(() => planStage('finalize', st(V1, V1, V2)), /run stage=identity first/);
  assert.throws(() => planStage('nonsense', st(V1, V1, V1)), ProvisionRefusal);

  assert.equal(usableSecret(V1), true);
  assert.equal(usableSecret('x'.repeat(31)), false);
  assert.equal(usableSecret(`${V1}\n`), false);
  assert.equal(usableSecret(`${V1.slice(0, 32)} ${V1.slice(32)}`), false);
  assert.equal(usableSecret(undefined), false);

  assert.equal(newSecret((n) => Buffer.alloc(n, 0xab)), 'ab'.repeat(32));
  assert.match(newSecret(), /^[0-9a-f]{64}$/);
  assert.notEqual(newSecret(), newSecret());

  const env = { RAILWAY_PROJECT_TOKEN: 't', STAGE: 'callers' };
  const WORKFLOW = 'markjspivey-xwisee/interego/.github/workflows/identity-introspection-provision.yml';
  const master = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/master', GITHUB_WORKFLOW_REF: `${WORKFLOW}@refs/heads/master` };
  assert.equal(cliRefusal(env), null, 'a local dry run');
  assert.equal(cliRefusal({ ...env, APPLY: 'false' }), null, 'a local dry run, said explicitly');
  assert.equal(cliRefusal({ ...env, ...master }), null);
  assert.equal(cliRefusal({ ...env, ...master, APPLY: 'true' }), null, 'an applied run from the master workflow');
  // Only this workflow, whose concurrency group keeps two runs apart, may apply.
  for (const ref of [undefined, '', 'markjspivey-xwisee/interego/.github/workflows/deploy-railway.yml@refs/heads/master',
    `${WORKFLOW}@refs/heads/feature`, `${WORKFLOW}@refs/tags/v1`, `x/${WORKFLOW}@refs/heads/master`]) {
    assert.match(cliRefusal({ ...env, ...master, APPLY: 'true', GITHUB_WORKFLOW_REF: ref }), /apply runs only from the master workflow \(identity-introspection-provision\.yml\)/, `GITHUB_WORKFLOW_REF=${ref}`);
    assert.equal(cliRefusal({ ...env, ...master, GITHUB_WORKFLOW_REF: ref }), null, `a dry run, GITHUB_WORKFLOW_REF=${ref}`);
  }
  assert.match(cliRefusal({ ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature' }), /only from master/);
  assert.match(cliRefusal({ ...env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature', APPLY: 'true' }), /only from master/);
  for (const ref of ['refs/heads/master', 'refs/heads/feature', undefined]) {
    assert.match(cliRefusal({ ...env, APPLY: 'true', GITHUB_REF: ref }), /apply runs only from the master workflow/, `local apply, GITHUB_REF=${ref}`);
  }
  assert.match(cliRefusal({ STAGE: 'callers' }), /RAILWAY_PROJECT_TOKEN/);
  assert.match(cliRefusal({ ...env, STAGE: 'all' }), /STAGE must be one of/);
  assert.deepEqual([...STAGES], ['callers', 'identity', 'finalize']);
  assert.deepEqual([...CALLERS], ['relay', 'css-gate']);
});

// ── static checks ─────────────────────────────────────────────────────────────

test('the tool cannot write a value anywhere but Railway', () => {
  const src = readFileSync(new URL('../tools/identity-introspection-provision.mjs', import.meta.url), 'utf8');
  for (const forbidden of [/child_process/, /writeFile/, /appendFile/, /GITHUB_OUTPUT/, /GITHUB_ENV/, /GITHUB_STEP_SUMMARY/]) {
    assert.doesNotMatch(src, forbidden);
  }
});

test('the workflow is dispatch-only, master-only, and has no output channel', () => {
  const yml = readFileSync(new URL('../.github/workflows/identity-introspection-provision.yml', import.meta.url), 'utf8');
  const on = yml.slice(yml.indexOf('\non:'), yml.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch:/);
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'workflow_run:', 'workflow_call:']) assert.equal(on.includes(trigger), false, trigger);
  assert.match(yml, /github\.ref == 'refs\/heads\/master'/);
  for (const option of STAGES) assert.match(yml, new RegExp(`- ${option}\\b`));
  assert.match(yml, /secrets\.RAILWAY_PROJECT_TOKEN/);
  for (const forbidden of ['GITHUB_OUTPUT', 'GITHUB_ENV', 'GITHUB_STEP_SUMMARY', 'set -x', 'upload-artifact']) {
    assert.equal(yml.includes(forbidden), false, forbidden);
  }
});
