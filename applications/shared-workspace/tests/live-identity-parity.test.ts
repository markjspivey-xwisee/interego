/**
 * The live drivers' sign-in signs the message the desktop shell signs, byte for byte.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. The headless SIWE ceremony is spelled twice:
 * `desktop/src/auth.ts` (`signInWithWallet`, the shell's own sign-in) and `tools/live-identity.ts`
 * (`mintBearer`, the sign-in of every live driver here, of the root `tools/*-live.ts` probes and of
 * the Discord bot). The second is a copy for a stated reason (its header), and a copy is only
 * worth having while it is the same ceremony: a driver whose message drifted from the shell's
 * would be measuring a sign-in no user performs, and the Discord bot would sign in, or fail to,
 * for a reason nobody could see. `live-identity.ts`'s header and the Discord bot's `src/identity.ts`
 * both name this file as the check that holds the two together.
 *
 * ★ HOW IT COMPARES THEM. Both ceremonies run against one stand-in relay and identity server that
 * issues the same nonce every time, with the clock frozen, for the same wallet. What each one
 * posted to `/oauth/verify` is then compared WHOLE, not field by field, because a field nobody
 * thought to compare is exactly where a copy drifts. The signer is recovered from each signature
 * (`verifyMessage`), so what is compared is what was actually signed. Only the default statement
 * is compared: the desktop shell has no Hosted Terms path, and `live-identity-terms.test.ts` holds
 * the other statement to identity's contract.
 *
 * ★ `globalThis.fetch` IS REPLACED, AND PUT BACK AFTER EVERY TEST. `signInWithWallet` takes no
 * fetch, so the global is its only seam; `mintBearer` is handed the same function explicitly.
 * Only `Date` is faked, so no timer the HTTP stack relies on is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wallet, verifyMessage, type HDNodeWallet } from 'ethers';
import { signInWithWallet } from '../desktop/src/auth.js';
import { mintBearer, siweMessage } from '../tools/live-identity.js';

// The deployed hosts, because the relay URL is a line of the signed message (`URI:`) and the
// comparison should be of the message the deployed relay is sent. Nothing here reaches them: every
// request is answered by the stand-in below, and an unscripted one throws.
const RELAY = 'https://relay.interego.xwisee.com';
const IDENTITY = 'https://identity.interego.xwisee.com';
const NONCE = 'parityNonce00000001';
const NOW = new Date('2026-11-07T12:00:00.000Z');

/** What one ceremony sent, in the order it sent it. */
interface Ceremony {
  /** Every `/challenges` request body. */
  readonly challengeBodies: Array<Record<string, unknown>>;
  /** Every `/oauth/verify` request body. */
  readonly verifyBodies: Array<Record<string, unknown>>;
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/** The relay and identity server as far as either ceremony reaches them. */
function standIn(): { impl: typeof fetch; seen: Ceremony } {
  const seen: Ceremony = { challengeBodies: [], verifyBodies: [] };
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {};

    if (url === `${RELAY}/register`) return json(201, { client_id: 'client-1' });
    if (url.startsWith(`${RELAY}/authorize?`)) {
      return new Response('<script>\nconst PENDING_ID = \'p1\';\n</script>', {
        status: 200, headers: { 'Content-Type': 'text/html' },
      });
    }
    if (url === `${IDENTITY}/challenges`) {
      seen.challengeBodies.push(body);
      return json(200, { nonce: NONCE, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    }
    if (url === `${RELAY}/oauth/verify`) {
      seen.verifyBodies.push(body);
      return json(200, { redirect: 'http://127.0.0.1:1/callback?code=c' });
    }
    if (url === `${RELAY}/token`) {
      return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error(`this test scripted no answer for ${url}`);
  }) as typeof fetch;
  return { impl, seen };
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

/** The desktop shell's sign-in, through the global fetch it uses. */
async function desktopCeremony(wallet: HDNodeWallet): Promise<Ceremony> {
  const { impl, seen } = standIn();
  globalThis.fetch = impl;
  try {
    await signInWithWallet(RELAY, IDENTITY, wallet.address, m => wallet.signMessage(m), 'http://127.0.0.1:1/callback');
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen;
}

/** The live drivers' sign-in, with no Hosted Terms agreement: the default statement. */
async function driverCeremony(wallet: HDNodeWallet): Promise<Ceremony> {
  const { impl, seen } = standIn();
  await mintBearer(RELAY, IDENTITY, wallet, undefined, impl);
  return seen;
}

describe('live-identity.ts and desktop/src/auth.ts sign in with the same SIWE message', () => {
  it('the message each posts to /oauth/verify is byte for byte the same, and each signature is the wallet\'s', async () => {
    const wallet = Wallet.createRandom();

    const desktop = await desktopCeremony(wallet);
    const driver = await driverCeremony(wallet);

    expect(desktop.verifyBodies).toHaveLength(1);
    expect(driver.verifyBodies).toHaveLength(1);
    const desktopMessage = String(desktop.verifyBodies[0]!['message']);
    const driverMessage = String(driver.verifyBodies[0]!['message']);
    expect(driverMessage).toBe(desktopMessage);
    expect(verifyMessage(desktopMessage, String(desktop.verifyBodies[0]!['signature']))).toBe(wallet.address);
    expect(verifyMessage(driverMessage, String(driver.verifyBodies[0]!['signature']))).toBe(wallet.address);
  });

  it('and that message is siweMessage with its default statement, for this wallet, nonce and moment', async () => {
    const wallet = Wallet.createRandom();

    const desktop = await desktopCeremony(wallet);

    expect(String(desktop.verifyBodies[0]!['message'])).toBe(siweMessage(RELAY, wallet.address, NONCE, NOW.toISOString()));
  });

  it('the challenge request and the rest of the verify request are the same too', async () => {
    const wallet = Wallet.createRandom();

    const desktop = await desktopCeremony(wallet);
    const driver = await driverCeremony(wallet);

    // Asking for a challenge with anything more than `purpose` would be asking identity a different
    // question; the desktop shell asks only that.
    expect(driver.challengeBodies).toEqual(desktop.challengeBodies);
    expect(desktop.challengeBodies).toEqual([{ purpose: 'siwe' }]);
    // Same fields, same values, except the signature: ECDSA signatures from ethers are
    // deterministic (RFC 6979), so over the same message they are equal too, and are compared.
    expect(driver.verifyBodies).toEqual(desktop.verifyBodies);
    expect(Object.keys(driver.verifyBodies[0]!).sort()).toEqual(['message', 'method', 'nonce', 'pending_id', 'signature']);
  });
});
