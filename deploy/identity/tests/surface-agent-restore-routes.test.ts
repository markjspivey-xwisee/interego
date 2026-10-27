/**
 * Restoring forgotten surface agents, through the routes: server.ts is started as a child
 * process against a stand-in pod server (no live pod), so its identities map is exactly what
 * the boot-time rebuild makes of the pods: the users, and one placeholder agent each. That is
 * the map after a restart, without any surface agent the relay had minted. Each pod also
 * holds the agent registry (`<pod>/agents`) the relay writes on OAuth, in the shape its
 * ownerProfileToTurtle writes, listing that person's surface agents.
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
import { closeServer, stopChild } from './teardown.js';

const ALICE = 'u-pk-aaaaaaaaaaaa';
const BOB = 'u-pk-bbbbbbbbbbbb';
const CAROL = 'u-eth-cccccccccccc';
const DAVE = 'u-did-dddddddddddd';
const ERIN = 'u-eth-eeeeeeeeeeee';
const TRY_USER = 'u-try-dddddddddddd';
const LEGACY = 'markj';
const now = new Date().toISOString();
const DAVE_TOOLS = Array.from({ length: 33 }, (_, i) => `tool-${i + 1}-${DAVE}`);

// What each pod's auth-methods.jsonld holds. Every one has a credential, so every one loads.
const pods = new Map<string, Record<string, unknown>>([
  [ALICE, { userId: ALICE, name: 'Alice', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [{ id: 'cred-alice', publicKey: 'AA', counter: 0, createdAt: now }] }],
  [BOB, { userId: BOB, name: 'Bob', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [{ did: 'did:key:zBob', publicKeyMultibase: 'zBob', keyType: 'Ed25519VerificationKey2020', createdAt: now }] }],
  [CAROL, { userId: CAROL, name: 'Carol', walletAddresses: ['0xcccccccccccccccccccccccccccccccccccccccc'], webAuthnCredentials: [], didKeys: [] }],
  [DAVE, { userId: DAVE, name: 'Dave', walletAddresses: [], webAuthnCredentials: [],
    didKeys: [{ did: 'did:key:zDave', publicKeyMultibase: 'zDave', keyType: 'Ed25519VerificationKey2020', createdAt: now }] }],
  [ERIN, { userId: ERIN, name: 'Erin', walletAddresses: ['0x1111111111111111111111111111111111111111'], webAuthnCredentials: [], didKeys: [] }],
  [TRY_USER, { userId: TRY_USER, name: 'Try', walletAddresses: ['0xdddddddddddddddddddddddddddddddddddddddd'], webAuthnCredentials: [], didKeys: [] }],
  [LEGACY, { userId: LEGACY, name: 'Mark', walletAddresses: ['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'], webAuthnCredentials: [], didKeys: [] }],
]);

// The surface agents each person's registry lists ('fail': the registry cannot be read).
// Some ids are listed only to show that the other checks still refuse them.
const registries = new Map<string, readonly string[] | 'fail'>([
  [ALICE, [`claude-${ALICE}`, `claude-code-vscode-${ALICE}`, `cursor-${ALICE}`, `reader-${ALICE}`, `playwright-passkey-${ALICE}`, `claude-${BOB}-${ALICE}`]],
  [BOB, [`my-client-${BOB}`, `claude-code-${BOB}`]],
  [CAROL, [`claude-${CAROL}`, `chatgpt-${CAROL}`]],
  [DAVE, DAVE_TOOLS],
  [ERIN, 'fail'],
  [TRY_USER, [`claude-${TRY_USER}`]],
  [LEGACY, [`claude-${LEGACY}`]],
]);
// Entries listed with a scope other than ReadWrite.
const registryScopes = new Map<string, string>([[`reader-${ALICE}`, 'ReadOnly']]);
const registryReads = new Map<string, number>();

/** `<pod>/agents` as the relay's writeAgentRegistry leaves it (ownerProfileToTurtle). */
function registryTurtle(userId: string, agentIds: readonly string[]): string {
  const did = (id: string) => `did:web:${host}:agents:${id}`;
  const frag = (id: string) => `<#agent-${encodeURIComponent(did(id))}>`;
  const webId = `${base}/users/${userId}/profile#me`;
  return [
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
    '@prefix foaf: <http://xmlns.com/foaf/0.1/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '',
    `<${webId}> a foaf:Person ;`,
    `    foaf:name "${userId}" ;`,
    '    iep:authorizedAgent',
    ...agentIds.map((id, i) => `        ${frag(id)}${i < agentIds.length - 1 ? ',' : ' .'}`),
    '',
    ...agentIds.flatMap(id => [
      `${frag(id)} a iep:AuthorizedAgent ;`,
      `    iep:agentIdentity <${did(id)}> ;`,
      `    iep:delegatedBy <${webId}> ;`,
      `    iep:scope iep:${registryScopes.get(id) ?? 'ReadWrite'} ;`,
      `    iep:validFrom "${now}"^^xsd:dateTime ;`,
      `    foaf:name "${id}" ;`,
      '    a prov:SoftwareAgent ;',
      '    iep:encryptionPublicKey "S2V5" .',
      '',
    ]),
  ].join('\n');
}

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
  // Kept, as a pod keeps it: deleting an account writes its tombstone here.
  if (m && req.method === 'PUT') {
    let body = '';
    req.on('data', d => { body += String(d); });
    req.on('end', () => { pods.set(m[1]!, JSON.parse(body) as Record<string, unknown>); res.writeHead(201).end(); });
    return;
  }
  const a = /^\/([^/]+)\/agents$/.exec(path);
  if (a && req.method === 'GET') {
    registryReads.set(a[1]!, (registryReads.get(a[1]!) ?? 0) + 1);
    const listed = registries.get(a[1]!);
    if (listed === 'fail') { res.writeHead(500).end(); return; }
    if (!listed) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(registryTurtle(a[1]!, listed));
    return;
  }
  if (a && req.method === 'DELETE') {
    registries.delete(a[1]!);
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

/** A token as issueToken signs it. `agentId` is unknown so a malformed one can be minted too. */
function token(userId: string, agentId: unknown, scope = 'ReadWrite'): string {
  const b64 = Buffer.from(JSON.stringify({
    userId, agentId, scope, issuedAt: new Date().toISOString(),
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

const agentPath = (id: string, leaf: 'did.json' | 'profile') => `/agents/${encodeURIComponent(id)}/${leaf}`;

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
  await stopChild(identity);
  await closeServer(podServer);
});

test('after a restart the map holds the users and one placeholder agent each', async () => {
  const health = (await get('/health')).json();
  assert.equal(health['users'], 7);
  assert.equal(health['agents'], 7);
});

test('a forgotten surface agent its user\'s registry lists is restored, its user as controller', async () => {
  const r = await get(agentPath(`claude-${ALICE}`, 'did.json'));
  assert.equal(r.status, 200, output);
  const doc = r.json();
  assert.equal(doc['id'], `did:web:${host}:agents:claude-${ALICE}`);
  assert.equal(doc['controller'], `did:web:${host}:users:${ALICE}`);
  assert.equal(await agentCount(), 8);
  // Served from memory from now on: the same document, keys and all, not a second restore.
  assert.deepEqual((await get(agentPath(`claude-${ALICE}`, 'did.json'))).json(), doc);
  assert.equal(await agentCount(), 8);
});

test('the profile route restores too, named as ensureSurfaceAgent names it', async () => {
  const r = await get(agentPath(`claude-code-vscode-${ALICE}`, 'profile'));
  assert.equal(r.status, 200);
  assert.match(r.body, /rdfs:label "Claude Code Vscode \(Alice\)"/);
  assert.ok(r.body.includes(`iep:delegatedBy <${base}/users/${ALICE}/profile#me>`), r.body);
  assert.ok(r.body.includes(`iep:agentIdentity <did:web:${host}:agents:claude-code-vscode-${ALICE}>`), r.body);
  assert.match(r.body, /iep:scope "ReadWrite"/);
  const webId = await get(`/users/${ALICE}/profile`);
  assert.ok(webId.body.includes(`<${base}/agents/claude-code-vscode-${ALICE}/profile#agent>`), webId.body);
});

test('a restored agent keeps the scope its registry entry or its token records', async () => {
  // Listed as ReadOnly (registered that way through POST /register-agent, say): not ReadWrite.
  const listed = await get(agentPath(`reader-${ALICE}`, 'profile'));
  assert.equal(listed.status, 200, output);
  assert.match(listed.body, /iep:scope "ReadOnly"/);
  // And a token minted for it now carries that scope.
  const minted = await post('/tokens', { userId: ALICE, agentId: `reader-${ALICE}` }, token(ALICE, `claude-${ALICE}`));
  assert.equal(minted.status, 200, JSON.stringify(minted.json));
  assert.equal(minted.json['scope'], 'ReadOnly');
  // Restored by a token: the scope it was signed with, the least one for a scope that is none.
  for (const [agentId, scope, expected] of [[`pub-${BOB}`, 'PublishOnly', 'PublishOnly'], [`odd-${BOB}`, 'Admin', 'DiscoverOnly']] as const) {
    assert.equal((await post('/tokens/verify', { token: token(BOB, agentId, scope) })).json['valid'], true, agentId);
    assert.match((await get(agentPath(agentId, 'profile'))).body, new RegExp(`iep:scope "${expected}"`), agentId);
  }
});

test('an anonymous lookup never invents an agent the person\'s registry does not list', async () => {
  const count = await agentCount();
  // A fixed surface Alice never used, and a slug the caller made up.
  for (const id of [`windsurf-${ALICE}`, `send-funds-here-${ALICE}`, `chatgpt-${ALICE}`]) {
    assert.equal((await get(agentPath(id, 'did.json'))).status, 404, id);
    assert.equal((await get(agentPath(id, 'profile'))).status, 404, id);
  }
  assert.equal(await agentCount(), count);
  // So none of them becomes an authorized agent in her WebID profile or her agent list.
  const webId = (await get(`/users/${ALICE}/profile`)).body;
  const mine = JSON.stringify((await get('/agents/me', token(ALICE, `claude-${ALICE}`))).json());
  for (const text of [webId, mine]) {
    assert.doesNotMatch(text, /windsurf|send-funds-here|Send Funds Here|chatgpt-u-pk/, text);
  }
});

test('no restore for an unknown user, a non-canonical id, a malformed slug, two users, or a reserved id', async () => {
  const count = await agentCount();
  for (const id of [
    'claude-u-pk-eeeeeeeeeeee',          // canonical, but no such user
    `claude-${LEGACY}`, `claude-${TRY_USER}`, // known users whose registries list them; ids not canonical
    `Claude-${ALICE}`, `claude--code-${ALICE}`, `c-${ALICE}`, `claude_code-${ALICE}`, `claude-${ALICE}-x`,
    `cursor-${ALICE}\n`, `cursor-${ALICE} `, // Alice's registry lists cursor-<Alice>, not these
    `claude-${BOB}-${ALICE}`,             // names two users (listed, still refused)
    `playwright-passkey-${ALICE}`,        // the janitor would delete Alice (listed, still refused)
    ALICE,                                // a user, not an agent
  ]) {
    assert.equal((await get(agentPath(id, 'did.json'))).status, 404, JSON.stringify(id));
    assert.equal((await get(agentPath(id, 'profile'))).status, 404, JSON.stringify(id));
  }
  assert.equal(await agentCount(), count);
});

test('made-up slugs cost a user nothing, and the registry is read once however many are asked for', async () => {
  for (let i = 1; i <= 10; i++) assert.equal((await get(agentPath(`junk-${i}-${BOB}`, 'did.json'))).status, 404, `junk-${i}`);
  assert.equal(registryReads.get(BOB), 1);
  // Bob's own custom client (a slugified client name) is still served.
  const doc = await get(agentPath(`my-client-${BOB}`, 'did.json'));
  assert.equal(doc.status, 200);
  assert.equal(doc.json()['controller'], `did:web:${host}:users:${BOB}`);
  assert.equal(registryReads.get(BOB), 1);
});

test('a registry that cannot be read restores nothing, and is not read on every lookup', async () => {
  assert.equal((await get(agentPath(`claude-${ERIN}`, 'did.json'))).status, 404);
  assert.equal((await get(agentPath(`chatgpt-${ERIN}`, 'profile'))).status, 404);
  assert.equal(registryReads.get(ERIN), 1);
});

test('anonymous restores are capped per user', async () => {
  for (const id of DAVE_TOOLS.slice(0, 32)) assert.equal((await get(agentPath(id, 'did.json'))).status, 200, id);
  const last = DAVE_TOOLS[32]!;
  assert.equal((await get(agentPath(last, 'did.json'))).status, 404);
  assert.equal((await get(agentPath(last, 'profile'))).status, 404);
});

test('a token for its own user\'s forgotten surface agent restores it, past the cap and without the registry', async () => {
  for (const [userId, agentId] of [[DAVE, DAVE_TOOLS[32]!], [BOB, `tool-x-${BOB}`]] as const) {
    const bearer = token(userId, agentId);
    const verified = await post('/tokens/verify', { token: bearer });
    assert.equal(verified.json['valid'], true, JSON.stringify(verified.json));
    assert.equal(verified.json['agentId'], agentId);
    const doc = (await get(agentPath(agentId, 'did.json'))).json();
    assert.equal(doc['controller'], `did:web:${host}:users:${userId}`);
    const me = (await get('/me', bearer)).json();
    assert.equal(me['authenticatedAgentId'], agentId);
    assert.equal(me['primaryAgentId'], agentId);
  }
});

test('a token naming another user\'s agent, or no string agent id, does not verify or restore', async () => {
  const foreign = await post('/tokens/verify', { token: token(ALICE, `tool-6-${BOB}`) });
  assert.equal(foreign.json['valid'], false);
  assert.match(String(foreign.json['reason']), /another user's namespace/);
  assert.equal((await get(agentPath(`tool-6-${BOB}`, 'did.json'))).status, 404);
  for (const agentId of [[`claude-code-${BOB}`], { id: 'x' }, 7, null, `cursor-${BOB}\n`, `cursor-${BOB} `]) {
    const r = await post('/tokens/verify', { token: token(ALICE, agentId) });
    assert.equal(r.json['valid'], false, JSON.stringify(agentId));
  }
});

test('register-agent refuses another user\'s canonical suffix and anything but a plain slug; the caller\'s own still registers', async () => {
  const bearer = token(ALICE, `claude-${ALICE}`);
  const count = await agentCount();
  for (const agentId of [`claude-code-${BOB}`, `windsurf-u-eth-0123456789ab`, BOB, `anything-${CAROL}`, `anything_${CAROL}`, `x.${CAROL}`]) {
    const r = await post('/register-agent', { userId: ALICE, agentId }, bearer);
    assert.equal(r.status, 403, agentId);
    assert.match(String(r.json['error']), /another user's id/, agentId);
  }
  for (const agentId of [
    [`claude-code-${BOB}`], { id: `claude-code-${BOB}` }, 42,
    `cursor-${BOB}\n`, `cursor-${BOB}\t`, `cursor-${BOB}\r`, `cursor-${BOB} `, `Anything-${CAROL}`, 'my bot',
  ]) {
    const r = await post('/register-agent', { userId: ALICE, agentId }, bearer);
    assert.equal(r.status, 400, JSON.stringify(agentId));
    assert.equal(r.json['token'], undefined, JSON.stringify(agentId));
  }
  assert.equal(await agentCount(), count);
  const webId = (await get(`/users/${ALICE}/profile`)).body;
  assert.doesNotMatch(webId, new RegExp(`${BOB}|${CAROL}`), webId);
  // Bob's surface agent, which Alice tried to take, is still Bob's when it is asked for, and the
  // newline variant names nobody.
  assert.equal((await get(agentPath(`claude-code-${BOB}`, 'did.json'))).json()['controller'], `did:web:${host}:users:${BOB}`);
  assert.equal((await get(agentPath(`cursor-${BOB}\n`, 'did.json'))).status, 404);

  const own = await post('/register-agent', { userId: ALICE, agentId: `zed-${ALICE}`, agentName: 'Zed' }, bearer);
  assert.equal(own.status, 201, JSON.stringify(own.json));
  assert.equal((await get(agentPath(`zed-${ALICE}`, 'did.json'))).json()['controller'], `did:web:${host}:users:${ALICE}`);
  // Ids without a canonical suffix behave as before.
  assert.equal((await post('/register-agent', { userId: ALICE, agentId: 'my-bot' }, bearer)).status, 201);
  assert.equal((await post('/register-agent', { userId: ALICE, agentId: 'my-bot' }, bearer)).status, 409);
  assert.equal((await post('/register-agent', { userId: ALICE, agentId: `claude-${ALICE}` }, bearer)).status, 409);
  assert.equal((await post('/register-agent', { userId: ALICE }, bearer)).status, 400);
});

test('a deleted user\'s surface agents are not restored', async () => {
  assert.equal((await get(agentPath(`claude-${CAROL}`, 'did.json'))).status, 200);
  const deleted = await post('/users/me/delete', {}, token(CAROL, `claude-${CAROL}`));
  assert.equal(deleted.status, 200, JSON.stringify(deleted.json));
  for (const id of [`claude-${CAROL}`, `chatgpt-${CAROL}`, `tool-1-${CAROL}`]) {
    assert.equal((await get(agentPath(id, 'did.json'))).status, 404, id);
  }
  // Nor by a token issued before the deletion.
  const verified = await post('/tokens/verify', { token: token(CAROL, `chatgpt-${CAROL}`) });
  assert.equal(verified.json['valid'], false);
  assert.equal((await get(agentPath(`chatgpt-${CAROL}`, 'did.json'))).status, 404);
});
