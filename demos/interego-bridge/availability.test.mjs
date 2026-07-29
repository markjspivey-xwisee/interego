#!/usr/bin/env node
/**
 * interego-bridge — it must advertise only what it can actually run.
 *
 * ★ WHY. A production audit found this bridge listing all 23 tools flat while
 * reporting `pod: "(pod not configured)"` and `walletAddress: null` alongside, as
 * separate facts a reader was left to correlate. So it advertised descriptor
 * publishing with no pod to publish to, and signing with no key to sign with.
 *
 * Booting without either is DELIBERATE — the governance, PGSL, ZK and attestation
 * demos are genuinely pod-free. The defect was never the degradation; it was not
 * saying so. And the pod path made it worse by leaking a Node internal
 * (`The "string" argument must be of type string…`) where the wallet path already
 * refused readably.
 *
 * This boots the REAL server with production's exact configuration — no pod, no
 * wallet — and exercises it over its own MCP transport. A test that stubbed the
 * config would prove nothing about the case that shipped broken.
 *
 * Run: node demos/interego-bridge/availability.test.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 6099;
let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

// Explicitly UNSET, to reproduce what production runs.
const env = { ...process.env, PORT: String(PORT) };
delete env.INTEREGO_DEFAULT_POD_URL;
delete env.BRIDGE_WALLET_KEY;

const proc = spawn('npx', ['tsx', 'demos/interego-bridge/server.ts'], {
  env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
});
/**
 * Kill the whole process TREE, not just the child we spawned.
 *
 * With `shell: true` on Windows, `proc.kill()` kills the shell and orphans the node
 * process actually holding the port. This test left exactly such an orphan behind
 * once; the next run then measured that stale server instead of a fresh one.
 */
const kill = () => {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
    }
  } catch { /* already gone */ }
};
process.on('exit', kill);
process.on('SIGINT', () => { kill(); process.exit(130); });

const B = `http://127.0.0.1:${PORT}`;

// ★ REFUSE TO RUN AGAINST SOMEONE ELSE'S SERVER. A stale process from an earlier
// run held this port once, so the spawn silently failed to bind and every assertion
// was made against PRE-FIX code — three of them failed for a reason that had nothing
// to do with the code under test, which is the most expensive kind of red. Better to
// stop with a clear message than to report a verdict about the wrong process.
const squatter = await fetch(`${B}/`).catch(() => null);
if (squatter) {
  console.error(`
Port ${PORT} is already serving. This test must boot its OWN`);
  console.error('bridge or its results describe a process it did not configure. Stop');
  console.error(`whatever is on ${PORT} and re-run.
`);
  process.exit(2);
}

let up = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = await fetch(`${B}/`).catch(() => null);
  if (r?.ok) { up = true; break; }
}
check('the bridge boots with no pod and no wallet', up);
if (!up) { kill(); process.exit(1); }

console.log('\ninterego-bridge: advertise only what is runnable');

const root = await (await fetch(`${B}/`)).json();
check('it reports having no pod', String(root.pod).includes('not configured'), String(root.pod));
check('it reports having no wallet', root.walletAddress === null, String(root.walletAddress));

// The heart of it: the split must exist and be non-empty on both sides.
check('unavailable tools are NAMED, not silently listed as available',
  Array.isArray(root.unavailableTools) && root.unavailableTools.length > 0,
  JSON.stringify(root.unavailableTools));
check('...each with a reason a reader can act on',
  (root.unavailableTools ?? []).every(u => /pod|wallet/i.test(u.reason)),
  JSON.stringify(root.unavailableTools));
// The inverse of what this once asserted, and deliberately so. An unavailable tool
// DOES appear in the list — it exists — and is ALSO named as unavailable. Omitting
// it would misreport the surface, and a client that later saw it appear would have
// no way to explain the change.
check('...and each unavailable tool still appears in the list, because it EXISTS',
  (root.unavailableTools ?? []).every(u => root.tools.includes(u.tool)),
  JSON.stringify((root.unavailableTools ?? []).map(u => u.tool)));
// ★ THE TOTAL IS THE TOTAL. An earlier revision made toolCount the RUNNABLE count,
// which hid four tools that genuinely exist and disagreed with tools/list on the
// same process. Existence and availability are different facts; report both.
check('toolCount counts every tool that EXISTS',
  root.toolCount === root.tools.length,
  `${root.toolCount} vs ${root.tools.length}`);
check('...and the runnable count is reported separately',
  typeof root.runnableCount === 'number' && root.runnableCount < root.toolCount,
  `runnable ${root.runnableCount} of ${root.toolCount}`);
check('...and they reconcile: runnable + unavailable === total',
  root.runnableCount + (root.unavailableTools ?? []).length === root.toolCount,
  `${root.runnableCount} + ${(root.unavailableTools ?? []).length} !== ${root.toolCount}`);
check('pod-free tools are still advertised (degradation is partial, not total)',
  root.runnableCount > 10, String(root.runnableCount));

// ★ BOTH DOORS MUST TELL THE SAME STORY. A JSON-RPC agent and a hypermedia agent
// asking about the same process must not get different answers — the drift this
// whole line of work exists to remove.
const listed = await (await fetch(`${B}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
})).json();
const mcpTools = listed?.result?.tools ?? [];
check('MCP tools/list lists every tool that exists, same as the root document',
  mcpTools.length === root.toolCount, `${mcpTools.length} vs ${root.toolCount}`);
const flagged = mcpTools.filter(t => t.annotations?.unavailable);
check('...and flags exactly the ones the root calls unavailable',
  flagged.length === (root.unavailableTools ?? []).length,
  `${flagged.length} vs ${(root.unavailableTools ?? []).length}`);
check('...naming the same reason, not a second wording of it',
  flagged.every(t => (root.unavailableTools ?? []).some(
    u => u.tool === t.name && u.reason === t.annotations.unavailableReason)),
  JSON.stringify(flagged.map(t => t.name)));
check('...and a runnable tool carries no unavailable marker',
  mcpTools.some(t => t.name === 'protocol.zk_commit' && !t.annotations?.unavailable));

// ── Behaviour over the real transport
const call = async (name, args) => {
  const r = await fetch(`${B}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return r.json();
};

const pod = await call('protocol.publish_descriptor', { graph_iri: 'urn:x', graph_content: 'x' });
const podMsg = pod?.error?.message ?? '';
check('a pod-backed tool REFUSES readably', /no pod/i.test(podMsg), podMsg.slice(0, 90));
// The exact leak that shipped. Named so a regression fails loudly rather than subtly.
check('...and never leaks a Node internal',
  !/must be of type string|Buffer|ArrayBuffer|undefined is not/i.test(podMsg), podMsg.slice(0, 90));
check('...naming the env var that would enable it',
  /INTEREGO_DEFAULT_POD_URL/.test(podMsg), podMsg.slice(0, 90));

const sig = await call('protocol.sign_message', { message: 'hi' });
check('a wallet-backed tool refuses readably', /no wallet/i.test(sig?.error?.message ?? ''),
  String(sig?.error?.message).slice(0, 80));

const zk = await call('protocol.zk_commit', { value: 0.9 });
check('a pod-free tool still returns a REAL result',
  /"ok": true/.test((zk?.result?.content ?? [{}])[0]?.text ?? ''),
  JSON.stringify(zk).slice(0, 100));

kill();
if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nThe bridge advertises only what it can run.\n');
process.exit(0);
