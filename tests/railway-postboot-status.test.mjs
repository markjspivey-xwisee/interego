import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../tools/railway-redeploy.mjs', import.meta.url));
const tag = 'a'.repeat(40);

// Execute the actual CLI and its real service/deploy modules. Only the external
// GraphQL transport and elapsed time are replaced; an unhandled request fails.
const preload = `
import assert from 'node:assert/strict';
let elapsed = 0, deploymentReads = 0, postBootReads = 0, bootReads = 0;
let triggers = 0, writes = 0;
const scenario = process.env.REDEPLOY_FIXTURE;
Date.now = () => elapsed;
globalThis.setTimeout = (fn, ms) => {
  elapsed += ms;
  queueMicrotask(fn);
  return 0;
};
const ok = data => new Response(JSON.stringify({ data }), {
  headers: { 'content-type': 'application/json' },
});
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://backboard.railway.com/graphql/v2');
  assert.equal(init.headers['Project-Access-Token'], 'fixture-only');
  const { query, variables } = JSON.parse(init.body);
  if (query.includes('projectToken')) return ok({ projectToken: { projectId: 'project', environmentId: 'env' } });
  if (query.includes('project(id:')) return ok({ project: { services: { edges: [{ node: { id: 'css-service', name: 'css' } }] } } });
  if (query.includes('domains(projectId:')) return ok({ domains: { serviceDomains: [], customDomains: [] } });
  if (query.includes('serviceInstance(serviceId:')) return ok({
    serviceInstance: {
      source: { image: 'ghcr.io/markjspivey-xwisee/interego-css-pgsl:' + 'a'.repeat(40) },
      numReplicas: 1, overlapSeconds: 0, drainingSeconds: null,
      latestDeployment: { id: 'this-deployment', status: 'SUCCESS' },
    },
  });
  if (query.includes('serviceInstanceUpdate(')) {
    writes++;
    return ok({ serviceInstanceUpdate: true });
  }
  if (query.includes('serviceInstanceDeployV2(')) {
    triggers++;
    return ok({ serviceInstanceDeployV2: 'this-deployment' });
  }
  if (query.includes('deployments(first:')) return ok({ deployments: { edges: [{ node: { id: 'previous-deployment' } }] } });
  if (query.includes('deploymentLogs(')) {
    assert.equal(variables.id, 'this-deployment');
    if (variables.filter === null) return ok({ deploymentLogs: [{ message: 'fixture tail' }] });
    assert.equal(variables.filter, JSON.stringify('Listening to server at'));
    bootReads++;
    const restarted = scenario === 'restarted' || (scenario === 'transient-then-restarted' && bootReads > 1);
    return ok({ deploymentLogs: Array.from({ length: restarted ? 2 : 1 }, () => ({ message: 'Listening to server at http://localhost:3456/' })) });
  }
  if (query.includes('deployment(id:') && query.includes('status')) {
    assert.equal(variables.id, 'this-deployment');
    deploymentReads++;
    if (deploymentReads === 1) return ok({ deployment: { status: 'SUCCESS' } });
    postBootReads++;
    if (scenario === 'unavailable' || ((scenario === 'transient' || scenario === 'transient-then-restarted') && postBootReads === 1)) {
      return new Response('upstream connection error', { status: 503 });
    }
    if (scenario === 'graphql-transient' && postBootReads === 1) {
      return new Response(JSON.stringify({ errors: [{ message: 'temporarily unavailable' }] }));
    }
    return ok({ deployment: { status: scenario === 'crashed' ? 'CRASHED' : 'SUCCESS' } });
  }
  throw new Error('Unexpected fixture request: ' + query);
};
process.on('exit', () => {
  console.log('FIXTURE_METRICS ' + JSON.stringify({ elapsed, postBootReads, bootReads, triggers, writes }));
});
`;

function run(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'railway-postboot-'));
  try {
    const hook = join(dir, 'fixture.mjs');
    writeFileSync(hook, preload);
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, 'css', tag], {
      env: { ...process.env, RAILWAY_PROJECT_TOKEN: 'fixture-only', REDEPLOY_FIXTURE: scenario },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    const output = child.stdout + child.stderr;
    const match = child.stdout.match(/^FIXTURE_METRICS (.+)$/m);
    assert.ok(match, output);
    const metrics = JSON.parse(match[1]);
    assert.equal(metrics.triggers, 1, 'verification must never retrigger deployment: ' + output);
    assert.equal(metrics.writes, 1, 'verification must never repeat source mutation: ' + output);
    return { code: child.status, output, metrics };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a transient control-plane read after one boot proof retries and verifies SUCCESS', () => {
  for (const scenario of ['transient', 'graphql-transient']) {
    const result = run(scenario);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.metrics.postBootReads, 2);
    assert.equal(result.metrics.bootReads, 2, 'retry must recheck whether another boot appeared');
    assert.match(result.output, /deployment still SUCCESS — verified/);
    assert.doesNotMatch(result.output, /container did not stay up/);
  }
});

test('perpetually unavailable post-boot status fails closed within the existing four-minute deadline', () => {
  const result = run('unavailable');
  assert.equal(result.code, 1, result.output);
  assert.ok(result.metrics.postBootReads > 1);
  assert.ok(result.metrics.elapsed >= 240000 && result.metrics.elapsed <= 253000, result.output);
  assert.match(result.output, /booted, but its status could not be verified within 4 minutes/);
  assert.doesNotMatch(result.output, /deployment still SUCCESS — verified/);
  assert.doesNotMatch(result.output, /never printed/);
});

test('a genuine CRASHED state after boot proof still fails immediately', () => {
  const result = run('crashed');
  assert.equal(result.code, 1, result.output);
  assert.equal(result.metrics.postBootReads, 1);
  assert.match(result.output, /deployment is now CRASHED/);
  assert.doesNotMatch(result.output, /deployment still SUCCESS — verified/);
});

test('multiple boot lines still fail, including a restart observed after a transient status read', () => {
  for (const scenario of ['restarted', 'transient-then-restarted']) {
    const result = run(scenario);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /The container RESTARTED/);
    assert.doesNotMatch(result.output, /deployment still SUCCESS — verified/);
  }
});
