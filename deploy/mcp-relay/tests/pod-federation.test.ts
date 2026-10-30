#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import express from 'express';
import type { Response as ExpressResponse } from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { generateKeyPair, type FetchFn, type ManifestEntry } from '@interego/core';
import { FederationService, type FederationResource, type FederationStore } from '@interego/pod-federation';
import { encryptedFederationStore } from '../pod-federation-store.js';
import { FEDERATION_MANAGE_SCOPE, FederationHttpError, federationOwnerFromOAuth, hostedFederationHttp } from '../pod-federation-http.js';
import { hostedFederationResources } from '../pod-federation-resources.js';
import { hostedFederationPage } from '../pod-federation-page.js';
import { InteregoOAuthProvider } from '../oauth-provider.js';

const cssUrl = 'https://store.example/';
const ownerExtra = { userId: 'u-owner', ownerWebId: 'https://id.example/users/u-owner/profile#me',
  podUrl: cssUrl + 'u-owner/', agentId: 'did:web:id.example:agents:browser-u-owner', identityToken: 'private-identity-token' };
const owner = federationOwnerFromOAuth({ scopes: [FEDERATION_MANAGE_SCOPE], extra: ownerExtra }, cssUrl);
const authError = (status: number) => (error: unknown) => error instanceof FederationHttpError && error.status === status;

function pod() {
  const files = new Map<string, { text: string; version: number }>();
  let failed = false;
  const fetch: FetchFn = async (url, init = {}) => {
    if (failed) return new Response('{}', { status: 503 });
    const existing = files.get(url), headers = new Headers(init.headers);
    if (init.method === 'PUT') {
      if (headers.get('If-None-Match') === '*' && existing
        || headers.has('If-Match') && headers.get('If-Match') !== '"' + existing?.version + '"') return new Response('{}', { status: 412 });
      const next = { text: String(init.body), version: (existing?.version ?? 0) + 1 };
      files.set(url, next); return new Response('{}', { status: 201, headers: { ETag: '"' + next.version + '"' } });
    }
    return existing ? new Response(existing.text, { headers: { ETag: '"' + existing.version + '"' } }) : new Response('{}', { status: 404 });
  };
  return { files, fetch, fail: () => { failed = true; } };
}
function memory(): FederationStore {
  let value: unknown = null;
  return { load: async () => structuredClone(value), save: async state => { value = structuredClone(state); } };
}
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('listener unavailable');
  return 'http://127.0.0.1:' + address.port;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

test('federation management requires its dedicated grant and a proven same-owner hosted pod', () => {
  for (const scopes of [['mcp'], ['mcp:write'], ['mcp:read'], []]) assert.throws(() => federationOwnerFromOAuth({ scopes, extra: ownerExtra }, cssUrl), authError(403));
  assert.equal(owner.podUrl, cssUrl + 'u-owner/');
  assert.equal(owner.userId, 'u-owner');
  for (const extra of [{ ...ownerExtra, userId: '../victim' }, { ...ownerExtra, podUrl: cssUrl + 'victim/' },
    { ...ownerExtra, identityToken: undefined }, { ...ownerExtra, provisionalPlay: {} }]) {
    assert.throws(() => federationOwnerFromOAuth({ scopes: [FEDERATION_MANAGE_SCOPE], extra }, cssUrl), authError(403));
  }
  assert.equal(federationOwnerFromOAuth({ scopes: [FEDERATION_MANAGE_SCOPE], extra: { ...ownerExtra, podUrl: 'https://public.example/u-owner/' } }, cssUrl,
    value => value.replace('https://public.example/', cssUrl)).userId, 'u-owner');
});

test('the actual OAuth page explains pod-management authority only for its explicit scope', async () => {
  const provider = new InteregoOAuthProvider({ identityUrl: 'https://identity.example', tokenTtlSec: 3600 });
  for (const scopes of [['mcp'], ['mcp:read'], ['mcp:write'], [FEDERATION_MANAGE_SCOPE], ['mcp', FEDERATION_MANAGE_SCOPE]]) {
    let html = '';
    const response = { setHeader: () => response, send: (value: string) => { html = value; return response; } };
    await provider.authorize({ client_id: 'consent-test', client_name: 'A selected app', redirect_uris: ['https://client.example/callback'] },
      { scopes, redirectUri: 'https://client.example/callback', codeChallenge: 'x'.repeat(43) }, response as unknown as ExpressResponse);
    assert.equal(html.includes('id="federation-consent"'), scopes.includes(FEDERATION_MANAGE_SCOPE));
    if (scopes.includes(FEDERATION_MANAGE_SCOPE)) {
      assert.match(html, /turn on pod sharing, approve or disconnect other pods/);
      assert.match(html, /recipient can keep copies already received/);
    }
  }
});

test('hosted state is encrypted, owner-bound and conditionally saved across restart', async () => {
  const backing = pod(), key = generateKeyPair();
  const config = { podUrl: owner.podUrl, fetch: backing.fetch, encryptionKey: key };
  const first = encryptedFederationStore(config);
  assert.equal(await first.load(), null);
  await first.save({ privateKey: 'never-visible-private-key', note: 'family-private-content' });
  const bytes = [...backing.files.values()][0].text;
  assert.ok(!bytes.includes('never-visible-private-key') && !bytes.includes('family-private-content'));
  assert.deepEqual(await encryptedFederationStore(config).load(), { privateKey: 'never-visible-private-key', note: 'family-private-content' });
  const stale = encryptedFederationStore(config); await stale.load();
  await first.save({ updated: true });
  await assert.rejects(stale.save({ lost: true }), /changed in another session/);
  assert.deepEqual(await encryptedFederationStore(config).load(), { updated: true });
  await first.save(null);
  assert.equal(await encryptedFederationStore(config).load(), null);
  const source = backing.files.get(owner.podUrl + 'private-pod-federation/state.json')!;
  backing.files.set(cssUrl + 'victim/private-pod-federation/state.json', source);
  await assert.rejects(encryptedFederationStore({ ...config, podUrl: cssUrl + 'victim/' }).load(), /could not be opened/);
  await assert.rejects(encryptedFederationStore({ ...config, encryptionKey: generateKeyPair() }).load(), /could not be opened/);
  backing.files.set(owner.podUrl + 'private-pod-federation/state.json', { text: '{"version":1,"private":"plaintext"}', version: 9 });
  const recovery = encryptedFederationStore(config);
  await assert.rejects(recovery.load(), /could not be opened/);
  await recovery.save(null);
  assert.equal(await encryptedFederationStore(config).load(), null);
  const withoutRevision = encryptedFederationStore({ ...config, fetch: async () => new Response('{"damaged":true}') });
  await assert.rejects(withoutRevision.save(null), /could not be opened/);
});

test('chunked private-state reads stop at the byte ceiling and never fall back to unbounded text()', async () => {
  const block = new Uint8Array(8 * 1024 * 1024);
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { if (++pulls <= 20) controller.enqueue(block); else controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const chunked = encryptedFederationStore({ podUrl: owner.podUrl, encryptionKey: generateKeyPair(),
    fetch: async () => new Response(stream, { headers: { ETag: '"chunked"' } }) });
  await assert.rejects(chunked.load(), /could not be opened/);
  assert.equal(pulls, 9, 'read eight permitted chunks and stop immediately at the ninth');
  assert.equal(cancelled, true, 'cancel the unconsumed remainder instead of draining it');
  let textCalls = 0;
  const noStream = encryptedFederationStore({ podUrl: owner.podUrl, encryptionKey: generateKeyPair(), fetch: async () => ({
    ok: true, status: 200, statusText: 'OK', headers: { get: name => name.toLowerCase() === 'etag' ? '"no-stream"' : null },
    text: async () => { textCalls++; return '{}'; }, json: async () => ({}),
  }) });
  await assert.rejects(noStream.load(), /could not be opened/);
  assert.equal(textCalls, 0, 'a transport without bounded streaming is refused before consuming its body');
});

test('private-state deadlines reject stalled headers, cancel late bodies and stop a stalled reader', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let deliver: (response: Response) => void = () => undefined;
    let signal: AbortSignal | undefined, lateCancelled = false;
    const responseReady = new Promise<Response>(resolve => { deliver = resolve; });
    const late = encryptedFederationStore({ podUrl: owner.podUrl, encryptionKey: generateKeyPair(), fetch: (_url, init) => {
      signal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return responseReady;
    } });
    const rejected = assert.rejects(late.load(), /could not be opened/);
    context.mock.timers.tick(15_000);
    await rejected;
    assert.equal(signal?.aborted, true);
    deliver(new Response(new ReadableStream<Uint8Array>({ cancel() { lateCancelled = true; } }), { headers: { ETag: '"late"' } }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(lateCancelled, true, 'a header response arriving after the deadline has its unread body cancelled');

    let readerCancelled = false;
    const stalled = encryptedFederationStore({ podUrl: owner.podUrl, encryptionKey: generateKeyPair(),
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ cancel() { readerCancelled = true; } }), { headers: { ETag: '"stalled"' } }) });
    const stalledRead = assert.rejects(stalled.load(), /could not be opened/);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    context.mock.timers.tick(15_000);
    await stalledRead;
    assert.equal(readerCancelled, true, 'a body that stops producing bytes is cancelled at the whole-read deadline');
  } finally { context.mock.timers.reset(); }
});

test('resource selection rechecks owner manifest and preserves original representations', async () => {
  const id = owner.podUrl + 'context-graphs/version.ttl';
  const turtle = '<urn:original> <urn:predicate> "signed descriptor bytes" .\n';
  const graph = '<urn:graph:original> { <urn:subject> <urn:value> "private original bytes" . }\n';
  let entries: ManifestEntry[] = [{ descriptorUrl: id, describes: ['urn:graph:original'], facetTypes: ['Agent'], validFrom: '2026-10-30T00:00:00Z' }];
  let reads = 0;
  const selection = hostedFederationResources({ entries: async () => entries,
    ownResource: (actor, url) => url.startsWith(actor.podUrl),
    descriptor: async () => { reads++; return { url: id, turtle, graph: { url: owner.podUrl + 'context-graphs/original.envelope.jose.json', mediaType: 'application/trig', content: graph } }; } });
  assert.equal((await selection.list(owner))[0].id, id);
  await assert.rejects(selection.selected(owner, [cssUrl + 'victim/secret.ttl']));
  await assert.rejects(selection.selected(owner, [owner.podUrl + 'auth-methods.jsonld']));
  assert.equal(reads, 0);
  const snapshots = await selection.selected(owner, [id]);
  assert.equal(snapshots[0].iri, 'urn:graph:original');
  assert.equal(JSON.parse(snapshots[0].content).descriptorTurtle, turtle);
  assert.equal(JSON.parse(snapshots[0].content).graphContent, graph);
  entries = [];
  await assert.rejects(selection.selected(owner, [id]));
  assert.equal(reads, 1);
});

test('actual local service federates with hosted HTTP owner/peer routes, encrypted persistence and revocation', async () => {
  const backing = pod(), key = generateKeyPair(), cache = new Map<string, FederationService>();
  const app = express(); app.use(express.json({ limit: '512kb' }));
  const hostedServer = createServer(app), hostedOrigin = await listen(hostedServer);
  const localStore = memory();
  const localServer = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const reply = await local.handle(new Request(localOrigin + req.url, { method: req.method,
      ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }), headers: { 'content-type': 'application/json' } }));
    res.writeHead(reply.status, Object.fromEntries(reply.headers)); res.end(await reply.text());
  });
  const localOrigin = await listen(localServer);
  const local = new FederationService({ store: localStore, binding: async () => 'local-pod-owner', allowLoopbackForTests: true });
  const selected: FederationResource = { iri: 'urn:graph:chosen', mediaType: 'text/plain', content: 'Only this chosen family note.' };
  let sourceReads = 0;
  const publicCreates: boolean[] = [];
  app.use('/pod-federation', hostedFederationHttp({ publicUrl: hostedOrigin,
    authorize: async header => {
      if (header === 'Bearer owner') return owner;
      if (header === 'Bearer assistant') return federationOwnerFromOAuth({ scopes: ['mcp'], extra: ownerExtra }, cssUrl);
      throw new FederationHttpError(401, 'Sign in required.');
    },
    service: async (id, ownerOperation) => {
      publicCreates.push(ownerOperation);
      const existing = cache.get(id); if (existing || !ownerOperation) return existing;
      const service = new FederationService({ store: encryptedFederationStore({ podUrl: owner.podUrl, fetch: backing.fetch, encryptionKey: key }),
        binding: async () => owner.podUrl, allowLoopbackForTests: true, refreshState: true });
      cache.set(id, service); return service;
    },
    listResources: async () => [{ id: 'chosen', title: 'A chosen note' }],
    resources: async (actor, ids) => { assert.equal(actor.userId, 'u-owner'); assert.deepEqual(ids, ['chosen']); sourceReads++; return [selected]; },
  }));
  const http = async (path: string, body?: unknown, token = 'owner', headers: Record<string, string> = {}) => {
    const response = await fetch(hostedOrigin + '/pod-federation/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, value: await response.json() as Record<string, unknown> };
  };
  try {
    assert.equal((await http('owner/status', undefined, 'assistant')).response.status, 403);
    assert.equal(cache.size, 0);
    assert.equal((await http('owner/status', undefined, 'none')).response.status, 401);
    assert.equal((await http('owner/configure', { name: 'Hosted family pod' }, 'owner', { Origin: 'https://unrelated.example' })).response.status, 403);
    assert.equal((await http('owner/configure', { name: 'Hosted family pod', userId: 'victim' })).response.status, 400);
    assert.equal((await http('peers/u-owner/profile')).response.status, 503);
    assert.equal(cache.size, 1); // The authenticated malformed request created only its own OFF context.
    const configured = await http('owner/configure', { name: 'Hosted family pod' }); assert.equal(configured.response.status, 200);
    assert.equal((configured.value as { enabled?: unknown }).enabled, false);
    assert.equal((await http('owner/invite', {})).response.status, 400);
    assert.equal((await http('owner/enable', { enabled: true })).response.status, 200);
    await local.configure({ name: 'My local pod', endpoint: localOrigin + '/pod-federation', kind: 'local' }); await local.setEnabled(true);
    const invite = await http('owner/invite', {}); assert.equal(invite.response.status, 200);
    await local.acceptInvite(String(invite.value.code));
    let hostedStatus = (await http('owner/status')).value.status as Awaited<ReturnType<FederationService['status']>>;
    assert.equal(hostedStatus.pending.length, 1); assert.equal(hostedStatus.peers.length, 0);
    assert.equal((await http('owner/approve', { id: hostedStatus.pending[0].id, verificationCode: 'WRONG' })).response.status, 400);
    assert.equal((await http('owner/approve', { id: hostedStatus.pending[0].id, verificationCode: hostedStatus.pending[0].verificationCode })).response.status, 200);
    await local.refresh();
    const localStatus = await local.status(), hostedId = localStatus.peers[0].id;
    assert.equal(localStatus.peers[0].kind, 'hosted');
    const localCopy: FederationResource = { iri: 'urn:graph:local-chosen', mediaType: 'text/plain', content: 'Chosen local note for my brother.' };
    await local.share(hostedId, [localCopy]);
    hostedStatus = (await http('owner/status')).value.status as typeof hostedStatus;
    assert.equal(hostedStatus.received.length, 1);
    assert.equal((await http('owner/received', { id: hostedStatus.received[0].id })).value.content, localCopy.content);
    assert.ok(![...backing.files.values()].some(file => file.text.includes(localCopy.content)));
    const wireState = JSON.stringify(hostedStatus); assert.ok(!wireState.includes('signingPrivateKey') && !wireState.includes('secretKey'));
    assert.equal((await http('owner/share', { peerId: localStatus.profile!.id, ids: ['chosen'] })).response.status, 200);
    assert.equal(sourceReads, 1);
    const localReceived = (await local.status()).received;
    assert.equal(localReceived.length, 1); assert.deepEqual(await local.received(localReceived[0].id), selected);
    await cache.get('u-owner')!.setEnabled(false); cache.clear();
    const restarted = await http('owner/status'); hostedStatus = restarted.value.status as typeof hostedStatus;
    assert.equal(hostedStatus.enabled, false); assert.equal(hostedStatus.received.length, 1);
    assert.equal(hostedStatus.profile!.id, hostedId);
    assert.equal((await http('owner/received', { id: hostedStatus.received[0].id })).value.content, localCopy.content);
    await assert.rejects(local.share(hostedId, [localCopy]));
    assert.equal((await http('owner/enable', { enabled: true })).response.status, 200);
    const secondReplica = new FederationService({ store: encryptedFederationStore({ podUrl: owner.podUrl, fetch: backing.fetch, encryptionKey: key }),
      binding: async () => owner.podUrl, allowLoopbackForTests: true, refreshState: true });
    await secondReplica.setEnabled(true);
    await secondReplica.revoke(localStatus.profile!.id);
    // The first hosted instance held an approved cached profile. A revocation committed
    // through another instance must prevent a new outbound send before transmission.
    await assert.rejects(cache.get('u-owner')!.share(localStatus.profile!.id, [selected]));
    assert.equal((await local.status()).received.length, 1);
    await assert.rejects(local.share(hostedId, [localCopy]));
    assert.equal((await http('owner/share', { peerId: localStatus.profile!.id, ids: ['chosen'] })).response.status, 400);
    assert.equal((await http('owner/enable', { enabled: false })).response.status, 200);
    assert.equal((await http('owner/remove-received', { id: hostedStatus.received[0].id })).response.status, 200);
    assert.equal((await http('owner/received', { id: hostedStatus.received[0].id })).response.status, 400);
    assert.equal((await http('owner/clear-sent-history', {})).response.status, 200);
    assert.equal(((await http('owner/status')).value.status as typeof hostedStatus).peers.length, 1);
    await secondReplica.setEnabled(false);
    assert.equal((await http('owner/forget', {})).response.status, 200);
    hostedStatus = (await http('owner/status')).value.status as typeof hostedStatus;
    assert.equal(hostedStatus.configured, false); assert.equal(hostedStatus.enabled, false);
    assert.ok(publicCreates.includes(false));
  } finally { await local.setEnabled(false); for (const service of cache.values()) await service.setEnabled(false); await close(localServer); await close(hostedServer); }
});

test('hosted owner page binds OAuth callback to the same tab and exchanges PKCE once', async () => {
  const page = hostedFederationPage();
  assert.ok(page.html.includes('script nonce="' + page.nonce + '"'));
  assert.notEqual(hostedFederationPage().nonce, page.nonce);
  const flowKey = 'interego-federation-owner-pkce', tokenKey = 'interego-federation-owner-token';
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  for (const matching of [false, true]) {
    const calls: { url: string; body: string }[] = [];
    const console = new VirtualConsole(); const failures: unknown[] = []; console.on('jsdomError', error => failures.push(error));
    const dom = new JSDOM(page.html, { url: 'https://relay.example/pod-federation?code=one-use-code&state=' + (matching ? 'expected' : 'attacker'), runScripts: 'dangerously', virtualConsole: console,
      beforeParse(window) {
        window.sessionStorage.setItem(flowKey, JSON.stringify({ state: 'expected', verifier: 'same-tab-proof', clientId: 'public-client' }));
        Object.defineProperty(window, 'crypto', { value: webcrypto });
        window.fetch = (async (url: string, init: RequestInit = {}) => {
          calls.push({ url, body: String(init.body ?? '') });
          if (url === '/token') return new Response(JSON.stringify({ access_token: 'scoped-owner-grant' }), { headers: { 'content-type': 'application/json' } });
          return new Response(JSON.stringify({ owner: { principal: 'did:key:owner' }, status: { enabled: false, configured: false, pending: [], joining: [], peers: [], received: [] } }), { headers: { 'content-type': 'application/json' } });
        }) as typeof window.fetch;
      } });
    await tick(); await tick();
    assert.deepEqual(failures, []);
    assert.equal(dom.window.location.search, ''); assert.equal(dom.window.sessionStorage.getItem(flowKey), null);
    if (!matching) { assert.equal(calls.length, 0); assert.equal(dom.window.sessionStorage.getItem(tokenKey), null); assert.match(dom.window.document.getElementById('message')!.textContent!, /another page|expired/); }
    else { assert.equal(calls.filter(call => call.url === '/token').length, 1); assert.equal(new URLSearchParams(calls[0].body).get('code_verifier'), 'same-tab-proof'); assert.equal(dom.window.sessionStorage.getItem(tokenKey), 'scoped-owner-grant'); assert.equal(dom.window.document.getElementById('panel')!.hidden, false); }
    dom.window.close();
  }
});
