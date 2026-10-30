/** Real Chromium/MV3 integration smoke test with an entirely offline relay.
 * Only the OAuth consent dialog, optional-permission dialog and fetch boundary
 * are fixture replacements. Worker modules, storage, messages and DOM are real.
 * No personal browser profile or live account is used.
 */
/* global chrome -- Available only inside callbacks evaluated in the extension's Chromium contexts. */
/* eslint-disable no-console -- This CLI test runner reports startup progress and final verification results. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = process.env.PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href)
  : await import('playwright');
const profileParent = resolve(extension, '../../../browser-wallet-smoke');
await mkdir(profileParent, { recursive: true });
const profile = await mkdtemp(join(profileParent, 'profile-'));
let context;
const checks = [];
try {
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_scripts, undefined);
  checks.push('MV3 and no website bridge or persistent content scripts');
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  console.log('Chromium started; waiting for MV3 worker.');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  console.log('MV3 worker registered.');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    globalThis.__walletFixture = { writes: [], calls: [], scope: 'mcp:read', agent: 'browser-fixture', hasPermission: true, failReadback: false };
    chrome.permissions.request = async () => true;
    chrome.permissions.contains = async () => globalThis.__walletFixture.hasPermission;
    chrome.identity.launchWebAuthFlow = async details => {
      const authorize = new URL(typeof details === 'string' ? details : details.url);
      globalThis.__walletFixture.scope = authorize.searchParams.get('scope');
      const callback = new URL(authorize.searchParams.get('redirect_uri'));
      callback.searchParams.set('state', authorize.searchParams.get('state'));
      callback.searchParams.set('code', 'offline-fixture-code');
      return callback.href;
    };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const fixture = globalThis.__walletFixture;
      const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.origin !== 'https://relay.interego.xwisee.com') throw new Error('Fixture refused an unexpected origin');
      if (init.credentials !== 'omit' || init.redirect !== 'error') throw new Error('Request did not use the guarded network boundary');
      if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: url.origin + '/', authorization_endpoint: url.origin + '/authorize', token_endpoint: url.origin + '/token', registration_endpoint: url.origin + '/register', code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp:read', 'mcp:write', 'mcp'] });
      if (url.pathname === '/register') {
        const body = JSON.parse(init.body);
        if (body.token_endpoint_auth_method !== 'none' || body.client_secret) throw new Error('Unexpected OAuth client secret');
        return json({ client_id: 'offline-fixture-client', token_endpoint_auth_method: 'none', redirect_uris: body.redirect_uris });
      }
      if (url.pathname === '/token') {
        const body = new URLSearchParams(init.body);
        if (!body.get('code_verifier') || body.get('client_secret')) throw new Error('PKCE missing or shared secret present');
        return json({ access_token: 'offline-fixture-access-token', token_type: 'Bearer', expires_in: 3600, scope: fixture.scope });
      }
      const schemas = {
        get_pod_status: { type: 'object', properties: {} },
        discover_context: { type: 'object', properties: { pod_url: { type: 'string' }, pod_name: { type: 'string' }, limit: { type: 'integer' }, sort: { type: 'string' }, verify_delegation: { type: 'boolean' } } },
        get_descriptor: { type: 'object', properties: { url: { type: 'string' }, bypass_cache: { type: 'boolean' } }, required: ['url'] },
        remember: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, visibility: { type: 'string', enum: ['private', 'shared', 'public'] } }, required: ['body'] },
      };
      if (url.pathname === '/tools') return json({ 'hydra:member': Object.entries(schemas).map(([name, inputSchema]) => ({ name, inputSchema, affordances: [{ action: 'urn:iep:action:invoke:' + name, target: url.origin + '/tool/' + name, method: 'POST' }] })) });
      const name = url.pathname.slice('/tool/'.length);
      const args = JSON.parse(init.body || '{}');
      fixture.calls.push({ name, args });
      if (init.headers.Authorization !== 'Bearer offline-fixture-access-token') throw new Error('Token was absent');
      if (name === 'get_pod_status') return json({ pod: 'http://css.railway.internal:3456/offline-fixture/', displayName: '<img src=x onerror=alert(1)>Fixture person', webId: 'https://identity.example/profile#me', sessionAgent: { id: fixture.agent, did: 'did:web:identity.example:agents:' + fixture.agent }, descriptors: 1 });
      if (name === 'discover_context') return json({ pod: 'http://css.railway.internal:3456/offline-fixture/', entries: [{ descriptorUrl: 'http://css.railway.internal:3456/offline-fixture/context/existing.ttl', describes: ['urn:graph:fixture:existing'], validFrom: '2026-10-29T12:00:00Z', trustLevel: 'SelfAsserted' }] });
      if (name === 'remember') {
        if (fixture.scope === 'mcp:read') return json({ error: 'read-only token' });
        if (args.visibility !== 'private') throw new Error('The wallet tried a nonprivate write');
        fixture.writes.push(args);
        return json({ remembered: true, visibility: 'private', encrypted: true, memory: 'urn:graph:fixture:memory', descriptorUrl: 'http://css.railway.internal:3456/offline-fixture/context/saved.ttl', view: { url: 'https://relay.interego.xwisee.com/view/offline-fixture/saved' } });
      }
      if (name === 'get_descriptor') {
        if (fixture.failReadback) return json({ error: 'fixture unreadable' });
        const body = fixture.writes.at(-1)?.body || 'Previously saved fixture context';
        return json({ url: args.url, turtle: '<urn:descriptor:fixture> a <urn:Descriptor> .', graph: { content: '@prefix schema: <https://schema.org/> .\n<urn:graph:fixture:memory> schema:text ' + JSON.stringify(body) + ' .', encrypted: true, mediaType: 'text/turtle' }, authorship: { authorshipVerified: true, contentBinding: 'bound', signatureAuthority: 'relay' } });
      }
      throw new Error('Fixture refused unknown tool: ' + name);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await page.evaluate(() => { chrome.permissions.request = async () => true; });
  const send = async message => page.evaluate(async message => {
    const state = await chrome.runtime.sendMessage({ type: 'STATE' });
    return chrome.runtime.sendMessage({ expectedAccountId: state.value.activeId, ...message });
  }, message);
  await page.locator('#relay').fill('https://relay.interego.xwisee.com');
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#identity').textContent.includes('browser-fixture'));
  assert.equal(await worker.evaluate(() => globalThis.__walletFixture.scope), 'mcp:read');
  assert.equal(await page.locator('#identity img').count(), 0);
  assert.match(await page.locator('#contexts').textContent(), /fixture:existing/);
  const state = await send({ type: 'STATE' });
  assert.equal(state.ok, true);
  assert.equal(JSON.stringify(state).includes('offline-fixture-access-token'), false);
  checks.push('OAuth PKCE/read-only connect, authenticated identity, bounded context list, text-only external rendering');
  const beforePermissionRemoval = await worker.evaluate(() => {
    globalThis.__walletFixture.hasPermission = false;
    return globalThis.__walletFixture.calls.length;
  });
  assert.equal((await send({ type: 'REFRESH' })).ok, false);
  assert.equal(await worker.evaluate(() => globalThis.__walletFixture.calls.length), beforePermissionRemoval);
  await worker.evaluate(() => { globalThis.__walletFixture.hasPermission = true; });
  checks.push('Revoked relay host permission blocks requests before network access');

  const writeConnect = await send({ type: 'CONNECT', relay: 'https://relay.interego.xwisee.com', scope: 'mcp:write' });
  assert.equal(writeConnect.ok, true, JSON.stringify(writeConnect));
  await worker.evaluate(async () => await chrome.storage.session.set({ draft: { title: 'Toolbar selection fixture', url: 'https://example.org/article', text: 'A selected passage', purpose: '' } }));
  await page.reload();
  assert.equal(await page.locator('#capture-title').inputValue(), 'Toolbar selection fixture');
  assert.equal(await page.locator('#capture-text').inputValue(), 'A selected passage');
  await page.locator('#capture-title').fill('Fixture capture');
  await page.locator('#capture-url').fill('https://example.org/article?privateQuery=remove-me#private-fragment');
  await page.locator('#capture-text').fill('Selected text with "quotes".\nSecond line <script>window.fixtureXss=true</script>.');
  await page.locator('#purpose').fill('Offline integration verification');
  await page.locator('#prepare').click();
  await page.locator('#confirm-save').waitFor({ state: 'visible' });
  const review = await page.locator('#review').textContent();
  assert.match(review, /Offline integration verification/);
  assert.match(review, /Selected text with/);
  assert.equal(await worker.evaluate(() => globalThis.__walletFixture.writes.length), 0);
  await page.locator('#confirm-save').click();
  await page.waitForFunction(() => document.querySelector('#receipts').textContent.includes('Fixture capture'));
  assert.equal(await worker.evaluate(() => globalThis.__walletFixture.writes.length), 1);
  const written = await worker.evaluate(() => globalThis.__walletFixture.writes[0]);
  assert.equal(written.body.includes('privateQuery'), false);
  assert.equal(written.body.includes('private-fragment'), false);
  assert.equal(await page.evaluate(() => globalThis.fixtureXss), undefined);
  assert.equal(await page.locator('#review script').count(), 0);
  const storage = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  assert.equal(JSON.stringify(storage.local).includes('offline-fixture-access-token'), false);
  assert.equal(JSON.stringify(storage.local).includes('Selected text with'), false);
  checks.push('Capture review precedes a single private save; descriptor readback; no token or selected text in durable storage');

  const reviewAgain = await send({ type: 'PREPARE', title: 'Cancelled fixture', url: '', text: 'Do not send this.', purpose: 'Test cancellation' });
  assert.equal(reviewAgain.ok, true);
  assert.equal((await send({ type: 'CANCEL' })).ok, true);
  assert.equal((await send({ type: 'SAVE', reviewId: reviewAgain.value.id })).ok, false);
  assert.equal(await worker.evaluate(() => globalThis.__walletFixture.writes.length), 1);
  checks.push('Cancelled review cannot be submitted or cause a duplicate write');

  const other = await context.newPage();
  await other.goto(`chrome-extension://${extensionId}/manifest.json`);
  const forbidden = await other.evaluate(() => chrome.runtime.sendMessage({ type: 'STATE' }));
  assert.equal(forbidden.ok, false);
  await other.close();
  checks.push('Untrusted extension document sender refused');
  if (process.env.WALLET_SCREENSHOT) await page.screenshot({ path: process.env.WALLET_SCREENSHOT, fullPage: true });

  const oldAccountId = (await send({ type: 'STATE' })).value.activeId;
  await worker.evaluate(() => { globalThis.__walletFixture.agent = 'second-browser-fixture'; });
  const otherWallet = await context.newPage();
  await otherWallet.goto(`chrome-extension://${extensionId}/app.html`);
  const otherConnection = await otherWallet.evaluate(() => chrome.runtime.sendMessage({ type: 'CONNECT', relay: 'https://relay.interego.xwisee.com', scope: 'mcp:write' }));
  assert.equal(otherConnection.ok, true, JSON.stringify(otherConnection));
  assert.notEqual(otherConnection.value.activeId, oldAccountId);
  const stale = await send({ type: 'REFRESH', expectedAccountId: oldAccountId });
  assert.equal(stale.ok, false);
  const beforeStaleClick = await worker.evaluate(() => globalThis.__walletFixture.calls.length);
  await page.locator('#refresh').click();
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('error'));
  assert.equal(await worker.evaluate(() => globalThis.__walletFixture.calls.length), beforeStaleClick);
  assert.equal((await send({ type: 'DISCONNECT', expectedAccountId: oldAccountId })).ok, false);
  checks.push('A second window changing identity makes the first window refuse stale reads and disconnects before network access');
  await otherWallet.close();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#identity').textContent.includes('second-browser-fixture'));
  await page.locator('#disconnect').click();
  await page.waitForFunction(() => !document.querySelector('#identity').textContent.includes('second-browser-fixture'));
  await worker.evaluate(() => { globalThis.__walletFixture.agent = 'browser-fixture'; });
  await page.locator('#disconnect').click();
  await page.waitForFunction(() => !document.querySelector('#identity').textContent.includes('browser-fixture'));
  const disconnected = await worker.evaluate(async () => await chrome.storage.session.get(null));
  assert.equal(JSON.stringify(disconnected).includes('offline-fixture-access-token'), false);
  await worker.evaluate(() => {
    const hostedFetch = globalThis.fetch;
    globalThis.__walletLocalFixture = { writes: [], refreshes: 0, tokenNumber: 0,
      grant: '93e18d44-e583-4776-9f49-52a266130e18',
      notes: [{ id: 'b3bc41b0-6680-417c-8bb2-457ba1c1045c', title: 'My installed pod', body: 'This local note belongs to the fixture.', createdAt: '2026-10-30T01:00:00Z', updatedAt: '2026-10-30T01:00:00Z' }] };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.origin !== 'https://local-pod.example') return hostedFetch(input, init);
      const f = globalThis.__walletLocalFixture;
      const json = value => Response.json(value);
      if (init.credentials !== 'omit' || init.redirect !== 'error') throw new Error('Local request escaped its guarded network boundary');
      if (url.pathname === '/.well-known/oauth-authorization-server') return json({ issuer: url.origin, authorization_endpoint: url.origin + '/authorize', token_endpoint: url.origin + '/token', registration_endpoint: url.origin + '/register', code_challenge_methods_supported: ['S256'], scopes_supported: ['notes:read', 'notes:create'], token_endpoint_auth_methods_supported: ['none'] });
      if (url.pathname === '/register') return json({ client_id: 'local-client', token_endpoint_auth_method: 'none' });
      if (url.pathname === '/token') {
        const form = new URLSearchParams(init.body);
        if (form.get('grant_type') === 'refresh_token') f.refreshes++;
        f.tokenNumber++;
        return json({ access_token: 'local-access-' + f.tokenNumber, refresh_token: String.fromCharCode(97 + f.tokenNumber).repeat(43), expires_in: 300, token_type: 'Bearer', scope: 'notes:read notes:create' });
      }
      if (url.pathname === '/revoke') { f.revoked = true; return json({}); }
      if (url.pathname !== '/mcp' || init.headers.Authorization !== 'Bearer local-access-' + f.tokenNumber) throw new Error('Local MCP authority missing');
      const message = JSON.parse(init.body);
      let result;
      if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'interego-local-pod-bridge' } };
      else if (message.method === 'tools/list') result = { tools: [
        { name: 'interego_status', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'interego_search_notes', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false } },
        { name: 'interego_read_note', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
        { name: 'interego_save_note', inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 160 }, body: { type: 'string', maxLength: 50_000 } }, required: ['title', 'body'], additionalProperties: false } },
      ] };
      else if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params;
        let value;
        if (name === 'interego_status') value = { storageLocal: true, remoteBridge: true, running: true, connection: { id: f.grant, name: 'My browser', state: 'active', permissions: ['notes:read', 'notes:create'] } };
        else if (name === 'interego_search_notes') value = { notes: f.notes.map(note => ({ ...note, body: undefined, excerpt: note.body.slice(0, 240) })) };
        else if (name === 'interego_read_note') value = { note: f.notes.find(note => note.id === args.id) };
        else if (name === 'interego_save_note') {
          f.writes.push(args);
          const note = { ...args, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          f.notes.push(note); value = { note };
        } else throw new Error('Unadmitted local tool');
        result = { structuredContent: value };
      } else throw new Error('Unadmitted local MCP method');
      return json({ jsonrpc: '2.0', id: message.id, result });
    };
  });
  await page.locator('#connection-mode').selectOption('local');
  // The previous page reload intentionally destroyed this page-level permission
  // fixture. Reinstall it before requesting a second, distinct provider origin.
  await page.evaluate(() => { chrome.permissions.request = async () => true; });
  assert.equal(await page.locator('#local-setup').isVisible(), true);
  assert.equal(await page.locator('#extension-id').textContent(), extensionId);
  await page.locator('#copy-extension-id').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Extension ID copied.'));
  await page.locator('#relay').fill('https://local-pod.example/mcp');
  await page.locator('#scope').selectOption('mcp:write');
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.querySelector('#identity').textContent.includes('Approved local note connection') || document.querySelector('#status').classList.contains('error'));
  assert.equal(await page.locator('#status').evaluate(node => node.classList.contains('error')), false, await page.locator('#status').textContent());
  assert.equal(await worker.evaluate(() => globalThis.__walletFixture.scope), 'notes:read notes:create');
  assert.match(await page.locator('#contexts').textContent(), /My installed pod/);
  await page.locator('#contexts button').first().click();
  assert.match(await page.locator('#descriptor-body').textContent(), /local note belongs/);
  assert.match(await page.locator('#proof').textContent(), /does not return a signed descriptor/);
  await page.locator('#capture-title').fill('A browser note saved locally');
  await page.locator('#capture-text').fill('Private selected text for the installed pod.');
  await page.locator('#purpose').fill('Local pod integration');
  await page.locator('#prepare').click();
  await page.locator('#confirm-save').waitFor({ state: 'visible' });
  assert.match(await page.locator('#review-destination').textContent(), /Private · your local pod/);
  assert.equal(await worker.evaluate(() => globalThis.__walletLocalFixture.writes.length), 0);
  await worker.evaluate(async () => {
    const local = await chrome.storage.local.get('activeId');
    const { sessions } = await chrome.storage.session.get('sessions');
    sessions[local.activeId].expiresAt = Date.now() + 500;
    await chrome.storage.session.set({ sessions });
  });
  await page.locator('#confirm-save').click();
  await page.waitForFunction(() => document.querySelector('#receipts').textContent.includes('A browser note saved locally'));
  assert.equal(await worker.evaluate(() => globalThis.__walletLocalFixture.writes.length), 1);
  assert.equal(await worker.evaluate(() => globalThis.__walletLocalFixture.refreshes), 1);
  assert.equal(JSON.stringify(await send({ type: 'STATE' })).includes('local-access-'), false);
  const localStorage = await worker.evaluate(async () => chrome.storage.local.get(null));
  assert.equal(JSON.stringify(localStorage).includes('Private selected text'), false);
  await page.locator('#disconnect').click();
  await page.waitForFunction(() => !document.querySelector('#identity').textContent.includes('My browser'));
  assert.equal(await worker.evaluate(() => globalThis.__walletLocalFixture.revoked), true);
  assert.equal(JSON.stringify(await worker.evaluate(async () => chrome.storage.session.get(null))).includes('refreshToken'), false);
  checks.push('Local selector and actual extension ID, explicit notes-scope OAuth, canonical note read, reviewed single save, session-only refresh rotation and Disconnect');
  assert.deepEqual(errors, []);
  checks.push('Disconnect clears session token; no uncaught page errors');
  console.log(JSON.stringify({ browser: 'Chromium', version: context.browser()?.version(), fixture: 'offline; no live account', checks }, null, 2));
} finally {
  await context?.close();
  // Delete only this process's verified generated profile, never a user profile.
  if (resolve(profile).startsWith(profileParent + '\\') || resolve(profile).startsWith(profileParent + '/')) await rm(profile, { recursive: true, force: true });
}
