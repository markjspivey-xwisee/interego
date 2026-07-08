/**
 * Order-preserving key encoding for the PGSL store's FoundationDB subspaces.
 *
 * Keys are opaque bytes to FDB; ordering is bytewise. We keep the encoding
 * entirely inside this package (both the in-memory fake and the eventual real
 * FDB adapter store these exact byte keys), so we only need it to be
 * bytewise-order-preserving for the ranges we scan — not the full FDB Tuple
 * layer. Fixed-width node addresses sort correctly; string-keyed subspaces are
 * length-delimited by a 0x00 separator for clean prefix ranges.
 *
 * This increment wires the N (nodes) and CP (mutable control-plane) subspaces;
 * the structural indexes (CI/CB/LFT/RGT/LV), overlay (OV/OVR), persistence
 * registry (PR) and ABAC attributes (AA/AAX) subspaces are added as their
 * operations land.
 */

import type { NodeAddr } from './addressing.js';
import { kindByte } from './addressing.js';
import type { Key } from './fdb-like.js';

const ROOT = new TextEncoder().encode('pgsl\x00'); // root subspace prefix
const TAG_N = 0x4e; // 'N' — content-addressed nodes
const TAG_CP = 0x43; // 'C' — mutable control-plane (.internal)

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const B = (n: number): Uint8Array => Uint8Array.of(n);

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Exclusive upper bound for a prefix range (FDB `strinc`). */
export function strinc(prefix: Uint8Array): Uint8Array {
  const b = prefix.slice();
  for (let i = b.length - 1; i >= 0; i--) {
    if (b[i]! < 0xff) {
      b[i] = b[i]! + 1;
      return b.slice(0, i + 1);
    }
  }
  throw new Error('strinc: prefix is all 0xff (no successor)');
}

// ── N: content-addressed nodes — [ROOT]['N'][kindByte][hash20] (fixed width) ──
export function nodeKey(addr: NodeAddr): Key {
  return concat(ROOT, B(TAG_N), B(kindByte(addr.kind)), addr.hash);
}
export function nodeRange(): { begin: Key; end: Key } {
  const p = concat(ROOT, B(TAG_N));
  return { begin: p, end: strinc(p) };
}

// ── CP: mutable control-plane — [ROOT]['C'][collection]\x00[id] ──
export function cpKey(collection: string, id: string): Key {
  return concat(ROOT, B(TAG_CP), utf8(collection), B(0x00), utf8(id));
}
export function cpRange(collection: string): { begin: Key; end: Key } {
  const p = concat(ROOT, B(TAG_CP), utf8(collection), B(0x00));
  return { begin: p, end: strinc(p) };
}
