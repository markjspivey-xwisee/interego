/**
 * DPoP (Demonstrating Proof of Possession) — RFC 9449
 *
 * Server-side validation utilities. Clients sign a short-lived JWT with
 * an ephemeral keypair on every request; the server checks the signature,
 * the bound HTTP method + URL, freshness, replay protection, and (for
 * resource calls) the access-token hash. The access token itself carries
 * a `cnf.jkt` claim that pins it to the SAME public key — so an attacker
 * who steals the bearer token can't use it without also stealing the
 * client's ephemeral private key.
 *
 * This module ONLY validates; the server never holds a DPoP key itself.
 *
 * Required by Solid OIDC (https://solid.github.io/solid-oidc/) §4.
 *
 * Supported algorithms:
 *   - ES256 (P-256 ECDSA)
 *   - EdDSA (Ed25519) — requires Node 18.4+ for WebCrypto Ed25519 support;
 *     falls back to node:crypto.verify if subtle.verify rejects.
 *
 * The JTI replay cache is in-memory only. A relay restart wipes it (a
 * 60-second freshness window means an attacker has at most 60s to replay,
 * and only if they happened to capture a recent JWT). For multi-instance
 * deployments behind a load balancer, this is sticky-session-correct;
 * cross-instance replay protection would need a shared cache (Redis,
 * etc.) — out of scope for the personal-deployment shape of this relay.
 */

import { webcrypto, createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────

export interface DpopJwk {
  kty: string;
  // ECDSA P-256
  crv?: string;
  x?: string;
  y?: string;
  // RSA (declared for completeness; RSA DPoP is permitted by RFC 9449 but
  // we don't accept it here — ES256/EdDSA are the Solid OIDC interop set)
  n?: string;
  e?: string;
  // Common
  alg?: string;
  kid?: string;
  use?: string;
}

export interface DpopHeader {
  typ: string;
  alg: string;
  jwk: DpopJwk;
}

export interface DpopPayload {
  jti: string;
  htm: string;
  htu: string;
  iat: number;
  ath?: string;
  nonce?: string;
  // free-form additional claims permitted
  [k: string]: unknown;
}

export interface DpopValidationExpectation {
  htm: string;
  htu: string;
  /** sha256(access_token), base64url-encoded — required for resource requests, omitted at /token. */
  ath?: string;
  /** Allowed clock skew in seconds. Defaults to 60. */
  maxAgeSec?: number;
}

export interface DpopValidationResult {
  jwk: DpopJwk;
  jkt: string;
  payload: DpopPayload;
}

// ── base64url helpers ────────────────────────────────────────────

function b64urlEncode(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function b64urlJsonDecode<T = unknown>(s: string): T {
  return JSON.parse(b64urlDecode(s).toString('utf8')) as T;
}

// ── JWK thumbprint (RFC 7638) ───────────────────────────────────

/**
 * Compute the RFC 7638 JWK thumbprint, base64url-encoded.
 *
 * The thumbprint is sha256 of the canonical JSON serialization of the
 * required JWK members in lexicographic order, with no whitespace.
 *
 * - EC keys (P-256): { crv, kty, x, y }
 * - OKP keys (Ed25519): { crv, kty, x }
 * - RSA keys: { e, kty, n }
 */
export function jktFromJwk(jwk: DpopJwk): string {
  let canonical: Record<string, string>;
  switch (jwk.kty) {
    case 'EC':
      if (!jwk.crv || !jwk.x || !jwk.y) {
        throw new Error('EC JWK missing required members (crv, x, y)');
      }
      canonical = { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y };
      break;
    case 'OKP':
      if (!jwk.crv || !jwk.x) {
        throw new Error('OKP JWK missing required members (crv, x)');
      }
      canonical = { crv: jwk.crv, kty: 'OKP', x: jwk.x };
      break;
    case 'RSA':
      if (!jwk.n || !jwk.e) {
        throw new Error('RSA JWK missing required members (n, e)');
      }
      canonical = { e: jwk.e, kty: 'RSA', n: jwk.n };
      break;
    default:
      throw new Error(`Unsupported JWK kty: ${jwk.kty}`);
  }
  // JSON.stringify with sorted keys produces the canonical form. The
  // switch arms above already construct objects in lexicographic key
  // order, but be defensive — JS Object key iteration order is only
  // guaranteed insertion-order, and we want sort-order regardless.
  const sortedKeys = Object.keys(canonical).sort();
  const json = '{' + sortedKeys.map(k => JSON.stringify(k) + ':' + JSON.stringify(canonical[k])).join(',') + '}';
  const hash = createHash('sha256').update(json, 'utf8').digest();
  return b64urlEncode(hash);
}

// ── access-token hash (`ath`) ────────────────────────────────────

/** Compute the `ath` claim: base64url(sha256(access_token)). */
export function athFromAccessToken(accessToken: string): string {
  return b64urlEncode(createHash('sha256').update(accessToken, 'ascii').digest());
}

// ── JTI replay cache ────────────────────────────────────────────

const JTI_TTL_MS = 5 * 60 * 1000; // 5 minutes
const jtiCache = new Map<string, number>();

function rememberJti(jti: string): void {
  // Sweep expired entries opportunistically. This is O(n) on the cache
  // size; n is bounded by ~ requests-per-5min, so well below problematic
  // even at high traffic.
  const now = Date.now();
  if (jtiCache.size > 1024) {
    for (const [k, exp] of jtiCache) {
      if (exp <= now) jtiCache.delete(k);
    }
  }
  jtiCache.set(jti, now + JTI_TTL_MS);
}

function jtiSeen(jti: string): boolean {
  const exp = jtiCache.get(jti);
  if (!exp) return false;
  if (exp <= Date.now()) {
    jtiCache.delete(jti);
    return false;
  }
  return true;
}

/** Internal: exposed for tests so they can simulate a fresh process. */
export function _resetJtiCacheForTests(): void {
  jtiCache.clear();
}

// ── Signature verification ──────────────────────────────────────

/**
 * Verify a DPoP JWT signature.
 *
 * Returns true if signature is valid. Throws on unsupported algorithms
 * or malformed JWK.
 */
async function verifyDpopSignature(
  alg: string,
  jwk: DpopJwk,
  signingInput: string,
  signature: Buffer,
): Promise<boolean> {
  if (alg === 'ES256') {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
      throw new Error(`Algorithm ${alg} requires EC P-256 key, got kty=${jwk.kty} crv=${jwk.crv}`);
    }
    // WebCrypto can import JWK directly.
    const key = await (webcrypto.subtle as any).importKey(
      'jwk',
      jwk as unknown as Record<string, unknown>,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return (webcrypto.subtle as any).verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature,
      Buffer.from(signingInput, 'utf8'),
    );
  }
  if (alg === 'EdDSA') {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') {
      throw new Error(`Algorithm ${alg} requires OKP Ed25519 key, got kty=${jwk.kty} crv=${jwk.crv}`);
    }
    // WebCrypto Ed25519 support is gated by Node version. Try subtle
    // first; fall back to node:crypto.verify with a SPKI-wrapped key.
    try {
      const key = await (webcrypto.subtle as any).importKey(
        'jwk',
        jwk as unknown as Record<string, unknown>,
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
      return (webcrypto.subtle as any).verify(
        { name: 'Ed25519' },
        key,
        signature,
        Buffer.from(signingInput, 'utf8'),
      );
    } catch {
      // Fallback: build a Node KeyObject from the raw JWK and use the
      // sync verify(). Node's createPublicKey accepts JWK directly.
      const keyObj = createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' });
      return nodeVerify(null, Buffer.from(signingInput, 'utf8'), keyObj, signature);
    }
  }
  throw new Error(`Unsupported DPoP signing algorithm: ${alg}. Supported: ES256, EdDSA.`);
}

// ── Public: validateDpopJwt ─────────────────────────────────────

/**
 * Validate a DPoP JWT per RFC 9449 §4.3.
 *
 * Checks (in order):
 *   1. Three-part JWT structure
 *   2. Header: `typ === "dpop+jwt"`, `alg` is supported, `jwk` present
 *   3. Payload: `jti`, `htm`, `htu`, `iat` present and well-typed
 *   4. `htm` matches expected method (case-insensitive — RFC says
 *      uppercase, but be tolerant)
 *   5. `htu` matches expected URL (case-insensitive scheme/host, exact
 *      path; query/fragment stripped per RFC §4.3 step 9)
 *   6. `iat` within ±maxAgeSec of now (default 60s)
 *   7. `ath` (if expected) matches base64url(sha256(access_token))
 *   8. `jti` not previously seen within JTI_TTL_MS (5 min)
 *   9. Signature verifies against the JWK in the header
 *
 * Throws Error on any failure. The error message is safe to surface
 * in the WWW-Authenticate `error_description` (no secrets leak).
 */
export async function validateDpopJwt(
  jwt: string,
  expected: DpopValidationExpectation,
): Promise<DpopValidationResult> {
  if (typeof jwt !== 'string' || !jwt) {
    throw new Error('DPoP JWT is empty or not a string');
  }
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new Error('DPoP JWT must have three parts');
  }
  const [headerB64, payloadB64, sigB64] = parts;

  // ── Header ──
  let header: DpopHeader;
  try {
    header = b64urlJsonDecode<DpopHeader>(headerB64);
  } catch (err) {
    throw new Error(`DPoP JWT header is not valid base64url JSON: ${(err as Error).message}`);
  }
  if (header.typ !== 'dpop+jwt') {
    throw new Error(`DPoP JWT typ must be "dpop+jwt", got "${header.typ}"`);
  }
  if (typeof header.alg !== 'string' || !header.alg) {
    throw new Error('DPoP JWT header missing "alg"');
  }
  if (!header.jwk || typeof header.jwk !== 'object') {
    throw new Error('DPoP JWT header missing "jwk"');
  }
  // Private-key material must not appear in the public header. Reject
  // any JWK that carries the private "d" parameter — see RFC 9449 §4.2.
  if ((header.jwk as unknown as Record<string, unknown>).d !== undefined) {
    throw new Error('DPoP JWK header MUST NOT contain private key material ("d")');
  }

  // ── Payload ──
  let payload: DpopPayload;
  try {
    payload = b64urlJsonDecode<DpopPayload>(payloadB64);
  } catch (err) {
    throw new Error(`DPoP JWT payload is not valid base64url JSON: ${(err as Error).message}`);
  }
  if (typeof payload.jti !== 'string' || !payload.jti) {
    throw new Error('DPoP JWT payload missing "jti"');
  }
  if (typeof payload.htm !== 'string' || !payload.htm) {
    throw new Error('DPoP JWT payload missing "htm"');
  }
  if (typeof payload.htu !== 'string' || !payload.htu) {
    throw new Error('DPoP JWT payload missing "htu"');
  }
  if (typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)) {
    throw new Error('DPoP JWT payload missing or invalid "iat"');
  }

  // ── htm ──
  if (payload.htm.toUpperCase() !== expected.htm.toUpperCase()) {
    throw new Error(`DPoP JWT htm mismatch: expected ${expected.htm}, got ${payload.htm}`);
  }

  // ── htu ──
  // Normalize: strip query + fragment, lowercase scheme + host, keep
  // case-sensitive path. RFC 9449 §4.3 step 9.
  const normUrl = (u: string): string => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      throw new Error(`DPoP htu is not a valid URL: ${u}`);
    }
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname}`;
  };
  if (normUrl(payload.htu) !== normUrl(expected.htu)) {
    throw new Error(`DPoP JWT htu mismatch: expected ${expected.htu}, got ${payload.htu}`);
  }

  // ── iat / freshness ──
  const maxAge = expected.maxAgeSec ?? 60;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - payload.iat) > maxAge) {
    throw new Error(`DPoP JWT iat outside freshness window (now=${nowSec}, iat=${payload.iat}, window=±${maxAge}s)`);
  }

  // ── ath ──
  if (expected.ath !== undefined) {
    if (typeof payload.ath !== 'string') {
      throw new Error('DPoP JWT missing "ath" claim for resource request');
    }
    if (payload.ath !== expected.ath) {
      throw new Error('DPoP JWT ath does not match sha256(access_token)');
    }
  }

  // ── JTI replay ──
  // We check BEFORE signature so a forged-sig replay still counts; an
  // attacker who replays a valid JWT can't get through twice.
  if (jtiSeen(payload.jti)) {
    throw new Error('DPoP JWT jti has been seen recently (replay)');
  }

  // ── Signature ──
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = b64urlDecode(sigB64);
  let ok: boolean;
  try {
    ok = await verifyDpopSignature(header.alg, header.jwk, signingInput, sig);
  } catch (err) {
    throw new Error(`DPoP JWT signature verification failed: ${(err as Error).message}`);
  }
  if (!ok) {
    throw new Error('DPoP JWT signature is invalid');
  }

  // Only remember the jti after full validation succeeded. Failed
  // verifications don't poison the cache.
  rememberJti(payload.jti);

  const jkt = jktFromJwk(header.jwk);
  return { jwk: header.jwk, jkt, payload };
}

/**
 * Reconstruct the full URL the client sees from an Express request.
 * Honors the X-Forwarded-Proto / X-Forwarded-Host headers set by Azure
 * Container Apps' Envoy proxy (the relay already sets `trust proxy`).
 *
 * RFC 9449 htu MUST be the URL the CLIENT addressed — for a relay
 * behind a TLS-terminating proxy this is the https://public-host/path
 * URL, never the internal http://0.0.0.0:8080/path URL.
 */
export function reconstructRequestUrl(req: {
  protocol: string;
  get: (name: string) => string | undefined;
  originalUrl: string;
}): string {
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  const host = req.get('host') ?? 'localhost';
  // Strip query string — htu is path-only per RFC 9449 §4.3 step 9.
  const path = (req.originalUrl || '/').split('?')[0];
  return `${proto}://${host}${path}`;
}
