import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { deriveEncryptionKeyPair, mintNodeId, type IRI } from '@interego/core';
import {
  NativeCommitStore, NativeCommitConflictError, NATIVE_COMMIT_MEDIA_TYPE, NATIVE_STAGE_MEDIA_TYPE,
  createNativeByteArtifact, readNativeByteArtifact, validateNativeArtifact,
  type NativeArtifactInput, type NativeArtifactReference, type NativeCommitScope, type NativeSnapshotReference,
  type NativeHeadReadDiagnostic,
} from '@interego/pgsl';

const owner = deriveEncryptionKeyPair('a'.repeat(64));
const bridge = deriveEncryptionKeyPair('b'.repeat(64));
const other = deriveEncryptionKeyPair('c'.repeat(64));
const scope: NativeCommitScope = {
  pod: 'https://pod.example/alice/', headUrl: 'https://pod.example/alice/native/head.json',
  artifactContainer: 'https://pod.example/alice/native/', owner: 'did:web:alice.example' as IRI,
};
const provenance = { wasAttributedTo: scope.owner, generatedAtTime: '2026-10-15T00:00:00.000Z' };
const sha = (bytes: Uint8Array | string): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function artifact(text: string): NativeArtifactInput {
  return createNativeByteArtifact({ owner: scope.owner, contentType: 'application/octet-stream', bytes: Buffer.from(text), provenance });
}
interface Row { bytes: Uint8Array; revision: string; }
/** Models the native CAS contract; cryptography and PGSL closure validation are real. */
class NativeTransport {
  readonly rows = new Map<string, Row>();
  readonly methods: string[] = [];
  readonly writes: Array<{ url: string; body: string }> = [];
  optionsAvailable = true;
  /** Batched staging is modelled only when a test turns it on; every other test sees a server without it. */
  stageAvailable = false;
  failBatch = false;
  batchTransform: ((receipts: Record<string, unknown>[]) => unknown) | undefined;
  readonly batches: string[][] = [];
  failStage = false;
  loseStageAck = false;
  failHead = false;
  loseHeadAck = false;
  corruptHeadRead = false;
  stripHeadDigest = false;
  receiptTransform: ((receipt: Record<string, unknown>) => void) | undefined;
  afterHead: (() => Promise<void>) | undefined;
  beforeHead: (() => Promise<void>) | undefined;
  private sequence = 0;
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    this.methods.push(method + ' ' + url);
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: this.optionsAvailable
      ? { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1', ...(this.stageAvailable ? { 'Interego-Native-Stage': '1' } : {}) } : {} });
    if (method === 'POST') return this.stageBatch(url, init);
    if (method === 'GET') {
      const row = this.rows.get(url); if (!row) return new Response(null, { status: 404 });
      const headers: Record<string, string> = { 'Content-Type': 'application/json',
        ETag: '"' + row.revision + '-json"', 'Interego-Revision': row.revision,
        'Interego-Body-Digest': sha(row.bytes) };
      if (url === scope.headUrl && this.stripHeadDigest) delete headers['Interego-Body-Digest'];
      const body = url === scope.headUrl && this.corruptHeadRead ? '{}' : Buffer.from(row.bytes).toString('utf8');
      return new Response(body, { headers });
    }
    expect(method).toBe('PUT');
    expect(init?.redirect).toBe('manual');
    const headers = new Headers(init?.headers);
    expect(headers.get('Content-Type')).toBe(NATIVE_COMMIT_MEDIA_TYPE);
    const command = JSON.parse(String(init?.body)) as {
      version: number; expectedRevision: string | null; contentType: string; bodyBase64: string;
    };
    expect(command.version).toBe(1); expect(command.contentType).toBe('application/json');
    const bytes = Buffer.from(command.bodyBase64, 'base64');
    expect(bytes.toString('base64')).toBe(command.bodyBase64);
    if (command.expectedRevision === null) {
      expect(headers.get('If-None-Match')).toBe('*'); expect(headers.get('If-Match')).toBeNull();
    } else {
      expect(headers.get('If-Match')).toBe('"' + command.expectedRevision + '"'); expect(headers.get('If-None-Match')).toBeNull();
    }
    if (url === scope.headUrl && this.beforeHead) {
      const before = this.beforeHead; this.beforeHead = undefined; await before();
    }
    const old = this.rows.get(url);
    if ((command.expectedRevision === null && old) || (command.expectedRevision !== null && old?.revision !== command.expectedRevision)) {
      return new Response(null, { status: 412 });
    }
    if ((url === scope.headUrl && this.failHead) || (url !== scope.headUrl && this.failStage)) return new Response(null, { status: 503 });
    const revision = sha(url + ':' + (++this.sequence) + ':' + sha(bytes));
    this.rows.set(url, { bytes, revision }); this.writes.push({ url, body: bytes.toString('utf8') });
    if (url !== scope.headUrl && this.loseStageAck) { this.loseStageAck = false; throw new Error('simulated lost immutable acknowledgement'); }
    const nativeUri = mintNodeId('atom', sha(bytes).slice(7, 47));
    const receipt: Record<string, unknown> = { version: 1, status: 'committed', expectedRevision: command.expectedRevision,
      resource: url, revision, bodyDigest: sha(bytes), contentType: 'application/json', pod: 'css', path: url,
      size: bytes.length, updatedAt: Date.now(), topUri: nativeUri, opaqueUri: nativeUri };
    if (url === scope.headUrl) {
      const loseAck = this.loseHeadAck; this.loseHeadAck = false;
      this.receiptTransform?.(receipt);
      if (this.afterHead) { const after = this.afterHead; this.afterHead = undefined; await after(); }
      if (loseAck) throw new Error('simulated dropped acknowledgement');
    }
    return new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json', ETag: '"' + revision + '-json"' } });
  };
  /** Create-if-absent per item, named by the digest of its bytes; identical bytes are confirmed, not rewritten. */
  private stageBatch(url: string, init: RequestInit | undefined): Response {
    expect(this.stageAvailable).toBe(true); // never sent to a server that did not advertise it
    expect(url).toBe(scope.artifactContainer); expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Content-Type')).toBe(NATIVE_STAGE_MEDIA_TYPE);
    const command = JSON.parse(String(init?.body)) as { version: number; items: Array<{ name: string; contentType: string; bodyBase64: string }> };
    expect(command.version).toBe(1); expect(command.items.length).toBeGreaterThan(0); expect(command.items.length).toBeLessThanOrEqual(64);
    this.batches.push(command.items.map(item => item.name));
    if (this.failBatch) return new Response(null, { status: 503 });
    const receipts = command.items.map(item => {
      const bytes = Buffer.from(item.bodyBase64, 'base64'), target = url + item.name, old = this.rows.get(target);
      expect(item.name).toMatch(new RegExp('^(artifact|commit)-' + sha(bytes).slice(7) + '\\.json$')); expect(item.contentType).toBe('application/json');
      if (old && !Buffer.from(old.bytes).equals(bytes)) throw new Error('model: a content-named resource changed');
      const revision = old?.revision ?? sha(target + ':' + (++this.sequence) + ':' + sha(bytes));
      if (!old) { this.rows.set(target, { bytes, revision }); this.writes.push({ url: target, body: bytes.toString('utf8') }); }
      return { name: item.name, status: 'staged', created: !old, revision, bodyDigest: sha(bytes), contentType: 'application/json', size: bytes.length } as Record<string, unknown>;
    });
    return new Response(JSON.stringify(this.batchTransform ? this.batchTransform(receipts) : { version: 1, receipts }), { headers: { 'Content-Type': 'application/json' } });
  }
  client(overrides: Partial<ConstructorParameters<typeof NativeCommitStore>[0]> = {}): NativeCommitStore {
    return new NativeCommitStore({ scope, fetch: this.fetch, senderKeyPair: bridge,
      ownerPublicKey: owner.publicKey, recipientPublicKeys: [owner.publicKey, bridge.publicKey], ...overrides });
  }
  headWrites(): number { return this.writes.filter(w => w.url === scope.headUrl).length; }
}
async function put(transport: NativeTransport, id: string, text = id) {
  const client = transport.client();
  return client.commit({ operationId: id, expected: await client.readHead(), changes: [{ key: 'statement:' + id, artifact: artifact(text) }] });
}
async function textAt(transport: NativeTransport, snapshot: Awaited<ReturnType<NativeCommitStore['readHead']>>, key: string): Promise<string> {
  const ref = snapshot.records.get(key); expect(ref).toBeDefined();
  return Buffer.from(readNativeByteArtifact(await transport.client().readArtifact(ref!)).bytes).toString();
}

/** Artificial network turns: nothing completes until the test releases one wave.
 * Head/backing-commit requests remain fresh and outside the index-node limiter. */
class IndexNetwork {
  active = 0;
  peak = 0;
  starts = 0;
  waves = 0;
  held: Array<() => void> = [];
  readonly fetch: typeof globalThis.fetch;
  constructor(readonly transport: NativeTransport,
    transform?: (response: Response, ordinal: number) => Promise<Response> | Response) {
    this.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET') !== 'GET' || !/\/artifact-[a-f0-9]{64}\.json$/.test(url)) return transport.fetch(input, init);
      const ordinal = ++this.starts; this.active++; this.peak = Math.max(this.peak, this.active);
      try {
        await new Promise<void>(resolve => { this.held.push(resolve); });
        const response = await transport.fetch(input, init);
        return transform ? await transform(response, ordinal) : response;
      } finally { this.active--; }
    };
  }
  async drive<T>(promise: Promise<T>): Promise<T> {
    // Attach the rejection handler immediately, before releasing any sibling.
    let done = false;
    const handled = promise.then(value => { done = true; return { ok: true as const, value }; },
      error => { done = true; return { ok: false as const, error }; });
    for (let turn = 0; !done && turn < 1000; turn++) {
      await new Promise<void>(resolve => { setImmediate(resolve); });
      const wave = this.held.splice(0);
      if (wave.length) { this.waves++; for (const release of wave) release(); }
    }
    expect(done, 'the bounded traversal must settle').toBe(true);
    const result = await handled;
    if (!result.ok) throw result.error;
    return result.value;
  }
}

describe('opt-in bounded full-index prefetch', () => {
  let seeded: NativeTransport;
  let expected: Awaited<ReturnType<NativeCommitStore['readHead']>>;
  beforeAll(async () => {
    seeded = new NativeTransport();
    const keys: string[] = [], shared = artifact('one shared encrypted payload');
    // Force both root fanout and another HAMT level, rather than relying on luck.
    let deep = 0, broad = 0;
    for (let i = 0; deep < 64 || broad < 64; i++) {
      const key = 'cold-index-' + i, first = sha('record:' + key).slice(7, 8);
      if (first === '0' && deep < 64) { keys.push(key); deep++; }
      else if (first !== '0' && broad < 64) { keys.push(key); broad++; }
    }
    const client = seeded.client();
    expected = (await client.commit({ operationId: 'cold-multilevel-index', expected: await client.readHead(),
      changes: keys.map(key => ({ key, artifact: shared })) })).snapshot;
    expect(expected.records.size).toBe(128);
  });
  function copy(): NativeTransport {
    const transport = new NativeTransport();
    for (const [url, row] of seeded.rows) transport.rows.set(url, { bytes: row.bytes.slice(), revision: row.revision });
    return transport;
  }

  it('uses fewer cold network turns with identical DFS order, snapshot and reference digests', async () => {
    const serial = new IndexNetwork(copy()), parallel = new IndexNetwork(copy());
    const serialEvents: NativeHeadReadDiagnostic[] = [], parallelEvents: NativeHeadReadDiagnostic[] = [];
    const one = await serial.drive(serial.transport.client({ fetch: serial.fetch, onHeadRead: event => serialEvents.push(event) }).readHead());
    const eight = await parallel.drive(parallel.transport.client({ fetch: parallel.fetch, indexReadConcurrency: 8,
      onHeadRead: event => parallelEvents.push(event) }).readHead());
    expect(one).toEqual(expected); expect(eight).toEqual(expected);
    expect([...eight.records]).toEqual([...one.records]);
    expect(serial.starts).toBe(parallel.starts); expect(serial.starts).toBeGreaterThan(20);
    expect(serial.peak).toBe(1); expect(parallel.peak).toBe(8);
    expect(parallel.waves).toBeLessThan(serial.waves / 2);
    expect(parallelEvents.at(-1)).toMatchObject({ operation: 0, event: 1, phase: 1, outcome: 1,
      indexNodes: parallel.starts, indexReadConcurrency: 8, peakIndexReads: 8 });
    const diagnostic = parallelEvents.at(-1)!;
    expect(diagnostic.indexBranches).toBeGreaterThan(1);
    expect(diagnostic.indexBranches + diagnostic.indexLeaves).toBe(diagnostic.indexNodes);
    expect(serialEvents.at(-1)?.indexNodes).toBe(diagnostic.indexNodes);
    for (const event of [...serialEvents, ...parallelEvents]) {
      expect(Object.isFrozen(event)).toBe(true);
      for (const value of Object.values(event)) expect(typeof value === 'number' && Number.isFinite(value) && value >= 0).toBe(true);
    }
    for (const transport of [serial.transport, parallel.transport]) {
      expect(transport.methods.filter(method => method === 'GET ' + scope.headUrl)).toHaveLength(1);
      expect(transport.methods.filter(method => method === 'GET ' + expected.reference!.commitUrl)).toHaveLength(1);
      expect(transport.writes).toEqual([]);
    }
  });

  it('shares eight permits across concurrent full heads without changing either result', async () => {
    const network = new IndexNetwork(copy()), client = network.transport.client({ fetch: network.fetch, indexReadConcurrency: 8 });
    const snapshots = await network.drive(Promise.all([client.readHead(), client.readHead()]));
    expect(snapshots).toEqual([expected, expected]);
    expect([...snapshots[0]!.records]).toEqual([...snapshots[1]!.records]);
    expect(network.peak).toBe(8); expect(network.active).toBe(0); expect(network.held).toEqual([]);
    expect(network.transport.methods.filter(method => method === 'GET ' + scope.headUrl)).toHaveLength(2);
    expect(network.transport.methods.filter(method => method === 'GET ' + expected.reference!.commitUrl)).toHaveLength(2);
  });

  it.each(['metadata', 'ciphertext'])('rejects speculative %s corruption, stops queued work and settles active siblings', async corruption => {
    const transport = copy();
    const network = new IndexNetwork(transport, (response, ordinal) => {
      if (ordinal === 3) {
        const headers = new Headers(response.headers);
        if (corruption === 'ciphertext') headers.set('Interego-Body-Digest', sha('{}'));
        return new Response('{}', { headers });
      }
      return response;
    });
    const events: NativeHeadReadDiagnostic[] = [];
    const client = transport.client({ fetch: network.fetch, indexReadConcurrency: 8, onHeadRead: event => events.push(event) });
    await expect(network.drive(client.readHead())).rejects.toThrow(corruption === 'metadata'
      ? 'Native read metadata is not bound to its representation.' : 'Committed native artifact is unavailable or changed.');
    const stoppedAt = network.starts;
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(network.starts).toBe(stoppedAt);
    expect(stoppedAt).toBeLessThan(17); // queued root siblings and descendants never all start
    expect(network.active).toBe(0); expect(network.held).toEqual([]);
    expect(events.at(-1)).toMatchObject({ event: 1, outcome: 2 });
    expect(transport.writes).toEqual([]);
  });

  it('handles an active sibling rejection after the first failure has stopped its queue', async () => {
    let releaseLate!: () => void, lateRejected = false;
    const stopped = new Promise<void>(resolve => { releaseLate = resolve; });
    const network = new IndexNetwork(copy(), async (response, ordinal) => {
      if (ordinal === 3) throw new Error('first transport failure');
      if (ordinal === 5) { await stopped; lateRejected = true; throw new Error('late active sibling failure'); }
      return response;
    });
    const client = network.transport.client({ fetch: network.fetch, indexReadConcurrency: 8 });
    const internal = client as unknown as { stopIndexReads(context: unknown, error?: unknown): void };
    const stop = internal.stopIndexReads.bind(client);
    vi.spyOn(internal, 'stopIndexReads').mockImplementation((context, error) => {
      stop(context, error); releaseLate(); // force the later rejection AFTER cancellation
    });
    await expect(network.drive(client.readHead())).rejects.toThrow('Native resource read is unavailable.');
    expect(lateRejected).toBe(true); expect(network.active).toBe(0); expect(network.held).toEqual([]);
    const stoppedAt = network.starts;
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(network.starts).toBe(stoppedAt); expect(stoppedAt).toBeLessThan(17);
  });

  it('does not cancel an unrelated concurrent head or leak permits after one head fails', async () => {
    const network = new IndexNetwork(copy(), (response, ordinal) => ordinal === 1
      ? new Response('{}', { headers: response.headers }) : response);
    const client = network.transport.client({ fetch: network.fetch, indexReadConcurrency: 8 });
    const results = await network.drive(Promise.allSettled([client.readHead(), client.readHead()]));
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: expected });
    expect(network.peak).toBeLessThanOrEqual(8); expect(network.active).toBe(0);
    expect(await network.drive(client.readHead())).toEqual(expected);
  });

  it.each(['duplicate', 'cycle', 'prefix'])('retains the %s guard during prefetched DFS consumption', async mode => {
    const transport = copy(), client = transport.client({ indexReadConcurrency: 8 });
    // Inject a decoded topology fault after each real cryptographic node read.
    // This targets the logical traversal guard, not a forged ciphertext fixture.
    type Node = { kind: 'branch'; children: Map<string, NativeArtifactReference> }
      | { kind: 'leaf'; entries: Map<string, NativeArtifactReference> };
    const internal = client as unknown as { indexNode(reference: NativeArtifactReference, prefix: string): Promise<Node> };
    const original = internal.indexNode.bind(client);
    vi.spyOn(internal, 'indexNode').mockImplementation(async (reference, prefix) => {
      const node = await original(reference, prefix);
      if (node.kind !== 'branch' || prefix !== '') return node;
      const children = new Map(node.children), entries = [...children];
      if (mode === 'cycle') children.set(entries[0]![0], reference);
      if (mode === 'duplicate') children.set(entries[1]![0], entries[0]![1]);
      if (mode === 'prefix') { children.set(entries[0]![0], entries[1]![1]); children.set(entries[1]![0], entries[0]![1]); }
      return { kind: 'branch', children };
    });
    await expect(client.readHead()).rejects.toThrow(mode === 'prefix'
      ? 'Native index leaf binding changed.' : 'Native index contains a cycle or duplicate branch.');
  });

  it('still refuses a corrupted immutable backing commit before any index fetch', async () => {
    const transport = copy(), row = transport.rows.get(expected.reference!.commitUrl)!;
    transport.rows.set(expected.reference!.commitUrl, { ...row, bytes: Buffer.from('{}') });
    const network = new IndexNetwork(transport);
    await expect(network.drive(transport.client({ fetch: network.fetch, indexReadConcurrency: 8 }).readHead())).rejects.toThrow();
    expect(network.starts).toBe(0);
  });

  it('keeps warm ciphertext reuse independent of plaintext validation and fresh head authority', async () => {
    const transport = copy(), client = transport.client({ indexReadConcurrency: 8, cacheImmutableReads: true });
    const internal = client as unknown as { decrypt(bytes: Uint8Array, expectedTop?: IRI): unknown };
    const decrypt = vi.spyOn(internal, 'decrypt');
    const first = await client.readHead(), coldDecryptions = decrypt.mock.calls.length;
    transport.methods.length = 0;
    (first.records as Map<string, NativeArtifactReference>).clear();
    const warm = await client.readHead();
    expect(warm).toEqual(expected); expect([...warm.records]).toEqual([...expected.records]);
    expect(decrypt.mock.calls.length - coldDecryptions).toBe(coldDecryptions);
    expect(transport.methods.filter(method => method.includes('/artifact-'))).toEqual([]);
    expect(transport.methods).toContain('GET ' + scope.headUrl);
    expect(transport.methods).toContain('GET ' + expected.reference!.commitUrl);
    const row = transport.rows.get(expected.reference!.commitUrl)!;
    transport.rows.set(expected.reference!.commitUrl, { ...row, bytes: Buffer.from('{}') });
    await expect(client.readHead()).rejects.toThrow();
  });

  it('uses the same bounded DFS for an authenticated historical snapshot', async () => {
    const transport = copy(), writer = transport.client();
    await writer.commit({ operationId: 'later-index-version', expected: await writer.readHead(),
      changes: [{ key: 'later-record', artifact: artifact('later') }], resultRecordKeys: [] });
    const events: NativeHeadReadDiagnostic[] = [], network = new IndexNetwork(transport);
    const client = transport.client({ indexReadConcurrency: 8, fetch: network.fetch, onHeadRead: event => events.push(event) });
    const historical = await network.drive(client.readSnapshotAt(expected.reference!));
    expect(historical).toEqual(expected); expect([...historical.records]).toEqual([...expected.records]);
    expect(events.at(-1)).toMatchObject({ operation: 1, event: 1, outcome: 1 });
    // The initial operation-receipt lookup remains serial; full materialization
    // shares eight permits and still validates every historical index node.
    expect(network.peak).toBe(8);
    expect(transport.methods).toContain('GET ' + expected.reference!.commitUrl);
  });

  it('keeps diagnostic observer failures outside the read authority, including rejected promises', async () => {
    for (const onHeadRead of [() => { throw new Error('observer sync'); }, () => Promise.reject(new Error('observer async'))]) {
      const transport = copy(), client = transport.client({ indexReadConcurrency: 8, onHeadRead });
      expect(await client.readHead()).toEqual(expected);
      await new Promise<void>(resolve => { setImmediate(resolve); });
    }
  });

  it('reports bounded numeric progress and completion without retaining an interval after failure', async () => {
    const events: NativeHeadReadDiagnostic[] = [], transport = copy();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.useFakeTimers();
    try {
      const read = transport.client({ indexReadConcurrency: 8, onHeadRead: event => events.push(event),
        fetch: async () => { await held; throw new Error('unavailable head'); } }).readHead();
      const failure = expect(read).rejects.toThrow('Native resource read is unavailable.');
      await vi.advanceTimersByTimeAsync(30 * 15000);
      expect(events).toHaveLength(24);
      expect(events.every(event => event.event === 0 && event.phase === 0 && event.outcome === 0 && event.indexNodes === 0)).toBe(true);
      release(); await failure;
      expect(events.at(-1)).toMatchObject({ event: 1, outcome: 2, phase: 0 });
      expect(vi.getTimerCount()).toBe(0);
      for (const event of events) expect(Object.values(event).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    } finally { release(); vi.useRealTimers(); }
  });

  it.each([0, -1, 1.5, 9, NaN, Infinity])('rejects invalid index-read concurrency %s before I/O', concurrency => {
    const transport = copy();
    expect(() => transport.client({ indexReadConcurrency: concurrency })).toThrow();
    expect(transport.methods).toEqual([]);
  });
});

describe('strict native encrypted PGSL commits', () => {
  it.each([false, true])('stages identical aliases once and verifies them after restart (lost acknowledgement: %s)', async loseAck => {
    const transport = new NativeTransport(), client = transport.client();
    transport.loseStageAck = loseAck;
    const result = await client.commit({ operationId: 'aliases', expected: await client.readHead(), changes: [
      { key: 'statement:one', artifact: artifact('one exact statement') },
      { key: 'query:one', artifact: artifact('one exact statement') },
    ] });
    const statement = result.snapshot.records.get('statement:one')!, query = result.snapshot.records.get('query:one')!;
    expect(query).toEqual(statement);
    expect(transport.writes.filter(write => write.url === statement.resourceUrl)).toHaveLength(1);
    expect(transport.writes).toHaveLength(4); // payload, index, immutable commit, authoritative head
    const restarted = await transport.client().readHead();
    expect(await textAt(transport, restarted, 'statement:one')).toBe('one exact statement');
    expect(await textAt(transport, restarted, 'query:one')).toBe('one exact statement');
    expect(result.resourceReceipt?.resource).toBe(scope.headUrl);
  });

  it('keeps equal content with different provenance in distinct encrypted resources', async () => {
    const transport = new NativeTransport(), client = transport.client(), first = artifact('same content'), second = artifact('same content');
    for (const [id, node] of second.pgsl.nodes) second.pgsl.nodes.set(id, {
      ...node, provenance: { ...node.provenance, generatedAtTime: '2026-10-16T00:00:00.000Z' },
    });
    expect(first.topUri).toBe(second.topUri);
    const result = await client.commit({ operationId: 'provenance', expected: await client.readHead(), changes: [
      { key: 'first', artifact: first }, { key: 'second', artifact: second },
    ] });
    const a = result.snapshot.records.get('first')!, b = result.snapshot.records.get('second')!;
    expect(a.plaintextDigest).not.toBe(b.plaintextDigest); expect(a.resourceUrl).not.toBe(b.resourceUrl);
    expect(await textAt(transport, result.snapshot, 'first')).toBe('same content');
    expect(await textAt(transport, result.snapshot, 'second')).toBe('same content');
  });

  it.each(['provenance', 'node-map'])('refuses caller %s changes before head publication and permits the original intent to retry', async mode => {
    const transport = new NativeTransport(), initial = await transport.client().readHead();
    const input = () => createNativeByteArtifact({ owner: scope.owner, contentType: 'application/octet-stream',
      bytes: Buffer.from('captured'), provenance: { ...provenance } });
    const first = input(), second = input(), changes = [{ key: 'first', artifact: first }, { key: 'second', artifact: second }];
    let changed = false;
    const client = transport.client({ fetch: async (url, init) => {
      if (!changed) {
        changed = true; changes[1]!.key = 'changed';
        const nested = second.pgsl.nodes.values().next().value!.provenance as { generatedAtTime: string };
        nested.generatedAtTime = '2026-10-20T00:00:00.000Z';
        if (mode === 'node-map') second.pgsl.nodes.clear();
      }
      return transport.fetch(url, init);
    } });
    await expect(client.commit({ operationId: 'captured', expected: initial, changes })).rejects.toThrow();
    expect(transport.headWrites()).toBe(0); expect((await transport.client().readHead()).records.size).toBe(0);
    const result = await client.commit({ operationId: 'captured', expected: initial, changes: [
      { key: 'first', artifact: input() }, { key: 'second', artifact: input() },
    ] });
    expect([...result.snapshot.records.keys()].sort()).toEqual(['first', 'second']);
    expect(result.snapshot.records.get('first')).toEqual(result.snapshot.records.get('second'));
    expect(await textAt(transport, result.snapshot, 'second')).toBe('captured');
    const before = transport.writes.length;
    const replay = await client.commit({ operationId: 'captured', expected: initial, changes: [
      { key: 'first', artifact: input() }, { key: 'second', artifact: input() },
    ] });
    expect(replay.replayed).toBe(true); expect(replay.head).toEqual(result.head); expect(transport.writes).toHaveLength(before);
  });

  it('captures record keys before I/O without retaining caller change objects', async () => {
    const transport = new NativeTransport(), initial = await transport.client().readHead();
    const changes = [{ key: 'first', artifact: artifact('same') }, { key: 'second', artifact: artifact('same') }];
    const client = transport.client({ fetch: async (url, init) => {
      changes[1]!.key = 'changed'; return transport.fetch(url, init);
    } });
    const result = await client.commit({ operationId: 'keys', expected: initial, changes });
    expect([...result.snapshot.records.keys()].sort()).toEqual(['first', 'second']);
    expect(result.snapshot.records.get('first')).toEqual(result.snapshot.records.get('second'));
  });

  it('refuses plaintext already beyond the existing encrypted-resource cap before I/O', async () => {
    const transport = new NativeTransport(), initial = await transport.client().readHead(); transport.methods.length = 0;
    const client = transport.client({ maxArtifactBytes: 1024 });
    await expect(client.commit({ operationId: 'oversized', expected: initial, changes: [
      { key: 'large', artifact: artifact('x'.repeat(2048)) },
    ] })).rejects.toThrow('capacity');
    expect(transport.methods).toHaveLength(0); expect(transport.writes).toHaveLength(0);
  });

  it('uses fresh randomized encryption for equal artifacts in a later commit', async () => {
    const transport = new NativeTransport(), client = transport.client();
    const changes = [{ key: 'first', artifact: artifact('same') }, { key: 'second', artifact: artifact('same') }];
    const first = await client.commit({ operationId: 'one', expected: await client.readHead(), changes });
    const second = await client.commit({ operationId: 'two', expected: await client.readHead(), changes });
    const a = first.snapshot.records.get('first')!, b = second.snapshot.records.get('first')!;
    expect(a.plaintextDigest).toBe(b.plaintextDigest); expect(a.resourceUrl).not.toBe(b.resourceUrl);
    expect(second.snapshot.records.get('second')).toEqual(b);
    expect(await textAt(transport, await client.readSnapshotAt(first.head), 'first')).toBe('same');
  });

  it('refuses alias publication when its first staged ciphertext cannot be verified', async () => {
    const transport = new NativeTransport(); let corrupted = false;
    const client = transport.client({ fetch: async (url, init) => {
      const response = await transport.fetch(url, init);
      if (!corrupted && init?.method === 'PUT' && String(url).includes('/artifact-')) {
        corrupted = true; const row = transport.rows.get(String(url))!;
        transport.rows.set(String(url), { ...row, bytes: Buffer.from('{}') });
      }
      return response;
    } });
    await expect(client.commit({ operationId: 'unverified', expected: await client.readHead(), changes: [
      { key: 'first', artifact: artifact('same') }, { key: 'second', artifact: artifact('same') },
    ] })).rejects.toThrow();
    expect(transport.writes).toHaveLength(1); expect(transport.headWrites()).toBe(0);
    expect((await transport.client().readHead()).records.size).toBe(0);
  });

  it('bounds and detaches selected coverage before I/O, including proven absence at an empty head', async () => {
    const transport = new NativeTransport(), client = transport.client();
    for (const keys of [new Array(1001).fill('x'), [''], ['bad\nkey'], [null], 'key']) {
      await expect(client.readHeadRecords(keys as readonly string[])).rejects.toThrow();
    }
    expect(transport.methods).toHaveLength(0);
    const keys = ['missing', 'a', 'missing'], pending = client.readHeadRecords(keys); keys.push('not-requested');
    const empty = await pending;
    expect(empty.selectedRecordKeys).toEqual(['a', 'missing']); expect(Object.isFrozen(empty.selectedRecordKeys)).toBe(true);
    expect(empty.revision).toBeNull(); expect(empty.records.size).toBe(0);
    expect((await client.readHead()).selectedRecordKeys).toBeUndefined();
  });

  it('anchors every selected path to one verified head even when another writer advances during the read', async () => {
    const transport = new NativeTransport(); await put(transport, 'first'); let advanced = false, heads = 0;
    const client = transport.client({ fetch: async (url, init) => {
      const response = await transport.fetch(url, init);
      if (String(url) === scope.headUrl && (init?.method ?? 'GET') === 'GET') {
        heads++; if (!advanced) { advanced = true; await put(transport, 'later'); }
      }
      return response;
    } });
    const selected = await client.readHeadRecords(['statement:first', 'statement:later']);
    expect(heads).toBe(1); expect(selected.records.has('statement:first')).toBe(true);
    expect(selected.records.has('statement:later')).toBe(false);
    expect(selected.revision).not.toBe((await transport.client().readHead()).revision);
  });

  it('selected proofs visit only requested paths and do not claim validation of unrelated branches', async () => {
    const transport = new NativeTransport(), client = transport.client();
    await client.commit({ operationId: 'wide-index', expected: await client.readHead(),
      changes: Array.from({ length: 96 }, (_, i) => ({ key: 'key-' + i, artifact: artifact('body-' + i) })), resultRecordKeys: [] });
    transport.methods.length = 0;
    const selected = await client.readHeadRecords(['key-0', 'absent']);
    const visited = new Set(transport.methods.filter(method => method.startsWith('GET ')).map(method => method.slice(4)));
    expect(selected.selectedRecordKeys).toEqual(['absent', 'key-0']); expect([...selected.records.keys()]).toEqual(['key-0']);
    const selectedReads = visited.size; transport.methods.length = 0;
    expect((await client.readHead()).records.size).toBe(96);
    const fullReads = new Set(transport.methods.filter(method => method.startsWith('GET ')).map(method => method.slice(4)));
    expect(fullReads.size).toBeGreaterThan(selectedReads * 2);
    const unvisited = [...fullReads].find(url => url.includes('/artifact-') && !visited.has(url))!;
    expect(unvisited).toBeDefined(); const old = transport.rows.get(unvisited)!;
    transport.rows.set(unvisited, { ...old, bytes: Buffer.from('{}') });
    expect((await client.readHeadRecords(['key-0', 'absent'])).records.size).toBe(1);
    await expect(client.readHead()).rejects.toThrow(); transport.rows.set(unvisited, old);
    const selectedPath = [...visited].filter(url => url.includes('/artifact-')).at(-1)!;
    transport.rows.set(selectedPath, { ...transport.rows.get(selectedPath)!, bytes: Buffer.from('{}') });
    await expect(client.readHeadRecords(['key-0', 'absent'])).rejects.toThrow();
  });

  it('selected commit results and historical replay retain exact coverage without enumerating unrelated records', async () => {
    const transport = new NativeTransport(), client = transport.client(), initial = await client.readHeadRecords(['one']);
    const keys = ['one', 'absent'], input = artifact('one');
    const pending = client.commit({ operationId: 'selected', expected: initial, changes: [{ key: 'one', artifact: input }], resultRecordKeys: keys });
    keys.push('not-requested'); const first = await pending;
    expect(first.snapshot.selectedRecordKeys).toEqual(['absent', 'one']); expect([...first.snapshot.records.keys()]).toEqual(['one']);
    await put(transport, 'later');
    const replay = await client.commit({ operationId: 'selected', expected: initial, changes: [{ key: 'one', artifact: input }], resultRecordKeys: ['one', 'statement:later'] });
    expect(replay.head).toEqual(first.head); expect(replay.replayed).toBe(true);
    expect(replay.snapshot.selectedRecordKeys).toEqual(['one', 'statement:later']); expect(replay.snapshot.records.has('statement:later')).toBe(false);
    expect((await client.readSnapshotAt(first.head)).selectedRecordKeys).toBeUndefined();
    const before = transport.writes.length;
    await expect(client.commit({ operationId: 'stale-selected', expected: first.snapshot, changes: [], resultRecordKeys: [] })).rejects.toBeInstanceOf(NativeCommitConflictError);
    expect(transport.writes.length).toBe(before);
  });

  it('selected result coverage survives lost acknowledgements, ancestor readback and an identical competing operation', async () => {
    for (const mode of ['lost-ack', 'ancestor', 'identical-competitor']) {
      const transport = new NativeTransport(), client = transport.client(), initial = await client.readHeadRecords(['own']);
      const changes = [{ key: 'own', artifact: artifact('own') }];
      if (mode === 'identical-competitor') transport.beforeHead = async () => {
        await transport.client().commit({ operationId: 'own', expected: initial, changes, resultRecordKeys: [] });
      };
      else {
        if (mode === 'lost-ack') transport.loseHeadAck = true;
        transport.afterHead = async () => { await put(transport, 'rival'); };
      }
      const result = await client.commit({ operationId: 'own', expected: initial, changes, resultRecordKeys: ['own', 'statement:rival'] });
      expect(result.snapshot.selectedRecordKeys).toEqual(['own', 'statement:rival']);
      expect([...result.snapshot.records.keys()]).toEqual(['own']);
      expect(result.replayed).toBe(mode !== 'ancestor');
      expect(await textAt(transport, result.snapshot, 'own')).toBe('own');
    }
  });

  it('discovers a missing native target without claiming write authority', async () => {
    const transport = new NativeTransport(); await transport.client().ready();
    expect(await transport.client().readHead()).toMatchObject({ revision: null, operationId: null });
    expect(transport.writes).toHaveLength(0);
    transport.optionsAvailable = false;
    await expect(put(transport, 'unsupported')).rejects.toThrow('unavailable');
    expect(transport.writes).toHaveLength(0);
  });

  it('accepts actual canonical base64 keys and requires both owner and stable reader', () => {
    const transport = new NativeTransport();
    expect(() => transport.client()).not.toThrow();
    expect(() => transport.client({ ownerPublicKey: 'a'.repeat(64) })).toThrow();
    expect(() => transport.client({ recipientPublicKeys: [bridge.publicKey] })).toThrow();
    expect(() => transport.client({ recipientPublicKeys: [owner.publicKey] })).toThrow();
    expect(() => transport.client({ scope: { ...scope, headUrl: 'https://evil.example/head.json' } })).toThrow();
  });

  it('preserves exact binary bytes, media type, owner and digest inside a native holon', () => {
    const bytes = new Uint8Array([0, 255, 1, 128, 0]);
    const input = createNativeByteArtifact({ owner: scope.owner, contentType: 'application/pdf', bytes, provenance });
    const read = readNativeByteArtifact({ topUri: input.topUri, nodes: input.pgsl.nodes });
    expect(read.owner).toBe(scope.owner); expect(read.contentType).toBe('application/pdf');
    expect([...read.bytes]).toEqual([...bytes]); expect(read.sha256).toBe(sha(bytes));
  });

  it('refuses incomplete closure before any writes', async () => {
    const transport = new NativeTransport(), client = transport.client(), input = artifact('complete');
    const top = input.pgsl.nodes.get(input.topUri)!;
    expect(top.kind).toBe('Fragment');
    if (top.kind !== 'Fragment') throw new Error('fixture');
    input.pgsl.nodes.delete(top.items[0]!);
    expect(() => validateNativeArtifact({ topUri: input.topUri, nodes: input.pgsl.nodes })).toThrow();
    await expect(client.commit({ operationId: 'bad', expected: await client.readHead(), changes: [{ key: 'bad', artifact: input }] })).rejects.toThrow();
    expect(transport.writes).toHaveLength(0);
  });

  it('rejects forged atom content even when the supplied top URI is unchanged', async () => {
    const transport = new NativeTransport(), client = transport.client(), input = artifact('original');
    const atom = [...input.pgsl.nodes.values()].find(node => node.kind === 'Atom')!;
    if (atom.kind !== 'Atom') throw new Error('fixture');
    input.pgsl.nodes.set(atom.uri, { ...atom, value: 'changed without readdressing' });
    await expect(client.commit({ operationId: 'forged', expected: await client.readHead(), changes: [{ key: 'forged', artifact: input }] }))
      .rejects.toThrow('content address');
    expect(transport.writes).toHaveLength(0);
  });

  it('validates fragment height and level-one constituent invariants', () => {
    const input = artifact('canonical heights'), top = input.pgsl.nodes.get(input.topUri)!;
    if (top.kind !== 'Fragment') throw new Error('fixture');
    input.pgsl.nodes.set(top.uri, { ...top, height: top.height + 1 });
    expect(() => validateNativeArtifact({ topUri: input.topUri, nodes: input.pgsl.nodes })).toThrow('constituents');
    input.pgsl.nodes.set(top.uri, top);
    const levelOne = [...input.pgsl.nodes.values()].find(node => node.kind === 'Fragment' && node.level === 1)!;
    if (levelOne.kind !== 'Fragment') throw new Error('fixture');
    input.pgsl.nodes.set(levelOne.uri, { ...levelOne, height: 2 });
    expect(() => validateNativeArtifact({ topUri: input.topUri, nodes: input.pgsl.nodes })).toThrow('level-one');
    input.pgsl.nodes.set(levelOne.uri, { ...levelOne, left: levelOne.uri });
    expect(() => validateNativeArtifact({ topUri: input.topUri, nodes: input.pgsl.nodes })).toThrow('level-one');
  });

  it('orders Unicode record keys without locale-dependent comparison for replay identity', async () => {
    const transport = new NativeTransport(), client = transport.client(), initial = await client.readHead();
    const changes = ['z', 'ä', 'A', 'a', '😀', 'e\u0301', 'é'].map(key => ({ key, artifact: artifact(key) }));
    const comparison = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('locale-sensitive comparison used'); });
    let first: Awaited<ReturnType<NativeCommitStore['commit']>> | undefined;
    let replay: Awaited<ReturnType<NativeCommitStore['commit']>> | undefined;
    try {
      first = await client.commit({ operationId: 'unicode', expected: initial, changes });
      replay = await client.commit({ operationId: 'unicode', expected: initial, changes: [...changes].reverse() });
    } finally { comparison.mockRestore(); }
    expect(replay?.head).toEqual(first?.head); expect(replay?.replayed).toBe(true);
    expect(transport.headWrites()).toBe(1);
  });

  it('requires the exact owner recipient set after a metadata-consistent ciphertext change', async () => {
    const transport = new NativeTransport(); await put(transport, 'recipient');
    const row = transport.rows.get(scope.headUrl)!;
    const envelope = JSON.parse(Buffer.from(row.bytes).toString()) as { wrappedKeys: Array<{ recipientPublicKey: string }> };
    envelope.wrappedKeys = envelope.wrappedKeys.filter(key => key.recipientPublicKey !== owner.publicKey);
    transport.rows.set(scope.headUrl, { bytes: Buffer.from(JSON.stringify(envelope)), revision: sha('recipient-tamper') });
    await expect(transport.client().readHead()).rejects.toThrow('recipient binding');
  });

  it('recovers an immutable write acknowledgement only through exact ciphertext readback', async () => {
    const transport = new NativeTransport(); transport.loseStageAck = true;
    const result = await put(transport, 'stage-recovery');
    expect(result.operationId).toBe('stage-recovery');
    expect(await textAt(transport, result.snapshot, 'statement:stage-recovery')).toBe('stage-recovery');
  });

  it('atomically publishes statement, attachment and registry with encrypted independently rooted closure', async () => {
    const transport = new NativeTransport(), client = transport.client();
    const result = await client.commit({ operationId: 'atomic', expected: await client.readHead(), changes: [
      { key: 'statement:one', artifact: artifact('private learner statement') },
      { key: 'attachment:one', artifact: artifact('private attachment') },
      { key: 'tenant:alice', artifact: artifact('private registry') },
    ] });
    expect(result.snapshot.records.size).toBe(3); expect(transport.headWrites()).toBe(1);
    expect(transport.writes.at(-1)?.url).toBe(scope.headUrl);
    expect(transport.writes.slice(0, -1).every(w => /\/(?:artifact|commit)-[a-f0-9]{64}\.json$/.test(w.url))).toBe(true);
    expect(transport.writes.every(w => !w.body.includes('private learner') && !w.body.includes('statement:one') && !w.body.includes('tenant:alice'))).toBe(true);
    const restarted = transport.client(), head = await restarted.readHead();
    expect(await textAt(transport, head, 'statement:one')).toBe('private learner statement');
    expect(result.resourceReceipt).toMatchObject({ pod: 'css', path: scope.headUrl, resource: scope.headUrl });
    expect(typeof result.resourceReceipt?.updatedAt).toBe('number');
    expect(transport.methods.some(m => m.startsWith('HEAD '))).toBe(false);
  });

  it('retains fixed immutable snapshots and survives updates, deletion and a new client', async () => {
    const transport = new NativeTransport(), first = await put(transport, 'first', 'old');
    const client = transport.client();
    await client.commit({ operationId: 'second', expected: await client.readHead(), changes: [
      { key: 'statement:first', artifact: null }, { key: 'statement:second', artifact: artifact('new') },
    ] });
    const historic = await transport.client().readSnapshotAt(first.head);
    expect(await textAt(transport, historic, 'statement:first')).toBe('old');
    expect((await client.readHead()).records.has('statement:first')).toBe(false);
    expect(transport.rows.has(first.head.commitUrl)).toBe(true);
    const forged: NativeSnapshotReference = { ...first.head, revision: sha('wrong revision') };
    await expect(client.readSnapshotAt(forged)).rejects.toThrow();
  });

  it('rejects a stale expected head before staging a different mutation', async () => {
    const transport = new NativeTransport(), client = transport.client(), stale = await client.readHead();
    await put(transport, 'winner'); const before = transport.writes.length;
    await expect(client.commit({ operationId: 'stale', expected: stale, changes: [{ key: 'stale', artifact: artifact('x') }] }))
      .rejects.toBeInstanceOf(NativeCommitConflictError);
    expect(transport.writes.length).toBe(before);
  });

  it('publishes only the winning mutation when another writer wins the final CAS', async () => {
    const transport = new NativeTransport(), client = transport.client(), initial = await client.readHead();
    let release = (): void => {}; let entered = (): void => {};
    const held = new Promise<void>(resolve => { release = resolve; }), atHead = new Promise<void>(resolve => { entered = resolve; });
    transport.beforeHead = async () => { entered(); await held; };
    const losing = client.commit({ operationId: 'loser', expected: initial, changes: [{ key: 'loser', artifact: artifact('loser') }] });
    // Attach the rejection observer before releasing the simulated competing transaction.
    const observed = expect(losing).rejects.toBeInstanceOf(NativeCommitConflictError);
    await atHead; await put(transport, 'winner'); release(); await observed;
    const head = await client.readHead();
    expect(head.records.has('loser')).toBe(false); expect(head.records.has('statement:winner')).toBe(true);
    expect(transport.headWrites()).toBe(1);
  });

  it('makes an empty authority-check mutation a real CAS', async () => {
    const transport = new NativeTransport(), client = transport.client();
    const first = await client.commit({ operationId: 'ready-one', expected: await client.readHead(), changes: [] });
    const second = await client.commit({ operationId: 'ready-two', expected: first.snapshot, changes: [] });
    expect(transport.headWrites()).toBe(2); expect(second.head.revision).not.toBe(first.head.revision);
    expect(second.snapshot.records.size).toBe(0);
  });

  it('recovers a lost acknowledgement through committed operation history after a rival advances', async () => {
    const transport = new NativeTransport(), client = transport.client(), initial = await client.readHead();
    transport.afterHead = async () => { await put(transport, 'rival'); };
    transport.loseHeadAck = true;
    const own = artifact('own intent');
    const result = await client.commit({ operationId: 'own', expected: initial, changes: [{ key: 'own', artifact: own }] });
    expect(result.operationId).toBe('own'); expect(result.replayed).toBe(true);
    expect(result.head.revision).not.toBe((await client.readHead()).revision);
    const before = transport.writes.length;
    const replay = await transport.client().commit({ operationId: 'own', expected: initial, changes: [{ key: 'own', artifact: own }] });
    expect(replay.head).toEqual(result.head); expect(transport.writes.length).toBe(before);
    expect(await textAt(transport, await client.readHead(), 'statement:rival')).toBe('rival');
  });

  it('binds operation replay to full canonical provenance, even with the same content-addressed top', async () => {
    const transport = new NativeTransport(), client = transport.client(), input = artifact('same');
    const empty = await client.readHead();
    await client.commit({ operationId: 'provenance', expected: empty, changes: [{ key: 'one', artifact: input }] });
    const changed = createNativeByteArtifact({ owner: scope.owner, contentType: 'application/octet-stream', bytes: Buffer.from('same'),
      provenance: { ...provenance, generatedAtTime: '2026-10-16T00:00:00.000Z' } });
    expect(changed.topUri).toBe(input.topUri);
    const before = transport.writes.length;
    await expect(client.commit({ operationId: 'provenance', expected: empty, changes: [{ key: 'one', artifact: changed }] }))
      .rejects.toMatchObject({ status: 409 });
    expect(transport.writes.length).toBe(before);
  });

  it.each(['resource', 'path', 'pod', 'bodyDigest', 'size', 'expectedRevision', 'updatedAt', 'topUri', 'opaqueUri'])(
    'rejects a successful but unbound native receipt field %s', async field => {
      const transport = new NativeTransport();
      transport.receiptTransform = receipt => { receipt[field] = field === 'size' ? -1 : field === 'updatedAt' ? '2026-10-15' : 'unbound'; };
      await expect(put(transport, 'bad-receipt')).rejects.toMatchObject({ status: 503 });
      expect(transport.methods.some(m => m.startsWith('HEAD '))).toBe(false);
    });

  it('does not acknowledge failed staging or failed native head commits', async () => {
    const stage = new NativeTransport(); stage.failStage = true;
    await expect(put(stage, 'stage-failure')).rejects.toThrow(); expect(stage.headWrites()).toBe(0);
    const head = new NativeTransport(); head.failHead = true;
    await expect(put(head, 'head-failure')).rejects.toThrow('uncertain'); expect(head.headWrites()).toBe(0);
    expect((await head.client().readHead()).records.size).toBe(0);
  });

  it('fails closed on corrupted read bytes, missing snapshot metadata and a wrong decryption key', async () => {
    const transport = new NativeTransport(); await put(transport, 'existing');
    transport.corruptHeadRead = true;
    await expect(transport.client().readHead()).rejects.toThrow(); transport.corruptHeadRead = false;
    transport.stripHeadDigest = true;
    await expect(transport.client().readHead()).rejects.toThrow('metadata'); transport.stripHeadDigest = false;
    await expect(transport.client({ senderKeyPair: { ...bridge, secretKey: other.secretKey } }).readHead()).rejects.toThrow('decrypt');
    const head = await transport.client().readHead(), ref = head.records.values().next().value!;
    await expect(transport.client().readArtifact({ ...ref, resourceUrl: 'https://evil.example/artifact.json' })).rejects.toThrow();
  });

  it('waits for the native head commit before resolving the operation', async () => {
    const transport = new NativeTransport(); let release = (): void => {}; let entered = (): void => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const atHead = new Promise<void>(resolve => { entered = resolve; });
    transport.beforeHead = async () => { entered(); await held; };
    let resolved = false; const pending = put(transport, 'pending').then(result => { resolved = true; return result; });
    await atHead; expect(resolved).toBe(false); expect(transport.headWrites()).toBe(0);
    release(); await pending; expect(resolved).toBe(true); expect(transport.headWrites()).toBe(1);
  });

  it('splits the immutable index and retains earlier operations without growing the head representation', async () => {
    const transport = new NativeTransport(), client = transport.client();
    const initial = await client.readHead(), first = artifact('first');
    const earliest = await client.commit({ operationId: 'earliest', expected: initial, changes: [{ key: 'first', artifact: first }] });
    const sizes = [transport.rows.get(scope.headUrl)!.bytes.length];
    for (let i = 0; i < 35; i++) {
      await client.commit({ operationId: 'history-' + i, expected: await client.readHead(), changes: [] });
      sizes.push(transport.rows.get(scope.headUrl)!.bytes.length);
    }
    expect(Math.max(...sizes)).toBeLessThan(100_000);
    const before = transport.writes.length;
    const replay = await transport.client().commit({ operationId: 'earliest', expected: initial, changes: [{ key: 'first', artifact: first }] });
    expect(replay.head).toEqual(earliest.head); expect(transport.writes.length).toBe(before);
    expect(await textAt(transport, await transport.client().readSnapshotAt(earliest.head), 'first')).toBe('first');
    expect(transport.methods.every(m => !m.startsWith('DELETE '))).toBe(true);
  }, 60_000);
});

describe('opt-in immutable native artifact reuse', () => {
  it('reuses verified ciphertext but returns independent decrypted node maps', async () => {
    const transport = new NativeTransport(), saved = await put(transport, 'cached', 'exact immutable content');
    const reference = saved.snapshot.records.get('statement:cached')!;
    const reader = transport.client({ cacheImmutableReads: true });
    transport.methods.length = 0;
    const first = await reader.readArtifact(reference);
    expect(Buffer.from(readNativeByteArtifact(first).bytes).toString()).toBe('exact immutable content');
    expect(transport.methods).toEqual(['GET ' + reference.resourceUrl]);
    (first.nodes as Map<IRI, unknown>).clear();
    const second = await reader.readArtifact(reference);
    expect(Buffer.from(readNativeByteArtifact(second).bytes).toString()).toBe('exact immutable content');
    expect(transport.methods).toEqual(['GET ' + reference.resourceUrl]);
    expect(second.nodes).not.toBe(first.nodes);
  });

  it('does not share cached authority or content across reader instances', async () => {
    const transport = new NativeTransport(), saved = await put(transport, 'private-cache');
    const reference = saved.snapshot.records.get('statement:private-cache')!;
    await transport.client({ cacheImmutableReads: true }).readArtifact(reference);
    transport.methods.length = 0;
    const restarted = transport.client({ cacheImmutableReads: true });
    await restarted.readArtifact(reference);
    expect(transport.methods).toEqual(['GET ' + reference.resourceUrl]);
    const denied = transport.client({ cacheImmutableReads: true, fetch: async () => new Response(null, { status: 403 }) });
    await expect(denied.readArtifact(reference)).rejects.toThrow('unreadable');
  });

  it('requires all reference bindings and does not retain a failed initial verification', async () => {
    const transport = new NativeTransport(), saved = await put(transport, 'verified-cache');
    const reference = saved.snapshot.records.get('statement:verified-cache')!;
    const reader = transport.client({ cacheImmutableReads: true });
    await expect(reader.readArtifact({ ...reference, plaintextDigest: sha('wrong plaintext') })).rejects.toThrow('plaintext binding');
    await expect(reader.readArtifact({ ...reference, topUri: mintNodeId('atom', 'd'.repeat(40)) })).rejects.toThrow();
    const original = transport.rows.get(reference.resourceUrl)!;
    transport.rows.set(reference.resourceUrl, { ...original, bytes: Buffer.from('{}') });
    transport.methods.length = 0;
    await expect(reader.readArtifact(reference)).rejects.toThrow('unavailable or changed');
    transport.rows.set(reference.resourceUrl, original);
    await reader.readArtifact(reference);
    expect(transport.methods).toEqual(['GET ' + reference.resourceUrl, 'GET ' + reference.resourceUrl]);
    transport.rows.set(reference.resourceUrl, { ...original, bytes: Buffer.from('{}') });
    await expect(transport.client({ cacheImmutableReads: true }).readArtifact(reference)).rejects.toThrow('unavailable or changed');
  });

  it('keeps head reads fresh while reusing exact immutable index artifacts', async () => {
    const transport = new NativeTransport(); await put(transport, 'head-one');
    const reader = transport.client({ cacheImmutableReads: true });
    transport.methods.length = 0;
    const first = await reader.readHead();
    const firstReads = [...transport.methods];
    const indexReads = firstReads.filter(method => method.includes('/artifact-'));
    expect(indexReads.length).toBeGreaterThan(0);
    transport.methods.length = 0;
    expect((await reader.readHead()).revision).toBe(first.revision);
    expect(transport.methods).toContain('GET ' + scope.headUrl);
    expect(transport.methods.filter(method => method.includes('/artifact-'))).toEqual([]);
    await put(transport, 'head-two');
    const changed = await reader.readHead();
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.records.has('statement:head-two')).toBe(true);
  });

  it('never substitutes a cached artifact for a required staging readback', async () => {
    const transport = new NativeTransport(); let corrupted = false;
    const client = transport.client({ cacheImmutableReads: true, fetch: async (url, init) => {
      const response = await transport.fetch(url, init);
      if (!corrupted && init?.method === 'PUT' && String(url).includes('/artifact-')) {
        corrupted = true;
        const row = transport.rows.get(String(url))!;
        transport.rows.set(String(url), { ...row, bytes: Buffer.from('{}') });
      }
      return response;
    } });
    await expect(client.commit({ operationId: 'staging-cache', expected: await client.readHead(),
      changes: [{ key: 'key', artifact: artifact('must read back') }] })).rejects.toThrow();
    expect(transport.headWrites()).toBe(0);
  });
});

describe('explicit bounded native rolling checkpoints', () => {
  const mediaTypes = [
    'application/vnd.interego.rolling-checkpoint+gzip',
    'application/vnd.interego.rolling-checkpoint-delta-v1+br',
  ];
  const checkpoint = (contentType: string, bytes = Buffer.from('opaque reviewed rolling history'), checkpointOwner = scope.owner) =>
    createNativeByteArtifact({ owner: checkpointOwner, contentType, bytes, provenance });

  it.each(mediaTypes)('round-trips exact bytes and MIME through encrypted scoped CAS: %s', async contentType => {
    const transport = new NativeTransport(), client = transport.client({ atomicCheckpoint: true });
    const bytes = Buffer.from([0, 1, 127, 128, 255]), input = checkpoint(contentType, bytes);
    const reserved = client.atomicCheckpointSize(input);
    expect(reserved).toBeGreaterThan(0); expect(reserved).toBeLessThanOrEqual(1024 * 1024);
    const committed = await client.commitAtomicCheckpoint(null, input, { maxEncryptedBytes: reserved });
    const restored = await transport.client({ atomicCheckpoint: true }).readAtomicCheckpoint();
    expect(restored.revision).toBe(committed.revision);
    const body = readNativeByteArtifact(restored.artifact!);
    expect(body.owner).toBe(scope.owner); expect(body.contentType).toBe(contentType);
    expect(Buffer.from(body.bytes)).toEqual(bytes);
    await expect(client.commitAtomicCheckpoint(null, input)).rejects.toBeInstanceOf(NativeCommitConflictError);
    expect(transport.headWrites()).toBe(1);
  });

  it.each(mediaTypes)('still requires explicit composition and exact owner: %s', async contentType => {
    const transport = new NativeTransport(), input = checkpoint(contentType);
    const ordinary = transport.client();
    expect(() => ordinary.atomicCheckpointSize(input)).toThrow('explicit composition');
    await expect(ordinary.commitAtomicCheckpoint(null, input)).rejects.toMatchObject({ status: 400 });
    const client = transport.client({ atomicCheckpoint: true });
    const foreign = checkpoint(contentType, undefined, 'did:web:mallory.example' as IRI);
    expect(() => client.atomicCheckpointSize(foreign)).toThrow('ownership or type');
    await expect(client.commitAtomicCheckpoint(null, foreign)).rejects.toMatchObject({ status: 400 });
    expect(transport.methods).toEqual([]);
  });

  it.each([
    'application/json', 'application/octet-stream',
    'application/vnd.interego.rolling-checkpoint+br',
    'application/vnd.interego.rolling-checkpoint-delta-v2+br',
    'application/vnd.interego.rolling-checkpoint-delta-v1+br; charset=utf-8',
  ])('rejects unreviewed checkpoint MIME before I/O: %s', async contentType => {
    const transport = new NativeTransport(), client = transport.client({ atomicCheckpoint: true }), input = checkpoint(contentType);
    expect(() => client.atomicCheckpointSize(input)).toThrow('ownership or type');
    await expect(client.commitAtomicCheckpoint(null, input)).rejects.toMatchObject({ status: 400 });
    expect(transport.methods).toEqual([]);
  });

  it.each(mediaTypes)('preserves the 1 MiB hard limit and per-write reservation: %s', async contentType => {
    const transport = new NativeTransport(), client = transport.client({ atomicCheckpoint: true });
    const input = checkpoint(contentType), size = client.atomicCheckpointSize(input);
    await expect(client.commitAtomicCheckpoint(null, input, { maxEncryptedBytes: size - 1 })).rejects.toMatchObject({ status: 413 });
    for (const maximum of [0, -1, 1.5, 1024 * 1024 + 1]) {
      await expect(client.commitAtomicCheckpoint(null, input, { maxEncryptedBytes: maximum })).rejects.toMatchObject({ status: 400 });
    }
    const oversized = checkpoint(contentType, Buffer.alloc(1024 * 1024));
    expect(() => client.atomicCheckpointSize(oversized)).toThrow('1 MiB storage budget');
    await expect(client.commitAtomicCheckpoint(null, oversized)).rejects.toMatchObject({ status: 413 });
    expect(transport.methods).toEqual([]);
    expect((await client.readAtomicCheckpoint()).revision).toBeNull();
  });

  it.each(mediaTypes)('rejects a checkpoint under a different artifact-container scope: %s', async contentType => {
    const transport = new NativeTransport(), client = transport.client({ atomicCheckpoint: true });
    await client.commitAtomicCheckpoint(null, checkpoint(contentType));
    const changed = transport.client({ atomicCheckpoint: true, scope: { ...scope, artifactContainer: scope.pod + 'other/' } });
    await expect(changed.readAtomicCheckpoint()).rejects.toThrow('scope changed');
    expect(transport.headWrites()).toBe(1);
  });
});

describe('native index reads at scale', () => {
  const RECORDS = 3000;
  let seeded: NativeTransport, total: number, complete: Awaited<ReturnType<NativeCommitStore['readHead']>>;
  const artifactGets = (transport: NativeTransport, from = 0): string[] => transport.methods.slice(from)
    .filter(method => /^GET .*\/artifact-[a-f0-9]{64}\.json$/.test(method)).map(method => method.slice(4));
  const copy = (): NativeTransport => {
    const transport = new NativeTransport();
    for (const [url, row] of seeded.rows) transport.rows.set(url, { bytes: Uint8Array.from(row.bytes), revision: row.revision });
    return transport;
  };
  beforeAll(async () => {
    seeded = new NativeTransport();
    const client = seeded.client({ indexNodeCacheEntries: 100_000 }), shared = artifact('same payload');
    for (let batch = 0; batch < RECORDS / 1000; batch++) {
      await client.commit({ operationId: 'seed-' + batch, expected: await client.readHeadRecords([]), resultRecordKeys: [],
        changes: Array.from({ length: 1000 }, (_, i) => ({ key: 'row:' + (batch * 1000 + i), artifact: shared })) });
    }
    const events: NativeHeadReadDiagnostic[] = [];
    complete = await copy().client({ onHeadRead: event => events.push(event) }).readHead();
    total = events.at(-1)!.indexNodes;
    expect(complete.records.size).toBe(RECORDS);
    expect(total).toBeGreaterThan(200);
  }, 120_000);

  it.each([0, 100_000])('writes one record without reading the whole index (node cache entries: %i)', async indexNodeCacheEntries => {
    const transport = copy(), client = transport.client({ indexNodeCacheEntries, indexReadConcurrency: 8 });
    const before = new Set(transport.rows.keys());
    const expected = await client.readHeadRecords(['row:new']);
    expect(expected.records.size).toBe(0);
    await client.commit({ operationId: 'one-write', expected, changes: [{ key: 'row:new', artifact: artifact('new') }], resultRecordKeys: ['row:new'] });
    // Index nodes that existed before this write and were fetched during it.
    const existingReads = artifactGets(transport).filter(url => before.has(url));
    expect(existingReads.length).toBeGreaterThan(0);
    expect(existingReads.length).toBeLessThanOrEqual(16);
    expect(existingReads.length).toBeLessThan(total / 10);
    if (indexNodeCacheEntries) expect(new Set(existingReads).size).toBe(existingReads.length);
    const after = await transport.client().readHead();
    expect(after.records.size).toBe(RECORDS + 1);
    expect(after.records.has('row:new')).toBe(true);
  }, 60_000);

  it('reuses verified index nodes for an unchanged head and still verifies that head on every read', async () => {
    const transport = copy(), client = transport.client({ indexNodeCacheEntries: 100_000, indexReadConcurrency: 8 });
    expect(await client.readHead()).toEqual(complete);
    expect(artifactGets(transport)).toHaveLength(total);
    const warm = transport.methods.length;
    const again = await client.readHead();
    expect(again).toEqual(complete);
    expect([...again.records]).toEqual([...complete.records]);
    // Callers get their own map: one caller cannot change what another reads.
    (again.records as Map<string, NativeArtifactReference>).clear();
    expect((await client.readHead()).records.size).toBe(RECORDS);
    expect(artifactGets(transport, warm)).toEqual([]);
    expect(transport.methods.slice(warm).filter(method => method === 'GET ' + scope.headUrl)).toHaveLength(2);
    expect(transport.methods.slice(warm).filter(method => method === 'GET ' + complete.reference!.commitUrl)).toHaveLength(2);
  }, 60_000);

  it('re-reads only the changed paths when another client moves the head', async () => {
    const transport = copy(), client = transport.client({ indexNodeCacheEntries: 100_000, indexReadConcurrency: 8 });
    await client.readHead();
    const writer = transport.client();
    await writer.commit({ operationId: 'elsewhere', expected: await writer.readHeadRecords([]), resultRecordKeys: [],
      changes: [{ key: 'row:elsewhere', artifact: artifact('elsewhere') }, { key: 'row:7', artifact: null }] });
    const moved = transport.methods.length;
    const changed = await client.readHead();
    const fetched = artifactGets(transport, moved);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.length).toBeLessThanOrEqual(12);
    expect(changed.revision).not.toBe(complete.revision);
    expect(changed).toEqual(await transport.client().readHead());
    expect(changed.records.has('row:elsewhere')).toBe(true);
    expect(changed.records.has('row:7')).toBe(false);
    expect(changed.records.size).toBe(RECORDS);
  }, 60_000);

  it('does not fetch the index again after its own commit', async () => {
    const transport = copy(), client = transport.client({ indexNodeCacheEntries: 100_000 });
    await client.readHead();
    await client.commit({ operationId: 'own', expected: await client.readHeadRecords([]), resultRecordKeys: [],
      changes: [{ key: 'row:own', artifact: artifact('own') }] });
    const committed = transport.methods.length;
    const own = await client.readHead();
    expect(artifactGets(transport, committed)).toEqual([]);
    expect(own).toEqual(await transport.client().readHead());
    expect(own.records.size).toBe(RECORDS + 1);
  }, 60_000);

  it('shares one fetch per index node between concurrent complete reads', async () => {
    const transport = copy(), client = transport.client({ indexNodeCacheEntries: 100_000, indexReadConcurrency: 8 });
    const snapshots = await Promise.all(Array.from({ length: 6 }, () => client.readHead()));
    for (const snapshot of snapshots) expect(snapshot).toEqual(complete);
    expect(artifactGets(transport)).toHaveLength(total);
    expect(new Set(artifactGets(transport)).size).toBe(total);
    expect(transport.methods.filter(method => method === 'GET ' + scope.headUrl)).toHaveLength(6);
  }, 60_000);

  it('keeps no failed or unverified node and verifies a node it has not seen', async () => {
    const transport = copy();
    let failures = 1, corrupt = false;
    const client = transport.client({ indexNodeCacheEntries: 100_000, fetch: async (input, init) => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET' && /\/artifact-/.test(url)) {
        if (failures-- > 0) return new Response(null, { status: 503 });
        if (corrupt) { corrupt = false; const response = await transport.fetch(input, init); return new Response('{}', { headers: response.headers }); }
      }
      return transport.fetch(input, init);
    } });
    await expect(client.readHead()).rejects.toThrow('Native resource is unreadable');
    expect(await client.readHead()).toEqual(complete);
    const writer = transport.client();
    await writer.commit({ operationId: 'unseen', expected: await writer.readHeadRecords([]), resultRecordKeys: [],
      changes: [{ key: 'row:unseen', artifact: artifact('unseen') }] });
    corrupt = true;
    await expect(client.readHead()).rejects.toThrow('Native read metadata is not bound to its representation.');
    expect((await client.readHead()).records.has('row:unseen')).toBe(true);
  }, 60_000);

  it('evicts least recently used nodes at its entry bound and rejects an invalid bound', async () => {
    const transport = copy(), client = transport.client({ indexNodeCacheEntries: 64 });
    expect(await client.readHead()).toEqual(complete);
    const warm = transport.methods.length;
    expect(await client.readHead()).toEqual(complete);
    // Too small to hold the index: correct, with most nodes fetched again.
    expect(artifactGets(transport, warm).length).toBeGreaterThan(total / 2);
    for (const indexNodeCacheEntries of [-1, 1.5, 4_000_001]) expect(() => transport.client({ indexNodeCacheEntries })).toThrow('Invalid native index node cache capacity.');
  }, 60_000);
});

describe('batched staging of a commit\'s immutable representations', () => {
  const stagingRequests = (transport: NativeTransport, from = 0): string[] => transport.methods.slice(from)
    .filter(m => !m.endsWith(' ' + scope.headUrl) && !m.startsWith('OPTIONS ') && !m.startsWith('GET '));
  const commitTwo = (client: NativeCommitStore, id: string) => client.readHead().then(expected => client.commit({ operationId: id, expected, changes: [
    { key: 'statement:' + id, artifact: artifact('statement ' + id) }, { key: 'state:' + id, artifact: artifact('state ' + id) },
  ] }));

  it('stages everything a commit refers to in one request, before the head, and reads none of it back', async () => {
    const transport = new NativeTransport(); transport.stageAvailable = true;
    const client = transport.client();
    await commitTwo(client, 'first');
    const from = transport.methods.length, result = await commitTwo(client, 'second');
    const during = transport.methods.slice(from), post = during.indexOf('POST ' + scope.artifactContainer);
    // Two records, the previous operation's record, the index leaf and the commit object: one request.
    expect(stagingRequests(transport, from)).toEqual(['POST ' + scope.artifactContainer]);
    expect(transport.batches.at(-1)).toHaveLength(5);
    expect(transport.batches.at(-1)!.filter(name => name.startsWith('commit-'))).toHaveLength(1);
    expect(post).toBeGreaterThan(-1); expect(post).toBeLessThan(during.indexOf('PUT ' + scope.headUrl));
    const staged = new Set(transport.batches.at(-1)!.map(name => scope.artifactContainer + name));
    expect(during.slice(0, during.indexOf('PUT ' + scope.headUrl)).filter(m => m.startsWith('GET ') && staged.has(m.slice(4)))).toEqual([]);
    // The head compare-and-set and its read-back are the same requests as without batching.
    expect(during.filter(m => m === 'PUT ' + scope.headUrl)).toHaveLength(1);
    expect(result.resourceReceipt?.resource).toBe(scope.headUrl);
    // A client that never batches reads exactly what was published.
    const reader = await transport.client({ stageIndividually: true }).readHead();
    expect(await textAt(transport, reader, 'statement:second')).toBe('statement second');
    expect(await textAt(transport, reader, 'state:first')).toBe('state first');
  });

  it('writes the same resources as individual staging, with far fewer requests', async () => {
    const batched = new NativeTransport(), individual = new NativeTransport(); batched.stageAvailable = true;
    for (const transport of [batched, individual]) { const client = transport.client(); await commitTwo(client, 'a'); await commitTwo(client, 'b'); }
    const kinds = (transport: NativeTransport): string[] => transport.writes.map(w => w.url === scope.headUrl ? 'head' : w.url.includes('/commit-') ? 'commit' : 'artifact').sort();
    expect(kinds(batched)).toEqual(kinds(individual));
    expect(stagingRequests(batched)).toHaveLength(2);
    expect(stagingRequests(individual).length).toBe(individual.writes.length - 2);
    expect(individual.methods.filter(m => m.startsWith('POST '))).toEqual([]);
  });

  it('stages individually when the server does not advertise it or the client opts out', async () => {
    const silent = new NativeTransport(); await commitTwo(silent.client(), 'silent');
    expect(silent.batches).toEqual([]);
    const declined = new NativeTransport(); declined.stageAvailable = true;
    await commitTwo(declined.client({ stageIndividually: true }), 'declined');
    expect(declined.batches).toEqual([]);
    expect(declined.methods.filter(m => m.startsWith('PUT ') && m.includes('/artifact-')).length).toBeGreaterThan(0);
  });

  it('falls back to a confirmed write and read-back of each representation when the batch is not answered', async () => {
    const transport = new NativeTransport(); transport.stageAvailable = true; transport.failBatch = true;
    const from = transport.methods.length, result = await commitTwo(transport.client(), 'fallback');
    expect(transport.batches).toHaveLength(1);
    const during = transport.methods.slice(from), head = during.indexOf('PUT ' + scope.headUrl);
    for (const name of transport.batches[0]!) {
      const put = during.indexOf('PUT ' + scope.artifactContainer + name), get = during.indexOf('GET ' + scope.artifactContainer + name, put);
      expect(put).toBeGreaterThan(-1); expect(get).toBeGreaterThan(put); expect(get).toBeLessThan(head);
    }
    expect(await textAt(transport, result.snapshot, 'statement:fallback')).toBe('statement fallback');
    // Nothing is staged and nothing confirms it: the head is not published.
    const dead = new NativeTransport(); dead.stageAvailable = true; dead.failBatch = true; dead.failStage = true;
    await expect(commitTwo(dead.client(), 'dead')).rejects.toThrow(); expect(dead.headWrites()).toBe(0);
  });

  it.each<[string, (receipts: Record<string, unknown>[]) => unknown]>([
    ['a receipt for different bytes', receipts => { receipts[1]!.bodyDigest = sha('other'); return { version: 1, receipts }; }],
    ['a receipt for another name', receipts => { receipts[0]!.name = receipts[1]!.name; return { version: 1, receipts }; }],
    ['a receipt with another size', receipts => { receipts[2]!.size = Number(receipts[2]!.size) + 1; return { version: 1, receipts }; }],
    ['a receipt that is not a confirmation', receipts => { receipts[0]!.status = 'pending'; return { version: 1, receipts }; }],
    ['a receipt without a native revision', receipts => { delete receipts[0]!.revision; return { version: 1, receipts }; }],
    ['a missing receipt', receipts => ({ version: 1, receipts: receipts.slice(1) })],
    ['an extra receipt', receipts => ({ version: 1, receipts: [...receipts, receipts[0]] })],
    ['reordered receipts', receipts => ({ version: 1, receipts: [...receipts].reverse() })],
    ['an unknown answer version', receipts => ({ version: 2, receipts })],
    ['an answer that is not receipts', () => ({ ok: true })],
  ])('does not publish a head after %s', async (_name, batchTransform) => {
    const transport = new NativeTransport(); transport.stageAvailable = true;
    const client = transport.client({ indexNodeCacheEntries: 1000 });
    await commitTwo(client, 'good');
    const head = transport.rows.get(scope.headUrl)!.revision;
    transport.batchTransform = batchTransform;
    await expect(commitTwo(client, 'refused')).rejects.toThrow(/staging/i);
    expect(transport.rows.get(scope.headUrl)!.revision).toBe(head); expect(transport.headWrites()).toBe(1);
    // Nothing from the refused commit was kept as verified: the same client still reads the published state.
    transport.batchTransform = undefined;
    const after = await client.readHead();
    expect([...after.records.keys()].sort()).toEqual(['state:good', 'statement:good']);
    expect(after).toEqual(await transport.client().readHead());
  });

  it('splits a large commit into bounded requests and confirms every one before the head', async () => {
    const transport = new NativeTransport(); transport.stageAvailable = true;
    const client = transport.client(), changes = Array.from({ length: 150 }, (_, i) => ({ key: 'row:' + i, artifact: artifact('row ' + i) }));
    const result = await client.commit({ operationId: 'large', expected: await client.readHead(), changes });
    expect(transport.batches.length).toBeGreaterThan(2);
    for (const batch of transport.batches) expect(batch.length).toBeLessThanOrEqual(64);
    const names = transport.batches.flat();
    expect(new Set(names).size).toBe(names.length);
    expect(transport.methods.lastIndexOf('POST ' + scope.artifactContainer)).toBeLessThan(transport.methods.indexOf('PUT ' + scope.headUrl));
    expect(result.snapshot.records.size).toBe(150);
    expect((await transport.client().readHead()).records.size).toBe(150);
    expect(transport.methods.filter(m => m.startsWith('PUT ') && !m.endsWith(scope.headUrl))).toEqual([]);
  }, 60_000);

  it('confirms identical representations that are already there and keeps replay and conflict handling', async () => {
    const transport = new NativeTransport(); transport.stageAvailable = true;
    const left = transport.client(), right = transport.client(), expected = await left.readHead();
    const won = await left.commit({ operationId: 'left', expected, changes: [{ key: 'k', artifact: artifact('left') }] });
    await expect(right.commit({ operationId: 'right', expected, changes: [{ key: 'k', artifact: artifact('right') }] })).rejects.toBeInstanceOf(NativeCommitConflictError);
    const writes = transport.writes.length;
    const replay = await right.commit({ operationId: 'left', expected, changes: [{ key: 'k', artifact: artifact('left') }] });
    expect(replay.replayed).toBe(true); expect(replay.head).toEqual(won.head); expect(transport.writes.length).toBe(writes);
    // A rival wins the head after this commit has staged: the staged batch is abandoned, the conflict surfaces.
    const stale = await left.readHead();
    transport.beforeHead = async () => { await right.commit({ operationId: 'rival', expected: await right.readHead(), changes: [{ key: 'r', artifact: artifact('rival') }] }); };
    await expect(left.commit({ operationId: 'loser', expected: stale, changes: [{ key: 'l', artifact: artifact('loser') }] })).rejects.toBeInstanceOf(NativeCommitConflictError);
    expect([...(await transport.client().readHead()).records.keys()].sort()).toEqual(['k', 'r']);
  });
});

describe('opt-in fewer round trips per commit', () => {
  // Index nodes are kept in both configurations, so the requests that differ are the ones these options remove.
  const indexed = { indexNodeCacheEntries: 10_000 } as const;
  const fast = { ...indexed, reuseBackingCommits: true, commitFromExpectedSnapshot: true, capabilityProbeTtlMs: 60_000 } as const;
  const write = async (client: NativeCommitStore, id: string) => client.commit({ operationId: id, expected: await client.readHeadRecords([]),
    resultRecordKeys: [], changes: [{ key: 'row:' + id, artifact: artifact(id) }] });
  const requests = (transport: NativeTransport, from: number): string[] => transport.methods.slice(from)
    .map(m => m.replace(/(artifact|commit)-[a-f0-9]{64}\.json$/, '$1')).map(m => m.replace(scope.headUrl, 'head').replace(scope.artifactContainer, ''));

  it('a steady write is one head read, one staging request, the head compare-and-set and its read-back', async () => {
    const transport = new NativeTransport(); transport.stageAvailable = true;
    const client = transport.client(fast);
    await write(client, 'one'); await write(client, 'two');
    const from = transport.methods.length; await write(client, 'three');
    expect(requests(transport, from)).toEqual(['GET head', 'POST ', 'PUT head', 'GET head']);
    // The same writes without the options: the probe, the second head read and both commit reads are there.
    const plain = new NativeTransport(); plain.stageAvailable = true;
    const slow = plain.client(indexed); await write(slow, 'one'); await write(slow, 'two');
    const before = plain.methods.length; await write(slow, 'three');
    expect(requests(plain, before)).toEqual(['GET head', 'GET commit', 'GET head', 'GET commit', 'OPTIONS head', 'POST ', 'PUT head', 'GET head']);
    expect([...(await plain.client().readHead()).records.keys()].sort()).toEqual([...(await transport.client().readHead()).records.keys()].sort());
  });

  it('still fetches and verifies the head on every read, and a commit object it has not seen', async () => {
    const transport = new NativeTransport(), client = transport.client(fast), other = transport.client();
    await write(client, 'mine');
    let from = transport.methods.length; await client.readHeadRecords([]);
    expect(requests(transport, from)).toEqual(['GET head']);
    await write(other, 'theirs');
    from = transport.methods.length; const seen = await client.readHead();
    expect(requests(transport, from).slice(0, 2)).toEqual(['GET head', 'GET commit']);
    expect([...seen.records.keys()].sort()).toEqual(['row:mine', 'row:theirs']);
    transport.corruptHeadRead = true;
    await expect(client.readHeadRecords([])).rejects.toThrow(); transport.corruptHeadRead = false;
  });

  it('refuses a kept commit object that does not match the head it is asked to back', async () => {
    const transport = new NativeTransport(), client = transport.client(fast);
    await write(client, 'first');
    const first = transport.rows.get(scope.headUrl)!;
    await write(client, 'second');
    // The pod now serves the earlier head's bytes under the head URL, with a new revision.
    transport.rows.set(scope.headUrl, { bytes: first.bytes, revision: sha('rolled-back') });
    const rolled = await client.readHeadRecords(['row:first', 'row:second']);
    // That earlier head is still backed by its own (kept) commit object, and is read as what it is.
    expect([...rolled.records.keys()]).toEqual(['row:first']);
    const forged = transport.rows.get(scope.headUrl)!.bytes.slice(); forged[forged.length - 20] = forged[forged.length - 20]! ^ 1;
    transport.rows.set(scope.headUrl, { bytes: forged, revision: sha('forged') });
    await expect(client.readHeadRecords([])).rejects.toThrow();
  });

  it('a head that moved since the expected snapshot is a conflict at the compare-and-set, and nothing is published', async () => {
    const transport = new NativeTransport(); transport.stageAvailable = true;
    const client = transport.client(fast), rival = transport.client();
    await write(client, 'base');
    const stale = await client.readHeadRecords([]);
    await write(rival, 'rival');
    const heads = transport.headWrites();
    await expect(client.commit({ operationId: 'late', expected: stale, changes: [{ key: 'row:late', artifact: artifact('late') }] }))
      .rejects.toBeInstanceOf(NativeCommitConflictError);
    expect(transport.headWrites()).toBe(heads);
    expect([...(await transport.client().readHead()).records.keys()].sort()).toEqual(['row:base', 'row:rival']);
    // Retrying from a fresh head commits, as a caller's conflict loop does.
    await client.commit({ operationId: 'late', expected: await client.readHeadRecords([]), changes: [{ key: 'row:late', artifact: artifact('late') }] });
    expect((await transport.client().readHead()).records.size).toBe(3);
  });

  it('replays an operation that committed after the expected snapshot, and keeps the content check', async () => {
    const transport = new NativeTransport(), client = transport.client(fast), rival = transport.client(fast);
    await write(client, 'base');
    const stale = await client.readHeadRecords([]), change = [{ key: 'row:once', artifact: artifact('once') }];
    const won = await rival.commit({ operationId: 'once', expected: await rival.readHeadRecords([]), changes: change });
    const heads = transport.headWrites();
    const replay = await client.commit({ operationId: 'once', expected: stale, changes: change });
    expect(replay.replayed).toBe(true); expect(replay.head).toEqual(won.head); expect(transport.headWrites()).toBe(heads);
    await expect(client.commit({ operationId: 'once', expected: await client.readHeadRecords([]), changes: [{ key: 'row:once', artifact: artifact('other') }] }))
      .rejects.toThrow('different content');
  });

  it('reads the head first for an expected snapshot it did not hand out, and by default', async () => {
    const transport = new NativeTransport(), client = transport.client(fast);
    await write(client, 'base');
    const copy = { ...(await client.readHeadRecords([])) };
    let from = transport.methods.length;
    await client.commit({ operationId: 'copy', expected: copy, changes: [] });
    expect(requests(transport, from)[0]).toBe('GET head');
    const stale = await client.readHeadRecords([]);
    await write(transport.client(), 'rival');
    from = transport.writes.length;
    await expect(transport.client().commit({ operationId: 'default', expected: stale, changes: [{ key: 'k', artifact: artifact('v') }] }))
      .rejects.toBeInstanceOf(NativeCommitConflictError);
    expect(transport.writes.length).toBe(from); // refused before staging, as before
  });

  it('probes again after the period, on ready(), and when the last probe failed; a vanished capability refuses the commit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const transport = new NativeTransport(), client = transport.client(fast);
      const probes = (): number => transport.methods.filter(m => m.startsWith('OPTIONS ')).length;
      await write(client, 'a'); await write(client, 'b'); expect(probes()).toBe(1);
      await client.ready(); expect(probes()).toBe(2);
      vi.setSystemTime(Date.now() + 60_001);
      await write(client, 'c'); expect(probes()).toBe(3);
      vi.setSystemTime(Date.now() + 60_001); transport.optionsAvailable = false;
      await expect(write(client, 'd')).rejects.toThrow('unavailable'); expect(probes()).toBe(4);
      transport.optionsAvailable = true;
      await write(client, 'd'); expect(probes()).toBe(5);
      expect(() => transport.client({ capabilityProbeTtlMs: -1 })).toThrow('probe period');
      expect(() => transport.client({ capabilityProbeTtlMs: 3_600_001 })).toThrow('probe period');
    } finally { vi.useRealTimers(); }
  });
});

describe('opt-in compact index nodes', () => {
  const compact = { compactIndexNodes: true } as const;
  const fill = async (client: NativeCommitStore, prefix: string, count: number) => client.commit({ operationId: prefix, expected: await client.readHead(),
    changes: Array.from({ length: count }, (_, i) => ({ key: prefix + ':' + i, artifact: artifact(prefix + ' ' + i) })) });
  /** Decrypted artifacts under the current head that are index nodes, with the tag of their top tuple. */
  const indexBytes = (transport: NativeTransport, from: number): number => transport.writes.slice(from)
    .filter(w => w.url.includes('/artifact-')).reduce((sum, w) => sum + w.body.length, 0);

  it('holds the same index in a small fraction of the bytes, and reads back identically', async () => {
    const wide = new NativeTransport(), small = new NativeTransport();
    await fill(wide.client(), 'row', 60); await fill(small.client(compact), 'row', 60);
    const wideOne = wide.writes.length, smallOne = small.writes.length;
    await wide.client().commit({ operationId: 'one', expected: await wide.client().readHead(), changes: [{ key: 'one', artifact: artifact('one') }] });
    await small.client(compact).commit({ operationId: 'one', expected: await small.client(compact).readHead(), changes: [{ key: 'one', artifact: artifact('one') }] });
    // One more record: the same number of resources either way, a fraction of the bytes.
    expect(small.writes.length - smallOne).toBe(wide.writes.length - wideOne);
    expect(indexBytes(small, smallOne) * 5).toBeLessThan(indexBytes(wide, wideOne));
    const a = await wide.client().readHead(), b = await small.client(compact).readHead();
    expect([...b.records.keys()].sort()).toEqual([...a.records.keys()].sort());
    for (const key of ['row:0', 'row:59', 'one']) expect(await textAt(small, b, key)).toBe(await textAt(wide, a, key));
  }, 60_000);

  it('is read by a client without the option, and both kinds of writer extend one head', async () => {
    const transport = new NativeTransport(), plain = transport.client(), small = transport.client(compact);
    await fill(plain, 'wide', 40);
    await fill(small, 'compact', 40);
    await fill(plain, 'again', 40);
    await small.commit({ operationId: 'del', expected: await small.readHead(), changes: [{ key: 'wide:3', artifact: null }] });
    for (const reader of [transport.client(), transport.client(compact), transport.client({ ...compact, indexNodeCacheEntries: 10_000, indexReadConcurrency: 8 })]) {
      const head = await reader.readHead();
      expect(head.records.size).toBe(119);
      expect(await textAt(transport, head, 'compact:17')).toBe('compact 17');
      expect(await textAt(transport, head, 'again:39')).toBe('again 39');
      expect(head.records.has('wide:3')).toBe(false);
      const selected = await reader.readHeadRecords(['wide:0', 'compact:1', 'missing']);
      expect([...selected.records.keys()].sort()).toEqual(['compact:1', 'wide:0']);
    }
    // History written by either kind stays reachable.
    const first = await transport.client(compact).commit({ operationId: 'wide', expected: await small.readHead(), changes: Array.from({ length: 40 }, (_, i) => ({ key: 'wide:' + i, artifact: artifact('wide ' + i) })) });
    expect(first.replayed).toBe(true);
  }, 60_000);

  it('refuses a compact node that is not the canonical encoding of well-formed references', async () => {
    const transport = new NativeTransport(), small = transport.client(compact);
    await fill(small, 'row', 3);
    const head = await small.readHead(), sample = head.records.get('row:0')!;
    const entry = (key: string, over: Partial<NativeArtifactReference> = {}) => { const r = { ...sample, ...over }; return [key, r.resourceUrl, r.bodyDigest, r.plaintextDigest, r.topUri]; };
    const forged = async (payload: string, owner = scope.owner, contentType = 'application/vnd.interego.native-index-node+json'): Promise<unknown> => {
      const node = createNativeByteArtifact({ owner, contentType, bytes: Buffer.from(payload), provenance });
      const staged = await small.commit({ operationId: 'forge-' + sha(payload + owner + contentType).slice(7, 20), expected: await small.readHead(), changes: [{ key: 'forged', artifact: node }] });
      const reference = staged.snapshot.records.get('forged')!;
      // The staged artifact stands in for an index node a hostile pod serves under a head.
      return (small as unknown as { readIndexNode(r: NativeArtifactReference, prefix: string): Promise<unknown> }).readIndexNode(reference, '');
    };
    const good = JSON.stringify({ entries: [entry('record:row:0')], kind: 'leaf' });
    await expect(forged(good)).resolves.toMatchObject({ kind: 'leaf' });
    await expect(forged(JSON.stringify({ kind: 'leaf', entries: [entry('record:row:0')] }))).rejects.toThrow('canonical');
    await expect(forged(good + ' ')).rejects.toThrow('canonical');
    await expect(forged(JSON.stringify({ entries: [entry('b'), entry('a')], kind: 'leaf' }))).rejects.toThrow('canonical');
    await expect(forged(JSON.stringify({ entries: [entry('a'), entry('a')], kind: 'leaf' }))).rejects.toThrow();
    await expect(forged(JSON.stringify({ entries: [], kind: 'leaf' }))).rejects.toThrow('fanout');
    await expect(forged(JSON.stringify({ entries: Array.from({ length: 17 }, (_, i) => entry('k' + String(i).padStart(2, '0'))), kind: 'leaf' }))).rejects.toThrow('fanout');
    await expect(forged(JSON.stringify({ entries: [entry('a')], kind: 'root' }))).rejects.toThrow();
    await expect(forged(JSON.stringify({ entries: [entry('a')], extra: 1, kind: 'leaf' }))).rejects.toThrow();
    await expect(forged(JSON.stringify({ entries: [['a', sample.resourceUrl]], kind: 'leaf' }))).rejects.toThrow('malformed');
    await expect(forged(JSON.stringify({ entries: [entry('a', { resourceUrl: 'https://evil.example/artifact-' + 'a'.repeat(64) + '.json' })], kind: 'leaf' }))).rejects.toThrow();
    await expect(forged(JSON.stringify({ entries: [entry('a', { bodyDigest: 'sha256:' + '0'.repeat(64) })], kind: 'leaf' }))).rejects.toThrow('content bound');
    await expect(forged(JSON.stringify({ entries: [entry('zz')], kind: 'branch' }))).rejects.toThrow('branch binding');
    await expect(forged(good, 'did:web:someone-else.example' as IRI)).rejects.toThrow('owner or type');
    await expect(forged(good, scope.owner, 'application/json')).rejects.toThrow('owner or type');
    await expect(forged('not json')).rejects.toThrow('malformed');
    // A leaf entry outside the hash prefix it is read under is refused, as in the wide form.
    const reference = (await small.commit({ operationId: 'prefix', expected: await small.readHead(), changes: [{ key: 'p', artifact: createNativeByteArtifact({ owner: scope.owner,
      contentType: 'application/vnd.interego.native-index-node+json', bytes: Buffer.from(good), provenance }) }] })).snapshot.records.get('p')!;
    const wrongPrefix = createHash('sha256').update('record:row:0').digest('hex')[0] === '0' ? '1' : '0';
    await expect((small as unknown as { readIndexNode(r: NativeArtifactReference, prefix: string): Promise<unknown> }).readIndexNode(reference, wrongPrefix)).rejects.toThrow('leaf binding');
  }, 60_000);

  it('works with batched staging, the node cache and the fewer-round-trip options together', async () => {
    const transport = new NativeTransport(); transport.stageAvailable = true;
    const client = transport.client({ ...compact, indexNodeCacheEntries: 10_000, reuseBackingCommits: true, commitFromExpectedSnapshot: true, capabilityProbeTtlMs: 60_000 });
    await fill(client, 'row', 150);
    for (const id of ['a', 'b', 'c']) await client.commit({ operationId: id, expected: await client.readHeadRecords([]), resultRecordKeys: [], changes: [{ key: id, artifact: artifact(id) }] });
    const head = await transport.client().readHead();
    expect(head.records.size).toBe(153);
    expect(await textAt(transport, head, 'row:149')).toBe('row 149');
    expect(transport.methods.filter(m => m.startsWith('PUT ') && !m.endsWith(scope.headUrl))).toEqual([]);
  }, 60_000);
});
