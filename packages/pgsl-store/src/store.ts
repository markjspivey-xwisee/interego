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

import type { FdbLike, FdbTxn } from './fdb-like.js';
import { createHash, randomUUID } from 'node:crypto';
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
  strinc,
} from './keyspace.js';
import { decodeJson, decodeNode, encodeJson, encodeNode, type StoredNode } from './node.js';
import type { AtomAccessAttributes } from './attributes.js';
import {
  assertExpectedResourceRevision, resourceCollection, resourceRevision, NativeResourceManagedError,
  type NativeResourceRecord, type NativeResourceHead, type NativeResourceCommitResult,
} from './resource.js';

const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface PutResult { created: boolean; }
export interface PutManyResult { created: number; dedup: number; }
export interface ComposeResult { created: number; dedup: number; topUri: string; }
/** One direct child of a control-plane id prefix, split at '/' (see `cpListChildren`). */
export interface CpChild<T> {
  /** A leaf's full id, or a branch's sub-prefix (ending in '/'). */
  id: string;
  /** True for a sub-prefix that has entries under it (an LDP child container). */
  branch: boolean;
  /** The leaf's document, or the branch's own entry stored at exactly `id`, if any. */
  value: T | undefined;
}
const SLASH = 0x2f;
// Batch sizes for the direct-children skip-scan. A batch restarts small after it met a branch,
// because the rows after a branch's first row are mostly its subtree; it doubles over a run of
// leaves. So no child costs more than CHILD_BATCH_MAX - 1 wasted rows, however deep it is.
const CHILD_BATCH_FIRST = 8;
const CHILD_BATCH_MAX = 256;
/** Children per `firstPerSegment` page, where the backend offers it (exported for the seam tests). */
export const CHILD_PAGE = 1000;
function compareKeys(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
/** The first key strictly after `key` in bytewise order (the cursor rule in fdb-like.ts). */
function keyAfter(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1);
  out.set(key);
  return out;
}
class ResourceWriteRace extends Error {}
// Provenance is edge/context metadata; immutable node content must agree even
// when the same bytes are projected with a different media type or attribution.
function nodeContentIdentity(node: StoredNode): string {
  return JSON.stringify([node.uri, node.kind, node.level, node.value ?? null, node.items ?? [],
    node.kind === 'fragment' ? node.height ?? Math.max(0, node.level - 1) : null,
    node.left ?? null, node.right ?? null]);
}

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
    return this.fdb.transact(txn => this.composeInTransaction(txn, slice, opts));
  }

  /** Shared composition so a native head and its canonical slice use one transaction. */
  private async composeInTransaction(
    txn: FdbTxn, slice: readonly StoredNode[], opts: { pod: string; resource: string }, topUri?: string,
  ): Promise<ComposeResult> {
    const top = topUri ?? slice.reduce((a, b) => (b.level >= a.level ? b : a)).uri;
      let created = 0;
      let dedup = 0;
      for (const node of slice) {
        const addr = nodeAddrFromUrn(node.uri);
        const nkey = nodeKey(addr);
        // ★ A NODE THAT EXISTS ALREADY HAS ITS PROJECTION ROWS. Every row below is a function of
        // the node's content and address, so re-setting them for a deduplicated node changes
        // nothing and costs a dead tuple per row. This used to run unconditionally: on the
        // production store a publish that rewrote a manifest re-set thousands of I/B rows for
        // fragments that had not changed, measured at two thousand row updates a minute with
        // no reader ever seeing a difference, and that churn is what filled the volume behind
        // the unreferenced history (2026-09-20). The collector in gc.ts reconstructs exactly
        // these rows for every live node, so a node's presence implies its rows' presence.
        if ((await txn.get(nkey)) !== undefined) { dedup++; continue; }
        txn.set(nkey, encodeNode(node));
        created++;
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

    txn.set(ovKey(opts.pod, opts.resource), enc.encode(top));
    txn.set(ovrKey(nodeAddrFromUrn(top).hash, opts.pod, opts.resource), EMPTY);
    return { created, dedup, topUri: top };
  }

  /** One native resource head with a token derived from those same stored bytes. */
  async resourceHead(pod: string, path: string): Promise<NativeResourceHead | null> {
    return this.fdb.transact(async txn => {
      const bytes = await txn.get(cpKey(resourceCollection(pod), path));
      return bytes === undefined ? null : {
        record: decodeJson<NativeResourceRecord>(bytes), revision: resourceRevision(pod, path, bytes),
      };
    });
  }

  /**
   * Atomically commit the native head, canonical nodes, structural indexes and
   * both overlay directions. The receipt describes this write, never a later
   * HEAD request. Uses only the existing native transaction and keyspace.
   */
  async commitResource(
    slice: readonly StoredNode[],
    options: { pod: string; resource: string; record: NativeResourceRecord; expectedRevision: string | null; legacy?: boolean },
  ): Promise<NativeResourceCommitResult> {
    assertExpectedResourceRevision(options.expectedRevision);
    const { pod, resource: path } = options;
    const record: NativeResourceRecord = { ...options.record, commitNonce: randomUUID() };
    if (options.legacy) delete record.nativeManaged;
    else record.nativeManaged = true;
    if (!record.bodyDigest || !/^sha256:[a-f0-9]{64}$/.test(record.bodyDigest)
      || !Number.isSafeInteger(record.size) || record.size < 0
      || !Number.isFinite(record.updatedAt) || typeof record.contentType !== 'string' || !record.contentType) {
      throw new Error('native resource commit requires valid representation metadata');
    }
    const bytes = encodeJson(record);
    const revision = resourceRevision(pod, path, bytes);
    const key = cpKey(resourceCollection(pod), path);
    try {
      return await this.fdb.transact(async txn => {
        const previous = await txn.get(key);
        if (options.legacy && previous !== undefined && decodeJson<NativeResourceRecord>(previous).nativeManaged) {
          throw new NativeResourceManagedError();
        }
        const observed = previous === undefined ? null : resourceRevision(pod, path, previous);
        if (observed !== options.expectedRevision) return { status: 'conflict' as const, revision: observed };
        // Restate the expectation in the write: SELECT then SET is not a CAS
        // under READ COMMITTED. Failure must abort all related writes.
        if (!await txn.compareAndSet(key, previous ?? null, bytes)) throw new ResourceWriteRace();
        const available = new Map<string, StoredNode>();
        for (const node of slice) {
          const duplicate = available.get(node.uri);
          if (duplicate && nodeContentIdentity(duplicate) !== nodeContentIdentity(node)) {
            throw new Error('native resource contains conflicting canonical node content');
          }
          available.set(node.uri, node);
        }
        const resolved = new Map<string, StoredNode>();
        const resolve = async (uri: string): Promise<StoredNode> => {
          const cached = resolved.get(uri);
          if (cached) return cached;
          const local = available.get(uri);
          const stored = await txn.get(nodeKey(nodeAddrFromUrn(uri)));
          if (stored === undefined) {
            if (!local) throw new Error('native resource head references an unavailable canonical node');
            resolved.set(uri, local);
            return local;
          }
          const node = decodeNode(stored);
          if (node.uri !== uri || (local && nodeContentIdentity(local) !== nodeContentIdentity(node))) {
            throw new Error('native resource references conflicting canonical node content');
          }
          resolved.set(uri, node);
          return node;
        };
        await resolve(record.topUri);
        await resolve(record.opaqueUri);
        for (const node of slice) {
          await resolve(node.uri);
          for (const ref of [...(node.items ?? []), ...(node.left ? [node.left] : []), ...(node.right ? [node.right] : [])]) await resolve(ref);
        }
        const digest = createHash('sha256');
        let size = 0;
        for (const uri of record.chunkUris?.length ? record.chunkUris : [record.opaqueUri]) {
          const node = await resolve(uri);
          if (node.kind !== 'atom' || typeof node.value !== 'string') throw new Error('native representation is not an opaque byte atom');
          const chunk = Buffer.from(node.value, 'base64');
          size += chunk.byteLength;
          digest.update(chunk);
        }
        if (size !== record.size || `sha256:${digest.digest('hex')}` !== record.bodyDigest) {
          throw new Error('native representation bytes do not match the committed metadata');
        }
        const oldTop = await txn.get(ovKey(pod, path));
        if (oldTop !== undefined && dec.decode(oldTop) !== record.topUri) {
          txn.clear(ovrKey(nodeAddrFromUrn(dec.decode(oldTop)).hash, pod, path));
        }
        await this.composeInTransaction(txn, slice, { pod, resource: path }, record.topUri);
        return { status: 'committed' as const, pod, path, revision,
          topUri: record.topUri, opaqueUri: record.opaqueUri, bodyDigest: record.bodyDigest!,
          contentType: record.contentType, updatedAt: record.updatedAt, size: record.size };
      });
    } catch (error) {
      if (!(error instanceof ResourceWriteRace)) throw error;
      return { status: 'conflict', revision: (await this.resourceHead(pod, path))?.revision ?? null };
    }
  }

  /** Legacy deletion is atomic with its overlay and cannot erase a managed head. */
  async deleteLegacyResource(pod: string, path: string): Promise<boolean> {
    const key = cpKey(resourceCollection(pod), path);
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        return await this.fdb.transact(async txn => {
          const previous = await txn.get(key);
          if (previous === undefined) return false;
          if (decodeJson<NativeResourceRecord>(previous).nativeManaged) throw new NativeResourceManagedError();
          // Acquire the exact row predicate before clearing. On engines with
          // READ COMMITTED, get+clear alone can otherwise erase a later commit.
          if (!await txn.compareAndSet(key, previous, previous)) throw new ResourceWriteRace();
          txn.clear(key);
          const top = await txn.get(ovKey(pod, path));
          txn.clear(ovKey(pod, path));
          if (top !== undefined) txn.clear(ovrKey(nodeAddrFromUrn(dec.decode(top)).hash, pod, path));
          return true;
        });
      } catch (error) {
        if (!(error instanceof ResourceWriteRace)) throw error;
      }
    }
    throw new Error('native resource changed repeatedly during legacy delete');
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

  /**
   * Forget the overlay of a resource that no longer exists: its O row and the W row that
   * pointed the top node back at it. The content nodes stay (grow-only); without this, a
   * deleted resource's overlay kept its nodes reachable for the collector forever.
   */
  async clearOverlay(pod: string, resource: string): Promise<boolean> {
    return this.fdb.transact(async (txn) => {
      const key = ovKey(pod, resource);
      const v = await txn.get(key);
      if (v === undefined) return false;
      txn.clear(key);
      try { txn.clear(ovrKey(nodeAddrFromUrn(dec.decode(v)).hash, pod, resource)); } catch { /* an unreadable top: the O row alone goes */ }
      return true;
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

  /**
   * The DIRECT children of an id prefix, splitting ids at '/': a leaf is an id with no further
   * '/', a branch is the sub-prefix up to and including the next '/'. Ascending bytewise by key.
   *
   * ★ BOUNDED BY THE CHILDREN, NOT BY THE DESCENDANTS. `cpList` over the prefix reads and decodes
   * every row beneath it; for an LDP root that is every record of every pod on the server, and it
   * was the 6-15 s root GET that outlived CSS's lock (2026-10-22). This walks the ordered keyspace
   * instead: leaves are read in batches, and at a branch's first row the cursor jumps to
   * strinc(branch prefix), past its whole subtree. A branch's subtree is one contiguous key range,
   * and its own entry (the container marker), when present, is the first key in it.
   */
  async cpListChildren<T = unknown>(collection: string, idPrefix = ''): Promise<Array<CpChild<T>>> {
    const { begin, end } = cpListRange(collection, idPrefix);
    return this.fdb.transact(async (txn) => {
      const out: Array<CpChild<T>> = [];
      /** Lists the child a row starts; for a branch, returns strinc(branch prefix), past its subtree. */
      const classify = (key: Uint8Array, value: Uint8Array): Uint8Array | undefined => {
        if (key.length === begin.length) return undefined; // the prefix's own entry is not its child
        // 0x2f never occurs inside a multi-byte UTF-8 sequence, so a byte search is exact.
        const slash = key.indexOf(SLASH, begin.length);
        if (slash === -1) {
          out.push({ id: cpIdFromKey(collection, key), branch: false, value: decodeJson<T>(value) });
          return undefined;
        }
        const branchKey = key.subarray(0, slash + 1);
        out.push({
          id: cpIdFromKey(collection, branchKey),
          branch: true,
          value: key.length === branchKey.length ? decodeJson<T>(value) : undefined,
        });
        return strinc(branchKey);
      };
      // A backend that walks its own index returns only each child's first row: one round trip
      // per CHILD_PAGE children instead of one per child container (see fdb-like.ts).
      if (txn.firstPerSegment) {
        let start = keyAfter(begin);
        for (;;) {
          const rows = await txn.firstPerSegment(start, end, { segmentOffset: begin.length, separator: SLASH, limit: CHILD_PAGE });
          for (const { key, value } of rows) start = classify(key, value) ?? keyAfter(key);
          if (rows.length < CHILD_PAGE) return out;
        }
      }
      let cursor: Uint8Array = begin;
      let limit = CHILD_BATCH_FIRST;
      for (;;) {
        const rows = await txn.getRange(cursor, end, { limit });
        let skipTo: Uint8Array | undefined;
        for (const { key, value } of rows) {
          if (skipTo && compareKeys(key, skipTo) < 0) continue; // inside a branch already listed
          skipTo = classify(key, value) ?? skipTo;
        }
        if (rows.length < limit) return out;
        const next = keyAfter(rows[rows.length - 1]!.key);
        cursor = skipTo && compareKeys(skipTo, next) > 0 ? skipTo : next;
        limit = skipTo ? CHILD_BATCH_FIRST : Math.min(limit * 2, CHILD_BATCH_MAX);
      }
    });
  }

  /** Whether any entry has an id strictly extending `idPrefix` — one row read, at most. */
  async cpHasUnder(collection: string, idPrefix: string): Promise<boolean> {
    const { begin, end } = cpListRange(collection, idPrefix);
    return this.fdb.transact(async (txn) => (await txn.getRange(keyAfter(begin), end, { limit: 1 })).length > 0);
  }
}

export function openStore(fdb: FdbLike): PgslStore {
  return new PgslStore(fdb);
}
