/**
 * Order-preserving key encoding for the PGSL store's FoundationDB subspaces.
 *
 * Keys are opaque bytes to FDB; ordering is bytewise. We keep the encoding
 * entirely inside this package (both the in-memory fake and the eventual real
 * FDB adapter store these exact byte keys), so we only need it to be
 * bytewise-order-preserving for the ranges we scan. Fixed-width node addresses
 * and big-endian ints sort correctly; string-keyed subspaces are 0x00-delimited
 * for clean prefix ranges.
 *
 * Subspaces:
 *   N   content-addressed nodes         [kindByte][hash20]
 *   CI  fragment -> ordered items       [fragHash20][pos:u32]        -> item urn
 *   CB  item -> containing fragments    [itemAddr21][fragHash20]      -> pos:u32
 *   LFT/RGT  pullback constituents      [childHash20][fragHash20]
 *   LV  level slice                     [level:u32][nodeAddr21]
 *   OV  LDP resource -> holon           [pod]0[resource]              -> top urn
 *   OVR holon -> projecting resources   [topHash20]0[pod]0[resource]
 *   PR  retained persistence registry   [nodeAddr21][tier:u32]        -> record
 *   AA  per-atom ABAC attributes        [scope]0[atomAddr21]          -> attrs
 *   AAX classification index            [scope]0[classOrd:u32][atomAddr21]
 *   CP  mutable control-plane           [collection]0[id]            -> doc
 */

import type { NodeAddr } from './addressing.js';
import { kindByte } from './addressing.js';
import type { Key } from './fdb-like.js';

const ROOT = new TextEncoder().encode('pgsl\x00');
const TAG_N = 0x4e;  // N nodes
const TAG_CI = 0x49; // I fragment->items
const TAG_CB = 0x42; // B item->fragments
const TAG_LFT = 0x4c; // L left constituents
const TAG_RGT = 0x52; // R right constituents
const TAG_LV = 0x56; // V level slice
const TAG_OV = 0x4f; // O overlay resource->holon
const TAG_OVR = 0x57; // W holon->resources
const TAG_PR = 0x50; // P persistence registry
const TAG_AA = 0x41; // A atom attributes
const TAG_AAX = 0x58; // X classification index
const TAG_CP = 0x43; // C control-plane

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const B = (n: number): Uint8Array => Uint8Array.of(n);
function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`u32be out of range: ${n}`);
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** The 21-byte in-key node address: kind byte + 20 hash bytes. */
function addrBytes(addr: NodeAddr): Uint8Array {
  return concat(B(kindByte(addr.kind)), addr.hash);
}

/** Exclusive upper bound for a prefix range (FDB `strinc`). */
export function strinc(prefix: Uint8Array): Uint8Array {
  const b = prefix.slice();
  for (let i = b.length - 1; i >= 0; i--) {
    if (b[i]! < 0xff) { b[i] = b[i]! + 1; return b.slice(0, i + 1); }
  }
  throw new Error('strinc: prefix is all 0xff (no successor)');
}
function range(prefix: Uint8Array): { begin: Key; end: Key } {
  return { begin: prefix, end: strinc(prefix) };
}

// ── N: content-addressed nodes ──
export function nodeKey(addr: NodeAddr): Key { return concat(ROOT, B(TAG_N), addrBytes(addr)); }
export function nodeRange(): { begin: Key; end: Key } { return range(concat(ROOT, B(TAG_N))); }

// ── CI: fragment -> ordered items (value = item urn) ──
export function ciKey(fragHash: Uint8Array, pos: number): Key {
  return concat(ROOT, B(TAG_CI), fragHash, u32be(pos));
}
export function ciRange(fragHash: Uint8Array): { begin: Key; end: Key } {
  return range(concat(ROOT, B(TAG_CI), fragHash));
}

// ── CB: item -> containing fragments (value = pos) ──
export function cbKey(itemAddr: NodeAddr, fragHash: Uint8Array): Key {
  return concat(ROOT, B(TAG_CB), addrBytes(itemAddr), fragHash);
}
export function cbRange(itemAddr: NodeAddr): { begin: Key; end: Key } {
  return range(concat(ROOT, B(TAG_CB), addrBytes(itemAddr)));
}
/** Extract the fragment hash (last 20 bytes) from a CB key. */
export function cbFragHash(key: Key): Uint8Array { return key.slice(key.length - 20); }

// ── LFT / RGT: pullback constituents ──
export function lftKey(childHash: Uint8Array, fragHash: Uint8Array): Key {
  return concat(ROOT, B(TAG_LFT), childHash, fragHash);
}
export function rgtKey(childHash: Uint8Array, fragHash: Uint8Array): Key {
  return concat(ROOT, B(TAG_RGT), childHash, fragHash);
}

// ── LV: level slice ──
export function lvKey(level: number, addr: NodeAddr): Key {
  return concat(ROOT, B(TAG_LV), u32be(level), addrBytes(addr));
}
export function lvRange(level: number): { begin: Key; end: Key } {
  return range(concat(ROOT, B(TAG_LV), u32be(level)));
}
/** Extract the 21-byte node address (last 21 bytes) from an LV key. */
export function lvAddrBytes(key: Key): Uint8Array { return key.slice(key.length - 21); }

// ── OV / OVR: overlay ──
export function ovKey(pod: string, resource: string): Key {
  return concat(ROOT, B(TAG_OV), utf8(pod), B(0), utf8(resource));
}
export function ovrKey(topHash: Uint8Array, pod: string, resource: string): Key {
  return concat(ROOT, B(TAG_OVR), topHash, B(0), utf8(pod), B(0), utf8(resource));
}

// ── PR: retained persistence registry ──
export function prKey(addr: NodeAddr, tier: number): Key {
  return concat(ROOT, B(TAG_PR), addrBytes(addr), u32be(tier));
}

// ── AA / AAX: per-atom ABAC attributes ──
export function aaKey(scope: string, atomAddr: NodeAddr): Key {
  return concat(ROOT, B(TAG_AA), utf8(scope), B(0), addrBytes(atomAddr));
}
export function aaScopeRange(scope: string): { begin: Key; end: Key } {
  return range(concat(ROOT, B(TAG_AA), utf8(scope), B(0)));
}
/** Extract the 21-byte atom address (last 21 bytes) from an AA key. */
export function aaAtomAddrBytes(key: Key): Uint8Array { return key.slice(key.length - 21); }
export function aaxKey(scope: string, classOrdinal: number, atomAddr: NodeAddr): Key {
  return concat(ROOT, B(TAG_AAX), utf8(scope), B(0), u32be(classOrdinal), addrBytes(atomAddr));
}
export function aaxAtLeastRange(scope: string, minOrdinal: number): { begin: Key; end: Key } {
  const scopePrefix = concat(ROOT, B(TAG_AAX), utf8(scope), B(0));
  return { begin: concat(scopePrefix, u32be(minOrdinal)), end: strinc(scopePrefix) };
}

// ── CP: mutable control-plane ──
export function cpKey(collection: string, id: string): Key {
  return concat(ROOT, B(TAG_CP), utf8(collection), B(0), utf8(id));
}
export function cpRange(collection: string): { begin: Key; end: Key } {
  return range(concat(ROOT, B(TAG_CP), utf8(collection), B(0)));
}
