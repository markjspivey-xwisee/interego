import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createEncryptedEnvelope, openEncryptedEnvelope } from '@interego/core';
import type { FederationConfiguration, FederationInvite, FederationPacket, FederationPeer, FederationProfile, FederationResource, FederationSavedState, FederationServiceOptions, FederationStatus } from './types.js';
import { canonical, comparison, createIdentity, ERROR, hash, INVITE_AGE, MAX_BODY, MAX_PEERS, MAX_SHARES, object, packet, PACKET_AGE, profile, profileFor, resource, text, token, verifyPacket } from './protocol.js';
import { array, envelope, iso, uuid, validateFederationState } from './state.js';
import { abortable, federationNetwork } from './network.js';

const PREFIX = 'interego-invite:v1:';
const EMPTY = { invites: [], pending: [], peers: [], joining: [], received: [], sent: [] } as const;
function equal(a: string, b: string): boolean { const aa = Buffer.from(a); const bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
/** No service starts networking. Hosts separately mount handle() and explicitly enable it. */
export class FederationService {
  private state: FederationSavedState | null | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private enabled = false;
  private inbound = 0;
  private readonly requests = new Set<{ peer: string; cancel: AbortController }>();
  private readonly revoking = new Set<string>();
  constructor(private readonly options: FederationServiceOptions) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private live(generation: number): void { if (!this.enabled || generation !== this.generation) throw new Error('Pod sharing is paused. Enable it before connecting or sharing.'); }
  private async load(): Promise<FederationSavedState | null> {
    const binding = await this.options.binding();
    if (this.state === undefined || this.options.refreshState) {
      const raw = await this.options.store.load();
      try {
        const loaded = raw === null ? null : validateFederationState(raw, this.options.allowLoopbackForTests);
        if (this.state && this.enabled && (!loaded || loaded.profile.fingerprint !== this.state.profile.fingerprint || loaded.profile.endpoint !== this.state.profile.endpoint)) {
          this.enabled = false; ++this.generation; for (const item of this.requests) item.cancel.abort();
        }
        this.state = loaded;
      }
      catch { throw new Error('Saved pod connections could not be opened. Reset sharing setup to continue. Your notes are safe.'); }
    }
    if (this.state && (!binding || this.state.binding !== binding)) throw new Error('These pod connections belong to another pod. Reset sharing setup to continue.');
    return this.state;
  }
  private async required(): Promise<FederationSavedState> { const state = await this.load(); if (!state) throw new Error('Set up pod sharing first.'); return state; }
  private serial<T>(operation: (generation: number) => Promise<T>, requireEnabled = true): Promise<T> {
    const generation = this.generation;
    const pending = this.queue.then(async () => { if (requireEnabled) this.live(generation); else if (generation !== this.generation) throw new Error('Pod sharing changed. Try again.'); return operation(generation); });
    this.queue = pending.catch(() => undefined); return pending;
  }
  private async commit(state: FederationSavedState, generation: number, requireEnabled = true, peerId?: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Pod sharing was paused.');
    if (requireEnabled) this.live(generation); else if (generation !== this.generation) throw new Error('Pod sharing changed. Try again.');
    if (await this.options.binding() !== state.binding) throw new Error('The pod changed. Sharing has stopped.');
    if (requireEnabled) this.live(generation);
    else if (generation !== this.generation) throw new Error('Pod sharing changed. Try again.');
    if (peerId && this.revoking.has(peerId)) throw new Error('This pod connection was disconnected.');
    if (signal?.aborted) throw new Error('Pod sharing was paused.');
    try { await this.options.store.save(state); }
    catch (error) {
      // A hosted compare-and-swap conflict invalidates cached authority.
      if (this.options.refreshState) { this.enabled = false; ++this.generation; for (const item of this.requests) item.cancel.abort(); this.state = undefined; }
      throw error;
    }
    this.state = state;
    if (requireEnabled) this.live(generation);
  }
  private prune(state: FederationSavedState): FederationSavedState {
    const now = this.now();
    return { ...state, invites: state.invites.filter(value => Date.parse(value.expiresAt) > now), pending: state.pending.filter(value => Date.parse(value.expiresAt) > now),
      joining: state.joining.filter(value => Date.parse(value.expiresAt) > now), replay: state.replay.filter(value => value.expiresAt > now) };
  }
  private view(state: FederationSavedState | null): FederationStatus {
    if (!state) return { enabled: false, configured: false, ...EMPTY };
    const value = this.prune(state);
    return { enabled: this.enabled, configured: true, profile: value.profile, invites: value.invites.map(({ id, expiresAt }) => ({ id, expiresAt })),
      pending: value.pending, joining: value.joining, peers: value.peers,
      received: value.received.map(({ id, from, resourceIri, receivedAt }) => ({ id, from, resourceIri, receivedAt })), sent: value.sent };
  }
  status(): Promise<FederationStatus> { return this.serial(async () => this.view(await this.load()), false); }
  configure(input: FederationConfiguration): Promise<FederationStatus> {
    return this.serial(async generation => {
      if (this.enabled) throw new Error('Pause sharing before changing its setup.');
      const previous = await this.load(); const binding = await this.options.binding();
      if (!binding) throw new Error('Set up your pod before connecting another pod.');
      const identity = previous?.identity ?? createIdentity(); const own = profileFor(identity, input, this.options.allowLoopbackForTests);
      if (previous && canonical(previous.profile) !== canonical(own)) throw new Error('Reset the existing sharing setup before changing its address or name.');
      const next: FederationSavedState = previous ?? { version: 1, binding, identity, profile: own, invites: [], pending: [], joining: [], peers: [], received: [], sent: [], replay: [] };
      await this.commit(next, generation, false); return this.view(next);
    }, false);
  }
  setEnabled(value: boolean): Promise<FederationStatus> {
    if (typeof value !== 'boolean') return Promise.reject(new Error('Choose whether to enable pod sharing.'));
    if (!value) {
      this.enabled = false; ++this.generation;
      for (const item of this.requests) item.cancel.abort();
      return this.queue.then(async () => this.view(await this.load()));
    }
    return this.serial(async generation => { const state = await this.required(); if (generation !== this.generation) throw new Error('Pod sharing changed. Try again.'); this.enabled = true; return this.view(state); }, false);
  }
  createInvite(): Promise<FederationInvite> {
    return this.serial(async generation => {
      const state = this.prune(await this.required()); this.live(generation);
      if (state.invites.length >= 8 || state.pending.length >= 8) throw new Error('Finish or cancel an existing invitation first.');
      const id = randomUUID(); const secret = token(); const expiresAt = new Date(this.now() + INVITE_AGE).toISOString();
      const next = { ...state, invites: [...state.invites, { id, secretHash: hash(secret), expiresAt }] };
      await this.commit(next, generation);
      const signed = packet(state.identity, state.profile.id, state.profile.endpoint, 'invite', { id, secret, expiresAt, profile: state.profile }, this.now());
      return { id, code: PREFIX + Buffer.from(JSON.stringify(signed)).toString('base64url'), expiresAt };
    });
  }
  private async send(state: FederationSavedState, peer: FederationProfile, action: string, payload: unknown, generation: number): Promise<Record<string, unknown>> {
    this.live(generation); if (this.revoking.has(peer.id)) throw new Error('This pod connection was disconnected.');
    const signed = packet(state.identity, state.profile.id, peer.endpoint, action, payload, this.now());
    const body = JSON.stringify(signed); if (Buffer.byteLength(body) > MAX_BODY) throw new Error('This shared snapshot is too large.');
    const cancel = new AbortController(); const item = { peer: peer.id, cancel }; this.requests.add(item);
    const timeout = setTimeout(() => cancel.abort(), 15_000);
    try {
      const url = new URL(peer.endpoint + '/' + action);
      const request = new Request(url, { method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json' }, redirect: 'error', signal: cancel.signal });
      const response = await abortable(this.options.fetch ? this.options.fetch(request) : federationNetwork(url, body, cancel.signal, this.options.allowLoopbackForTests), cancel.signal);
      this.live(generation); if (cancel.signal.aborted || this.revoking.has(peer.id)) throw new Error('This pod connection was paused or disconnected.');
      if (!response.ok || response.status >= 300 || response.redirected || !(response.headers.get('content-type') ?? '').startsWith('application/json')) throw new Error('The other pod is unavailable or did not approve this request.');
      const content = await boundedText(response, cancel.signal); this.live(generation);
      const result = verifyPacket(JSON.parse(content), peer, state.profile.endpoint, 'response:' + action, this.now());
      const data = object(result.payload); if (data['requestNonce'] !== signed.nonce) throw new Error(ERROR);
      return data;
    } finally { clearTimeout(timeout); this.requests.delete(item); }
  }
  acceptInvite(code: string): Promise<FederationStatus> {
    return this.serial(async generation => {
      const state = this.prune(await this.required());
      if (typeof code !== 'string' || !code.startsWith(PREFIX) || code.length > 8192) throw new Error('Paste a complete Interego pod invitation.');
      let raw: unknown; try { const encoded = code.slice(PREFIX.length); const decoded = Buffer.from(encoded, 'base64url'); if (decoded.toString('base64url') !== encoded) throw new Error(ERROR); raw = JSON.parse(decoded.toString('utf8')); } catch { throw new Error('This pod invitation could not be read.'); }
      const candidate = object(object(raw)['payload']); const remote = profile(candidate['profile'], this.options.allowLoopbackForTests);
      const invite = verifyPacket(raw, remote, remote.endpoint, 'invite', this.now(), INVITE_AGE);
      const data = object(invite.payload, ['id', 'secret', 'expiresAt', 'profile']); const id = uuid(data['id']); const secret = text(data['secret'], 43); const expiresAt = iso(data['expiresAt']);
      if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Date.parse(expiresAt) <= this.now() || Date.parse(expiresAt) > this.now() + INVITE_AGE + 30_000 || remote.id === state.profile.id) throw new Error('This invitation is expired or belongs to your own pod.');
      if (state.joining.length >= 8 || state.peers.length >= MAX_PEERS) throw new Error('Disconnect an old pod or finish an existing invitation first.');
      if (state.peers.some(value => value.id === remote.id) || state.joining.some(value => value.peer.id === remote.id)) throw new Error('This pod already has a connection or invitation.');
      const result = await this.send(state, remote, 'join', { inviteId: id, secret, peer: state.profile }, generation);
      const requestId = uuid(result['id']); const expected = comparison(state.profile, remote, requestId);
      if (result['verificationCode'] !== expected || result['expiresAt'] !== expiresAt) throw new Error(ERROR);
      const next = { ...state, joining: [...state.joining, { id: requestId, peer: remote, verificationCode: expected, expiresAt }] };
      await this.commit(next, generation); return this.view(next);
    });
  }
  approve(id: string, verificationCode: string): Promise<FederationStatus> {
    return this.serial(async generation => {
      const state = this.prune(await this.required()); const pending = state.pending.find(value => value.id === id);
      if (!pending || !equal(pending.verificationCode, text(verificationCode, 9))) throw new Error('This invitation or verification code is no longer available.');
      if (state.peers.length >= MAX_PEERS || state.peers.some(value => value.id === pending.peer.id)) throw new Error('This pod already has a connection, or your connection list is full.');
      const next = { ...state, pending: state.pending.filter(value => value.id !== id), peers: [...state.peers, { ...pending.peer, connectedAt: new Date(this.now()).toISOString() }] };
      await this.commit(next, generation); return this.view(next);
    });
  }
  deny(id: string): Promise<FederationStatus> {
    return this.serial(async generation => {
      const state = this.prune(await this.required());
      const next = { ...state, pending: state.pending.filter(value => value.id !== id), invites: state.invites.filter(value => value.id !== id), joining: state.joining.filter(value => value.id !== id) };
      await this.commit(next, generation); return this.view(next);
    });
  }
  refresh(): Promise<FederationStatus> {
    return this.serial(async generation => {
      let state = this.prune(await this.required());
      for (const joining of state.joining) {
        const result = await this.send(state, joining.peer, 'pairing', { id: joining.id, peer: state.profile }, generation);
        if (result['state'] === 'pending') continue;
        if (result['state'] === 'approved') {
          if (state.peers.length >= MAX_PEERS || state.peers.some(value => value.id === joining.peer.id)) throw new Error('Your pod connection list is full or already contains this pod.');
          state = { ...state, peers: [...state.peers, { ...joining.peer, connectedAt: new Date(this.now()).toISOString() }], joining: state.joining.filter(value => value.id !== joining.id) };
        } else if (result['state'] === 'denied') state = { ...state, joining: state.joining.filter(value => value.id !== joining.id) };
        else throw new Error(ERROR);
        await this.commit(state, generation, true, joining.peer.id);
      }
      return this.view(state);
    });
  }
  private approved(state: FederationSavedState, id: string): FederationPeer {
    const peer = state.peers.find(value => value.id === id && !value.revokedAt);
    if (!peer || this.revoking.has(id)) throw new Error('This pod connection was disconnected or has not been approved.');
    return peer;
  }
  share(peerId: string, resources: readonly FederationResource[]): Promise<FederationStatus> {
    return this.serial(async generation => {
      let state = this.prune(await this.required()); const peer = this.approved(state, peerId);
      const selected = array(resources, 16).map(resource); if (!selected.length) throw new Error('Choose at least one note to share.');
      if (state.sent.length + selected.length > MAX_SHARES) throw new Error('Your sharing history is full. Reset sharing setup before sending more snapshots.');
      for (const item of selected) {
        this.approved(state, peerId); this.live(generation);
        const id = randomUUID(); const createdAt = new Date(this.now()).toISOString();
        if (state.replay.length >= 2048) throw new Error('This pod is making too many requests. Try again shortly.');
        state = { ...state, replay: [...state.replay, { key: 'outbound:' + peerId + ':' + id, expiresAt: this.now() + PACKET_AGE + 30_000 }] };
        // Linearize outbound authority against a hosted conditional store before sending.
        await this.commit(state, generation, true, peerId);
        const wrapped = createEncryptedEnvelope(JSON.stringify(item), [state.identity.encryption.publicKey, peer.encryptionKey].filter((key, index, values) => values.indexOf(key) === index), state.identity.encryption);
        const result = await this.send(state, peer, 'inbox', { id, to: peer.id, envelope: wrapped }, generation);
        if (result['id'] !== id || result['state'] !== 'received') throw new Error(ERROR);
        this.approved(state, peerId);
        state = { ...state, sent: [...state.sent, { id, to: peerId, resourceIri: item.iri, createdAt }] };
        await this.commit(state, generation, true, peerId);
      }
      return this.view(state);
    });
  }
  received(id: string): Promise<FederationResource> {
    return this.serial(async () => {
      const state = await this.required(); const found = state.received.find(value => value.id === id);
      if (!found) throw new Error('This received snapshot is no longer available.');
      const plain = openEncryptedEnvelope(found.envelope, state.identity.encryption);
      if (plain === null) throw new Error('This snapshot could not be decrypted by this pod.');
      const item = resource(JSON.parse(plain)); if (item.iri !== found.resourceIri) throw new Error(ERROR); return item;
    }, false);
  }
  /** Owner-only local retention control; never sends a remote deletion request. */
  removeReceived(id: string): Promise<FederationStatus> {
    return this.serial(async generation => {
      const state = await this.required(); const validId = uuid(id);
      if (!state.received.some(value => value.id === validId)) throw new Error('This received snapshot is no longer available.');
      const next = { ...state, received: state.received.filter(value => value.id !== validId) };
      await this.commit(next, generation, false); return this.view(next);
    }, false);
  }
  /** Clears display history only; peer authority and replay history stay intact. */
  clearSentHistory(): Promise<FederationStatus> {
    return this.serial(async generation => {
      const state = await this.required(); const next = { ...state, sent: [] };
      await this.commit(next, generation, false); return this.view(next);
    }, false);
  }
  revoke(peerId: string): Promise<FederationStatus> {
    this.revoking.add(peerId); for (const item of this.requests) if (item.peer === peerId) item.cancel.abort();
    return this.serial(async generation => {
      const state = await this.required(); const previous = state.peers.find(value => value.id === peerId);
      if (!previous) throw new Error('This pod connection could not be found.');
      const next = { ...state, peers: state.peers.map(value => value.id === peerId ? { ...value, revokedAt: value.revokedAt ?? new Date(this.now()).toISOString() } : value),
        pending: state.pending.filter(value => value.peer.id !== peerId), joining: state.joining.filter(value => value.peer.id !== peerId) };
      await this.commit(next, generation, false); return this.view(next);
    }, false);
  }
  forget(): Promise<FederationStatus> {
    this.enabled = false; ++this.generation; for (const item of this.requests) item.cancel.abort();
    const pending = this.queue.then(async () => {
      await this.options.store.save(null); this.state = null; this.revoking.clear(); return this.view(null);
    });
    this.queue = pending.catch(() => undefined); return pending;
  }
  private replay(state: FederationSavedState, signed: FederationPacket): FederationSavedState {
    const value = this.prune(state); const key = signed.issuer + ':' + signed.nonce;
    if (value.replay.some(row => row.key === key)) throw new Error(ERROR);
    if (value.replay.length >= 2048) throw new Error('This pod is receiving too many requests. Try again shortly.');
    return { ...value, replay: [...value.replay, { key, expiresAt: this.now() + PACKET_AGE + 30_000 }] };
  }
  /** Public route adapter: no owner management, arbitrary URL fetch or raw storage access. */
  async handle(request: Request): Promise<Response> {
    if (!this.enabled) return json({ error: 'Pod sharing is paused.' }, 503);
    if (this.inbound >= 16) return json({ error: 'This pod is busy. Try again shortly.' }, 429);
    this.inbound++;
    const generation = this.generation;
    const cancel = new AbortController(); const tracked = { peer: '(incoming)', cancel }; this.requests.add(tracked);
    const timedOut = setTimeout(() => cancel.abort(), 15_000);
    const abort = () => cancel.abort(); request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) cancel.abort();
    try {
      const body = request.method === 'POST' ? await boundedText(request, cancel.signal) : '';
      return await this.serial(async () => {
        this.live(generation); let state = this.prune(await this.required()); const own = state.profile;
        if (cancel.signal.aborted) throw new Error('Pod sharing was paused.');
        const url = new URL(request.url); const prefix = new URL(own.endpoint);
        if (url.origin !== prefix.origin || url.search || url.hash || !url.pathname.startsWith(prefix.pathname + '/')) return json({ error: 'Not found.' }, 404);
        const action = url.pathname.slice(prefix.pathname.length + 1);
        if (request.method === 'GET' && action === 'profile') return json({ profile: own });
        if (request.method !== 'POST' || !['join', 'pairing', 'inbox', 'revoke'].includes(action)) return json({ error: 'Not found.' }, 404);
        if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'Use application/json.' }, 415);
        const raw = JSON.parse(body) as unknown; const rawPayload = object(object(raw)['payload']);
        const remote = action === 'join' || action === 'pairing' ? profile(rawPayload['peer'], this.options.allowLoopbackForTests) : this.approved(state, text(object(raw)['issuer'], 256));
        if (remote.id === own.id) throw new Error(ERROR);
        const signed = verifyPacket(raw, remote, own.endpoint, action, this.now());
        // An unknown self-signed polling caller must not fill the durable replay budget.
        // The signed denial has no side effect and remains bound to that request's nonce.
        if (action === 'pairing') {
          const data = object(signed.payload, ['id', 'peer']); const id = uuid(data['id']);
          const known = state.peers.some(value => value.id === remote.id && !value.revokedAt)
            || state.pending.some(value => value.id === id && canonical(value.peer) === canonical(remote));
          if (!known) return json(packet(state.identity, own.id, remote.endpoint, 'response:pairing', { state: 'denied', requestNonce: signed.nonce }, this.now()));
        }
        state = this.replay(state, signed);
        let result: Record<string, unknown>;
        if (action === 'join') {
          const data = object(signed.payload, ['inviteId', 'secret', 'peer']); const inviteId = uuid(data['inviteId']); const secret = text(data['secret'], 43);
          const invite = state.invites.find(value => value.id === inviteId && equal(value.secretHash, hash(secret)));
          if (!invite || state.pending.length >= 8 || state.peers.length >= MAX_PEERS || state.peers.some(value => value.id === remote.id) || state.pending.some(value => value.peer.id === remote.id)) throw new Error(ERROR);
          const id = randomUUID(); const verificationCode = comparison(own, remote, id);
          state = { ...state, invites: state.invites.filter(value => value.id !== inviteId), pending: [...state.pending, { id, peer: remote, verificationCode, expiresAt: invite.expiresAt }] };
          result = { id, verificationCode, expiresAt: invite.expiresAt };
        } else if (action === 'pairing') {
          const data = object(signed.payload, ['id', 'peer']); const id = uuid(data['id']);
          const approved = state.peers.find(value => value.id === remote.id && !value.revokedAt);
          if (approved && canonical(stripPeer(approved)) !== canonical(remote)) throw new Error(ERROR);
          const pending = state.pending.some(value => value.id === id && canonical(value.peer) === canonical(remote));
          result = { state: approved ? 'approved' : pending ? 'pending' : 'denied' };
        } else if (action === 'inbox') {
          this.approved(state, remote.id); const data = object(signed.payload, ['id', 'to', 'envelope']); const id = uuid(data['id']);
          if (data['to'] !== own.id || state.received.some(value => value.id === id) || state.received.length >= MAX_SHARES) throw new Error(ERROR);
          const wrapped = envelope(data['envelope']);
          if (wrapped.wrappedKeys.some(value => value.senderPublicKey !== remote.encryptionKey) || !wrapped.wrappedKeys.some(value => value.recipientPublicKey === own.encryptionKey)) throw new Error(ERROR);
          const plain = openEncryptedEnvelope(wrapped, state.identity.encryption); if (plain === null) throw new Error(ERROR);
          const item = resource(JSON.parse(plain));
          this.approved(state, remote.id);
          state = { ...state, received: [...state.received, { id, from: remote.id, resourceIri: item.iri, receivedAt: new Date(this.now()).toISOString(), envelope: wrapped }] };
          result = { id, state: 'received' };
        } else {
          object(signed.payload, []); this.approved(state, remote.id);
          state = { ...state, peers: state.peers.map(value => value.id === remote.id ? { ...value, revokedAt: new Date(this.now()).toISOString() } : value) };
          result = { state: 'revoked' };
        }
        if (action === 'inbox') this.approved(state, remote.id);
        await this.commit(state, generation, true, action === 'inbox' ? remote.id : undefined, cancel.signal);
        return json(packet(state.identity, own.id, remote.endpoint, 'response:' + action, { ...result, requestNonce: signed.nonce }, this.now()));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return json({ error: message === 'This request is too large.' ? message : 'This pod request could not be verified.' }, message === 'This request is too large.' ? 413 : this.enabled ? 403 : 503);
    } finally { clearTimeout(timedOut); request.signal.removeEventListener('abort', abort); this.requests.delete(tracked); this.inbound--; }
  }
}
function stripPeer(peer: FederationPeer): FederationProfile { const { connectedAt: _connected, revokedAt: _revoked, ...profile } = peer; return profile; }
async function boundedText(value: Request | Response, signal?: AbortSignal): Promise<string> {
  const declared = value.headers.get('content-length'); if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) throw new Error('This request is too large.');
  if (!value.body) return '';
  const reader = value.body.getReader(); let count = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const item = await (signal ? abortable(reader.read(), signal) : reader.read()); if (item.done) break; count += item.value.length; if (count > MAX_BODY) { await reader.cancel(); throw new Error('This request is too large.'); } chunks.push(item.value); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { try { reader.releaseLock(); } catch { /* A cancelled host stream can still have a pending read. */ } }
}
