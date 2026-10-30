import { afterEach, expect, it } from 'vitest';
import { randomUUID, webcrypto } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BridgeServer } from '../src/bridge-server.js';
import { AgentService } from '../src/agent-service.js';

const origin = 'https://my-private-pod.example';
const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32);
const redirectUri = 'https://' + 'a'.repeat(32) + '.chromiumapp.org/interego';
type Json = Record<string, unknown>;
interface Session { relay: string; accessToken: string; refreshToken: string; clientId: string; tokenEndpoint: string; scope: string }
interface LocalModule {
  discoverLocalCatalog(origin: string, token: string, options: { fetchImpl: typeof fetch }): Promise<Json>;
  callLocalTool(origin: string, token: string, catalog: Json, name: string, args: Json, options: { fetchImpl: typeof fetch }): Promise<Json>;
  localProfile(status: Json, origin: string): { id: string; podUrl: string; mode: string };
  refreshLocalSession(session: Session, options: { fetchImpl: typeof fetch }): Promise<Session>;
  revokeLocalSession(session: Session, options: { fetchImpl: typeof fetch }): Promise<void>;
}
interface OAuthModule {
  signIn(input: { relay: string; mode: string; scope: string; redirectUri: string; fetchImpl: typeof fetch; cryptoImpl: typeof webcrypto; launch(url: string): Promise<string> }): Promise<Session>;
}
const local = await import(new URL('../../browser-wallet/src/local.mjs', import.meta.url).href) as LocalModule;
const oauth = await import(new URL('../../browser-wallet/src/oauth.mjs', import.meta.url).href) as OAuthModule;
let server: BridgeServer | undefined;
let agents: AgentService | undefined;
let directory: string | undefined;

afterEach(async () => {
  await server?.stop(); await agents?.close();
  if (directory && dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-wallet-bridge-')) {
    await rm(directory, { recursive: true, force: true });
  }
  server = undefined; agents = undefined; directory = undefined;
});

it('connects the real wallet OAuth and MCP adapters to the real local bridge, reads and saves once, refreshes, and obeys revocation', async () => {
  directory = await mkdtemp(join(tmpdir(), 'interego-wallet-bridge-'));
  const notes = [{ id: randomUUID(), title: 'Existing local note', body: 'Private stored fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
  let writes = 0;
  agents = new AgentService({ dataDir: directory, protector: { protect: text => Buffer.from(text).toString('base64'), unprotect: text => Buffer.from(text, 'base64').toString() },
    getPodBinding: async () => 'isolated-wallet-fixture-pod', execute: async (operation, args, authorize) => {
      await authorize();
      const values = args as Json;
      if (operation === 'status') return { running: true, localOnly: true, federationEnabled: false };
      if (operation === 'notes.search') return { notes: notes.slice(0, Number(values['limit'])).map(note => ({ ...note, body: undefined, excerpt: note.body.slice(0, 240) })) };
      if (operation === 'notes.read') return { note: notes.find(note => note.id === values['id']) };
      const note = { id: randomUUID(), title: String(values['title']), body: String(values['body']), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes.push(note); writes++; return { note };
    } });
  server = new BridgeServer({ agents, allowedBrowserOrigins: async () => [extensionOrigin] });
  const loopback = await server.start({ client: 'other-web', name: 'Browser wallet', permissions: ['notes:read', 'notes:create'], expiresInDays: 30 });
  server.setPublicUrl(origin);
  // Only the public TLS hop is replaced with this fixture's loopback HTTP route.
  // OAuth, PKCE, origin checks, native approval, MCP handlers and grants are real.
  const fetchImpl: typeof fetch = async (raw, init = {}) => {
    const url = new URL(String(raw));
    expect(url.origin).toBe(origin);
    expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit');
    const response = await fetch(loopback + url.pathname + url.search, { ...init, headers: { ...init.headers, Origin: extensionOrigin } });
    expect(response.headers.get('access-control-allow-origin')).toBe(extensionOrigin);
    return response;
  };
  const preflight = await fetch(loopback + '/mcp', { method: 'OPTIONS', headers: { Origin: extensionOrigin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version' } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe(extensionOrigin);
  const session = await oauth.signIn({ relay: origin, mode: 'local', scope: 'notes:read notes:create', redirectUri, fetchImpl, cryptoImpl: webcrypto,
    launch: async address => {
      const url = new URL(address);
      expect(url.origin).toBe(origin);
      const page = await (await fetch(loopback + url.pathname + url.search)).text();
      const pending = (await server!.status()).pendingApprovals[0]!;
      expect(page).toContain(pending.verificationCode);
      const polling = page.match(/const request=(\{[^;]+\});/)?.[1];
      expect(polling).toBeTruthy();
      await server!.approve(pending.id);
      const approval = await (await fetch(loopback + '/approval-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: polling })).json() as { redirect: string };
      return approval.redirect;
    } });
  const catalog = await local.discoverLocalCatalog(origin, session.accessToken, { fetchImpl });
  const call = (name: string, args: Json = {}, active = session) => local.callLocalTool(origin, active.accessToken, catalog, name, args, { fetchImpl });
  const profile = local.localProfile(await call('get_pod_status'), origin);
  expect(profile.mode).toBe('local');
  const discovered = await call('discover_context', { pod_url: profile.podUrl, limit: 12 });
  const entries = discovered['entries'] as Array<{ descriptorUrl: string }>;
  expect(entries[0]!.descriptorUrl).toBe('urn:graph:pod-note:' + notes[0]!.id);
  const read = await call('get_descriptor', { url: entries[0]!.descriptorUrl });
  expect(read['graph']).toMatchObject({ content: notes[0]!.body });
  const saved = await call('remember', { title: 'Reviewed browser note', body: 'Only this exact text', visibility: 'private' });
  expect(writes).toBe(1);
  const checked = await call('get_descriptor', { url: saved['descriptorUrl'] });
  expect(checked['graph']).toMatchObject({ content: 'Only this exact text' });
  const renewed = await local.refreshLocalSession(session, { fetchImpl });
  expect(renewed.refreshToken).not.toBe(session.refreshToken);
  expect(local.localProfile(await call('get_pod_status', {}, renewed), origin).id).toBe(profile.id);
  await local.revokeLocalSession(renewed, { fetchImpl });
  await expect(call('get_descriptor', { url: saved['descriptorUrl'] }, renewed)).rejects.toThrow();
  expect(writes).toBe(1);
});
