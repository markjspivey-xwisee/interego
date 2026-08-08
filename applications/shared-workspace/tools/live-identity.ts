/**
 * Mint a relay OAuth bearer from a wallet, headlessly, for the LIVE drivers in this directory.
 *
 * ★ THIS IS THE DESKTOP SHELL'S OWN SIGN-IN, MINUS THE SHELL. It registers a public OAuth
 * client, opens an authorization, signs the relay's SIWE message with a secp256k1 key and posts
 * the proof to `/oauth/verify`, then exchanges the code with PKCE — the same sequence
 * `desktop/src/auth.ts` runs. It is duplicated here for one reason: `auth.ts` imports nothing
 * from Electron but it lives in an Electron package whose `main` is a bundled CJS entry, and a
 * `tsx` driver importing across that boundary would be testing the bundler rather than the
 * relay. What it must NOT do is diverge, so `tests/workspace-live-identity-parity.test.ts` pins
 * the two message bodies against each other.
 *
 * The redirect URI is a loopback address that is never listened on: the wallet path posts its
 * own proof and reads the code out of the relay's redirect, so no browser and no socket are
 * involved. The relay still requires a registered `redirect_uri`, which is why one is supplied.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { RelayOAuthBearer } from '@interego/workspace-client';

/**
 * The two things a signer has to be able to do, and nothing else.
 *
 * Structural rather than `ethers.Wallet`, because `Wallet.createRandom()` returns an
 * `HDNodeWallet` — a different nominal type with the same shape — and a driver that typed this
 * as `Wallet` could not be handed a freshly minted identity, which is exactly what the
 * second-party runs need.
 */
export interface Signer {
  readonly address: string;
  signMessage(message: string): Promise<string>;
}

const b64u = (b: Buffer): string => b.toString('base64url');
const json = { 'Content-Type': 'application/json' } as const;

/** The SIWE message the relay expects. Kept byte-identical to `desktop/src/auth.ts`. */
export function siweMessage(relay: string, address: string, nonce: string, issuedAt: string): string {
  return 'relay.interego.xwisee.com wants you to sign in with your Ethereum account:\n'
    + address + '\n\nSign in to Interego\n\nURI: ' + relay + '\nVersion: 1\nChain ID: 1\n'
    + 'Nonce: ' + nonce + '\nIssued At: ' + issuedAt;
}

/**
 * Register a client, open an authorization, sign, verify, exchange. Returns the bearer.
 *
 * ★ `clientName` IS A PARAMETER FOR THE REASON `auth.ts` MEASURES: the relay puts the OAuth
 * client name inside the agent DID it issues. A driver signing a DELEGATE key in has to use
 * `DELEGATE_SURFACE`, or it would be exercising a different identity from the one the desktop
 * app would produce from the same key — which is precisely the property the drive exists to check.
 */
export async function mintBearer(
  relay: string, identityServer: string, wallet: Signer,
  clientName = 'interego-workspace-live-driver',
  // ★ THE HTTP IS A PARAMETER SO THE CLIENT NAME CAN BE OBSERVED WITHOUT A GLOBAL PATCH. The
  // Discord bot is a LONG-LIVED identity whose DID contains `clientName` (see
  // `discord/src/identity.ts`), so "did this caller pass its own name?" is worth a test — and
  // the only place that question is answerable is the `/register` body below. Patching
  // `globalThis.fetch` to read it would leak across the shared vitest realm. Every existing
  // caller omits this and gets the global `fetch`, unchanged.
  fetchImpl: typeof fetch = fetch,
): Promise<RelayOAuthBearer> {
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const redirectUri = 'http://127.0.0.1:1/callback';

  const reg = await fetchImpl(relay + '/register', {
    method: 'POST', headers: json,
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!reg.ok) throw new Error('client registration failed: HTTP ' + reg.status + ' ' + (await reg.text()).slice(0, 200));
  const { client_id: clientId } = await reg.json() as { client_id?: string };
  if (!clientId) throw new Error('client registration returned no client_id');

  const authorizeUrl = relay + '/authorize?response_type=code'
    + '&client_id=' + encodeURIComponent(clientId)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&code_challenge=' + challenge
    + '&code_challenge_method=S256&scope=mcp&state=' + b64u(randomBytes(9))
    + '&resource=' + encodeURIComponent(relay + '/');
  const page = await (await fetchImpl(authorizeUrl)).text();
  const pendingId = /const PENDING_ID\s*=\s*['"]([^'"]+)/.exec(page)?.[1];
  if (!pendingId) throw new Error('the relay\'s authorize page carried no PENDING_ID');

  const { nonce } = await (await fetchImpl(identityServer + '/challenges', {
    method: 'POST', headers: json, body: JSON.stringify({ purpose: 'siwe' }),
  })).json() as { nonce?: string };
  if (!nonce) throw new Error('the identity server issued no SIWE nonce');

  const message = siweMessage(relay, wallet.address, nonce, new Date().toISOString());
  const signature = await wallet.signMessage(message);

  const vres = await fetchImpl(relay + '/oauth/verify', {
    method: 'POST', headers: json,
    body: JSON.stringify({ pending_id: pendingId, method: 'siwe', message, signature, nonce }),
  });
  const vj = await vres.json() as { redirect?: string; error?: string; message?: string };
  const code = /[?&]code=([^&]+)/.exec(vj.redirect ?? '')?.[1];
  if (!code) throw new Error('the relay did not accept this wallet proof: ' + (vj.message ?? vj.error ?? JSON.stringify(vj).slice(0, 200)));

  const tres = await fetchImpl(relay + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri,
      client_id: clientId, code_verifier: verifier, resource: relay + '/',
    }),
  });
  const tj = await tres.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!tj.access_token) throw new Error('the token endpoint returned no access_token: ' + (tj.error_description ?? tj.error ?? JSON.stringify(tj).slice(0, 200)));
  return {
    kind: 'relay-oauth-bearer',
    accessToken: tj.access_token,
    method: 'siwe',
    // Absence is not evidence: a grant that reported no lifetime gets null, not a guessed one.
    expiresAt: typeof tj.expires_in === 'number' ? Date.now() + tj.expires_in * 1000 : null,
    // Carried even though these drivers finish inside the hour: dropping the successor is the
    // one mistake that only shows up an hour later, and a driver that models the shell wrongly
    // is a driver whose green result means less than it looks like it does.
    refreshToken: tj.refresh_token ?? null,
    clientId,
  };
}
