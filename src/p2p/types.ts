/**
 * @module p2p/types
 * @description Nostr-style event types for the P2P transport.
 *
 *   The shape mirrors NIP-01 (id, pubkey, created_at, kind, tags,
 *   content, sig) so a future swap to BIP-340 Schnorr signatures
 *   gives us interop with the public Nostr ecosystem. Today we sign
 *   with the same secp256k1 ECDSA used everywhere else in the
 *   codebase (ethers.js) — the event ID is computed exactly per
 *   NIP-01 (sha256 of the canonical JSON array) but the `sig` field
 *   carries an ECDSA signature over the event ID rather than a
 *   Schnorr one.
 *
 *   Why this matters: ECDSA signatures recover the signer's
 *   secp256k1 address, which is the same key the operator uses for
 *   compliance signing, x402 payments, and SIWE — one keypair, one
 *   identity, all the way down. We don't need a separate Nostr key.
 */

/** Nostr-style signed event. NIP-01-compatible field shape. */
export interface P2pEvent {
  /** Hex-encoded sha256 of the canonical event (per NIP-01). */
  readonly id: string;
  /** Hex-encoded secp256k1 public key (or address — see signer note above). */
  readonly pubkey: string;
  /** Unix seconds. */
  readonly created_at: number;
  /** Event kind. See KIND_* constants. */
  readonly kind: number;
  /** [name, value, ...metadata] tuples. */
  readonly tags: readonly (readonly string[])[];
  /** Event payload. May be empty if all data lives in tags. */
  readonly content: string;
  /** Hex signature over the event id. ECDSA today; Schnorr later for Nostr-spec interop. */
  readonly sig: string;
}

/** Subscription / query filter — NIP-01 subset we use. */
export interface P2pFilter {
  /** Match events whose pubkey is in this list. */
  readonly authors?: readonly string[];
  /** Match events whose kind is in this list. */
  readonly kinds?: readonly number[];
  /** Tag filters: key starts with `#`, value is the array of allowed tag values. */
  readonly [tagKey: `#${string}`]: readonly string[] | undefined;
  /** Match events created after this unix timestamp. */
  readonly since?: number;
  /** Match events created before this unix timestamp. */
  readonly until?: number;
  /** Limit the number of returned events. */
  readonly limit?: number;
}

/** Handle returned from `subscribe`; call `close()` to unsubscribe. */
export interface P2pSubscription {
  readonly close: () => void;
}

/**
 * Relay interface — what a client expects from any transport.
 *
 *   In-memory relay (this repo, used in tests) implements it.
 *   A WebSocket adapter against a public Nostr relay would
 *   implement it identically. A libp2p-backed peer-to-peer
 *   transport would also implement it.
 */
export interface P2pRelay {
  publish(event: P2pEvent): Promise<{ ok: boolean; reason?: string }>;
  query(filter: P2pFilter): Promise<readonly P2pEvent[]>;
  subscribe(filter: P2pFilter, onEvent: (e: P2pEvent) => void): P2pSubscription;
}

// ── Interego event kinds ───────────────────────────────────
//
// We claim three custom kinds in the NIP-33 parameterized-replaceable
// range (30000-39999). If we ever want to publish a NIP for these,
// they're already in the right range.

/** Descriptor announcement (parameterized-replaceable; per `d` tag). */
export const KIND_DESCRIPTOR = 30040;

/** Pod / federation directory (parameterized-replaceable; per `d` tag). */
export const KIND_DIRECTORY = 30041;

/** Witness attestation referencing another event by id. */
export const KIND_ATTESTATION = 30042;

// ── Decoded forms — what the transport layer hands callers ──

/** Decoded descriptor announcement. */
export interface DescriptorAnnouncement {
  readonly eventId: string;
  readonly publisher: string; // pubkey
  readonly publishedAt: number; // unix seconds
  readonly descriptorId: string;
  readonly cid: string; // IPFS CID of the descriptor turtle
  readonly graphIri: string;
  readonly facetTypes: readonly string[];
  readonly conformsTo: readonly string[]; // dct:conformsTo IRIs
  readonly summary: string; // free-text or JSON manifest entry
}

/** Decoded directory entry. */
export interface DirectoryEntry {
  readonly eventId: string;
  readonly publisher: string;
  readonly publishedAt: number;
  readonly pods: readonly string[];
  readonly summary: string;
}
