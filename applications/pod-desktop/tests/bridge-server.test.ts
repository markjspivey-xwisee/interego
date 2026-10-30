import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { BridgeServer } from '../src/bridge-server.js';
import { AgentService, type AgentServiceOptions } from '../src/agent-service.js';
import type { BridgeStartInput } from '../src/bridge-types.js';

const publicOrigin = 'https://temporary-bridge.trycloudflare.com';
const resource = `${publicOrigin}/mcp`;
const redirect = 'https://chatgpt.com/connector/oauth/test-callback';
const input: BridgeStartInput = { client: 'chatgpt-web', name: 'ChatGPT web', permissions: ['notes:read'], expiresInDays: 30 };
const directories: string[] = [];
const servers: BridgeServer[] = [];
const agents: AgentService[] = [];
const originalNote = { id: randomUUID(), title: 'Private local note', body: 'Only grant holders can read this.', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
async function fixture(configuration: BridgeStartInput = input, execute?: AgentServiceOptions['execute'], stable = false) {
  const directory = await mkdtemp(join(tmpdir(), 'interego-bridge-test-')); directories.push(directory);
  let binding = 'this-local-pod'; let writes = 0;
  const notes = [originalNote];
  const options: AgentServiceOptions = { dataDir: directory, protector: { protect: value => Buffer.from(value).toString('base64'), unprotect: value => Buffer.from(value, 'base64').toString() },
    getPodBinding: async () => binding,
    execute: execute ?? (async (operation, args, authorize) => {
      const principal = await authorize();
      if (operation === 'status') return { running: true, localOnly: true, federationEnabled: false };
      if (operation === 'notes.search') return { notes: notes.map(note => ({ ...note, body: undefined, excerpt: note.body.slice(0, 240) })) };
      if (operation === 'notes.read') return { note: notes.find(note => note.id === (args as { id: string }).id) };
      const now = new Date().toISOString();
      const note = { id: randomUUID(), ...(args as { title: string; body: string }), createdAt: now, updatedAt: now,
        author: { connectionId: principal.id, name: principal.name } };
      notes.push(note); writes++; return { note };
    }),
  };
  const service = new AgentService(options);
  agents.push(service);
  const persistence = stable ? { dataDir: join(directory, 'bridge-pairings'), protector: options.protector, getPodBinding: options.getPodBinding } : undefined;
  const server = new BridgeServer({ agents: service, persistence }); servers.push(server);
  let port = 0;
  if (stable) {
    const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
    const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('No test port.'); port = address.port;
    await new Promise<void>(done => reserve.close(() => done()));
  }
  const origin = stable ? 'https://permanent-pod.example' : publicOrigin;
  const address = stable ? { origin, port } : undefined;
  const loopback = await server.start(configuration, address);
  server.setPublicUrl(origin);
  return { server, service, loopback, notes, options, persistence, address, origin, resource: `${origin}/mcp`, directory,
    writes: () => writes, changePod: () => { binding = 'different-pod'; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function json(f: Fixture, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${f.loopback}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
}
async function register(f: Fixture, redirects = [redirect]) {
  const registered = await json(f, '/register', 'POST', { client_name: 'ChatGPT test client', redirect_uris: redirects, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  expect(registered.status).toBe(201); return String(registered.body['client_id']);
}
async function begin(f: Fixture, clientId: string, overrides: Record<string, string> = {}) {
  const verifier = 'secure-pkce-verifier-for-this-test-01234567890123456789';
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirect, resource: f.resource,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), state: 'bound-client-state', ...overrides });
  const response = await fetch(`${f.loopback}/authorize?${q}`); const html = await response.text();
  return { status: response.status, html, verifier, poll: html.match(/const request=(\{[^;]+\});/)?.[1] };
}
async function token(f: Fixture, values: Record<string, string>) {
  const response = await fetch(`${f.loopback}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ resource: f.resource, ...values }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
async function pair(f: Fixture, scopes?: string) {
  const clientId = await register(f); const approval = await begin(f, clientId, scopes === undefined ? {} : { scope: scopes });
  expect(approval.status).toBe(200); expect(approval.poll).toBeTruthy();
  const pending = (await f.server.status()).pendingApprovals[0]!;
  expect(approval.html).toContain(pending.verificationCode);
  const polling = JSON.parse(approval.poll!) as unknown;
  expect((await json(f, '/approval-status', 'POST', polling)).body).toEqual({ waiting: true });
  await f.server.approve(pending.id);
  const allowed = await json(f, '/approval-status', 'POST', polling);
  const callback = new URL(String(allowed.body['redirect']));
  expect(callback.origin + callback.pathname).toBe(redirect);
  expect(callback.searchParams.get('state')).toBe('bound-client-state'); expect(callback.searchParams.get('iss')).toBe(f.origin);
  const code = callback.searchParams.get('code')!;
  const issued = await token(f, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: approval.verifier });
  expect(issued.status).toBe(200);
  return { clientId, code, verifier: approval.verifier, access: String(issued.body['access_token']), refresh: String(issued.body['refresh_token']), connection: (await f.server.status()).connections.at(-1)! };
}
async function mcp(f: Fixture, access: string, method: string, params: unknown = {}) {
  return json(f, '/mcp', 'POST', { jsonrpc: '2.0', id: randomUUID(), method, params }, { authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => server.stop()));
  await Promise.all(agents.splice(0).map(service => service.close()));
  for (const path of directories.splice(0)) {
    if (dirname(resolve(path)) === resolve(tmpdir()) && basename(path).startsWith('interego-bridge-test-')) await rm(path, { recursive: true, force: true });
  }
});

describe('optional temporary web MCP bridge', () => {
  it('advertises resource-bound OAuth and exposes no pod or tools without a bearer', async () => {
    const f = await fixture();
    expect(new URL(f.loopback).hostname).toBe('127.0.0.1');
    expect(await f.server.status()).toMatchObject({ state: 'ready', url: resource, pendingApprovals: [], connections: [] });
    expect((await json(f, '/.well-known/oauth-protected-resource')).body).toEqual({ resource, authorization_servers: [publicOrigin], bearer_methods_supported: ['header'], scopes_supported: ['notes:read'] });
    const metadata = (await json(f, '/.well-known/oauth-authorization-server')).body;
    expect(metadata).toMatchObject({ issuer: publicOrigin, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    const denied = await json(f, '/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(denied.status).toBe(401); expect(denied.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource');
    for (const path of ['/agent', '/notes-key.bin', '/local-pod/', '/mcp?access_token=not-a-header']) expect((await json(f, path)).status).toBe(404);
    expect((await json(f, '/.well-known/oauth-protected-resource', 'GET', undefined, { origin: 'https://attacker.example' })).status).toBe(403);
    expect(() => f.server.setPublicUrl('https://replacement.example')).toThrow();
  });

  it('requires explicit desktop approval, binds PKCE, then serves only the chosen tools over JSON', async () => {
    const f = await fixture(); const clientId = await register(f); const approval = await begin(f, clientId);
    const pending = (await f.server.status()).pendingApprovals[0]!;
    expect(pending).toMatchObject({ clientName: 'ChatGPT test client', redirectOrigin: 'https://chatgpt.com', permissions: ['notes:read'] });
    expect(JSON.stringify(pending)).not.toContain('proof');
    expect((await json(f, '/approval-status', 'POST', { id: pending.id, proof: 'x'.repeat(43) })).status).toBe(400);
    expect((await f.server.status()).connections).toEqual([]);
    await f.server.approve(pending.id);
    const poll = await json(f, '/approval-status', 'POST', JSON.parse(approval.poll!));
    const code = new URL(String(poll.body['redirect'])).searchParams.get('code')!;
    expect((await token(f, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: 'x'.repeat(43) })).status).toBe(400);
    expect((await token(f, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: approval.verifier, resource: 'https://another.example/mcp' })).status).toBe(400);
    const issued = await token(f, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: approval.verifier });
    expect(issued.status).toBe(200); const access = String(issued.body['access_token']);
    expect((await token(f, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: approval.verifier })).status).toBe(400);
    const initialized = await mcp(f, access, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(initialized.status).toBe(200); expect(initialized.headers.get('content-type')).toContain('application/json');
    const listing = await mcp(f, access, 'tools/list');
    const tools = (listing.body['result'] as { tools: Array<{ name: string; _meta: unknown }> }).tools;
    expect(tools.map(tool => tool.name)).toEqual(['interego_status', 'interego_search_notes', 'interego_read_note']);
    expect(tools[0]!._meta).toMatchObject({ securitySchemes: [{ type: 'oauth2', scopes: ['notes:read'] }] });
    const read = await mcp(f, access, 'tools/call', { name: 'interego_read_note', arguments: { id: originalNote.id } });
    expect(read.body).toMatchObject({ result: { structuredContent: { note: originalNote } } });
    const denied = await mcp(f, access, 'tools/call', { name: 'interego_save_note', arguments: { title: 'No', body: 'No' } });
    expect(denied.body).toMatchObject({ result: { isError: true } }); expect(f.writes()).toBe(0);
    const status = await mcp(f, access, 'tools/call', { name: 'interego_status', arguments: {} });
    expect(status.body).toMatchObject({ result: { structuredContent: { storageLocal: true, remoteBridge: true, federationEnabled: false } } });
    expect(JSON.stringify(status.body)).not.toContain('localOnly');
    expect((await json(f, '/mcp', 'GET', undefined, { authorization: `Bearer ${access}` })).status).toBe(405);
  });

  it('supports save-only scopes and preserves connection provenance', async () => {
    const f = await fixture({ ...input, client: 'grok-bot', name: 'Grok Bot', permissions: ['notes:create'] }); const grant = await pair(f);
    expect(((await mcp(f, grant.access, 'tools/list')).body['result'] as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toEqual(['interego_status', 'interego_save_note']);
    const saved = await mcp(f, grant.access, 'tools/call', { name: 'interego_save_note', arguments: { title: 'Bot observation', body: 'Saved locally.' } });
    expect(saved.body).toMatchObject({ result: { structuredContent: { note: { title: 'Bot observation', author: { connectionId: grant.connection.id, name: 'Grok Bot' } } } } });
    expect(f.notes[0]).toEqual(originalNote); expect(f.writes()).toBe(1);
    const denied = await mcp(f, grant.access, 'tools/call', { name: 'interego_search_notes', arguments: { query: '' } });
    expect(denied.body).toMatchObject({ result: { isError: true } });
  });

  it('serves modern MCP requests over JSON from the same granted surface', async () => {
    const f = await fixture(); const grant = await pair(f);
    const modern = (method: string, params: Record<string, unknown> = {}) => json(f, '/mcp', 'POST', {
      jsonrpc: '2.0', id: randomUUID(), method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
    }, { authorization: `Bearer ${grant.access}`, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
      ...(typeof params['name'] === 'string' ? { 'mcp-name': params['name'] } : {}) });
    const discovered = await modern('server/discover');
    expect(discovered.status).toBe(200); expect(discovered.headers.get('content-type')).toContain('application/json');
    expect(discovered.body).toMatchObject({ result: { supportedVersions: expect.arrayContaining(['2026-07-28']) } });
    const listing = await modern('tools/list');
    expect((listing.body['result'] as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toContain('interego_read_note');
    const read = await modern('tools/call', { name: 'interego_read_note', arguments: { id: originalNote.id } });
    expect(read.body).toMatchObject({ result: { structuredContent: { note: originalNote } } });
  });

  it('rotates refresh tokens, detects replay, and checks revocation and pod binding', async () => {
    const f = await fixture(); const grant = await pair(f);
    const refreshed = await token(f, { grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refresh });
    expect(refreshed.status).toBe(200); expect(refreshed.body['refresh_token']).not.toBe(grant.refresh);
    expect((await token(f, { grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refresh })).status).toBe(400);
    expect((await mcp(f, String(refreshed.body['access_token']), 'tools/list')).status).toBe(401);
    const next = await pair(f); await f.service.revoke(next.connection.id);
    expect((await mcp(f, next.access, 'tools/list')).status).toBe(401);
    expect((await token(f, { grant_type: 'refresh_token', client_id: next.clientId, refresh_token: next.refresh })).status).toBe(400);
    const changed = await pair(f); f.changePod(); expect((await mcp(f, changed.access, 'tools/list')).status).toBe(401);
  });

  it('denies requests, rejects unsafe callbacks and scope escalation, and expires pending approval', async () => {
    const f = await fixture();
    for (const uri of ['http://chatgpt.com/callback', 'https://127.0.0.1/callback', 'https://192.168.1.2/callback', 'https://example.com/callback#token', 'https://name:secret@example.com/callback']) {
      expect((await json(f, '/register', 'POST', { redirect_uris: [uri] })).status).toBe(400);
    }
    const clientId = await register(f);
    expect((await begin(f, clientId, { scope: 'notes:create' })).status).toBe(400);
    expect((await begin(f, clientId, { code_challenge_method: 'plain' })).status).toBe(400);
    expect((await begin(f, clientId, { redirect_uri: 'https://attacker.example/callback' })).status).toBe(400);
    const denied = await begin(f, clientId); const pending = (await f.server.status()).pendingApprovals[0]!; f.server.deny(pending.id);
    const poll = await json(f, '/approval-status', 'POST', JSON.parse(denied.poll!));
    expect(new URL(String(poll.body['redirect'])).searchParams.get('error')).toBe('access_denied'); expect((await f.server.status()).connections).toEqual([]);
    await begin(f, clientId); const expiring = (await f.server.status()).pendingApprovals[0]!;
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    await expect(f.server.approve(expiring.id)).rejects.toThrow('expired'); expect((await f.server.status()).pendingApprovals).toEqual([]);
  });

  it('rejects expired access, connection expiry, and a queued write revoked before execution', async () => {
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; }); let writes = 0;
    const f = await fixture({ ...input, permissions: ['notes:create'] }, async (operation, _args, authorize) => {
      if (operation === 'status') { await authorize(); return { running: true, localOnly: true, federationEnabled: false }; }
      entered(); await gate; await authorize(); writes++; return { note: originalNote };
    });
    const grant = await pair(f);
    const pending = mcp(f, grant.access, 'tools/call', { name: 'interego_save_note', arguments: { title: 'Queued', body: 'Revoke before execution.' } });
    await started; await f.service.revoke(grant.connection.id); release();
    expect((await pending).status).toBe(401); expect(writes).toBe(0);
    const next = await pair(f); const now = Date.now(); const clock = vi.spyOn(Date, 'now'); clock.mockReturnValue(now + 6 * 60_000);
    expect((await mcp(f, next.access, 'tools/list')).status).toBe(401);
    clock.mockReturnValue(Date.parse(next.connection.expiresAt) + 1);
    expect((await f.service.get(next.connection.id)).state).toBe('expired');
    expect((await mcp(f, next.access, 'tools/list')).status).toBe(401);
  });

  it('does not complete an approval after the owner turns the bridge off', async () => {
    const f = await fixture(); const clientId = await register(f); await begin(f, clientId);
    const pending = (await f.server.status()).pendingApprovals[0]!;
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const create = f.service.create.bind(f.service);
    vi.spyOn(f.service, 'create').mockImplementation(async value => { entered(); await gate; return create(value); });
    const approval = f.server.approve(pending.id); const denied = expect(approval).rejects.toThrow('no longer');
    await started; const stopped = f.server.stop(); release(); await denied; await stopped;
    expect((await f.server.status()).state).toBe('off');
    expect((await f.service.list()).every(connection => connection.state === 'revoked')).toBe(true);
  });

  it('cancels a queued remote write when that caller disconnects', async () => {
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    let finished!: () => void; const done = new Promise<void>(resolveDone => { finished = resolveDone; }); let writes = 0;
    const f = await fixture({ ...input, permissions: ['notes:create'] }, async (operation, _args, authorize) => {
      if (operation === 'status') { await authorize(); return { running: true, localOnly: true, federationEnabled: false }; }
      entered(); await gate;
      try { await authorize(); writes++; return { note: originalNote }; } finally { finished(); }
    });
    const grant = await pair(f); const cancel = new AbortController();
    const disconnected = new Promise<void>((resolveDisconnected, rejectDisconnected) => {
      const target = new URL(f.loopback);
      const request = httpRequest({ hostname: target.hostname, port: target.port, path: '/mcp', method: 'POST',
        signal: cancel.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${grant.access}`, 'mcp-protocol-version': '2025-11-25' } });
      request.once('error', error => error.name === 'AbortError' ? resolveDisconnected() : rejectDisconnected(error));
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'interego_save_note', arguments: { title: 'Queued', body: 'Cancel this caller only.' } } }));
    });
    await started; cancel.abort(); await disconnected;
    // Other calls remain usable after this TCP caller closes its connection.
    expect((await mcp(f, grant.access, 'tools/call', { name: 'interego_status', arguments: {} })).status).toBe(200);
    release(); await done; expect(writes).toBe(0);
    expect((await f.server.status()).state).toBe('ready');
  });

  it('closes a listener whose startup finishes after Stop was requested', async () => {
    const f = await fixture(); await f.server.stop();
    const starting = f.server.start(input); const rejected = expect(starting).rejects.toThrow('stopped');
    const stopped = f.server.stop(); await rejected; await stopped;
    expect((await f.server.status()).state).toBe('off');
    // A fresh explicit start remains available after the interrupted startup.
    f.loopback = await f.server.start(input); f.server.setPublicUrl(publicOrigin);
    expect((await json(f, '/.well-known/oauth-protected-resource')).status).toBe(200);
  });

  it('starts off again with no remembered tokens and synchronously aborts queued writes when stopped', async () => {
    let entered!: () => void; const started = new Promise<void>(done => { entered = done; });
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    let writes = 0;
    const f = await fixture({ ...input, permissions: ['notes:create'] }, async (operation, _args, authorize) => {
      if (operation === 'status') { await authorize(); return { running: true, localOnly: true, federationEnabled: false }; }
      entered(); await gate; await authorize(); writes++; return { note: originalNote };
    });
    const grant = await pair(f);
    const pending = mcp(f, grant.access, 'tools/call', { name: 'interego_save_note', arguments: { title: 'Queued', body: 'Cancel when turned off.' } }).catch(() => undefined);
    await started;
    const stopped = f.server.stop(); release(); await stopped; await pending;
    expect(writes).toBe(0); expect((await f.service.get(grant.connection.id)).state).toBe('revoked');
    expect(await f.server.status()).toEqual({ state: 'off', permissions: [], pendingApprovals: [], connections: [] });
    f.loopback = await f.server.start(input); f.server.setPublicUrl(publicOrigin);
    expect((await mcp(f, grant.access, 'tools/list')).status).toBe(401);
    const fresh = new BridgeServer({ agents: f.service }); servers.push(fresh); expect((await fresh.status()).state).toBe('off');
  });

  it('rejects Host rebinding and overlarge bodies before they can become grants', async () => {
    const f = await fixture();
    const status = await new Promise<number>((done, fail) => {
      const target = new URL(f.loopback); const request = httpRequest({ hostname: target.hostname, port: target.port, path: '/.well-known/oauth-protected-resource', headers: { host: 'attacker.example' } }, response => { response.resume(); done(response.statusCode!); });
      request.once('error', fail); request.end();
    });
    expect(status).toBe(403);
    const response = await fetch(`${f.loopback}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x'.repeat(33 * 1024), redirect_uris: [redirect] }) });
    expect(response.status).toBe(413); expect((await f.server.status()).connections).toEqual([]);
  });
});

async function freshStableInstance(f: Fixture) {
  await f.server.stop(); await f.service.close();
  const service = new AgentService(f.options); agents.push(service);
  const server = new BridgeServer({ agents: service, persistence: f.persistence }); servers.push(server);
  f.service = service; f.server = server;
  return server;
}

describe('remembered stable web authorization', () => {
  it('keeps the address and approved OAuth credentials across fresh instances while starting off', async () => {
    const f = await fixture(input, undefined, true); const grant = await pair(f);
    expect((await mcp(f, grant.access, 'tools/list')).status).toBe(200);
    const firstChallenge = f.server.readiness();
    expect(await json(f, firstChallenge.path)).toMatchObject({ status: 200, body: { challenge: firstChallenge.expected } });
    const file = await readFile(join(f.directory, 'bridge-pairings', 'oauth-state.json'), 'utf8');
    const saved = JSON.parse(Buffer.from((JSON.parse(file) as { ciphertext: string }).ciphertext, 'base64').toString()) as unknown;
    expect(JSON.stringify(saved)).not.toContain(grant.access); expect(JSON.stringify(saved)).not.toContain(grant.refresh);
    await freshStableInstance(f);
    expect(await f.server.status()).toMatchObject({ state: 'off', mode: 'stable', remembered: true, url: f.resource,
      connections: [{ id: grant.connection.id, state: 'active' }] });
    await expect(fetch(`${f.loopback}/mcp`)).rejects.toThrow();
    await expect(f.server.start(input)).rejects.toThrow('Forget the saved');
    f.loopback = await f.server.start(input, f.address); f.server.setPublicUrl(f.origin);
    expect(f.server.readiness().expected).not.toBe(firstChallenge.expected);
    expect((await mcp(f, grant.access, 'tools/list')).status).toBe(200);
    const rotated = await token(f, { grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refresh });
    expect(rotated.status).toBe(200);
    await freshStableInstance(f);
    f.loopback = await f.server.start(input, f.address); f.server.setPublicUrl(f.origin);
    expect((await mcp(f, String(rotated.body['access_token']), 'tools/list')).status).toBe(200);
    expect((await token(f, { grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refresh })).status).toBe(400);
    await freshStableInstance(f);
    f.loopback = await f.server.start(input, f.address); f.server.setPublicUrl(f.origin);
    expect((await mcp(f, String(rotated.body['access_token']), 'tools/list')).status).toBe(401);
  });

  it('never restores pending browser approvals or authorization codes', async () => {
    const f = await fixture(input, undefined, true); const clientId = await register(f);
    const approved = await begin(f, clientId); const pending = (await f.server.status()).pendingApprovals[0]!;
    await f.server.approve(pending.id);
    const allowed = await json(f, '/approval-status', 'POST', JSON.parse(approved.poll!));
    const code = new URL(String(allowed.body['redirect'])).searchParams.get('code')!;
    const waiting = await begin(f, clientId); const waitingId = (await f.server.status()).pendingApprovals[0]!.id;
    await freshStableInstance(f);
    expect((await f.server.status()).pendingApprovals).toEqual([]);
    f.loopback = await f.server.start(input, f.address); f.server.setPublicUrl(f.origin);
    await expect(f.server.approve(waitingId)).rejects.toThrow('expired');
    expect((await json(f, '/approval-status', 'POST', JSON.parse(waiting.poll!))).status).toBe(400);
    expect((await token(f, { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirect, code_verifier: approved.verifier })).status).toBe(400);
  });

  it.each(['origin', 'permissions', 'pod'] as const)('invalidates remembered authorization after changing %s', async change => {
    const f = await fixture(input, undefined, true); const grant = await pair(f);
    await f.server.stop(); if (change === 'pod') f.changePod();
    await freshStableInstance(f);
    if (change === 'origin') { f.origin = 'https://replacement-pod.example'; f.resource = `${f.origin}/mcp`; f.address = { ...f.address!, origin: f.origin }; }
    const policy: BridgeStartInput = change === 'permissions' ? { ...input, permissions: ['notes:create'] } : input;
    f.loopback = await f.server.start(policy, f.address); f.server.setPublicUrl(f.origin);
    expect((await f.service.get(grant.connection.id)).state).toBe('revoked');
    expect((await mcp(f, grant.access, 'tools/list')).status).toBe(401);
    expect((await token(f, { grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refresh })).status).not.toBe(200);
  });

  it('forgets saved authority while off and never restores a disconnected grant', async () => {
    const f = await fixture(input, undefined, true); const grant = await pair(f);
    await f.server.stop(); await f.server.forget();
    expect((await f.service.get(grant.connection.id)).state).toBe('revoked');
    await freshStableInstance(f);
    expect(await f.server.status()).toEqual({ state: 'off', permissions: [], pendingApprovals: [], connections: [] });
    f.loopback = await f.server.start(input, f.address); f.server.setPublicUrl(f.origin);
    expect((await mcp(f, grant.access, 'tools/list')).status).toBe(401);
    const fresh = await pair(f); await f.service.revoke(fresh.connection.id); await freshStableInstance(f);
    f.loopback = await f.server.start(input, f.address); f.server.setPublicUrl(f.origin);
    expect((await mcp(f, fresh.access, 'tools/list')).status).toBe(401);
    expect((await token(f, { grant_type: 'refresh_token', client_id: fresh.clientId, refresh_token: fresh.refresh })).status).toBe(400);
  });

  it('fails closed on a fixed port conflict and resumes existing authorization once the conflict is removed', async () => {
    const f = await fixture(input, undefined, true); const grant = await pair(f); await f.server.stop();
    const collision = createServer(); await new Promise<void>(done => collision.listen(f.address!.port, '127.0.0.1', done));
    try { await expect(f.server.start(input, f.address)).rejects.toThrow(/EADDRINUSE|address.*in use/); }
    finally { await new Promise<void>(done => collision.close(() => done())); }
    expect((await f.server.status()).state).toBe('off');
    f.loopback = await f.server.start(input, f.address); f.server.setPublicUrl(f.origin);
    expect((await mcp(f, grant.access, 'tools/list')).status).toBe(200);
  });
});
