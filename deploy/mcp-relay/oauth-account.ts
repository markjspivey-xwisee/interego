/** Read-only, bearer-bound account metadata. This is a custom Interego affordance,
 * not OpenID Connect userinfo and never a token-introspection oracle. */
import type { RequestHandler } from 'express';
import { createHash } from 'node:crypto';

export interface OAuthAccountGrant {
  valid: true; userId: string; ownerWebId: string; ownerDid?: string; podUrl: string;
  agentId: string; clientId: string; scope: string[]; expiresAt: number; provisionalPlay?: unknown;
}
export interface OAuthAccountBacking extends OAuthAccountGrant { identityToken: string; }
export type ValidateBackingIdentity = (grant: OAuthAccountGrant, oauthToken: string, signal: AbortSignal) => Promise<boolean>;
/** Fixed, uncached native identity verification. Native credentials stay within
 * the relay; the public handler only receives the boolean verification result. */
export function nativeBackingIdentityValidator(options: {
  identityUrl: string;
  introspectionSecret(): string | undefined;
  lookupOAuth(token: string): Promise<OAuthAccountBacking | null>;
  publicPod(url: string): string | undefined;
  fetch?: typeof fetch; now?: () => number;
}): ValidateBackingIdentity {
  const identity = new URL(options.identityUrl);
  if (!['https:', 'http:'].includes(identity.protocol) || identity.username || identity.password || identity.search || identity.hash || identity.pathname !== '/') throw Error('Invalid native identity endpoint');
  const target = new URL('/tokens/verify', identity).href;
  function unavailable(): never { throw Error('Native account verification unavailable'); }
  return async (grant, token, signal) => {
    const secret = options.introspectionSecret();
    if (typeof secret !== 'string' || !secret || secret.length > 8192 || /[^\x21-\x7e]/.test(secret)) unavailable();
    const backing = await options.lookupOAuth(token);
    if (!backing || grantFingerprint(backing) !== grantFingerprint(grant) || typeof backing.identityToken !== 'string'
      || !/^[\x21-\x7e]{1,8192}$/.test(backing.identityToken)) return false;
    if (signal.aborted) unavailable();
    const response = await (options.fetch ?? fetch)(target, { method: 'POST', redirect: 'error', signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store', 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
      body: JSON.stringify({ token: backing.identityToken }) });
    if (response.redirected || response.url && response.url !== target) { await response.body?.cancel(); unavailable(); }
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); return false; }
    if (!response.ok) { await response.body?.cancel(); unavailable(); }
    const limit = 64 * 1024, length = response.headers.get('content-length');
    if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel(); unavailable(); }
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (signal.aborted) unavailable();
        if (part.done) break; size += part.value.byteLength; if (size > limit) unavailable(); chunks.push(part.value);
      }
    } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); } catch { return unavailable(); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return unavailable();
    const value = raw as Record<string, unknown>;
    if (value.valid === false) {
      if (value.unreadable === true || value.reason === 'Could not read the account for this token; try again') unavailable();
      return false;
    }
    if (value.valid !== true) return unavailable();
    const webId = new URL(grant.ownerWebId), prefix = `did:web:${webId.host.replace(/:/g, '%3A')}:agents:`;
    const agent = grant.agentId.startsWith(prefix) ? grant.agentId.slice(prefix.length) : '';
    const owner = `did:web:${webId.host.replace(/:/g, '%3A')}:users:${grant.userId}`;
    const expiry = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : NaN;
    return value.userId === grant.userId && value.ownerDid === owner && value.webId === grant.ownerWebId
      && value.agentId === agent && !!agent && value.provisionalPlay === undefined
      && typeof value.podUrl === 'string' && options.publicPod(value.podUrl) === options.publicPod(grant.podUrl)
      && options.publicPod(value.podUrl) !== undefined && Number.isFinite(expiry) && expiry > (options.now?.() ?? Date.now()) && !signal.aborted;
  };
}
function grantFingerprint(grant: OAuthAccountGrant): string {
  return JSON.stringify([grant.valid, grant.userId, grant.ownerWebId, grant.ownerDid ?? null, grant.podUrl,
    grant.agentId, grant.clientId, grant.scope, grant.expiresAt, grant.provisionalPlay !== undefined]);
}
export interface OAuthAccountLimits {
  windowMs: number; perAccount: number; invalidPerIp: number; invalidGlobal: number; accountEntries: number; invalidIpEntries: number;
}
type Bucket = { at: number; count: number };
/** Verified people never spend another person's budget merely by sharing an IP.
 * Unknown token strings never become keys, and both limiter maps have hard caps. */
class AccountLimits {
  private readonly accounts = new Map<string, Bucket>();
  private readonly invalidIps = new Map<string, Bucket>();
  private invalid: Bucket = { at: 0, count: 0 };
  readonly limits: OAuthAccountLimits;
  constructor(private readonly now: () => number, limits?: Partial<OAuthAccountLimits>) {
    this.limits = { windowMs: 60_000, perAccount: 240, invalidPerIp: 20, invalidGlobal: 240, accountEntries: 4096, invalidIpEntries: 512, ...limits };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 60_000)) throw Error('Invalid account rate limits');
  }
  private hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
  private spend(map: Map<string, Bucket>, key: string, limit: number, capacity: number): boolean {
    const now = this.now(); let bucket = map.get(key);
    if (bucket && bucket.at + this.limits.windowMs <= now) { map.delete(key); bucket = undefined; }
    if (!bucket) {
      if (map.size >= capacity) for (const [k, v] of map) if (v.at + this.limits.windowMs <= now) map.delete(k);
      if (map.size >= capacity) return false;
      bucket = { at: now, count: 0 }; map.set(key, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count++; return true;
  }
  account(subject: string, client: string): boolean {
    return this.spend(this.accounts, this.hash(JSON.stringify([subject, client])), this.limits.perAccount, this.limits.accountEntries);
  }
  unproven(ip: string): boolean {
    const now = this.now();
    if (this.invalid.at + this.limits.windowMs <= now) this.invalid = { at: now, count: 0 };
    if (this.invalid.count >= this.limits.invalidGlobal) return false;
    this.invalid.count++;
    return this.spend(this.invalidIps, this.hash(ip), this.limits.invalidPerIp, this.limits.invalidIpEntries);
  }
}
export function oauthAccountHandler(options: {
  introspect(token: string): OAuthAccountGrant | null;
  identityOrigin: string;
  podOrigin: string;
  publicPod(url: string): string | undefined;
  /** Required in production; an omitted verifier refuses every account read. */
  validateBackingIdentity?: ValidateBackingIdentity;
  now?: () => number;
  /** Program-only fixture/operator policy; never taken from a request. */
  limits?: Partial<OAuthAccountLimits>;
}): RequestHandler {
  const limiter = new AccountLimits(options.now ?? Date.now, options.limits);
  let active = 0;
  let identity: URL | undefined;
  try { const u = new URL(options.identityOrigin); if (u.protocol === 'https:' && u.pathname === '/' && !u.username && !u.password && !u.search && !u.hash) identity = u; } catch { /* unavailable in local development */ }
  return async (req, res) => {
    res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').set('X-Content-Type-Options', 'nosniff');
    const limited = () => { res.set('Retry-After', String(Math.ceil(limiter.limits.windowMs / 1000))).status(429).json({ error: 'account_metadata_rate_limited' }); };
    const no = (status: number, code: string) => {
      if (!limiter.unproven(req.ip ?? req.socket.remoteAddress ?? 'unknown')) { limited(); return; }
      res.status(status).json({ error: code });
    };
    if (!identity) { no(503, 'account_metadata_unavailable'); return; }
    if (Object.keys(req.query).length) { no(400, 'account_metadata_takes_no_parameters'); return; }
    const match = /^Bearer ([\x21-\x7e]{1,8192})$/i.exec(req.get('Authorization') ?? '');
    if (!match) { no(401, 'account_bearer_required'); return; }
    try {
      const grant = options.introspect(match[1]!);
      if (!grant || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt * 1000 <= (options.now?.() ?? Date.now()) || grant.provisionalPlay !== undefined) { no(401, 'account_sign_in_expired'); return; }
      if (!Array.isArray(grant.scope) || !grant.scope.includes('mcp:read')) { no(403, 'account_read_scope_required'); return; }
      const id = grant.userId;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id)) { no(403, 'account_identity_invalid'); return; }
      const subject = `did:web:${identity.host.replace(/:/g, '%3A')}:users:${id}`;
      const webId = `${identity.origin}/users/${id}/profile#me`;
      const prefix = `did:web:${identity.host.replace(/:/g, '%3A')}:agents:`;
      const agentSlug = grant.agentId.startsWith(prefix) ? grant.agentId.slice(prefix.length) : '';
      const named = /-(u-(?:pk|eth|did)-[0-9a-f]{12})$/.exec(agentSlug)?.[1];
      const podUrl = options.publicPod(grant.podUrl);
      const pod = podUrl ? new URL(podUrl) : null, expectedPodOrigin = new URL(options.podOrigin).origin;
      if (grant.ownerWebId !== webId || grant.ownerDid !== undefined && grant.ownerDid !== subject
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(agentSlug) || named && named !== id
        || !grant.clientId || grant.clientId.length > 2048 || !pod || pod.origin !== expectedPodOrigin || pod.protocol !== 'https:' || pod.username || pod.password || pod.search || pod.hash || pod.pathname !== `/${id}/`) { no(403, 'account_identity_invalid'); return; }
      if (!limiter.account(subject, grant.clientId)) { limited(); return; }
      if (!options.validateBackingIdentity || active >= 16) { no(503, 'account_metadata_unavailable'); return; }
      // Detach the grant before awaiting private verification. Neither a revoked
      // OAuth grant nor a changed client/account can survive this await.
      const bound: OAuthAccountGrant = { valid: true, userId: grant.userId, ownerWebId: grant.ownerWebId,
        ...(grant.ownerDid === undefined ? {} : { ownerDid: grant.ownerDid }), podUrl: grant.podUrl, agentId: grant.agentId,
        clientId: grant.clientId, scope: [...grant.scope], expiresAt: grant.expiresAt };
      Object.freeze(bound.scope); Object.freeze(bound);
      const fingerprint = grantFingerprint(bound), controller = new AbortController();
      let rejectDeadline!: () => void;
      const deadline = new Promise<never>((_, reject) => { rejectDeadline = () => reject(Error('Account verification deadline')); });
      const timer = setTimeout(() => { controller.abort(); rejectDeadline(); }, 5000); timer.unref();
      const close = () => { if (!res.writableEnded) { controller.abort(); rejectDeadline(); } }; res.on('close', close);
      active++;
      let verified: boolean;
      try { verified = await Promise.race([options.validateBackingIdentity(bound, match[1]!, controller.signal), deadline]); }
      finally { clearTimeout(timer); res.off('close', close); controller.abort(); active--; }
      if (res.writableEnded || res.destroyed) return;
      if (verified !== true) { no(401, 'account_sign_in_expired'); return; }
      const current = options.introspect(match[1]!);
      if (!current || grantFingerprint(current) !== fingerprint || current.expiresAt * 1000 <= (options.now?.() ?? Date.now())) { no(401, 'account_sign_in_expired'); return; }
      res.json({ userId: id, ownerDid: subject, webId, podUrl: pod.href, agentId: grant.agentId,
        clientId: bound.clientId, scope: bound.scope.join(' '), expiresAt: bound.expiresAt });
    } catch { if (!res.writableEnded && !res.destroyed) no(503, 'account_metadata_unavailable'); }
  };
}
