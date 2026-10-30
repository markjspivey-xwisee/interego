/** Local credential custody with native consent; private proof completes only its relay handoff. */
import { createCipheriv, createDecipheriv, pbkdf2, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { LocalIdentityApproval, LocalIdentityContext, LocalIdentityLinkContext, LocalIdentityLinkedReceipt, LocalIdentityResult, LocalIdentityServiceOptions, LocalIdentityStart, LocalIdentityStatus, LocalIdentityTicket } from './local-identity-types.js';
import { IDENTITY_ERROR, IDENTITY_HANDOFF, IDENTITY_NONCE, identityHash, identityObject, identityOrigin, identitySame, identityText,
  localIdentityContext, localIdentityPublic, localIdentityRedirect, newLocalIdentity, savedLocalIdentity, signLocalIdentity, type LocalIdentitySaved } from './local-identity-protocol.js';
import { identityAbortable, localIdentityJson, localIdentityNetwork } from './local-identity-network.js';
import { IDENTITY_LINK_HANDOFF, localIdentityLinkContext, localIdentityLinkedReceipt } from './local-identity-link.js';
export type { LocalIdentityApproval, LocalIdentityResult, LocalIdentityServiceOptions, LocalIdentityStart, LocalIdentityStatus, LocalIdentityTicket } from './local-identity-types.js';
export { ProtectedLocalIdentityStore } from './local-identity-store.js';

interface Pending {
  readonly purpose: 'signin' | 'link';
  readonly id: string;
  readonly channel: string;
  readonly receiptHash: string;
  readonly verificationCode: string;
  readonly generation: number;
  identity?: LocalIdentitySaved;
  readonly cancel: AbortController;
  expiresAt: number;
  state: 'preparing' | 'waiting' | 'completing' | 'complete' | 'failed' | 'denied';
  context?: LocalIdentityContext;
  linkContext?: LocalIdentityLinkContext;
  linked?: LocalIdentityLinkedReceipt;
  redirect?: string;
}
const MAX_REQUESTS = 8;
const CANCELLED = 'This sign-in was stopped. Start a new sign-in when you are ready.';
const FAILED = 'Sign-in could not be confirmed. Start a new sign-in rather than retrying this request.';
const LINK_FAILED = 'The account link could not be confirmed. Check your registered credentials in the hosted dashboard before starting again. Your progress has not been moved.';
const NOT_CONFIGURED = 'Create a local sign-in identity in Interego before connecting a website.';
const BACKUP_ERROR = 'This identity backup could not be unlocked. Check the passphrase and file.';
const BACKUP_AAD = Buffer.from('interego-local-identity-backup:v1:PBKDF2-SHA256:600000:AES-256-GCM');
const deriveBackupKey = promisify(pbkdf2);
function backupPhrase(value: string): void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw new Error('Use an identity backup passphrase between 12 and 1,024 characters.');
}
function backupBytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > 16 * 1024) throw new Error(BACKUP_ERROR);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || length !== undefined && bytes.length !== length) throw new Error(BACKUP_ERROR);
  return bytes;
}
function opaque(): string { return randomBytes(32).toString('base64url'); }
function channelValue(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error(IDENTITY_ERROR);
}

export class LocalIdentityService {
  private saved: LocalIdentitySaved | null | undefined;
  private revision = 0;
  private generation = 0;
  private resetting = false;
  private ownerQueue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Pending>();
  private readonly trusted = new Map<string, string>();
  private readonly providers = new Set<string>();
  constructor(private readonly options: LocalIdentityServiceOptions) {
    for (const pair of options.trustedRelays) {
      const relay = identityOrigin(pair.relayOrigin, options.allowLoopbackForTests);
      const provider = identityOrigin(pair.identityOrigin, options.allowLoopbackForTests);
      if (this.trusted.has(relay)) throw new Error('Each sign-in service needs exactly one trusted identity provider.');
      this.trusted.set(relay, provider);
      this.providers.add(provider);
    }
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private owner<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.ownerQueue.then(operation); this.ownerQueue = next.catch(() => {}); return next;
  }
  private async load(verifyBinding = true): Promise<LocalIdentitySaved | null> {
    const began = this.revision;
    if (this.saved === undefined) {
      const revision = this.revision; const raw = await this.options.store.load();
      if (revision !== this.revision) throw new Error(CANCELLED);
      this.saved = raw === null ? null : savedLocalIdentity(raw);
    }
    const saved = this.saved;
    if (verifyBinding && saved && await this.options.binding() !== saved.binding) throw new Error('This sign-in identity belongs to another local pod. Reset local identity setup to continue.');
    if (began !== this.revision) throw new Error(CANCELLED);
    return saved;
  }
  private async required(): Promise<LocalIdentitySaved> {
    const value = await this.load(); if (!value) throw new Error(NOT_CONFIGURED); return value;
  }
  private prune(): void {
    for (const [id, entry] of this.pending) if (entry.expiresAt <= this.now()) { entry.cancel.abort(); this.pending.delete(id); }
  }
  private view(saved: LocalIdentitySaved | null): LocalIdentityStatus {
    this.prune(); const pending: LocalIdentityApproval[] = [];
    for (const entry of this.pending.values()) {
      if (!['waiting', 'completing'].includes(entry.state)) continue;
      if (entry.linkContext) {
        const context = entry.linkContext;
        pending.push({ purpose: 'link', id: entry.id, state: entry.state as 'waiting' | 'completing', identityOrigin: context.identityOrigin,
          owner: { ...context.owner }, credentialDid: context.credentialDid, credentialFingerprint: identityHash(context.credentialDid),
          verificationCode: entry.verificationCode, expiresAt: new Date(entry.expiresAt).toISOString() });
        continue;
      }
      if (!entry.context) continue;
      const context = entry.context;
      pending.push({ id: entry.id, state: entry.state as 'waiting' | 'completing', relayOrigin: context.issuer, identityOrigin: context.identityOrigin,
        clientId: context.clientId, clientName: context.clientName, redirectOrigin: new URL(context.redirectUri).origin, redirectUri: context.redirectUri,
        scopes: [...context.scopes], resource: context.resource, verificationCode: entry.verificationCode, expiresAt: new Date(entry.expiresAt).toISOString() });
    }
    return { configured: !!saved, ...(saved ? { identity: localIdentityPublic(saved) } : {}), pending };
  }
  async status(): Promise<LocalIdentityStatus> { return this.view(await this.load()); }
  setup(): Promise<LocalIdentityStatus> {
    if (this.resetting) return Promise.reject(new Error('Local identity setup is changing. Please wait a moment.'));
    const generation = this.generation;
    return this.owner(async () => {
      if (generation !== this.generation) throw new Error(CANCELLED);
      const previous = await this.load(); if (generation !== this.generation) throw new Error(CANCELLED);
      if (previous) return this.view(previous);
      const binding = await this.options.binding();
      if (!binding || typeof binding !== 'string' || binding.length > 256) throw new Error('Set up your local pod before creating a sign-in identity.');
      if (generation !== this.generation) throw new Error(CANCELLED);
      const next = newLocalIdentity(binding, this.now()); ++this.revision;
      await this.options.store.save(next); ++this.revision; this.saved = next;
      if (generation !== this.generation) throw new Error(CANCELLED);
      return this.view(next);
    });
  }
  private current(entry: Pending): void {
    if (this.resetting || this.generation !== entry.generation || this.pending.get(entry.id) !== entry || entry.cancel.signal.aborted || entry.expiresAt <= this.now()) throw new Error(CANCELLED);
  }
  private async bound(entry: Pending): Promise<void> {
    this.current(entry); const binding = await this.options.binding(); this.current(entry);
    if (!entry.identity || binding !== entry.identity.binding) throw new Error('The local pod changed. Start a new sign-in after reviewing local identity setup.');
  }
  private async post(origin: string, path: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    const url = new URL(path, origin); const body = JSON.stringify(value);
    if (url.origin !== origin || !['/oauth/local-identity/context', '/oauth/verify', '/local-identity/link/context', '/local-identity/link/complete'].includes(url.pathname) || Buffer.byteLength(body) > 16 * 1024) throw new Error(IDENTITY_ERROR);
    const request = new Request(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body, redirect: 'error', signal });
    const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), 15_000);
    const active = AbortSignal.any([signal, timeout.signal]);
    let response: Response | undefined;
    try {
      const operation = this.options.fetch ? this.options.fetch(new Request(request, { signal: active })) : localIdentityNetwork(url, body, active, this.options.allowLoopbackForTests);
      operation.then(late => { if (active.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
      response = await identityAbortable(operation, active); return await localIdentityJson(response, active);
    }
    finally { clearTimeout(timer); if (active.aborted) void response?.body?.cancel().catch(() => {}); }
  }
  async request(input: LocalIdentityStart, channel: string): Promise<LocalIdentityTicket> {
    if (this.resetting) throw new Error('Local identity setup is changing. Please wait a moment.');
    channelValue(channel); const raw = identityObject(input, ['relayOrigin', 'handoffCode']);
    const relay = identityOrigin(raw['relayOrigin'], this.options.allowLoopbackForTests);
    const code = identityText(raw['handoffCode'], 256); const linking = IDENTITY_LINK_HANDOFF.test(code);
    const provider = linking ? (this.providers.has(relay) ? relay : undefined) : this.trusted.get(relay);
    if (!provider || !linking && !IDENTITY_HANDOFF.test(code)) throw new Error(IDENTITY_ERROR);
    this.prune(); if (this.pending.size >= MAX_REQUESTS) throw new Error('Finish or cancel an existing sign-in request before starting another.');
    const generation = this.generation;
    const receipt = opaque(); const entry: Pending = { purpose: linking ? 'link' : 'signin', id: randomUUID(), channel, receiptHash: identityHash(receipt), verificationCode: randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})(.{4})/, '$1 $2'),
      generation, cancel: new AbortController(), expiresAt: this.now() + (linking ? 120_000 : 300_000), state: 'preparing' };
    this.pending.set(entry.id, entry);
    try {
      entry.identity = await identityAbortable(this.required(), entry.cancel.signal); this.current(entry);
      const context = linking
        ? localIdentityLinkContext(await this.post(provider, '/local-identity/link/context', { handoffCode: code, did: localIdentityPublic(entry.identity).did }, entry.cancel.signal), provider,
          localIdentityPublic(entry.identity).did, this.now(), this.options.allowLoopbackForTests)
        : localIdentityContext(await this.post(relay, '/oauth/local-identity/context', { handoffCode: code }, entry.cancel.signal), relay, provider, this.now(), this.options.allowLoopbackForTests);
      await this.bound(entry);
      entry.expiresAt = Math.min(entry.expiresAt, Date.parse(context.expiresAt), Date.parse(context.challengeExpiresAt));
      if ('purpose' in context && context.purpose === 'link') entry.linkContext = context; else entry.context = context as LocalIdentityContext;
      entry.state = 'waiting'; this.current(entry);
      return { id: entry.id, receipt, verificationCode: entry.verificationCode, expiresAt: new Date(entry.expiresAt).toISOString() };
    } catch (error) { entry.cancel.abort(); this.pending.delete(entry.id); throw new Error(error instanceof Error && error.message === NOT_CONFIGURED ? NOT_CONFIGURED : linking
      ? 'This account link could not be prepared. Start a new link from your signed-in hosted dashboard.' : 'This sign-in request could not be prepared. Start a new sign-in from the app you want to use.'); }
  }
  async approve(id: string, verificationCode: string): Promise<void> {
    this.prune(); const entry = this.pending.get(id);
    if (!entry || entry.state !== 'waiting' || typeof verificationCode !== 'string' || !identitySame(verificationCode, entry.verificationCode) || (!entry.context && !entry.linkContext) || !entry.identity) throw new Error('Compare the code before approving this request.');
    entry.state = 'completing'; const context = entry.context; const identity = entry.identity;
    try {
      await this.bound(entry);
      if (entry.linkContext) {
        const link = entry.linkContext;
        const signature = signLocalIdentity(identity, link.message);
        const result = await this.post(link.identityOrigin, '/local-identity/link/complete', { completionCode: link.completionCode, did: link.credentialDid,
          nonce: link.nonce, signature }, entry.cancel.signal);
        await this.bound(entry); entry.linked = localIdentityLinkedReceipt(result, link); entry.linkContext = undefined; entry.state = 'complete'; return;
      }
      if (!context) throw new Error(IDENTITY_ERROR);
      const signature = signLocalIdentity(identity, context.message);
      const result = await this.post(context.issuer, '/oauth/verify', { pending_id: context.pendingId, method: 'did', did: localIdentityPublic(identity).did,
        nonce: context.nonce, signature, native_handoff: context.completionCode }, entry.cancel.signal);
      await this.bound(entry); entry.redirect = localIdentityRedirect(result, context, this.options.allowLoopbackForTests); entry.context = undefined; entry.state = 'complete';
    } catch {
      if (this.pending.get(id) === entry && entry.state === 'completing') { entry.state = 'failed'; entry.context = undefined; entry.linkContext = undefined; entry.linked = undefined; entry.redirect = undefined; }
      throw new Error(entry.purpose === 'link' ? LINK_FAILED : FAILED);
    }
  }
  deny(id: string): void {
    const entry = this.pending.get(id); if (!entry || !['waiting', 'completing'].includes(entry.state)) throw new Error('This sign-in request is no longer available.');
    entry.cancel.abort(); entry.context = undefined; entry.linkContext = undefined; entry.linked = undefined; entry.redirect = undefined; entry.state = 'denied';
  }
  private receipt(id: string, receipt: string, channel: string): Pending | undefined {
    channelValue(channel); if (typeof id !== 'string' || typeof receipt !== 'string' || !IDENTITY_NONCE.test(receipt)) throw new Error(IDENTITY_ERROR);
    const entry = this.pending.get(id);
    if (entry && (entry.channel !== channel || !identitySame(entry.receiptHash, identityHash(receipt)))) throw new Error(IDENTITY_ERROR);
    return entry;
  }
  poll(id: string, receipt: string, channel: string): LocalIdentityResult {
    const entry = this.receipt(id, receipt, channel); if (!entry) return { state: 'expired' };
    if (entry.expiresAt <= this.now()) { entry.cancel.abort(); this.pending.delete(id); return { state: 'expired' }; }
    if (entry.state === 'preparing' || entry.state === 'waiting') return { state: 'waiting' };
    if (entry.state === 'completing') return { state: 'completing' };
    this.pending.delete(id); // Consume terminal OAuth authority before returning it to its native channel.
    if (entry.state === 'complete' && entry.linked) return { state: 'linked', identityOrigin: entry.linked.identityOrigin, owner: { ...entry.linked.owner }, credentialDid: entry.linked.credentialDid };
    return entry.state === 'complete' && entry.redirect ? { state: 'complete', redirect: entry.redirect }
      : { state: entry.state === 'denied' ? 'denied' : 'failed', message: entry.state === 'denied' ? 'You declined this request.' : entry.purpose === 'link' ? LINK_FAILED : FAILED };
  }
  cancel(id: string, receipt: string, channel: string): void {
    const entry = this.receipt(id, receipt, channel); if (!entry) return;
    entry.cancel.abort(); entry.context = undefined; entry.linkContext = undefined; entry.linked = undefined; entry.redirect = undefined; this.pending.delete(id);
  }
  cancelChannel(channel: string): void {
    for (const [id, entry] of this.pending) if (entry.channel === channel) { entry.cancel.abort(); this.pending.delete(id); }
  }
  stop(): void {
    ++this.generation;
    for (const entry of this.pending.values()) entry.cancel.abort(); this.pending.clear();
  }
  /** Native owner file export only; never exposed by the browser/native-port operations. */
  exportBackup(passphrase: string): Promise<Uint8Array> {
    backupPhrase(passphrase);
    if (this.resetting) return Promise.reject(new Error('Local identity setup is changing. Please wait a moment.'));
    this.stop(); const generation = this.generation;
    return this.owner(async () => {
      if (generation !== this.generation) throw new Error(CANCELLED);
      // Recovery may export a valid OS-protected key even when its old notes pod is
      // unavailable. Export gives no sign-in proof and requires the native owner's passphrase.
      const saved = await this.load(false); if (!saved) throw new Error(NOT_CONFIGURED);
      const salt = randomBytes(16); const iv = randomBytes(12);
      const key = await deriveBackupKey(passphrase, salt, 600_000, 32, 'sha256');
      let plaintext: Buffer | undefined;
      try {
        if (generation !== this.generation || this.resetting) throw new Error(CANCELLED);
        plaintext = Buffer.from(JSON.stringify({ format: 'interego-local-identity-key', version: 1, did: localIdentityPublic(saved).did,
          identity: { publicKey: saved.publicKey, privateKey: saved.privateKey, createdAt: saved.createdAt } }));
        const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(BACKUP_AAD);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return new Uint8Array(Buffer.from(JSON.stringify({ format: 'interego-local-identity-backup', version: 1, kdf: 'PBKDF2-SHA256', iterations: 600_000,
          cipher: 'AES-256-GCM', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })));
      } finally { key.fill(0); plaintext?.fill(0); }
    });
  }
  /** Restores the same credential onto an explicitly chosen, configured local pod. */
  restoreBackup(bytes: Uint8Array, passphrase: string): Promise<LocalIdentityStatus> {
    backupPhrase(passphrase);
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.byteLength > 32 * 1024) return Promise.reject(new Error(BACKUP_ERROR));
    if (this.resetting) return Promise.reject(new Error('Local identity setup is changing. Please wait a moment.'));
    const backup = Buffer.from(bytes); // The native file read cannot change while an owner operation is queued.
    this.resetting = true; this.stop(); ++this.revision; const generation = this.generation;
    return this.owner(async () => {
      let key: Buffer | undefined; let plaintext: Buffer | undefined;
      try {
        if (generation !== this.generation) throw new Error(CANCELLED);
        if (await this.load(false)) throw new Error('This installation already holds a sign-in identity. Its key has not been overwritten.');
        if (generation !== this.generation) throw new Error(CANCELLED);
        const binding = await this.options.binding();
        if (!binding || typeof binding !== 'string' || binding.length > 256) throw new Error('Set up your local pod before restoring a sign-in identity.');
        if (generation !== this.generation) throw new Error(CANCELLED);
        let wrapper: Record<string, unknown>;
        try { wrapper = identityObject(JSON.parse(backup.toString('utf8')), ['format', 'version', 'kdf', 'iterations', 'cipher', 'salt', 'iv', 'tag', 'ciphertext']); }
        catch { throw new Error(BACKUP_ERROR); }
        if (wrapper['format'] !== 'interego-local-identity-backup' || wrapper['version'] !== 1 || wrapper['kdf'] !== 'PBKDF2-SHA256'
          || wrapper['iterations'] !== 600_000 || wrapper['cipher'] !== 'AES-256-GCM') throw new Error(BACKUP_ERROR);
        const salt = backupBytes(wrapper['salt'], 16); const iv = backupBytes(wrapper['iv'], 12); const tag = backupBytes(wrapper['tag'], 16); const ciphertext = backupBytes(wrapper['ciphertext']);
        if (!ciphertext.length || ciphertext.length > 8192) throw new Error(BACKUP_ERROR);
        key = await deriveBackupKey(passphrase, salt, 600_000, 32, 'sha256');
        let restored: LocalIdentitySaved;
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(BACKUP_AAD); decipher.setAuthTag(tag);
          plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
          const payload = identityObject(JSON.parse(plaintext.toString('utf8')), ['format', 'version', 'did', 'identity']);
          const identity = identityObject(payload['identity'], ['publicKey', 'privateKey', 'createdAt']);
          if (payload['format'] !== 'interego-local-identity-key' || payload['version'] !== 1) throw new Error(BACKUP_ERROR);
          restored = savedLocalIdentity({ version: 1, binding, publicKey: identity['publicKey'], privateKey: identity['privateKey'], createdAt: identity['createdAt'] });
          if (localIdentityPublic(restored).did !== payload['did']) throw new Error(BACKUP_ERROR);
        } catch { throw new Error(BACKUP_ERROR); }
        if (generation !== this.generation || await this.options.binding() !== binding) throw new Error(CANCELLED);
        if (generation !== this.generation) throw new Error(CANCELLED);
        await this.options.store.save(restored); ++this.revision; this.saved = restored;
        if (generation !== this.generation || await this.options.binding() !== binding) throw new Error(CANCELLED);
        if (generation !== this.generation) throw new Error(CANCELLED);
        return this.view(restored);
      } finally { key?.fill(0); plaintext?.fill(0); this.stop(); this.resetting = false; }
    });
  }
  forget(): Promise<LocalIdentityStatus> {
    if (this.resetting) return Promise.reject(new Error('Local identity setup is changing. Please wait a moment.'));
    this.resetting = true;
    this.stop(); ++this.revision;
    return this.owner(async () => {
      try { await this.options.store.save(null); ++this.revision; this.saved = null; return this.view(null); }
      catch (error) { ++this.revision; this.saved = undefined; throw error; }
      finally { this.stop(); this.resetting = false; }
    });
  }
}
