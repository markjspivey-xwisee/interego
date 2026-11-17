/**
 * css-gate: without GUEST_POD_OPERATOR_MODE=enforce the operator-bearer rule for a guest's pod is
 * SHADOW: the write it would refuse goes on as before, and /healthz says which mode is running.
 * (The refusals themselves are guest-pod-operator-writes.test.mjs, which runs in enforce.)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Pool } from 'undici';
import { listenLoopback } from './loopback.mjs';

process.env.WRITE_SECRET = 'operator-fixture';
process.env.CSS_INTERNAL_URL = 'http://guest-storage-shadow.invalid';
process.env.CSS_HOST_HEADER = 'storage.example';
process.env.PUBLIC_BASE_URL = 'https://gate.example';
process.env.CSS_GATE_AUTOSTART = '0';
process.env.RELAY_VERIFY_URL = '';
process.env.IDENTITY_URL = '';
delete process.env.GUEST_POD_OPERATOR_MODE;

const { server, _setUpstreamPool } = await import('../server.mjs');

const pod = `u-try-guest-${'c'.repeat(32)}`;
const stored = [];
const upstream = await listenLoopback(createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  if (req.method === 'GET' && req.url === `/${pod}/auth-methods.jsonld`) {
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify({ userId: pod, walletAddresses: [], webAuthnCredentials: [], didKeys: [], deletedAt: '2031-01-01' })); return;
  }
  stored.push(`${req.method} ${req.url}`);
  res.writeHead(201); res.end('stored');
}));
const pool = new Pool(upstream.base, { connections: 2 });
_setUpstreamPool(process.env.CSS_INTERNAL_URL, pool);
const gate = await listenLoopback(server);
after(async () => { await gate.close(); await pool.close(); await upstream.close(); });

test('in shadow, a write into a closed guest pod is logged and still written', async () => {
  const warned = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { warned.push(String(chunk)); return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true; };
  try {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${gate.base}/${pod}/records/a.json`, { method: 'PUT', headers: { Authorization: 'Bearer operator-fixture', 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 201);
    }
  } finally { process.stderr.write = write; }
  assert.deepEqual(stored, [`PUT /${pod}/records/a.json`, `PUT /${pod}/records/a.json`]);
  const lines = warned.filter(l => l.includes('[guest-pod-operator][shadow]'));
  assert.equal(lines.length, 1, 'once per pod and reason');
  assert.match(lines[0], /would refuse 410 guest_pod_closed/);
});

test('/healthz names the mode', async () => {
  const body = await (await fetch(`${gate.base}/healthz`)).json();
  assert.equal(body.guestPodOperatorWrites?.mode, 'shadow');
});
