import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { returningPasskeyLoginDashboard } from '../returning-passkey-dashboard.js';

const provider = 'https://identity.interego.test', relay = 'https://relay.interego.test';
const id = 'a'.repeat(43), receipt = 'interego-login-receipt:v1:' + id + '.' + 'b'.repeat(43);
const ready = () => ({ version: 1, identityOrigin: provider, authorizationUrl: relay + '/local-identity/sign-in#interego-login:v1:' + id + '.' + 'c'.repeat(43),
  receipt, expiresAt: new Date(Date.now() + 120_000).toISOString() });
const documents: JSDOM[] = [];
async function flush() { for (let i = 0; i < 4; i++) await new Promise<void>(done => setImmediate(done)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function mount(handler: (path: string) => unknown | Promise<unknown>, popupAvailable = true) {
  const dom = new JSDOM('<!doctype html><div id="login"></div>', { url: provider + '/dashboard', runScripts: 'outside-only' }); documents.push(dom);
  const calls: Array<{ path: string; init: RequestInit; body: unknown }> = [], events = new Map<string, (event: { isTrusted: boolean }) => void>();
  let url = '', closed = 0, rendered = 0; const order: string[] = [], timers: Array<() => void> = [];
  const popup = { opener: {} as unknown, location: { replace: (value: string) => { url = value; } }, close: () => { closed++; } };
  const add = dom.window.EventTarget.prototype.addEventListener;
  dom.window.EventTarget.prototype.addEventListener = function (type, listener, options) {
    const target = this as HTMLElement;
    if (type === 'click' && target.id === 'returning-passkey-login') events.set('click', listener as unknown as (event: { isTrusted: boolean }) => void);
    return add.call(this, type, listener, options);
  };
  Object.defineProperties(dom.window, {
    getToken: { value: () => dom.window.sessionStorage.getItem('cg.token') }, renderDashboard: { value: async () => { rendered++; } },
    AbortSignal: { value: AbortSignal }, AbortController: { value: AbortController },
    open: { value: () => { order.push('open'); return popupAvailable ? popup : null; } },
    setTimeout: { value: (callback: () => void) => { timers.push(callback); return timers.length; } }, clearTimeout: { value: () => {} },
    fetch: { value: async (url: string, init: RequestInit) => {
      assert.equal(new URL(url).origin, provider); const path = url.split('/').pop()!; order.push(path);
      calls.push({ path, init, body: JSON.parse(String(init.body)) }); return Response.json(await handler(path));
    } },
  });
  dom.window.eval(returningPasskeyLoginDashboard(provider, relay) + '\ninstallReturningPasskeyLogin(document.getElementById("login"));');
  const el = (id: string) => dom.window.document.getElementById(id)!;
  return { dom, calls, order, popup, click: (trusted = true) => events.get('click')!({ isTrusted: trusted }),
    poll: async () => { const timer = timers.shift(); assert.ok(timer); timer(); await flush(); }, cancel: () => (el('login').querySelectorAll('button')[1] as HTMLButtonElement).click(),
    status: () => el('returning-passkey-login-status').textContent, popupUrl: () => url, closed: () => closed, rendered: () => rendered };
}
afterEach(() => { for (const dom of documents.splice(0)) { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); } });

test('usual-device login opens its fixed RP under the click, and only the provider receives/stores its normal session', async () => {
  const page = mount(path => path === 'start' ? ready() : { state: 'signed-in', token: 'fixture-token', userId: 'existing-owner' });
  page.click(false); await flush(); assert.equal(page.calls.length, 0); page.click(); await flush();
  assert.deepEqual(page.order, ['open', 'start']); assert.equal(page.popup.opener, null); assert.equal(page.popupUrl(), ready().authorizationUrl);
  assert.equal(page.popupUrl().includes(receipt), false); assert.equal(page.dom.window.sessionStorage.length, 0);
  await page.poll(); assert.equal(page.rendered(), 1); assert.equal(page.closed(), 1); assert.equal(page.dom.window.sessionStorage.getItem('cg.token'), 'fixture-token');
  assert.equal(page.dom.window.document.body.textContent!.includes('fixture-token'), false);
  for (const call of page.calls) { assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal('Authorization' in (call.init.headers as object), false); }
  assert.deepEqual(page.calls[0]!.body, {}); assert.deepEqual(page.calls[1]!.body, { receipt });
});
test('cancelled or independently changed account pages cannot be overwritten by a delayed login', async () => {
  for (const changed of [false, true]) {
    const result = deferred<unknown>(); const page = mount(path => path === 'start' ? ready() : path === 'result' ? result.promise : { cancelled: true });
    page.click(); await flush(); const pending = page.poll(); await flush();
    if (changed) page.dom.window.sessionStorage.setItem('cg.token', 'other-session'); else page.cancel();
    result.resolve({ state: 'signed-in', token: 'fixture-token', userId: 'existing-owner' }); await pending; await flush();
    assert.equal(page.dom.window.sessionStorage.getItem('cg.token'), changed ? 'other-session' : null); assert.equal(page.rendered(), 0);
    assert.ok(page.closed() >= 1);
  }
});
test('blocked popups and foreign, query-bearing or mismatched RP handoffs fail without an account change', async () => {
  const blocked = mount(() => { throw new Error('No request expected'); }, false); blocked.click(); await flush(); assert.equal(blocked.calls.length, 0); assert.match(blocked.status()!, /Allow the sign-in popup/);
  for (const change of [(v: ReturnType<typeof ready>) => ({ ...v, authorizationUrl: v.authorizationUrl.replace(relay, 'https://foreign.interego.test') }),
    (v: ReturnType<typeof ready>) => ({ ...v, authorizationUrl: v.authorizationUrl.replace('#', '?token=unexpected#') }),
    (v: ReturnType<typeof ready>) => ({ ...v, receipt: v.receipt.replace(id, 'd'.repeat(43)) }),
    (v: ReturnType<typeof ready>) => ({ ...v, expiresAt: new Date(Date.now() - 1).toISOString() })]) {
    const page = mount(() => change(ready())); page.click(); await flush(); assert.equal(page.popupUrl(), ''); assert.equal(page.dom.window.sessionStorage.length, 0); assert.match(page.status()!, /could not be verified/);
  }
});
