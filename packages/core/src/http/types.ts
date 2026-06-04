/**
 * @module http/types
 * @description Substrate-level HTTP + WebSocket abstractions.
 *
 * These types are the substrate's contract with the network — used by
 * Solid pod clients, federation lookups, IPFS pins, affordance followers,
 * and any other component that performs HTTP I/O. They are intentionally
 * minimal so the library does not require DOM lib types and so callers
 * can substitute Node 20 globals, undici, msw, or a mock during tests.
 *
 * Not Solid-specific: these are the substrate's HTTP shape, NOT the LDP
 * binding. The Solid client composes against them.
 */

/** Minimal subset of the WHATWG fetch Response surface the substrate uses. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Minimal fetch signature compatible with WHATWG fetch + Node 20 globals. */
export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

/** Minimal WebSocket-like surface (subscribe / close + message events). */
export interface WebSocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** Constructor signature for WebSocket implementations (browser / ws / mock). */
export type WebSocketConstructor = new (url: string) => WebSocketLike;
