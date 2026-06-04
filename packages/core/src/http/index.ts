/**
 * @module http
 * @description Substrate-level HTTP plumbing — types, default fetch/WebSocket
 * resolvers, and transient-network retry. The Solid pod client and the
 * affordance follower compose against these primitives; nothing in here is
 * Solid-specific.
 */

export type {
  FetchFn,
  FetchResponse,
  WebSocketLike,
  WebSocketConstructor,
} from './types.js';
export { getDefaultFetch, getDefaultWebSocket } from './fetch.js';
export { withTransientRetry, isTransientNetworkError } from './retry.js';
export type { TransientRetryOptions } from './retry.js';
