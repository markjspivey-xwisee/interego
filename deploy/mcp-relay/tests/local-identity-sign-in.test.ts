import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { localIdentitySignInPage } from '../local-identity-sign-in.js';
const provider = 'https://identity.interego.test', id = 'a'.repeat(43);
const loginCode = 'interego-login:v1:' + id + '.' + 'b'.repeat(43), completionCode = 'interego-login-result:v1:' + id + '.' + 'c'.repeat(43);
const metadata = () => ({ version: 1, purpose: 'returning-passkey-login', identityOrigin: provider, loginId: id, completionCode,
  expiresAt: new Date(Date.now() + 120_000).toISOString(), options: { challenge: 'n'.repeat(43), rpId: 'relay.interego.test', allowCredentials: [], userVerification: 'required' } });
async function flush(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise<void>(done => setImmediate(done)); } throw Error('Sign-in page did not settle'); }
async function page(change: (value: ReturnType<typeof metadata>) => unknown = value => value, hash = '#' + loginCode) {
  const html = localIdentitySignInPage(provider, 'fixture-script-nonce-1234'); const source = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
  const nodes = new Map(['verify', 'status', 'provider'].map(id => [id, { disabled: true, textContent: '', listeners: new Map<string, (event: { isTrusted: boolean }) => void>(),
    addEventListener(type: string, listener: (event: { isTrusted: boolean }) => void) { this.listeners.set(type, listener); } }]));
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [], replaced: unknown[][] = []; let calls = 0;
  vm.runInNewContext(source, { document: { getElementById: (id: string) => nodes.get(id) }, location: { hash, pathname: '/local-identity/sign-in', hostname: 'relay.interego.test' },
    history: { replaceState: (...args: unknown[]) => replaced.push(args) }, window: { PublicKeyCredential: class {}, addEventListener() {} },
    navigator: { credentials: { get: async (options: { publicKey: { userVerification: string; rpId: string; allowCredentials: unknown[] } }) => {
      calls++; assert.equal(options.publicKey.userVerification, 'required'); assert.equal(options.publicKey.rpId, 'relay.interego.test'); assert.deepEqual([...options.publicKey.allowCredentials], []);
      return { id: 'existing-device-passkey', rawId: new Uint8Array([1]).buffer, type: 'public-key', response: { authenticatorData: new Uint8Array([2]).buffer,
        clientDataJSON: new Uint8Array([3]).buffer, signature: new Uint8Array([4]).buffer, userHandle: null } };
    } } },
    fetch: async (url: string, init: RequestInit) => { requests.push({ url, init, body: JSON.parse(String(init.body)) }); return Response.json(url.endsWith('/context') ? change(metadata()) : { verified: true }); },
    URL, Uint8Array, TextDecoder, AbortController, AbortSignal, atob, btoa, Date,
  });
  await flush(() => !nodes.get('verify')!.disabled || nodes.get('status')!.textContent.includes('could not'));
  return { html, nodes, requests, replaced, calls: () => calls, click: (trusted: boolean) => nodes.get('verify')!.listeners.get('click')!({ isTrusted: trusted }) };
}
test('the original RP uses discoverable existing-device assertion and protected provider cookies, never account creation or bearer delivery', async () => {
  const p = await page(); assert.deepEqual(p.replaced[0], [null, '', '/local-identity/sign-in']); assert.equal(p.calls(), 0);
  p.click(false); assert.equal(p.calls(), 0); p.click(true); await flush(() => p.nodes.get('status')!.textContent.startsWith('Existing account verified'));
  assert.equal(p.calls(), 1); p.click(true); assert.equal(p.calls(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(p.requests[0]!.body)), { loginCode }); assert.equal(p.requests[1]!.body['completionCode'], completionCode);
  for (const row of p.requests) { assert.ok(row.url.startsWith(provider + '/local-identity/login/')); assert.equal(row.init.credentials, 'include'); assert.equal(row.init.redirect, 'error'); assert.equal('Authorization' in (row.init.headers as object), false); }
  for (const text of ['sessionStorage', 'localStorage', 'postMessage', 'credentials.create', 'identity-token']) assert.equal(p.html.includes(text), false);
});
test('foreign provider/RP, mismatched capabilities, weak UV and expired context never invoke the passkey', async () => {
  for (const change of [(v: ReturnType<typeof metadata>) => ({ ...v, identityOrigin: 'https://other.interego.test' }),
    (v: ReturnType<typeof metadata>) => ({ ...v, options: { ...v.options, rpId: 'identity.interego.test' } }),
    (v: ReturnType<typeof metadata>) => ({ ...v, options: { ...v.options, userVerification: 'preferred' } }),
    (v: ReturnType<typeof metadata>) => ({ ...v, loginId: 'z'.repeat(43) }),
    (v: ReturnType<typeof metadata>) => ({ ...v, completionCode: completionCode.replace(id, 'z'.repeat(43)) }),
    (v: ReturnType<typeof metadata>) => ({ ...v, expiresAt: new Date(Date.now() - 1).toISOString() })]) {
    const p = await page(change); assert.equal(p.nodes.get('verify')!.disabled, true); assert.equal(p.calls(), 0);
  }
  assert.equal((await page(value => value, '#arbitrary')).requests.length, 0);
});
