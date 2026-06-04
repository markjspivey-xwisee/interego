/**
 * @module http/fetch
 * @description Default `fetch` resolver — picks up the WHATWG `globalThis.fetch`
 * on Node 20+ / browsers / Bun / Deno. Throws if no implementation is available
 * so callers know to pass one explicitly via `options.fetch`.
 *
 * Substrate-level: not Solid-specific. Used by Solid pod clients, federation
 * lookups, affordance followers, IPFS pinners — anything that wants the
 * platform fetch unless a test/runtime overrides it.
 */

import type { FetchFn, WebSocketConstructor } from './types.js';

/**
 * Resolve a fetch implementation from the runtime, or throw a clear error.
 *
 * Use this when you want to honour `options.fetch ?? getDefaultFetch()` —
 * the standard pattern across Solid + federation calls in the substrate.
 */
export function getDefaultFetch(): FetchFn {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)['fetch'] === 'function') {
    return (globalThis as Record<string, unknown>)['fetch'] as FetchFn;
  }
  throw new Error('No fetch implementation available. Pass one via options.fetch.');
}

/**
 * Resolve a WebSocket constructor from the runtime, or throw a clear error.
 *
 * Use this when you want to honour `options.WebSocket ?? getDefaultWebSocket()`.
 */
export function getDefaultWebSocket(): WebSocketConstructor {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)['WebSocket'] === 'function') {
    return (globalThis as Record<string, unknown>)['WebSocket'] as WebSocketConstructor;
  }
  throw new Error('No WebSocket implementation available. Pass one via options.WebSocket.');
}
