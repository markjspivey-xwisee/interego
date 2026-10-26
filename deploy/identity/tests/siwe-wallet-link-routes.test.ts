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
 * Run:
 *   node --test --import tsx tests/siwe-wallet-link-routes.test.ts
 */

import { test, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { deriveUserIdFromWallet } from '../derive-userid.js';

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
const passkeyAccount = 'u-pk-0123456789ab';

// ── Pods ──
const pods = new Map<string, Record<string, unknown>>([
  [walletUser(victim), { userId: walletUser(victim), name: 'Victim', walletAddresses: [lower(victim)], webAuthnCredentials: [], didKeys: [] }],
  [walletUser(unlisted), { userId: walletUser(unlisted), name: 'Unlisted', walletAddresses: [lower(unlisted)], webAuthnCredentials: [], didKeys: [] }],
  [passkeyAccount, { userId: passkeyAccount, name: 'Passkey', walletAddresses: [lower(addedElsewhere)], didKeys: [],
    webAuthnCredentials: [{ id: 'cred-passkey-account', publicKey: 'AA', counter: 0, createdAt: now }] }],
]);
// Only these are in the root listing, so only these are in the wallet index at startup.
const listed = new Set([walletUser(victim), passkeyAccount]);
const snapshot = (userId: string) => JSON.stringify(pods.get(userId) ?? null);

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
let host = '';
let output = '';

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { body: text }; }
  return { status: r.status, json };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const siweNonce = async () => (await post('/challenges', { purpose: 'siwe' })).json['nonce'] as string;

/** An ERC-4361 message by `address` for `domain`, carrying `nonce`. */
function siweMessage(domain: string, address: string, nonce: string): string {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address, '', 'Link this wallet to my Interego account.', '',
    `URI: http://${domain}`, 'Version: 1', 'Chain ID: 1', `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
}

/** Wallet sign-in the supported way: a /challenges nonce, then /auth/siwe. */
async function signIn(w: Signer) {
  const nonce = await siweNonce();
  const message = siweMessage(host, w.address, nonce);
  return post('/auth/siwe', { message, signature: await w.signMessage(message), nonce, name: 'Someone' });
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
  const opened = await signIn(linker);
  assert.equal(opened.status, 200, `${JSON.stringify(opened.json)}\n${output}`);
  linkerToken = String(opened.json['token']);
  linkerId = String(opened.json['userId']);
  assert.equal(linkerId, walletUser(linker));
});

after(async () => {
  identity?.kill('SIGTERM');
  await new Promise<void>(resolve => podServer?.close(() => resolve()));
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
  const lacksNonce = await link(linkerToken, w, { signedNonce: 'some-other-nonce' });
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
    assert.equal(r.status, 409, `${holder}: ${JSON.stringify(r.json)}\n${output}`);
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
  assert.equal(r.status, 200, `${JSON.stringify(r.json)}\n${output}`);
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
