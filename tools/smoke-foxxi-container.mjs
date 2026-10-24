#!/usr/bin/env node
/** Build-time startup proof against the actual packaged modules, never a live pod. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const port = 6080;
const build = 'foxxi-container-startup-smoke';
// Deliberately do not inherit credentials or deployment configuration.
const child = spawn(process.execPath, ['--import', 'tsx', 'applications/foxxi-content-intelligence/bridge/server.ts'], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, NODE_ENV: 'test', NODE_NO_WARNINGS: '1', PORT: String(port),
    FOXXI_LRS_BACKEND: 'memory', FOXXI_TENANT_POD_URL: 'http://127.0.0.1:9/container-smoke/',
    FOXXI_AUTHORITATIVE_SOURCE: 'did:web:container-smoke.test',
    FOXXI_BRIDGE_PRIVATE_KEY: '0x' + '11'.repeat(32), FOXXI_ADMIN_KEY_SEED: 'synthetic-container-smoke-seed',
    BRIDGE_DEPLOYMENT_URL: `http://127.0.0.1:${port}`, FOXXI_AUDIENCE: 'both', INTEREGO_BUILD_SHA: build },
});
let output = '', exited = false;
const capture = chunk => { output = (output + chunk.toString()).slice(-32768); };
child.stdout.on('data', capture); child.stderr.on('data', capture);
child.once('exit', () => { exited = true; });
const ended = once(child, 'exit');
try {
  const deadline = Date.now() + 60000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (exited) throw new Error('Foxxi entrypoint exited before health: ' + output);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.status, 'ok'); assert.equal(health.build, build);
        healthy = true; break;
      }
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await delay(100);
  }
  if (!healthy) throw new Error('Foxxi container health timed out: ' + output);
  // The route is registered after the entrypoint's complete static import graph loads.
  const affordances = await fetch(`http://127.0.0.1:${port}/affordances`, { signal: AbortSignal.timeout(2000) });
  assert.equal(affordances.status, 200);
  assert.ok((await affordances.text()).length > 100);
  // Exercise the packaged entrypoint's middleware and actual generated graphs.
  // An isolated route fixture cannot detect transport fields injected here.
  const base = `http://127.0.0.1:${port}`;
  const discovery = await fetch(base + '/i2idlx/capabilities', { signal: AbortSignal.timeout(2000) });
  assert.equal(discovery.status, 200);
  const capabilities = await discovery.json();
  const callCheck = async (name, payload, expectedStatus = 200) => {
    const control = capabilities.checkOperations[name];
    assert.equal(control.method, 'POST'); assert.equal(new URL(control.href).origin, base);
    const response = await fetch(control.href, { method: control.method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-container-smoke-token' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, expectedStatus, name + ' must pass the actual HTTP middleware');
    const packet = await response.json();
    assert.equal(packet.sampling_performed, false); assert.equal(packet.writes_performed, false);
    assert.ok(!JSON.stringify(packet).includes('synthetic-container-smoke-token'));
    return packet;
  };
  const record = 'urn:example:container-smoke:lrs';
  const graph = `<${record}> <https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx#isClassifiedBy> <https://id.i2idl.org/concepts/learning-record-store-lrs> .`;
  const classified = await callCheck('classifier', { graph_content: graph });
  assert.equal(classified.execution, 'deterministic-read-only');
  assert.ok(classified.result.types.some(row => row.subject === record));
  assert.deepEqual(classified.result.clashes, []);
  const validated = await callCheck('shacl', { graph_content: graph });
  assert.equal(validated.result.conforms, true); assert.equal(validated.result.validation_applicable, true);
  assert.deepEqual(validated.evidence.targeted_nodes, [record]);
  assert.ok(validated.evidence.applied_targets.some(row => row.focus === record));
  const peer = await callCheck('peerTerm', { iri: 'https://purl.org/ctdl/terms/Credential' });
  assert.equal(peer.result.confirmed_in_snapshot, true); assert.equal(peer.evidence.network_fetch_performed, false);
  // This build proof runs with --network=none: a source outage must be 503, not
  // a 400 caused by middleware metadata or a fabricated successful comparison.
  const source = await callCheck('sourceVersion', {}, 503);
  assert.equal(source.status, 'unavailable'); assert.equal(source.result, undefined);
  console.log(JSON.stringify({ containerStartupSmoke: 'passed', health: true, affordances: true,
    semanticHttp: { classifier: true, shacl: true, peerTerm: true, sourceVersionUnavailable: true },
    actualEntrypoint: true, backend: 'memory', productionDurabilityTest: false }));
} finally {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
  await ended; clearTimeout(force);
}
