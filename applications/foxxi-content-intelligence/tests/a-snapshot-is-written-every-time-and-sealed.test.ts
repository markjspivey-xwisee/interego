/**
 * A snapshot on the pod is the state as it last was, and only the bridge can read it.
 *
 * Found on the deployed bridge, 2026-11-15: a restart lost every cmi5 launch. The snapshot graph
 * on the pod was from 2026-09-26. `publish()` writes a graph with `If-None-Match: *` and takes the
 * 412 as done, so a snapshot's first write was its only one, and the descriptor beside it went on
 * being rewritten. The graph was also plain text on a pod anyone can read.
 *
 * The real `publish()` runs here against a stand-in pod that answers 412 as a Solid server does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { FOXXI_SNAPSHOT_TYPES, SEALED_SNAPSHOT_MAX_BYTES, flushSnapshot, loadLatestSnapshot, registerSnapshot } from '../src/pod-snapshot-publisher.js';

const POD = 'https://pod.example/tenant/';
const SOURCE = 'did:web:tenant.example' as IRI;
const KEY = deriveEncryptionKeyPair('11'.repeat(32), `urn:foxxi:tenant-snapshot:v1:${POD}`);
const OTHER_KEY = deriveEncryptionKeyPair('22'.repeat(32), `urn:foxxi:tenant-snapshot:v1:${POD}`);
const LEARNER = 'https://identity.example/users/u-pk-fictional0001/profile#me';
const REGISTRATION = '5ea1ed00-0000-4000-8000-000000000001';

/** A pod: an existing resource PUT with If-None-Match:* answers 412 and keeps its first bytes. */
class Pod {
  readonly files = new Map<string, string>();
  readonly puts: Array<{ url: string; ifNone: string | null; status: number }> = [];
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    if (method === 'GET' || method === 'HEAD') {
      const body = this.files.get(url);
      return body === undefined ? new Response('', { status: 404 }) : new Response(method === 'HEAD' ? null : body, { headers: { etag: `"${body.length}"` } });
    }
    if (method !== 'PUT') return new Response('', { status: 405 });
    const held = this.files.has(url);
    const refused = headers.get('if-none-match') === '*' && held;
    if (!refused) this.files.set(url, String(init?.body ?? ''));
    const status = refused ? 412 : held ? 200 : 201;
    this.puts.push({ url, ifNone: headers.get('if-none-match'), status });
    return new Response('', { status });
  };
}

let n = 0;
function surfaceOn(pod: Pod, sealKey: typeof KEY | undefined) {
  const surface = `cmi5-test-${++n}`;
  const state = { launches: [] as Array<[string, { learner: { id: string }; registration: string; satisfied: boolean }]> };
  const config = { podUrl: POD, authoritativeSource: SOURCE, fetch: pod.fetch, ...(sealKey ? { sealKey } : {}) };
  registerSnapshot({ surface, typeIri: FOXXI_SNAPSHOT_TYPES.Cmi5Launches, collect: () => state, config, debounceMs: 1 });
  const sealed = `${POD}foxxi/snapshots/${surface}-snapshot-graph.envelope.jose.json`;
  const plain = `${POD}foxxi/snapshots/${surface}-snapshot-graph.trig`;
  const launch = (registration: string, satisfied = false) => { state.launches.push([registration, { learner: { id: LEARNER }, registration, satisfied }]); };
  return { surface, state, config, sealed, plain, launch, load: (key: typeof KEY | undefined = sealKey) => loadLatestSnapshot<typeof state>(surface, { ...config, sealKey: key }) };
}
const LEGACY = (payload: unknown): string =>
  `<urn:foxxi:legacy> <https://foxxi-bridge.interego.xwisee.com/ns/foxxi#bundleJson> "${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .`;

afterEach(() => { vi.restoreAllMocks(); });

describe('a snapshot written more than once', () => {
  it('is on the pod as it last was, not as it first was', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, KEY);
    s.launch(REGISTRATION);
    await flushSnapshot(s.surface);
    expect((await s.load())?.launches).toHaveLength(1);

    s.launch('5ea1ed00-0000-4000-8000-000000000002');
    s.state.launches[0]![1].satisfied = true;
    await flushSnapshot(s.surface);
    const read = await s.load();
    expect(read?.launches.map(l => l[0])).toEqual([REGISTRATION, '5ea1ed00-0000-4000-8000-000000000002']);
    expect(read?.launches[0]![1].satisfied).toBe(true);

    // Every write of the graph reached the pod and was taken: none was a create-only PUT refused as existing.
    const graphPuts = pod.puts.filter(p => p.url === s.sealed);
    expect(graphPuts.map(p => p.status)).toEqual([201, 200]);
    expect(graphPuts.every(p => p.ifNone === null)).toBe(true);
  });

  it('shows the defect it replaces: the same pod keeps the first bytes of a create-only write', async () => {
    const pod = new Pod();
    await pod.fetch(`${POD}x`, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: 'first' });
    const second = await pod.fetch(`${POD}x`, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: 'second' });
    expect([second.status, pod.files.get(`${POD}x`)]).toEqual([412, 'first']);
  });
});

describe('what a snapshot is on the pod', () => {
  it('is sealed: no plain graph is written, and the sealed one names nobody', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, KEY);
    s.launch(REGISTRATION);
    await flushSnapshot(s.surface);
    expect(pod.files.has(s.plain)).toBe(false);
    const everything = [...pod.files.values()].join('\n');
    for (const said of [LEARNER, REGISTRATION, Buffer.from(JSON.stringify(s.state), 'utf8').toString('base64').slice(0, 40)]) {
      expect(everything).not.toContain(said);
    }
    expect(JSON.parse(pod.files.get(s.sealed)!)).toHaveProperty('wrappedKeys');
  });

  it('is opened only by the key that sealed it', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, KEY);
    s.launch(REGISTRATION);
    await flushSnapshot(s.surface);
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await s.load(OTHER_KEY)).toBeNull();
    expect(said.mock.calls.join(' ')).toContain('was not sealed by this bridge\'s key');
    expect((await s.load(KEY))?.launches).toHaveLength(1);
  });

  it('is not taken when someone else sealed it to the bridge, or it was altered', async () => {
    const pod = new Pod();
    const theirs = surfaceOn(pod, OTHER_KEY);
    theirs.launch(REGISTRATION);
    await flushSnapshot(theirs.surface);
    const mine = surfaceOn(pod, KEY);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Their envelope, put where this bridge's snapshot would be.
    pod.files.set(mine.sealed, pod.files.get(theirs.sealed)!);
    expect(await mine.load()).toBeNull();
    pod.files.set(mine.sealed, '{"not":"an envelope"}');
    expect(await mine.load()).toBeNull();
    pod.files.set(mine.sealed, 'not json');
    expect(await mine.load()).toBeNull();
  });

  it('is not written at all by a bridge with no key, which says so once', async () => {
    const pod = new Pod();
    const warned = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const s = surfaceOn(pod, undefined);
    s.launch(REGISTRATION);
    await flushSnapshot(s.surface);
    await flushSnapshot(s.surface);
    expect(pod.files.size).toBe(0);
    expect(pod.puts).toEqual([]);
    expect(warned.mock.calls.filter(c => String(c[0]).includes(s.surface))).toHaveLength(1);
    expect(await s.load()).toBeNull();
  });
});

describe('the plain graph an earlier bridge left', () => {
  it('is read where there is no sealed one yet, and never once there is', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, KEY);
    pod.files.set(s.plain, LEGACY({ launches: [['0ld00000-0000-4000-8000-000000000000', { learner: { id: LEARNER }, registration: '0ld00000-0000-4000-8000-000000000000', satisfied: true }]] }));
    expect((await s.load())?.launches.map(l => l[0])).toEqual(['0ld00000-0000-4000-8000-000000000000']);

    s.launch(REGISTRATION);
    await flushSnapshot(s.surface);
    expect((await s.load())?.launches.map(l => l[0])).toEqual([REGISTRATION]);
    // It is left where it was: removing stored data is not this code's to do.
    expect(pod.files.has(s.plain)).toBe(true);

    // A sealed graph this bridge cannot open is not papered over with the old plain one.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await s.load(OTHER_KEY)).toBeNull();
  });

  it('is still read by a bridge with no key, where nothing sealed exists', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, undefined);
    pod.files.set(s.plain, LEGACY({ launches: [] }));
    expect(await s.load()).toEqual({ launches: [] });
  });

  it('is not read by a bridge that lost its key once a sealed snapshot exists', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, KEY);
    pod.files.set(s.plain, LEGACY({ launches: [['0ld00000-0000-4000-8000-000000000000', { learner: { id: LEARNER }, registration: '0ld00000-0000-4000-8000-000000000000', satisfied: true }]] }));
    s.launch(REGISTRATION);
    await flushSnapshot(s.surface);
    const said = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Started again with no key: the old plain state is not brought back as if it were current.
    expect(await loadLatestSnapshot(s.surface, { podUrl: POD, authoritativeSource: SOURCE, fetch: pod.fetch })).toBeNull();
    expect(said.mock.calls.join(' ')).toContain('this bridge has no key to open it');
  });
});

describe('a write the pod does not take', () => {
  /** A pod that answers one status to every PUT of the sealed graph, and is a pod for everything else. */
  const refusing = (pod: Pod, sealed: string, status: number): typeof globalThis.fetch => async (input, init) =>
    (String(input) === sealed && (init?.method ?? 'GET').toUpperCase() === 'PUT' ? new Response('', { status }) : pod.fetch(input, init));

  it('leaves the last readable snapshot and its descriptor, for a 412 as for any other refusal', async () => {
    for (const status of [412, 403, 507]) {
      const pod = new Pod();
      const s = surfaceOn(pod, KEY);
      s.launch(REGISTRATION);
      await flushSnapshot(s.surface);
      const descriptor = `${POD}foxxi/snapshots/${s.surface}-snapshot.ttl`;
      const before = { graph: pod.files.get(s.sealed), descriptor: pod.files.get(descriptor) };
      expect(before.descriptor).toBeDefined();

      const failed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      registerSnapshot({ surface: s.surface, typeIri: FOXXI_SNAPSHOT_TYPES.Cmi5Launches, collect: () => s.state, debounceMs: 1,
        config: { ...s.config, fetch: refusing(pod, s.sealed, status) } });
      s.launch('5ea1ed00-0000-4000-8000-0000000000ff');
      await flushSnapshot(s.surface);
      expect(failed.mock.calls.join(' '), `status ${status}`).toContain('publish failed');
      // Neither the graph nor the descriptor moved: no descriptor was written over a graph that was not replaced.
      expect({ graph: pod.files.get(s.sealed), descriptor: pod.files.get(descriptor) }).toEqual(before);
      expect((await s.load())?.launches.map(l => l[0])).toEqual([REGISTRATION]);
      vi.restoreAllMocks();
    }
  }, 240_000);

  it('is not sent when it is larger than a reader would take', async () => {
    const pod = new Pod();
    const s = surfaceOn(pod, KEY);
    s.launch(REGISTRATION);
    await flushSnapshot(s.surface);
    const before = pod.files.get(s.sealed);
    const failed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (s.state as unknown as { padding: string }).padding = 'x'.repeat(SEALED_SNAPSHOT_MAX_BYTES);
    await flushSnapshot(s.surface);
    expect(failed.mock.calls.join(' ')).toContain('publish failed');
    expect(pod.puts.filter(p => p.url === s.sealed)).toHaveLength(1);
    expect(pod.files.get(s.sealed)).toBe(before);
    expect((await s.load())?.launches.map(l => l[0])).toEqual([REGISTRATION]);
  }, 240_000);
});
