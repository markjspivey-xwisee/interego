/**
 * DID parse + verify-key cache.
 *
 * Hot path for `/auth/did`: the same DID is reused across many challenges
 * by the same client, but parseEd25519DidKey + crypto.createPublicKey were
 * being re-executed per call. base58btc decode is ~3ms cold and
 * crypto.createPublicKey is ~30ms cold (lazy-loads OpenSSL EVP_PKEY +
 * ed25519 curve params on first call), so both are cached in-process.
 *
 * Cache shape:
 *   parsedDidCache:    did:key → { publicKeyRaw, format }
 *   verifyKeyCache:    hex(publicKeyRaw) → crypto.KeyObject
 *
 * Only a did:key is cached by DID, for the process lifetime: it is
 * content-addressed, the public key is encoded INTO the DID itself, so a
 * given did:key string can never refer to a different key. Any other DID
 * (did:web, ...) is verified against a key the CALLER supplies in that
 * request, which says nothing about the next request for the same DID.
 * Caching it by DID applied one caller's key to another caller's request
 * (a stranger's key locked the owner out for a minute), so those DIDs are
 * never cached here: set is a no-op and get misses.
 *
 * Bounded — cap at MAX_ENTRIES via insertion-order LRU eviction (the
 * native Map already preserves insertion order, so dropping the first
 * key is a single .delete()). 1000 entries keeps memory trivial
 * (~64KB) while comfortably covering every client a single identity
 * server sees.
 */

import * as crypto from 'node:crypto';

const MAX_ENTRIES = 1000;

export interface CachedParsedDid {
  publicKeyRaw: Buffer;
  format: 'base58btc' | 'base64url-legacy';
  cachedAt: number;
}

const parsedDidCache: Map<string, CachedParsedDid> = new Map();
const verifyKeyCache: Map<string, crypto.KeyObject> = new Map();

function evictIfNeeded<K, V>(m: Map<K, V>): void {
  if (m.size <= MAX_ENTRIES) return;
  // Map preserves insertion order — the first key is the oldest. One
  // delete brings us back within bounds; pre-fetching the keys iterator
  // is cheaper than rebuilding.
  const firstKey = m.keys().next().value;
  if (firstKey !== undefined) m.delete(firstKey);
}

/** A did:key names its own key (`did:key:z…`); nothing else may be cached by DID. */
function isContentAddressed(did: string): boolean {
  return did.startsWith('did:key:z');
}

export function getCachedParsedDid(did: string): CachedParsedDid | undefined {
  return isContentAddressed(did) ? parsedDidCache.get(did) : undefined;
}

export function setCachedParsedDid(
  did: string,
  publicKeyRaw: Buffer,
  format: 'base58btc' | 'base64url-legacy',
): void {
  if (!isContentAddressed(did)) return;
  parsedDidCache.set(did, { publicKeyRaw, format, cachedAt: Date.now() });
  evictIfNeeded(parsedDidCache);
}

/**
 * Build (or retrieve a cached) Ed25519 verify KeyObject from the raw
 * 32-byte public key. crypto.createPublicKey is ~30ms cold (OpenSSL
 * EVP_PKEY init) and ~0.3ms warm; the KeyObject is immutable so caching
 * is always safe. Keyed by hex(rawKey) so two DIDs that happen to wrap
 * the same key share one KeyObject.
 */
export function getOrCreateEd25519VerifyKey(publicKeyRaw: Buffer): crypto.KeyObject {
  const key = publicKeyRaw.toString('hex');
  const hit = verifyKeyCache.get(key);
  if (hit) return hit;
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), // Ed25519 SPKI prefix
    publicKeyRaw,
  ]);
  const verifyKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  verifyKeyCache.set(key, verifyKey);
  evictIfNeeded(verifyKeyCache);
  return verifyKey;
}

// The y-coordinates of the eight Ed25519 points of small order (order 1, 2, 4 or 8): 1 (the
// identity), p-1 (the point of order 2), 0 (the two of order 4), and two values each shared by
// two of the four of order 8.
const ED25519_P = (1n << 255n) - 19n;
const ED25519_ORDER8_Y = 2707385501144840649318225287225658788936804267575313519463743609750303402022n;
const SMALL_ORDER_Y = new Set([0n, 1n, ED25519_P - 1n, ED25519_ORDER8_Y, ED25519_P - ED25519_ORDER8_Y]);

/**
 * Whether a raw 32-byte Ed25519 public key is a point of small order, in any encoding. A
 * signature by such a key proves nothing: it can be made without any private key, and OpenSSL's
 * verify does not refuse the key. No key generator makes one. The sign bit is ignored and y is
 * read mod p, which also catches the non-canonical encodings p and p+1 of 0 and 1: the same
 * list libsodium refuses.
 */
export function isSmallOrderEd25519Key(publicKeyRaw: Uint8Array): boolean {
  if (publicKeyRaw.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? publicKeyRaw[i] & 0x7f : publicKeyRaw[i]);
  return SMALL_ORDER_Y.has(y % ED25519_P);
}

/** Test-only / introspection. */
export function _cacheSizes(): { parsedDid: number; verifyKey: number } {
  return { parsedDid: parsedDidCache.size, verifyKey: verifyKeyCache.size };
}

/** Test-only — clear both caches between bench runs. */
export function _clearCaches(): void {
  parsedDidCache.clear();
  verifyKeyCache.clear();
}
