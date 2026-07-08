/**
 * PgslStore — the durable, transactional PGSL substrate of record.
 *
 * Coded against the `FdbLike` seam, so it runs identically over the in-memory
 * fake (local unit tests, no Docker) and the real FoundationDB binding (prod +
 * CI). Lands: content-addressed grow-only node writes (set-if-absent), point
 * resolve, full rehydrate (rebuild the registry WITH bodies — fixes the
 * in-memory-singleton restart loss), compose-on-write of a whole lattice slice
 * in ONE transaction (nodes + structural indexes + overlay + persistence
 * registry), the structural queries those indexes enable, and the mutable
 * control-plane (.internal accounts / idp / sessions).
 *
 * Still to come: the AA/AAX ABAC attribute store + the mediator-side
 * ABAC-filtered project-on-read (both pure/Docker-free), and a thin real-FDB
 * adapter over this same seam.
 */

import type { FdbLike } from './fdb-like.js';
import { nodeAddrFromUrn, urnFromNodeAddr } from './addressing.js';
import {
  aaAtomAddrBytes,
  aaKey,
  aaScopeRange,
  aaxKey,
  cbFragHash,
  cbKey,
  cbRange,
  ciKey,
  ciRange,
  cpIdFromKey,
  cpKey,
  cpListRange,
  cpRange,
  lftKey,
  lvAddrBytes,
  lvKey,
  lvRange,
  nodeKey,
  nodeRange,
  ovKey,
  ovrKey,
  prKey,
  rgtKey,
} from './keyspace.js';
import { decodeJson, decodeNode, encodeJson, encodeNode, type StoredNode } from './node.js';
import type { AtomAccessAttributes } from './attributes.js';

const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface PutResult { created: boolean; }
export interface PutManyResult { created: number; dedup: number; }
export interface ComposeResult { created: number; dedup: number; topUri: string; }

export class PgslStore {
  constructor(private readonly fdb: FdbLike) {}

  /** Content-addressed grow-only write. `created=false` iff the node already existed. */
  async put(node: StoredNode): Promise<PutResult> {
    const key = nodeKey(nodeAddrFromUrn(node.uri));
    return this.fdb.transact(async (txn) => {
      if ((await txn.get(key)) !== undefined) return { created: false };
      txn.set(key, encodeNode(node));
      return { created: true };
    });
  }

  /** Write a set of nodes in ONE transaction — atomic + idempotent (convergent). */
  async putMany(nodes: readonly StoredNode[]): Promise<PutManyResult> {
    return this.fdb.transact(async (txn) => {
      let created = 0;
      let dedup = 0;
      for (const node of nodes) {
        const key = nodeKey(nodeAddrFromUrn(node.uri));
        if ((await txn.get(key)) === undefined) { txn.set(key, encodeNode(node)); created++; }
        else dedup++;
      }
      return { created, dedup };
    });
  }

  /**
   * Compose a whole lattice slice into the store in ONE transaction: the nodes
   * (set-if-absent), the structural index rows (CI fragment->items, CB
   * item->fragments, LFT/RGT pullback, LV level slice), the persistence-registry
   * rows (PR, tier 2 = pod), and the overlay (OV resource->holon, OVR
   * holon->resources) committed together so a reader never sees a partial holon.
   * Two writers composing the same slice touch identical keys → convergent no-op.
   * `top` = the highest-level node in the slice.
   */
  async compose(
    slice: readonly StoredNode[],
    opts: { pod: string; resource: string },
  ): Promise<ComposeResult> {
    if (slice.length === 0) throw new Error('compose: empty slice');
    const top = slice.reduce((a, b) => (b.level >= a.level ? b : a));
    return this.fdb.transact(async (txn) => {
      let created = 0;
      let dedup = 0;
      for (const node of slice) {
        const addr = nodeAddrFromUrn(node.uri);
        const nkey = nodeKey(addr);
        if ((await txn.get(nkey)) === undefined) { txn.set(nkey, encodeNode(node)); created++; }
        else dedup++;
        txn.set(lvKey(node.level, addr), EMPTY);
        txn.set(prKey(addr, 2), encodeJson({ tier: 2 }));
        if (node.kind === 'fragment') {
          (node.items ?? []).forEach((itemUri, pos) => {
            const itemAddr = nodeAddrFromUrn(itemUri);
            txn.set(ciKey(addr.hash, pos), enc.encode(itemUri));
            txn.set(cbKey(itemAddr, addr.hash), EMPTY);
          });
          if (node.left) txn.set(lftKey(nodeAddrFromUrn(node.left).hash, addr.hash), EMPTY);
          if (node.right) txn.set(rgtKey(nodeAddrFromUrn(node.right).hash, addr.hash), EMPTY);
        }
      }
      txn.set(ovKey(opts.pod, opts.resource), enc.encode(top.uri));
      txn.set(ovrKey(nodeAddrFromUrn(top.uri).hash, opts.pod, opts.resource), EMPTY);
      return { created, dedup, topUri: top.uri };
    });
  }

  /** Point read of a node by its content-address URN. */
  async resolve(uri: string): Promise<StoredNode | null> {
    const key = nodeKey(nodeAddrFromUrn(uri));
    return this.fdb.transact(async (txn) => {
      const v = await txn.get(key);
      return v === undefined ? null : decodeNode(v);
    });
  }

  /** Resolve the holon an LDP resource projects (via the OV overlay). */
  async resolveResource(pod: string, resource: string): Promise<StoredNode | null> {
    return this.fdb.transact(async (txn) => {
      const v = await txn.get(ovKey(pod, resource));
      if (v === undefined) return null;
      const nv = await txn.get(nodeKey(nodeAddrFromUrn(dec.decode(v))));
      return nv === undefined ? null : decodeNode(nv);
    });
  }

  /** A fragment's ordered item URIs (via the CI index — range read, no scan). */
  async fragmentItems(fragUri: string): Promise<string[]> {
    const { begin, end } = ciRange(nodeAddrFromUrn(fragUri).hash);
    return this.fdb.transact(async (txn) => {
      const rows = await txn.getRange(begin, end); // key order = ascending position
      return rows.map((r) => dec.decode(r.value));
    });
  }

  /** Which fragments contain an atom/fragment (via the CB index). */
  async fragmentsContaining(itemUri: string): Promise<string[]> {
    const { begin, end } = cbRange(nodeAddrFromUrn(itemUri));
    return this.fdb.transact(async (txn) => {
      const rows = await txn.getRange(begin, end);
      return rows.map((r) => urnFromNodeAddr({ kind: 'fragment', hash: cbFragHash(r.key) }));
    });
  }

  /** All node URIs at a given level (via the LV index). */
  async levelSlice(level: number): Promise<string[]> {
    const { begin, end } = lvRange(level);
    return this.fdb.transact(async (txn) => {
      const rows = await txn.getRange(begin, end);
      return rows.map((r) => {
        const b = lvAddrBytes(r.key);
        return urnFromNodeAddr({ kind: b[0] === 0x01 ? 'atom' : 'fragment', hash: b.slice(1) });
      });
    });
  }

  /**
   * Rebuild the node registry from the durable store — with node BODIES, not
   * just recomputable URIs. The fix for in-memory-singleton restart loss.
   */
  async rehydrate(): Promise<Map<string, StoredNode>> {
    const { begin, end } = nodeRange();
    return this.fdb.transact(async (txn) => {
      const rows = await txn.getRange(begin, end);
      const out = new Map<string, StoredNode>();
      for (const { value } of rows) {
        const n = decodeNode(value);
        out.set(n.uri, n);
      }
      return out;
    });
  }

  // ── Per-atom (edge-scoped) ABAC attributes (AA + AAX) ──
  // The value's identity never carries its access class; class lives on the
  // containing edge (scope), so one shared atom can be public in one holon and
  // secret in another. Written/read only by a trusted mediator's PDP.

  async putAtomAttributes(scope: string, atomUri: string, attrs: AtomAccessAttributes): Promise<void> {
    const addr = nodeAddrFromUrn(atomUri);
    await this.fdb.transact(async (txn) => {
      txn.set(aaKey(scope, addr), encodeJson(attrs));
      txn.set(aaxKey(scope, attrs.classification, addr), EMPTY);
    });
  }
  async getAtomAttributes(scope: string, atomUri: string): Promise<AtomAccessAttributes | undefined> {
    const addr = nodeAddrFromUrn(atomUri);
    return this.fdb.transact(async (txn) => {
      const v = await txn.get(aaKey(scope, addr));
      return v === undefined ? undefined : decodeJson<AtomAccessAttributes>(v);
    });
  }
  /** All atom attributes recorded in a scope (edge/holon) — one prefix scan. */
  async getHolonAtomAttributes(scope: string): Promise<Map<string, AtomAccessAttributes>> {
    const { begin, end } = aaScopeRange(scope);
    return this.fdb.transact(async (txn) => {
      const rows = await txn.getRange(begin, end);
      const out = new Map<string, AtomAccessAttributes>();
      for (const r of rows) {
        const b = aaAtomAddrBytes(r.key);
        const uri = urnFromNodeAddr({ kind: b[0] === 0x01 ? 'atom' : 'fragment', hash: b.slice(1) });
        out.set(uri, decodeJson<AtomAccessAttributes>(r.value));
      }
      return out;
    });
  }

  // ── Mutable control-plane (.internal accounts / idp clients / sessions) ──
  async cpSet(collection: string, id: string, doc: unknown): Promise<void> {
    const key = cpKey(collection, id);
    await this.fdb.transact(async (txn) => { txn.set(key, encodeJson(doc)); });
  }
  async cpGet<T = unknown>(collection: string, id: string): Promise<T | null> {
    const key = cpKey(collection, id);
    return this.fdb.transact(async (txn) => {
      const v = await txn.get(key);
      return v === undefined ? null : decodeJson<T>(v);
    });
  }
  async cpDelete(collection: string, id: string): Promise<void> {
    const key = cpKey(collection, id);
    await this.fdb.transact(async (txn) => { txn.clear(key); });
  }
  async cpClearCollection(collection: string): Promise<void> {
    const { begin, end } = cpRange(collection);
    await this.fdb.transact(async (txn) => { txn.clearRange(begin, end); });
  }
  /** List control-plane entries in a collection (optionally filtered by id prefix). */
  async cpList<T = unknown>(collection: string, idPrefix = ''): Promise<Array<{ id: string; value: T }>> {
    const { begin, end } = cpListRange(collection, idPrefix);
    return this.fdb.transact(async (txn) => {
      const rows = await txn.getRange(begin, end);
      return rows.map((r) => ({ id: cpIdFromKey(collection, r.key), value: decodeJson<T>(r.value) }));
    });
  }
}

export function openStore(fdb: FdbLike): PgslStore {
  return new PgslStore(fdb);
}
