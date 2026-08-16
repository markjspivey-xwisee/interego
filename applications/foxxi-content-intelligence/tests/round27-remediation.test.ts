/**
 * Round-27 remediation tests:
 *  (1) safeFetch re-guards every redirect hop — assertSafeFetchTarget alone
 *      validates only the initial URL, so a public host that 302s to an internal
 *      address was followed unvalidated (the round-26 redirect-bypass SSRF).
 *  (2) safeFetch disables auto-redirects (redirect:'manual') so undici cannot
 *      transparently follow to a new host behind our back.
 */

import { describe, it, expect } from 'vitest';
import { safeFetch } from '../src/ssrf-guard.js';

type Init = { headers?: Record<string, string>; method?: string; redirect?: string };
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

describe('round-27 — safeFetch re-guards redirects + refuses auto-follow', () => {
  /**
   * ★ THE ONLY CASE HERE THAT TOUCHES A REAL RESOLVER, AND THE TIMEOUT SAYS SO.
   *
   * `fetchFn` is mocked, so nothing reaches the network — but the guard under test is not mocked,
   * and `ssrf-guard.ts` calls `lookup` from `node:dns/promises` to decide whether a host is
   * private. This case is the only one that passes HOSTNAMES (`pod.example`, `other.example`); the
   * other two use IP literals and resolve nothing. So its runtime is bounded by however long the
   * machine's resolver takes to answer for a name that does not exist.
   *
   * MEASURED: green on eight consecutive commits, then "Test timed out in 5000ms" on a CI run
   * where the suite took 313 s — two NXDOMAIN lookups on a loaded runner, against vitest's 5 s
   * default. It reproduces nowhere locally, because a developer's resolver answers immediately.
   *
   * The timeout is raised rather than the lookup stubbed: stubbing would leave the DNS branch of
   * an SSRF guard untested, which is the branch the whole file exists to cover.
   */
  it('follows a redirect to a PUBLIC host (re-guarded) and returns the final 200', async () => {
    const calls: Array<{ url: string; redirect?: string }> = [];
    const fetchFn = (async (url: string, init?: Init) => {
      calls.push({ url, redirect: init?.redirect });
      if (url === 'https://pod.example/desc.ttl') return mockResp(302, 'https://other.example/real.ttl');
      return mockResp(200);
    }) as never;
    const r = await safeFetch('https://pod.example/desc.ttl', {}, fetchFn);
    expect(r.status).toBe(200);
    // Both hops used redirect:'manual' (never auto-follow).
    expect(calls.every(c => c.redirect === 'manual')).toBe(true);
    expect(calls.map(c => c.url)).toEqual(['https://pod.example/desc.ttl', 'https://other.example/real.ttl']);
  }, 30_000);

  it('REJECTS a redirect whose Location is an internal address (the SSRF bypass)', async () => {
    const fetchFn = (async (url: string, init?: Init) => {
      if (url === 'https://pod.example/desc.ttl') return mockResp(302, 'http://169.254.169.254/latest/meta-data/');
      return mockResp(200);
    }) as never;
    await expect(safeFetch('https://pod.example/desc.ttl', {}, fetchFn)).rejects.toThrow();
  });

  it('REJECTS an initial target that resolves to a private literal', async () => {
    const fetchFn = (async () => mockResp(200)) as never;
    await expect(safeFetch('http://127.0.0.1:6080/x', {}, fetchFn)).rejects.toThrow();
  });
});
