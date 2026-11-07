import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { signIn } from '../src/oauth.mjs';

const RELAY = 'https://relay.example';
const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/oauth2';
const metadata = { issuer: `${RELAY}/`, authorization_endpoint: `${RELAY}/authorize`, token_endpoint: `${RELAY}/token`, registration_endpoint: `${RELAY}/register`, code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp:read', 'mcp'], token_endpoint_auth_methods_supported: ['none'] };

function harness({ metadataOverrides = {}, tokenOverrides = {}, clientOverrides = {}, callbackChange = url => url } = {}) {
  const requests = [];
  let authorization;
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/.well-known/oauth-authorization-server')) return Response.json({ ...metadata, ...metadataOverrides });
    if (url.endsWith('/register')) return Response.json({ client_id: 'public-client', token_endpoint_auth_method: 'none', ...clientOverrides });
    if (url.endsWith('/token')) return Response.json({ access_token: 'session-secret', token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read', refresh_token: 'discard-this', ...tokenOverrides });
    throw new Error('Unexpected destination');
  };
  const launch = async raw => {
    authorization = new URL(raw);
    const callback = new URL(REDIRECT);
    callback.searchParams.set('code', 'one-time-code');
    callback.searchParams.set('state', authorization.searchParams.get('state'));
    return callbackChange(callback).href;
  };
  return { run: extra => signIn({ relay: RELAY, redirectUri: REDIRECT, launch, fetchImpl, cryptoImpl: webcrypto, ...extra }), requests, get authorization() { return authorization; } };
}

test('public sign-in binds PKCE, callback, state, scope and resource without persisting refresh credentials', async () => {
  const h = harness();
  const grant = await h.run();
  assert.deepEqual(Object.keys(grant).sort(), ['accessToken', 'expiresAt', 'relay', 'scope']);
  assert.equal(grant.scope, 'mcp:read');
  assert.equal(grant.accessToken, 'session-secret');
  assert.ok(grant.expiresAt > Date.now());
  const dcr = JSON.parse(h.requests[1].options.body);
  assert.equal(dcr.token_endpoint_auth_method, 'none');
  assert.deepEqual(dcr.redirect_uris, [REDIRECT]);
  assert.equal(dcr.scope, 'mcp:read');
  const tokenForm = new URLSearchParams(h.requests[2].options.body);
  const verifier = tokenForm.get('code_verifier');
  assert.equal(h.authorization.searchParams.get('code_challenge_method'), 'S256');
  const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(verifier))).toString('base64url');
  assert.equal(h.authorization.searchParams.get('code_challenge'), expected);
  assert.equal(h.authorization.searchParams.get('resource'), `${RELAY}/mcp`);
  assert.equal(tokenForm.get('redirect_uri'), REDIRECT);
  assert.equal(tokenForm.get('code'), 'one-time-code');
  assert.equal(h.authorization.searchParams.has('access_token'), false);
  for (const request of h.requests) {
    assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.redirect, 'error');
    assert.equal(request.url.includes('session-secret'), false);
  }
});

test('every sign-in uses a fresh verifier and state', async () => {
  const first = harness(); const second = harness();
  await first.run(); await second.run();
  assert.notEqual(first.authorization.searchParams.get('state'), second.authorization.searchParams.get('state'));
  assert.notEqual(first.authorization.searchParams.get('code_challenge'), second.authorization.searchParams.get('code_challenge'));
});

test('foreign issuer, token, authorization or registration endpoints are refused before launch', async () => {
  for (const overrides of [{ issuer: 'https://attacker.example' }, { token_endpoint: 'https://attacker.example/token' }, { authorization_endpoint: 'https://attacker.example/authorize' }, { registration_endpoint: 'https://attacker.example/register' }, { code_challenge_methods_supported: ['plain'] }, { scopes_supported: ['mcp'] }, { scopes_supported: 'mcp:read' }, { token_endpoint_auth_methods_supported: 'none' }]) {
    const h = harness({ metadataOverrides: overrides });
    await assert.rejects(h.run());
    assert.equal(h.authorization, undefined);
    assert.equal(h.requests.length, 1);
  }
});

test('wrong state, callback, duplicate code or token URL never reaches the token endpoint', async () => {
  for (const callbackChange of [
    url => { url.searchParams.set('state', 'forged'); return url; },
    url => { url.hostname = 'attacker.example'; return url; },
    url => { url.pathname += '/other'; return url; },
    url => { url.searchParams.append('code', 'second'); return url; },
    url => { url.searchParams.append('state', url.searchParams.get('state')); return url; },
    url => { url.searchParams.set('access_token', 'secret'); return url; },
    url => { url.hash = 'access_token=secret'; return url; },
    url => { url.searchParams.set('error', 'access_denied'); return url; },
  ]) {
    const h = harness({ callbackChange });
    await assert.rejects(h.run());
    assert.equal(h.requests.length, 2);
  }
});

test('unexpected grants and shared-secret clients are refused', async () => {
  for (const tokenOverrides of [{ scope: 'mcp' }, { token_type: 'DPoP' }, { access_token: '' }, { expires_in: -1 }, { expires_in: 99999999 }]) await assert.rejects(harness({ tokenOverrides }).run());
  await assert.rejects(harness({ clientOverrides: { client_secret: 'secret' } }).run(), /public OAuth client/);
  await assert.rejects(harness().run({ scope: 'admin' }), /scope/);
});
