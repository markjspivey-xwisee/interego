/**
 * Mint a relay OAuth bearer from a wallet, headlessly, for the LIVE drivers in this directory.
 *
 * ★ THIS IS THE DESKTOP SHELL'S OWN SIGN-IN, MINUS THE SHELL. It registers a public OAuth
 * client, opens an authorization, signs the relay's SIWE message with a secp256k1 key and posts
 * the proof to `/oauth/verify`, then exchanges the code with PKCE — the same sequence
 * `desktop/src/auth.ts` runs. It is duplicated here for one reason: `auth.ts` imports nothing
 * from Electron but it lives in an Electron package whose `main` is a bundled CJS entry, and a
 * `tsx` driver importing across that boundary would be testing the bundler rather than the
 * relay. What it must NOT do is diverge, so `../tests/live-identity-parity.test.ts` runs both
 * ceremonies against one stand-in relay and identity server and pins what each sends, the signed
 * message included, byte for byte against the other. It compares the default statement only: the
 * desktop shell has no Hosted Terms path.
 *
 * The redirect URI is a loopback address that is never listened on: the wallet path posts its
 * own proof and reads the code out of the relay's redirect, so no browser and no socket are
 * involved. The relay still requires a registered `redirect_uri`, which is why one is supplied.
 *
 * ★ A NEW WALLET NEEDS ITS OPERATOR'S HOSTED TERMS AGREEMENT, AND NOTHING HERE GIVES IT ON THEIR
 * BEHALF. Since #778 hosted identity creates an account only for a wallet that signed the Hosted
 * Terms agreement statement, and answers any other first sign-in HTTP 428 `hosted_terms_required`.
 * Most drivers here sign a freshly generated wallet in, so each of them creates an account. The
 * agreement is the operator's to give: `mintBearer` takes it as `acceptHostedTermsVersion`, and
 * the drivers read it from {@link ACCEPT_HOSTED_TERMS_ENV} through
 * {@link mintBearerWithOperatorTerms}, for the wallets they generate and for no other. A key a
 * driver is handed (a file, an environment variable) signs in through plain `mintBearer`. Unset,
 * the ceremony is exactly the one it always was. The same opt-in, with the same guards, is
 * `openAgentSession`'s in `../src/agent-session.ts`.
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

/** The statement of an ordinary sign-in. */
const SIGN_IN_STATEMENT = 'Sign in to Interego';

/**
 * The SIWE message the relay expects. With the default statement it is byte-identical to
 * `desktop/src/auth.ts` (`../tests/live-identity-parity.test.ts` holds it there); the only other
 * statement ever passed is the Hosted Terms agreement identity returned for the version the
 * operator agreed to (see {@link mintBearer}).
 */
export function siweMessage(relay: string, address: string, nonce: string, issuedAt: string, statement = SIGN_IN_STATEMENT): string {
  return 'relay.interego.xwisee.com wants you to sign in with your Ethereum account:\n'
    + address + '\n\n' + statement + '\n\nURI: ' + relay + '\nVersion: 1\nChain ID: 1\n'
    + 'Nonce: ' + nonce + '\nIssued At: ' + issuedAt;
}

/** What a caller may add to the ceremony. An options bag, so it is not a sixth positional string. */
export interface MintBearerOptions {
  /**
   * The Hosted Terms version the OPERATOR of this process explicitly agreed to, for the account
   * this wallet signs in as.
   *
   * It is sent with the SIWE challenge request, and it is used only when identity offers that
   * exact version: identity then returns the agreement statement, and that statement is what the
   * wallet signs. It is only needed to create a NEW account. An existing account signs in without
   * it, and a version identity no longer offers falls back to the ordinary sign-in. Absent or
   * empty, nothing about the ceremony changes.
   *
   * ★ THIS MODULE NEVER AGREES ON ITS OWN. It does not fetch the terms, pick a version or default
   * this; agreeing is the operator's decision and has to arrive here from them.
   */
  readonly acceptHostedTermsVersion?: string;
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
  // `globalThis.fetch` to read it would leak into every later test in the same process.
  // Every existing caller omits this and gets the global `fetch`, unchanged.
  fetchImpl: typeof fetch = fetch,
  // ★ THE OPERATOR'S HOSTED TERMS AGREEMENT, AND ONLY AN EXPLICIT ONE. The Discord bot passes
  // nothing here: it signs in an account that already exists, and it must not start agreeing to
  // anything because some environment variable happens to be set where it runs.
  options: MintBearerOptions = {},
): Promise<RelayOAuthBearer> {
  const termsVersion = options.acceptHostedTermsVersion ?? '';
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

  const cres = await fetchImpl(identityServer + '/challenges', {
    method: 'POST', headers: json,
    body: JSON.stringify({ purpose: 'siwe', ...(termsVersion !== '' ? { termsVersion } : {}) }),
  });
  const { nonce, termsStatement } = await cres.json().catch(() => ({})) as { nonce?: string; termsStatement?: unknown };
  if (!nonce) throw new Error('the identity server issued no SIWE nonce (HTTP ' + cres.status + ')');
  // The nonce is a line of the signed message too, so it gets the identity server's own rule
  // (deploy/identity/siwe-message.ts NONCE): letters and digits only, at least eight.
  if (!/^[A-Za-z0-9]{8,}$/.test(nonce)) throw new Error('the identity server issued a nonce that is not 8+ letters or digits');
  // Identity returns `termsStatement` only when it offers exactly the version asked for. None back
  // is NOT an error: a stale version must still let an existing account sign in, and identity
  // then decides whether this wallet needs the agreement. A statement nobody asked for is never
  // signed: without the operator's version this is the ordinary sign-in, whatever the reply says.
  const statement = termsVersion !== '' && typeof termsStatement === 'string' && termsStatement !== ''
    ? termsStatement
    : SIGN_IN_STATEMENT;
  // The statement is one line of an ERC-4361 message; a line break in it would let identity's
  // text write the fields that follow it (URI, Nonce, ...) into what this wallet signs.
  if (/[\r\n]/.test(statement)) throw new Error('the identity server offered a terms statement containing a line break');

  const message = siweMessage(relay, wallet.address, nonce, new Date().toISOString(), statement);
  const signature = await wallet.signMessage(message);

  const vres = await fetchImpl(relay + '/oauth/verify', {
    method: 'POST', headers: json,
    body: JSON.stringify({ pending_id: pendingId, method: 'siwe', message, signature, nonce }),
  });
  const vj = await vres.json().catch(() => ({})) as { redirect?: string; error?: string; message?: string };
  const code = /[?&]code=([^&]+)/.exec(vj.redirect ?? '')?.[1];
  // Carry the status and the server's own words: a 428 `hosted_terms_required` read as "did not
  // accept this wallet proof" hides the one fact that says what to do.
  if (!code) throw new Error('SIWE verify answered HTTP ' + vres.status + ': ' + (vj.error ?? vj.message ?? 'no error given'));

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

/**
 * THE ENVIRONMENT VARIABLE THROUGH WHICH THE OPERATOR OF A LIVE DRIVER AGREES TO THE HOSTED TERMS.
 *
 * Its value is a Hosted Terms version (`YYYY-MM-DD` or `YYYY-MM-DD-rN`). Identity publishes the
 * version it offers, and the terms it names, at `<identity>/.well-known/hosted-interego-terms`;
 * setting this says the operator read those terms and agrees to them for every account the run
 * creates. Nothing in this repository sets it, and no driver reads that endpoint to fill it in.
 * It reaches only the wallets a driver generates: see {@link mintBearerWithOperatorTerms}.
 */
export const ACCEPT_HOSTED_TERMS_ENV = 'INTEREGO_ACCEPT_HOSTED_TERMS_VERSION';

/** The operator's agreement as the environment states it: `{}` when it states none. */
export function operatorHostedTerms(env: Readonly<Record<string, string | undefined>> = process.env): MintBearerOptions {
  const version = (env[ACCEPT_HOSTED_TERMS_ENV] ?? '').trim();
  return version === '' ? {} : { acceptHostedTermsVersion: version };
}

/**
 * {@link mintBearer} for a wallet a live driver GENERATED this run, with the operator's Hosted
 * Terms agreement read from {@link ACCEPT_HOSTED_TERMS_ENV} when (and only when) it is set.
 *
 * ★ ONLY FOR A GENERATED WALLET. Nothing here can tell a wallet with an account from one without,
 * so with the variable at the version identity offers, EVERY wallet passed in signs the agreement
 * statement, one that already holds an account included. The operator agreed for the accounts the
 * run creates, and a key the driver was handed is not one of them: the maintainer's key, a
 * deployed service's key, a key saved by an earlier run. Those sign in through plain
 * {@link mintBearer}, so a driver whose parties mix a handed key and generated ones calls both.
 *
 * ★ A REFUSAL SAYS WHAT TO DO. A 428 here is a wallet with no account and no agreement, and the
 * person who can fix it is the one running the driver, so the error names the variable and where
 * the current version is published. It does not retry with that version: that would be agreeing.
 */
export async function mintBearerWithOperatorTerms(
  relay: string, identityServer: string, wallet: Signer,
  clientName?: string,
  seams: { readonly fetchImpl?: typeof fetch; readonly env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<RelayOAuthBearer> {
  const options = operatorHostedTerms(seams.env);
  try {
    return await mintBearer(relay, identityServer, wallet, clientName, seams.fetchImpl, options);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.startsWith('SIWE verify answered HTTP 428:')) throw e;
    const where = identityServer + '/.well-known/hosted-interego-terms';
    throw new Error(msg + (options.acceptHostedTermsVersion === undefined
      ? ' (this wallet has no account yet, and creating one needs the Hosted Terms agreement. Read the version and terms at '
        + where + ' and, only if you agree to them for the accounts this run creates, set ' + ACCEPT_HOSTED_TERMS_ENV + '=<that version>)'
      : ' (' + ACCEPT_HOSTED_TERMS_ENV + ' is ' + options.acceptHostedTermsVersion
        + ', and identity did not take it as agreement for a new account; the version it offers now is at ' + where + ')'), { cause: e });
  }
}
