import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNativeIdentity, NATIVE_HOST } from '../src/native-identity.mjs';
import { dashboardSender, validatedLinkedResult } from '../src/native-linking.mjs';

const provider = 'https://identity.example'; const relay = 'https://relay.example';
const runtime = { id: 'wallet', getURL: path => 'chrome-extension://wallet/' + path };
const app = { id: runtime.id, url: runtime.getURL('app.html') };
const sender = { id: runtime.id, frameId: 0, tab: { id: 19 }, url: provider + '/dashboard?token=DO_NOT_READ_OR_FORWARD' };
const cap = 'interego-link:v1:' + 'i'.repeat(43) + '.' + 's'.repeat(43);
const ticket = () => ({ id: 'd0e274c1-635c-4099-9027-72a5e7bdb7c4', receipt: 'r'.repeat(43), verificationCode: 'ABCD 1234', expiresAt: new Date(Date.now() + 60_000).toISOString() });
const linked = () => ({ state: 'linked', identityOrigin: provider, credentialDid: 'did:key:z6Mk' + 'a'.repeat(44), owner: {
  userId: 'u-pk-owner', did: 'did:web:identity.example:users:u-pk-owner', webId: provider + '/users/u-pk-owner/profile#me', podUrl: 'https://pod.example/u-pk-owner/', displayName: 'Existing account' } });
function event() { const listeners = []; return { addListener: f => listeners.push(f), emit: (...args) => listeners.forEach(f => f(...args)) }; }
function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(options = {}) {
  let saved = { nativeIdentityRelays: [relay], ...(options.enabled === false ? {} : { nativeIdentityProviders: [provider] }) };
  const permissions = new Set([provider, relay]); const registered = new Map(); const messages = []; const calls = []; const scripts = []; const done = deferred(); let opens = 0; let disconnected = 0;
  const native = { onMessage: event(), onDisconnect: event(), disconnect: () => { disconnected++; }, postMessage: request => {
    calls.push(request);
    const value = request.operation === 'start' ? options.ticket?.() ?? ticket() : options.result?.() ?? linked();
    queueMicrotask(() => native.onMessage.emit({ version: 1, id: request.id, ok: true, value }));
  } };
  const chrome = { runtime: { ...runtime, connectNative: host => { assert.equal(host, NATIVE_HOST); opens++; return native; } },
    storage: { local: { get: async () => structuredClone(saved), set: async values => { saved = { ...saved, ...structuredClone(values) }; } } },
    permissions: { contains: async query => query.origins.every(origin => permissions.has(origin.slice(0, -2))), request: () => { throw new Error('Worker must never request browser access.'); }, onRemoved: event() },
    scripting: { getRegisteredContentScripts: async ({ ids }) => ids.filter(id => registered.has(id)).map(id => registered.get(id)),
      unregisterContentScripts: async ({ ids }) => ids.forEach(id => registered.delete(id)),
      registerContentScripts: async values => { scripts.push(...values); for (const value of values) registered.set(value.id, value); } } };
  const page = { name: 'interego-local-identity', sender: options.sender ?? sender, onMessage: event(), onDisconnect: event(), postMessage: value => { messages.push(value); if (value.state !== 'waiting') done.resolve(); } };
  const broker = createNativeIdentity({ chrome, randomUUID, delay: options.delay ?? (async () => {}) });
  return { chrome, page, native, broker, permissions, registered, scripts, messages, calls, done: done.promise, opens: () => opens, disconnected: () => disconnected, saved: () => saved,
    start: (message = { type: 'start', handoffCode: cap }) => { broker.handlePort(page); page.onMessage.emit(message); } };
}

test('dashboard linking is independently off until opted in; URL query credentials are discarded', async () => {
  const f = fixture({ enabled: false }); assert.deepEqual(await f.broker.dispatch({ type: 'NATIVE_STATE' }, app), { relays: [relay], providers: [] });
  f.start(); await f.done; assert.equal(f.opens(), 0); assert.equal(f.messages[0].state, 'failed');
  const u = dashboardSender(sender, runtime, [provider]); assert.equal(u.href, provider + '/dashboard'); assert.equal(u.search, '');
});
test('exact provider dashboard, extension, permission and top frame are required before native launch', async () => {
  for (const patch of [{ id: 'other' }, { frameId: 1 }, { tab: undefined }, { url: provider + '/dashboard/' }, { url: provider + '/dashboard-other' }, { url: provider + '/authorize' }, { url: 'https://evil.example/dashboard' }, { url: provider + '/dashboard#secret' }]) {
    const f = fixture({ sender: { ...sender, ...patch } }); f.start(); await f.done; assert.equal(f.opens(), 0); assert.equal(f.messages[0].state, 'failed');
  }
  const f = fixture(); f.permissions.delete(provider); f.start(); await f.done; assert.equal(f.opens(), 0);
});
test('linking accepts only its exact public canonical receipt, including internal HTTP pod metadata', () => {
  assert.deepEqual(validatedLinkedResult(linked(), provider), linked());
  const internal = linked(); internal.owner.podUrl = 'http://css.railway.internal:3456/base/u-pk-owner/'; assert.deepEqual(validatedLinkedResult(internal, provider), internal);
  for (const change of [v => { v.identityOrigin = 'https://other.example'; }, v => { v.owner.did = 'did:key:chosen-owner'; }, v => { v.owner.webId = provider + '/users/stranger/profile#me'; },
    v => { v.owner.userId = '../owner'; }, v => { v.owner.podUrl = 'https://pod.example/stranger/'; }, v => { v.owner.podUrl += '?token=secret'; }, v => { v.owner.podUrl = 'https://name:secret@pod.example/u-pk-owner/'; },
    v => { v.owner.podUrl = 'file:///u-pk-owner/'; }, v => { v.owner.displayName = 'line\nbreak'; }, v => { v.credentialDid = 'did:web:chosen.example'; },
    v => { v.owner.token = 'private'; }, v => { v.signature = 'private'; }, v => { v.redirect = 'https://evil.example'; }, v => { v.linked = true; }]) {
    const value = linked(); change(value); assert.throws(() => validatedLinkedResult(value, provider));
  }
});
test('native linking sends no dashboard bearer or account claim and returns only sanitized public owner data', async () => {
  const f = fixture(); f.start(); await f.done;
  assert.deepEqual(f.messages.map(value => value.state), ['waiting', 'linked']); assert.equal(f.calls[0].relayOrigin, provider); assert.equal(f.calls[0].handoffCode, cap);
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['handoffCode', 'id', 'operation', 'relayOrigin', 'version']);
  for (const secret of ['DO_NOT_READ_OR_FORWARD', 'rrrrrrrr', 'signature', 'completionCode', 'privateKey', 'access_token']) assert.ok(!JSON.stringify(f.messages).includes(secret));
  assert.ok(!JSON.stringify(f.calls).includes('DO_NOT_READ_OR_FORWARD')); assert.equal(f.disconnected(), 1);
  f.page.onMessage.emit({ type: 'start', handoffCode: cap }); await flush(); assert.equal(f.calls.filter(value => value.operation === 'start').length, 1);
});
test('page-selected owners, proof fields and cross-purpose handoffs are refused', async () => {
  for (const extra of [{ owner: linked().owner }, { did: linked().credentialDid }, { token: 'not-authority' }]) {
    const f = fixture(); f.start({ type: 'start', handoffCode: cap, ...extra }); await f.done; assert.equal(f.opens(), 0);
  }
  const f = fixture(); f.start({ type: 'start', handoffCode: cap.replace('interego-link:', 'interego-login:') }); await f.done; assert.equal(f.opens(), 0);
  const wrongTerminal = fixture({ result: () => ({ state: 'complete', redirect: provider + '/dashboard?token=secret' }) }); wrongTerminal.start(); await wrongTerminal.done;
  assert.equal(wrongTerminal.messages.at(-1).state, 'failed'); assert.ok(!JSON.stringify(wrongTerminal.messages).includes('token=secret'));
});
test('malformed native receipt capabilities are rejected without exposing raw fields', async () => {
  for (const change of [v => { v.receipt = 'short'; }, v => { v.id = 'chosen'; }, v => { v.expiresAt = new Date(Date.now() + 900_000).toISOString(); }, v => { v.signature = 'never-display'; }]) {
    const f = fixture({ ticket: () => { const value = ticket(); change(value); return value; } }); f.start(); await f.done;
    assert.deepEqual(f.messages.map(value => value.state), ['failed']); assert.ok(!JSON.stringify(f.messages).includes('never-display'));
  }
});
test('provider opt-in uses its own isolated script and does not change relay sign-in or request permissions automatically', async () => {
  const f = fixture({ enabled: false }); await assert.rejects(f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers: [provider] }, sender));
  await f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers: [provider] }, app);
  assert.deepEqual(f.scripts[0], { id: 'interego-native-identity-link', matches: [provider + '/dashboard*'], js: ['src/native-identity-link-content.js'], runAt: 'document_idle', allFrames: false, world: 'ISOLATED', persistAcrossSessions: true });
  assert.deepEqual(f.saved().nativeIdentityRelays, [relay]);
  await f.broker.dispatch({ type: 'NATIVE_CONFIGURE', relays: [relay] }, app); assert.deepEqual(f.saved().nativeIdentityProviders, [provider]); assert.equal(f.registered.size, 2);
  await f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers: [] }, app); assert.deepEqual(f.saved().nativeIdentityProviders, []); assert.deepEqual(f.saved().nativeIdentityRelays, [relay]);
  assert.equal(f.registered.has('interego-native-identity-link'), false); assert.equal(f.registered.has('interego-native-identity'), true);
});
test('more than four providers, malformed origins and missing host permission never enable linking', async () => {
  const f = fixture({ enabled: false });
  for (const providers of [[provider + '/dashboard'], ['http://identity.example'], Array.from({ length: 5 }, (_, i) => `https://id${i}.example`)] ) await assert.rejects(f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers }, app));
  f.permissions.delete(provider); await assert.rejects(f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers: [provider] }, app)); assert.deepEqual(f.saved().nativeIdentityProviders, []);
});
test('permission removal or either policy change cancels the native channel and cannot return a late link result', async () => {
  for (const policy of ['permission', 'linking', 'signin']) {
    const waiting = deferred(); const f = fixture({ delay: () => waiting.promise }); f.start(); await flush(); assert.equal(f.messages[0].state, 'waiting');
    if (policy === 'permission') f.chrome.permissions.onRemoved.emit({ origins: [provider + '/*'] });
    else await f.broker.dispatch(policy === 'linking' ? { type: 'NATIVE_CONFIGURE_LINKING', providers: [] } : { type: 'NATIVE_CONFIGURE', relays: [] }, app);
    await f.done; waiting.resolve(); await flush(); assert.equal(f.disconnected(), 1); assert.equal(f.messages.at(-1).state, 'failed'); assert.equal(f.calls.length, 1);
  }
});
test('serialized settings keep a newer failed linking change denied instead of restoring an older successful provider list', async () => {
  const f = fixture({ enabled: false }); const first = deferred(); const other = 'https://other.example'; f.permissions.add(other); let registrations = 0;
  f.chrome.scripting.registerContentScripts = async () => { registrations++; if (registrations === 1) await first.promise; else throw new Error('Script registration failed'); };
  const a = f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers: [provider] }, app); const b = f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers: [other] }, app); const failed = assert.rejects(b);
  await flush(); assert.equal(registrations, 1); first.resolve(); await a; await failed; assert.deepEqual(f.saved().nativeIdentityProviders, []);
  f.start(); await f.done; assert.equal(f.opens(), 0);
});
test('failed persistent denial still blocks linking in memory until a successful owner settings action', async () => {
  const f = fixture(); f.chrome.storage.local.set = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(f.broker.dispatch({ type: 'NATIVE_CONFIGURE_LINKING', providers: [] }, app)); assert.deepEqual(f.saved().nativeIdentityProviders, [provider]);
  f.start(); await f.done; assert.equal(f.opens(), 0); assert.equal(f.messages[0].state, 'failed');
});

async function contentFixture({ prepared = false, pathname = '/dashboard' } = {}) {
  const listener = {}; let observed; const posted = []; let opened = 0; let reloads = 0; let disconnected = 0;
  const node = () => ({ textContent: '', dataset: {}, children: [], listeners: {}, append(child) { this.children.push(child); }, addEventListener(name, handler) { this.listeners[name] = handler; } });
  const button = node(); button.disabled = true; button.dataset = prepared ? { handoffCode: cap, expiresAt: new Date(Date.now() + 60_000).toISOString() } : {};
  const status = node(); const port = { onMessage: event(), onDisconnect: event(), disconnect: () => { disconnected++; port.onDisconnect.emit(); }, postMessage: value => posted.push(value) };
  const window = { addEventListener: (name, handler) => { listener[name] = handler; } }; window.top = window;
  const location = { protocol: 'https:', pathname, reload: () => { reloads++; }, assign: () => { throw new Error('Linking must not navigate to a returned URL'); } };
  Object.defineProperty(location, 'search', { get() { throw new Error('Dashboard bearer query must never be read'); } });
  vm.runInNewContext(await readFile(new URL('../src/native-identity-link-content.js', import.meta.url), 'utf8'), { window, location, document: {
    documentElement: {}, getElementById: id => id === 'interego-local-identity-link' ? button : status, createElement: () => node(),
  }, chrome: { runtime: { connect: () => { opened++; return port; } } }, MutationObserver: class { constructor(callback) { observed = callback; } observe() {} disconnect() {} }, Date, WeakSet, Set });
  return { button, status, port, posted, location, opened: () => opened, reloads: () => reloads, disconnected: () => disconnected,
    prepare: (code = cap) => { button.dataset = { handoffCode: code, expiresAt: new Date(Date.now() + 60_000).toISOString() }; observed?.(); }, mutate: () => observed?.(), hide: () => listener.pagehide?.(),
    click: (trusted = true) => button.listeners.click?.({ isTrusted: trusted, preventDefault() {} }) };
}
test('dashboard script waits for fresh-auth markup, requires a trusted click and never reuses a consumed ceremony', async () => {
  const f = await contentFixture(); assert.equal(f.button.disabled, true); f.prepare(); assert.equal(f.button.disabled, false);
  f.click(false); assert.equal(f.opened(), 0); f.click(); assert.equal(f.opened(), 1); assert.deepEqual(JSON.parse(JSON.stringify(f.posted)), [{ type: 'start', handoffCode: cap }]);
  f.port.onMessage.emit({ state: 'failed', message: 'Authenticate again.' }); f.mutate(); f.click(); assert.equal(f.opened(), 1); assert.equal(f.button.disabled, true); assert.equal(f.status.dataset.nativeState, 'failed');
});
test('dashboard completion displays public identity as text and refreshes only the same dashboard on deliberate click', async () => {
  const f = await contentFixture({ prepared: true }); f.click(); const value = linked(); value.owner.displayName = '<img src=x onerror=steal()>'; f.port.onMessage.emit(value);
  assert.ok(f.status.textContent.includes(value.owner.displayName)); assert.ok(f.status.textContent.includes(value.owner.did)); assert.equal(f.status.children.length, 1); assert.equal(f.status.dataset.nativeState, 'linked');
  const refresh = f.status.children[0]; refresh.listeners.click({ isTrusted: false }); assert.equal(f.reloads(), 0); refresh.listeners.click({ isTrusted: true }); assert.equal(f.reloads(), 1);
});
test('dashboard path changes and newly prepared ceremonies close older native channels', async () => {
  const f = await contentFixture({ prepared: true }); f.click(); f.prepare(cap.replace(/s/g, 't')); assert.equal(f.disconnected(), 1); assert.equal(f.button.disabled, false);
  const wrongPath = await contentFixture({ prepared: true, pathname: '/dashboard-other' }); wrongPath.click(); assert.equal(wrongPath.opened(), 0);
  const moved = await contentFixture({ prepared: true }); moved.click(); moved.location.pathname = '/other'; moved.port.onMessage.emit(linked()); assert.equal(moved.disconnected(), 1); assert.equal(moved.status.children.length, 0);
});
