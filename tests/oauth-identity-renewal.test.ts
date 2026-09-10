import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InteregoOAuthProvider, renewIdentityToken } from '../deploy/mcp-relay/oauth-provider.js';

const identity = { userId: 'user', agentId: 'did:web:identity.example:agents:agent', ownerWebId: 'https://identity.example/users/user/profile', podUrl: 'https://pod.example/user/', identityToken: 'old-identity' };
const client = { client_id: 'client', redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'none' as const };
function fixture(renew: (value: Readonly<typeof identity>) => Promise<string>) {
  const expiresAt = Date.now() + 86400_000;
  const provider = new InteregoOAuthProvider({ identityUrl: 'https://identity.example', renewIdentityToken: renew,
    initialRefreshTokensBySha: new Map([[createHash('sha256').update('refresh').digest('hex'), { clientId: 'client', scopes: ['mcp'], identity, expiresAt }]]) });
  return provider;
}

describe('OAuth identity renewal', () => {
  it('renews the same identity before rotation and retains it for the next refresh', async () => {
    const renew = vi.fn(async () => 'fresh-identity'); const provider = fixture(renew);
    const tokens = await provider.exchangeRefreshToken(client, 'refresh');
    expect(renew).toHaveBeenCalledWith(identity);
    expect((await provider.verifyAccessToken(tokens.access_token)).extra).toMatchObject({ ...identity, identityToken: 'fresh-identity' });
    await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect(renew).toHaveBeenLastCalledWith({ ...identity, identityToken: 'fresh-identity' });
    await expect(provider.exchangeRefreshToken(client, 'refresh')).rejects.toThrow();
  });
  it('preserves the original refresh grant after a transient renewal failure', async () => {
    let fail = true; const provider = fixture(async () => { if (fail) throw new Error('temporary'); return 'fresh'; });
    await expect(provider.exchangeRefreshToken(client, 'refresh')).rejects.toThrow('temporary');
    fail = false;
    expect((await provider.exchangeRefreshToken(client, 'refresh')).access_token).toBeTruthy();
  });
  it('allows exactly one rotation when concurrent identity renewals finish', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const renew = vi.fn(async () => { await gate; return 'fresh'; }); const provider = fixture(renew);
    const a = provider.exchangeRefreshToken(client, 'refresh'); const b = provider.exchangeRefreshToken(client, 'refresh');
    release(); const result = await Promise.allSettled([a, b]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('refuses client changes and expanded scopes before contacting identity', async () => {
    const renew = vi.fn(async () => 'fresh'); const provider = fixture(renew);
    await expect(provider.exchangeRefreshToken({ ...client, client_id: 'other' }, 'refresh')).rejects.toThrow('Client ID');
    await expect(provider.exchangeRefreshToken(client, 'refresh', ['mcp', 'admin'])).rejects.toThrow('scopes');
    expect(renew).not.toHaveBeenCalled();
  });
  it('uses the existing authenticated same-actor endpoint and fails closed on expiry', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ token: 'fresh', expiresAt: new Date(Date.now() + 86400_000).toISOString() })));
    expect(await renewIdentityToken('https://identity.example', identity, fetcher)).toBe('fresh');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://identity.example/tokens');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer old-identity' } });
    expect(JSON.parse(String(init!.body))).toEqual({ userId: 'user', agentId: 'agent' });
    fetcher.mockResolvedValue(new Response('', { status: 401 }));
    await expect(renewIdentityToken('https://identity.example', identity, fetcher)).rejects.toMatchObject({ code: 'invalid_grant' });
    fetcher.mockResolvedValue(new Response('', { status: 503 }));
    await expect(renewIdentityToken('https://identity.example', identity, fetcher)).rejects.toThrow('temporarily unavailable');
  });
  it('maps the public DID over an internal transport and refuses a foreign authority', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ token: 'fresh', expiresAt: new Date(Date.now() + 86400_000).toISOString() })));
    await renewIdentityToken('http://identity:8090', identity, fetcher);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://identity:8090/tokens');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({ userId: 'user', agentId: 'agent' });
    fetcher.mockClear();
    await expect(renewIdentityToken('https://identity.example', { ...identity, agentId: 'did:web:foreign.example:agents:agent' }, fetcher)).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
