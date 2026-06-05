#!/usr/bin/env tsx
/**
 * Micro-benchmark for the /auth/did cold-vs-warm caching strategy.
 *
 * Hits the cache-backed parse + verify-key helpers directly (no HTTP
 * round-trip needed — the cache code path is the thing we want to
 * measure) and emits two timings:
 *
 *   cold: first call for a brand-new did:key   — pays parse + KeyObject
 *   warm: second call for the SAME did:key     — both cached
 *
 * Run:
 *   cd deploy/identity && npx tsx tests/bench-auth-did.ts
 *
 * Expected: the warm path is materially faster than the cold path
 * (typically a 10-100x speedup; the absolute numbers vary by machine
 * and Node version, but the warm number should be sub-millisecond).
 */

import * as crypto from 'node:crypto';
import {
  getCachedParsedDid,
  setCachedParsedDid,
  getOrCreateEd25519VerifyKey,
  _clearCaches,
} from '../did-parse.js';

// Mirror the encode helper from server.ts so we can build a fresh
// did:key without dragging the whole server module in.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01]);

function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
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

function base58btcDecode(str: string): Uint8Array {
  const idx: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) idx[BASE58_ALPHABET[i]!] = i;
  if (str.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === BASE58_ALPHABET[0]) zeros++;
  const buf: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const digit = idx[str[i]!]!;
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
  const out = new Uint8Array(zeros + buf.length);
  for (let i = 0; i < buf.length; i++) out[zeros + i] = buf[buf.length - 1 - i]!;
  return out;
}

function parseDidKey(did: string): { publicKey: Buffer; format: 'base58btc' | 'base64url-legacy' } {
  const encoded = did.slice('did:key:z'.length);
  const decoded = base58btcDecode(encoded);
  if (decoded.length === 34
    && decoded[0] === ED25519_MULTICODEC[0]
    && decoded[1] === ED25519_MULTICODEC[1]) {
    return { publicKey: Buffer.from(decoded.subarray(2)), format: 'base58btc' };
  }
  throw new Error('not a base58btc did:key');
}

function mintFreshDidKey(): { did: string; publicKeyRaw: Buffer; nonce: string; signature: Buffer; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = Buffer.from(spki.subarray(spki.length - 32));
  const mc = new Uint8Array(2 + 32);
  mc.set(ED25519_MULTICODEC, 0);
  mc.set(raw, 2);
  const did = 'did:key:z' + base58btcEncode(mc);
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), privateKey);
  return { did, publicKeyRaw: raw, nonce, signature, privateKey };
}

// What the /auth/did handler actually does in its parse + verify-key
// + verify path. We measure the same sequence the handler runs so
// the numbers reflect the production hot path, not a synthetic.
function authDidCriticalPath(did: string, publicKeyRawFromDid: Buffer, nonce: string, signature: Buffer): boolean {
  // 1. Parse cache lookup.
  let publicKeyRaw: Buffer;
  const cached = getCachedParsedDid(did);
  if (cached) {
    publicKeyRaw = cached.publicKeyRaw;
  } else {
    // First call — parse + cache.
    const parsed = parseDidKey(did);
    publicKeyRaw = parsed.publicKey;
    setCachedParsedDid(did, publicKeyRaw, parsed.format);
  }
  // 2. KeyObject cache lookup + verify.
  const verifyKey = getOrCreateEd25519VerifyKey(publicKeyRaw);
  return crypto.verify(null, Buffer.from(nonce, 'utf8'), verifyKey, signature);
}

function bench(label: string, fn: () => void, iterations: number): { totalMs: number; perCallMs: number } {
  // GC nudge so we're not measuring an old generation.
  if (typeof global.gc === 'function') global.gc();
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const total = performance.now() - t0;
  return { totalMs: total, perCallMs: total / iterations };
}

async function main(): Promise<void> {
  // Cold first-call timing — fresh DID, empty caches.
  _clearCaches();
  const fresh = mintFreshDidKey();
  // Use publicKeyRawFromDid only as a sanity wrapper — the real path
  // re-derives it from the DID string itself, which is exactly what
  // we want to measure.
  const coldT0 = performance.now();
  const coldOk = authDidCriticalPath(fresh.did, fresh.publicKeyRaw, fresh.nonce, fresh.signature);
  const coldMs = performance.now() - coldT0;
  if (!coldOk) throw new Error('cold-path signature verify returned false (should not happen on a freshly-minted keypair)');

  // Warm same-DID timing — same DID, caches hot. Repeat 1000 times
  // so we can average out noise; the per-call number is what matters.
  const ITER = 1000;
  // Pre-warm an extra signature so we're measuring verify, not signing.
  const warm = bench('warm', () => {
    const ok = authDidCriticalPath(fresh.did, fresh.publicKeyRaw, fresh.nonce, fresh.signature);
    if (!ok) throw new Error('warm verify failed');
  }, ITER);

  console.log('— /auth/did cache benchmark —');
  console.log(`Cold (first call, fresh DID):  ${coldMs.toFixed(3)} ms`);
  console.log(`Warm (same DID, x${ITER} avg):    ${warm.perCallMs.toFixed(4)} ms/call (total ${warm.totalMs.toFixed(1)} ms)`);
  const speedup = coldMs / warm.perCallMs;
  console.log(`Speedup:                       ${speedup.toFixed(1)}x`);
  if (warm.perCallMs > coldMs) {
    console.error('FAIL: warm path is not measurably faster than cold path');
    process.exitCode = 1;
  } else {
    console.log('OK: warm path is faster than cold path.');
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
