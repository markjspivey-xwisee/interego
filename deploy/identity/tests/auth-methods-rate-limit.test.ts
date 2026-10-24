/**
 * GET /auth-methods/me is limited per verified account, not per IP.
 *
 * The relay reads a user's registered signing keys with that user's bearer for every
 * client-signed write, and every one of those reads arrives from the relay's address. Under
 * the per-IP auth-enroll limiter (30/min) every relay user shared one budget, and the live
 * client-signature check failed with "registered signing keys could not be read (429)".
 *
 * server.ts is started as a child process against a stand-in pod server, as in
 * surface-agent-restore-routes.test.ts. Callers are told apart by X-Forwarded-For, which the
 * server honours for one hop (trust proxy 1), as it does behind the platform's ingress.
 *
 * Run:
 *   node --test --import tsx tests/auth-methods-rate-limit.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';

const ALICE = 'u-pk-aaaaaaaaaaaa';
const BOB = 'u-pk-bbbbbbbbbbbb';
const CAROL = 'u-pk-cccccccccccc';
const now = new Date().toISOString();
const pods = new Map<string, Record<string, unknown>>([ALICE, BOB, CAROL].map(userId => [userId, {
  userId, name: userId, walletAddresses: [], didKeys: [],
  webAuthnCredentials: [{ id: `cred-${userId}`, publicKey: 'AA', counter: 0, createdAt: now }],
}]));

// The per-account cap and the per-IP cap on failed attempts the server sets.
const PER_USER = 120;
const FAILURES_PER_IP = 30;
const RELAY_IP = '203.0.113.10';

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
let podServer: http.Server;
let identity: ChildProcess;
let base = '';
let output = '';

/** A token as issueToken signs it. */
function token(userId: string): string {
  const b64 = Buffer.from(JSON.stringify({
    userId, agentId: `mcp-client-${userId}`, scope: 'ReadWrite', issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), epoch: 0,
  }), 'utf8').toString('base64url');
  return `cg2_${b64}.${crypto.createHmac('sha256', signingKey).update(b64).digest('base64url')}`;
}

async function readKeys(ip: string, bearer?: string): Promise<Response> {
  const r = await fetch(`${base}/auth-methods/me?purpose=client-signature`, {
    headers: { 'X-Forwarded-For': ip, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
  });
  await r.arrayBuffer();
  return r;
}

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  const podPort = (podServer.address() as net.AddressInfo).port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: signingKey.toString('base64'), ALLOW_OPEN_INTROSPECTION: '1', JANITOR_INTERVAL_MS: '0',
  });
  identity = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  identity.stdout!.on('data', d => { output += String(d); });
  identity.stderr!.on('data', d => { output += String(d); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (identity.exitCode !== null) throw new Error(`identity server exited ${identity.exitCode}:\n${output}`);
    try {
      const health = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      if ((health['accountIndex'] as { complete: boolean }).complete) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

after(async () => {
  identity?.kill('SIGTERM');
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

test('users behind one IP each get their own budget', async () => {
  // Alice uses her whole minute's budget from the relay's address...
  for (let i = 1; i <= PER_USER; i++) {
    const r = await readKeys(RELAY_IP, token(ALICE));
    assert.equal(r.status, 200, `Alice's read ${i}:\n${output}`);
  }
  // ...and Bob, from the same address, still reads his.
  assert.equal((await readKeys(RELAY_IP, token(BOB))).status, 200);
});

test('one user over the limit gets 429 with Retry-After, and only that user', async () => {
  const r = await fetch(`${base}/auth-methods/me?purpose=client-signature`, {
    headers: { 'X-Forwarded-For': RELAY_IP, Authorization: `Bearer ${token(ALICE)}` },
  });
  assert.equal(r.status, 429);
  const wait = Number(r.headers.get('retry-after'));
  assert.ok(Number.isInteger(wait) && wait > 0 && wait <= 60, `Retry-After: ${r.headers.get('retry-after')}`);
  const body = await r.json() as Record<string, unknown>;
  assert.equal(body['error'], 'rate_limit_exceeded');
  assert.match(String(body['detail']), /for this account/);
  // From another address too: the budget is Alice's, not the address's.
  assert.equal((await readKeys('198.51.100.1', token(ALICE))).status, 429);
  assert.equal((await readKeys(RELAY_IP, token(CAROL))).status, 200);
});

test('verified reads leave the address\'s enrollment budget alone', async () => {
  // POST /siwe/nonce shares the per-IP auth-enroll bucket the read used to count against.
  const r = await fetch(`${base}/siwe/nonce`, { method: 'POST', headers: { 'X-Forwarded-For': RELAY_IP } });
  assert.equal(r.status, 200, await r.text());
});

test('requests without a valid token are still limited per IP, before verification', async () => {
  const attacker = '192.0.2.66';
  const forged = `cg2_${Buffer.from('{}').toString('base64url')}.not-a-signature`;
  for (let i = 1; i <= FAILURES_PER_IP; i++) {
    const r = await readKeys(attacker, i % 2 ? forged : undefined);
    assert.equal(r.status, 401, `attempt ${i}`);
  }
  const limited = await fetch(`${base}/auth-methods/me`, { headers: { 'X-Forwarded-For': attacker, Authorization: `Bearer ${forged}` } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  // The address is refused before its next token is looked at, even a valid one.
  assert.equal((await readKeys(attacker, token(BOB))).status, 429);
  // Other addresses are unaffected, and so is the relay's: its verified reads used none of it.
  assert.equal((await readKeys(RELAY_IP, forged)).status, 401);
  assert.equal((await readKeys(RELAY_IP, token(BOB))).status, 200);
});
