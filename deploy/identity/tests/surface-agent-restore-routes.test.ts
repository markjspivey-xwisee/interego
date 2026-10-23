/**
 * Restoring forgotten surface agents, through the routes: server.ts is started as a child
 * process against a stand-in pod server (no live pod), so its identities map is exactly what
 * the boot-time rebuild makes of the pods: the users, and one placeholder agent each. That is
 * the map after a restart, without any surface agent the relay had minted.
 *
 * The bearer tokens are minted here with the server's TOKEN_SIGNING_KEY, in its `cg2_` format,
 * as a token issued before the restart would be.
 *
 * Run:
 *   node --test --import tsx tests/surface-agent-restore-routes.test.ts
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
const CAROL = 'u-eth-cccccccccccc';
const TRY_USER = 'u-try-dddddddddddd';
const LEGACY = 'markj';
const now = new Date().toISOString();

// What each pod's auth-methods.jsonld holds. Every one has a credential, so every one loads.
const pods = new Map<string, Record<string, unknown>>([
  [ALICE, { userId: ALICE, name: 'Alice', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [{ id: 'cred-alice', publicKey: 'AA', counter: 0, createdAt: now }] }],
  [BOB, { userId: BOB, name: 'Bob', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [{ did: 'did:key:zBob', publicKeyMultibase: 'zBob', keyType: 'Ed25519VerificationKey2020', createdAt: now }] }],
  [CAROL, { userId: CAROL, name: 'Carol', walletAddresses: ['0xcccccccccccccccccccccccccccccccccccccccc'], webAuthnCredentials: [], didKeys: [] }],
  [TRY_USER, { userId: TRY_USER, name: 'Try', walletAddresses: ['0xdddddddddddddddddddddddddddddddddddddddd'], webAuthnCredentials: [], didKeys: [] }],
  [LEGACY, { userId: LEGACY, name: 'Mark', walletAddresses: ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'], webAuthnCredentials: [], didKeys: [] }],
]);

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
  if (m && req.method === 'DELETE') {
    pods.delete(m[1]!);
    res.writeHead(205).end();
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
let host = '';
let output = '';

function token(userId: string, agentId: string): string {
  const b64 = Buffer.from(JSON.stringify({
    userId, agentId, scope: 'ReadWrite', issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), epoch: 0,
  }), 'utf8').toString('base64url');
  return `cg2_${b64}.${crypto.createHmac('sha256', signingKey).update(b64).digest('base64url')}`;
}

async function get(path: string, bearer?: string): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {});
  const body = await r.text();
  return { status: r.status, body, json: () => JSON.parse(body) as Record<string, unknown> };
}

async function post(path: string, body: unknown, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

async function agentCount(): Promise<number> {
  return (await get('/health')).json()['agents'] as number;
}

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  const podPort = (podServer.address() as net.AddressInfo).port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  host = new URL(base).host;
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
      const health = (await get('/health')).json();
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

test('after a restart the map holds the users and one placeholder agent each', async () => {
  const health = (await get('/health')).json();
  assert.equal(health['users'], 5);
  assert.equal(health['agents'], 5);
});

test('a forgotten surface agent of a known canonical user is restored, its user as controller', async () => {
  const r = await get(`/agents/claude-${ALICE}/did.json`);
  assert.equal(r.status, 200, output);
  const doc = r.json();
  assert.equal(doc['id'], `did:web:${host}:agents:claude-${ALICE}`);
  assert.equal(doc['controller'], `did:web:${host}:users:${ALICE}`);
  assert.equal(await agentCount(), 6);
  // Served from memory from now on: the same document, not a second restore.
  assert.deepEqual((await get(`/agents/claude-${ALICE}/did.json`)).json(), doc);
  assert.equal(await agentCount(), 6);
});

test('the profile route restores too, named as ensureSurfaceAgent names it', async () => {
  const r = await get(`/agents/claude-code-vscode-${ALICE}/profile`);
  assert.equal(r.status, 200);
  assert.match(r.body, /rdfs:label "Claude Code Vscode \(Alice\)"/);
  assert.ok(r.body.includes(`iep:delegatedBy <${base}/users/${ALICE}/profile#me>`), r.body);
  assert.ok(r.body.includes(`iep:agentIdentity <did:web:${host}:agents:claude-code-vscode-${ALICE}>`), r.body);
  assert.match(r.body, /iep:scope "ReadWrite"/);
  const webId = await get(`/users/${ALICE}/profile`);
  assert.ok(webId.body.includes(`<${base}/agents/claude-code-vscode-${ALICE}/profile#agent>`), webId.body);
});

test('no restore for an unknown user, a non-canonical id, a malformed slug, two users, or a reserved id', async () => {
  const count = await agentCount();
  for (const id of [
    'claude-u-pk-eeeeeeeeeeee',          // canonical, but no such user
    `claude-${LEGACY}`, `claude-${TRY_USER}`, // known users, ids that are not canonical
    `Claude-${ALICE}`, `claude--code-${ALICE}`, `c-${ALICE}`, `claude_code-${ALICE}`, `claude-${ALICE}-x`,
    `claude-${BOB}-${ALICE}`,             // names two users
    `playwright-passkey-${ALICE}`,        // the janitor would delete Alice
    ALICE,                                // a user, not an agent
  ]) {
    assert.equal((await get(`/agents/${encodeURIComponent(id)}/did.json`)).status, 404, id);
    assert.equal((await get(`/agents/${encodeURIComponent(id)}/profile`)).status, 404, id);
  }
  assert.equal(await agentCount(), count);
});

test('anonymous restores of slugified names are capped per user; fixed surfaces are not', async () => {
  for (let i = 1; i <= 4; i++) assert.equal((await get(`/agents/tool-${i}-${BOB}/did.json`)).status, 200, `tool-${i}`);
  assert.equal((await get(`/agents/tool-5-${BOB}/did.json`)).status, 404);
  assert.equal((await get(`/agents/tool-5-${BOB}/profile`)).status, 404);
  assert.equal((await get(`/agents/cursor-${BOB}/did.json`)).status, 200);
  assert.equal((await get(`/agents/chatgpt-${BOB}/did.json`)).status, 200);
});

test('a token for its own user\'s forgotten surface agent restores it, past the cap', async () => {
  const bearer = token(BOB, `tool-5-${BOB}`);
  const verified = await post('/tokens/verify', { token: bearer });
  assert.equal(verified.json['valid'], true, JSON.stringify(verified.json));
  assert.equal(verified.json['agentId'], `tool-5-${BOB}`);
  const doc = (await get(`/agents/tool-5-${BOB}/did.json`)).json();
  assert.equal(doc['controller'], `did:web:${host}:users:${BOB}`);
  const me = (await get('/me', bearer)).json();
  assert.equal(me['authenticatedAgentId'], `tool-5-${BOB}`);
  assert.equal(me['primaryAgentId'], `tool-5-${BOB}`);
});

test('a token does not restore another user\'s agent', async () => {
  const verified = await post('/tokens/verify', { token: token(ALICE, `tool-6-${BOB}`) });
  assert.equal(verified.json['valid'], true);
  assert.equal((await get(`/agents/tool-6-${BOB}/did.json`)).status, 404);
});

test('register-agent refuses another user\'s canonical suffix; the caller\'s own still registers', async () => {
  const bearer = token(ALICE, `claude-${ALICE}`);
  for (const agentId of [`claude-code-${BOB}`, `windsurf-u-eth-0123456789ab`, BOB, `Anything-${CAROL}`]) {
    const r = await post('/register-agent', { userId: ALICE, agentId }, bearer);
    assert.equal(r.status, 403, agentId);
    assert.match(String(r.json['error']), /another user's id/, agentId);
    const doc = await get(`/agents/${encodeURIComponent(agentId)}/did.json`);
    if (doc.status === 200) assert.notEqual(doc.json()['controller'], `did:web:${host}:users:${ALICE}`, agentId);
  }
  // Bob's surface agent, which Alice tried to take, is still Bob's when it is asked for.
  assert.equal((await get(`/agents/claude-code-${BOB}/did.json`)).json()['controller'], `did:web:${host}:users:${BOB}`);

  const own = await post('/register-agent', { userId: ALICE, agentId: `zed-${ALICE}`, agentName: 'Zed' }, bearer);
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal((await get(`/agents/zed-${ALICE}/did.json`)).json()['controller'], `did:web:${host}:users:${ALICE}`);
  // Ids without a canonical suffix behave as before.
  assert.equal((await post('/register-agent', { userId: ALICE, agentId: 'my-bot' }, bearer)).status, 201);
  assert.equal((await post('/register-agent', { userId: ALICE, agentId: 'my-bot' }, bearer)).status, 409);
  assert.equal((await post('/register-agent', { userId: ALICE, agentId: `claude-${ALICE}` }, bearer)).status, 409);
});

test('a deleted user\'s surface agents are not restored', async () => {
  assert.equal((await get(`/agents/claude-${CAROL}/did.json`)).status, 200);
  const deleted = await post('/users/me/delete', {}, token(CAROL, `claude-${CAROL}`));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  for (const id of [`claude-${CAROL}`, `chatgpt-${CAROL}`, `tool-1-${CAROL}`]) {
    assert.equal((await get(`/agents/${id}/did.json`)).status, 404, id);
  }
  // Nor by a token issued before the deletion.
  const verified = await post('/tokens/verify', { token: token(CAROL, `chatgpt-${CAROL}`) });
  assert.equal(verified.json['valid'], false);
  assert.equal((await get(`/agents/chatgpt-${CAROL}/did.json`)).status, 404);
});
