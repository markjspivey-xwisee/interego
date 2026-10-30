import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
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
