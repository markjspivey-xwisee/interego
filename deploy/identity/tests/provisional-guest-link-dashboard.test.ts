/**
 * The dashboard's guest-link section (provisional-guest-link-dashboard.ts), run in a document with
 * a stand-in for identity's answers, a stand-in wallet and a stand-in passkey. It asks for nothing
 * without the bearer, proves with a credential already on the account before each code and each
 * unlink, and never puts the bearer in the page. Fictional values only.
 */
import { afterEach, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { JSDOM } from 'jsdom';
import { guestLinkDashboard } from '../provisional-guest-link-dashboard.js';

const origin = 'https://identity.example';
const door = 'https://door.identity.example/guest/door#link';
const bearer = 'BEARER-MUST-STAY-ON-IDENTITY-ORIGIN';
const wallet = `0x${'ab'.repeat(20)}`;
const guest = `u-try-guest-${'c'.repeat(32)}`;
type Row = { url: string; method: string; body: Record<string, unknown> | undefined; authorization: string };
const documents: JSDOM[] = [];
async function flush() { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function mount(handler: (row: Row) => unknown, options: { token?: string | null; signed?: unknown[]; credential?: () => Promise<unknown> } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${guestLinkDashboard(door)}</body></html>`, { url: `${origin}/dashboard`, runScripts: 'outside-only' }); documents.push(dom);
  const calls: Row[] = [];
  Object.defineProperties(dom.window, {
    getToken: { value: () => options.token === undefined ? bearer : options.token }, IDENTITY_BASE: { value: origin }, TextEncoder: { value: TextEncoder },
    fetch: { value: async (url: string, init: RequestInit) => {
      const row: Row = { url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined, authorization: (init.headers as Record<string, string>)['Authorization']! };
      calls.push(row);
      const answer = handler(row) as { status?: number } | undefined;
      return Response.json(answer ?? {}, { status: answer?.status ?? 200 });
    } },
    ethereum: { value: { request: async (asked: { method: string; params?: unknown[] }) => {
      if (asked.method === 'eth_requestAccounts') return [wallet];
      if (asked.method === 'eth_chainId') return '0x1';
      options.signed?.push(asked.params); return `0x${'12'.repeat(65)}`;
    } } },
  });
  Object.defineProperty(dom.window.navigator, 'credentials', { value: { get: options.credential ?? (async () => { throw new Error('No passkey here.'); }) } });
  dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T;
  return { dom, calls, el, click: (id: string) => el<HTMLButtonElement>(id).click() };
}
afterEach(() => { for (const dom of documents.splice(0)) dom.window.close(); });
const answers = (linked: Array<Record<string, unknown>>) => (row: Row): unknown => {
  const path = new URL(row.url).pathname;
  if (path === '/local-identity/link/methods') return { passkeyOrigins: [origin], walletAddresses: [wallet] };
  if (path === '/guest/link/guests') return { guests: linked };
  if (path === '/guest/link/prepare') return row.body!['method'] === 'wallet'
    ? { version: 1, method: 'wallet', stepUpId: 'S'.repeat(43), message: `Authorize ${String(row.body!['action'])}`, address: wallet }
    : { version: 1, method: 'passkey', stepUpId: 'P'.repeat(43), options: { challenge: 'A'.repeat(43), rpId: 'identity.example', allowCredentials: [{ type: 'public-key', id: 'B'.repeat(43) }], userVerification: 'required' } };
  if (path === '/guest/link/code') return { code: 'u-eth-aaaa00000001:0123456789AB', expiresAt: new Date(Date.now() + 300_000).toISOString() };
  if (path === '/guest/link/unlink') { linked.length = 0; return { unlinked: true, wasLinked: true }; }
  return { status: 404 };
};

test('the section asks nothing until the owner acts, and a code is shown only after a proof by a credential on the account', async () => {
  const signed: unknown[] = [];
  const page = mount(answers([]), { signed });
  assert.equal(page.calls.length, 0);
  assert.equal(page.el('guest-link-methods').hidden, true);
  page.click('guest-link-load'); await flush();
  assert.deepEqual(page.calls.map(row => new URL(row.url).pathname), ['/local-identity/link/methods', '/guest/link/guests']);
  const select = page.el<HTMLSelectElement>('guest-link-method');
  assert.deepEqual([...select.options].map(option => option.value), ['passkey', wallet]);
  // With the wallet: prepare names the action and the wallet, the wallet signs the message it was given, and only then is a code asked for.
  select.value = wallet;
  page.click('guest-link-code'); await flush();
  const prepared = page.calls.find(row => row.url.endsWith('/guest/link/prepare'))!;
  assert.deepEqual(prepared.body, { action: 'code', method: 'wallet', address: wallet, chainId: 1 });
  assert.equal(signed.length, 1);
  assert.equal(Buffer.from(String((signed[0] as string[])[0]).slice(2), 'hex').toString('utf8'), 'Authorize code');
  assert.deepEqual(page.calls.at(-1)!.body, { stepUpId: 'S'.repeat(43), signature: `0x${'12'.repeat(65)}` });
  assert.equal(page.el('guest-link-result').hidden, false);
  assert.equal(page.el('guest-link-value').textContent, 'u-eth-aaaa00000001:0123456789AB');
  assert.equal(page.el<HTMLAnchorElement>('guest-link-door').href, door);
  assert.match(page.el('guest-link-settings').textContent!, /give it to nobody/);
  // Every request went to identity's own origin with the bearer, and the bearer is nowhere in the page.
  assert.ok(page.calls.every(row => row.url.startsWith(`${origin}/`) && row.authorization === `Bearer ${bearer}`));
  assert.equal(page.dom.window.document.body.innerHTML.includes(bearer), false);
});

test('a passkey on this site proves too; a refused proof shows no code; unlinking proves again, for that guest', async () => {
  const linked = [{ userId: guest, did: `did:web:identity.example:users:${guest}`, linkedAt: 1, standingUntil: Math.floor(Date.now() / 1000) + 3600 }];
  const assertion = { id: 'existing-passkey', type: 'public-key', rawId: new Uint8Array([1]).buffer, response: {
    authenticatorData: new Uint8Array([2]).buffer, clientDataJSON: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer, userHandle: null }, getClientExtensionResults: () => ({}) };
  let allow = false;
  const page = mount(answers(linked), { credential: async () => { if (!allow) throw new Error('The passkey was not confirmed.'); return assertion; } });
  page.click('guest-link-load'); await flush();
  page.click('guest-link-code'); await flush();
  assert.equal(page.el('guest-link-result').hidden, true);
  assert.equal(page.el('guest-link-status').textContent, 'The passkey was not confirmed.');
  assert.equal(page.calls.some(row => row.url.endsWith('/guest/link/code')), false, 'no proof, no request for a code');
  allow = true;
  page.click('guest-link-code'); await flush();
  const asked = page.calls.find(row => row.url.endsWith('/guest/link/code'))!;
  assert.deepEqual(Object.keys(asked.body!).sort(), ['response', 'stepUpId']);
  assert.equal((asked.body!['response'] as { id: string }).id, 'existing-passkey');
  assert.equal(page.el('guest-link-result').hidden, false);
  // The linked guest is listed, and unlinking it prepares a proof that names it.
  const unlink = page.el('guest-link-list').querySelector('button')!;
  assert.match(page.el('guest-link-list').textContent!, /Linked guest cccccccc/);
  unlink.click(); await flush();
  const prepares = page.calls.filter(row => row.url.endsWith('/guest/link/prepare'));
  assert.deepEqual(prepares.at(-1)!.body, { action: 'unlink', guest, method: 'passkey' });
  assert.equal(page.calls.some(row => row.url.endsWith('/guest/link/unlink')), true);
  assert.equal(page.el('guest-link-list').querySelector('button'), null);
});

test('without a bearer the section sends nothing', async () => {
  const page = mount(answers([]), { token: null });
  page.click('guest-link-load'); await flush();
  page.click('guest-link-code'); await flush();
  assert.equal(page.calls.length, 0);
  assert.match(page.el('guest-link-status').textContent!, /Sign in/);
});
