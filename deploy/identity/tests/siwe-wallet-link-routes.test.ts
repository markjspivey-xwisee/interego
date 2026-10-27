/**
 * Wallet proofs outside POST /auth/siwe, through the routes: server.ts is started as a child
 * process against a stand-in pod server (no live pod).
 *
 * POST /siwe/verify issued a ReadWrite token for a wallet's account after checking only that a
 * signature over ANY message containing the address recovered to it: no server nonce, nothing
 * consumed, no domain. One message the wallet had signed anywhere (a sign-in to another site, a
 * post) could be replayed for a token to that wallet's account. It is retired (410), as is
 * POST /siwe/nonce, whose random bytes nothing stored.
 *
 * POST /wallet/link took a signature by the wallet over any message, and linked a wallet that
 * another account already held. With one message signed by a victim's wallet, an attacker
 * could attach that wallet to the attacker's own account. It now requires a nonce from
 * POST /challenges (purpose 'siwe'), consumes it, requires the ERC-4361 message to name this
 * server and the wallet and to carry the nonce, and refuses a wallet another account holds.
 *
 * POST /auth/siwe consumed a server nonce but never read the message's domain line, so a nonce
 * an attacker fetched from /challenges and put in their own site's sign-in prompt came back as
 * a sign-in here. Its bearer add-wallet branch bound a wallet missing from the index to the
 * bearer's account without asking whether an account whose pod was not read holds it.
 *
 * Run:
 *   node --test --import tsx tests/siwe-wallet-link-routes.test.ts
 */

import { test, before, after, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { deriveUserIdFromWallet } from '../derive-userid.js';
import { closeServer, stopChild } from './teardown.js';

const now = new Date().toISOString();
type Signer = { address: string; signMessage(message: string): Promise<string> };
const walletUser = (w: { address: string }) => deriveUserIdFromWallet(w.address.toLowerCase());
const lower = (w: { address: string }) => w.address.toLowerCase();

// ── Credentials ──
const victim = Wallet.createRandom();        // its own account, listed
const unlisted = Wallet.createRandom();      // its own account, on its pod but not in the root listing
const addedElsewhere = Wallet.createRandom(); // added to a passkey account, listed
const linker = Wallet.createRandom();        // opens an account, then links other wallets to it
const otherSigner = Wallet.createRandom();   // signs in to a second, unrelated account
const unlistedForSiwe = Wallet.createRandom(); // like `unlisted`, for the /auth/siwe bearer branch
const unreadableForLink = Wallet.createRandom(); // its own account's pod answers 500
const unreadableForSiwe = Wallet.createRandom(); // the same, for the /auth/siwe bearer branch
const passkeyAccount = 'u-pk-0123456789ab';
const unreadablePod = 'u-pk-ba9876543210'; // listed, answers 500: the second server's index never completes

// ── Pods ──
const pods = new Map<string, Record<string, unknown>>([
  [walletUser(victim), { userId: walletUser(victim), name: 'Victim', walletAddresses: [lower(victim)], webAuthnCredentials: [], didKeys: [] }],
  [walletUser(unlisted), { userId: walletUser(unlisted), name: 'Unlisted', walletAddresses: [lower(unlisted)], webAuthnCredentials: [], didKeys: [] }],
  [walletUser(unlistedForSiwe), { userId: walletUser(unlistedForSiwe), name: 'Unlisted 2', walletAddresses: [lower(unlistedForSiwe)], webAuthnCredentials: [], didKeys: [] }],
  [passkeyAccount, { userId: passkeyAccount, name: 'Passkey', walletAddresses: [lower(addedElsewhere)], didKeys: [],
    webAuthnCredentials: [{ id: 'cred-passkey-account', publicKey: 'AA', counter: 0, createdAt: now }] }],
]);
// Only these are in the root listing, so only these are in the wallet index at startup.
const listed = new Set([walletUser(victim), passkeyAccount]);
// The second server's listing adds a pod that cannot be read, so its index stays incomplete.
const listedIncomplete = new Set([...listed, unreadablePod]);
// Pods whose auth-methods.jsonld answers 500.
const failing = new Set([walletUser(unreadableForLink), walletUser(unreadableForSiwe), unreadablePod]);
const snapshot = (userId: string) => JSON.stringify(pods.get(userId) ?? null);

const servePods = (listed: ReadonlySet<string>) => (req: http.IncomingMessage, res: http.ServerResponse): void => {
  const path = new URL(req.url ?? '/', 'http://pods').pathname;
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/turtle' });
    res.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> .\n<> ldp:contains ${[...listed].map(p => `<${p}/>`).join(', ')} .\n`);
    return;
  }
  const m = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
  if (m && failing.has(m[1]!)) { res.writeHead(500).end(); return; }
  if (m && req.method === 'GET') {
    const doc = pods.get(m[1]!);
    if (!doc) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/ld+json' });
    res.end(JSON.stringify(doc));
    return;
  }
  if (m && req.method === 'PUT') {
    const userId = m[1]!;
    const ifNoneMatch = req.headers['if-none-match'];
    let body = '';
    req.on('data', d => { body += String(d); });
    req.on('end', () => {
      if (ifNoneMatch === '*' && pods.has(userId)) { res.writeHead(412).end(); return; }
      pods.set(userId, JSON.parse(body) as Record<string, unknown>);
      res.writeHead(201).end();
    });
    return;
  }
  if (req.method === 'PUT') { res.writeHead(201).end(); return; }
  res.writeHead(404).end();
};

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
let host = '';
const output = { text: '' };
// A second server whose account index never completes (one listed pod answers 500).
let podServer2: http.Server;
let identity2: ChildProcess;
let base2 = '';
const output2 = { text: '' };

/** server.ts as a child process over the pod server on `podPort`, once /health answers. */
async function startIdentity(podPort: number, sink: { text: string }, ready: (h: { complete: boolean }) => boolean, extraEnv: (port: number) => Record<string, string> = () => ({})) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['IDENTITY_INTROSPECTION_SECRET', 'TEST_AGENT_PATTERN', 'CSS_PUBLIC_URL', 'BOOTSTRAP_INVITES', 'PROVISIONAL_PLAY_CLIENTS', 'RELAY_PUBLIC_URL', 'SIWE_DOMAINS', 'WEBAUTHN_RP_ORIGINS', 'WEBAUTHN_RP_ORIGIN']) delete env[k];
  Object.assign(env, {
    PORT: String(port), BASE_URL: url, CSS_URL: `http://127.0.0.1:${podPort}/`, RELAY_URL: 'http://relay.invalid',
    TOKEN_SIGNING_KEY: crypto.randomBytes(32).toString('base64'), JANITOR_INTERVAL_MS: '0',
  }, extraEnv(port));
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', d => { sink.text += String(d); });
  proc.stderr!.on('data', d => { sink.text += String(d); });
  const deadline = Date.now() + 60_000;
  try {
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`identity server exited ${proc.exitCode}:\n${sink.text}`);
      try {
        const health = await (await fetch(`${url}/health`)).json() as { accountIndex: { complete: boolean } };
        if (ready(health.accountIndex)) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) throw new Error(`identity server did not start:\n${sink.text}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (err) {
    // No caller holds `proc` yet, so no after() hook could stop it: a live child would keep
    // this file's process (and the whole run) waiting for ever.
    await stopChild(proc);
    throw err;
  }
  return { proc, url };
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return postTo(base, path, body, headers);
}
// Each test arrives from its own address (the server trusts one proxy hop), so the per-IP
// auth-enroll budget (30 a minute) is not shared across the whole file.
let clientAddr = 0;
beforeEach(() => { clientAddr++; });
async function postTo(server: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${server}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${clientAddr}`, ...headers }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { body: text }; }
  return { status: r.status, json };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const siweNonce = async (server = base) => (await postTo(server, '/challenges', { purpose: 'siwe' })).json['nonce'] as string;

/** An ERC-4361 message by `address` for `domain`, carrying `nonce`. */
function siweMessage(domain: string, address: string, nonce: string, o: { uri?: string; issuedAt?: string } = {}): string {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address, '', 'Link this wallet to my Interego account.', '',
    `URI: ${o.uri ?? `http://${domain}`}`, 'Version: 1', 'Chain ID: 1', `Nonce: ${nonce}`, `Issued At: ${o.issuedAt ?? new Date().toISOString()}`,
  ].join('\n');
}

/** Wallet sign-in the supported way: a /challenges nonce, then /auth/siwe (with a bearer, add-wallet). */
async function signIn(w: Signer, opts: { server?: string; token?: string; domain?: string } = {}) {
  const server = opts.server ?? base;
  const nonce = await siweNonce(server);
  const message = siweMessage(opts.domain ?? new URL(server).host, w.address, nonce);
  return postTo(server, '/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'Someone' },
    opts.token ? bearer(opts.token) : {});
}

/** POST /wallet/link for `w`, signed by `w`, with a fresh nonce unless one is given. */
async function link(token: string, w: Signer, opts: { nonce?: string | null; signedNonce?: string; domain?: string } = {}) {
  const nonce = opts.nonce === undefined ? await siweNonce() : opts.nonce;
  const siwe = siweMessage(opts.domain ?? host, w.address, opts.signedNonce ?? nonce ?? 'none');
  const body: Record<string, unknown> = { walletAddress: w.address, siweMessage: siwe, signature: await w.signMessage(siwe) };
  if (nonce !== null) body['nonce'] = nonce;
  return { ...(await post('/wallet/link', body, bearer(token))), body };
}

let linkerToken = '';
let linkerId = '';

before(async () => {
  const pods1 = await listen(servePods(listed));
  podServer = pods1.server;
  const started = await startIdentity(pods1.port, output, h => h.complete);
  identity = started.proc;
  base = started.url;
  host = new URL(base).host;
  const pods2 = await listen(servePods(listedIncomplete));
  podServer2 = pods2.server;
  // Its index is incomplete from the start and stays so: no need to wait for the first pass.
  const started2 = await startIdentity(pods2.port, output2, () => true);
  identity2 = started2.proc;
  base2 = started2.url;
  const opened = await signIn(linker);
  assert.equal(opened.status, 200, `${JSON.stringify(opened.json)}\n${output.text}`);
  linkerToken = String(opened.json['token']);
  linkerId = String(opened.json['userId']);
  assert.equal(linkerId, walletUser(linker));
});

after(async () => {
  await Promise.all([stopChild(identity), stopChild(identity2)]);
  await Promise.all([closeServer(podServer), closeServer(podServer2)]);
});

test('a message the victim\'s wallet signed for another site, replayed to /siwe/verify, gets 410 and no token', async () => {
  const message = siweMessage('other-site.example', victim.address, 'their-own-nonce');
  const r = await post('/siwe/verify', { message, signature: await victim.signMessage(message) });
  assert.equal(r.status, 410, JSON.stringify(r.json));
  assert.equal(r.json['token'], undefined);
  assert.equal(r.json['userId'], undefined);
  assert.equal(r.json['valid'], undefined);
  assert.match(JSON.stringify(r.json), /\/challenges/);
  assert.match(JSON.stringify(r.json), /\/auth\/siwe/);
  // A request that would not even have verified gets the same answer: nothing is checked.
  assert.equal((await post('/siwe/verify', {})).status, 410);
});

test('/siwe/nonce is retired too and hands out nothing', async () => {
  const r = await post('/siwe/nonce', {});
  assert.equal(r.status, 410, JSON.stringify(r.json));
  assert.equal(r.json['nonce'], undefined);
});

test('/wallet/link without a nonce is 400 and links nothing', async () => {
  const w = Wallet.createRandom();
  const before = snapshot(linkerId);
  const r = await link(linkerToken, w, { nonce: null });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(String(r.json['error']), /nonce/);
  assert.equal(snapshot(linkerId), before);
});

test('/wallet/link with a nonce this server never issued, or one of another purpose, is 401', async () => {
  const w = Wallet.createRandom();
  const before = snapshot(linkerId);
  const invented = await link(linkerToken, w, { nonce: crypto.randomBytes(32).toString('base64url') });
  assert.equal(invented.status, 401, JSON.stringify(invented.json));
  const didNonce = (await post('/challenges', { purpose: 'did-sig' })).json['nonce'] as string;
  const wrongPurpose = await link(linkerToken, w, { nonce: didNonce });
  assert.equal(wrongPurpose.status, 401, JSON.stringify(wrongPurpose.json));
  assert.equal(snapshot(linkerId), before);
});

test('/wallet/link with a message that does not carry the nonce, or names another host, is 400', async () => {
  const w = Wallet.createRandom();
  const before = snapshot(linkerId);
  const lacksNonce = await link(linkerToken, w, { signedNonce: 'someOtherNonce1234' });
  assert.equal(lacksNonce.status, 400, JSON.stringify(lacksNonce.json));
  assert.match(String(lacksNonce.json['error']), /nonce/);
  const otherHost = await link(linkerToken, w, { domain: 'other-site.example' });
  assert.equal(otherHost.status, 400, JSON.stringify(otherHost.json));
  assert.match(String(otherHost.json['error']), /not addressed to this server/);
  // The host only in the statement is not enough: the domain line is what the wallet showed.
  const nonce = await siweNonce();
  const siwe = siweMessage('other-site.example', w.address, nonce).replace('Link this wallet', `Link this wallet at ${host}`);
  const statementOnly = await post('/wallet/link', { walletAddress: w.address, siweMessage: siwe, signature: await w.signMessage(siwe), nonce }, bearer(linkerToken));
  assert.equal(statementOnly.status, 400, JSON.stringify(statementOnly.json));
  assert.equal(snapshot(linkerId), before);
});

test('/wallet/link refuses with 409 a wallet another account holds, indexed or only on its pod', async () => {
  for (const [w, holder] of [[victim, walletUser(victim)], [addedElsewhere, passkeyAccount], [unlisted, walletUser(unlisted)]] as const) {
    const before = snapshot(linkerId);
    const r = await link(linkerToken, w);
    assert.equal(r.status, 409, `${holder}: ${JSON.stringify(r.json)}\n${output.text}`);
    assert.match(String(r.json['error']), /registered to another account/);
    assert.equal(snapshot(linkerId), before);
    // The wallet still signs in to the account that holds it.
    const signedIn = await signIn(w);
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
    assert.equal(signedIn.json['userId'], holder);
  }
});

test('a correct link is 200, the wallet then signs in to the linking account, and its nonce is spent', async () => {
  const w = Wallet.createRandom();
  const r = await link(linkerToken, w);
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output.text}`);
  assert.equal(r.json['linked'], true);
  assert.equal(r.json['userId'], linkerId);
  assert.ok((pods.get(linkerId)!['walletAddresses'] as string[]).includes(lower(w)));
  const signedIn = await signIn(w);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
  assert.equal(signedIn.json['userId'], linkerId);
  // The same request again: its nonce was consumed.
  const replay = await post('/wallet/link', r.body, bearer(linkerToken));
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
  assert.match(String(replay.json['error']), /expired challenge/);
});

test('a linked request replayed by another account, with the nonce it carried, links nothing', async () => {
  const other = await signIn(otherSigner);
  assert.equal(other.status, 200, JSON.stringify(other.json));
  const otherId = String(other.json['userId']);
  const w = Wallet.createRandom();
  const original = await link(linkerToken, w);
  assert.equal(original.status, 200, JSON.stringify(original.json));
  const before = snapshot(otherId);
  const replay = await post('/wallet/link', original.body, bearer(String(other.json['token'])));
  assert.equal(replay.status, 401, JSON.stringify(replay.json));
  assert.equal(snapshot(otherId), before);
  assert.equal((await signIn(w)).json['userId'], linkerId);
});

test('/wallet/link with a message whose second line names another wallet is 400, though the wallet signed it', async () => {
  const w = Wallet.createRandom();
  const before = snapshot(linkerId);
  const nonce = await siweNonce();
  const siwe = siweMessage(host, Wallet.createRandom().address, nonce);
  const r = await post('/wallet/link', { walletAddress: w.address, siweMessage: siwe, signature: await w.signMessage(siwe), nonce }, bearer(linkerToken));
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(String(r.json['error']), /does not name walletAddress/);
  assert.equal(snapshot(linkerId), before);
});

test('/wallet/link is 503 and links nothing while it cannot tell who holds the wallet', async () => {
  // The account the wallet would have opened by itself is on a pod that answers 500.
  const before = snapshot(linkerId);
  const r = await link(linkerToken, unreadableForLink);
  assert.equal(r.status, 503, `${JSON.stringify(r.json)}\n${output.text}`);
  assert.equal(snapshot(linkerId), before);
  // A server that could not read one of its listed pods: its index is incomplete, so it opens
  // no new account, and the bearer is an existing account's.
  const opened = await signIn(victim, { server: base2 });
  assert.equal(opened.status, 200, `${JSON.stringify(opened.json)}\n${output2.text}`);
  const ownerId = String(opened.json['userId']);
  const ownerBefore = snapshot(ownerId);
  const w = Wallet.createRandom();
  const nonce = await siweNonce(base2);
  const siwe = siweMessage(new URL(base2).host, w.address, nonce);
  const r2 = await postTo(base2, '/wallet/link', { walletAddress: w.address, siweMessage: siwe, signature: await w.signMessage(siwe), nonce },
    bearer(String(opened.json['token'])));
  assert.equal(r2.status, 503, `${JSON.stringify(r2.json)}\n${output2.text}`);
  assert.equal(snapshot(ownerId), ownerBefore);
});

test('a /wallet/link request refused before it is checked (a stale bearer) still spends its nonce', async () => {
  const w = Wallet.createRandom();
  const nonce = await siweNonce();
  const message = siweMessage(host, w.address, nonce);
  const signature = await w.signMessage(message);
  const refused = await post('/wallet/link', { walletAddress: w.address, siweMessage: message, signature, nonce }, bearer('not-a-token'));
  assert.equal(refused.status, 401, JSON.stringify(refused.json));
  // Whoever saw that request cannot redeem its message and signature as a sign-in.
  const redeemed = await post('/auth/siwe', { message, signature, nonce });
  assert.equal(redeemed.status, 401, JSON.stringify(redeemed.json));
  assert.equal(redeemed.json['token'], undefined);
  assert.equal(pods.has(walletUser(w)), false);
});

test('/auth/siwe refuses a message the wallet signed for another site, even with a nonce this server issued', async () => {
  // evil.example fetched a nonce from /challenges and put it in its own sign-in prompt; the
  // wallet showed "evil.example wants you to sign in", which matched the page, so it signed.
  const nonce = await siweNonce();
  const message = siweMessage('evil.example', victim.address, nonce);
  const signature = await victim.signMessage(message);
  const r = await post('/auth/siwe', { message, signature, nonce });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(String(r.json['error']), /not addressed to this server/);
  assert.equal(r.json['token'], undefined);
  // Its nonce was spent: the same request cannot be retried.
  assert.equal((await post('/auth/siwe', { message, signature, nonce })).status, 401);
  // This server's host only in the statement is not enough.
  const nonce2 = await siweNonce();
  const statementOnly = siweMessage('evil.example', victim.address, nonce2).replace('Link this wallet', `Sign in at ${host}`);
  const r2 = await post('/auth/siwe', { message: statementOnly, signature: await victim.signMessage(statementOnly), nonce: nonce2 });
  assert.equal(r2.status, 400, JSON.stringify(r2.json));
  assert.equal(r2.json['token'], undefined);
  // The deployment's own front-ends still sign in: this server and its relay (RELAY_URL).
  const own = await signIn(victim);
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.equal(own.json['userId'], walletUser(victim));
  const viaRelay = await signIn(victim, { domain: 'relay.invalid' });
  assert.equal(viaRelay.status, 200, JSON.stringify(viaRelay.json));
  assert.equal(viaRelay.json['userId'], walletUser(victim));
});

test('/auth/siwe with a bearer does not bind a wallet held by an account only on its pod, or one it cannot rule out', async () => {
  // Held by an account whose pod was not in the listing: the wallet signs in to that account.
  const before = snapshot(linkerId);
  const held = await signIn(unlistedForSiwe, { token: linkerToken });
  assert.equal(held.status, 200, `${JSON.stringify(held.json)}\n${output.text}`);
  assert.equal(held.json['userId'], walletUser(unlistedForSiwe));
  assert.equal(snapshot(linkerId), before);
  assert.equal((await signIn(unlistedForSiwe)).json['userId'], walletUser(unlistedForSiwe));
  // The account it would have opened by itself cannot be read: nothing is bound, 503.
  const unreadable = await signIn(unreadableForSiwe, { token: linkerToken });
  assert.equal(unreadable.status, 503, `${JSON.stringify(unreadable.json)}\n${output.text}`);
  assert.equal(unreadable.json['token'], undefined);
  assert.equal(snapshot(linkerId), before);
  // A server whose index is incomplete binds no new wallet to a bearer's account (and opens no
  // new account, so the bearer is an existing account's).
  const opened = await signIn(victim, { server: base2 });
  assert.equal(opened.status, 200, `${JSON.stringify(opened.json)}\n${output2.text}`);
  const ownerId = String(opened.json['userId']);
  const ownerBefore = snapshot(ownerId);
  const added = await signIn(Wallet.createRandom(), { server: base2, token: String(opened.json['token']) });
  assert.equal(added.status, 503, `${JSON.stringify(added.json)}\n${output2.text}`);
  assert.equal(snapshot(ownerId), ownerBefore);
  // A wallet no account holds is still added to the bearer's account on a complete index.
  const fresh = Wallet.createRandom();
  const addFresh = await signIn(fresh, { token: linkerToken });
  assert.equal(addFresh.status, 200, JSON.stringify(addFresh.json));
  assert.equal(addFresh.json['userId'], linkerId);
  assert.equal((await signIn(fresh)).json['userId'], linkerId);
});

test('/challenges for siwe issues a nonce ERC-4361 allows, and returns a sent address in EIP-55 form', async () => {
  // base64url's '-' and '_' are not ERC-4361 nonce characters: a wallet read such a message as
  // no sign-in at all, and skipped its domain check.
  for (let k = 0; k < 8; k++) assert.match(await siweNonce(), /^[A-Za-z0-9]{8,}$/);
  const w = Wallet.createRandom();
  const r = await post('/challenges', { purpose: 'siwe', address: lower(w) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json['address'], w.address);
  assert.equal((await post('/challenges', { purpose: 'siwe', address: 'not-an-address' })).status, 400);
  // A browser page's flow: a lowercase account from the wallet, the checksummed form back, a sign-in.
  const nonce = String(r.json['nonce']);
  const message = siweMessage(host, String(r.json['address']), nonce);
  const signedIn = await post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'Someone' });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
  assert.equal(signedIn.json['userId'], walletUser(w));
});

test('/auth/siwe and /wallet/link refuse text a wallet does not read as a sign-in, though it names this server and carries the nonce', async () => {
  // Each of these passed the old reading (trimmed first line, any `Nonce:` line, no other
  // field) and none is ERC-4361, so a wallet showed it as a plain signature request with no
  // domain warning. Signed on an attacker's page, each was a sign-in to the victim's account.
  const forms: Record<string, (nonce: string) => string> = {
    'a leading byte-order mark': n => '\uFEFF' + siweMessage(host, victim.address, n),
    'a leading space': n => ' ' + siweMessage(host, victim.address, n),
    'no URI, Version, Chain ID or Issued At': n => `${host} wants you to sign in with your Ethereum account:\n${victim.address}\n\nVerify ownership\n\nNonce: ${n}`,
    'the nonce on another line, another value in the Nonce field': n => siweMessage(host, victim.address, 'otherNonce1234').replace('Link this wallet to my Interego account.', `Nonce: ${n}`),
    'a lowercase address': n => siweMessage(host, lower(victim), n),
    'CRLF line ends': n => siweMessage(host, victim.address, n).replace(/\n/g, '\r\n'),
    // A URL constructor takes these; siwe-parser does not (RFC 3986 allows '[' ']' only around
    // an IPv6 host and one '#'; ERC-4361's request-id is *pchar, so no '/' or '?').
    'brackets in the URI path': n => siweMessage(host, victim.address, n, { uri: `http://${host}/[x]` }),
    'a second # in the URI fragment': n => siweMessage(host, victim.address, n, { uri: `http://${host}/#a#b` }),
    'a / in the Request ID': n => `${siweMessage(host, victim.address, n)}\nRequest ID: a/b`,
    'brackets in a resource': n => `${siweMessage(host, victim.address, n)}\nResources:\n- http://${host}/[y]`,
  };
  for (const [name, build] of Object.entries(forms)) {
    const nonce = await siweNonce();
    const message = build(nonce);
    const r = await post('/auth/siwe', { message, signature: await victim.signMessage(message), nonce });
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json['token'], undefined, name);
  }
  // The same through /wallet/link with the attacker's own bearer: nothing is linked.
  const w = Wallet.createRandom();
  const before = snapshot(linkerId);
  for (const [name, build] of Object.entries(forms)) {
    const nonce = await siweNonce();
    const siwe = build(nonce).split(victim.address).join(w.address).split(lower(victim)).join(lower(w));
    const r = await post('/wallet/link', { walletAddress: w.address, siweMessage: siwe, signature: await w.signMessage(siwe), nonce }, bearer(linkerToken));
    assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.json)}`);
  }
  assert.equal(snapshot(linkerId), before);
});

test('/auth/siwe refuses a message whose URI is another site, or whose Issued At does not fit its challenge', async () => {
  const otherUri = await siweNonce();
  const m1 = siweMessage(host, victim.address, otherUri, { uri: 'https://evil.example/login' });
  const r1 = await post('/auth/siwe', { message: m1, signature: await victim.signMessage(m1), nonce: otherUri });
  assert.equal(r1.status, 400, JSON.stringify(r1.json));
  assert.match(String(r1.json['error']), /URI/);
  const stale = await siweNonce();
  const m2 = siweMessage(host, victim.address, stale, { issuedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() });
  const r2 = await post('/auth/siwe', { message: m2, signature: await victim.signMessage(m2), nonce: stale });
  assert.equal(r2.status, 400, JSON.stringify(r2.json));
  assert.match(String(r2.json['error']), /Issued At/);
});

test('the relay host guessed from BASE_URL is not a sign-in domain; RELAY_URL is, and each domain is logged with its source', async () => {
  // BASE_URL acme-identity.<suffix> with RELAY_PUBLIC_URL unset: relayPublicBase() guesses
  // acme-relay.<suffix>, a name that on a shared hosting suffix anyone may register. A page an
  // attacker serves there passes the wallet's domain check, so it must not pass this server's.
  const pods3 = await listen(servePods(listed));
  const sink = { text: '' };
  let proc: ChildProcess | undefined;
  let port = 0;
  try {
    const started = await startIdentity(pods3.port, sink, h => h.complete,
      p => ({ BASE_URL: `http://acme-identity.localhost:${p}`, RELAY_URL: 'http://acme-mcp.invalid' }));
    port = Number(new URL(started.url).port);
    proc = started.proc;
    const w = Wallet.createRandom();
    const guessed = await signIn(w, { server: started.url, domain: `acme-relay.localhost:${port}` });
    assert.equal(guessed.status, 400, `${JSON.stringify(guessed.json)}\n${sink.text}`);
    assert.match(String(guessed.json['error']), /not addressed to this server/);
    const viaRelay = await signIn(w, { server: started.url, domain: 'acme-mcp.invalid' });
    assert.equal(viaRelay.status, 200, `${JSON.stringify(viaRelay.json)}\n${sink.text}`);
    assert.match(sink.text, /acme-identity\.localhost:\d+ \(BASE_URL\)/);
    assert.match(sink.text, /acme-mcp\.invalid \(RELAY_URL\)/);
    assert.doesNotMatch(sink.text.split('\n').find(l => l.includes('SIWE domains')) ?? '', /acme-relay/);
  } finally {
    await stopChild(proc);
    await closeServer(pods3.server);
  }
});
