/**
 * A BOUND ON ROWS IS NOT A BOUND ON SIZE — AND A LIMIT ON THE ANSWER IS NOT A LIMIT ON THE WORK.
 *
 * Two independent defects, found together on a live pod, that between them let a bounded index
 * grow to 32.7 MB and then made a reader hold all of it:
 *
 *  1. ROLL-OVER TRIGGERED ON ENTRY COUNT ONLY. `.well-known/context-graphs` on
 *     `u-eth-03f52e15b9df` held NINETY-THREE entries — comfortably under the hundred-row bound,
 *     so roll-over never fired once — and measured 32,684,808 bytes. 301,806 of its 303,226
 *     lines were `iep:supersedes` refs, because a presence lease republished every 90 seconds
 *     under `auto_supersede_prior` linked each new version to every prior one. The row cap
 *     cannot see that: rows stayed constant while bytes grew quadratically.
 *
 *  2. `discover()`'s `limit` BOUNDED THE ANSWER, NOT THE READ. It fetched the hot document plus
 *     every archive segment the chain advertised — all in parallel, all resident — parsed the
 *     union, and only then sorted and sliced. Asking for the 750 newest rows of a 95-segment
 *     pod read the whole pod. That is what exhausted the Foxxi projector's 3 GB heap on a
 *     five-minute timer.
 *
 * These tests fail against the old code for the RIGHT reason in each case: the first because no
 * archive is written at all, the second because every segment is fetched regardless of window.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  publish,
  discover,
  discoverPage,
  fetchAllManifestEntries,
} from '@interego/solid';
import { ContextDescriptor } from '@interego/core';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example/u/';
const MANIFEST = `${POD}.well-known/context-graphs`;
const HOT_MAX_BYTES = 1024 * 1024;

const PREFIXES = [
  '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .',
  '@prefix dct: <http://purl.org/dc/terms/> .',
].join('\n');

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function respond(status: number, body: string, etag: string | null = null): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : '',
    headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? etag : 'text/turtle') },
    text: async (): Promise<string> => body,
    json: async (): Promise<unknown> => ({}),
  };
}

function makePod(initial: Record<string, string>, unreadable: ReadonlySet<string> = new Set()): {
  store: Map<string, string>;
  gets: string[];
  puts: Array<{ url: string; bytes: number }>;
  fetch: never;
} {
  const store = new Map<string, string>(Object.entries(initial));
  const gets: string[] = [];
  const puts: Array<{ url: string; bytes: number }> = [];
  const fetchFn = vi.fn(async (
    url: string,
    init?: { method?: string; body?: string },
  ): Promise<MockResponse> => {
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      store.set(url, init?.body ?? '');
      puts.push({ url, bytes: Buffer.byteLength(init?.body ?? '', 'utf8') });
      return respond(205, '', '"e"');
    }
    if (method === 'DELETE') return respond(store.delete(url) ? 205 : 404, '');
    gets.push(url);
    // 404 is "absent", which a chain walk treats as a hole it must report — distinct from a
    // segment that simply lies beyond the window.
    if (unreadable.has(url)) return respond(404, '');
    const body = store.get(url);
    if (body === undefined) return respond(404, '');
    return respond(200, body, '"e"');
  });
  return { store, gets, puts, fetch: fetchFn as never };
}

/**
 * An entry block carrying `refs` supersession references — the exact shape that inflated the
 * live pod. One ref per line, which is how the serializer emits them.
 */
function fatEntry(i: number, refs: number): string {
  const stamp = new Date(Date.UTC(2026, 0, 1) + i * 90_000).toISOString();
  const supersedes = Array.from(
    { length: refs },
    (_, k) => `        <${POD}context-graphs/e${i}-v${k}.ttl>`,
  ).join(',\n');
  return [
    `<${POD}context-graphs/e${i}.ttl> a iep:ManifestEntry ;`,
    `    iep:describes <${POD}graph/presence> ;`,
    `    iep:validFrom "${stamp}"^^xsd:dateTime ;`,
    ...(refs > 0 ? [`    iep:supersedes\n${supersedes} ;`] : []),
    `    iep:hasFacetType iep:Temporal .`,
  ].join('\n');
}

function manifestOf(blocks: string[], archiveLinks: string[] = []): string {
  const head = [
    `<${MANIFEST}> a hydra:Collection, iep:DataProduct ;`,
    ...(archiveLinks.length > 0
      ? [`    iep:manifestArchive ${archiveLinks.map(u => `<${u}>`).join(', ')} ;`]
      : []),
    '    iep:affordance iep:canDiscover, iep:canSubscribe .',
  ].join('\n');
  return `${PREFIXES}\n\n${head}\n\n${blocks.join('\n\n')}\n`;
}

function countEntries(body: string): number {
  return (body.match(/a iep:ManifestEntry/g) ?? []).length;
}

const archiveUrl = (i: number): string =>
  `${POD}.well-known/context-graphs-archive-${String(i).padStart(4, '0')}`;

// ── 1. The write side: bytes, not rows ──────────────────────────────────────────

describe('the index bounds bytes, not just rows', () => {
  it('rolls over a FEW enormous rows — the exact shape that reached 32.7 MB unrolled', async () => {
    // Twelve rows. Twelve is nowhere near the hundred-row cap, so the old trigger is silent.
    // At ~3,200 refs each these carry ~350 KB apiece — the live pod's measured row size — for
    // a ~4 MB document that the old code would have left, and kept extending, forever.
    const blocks = Array.from({ length: 12 }, (_, i) => fatEntry(i, 3200));
    const before = manifestOf(blocks);
    expect(countEntries(before)).toBe(12);
    expect(countEntries(before)).toBeLessThan(100);           // under the ROW bound…
    expect(Buffer.byteLength(before, 'utf8')).toBeGreaterThan(2 * HOT_MAX_BYTES); // …and far over the byte one

    const pod = makePod({ [MANIFEST]: before });
    const d = ContextDescriptor.create('urn:iep:presence-renewal' as IRI)
      .describes(`${POD}graph/presence` as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    // It rolled — on bytes alone, with the row count never in question.
    expect(r.manifestArchivesWritten?.length ?? 0).toBeGreaterThan(0);

    const hot = pod.store.get(MANIFEST)!;
    expect(Buffer.byteLength(hot, 'utf8')).toBeLessThanOrEqual(HOT_MAX_BYTES);

    // ★ AND NOTHING WAS DROPPED. The rows that left the hot document are reachable by
    // following the link the document itself advertises. A bound that loses rows is not a
    // bound, it is data loss.
    const all = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(all.complete).toBe(true);
    expect(all.entries).toHaveLength(13); // 12 existing + the one just published
  });

  it('bounds every archive segment it writes by bytes too', async () => {
    // A roll-over that moved one oversized document into another oversized document would
    // relocate the failure, not remove it: a segment is something a reader fetches WHOLE.
    const blocks = Array.from({ length: 30 }, (_, i) => fatEntry(i, 3200));
    const pod = makePod({ [MANIFEST]: manifestOf(blocks) });
    const d = ContextDescriptor.create('urn:iep:seg' as IRI)
      .describes(`${POD}graph/presence` as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    const segments = pod.puts.filter(p => p.url.includes('context-graphs-archive'));
    expect(segments.length).toBeGreaterThan(1); // 30 fat rows cannot fit in one bounded segment
    for (const s of segments) {
      // A little slack for the segment's own prefix + header block, which is not row bytes.
      expect(s.bytes).toBeLessThanOrEqual(HOT_MAX_BYTES + 4096);
    }
  });

  it('still keeps the row it is publishing, even when that row alone busts the budget', async () => {
    // The pinned entry is admitted unconditionally and on purpose: a publish that archived its
    // own new row would fail its post-PUT verify-GET, and the CAS loop would read the miss as a
    // concurrent clobber and report a write that was fine as a failure. An over-budget hot
    // document holding exactly one row is the correct outcome; a refused write is not.
    // Each row is deliberately LARGER than the whole budget on its own, so no existing row can
    // be kept and the only row left hot is the one being published.
    const blocks = Array.from({ length: 6 }, (_, i) => fatEntry(i, 20_000));
    expect(Buffer.byteLength(fatEntry(0, 20_000), 'utf8')).toBeGreaterThan(HOT_MAX_BYTES);
    const pod = makePod({ [MANIFEST]: manifestOf(blocks) });
    const d = ContextDescriptor.create('urn:iep:huge-row' as IRI)
      .describes(`${POD}graph/presence` as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    expect(r.manifestArchivesWritten?.length ?? 0).toBeGreaterThan(0);
    const hot = pod.store.get(MANIFEST)!;
    // The row just written is the one that MUST still be hot — asserted on the descriptor URL
    // the manifest actually keys entries by, not on the graph IRI.
    expect(hot).toContain(`<${r.descriptorUrl}>`);
    expect(countEntries(hot)).toBe(1);
    const all = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(all.complete).toBe(true);
    expect(all.entries).toHaveLength(7);
  });

  it('leaves a small manifest completely alone — the bound costs the common case nothing', async () => {
    const pod = makePod({ [MANIFEST]: manifestOf(Array.from({ length: 5 }, (_, i) => fatEntry(i, 0))) });
    const d = ContextDescriptor.create('urn:iep:tiny' as IRI)
      .describes(`${POD}graph/tiny` as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    expect(r.manifestArchivesWritten).toBeUndefined();
    expect(pod.store.get(MANIFEST)!).not.toContain('iep:manifestArchive');
    expect(pod.gets.some(u => u.includes('context-graphs-archive'))).toBe(false);
  });
});

// ── 2. The read side: a window costs the window ─────────────────────────────────

/** A pod whose index is one hot document plus `n` linked segments of `per` rows each. */
function chainPod(
  n: number,
  per: number,
  unreadable: ReadonlySet<string> = new Set(),
  /** Supersession refs per row — the lever that makes a row fat without changing the count. */
  refs = 0,
): ReturnType<typeof makePod> {
  const links = Array.from({ length: n }, (_, i) => archiveUrl(i));
  const store: Record<string, string> = {
    // Hot holds the NEWEST rows; segments are linked oldest-first, newest last.
    // Ids are disjoint from the segments' `i * 1000 + k`, or dedup silently eats the overlap
    // and the totals stop meaning what the test says they mean.
    [MANIFEST]: manifestOf(Array.from({ length: per }, (_, k) => fatEntry(900_000 + k, refs)), links),
  };
  for (let i = 0; i < n; i++) {
    // `hydra:previous` points at the previous SEGMENT (absent on the oldest), which is what
    // roll-over writes. Pointing it at the manifest would make the chain walk treat the
    // manifest as one of its own archive links and report it unreachable.
    const prev = i > 0 ? `    hydra:previous <${archiveUrl(i - 1)}> ;\n` : '';
    store[archiveUrl(i)] = `${PREFIXES}\n\n<${archiveUrl(i)}> a iep:ManifestArchive ;\n`
      + prev
      + `    hydra:collection <${MANIFEST}> .\n\n`
      + Array.from({ length: per }, (_, k) => fatEntry(i * 1000 + k, refs)).join('\n\n') + '\n';
  }
  return makePod(store, unreadable);
}

describe('a bounded read costs the window, not the pod', () => {
  it('stops walking the chain once the window is filled', async () => {
    const pod = chainPod(40, 10); // 40 segments × 10 rows + 10 hot = 410 rows available

    const page = await discoverPage(POD, { limit: 25, sort: 'newest-first' }, { readWindow: 25, fetch: pod.fetch as never });

    expect(page.entries).toHaveLength(25);
    // 10 hot + 2 segments gets it to 30 ≥ 25, so it reads TWO segments, not forty.
    expect(page.archivesFollowed).toBeLessThanOrEqual(3);
    const segmentGets = pod.gets.filter(u => u.includes('context-graphs-archive'));
    expect(segmentGets.length).toBeLessThanOrEqual(3);
    // ★ THE ASSERTION THAT ACTUALLY DISTINGUISHES THE FIX. The old code fetched all forty and
    // then sliced; the row count it returned was identical, which is exactly why the defect
    // survived a `limit` being added and measured nothing.
    expect(segmentGets.length).toBeLessThan(40);
  });

  it('says so, rather than reporting a window as the whole pod', async () => {
    const pod = chainPod(40, 10);
    const bounded = await discoverPage(POD, { limit: 25, sort: 'newest-first' }, { readWindow: 25, fetch: pod.fetch as never });
    expect(bounded.bounded).toBe(true);

    // And a read that genuinely covered everything reports the opposite, so `bounded` carries
    // information rather than being always-true whenever a window was passed.
    const whole = await discoverPage(POD, undefined, { readWindow: 100_000, fetch: pod.fetch as never });
    expect(whole.bounded).toBe(false);
    expect(whole.entries).toHaveLength(410);
    expect(pod.gets.filter(u => u.includes('context-graphs-archive')).length).toBeGreaterThan(40);
  });

  it('reads the newest end first — the window is the newest rows, not an arbitrary slice', async () => {
    const pod = chainPod(40, 10);
    const page = await discoverPage(POD, { limit: 10, sort: 'newest-first' }, { readWindow: 10, fetch: pod.fetch as never });
    // The hot document alone satisfies a 10-row window, so no segment is touched at all…
    expect(pod.gets.filter(u => u.includes('context-graphs-archive'))).toHaveLength(0);
    // …and what comes back is the hot rows, which are the newest ones.
    for (const e of page.entries) expect(e.descriptorUrl).toMatch(/\/e9000\d\d\.ttl$/);
  });

  it('stops on BYTES when the rows are fat — a row count is not a size', async () => {
    // The pod that caused all of this carried ~355 KB per row, so its 750-row window was 260 MB
    // of Turtle. Rows here are ~24 KB, so a 256 KB budget is filled by roughly ten of them —
    // long before a 400-row window would be.
    const pod = chainPod(40, 5, new Set(), 400);
    const perRow = Buffer.byteLength(fatEntry(1, 400), 'utf8');
    expect(perRow).toBeGreaterThan(20_000);

    const page = await discoverPage(
      POD,
      { limit: 400, sort: 'newest-first' },
      { readWindow: 400, readBudgetBytes: 256 * 1024, fetch: pod.fetch as never },
    );

    expect(page.bounded).toBe(true);
    // The 400-ROW window is nowhere near satisfied — 205 rows exist in total — so if bytes were
    // not a bound the walk would have read all forty segments.
    expect(page.entries.length).toBeLessThan(400);
    const read = pod.gets.filter(u => u.includes('context-graphs-archive'));
    expect(read.length).toBeLessThan(15);
    // And the bytes actually pulled stayed near the budget rather than near the pod.
    const pulled = read.reduce((n, u) => n + Buffer.byteLength(pod.store.get(u) ?? '', 'utf8'), 0);
    expect(pulled).toBeLessThan(2 * 256 * 1024);
  });

  it('STILL refuses when a segment it tried to read was unreachable, window or no window', async () => {
    // The precision that makes `bounded` safe. Treating any incomplete bounded walk as
    // acceptable would let a bounded caller silently absorb the very failure the refusal
    // exists to surface — a hole in the answer is not a row beyond the window.
    const pod = chainPod(3, 10, new Set([archiveUrl(2)]));
    await expect(
      discoverPage(POD, { limit: 400, sort: 'newest-first' }, { readWindow: 400, fetch: pod.fetch as never }),
    ).rejects.toThrow(/refusing to report a partial pod as complete/);
    expect(pod.gets.some(u => u.includes('archive-0002'))).toBe(true);
  });

  it('leaves plain discover() exactly as it was — full read, and it still refuses on a hole', async () => {
    const whole = chainPod(5, 10);
    expect(await discover(POD, undefined, { fetch: whole.fetch as never })).toHaveLength(60);
    expect(whole.gets.filter(u => u.includes('context-graphs-archive'))).toHaveLength(5);

    const holed = chainPod(3, 10, new Set([archiveUrl(1)]));
    await expect(discover(POD, undefined, { fetch: holed.fetch as never }))
      .rejects.toThrow(/refusing to report a partial pod as complete/);
  });
});
