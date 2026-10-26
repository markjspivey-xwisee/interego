/**
 * A passkey credential id listed by more than one account, through the routes: server.ts is
 * started as a child process against a stand-in pod server (no live pod), with passkeys from
 * the software authenticator in tests/soft-authenticator.ts.
 *
 * Credential ids are not secret (POST /challenges lists an account's ids to anyone who names
 * it) and a software authenticator registers any id with its own key. So while a victim's
 * account is not loaded, anyone could register the victim's id: the account derived from the
 * id is empty, so a fresh registration creates it. The index used to map the id to whichever
 * account was loaded last, and the other holder's sign-ins then failed, on and off with every
 * load order and refresh. Now every holder is a candidate, and the first whose stored key
 * verifies the assertion wins.
 *
 * This server's index is complete, so a registration is refused only for an id a loaded account
 * holds (or the account derived from the id holds). The victims here are not in the root
 * listing: they stand for a holder this server has not seen, as when the other instance, while
 * a deploy overlapped the two, opened the account after this one listed the pods (or added the
 * passkey to an account after this one read it), or for a copy registered before registrations
 * waited for every account to load. While the index is incomplete nothing is registered at all
 * (tests/incomplete-index-routes.test.ts).
 *
 * The pure half is tests/credential-index.test.ts.
 *
 * Run:
 *   node --test --import tsx tests/credential-multi-holder-routes.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { assertion, attest, recoded, softPasskey, type SoftPasskey } from './soft-authenticator.js';

const now = new Date().toISOString();
// When the owners enrolled: before anyone could copy their credential ids.
const earlier = '2025-01-01T00:00:00.000Z';
const stored = (key: SoftPasskey, createdAt = now, counter = 0) => ({ id: key.id, publicKey: key.cose.toString('base64url'), counter, createdAt });
const account = (userId: string, ...passkeys: SoftPasskey[]) =>
  ({ userId, name: userId, walletAddresses: [], didKeys: [], webAuthnCredentials: passkeys.map(k => stored(k)) });
const enrolled = (userId: string, key: SoftPasskey, createdAt: string, counter = 0) =>
  ({ ...account(userId), webAuthnCredentials: [stored(key, createdAt, counter)] });
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
// A victim's id registered by someone else with a copy of the victim's public key (a public
// key is not secret), so the victim's own signature verifies on both accounts.
const copied = { victim: softPasskey(), victimId: 'u-eth-00000000000d' };
// An owner's id added by someone else to nine accounts of their own, each with its own key.
const crowded = { owner: softPasskey(), ownerId: 'zz-crowd-owner' };
const crowd = Array.from({ length: 9 }, (_, i) => ({ id: `crowd-${i + 1}`, key: sameId(crowded.owner) }));
const eight = softPasskey();     // listed by exactly the cap
const eightIds = Array.from({ length: 8 }, (_, i) => `eight-${8 - i}`);
// One id on two accounts, each with its own key; the earlier-enrolled one is deleted while the
// other's sign-in is reading their records.
const doomed = { key: softPasskey(), id: 'del-x' };
const survivor = { key: sameId(doomed.key), id: 'del-v' };
// One key on two accounts: the earlier holder's stored sign counter is above the counter the
// assertion carries (a replay, or a cloned authenticator), the later holder's (a copy of the
// key registered under the same id) is below it.
const counted = { key: softPasskey(), earliestId: 'cnt-early', laterId: 'cnt-later' };
// The same, but the later holder stores the key in other COSE bytes: whoever registers a copy
// picks its encoding, and the verifier reads both as the same key.
const recodedCopies = (['reordered', 'extra-label'] as const).map(how =>
  ({ how, key: softPasskey(), earliestId: `cnt-${how}-early`, laterId: `cnt-${how}-copy` }));
// A passkey whose account is the one derived from its id (a fresh registration opened it), not
// in this server's listing; someone signed in to an account of their own adds the id with a
// copy of its public key.
const derivedOwner = softPasskey();
const adder = { id: 'u-eth-00000000000e', key: softPasskey() };
// A passkey only the account derived from its id lists, not in this server's listing.
const derivedOnly = softPasskey();
// A Play owner's passkey, and a later copy of its key under its id on another account. The Play
// owner's record is read again from its pod at sign-in.
const play = { key: softPasskey(), id: 'u-try-play-0000000000aa', copyId: 'zz-play-copy' };

const pods = new Map<string, Record<string, unknown>>([
  [race.victimId, account(race.victimId, race.victim)],
  [pair.victimId, account(pair.victimId, pair.victim)],
  [pairAttacker.userId, account(pairAttacker.userId, pairAttacker)],
  [flaky.victimId, account(flaky.victimId, flaky.victim)],
  [flakyAttacker.userId, account(flakyAttacker.userId, flakyAttacker)],
  [copied.victimId, enrolled(copied.victimId, copied.victim, earlier)],
  [crowded.ownerId, enrolled(crowded.ownerId, crowded.owner, earlier)],
  ...crowd.map(({ id, key }) => [id, account(id, key)] as [string, Record<string, unknown>]),
  [doomed.id, enrolled(doomed.id, doomed.key, '2024-01-01T00:00:00.000Z')],
  [survivor.id, enrolled(survivor.id, survivor.key, earlier)],
  ...eightIds.map(id => [id, account(id, eight)] as [string, Record<string, unknown>]),
  [counted.earliestId, enrolled(counted.earliestId, counted.key, earlier, 100)],
  [counted.laterId, enrolled(counted.laterId, counted.key, now, 0)],
  [play.id, enrolled(play.id, play.key, earlier)],
  [play.copyId, enrolled(play.copyId, play.key, now)],
  ...recodedCopies.flatMap(({ how, key, earliestId, laterId }) => [
    [earliestId, enrolled(earliestId, key, earlier, 100)],
    [laterId, { ...account(laterId), webAuthnCredentials: [{ ...stored(key, now, 0), publicKey: recoded(key, how).toString('base64url') }] }],
  ] as Array<[string, Record<string, unknown>]>),
  [derivedOwner.userId, enrolled(derivedOwner.userId, derivedOwner, earlier)],
  [adder.id, enrolled(adder.id, adder.key, earlier)],
  [derivedOnly.userId, enrolled(derivedOnly.userId, derivedOnly, earlier)],
]);
// Only these are in the root listing, so only these load at startup. The others load when a
// targeted sign-in names them (POST /challenges with a userId).
const listed = new Set([pair.victimId, flaky.victimId, crowded.ownerId, ...crowd.map(c => c.id), ...eightIds, doomed.id, survivor.id,
  counted.earliestId, counted.laterId, play.id, play.copyId, ...recodedCopies.flatMap(c => [c.earliestId, c.laterId]), adder.id]);
const failingPuts = new Set<string>([flaky.victimId]);
// Pods whose auth-methods.jsonld a test makes answer 502 for a while, after startup loaded them.
const failingGets = new Set<string>();
const writes: string[] = [];
/** A pod read a test holds until it lets go: `arrived` resolves when the read comes in. */
let heldRead: { userId: string; arrived: () => void; release: Promise<void> } | undefined;

function servePods(req: http.IncomingMessage, res: http.ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...listed].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && req.method === 'GET' && heldRead?.userId === m[1]) {
    const held = heldRead;
    heldRead = undefined;
    held.arrived();
    void held.release.then(() => servePods(req, res));
    return;
  }
  if (m && req.method === 'GET') {
    if (failingGets.has(m[1]!)) { res.writeHead(502).end(); return; }
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

// Each test arrives from its own address (the server trusts one proxy hop), so the per-IP
// auth-enroll budget (30 a minute) is not shared across the whole file.
let clientAddr = 0;
beforeEach(() => { clientAddr++; });
async function post(path: string, body: unknown, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${clientAddr}`, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Record<string, unknown> };
}

/** A registration: fresh (the account is derived from the credential id), or added with a bearer. */
async function register(key: SoftPasskey, bearer?: string) {
  const options = await post('/auth/webauthn/register-options', { name: 'New' }, bearer);
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
async function signIn(key: SoftPasskey, userId?: string, counter = ++signCount) {
  const ch = await challenge(userId);
  const rpId = String(ch['rpId'] ?? new URL(base).hostname);
  return post('/auth/webauthn/authenticate', { response: assertion(key, String(ch['nonce']), base, rpId, counter) });
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

test('a victim\'s passkey id registered by someone else while the victim was not in this server\'s listing: both sign in to their own accounts', async () => {
  // The index is complete and no loaded account holds the id, so the registration creates the
  // empty derived account.
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

test('a later copy of the victim\'s public key under the victim\'s id does not take the victim\'s sign-in', async () => {
  // The derived account is created with the victim's own public key: 'none' attestation proves
  // nothing about the private key. The victim's signature now verifies on both accounts.
  const copy = { ...copied.victim };
  const r = await register(copy);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], copied.victim.userId);
  await challenge(copied.victimId);
  // Once loaded, the victim's account, which enrolled the id first, is tried first, every time.
  await signsInTo(copied.victim, copied.victimId);
  await signsInTo(copied.victim, copied.victimId);
  assert.equal(writesTo(copied.victim.userId), 1);   // its creation, never a sign-in counter
});

test('holders of equal standing are tried in id order, up to the cap', async () => {
  await signsInTo(eight, 'eight-1');
});

test('an id on more accounts than the cap still signs its owner in: the earliest-enrolled are tried', async () => {
  await signsInTo(crowded.owner, crowded.ownerId);
  // The owner, then crowd-1..crowd-7, are tried; past the cap, nothing is.
  await signsInTo(crowd[0]!.key, 'crowd-1');
  const past = await signIn(crowd[7]!.key);
  assert.equal(past.status, 401, JSON.stringify(past.json));
  assert.equal(past.json['token'], undefined);
  assert.ok(output.split('\n').some(l => /kind=webauthn holders=10 tried=8$/.test(l.trim())), output);
});

test('a holder deleted while a sign-in reads the records is skipped, not reported as the deleted account', async () => {
  // A token for the earlier-enrolled holder, so it can be deleted mid-request.
  const token = await signIn(doomed.key);
  assert.equal(token.status, 200, JSON.stringify(token.json));
  assert.equal(token.json['userId'], doomed.id);
  // Wait out the auth-methods cache, so the sign-in below reads both records from their pods.
  await new Promise(resolve => setTimeout(resolve, 10_500));
  let arrived!: () => void;
  let release!: () => void;
  const reading = new Promise<void>(resolve => { arrived = resolve; });
  heldRead = { userId: survivor.id, arrived, release: new Promise<void>(resolve => { release = resolve; }) };
  const signingIn = signIn(survivor.key);
  await reading;
  const del = await fetch(`${base}/users/me/delete`, {
    method: 'POST', headers: { Authorization: `Bearer ${String(token.json['token'])}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(del.status, 200, await del.text());
  release();
  const r = await signingIn;
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['userId'], survivor.id);
});

test('a holder that refuses an assertion for its sign counter does not hand it to a later holder of the same key', async () => {
  // The earlier holder refuses counter 50 (its own is 100) before it checks the signature; the
  // later one, storing the same key with counter 0, would accept it and record 50.
  const before = { earliest: writesTo(counted.earliestId), later: writesTo(counted.laterId) };
  const r = await signIn(counted.key, undefined, 50);
  assert.equal(r.status, 401, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  assert.equal(writesTo(counted.laterId), before.later);
  assert.equal(writesTo(counted.earliestId), before.earliest);
  // Above the earlier holder's counter, the assertion signs in to it.
  const ok = await signIn(counted.key, undefined, 101);
  assert.equal(ok.status, 200, `${JSON.stringify(ok.json)}\n${output}`);
  assert.equal(ok.json['userId'], counted.earliestId);
  assert.equal(writesTo(counted.laterId), before.later);
});

test('a Play owner whose pod cannot be read stops the sign-in: no later holder of its key takes it', async () => {
  failingGets.add(play.id);
  const before = { owner: writesTo(play.id), copy: writesTo(play.copyId) };
  const r = await signIn(play.key);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  assert.equal(r.json['userId'], undefined);
  assert.equal(writesTo(play.copyId), before.copy);
  assert.equal(writesTo(play.id), before.owner);
  // Readable again, it signs in to the Play owner.
  failingGets.delete(play.id);
  await signsInTo(play.key, play.id);
  assert.equal(writesTo(play.copyId), before.copy);
});

test('a later copy of the key in other COSE bytes is still the same key: it does not take an assertion the earlier holder refused', async () => {
  for (const { how, key, earliestId, laterId } of recodedCopies) {
    const before = { earliest: writesTo(earliestId), later: writesTo(laterId) };
    const r = await signIn(key, undefined, 50);
    assert.equal(r.status, 401, `${how}: ${JSON.stringify(r.json)}\n${output}`);
    assert.equal(r.json['token'], undefined);
    assert.equal(writesTo(laterId), before.later, how);
    assert.equal(writesTo(earliestId), before.earliest, how);
    const ok = await signIn(key, undefined, 101);
    assert.equal(ok.status, 200, `${how}: ${JSON.stringify(ok.json)}\n${output}`);
    assert.equal(ok.json['userId'], earliestId);
    assert.equal(writesTo(laterId), before.later, how);
  }
});

test('a passkey id its unlisted derived account holds is not added to another account with a copy of its key', async () => {
  const signedIn = await signIn(adder.key);
  assert.equal(signedIn.status, 200, `${JSON.stringify(signedIn.json)}\n${output}`);
  assert.equal(signedIn.json['userId'], adder.id);
  const before = { adder: writesTo(adder.id), owner: writesTo(derivedOwner.userId) };
  // Only the id and the public key: 'none' attestation proves nothing about the private key.
  const r = await register({ ...derivedOwner }, String(signedIn.json['token']));
  assert.equal(r.status, 409, `${JSON.stringify(r.json)}\n${output}`);
  assert.equal(r.json['token'], undefined);
  await new Promise(resolve => setTimeout(resolve, 300));   // a deferred write would land by now
  assert.equal(writesTo(adder.id), before.adder);
  assert.equal(writesTo(derivedOwner.userId), before.owner);
  assert.equal((pods.get(adder.id)!['webAuthnCredentials'] as unknown[]).length, 1);
  // The owner's usernameless sign-in lands in the owner's account.
  await signsInTo(derivedOwner, derivedOwner.userId);
});

test('a passkey no loaded account lists signs in to the account derived from its id, which lists it but was not loaded', async () => {
  await signsInTo(derivedOnly, derivedOnly.userId);
  await signsInTo(derivedOnly, derivedOnly.userId);
});
