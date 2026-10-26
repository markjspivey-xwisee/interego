/**
 * Shared fixtures for the container-listing tests: the old full-scan listing kept as the
 * reference, the randomized and page-seam stores, and FdbLike wrappers that count reads, add a
 * plain-JavaScript `firstPerSegment`, or take it away.
 *
 * Used by tests/pgsl-store-ldp-listing.test.ts (in memory) and by
 * tests/pgsl-store-pg-integration.test.ts (over a real PostgreSQL), so both paths of
 * `PgslStore.cpListChildren` are held to the same stores and the same reference.
 */

import { expect } from 'vitest';
import type { ChildMeta, PgslStore } from '../packages/pgsl-store/src/index.js';
import { resourceCollection } from '../packages/pgsl-store/src/resource.js';
import { cpKey } from '../packages/pgsl-store/src/keyspace.js';
import { encodeJson } from '../packages/pgsl-store/src/node.js';
import type { FdbLike, FdbTxn, Key, KeyValue } from '../packages/pgsl-store/src/fdb-like.js';

export const POD = 'css';
export const BASE = 'http://css.internal:3456/';

export interface Rec { topUri: string; opaqueUri: string; contentType: string; updatedAt?: number; size?: number }

/** The listing as it was computed before the skip-scan: the reference the new one must match. */
export async function referenceListing(store: PgslStore, pod: string, containerPath: string): Promise<ChildMeta[]> {
  const prefix = containerPath === '' || containerPath.endsWith('/') ? containerPath : `${containerPath}/`;
  const entries = await store.cpList<Rec>(resourceCollection(pod), prefix);
  const direct = new Map<string, ChildMeta>();
  for (const { id, value } of entries) {
    if (id === prefix) continue;
    const rest = id.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const childPath = prefix + rest;
      direct.set(childPath, { path: childPath, isContainer: false, contentType: value.contentType, size: value.size ?? 0, updatedAt: value.updatedAt });
    } else {
      const childPath = `${prefix}${rest.slice(0, slash)}/`;
      const isMarker = rest === `${rest.slice(0, slash)}/`;
      const prev = direct.get(childPath);
      direct.set(childPath, { path: childPath, isContainer: true, updatedAt: isMarker ? value.updatedAt : prev?.updatedAt });
    }
  }
  return [...direct.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Counts what the store actually reads, so the bound is measured rather than assumed. */
export class CountingFdb implements FdbLike {
  rows = 0;
  ranges = 0;
  segments = 0;
  constructor(private readonly inner: FdbLike) {}
  reset(): void { this.rows = 0; this.ranges = 0; this.segments = 0; }
  transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
    return this.inner.transact((txn) => fn({
      ...txn,
      getRange: async (begin, end, opts) => {
        const out = await txn.getRange(begin, end, opts);
        this.ranges++;
        this.rows += out.length;
        return out;
      },
      firstPerSegment: txn.firstPerSegment && (async (start, end, opts) => {
        const out = await txn.firstPerSegment!(start, end, opts);
        this.segments++;
        this.rows += out.length;
        return out;
      }),
    }));
  }
  close(): Promise<void> { return this.inner.close(); }
}

/** The bytes of a row's group: up to and including the first separator at or after the offset. */
function groupOf(key: Key, segmentOffset: number, separator: number): Key {
  const at = key.indexOf(separator, segmentOffset);
  return at === -1 ? key : key.subarray(0, at + 1);
}
function same(a: Key, b: Key): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * `firstPerSegment` written the obvious way — read the whole range, keep each group's first row —
 * over any backend. A different algorithm from both the store's skip-scan and the Postgres walk,
 * which is what makes it a reference rather than a copy.
 */
export class SegmentFdb implements FdbLike {
  constructor(private readonly inner: FdbLike) {}
  transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
    return this.inner.transact((txn) => fn({
      ...txn,
      firstPerSegment: async (start, end, { segmentOffset, separator, limit }) => {
        const out: KeyValue[] = [];
        let last: Key | undefined;
        for (const row of await txn.getRange(start, end)) {
          const group = groupOf(row.key, segmentOffset, separator);
          if (last && same(group, last)) continue;
          last = group;
          if (out.length === limit) break;
          out.push(row);
        }
        return out;
      },
    }));
  }
  close(): Promise<void> { return this.inner.close(); }
}

/** The same backend with `firstPerSegment` taken away, so the store takes its generic path. */
export class GenericOnlyFdb implements FdbLike {
  constructor(private readonly inner: FdbLike) {}
  transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
    return this.inner.transact((txn) => fn({ ...txn, firstPerSegment: undefined }));
  }
  close(): Promise<void> { return this.inner.close(); }
}

export function rec(contentType: string, updatedAt?: number, size?: number): Rec {
  return { topUri: 'urn:pgsl:atom:x', opaqueUri: 'urn:pgsl:atom:x', contentType, updatedAt, size };
}
export const marker = (t?: number): Rec => rec('internal/container', t, 0);
export const doc = (t?: number, size?: number): Rec => rec('text/turtle', t, size);

export async function seed(store: PgslStore, entries: Array<[string, Rec]>, pod = POD): Promise<void> {
  for (const [id, value] of entries) await store.cpSet(resourceCollection(pod), id, value);
}
/** The same rows, in one transaction, for the larger stores. */
export async function seedBulk(fdb: FdbLike, entries: Array<[string, Rec]>, pod = POD): Promise<void> {
  await fdb.transact(async (t) => { for (const [id, value] of entries) t.set(cpKey(resourceCollection(pod), id), encodeJson(value)); });
}

/** Small deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Names chosen to stress the key order: '.', '-', ' ' and '!' sort BEFORE '/', so "a.b" sits
// between "a" and "a/"; '0' sorts right after it, where strinc("a/") lands; the astral and
// private-use characters order differently in UTF-8 bytes than in UTF-16 code units, which is
// the order the listing is finally sorted in.
const NAMES = ['a', 'ab', 'a.b', 'a-b', 'a b', 'a!', '.', '-', '0', 'a0', 'z', 'é', '日本', '😀', '', 'a%2F', ''];

export interface RandomStore {
  /** This pod's rows. */
  entries: Array<[string, Rec]>;
  /** A neighbouring pod's rows, which must never leak into this one's listings. */
  neighbour: Array<[string, Rec]>;
  /** The container paths to list. */
  probes: string[];
}

/** A randomized pod store: a root that may lack its marker, nested containers, missing markers. */
export function randomStore(seedNo: number): RandomStore {
  const r = rng(seedNo);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const containers = new Set<string>([BASE, '']);
  const entries: Array<[string, Rec]> = [];
  // Root marker sometimes missing; many "pods" under the root, nested containers, documents,
  // some markers missing, some records without size or updatedAt.
  if (r() < 0.5) entries.push([BASE, marker(1000)]);
  for (let i = 0; i < 400; i++) {
    let path = r() < 0.9 ? BASE : '';
    const depth = 1 + Math.floor(r() * 4);
    for (let d = 0; d < depth; d++) {
      const name = r() < 0.6 ? `p${Math.floor(r() * 12)}` : pick(NAMES);
      if (d === depth - 1 && r() < 0.6) {
        path += name;
      } else {
        path += `${name}/`;
        containers.add(path);
      }
    }
    const t = r() < 0.9 ? Math.floor(r() * 1e9) : undefined;
    if (path.endsWith('/')) {
      if (r() < 0.7) entries.push([path, marker(t)]);
    } else {
      entries.push([path, doc(t, r() < 0.9 ? Math.floor(r() * 5000) : undefined)]);
    }
  }
  const probes = new Set<string>(['', '/', BASE, BASE.slice(0, -1), `${BASE}nope/`, `${BASE}p1`, `${BASE}a`]);
  for (const c of containers) { probes.add(c); if (c.endsWith('/')) probes.add(c.slice(0, -1)); }
  return { entries, neighbour: [[`${BASE}leak/`, marker(5)], [`${BASE}leak.txt`, doc(5, 5)]], probes: [...probes] };
}

/**
 * Roots whose listing crosses a `firstPerSegment` page boundary of `page` children with each kind
 * of child on either side of the seam: a document, a container with its marker, a container whose
 * marker is missing (its first row is a deep descendant), and an empty container (marker only).
 * One store lists exactly `page` children, so its last page comes back empty.
 */
export function seamStores(page: number): Array<{ name: string; entries: Array<[string, Rec]>; children: number }> {
  const seams: Array<[string, Array<[string, Rec]>]> = [
    ['document', [[`${BASE}s`, doc(7, 7)]]],
    ['container', [[`${BASE}s/`, marker(7)], [`${BASE}s/in`, doc(8, 8)], [`${BASE}s/deep/x`, doc()]]],
    ['markerless container', [[`${BASE}s/deep/x`, doc(9, 9)], [`${BASE}s/y`, doc()]]],
    ['empty container', [[`${BASE}s/`, marker(7)]]],
  ];
  const tail: Array<[string, Rec]> = [
    [`${BASE}t/`, marker(1)], [`${BASE}t/x`, doc()], [`${BASE}t0`, doc(2, 2)], [`${BASE}u/v/w`, doc()], [`${BASE}v`, doc(3, 3)],
  ];
  const out: Array<{ name: string; entries: Array<[string, Rec]>; children: number }> = [];
  for (const fill of [page - 2, page - 1, page]) {
    for (const [kind, rows] of seams) {
      const entries: Array<[string, Rec]> = [[BASE, marker(1)]];
      for (let i = 0; i < fill; i++) {
        const name = `${BASE}f${String(i).padStart(4, '0')}`;
        // Mixed fillers, so the row before the seam is sometimes a container's subtree.
        if (i % 3 === 0) entries.push([`${name}/`, marker(i)], [`${name}/x`, doc(i, i)]);
        else entries.push([name, doc(i, i)]);
      }
      entries.push(...rows);
      const withTail = !(fill === page - 1 && kind === 'document');
      if (withTail) entries.push(...tail);
      out.push({ name: `${fill} children, then a ${kind}${withTail ? ', then more' : ''}`, entries, children: fill + 1 + (withTail ? 4 : 0) });
    }
  }
  return out;
}

/**
 * The `firstPerSegment` contract, checked against a backend that offers it: every page is at most
 * `limit` rows, and a walk in pages yields each group's first row exactly once, the same rows as
 * the plain reference above over the same data.
 */
export async function expectFirstPerSegmentContract(db: FdbLike, begin: Key, end: Key, offset: number): Promise<void> {
  const reference = await new SegmentFdb(db).transact((t) => t.firstPerSegment!(begin, end, { segmentOffset: offset, separator: 0x2f, limit: 1e6 }));
  expect(reference.length).toBeGreaterThan(3);
  const hex = (k: Key): string => Buffer.from(k).toString('hex');
  for (const limit of [1, 2, 7, reference.length - 1, reference.length, reference.length + 1]) {
    const keys: string[] = [];
    let start = begin;
    for (let pages = 0; ; pages++) {
      if (pages > reference.length + 1) throw new Error('the walk did not terminate');
      const rows = await db.transact((t) => t.firstPerSegment!(start, end, { segmentOffset: offset, separator: 0x2f, limit }));
      expect(rows.length).toBeLessThanOrEqual(limit);
      for (const row of rows) {
        keys.push(hex(row.key));
        // Past this row's group: the next key for a lone row, strinc(group) for a group.
        start = row.key.indexOf(0x2f, offset) === -1
          ? Uint8Array.from([...row.key, 0])
          : Uint8Array.from([...groupOf(row.key, offset, 0x2f).subarray(0, -1), 0x30]);
      }
      if (rows.length < limit) break;
    }
    expect(keys, `limit ${limit}`).toEqual(reference.map((r) => hex(r.key)));
  }
}
