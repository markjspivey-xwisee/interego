/**
 * The desktop app's wallet sign-in answers the Hosted Terms offer only with the person's own
 * tick, and a refusal reaches the window in the server's words.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. Since hosted identity began requiring the Hosted Interego
 * Terms for a NEW account (HTTP 428 `hosted_terms_required`), `signInWithWallet` with a key the
 * server had never seen could not sign in at all — the app's first-run path (mint a key, sign in)
 * among them — and it reported "the relay did not accept this wallet proof", dropping the status
 * that said what was wrong. It had no way to carry an agreement, and must never invent one.
 *
 * ★ THE FAKE IS THE IDENTITY CONTRACT, as `deploy/identity/server.ts` implements it for SIWE:
 * `/challenges` returns `termsStatement` only when the body's `termsVersion` is exactly the version
 * on offer; an UNKNOWN wallet is admitted only when it signed that exact statement on a challenge
 * that carried that version; a KNOWN wallet signs in with the ordinary statement whatever it asked
 * for. The signer is recovered from the signature, so a case cannot pass by naming an address it
 * does not hold. The relay's `/oauth/verify` forwards identity's status and `error` unchanged.
 *
 * The HTTP is injected (`fetchImpl`), so nothing global is patched.
 */

import { describe, expect, it } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import { ORDINARY_SIWE_STATEMENT, readHostedTerms, signInWithWallet } from '../desktop/src/auth.js';

const RELAY = 'https://relay.interego.xwisee.com';
const IDENTITY = 'https://identity.example';
const CURRENT = '2026-11-06-r2';
const STALE = '2026-10-01';
const STATEMENT = `I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/${CURRENT}/`;
const REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';
const REDIRECT = 'http://127.0.0.1:1/callback';

interface Seen {
  readonly challengeBodies: Array<Record<string, unknown>>;
  readonly signedStatements: string[];
  readonly accounts: Set<string>;
  verifyCalls: number;
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

function fleet(opts: { known?: readonly string[]; volunteer?: string; nonce?: string } = {}): { f: typeof fetch; seen: Seen } {
  const seen: Seen = { challengeBodies: [], signedStatements: [], accounts: new Set((opts.known ?? []).map((a) => a.toLowerCase())), verifyCalls: 0 };
  const challenges = new Map<string, { termsVersion?: string }>();
  let serial = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' || init?.body instanceof URLSearchParams ? String(init.body) : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {};
    if (url === `${RELAY}/register`) return json(201, { client_id: 'client-1' });
    if (url.startsWith(`${RELAY}/authorize?`)) return new Response('<script>const PENDING_ID = \'p1\';</script>', { status: 200 });
    if (url === `${IDENTITY}/challenges`) {
      seen.challengeBodies.push(body);
      const nonce = opts.nonce ?? `nonce${String(++serial).padStart(8, '0')}`;
      const accepted = body['termsVersion'] === CURRENT;
      challenges.set(nonce, accepted ? { termsVersion: CURRENT } : {});
      const offered = opts.volunteer ?? (accepted ? STATEMENT : undefined);
      return json(200, { nonce, expiresAt: new Date(Date.now() + 300_000).toISOString(), ...(offered !== undefined ? { termsStatement: offered } : {}) });
    }
    if (url === `${RELAY}/oauth/verify`) {
      seen.verifyCalls += 1;
      const message = String(body['message']);
      const ch = challenges.get(String(body['nonce']));
      if (!ch) return json(401, { error: 'Unknown or expired nonce' });
      challenges.delete(String(body['nonce']));
      const lines = message.split('\n');
      expect(lines[2]).toBe('');
      expect(lines[4]).toBe('');
      const signer = verifyMessage(message, String(body['signature']));
      if (signer !== lines[1]) return json(401, { error: 'SIWE signature does not match the address' });
      seen.signedStatements.push(lines[3]!);
      const account = signer.toLowerCase();
      if (!seen.accounts.has(account)) {
        if (!(lines[3] === STATEMENT && ch.termsVersion === CURRENT)) return json(428, { error: REFUSAL });
        seen.accounts.add(account);
      }
      return json(200, { redirect: `${REDIRECT}?code=c-${account}` });
    }
    if (url === `${RELAY}/token`) return json(200, { access_token: 'tok-' + new URLSearchParams(raw).get('code'), refresh_token: 'r', expires_in: 3600 });
    throw new Error('unexpected request ' + url);
  }) as typeof fetch;
  return { f, seen };
}

const signIn = (w: { readonly address: string; signMessage(m: string): Promise<string> }, f: typeof fetch, acceptHostedTermsVersion?: string) =>
  signInWithWallet(RELAY, IDENTITY, w.address, (m) => w.signMessage(m), REDIRECT, undefined,
    { fetchImpl: f, ...(acceptHostedTermsVersion ? { acceptHostedTermsVersion } : {}) });

describe('the desktop wallet sign-in and the Hosted Terms', () => {
  it('★ a NEW key with no tick asks for no agreement, signs none, and the 428 reaches the window with its status and the server\'s words', async () => {
    const w = Wallet.createRandom();
    const { f, seen } = fleet();
    const err = await signIn(w, f).then(() => null, (e: Error) => e);
    expect(err?.message).toContain('(HTTP 428): ' + REFUSAL);
    expect(err?.message).toContain('tick "I agree"');
    expect(seen.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(seen.signedStatements).toEqual([ORDINARY_SIWE_STATEMENT]);
    expect(seen.accounts.size).toBe(0);
  });

  it('★ the ticked version is sent, the server\'s statement is what the key signs, and the new account opens', async () => {
    const w = Wallet.createRandom();
    const { f, seen } = fleet();
    const bearer = await signIn(w, f, CURRENT);
    expect(bearer.accessToken).toBe('tok-c-' + w.address.toLowerCase());
    expect(seen.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: CURRENT }]);
    expect(seen.signedStatements).toEqual([STATEMENT]);
    expect(seen.accounts.has(w.address.toLowerCase())).toBe(true);
  });

  it('a returning account signs in unticked, exactly as before', async () => {
    const w = Wallet.createRandom();
    const { f, seen } = fleet({ known: [w.address] });
    await expect(signIn(w, f)).resolves.toMatchObject({ kind: 'relay-oauth-bearer', method: 'siwe' });
    expect(seen.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(seen.signedStatements).toEqual([ORDINARY_SIWE_STATEMENT]);
  });

  it('a version the server no longer offers still lets a returning account in, with the ordinary statement', async () => {
    const w = Wallet.createRandom();
    const { f, seen } = fleet({ known: [w.address] });
    await expect(signIn(w, f, STALE)).resolves.toMatchObject({ method: 'siwe' });
    expect(seen.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: STALE }]);
    expect(seen.signedStatements).toEqual([ORDINARY_SIWE_STATEMENT]);
  });

  it('★ a statement nobody ticked for is never signed, whatever the server volunteers', async () => {
    const w = Wallet.createRandom();
    const { f, seen } = fleet({ known: [w.address], volunteer: STATEMENT });
    await signIn(w, f);
    expect(seen.signedStatements).toEqual([ORDINARY_SIWE_STATEMENT]);
  });

  it('★ a statement with a line break in it is refused before anything is signed', async () => {
    const w = Wallet.createRandom();
    const { f, seen } = fleet({ volunteer: 'I agree\nURI: https://elsewhere.example' });
    await expect(signIn(w, f, CURRENT)).rejects.toThrow(/line break, so nothing was signed/);
    expect(seen.verifyCalls).toBe(0);
  });

  it('a nonce that is not letters and digits is refused before anything is signed', async () => {
    const w = Wallet.createRandom();
    const { f, seen } = fleet({ known: [w.address], nonce: 'abcdefgh\nURI: x' });
    await expect(signIn(w, f)).rejects.toThrow(/nonce .*nothing was signed/);
    expect(seen.verifyCalls).toBe(0);
  });
});

describe('reading the current Hosted Terms to show them', () => {
  const answering = (status: number, payload: unknown): typeof fetch => (async () => json(status, payload)) as typeof fetch;

  it('reads the offered version and its https link, and the privacy link and beta notice beside them', async () => {
    const offer = await readHostedTerms(IDENTITY, answering(200, {
      terms: { version: CURRENT, url: `https://interego.example/terms/${CURRENT}/` },
      privacyUrl: 'https://interego.example/privacy/', betaNotice: 'A beta prototype.',
    }));
    expect(offer).toEqual({
      state: 'offered', version: CURRENT, url: `https://interego.example/terms/${CURRENT}/`,
      privacyUrl: 'https://interego.example/privacy/', betaNotice: 'A beta prototype.',
    });
  });

  it('says there are none when the server offers none', async () => {
    expect(await readHostedTerms(IDENTITY, answering(200, { terms: null, privacyUrl: null }))).toEqual({ state: 'none' });
  });

  it('★ refuses to call a link it would open anything but an https offer, and says why rather than "none"', async () => {
    const offer = await readHostedTerms(IDENTITY, answering(200, { terms: { version: CURRENT, url: 'javascript:alert(1)' } }));
    expect(offer.state).toBe('unknown');
    const bad = await readHostedTerms(IDENTITY, answering(200, { terms: { version: 'latest', url: 'https://interego.example/terms/' } }));
    expect(bad.state).toBe('unknown');
  });

  it('an unreachable server is "unknown", never "none"', async () => {
    const offer = await readHostedTerms(IDENTITY, (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    expect(offer).toMatchObject({ state: 'unknown', why: expect.stringContaining('ECONNREFUSED') });
    expect((await readHostedTerms(IDENTITY, answering(503, {}))).state).toBe('unknown');
  });
});
