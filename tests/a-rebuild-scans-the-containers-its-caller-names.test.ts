/**
 * THE MANIFEST SCAN KNOWS NO VERTICAL'S CONTAINERS; ITS CALLERS NAME THEIR OWN.
 *
 * `rebuildManifestFromPod` — and `publish`, when a pod's manifest has gone missing — rebuilds
 * the index by walking the containers the pod root lists. Until #366 it also probed one
 * vertical's credential container on every pod, for every caller, so the substrate package
 * carried that vertical's storage layout. A named container only matters when the root
 * listing cannot be read, and the caller that wrote into a container is the one that knows
 * it exists. So: no container but the default is probed unless the root lists it or the
 * caller names it.
 */

import { describe, it, expect, vi } from 'vitest';
import { publish, rebuildManifestFromPod } from '@interego/solid';
import { ContextDescriptor } from '@interego/core';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example/u/';
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
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET') gets.push(url);
    if (method === 'GET' && url === POD && opts.rootStatus) return respond(opts.rootStatus, '');
    if (method === 'PUT') { store.set(url, init?.body ?? ''); return respond(205, ''); }
    if (method === 'DELETE') return respond(store.delete(url) ? 205 : 404, '');
    const body = store.get(url);
    return body === undefined ? respond(404, '') : respond(200, body);
  });
  return { store, gets, fetch: fetchFn as never };
}

const listing = (container: string, members: string[]): string =>
  members.length === 0 ? '' : `<${container}> ${LDP_CONTAINS} ${members.map(m => `<${m}>`).join(', ')} .`;
const descriptor = (graph: string): string =>
  `<#d> <https://markjspivey-xwisee.github.io/interego/ns/iep#describes> <${graph}> .\n@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n<#d> iep:describes <${graph}> .`;

/** A pod with one descriptor in the default container and one in a caller's own container. */
function podWithTwoContainers(opts: { rootStatus?: number; rootListsOwn?: boolean } = {}) {
  const own = `${POD}my-records/`;
  const members = [`${POD}context-graphs/`, ...(opts.rootListsOwn ? [own] : [])];
  return makePod({
    [POD]: listing(POD, members),
    [`${POD}context-graphs/`]: listing(`${POD}context-graphs/`, [`${POD}context-graphs/a.ttl`]),
    [`${POD}context-graphs/a.ttl`]: descriptor('urn:graph:a'),
    [own]: listing(own, [`${own}b.ttl`]),
    [`${own}b.ttl`]: descriptor('urn:graph:b'),
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

  it('a caller-named container is scanned when the root listing cannot be read', async () => {
    const unnamed = podWithTwoContainers({ rootStatus: 500 });
    expect((await rebuildManifestFromPod(POD, { fetch: unnamed.fetch })).written).toBe(1);

    const named = podWithTwoContainers({ rootStatus: 500 });
    const out = await rebuildManifestFromPod(POD, { fetch: named.fetch, containers: ['my-records/'] });
    expect(out.written).toBe(2);
    expect(named.store.get(`${POD}.well-known/context-graphs`)).toContain('urn:graph:b');
  });

  it('accepts a container as an absolute URL under the pod, with or without its trailing slash', async () => {
    for (const seed of [`${POD}my-records/`, `${POD}my-records`]) {
      const pod = podWithTwoContainers({ rootStatus: 500 });
      expect((await rebuildManifestFromPod(POD, { fetch: pod.fetch, containers: [seed] })).written).toBe(2);
    }
  });

  it('ignores a named container outside the pod, the pod root, or a system container', async () => {
    const pod = podWithTwoContainers({ rootStatus: 500 });
    await rebuildManifestFromPod(POD, {
      fetch: pod.fetch,
      containers: ['../other/', 'https://elsewhere.example/x/', '/u2/', '', './', 'inbox/', 'settings/', 'my-records/?x=1'],
    });
    const probed = pod.gets.filter(u => u.endsWith('/') && u !== POD);
    expect(probed).toEqual([`${POD}context-graphs/`]);
  });

  it('publish, recovering a lost manifest, scans the container it just wrote to', async () => {
    // The manifest is absent (404) and the root cannot be listed, so without the seed the
    // recovery would see only the default container and drop the caller's own entries.
    const pod = podWithTwoContainers({ rootStatus: 500 });
    const d = ContextDescriptor.create('urn:iep:c' as IRI)
      .describes('urn:graph:c' as IRI)
      .temporal({ validFrom: '2026-09-28T00:00:00Z' })
      .build();
    await publish(d, '<urn:s> <urn:p> "v" .', POD, { fetch: pod.fetch, containerPath: 'my-records/' });
    expect(pod.gets).toContain(`${POD}my-records/`);
    const manifest = pod.store.get(`${POD}.well-known/context-graphs`) ?? '';
    expect(manifest).toContain('urn:graph:b');
    expect(manifest).toContain('urn:graph:a');
  });
});
