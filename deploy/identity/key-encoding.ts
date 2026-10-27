/**
 * The public-key encodings the identity server publishes: base58btc, the W3C multibase forms of
 * Ed25519 and X25519 keys, and both encodings of an X25519 KeyObject's keyAgreement key.
 *
 * Moved out of server.ts so tests can reach them (tests/key-encoding.test.ts); server.ts imports
 * them from here.
 */

import type * as crypto from 'node:crypto';

// ── base58btc (Bitcoin alphabet) — for W3C did:key + multibase ──
//
// `did:key:z<...>` per the W3C did:key Method Spec is multibase-encoded
// with prefix 'z' = base58btc, and the decoded bytes are
//   multicodec_prefix || raw_public_key
// For Ed25519 the multicodec prefix is the varint 0xed 0x01, followed by
// the 32-byte raw public key — total 34 bytes.
//
// Why hand-rolled: this deploy package intentionally keeps zero runtime
// deps beyond express/ethers/@simplewebauthn (see package.json) and
// pulls no separate base58/multibase library. The implementation is
// ~30 LOC of unambiguous arithmetic; correctness is verified against
// the W3C did:key test vectors at runtime via the round-trip
// emit-then-parse done on every new registration.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m[BASE58_ALPHABET[i]!] = i;
  return m;
})();

function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zero bytes — each maps to a '1' in the output.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Convert the big-endian byte string to base58 by repeated division.
  // Work on a copy because we mutate.
  const buf = Array.from(bytes);
  const out: number[] = [];
  let start = zeros;
  while (start < buf.length) {
    let carry = 0;
    for (let i = start; i < buf.length; i++) {
      const v = (buf[i]! & 0xff) + carry * 256;
      buf[i] = Math.floor(v / 58);
      carry = v % 58;
    }
    out.push(carry);
    if (buf[start] === 0) start++;
  }
  let result = '';
  for (let i = 0; i < zeros; i++) result += BASE58_ALPHABET[0];
  for (let i = out.length - 1; i >= 0; i--) result += BASE58_ALPHABET[out[i]!];
  return result;
}

export function base58btcDecode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === BASE58_ALPHABET[0]) zeros++;
  const buf: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    const digit = BASE58_INDEX[ch];
    if (digit === undefined) throw new Error(`invalid base58 character '${ch}' at position ${i}`);
    let carry = digit;
    for (let j = 0; j < buf.length; j++) {
      const v = buf[j]! * 58 + carry;
      buf[j] = v & 0xff;
      carry = v >> 8;
    }
    while (carry > 0) {
      buf.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // The leading-zero-character count from base58 reflects leading zero
  // bytes in the original. Append them.
  const out = new Uint8Array(zeros + buf.length);
  for (let i = 0; i < buf.length; i++) out[zeros + i] = buf[buf.length - 1 - i]!;
  return out;
}

// Multicodec varint for Ed25519 public key: 0xed 0x01.
export const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]);
// Multicodec varint for X25519 public key: 0xec 0x01.
const X25519_MULTICODEC = Uint8Array.from([0xec, 0x01]);

/**
 * Encode a 32-byte raw Ed25519 public key as a W3C-spec multibase string:
 *   'z' + base58btc(0xed 0x01 || rawKey)
 * This is the canonical form for `did:key:z…` and for the
 * `publicKeyMultibase` field of `Ed25519VerificationKey2020`.
 */
export function encodeEd25519Multibase(rawKey: Buffer): string {
  if (rawKey.length !== 32) throw new Error(`Ed25519 raw key must be 32 bytes, got ${rawKey.length}`);
  const buf = new Uint8Array(ED25519_MULTICODEC.length + 32);
  buf.set(ED25519_MULTICODEC, 0);
  buf.set(rawKey, ED25519_MULTICODEC.length);
  return 'z' + base58btcEncode(buf);
}

/**
 * Encode a 32-byte raw X25519 public key as a W3C-spec multibase string:
 *   'z' + base58btc(0xec 0x01 || rawKey)
 * Canonical form for `publicKeyMultibase` on `X25519KeyAgreementKey2020`
 * verification methods (W3C Security Vocabulary — X25519 Key Agreement 2020).
 */
export function encodeX25519Multibase(rawKey: Buffer): string {
  if (rawKey.length !== 32) throw new Error(`X25519 raw key must be 32 bytes, got ${rawKey.length}`);
  const buf = new Uint8Array(X25519_MULTICODEC.length + 32);
  buf.set(X25519_MULTICODEC, 0);
  buf.set(rawKey, X25519_MULTICODEC.length);
  return 'z' + base58btcEncode(buf);
}

/**
 * The two published encodings of an X25519 public key: `multibase`, 'z' + base58btc(0xec 0x01 ||
 * key), for the DID document's keyAgreement `publicKeyMultibase`; and `base64`, the raw 32 bytes
 * in base64, for the on-pod `iep:AuthorizedAgent.encryptionPublicKey`.
 *
 * The raw key is the last 32 bytes of the key's 44-byte SPKI DER, not the `x` of a JWK export.
 * On Node 20 a JWK export of a key made by generateKeyPairSync holds the key pair's mutex while
 * it allocates. A GC there can collect the finished keygen job, whose destructor takes the same
 * mutex, and the thread deadlocks with itself (see tests/public-jwk.ts). The SPKI export takes no
 * lock while it allocates. Both give the same bytes (tests/key-encoding.test.ts).
 */
export function x25519PublicKeyEncodings(publicKey: crypto.KeyObject): { multibase: string; base64: string } {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  if (spki.length !== 44) {
    throw new Error(`X25519 SPKI must be 44 bytes, got ${spki.length}`);
  }
  const raw = spki.subarray(spki.length - 32);
  return { multibase: encodeX25519Multibase(raw), base64: raw.toString('base64') };
}
