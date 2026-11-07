/**
 * A Discord bot deployed with a NEW key gets its hosted account only on its operator's explicit
 * Hosted Terms agreement, through the bot's own variable — and a refusal says what to do.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. The README tells a maintainer to generate `INTEREGO_BOT_KEY`
 * with `openssl rand -hex 32`. Since #778 the first sign-in of such a key is a NEW hosted account,
 * which identity opens only for a wallet that signed the Hosted Terms agreement for the current
 * version (HTTP 428 `hosted_terms_required` otherwise). A fresh deployment therefore could not
 * start at all, and nothing in its error named the one setting that would let it.
 *
 * ★ THE FAKE IS THE IDENTITY CONTRACT, as `deploy/identity/server.ts` implements it for SIWE, with
 * the signer recovered from the signature (`verifyMessage`): `/challenges` returns `termsStatement`
 * only for exactly the version on offer; an UNKNOWN wallet is admitted only when it signed that
 * statement on a challenge that carried that version; a known one signs in either way. The HTTP is
 * injected, so nothing global is patched.
 *
 * `identity.test.ts` pins the other half: with no agreement configured the bot asks for none, even
 * where the live drivers' `INTEREGO_ACCEPT_HOSTED_TERMS_VERSION` is set.
 */

import { describe, expect, it } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import { REQUIRED_TOOLS } from '@interego/workspace-client';
import { BOT_ACCEPT_HOSTED_TERMS_ENV, BotSession, DISCORD_CLIENT_NAME, botHostedTerms } from '../src/identity.js';

const RELAY = 'https://relay.example';
const IDENTITY = 'https://identity.example';
const CURRENT = '2026-11-06-r2';
const STATEMENT = `I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/${CURRENT}/`;
const REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';

function fleet(known: readonly string[] = []) {
  const accounts = new Set(known.map((a) => a.toLowerCase()));
  const challengeBodies: Array<Record<string, unknown>> = [];
  const statements: string[] = [];
  const challenges = new Map<string, boolean>();
  let serial = 0;
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {};
    if (url === RELAY + '/register') return json({ client_id: 'client-1' });
    if (url.startsWith(RELAY + '/authorize')) return new Response('<script>const PENDING_ID = \'pending-1\';</script>', { status: 200 });
    if (url === IDENTITY + '/challenges') {
      challengeBodies.push(body);
      const nonce = 'b2'.repeat(31) + String(++serial).padStart(2, '0');
      const accepted = body['termsVersion'] === CURRENT;
      challenges.set(nonce, accepted);
      return json({ nonce, ...(accepted ? { termsStatement: STATEMENT } : {}) });
    }
    if (url === RELAY + '/oauth/verify') {
      const message = String(body['message']);
      const accepted = challenges.get(String(body['nonce']));
      if (accepted === undefined) return json({ error: 'Unknown or expired nonce' }, 401);
      const lines = message.split('\n');
      const signer = verifyMessage(message, String(body['signature']));
      if (signer !== lines[1]) return json({ error: 'signature does not match' }, 401);
      statements.push(lines[3]!);
      if (!accounts.has(signer.toLowerCase())) {
        if (!(accepted && lines[3] === STATEMENT)) return json({ error: REFUSAL }, 428);
        accounts.add(signer.toLowerCase());
      }
      return json({ redirect: 'http://127.0.0.1:1/callback?code=code-1&state=s' });
    }
    if (url === RELAY + '/token') return json({ access_token: 'access-1', expires_in: 3600 });
    if (url === RELAY + '/mcp') {
      const method = body['method'];
      if (method === 'tools/list') return json({ jsonrpc: '2.0', id: 1, result: { tools: REQUIRED_TOOLS.map((name) => ({ name })) } });
      return json({ jsonrpc: '2.0', id: 2, result: { structuredContent: {
        pod: 'http://css.railway.internal:3456/u-eth-bot/', sessionAgent: { did: 'did:web:identity.example:agents:' + DISCORD_CLIENT_NAME + '-u-eth-bot' },
      } } });
    }
    throw new Error('this test scripted no answer for ' + url);
  }) as typeof fetch;
  return { impl, challengeBodies, statements, accounts };
}

describe('a Discord bot with a NEW key and the Hosted Terms', () => {
  it('★ with no agreement it asks for none, and the 428 reaches the operator in the server\'s words, naming the bot\'s variable', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = fleet();
    const err = await new BotSession(RELAY, IDENTITY, key, f.impl).open().then(() => null, (e: Error) => e);
    expect(err?.message).toContain('HTTP 428: ' + REFUSAL);
    expect(err?.message).toContain(BOT_ACCEPT_HOSTED_TERMS_ENV + '=<that version>');
    expect(err?.message).toContain(IDENTITY + '/.well-known/hosted-interego-terms');
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(f.statements).toEqual(['Sign in to Interego']);
    expect(f.accounts.size).toBe(0);
  });

  it('★ with the operator\'s version it signs identity\'s statement for exactly that version, and the account opens', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = fleet();
    const identity = await new BotSession(RELAY, IDENTITY, key, f.impl, CURRENT).open();
    expect(identity.agentId).toContain(DISCORD_CLIENT_NAME);
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: CURRENT }]);
    expect(f.statements).toEqual([STATEMENT]);
    expect(f.accounts.has(new Wallet(key).address.toLowerCase())).toBe(true);
  });

  it('an existing deployment\'s key signs in with or without it', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = fleet([new Wallet(key).address]);
    await new BotSession(RELAY, IDENTITY, key, f.impl).open();
    await new BotSession(RELAY, IDENTITY, key, f.impl, CURRENT).open();
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe' }, { purpose: 'siwe', termsVersion: CURRENT }]);
  });
});

describe('where the bot reads its operator\'s agreement from', () => {
  it('★ only its own variable: the live drivers\' one is not an agreement for the bot', () => {
    expect(BOT_ACCEPT_HOSTED_TERMS_ENV).toBe('INTEREGO_BOT_ACCEPT_HOSTED_TERMS_VERSION');
    expect(botHostedTerms({ INTEREGO_ACCEPT_HOSTED_TERMS_VERSION: CURRENT })).toBeUndefined();
    expect(botHostedTerms({ [BOT_ACCEPT_HOSTED_TERMS_ENV]: ' ' + CURRENT + ' ' })).toBe(CURRENT);
    expect(botHostedTerms({ [BOT_ACCEPT_HOSTED_TERMS_ENV]: '   ' })).toBeUndefined();
    expect(botHostedTerms({})).toBeUndefined();
  });
});
