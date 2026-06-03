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

/**
 * 1:N encrypted share. Content is a JSON-serialized
 * EncryptedEnvelope (NaCl X25519 + XSalsa20-Poly1305). Recipients
 * are tagged via `p` (their signing pubkey, so they can filter for
 * "events addressed to me") and carry their X25519 public key in
 * the envelope's wrappedKeys array (so they can decrypt).
 *
 * This closes the gap between Tier 4 cross-pod E2EE share and the
 * Tier 5 P2P transport — same security model, transport-agnostic.
 */
export const KIND_ENCRYPTED_SHARE = 30043;

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

/** Decoded encrypted share — the envelope is opaque until decrypted. */
export interface EncryptedShare {
  readonly eventId: string;
  readonly sender: string;            // publisher pubkey
  readonly publishedAt: number;
  readonly recipientPubkeys: readonly string[]; // signing pubkeys from `p` tags
  readonly topic?: string;            // optional `topic` tag for context
  /** JSON-serialized EncryptedEnvelope; pass to decryptEncryptedShare. */
  readonly envelope: string;
}

/** Two valid signing schemes — see crypto/schnorr.ts + crypto/wallet.ts. */
export type SignatureScheme = 'ecdsa' | 'schnorr';

/**
 * Detect the signing scheme from the pubkey format:
 *   - 0x-prefixed 42-char hex (Ethereum address)  → ECDSA
 *   - 64-char hex with no prefix (BIP-340 x-only) → Schnorr
 *
 * This means events on the wire self-describe their scheme without
 * an explicit field — the same `pubkey` field holds either form.
 */
export function detectSignatureScheme(pubkey: string): SignatureScheme | null {
  const trimmed = pubkey.startsWith('0x') ? pubkey : pubkey;
  if (trimmed.startsWith('0x') && trimmed.length === 42) return 'ecdsa';
  if (!trimmed.startsWith('0x') && trimmed.length === 64) return 'schnorr';
  return null;
}
