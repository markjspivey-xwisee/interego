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
  /**
   * When `descriptor.supersedes` was set AND the precondition path resolved
   * a current chain head, this is the content-CID of that head's descriptor
   * Turtle at the moment of publish. Callers performing a series of
   * supersession publishes should pass this back as `ifMatchCid` on the
   * next publish to detect concurrent writers — see {@link PublishOptions.ifMatchCid}.
   */
  readonly previousHeadCid?: string;
  /**
   * When `descriptor.supersedes` was set, the descriptor URL of the
   * resolved current chain head at publish time. Companion to
   * `previousHeadCid` for callers that prefer URL-based CAS.
   */
  readonly previousHeadUrl?: string;
}

/**
 * Thrown when a publish() call carries a CAS precondition
 * ({@link PublishOptions.ifMatchSupersedes} or
 * {@link PublishOptions.ifMatchCid}) and the precondition fails. The HTTP
 * mapping is 412 Precondition Failed; callers can `instanceof`-check this
 * and re-read the current head before retrying.
 */
export class PublishPreconditionFailedError extends Error {
  readonly code = 412;
  /** Descriptor URL(s) the caller asserted as current head. */
  readonly expected: { supersedes?: string; cid?: string };
  /** Actual current head observed on the pod at precondition-check time. */
  readonly actual: { descriptorUrl: string | null; cid: string | null; supersedesList: readonly string[] };
  constructor(
    message: string,
    expected: { supersedes?: string; cid?: string },
    actual: { descriptorUrl: string | null; cid: string | null; supersedesList: readonly string[] },
  ) {
    super(message);
    this.name = 'PublishPreconditionFailedError';
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown when a publish() call's optional SHACL conformance gate
 * ({@link PublishOptions.conformsToShapes}) rejects the inbound graph
 * content. HTTP mapping is 422 Unprocessable Entity. The `violations`
 * array carries the SHACL result rows so callers can surface the
 * exact constraint that failed.
 */
export class PublishShapeViolationError extends Error {
  readonly code = 422;
  /** Shape IRI whose constraint(s) were violated. */
  readonly shape: string;
  /** Violation rows from the SHACL engine. */
  readonly violations: readonly {
    readonly focusNode: string;
    readonly path?: string;
    readonly value?: string;
    readonly constraint: string;
    readonly severity: string;
    readonly message: string;
  }[];
  constructor(
    message: string,
    shape: string,
    violations: readonly {
      readonly focusNode: string;
      readonly path?: string;
      readonly value?: string;
      readonly constraint: string;
      readonly severity: string;
      readonly message: string;
    }[],
  ) {
    super(message);
    this.name = 'PublishShapeViolationError';
    this.shape = shape;
    this.violations = violations;
  }
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
   * Optional agent-level authorship proof, embedded in the descriptor
   * Turtle adjacent to the AgentFacet block as a `cg:authorshipProof`
   * blank node. Independent of the descriptor-level compliance signature
   * (`cg:proof` on the TrustFacet, which covers the whole descriptor
   * Turtle and is the pod-operator anchor): authorship binds an agent's
   * identity claim to the AgentFacet via the agent's own delegation
   * key, so any reader can re-derive the canonical payload and
   * re-verify the signature WITHOUT trusting the pod's storage layer.
   *
   * Mint via `createSignedAuthorship` from `@interego/core` (uses the
   * same `DelegationSigner` shape as the signed delegation VC).
   */
  readonly authorshipProof?: import('@interego/core').AuthorshipProof;

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

  /**
   * CAS precondition — descriptor URL of the chain head the caller
   * believes is current. publish() resolves the current head for every
   * IRI in `descriptor.supersedes` and rejects with
   * {@link PublishPreconditionFailedError} (HTTP 412 semantics) if
   * `ifMatchSupersedes` is not present in the resolved head set.
   *
   * Pairs with `ifMatchCid`: if both are supplied, BOTH must match.
   * If `descriptor.supersedes` is empty, this option is a no-op
   * (nothing to compare against).
   *
   * Fixes the auto-supersede race in the MCP shim: without this gate,
   * two concurrent publishers republishing the same graph_iri each see
   * the same prior head, each emit a cg:supersedes back-link to it, and
   * both succeed — producing a forked chain with two heads. The
   * precondition forces the second writer to re-read first.
   */
  readonly ifMatchSupersedes?: string;

  /**
   * CAS precondition — content-CID (SHA-256 multihash, base32 CIDv1) of
   * the current chain head's descriptor Turtle that the caller observed.
   * publish() recomputes the head's CID at precondition-check time and
   * rejects with {@link PublishPreconditionFailedError} on mismatch.
   *
   * Pairs with `ifMatchSupersedes`. Use the `previousHeadCid` field on
   * {@link PublishResult} from a prior publish as the next call's CAS token.
   */
  readonly ifMatchCid?: string;

  /**
   * Optional manifest-mirrored head-CID resolver. When provided AND a
   * supersedes target has its content-CID mirrored on the manifest (the
   * `cg:contentCid` triple added at publish time), the CAS precondition
   * comparison skips the descriptor body GET + rehash entirely and uses
   * the manifest-supplied CID. Falls through to body-fetch when the
   * lookup misses (legacy manifest entries written before the mirror
   * landed). Pure latency / reliability optimization — no semantic
   * change: the manifest mirror is written from the same `computeCid`
   * the body-fetch path recomputes.
   *
   * Wired by the MCP relay's Phase A pre-flight: the cached
   * `.well-known/context-graphs` GET already carries the head identity,
   * so threading it here removes the flaky descriptor-body GET that
   * surfaced as 503 `precondition_unavailable` on cold Azure-Files
   * caches.
   */
  readonly headCidLookup?: (descriptorUrl: string) => string | null | undefined;

  /**
   * Optional SHACL conformance gate, run BEFORE any pod write. Lets the
   * caller (typically the MCP relay, but anything calling publish()
   * directly) declare a list of shape graphs the inbound `graphContent`
   * MUST conform to. If the gate rejects, publish() throws
   * `PublishShapeViolationError` before the descriptor or payload land
   * on the pod.
   *
   * The kernel does not synthesize shapes — every shape graph in
   * `shapes` is supplied verbatim by the caller (typically fetched from
   * the target container's `.well-known/container-shape` declaration).
   * Passing an empty array (or omitting the field) skips the gate.
   *
   * Pair with {@link validateAgainstShape} from `@interego/core`'s
   * validation surface for the engine that runs each shape.
   */
  readonly conformsToShapes?: readonly { readonly shapeIri: string; readonly shapeTurtle: string }[];
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
  /**
   * Only return descriptors whose `cg:describes` set includes this
   * graph IRI. The single most useful narrowing filter for typical
   * agent workflows ("find the descriptors for `urn:graph:X` on this
   * pod") — without it, callers fetch the whole manifest and post-
   * filter client-side, which truncates on harness UIs for any pod
   * with more than ~20 entries.
   *
   * Note: when a learner already knows the specific urn:graph IRI it
   * is looking for, prefer `get_current_head` (relay tool) — it
   * returns just the unsuperseded head directly. This filter is for
   * "give me ALL descriptors describing this urn" workflows
   * (lineage / supersedes-chain walks / audit).
   */
  readonly graphIri?: string;
  /**
   * Sort order applied AFTER filters. Defaults to 'newest-first' so
   * the most recently published descriptor (largest `validFrom`)
   * comes first — matching the discovery pattern agents typically
   * want ("find what just landed"). 'oldest-first' walks the chain
   * forward from genesis; 'unsorted' returns server-native order
   * (cheaper, but observably arbitrary).
   */
  readonly sort?: 'newest-first' | 'oldest-first' | 'unsorted';
  /**
   * Cap the result count. Combined with `sort` this gives the
   * common "latest N descriptors" affordance without a server-side
   * pagination cursor. Applied AFTER filter + sort.
   */
  readonly limit?: number;
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
