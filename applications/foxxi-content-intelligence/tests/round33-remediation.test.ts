/**
 * Round-33: the redirect-follow SSRF class had 3 more sites the guardedFetchFn
 * choke point hadn't reached (round-32): the shared-lattice pod read, the
 * void-credential GET+DELETE, and the pre-auth delegation reads. All now route
 * through safeFetch / guardedFetchFn. This asserts the safeFetch behaviors those
 * fixes rely on — in particular that a DELETE (void-credential's delete of the
 * credential graph + descriptor) refuses to follow a 3xx (never issue the DELETE
 * against a redirected internal host, and never turn the echoed status into an
 * internal-service oracle).
 */

import { describe, it, expect } from 'vitest';
import { safeFetch, guardedFetchFn } from '../src/ssrf-guard.js';

function mockResp(status: number, location?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (n: string) => (n.toLowerCase() === 'location' ? (location ?? null) : null) },
    text: async () => 'body',
    json: async () => ({}),
  };
}

describe('round-33 — void-credential DELETE + delegation-read redirects are re-guarded', () => {
  it('safeFetch REFUSES to follow a redirect on a DELETE (void-credential delete cannot hit a redirected internal host)', async () => {
    const base = (async (url: string) => {
      if (url === 'https://pod.example/eth-self/creds/x.ttl') return mockResp(302, 'http://169.254.169.254/x');
      return mockResp(204);
    }) as never;
    await expect(safeFetch('https://pod.example/eth-self/creds/x.ttl', { method: 'DELETE' }, base)).rejects.toThrow(/redirect on a DELETE/);
  });

  it('guardedFetchFn (used for the delegation reads) rejects a redirect to an internal host', async () => {
    const base = (async (url: string) => {
      if (url === 'https://attacker.example/agents/registry.ttl') return mockResp(302, 'http://127.0.0.1:6080/');
      return mockResp(200);
    }) as never;
    const gfetch = guardedFetchFn(base) as (u: string, i?: unknown) => Promise<{ status: number }>;
    await expect(gfetch('https://attacker.example/agents/registry.ttl')).rejects.toThrow();
  });

  it('guardedFetchFn passes a clean public delegation read straight through', async () => {
    const base = (async () => mockResp(200)) as never;
    const gfetch = guardedFetchFn(base) as (u: string, i?: unknown) => Promise<{ status: number }>;
    expect((await gfetch('https://pod.example/agents/registry.ttl')).status).toBe(200);
  });
});
