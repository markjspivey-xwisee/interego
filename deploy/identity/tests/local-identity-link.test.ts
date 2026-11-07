import { afterEach, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountLocalIdentityLink, LocalIdentityLinkError, localLinkMessage, type LocalIdentityLinkDeps } from '../local-identity-link.js';
import { closeServer } from './teardown.js';

type Json = Record<string, unknown>;
const origin = 'https://identity.example.com'; const relay = 'https://relay.example.com'; const address = '0x' + 'a'.repeat(40);
const owner = { userId: 'existing-owner', did: 'did:web:identity.example.com:users:existing-owner', webId: origin + '/users/existing-owner/profile#me', podUrl: 'https://pods.example.com/existing-owner/', displayName: 'Existing owner' };
const testAccount = () => ({ owner, walletAddresses: [address], passkeys: [{ id: 'existing-passkey', publicKey: 'stored-key', rpId: 'relay.example.com', rpOrigin: relay }] });
const servers: Server[] = [];
const value = (body: Json, key: string) => String(body[key]);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function key() {
  const pair = generateKeyPairSync('ed25519'); const bytes = Buffer.concat([Buffer.from([0xed, 1]), pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
  let number = BigInt('0x' + bytes.toString('hex')); let encoded = ''; const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  while (number) { encoded = alphabet[Number(number % 58n)] + encoded; number /= 58n; }
  return { did: 'did:key:z' + encoded, privateKey: pair.privateKey };
}
async function fixture(overrides: Partial<LocalIdentityLinkDeps> = {}) {
  let clock = Date.parse('2026-11-01T12:00:00Z'); let commits = 0;
  const app = express(); app.use(express.json());
  mountLocalIdentityLink(app, { identityOrigin: origin, trustedPasskeyOrigins: new Set([origin, relay]), now: () => clock,
    limiter: (_req, _res, next) => next(),
    authenticate: async token => { if (!['owner-session', 'renewed-session'].includes(token)) throw new LocalIdentityLinkError(401, 'no_session', 'Sign in.'); return { userId: owner.userId, sessionHash: token, epoch: 0 }; },
    account: async () => testAccount(),
    walletAddress: async value => value,
    verifyStepUp: async (step, body) => { if (body.signature !== 'fresh-human-' + step.nonce && !body.response) throw new LocalIdentityLinkError(401, 'human_proof_required', 'Verify an existing credential.'); return { method: 'wallet', address }; },
    check: async () => {}, available: async () => {},
    commit: async (_session, _credential, _did, active) => { if (!active()) throw new LocalIdentityLinkError(401, 'cancelled', 'Cancelled.'); commits++; }, ...overrides,
  });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(resolve => server.once('listening', resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, options: { dashboard?: boolean; origin?: string; token?: string } = {}) => {
    const response = await fetch(base + '/local-identity/link/' + path, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(options.dashboard || options.token ? { authorization: 'Bearer ' + (options.token ?? 'owner-session') } : {}),
      ...(options.dashboard ? { origin } : options.origin ? { origin: options.origin } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Json };
  };
  const prepare = () => post('prepare', { method: 'wallet', address, chainId: 1 }, { dashboard: true });
  const start = async () => { const prepared = await prepare(); assert.equal(prepared.status, 200); const nonce = /\nNonce: ([^\n]+)/.exec(value(prepared.body, 'message'))![1]!;
    const started = await post('start', { stepUpId: prepared.body['stepUpId'], signature: 'fresh-human-' + nonce }, { dashboard: true }); assert.equal(started.status, 200); return started.body; };
  const context = async (credential: ReturnType<typeof key>) => { const started = await start(); const result = await post('context', { handoffCode: started['handoffCode'], did: credential.did }); assert.equal(result.status, 200); return { started, context: result.body }; };
  const complete = (credential: ReturnType<typeof key>, ctx: Json) => post('complete', { completionCode: ctx['completionCode'], did: credential.did, nonce: ctx['nonce'], signature: sign(null, Buffer.from(value(ctx, 'message')), credential.privateKey).toString('base64url') });
  return { post, prepare, start, context, complete, base, time: (delta: number) => { clock += delta; }, commits: () => commits };
}
afterEach(async () => { await Promise.all(servers.splice(0).map(closeServer)); });

test('link capabilities are one-use, receipts contain only public linkage, and every signature field binds the exact owner and native key', async () => {
  const f = await fixture(); const credential = key(); const { started, context } = await f.context(credential);
  assert.equal(context['message'], localLinkMessage(origin, value(context, 'pendingId'), owner, credential.did, value(context, 'nonce'), value(context, 'expiresAt')));
  assert.equal((await f.post('context', { handoffCode: started['handoffCode'], did: credential.did })).status, 401);
  const completed = await f.complete(credential, context); assert.deepEqual(completed, { status: 200, body: { linked: true, identityOrigin: origin, owner, credentialDid: credential.did } });
  const bytes = JSON.stringify(completed.body); for (const secret of ['owner-session', value(context, 'completionCode'), value(context, 'nonce')]) assert.ok(!bytes.includes(secret));
  assert.equal((await f.complete(credential, context)).status, 401); assert.equal(f.commits(), 1);
});
test('freshness expires both human step-up and native consent without any credential write', async () => {
  const f = await fixture(); const prepared = await f.prepare(); const nonce = /\nNonce: ([^\n]+)/.exec(value(prepared.body, 'message'))![1]!; f.time(120_001);
  assert.equal((await f.post('start', { stepUpId: prepared.body['stepUpId'], signature: 'fresh-human-' + nonce }, { dashboard: true })).status, 401);
  const credential = key(); const { context } = await f.context(credential); f.time(120_001); assert.equal((await f.complete(credential, context)).status, 401); assert.equal(f.commits(), 0);
});
test('foreign browser origins and an owner session alone cannot enroll, and unknown caller claims are refused', async () => {
  const f = await fixture(); assert.equal((await f.post('prepare', { method: 'wallet', address, chainId: 1 }, { token: 'owner-session', origin: relay })).status, 403);
  assert.equal((await f.post('start', {}, { dashboard: true })).status, 400);
  assert.equal((await f.post('prepare', { method: 'wallet', address, chainId: 1, userId: 'victim' }, { dashboard: true })).status, 400);
  const credential = key(); const started = await f.start(); assert.equal((await f.post('context', { handoffCode: started['handoffCode'], did: credential.did }, { origin })).status, 400); assert.equal(f.commits(), 0);
});
test('cancelled native approval and a different owner session cannot consume or complete a link', async () => {
  const f = await fixture(); const credential = key(); const { started, context } = await f.context(credential);
  assert.equal((await f.post('cancel', { pendingId: started['pendingId'] }, { dashboard: true, token: 'renewed-session' })).status, 401);
  assert.equal((await f.post('cancel', { pendingId: started['pendingId'] }, { dashboard: true })).status, 200);
  assert.equal((await f.complete(credential, context)).status, 401); assert.equal(f.commits(), 0);
});
test('a concurrent owner cancellation stops a human proof before a native handoff is minted', async () => {
  const entered = deferred<void>(); const gate = deferred<void>();
  const f = await fixture({ verifyStepUp: async () => { entered.resolve(); await gate.promise; return { method: 'wallet', address }; } }); const prepared = await f.prepare();
  const starting = f.post('start', { stepUpId: prepared.body['stepUpId'], signature: 'human-proof' }, { dashboard: true }); await entered.promise;
  assert.equal((await f.post('cancel', { stepUpId: prepared.body['stepUpId'] }, { dashboard: true })).status, 200); gate.resolve(); assert.equal((await starting).status, 401); assert.equal(f.commits(), 0);
});
test('an approved native completion still checks cancellation immediately before the conditional enrollment', async () => {
  const entered = deferred<void>(); const gate = deferred<void>(); let written = false;
  const f = await fixture({ commit: async (_session, _credential, _did, active) => { entered.resolve(); await gate.promise; if (!active()) throw new LocalIdentityLinkError(401, 'cancelled', 'Cancelled.'); written = true; } });
  const credential = key(); const { started, context } = await f.context(credential); const completing = f.complete(credential, context); await entered.promise;
  await f.post('cancel', { pendingId: started['pendingId'] }, { dashboard: true }); gate.resolve(); assert.equal((await completing).status, 401); assert.equal(written, false);
});
test('the original-RP popup cannot obtain the native handoff, and only the initiating dashboard session can consume its verified result', async () => {
  const f = await fixture(); const prepared = await f.post('prepare', { method: 'passkey', rpOrigin: relay }, { dashboard: true });
  const stepUpCode = new URL(value(prepared.body, 'stepUpUrl')).hash.slice(1);
  assert.equal((await f.post('step-up/context', { stepUpCode }, { origin })).status, 401);
  const scoped = await f.post('step-up/context', { stepUpCode }, { origin: relay }); assert.equal(scoped.status, 200);
  const verified = await f.post('step-up/complete', { completionCode: scoped.body['completionCode'], response: { proof: 'fresh' } }, { origin: relay });
  assert.deepEqual(verified.body, { verified: true });
  assert.equal((await f.post('step-up/result', { stepUpId: prepared.body['stepUpId'] }, { dashboard: true, token: 'renewed-session' })).status, 401);
  const ready = await f.post('step-up/result', { stepUpId: prepared.body['stepUpId'] }, { dashboard: true }); assert.equal(ready.body['state'], 'ready');
  assert.match(value(ready.body, 'handoffCode'), /^interego-link:v1:/); assert.equal((await f.post('step-up/result', { stepUpId: prepared.body['stepUpId'] }, { dashboard: true })).body['state'], 'expired');
});
test('the account bounds incomplete requests and admits a new one only after an owned cancellation', async () => {
  const f = await fixture(); const ids: string[] = [];
  for (let index = 0; index < 8; index++) { const result = await f.prepare(); assert.equal(result.status, 200); ids.push(value(result.body, 'stepUpId')); }
  assert.equal((await f.prepare()).status, 429); await f.post('cancel', { stepUpId: ids[0] }, { dashboard: true }); assert.equal((await f.prepare()).status, 200);
});
test('concurrent verified popup result polls consume the native handoff only once after asynchronous owner checks', async () => {
  const entered = deferred<void>(); const gate = deferred<void>(); let blocking = false; let reads = 0;
  const f = await fixture({ account: async () => { if (blocking) { if (++reads === 2) entered.resolve(); await gate.promise; } return testAccount(); } });
  const prepared = await f.post('prepare', { method: 'passkey', rpOrigin: relay }, { dashboard: true });
  const stepUpCode = new URL(value(prepared.body, 'stepUpUrl')).hash.slice(1);
  const scoped = await f.post('step-up/context', { stepUpCode }, { origin: relay });
  await f.post('step-up/complete', { completionCode: scoped.body['completionCode'], response: { proof: 'fresh' } }, { origin: relay }); blocking = true;
  const first = f.post('step-up/result', { stepUpId: prepared.body['stepUpId'] }, { dashboard: true });
  const second = f.post('step-up/result', { stepUpId: prepared.body['stepUpId'] }, { dashboard: true }); await entered.promise; gate.resolve();
  const results = await Promise.all([first, second]); assert.deepEqual(results.map(result => result.body['state']).sort(), ['expired', 'ready']);
  assert.equal(results.filter(result => result.body['handoffCode'] !== undefined).length, 1);
});
