/** Institution-owned Cloud LTI discovery. A helper launch can request an account
 * association, never establish learner identity, enrollment, curriculum or grades. */
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { LearningAccountAuth, LearningPrincipal } from './i2idlx-learning-auth.js';
import type { LearningConnector, LearningConnectionsStore } from './i2idlx-learning-connections.js';
import { verifyCourseLtiJwt, type CourseLtiPlatform, type CourseLtiVerifyResult } from './i2idlx-course-lti.js';
import { LTI_CLAIMS } from './lti13.js';
import { sourceServiceUrl } from './i2idlx-course-provider.js';

type Row = Record<string, unknown>;
type Phase = 'prepared' | 'installing' | 'ready' | 'removing' | 'cleanup-failed' | 'removed';
interface Saved {
  format: 'i2idlx.learning-lti/v1'; id: string; state: Phase; publicKeyPem: string;
  connectorRequested: boolean; helperRequested: boolean; helperSettled: boolean;
  cloudConnectorId?: string; importJobId?: string; platform?: CourseLtiPlatform; note?: string;
}
export interface LearningLtiSettings { login_url: string; launch_url: string; jwks_url: string; public_key_pem: string; }
export interface LearningLtiDto { state: Phase | 'unavailable'; settings: LearningLtiSettings | null; note?: string; }
export interface LearningLtiConfig {
  baseUrl: string;
  store: Pick<LearningConnectionsStore, 'readConnector' | 'updateConnector' | 'requestLink'>;
  auth: Pick<LearningAccountAuth, 'resolve' | 'revalidate' | 'assertMutation'>;
  fetch?: typeof fetch; now?: () => number;
  /** Program-only fixture policy; public input cannot change admission. */
  publicRequestsPerMinute?: number;
  /** Program-only isolated signature fixture; request JSON cannot select a verifier. */
  verifyJwt?: (jwt: string, jwksUrl: string, signal: AbortSignal) => Promise<CourseLtiVerifyResult>;
}
export class LearningLtiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const ROOT = '/i2idlx/learning/lti', CLOUD = 'https://cloud.scorm.com/api/v2', FORMAT = 'i2idlx.learning-lti/v1';
const HEX = /^[a-f0-9]{32}$/, MAX_PENDING = 1000, MAX_BODY = 1024 * 1024;
const RESERVED = new Set(['response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'prompt', 'state', 'nonce', 'login_hint',
  'lti_message_hint', 'lti_deployment_id', 'target_link_uri', 'iss', 'request', 'request_uri', 'id_token_hint', 'claims', 'max_age', 'acr_values',
  'ui_locales', 'display', 'code_challenge', 'code_challenge_method', 'authorization_details', 'resource', 'audience', 'client_secret', 'access_token', 'id_token']);
type Pending = { connector: string; setup: string; state: string; nonce: string; browserHash: string; expires: number; verifying: boolean };
type Receipt = { connector: string; setup: string; evidence: Row; expires: number; claiming: boolean };
type Handoff = { connector: string; setup: string; input: Row; expires: number };
const NONCE_COOKIE = '__Host-i2idlx-learning-lti', RECEIPT_COOKIE = '__Host-i2idlx-learning-lti-receipt';
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const opaque = () => randomBytes(32).toString('hex');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function canonical(v: unknown): string { return Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : object(v)
  ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v); }
function fail(status: number, code: string): never { throw new LearningLtiError(status, code); }
function text(v: unknown, max: number): v is string { return typeof v === 'string' && !!v && v === v.trim() && Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f]/.test(v); }
function cookie(req: Request, name: string): string | null {
  const matches = (req.get('Cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  const value = matches.length === 1 ? matches[0]!.slice(name.length + 1) : '';
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function setCookie(res: Response, name: string, value: string, seconds: number): void {
  res.cookie(name, value, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: Math.max(0, seconds * 1000) });
}
function secure(res: Response): void { res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff'); }
function errorResponse(res: Response, error: unknown): void {
  secure(res);
  const known = error instanceof LearningLtiError || error instanceof Error && 'status' in error && 'code' in error;
  res.status(known && typeof error.status === 'number' ? error.status : 503).json({ error: known && typeof error.code === 'string' ? error.code : 'learning_lti_unavailable' });
}
function helperId(saved: Saved): string { return 'i2idlx-learning-' + saved.id; }
function helperTitle(saved: Saved): string { return 'I2IDL-X learner discovery ' + saved.id.slice(0, 8); }
function cloudEndpoint(value: unknown, kind: 'issuer' | 'authorization' | 'jwks' | 'token', connectorId: string): string {
  if (!text(value, 2048)) fail(502, 'learning_lti_platform_invalid');
  let u: URL; try { u = new URL(value); } catch { fail(502, 'learning_lti_platform_invalid'); }
  if (u.protocol !== 'https:' || !['cloud.scorm.com', 'app.cloud.scorm.com'].includes(u.hostname) || u.username || u.password || u.hash || u.port && u.port !== '443') fail(502, 'learning_lti_platform_invalid');
  if (kind === 'issuer' ? u.pathname !== '/' || u.search : kind === 'authorization'
    ? u.pathname !== '/ScormEngineInterface/defaultui/player/authorizations.html'
    : u.pathname !== '/api/v2/plugin/lti13/' + encodeURIComponent(connectorId) + '/' + kind) fail(502, 'learning_lti_platform_invalid');
  return value;
}

export class LearningLtiManager {
  private readonly base: string;
  private readonly store: LearningLtiConfig['store'];
  private readonly auth: LearningLtiConfig['auth'];
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly verifyJwt: NonNullable<LearningLtiConfig['verifyJwt']>;
  private readonly busy = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly handoffs = new Map<string, Handoff>();
  private readonly expected = new WeakMap<Saved, string>();
  private verifications = 0;
  private readonly publicRequestsPerMinute: number;
  constructor(config: LearningLtiConfig) {
    let base = '';
    try { sourceServiceUrl(config.baseUrl); const u = new URL(config.baseUrl); if (u.pathname === '/' && !u.search && !u.hash) base = u.origin; } catch { /* ordinary local HTTP startup remains available */ }
    this.base = base; this.store = config.store; this.auth = config.auth; this.fetcher = config.fetch ?? globalThis.fetch;
    this.now = config.now ?? Date.now; this.verifyJwt = config.verifyJwt ?? verifyCourseLtiJwt;
    this.publicRequestsPerMinute = config.publicRequestsPerMinute ?? 300;
    if (!Number.isSafeInteger(this.publicRequestsPerMinute) || this.publicRequestsPerMinute < 1 || this.publicRequestsPerMinute > 300) throw Error('Invalid LTI public request limit');
  }
  dispose(): void { this.pending.clear(); this.receipts.clear(); this.handoffs.clear(); }
  private ready(): void { if (!this.base) fail(503, 'learning_lti_unavailable'); }
  private sweep(): void { for (const [id, p] of this.pending) if (p.expires <= this.now()) this.pending.delete(id); for (const [id, r] of this.receipts) if (r.expires <= this.now()) this.receipts.delete(id); for (const [id, h] of this.handoffs) if (h.expires <= this.now()) this.handoffs.delete(id); }
  private settings(id: string, saved: Saved): LearningLtiSettings {
    const prefix = this.base + ROOT + '/' + id + '/' + saved.id;
    return { login_url: prefix + '/login', launch_url: prefix + '/launch', jwks_url: prefix + '/jwks', public_key_pem: saved.publicKeyPem };
  }
  private saved(connector: LearningConnector): Saved | null {
    if (connector.lti === undefined) return null;
    const v = connector.lti;
    if (Object.keys(v).some(key => !['format', 'id', 'state', 'publicKeyPem', 'connectorRequested', 'helperRequested', 'helperSettled', 'cloudConnectorId', 'importJobId', 'platform', 'note'].includes(key))
      || v.format !== FORMAT || typeof v.id !== 'string' || !HEX.test(v.id) || !['prepared', 'installing', 'ready', 'removing', 'cleanup-failed', 'removed'].includes(String(v.state))
      || typeof v.publicKeyPem !== 'string' || Buffer.byteLength(v.publicKeyPem) > 2048 || !/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(v.publicKeyPem)
      || !['connectorRequested', 'helperRequested', 'helperSettled'].every(key => typeof v[key] === 'boolean')
      || v.cloudConnectorId !== undefined && !text(v.cloudConnectorId, 256) || v.importJobId !== undefined && !text(v.importJobId, 256)) fail(503, 'learning_lti_state_invalid');
    try { const key = createPublicKey(v.publicKeyPem); const bits = key.asymmetricKeyDetails?.modulusLength ?? 0; if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 4096) fail(503, 'learning_lti_state_invalid'); }
    catch { fail(503, 'learning_lti_state_invalid'); }
    const saved = structuredClone(v) as unknown as Saved;
    if (saved.platform) this.platform(saved.platform, saved.cloudConnectorId ?? '');
    if (saved.state === 'ready' && (!saved.connectorRequested || !saved.helperRequested || !saved.helperSettled || !saved.cloudConnectorId || !saved.platform)) fail(503, 'learning_lti_state_invalid');
    this.expected.set(saved, hash(canonical(saved)));
    return saved;
  }
  private platform(info: unknown, connectorId: string): CourseLtiPlatform {
    if (!object(info) || !text(info.clientId, 512) || !text(info.deploymentId, 512)) fail(502, 'learning_lti_platform_invalid');
    return { issuer: cloudEndpoint(info.issuer, 'issuer', connectorId), clientId: info.clientId, deploymentId: info.deploymentId,
      jwksUrl: cloudEndpoint(info.jwksUrl, 'jwks', connectorId), authorizationEndpoint: cloudEndpoint(info.authorizationEndpoint, 'authorization', connectorId),
      ...(info.tokenEndpoint ? { tokenEndpoint: cloudEndpoint(info.tokenEndpoint, 'token', connectorId) } : {}) };
  }
  private view(id: string, saved: Saved): LearningLtiDto { return { state: saved.state, settings: this.settings(id, saved), ...(saved.note ? { note: saved.note } : {}) }; }
  private async owned(principal: LearningPrincipal, id: string): Promise<LearningConnector> {
    this.ready(); await this.auth.revalidate(principal);
    const c = await this.store.readConnector(id);
    if (!c || c.owner !== principal.subject) fail(404, 'learning_connection_not_found');
    if (c.status !== 'active' || !c.authorization || !c.joinCode) fail(403, 'learning_connection_revoked');
    return c;
  }
  private async publicConnector(id: string, setup: string): Promise<{ connector: LearningConnector; saved: Saved }> {
    this.ready();
    if (!HEX.test(id) || !HEX.test(setup)) fail(404, 'learning_lti_not_found');
    const connector = await this.store.readConnector(id), saved = connector ? this.saved(connector) : null;
    if (!connector || !saved || saved.id !== setup || connector.status !== 'active' || !connector.authorization || !connector.joinCode || saved.state !== 'ready') fail(404, 'learning_lti_not_found');
    return { connector, saved };
  }
  private async save(principal: LearningPrincipal, id: string, saved: Saved): Promise<void> {
    await this.auth.revalidate(principal);
    const expected = this.expected.get(saved);
    await this.store.updateConnector(principal, id, current => {
      const prior = this.saved(current);
      if (expected !== undefined ? !prior || hash(canonical(prior)) !== expected : prior && prior.state !== 'removed') fail(409, 'learning_lti_changed');
      current.lti = structuredClone(saved) as unknown as Row;
    });
    this.expected.set(saved, hash(canonical(saved)));
  }
  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(id) || this.busy.size >= 64) fail(409, 'learning_lti_busy');
    this.busy.add(id); try { return await work(); } finally { this.busy.delete(id); }
  }
  private async cloud(connector: LearningConnector, path: string, principal: LearningPrincipal, method = 'GET', body?: Row): Promise<Row | null> {
    if (!connector.authorization || !path.startsWith('/') || path.startsWith('//')) fail(503, 'learning_lti_unavailable');
    const target = CLOUD + path, signal = AbortSignal.any([principal.signal, AbortSignal.timeout(20_000)]);
    let response: globalThis.Response;
    try { response = await this.fetcher(target, { method, redirect: 'error', signal, headers: { Authorization: connector.authorization, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
    catch { fail(503, 'learning_lti_provider_unavailable'); }
    if (response.redirected || response.url && response.url !== target) { await response.body?.cancel(); fail(502, 'learning_lti_provider_unavailable'); }
    if (response.status === 404) { await response.body?.cancel(); await this.auth.revalidate(principal); return null; }
    if (!response.ok) { await response.body?.cancel(); fail(response.status === 401 || response.status === 403 ? response.status : 502, 'learning_lti_provider_unavailable'); }
    if (method === 'DELETE' || response.status === 204) { await response.body?.cancel(); await this.auth.revalidate(principal); return {}; }
    if (!response.body) fail(502, 'learning_lti_provider_unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > MAX_BODY) { await reader.cancel(); fail(413, 'learning_lti_provider_capacity'); } chunks.push(part.value); } }
    finally { reader.releaseLock(); }
    await this.auth.revalidate(principal);
    let raw: unknown; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(502, 'learning_lti_provider_unavailable'); }
    if (!object(raw)) fail(502, 'learning_lti_provider_unavailable'); return raw;
  }
  private async findCloud(connector: LearningConnector, saved: Saved, principal: LearningPrincipal): Promise<Row | null> {
    const listing = await this.cloud(connector, '/contentConnectors?includeAdditionalInstanceInformation=true', principal);
    if (!listing || !Array.isArray(listing.connectorEntries) || listing.connectorEntries.length > 500) fail(502, 'learning_lti_provider_capacity');
    const settings = this.settings(connector.id, saved);
    const matches = listing.connectorEntries.filter((v): v is Row => object(v) && v.contentConnectorType === 'ContentConnector.Lti13' && object(v.configuration)
      && v.configuration.toolPublicKey === settings.public_key_pem && v.configuration.toolOidcLoginInitiationsEndpoint === settings.login_url
      && Array.isArray(v.configuration.toolOidcLaunchRedirectUris) && v.configuration.toolOidcLaunchRedirectUris.length === 1 && v.configuration.toolOidcLaunchRedirectUris[0] === settings.launch_url);
    if (matches.length > 1) fail(409, 'learning_lti_setup_uncertain');
    const match = matches[0];
    if (saved.cloudConnectorId && listing.connectorEntries.some(v => object(v) && v.connectorId === saved.cloudConnectorId && v !== match)) fail(409, 'learning_lti_setup_uncertain');
    if (!match) return null;
    if (!text(match.connectorId, 256) || saved.cloudConnectorId && saved.cloudConnectorId !== match.connectorId) fail(409, 'learning_lti_setup_uncertain');
    saved.cloudConnectorId = match.connectorId; return match;
  }
  private async reconcile(connector: LearningConnector, saved: Saved, principal: LearningPrincipal): Promise<void> {
    const found = await this.findCloud(connector, saved, principal);
    if (!found || found.enabled !== true || !object(found.additionalInstanceInformation)) { saved.note = 'Cloud has not confirmed this exact enabled LTI connection. Remove or check this setup before creating another.'; await this.save(principal, connector.id, saved); return; }
    const info = found.additionalInstanceInformation;
    const platform = this.platform({ issuer: info.issuer, clientId: info.toolClientId, deploymentId: info.deploymentId, jwksUrl: info.jwksEndpoint,
      authorizationEndpoint: info.oidcAuthorizationUrl, ...(info.accessTokenUrl ? { tokenEndpoint: info.accessTokenUrl } : {}) }, saved.cloudConnectorId!);
    if (saved.platform && canonical(saved.platform) !== canonical(platform)) fail(409, 'learning_lti_platform_changed');
    saved.platform = platform;
    if (saved.importJobId && !saved.helperSettled) {
      const job = await this.cloud(connector, '/courses/importJobs/' + encodeURIComponent(saved.importJobId), principal);
      if (!job || job.jobId !== saved.importJobId || !['RUNNING', 'COMPLETE', 'ERROR'].includes(String(job.status))) fail(502, 'learning_lti_setup_uncertain');
      if (job.status === 'ERROR') { saved.helperSettled = true; saved.note = 'Cloud could not create the separate discovery helper. Remove this setup before trying again.'; await this.save(principal, connector.id, saved); return; }
      if (job.status === 'RUNNING') { saved.note = 'Cloud is preparing the separate learner-discovery helper. Refresh this connection shortly.'; await this.save(principal, connector.id, saved); return; }
      if (!object(job.importResult) || !object(job.importResult.course) || job.importResult.course.id !== helperId(saved)) fail(409, 'learning_lti_setup_uncertain');
      saved.helperSettled = true;
    }
    if (saved.helperRequested) {
      const helper = await this.cloud(connector, '/courses/' + encodeURIComponent(helperId(saved)), principal);
      if (helper && helper.id === helperId(saved) && helper.title === helperTitle(saved) && saved.helperSettled) {
        saved.state = 'ready'; saved.note = 'The separate Cloud helper discovers account-link requests only. An administrator must verify the learner registration, and the learner must confirm. It supplies no enrollment, curriculum, roster or grade authority.';
      } else saved.note = 'The exact separate discovery helper is not confirmed. Refresh or remove this setup; do not create a duplicate.';
    }
    await this.save(principal, connector.id, saved);
  }
  async prepare(principal: LearningPrincipal, id: string): Promise<LearningLtiDto> {
    return this.exclusive(id, async () => {
      const connector = await this.owned(principal, id), prior = this.saved(connector);
      if (prior && prior.state !== 'removed') return this.view(id, prior);
      const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const saved: Saved = { format: FORMAT, id: randomBytes(16).toString('hex'), state: 'prepared',
        publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), connectorRequested: false, helperRequested: false, helperSettled: false };
      await this.save(principal, id, saved); return this.view(id, saved);
    });
  }
  async install(principal: LearningPrincipal, id: string): Promise<LearningLtiDto> {
    return this.exclusive(id, async () => {
      const connector = await this.owned(principal, id), saved = this.saved(connector);
      if (!saved || ['removing', 'cleanup-failed', 'removed'].includes(saved.state)) fail(409, 'learning_lti_prepare_required');
      if (saved.state === 'ready') return this.view(id, saved);
      const settings = this.settings(id, saved);
      saved.state = 'installing';
      if (!saved.connectorRequested) {
        saved.connectorRequested = true; await this.save(principal, id, saved);
        const result = await this.cloud(connector, '/contentConnectors', principal, 'POST', { contentConnectorType: 'ContentConnector.Lti13', enabled: true,
          configuration: { toolPublicKey: settings.public_key_pem, toolOidcLoginInitiationsEndpoint: settings.login_url, toolOidcLaunchRedirectUris: [settings.launch_url] } });
        if (!result || !text(result.result, 256)) fail(502, 'learning_lti_setup_uncertain'); saved.cloudConnectorId = result.result; await this.save(principal, id, saved);
      }
      await this.reconcile(connector, saved, principal);
      if (!saved.platform) return this.view(id, saved);
      if (!saved.helperRequested) {
        if (await this.cloud(connector, '/courses/' + encodeURIComponent(helperId(saved)), principal)) fail(409, 'learning_lti_helper_collision');
        saved.helperRequested = true; await this.save(principal, id, saved);
        const imported = await this.cloud(connector, '/courses/importJobs/noUpload?' + new URLSearchParams({ courseId: helperId(saved), mayCreateNewVersion: 'false' }), principal, 'POST', {
          connectorReferenceRequest: { connectorId: saved.cloudConnectorId, metadataForConnector: { url: settings.launch_url, title: helperTitle(saved),
            ltiMetadata: { description: 'Isolated learner account discovery; never evidence of enrollment', context: { contextId: saved.id } } } } });
        if (!imported || !text(imported.result, 256)) fail(502, 'learning_lti_setup_uncertain'); saved.importJobId = imported.result; await this.save(principal, id, saved);
      }
      await this.reconcile(connector, saved, principal); return this.view(id, saved);
    });
  }
  async status(principal: LearningPrincipal, id: string): Promise<LearningLtiDto> {
    if (!this.base) return { state: 'unavailable', settings: null, note: 'Institution LTI requires this service public HTTPS address.' };
    return this.exclusive(id, async () => {
      const connector = await this.owned(principal, id), saved = this.saved(connector);
      if (!saved) return { state: 'unavailable', settings: null, note: 'Prepare the optional institution discovery helper to view its settings.' };
      if (saved.state === 'installing') await this.reconcile(connector, saved, principal);
      return this.view(id, saved);
    });
  }
  async remove(principal: LearningPrincipal, id: string): Promise<LearningLtiDto> {
    return this.exclusive(id, async () => {
      const connector = await this.owned(principal, id), saved = this.saved(connector);
      if (!saved) return { state: 'removed', settings: null };
      if (saved.state === 'removed') return this.view(id, saved);
      saved.state = 'removing'; await this.save(principal, id, saved);
      for (const [key, p] of this.pending) if (p.connector === id) this.pending.delete(key);
      for (const [key, r] of this.receipts) if (r.connector === id) this.receipts.delete(key);
      for (const [key, h] of this.handoffs) if (h.connector === id) this.handoffs.delete(key);
      try {
        const found = saved.connectorRequested ? await this.findCloud(connector, saved, principal) : null;
        if (saved.connectorRequested && !saved.cloudConnectorId) fail(409, 'learning_lti_setup_uncertain');
        let settled = !saved.helperRequested;
        if (saved.importJobId && !saved.helperSettled) {
          const job = await this.cloud(connector, '/courses/importJobs/' + encodeURIComponent(saved.importJobId), principal);
          if (job?.jobId === saved.importJobId && (job.status === 'ERROR' || job.status === 'COMPLETE' && object(job.importResult) && object(job.importResult.course) && job.importResult.course.id === helperId(saved))) saved.helperSettled = true;
        }
        if (saved.helperRequested) {
          const helper = await this.cloud(connector, '/courses/' + encodeURIComponent(helperId(saved)), principal);
          if (helper) {
            if (helper.id !== helperId(saved) || helper.title !== helperTitle(saved)) fail(409, 'learning_lti_setup_uncertain');
            await this.cloud(connector, '/courses/' + encodeURIComponent(helperId(saved)), principal, 'DELETE');
          }
          settled = saved.helperSettled && await this.cloud(connector, '/courses/' + encodeURIComponent(helperId(saved)), principal) === null;
        }
        if (found && saved.cloudConnectorId) await this.cloud(connector, '/contentConnectors/' + encodeURIComponent(saved.cloudConnectorId), principal, 'DELETE');
        const remaining = saved.connectorRequested ? await this.findCloud(connector, saved, principal) : null;
        if (!settled || remaining) fail(409, 'learning_lti_cleanup_unconfirmed');
        saved.state = 'removed'; saved.note = 'Only this isolated discovery helper and its LTI connector were removed. Other courses and learner registrations were not changed.';
      } catch {
        saved.state = 'cleanup-failed'; saved.note = 'LTI use is stopped, but Cloud cleanup is unconfirmed. Keep this connector credential and retry removal before revoking the connection.';
      }
      await this.save(principal, id, saved); return this.view(id, saved);
    });
  }
  private handoffPage(ticket: string, platform: CourseLtiPlatform, res: Response): void {
    const link = this.base + ROOT + '/open?handoff=' + ticket;
    // Cloud's management portal can be an outer ancestor of its engine player.
    // Every ancestor must be admitted; both are fixed provider hosts, never a
    // caller-supplied LMS URL or a wildcard. The subsequent claim is top-level.
    const ancestors = [...new Set([this.base, new URL(platform.issuer).origin, new URL(platform.authorizationEndpoint).origin,
      'https://cloud.scorm.com', 'https://app.cloud.scorm.com'])].join(' ');
    res.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " + ancestors)
      .type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue your learning account link</title><h1>Continue your learning account link</h1><p>Open the secure account-link step in its own tab. Your sign-in stays separate from the course player.</p><p><a target="_blank" rel="noopener noreferrer" href="' + link + '">Continue in a new tab</a></p></html>');
  }
  private async openHandoff(req: Request, res: Response): Promise<void> {
    this.sweep(); const ticket = req.query.handoff;
    if (Object.keys(req.query).length !== 1 || typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) fail(410, 'learning_lti_handoff_expired');
    const key = hash(ticket), handoff = this.handoffs.get(key);
    if (!handoff || handoff.expires <= this.now()) fail(410, 'learning_lti_handoff_expired');
    const { saved } = await this.publicConnector(handoff.connector, handoff.setup);
    if (!saved.platform) fail(410, 'learning_lti_handoff_expired');
    // Only a real top-level navigation establishes the first-party nonce cookie.
    // A player opening this link in another frame gets the same explicit link.
    if (req.get('Sec-Fetch-Dest') !== 'document') { this.handoffPage(ticket, saved.platform, res); return; }
    if (this.handoffs.get(key) !== handoff || handoff.expires <= this.now()) fail(410, 'learning_lti_handoff_expired');
    this.handoffs.delete(key);
    await this.login(handoff.connector, handoff.setup, req, res, handoff.input);
  }
  private async login(id: string, setup: string, req: Request, res: Response, input?: Row): Promise<void> {
    this.sweep(); const { saved } = await this.publicConnector(id, setup), platform = saved.platform, raw = input ?? req.query;
    if (!platform || raw.iss !== platform.issuer || !text(raw.login_hint, 2048) || raw.target_link_uri !== this.settings(id, saved).launch_url
      || raw.client_id !== undefined && raw.client_id !== platform.clientId || raw.lti_deployment_id !== undefined && raw.lti_deployment_id !== platform.deploymentId
      || raw.lti_message_hint !== undefined && !text(raw.lti_message_hint, 8192)) fail(401, 'learning_lti_login_rejected');
    if (['iframe', 'frame'].includes(req.get('Sec-Fetch-Dest') ?? '')) {
      if (this.handoffs.size >= MAX_PENDING || [...this.handoffs.values()].filter(h => h.connector === id).length >= 128) fail(429, 'learning_lti_capacity');
      const ticket = opaque(), fields = ['iss', 'login_hint', 'target_link_uri', 'client_id', 'lti_deployment_id', 'lti_message_hint'];
      const normalized = Object.fromEntries(fields.filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
      this.handoffs.set(hash(ticket), { connector: id, setup, input: normalized, expires: this.now() + 300_000 });
      this.handoffPage(ticket, platform, res); return;
    }
    if (this.pending.size >= MAX_PENDING || [...this.pending.values()].filter(p => p.connector === id).length >= 128) fail(429, 'learning_lti_capacity');
    const secret = opaque(), state = opaque(), nonce = opaque();
    this.pending.set(hash(state), { connector: id, setup, state, nonce, browserHash: hash(secret), expires: this.now() + 300_000, verifying: false });
    const url = new URL(platform.authorizationEndpoint);
    for (const key of [...url.searchParams.keys()]) if (RESERVED.has(key.toLowerCase())) url.searchParams.delete(key);
    for (const [key, value] of Object.entries({ response_type: 'id_token', response_mode: 'form_post', client_id: platform.clientId,
      redirect_uri: this.settings(id, saved).launch_url, scope: 'openid', prompt: 'none', state, nonce, login_hint: raw.login_hint,
      ...(typeof raw.lti_message_hint === 'string' ? { lti_message_hint: raw.lti_message_hint } : {}) })) url.searchParams.set(key, value);
    // The pending launch lasts five minutes; its browser binding must also
    // survive the following ten-minute sign-in/explicit-claim window.
    setCookie(res, NONCE_COOKIE, secret, 900); res.redirect(302, url.href);
  }
  private async launch(id: string, setup: string, raw: unknown, res: Response): Promise<void> {
    this.sweep();
    if (!object(raw) || !text(raw.state, 128) || !text(raw.id_token, 65536)) fail(401, 'learning_lti_launch_rejected');
    const key = hash(raw.state), pending = this.pending.get(key); this.pending.delete(key);
    if (!pending || pending.connector !== id || pending.setup !== setup || pending.expires <= this.now() || pending.verifying) fail(401, 'learning_lti_launch_rejected');
    if (this.verifications >= 16 || this.receipts.size >= MAX_PENDING) fail(429, 'learning_lti_capacity');
    const { saved } = await this.publicConnector(id, setup), platform = saved.platform; if (!platform) fail(401, 'learning_lti_launch_rejected');
    if (this.verifications >= 16) fail(429, 'learning_lti_capacity');
    let verified: CourseLtiVerifyResult; this.verifications++;
    try { verified = await this.verifyJwt(raw.id_token, platform.jwksUrl, AbortSignal.timeout(10_000)); }
    catch { fail(401, 'learning_lti_token_rejected'); }
    finally { this.verifications--; }
    const p = verified.payload, h = verified.header, now = this.now() / 1000;
    if (!verified.ok || !object(p) || !object(h) || !['RS256', 'ES256'].includes(String(h.alg))) fail(401, 'learning_lti_token_rejected');
    const aud = Array.isArray(p.aud) ? p.aud : [p.aud], context = p[LTI_CLAIMS.context], resource = p[LTI_CLAIMS.resourceLink], roles = p[LTI_CLAIMS.roles];
    if (p.iss !== platform.issuer || !aud.length || aud.length > 8 || !aud.every(v => text(v, 512)) || !aud.includes(platform.clientId)
      || p.azp !== undefined && p.azp !== platform.clientId || aud.length > 1 && p.azp !== platform.clientId || !text(p.sub, 255) || !/^[\x21-\x7e]+$/.test(p.sub) || p.nonce !== pending.nonce
      || typeof p.iat !== 'number' || !Number.isFinite(p.iat) || p.iat > now + 60 || p.iat < now - 300 || typeof p.exp !== 'number' || !Number.isFinite(p.exp) || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > 600
      || p.nbf !== undefined && (typeof p.nbf !== 'number' || !Number.isFinite(p.nbf) || p.nbf > now + 60)
      || p[LTI_CLAIMS.deploymentId] !== platform.deploymentId || p[LTI_CLAIMS.version] !== '1.3.0' || p[LTI_CLAIMS.messageType] !== 'LtiResourceLinkRequest'
      || p[LTI_CLAIMS.targetLinkUri] !== this.settings(id, saved).launch_url || !object(context) || context.id !== saved.id || !object(resource) || !text(resource.id, 255)
      || !Array.isArray(roles) || roles.length > 32 || !roles.every(v => text(v, 512))) fail(401, 'learning_lti_claims_rejected');
    await this.publicConnector(id, setup); // deletion/revocation during signature verification
    if (this.receipts.size >= MAX_PENDING) fail(429, 'learning_lti_capacity');
    const ticket = opaque(); this.receipts.set(hash(ticket), { connector: id, setup, expires: this.now() + 600_000, claiming: false,
      evidence: { verification: 'signed-lti13-platform-launch', issuer: platform.issuer, client_id: platform.clientId, deployment_id: platform.deploymentId,
        subject: p.sub, context_id: context.id, resource_link_id: resource.id, verified_at: new Date(this.now()).toISOString(), helper_is_enrollment: false,
        browser_hash: pending.browserHash } });
    setCookie(res, RECEIPT_COOKIE, ticket, 600); res.redirect(303, this.base + ROOT + '/receipt');
  }
  private receipt(req: Request): Receipt {
    this.sweep(); const ticket = cookie(req, RECEIPT_COOKIE), browser = cookie(req, NONCE_COOKIE), receipt = ticket ? this.receipts.get(hash(ticket)) : undefined;
    if (!receipt || !browser || receipt.evidence.browser_hash !== hash(browser) || receipt.expires <= this.now() || receipt.claiming) fail(410, 'learning_lti_receipt_expired');
    return receipt;
  }
  private async claim(req: Request, res: Response): Promise<void> {
    if (Object.keys(req.query).length) fail(400, 'learning_lti_request_invalid');
    if (req.body !== undefined && (!object(req.body) || Object.keys(req.body).some(key => !['__client_ip', '__caller_token'].includes(key)))) fail(400, 'learning_lti_request_invalid');
    const principal = await this.auth.resolve(req); this.auth.assertMutation(req, principal);
    const receipt = this.receipt(req), ticket = cookie(req, RECEIPT_COOKIE)!; receipt.claiming = true;
    try {
      const { connector } = await this.publicConnector(receipt.connector, receipt.setup);
      await this.auth.revalidate(principal);
      const { browser_hash: _browserBinding, ...evidence } = receipt.evidence;
      const result = await this.store.requestLink(principal, connector.joinCode!, evidence);
      await this.auth.revalidate(principal);
      this.receipts.delete(hash(ticket)); setCookie(res, RECEIPT_COOKIE, '', 0); setCookie(res, NONCE_COOKIE, '', 0); res.json(result);
    } catch (error) { receipt.claiming = false; throw error; }
  }
  attachRoutes(app: Express): void {
    // One constant process bucket has a fixed memory footprint. Every public
    // route is admitted before an encrypted-state read or signature/key work.
    const admission = rateLimit({ windowMs: 60_000, limit: this.publicRequestsPerMinute,
      keyGenerator: () => 'i2idlx-learning-lti-public', standardHeaders: false, legacyHeaders: false,
      handler: (_req, res) => { secure(res); res.set('Retry-After', '60').status(429).json({ error: 'learning_lti_rate_limited' }); } });
    const route = (work: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => { secure(res); void work(req, res).catch(error => errorResponse(res, error)); };
    app.get(ROOT + '/receipt', admission, route(async (req, res) => {
      if (Object.keys(req.query).length) fail(400, 'learning_lti_request_invalid');
      this.receipt(req);
      res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        .type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link your learning account</title><h1>Link your learning account</h1><p>This verified helper launch can request a learner-account link. It does not prove course enrollment or learner identity.</p><p><a href="/i2idlx/learning/oauth/start" target="_blank" rel="noopener">Sign in with Interego</a>, then return here.</p><button id="claim" type="button">Request account link</button><p id="status" role="status"></p><script src="/i2idlx/learning/lti/receipt.js" defer></script></html>');
    }));
    app.get(ROOT + '/receipt.js', admission, (_req, res) => { secure(res); res.type('application/javascript').send(RECEIPT_JS); });
    app.post(ROOT + '/receipt/claim', admission, route((req, res) => this.claim(req, res)));
    app.get(ROOT + '/open', admission, route((req, res) => this.openHandoff(req, res)));
    app.get(ROOT + '/:connectorId/:setupId/login', admission, route((req, res) => this.login(String(req.params.connectorId), String(req.params.setupId), req, res)));
    app.get(ROOT + '/:connectorId/:setupId/jwks', admission, route(async (req, res) => {
      if (Object.keys(req.query).length) fail(400, 'learning_lti_request_invalid');
      const { saved } = await this.publicConnector(String(req.params.connectorId), String(req.params.setupId));
      res.json({ keys: [{ ...createPublicKey(saved.publicKeyPem).export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'learning-' + saved.id }] });
    }));
    app.post(ROOT + '/:connectorId/:setupId/launch', admission, express.urlencoded({ extended: false, limit: '96kb', parameterLimit: 8 }), route(async (req, res) => {
      if (Object.keys(req.query).length) fail(400, 'learning_lti_request_invalid');
      await this.launch(String(req.params.connectorId), String(req.params.setupId), req.body, res);
    }));
  }
}
const RECEIPT_JS = "'use strict';document.getElementById('claim').addEventListener('click',async()=>{const button=document.getElementById('claim'),status=document.getElementById('status');button.disabled=true;try{const r=await fetch('/i2idlx/learning/session',{credentials:'same-origin'}),session=await r.json();if(!r.ok||!session.authenticated||!session.csrf)throw Error('Sign in with Interego, then return to request the link.');const claim=await fetch('/i2idlx/learning/lti/receipt/claim',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-I2IDLX-Learning-CSRF':session.csrf},body:'{}'});if(!claim.ok)throw Error('The link request was not confirmed. Sign in again or repeat the helper launch.');status.textContent='Link requested. Your administrator must verify the learner registration; you must then confirm the association in Ask.';}catch(error){status.textContent=error instanceof Error?error.message:'The link request was not confirmed.';button.disabled=false;}});";
