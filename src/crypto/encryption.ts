/**
 * @module crypto/encryption
 * @description End-to-end encryption for Context Graphs.
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
 */

import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

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
    publicKey: util.encodeBase64(kp.publicKey),
    secretKey: util.encodeBase64(kp.secretKey),
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
    key: util.encodeBase64(key),
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
  const message = util.decodeUTF8(plaintext);
  const key = util.decodeBase64(contentKey.key);
  const nonce = nacl.randomBytes(24);

  const ciphertext = nacl.secretbox(message, nonce, key);
  if (!ciphertext) throw new Error('Encryption failed');

  return {
    ciphertext: util.encodeBase64(ciphertext),
    nonce: util.encodeBase64(nonce),
    algorithm: 'XSalsa20-Poly1305',
    encryptedAt: new Date().toISOString(),
  };
}

/**
 * Decrypt content with a symmetric key.
 * Returns null if decryption fails (wrong key, tampered ciphertext).
 */
export function decryptContent(encrypted: EncryptedContent, contentKey: ContentKey): string | null {
  const ciphertext = util.decodeBase64(encrypted.ciphertext);
  const nonce = util.decodeBase64(encrypted.nonce);
  const key = util.decodeBase64(contentKey.key);

  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) return null;

  return util.encodeUTF8(plaintext);
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
  const message = util.decodeBase64(contentKey.key);
  const recipientPub = util.decodeBase64(recipientPublicKey);
  const senderSecret = util.decodeBase64(senderKeyPair.secretKey);
  const nonce = nacl.randomBytes(24);

  const wrapped = nacl.box(message, nonce, recipientPub, senderSecret);
  if (!wrapped) throw new Error('Key wrapping failed');

  return {
    recipientPublicKey,
    wrappedKey: util.encodeBase64(wrapped),
    nonce: util.encodeBase64(nonce),
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
  const ciphertext = util.decodeBase64(wrapped.wrappedKey);
  const nonce = util.decodeBase64(wrapped.nonce);
  const senderPub = util.decodeBase64(wrapped.senderPublicKey);
  const recipientSecret = util.decodeBase64(recipientSecretKey);

  const keyBytes = nacl.box.open(ciphertext, nonce, senderPub, recipientSecret);
  if (!keyBytes) return null;

  return {
    key: util.encodeBase64(keyBytes),
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
  // Generate a random content key
  const contentKey = generateContentKey();

  // Encrypt the content with the symmetric key
  const content = encryptContent(plaintext, contentKey);

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
  // Find the wrapped key for this recipient
  const myWrappedKey = envelope.wrappedKeys.find(
    wk => wk.recipientPublicKey === recipientKeyPair.publicKey
  );

  if (!myWrappedKey) return null; // Not a recipient

  // Unwrap the content key
  const contentKey = unwrapKey(myWrappedKey, recipientKeyPair.secretKey);
  if (!contentKey) return null; // Unwrapping failed

  // Decrypt the content
  return decryptContent(envelope.content, contentKey);
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
  // Decrypt with owner's key
  const plaintext = openEncryptedEnvelope(envelope, ownerKeyPair);
  if (!plaintext) return null;

  // Re-encrypt for new recipient set (with a new random content key)
  return createEncryptedEnvelope(plaintext, newRecipientPublicKeys, ownerKeyPair);
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
