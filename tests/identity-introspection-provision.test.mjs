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
  newSecret, usableSecret, cliRefusal, planStage, runStage, describeFailure, railwayGql, httpClient, maskCommand,
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
      return { serviceInstance: { source: { image: pins[svc] }, numReplicas: Object.hasOwn(o.numReplicas ?? {}, svc) ? o.numReplicas[svc] : 1,
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
// A caller whose health does not answer, or does not report identityVerifyAuth, may as well be
// sealed and working, or deleted without a deploy: the text names each case and states none (tested
// further down).
const UNREAD_CSS_GATE = /^identity holds IDENTITY_INTROSPECTION_SECRET and Railway shows it unset on css-gate, whose health does not say whether it presents it \(no answer, or no identityVerifyAuth field\)\. If css-gate runs a sealed value, nothing is wrong: rerun when its health answers\. If css-gate's variable was deleted without a deploy, its next deploy \(an auto-deploy included\) ships it unset and identity refuses it: restore the variable in Railway before anything deploys css-gate\. If a Railway Rollback took css-gate past the deployment stage=callers made, identity refuses it: in Railway, roll css-gate back again to the deployment that was active before that rollback, and do not delete relay's copy\./;
for (const [why, opts, otherwise, said] of [
  ['is pinned to a mutable tag', { pins: { 'css-gate': 'ghcr.io/markjspivey-xwisee/interego-css-gate:latest' } }, /css-gate is not pinned to ghcr\.io\/markjspivey-xwisee\/interego-css-gate:<40-hex sha>/],
  ['serves a build other than its pin', { serving: { 'css-gate': 'e5'.repeat(20) } }, /css-gate is pinned to b2b2b2b2 but serving e5e5e5e5; a redeploy would change running code/],
  ['serves an image without the health fields', { healthOverride: (svc, body) => (svc === 'css-gate' ? { status: 'ok', build: body.build } : undefined) }, /css-gate serves an image without the introspection health fields; deploy master first/, UNREAD_CSS_GATE],
  ['does not answer its health check', { healthStatus: { 'css-gate': 503 } }, /css-gate: GET https:\/\/css-gate\.example\.test\/healthz did not answer 200 with JSON/, UNREAD_CSS_GATE],
]) {
  for (const stage of STAGES) {
    test(`${stage}: a caller rolled back to an older image that ${why} is told to roll back again`, async () => {
      const w = world({ ...opts, stored: { relay: { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1 } } });
      const r = await run(w, stage, { apply: true });
      assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
      assert.match(r.error.message, said ?? /^identity holds IDENTITY_INTROSPECTION_SECRET and css-gate does not, so identity refuses it now\. .*roll css-gate back again to the deployment that was active before that rollback, and do not delete relay's copy\./);
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
    identity: { stored: V1, running: false, openStored: true, openListed: true, openRunning: true } };
  assert.throws(() => planStage('callers', st), /relay does not, so identity refuses it from its next deploy\. .*roll relay back again .*do not delete css-gate's copy/);
});

// Railway shows the variable unset, so a change without a deploy can only have been a deletion,
// whose next deploy (an auto-deploy included) ships it unset: the text must not call that harmless.
const SEALED_CSS_GATE = "css-gate runs with a value Railway does not show (sealed, or deleted without a deploy); resolve by hand. If it was deleted, css-gate's next deploy (an auto-deploy included) ships it unset, and identity refuses a caller without it whenever it enforces: restore the variable in Railway before anything deploys css-gate";

// After finalize the docs allow sealing a caller's variable: Railway then shows it unset while the
// caller runs it, and identity accepts it. A refusal about what another service serves must not
// turn that into "identity refuses css-gate, roll it back", which would take a working deployment
// away: the sealed refusal goes first, as it does when nothing else is wrong.
for (const [why, opts] of [
  ['a sealed css-gate', { stored: { ...both, identity: { [SECRET_VAR]: V1 } }, sealed: ['css-gate'] }],
  ['a css-gate variable deleted without a deploy', { stored: { relay: { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1 } }, running: { 'css-gate': { [SECRET_VAR]: V1 } } }],
]) {
  for (const [problem, more] of [
    ['nothing else wrong', {}],
    ['the relay pinned to a mutable tag', { pins: { relay: 'ghcr.io/markjspivey-xwisee/interego-relay:latest' } }],
    ['identity serving a build other than its pin', { serving: { identity: 'e5'.repeat(20) } }],
  ]) {
    test(`${why}, with ${problem}: every stage gives the sealed refusal, not Rollback advice`, async () => {
      for (const stage of STAGES) {
        const w = world({ ...opts, ...more });
        const r = await run(w, stage, { apply: true });
        assert.ok(r.error instanceof ProvisionRefusal, `${stage}: ${r.error?.message ?? 'no refusal'}`);
        assert.equal(r.error.message, SEALED_CSS_GATE, stage);
        assert.equal(writeCount(w), 0);
        assert.deepEqual(deploysTriggered(w), []);
        assertNoValue(r, V1);
      }
    });
  }
}

// identity running 'enforced' while Railway shows its variable unset, and both callers without
// it: identity refuses them now, so the roll-back-again text comes first and names the seal.
test('callers refuses when identity runs enforced but Railway shows it unset (sealed)', async () => {
  const w = world({ stored: { identity: { [SECRET_VAR]: V1 } }, sealed: ['identity'] });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /^identity holds IDENTITY_INTROSPECTION_SECRET and relay and css-gate do not, so identity refuses them now\. /);
  assert.match(r.error.message, /\(identity also runs with a value Railway does not show: sealed, or deleted without a deploy\.\) Otherwise resolve by hand; a new value would not match identity's$/);
  assert.equal(writeCount(w), 0);
});

// After finalize, with css-gate's variable sealed (Railway shows it unset, css-gate runs it and
// identity accepts it), css-gate's own health failing to answer, or answering without
// identityVerifyAuth, must not turn into "identity refuses it now, roll it back": the tool cannot
// tell a sealed css-gate from a rolled-back one, or one deleted without a deploy, so it names each
// and states none.
const finalized = { relay: { [SECRET_VAR]: V1 }, 'css-gate': { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } };
for (const [why, opts] of [
  ['does not answer', { healthStatus: { 'css-gate': 503 } }],
  ['answers without identityVerifyAuth', { healthOverride: (svc, body) => (svc === 'css-gate' ? { ...body, identityVerifyAuth: undefined } : undefined) }],
]) {
  test(`a sealed css-gate whose health ${why}: every stage names each case and states none`, async () => {
    for (const stage of STAGES) {
      for (const apply of [false, true]) {
        const w = world({ stored: finalized, sealed: ['css-gate'], ...opts });
        const r = await run(w, stage, { apply });
        assert.ok(r.error instanceof ProvisionRefusal, `${stage}: ${r.error?.message ?? 'no refusal'}`);
        assert.match(r.error.message, UNREAD_CSS_GATE, stage);
        assert.doesNotMatch(r.error.message, /refuses it now|so identity refuses/, stage);
        // The only roll-back instruction is the one conditioned on a Rollback having happened.
        assert.equal(r.error.message.match(/roll css-gate back/g).length, 1, stage);
        assert.equal(writeCount(w), 0);
        assert.deepEqual(deploysTriggered(w), []);
        assertNoValue(r, V1);
      }
    }
  });
}

// With Railway showing the variable unset, a value "changed without a deploy" can only have been
// deleted, and the service's next deploy (an auto-deploy from a master push included) ships it
// unset. Only a sealed value is harmless, so no refusal may call the deleted case harmless:
// css-gate deleted without a deploy while identity enforces, with its health not answering (the
// text names the three cases) or answering (the sealed refusal), and identity deleted without a
// deploy, whose next deploy runs without the secret.
for (const [why, healthOpts, said] of [
  ['does not answer', { healthStatus: { 'css-gate': 503 } }, UNREAD_CSS_GATE],
  ['answers', {}, SEALED_CSS_GATE],
]) {
  test(`a css-gate variable deleted without a deploy, health that ${why}: every stage says its next deploy is refused`, async () => {
    for (const stage of STAGES) {
      for (const apply of [false, true]) {
        const w = world({ stored: { relay: { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } }, running: { 'css-gate': { [SECRET_VAR]: V1 } }, ...healthOpts });
        const r = await run(w, stage, { apply });
        assert.ok(r.error instanceof ProvisionRefusal, `${stage}: ${r.error?.message ?? 'no refusal'}`);
        if (typeof said === 'string') assert.equal(r.error.message, said, stage);
        else assert.match(r.error.message, said, stage);
        assert.match(r.error.message, /next deploy \(an auto-deploy included\) ships it unset,? and identity refuses/, stage);
        assert.match(r.error.message, /restore the variable in Railway before anything deploys css-gate/, stage);
        assert.doesNotMatch(r.error.message, /changed without a deploy/, stage);
        assert.equal(writeCount(w), 0);
        assert.deepEqual(deploysTriggered(w), []);
        assertNoValue(r, V1);
      }
    }
    // What the text warns about: css-gate's next deploy runs what Railway stores, and identity,
    // which enforces V1, then refuses it.
    const w = world({ stored: { relay: { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } }, running: { 'css-gate': { [SECRET_VAR]: V1 } } });
    w.running['css-gate'] = { ...w.stored['css-gate'] };
    await w.http.getJson('https://css-gate.example.test/x/auth-methods.jsonld', { headers: { Authorization: 'Bearer introspection-rollout-probe-0123456789abcdef' } });
    assert.deepEqual(w.counters, { accepted: 0, refused: 1, other: 0 });
  });
}

for (const [why, identityStored, next] of [
  ['finalized', { [OPEN_VAR]: undefined }, /If it was deleted, identity's next deploy \(an auto-deploy included\) runs without it and leaves introspection disabled, which refuses both callers: restore the variable, or set ALLOW_OPEN_INTROSPECTION=1, in Railway before anything deploys identity$/],
  ['with ALLOW_OPEN_INTROSPECTION=1 stored', {}, /If it was deleted, identity's next deploy \(an auto-deploy included\) runs without it and opens introspection again \(ALLOW_OPEN_INTROSPECTION=1 is stored\)$/],
]) {
  test(`identity's variable deleted without a deploy, ${why}: every stage says what its next deploy does`, async () => {
    for (const stage of STAGES) {
      const w = world({ stored: { ...both, identity: identityStored }, running: { identity: { [SECRET_VAR]: V1 } } });
      const r = await run(w, stage, { apply: true });
      assert.ok(r.error instanceof ProvisionRefusal, `${stage}: ${r.error?.message ?? 'no refusal'}`);
      assert.match(r.error.message, /^identity runs with a value Railway does not show \(sealed, or deleted without a deploy\); resolve by hand\. /, stage);
      assert.match(r.error.message, next, stage);
      assert.equal(writeCount(w), 0);
      assert.deepEqual(deploysTriggered(w), []);
      assertNoValue(r, V1);
    }
  });
}

test('the text for a caller whose health says nothing follows how many there are and whether one is sealed', () => {
  const st = { relay: { stored: undefined, running: null }, 'css-gate': { stored: undefined, running: null },
    identity: { stored: undefined, running: true, openStored: false, openListed: false, openRunning: false } };
  const bothUnread = /: identity holds IDENTITY_INTROSPECTION_SECRET and Railway shows it unset on relay and css-gate, whose health does not say whether they present it .* If relay and css-gate run a sealed value, nothing is wrong: rerun when their health answers\. If the variable was deleted from either without a deploy, that caller's next deploy \(an auto-deploy included\) ships it unset and identity refuses it: restore the variable in Railway before anything deploys it\. If a Railway Rollback took relay and css-gate past the deployment stage=callers made, identity refuses them: in Railway, roll relay and css-gate back again to the deployment that was active before that rollback\. \(identity also runs with a value Railway does not show: sealed, or deleted without a deploy\.\) Otherwise resolve by hand$/;
  for (const stage of ['identity', 'finalize']) assert.throws(() => planStage(stage, st), bothUnread);
  // One caller lost by its health, the other unread: the lost one is named as refused, and the
  // unread one is not called refused.
  const mixed = { ...st, 'css-gate': { stored: undefined, running: false }, identity: { ...st.identity, stored: V1, running: null } };
  assert.throws(() => planStage('finalize', mixed), /: identity holds IDENTITY_INTROSPECTION_SECRET and css-gate does not, so identity refuses it now or from its next deploy\. .*roll css-gate back again to the deployment that was active before that rollback\. relay's health does not say whether it presents the value; check it once it does\. Otherwise resolve by hand$/);
});

// A sealed relay or identity must not hide a caller that identity refuses now: css-gate rolled
// back past stage=callers stores and runs nothing, and its health says so. Every stage gives the
// roll-back-again text, with a note naming the sealed service.
for (const sealedSvc of ['relay', 'identity']) {
  test(`a sealed ${sealedSvc} with css-gate rolled back past stage=callers: every stage says to roll css-gate back again`, async () => {
    for (const stage of STAGES) {
      for (const apply of [false, true]) {
        const w = world({ stored: { relay: { [SECRET_VAR]: V1 }, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } }, sealed: [sealedSvc] });
        const r = await run(w, stage, { apply });
        assert.ok(r.error instanceof ProvisionRefusal, `${stage}: ${r.error?.message ?? 'no refusal'}`);
        assert.match(r.error.message, /^identity holds IDENTITY_INTROSPECTION_SECRET and css-gate does not, so identity refuses it now\. A Railway Rollback past the deployment stage=callers made unsets the variable: in Railway, roll css-gate back again to the deployment that was active before that rollback, and do not delete relay's copy\./, stage);
        assert.match(r.error.message, new RegExp(`\\(${sealedSvc} also runs with a value Railway does not show: sealed, or deleted without a deploy\\.\\)`), stage);
        assert.equal(writeCount(w), 0);
        assert.deepEqual(deploysTriggered(w), []);
        assertNoValue(r, V1);
      }
    }
  });
}

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

// Identity opens only when ALLOW_OPEN_INTROSPECTION is exactly '1' (deploy/identity/server.ts), so
// a stored '0', '' or 'true' is no rollback, even while identity still runs '1' from an earlier
// deploy: deleting the secret would then leave it disabled. The stage refuses to write, as it does
// when the variable is missing.
for (const other of ['0', '', 'true']) {
  test(`identity refuses to write while ALLOW_OPEN_INTROSPECTION is stored as ${JSON.stringify(other)} and identity runs '1'`, async () => {
    for (const apply of [false, true]) {
      const w = world({ stored: { ...both, identity: { [OPEN_VAR]: other } }, running: { identity: { [OPEN_VAR]: '1' } } });
      const r = await run(w, 'identity', { apply });
      assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
      assert.match(r.error.message, /^identity does not hold ALLOW_OPEN_INTROSPECTION=1, this stage's rollback: /);
      assert.equal(writeCount(w), 0);
      assert.deepEqual(deploysTriggered(w), []);
    }
  });
}

test('the report says whether ALLOW_OPEN_INTROSPECTION is stored as 1, as another value, or not at all', async () => {
  for (const [open, said] of [['1', /ALLOW_OPEN_INTROSPECTION=1;/], ['0', /ALLOW_OPEN_INTROSPECTION set to a value other than 1;/], [undefined, /ALLOW_OPEN_INTROSPECTION unset;/]]) {
    const w = world({ stored: { ...both, identity: { [OPEN_VAR]: open } }, running: { identity: { [OPEN_VAR]: '1' } } });
    const r = await run(w, 'callers');
    assert.equal(r.error, undefined, r.error?.message);
    assert.match(r.text, said);
  }
});

// The warning beside the identity stage's check: only while the rollback is not stored as 1.
// Stored but not running yet is fine, because the rollback's own deploy picks it up.
for (const [why, identity, warns] of [
  ['not stored', { stored: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined } }, true],
  ['stored as another value', { stored: { [SECRET_VAR]: V1, [OPEN_VAR]: '0' } }, true],
  ['stored as 1 but not running yet', { stored: { [SECRET_VAR]: V1 }, running: { [OPEN_VAR]: undefined } }, false],
]) {
  test(`identity stage, ALLOW_OPEN_INTROSPECTION ${why}: the rollback warning is ${warns ? '' : 'not '}printed`, async () => {
    const w = world({ stored: { ...both, identity: identity.stored }, running: { identity: identity.running ?? {} } });
    const r = await run(w, 'identity');
    assert.equal(r.error, undefined, r.error?.message);
    assert[warns ? 'match' : 'doesNotMatch'](r.text, /warning: identity does not hold ALLOW_OPEN_INTROSPECTION=1, so deleting the secret to roll back would leave introspection disabled/);
  });
}

// ALLOW_OPEN_INTROSPECTION=1 was stored when the run began, and the deployment no longer runs it
// (changed in Railway meanwhile): the stage must not call the rollback "still set".
test('an identity deploy that no longer runs ALLOW_OPEN_INTROSPECTION=1 fails the stage and says to set it first', async () => {
  const w = world({ stored: both });
  const gql = async (q, v) => {
    const answer = await w.gql(q, v);
    if (q.includes('variableUpsert') && v.input.serviceId === 'id-identity') w.stored.identity[OPEN_VAR] = '0';
    return answer;
  };
  const r = await run({ ...w, gql }, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.equal(w.running.identity[SECRET_VAR], V1);
  assert.match(r.error.message, /^identity enforces IDENTITY_INTROSPECTION_SECRET but no longer runs ALLOW_OPEN_INTROSPECTION=1, which it stored when this run began, so the rollback is gone/);
  assert.match(r.error.message, /To reopen instead, set ALLOW_OPEN_INTROSPECTION=1 on identity, then delete IDENTITY_INTROSPECTION_SECRET from identity, and deploy identity again\.$/);
  assert.doesNotMatch(r.error.message, /still set/);
  assertNoValue(r, V1);
});

// The same deployment, but identity's health fails on the last reading of the window (or on
// every one): the "still set" text would send the operator to delete the secret alone, which
// leaves identity disabled. A reading that showed the rollback gone counts even when later ones
// fail, and with no reading either way the text says "still set" only if Railway still stores it.
for (const [why, failsAt, openChanged, said] of [
  ['the last reading fails', 170_000, true, /^identity enforces IDENTITY_INTROSPECTION_SECRET but no longer runs ALLOW_OPEN_INTROSPECTION=1, which it stored when this run began, so the rollback is gone/],
  ['every reading fails', 0, true, /^identity reached SUCCESS but still reports no health; /],
  ['every reading fails, and Railway still stores ALLOW_OPEN_INTROSPECTION=1', 0, false, /^identity reached SUCCESS but still reports no health; /],
]) {
  test(`an identity deploy whose rollback may be gone, when ${why}, says "still set" only when it is`, async () => {
    const w = world({ stored: both });
    const gql = async (q, v) => {
      const answer = await w.gql(q, v);
      if (openChanged && q.includes('variableUpsert') && v.input.serviceId === 'id-identity') w.stored.identity[OPEN_VAR] = '0';
      return answer;
    };
    const http = {
      ...w.http,
      async getJson(url, opts) {
        const after = w.successAt.identity === undefined ? -1 : w.clock.t - w.successAt.identity;
        if (url === 'https://identity.example.test/health' && after >= failsAt) return { status: 503, body: null };
        return w.http.getJson(url, opts);
      },
    };
    const r = await run({ ...w, gql, http }, 'identity', { apply: true });
    assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
    assert.match(r.error.message, said);
    if (openChanged) {
      assert.match(r.error.message, /To reopen instead, set ALLOW_OPEN_INTROSPECTION=1 on identity, then delete IDENTITY_INTROSPECTION_SECRET from identity, and deploy identity again\.$/);
      assert.doesNotMatch(r.error.message, /still set/);
    } else {
      assert.match(r.error.message, /To reopen instead, delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION=1 is still set\), and deploy identity again\.$/);
    }
    assertNoValue(r, V1);
  });
}

for (const [side, opts, said] of [
  ['the relay', { relayInconclusive: true }, /accepts relay: inconclusive; accepts css-gate: accepted/],
  ['css-gate', { gateInconclusive: true }, /accepts relay: accepted; accepts css-gate: inconclusive/],
]) {
  test(`identity refuses when the check before the write is not accepted for ${side}`, async () => {
    const w = world({ stored: both, ...opts });
    const r = await run(w, 'identity', { apply: true });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? 'no refusal');
    assert.match(r.error.message, /does not accept both callers now/);
    assert.match(r.text, said);
    assert.equal(writeCount(w), 0);
  });
}

test('an identity write Railway does not confirm says the secret may be stored on identity', async () => {
  const w = world({ stored: both, upsertResult: false });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.match(r.error.message, /^Railway did not confirm writing IDENTITY_INTROSPECTION_SECRET on identity\. IDENTITY_INTROSPECTION_SECRET may be stored on identity, and the next identity deploy/);
  assert.deepEqual(deploysTriggered(w), []);
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
  assert.match(r.error.message, /delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION=1 is still set\) and redeploy identity/);
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

// The value changed in Railway on all three services without a deploy: all three store V1 and
// run V2. The check before the delete passes (what runs matches), the new identity container
// enforces V1, and both callers present V2. finalize waits out the overlap, checks again, and
// fails with the after-finalize rollback instead of reporting done. The same holds when the
// delete was made earlier and finalize only deploys.
for (const [why, identity] of [
  ['deletes and deploys', { [SECRET_VAR]: V1 }],
  ['only deploys (deleted earlier, still running)', { [SECRET_VAR]: V1, [OPEN_VAR]: undefined }],
]) {
  test(`finalize that ${why} checks both callers after the deploy and fails while identity refuses them`, async () => {
    const w = world({
      stored: { ...both, identity },
      running: { relay: { [SECRET_VAR]: V2 }, 'css-gate': { [SECRET_VAR]: V2 }, identity: { [SECRET_VAR]: V2, [OPEN_VAR]: '1' } },
      overlapSeconds: 30,
    });
    const r = await run(w, 'finalize', { apply: true });
    assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
    assert.match(r.text, /check: identity accepts relay: accepted; accepts css-gate: accepted/);
    assert.match(r.text, /check after the deploy: identity accepts relay: rejected; accepts css-gate: rejected/);
    assert.equal(r.error.message, `identity refuses the relay and css-gate: the ${SECRET_VAR} those callers run with is not identity's. Roll back: set ${OPEN_VAR}=1 on identity, then delete ${SECRET_VAR} from identity and deploy identity, and check that identity's GET /health reports introspection: "open" on two readings in a row.`);
    assert.doesNotMatch(r.text, /done: deployed/);
    const after = w.probes.filter((p) => p.at > w.successAt.identity);
    assert.ok(Math.min(...after.map((p) => p.at)) - w.successAt.identity >= 40_000, 'probed inside the overlap');
    assertNoValue(r, V1, V2);
  });
}

test('finalize: an inconclusive check after the deploy fails the stage with the manual checks', async () => {
  const w = world({ stored: enforcing });
  let calls = 0;
  const http = { ...w.http, async send(url, opts) { calls++; return calls === 1 ? w.http.send(url, opts) : { status: 502, body: null }; } };
  const r = await run({ ...w, http }, 'finalize', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.match(r.error.message, /^identity enforces, but the check is inconclusive for the relay\. Check by hand: .* If either fails: Roll back: set ALLOW_OPEN_INTROSPECTION=1 on identity, then delete/);
});

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

test('finalize removes ALLOW_OPEN_INTROSPECTION stored as a value other than 1', async () => {
  const w = world({ stored: { ...enforcing, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: '0' } } });
  const r = await run(w, 'finalize', { apply: true });
  assert.equal(r.error, undefined, r.error?.message);
  assert.deepEqual(deletes(w).map((d) => [d.serviceId, d.name]), [['id-identity', OPEN_VAR]]);
  assert.equal(Object.hasOwn(w.stored.identity, OPEN_VAR), false);
  assert.deepEqual(r.summary.deployed, ['identity']);
});

// Once the variable is gone from Railway, a failed deploy cannot bring it back: the text says it
// is removed, whether this run deleted it or an earlier one did.
for (const [why, identity] of [
  ['after this run deleted it', { stored: { [SECRET_VAR]: V1 } }],
  ['after an earlier run deleted it', { stored: { [SECRET_VAR]: V1, [OPEN_VAR]: undefined }, running: { [OPEN_VAR]: '1' } }],
]) {
  test(`a failed finalize deploy ${why} says ALLOW_OPEN_INTROSPECTION is removed`, async () => {
    const w = world({ stored: { ...both, identity: identity.stored }, running: { identity: identity.running ?? {} }, statuses: { identity: ['DEPLOYING', 'FAILED'] } });
    const r = await run(w, 'finalize', { apply: true });
    assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
    assert.match(r.error.message, /ended FAILED\. ALLOW_OPEN_INTROSPECTION is removed from identity, which keeps enforcing the secret/);
  });
}

// ── deploy outcomes ───────────────────────────────────────────────────────────

test('a FAILED deployment fails the stage and says what is stored', async () => {
  const w = world({ stored: both, statuses: { identity: ['DEPLOYING', 'FAILED'] } });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure);
  assert.match(r.error.message, /ended FAILED\. IDENTITY_INTROSPECTION_SECRET is stored on identity, /);
  assert.match(r.error.message, /next identity deploy \(an auto-deploy included\) will enforce it\. Rerun stage=identity, or delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION=1 is still set\) to stay open\.$/);
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
  assert.match(r.error.message, /ended FAILED\. IDENTITY_INTROSPECTION_SECRET is stored on identity, .*Rerun stage=identity, or set ALLOW_OPEN_INTROSPECTION=1 on identity, then delete IDENTITY_INTROSPECTION_SECRET from identity to stay open\.$/);
  assertNoValue(r, V1);
});

test('a failed identity deploy with ALLOW_OPEN_INTROSPECTION stored as another value says to set it to 1 first', async () => {
  const w = world({
    stored: { ...both, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: '0' } },
    running: { identity: { [SECRET_VAR]: undefined, [OPEN_VAR]: '1' } },
    statuses: { identity: ['DEPLOYING', 'FAILED'] },
  });
  const r = await run(w, 'identity', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.match(r.text, /warning: identity does not hold ALLOW_OPEN_INTROSPECTION=1/);
  assert.match(r.error.message, /Rerun stage=identity, or set ALLOW_OPEN_INTROSPECTION=1 on identity, then delete IDENTITY_INTROSPECTION_SECRET from identity to stay open\.$/);
  assert.doesNotMatch(r.error.message, /still set/);
});

// The deploy request was sent and no deployment id came back: Railway may have created a
// deployment carrying the secret, which deleting the stored variable would not reach.
for (const [why, opts, failure] of [
  ['whose answer is lost', { lose: true }, /^the deploy of identity failed at a Railway or HTTP request \(network\)\. /],
  ['that returns no deployment id', { deployResult: null }, /^Railway returned no deployment id for identity\. /],
]) {
  test(`identity: a deploy request ${why} says a deployment may exist, not "to stay open"`, async () => {
    const w = world({ stored: both, ...(opts.lose ? {} : opts) });
    const gql = opts.lose
      ? async (q, v) => { const answer = await w.gql(q, v); if (q.includes('serviceInstanceDeployV2')) throw new Error('network: request failed'); return answer; }
      : w.gql;
    const r = await run({ ...w, gql }, 'identity', { apply: true });
    assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
    assert.match(r.error.message, failure);
    assert.match(r.error.message, /A deployment of identity may have been created with IDENTITY_INTROSPECTION_SECRET stored \(this run sent a deploy request and got no deployment id back\)/);
    assert.match(r.error.message, /Rerun stage=identity once no identity deployment is in flight/);
    assert.match(r.error.message, /To reopen instead, delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION=1 is still set\), and deploy identity again\.$/);
    assert.doesNotMatch(r.error.message, /to stay open|next identity deploy \(an auto-deploy included\)/);
    if (opts.lose) assert.equal(w.deployments.identity[0].status, 'DEPLOYING', 'the stand-in created the deployment');
    assertNoValue(r, V1);
  });
}

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
    assert.match(r.error.message, /To reopen instead, delete IDENTITY_INTROSPECTION_SECRET from identity \(ALLOW_OPEN_INTROSPECTION=1 is still set\), and deploy identity again\.$/);
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

// The field shows the change, but on another build: not the deployment this run made.
test('health readings with the change from another build fail the stage', async () => {
  let w;
  w = world({ healthOverride: (svc, body) => (svc === 'relay' && w?.successAt.relay !== undefined ? { ...body, build: 'e5'.repeat(20) } : undefined) });
  const r = await run(w, 'callers', { apply: true });
  assert.ok(r.error instanceof StageFailure, r.error?.message ?? 'no failure');
  assert.match(r.error.message, /^relay reached SUCCESS but still reports identityVerifyAuth=true on build e5e5e5e5/);
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
  ['a value other than 1 is still listed after the delete', { deleteKeeps: true, stored: { ...enforcing, identity: { [SECRET_VAR]: V1, [OPEN_VAR]: '0' } } }, /ALLOW_OPEN_INTROSPECTION is still listed on identity after the delete/],
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
  ['an identity image without introspection', { healthOverride: (svc, body) => (svc === 'identity' ? { ...body, introspection: undefined } : undefined) }, /identity serves an image without the introspection health fields/],
  ['an identity image with an unknown introspection mode', { healthOverride: (svc, body) => (svc === 'identity' ? { ...body, introspection: 'unknown' } : undefined) }, /identity serves an image without the introspection health fields/],
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
  assert.match(r.text, /note: css-gate is set to 2 replicas \(numReplicas\), and its identityVerifyResults counters are per replica, .* can be wrong either way; stages identity and finalize refuse until css-gate runs one replica/);
  // Unset is Railway's default of one replica: no note.
  const unset = await run(world({ stored: both, numReplicas: { 'css-gate': null } }), 'callers');
  assert.doesNotMatch(unset.text, /replicas/);
});

// css-gate's identityVerifyResults counters are per replica, and the two /healthz readings around a
// probe can come from different replicas. Here replica 0 has accepted 100 and replica 1 300, the
// readings alternate, and real traffic, refused while identity refuses the gate, lands 2:1. The
// comparison then reads 'accepted' while identity refuses css-gate: the identity stage wrote and
// deployed, and finalize removed the rollback, each ending in "done" with identity refusing
// css-gate. With css-gate on more than one replica both stages refuse before any probe or write.
for (const [stage, base] of [
  // css-gate stores V1 and runs V2 (changed without a deploy); identity is open, so it accepts css-gate until it enforces V1.
  ['identity', { stored: both, running: { 'css-gate': { [SECRET_VAR]: V2 } } }],
  // identity enforces V1 and already refuses css-gate, which runs V2.
  ['finalize', { stored: { ...both, identity: { [SECRET_VAR]: V1 } }, running: { 'css-gate': { [SECRET_VAR]: V2 } } }],
]) {
  test(`${stage}: css-gate on two replicas is refused before any probe or write`, async () => {
    const w = world({ ...base, numReplicas: { 'css-gate': 2 } });
    const replicas = [{ accepted: 100, refused: 0, other: 0 }, { accepted: 300, refused: 0, other: 0 }];
    let reading = 1;
    let hit = 0;
    const refusesGate = () => Boolean(w.running.identity[SECRET_VAR]) && w.running['css-gate'][SECRET_VAR] !== w.running.identity[SECRET_VAR];
    const http = {
      ...w.http,
      async getJson(url, opts = {}) {
        const u = new URL(url);
        if (u.hostname === 'css-gate.example.test' && u.pathname === '/healthz') {
          const r = await w.http.getJson(url, opts);
          r.body.identityVerifyResults = { ...replicas[reading++ % 2] };
          return r;
        }
        if (u.hostname === 'css-gate.example.test' && u.pathname.endsWith('/auth-methods.jsonld')) {
          replicas[hit++ % 2][refusesGate() ? 'refused' : 'accepted']++;
          return { status: 401, body: { error: 'invalid bearer' } };
        }
        return w.http.getJson(url, opts);
      },
    };
    const sleep = async (ms) => {
      await w.sleep(ms);
      const k = refusesGate() ? 'refused' : 'accepted';
      replicas[0][k] += 2;
      replicas[1][k] += 1;
    };
    const r = await run({ ...w, http, sleep }, stage, { apply: true });
    assert.ok(r.error instanceof ProvisionRefusal, r.error?.message ?? `no refusal: ${r.lines.join(' | ')}`);
    assert.match(r.error.message, /^css-gate is set to 2 replicas \(numReplicas\), and its identityVerifyResults counters are per replica, so the check that identity accepts css-gate compares readings that can come from different replicas and can be wrong either way\. Run css-gate on one replica for this stage, or make this stage's checks by hand/);
    assert.equal(hit, 0, 'no probe reached css-gate');
    assert.equal(writeCount(w), 0);
    assert.deepEqual(deploysTriggered(w), []);
    assert.equal(w.stored.identity[OPEN_VAR], '1', 'the rollback is still stored');
    assertNoValue(r, V1, V2);
  });
}

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
  // A non-2xx answer whose body is JSON with `errors` is still ambiguous: not 'GraphQL:', not retried.
  let unavailableCalls = 0;
  const unavailable = railwayGql('tok', async () => { unavailableCalls++; return new Response(JSON.stringify({ errors: [{ message: `busy ${V1}` }] }), { status: 503 }); });
  const e4 = await triggerWithRetry(() => unavailable('mutation{x}'), { sleep: async () => {} }).catch((e) => e);
  assert.equal(e4.message, 'network: request failed');
  assert.equal(unavailableCalls, 1, 'a 503 with a JSON body is not retried');
  const ok = railwayGql('tok', async (url, init) => {
    assert.equal(url, 'https://backboard.railway.com/graphql/v2');
    assert.equal(init.headers['Project-Access-Token'], 'tok');
    assert.equal(init.redirect, 'error');
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

// fetch drops only Authorization across origins, so a followed 307 or 308 would carry the
// Project-Access-Token and the upsert's body, value included, to wherever Location points, and
// that origin's answer would read as Railway's.
test('the Railway client follows no redirect', async () => {
  const followed = [];
  const redirecting = railwayGql('tok', async (url, init) => {
    if (init.redirect === 'error') throw new TypeError('fetch failed');
    followed.push(init.body);
    return new Response(JSON.stringify({ data: { variableUpsert: true } }), { status: 200 });
  });
  const e = await redirecting('mutation{x}', { input: { name: SECRET_VAR, value: V1 } }).catch((x) => x);
  assert.ok(e instanceof Error, 'the redirect target answered for Railway');
  assert.equal(e.message, 'network: request failed');
  assert.deepEqual(followed, []);
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

// The runner percent-decodes a command's data (%25, %0D, %0A), so an unescaped add-mask line
// holding `%25` registers a mask for another string and leaves the stored value unmasked. The
// CLI, run as the workflow runs it with fetch replaced, escapes the value as @actions/core does.
test('the add-mask line escapes the value as the runner decodes it', () => {
  const value = `${'a'.repeat(32)}%25${'b'.repeat(8)}`;
  assert.equal(usableSecret(value), true);
  assert.equal(maskCommand(value), `::add-mask::${'a'.repeat(32)}%2525${'b'.repeat(8)}\n`);
  assert.equal(maskCommand('x%0Dy\r\nz'), '::add-mask::x%250Dy%0D%0Az\n');
  const tool = fileURLToPath(new URL('../tools/identity-introspection-provision.mjs', import.meta.url));
  const stub = `globalThis.fetch = async (url, init) => {
    const json = (b) => new Response(JSON.stringify(b), { status: 200 });
    if (String(url).startsWith('https://api.github.com/')) return json({ workflow_runs: [] });
    if (String(url) !== 'https://backboard.railway.com/graphql/v2') throw new Error('no network in this test');
    const { query } = JSON.parse(init.body);
    if (query.includes('projectToken')) return json({ data: { projectToken: ${JSON.stringify(TARGET)} } });
    if (query.includes('project(id')) return json({ data: { project: { services: { edges: ['relay', 'css-gate', 'identity'].map((name) => ({ node: { id: 'id-' + name, name } })) } } } });
    if (query.includes('variables(')) return json({ data: { variables: { ${SECRET_VAR}: ${JSON.stringify(value)} } } });
    return json({ data: {} });
  };`;
  const r = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub)}`, tool], {
    env: {
      PATH: process.env.PATH, RAILWAY_PROJECT_TOKEN: 'not-a-token', STAGE: 'callers', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/master',
      GITHUB_REPOSITORY: 'x/y', GITHUB_TOKEN: 'gh-token', GITHUB_RUN_ID: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(r.status, 1, 'the stand-in answers no domains, so the dry run refuses after reading the variables');
  const masks = r.stdout.split('\n').filter((l) => l.startsWith('::add-mask::'));
  assert.deepEqual(masks, [`::add-mask::${'a'.repeat(32)}%2525${'b'.repeat(8)}`]);
});

// The apply guard reads environment variables, so it stops accidents, not a holder of the
// token, and the add-mask line carries the value to stdout: the docs must not claim more.
test('the docs call the apply guard an accident guard and say what the add-mask line carries', () => {
  const doc = readFileSync(new URL('../deploy/identity/AUTH-ARCHITECTURE.md', import.meta.url), 'utf8');
  assert.doesNotMatch(doc, /Only this workflow on master can make the tool write/);
  assert.match(doc, /stops an accidental apply, not someone who holds `RAILWAY_PROJECT_TOKEN`/);
  const src = readFileSync(new URL('../tools/identity-introspection-provision.mjs', import.meta.url), 'utf8');
  assert.match(src, /It is not an access boundary:\n \* RAILWAY_PROJECT_TOKEN is a repository secret/);
  assert.match(src, /The one line that carries a value is the runner's\n \* add-mask command/);
});

// The tool masks the value it generates, and a stored value only when it could be the secret
// (usableSecret): masking a short string such as `1` would hide every occurrence of it in the log.
// The docs said it masks every value it reads.
test('the docs say which values are masked, and the tool masks exactly those', async () => {
  const doc = readFileSync(new URL('../deploy/identity/AUTH-ARCHITECTURE.md', import.meta.url), 'utf8');
  assert.doesNotMatch(doc, /registers each value it reads with the runner's/);
  assert.match(doc, /registers the value it generates, and each stored value it reads that could be the secret \(32 or more printable ASCII characters without spaces\), with the runner's `::add-mask::` command/);
  const short = world({ stored: { relay: { [SECRET_VAR]: 'short value' }, 'css-gate': { [SECRET_VAR]: 'short value' } } });
  const r = await run(short, 'callers', { apply: true });
  assert.ok(r.error instanceof ProvisionRefusal);
  assert.match(r.error.message, /not usable/);
  assert.deepEqual(short.masks, []);
  const usable = world({ stored: both });
  await run(usable, 'callers');
  assert.deepEqual(usable.masks, [V1]);
});

// The checks see whether identity accepts a caller, not which value it runs, and identity is open
// before stage=identity's write: a caller whose variable was changed without a deploy is found only
// by the check after the deploy (tested above as 'a caller running a stale value'). The docs say
// so, and how to rule it out; and that css-gate on more than one replica is refused.
test('the docs say what the checks cannot see', () => {
  const doc = readFileSync(new URL('../deploy/identity/AUTH-ARCHITECTURE.md', import.meta.url), 'utf8');
  assert.match(doc, /The check before the write cannot tell which value a caller runs, because an open identity accepts any: a caller whose variable was changed in Railway without a deploy runs a value other than the one this stage copies, identity refuses it once the deploy enforces, and only the check after the deploy finds that\. To rule it out beforehand, deploy any caller whose variable may have changed since its last deploy/);
  assert.match(doc, /Stages `identity` and `finalize` also refuse while css-gate is set to anything other than one replica: .* can make that check wrong either way, including reporting a refused gate as accepted\./);
  const src = readFileSync(new URL('../tools/identity-introspection-provision.mjs', import.meta.url), 'utf8');
  assert.match(src, /That check, and the one before each write, sees only whether identity accepts a caller, not\n \* which value the caller runs/);
  assert.match(src, /so stages\n \* identity and finalize refuse unless css-gate is set to one replica\./);
});

// ── unit tables ───────────────────────────────────────────────────────────────

test('planStage, usableSecret, newSecret and cliRefusal', () => {
  const st = (relay, gate, identity, more = {}) => ({
    relay: { stored: relay, running: false }, 'css-gate': { stored: gate, running: false },
    identity: { stored: identity, running: false, openStored: true, openListed: true, openRunning: true, ...more },
  });
  assert.deepEqual(planStage('callers', st(undefined, '', undefined), { generate: () => V1 }).writes.map((w) => [w.service, w.value]), [['relay', V1], ['css-gate', V1]]);
  assert.deepEqual(planStage('callers', st(undefined, undefined, undefined)).writes.map((w) => Object.hasOwn(w, 'value')), [false, false]);
  assert.deepEqual(planStage('callers', st(V1, V1, V2)).notes.length, 1);
  assert.equal(planStage('callers', st(V1, V1, V2)).identityEqual, 'no');
  assert.deepEqual(planStage('identity', st(V1, V1, undefined)).writes, [{ service: 'identity', op: 'upsert', name: SECRET_VAR, value: V1 }]);
  assert.deepEqual(planStage('identity', st(V1, V1, V1)).writes, []);
  assert.throws(() => planStage('identity', st(V1, V2, undefined)), /different values/);
  assert.deepEqual(planStage('finalize', st(V1, V1, V1)).writes, [{ service: 'identity', op: 'delete', name: OPEN_VAR }]);
  assert.deepEqual(planStage('finalize', st(V1, V1, V1, { openStored: false, openListed: false })).writes, []);
  // A value other than '1' does not open identity, but finalize still removes it.
  assert.deepEqual(planStage('finalize', st(V1, V1, V1, { openStored: false })).writes, [{ service: 'identity', op: 'delete', name: OPEN_VAR }]);
  assert.throws(() => planStage('identity', st(V1, V1, undefined, { openStored: false })), /does not hold ALLOW_OPEN_INTROSPECTION=1/);
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
