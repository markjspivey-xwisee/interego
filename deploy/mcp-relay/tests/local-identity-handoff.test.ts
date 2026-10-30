import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { LocalIdentityHandoffs, type LocalIdentityChallenge, type LocalIdentityPending } from '../local-identity-handoff.js';

const issuer = 'https://relay.example'; const identityOrigin = 'https://identity.example';
const fresh = () => randomBytes(32).toString('base64url');
function fixture() {
  let now = 1_800_000_000_000; let requests = 0;
  const pending = new Map<string, LocalIdentityPending>();
  const value: LocalIdentityPending = { pendingId: 'a'.repeat(32), clientId: 'https://game.example/client.json', clientName: 'Test game',
    redirectUri: 'https://game.example/callback?fixed=one', scopes: ['mcp:read'], resource: null, codeChallenge: fresh(), state: fresh(), expiresAt: now + 600_000 };
  pending.set(value.pendingId, value);
  const challenge = async (): Promise<LocalIdentityChallenge> => { requests++; const nonce = fresh(); return { nonce, message: `Interego DID sign-in v1\nHost: identity.example\nNonce: ${nonce}`, expiresAt: new Date(now + 300_000).toISOString() }; };
  const handoffs = new LocalIdentityHandoffs({ issuer, identityOrigin, pending: id => pending.get(id), challenge, now: () => now });
  return { handoffs, pending, value, challenge, now: () => now, advance: (milliseconds: number) => { now += milliseconds; }, requests: () => requests };
}

test('one-use native context and completion preserve the exact existing OAuth ceremony without exposing raw state', async () => {
  const f = fixture(); const issued = f.handoffs.issue(f.value.pendingId); const context = await f.handoffs.context(issued.handoffCode);
  assert.equal(context.version, 1); assert.equal(context.issuer, issuer); assert.equal(context.identityOrigin, identityOrigin);
  for (const key of ['pendingId', 'clientId', 'clientName', 'redirectUri', 'scopes', 'resource', 'codeChallenge'] as const) assert.deepEqual(context[key], f.value[key]);
  assert.equal(context.stateDigest, createHash('sha256').update(f.value.state).digest('base64url'));
  assert.equal(Object.hasOwn(context, 'state'), false); assert.equal(context.message, `Interego DID sign-in v1\nHost: identity.example\nNonce: ${context.nonce}`);
  assert.ok(context.completionCode.startsWith('interego-login-result:v1:')); assert.equal(f.requests(), 1);
  await assert.rejects(f.handoffs.context(issued.handoffCode)); assert.equal(f.requests(), 1);
  f.handoffs.consume(context.completionCode, f.value.pendingId, context.nonce);
  assert.throws(() => f.handoffs.consume(context.completionCode, f.value.pendingId, context.nonce));
});

test('forged, expired and changed request capabilities fail before contacting identity', async () => {
  const f = fixture(); const issued = f.handoffs.issue(f.value.pendingId);
  await assert.rejects(f.handoffs.context(issued.handoffCode.slice(0, -1) + (issued.handoffCode.endsWith('A') ? 'B' : 'A')));
  assert.equal(f.requests(), 0);
  f.pending.set(f.value.pendingId, { ...f.value, redirectUri: 'https://attacker.example/callback' });
  await assert.rejects(f.handoffs.context(issued.handoffCode)); assert.equal(f.requests(), 0);
  f.pending.set(f.value.pendingId, f.value); const expired = f.handoffs.issue(f.value.pendingId); f.advance(120_001);
  await assert.rejects(f.handoffs.context(expired.handoffCode)); assert.equal(f.requests(), 0);
});

test('native completion binds nonce, client, scopes, callback, state, resource and PKCE and is spent before refusal', async () => {
  for (const key of ['clientId', 'redirectUri', 'scopes', 'state', 'resource', 'codeChallenge'] as const) {
    const f = fixture(); const issued = f.handoffs.issue(f.value.pendingId); const context = await f.handoffs.context(issued.handoffCode);
    const updates: Partial<LocalIdentityPending> = { clientId: 'other-client', redirectUri: 'https://other.example/callback', scopes: ['mcp:write'], state: fresh(), resource: 'https://other.example/mcp', codeChallenge: fresh() };
    f.pending.set(f.value.pendingId, { ...f.value, [key]: updates[key] });
    assert.throws(() => f.handoffs.consume(context.completionCode, f.value.pendingId, context.nonce));
    f.pending.set(f.value.pendingId, f.value);
    assert.throws(() => f.handoffs.consume(context.completionCode, f.value.pendingId, context.nonce));
  }
  const f = fixture(); const context = await f.handoffs.context(f.handoffs.issue(f.value.pendingId).handoffCode);
  assert.throws(() => f.handoffs.consume(context.completionCode, f.value.pendingId, fresh()));
  assert.throws(() => f.handoffs.consume(context.completionCode, f.value.pendingId, context.nonce));
});

test('bare-nonce, foreign-provider and expired challenges never yield native completion authority', async () => {
  for (const kind of ['bare', 'foreign', 'expired']) {
    const f = fixture();
    const handoffs = new LocalIdentityHandoffs({ issuer, identityOrigin, pending: id => f.pending.get(id), now: f.now,
      challenge: async () => { const original = await f.challenge(); return { ...original, message: kind === 'bare' ? original.nonce : kind === 'foreign' ? original.message.replace('identity.example', 'attacker.example') : original.message,
        expiresAt: kind === 'expired' ? new Date(f.now() - 1).toISOString() : original.expiresAt }; } });
    await assert.rejects(handoffs.context(handoffs.issue(f.value.pendingId).handoffCode));
  }
});

test('parallel context claims contact identity once and pending cancellation wins while challenge is pending', async () => {
  const f = fixture(); let complete!: (value: LocalIdentityChallenge) => void; let requests = 0;
  const handoffs = new LocalIdentityHandoffs({ issuer, identityOrigin, pending: id => f.pending.get(id), now: f.now,
    challenge: async () => { requests++; return new Promise(done => { complete = done; }); } });
  const issued = handoffs.issue(f.value.pendingId); const first = handoffs.context(issued.handoffCode); const refused = assert.rejects(first);
  await assert.rejects(handoffs.context(issued.handoffCode)); assert.equal(requests, 1);
  f.pending.delete(f.value.pendingId); complete(await f.challenge()); await refused;
});

test('stalled challenge requests have a bounded deadline and late responses cannot restore the capability', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let complete!: (value: LocalIdentityChallenge) => void; let signal: AbortSignal | undefined;
  const handoffs = new LocalIdentityHandoffs({ issuer, identityOrigin, pending: id => f.pending.get(id), now: f.now,
    challenge: async value => { signal = value; return new Promise(done => { complete = done; }); } });
  const issued = handoffs.issue(f.value.pendingId); const request = handoffs.context(issued.handoffCode); const refused = assert.rejects(request);
  t.mock.timers.tick(15_000); await refused; assert.equal(signal?.aborted, true);
  complete(await f.challenge()); await assert.rejects(handoffs.context(issued.handoffCode));
});

test('fresh handoffs replace earlier ones and resident capabilities remain bounded', async () => {
  const f = fixture(); const first = f.handoffs.issue(f.value.pendingId); f.handoffs.issue(f.value.pendingId);
  await assert.rejects(f.handoffs.context(first.handoffCode));
  for (let i = 1; i < 128; i++) { const id = i.toString(16).padStart(32, '0'); f.pending.set(id, { ...f.value, pendingId: id }); f.handoffs.issue(id); }
  const last = 'f'.repeat(32); f.pending.set(last, { ...f.value, pendingId: last }); assert.throws(() => f.handoffs.issue(last), /busy/);
  f.advance(120_001); assert.ok(f.handoffs.issue(last).handoffCode);
});
