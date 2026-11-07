import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';
import { createHealthBridge } from '../bridge.mjs';
import { createEncryptedStore, createSecurity } from '../security.mjs';

const identityHost = 'identity.oauth-test.example';
const users = ['u-pk-0123456789ab', 'u-pk-abcdef012345'];
const hash = value => createHash('sha256').update(value).digest('hex');
const challenge = value => createHash('sha256').update(value).digest('base64url');
const principal = user => `did:web:${identityHost}:users:${user}`;
const agent = user => `did:web:${identityHost}:agents:interego-health-connections-${user}`;
const cookie = response => response.headers.get('set-cookie')?.split(';')[0];
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return Buffer.concat(parts).toString('utf8');
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// The relay fixture begins after a successful identity proof. It issues genuine
// single-use, PKCE-bound OAuth codes and signs challenges with a fresh test key;
// it does not simulate the user's device or claim to test WebAuthn itself.
async function fixture(t, mode = 'json') {
  const wallet = Wallet.createRandom();
  const directory = await mkdtemp(join(tmpdir(), 'health-oauth-'));
  const store = createEncryptedStore({ directory, keyHex: randomBytes(32).toString('hex') });
  const codes = new Map(), tokens = new Map(), calls = [], failures = [];
  let activeUser = users[0], tokenExchanges = 0, rpcCalls = 0, didReads = 0;
  let relayOrigin, bridgeOrigin;
  const relay = createServer((req, res) => void (async () => {
    const url = new URL(req.url, relayOrigin);
    calls.push(url.pathname);
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, { authorization_endpoint: relayOrigin + '/authorize', token_endpoint: relayOrigin + '/token' });
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('scope'), 'mcp');
      assert.equal(url.searchParams.get('resource'), relayOrigin + '/mcp');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
      assert.match(url.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(url.searchParams.get('client_id'), bridgeOrigin + '/oauth/client.json');
      assert.equal(url.searchParams.get('redirect_uri'), bridgeOrigin + '/oauth/interego/callback');
      const code = randomBytes(32).toString('hex');
      codes.set(code, { params: url.searchParams, user: activeUser });
      const target = new URL(url.searchParams.get('redirect_uri'));
      target.searchParams.set('code', code);
      target.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(303, { Location: target.href });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      tokenExchanges++;
      const params = new URLSearchParams(await body(req)), grant = codes.get(params.get('code'));
      if (!grant || challenge(params.get('code_verifier') || '') !== grant.params.get('code_challenge')) {
        return json(res, 400, { error: 'invalid_grant' });
      }
      assert.equal(params.get('grant_type'), 'authorization_code');
      for (const name of ['client_id', 'redirect_uri', 'resource']) assert.equal(params.get(name), grant.params.get(name));
      codes.delete(params.get('code'));
      // This is the relay's opaque OAuth bearer, deliberately not identity's cg2_ token.
      const accessToken = randomBytes(32).toString('hex');
      tokens.set(accessToken, grant.user);
      return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
    }
    if (req.method === 'POST' && url.pathname === '/tool/sign_request') {
      return json(res, 401, { error: 'This REST endpoint accepts identity credentials, not relay OAuth access tokens.' });
    }
    if (req.method === 'POST' && url.pathname === '/mcp') {
      rpcCalls++;
      const user = tokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
      if (!user) return json(res, 401, { error: 'invalid_token' });
      assert.match(req.headers.accept, /application\/json/);
      assert.match(req.headers.accept, /text\/event-stream/);
      assert.equal(req.headers['content-type'], 'application/json');
      assert.equal(req.headers['mcp-protocol-version'], '2025-11-25');
      assert.equal(req.headers['mcp-session-id'], undefined);
      const rpc = JSON.parse(await body(req));
      assert.equal(rpc.jsonrpc, '2.0');
      assert.equal(rpc.method, 'tools/call');
      assert.equal(rpc.params.name, 'sign_request');
      const requested = rpc.params.arguments.payload;
      assert.equal(requested.action, 'urn:interego:health:authenticate');
      assert.equal(requested.target, bridgeOrigin);
      assert.match(requested.nonce, /^[A-Za-z0-9_-]{16,128}$/);
      if (mode === 'rpc-error') return json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Synthetic relay error' } });
      const signed = JSON.stringify({ ...requested, ...(mode === 'wrong-nonce' ? { nonce: randomBytes(24).toString('base64url') } : {}), agent_id: agent(user), subject_pod_url: `https://pod.oauth-test.example/${user}/`, timestamp: new Date().toISOString() });
      const envelope = { _signed_payload: signed, _signature: await wallet.signMessage(`sha256:${hash(signed)}`) };
      const response = { jsonrpc: '2.0', id: mode === 'wrong-rpc-id' ? 'unrelated-response' : rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(envelope) }] } };
      if (mode !== 'sse') return json(res, 200, response);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': heartbeat\r\n\r\nevent: message\r\ndata:\r\n\r\n');
      res.write('data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n\r\n');
      const frame = `event: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n`;
      res.write(frame.slice(0, 57));
      return res.end(frame.slice(57));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/identity/agents/')) {
      didReads++;
      const user = users.find(value => url.pathname === `/identity/agents/interego-health-connections-${value}/did.json`);
      if (!user) return json(res, 404, { error: 'not_found' });
      return json(res, 200, { id: agent(user), controller: principal(user) });
    }
    assert.fail(`Unexpected relay request: ${req.method} ${url.pathname}`);
  })().catch(error => { failures.push(error); if (!res.headersSent) json(res, 500, { error: 'test_fixture_failure' }); else res.end(); }));
  relayOrigin = await listen(relay);
  const bridgeServer = createServer();
  bridgeOrigin = await listen(bridgeServer);
  const routedFetch = (url, options) => {
    const target = new URL(url);
    if (target.origin === `https://${identityHost}`) return fetch(relayOrigin + '/identity' + target.pathname, options);
    assert.equal(target.origin, relayOrigin, 'The sign-in flow must not contact any other service.');
    return fetch(url, options);
  };
  const security = createSecurity({ relayUrl: relayOrigin, identityHost, trustedRelayAddresses: [wallet.address], targetOrigin: bridgeOrigin, store, fetch: routedFetch });
  const bridge = createHealthBridge({ publicUrl: bridgeOrigin, relayUrl: relayOrigin, store, security, fetch: routedFetch, duke: {}, oura: {} });
  bridgeServer.on('request', bridge.handler);
  t.after(async () => {
    await Promise.all([new Promise(resolve => bridgeServer.close(resolve)), new Promise(resolve => relay.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(failures, [], 'All relay protocol assertions must hold.');
  });
  const begin = async (user = users[0]) => {
    activeUser = user;
    const start = await fetch(bridgeOrigin + '/oauth/interego/start', { redirect: 'manual' });
    assert.equal(start.status, 303);
    const flowCookie = cookie(start);
    assert.ok(flowCookie);
    const authorization = await fetch(start.headers.get('location'), { redirect: 'manual' });
    assert.equal(authorization.status, 303);
    return { callback: authorization.headers.get('location'), flowCookie };
  };
  const finish = flow => fetch(flow.callback, { headers: { Cookie: flow.flowCookie }, redirect: 'manual' });
  const status = session => fetch(bridgeOrigin + '/api/status', { headers: session ? { Cookie: session } : {} });
  return { begin, finish, status, bridgeOrigin, relayOrigin, calls, directory, tokens, counts: () => ({ tokenExchanges, rpcCalls, didReads }) };
}

for (const mode of ['json', 'sse']) test(`fresh OAuth login completes through signed MCP ${mode.toUpperCase()} challenge and binds the owner`, async t => {
  const f = await fixture(t, mode), flow = await f.begin(), callback = await f.finish(flow);
  assert.equal(callback.status, 303);
  assert.equal(new URL(callback.headers.get('location')).searchParams.get('connected'), 'interego');
  assert.match(callback.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const session = cookie(callback);
  const response = await f.status(session);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(status.owner, { userId: users[0], principal: principal(users[0]) });
  assert.equal(status.recordCount, 0);
  assert.equal(status.consent.enabled, false);
  assert.equal(status.sources.duke.connected, false);
  assert.equal(status.sources.apple.connected, false);
  const records = await fetch(f.bridgeOrigin + '/api/records?owner=' + users[1], { headers: { Cookie: session } });
  assert.equal(records.status, 200);
  assert.equal((await records.json()).total, 0);
  assert.equal((await f.status()).status, 401);
  assert.deepEqual(f.counts(), { tokenExchanges: 1, rpcCalls: 1, didReads: 1 });
  assert.equal(f.calls.includes('/tool/sign_request'), false);
  assert.equal((await fetch(f.relayOrigin + '/tool/sign_request', { method: 'POST', headers: { Authorization: 'Bearer ' + f.tokens.keys().next().value, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  // Only authentication replay state is persisted; login creates no health imports.
  assert.deepEqual(await readdir(f.directory), [hash('security/replay-ledger') + '.json']);
  const replay = await f.finish(flow);
  assert.equal(new URL(replay.headers.get('location')).searchParams.get('error'), 'oauth_state');
  assert.equal(cookie(replay), undefined);
  assert.equal(f.counts().tokenExchanges, 1);
  const other = await f.finish(await f.begin(users[1]));
  assert.equal((await (await f.status(cookie(other))).json()).owner.principal, principal(users[1]));
  assert.equal((await (await f.status(session)).json()).owner.principal, principal(users[0]));
});

test('invalid OAuth state or a different browser cannot exchange a code or create a session', async t => {
  const f = await fixture(t), flow = await f.begin();
  const invalid = new URL(flow.callback); invalid.searchParams.set('state', 'not-the-original-state');
  const callback = await f.finish({ ...flow, callback: invalid.href });
  assert.equal(new URL(callback.headers.get('location')).searchParams.get('error'), 'oauth_state');
  assert.equal(cookie(callback), undefined);
  const differentBrowser = await f.finish({ ...flow, flowCookie: 'interego-health-flow=not-the-bound-browser' });
  assert.equal(new URL(differentBrowser.headers.get('location')).searchParams.get('error'), 'oauth_state');
  assert.equal(cookie(differentBrowser), undefined);
  assert.equal((await f.status()).status, 401);
  assert.deepEqual(f.counts(), { tokenExchanges: 0, rpcCalls: 0, didReads: 0 });
});

for (const mode of ['rpc-error', 'wrong-rpc-id', 'wrong-nonce']) test(`OAuth callback creates no session after ${mode}`, async t => {
  const f = await fixture(t, mode), callback = await f.finish(await f.begin());
  assert.equal(callback.status, 303);
  assert.ok(new URL(callback.headers.get('location')).searchParams.has('error'));
  assert.equal(cookie(callback), undefined);
  assert.equal((await f.status()).status, 401);
  assert.equal(f.counts().tokenExchanges, 1);
  assert.equal(f.counts().rpcCalls, 1);
  assert.equal(f.calls.includes('/tool/sign_request'), false);
});
