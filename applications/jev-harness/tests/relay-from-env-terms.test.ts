/**
 * The bridge's environment reaches the agent-key minter: INTEREGO_AGENT_ACCEPT_HOSTED_TERMS_VERSION
 * goes out with the did-sig challenge of a first login, and a refusal names that variable.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. `relayFromEnv()` is the only place the deployed bridge's
 * operator can give the Hosted Terms agreement its first login needs (HTTP 428 otherwise), and
 * the minter it builds is otherwise tested only when constructed by hand. A read of the wrong name,
 * or a minter built without the value, would leave a fresh bridge unable to log in with the
 * variable set; a refusal that named the library option instead of the variable would point the
 * operator at code they do not edit.
 *
 * ★ NOTHING HERE DIALS ANYTHING. Every variable `relayFromEnv()` reads is stubbed — the relay URL
 * at an example host — and `globalThis.fetch` is replaced by a scripted relay and identity server
 * for each case, then restored. The scripted identity admits a NEW key only when its challenge
 * was asked for with the version on offer; that is the whole of the contract this question needs
 * (the signed text and its Ed25519 verification are `applications/_shared/tests/relay-agent-terms.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateAgentKeyJwk, HostedTermsRequiredError, relayFromEnv } from '../src/publish.js';

const RELAY = 'https://relay.example';
const IDENTITY = 'https://identity.example';
const CURRENT = '2026-11-06-r2';
const REFUSAL = 'Review the Hosted Interego Terms of Service and select I agree before creating an account.';
const VARIABLE = 'INTEREGO_AGENT_ACCEPT_HOSTED_TERMS_VERSION';

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/** A relay and identity server that open a new account only for a challenge asked for with CURRENT. */
function scripted(): { f: typeof fetch; challengeBodies: Array<Record<string, unknown>> } {
  const challengeBodies: Array<Record<string, unknown>> = [];
  const agreed = new Map<string, boolean>();
  let serial = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const raw = typeof init?.body === 'string' ? init.body : '';
    const body = raw.startsWith('{') ? JSON.parse(raw) as Record<string, unknown> : {};
    if (url === `${RELAY}/register`) return json(201, { client_id: 'client-1' });
    if (url.startsWith(`${RELAY}/authorize?`)) {
      return new Response(`<script>const PENDING_ID = "p1";\nconst IDENTITY = "${IDENTITY}";</script>`, { status: 200 });
    }
    if (url === `${IDENTITY}/challenges`) {
      challengeBodies.push(body);
      const nonce = `Nonce${String(++serial).padStart(12, '0')}`;
      const accepted = body['termsVersion'] === CURRENT;
      agreed.set(nonce, accepted);
      const statement = accepted ? `\nI am at least 18 and agree to the Hosted Interego Terms of Service at https://interego.example/terms/${CURRENT}/` : '';
      return json(200, { nonce, message: `Interego DID sign-in v1\nHost: identity.example\nNonce: ${nonce}${statement}` });
    }
    if (url === `${RELAY}/oauth/verify`) {
      return agreed.get(String(body['nonce'])) ? json(200, { redirect: 'http://localhost:9999/cb?code=c1' }) : json(428, { error: REFUSAL });
    }
    if (url === `${RELAY}/token`) return json(200, { access_token: 'minted-token', expires_in: 3600 });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { f, challengeBodies };
}

/** The bearer source `relayFromEnv()` built; minting it is the question, not the MCP call after it. */
const mint = (relay: unknown): Promise<string> => (relay as { cfg: { bearer: { token(): Promise<string> } } }).cfg.bearer.token();

describe('relayFromEnv() and the operator\'s Hosted Terms agreement', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubEnv('INTEREGO_RELAY_URL', `${RELAY}/mcp`);
    vi.stubEnv('INTEREGO_AGENT_KEY_JSON', JSON.stringify(generateAgentKeyJwk()));
    vi.stubEnv('INTEREGO_CLIENT_NAME', 'jev-harness-test');
    vi.stubEnv('INTEREGO_POD_NAME', '');
    vi.stubEnv('INTEREGO_BEARER', '');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it('★ with the variable set, the challenge carries exactly that termsVersion and the first login opens the account', async () => {
    vi.stubEnv(VARIABLE, CURRENT);
    const { f, challengeBodies } = scripted();
    globalThis.fetch = f;
    await expect(mint(relayFromEnv())).resolves.toBe('minted-token');
    expect(challengeBodies).toEqual([{ purpose: 'did-sig', termsVersion: CURRENT }]);
  });

  it('★ unset, nothing is agreed to, and the 428 names the variable the operator sets — not the library option', async () => {
    vi.stubEnv(VARIABLE, '');
    const { f, challengeBodies } = scripted();
    globalThis.fetch = f;
    const err = await mint(relayFromEnv()).then(() => null, (e: Error) => e);
    expect(challengeBodies).toEqual([{ purpose: 'did-sig' }]);
    expect(err).toBeInstanceOf(HostedTermsRequiredError);
    expect(err?.message).toContain('answered HTTP 428: ' + REFUSAL);
    expect(err?.message).toContain(`${VARIABLE} is not set, so none was sent`);
    expect(err?.message).not.toContain('acceptHostedTermsVersion');
  });

  it('a configured version the server no longer offers is reported as sent and not accepted, naming the variable', async () => {
    vi.stubEnv(VARIABLE, '2026-10-01');
    const { f, challengeBodies } = scripted();
    globalThis.fetch = f;
    const err = await mint(relayFromEnv()).then(() => null, (e: Error) => e);
    expect(challengeBodies).toEqual([{ purpose: 'did-sig', termsVersion: '2026-10-01' }]);
    expect(err?.message).toContain(`version 2026-10-01 (${VARIABLE}) was sent and NOT accepted`);
  });
});
