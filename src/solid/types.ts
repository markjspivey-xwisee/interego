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
  /** IRI where the TriG graph content was written (plaintext mode), or the encrypted envelope (encrypted mode). */
  readonly graphUrl: string;
  /** True when the graph payload at graphUrl is an encrypted envelope (application/jose+json). */
  readonly encrypted?: boolean;
  /** IRI of the updated manifest. */
  readonly manifestUrl: string;
  /**
   * PGSL structural URI of the published content (if PGSL ingestion was enabled).
   * This is the canonical content-addressed URI in the lattice — same content
   * always produces the same URI regardless of when or where it's published.
   */
  readonly pgslUri?: string;
  /**
   * PGSL structural level of the published content.
   * Level 0 = atom, Level N = N-item overlapping pair construction.
   */
  readonly pgslLevel?: number;
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
  /**
   * Optional PGSL instance — if provided, the published content will be
   * ingested into the lattice during publish. This creates the structural
   * representation alongside the RDF representation.
   *
   * The graph content is ingested (not the descriptor metadata) so that
   * the actual knowledge is structurally indexed and addressable.
   */
  readonly pgsl?: import('../pgsl/types.js').PGSLInstance;
  /** Tokenization granularity for PGSL ingestion (default: 'word'). */
  readonly pgslGranularity?: import('../pgsl/types.js').TokenGranularity;

  /**
   * If set, the named-graph content is encrypted client-side as a
   * tweetnacl envelope (XSalsa20-Poly1305 content + X25519-wrapped keys
   * per recipient) before PUT. CSS / Azure Files / IPFS see only
   * ciphertext. Descriptor metadata stays plaintext (it's discoverable
   * manifest content: facet types, temporal range, modal status) so
   * federation queries still work without decryption.
   */
  readonly encrypt?: {
    /** Base64 X25519 public keys of every authorized agent. */
    readonly recipients: readonly string[];
    /** Sender's X25519 keypair (typically the publishing agent's). */
    readonly senderKeyPair: import('../crypto/encryption.js').EncryptionKeyPair;
  };
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
  /** Only return descriptors whose own validFrom is at or after this time. */
  readonly validFrom?: string;
  /** Only return descriptors whose own validUntil is at or before this time. */
  readonly validUntil?: string;
  /**
   * Only return descriptors effective AT the given instant:
   *   validFrom <= effectiveAt AND (validUntil >= effectiveAt OR validUntil absent).
   * This is the "currently-valid-at-time-T" semantic that was previously
   * mistakenly expected of `validFrom`. Distinct from validFrom/validUntil
   * which only filter on the endpoints.
   */
  readonly effectiveAt?: string;
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
  /** Modal status from the Semiotic facet (if present). */
  readonly modalStatus?: ModalStatus;
  /** Trust level from the Trust facet (if present). */
  readonly trustLevel?: TrustLevel;
  /** Schemas/vocabularies this entry conforms to (cleartext-mirrored from dct:conformsTo). */
  readonly conformsTo?: readonly string[];
  /**
   * PGSL structural URI (if the content was ingested into the lattice).
   * Same content from different pods produces the same URI —
   * structural overlap is detectable across federation.
   */
  readonly pgslUri?: string;
  /** PGSL structural level. */
  readonly pgslLevel?: number;
  /**
   * Structural overlap with a query or other descriptor.
   * Computed via PGSL lattice meet — the shared sub-structure.
   */
  readonly structuralOverlap?: {
    readonly meetUri?: string;
    readonly meetResolved?: string;
    readonly meetLevel?: number;
  };
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
