import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { localIdentityLinkStepUpPage } from '../local-identity-link-step-up.js';

const provider = 'https://identity.example.com';
const stepUpCode = 'interego-link-step-up:v1:' + 'a'.repeat(43) + '.' + 'b'.repeat(43);
const completionCode = 'interego-link-step-up-result:v1:' + 'c'.repeat(43) + '.' + 'd'.repeat(43);
function metadata(now = Date.now()) { return { version: 1, purpose: 'link-step-up', identityOrigin: provider, stepUpId: 'e'.repeat(43),
  owner: { did: 'did:web:identity.example.com:users:existing-player' }, expiresAt: new Date(now + 120_000).toISOString(),
  options: { challenge: 'n'.repeat(43), rpId: 'relay.example.com', allowCredentials: [{ type: 'public-key', id: 'a'.repeat(43) }], userVerification: 'required', timeout: 120_000 }, completionCode }; }
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Page fixture did not settle.'); }
function clock() {
  let now = Date.parse('2026-10-31T20:00:00.000Z'), next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return { now: () => now, timers,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (run: () => void, delay: number) => { const id = ++next; timers.set(id, { at: now + delay, run }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    jump: (milliseconds: number) => { now += milliseconds; },
    advance: (milliseconds: number) => {
      const end = now + milliseconds;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].run();
      }
      now = end;
    },
  };
}
async function page(change: (value: ReturnType<typeof metadata>) => unknown = value => value, hash = '#' + stepUpCode, timer?: ReturnType<typeof clock>,
  behavior: { credential?: (assertion: unknown) => Promise<unknown>; completion?: () => Promise<Response> } = {}) {
  const html = localIdentityLinkStepUpPage(provider, 'test-script-nonce-1234');
  const source = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1];
  const nodes = new Map(['verify', 'status', 'account'].map(id => [id, { disabled: true, textContent: '', listeners: new Map<string, (event: unknown) => void>(),
    addEventListener(event: string, fn: (event: unknown) => void) { this.listeners.set(event, fn); } }]));
  const events = new Map<string, () => void>(); const posts: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const replaced: unknown[][] = []; let credentialCalls = 0; const credentialSignals: AbortSignal[] = [];
  const assertion = { id: 'existing-passkey', rawId: new Uint8Array([1, 2]).buffer, type: 'public-key', response: {
    authenticatorData: new Uint8Array([3]).buffer, clientDataJSON: new Uint8Array([4]).buffer, signature: new Uint8Array([5]).buffer, userHandle: null },
    getClientExtensionResults: () => ({}) };
  vm.runInNewContext(source, { document: { getElementById: (id: string) => nodes.get(id) }, location: { hash, pathname: '/local-identity/link-step-up', hostname: 'relay.example.com' },
    history: { replaceState: (...args: unknown[]) => { replaced.push(args); } }, window: { PublicKeyCredential: class {}, addEventListener: (event: string, fn: () => void) => events.set(event, fn) },
    navigator: { credentials: { get: async (options: { signal: AbortSignal; publicKey: { userVerification: string; rpId: string } }) => {
      credentialCalls++; credentialSignals.push(options.signal); assert.equal(options.publicKey.userVerification, 'required');
      assert.equal(options.publicKey.rpId, 'relay.example.com'); return behavior.credential ? behavior.credential(assertion) : assertion; } } },
    fetch: async (url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); posts.push({ url, init, body });
      return url.endsWith('/context') ? Response.json(change(metadata(timer?.now())))
        : behavior.completion ? behavior.completion() : Response.json({ verified: true }); },
    AbortController, AbortSignal, Uint8Array, TextDecoder, atob, btoa,
    Date: timer?.Date ?? Date, setTimeout: timer?.setTimeout ?? setTimeout, clearTimeout: timer?.clearTimeout ?? clearTimeout,
  });
  await until(() => !nodes.get('verify')!.disabled || nodes.get('status')!.textContent.includes('could not'));
  return { html, nodes, posts, replaced, events, credentialSignals, credentialCalls: () => credentialCalls,
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

test('the verified absolute deadline disables the waiting button without extending its two-minute lifetime', async () => {
  const timer = clock(), p = await page(value => value, '#' + stepUpCode, timer);
  timer.advance(119_999); assert.equal(p.nodes.get('verify')!.disabled, false);
  assert.equal(p.posts.length, 1); assert.equal(p.credentialCalls(), 0);
  timer.advance(1);
  assert.equal(p.nodes.get('verify')!.disabled, true);
  assert.match(p.nodes.get('status')!.textContent, /expired/i);
  assert.match(p.nodes.get('status')!.textContent, /account dashboard.*new/i);
  p.click(true); assert.equal(p.credentialCalls(), 0); assert.equal(p.posts.length, 1);
  assert.equal(timer.timers.size, 0);
});

test('an expired click gives feedback even when a suspended tab has not delivered its timer', async () => {
  const timer = clock(), p = await page(value => value, '#' + stepUpCode, timer);
  timer.jump(120_000); p.click(true);
  assert.equal(p.nodes.get('verify')!.disabled, true);
  assert.match(p.nodes.get('status')!.textContent, /expired/i);
  assert.equal(p.credentialCalls(), 0); assert.equal(p.posts.length, 1);
  assert.equal(timer.timers.size, 0);
});

test('a request with little time remaining expires at its server deadline rather than receiving another two minutes', async () => {
  const timer = clock(), expiresAt = new Date(timer.now() + 5000).toISOString();
  const p = await page(value => ({ ...value, expiresAt }), '#' + stepUpCode, timer);
  timer.advance(4999); assert.equal(p.nodes.get('verify')!.disabled, false);
  timer.advance(1); assert.equal(p.nodes.get('verify')!.disabled, true);
  assert.match(p.nodes.get('status')!.textContent, /expired/i);
  assert.equal(p.credentialCalls(), 0); assert.equal(p.posts.length, 1); assert.equal(timer.timers.size, 0);
});

test('invalid and zero initial deadlines remain closed without arming expiry or asking for a passkey', async () => {
  for (const expiresAt of ['invalid', new Date(0).toISOString()]) {
    const timer = clock(), p = await page(value => ({ ...value, expiresAt }), '#' + stepUpCode, timer);
    p.click(true); timer.advance(120_000);
    assert.equal(p.nodes.get('verify')!.disabled, true);
    assert.match(p.nodes.get('status')!.textContent, /could not/);
    assert.equal(p.credentialCalls(), 0); assert.equal(p.posts.length, 1); assert.equal(timer.timers.size, 0);
  }
});

test('successful proof and leaving the page clear the waiting expiry callback', async () => {
  const timer = clock(), p = await page(value => value, '#' + stepUpCode, timer);
  p.click(true); await until(() => p.nodes.get('status')!.textContent.startsWith('Existing account verified'));
  const verified = p.nodes.get('status')!.textContent;
  assert.equal(timer.timers.size, 0); timer.advance(120_000);
  assert.equal(p.nodes.get('status')!.textContent, verified);
  const leaving = clock(), other = await page(value => value, '#' + stepUpCode, leaving);
  other.events.get('pagehide')!(); assert.equal(leaving.timers.size, 0);
  other.click(true); assert.equal(other.credentialCalls(), 0); assert.equal(other.posts.length, 1);
});

test('expiry aborts a pending passkey and ignores a late assertion even if the provider ignores cancellation', async () => {
  for (const deliverTimer of [true, false]) {
    const timer = clock(); let release!: (value: unknown) => void, assertion: unknown;
    const pending = new Promise<unknown>(resolve => { release = resolve; });
    const p = await page(value => value, '#' + stepUpCode, timer, { credential: value => { assertion = value; return pending; } });
    p.click(true); assert.equal(p.credentialCalls(), 1);
    if (deliverTimer) timer.advance(120_000); else timer.jump(120_000);
    if (deliverTimer) assert.equal(p.credentialSignals[0].aborted, true);
    release(assertion); await new Promise(resolve => setImmediate(resolve));
    assert.equal(p.credentialSignals[0].aborted, true);
    assert.equal(p.posts.length, 1); assert.match(p.nodes.get('status')!.textContent, /expired/i);
    assert.equal(p.nodes.get('verify')!.disabled, true); assert.equal(timer.timers.size, 0);
  }
});

test('a still-valid verification POST preserves server success when its response body arrives after the old deadline', async () => {
  const timer = clock(); let release!: () => void;
  const p = await page(value => value, '#' + stepUpCode, timer, { completion: async () => new Response(new ReadableStream({
    start(controller) { release = () => { controller.enqueue(new TextEncoder().encode('{"verified":true}')); controller.close(); }; },
  }), { headers: { 'content-type': 'application/json' } }) });
  p.click(true); await until(() => p.posts.length === 2); timer.advance(120_000); release();
  await new Promise(resolve => setImmediate(resolve));
  await until(() => p.nodes.get('status')!.textContent.startsWith('Existing account verified'));
  assert.equal(p.posts.length, 2); assert.equal(p.credentialCalls(), 1); assert.equal(timer.timers.size, 0);
});

test('a passkey failure clears its expiry timer and keeps its terminal feedback', async () => {
  const timer = clock(), p = await page(value => value, '#' + stepUpCode, timer, {
    credential: async () => { throw new Error('Passkey was cancelled'); },
  });
  p.click(true); await until(() => p.nodes.get('status')!.textContent.includes('could not'));
  const failed = p.nodes.get('status')!.textContent;
  assert.equal(timer.timers.size, 0); timer.advance(120_000);
  assert.equal(p.nodes.get('status')!.textContent, failed); assert.equal(p.posts.length, 1);
});
