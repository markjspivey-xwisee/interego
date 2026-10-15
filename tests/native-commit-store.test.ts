import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { deriveEncryptionKeyPair, mintNodeId, type IRI } from '@interego/core';
import {
  NativeCommitStore, NativeCommitConflictError, NATIVE_COMMIT_MEDIA_TYPE,
  createNativeByteArtifact, readNativeByteArtifact, validateNativeArtifact,
  type NativeArtifactInput, type NativeCommitScope, type NativeSnapshotReference,
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
      ? { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1' } : {} });
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

describe('strict native encrypted PGSL commits', () => {
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
