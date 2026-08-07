/**
 * The two auth paths, and why they are two.
 *
 * ★ MEASURED AGAINST THE LIVE RELAY, 2026-08-06. Both paths end at the SAME credential — an
 * OAuth bearer minted by the relay's own authorization server at `POST /token` — because SIWE
 * and WebAuthn are two ways of satisfying `POST /oauth/verify` for one pending authorization,
 * not two token types. What differs is which pod the relay provisions:
 *
 *   SIWE (wallet)     -> pod u-eth-8f3b8e939600
 *   WebAuthn (passkey)-> pod u-pk-1d88635fe1cf
 *
 * and that difference is exactly why a picker is worth having: the identity a user signs in
 * with decides which pod their words land on, permanently.
 *
 * ★ THE GOTCHA THAT COST A SESSION. The WebAuthn ceremony's `clientDataJSON.origin` must be
 * `https://identity.interego.xwisee.com` — the IDENTITY server — not the relay, even though
 * the proof is submitted to the relay's `/oauth/verify`. A ceremony run with the relay's
 * origin is rejected. This is the whole reason the passkey path here delegates to a BROWSER
 * rather than doing the ceremony in-process: a browser window loaded from the identity
 * server's own origin gets the origin right by construction, and the platform authenticator
 * (Windows Hello) is real rather than a soft key this process generated.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RelayOAuthBearer } from '@interego/workspace-client';

const b64u = (b: Buffer): string => b.toString('base64url');

/** Which sign-in the user picked. Both mint a relay OAuth bearer; see the header. */
export type AuthMethod =
  /** A secp256k1 key this app holds, in the OS secret store. No browser, no user gesture. */
  | 'wallet'
  /**
   * The relay's own sign-in page in the system browser, over a loopback redirect (RFC 8252).
   * Covers passkey / WebAuthn — and it is the only way to get a real platform authenticator,
   * because the ceremony has to run at the identity server's origin.
   */
  | 'browser';

/** A registered OAuth client plus the PKCE material for one authorization. */
export interface PendingAuthorization {
  readonly clientId: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly redirectUri: string;
  readonly authorizeUrl: string;
  /**
   * The relay's own id for this pending sign-in, scraped from the authorize page.
   *
   * Needed only by the wallet path, which submits its proof to `/oauth/verify` directly
   * instead of letting a browser do it. Null when the page did not carry one — which is a
   * fact worth keeping rather than a reason to throw, because the browser path does not need
   * it and would otherwise fail for a reason that has nothing to do with it.
   */
  readonly pendingId: string | null;
}

const json = { 'Content-Type': 'application/json' } as const;

/**
 * Register a client and open an authorization, returning everything both paths need.
 *
 * The client is registered per run rather than baked in: this app has no client secret to
 * protect (`token_endpoint_auth_method: 'none'`), and a public client id shipped in a desktop
 * binary is a public client id either way. PKCE is what actually binds the code to this
 * process.
 */
export async function beginAuthorization(relay: string, clientName: string, redirectUri: string): Promise<PendingAuthorization> {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const regRes = await fetch(relay + '/register', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!regRes.ok) throw new Error('dynamic client registration failed: HTTP ' + regRes.status + ' ' + (await regRes.text()).slice(0, 200));
  const client = await regRes.json() as { client_id?: string };
  if (!client.client_id) throw new Error('dynamic client registration returned no client_id');

  const authorizeUrl = relay + '/authorize?response_type=code'
    + '&client_id=' + encodeURIComponent(client.client_id)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&code_challenge=' + challenge
    + '&code_challenge_method=S256&scope=mcp&state=' + b64u(randomBytes(9))
    + '&resource=' + encodeURIComponent(relay + '/');

  const page = await (await fetch(authorizeUrl)).text();
  const pendingId = /const PENDING_ID\s*=\s*['"]([^'"]+)/.exec(page)?.[1] ?? null;
  return { clientId: client.client_id, verifier, challenge, redirectUri, authorizeUrl, pendingId };
}

/** What `/token` answers with, for either grant type. */
interface TokenGrant {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Turn a `/token` body into a bearer, or throw with the relay's own words. */
function asBearer(tj: TokenGrant, method: RelayOAuthBearer['method'], clientId: string): RelayOAuthBearer {
  if (!tj.access_token) {
    throw new Error('the token endpoint returned no access_token: ' + (tj.error_description ?? tj.error ?? JSON.stringify(tj).slice(0, 200)));
  }
  return {
    kind: 'relay-oauth-bearer',
    accessToken: tj.access_token,
    method,
    // Absence is not evidence: a grant that reported no lifetime gets `null`, not a guessed
    // one. A client that invented an hour would keep using a token the relay had dropped and
    // report the 401 as an outage.
    expiresAt: typeof tj.expires_in === 'number' ? Date.now() + tj.expires_in * 1000 : null,
    refreshToken: tj.refresh_token ?? null,
    clientId,
  };
}

/** Exchange an authorization code for a bearer. PKCE verifier is what proves it is ours. */
export async function exchangeCode(relay: string, p: PendingAuthorization, code: string, method: RelayOAuthBearer['method']): Promise<RelayOAuthBearer> {
  const res = await fetch(relay + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: p.redirectUri,
      client_id: p.clientId,
      code_verifier: p.verifier,
      resource: relay + '/',
    }),
  });
  return asBearer(await res.json() as TokenGrant, method, p.clientId);
}

/**
 * Renew a bearer with no user present.
 *
 * ★ THE SUCCESSOR IS CARRIED FORWARD BECAUSE THE RELAY ROTATES IT. Measured 2026-08-06:
 * exchanging a refresh token returns a NEW one and refuses the old one afterwards with
 * `400 invalid_grant`. A shell that renewed and kept its original token would work for exactly
 * one more hour and then fail, unattended, in the middle of somebody's session — which is the
 * failure that is hardest to notice and worst to meet. The bearer this returns therefore
 * carries the new refresh token, and the caller must replace the whole credential, not just its
 * access token.
 *
 * ★ AND A FAILED RENEWAL IS SAID OUT LOUD RATHER THAN LEAVING AN EMPTY WORKSPACE. This throws,
 * and `main.ts` turns the throw into a session state the renderer renders — because a client
 * whose token lapsed and which then shows a workspace with nothing in it has told the user
 * their workspace is empty.
 */
export async function refreshBearer(relay: string, bearer: RelayOAuthBearer): Promise<RelayOAuthBearer> {
  if (!bearer.refreshToken || !bearer.clientId) {
    throw new Error('this grant carried no refresh token' + (bearer.clientId ? '' : ' and no client id')
      + ', so it cannot be renewed without signing in again. That is what the relay returned, not an assumption about it.');
  }
  const res = await fetch(relay + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: bearer.refreshToken,
      client_id: bearer.clientId,
      resource: relay + '/',
    }),
  });
  const tj = await res.json() as TokenGrant;
  if (!tj.access_token) {
    throw new Error('the relay refused to renew this session (HTTP ' + res.status + '): '
      + (tj.error_description ?? tj.error ?? JSON.stringify(tj).slice(0, 200)));
  }
  const next = asBearer(tj, bearer.method, bearer.clientId);
  // A grant that renewed without returning a successor cannot be renewed AGAIN. Keeping the
  // spent one would be worse than keeping none: it would look renewable and fail in an hour.
  return tj.refresh_token ? next : { ...next, refreshToken: null };
}

/**
 * PATH 1 — the wallet this app holds.
 *
 * The private key never leaves the main process and is stored encrypted by the OS (see
 * `secrets.ts`). Nothing is written to the repo and nothing is written in plaintext.
 *
 * `signMessage` is injected rather than importing ethers here, so this module stays testable
 * and so the one place that touches a private key is the one place that holds it.
 *
 * ★ `clientName` IS A PARAMETER, AND THAT IS NOT COSMETIC. MEASURED against the live relay: the
 * agent DID it issues is `did:web:<identity host>:agents:<client_name>-<pod>`, so the OAuth client
 * name is INSIDE the identity. The person signs in under this app's name; a DELEGATE signs in
 * under `DELEGATE_SURFACE`, one constant shared by every host, so the same delegate key is the
 * same delegate whichever app is running it. Hardcoding this app's name here would have minted a
 * different delegate per application, which is the opposite of what a delegate is.
 */
export const DESKTOP_CLIENT_NAME = 'interego-workspace-desktop';

export async function signInWithWallet(
  relay: string,
  identityServer: string,
  address: string,
  signMessage: (message: string) => Promise<string>,
  redirectUri: string,
  clientName: string = DESKTOP_CLIENT_NAME,
): Promise<RelayOAuthBearer> {
  const p = await beginAuthorization(relay, clientName, redirectUri);
  if (!p.pendingId) throw new Error('the relay\'s authorize page carried no PENDING_ID, so this sign-in has nothing to attach a wallet proof to');

  const nonceRes = await fetch(identityServer + '/challenges', {
    method: 'POST', headers: json, body: JSON.stringify({ purpose: 'siwe' }),
  });
  const { nonce } = await nonceRes.json() as { nonce?: string };
  if (!nonce) throw new Error('the identity server issued no SIWE nonce');

  // The message is built to the relay's own expectations — host, URI and statement included —
  // because a SIWE message is only as good as what it commits to. Signing a bare nonce would
  // let the same signature be replayed at any other verifier that asked for one.
  const message = 'relay.interego.xwisee.com wants you to sign in with your Ethereum account:\n'
    + address + '\n\nSign in to Interego\n\nURI: ' + relay + '\nVersion: 1\nChain ID: 1\n'
    + 'Nonce: ' + nonce + '\nIssued At: ' + new Date().toISOString();
  const signature = await signMessage(message);

  const vres = await fetch(relay + '/oauth/verify', {
    method: 'POST', headers: json,
    body: JSON.stringify({ pending_id: p.pendingId, method: 'siwe', message, signature, nonce }),
  });
  const vj = await vres.json() as { redirect?: string; error?: string; message?: string };
  const code = /[?&]code=([^&]+)/.exec(vj.redirect ?? '')?.[1];
  if (!code) throw new Error('the relay did not accept this wallet proof: ' + (vj.message ?? vj.error ?? JSON.stringify(vj).slice(0, 200)));
  return exchangeCode(relay, p, code, 'siwe');
}

/**
 * PATH 2 — the relay's own sign-in page in the system browser, code returned over loopback.
 *
 * ★ LOOPBACK, NOT A CUSTOM SCHEME, AND NOT AN EMBEDDED WEBVIEW. RFC 8252 §7.3: an embedded
 * webview lets the app read the user's credentials, which defeats the point of delegating the
 * ceremony; a custom scheme can be claimed by another installed program. A loopback listener
 * on an OS-assigned port can only be reached from this machine, and PKCE binds the code to
 * this process even if something else on the machine sees it.
 *
 * The listener binds 127.0.0.1 explicitly rather than all interfaces, so nothing off-machine
 * can reach it at all.
 */
export interface LoopbackReceiver {
  readonly redirectUri: string;
  /** Resolves with the authorization code, or rejects on timeout / an error redirect. */
  readonly code: Promise<string>;
  close(): void;
}

export async function startLoopbackReceiver(timeoutMs = 300_000): Promise<LoopbackReceiver> {
  let resolveCode: (c: string) => void = () => {};
  let rejectCode: (e: Error) => void = () => {};
  const code = new Promise<string>((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end('not here'); return; }
    const got = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>Interego</title>'
      + '<body style="font:15px system-ui;padding:40px;max-width:32em">'
      + (got
        ? '<h2>Signed in.</h2><p>You can close this tab and go back to the workspace app.</p>'
        : '<h2>Sign-in did not complete.</h2><p>' + (err ? String(err).replace(/[<&]/g, '') : 'The relay redirected here without an authorization code.') + '</p>')
      + '</body>');
    if (got) resolveCode(got);
    else rejectCode(new Error('the relay redirected to the loopback receiver without a code' + (err ? ': ' + err : '')));
  });

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    // Port 0: the OS picks a free one. A fixed port collides with anything else on the
    // machine and, worse, is guessable by anything else on the machine.
    server.listen(0, '127.0.0.1', res);
  });
  const port = (server.address() as AddressInfo).port;

  const timer = setTimeout(() => rejectCode(new Error('sign-in was not completed within ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs);
  const close = (): void => { clearTimeout(timer); server.close(); };
  void code.then(close, close);

  return { redirectUri: 'http://127.0.0.1:' + port + '/callback', code, close };
}
