/**
 * A session key signs this bridge's requests as the wallet that granted it, and as nothing else.
 *
 * ★ WHY. A person whose key stays in a wallet extension approved every signed request in the
 * wallet: every step played, every fragment written, every read of their own work. Now the wallet
 * approves one grant (an EIP-4361 message) for a key the tab makes and keeps in memory, and the
 * key signs that bridge's requests as the wallet until the grant expires (src/session-key.ts).
 * The bridge keeps no session: each request carries its grant, and every check is made each time.
 * A grant that fails any of them refuses the request; it is never read as signed another way.
 *
 * The first half drives the bridge's own verifier (recoverSignedRequest) with real signatures; the
 * second drives the dashboard's signer against it, through a stand-in wallet extension that counts
 * what it is asked to sign.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { recoverSignedRequest } from '../src/auth.js';
import { acceptSessionKeys, checkSessionKeyGrant, sessionKeyMessage, sessionKeyPolicyFor, type SessionKeyGrant } from '../src/session-key.js';
import { signAgentRequestAs } from '../dashboard-app/src/auth/signed-request.js';
import { extensionSigner, signerAsks } from '../dashboard-app/src/auth/signer.js';
import { forgetSessionKeys, sessionFor } from '../dashboard-app/src/auth/session-key.js';

const BRIDGE = 'https://bridge.example';
const DASH = 'dash.example';
const HOUR = 60 * 60 * 1000;
const POLICY = { audience: BRIDGE, domains: [DASH], maxTtlMs: 12 * HOUR };

const sha256Hex = (s: string): string => ethers.sha256(new TextEncoder().encode(s)).slice(2);
/** A grant, as a wallet would sign it: `by` signs, for the fields given. */
async function grant(by: ethers.Wallet | ethers.HDNodeWallet, key: string, over: Partial<Omit<SessionKeyGrant, 'signature'>> = {}, actor: string = by.address): Promise<SessionKeyGrant> {
  const now = Date.now();
  const body = { domain: DASH, actor, key, audience: BRIDGE, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + HOUR).toISOString(), nonce: 'n0nce12345abc', ...over };
  return { ...body, signature: await by.signMessage(sessionKeyMessage(body)) };
}
/** A request envelope: `signer` signs a payload made as `agentId`, with the grant beside it. */
async function envelope(signer: ethers.Wallet | ethers.HDNodeWallet, agentId: string, g?: unknown): Promise<Record<string, unknown>> {
  const _signed_payload = JSON.stringify({ agent_id: agentId, timestamp: new Date().toISOString(), composition: 'urn:x' });
  return { _signed_payload, _signature: await signer.signMessage(`sha256:${sha256Hex(_signed_payload)}`), ...(g !== undefined ? { _session: g } : {}) };
}
const refused = (r: ReturnType<typeof recoverSignedRequest>): string => (r.ok ? 'accepted' : r.reason);

beforeEach(() => { acceptSessionKeys(POLICY); });
afterAll(() => { acceptSessionKeys(null); });

describe('the bridge takes a request a session key signs as the wallet that granted the key', () => {
  it('reads it as the wallet\'s own: its signer, on the DIRECT branch', async () => {
    const wallet = ethers.Wallet.createRandom();
    const key = ethers.Wallet.createRandom();
    const r = recoverSignedRequest(await envelope(key, `did:ethr:${wallet.address}`, await grant(wallet, key.address)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signer).toBe(wallet.address);
    expect(r.agentId).toBe(`did:ethr:${wallet.address}`);
    expect(r.sessionKey).toBe(key.address);
  });

  it('is granted with a Sign-In with Ethereum message that names the page, the bridge, the key and the expiry', async () => {
    const wallet = ethers.Wallet.createRandom();
    const key = ethers.Wallet.createRandom();
    const g = await grant(wallet, key.address.toLowerCase());
    const text = sessionKeyMessage(g);
    expect(text.split('\n').slice(0, 3)).toEqual([`${DASH} wants you to sign in with your Ethereum account:`, wallet.address, '']);
    expect(text).toContain(`session key ${key.address} sign Foxxi requests as you on ${BRIDGE} until ${g.expiresAt}`);
    for (const line of [`URI: ${BRIDGE}`, 'Version: 1', 'Chain ID: 1', `Nonce: ${g.nonce}`, `Issued At: ${g.issuedAt}`, `Expiration Time: ${g.expiresAt}`, `Resources:\n- urn:foxxi:session-key:${key.address}`]) {
      expect(text).toContain(line);
    }
    // The addresses are written checksummed whatever case a grant carries, so both sides build one text.
    expect(checkSessionKeyGrant(g, POLICY)).toEqual({ ok: true, actor: wallet.address, key: key.address });
  });

  it('reads a request with no grant exactly as before', async () => {
    const wallet = ethers.Wallet.createRandom();
    const r = recoverSignedRequest(await envelope(wallet, `did:ethr:${wallet.address}`));
    expect(r.ok && r.signer).toBe(wallet.address);
    expect(r.ok && r.sessionKey).toBeUndefined();
  });
});

describe('a grant that fails any check refuses the request', () => {
  const wallet = ethers.Wallet.createRandom();
  const key = ethers.Wallet.createRandom();
  const as = `did:ethr:${wallet.address}`;
  const now = Date.now();

  it('when the bridge takes no session keys', async () => {
    acceptSessionKeys(null);
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address))))).toMatch(/takes no session keys/);
  });

  it('when it is for another bridge, or asked for on a page that is not this bridge\'s dashboard', async () => {
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address, { audience: 'https://other.example' }))))).toMatch(/not this bridge/);
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address, { domain: 'evil.example' }))))).toMatch(/not a dashboard of this bridge/);
  });

  it('when it has expired, says it was made in the future, or runs longer than the bridge allows', async () => {
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address, { issuedAt: new Date(now - 2 * HOUR).toISOString(), expiresAt: new Date(now - 60_000).toISOString() }))))).toMatch(/expired/);
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address, { issuedAt: new Date(now + 10 * 60_000).toISOString(), expiresAt: new Date(now + HOUR).toISOString() }))))).toMatch(/in the future/);
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address, { expiresAt: new Date(now + 13 * HOUR).toISOString() }))))).toMatch(/runs longer/);
  });

  it('when another wallet signed it, or it was changed after signing', async () => {
    const other = ethers.Wallet.createRandom();
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(other, key.address, {}, wallet.address))))).toMatch(/not signed by the wallet it names/);
    const g = await grant(wallet, key.address);
    const longer = { ...g, expiresAt: new Date(Date.parse(g.expiresAt) + HOUR).toISOString() };
    expect(refused(recoverSignedRequest(await envelope(key, as, longer)))).toMatch(/not signed by the wallet it names/);
  });

  it('when the request was signed by any key but the one it names, the wallet\'s own included', async () => {
    const g = await grant(wallet, key.address);
    expect(refused(recoverSignedRequest(await envelope(ethers.Wallet.createRandom(), as, g)))).toMatch(/not signed by the key its grant names/);
    expect(refused(recoverSignedRequest(await envelope(wallet, as, g)))).toMatch(/not signed by the key its grant names/);
  });

  it('when the request is made as anyone but the wallet: a session key never acts through a delegation', async () => {
    const g = await grant(wallet, key.address);
    expect(refused(recoverSignedRequest(await envelope(key, 'did:web:agent.example', g)))).toMatch(/signs only as the wallet that granted it/);
    expect(refused(recoverSignedRequest(await envelope(key, `did:ethr:${ethers.Wallet.createRandom().address}`, g)))).toMatch(/signs only as the wallet that granted it/);
  });

  it('when it is not a whole grant', async () => {
    const g = await grant(wallet, key.address);
    expect(refused(recoverSignedRequest(await envelope(key, as, 'a grant')))).toMatch(/not an object/);
    const { nonce: _n, ...noNonce } = g;
    expect(refused(recoverSignedRequest(await envelope(key, as, noNonce)))).toMatch(/has no nonce/);
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address, { nonce: 'short' }))))).toMatch(/nonce/);
    expect(refused(recoverSignedRequest(await envelope(key, as, await grant(wallet, key.address, { expiresAt: 'tomorrow' }))))).toMatch(/UTC instants/);
  });

  it('is served with the bridge\'s own origin, and the hosts of the dashboards it serves', () => {
    expect(sessionKeyPolicyFor('https://bridge.example/some/path', ['https://Dash.example', 'http://localhost:5173', 'not a url'], HOUR))
      .toEqual({ audience: BRIDGE, domains: ['dash.example', 'localhost:5173'], maxTtlMs: HOUR });
    expect(sessionKeyPolicyFor('not a url', [], HOUR)).toBeNull();
  });
});

describe('the dashboard asks a wallet once, then signs with the key it granted', () => {
  /** A stand-in wallet extension that counts what it is asked to sign. */
  function extension(wallet: ethers.HDNodeWallet) {
    const signed: string[] = [];
    return {
      signed,
      async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address.toLowerCase()];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'personal_sign') {
          const [data] = params as [string];
          const text = ethers.toUtf8String(data);
          signed.push(text);
          return wallet.signMessage(text);
        }
        throw Object.assign(new Error(`${method} is not supported`), { code: 4200 });
      },
    };
  }
  let served: Record<string, unknown> | null;
  beforeEach(() => {
    forgetSessionKeys();
    served = { kind: 'foxxi-session-key-policy', version: 1, audience: BRIDGE, domains: [DASH], maxTtlSeconds: 12 * 3600 };
    vi.stubGlobal('location', { host: DASH });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${BRIDGE}/.well-known/foxxi-session-key` && served) return new Response(JSON.stringify(served), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response('{}', { status: 404 });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); forgetSessionKeys(); });

  it('asks for one grant, however many requests follow or wait for it, and the bridge reads each as the wallet', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ext = extension(wallet);
    const signer = extensionSigner(wallet.address, ext);
    expect(signerAsks({ userId: wallet.address, signingMode: 'extension', extensionAddress: wallet.address })).toBe(true);
    const [a, b] = await Promise.all([signAgentRequestAs(signer, { n: 1 }, undefined, BRIDGE), signAgentRequestAs(signer, { n: 2 }, undefined, BRIDGE)]);
    const c = await signAgentRequestAs(signer, { n: 3 }, undefined, BRIDGE);
    expect(ext.signed).toHaveLength(1);
    expect(ext.signed[0]).toMatch(new RegExp(`^${DASH} wants you to sign in with your Ethereum account:\n${wallet.address}\n`));
    for (const e of [a, b, c]) {
      const r = recoverSignedRequest(e);
      expect(r.ok && r.signer).toBe(wallet.address);
      expect(r.ok && r.sessionKey).toBe((e._session as SessionKeyGrant).key);
    }
    // Once it holds a key, a page need not wait for a click to read.
    expect(signerAsks({ userId: wallet.address, signingMode: 'extension', extensionAddress: wallet.address })).toBe(false);
    // Signing out forgets it.
    forgetSessionKeys();
    expect(signerAsks({ userId: wallet.address, signingMode: 'extension', extensionAddress: wallet.address })).toBe(true);
  });

  it('asks again when the grant it holds is nearly spent', async () => {
    const wallet = ethers.Wallet.createRandom();
    const ext = extension(wallet);
    const signer = extensionSigner(wallet.address, ext);
    const first = await sessionFor(signer, BRIDGE, { now: () => Date.now() });
    const later = await sessionFor(signer, BRIDGE, { now: () => Date.now() + HOUR - 60_000 });
    expect(ext.signed).toHaveLength(2);
    expect(later!.key.address).not.toBe(first!.key.address);
  });

  it('lets the wallet sign each request where the bridge takes no session keys for this page', async () => {
    const wallet = ethers.Wallet.createRandom();
    served = null;
    const ext = extension(wallet);
    const signer = extensionSigner(wallet.address, ext);
    const e = await signAgentRequestAs(signer, { n: 1 }, undefined, BRIDGE);
    await signAgentRequestAs(signer, { n: 2 }, undefined, BRIDGE);
    expect(ext.signed).toHaveLength(2);
    expect(e._session).toBeUndefined();
    expect(recoverSignedRequest(e)).toMatchObject({ ok: true, signer: wallet.address });
  });

  it('takes no grant from a policy that names another bridge, or not this page', async () => {
    const wallet = ethers.Wallet.createRandom();
    served = { audience: 'https://other.example', domains: [DASH], maxTtlSeconds: 3600 };
    expect(await sessionFor(extensionSigner(wallet.address, extension(wallet)), BRIDGE)).toBeNull();
    forgetSessionKeys();
    served = { audience: BRIDGE, domains: ['elsewhere.example'], maxTtlSeconds: 3600 };
    expect(await sessionFor(extensionSigner(wallet.address, extension(wallet)), BRIDGE)).toBeNull();
  });
});

describe('the bridge serves the policy it takes', () => {
  it('takes grants from its own dashboards, for itself, unless told to take none, and says so at a well-known address', () => {
    const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
    expect(src).toContain("acceptSessionKeys(process.env.FOXXI_SESSION_KEYS === 'off' ? null : sessionKeyPolicyFor(bridgeBaseUrl, ALLOWED_ORIGINS, SESSION_KEY_MAX_TTL_MS));");
    expect(src.indexOf('const ALLOWED_ORIGINS')).toBeLessThan(src.indexOf('acceptSessionKeys('));
    const route = src.slice(src.indexOf("app.get('/.well-known/foxxi-session-key'"), src.indexOf('\n});\n', src.indexOf("app.get('/.well-known/foxxi-session-key'")));
    expect(route).toContain('const p = sessionKeyPolicy();');
    expect(route).toMatch(/if \(!p\) \{ res\.status\(404\)/);
    expect(route).toContain("audience: p.audience, domains: p.domains, maxTtlSeconds: Math.floor(p.maxTtlMs / 1000),");
  });
});
