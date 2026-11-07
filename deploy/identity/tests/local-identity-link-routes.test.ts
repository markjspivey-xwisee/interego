import { after, before, beforeEach, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createProbe, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { Wallet } from 'ethers';
import { assertion, softPasskey } from './soft-authenticator.js';
import { closeServer, stopChild } from './teardown.js';
import { deriveUserIdFromDid } from '../derive-userid.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Route fixtures exercise deliberately untyped JSON responses.
type RecordValue = Record<string, any>;
const wallet = Wallet.createRandom(); const ownerId = 'u-pk-existing-game-owner';
const passkey = softPasskey(); const relayPasskey = softPasskey();
const otherId = 'u-pk-other-existing-owner';
const pods = new Map<string, RecordValue>(); const revisions = new Map<string, number>();
const unlistedPods = new Set<string>();
const writes: Array<{ path: string; condition?: string; body: RecordValue }> = [];
const progress = JSON.stringify({ ownerDid: 'unchanged-owner', checkpoint: 17, inventory: ['existing-progress'] });
let identity: ChildProcess; let store: Server; let base = ''; let relayOrigin = ''; let podBase = ''; let output = ''; let bearer = '';
let refuseWrite = false; let applyFailedWrite = false; let noEtag = false; let conflict = false; let brokenOwner: string | undefined;
function nativeKey() {
  const pair = generateKeyPairSync('ed25519'); const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  let number = BigInt('0x' + Buffer.concat([Buffer.from([0xed, 1]), raw]).toString('hex')); let encoded = ''; const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while (number) { encoded = alphabet[Number(number % 58n)] + encoded; number /= 58n; }
  return { did: 'did:key:z' + encoded, multibase: 'z' + encoded, privateKey: pair.privateKey };
}
async function freePort(): Promise<number> {
  const probe = createProbe(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve())); return port;
}
function fixtureAccount() {
  return { userId: ownerId, name: 'Existing game owner', walletAddresses: [wallet.address.toLowerCase()], didKeys: [], sessionEpoch: 0,
    webAuthnCredentials: [{ id: passkey.id, publicKey: passkey.cose.toString('base64url'), counter: 0, createdAt: new Date().toISOString(), rpId: '127.0.0.1', rpOrigin: base },
      { id: relayPasskey.id, publicKey: relayPasskey.cose.toString('base64url'), counter: 0, createdAt: new Date().toISOString(), rpId: '127.0.0.1', rpOrigin: relayOrigin }],
    applicationOwnedField: { preserve: 'not auth-owned' } };
}
async function post(path: string, body: unknown, options: { token?: string; origin?: string } = {}) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
    ...(options.origin === undefined ? {} : { origin: options.origin }) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as RecordValue };
}
const dashboard = (path: string, body: unknown, token = bearer) => post('/local-identity/link/' + path, body, { token, origin: base });
async function walletStart() {
  const prepared = await dashboard('prepare', { method: 'wallet', address: wallet.address, chainId: 1 }); assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
  const started = await dashboard('start', { stepUpId: prepared.body.stepUpId, signature: await wallet.signMessage(prepared.body.message) }); assert.equal(started.status, 200, JSON.stringify(started.body));
  return started.body;
}
async function context(key: ReturnType<typeof nativeKey>) {
  const started = await walletStart(); const response = await post('/local-identity/link/context', { handoffCode: started.handoffCode, did: key.did });
  assert.equal(response.status, 200, JSON.stringify(response.body)); return { started, context: response.body };
}
const complete = (key: ReturnType<typeof nativeKey>, ctx: RecordValue, signature = sign(null, Buffer.from(ctx.message), key.privateKey).toString('base64url')) =>
  post('/local-identity/link/complete', { completionCode: ctx.completionCode, did: key.did, nonce: ctx.nonce, signature });

before(async () => {
  base = `http://127.0.0.1:${await freePort()}`; relayOrigin = `http://127.0.0.1:${await freePort()}`;
  pods.set(ownerId, fixtureAccount()); pods.set(otherId, { userId: otherId, name: 'Other owner', walletAddresses: [], didKeys: [], webAuthnCredentials: [] }); revisions.set(ownerId, 1); revisions.set(otherId, 1);
  store = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://pods').pathname;
    if (path === '/') { response.writeHead(200, { 'content-type': 'text/turtle' }); response.end(`@prefix ldp: <http://www.w3.org/ns/ldp#> . <> ldp:contains ${[...pods.keys()].filter(id => !unlistedPods.has(id)).map(id => `<${id}/>`).join(', ')} .`); return; }
    if (path === `/${ownerId}/hallowmarch/progress.json`) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(progress); return; }
    const matched = /^\/([^/]+)\/auth-methods\.jsonld$/.exec(path);
    if (matched && request.method === 'GET') {
      const id = matched[1]!; if (id === brokenOwner) { response.writeHead(503).end(); return; } const record = pods.get(id);
      if (!record) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/ld+json', ...(noEtag ? {} : { etag: `"revision-${revisions.get(id) ?? 1}"` }) }); response.end(JSON.stringify(record)); return;
    }
    if (matched && request.method === 'PUT') {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const id = matched[1]!;
      if (conflict) { conflict = false; const current = pods.get(id)!; current.concurrentChange = 'preserved'; revisions.set(id, (revisions.get(id) ?? 1) + 1); response.writeHead(412).end(); return; }
      if (request.headers['if-match'] !== `"revision-${revisions.get(id) ?? 1}"`) { response.writeHead(412).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as RecordValue;
      writes.push({ path, condition: request.headers['if-match'] as string, body });
      if (!refuseWrite || applyFailedWrite) { pods.set(id, body); revisions.set(id, (revisions.get(id) ?? 1) + 1); }
      response.writeHead(refuseWrite ? 503 : 201).end(); return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => store.listen(0, '127.0.0.1', resolve)); podBase = `http://127.0.0.1:${(store.address() as AddressInfo).port}/`;
});
async function startIdentity(authenticateWallet = true) {
  const env = { ...process.env, PORT: new URL(base).port, BASE_URL: base, CSS_URL: podBase, CSS_PUBLIC_URL: 'https://pods.example.com/', RELAY_URL: relayOrigin, RELAY_PUBLIC_URL: relayOrigin,
    WEBAUTHN_RP_ORIGINS: `${base},${relayOrigin}`, TOKEN_SIGNING_KEY: randomBytes(32).toString('base64'), JANITOR_INTERVAL_MS: '0', UNCONFIRMED_SETTLE_MS: '0' };
  identity = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
  identity.stdout!.on('data', chunk => { output = (output + String(chunk)).slice(-20_000); }); identity.stderr!.on('data', chunk => { output = (output + String(chunk)).slice(-20_000); });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (identity.exitCode !== null) throw new Error(output);
    try { const health = await (await fetch(base + '/health')).json() as RecordValue; if (health.accountIndex.complete) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Identity fixture did not become ready: ' + output); await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!authenticateWallet) return;
  const challenge = (await post('/challenges', { purpose: 'siwe' })).body;
  const message = `${new URL(base).host} wants you to sign in with your Ethereum account:\n${wallet.address}\n\nSign in to Interego.\n\nURI: ${base}\nVersion: 1\nChain ID: 1\nNonce: ${challenge.nonce}\nIssued At: ${new Date().toISOString()}`;
  const signed = await post('/auth/siwe', { message, nonce: challenge.nonce, signature: await wallet.signMessage(message) }, { origin: base }); assert.equal(signed.status, 200, JSON.stringify(signed.body)); bearer = signed.body.token;
}
beforeEach(async () => {
  await stopChild(identity); pods.set(ownerId, fixtureAccount()); revisions.set(ownerId, (revisions.get(ownerId) ?? 0) + 1);
  writes.splice(0); unlistedPods.clear(); refuseWrite = false; applyFailedWrite = false; noEtag = false; conflict = false; brokenOwner = undefined; output = '';
  await startIdentity();
});
after(async () => { await stopChild(identity); await closeServer(store); });

async function returningLogin() {
  let cookie = '';
  const request = async (path: string, body: unknown, rp = false) => {
    const response = await fetch(base + '/local-identity/login/' + path, { method: 'POST', headers: { 'content-type': 'application/json',
      origin: rp ? relayOrigin : base, 'sec-fetch-site': rp ? 'same-site' : 'same-origin', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const result = { status: response.status, body: await response.json() as RecordValue };
    if (path === 'start' && response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return result;
  };
  const start = await request('start', {}); assert.equal(start.status, 200, JSON.stringify(start.body));
  const loginCode = new URL(start.body.authorizationUrl).hash.slice(1);
  const context = await request('context', { loginCode }, true); assert.equal(context.status, 200, JSON.stringify(context.body));
  const response = assertion(relayPasskey, context.body.options.challenge, relayOrigin, '127.0.0.1', 1);
  return { request, start: start.body, context: context.body, response,
    complete: () => request('complete', { completionCode: context.body.completionCode, response }, true),
    result: () => request('result', { receipt: start.body.receipt }) };
}

test('a relay-only returning passkey starts with no identity session, then links the local key to the same owner without changing progress', async () => {
  await stopChild(identity);
  const existing = fixtureAccount(); existing.walletAddresses = []; existing.webAuthnCredentials = existing.webAuthnCredentials.slice(1);
  pods.set(ownerId, existing); revisions.set(ownerId, revisions.get(ownerId)! + 1); writes.splice(0); bearer = '';
  await startIdentity(false);
  const flow = await returningLogin();
  // This dedicated proof cannot be exchanged through the generic login route.
  assert.equal((await post('/auth/webauthn/authenticate', { response: flow.response }, { origin: relayOrigin })).status, 401);
  assert.deepEqual((await flow.complete()).body, { verified: true });
  const loggedIn = await flow.result(); assert.equal(loggedIn.status, 200, JSON.stringify(loggedIn.body));
  assert.equal(loggedIn.body.userId, ownerId); assert.equal(loggedIn.body.did, `did:web:${new URL(base).host}:users:${ownerId}`);
  assert.equal(loggedIn.body.podUrl, `https://pods.example.com/${ownerId}/`); bearer = loggedIn.body.token;
  assert.equal((await flow.result()).status, 401);
  // A normal login session still cannot add a native key without another fresh
  // action-bound proof and separate native owner approval.
  assert.equal((await dashboard('start', {})).status, 400);
  const prepared = await dashboard('prepare', { method: 'passkey', rpOrigin: relayOrigin }); assert.equal(prepared.status, 200);
  const stepUpCode = new URL(prepared.body.stepUpUrl).hash.slice(1);
  const step = await post('/local-identity/link/step-up/context', { stepUpCode }, { origin: relayOrigin }); assert.equal(step.status, 200);
  const verified = await post('/local-identity/link/step-up/complete', { completionCode: step.body.completionCode,
    response: assertion(relayPasskey, step.body.options.challenge, relayOrigin, '127.0.0.1', 2) }, { origin: relayOrigin });
  assert.deepEqual(verified.body, { verified: true });
  const ready = await dashboard('step-up/result', { stepUpId: prepared.body.stepUpId }); assert.equal(ready.body.state, 'ready');
  const key = nativeKey(); const ctx = await post('/local-identity/link/context', { handoffCode: ready.body.handoffCode, did: key.did }); assert.equal(ctx.status, 200);
  const linked = await complete(key, ctx.body); assert.equal(linked.status, 200, JSON.stringify(linked.body)); assert.equal(linked.body.owner.userId, ownerId);
  assert.deepEqual(pods.get(ownerId)!.walletAddresses, []); assert.equal(pods.get(ownerId)!.didKeys.length, 1);
  assert.equal(pods.has(deriveUserIdFromDid(key.did)), false);
  assert.equal(await (await fetch(`${podBase}${ownerId}/hallowmarch/progress.json`)).text(), progress);
  assert.ok(writes.every(write => write.path === `/${ownerId}/auth-methods.jsonld` && write.condition));
});

test('returning login refuses removal, key replacement, epoch changes and unreadable owner storage before issuing its provider token', async () => {
  for (const change of ['remove', 'replace', 'epoch', 'unreadable']) {
    pods.set(ownerId, fixtureAccount()); revisions.set(ownerId, revisions.get(ownerId)! + 1);
    const flow = await returningLogin(); assert.equal((await flow.complete()).status, 200);
    const account = pods.get(ownerId)!;
    if (change === 'remove') account.webAuthnCredentials = account.webAuthnCredentials.filter((entry: { id: string }) => entry.id !== relayPasskey.id);
    if (change === 'replace') account.webAuthnCredentials.find((entry: { id: string }) => entry.id === relayPasskey.id).publicKey = softPasskey().cose.toString('base64url');
    if (change === 'epoch') account.sessionEpoch++;
    if (change === 'unreadable') brokenOwner = ownerId;
    revisions.set(ownerId, revisions.get(ownerId)! + 1);
    const result = await flow.result(); assert.ok(result.status === 401 || result.status === 503, change + ': ' + JSON.stringify(result.body));
    assert.equal(result.body.token, undefined); brokenOwner = undefined;
  }
});

test('returning login resolves a copied credential ID by its genuine stored key and never creates an account for an unknown passkey', async () => {
  const impostor = softPasskey(relayPasskey.rawId), id = impostor.userId;
  pods.set(id, { userId: id, name: 'Different credential holder', walletAddresses: [], didKeys: [], sessionEpoch: 0,
    webAuthnCredentials: [{ id: impostor.id, publicKey: impostor.cose.toString('base64url'), counter: 0, createdAt: new Date().toISOString(), rpId: '127.0.0.1', rpOrigin: relayOrigin }] }); revisions.set(id, 1);
  try {
    const flow = await returningLogin(); assert.equal((await flow.complete()).status, 200); const answer = await flow.result(); assert.equal(answer.status, 200); assert.equal(answer.body.userId, ownerId);
    assert.equal(pods.get(id)!.webAuthnCredentials[0].counter, 0);
  } finally { pods.delete(id); revisions.delete(id); }
  const unknown = softPasskey(), flow = await returningLogin();
  const rejected = await flow.request('complete', { completionCode: flow.context.completionCode,
    response: assertion(unknown, flow.context.options.challenge, relayOrigin, '127.0.0.1', 1) }, true);
  assert.equal(rejected.status, 401); assert.equal(pods.has(unknown.userId), false); assert.equal((await flow.result()).body.token, undefined);
});

test('returning login verifies the genuine signed RP origin and UV flag rather than trusting client options', async () => {
  for (const weakUv of [false, true]) {
    const flow = await returningLogin();
    const response = assertion(relayPasskey, flow.context.options.challenge, weakUv ? relayOrigin : base, '127.0.0.1', 1);
    if (weakUv) {
      const authData = Buffer.from(response.response.authenticatorData, 'base64url'); authData[32] &= ~4;
      response.response.authenticatorData = authData.toString('base64url');
      response.response.signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(Buffer.from(response.response.clientDataJSON, 'base64url')).digest()]), relayPasskey.privateKey).toString('base64url');
    }
    const rejected = await flow.request('complete', { completionCode: flow.context.completionCode, response }, true);
    assert.equal(rejected.status, 401); assert.equal((await flow.result()).body.token, undefined);
  }
});

test('fresh owner wallet proof and native proof add only a credential; unchanged DID login returns the same existing game owner and pod', async () => {
  const html = await (await fetch(base + '/dashboard')).text();
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]!);
  assert.ok(html.includes('id="interego-local-identity-link"')); assert.ok(!html.includes(bearer));
  const key = nativeKey(); const { context: ctx } = await context(key); const result = await complete(key, ctx); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { linked: true, identityOrigin: base, owner: ctx.owner, credentialDid: key.did }); assert.equal(ctx.owner.userId, ownerId);
  assert.equal(ctx.owner.podUrl, `https://pods.example.com/${ownerId}/`); assert.equal(writes.length, 1); assert.equal(writes[0]!.path, `/${ownerId}/auth-methods.jsonld`);
  assert.ok(writes[0]!.condition); assert.deepEqual(pods.get(ownerId)!.applicationOwnedField, { preserve: 'not auth-owned' });
  assert.equal(await (await fetch(`${podBase}${ownerId}/hallowmarch/progress.json`)).text(), progress);
  const challenge = (await post('/challenges', { purpose: 'did-sig' })).body;
  const login = await post('/auth/did', { did: key.did, nonce: challenge.nonce, signature: sign(null, Buffer.from(challenge.message), key.privateKey).toString('base64url') });
  assert.equal(login.status, 200, JSON.stringify(login.body)); assert.equal(login.body.userId, ownerId); assert.equal(login.body.did, ctx.owner.did);
  assert.equal(pods.has(deriveUserIdFromDid(key.did)), false); assert.equal(writes.length, 1); assert.equal((await complete(key, ctx)).status, 401);
});
test('a valid session or renewed/MCP token alone cannot start linking, and a prepared proof is bound to its exact original token', async () => {
  assert.equal((await dashboard('start', {})).status, 400);
  const prepared = await dashboard('prepare', { method: 'wallet', address: wallet.address, chainId: 1 });
  const renewal = await post('/tokens', { userId: ownerId, agentId: 'mcp-client-' + ownerId }, { token: bearer }); assert.equal(renewal.status, 200, JSON.stringify(renewal.body));
  const proof = await wallet.signMessage(prepared.body.message);
  assert.equal((await dashboard('start', { stepUpId: prepared.body.stepUpId, signature: proof }, renewal.body.token)).status, 401);
  assert.equal((await post('/local-identity/link/start', { stepUpId: prepared.body.stepUpId, signature: proof }, { token: bearer, origin: relayOrigin })).status, 403);
  assert.equal((await dashboard('start', { stepUpId: prepared.body.stepUpId, signature: proof })).status, 200); assert.equal(writes.length, 0);
});
test('the actual passkey verifier requires a fresh scoped assertion, including original-relay-RP popup support', async () => {
  const own = await dashboard('prepare', { method: 'passkey', rpOrigin: base }); assert.equal(own.status, 200);
  const begun = await dashboard('start', { stepUpId: own.body.stepUpId, response: assertion(passkey, own.body.options.challenge, base, '127.0.0.1', 1) }); assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const ownKey = nativeKey(); const ownContext = await post('/local-identity/link/context', { handoffCode: begun.body.handoffCode, did: ownKey.did }); assert.equal(ownContext.status, 200);
  assert.equal((await complete(ownKey, ownContext.body)).status, 200);
  const cross = await dashboard('prepare', { method: 'passkey', rpOrigin: relayOrigin }); assert.equal(cross.status, 200);
  const stepUpCode = new URL(cross.body.stepUpUrl).hash.slice(1);
  assert.equal((await post('/local-identity/link/step-up/context', { stepUpCode }, { origin: base })).status, 401);
  const scoped = await post('/local-identity/link/step-up/context', { stepUpCode }, { origin: relayOrigin }); assert.equal(scoped.status, 200, JSON.stringify(scoped.body));
  assert.equal(scoped.body.options.rpId, '127.0.0.1'); assert.equal((await post('/local-identity/link/step-up/context', { stepUpCode }, { origin: relayOrigin })).status, 401);
  const checked = await post('/local-identity/link/step-up/complete', { completionCode: scoped.body.completionCode, response: assertion(relayPasskey, scoped.body.options.challenge, relayOrigin, '127.0.0.1', 1) }, { origin: relayOrigin });
  assert.deepEqual(checked, { status: 200, body: { verified: true } });
  const result = await dashboard('step-up/result', { stepUpId: cross.body.stepUpId }); assert.equal(result.body.state, 'ready'); assert.match(result.body.handoffCode, /^interego-link:v1:/);
  assert.equal((await dashboard('step-up/result', { stepUpId: cross.body.stepUpId })).body.state, 'expired');
  const relayKey = nativeKey(); const relayContext = await post('/local-identity/link/context', { handoffCode: result.body.handoffCode, did: relayKey.did }); assert.equal(relayContext.status, 200);
  const linked = await complete(relayKey, relayContext.body); assert.equal(linked.status, 200); assert.equal(linked.body.owner.userId, ownerId); assert.equal(pods.get(ownerId)!.didKeys.length, 2);
});
test('native proof is action/account/key scoped, cannot replay a login message, and is spent after a failed completion', async () => {
  const key = nativeKey(); const { context: ctx } = await context(key); const signature = sign(null, Buffer.from(`Interego DID sign-in v1\nHost: ${new URL(base).host}\nNonce: ${ctx.nonce}`), key.privateKey).toString('base64url');
  assert.equal((await complete(key, ctx, signature)).status, 401); assert.equal((await complete(key, ctx)).status, 401); assert.equal(writes.length, 0);
});
test('revoking the owner epoch or removing the human credential after native context prevents enrollment', async () => {
  for (const mutation of [(record: RecordValue) => { record.walletAddresses = []; }, (record: RecordValue) => { record.sessionEpoch++; }]) {
    pods.set(ownerId, fixtureAccount()); const key = nativeKey(); const { context: ctx } = await context(key); mutation(pods.get(ownerId)!); revisions.set(ownerId, revisions.get(ownerId)! + 1);
    assert.equal((await complete(key, ctx)).status, 401); assert.equal(pods.get(ownerId)!.didKeys.length, 0);
  }
  assert.equal(writes.length, 0);
});
test('a key already held by another account, including its unlisted derived account, is refused without merges or game writes', async () => {
  const key = nativeKey(); const derived = deriveUserIdFromDid(key.did); const untouched = { userId: derived, name: 'Separate existing account', walletAddresses: [], webAuthnCredentials: [], didKeys: [{ did: key.did, publicKeyMultibase: key.multibase, keyType: 'Ed25519VerificationKey2020', createdAt: new Date().toISOString() }] };
  pods.set(derived, untouched); unlistedPods.add(derived); revisions.set(derived, 1); const started = await walletStart();
  const response = await post('/local-identity/link/context', { handoffCode: started.handoffCode, did: key.did }); assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error, 'local_key_has_another_account'); assert.deepEqual(pods.get(derived), untouched); assert.equal(writes.length, 0); pods.delete(derived);
});
test('CAS conflicts retain concurrent fields; missing conditions and failed/ambiguous writes never produce a linked receipt', async () => {
  const key = nativeKey(); const { context: ctx } = await context(key); conflict = true; const success = await complete(key, ctx);
  assert.equal(success.status, 200, JSON.stringify(success.body)); assert.equal(pods.get(ownerId)!.concurrentChange, 'preserved');
  for (const mode of ['no-etag', 'refused', 'applied-but-failed']) {
    pods.set(ownerId, fixtureAccount()); revisions.set(ownerId, revisions.get(ownerId)! + 1); const fresh = nativeKey(); const prepared = await context(fresh);
    noEtag = mode === 'no-etag'; refuseWrite = mode !== 'no-etag'; applyFailedWrite = mode === 'applied-but-failed';
    const response = await complete(fresh, prepared.context); assert.equal(response.status, 503, mode + ': ' + JSON.stringify(response.body)); assert.equal(response.body.linked, undefined);
    noEtag = false; refuseWrite = false; applyFailedWrite = false;
  }
  assert.ok(writes.every(write => write.path === `/${ownerId}/auth-methods.jsonld`));
});
test('an unreadable other holder or owner cancellation cannot be treated as permission to enroll', async () => {
  brokenOwner = otherId; const key = nativeKey(); const started = await walletStart();
  assert.equal((await post('/local-identity/link/context', { handoffCode: started.handoffCode, did: key.did })).status, 503); brokenOwner = undefined;
  const another = await context(key); assert.equal((await dashboard('cancel', { pendingId: another.started.pendingId })).status, 200);
  assert.equal((await complete(key, another.context)).status, 401); assert.equal(writes.length, 0);
});
test('waiting popup polls have their own bounded read budget and cannot exhaust fresh authentication or enrollment', async () => {
  const prepared = await dashboard('prepare', { method: 'passkey', rpOrigin: relayOrigin }); assert.equal(prepared.status, 200);
  for (let index = 0; index < 40; index++) {
    const result = await dashboard('step-up/result', { stepUpId: prepared.body.stepUpId }); assert.equal(result.status, 200); assert.equal(result.body.state, 'waiting');
  }
  const key = nativeKey(); const { context: ctx } = await context(key); const linked = await complete(key, ctx); assert.equal(linked.status, 200, JSON.stringify(linked.body));
  const mutations: number[] = []; for (let index = 0; index < 31; index++) mutations.push((await post('/auth/did', {})).status);
  assert.ok(mutations.includes(429), 'the original enrollment mutation quota remains in force');
  assert.equal(mutations.filter(status => status === 400).length, 24, 'six genuine enrollment/auth calls plus24 refusals spend the unchanged30-request budget');
});
