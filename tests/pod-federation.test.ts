import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { FederationService, ProtectedFederationStore, type FederationStore, type FederationResource } from '../packages/pod-federation/src/index.js';
import { publicAddress } from '../packages/pod-federation/src/network.js';
import { createIdentity, packet, profileFor } from '../packages/pod-federation/src/protocol.js';
import type { FederationSavedState } from '../packages/pod-federation/src/types.js';

class MemoryStore implements FederationStore {
  value: unknown | null = null;
  saves = 0;
  fail = false;
  async load(): Promise<unknown | null> { return structuredClone(this.value); }
  async save(value: unknown | null): Promise<void> { if (this.fail) throw new Error('fixture durable storage failure'); this.value = structuredClone(value); this.saves++; }
}
function fixture(kind: 'local' | 'hosted' = 'local') {
  const stores = [new MemoryStore(), new MemoryStore()];
  let now = Date.now(); const seen: Request[] = []; let intercept: ((request: Request) => Promise<Response> | undefined) | undefined;
  let bBinding: (() => Promise<string | null>) | undefined;
  const services = new Map<string, FederationService>();
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init); seen.push(request.clone());
    const overridden = intercept?.(request); if (overridden) return overridden;
    const target = services.get(new URL(request.url).origin); if (!target) throw new Error('No fixture peer.');
    return target.handle(request);
  };
  const a = new FederationService({ store: stores[0]!, binding: async () => 'pod-a', now: () => now, fetch: transport });
  const b = new FederationService({ store: stores[1]!, binding: () => bBinding ? bBinding() : Promise.resolve('pod-b'), now: () => now, fetch: transport });
  services.set('https://alice.example.com', a); services.set('https://bob.example.com', b);
  return { a, b, stores, seen, setIntercept: (value: typeof intercept) => { intercept = value; }, setBbinding: (value: typeof bBinding) => { bBinding = value; }, advance: (ms: number) => { now += ms; }, transport, now: () => now,
    async setup() { await a.configure({ name: 'Alice', endpoint: 'https://alice.example.com/pod-federation', kind: 'local' }); await b.configure({ name: 'Bob', endpoint: 'https://bob.example.com/pod-federation', kind }); await a.setEnabled(true); await b.setEnabled(true); },
    async pair() { const invite = await a.createInvite(); await b.acceptInvite(invite.code); const pending = (await a.status()).pending[0]!; await a.approve(pending.id, pending.verificationCode); await b.refresh(); return { aid: (await a.status()).profile!.id, bid: (await b.status()).profile!.id }; } };
}
const note: FederationResource = { iri: 'urn:graph:pod-note:12345678-1234-4123-8123-123456789abc', mediaType: 'text/turtle', content: '<urn:note:original> <http://www.w3.org/1999/02/22-rdf-syntax-ns#value> "A private shared note" .' };

describe('opt-in encrypted pod federation', () => {
  it('starts off, only configures through owner API, and exposes no storage or management public route', async () => {
    const f = fixture(); expect((await f.a.status()).enabled).toBe(false);
    await expect(f.a.createInvite()).rejects.toThrow('paused');
    expect((await f.a.handle(new Request('https://alice.example.com/pod-federation/profile'))).status).toBe(503);
    await f.setup();
    for (const path of ['owner/enable', 'notes', '../store', 'profile?target=https://evil.example.com']) expect((await f.a.handle(new Request('https://alice.example.com/pod-federation/' + path))).status).toBe(404);
    expect(f.seen).toHaveLength(0);
  });
  it.each(['local', 'hosted'] as const)('requires invite acceptance and inviter comparison before %s sharing', async kind => {
    const f = fixture(kind); await f.setup(); const invite = await f.a.createInvite();
    await f.b.acceptInvite(invite.code); const a = await f.a.status(); const b = await f.b.status();
    expect(a.peers).toHaveLength(0); expect(a.pending[0]!.verificationCode).toBe(b.joining[0]!.verificationCode);
    await expect(f.a.share(b.profile!.id, [note])).rejects.toThrow('approved');
    await expect(f.a.approve(a.pending[0]!.id, '0000 0000')).rejects.toThrow('code');
    await f.a.approve(a.pending[0]!.id, a.pending[0]!.verificationCode); await f.b.refresh();
    expect((await f.a.status()).peers[0]!.id).toBe(b.profile!.id); expect((await f.b.status()).peers[0]!.id).toBe(a.profile!.id);
  });
  it('delivers only explicitly selected exact representations using recipient encryption', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair();
    await f.a.share(bid, [note]); const status = await f.b.status(); const received = status.received[0]!;
    expect(await f.b.received(received.id)).toEqual(note); expect(status.received).toHaveLength(1);
    const network = await f.seen.find(request => request.url.endsWith('/inbox'))!.text();
    expect(network).not.toContain('A private shared note'); expect(network).not.toContain(note.content); expect(network).not.toContain('secretKey');
    expect(JSON.stringify(f.stores[1]!.value)).not.toContain('A private shared note');
  });
  it('retains protected identity, approved peers and local received copies across service restart, while transport stays off', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair(); await f.a.share(bid, [note]);
    const before = await f.b.status(); const fresh = new FederationService({ store: f.stores[1]!, binding: async () => 'pod-b', fetch: f.transport });
    expect((await fresh.status()).enabled).toBe(false); expect((await fresh.status()).profile).toEqual(before.profile);
    expect((await fresh.status()).peers).toEqual(before.peers); expect(await fresh.received(before.received[0]!.id)).toEqual(note);
    expect((await fresh.handle(new Request('https://bob.example.com/pod-federation/profile'))).status).toBe(503);
  });
  it('consumes invitations once, rejects expired invitations without fetching, and accepts no forged identity', async () => {
    const f = fixture(); await f.setup(); const invite = await f.a.createInvite(); await f.b.acceptInvite(invite.code);
    const joined = f.seen[0]!.clone(); expect((await f.a.handle(joined)).status).toBe(403);
    const expired = await f.a.createInvite(); f.advance(16 * 60_000); const count = f.seen.length;
    await expect(f.b.acceptInvite(expired.code)).rejects.toThrow(); expect(f.seen).toHaveLength(count);
    const raw = JSON.parse(Buffer.from(invite.code.split(':v1:')[1]!, 'base64url').toString()); raw.payload.profile.name = 'Mallory';
    await expect(f.b.acceptInvite('interego-invite:v1:' + Buffer.from(JSON.stringify(raw)).toString('base64url'))).rejects.toThrow();
  });
  it('rejects replay and altered signed ciphertext, and persists replay protection before acknowledging', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair(); await f.a.share(bid, [note]);
    const original = f.seen.find(request => request.url.endsWith('/inbox'))!;
    expect((await f.b.handle(original.clone())).status).toBe(403);
    const raw = await original.clone().json(); raw.payload.envelope.content.ciphertext = 'A'.repeat(64);
    const altered = new Request(original.url, { method: 'POST', body: JSON.stringify(raw), headers: { 'content-type': 'application/json' } });
    expect((await f.b.handle(altered)).status).toBe(403); expect((await f.b.status()).received).toHaveLength(1);
    const fresh = new FederationService({ store: f.stores[1]!, binding: async () => 'pod-b', now: f.now }); await fresh.setEnabled(true);
    expect((await fresh.handle(original.clone())).status).toBe(403);
  });
  it('revocation blocks future inbound transfers while retained copies remain readable', async () => {
    const f = fixture(); await f.setup(); const { aid, bid } = await f.pair(); await f.a.share(bid, [note]);
    const id = (await f.b.status()).received[0]!.id; await f.b.revoke(aid);
    await expect(f.a.share(bid, [note])).rejects.toThrow('unavailable'); expect(await f.b.received(id)).toEqual(note);
    await f.b.setEnabled(false); expect(await f.b.received(id)).toEqual(note);
  });
  it('aborts a noncooperating outbound host transport and rejects queued delivery after Pause', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair(); let started!: () => void; const active = new Promise<void>(resolve => { started = resolve; });
    f.setIntercept(request => request.url.endsWith('/inbox') ? (started(), new Promise<Response>(() => {})) : undefined);
    const sending = f.a.share(bid, [note]); const queued = f.a.share(bid, [note]);
    const rejects = Promise.all([expect(sending).rejects.toThrow('paused'), expect(queued).rejects.toThrow('paused')]);
    await active; await f.a.setEnabled(false); await rejects;
    expect(f.seen.filter(request => request.url.endsWith('/inbox'))).toHaveLength(1); expect((await f.a.status()).sent).toHaveLength(0);
  });
  it('immediately prevents an active send when the owner revokes its peer', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair(); let started!: () => void; const active = new Promise<void>(resolve => { started = resolve; });
    f.setIntercept(request => request.url.endsWith('/inbox') ? (started(), new Promise<Response>(() => {})) : undefined);
    const sending = f.a.share(bid, [note]); const rejected = expect(sending).rejects.toThrow(); await active; await f.a.revoke(bid); await rejected;
    expect((await f.a.status()).peers[0]!.revokedAt).toBeTruthy(); await expect(f.a.share(bid, [note])).rejects.toThrow('disconnected');
  });
  it('rechecks revocation after an asynchronous pod-binding check before accepting an incoming snapshot', async () => {
    const f = fixture(); await f.setup(); const { aid, bid } = await f.pair(); let started!: () => void; let release!: (value: string) => void;
    const active = new Promise<void>(resolve => { started = resolve; }); const deferred = new Promise<string>(resolve => { release = resolve; }); let checks = 0;
    f.setBbinding(() => ++checks === 2 ? (started(), deferred) : Promise.resolve('pod-b'));
    const sending = f.a.share(bid, [note]); const rejected = expect(sending).rejects.toThrow('unavailable'); await active;
    const revoked = f.b.revoke(aid); release('pod-b'); await rejected; await revoked;
    expect((await f.b.status()).received).toHaveLength(0);
  });
  it('never acknowledges new grants or incoming snapshots when durable storage fails', async () => {
    const f = fixture(); await f.setup(); const invite = await f.a.createInvite(); f.stores[0]!.fail = true;
    await expect(f.b.acceptInvite(invite.code)).rejects.toThrow('unavailable'); expect((await f.a.status()).pending).toHaveLength(0);
    f.stores[0]!.fail = false; await f.b.acceptInvite(invite.code); const pending = (await f.a.status()).pending[0]!;
    f.stores[0]!.fail = true; await expect(f.a.approve(pending.id, pending.verificationCode)).rejects.toThrow('storage');
    expect((await f.a.status()).peers).toHaveLength(0); await expect(f.b.refresh()).rejects.toThrow('unavailable'); expect((await f.b.status()).joining).toHaveLength(1);
    f.stores[0]!.fail = false; await f.a.approve(pending.id, pending.verificationCode); await f.b.refresh(); f.stores[1]!.fail = true;
    await expect(f.a.share((await f.b.status()).profile!.id, [note])).rejects.toThrow('unavailable'); expect((await f.b.status()).received).toHaveLength(0);
  });
  it('returns side-effect-free signed denial to unknown polling identities without using durable replay capacity', async () => {
    const f = fixture(); await f.setup(); const identity = createIdentity(); const stranger = profileFor(identity, { name: 'Unknown', endpoint: 'https://unknown.example.com/pod-federation', kind: 'local' });
    const own = (await f.a.status()).profile!; const before = f.stores[0]!.saves;
    const signed = packet(identity, stranger.id, own.endpoint, 'pairing', { id: '12345678-1234-4123-8123-123456789abc', peer: stranger }, f.now());
    for (let n = 0; n < 2; n++) {
      const response = await f.a.handle(new Request(own.endpoint + '/pairing', { method: 'POST', body: JSON.stringify(signed), headers: { 'content-type': 'application/json' } }));
      expect(response.status).toBe(200); expect((await response.json()).payload.state).toBe('denied');
    }
    expect(f.stores[0]!.saves).toBe(before);
  });
  it('removes one local received copy while paused, persists cleanup and preserves peers and replay protection', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair();
    await f.a.share(bid, [note, { ...note, iri: 'urn:graph:second', content: 'another exact representation' }]);
    const before = await f.b.status(); const replayBefore = structuredClone((f.stores[1]!.value as FederationSavedState).replay);
    const networkCount = f.seen.length; await f.b.setEnabled(false); await f.b.removeReceived(before.received[0]!.id);
    const fresh = new FederationService({ store: f.stores[1]!, binding: async () => 'pod-b' }); const after = await fresh.status();
    expect(after.enabled).toBe(false); expect(after.profile).toEqual(before.profile); expect(after.peers).toEqual(before.peers);
    expect(after.received).toHaveLength(1); expect(after.received[0]!.id).toBe(before.received[1]!.id);
    await expect(fresh.received(before.received[0]!.id)).rejects.toThrow('no longer available');
    expect((f.stores[1]!.value as FederationSavedState).replay).toEqual(replayBefore); expect(f.seen).toHaveLength(networkCount);
  });
  it('clears sent display history while paused without revoking grants or forgetting replay history', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair(); await f.a.share(bid, [note]);
    const before = await f.a.status(); const replayBefore = structuredClone((f.stores[0]!.value as FederationSavedState).replay); const networkCount = f.seen.length;
    await f.a.setEnabled(false); await f.a.clearSentHistory();
    const fresh = new FederationService({ store: f.stores[0]!, binding: async () => 'pod-a' }); const after = await fresh.status();
    expect(after.sent).toHaveLength(0); expect(after.profile).toEqual(before.profile); expect(after.peers).toEqual(before.peers);
    expect((f.stores[0]!.value as FederationSavedState).replay).toEqual(replayBefore); expect(f.seen).toHaveLength(networkCount);
  });
  it('refreshes hosted authority before sending when another instance has revoked a peer', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair();
    const replica = new FederationService({ store: f.stores[0]!, binding: async () => 'pod-a', now: f.now, fetch: f.transport, refreshState: true });
    await replica.setEnabled(true); await f.a.revoke(bid); const requests = f.seen.length;
    await expect(replica.share(bid, [note])).rejects.toThrow('disconnected'); expect(f.seen).toHaveLength(requests);
    expect((await replica.status()).peers[0]!.revokedAt).toBeTruthy();
  });
  it('commits outbound authority before networking and pauses a hosted replica on a conditional-write conflict', async () => {
    const f = fixture(); await f.setup(); const { bid } = await f.pair(); const backend = f.stores[0]!; let expected = 0; let conflict = false;
    const conditional: FederationStore = {
      async load() { expected = backend.saves; return backend.load(); },
      async save(value) {
        if (conflict) {
          const state = backend.value as FederationSavedState;
          await backend.save({ ...state, peers: state.peers.map(peer => peer.id === bid ? { ...peer, revokedAt: new Date(f.now()).toISOString() } : peer) }); conflict = false;
        }
        if (backend.saves !== expected) throw new Error('fixture compare-and-swap conflict');
        await backend.save(value); expected = backend.saves;
      },
    };
    const replica = new FederationService({ store: conditional, binding: async () => 'pod-a', now: f.now, fetch: f.transport, refreshState: true });
    await replica.setEnabled(true); conflict = true; const requests = f.seen.length;
    await expect(replica.share(bid, [note])).rejects.toThrow('compare-and-swap');
    expect(f.seen).toHaveLength(requests); const after = await replica.status(); expect(after.enabled).toBe(false); expect(after.peers[0]!.revokedAt).toBeTruthy();
  });
  it('fails closed on changed pod binding and forgets corrupted saved state without requiring it to load', async () => {
    const f = fixture(); await f.setup(); const changed = new FederationService({ store: f.stores[0]!, binding: async () => 'another-pod' });
    await expect(changed.status()).rejects.toThrow('another pod');
    f.stores[0]!.value = { invalid: true }; const corrupt = new FederationService({ store: f.stores[0]!, binding: async () => 'pod-a' });
    await expect(corrupt.status()).rejects.toThrow('could not be opened'); expect((await corrupt.forget()).configured).toBe(false); expect(f.stores[0]!.value).toBeNull();
  });
  it('rejects private endpoints, bulk/resource overflows and forged recipient envelopes', async () => {
    const f = fixture();
    for (const endpoint of ['http://localhost:1234/pod-federation', 'https://127.0.0.1/pod-federation', 'https://host.internal/pod-federation', 'https://alice.example.com/a?next=x']) await expect(f.a.configure({ name: 'A', kind: 'local', endpoint })).rejects.toThrow('HTTPS');
    await f.setup(); const { aid, bid } = await f.pair();
    await expect(f.a.share(bid, Array.from({ length: 17 }, () => note))).rejects.toThrow();
    await expect(f.a.share(bid, [{ ...note, content: 'x'.repeat(128 * 1024) }])).rejects.toThrow('128 KiB');
    const astate = f.stores[0]!.value as FederationSavedState;
    const forged = packet(astate.identity, aid, (await f.b.status()).profile!.endpoint, 'inbox', { id: '12345678-1234-4123-8123-123456789abc', to: bid, envelope: { version: 1 } }, f.now());
    expect((await f.b.handle(new Request('https://bob.example.com/pod-federation/inbox', { method: 'POST', body: JSON.stringify(forged), headers: { 'content-type': 'application/json' } }))).status).toBe(403);
  });
});

describe('federation network and protected storage', () => {
  it('rejects private, mapped, link-local, reserved and documentation addresses', () => {
    for (const value of ['127.0.0.1', '10.1.2.3', '172.16.2.3', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) expect(publicAddress(value), value).toBe(false);
    for (const value of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) expect(publicAddress(value), value).toBe(true);
  });
  it('writes an opaque protected snapshot atomically and can tombstone a corrupt file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'interego-federation-')); const key = randomBytes(32);
    const protector = {
      protect(value: string) { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); const body = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64'); },
      unprotect(value: string) { const bytes = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString(); },
    };
    try {
      const store = new ProtectedFederationStore({ dataDir: dir, protector });
      await store.save({ secret: 'private-signing-key' }); expect(await store.load()).toEqual({ secret: 'private-signing-key' });
      expect(await readFile(join(dir, 'federation-state.json'), 'utf8')).not.toContain('private-signing-key');
      await writeFile(join(dir, 'federation-state.json'), '{bad'); await expect(store.load()).rejects.toThrow('could not be opened');
      await store.save(null); expect(await store.load()).toBeNull();
    } finally { key.fill(0); await rm(dir, { recursive: true, force: true }); }
  });
});
