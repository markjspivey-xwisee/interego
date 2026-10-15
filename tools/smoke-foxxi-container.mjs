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
  console.log(JSON.stringify({ containerStartupSmoke: 'passed', health: true, affordances: true,
    actualEntrypoint: true, backend: 'memory', productionDurabilityTest: false }));
} finally {
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 1000); force.unref();
  await ended; clearTimeout(force);
}
