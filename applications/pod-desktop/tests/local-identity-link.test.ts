import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { ClientRequest, createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalIdentityService } from '../src/local-identity.js';
import { identityHash, type LocalIdentitySaved } from '../src/local-identity-protocol.js';
import type { LocalIdentityLinkContext, LocalIdentityLinkedReceipt, LocalIdentityStore } from '../src/local-identity-types.js';

const provider = 'https://identity.example.com'; const relay = 'https://relay.example.com';
const now = Date.parse('2026-10-30T15:00:00Z'); const opaque = () => randomBytes(32).toString('base64url');
const handoff = () => 'interego-link:v1:' + opaque() + '.' + opaque();
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const account = { userId: 'u-pk-existing-owner', did: 'did:web:identity.example.com:users:u-pk-existing-owner',
  webId: provider + '/users/u-pk-existing-owner/profile#me', podUrl: 'https://store.example.com/u-pk-existing-owner/', displayName: 'Existing player' };
function context(did: string): LocalIdentityLinkContext {
  const value = { version: 1 as const, purpose: 'link' as const, issuer: provider, identityOrigin: provider, pendingId: opaque(), owner: { ...account }, credentialDid: did,
    nonce: opaque(), message: '', expiresAt: new Date(now + 120_000).toISOString(), challengeExpiresAt: new Date(now + 120_000).toISOString(),
    completionCode: 'interego-link-result:v1:' + opaque() + '.' + opaque() };
  value.message = `Interego local identity link v1\nHost: identity.example.com\nAccount: ${account.did}\nPod: ${account.podUrl}\nCredential: ${did}\nRequest: ${value.pendingId}\nNonce: ${value.nonce}\nExpires: ${value.expiresAt}`;
  return value;
}
async function fixture(input: { change?: (value: LocalIdentityLinkContext) => unknown; complete?: (value: LocalIdentityLinkedReceipt) => unknown; fetch?: typeof fetch } = {}) {
  let saved: unknown | null = null; let binding: string | null = 'existing-local-pod'; let clock = now;
  const store: LocalIdentityStore = { load: async () => structuredClone(saved), save: async value => { saved = structuredClone(value); } };
  const posts: Array<{ url: string; body: Record<string, unknown>; signal: AbortSignal }> = []; let meta: LocalIdentityLinkContext;
  const fetcher: typeof fetch = input.fetch ?? (async request => {
    const req = new Request(request); const body = JSON.parse(await req.text()) as Record<string, unknown>; posts.push({ url: req.url, body, signal: req.signal });
    if (req.url === provider + '/local-identity/link/context') { meta = context(String(body['did'])); return Response.json(input.change ? input.change(meta) : meta); }
    if (req.url === provider + '/local-identity/link/complete') {
      const receipt: LocalIdentityLinkedReceipt = { linked: true, identityOrigin: provider, owner: { ...account }, credentialDid: meta.credentialDid };
      return Response.json(input.complete ? input.complete(receipt) : receipt);
    }
    throw new Error('Unexpected network endpoint.');
  });
  const options = { store, binding: async () => binding, trustedRelays: [{ relayOrigin: relay, identityOrigin: provider }], now: () => clock, fetch: fetcher };
  const service = new LocalIdentityService(options); const initial = await service.setup();
  return { service, initial, posts, options, meta: () => meta, saved: () => saved as LocalIdentitySaved, time: (value: number) => { clock = value; },
    binding: (value: string | null) => { binding = value; }, request: (channel = 'same-native-browser') => service.request({ relayOrigin: provider, handoffCode: handoff() }, channel) };
}

describe('native local key linking to an existing hosted account', () => {
  it('requires native owner approval and returns only an exact existing-owner receipt once', async () => {
    const f = await fixture(); const ticket = await f.request(); const pending = (await f.service.status()).pending[0]!;
    expect(pending).toEqual({ purpose: 'link', id: ticket.id, state: 'waiting', identityOrigin: provider, owner: account,
      credentialDid: f.initial.identity!.did, credentialFingerprint: identityHash(f.initial.identity!.did), verificationCode: ticket.verificationCode, expiresAt: f.meta().expiresAt });
    for (const secret of [f.saved().privateKey, f.meta().completionCode, f.meta().nonce, ticket.receipt]) expect(JSON.stringify(pending)).not.toContain(secret);
    expect(f.posts).toHaveLength(1); expect(f.posts[0]!.body).toEqual({ handoffCode: expect.stringMatching(/^interego-link:v1:/), did: f.initial.identity!.did });
    await expect(f.service.approve(ticket.id, 'WRONG')).rejects.toThrow('Compare'); expect(f.posts).toHaveLength(1);
    await f.service.approve(ticket.id, ticket.verificationCode); expect(f.posts).toHaveLength(2);
    const proof = f.posts[1]!.body;
    expect(f.posts[1]!.url).toBe(provider + '/local-identity/link/complete');
    expect(Object.keys(proof).sort()).toEqual(['completionCode', 'did', 'nonce', 'signature']);
    const publicKey = createPublicKey({ key: Buffer.from(f.saved().publicKey, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(f.meta().message), publicKey, Buffer.from(String(proof['signature']), 'base64url'))).toBe(true);
    expect(verify(null, Buffer.from(`Interego DID sign-in v1\nHost: identity.example.com\nNonce: ${f.meta().nonce}`), publicKey, Buffer.from(String(proof['signature']), 'base64url'))).toBe(false);
    expect(() => f.service.poll(ticket.id, ticket.receipt, 'foreign-channel')).toThrow('verified');
    const receipt = f.service.poll(ticket.id, ticket.receipt, 'same-native-browser');
    expect(receipt).toEqual({ state: 'linked', identityOrigin: provider, owner: account, credentialDid: f.initial.identity!.did });
    expect(JSON.stringify(receipt)).not.toMatch(/signature|completionCode|token|redirect/);
    expect(f.service.poll(ticket.id, ticket.receipt, 'same-native-browser')).toEqual({ state: 'expired' });
    expect((await f.service.status()).identity).toEqual(f.initial.identity);
    expect(f.posts.every(post => !post.url.includes('/auth/did') && !post.url.includes('/oauth/'))).toBe(true);
  });

  it('refuses browser-supplied owners, untrusted providers, and role-swapped service origins before network access', async () => {
    const f = await fixture();
    for (const input of [{ relayOrigin: 'https://untrusted.example', handoffCode: handoff() }, { relayOrigin: relay, handoffCode: handoff() },
      { relayOrigin: provider, handoffCode: handoff(), userId: account.userId }, { relayOrigin: provider, handoffCode: 'interego-login:v1:' + opaque() + '.' + opaque() }]) {
      await expect(f.service.request(input, 'browser')).rejects.toThrow('verified');
    }
    expect(f.posts).toEqual([]);
  });

  it.each([
    (v: LocalIdentityLinkContext) => ({ ...v, credentialDid: 'did:key:zForeignKey' }),
    (v: LocalIdentityLinkContext) => ({ ...v, owner: { ...v.owner, did: 'did:web:identity.example.com:users:someone-else' } }),
    (v: LocalIdentityLinkContext) => ({ ...v, owner: { ...v.owner, webId: 'https://other.example/profile#me' } }),
    (v: LocalIdentityLinkContext) => ({ ...v, owner: { ...v.owner, podUrl: 'https://store.example.com/another-user/' } }),
    (v: LocalIdentityLinkContext) => ({ ...v, message: 'Sign in instead of linking' }),
    (v: LocalIdentityLinkContext) => ({ ...v, expiresAt: new Date(now + 600_000).toISOString() }),
    (v: LocalIdentityLinkContext) => ({ ...v, completionCode: 'interego-login-result:v1:' + opaque() + '.' + opaque() }),
    (v: LocalIdentityLinkContext) => ({ ...v, rawOwnerBearer: 'must-never-cross-native-boundary' }),
  ])('rejects substituted metadata or secret-bearing link contexts', async change => {
    const f = await fixture({ change }); await expect(f.request()).rejects.toThrow('could not be prepared');
    expect((await f.service.status()).pending).toEqual([]); expect(f.posts).toHaveLength(1);
  });

  it.each([
    (v: LocalIdentityLinkedReceipt) => ({ ...v, owner: { ...v.owner, podUrl: 'https://another-store.example/' + v.owner.userId + '/' } }),
    (v: LocalIdentityLinkedReceipt) => ({ ...v, owner: { ...v.owner, displayName: 'Substituted target' } }),
    (v: LocalIdentityLinkedReceipt) => ({ ...v, identityOrigin: 'https://another.example' }),
    (v: LocalIdentityLinkedReceipt) => ({ ...v, token: 'never-return-a-login-token' }),
    (v: LocalIdentityLinkedReceipt) => ({ ...v, redirect: 'https://attacker.example' }),
  ])('does not turn an unconfirmed or changed account receipt into success', async complete => {
    const f = await fixture({ complete }); const ticket = await f.request();
    await expect(f.service.approve(ticket.id, ticket.verificationCode)).rejects.toThrow('account link could not be confirmed');
    expect(f.service.poll(ticket.id, ticket.receipt, 'same-native-browser')).toMatchObject({ state: 'failed' }); expect(f.posts).toHaveLength(2);
    await expect(f.service.approve(ticket.id, ticket.verificationCode)).rejects.toThrow('Compare'); expect(f.posts).toHaveLength(2);
  });

  it('denial, browser disconnect, expiry and pod replacement all stop link authority', async () => {
    const f = await fixture(); const denied = await f.request(); f.service.deny(denied.id);
    expect(f.service.poll(denied.id, denied.receipt, 'same-native-browser')).toMatchObject({ state: 'denied' });
    const cancelled = await f.request(); f.service.cancelChannel('same-native-browser'); expect(f.service.poll(cancelled.id, cancelled.receipt, 'same-native-browser')).toEqual({ state: 'expired' });
    const changed = await f.request(); f.binding('different-pod'); await expect(f.service.approve(changed.id, changed.verificationCode)).rejects.toThrow('account link could not be confirmed');
    f.binding('existing-local-pod'); const expired = await f.request(); f.time(now + 120_001);
    await expect(f.service.approve(expired.id, expired.verificationCode)).rejects.toThrow('Compare'); expect(f.posts.every(post => post.url.endsWith('/context'))).toBe(true);
  });

  it('does not revive an abandoned link when its context arrives late', async () => {
    const delayed = deferred<Response>(); let sent: AbortSignal | undefined;
    const f = await fixture({ fetch: vi.fn(async request => { sent = new Request(request).signal; return delayed.promise; }) });
    const pending = f.request('abandoned-browser'); const rejected = expect(pending).rejects.toThrow('could not be prepared');
    while (!sent) await new Promise(resolve => setTimeout(resolve, 0));
    f.service.cancelChannel('abandoned-browser'); await rejected; expect(sent.aborted).toBe(true);
    delayed.resolve(Response.json(context(f.initial.identity!.did))); expect((await f.service.status()).pending).toEqual([]);
  });
});

describe('link transport budget', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('accepts a legitimate link context response after twenty seconds', async () => {
    vi.useFakeTimers(); const f = await fixture(), originalFetch = f.options.fetch;
    f.options.fetch = async request => {
      await new Promise(resolve => setTimeout(resolve, 20_000));
      return originalFetch(request);
    };
    const outcome = f.request().then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await vi.advanceTimersByTimeAsync(20_000); const result = await outcome;
    expect(result.error).toBeUndefined(); expect(result.value?.id).toBeTruthy();
    expect(f.posts).toHaveLength(1); expect(f.posts[0]!.signal.aborted).toBe(false);
    expect((await f.service.status()).pending).toMatchObject([{ purpose: 'link', state: 'waiting', owner: account }]);
  });

  it('confirms a slow link completion only from its exact existing-owner receipt', async () => {
    vi.useFakeTimers(); const f = await fixture(), originalFetch = f.options.fetch;
    f.options.fetch = async request => {
      if (new URL(request instanceof Request ? request.url : String(request)).pathname.endsWith('/complete')) await new Promise(resolve => setTimeout(resolve, 20_000));
      return originalFetch(request);
    };
    const ticket = await f.request();
    const outcome = f.service.approve(ticket.id, ticket.verificationCode).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(20_000); expect(await outcome).toBeUndefined();
    expect(f.posts).toHaveLength(2); expect(f.posts[1]!.signal.aborted).toBe(false);
    expect(f.service.poll(ticket.id, ticket.receipt, 'same-native-browser')).toEqual({ state: 'linked', identityOrigin: provider, owner: account, credentialDid: f.initial.identity!.did });
    expect((await f.service.status()).identity).toEqual(f.initial.identity);
  });

  it('keeps one forty-five-second deadline across response headers and a dripping body', async () => {
    vi.useFakeTimers(); const cancelled = vi.fn(); let sent: AbortSignal | undefined;
    const f = await fixture({ fetch: async request => {
      sent = (request as Request).signal;
      await new Promise(resolve => setTimeout(resolve, 30_000));
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
          setTimeout(() => controller.enqueue(new TextEncoder().encode(' ')), 10_000);
        }, cancel: cancelled,
      }), { headers: { 'content-type': 'application/json' } });
    } });
    const outcome = f.request().then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(44_999); expect(sent?.aborted).toBe(false); expect(cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await outcome).toBeInstanceOf(Error); expect(sent?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce(); expect((await f.service.status()).pending).toEqual([]);
  });

  it('clips completion transport to the existing security expiry without extending the approval', async () => {
    vi.useFakeTimers(); const f = await fixture(); const ticket = await f.request(); f.time(now + 100_000);
    let sent: AbortSignal | undefined; f.options.fetch = async request => { sent = (request as Request).signal; return new Promise<Response>(() => {}); };
    const outcome = f.service.approve(ticket.id, ticket.verificationCode).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(19_999); expect(sent?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(await outcome).toBeInstanceOf(Error); expect(sent?.aborted).toBe(true);
    expect(ticket.expiresAt).toBe(new Date(now + 120_000).toISOString());
    expect(f.service.poll(ticket.id, ticket.receipt, 'same-native-browser')).toMatchObject({ state: 'failed' });
  });

  it('reports a committed registration with a lost reply as unconfirmed and never retries it', async () => {
    vi.useFakeTimers(); const f = await fixture(); const ticket = await f.request();
    let committed: string | undefined; let attempts = 0; let sent: AbortSignal | undefined; const late = deferred<Response>();
    f.options.fetch = async request => {
      const req = request as Request; sent = req.signal; const proof = JSON.parse(await req.text()) as Record<string, unknown>;
      attempts++; committed = String(proof['did']); return late.promise;
    };
    const outcome = f.service.approve(ticket.id, ticket.verificationCode).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(44_999); expect(committed).toBe(f.initial.identity!.did); expect(sent?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect((await outcome as Error).message).toContain('Check your registered credentials');
    expect(sent?.aborted).toBe(true); expect(attempts).toBe(1);
    expect(f.service.poll(ticket.id, ticket.receipt, 'same-native-browser')).toMatchObject({ state: 'failed' });
    const cancelled = vi.fn(); late.resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } }));
    await vi.advanceTimersByTimeAsync(0); expect(cancelled).toHaveBeenCalledOnce();
    await expect(f.service.approve(ticket.id, ticket.verificationCode)).rejects.toThrow('Compare'); expect(attempts).toBe(1);
    expect(f.service.poll(ticket.id, ticket.receipt, 'same-native-browser')).toEqual({ state: 'expired' });
    expect((await f.service.status()).identity).toEqual(f.initial.identity);
  });

  it('cancels a completion promptly and cannot accept its late valid receipt', async () => {
    vi.useFakeTimers(); const f = await fixture(); const ticket = await f.request(); const originalFetch = f.options.fetch;
    const late = deferred<Response>(); let sent: AbortSignal | undefined;
    f.options.fetch = async request => { sent = (request as Request).signal; await late.promise; return originalFetch(request); };
    const outcome = f.service.approve(ticket.id, ticket.verificationCode).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(1); f.service.cancelChannel('same-native-browser'); expect(await outcome).toBeInstanceOf(Error);
    expect(sent?.aborted).toBe(true); late.resolve(Response.json({})); await vi.advanceTimersByTimeAsync(0);
    expect(f.service.poll(ticket.id, ticket.receipt, 'same-native-browser')).toEqual({ state: 'expired' });
    expect((await f.service.status()).pending).toEqual([]);
  });

  it('passes the link budget to the real HTTP socket while keeping the OAuth socket bound', async () => {
    const server = createServer((request, response) => {
      request.resume(); request.once('end', () => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
    const origin = 'http://127.0.0.1:' + address.port; const timeouts = vi.spyOn(ClientRequest.prototype, 'setTimeout');
    try {
      const f = await fixture(); const service = new LocalIdentityService({ ...f.options, fetch: undefined, allowLoopbackForTests: true,
        trustedRelays: [{ relayOrigin: origin, identityOrigin: origin }] });
      // Both responses are deliberately invalid metadata; the real transport must still use each operation's correct bound.
      await expect(service.request({ relayOrigin: origin, handoffCode: handoff() }, 'link-http')).rejects.toThrow('could not be prepared');
      await expect(service.request({ relayOrigin: origin, handoffCode: 'interego-login:v1:' + opaque() + '.' + opaque() }, 'signin-http')).rejects.toThrow('could not be prepared');
      expect(timeouts.mock.calls.map(call => call[0])).toEqual([45_000, 12_000]);
    } finally { await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }); }
  });
});
