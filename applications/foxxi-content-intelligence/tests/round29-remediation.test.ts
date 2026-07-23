/**
 * Round-29 remediation tests: the round-27 safeFetch sweep covered only the
 * DESCRIPTOR hop; the MANIFEST hop (discover) and GRAPH hop (fetchGraphContent)
 * still followed 3xx to internal hosts (round-28). guardedFetchFn is the choke
 * point — a base-fetch wrapper that re-guards every call + every redirect hop —
 * so it can be handed to discover()/fetchGraphContent() to cover those hops.
 * safeFetch additionally refuses to follow a redirect on a NON-GET request (never
 * replay a mutating body + credentials to a redirected host — the lrs-forwarding
 * POST vector).
 */

import { describe, it, expect } from 'vitest';
import { guardedFetchFn, safeFetch } from '../src/ssrf-guard.js';

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

describe('round-29 — guardedFetchFn re-guards the manifest/graph hops; safeFetch refuses non-GET redirects', () => {
  it('guardedFetchFn wraps a base fetch so a redirect to an internal host is rejected', async () => {
    const base = (async (url: string) => {
      if (url === 'https://pod.example/.well-known/context-graphs') return mockResp(302, 'http://169.254.169.254/');
      return mockResp(200);
    }) as never;
    const gfetch = guardedFetchFn(base) as (u: string, i?: unknown) => Promise<{ status: number }>;
    await expect(gfetch('https://pod.example/.well-known/context-graphs')).rejects.toThrow();
  });

  it('guardedFetchFn passes a clean public GET straight through (200)', async () => {
    const base = (async () => mockResp(200)) as never;
    const gfetch = guardedFetchFn(base) as (u: string, i?: unknown) => Promise<{ status: number }>;
    const r = await gfetch('https://pod.example/graph.ttl');
    expect(r.status).toBe(200);
  });

  it('safeFetch REFUSES to follow a redirect on a POST (no body/cred replay to a new host)', async () => {
    const base = (async (url: string) => {
      if (url === 'https://lrs.example/statements') return mockResp(308, 'http://css.railway.internal/statements');
      return mockResp(200);
    }) as never;
    await expect(safeFetch('https://lrs.example/statements', { method: 'POST', body: '{}' }, base)).rejects.toThrow(/redirect on a POST/);
  });
});
