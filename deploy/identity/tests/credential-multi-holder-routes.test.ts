/**
 * A passkey credential id listed by more than one account, through the routes: server.ts is
 * started as a child process against a stand-in pod server (no live pod), with passkeys from
 * the software authenticator in tests/soft-authenticator.ts.
 *
 * Credential ids are not secret (POST /challenges lists an account's ids to anyone who names
 * it) and a software authenticator registers any id with its own key. So while a victim's
 * account is not loaded, anyone can register the victim's id: the account derived from the
 * id is empty, so a fresh registration creates it. The index used to map the id to whichever
 * account was loaded last, and the other holder's sign-ins then failed, on and off with every
 * load order and refresh. Now every holder is a candidate, and the first whose stored key
 * verifies the assertion wins.
 *
 * The pure half is tests/credential-index.test.ts.
 *
 * Run:
 *   node --test --import tsx tests/credential-multi-holder-routes.test.ts
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
const stored = (key: SoftPasskey) => ({ id: key.id, publicKey: key.cose.toString('base64url'), counter: 0, createdAt: now });
const account = (userId: string, ...passkeys: SoftPasskey[]) =>
  ({ userId, name: userId, walletAddresses: [], didKeys: [], webAuthnCredentials: passkeys.map(stored) });
/** Someone else's passkey with the same credential id. */
const sameId = (key: SoftPasskey) => softPasskey(key.rawId);

// Each victim's passkey sits on an account not derived from its id (added from another
// device, or a wallet account), so the account derived from the id is free to be created.
const race = { victim: softPasskey(), victimId: 'u-eth-00000000000a' };
const raceAttacker = sameId(race.victim);
const pair = { victim: softPasskey(), victimId: 'u-eth-00000000000b' };
const pairAttacker = sameId(pair.victim);
const flaky = { victim: softPasskey(), victimId: 'u-eth-00000000000c' };
const flakyAttacker = sameId(flaky.victim);
const crowded = softPasskey();   // listed by more accounts than the cap
const eight = softPasskey();     // listed by exactly the cap
const crowdIds = Array.from({ length: 9 }, (_, i) => `crowd-${i + 1}`);
const eightIds = Array.from({ length: 8 }, (_, i) => `eight-${8 - i}`);

const pods = new Map<string, Record<string, unknown>>([
  [race.victimId, account(race.victimId, race.victim)],
  [pair.victimId, account(pair.victimId, pair.victim)],
  [pairAttacker.userId, account(pairAttacker.userId, pairAttacker)],
  [flaky.victimId, account(flaky.victimId, flaky.victim)],
  [flakyAttacker.userId, account(flakyAttacker.userId, flakyAttacker)],
  ...crowdIds.map(id => [id, account(id, crowded)] as [string, Record<string, unknown>]),
  ...eightIds.map(id => [id, account(id, eight)] as [string, Record<string, unknown>]),
]);
// Only these are in the root listing, so only these load at startup. The others load when a
// targeted sign-in names them (POST /challenges with a userId).
const listed = new Set([pair.victimId, flaky.victimId, ...crowdIds, ...eightIds]);
const failingPuts = new Set<string>([flaky.victimId]);
const writes: string[] = [];

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...listed].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET') {
    const doc = pods.get(m[1]!);
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
      if (failingPuts.has(userId)) { res.writeHead(500).end(); return; }
      if (ifNoneMatch === '*' && pods.has(userId)) { res.writeHead(412).end(); return; }
      writes.push(userId);
      pods.set(userId, JSON.parse(body) as Record<string, unknown>);
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

/** A fresh registration (no bearer, no invite): the account is derived from the credential id. */
async function register(key: SoftPasskey) {
  const options = await post('/auth/webauthn/register-options', { name: 'New' });
  assert.equal(options.status, 200, JSON.stringify(options.json));
  const rpId = (options.json['rp'] as { id: string }).id;
  return post('/auth/webauthn/register', { response: attest(key, String(options.json['challenge']), base, rpId) });
}

/** A passkey sign-in: usernameless, or targeted at `userId` (which also loads that account). */
let signCount = 0;
async function challenge(userId?: string) {
  const ch = await post('/challenges', { purpose: 'webauthn-authenticate', ...(userId ? { userId } : {}) });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  return ch.json;
}
async function signIn(key: SoftPasskey, userId?: string) {
  const ch = await challenge(userId);
  const rpId = String(ch['rpId'] ?? new URL(base).hostname);
  return post('/auth/webauthn/authenticate', { response: assertion(key, String(ch['nonce']), base, rpId, ++signCount) });
}
async function signsInTo(key: SoftPasskey, userId: string, scope?: string): Promise<void> {
  const r = await signIn(key, scope);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], userId);
  assert.ok(r.json['token']);
}
const writesTo = (userId: string) => writes.filter(w => w === userId).length;

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

test('a victim\'s passkey id registered by someone else while the victim was unloaded: both sign in to their own accounts', async () => {
  // The race itself is unchanged: the derived account is empty, so the registration creates it.
  const r = await register(raceAttacker);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], raceAttacker.userId);
  // The victim's account loads (a targeted sign-in names it) and now both list the id.
  await challenge(race.victimId);
  await signsInTo(race.victim, race.victimId);
  await signsInTo(raceAttacker, raceAttacker.userId);
  await signsInTo(race.victim, race.victimId);
  // The warning carries a count, never an id.
  const warnings = output.split('\n').filter(l => l.includes('identity_credential_multi_holder'));
  assert.ok(warnings.some(l => /kind=webauthn holders=2$/.test(l.trim())), output);
  for (const l of warnings) assert.ok(!l.includes(race.victim.id) && !l.includes(race.victimId), l);
});

test('loaded in the other order, the victim still signs in, and only its counter is written', async () => {
  // The victim's account loaded at startup; the other holder (the id's derived account) loads after.
  await challenge(pairAttacker.userId);
  const before = { victim: writesTo(pair.victimId), attacker: writesTo(pairAttacker.userId) };
  await signsInTo(pair.victim, pair.victimId);
  assert.equal(writesTo(pairAttacker.userId), before.attacker);
  assert.equal(writesTo(pair.victimId), before.victim + 1);
  await signsInTo(pairAttacker, pairAttacker.userId);
});

test('a challenge scoped to one account tries that account only', async () => {
  await signsInTo(pair.victim, pair.victimId, pair.victimId);
  const before = writes.length;
  const other = await signIn(pair.victim, pairAttacker.userId);
  assert.equal(other.status, 401, JSON.stringify(other.json));
  assert.equal(other.json['token'], undefined);
  assert.equal(writes.length, before);
});

test('a counter the verifying account cannot persist is a 503, and no other holder is written', async () => {
  await challenge(flakyAttacker.userId);
  const r = await signIn(flaky.victim);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  assert.equal(writesTo(flakyAttacker.userId), 0);
  assert.equal(writesTo(flaky.victimId), 0);
  failingPuts.delete(flaky.victimId);
  await signsInTo(flaky.victim, flaky.victimId);
});

test('up to the cap, holders are tried in id order; above it the passkey is refused', async () => {
  await signsInTo(eight, 'eight-1');
  const r = await signIn(crowded);
  assert.equal(r.status, 401, JSON.stringify(r.json));
  assert.equal(r.json['token'], undefined);
});
