/**
 * @module crypto/schnorr
 * @description BIP-340 Schnorr signatures over secp256k1.
 *
 *   This is what public Nostr relays expect (NIP-01 §3 mandates
 *   BIP-340). With this module the same wallet that signs ECDSA
 *   compliance descriptors can also sign Schnorr-shaped Nostr
 *   events — interop with the public Nostr ecosystem becomes a
 *   per-event scheme choice, not a different wallet.
 *
 *   The pubkey for Schnorr is the 32-byte *x-only* coordinate of the
 *   curve point (BIP-340), serialized as 64 hex chars without a
 *   prefix. This is what NIP-01 calls `pubkey`. It differs from the
 *   Ethereum-style 20-byte address we use for ECDSA / x402 — same
 *   private key, two pubkey representations.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** Strip 0x prefix if present and lowercase. */
function normalizeHex(hex: string): string {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  return h.toLowerCase();
}

/**
 * Derive the 32-byte x-only Schnorr public key (Nostr `pubkey` form)
 * from a wallet private key. Returns 64 hex chars, no prefix.
 */
export function getNostrPubkey(privateKey: string): string {
  const skBytes = hexToBytes(normalizeHex(privateKey));
  const pkBytes = schnorr.getPublicKey(skBytes); // 32-byte x-only
  return bytesToHex(pkBytes);
}

/**
 * Sign a 32-byte message digest with BIP-340 Schnorr.
 *
 * Per NIP-01 §3: `sig` is the schnorr signature of the event id (the
 * sha256 of the canonical event). Pass the event id as a hex string;
 * we convert it to the 32-byte digest internally.
 *
 * Returns the signature as 128 hex chars (64 bytes).
 */
export function schnorrSign(messageHex: string, privateKey: string): string {
  const msgBytes = hexToBytes(normalizeHex(messageHex));
  if (msgBytes.length !== 32) {
    throw new Error(`schnorrSign expects a 32-byte message digest (got ${msgBytes.length} bytes)`);
  }
  const skBytes = hexToBytes(normalizeHex(privateKey));
  const sig = schnorr.sign(msgBytes, skBytes);
  return bytesToHex(sig);
}

/**
 * Verify a BIP-340 Schnorr signature.
 *
 * @param signatureHex 64-byte signature, hex
 * @param messageHex   32-byte message digest, hex (typically the event id)
 * @param pubkeyHex    32-byte x-only pubkey, hex (Nostr `pubkey` form)
 * @returns true if valid
 */
export function schnorrVerify(
  signatureHex: string,
  messageHex: string,
  pubkeyHex: string,
): boolean {
  try {
    const sig = hexToBytes(normalizeHex(signatureHex));
    const msg = hexToBytes(normalizeHex(messageHex));
    const pk = hexToBytes(normalizeHex(pubkeyHex));
    return schnorr.verify(sig, msg, pk);
  } catch {
    return false;
  }
}

/**
 * SHA-256 of a UTF-8 string, returned as 64 hex chars.
 *
 * Provided here (rather than reusing crypto/ipfs.ts sha256) so this
 * module is self-contained and uses the same noble primitives the
 * Schnorr code uses — important for cross-platform reproducibility.
 */
export function sha256Hex(content: string): string {
  return bytesToHex(nobleSha256(new TextEncoder().encode(content)));
}
