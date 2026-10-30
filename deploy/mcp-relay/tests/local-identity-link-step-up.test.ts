import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { localIdentityLinkStepUpPage } from '../local-identity-link-step-up.js';

const provider = 'https://identity.example.com';
const stepUpCode = 'interego-link-step-up:v1:' + 'a'.repeat(43) + '.' + 'b'.repeat(43);
const completionCode = 'interego-link-step-up-result:v1:' + 'c'.repeat(43) + '.' + 'd'.repeat(43);
function metadata() { return { version: 1, purpose: 'link-step-up', identityOrigin: provider, stepUpId: 'e'.repeat(43),
  owner: { did: 'did:web:identity.example.com:users:existing-player' }, expiresAt: new Date(Date.now() + 120_000).toISOString(),
  options: { challenge: 'n'.repeat(43), rpId: 'relay.example.com', allowCredentials: [{ type: 'public-key', id: 'a'.repeat(43) }], userVerification: 'required', timeout: 120_000 }, completionCode }; }
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Page fixture did not settle.'); }
async function page(change: (value: ReturnType<typeof metadata>) => unknown = value => value, hash = '#' + stepUpCode) {
  const html = localIdentityLinkStepUpPage(provider, 'test-script-nonce-1234');
  const source = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
  const nodes = new Map(['verify', 'status', 'account'].map(id => [id, { disabled: true, textContent: '', listeners: new Map<string, (event: unknown) => void>(),
    addEventListener(event: string, fn: (event: unknown) => void) { this.listeners.set(event, fn); } }]));
  const events = new Map<string, () => void>(); const posts: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const replaced: unknown[][] = []; let credentialCalls = 0;
  const assertion = { id: 'existing-passkey', rawId: new Uint8Array([1, 2]).buffer, type: 'public-key', response: {
    authenticatorData: new Uint8Array([3]).buffer, clientDataJSON: new Uint8Array([4]).buffer, signature: new Uint8Array([5]).buffer, userHandle: null },
    getClientExtensionResults: () => ({}) };
  vm.runInNewContext(source, { document: { getElementById: (id: string) => nodes.get(id) }, location: { hash, pathname: '/local-identity/link-step-up', hostname: 'relay.example.com' },
    history: { replaceState: (...args: unknown[]) => { replaced.push(args); } }, window: { PublicKeyCredential: class {}, addEventListener: (event: string, fn: () => void) => events.set(event, fn) },
    navigator: { credentials: { get: async (options: { publicKey: { userVerification: string; rpId: string } }) => { credentialCalls++; assert.equal(options.publicKey.userVerification, 'required'); assert.equal(options.publicKey.rpId, 'relay.example.com'); return assertion; } } },
    fetch: async (url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); posts.push({ url, init, body });
      return Response.json(url.endsWith('/context') ? change(metadata()) : { verified: true }); },
    AbortController, AbortSignal, Uint8Array, TextDecoder, atob, btoa, Date, setTimeout, clearTimeout,
  });
  await until(() => !nodes.get('verify')!.disabled || nodes.get('status')!.textContent.includes('could not'));
  return { html, nodes, posts, replaced, events, credentialCalls: () => credentialCalls,
    click: (trusted: boolean) => nodes.get('verify')!.listeners.get('click')!({ isTrusted: trusted }) };
}

test('original-RP step-up uses only one-use capabilities and fresh existing passkey proof', async () => {
  const p = await page(); assert.equal(p.nodes.get('verify')!.disabled, false);
  assert.deepEqual(p.replaced[0], [null, '', '/local-identity/link-step-up']);
  assert.equal(p.posts.length, 1); assert.equal(p.posts[0].url, provider + '/local-identity/link/step-up/context');
  assert.deepEqual(JSON.parse(JSON.stringify(p.posts[0].body)), { stepUpCode });
  p.click(false); assert.equal(p.credentialCalls(), 0); p.click(true);
  await until(() => p.nodes.get('status')!.textContent.startsWith('Existing account verified'));
  assert.equal(p.credentialCalls(), 1); assert.equal(p.posts.length, 2); assert.equal(p.posts[1].url, provider + '/local-identity/link/step-up/complete');
  assert.equal(p.posts[1].body.completionCode, completionCode);
  assert.equal((p.posts[1].body.response as { id: string }).id, 'existing-passkey');
  for (const post of p.posts) { assert.equal(post.init.credentials, 'omit'); assert.equal(post.init.redirect, 'error'); assert.equal('authorization' in (post.init.headers as object), false); }
  assert.ok(!p.html.includes('sessionStorage') && !p.html.includes('localStorage') && !p.html.includes('postMessage'));
  p.click(true); assert.equal(p.credentialCalls(), 1); p.events.get('pagehide')!();
});

test('step-up refuses foreign provider/RP, weak verification, expiry and malformed capabilities', async () => {
  for (const change of [
    (v: ReturnType<typeof metadata>) => ({ ...v, identityOrigin: 'https://foreign.example' }),
    (v: ReturnType<typeof metadata>) => ({ ...v, options: { ...v.options, rpId: 'foreign.example' } }),
    (v: ReturnType<typeof metadata>) => ({ ...v, options: { ...v.options, userVerification: 'preferred' } }),
    (v: ReturnType<typeof metadata>) => ({ ...v, expiresAt: new Date(Date.now() - 1).toISOString() }),
    (v: ReturnType<typeof metadata>) => ({ ...v, completionCode: 'raw-login-token' }),
  ]) { const p = await page(change); assert.ok(p.nodes.get('verify')!.disabled); assert.match(p.nodes.get('status')!.textContent, /could not/); assert.equal(p.credentialCalls(), 0); }
  const invalid = await page(v => v, '#arbitrary'); assert.equal(invalid.posts.length, 0);
});

test('popup renderer accepts only a configured HTTPS provider and a script nonce', () => {
  for (const origin of ['http://identity.example.com', provider + '/path', 'https://user:secret@identity.example.com', provider + ':8443']) assert.throws(() => localIdentityLinkStepUpPage(origin, 'safe-script-nonce-1234'));
  assert.throws(() => localIdentityLinkStepUpPage(provider, '"><script>'));
});
