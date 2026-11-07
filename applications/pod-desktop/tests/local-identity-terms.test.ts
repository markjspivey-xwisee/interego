/**
 * Installed-app sign-in with a key that has no hosted account says WHY it was refused, and
 * never agrees to the Hosted Terms on anybody's behalf.
 *
 * ★ WHAT THIS FILE EXISTS TO CATCH. Hosted identity opens a new account only with the Hosted
 * Interego Terms agreement and answers any other first sign-in HTTP 428, which the relay's
 * `/oauth/verify` forwards. Installed-app sign-in signs the relay's fixed three-line challenge and
 * nothing else, so an unlinked key reaches that 428 — and the app reported it as "Sign-in could
 * not be confirmed. Start a new sign-in rather than retrying", which sent people round a loop no
 * retry could leave. The refusal is now named, with what does work (linking the key first).
 *
 * The signed text is unchanged: the challenge the app signs is still exactly the relay's.
 */

import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { LocalIdentityService, type LocalIdentityServiceOptions } from '../src/local-identity.js';
import { identityHash } from '../src/local-identity-protocol.js';
import { localIdentityJson, HostedTermsRefusal } from '../src/local-identity-network.js';
import type { LocalIdentityContext } from '../src/local-identity-types.js';

const relay = 'https://relay.example.com';
const provider = 'https://identity.example.com';
const callback = 'https://client.example.com/callback';
const token = (): string => randomBytes(32).toString('base64url');
const now = Date.parse('2026-10-30T12:00:00Z');

function context(): LocalIdentityContext {
  const nonce = token();
  return { version: 1, issuer: relay, identityOrigin: provider, pendingId: 'pending-authorization-0123456789', clientId: 'registered-client', clientName: 'My website',
    redirectUri: callback, scopes: ['mcp:read'], resource: relay + '/mcp', codeChallenge: token(), stateDigest: identityHash('original-oauth-state'),
    expiresAt: new Date(now + 600_000).toISOString(), nonce, message: `Interego DID sign-in v1\nHost: identity.example.com\nNonce: ${nonce}`, challengeExpiresAt: new Date(now + 300_000).toISOString(),
    completionCode: 'interego-login-result:v1:' + token() + '.' + token() };
}

async function signInAnswered(verify: () => Response) {
  let saved: unknown = null;
  const meta = context();
  const signed: string[] = [];
  const fetcher: typeof fetch = async (request, init) => {
    const req = new Request(request, init);
    const path = new URL(req.url).pathname;
    if (path === '/oauth/local-identity/context') return Response.json(meta);
    if (path === '/oauth/verify') { signed.push(String((JSON.parse(await req.text()) as { signature?: string }).signature)); return verify(); }
    throw new Error('Unexpected endpoint.');
  };
  const options: LocalIdentityServiceOptions = {
    store: { load: vi.fn(async () => structuredClone(saved)), save: vi.fn(async (value) => { saved = structuredClone(value); }) },
    binding: async () => 'this-local-pod', trustedRelays: [{ relayOrigin: relay, identityOrigin: provider }], fetch: fetcher, now: () => now,
  };
  const service = new LocalIdentityService(options);
  await service.setup();
  const ticket = await service.request({ relayOrigin: relay, handoffCode: 'interego-login:v1:' + token() + '.' + token() }, 'native-channel-a');
  const approved = await service.approve(ticket.id, ticket.verificationCode).then(() => null, (e: Error) => e);
  return { approved, poll: service.poll(ticket.id, ticket.receipt, 'native-channel-a'), signed };
}

describe('installed-app sign-in and the Hosted Terms', () => {
  it('★ a 428 from hosted identity is named — no account for this key, link it first — and nothing invites a retry', async () => {
    const r = await signInAnswered(() => Response.json({ error: 'Review the Hosted Interego Terms of Service and select I agree before creating an account.' }, { status: 428 }));
    expect(r.signed).toHaveLength(1);
    expect(r.approved?.message).toContain('Hosted Interego has no account for this key');
    expect(r.approved?.message).toContain('Link this key to your existing account first');
    expect(r.poll).toEqual({ state: 'failed', message: r.approved?.message });
    expect(r.poll.state === 'failed' && r.poll.message).not.toMatch(/retry/i);
    // Under the native host's own ceiling for a message it relays.
    expect(String(r.approved?.message).length).toBeLessThanOrEqual(350);
  });

  it('every other refusal keeps the generic copy, and its body never crosses', async () => {
    const r = await signInAnswered(() => Response.json({ error: 'secret server detail' }, { status: 401 }));
    expect(r.approved?.message).toBe('Sign-in could not be confirmed. Start a new sign-in rather than retrying this request.');
    expect(JSON.stringify(r.poll)).not.toContain('secret server detail');
  });

  it('the 428 is told apart by status alone: its body is dropped, and a redirected 428 is not trusted', async () => {
    const signal = new AbortController().signal;
    await expect(localIdentityJson(new Response('{"error":"anything"}', { status: 428, headers: { 'content-type': 'application/json' } }), signal))
      .rejects.toBeInstanceOf(HostedTermsRefusal);
    const redirected = new Response('{}', { status: 428, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(redirected, 'redirected', { value: true });
    await expect(localIdentityJson(redirected, signal)).rejects.not.toBeInstanceOf(HostedTermsRefusal);
  });
});
