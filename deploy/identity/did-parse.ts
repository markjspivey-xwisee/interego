/**
 * DID parse + verify-key cache.
 *
 * Hot path for `/auth/did`: the same DID is reused across many challenges
 * by the same client, but parseEd25519DidKey + crypto.createPublicKey were
 * being re-executed per call. base58btc decode is ~3ms cold and
 * crypto.createPublicKey is ~30ms cold (lazy-loads OpenSSL EVP_PKEY +
 * ed25519 curve params on first call). Both results are functions of the
 * DID string alone, so we cache them in-process and keyed on the DID.
 *
 * Cache shape:
 *   parsedDidCache:    did → { publicKeyRaw, format }
 *   verifyKeyCache:    hex(publicKeyRaw) → crypto.KeyObject
 *
 * TTL:
 *   - did:key entries live for the process lifetime — did:key is
 *     content-addressed, the public key is encoded INTO the DID itself,
 *     so a given did:key string can never refer to a different key.
 *   - did:web entries are bounded to 60s so a key rotation surfaces
 *     within a minute (this module doesn't fetch the DID document — the
 *     handler still has to supply publicKeyMultibase — but if it later
 *     does, the TTL is already wired).
 *
 * Bounded — cap at MAX_ENTRIES via insertion-order LRU eviction (the
 * native Map already preserves insertion order, so dropping the first
 * key is a single .delete()). 1000 entries keeps memory trivial
 * (~64KB) while comfortably covering every client a single identity
 * server sees.
 */

import * as crypto from 'node:crypto';

const MAX_ENTRIES = 1000;
const DID_WEB_TTL_MS = 60 * 1000;

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

function isExpired(entry: CachedParsedDid, did: string): boolean {
  // did:key is content-addressed — never expires.
  if (did.startsWith('did:key:')) return false;
  return Date.now() - entry.cachedAt > DID_WEB_TTL_MS;
}

export function getCachedParsedDid(did: string): CachedParsedDid | undefined {
  const hit = parsedDidCache.get(did);
  if (!hit) return undefined;
  if (isExpired(hit, did)) {
    parsedDidCache.delete(did);
    return undefined;
  }
  return hit;
}

export function setCachedParsedDid(
  did: string,
  publicKeyRaw: Buffer,
  format: 'base58btc' | 'base64url-legacy',
): void {
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

/** Test-only / introspection. */
export function _cacheSizes(): { parsedDid: number; verifyKey: number } {
  return { parsedDid: parsedDidCache.size, verifyKey: verifyKeyCache.size };
}

/** Test-only — clear both caches between bench runs. */
export function _clearCaches(): void {
  parsedDidCache.clear();
  verifyKeyCache.clear();
}
