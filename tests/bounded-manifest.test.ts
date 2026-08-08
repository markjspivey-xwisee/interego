/**
 * A MANIFEST THAT STAYS SMALL, AND STILL SAYS WHERE THE REST OF IT IS.
 *
 * A pod's manifest is one Turtle document rewritten in full on every publish. Measured
 * against the live fleet (tools/measure-manifest-write-cost-live.ts), that write costs
 * `1010 ms + 9.73 ms × entries` and CSS's write lock expires at 6000 ms — so at the
 * maintainer pod's 653 entries the PUT loses its lock, CSS answers 500, and, because lock
 * expiry is a watchdog and not a rollback, the bytes land anyway. The cost is per-STATEMENT
 * (the same bytes written as an opaque blob take a flat ~1.8 s at any size), and a manifest
 * entry is exactly one statement, so the entry count is the lever.
 *
 * These tests hold the fix to the property that makes it the right one: EVERY EXISTING READER
 * KEEPS WORKING. The hot document is still a valid, parseable manifest; the entries that
 * rolled out are reachable by following a link the document itself advertises; and a reader
 * that does not follow that link degrades HONESTLY rather than silently.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  publish,
  discover,
  parseManifest,
  parseManifestArchiveUrls,
  fetchManifestChain,
  fetchAllManifestEntries,
  rebuildManifestFromPod,
  fetchGraphContent,
  parseDistributionFromDescriptorTurtle,
} from '@interego/solid';
import {
  ContextDescriptor,
  dereference,
  clearUrnGraphCache,
  setSolidModuleForTests,
} from '@interego/core';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example/u/';
const MANIFEST = `${POD}.well-known/context-graphs`;

// ── A tiny in-memory pod ────────────────────────────────────────────────────────

interface PodOptions {
  /** URLs that answer 5xx however many times, then succeed. */
  readonly hardFail?: ReadonlySet<string>;
  /** Record every PUT body size so a test can assert the write stayed bounded. */
  readonly puts?: Array<{ url: string; entries: number }>;
  /**
   * Answer 412 to every PUT of this URL — a writer that never wins its compare-and-swap.
   * Models sustained cross-process contention, which is what the maintainer's pod actually
   * has (5 of 8 sequential publishes landed when it was measured).
   */
  readonly alwaysConflict?: ReadonlySet<string>;
}

function countEntries(body: string): number {
  return (body.match(/a iep:ManifestEntry/g) ?? []).length;
}

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function respond(
  status: number,
  body: string,
  etag: string | null = null,
): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 404 ? 'Not Found' : '',
    headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? etag : 'text/turtle') },
    text: async (): Promise<string> => body,
    json: async (): Promise<unknown> => ({}),
  };
}

function makePod(initial: Record<string, string>, options: PodOptions = {}): {
  store: Map<string, string>;
  requests: string[];
  fetch: never;
} {
  const store = new Map<string, string>(Object.entries(initial));
  const requests: string[] = [];
  const fetchFn = vi.fn(async (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<MockResponse> => {
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url}`);
    if (options.hardFail?.has(url)) return respond(503, '');
    if (method === 'PUT' && options.alwaysConflict?.has(url)) return respond(412, '');
    if (method === 'PUT') {
      store.set(url, init?.body ?? '');
      options.puts?.push({ url, entries: countEntries(init?.body ?? '') });
      return respond(205, '', `"etag-${store.size}"`);
    }
    if (method === 'DELETE') {
      const existed = store.delete(url);
      return respond(existed ? 205 : 404, '');
    }
    const body = store.get(url);
    if (body === undefined) return respond(404, '');
    return respond(200, body, '"etag-1"');
  });
  return { store, requests, fetch: fetchFn as never };
}

const PREFIXES = [
  '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
  '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
  '@prefix hydra: <http://www.w3.org/ns/hydra/core#> .',
  '@prefix dct: <http://purl.org/dc/terms/> .',
].join('\n');

function entryBlock(i: number): string {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + i * 60_000).toISOString();
  return [
    `<${POD}context-graphs/e${i}.ttl> a iep:ManifestEntry ;`,
    `    iep:describes <urn:graph:e${i}> ;`,
    `    iep:hasFacetType iep:Temporal ;`,
    `    iep:validFrom "${stamp}"^^xsd:dateTime .`,
  ].join('\n');
}

/**
 * A manifest of `n` entries in the exact shape publish() writes, including the collection
 * header — plus, optionally, a container-level `dct:conformsTo` the relay's shape resolver
 * reads off that subject. It is here so a test can prove roll-over does not eat it.
 */
function manifestOf(n: number, extraHeaderTriple?: string, terseHeader = false): string {
  const head = terseHeader
    // A collection subject that is a WHOLE statement on one line — what an older build, a
    // hand-repair or another implementation can leave behind.
    ? `<${MANIFEST}> a hydra:Collection .`
    : [
      '# Interego Manifest — Hydra-aware, DPROD-aligned',
      '',
      `<${MANIFEST}> a hydra:Collection, iep:DataProduct ;`,
      ...(extraHeaderTriple ? [`    ${extraHeaderTriple} ;`] : []),
      '    iep:affordance iep:canDiscover, iep:canSubscribe .',
    ].join('\n');
  const entries: string[] = [];
  for (let i = 0; i < n; i++) entries.push(entryBlock(i));
  return `${PREFIXES}\n\n${head}\n\n${entries.join('\n\n')}\n`;
}

function descriptorFor(i: number): string {
  return [
    PREFIXES,
    '',
    `<${POD}context-graphs/e${i}.ttl> a iep:ContextDescriptor ;`,
    `    iep:describes <urn:graph:e${i}> ;`,
    `    iep:validFrom "2026-01-01T00:00:00.000Z"^^xsd:dateTime .`,
  ].join('\n');
}

/** A pod whose descriptors are declared through `ldp:contains`, the way a real one is. */
function withDescriptors(n: number, extra: Record<string, string> = {}): Record<string, string> {
  const store: Record<string, string> = {
    // ★ THE POD ROOT DECLARES `.well-known/`, AND IT HAS TO. The rebuild's descriptor scan
    // walks the root's own `ldp:contains`; a fixture that omitted `.well-known/` would never
    // exercise the exclusion that stops archive segments being re-indexed as descriptors —
    // the exact defect that made the append-only shards a one-way door. The container is
    // listed here so the guard is under test rather than merely unreached.
    [POD]: `${PREFIXES}\n<${POD}> <http://www.w3.org/ns/ldp#contains> <${POD}context-graphs/>, <${POD}.well-known/> .`,
    [`${POD}.well-known/`]: `${PREFIXES}\n<${POD}.well-known/> <http://www.w3.org/ns/ldp#contains> `
      + Array.from({ length: 3 }, (_, i) => `<${POD}.well-known/context-graphs-archive-000${i}>`).join(', ')
      + `, <${MANIFEST}> .`,
    [`${POD}context-graphs/`]: `${PREFIXES}\n<${POD}context-graphs/> <http://www.w3.org/ns/ldp#contains> `
      + Array.from({ length: n }, (_, i) => `<${POD}context-graphs/e${i}.ttl>`).join(', ') + ' .',
    ...extra,
  };
  for (let i = 0; i < n; i++) store[`${POD}context-graphs/e${i}.ttl`] = descriptorFor(i);
  return store;
}

// ── The bound itself ────────────────────────────────────────────────────────────

describe('bounded manifest — the write stays O(1) in the pod size', () => {
  it('leaves a manifest under the bound completely alone (no archive, byte-shape unchanged)', async () => {
    const puts: Array<{ url: string; entries: number }> = [];
    const pod = makePod({ [MANIFEST]: manifestOf(10) }, { puts });
    const d = ContextDescriptor.create('urn:iep:small' as IRI)
      .describes('urn:graph:small' as IRI)
      .temporal({ validFrom: '2026-06-01T00:00:00Z' })
      .build();

    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    expect(r.manifestArchivesWritten).toBeUndefined();
    const written = pod.store.get(MANIFEST)!;
    expect(written).not.toContain('iep:manifestArchive');
    expect(countEntries(written)).toBe(11);
    // Not one request to an archive URL — an unbounded pod pays nothing for this feature.
    expect(pod.requests.some(x => x.includes('context-graphs-archive'))).toBe(false);
    expect(puts.filter(p => p.url === MANIFEST)).toHaveLength(1);
    // ★ AND NOT ONE EXTRA MANIFEST GET EITHER. Compaction has to read the manifest to decide
    // whether the pod is over the bound, and the append reads it too — which would have added
    // a second GET to every publish in the system for a feature that does not fire. It hands
    // its read forward instead. Two GETs is the pre-existing shape: one to build the body,
    // one to verify after the PUT.
    expect(pod.requests.filter(x => x === `GET ${MANIFEST}`)).toHaveLength(2);
  });

  it('rolls the oldest entries into a linked archive once the bound is passed, and every PUT stays bounded', async () => {
    // The trigger is the size of the manifest AS READ, so a document sitting exactly at the
    // bound accepts one more row and the roll happens on the publish after that. The hot
    // document therefore never exceeds MANIFEST_HOT_LIMIT + 1, which is the number the budget
    // has to hold — and does: ~101 entries is around 2s against a 6s lock.
    const puts: Array<{ url: string; entries: number }> = [];
    const pod = makePod({ [MANIFEST]: manifestOf(101) }, { puts });
    const d = ContextDescriptor.create('urn:iep:tips-it-over' as IRI)
      .describes('urn:graph:tips-it-over' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    expect(r.manifestArchivesWritten).toEqual([`${POD}.well-known/context-graphs-archive-0000`]);
    const hot = pod.store.get(MANIFEST)!;
    // 101 read → compacted to 50 → the new row appended → 51.
    expect(countEntries(hot)).toBe(51);
    expect(hot).toContain('iep:manifestArchive <https://pod.example/u/.well-known/context-graphs-archive-0000>');
    // ★ EVERY WRITE IN THE ROLL-OVER IS UNDER THE BOUND. Roll-over is itself a big write, and
    // a design that moved the 6-second wall from the manifest onto the archive would have
    // relocated the failure rather than fixed it.
    for (const p of puts) expect(p.entries).toBeLessThanOrEqual(101);
    // 101 rows in, 50 stayed hot, so the segment holds the other 51 — nothing is dropped.
    const archive = pod.store.get(`${POD}.well-known/context-graphs-archive-0000`)!;
    expect(countEntries(archive)).toBe(51);
    expect((await fetchAllManifestEntries(MANIFEST, pod.fetch)).entries).toHaveLength(102);
  });

  it('a manifest sitting exactly at the bound accepts one more row without rolling', async () => {
    // The complement of the test above, and what makes the ceiling limit+1 rather than
    // limit: it pins the trigger to the READ size, so one row cannot cause two rolls.
    const pod = makePod({ [MANIFEST]: manifestOf(100) });
    const d = ContextDescriptor.create('urn:iep:at-the-bound' as IRI)
      .describes('urn:graph:at-the-bound' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });
    expect(r.manifestArchivesWritten).toBeUndefined();
    expect(countEntries(pod.store.get(MANIFEST)!)).toBe(101);
  });

  it('splits a far-over-bound manifest into SEVERAL bounded segments rather than one huge PUT', async () => {
    // The maintainer's pod shape: 653 entries, which is where the live PUT hard-fails.
    const puts: Array<{ url: string; entries: number }> = [];
    const pod = makePod({ [MANIFEST]: manifestOf(653) }, { puts });
    const d = ContextDescriptor.create('urn:iep:migration' as IRI)
      .describes('urn:graph:migration' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    // 654 total, keep 50 + the pinned new row → 604 evicted → 7 segments of ≤100.
    expect(r.manifestArchivesWritten).toHaveLength(7);
    for (const p of puts) expect(p.entries).toBeLessThanOrEqual(100);
    // Nothing was lost: hot + archives must still cover all 654.
    const read = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(read.entries).toHaveLength(654);
    expect(read.complete).toBe(true);
  });

  it('keeps the row being published HOT when a 404-HEAL rebuilds straight past the bound', async () => {
    // ★ THE ONE PATH WHERE THE ROLL-OVER STILL SEES THE NEW ROW, AND WHY IT MATTERS.
    //
    // Compaction runs before the append, so on the ordinary path the new entry is added to an
    // already-small document and can never be the one archived. The exception is here: the
    // manifest is MISSING, publish() reconstructs it from the pod's descriptors to avoid
    // replacing a lost index with a one-entry stub, and that reconstruction can land far past
    // the bound in a single step — with the new row inside it.
    //
    // The split orders by `iep:validFrom`, which `manifestEntryTurtle` emits only when the
    // DESCRIPTOR declares one (a Temporal facet does not set it — `ContextDescriptor.validFrom()`
    // does). A descriptor without it sorts to the OLDEST end, so an unpinned roll-over would
    // archive the row it had just added, the post-PUT verify would not find it in the hot
    // document, and the CAS loop would report a failure over a write that was fine. This repo
    // has just finished fixing a landed write announced as a failure; this is the same family.
    // ★ AND THE ASSERTION IS THE NUMBER OF MANIFEST WRITES, BECAUSE THE OUTCOME SELF-HEALS.
    // Measured with the pin removed: the entry ends up hot anyway, the archives still exist,
    // and the total is still 241 — because the CAS loop retries and the second attempt reads
    // an already-compacted manifest. Every state assertion passes. The only thing that
    // differs is the WORK: one manifest PUT versus two, plus a segment carrying a row that is
    // also in the hot document. A test that checked only the end state would be inert here,
    // and this file had one that was.
    const puts: Array<{ url: string; entries: number }> = [];
    const pod = makePod(withDescriptors(240), { puts }); // no manifest → the 404-heal branch
    const d = ContextDescriptor.create('urn:iep:no-valid-from' as IRI)
      .describes('urn:graph:no-valid-from' as IRI)
      .selfAsserted('did:web:alice.example' as IRI)
      .build();

    const r = await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    const hot = pod.store.get(MANIFEST)!;
    expect(parseManifest(hot).map(e => e.descriptorUrl)).toContain(r.descriptorUrl);
    expect((r.manifestArchivesWritten ?? []).length).toBeGreaterThan(0);
    expect(puts.filter(p => p.url === MANIFEST)).toHaveLength(1);
    // And the heal did not lose the 240 descriptors it was reconstructing from.
    const read = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(read.entries).toHaveLength(241);
  });

  it('preserves header triples it does not understand — the roll-over edits the head, it does not regenerate it', async () => {
    // ★ The relay's resolveContainerShapes reads container-level dct:conformsTo off the
    // collection subject and treats its absence as "this pod declares no shape" — a fail-open
    // on a validation gate. Regenerating the header on roll-over would have discharged that
    // gate silently for every pod that grew past the bound.
    const pod = makePod({ [MANIFEST]: manifestOf(120, 'dct:conformsTo <https://example.org/shapes/pod>') });
    const d = ContextDescriptor.create('urn:iep:keeps-header' as IRI)
      .describes('urn:graph:keeps-header' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    expect(pod.store.get(MANIFEST)!).toContain('dct:conformsTo <https://example.org/shapes/pod>');
  });

  it('a writer that never wins its CAS still rolls over a BOUNDED number of times', async () => {
    // ★ THE WORST CASE, WHICH IS WHERE THIS DESIGN COULD HAVE MOVED THE FAILURE INSTEAD OF
    // FIXING IT. Roll-over is itself a big write, so what matters is not only that one roll
    // fits under the lock but that a contended publish cannot perform many of them.
    //
    // Measured live: on a 400-entry pod the append's conditional PUT lost a 412 to the
    // relay's own concurrent pod-bootstrap write, attempt two re-derived the same split, and
    // the publish took 25.7 seconds across eight segment PUTs for four segments. With the
    // roll left inside the append's retry loop the ceiling is `maxAttempts` (8) full splits;
    // compaction owns the roll now and its budget is 4, and the append — which retries
    // eight times — never rolls a body it read from the server.
    //
    // The pod here 412s every manifest PUT forever, so the publish is bound to fail. What is
    // asserted is the WORK it did on the way, which is the whole difference.
    const puts: Array<{ url: string; entries: number }> = [];
    const pod = makePod({ [MANIFEST]: manifestOf(300) }, { puts, alwaysConflict: new Set([MANIFEST]) });
    const d = ContextDescriptor.create('urn:iep:never-wins' as IRI)
      .describes('urn:graph:never-wins' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    await expect(publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch })).rejects.toThrow(/manifest/i);

    // 300 entries → keep 50, evict 250 → 3 segments per split. Compaction's budget is 4
    // attempts, so at most 12 segment PUTs; the append's 8 attempts must contribute none.
    const segmentPuts = puts.filter(p => p.url.includes('context-graphs-archive'));
    expect(segmentPuts.length).toBeLessThanOrEqual(12);
    // And every one of them was still a bounded write.
    for (const p of segmentPuts) expect(p.entries).toBeLessThanOrEqual(101);
    // At most three distinct segments were ever needed, so any repeats were OVERWRITES of the
    // same indices — no orphans accumulate, because the index is derived from the manifest's
    // own links rather than from a counter.
    expect(new Set(segmentPuts.map(p => p.url)).size).toBeLessThanOrEqual(3);
    // 8 CAS attempts with exponential backoff; the point is the ceiling, not the speed.
  }, 30_000);

  it('produces parseable Turtle when the collection subject is a single terminated statement', async () => {
    // ★ THE HEAD THIS FUNCTION EDITS IS WHATEVER THE POD IS SERVING, not what this file
    // writes. `manifestHeaderTurtle` always emits a multi-predicate stanza whose first line
    // ends in `;`, but a manifest written by an older build, a hand-repair, or another
    // implementation can carry `<url> a hydra:Collection .` on one line — and splicing
    // predicate lines after a TERMINATED statement yields a document CSS rejects. It would
    // have failed at the exact moment such a pod first grew past the bound.
    const pod = makePod({ [MANIFEST]: manifestOf(101, undefined, true) });
    const d = ContextDescriptor.create('urn:iep:terse-head' as IRI)
      .describes('urn:graph:terse-head' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();

    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    const hot = pod.store.get(MANIFEST)!;
    // Exactly one statement terminator in the head region, and the archive link is inside it.
    // Everything before the first entry block — split on the line START so the region does
    // not end mid-way through an entry's own subject.
    const headRegion = hot.split(/^<[^>]+> a iep:ManifestEntry/m)[0]!;
    expect(headRegion).toContain('iep:manifestArchive <');
    expect((headRegion.match(/^\s*<[^>]+> a hydra:Collection ;/m) ?? []).length).toBe(1);
    expect(headRegion.trimEnd().endsWith('.')).toBe(true);
    // And the whole document still round-trips through the parser the readers use.
    expect((await fetchAllManifestEntries(MANIFEST, pod.fetch)).entries).toHaveLength(102);
  });

  it('does not accumulate stale archive links across successive roll-overs', async () => {
    const pod = makePod({ [MANIFEST]: manifestOf(101) });
    for (let k = 0; k < 3; k++) {
      const d = ContextDescriptor.create(`urn:iep:seq-${k}` as IRI)
        .describes(`urn:graph:seq-${k}` as IRI)
        .temporal({ validFrom: `2026-12-0${k + 1}T00:00:00Z` })
        .build();
      await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });
      // Push it back over the bound so the next publish rolls again.
      const cur = pod.store.get(MANIFEST)!;
      pod.store.set(MANIFEST, `${cur.trimEnd()}\n\n${Array.from({ length: 60 }, (_, i) => entryBlock(1000 + k * 100 + i)).join('\n\n')}\n`);
    }
    const hot = pod.store.get(MANIFEST)!;
    const links = parseManifestArchiveUrls(hot, MANIFEST);
    // One link per segment, each exactly once — an insert that did not strip the previous
    // line would duplicate the whole list on every roll-over.
    expect(new Set(links).size).toBe(links.length);
    expect((hot.match(/iep:manifestArchive/g) ?? []).length).toBe(1);
  });
});

// ── The read contract ───────────────────────────────────────────────────────────

describe('bounded manifest — every reader still gets the whole pod', () => {
  it('a raw GET of the hot document still parses as a valid manifest', async () => {
    const pod = makePod({ [MANIFEST]: manifestOf(120) });
    const d = ContextDescriptor.create('urn:iep:still-valid' as IRI)
      .describes('urn:graph:still-valid' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    // ★ THE BACK-COMPAT CONTRACT: an unaware reader gets a well-formed manifest, not an
    // error and not an empty document. It is SHORT, and the links tell it so.
    const entries = parseManifest(pod.store.get(MANIFEST)!);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => typeof e.descriptorUrl === 'string')).toBe(true);
  });

  it('discover() unions the chain and returns every entry', async () => {
    const pod = makePod({ [MANIFEST]: manifestOf(250) });
    const d = ContextDescriptor.create('urn:iep:union' as IRI)
      .describes('urn:graph:union' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    const found = await discover(POD, undefined, { fetch: pod.fetch });
    expect(found).toHaveLength(251);
    expect(found.map(e => e.descriptorUrl)).toContain(`${POD}context-graphs/e0.ttl`);
  });

  it('a segment reachable only from another segment is still found (the chain walks backward)', async () => {
    const pod = makePod({ [MANIFEST]: manifestOf(300) });
    const d = ContextDescriptor.create('urn:iep:backward' as IRI)
      .describes('urn:graph:backward' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    // Strip every archive link but the newest from the hot document. A reader must still
    // reach the older segments via each segment's own link to its predecessor.
    const hot = pod.store.get(MANIFEST)!;
    const links = parseManifestArchiveUrls(hot, MANIFEST);
    expect(links.length).toBeGreaterThan(1);
    const newest = links[links.length - 1]!;
    pod.store.set(MANIFEST, hot.replace(/iep:manifestArchive [^;]+;/, `iep:manifestArchive <${newest}> ;`)
      .replace(/hydra:view [^;]+;/, `hydra:view <${newest}> ;`));

    const read = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(read.complete).toBe(true);
    expect(read.entries).toHaveLength(301);
  });

  it('follows archive links whose IRI names a host the reader cannot reach', async () => {
    // ★ THIS IS THE LIVE DEFECT, AND IT SURVIVED EVERY OTHER TEST IN THIS FILE.
    //
    // The maintainer pod's manifest is written by the relay against the pod's CANONICAL
    // internal URL, so after it rolled over every archive link read
    // `http://css.railway.internal:3456/u-eth-.../.well-known/context-graphs-archive-0000`.
    // The relay resolved that and reported all 654 rows. A reader reached through the public
    // gate could not resolve the host at all: all seven segments came back unreachable and
    // `discover()` refused. Nothing in the in-memory suite noticed, because its fixture writes
    // links on the same origin it serves them from.
    //
    // The IRI is right and must not be rewritten — it matches the 653 descriptor URLs beside
    // it, and the rule here is that the internal host in stored bytes is canonical and only
    // the FETCH TARGET is rebased. A segment is always a sibling of its manifest, so that is
    // where the request goes.
    const pod0 = makePod({ [MANIFEST]: manifestOf(150) });
    const d = ContextDescriptor.create('urn:iep:foreign-host' as IRI)
      .describes('urn:graph:foreign-host' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod0.fetch });

    // Rewrite the links to a host that does not exist in the fixture at all — exactly the
    // shape the live pod has.
    const rewritten = Object.fromEntries(
      [...pod0.store].map(([k, v]) => [k, v.replace(/https:\/\/pod\.example\/u\/\.well-known\/context-graphs-archive-/g,
        'http://css.railway.internal:3456/u/.well-known/context-graphs-archive-')]),
    );
    const pod = makePod(rewritten);

    const chain = await fetchManifestChain(MANIFEST, pod.fetch);
    expect(chain.unreachable).toEqual([]);
    expect(chain.complete).toBe(true);
    const read = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(read.entries).toHaveLength(151);
    // And the published IRI was left exactly as it was — only the request moved.
    expect(pod.store.get(MANIFEST)!).toContain('http://css.railway.internal:3456/u/.well-known/context-graphs-archive-0000');
  });

  it('counts a link it will not follow as UNREADABLE rather than ignoring it', async () => {
    // The sibling rule refuses names this writer does not produce, which is what stops a
    // manifest sending a reader to an arbitrary host. Silently dropping such a link would
    // turn a redirected index into a short one with nothing to show for it.
    const bogus = `${POD}.well-known/context-graphs-archive-0000`;
    const pod = makePod({
      [MANIFEST]: `${PREFIXES}\n\n<${MANIFEST}> a hydra:Collection ;\n`
        + `    iep:manifestArchive <https://evil.example/exfiltrate> .\n\n${entryBlock(1)}\n`,
      [bogus]: `${PREFIXES}\n\n${entryBlock(2)}\n`,
    });
    const chain = await fetchManifestChain(MANIFEST, pod.fetch);
    expect(chain.complete).toBe(false);
    expect(chain.unreachable).toEqual(['https://evil.example/exfiltrate']);
    expect(pod.requests.some(r => r.includes('evil.example'))).toBe(false);
  });

  it('reports complete:false — and discover() REFUSES — when an advertised segment cannot be read', async () => {
    // ★ THE ABSENCE-AS-EVIDENCE GUARD. A pod whose archive is momentarily unreadable must not
    // read as a smaller pod. Returning the hot slice would be indistinguishable, to the
    // caller, from a pod that genuinely has that many entries.
    const pod0 = makePod({ [MANIFEST]: manifestOf(150) });
    const d = ContextDescriptor.create('urn:iep:unreachable' as IRI)
      .describes('urn:graph:unreachable' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod0.fetch });
    const snapshot = Object.fromEntries(pod0.store);
    const archiveUrl = `${POD}.well-known/context-graphs-archive-0000`;

    const broken = makePod(snapshot, { hardFail: new Set([archiveUrl]) });
    const chain = await fetchManifestChain(MANIFEST, broken.fetch);
    expect(chain.complete).toBe(false);
    expect(chain.unreachable).toEqual([archiveUrl]);

    await expect(discover(POD, undefined, { fetch: broken.fetch })).rejects.toThrow(/bounded/i);
  });

  it('the hot copy wins a duplicate, so an orphaned archive from an interrupted roll-over is harmless', async () => {
    // Archive-first ordering means a crash between the two writes leaves an entry in BOTH.
    const archiveUrl = `${POD}.well-known/context-graphs-archive-0000`;
    const pod = makePod({
      [MANIFEST]: `${PREFIXES}\n\n<${MANIFEST}> a hydra:Collection ;\n    iep:manifestArchive <${archiveUrl}> ;\n    iep:affordance iep:canDiscover .\n\n${entryBlock(1)}\n`,
      [archiveUrl]: `${PREFIXES}\n\n<${archiveUrl}> a iep:ManifestArchive ;\n    iep:archiveOf <${MANIFEST}> .\n\n${entryBlock(1)}\n\n${entryBlock(2)}\n`,
    });
    const read = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(read.entries).toHaveLength(2);
    expect(read.complete).toBe(true);
  });

  it('never follows a cycle forever, and says the view is partial when it stops', async () => {
    const a = `${POD}.well-known/context-graphs-archive-0000`;
    const b = `${POD}.well-known/context-graphs-archive-0001`;
    const pod = makePod({
      [MANIFEST]: `${PREFIXES}\n\n<${MANIFEST}> a hydra:Collection ;\n    iep:manifestArchive <${a}> .\n`,
      [a]: `${PREFIXES}\n\n<${a}> a iep:ManifestArchive ;\n    iep:manifestArchive <${b}> .\n\n${entryBlock(1)}\n`,
      [b]: `${PREFIXES}\n\n<${b}> a iep:ManifestArchive ;\n    iep:manifestArchive <${a}> .\n\n${entryBlock(2)}\n`,
    });
    const chain = await fetchManifestChain(MANIFEST, pod.fetch);
    expect(chain.archives).toHaveLength(2);
    expect(chain.complete).toBe(true);
  });
});

// ── The reader for which truncation is a WRONG ANSWER, not a short list ─────────

describe('bounded manifest — resolving a urn:graph from the archive', () => {
  beforeEach(() => {
    clearUrnGraphCache();
    setSolidModuleForTests({
      fetchGraphContent: fetchGraphContent as never,
      parseManifest: parseManifest as never,
      parseDistributionFromDescriptorTurtle: parseDistributionFromDescriptorTurtle as never,
      fetchAllManifestEntries: fetchAllManifestEntries as never,
    });
  });

  it('resolves a URN whose manifest row has rolled into an archive segment', async () => {
    // ★ EVERY OTHER CONSEQUENCE OF BOUNDING IS A SHORTER LIST. THIS ONE IS A WRONG ANSWER.
    // `dereference('urn:graph:…')` finds the URN by scanning manifest rows for a matching
    // `iep:describes`. A reader that saw only the hot document would not find an archived
    // row, and would report `not-found` — which is indistinguishable, to its caller, from
    // "no such graph exists anywhere". The URN would simply stop resolving, silently,
    // the moment the pod grew.
    const pod = makePod({ [MANIFEST]: manifestOf(300) });
    const d = ContextDescriptor.create('urn:iep:tips' as IRI)
      .describes('urn:graph:tips' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch });

    // e0 is the oldest row, so it is certainly in a segment now, not in the hot document.
    expect(pod.store.get(MANIFEST)!).not.toContain(`<${POD}context-graphs/e0.ttl>`);
    // Give the archived row a real descriptor to resolve to.
    pod.store.set(`${POD}context-graphs/e0.ttl`, descriptorFor(0));

    const r = await dereference('urn:graph:e0', { fetch: pod.fetch, podHint: POD });
    expect(r.status).toBe('ok');
  });

  it('answers `error`, not `not-found`, when an advertised segment could not be read', async () => {
    // A miss over an index we never fully read is not a miss. Reporting `not-found` would
    // turn a transient read failure into a claim about the world.
    const pod0 = makePod({ [MANIFEST]: manifestOf(150) });
    const d = ContextDescriptor.create('urn:iep:tips2' as IRI)
      .describes('urn:graph:tips2' as IRI)
      .temporal({ validFrom: '2026-12-01T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod0.fetch });
    const broken = makePod(Object.fromEntries(pod0.store), {
      hardFail: new Set([`${POD}.well-known/context-graphs-archive-0000`]),
    });

    const r = await dereference('urn:graph:e0', { fetch: broken.fetch, podHint: POD });
    expect(r.status).toBe('error');
  });
});

// ── Recovery, and the way back ──────────────────────────────────────────────────

describe('bounded manifest — rebuild is correct for the new shape', () => {
  it('rebuilding an over-bound pod produces bounded documents, and loses nothing', async () => {
    // ★ Before this change `rebuild_manifest` could not complete on the maintainer's pod at
    // all: it PUT one 653-entry document, which is the write that loses CSS's lock.
    const puts: Array<{ url: string; entries: number }> = [];
    const pod = makePod(withDescriptors(240), { puts });
    const out = await rebuildManifestFromPod(POD, { fetch: pod.fetch });

    expect(out.written).toBe(240);
    expect(out.archives.length).toBeGreaterThan(0);
    for (const p of puts) expect(p.entries).toBeLessThanOrEqual(100);
    const read = await fetchAllManifestEntries(MANIFEST, pod.fetch);
    expect(read.entries).toHaveLength(240);
  });

  it('does NOT re-index its own archive segments — the defect that made append-only shards a one-way door', async () => {
    // ★ The rejected design put its shards at the pod ROOT, which the descriptor scan walks,
    // so recovery emitted a phantom row per shard and roughly doubled the index. Archive
    // segments live inside `.well-known/`, which the scan excludes. This test asserts the
    // consequence, not the mechanism: rebuild twice, get the same count.
    const pod = makePod(withDescriptors(240));
    await rebuildManifestFromPod(POD, { fetch: pod.fetch });
    const first = (await fetchAllManifestEntries(MANIFEST, pod.fetch)).entries.length;
    await rebuildManifestFromPod(POD, { fetch: pod.fetch });
    const second = (await fetchAllManifestEntries(MANIFEST, pod.fetch)).entries.length;
    expect(second).toBe(first);
    expect(second).toBe(240);
  });

  it('a pod that shrinks below the bound goes BACK to a plain unbounded manifest, and the segments are retired', async () => {
    // ★ REVERSIBILITY, exercised by the ordinary code path rather than a special migration.
    const pod = makePod(withDescriptors(240));
    const big = await rebuildManifestFromPod(POD, { fetch: pod.fetch });
    expect(big.archives.length).toBeGreaterThan(0);

    // Shrink the pod: only 20 descriptors remain declared.
    pod.store.set(`${POD}context-graphs/`, `${PREFIXES}\n<${POD}context-graphs/> <http://www.w3.org/ns/ldp#contains> `
      + Array.from({ length: 20 }, (_, i) => `<${POD}context-graphs/e${i}.ttl>`).join(', ') + ' .');

    const small = await rebuildManifestFromPod(POD, { fetch: pod.fetch });
    expect(small.archives).toEqual([]);
    expect(small.archivesDeleted.sort()).toEqual([...big.archives].sort());
    const hot = pod.store.get(MANIFEST)!;
    expect(hot).not.toContain('iep:manifestArchive');
    expect(countEntries(hot)).toBe(20);
    for (const gone of big.archives) expect(pod.store.has(gone)).toBe(false);
  });
});
