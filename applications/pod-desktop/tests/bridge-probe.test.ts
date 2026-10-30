import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyBridgeRoute } from '../src/bridge-probe.js';

const origin = 'https://memory.example.com';
const proof = { path: '/.well-known/interego-bridge', expected: 'fresh-per-listener-challenge' };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('public bridge route verification', () => {
  it('requires the fresh local listener nonce and sends no notes or credentials', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ challenge: proof.expected }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    await verifyBridgeRoute(origin, proof, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(`${origin}${proof.path}`); expect(options.redirect).toBe('manual');
    expect(options.body).toBeUndefined(); expect(new Headers(options.headers).has('authorization')).toBe(false);
  });

  it('does not follow redirects to a different service and stops promptly on cancellation', async () => {
    const canceled = new AbortController();
    const fetcher = vi.fn(async () => { canceled.abort(); return new Response(null, { status: 302, headers: { location: 'https://other.example.com' } }); });
    vi.stubGlobal('fetch', fetcher);
    await expect(verifyBridgeRoute(origin, proof, canceled.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('never accepts another listener nonce or an oversized response', async () => {
    for (const body of [JSON.stringify({ challenge: 'previous-session' }), 'x'.repeat(4097)]) {
      const canceled = new AbortController();
      const fetcher = vi.fn(async () => { canceled.abort(); return new Response(body, { headers: { 'content-type': 'application/json' } }); });
      vi.stubGlobal('fetch', fetcher);
      await expect(verifyBridgeRoute(origin, proof, canceled.signal)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it('rejects an untrusted path before making a request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(verifyBridgeRoute(origin, { ...proof, path: '/notes' }, new AbortController().signal)).rejects.toThrow('public address');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
