/**
 * Attach the css-gate operator bearer to writes aimed at ONE pod origin.
 *
 * The live pods sit behind deploy/css-gate, which 401s every anonymous
 * POST/PUT/PATCH/DELETE. The bridge gets its bearer from a fetch patch in
 * bridge/server.ts, but the standalone provisioning tools
 * (tools/provision-federation-peer.mjs, tools/seed-federation-peer.mjs) never
 * load that module — so every write they made returned 401 and the federation
 * peer pod named by FOXXI_FEDERATION_PODS was never provisioned. The bridge
 * then composed SAMPLE_PEER_OUTCOMES forever without saying so. Extracted here
 * rather than copied a third time so the next standalone writer inherits it.
 *
 * Origin is compared with an EXACT === on a parsed URL, never startsWith:
 * `https://gate.interego.xwisee.com.<attacker-tld>/…` passes a startsWith check
 * and would leak the operator secret (the round-26 blocker class). Reads are
 * never decorated, so the secret cannot ride along on a GET. `redirect` is
 * forced to 'manual' on writes so a 3xx cannot carry the bearer to a new host.
 */
export function gateWriteFetch(
  podUrl: string,
  writeSecret: string | undefined,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const targetOrigin = new URL(podUrl).origin;
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (!WRITE_METHODS.has(method) || !writeSecret) return baseFetch(input, init);
    let origin: string;
    try {
      origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    } catch { return baseFetch(input, init); }
    if (origin !== targetOrigin) return baseFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('Authorization', `Bearer ${writeSecret}`);
    return baseFetch(input, { ...init, method, headers, redirect: init?.redirect ?? 'manual' });
  }) as typeof globalThis.fetch;
}
