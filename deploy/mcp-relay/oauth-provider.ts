/**
 * Minimal OAuth 2.1 provider for the Interego MCP relay.
 *
 * Implements the MCP-required subset of OAuth 2.1 per the SDK's
 * OAuthServerProvider interface: DCR, authorization code + PKCE, token
 * exchange, token verification. In-memory state (lost on container restart)
 * — acceptable for a single-user personal deployment.
 *
 * Authorization is passwordless. The authorize() method renders an HTML
 * method-picker (passkey / SIWE / did:key); the page POSTs the resulting
 * cryptographic proof to /oauth/verify (defined in server.ts), which
 * forwards it to the identity server's /auth/* endpoints. On a verified
 * proof, the verify route calls completePendingAuthorization to issue the
 * code and redirect the user back to the client's redirect_uri. No shared
 * secret is involved at any step.
 */
import type { Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';

// The AUTHORIZATION-SERVER contract (OAuthServerProvider and friends) has no v2
// successor — v2 ships only the resource-server half, on the view that an MCP server
// verifies tokens rather than issuing them. So these interfaces come from the frozen
// server-legacy copy while this class continues to BE our authorization server.
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/server-legacy';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/server-legacy';
// ★ AuthInfo and the error classes must come from '@modelcontextprotocol/server', NOT
// server-legacy. server-legacy defines its own unbranded OAuthError; v2's
// requireBearerAuth tests `error instanceof OAuthError` against the BRANDED class, and
// an unbranded one falls through as an unexpected error — turning every invalid token
// into HTTP 500 with no WWW-Authenticate challenge, so no client ever begins an OAuth
// flow. Same reasoning for AuthInfo: one identity, and it must be the one
// verifyBearerToken consumes.
import type { AuthInfo } from '@modelcontextprotocol/server';
import { OAuthError, OAuthErrorCode, checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/server';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/server';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export interface ResolvedIdentity {
  userId: string;
  agentId: string;
  ownerWebId: string;
  podUrl: string;
  identityToken: string; // bearer token from the identity server
}

export interface InteregoAuthInfo extends AuthInfo {
  // Identity the provider asserts for this token — used by MCP handlers to
  // attribute writes to the authenticated user's home pod. Populated by
  // InteregoOAuthProvider from the identity server's /login response.
  extra?: {
    agentId: string;
    ownerWebId: string;
    userId: string;
    /** The user's canonical home pod (declared by the identity server). The relay
     *  threads this through `req.auth.extra` so MCP tool calls without an
     *  explicit `pod_url` default to the correct pod — never silently
     *  reconstructed from `userId` by the relay. */
    podUrl: string;
    identityToken: string;
    /**
     * RFC 9449 cnf.jkt — JWK SHA-256 thumbprint of the DPoP public key
     * this access token is bound to. Present iff the token was issued
     * over a DPoP-bound /token exchange. The /mcp middleware compares
     * this against the JWK in the inbound DPoP header before accepting
     * the request.
     */
    cnf?: { jkt: string };
  };
}

/**
 * Identity-server-backed OAuth provider for the Interego MCP relay.
 *
 * The authorize() page presents a passwordless method-picker (passkey,
 * Ethereum SIWE, did:key). The browser submits the resulting cryptographic
 * proof to the server-side /oauth/verify route, which forwards it to the
 * identity server's matching /auth/* endpoint (e.g. /auth/webauthn/verify,
 * /auth/siwe/verify, /auth/did/verify). On a verified proof, the provider
 * issues an OAuth access token that carries the user's identity (webId,
 * podUrl, agentId) so MCP tool calls land in THAT user's pod rather than a
 * shared admin identity.
 *
 * Design notes:
 * - In-memory state (clients, auth codes, access tokens) — lost on restart.
 * - Identity resolution is delegated to identity server: this provider stays
 *   a thin OAuth shell so the identity server remains the source of truth.
 * - No refresh tokens yet; tokens TTL = 1h; re-authenticate via /oauth/verify.
 */
export class InteregoOAuthProvider implements OAuthServerProvider {
  // Initial state can be hydrated from a persistent store at startup; see
  // deploy/mcp-relay/oauth-client-store.ts. When the constructor's
  // `initialClients` arg is empty the map starts empty (legacy behavior).
  private clients: Map<string, OAuthClientInformationFull>;
  private authCodes = new Map<string, {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    scopes: string[];
    identity: ResolvedIdentity;
    expiresAt: number;
    /**
     * RFC 8707 resource indicator the client named at /authorize, if any. The token
     * exchange must be for the SAME resource, and the issued token is bound to it.
     */
    resource?: string;
  }>();
  private accessTokens = new Map<string, InteregoAuthInfo>();
  /**
   * Secondary access-token index keyed by sha256(token).hex.
   *
   * Hydrated at startup from the persistent backing store (see
   * `cfg.initialAccessTokensBySha`). The raw token string is NEVER
   * persisted, only its sha256, so we cannot reconstruct the primary
   * `accessTokens` map at startup. Instead we keep this side map.
   *
   * verifyAccessToken's hot path consults `accessTokens` first (cheap
   * O(1) on the raw token); on a miss it falls back to hashing the
   * inbound bearer and probing `accessTokensBySha`. On a hit there it
   * promotes the entry into `accessTokens` (now that the raw token is
   * known) so subsequent calls skip the sha step.
   */
  private accessTokensBySha = new Map<string, InteregoAuthInfo>();
  // Refresh tokens: long-lived (14 days) secrets that can be traded for a
  // fresh access token without reprompting the user. Keyed by the token
  // string. One refresh token per access token issuance.
  private refreshTokens = new Map<string, {
    clientId: string;
    scopes: string[];
    identity: ResolvedIdentity;
    expiresAt: number;
  }>();
  /** Refresh-token analog of `accessTokensBySha`. Same promotion rules. */
  private refreshTokensBySha = new Map<string, {
    clientId: string;
    scopes: string[];
    identity: ResolvedIdentity;
    expiresAt: number;
    dpopJkt?: string;
  }>();
  private pendingAuthorizations = new Map<string, {
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
    expiresAt: number;
  }>();
  /**
   * Per-authorization-code DPoP binding stash. Set by the relay's
   * /token middleware when a valid DPoP proof accompanies the exchange
   * request, read here in exchangeAuthorizationCode so we can embed the
   * `cnf.jkt` claim and flip token_type from "Bearer" to "DPoP".
   *
   * Keyed by the authorization_code value the client sent. Entries are
   * cleaned up alongside the code itself.
   */
  /** Cap for the unauthenticated-write codeDpopJkt map (see bindAuthorizationCodeDpop). */
  private static readonly CODE_DPOP_MAX = 10_000;
  private codeDpopJkt = new Map<string, string>();
  /**
   * Per-refresh-token DPoP binding stash. Same mechanism as above but
   * for the refresh-token grant. RFC 9449 §5.2 requires that a DPoP-
   * bound refresh token can only be redeemed with a fresh DPoP proof
   * whose JWK matches the original binding.
   */
  private refreshDpopJkt = new Map<string, string>();

  constructor(
    private readonly cfg: {
      identityUrl: string;
      tokenTtlSec?: number;
      /**
       * RFC 8707 canonical resource identifier of THIS resource server — the relay's
       * own public URL. Tokens are bound to it, and a client naming a different
       * resource is refused.
       *
       * When unset, audience binding is inert: tokens carry no `resource` and
       * verifyAccessToken enforces nothing. That is the local-dev posture, not the
       * deployed one — deployments set PUBLIC_BASE_URL and the relay passes it here.
       */
      resourceIdentifier?: string;
      /**
       * SSRF-GUARDED fetch used to dereference a Client ID Metadata Document.
       *
       * MUST be the relay's `guardedInvokeFetch`, never a bare fetch: the URL is
       * entirely caller-supplied, so every redirect hop has to be re-screened against
       * loopback, link-local, private ranges and internal-labelled hosts. Omitting it
       * disables CIMD rather than falling back to an unguarded fetch — a client_id
       * URL is exactly the shape of input that turns a server into an SSRF proxy.
       */
      cimdFetch?: (url: string, init?: unknown) => Promise<{
        ok: boolean; status: number;
        text: () => Promise<string>;
        headers: { get: (n: string) => string | null };
      }>;
      /** How long a resolved CIMD stays cached, in seconds. Defaults to 300. */
      cimdCacheTtlSec?: number;
      /**
       * Map of pre-existing client_id → OAuthClientInformationFull,
       * typically loaded from the persistent store at startup. The
       * provider takes ownership of the Map (does not copy) — callers
       * MUST NOT mutate it after handing it over.
       */
      initialClients?: Map<string, OAuthClientInformationFull>;
      /**
       * Optional async sink invoked after a successful registerClient.
       * Fire-and-forget — the caller awaits Promise rejection only via
       * the supplied logger. Persistence failures DO NOT fail the DCR
       * call: the client is in this process's map for the lifetime of
       * this process, so the user's authorization succeeds; the worst
       * case is the registration is lost on the next restart, which
       * is the same as the legacy in-memory-only behavior.
       */
      persistClient?: (
        client_id: string,
        client_data: OAuthClientInformationFull,
      ) => Promise<void>;
      /**
       * Pre-hydrated secondary index for access tokens, keyed by
       * sha256(token).hex. Built at startup from the persistent
       * backing store. See the comment on `accessTokensBySha`.
       */
      initialAccessTokensBySha?: Map<string, InteregoAuthInfo>;
      /** Same idea for refresh tokens. */
      initialRefreshTokensBySha?: Map<string, {
        clientId: string;
        scopes: string[];
        identity: ResolvedIdentity;
        expiresAt: number;
        dpopJkt?: string;
      }>;
      /**
       * Optional async sinks for OAuth token lifecycle events. Same
       * fire-and-forget contract as `persistClient` — failures log
       * but do NOT fail the OAuth exchange. Without these the provider
       * still works but tokens evaporate on container restart, which
       * surfaces to MCP clients as stale-token 401s.
       */
      persistAccessToken?: (token: string, info: InteregoAuthInfo) => Promise<void>;
      persistRefreshToken?: (refreshToken: string, rec: {
        clientId: string;
        scopes: string[];
        identity: ResolvedIdentity;
        expiresAt: number;
        dpopJkt?: string;
      }) => Promise<void>;
      removeAccessToken?: (sha256Hex: string) => Promise<void>;
      removeRefreshToken?: (sha256Hex: string) => Promise<void>;
      /**
       * Best-effort one-shot lookup for a single raw access token.
       * Called on verifyAccessToken miss BEFORE throwing
       * OAuthError(InvalidToken). Lets a client whose token was issued by a
       * prior relay revision keep working without re-authenticating
       * — the provider transparently rehydrates from the backing
       * store. Return null on miss.
       */
      lookupAccessTokenByRaw?: (token: string) => Promise<InteregoAuthInfo | null>;
      /**
       * Best-effort read-through loader for a single refresh token by its
       * raw string. Called on exchangeRefreshToken miss BEFORE rejecting,
       * mirroring lookupAccessTokenByRaw. Lets a refresh grant succeed for
       * a token issued by a prior relay revision / not yet warmed into the
       * in-memory map — the "authority on the pod, process holds only a
       * read-through cache" discipline applied to the last critical
       * in-process-only lookup. Return null on miss/expiry.
       */
      lookupRefreshTokenByRaw?: (refreshToken: string) => Promise<{
        clientId: string;
        scopes: string[];
        identity: ResolvedIdentity;
        expiresAt: number;
        dpopJkt?: string;
      } | null>;
      /**
       * Best-effort read-through loader for a single client by client_id.
       * Called on `getClient` miss BEFORE returning undefined. Lets a
       * client whose registration exists on the backing store but is not
       * in the in-memory map (e.g. manifest drifted out of sync with the
       * on-pod descriptors, or the map was started small to keep boot
       * fast) authenticate without re-registering. Return undefined on
       * miss. The result is cached into the in-memory map.
       */
      loadClient?: (clientId: string) => Promise<OAuthClientInformationFull | undefined>;
      /** Optional logger used by the fire-and-forget persistence path. */
      log?: (msg: string) => void;
    },
  ) {
    this.clients = cfg.initialClients ?? new Map();
    if (cfg.initialAccessTokensBySha) {
      this.accessTokensBySha = cfg.initialAccessTokensBySha;
    }
    if (cfg.initialRefreshTokensBySha) {
      this.refreshTokensBySha = cfg.initialRefreshTokensBySha;
    }
    // R9 — there was NO sweeper anywhere in this file: authCodes and
    // pendingAuthorizations each carry an `expiresAt` that nothing ever read, so
    // expired entries accumulated for the process lifetime (a slow-burn OOM that,
    // at the 2 GiB relay floor, surfaces as opaque 502s with empty logs). Sweep
    // them periodically. unref() so the timer never holds the process open.
    this.sweepTimer = setInterval(() => this.sweepExpired(), InteregoOAuthProvider.SWEEP_INTERVAL_MS);
    (this.sweepTimer as unknown as { unref?: () => void }).unref?.();
  }

  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private static readonly SWEEP_INTERVAL_MS = 5 * 60_000;

  /** Drop entries whose own `expiresAt` has passed. Safe by construction: an
   *  expired authorization code or pending authorization is already unusable. */
  private sweepExpired(): void {
    const now = Date.now();
    let dropped = 0;
    for (const [k, v] of this.authCodes) {
      if (v.expiresAt <= now) { this.authCodes.delete(k); this.codeDpopJkt.delete(k); dropped++; }
    }
    for (const [k, v] of this.pendingAuthorizations) {
      if (v.expiresAt <= now) { this.pendingAuthorizations.delete(k); dropped++; }
    }
    for (const [k, v] of this.refreshTokens) {
      if (v.expiresAt <= now) { this.refreshTokens.delete(k); this.refreshDpopJkt.delete(k); dropped++; }
    }
    if (dropped > 0) {
      // eslint-disable-next-line no-console
      console.log(`[oauth] swept ${dropped} expired entr${dropped === 1 ? 'y' : 'ies'}`);
    }
  }

  /** Stop the sweeper (tests / graceful shutdown). */
  stopSweeper(): void { clearInterval(this.sweepTimer); }

  /** sha256(token).hex — same hash the persistence backend keys on. */
  private static sha256Hex(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Called by the relay's /token middleware after it validates a DPoP
   * proof presented alongside an authorization-code grant. Binds the
   * JWK thumbprint to this code so the subsequent exchangeAuthorizationCode
   * call can embed `cnf.jkt` in the minted access token.
   */
  bindAuthorizationCodeDpop(authorizationCode: string, jkt: string): void {
    // R9 — this is written by the pre-authenticateClient /token middleware under ANY
    // caller-supplied `code` string, i.e. FULLY UNAUTHENTICATED and before the code
    // is validated. The only delete is on the SUCCESS path of
    // exchangeAuthorizationCode, which a bogus code never reaches — so every
    // attacker-supplied code leaked a permanent entry. Bound it: an authorization
    // code is single-use and short-lived, so evicting the oldest is safe (a genuine
    // flow redeems its code within seconds of binding it).
    if (this.codeDpopJkt.size >= InteregoOAuthProvider.CODE_DPOP_MAX && !this.codeDpopJkt.has(authorizationCode)) {
      const oldest = this.codeDpopJkt.keys().next().value;
      if (oldest !== undefined) this.codeDpopJkt.delete(oldest);
    }
    this.codeDpopJkt.set(authorizationCode, jkt);
  }

  /** Read-only: get the DPoP JKT bound to a refresh token, if any. */
  getRefreshTokenJkt(refreshToken: string): string | undefined {
    return this.refreshDpopJkt.get(refreshToken);
  }

  /**
   * Read-only introspection of a raw access token for cross-service
   * RPC. Used by /verify-token — the css-gate falls back to this
   * endpoint when identity-server's parseAndVerifySignature() rejects
   * the bearer because it was minted by THIS relay's OAuth flow (the
   * relay's access tokens are opaque randomBytes(32).hex strings the
   * identity server has never seen and cannot verify).
   *
   * Returns the introspection record on a live, non-expired token, or
   * `null` if the token is unknown / expired. The cnf.jkt binding is
   * NOT enforced here — the gate is a different audience than /mcp
   * and is not in a position to validate a DPoP proof against the
   * inbound caller's keypair (the caller signs DPoP to the gate's URL,
   * not the relay's). The token's expiry + ownership are the
   * authorization bar at the gate; per-path scoping happens in the
   * gate's `firstPathSegment(req.url) === userId` check.
   *
   * Side effect: a sha-keyed-only entry (hydrated at startup from the
   * persistent store without a raw token) gets promoted into the raw
   * map so the next call is O(1) — same promotion verifyAccessToken
   * performs on its hot path.
   */
  introspectAccessToken(token: string): {
    valid: true;
    userId: string;
    agentId: string;
    ownerWebId: string;
    podUrl: string;
    scope: string[];
    clientId: string;
    expiresAt: number;
  } | null {
    let info = this.accessTokens.get(token);
    if (!info) {
      const sha = InteregoOAuthProvider.sha256Hex(token);
      const bySha = this.accessTokensBySha.get(sha);
      if (bySha) {
        info = { ...bySha, token };
        this.accessTokens.set(token, info);
      }
    }
    if (!info) return null;
    if (info.expiresAt && info.expiresAt * 1000 < Date.now()) {
      // Expired — drop both indexes for hygiene and report miss.
      this.accessTokens.delete(token);
      this.accessTokensBySha.delete(InteregoOAuthProvider.sha256Hex(token));
      return null;
    }
    const extra = info.extra;
    if (!extra?.userId) return null;
    return {
      valid: true,
      userId: extra.userId,
      agentId: extra.agentId,
      ownerWebId: extra.ownerWebId,
      podUrl: extra.podUrl,
      scope: info.scopes ?? [],
      clientId: info.clientId,
      expiresAt: info.expiresAt ?? 0,
    };
  }

  /** Resolved Client ID Metadata Documents, keyed by client_id URL. */
  private cimdCache = new Map<string, { client: OAuthClientInformationFull; expiresAt: number }>();
  /** Bound on the CIMD cache so a stream of distinct URLs cannot grow it without limit. */
  private static readonly CIMD_CACHE_MAX = 1_000;
  /** Refuse a metadata document larger than this. A client_id URL is caller-supplied. */
  private static readonly CIMD_MAX_BYTES = 64 * 1024;

  /**
   * Is this client_id a Client ID Metadata Document URL rather than a registered id?
   *
   * CIMD identifies a client BY the https URL its metadata lives at, so the id is
   * self-describing and no registration step is needed. Protocol revision 2026-07-28
   * DEPRECATES Dynamic Client Registration in favour of it, and orders client
   * preference pre-registration > CIMD > DCR.
   *
   * https ONLY, and no fragment: an http document is trivially spoofable on the
   * network path, and a fragment is not sent to the server so two different ids would
   * dereference identically.
   */
  private static isCimdClientId(clientId: string): boolean {
    if (!clientId.startsWith('https://')) return false;
    try {
      const u = new URL(clientId);
      return u.protocol === 'https:' && u.hash === '';
    } catch {
      return false;
    }
  }

  /**
   * Dereference a Client ID Metadata Document and turn it into client information.
   *
   * ★ EVERY CHECK HERE IS LOAD-BEARING. This method fetches a URL chosen entirely by
   * the caller and then treats the response as an OAuth client identity, so it is both
   * an SSRF sink and an impersonation sink.
   *
   *  - the fetch goes through the relay's SSRF guard, which re-screens EVERY redirect
   *    hop. Without an injected guard CIMD stays OFF rather than falling back to a
   *    bare fetch.
   *  - the document's `client_id` MUST equal the URL it was fetched from. Without this
   *    anyone who can host a document could claim to BE a different, trusted client —
   *    the self-reference is the entire binding between identity and control of a URL.
   *  - the auth method is forced to `none`. A CIMD client is public by construction: it
   *    proves control of a URL, never possession of a secret. Honouring a
   *    `client_secret_*` method from the document would let a caller assert a
   *    confidential client it cannot authenticate as.
   *  - redirect_uris must be present and https (or loopback, which the OAuth 2.1
   *    native-app flow requires), because that is where the authorization code goes.
   */
  private async resolveClientIdMetadata(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const cached = this.cimdCache.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;

    const fetchFn = this.cfg.cimdFetch;
    if (!fetchFn) return undefined;

    let raw: string;
    try {
      const r = await fetchFn(clientId, { headers: { Accept: 'application/json' } });
      if (!r.ok) return undefined;
      const len = Number(r.headers.get('content-length') ?? '0');
      if (len > InteregoOAuthProvider.CIMD_MAX_BYTES) return undefined;
      raw = await r.text();
      // content-length is advisory; enforce on the body we actually received.
      if (raw.length > InteregoOAuthProvider.CIMD_MAX_BYTES) return undefined;
    } catch (err) {
      const log = this.cfg.log;
      // A refusal from the SSRF guard lands here. Logged, never surfaced to the
      // caller — the reason would tell a prober what the guard blocks.
      if (log) log(`[oauth-provider] CIMD fetch failed for ${clientId}: ${(err as Error)?.message ?? String(err)}`);
      return undefined;
    }

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (!doc || typeof doc !== 'object') return undefined;

    // ★ The self-reference check. Everything else is metadata; this is identity.
    if (doc.client_id !== clientId) {
      const log = this.cfg.log;
      if (log) log(`[oauth-provider] CIMD at ${clientId} declares client_id ${String(doc.client_id)} — refused`);
      return undefined;
    }

    const redirectUris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter(u => typeof u === 'string') as string[] : [];
    if (redirectUris.length === 0) return undefined;
    const redirectsAcceptable = redirectUris.every(u => {
      try {
        const p = new URL(u);
        if (p.protocol === 'https:') return true;
        // OAuth 2.1 keeps loopback redirects for native apps; nothing else.
        return p.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(p.hostname);
      } catch {
        return false;
      }
    });
    if (!redirectsAcceptable) return undefined;

    const client: OAuthClientInformationFull = {
      client_id: clientId,
      redirect_uris: redirectUris,
      grant_types: Array.isArray(doc.grant_types)
        ? (doc.grant_types as string[]) : ['authorization_code', 'refresh_token'],
      response_types: Array.isArray(doc.response_types) ? (doc.response_types as string[]) : ['code'],
      // Forced, not read from the document — see the note above.
      token_endpoint_auth_method: 'none',
      ...(typeof doc.client_name === 'string' ? { client_name: doc.client_name } : {}),
      ...(typeof doc.client_uri === 'string' ? { client_uri: doc.client_uri } : {}),
      ...(typeof doc.logo_uri === 'string' ? { logo_uri: doc.logo_uri } : {}),
      ...(typeof doc.scope === 'string' ? { scope: doc.scope } : {}),
    } as OAuthClientInformationFull;

    // Bounded cache. Evict oldest-first rather than refusing to cache, so a burst of
    // distinct ids degrades to more fetches instead of unbounded memory.
    if (this.cimdCache.size >= InteregoOAuthProvider.CIMD_CACHE_MAX) {
      const oldest = this.cimdCache.keys().next().value;
      if (oldest !== undefined) this.cimdCache.delete(oldest);
    }
    this.cimdCache.set(clientId, {
      client,
      expiresAt: Date.now() + (this.cfg.cimdCacheTtlSec ?? 300) * 1000,
    });
    return client;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: async (clientId) => {
        const inMem = this.clients.get(clientId);
        if (inMem) return inMem;
        // Miss: try the read-through loader (covers clients present on
        // the backing store but absent from the in-memory map). Cache
        // the result so the next lookup is O(1).
        const loader = this.cfg.loadClient;
        if (loader) {
          try {
            const loaded = await loader(clientId);
            if (loaded) {
              this.clients.set(clientId, loaded);
              return loaded;
            }
          } catch (err) {
            const log = this.cfg.log;
            if (log) log(`[oauth-provider] loadClient(${clientId}) failed: ${(err as Error)?.message ?? String(err)}`);
          }
        }
        // ★ Client ID Metadata Documents, LAST — after both registered-client paths.
        //
        // Protocol revision 2026-07-28 deprecates Dynamic Client Registration in
        // favour of CIMD and orders client preference pre-registration > CIMD > DCR.
        // Resolving here mirrors that order exactly: an id that is already registered
        // is never re-fetched, so a registration can never be shadowed by a document
        // hosted at a colliding URL.
        if (InteregoOAuthProvider.isCimdClientId(clientId)) {
          return this.resolveClientIdMetadata(clientId);
        }
        return undefined;
      },
      registerClient: (clientData) => {
        const client_id = randomBytes(16).toString('hex');
        const client_id_issued_at = Math.floor(Date.now() / 1000);
        const registered: OAuthClientInformationFull = {
          ...clientData,
          client_id,
          client_id_issued_at,
        };
        this.clients.set(client_id, registered);
        // Fire-and-forget persistence. If this throws / rejects we
        // still return the freshly-minted registration to the caller —
        // the DCR endpoint MUST return per RFC 7591 even if a back-
        // store write fails. Logging is the only side effect.
        const persist = this.cfg.persistClient;
        const log = this.cfg.log;
        if (persist) {
          void persist(client_id, registered).catch((err: unknown) => {
            const msg = (err as Error)?.message ?? String(err);
            if (log) log(`[oauth-provider] persistClient(${client_id}) failed: ${msg}`);
          });
        }
        return registered;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Stash the request so the signature-proof submission can resume it
    const pendingId = randomBytes(16).toString('hex');
    this.pendingAuthorizations.set(pendingId, {
      client,
      params,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const clientName = escapeHtml(client.client_name || '(unnamed client)');
    const scopeList = escapeHtml((params.scopes || ['mcp']).join(', '));
    const redirectHost = escapeHtml(new URL(params.redirectUri).host);
    const identityOrigin = new URL(this.cfg.identityUrl).origin;
    const identityHost = escapeHtml(new URL(this.cfg.identityUrl).host);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in \u2014 Interego</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 480px; margin: 2.5em auto; padding: 0 1em; }
  h1 { font-size: 1.3em; margin: 0 0 .4em; }
  h2 { font-size: .95em; margin: 1.4em 0 .6em; color: #555; text-transform: uppercase; letter-spacing: .04em; }
  .sub { color: #666; font-size: .9em; margin-bottom: 1.4em; }
  .client { padding: .9em 1em; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 1.4em; }
  .client .name { font-weight: 600; }
  .client .meta { color: #666; font-size: .85em; margin-top: .25em; }
  .method { padding: 1em; border: 1px solid #ddd; border-radius: 8px; margin-bottom: .8em; background: #fafafa; }
  .method h3 { margin: 0 0 .2em; font-size: 1em; }
  .method p { margin: 0 0 .6em; color: #666; font-size: .85em; }
  label { display: block; margin: .6em 0 .2em; font-size: .85em; color: #333; }
  input[type=text] { width: 100%; padding: .55em; font-size: .95em; border: 1px solid #bbb; border-radius: 6px; }
  button { width: 100%; padding: .7em; font-size: .95em; background: #111; color: #fff; border: 0; border-radius: 6px; cursor: pointer; margin-top: .6em; }
  button:hover:not(:disabled) { background: #333; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.secondary { background: #fff; color: #111; border: 1px solid #bbb; }
  button.secondary:hover { background: #f0f0f0; }
  .status { margin-top: .7em; padding: .5em .7em; border-radius: 6px; font-size: .85em; display: none; }
  .status.ok { display: block; background: #d7f5dc; border: 1px solid #2b6c35; color: #193f1d; }
  .status.err { display: block; background: #fadede; border: 1px solid #a43939; color: #4d1818; }
  .status.info { display: block; background: #e3edff; border: 1px solid #355db3; color: #1c2d57; }
  .foot { margin-top: 1.5em; font-size: .8em; color: #888; text-align: center; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    .sub, .foot, h2 { color: #aaa; }
    .client, .method { border-color: #333; background: #181818; }
    .client .meta, .method p { color: #aaa; }
    label { color: #ddd; }
    input[type=text] { background: #1a1a1a; color: #fff; border-color: #444; }
    button { background: #fff; color: #111; }
    button.secondary { background: #1a1a1a; color: #fff; border-color: #444; }
    button.secondary:hover { background: #262626; }
    .status.ok { background: #122d16; border-color: #2b6c35; color: #9de2a8; }
    .status.err { background: #2a1010; border-color: #a43939; color: #f2b0b0; }
    .status.info { background: #12223e; border-color: #355db3; color: #aac1ed; }
  }
</style>
</head>
<body>
  <h1>Sign in to Interego</h1>
  <div class="sub">Authorize this MCP client to act on your behalf against your pod.</div>

  <div class="client">
    <div class="name">${clientName}</div>
    <div class="meta">redirect: ${redirectHost} \u00b7 scopes: ${scopeList}</div>
  </div>

  <h2>Choose a sign-in method</h2>

  <div class="method">
    <h3>Passkey</h3>
    <p>Use Face ID / Touch ID / your device's built-in key. Works on iOS, Android, and modern browsers. No extensions needed.</p>
    <p style="margin-top:.3em">Your identifier is derived from the passkey itself \u2014 typing someone else's name here cannot bind your passkey to their account.</p>
    <input id="pk-name" type="text" placeholder="Your name (display only)" autocomplete="name">
    <details style="margin:.4em 0 .6em">
      <summary style="cursor:pointer;color:#8ea0be;font-size:.9em">Advanced: claim a seeded legacy userId (requires one-time invite)</summary>
      <div style="margin-top:.4em;padding:.4em;border:1px dashed #2a3a5a;border-radius:6px">
        <input id="pk-bs-user" type="text" placeholder="Legacy userId (e.g. markj)" autocomplete="off" style="margin-bottom:.3em">
        <input id="pk-bs-invite" type="text" placeholder="Bootstrap invite token (out-of-band)" autocomplete="off">
      </div>
    </details>
    <div style="display:flex;gap:.5em">
      <button onclick="passkeyLogin()" class="secondary" style="flex:1">Sign in</button>
      <button onclick="passkeyRegister()" style="flex:1">Register new</button>
    </div>
    <div id="pk-status" class="status"></div>
  </div>

  <div class="method">
    <h3>Sign in with a known userId</h3>
    <p>If you already know your Interego userId (starts with <code>u-pk-</code>, <code>u-did-</code>, or <code>u-eth-</code>), enter it here. The OS passkey picker will be narrowed to just that account's keys — useful when you have many passkeys on this device.</p>
    <p style="margin-top:.3em;color:#7a8aa3;font-size:.85em">Leave blank and use the Passkey "Sign in" button above for the discoverable-credential picker.</p>
    <input id="uid-userid" type="text" placeholder="u-pk-... / u-did-... / u-eth-..." autocomplete="off" inputmode="latin" spellcheck="false">
    <button onclick="passkeyLoginScoped()" class="secondary">Sign in with this userId</button>
    <div id="uid-status" class="status"></div>
  </div>

  <div class="method">
    <h3>Ethereum wallet (SIWE)</h3>
    <p>Sign in with MetaMask, Coinbase Wallet, or any EIP-1193 provider. For CLI users without a wallet extension, use the DID method below.</p>
    <button onclick="siweLogin()" class="secondary">Connect wallet &amp; sign</button>
    <div id="siwe-status" class="status"></div>
  </div>

  <div class="method">
    <h3>DID (Ed25519)</h3>
    <p>Already have a <code>did:key</code>? Get a challenge, sign it with your key, paste back. Primarily for CLI/automation.</p>
    <input id="did-did" type="text" placeholder="did:key:z..." autocomplete="off">
    <button onclick="didChallenge()" class="secondary">Request challenge</button>
    <div id="did-nonce-wrap" style="display:none;margin-top:.6em">
      <label for="did-sig">Signature (base64url, Ed25519 over nonce)</label>
      <input id="did-sig" type="text" autocomplete="off">
      <button onclick="didSubmit()">Submit signature</button>
    </div>
    <div id="did-status" class="status"></div>
  </div>

  <div class="foot">identity: ${identityHost} \u00b7 pending: ${escapeHtml(pendingId).slice(0, 8)}\u2026</div>

<script>
const PENDING_ID = ${JSON.stringify(pendingId)};
const IDENTITY = ${JSON.stringify(identityOrigin)};

function setStatus(id, msg, cls) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'status ' + (cls || 'info');
}
function b64urlToBytes(s) {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(p);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}

async function submitProof(method, body) {
  const r = await fetch('/oauth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_id: PENDING_ID, method, ...body }),
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok && data.redirect) {
    window.location.href = data.redirect;
  } else {
    throw new Error(data.error || ('HTTP ' + r.status));
  }
}

// ── Passkey flows ──────────────────────────────────────────
async function passkeyRegister() {
  const name = (document.getElementById('pk-name').value || '').trim();
  if (!name) { setStatus('pk-status', 'Enter a display name first.', 'err'); return; }
  const bootstrapUserId = (document.getElementById('pk-bs-user').value || '').trim();
  const bootstrapInvite = (document.getElementById('pk-bs-invite').value || '').trim();
  if ((bootstrapUserId && !bootstrapInvite) || (!bootstrapUserId && bootstrapInvite)) {
    setStatus('pk-status', 'Bootstrap userId and invite must both be supplied.', 'err'); return;
  }
  try {
    setStatus('pk-status', 'Creating passkey...', 'info');
    const body = { name };
    if (bootstrapUserId) { body.bootstrapUserId = bootstrapUserId; body.bootstrapInvite = bootstrapInvite; }
    const optRes = await fetch(IDENTITY + '/auth/webauthn/register-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!optRes.ok) throw new Error('register-options: ' + await optRes.text());
    const options = await optRes.json();
    options.challenge = b64urlToBytes(options.challenge);
    options.user.id = b64urlToBytes(options.user.id);
    if (options.excludeCredentials) options.excludeCredentials.forEach(c => c.id = b64urlToBytes(c.id));

    const cred = await navigator.credentials.create({ publicKey: options });
    const resp = {
      id: cred.id,
      rawId: bytesToB64url(new Uint8Array(cred.rawId)),
      type: cred.type,
      response: {
        attestationObject: bytesToB64url(new Uint8Array(cred.response.attestationObject)),
        clientDataJSON: bytesToB64url(new Uint8Array(cred.response.clientDataJSON)),
        transports: (cred.response.getTransports && cred.response.getTransports()) || [],
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    await submitProof('webauthn-register', { response: resp });
  } catch (e) { setStatus('pk-status', e.message, 'err'); }
}

async function passkeyLogin() {
  try {
    // Discoverable credentials: no userId claim, no allowCredentials. The
    // browser lets the user pick any passkey registered for this RP.
    setStatus('pk-status', 'Requesting challenge...', 'info');
    const chRes = await fetch(IDENTITY + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'webauthn-authenticate' }),
    });
    const ch = await chRes.json();
    if (!ch.nonce) throw new Error(ch.error || 'no challenge');

    const options = {
      challenge: b64urlToBytes(ch.nonce),
      allowCredentials: [],
      userVerification: 'preferred',
    };
    const cred = await navigator.credentials.get({ publicKey: options });
    const resp = {
      id: cred.id,
      rawId: bytesToB64url(new Uint8Array(cred.rawId)),
      type: cred.type,
      response: {
        authenticatorData: bytesToB64url(new Uint8Array(cred.response.authenticatorData)),
        clientDataJSON: bytesToB64url(new Uint8Array(cred.response.clientDataJSON)),
        signature: bytesToB64url(new Uint8Array(cred.response.signature)),
        userHandle: cred.response.userHandle ? bytesToB64url(new Uint8Array(cred.response.userHandle)) : null,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    await submitProof('webauthn-authenticate', { response: resp });
  } catch (e) { setStatus('pk-status', e.message, 'err'); }
}

// Targeted (scoped) passkey sign-in. The user supplies their known
// userId (u-pk-… / u-did-… / u-eth-…); the identity server returns
// the allowCredentials[] for that account so the OS picker shows only
// those passkeys — typically the single account-labeled entry. Falls
// back to the usernameless flow if the field is left blank, so the
// discoverable-credential path stays the default.
async function passkeyLoginScoped() {
  const userId = (document.getElementById('uid-userid').value || '').trim();
  if (!userId) {
    // Empty input: defer to the discoverable picker so a misclick here
    // is still useful.
    return passkeyLogin();
  }
  try {
    setStatus('uid-status', 'Requesting challenge for ' + userId + '...', 'info');
    const chRes = await fetch(IDENTITY + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'webauthn-authenticate', userId: userId }),
    });
    const ch = await chRes.json();
    if (!chRes.ok) {
      // The server returns a generic "no passkey found" for both
      // unknown userIds and userIds with zero passkeys (no enumeration).
      throw new Error(ch.title || ch.error || ('HTTP ' + chRes.status));
    }
    if (!ch.nonce) throw new Error(ch.error || 'no challenge');
    const allow = Array.isArray(ch.allowCredentials) ? ch.allowCredentials : [];
    if (allow.length === 0) {
      // Defensive: the server should never get here, but if it does
      // we refuse to fall through to a discoverable picker — the user
      // explicitly asked for the targeted flow.
      throw new Error('No passkeys are registered for that userId.');
    }
    const options = {
      challenge: b64urlToBytes(ch.nonce),
      allowCredentials: allow.map(function (c) {
        return {
          id: b64urlToBytes(c.id),
          type: c.type || 'public-key',
          transports: c.transports,
        };
      }),
      userVerification: 'preferred',
    };
    setStatus('uid-status', 'Waiting for passkey...', 'info');
    const cred = await navigator.credentials.get({ publicKey: options });
    const resp = {
      id: cred.id,
      rawId: bytesToB64url(new Uint8Array(cred.rawId)),
      type: cred.type,
      response: {
        authenticatorData: bytesToB64url(new Uint8Array(cred.response.authenticatorData)),
        clientDataJSON: bytesToB64url(new Uint8Array(cred.response.clientDataJSON)),
        signature: bytesToB64url(new Uint8Array(cred.response.signature)),
        userHandle: cred.response.userHandle ? bytesToB64url(new Uint8Array(cred.response.userHandle)) : null,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
    };
    await submitProof('webauthn-authenticate', { response: resp });
  } catch (e) { setStatus('uid-status', e.message, 'err'); }
}

// ── SIWE ───────────────────────────────────────────────────
async function siweLogin() {
  if (!window.ethereum) { setStatus('siwe-status', 'No wallet detected. Install a wallet extension, or use the DID method.', 'err'); return; }
  try {
    setStatus('siwe-status', 'Requesting wallet connection...', 'info');
    const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const chRes = await fetch(IDENTITY + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'siwe' }),
    });
    const { nonce } = await chRes.json();
    const domain = window.location.host;
    const issuedAt = new Date().toISOString();
    const message =
      domain + ' wants you to sign in with your Ethereum account:\\n' +
      address + '\\n\\n' +
      'Sign in to Interego\\n\\n' +
      'URI: ' + window.location.origin + '\\n' +
      'Version: 1\\n' +
      'Chain ID: 1\\n' +
      'Nonce: ' + nonce + '\\n' +
      'Issued At: ' + issuedAt;
    setStatus('siwe-status', 'Please sign the message in your wallet...', 'info');
    const signature = await window.ethereum.request({ method: 'personal_sign', params: [message, address] });
    await submitProof('siwe', { message, signature, nonce });
  } catch (e) { setStatus('siwe-status', e.message, 'err'); }
}

// ── DID key signing ────────────────────────────────────────
let didNonceCache = '';
async function didChallenge() {
  const did = document.getElementById('did-did').value.trim();
  if (!did.startsWith('did:')) { setStatus('did-status', 'Enter a DID (did:key:... or did:web:...).', 'err'); return; }
  try {
    const chRes = await fetch(IDENTITY + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'did-sig' }),
    });
    const { nonce } = await chRes.json();
    didNonceCache = nonce;
    document.getElementById('did-nonce-wrap').style.display = 'block';
    setStatus('did-status', 'Nonce: ' + nonce + '\\n\\nSign this (raw UTF-8 bytes) with your Ed25519 key, then paste the base64url signature above.', 'info');
  } catch (e) { setStatus('did-status', e.message, 'err'); }
}
async function didSubmit() {
  const did = document.getElementById('did-did').value.trim();
  const signature = document.getElementById('did-sig').value.trim();
  if (!did || !signature || !didNonceCache) { setStatus('did-status', 'Fill in DID and signature.', 'err'); return; }
  try {
    await submitProof('did', { did, signature, nonce: didNonceCache });
  } catch (e) { setStatus('did-status', e.message, 'err'); }
}
</script>
</body>
</html>`);
  }

  getPendingAuthorization(pendingId: string) {
    return this.pendingAuthorizations.get(pendingId);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const c = this.authCodes.get(authorizationCode);
    if (!c) throw new Error('Invalid authorization code');
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const c = this.authCodes.get(authorizationCode);
    if (!c) throw new Error('Invalid authorization code');
    // ★ RFC 8707. The SDK parses `resource` off /token and hands it here; this
    // parameter did not exist, so the value was silently DISCARDED and every token was
    // issued with no audience at all. 2026-07-28 makes audience restriction a MUST,
    // and the resource-server side does none of it for you: verifyBearerToken never
    // reads authInfo.resource.
    //
    // Two checks, in order: the exchange must name the same resource the
    // authorization did (else a code obtained for one audience buys a token for
    // another), and the resource must be one this server actually is.
    this.assertResourceConsistent(c.resource, resource);
    const boundResource = this.resolveBoundResource(resource ?? (c.resource ? new URL(c.resource) : undefined));
    // Single use
    this.authCodes.delete(authorizationCode);
    // DPoP binding (if any) was keyed by the same authorization code.
    // Pull it out and immediately drop it to keep the stash bounded.
    const jkt = this.codeDpopJkt.get(authorizationCode);
    this.codeDpopJkt.delete(authorizationCode);
    if (c.clientId !== client.client_id) throw new Error('Client ID mismatch');
    if (redirectUri && c.redirectUri !== redirectUri) throw new Error('Redirect URI mismatch');
    if (c.expiresAt < Date.now()) throw new Error('Authorization code expired');

    const token = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    const expiresIn = this.cfg.tokenTtlSec ?? 3600;
    const refreshTtlSec = 14 * 24 * 3600; // 14 days
    const accessInfo: InteregoAuthInfo = {
      token,
      clientId: client.client_id,
      scopes: c.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      // RFC 8707 audience binding. Present only when the client named a resource;
      // verifyAccessToken holds the token to it on every subsequent request.
      ...(boundResource ? { resource: boundResource } : {}),
      extra: {
        agentId: c.identity.agentId,
        ownerWebId: c.identity.ownerWebId,
        userId: c.identity.userId,
        // The user's canonical home pod, as declared by the identity server.
        // Threading this through lets the relay default `pod_url`-less tool
        // calls to the right place without reconstructing from userId — the
        // identity layer is the only authority on which pod a user owns.
        podUrl: c.identity.podUrl,
        identityToken: c.identity.identityToken,
        // RFC 9449 cnf.jkt token-key binding. Only present when the
        // /token request included a valid DPoP proof. The /mcp middleware
        // will refuse to honor the token unless an accompanying DPoP
        // header carries a JWK whose thumbprint equals this value.
        ...(jkt ? { cnf: { jkt } } : {}),
      },
    };
    this.accessTokens.set(token, accessInfo);
    this.accessTokensBySha.set(InteregoOAuthProvider.sha256Hex(token), accessInfo);
    const refreshRec = {
      clientId: client.client_id,
      scopes: c.scopes,
      identity: c.identity,
      expiresAt: Date.now() + refreshTtlSec * 1000,
    };
    this.refreshTokens.set(refresh, refreshRec);
    this.refreshTokensBySha.set(InteregoOAuthProvider.sha256Hex(refresh), {
      ...refreshRec,
      ...(jkt ? { dpopJkt: jkt } : {}),
    });
    // Propagate the DPoP binding onto the refresh token so the next
    // refresh-token grant inherits + enforces it. RFC 9449 §5.2.
    if (jkt) this.refreshDpopJkt.set(refresh, jkt);

    // Fire-and-forget persistence. Same contract as persistClient: a
    // failure logs but does NOT fail the token exchange — the token
    // is live in this process's Map for the lifetime of this process,
    // so the immediate request succeeds. Worst case is the token is
    // lost on the next restart (legacy behaviour).
    const log = this.cfg.log;
    const persistA = this.cfg.persistAccessToken;
    if (persistA) {
      void persistA(token, accessInfo).catch((err: unknown) => {
        const msg = (err as Error)?.message ?? String(err);
        if (log) log(`[oauth-provider] persistAccessToken failed: ${msg}`);
      });
    }
    const persistR = this.cfg.persistRefreshToken;
    if (persistR) {
      void persistR(refresh, {
        ...refreshRec,
        ...(jkt ? { dpopJkt: jkt } : {}),
      }).catch((err: unknown) => {
        const msg = (err as Error)?.message ?? String(err);
        if (log) log(`[oauth-provider] persistRefreshToken failed: ${msg}`);
      });
    }
    return {
      access_token: token,
      // DPoP token_type per RFC 9449 §4. Bearer remains the fallback for
      // clients that haven't adopted DPoP yet — they get a token they
      // can use against /mcp without a DPoP header.
      token_type: jkt ? 'DPoP' : 'Bearer',
      expires_in: expiresIn,
      refresh_token: refresh,
      scope: c.scopes.join(' '),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    // RFC 8707 on the refresh grant: a refresh token may not be traded for a token
    // aimed at a resource this server is not.
    const boundResource = this.resolveBoundResource(resource);
    let rec = this.refreshTokens.get(refreshToken);
    // Sha-keyed fallback for refresh tokens hydrated at startup — same
    // shape as the access-token path. The promote step copies the
    // record into the raw-token map so the rest of this method sees
    // the same in-memory state regardless of which path hit.
    if (!rec) {
      const sha = InteregoOAuthProvider.sha256Hex(refreshToken);
      const bySha = this.refreshTokensBySha.get(sha);
      if (bySha) {
        rec = {
          clientId: bySha.clientId,
          scopes: bySha.scopes,
          identity: bySha.identity,
          expiresAt: bySha.expiresAt,
        };
        this.refreshTokens.set(refreshToken, rec);
        if (bySha.dpopJkt) this.refreshDpopJkt.set(refreshToken, bySha.dpopJkt);
      }
    }
    // Read-through to the backing store on a full miss (mirrors the
    // access-token verifyAccessToken miss path). Covers a refresh token
    // that exists on the pod but isn't in this process's maps — issued by
    // a prior revision, or never warmed in. Promotes into both maps.
    if (!rec && this.cfg.lookupRefreshTokenByRaw) {
      try {
        const loaded = await this.cfg.lookupRefreshTokenByRaw(refreshToken);
        if (loaded) {
          rec = {
            clientId: loaded.clientId,
            scopes: loaded.scopes,
            identity: loaded.identity,
            expiresAt: loaded.expiresAt,
          };
          this.refreshTokens.set(refreshToken, rec);
          const sha = InteregoOAuthProvider.sha256Hex(refreshToken);
          this.refreshTokensBySha.set(sha, {
            clientId: loaded.clientId,
            scopes: loaded.scopes,
            identity: loaded.identity,
            expiresAt: loaded.expiresAt,
            ...(loaded.dpopJkt ? { dpopJkt: loaded.dpopJkt } : {}),
          });
          if (loaded.dpopJkt) this.refreshDpopJkt.set(refreshToken, loaded.dpopJkt);
        }
      } catch (err) {
        const log = this.cfg.log;
        if (log) log(`[oauth-provider] lookupRefreshTokenByRaw failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    if (!rec) throw new Error('Invalid refresh token');
    if (rec.expiresAt < Date.now()) {
      this.refreshTokens.delete(refreshToken);
      throw new Error('Refresh token expired');
    }
    if (rec.clientId !== client.client_id) throw new Error('Client ID mismatch');

    // Scope narrowing: MUST be a subset of the original scopes (RFC 6749 §6).
    const finalScopes = scopes && scopes.length > 0
      ? scopes.filter(s => rec.scopes.includes(s))
      : rec.scopes;
    if (scopes && finalScopes.length !== scopes.length) {
      throw new Error('Requested scopes exceed original grant');
    }

    // Rotate the refresh token: invalidate the old one, issue a new one.
    // Defense against replayed refresh tokens (standard OAuth best practice).
    this.refreshTokens.delete(refreshToken);
    const oldRefreshSha = InteregoOAuthProvider.sha256Hex(refreshToken);
    this.refreshTokensBySha.delete(oldRefreshSha);

    // Inherit any DPoP binding from the prior refresh token. The /token
    // middleware also validated the inbound DPoP proof against this jkt
    // before we got here (see RFC 9449 §5.2: refresh tokens for public
    // clients MUST be bound to the same DPoP key as their original).
    const inheritedJkt = this.refreshDpopJkt.get(refreshToken);
    this.refreshDpopJkt.delete(refreshToken);

    const token = randomBytes(32).toString('hex');
    const newRefresh = randomBytes(32).toString('hex');
    const expiresIn = this.cfg.tokenTtlSec ?? 3600;
    const accessInfo: InteregoAuthInfo = {
      token,
      clientId: client.client_id,
      scopes: finalScopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      ...(boundResource ? { resource: boundResource } : {}),
      extra: {
        agentId: rec.identity.agentId,
        ownerWebId: rec.identity.ownerWebId,
        userId: rec.identity.userId,
        // Carry podUrl across refresh too — see the access-token path above.
        podUrl: rec.identity.podUrl,
        identityToken: rec.identity.identityToken,
        ...(inheritedJkt ? { cnf: { jkt: inheritedJkt } } : {}),
      },
    };
    this.accessTokens.set(token, accessInfo);
    this.accessTokensBySha.set(InteregoOAuthProvider.sha256Hex(token), accessInfo);
    const refreshRec = {
      clientId: client.client_id,
      scopes: finalScopes,
      identity: rec.identity,
      expiresAt: rec.expiresAt, // preserve original refresh TTL window
    };
    this.refreshTokens.set(newRefresh, refreshRec);
    this.refreshTokensBySha.set(InteregoOAuthProvider.sha256Hex(newRefresh), {
      ...refreshRec,
      ...(inheritedJkt ? { dpopJkt: inheritedJkt } : {}),
    });
    if (inheritedJkt) this.refreshDpopJkt.set(newRefresh, inheritedJkt);

    // Fire-and-forget persistence — same as the auth-code path. Also
    // best-effort drop the rotated-out refresh token from the backing
    // store so an attacker who exfiltrated the pod file can't replay
    // a refresh token we just retired.
    const log = this.cfg.log;
    const persistA = this.cfg.persistAccessToken;
    if (persistA) {
      void persistA(token, accessInfo).catch((err: unknown) => {
        const msg = (err as Error)?.message ?? String(err);
        if (log) log(`[oauth-provider] persistAccessToken (refresh) failed: ${msg}`);
      });
    }
    const persistR = this.cfg.persistRefreshToken;
    if (persistR) {
      void persistR(newRefresh, {
        ...refreshRec,
        ...(inheritedJkt ? { dpopJkt: inheritedJkt } : {}),
      }).catch((err: unknown) => {
        const msg = (err as Error)?.message ?? String(err);
        if (log) log(`[oauth-provider] persistRefreshToken (rotated) failed: ${msg}`);
      });
    }
    const removeR = this.cfg.removeRefreshToken;
    if (removeR) {
      void removeR(oldRefreshSha).catch((err: unknown) => {
        const msg = (err as Error)?.message ?? String(err);
        if (log) log(`[oauth-provider] removeRefreshToken (rotated-out) failed: ${msg}`);
      });
    }
    return {
      access_token: token,
      token_type: inheritedJkt ? 'DPoP' : 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefresh,
      scope: finalScopes.join(' '),
    };
  }

  /**
   * RFC 8707 §2 — the resource this server IS, in canonical form (no fragment).
   * `undefined` when unconfigured, which makes audience handling inert.
   */
  private get configuredResource(): URL | undefined {
    if (!this.cfg.resourceIdentifier) return undefined;
    return resourceUrlFromServerUrl(this.cfg.resourceIdentifier);
  }

  /**
   * Refuse a token exchange whose `resource` disagrees with the one the
   * authorization was granted for.
   *
   * Without this an authorization code obtained for audience A could be exchanged for
   * a token claiming audience B. The asymmetry is deliberate: a client that named a
   * resource at /authorize must name the SAME one at /token, but a client that named
   * none at /authorize may still name one at /token (it is narrowing, not switching).
   */
  private assertResourceConsistent(authorized: string | undefined, requested: URL | undefined): void {
    if (!authorized || !requested) return;
    if (resourceUrlFromServerUrl(authorized).href !== resourceUrlFromServerUrl(requested).href) {
      throw new OAuthError(
        OAuthErrorCode.InvalidRequest,
        `The token request names resource ${requested.href}, but this authorization was granted for ${authorized}.`,
      );
    }
  }

  /**
   * Validate a requested resource against what this server is, and return the value to
   * bind onto the issued token.
   *
   * ★ ABSENCE IS TOLERATED, MISMATCH IS NOT. 2026-07-28 requires clients to send
   * `resource`, but the connectors in the field today predate it — refusing an absent
   * indicator would lock out every existing client on deploy. So a request with no
   * resource yields an unbound token exactly as before, while a request that DOES name
   * a resource is held to it. That makes this change strictly additive at the moment
   * it ships, and lets the enforcement tighten once clients have caught up.
   *
   * `checkResourceAllowed` is the SDK's own comparison (same scheme/host/port, and the
   * requested path must be under the configured one) rather than a string compare, so
   * a sub-path resource is accepted and a look-alike host is not.
   */
  private resolveBoundResource(requested: URL | undefined): URL | undefined {
    if (!requested) return undefined;
    const configured = this.configuredResource;
    // Nothing to check against: accept, but do not pretend to have validated.
    if (!configured) return resourceUrlFromServerUrl(requested);
    if (!checkResourceAllowed({ requestedResource: requested, configuredResource: configured })) {
      throw new OAuthError(
        OAuthErrorCode.InvalidTarget,
        `This server does not issue tokens for ${requested.href}; its resource identifier is ${configured.href}.`,
      );
    }
    return resourceUrlFromServerUrl(requested);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // ★ THROW THE BRANDED OAuthError FROM '@modelcontextprotocol/server'.
    //
    // requireBearerAuth turns this into a clean RFC 6750 `401 invalid_token` with a
    // WWW-Authenticate header pointing at the discovery metadata, which is what lets a
    // client begin the OAuth flow. It decides that by testing
    // `error instanceof OAuthError` — and that check is BRAND-based, not structural.
    //
    // Three ways to get this wrong, all of which compile cleanly:
    //   1. a plain Error                            -> 500 server_error
    //   2. server-legacy's identically-named
    //      InvalidTokenError / OAuthError           -> 500, no challenge (unbranded)
    //   3. new OAuthError('some message')           -> the message lands in the CODE
    //                                                 slot, emitting
    //                                                 {"error":"some message"}
    // The argument order is (code, message) — INVERTED versus v1's
    // `new InvalidTokenError(message)`, and `code` is typed `OAuthErrorCode | string`,
    // so form 3 type-checks.
    //
    // The consequence of any of them is not a loud failure: every rejected token
    // becomes a 500 that reads as a backend outage (ChatGPT's connector reports it as
    // a generic "502 upstream"), and no client ever starts an authorization flow.
    let info = this.accessTokens.get(token);
    const sha = InteregoOAuthProvider.sha256Hex(token);
    // Hot-path miss: consult the sha-keyed secondary map (populated at
    // startup from the persistent backing store). On hit, promote into
    // the raw-token Map so subsequent calls are O(1).
    if (!info) {
      const bySha = this.accessTokensBySha.get(sha);
      if (bySha) {
        // The persisted record's `token` slot may be the sha (we don't
        // know the raw token at hydration time). Fix it now that we do.
        info = { ...bySha, token };
        this.accessTokens.set(token, info);
      }
    }
    // Cold-path miss: one best-effort backing-store fetch. Handles the
    // case where the token was issued AFTER the current process started
    // but is being VERIFIED by a different process / after a restart
    // that didn't include this token in its initial load.
    if (!info && this.cfg.lookupAccessTokenByRaw) {
      try {
        const loaded = await this.cfg.lookupAccessTokenByRaw(token);
        if (loaded) {
          info = { ...loaded, token };
          this.accessTokens.set(token, info);
          this.accessTokensBySha.set(sha, info);
        }
      } catch (err) {
        const log = this.cfg.log;
        if (log) log(`[oauth-provider] lookupAccessTokenByRaw failed: ${(err as Error).message}`);
      }
    }
    if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token not found (may have been issued by a prior relay revision; re-authenticate to obtain a fresh token)');
    if (info.expiresAt && info.expiresAt * 1000 < Date.now()) {
      this.accessTokens.delete(token);
      this.accessTokensBySha.delete(sha);
      // Best-effort drop the file too so we don't keep finding the
      // expired entry on every subsequent miss.
      const removeA = this.cfg.removeAccessToken;
      if (removeA) {
        void removeA(sha).catch((err: unknown) => {
          const log = this.cfg.log;
          const msg = (err as Error)?.message ?? String(err);
          if (log) log(`[oauth-provider] removeAccessToken (expired) failed: ${msg}`);
        });
      }
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token expired');
    }
    // ★ RFC 8707 AUDIENCE ENFORCEMENT — the check that made binding worth doing.
    //
    // Binding a resource onto a token accomplishes nothing unless someone verifies it,
    // and the resource-server side of the SDK deliberately does not: verifyBearerToken
    // checks the header shape, the verifier, requiredScopes and expiry, and never reads
    // authInfo.resource. 2026-07-28 is explicit that an MCP server MUST validate that a
    // token was issued for IT, and MUST NOT accept or transit any other token.
    //
    // Only tokens that CARRY an audience are held to it. A token minted before this
    // existed, or by a client that named no resource, has none — those stay valid, which
    // is what keeps this deployable without invalidating every live session. The
    // enforcement grows as the tokens do.
    const configured = this.configuredResource;
    if (info.resource && configured
        && !checkResourceAllowed({ requestedResource: info.resource, configuredResource: configured })) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        `This token was issued for ${info.resource.href}, not for ${configured.href}.`,
      );
    }
    return info;
  }

  /**
   * Called by the /oauth/login POST handler after identity server login
   * succeeds. Issues an authorization code bound to the pending authorization
   * AND the now-resolved user identity (so exchangeAuthorizationCode can
   * mint an OAuth token carrying that identity). Returns the redirect
   * target for the user's browser.
   */
  completePendingAuthorization(
    pendingId: string,
    identity: ResolvedIdentity,
  ): { redirectUri: string; code: string; state?: string } | null {
    const pending = this.pendingAuthorizations.get(pendingId);
    if (!pending) return null;
    if (pending.expiresAt < Date.now()) {
      this.pendingAuthorizations.delete(pendingId);
      return null;
    }
    this.pendingAuthorizations.delete(pendingId);

    const code = randomBytes(32).toString('hex');
    // FIX D — default to ['mcp'] (full access) ONLY when the client
    // requested no scope at all. An EMPTY scopes array from the SDK
    // means the client passed no `scope` query parameter; an array
    // with members (e.g. ['mcp:read']) is an explicit narrowing
    // request that we MUST honor verbatim. The legacy `||` short-
    // circuit treated `[]` as truthy and would have silently kept
    // an empty array — not a bug in practice because every legacy
    // client either passed `scope=mcp` or no scope at all, but it
    // becomes load-bearing now that scope-narrowing is supported.
    const requestedScopes = pending.params.scopes;
    const grantedScopes = requestedScopes && requestedScopes.length > 0
      ? requestedScopes
      : ['mcp'];
    this.authCodes.set(code, {
      clientId: pending.client.client_id,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      scopes: grantedScopes,
      identity,
      expiresAt: Date.now() + 10 * 60 * 1000,
      // RFC 8707: remember what the client asked the token to be FOR, so the
      // exchange can refuse a different audience and the token can be bound to it.
      ...(pending.params.resource ? { resource: pending.params.resource.href } : {}),
    });
    return {
      redirectUri: pending.params.redirectUri,
      code,
      state: pending.params.state,
    };
  }
}

