/** Human sign-in is independent of the model driving Ask. Relay credentials never
 * leave this server; the browser receives only an opaque, HttpOnly session cookie. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { routeJson } from './route-json.js';
import { guardedFetchFn } from './ssrf-guard.js';

type Row = Record<string, unknown>;
export interface LearningPrincipal {
  subject: string; userId: string; webId: string; podUrl: string; sessionId: string;
  expiresAt: number; signal: AbortSignal;
  /** Present only on a provisional guest (browser-key possession, no human credential). Routes
   * refuse a guest unless they pass `allowGuest` to resolve(): see GUEST_LEARNING_OPERATIONS. */
  guest?: true;
}
/** What Foxxi asks its service agent to sign so identity will provision a guest for one browser key. */
export interface GuestGrantRequest { audience: string; publicKeyThumbprint: string; challenge: string }
/** Signs a grant as this application's registered service agent (the relay's `sign_request` envelope).
 * The signer sets the grant's purpose and its short expiry; both are checked on what it returns. */
export type GuestGrantSigner = (request: GuestGrantRequest, signal: AbortSignal) => Promise<{ _signed_payload: string; _signature: string }>;
export interface LearningAccountAuthConfig {
  baseUrl: string; relayOrigin: string; identityOrigin: string; podOrigin: string;
  /** Program-only transport/clock injection for isolated fixtures. */
  fetch?: typeof fetch; now?: () => number; maxSessions?: number; maxPending?: number;
  /** Guest sign-in exists only where this is supplied. Never read from HTTP. */
  guestGrant?: GuestGrantSigner;
}
export class LearningAuthError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
type Account = { subject: string; userId: string; webId: string; podUrl: string; agentId: string; clientId: string; expiresAt: number };
/** Public proof material identity re-checks against the guest's live pod anchor. Not a bearer. */
type GuestProof = { attestation: string; challenge: string; proof: string; checkedAt: number };
type Session = { hash: string; principal: LearningPrincipal; account: Account; token: string; csrf: string; lifetime: AbortController; timer: ReturnType<typeof setTimeout>; guest?: GuestProof };
type Pending = { hash: string; state: string; verifier: string; expires: number; prior: string | null; claimed: boolean; lifetime: AbortController };
type Endpoints = { authorization: string; token: string; account: string; resource: string };
const PREFIX = '/i2idlx/learning';
const COOKIE = '__Host-i2idlx-learning', PENDING_COOKIE = '__Host-i2idlx-learning-pending';
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const opaque = () => randomBytes(32).toString('hex');
const B64URL = /^[A-Za-z0-9_-]+$/;
/** How long one identity check of a guest's anchor stands before the next request repeats it. */
const GUEST_RECHECK_MS = 30_000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function refuse(status: number, code: string): never { throw new LearningAuthError(status, code); }
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
function origin(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/'
    || /^(?:localhost|.*\.localhost|127\..*|\[?::1\]?)$/i.test(u.hostname)) throw Error('Public HTTPS origin required');
  return u.origin;
}
function cookie(req: Request, name: string): string | null {
  const values = (req.get('Cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function setCookie(res: Response, name: string, value: string, maxAge: number): void {
  res.cookie(name, value, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: Math.max(0, maxAge) });
}
function secure(res: Response): void {
  res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
}
function answerError(res: Response, error: unknown): void {
  secure(res);
  res.status(error instanceof LearningAuthError ? error.status : 503).json({ error: error instanceof LearningAuthError ? error.code : 'learning_sign_in_unavailable' });
}

export class LearningAccountAuth {
  readonly enabled: boolean;
  readonly base: string;
  readonly clientId: string;
  readonly callbackUrl: string;
  private readonly relay: string;
  private readonly identity: string;
  private readonly pod: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, Pending>();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private endpoints?: { value: Endpoints; expires: number };
  private active = 0;
  private readonly maxSessions: number;
  private readonly maxPending: number;
  private readonly guestGrant?: GuestGrantSigner;
  private readonly guestChallenges = new Map<string, number>();
  /** Whether a provisional guest can sign in here at all. */
  get guestEnabled(): boolean { return this.enabled && !!this.guestGrant; }
  constructor(config: LearningAccountAuthConfig) {
    let base = '', relay = '', identity = '', pod = '';
    try { base = origin(config.baseUrl); relay = origin(config.relayOrigin); identity = origin(config.identityOrigin); pod = origin(config.podOrigin); } catch { /* ordinary HTTP development keeps working without human sign-in */ }
    this.enabled = !!(base && relay && identity && pod);
    this.base = base; this.relay = relay; this.identity = identity; this.pod = pod;
    this.clientId = base + PREFIX + '/oauth/client.json'; this.callbackUrl = base + PREFIX + '/oauth/callback';
    this.fetcher = config.fetch ?? guardedFetchFn(globalThis.fetch) as typeof fetch;
    this.now = config.now ?? Date.now;
    this.guestGrant = config.guestGrant;
    this.maxSessions = config.maxSessions ?? 500; this.maxPending = config.maxPending ?? 200;
    if (![this.maxSessions, this.maxPending].every(v => Number.isSafeInteger(v) && v >= 1 && v <= 2000)) throw Error('Invalid learning session capacity');
  }
  private ready(): void { if (!this.enabled) refuse(503, 'learning_sign_in_unavailable'); }
  private admit(key: string, limit: number): void {
    const now = this.now();
    for (const [k, rate] of this.rates) if (rate.at + 60_000 <= now) this.rates.delete(k);
    const rate = this.rates.get(key);
    if (rate && rate.count >= limit || !rate && this.rates.size >= 2000) refuse(429, 'learning_sign_in_busy');
    if (rate) rate.count++; else this.rates.set(key, { at: now, count: 1 });
  }
  private sweep(): void {
    const now = this.now();
    for (const [key, p] of this.pending) if (p.expires <= now) this.dropPending(key);
    for (const [key, expires] of this.guestChallenges) if (expires <= now) this.guestChallenges.delete(key);
    for (const [key, s] of this.sessions) if (s.principal.expiresAt <= now) this.drop(key);
  }
  private drop(key: string): void {
    const s = this.sessions.get(key);
    if (s) { this.sessions.delete(key); s.token = ''; s.lifetime.abort(); clearTimeout(s.timer); }
    for (const [pendingKey, pending] of this.pending) if (pending.prior === key) this.dropPending(pendingKey);
  }
  private dropPending(key: string): void { const p = this.pending.get(key); if (p) { this.pending.delete(key); p.verifier = ''; p.lifetime.abort(); } }
  dispose(): void { for (const key of this.sessions.keys()) this.drop(key); for (const key of this.pending.keys()) this.dropPending(key); this.rates.clear(); this.guestChallenges.clear(); this.endpoints = undefined; }
  private async json(url: string, init: RequestInit = {}, lifetime?: AbortSignal): Promise<Row> {
    if (this.active >= 8) refuse(429, 'learning_sign_in_busy');
    this.active++;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    const signal = lifetime ? AbortSignal.any([controller.signal, lifetime]) : controller.signal;
    try {
      const headers = new Headers(init.headers); headers.set('Cache-Control', 'no-store');
      const r = await this.fetcher(url, { ...init, headers, redirect: 'manual', signal });
      if (r.url && r.url !== url || r.status >= 300 && r.status < 400) refuse(503, 'learning_sign_in_unavailable');
      if (!r.ok) { await r.body?.cancel(); refuse(r.status === 401 || r.status === 403 ? 401 : 503, r.status === 401 || r.status === 403 ? 'learning_session_expired' : 'learning_sign_in_unavailable'); }
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = r.body?.getReader();
      if (!reader) refuse(503, 'learning_sign_in_unavailable');
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 64 * 1024) { await reader.cancel(); refuse(503, 'learning_sign_in_unavailable'); } chunks.push(chunk.value); } }
      finally { reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!object(value)) refuse(503, 'learning_sign_in_unavailable');
      return value;
    } catch (error) { if (error instanceof LearningAuthError) throw error; refuse(503, 'learning_sign_in_unavailable'); }
    finally { clearTimeout(timer); this.active--; }
  }
  private endpoint(raw: unknown, path?: string): string {
    if (typeof raw !== 'string') refuse(503, 'learning_sign_in_unavailable');
    let u: URL; try { u = new URL(raw); } catch { refuse(503, 'learning_sign_in_unavailable'); }
    if (u.origin !== this.relay || u.username || u.password || u.hash || u.search || path && u.pathname !== path) refuse(503, 'learning_sign_in_unavailable');
    return u.href;
  }
  private async discover(): Promise<Endpoints> {
    this.ready();
    if (this.endpoints && this.endpoints.expires > this.now()) return this.endpoints.value;
    const m = await this.json(this.relay + '/.well-known/oauth-authorization-server');
    if (m.issuer !== this.relay + '/' && m.issuer !== this.relay || m.client_id_metadata_document_supported !== true
      || !Array.isArray(m.code_challenge_methods_supported) || !m.code_challenge_methods_supported.includes('S256')
      || !Array.isArray(m.scopes_supported) || !m.scopes_supported.includes('mcp:read')) refuse(503, 'learning_sign_in_unavailable');
    const p = await this.json(this.relay + '/.well-known/oauth-protected-resource');
    if (p.resource !== this.relay + '/' || !Array.isArray(p.authorization_servers) || !p.authorization_servers.some(v => v === this.relay || v === this.relay + '/')) refuse(503, 'learning_sign_in_unavailable');
    const value = { authorization: this.endpoint(m.authorization_endpoint), token: this.endpoint(m.token_endpoint),
      account: this.endpoint(m.interego_account_endpoint, '/oauth/account'), resource: this.relay + '/' };
    this.endpoints = { value, expires: this.now() + 300_000 }; return value;
  }
  private async account(token: string, signal?: AbortSignal): Promise<Account> {
    const ep = await this.discover();
    const a = await this.json(ep.account, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }, signal);
    const id = a.userId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id)) refuse(401, 'learning_account_invalid');
    const subject = `did:web:${new URL(this.identity).host.replace(/:/g, '%3A')}:users:${id}`;
    const prefix = `did:web:${new URL(this.identity).host.replace(/:/g, '%3A')}:agents:`;
    const slug = typeof a.agentId === 'string' && a.agentId.startsWith(prefix) ? a.agentId.slice(prefix.length) : '';
    const named = /-(u-(?:pk|eth|did)-[0-9a-f]{12})$/.exec(slug)?.[1];
    if (a.ownerDid !== subject || a.webId !== `${this.identity}/users/${id}/profile#me` || a.podUrl !== `${this.pod}/${id}/`
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(slug) || named && named !== id || a.clientId !== this.clientId
      || a.scope !== 'mcp:read' || a.provisionalPlay !== undefined || !Number.isSafeInteger(a.expiresAt) || Number(a.expiresAt) * 1000 <= this.now()) refuse(401, 'learning_account_invalid');
    return { subject, userId: id, webId: a.webId as string, podUrl: a.podUrl as string,
      agentId: a.agentId as string, clientId: this.clientId, expiresAt: Number(a.expiresAt) * 1000 };
  }
  /** A guest session is refused unless the route opts in: a route nobody decided about stays closed to guests. */
  async resolve(req: Request, options: { allowGuest?: boolean } = {}): Promise<LearningPrincipal> {
    this.ready(); this.sweep();
    const value = cookie(req, COOKIE), s = value ? this.sessions.get(hash(value)) : undefined;
    if (!s) refuse(401, 'learning_sign_in_required');
    if (s.guest && options.allowGuest !== true) refuse(403, 'learning_guest_refused');
    return this.validateSession(s);
  }
  /**
   * Asks identity whether this attestation, with this browser-key proof over this challenge, is a
   * live guest of THIS application. Identity checks its own signature on the attestation, the proof,
   * the original deadline and the owner's pod anchor; every canonical field is checked again here.
   */
  private async guestAccount(proof: Pick<GuestProof, 'attestation' | 'challenge' | 'proof'>, signal?: AbortSignal): Promise<Account> {
    const v = await this.json(this.identity + '/play/provisional/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ attestation: proof.attestation, audience: this.base, challenge: proof.challenge, proof: proof.proof }) }, signal);
    const id = v.userId, host = new URL(this.identity).host.replace(/:/g, '%3A');
    if (typeof id !== 'string' || !/^u-try-play-[0-9a-f]{32}$/.test(id)) refuse(401, 'learning_account_invalid');
    const subject = `did:web:${host}:users:${id}`, agentPrefix = `did:web:${host}:agents:`;
    const expiresAt = typeof v.expiresAt === 'string' ? Date.parse(v.expiresAt) : NaN;
    if (v.valid !== true || v.provisional !== true || v.issuer !== this.identity || v.audience !== this.base
      || v.ownerDid !== subject || v.webId !== `${this.identity}/users/${id}/profile#me` || v.podUrl !== `${this.pod}/${id}/`
      || typeof v.authenticatedAgentDid !== 'string' || !v.authenticatedAgentDid.startsWith(agentPrefix)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(v.authenticatedAgentDid.slice(agentPrefix.length))
      || !Number.isFinite(expiresAt) || expiresAt <= this.now()) refuse(401, 'learning_account_invalid');
    return { subject, userId: id, webId: v.webId as string, podUrl: v.podUrl as string,
      agentId: v.authenticatedAgentDid as string, clientId: 'interego-play-provisional', expiresAt };
  }
  /** Program-only revalidation for an already authenticated task. A session id
   * from request JSON is never a replacement for resolve(req)'s cookie check. */
  async revalidate(principal: LearningPrincipal): Promise<LearningPrincipal> {
    this.ready(); this.sweep();
    const s = [...this.sessions.values()].find(value => value.principal.sessionId === principal.sessionId);
    if (!s || s.principal.subject !== principal.subject || s.principal.userId !== principal.userId
      || s.principal.webId !== principal.webId || s.principal.podUrl !== principal.podUrl || s.principal.signal !== principal.signal) refuse(401, 'learning_session_expired');
    return this.validateSession(s);
  }
  private async validateSession(s: Session): Promise<LearningPrincipal> {
    this.admit('session:' + s.hash, 120);
    try {
      if (s.guest && this.now() - s.guest.checkedAt < GUEST_RECHECK_MS && this.now() < s.principal.expiresAt && !s.lifetime.signal.aborted) return { ...s.principal };
      const account = s.guest ? await this.guestAccount(s.guest, s.lifetime.signal) : await this.account(s.token, s.lifetime.signal);
      if (s.guest) s.guest.checkedAt = this.now();
      if (this.sessions.get(s.hash) !== s || s.lifetime.signal.aborted || this.now() >= s.principal.expiresAt
        || ['subject', 'userId', 'webId', 'podUrl', 'agentId', 'clientId'].some(k => account[k as keyof Account] !== s.account[k as keyof Account])) refuse(401, 'learning_session_expired');
      if (account.expiresAt < s.principal.expiresAt) { s.principal.expiresAt = account.expiresAt; clearTimeout(s.timer); s.timer = this.expire(s.hash, account.expiresAt); }
      return { ...s.principal };
    } catch (error) {
      // Neither a lost grant nor an unavailable authority can leave a queued
      // private task alive. A fresh human sign-in establishes a new binding.
      if (error instanceof LearningAuthError && [401, 503].includes(error.status)) this.drop(s.hash);
      throw error;
    }
  }
  async status(req: Request): Promise<Row> {
    const basic = { authenticated: false, enabled: this.enabled, account: null, csrf: null, expires_at: null,
      sign_in_url: this.enabled ? PREFIX + '/oauth/start' : null,
      ...(this.guestEnabled ? { guest_sign_in: { grant_url: PREFIX + '/guest/grant', challenge_url: PREFIX + '/guest/challenge', session_url: PREFIX + '/guest/session',
        bootstrap_url: this.identity + '/play/provisional', audience: this.base } } : {}) };
    if (!this.enabled || !cookie(req, COOKIE)) return basic;
    try {
      const p = await this.resolve(req, { allowGuest: true }), s = this.sessionFor(req, p);
      return { ...basic, authenticated: true, account: { id: p.subject, userId: p.userId, webId: p.webId }, csrf: s.csrf, expires_at: new Date(p.expiresAt).toISOString(),
        ...(p.guest ? { guest: true } : {}) };
    } catch (error) { if (error instanceof LearningAuthError && error.status === 401) return basic; throw error; }
  }
  private sessionFor(req: Request, p: LearningPrincipal): Session {
    const value = cookie(req, COOKIE), s = value ? this.sessions.get(hash(value)) : undefined;
    if (!s || s.principal.sessionId !== p.sessionId || s.principal.subject !== p.subject || s.lifetime.signal.aborted || s.principal.expiresAt <= this.now()) refuse(401, 'learning_session_expired');
    return s;
  }
  assertMutation(req: Request, principal: LearningPrincipal): void {
    const s = this.sessionFor(req, principal);
    const csrf = req.get('X-I2IDLX-Learning-CSRF');
    if (Object.keys(req.query).length || req.get('Origin') !== this.base || !csrf || !/^[a-f0-9]{64}$/.test(csrf) || !equal(csrf, s.csrf)) refuse(403, 'learning_csrf_refused');
  }
  private expire(key: string, at: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.drop(key), Math.max(1, at - this.now())); timer.unref(); return timer;
  }
  clientDocument(): Row {
    this.ready();
    return { client_id: this.clientId, client_name: 'I2IDL-X Learning', client_uri: this.base + '/i2idlx/#ask',
      redirect_uris: [this.callbackUrl], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'mcp:read' };
  }
  async start(req: Request, res: Response): Promise<void> {
    this.ready(); this.sweep(); this.admit('start:' + (req.ip ?? 'unknown'), 10); this.admit('starts', 100);
    if (Object.keys(req.query).length || req.get('Origin') && req.get('Origin') !== this.base) refuse(400, 'learning_sign_in_input_invalid');
    const oldPending = cookie(req, PENDING_COOKIE); if (oldPending) this.dropPending(hash(oldPending));
    if (this.pending.size >= this.maxPending) refuse(429, 'learning_sign_in_busy');
    // The cookie is only a random lookup handle; OAuth credentials stay server-side.
    const endpoints = await this.discover(), pendingHandle = opaque();
    if (this.pending.size >= this.maxPending) refuse(429, 'learning_sign_in_busy');
    const prior = cookie(req, COOKIE), priorHash = prior ? hash(prior) : null;
    const record = { hash: hash(pendingHandle), state: opaque(), verifier: randomBytes(32).toString('base64url'), expires: this.now() + 300_000,
      prior: priorHash && this.sessions.has(priorHash) ? priorHash : null, claimed: false, lifetime: new AbortController() };
    this.pending.set(record.hash, record);
    const url = new URL(endpoints.authorization);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: this.clientId, redirect_uri: this.callbackUrl, scope: 'mcp:read',
      resource: endpoints.resource, state: record.state, code_challenge: createHash('sha256').update(record.verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
    setCookie(res, PENDING_COOKIE, pendingHandle, 300_000); secure(res); res.redirect(302, url.href);
  }
  async callback(req: Request, res: Response): Promise<void> {
    this.ready(); this.sweep(); this.admit('callbacks', 100);
    const pendingHandle = cookie(req, PENDING_COOKIE), pending = pendingHandle ? this.pending.get(hash(pendingHandle)) : undefined;
    setCookie(res, PENDING_COOKIE, '', 0);
    const { code, state } = req.query;
    if (!pending || pending.claimed || Object.keys(req.query).some(k => !['code', 'state'].includes(k)) || typeof code !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(code)
      || typeof state !== 'string' || !equal(state, pending.state) || pending.expires <= this.now()) {
      if (pending) this.dropPending(pending.hash);
      refuse(400, 'learning_sign_in_state_invalid');
    }
    pending.claimed = true;
    try {
      if (this.sessions.size >= this.maxSessions && !(pending.prior && this.sessions.has(pending.prior))) refuse(429, 'learning_sign_in_busy');
      const ep = await this.discover();
      const token = await this.json(ep.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: this.callbackUrl, client_id: this.clientId, resource: ep.resource }).toString() }, pending.lifetime.signal);
      if (typeof token.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(token.access_token) || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer' || token.scope !== 'mcp:read'
        || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in < 1) refuse(401, 'learning_account_invalid');
      const account = await this.account(token.access_token, pending.lifetime.signal), value = opaque(), key = hash(value), lifetime = new AbortController();
      const expiresAt = Math.min(account.expiresAt, this.now() + Math.min(3600, token.expires_in) * 1000);
      const principal = { subject: account.subject, userId: account.userId, webId: account.webId, podUrl: account.podUrl, sessionId: opaque(), expiresAt, signal: lifetime.signal };
      if (this.pending.get(pending.hash) !== pending || pending.lifetime.signal.aborted || pending.expires <= this.now()
        || pending.prior && !this.sessions.has(pending.prior)) refuse(401, 'learning_session_expired');
      if (this.sessions.size >= this.maxSessions && !(pending.prior && this.sessions.has(pending.prior))) refuse(429, 'learning_sign_in_busy');
      this.pending.delete(pending.hash);
      if (pending.prior) this.drop(pending.prior);
      const current = cookie(req, COOKIE); if (current) this.drop(hash(current));
      this.sessions.set(key, { hash: key, principal, account, token: token.access_token, csrf: opaque(), lifetime, timer: this.expire(key, expiresAt) });
      setCookie(res, COOKIE, value, expiresAt - this.now()); secure(res); res.redirect(303, this.base + '/i2idlx/#ask');
    } finally { pending.verifier = ''; pending.lifetime.abort(); this.pending.delete(pending.hash); }
  }
  private guestReady(req: Request, fields: string[]): Row {
    this.ready(); this.sweep();
    if (!this.guestGrant) refuse(503, 'learning_guest_unavailable');
    if (Object.keys(req.query).length || req.get('Origin') !== this.base || !object(req.body)) refuse(400, 'learning_sign_in_input_invalid');
    // The bridge decorates every JSON body with these two (its own reading of the caller's address
    // and bearer). They carry no authority here and are not part of what the browser sent.
    const body = { ...req.body }; delete body.__client_ip; delete body.__caller_token;
    if (Object.keys(body).length !== fields.length || fields.some(k => typeof body[k] !== 'string')) refuse(400, 'learning_sign_in_input_invalid');
    return body;
  }
  /** The caller's address for rate limits: the bridge's own reading where it supplies one (behind
   * its proxy every request shares one socket address), else the socket's. Never an identity. */
  private guestCaller(req: Request): string {
    const supplied = object(req.body) ? req.body.__client_ip : undefined;
    return typeof supplied === 'string' && supplied.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(supplied) ? supplied : req.ip ?? 'unknown';
  }
  /** Step 1: a grant, signed by this application's service agent, for the caller's browser key. */
  async guestGrantFor(req: Request, res: Response): Promise<void> {
    const body = this.guestReady(req, ['publicKeyThumbprint']), thumbprint = body.publicKeyThumbprint as string;
    this.admit('guest-grant:' + this.guestCaller(req), 5); this.admit('guest-grants', 30);
    if (thumbprint.length !== 43 || !B64URL.test(thumbprint)) refuse(400, 'learning_sign_in_input_invalid');
    const request: GuestGrantRequest = { audience: this.base, publicKeyThumbprint: thumbprint, challenge: randomBytes(32).toString('base64url') };
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    let grant: { _signed_payload: string; _signature: string };
    try { grant = await this.guestGrant!(request, controller.signal); } catch { refuse(503, 'learning_guest_unavailable'); } finally { clearTimeout(timer); }
    // The signer is this deployment's own, but what leaves here is still checked: exactly the grant asked for.
    let signed: unknown; try { signed = JSON.parse(grant._signed_payload); } catch { refuse(503, 'learning_guest_unavailable'); }
    if (typeof grant._signed_payload !== 'string' || grant._signed_payload.length > 8192 || typeof grant._signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(grant._signature)
      || !object(signed) || (Object.keys(request) as Array<keyof GuestGrantRequest>).some(k => signed[k] !== request[k])
      || signed.purpose !== 'interego-play-provisional-v1' || !Number.isSafeInteger(signed.expiresAt)
      || Number(signed.expiresAt) * 1000 <= this.now() || Number(signed.expiresAt) * 1000 > this.now() + 120_000) refuse(503, 'learning_guest_unavailable');
    secure(res); res.json({ playGrant: { _signed_payload: grant._signed_payload, _signature: grant._signature } });
  }
  /** Step 2: a single-use challenge the browser key signs with its attestation. */
  async guestChallenge(req: Request, res: Response): Promise<void> {
    this.guestReady(req, []);
    this.admit('guest-challenge:' + this.guestCaller(req), 10); this.admit('guest-challenges', 100);
    if (this.guestChallenges.size >= this.maxPending) refuse(429, 'learning_sign_in_busy');
    const challenge = randomBytes(32).toString('base64url'), expires = this.now() + 120_000;
    this.guestChallenges.set(hash(challenge), expires);
    secure(res); res.json({ challenge, audience: this.base, expires_at: new Date(expires).toISOString() });
  }
  /** Step 3: attestation + proof over that challenge become a guest learner session. */
  async guestSession(req: Request, res: Response): Promise<void> {
    const body = this.guestReady(req, ['attestation', 'challenge', 'proof']);
    this.admit('guest-session:' + this.guestCaller(req), 10); this.admit('guest-sessions', 100);
    const { attestation, challenge, proof } = body as { attestation: string; challenge: string; proof: string };
    const key = hash(challenge), expires = this.guestChallenges.get(key);
    this.guestChallenges.delete(key);
    if (expires === undefined || expires <= this.now() || attestation.length > 8192 || !/^ipa1_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(attestation)
      || proof.length !== 86 || !B64URL.test(proof)) refuse(400, 'learning_sign_in_state_invalid');
    const prior = cookie(req, COOKIE), priorHash = prior ? hash(prior) : null, replaces = !!priorHash && this.sessions.has(priorHash);
    if (this.sessions.size >= this.maxSessions && !replaces) refuse(429, 'learning_sign_in_busy');
    const lifetime = new AbortController();
    let account: Account;
    try { account = await this.guestAccount({ attestation, challenge, proof }, lifetime.signal); }
    catch (error) { if (error instanceof LearningAuthError && error.status === 401) refuse(401, 'learning_account_invalid'); throw error; }
    if (this.sessions.size >= this.maxSessions && !(priorHash && this.sessions.has(priorHash))) refuse(429, 'learning_sign_in_busy');
    if (priorHash) this.drop(priorHash);
    const value = opaque(), sessionKey = hash(value), expiresAt = Math.min(account.expiresAt, this.now() + 3600_000);
    const principal: LearningPrincipal = { subject: account.subject, userId: account.userId, webId: account.webId, podUrl: account.podUrl, sessionId: opaque(), expiresAt, signal: lifetime.signal, guest: true };
    this.sessions.set(sessionKey, { hash: sessionKey, principal, account, token: '', csrf: opaque(), lifetime, timer: this.expire(sessionKey, expiresAt),
      guest: { attestation, challenge, proof, checkedAt: this.now() } });
    setCookie(res, COOKIE, value, expiresAt - this.now()); secure(res); res.json({ signed_in: true, guest: true });
  }
  async signOut(req: Request, res: Response): Promise<void> {
    const principal = await this.resolve(req, { allowGuest: true }); this.assertMutation(req, principal);
    const value = cookie(req, COOKIE); if (value) this.drop(hash(value));
    const pending = cookie(req, PENDING_COOKIE); if (pending) this.dropPending(hash(pending));
    setCookie(res, COOKIE, '', 0); setCookie(res, PENDING_COOKIE, '', 0); secure(res); res.json({ signed_out: true });
  }
}

export function attachLearningAccountRoutes(app: Express, auth: LearningAccountAuth): void {
  const route = (work: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => { secure(res); void work(req, res).catch(error => answerError(res, error)); };
  app.get(PREFIX + '/session', route(async (req, res) => { if (Object.keys(req.query).length) refuse(400, 'learning_sign_in_input_invalid'); res.json(await auth.status(req)); }));
  app.get(PREFIX + '/oauth/client.json', (req, res) => { try { secure(res); if (Object.keys(req.query).length) refuse(400, 'learning_sign_in_input_invalid'); res.json(auth.clientDocument()); } catch (error) { answerError(res, error); } });
  app.get(PREFIX + '/oauth/start', route((req, res) => auth.start(req, res)));
  app.get(PREFIX + '/oauth/callback', route((req, res) => auth.callback(req, res)));
  app.post(PREFIX + '/sign-out', route((req, res) => auth.signOut(req, res)));
  const guestBody = routeJson({ limit: '16kb', strict: true });
  app.post(PREFIX + '/guest/grant', guestBody, route((req, res) => auth.guestGrantFor(req, res)));
  app.post(PREFIX + '/guest/challenge', guestBody, route((req, res) => auth.guestChallenge(req, res)));
  app.post(PREFIX + '/guest/session', guestBody, route((req, res) => auth.guestSession(req, res)));
}
