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
 * itself, which is INJECTED rather than monkey-patched onto `globalThis` — one vitest realm is
 * shared by every file in the run and a global `fetch` patch is a defect in somebody else's test.
 */

import { describe, expect, it } from 'vitest';
import { REQUIRED_TOOLS } from '@interego/workspace-client';
import { BotSession, DISCORD_CLIENT_NAME } from '../src/identity.js';

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
function scriptedFleet(): { impl: typeof fetch; seen: Seen[]; minted: () => number } {
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
    if (url === IDENTITY + '/challenges') return json({ nonce: 'nonce-1' });
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
