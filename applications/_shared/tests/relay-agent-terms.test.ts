/**
 * A service agent's FIRST login answers the Hosted Terms offer only when its operator said so,
 * and a refusal reaches the operator in the server's own words.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. Since hosted identity began requiring the Hosted Interego
 * Terms for a NEW account (HTTP 428 `hosted_terms_required`), a service holding a fresh agent key
 * (jev-harness, the fleet's evidence publisher, anything built on `relay-agent`) could not log in
 * at all, and the minter reported it as `relay /oauth/verify responded 428: {...}` — a failed step,
 * with no way to answer it short of editing the code. Agreeing silently would have been worse.
 *
 * ★ THE FAKE IS THE IDENTITY CONTRACT FOR did-sig, as `deploy/identity/server.ts` implements it:
 * `/challenges` issues a base64url nonce and the message `Interego DID sign-in v1\nHost: …\nNonce: …`,
 * with `\n<statement>` appended only when the body's `termsVersion` is exactly the version on
 * offer; `/auth/did` (reached through the relay's `/oauth/verify`) verifies the Ed25519 signature
 * over that message and admits an UNKNOWN DID only when it signed the message that carried the
 * statement. A known DID signs in whatever it asked for. The signature is really verified, so a
 * test cannot pass by naming a key it does not hold.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import {
  DidChallengeRefusedError, DidTokenMinter, HostedTermsRequiredError, agentKeyFromJwk, checkDidChallenge, generateAgentKeyJwk,
  relayForAgent, type AgentKey,
} from '../relay-agent/index.js';

const RELAY = 'https://relay.example';
const IDENTITY = 'https://identity.example';
const CURRENT = '2026-11-06-r2';
const STALE = '2026-10-01';
const statementFor = (v: string): string => `I am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/${v}/`;
const REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';

interface Fleet {
  readonly challengeBodies: Array<Record<string, unknown>>;
  /** The text each /oauth/verify signature was verified over, in order. */
  readonly signedTexts: string[];
  /** DIDs that hold an account. */
  readonly accounts: Set<string>;
  verifyCalls: number;
  /** Client registrations: a refusal no registration can answer must not cause a second one. */
  registerCalls: number;
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/** One agent key and its public half, so the fake can verify what the minter signed. */
function agent(): { key: AgentKey; x: string } {
  const jwk = generateAgentKeyJwk();
  return { key: agentKeyFromJwk(jwk), x: String(jwk.x) };
}

function fleet(opts: {
  known?: readonly string[];
  /** Keys the fake can verify signatures for, by DID. */
  publicKeys: ReadonlyMap<string, string>;
  /** Make /challenges append this line whatever was asked — a server that misbehaves. */
  volunteer?: string;
  /** Replace the issued nonce — a server that misbehaves. */
  nonce?: string;
}): { f: typeof fetch; state: Fleet } {
  const state: Fleet = { challengeBodies: [], signedTexts: [], accounts: new Set(opts.known ?? []), verifyCalls: 0, registerCalls: 0 };
  const challenges = new Map<string, { message: string; termsVersion?: string }>();
  let serial = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? String(init.body) : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {};
    if (url === `${RELAY}/register`) { state.registerCalls += 1; return json(201, { client_id: 'client-1' }); }
    if (url.startsWith(`${RELAY}/authorize?`)) {
      return new Response(`<script>const PENDING_ID = "p1";\nconst IDENTITY = "${IDENTITY}";</script>`, { status: 200 });
    }
    if (url === `${IDENTITY}/challenges`) {
      state.challengeBodies.push(body);
      expect(body['purpose']).toBe('did-sig');
      const nonce = opts.nonce ?? `Nonce${String(++serial).padStart(12, '0')}_x-y`;
      const accepted = body['termsVersion'] === CURRENT;
      let message = `Interego DID sign-in v1\nHost: identity.example\nNonce: ${nonce}`;
      if (accepted) message += `\n${statementFor(CURRENT)}`;
      if (opts.volunteer !== undefined) message += `\n${opts.volunteer}`;
      challenges.set(nonce, { message, ...(accepted ? { termsVersion: CURRENT } : {}) });
      return json(200, { nonce, message, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    }
    if (url === `${RELAY}/oauth/verify`) {
      state.verifyCalls += 1;
      expect(body['method']).toBe('did');
      const did = String(body['did']);
      const ch = challenges.get(String(body['nonce']));
      if (!ch) return json(401, { error: 'Unknown or expired nonce' });
      challenges.delete(String(body['nonce']));
      const x = opts.publicKeys.get(did);
      if (!x) return json(401, { error: 'unknown key' });
      const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
      const ok = edVerify(null, Buffer.from(ch.message, 'utf8'), pub, Buffer.from(String(body['signature']), 'base64url'));
      if (!ok) return json(401, { error: 'DID signature verification failed' });
      state.signedTexts.push(ch.message);
      if (!state.accounts.has(did)) {
        const agreed = ch.termsVersion === CURRENT && ch.message.endsWith(`\n${statementFor(CURRENT)}`);
        if (!agreed) return json(428, { error: REFUSAL });
        state.accounts.add(did);
      }
      return json(200, { redirect: 'http://localhost:9999/cb?code=c1' });
    }
    if (url === `${RELAY}/token`) return json(200, { access_token: 'minted-token', expires_in: 3600 });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { f, state };
}

describe('a service agent\'s first login and the Hosted Terms', () => {
  it('★ a NEW key with no operator agreement asks for none, and the 428 reaches the operator in the server\'s words, naming the option', async () => {
    const a = agent();
    const { f, state } = fleet({ publicKeys: new Map([[a.key.did, a.x]]) });
    const minter = new DidTokenMinter({ relayOrigin: RELAY, key: a.key, fetchImpl: f });
    const err = await minter.token().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(HostedTermsRequiredError);
    expect(err?.message).toContain('relay /oauth/verify answered HTTP 428: ' + REFUSAL);
    expect(err?.message).toContain('acceptHostedTermsVersion is not set, so none was sent');
    expect((err as HostedTermsRequiredError).sentVersion).toBeUndefined();
    expect(state.challengeBodies).toEqual([{ purpose: 'did-sig' }]);
    // Not retried with a fresh registration: no registration answers a 428.
    expect(state.registerCalls).toBe(1);
    // Nothing was agreed: the text the key signed carries no statement, and no account was made.
    expect(state.signedTexts[0]).not.toContain('Hosted Interego Terms');
    expect(state.accounts.size).toBe(0);
  });

  it('★ the operator\'s exact version is sent, the server\'s statement is what the key signs, and the account opens', async () => {
    const a = agent();
    const { f, state } = fleet({ publicKeys: new Map([[a.key.did, a.x]]) });
    const minter = new DidTokenMinter({ relayOrigin: RELAY, key: a.key, fetchImpl: f, acceptHostedTermsVersion: CURRENT });
    await expect(minter.token()).resolves.toBe('minted-token');
    expect(state.challengeBodies).toEqual([{ purpose: 'did-sig', termsVersion: CURRENT }]);
    expect(state.signedTexts[0]!.endsWith(`\n${statementFor(CURRENT)}`)).toBe(true);
    expect(state.accounts.has(a.key.did)).toBe(true);
  });

  it('an agent that already has an account signs in without any agreement, as it always did', async () => {
    const a = agent();
    const { f, state } = fleet({ known: [a.key.did], publicKeys: new Map([[a.key.did, a.x]]) });
    await expect(new DidTokenMinter({ relayOrigin: RELAY, key: a.key, fetchImpl: f }).token()).resolves.toBe('minted-token');
    expect(state.challengeBodies).toEqual([{ purpose: 'did-sig' }]);
    expect(state.signedTexts[0]).not.toContain('Hosted Interego Terms');
  });

  it('a version the server no longer offers still lets an existing account in, and a new one is refused rather than agreed for', async () => {
    const known = agent();
    const fresh = agent();
    const { f, state } = fleet({ known: [known.key.did], publicKeys: new Map([[known.key.did, known.x], [fresh.key.did, fresh.x]]) });
    await expect(new DidTokenMinter({ relayOrigin: RELAY, key: known.key, fetchImpl: f, acceptHostedTermsVersion: STALE }).token())
      .resolves.toBe('minted-token');
    const err = await new DidTokenMinter({ relayOrigin: RELAY, key: fresh.key, fetchImpl: f, acceptHostedTermsVersion: STALE }).token()
      .then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/answered HTTP 428/);
    // ★ SAYS THE CONFIGURED VERSION WENT AND WAS NOT ACCEPTED — a different fix from setting one.
    expect(err?.message).toContain(`version ${STALE} (acceptHostedTermsVersion) was sent and NOT accepted`);
    expect((err as HostedTermsRequiredError).sentVersion).toBe(STALE);
    expect(state.challengeBodies.map((b) => b['termsVersion'])).toEqual([STALE, STALE]);
    expect(state.signedTexts.every((t) => !t.includes('Hosted Interego Terms'))).toBe(true);
  });

  it('★ a challenge carrying an agreement nobody asked for is not signed at all', async () => {
    const a = agent();
    const { f, state } = fleet({ known: [a.key.did], publicKeys: new Map([[a.key.did, a.x]]), volunteer: statementFor(CURRENT) });
    const err = await new DidTokenMinter({ relayOrigin: RELAY, key: a.key, fetchImpl: f }).token().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(DidChallengeRefusedError);
    expect(err?.message).toMatch(/did not give .*nothing was signed/);
    expect(state.verifyCalls).toBe(0);
    // ★ ONE challenge, ONE registration: a refused challenge is not "the relay forgot this client".
    expect(state.challengeBodies).toHaveLength(1);
    expect(state.registerCalls).toBe(1);
  });

  it('★ an agreement to a version other than the operator\'s is not signed', async () => {
    const a = agent();
    const { f, state } = fleet({ publicKeys: new Map([[a.key.did, a.x]]), volunteer: statementFor('2027-01-01') });
    const err = await new DidTokenMinter({
      relayOrigin: RELAY, key: a.key, fetchImpl: f, acceptHostedTermsVersion: CURRENT, acceptHostedTermsSetting: 'INTEREGO_FLEET_ACCEPT_HOSTED_TERMS_VERSION',
    }).token().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(DidChallengeRefusedError);
    expect(err?.message).toContain(`does not name version ${CURRENT}, the one this agent's operator agreed to (INTEREGO_FLEET_ACCEPT_HOSTED_TERMS_VERSION)`);
    expect(state.verifyCalls).toBe(0);
    expect(state.registerCalls).toBe(1);
  });

  it('a nonce that could carry a line break into the signed text is refused', async () => {
    const a = agent();
    const { f, state } = fleet({ known: [a.key.did], publicKeys: new Map([[a.key.did, a.x]]), nonce: 'abcdefgh\nURI: elsewhere' });
    const err = await new DidTokenMinter({ relayOrigin: RELAY, key: a.key, fetchImpl: f }).token().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(DidChallengeRefusedError);
    expect(err?.message).toMatch(/nonce .*nothing was signed/);
    expect(state.verifyCalls).toBe(0);
    expect(state.registerCalls).toBe(1);
  });

  it('★ a refusal names WHERE the operator sets the version, when the caller says — not the option name', async () => {
    const a = agent();
    const { f } = fleet({ publicKeys: new Map([[a.key.did, a.x]]) });
    const err = await new DidTokenMinter({ relayOrigin: RELAY, key: a.key, fetchImpl: f, acceptHostedTermsSetting: 'INTEREGO_AGENT_ACCEPT_HOSTED_TERMS_VERSION' })
      .token().then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(HostedTermsRequiredError);
    expect(err?.message).toContain('INTEREGO_AGENT_ACCEPT_HOSTED_TERMS_VERSION is not set, so none was sent');
    expect(err?.message).toContain('set INTEREGO_AGENT_ACCEPT_HOSTED_TERMS_VERSION to that exact version');
    expect(err?.message).not.toContain('acceptHostedTermsVersion');
  });

  it('a challenge carrying an agreement the operator did not give names the unset variable', () => {
    const message = `Interego DID sign-in v1\nHost: x\nNonce: abcdefgh\n${statementFor(CURRENT)}`;
    expect(() => checkDidChallenge({ nonce: 'abcdefgh', message }, undefined, 'INTEREGO_FLEET_ACCEPT_HOSTED_TERMS_VERSION'))
      .toThrow(/did not give \(INTEREGO_FLEET_ACCEPT_HOSTED_TERMS_VERSION is not set\)/);
  });

  it('checkDidChallenge leaves a message with no agreement exactly as sent, and the bare nonce when there is no message', () => {
    const odd = ' Interego DID sign-in v9\r\nHost: x\nNonce: abcdefgh\n';
    expect(checkDidChallenge({ nonce: 'abcdefgh', message: odd }, undefined)).toBe(odd);
    expect(checkDidChallenge({ nonce: 'abcdefgh', message: odd }, CURRENT)).toBe(odd);
    expect(checkDidChallenge({ nonce: 'abcdefgh' }, undefined)).toBe('abcdefgh');
  });
});

describe('relayForAgent carries the operator\'s agreement to the minter', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  // The MCP endpoint is not part of this question; minting the bearer is.
  const mint = (c: unknown): Promise<string> => (c as { cfg: { bearer: { token(): Promise<string> } } }).cfg.bearer.token();

  it('sends the configured version, and nothing when none is configured', async () => {
    const a = agent();
    const jwk = JSON.stringify(generateAgentKeyJwk());
    const other = agentKeyFromJwk(jwk);
    const { f, state } = fleet({ known: [other.did], publicKeys: new Map([[a.key.did, a.x], [other.did, String(JSON.parse(jwk).x)]]) });
    globalThis.fetch = f;
    const withAgreement = relayForAgent({ keyJson: jwk, relayUrl: `${RELAY}/mcp`, clientName: 'svc', acceptHostedTermsVersion: CURRENT });
    const without = relayForAgent({ keyJson: jwk, relayUrl: `${RELAY}/mcp`, clientName: 'svc' });
    await mint(withAgreement);
    await mint(without);
    expect(state.challengeBodies).toEqual([{ purpose: 'did-sig', termsVersion: CURRENT }, { purpose: 'did-sig' }]);
  });

  it('carries the caller\'s setting name into a refusal (tools/fleet-event.ts passes its own variable)', async () => {
    const jwk = JSON.stringify(generateAgentKeyJwk());
    const key = agentKeyFromJwk(jwk);
    const { f } = fleet({ publicKeys: new Map([[key.did, String(JSON.parse(jwk).x)]]) });
    globalThis.fetch = f;
    const relay = relayForAgent({
      keyJson: jwk, relayUrl: `${RELAY}/mcp`, clientName: 'interego-fleet', acceptHostedTermsSetting: 'INTEREGO_FLEET_ACCEPT_HOSTED_TERMS_VERSION',
    });
    const err = await mint(relay).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(HostedTermsRequiredError);
    expect(err?.message).toContain('set INTEREGO_FLEET_ACCEPT_HOSTED_TERMS_VERSION to that exact version');
  });
});
