/**
 * OAuth 2.0 token endpoint for Foxxi-as-LRS.
 *
 * xAPI 2.0 §6.4 lists OAuth 2.0 as a recommended auth mechanism alongside
 * Basic. For non-MCP clients (a CI script forwarding statements, a
 * partner-eng SDK, a SCORM Cloud connector) Basic Auth is awkward —
 * OAuth client_credentials with a short-lived bearer token is the
 * canonical fit.
 *
 *   POST /xapi/oauth/token
 *     grant_type=client_credentials
 *     client_id=<key>&client_secret=<secret>
 *     scope=xapi.read xapi.write
 *   →
 *     { access_token: <jwt>, token_type: "Bearer", expires_in: 3600, scope: "..." }
 *
 * Tokens are signed with the same ES256 keypair used for LTI 1.3, so
 * verifying them is mechanical: hit `/lti/.well-known/jwks.json`,
 * verify against the published key, accept if exp > now and scope
 * includes the operation.
 *
 * Registered clients live in FOXXI_LRS_OAUTH_CLIENTS env (comma-sep
 * `client_id:client_secret:scope` triples). For multi-tenant deploys
 * this would move to a real client registry.
 */

import type { Express, Request, Response } from 'express';
import { createHash, sign as cryptoSign, verify as cryptoVerify, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';

interface OauthConfig {
  selfBaseUrl: string;
  /** ES256 PEM (FOXXI_LTI_PRIVATE_KEY_PEM) — reused so the JWKS publishes one key. */
  privateKeyPem?: string;
  /** Token TTL in seconds. Default 3600. */
  tokenTtlSec?: number;
  /** Registered clients: comma-separated `client_id:client_secret:scope` */
  clientsConfig: string;
}

interface Client {
  client_id: string;
  client_secret: string;
  scope: string;
}

function parseClients(s: string): Client[] {
  return s.split(',').map(c => c.trim()).filter(Boolean).map(c => {
    const [client_id, client_secret, scope] = c.split(':');
    return { client_id: client_id ?? '', client_secret: client_secret ?? '', scope: scope ?? 'xapi.read xapi.write' };
  });
}

function base64url(b: Buffer | string): string {
  const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function derToJose(der: Buffer): Buffer {
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

/**
 * Verify an OAuth-issued bearer (separate from the wallet-signed session
 * tokens the dashboard mints). The xapi-lrs auth gate calls this if a
 * Bearer header is present but doesn't decode as a session token.
 *
 * Returns the decoded claims on success, null on failure.
 */
/** Derive the ES256 public key used to verify our OAuth bearers from the signing
 *  private-key PEM (FOXXI_LTI_PRIVATE_KEY_PEM). Returns null when no key is configured
 *  — the LRS then rejects all OAuth bearers (fail-closed; none can have been minted). */
export function oauthPublicKeyFrom(privateKeyPem: string | undefined): KeyObject | null {
  if (!privateKeyPem) return null;
  try { return createPublicKey(createPrivateKey({ key: privateKeyPem.replace(/\\n/g, '\n'), format: 'pem' })); }
  catch { return null; }
}

export function verifyOauthBearer(jwt: string, publicKey: KeyObject | null | undefined): Record<string, unknown> | null {
  // Real ES256 verification (round-47). A prior version checked ONLY exp, so any
  // well-formed JWT with a future exp authenticated — a forgeable bearer the LRS auth
  // gate then trusted. Now: reject alg=none / anything unsigned, verify the signature
  // against the LTI keypair's public key (ieee-p1363 = the raw r||s JOSE format our
  // minter emits), then check expiry. No key configured → reject (fail-closed).
  try {
    if (!publicKey) return null;
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { alg?: string };
    if (header.alg !== 'ES256') return null;
    const joseSig = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (joseSig.length !== 64) return null;
    const ok = cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, joseSig);
    if (!ok) return null;
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
    const exp = Number(payload.exp);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}

export function attachOauthTokenRoute(app: Express, config: OauthConfig): void {
  const clients = parseClients(config.clientsConfig);
  const ttl = config.tokenTtlSec ?? 3600;
  let privateKey: ReturnType<typeof createPrivateKey> | null = null;
  if (config.privateKeyPem) {
    try { privateKey = createPrivateKey({ key: config.privateKeyPem.replace(/\\n/g, '\n'), format: 'pem' }); }
    catch { privateKey = null; }
  }

  app.post('/xapi/oauth/token', (req, res) => {
    // Per OAuth 2.0 §3.2 + RFC 6749 client_credentials grant. Accept
    // form-encoded body (the canonical OAuth wire format).
    const body = (req.body || {}) as Record<string, string>;
    const grant_type = body.grant_type ?? (req.query.grant_type as string | undefined);
    const client_id  = body.client_id  ?? (req.query.client_id  as string | undefined);
    const client_secret = body.client_secret ?? (req.query.client_secret as string | undefined);
    const scope = body.scope ?? (req.query.scope as string | undefined) ?? 'xapi.read xapi.write';

    if (grant_type !== 'client_credentials') {
      res.status(400).json({ error: 'unsupported_grant_type', error_description: 'only client_credentials supported (OAuth 2.0 §4.4)' });
      return;
    }
    const client = clients.find(c => c.client_id === client_id && c.client_secret === client_secret);
    if (!client) {
      res.status(401).json({ error: 'invalid_client', error_description: 'unknown client_id / client_secret pair — register via FOXXI_LRS_OAUTH_CLIENTS' });
      return;
    }
    // Scope: must be subset of registered scope
    const requested = new Set(scope.split(/\s+/).filter(Boolean));
    const allowed = new Set(client.scope.split(/\s+/).filter(Boolean));
    for (const s of requested) {
      if (!allowed.has(s)) {
        res.status(400).json({ error: 'invalid_scope', error_description: `scope ${s} not registered for client` });
        return;
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: config.selfBaseUrl,
      sub: client.client_id,
      aud: config.selfBaseUrl,
      iat: now,
      exp: now + ttl,
      scope: [...requested].join(' '),
      jti: createHash('sha256').update(`${client.client_id}:${now}:${Math.random()}`).digest('hex').slice(0, 16),
    };

    let access_token: string;
    if (privateKey) {
      const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
      const payload = base64url(JSON.stringify(claims));
      const sig = derToJose(cryptoSign(null, Buffer.from(`${header}.${payload}`), privateKey));
      access_token = `${header}.${payload}.${base64url(sig)}`;
    } else {
      // Fallback: unsigned JWT (alg=none). Suitable for dev only; switch on
      // FOXXI_LTI_PRIVATE_KEY_PEM in production so partners can verify.
      const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const payload = base64url(JSON.stringify(claims));
      access_token = `${header}.${payload}.`;
    }

    res.json({
      access_token,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: claims.scope,
    });
  });
}
