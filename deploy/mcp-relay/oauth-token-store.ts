/**
 * @module oauth-token-store
 * @description Persistent storage for the OAuth provider's access + refresh
 *              tokens, written to the same service-account pod that backs
 *              the DCR client store.
 *
 * Background:
 *   The relay's `InteregoOAuthProvider` keeps access tokens + refresh
 *   tokens in process-local Maps. Every container restart drops both
 *   maps and existing ChatGPT / claude.ai connector sessions break
 *   with stale-token errors (now surfacing as RFC 6750 `401 invalid_token`
 *   thanks to the prior commit, but the structural fix is still to
 *   not lose the tokens in the first place).
 *
 *   This module mirrors each issued access / refresh token onto the
 *   relay's service-account pod (the same `svc-relay-dcr/` container
 *   the DCR client records use), under sibling subcontainers
 *   `tokens/` and `tokens-refresh/`. Each token is written as a single
 *   small JSON-LD file at
 *
 *     ${oauthStorePodUrl}/tokens/<sha256(token).hex>.jsonld
 *
 *   The filename is sha256(token), NOT the raw token, so the bearer
 *   token string itself never lands on disk. Lookup at startup walks
 *   the container listing and the body of each file carries the
 *   fully-typed AuthInfo the provider needs to reconstruct its Map
 *   (clientId, scopes, expiresAt, extra { agentId, ownerWebId, ... }).
 *
 *   Operational-state storage on purpose: NOT a `cg:` Context Descriptor.
 *   Tokens are short-lived (1h access, 14d refresh), opaque to the
 *   federation, and never shared. A descriptor with the seven facets
 *   would carry a lot of ceremony for no semantic gain — this is the
 *   same line `oauth-client-store.ts` walks, just one level looser.
 *
 *   Cold-start: missing container = empty Map (legacy behaviour).
 *   Lazy GC: expired files are deleted on load and on every
 *   `verifyAccessToken` miss / expiry.
 */

import { createHash } from 'node:crypto';

import type {
  FetchFn,
} from '@interego/core';

import type { InteregoAuthInfo, ResolvedIdentity } from './oauth-provider.js';

// ── Configuration ────────────────────────────────────────────

export interface OAuthTokenStoreConfig {
  /** Service-account pod URL. Same pod the DCR client store uses. */
  readonly podUrl: string;
  /** Optional custom fetch — defaults to plain global fetch. */
  readonly fetch?: FetchFn;
  /** Optional logger — defaults to silent. */
  readonly log?: (msg: string) => void;
}

// Subcontainers below the service-account pod root. Sibling to the
// existing DCR descriptors so an operator inspecting `svc-relay-dcr/`
// sees one consistent layout: clients/, tokens/, tokens-refresh/.
const ACCESS_TOKEN_CONTAINER = 'tokens/';
const REFRESH_TOKEN_CONTAINER = 'tokens-refresh/';

// ── Helpers ─────────────────────────────────────────────────

function ensureTrailingSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

/**
 * sha256 the raw token. The filename in the pod is this hex string so
 * the bearer token itself never appears on disk. Lookup hashes the
 * inbound bearer to find the file.
 */
export function sha256Hex(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function accessTokenUrl(podUrl: string, sha: string): string {
  return `${ensureTrailingSlash(podUrl)}${ACCESS_TOKEN_CONTAINER}${sha}.jsonld`;
}
function refreshTokenUrl(podUrl: string, sha: string): string {
  return `${ensureTrailingSlash(podUrl)}${REFRESH_TOKEN_CONTAINER}${sha}.jsonld`;
}

function defaultFetch(): FetchFn {
  return (async (url, init) => {
    const r = await fetch(url, init as RequestInit);
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      headers: { get: (n: string) => r.headers.get(n) },
      text: () => r.text(),
      json: () => r.json(),
    };
  }) as FetchFn;
}

// ── Wire shape ──────────────────────────────────────────────
//
// Each token file is one small JSON-LD document. Keeping it JSON-LD
// (rather than plain JSON) leaves room for SPARQL/RDF tooling to
// index the pod later without a migration; in the meantime callers
// only ever round-trip via the JSON top-level keys.

interface PersistedAccessToken {
  '@context': Record<string, string>;
  '@id': string;
  '@type': string;
  token_sha256: string;
  clientId: string;
  scopes: string[];
  /** Unix seconds — matches AuthInfo.expiresAt. */
  expiresAt: number;
  extra: {
    agentId: string;
    ownerWebId: string;
    userId: string;
    podUrl: string;
    identityToken: string;
    cnf?: { jkt: string };
  };
}

interface PersistedRefreshToken {
  '@context': Record<string, string>;
  '@id': string;
  '@type': string;
  token_sha256: string;
  clientId: string;
  scopes: string[];
  /** Unix MILLIseconds — refresh-Map stores ms (Date.now()) to preserve 14d window math. */
  expiresAt: number;
  identity: ResolvedIdentity;
  dpopJkt?: string;
}

const JSONLD_CTX: Record<string, string> = {
  relay: 'https://interego-emergent.example/ns/mcp-relay#',
};
const TYPE_ACCESS = 'urn:cg:relay:AccessToken';
const TYPE_REFRESH = 'urn:cg:relay:RefreshToken';

// ── save: access token ──────────────────────────────────────

export async function persistAccessToken(
  token: string,
  info: InteregoAuthInfo,
  cfg: OAuthTokenStoreConfig,
): Promise<void> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const sha = sha256Hex(token);
  const url = accessTokenUrl(cfg.podUrl, sha);

  if (!info.extra) {
    // Shouldn't happen — the provider always populates `extra` — but
    // refuse to persist a token without an identity rather than write
    // an unparseable file.
    log(`[oauth-token-store] refusing to persist access token without extra (sha=${sha.slice(0, 12)})`);
    return;
  }

  const body: PersistedAccessToken = {
    '@context': JSONLD_CTX,
    '@id': `urn:interego:mcp-relay:token:${sha.slice(0, 16)}`,
    '@type': TYPE_ACCESS,
    token_sha256: sha,
    clientId: info.clientId,
    scopes: info.scopes,
    expiresAt: info.expiresAt ?? Math.floor(Date.now() / 1000),
    extra: {
      agentId: info.extra.agentId,
      ownerWebId: info.extra.ownerWebId,
      userId: info.extra.userId,
      podUrl: info.extra.podUrl,
      identityToken: info.extra.identityToken,
      ...(info.extra.cnf ? { cnf: info.extra.cnf } : {}),
    },
  };

  const r = await fetchFn(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(body, null, 2),
  });
  if (!r.ok) {
    throw new Error(`PUT ${url} failed: ${r.status} ${r.statusText}`);
  }
  log(`[oauth-token-store] persisted access token sha=${sha.slice(0, 12)}... at ${url}`);
}

// ── save: refresh token ─────────────────────────────────────

export interface RefreshTokenRecord {
  clientId: string;
  scopes: string[];
  identity: ResolvedIdentity;
  /** ms-since-epoch (Date.now() based) — matches the provider's in-memory shape. */
  expiresAt: number;
  /** RFC 9449 DPoP JKT binding (if the original /token exchange was DPoP-bound). */
  dpopJkt?: string;
}

export async function persistRefreshToken(
  refreshToken: string,
  rec: RefreshTokenRecord,
  cfg: OAuthTokenStoreConfig,
): Promise<void> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const sha = sha256Hex(refreshToken);
  const url = refreshTokenUrl(cfg.podUrl, sha);

  const body: PersistedRefreshToken = {
    '@context': JSONLD_CTX,
    '@id': `urn:interego:mcp-relay:refresh:${sha.slice(0, 16)}`,
    '@type': TYPE_REFRESH,
    token_sha256: sha,
    clientId: rec.clientId,
    scopes: rec.scopes,
    expiresAt: rec.expiresAt,
    identity: rec.identity,
    ...(rec.dpopJkt ? { dpopJkt: rec.dpopJkt } : {}),
  };

  const r = await fetchFn(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify(body, null, 2),
  });
  if (!r.ok) {
    throw new Error(`PUT ${url} failed: ${r.status} ${r.statusText}`);
  }
  log(`[oauth-token-store] persisted refresh token sha=${sha.slice(0, 12)}... at ${url}`);
}

// ── delete ──────────────────────────────────────────────────

export async function removeAccessToken(
  sha: string,
  cfg: OAuthTokenStoreConfig,
): Promise<void> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const url = accessTokenUrl(cfg.podUrl, sha);
  try {
    const r = await fetchFn(url, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) {
      throw new Error(`DELETE ${url} failed: ${r.status} ${r.statusText}`);
    }
  } catch (err) {
    log(`[oauth-token-store] removeAccessToken(${sha.slice(0, 12)}...): ${(err as Error).message}`);
  }
}

export async function removeRefreshToken(
  sha: string,
  cfg: OAuthTokenStoreConfig,
): Promise<void> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const url = refreshTokenUrl(cfg.podUrl, sha);
  try {
    const r = await fetchFn(url, { method: 'DELETE' });
    if (!r.ok && r.status !== 404) {
      throw new Error(`DELETE ${url} failed: ${r.status} ${r.statusText}`);
    }
  } catch (err) {
    log(`[oauth-token-store] removeRefreshToken(${sha.slice(0, 12)}...): ${(err as Error).message}`);
  }
}

// ── load: one-by-sha (single fetch, used by verifyAccessToken miss path) ──

/**
 * Best-effort fetch of a single access-token record by its raw token
 * string. Used by the `verifyAccessToken` miss path: if the bearer
 * isn't in the in-memory Map, we try one pod fetch before throwing
 * InvalidTokenError. Returns null on any failure (network, 404, parse).
 *
 * On a successful read of an EXPIRED entry, deletes the file
 * best-effort and returns null. Caller treats this exactly the same
 * as "not found".
 */
export async function loadAccessTokenByRaw(
  token: string,
  cfg: OAuthTokenStoreConfig,
): Promise<InteregoAuthInfo | null> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const sha = sha256Hex(token);
  const url = accessTokenUrl(cfg.podUrl, sha);

  try {
    const r = await fetchFn(url, { method: 'GET' });
    if (r.status === 404) return null;
    if (!r.ok) {
      log(`[oauth-token-store] GET ${url} failed: ${r.status} ${r.statusText}`);
      return null;
    }
    const body = JSON.parse(await r.text()) as PersistedAccessToken;
    if (body.token_sha256 !== sha) {
      log(`[oauth-token-store] sha mismatch at ${url} (expected ${sha.slice(0, 12)}...)`);
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (body.expiresAt && body.expiresAt < nowSec) {
      void removeAccessToken(sha, cfg);
      return null;
    }
    const info: InteregoAuthInfo = {
      token,
      clientId: body.clientId,
      scopes: body.scopes,
      expiresAt: body.expiresAt,
      extra: {
        agentId: body.extra.agentId,
        ownerWebId: body.extra.ownerWebId,
        userId: body.extra.userId,
        podUrl: body.extra.podUrl,
        identityToken: body.extra.identityToken,
        ...(body.extra.cnf ? { cnf: body.extra.cnf } : {}),
      },
    };
    return info;
  } catch (err) {
    log(`[oauth-token-store] loadAccessTokenByRaw failed: ${(err as Error).message}`);
    return null;
  }
}

// ── load: bulk-at-startup ───────────────────────────────────

/**
 * List a Solid/LDP container. Returns the URLs of every contained
 * resource ending in `.jsonld`. Cold-start safe: returns [] when the
 * container doesn't yet exist (404) or can't be parsed.
 *
 * The relay's CSS deployment serves LDP container listings as either
 * Turtle (ldp:contains predicates) or JSON. We accept either by
 * accepting whatever the server returns and pulling URLs with a
 * tolerant regex — the only thing we care about is the set of URLs.
 */
async function listContainer(
  containerUrl: string,
  cfg: OAuthTokenStoreConfig,
): Promise<string[]> {
  const fetchFn = cfg.fetch ?? defaultFetch();
  try {
    const r = await fetchFn(containerUrl, {
      method: 'GET',
      headers: { Accept: 'text/turtle, application/ld+json;q=0.9, */*;q=0.5' },
    });
    if (r.status === 404) return [];
    if (!r.ok) return [];
    const body = await r.text();
    const urls = new Set<string>();
    // Turtle: <child.jsonld> or absolute <https://.../child.jsonld>
    const reTurtle = /<([^>\s]+\.jsonld)>/g;
    let m: RegExpExecArray | null;
    while ((m = reTurtle.exec(body)) !== null) {
      const raw = m[1]!;
      try {
        const resolved = new URL(raw, containerUrl).toString();
        urls.add(resolved);
      } catch {
        // skip malformed entries
      }
    }
    // JSON: "@id":"...child.jsonld"
    const reJson = /"@id"\s*:\s*"([^"]+\.jsonld)"/g;
    while ((m = reJson.exec(body)) !== null) {
      const raw = m[1]!;
      try {
        const resolved = new URL(raw, containerUrl).toString();
        urls.add(resolved);
      } catch {
        // skip
      }
    }
    return [...urls];
  } catch {
    return [];
  }
}

/**
 * Read every previously-saved access-token record off the service-
 * account pod, dropping any that have already expired (best-effort
 * DELETE of those files). Returns a Map keyed by the persisted
 * sha256(token) — the CALLER must NOT use this map directly as the
 * provider's in-memory Map, because that map is keyed by the raw
 * token string. See `loadAccessTokens()` for the wrapper.
 *
 * Reason for the two-tier shape: the raw token never leaves the
 * caller's request flow, so we cannot reconstruct it at startup.
 * Instead we maintain a SECONDARY map (`sha → info`) the
 * verifyAccessToken miss path can consult cheaply without a pod
 * round-trip. The provider hashes the inbound bearer, looks up by
 * sha, and on a hit promotes the entry into the raw-token Map.
 */
export async function loadAccessTokens(
  cfg: OAuthTokenStoreConfig,
): Promise<Map<string, InteregoAuthInfo>> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const out = new Map<string, InteregoAuthInfo>();
  const containerUrl = `${ensureTrailingSlash(cfg.podUrl)}${ACCESS_TOKEN_CONTAINER}`;

  const urls = await listContainer(containerUrl, cfg);
  if (urls.length === 0) {
    log(`[oauth-token-store] no access-token files found at ${containerUrl}`);
    return out;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { method: 'GET' });
      if (!r.ok) {
        log(`[oauth-token-store] GET ${url} -> ${r.status}; skipping`);
        continue;
      }
      const body = JSON.parse(await r.text()) as PersistedAccessToken;
      if (!body.token_sha256 || !body.clientId) {
        log(`[oauth-token-store] malformed access-token at ${url}; skipping`);
        continue;
      }
      if (body.expiresAt && body.expiresAt < nowSec) {
        // Lazy GC: drop expired files during startup walk.
        void removeAccessToken(body.token_sha256, cfg);
        continue;
      }
      const info: InteregoAuthInfo = {
        // Placeholder: we don't know the raw token string, only its
        // sha. The consumer (provider's hash-keyed map) reconstructs
        // `token` from the inbound bearer on miss.
        token: body.token_sha256,
        clientId: body.clientId,
        scopes: body.scopes,
        expiresAt: body.expiresAt,
        extra: {
          agentId: body.extra.agentId,
          ownerWebId: body.extra.ownerWebId,
          userId: body.extra.userId,
          podUrl: body.extra.podUrl,
          identityToken: body.extra.identityToken,
          ...(body.extra.cnf ? { cnf: body.extra.cnf } : {}),
        },
      };
      out.set(body.token_sha256, info);
    } catch (err) {
      log(`[oauth-token-store] failed to read ${url}: ${(err as Error).message}`);
      continue;
    }
  }

  log(`[oauth-token-store] loaded ${out.size} access token(s) from ${containerUrl}`);
  return out;
}

/**
 * Refresh-token analog of `loadAccessTokens`. Same secondary-map
 * shape (keyed by sha256(refreshToken)). Expired entries (`expiresAt`
 * is ms-since-epoch for refresh tokens — see the provider) are
 * dropped from disk and excluded from the returned map.
 */
export async function loadRefreshTokens(
  cfg: OAuthTokenStoreConfig,
): Promise<Map<string, RefreshTokenRecord>> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const out = new Map<string, RefreshTokenRecord>();
  const containerUrl = `${ensureTrailingSlash(cfg.podUrl)}${REFRESH_TOKEN_CONTAINER}`;

  const urls = await listContainer(containerUrl, cfg);
  if (urls.length === 0) {
    log(`[oauth-token-store] no refresh-token files found at ${containerUrl}`);
    return out;
  }

  const nowMs = Date.now();
  for (const url of urls) {
    try {
      const r = await fetchFn(url, { method: 'GET' });
      if (!r.ok) {
        log(`[oauth-token-store] GET ${url} -> ${r.status}; skipping`);
        continue;
      }
      const body = JSON.parse(await r.text()) as PersistedRefreshToken;
      if (!body.token_sha256 || !body.clientId || !body.identity) {
        log(`[oauth-token-store] malformed refresh-token at ${url}; skipping`);
        continue;
      }
      if (body.expiresAt && body.expiresAt < nowMs) {
        void removeRefreshToken(body.token_sha256, cfg);
        continue;
      }
      const rec: RefreshTokenRecord = {
        clientId: body.clientId,
        scopes: body.scopes,
        identity: body.identity,
        expiresAt: body.expiresAt,
        ...(body.dpopJkt ? { dpopJkt: body.dpopJkt } : {}),
      };
      out.set(body.token_sha256, rec);
    } catch (err) {
      log(`[oauth-token-store] failed to read ${url}: ${(err as Error).message}`);
      continue;
    }
  }

  log(`[oauth-token-store] loaded ${out.size} refresh token(s) from ${containerUrl}`);
  return out;
}

/**
 * Best-effort fetch of a single refresh-token record by its raw
 * token string. Mirrors `loadAccessTokenByRaw` but for the refresh
 * grant. Returns null on any failure or expiry.
 */
export async function loadRefreshTokenByRaw(
  refreshToken: string,
  cfg: OAuthTokenStoreConfig,
): Promise<RefreshTokenRecord | null> {
  const log = cfg.log ?? (() => {});
  const fetchFn = cfg.fetch ?? defaultFetch();
  const sha = sha256Hex(refreshToken);
  const url = refreshTokenUrl(cfg.podUrl, sha);

  try {
    const r = await fetchFn(url, { method: 'GET' });
    if (r.status === 404) return null;
    if (!r.ok) {
      log(`[oauth-token-store] GET ${url} failed: ${r.status} ${r.statusText}`);
      return null;
    }
    const body = JSON.parse(await r.text()) as PersistedRefreshToken;
    if (body.token_sha256 !== sha) {
      log(`[oauth-token-store] sha mismatch at ${url}`);
      return null;
    }
    if (body.expiresAt && body.expiresAt < Date.now()) {
      void removeRefreshToken(sha, cfg);
      return null;
    }
    return {
      clientId: body.clientId,
      scopes: body.scopes,
      identity: body.identity,
      expiresAt: body.expiresAt,
      ...(body.dpopJkt ? { dpopJkt: body.dpopJkt } : {}),
    };
  } catch (err) {
    log(`[oauth-token-store] loadRefreshTokenByRaw failed: ${(err as Error).message}`);
    return null;
  }
}
