/**
 * @module solid/types
 * @description Types for Solid pod integration — publish, discover, subscribe.
 *
 * These types define the runtime layer that reads and writes
 * context-annotated graphs to Solid pods over LDP/HTTP.
 */

import type {
  ContextTypeName,
  TrustLevel,
  ModalStatus,
} from '../model/types.js';

// ── Minimal HTTP/WS interfaces ──────────────────────────────
// Defined here so the library doesn't require DOM lib types.
// Compatible with Node 20+ globals and browser environments.

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

export interface WebSocketLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

// ── Publish ─────────────────────────────────────────────────

/** Result of publishing a descriptor + graph to a Solid pod. */
export interface PublishResult {
  /** IRI where the descriptor Turtle was written. */
  readonly descriptorUrl: string;
  /** IRI where the TriG graph content was written. */
  readonly graphUrl: string;
  /** IRI of the updated manifest. */
  readonly manifestUrl: string;
}

/** Options for the publish function. */
export interface PublishOptions {
  /** LDP container path relative to pod root (default: "context-graphs/"). */
  readonly containerPath?: string;
  /** Filename for the descriptor (default: derived from descriptor id). */
  readonly descriptorSlug?: string;
  /** Filename for the graph (default: derived from descriptor id). */
  readonly graphSlug?: string;
  /** Custom fetch implementation (default: globalThis.fetch). */
  readonly fetch?: FetchFn;
}

/** Options for the discover function. */
export interface DiscoverOptions {
  /** Custom fetch implementation (default: globalThis.fetch). */
  readonly fetch?: FetchFn;
}

// ── Discover ────────────────────────────────────────────────

/** Filter criteria for discovery queries. */
export interface DiscoverFilter {
  /** Only return descriptors containing this facet type. */
  readonly facetType?: ContextTypeName;
  /** Only return descriptors valid at or after this time. */
  readonly validFrom?: string;
  /** Only return descriptors valid at or before this time. */
  readonly validUntil?: string;
  /** Only return descriptors at or above this trust level. */
  readonly trustLevel?: TrustLevel;
  /** Only return descriptors with this modal status. */
  readonly modalStatus?: ModalStatus;
}

/** A single entry from the context-graphs manifest. */
export interface ManifestEntry {
  /** IRI of the context descriptor resource. */
  readonly descriptorUrl: string;
  /** IRIs of the named graphs this descriptor covers. */
  readonly describes: readonly string[];
  /** Facet types present on this descriptor. */
  readonly facetTypes: readonly ContextTypeName[];
  /** Temporal validity start (if declared). */
  readonly validFrom?: string;
  /** Temporal validity end (if declared). */
  readonly validUntil?: string;
}

// ── Subscribe ───────────────────────────────────────────────

/** Event emitted when a context-graph resource changes on a pod. */
export interface ContextChangeEvent {
  /** The resource IRI that changed. */
  readonly resource: string;
  /** The type of change. */
  readonly type: 'Add' | 'Update' | 'Remove';
  /** ISO 8601 timestamp of the notification. */
  readonly timestamp: string;
}

/** Callback invoked when a context-relevant change is detected. */
export type ContextChangeCallback = (event: ContextChangeEvent) => void;

/** Handle returned by subscribe() for lifecycle management. */
export interface Subscription {
  /** Close the WebSocket and stop listening. */
  readonly unsubscribe: () => void;
}

/** Options for the subscribe function. */
export interface SubscribeOptions {
  /** Custom WebSocket constructor (default: globalThis.WebSocket). */
  readonly WebSocket?: WebSocketConstructor;
  /** Custom fetch for the notification channel negotiation. */
  readonly fetch?: FetchFn;
}

// ── Manifest format ─────────────────────────────────────────

/** Shape of the .well-known/context-graphs manifest (Turtle/JSON-LD). */
export interface ContextGraphsManifest {
  readonly entries: readonly ManifestEntry[];
}

// ── Delegation / Registry ──────────────────────────────────

/** Options for agent registry operations. */
export interface RegistryOptions {
  /** Custom fetch implementation. */
  readonly fetch?: FetchFn;
}

/** Path within the pod where the agent registry lives. */
export const AGENT_REGISTRY_PATH = 'agents';

/** Path within the pod where delegation credentials live. */
export const CREDENTIALS_PATH = 'credentials/';
