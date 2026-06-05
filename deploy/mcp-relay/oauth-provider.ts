/**
 * Minimal OAuth 2.1 provider for the Interego MCP relay.
 *
 * Implements the MCP-required subset of OAuth 2.1 per the SDK's
 * OAuthServerProvider interface: DCR, authorization code + PKCE, token
 * exchange, token verification. In-memory state (lost on container restart)
 * — acceptable for a single-user personal deployment.
 *
 * Authorization is gated by a single RELAY_ADMIN_PASSWORD env var. The
 * authorize() method renders an HTML login form; the form POSTs to
 * /oauth/login (defined in server.ts) which calls completePendingAuthorization
 * to issue the code and redirect the user back to the client's redirect_uri.
 */
import type { Response } from 'express';
import { randomBytes, createHash } from 'node:crypto';

import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

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
 * The authorize() login form collects a userId + password, which the server-
 * side /oauth/login route forwards to the identity server's /login endpoint.
 * On success, the provider issues an OAuth access token that carries the
 * user's identity (webId, podUrl, agentId) so MCP tool calls land in THAT
 * user's pod rather than a shared admin identity.
 *
 * Design notes:
 * - In-memory state (clients, auth codes, access tokens) — lost on restart.
 * - Identity resolution is delegated to identity server: this provider stays
 *   a thin OAuth shell so the identity server remains the source of truth.
 * - No refresh tokens yet; tokens TTL = 1h; re-login via identity /login.
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
       * InvalidTokenError. Lets a client whose token was issued by a
       * prior relay revision keep working without re-authenticating
       * — the provider transparently rehydrates from the backing
       * store. Return null on miss.
       */
      lookupAccessTokenByRaw?: (token: string) => Promise<InteregoAuthInfo | null>;
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
  }

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

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
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
  ): Promise<OAuthTokens> {
    const c = this.authCodes.get(authorizationCode);
    if (!c) throw new Error('Invalid authorization code');
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
  ): Promise<OAuthTokens> {
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

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // Throw the SDK's `InvalidTokenError` so requireBearerAuth produces
    // a clean RFC 6750 `401 invalid_token` with WWW-Authenticate header
    // (rather than wrapping a plain Error as `500 server_error`, which
    // looks like a backend outage to clients — ChatGPT's connector
    // surfaces that as a generic "502 upstream" failure mode).
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
    if (!info) throw new InvalidTokenError('Token not found (may have been issued by a prior relay revision; re-authenticate to obtain a fresh token)');
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
      throw new InvalidTokenError('Token expired');
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
    this.authCodes.set(code, {
      clientId: pending.client.client_id,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      scopes: pending.params.scopes || ['mcp'],
      identity,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    return {
      redirectUri: pending.params.redirectUri,
      code,
      state: pending.params.state,
    };
  }
}

