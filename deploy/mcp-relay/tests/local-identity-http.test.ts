import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type Response } from 'express';
import { once } from 'node:events';
import { LocalIdentityHandoffs, type LocalIdentityPending } from '../local-identity-handoff.js';
import { localIdentityContextHandler } from '../local-identity-http.js';
import { InteregoOAuthProvider } from '../oauth-provider.js';

const issuer = 'https://relay.example'; const identityOrigin = 'https://identity.example';
test('native-only context rejects page-origin and malformed requests, never discloses raw state', async () => {
  const pending: LocalIdentityPending = { pendingId: 'a'.repeat(32), clientId: 'game', clientName: 'Game', redirectUri: 'https://game.example/callback', scopes: ['mcp:read'],
    resource: null, codeChallenge: 'p'.repeat(43), state: 'private-oauth-state', expiresAt: Date.now() + 300_000 };
  let challenges = 0;
  const handoffs = new LocalIdentityHandoffs({ issuer, identityOrigin, pending: () => pending, challenge: async () => {
    challenges++; const nonce = 'n'.repeat(43); return { nonce, message: `Interego DID sign-in v1\nHost: identity.example\nNonce: ${nonce}`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  } });
  const cap = handoffs.issue(pending.pendingId);
  const app = express(); app.use(express.json()); app.post('/oauth/local-identity/context', localIdentityContextHandler(handoffs));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
  assert.ok(address && typeof address !== 'string'); const endpoint = `http://127.0.0.1:${address.port}/oauth/local-identity/context`;
  try {
    for (const variant of [{ origin: 'https://relay.example', body: { handoffCode: cap.handoffCode } }, { body: { handoffCode: cap.handoffCode, pendingId: pending.pendingId } }, { body: {} }]) {
      const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...('origin' in variant ? { Origin: variant.origin } : {}) }, body: JSON.stringify(variant.body) });
      assert.equal(r.status, 400); await r.text();
    }
    assert.equal(challenges, 0);
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handoffCode: cap.handoffCode }) });
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
    const text = await r.text(); assert.ok(!text.includes(pending.state)); const context = JSON.parse(text);
    assert.equal(context.clientId, pending.clientId); assert.equal(context.redirectUri, pending.redirectUri); assert.equal(challenges, 1);
    const replay = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handoffCode: cap.handoffCode }) }); assert.equal(replay.status, 400); await replay.text();
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
test('authorize page opts into native handoff additively and preserves hosted sign-in methods', async () => {
  for (const enabled of [false, true, 'failed']) {
    let html = ''; let claimed = '';
    const provider = new InteregoOAuthProvider({ identityUrl: identityOrigin, ...(enabled ? { nativeLoginHandoff: (id: string) => {
      claimed = id; if (enabled === 'failed') throw new Error('busy'); return { handoffCode: 'capability', expiresAt: new Date().toISOString() };
    } } : {}) });
    await provider.authorize({ client_id: 'test', client_name: 'Game <script>', redirect_uris: ['https://game.example/cb'] },
      { redirectUri: 'https://game.example/cb', codeChallenge: 'x'.repeat(43), state: 'state', scopes: ['mcp:read'] },
      { setHeader() {}, send(value: string) { html = value; } } as unknown as Response);
    for (const method of ['Passkey', 'Ethereum wallet', 'DID (Ed25519)']) assert.ok(html.includes(method));
    assert.equal(html.includes('id="interego-local-identity"'), enabled === true);
    if (enabled === true) { assert.ok(provider.getPendingAuthorization(claimed)); assert.match(html, /id="interego-local-identity"[^>]+disabled/); }
    assert.ok(!html.includes('Game <script>')); assert.ok(html.includes('Game &lt;script&gt;'));
  }
});
