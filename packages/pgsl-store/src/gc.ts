/**
 * Garbage collection for a grow-only, content-addressed node store.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * `LdpStore` implements PUT-overwrite by repointing a resource's mutable record at new nodes;
 * the previous nodes "simply become unreferenced" (ldp.ts). Nothing ever removed them. On the
 * production pod store that meant one pod's manifest, rewritten a few thousand times while it
 * was 30 to 45 MB, kept every copy: 45 GB in a table whose live content is a small fraction of
 * that, until the volume filled and Postgres stopped writing (2026-09-20).
 *
 * ── WHAT "LIVE" MEANS ─────────────────────────────────────────────────────────────────────────
 *
 * Roots are everything the mutable subspaces point at:
 *   C  control-plane records: an LDP ResourceRecord names topUri, opaqueUri and chunkUris; any
 *      other collection is kept whole and any node URN inside it is a root as well;
 *   O  overlay resource -> holon: the value is the top node's URN;
 *   A / X  per-atom attributes and their classification index: the atom in the key is a root
 *      (an attribute someone set is a claim about that atom, whatever else references it);
 *   P  persistence registry: rows whose tier is not the derived tier 2 are roots.
 * From the roots, a fragment reaches its items (I is written from `items`), and a level >= 2
 * fragment reaches its left and right constituents. Every node reached is live.
 *
 * The keys to keep are then reconstructed exactly as `PgslStore.compose` wrote them — N, V and
 * P per node; I, B, L, R per fragment — plus the W rows whose top node is live, plus every row
 * of C, O, A and X. Everything else in the table is garbage: unreferenced nodes and the
 * projection rows that only they justify.
 *
 * ── HOW IT IS APPLIED ─────────────────────────────────────────────────────────────────────────
 *
 * Deleting tens of millions of rows leaves a table just as large until it is rewritten, and a
 * rewrite of a 45 GB table needs 45 GB free. The live set is small, so `rebuildTable` copies
 * the live rows into a new table under a budgeted ACCESS EXCLUSIVE attempt. The collection
 * runs inside that lock, so nothing written during the copy can be missed. NOWAIT refuses
 * contention; a short monotonic SQL work budget aborts a long traversal/copy. Only a completed
 * attempt swaps the names and leaves the old table for later verified retirement. Large live
 * graphs can therefore defer compaction; this is not an online collector. Durable COMMIT and
 * network/scheduling latency are not an absolute wall-clock bound. `tools/pgsl-store-gc.ts`
 * drives it; a dry run only reads.
 */

import { kindByte, nodeAddrFromUrn, type NodeAddr, type NodeKind } from './addressing.js';
import { performance } from 'node:perf_hooks';
import type { FdbLike } from './fdb-like.js';
import {
  SUBSPACE_PAYLOAD_OFFSET, cbKey, ciKey, cpKey, lftKey, lvKey, nodeAddrBytes, nodeKey, prKey, rgtKey, subspaceRange, type SubspaceTag,
} from './keyspace.js';
import type { StoredNode } from './node.js';
import { ATOM_HEADER_BYTES, atomTopologyFromPrefix } from './gc-atom-header.js';

const dec = new TextDecoder();
const nodeDec = new TextDecoder('utf-8', { fatal: true });
// Root recognition must use the same dual-read codec as fragment edges.
// Otherwise a current URL-form head would be omitted from the live closure.
function isNodeIdentifier(value: string): boolean {
  if (!value.startsWith('urn:pgsl:') && !value.includes('/ns/pgsl/')) return false;
  try { nodeAddrFromUrn(value); return true; } catch { return false; }
}
const ADDR_BYTES = 21;
const HASH_BYTES = 20;
// Large opaque atoms are commonly ~700 KiB. A 2,000-node fetch can allocate
// over a gigabyte before traversal starts; keep each fetch small instead.
const TRAVERSAL_BATCH_SIZE = 32;
export type NodeTopology = Pick<StoredNode, 'kind' | 'level' | 'items' | 'left' | 'right'>;
export interface NodeTopologyRecord {
  /** Null records an unreadable node; collection must not authorize cleanup. */
  readonly topology: NodeTopology | null;
  /** Exact original stored value bytes, never the projected JSON length. */
  readonly byteLength: number;
}

/** Collector reads; `readerFromFdb` serves tests, `readerFromPg` production. */
export interface KvReader {
  /** Every row of [begin, end) in key order, paged; `onRow` may be async. */
  scan(begin: Uint8Array, end: Uint8Array, onRow: (key: Uint8Array, value: Uint8Array) => void): Promise<void>;
  /** The values of the given keys, by hex key; absent keys are simply missing from the map. */
  getMany(keys: readonly Uint8Array[]): Promise<Map<string, Uint8Array>>;
  /** Optional payload-free traversal; absent keys have no stored node row. */
  getManyTopology?(keys: readonly Uint8Array[]): Promise<Map<string, NodeTopologyRecord>>;
}

function nodeTopology(value: unknown): NodeTopology | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if ((row.kind !== 'atom' && row.kind !== 'fragment') || !Number.isSafeInteger(row.level) || (row.level as number) < 0) return null;
  if (row.kind === 'atom') return { kind: row.kind, level: row.level as number };
  if ((row.items != null && (!Array.isArray(row.items) || row.items.some(item => typeof item !== 'string')))
    || (row.left != null && typeof row.left !== 'string') || (row.right != null && typeof row.right !== 'string')) return null;
  return { kind: row.kind, level: row.level as number,
    ...(row.items != null ? { items: row.items as string[] } : {}),
    ...(row.left != null ? { left: row.left as string } : {}),
    ...(row.right != null ? { right: row.right as string } : {}) };
}

export const hex = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('hex');
export const unhex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

export function readerFromFdb(fdb: FdbLike, pageSize = 1000): KvReader {
  return {
    async scan(begin, end, onRow) {
      let from = begin;
      for (;;) {
        const rows = await fdb.transact((txn) => txn.getRange(from, end, { limit: pageSize }));
        for (const r of rows) onRow(r.key, r.value);
        if (rows.length < pageSize) return;
        // This is an exclusive cursor after ONE key, not a prefix-range end.
        // strinc(last) skips every extension, including document ACL keys.
        from = Uint8Array.from([...rows[rows.length - 1]!.key, 0]);
      }
    },
    async getMany(keys) {
      const out = new Map<string, Uint8Array>();
      await fdb.transact(async (txn) => {
        for (const k of keys) {
          const v = await txn.get(k);
          if (v !== undefined) out.set(hex(k), v);
        }
      });
      return out;
    },
  };
}

/** A reader over a `pg` client (or pool); traversal fetches at most 32 nodes per query. */
export function readerFromPg(client: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<{
  k: Buffer; v?: Buffer; topology?: unknown; value_bytes?: unknown; needs_js_parse?: unknown; atom_header?: Buffer | null;
}> }> }, table = 'pgsl_kv', pageSize = 5000, topologyBatchSize = TRAVERSAL_BATCH_SIZE): KvReader {
  const t = table.replace(/[^a-zA-Z0-9_]/g, '');
  if (!Number.isSafeInteger(topologyBatchSize) || topologyBatchSize < 1 || topologyBatchSize > 4096) throw new Error('invalid topology batch size');
  return {
    async scan(begin, end, onRow) {
      let from = Buffer.from(begin);
      const endBuf = Buffer.from(end);
      for (;;) {
        const r = await client.query(`SELECT k, v FROM ${t} WHERE k >= $1 AND k < $2 ORDER BY k LIMIT $3`, [from, endBuf, pageSize]);
        for (const row of r.rows) {
          if (!Buffer.isBuffer(row.v)) throw new Error('collector row value is unavailable');
          onRow(new Uint8Array(row.k), new Uint8Array(row.v));
        }
        if (r.rows.length < pageSize) return;
        from = Buffer.concat([r.rows[r.rows.length - 1]!.k, Buffer.from([0])]);
      }
    },
    async getMany(keys) {
      const out = new Map<string, Uint8Array>();
      for (let i = 0; i < keys.length; i += 2000) {
        const batch = keys.slice(i, i + 2000).map((k) => Buffer.from(k));
        const r = await client.query(`SELECT k, v FROM ${t} WHERE k = ANY($1::bytea[])`, [batch]);
        for (const row of r.rows) {
          if (!Buffer.isBuffer(row.v)) throw new Error('collector row value is unavailable');
          out.set(hex(new Uint8Array(row.k)), new Uint8Array(row.v));
        }
      }
      return out;
    },
    async getManyTopology(keys) {
      const out = new Map<string, NodeTopologyRecord>();
      // Ordinary atom values/provenance stay in PostgreSQL. JSON's native
      // parser rejects escapes that JS JSON.stringify can legitimately emit
      // (NUL and lone surrogates), even in ignored values. Divert every raw
      // backslash-u sequence before parsing and read only that exceptional row
      // with the native JS semantics. This conservative discriminator can
      // produce harmless false positives, without poisoning a rebuild's SQL
      // transaction or exporting the rest of its 32-node batch.
      // Only atom header probes may use the large private-network batch. Full
      // fragment topology remains in batches of 32, even for a 4096-node frontier.
      const ordered = topologyBatchSize > TRAVERSAL_BATCH_SIZE
        ? [...keys.filter(k => k[SUBSPACE_PAYLOAD_OFFSET] === 1), ...keys.filter(k => k[SUBSPACE_PAYLOAD_OFFSET] !== 1)] : keys;
      for (let i = 0; i < ordered.length;) {
        const atom = ordered[i]![SUBSPACE_PAYLOAD_OFFSET] === 1;
        const limit = atom ? topologyBatchSize : Math.min(topologyBatchSize, TRAVERSAL_BATCH_SIZE);
        let end = Math.min(i + limit, ordered.length);
        if (topologyBatchSize > TRAVERSAL_BATCH_SIZE) while (end > i + 1 && (ordered[end - 1]![SUBSPACE_PAYLOAD_OFFSET] === 1) !== atom) end--;
        const batch = ordered.slice(i, end).map(k => Buffer.from(k));
        i = end;
        try {
          const result = await client.query(`SELECT source.k, octet_length(source.v) AS value_bytes,
              substring(source.v FROM 1 FOR ${ATOM_HEADER_BYTES}) AS atom_header,
              false AS needs_js_parse, NULL::json AS topology
            FROM ${t} AS source
            WHERE source.k = ANY($1::bytea[]) AND get_byte(source.k, ${SUBSPACE_PAYLOAD_OFFSET}) = 1
            UNION ALL
            SELECT source.k, octet_length(source.v) AS value_bytes, NULL::bytea AS atom_header,
              position(decode('5c75', 'hex') in source.v) > 0 AS needs_js_parse,
              json_build_object('uri', n.uri, 'kind', n.kind, 'level', n.level,
                'items', CASE WHEN n.kind #>> '{}' = 'fragment' THEN n.items END,
                'left', CASE WHEN n.kind #>> '{}' = 'fragment' THEN n."left" END,
                'right', CASE WHEN n.kind #>> '{}' = 'fragment' THEN n."right" END) AS topology
            FROM ${t} AS source
            CROSS JOIN LATERAL json_to_record(CASE
              WHEN position(decode('5c75', 'hex') in source.v) > 0 THEN '{}'::json
              ELSE convert_from(source.v, 'UTF8')::json END)
              AS n(uri text, kind json, level json, items json, "left" json, "right" json)
            WHERE source.k = ANY($1::bytea[]) AND get_byte(source.k, ${SUBSPACE_PAYLOAD_OFFSET}) <> 1`, [batch]);
          for (const row of result.rows) {
            if (!Buffer.isBuffer(row.k) || !Number.isSafeInteger(row.value_bytes) || (row.value_bytes as number) < 0
              || typeof row.needs_js_parse !== 'boolean') {
              throw new Error('invalid topology record');
            }
            if (!row.needs_js_parse && row.topology && typeof row.topology === 'object' && 'uri' in row.topology) {
              const storedUri = (row.topology as { uri?: unknown }).uri;
              if (typeof storedUri !== 'string' || !row.k.equals(Buffer.from(nodeKey(nodeAddrFromUrn(storedUri))))) throw new Error('node body/key binding changed');
            }
            let topology: NodeTopology | null;
            const atomTopology = row.atom_header === null || row.atom_header === undefined ? null
              : atomTopologyFromPrefix(new Uint8Array(row.k), new Uint8Array(row.atom_header), row.value_bytes as number);
            if (atomTopology) topology = atomTopology;
            else if (row.needs_js_parse || row.atom_header !== null && row.atom_header !== undefined) {
              const exceptional = await client.query(`SELECT k, v FROM ${t} WHERE k = ANY($1::bytea[])`, [[row.k]]);
              const value = exceptional.rows[0];
              if (exceptional.rows.length !== 1 || !value || !Buffer.isBuffer(value.k) || !value.k.equals(row.k)
                || !Buffer.isBuffer(value.v) || value.v.length !== row.value_bytes) throw new Error('invalid exceptional topology record');
              const decoded = JSON.parse(nodeDec.decode(value.v)) as StoredNode;
              if (!value.k.equals(Buffer.from(nodeKey(nodeAddrFromUrn(decoded.uri))))) throw new Error('node body/key binding changed');
              topology = nodeTopology(decoded);
            } else topology = nodeTopology(row.topology);
            out.set(hex(new Uint8Array(row.k)), { topology, byteLength: row.value_bytes as number });
          }
        } catch {
          // PostgreSQL JSON/UTF8 error details can include private payload bytes.
          // No caller receives that error or its cause, and no incomplete scan
          // may advance to retirement or rebuilding.
          throw new Error('refusing collection: PostgreSQL node topology could not be read');
        }
      }
      return out;
    },
  };
}

export interface CollectStats {
  /** Rows kept per subspace. */
  readonly kept: Record<SubspaceTag, number>;
  /** Rows seen in the subspaces that were scanned (N, I, B, L and R are not scanned). */
  readonly scanned: Partial<Record<SubspaceTag, number>>;
  readonly roots: number;
  readonly liveNodes: number;
  readonly liveAtoms: number;
  readonly liveFragments: number;
  /** Bytes of live node values, the size the live table will roughly have before compression. */
  readonly liveNodeBytes: number;
  /** Root URNs whose node row does not exist: a record pointing at nothing, reported, never fatal. */
  readonly danglingRoots: string[];
  /** Nodes whose value could not be parsed; kept, with their reconstructed rows, on the safe side. */
  readonly unreadableNodes: number;
  /** O rows whose resource record is gone: deleted resources whose overlay row was never cleared. */
  readonly staleOverlays: number;
}

export interface LiveSet {
  /** Every key to keep, hex-encoded, in no particular order. */
  readonly keys: Set<string>;
  readonly stats: CollectStats;
}

function addrOfBytes(b: Uint8Array): NodeAddr {
  const kind: NodeKind = b[0] === kindByte('fragment') ? 'fragment' : 'atom';
  return { kind, hash: b.slice(1, 1 + HASH_BYTES) };
}

function urnsIn(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') { if (isNodeIdentifier(value)) out.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) urnsIn(v, out); return; }
  if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) urnsIn(v, out);
}

/**
 * Compute the live set. Reads only. Runs in memory proportional to the live set plus the
 * scanned subspaces' keys, which on the production store is a few million short keys.
 */
export async function collectLive(reader: KvReader, opts: { readonly log?: (line: string) => void; readonly traversalBatchSize?: number } = {}): Promise<LiveSet> {
  const log = opts.log ?? (() => undefined);
  const traversalBatchSize = opts.traversalBatchSize ?? TRAVERSAL_BATCH_SIZE;
  if (!Number.isSafeInteger(traversalBatchSize) || traversalBatchSize < 1 || traversalBatchSize > 4096) throw new Error('invalid traversal batch size');
  const keys = new Set<string>();
  const kept: Record<SubspaceTag, number> = { N: 0, I: 0, B: 0, L: 0, R: 0, V: 0, O: 0, W: 0, P: 0, A: 0, X: 0, C: 0 };
  const scanned: Partial<Record<SubspaceTag, number>> = {};
  const roots = new Set<string>();           // node URNs
  const rootAddrs = new Set<string>();       // hex of 21-byte addresses (from A, X, P keys)
  const keep = (tag: SubspaceTag, k: Uint8Array): void => { keys.add(hex(k)); kept[tag] += 1; };

  // Mutable subspaces: kept whole, and mined for roots.
  const controlKeys = new Set<string>();
  await reader.scan(subspaceRange('C').begin, subspaceRange('C').end, (k, v) => {
    scanned.C = (scanned.C ?? 0) + 1;
    keep('C', k);
    controlKeys.add(hex(k));
    try { urnsIn(JSON.parse(dec.decode(v)), roots); } catch { /* not JSON: a record we keep but cannot mine */ }
  });
  // O rows are written by LdpStore beside the resource's C record and were never cleared on
  // delete, so an O row whose C record is gone is the ghost of a deleted resource: it is not
  // kept and does not root anything. An O row whose key cannot be read as (pod, resource) is
  // kept and rooted, on the safe side.
  let staleOverlays = 0;
  await reader.scan(subspaceRange('O').begin, subspaceRange('O').end, (k, v) => {
    scanned.O = (scanned.O ?? 0) + 1;
    const payload = k.slice(SUBSPACE_PAYLOAD_OFFSET);
    const sep = payload.indexOf(0);
    if (sep > 0) {
      const pod = dec.decode(payload.slice(0, sep));
      const resource = dec.decode(payload.slice(sep + 1));
      if (!controlKeys.has(hex(cpKey(`ldp ${pod}`, resource)))) { staleOverlays += 1; return; }
    }
    keep('O', k);
    const urn = dec.decode(v);
    if (isNodeIdentifier(urn)) roots.add(urn);
  });
  for (const tag of ['A', 'X'] as const) {
    await reader.scan(subspaceRange(tag).begin, subspaceRange(tag).end, (k) => {
      scanned[tag] = (scanned[tag] ?? 0) + 1;
      keep(tag, k);
      rootAddrs.add(hex(k.slice(k.length - ADDR_BYTES)));
    });
  }
  // P: tier-2 rows are derived (one per composed node) and follow their node; any other tier is a root.
  const pRows: Array<{ key: Uint8Array; addr: string }> = [];
  await reader.scan(subspaceRange('P').begin, subspaceRange('P').end, (k) => {
    scanned.P = (scanned.P ?? 0) + 1;
    const addr = hex(k.slice(SUBSPACE_PAYLOAD_OFFSET, SUBSPACE_PAYLOAD_OFFSET + ADDR_BYTES));
    const tier = k.length >= SUBSPACE_PAYLOAD_OFFSET + ADDR_BYTES + 4 ? new DataView(k.buffer, k.byteOffset + k.length - 4, 4).getUint32(0) : -1;
    if (tier !== 2) { rootAddrs.add(addr); keep('P', k); }
    else pRows.push({ key: k, addr });
  });
  log(`roots: ${roots.size} URNs from C/O, ${rootAddrs.size} addresses from A/X/P; C ${scanned.C ?? 0}, O ${scanned.O ?? 0}, P ${scanned.P ?? 0} rows`);

  // Traverse.
  const live = new Map<string, { addr: NodeAddr; node: NodeTopology | null }>(); // hex addr -> node
  const dangling: string[] = [];
  let unreadable = 0;
  let liveNodeBytes = 0;
  const frontier: NodeAddr[] = [];
  const enqueue = (addr: NodeAddr): void => { const h = hex(nodeAddrBytes(addr)); if (!live.has(h)) { live.set(h, { addr, node: null }); frontier.push(addr); } };
  for (const urn of roots) { try { enqueue(nodeAddrFromUrn(urn)); } catch { dangling.push(urn); } }
  for (const a of rootAddrs) enqueue(addrOfBytes(unhex(a)));
  let frontierOffset = 0;
  while (frontierOffset < frontier.length) {
    // Shifting a six-figure frontier once per 32 nodes is quadratic work.
    // A cursor plus occasional compaction preserves order with bounded storage.
    const batch = frontier.slice(frontierOffset, frontierOffset + traversalBatchSize);
    frontierOffset += batch.length;
    const batchKeys = batch.map(a => nodeKey(a));
    const values = reader.getManyTopology ? await reader.getManyTopology(batchKeys) : await reader.getMany(batchKeys);
    for (const addr of batch) {
      const k = nodeKey(addr);
      const v = values.get(hex(k));
      const h = hex(nodeAddrBytes(addr));
      if (v === undefined) { dangling.push(`urn:pgsl:${addr.kind}:${hex(addr.hash)}`); live.delete(h); continue; }
      let node: NodeTopology | null = null;
      if (v instanceof Uint8Array) {
        liveNodeBytes += v.length;
        try { node = nodeTopology(JSON.parse(nodeDec.decode(v))); } catch { /* unreadable below */ }
      } else {
        if (!Number.isSafeInteger(v.byteLength) || v.byteLength < 0) throw new Error('refusing collection: invalid topology byte count');
        liveNodeBytes += v.byteLength;
        node = nodeTopology(v.topology);
      }
      if (!node || node.kind !== addr.kind) { node = null; unreadable += 1; }
      // Release fetched bytes as each node is consumed, not at the next batch.
      values.delete(hex(k));
      live.set(h, { addr, node });
      if (node?.kind === 'fragment') {
        for (const item of node.items ?? []) { try { enqueue(nodeAddrFromUrn(item)); } catch { /* not a node urn */ } }
        for (const side of [node.left, node.right]) if (side) { try { enqueue(nodeAddrFromUrn(side)); } catch { /* not a node urn */ } }
      }
    }
    log(`traversed ${live.size} live nodes, frontier ${frontier.length - frontierOffset}`);
    if (frontierOffset >= 16_384) {
      frontier.splice(0, frontierOffset);
      frontierOffset = 0;
    }
  }

  // Reconstruct the rows compose() wrote for each live node.
  let liveAtoms = 0;
  let liveFragments = 0;
  const liveHashes = new Set<string>();
  for (const { addr, node } of live.values()) {
    liveHashes.add(hex(addr.hash));
    keep('N', nodeKey(addr));
    if (node) keep('V', lvKey(node.level, addr));
    if (addr.kind === 'atom') liveAtoms += 1; else liveFragments += 1;
    if (node?.kind === 'fragment') {
      (node.items ?? []).forEach((itemUri, pos) => {
        let itemAddr: NodeAddr;
        try { itemAddr = nodeAddrFromUrn(itemUri); } catch { return; }
        keep('I', ciKey(addr.hash, pos));
        keep('B', cbKey(itemAddr, addr.hash));
      });
      if (node.left) { try { keep('L', lftKey(nodeAddrFromUrn(node.left).hash, addr.hash)); } catch { /* skip */ } }
      if (node.right) { try { keep('R', rgtKey(nodeAddrFromUrn(node.right).hash, addr.hash)); } catch { /* skip */ } }
    }
  }
  // V rows for nodes whose level could not be read: keep every V row of a live address.
  await reader.scan(subspaceRange('V').begin, subspaceRange('V').end, (k) => {
    scanned.V = (scanned.V ?? 0) + 1;
    const addr = hex(k.slice(k.length - ADDR_BYTES));
    if (live.has(addr) && !keys.has(hex(k))) keep('V', k);
  });
  for (const p of pRows) if (live.has(p.addr)) keep('P', p.key);
  for (const { addr } of live.values()) { const k = prKey(addr, 2); if (!keys.has(hex(k))) keep('P', k); }
  await reader.scan(subspaceRange('W').begin, subspaceRange('W').end, (k) => {
    scanned.W = (scanned.W ?? 0) + 1;
    const top = hex(k.slice(SUBSPACE_PAYLOAD_OFFSET, SUBSPACE_PAYLOAD_OFFSET + HASH_BYTES));
    if (liveHashes.has(top)) keep('W', k);
  });
  const stats: CollectStats = {
    kept, scanned, roots: roots.size + rootAddrs.size, liveNodes: live.size, liveAtoms, liveFragments, liveNodeBytes,
    danglingRoots: dangling, unreadableNodes: unreadable, staleOverlays,
  };
  log(`live set: ${keys.size} keys, ${live.size} nodes (${liveAtoms} atoms, ${liveFragments} fragments), ${(liveNodeBytes / 1048576).toFixed(1)} MB of node values, ${dangling.length} dangling roots, ${staleOverlays} stale overlay rows`);
  return { keys, stats };
}

/** Group the live keys by subspace, for reporting and for copying range by range. */
export function keysBySubspace(keys: ReadonlySet<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    const tag = String.fromCharCode(parseInt(k.slice(SUBSPACE_PAYLOAD_OFFSET * 2 - 2, SUBSPACE_PAYLOAD_OFFSET * 2), 16));
    out[tag] = (out[tag] ?? 0) + 1;
  }
  return out;
}

export interface RebuildResult {
  readonly copied: number;
  readonly oldTable: string;
  readonly newRows: number;
}

/** Optional compaction was deferred; the original table remains authoritative. */
export class RebuildDeferredError extends Error {
  readonly code = 'REBUILD_DEFERRED';
  constructor(readonly reason: 'sql-work-budget' | 'lock-unavailable') {
    super(`rebuild deferred: ${reason === 'sql-work-budget' ? 'SQL work budget exhausted' : 'live table is busy'}; compaction is not confirmed`);
    this.name = 'RebuildDeferredError';
  }
}

/**
 * The storage parameters of `from`, applied to `to`: `CREATE TABLE ... (LIKE ... INCLUDING ALL)`
 * copies columns, constraints, indexes and column storage, but no relation options, so the
 * autovacuum settings `--tune` put on the table and its TOAST relation would vanish with every
 * rebuild and the table would drift back to the defaults that let it reach 45 GB. Options are
 * read from the catalog and applied as they are; anything not of the form name=value is
 * skipped and named. Returns what was applied.
 */
export async function copyStorageParameters(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  from: string,
  to: string,
  log: (line: string) => void = () => undefined,
): Promise<string[]> {
  const r = await client.query('SELECT c.reloptions AS heap, tc.reloptions AS toast FROM pg_class c LEFT JOIN pg_class tc ON tc.oid = c.reltoastrelid WHERE c.oid = $1::regclass', [from]);
  const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const wellFormed = /^[a-z_]+=[A-Za-z0-9_.-]+$/;
  const heap = asList(r.rows[0]?.['heap']);
  const toast = asList(r.rows[0]?.['toast']);
  const skipped = [...heap, ...toast].filter((o) => !wellFormed.test(o));
  if (skipped.length > 0) log(`storage parameters not carried over (not name=value): ${skipped.join(', ')}`);
  const heapOk = heap.filter((o) => wellFormed.test(o));
  const toastOk = toast.filter((o) => wellFormed.test(o)).map((o) => `toast.${o}`);
  if (heapOk.length > 0) await client.query(`ALTER TABLE ${to} SET (${heapOk.join(', ')})`);
  if (toastOk.length > 0) await client.query(`ALTER TABLE ${to} SET (${toastOk.join(', ')})`);
  const applied = [...heapOk, ...toastOk];
  if (applied.length > 0) log(`storage parameters carried over to ${to}: ${applied.join(', ')}`);
  return applied;
}
/**
 * Copy the live rows into a fresh table and swap it in, inside one transaction that holds an
 * ACCESS EXCLUSIVE lock on the old table: every other session waits until commit or rollback.
 * The exact live set is computed INSIDE that lock. The entire SQL work has a five-second
 * monotonic budget with a server statement timeout for each remaining slice. PostgreSQL 16
 * cannot interrupt durable COMMIT, so the deadline is checked before dispatch but is not an
 * absolute lock-hold guarantee. This is not online compaction or guaranteed reclamation.
 */
export function rebuildOldTableSuffix(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '');
  return `old_${stamp.slice(0, 8)}_${stamp.slice(8)}`;
}

/** Serialize collectors before PostgreSQL resolves the live relation's OID.
 * A waiter on LOCK TABLE alone can acquire the renamed backup after another
 * collector swaps it, then accidentally collect the new live table unlocked.
 * Session advisory locks also cover CLI measurement/drop and are reentrant when
 * that same session calls rebuildTable. A lost connection releases the lock. */
export async function acquireCollectorLock(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  table: string,
): Promise<() => Promise<void>> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error('invalid collector table name');
  const key = table.toLowerCase();
  const acquired = await client.query("SELECT pg_try_advisory_lock(hashtextextended(current_database() || ':public.' || $1, 0)) AS acquired", [key]);
  if (acquired.rows[0]?.['acquired'] !== true) throw new Error('refusing concurrent collector: another collector holds this database/table lock');
  let released = false;
  return async () => {
    if (released) return;
    const result = await client.query("SELECT pg_advisory_unlock(hashtextextended(current_database() || ':public.' || $1, 0)) AS released", [key]);
    if (result.rows[0]?.['released'] !== true) throw new Error('collector advisory lock release was not confirmed');
    released = true;
  };
}

export async function rebuildTable(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> },
  table: string,
  opts: { readonly log?: (line: string) => void; readonly batch?: number; readonly suffixOld?: string;
    /** Tests or a stricter caller may lower, but never lengthen, the live SQL work budget. */
    readonly sqlWorkBudgetMs?: number } = {},
): Promise<RebuildResult> {
  const t = table.replace(/[^a-zA-Z0-9_]/g, '');
  const oldTable = `${t}_${opts.suffixOld ?? rebuildOldTableSuffix()}`;
  const newTable = `${t}_live`;
  const batch = opts.batch ?? 4000;
  const log = opts.log ?? (() => undefined);
  const budget = opts.sqlWorkBudgetMs ?? 5000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 5000) throw new Error('collector SQL work budget must be between 1 and 5000 milliseconds');
  const release = await acquireCollectorLock(client, t);
  let failure: unknown;
  try {
    // PostgreSQL 16 has no transaction_timeout. On newer servers, use its
    // independent backstop in addition to the remaining-statement budget.
    const setting = await client.query("SELECT current_setting('transaction_timeout', true) AS transaction_timeout");
    const hasTransactionTimeout = typeof setting.rows[0]?.['transaction_timeout'] === 'string';
    const deadline = performance.now() + budget;
    let deferred: RebuildDeferredError | undefined;
    const remaining = (): number => {
      const ms = Math.floor(deadline - performance.now());
      if (ms < 1) { deferred ??= new RebuildDeferredError('sql-work-budget'); throw deferred; }
      return ms;
    };
    const bounded = { async query(sql: string, params?: unknown[]) {
      const allowance = remaining();
      try {
        // A client-side query_timeout does not cancel PostgreSQL work. Use the
        // server's timeout, reduced before EVERY query while the lock is held.
        await client.query(`SET LOCAL statement_timeout = '${allowance}ms'`);
        remaining();
        const result = await client.query(sql, params);
        // An acknowledged commit already released the lock and must never be
        // reported as rolled back just because its reply crossed the deadline.
        if (sql !== 'COMMIT') remaining();
        return result;
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? (error as { code?: string }).code : undefined;
        if (code === '57014') deferred ??= new RebuildDeferredError('sql-work-budget');
        if (code === '55P03') deferred ??= new RebuildDeferredError('lock-unavailable');
        throw deferred ?? error;
      }
    } };
    await client.query('BEGIN');
    try {
      // A stalled collector must not retain its transaction while waiting for
      // another client query. This setting is local to this maintenance attempt.
      await bounded.query("SET LOCAL idle_in_transaction_session_timeout = '1s'");
      if (hasTransactionTimeout) await bounded.query(`SET LOCAL transaction_timeout = '${remaining()}ms'`);
      // ACCESS EXCLUSIVE from the start, not EXCLUSIVE upgraded at the rename: with EXCLUSIVE held,
      // a store transaction that had already read (ACCESS SHARE) and now waited to write blocked on
      // this transaction, whose RENAME then waited on that reader's ACCESS SHARE, and Postgres
      // resolved the cycle by killing the rebuild after the copy (measured on the first production
      // run, 2026-09-20). Take the strongest lock without queuing, then keep the traversal and
      // copy within the short budget; no lock upgrade can form that cycle.
      await bounded.query(`LOCK TABLE ${t} IN ACCESS EXCLUSIVE MODE NOWAIT`);
      log('lock held for a budgeted maintenance attempt; readers and writers resume on commit or rollback');
      const live = await collectLive(readerFromPg(bounded as never, t), { log });
      remaining();
      if (live.keys.size === 0) throw new Error('refusing to rebuild: the live set is empty');
      // A missing or unreadable retained node makes reachability incomplete.
      // Preserve the existing table rather than collecting through uncertainty.
      if (live.stats.danglingRoots.length > 0 || live.stats.unreadableNodes > 0) {
        throw new Error(`refusing to rebuild: ${live.stats.danglingRoots.length} dangling roots and ${live.stats.unreadableNodes} unreadable nodes`);
      }
      await bounded.query(`CREATE TABLE ${newTable} (LIKE ${t} INCLUDING ALL)`);
      await copyStorageParameters(bounded, t, newTable, log);
      const all = [...live.keys];
      let copied = 0;
      for (let i = 0; i < all.length; i += batch) {
        const chunk = all.slice(i, i + batch).map((h) => Buffer.from(h, 'hex'));
        const r = await bounded.query(`INSERT INTO ${newTable} (k, v) SELECT k, v FROM ${t} WHERE k = ANY($1::bytea[]) ON CONFLICT DO NOTHING`, [chunk]);
        copied += r.rowCount ?? 0;
        if ((i / batch) % 25 === 0) log(`copied ${copied} of up to ${all.length} rows`);
      }
      const count = await bounded.query(`SELECT count(*)::bigint AS n FROM ${newTable}`);
      const newRows = Number(count.rows[0]?.['n'] ?? 0);
      // Reconstructed keys are promises of retained data. Both the INSERT row
      // counts and an independent table count must confirm every promised key.
      if (copied !== live.keys.size || newRows !== live.keys.size) {
        throw new Error(`refusing to swap: expected ${live.keys.size} live keys, copied ${copied}, counted ${newRows}`);
      }
      await bounded.query(`ALTER TABLE ${t} RENAME TO ${oldTable}`);
      await bounded.query(`ALTER TABLE ${newTable} RENAME TO ${t}`);
      await bounded.query('COMMIT');
      log(`swapped: ${t} now has ${newRows} rows; the previous table is ${oldTable}`);
      return { copied, oldTable, newRows };
    } catch (err) {
      // Deliberately bypass the exhausted query wrapper so PostgreSQL releases
      // the lock and rolls back any partially copied table or rename.
      await client.query('ROLLBACK').catch(() => undefined);
      throw deferred ?? err;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // A transaction/idle timeout on supported servers terminates the session,
    // which already releases its advisory lock. Preserve the original failure.
    if (failure) await release().catch(() => undefined);
    else await release();
  }
}
