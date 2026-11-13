/**
 * @module crypto/encryption
 * @description End-to-end encryption for Interego.
 *
 * Uses tweetnacl (NaCl) for real, audited cryptography:
 *   - X25519 key exchange (Curve25519 Diffie-Hellman)
 *   - XSalsa20-Poly1305 authenticated encryption (nacl.box / nacl.secretbox)
 *
 * The model:
 *   - Each pod has an X25519 key pair (public in profile, private held by owner)
 *   - Content is encrypted with a random symmetric key
 *   - The symmetric key is wrapped (box'd) for each authorized agent's public key
 *   - Decryption requires the agent's private key + the wrapped key
 *   - Revocation = re-encrypt with new symmetric key, re-wrap for remaining agents
 *
 * Selective disclosure:
 *   - Manifest metadata (facet types, temporal range, graph IRI) stays plaintext
 *   - Graph content + full descriptor Turtle are encrypted
 *   - Agents can discover WHAT exists but not read WHAT it says without delegation
 *
 * Structural-level encryption (PGSL foundation):
 *   - Encrypt at any level of the PGSL lattice
 *   - Inner (0,0) can be encrypted while outer structure is visible
 *   - Wrap creates an encryption boundary — wrapping then encrypting
 *     hides the inner structure while the outer placement is visible
 *   - Each structural level can have different encryption keys/recipients
 */

import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// ── Byte/text conversions ────────────────────────────────────
//
// tweetnacl-util chooses its implementation by whether `atob` exists, and
// Node has had a global `atob` since v16. So on Node it takes the path written
// for old browsers: one String.fromCharCode and one array push per byte, for
// base64 and UTF-8 alike. For a payload of tens of kilobytes that costs more
// than the cipher does, on every envelope sealed or opened.
//
// These produce exactly what tweetnacl-util produces and refuse exactly what
// it refuses: any input the fast path does not plainly accept is handed to
// tweetnacl-util, which then returns or throws as it always has.
const NodeBuffer: typeof Buffer | undefined = (globalThis as { Buffer?: typeof Buffer }).Buffer;
const strictUtf8 = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) : undefined;
const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : undefined;
const isWellFormed = (String.prototype as { isWellFormed?: (this: string) => boolean }).isWellFormed;

function toBase64(bytes: Uint8Array): string {
  if (!NodeBuffer || !(bytes instanceof Uint8Array)) return util.encodeBase64(bytes);
  return NodeBuffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
function fromBase64(text: string): Uint8Array {
  if (!NodeBuffer || typeof text !== 'string') return util.decodeBase64(text);
  // Buffer skips what it does not recognise, so accept its answer only when
  // encoding it gives the input back: that holds exactly for canonical
  // standard base64, which tweetnacl-util decodes to these same bytes.
  const bytes = NodeBuffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) return util.decodeBase64(text);
  return Uint8Array.from(bytes);
}
function utf8ToText(bytes: Uint8Array): string {
  if (strictUtf8 && bytes instanceof Uint8Array) {
    try { return strictUtf8.decode(bytes); } catch { /* malformed: let tweetnacl-util decide and report */ }
  }
  return util.encodeUTF8(bytes);
}
function textToUtf8(text: string): Uint8Array {
  // A lone surrogate has no UTF-8 form. TextEncoder would replace it silently;
  // tweetnacl-util refuses it, so it still does.
  if (!utf8Encoder || !isWellFormed || typeof text !== 'string' || !isWellFormed.call(text)) return util.decodeUTF8(text);
  return utf8Encoder.encode(text);
}

// ═════════════════════════════════════════════════════════════
//  Types
// ═════════════════════════════════════════════════════════════

/** An X25519 key pair for asymmetric encryption */
export interface EncryptionKeyPair {
  readonly publicKey: string;     // base64
  readonly secretKey: string;     // base64
  readonly algorithm: 'X25519-XSalsa20-Poly1305';
}

/** A symmetric key for content encryption */
export interface ContentKey {
  readonly key: string;           // base64 (32 bytes)
  readonly algorithm: 'XSalsa20-Poly1305';
}

/** Encrypted content with metadata */
export interface EncryptedContent {
  readonly ciphertext: string;    // base64
  readonly nonce: string;         // base64 (24 bytes)
  readonly algorithm: 'XSalsa20-Poly1305';
  readonly encryptedAt: string;
}

/** A content key wrapped (encrypted) for a specific recipient */
export interface WrappedKey {
  readonly recipientPublicKey: string;   // base64 — who this is for
  readonly wrappedKey: string;           // base64 — the encrypted content key
  readonly nonce: string;                // base64 — nonce used for wrapping
  readonly senderPublicKey: string;      // base64 — who wrapped it (for box_open)
}

/** Full encrypted envelope: encrypted content + wrapped keys for each recipient */
export interface EncryptedEnvelope {
  readonly content: EncryptedContent;
  readonly wrappedKeys: readonly WrappedKey[];
  readonly algorithm: 'X25519-XSalsa20-Poly1305';
  readonly version: 1;
}

// ═════════════════════════════════════════════════════════════
//  Key Generation (real Curve25519)
// ═════════════════════════════════════════════════════════════

/**
 * Generate an X25519 key pair for asymmetric encryption.
 * Uses tweetnacl's nacl.box.keyPair() — real Curve25519.
 */
export function generateKeyPair(): EncryptionKeyPair {
  const kp = nacl.box.keyPair();
  return {
    publicKey: toBase64(kp.publicKey),
    secretKey: toBase64(kp.secretKey),
    algorithm: 'X25519-XSalsa20-Poly1305',
  };
}

/**
 * Derive an X25519 key pair deterministically from the wallet
 * private key. The same secp256k1 wallet always produces the same
 * Curve25519 keypair, so encrypted shares addressed to your bridge
 * stay decryptable across restarts.
 *
 * Why derive instead of persist + load: zero new state to manage,
 * zero key file to back up separately, no possibility of the
 * X25519 keypair drifting from the wallet that signs your events.
 *
 * `principal` is REQUIRED whenever one wallet stands in for more than
 * one identity, and omitting it there is the failure this parameter
 * exists to prevent. The original docstring here read "The wallet IS
 * the identity, all the way down" — true of a bridge (one wallet, one
 * identity), false of the relay, which is single-signer:
 * `getDelegationSigner()` hands every agent the SAME compliance wallet.
 * Deriving relay-mediated agents off that root without a principal
 * returned one keypair for all of them — measured, johnny and boozer both
 * got `3xeZVVgoS3f0F5UMJPPgtUufKl6pWSJjKiCpZZCpxDI=`, so either could
 * owner-decrypt the other's confidential holon. Folding the principal into
 * the pre-image gives each identity an independent scalar off the shared
 * root.
 *
 * Omitting `principal` reproduces the pre-existing bytes EXACTLY. The Foxxi
 * bridge (FOXXI_WALLET_SEED), examples/personal-bridge (BRIDGE_KEY) and
 * `deriveAdminKeyPair` have already wrapped envelopes with those keys; a
 * changed pre-image would orphan every one of them with no error, only
 * silent decrypt failure — `openEncryptedEnvelope` returns null, it does
 * not throw. tests/derive-encryption-keypair.test.ts pins the vector.
 *
 * @param privateKeyHex secp256k1 private key, hex (with or without 0x)
 * @param principal stable identity string (e.g. an agent DID) to scope the
 *   key to, when the private key is shared across identities. Omit for a
 *   single-identity wallet.
 * @returns EncryptionKeyPair (base64-encoded publicKey + secretKey)
 */
export function deriveEncryptionKeyPair(privateKeyHex: string, principal?: string): EncryptionKeyPair {
  // Domain-separated derivation. Different from the storage key
  // (which uses ':interego-bridge-storage-v1') so a leak of one
  // doesn't compromise the other.
  const stem = privateKeyHex.toLowerCase().replace(/^0x/, '');
  const seed = principal
    ? `${stem}:interego-agent-encryption-v1:${principal}`
    : `${stem}:interego-bridge-encryption-v1`;
  const secretBytes = sha256(utf8ToBytes(seed));
  // tweetnacl reduces this to a valid Curve25519 scalar internally.
  const kp = nacl.box.keyPair.fromSecretKey(secretBytes);
  return {
    publicKey: toBase64(kp.publicKey),
    secretKey: toBase64(kp.secretKey),
    algorithm: 'X25519-XSalsa20-Poly1305',
  };
}

/**
 * Generate a random symmetric key for content encryption.
 * 32 bytes of cryptographic randomness.
 */
export function generateContentKey(): ContentKey {
  const key = nacl.randomBytes(32);
  return {
    key: toBase64(key),
    algorithm: 'XSalsa20-Poly1305',
  };
}

// ═════════════════════════════════════════════════════════════
//  Symmetric Encryption (content)
// ═════════════════════════════════════════════════════════════

/**
 * Encrypt content with a symmetric key.
 * Uses nacl.secretbox (XSalsa20-Poly1305) — authenticated encryption.
 */
export function encryptContent(plaintext: string, contentKey: ContentKey): EncryptedContent {
  return encryptContentBytes(textToUtf8(plaintext), contentKey);
}

/**
 * Encrypt RAW BYTES with a symmetric key — the bytes-capable twin of
 * {@link encryptContent}, which is now a thin wrapper over this (text is
 * UTF-8 encoded exactly as before, so a string caller's output is unchanged
 * in shape and construction).
 *
 * Exists so a caller can seal a binary plaintext (e.g. a compressed body)
 * without first base64-ing it into a string, which would cost a third again
 * before the envelope's own base64 of the ciphertext.
 *
 * A reader that expects text MUST NOT open a bytes envelope with
 * {@link decryptContent}: use {@link decryptContentBytes} and decide from the
 * bytes what they are.
 */
export function encryptContentBytes(message: Uint8Array, contentKey: ContentKey): EncryptedContent {
  const key = fromBase64(contentKey.key);
  const nonce = nacl.randomBytes(24);

  const ciphertext = nacl.secretbox(message, nonce, key);
  if (!ciphertext) throw new Error('Encryption failed');

  return {
    ciphertext: toBase64(ciphertext),
    nonce: toBase64(nonce),
    algorithm: 'XSalsa20-Poly1305',
    encryptedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt content with a symmetric key.
 * Returns null if decryption fails (wrong key, tampered ciphertext).
 */
export function decryptContent(encrypted: EncryptedContent, contentKey: ContentKey): string | null {
  const plaintext = decryptContentBytes(encrypted, contentKey);
  if (!plaintext) return null;

  return utf8ToText(plaintext);
}

/**
 * Decrypt content to RAW BYTES, with no text decoding. Returns null if
 * decryption fails (wrong key, tampered ciphertext). The authenticated bytes
 * are returned exactly as sealed, whether the writer sealed text or binary.
 */
export function decryptContentBytes(encrypted: EncryptedContent, contentKey: ContentKey): Uint8Array | null {
  const ciphertext = fromBase64(encrypted.ciphertext);
  const nonce = fromBase64(encrypted.nonce);
  const key = fromBase64(contentKey.key);

  return nacl.secretbox.open(ciphertext, nonce, key);
}

// ═════════════════════════════════════════════════════════════
//  Asymmetric Key Wrapping (sharing keys with agents)
// ═════════════════════════════════════════════════════════════

/**
 * Wrap a content key for a specific recipient.
 * Uses nacl.box (X25519 + XSalsa20-Poly1305).
 * The sender's secret key + recipient's public key = shared secret.
 */
export function wrapKeyForRecipient(
  contentKey: ContentKey,
  recipientPublicKey: string,
  senderKeyPair: EncryptionKeyPair,
): WrappedKey {
  const message = fromBase64(contentKey.key);
  const recipientPub = fromBase64(recipientPublicKey);
  const senderSecret = fromBase64(senderKeyPair.secretKey);
  const nonce = nacl.randomBytes(24);

  const wrapped = nacl.box(message, nonce, recipientPub, senderSecret);
  if (!wrapped) throw new Error('Key wrapping failed');

  return {
    recipientPublicKey,
    wrappedKey: toBase64(wrapped),
    nonce: toBase64(nonce),
    senderPublicKey: senderKeyPair.publicKey,
  };
}

/**
 * Unwrap a content key using the recipient's secret key.
 * Returns null if unwrapping fails (wrong key, tampered data).
 */
export function unwrapKey(
  wrapped: WrappedKey,
  recipientSecretKey: string,
): ContentKey | null {
  const ciphertext = fromBase64(wrapped.wrappedKey);
  const nonce = fromBase64(wrapped.nonce);
  const senderPub = fromBase64(wrapped.senderPublicKey);
  const recipientSecret = fromBase64(recipientSecretKey);

  const keyBytes = nacl.box.open(ciphertext, nonce, senderPub, recipientSecret);
  if (!keyBytes) return null;

  return {
    key: toBase64(keyBytes),
    algorithm: 'XSalsa20-Poly1305',
  };
}

// ═════════════════════════════════════════════════════════════
//  Encrypted Envelope (the full E2E package)
// ═════════════════════════════════════════════════════════════

/**
 * Encrypt content and wrap the key for multiple recipients.
 * This is the main E2E encryption function.
 *
 * @param plaintext - The content to encrypt (Turtle, TriG, etc.)
 * @param recipientPublicKeys - Base64 public keys of authorized agents
 * @param senderKeyPair - The pod owner's key pair
 * @returns Encrypted envelope with wrapped keys for each recipient
 */
export function createEncryptedEnvelope(
  plaintext: string,
  recipientPublicKeys: readonly string[],
  senderKeyPair: EncryptionKeyPair,
): EncryptedEnvelope {
  return createEncryptedEnvelopeFromBytes(textToUtf8(plaintext), recipientPublicKeys, senderKeyPair);
}

/**
 * Bytes-capable twin of {@link createEncryptedEnvelope}: seal RAW BYTES and
 * wrap the key for each recipient. The envelope has the same shape, version
 * and algorithms — only the sealed plaintext is binary instead of UTF-8 text.
 * Open with {@link openEncryptedEnvelopeBytes}.
 */
export function createEncryptedEnvelopeFromBytes(
  plaintext: Uint8Array,
  recipientPublicKeys: readonly string[],
  senderKeyPair: EncryptionKeyPair,
): EncryptedEnvelope {
  // Generate a random content key
  const contentKey = generateContentKey();

  // Encrypt the content with the symmetric key
  const content = encryptContentBytes(plaintext, contentKey);

  // Wrap the content key for each recipient
  const wrappedKeys = recipientPublicKeys.map(pubKey =>
    wrapKeyForRecipient(contentKey, pubKey, senderKeyPair)
  );

  return {
    content,
    wrappedKeys,
    algorithm: 'X25519-XSalsa20-Poly1305',
    version: 1,
  };
}

/**
 * Open an encrypted envelope using the recipient's key pair.
 * Finds the wrapped key for this recipient and decrypts the content.
 *
 * @returns Decrypted plaintext, or null if not authorized / decryption fails
 */
export function openEncryptedEnvelope(
  envelope: EncryptedEnvelope,
  recipientKeyPair: EncryptionKeyPair,
): string | null {
  const bytes = openEncryptedEnvelopeBytes(envelope, recipientKeyPair);
  return bytes ? utf8ToText(bytes) : null;
}

/**
 * Open an encrypted envelope to RAW BYTES (no text decoding). Works on any
 * envelope, whether sealed from text or from bytes.
 *
 * @returns The authenticated plaintext bytes, or null if not authorized /
 *   decryption fails
 */
export function openEncryptedEnvelopeBytes(
  envelope: EncryptedEnvelope,
  recipientKeyPair: EncryptionKeyPair,
): Uint8Array | null {
  // Find the wrapped key for this recipient
  const myWrappedKey = envelope.wrappedKeys.find(
    wk => wk.recipientPublicKey === recipientKeyPair.publicKey
  );

  if (!myWrappedKey) return null; // Not a recipient

  // Unwrap the content key
  const contentKey = unwrapKey(myWrappedKey, recipientKeyPair.secretKey);
  if (!contentKey) return null; // Unwrapping failed

  // Decrypt the content
  return decryptContentBytes(envelope.content, contentKey);
}

/**
 * Open an encrypted envelope using the recipient's CURRENT key pair AND
 * any historical key pairs they're still holding from the rollover
 * window. Returns the first plaintext that decrypts cleanly.
 *
 * Use this in clients that have rotated X25519 keys and want to
 * remain able to read envelopes that publishers wrapped to a prior
 * generation of their key. Pair with `EncryptionKeyHistoryEntry` on
 * the registry-side (see model/types.ts) so publishers continue
 * wrapping to the recently-retired pubkey during the same window.
 *
 * Closes Sec #12 from the production-readiness audit on the
 * decryption side.
 *
 * @param envelope - The encrypted envelope
 * @param currentKeyPair - The recipient's current X25519 keypair
 * @param historicalKeyPairs - Previously-active keypairs the recipient
 *   still has the private side of (kept locally during the rollover
 *   window). Each is tried in order if the current pair fails to find
 *   a matching wrappedKey or fails to unwrap.
 * @returns Decrypted plaintext, or null if no keypair matches
 */
export function openEncryptedEnvelopeWithHistory(
  envelope: EncryptedEnvelope,
  currentKeyPair: EncryptionKeyPair,
  historicalKeyPairs: readonly EncryptionKeyPair[] = [],
): string | null {
  // Try current first — fastest path, expected case.
  const current = openEncryptedEnvelope(envelope, currentKeyPair);
  if (current !== null) return current;
  // Fall back through each retired keypair.
  for (const kp of historicalKeyPairs) {
    const result = openEncryptedEnvelope(envelope, kp);
    if (result !== null) return result;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════
//  Re-encryption (for revocation)
// ═════════════════════════════════════════════════════════════

/**
 * Re-encrypt content for a new set of recipients.
 * Used when revoking an agent — decrypt with old key, re-encrypt with new key
 * for remaining authorized agents.
 *
 * @param envelope - The current encrypted envelope
 * @param ownerKeyPair - The pod owner's key pair (can decrypt everything)
 * @param newRecipientPublicKeys - The new set of authorized agent public keys
 * @returns New encrypted envelope with the revoked agent excluded
 */
export function reEncryptForRecipients(
  envelope: EncryptedEnvelope,
  ownerKeyPair: EncryptionKeyPair,
  newRecipientPublicKeys: readonly string[],
): EncryptedEnvelope | null {
  // Decrypt with owner's key. As BYTES: the plaintext is not always text (a compressed lattice is
  // a binary container), and decoding it as UTF-8 threw, so such an envelope could not have a
  // recipient revoked. Bytes in, the same bytes out, whatever they are.
  const plaintext = openEncryptedEnvelopeBytes(envelope, ownerKeyPair);
  if (!plaintext) return null;

  // Re-encrypt for new recipient set (with a new random content key)
  return createEncryptedEnvelopeFromBytes(plaintext, newRecipientPublicKeys, ownerKeyPair);
}

// ═════════════════════════════════════════════════════════════
//  Serialization (for storage on pods / IPFS)
// ═════════════════════════════════════════════════════════════

/**
 * Serialize an encrypted envelope to JSON for storage.
 */
export function envelopeToJson(envelope: EncryptedEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

/**
 * Deserialize an encrypted envelope from JSON.
 */
export function envelopeFromJson(json: string): EncryptedEnvelope {
  return JSON.parse(json) as EncryptedEnvelope;
}

// ═════════════════════════════════════════════════════════════
//  Structural-Level Encryption (PGSL foundation)
// ═════════════════════════════════════════════════════════════

/**
 * A structurally-encrypted PGSL node.
 *
 * In PGSL terms: wrapping creates an encryption boundary.
 * The outer structure (placement in the lattice) is visible.
 * The inner structure (what's inside the wrap) is encrypted.
 *
 * Example: ((encrypted_inner), is, fact)
 *   - The outer structure [?, is, fact] is visible
 *   - The inner (encrypted_inner) requires the key to read
 *   - Agents can see the structural position without reading the content
 */
export interface StructuralEncryption {
  /** The PGSL URI of the node being encrypted */
  readonly nodeUri: string;
  /** The structural level (0 = atom, 1 = L1, etc.) */
  readonly level: number;
  /** The encrypted content of this node */
  readonly encrypted: EncryptedContent;
  /** The encrypted key, wrapped for authorized recipients */
  readonly wrappedKeys: readonly WrappedKey[];
  /** What's visible WITHOUT decryption (structural metadata) */
  readonly visibleMetadata: {
    readonly level: number;
    readonly itemCount?: number;    // how many items (without revealing what they are)
    readonly facetTypes?: string[]; // which facet types (without revealing values)
  };
}

/**
 * Encrypt a PGSL node at a specific structural level.
 *
 * The node's content is encrypted, but its structural position
 * (URI, level, item count) remains visible. This allows agents
 * to see WHERE in the lattice something exists without reading
 * WHAT it is.
 *
 * @param content - The resolved content of the PGSL node
 * @param nodeUri - The canonical URI of the node
 * @param level - The structural level (0 = atom, etc.)
 * @param recipientPublicKeys - Who can decrypt
 * @param senderKeyPair - The encryptor's key pair
 * @param itemCount - Optional: number of items (visible in metadata)
 * @param facetTypes - Optional: facet types (visible in metadata)
 */
export function encryptAtStructuralLevel(
  content: string,
  nodeUri: string,
  level: number,
  recipientPublicKeys: readonly string[],
  senderKeyPair: EncryptionKeyPair,
  itemCount?: number,
  facetTypes?: string[],
): StructuralEncryption {
  const contentKey = generateContentKey();
  const encrypted = encryptContent(content, contentKey);
  const wrappedKeys = recipientPublicKeys.map(pubKey =>
    wrapKeyForRecipient(contentKey, pubKey, senderKeyPair)
  );

  return {
    nodeUri,
    level,
    encrypted,
    wrappedKeys,
    visibleMetadata: {
      level,
      itemCount,
      facetTypes,
    },
  };
}

/**
 * Decrypt a structurally-encrypted PGSL node.
 */
export function decryptStructuralNode(
  structuralEnc: StructuralEncryption,
  recipientKeyPair: EncryptionKeyPair,
): string | null {
  const myWrappedKey = structuralEnc.wrappedKeys.find(
    wk => wk.recipientPublicKey === recipientKeyPair.publicKey
  );
  if (!myWrappedKey) return null;

  const contentKey = unwrapKey(myWrappedKey, recipientKeyPair.secretKey);
  if (!contentKey) return null;

  return decryptContent(structuralEnc.encrypted, contentKey);
}
