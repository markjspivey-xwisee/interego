import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, createPublicKey, pbkdf2Sync, randomBytes, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalIdentityService, ProtectedLocalIdentityStore, type LocalIdentityServiceOptions } from '../src/local-identity.js';
import { identityHash, newLocalIdentity, type LocalIdentitySaved } from '../src/local-identity-protocol.js';
import type { LocalIdentityContext, LocalIdentityStore } from '../src/local-identity-types.js';
import { identityPublicAddress } from '../src/local-identity-network.js';

const relay = 'https://relay.example.com';
const provider = 'https://identity.example.com';
const callback = 'https://client.example.com/callback';
const freshToken = () => randomBytes(32).toString('base64url');
const code = 'interego-login:v1:' + freshToken() + '.' + freshToken();
const now = Date.parse('2026-10-30T12:00:00Z');
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-local-identity-')) await rm(directory, { recursive: true, force: true });
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const backupPassphrase = 'an owner controlled recovery phrase';
function rewriteBackup(bytes: Uint8Array, change: (payload: Record<string, unknown>) => void): Uint8Array {
  const wrapper = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, string>;
  const key = pbkdf2Sync(backupPassphrase, Buffer.from(wrapper['salt']!, 'base64'), 600_000, 32, 'sha256');
  const aad = Buffer.from('interego-local-identity-backup:v1:PBKDF2-SHA256:600000:AES-256-GCM');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrapper['iv']!, 'base64')); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(wrapper['tag']!, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(wrapper['ciphertext']!, 'base64')), decipher.final()]);
  const payload = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>; change(payload);
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
  wrapper['ciphertext'] = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]).toString('base64');
  wrapper['tag'] = cipher.getAuthTag().toString('base64'); wrapper['iv'] = iv.toString('base64'); key.fill(0); plaintext.fill(0);
  return Buffer.from(JSON.stringify(wrapper));
}
function context(): LocalIdentityContext {
  const nonce = freshToken();
  return { version: 1, issuer: relay, identityOrigin: provider, pendingId: 'pending-authorization-0123456789', clientId: 'registered-client', clientName: 'My website',
    redirectUri: callback, scopes: ['mcp:read'], resource: relay + '/mcp', codeChallenge: freshToken(), stateDigest: identityHash('original-oauth-state'),
    expiresAt: new Date(now + 600_000).toISOString(), nonce, message: `Interego DID sign-in v1\nHost: identity.example.com\nNonce: ${nonce}`, challengeExpiresAt: new Date(now + 300_000).toISOString(),
    completionCode: 'interego-login-result:v1:' + freshToken() + '.' + freshToken() };
}
async function fixture(input: { context?: (value: LocalIdentityContext) => unknown; fetch?: typeof fetch; store?: LocalIdentityStore } = {}) {
  let saved: unknown | null = null; let binding: string | null = 'this-local-pod'; let clock = now;
  const store = input.store ?? { load: vi.fn(async () => structuredClone(saved)), save: vi.fn(async value => { saved = structuredClone(value); }) };
  const meta = context(); const posts: Array<{ url: string; body: Record<string, unknown>; signal: AbortSignal }> = [];
  const fetcher: typeof fetch = input.fetch ?? (async (request, init) => {
    const req = new Request(request, init); const body = JSON.parse(await req.text()) as Record<string, unknown>; posts.push({ url: req.url, body, signal: req.signal });
    if (new URL(req.url).pathname === '/oauth/local-identity/context') return Response.json(input.context ? input.context(meta) : meta);
    if (new URL(req.url).pathname === '/oauth/verify') return Response.json({ redirect: callback + '?code=short-lived-code&state=original-oauth-state' });
    throw new Error('Unexpected endpoint.');
  });
  const options: LocalIdentityServiceOptions = { store, binding: async () => binding, trustedRelays: [{ relayOrigin: relay, identityOrigin: provider }], fetch: fetcher, now: () => clock };
  const service = new LocalIdentityService(options);
  return { service, options, store, meta, posts, saved: () => saved as LocalIdentitySaved,
    binding: (value: string | null) => { binding = value; }, time: (value: number) => { clock = value; },
    request: (channel = 'native-channel-a') => service.request({ relayOrigin: relay, handoffCode: code }, channel) };
}

describe('native-held identity sign-in', () => {
  it('creates a separate native credential only after owner setup, persists its public DID, and returns no keys or proof', async () => {
    const f = await fixture(); expect(await f.service.status()).toEqual({ configured: false, pending: [] });
    await expect(f.request()).rejects.toThrow('Create a local sign-in identity'); expect(f.posts).toEqual([]);
    const first = await f.service.setup(); expect(first.identity?.did).toMatch(/^did:key:z6Mk/); expect(first.configured).toBe(true);
    const reopened = new LocalIdentityService(f.options); expect(await reopened.status()).toEqual(first);
    const ticket = await f.request(); const status = await f.service.status();
    expect(status.pending).toMatchObject([{ id: ticket.id, state: 'waiting', relayOrigin: relay, identityOrigin: provider, clientName: 'My website', redirectOrigin: 'https://client.example.com', scopes: ['mcp:read'] }]);
    for (const secret of [f.saved().privateKey, f.meta.completionCode, f.meta.nonce, ticket.receipt]) expect(JSON.stringify(status)).not.toContain(secret);
    expect(f.posts).toHaveLength(1); expect(f.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toEqual({ state: 'waiting' });
  });
  it('signs the exact provider challenge only after native comparison, completes only its relay, and returns the redirect once to its channel', async () => {
    const f = await fixture(); await f.service.setup(); const ticket = await f.request();
    await expect(f.service.approve(ticket.id, 'WRONG CODE')).rejects.toThrow('Compare'); expect(f.posts).toHaveLength(1);
    await f.service.approve(ticket.id, ticket.verificationCode);
    expect(f.posts).toHaveLength(2); expect(f.posts[1]!.url).toBe(relay + '/oauth/verify');
    const proof = f.posts[1]!.body;
    expect(Object.keys(proof).sort()).toEqual(['did', 'method', 'native_handoff', 'nonce', 'pending_id', 'signature']);
    expect(proof).toMatchObject({ did: (await f.service.status()).identity!.did, method: 'did', native_handoff: f.meta.completionCode, nonce: f.meta.nonce, pending_id: f.meta.pendingId });
    const publicKey = createPublicKey({ key: Buffer.from(f.saved().publicKey, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(f.meta.message), publicKey, Buffer.from(String(proof['signature']), 'base64url'))).toBe(true);
    expect(() => f.service.poll(ticket.id, ticket.receipt, 'other-channel')).toThrow('verified');
    const result = f.service.poll(ticket.id, ticket.receipt, 'native-channel-a');
    expect(result).toEqual({ state: 'complete', redirect: callback + '?code=short-lived-code&state=original-oauth-state' });
    expect(JSON.stringify(result)).not.toContain(String(proof['signature'])); expect(JSON.stringify(result)).not.toContain(f.meta.completionCode);
    expect(f.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toEqual({ state: 'expired' });
    await expect(f.service.approve(ticket.id, ticket.verificationCode)).rejects.toThrow(); expect(f.posts).toHaveLength(2);
  });
  it.each([
    (value: LocalIdentityContext) => ({ ...value, issuer: 'https://other-relay.example' }),
    (value: LocalIdentityContext) => ({ ...value, identityOrigin: 'https://other-provider.example' }),
    (value: LocalIdentityContext) => ({ ...value, message: value.nonce }),
    (value: LocalIdentityContext) => ({ ...value, message: value.message.replace('identity.example.com', 'evil.example.com') }),
    (value: LocalIdentityContext) => ({ ...value, message: value.message.replaceAll('\n', '\r\n') }),
    (value: LocalIdentityContext) => ({ ...value, challengeExpiresAt: new Date(now - 1).toISOString() }),
    (value: LocalIdentityContext) => ({ ...value, redirectUri: 'javascript:alert(1)' }),
    (value: LocalIdentityContext) => ({ ...value, codeChallenge: 'not-pkce' }),
  ])('refuses untrusted, malformed or legacy challenge context before any signature (%#)', async change => {
    const f = await fixture({ context: change }); await f.service.setup(); await expect(f.request()).rejects.toThrow('could not be prepared');
    expect(f.posts).toHaveLength(1); expect((await f.service.status()).pending).toEqual([]);
  });
  it('allows native denial and requires the same receipt and channel for browser cancellation', async () => {
    const f = await fixture(); await f.service.setup(); const ticket = await f.request();
    expect(() => f.service.poll(ticket.id, freshToken(), 'native-channel-a')).toThrow();
    expect(() => f.service.cancel(ticket.id, ticket.receipt, 'other-channel')).toThrow();
    f.service.deny(ticket.id); expect(f.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toMatchObject({ state: 'denied' });
    expect(f.posts).toHaveLength(1);
  });
  it('cancels a delayed metadata read when its native channel closes and never restores the request', async () => {
    const response = deferred<Response>(); const entered = deferred<void>();
    const f = await fixture({ fetch: async () => { entered.resolve(); return response.promise; } }); await f.service.setup();
    const request = f.request(); const rejected = expect(request).rejects.toThrow('could not be prepared');
    await entered.promise; f.service.cancelChannel('native-channel-a'); await rejected;
    response.resolve(Response.json(f.meta)); await Promise.resolve();
    expect((await f.service.status()).pending).toEqual([]);
  });
  it('cancels a native channel even while the first private key read is pending', async () => {
    const original = await fixture(); await original.service.setup(); const read = deferred<unknown>();
    const f = await fixture({ store: { load: async () => read.promise, save: async () => {} } });
    const request = f.request(); const rejected = expect(request).rejects.toThrow('could not be prepared');
    f.service.cancelChannel('native-channel-a'); await rejected; read.resolve(original.saved()); await Promise.resolve(); expect(f.posts).toEqual([]);
  });
  it('stops an approved request during a noncooperating completion fetch, without exposing its eventual redirect', async () => {
    const completion = deferred<Response>(); const entered = deferred<void>(); let meta = context();
    const f = await fixture({ fetch: async (request, init) => {
      const req = new Request(request, init);
      if (new URL(req.url).pathname.endsWith('/context')) return Response.json(meta);
      entered.resolve(); return completion.promise;
    } }); meta = f.meta; await f.service.setup(); const ticket = await f.request();
    const approval = f.service.approve(ticket.id, ticket.verificationCode); const rejected = expect(approval).rejects.toThrow('could not be confirmed');
    await entered.promise; f.service.stop(); await rejected;
    completion.resolve(Response.json({ redirect: callback + '?code=late-code&state=original-oauth-state' })); await Promise.resolve();
    expect(f.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toEqual({ state: 'expired' });
  });
  it.each(['https://other.example/callback?code=x&state=original-oauth-state', callback + '?code=x&state=wrong', callback + '?code=x&code=y&state=original-oauth-state'])('refuses an altered completion callback %s', async redirect => {
    let meta = context(); const f = await fixture({ fetch: async (request, init) => new URL(new Request(request, init).url).pathname.endsWith('/context') ? Response.json(meta) : Response.json({ redirect }) });
    meta = f.meta; await f.service.setup(); const ticket = await f.request();
    await expect(f.service.approve(ticket.id, ticket.verificationCode)).rejects.toThrow('could not be confirmed');
    expect(f.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toMatchObject({ state: 'failed' });
  });
  it('expires approvals and rejects a pod change or key reset while preserving unrelated storage', async () => {
    const f = await fixture(); await f.service.setup(); const ticket = await f.request(); f.time(now + 300_001);
    expect(f.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toEqual({ state: 'expired' });
    f.time(now); const next = await f.request(); f.binding('different-pod');
    await expect(f.service.approve(next.id, next.verificationCode)).rejects.toThrow('could not be confirmed');
    await expect(f.service.status()).rejects.toThrow('another local pod');
    expect(await f.service.forget()).toEqual({ configured: false, pending: [] }); expect(f.saved()).toBeNull();
  });
  it('does not generate identity keys on a failed durable setup and can forget corrupt stored state', async () => {
    const broken = await fixture({ store: { load: async () => null, save: async () => { throw new Error('disk unavailable'); } } });
    await expect(broken.service.setup()).rejects.toThrow('disk unavailable'); expect(await broken.service.status()).toEqual({ configured: false, pending: [] });
    let data: unknown = { damaged: true };
    const f = await fixture({ store: { load: async () => data, save: async value => { data = value; } } });
    await expect(f.service.status()).rejects.toThrow('saved sign-in identity');
    expect(await f.service.forget()).toEqual({ configured: false, pending: [] }); expect(data).toBeNull();
  });
  it('does not admit a new request while a native reset is waiting for its private tombstone', async () => {
    const gate = deferred<void>(); const entered = deferred<void>(); let data: unknown | null = null;
    const f = await fixture({ store: { load: async () => data, save: async value => {
      if (value === null) { entered.resolve(); await gate.promise; } data = value;
    } } });
    await f.service.setup(); const ticket = await f.request(); const reset = f.service.forget(); await entered.promise;
    await expect(f.request()).rejects.toThrow('changing');
    gate.resolve(); expect(await reset).toEqual({ configured: false, pending: [] });
    expect(f.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toEqual({ state: 'expired' });
    expect(f.posts).toHaveLength(1);
  });
  it('times out a noncooperating metadata transport and cancels a late body', async () => {
    vi.useFakeTimers(); const response = deferred<Response>(); const entered = deferred<void>(); const cancelled = vi.fn();
    const f = await fixture({ fetch: async () => { entered.resolve(); return response.promise; } }); await f.service.setup();
    const request = f.request(); const refused = expect(request).rejects.toThrow('could not be prepared'); await entered.promise;
    await vi.advanceTimersByTimeAsync(15_001); await refused;
    response.resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'application/json' } }));
    await Promise.resolve(); await Promise.resolve(); expect(cancelled).toHaveBeenCalledOnce();
    expect((await f.service.status()).pending).toEqual([]);
  });
  it('bounds chunked metadata before allocation and refuses redirects without signing', async () => {
    const cancelled = vi.fn(); let count = 0;
    const f = await fixture({ fetch: async () => new Response(new ReadableStream({
      pull(controller) { count++; if (count <= 10) controller.enqueue(new Uint8Array(32 * 1024)); else controller.close(); }, cancel: cancelled,
    }), { headers: { 'content-type': 'application/json' } }) });
    await f.service.setup(); await expect(f.request()).rejects.toThrow('could not be prepared');
    expect(cancelled).toHaveBeenCalledOnce(); expect(count).toBeLessThan(10); expect((await f.service.status()).pending).toEqual([]);
    const redirect = await fixture({ fetch: async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } }) });
    await redirect.service.setup(); await expect(redirect.request()).rejects.toThrow('could not be prepared');
  });
  it('bounds concurrent starts before asynchronous key loading and admits no unknown trust pair', async () => {
    const f = await fixture(); await f.service.setup();
    await expect(f.service.request({ relayOrigin: 'https://other.example', handoffCode: code }, 'channel')).rejects.toThrow('verified'); expect(f.posts).toEqual([]);
    for (let index = 0; index < 8; index++) await f.request('channel-' + index);
    await expect(f.request('ninth-channel')).rejects.toThrow('Finish or cancel'); expect(f.posts).toHaveLength(8);
    f.service.cancelChannel('channel-0'); await f.request('new-channel'); expect(f.posts).toHaveLength(9);
  });
  it('protects the private identity file, refuses corruption and writes an explicit tombstone', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interego-local-identity-')); directories.push(directory);
    const protector = { protect: (value: string) => Buffer.from(value).toString('base64'), unprotect: (value: string) => Buffer.from(value, 'base64').toString() };
    const store = new ProtectedLocalIdentityStore({ dataDir: directory, protector }); const f = await fixture({ store }); await f.service.setup();
    const saved = await store.load() as LocalIdentitySaved; const file = await readFile(join(directory, 'identity-key.json'), 'utf8'); expect(file).not.toContain(saved.privateKey);
    await writeFile(join(directory, 'identity-key.json'), 'broken'); await expect(store.load()).rejects.toThrow('saved sign-in identity');
    await store.save(null); expect(await store.load()).toBeNull();
  });
  it('rejects private, mapped and reserved DNS addresses for the production authentication transport', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.2', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1']) expect(identityPublicAddress(ip)).toBe(false);
    expect(identityPublicAddress('8.8.8.8')).toBe(true);
  });
  it('backs up an encrypted owner credential, cancels pending login, and restores the same DID onto a chosen pod across restarts', async () => {
    const original = await fixture(); const status = await original.service.setup(); const ticket = await original.request();
    const bytes = await original.service.exportBackup(backupPassphrase); const text = Buffer.from(bytes).toString('utf8');
    expect(text).not.toContain(original.saved().privateKey); expect(text).not.toContain(status.identity!.did); expect(text).not.toContain('this-local-pod');
    expect(JSON.parse(text)).toMatchObject({ format: 'interego-local-identity-backup', version: 1, kdf: 'PBKDF2-SHA256', iterations: 600_000, cipher: 'AES-256-GCM' });
    expect(original.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toEqual({ state: 'expired' }); expect(original.posts).toHaveLength(1);
    original.binding(null); await expect(original.service.status()).rejects.toThrow('another local pod');
    const recovery = await original.service.exportBackup(backupPassphrase); expect(recovery).not.toEqual(bytes);
    const directory = await mkdtemp(join(tmpdir(), 'interego-local-identity-')); directories.push(directory);
    const protector = { protect: (value: string) => Buffer.from(value).toString('base64'), unprotect: (value: string) => Buffer.from(value, 'base64').toString() };
    const target = await fixture({ store: new ProtectedLocalIdentityStore({ dataDir: directory, protector }) }); target.binding('replacement-pod');
    expect(await target.service.restoreBackup(recovery, backupPassphrase)).toEqual(status);
    expect((await target.store.load() as LocalIdentitySaved).binding).toBe('replacement-pod');
    const reopened = new LocalIdentityService(target.options); expect(await reopened.status()).toEqual(status);
    const next = await reopened.request({ relayOrigin: relay, handoffCode: code }, 'restored-channel'); await reopened.approve(next.id, next.verificationCode);
    const publicKey = createPublicKey({ key: Buffer.from(original.saved().publicKey, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(target.meta.message), publicKey, Buffer.from(String(target.posts[1]!.body['signature']), 'base64url'))).toBe(true);
    expect(reopened.poll(next.id, next.receipt, 'restored-channel')).toMatchObject({ state: 'complete' });
  });
  it('refuses wrong passphrases, tampering, malformed metadata and oversized identity backups without creating a credential', async () => {
    const source = await fixture(); await source.service.setup(); const backup = await source.service.exportBackup(backupPassphrase);
    const target = await fixture(); await expect(target.service.restoreBackup(backup, 'a different owner passphrase')).rejects.toThrow('could not be unlocked');
    const wrapper = JSON.parse(Buffer.from(backup).toString('utf8')) as Record<string, unknown>;
    const tag = Buffer.from(String(wrapper['tag']), 'base64'); tag[0] = tag[0]! ^ 1;
    for (const bytes of [Buffer.from(JSON.stringify({ ...wrapper, tag: tag.toString('base64') })), Buffer.from(JSON.stringify({ ...wrapper, iterations: 1 })),
      Buffer.from(JSON.stringify({ ...wrapper, salt: String(wrapper['salt']) + '=' })), new Uint8Array(32 * 1024 + 1), new Uint8Array()]) {
      await expect(target.service.restoreBackup(bytes, backupPassphrase)).rejects.toThrow('could not be unlocked');
      expect(await target.service.status()).toEqual({ configured: false, pending: [] }); expect(target.saved()).toBeNull();
    }
    expect(() => source.service.exportBackup('short')).toThrow('passphrase'); expect(() => target.service.restoreBackup(backup, 'short')).toThrow('passphrase');
  });
  it('validates a decrypted backup DID and Ed25519 public/private coherence before any restore write', async () => {
    const source = await fixture(); await source.service.setup(); const backup = await source.service.exportBackup(backupPassphrase); const target = await fixture();
    const differentKey = newLocalIdentity('different-pod', now);
    for (const mutate of [(payload: Record<string, unknown>) => { payload['did'] = 'did:key:z6MkIncorrectDID'; },
      (payload: Record<string, unknown>) => { (payload['identity'] as Record<string, unknown>)['publicKey'] = differentKey.publicKey; }]) {
      await expect(target.service.restoreBackup(rewriteBackup(backup, mutate), backupPassphrase)).rejects.toThrow('could not be unlocked');
      expect(target.saved()).toBeNull(); expect(await target.service.status()).toEqual({ configured: false, pending: [] });
    }
  });
  it('refuses to overwrite an existing credential or restore before a local pod has been selected', async () => {
    const source = await fixture(); await source.service.setup(); const backup = await source.service.exportBackup(backupPassphrase);
    const target = await fixture(); const existing = await target.service.setup(); const key = target.saved().privateKey; const ticket = await target.request();
    await expect(target.service.restoreBackup(backup, backupPassphrase)).rejects.toThrow('has not been overwritten');
    expect(await target.service.status()).toEqual(existing); expect(target.saved().privateKey).toBe(key);
    expect(target.service.poll(ticket.id, ticket.receipt, 'native-channel-a')).toEqual({ state: 'expired' });
    const empty = await fixture(); empty.binding(null); await expect(empty.service.restoreBackup(backup, backupPassphrase)).rejects.toThrow('Set up your local pod'); expect(empty.saved()).toBeNull();
  });
  it('blocks setup, restore and login races during native recovery, and a stop cancels before any identity commit', async () => {
    const source = await fixture(); await source.service.setup(); const backup = await source.service.exportBackup(backupPassphrase);
    const read = deferred<null>(); const entered = deferred<void>(); const save = vi.fn(async () => {});
    const target = await fixture({ store: { load: async () => { entered.resolve(); return read.promise; }, save } });
    const restore = target.service.restoreBackup(backup, backupPassphrase); const refused = expect(restore).rejects.toThrow('stopped'); await entered.promise;
    await expect(target.service.setup()).rejects.toThrow('changing'); await expect(target.request()).rejects.toThrow('changing');
    await expect(target.service.restoreBackup(backup, backupPassphrase)).rejects.toThrow('changing'); await expect(target.service.forget()).rejects.toThrow('changing');
    target.service.stop(); read.resolve(null); await refused; expect(save).not.toHaveBeenCalled(); expect(await target.service.status()).toEqual({ configured: false, pending: [] });
  });
  it('refuses a pod switch while recovery is waiting for key derivation and preserves a failed durable restore for retry', async () => {
    const source = await fixture(); await source.service.setup(); const backup = await source.service.exportBackup(backupPassphrase);
    const target = await fixture(); let reads = 0;
    const switching = new LocalIdentityService({ ...target.options, binding: async () => ++reads === 1 ? 'chosen-pod' : 'another-pod' });
    await expect(switching.restoreBackup(backup, backupPassphrase)).rejects.toThrow('stopped'); expect(target.saved()).toBeNull();
    let fail = true; let stored: unknown = null;
    const broken = await fixture({ store: { load: async () => stored, save: async value => { if (fail) throw new Error('disk unavailable'); stored = value; } } });
    await expect(broken.service.restoreBackup(backup, backupPassphrase)).rejects.toThrow('disk unavailable'); expect(await broken.service.status()).toEqual({ configured: false, pending: [] });
    fail = false; expect((await broken.service.restoreBackup(backup, backupPassphrase)).identity).toEqual((await source.service.status()).identity);
  });
  it('serializes an earlier setup with restore without generating or overwriting a credential in the race', async () => {
    const source = await fixture(); const original = await source.service.setup(); const backup = await source.service.exportBackup(backupPassphrase);
    const read = deferred<null>(); const entered = deferred<void>(); let data: unknown = null; let reads = 0; const writes: unknown[] = [];
    const target = await fixture({ store: { load: async () => { if (++reads === 1) { entered.resolve(); return read.promise; } return data; },
      save: async value => { data = value; writes.push(value); } } });
    const setup = target.service.setup(); const stopped = expect(setup).rejects.toThrow('stopped'); await entered.promise;
    const restore = target.service.restoreBackup(backup, backupPassphrase); read.resolve(null); await stopped;
    expect(await restore).toEqual(original); expect(writes).toHaveLength(1); expect((writes[0] as LocalIdentitySaved).publicKey).toBe(source.saved().publicKey);
  });
});
