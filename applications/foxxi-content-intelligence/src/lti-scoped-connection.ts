import express, { type Express } from 'express';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { LtiPlatform, attachLtiPlatformRoutes, type LaunchCourse, type ToolRegistration } from './lti-platform.js';
import { jwsVerifyRs256OrEs256 } from './lti13.js';

const MAX_LEASE_MS = 3 * 60 * 60_000;

interface Lease {
  readonly id: string;
  readonly owner: string;
  readonly title: string;
  readonly expiresAt: number;
  readonly tool: ToolRegistration;
  readonly keys: readonly Record<string, unknown>[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
  return value as Record<string, unknown>;
}

function field(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('invalid field');
  return value;
}

function httpsUrl(value: unknown): URL {
  const url = new URL(field(value, /^https:\/\/[^\s]{1,3000}$/));
  if (url.username || url.password || url.hash || url.port) throw new Error('invalid tool URL');
  return url;
}

function publicKey(value: unknown): Record<string, unknown> {
  const input = record(value);
  if (input.kty !== 'RSA' || (input.alg !== undefined && input.alg !== 'RS256')) throw new Error('expected an RSA signing key');
  const key = {
    kty: 'RSA',
    alg: 'RS256',
    n: field(input.n, /^[a-zA-Z0-9_-]{342,1400}$/),
    e: field(input.e, /^[a-zA-Z0-9_-]{1,12}$/),
    ...(input.kid === undefined ? {} : { kid: field(input.kid, /^[\x21-\x7e]{1,160}$/) }),
  };
  if ((createPublicKey({ format: 'jwk', key }).asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error('the tool RSA key must be at least 2048 bits');
  }
  return key;
}

function parseLease(raw: string, now: number): Lease {
  if (Buffer.byteLength(raw) > 20_000) throw new Error('the tool registration is too large');
  const entry = record(JSON.parse(raw));
  const id = field(entry.id, /^[a-f0-9]{32}$/);
  const owner = field(entry.owner, /^did:[a-z0-9]+:[\x21-\x7e]{1,200}$/);
  const title = field(entry.title, /^[^\p{Cc}]{1,120}$/u);
  const expiresAt = Date.parse(field(entry.expiresAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/));
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + MAX_LEASE_MS) throw new Error('invalid lease expiry');
  const tool = record(entry.tool);
  const login = httpsUrl(tool.loginUrl);
  const redirect = httpsUrl(tool.redirectUri);
  const target = httpsUrl(tool.targetLinkUri);
  const jwks = httpsUrl(tool.jwksUrl);
  if ([redirect, target, jwks].some((url) => url.origin !== login.origin)) throw new Error('tool endpoints must share an HTTPS origin');
  if (!Array.isArray(entry.keys) || entry.keys.length < 1 || entry.keys.length > 4) throw new Error('expected one to four tool signing keys');
  return {
    id, owner, title, expiresAt,
    tool: {
      clientId: field(tool.clientId, /^[\x21-\x7e]{1,160}$/),
      deploymentId: field(tool.deploymentId, /^[\x21-\x7e]{1,160}$/),
      loginUrl: login.href, redirectUris: [redirect.href], targetLinkUri: target.href, jwksUrl: jwks.href,
    },
    keys: entry.keys.map(publicKey),
  };
}

/** One operator-provisioned, expiring course for one signed learner. The tool sees a
 * random launch subject. Its tokens, grades and enrollment never enter the open context. */
export class ScopedLtiConnection {
  private readonly subject = randomBytes(24).toString('base64url');
  private readonly expiry: ReturnType<typeof setTimeout>;
  private current?: { platform: LtiPlatform; routes: Express };
  readonly course: LaunchCourse;
  readonly scoreRoutePath: string;
  private readonly issuerPath: string;

  static fromSetting(raw: string | undefined, baseUrl: string): ScopedLtiConnection | undefined {
    if (!raw) return undefined;
    try {
      return new ScopedLtiConnection(parseLease(raw, Date.now()), baseUrl);
    } catch {
      // A stale or malformed lease must never interfere with the open gradebook.
      console.warn('[lti-scoped] ignored an invalid or expired tool lease');
      return undefined;
    }
  }

  private constructor(private readonly lease: Lease, baseUrl: string) {
    this.course = { id: `lti:${lease.id}`, title: lease.title };
    const privateKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const platform = new LtiPlatform({
      selfBaseUrl: `${baseUrl.replace(/\/+$/, '')}/lti/connections/${lease.id}`,
      tool: lease.tool,
      scoreOnly: true,
      privateKeyPem,
      verifyJwt: (jwt) => jwsVerifyRs256OrEs256(jwt, lease.keys),
    });
    const routes = express();
    attachLtiPlatformRoutes(routes, platform);
    this.current = { platform, routes };
    this.scoreRoutePath = platform.scoreRoutePath;
    this.issuerPath = new URL(platform.issuer).pathname;
    this.expiry = setTimeout(() => { this.current = undefined; }, Math.max(0, lease.expiresAt - Date.now()));
    this.expiry.unref();
  }

  private active() {
    return Date.now() < this.lease.expiresAt ? this.current : undefined;
  }

  attach(app: Express): void {
    app.use((req, res, next) => {
      if (!req.path.startsWith(`${this.issuerPath}/`)) { next(); return; }
      const current = this.active();
      if (!current) { res.sendStatus(404); return; }
      current.routes(req, res, next);
    });
  }

  launch(owner: string, courseId: string) {
    const current = this.active();
    if (!current || owner !== this.lease.owner || courseId !== this.course.id) return undefined;
    return {
      platform: current.platform.issuer,
      start: current.platform.beginLaunch({ sub: this.subject, podUrl: '' }, this.course),
    };
  }

  gradesFor(owner: string) {
    return owner === this.lease.owner ? this.active()?.platform.gradebookFor(this.subject) ?? [] : [];
  }

  revoke(owner: string, courseId: unknown): boolean {
    if (!this.active() || owner !== this.lease.owner || courseId !== this.course.id) return false;
    clearTimeout(this.expiry);
    this.current = undefined;
    return true;
  }
}
