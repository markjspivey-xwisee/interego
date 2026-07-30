/**
 * The two things every MCP-over-HTTP mount must get right, in ONE place.
 *
 * Three surfaces in this repo mount MCP over Express — the shared vertical-bridge (7
 * verticals), the substrate demo bridge, and the personal-bridge example. Each needs its
 * own thin wiring, but two pieces are security- or availability-relevant and must never
 * drift between them. Both were learned the hard way:
 *
 *  1. {@link protocolMembersOnly} — a middleware-injected top-level field took the live
 *     foxxi bridge to HTTP 400 on every request.
 *  2. {@link acceptForSdkTransport} — the SDK's streamable transport answers 406 unless
 *     the client accepts BOTH application/json and text/event-stream, and every browser
 *     client we ship sends no Accept header at all.
 *
 * Neither is express-specific, so they live here rather than in a bridge — and here is
 * a package both the applications tree and the demos tree already depend on and that
 * every image already builds.
 */

/**
 * Strip non-protocol top-level members from a JSON-RPC message.
 *
 * ★ WHY. A JSON-RPC 2.0 message has exactly `jsonrpc`, `method`, `params` and `id`. A
 * hand-rolled mount reads the members it cares about and silently ignores the rest; the
 * MCP SDK VALIDATES the message and rejects an unknown top-level member with
 * `-32600 "the request body is not a valid JSON-RPC message"`.
 *
 * That is not hypothetical. The foxxi bridge's auth middleware injects `__client_ip` and
 * `__caller_token` at the TOP LEVEL of `req.body` as well as into `params.arguments`, so
 * the moment its mount moved to the SDK every request 400'd — while the same mount,
 * booted alone in a test, passed 29 of 29 checks.
 *
 * ★ ONLY THE TOP LEVEL IS FILTERED, and that restraint is the important part.
 * `params.arguments.__caller_token` is nested, so it survives untouched — and it is the
 * bridge's entire session-auth mechanism. Filtering both halves would leave every
 * handler with NO caller identity while everything still appeared to work, which is far
 * worse than a loud 400.
 *
 * It also closes the smuggling direction: a caller cannot put arbitrary top-level
 * members into a message the SDK will parse. Batches (arrays) are filtered elementwise.
 */
export function protocolMembersOnly(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(protocolMembersOnly);
  if (!body || typeof body !== 'object') return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k === 'jsonrpc' || k === 'method' || k === 'params' || k === 'id') out[k] = v;
  }
  return out;
}

/** What the SDK's streamable transport requires a client to accept. */
export const SDK_REQUIRED_ACCEPT = 'application/json, text/event-stream';

/**
 * Widen an inbound `Accept` so the SDK transport will serve it.
 *
 * ★ WHY. MEASURED against @modelcontextprotocol/server: the streamable transport answers
 * **HTTP 406** unless the client accepts BOTH `application/json` and
 * `text/event-stream`. Every browser client in this repo — the foxxi dashboard, both
 * microsites, LmsContentPanel — sends NO Accept header at all, as do the demo scenarios.
 * Adopting the SDK without this breaks all of them at once, and silently, because a 406
 * body is not the shape they parse.
 *
 * This widens what the server ACCEPTS without changing what it RETURNS: the transports
 * are configured never to stream, so those callers still get plain JSON.
 */
export function acceptForSdkTransport(incoming: string | undefined): string {
  return /text\/event-stream/.test(incoming ?? '') ? incoming! : SDK_REQUIRED_ACCEPT;
}

/**
 * The CORS request headers protocol revision 2026-07-28 makes mandatory.
 *
 * `Mcp-Method` is required on every modern request and `Mcp-Name` on every modern
 * `tools/call`; the modern path answers `-32020` ("the request headers and body
 * disagree") without them. A browser cannot send a header the preflight did not allow,
 * so a mount that omits these serves the modern era to everything EXCEPT browsers — with
 * no error on the server side, because the request never arrives.
 */
export const MCP_MODERN_CORS_HEADERS = ['mcp-protocol-version', 'Mcp-Method', 'Mcp-Name'] as const;
