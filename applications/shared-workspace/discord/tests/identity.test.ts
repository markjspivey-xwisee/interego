/**
 * THE ONE STRING IN THIS BOT THAT IS PERMANENT, AND IT WAS WRONG.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. `mintBearer` defaults `clientName` to
 * `interego-workspace-live-driver` — the name of the disposable DRIVERS in the sibling `tools/`
 * directory. `BotSession.open()` omitted the argument, so the deployed conduit signed in under
 * that default and the relay, which bakes the OAuth client name into the agent DID it issues,
 * minted `…:agents:interego-workspace-live-driver-<pod>` as this bot's identity. Nothing failed:
 * it worked perfectly under somebody else's test-harness name.
 *
 * That string is not a display name. It is what `/workspace link` prints, what every participant
 * pastes into `register_agent`, and what then sits world-readably in their own pod's delegation
 * registry as the agent they authorised. Changing it after anyone has linked invalidates every
 * one of those rows at once. So the argument being passed is worth a test, and the test has to
 * observe the argument the way the relay does — in the `/register` body — not by re-reading the
 * constant it came from.
 *
 * ★ AND IT DRIVES THE REAL CEREMONY. `BotSession.open()` here is the real one: the real
 * `mintBearer` doing the real four-round-trip SIWE exchange with a real `ethers` signature over
 * the real message body, the real `RelayMcpTransport` speaking real JSON-RPC, and the real
 * `WorkspaceClient.connect()` probing the real tool list. The only substitution is the HTTP
 * itself, which is INJECTED rather than monkey-patched onto `globalThis` — a global `fetch` patch
 * reaches every later test in the same process (every later file, under vitest 3), so it is a
 * defect in somebody else's test.
 *
 * ★ AND THE HOSTED TERMS, BELOW. A NEW `INTEREGO_BOT_KEY` has no account, and hosted identity
 * creates one only for a wallet that signed the Hosted Terms agreement. The bot gives it only from
 * its own operator's `INTEREGO_BOT_ACCEPT_HOSTED_TERMS_VERSION`, never from the live drivers'
 * variable, and a refusal tells the operator both ways to start the key.
 */

import { describe, expect, it } from 'vitest';
import { Wallet, verifyMessage } from 'ethers';
import { REQUIRED_TOOLS } from '@interego/workspace-client';
import { BOT_ACCEPT_HOSTED_TERMS_ENV, BotSession, DISCORD_CLIENT_NAME, botHostedTerms } from '../src/identity.js';
import { main } from '../src/main.js';

const RELAY = 'https://relay.example';
const IDENTITY = 'https://identity.example';
/** A throwaway secp256k1 key. It signs the SIWE message below and authorises nothing anywhere. */
const KEY = '0x' + '11'.repeat(32);
const POD = 'u-eth-053ad15f9633';
const AGENT = 'did:web:identity.example:agents:' + DISCORD_CLIENT_NAME + '-' + POD;

interface Seen { readonly url: string; readonly body: Record<string, unknown> | string | null }

/**
 * The relay and identity server, as far as one sign-in reaches them. Every response shape below
 * is the one the real code paths parse — the authorize page's inline `PENDING_ID`, the redirect
 * with the code in its query, the JSON-RPC envelope with `structuredContent`.
 */
function scriptedFleet(opts: { volunteer?: string } = {}): { impl: typeof fetch; seen: Seen[]; minted: () => number } {
  const seen: Seen[] = [];
  /** How many SIWE ceremonies reached the token endpoint. One per real re-mint. */
  let tokens = 0;
  const json = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : null;
    let body: Record<string, unknown> | string | null = raw;
    if (raw && raw.startsWith('{')) { try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* left as text */ } }
    seen.push({ url, body });

    if (url === RELAY + '/register') return json({ client_id: 'client-1' });
    if (url.startsWith(RELAY + '/authorize')) {
      return new Response('<script>const PENDING_ID = \'pending-1\';</script>', {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }
    // ★ A NONCE OF THE FORM IDENTITY ISSUES: hex, 64 characters (`issueChallenge` for `siwe`).
    // `mintBearer` refuses one that is not 8+ letters or digits before signing it, as identity's
    // own message parser refuses it after. This was `nonce-1`, which the live fleet never issues.
    // `volunteer` makes `/challenges` also return an agreement statement nobody asked for.
    if (url === IDENTITY + '/challenges') {
      return json({ nonce: 'a1'.repeat(32), ...(opts.volunteer !== undefined ? { termsStatement: opts.volunteer } : {}) });
    }
    if (url === RELAY + '/oauth/verify') return json({ redirect: 'http://127.0.0.1:1/callback?code=code-1&state=s' });
    if (url === RELAY + '/token') return json({ access_token: 'access-' + (++tokens), expires_in: 3600 });
    if (url === RELAY + '/mcp') {
      const method = (body as Record<string, unknown> | null)?.['method'];
      if (method === 'tools/list') {
        return json({ jsonrpc: '2.0', id: 1, result: { tools: REQUIRED_TOOLS.map((name) => ({ name })) } });
      }
      return json({
        jsonrpc: '2.0', id: 2,
        result: {
          structuredContent: {
            pod: 'http://css.railway.internal:3456/' + POD + '/',
            sessionAgent: { did: AGENT },
          },
        },
      });
    }
    throw new Error('this test scripted no answer for ' + url);
  }) as typeof fetch;

  return { impl, seen, minted: () => tokens };
}

const CURRENT = '2026-11-06-r2';
const STALE = '2026-10-01';
const TERMS_STATEMENT = `I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/${CURRENT}/`;
const TERMS_REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';

interface HostedFleet {
  readonly impl: typeof fetch;
  /** Every `/challenges` request body, in order. */
  readonly challengeBodies: Array<Record<string, unknown>>;
  /** The statement line of every message that reached `/oauth/verify`, in order. */
  readonly statements: string[];
  /** Lowercased addresses that hold an account. */
  readonly accounts: Set<string>;
}

/**
 * ★ THE IDENTITY CONTRACT FOR THE HOSTED TERMS, as `deploy/identity/server.ts` implements it for
 * SIWE and as `../../tests/live-identity-terms.test.ts` holds `mintBearer` to: `/challenges` returns
 * `termsStatement` only when the body's `termsVersion` is exactly the version on offer; an UNKNOWN
 * wallet is admitted only when it signed that exact statement on a challenge that carried that
 * version, and is otherwise answered 428 with identity's text; a KNOWN wallet signs in whatever it
 * signed. The signer is recovered from the signature, not read from the message. `refuse` stands for
 * any other refusal at `/oauth/verify`. It also answers the one Discord call `main()` makes before
 * signing in.
 */
function hostedFleet(opts: { known?: readonly string[]; refuse?: { status: number; error: string } } = {}): HostedFleet {
  const accounts = new Set((opts.known ?? []).map((a) => a.toLowerCase()));
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
    if (url === 'https://discord.com/api/v10/users/@me') return json({ id: 'app-1', username: 'workspace-bot' });
    if (url === RELAY + '/register') return json({ client_id: 'client-1' });
    if (url.startsWith(RELAY + '/authorize')) return new Response('<script>const PENDING_ID = \'pending-1\';</script>', { status: 200 });
    if (url === IDENTITY + '/challenges') {
      challengeBodies.push(body);
      const nonce = 'b2'.repeat(31) + String(++serial).padStart(2, '0');
      const offered = body['termsVersion'] === CURRENT;
      challenges.set(nonce, offered);
      return json({ nonce, ...(offered ? { termsStatement: TERMS_STATEMENT } : {}) });
    }
    if (url === RELAY + '/oauth/verify') {
      if (opts.refuse) return json({ error: opts.refuse.error }, opts.refuse.status);
      const message = String(body['message']);
      const offered = challenges.get(String(body['nonce']));
      if (offered === undefined) return json({ error: 'Unknown or expired nonce' }, 401);
      const lines = message.split('\n');
      if (verifyMessage(message, String(body['signature'])) !== lines[1]) return json({ error: 'SIWE signature does not match the address' }, 401);
      statements.push(lines[3]!);
      const account = lines[1]!.toLowerCase();
      if (!accounts.has(account)) {
        if (!(offered && lines[3] === TERMS_STATEMENT)) return json({ error: TERMS_REFUSAL }, 428);
        accounts.add(account);
      }
      return json({ redirect: 'http://127.0.0.1:1/callback?code=code-1&state=s' });
    }
    if (url === RELAY + '/token') return json({ access_token: 'access-1', expires_in: 3600 });
    if (url === RELAY + '/mcp') {
      if (body['method'] === 'tools/list') return json({ jsonrpc: '2.0', id: 1, result: { tools: REQUIRED_TOOLS.map((name) => ({ name })) } });
      return json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { pod: 'http://css.railway.internal:3456/' + POD + '/', sessionAgent: { did: AGENT } } } });
    }
    throw new Error('this test scripted no answer for ' + url);
  }) as typeof fetch;

  return { impl, challengeBodies, statements, accounts };
}

describe('the OAuth client name the bot signs in under', () => {
  it('is this conduit\'s own name, not the live drivers\' default', () => {
    expect(DISCORD_CLIENT_NAME).toBe('interego-discord');
    expect(DISCORD_CLIENT_NAME).not.toBe('interego-workspace-live-driver');
  });

  it('survives the relay\'s slugifier unchanged, so the DID contains it verbatim', () => {
    // Mirrors `surfaceAgentFromClient` in `deploy/mcp-relay/server.ts`: an unrecognised client
    // name is lowercased, non-alphanumerics collapse to `-`, and the result must match
    // `^[a-z][a-z0-9-]{1,31}$` or the relay substitutes its generic default agent instead. A name
    // that does not survive that round trip would put a DIFFERENT string in the DID from the one
    // this package prints in `/workspace link` — the two would disagree and no link would verify.
    const slug = DISCORD_CLIENT_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    expect(slug).toBe(DISCORD_CLIENT_NAME);
    expect(DISCORD_CLIENT_NAME).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
  });

  it('is the name actually registered with the relay when a session opens', async () => {
    const { impl, seen } = scriptedFleet();
    const identity = await new BotSession(RELAY, IDENTITY, KEY, impl).open();

    const registration = seen.find((s) => s.url === RELAY + '/register');
    expect(registration, 'the sign-in never registered an OAuth client').toBeDefined();
    // ★ THE ASSERTION THE DEFECT WOULD HAVE FAILED. Read off the wire, because this is the only
    // value the relay sees and the only one that ends up in the DID.
    expect((registration?.body as Record<string, unknown>)['client_name']).toBe('interego-discord');

    // And the identity it comes back with is the relay's answer, not anything derived locally.
    expect(identity.agentId).toBe(AGENT);
    expect(identity.pod).toBe(POD);
  });

  it('does not let the client name move the pod — that is the key\'s', async () => {
    // The pod in the DID is the OWNER's, derived from the wallet the bot signs with; the surface
    // slug in front of it is the client name. Renaming the client is therefore a new AGENT on the
    // SAME pod, which is exactly why the rename was cheap before anybody linked and expensive
    // after. Two sessions, same key, and the pod the relay reports is the same one.
    const a = await new BotSession(RELAY, IDENTITY, KEY, scriptedFleet().impl).open();
    const b = await new BotSession(RELAY, IDENTITY, KEY, scriptedFleet().impl).open();
    expect(a.address).toBe(b.address);
    expect(a.pod).toBe(b.pod);
  });
});

describe('the bot and the Hosted Terms', () => {
  /**
   * ★ THE LIVE DRIVERS' AGREEMENT IS NOT THE BOT'S. `mintBearer` takes the operator's Hosted Terms
   * agreement for the live drivers that create accounts, and those drivers read it from
   * `INTEREGO_ACCEPT_HOSTED_TERMS_VERSION`. The bot is not one of them: with no agreement of its own
   * its sign-in must stay exactly what it was even where that variable is set, and even when
   * identity's reply carries an agreement statement.
   */
  it('asks for no terms version and signs the ordinary statement, whatever the environment or the reply', async () => {
    const variable = 'INTEREGO_ACCEPT_HOSTED_TERMS_VERSION';
    const before = process.env[variable];
    process.env[variable] = '2026-11-06-r2';
    try {
      const { impl, seen } = scriptedFleet({ volunteer: 'I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/2026-11-06-r2/' });
      await new BotSession(RELAY, IDENTITY, KEY, impl).open();

      expect(seen.filter((s) => s.url === IDENTITY + '/challenges').map((s) => s.body)).toEqual([{ purpose: 'siwe' }]);
      const proof = seen.find((s) => s.url === RELAY + '/oauth/verify')?.body as Record<string, unknown> | undefined;
      expect(String(proof?.['message']).split('\n')[3]).toBe('Sign in to Interego');
    } finally {
      if (before === undefined) delete process.env[variable];
      else process.env[variable] = before;
    }
  });

  it('reads its operator\'s agreement only from its own variable, and a blank one is no agreement', () => {
    expect(BOT_ACCEPT_HOSTED_TERMS_ENV).toBe('INTEREGO_BOT_ACCEPT_HOSTED_TERMS_VERSION');
    expect(botHostedTerms({ [BOT_ACCEPT_HOSTED_TERMS_ENV]: ` ${CURRENT}\n` })).toEqual({ acceptHostedTermsVersion: CURRENT });
    // The drivers' variable, alone or beside a blank one of the bot's, is not an agreement for the bot.
    expect(botHostedTerms({ INTEREGO_ACCEPT_HOSTED_TERMS_VERSION: CURRENT })).toEqual({});
    expect(botHostedTerms({ INTEREGO_ACCEPT_HOSTED_TERMS_VERSION: CURRENT, [BOT_ACCEPT_HOSTED_TERMS_ENV]: '' })).toEqual({});
    expect(botHostedTerms({ [BOT_ACCEPT_HOSTED_TERMS_ENV]: '  \n' })).toEqual({});
    expect(botHostedTerms({})).toEqual({});
  });

  it('★ with its operator\'s version, a NEW key signs exactly the statement identity returns for it, and the account is created', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = hostedFleet();

    const identity = await new BotSession(RELAY, IDENTITY, key, f.impl, { acceptHostedTermsVersion: CURRENT }).open();

    expect(identity.agentId).toBe(AGENT);
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: CURRENT }]);
    expect(f.statements).toEqual([TERMS_STATEMENT]);
    expect(f.accounts.has(new Wallet(key).address.toLowerCase())).toBe(true);
  });

  it('★ without one, a NEW key is refused once, in identity\'s words, then told the bot\'s variable and where the terms are; nothing is retried or created', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = hostedFleet();

    const err = await new BotSession(RELAY, IDENTITY, key, f.impl).open().then(() => null, (e: Error) => e);

    // What the operator reads after `FATAL: ` at boot, as DEPLOY.md Part B quotes it.
    expect(err?.message.startsWith('SIWE verify answered HTTP 428: ' + TERMS_REFUSAL + ' (')).toBe(true);
    expect(err?.message).toContain('set ' + BOT_ACCEPT_HOSTED_TERMS_ENV + '=<that version>');
    expect(err?.message).toContain(IDENTITY + '/.well-known/hosted-interego-terms');
    expect(err?.message).toContain('or create the account first as DEPLOY.md Part B says');
    // It points at the bot's variable, never at the drivers'.
    expect(err?.message).not.toContain('INTEREGO_ACCEPT_HOSTED_TERMS_VERSION');
    // ONE ceremony: it did not go and agree, with any version, after being refused.
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(f.statements).toEqual(['Sign in to Interego']);
    expect(f.accounts.size).toBe(0);
  });

  it('a version identity no longer offers is refused for a NEW key, and the refusal names the variable\'s value', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = hostedFleet();

    const err = await new BotSession(RELAY, IDENTITY, key, f.impl, { acceptHostedTermsVersion: STALE }).open().then(() => null, (e: Error) => e);

    expect(err?.message.startsWith('SIWE verify answered HTTP 428: ' + TERMS_REFUSAL + ' (')).toBe(true);
    expect(err?.message).toContain(BOT_ACCEPT_HOSTED_TERMS_ENV + ' is ' + STALE);
    expect(f.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: STALE }]);
    expect(f.statements).toEqual(['Sign in to Interego']);
  });

  it('a refusal that is not the Hosted Terms is passed on as it came', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = hostedFleet({ refuse: { status: 401, error: 'Unknown or expired nonce' } });

    const err = await new BotSession(RELAY, IDENTITY, key, f.impl).open().then(() => null, (e: Error) => e);

    expect(err?.message).toBe('SIWE verify answered HTTP 401: Unknown or expired nonce');
  });

  it('a key that already holds an account signs in with or without the agreement', async () => {
    const key = Wallet.createRandom().privateKey;
    const f = hostedFleet({ known: [new Wallet(key).address] });

    await new BotSession(RELAY, IDENTITY, key, f.impl).open();
    await new BotSession(RELAY, IDENTITY, key, f.impl, { acceptHostedTermsVersion: CURRENT }).open();

    expect(f.challengeBodies).toEqual([{ purpose: 'siwe' }, { purpose: 'siwe', termsVersion: CURRENT }]);
    expect(f.statements).toEqual(['Sign in to Interego', TERMS_STATEMENT]);
  });

  /**
   * ★ THE WIRING, NOT ONLY THE CLASS. `main()` is what builds the session the deployed bot runs, so
   * this drives it with an injected environment and HTTP up to the sign-in, where a NEW key is
   * refused before anything else starts. What it sends is the evidence of what it read.
   */
  it('★ main() hands the session its own variable\'s version and never the drivers\'', async () => {
    const boot = (env: Record<string, string>, f: HostedFleet) => main({
      env: {
        DISCORD_BOT_TOKEN: 'discord-token', INTEREGO_BOT_KEY: Wallet.createRandom().privateKey,
        INTEREGO_RELAY: RELAY, INTEREGO_IDENTITY: IDENTITY, ...env,
      },
      argv: [], out: () => undefined, fetchImpl: f.impl,
    }).then(() => null, (e: Error) => e);

    const drivers = hostedFleet();
    const refused = await boot({ INTEREGO_ACCEPT_HOSTED_TERMS_VERSION: CURRENT }, drivers);
    expect(drivers.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    expect(refused?.message).toContain('set ' + BOT_ACCEPT_HOSTED_TERMS_ENV + '=<that version>');

    const own = hostedFleet();
    const stale = await boot({ [BOT_ACCEPT_HOSTED_TERMS_ENV]: STALE, INTEREGO_ACCEPT_HOSTED_TERMS_VERSION: CURRENT }, own);
    expect(own.challengeBodies).toEqual([{ purpose: 'siwe', termsVersion: STALE }]);
    expect(stale?.message).toContain(BOT_ACCEPT_HOSTED_TERMS_ENV + ' is ' + STALE);
  });
});

describe('★★ re-minting the bot\'s own session', () => {
  /**
   * ── WHY THE BOT WAS REJECTED ONCE AN HOUR ───────────────────────────────────
   *
   * `expiring()` is a comparison against one clock, so at the hour boundary EVERY concurrent
   * caller answers it identically. Before this guard each would run its own SIWE ceremony, mint
   * its own bearer and build its own transport — the last to finish winning `this.identity`,
   * the rest having signed in for nothing against a relay that had just been handed a burst of
   * identical authorization requests from one wallet.
   *
   * It was survivable while only Discord commands went through `call()`. It stops being
   * survivable now the WATCHES do — one per watched thread, all polling on the same cadence.
   */
  it('runs ONE ceremony when everything notices expiry at the same instant', async () => {
    const fleet = scriptedFleet();
    const session = new BotSession(RELAY, IDENTITY, KEY, fleet.impl);
    await session.open();
    expect(fleet.minted(), 'opening once did not mint once').toBe(1);

    // Every watch and every command, in the same tick, all seeing an expired bearer.
    (session as unknown as { bearer: { expiresAt: number } }).bearer.expiresAt = Date.now() + 1000;
    const all = await Promise.all(Array.from({ length: 8 }, () => session.call(async (c) => c !== null)));
    expect(all.every(Boolean)).toBe(true);

    // ★ THE LOAD-BEARING ASSERTION. Eight callers, one ceremony.
    expect(fleet.minted(), 'concurrent callers each ran their own SIWE ceremony').toBe(2);
  });

  it('and a later expiry mints again, so the guard is a lock and not a latch', async () => {
    // The other half: single-flight must not become sign-in-once.
    const fleet = scriptedFleet();
    const session = new BotSession(RELAY, IDENTITY, KEY, fleet.impl);
    await session.open();
    for (const _ of [1, 2]) {
      (session as unknown as { bearer: { expiresAt: number } }).bearer.expiresAt = Date.now() + 1000;
      await session.call(async () => null);
    }
    expect(fleet.minted()).toBe(3);
  });
});
