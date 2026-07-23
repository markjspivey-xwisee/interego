/**
 * Round-35: the round-33 redirect fix was READ-only — the persist/WRITE twins
 * (casPersist, persistRecordedStatement, publishAgentEncryptionKey, issue-credential)
 * still followed 3xx to internal via the raw fetch, reachable any-wallet through
 * record_performance -> attacker-origin perfPod. They now route their writes through
 * guardedFetchFn. This asserts the write-path property those fixes rely on: a PUT
 * (like a DELETE) is a NON-GET, so safeFetch REFUSES to follow a redirect — the pod
 * write body + credentials are never replayed to a redirected internal host.
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

describe('round-35 — write-path (PUT) redirects are refused; guardedFetchFn re-guards the persist write', () => {
  it('safeFetch REFUSES to follow a redirect on a PUT (persist/publish write cannot hit a redirected internal host)', async () => {
    const base = (async (url: string) => {
      if (url === 'https://pod.example/eth-self/foxxi-records/rec.ttl') return mockResp(308, 'http://169.254.169.254/x');
      return mockResp(201);
    }) as never;
    await expect(safeFetch('https://pod.example/eth-self/foxxi-records/rec.ttl', { method: 'PUT', body: '<x> a <y> .' }, base)).rejects.toThrow(/redirect on a PUT/);
  });

  it('guardedFetchFn wrapping the write fetch rejects a PUT that 302s to an internal host', async () => {
    const base = (async (url: string) => {
      if (url === 'https://attacker.example/eth-self/keys/encryption.json') return mockResp(302, 'http://10.0.0.5/');
      return mockResp(201);
    }) as never;
    const gfetch = guardedFetchFn(base) as (u: string, i?: unknown) => Promise<{ status: number }>;
    await expect(gfetch('https://attacker.example/eth-self/keys/encryption.json', { method: 'PUT', body: '{}' })).rejects.toThrow();
  });

  it('guardedFetchFn passes a clean public PUT (201) straight through', async () => {
    const base = (async () => mockResp(201)) as never;
    const gfetch = guardedFetchFn(base) as (u: string, i?: unknown) => Promise<{ status: number }>;
    expect((await gfetch('https://pod.example/eth-self/foxxi-records/rec.ttl', { method: 'PUT', body: 'x' })).status).toBe(201);
  });
});
