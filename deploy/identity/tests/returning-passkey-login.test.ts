import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mountReturningPasskeyLogin, returningPasskeyRelay, RETURNING_PASSKEY_COOKIE, type ReturningPasskeyLoginDeps, type ReturningPasskeyProof } from '../returning-passkey-login.js';
import { closeServer } from './teardown.js';

const provider = 'https://identity.interego.test', relay = 'https://relay.interego.test';
const proof: ReturningPasskeyProof = { userId: 'existing-owner', epoch: 4,
  credential: { method: 'passkey', id: 'existing-device-passkey', publicKey: 'public-fixture-key', rpId: 'relay.interego.test', rpOrigin: relay } };
const servers: Server[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(overrides: Partial<ReturningPasskeyLoginDeps> = {}) {
  let now = Date.now(), verifies = 0, issues = 0;
  const app = express(); app.use(express.json());
  mountReturningPasskeyLogin(app, { identityOrigin: provider, relayOrigin: relay, limiter: (_req, _res, next) => next(), now: () => now,
    verify: async () => { verifies++; return proof; }, issue: async (_proof, active) => { issues++; assert.ok(active()); return { token: 'fixture-token', userId: proof.userId }; }, ...overrides });
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/local-identity/login/`;
  const post = async (path: string, input: unknown, options: { cookie?: string; rp?: boolean; origin?: string; site?: string; authorization?: string } = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: options.origin ?? (options.rp ? relay : provider),
      'sec-fetch-site': options.site ?? (options.rp ? 'same-site' : 'same-origin'), ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.authorization ? { authorization: options.authorization } : {}) }, body: JSON.stringify(input) });
    return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
  };
  const start = async () => { const answer = await post('start', {}); assert.equal(answer.status, 200); return { ...answer.body,
    cookie: answer.headers.get('set-cookie')!.split(';')[0]!, loginCode: new URL(String(answer.body['authorizationUrl'])).hash.slice(1), headers: answer.headers }; };
  const context = async (flow: Awaited<ReturnType<typeof start>>) => {
    const answer = await post('context', { loginCode: flow.loginCode }, { rp: true, cookie: flow.cookie }); assert.equal(answer.status, 200); return answer.body;
  };
  const complete = (flow: Awaited<ReturnType<typeof start>>, ctx: Record<string, unknown>, options: Parameters<typeof post>[2] = {}) => post('complete', { completionCode: ctx['completionCode'], response: { id: 'existing-device-passkey' } }, { rp: true, cookie: flow.cookie, ...options });
  const result = (flow: Awaited<ReturnType<typeof start>>, options: Parameters<typeof post>[2] = {}) => post('result', { receipt: flow['receipt'] }, { cookie: flow.cookie, ...options });
  return { post, start, context, complete, result, base, counts: () => ({ verifies, issues }), advance: (ms: number) => { now += ms; } };
}
afterEach(async () => { await Promise.all(servers.splice(0).map(closeServer)); });

test('only the initiating provider cookie and receipt receive a one-use returning login; the RP never receives a bearer', async () => {
  const f = await fixture(), flow = await f.start();
  assert.match(flow.headers.get('set-cookie')!, new RegExp('^' + RETURNING_PASSKEY_COOKIE + '=.*; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=120$'));
  assert.equal(flow.headers.get('access-control-allow-credentials'), null);
  const ctx = await f.context(flow); assert.deepEqual((ctx['options'] as { allowCredentials: unknown[] }).allowCredentials, []);
  assert.equal((await f.post('context', { loginCode: flow.loginCode }, { rp: true, cookie: flow.cookie })).status, 401);
  const completed = await f.complete(flow, ctx); assert.deepEqual(completed.body, { verified: true });
  assert.equal(completed.headers.get('access-control-allow-origin'), relay); assert.equal(completed.headers.get('access-control-allow-credentials'), 'true');
  assert.equal((await f.complete(flow, ctx)).status, 401);
  const answer = await f.result(flow); assert.deepEqual(answer.body, { state: 'signed-in', token: 'fixture-token', userId: proof.userId });
  assert.match(answer.headers.get('set-cookie')!, /Max-Age=0$/); assert.equal((await f.result(flow)).status, 401);
  assert.deepEqual(f.counts(), { verifies: 1, issues: 1 });
  for (const value of [flow, ctx, completed.body]) assert.equal(JSON.stringify(value).includes('fixture-token'), false);
});
test('forwarding an RP capability to another browser cannot verify or transfer its login', async () => {
  const f = await fixture(), a = await f.start(), b = await f.start();
  for (const cookie of [undefined, b.cookie, a.cookie + '; ' + a.cookie]) assert.equal((await f.post('context', { loginCode: a.loginCode }, { rp: true, cookie })).status, 401);
  const ctx = await f.context(a);
  assert.equal((await f.complete(a, ctx, { cookie: b.cookie })).status, 401); assert.equal(f.counts().verifies, 0);
  assert.equal((await f.complete(a, ctx)).status, 200);
  assert.equal((await f.result(a, { cookie: b.cookie })).status, 401); assert.equal(f.counts().issues, 0);
  assert.equal((await f.result(a)).body['userId'], proof.userId);
});
test('exact browser origins, same-site metadata, bodies and credentialed preflight are confined to the two RP endpoints', async () => {
  const f = await fixture(), flow = await f.start();
  for (const options of [{ origin: provider }, { origin: 'https://foreign.interego.test' }, { site: 'cross-site' }, { site: '' }, { authorization: 'Bearer fixture-token' }]) {
    assert.equal((await f.post('context', { loginCode: flow.loginCode }, { rp: true, cookie: flow.cookie, ...options })).status, 401);
  }
  assert.equal((await f.post('start', {}, { origin: relay })).status, 401);
  assert.equal((await f.post('start', { userId: 'claimed-owner' })).status, 400);
  const ctx = await f.context(flow); assert.equal((await f.complete(flow, ctx)).status, 200);
  assert.equal((await f.result(flow, { origin: relay })).status, 401); assert.equal(f.counts().issues, 0);
  const preflight = (origin: string, path: string, headers = 'content-type') => fetch(f.base + path, { method: 'OPTIONS', headers: { origin,
    'access-control-request-method': 'POST', 'access-control-request-headers': headers } });
  const ok = await preflight(relay, 'context'); assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.equal((await preflight('https://foreign.interego.test', 'context')).status, 403);
  assert.equal((await preflight(relay, 'complete', 'authorization')).status, 403);
  assert.equal((await preflight(relay, 'result')).headers.get('access-control-allow-credentials'), null);
});
test('completion is claimed before verification; cancellation and expiry defeat an in-flight proof', async () => {
  for (const expiry of [false, true]) {
    const entered = deferred<void>(), gate = deferred<ReturningPasskeyProof>(); let verifies = 0;
    const f = await fixture({ verify: async () => { verifies++; entered.resolve(); return gate.promise; } }), flow = await f.start(), ctx = await f.context(flow);
    const pending = f.complete(flow, ctx); await entered.promise;
    assert.equal((await f.complete(flow, ctx)).status, 401); assert.equal(verifies, 1);
    if (expiry) f.advance(120_001); else { const cancelled = await f.post('cancel', { receipt: flow['receipt'] }, { cookie: flow.cookie }); assert.equal(cancelled.status, 200); assert.match(cancelled.headers.get('set-cookie')!, /Max-Age=0$/); }
    gate.resolve(proof); const answer = await pending; assert.equal(answer.status, 401); assert.equal(answer.body['token'], undefined); assert.equal((await f.result(flow)).status, 401);
  }
});
test('a concurrent result cannot issue twice; cancellation or expiry during issuance never returns a token', async () => {
  for (const expiry of [false, true]) {
    const entered = deferred<void>(), gate = deferred<void>(); let issues = 0;
    const f = await fixture({ issue: async () => { issues++; entered.resolve(); await gate.promise; return { token: 'fixture-token' }; } });
    const flow = await f.start(), ctx = await f.context(flow); await f.complete(flow, ctx);
    const pending = f.result(flow); await entered.promise; assert.equal((await f.result(flow)).status, 401); assert.equal(issues, 1);
    if (expiry) f.advance(120_001); else assert.equal((await f.post('cancel', { receipt: flow['receipt'] }, { cookie: flow.cookie })).status, 200);
    gate.resolve(); const answer = await pending; assert.equal(answer.status, 401); assert.equal(answer.body['token'], undefined);
  }
});
test('unavailable, self, non-sibling and insecure RP configurations have no login fallback', async () => {
  for (const rp of [undefined, provider, 'https://other.example.com', 'https://user:secret@relay.interego.test', relay + '/path', 'http://relay.interego.test', relay + ':8443']) {
    assert.equal(returningPasskeyRelay(provider, rp), undefined);
    const f = await fixture({ relayOrigin: rp }); assert.equal((await f.post('start', {})).status, 401);
  }
});
