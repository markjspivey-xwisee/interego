/** Short-lived capabilities that bind native-held sign-in to an existing OAuth ceremony. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CONTEXT_PREFIX = 'interego-login:v1:';
const COMPLETION_PREFIX = 'interego-login-result:v1:';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PENDING = /^[a-f0-9]{32}$/;
const TTL = 2 * 60_000;
const SCOPES = new Set(['mcp', 'mcp:read', 'mcp:write', 'federation:manage']);
const failure = 'This local sign-in request expired or could not be verified. Start sign-in again.';

export interface LocalIdentityPending {
  readonly pendingId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly codeChallenge: string;
  readonly state: string;
  readonly expiresAt: number;
}
export interface LocalIdentityChallenge { readonly nonce: string; readonly message: string; readonly expiresAt: string }
export interface LocalIdentityContext {
  readonly version: 1;
  readonly issuer: string;
  readonly identityOrigin: string;
  readonly pendingId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly resource: string | null;
  readonly codeChallenge: string;
  readonly stateDigest: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly message: string;
  readonly challengeExpiresAt: string;
  readonly completionCode: string;
}
export interface LocalIdentityHandoffOptions {
  readonly issuer: string;
  readonly identityOrigin: string;
  readonly pending: (id: string) => LocalIdentityPending | undefined;
  readonly challenge: (signal: AbortSignal) => Promise<LocalIdentityChallenge>;
  readonly now?: () => number;
}
interface Record {
  readonly id: string;
  readonly pendingId: string;
  readonly binding: string;
  readonly contextHash: string;
  readonly expiresAt: number;
  claimed: boolean;
  completionHash?: string;
  nonce?: string;
  challengeExpiresAt?: number;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('base64url'); }
function secret(): string { return randomBytes(32).toString('base64url'); }
function equal(a: string, b: string): boolean { return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
function origin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port || !url.hostname.includes('.') || url.hostname.startsWith('[')) throw new Error('Local identity handoff requires configured HTTPS origins.');
  return url.origin;
}
function clean(value: string, maximum: number): boolean { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value); }
function validate(pending: LocalIdentityPending): void {
  if (!PENDING.test(pending.pendingId) || !clean(pending.clientId, 2048) || !clean(pending.clientName, 160)
    || !clean(pending.state, 1024) || !TOKEN.test(pending.codeChallenge) || !Number.isSafeInteger(pending.expiresAt)
    || !Array.isArray(pending.scopes) || !pending.scopes.length || pending.scopes.length > 4
    || new Set(pending.scopes).size !== pending.scopes.length || pending.scopes.some(scope => !SCOPES.has(scope))) throw new Error(failure);
  const redirect = new URL(pending.redirectUri);
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash || !clean(pending.redirectUri, 4096)) throw new Error(failure);
  if (pending.resource !== null) {
    const resource = new URL(pending.resource);
    if (resource.protocol !== 'https:' || resource.username || resource.password || resource.hash || !clean(pending.resource, 4096)) throw new Error(failure);
  }
}
function binding(pending: LocalIdentityPending): string {
  validate(pending);
  return hash(JSON.stringify([pending.pendingId, pending.clientId, pending.clientName, pending.redirectUri, pending.scopes,
    pending.resource, pending.codeChallenge, pending.state, pending.expiresAt]));
}
function decode(code: string, prefix: string): { id: string; token: string } {
  if (typeof code !== 'string' || code.length > 256 || !code.startsWith(prefix)) throw new Error(failure);
  const [id, token, extra] = code.slice(prefix.length).split('.');
  if (!id || !token || extra !== undefined || !TOKEN.test(id) || !TOKEN.test(token)) throw new Error(failure);
  return { id, token };
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(failure));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error(failure)); signal.addEventListener('abort', abort, { once: true });
    operation.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Stores only hashes of capabilities. Nothing here accepts a caller-selected identity or account. */
export class LocalIdentityHandoffs {
  private readonly records = new Map<string, Record>();
  private readonly byPending = new Map<string, string>();
  private readonly issuer: string;
  private readonly identityOrigin: string;
  constructor(private readonly options: LocalIdentityHandoffOptions) { this.issuer = origin(options.issuer); this.identityOrigin = origin(options.identityOrigin); }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private prune(): void {
    for (const [id, record] of this.records) if (record.expiresAt <= this.now()) this.drop(id);
  }
  private drop(id: string): void {
    const record = this.records.get(id);
    if (record && this.byPending.get(record.pendingId) === id) this.byPending.delete(record.pendingId);
    this.records.delete(id);
  }
  private current(record: Record): LocalIdentityPending {
    const pending = this.options.pending(record.pendingId);
    if (record.expiresAt <= this.now() || !pending || pending.expiresAt <= this.now() || binding(pending) !== record.binding) throw new Error(failure);
    return pending;
  }
  issue(pendingId: string): { handoffCode: string; expiresAt: string } {
    this.prune();
    const pending = this.options.pending(pendingId);
    if (!pending || pending.expiresAt <= this.now()) throw new Error(failure);
    const digest = binding(pending);
    const prior = this.byPending.get(pendingId); if (prior) this.drop(prior);
    if (this.records.size >= 128) throw new Error('Local sign-in is busy. Use another sign-in method or try again shortly.');
    const id = secret(); const token = secret(); const expiresAt = Math.min(pending.expiresAt, this.now() + TTL);
    this.records.set(id, { id, pendingId, binding: digest, contextHash: hash(token), expiresAt, claimed: false }); this.byPending.set(pendingId, id);
    return { handoffCode: CONTEXT_PREFIX + id + '.' + token, expiresAt: new Date(expiresAt).toISOString() };
  }
  async context(handoffCode: string, signal?: AbortSignal): Promise<LocalIdentityContext> {
    this.prune(); const decoded = decode(handoffCode, CONTEXT_PREFIX); const record = this.records.get(decoded.id);
    if (!record || record.claimed || !equal(hash(decoded.token), record.contextHash)) throw new Error(failure);
    this.current(record); record.claimed = true; // One claim before provider I/O.
    const cancel = new AbortController(); const timer = setTimeout(() => cancel.abort(), 15_000);
    const abort = () => cancel.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) cancel.abort();
    try {
      if (cancel.signal.aborted) throw new Error(failure);
      const challenge = await bounded(this.options.challenge(cancel.signal), cancel.signal);
      const pending = this.current(record);
      if (this.records.get(record.id) !== record) throw new Error(failure);
      const challengeExpiry = Date.parse(challenge.expiresAt);
      if (!TOKEN.test(challenge.nonce) || challenge.message !== `Interego DID sign-in v1\nHost: ${new URL(this.identityOrigin).host}\nNonce: ${challenge.nonce}`
        || !Number.isFinite(challengeExpiry) || challengeExpiry <= this.now() || challengeExpiry > this.now() + 5 * 60_000 + 30_000) throw new Error(failure);
      const token = secret(); record.completionHash = hash(token); record.nonce = challenge.nonce; record.challengeExpiresAt = challengeExpiry;
      return { version: 1, issuer: this.issuer, identityOrigin: this.identityOrigin, pendingId: pending.pendingId, clientId: pending.clientId,
        clientName: pending.clientName, redirectUri: pending.redirectUri, scopes: [...pending.scopes], resource: pending.resource,
        codeChallenge: pending.codeChallenge, stateDigest: hash(pending.state), expiresAt: new Date(Math.min(record.expiresAt, challengeExpiry)).toISOString(),
        nonce: challenge.nonce, message: challenge.message, challengeExpiresAt: challenge.expiresAt, completionCode: COMPLETION_PREFIX + record.id + '.' + token };
    } catch { this.drop(record.id); throw new Error(failure); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); cancel.abort(); }
  }
  /** Consumed before /auth/did is invoked. Native credentials cannot become a generic proof relay. */
  consume(completionCode: string, pendingId: string, nonce: unknown): void {
    this.prune(); const decoded = decode(completionCode, COMPLETION_PREFIX); const record = this.records.get(decoded.id);
    if (!record || !record.completionHash || !equal(hash(decoded.token), record.completionHash)) throw new Error(failure);
    this.drop(record.id); // A valid capability gets exactly one submission, including a refusal.
    this.current(record);
    if (!record.claimed || record.pendingId !== pendingId || !record.nonce || record.nonce !== nonce
      || !record.challengeExpiresAt || record.challengeExpiresAt <= this.now()) throw new Error(failure);
  }
}
