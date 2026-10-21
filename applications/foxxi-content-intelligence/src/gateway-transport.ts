/** Keep public pod identifiers while sending this deployment's gateway traffic privately.
 * The configured transport is the SAME gate, never the allow-all CSS backend.
 * Outer SSRF screens still validate the public logical URL before this wrapper runs.
 */
export interface GatewayTransportConfig {
  publicPodUrl: string;
  internalGatewayUrl?: string;
}

export function gatewayTransport(fetchFn: typeof fetch, config: GatewayTransportConfig): typeof fetch {
  if (!config.internalGatewayUrl) return fetchFn;
  const publicUrl = new URL(config.publicPodUrl);
  const internal = new URL(config.internalGatewayUrl);
  for (const url of [publicUrl, internal]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('gateway transport requires configured HTTP(S) origins without credentials, query or fragment');
    }
  }
  if (internal.pathname !== '/') throw new Error('internal gateway transport must name an origin, not a resource path');
  const logicalOrigin = publicUrl.origin;
  const logicalResponse = (response: Response, url: string): Response => {
    // URL-based parsers must resolve relative links against the logical public address.
    Object.defineProperty(response, 'url', { value: url, configurable: true });
    const clone = response.clone.bind(response);
    response.clone = () => logicalResponse(clone(), url);
    return response;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try { url = new URL(raw); } catch { return fetchFn(input, init); }
    // Exact origin only: other tenants, lookalike hosts and unrelated services never move.
    if (url.origin !== logicalOrigin) return fetchFn(input, init);
    if (url.username || url.password) throw new Error('gateway request URL must not contain credentials');
    const request = new Request(input, init);
    const target = new URL(request.url);
    target.protocol = internal.protocol;
    target.host = internal.host;
    const headers = new Headers(request.headers);
    headers.set('Host', publicUrl.host);
    // Never let an internal transport automatically follow a redirect to another service.
    // Existing outer safeFetch handles public redirect targets with its usual guards.
    const transported = new Request(target, new Request(request, { headers, redirect: 'manual' }));
    return logicalResponse(await fetchFn(transported), request.url);
  }) as typeof fetch;
}
