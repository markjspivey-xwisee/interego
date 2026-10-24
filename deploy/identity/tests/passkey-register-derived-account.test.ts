/**
 * A new passkey whose derived id names an existing account is refused, not added to it.
 *
 * POST /auth/webauthn/register, with no bearer and no bootstrap invite, derives the account
 * id from the credential id (`u-pk-<sha256(credentialId)[:12]>`) and enrolls the passkey on
 * it through commitCredentialEnrollment, which appends to whatever document the pod holds.
 * The credential id is not in the index, so an account already under that id holds other
 * credentials: the id keeps 48 bits of a hash of a credential id that a software
 * authenticator chooses, so a match can be searched for. Appending gave the caller a
 * token for that account. The first-time wallet and DID paths refuse the same case
 * (first-sign-in.ts); registration now refuses it as well.
 *
 * server.ts is started as a child process against a stand-in pod server. The registration
 * responses are built here as a software authenticator makes them: "none" attestation, an
 * ES256 key, user present and verified, and a credential id the caller chooses.
 *
 * Run:
 *   node --test --import tsx tests/passkey-register-derived-account.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { deriveUserIdFromCredentialId } from '../derive-userid.js';

const now = new Date().toISOString();
const credentialId = () => crypto.randomBytes(16).toString('base64url');

// A credential id whose account is on its pod but not in the root listing (not loaded at startup).
const unloadedMatch = credentialId();
const UNLOADED = deriveUserIdFromCredentialId(unloadedMatch);
// One whose account is listed, so it is loaded at startup.
const loadedMatch = credentialId();
const LOADED = deriveUserIdFromCredentialId(loadedMatch);
// One whose account's pod cannot be read.
const blockedMatch = credentialId();
const BLOCKED = deriveUserIdFromCredentialId(blockedMatch);
// One with no account at all.
const fresh = credentialId();
const FRESH = deriveUserIdFromCredentialId(fresh);

const account = (userId: string, name: string) => ({
  userId, name, sessionEpoch: 2, walletAddresses: [], didKeys: [],
  webAuthnCredentials: [{ id: `cred-${name.toLowerCase()}`, publicKey: 'AA', counter: 9, createdAt: now }],
});
const pods = new Map<string, Record<string, unknown>>([
  [UNLOADED, account(UNLOADED, 'Una')],
  [LOADED, account(LOADED, 'Lou')],
  [BLOCKED, account(BLOCKED, 'Bo')],
]);
const seeded = new Map([...pods].map(([id, doc]) => [id, structuredClone(doc)]));
const listed = [LOADED];
const unreadable = new Set([BLOCKED]);
// Every write the server makes, as `<METHOD> <path>`.
const writes: string[] = [];

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (req.method !== 'GET' && req.method !== 'HEAD') writes.push(`${req.method} ${path}`);
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(req.method === 'HEAD' ? undefined
      : `@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${listed.map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET') {
    if (unreadable.has(m[1]!)) { res.writeHead(500).end(); return; }
    const doc = pods.get(m[1]!);
    if (!doc) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify(doc));
    return;
  }
  if (m && req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => {
      pods.set(m[1]!, JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      res.writeHead(201).end();
    });
    return;
  }
  if (req.method === 'PUT') { res.writeHead(201).end(); return; }
  res.writeHead(404).end();
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => s.close(() => resolve()));
  return port;
}

let podServer: http.Server;
let identity: ChildProcess;
let base = '';
let output = '';

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

async function registerPasskey(id: string) {
  const options = await post('/auth/webauthn/register-options', { name: 'Someone else' });
  assert.equal(options.status, 200, JSON.stringify(options.json));
  const challenge = options.json['challenge'] as string;
  const rpId = (options.json['rp'] as { id: string }).id;
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const coseKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')],
  ]));
  const raw = Buffer.from(id, 'base64url');
  const length = Buffer.alloc(2);
  length.writeUInt16BE(raw.length);
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16),
    length, raw, Buffer.from(coseKey),
  ]);
  const attestationObject = isoCBOR.encode(new Map<string, Parameters<typeof isoCBOR.encode>[0]>([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)],
  ]));
  const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin: base, crossOrigin: false });
  return post('/auth/webauthn/register', { response: {
    id, rawId: id, type: 'public-key', clientExtensionResults: {},
    response: {
      clientDataJSON: Buffer.from(clientDataJSON).toString('base64url'),
      attestationObject: Buffer.from(attestationObject).toString('base64url'),
      transports: ['internal'],
    },
  } });
}

const writesTo = (userId: string) => writes.filter(w => w.split(' ')[1]!.startsWith(`/${userId}/`));
/** Long enough for a write the server deferred past its response to reach the pod. */
const settle = () => new Promise(resolve => setTimeout(resolve, 500));

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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
    TOKEN_SIGNING_KEY: crypto.randomBytes(32).toString('base64'), ALLOW_OPEN_INTROSPECTION: '1', JANITOR_INTERVAL_MS: '0',
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

for (const [label, id, userId] of [
  ['an account on its pod the server has not loaded', unloadedMatch, UNLOADED],
  ['an account the server has loaded', loadedMatch, LOADED],
] as const) {
  test(`a passkey whose id derives to ${label} is refused, and the account is left alone`, async () => {
    const r = await registerPasskey(id);
    assert.equal(r.status, 401, `${JSON.stringify(r.json)}\n${output}`);
    assert.equal(r.json['token'], undefined);
    await settle();
    assert.deepEqual(writesTo(userId), []);
    assert.deepEqual(pods.get(userId), seeded.get(userId));
  });
}

test('a passkey whose derived account cannot be read gets a 503 and no write', async () => {
  const r = await registerPasskey(blockedMatch);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  await settle();
  assert.deepEqual(writesTo(BLOCKED), []);
  assert.deepEqual(pods.get(BLOCKED), seeded.get(BLOCKED));
});

test('a passkey with no account behind its id still registers', async () => {
  const r = await registerPasskey(fresh);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], FRESH);
  await until(() => ((pods.get(FRESH)?.['webAuthnCredentials'] as unknown[] | undefined) ?? []).length > 0, 'the new passkey to be written');
  assert.deepEqual((pods.get(FRESH)!['webAuthnCredentials'] as Array<{ id: string }>).map(c => c.id), [fresh]);
});
