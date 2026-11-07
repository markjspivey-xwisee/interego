/** Temporary LTI Tool registrations for an already-authorized course connection.
 * The LTI subject is evidence about a launch, never an agent DID or owner grant.
 * Only the initiating authenticated browser may explicitly consume that evidence.
 */
import express, { type Express } from 'express';
import { createPublicKey, generateKeyPairSync, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { LTI_CLAIMS } from './lti13.js';
import { sourceConnectionAddresses, sourceServiceUrl } from './i2idlx-course-provider.js';

type Row = Record<string, unknown>;
const ROOT = '/i2idlx/course-lti';
const MAX_RECORDS = 1000, MAX_PER_CONNECTION = 4, MAX_LOGINS = 4;
const LOGIN_MS = 5 * 60_000, SESSION_MS = 30 * 60_000;
const MAX_JWT = 65_536, MAX_JWKS = 65_536;
// An exact registered endpoint may carry opaque vendor routing parameters.
// OIDC/LTI request authority always comes from the current pending launch.
const AUTHORIZATION_ARGUMENTS = new Set(['response_type', 'response_mode', 'client_id', 'redirect_uri', 'scope', 'prompt', 'state', 'nonce',
  'login_hint', 'lti_message_hint', 'lti_deployment_id', 'target_link_uri', 'iss', 'request', 'request_uri', 'id_token_hint', 'claims',
  'max_age', 'acr_values', 'ui_locales', 'display', 'code_challenge', 'code_challenge_method', 'authorization_details', 'resource', 'audience',
  'client_secret', 'access_token', 'id_token']);
const opaque = () => randomBytes(24).toString('hex');
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() &&
  Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value);
const sameVersion = (left: unknown, right: unknown): boolean => typeof left === typeof right && left === right;

export class CourseLtiError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'course_lti_invalid') { super(message); }
}
function fail(message: string, status = 400, code?: string): never { throw new CourseLtiError(message, status, code); }

export interface CourseLtiBinding {
  sessionId: string;
  actor: string;
  connectionId: string;
  courseId: string;
  version: number | string;
  expiresAt: number;
  signal?: AbortSignal;
}
export interface CourseLtiPlatform {
  issuer: string;
  clientId: string;
  deploymentId: string;
  jwksUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint?: string;
}
export interface CourseLtiDescriptor {
  id: string;
  login_url: string;
  launch_url: string;
  jwks_url: string;
  public_key_pem: string;
  expires_at: string;
}
export interface CourseLtiLaunchEvidence {
  issuer: string;
  client_id: string;
  deployment_id: string;
  subject: string;
  context_id: string;
  resource_link_id: string;
  verified_at: string;
  course_id: string;
  version: number | string;
}
export interface CourseLtiStatus {
  id: string;
  state: 'prepared' | 'configured' | 'verified' | 'consumed';
  expires_at: string;
  launch?: CourseLtiLaunchEvidence;
}
export interface CourseLtiVerifyResult { ok: boolean; payload?: Row; header?: Row; }
export interface CourseLtiOptions {
  baseUrl: string;
  now?: () => number;
  /** Trusted program configuration only; never accepted from request JSON. */
  verifyJwt?: (jwt: string, jwksUrl: string, signal: AbortSignal) => Promise<CourseLtiVerifyResult>;
}
interface Login {
  nonce: string;
  expires: number;
}
interface Entry {
  id: string;
  binding: CourseLtiBinding;
  expires: number;
  descriptor: CourseLtiDescriptor;
  jwk: JsonWebKey;
  platform?: CourseLtiPlatform;
  contextId?: string;
  resourceLinkId?: string;
  logins: Map<string, Login>;
  launch?: CourseLtiLaunchEvidence;
  consumed: boolean;
  verifying: number;
  abort: AbortController;
  release: () => void;
}

function publicUrl(value: unknown): string {
  if (!bounded(value, 2048)) fail('The registered LTI endpoint must be a public HTTPS URL.');
  try {
    if (/[?#]/.test(value)) throw new Error('Issuer and tool addresses do not take routing arguments.');
    sourceServiceUrl(value);
  } catch { fail('The registered LTI endpoint must be a public HTTPS URL without credentials, query or fragment.'); }
  return value;
}
/** Only program-registered platform endpoints allow fixed query parameters.
 * Validate the same origin/path through the existing public-network guard, then
 * preserve the original opaque query. It is never copied into error messages.
 */
function platformEndpoint(value: unknown): string {
  if (!bounded(value, 2048)) fail('The registered platform endpoint must be a public HTTPS URL.');
  try {
    const screened = new URL(value);
    if (value.includes('#')) throw new Error('Endpoint fragments are not supported.');
    screened.search = '';
    sourceServiceUrl(screened.href);
  } catch { fail('The registered platform endpoint must be a public HTTPS URL without credentials or fragments.'); }
  return value;
}
function decode(segment: string): Row {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) fail('Invalid LTI token.', 401, 'course_lti_token_rejected');
  let value: unknown;
  try { value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')); } catch { fail('Invalid LTI token.', 401, 'course_lti_token_rejected'); }
  if (!object(value)) fail('Invalid LTI token.', 401, 'course_lti_token_rejected');
  return value;
}

/** A bounded GET whose actual socket resolves only public addresses. No redirects. */
async function readJwks(raw: string, signal: AbortSignal): Promise<Row[]> {
  const url = new URL(platformEndpoint(raw));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const body = await new Promise<Buffer>((resolve, reject) => {
    if (signal.aborted) { reject(new CourseLtiError('LTI connection ended.', 410)); return; }
    const request = httpsRequest(url, { method: 'GET', agent: false, signal: deadline, headers: { Accept: 'application/json, application/jwk-set+json' },
      lookup(hostname, options, callback) {
        sourceConnectionAddresses(hostname).then(addresses => {
          if (options.all) callback(null, addresses);
          else { const address = addresses[0]!; callback(null, address.address, address.family); }
        }, error => callback(error instanceof Error ? error : new Error('LTI key address refused.'), []));
      },
    }, response => {
      const mime = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const length = Number(response.headers['content-length']);
      if (response.statusCode !== 200 || !['application/json', 'application/jwk-set+json'].includes(mime) || Number.isFinite(length) && length > MAX_JWKS) {
        response.destroy(); reject(new CourseLtiError('The registered platform did not supply bounded public keys.', 502)); return;
      }
      const chunks: Buffer[] = []; let count = 0;
      response.on('data', (chunk: Buffer) => {
        count += chunk.length;
        if (count > MAX_JWKS) { response.destroy(new CourseLtiError('LTI key response exceeded capacity.', 502)); return; }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve(Buffer.concat(chunks, count)));
    });
    request.once('error', reject);
    request.setTimeout(10_000, () => request.destroy(new CourseLtiError('The registered platform key request timed out.', 502)));
    request.end();
  });
  let value: unknown;
  try { value = JSON.parse(body.toString('utf8')); } catch { fail('The platform key response was invalid.', 502); }
  if (!object(value) || !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 20 || value.keys.some(key => !object(key))) fail('The platform key response was invalid.', 502);
  return value.keys as Row[];
}

/** Verification ignores token-supplied key URLs and accepts only the registered JWKS. */
export async function verifyCourseLtiJwt(jwt: string, jwksUrl: string, signal: AbortSignal): Promise<CourseLtiVerifyResult> {
  if (!bounded(jwt, MAX_JWT)) return { ok: false };
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false };
  let header: Row, payload: Row;
  try { header = decode(parts[0]!); payload = decode(parts[1]!); } catch { return { ok: false }; }
  if (!['RS256', 'ES256'].includes(String(header.alg)) || !bounded(header.kid, 200) || header.crit !== undefined || header.b64 !== undefined || !/^[A-Za-z0-9_-]+$/.test(parts[2]!)) return { ok: false };
  const signature = Buffer.from(parts[2]!, 'base64url');
  if (header.alg === 'ES256' && signature.length !== 64 || signature.length > 1024) return { ok: false };
  const keys = await readJwks(jwksUrl, signal);
  for (const key of keys) {
    if (key.kid !== header.kid || key.alg !== undefined && key.alg !== header.alg || key.use !== undefined && key.use !== 'sig' ||
        key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify')) || key.d !== undefined) continue;
    try {
      if (header.alg === 'RS256' ? key.kty !== 'RSA' : key.kty !== 'EC' || key.crv !== 'P-256') continue;
      const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
      if (header.alg === 'RS256' && (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      const input = Buffer.from(parts[0] + '.' + parts[1]);
      const valid = header.alg === 'RS256'
        ? verifySignature('RSA-SHA256', input, publicKey, signature)
        : verifySignature('sha256', input, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
      if (valid) return { ok: true, payload, header };
    } catch { /* An unusable public key does not authorize a launch. */ }
  }
  return { ok: false };
}

export class CourseLtiManager {
  private readonly entries = new Map<string, Entry>();
  private readonly base: string;
  private readonly clock: () => number;
  private readonly verifyJwt: NonNullable<CourseLtiOptions['verifyJwt']>;
  private verifications = 0;
  constructor(options: CourseLtiOptions) {
    const base = new URL(publicUrl(options.baseUrl));
    if (base.pathname !== '/') fail('The LTI workbench base must be its public HTTPS origin.');
    this.base = base.origin; this.clock = options.now ?? Date.now;
    this.verifyJwt = options.verifyJwt ?? verifyCourseLtiJwt;
  }
  private sweep(): void { for (const entry of this.entries.values()) if (entry.expires <= this.clock() || entry.binding.signal?.aborted) this.remove(entry); }
  private remove(entry: Entry): void {
    if (this.entries.get(entry.id) !== entry) return;
    this.entries.delete(entry.id); entry.logins.clear(); entry.launch = undefined; entry.abort.abort(); entry.release();
  }
  private entry(id: string): Entry {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) fail('This LTI connection ended. Prepare a fresh connection in Ask.', 410, 'course_lti_expired');
    return entry;
  }
  private bound(id: string, binding: CourseLtiBinding): Entry {
    const entry = this.entry(id), own = entry.binding;
    if (binding.signal?.aborted || binding.sessionId !== own.sessionId || binding.actor !== own.actor || binding.connectionId !== own.connectionId ||
        binding.courseId !== own.courseId || !sameVersion(binding.version, own.version) || binding.expiresAt !== own.expiresAt) fail('This LTI connection does not belong to the current course session.', 403, 'course_lti_binding_mismatch');
    return entry;
  }
  prepare(binding: CourseLtiBinding): CourseLtiDescriptor {
    this.sweep();
    if (![binding.sessionId, binding.actor, binding.connectionId, binding.courseId].every(value => bounded(value, 1024)) ||
        !(Number.isSafeInteger(binding.version) && Number(binding.version) >= 0 || bounded(binding.version, 256)) ||
        !Number.isFinite(binding.expiresAt) || binding.expiresAt <= this.clock() || binding.signal?.aborted) fail('An active authenticated course binding is required.', 403, 'course_lti_binding_required');
    if (this.entries.size >= MAX_RECORDS || [...this.entries.values()].filter(entry => entry.binding.connectionId === binding.connectionId).length >= MAX_PER_CONNECTION) fail('LTI connection capacity reached. End an older connection first.', 429, 'course_lti_capacity');
    const id = opaque(), expires = Math.min(binding.expiresAt, this.clock() + SESSION_MS), prefix = this.base + ROOT + '/' + id;
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk: JsonWebKey = { ...publicKey.export({ format: 'jwk' }), alg: 'RS256', use: 'sig', kid: 'course-lti-' + id };
    // No service scopes or outbound client assertions are supported here, so the
    // unused private half is not retained or exported by this launch-only Tool.
    const descriptor: CourseLtiDescriptor = { id, login_url: prefix + '/login', launch_url: prefix + '/launch', jwks_url: prefix + '/jwks',
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), expires_at: new Date(expires).toISOString() };
    const entry: Entry = { id, binding: { ...binding }, expires, descriptor, jwk, logins: new Map(), consumed: false, verifying: 0, abort: new AbortController(), release: () => undefined };
    const boundSignal = binding.signal;
    if (boundSignal) {
      const abort = () => this.remove(entry); boundSignal.addEventListener('abort', abort, { once: true });
      entry.release = () => boundSignal.removeEventListener('abort', abort);
    }
    this.entries.set(id, entry);
    return structuredClone(descriptor);
  }
  /** Program-only: caller must obtain this exact tuple from the authenticated provider account. */
  configure(id: string, platform: CourseLtiPlatform, expectedContextId: string, expectedResourceLinkId?: string): void {
    const entry = this.entry(id);
    if (entry.platform) fail('An LTI connection cannot replace its registered platform.', 409);
    if (!bounded(platform.clientId, 512) || !bounded(platform.deploymentId, 512) || !bounded(expectedContextId, 255) ||
        expectedResourceLinkId !== undefined && !bounded(expectedResourceLinkId, 255)) fail('Exact platform and course identifiers are required.');
    const copy: CourseLtiPlatform = { issuer: publicUrl(platform.issuer), clientId: platform.clientId, deploymentId: platform.deploymentId,
      jwksUrl: platformEndpoint(platform.jwksUrl), authorizationEndpoint: platformEndpoint(platform.authorizationEndpoint),
      ...(platform.tokenEndpoint ? { tokenEndpoint: platformEndpoint(platform.tokenEndpoint) } : {}) };
    entry.platform = copy; entry.contextId = expectedContextId; entry.resourceLinkId = expectedResourceLinkId;
  }
  status(id: string, binding: CourseLtiBinding): CourseLtiStatus {
    const entry = this.bound(id, binding);
    return { id, state: entry.consumed ? 'consumed' : entry.launch ? 'verified' : entry.platform ? 'configured' : 'prepared',
      expires_at: entry.descriptor.expires_at, ...(entry.launch ? { launch: structuredClone(entry.launch) } : {}) };
  }
  consume(id: string, binding: CourseLtiBinding): CourseLtiLaunchEvidence {
    const entry = this.bound(id, binding);
    if (!entry.launch || entry.consumed) fail('Verify a fresh LTI launch before attaching it to Ask.', 409, 'course_lti_launch_required');
    entry.consumed = true; entry.logins.clear(); return structuredClone(entry.launch);
  }
  revoke(id: string, binding: CourseLtiBinding): void { this.remove(this.bound(id, binding)); }
  revokeConnection(connectionId: string): void { for (const entry of this.entries.values()) if (entry.binding.connectionId === connectionId) this.remove(entry); }
  dispose(): void { for (const entry of this.entries.values()) this.remove(entry); }
  jwks(id: string): { keys: JsonWebKey[] } { return { keys: [structuredClone(this.entry(id).jwk)] }; }
  login(id: string, raw: unknown): string {
    const entry = this.entry(id), platform = entry.platform;
    if (!platform) fail('This LTI platform is not configured.', 409);
    if (entry.consumed || entry.launch) fail('This LTI launch already completed. Return to Ask.', 409);
    if (!object(raw) || raw.iss !== platform.issuer || !bounded(raw.login_hint, 2048) || raw.target_link_uri !== entry.descriptor.launch_url ||
        raw.client_id !== undefined && raw.client_id !== platform.clientId || raw.lti_deployment_id !== undefined && raw.lti_deployment_id !== platform.deploymentId ||
        raw.lti_message_hint !== undefined && !bounded(raw.lti_message_hint, 8192)) fail('The login does not match this registered course connection.', 401, 'course_lti_login_rejected');
    const now = this.clock();
    for (const [state, login] of entry.logins) if (login.expires <= now) entry.logins.delete(state);
    if (entry.logins.size >= MAX_LOGINS) fail('Too many pending launches. Retry after the earlier launch expires.', 429);
    const state = opaque(), nonce = opaque(); entry.logins.set(state, { nonce, expires: Math.min(entry.expires, now + LOGIN_MS) });
    const url = new URL(platform.authorizationEndpoint);
    // Remove duplicates and alternate-cased reserved names before inserting the
    // current state, nonce and registered client/target. In particular a stale
    // configured lti_message_hint must not survive when this login has none.
    for (const key of [...url.searchParams.keys()]) if (AUTHORIZATION_ARGUMENTS.has(key.toLowerCase())) url.searchParams.delete(key);
    for (const [key, value] of Object.entries({ response_type: 'id_token', response_mode: 'form_post', client_id: platform.clientId,
      redirect_uri: entry.descriptor.launch_url, scope: 'openid', prompt: 'none', state, nonce, login_hint: raw.login_hint,
      ...(typeof raw.lti_message_hint === 'string' ? { lti_message_hint: raw.lti_message_hint } : {}) })) url.searchParams.set(key, value);
    return url.href;
  }
  async launch(id: string, raw: unknown): Promise<void> {
    const entry = this.entry(id), platform = entry.platform;
    if (!platform || entry.consumed || entry.launch || !object(raw) || !bounded(raw.state, 200)) fail('No matching LTI launch is pending.', 401, 'course_lti_launch_rejected');
    // Spend the state before verification, including unsuccessful attempts.
    const login = entry.logins.get(raw.state); entry.logins.delete(raw.state);
    if (!login || login.expires <= this.clock() || !bounded(raw.id_token, MAX_JWT)) fail('The LTI launch expired or was already used.', 401, 'course_lti_launch_rejected');
    if (entry.verifying >= 4 || this.verifications >= 32) fail('LTI verification is busy. Prepare another launch shortly.', 429, 'course_lti_capacity');
    let verified: CourseLtiVerifyResult;
    entry.verifying++; this.verifications++;
    try { verified = await this.verifyJwt(raw.id_token, platform.jwksUrl, entry.abort.signal); }
    catch {
      if (entry.abort.signal.aborted || entry.binding.signal?.aborted || entry.expires <= this.clock()) fail('This LTI connection ended during verification.', 410, 'course_lti_expired');
      fail('The registered platform launch could not be verified.', 401, 'course_lti_token_rejected');
    }
    finally { entry.verifying--; this.verifications--; }
    if (this.entries.get(id) !== entry || entry.expires <= this.clock() || entry.binding.signal?.aborted || entry.abort.signal.aborted) fail('This LTI connection ended during verification.', 410, 'course_lti_expired');
    if (!verified.ok || !object(verified.payload) || !object(verified.header) || !['RS256', 'ES256'].includes(String(verified.header.alg))) fail('The registered platform launch could not be verified.', 401, 'course_lti_token_rejected');
    const p = verified.payload, audiences = Array.isArray(p.aud) ? p.aud : [p.aud], now = this.clock() / 1000;
    const context = p[LTI_CLAIMS.context], resource = p[LTI_CLAIMS.resourceLink], roles = p[LTI_CLAIMS.roles];
    if (p.iss !== platform.issuer || !audiences.length || audiences.length > 8 || !audiences.every(value => bounded(value, 512)) ||
        !audiences.includes(platform.clientId) || p.azp !== undefined && p.azp !== platform.clientId || audiences.length > 1 && p.azp !== platform.clientId ||
        !bounded(p.sub, 255) || !/^[\x21-\x7e]+$/.test(p.sub) || p.nonce !== login.nonce ||
        typeof p.iat !== 'number' || !Number.isFinite(p.iat) || p.iat > now + 60 || p.iat < now - 300 ||
        typeof p.exp !== 'number' || !Number.isFinite(p.exp) || p.exp <= now || p.exp <= p.iat || p.exp - p.iat > 600 ||
        p.nbf !== undefined && (typeof p.nbf !== 'number' || !Number.isFinite(p.nbf) || p.nbf > now + 60) ||
        p[LTI_CLAIMS.deploymentId] !== platform.deploymentId || p[LTI_CLAIMS.version] !== '1.3.0' ||
        p[LTI_CLAIMS.messageType] !== 'LtiResourceLinkRequest' || p[LTI_CLAIMS.targetLinkUri] !== entry.descriptor.launch_url ||
        !Array.isArray(roles) || roles.length > 32 || !roles.every(role => bounded(role, 512)) ||
        !object(context) || context.id !== entry.contextId || !object(resource) || !bounded(resource.id, 255) ||
        entry.resourceLinkId !== undefined && resource.id !== entry.resourceLinkId) fail('The verified launch does not match this user-scoped course connection.', 401, 'course_lti_claims_rejected');
    // Another valid state may have finished while the key request was in flight.
    if (entry.launch || entry.consumed) fail('This LTI launch already completed.', 409);
    entry.launch = { issuer: platform.issuer, client_id: platform.clientId, deployment_id: platform.deploymentId, subject: p.sub,
      context_id: entry.contextId!, resource_link_id: resource.id, verified_at: new Date(this.clock()).toISOString(),
      course_id: entry.binding.courseId, version: entry.binding.version };
    entry.logins.clear();
  }
  attachRoutes(app: Express): void {
    const form = express.urlencoded({ extended: false, limit: '96kb', parameterLimit: 24 });
    const route = (operation: (id: string, input: unknown) => unknown | Promise<unknown>) => (req: express.Request, res: express.Response): void => {
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer').set('X-Content-Type-Options', 'nosniff');
      void (async () => {
        if (req.method !== 'GET' && Object.keys(req.query).length) fail('LTI launch arguments must be sent in the form body.');
        const result = await operation(String(req.params.id), req.method === 'GET' ? req.query : req.body);
        if (typeof result === 'string') res.redirect(302, result);
        else if (result !== undefined) res.json(result);
        else res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors " +
          this.base + ' ' + new URL(this.entry(String(req.params.id)).platform!.issuer).origin)
          .type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Course launch verified</title><style>body{font:18px system-ui;max-width:40rem;margin:3rem auto;padding:1rem;color:#183048}</style><h1>Course launch verified</h1><p>Return to your original Ask tab and select <b>Use verified launch</b>. The launch has not granted content access or attached itself to an agent.</p></html>');
      })().catch(error => {
        const known = error instanceof CourseLtiError;
        res.status(known ? error.status : 500).json({ error: known ? error.message : 'The LTI connection is unavailable.', code: known ? error.code : 'course_lti_unavailable' });
      });
    };
    app.get(ROOT + '/:id/jwks', route((id, input) => {
      if (!object(input) || Object.keys(input).length) fail('Public keys do not accept URL arguments.');
      return this.jwks(id);
    }));
    app.get(ROOT + '/:id/login', route((id, input) => this.login(id, input)));
    app.post(ROOT + '/:id/login', form, route((id, input) => this.login(id, input)));
    app.post(ROOT + '/:id/launch', form, route((id, input) => this.launch(id, input)));
  }
}
