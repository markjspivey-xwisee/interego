/**
 * Container listing reads the container's direct children, not everything beneath it.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────
 *
 * `LdpStore.listChildren` used to be one prefix scan that read and decoded every record under
 * the container and then kept the direct children. For the server root that is every record of
 * every pod, and the root GET grew to 6-15 s, past CSS's lock expiry, and answered 500
 * (2026-10-22). The listing now walks the ordered keyspace and jumps over each child
 * container's subtree.
 *
 * Two things are held here: the output is EXACTLY what the old scan produced (a randomized
 * comparison against that scan, kept below as the reference), and the rows read grow with the
 * number of children, not with what the children contain.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  CodecRegistry,
  rdfCodec,
  LdpStore,
  type ChildMeta,
  type PgslStore,
} from '../packages/pgsl-store/src/index.js';
import { resourceCollection } from '../packages/pgsl-store/src/resource.js';
import { cpKey } from '../packages/pgsl-store/src/keyspace.js';
import { encodeJson } from '../packages/pgsl-store/src/node.js';
import type { FdbLike, FdbTxn } from '../packages/pgsl-store/src/fdb-like.js';

const POD = 'css';
const BASE = 'http://css.internal:3456/';

interface Rec { topUri: string; opaqueUri: string; contentType: string; updatedAt?: number; size?: number }

/** The listing as it was computed before the skip-scan: the reference the new one must match. */
async function referenceListing(store: PgslStore, pod: string, containerPath: string): Promise<ChildMeta[]> {
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
class CountingFdb implements FdbLike {
  rows = 0;
  ranges = 0;
  constructor(private readonly inner: FdbLike) {}
  reset(): void { this.rows = 0; this.ranges = 0; }
  transact<T>(fn: (txn: FdbTxn) => Promise<T>): Promise<T> {
    return this.inner.transact((txn) => fn({
      ...txn,
      getRange: async (begin, end, opts) => {
        const out = await txn.getRange(begin, end, opts);
        this.ranges++;
        this.rows += out.length;
        return out;
      },
    }));
  }
  close(): Promise<void> { return this.inner.close(); }
}

function setup(fdb: FdbLike = new InMemoryFdb()): { store: PgslStore; ldp: LdpStore } {
  const store = openStore(fdb);
  return { store, ldp: new LdpStore(store, new CodecRegistry().register(rdfCodec)) };
}

function rec(contentType: string, updatedAt?: number, size?: number): Rec {
  return { topUri: 'urn:pgsl:atom:x', opaqueUri: 'urn:pgsl:atom:x', contentType, updatedAt, size };
}
const marker = (t?: number): Rec => rec('internal/container', t, 0);
const doc = (t?: number, size?: number): Rec => rec('text/turtle', t, size);

async function seed(store: PgslStore, entries: Array<[string, Rec]>, pod = POD): Promise<void> {
  for (const [id, value] of entries) await store.cpSet(resourceCollection(pod), id, value);
}
/** The same rows, in one transaction, for the larger stores. */
async function seedBulk(fdb: FdbLike, entries: Array<[string, Rec]>, pod = POD): Promise<void> {
  await fdb.transact(async (t) => { for (const [id, value] of entries) t.set(cpKey(resourceCollection(pod), id), encodeJson(value)); });
}

/** Small deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number): () => number {
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
// between "a" and "a/"; the astral and private-use characters order differently in UTF-8 bytes
// than in UTF-16 code units, which is the order the listing is finally sorted in.
const NAMES = ['a', 'ab', 'a.b', 'a-b', 'a b', 'a!', '.', '-', '0', 'z', 'é', '日本', '😀', '', 'a%2F', ''];

describe('LdpStore.listChildren matches the full-scan listing it replaced', () => {
  for (const seedNo of [1, 2, 3, 4, 5, 6]) {
    it(`randomized store, seed ${seedNo}`, async () => {
      const r = rng(seedNo);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const { store, ldp } = setup();
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
      // A neighbouring pod collection must never leak into this one.
      await seed(store, [[`${BASE}leak/`, marker(5)], [`${BASE}leak.txt`, doc(5, 5)]], `${POD}2`);
      await seed(store, entries);

      const probes = new Set<string>(['', '/', BASE, BASE.slice(0, -1), `${BASE}nope/`, `${BASE}p1`, `${BASE}a`]);
      for (const c of containers) { probes.add(c); if (c.endsWith('/')) probes.add(c.slice(0, -1)); }
      for (const probe of probes) {
        const want = await referenceListing(store, POD, probe);
        expect(await ldp.listChildren(POD, probe), probe).toStrictEqual(want);
        expect(await ldp.hasChildren(POD, probe), probe).toBe(want.length > 0);
      }
    });
  }
});

describe('LdpStore.listChildren edge cases', () => {
  it("lists the '' and '/' prefixes", async () => {
    const { store, ldp } = setup();
    await seed(store, [['/', marker(1)], ['/x', doc(2, 3)], ['/y/', marker(4)], ['/y/z', doc()], ['top', doc(5, 6)], ['dir/q', doc()]]);
    expect(await ldp.listChildren(POD, '')).toStrictEqual([
      { path: '/', isContainer: true, updatedAt: 1 },
      { path: 'dir/', isContainer: true, updatedAt: undefined },
      { path: 'top', isContainer: false, contentType: 'text/turtle', size: 6, updatedAt: 5 },
    ]);
    expect(await ldp.listChildren(POD, '/')).toStrictEqual([
      { path: '/x', isContainer: false, contentType: 'text/turtle', size: 3, updatedAt: 2 },
      { path: '/y/', isContainer: true, updatedAt: 4 },
    ]);
  });

  it('treats a container path without its trailing slash as the container', async () => {
    const { store, ldp } = setup();
    await seed(store, [[`${BASE}c/`, marker(1)], [`${BASE}c/d`, doc(2, 2)], [`${BASE}cd`, doc(3, 3)]]);
    expect(await ldp.listChildren(POD, `${BASE}c`)).toStrictEqual(await ldp.listChildren(POD, `${BASE}c/`));
    expect((await ldp.listChildren(POD, `${BASE}c`)).map((c) => c.path)).toEqual([`${BASE}c/d`]);
  });

  it('an empty container lists nothing and has no children', async () => {
    const { store, ldp } = setup();
    await seed(store, [[`${BASE}empty/`, marker(1)], [`${BASE}empty.ttl`, doc(1, 1)], [`${BASE}emptyish/x`, doc()]]);
    expect(await ldp.listChildren(POD, `${BASE}empty/`)).toStrictEqual([]);
    expect(await ldp.hasChildren(POD, `${BASE}empty/`)).toBe(false);
    expect(await ldp.hasChildren(POD, `${BASE}absent/`)).toBe(false);
  });

  it('a container whose only content is a deep descendant lists the markerless child container', async () => {
    const { store, ldp } = setup();
    await seed(store, [[`${BASE}a/b/c/d/e.ttl`, doc(9, 9)]]);
    expect(await ldp.listChildren(POD, `${BASE}a/`)).toStrictEqual([{ path: `${BASE}a/b/`, isContainer: true, updatedAt: undefined }]);
    expect(await ldp.hasChildren(POD, `${BASE}a/`)).toBe(true);
    expect(await ldp.listChildren(POD, BASE)).toStrictEqual([{ path: `${BASE}a/`, isContainer: true, updatedAt: undefined }]);
  });

  it('does not confuse /a, /a.b, /a/ and /ab/', async () => {
    const { store, ldp } = setup();
    await seed(store, [
      [`${BASE}a`, doc(1, 1)], [`${BASE}a.b`, doc(2, 2)], [`${BASE}a-/x`, doc()],
      [`${BASE}a/`, marker(3)], [`${BASE}a/in`, doc(4, 4)], [`${BASE}a/deep/x`, doc()],
      [`${BASE}ab/`, marker(5)], [`${BASE}ab/in`, doc()],
    ]);
    expect(await ldp.listChildren(POD, BASE)).toStrictEqual([
      { path: `${BASE}a`, isContainer: false, contentType: 'text/turtle', size: 1, updatedAt: 1 },
      { path: `${BASE}a-/`, isContainer: true, updatedAt: undefined },
      { path: `${BASE}a.b`, isContainer: false, contentType: 'text/turtle', size: 2, updatedAt: 2 },
      { path: `${BASE}a/`, isContainer: true, updatedAt: 3 },
      { path: `${BASE}ab/`, isContainer: true, updatedAt: 5 },
    ]);
    expect((await ldp.listChildren(POD, `${BASE}a/`)).map((c) => c.path)).toEqual([`${BASE}a/deep/`, `${BASE}a/in`]);
  });

  it('lists resources written through the real write path', async () => {
    const { ldp } = setup();
    const enc = new TextEncoder();
    await ldp.writeResource(POD, `${BASE}pod/`, new Uint8Array(0), 'internal/container');
    await ldp.writeResource(POD, `${BASE}pod/doc.ttl`, enc.encode('<a> <b> <c> .\n'), 'text/turtle');
    await ldp.writeResource(POD, `${BASE}pod/blob.bin`, Uint8Array.of(1, 2, 3), 'application/octet-stream');
    await ldp.writeResource(POD, `${BASE}pod/sub/x.bin`, Uint8Array.of(4), 'application/octet-stream');
    const got = await ldp.listChildren(POD, `${BASE}pod/`);
    expect(got.map((c) => [c.path, c.isContainer, c.size, c.contentType])).toEqual([
      [`${BASE}pod/blob.bin`, false, 3, 'application/octet-stream'],
      [`${BASE}pod/doc.ttl`, false, 14, 'text/turtle'],
      [`${BASE}pod/sub/`, true, undefined, undefined],
    ]);
    expect((await ldp.listChildren(POD, BASE)).map((c) => c.path)).toEqual([`${BASE}pod/`]);
  });
});

describe('LdpStore.listChildren reads O(children) rows, not O(descendants)', () => {
  async function rootRead(pods: number, perPod: number): Promise<{ rows: number; ranges: number; total: number; listed: number }> {
    const fdb = new CountingFdb(new InMemoryFdb());
    const { ldp } = setup(fdb);
    const entries: Array<[string, Rec]> = [[BASE, marker(1)]];
    for (let p = 0; p < pods; p++) {
      const pod = `${BASE}u${String(p).padStart(4, '0')}/`;
      entries.push([pod, marker(p)]);
      for (let i = 0; i < perPod; i++) entries.push([`${pod}${i % 3 ? 'ctx' : 'meta'}/r${i}.ttl`, doc(i, i)]);
    }
    for (let d = 0; d < 20; d++) entries.push([`${BASE}d${d}.ttl`, doc(d, d)]); // a run of root documents
    await seedBulk(fdb, entries);
    fdb.reset();
    const listed = (await ldp.listChildren(POD, BASE)).length;
    return { rows: fdb.rows, ranges: fdb.ranges, total: entries.length, listed };
  }

  it('★ the root listing reads a bounded number of rows per child, independent of the pods\' contents', async () => {
    const small = await rootRead(30, 10);
    const big = await rootRead(30, 60);
    expect(small.listed).toBe(50);
    expect(big.listed).toBe(50);
    // Reading the root cost the same whether each pod held 10 records or 60.
    expect(big.rows).toBe(small.rows);
    expect(big.ranges).toBe(small.ranges);
    // At most one small batch per child container, and the whole thing far below the store size.
    expect(big.rows).toBeLessThanOrEqual(8 * (30 + 1) + 20);
    expect(big.rows * 5).toBeLessThan(big.total);
  });

  it('the existence check reads one row', async () => {
    const fdb = new CountingFdb(new InMemoryFdb());
    const { ldp } = setup(fdb);
    await seedBulk(fdb, Array.from({ length: 50 }, (_, i): [string, Rec] => [`${BASE}p/r${i}`, doc()]));
    fdb.reset();
    expect(await ldp.hasChildren(POD, BASE)).toBe(true);
    expect(fdb.rows).toBe(1);
  });
});
