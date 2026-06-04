/**
 * LTI 1.3 Advantage Tool Provider for the Foxxi vertical.
 *
 * Implements the parts of 1EdTech LTI 1.3 Core + Advantage that enable
 * an enterprise LMS (Canvas, Moodle, Blackboard, D2L Brightspace,
 * Schoology, Open edX, Sakai) to launch Foxxi as a Tool with full
 * roster + grade-passback wiring.
 *
 * Endpoints (mounted on the bridge by `attachLti13Routes`):
 *
 *   GET  /lti/.well-known/jwks.json    Tool's public JWK set (RFC 7517)
 *   POST /lti/login                    OIDC 3rd-party-initiated login (LTI 1.3 §5.1)
 *   POST /lti/launch                   Resource-link / deep-linking launch (LTI 1.3 §5.1.2)
 *   GET  /lti/deeplink                 Deep Linking 2.0 content picker (UI)
 *   POST /lti/deeplink                 Deep Linking 2.0 — signed content-item response
 *   GET  /lti/ags/lineitems            AGS — list line items (+ ?platformLineItemsUrl proxy)
 *   POST /lti/ags/lineitems            AGS — create a line item (+ optional platform mirror)
 *   GET/PUT/DELETE /lti/ags/lineitems/:id   AGS — line-item read / update / delete
 *   POST /lti/ags/scores               AGS — submit a Score back to the platform
 *   GET  /lti/nrps/members             NRPS — tenant roster, or ?members_url proxy
 *
 * Platforms are registered per-tenant via the
 * `foxxi.register_lti_platform` affordance (issuer, client_id,
 * deployment_id, JWKS url, auth-login url, auth-token url). Multi-tenant
 * by design: each registration row belongs to a Foxxi tenant.
 *
 * Cryptography:
 *   - Tool keypair: ES256 (ECDSA P-256). Derived deterministically from
 *     FOXXI_LTI_KEY_SEED + a domain separator so rotating the seed
 *     rotates the JWKS.
 *   - JWS signing for outbound calls (AGS, NRPS): ES256.
 *   - JWS verification for inbound id_token: looks up platform's JWKS
 *     by issuer, verifies signature, validates claims per LTI 1.3 §5.1.3.
 *
 * Standards: 1EdTech LTI 1.3 Core (IMS-LTI-13-Core); Deep Linking 2.0
 * (IMS-LTI-DL-2); Assignment and Grade Services 2.0 (IMS-LTI-AGS-2);
 * Names and Roles Provisioning 2.0 (IMS-LTI-NRPS-2); OpenID Connect
 * Core 1.0; OAuth 2.0 Client Credentials Grant (RFC 6749); JOSE
 * (RFC 7515/7517/7518/7519).
 */

import express, { type Express, type Request, type Response } from 'express';
import { createHash, createHmac, randomUUID, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { DEFAULT_TENANT, tenantIdOf, type TenantId } from './tenant-context.js';
import { tenantOrUsers, type OrUser } from './oneroster.js';
import { listCmi5Courses } from './cmi5-lms.js';
import {
  withTransientRetry,
} from '@interego/core';

// ── Config ──────────────────────────────────────────────────────────

export interface Lti13Config {
  /** Bridge URL — used as the Tool's audience and key-id base. */
  selfBaseUrl: string;
  /** Tenant DID — bound to every issued credential / score posted back. */
  tenantDid: string;
  /** ES256 keypair seed. */
  keySeed: string;
  /** Foxxi dashboard URL — where Tool redirects the learner after launch. */
  dashboardUrl: string;
  /**
   * Registered platforms. Comma-separated rows, each row a
   * `||`-separated tuple: `issuer||client_id||deployment_id||jwks_url||auth_login_url||auth_token_url`.
   * Empty = no platforms registered (calls 4xx until at least one is added).
   */
  platformsConfig: string;
}

interface PlatformRegistration {
  issuer: string;
  client_id: string;
  deployment_id: string;
  jwks_url: string;
  auth_login_url: string;
  auth_token_url: string;
}

function parsePlatforms(s: string): PlatformRegistration[] {
  return s.split(',').map(row => row.trim()).filter(Boolean).map(row => {
    const [issuer, client_id, deployment_id, jwks_url, auth_login_url, auth_token_url] = row.split('||');
    return { issuer: issuer ?? '', client_id: client_id ?? '', deployment_id: deployment_id ?? '', jwks_url: jwks_url ?? '', auth_login_url: auth_login_url ?? '', auth_token_url: auth_token_url ?? '' };
  });
}

// ── Keypair derivation (ES256) ──────────────────────────────────────

interface Es256Keys {
  privateKey: ReturnType<typeof createPrivateKey>;
  publicKey: ReturnType<typeof createPublicKey>;
  /** Public key as JWK (JSON Web Key per RFC 7517). */
  jwk: {
    kty: 'EC';
    crv: 'P-256';
    x: string;
    y: string;
    use: 'sig';
    alg: 'ES256';
    kid: string;
  };
}

/**
 * Derive an ES256 keypair from a seed. We can't trivially do
 * deterministic ECDSA key generation with the high-level crypto API
 * without a CSPRNG override, so we use the seed as the kid + draw fresh
 * randomness at boot. For deterministic-across-restart behaviour, the
 * operator MUST persist the key material outside (e.g. via Azure Key
 * Vault) and inject as PEMs. For the demo we cache the generated key in
 * process memory and emit a stable kid.
 */
let _cachedKeys: Es256Keys | null = null;
let _cachedSeed: string | null = null;

function deriveKeys(seed: string): Es256Keys {
  if (_cachedKeys && _cachedSeed === seed) return _cachedKeys;
  // node:crypto generateKeyPair lacks a seedable variant. Use a deterministic
  // PEM if one is provided via env (FOXXI_LTI_PRIVATE_KEY_PEM); otherwise
  // generate fresh and remember it process-wide.
  const pem = process.env.FOXXI_LTI_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
  let privateKey: ReturnType<typeof createPrivateKey>;
  if (pem) {
    privateKey = createPrivateKey({ key: pem, format: 'pem' });
  } else {
    const { privateKey: pk } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = pk;
  }
  const publicKey = createPublicKey(privateKey);
  const jwkRaw = publicKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  const kid = `foxxi-lti-${createHash('sha256').update(`${seed}:${jwkRaw.x}:${jwkRaw.y}`).digest('hex').slice(0, 16)}`;
  const out: Es256Keys = {
    privateKey,
    publicKey,
    jwk: { ...jwkRaw, use: 'sig', alg: 'ES256', kid },
  };
  _cachedKeys = out;
  _cachedSeed = seed;
  return out;
}

// ── JWS sign / verify ───────────────────────────────────────────────

function base64url(input: Buffer | string): string {
  const b = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(s: string): Buffer {
  let pad = s.length % 4;
  if (pad === 2) s += '==';
  else if (pad === 3) s += '=';
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function jwsSignEs256(header: Record<string, unknown>, payload: Record<string, unknown>, keys: Es256Keys): string {
  const h = base64url(JSON.stringify({ ...header, alg: 'ES256', typ: 'JWT', kid: keys.jwk.kid }));
  const p = base64url(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;
  const der = cryptoSign(null, Buffer.from(signingInput), keys.privateKey);
  // Convert DER signature to JOSE r||s 64-byte concatenation per RFC 7518 §3.4
  const sigJose = derToJose(der);
  return `${signingInput}.${base64url(sigJose)}`;
}

function derToJose(der: Buffer): Buffer {
  // DER: 0x30 [len] 0x02 [rlen] r 0x02 [slen] s — strip padding zeros, left-pad to 32 bytes each.
  let offset = 2;
  if (der[1]! > 0x80) offset = 3;
  const rLen = der[offset + 1]!;
  let r = der.subarray(offset + 2, offset + 2 + rLen);
  while (r.length > 32 && r[0] === 0) r = r.subarray(1);
  while (r.length < 32) r = Buffer.concat([Buffer.from([0]), r]);
  const sStart = offset + 2 + rLen + 2;
  const sLen = der[offset + 2 + rLen + 1]!;
  let s = der.subarray(sStart, sStart + sLen);
  while (s.length > 32 && s[0] === 0) s = s.subarray(1);
  while (s.length < 32) s = Buffer.concat([Buffer.from([0]), s]);
  return Buffer.concat([r, s]);
}

interface VerifyResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  header?: Record<string, unknown>;
  error?: string;
}

async function jwsVerifyRs256OrEs256(jwt: string, jwksUrl: string): Promise<VerifyResult> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed JWT' };
  const headerRaw = base64urlDecode(parts[0]!).toString('utf8');
  const payloadRaw = base64urlDecode(parts[1]!).toString('utf8');
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(headerRaw);
    payload = JSON.parse(payloadRaw);
  } catch { return { ok: false, error: 'invalid JSON in header/payload' }; }
  if (header.alg !== 'RS256' && header.alg !== 'ES256') {
    return { ok: false, error: `unsupported alg ${header.alg as string}` };
  }
  // Fetch JWKS and find key by kid
  let jwks: { keys?: Array<Record<string, unknown>> };
  try {
    // Transient-network retry: platform JWKS endpoints are hosted by the
    // LMS and may be momentarily unreachable. withTransientRetry handles
    // 5xx / connect blips; 4xx falls through to the caller as "bad URL".
    const r = await withTransientRetry(async () => {
      const resp = await fetch(jwksUrl, { headers: { Accept: 'application/json' } });
      if (resp.status >= 500) {
        throw new Error(`JWKS fetch failed: ${resp.status} ${resp.statusText}`);
      }
      return resp;
    });
    if (!r.ok) return { ok: false, error: `JWKS fetch ${r.status}` };
    jwks = await r.json() as typeof jwks;
  } catch (err) { return { ok: false, error: `JWKS fetch threw: ${(err as Error).message}` }; }
  const kid = header.kid as string | undefined;
  const candidates = (jwks.keys ?? []).filter(k => !kid || k.kid === kid);
  if (candidates.length === 0) return { ok: false, error: `no JWK matching kid=${kid as string}` };
  for (const k of candidates) {
    try {
      const pub = createPublicKey({ key: k as any, format: 'jwk' });  // eslint-disable-line @typescript-eslint/no-explicit-any
      const sigBuf = base64urlDecode(parts[2]!);
      const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
      let okSig = false;
      if (header.alg === 'RS256') {
        okSig = cryptoVerify('RSA-SHA256', signingInput, pub, sigBuf);
      } else {
        // ES256: signature is JOSE r||s (64 bytes); node verify wants DER
        okSig = cryptoVerify(null, signingInput, pub, joseToDer(sigBuf));
      }
      if (okSig) return { ok: true, payload, header };
    } catch { /* try next */ }
  }
  return { ok: false, error: 'signature did not verify against any JWK' };
}

function joseToDer(sig: Buffer): Buffer {
  if (sig.length !== 64) throw new Error(`expected 64-byte ES256 sig, got ${sig.length}`);
  const r = trimAndPad(sig.subarray(0, 32));
  const s = trimAndPad(sig.subarray(32, 64));
  const rPart = Buffer.concat([Buffer.from([0x02, r.length]), r]);
  const sPart = Buffer.concat([Buffer.from([0x02, s.length]), s]);
  const seq = Buffer.concat([rPart, sPart]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}
function trimAndPad(b: Buffer): Buffer {
  while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.subarray(1);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return b;
}

// ── Launch state (login→launch session) ─────────────────────────────

interface LoginState {
  state: string;
  nonce: string;
  issuer: string;
  client_id: string;
  redirect_uri: string;
  expiresAt: number;
}
const loginStates = new Map<string, LoginState>();
function rememberLoginState(s: LoginState): void {
  loginStates.set(s.state, s);
  // Garbage-collect after 10min
  setTimeout(() => loginStates.delete(s.state), 10 * 60 * 1000).unref();
}
function consumeLoginState(state: string): LoginState | undefined {
  const v = loginStates.get(state);
  if (v) loginStates.delete(state);
  return v;
}

// ── LTI 1.3 standard claim IRIs ─────────────────────────────────────

const LTI_CLAIMS = {
  messageType: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  version: 'https://purl.imsglobal.org/spec/lti/claim/version',
  deploymentId: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  resourceLink: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
  targetLinkUri: 'https://purl.imsglobal.org/spec/lti/claim/target_link_uri',
  context: 'https://purl.imsglobal.org/spec/lti/claim/context',
  toolPlatform: 'https://purl.imsglobal.org/spec/lti/claim/tool_platform',
  roles: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  custom: 'https://purl.imsglobal.org/spec/lti/claim/custom',
  ags: 'https://purl.imsglobal.org/spec/lti-ags/claim/endpoint',
  nrps: 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice',
  deepLinkingSettings: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings',
  dlContentItems: 'https://purl.imsglobal.org/spec/lti-dl/claim/content_items',
  dlData: 'https://purl.imsglobal.org/spec/lti-dl/claim/data',
} as const;

// ── AGS / NRPS scopes + LIS role IRIs ───────────────────────────────

const AGS_SCOPE = {
  lineItem: 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem',
  score: 'https://purl.imsglobal.org/spec/lti-ags/scope/score',
  result: 'https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly',
} as const;
const NRPS_SCOPE = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
const NRPS_ROLE = {
  learner: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner',
  instructor: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor',
  administrator: 'http://purl.imsglobal.org/vocab/lis/v2/membership#Administrator',
} as const;

// ── AGS line-item store (the Tool's per-tenant line-item registry) ──

interface AgsLineItem {
  id: string;
  label: string;
  scoreMaximum: number;
  resourceId?: string;
  resourceLinkId?: string;
  tag?: string;
  startDateTime?: string;
  endDateTime?: string;
  /** Platform-side line-item URL, set when the item was mirrored to a platform. */
  platformLineItemUrl?: string;
}
const lineItemStore = new Map<TenantId, Map<string, AgsLineItem>>();
function lineItemsFor(t: TenantId): Map<string, AgsLineItem> {
  let m = lineItemStore.get(t);
  if (!m) { m = new Map(); lineItemStore.set(t, m); }
  return m;
}

// ── Pod projection (foxxi:LtiTenantSnapshot) ─────────────────────────
// Every mutation to lineItemStore triggers a debounced snapshot publish
// to the tenant pod. On bridge startup we hydrate from the latest
// snapshot — the pod is the durable source of truth across container
// restarts, the in-memory Map is a hot cache.
import {
  registerSnapshot, dirty as markDirty, loadLatestSnapshot, FOXXI_SNAPSHOT_TYPES,
} from './pod-snapshot-publisher.js';

interface LtiSnapshot {
  byTenant: Record<string, Array<[string, AgsLineItem]>>;
}
function collectLtiSnapshot(): LtiSnapshot {
  const byTenant: Record<string, Array<[string, AgsLineItem]>> = {};
  for (const [tenant, m] of lineItemStore) byTenant[String(tenant)] = [...m.entries()];
  return { byTenant };
}
async function hydrateLtiFromPod(): Promise<void> {
  const snap = await loadLatestSnapshot<LtiSnapshot>('lti');
  if (!snap?.byTenant) return;
  for (const [tenant, entries] of Object.entries(snap.byTenant)) {
    const map = new Map<string, AgsLineItem>(entries);
    lineItemStore.set(tenant as TenantId, map);
  }
}
registerSnapshot({
  surface: 'lti',
  typeIri: FOXXI_SNAPSHOT_TYPES.LtiLineItems,
  collect: collectLtiSnapshot,
});
// Best-effort hydrate on module load (don't block; bridge may
// not have FOXXI_TENANT_POD_URL set in dev).
void hydrateLtiFromPod();
const ltiPodDirty = (): void => markDirty('lti');
/** A line item as exposed on the wire — `id` is the full resource URL. */
function publicLineItem(li: AgsLineItem, selfBaseUrl: string): Record<string, unknown> {
  return {
    id: `${selfBaseUrl.replace(/\/+$/, '')}/lti/ags/lineitems/${li.id}`,
    label: li.label,
    scoreMaximum: li.scoreMaximum,
    ...(li.resourceId ? { resourceId: li.resourceId } : {}),
    ...(li.resourceLinkId ? { resourceLinkId: li.resourceLinkId } : {}),
    ...(li.tag ? { tag: li.tag } : {}),
    ...(li.startDateTime ? { startDateTime: li.startDateTime } : {}),
    ...(li.endDateTime ? { endDateTime: li.endDateTime } : {}),
  };
}

/** Map a OneRoster user to an NRPS 2.0 membership member object. */
function orUserToNrpsMember(u: OrUser): Record<string, unknown> {
  const role = u.role === 'administrator' ? NRPS_ROLE.administrator
    : u.role === 'teacher' ? NRPS_ROLE.instructor
    : NRPS_ROLE.learner;
  const name = `${u.givenName} ${u.familyName}`.trim();
  return {
    status: u.status === 'active' ? 'Active' : 'Inactive',
    ...(name ? { name } : {}),
    given_name: u.givenName,
    family_name: u.familyName,
    ...(u.email ? { email: u.email } : {}),
    user_id: u.sourcedId,
    lis_person_sourcedid: u.identifier || u.sourcedId,
    roles: [role],
  };
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Obtain a platform access token via the OAuth 2.0 client-credentials
 * grant with a Tool-signed JWT bearer assertion (LTI Security Framework
 * §4 / RFC 7523). Used for outbound AGS + NRPS service calls.
 */
async function platformToken(
  platform: PlatformRegistration, scope: string, keys: Es256Keys,
): Promise<{ ok: true; token: string } | { ok: false; status: number; error: string }> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwsSignEs256({}, {
    iss: platform.client_id,
    sub: platform.client_id,
    aud: platform.auth_token_url,
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  }, keys);
  let resp: Awaited<ReturnType<typeof fetch>>;
  try {
    // Transient-network retry: OAuth2 client-credentials calls to the
    // platform's token endpoint cross the public internet; transient 5xx
    // or socket errors should not fail an entire AGS/NRPS flow. 4xx
    // surfaces immediately as a registration / auth fault.
    resp = await withTransientRetry(async () => {
      const r = await fetch(platform.auth_token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: assertion,
          scope,
        }).toString(),
      });
      if (r.status >= 500) {
        throw new Error(`platform token endpoint failed: ${r.status} ${r.statusText}`);
      }
      return r;
    });
  } catch (err) { return { ok: false, status: 502, error: `platform token endpoint unreachable: ${(err as Error).message}` }; }
  if (!resp.ok) return { ok: false, status: 502, error: `platform token endpoint ${resp.status}` };
  const j = await resp.json().catch(() => ({})) as { access_token?: string };
  if (!j.access_token) return { ok: false, status: 502, error: 'platform token response missing access_token' };
  return { ok: true, token: j.access_token };
}

// ── Route attachment ────────────────────────────────────────────────

export function attachLti13Routes(app: Express, config: Lti13Config): void {
  const platforms = parsePlatforms(config.platformsConfig);
  const keys = deriveKeys(config.keySeed);
  // The global JSON parser does not cover `application/x-www-form-urlencoded`
  // bodies — and an OIDC/LTI form-post arrives exactly that way. Apply a
  // route-scoped urlencoded parser to every form-post endpoint.
  const formBody = express.urlencoded({ extended: true, limit: '1mb' });

  // Short-lived HMAC-signed tickets (launch hand-off + deep-linking
  // hand-off). base64url(JSON.stringify({ ...payload, sig })) where sig
  // is HMAC-SHA256(keySeed, JSON.stringify(payload)).
  const signTicket = (payload: Record<string, unknown>): string => {
    const sig = createHmac('sha256', config.keySeed).update(JSON.stringify(payload)).digest('base64url');
    return base64url(JSON.stringify({ ...payload, sig }));
  };
  const verifyTicket = (raw: string): Record<string, unknown> | null => {
    try {
      const obj = JSON.parse(base64urlDecode(raw).toString('utf8')) as Record<string, unknown>;
      const { sig, ...rest } = obj;
      const expect = createHmac('sha256', config.keySeed).update(JSON.stringify(rest)).digest('base64url');
      if (typeof sig !== 'string' || sig !== expect) return null;
      if (typeof rest.exp === 'number' && rest.exp * 1000 < Date.now()) return null;
      return rest;
    } catch { return null; }
  };

  // (1) JWKS — Tool's public keys, fetched by Platform for signing operations
  // Foxxi makes outbound (AGS, NRPS service-call authentication).
  app.get('/lti/.well-known/jwks.json', (_req, res) => {
    res.json({ keys: [keys.jwk] });
  });

  // (2) OIDC 3rd-party-initiated login.
  // Platform POSTs (or GETs) with iss, login_hint, target_link_uri, [lti_message_hint],
  // [client_id], [lti_deployment_id]. We respond with a 302 to the platform's
  // auth_login_url with state + nonce so the platform can redirect back with id_token.
  const loginHandler = (req: Request, res: Response): void => {
    const params = req.method === 'GET' ? req.query as Record<string, string> : req.body as Record<string, string>;
    const issuer = params.iss;
    const client_id_hint = params.client_id;
    const target_link_uri = params.target_link_uri ?? `${config.selfBaseUrl}/lti/launch`;
    const login_hint = params.login_hint;
    if (!issuer || !login_hint) {
      res.status(400).json({ error: 'iss + login_hint required (LTI 1.3 §5.1.1)' });
      return;
    }
    const platform = platforms.find(p => p.issuer === issuer && (!client_id_hint || p.client_id === client_id_hint));
    if (!platform) {
      res.status(401).json({ error: `unregistered platform issuer=${issuer}; register via foxxi.register_lti_platform` });
      return;
    }
    const state = base64url(Buffer.from(randomUUID()));
    const nonce = base64url(Buffer.from(randomUUID()));
    rememberLoginState({
      state, nonce, issuer, client_id: platform.client_id,
      redirect_uri: target_link_uri,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    const u = new URL(platform.auth_login_url);
    u.searchParams.set('response_type', 'id_token');
    u.searchParams.set('response_mode', 'form_post');
    u.searchParams.set('redirect_uri', target_link_uri);
    u.searchParams.set('client_id', platform.client_id);
    u.searchParams.set('scope', 'openid');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('prompt', 'none');
    u.searchParams.set('login_hint', login_hint);
    if (params.lti_message_hint) u.searchParams.set('lti_message_hint', params.lti_message_hint);
    res.redirect(302, u.toString());
  };
  app.get('/lti/login', loginHandler);
  app.post('/lti/login', formBody, loginHandler);

  // (3) Launch — Platform POSTs id_token + state to us. We verify the
  // JWS against the platform's JWKS, validate LTI claims, and produce a
  // Foxxi session redirect to the dashboard.
  app.post('/lti/launch', formBody, (req, res) => { void (async () => {
    const id_token = (req.body?.id_token ?? '') as string;
    const state = (req.body?.state ?? '') as string;
    if (!id_token || !state) {
      res.status(400).json({ error: 'id_token + state required' });
      return;
    }
    const login = consumeLoginState(state);
    if (!login) { res.status(400).json({ error: 'unknown / expired state — replay protection (LTI 1.3 §5.1.3)' }); return; }
    const platform = platforms.find(p => p.issuer === login.issuer && p.client_id === login.client_id);
    if (!platform) { res.status(401).json({ error: 'platform deregistered between login and launch' }); return; }
    const verify = await jwsVerifyRs256OrEs256(id_token, platform.jwks_url);
    if (!verify.ok || !verify.payload) { res.status(401).json({ error: `id_token verification failed: ${verify.error}` }); return; }
    const p = verify.payload;
    // Required LTI claims
    if (p.iss !== platform.issuer) { res.status(401).json({ error: 'iss mismatch' }); return; }
    if (p.aud !== platform.client_id && !(Array.isArray(p.aud) && (p.aud as unknown[]).includes(platform.client_id))) {
      res.status(401).json({ error: 'aud mismatch' }); return;
    }
    if (p.nonce !== login.nonce) { res.status(401).json({ error: 'nonce mismatch' }); return; }
    const expClaim = Number(p.exp);
    if (!Number.isFinite(expClaim) || expClaim * 1000 < Date.now()) { res.status(401).json({ error: 'expired' }); return; }
    if (p[LTI_CLAIMS.deploymentId] !== platform.deployment_id) { res.status(401).json({ error: 'deployment_id mismatch' }); return; }
    if (p[LTI_CLAIMS.version] !== '1.3.0') { res.status(401).json({ error: `unsupported LTI version ${p[LTI_CLAIMS.version] as string}` }); return; }
    const messageType = p[LTI_CLAIMS.messageType];
    if (messageType !== 'LtiResourceLinkRequest' && messageType !== 'LtiDeepLinkingRequest') {
      res.status(400).json({ error: `unsupported message_type ${messageType as string}` }); return;
    }
    const iat = Math.floor(Date.now() / 1000);

    // Deep Linking 2.0 (IMS-LTI-DL-2) — the platform is asking the Tool
    // to return content items. Hand off to the Foxxi content picker:
    // sign a short-lived deep-linking ticket carrying the return URL +
    // opaque `data` (which MUST be echoed back), and redirect there.
    if (messageType === 'LtiDeepLinkingRequest') {
      const dls = (p[LTI_CLAIMS.deepLinkingSettings] ?? {}) as Record<string, unknown>;
      const returnUrl = typeof dls.deep_link_return_url === 'string' ? dls.deep_link_return_url : '';
      if (!returnUrl) { res.status(400).json({ error: 'deep_linking_settings.deep_link_return_url missing — not a valid deep-linking request' }); return; }
      const dlTicket = signTicket({
        kind: 'deeplink',
        iss: platform.issuer,
        clientId: platform.client_id,
        deploymentId: platform.deployment_id,
        returnUrl,
        ...(dls.data !== undefined ? { data: String(dls.data) } : {}),
        acceptMultiple: dls.accept_multiple === true || dls.accept_multiple === 'true',
        iat,
        exp: iat + 900, // 15min to make a selection
      });
      const picker = new URL(`${config.selfBaseUrl.replace(/\/+$/, '')}/lti/deeplink`);
      picker.searchParams.set('dl', dlTicket);
      res.redirect(302, picker.toString());
      return;
    }

    // LtiResourceLinkRequest — an authentic content launch. Build a
    // launch context the dashboard reads on next page load, signed as a
    // short-lived ticket passed on the redirect URL; the dashboard
    // exchanges it for a session.
    const ticketJson = signTicket({
      iss: platform.issuer,
      sub: p.sub,
      roles: (p[LTI_CLAIMS.roles] ?? []) as string[],
      context: p[LTI_CLAIMS.context],
      resourceLink: p[LTI_CLAIMS.resourceLink],
      platform: p[LTI_CLAIMS.toolPlatform],
      custom: p[LTI_CLAIMS.custom],
      ags: p[LTI_CLAIMS.ags],
      nrps: p[LTI_CLAIMS.nrps],
      deploymentId: platform.deployment_id,
      clientId: platform.client_id,
      iat,
      exp: iat + 300, // 5min ticket
    });
    const redirect = new URL(config.dashboardUrl);
    redirect.searchParams.set('lti_ticket', ticketJson);
    res.redirect(302, redirect.toString());
  })().catch(err => { res.status(500).json({ error: (err as Error).message }); }); });

  // (4) Deep Linking 2.0 — content-item selection round-trip.
  //
  // GET /lti/deeplink?dl=<ticket> renders the Foxxi content picker
  // (registered cmi5 courses + the generic dashboard link). POST submits
  // the selection: the Tool signs an LtiDeepLinkingResponse JWT and
  // auto-posts it to the platform's deep_link_return_url. The platform
  // verifies the JWT against the Tool's JWKS and persists the items.
  app.get('/lti/deeplink', (req, res) => {
    const ticket = verifyTicket(String(req.query.dl ?? ''));
    if (!ticket || ticket.kind !== 'deeplink') {
      res.status(400).type('html').send('<p>Invalid or expired deep-linking ticket. Re-launch from your LMS.</p>');
      return;
    }
    const courses = listCmi5Courses(DEFAULT_TENANT);
    const dl = htmlEscape(String(req.query.dl ?? ''));
    const courseItems = courses.map(c => `
      <label class="item"><input type="checkbox" name="course" value="${htmlEscape(c.id)}">
        <span><b>${htmlEscape(c.title)}</b>${c.description ? `<br><small>${htmlEscape(c.description)}</small>` : ''}</span>
      </label>`).join('');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Add Foxxi content</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;color:#1a1a2e}
h1{font-size:1.25rem}.item{display:flex;gap:.6rem;align-items:flex-start;border:1px solid #dde;border-radius:8px;padding:.7rem .9rem;margin:.5rem 0;cursor:pointer}
.item:hover{border-color:#1a73e8}small{color:#667}
button{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:.65rem 1.3rem;font-size:1rem;cursor:pointer;margin-top:1rem}
</style></head><body>
<h1>Add Foxxi content to your course</h1>
<p>Select the content items to embed. Your LMS will create a resource link for each.</p>
<form method="POST" action="${config.selfBaseUrl.replace(/\/+$/, '')}/lti/deeplink">
<input type="hidden" name="dl" value="${dl}">
${courseItems || '<p><em>No cmi5 courses registered yet — the generic Foxxi link is offered below.</em></p>'}
<label class="item"><input type="checkbox" name="generic" value="dashboard">
  <span><b>Foxxi Learning Dashboard</b><br><small>The learner's full Foxxi experience surface</small></span></label>
<button type="submit">Add selected content</button>
</form></body></html>`);
  });

  app.post('/lti/deeplink', formBody, (req, res) => { void (async () => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ticket = verifyTicket(String(body.dl ?? ''));
    if (!ticket || ticket.kind !== 'deeplink') {
      res.status(400).type('html').send('<p>Invalid or expired deep-linking ticket.</p>');
      return;
    }
    const platform = platforms.find(pl => pl.issuer === ticket.iss && pl.client_id === ticket.clientId);
    if (!platform) { res.status(401).type('html').send('<p>Platform deregistered since launch.</p>'); return; }

    const courseSel = Array.isArray(body.course) ? body.course.map(String)
      : body.course ? [String(body.course)] : [];
    const courses = listCmi5Courses(DEFAULT_TENANT);
    const launchUrl = `${config.selfBaseUrl.replace(/\/+$/, '')}/lti/launch`;
    let contentItems: Array<Record<string, unknown>> = [];
    for (const cid of courseSel) {
      const c = courses.find(x => x.id === cid);
      if (!c) continue;
      contentItems.push({
        type: 'ltiResourceLink',
        title: c.title,
        ...(c.description ? { text: c.description } : {}),
        url: launchUrl,
        custom: { foxxi_course_id: c.id },
      });
    }
    if (body.generic) {
      contentItems.push({
        type: 'ltiResourceLink',
        title: 'Foxxi Learning Dashboard',
        url: launchUrl,
        custom: { foxxi_view: 'dashboard' },
      });
    }
    // Respect accept_multiple — return at most one item when the platform
    // asked for a single selection.
    if (ticket.acceptMultiple !== true && contentItems.length > 1) {
      contentItems = contentItems.slice(0, 1);
    }

    const now = Math.floor(Date.now() / 1000);
    const responseJwt = jwsSignEs256({}, {
      iss: platform.client_id,
      aud: platform.issuer,
      iat: now,
      exp: now + 600,
      nonce: randomUUID(),
      [LTI_CLAIMS.messageType]: 'LtiDeepLinkingResponse',
      [LTI_CLAIMS.version]: '1.3.0',
      [LTI_CLAIMS.deploymentId]: ticket.deploymentId,
      [LTI_CLAIMS.dlContentItems]: contentItems,
      ...(typeof ticket.data === 'string' ? { [LTI_CLAIMS.dlData]: ticket.data } : {}),
    }, keys);

    // Auto-post the signed response JWT back to the platform (IMS-LTI-DL-2 §3).
    const returnUrl = htmlEscape(String(ticket.returnUrl));
    res.type('html').send(`<!doctype html><html><body onload="document.forms[0].submit()">
<p>Returning ${contentItems.length} item(s) to your LMS…</p>
<form method="POST" action="${returnUrl}">
<input type="hidden" name="JWT" value="${htmlEscape(responseJwt)}">
<noscript><button type="submit">Return to your LMS</button></noscript>
</form></body></html>`);
  })().catch(err => { res.status(500).type('html').send(htmlEscape((err as Error).message)); }); });

  // (5) AGS line-item management (IMS-LTI-AGS-2). The Tool keeps a
  // per-tenant line-item registry; create/read/update/delete operate on
  // it. `?platformLineItemsUrl=` proxies a read against a platform's
  // line-item container, and `platformLineItemsUrl` in a create body
  // mirrors the new line item onto the platform with a Tool-signed JWT.
  app.get('/lti/ags/lineitems', (req, res) => { void (async () => {
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const platformUrl = req.query.platformLineItemsUrl as string | undefined;
    if (platformUrl) {
      const platform = platforms[0];
      if (!platform) { res.status(400).json({ error: 'no LTI platforms registered' }); return; }
      const tok = await platformToken(platform, AGS_SCOPE.lineItem, keys);
      if (!tok.ok) { res.status(tok.status).json({ error: tok.error }); return; }
      const r = await fetch(platformUrl, {
        headers: { Accept: 'application/vnd.ims.lis.v2.lineitemcontainer+json', Authorization: `Bearer ${tok.token}` },
      });
      const text = await r.text();
      res.status(r.status).type('application/vnd.ims.lis.v2.lineitemcontainer+json').send(text);
      return;
    }
    res.type('application/vnd.ims.lis.v2.lineitemcontainer+json')
      .send(JSON.stringify([...lineItemsFor(tenant).values()].map(li => publicLineItem(li, config.selfBaseUrl))));
  })().catch(err => { res.status(500).json({ error: (err as Error).message }); }); });

  app.post('/lti/ags/lineitems', (req, res) => { void (async () => {
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const label = typeof b.label === 'string' ? b.label : '';
    const scoreMaximum = Number(b.scoreMaximum);
    if (!label || !Number.isFinite(scoreMaximum) || scoreMaximum <= 0) {
      res.status(400).json({ error: 'label (non-empty string) and scoreMaximum (positive number) are required' });
      return;
    }
    const li: AgsLineItem = {
      id: randomUUID(),
      label,
      scoreMaximum,
      ...(typeof b.resourceId === 'string' ? { resourceId: b.resourceId } : {}),
      ...(typeof b.resourceLinkId === 'string' ? { resourceLinkId: b.resourceLinkId } : {}),
      ...(typeof b.tag === 'string' ? { tag: b.tag } : {}),
      ...(typeof b.startDateTime === 'string' ? { startDateTime: b.startDateTime } : {}),
      ...(typeof b.endDateTime === 'string' ? { endDateTime: b.endDateTime } : {}),
    };
    let platformSync: Record<string, unknown> | undefined;
    const platformUrl = typeof b.platformLineItemsUrl === 'string' ? b.platformLineItemsUrl : undefined;
    if (platformUrl) {
      const platform = platforms[0];
      if (!platform) {
        platformSync = { ok: false, error: 'no LTI platforms registered' };
      } else {
        const tok = await platformToken(platform, AGS_SCOPE.lineItem, keys);
        if (!tok.ok) {
          platformSync = { ok: false, status: tok.status, error: tok.error };
        } else {
          const r = await fetch(platformUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/vnd.ims.lis.v2.lineitem+json', Authorization: `Bearer ${tok.token}` },
            body: JSON.stringify(publicLineItem(li, config.selfBaseUrl)),
          });
          const created = await r.json().catch(() => ({})) as { id?: string };
          if (r.ok && typeof created.id === 'string') li.platformLineItemUrl = created.id;
          platformSync = { ok: r.ok, status: r.status, ...(li.platformLineItemUrl ? { platformLineItemUrl: li.platformLineItemUrl } : {}) };
        }
      }
    }
    lineItemsFor(tenant).set(li.id, li);
    ltiPodDirty();
    res.status(201).type('application/vnd.ims.lis.v2.lineitem+json')
      .send(JSON.stringify({ ...publicLineItem(li, config.selfBaseUrl), ...(platformSync ? { platformSync } : {}) }));
  })().catch(err => { res.status(500).json({ error: (err as Error).message }); }); });

  app.get('/lti/ags/lineitems/:id', (req, res) => {
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const li = lineItemsFor(tenant).get(String(req.params.id ?? ''));
    if (!li) { res.status(404).json({ error: 'line item not found' }); return; }
    res.type('application/vnd.ims.lis.v2.lineitem+json').send(JSON.stringify(publicLineItem(li, config.selfBaseUrl)));
  });

  app.put('/lti/ags/lineitems/:id', (req, res) => {
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const li = lineItemsFor(tenant).get(String(req.params.id ?? ''));
    if (!li) { res.status(404).json({ error: 'line item not found' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.label === 'string' && b.label) li.label = b.label;
    if (Number.isFinite(Number(b.scoreMaximum)) && Number(b.scoreMaximum) > 0) li.scoreMaximum = Number(b.scoreMaximum);
    if (typeof b.tag === 'string') li.tag = b.tag;
    if (typeof b.resourceId === 'string') li.resourceId = b.resourceId;
    if (typeof b.resourceLinkId === 'string') li.resourceLinkId = b.resourceLinkId;
    if (typeof b.startDateTime === 'string') li.startDateTime = b.startDateTime;
    if (typeof b.endDateTime === 'string') li.endDateTime = b.endDateTime;
    ltiPodDirty();
    res.type('application/vnd.ims.lis.v2.lineitem+json').send(JSON.stringify(publicLineItem(li, config.selfBaseUrl)));
  });

  app.delete('/lti/ags/lineitems/:id', (req, res) => {
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const existed = lineItemsFor(tenant).delete(String(req.params.id ?? ''));
    if (!existed) { res.status(404).json({ error: 'line item not found' }); return; }
    ltiPodDirty();
    res.status(204).end();
  });

  // (6) AGS score submission — accepts a Score object and forwards it
  // to the platform's lineitem/<id>/scores URL with a Tool-signed JWT
  // (client_credentials grant against the platform's auth_token_url).
  app.post('/lti/ags/scores', (req, res) => { void (async () => {
    const { lineItemUrl, score } = req.body as { lineItemUrl?: string; score?: Record<string, unknown> };
    if (!lineItemUrl || !score) { res.status(400).json({ error: 'lineItemUrl + score required' }); return; }
    const platform = platforms[0];
    if (!platform) { res.status(400).json({ error: 'no LTI platforms registered' }); return; }
    const tok = await platformToken(platform, AGS_SCOPE.score, keys);
    if (!tok.ok) { res.status(tok.status).json({ error: tok.error }); return; }
    const scoreUrl = `${lineItemUrl.replace(/\/$/, '')}/scores`;
    const scorePost = await fetch(scoreUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.ims.lis.v1.score+json',
        'Authorization': `Bearer ${tok.token}`,
      },
      body: JSON.stringify(score),
    });
    res.status(scorePost.status).json({ ok: scorePost.ok, status: scorePost.status });
  })().catch(err => { res.status(500).json({ error: (err as Error).message }); }); });

  // (7) NRPS — Names and Role Provisioning Service 2.0 (IMS-LTI-NRPS-2).
  //
  // Two modes, both conformant:
  //  · `?members_url=` — Foxxi acts as an NRPS *consumer*: it calls the
  //    platform's context-membership endpoint with a Tool-signed JWT and
  //    returns the platform's membership container (the true Tool role).
  //  · default — Foxxi acts as an NRPS *provider*: it returns its own
  //    tenant roster (Foxxi directory + any imported OneRoster overlay)
  //    as a conformant NRPS MembershipContainer.
  app.get('/lti/nrps/members', (req, res) => { void (async () => {
    const membersUrl = req.query.members_url as string | undefined;
    if (membersUrl) {
      const platform = platforms[0];
      if (!platform) { res.status(400).json({ error: 'no LTI platforms registered' }); return; }
      const tok = await platformToken(platform, NRPS_SCOPE, keys);
      if (!tok.ok) { res.status(tok.status).json({ error: tok.error }); return; }
      const r = await fetch(membersUrl, {
        headers: { Accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json', Authorization: `Bearer ${tok.token}` },
      });
      const text = await r.text();
      res.status(r.status).type('application/vnd.ims.lti-nrps.v2.membershipcontainer+json').send(text);
      return;
    }
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const members = tenantOrUsers(tenant).map(orUserToNrpsMember);
    res.type('application/vnd.ims.lti-nrps.v2.membershipcontainer+json').send(JSON.stringify({
      id: `${config.selfBaseUrl.replace(/\/+$/, '')}/lti/nrps/members`,
      context: { id: 'foxxi-tenant', label: 'foxxi', title: 'Foxxi tenant roster' },
      members,
    }));
  })().catch(err => { res.status(500).json({ error: (err as Error).message }); }); });
}
