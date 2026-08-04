/**
 * The relay's OAuth 2.1 Authorization Server routes: /authorize, /token, /register.
 *
 * ★ WHY THIS EXISTS. MCP SDK v2 ships NO Authorization Server. Its position is that an
 * MCP server verifies tokens rather than issuing them, so the entire AS surface —
 * `mcpAuthRouter` and its handlers — was moved to `@modelcontextprotocol/server-legacy`,
 * a package whose own README calls it "a frozen copy of v1 code for migration purposes
 * only", promises no new features, and states it is "planned for removal in v3".
 *
 * We ARE an authorization server, and deliberately: the relay mints tokens carrying a
 * DID-bound, pod-scoped identity that no third-party IdP can produce. The spec permits
 * this — "the authorization server ... may be hosted with the resource server" — so what
 * was withdrawn is the SDK's willingness to ship the plumbing, not permission to run it.
 * This file is that plumbing, owned.
 *
 * ★ BEHAVIOURAL EQUIVALENCE IS THE POINT, and it is testable. This fronts live
 * authentication for the claude.ai and ChatGPT connectors, so the contract below was
 * derived from the upstream TypeScript (recovered from the package's own source maps,
 * MIT / Apache-2.0) and is pinned by tests/authorization-server-flow.test.ts — 20
 * end-to-end checks written BEFORE this rewrite for exactly this purpose. If those pass
 * unchanged, the observable behaviour did not move.
 *
 * ★ ONE DELIBERATE IMPROVEMENT: ONE ERROR HIERARCHY.
 *
 * server-legacy defines its OWN unbranded `OAuthError`, distinct from the branded one in
 * `@modelcontextprotocol/server`. Keeping the legacy classes here would have recreated
 * the brand trap this migration already closed once, in reverse: `verifyAccessToken` and
 * the RFC 8707 audience checks throw the BRANDED error, which would fail an
 * `instanceof` against a vendored copy and degrade a precise `invalid_target` into a
 * generic 500. So every error on this path is the branded `OAuthError`, and status is
 * decided by CODE rather than by class identity.
 *
 * Everything else is preserved verbatim, including the parts that are surprising:
 *   - `invalid_client` is 400, not 401, and carries no WWW-Authenticate
 *   - /authorize has TWO error phases: client_id / redirect_uri failures answer
 *     DIRECTLY, everything after redirects to the client with ?error=. Inverting that
 *     is an open-redirect
 *   - /authorize has no CORS (it is reached by top-level navigation)
 *   - Cache-Control: no-store is set inside the handlers, so it is absent on 405/429
 */

import express, { type RequestHandler, type Request, type Response, type Router } from 'express';
import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/server';
import type { InteregoOAuthProvider } from './oauth-provider.js';

/** The client resolved by `authenticateClient`, attached for the /token handler. */
interface RequestWithClient extends Request {
  oauthClient?: OAuthClientInformationFull;
}

/**
 * Turn an error into an OAuth error response.
 *
 * Status is decided by the error CODE, not by class identity — see the header. Only
 * `server_error` is a 500; every other OAuth error is a 400, which is what the SDK did
 * and what clients are built against. A non-OAuth throw becomes a generic 500 whose
 * message is DISCARDED: a provider's internal error text must not reach the wire.
 */
function respondWithError(res: Response, error: unknown): void {
  if (OAuthError.isInstance(error)) {
    const code = String((error as { errorCode?: string; code?: string }).errorCode
      ?? (error as { code?: string }).code ?? OAuthErrorCode.ServerError);
    const status = code === OAuthErrorCode.ServerError ? 500 : 400;
    res.status(status).json({ error: code, error_description: error.message });
    return;
  }
  res.status(500).json({ error: OAuthErrorCode.ServerError, error_description: 'Internal Server Error' });
}

/** 405 with an `Allow` header, before any body parsing or rate limiting. */
function allowedMethods(methods: string[]): RequestHandler {
  return (req, res, next) => {
    if (methods.includes(req.method)) { next(); return; }
    res.status(405).set('Allow', methods.join(', ')).json({
      // `method_not_allowed` is not a registered OAuth error code — it is the SDK's own
      // invention. Preserved because clients may already switch on it.
      error: 'method_not_allowed',
      error_description: `The method ${req.method} is not allowed for this endpoint`,
    });
  };
}

function limiter(windowMs: number, max: number, message: string): RequestHandler {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: message },
  } as Partial<RateLimitOptions>);
}

/**
 * RFC 7636 S256 verification.
 *
 * ★ THIS IS PKCE ENFORCEMENT ITSELF. The SDK performed it in the token handler rather
 * than in the provider (`skipLocalPkceValidation` is not set on ours), so dropping it
 * here would silently remove PKCE from the relay and make an intercepted authorization
 * code redeemable. Comparison is over the base64url encoding of SHA-256(verifier).
 */
function verifyPkceS256(codeVerifier: string, storedChallenge: string): boolean {
  const computed = createHash('sha256').update(codeVerifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Length-independent constant-time-ish compare. Both values are public per RFC 7636
  // (the challenge is sent in the clear at /authorize), so this is defence in depth.
  if (computed.length !== storedChallenge.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ storedChallenge.charCodeAt(i);
  return diff === 0;
}

/**
 * Does a requested redirect_uri match a registered one?
 *
 * Exact string equality. The SDK's `redirectUriMatches` additionally relaxes the PORT
 * for loopback hosts, per RFC 8252 §7.3 — a native app binds an ephemeral port it
 * cannot know at registration time. Both behaviours are preserved; anything looser is
 * an open redirect on the authorization code.
 */
function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  try {
    const a = new URL(requested);
    const b = new URL(registered);
    const loopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
    if (!loopback(a.hostname) || !loopback(b.hostname)) return false;
    return a.protocol === b.protocol && a.hostname === b.hostname
      && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** Build the ?error= redirect used by /authorize's second phase. */
function errorRedirect(redirectUri: string, error: unknown, state: string | undefined, issuer?: string): string {
  const u = new URL(redirectUri);
  const code = OAuthError.isInstance(error)
    ? String((error as { errorCode?: string; code?: string }).errorCode ?? (error as { code?: string }).code ?? OAuthErrorCode.ServerError)
    : OAuthErrorCode.ServerError;
  u.searchParams.set('error', code);
  u.searchParams.set('error_description', error instanceof Error ? error.message : 'Internal Server Error');
  if (state !== undefined) u.searchParams.set('state', state);
  // RFC 9207: identify which AS produced this response, so a client juggling several
  // cannot be confused into accepting one server's answer as another's.
  if (issuer) u.searchParams.set('iss', issuer);
  return u.toString();
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface OAuthRouterOptions {
  provider: InteregoOAuthProvider;
  issuerUrl: URL;
  scopesSupported?: string[];
}

/**
 * Mount /authorize, /token and /register.
 *
 * NOT mounted, deliberately:
 *   - /revoke — the provider implements no `revokeToken`, so the SDK never mounted it
 *     either and the metadata never advertised it. Adding it now would be a new,
 *     untested surface.
 *
 *     ★ AND THE CONSEQUENCE, WHICH THIS COMMENT USED TO LEAVE UNSAID: with no
 *     revocation, the ONLY ceiling on a leaked bearer is its own TTL — 1h access,
 *     14 days refresh. That is an accepted risk, recorded at the OAuth-routes comment
 *     in server.ts, not an absence nobody noticed. The startup banner advertised
 *     `/revoke` regardless until it was corrected, so the gap read as closed.
 *
 *     Whoever mounts it: RFC 7009 §2.1 requires the SAME client authentication as
 *     /token, so the authenticator below must be extracted and shared rather than
 *     copied (the copy that lost the secret-expiry check would let a client with a
 *     dead secret keep killing tokens), and the provider needs a revocation TOMBSTONE
 *     rather than a map delete — `verifyAccessToken` and `exchangeRefreshToken` both
 *     read through to the pod on a map miss and promote what they find back into the
 *     maps, so a delete-only revocation is undone by the very next request.
 *   - the /.well-known documents — the relay serves its own, registered earlier in
 *     server.ts, carrying JSON-LD and Hydra affordances the SDK's derivation cannot
 *     express. They already shadowed the SDK's by route order; now there is nothing to
 *     shadow.
 */
export function interegoOAuthRouter(options: OAuthRouterOptions): Router {
  const { provider, issuerUrl } = options;
  const issuer = issuerUrl.href;
  const router = express.Router();

  // ── /authorize ─────────────────────────────────────────────────────────
  // No cors() — matching the SDK. This endpoint is reached by top-level browser
  // navigation, never by fetch(), so a preflight would be meaningless.
  const authorizeRouter = express.Router();
  authorizeRouter.use(allowedMethods(['GET', 'POST']));
  authorizeRouter.use(express.urlencoded({ extended: false }));
  authorizeRouter.use(limiter(15 * 60 * 1000, 100, 'You have exceeded the rate limit for authorization requests'));
  authorizeRouter.all('/', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const source = (req.method === 'POST' ? req.body : req.query) as Record<string, unknown>;

    // ── PHASE 1 — errors answer DIRECTLY ─────────────────────────────────
    // Until client_id and redirect_uri are BOTH validated there is no address we are
    // entitled to redirect to. Redirecting on these would hand an attacker an
    // open redirect and leak the error to a URL of their choosing.
    let client: OAuthClientInformationFull;
    let redirectUri: string;
    try {
      const clientId = asString(source?.['client_id']);
      if (clientId === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'client_id is required and must be a single string value');
      }
      const requestedRedirect = asString(source?.['redirect_uri']);
      if (source?.['redirect_uri'] !== undefined && requestedRedirect === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'redirect_uri must be a single string value');
      }
      if (requestedRedirect !== undefined && !URL.canParse(requestedRedirect)) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'redirect_uri must be a valid URL');
      }

      const found = await provider.clientsStore.getClient(clientId);
      if (!found) throw new OAuthError(OAuthErrorCode.InvalidClient, 'Invalid client_id');
      client = found;

      const registered = client.redirect_uris ?? [];
      if (requestedRedirect !== undefined) {
        if (!registered.some(r => redirectUriMatches(requestedRedirect, r))) {
          throw new OAuthError(OAuthErrorCode.InvalidRequest, 'Unregistered redirect_uri');
        }
        redirectUri = requestedRedirect;
      } else if (registered.length === 1) {
        redirectUri = registered[0]!;
      } else {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'redirect_uri must be specified when client has multiple registered URIs');
      }
    } catch (error) {
      respondWithError(res, error);
      return;
    }

    // ── PHASE 2 — errors REDIRECT to the (now validated) redirect_uri ────
    let state: string | undefined;
    try {
      state = asString(source?.['state']);
      const scope = asString(source?.['scope']);
      const codeChallenge = asString(source?.['code_challenge']);
      const codeChallengeMethod = asString(source?.['code_challenge_method']);
      const resource = asString(source?.['resource']);

      // PKCE is mandatory. OAuth 2.1 removed the implicit grant and requires PKCE on
      // every authorization-code flow; a code issued without one is bearer-equivalent.
      if (codeChallenge === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'code_challenge is required');
      }
      if (codeChallengeMethod !== undefined && codeChallengeMethod !== 'S256') {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'code_challenge_method must be S256');
      }
      if (resource !== undefined && !URL.canParse(resource)) {
        throw new OAuthError(OAuthErrorCode.InvalidTarget, 'resource must be a valid URL');
      }

      await provider.authorize(
        client,
        {
          ...(state !== undefined ? { state } : {}),
          scopes: scope !== undefined ? scope.split(' ').filter(Boolean) : [],
          redirectUri,
          codeChallenge,
          ...(resource !== undefined ? { resource: new URL(resource) } : {}),
        },
        res,
      );
    } catch (error) {
      if (!res.headersSent) res.redirect(302, errorRedirect(redirectUri, error, state, issuer));
    }
  });
  router.use('/authorize', authorizeRouter);

  // ── /token ─────────────────────────────────────────────────────────────
  const tokenRouter = express.Router();
  tokenRouter.use(allowedMethods(['POST']));
  tokenRouter.use(express.urlencoded({ extended: false }));
  tokenRouter.use(limiter(15 * 60 * 1000, 50, 'You have exceeded the rate limit for token requests'));

  // Client authentication. A PUBLIC client (no registered secret) authenticates by
  // client_id alone — PKCE is what binds the exchange, not a secret. A confidential
  // one must present a matching, unexpired secret.
  tokenRouter.use(async (req: RequestWithClient, res: Response, next) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const clientId = asString(body?.['client_id']);
      if (clientId === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidRequest, 'client_id is required');
      }
      const clientSecret = asString(body?.['client_secret']);
      const client = await provider.clientsStore.getClient(clientId);
      if (!client) throw new OAuthError(OAuthErrorCode.InvalidClient, 'Invalid client_id');

      if (client.client_secret) {
        if (!clientSecret) throw new OAuthError(OAuthErrorCode.InvalidClient, 'Client secret is required');
        if (client.client_secret !== clientSecret) {
          throw new OAuthError(OAuthErrorCode.InvalidClient, 'Invalid client_secret');
        }
        if (client.client_secret_expires_at && client.client_secret_expires_at < Math.floor(Date.now() / 1000)) {
          throw new OAuthError(OAuthErrorCode.InvalidClient, 'Client secret has expired');
        }
      }
      req.oauthClient = client;
      next();
    } catch (error) {
      respondWithError(res, error);
    }
  });

  tokenRouter.post('/', async (req: RequestWithClient, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const body = req.body as Record<string, unknown>;
      const client = req.oauthClient;
      if (!client) throw new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');

      const grantType = asString(body?.['grant_type']);
      const resource = asString(body?.['resource']);
      if (resource !== undefined && !URL.canParse(resource)) {
        throw new OAuthError(OAuthErrorCode.InvalidTarget, 'resource must be a valid URL');
      }
      const resourceUrl = resource !== undefined ? new URL(resource) : undefined;

      if (grantType === 'authorization_code') {
        const code = asString(body['code']);
        const codeVerifier = asString(body['code_verifier']);
        if (code === undefined) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'code is required');
        if (codeVerifier === undefined) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'code_verifier is required');
        const redirectUri = asString(body['redirect_uri']);

        // ★ PKCE, verified HERE. The provider does not set skipLocalPkceValidation, so
        // the SDK did this itself — omitting it removes PKCE enforcement entirely.
        const storedChallenge = await provider.challengeForAuthorizationCode(client, code);
        if (!verifyPkceS256(codeVerifier, storedChallenge)) {
          throw new OAuthError(OAuthErrorCode.InvalidGrant, 'code_verifier does not match the challenge');
        }

        const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, redirectUri, resourceUrl);
        res.status(200).json(tokens);
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = asString(body['refresh_token']);
        if (refreshToken === undefined) {
          throw new OAuthError(OAuthErrorCode.InvalidRequest, 'refresh_token is required');
        }
        const scope = asString(body['scope']);
        const tokens = await provider.exchangeRefreshToken(
          client, refreshToken, scope ? scope.split(' ').filter(Boolean) : undefined, resourceUrl);
        res.status(200).json(tokens);
        return;
      }

      throw new OAuthError(OAuthErrorCode.UnsupportedGrantType, 'The grant type is not supported by this authorization server.');
    } catch (error) {
      respondWithError(res, error);
    }
  });
  router.use('/token', tokenRouter);

  // ── /register (Dynamic Client Registration) ────────────────────────────
  // DCR is DEPRECATED by protocol revision 2026-07-28 in favour of Client ID Metadata
  // Documents, which the relay now also supports. It stays mounted because deprecated
  // is not removed and existing registrations must keep working.
  const registerRouter = express.Router();
  registerRouter.use(allowedMethods(['POST']));
  registerRouter.use(express.json());
  registerRouter.use(limiter(60 * 60 * 1000, 20, 'You have exceeded the rate limit for client registration requests'));
  registerRouter.post('/', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const md = req.body as Record<string, unknown> | undefined;
      if (!md || typeof md !== 'object') {
        throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, 'Client metadata must be a JSON object');
      }
      const redirectUris = Array.isArray(md['redirect_uris'])
        ? (md['redirect_uris'] as unknown[]).filter((u): u is string => typeof u === 'string')
        : undefined;
      if (redirectUris === undefined) {
        throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, 'redirect_uris is required and must be an array of strings');
      }
      // Tightened deliberately over the SDK, which accepted `redirect_uris: []` and
      // registered a client that could never complete an authorization. Every scheme
      // below is refused because it executes in the user agent rather than navigating.
      if (redirectUris.length === 0) {
        throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, 'redirect_uris must contain at least one URI');
      }
      for (const u of redirectUris) {
        if (!URL.canParse(u)) {
          throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, `redirect_uri is not a valid URL: ${u}`);
        }
        const scheme = new URL(u).protocol.toLowerCase();
        if (scheme === 'javascript:' || scheme === 'data:' || scheme === 'vbscript:') {
          throw new OAuthError(OAuthErrorCode.InvalidRedirectUri, `redirect_uri scheme is not allowed: ${scheme}`);
        }
      }

      const registered = await provider.clientsStore.registerClient({
        ...md,
        redirect_uris: redirectUris,
      } as OAuthClientInformationFull);
      res.status(201).json(registered);
    } catch (error) {
      respondWithError(res, error);
    }
  });
  router.use('/register', registerRouter);

  return router;
}
