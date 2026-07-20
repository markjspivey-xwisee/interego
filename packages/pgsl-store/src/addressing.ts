/**
 * PGSL content-addressing — the public/private dedup split + the node-address
 * codec used as FoundationDB keys.
 *
 * Two decisions (maintainer, 2026-07-08) are realized here:
 *
 *  1. DEDUP DOMAIN by sensitivity. A PGSL atom's identity is a hash of its VALUE,
 *     which globally de-duplicates identical values — a feature (cross-agent
 *     structural overlap detectable from public projections) but also a leak: the
 *     content-addressed `set-if-absent` write lets any writer probe whether a
 *     value already exists by minting `sha256(guess)` and checking presence
 *     (guess-and-check on e.g. an SSN), cross-tenant, with no read access. So:
 *       - PUBLIC atoms keep the bare global hash (the overlap feature; existence
 *         of public content is not secret). Wire-identical to @interego/pgsl's
 *         `atomUri` so public atoms stay compatible with the existing lattice.
 *       - PRIVATE / confidential atoms are addressed by an HMAC keyed by the
 *         owning tenant's secret. Identical private values under different tenant
 *         keys get different addresses (no cross-tenant dedup), and — crucially —
 *         a party without the tenant key cannot compute the address at all, which
 *         CLOSES the existence oracle. Same value + same tenant key still dedups
 *         within the tenant.
 *     The URN SHAPE is identical for both (40 hex), so the address never leaks
 *     whether an atom is public or private.
 *
 *  2. The FDB key form of a node URN is a compact 21-byte address (1 kind byte +
 *     the 20 raw bytes behind the 40 hex chars), keeping atoms and fragments in
 *     disjoint, contiguous key ranges well under FDB's ideal key size.
 *
 * Pure module: only `node:crypto`. No FDB, no lattice state.
 */

import { createHash, createHmac } from 'node:crypto';
import { pgslNodeKind, pgslNodeHash } from '@interego/core';

export type AtomValue = string | number | boolean;
export type Sensitivity = 'public' | 'private';

export interface AtomAddressOptions {
  /** Default 'public'. 'private' requires `tenantKey`. */
  sensitivity?: Sensitivity;
  /** The owning tenant's secret; required (and only used) when sensitivity is 'private'. */
  tenantKey?: string;
}

const ATOM_PREFIX = 'urn:pgsl:atom:';
const FRAGMENT_PREFIX = 'urn:pgsl:fragment:';
const HASH_HEX_LEN = 40;
const HASH_BYTES = HASH_HEX_LEN / 2; // 20

function sha40(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, HASH_HEX_LEN);
}
function hmac40(key: string, input: string): string {
  return createHmac('sha256', key).update(input).digest('hex').slice(0, HASH_HEX_LEN);
}

/**
 * Public atom address — bare hash, globally de-duplicated. The 40-hex hash is
 * identical to `@interego/pgsl`'s `atomUri` (`sha256("atom:" + String(value))[:40]`),
 * but atomUri now mints the dereferenceable URL id (`…/ns/pgsl/atom/<hash>`) while
 * this emits the legacy `urn:pgsl:atom:<hash>`, so the two id STRINGS are no longer
 * byte-identical — they differ only by scheme. The FDB node-address codec
 * ({@link nodeAddrFromUrn}) strips the scheme, so both forms resolve to the same
 * key and public atoms stay wire-compatible with the current lattice. An external
 * party CAN recompute this — existence of PUBLIC content is not secret; this is
 * exactly the cross-agent structural-overlap primitive.
 */
export function publicAtomAddress(value: AtomValue): string {
  return ATOM_PREFIX + sha40('atom:' + String(value));
}

/**
 * Private/confidential atom address — HMAC-SHA256 keyed by the owning tenant's
 * secret. Same value under two tenant keys → two different addresses (no
 * cross-tenant dedup); a party without the tenant key cannot compute the address
 * (closes the content-addressed existence oracle). Same value + same key still
 * dedups within the tenant.
 */
export function privateAtomAddress(value: AtomValue, tenantKey: string): string {
  if (!tenantKey) throw new Error('privateAtomAddress requires a non-empty tenantKey');
  return ATOM_PREFIX + hmac40(tenantKey, 'atom:' + String(value));
}

/**
 * Address an atom by sensitivity. Public (default) = bare global hash; private =
 * tenant-keyed HMAC. Throws if 'private' is requested without a `tenantKey`.
 */
export function atomAddress(value: AtomValue, opts: AtomAddressOptions = {}): string {
  const sensitivity = opts.sensitivity ?? 'public';
  if (sensitivity === 'private') {
    if (!opts.tenantKey) throw new Error("atomAddress: sensitivity 'private' requires opts.tenantKey");
    return privateAtomAddress(value, opts.tenantKey);
  }
  return publicAtomAddress(value);
}

// ── Node-address codec (URN ↔ 21-byte FDB key) ──────────────────

export type NodeKind = 'atom' | 'fragment';
export const KIND_ATOM = 0x01;
export const KIND_FRAGMENT = 0x02;

/** The FDB key form of a node URN: kind byte + the 20 raw hash bytes. */
export interface NodeAddr {
  kind: NodeKind;
  /** 20 bytes — the raw form of the URN's 40 hex chars. */
  hash: Uint8Array;
}

export function kindByte(kind: NodeKind): number {
  return kind === 'atom' ? KIND_ATOM : KIND_FRAGMENT;
}

/**
 * Parse a PGSL node id into a NodeAddr. DUAL-READ: accepts BOTH the legacy
 * `urn:pgsl:<kind>:<40hex>` and the current dereferenceable URL form
 * `https://…/ns/pgsl/<kind>/<40hex>`. `pgslNodeKind`/`pgslNodeHash` extract the
 * same <kind>/<hash> from either scheme, and the FDB codec strips the scheme, so
 * both forms yield an identical 21-byte address.
 */
export function nodeAddrFromUrn(urn: string): NodeAddr {
  const parsedKind = pgslNodeKind(urn);
  const hex = pgslNodeHash(urn);
  if (parsedKind === null || hex === null) throw new Error(`not a pgsl node urn: ${urn}`);
  if (parsedKind !== 'atom' && parsedKind !== 'fragment') throw new Error(`unsupported pgsl node kind: ${urn}`);
  const kind: NodeKind = parsedKind;
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`malformed pgsl urn hash: ${urn}`);
  const hash = new Uint8Array(HASH_BYTES);
  for (let i = 0; i < HASH_BYTES; i++) hash[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { kind, hash };
}

/** Inverse of {@link nodeAddrFromUrn}. */
export function urnFromNodeAddr(addr: NodeAddr): string {
  if (addr.hash.length !== HASH_BYTES) throw new Error(`NodeAddr.hash must be ${HASH_BYTES} bytes`);
  const hex = Array.from(addr.hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return (addr.kind === 'atom' ? ATOM_PREFIX : FRAGMENT_PREFIX) + hex;
}
