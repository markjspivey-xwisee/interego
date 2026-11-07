/**
 * An agent process creating its own account answers the Hosted Terms offer only when its
 * operator said so, and a refusal reaches the caller in the server's own words.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. Since hosted identity began requiring the Hosted Terms
 * agreement for a NEW account (HTTP 428 `hosted_terms_required`), `openAgentSession` with a
 * fresh wallet could not sign in at all — and `mintBearer` reported it as "SIWE verify returned
 * no authorization code", dropping the status and the sentence that said what to do. The live
 * client-signature check creates a fresh wallet every run, so it failed every run, for a
 * reason its error hid.
 *
 * ★ THE FAKE IS THE IDENTITY CONTRACT, NOT A CONVENIENCE. Every answer below follows what
 * `deploy/identity/server.ts` does: `/challenges` returns `termsStatement` only when the body's
 * `termsVersion` is exactly the version on offer; an UNKNOWN wallet is admitted only when it
 * signed that exact statement on a challenge that carried that version; a KNOWN wallet signs
 * in with the ordinary statement whatever it asked for. The signer is recovered from the
 * signature (`verifyMessage`), not read from the message, so a test cannot pass by naming an
 * address it does not hold. The relay's `/oauth/verify` forwards identity's status and
 * `error` unchanged, which is what the 428 here stands for.
 *
 * ★ `globalThis.fetch` IS REPLACED, AND PUT BACK AFTER EVERY TEST. `openAgentSession` takes no
 * fetch for its sign-in, so the global is the only seam; each file runs in its own process
 * (vitest.config.ts `isolate: true`), and `afterEach` restores it inside this file too.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import { openAgentSession } from '../applications/shared-workspace/src/agent-session.js';

const RELAY = 'https://relay.example';
const IDENTITY = 'https://identity.example';
const CURRENT = '2026-11-06-r2';
const STALE = '2026-10-01';
const TERMS_STATEMENT = `I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/${CURRENT}/`;
const TERMS_REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Challenge { readonly termsVersion?: string }
interface Fleet {
  /** Every `/challenges` request body, in order. */
  readonly challengeBodies: Array<Record<string, unknown>>;
  /** Every `/challenges` reply's `termsStatement` (undefined when none was offered), in order. */
  readonly offered: Array<string | undefined>;
  /** The statement line of every message that reached `/oauth/verify`, in order. */
  readonly signedStatements: string[];
  /** Lowercased addresses that hold an account. */
  readonly accounts: Set<string>;
  /** Bearers the token endpoint issued, in order. */
  readonly issued: string[];
  /** Bearers presented to `/mcp`, in order. */
  readonly presented: string[];
  /** The nonce of every request that reached `/oauth/verify`, in order. */
  readonly verifyNonces: string[];
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The relay and identity server as far as `openAgentSession` reaches them, installed on
 * `globalThis.fetch`. `known` seeds wallets that already hold an account; `expireFirstBearer`
 * answers the first `/mcp` call 401, as a lapsed relay token is answered. `volunteer` makes
 * `/challenges` return that statement whatever was asked; `nonce` replaces the issued nonce —
 * both stand for a server that misbehaves.
 */
function installFleet(opts: {
  known?: readonly string[]; expireFirstBearer?: boolean; volunteer?: string; nonce?: string;
} = {}): Fleet {
  const fleet: Fleet = {
    challengeBodies: [],
    offered: [],
    signedStatements: [],
    accounts: new Set((opts.known ?? []).map(a => a.toLowerCase())),
    issued: [],
    presented: [],
    verifyNonces: [],
  };
  const challenges = new Map<string, Challenge>();
  /** Authorization code → the account it was issued to. */
  const codes = new Map<string, string>();
  /** Bearer → the account it was issued to. */
  const bearers = new Map<string, string>();
  let mcpCalls = 0;
  let serial = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
      fleet.challengeBodies.push(body);
      expect(body['purpose']).toBe('siwe');
      const nonce = opts.nonce ?? `nonce${String(++serial).padStart(8, '0')}`;
      const accepted = body['termsVersion'] === CURRENT;
      challenges.set(nonce, accepted ? { termsVersion: CURRENT } : {});
      const offered = opts.volunteer ?? (accepted ? TERMS_STATEMENT : undefined);
      fleet.offered.push(offered);
      return json(200, {
        nonce,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        ...(offered !== undefined ? { termsStatement: offered } : {}),
      });
    }

    if (url === `${RELAY}/oauth/verify`) {
      expect(body['pending_id']).toBe('p1');
      expect(body['method']).toBe('siwe');
      const message = String(body['message']);
      const nonce = String(body['nonce']);
      fleet.verifyNonces.push(nonce);
      const challenge = challenges.get(nonce);
      if (!challenge) return json(401, { error: 'Unknown or expired nonce' });
      challenges.delete(nonce);
      const lines = message.split('\n');
      // ERC-4361: domain line, address, blank, statement, blank, then the fields.
      expect(lines[0]).toBe(`${new URL(RELAY).host} wants you to sign in with your Ethereum account:`);
      expect(lines[2]).toBe('');
      expect(lines[4]).toBe('');
      expect(lines).toContain(`Nonce: ${nonce}`);
      const signer = verifyMessage(message, String(body['signature']));
      if (signer !== lines[1]) return json(401, { error: 'SIWE signature does not match the address' });
      const statement = lines[3]!;
      fleet.signedStatements.push(statement);
      const account = signer.toLowerCase();
      if (!fleet.accounts.has(account)) {
        const agreed = statement === TERMS_STATEMENT && challenge.termsVersion === CURRENT;
        if (!agreed) return json(428, { error: TERMS_REFUSAL });
        fleet.accounts.add(account);
      }
      codes.set('c', account);
      return json(200, { redirect: 'http://localhost:9999/callback?code=c' });
    }

    if (url === `${RELAY}/token`) {
      const form = new URLSearchParams(raw);
      const account = codes.get(form.get('code') ?? '');
      if (!account) return json(400, { error: 'invalid_grant' });
      codes.delete(form.get('code') ?? '');
      const token = `access-${++serial}`;
      bearers.set(token, account);
      fleet.issued.push(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }

    if (url === `${RELAY}/mcp`) {
      const auth = new Headers(init?.headers).get('Authorization') ?? '';
      const token = auth.replace(/^Bearer /, '');
      fleet.presented.push(token);
      mcpCalls += 1;
      const account = bearers.get(token);
      if (!account || (opts.expireFirstBearer && mcpCalls === 1)) return new Response('', { status: 401 });
      const params = body['params'] as { name?: string } | undefined;
      expect(params?.name).toBe('get_pod_status');
      const pod = `https://pods.example/u-eth-${account.slice(2, 14)}/`;
      const status = {
        pod,
        registry: { owner: `${pod}profile/card#me` },
        sessionAgent: { did: `did:web:identity.example:agents:wsp-agent-member-u-eth-${account.slice(2, 14)}`, scope: 'ReadWrite' },
      };
      return json(200, { jsonrpc: '2.0', id: body['id'], result: { content: [{ type: 'text', text: JSON.stringify(status) }] } });
    }

    throw new Error(`this test scripted no answer for ${url}`);
  }) as typeof fetch;

  return fleet;
}

const open = (privateKey: string, acceptHostedTermsVersion?: string) => openAgentSession({
  privateKey,
  relay: RELAY,
  identityHost: IDENTITY,
  ...(acceptHostedTermsVersion !== undefined ? { acceptHostedTermsVersion } : {}),
});

describe('openAgentSession and the Hosted Terms offer', () => {
  it('(i) a new wallet without the operator\'s agreement is refused, and the refusal says HTTP 428 and why', async () => {
    const wallet = Wallet.createRandom();
    const fleet = installFleet();

    const opened = open(wallet.privateKey);
    await expect(opened).rejects.toThrow(/HTTP 428/);
    await expect(opened).rejects.toThrow(/Review the Hosted Interego Terms/);

    // The library did not agree on its own: no version asked for, the ordinary statement signed,
    // and no account created.
    expect(fleet.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(fleet.signedStatements).toEqual(['Sign in to Interego']);
    expect(fleet.accounts.has(wallet.address.toLowerCase())).toBe(false);
  });

  it('(ii) a new wallet whose operator agreed to the offered version signs exactly the statement the server returned', async () => {
    const wallet = Wallet.createRandom();
    const fleet = installFleet();

    const session = await open(wallet.privateKey, CURRENT);

    expect(fleet.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: CURRENT }]);
    expect(fleet.offered).toEqual([TERMS_STATEMENT]);
    expect(fleet.signedStatements).toEqual([fleet.offered[0]]);
    expect(fleet.accounts.has(wallet.address.toLowerCase())).toBe(true);
    expect(session.identity.address).toBe(wallet.address);
    expect(session.identity.podName).toBe(`u-eth-${wallet.address.toLowerCase().slice(2, 14)}`);
  });

  it('(iii) a returning wallet with a stale version signs in with the ordinary statement, again on refresh', async () => {
    const wallet = Wallet.createRandom();
    const fleet = installFleet({ known: [wallet.address], expireFirstBearer: true });

    const session = await open(wallet.privateKey, STALE);

    // Two ceremonies: the first bearer was answered 401, so refresh() minted again.
    expect(fleet.issued).toHaveLength(2);
    expect(fleet.presented).toEqual(fleet.issued);
    // Both asked for the stale version, were offered nothing, and signed the ordinary statement.
    expect(fleet.challengeBodies).toEqual([
      { purpose: 'siwe', termsVersion: STALE },
      { purpose: 'siwe', termsVersion: STALE },
    ]);
    expect(fleet.offered).toEqual([undefined, undefined]);
    expect(fleet.signedStatements).toEqual(['Sign in to Interego', 'Sign in to Interego']);
    expect(session.identity.address).toBe(wallet.address);
  });

  it('(iv) a returning wallet without the option signs in exactly as before', async () => {
    const wallet = Wallet.createRandom();
    const fleet = installFleet({ known: [wallet.address] });

    const session = await open(wallet.privateKey);

    expect(fleet.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(fleet.signedStatements).toEqual(['Sign in to Interego']);
    expect(fleet.issued).toHaveLength(1);
    expect(session.identity.webId).toBe(`https://pods.example/u-eth-${wallet.address.toLowerCase().slice(2, 14)}/profile/card#me`);
  });

  it('(v) a statement the server volunteers without being asked is never signed', async () => {
    const wallet = Wallet.createRandom();
    const fleet = installFleet({ known: [wallet.address], volunteer: TERMS_STATEMENT });

    await open(wallet.privateKey);

    expect(fleet.offered).toEqual([TERMS_STATEMENT]);
    expect(fleet.signedStatements).toEqual(['Sign in to Interego']);
  });

  it('(vi) an offered statement with a line break is refused before anything is signed or sent', async () => {
    const wallet = Wallet.createRandom();
    const fleet = installFleet({ volunteer: `${TERMS_STATEMENT}\nURI: https://elsewhere.example` });

    await expect(open(wallet.privateKey, CURRENT)).rejects.toThrow(/line break/);
    expect(fleet.verifyNonces).toEqual([]);
  });

  it('(vii) a nonce outside the identity server\'s own form is refused before anything is signed or sent', async () => {
    const wallet = Wallet.createRandom();
    const fleet = installFleet({ known: [wallet.address], nonce: 'abc12345\nURI: https://elsewhere.example' });

    await expect(open(wallet.privateKey)).rejects.toThrow(/nonce/);
    expect(fleet.verifyNonces).toEqual([]);
  });
});
