import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { signIn } from '../src/oauth.mjs';
import { discoverLocalCatalog, callLocalTool, localProfile, localScope, refreshLocalSession, revokeLocalSession } from '../src/local.mjs';

const relay = 'https://my-pod.example';
const id = '392ac949-4b07-4f43-9f60-79d9aff67f7b';
const grantId = '7d908358-4808-471c-aecc-971392076629';
const note = { id, title: 'Local note', body: 'Private content', createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z' };
const schemas = {
  interego_status: { type: 'object', properties: {}, additionalProperties: false },
  interego_search_notes: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', maximum: 50 } }, required: ['query'], additionalProperties: false },
  interego_read_note: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  interego_save_note: { type: 'object', properties: { title: { type: 'string', maxLength: 160 }, body: { type: 'string', maxLength: 50_000 } }, required: ['title', 'body'], additionalProperties: false },
};
function harness() {
  const calls = [];
  const mode = { schema: schemas, resultChange: value => value, responseId: null };
  const fetchImpl = async (url, init) => {
    assert.equal(url, relay + '/mcp');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.Authorization, 'Bearer access');
    const body = JSON.parse(init.body); calls.push(body);
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'interego-local-pod-bridge' } };
    else if (body.method === 'tools/list') result = { tools: Object.entries(mode.schema).map(([name, inputSchema]) => ({ name, inputSchema })) };
    else {
      const name = body.params.name;
      if (name === 'interego_status') result = { storageLocal: true, remoteBridge: true, running: true, connection: { id: grantId, name: 'Browser wallet', state: 'active', permissions: ['notes:read', 'notes:create'] } };
      else if (name === 'interego_search_notes') result = { notes: [{ ...note, body: undefined }] };
      else if (name === 'interego_read_note' || name === 'interego_save_note') result = { note: { ...note, ...(name === 'interego_save_note' ? body.params.arguments : {}) } };
      result = { structuredContent: mode.resultChange(result) };
    }
    return Response.json({ jsonrpc: '2.0', id: mode.responseId ?? body.id, result });
  };
  return { calls, mode, options: { fetchImpl }, catalog: () => discoverLocalCatalog(relay, 'access', { fetchImpl }) };
}

test('local MCP projection discovers exact known tools and preserves canonical note references', async () => {
  const h = harness(); const catalog = await h.catalog();
  const status = await callLocalTool(relay, 'access', catalog, 'get_pod_status', {}, h.options);
  const profile = localProfile(status, relay);
  assert.equal(profile.mode, 'local'); assert.match(profile.principal, /Local connection:/); assert.equal(profile.principal.startsWith('did:'), false);
  const list = await callLocalTool(relay, 'access', catalog, 'discover_context', { pod_url: profile.podUrl, limit: 12 }, h.options);
  assert.equal(list.entries[0].descriptorUrl, 'urn:graph:pod-note:' + id);
  const read = await callLocalTool(relay, 'access', catalog, 'get_descriptor', { url: list.entries[0].descriptorUrl }, h.options);
  assert.equal(read.graph.content, note.body); assert.equal(read.authorship, undefined);
  assert.equal(h.calls.filter(c => c.method === 'tools/call').length, 3);
});

test('local projection checks tool schemas and never sends arbitrary URLs or unreviewed visibility', async () => {
  const h = harness(); const catalog = await h.catalog(); const count = h.calls.length;
  for (const [name, args] of [['get_descriptor', { url: 'http://127.0.0.1/private' }], ['remember', { title: 'No', body: 'No', visibility: 'public' }], ['act', {}], ['remember', { title: 'x'.repeat(161), body: 'No', visibility: 'private' }]]) {
    await assert.rejects(callLocalTool(relay, 'access', catalog, name, args, h.options));
  }
  assert.equal(h.calls.length, count);
  await assert.rejects(callLocalTool('https://other.example', 'access', catalog, 'get_pod_status', {}, h.options));
});

test('local save checks the exact accepted note and distinguishes MCP errors', async () => {
  const h = harness(); const catalog = await h.catalog();
  assert.deepEqual(await callLocalTool(relay, 'access', catalog, 'remember', { title: 'Reviewed', body: 'Exact text', visibility: 'private' }, h.options), { remembered: true, visibility: 'private', descriptorUrl: 'urn:graph:pod-note:' + id });
  h.mode.resultChange = value => ({ ...value, note: { ...note, body: 'Different' } });
  await assert.rejects(callLocalTool(relay, 'access', catalog, 'remember', { title: note.title, body: note.body, visibility: 'private' }, h.options), /reviewed note/);
  h.mode.resultChange = () => ({ isError: true });
  await assert.rejects(callLocalTool(relay, 'access', catalog, 'get_pod_status', {}, h.options), /refused/);
});

test('ambiguous catalogs, unmatched JSON-RPC ids and missing read scope fail closed', async () => {
  const h = harness(); h.mode.responseId = 'different-request'; await assert.rejects(h.catalog(), /invalid MCP/);
  h.mode.responseId = null; h.mode.schema = { interego_status: schemas.interego_status };
  await assert.rejects(h.catalog(), /permission to read/);
  for (const value of [{ identity: { did: 'did:web:owner' } }, { storageLocal: false }, { storageLocal: true, remoteBridge: true, running: true, connection: { id: 'not-an-id' } }]) assert.throws(() => localProfile(value, relay));
});

test('local OAuth requests only notes scopes and retains rotating authority only for the browser session', async () => {
  const requests = []; let scope;
  const redirectUri = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/interego';
  const grant = await signIn({ relay, mode: 'local', scope: localScope('mcp:write'), redirectUri, cryptoImpl: webcrypto,
    launch: async value => { const auth = new URL(value); scope = auth.searchParams.get('scope'); const callback = new URL(redirectUri); callback.searchParams.set('state', auth.searchParams.get('state')); callback.searchParams.set('code', 'approved'); return callback.href; },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/.well-known/oauth-authorization-server')) return Response.json({ issuer: relay, authorization_endpoint: relay + '/authorize', token_endpoint: relay + '/token', registration_endpoint: relay + '/register', scopes_supported: ['notes:read', 'notes:create'], code_challenge_methods_supported: ['S256'] });
      if (url.endsWith('/register')) return Response.json({ client_id: 'client', token_endpoint_auth_method: 'none' });
      return Response.json({ access_token: 'access', refresh_token: 'r'.repeat(43), scope, token_type: 'Bearer', expires_in: 300 });
    } });
  assert.equal(scope, 'notes:read notes:create'); assert.equal(grant.refreshToken, 'r'.repeat(43));
  assert.equal(new URLSearchParams(requests.at(-1).init.body).get('resource'), relay + '/mcp');
  await assert.rejects(signIn({ relay, mode: 'local', scope: 'mcp:write', redirectUri }), /read or write scope/);
  assert.throws(() => localScope('arbitrary'));
});

test('refresh tokens rotate with exact resource and scope and cannot move to another origin', async () => {
  const session = { relay, tokenEndpoint: relay + '/token', clientId: 'client', scope: 'notes:read', refreshToken: 'r'.repeat(43), accessToken: 'old' };
  let sent;
  const options = { now: () => 1000, fetchImpl: async (url, init) => { sent = { url, init }; return Response.json({ access_token: 'new', refresh_token: 's'.repeat(43), scope: 'notes:read', token_type: 'Bearer', expires_in: 300 }); } };
  const rotated = await refreshLocalSession(session, options);
  assert.equal(rotated.accessToken, 'new'); assert.equal(rotated.refreshToken, 's'.repeat(43)); assert.equal(rotated.expiresAt, 301000);
  assert.equal(new URLSearchParams(sent.init.body).get('resource'), relay + '/mcp');
  await assert.rejects(refreshLocalSession({ ...session, tokenEndpoint: 'https://attacker.example/token' }, options));
  await assert.rejects(refreshLocalSession(session, { fetchImpl: async () => Response.json({ access_token: 'new', refresh_token: session.refreshToken, scope: 'notes:read', token_type: 'Bearer', expires_in: 300 }) }));
});

test('local forget revokes only the selected OAuth session without cookies or a URL token', async () => {
  const calls = [];
  await revokeLocalSession({ relay, clientId: 'client', refreshToken: 'r'.repeat(43) }, { fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({}); } });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, relay + '/revoke');
  assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(new URLSearchParams(calls[0].init.body).get('token'), 'r'.repeat(43));
});
