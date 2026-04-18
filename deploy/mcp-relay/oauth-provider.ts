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
import { randomBytes } from 'node:crypto';

import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
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
    identityToken: string;
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
  private clients = new Map<string, OAuthClientInformationFull>();
  private authCodes = new Map<string, {
    clientId: string;
    codeChallenge: string;
    redirectUri: string;
    scopes: string[];
    identity: ResolvedIdentity;
    expiresAt: number;
  }>();
  private accessTokens = new Map<string, InteregoAuthInfo>();
  // Refresh tokens: long-lived (14 days) secrets that can be traded for a
  // fresh access token without reprompting the user. Keyed by the token
  // string. One refresh token per access token issuance.
  private refreshTokens = new Map<string, {
    clientId: string;
    scopes: string[];
    identity: ResolvedIdentity;
    expiresAt: number;
  }>();
  private pendingAuthorizations = new Map<string, {
    client: OAuthClientInformationFull;
    params: AuthorizationParams;
    expiresAt: number;
  }>();

  constructor(
    private readonly cfg: {
      identityUrl: string;
      tokenTtlSec?: number;
    },
  ) {}

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
    <input id="pk-user" type="text" placeholder="Your user ID (e.g. markj)" autocomplete="username">
    <div style="display:flex;gap:.5em">
      <button onclick="passkeyLogin()" class="secondary" style="flex:1">Sign in</button>
      <button onclick="passkeyRegister()" style="flex:1">Register new</button>
    </div>
    <div id="pk-status" class="status"></div>
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
  const userId = document.getElementById('pk-user').value.trim();
  if (!userId) { setStatus('pk-status', 'Enter a user ID first.', 'err'); return; }
  try {
    setStatus('pk-status', 'Creating passkey...', 'info');
    const optRes = await fetch(IDENTITY + '/auth/webauthn/register-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, name: userId }),
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
    await submitProof('webauthn-register', { userId, response: resp });
  } catch (e) { setStatus('pk-status', e.message, 'err'); }
}

async function passkeyLogin() {
  const userId = document.getElementById('pk-user').value.trim();
  if (!userId) { setStatus('pk-status', 'Enter a user ID first.', 'err'); return; }
  try {
    setStatus('pk-status', 'Requesting challenge...', 'info');
    const chRes = await fetch(IDENTITY + '/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'webauthn-authenticate', userId }),
    });
    const ch = await chRes.json();
    if (!ch.nonce) throw new Error(ch.error || 'no challenge');

    const options = {
      challenge: b64urlToBytes(ch.nonce),
      allowCredentials: (ch.allowCredentials || []).map(c => ({ ...c, id: b64urlToBytes(c.id) })),
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
    await submitProof('webauthn-authenticate', { userId, response: resp });
  } catch (e) { setStatus('pk-status', e.message, 'err'); }
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
    if (c.clientId !== client.client_id) throw new Error('Client ID mismatch');
    if (redirectUri && c.redirectUri !== redirectUri) throw new Error('Redirect URI mismatch');
    if (c.expiresAt < Date.now()) throw new Error('Authorization code expired');

    const token = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    const expiresIn = this.cfg.tokenTtlSec ?? 3600;
    const refreshTtlSec = 14 * 24 * 3600; // 14 days
    this.accessTokens.set(token, {
      token,
      clientId: client.client_id,
      scopes: c.scopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      extra: {
        agentId: c.identity.agentId,
        ownerWebId: c.identity.ownerWebId,
        userId: c.identity.userId,
        identityToken: c.identity.identityToken,
      },
    });
    this.refreshTokens.set(refresh, {
      clientId: client.client_id,
      scopes: c.scopes,
      identity: c.identity,
      expiresAt: Date.now() + refreshTtlSec * 1000,
    });
    return {
      access_token: token,
      token_type: 'Bearer',
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
    const rec = this.refreshTokens.get(refreshToken);
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

    const token = randomBytes(32).toString('hex');
    const newRefresh = randomBytes(32).toString('hex');
    const expiresIn = this.cfg.tokenTtlSec ?? 3600;
    this.accessTokens.set(token, {
      token,
      clientId: client.client_id,
      scopes: finalScopes,
      expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
      extra: {
        agentId: rec.identity.agentId,
        ownerWebId: rec.identity.ownerWebId,
        userId: rec.identity.userId,
        identityToken: rec.identity.identityToken,
      },
    });
    this.refreshTokens.set(newRefresh, {
      clientId: client.client_id,
      scopes: finalScopes,
      identity: rec.identity,
      expiresAt: rec.expiresAt, // preserve original refresh TTL window
    });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: newRefresh,
      scope: finalScopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = this.accessTokens.get(token);
    if (!info) throw new Error('Invalid token');
    if (info.expiresAt && info.expiresAt * 1000 < Date.now()) {
      this.accessTokens.delete(token);
      throw new Error('Token expired');
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

