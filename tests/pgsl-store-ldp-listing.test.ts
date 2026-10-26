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
 * comparison against that scan, kept as the reference in pgsl-store-listing-fixtures.ts), and the
 * rows read grow with the number of children, not with what the children contain.
 *
 * ★ BOTH PATHS. A backend may offer `firstPerSegment` (Postgres does), and the store then lists a
 * container in one read per page instead of one per child container. Every listing test below
 * runs over the generic skip-scan and over that path, with a plain-JavaScript `firstPerSegment`;
 * tests/pgsl-store-pg-integration.test.ts runs the same stores over the Postgres one.
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryFdb,
  openStore,
  CodecRegistry,
  rdfCodec,
  LdpStore,
  type PgslStore,
} from '../packages/pgsl-store/src/index.js';
import { CHILD_PAGE } from '../packages/pgsl-store/src/store.js';
import { cpListRange } from '../packages/pgsl-store/src/keyspace.js';
import { resourceCollection } from '../packages/pgsl-store/src/resource.js';
import type { FdbLike } from '../packages/pgsl-store/src/fdb-like.js';
import {
  BASE, POD, type Rec, CountingFdb, SegmentFdb, referenceListing, marker, doc, seed, seedBulk,
  randomStore, seamStores, expectFirstPerSegmentContract,
} from './pgsl-store-listing-fixtures.js';

function setup(fdb: FdbLike = new InMemoryFdb()): { store: PgslStore; ldp: LdpStore } {
  const store = openStore(fdb);
  return { store, ldp: new LdpStore(store, new CodecRegistry().register(rdfCodec)) };
}

const PATHS: Array<[string, () => FdbLike]> = [
  ['generic skip-scan', () => new InMemoryFdb()],
  ['firstPerSegment', () => new SegmentFdb(new InMemoryFdb())],
];

describe.each(PATHS)('LdpStore.listChildren matches the full-scan listing it replaced (%s)', (path, make) => {
  for (const seedNo of [1, 2, 3, 4, 5, 6]) {
    it(`randomized store, seed ${seedNo}`, async () => {
      const fdb = new CountingFdb(make());
      const { store, ldp } = setup(fdb);
      const { entries, neighbour, probes } = randomStore(seedNo);
      // A neighbouring pod collection must never leak into this one.
      await seed(store, neighbour, `${POD}2`);
      await seed(store, entries);
      for (const probe of probes) {
        const want = await referenceListing(store, POD, probe);
        fdb.reset();
        expect(await ldp.listChildren(POD, probe), probe).toStrictEqual(want);
        // The path under test is the one that ran: a silent fallback would pass the line above.
        if (path === 'firstPerSegment') expect([fdb.ranges, fdb.segments > 0], probe).toEqual([0, true]);
        else expect(fdb.segments, probe).toBe(0);
        expect(await ldp.hasChildren(POD, probe), probe).toBe(want.length > 0);
      }
    });
  }

  it(`pages of ${CHILD_PAGE} children join without a gap or a repeat, whatever sits at the seam`, async () => {
    for (const { name, entries, children } of seamStores(CHILD_PAGE)) {
      const fdb = new CountingFdb(make());
      const { store, ldp } = setup(fdb);
      await seedBulk(fdb, entries);
      const want = await referenceListing(store, POD, BASE);
      expect(want.length, name).toBe(children);
      fdb.reset();
      expect(await ldp.listChildren(POD, BASE), name).toStrictEqual(want);
      if (path === 'firstPerSegment') expect(fdb.segments, name).toBe(Math.floor(children / CHILD_PAGE) + 1);
    }
  });
});

describe.each(PATHS)('LdpStore.listChildren edge cases (%s)', (_path, make) => {
  const fresh = (): { store: PgslStore; ldp: LdpStore } => setup(make());

  it("lists the '' and '/' prefixes", async () => {
    const { store, ldp } = fresh();
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
    const { store, ldp } = fresh();
    await seed(store, [[`${BASE}c/`, marker(1)], [`${BASE}c/d`, doc(2, 2)], [`${BASE}cd`, doc(3, 3)]]);
    expect(await ldp.listChildren(POD, `${BASE}c`)).toStrictEqual(await ldp.listChildren(POD, `${BASE}c/`));
    expect((await ldp.listChildren(POD, `${BASE}c`)).map((c) => c.path)).toEqual([`${BASE}c/d`]);
  });

  it('an empty container lists nothing and has no children', async () => {
    const { store, ldp } = fresh();
    await seed(store, [[`${BASE}empty/`, marker(1)], [`${BASE}empty.ttl`, doc(1, 1)], [`${BASE}emptyish/x`, doc()]]);
    expect(await ldp.listChildren(POD, `${BASE}empty/`)).toStrictEqual([]);
    expect(await ldp.hasChildren(POD, `${BASE}empty/`)).toBe(false);
    expect(await ldp.hasChildren(POD, `${BASE}absent/`)).toBe(false);
  });

  it('a container whose only content is a deep descendant lists the markerless child container', async () => {
    const { store, ldp } = fresh();
    await seed(store, [[`${BASE}a/b/c/d/e.ttl`, doc(9, 9)]]);
    expect(await ldp.listChildren(POD, `${BASE}a/`)).toStrictEqual([{ path: `${BASE}a/b/`, isContainer: true, updatedAt: undefined }]);
    expect(await ldp.hasChildren(POD, `${BASE}a/`)).toBe(true);
    expect(await ldp.listChildren(POD, BASE)).toStrictEqual([{ path: `${BASE}a/`, isContainer: true, updatedAt: undefined }]);
  });

  it('does not confuse /a, /a.b, /a/ and /ab/', async () => {
    const { store, ldp } = fresh();
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
    const { ldp } = fresh();
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
  async function rootRead(pods: number, perPod: number, make: () => FdbLike = () => new InMemoryFdb()) {
    const fdb = new CountingFdb(make());
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
    return { rows: fdb.rows, ranges: fdb.ranges, segments: fdb.segments, total: entries.length, listed };
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

  it('★ with firstPerSegment the root listing is ONE read of exactly one row per child', async () => {
    const got = await rootRead(30, 60, () => new SegmentFdb(new InMemoryFdb()));
    expect(got).toMatchObject({ listed: 50, rows: 50, ranges: 0, segments: 1 });
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

describe('the plain-JavaScript firstPerSegment the in-memory runs use', () => {
  it('keeps the contract the Postgres one is held to', async () => {
    const fdb = new SegmentFdb(new InMemoryFdb());
    await seedBulk(fdb, randomStore(7).entries);
    const { begin, end } = cpListRange(resourceCollection(POD), BASE);
    await expectFirstPerSegmentContract(fdb, Uint8Array.from([...begin, 0]), end, begin.length);
  });
});
