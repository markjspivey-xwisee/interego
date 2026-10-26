/**
 * Passkey registration (POST /auth/webauthn/register), through the routes: server.ts is
 * started as a child process against a stand-in pod server (no live pod), and the passkeys
 * come from a software authenticator (tests/soft-authenticator.ts, 'none' attestation), so
 * the server's own WebAuthn verification runs unchanged.
 *
 * A fresh registration (no bearer, no bootstrap invite) derives its account id from the
 * credential id, `u-pk-<48 bits of its sha256>`. Credential ids are not secret, and an
 * authenticator built in software registers any id it is given, so a fresh registration
 * may only CREATE an account: it is refused when the derived account already holds
 * credentials, whether the index has not loaded that account yet, its owner removed this
 * passkey, or another credential id lands on the same derived id. It used to append the
 * passkey to whatever account lived there and hand back that account's token. After a
 * refusal, or a create the pod applied without confirming, the account the pod holds is
 * loaded (no token), so its own passkey can sign in.
 *
 * Run:
 *   node --test --import tsx tests/passkey-register-routes.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { assertion, attest, softPasskey, type SoftPasskey } from './soft-authenticator.js';

const now = new Date().toISOString();
const passkey = (id: string) => ({ id, publicKey: 'AA', counter: 0, createdAt: now });

// ── Passkeys and the accounts their ids derive to ──
const keys = {
  unloaded: softPasskey(),   // reuses an id its account lists; that account was never loaded
  removed: softPasskey(),    // its account (loaded) no longer lists it: the owner removed it
  collision: softPasskey(),  // its derived id holds an account with a different passkey
  unreadable: softPasskey(), // its derived pod answers 502 for a while
  fresh: softPasskey(),      // no pod
  raced: softPasskey(),      // no pod when read; another writer creates it before the write
  lost: softPasskey(),       // no pod; the pod stores the create but answers 504
  owner: softPasskey(),      // its own unloaded account lists it with its key
  added: softPasskey(),      // added to an existing account with its bearer (mode C)
  bootstrap: softPasskey(),  // claims a seeded account with an invite (mode B)
};
const invite = { userId: 'seeded-passkey', token: crypto.randomBytes(16).toString('hex') };

const pods = new Map<string, Record<string, unknown>>([
  [keys.unloaded.userId, { userId: keys.unloaded.userId, name: 'Unloaded', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [passkey(keys.unloaded.id)] }],
  [keys.removed.userId, { userId: keys.removed.userId, name: 'Removed', didKeys: [],
    walletAddresses: ['0x00000000000000000000000000000000000000aa'], webAuthnCredentials: [passkey('cred-kept')] }],
  [keys.collision.userId, { userId: keys.collision.userId, name: 'Collided', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [passkey('cred-victim')] }],
  [keys.owner.userId, { userId: keys.owner.userId, name: 'Owner', walletAddresses: [], didKeys: [],
    webAuthnCredentials: [{ ...passkey(keys.owner.id), publicKey: keys.owner.cose.toString('base64url') }] }],
]);
// Only these are in the root listing, so only these load at startup.
const listed = new Set([keys.removed.userId, keys.collision.userId]);
const blipping = new Set<string>([keys.unreadable.userId]);
const lossy = new Set<string>([keys.lost.userId]);
const racedDoc = { userId: keys.raced.userId, name: 'Other writer', walletAddresses: [], didKeys: [],
  webAuthnCredentials: [passkey('cred-other-writer')] };
let racedReads = 0;
const writes: Array<{ userId: string; ifNoneMatch: string | undefined }> = [];
const snapshot = (userId: string) => JSON.parse(JSON.stringify(pods.get(userId) ?? null)) as unknown;

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...listed].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET') {
    const userId = m[1]!;
    if (blipping.has(userId)) { res.writeHead(502).end(); return; }
    if (userId === keys.raced.userId && racedReads++ === 0) {
      pods.set(userId, racedDoc);
      res.writeHead(404).end();
      return;
    }
    const doc = pods.get(userId);
    if (!doc) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify(doc));
    return;
  }
  if (m && req.method === 'PUT') {
    const userId = m[1]!;
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined;
    let body = '';
    req.on('data', d => { body += String(d); });
    req.on('end', () => {
      if (ifNoneMatch === '*' && pods.has(userId)) { res.writeHead(412).end(); return; }
      writes.push({ userId, ifNoneMatch });
      pods.set(userId, JSON.parse(body) as Record<string, unknown>);
      if (lossy.delete(userId)) { res.writeHead(504).end(); return; }
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

async function post(path: string, body: unknown, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

async function register(key: SoftPasskey, opts: { bearer?: string; bootstrap?: typeof invite } = {}) {
  const extra = opts.bootstrap ? { bootstrapUserId: opts.bootstrap.userId, bootstrapInvite: opts.bootstrap.token } : {};
  const options = await post('/auth/webauthn/register-options', { name: 'New', ...extra }, opts.bearer);
  assert.equal(options.status, 200, JSON.stringify(options.json));
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), base, rpId) });
}

/** A usernameless passkey sign-in: the server finds the account from the credential id. */
let signCount = 0;
async function signIn(key: SoftPasskey) {
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate' });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  const rpId = String(ch.json['rpId'] ?? new URL(base).hostname);
  return post('/auth/webauthn/authenticate', { response: assertion(key, String(ch.json['nonce']), base, rpId, ++signCount) });
}

const writesTo = (userId: string) => writes.filter(w => w.userId === userId);
const credentialIds = (userId: string) =>
  ((pods.get(userId)?.['webAuthnCredentials'] ?? []) as Array<{ id: string }>).map(c => c.id);

async function eventually(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

before(async () => {
  podServer = http.createServer(servePods);
  await new Promise<void>(resolve => podServer.listen(0, '127.0.0.1', resolve));
  const podPort = (podServer.address() as net.AddressInfo).port;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS',
    'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_ORIGIN', 'WEBAUTHN_RP_ORIGINS']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: base, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: crypto.randomBytes(32).toString('base64'), JANITOR_INTERVAL_MS: '0',
    BOOTSTRAP_INVITES: `${invite.userId}:${invite.token}`,
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
      const health = await (await fetch(`${base}/health`)).json() as { accountIndex: { complete: boolean } };
      if (health.accountIndex.complete) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`identity server did not load its accounts:\n${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

after(async () => {
  identity?.kill('SIGTERM');
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
});

/** A fresh registration that must be refused: 409, no token, and the account left as it was. */
async function assertRefused(key: SoftPasskey): Promise<void> {
  const before = snapshot(key.userId);
  const r = await register(key);
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}\n${output}`);
  assert.match(String(r.json['error']), /cannot be registered as a new account/);
  assert.equal(r.json['token'], undefined);
  // A deferred write would land after the response; give it the time one takes.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(writesTo(key.userId), []);
  assert.deepEqual(snapshot(key.userId), before);
}

test('a passkey reusing the id an unloaded account lists does not join that account', async () => {
  await assertRefused(keys.unloaded);
});

test('a passkey its owner removed, registered again, does not join the account it was removed from', async () => {
  await assertRefused(keys.removed);
});

test('a passkey whose id derives to an account holding a different passkey does not join it', async () => {
  await assertRefused(keys.collision);
});

test('an account another writer creates between the read and the write is not appended to', async () => {
  const r = await register(keys.raced);
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  assert.deepEqual(writesTo(keys.raced.userId), []);
  assert.deepEqual(pods.get(keys.raced.userId), racedDoc);
});

test('a derived pod that cannot be read is a 503 with nothing written; once readable, the new account is created', async () => {
  const { userId } = keys.unreadable;
  const down = await register(keys.unreadable);
  assert.equal(down.status, 503, `${JSON.stringify(down.json)}\n${output}`);
  assert.equal(down.json['token'], undefined);
  assert.deepEqual(writesTo(userId), []);
  blipping.delete(userId);
  const retry = await register(keys.unreadable);
  assert.equal(retry.status, 200, `${JSON.stringify(retry.json)}\n${output}`);
  assert.equal(retry.json['userId'], userId);
  assert.ok(retry.json['token']);
  assert.deepEqual(credentialIds(userId), [keys.unreadable.id]);
});

test('a create the pod applied without confirming it is not reported as unchanged, and the passkey then signs in', async () => {
  const { userId } = keys.lost;
  const r = await register(keys.lost);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  assert.doesNotMatch(JSON.stringify(r.json), /Nothing was changed/);
  assert.deepEqual(credentialIds(userId), [keys.lost.id]);
  // Registering it again is refused (the account exists now) and makes nothing new.
  const again = await register(keys.lost);
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.equal(writesTo(userId).length, 1);
  // The account the pod holds is reachable by signing in with the passkey, as both answers say.
  const signedIn = await signIn(keys.lost);
  assert.equal(signedIn.status, 200, `${JSON.stringify(signedIn.json)}\n${output}`);
  assert.equal(signedIn.json['userId'], userId);
  assert.ok(signedIn.json['token']);
});

test('a refused registration loads the account it found, so the owner\'s passkey signs in to it', async () => {
  const { owner } = keys;
  await assertRefused(softPasskey(owner.rawId));   // the owner's id, someone else's key
  const signedIn = await signIn(owner);
  assert.equal(signedIn.status, 200, `${JSON.stringify(signedIn.json)}\n${output}`);
  assert.equal(signedIn.json['userId'], owner.userId);
});

let freshToken = '';
test('a new passkey creates its account once, with a write that requires absence', async () => {
  const { userId } = keys.fresh;
  const r = await register(keys.fresh);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], userId);
  freshToken = String(r.json['token']);
  assert.ok(freshToken);
  assert.deepEqual(writesTo(userId), [{ userId, ifNoneMatch: '*' }]);
  assert.deepEqual(credentialIds(userId), [keys.fresh.id]);
  // The same passkey again is a duplicate, not a second account.
  const again = await register(keys.fresh);
  assert.equal(again.status, 409, JSON.stringify(again.json));
  assert.equal(writesTo(userId).length, 1);
});

test('adding a device with the account\'s bearer still appends the passkey to it', async () => {
  assert.ok(freshToken, 'needs the account the previous test created');
  const { userId } = keys.fresh;
  const r = await register(keys.added, { bearer: freshToken });
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], userId);
  await eventually(() => credentialIds(userId).length === 2, 'the added passkey to be written');
  assert.deepEqual(credentialIds(userId), [keys.fresh.id, keys.added.id]);
  assert.equal(pods.get(keys.added.userId), undefined);
});

test('registration options for a bootstrap invite write nothing to the seeded pod, and an unreadable one starts no ceremony', async () => {
  // The options read the seeded pod to check it holds no credential. That read used to write an
  // empty document when the pod had none, before any credential was verified, and left it there
  // when the ceremony was abandoned; a pod that could not be read was taken as an empty account.
  const body = { name: 'New', bootstrapUserId: invite.userId, bootstrapInvite: invite.token };
  blipping.add(invite.userId);
  const down = await post('/auth/webauthn/register-options', body);
  blipping.delete(invite.userId);
  assert.equal(down.status, 503, `${JSON.stringify(down.json)}\n${output}`);
  assert.equal(down.json['challenge'], undefined);
  const abandoned = await post('/auth/webauthn/register-options', body);
  assert.equal(abandoned.status, 200, `${JSON.stringify(abandoned.json)}\n${output}`);
  // A deferred write would land after the response; give it the time one takes.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(writesTo(invite.userId), []);
  assert.equal(pods.has(invite.userId), false);
});

test('a bootstrap invite still claims its seeded account with a passkey', async () => {
  const r = await register(keys.bootstrap, { bootstrap: invite });
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], invite.userId);
  await eventually(() => credentialIds(invite.userId).length === 1, 'the bootstrap passkey to be written');
  assert.deepEqual(credentialIds(invite.userId), [keys.bootstrap.id]);
  assert.equal(pods.get(keys.bootstrap.userId), undefined);
});
