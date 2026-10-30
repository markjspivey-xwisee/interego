import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { relayOrigin } from '../src/native-origin.mjs';
import { identityProviderOrigin } from '../src/native-linking.mjs';

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const html = await readFile(new URL('../app.html', import.meta.url), 'utf8'); const nodes = new Map();
  const node = () => ({ value: '', checked: false, hidden: false, textContent: '', listeners: {}, classList: { add() {}, remove() {}, toggle() {} }, append() {}, replaceChildren() {},
    addEventListener(name, listener) { this.listeners[name] = listener; } });
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], node());
  const permission = deferred(); const requested = []; const messages = [];
  const chrome = { runtime: { id: 'wallet', sendMessage: async message => {
    messages.push(message);
    if (message.type === 'NATIVE_STATE') return { ok: true, value: { relays: [], providers: [] } };
    if (message.type === 'STATE') return { ok: true, value: { accounts: [], receipts: [], activeId: null } };
    if (message.type === 'NATIVE_CONFIGURE_LINKING') return { ok: true, value: { relays: [], providers: message.providers } };
    throw new Error('Unexpected wallet operation');
  } }, permissions: { request: query => { requested.push(query); return permission.promise; } } };
  const source = (await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  await vm.runInNewContext('(async () => {\n' + source + '\n})()', { document: { getElementById: id => nodes.get(id), createElement: node, body: node() },
    chrome, relayOrigin, identityProviderOrigin, normalizeRelay: value => value, navigator: { clipboard: {} }, URL, Error });
  return { permission, requested, messages, get: id => nodes.get(id), submit: () => nodes.get('native-linking-form').listeners.submit({ preventDefault() {} }) };
}
test('linking UI requires separate consent before the explicit optional-origin permission gesture', async () => {
  const f = await fixture(); f.get('native-linking-providers').value = 'https://identity.example';
  f.submit(); await flush(); assert.equal(f.requested.length, 0); assert.equal(f.messages.filter(v => v.type === 'NATIVE_CONFIGURE_LINKING').length, 0);
  f.get('native-linking-consent').checked = true; f.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(f.requested)), [{ origins: ['https://identity.example/*'] }]);
  assert.equal(f.messages.filter(v => v.type === 'NATIVE_CONFIGURE_LINKING').length, 0);
  f.permission.resolve(true); await flush();
  const configured = f.messages.find(v => v.type === 'NATIVE_CONFIGURE_LINKING'); assert.deepEqual(JSON.parse(JSON.stringify(configured)), { type: 'NATIVE_CONFIGURE_LINKING', providers: ['https://identity.example'] });
  assert.equal(f.get('native-linking-consent').checked, false); assert.ok(f.get('native-linking-status').textContent.includes('https://identity.example'));
});
test('denied host permission and pasted dashboard query credentials never configure linking', async () => {
  const denied = await fixture(); denied.get('native-linking-providers').value = 'https://identity.example'; denied.get('native-linking-consent').checked = true;
  denied.submit(); denied.permission.resolve(false); await flush(); assert.equal(denied.messages.filter(v => v.type === 'NATIVE_CONFIGURE_LINKING').length, 0);
  const query = await fixture(); query.get('native-linking-providers').value = 'https://identity.example/dashboard?token=NEVER_FORWARD'; query.get('native-linking-consent').checked = true;
  query.submit(); await flush(); assert.equal(query.requested.length, 0); assert.ok(!JSON.stringify(query.messages).includes('NEVER_FORWARD'));
});
test('editing provider origins removes old linking consent and disabling makes no permission request', async () => {
  const f = await fixture(); f.get('native-linking-consent').checked = true; f.get('native-linking-providers').listeners.input(); assert.equal(f.get('native-linking-consent').checked, false);
  f.get('native-linking-forget').listeners.click(); await flush();
  assert.equal(f.requested.length, 0); assert.deepEqual(JSON.parse(JSON.stringify(f.messages.at(-1))), { type: 'NATIVE_CONFIGURE_LINKING', providers: [] });
});
