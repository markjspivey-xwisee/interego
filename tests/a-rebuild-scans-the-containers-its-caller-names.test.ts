/**
 * THE MANIFEST SCAN KNOWS NO VERTICAL'S CONTAINERS; ITS CALLERS NAME THEIR OWN.
 *
 * `rebuildManifestFromPod` — and `publish`, when a pod's manifest has gone missing — rebuilds
 * the index by walking the containers the pod root lists. Until #366 it also probed one
 * vertical's credential container on every pod, for every caller, so the substrate package
 * carried that vertical's storage layout. Now no container but the default is probed unless the
 * root lists it or the caller names it.
 *
 * ★ AND A ROOT THAT CANNOT BE LISTED REFUSES THE REBUILD (Codex on #556). The rebuild OVERWRITES
 * the manifest; with the root unreadable it used to write an index of only the containers it
 * happened to know, silently dropping every entry in the rest. `publish`'s recovery of a
 * manifest that is already gone stays best-effort, and reaches the container it just wrote to.
 */

import { describe, it, expect, vi } from 'vitest';
import { publish, rebuildManifestFromPod } from '@interego/solid';
import { ContextDescriptor } from '@interego/core';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example/u/';
const MANIFEST = `${POD}.well-known/context-graphs`;
const LDP_CONTAINS = '<http://www.w3.org/ns/ldp#contains>';

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function respond(status: number, body: string): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? '"e"' : 'text/turtle') },
    text: async () => body,
    json: async () => ({}),
  };
}

/** A pod whose containers declare their members through `ldp:contains`, as a real one does. */
function makePod(docs: Record<string, string>, opts: { rootStatus?: number } = {}) {
  const store = new Map(Object.entries(docs));
  const gets: string[] = [];
  const puts: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') gets.push(url);
    if (method === 'GET' && url === POD && opts.rootStatus) return respond(opts.rootStatus, '');
    if (method === 'PUT') { puts.push(url); store.set(url, init?.body ?? ''); return respond(205, ''); }
    if (method === 'DELETE') return respond(store.delete(url) ? 205 : 404, '');
    const body = store.get(url);
    return body === undefined ? respond(404, '') : respond(200, body);
  });
  return { store, gets, puts, fetch: fetchFn as never };
}

const listing = (container: string, members: string[]): string =>
  members.length === 0 ? '' : `<${container}> ${LDP_CONTAINS} ${members.map(m => `<${m}>`).join(', ')} .`;
const descriptor = (graph: string): string =>
  `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n<#d> iep:describes <${graph}> .`;

/**
 * A pod with one descriptor in the default container and one in a caller's own container, which
 * the root lists or not, and which may sit one level further down (`nested`).
 */
function podWithTwoContainers(opts: { rootStatus?: number; rootListsOwn?: boolean; nested?: boolean } = {}) {
  const own = `${POD}my-records/`;
  const leaf = opts.nested ? `${own}2026/` : own;
  const members = [`${POD}context-graphs/`, ...(opts.rootListsOwn ? [own] : [])];
  return makePod({
    [POD]: listing(POD, members),
    [`${POD}context-graphs/`]: listing(`${POD}context-graphs/`, [`${POD}context-graphs/a.ttl`]),
    [`${POD}context-graphs/a.ttl`]: descriptor('urn:graph:a'),
    ...(opts.nested ? { [own]: listing(own, [leaf]) } : {}),
    [leaf]: listing(leaf, [`${leaf}b.ttl`]),
    [`${leaf}b.ttl`]: descriptor('urn:graph:b'),
  }, opts);
}

describe('the manifest scan probes no container its caller did not name', () => {
  it('reads only the default container and what the root lists — nothing else is probed', async () => {
    const pod = podWithTwoContainers();
    const out = await rebuildManifestFromPod(POD, { fetch: pod.fetch });
    const containers = pod.gets.filter(u => u.endsWith('/') && u !== POD);
    expect(containers).toEqual([`${POD}context-graphs/`]);
    expect(out.scanned).toBe(1);
  });

  it('a container the root lists is found without anyone naming it', async () => {
    const pod = podWithTwoContainers({ rootListsOwn: true });
    const out = await rebuildManifestFromPod(POD, { fetch: pod.fetch });
    expect(out.written).toBe(2);
  });

  it('a caller-named container reaches what the root does not list, such as one nested below a child', async () => {
    const unnamed = podWithTwoContainers({ rootListsOwn: true, nested: true });
    expect((await rebuildManifestFromPod(POD, { fetch: unnamed.fetch })).written).toBe(1);

    for (const seed of ['my-records/2026/', `${POD}my-records/2026/`, `${POD}my-records/2026`]) {
      const named = podWithTwoContainers({ rootListsOwn: true, nested: true });
      const out = await rebuildManifestFromPod(POD, { fetch: named.fetch, containers: [seed] });
      expect(out.written, seed).toBe(2);
      expect(named.store.get(MANIFEST), seed).toContain('urn:graph:b');
    }
  });

  it('ignores a named container outside the pod, the pod root, or a system container', async () => {
    const pod = podWithTwoContainers();
    await rebuildManifestFromPod(POD, {
      fetch: pod.fetch,
      containers: ['../other/', 'https://elsewhere.example/x/', '/u2/', '', './', 'inbox/', 'settings/', 'my-records/?x=1'],
    });
    const probed = pod.gets.filter(u => u.endsWith('/') && u !== POD);
    expect(probed).toEqual([`${POD}context-graphs/`]);
  });
});

describe('a rebuild that cannot list the pod root refuses rather than overwrite the index', () => {
  it.each([500, 403, 401])('refuses when the root answers %i, named containers or not, and writes nothing', async (status) => {
    for (const containers of [undefined, ['my-records/']]) {
      const pod = podWithTwoContainers({ rootStatus: status });
      pod.store.set(MANIFEST, '# the index as it stood');
      await expect(rebuildManifestFromPod(POD, { fetch: pod.fetch, ...(containers ? { containers } : {}) }))
        .rejects.toThrow(/could not be listed/);
      expect(pod.puts, String(containers)).toEqual([]);
      expect(pod.store.get(MANIFEST)).toBe('# the index as it stood');
    }
  });

  it('refuses when reaching the root fails outright', async () => {
    const pod = podWithTwoContainers();
    const failing = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === POD && (init?.method ?? 'GET') === 'GET') throw new Error('connection reset');
      return (pod.fetch as unknown as (u: string, i?: unknown) => Promise<MockResponse>)(url, init);
    });
    await expect(rebuildManifestFromPod(POD, { fetch: failing as never })).rejects.toThrow(/connection reset/);
    expect(pod.puts).toEqual([]);
  });

  it('publish, recovering a manifest that is already gone, still reaches the container it just wrote to', async () => {
    // Best-effort by design: the index is already missing, and without the seed the recovery
    // would see only the default container and drop the caller's own entries.
    const pod = podWithTwoContainers({ rootStatus: 500 });
    const d = ContextDescriptor.create('urn:iep:c' as IRI)
      .describes('urn:graph:c' as IRI)
      .temporal({ validFrom: '2026-09-28T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch, containerPath: 'my-records/' });
    expect(pod.gets).toContain(`${POD}my-records/`);
    const manifest = pod.store.get(MANIFEST) ?? '';
    expect(manifest).toContain('urn:graph:b');
    expect(manifest).toContain('urn:graph:a');
  });
});
