/**
 * @module solid/types
 * @description Types for Solid pod integration — publish, discover, subscribe.
 *
 * These types define the runtime layer that reads and writes
 * context-annotated graphs to Solid pods over LDP/HTTP.
 *
 * Substrate HTTP types (`FetchFn`, `FetchResponse`, `WebSocketLike`,
 * `WebSocketConstructor`) used to live here. They are now in `../http/types`
 * because they are not Solid-specific. The re-exports below preserve
 * back-compat for any existing import path.
 */

import type {
  ContextTypeName,
  TrustLevel,
  ModalStatus,
} from '@interego/core';

// ── Substrate HTTP/WS interfaces — re-exported for back-compat ──
// Authoritative definitions live in ../http/types.
export type {
  FetchFn,
  FetchResponse,
  WebSocketLike,
  WebSocketConstructor,
} from '@interego/core/http';

import type { FetchFn } from '@interego/core/http';

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
   * Typed as `unknown` here so the Solid binding does not depend on
   * `@interego/pgsl` at the type level. Callers pass the PGSL instance
   * from `createPGSL()`; the publish path narrows on `.nodes` etc.
   * before use. New code SHOULD type the variable as `PGSLInstance` at
   * the call site (`import type { PGSLInstance } from '@interego/pgsl'`)
   * and pass it here.
   */
  readonly pgsl?: unknown;
  /** Tokenization granularity for PGSL ingestion (default: 'word'). */
  readonly pgslGranularity?: 'character' | 'word' | 'sentence';

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
    readonly senderKeyPair: import('@interego/core').EncryptionKeyPair;
  };

  /**
   * Audience class of the published payload. Affects the distribution
   * block (`cg:visibility`, `cg:encrypted`) and is intended to be paired
   * with an ACL writer at the caller for `public`.
   *
   * - `public`  — no envelope; plaintext payload; descriptor advertises
   *               `cg:visibility "public"` and `cg:encrypted false`.
   *               Callers should also grant `acl:Read` to
   *               `acl:agentClass foaf:Agent` on the payload + descriptor.
   * - `shared`  — envelope to the caller-supplied recipient set
   *               (current behavior). Default when omitted.
   * - `private` — envelope to the author's agent only. share_with-style
   *               co-recipients should be dropped by the caller.
   */
  readonly visibility?: 'public' | 'shared' | 'private';

  /**
   * Optional relay base URL (no trailing slash). When set AND the
   * publish is encrypted, the emitted distribution block carries a
   * SECOND affordance — `cg:renderView` — whose hydra:target is
   * `<relayBaseUrl>/render/<encodeURIComponent(descriptor.id)>`. Thin
   * clients (no X25519 keypair) follow that link with a bearer token
   * to receive server-side-unwrapped plaintext Turtle. cg:canDecrypt
   * remains the point-of-fetch path for clients that hold the key.
   */
  readonly relayBaseUrl?: string;

  /**
   * Maximum permitted graph payload size in bytes. Default 4 MiB.
   * publish() throws before serialization if the named-graph content
   * exceeds this — keeps pathological inputs (multi-GB serialization,
   * descriptor bombs) from driving the process OOM and from hitting
   * pod-server upload limits with no diagnostic. For payloads larger
   * than the cap, content-address into PGSL and reference atoms via
   * pgsl:contains / dct:hasPart instead of inlining.
   */
  readonly maxGraphBytes?: number;
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

// `ManifestEntry` lives in `@interego/core` (substrate-level shape) so
// the kernel + affordance follower can work against manifest rows
// without dragging the Solid binding in. Re-exported here for back-compat.
export type { ManifestEntry } from '@interego/core';

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
  readonly WebSocket?: import('@interego/core/http').WebSocketConstructor;
  /** Custom fetch for the notification channel negotiation. */
  readonly fetch?: FetchFn;
}

// ── Manifest format ─────────────────────────────────────────

/** Shape of the .well-known/context-graphs manifest (Turtle/JSON-LD). */
export interface ContextGraphsManifest {
  readonly entries: readonly import('@interego/core').ManifestEntry[];
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
