import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { authorizeSender, validatedRedirect, createNativeIdentity, NATIVE_HOST } from '../src/native-identity.mjs';

const relay = 'https://relay.example';
const callback = 'https://game.example/callback?mode=play';
const authorization = relay + '/authorize?' + new URLSearchParams({ client_id: 'game', redirect_uri: callback, code_challenge: 'x'.repeat(43), state: 'exact-state' });
const runtime = { id: 'extension', getURL: p => 'chrome-extension://extension/' + p };
const sender = { id: runtime.id, frameId: 0, tab: { id: 9 }, url: authorization };
const handoffCode = 'interego-login:v1:' + 'i'.repeat(43) + '.' + 's'.repeat(43);
const redirect = callback + '&code=only-oauth-code&state=exact-state';
function event() { const listeners = []; return { addListener: f => listeners.push(f), emit: (...args) => listeners.forEach(f => f(...args)) }; }
function fixture(options = {}) {
  let saved = { nativeIdentityRelays: [relay] }; let permission = true; const registrations = []; const calls = []; const messages = []; let ended;
  const done = new Promise(resolve => { ended = resolve; });
  const native = { onMessage: event(), onDisconnect: event(), disconnect: () => calls.push({ disconnected: true }), postMessage: message => {
    calls.push(message);
    if (options.silent) return;
    queueMicrotask(() => native.onMessage.emit({ version: 1, id: message.id, ok: true, value: message.operation === 'start'
      ? { id: '7c762854-5a98-4dc3-a2f9-95b0a7788c8e', receipt: 'r'.repeat(43), verificationCode: 'ABCD 1234', expiresAt: new Date(Date.now() + 30_000).toISOString() }
      : { state: 'complete', redirect } }));
  } };
  const chrome = { runtime: { ...runtime, connectNative: host => { assert.equal(host, NATIVE_HOST); return native; } },
    storage: { local: { get: async () => saved, set: async value => { saved = { ...saved, ...value }; } } },
    permissions: { contains: async () => permission, onRemoved: event() },
    scripting: { getRegisteredContentScripts: async () => [{ id: 'interego-native-identity' }], unregisterContentScripts: async value => registrations.push(value), registerContentScripts: async value => registrations.push(value) } };
  const page = { name: 'interego-local-identity', sender, onMessage: event(), onDisconnect: event(), postMessage: value => { messages.push(value); if (value.state !== 'waiting') ended(); } };
  const broker = createNativeIdentity({ chrome, randomUUID, delay: async () => {} });
  return { chrome, broker, native, page, calls, messages, registrations, done, permission: value => { permission = value; } };
}
test('only opted-in exact relay authorize top frame can open native sign-in', () => {
  assert.equal(authorizeSender(sender, runtime, [relay]).href, authorization);
  for (const patch of [{ id: 'foreign' }, { frameId: 1 }, { tab: undefined }, { url: authorization.replace('/authorize?', '/other?') }, { url: authorization.replace('relay.example', 'evil.example') }, { url: authorization + '&state=duplicate' }]) assert.throws(() => authorizeSender({ ...sender, ...patch }, runtime, [relay]));
  assert.throws(() => authorizeSender(sender, runtime, []));
});
test('callback preserves original state, destination and static query; rejects appended capabilities', () => {
  const u = new URL(authorization); assert.equal(validatedRedirect(redirect, u), redirect);
  for (const bad of [redirect.replace('game.example', 'evil.example'), redirect.replace('exact-state', 'other'), redirect + '&state=exact-state', redirect + '&token=secret', redirect.replace('mode=play', 'mode=edit'), redirect + '#code', redirect + '&iss=https://other.example']) assert.throws(() => validatedRedirect(bad, u));
});
test('native login keeps receipts and proof away from page, exposes only code and validated callback', async () => {
  const f = fixture(); f.broker.handlePort(f.page); f.page.onMessage.emit({ type: 'start', handoffCode }); await f.done;
  assert.deepEqual(f.messages.map(v => v.state), ['waiting', 'complete']);
  assert.deepEqual(f.calls.filter(v => v.operation).map(v => v.operation), ['start', 'poll']);
  assert.equal(f.calls[0].relayOrigin, relay); assert.equal(f.calls[1].receipt, 'r'.repeat(43));
  assert.ok(!JSON.stringify(f.messages).includes('rrrrrrrr')); assert.ok(!JSON.stringify(f.messages).includes('signature')); assert.equal(f.messages[1].redirect, redirect);
});

test('ordinary OAuth sign-in keeps its existing twenty-second native response limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture({ silent: true });
  f.broker.handlePort(f.page); f.page.onMessage.emit({ type: 'start', handoffCode });
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(value => value.operation).length, 1); t.mock.timers.tick(19_999);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.messages.length, 0);
  t.mock.timers.tick(1); await f.done; assert.equal(f.messages[0].state, 'failed'); assert.match(f.messages[0].message, /did not respond/i);
  assert.equal(f.calls.filter(value => value.operation).length, 1);
});
test('permission revocation and forged page sender refuse before native launch', async () => {
  for (const kind of ['permission', 'sender']) {
    const f = fixture(); if (kind === 'permission') f.permission(false); else f.page.sender = { ...sender, frameId: 1 };
    f.broker.handlePort(f.page); f.page.onMessage.emit({ type: 'start', handoffCode }); await f.done;
    assert.equal(f.messages[0].state, 'failed'); assert.equal(f.calls.length, 0);
  }
});
test('only wallet settings opt in, with isolated top-frame scripts on exact hosts', async () => {
  const f = fixture(); const app = { id: runtime.id, url: runtime.getURL('app.html') };
  await assert.rejects(f.broker.dispatch({ type: 'NATIVE_CONFIGURE', relays: [relay] }, sender));
  await f.broker.dispatch({ type: 'NATIVE_CONFIGURE', relays: [relay] }, app);
  assert.deepEqual(f.registrations[1][0], { id: 'interego-native-identity', matches: [relay + '/authorize*'], js: ['src/native-identity-content.js'], runAt: 'document_idle', allFrames: false, world: 'ISOLATED', persistAcrossSessions: true });
  f.permission(false); await assert.rejects(f.broker.dispatch({ type: 'NATIVE_CONFIGURE', relays: [relay] }, app));
});
test('content script requires an actual user click and never accepts page messages', async () => {
  let click; let opened = 0; const posted = [];
  const button = { disabled: true, dataset: { handoffCode, expiresAt: new Date(Date.now() + 30_000).toISOString() }, addEventListener: (name, listener) => { assert.equal(name, 'click'); click = listener; } };
  const status = { textContent: '' }; const window = { addEventListener: () => {} }; window.top = window;
  const context = { window, location: { protocol: 'https:', pathname: '/authorize', assign: () => {} }, document: { getElementById: id => id === 'interego-local-identity' ? button : status },
    chrome: { runtime: { connect: () => { opened++; return { onMessage: event(), onDisconnect: event(), postMessage: value => posted.push(value) }; } } }, Date };
  const source = await readFile(new URL('../src/native-identity-content.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, context); assert.equal(button.disabled, false);
  click({ isTrusted: false }); assert.equal(opened, 0);
  click({ isTrusted: true }); assert.equal(opened, 1); assert.equal(posted[0].handoffCode, handoffCode);
  click({ isTrusted: true }); assert.equal(opened, 1);
  assert.ok(!source.includes('postMessage(' + "'")); assert.ok(!source.includes('window.postMessage')); assert.ok(!source.includes('connectNative'));
});
