/**
 * THE NEUTRAL EXTENSION CONTRACT: COMPLETE, BOUNDED, VERIFIED, UNAMBIGUOUS — OR REFUSED.
 *
 * `loadExtensionCatalog` (packages/solid/src/extensions.ts) replaced a relay loader that knew one
 * vertical's vocabulary and read only the newest 200 manifest rows, silently (#367). These cases
 * use a profile that knows nothing but the fixture's own made-up vocabulary, over descriptors
 * published into an in-memory pod by the real `publish()`, so the contract is shown to hold for a
 * vertical this repository has never heard of. Every refusal is paired with the load that must
 * still succeed, so a guard that refuses everything fails as surely as one that refuses nothing.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  publish,
  loadExtensionCatalog,
  ExtensionLoadRefused,
  type ExtensionProfile,
  type ExtensionOperationDraft,
} from '@interego/solid';
import { ContextDescriptor } from '@interego/core';
import type { IRI } from '@interego/core';

const POD = 'https://pod.example/u/';
const MANIFEST = `${POD}.well-known/context-graphs`;
const EX = 'https://vertical.example/ns#';

interface MockResponse {
  ok: boolean; status: number; statusText: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>; json: () => Promise<unknown>;
}
const respond = (status: number, body: string, type = 'text/turtle'): MockResponse => ({
  ok: status >= 200 && status < 300, status, statusText: '',
  headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? `"e${body.length}"` : type) },
  text: async () => body, json: async () => ({}),
});

function makePod() {
  const store = new Map<string, string>();
  const fail = new Set<string>();
  const requested: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    requested.push(`${method} ${url}`);
    // Unreadable, and not a status the substrate retries, so a refusal is immediate.
    if (fail.has(url)) return respond(403, '');
    if (method === 'PUT') { store.set(url, init?.body ?? ''); return respond(205, ''); }
    if (method === 'DELETE') return respond(store.delete(url) ? 205 : 404, '');
    const body = store.get(url);
    return body === undefined ? respond(404, '') : respond(200, body, url.endsWith('.trig') ? 'application/trig' : 'text/turtle');
  });
  return { store, fail, requested, fetch: fetchFn as never };
}

/** Publish one operation the fixture's vocabulary describes. */
async function offer(pod: ReturnType<typeof makePod>, id: string, action: string, title: string, extra = '') {
  const d = ContextDescriptor.create(`urn:example:op:${id}` as IRI)
    .describes(`urn:graph:example-op:${id}` as IRI)
    .temporal({ validFrom: '2026-09-28T00:00:00Z' })
    .asserted(0.9)
    .build();
  const graph = `@prefix ex: <${EX}> .\n<urn:example:op:${id}> a ex:Operation ;\n    ex:action <${action}> ;\n    ex:title "${title}" ${extra}.\n`;
  return publish(d, graph, POD, { fetch: pod.fetch });
}

/** A profile that knows only the fixture's vocabulary. */
function profile(overrides: Partial<ExtensionProfile> = {}): ExtensionProfile {
  return {
    id: `${EX}Operation`,
    selects: e => e.describes.some(g => g.startsWith('urn:graph:example-op:')),
    async interpret(c): Promise<ExtensionOperationDraft | undefined> {
      const payload = await c.readPayload(c.entry.descriptorUrl);
      const action = /ex:action <([^>]+)>/.exec(payload)?.[1];
      const title = /ex:title "([^"]+)"/.exec(payload)?.[1];
      if (!action || !title) return undefined;
      const target = /ex:target <([^>]+)>/.exec(payload)?.[1];
      return { action, title, ...(target ? { target: { href: target } } : {}) };
    },
    ...overrides,
  };
}

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { if (e instanceof ExtensionLoadRefused) return e.reason; throw e; }
  return 'loaded';
};

describe('a complete load', () => {
  it('reads every operation the profile selects, sorted, with content identity', async () => {
    const pod = makePod();
    await offer(pod, 'b', 'https://vertical.example/actions/b', 'Second');
    await offer(pod, 'a', 'https://vertical.example/actions/a', 'First', '; ex:target <https://vertical.example/run/a> ');
    const other = ContextDescriptor.create('urn:example:note' as IRI).describes('urn:graph:note' as IRI)
      .temporal({ validFrom: '2026-09-28T00:00:00Z' }).build();
    await publish(other, '<urn:s> <urn:p> "not an operation" .', POD, { fetch: pod.fetch });

    const catalog = await loadExtensionCatalog(POD, profile(), { fetch: pod.fetch });
    expect(catalog.operations.map(o => o.action)).toEqual(['https://vertical.example/actions/a', 'https://vertical.example/actions/b']);
    expect(catalog.operations[0]).toMatchObject({ title: 'First', target: { href: 'https://vertical.example/run/a', method: 'POST' } });
    expect(catalog.operations[1]!.descriptorUrl.startsWith(POD)).toBe(true);
    expect(catalog).toMatchObject({ profile: `${EX}Operation`, pod: POD, rows: 3, selected: 2 });
    expect(catalog.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('gives the same digest for the same operations, and a new one when what is offered changes', async () => {
    const pod = makePod();
    await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    const one = await loadExtensionCatalog(POD, profile(), { fetch: pod.fetch });
    const again = await loadExtensionCatalog(POD, profile(), { fetch: pod.fetch });
    expect(again.digest).toBe(one.digest);
    await offer(pod, 'c', 'https://vertical.example/actions/c', 'Third');
    expect((await loadExtensionCatalog(POD, profile(), { fetch: pod.fetch })).digest).not.toBe(one.digest);
  });

  it('reads a pod with no manifest yet as offering nothing', async () => {
    const catalog = await loadExtensionCatalog(POD, profile(), { fetch: makePod().fetch });
    expect(catalog.operations).toEqual([]);
    expect(catalog.rows).toBe(0);
  });

  it('never fetches outside the pod, even when a row names another host for a path inside it', async () => {
    const pod = makePod();
    const published = await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    // What a pod server writes: its canonical internal host in the stored bytes.
    const hot = pod.store.get(MANIFEST)!;
    pod.store.set(MANIFEST, hot.split(published.descriptorUrl).join(published.descriptorUrl.replace('https://pod.example', 'http://pod-server.internal:3456')));
    const catalog = await loadExtensionCatalog(POD, profile(), { fetch: pod.fetch });
    expect(catalog.operations).toHaveLength(1);
    expect(pod.requested.every(r => r.split(' ')[1]!.startsWith('https://pod.example/u/'))).toBe(true);
  });
});

describe('a load that cannot be complete is refused', () => {
  it('when an archive segment of the manifest cannot be read', async () => {
    const pod = makePod();
    await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('loaded');
    const archive = `${POD}.well-known/context-graphs-archive-0000`;
    pod.store.set(MANIFEST, pod.store.get(MANIFEST)!.replace(' a hydra:Collection', ` iep:manifestArchive <${archive}> ;\n    a hydra:Collection`));
    pod.fail.add(archive);
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('incomplete');
  });

  it('when the manifest itself fails', async () => {
    const pod = makePod();
    pod.fail.add(MANIFEST);
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('incomplete');
  });

  it('when a selected descriptor or its payload cannot be read', async () => {
    const pod = makePod();
    const published = await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    pod.fail.add(published.descriptorUrl);
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('incomplete');
    pod.fail.delete(published.descriptorUrl);
    pod.fail.add(published.graphUrl);
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('incomplete');
  });

  it('when the pod holds more rows, or offers more operations, than the bound', async () => {
    const pod = makePod();
    await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    await offer(pod, 'b', 'https://vertical.example/actions/b', 'Second');
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch, maxRows: 2 }))).toBe('loaded');
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch, maxRows: 1 }))).toBe('over-bound');
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch, maxOperations: 1 }))).toBe('over-bound');
  });
});

describe('a candidate is verified before a profile reads it', () => {
  it('refuses a row whose descriptor lies outside the pod', async () => {
    const pod = makePod();
    const published = await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    const elsewhere = published.descriptorUrl.replace('/u/', '/someone-else/');
    pod.store.set(elsewhere, pod.store.get(published.descriptorUrl)!);
    pod.store.set(MANIFEST, pod.store.get(MANIFEST)!.split(published.descriptorUrl).join(elsewhere));
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('unverified');
  });

  it('refuses a descriptor that does not describe the graph its row claims', async () => {
    const pod = makePod();
    const published = await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    pod.store.set(published.descriptorUrl, pod.store.get(published.descriptorUrl)!.split('urn:graph:example-op:a').join('urn:graph:swapped'));
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('unverified');
  });

  it('refuses a descriptor whose body is not the one its row\'s content id names', async () => {
    const pod = makePod();
    const published = await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    expect(pod.store.get(MANIFEST)).toContain('iep:contentCid');
    pod.store.set(published.descriptorUrl, `${pod.store.get(published.descriptorUrl)!}\n# edited after publication\n`);
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('unverified');
  });
});

describe('identity is the action, and it is unambiguous', () => {
  it('refuses two current descriptors offering the same action', async () => {
    const pod = makePod();
    await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    await offer(pod, 'a2', 'https://vertical.example/actions/a', 'Also first');
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('ambiguous');
  });

  it('treats the urn and URL forms of one action as one action', async () => {
    const pod = makePod();
    await offer(pod, 'a', 'urn:iep:action:example:run', 'First');
    await offer(pod, 'b', 'https://relay.interego.xwisee.com/ns/iep/action/example/run', 'Same action');
    expect(await refusal(loadExtensionCatalog(POD, profile(), { fetch: pod.fetch }))).toBe('ambiguous');
  });

  it('reads only the current descriptor of a superseded pair', async () => {
    const pod = makePod();
    const old = await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    const d = ContextDescriptor.create('urn:example:op:a-v2' as IRI)
      .describes('urn:graph:example-op:a-v2' as IRI)
      .temporal({ validFrom: '2026-09-29T00:00:00Z' })
      .asserted(0.9)
      .supersedes(old.descriptorUrl as IRI)
      .build();
    await publish(d, `@prefix ex: <${EX}> .\n<urn:example:op:a-v2> ex:action <https://vertical.example/actions/a> ; ex:title "First, revised" .\n`, POD, { fetch: pod.fetch });
    const catalog = await loadExtensionCatalog(POD, profile(), { fetch: pod.fetch });
    expect(catalog.operations.map(o => o.title)).toEqual(['First, revised']);
  });
});

describe('a profile is held to the contract', () => {
  it('refuses an action that is not an absolute IRI, a non-http target, and an untitled operation', async () => {
    for (const draft of [
      { action: 'relative/action', title: 'x' },
      { action: 'https://vertical.example/actions/a', title: 'x', target: { href: 'javascript:alert(1)' } },
      { action: 'https://vertical.example/actions/a', title: '  ' },
    ]) {
      const pod = makePod();
      await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
      const p = profile({ interpret: async () => draft as ExtensionOperationDraft });
      expect(await refusal(loadExtensionCatalog(POD, p, { fetch: pod.fetch })), JSON.stringify(draft)).toBe('invalid');
    }
  });

  it('refuses the whole load when a profile cannot read something it selected', async () => {
    const pod = makePod();
    await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    const p = profile({ interpret: async () => { throw new Error('unexpected shape'); } });
    expect(await refusal(loadExtensionCatalog(POD, p, { fetch: pod.fetch }))).toBe('invalid');
  });

  it('refuses a definition named outside the pod\'s current rows', async () => {
    const pod = makePod();
    await offer(pod, 'a', 'https://vertical.example/actions/a', 'First');
    const p = profile({ interpret: async () => ({ action: 'https://vertical.example/actions/a', title: 'x', definedBy: `${POD}context-graphs/nothing.ttl` }) });
    expect(await refusal(loadExtensionCatalog(POD, p, { fetch: pod.fetch }))).toBe('unverified');
  });

  it('refuses a profile not named by an absolute IRI', async () => {
    expect(await refusal(loadExtensionCatalog(POD, profile({ id: 'Operation' }), { fetch: makePod().fetch }))).toBe('invalid');
  });
});
