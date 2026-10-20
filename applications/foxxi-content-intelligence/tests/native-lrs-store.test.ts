import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NativeCommitStore, NativeCommitConflictError, NATIVE_COMMIT_MEDIA_TYPE, createNativeByteArtifact, validateNativeArtifact,
  type NativeArtifact, type NativeArtifactReference, type NativeCommitClient,
  type NativeCommitReceipt, type NativeCommitRequest, type NativeCommitScope,
  type NativeSnapshot, type NativeSnapshotReference,
} from '@interego/pgsl';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { openStore, InMemoryFdb, CodecRegistry, LdpStore } from '../../../packages/pgsl-store/src/index.js';
import { NATIVE_CSS_FIXTURE_CAPABILITY, startNativeCssFixture, type NativeCssFixture } from './support/native-css-fixture.js';
import { NativeInteregoLrsDatabase, InvalidLrsQueryError } from '../src/native-lrs-store.js';
import { ConflictError, assertLrsPrimaryConfiguration, configuredLrsBackend, createConfiguredNativeLrsDatabase, type StoredStatement } from '../src/statement-store.js';

const owner = 'did:web:native-lrs.test:service' as IRI;
const scope: NativeCommitScope = { pod: 'https://pod.test/service/', headUrl: 'https://pod.test/service/head', artifactContainer: 'https://pod.test/service/artifacts/', owner };
const secret = 'synthetic-native-lrs-cursor-secret-000000001';
const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex');
interface TestPrimary {
  head: NativeSnapshot;
  histories: Map<string, NativeSnapshot>;
  artifacts: Map<string, NativeArtifact>;
}
function primary(): TestPrimary {
  return { head: { scope, revision: null, reference: null, operationId: null, records: new Map() }, histories: new Map(), artifacts: new Map() };
}
/** Adapter-level unit seam. Real encryption/CSS/engine recovery is tested separately. */
class TestNativeClient implements NativeCommitClient {
  beforeCommit?: (request: NativeCommitRequest) => Promise<void>;
  beforeSelection?: (keys: readonly string[]) => Promise<void>;
  transformSelection?: (head: NativeSnapshot, keys: readonly string[]) => NativeSnapshot;
  readyFailure = false;
  readFailures = false;
  forbidFullReads = false;
  fullReads = 0;
  selectedReads: string[][] = [];
  artifactReads: string[] = [];
  blockedArtifactReads = new Set<string>();
  commits: NativeCommitRequest[] = [];
  historicalReads = 0;
  constructor(readonly storage = primary()) {}
  async ready(): Promise<void> { if (this.readyFailure) throw new Error('native media unavailable'); }
  async readHead(): Promise<NativeSnapshot> {
    this.fullReads++;
    if (this.readFailures) throw new Error('native head unreadable');
    if (this.forbidFullReads) throw new Error('unexpected full native index scan');
    return this.storage.head;
  }
  async readHeadRecords(keys: readonly string[]): Promise<NativeSnapshot> {
    this.selectedReads.push([...keys]);
    if (this.readFailures) throw new Error('native head unreadable');
    await this.beforeSelection?.(keys);
    const records = new Map([...this.storage.head.records].filter(([key]) => keys.includes(key)));
    const snapshot = { ...this.storage.head, records, selectedRecordKeys: [...keys] };
    return this.transformSelection?.(snapshot, keys) ?? snapshot;
  }
  async readSnapshotAt(ref: NativeSnapshotReference): Promise<NativeSnapshot> {
    this.historicalReads++;
    const head = this.storage.histories.get(ref.commitUrl);
    if (!head || head.reference?.revision !== ref.revision || head.reference.topUri !== ref.topUri) throw new Error('historical native head unavailable');
    return head;
  }
  async readArtifact(ref: NativeArtifactReference): Promise<NativeArtifact> {
    this.artifactReads.push(ref.resourceUrl);
    if (this.readFailures) throw new Error('native artifact unavailable');
    if (this.blockedArtifactReads.has(ref.resourceUrl)) throw new Error('unrelated artifact must not be fetched');
    const value = this.storage.artifacts.get(ref.resourceUrl);
    if (!value) throw new Error('native artifact missing');
    return validateNativeArtifact(value);
  }
  async commit(request: NativeCommitRequest): Promise<NativeCommitReceipt> {
    this.commits.push(request);
    await this.beforeCommit?.(request);
    if (request.expected.revision !== this.storage.head.revision) throw new NativeCommitConflictError();
    // A selected expected snapshot proves a revision, not the complete map.
    // Native CAS changes that durable head without discarding unselected paths.
    const records = new Map(this.storage.head.records);
    for (const change of request.changes) {
      if (!change.artifact) { records.delete(change.key); continue; }
      const artifact = validateNativeArtifact({ topUri: change.artifact.topUri, nodes: change.artifact.pgsl.nodes });
      const plaintextDigest = hash(JSON.stringify([...artifact.nodes].sort(([a], [b]) => a.localeCompare(b))));
      const resourceUrl = scope.artifactContainer + randomUUID();
      this.storage.artifacts.set(resourceUrl, artifact);
      records.set(change.key, { resourceUrl, bodyDigest: hash(resourceUrl), plaintextDigest, topUri: artifact.topUri });
    }
    const revision = hash(randomUUID()), topUri = ('urn:test:head:' + randomUUID()) as IRI;
    const reference = { revision, topUri, commitUrl: scope.artifactContainer + randomUUID() };
    const snapshot: NativeSnapshot = { scope, revision, reference, operationId: request.operationId, records };
    const previousHead = this.storage.head.reference;
    this.storage.head = snapshot; this.storage.histories.set(reference.commitUrl, snapshot);
    const resultSnapshot = request.resultRecordKeys === undefined ? snapshot : {
      ...snapshot, selectedRecordKeys: [...request.resultRecordKeys],
      records: new Map([...snapshot.records].filter(([key]) => request.resultRecordKeys!.includes(key))),
    };
    return { scope, operationId: request.operationId, previousHead, head: reference, createdAt: new Date().toISOString(), replayed: false, snapshot: resultSnapshot, resourceReceipt: null };
  }
}
const database = (client: NativeCommitClient, options: { allowClear?: boolean; now?: () => number } = {}) =>
  new NativeInteregoLrsDatabase({ client, owner, scopeIdentity: JSON.stringify(scope), cursorSecret: secret, ...options });
const record = (id = randomUUID(), stored = '2026-10-15T10:00:00.000Z', registration?: string): StoredStatement => ({
  id, stored, voided: false,
  statement: { id, actor: { mbox: 'mailto:synthetic-learner@example.test' },
    verb: { id: 'http://adlnet.gov/expapi/verbs/completed' }, object: { id: 'https://example.test/course' }, stored,
    authority: { account: { homePage: 'https://example.test', name: 'synthetic-lrs' } },
    ...(registration ? { context: { registration } } : {}) },
});
const voider = (target: string): StoredStatement => {
  const value = record();
  value.statement.verb = { id: 'http://adlnet.gov/expapi/verbs/voided' };
  value.statement.object = { objectType: 'StatementRef', id: target };
  return value;
};

describe('native Interego xAPI artifact adapter', () => {
  it('requires native production configuration and never derives a SQL or memory primary', () => {
    expect(configuredLrsBackend({ NODE_ENV: 'production', DATABASE_URL: 'postgres://unused' })).toBe('interego');
    expect(() => assertLrsPrimaryConfiguration({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'memory' })).toThrow(/interego/);
    expect(() => assertLrsPrimaryConfiguration({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'postgres', DATABASE_URL: 'postgres://unused' })).toThrow();
    expect(() => assertLrsPrimaryConfiguration({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'interego' })).toThrow(/native pod/);
  });
  it('fails closed on native discovery, unreadable heads and rejected commits', async () => {
    const client = new TestNativeClient(); client.readyFailure = true;
    const db = database(client), store = db.forTenant('alice');
    await expect(store.put(record())).rejects.toThrow(/native media/);
    expect(client.storage.head.records.size).toBe(0);
    await store.putBatchWithAttachments([], new Map());
    expect(client.storage.head.records.size).toBe(0);
    client.readyFailure = false; client.readFailures = true;
    await expect(db.ready()).rejects.toThrow(/unreadable/);
    client.readFailures = false;
    await db.ready();
    client.beforeCommit = async request => { if (request.changes.length) throw new Error('private synthetic transport failure'); };
    await expect(store.put(record())).rejects.toThrow(/transport failure/);
    expect(await store.count()).toBe(0);
    expect(await db.listTenants()).toEqual([]);
    let conflicts = 0;
    client.beforeCommit = async request => { if (request.changes.length) { conflicts++; throw new NativeCommitConflictError(); } };
    await expect(store.put(record())).rejects.toThrow('native LRS commit contention limit reached');
    expect(conflicts).toBe(8);
    expect(await store.count()).toBe(0);
  });
  it('acknowledges only after the native commit and registers the tenant in that same commit', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    await db.ready();
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    client.beforeCommit = async request => { if (request.changes.length) { entered(); await gate; } };
    const value = record(); let acknowledged = false;
    const pending = store.put(value).then(() => { acknowledged = true; });
    await waiting;
    expect(acknowledged).toBe(false); expect(await store.get(value.id)).toBeNull(); expect(await db.listTenants()).toEqual([]);
    release(); await pending;
    expect(await store.get(value.id)).toEqual(value); expect(await db.listTenants()).toEqual(['alice']);
    const restarted = database(new TestNativeClient(client.storage));
    expect(await restarted.forTenant('alice').get(value.id)).toEqual(value);
    expect(await restarted.listTenants()).toEqual(['alice']);
  });
  it('keeps point writes, statement reads and resource reads on selected paths without fetching another tenant', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const unrelated = record();
    await db.forTenant('bob').put(unrelated);
    await db.forTenant('bob').putResource('state', 'private', { private: true });
    const unrelatedEntries = [...client.storage.head.records].filter(([key]) => key.startsWith(db.prefix('bob')));
    for (const [, reference] of unrelatedEntries) client.blockedArtifactReads.add(reference.resourceUrl);
    const fullReadsBefore = client.fullReads;
    client.selectedReads = []; client.artifactReads = []; client.commits = []; client.forbidFullReads = true;

    const first = record(), second = record();
    await store.putBatchWithAttachments([first, second], new Map());
    expect(await store.get(first.id)).toEqual(first);
    expect(await store.get(randomUUID())).toBeNull();
    await store.putResource('state', 'settings', { version: 1 });
    expect(await store.getResource('state', 'settings')).toEqual({ version: 1 });
    const readsBeforeResource = client.selectedReads.length;
    expect(await store.getResource('state', 'missing')).toBeNull();
    expect(client.selectedReads.slice(readsBeforeResource)).toEqual([[db.key('alice', 'state', 'missing')]]);

    expect(client.fullReads).toBe(fullReadsBefore);
    expect(client.selectedReads.length).toBeGreaterThan(0);
    const writePaths = client.selectedReads[0]!;
    expect(new Set(writePaths)).toEqual(new Set([
      db.key('alice', 'registry', 'tenant'), db.key('alice', 'statement', first.id), db.key('alice', 'statement', second.id),
    ]));
    expect(client.selectedReads.every(keys => keys.every(key => !key.startsWith(db.prefix('bob'))))).toBe(true);
    expect(client.artifactReads.every(url => !client.blockedArtifactReads.has(url))).toBe(true);
    expect(client.commits.length).toBeGreaterThan(0);
    expect(client.commits.every(request => request.resultRecordKeys?.length === 0)).toBe(true);
    // A partial expected snapshot must never replace the complete durable head.
    for (const [key, reference] of unrelatedEntries) expect(client.storage.head.records.get(key)).toEqual(reference);
    expect(client.storage.head.records.has(db.queryKey('alice', first))).toBe(true);
    expect(client.storage.head.records.has(db.queryKey('alice', second))).toBe(true);
  });
  it('does not confuse unselected paths with verified absence or accept incomplete selected-read coverage', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice'), value = record();
    await store.put(value);
    const omitted = db.key('alice', 'statement', value.id);
    const partial = await client.readHeadRecords([db.key('alice', 'registry', 'tenant')]);
    await expect(db.read(partial, 'alice', 'statement', value.id)).rejects.toThrow();

    client.transformSelection = head => { const { selectedRecordKeys: _coverage, ...withoutProof } = head; return withoutProof; };
    await expect(store.get(value.id)).rejects.toThrow();

    client.transformSelection = (head, keys) => ({ ...head, records: new Map(), selectedRecordKeys: keys.filter(key => key !== omitted) });
    await expect(store.get(value.id)).rejects.toThrow();
    const commitsBefore = client.commits.length;
    const conflict = structuredClone(value); conflict.statement.object = { id: 'https://example.test/must-not-replace' };
    await expect(store.put(conflict)).rejects.toThrow();
    expect(client.commits).toHaveLength(commitsBefore);

    const resourceKey = db.key('alice', 'state', 'private');
    client.transformSelection = (head, keys) => ({ ...head, records: new Map(), selectedRecordKeys: keys.filter(key => key !== resourceKey) });
    await expect(store.getResource('state', 'private')).rejects.toThrow();
    client.transformSelection = undefined;
    expect(await store.get(value.id)).toEqual(value);
  });
  it('falls back to a complete verified head for large selections while deduplicating bounded requests', async () => {
    const client = new TestNativeClient(), db = database(client), value = record();
    await db.forTenant('alice').put(value);
    const key = db.key('alice', 'statement', value.id), fullReadsBefore = client.fullReads;
    client.selectedReads = [];
    const repeated = await db.readHead(new Array(1001).fill(key));
    expect(repeated.records.has(key)).toBe(true);
    expect(client.selectedReads).toEqual([[key]]);
    expect(client.fullReads).toBe(fullReadsBefore);
    const manyKeys = Array.from({ length: 1001 }, (_, index) => 'unique-synthetic-path-' + index);
    const full = await db.readHead(manyKeys);
    expect(full.selectedRecordKeys).toBeUndefined();
    expect(full.records.has(key)).toBe(true);
    expect(client.selectedReads).toEqual([[key]]);
    expect(client.fullReads).toBe(fullReadsBefore + 1);
  });
  it('keeps immutable replay and collision checks on selected statement paths and never acknowledges a refused CAS', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice'), value = record();
    await db.ready(); client.forbidFullReads = true;
    await store.put(value);
    const firstReference = client.storage.head.records.get(db.key('alice', 'statement', value.id));
    const replay = await store.putWithAttachments(structuredClone(value), new Map());
    expect(replay.records).toEqual([value]); expect(replay.inserted).toEqual([]);
    const changed = structuredClone(value); changed.statement.object = { id: 'https://example.test/conflict' };
    await expect(store.put(changed)).rejects.toBeInstanceOf(ConflictError);
    expect(client.storage.head.records.get(db.key('alice', 'statement', value.id))).toEqual(firstReference);
    client.beforeCommit = async request => { if (request.changes.length) throw new Error('synthetic durable CAS refused'); };
    const refused = record();
    await expect(store.put(refused)).rejects.toThrow('synthetic durable CAS refused');
    expect(await store.get(refused.id)).toBeNull();
    expect(await store.get(value.id)).toEqual(value);
  });
  it('retries a void lookup when its selected head changes before reading the voider', async () => {
    const storage = primary(), client = new TestNativeClient(storage), otherClient = new TestNativeClient(storage);
    const db = database(client), otherDb = database(otherClient), store = db.forTenant('alice'), other = otherDb.forTenant('alice');
    await Promise.all([db.ready(), otherDb.ready()]);
    const target = record(), firstVoider = voider(target.id), newerVoider = voider(target.id);
    await store.put(target); await store.put(firstVoider);
    client.selectedReads = []; client.forbidFullReads = true;
    let replaced = false;
    client.beforeSelection = async keys => {
      if (!replaced && keys.includes(db.key('alice', 'statement', firstVoider.id))) {
        replaced = true;
        await other.put(newerVoider);
      }
    };
    const result = await store.get(target.id);
    expect(replaced).toBe(true);
    expect(result?.voidingStatementId).toBe(newerVoider.id);
    expect(result?.statement).toEqual(target.statement);
    expect(client.selectedReads.length).toBeGreaterThan(2);
  });
  it('supports full-snapshot native clients that do not advertise selected reads', async () => {
    const underlying = new TestNativeClient();
    const legacy: NativeCommitClient = {
      ready: () => underlying.ready(), readHead: () => underlying.readHead(),
      readSnapshotAt: reference => underlying.readSnapshotAt(reference),
      readArtifact: reference => underlying.readArtifact(reference), commit: request => underlying.commit(request),
    };
    const store = database(legacy).forTenant('alice'), target = record(), appliedVoid = voider(target.id);
    await store.put(target); await store.put(appliedVoid);
    expect((await store.get(target.id))?.voidingStatementId).toBe(appliedVoid.id);
    await store.putResource('state', 'settings', { version: 1 });
    expect(await store.getResource('state', 'settings')).toEqual({ version: 1 });
    expect(underlying.fullReads).toBeGreaterThan(0);
    expect(underlying.selectedReads).toEqual([]);
  });
  it('reduces verified native transport reads over the real encrypted client and local resource engine', async () => {
    // The native encryption, HAMT proofs, resource CAS and PGSL engine run here.
    // Only their persistence driver and HTTP transport are local test seams.
    const driver = new InMemoryFdb(), engine = openStore(driver), ldp = new LdpStore(engine, new CodecRegistry());
    const methods: string[] = [], keys = deriveEncryptionKeyPair('11'.repeat(32), owner);
    const transport: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET'; methods.push(method);
      if (method === 'OPTIONS') return new Response(null, { status: 204,
        headers: { 'Accept-Put': NATIVE_COMMIT_MEDIA_TYPE, 'Interego-Native-Commit': '1' } });
      if (method === 'GET') {
        const result = await ldp.readResource('css', url);
        return result ? new Response(Buffer.from(result.bytes).toString('utf8'), { headers: {
          'Content-Type': result.contentType, ETag: '"' + result.revision + '-json"',
          'Interego-Revision': result.revision, 'Interego-Body-Digest': result.bodyDigest,
        } }) : new Response(null, { status: 404 });
      }
      expect(method).toBe('PUT');
      const command = JSON.parse(String(init?.body)) as { expectedRevision: string | null; bodyBase64: string; contentType: string };
      const result = await ldp.commitResource('css', url, Buffer.from(command.bodyBase64, 'base64'), command.contentType,
        { expectedRevision: command.expectedRevision });
      if (result.status === 'conflict') return new Response(null, { status: 412 });
      return new Response(JSON.stringify({ ...result, version: 1, resource: url, expectedRevision: command.expectedRevision }), {
        headers: { 'Content-Type': 'application/json', ETag: '"' + result.revision + '-json"' },
      });
    };
    const client = new NativeCommitStore({ scope, fetch: transport, senderKeyPair: keys,
      ownerPublicKey: keys.publicKey, recipientPublicKeys: [keys.publicKey] });
    await client.commit({ operationId: randomUUID(), expected: await client.readHead(), resultRecordKeys: [],
      changes: Array.from({ length: 96 }, (_, index) => ({ key: 'unrelated-native-record-' + index,
        artifact: createNativeByteArtifact({ owner, contentType: 'application/octet-stream', bytes: Buffer.from('synthetic-' + index) }) })),
    });
    const db = database(client), store = db.forTenant('alice'), value = record();
    await store.put(value); await store.putResource('state', 'settings', { version: 1 });
    methods.length = 0;
    const complete = await client.readHead(), fullGets = methods.filter(method => method === 'GET').length;
    expect(complete.records.size).toBeGreaterThan(96);
    methods.length = 0;
    expect(await store.get(value.id)).toEqual(value);
    const statementGets = methods.filter(method => method === 'GET').length;
    methods.length = 0;
    expect(await store.getResource('state', 'settings')).toEqual({ version: 1 });
    const resourceGets = methods.filter(method => method === 'GET').length;
    expect(statementGets).toBeLessThan(fullGets / 2);
    expect(resourceGets).toBeLessThan(fullGets / 2);
    expect(methods.every(method => method === 'GET')).toBe(true);
    await db.close(); await driver.close();
  }, 30_000);
  it('keeps exact immutable statement envelopes while allowing idempotent authored-field retries', async () => {
    const store = database(new TestNativeClient()).forTenant('alice'), first = record();
    await store.put(first);
    const retry = structuredClone(first); retry.stored = '2026-10-15T10:01:00.000Z';
    retry.statement.stored = retry.stored; retry.statement.authority = { name: 'other authenticated LRS' };
    const replay = await store.putWithAttachments(retry, new Map());
    expect(replay.records).toEqual([first]); expect(replay.inserted).toEqual([]); expect(replay.appliedVoids).toEqual([]);
    expect(await store.get(first.id)).toEqual(first);
    const conflict = structuredClone(retry); conflict.statement.object = { id: 'https://example.test/other' };
    await expect(store.put(conflict)).rejects.toBeInstanceOf(ConflictError);
    expect(await store.get(first.id)).toEqual(first);
    expect(await store.count()).toBe(1);
  });
  it('resolves concurrent generated-timestamp retries using durable provenance and keeps the original artifact', async () => {
    const storage = primary(), leftClient = new TestNativeClient(storage), rightClient = new TestNativeClient(storage);
    const leftDb = database(leftClient), rightDb = database(rightClient), left = leftDb.forTenant('alice'), right = rightDb.forTenant('alice');
    await Promise.all([leftDb.ready(), rightDb.ready()]);
    let arrived = 0, bothEntered!: () => void, release!: () => void;
    const both = new Promise<void>(resolve => { bothEntered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pause = async (request: NativeCommitRequest): Promise<void> => {
      if (!request.changes.length || ++arrived > 2) return;
      if (arrived === 2) bothEntered();
      await gate;
    };
    leftClient.beforeCommit = pause; rightClient.beforeCommit = pause;
    const first = record(); first.timestampAssignedByLrs = true; first.statement.timestamp = '2026-10-15T10:00:00.000Z';
    const competing = structuredClone(first); competing.stored = '2026-10-15T10:00:01.000Z';
    competing.statement.stored = competing.stored; competing.statement.timestamp = competing.stored;
    const pending = [left.putWithAttachments(first, new Map()), right.putWithAttachments(competing, new Map())];
    await both; release();
    const answers = await Promise.all(pending), winner = answers.find(answer => answer.inserted.length)?.records[0];
    expect(winner).toBeDefined();
    expect(answers.map(answer => answer.inserted.length).sort()).toEqual([0, 1]);
    expect(answers.map(answer => answer.records)).toEqual([[winner], [winner]]);
    expect(await right.get(first.id)).toEqual(winner);
    const statementKey = leftDb.key('alice', 'statement', first.id), queryKey = leftDb.queryKey('alice', winner!);
    const originalArtifact = storage.head.records.get(statementKey), originalQueryArtifact = storage.head.records.get(queryKey);
    expect(originalArtifact).toBeDefined(); expect(originalQueryArtifact).toBeDefined();
    // Each index entry has its own encrypted reference, bound to the same canonical source.
    expect(originalQueryArtifact?.plaintextDigest).toBe(originalArtifact?.plaintextDigest);
    expect(originalQueryArtifact?.topUri).toBe(originalArtifact?.topUri);
    const later = structuredClone(first); later.statement.timestamp = '2026-10-16T10:00:00.000Z';
    const replay = await right.putWithAttachments(later, new Map());
    expect(replay.records).toEqual([winner]); expect(replay.inserted).toEqual([]);
    expect(storage.head.records.get(statementKey)).toEqual(originalArtifact);
    expect(storage.head.records.get(queryKey)).toEqual(originalQueryArtifact);
  });
  it('keeps explicit or unknown timestamp provenance strict and never upgrades it on replay', async () => {
    const cases: Array<[boolean | undefined, boolean | undefined]> = [[undefined, true], [false, true], [true, undefined], [true, false], [false, false]];
    for (const [originalFlag, incomingFlag] of cases) {
      const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice'), first = record();
      first.statement.timestamp = '2026-10-15T10:00:00.000Z';
      if (originalFlag !== undefined) first.timestampAssignedByLrs = originalFlag;
      await store.put(first);
      const artifact = client.storage.head.records.get(db.key('alice', 'statement', first.id));
      const same = structuredClone(first); delete same.timestampAssignedByLrs;
      if (incomingFlag !== undefined) same.timestampAssignedByLrs = incomingFlag;
      const replay = await store.putWithAttachments(same, new Map());
      expect(replay.records).toEqual([first]); expect(replay.inserted).toEqual([]);
      expect(await store.get(first.id)).toEqual(first);
      expect(client.storage.head.records.get(db.key('alice', 'statement', first.id))).toEqual(artifact);
      const changed = structuredClone(same); changed.statement.timestamp = '2026-10-16T10:00:00.000Z';
      await expect(store.put(changed)).rejects.toBeInstanceOf(ConflictError);
      expect(await store.get(first.id)).toEqual(first);
      expect(client.storage.head.records.get(db.key('alice', 'statement', first.id))).toEqual(artifact);
    }
  });
  it('commits whole batches, attachment bytes and tenant membership or keeps none', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice'), bytes = Buffer.from([0, 1, 255, 13, 10]);
    const sha = createHash('sha256').update(bytes).digest('hex'), value = record();
    client.beforeCommit = async request => { if (request.changes.length) throw new Error('synthetic durable commit refused'); };
    await expect(store.putWithAttachments(value, new Map([[sha, { data: bytes, contentType: 'application/octet-stream' }]]))).rejects.toThrow();
    expect(await store.get(value.id)).toBeNull(); expect(await store.getAttachment(sha)).toBeNull(); expect(await db.listTenants()).toEqual([]);
    client.beforeCommit = undefined;
    await store.putWithAttachments(value, new Map([[sha, { data: bytes, contentType: 'application/octet-stream' }]]));
    expect(await store.getAttachment(sha)).toEqual({ data: bytes, contentType: 'application/octet-stream' });
    expect(await db.forTenant('bob').get(value.id)).toBeNull(); expect(await db.forTenant('bob').getAttachment(sha)).toBeNull();
    const added = record(), changed = structuredClone(value); changed.statement.actor = { mbox: 'mailto:other@example.test' };
    await expect(store.putBatchWithAttachments([added, changed], new Map())).rejects.toBeInstanceOf(ConflictError);
    expect(await store.get(added.id)).toBeNull();
  });
  it('guards void relationships and commits the voider with the edge atomically', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const registration = randomUUID(), target = record(undefined, undefined, registration);
    await store.put(target);
    const refused = voider(target.id);
    client.beforeCommit = async request => { if (request.changes.length) throw new Error('synthetic commit refused'); };
    await expect(store.put(refused)).rejects.toThrow();
    expect(await store.get(refused.id)).toBeNull(); expect((await store.get(target.id))?.voided).toBe(false);
    client.beforeCommit = undefined;
    const outside = voider(target.id);
    await store.putWithAttachments(outside, new Map(), randomUUID());
    expect((await store.get(target.id))?.voided).toBe(false);
    const accepted = voider(target.id);
    const acceptedCommit = await store.putWithAttachments(accepted, new Map(), registration);
    expect(acceptedCommit.appliedVoids).toHaveLength(1);
    const replayCommit = await store.putWithAttachments(accepted, new Map(), registration);
    expect(replayCommit.inserted).toEqual([]); expect(replayCommit.appliedVoids).toEqual([]);
    expect((await store.get(target.id))?.voidingStatementId).toBe(accepted.id);
    expect(await store.markVoided(target.id, accepted.id, current => !current.voided)).toBe(false);
    expect(await store.markVoided(accepted.id, voider(accepted.id).id)).toBe(false);
    expect((await store.query({})).statements.some(row => row.id === target.id)).toBe(false);
    expect((await store.query({ voidedStatementId: target.id })).statements[0]?.statement).toEqual(target.statement);
    const restarted = database(new TestNativeClient(client.storage)).forTenant('alice');
    expect((await restarted.get(target.id))?.voided).toBe(true);
  });
  it('retains binary documents, content type and CAS preconditions across independent clients', async () => {
    const storage = primary(), left = database(new TestNativeClient(storage)).forTenant('alice'), right = database(new TestNativeClient(storage)).forTenant('alice');
    const bytes = Buffer.from([0, 255, 128, 1]);
    await left.putResource('state', 'binary', { content: bytes, contentType: 'application/octet-stream', etag: '"v1"' });
    expect(await right.getResource('state', 'binary')).toEqual({ content: bytes, contentType: 'application/octet-stream', etag: '"v1"' });
    await left.putResource('activityProfile', 'settings', { version: 1, data: { original: true } });
    const change = (current: { version: number; data: object } | null) => {
      if (current?.version !== 1) throw Object.assign(new Error('stale document'), { status: 412 });
      return { value: { version: 2, data: { updated: true } }, result: undefined };
    };
    const results = await Promise.allSettled([left.updateResource('activityProfile', 'settings', change), right.updateResource('activityProfile', 'settings', change)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(row => row.status === 'rejected')).toHaveLength(1);
    expect(await right.getResource('activityProfile', 'settings')).toEqual({ version: 2, data: { updated: true } });
  });
  it('resumes a signed query at its immutable native head through restart, later writes and voids', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const rows = Array.from({ length: 5 }, (_, i) => record(undefined, '2026-10-15T10:00:0' + i + '.000Z'));
    await store.putBatchWithAttachments(rows, new Map());
    const first = await store.query({ limit: 2, ascending: true }); expect(first.more).toBeTruthy();
    await store.put(record(undefined, '2026-10-15T09:00:00.000Z'));
    await store.put(voider(rows[3]!.id));
    const restarted = database(new TestNativeClient(client.storage)).forTenant('alice');
    const seen = first.statements.map(row => row.id); let cursor = first.more;
    while (cursor) { const page = await restarted.query({ limit: 2, ascending: true, cursor }); seen.push(...page.statements.map(row => row.id)); cursor = page.more; }
    expect(seen).toEqual(rows.map(row => row.id));
    const raw = JSON.parse(Buffer.from(first.more!, 'base64url').toString('utf8')) as Record<string, unknown>; raw.offset = 999;
    await expect(restarted.query({ limit: 2, ascending: true, cursor: Buffer.from(JSON.stringify(raw)).toString('base64url') })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    await expect(db.forTenant('bob').query({ limit: 2, ascending: true, cursor: first.more! })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    await expect(restarted.query({ limit: 3, ascending: true, cursor: first.more! })).rejects.toBeInstanceOf(InvalidLrsQueryError);
  });
  it('pages every matching voider exactly once and never expands another registration into a restricted query', async () => {
    const store = database(new TestNativeClient()).forTenant('alice');
    const verb = 'https://example.test/verbs/void-query';
    const targets = Array.from({ length: 3 }, () => { const row = record(undefined, '2026-10-15T09:00:00.000Z'); row.statement.verb = { id: verb }; return row; });
    const voiders = targets.map(row => voider(row.id));
    await store.putBatchWithAttachments(targets, new Map());
    await store.putBatchWithAttachments(voiders, new Map());
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await store.query({ verb, limit: 1, cursor });
      expect(result.statements.length).toBeLessThanOrEqual(1);
      seen.push(...result.statements.map(row => row.id));
      if (!result.more) break;
      cursor = result.more;
    }
    expect(seen.sort()).toEqual(voiders.map(row => row.id).sort());
    expect(new Set(seen).size).toBe(3);
    const regA = randomUUID(), regB = randomUUID(), target = record(undefined, undefined, regA), otherLaunch = voider(target.id);
    target.statement.verb = { id: 'https://example.test/verbs/private-void-query' };
    otherLaunch.statement.context = { registration: regB };
    await store.put(target); await store.put(otherLaunch);
    expect((await store.query({ verb: 'https://example.test/verbs/private-void-query', registration: regA })).statements.map(row => row.id)).toEqual([otherLaunch.id]);
    expect((await store.query({ verb: 'https://example.test/verbs/private-void-query', registration: regA, authorizedRegistration: regA })).statements).toEqual([]);
    const page = await store.query({ verb: 'https://example.test/verbs/private-void-query', registration: regA, limit: 1 });
    expect(page.more).toBeTruthy();
    await expect(store.query({ verb: 'https://example.test/verbs/private-void-query', registration: regA, limit: 1,
      cursor: page.more!, authorizedRegistration: regA })).rejects.toBeInstanceOf(InvalidLrsQueryError);
  });
  it('rebuilds query entries from verified canonical statements and fails on tenant/index substitution', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice'), row = record();
    await store.put(row);
    const head = await client.readHead(), key = db.queryKey('alice', row);
    await client.commit({ operationId: randomUUID(), expected: head, changes: [{ key, artifact: null }] });
    await expect(store.query({})).rejects.toThrow(/incomplete/);
    await store.rebuildQueryView(); expect((await store.query({})).statements).toEqual([row]);
    const fake = createNativeByteArtifact({ owner, contentType: 'application/vnd.foxxi.lrs-record+json',
      bytes: Buffer.from(JSON.stringify({ format: 'foxxi-native-lrs/1', tenant: 'bob', kind: 'statement', id: row.id, value: ['value', null] })) });
    await client.commit({ operationId: randomUUID(), expected: await client.readHead(), changes: [{ key: db.key('alice', 'statement', row.id), artifact: fake }] });
    await expect(store.get(row.id)).rejects.toThrow(/binding/);
  });
});

const fixtureInputs = Boolean(process.env.TEST_NATIVE_CSS_ROOT && process.env.TEST_NATIVE_PG_URL);
const optionalPod = process.env.TEST_NATIVE_POD_URL;
if (process.env.REQUIRE_LRS_NATIVE_TESTS === '1' && !fixtureInputs) throw new Error('Required native LRS tests need TEST_NATIVE_CSS_ROOT and TEST_NATIVE_PG_URL for real engine recovery');
describe.skipIf(!fixtureInputs && !optionalPod)('LRS adapter over actual native CSS and durable PGSL engine', () => {
  let fixture: NativeCssFixture | undefined, left: NativeInteregoLrsDatabase, right: NativeInteregoLrsDatabase;
  const originalPod = process.env.TEST_NATIVE_POD_URL;
  const serviceOwner = 'did:web:synthetic-native-lrs.test:service' as IRI;
  const privateKey = '0x' + '11'.repeat(32), suffix = randomUUID();
  let config: NodeJS.ProcessEnv;
  beforeAll(async () => {
    fixture = fixtureInputs ? await startNativeCssFixture() : undefined;
    const pod = fixture?.podUrl ?? optionalPod!;
    process.env.TEST_NATIVE_POD_URL = pod;
    const keys = deriveEncryptionKeyPair(privateKey, serviceOwner);
    config = { NODE_ENV: 'test', FOXXI_LRS_BACKEND: 'interego', FOXXI_LRS_NATIVE_POD_URL: pod,
      FOXXI_LRS_NATIVE_OWNER: serviceOwner, FOXXI_LRS_NATIVE_PRIVATE_KEY: privateKey, FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: keys.publicKey,
      FOXXI_LRS_NATIVE_CAPABILITY: fixture ? NATIVE_CSS_FIXTURE_CAPABILITY : process.env.TEST_NATIVE_CAPABILITY,
      FOXXI_LRS_NATIVE_HEAD_URL: new URL('foxxi/lrs/native/store-' + suffix + '/head', pod).href,
      FOXXI_LRS_NATIVE_ARTIFACT_CONTAINER: new URL('foxxi/lrs/native/store-' + suffix + '/artifacts/', pod).href };
    left = createConfiguredNativeLrsDatabase(config); right = createConfiguredNativeLrsDatabase(config);
    await Promise.all([left.ready(), right.ready()]);
  }, 60000);
  afterAll(async () => {
    await left?.close(); await right?.close(); await fixture?.stop();
    if (originalPod === undefined) delete process.env.TEST_NATIVE_POD_URL; else process.env.TEST_NATIVE_POD_URL = originalPod;
  });
  it('atomically keeps complete artifacts, resolves concurrent immutable UUID collisions and rebuilds the query view', async () => {
    const alice = left.forTenant('synthetic-alice'), other = right.forTenant('synthetic-alice');
    const original = record(), conflict = structuredClone(original); conflict.statement.object = { id: 'https://example.test/conflict' };
    const collisions = await Promise.allSettled([alice.put(original), other.put(conflict)]);
    expect(collisions.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(collisions.filter(row => row.status === 'rejected')).toHaveLength(1);
    const held = await alice.get(original.id); expect(held).not.toBeNull();
    const bytes = Buffer.from([0, 255, 128, 13, 10]), sha = createHash('sha256').update(bytes).digest('hex'), attached = record();
    await alice.putWithAttachments(attached, new Map([[sha, { data: bytes, contentType: 'application/octet-stream' }]]));
    await alice.putResource('state', 'binary', { content: bytes, contentType: 'application/octet-stream', etag: '"native-binary-v1"' });
    const accepted = voider(original.id); await alice.put(accepted);
    expect((await other.get(original.id))?.voidingStatementId).toBe(accepted.id);
    expect(await right.forTenant('synthetic-bob').getAttachment(sha)).toBeNull();
    expect(await right.listTenants()).toEqual(['synthetic-alice']);
    await alice.rebuildQueryView();
    expect((await other.query({ limit: 500 })).statements.map(row => row.id)).toContain(attached.id);
    // Actual process/engine recovery, never claimed for an optional pre-existing remote target.
    if (fixture) await fixture.restart();
    const recovered = createConfiguredNativeLrsDatabase(config), store = recovered.forTenant('synthetic-alice');
    try {
      await recovered.ready();
      expect((await store.get(original.id))?.statement).toEqual(held!.statement);
      expect((await store.get(original.id))?.voided).toBe(true);
      expect(await store.getAttachment(sha)).toEqual({ data: bytes, contentType: 'application/octet-stream' });
      expect(await store.getResource('state', 'binary')).toEqual({ content: bytes, contentType: 'application/octet-stream', etag: '"native-binary-v1"' });
      expect(await recovered.listTenants()).toEqual(['synthetic-alice']);
    } finally { await recovered.close(); }
  }, 120000);
});
