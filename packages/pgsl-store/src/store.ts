/**
 * PgslStore — the durable, transactional PGSL substrate of record.
 *
 * Coded against the `FdbLike` seam, so it runs identically over the in-memory
 * fake (local unit tests, no Docker) and the real FoundationDB binding (prod +
 * CI). This increment lands: content-addressed grow-only node writes
 * (set-if-absent), point resolve, a full rehydrate (rebuild the registry from
 * the store — the fix for "node bodies lost on restart"), and the mutable
 * control-plane (.internal accounts / idp / sessions), which coexists with the
 * grow-only lattice because FDB does native UPDATE/DELETE.
 *
 * Still to come (next increments): compose-on-write of a whole lattice slice in
 * one transaction, the structural-index + overlay + persistence-registry
 * subspaces, the AA/AAX ABAC attribute store, and the mediator-side
 * ABAC-filtered project-on-read.
 */

import type { FdbLike } from './fdb-like.js';
import { nodeAddrFromUrn } from './addressing.js';
import { cpKey, cpRange, nodeKey, nodeRange } from './keyspace.js';
import {
  decodeJson,
  decodeNode,
  encodeJson,
  encodeNode,
  type StoredNode,
} from './node.js';

export interface PutResult {
  created: boolean;
}
export interface PutManyResult {
  created: number;
  dedup: number;
}

export class PgslStore {
  constructor(private readonly fdb: FdbLike) {}

  /** Content-addressed grow-only write. `created=false` iff the node already existed. */
  async put(node: StoredNode): Promise<PutResult> {
    const key = nodeKey(nodeAddrFromUrn(node.uri));
    return this.fdb.transact(async (txn) => {
      const existing = await txn.get(key);
      if (existing !== undefined) return { created: false };
      txn.set(key, encodeNode(node));
      return { created: true };
    });
  }

  /**
   * Write a whole set of nodes (e.g. a lattice slice) in ONE transaction —
   * atomic and idempotent. Two writers persisting the same slice touch identical
   * content-addressed keys, so the loser's writes are no-ops (convergent).
   */
  async putMany(nodes: readonly StoredNode[]): Promise<PutManyResult> {
    return this.fdb.transact(async (txn) => {
      let created = 0;
      let dedup = 0;
      for (const node of nodes) {
        const key = nodeKey(nodeAddrFromUrn(node.uri));
        const existing = await txn.get(key);
        if (existing === undefined) {
          txn.set(key, encodeNode(node));
          created++;
        } else {
          dedup++;
        }
      }
      return { created, dedup };
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

  /**
   * Rebuild the node registry from the durable store — with node BODIES, not
   * just recomputable URIs. This is the fix for the in-memory-singleton restart
   * loss: after a process restart the lattice is reconstructed from here.
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

  // ── Mutable control-plane (.internal accounts / idp clients / sessions) ──
  // FDB does native UPDATE/DELETE, so password rotation + client/session
  // revocation live here — the thing grow-only content-addressed CAS cannot do.

  async cpSet(collection: string, id: string, doc: unknown): Promise<void> {
    const key = cpKey(collection, id);
    await this.fdb.transact(async (txn) => {
      txn.set(key, encodeJson(doc));
    });
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
    await this.fdb.transact(async (txn) => {
      txn.clear(key);
    });
  }
  /** Revoke a whole control-plane collection (e.g. all of a user's credentials). */
  async cpClearCollection(collection: string): Promise<void> {
    const { begin, end } = cpRange(collection);
    await this.fdb.transact(async (txn) => {
      txn.clearRange(begin, end);
    });
  }
}

export function openStore(fdb: FdbLike): PgslStore {
  return new PgslStore(fdb);
}
