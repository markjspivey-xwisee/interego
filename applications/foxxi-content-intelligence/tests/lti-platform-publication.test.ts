import { afterEach, describe, expect, it, vi } from 'vitest';
import { LtiPlatform } from '../src/lti-platform.js';
import { isPlatformSnapshot } from '../src/lti-platform-readiness.js';
import { FOXXI_SNAPSHOT_TYPES, flushSnapshot, loadLatestSnapshotStrict, registerSnapshot, seedLatestSnapshotHead } from '../src/pod-snapshot-publisher.js';
import { withPublishLock } from '../src/bridge-signer.js';

const pod = 'https://pod.example/lms/';
const source = 'did:web:lms.example';
const typeIri = FOXXI_SNAPSHOT_TYPES.LtiPlatformGradebook;
const person = 'https://identity.example/users/synthetic/profile#me';
let sequence = 0;

/** Real publish() executes against this HTTP substrate. In particular, an existing graph's
 * If-None-Match:* PUT returns412 and leaves the FIRST bytes untouched, just like Solid.
 */
class SolidFixture {
  readonly files = new Map<string, { body: string; etag: string }>();
  readonly requests: Array<{ url: string; method: string; ifMatch: string | null; ifNone: string | null }> = [];
  private revision = 0;
  beforeGet?: (url: string) => Promise<Response | undefined>;
  set(url: string, body: string): void { this.files.set(url, { body, etag: `"r${++this.revision}"` }); }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    this.requests.push({ url, method, ifMatch: headers.get('if-match'), ifNone: headers.get('if-none-match') });
    if (method === 'GET' || method === 'HEAD') {
      const overridden = await this.beforeGet?.(url);
      if (overridden) return overridden;
      const file = this.files.get(url);
      return file ? new Response(method === 'HEAD' ? null : file.body, { headers: { etag: file.etag,
        'content-type': url.endsWith('.trig') ? 'application/trig' : 'text/turtle' } }) : new Response('', { status: 404 });
    }
    if (method !== 'PUT') return new Response('', { status: 405 });
    const held = this.files.get(url);
    if ((headers.get('if-none-match') === '*' && held)
      || (headers.has('if-match') && headers.get('if-match') !== held?.etag)) return new Response('', { status: 412 });
    this.set(url, String(init?.body ?? ''));
    return new Response('', { status: held ? 200 : 201, headers: { etag: this.files.get(url)!.etag } });
  };
}

function fixture(timeoutMs?: number) {
  const solid = new SolidFixture();
  vi.stubGlobal('fetch', solid.fetch);
  vi.stubEnv('FOXXI_TENANT_POD_URL', pod);
  vi.stubEnv('FOXXI_AUTHORITATIVE_SOURCE', source);
  const surface = `lti-platform-test-${++sequence}`;
  const latest = `${pod}foxxi/snapshots/${surface}-snapshot.ttl`;
  const legacyGraph = `${pod}foxxi/snapshots/${surface}-snapshot-graph.trig`;
  const platform = new LtiPlatform({ selfBaseUrl: 'https://bridge.example' });
  const start = platform.beginLaunch({ sub: person, podUrl: 'https://pod.example/person/' }, { id: 'signalkeeper-fixture', title: 'Synthetic course' });
  if (!start.ok) throw new Error('fixture launch failed');
  const read = () => loadLatestSnapshotStrict(surface, { typeIri, validate: isPlatformSnapshot, followLatestDescriptor: true });
  registerSnapshot({ surface, typeIri, collect: () => platform.snapshot(), immutableLatest: true, publicationTimeoutMs: timeoutMs });
  const prime = async () => { const value = await read(); seedLatestSnapshotHead(surface, value); return value; };
  const score = () => expect(platform.acceptScore(platform.context.id, String(start.lineItem.id).split('/').at(-1)!, {
    userId: person, scoreGiven: 100, scoreMaximum: 100, activityProgress: 'Completed', gradingProgress: 'FullyGraded',
    timestamp: '2026-10-31T18:00:00.000Z',
  }, Date.parse('2026-10-31T18:00:00.000Z'))).toEqual({ ok: true });
  return { solid, surface, platform, latest, legacyGraph, read, prime, score };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('LTI-only immutable versions and a CAS latest head', () => {
  it('publishes TWO different snapshots through REAL Solid publish and restores the SECOND score', async () => {
    const f = fixture();
    expect((await f.prime()).state).toBe('absent');
    await flushSnapshot(f.surface);
    const first = await f.read();
    expect(first.state).toBe('loaded');
    if (first.state !== 'loaded') throw new Error('first snapshot unavailable');
    expect(first.snapshot.results).toEqual([]);
    const firstGraph = [...f.solid.files.keys()].find((url) => url.endsWith('-graph.trig'))!;
    const firstBytes = f.solid.files.get(firstGraph)!.body;
    f.score();
    await flushSnapshot(f.surface);
    const second = await f.read();
    expect(second.state).toBe('loaded');
    if (second.state !== 'loaded') throw new Error('second snapshot unavailable');
    const restarted = new LtiPlatform({ selfBaseUrl: 'https://bridge.example' });
    restarted.restore(second.snapshot);
    expect(restarted.gradebookFor(person)[0]?.result).toMatchObject({ resultScore: 100, resultMaximum: 100, timestamp: '2026-10-31T18:00:00.000Z' });
    expect(second.revision.sha256).not.toBe(first.revision.sha256);
    expect(second.revision.version).toBe(2);
    expect(second.head?.descriptorIri).not.toBe(first.head?.descriptorIri);
    expect(f.solid.files.get(firstGraph)!.body).toBe(firstBytes);
    expect([...f.solid.files.keys()].filter((url) => url.endsWith('-graph.trig'))).toHaveLength(2);
    expect(f.solid.requests.filter((r) => r.url === f.latest && r.method === 'PUT')).toEqual([
      expect.objectContaining({ ifNone: '*', ifMatch: null }), expect.objectContaining({ ifNone: null, ifMatch: first.head?.etag }),
    ]);
    const immutableDescriptors = f.solid.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('.ttl') && r.url !== f.latest);
    expect(immutableDescriptors).toHaveLength(2);
    expect(immutableDescriptors.every((r) => r.ifNone === '*')).toBe(true);
    expect((await f.solid.fetch(firstGraph, { method: 'PUT', headers: { 'If-None-Match': '*' }, body: 'cannot clobber' })).status).toBe(412);
    expect(f.solid.files.get(firstGraph)!.body).toBe(firstBytes);
    const before = f.solid.requests.length;
    await flushSnapshot(f.surface);
    expect(f.solid.requests).toHaveLength(before); // identical payload is not a new grade or publication
  });

  it('refuses a stale head and never adopts a fresh ETag to republish stale RAM after412', async () => {
    const f = fixture();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await f.prime(); await flushSnapshot(f.surface);
    f.solid.set(f.latest, `${f.solid.files.get(f.latest)!.body}\n# another writer advanced this head\n`);
    const competing = { ...f.solid.files.get(f.latest)! };
    f.score(); await flushSnapshot(f.surface);
    expect(errors.mock.calls.some((call) => call[1] === 'lti_snapshot_head_conflict')).toBe(true);
    expect(f.solid.files.get(f.latest)).toEqual(competing);
    await f.prime(); // even an explicit read cannot rebase this publisher over stale RAM
    const before = f.solid.requests.length;
    await flushSnapshot(f.surface);
    expect(f.solid.requests).toHaveLength(before);
    expect(f.solid.files.get(f.latest)).toEqual(competing);
  });

  it('hydrates publisher lineage/version from the observed head instead of restarting identity at v1', async () => {
    const f = fixture();
    await f.prime(); await flushSnapshot(f.surface);
    const originalHead = await f.read();
    expect(originalHead.state).toBe('loaded');
    // A fresh module is a new process-local registry, against the SAME durable HTTP substrate.
    vi.resetModules();
    const fresh = await import('../src/pod-snapshot-publisher.js');
    const cold = new LtiPlatform({ selfBaseUrl: 'https://bridge.example' });
    fresh.registerSnapshot({ surface: f.surface, typeIri, collect: () => cold.snapshot(), immutableLatest: true });
    const loaded = await fresh.loadLatestSnapshotStrict(f.surface, { typeIri, validate: isPlatformSnapshot, followLatestDescriptor: true });
    if (loaded.state !== 'loaded') throw new Error('restart hydration failed');
    cold.restore(loaded.snapshot);
    fresh.seedLatestSnapshotHead(f.surface, loaded);
    expect(cold.acceptScore(cold.context.id, cold.snapshot().lineItems[0]!.id, { userId: person, scoreGiven: 100, scoreMaximum: 100,
      activityProgress: 'Completed', gradingProgress: 'FullyGraded', timestamp: '2026-10-31T18:00:00.000Z' }, Date.parse('2026-10-31T18:00:00.000Z'))).toEqual({ ok: true });
    await fresh.flushSnapshot(f.surface);
    const kept = await fresh.loadLatestSnapshotStrict(f.surface, { typeIri, validate: isPlatformSnapshot, followLatestDescriptor: true });
    expect(kept.state).toBe('loaded');
    if (kept.state !== 'loaded' || originalHead.state !== 'loaded') throw new Error('restart snapshot unavailable');
    expect(kept.revision.version).toBe(2);
    expect(f.solid.files.get(f.latest)!.body).toContain(`<${originalHead.head!.descriptorIri}>`);
    expect(kept.snapshot.results[0]?.[1][0]?.scoreGiven).toBe(100);
  });

  it('accepts only a matching legacy descriptor+graph; never calls a newer descriptor over the first graph latest', async () => {
    const f = fixture(); await f.prime(); await flushSnapshot(f.surface);
    const head = f.solid.files.get(f.latest)!.body;
    const graphUrl = [...f.solid.files.keys()].find((url) => url.endsWith('-graph.trig'))!;
    const graph = f.solid.files.get(graphUrl)!.body;
    const iri = /urn:foxxi:[^<>\s]+:sha256:[a-f0-9]{64}/.exec(graph)![0];
    const legacyIri = `urn:foxxi:${f.surface}-snapshot:v1`;
    f.solid.set(f.legacyGraph, graph.replaceAll(iri, legacyIri));
    f.solid.set(f.latest, head.replaceAll(graphUrl, f.legacyGraph).replaceAll(iri, `urn:foxxi:${f.surface}-snapshot:v2`));
    expect(await f.read()).toMatchObject({ state: 'unavailable', reason: 'legacy-head-mismatch' });
    f.solid.set(f.latest, head.replaceAll(graphUrl, f.legacyGraph).replaceAll(iri, legacyIri));
    expect(await f.read()).toMatchObject({ state: 'loaded' });
    f.solid.files.delete(f.latest);
    expect(await f.read()).toEqual({ state: 'unavailable', reason: 'legacy-head-missing' });
  });

  it('rejects a self-consistent payload and dct hash carried under a DIFFERENT payload-hash graph IRI', async () => {
    const f = fixture(); await f.prime(); await flushSnapshot(f.surface);
    const firstHead = f.solid.files.get(f.latest)!.body;
    const firstIri = /urn:foxxi:[^<>\s]+:sha256:[a-f0-9]{64}/.exec(firstHead)![0];
    f.score(); await flushSnapshot(f.surface);
    const secondHead = f.solid.files.get(f.latest)!.body;
    const secondIri = /urn:foxxi:[^<>\s]+:sha256:[a-f0-9]{64}/.exec(secondHead)![0];
    const secondGraph = [...f.solid.files.entries()].find(([url, value]) => url.endsWith('-graph.trig') && value.body.includes(secondIri))!;
    f.solid.set(secondGraph[0], secondGraph[1].body.replaceAll(secondIri, firstIri));
    f.solid.set(f.latest, secondHead.replaceAll(secondIri, firstIri));
    expect(await f.read()).toEqual({ state: 'unavailable', reason: 'invalid-snapshot' });
  });

  it('fails closed on weak/missing head ETags and out-of-container distributions', async () => {
    const f = fixture(); await f.prime(); await flushSnapshot(f.surface);
    const original = { ...f.solid.files.get(f.latest)! };
    for (const etag of ['', 'W/"weak"']) {
      f.solid.files.set(f.latest, { ...original, etag });
      expect(await f.read()).toEqual({ state: 'unavailable', reason: 'head-unversioned' });
    }
    f.solid.set(f.latest, original.body.replaceAll(`${pod}foxxi/snapshots/`, 'https://untrusted.example/'));
    const before = f.solid.requests.length;
    expect(await f.read()).toEqual({ state: 'unavailable', reason: 'invalid-head' });
    expect(f.solid.requests.slice(before).every((r) => r.url.startsWith(pod))).toBe(true);
    f.solid.set(f.latest, original.body.replace('<> iep:affordance [', '<urn:disconnected> iep:affordance ['));
    expect(await f.read()).toEqual({ state: 'unavailable', reason: 'invalid-head' });
  });

  it('bounds the whole publication and prevents late graph readback from updating the latest pointer', async () => {
    const f = fixture(500);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await f.prime();
    let release: ((response: Response) => void) | undefined;
    let heldUrl = '';
    f.solid.beforeGet = async (url) => {
      if (url.endsWith('-graph.trig') && f.solid.files.has(url)) {
        heldUrl = url;
        return await new Promise<Response>((r) => { release = r; }); // deliberately ignores AbortSignal
      }
      return undefined;
    };
    const pending = flushSnapshot(f.surface);
    await vi.waitFor(() => expect(release !== undefined).toBe(true));
    await pending;
    expect(errors.mock.calls.some((call) => call[1] === 'lti_snapshot_publish_deadline')).toBe(true);
    expect(f.solid.files.has(f.latest)).toBe(false);
    const following = fixture();
    await following.prime(); await flushSnapshot(following.surface);
    expect(following.solid.files.has(following.latest)).toBe(true); // the timed-out job released the actual shared lock
    release!(new Response(f.solid.files.get(heldUrl)!.body));
    await new Promise<void>((r) => setImmediate(r));
    expect(f.solid.requests.some((r) => r.url === f.latest && r.method === 'PUT')).toBe(false);
  });

  it('counts shared-lock wait in the deadline and refuses queued work when the old lock finally releases', async () => {
    let release!: () => void;
    const held = withPublishLock(() => new Promise<void>((r) => { release = r; }));
    await vi.waitFor(() => expect(release !== undefined).toBe(true));
    const f = fixture(30);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await f.prime();
    const before = f.solid.requests.length;
    try {
      await flushSnapshot(f.surface);
      expect(errors.mock.calls.some((call) => call[1] === 'lti_snapshot_publish_deadline')).toBe(true);
      expect(f.solid.requests).toHaveLength(before);
    } finally { release(); await held; }
    await new Promise<void>((r) => setImmediate(r));
    expect(f.solid.requests).toHaveLength(before);
    expect(f.solid.files.has(f.latest)).toBe(false);
  });
});
