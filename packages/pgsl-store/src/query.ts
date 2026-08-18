/**
 * @module query
 * @description A BOUNDED, ACCESS-SCOPED read over the PGSL keyspace indices.
 *
 * ── ★★ WHY THIS EXISTS, AND WHY IT IS NOT A SPARQL ENDPOINT ─────────────────────────────────
 *
 * A system-wide audit found 51 response surfaces inlining collections that grow with stored data.
 * Underneath all of them was the same absence: there was no way to ASK the substrate a narrow
 * question. The only lattice-wide read the relay offered was `pgsl_to_turtle` — a whole-corpus dump
 * — so "which fragments contain this atom" was answerable only by transferring everything and
 * filtering at the client. An agent could not query, so it downloaded, so responses were unbounded.
 *
 * ★ THE OBVIOUS FIX WAS WRONG, AND THE CODE SAYS WHY. `@interego/pgsl` exports a working SPARQL
 * engine, and mounting it here is a one-liner. It would make things worse: `executeSparqlProtocol`
 * calls `materializeSystem` on EVERY request, walking the entire lattice plus every descriptor into
 * an in-memory triple store before the query is even parsed — converting a wire copy into a heap
 * copy on the request path, at a service with a 2 GiB floor. Its alternative entry point caches that
 * materialization and (until this refactor) never invalidated it. A full materialization is honest
 * in a browser tool against a snapshot; it is not a query service.
 *
 * So this is index-backed. Every method below is a range read over an ordered, prefix-clean keyspace
 * — `cbRange`, `ciRange`, `lvRange` — bounded by `getRange`'s `limit`, with the last key as the
 * cursor. Cost is proportional to the PAGE, never to the corpus. Nothing is materialized.
 *
 * ── ★★ AND THE SCOPE IS THE CALLER'S, NOT A PARAMETER ───────────────────────────────────────
 *
 * The access machinery already existed: `clearancePdp` decides per atom and `getHolonAtomAttributes`
 * loads the attributes. What was missing — the audit's exact finding — is that NOTHING derived a
 * scope from a caller's identity, so every read was either unauthenticated or trusted a string the
 * caller supplied. Here a `QueryPrincipal` is required and its clearance drives the PDP; a caller
 * cannot widen its own view by asking differently.
 *
 * ★ THE FILTER RUNS OVER THE PAGE, NOT THE CORPUS. Loading every attribute in scope to filter one
 * page would reintroduce the unbounded read one layer down, which is exactly the shape being removed
 * — so attributes are fetched only for the URIs on the page in hand.
 *
 * ★ AND A FILTERED PAGE IS STILL A FULL PAGE'S WORTH OF WORK. `pageSize` bounds what is READ; the
 * page returned can be shorter after the PDP removes what the caller may not see. `nextCursor` is
 * what says whether more exists — never the length of `items`, which would end a walk early the
 * first time a page happened to be entirely classified.
 */

import type { Page } from '@interego/core';
import type { FdbLike } from './fdb-like.js';
import { nodeAddrFromUrn, urnFromNodeAddr } from './addressing.js';
import { cbRange, cbFragHash, ciRange, lvRange, lvAddrBytes, aaKey, strinc } from './keyspace.js';
import { decodeJson } from './node.js';
import type { AtomAccessAttributes } from './attributes.js';
import type { Pdp } from './abac-pdp.js';

const dec = new TextDecoder();

/** Who is asking. Derived from a verified identity by the caller — never supplied by the requester. */
export interface QueryPrincipal {
  /** The verified subject (a DID/WebID). Present so a decision can be attributed. */
  readonly subject: string;
  /** The requester's clearance, as the PDP reads it. */
  readonly clearance: number;
  /** The access-attribute scope this principal reads within. */
  readonly scope: string;
}

export interface QueryOptions {
  /** Max keys READ for this page. The returned page may be shorter after access filtering. */
  readonly pageSize?: number;
  /** Opaque continuation from a previous page's `nextCursor`. */
  readonly cursor?: string | null;
}

/**
 * The default page. Deliberately a COUNT here and a byte budget at the transport edge: this layer
 * returns URIs of bounded length, so a count is a real bound; a layer returning bodies of varying
 * size needs the byte budget too (a count sized from a 741-byte mean once met 9.9 KB entries and
 * returned 989,903 bytes).
 */
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;

const b64u = {
  enc: (b: Uint8Array): string => Buffer.from(b).toString('base64url'),
  dec: (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url')),
};

function pageSizeOf(opts?: QueryOptions): number {
  const n = opts?.pageSize;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(Math.floor(n), MAX_PAGE);
}

/** Where this page starts: the cursor if given, else the range's own beginning. */
function beginAt(rangeBegin: Uint8Array, cursor?: string | null): Uint8Array {
  return cursor ? b64u.dec(cursor) : rangeBegin;
}

/**
 * A bounded, access-scoped view over the PGSL indices.
 *
 * Constructed with the principal, not handed one per call: a service that takes the scope as an
 * argument invites the caller to choose it, which is the defect this closes.
 */
export class PgslQuery {
  constructor(
    private readonly fdb: FdbLike,
    private readonly principal: QueryPrincipal,
    private readonly pdp: Pdp,
  ) {}

  /**
   * Which fragments contain this atom or fragment — one page, via the CB index.
   *
   * This is the question `pgsl_to_turtle` was standing in for. It is a prefix range read: the cost
   * is the page, not the lattice.
   */
  async fragmentsContaining(itemUri: string, opts?: QueryOptions): Promise<Page<string>> {
    const { begin, end } = cbRange(nodeAddrFromUrn(itemUri));
    return this.pageOf(beginAt(begin, opts?.cursor), end, opts, (key) =>
      urnFromNodeAddr({ kind: 'fragment', hash: cbFragHash(key) }));
  }

  /** A fragment's ordered item URIs — one page, via the CI index (key order = position). */
  async fragmentItems(fragUri: string, opts?: QueryOptions): Promise<Page<string>> {
    const { begin, end } = ciRange(nodeAddrFromUrn(fragUri).hash);
    return this.pageOf(beginAt(begin, opts?.cursor), end, opts, (_key, value) => dec.decode(value));
  }

  /** Every node URI at one lattice level — one page, via the LV index. */
  async levelSlice(level: number, opts?: QueryOptions): Promise<Page<string>> {
    const { begin, end } = lvRange(level);
    return this.pageOf(beginAt(begin, opts?.cursor), end, opts, (key) => {
      const b = lvAddrBytes(key);
      return urnFromNodeAddr({ kind: b[0] === 0x01 ? 'atom' : 'fragment', hash: b.slice(1) });
    });
  }

  /**
   * Read one page of an index range, decode each row to a URI, and drop what this principal may not
   * see.
   *
   * ★ `nextCursor` COMES FROM THE LAST KEY READ, not the last item returned. If the PDP removed the
   * tail of a page, resuming from the last SURVIVING item would re-read — or worse, skip — the rows
   * in between. The walk is over the keyspace; the filter is over what the walk found.
   */
  private async pageOf(
    begin: Uint8Array,
    end: Uint8Array,
    opts: QueryOptions | undefined,
    toUri: (key: Uint8Array, value: Uint8Array) => string,
  ): Promise<Page<string>> {
    const limit = pageSizeOf(opts);
    const rows = await this.fdb.transact(async (txn) => txn.getRange(begin, end, { limit }));
    if (rows.length === 0) return { items: [], nextCursor: null };

    const uris = rows.map((r) => toUri(r.key, r.value));
    const visible = await this.filterVisible(uris);

    // A short page means the range is exhausted; a full page means there may be more. Judged on the
    // rows READ, because the filter can empty a page that is not the last.
    const lastKey = rows[rows.length - 1]!.key;
    const nextCursor = rows.length < limit ? null : b64u.enc(strinc(lastKey));
    return { items: visible, nextCursor };
  }

  /**
   * Drop the URIs this principal may not read.
   *
   * Attributes are fetched PER URI ON THIS PAGE. The alternative — `getHolonAtomAttributes(scope)`,
   * which loads every attribute in scope in one unbounded range read — would put the corpus back
   * into the request path underneath a bounded page, which is precisely the shape this module
   * exists to remove.
   */
  private async filterVisible(uris: readonly string[]): Promise<string[]> {
    if (uris.length === 0) return [];
    const attrs = await this.fdb.transact(async (txn) => {
      const out = new Map<string, AtomAccessAttributes | undefined>();
      for (const uri of uris) {
        const v = await txn.get(aaKey(this.principal.scope, nodeAddrFromUrn(uri)));
        out.set(uri, v === undefined ? undefined : decodeJson<AtomAccessAttributes>(v));
      }
      return out;
    });
    return uris.filter((uri) => this.pdp.decide(attrs.get(uri)) === 'Allowed');
  }
}
