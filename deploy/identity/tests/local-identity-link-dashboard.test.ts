import { afterEach, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';
import { localIdentityLinkDashboard } from '../local-identity-link-dashboard.js';

const origin = 'https://identity.example';
const bearer = 'BEARER-MUST-STAY-ON-IDENTITY-ORIGIN';
const stepUpId = 'P'.repeat(43), pendingId = 'H'.repeat(43);
const handoffCode = 'interego-link:v1:' + pendingId + '.' + 'S'.repeat(43);
const expiry = () => new Date(Date.now() + 60_000).toISOString();
const ready = () => ({ handoffCode, pendingId, expiresAt: expiry() });
const ownPasskey = () => ({ version: 1, method: 'passkey', stepUpId, expiresAt: expiry(), options: {
  challenge: 'A'.repeat(43), rpId: 'identity.example', allowCredentials: [{ type: 'public-key', id: 'B'.repeat(43) }], userVerification: 'required', timeout: 120_000,
} });
const assertion = () => ({ id: 'existing-passkey', type: 'public-key', rawId: new Uint8Array([1]).buffer, response: {
  authenticatorData: new Uint8Array([2]).buffer, clientDataJSON: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer, userHandle: null,
}, getClientExtensionResults: () => ({}) });
type Row = { url: string; method: string; body: Record<string, unknown> | undefined; authorization: string; redirect: string };
type Handler = (row: Row) => unknown | Promise<unknown>;
const documents: JSDOM[] = [];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function pollClock() {
  const delays: number[] = [], tasks = new Map<number, () => void>(); let id = -1;
  return { delays, tasks, add: (delay: number, callback: () => void) => { delays.push(delay); const next = id--; tasks.set(next, callback); return next; },
    fire: () => { const next = tasks.entries().next().value; assert.ok(next, 'A poll should be scheduled.'); tasks.delete(next[0]); next[1](); } };
}
function mount(handler: Handler, options: { credential?: (value: unknown) => Promise<unknown>; wallet?: { request(value: { method: string; params?: unknown[] }): Promise<unknown> }; popup?: () => unknown; clock?: ReturnType<typeof pollClock> } = {}) {
  const dom = new JSDOM('<!doctype html><html><body>' + localIdentityLinkDashboard() + '</body></html>', { url: origin + '/dashboard', runScripts: 'outside-only' }); documents.push(dom);
  const calls: Row[] = []; let currentToken: string | null = bearer;
  Object.defineProperties(dom.window, {
    getToken: { value: () => currentToken }, IDENTITY_BASE: { value: origin }, TextEncoder: { value: TextEncoder }, TextDecoder: { value: TextDecoder }, AbortController: { value: AbortController },
    fetch: { value: async (url: string, init: RequestInit) => {
      const row: Row = { url, method: init.method!, body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined,
        authorization: (init.headers as Record<string, string>)['Authorization']!, redirect: init.redirect! }; calls.push(row);
      return Response.json(await handler(row));
    } },
    open: { value: options.popup ?? (() => { throw new Error('No real window should open in this test.'); }) },
    ethereum: { value: options.wallet },
  });
  Object.defineProperty(dom.window.navigator, 'credentials', { value: { get: options.credential ?? (async () => { throw new Error('No automatic passkey assertion.'); }) } });
  if (options.clock) {
    const clock = options.clock, schedule = dom.window.setTimeout.bind(dom.window), clear = dom.window.clearTimeout.bind(dom.window);
    Object.defineProperties(dom.window, {
      setTimeout: { value: (callback: () => void, timeout: number) => [750, 1500, 3000, 5000].includes(timeout) ? clock.add(timeout, callback) : schedule(callback, timeout) },
      clearTimeout: { value: (timer: number) => { if (!clock.tasks.delete(timer)) clear(timer); } },
    });
  }
  dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T;
  return { dom, calls, el, token: (value: string | null) => { currentToken = value; },
    click: (id: string) => el<HTMLButtonElement>(id).click(),
    consent: () => { el<HTMLInputElement>('interego-link-consent').checked = true; el('interego-link-consent').dispatchEvent(new dom.window.Event('change')); },
  };
}
afterEach(async () => { for (const dom of documents.splice(0)) { dom.window.dispatchEvent(new dom.window.Event('pagehide')); await flush(); dom.window.close(); } });

test('session alone exposes no handoff and no assertion; fresh own-origin passkey proof gates the native capability', async () => {
  const credential = deferred<ReturnType<typeof assertion>>(); let requested = false;
  const page = mount(row => row.url.endsWith('/methods') ? { passkeyOrigins: [origin], walletAddresses: [] }
    : row.url.endsWith('/prepare') ? ownPasskey() : row.url.endsWith('/start') ? ready() : { cancelled: true }, {
    credential: async value => { requested = true; const request = value as { publicKey: { userVerification: string; rpId: string } }; assert.equal(request.publicKey.userVerification, 'required'); assert.equal(request.publicKey.rpId, 'identity.example'); return credential.promise; },
  });
  assert.equal(page.calls.length, 0); assert.equal(page.el<HTMLButtonElement>('interego-local-identity-link').disabled, true);
  assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined);
  page.click('interego-link-load'); await flush(); page.click('interego-link-verify'); await flush(); assert.equal(requested, false);
  page.consent(); page.click('interego-link-verify'); await flush(); assert.equal(requested, true);
  assert.equal(page.calls.filter(row => row.url.endsWith('/start')).length, 0); assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined);
  credential.resolve(assertion()); await flush();
  assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, handoffCode);
  assert.deepEqual(Object.keys(page.calls.find(row => row.url.endsWith('/start'))!.body!).sort(), ['response', 'stepUpId']);
  assert.ok(page.calls.every(row => row.url.startsWith(origin + '/local-identity/link/') && row.authorization === 'Bearer ' + bearer && row.redirect === 'error'));
  assert.equal(page.dom.window.document.body.innerHTML.includes(bearer), false);
});

test('original-RP passkey popup receives only its fragment capability while the dashboard polls with its own bearer', async () => {
  const result = deferred<unknown>(); const clock = pollClock(); let closed = 0, navigated = '', assertedHere = false;
  const popup = { opener: {} as unknown, location: { replace: (url: string) => { navigated = url; } }, close: () => { closed++; } };
  const stepUpUrl = 'https://game.example/local-identity/link-step-up#interego-link-step-up:v1:' + stepUpId + '.' + 'T'.repeat(43);
  const page = mount(row => row.url.endsWith('/methods') ? { passkeyOrigins: ['https://game.example'], walletAddresses: [] }
    : row.url.endsWith('/prepare') ? { version: 1, method: 'passkey', stepUpId, expiresAt: expiry(), stepUpUrl }
      : row.url.endsWith('/step-up/result') ? result.promise : { cancelled: true }, {
    popup: () => popup, credential: async () => { assertedHere = true; return assertion(); }, clock,
  });
  page.click('interego-link-load'); await flush(); page.consent(); page.click('interego-link-verify'); await flush();
  assert.equal(popup.opener, null); assert.equal(navigated, stepUpUrl); assert.equal(navigated.includes(bearer), false); assert.equal(assertedHere, false);
  assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined);
  result.resolve({ state: 'ready', ...ready() }); clock.fire(); await flush();
  assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, handoffCode); assert.equal(closed, 1);
  assert.ok(page.calls.every(row => new URL(row.url).origin === origin));
  assert.deepEqual(page.calls.find(row => row.url.endsWith('/prepare'))!.body, { method: 'passkey', rpOrigin: 'https://game.example' });
});

test('original-RP polling backs off to five seconds and cancellation removes the scheduled poll', async () => {
  const clock = pollClock();
  const stepUpUrl = 'https://game.example/local-identity/link-step-up#interego-link-step-up:v1:' + stepUpId + '.' + 'T'.repeat(43);
  const page = mount(row => row.url.endsWith('/methods') ? { passkeyOrigins: ['https://game.example'], walletAddresses: [] }
    : row.url.endsWith('/prepare') ? { version: 1, method: 'passkey', stepUpId, expiresAt: expiry(), stepUpUrl }
      : row.url.endsWith('/step-up/result') ? { state: 'waiting' } : { cancelled: true }, {
    clock, popup: () => ({ opener: {}, location: { replace: () => {} }, close: () => {} }),
  });
  page.click('interego-link-load'); await flush(); page.consent(); page.click('interego-link-verify'); await flush();
  assert.equal(page.calls.filter(row => row.url.endsWith('/step-up/result')).length, 0);
  for (const expected of [750, 1500, 3000, 5000, 5000]) {
    assert.equal(clock.delays.at(-1), expected); clock.fire(); await flush();
  }
  assert.equal(page.calls.filter(row => row.url.endsWith('/step-up/result')).length, 5); assert.equal(clock.tasks.size, 1);
  page.click('interego-link-cancel'); await flush(); assert.equal(clock.tasks.size, 0);
  assert.deepEqual(page.calls.find(row => row.url.endsWith('/cancel'))!.body, { stepUpId });
  assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined);
});

test('refuses a changed popup destination and cancels that prepared credential ceremony', async () => {
  let navigated = false, closed = false;
  const page = mount(row => row.url.endsWith('/methods') ? { passkeyOrigins: ['https://game.example'], walletAddresses: [] }
    : row.url.endsWith('/prepare') ? { version: 1, method: 'passkey', stepUpId, expiresAt: expiry(), stepUpUrl: 'https://other.example/local-identity/link-step-up#interego-link-step-up:v1:' + stepUpId + '.' + 'T'.repeat(43) }
      : { cancelled: true }, { popup: () => ({ opener: {}, location: { replace: () => { navigated = true; } }, close: () => { closed = true; } }) });
  page.click('interego-link-load'); await flush(); page.consent(); page.click('interego-link-verify'); await flush();
  assert.equal(navigated, false); assert.equal(closed, true); assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined);
  assert.deepEqual(page.calls.find(row => row.url.endsWith('/cancel'))!.body, { stepUpId });
});

test('wallet step-up signs the exact server message, keeps its signature out of the DOM, and clears the terminal link lifecycle', async () => {
  const address = '0x' + 'a'.repeat(40), signature = '0x' + 'b'.repeat(130), action = 'Authorize adding this PC key to the existing owner and pod.';
  const signed = deferred<string>(); let messageHex = '';
  const page = mount(row => row.url.endsWith('/methods') ? { passkeyOrigins: [], walletAddresses: [address] }
    : row.url.endsWith('/prepare') ? { version: 1, method: 'wallet', stepUpId, expiresAt: expiry(), message: action, address }
      : row.url.endsWith('/start') ? ready() : { cancelled: true }, { wallet: { request: async input => {
        if (input.method === 'eth_requestAccounts') return [address]; if (input.method === 'eth_chainId') return '0x1';
        assert.equal(input.method, 'personal_sign'); messageHex = String(input.params![0]); assert.equal(input.params![1], address); return signed.promise;
      } } });
  page.click('interego-link-load'); await flush(); page.consent(); page.click('interego-link-verify'); await flush();
  assert.equal(Buffer.from(messageHex.slice(2), 'hex').toString(), action); assert.equal(page.el('interego-link-wallet-message').textContent, action);
  assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined);
  signed.resolve(signature); await flush();
  assert.deepEqual(page.calls.find(row => row.url.endsWith('/prepare'))!.body, { method: 'wallet', address, chainId: 1 });
  assert.deepEqual(page.calls.find(row => row.url.endsWith('/start'))!.body, { stepUpId, signature });
  assert.equal(page.dom.window.document.body.innerHTML.includes(signature), false); assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, handoffCode);
  page.el('interego-local-identity-link-status').dataset.nativeState = 'linked'; await flush();
  assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined); assert.equal(page.el<HTMLButtonElement>('interego-link-cancel').disabled, true);
  assert.equal(page.el<HTMLInputElement>('interego-link-consent').checked, false); assert.equal(page.calls.some(row => row.url.endsWith('/cancel')), false);
});

test('cancelling during wallet approval prevents a late signature from starting native linking', async () => {
  const signature = deferred<string>(), address = '0x' + 'c'.repeat(40);
  const page = mount(row => row.url.endsWith('/methods') ? { passkeyOrigins: [], walletAddresses: [address] }
    : row.url.endsWith('/prepare') ? { version: 1, method: 'wallet', stepUpId, expiresAt: expiry(), message: 'Add a PC key.', address } : { cancelled: true }, {
    wallet: { request: async input => input.method === 'eth_requestAccounts' ? [address] : input.method === 'eth_chainId' ? '0x1' : signature.promise },
  });
  page.click('interego-link-load'); await flush(); page.consent(); page.click('interego-link-verify'); await flush();
  page.click('interego-link-cancel'); await flush(); signature.resolve('0x' + 'd'.repeat(130)); await flush();
  assert.equal(page.calls.some(row => row.url.endsWith('/start')), false); assert.equal(page.el('interego-local-identity-link').dataset.handoffCode, undefined);
  assert.deepEqual(page.calls.find(row => row.url.endsWith('/cancel'))!.body, { stepUpId });
});
