/**
 * POST /tokens/verify in each of its three modes, and the budgets its callers count against.
 *
 * The route answers whether a token is live, and for whom. Its callers (the relay and css-gate)
 * send `Authorization: Bearer <IDENTITY_INTROSPECTION_SECRET>` whenever they hold that variable.
 * The server runs in one of three modes, read once at startup:
 *   - enforced: IDENTITY_INTROSPECTION_SECRET is set. Only a caller presenting it is answered;
 *     ALLOW_OPEN_INTROSPECTION is ignored (it is kept as the rollback).
 *   - open: no secret, ALLOW_OPEN_INTROSPECTION=1. Anyone is answered, with a startup warning.
 *   - disabled: neither. Everyone gets 401.
 * GET /health reports the mode and whether ALLOW_OPEN_INTROSPECTION is set, and nothing about
 * the secret's value.
 *
 * A caller presenting the right bearer counts against its own per-address budget
 * ('introspection', 600 a minute) and not against the 'tokens' budget it used to share with
 * /tokens, /register-agent, /tokens/me/sign-out-everywhere, /users/me/delete and /agents/me.
 * Every other request still counts against 'tokens' before it is answered, and an address that
 * has used its 60 gets 429 even with the right bearer, so a guess past the 60th learns nothing.
 *
 * Three servers (one per mode), plus one per row of VALUE_TABLE for the header-value warning
 * test, run as child processes over one stand-in pod server, as in
 * auth-methods-rate-limit.test.ts. Callers are told apart by X-Forwarded-For (trust proxy 1).
 *
 * Run:
 *   node --test --test-timeout=120000 --import tsx tests/token-introspection-routes.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { closeServer, stopChild } from './teardown.js';

const ALICE = 'u-pk-aaaaaaaaaaaa';
// A fixed value with letters in it, so the upper-cased copy below is a different string.
const SECRET = '3f9c1a7be04d2c68a5f1e9b7d3c02a4e6b8f0d1c3a5e7f9b2d4c6a8e0f1b3d5c';
const now = new Date().toISOString();
const pods = new Map<string, Record<string, unknown>>([[ALICE, {
  userId: ALICE, name: ALICE, walletAddresses: [], didKeys: [],
  webAuthnCredentials: [{ id: `cred-${ALICE}`, publicKey: 'AA', counter: 0, createdAt: now }],
}]]);

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(req.method === 'HEAD' ? undefined
      : `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...pods.keys()].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET' && pods.has(m[1]!)) {
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify(pods.get(m[1]!)));
    return;
  }
  if (req.method === 'PUT' || req.method === 'DELETE') { res.writeHead(201).end(); return; }
  res.writeHead(404).end();
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}

const signingKey = crypto.randomBytes(32);

/** A token as issueToken signs it. */
function token(userId: string): string {
  const b64 = Buffer.from(JSON.stringify({
    userId, agentId: `mcp-client-${userId}`, scope: 'ReadWrite', issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), epoch: 0,
  }), 'utf8').toString('base64url');
  return `cg2_${b64}.${crypto.createHmac('sha256', signingKey).update(b64).digest('base64url')}`;
}

interface Server { child: ChildProcess; base: string; output: () => string }

let podServer: http.Server;
let podBase = '';
const servers: Server[] = [];

async function startIdentity(extraEnv: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'ALLOW_OPEN_INTROSPECTION', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL',
    'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `${podBase}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: signingKey.toString('base64'), JANITOR_INTERVAL_MS: '0', ...extraEnv,
  });
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout!.on('data', d => { out += String(d); });
  child.stderr!.on('data', d => { out += String(d); });
  const server: Server = { child, base, output: () => out };
  servers.push(server);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`identity server exited ${child.exitCode}:\n${out}`);
    try {
      const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      if ((health['accountIndex'] as { complete: boolean }).complete) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${out}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return server;
}

let enforced: Server;
let open: Server;
let disabled: Server;

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  podBase = `http://127.0.0.1:${(podServer.address() as net.AddressInfo).port}`;
  [enforced, open, disabled] = await Promise.all([
    startIdentity({ IDENTITY_INTROSPECTION_SECRET: SECRET, ALLOW_OPEN_INTROSPECTION: '1' }),
    startIdentity({ ALLOW_OPEN_INTROSPECTION: '1' }),
    startIdentity({}),
  ]);
});

after(async () => {
  await Promise.all(servers.map(s => stopChild(s.child)));
  await closeServer(podServer);
});

interface Answer { status: number; body: Record<string, unknown>; text: string; retryAfter: string | null }

async function verify(server: Server, ip: string, body: unknown, authorization?: string): Promise<Answer> {
  const r = await fetch(`${server.base}/tokens/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(authorization !== undefined ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  return { status: r.status, body: parsed, text, retryAfter: r.headers.get('retry-after') };
}

async function health(server: Server): Promise<{ body: Record<string, unknown>; text: string }> {
  const text = await (await fetch(`${server.base}/health`)).text();
  return { body: JSON.parse(text) as Record<string, unknown>, text };
}

const RIGHT = `Bearer ${SECRET}`;

// ── enforced ──────────────────────────────────────────────────────────────────

test('enforced: the startup log says so, and never prints the secret', () => {
  const out = enforced.output();
  assert.match(out, /Introspection: ENFORCED/);
  assert.match(out, /ignored while the secret is set/);
  assert.doesNotMatch(out, /OPEN mode/);
  assert.doesNotMatch(out, /cannot be sent intact/);
  assert.equal(out.includes(SECRET), false);
  assert.equal(out.includes(SECRET.slice(0, 12)), false);
});

test('enforced: /health reports the mode and the rollback flag, and nothing of the value', async () => {
  const h = await health(enforced);
  assert.equal(h.body['introspection'], 'enforced');
  assert.equal(h.body['allowOpenIntrospection'], true);
  assert.equal(h.text.includes(SECRET), false);
  assert.equal(h.text.includes(SECRET.slice(0, 12)), false);
});

test('enforced: no bearer, another scheme, or an empty bearer is "introspection bearer required"', async () => {
  // `Bearer ` alone arrives as `Bearer`: fetch and Node's parser drop trailing whitespace.
  for (const [i, authorization] of [undefined, `Basic ${SECRET}`, `bearer ${SECRET}`, 'Bearer '].entries()) {
    const r = await verify(enforced, `198.51.100.${10 + i}`, { token: token(ALICE) }, authorization);
    assert.equal(r.status, 401, `${String(authorization)}: ${r.text}`);
    assert.equal(r.body['error'], 'introspection bearer required', String(authorization));
    assert.equal(r.text.includes(ALICE), false);
  }
});

test('enforced: a wrong value is "introspection bearer rejected"', async () => {
  for (const [i, authorization] of [`Bearer ${SECRET.toUpperCase()}`, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`,
    `Bearer  ${SECRET}`].entries()) {
    const r = await verify(enforced, `198.51.100.${30 + i}`, { token: token(ALICE) }, authorization);
    assert.equal(r.status, 401, `case ${i}: ${r.text}`);
    assert.equal(r.body['error'], 'introspection bearer rejected', `case ${i}`);
    assert.equal(r.text.includes(ALICE), false);
  }
});

test('enforced: the right bearer is answered', async () => {
  const ip = '198.51.100.50';
  const ok = await verify(enforced, ip, { token: token(ALICE) }, RIGHT);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body['valid'], true);
  assert.equal(ok.body['userId'], ALICE);
  const missing = await verify(enforced, ip, {}, RIGHT);
  assert.equal(missing.status, 400);
  assert.equal(missing.body['error'], 'token is required');
  const unknown = await verify(enforced, ip, { token: 'probe' }, RIGHT);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body['valid'], false);
  assert.equal(unknown.body['reason'], 'Token not found');
});

test('enforced: authorized introspection does not use the shared tokens budget', async () => {
  const ip = '203.0.113.20';
  for (let i = 0; i < 100; i += 25) {
    const batch = await Promise.all(Array.from({ length: 25 }, () => verify(enforced, ip, { token: 'probe' }, RIGHT)));
    assert.deepEqual(batch.map(r => r.status), Array(25).fill(200));
  }
  // /agents/me shares 'tokens'. With 100 counted there it would be 429; it is 401 (no bearer).
  const me = await fetch(`${enforced.base}/agents/me`, { headers: { 'X-Forwarded-For': ip } });
  await me.arrayBuffer();
  assert.equal(me.status, 401);
});

test('enforced: an address that has used its 60 gets 429 with the right bearer too', async () => {
  const ip = '203.0.113.30';
  for (let i = 1; i <= 60; i++) {
    const r = await verify(enforced, ip, { token: 'probe' });
    assert.equal(r.status, 401, `attempt ${i}: ${r.text}`);
  }
  // The 61st request: the right bearer and a wrong one get the same answer, so the guess that
  // would be the 61st teaches nothing.
  const right = await verify(enforced, ip, { token: 'probe' }, RIGHT);
  assert.equal(right.status, 429, right.text);
  assert.equal(right.text.includes('Token not found'), false);
  const wrong = await verify(enforced, ip, { token: 'probe' }, 'Bearer not-the-secret');
  assert.equal(wrong.status, 429);
  assert.match(String(wrong.body['detail']), /60 requests in a 60s window for tokens on this IP/);
  assert.ok(Number(wrong.retryAfter) > 0);
  const me = await fetch(`${enforced.base}/agents/me`, { headers: { 'X-Forwarded-For': ip } });
  await me.arrayBuffer();
  assert.equal(me.status, 429);
});

test('enforced: authorized introspection has a budget of its own, 600 a minute', async () => {
  const ip = '203.0.113.40';
  for (let i = 0; i < 600; i += 100) {
    const batch = await Promise.all(Array.from({ length: 100 }, () => verify(enforced, ip, { token: 'probe' }, RIGHT)));
    assert.equal(batch.filter(r => r.status === 200).length, 100, `batch at ${i}: ${batch.map(r => r.status).join(',')}`);
  }
  const over = await verify(enforced, ip, { token: 'probe' }, RIGHT);
  assert.equal(over.status, 429, over.text);
  assert.ok(Number(over.retryAfter) > 0);
  assert.match(String(over.body['detail']), /600 requests in a 60s window for introspection/);
});

// The startup warning about a value no caller can present: it fires exactly for the values a
// caller building `Authorization: Bearer ${value}` with fetch (as the relay and css-gate do)
// cannot get answered, and for no value that works. A trailing space or tab is dropped on the
// way; an ASCII control character other than TAB (U+0000-U+001F or U+007F), or a character
// above U+00FF, makes fetch throw. Leading and interior whitespace and other Latin-1 characters,
// the C1 controls U+0080-U+009F among them, arrive intact. css-gate's
// identity-introspection-value-warning.test.mjs runs the same table against the gate.
const HEX = SECRET;
const VALUE_TABLE: ReadonlyArray<readonly [string, string, 'answered' | 'rejected' | 'unsendable']> = [
  ['a leading space', ` ${HEX}`, 'answered'],
  ['an interior space', `${HEX.slice(0, 32)} ${HEX.slice(32)}`, 'answered'],
  ['an interior tab', `${HEX.slice(0, 32)}\t${HEX.slice(32)}`, 'answered'],
  ['a Latin-1 character', `${HEX}\u00e9`, 'answered'],
  ['a C1 control character', `${HEX.slice(0, 32)}\u0085${HEX.slice(32)}`, 'answered'],
  ['a trailing space', `${HEX} `, 'rejected'],
  ['a trailing tab', `${HEX}\t`, 'rejected'],
  ['a control character', `${HEX.slice(0, 32)}\u0001${HEX.slice(32)}`, 'unsendable'],
  ['a character above U+00FF', `${HEX}\u0100`, 'unsendable'],
];

test('enforced: the header-value warning fires exactly for the values no caller can present', async () => {
  const started = await Promise.all(VALUE_TABLE.map(([, value]) => startIdentity({ IDENTITY_INTROSPECTION_SECRET: value })));
  for (const [i, [why, value, expected]] of VALUE_TABLE.entries()) {
    const server = started[i]!;
    const out = server.output();
    assert.match(out, /Introspection: ENFORCED/, why);
    const warned = /cannot be sent intact in a header, so no caller can present it/.test(out);
    let outcome: string;
    try {
      const r = await verify(server, `192.0.2.${10 + i}`, { token: 'probe' }, `Bearer ${value}`);
      outcome = r.status === 200 ? 'answered' : r.body['error'] === 'introspection bearer rejected' ? 'rejected' : `status ${r.status}`;
    } catch {
      outcome = 'unsendable';
    }
    assert.equal(outcome, expected, why);
    assert.equal(warned, expected !== 'answered', `${why}: warned=${warned}, outcome=${outcome}`);
    assert.equal(out.includes(HEX.slice(0, 12)), false, `${why}: the log shows part of the value`);
  }
});

// ── open ──────────────────────────────────────────────────────────────────────

test('open: the startup warning names both callers', () => {
  const out = open.output();
  assert.match(out, /OPEN mode/);
  assert.match(out, /relay and css-gate/);
  assert.doesNotMatch(out, /Introspection: ENFORCED/);
});

test('open: /health says open', async () => {
  const h = await health(open);
  assert.equal(h.body['introspection'], 'open');
  assert.equal(h.body['allowOpenIntrospection'], true);
});

test('open: answered without a header', async () => {
  const ip = '198.51.100.70';
  const unknown = await verify(open, ip, { token: 'probe' });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body['valid'], false);
  const ok = await verify(open, ip, { token: token(ALICE) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body['valid'], true);
  assert.equal(ok.body['userId'], ALICE);
});

test('open: every request counts against the tokens budget, with or without a bearer', async () => {
  const ip = '198.51.100.80';
  for (let i = 1; i <= 60; i++) {
    const r = await verify(open, ip, { token: 'probe' }, i % 2 ? RIGHT : undefined);
    assert.equal(r.status, 200, `attempt ${i}`);
  }
  const r = await verify(open, ip, { token: 'probe' }, RIGHT);
  assert.equal(r.status, 429);
  assert.match(String(r.body['detail']), /for tokens on this IP/);
});

// ── disabled ──────────────────────────────────────────────────────────────────

test('disabled: the startup log says FAIL-CLOSED, and /health says disabled', async () => {
  assert.match(disabled.output(), /Introspection: FAIL-CLOSED/);
  const h = await health(disabled);
  assert.equal(h.body['introspection'], 'disabled');
  assert.equal(h.body['allowOpenIntrospection'], false);
});

test('disabled: 401 for everyone, bearer or not', async () => {
  for (const [i, authorization] of [undefined, RIGHT].entries()) {
    const r = await verify(disabled, `198.51.100.${90 + i}`, { token: token(ALICE) }, authorization);
    assert.equal(r.status, 401);
    assert.match(String(r.body['error']), /token introspection is disabled/);
  }
});
