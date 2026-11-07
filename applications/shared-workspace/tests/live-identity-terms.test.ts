/**
 * The live drivers' sign-in answers the Hosted Terms offer only when the operator said so, and a
 * refusal reaches the person running the driver in identity's own words.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. `mintBearer` in `tools/live-identity.ts` is the sign-in of
 * every live driver in this vertical, of the root `tools/*-live.ts` probes, and of the Discord
 * bot. Since hosted identity began requiring the Hosted Terms agreement for a NEW account (HTTP
 * 428 `hosted_terms_required`), every driver that generates a fresh wallet could not sign in at
 * all, and the refusal read "the relay did not accept this wallet proof", without the status.
 * There was no way to give the agreement short of editing the helper.
 *
 * ★ THE FAKE IS THE IDENTITY CONTRACT, NOT A CONVENIENCE, and it is the one
 * `agent-session-terms.test.ts` already holds `openAgentSession` to: `/challenges` returns
 * `termsStatement` only when the body's `termsVersion` is exactly the version on offer; an UNKNOWN
 * wallet is admitted only when it signed that exact statement on a challenge that carried that
 * version; a KNOWN wallet signs in whatever statement it signed. The signer is recovered from the
 * signature (`verifyMessage`), not read from the message, so a case cannot pass by naming an
 * address it does not hold. The relay's `/oauth/verify` forwards identity's status and `error`
 * unchanged, which is what the 428 here stands for.
 *
 * ★ THE HTTP IS INJECTED. `mintBearer` takes its `fetch` as a parameter, so nothing here patches
 * `globalThis.fetch`, and the environment the driver entry point reads is injected too.
 */

import { describe, expect, it } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import {
  ACCEPT_HOSTED_TERMS_ENV,
  mintBearer,
  mintBearerWithOperatorTerms,
  operatorHostedTerms,
  siweMessage,
  type Signer,
} from '../tools/live-identity.js';

const RELAY = 'https://relay.example';
const IDENTITY = 'https://identity.example';
const CURRENT = '2026-11-06-r2';
const STALE = '2026-10-01';
const TERMS_STATEMENT = `I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/${CURRENT}/`;
const TERMS_REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';

interface Challenge { readonly termsVersion?: string }
interface Fleet {
  readonly impl: typeof fetch;
  /** Every `/challenges` request body, in order. */
  readonly challengeBodies: Array<Record<string, unknown>>;
  /** Every `/challenges` reply's `termsStatement` (undefined when none was offered), in order. */
  readonly offered: Array<string | undefined>;
  /** Every message that reached `/oauth/verify`, in order. */
  readonly signedMessages: string[];
  /** The statement line of every message that reached `/oauth/verify`, in order. */
  readonly signedStatements: string[];
  /** Lowercased addresses that hold an account. */
  readonly accounts: Set<string>;
  /** Bearers the token endpoint issued, in order. */
  readonly issued: string[];
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The relay and identity server as far as `mintBearer` reaches them. `known` seeds wallets that
 * already hold an account. `volunteer` makes `/challenges` return that statement whatever was
 * asked, and `nonce` replaces the issued nonce: both stand for a server that misbehaves.
 */
function fleet(opts: { known?: readonly string[]; volunteer?: string; nonce?: string } = {}): Fleet {
  const challengeBodies: Array<Record<string, unknown>> = [];
  const offered: Array<string | undefined> = [];
  const signedMessages: string[] = [];
  const signedStatements: string[] = [];
  const accounts = new Set((opts.known ?? []).map(a => a.toLowerCase()));
  const issued: string[] = [];
  const challenges = new Map<string, Challenge>();
  /** Authorization code -> the account it was issued to. */
  const codes = new Map<string, string>();
  let serial = 0;

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    // JSON bodies arrive as strings; the token request's form body as URLSearchParams.
    const raw = typeof init?.body === 'string' || init?.body instanceof URLSearchParams ? String(init.body) : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {};

    if (url === `${RELAY}/register`) return json(201, { client_id: 'client-1' });
    if (url.startsWith(`${RELAY}/authorize?`)) {
      return new Response('<script>\nconst PENDING_ID = \'p1\';\n</script>', {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }

    if (url === `${IDENTITY}/challenges`) {
      challengeBodies.push(body);
      expect(body['purpose']).toBe('siwe');
      const nonce = opts.nonce ?? `nonce${String(++serial).padStart(8, '0')}`;
      const accepted = body['termsVersion'] === CURRENT;
      challenges.set(nonce, accepted ? { termsVersion: CURRENT } : {});
      const statement = opts.volunteer ?? (accepted ? TERMS_STATEMENT : undefined);
      offered.push(statement);
      return json(200, {
        nonce,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        ...(statement !== undefined ? { termsStatement: statement } : {}),
      });
    }

    if (url === `${RELAY}/oauth/verify`) {
      expect(body['pending_id']).toBe('p1');
      expect(body['method']).toBe('siwe');
      const message = String(body['message']);
      const nonce = String(body['nonce']);
      const challenge = challenges.get(nonce);
      if (!challenge) return json(401, { error: 'Unknown or expired nonce' });
      challenges.delete(nonce);
      signedMessages.push(message);
      const lines = message.split('\n');
      // ERC-4361: domain line, address, blank, statement, blank, then the fields.
      expect(lines[0]).toMatch(/^\S+ wants you to sign in with your Ethereum account:$/);
      expect(lines[2]).toBe('');
      expect(lines[4]).toBe('');
      expect(lines[5]).toBe(`URI: ${RELAY}`);
      expect(lines).toContain(`Nonce: ${nonce}`);
      const signer = verifyMessage(message, String(body['signature']));
      if (signer !== lines[1]) return json(401, { error: 'SIWE signature does not match the address' });
      const statement = lines[3]!;
      signedStatements.push(statement);
      const account = signer.toLowerCase();
      if (!accounts.has(account)) {
        const agreed = statement === TERMS_STATEMENT && challenge.termsVersion === CURRENT;
        if (!agreed) return json(428, { error: TERMS_REFUSAL });
        accounts.add(account);
      }
      codes.set('c', account);
      return json(200, { redirect: 'http://127.0.0.1:1/callback?code=c' });
    }

    if (url === `${RELAY}/token`) {
      const form = new URLSearchParams(raw);
      if (!codes.has(form.get('code') ?? '')) return json(400, { error: 'invalid_grant' });
      codes.delete(form.get('code') ?? '');
      const token = `access-${++serial}`;
      issued.push(token);
      return json(200, { access_token: token, refresh_token: `refresh-${serial}`, token_type: 'Bearer', expires_in: 3600 });
    }

    throw new Error(`this test scripted no answer for ${url}`);
  }) as typeof fetch;

  return { impl, challengeBodies, offered, signedMessages, signedStatements, accounts, issued };
}

/** `mintBearer` exactly as a caller that passes its own HTTP calls it, with or without the agreement. */
const mint = (wallet: Signer, f: Fleet, acceptHostedTermsVersion?: string) =>
  mintBearer(RELAY, IDENTITY, wallet, undefined, f.impl,
    acceptHostedTermsVersion !== undefined ? { acceptHostedTermsVersion } : undefined);

describe('mintBearer and the Hosted Terms offer', () => {
  it('(i) a new wallet without the operator\'s agreement is refused, and the refusal says HTTP 428 and why', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet();

    const minted = mint(wallet, f);
    await expect(minted).rejects.toThrow(`SIWE verify answered HTTP 428: ${TERMS_REFUSAL}`);

    // Nothing agreed on the operator's behalf: no version asked for, the ordinary statement
    // signed, and no account created.
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(f.signedStatements).toEqual(['Sign in to Interego']);
    expect(f.accounts.has(wallet.address.toLowerCase())).toBe(false);
    expect(f.issued).toEqual([]);
  });

  it('(ii) a new wallet whose operator agreed to the offered version signs exactly the statement identity returned', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet();

    const bearer = await mint(wallet, f, CURRENT);

    expect(f.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: CURRENT }]);
    expect(f.offered).toEqual([TERMS_STATEMENT]);
    expect(f.signedStatements).toEqual([f.offered[0]]);
    expect(f.accounts.has(wallet.address.toLowerCase())).toBe(true);
    expect(bearer.accessToken).toBe(f.issued[0]);
    expect(bearer.method).toBe('siwe');
  });

  it('(iii) a returning wallet with a stale version signs in with the ordinary statement', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet({ known: [wallet.address] });

    const bearer = await mint(wallet, f, STALE);

    expect(f.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: STALE }]);
    expect(f.offered).toEqual([undefined]);
    expect(f.signedStatements).toEqual(['Sign in to Interego']);
    expect(bearer.accessToken).toBe(f.issued[0]);
  });

  it('(iv) a returning wallet without the option signs in exactly as before, message byte for byte', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet({ known: [wallet.address] });

    const bearer = await mint(wallet, f);

    expect(f.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(f.signedStatements).toEqual(['Sign in to Interego']);
    // The whole message is the four-argument `siweMessage` it always was: same domain line, same
    // statement, same fields, so nothing about an existing caller's sign-in moved.
    const signed = f.signedMessages[0]!;
    const nonce = /\nNonce: (\S+)\n/.exec(signed)?.[1] ?? '';
    const issuedAt = /\nIssued At: (\S+)$/.exec(signed)?.[1] ?? '';
    expect(signed).toBe(siweMessage(RELAY, wallet.address, nonce, issuedAt));
    expect(bearer.accessToken).toBe(f.issued[0]);
  });

  it('(v) a statement identity volunteers without being asked is never signed', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet({ known: [wallet.address], volunteer: TERMS_STATEMENT });

    await mint(wallet, f);

    expect(f.offered).toEqual([TERMS_STATEMENT]);
    expect(f.signedStatements).toEqual(['Sign in to Interego']);
  });

  it('(vi) an offered statement with a line break is refused before anything is signed or sent', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet({ volunteer: `${TERMS_STATEMENT}\nURI: https://elsewhere.example` });

    await expect(mint(wallet, f, CURRENT)).rejects.toThrow(/line break/);
    expect(f.signedMessages).toEqual([]);
  });

  it('(vii) a nonce outside identity\'s own form is refused before anything is signed or sent', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet({ known: [wallet.address], nonce: 'abc12345\nURI: https://elsewhere.example' });

    await expect(mint(wallet, f)).rejects.toThrow(/nonce/);
    expect(f.signedMessages).toEqual([]);
  });
});

describe('the drivers\' opt-in: INTEREGO_ACCEPT_HOSTED_TERMS_VERSION', () => {
  it('is the variable the READMEs and the driver headers name', () => {
    expect(ACCEPT_HOSTED_TERMS_ENV).toBe('INTEREGO_ACCEPT_HOSTED_TERMS_VERSION');
  });

  it('reads an agreement only from a non-blank value, and never invents one', () => {
    expect(operatorHostedTerms({})).toEqual({});
    expect(operatorHostedTerms({ [ACCEPT_HOSTED_TERMS_ENV]: '' })).toEqual({});
    expect(operatorHostedTerms({ [ACCEPT_HOSTED_TERMS_ENV]: '  \n' })).toEqual({});
    expect(operatorHostedTerms({ [ACCEPT_HOSTED_TERMS_ENV]: ` ${CURRENT}\n` })).toEqual({ acceptHostedTermsVersion: CURRENT });
  });

  it('unset: a fresh wallet is refused, and the refusal names the variable and where the version is published', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet();

    const minted = mintBearerWithOperatorTerms(RELAY, IDENTITY, wallet, undefined, { fetchImpl: f.impl, env: {} });
    await expect(minted).rejects.toThrow(`SIWE verify answered HTTP 428: ${TERMS_REFUSAL}`);
    await expect(minted).rejects.toThrow(`${IDENTITY}/.well-known/hosted-interego-terms`);
    await expect(minted).rejects.toThrow(`set ${ACCEPT_HOSTED_TERMS_ENV}=<that version>`);
    // It did not go and agree after being refused: one ceremony, ordinary statement, no account.
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(f.accounts.has(wallet.address.toLowerCase())).toBe(false);
  });

  it('set to the offered version: a fresh wallet creates its account by signing the returned statement', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet();

    const bearer = await mintBearerWithOperatorTerms(RELAY, IDENTITY, wallet, undefined,
      { fetchImpl: f.impl, env: { [ACCEPT_HOSTED_TERMS_ENV]: CURRENT } });

    expect(f.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: CURRENT }]);
    expect(f.signedStatements).toEqual([TERMS_STATEMENT]);
    expect(f.accounts.has(wallet.address.toLowerCase())).toBe(true);
    expect(bearer.accessToken).toBe(f.issued[0]);
  });

  it('set to a version identity no longer offers: refused, and the refusal says the variable\'s version was not taken', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet();

    const minted = mintBearerWithOperatorTerms(RELAY, IDENTITY, wallet, undefined,
      { fetchImpl: f.impl, env: { [ACCEPT_HOSTED_TERMS_ENV]: STALE } });
    await expect(minted).rejects.toThrow(`SIWE verify answered HTTP 428: ${TERMS_REFUSAL}`);
    await expect(minted).rejects.toThrow(`${ACCEPT_HOSTED_TERMS_ENV} is ${STALE}`);
    expect(f.signedStatements).toEqual(['Sign in to Interego']);
  });

  it('a fixed key that already holds an account signs in the same with or without the variable', async () => {
    const wallet = Wallet.createRandom();
    const f = fleet({ known: [wallet.address] });

    await mintBearerWithOperatorTerms(RELAY, IDENTITY, wallet, undefined, { fetchImpl: f.impl, env: {} });
    await mintBearerWithOperatorTerms(RELAY, IDENTITY, wallet, undefined,
      { fetchImpl: f.impl, env: { [ACCEPT_HOSTED_TERMS_ENV]: STALE } });

    expect(f.signedStatements).toEqual(['Sign in to Interego', 'Sign in to Interego']);
    expect(f.issued).toHaveLength(2);
  });
});
