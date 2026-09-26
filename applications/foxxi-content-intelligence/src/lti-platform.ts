/**
 * Foxxi as its own LMS: the LTI 1.3 Platform role.
 *
 * lti13.ts is the Tool: an LMS launches Foxxi, and Foxxi posts grades back. This is the other
 * side, so one bridge can be both and a launch runs end to end without anyone else's LMS. The
 * Platform launches its Tool with the OIDC third-party-initiated login and a signed id_token,
 * issues the Tool an access token for a client assertion signed with the Tool's own key, and
 * keeps the gradebook the Tool posts scores to over Assignment and Grade Services. Every hop is
 * the standard one over HTTP, so the Tool code that serves this Platform serves any other.
 *
 *   GET      /lti/platform/.well-known/openid-configuration     issuer, endpoints, keys
 *   GET      /lti/platform/jwks.json                            the keys id_tokens are signed with
 *   GET|POST /lti/platform/auth                                 OIDC authorization: the id_token, form-posted to the Tool
 *   POST     /lti/platform/token                                client_credentials with a JWT client assertion
 *   GET      /lti/platform/contexts/:context                    the course context
 *   GET      /lti/platform/contexts/:context/lineitems          AGS line items
 *   GET      /lti/platform/contexts/:context/lineitems/:id      AGS line item
 *   GET      /lti/platform/contexts/:context/lineitems/:id/results   AGS results
 *   POST     /lti/platform/contexts/:context/lineitems/:id/scores    AGS score publish
 *
 * Who a launch is for is settled before any of this. There are no passwords: the bridge verifies
 * a learner's signed request and calls beginLaunch, which returns the initiation URL for that
 * learner and course. The grant it mints is the learner's session here: single use, bound to the
 * learner and the course, and gone in five minutes.
 *
 * Standards: 1EdTech LTI 1.3 Core; LTI Advantage Assignment and Grade Services 2.0; the 1EdTech
 * Security Framework (OIDC third-party-initiated login, client_credentials with a JWT assertion,
 * RFC 7523); OpenID Connect Core 1.0 (form_post response mode); JOSE (RFC 7515/7517/7519).
 */

import express, { type Express, type Request, type Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { AGS_SCOPE, LTI_CLAIMS, es256Keys, jwsSignEs256, jwsVerifyRs256OrEs256, type Es256Keys, type PlatformRegistration } from './lti13.js';
import { sendServerError } from './http-errors.js';

const LEARNER_ROLE = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
const COURSE_OFFERING = 'http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering';
const LAUNCH_PRESENTATION = 'https://purl.imsglobal.org/spec/lti/claim/launch_presentation';
const LINEITEM_READONLY = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** What a token from this Platform can be for. Line items are read here, never written by a Tool. */
const GRANTABLE_SCOPES = new Set<string>([AGS_SCOPE.lineItem, LINEITEM_READONLY, AGS_SCOPE.result, AGS_SCOPE.score]);
/** The services a launch offers its Tool. */
const LAUNCH_SCOPES = [LINEITEM_READONLY, AGS_SCOPE.result, AGS_SCOPE.score];
const ACTIVITY_PROGRESS = new Set(['Initialized', 'Started', 'InProgress', 'Submitted', 'Completed']);
const GRADING_PROGRESS = new Set(['FullyGraded', 'Pending', 'PendingManual', 'Failed', 'NotReady']);

const MEDIA = {
  lineItem: 'application/vnd.ims.lis.v2.lineitem+json',
  lineItems: 'application/vnd.ims.lis.v2.lineitemcontainer+json',
  results: 'application/vnd.ims.lis.v2.resultcontainer+json',
  score: 'application/vnd.ims.lis.v1.score+json',
} as const;

const GRANT_TTL_MS = 5 * 60_000;
const ID_TOKEN_TTL_S = 300;
const TOKEN_TTL_S = 3600;
/** Caps on what a caller can grow: every map here is in memory, and the gradebook is persisted whole. */
const MAX_GRANTS = 5000;
const MAX_TOKENS = 5000;
const MAX_SEEN_JTI = 10_000;
/** How far out a client assertion may expire. Its jti is kept until then, so the bound keeps the replay cache sweepable. */
const MAX_ASSERTION_LIFETIME_MS = 10 * 60_000;
const MAX_LINE_ITEMS = 5000;
const MAX_MEMBERS = 50_000;
const MAX_RESULTS_PER_ITEM = 10_000;

/** The Tool this Platform launches, as a Platform registers one. */
export interface ToolRegistration {
  readonly clientId: string;
  readonly deploymentId: string;
  /** The Tool's OIDC login initiation endpoint. */
  readonly loginUrl: string;
  /** Where an id_token may be posted, and nowhere else. */
  readonly redirectUris: readonly string[];
  readonly targetLinkUri: string;
  /** The Tool's public keys, which its client assertions must verify against. */
  readonly jwksUrl: string;
}

export interface LtiPlatformConfig {
  /** The bridge as reached from outside. The issuer and every endpoint hang off it. */
  readonly selfBaseUrl: string;
  /** The Tool this Platform launches: the bridge's own when absent. */
  readonly tool?: ToolRegistration;
  /** The Platform's signing key as PEM. A fresh key per process when absent; the JWKS names it. */
  readonly privateKeyPem?: string;
  /** Called after the gradebook changes, so the bridge can keep it. */
  readonly onChange?: () => void;
  /** Verify a JWT against a JWKS URL. lti13's verifier when absent. */
  readonly verifyJwt?: (jwt: string, jwksUrl: string) => Promise<{ ok: boolean; payload?: Record<string, unknown>; error?: string }>;
  /** How many unexpired client assertions are remembered for replay protection (10,000 by default). */
  readonly maxLiveAssertions?: number;
}

/** The learner a launch is for: who the Platform says they are, and the pod their record is on. */
export interface LaunchLearner { readonly sub: string; readonly podUrl: string }
export interface LaunchCourse { readonly id: string; readonly title: string }

export interface PlatformContext {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly type: readonly string[];
}

interface Grant {
  readonly loginHint: string;
  readonly sub: string;
  readonly podUrl: string;
  readonly courseId: string;
  readonly lineItemId: string;
  readonly expiresAt: number;
}

interface LineItem {
  readonly id: string;
  label: string;
  readonly scoreMaximum: number;
  readonly resourceLinkId: string;
  /** The course, as the Tool knows it. */
  readonly resourceId: string;
  readonly tag: string;
}

interface ResultRow {
  readonly userId: string;
  readonly scoreGiven?: number;
  readonly scoreMaximum?: number;
  readonly activityProgress: string;
  readonly gradingProgress: string;
  readonly timestamp: string;
  readonly comment?: string;
}

interface AccessToken { readonly clientId: string; readonly scopes: ReadonlySet<string>; readonly expiresAt: number }

export type Refused = { readonly ok: false; readonly status: number; readonly error: string; readonly description?: string };

export interface LaunchStart {
  readonly ok: true;
  readonly initiationUrl: string;
  readonly context: PlatformContext;
  readonly resourceLink: { readonly id: string; readonly title: string };
  readonly lineItem: Record<string, unknown>;
  readonly expiresAt: string;
}

export interface PlatformSnapshot {
  readonly lineItems: readonly LineItem[];
  readonly results: ReadonlyArray<readonly [string, readonly ResultRow[]]>;
  readonly members: readonly string[];
}

/** One row of a learner's gradebook: a course's line item and where they stand in it. */
export interface GradebookRow {
  readonly lineItem: Record<string, unknown>;
  readonly courseId: string;
  readonly result: { readonly resultScore?: number; readonly resultMaximum: number; readonly activityProgress: string; readonly gradingProgress: string; readonly timestamp: string; readonly comment?: string } | null;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, '');
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const digest = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The bridge's own Tool, as its own Platform registers it. */
export function selfTool(selfBaseUrl: string): ToolRegistration {
  const base = trimSlash(selfBaseUrl);
  return {
    clientId: 'foxxi-tool',
    deploymentId: 'foxxi-lms-1',
    loginUrl: `${base}/lti/login`,
    redirectUris: [`${base}/lti/launch`],
    targetLinkUri: `${base}/lti/launch`,
    jwksUrl: `${base}/lti/.well-known/jwks.json`,
  };
}

export class LtiPlatform {
  /** The issuer, and the root every Platform endpoint hangs off. */
  readonly issuer: string;
  readonly tool: ToolRegistration;
  readonly context: PlatformContext = {
    id: 'foxxi-open',
    label: 'Foxxi',
    title: 'Foxxi open courses',
    type: [COURSE_OFFERING],
  };
  private readonly keys: Es256Keys;
  private readonly onChange: () => void;
  private readonly verifyJwt: NonNullable<LtiPlatformConfig['verifyJwt']>;
  private readonly maxLiveAssertions: number;
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, AccessToken>();
  private readonly seenJti = new Map<string, number>();
  private readonly lineItems = new Map<string, LineItem>();
  private readonly results = new Map<string, Map<string, ResultRow>>();
  private readonly members = new Set<string>();

  constructor(config: LtiPlatformConfig) {
    this.issuer = `${trimSlash(config.selfBaseUrl)}/lti/platform`;
    this.tool = config.tool ?? selfTool(config.selfBaseUrl);
    this.keys = es256Keys('foxxi-lms', this.issuer, config.privateKeyPem);
    this.onChange = config.onChange ?? (() => undefined);
    this.verifyJwt = config.verifyJwt ?? jwsVerifyRs256OrEs256;
    this.maxLiveAssertions = config.maxLiveAssertions ?? MAX_SEEN_JTI;
  }

  get authorizationUrl(): string { return `${this.issuer}/auth`; }
  get tokenUrl(): string { return `${this.issuer}/token`; }
  get jwksUrl(): string { return `${this.issuer}/jwks.json`; }
  get contextUrl(): string { return `${this.issuer}/contexts/${this.context.id}`; }
  get lineItemsUrl(): string { return `${this.contextUrl}/lineitems`; }
  lineItemUrl(id: string): string { return `${this.lineItemsUrl}/${id}`; }

  /** This Platform as its Tool registers it: the row lti13 reads from FOXXI_LTI_PLATFORMS. */
  registration(): PlatformRegistration {
    return {
      issuer: this.issuer,
      client_id: this.tool.clientId,
      deployment_id: this.tool.deploymentId,
      jwks_url: this.jwksUrl,
      auth_login_url: this.authorizationUrl,
      auth_token_url: this.tokenUrl,
    };
  }

  jwks(): { keys: Array<Record<string, unknown>> } { return { keys: [{ ...this.keys.jwk }] }; }

  /** OpenID Provider metadata with the LTI platform configuration, as LTI Dynamic Registration reads it. */
  configuration(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: this.authorizationUrl,
      token_endpoint: this.tokenUrl,
      jwks_uri: this.jwksUrl,
      token_endpoint_auth_methods_supported: ['private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['RS256', 'ES256'],
      id_token_signing_alg_values_supported: ['ES256'],
      response_types_supported: ['id_token'],
      response_modes_supported: ['form_post'],
      subject_types_supported: ['public'],
      scopes_supported: ['openid', ...GRANTABLE_SCOPES],
      claims_supported: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'azp'],
      'https://purl.imsglobal.org/spec/lti-platform-configuration': {
        product_family_code: 'foxxi',
        version: '1',
        messages_supported: [{ type: 'LtiResourceLinkRequest' }],
      },
    };
  }

  /**
   * Start a launch for a learner the bridge has already identified: the resource link and line
   * item for the course, the learner's membership, and the one grant that lets the authorization
   * step issue their id_token.
   */
  beginLaunch(learner: LaunchLearner, course: LaunchCourse, now = Date.now()): LaunchStart | Refused {
    // LTI 1.3 Core §5.3.6: sub is at most 255 ASCII characters.
    if (!/^[\x21-\x7e]{1,255}$/.test(learner.sub)) return { ok: false, status: 400, error: 'the learner identifier is not a valid LTI sub (1 to 255 printable ASCII characters)' };
    if (!course.id) return { ok: false, status: 400, error: 'a launch names a course' };
    const item = this.lineItemFor(course);
    if (!item) return { ok: false, status: 507, error: `this LMS holds ${MAX_LINE_ITEMS} courses and no more` };
    if (!this.members.has(learner.sub)) {
      if (this.members.size >= MAX_MEMBERS) return { ok: false, status: 507, error: `this LMS holds ${MAX_MEMBERS} members and no more` };
      this.members.add(learner.sub);
      this.onChange();
    }
    this.sweep(now);
    if (this.grants.size >= MAX_GRANTS) { const oldest = this.grants.keys().next().value; if (oldest !== undefined) this.grants.delete(oldest); }
    const messageHint = randomBytes(32).toString('base64url');
    // Opaque to the Tool, and the same for every launch of this learner (LTI 1.3 Core §4.1).
    const loginHint = createHash('sha256').update(`login_hint:${learner.sub}`).digest('base64url');
    const expiresAt = now + GRANT_TTL_MS;
    this.grants.set(messageHint, { loginHint, sub: learner.sub, podUrl: learner.podUrl, courseId: course.id, lineItemId: item.id, expiresAt });
    const u = new URL(this.tool.loginUrl);
    u.searchParams.set('iss', this.issuer);
    u.searchParams.set('login_hint', loginHint);
    u.searchParams.set('lti_message_hint', messageHint);
    u.searchParams.set('target_link_uri', this.tool.targetLinkUri);
    u.searchParams.set('client_id', this.tool.clientId);
    u.searchParams.set('lti_deployment_id', this.tool.deploymentId);
    return {
      ok: true,
      initiationUrl: u.toString(),
      context: this.context,
      resourceLink: { id: item.resourceLinkId, title: item.label },
      lineItem: this.publicLineItem(item),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * The OIDC authorization step (LTI 1.3 Core §5.1.1.3): check the request the Tool redirected
   * here, consume the grant it names, and sign the id_token. The answer is where to post it, never
   * a redirect: a request that fails is refused here, so an unregistered redirect_uri never
   * receives anything.
   */
  authorize(params: Record<string, unknown>, now = Date.now()): { ok: true; action: string; fields: Record<string, string> } | Refused {
    const scope = str(params.scope).split(/\s+/);
    if (!scope.includes('openid')) return { ok: false, status: 400, error: 'invalid_scope', description: 'scope must include openid' };
    if (str(params.response_type) !== 'id_token') return { ok: false, status: 400, error: 'unsupported_response_type', description: 'response_type must be id_token' };
    if (params.response_mode !== undefined && str(params.response_mode) !== 'form_post') return { ok: false, status: 400, error: 'invalid_request', description: 'response_mode must be form_post' };
    if (str(params.client_id) !== this.tool.clientId) return { ok: false, status: 401, error: 'unauthorized_client', description: 'client_id is not a Tool registered with this Platform' };
    const redirectUri = str(params.redirect_uri);
    if (!this.tool.redirectUris.includes(redirectUri)) return { ok: false, status: 400, error: 'invalid_request', description: 'redirect_uri is not registered for this Tool' };
    const nonce = str(params.nonce);
    if (!nonce) return { ok: false, status: 400, error: 'invalid_request', description: 'nonce is required' };
    // Consumed before it is checked, so a hint is spent by the first attempt whatever it carried.
    const hint = str(params.lti_message_hint);
    const grant = hint ? this.grants.get(hint) : undefined;
    if (grant) this.grants.delete(hint);
    if (!grant || grant.expiresAt < now) return { ok: false, status: 401, error: 'login_required', description: 'no launch is pending for this lti_message_hint; a launch starts from a signed request and is used once within five minutes' };
    if (str(params.login_hint) !== grant.loginHint) return { ok: false, status: 401, error: 'login_required', description: 'login_hint is not the learner this launch was started for' };
    const item = this.lineItems.get(grant.lineItemId);
    if (!item) return { ok: false, status: 410, error: 'invalid_request', description: 'the course this launch was for is no longer in this LMS' };
    const iat = Math.floor(now / 1000);
    const claims: Record<string, unknown> = {
      iss: this.issuer,
      aud: this.tool.clientId,
      azp: this.tool.clientId,
      sub: grant.sub,
      iat,
      exp: iat + ID_TOKEN_TTL_S,
      nonce,
      [LTI_CLAIMS.messageType]: 'LtiResourceLinkRequest',
      [LTI_CLAIMS.version]: '1.3.0',
      [LTI_CLAIMS.deploymentId]: this.tool.deploymentId,
      [LTI_CLAIMS.targetLinkUri]: this.tool.targetLinkUri,
      [LTI_CLAIMS.resourceLink]: { id: item.resourceLinkId, title: item.label },
      [LTI_CLAIMS.roles]: [LEARNER_ROLE],
      [LTI_CLAIMS.context]: this.context,
      [LTI_CLAIMS.toolPlatform]: { guid: digest(this.issuer).slice(0, 32), name: 'Foxxi LMS', product_family_code: 'foxxi', version: '1' },
      // Platform-substituted custom parameters: the course, and the pod the learner's record is on.
      [LTI_CLAIMS.custom]: { foxxi_course_id: grant.courseId, foxxi_learner_pod: grant.podUrl },
      [LTI_CLAIMS.ags]: { scope: LAUNCH_SCOPES, lineitems: this.lineItemsUrl, lineitem: this.lineItemUrl(item.id) },
      [LAUNCH_PRESENTATION]: { document_target: 'window' },
    };
    const fields: Record<string, string> = { id_token: jwsSignEs256({}, claims, this.keys) };
    if (typeof params.state === 'string' && params.state) fields.state = params.state;
    return { ok: true, action: redirectUri, fields };
  }

  /** client_credentials with a JWT client assertion signed by the Tool's key (1EdTech Security Framework §4.1; RFC 7523). */
  async token(form: Record<string, unknown>, now = Date.now()): Promise<{ ok: true; body: Record<string, unknown> } | Refused> {
    if (str(form.grant_type) !== 'client_credentials') return { ok: false, status: 400, error: 'unsupported_grant_type', description: 'grant_type must be client_credentials' };
    if (str(form.client_assertion_type) !== ASSERTION_TYPE) return { ok: false, status: 400, error: 'invalid_request', description: `client_assertion_type must be ${ASSERTION_TYPE}` };
    const assertion = str(form.client_assertion);
    if (!assertion) return { ok: false, status: 400, error: 'invalid_request', description: 'client_assertion is required' };
    const verified = await this.verifyJwt(assertion, this.tool.jwksUrl);
    if (!verified.ok || !verified.payload) return { ok: false, status: 401, error: 'invalid_client', description: `the client assertion does not verify against the Tool's keys: ${verified.error ?? 'no payload'}` };
    const a = verified.payload;
    if (a.iss !== this.tool.clientId || a.sub !== this.tool.clientId) return { ok: false, status: 401, error: 'invalid_client', description: 'the assertion\'s iss and sub must both be the Tool\'s client_id' };
    const aud = Array.isArray(a.aud) ? a.aud : [a.aud];
    if (!aud.includes(this.tokenUrl)) return { ok: false, status: 401, error: 'invalid_client', description: 'the assertion\'s aud must be this token endpoint' };
    const exp = Number(a.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= now) return { ok: false, status: 401, error: 'invalid_client', description: 'the assertion has expired' };
    if (exp * 1000 - now > MAX_ASSERTION_LIFETIME_MS) return { ok: false, status: 401, error: 'invalid_client', description: 'the assertion must expire within ten minutes' };
    const iat = Number(a.iat);
    if (Number.isFinite(iat) && iat * 1000 > now + 60_000) return { ok: false, status: 401, error: 'invalid_client', description: 'the assertion is issued in the future' };
    const jti = str(a.jti);
    if (!jti) return { ok: false, status: 401, error: 'invalid_client', description: 'the assertion needs a jti' };
    this.sweep(now);
    if (this.seenJti.has(jti)) return { ok: false, status: 401, error: 'invalid_client', description: 'this assertion was already used' };
    // ★ A live jti is never evicted to make room: that would let its still-valid assertion buy a
    // second token. Every entry expires within ten minutes, so a full cache refuses until it drains.
    if (this.seenJti.size >= this.maxLiveAssertions) return { ok: false, status: 503, error: 'temporarily_unavailable', description: 'too many client assertions are still live; try again in a few minutes' };
    this.seenJti.set(jti, exp * 1000);
    const asked = str(form.scope).split(/\s+/).filter(Boolean);
    const granted = asked.filter((s) => GRANTABLE_SCOPES.has(s));
    if (granted.length === 0) return { ok: false, status: 400, error: 'invalid_scope', description: `none of the requested scopes is one this Platform grants: ${[...GRANTABLE_SCOPES].join(' ')}` };
    if (this.tokens.size >= MAX_TOKENS) { const oldest = this.tokens.keys().next().value; if (oldest !== undefined) this.tokens.delete(oldest); }
    const accessToken = randomBytes(32).toString('base64url');
    this.tokens.set(accessToken, { clientId: this.tool.clientId, scopes: new Set(granted), expiresAt: now + TOKEN_TTL_S * 1000 });
    return { ok: true, body: { access_token: accessToken, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: granted.join(' ') } };
  }

  /** A service call's bearer, held to one of the scopes that allow it. */
  bearer(authorization: string | undefined, anyOf: readonly string[], now = Date.now()): { ok: true; clientId: string } | Refused {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    const held = token ? this.tokens.get(token) : undefined;
    if (!held || held.expiresAt <= now) return { ok: false, status: 401, error: 'invalid_token', description: 'a bearer token from this Platform\'s token endpoint is required' };
    if (!anyOf.some((s) => held.scopes.has(s))) return { ok: false, status: 403, error: 'insufficient_scope', description: `this needs one of: ${anyOf.join(' ')}` };
    return { ok: true, clientId: held.clientId };
  }

  listLineItems(contextId: string, filter: { resourceLinkId?: string; resourceId?: string; tag?: string } = {}): Array<Record<string, unknown>> | null {
    if (contextId !== this.context.id) return null;
    return [...this.lineItems.values()]
      .filter((li) => (!filter.resourceLinkId || li.resourceLinkId === filter.resourceLinkId)
        && (!filter.resourceId || li.resourceId === filter.resourceId)
        && (!filter.tag || li.tag === filter.tag))
      .map((li) => this.publicLineItem(li));
  }

  getLineItem(contextId: string, id: string): Record<string, unknown> | null {
    const li = contextId === this.context.id ? this.lineItems.get(id) : undefined;
    return li ? this.publicLineItem(li) : null;
  }

  /** AGS results, each rescaled to the line item's maximum (AGS 2.0 §3.3). */
  listResults(contextId: string, id: string, userId?: string): Array<Record<string, unknown>> | null {
    const li = contextId === this.context.id ? this.lineItems.get(id) : undefined;
    if (!li) return null;
    const rows = [...(this.results.get(id)?.values() ?? [])].filter((r) => !userId || r.userId === userId);
    return rows.map((r) => {
      const scored = this.rescaled(r, li);
      return {
        id: `${this.lineItemUrl(id)}/results/${digest(r.userId).slice(0, 24)}`,
        scoreOf: this.lineItemUrl(id),
        userId: r.userId,
        ...(scored !== undefined ? { resultScore: scored } : {}),
        resultMaximum: li.scoreMaximum,
        ...(r.comment ? { comment: r.comment } : {}),
      };
    });
  }

  /**
   * An AGS Score (AGS 2.0 §3.4). Only for a learner this LMS launched, and never older than the
   * score already on record: a Platform keeps the latest by timestamp, whatever order they arrive in.
   */
  acceptScore(contextId: string, id: string, body: unknown, now = Date.now()): { ok: true } | Refused {
    const li = contextId === this.context.id ? this.lineItems.get(id) : undefined;
    if (!li) return { ok: false, status: 404, error: 'not_found', description: 'no such line item' };
    const s = (body && typeof body === 'object') ? body as Record<string, unknown> : {};
    const userId = str(s.userId);
    if (!userId) return { ok: false, status: 400, error: 'invalid_request', description: 'userId is required' };
    if (!this.members.has(userId)) return { ok: false, status: 400, error: 'invalid_request', description: 'userId is not a learner this LMS launched' };
    const activityProgress = str(s.activityProgress);
    const gradingProgress = str(s.gradingProgress);
    if (!ACTIVITY_PROGRESS.has(activityProgress)) return { ok: false, status: 400, error: 'invalid_request', description: `activityProgress must be one of ${[...ACTIVITY_PROGRESS].join(', ')}` };
    if (!GRADING_PROGRESS.has(gradingProgress)) return { ok: false, status: 400, error: 'invalid_request', description: `gradingProgress must be one of ${[...GRADING_PROGRESS].join(', ')}` };
    const timestamp = str(s.timestamp);
    const at = Date.parse(timestamp);
    if (!timestamp || !Number.isFinite(at)) return { ok: false, status: 400, error: 'invalid_request', description: 'timestamp must be an ISO 8601 date-time' };
    if (at > now + 5 * 60_000) return { ok: false, status: 400, error: 'invalid_request', description: 'timestamp is in the future' };
    let scoreGiven: number | undefined;
    let scoreMaximum: number | undefined;
    if (s.scoreGiven !== undefined) {
      scoreGiven = Number(s.scoreGiven);
      scoreMaximum = Number(s.scoreMaximum);
      if (!Number.isFinite(scoreGiven) || scoreGiven < 0) return { ok: false, status: 400, error: 'invalid_request', description: 'scoreGiven must be a number of at least 0' };
      if (!Number.isFinite(scoreMaximum) || scoreMaximum <= 0) return { ok: false, status: 400, error: 'invalid_request', description: 'scoreMaximum is required with scoreGiven, and must be above 0' };
    }
    let byUser = this.results.get(id);
    const prior = byUser?.get(userId);
    if (prior && Date.parse(prior.timestamp) >= at) return { ok: false, status: 409, error: 'conflict', description: 'a score with a later timestamp is already on record' };
    if (!byUser) { byUser = new Map(); this.results.set(id, byUser); }
    if (!prior && byUser.size >= MAX_RESULTS_PER_ITEM) return { ok: false, status: 507, error: 'insufficient_storage', description: 'this line item holds no more results' };
    const comment = str(s.comment).slice(0, 1000);
    byUser.set(userId, {
      userId, activityProgress, gradingProgress, timestamp,
      ...(scoreGiven !== undefined && scoreMaximum !== undefined ? { scoreGiven, scoreMaximum } : {}),
      ...(comment ? { comment } : {}),
    });
    this.onChange();
    return { ok: true };
  }

  /** A learner's own gradebook: every course in the context, and where they stand in each. */
  gradebookFor(sub: string): GradebookRow[] {
    return [...this.lineItems.values()].map((li) => {
      const r = this.results.get(li.id)?.get(sub);
      const scored = r ? this.rescaled(r, li) : undefined;
      return {
        lineItem: this.publicLineItem(li),
        courseId: li.resourceId,
        result: r ? {
          ...(scored !== undefined ? { resultScore: scored } : {}),
          resultMaximum: li.scoreMaximum,
          activityProgress: r.activityProgress,
          gradingProgress: r.gradingProgress,
          timestamp: r.timestamp,
          ...(r.comment ? { comment: r.comment } : {}),
        } : null,
      };
    });
  }

  snapshot(): PlatformSnapshot {
    return {
      lineItems: [...this.lineItems.values()],
      results: [...this.results.entries()].map(([id, m]) => [id, [...m.values()]] as const),
      members: [...this.members],
    };
  }

  /** Take back a kept gradebook. What this process already holds wins: it is newer. */
  restore(snap: Partial<PlatformSnapshot> | null | undefined): void {
    if (!snap) return;
    for (const li of Array.isArray(snap.lineItems) ? snap.lineItems : []) {
      if (li && typeof li.id === 'string' && typeof li.resourceId === 'string' && !this.lineItems.has(li.id) && this.lineItems.size < MAX_LINE_ITEMS) this.lineItems.set(li.id, li);
    }
    for (const m of Array.isArray(snap.members) ? snap.members : []) {
      if (typeof m === 'string' && this.members.size < MAX_MEMBERS) this.members.add(m);
    }
    for (const entry of Array.isArray(snap.results) ? snap.results : []) {
      const [id, rows] = Array.isArray(entry) ? entry : [];
      if (typeof id !== 'string' || !Array.isArray(rows) || !this.lineItems.has(id)) continue;
      let byUser = this.results.get(id);
      if (!byUser) { byUser = new Map(); this.results.set(id, byUser); }
      for (const r of rows) {
        if (r && typeof r.userId === 'string' && !byUser.has(r.userId) && byUser.size < MAX_RESULTS_PER_ITEM) byUser.set(r.userId, r);
      }
    }
  }

  private lineItemFor(course: LaunchCourse): LineItem | null {
    const key = digest(course.id).slice(0, 16);
    const id = `li-${key}`;
    const existing = this.lineItems.get(id);
    if (existing) {
      if (course.title && existing.label !== course.title) { existing.label = course.title; this.onChange(); }
      return existing;
    }
    if (this.lineItems.size >= MAX_LINE_ITEMS) return null;
    const li: LineItem = { id, label: course.title || course.id, scoreMaximum: 100, resourceLinkId: `rl-${key}`, resourceId: course.id, tag: 'grade' };
    this.lineItems.set(id, li);
    this.onChange();
    return li;
  }

  private publicLineItem(li: LineItem): Record<string, unknown> {
    return { id: this.lineItemUrl(li.id), label: li.label, scoreMaximum: li.scoreMaximum, resourceLinkId: li.resourceLinkId, resourceId: li.resourceId, tag: li.tag };
  }

  private rescaled(r: ResultRow, li: LineItem): number | undefined {
    if (r.scoreGiven === undefined || r.scoreMaximum === undefined) return undefined;
    return Math.round((r.scoreGiven / r.scoreMaximum) * li.scoreMaximum * 100) / 100;
  }

  private sweep(now: number): void {
    for (const [k, g] of this.grants) if (g.expiresAt < now) this.grants.delete(k);
    for (const [k, t] of this.tokens) if (t.expiresAt <= now) this.tokens.delete(k);
    for (const [k, exp] of this.seenJti) if (exp <= now) this.seenJti.delete(k);
  }
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The form_post response (OAuth 2.0 Form Post Response Mode): a page that posts itself to the Tool. */
export function autoPostForm(action: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Launching</title></head>
<body onload="document.forms[0].submit()"><p>Launching your course…</p>
<form method="POST" action="${htmlEscape(action)}">
${inputs}
<noscript><button type="submit">Continue</button></noscript>
</form></body></html>`;
}

function refuse(res: Response, r: Refused): void {
  if (r.status === 401 && r.error === 'invalid_token') res.set('WWW-Authenticate', 'Bearer');
  res.status(r.status).json({ error: r.error, ...(r.description ? { error_description: r.description } : {}) });
}

export function attachLtiPlatformRoutes(app: Express, platform: LtiPlatform): void {
  const formBody = express.urlencoded({ extended: false, limit: '64kb' });
  // A Score arrives as application/vnd.ims.lis.v1.score+json, which the bridge's JSON parser skips.
  const scoreBody = express.json({ type: [MEDIA.score, 'application/json'], limit: '64kb' });
  const base = new URL(platform.issuer).pathname;

  app.get(`${base}/.well-known/openid-configuration`, (_req, res) => { res.json(platform.configuration()); });
  app.get(`${base}/jwks.json`, (_req, res) => { res.json(platform.jwks()); });

  const authorize = (req: Request, res: Response): void => {
    const params = (req.method === 'GET' ? req.query : req.body) as Record<string, unknown> | undefined;
    const r = platform.authorize(params ?? {});
    res.set('Cache-Control', 'no-store');
    if (!r.ok) { refuse(res, r); return; }
    // A client without a browser asks for the form as data and posts it itself.
    if (req.accepts(['html', 'json']) === 'json') { res.json({ form_post: { action: r.action, method: 'POST', fields: r.fields } }); return; }
    res.set('Referrer-Policy', 'no-referrer').type('html').send(autoPostForm(r.action, r.fields));
  };
  app.get(`${base}/auth`, authorize);
  app.post(`${base}/auth`, formBody, authorize);

  app.post(`${base}/token`, formBody, (req, res) => { void (async () => {
    const r = await platform.token((req.body ?? {}) as Record<string, unknown>);
    res.set('Cache-Control', 'no-store');
    if (!r.ok) { refuse(res, r); return; }
    res.json(r.body);
  })().catch((err) => { sendServerError(res, err, 'lti-platform-token'); }); });

  app.get(`${base}/contexts/:context`, (req, res) => {
    if (req.params.context !== platform.context.id) { res.status(404).json({ error: 'not_found' }); return; }
    res.json({ ...platform.context, lineitems: platform.lineItemsUrl });
  });

  app.get(`${base}/contexts/:context/lineitems`, (req, res) => {
    const auth = platform.bearer(req.get('authorization'), [LINEITEM_READONLY, AGS_SCOPE.lineItem]);
    if (!auth.ok) { refuse(res, auth); return; }
    const q = req.query as Record<string, unknown>;
    const items = platform.listLineItems(String(req.params.context), { resourceLinkId: str(q.resource_link_id), resourceId: str(q.resource_id), tag: str(q.tag) });
    if (!items) { res.status(404).json({ error: 'not_found' }); return; }
    res.type(MEDIA.lineItems).send(JSON.stringify(items));
  });

  app.get(`${base}/contexts/:context/lineitems/:id`, (req, res) => {
    const auth = platform.bearer(req.get('authorization'), [LINEITEM_READONLY, AGS_SCOPE.lineItem]);
    if (!auth.ok) { refuse(res, auth); return; }
    const item = platform.getLineItem(String(req.params.context), String(req.params.id));
    if (!item) { res.status(404).json({ error: 'not_found' }); return; }
    res.type(MEDIA.lineItem).send(JSON.stringify(item));
  });

  app.get(`${base}/contexts/:context/lineitems/:id/results`, (req, res) => {
    const auth = platform.bearer(req.get('authorization'), [AGS_SCOPE.result]);
    if (!auth.ok) { refuse(res, auth); return; }
    const userId = str((req.query as Record<string, unknown>).user_id);
    const rows = platform.listResults(String(req.params.context), String(req.params.id), userId || undefined);
    if (!rows) { res.status(404).json({ error: 'not_found' }); return; }
    res.type(MEDIA.results).send(JSON.stringify(rows));
  });

  app.post(`${base}/contexts/:context/lineitems/:id/scores`, scoreBody, (req, res) => {
    const auth = platform.bearer(req.get('authorization'), [AGS_SCOPE.score]);
    if (!auth.ok) { refuse(res, auth); return; }
    const r = platform.acceptScore(String(req.params.context), String(req.params.id), req.body);
    if (!r.ok) { refuse(res, r); return; }
    res.status(204).end();
  });
}
