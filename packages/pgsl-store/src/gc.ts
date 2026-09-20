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
 * the live rows into a new table under an EXCLUSIVE lock on the old one (readers continue,
 * writers wait), swaps the names in the same transaction, and leaves the old table for the
 * operator to drop once the store has been checked. The collection runs inside that lock, so
 * nothing written during the copy can be missed. `tools/pgsl-store-gc.ts` drives it; a dry run
 * only reads.
 */

import { kindByte, nodeAddrFromUrn, type NodeAddr, type NodeKind } from './addressing.js';
import type { FdbLike } from './fdb-like.js';
import {
  SUBSPACE_PAYLOAD_OFFSET, cbKey, ciKey, cpKey, lftKey, lvKey, nodeAddrBytes, nodeKey, prKey, rgtKey, strinc, subspaceRange, type SubspaceTag,
} from './keyspace.js';
import type { StoredNode } from './node.js';

const dec = new TextDecoder();
const NODE_URN = /^urn:pgsl:(atom|fragment):[0-9a-f]{40}$/;
const ADDR_BYTES = 21;
const HASH_BYTES = 20;

/** The two reads a collector needs; `readerFromFdb` serves tests, `readerFromPg` production. */
export interface KvReader {
  /** Every row of [begin, end) in key order, paged; `onRow` may be async. */
  scan(begin: Uint8Array, end: Uint8Array, onRow: (key: Uint8Array, value: Uint8Array) => void): Promise<void>;
  /** The values of the given keys, by hex key; absent keys are simply missing from the map. */
  getMany(keys: readonly Uint8Array[]): Promise<Map<string, Uint8Array>>;
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
        from = strinc(rows[rows.length - 1]!.key);
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

/** A reader over a `pg` client (or pool) for the store's table; batched so 100k nodes cost 50 queries. */
export function readerFromPg(client: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<{ k: Buffer; v: Buffer }> }> }, table = 'pgsl_kv', pageSize = 5000): KvReader {
  const t = table.replace(/[^a-zA-Z0-9_]/g, '');
  return {
    async scan(begin, end, onRow) {
      let from = Buffer.from(begin);
      const endBuf = Buffer.from(end);
      for (;;) {
        const r = await client.query(`SELECT k, v FROM ${t} WHERE k >= $1 AND k < $2 ORDER BY k LIMIT $3`, [from, endBuf, pageSize]);
        for (const row of r.rows) onRow(new Uint8Array(row.k), new Uint8Array(row.v));
        if (r.rows.length < pageSize) return;
        from = Buffer.from(strinc(new Uint8Array(r.rows[r.rows.length - 1]!.k)));
      }
    },
    async getMany(keys) {
      const out = new Map<string, Uint8Array>();
      for (let i = 0; i < keys.length; i += 2000) {
        const batch = keys.slice(i, i + 2000).map((k) => Buffer.from(k));
        const r = await client.query(`SELECT k, v FROM ${t} WHERE k = ANY($1::bytea[])`, [batch]);
        for (const row of r.rows) out.set(hex(new Uint8Array(row.k)), new Uint8Array(row.v));
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
  if (typeof value === 'string') { if (NODE_URN.test(value)) out.add(value); return; }
  if (Array.isArray(value)) { for (const v of value) urnsIn(v, out); return; }
  if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) urnsIn(v, out);
}

/**
 * Compute the live set. Reads only. Runs in memory proportional to the live set plus the
 * scanned subspaces' keys, which on the production store is a few million short keys.
 */
export async function collectLive(reader: KvReader, opts: { readonly log?: (line: string) => void } = {}): Promise<LiveSet> {
  const log = opts.log ?? (() => undefined);
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
    if (NODE_URN.test(urn)) roots.add(urn);
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
  const live = new Map<string, { addr: NodeAddr; node: StoredNode | null }>(); // hex addr -> node
  const dangling: string[] = [];
  let unreadable = 0;
  let liveNodeBytes = 0;
  const frontier: NodeAddr[] = [];
  const enqueue = (addr: NodeAddr): void => { const h = hex(nodeAddrBytes(addr)); if (!live.has(h)) { live.set(h, { addr, node: null }); frontier.push(addr); } };
  for (const urn of roots) { try { enqueue(nodeAddrFromUrn(urn)); } catch { dangling.push(urn); } }
  for (const a of rootAddrs) enqueue(addrOfBytes(unhex(a)));
  while (frontier.length > 0) {
    const batch = frontier.splice(0, 2000);
    const values = await reader.getMany(batch.map((a) => nodeKey(a)));
    for (const addr of batch) {
      const k = nodeKey(addr);
      const v = values.get(hex(k));
      const h = hex(nodeAddrBytes(addr));
      if (v === undefined) { dangling.push(`urn:pgsl:${addr.kind}:${hex(addr.hash)}`); live.delete(h); continue; }
      liveNodeBytes += v.length;
      let node: StoredNode | null = null;
      try { node = JSON.parse(dec.decode(v)) as StoredNode; } catch { unreadable += 1; }
      live.set(h, { addr, node });
      if (node?.kind === 'fragment') {
        for (const item of node.items ?? []) { try { enqueue(nodeAddrFromUrn(item)); } catch { /* not a node urn */ } }
        for (const side of [node.left, node.right]) if (side) { try { enqueue(nodeAddrFromUrn(side)); } catch { /* not a node urn */ } }
      }
    }
    log(`traversed ${live.size} live nodes, frontier ${frontier.length}`);
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

/**
 * Copy the live rows into a fresh table and swap it in, inside one transaction that holds an
 * EXCLUSIVE lock on the old table: readers keep reading the old table until the commit, writers
 * wait. The live set is computed INSIDE the lock, so it is exact. The old table is renamed, not
 * dropped; the operator drops it after checking the store.
 */
export async function rebuildTable(
  client: { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> },
  table: string,
  opts: { readonly log?: (line: string) => void; readonly batch?: number; readonly suffixOld?: string } = {},
): Promise<RebuildResult> {
  const t = table.replace(/[^a-zA-Z0-9_]/g, '');
  const oldTable = `${t}_${opts.suffixOld ?? `old_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`}`;
  const newTable = `${t}_live`;
  const batch = opts.batch ?? 4000;
  const log = opts.log ?? (() => undefined);
  await client.query('BEGIN');
  try {
    await client.query(`LOCK TABLE ${t} IN EXCLUSIVE MODE`);
    log('lock held: writers wait, readers continue');
    const live = await collectLive(readerFromPg(client as never, t), { log });
    if (live.keys.size === 0) throw new Error('refusing to rebuild: the live set is empty');
    await client.query(`CREATE TABLE ${newTable} (LIKE ${t} INCLUDING ALL)`);
    const all = [...live.keys];
    let copied = 0;
    for (let i = 0; i < all.length; i += batch) {
      const chunk = all.slice(i, i + batch).map((h) => Buffer.from(h, 'hex'));
      const r = await client.query(`INSERT INTO ${newTable} (k, v) SELECT k, v FROM ${t} WHERE k = ANY($1::bytea[]) ON CONFLICT DO NOTHING`, [chunk]);
      copied += r.rowCount ?? 0;
      if ((i / batch) % 25 === 0) log(`copied ${copied} of up to ${all.length} rows`);
    }
    const count = await client.query(`SELECT count(*)::bigint AS n FROM ${newTable}`);
    const newRows = Number(count.rows[0]?.['n'] ?? 0);
    if (newRows === 0) throw new Error('refusing to swap: the new table is empty');
    await client.query(`ALTER TABLE ${t} RENAME TO ${oldTable}`);
    await client.query(`ALTER TABLE ${newTable} RENAME TO ${t}`);
    await client.query('COMMIT');
    log(`swapped: ${t} now has ${newRows} rows; the previous table is ${oldTable}`);
    return { copied, oldTable, newRows };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
