import { createHash, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NativeCommitStore, NativeCommitConflictError, NATIVE_COMMIT_MEDIA_TYPE, createNativeByteArtifact, validateNativeArtifact,
  type NativeArtifact, type NativeArtifactReference, type NativeCommitClient,
  type NativeCommitReceipt, type NativeCommitRequest, type NativeCommitScope,
  type NativeSnapshot, type NativeSnapshotReference,
} from '@interego/pgsl';
import { deriveEncryptionKeyPair, type IRI } from '@interego/core';
import { openStore, InMemoryFdb, CodecRegistry, LdpStore } from '../../../packages/pgsl-store/src/index.js';
import { NATIVE_CSS_FIXTURE_CAPABILITY, startNativeCssFixture, type NativeCssFixture } from './support/native-css-fixture.js';
import { NativeInteregoLrsDatabase, InvalidLrsQueryError, type NativeLrsQueryDiagnostic } from '../src/native-lrs-store.js';
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
  constructor(readonly storage = primary(), readonly sharedArtifactReferences = false) {}
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
    const shared = new Map<string, NativeArtifactReference>();
    for (const change of request.changes) {
      if (!change.artifact) { records.delete(change.key); continue; }
      const artifact = validateNativeArtifact({ topUri: change.artifact.topUri, nodes: change.artifact.pgsl.nodes });
      const plaintextDigest = hash(JSON.stringify([...artifact.nodes].sort(([a], [b]) => a.localeCompare(b))));
      const identity = plaintextDigest + ':' + artifact.topUri;
      const existing = this.sharedArtifactReferences ? shared.get(identity) : undefined;
      if (existing) { records.set(change.key, existing); continue; }
      const resourceUrl = scope.artifactContainer + randomUUID();
      this.storage.artifacts.set(resourceUrl, artifact);
      const reference = { resourceUrl, bodyDigest: hash(resourceUrl), plaintextDigest, topUri: artifact.topUri };
      records.set(change.key, reference); shared.set(identity, reference);
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

describe('native LRS query read pipeline', () => {
  it('verifies independent rows concurrently with at most eight native artifact reads in flight', async () => {
    const client = new TestNativeClient(), store = database(client).forTenant('alice');
    const rows = Array.from({ length: 12 }, (_, i) => record(undefined, new Date(Date.UTC(2026, 9, 20, 10, 0, i)).toISOString()));
    await store.putBatchWithAttachments(rows, new Map());
    const read = client.readArtifact.bind(client);
    let active = 0, maximum = 0, release!: () => void, started = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    client.readArtifact = async reference => {
      active++; maximum = Math.max(maximum, active);
      // The first event-loop turn releases the gate even for the serial baseline.
      // This proves overlap without a machine-speed or wall-clock assertion.
      if (!started) { started = true; setImmediate(release); }
      try { await gate; return await read(reference); } finally { active--; }
    };
    const result = await store.query({ ascending: true, limit: rows.length });
    expect(result.statements.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(result.more).toBeNull(); expect(active).toBe(0);
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(8);
  });
  it('reuses the exact verified artifact reference within one query without retaining proofs for later requests', async () => {
    // Native production commits reuse the same immutable artifact for the point
    // record and its query entry. The fixture's optional dedup models that layout.
    const client = new TestNativeClient(primary(), true), store = database(client).forTenant('alice');
    const target = record(), ordinary = record(), cancellation = voider(target.id);
    await store.putBatchWithAttachments([target, ordinary], new Map()); await store.put(cancellation);
    client.artifactReads = [];
    expect((await store.query({})).statements.map(row => row.id).sort()).toEqual([ordinary.id, cancellation.id].sort());
    const firstReads = [...client.artifactReads];
    expect(firstReads.length).toBeGreaterThan(0);
    expect(firstReads).toHaveLength(new Set(firstReads).size);
    client.artifactReads = [];
    await store.query({});
    expect([...client.artifactReads].sort()).toEqual([...firstReads].sort());
    client.blockedArtifactReads.add(firstReads[0]!);
    await expect(store.query({})).rejects.toThrow(/must not be fetched/);
  });
});

describe('native LRS verified time-window contracts', () => {
  const since = '2026-10-20T10:00:00.000Z', until = '2026-10-20T11:00:00.000Z';
  const retime = (row: StoredStatement, stored: string): StoredStatement => ({ ...row, stored, statement: { ...row.statement, stored } });
  const authoredArtifact = (client: TestNativeClient, key: string) => {
    const artifact = client.commits.flatMap(commit => [...commit.changes]).find(change => change.key === key)?.artifact;
    if (!artifact) throw new Error('fixture has no committed artifact for path');
    return artifact;
  };

  it('continues across more than 4096 old rows with unchanged raw-budget and signed-head semantics in both orders', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const old = Array.from({ length: 4100 }, () => record(undefined, '2026-10-01T00:00:00.000Z'));
    const recent = [1, 2, 3].map(second => record(undefined, `2026-10-20T10:00:0${second}.000Z`));
    const future = record(undefined, '2026-10-31T00:00:00.000Z');
    await store.putBatchWithAttachments([...old, ...recent, future], new Map());
    for (const ascending of [true, false]) {
      const filter = { since, until, ascending, limit: 2 };
      const first = await store.query(filter); expect(first.more).toBeTruthy();
      const firstCursor = JSON.parse(Buffer.from(first.more!, 'base64url').toString('utf8')) as {
        head: NativeSnapshotReference; after: string; offset: number; expires: number; authorizationRegistration: null;
      };
      if (ascending) {
        expect(first.statements).toEqual([]); expect(firstCursor.offset).toBe(0);
        expect(firstCursor.after).toContain('/query/2026-10-01T00:00:00.000Z/');
      } else {
        expect(first.statements.map(row => row.id)).toEqual([recent[2]!.id, recent[1]!.id]);
        // Cursor position is the last consumed row, never the prefetch frontier.
        expect(firstCursor.after).toBe(db.queryKey('alice', recent[1]!));
      }
      const restarted = database(new TestNativeClient(client.storage)).forTenant('alice');
      const seen = first.statements.map(row => row.id); let cursor = first.more;
      for (let page = 0; cursor && page < 5; page++) {
        const next = await restarted.query({ ...filter, cursor }); seen.push(...next.statements.map(row => row.id));
        if (next.more) {
          const raw = JSON.parse(Buffer.from(next.more, 'base64url').toString('utf8')) as typeof firstCursor;
          expect(raw.head).toEqual(firstCursor.head); expect(raw.expires).toBe(firstCursor.expires);
          expect(raw.offset).toBe(seen.length); expect(raw.authorizationRegistration).toBeNull();
        }
        cursor = next.more;
      }
      expect(cursor).toBeNull();
      expect(seen).toEqual((ascending ? recent : [...recent].reverse()).map(row => row.id));
      expect(new Set(seen).size).toBe(recent.length);
    }
  }, 60000);

  it.each([true, false])('keeps since exclusive and until inclusive with equivalent UTC offsets (ascending=%s)', async ascending => {
    const store = database(new TestNativeClient()).forTenant('alice');
    const lower = record(undefined, since), inside = record(undefined, '2026-10-20T10:00:00.001Z');
    const upper = record(undefined, until), later = record(undefined, '2026-10-20T11:00:00.001Z');
    await store.putBatchWithAttachments([lower, inside, upper, later], new Map());
    const result = await store.query({ since: '2026-10-20T11:00:00+01:00', until, ascending });
    expect(result.statements.map(row => row.id)).toEqual((ascending ? [inside, upper] : [upper, inside]).map(row => row.id));
  });

  it.each([true, false])('pages both earlier and later out-of-window voiders exactly once from matching targets (ascending=%s)', async ascending => {
    const store = database(new TestNativeClient()).forTenant('alice'), registration = randomUUID();
    const verb = 'https://example.test/verbs/window-target';
    const targets = [1, 2].map(second => { const row = record(undefined, `2026-10-20T10:00:0${second}.000Z`, registration); row.statement.verb = { id: verb }; return row; });
    const ordinary = record(undefined, '2026-10-20T10:00:03.000Z', registration); ordinary.statement.verb = { id: verb };
    const before = retime(voider(targets[0]!.id), '2026-10-01T00:00:00.000Z');
    const after = retime(voider(targets[1]!.id), '2026-10-31T00:00:00.000Z');
    before.statement.context = after.statement.context = { registration };
    await store.putBatchWithAttachments([...targets, ordinary], new Map()); await store.putBatchWithAttachments([before, after], new Map());
    const seen: string[] = []; let cursor: string | undefined;
    for (let page = 0; page < 6; page++) {
      const result = await store.query({ since, until, verb, registration, authorizedRegistration: registration, ascending, limit: 1, cursor });
      expect(result.statements.length).toBeLessThanOrEqual(1); seen.push(...result.statements.map(row => row.id));
      if (!result.more) { cursor = undefined; break; } cursor = result.more;
    }
    expect(cursor).toBeUndefined();
    expect(seen).toEqual((ascending ? [before, ordinary, after] : [after, ordinary, before]).map(row => row.id));
    expect(new Set(seen).size).toBe(3);
  });

  it('never expands a foreign registration through an out-of-window voider', async () => {
    const store = database(new TestNativeClient()).forTenant('alice'), allowed = randomUUID(), other = randomUUID();
    const verb = 'https://example.test/verbs/registration-window-target';
    const target = record(undefined, '2026-10-20T10:00:01.000Z', allowed), foreign = record(undefined, '2026-10-20T10:00:02.000Z', other);
    target.statement.verb = foreign.statement.verb = { id: verb };
    const foreignVoider = retime(voider(target.id), '2026-10-31T00:00:00.000Z'); foreignVoider.statement.context = { registration: other };
    const ownVoider = retime(voider(foreign.id), '2026-10-01T00:00:00.000Z'); ownVoider.statement.context = { registration: allowed };
    await store.putBatchWithAttachments([target, foreign], new Map()); await store.putBatchWithAttachments([foreignVoider, ownVoider], new Map());
    const filter = { since, until, verb, registration: allowed };
    expect((await store.query(filter)).statements.map(row => row.id)).toEqual([foreignVoider.id]);
    expect((await store.query({ ...filter, authorizedRegistration: allowed })).statements).toEqual([]);
  });

  it('pins ranged continuations to their original head, query, tenant, registration and signed consumed position', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice'), registration = randomUUID();
    const rows = [1, 2, 3].map(second => record(undefined, `2026-10-20T10:00:0${second}.000Z`, registration));
    await store.putBatchWithAttachments(rows, new Map());
    const filter = { since, until, ascending: true, limit: 1, authorizedRegistration: registration };
    const first = await store.query(filter); expect(first.more).toBeTruthy();
    type Body = Parameters<NativeInteregoLrsDatabase['signature']>[1];
    const raw = JSON.parse(Buffer.from(first.more!, 'base64url').toString('utf8')) as Body & { proof: string };
    expect(raw.after).toBe(db.queryKey('alice', rows[0]!)); expect(raw.offset).toBe(1);
    await store.put(record(undefined, '2026-10-20T10:00:01.500Z', registration)); await store.put(voider(rows[2]!.id));
    const restarted = database(new TestNativeClient(client.storage)).forTenant('alice');
    const second = await restarted.query({ ...filter, cursor: first.more! });
    expect(second.statements.map(row => row.id)).toEqual([rows[1]!.id]); expect(second.more).toBeTruthy();
    const last = await restarted.query({ ...filter, cursor: second.more! });
    expect(last.statements.map(row => row.id)).toEqual([rows[2]!.id]); expect(last.more).toBeNull();
    for (const changed of [{ ...raw, offset: 999 }, { ...raw, after: db.queryKey('alice', rows[2]!) },
      { ...raw, head: { ...raw.head, revision: hash('substituted-head') } }]) {
      await expect(restarted.query({ ...filter, cursor: Buffer.from(JSON.stringify(changed)).toString('base64url') })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    }
    await expect(restarted.query({ ...filter, since: '2026-10-20T09:00:00.000Z', cursor: first.more! })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    await expect(restarted.query({ ...filter, authorizedRegistration: randomUUID(), cursor: first.more! })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    await expect(db.forTenant('bob').query({ ...filter, cursor: first.more! })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    const { proof: _proof, ...body } = raw;
    const missingPosition = { ...body, after: db.prefix('alice') + 'query/2026-10-20T10:00:01.000Z/' + 'f'.repeat(64) };
    const forged = Buffer.from(JSON.stringify({ ...missingPosition, proof: db.signature('alice', missingPosition) })).toString('base64url');
    await expect(restarted.query({ ...filter, cursor: forged })).rejects.toBeInstanceOf(InvalidLrsQueryError);
  });

  it.each(['missing', 'malformed', 'substituted'] as const)('rejects %s query metadata even outside the requested window', async mode => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const old = record(undefined, '2026-10-01T00:00:00.000Z'), recent = record(undefined, '2026-10-20T10:00:01.000Z');
    await store.putBatchWithAttachments([old, recent], new Map());
    const key = db.queryKey('alice', old), changes: NativeCommitRequest['changes'][number][] = [{ key, artifact: null }];
    if (mode === 'malformed') changes.push({ key: key.replace(old.stored, '2026-99-99T00:00:00.000Z'), artifact: authoredArtifact(client, key) });
    if (mode === 'substituted') {
      const changed = structuredClone(old); changed.statement.object = { id: 'https://example.test/substituted-artifact' };
      changes.push({ key, artifact: db.artifact('alice', 'statement', old.id, changed) });
    }
    await client.commit({ operationId: randomUUID(), expected: await client.readHead(), changes });
    await expect(store.query({ since, until })).rejects.toThrow(/query view/);
  });

  it.each(['2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'])('rejects a canonical false timestamp %s paired with the genuine primary artifact', async falseTime => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const row = record(undefined, '2026-10-20T10:00:01.000Z'); await store.put(row);
    const key = db.queryKey('alice', row), forgedKey = key.replace(row.stored, falseTime);
    await client.commit({ operationId: randomUUID(), expected: await client.readHead(), changes: [
      { key, artifact: null }, { key: forgedKey, artifact: authoredArtifact(client, key) },
    ] });
    const primaryRef = client.storage.head.records.get(db.key('alice', 'statement', row.id))!;
    const queryRef = client.storage.head.records.get(forgedKey)!;
    expect(queryRef.plaintextDigest).toBe(primaryRef.plaintextDigest); expect(queryRef.topUri).toBe(primaryRef.topUri);
    // An authenticated index timestamp is not proof of the statement's stored
    // timestamp. A time prefilter must not turn this corruption into empty success.
    await expect(store.query({ since, until })).rejects.toThrow(/binding/);
  });

  it.each(['wrong-target', 'missing-voider', 'non-voider', 'foreign-envelope'] as const)('rejects a %s relation rather than returning partial window results', async mode => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const target = record(undefined, '2026-10-20T10:00:01.000Z'), ordinary = record(undefined, '2026-10-20T10:00:02.000Z');
    const cancellation = retime(voider(target.id), '2026-10-31T00:00:00.000Z');
    await store.putBatchWithAttachments([target, ordinary], new Map()); await store.put(cancellation);
    const relation = { target: mode === 'wrong-target' ? ordinary.id : target.id,
      voidingStatementId: mode === 'missing-voider' ? randomUUID() : mode === 'non-voider' ? ordinary.id : cancellation.id };
    await client.commit({ operationId: randomUUID(), expected: await client.readHead(), changes: [{
      key: db.key('alice', 'void', target.id), artifact: db.artifact(mode === 'foreign-envelope' ? 'bob' : 'alice', 'void', target.id, relation),
    }] });
    await expect(store.query({ since, until })).rejects.toThrow(/binding/);
  });

  it('does not reuse a valid query proof for a different missing primary ciphertext reference', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice'), row = record();
    await store.put(row);
    const queryRef = client.storage.head.records.get(db.queryKey('alice', row))!;
    const primaryRef = client.storage.head.records.get(db.key('alice', 'statement', row.id))!;
    expect(queryRef.plaintextDigest).toBe(primaryRef.plaintextDigest); expect(queryRef.topUri).toBe(primaryRef.topUri);
    expect(queryRef.resourceUrl).not.toBe(primaryRef.resourceUrl); expect(queryRef.bodyDigest).not.toBe(primaryRef.bodyDigest);
    client.blockedArtifactReads.add(primaryRef.resourceUrl);
    await expect(store.query({})).rejects.toThrow(/must not be fetched/);
    expect(client.artifactReads).toContain(queryRef.resourceUrl); expect(client.artifactReads).toContain(primaryRef.resourceUrl);
  });

  it('rechecks envelope kind on an exact-reference cache hit', async () => {
    const client = new TestNativeClient(primary(), true), db = database(client), store = db.forTenant('alice'), row = record();
    await store.put(row); const key = db.queryKey('alice', row), artifact = authoredArtifact(client, key);
    await client.commit({ operationId: randomUUID(), expected: await client.readHead(), changes: [
      { key, artifact }, { key: db.key('alice', 'statement', row.id), artifact }, { key: db.key('alice', 'void', row.id), artifact },
    ] });
    const refs = [key, db.key('alice', 'statement', row.id), db.key('alice', 'void', row.id)].map(path => client.storage.head.records.get(path));
    expect(refs[0]).toEqual(refs[1]); expect(refs[1]).toEqual(refs[2]);
    await expect(store.query({})).rejects.toThrow(/artifact\/index binding/);
  });

  it('bounds speculative distance while an earlier row is held and does not leak later failures into a completed page', async () => {
    const client = new TestNativeClient(), db = database(client), store = db.forTenant('alice');
    const rows = Array.from({ length: 24 }, (_, i) => record(undefined, new Date(Date.UTC(2026, 9, 20, 10, 0, i)).toISOString()));
    await store.putBatchWithAttachments(rows, new Map());
    const firstRef = client.storage.head.records.get(db.queryKey('alice', rows[0]!))!, secondRef = client.storage.head.records.get(db.queryKey('alice', rows[1]!))!;
    const read = client.readArtifact.bind(client); let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const requested = new Set<string>();
    client.readArtifact = async reference => {
      requested.add(reference.resourceUrl);
      if (reference.resourceUrl === firstRef.resourceUrl) { entered(); await gate; }
      if (reference.resourceUrl === secondRef.resourceUrl) throw new Error('synthetic later-row failure');
      return read(reference);
    };
    const pending = store.query({ ascending: true, limit: 1 }); await waiting;
    try {
      await new Promise<void>(resolve => { setImmediate(() => setImmediate(resolve)); });
      const startedRows = rows.filter(row => requested.has(client.storage.head.records.get(db.queryKey('alice', row))!.resourceUrl));
      expect(startedRows.length).toBeLessThanOrEqual(8);
      expect(startedRows.every(row => rows.indexOf(row) < 8)).toBe(true);
    } finally { release(); }
    const page = await pending;
    expect(page.statements.map(row => row.id)).toEqual([rows[0]!.id]); expect(page.more).toBeTruthy();
    const raw = JSON.parse(Buffer.from(page.more!, 'base64url').toString('utf8')) as { after: string };
    expect(raw.after).toBe(db.queryKey('alice', rows[0]!));
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(store.query({ ascending: true, limit: 2 })).rejects.toThrow('synthetic later-row failure');
  });
});

describe('native LRS slow-query diagnostics', () => {
  const filter = { since: '2026-10-01T00:00:00.000Z', until: '2026-10-31T00:00:00.000Z' };
  const keys = ['event', 'phase', 'outcome', 'elapsedMs', 'readyMs', 'headMs', 'indexMs', 'scanMs', 'indexedRows', 'scannedRows', 'returnedRows'].sort();
  const observed = (client: TestNativeClient, observer: (event: NativeLrsQueryDiagnostic) => void) => new NativeInteregoLrsDatabase({
    client, owner, scopeIdentity: JSON.stringify(scope), cursorSecret: secret, onSlowQuery: observer,
  });
  const pause = () => {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    return { waiting, release, wait: async () => { entered(); await gate; } };
  };
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const checked = (event: NativeLrsQueryDiagnostic) => {
    expect(Object.keys(event).sort()).toEqual(keys); expect(Object.isFrozen(event)).toBe(true);
    expect(['ongoing', 'complete']).toContain(event.event);
    expect(['ready', 'head', 'index', 'scan']).toContain(event.phase);
    expect(['ongoing', 'success', 'error']).toContain(event.outcome);
    for (const [key, value] of Object.entries(event)) if (!['event', 'phase', 'outcome'].includes(key)) {
      expect(typeof value).toBe('number'); expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0);
    }
  };
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('keeps fast, empty and rejected queries silent and removes their timers', async () => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient(), store = observed(client, event => events.push(event)).forTenant('alice');
    await store.put(record()); fakeClock();
    expect((await store.query(filter)).statements).toHaveLength(1);
    expect((await store.query({ since: '2026-10-31T00:00:00.000Z' })).statements).toEqual([]);
    await expect(store.query({ since: 'private-invalid-query-sentinel' })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    await expect(store.query({ ...filter, cursor: 'private-invalid-cursor-sentinel' })).rejects.toBeInstanceOf(InvalidLrsQueryError);
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10000); expect(events).toEqual([]);
  });

  it.each(['success', 'error'] as const)('attributes a slow readiness %s without exposing its error', async outcome => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient(), store = observed(client, event => events.push(event)).forTenant('private-tenant-sentinel');
    const gate = pause();
    client.ready = async () => { await gate.wait(); if (outcome === 'error') throw new Error('private-readiness-token-sentinel'); };
    fakeClock(); const pending = store.query(filter); await gate.waiting;
    await vi.advanceTimersByTimeAsync(15000);
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ event: 'ongoing', phase: 'ready', outcome: 'ongoing', elapsedMs: 5000, readyMs: 5000 });
    gate.release();
    if (outcome === 'error') await expect(pending).rejects.toThrow('private-readiness-token-sentinel');
    else expect((await pending).statements).toEqual([]);
    expect(events).toHaveLength(2); expect(events[1]).toMatchObject({ event: 'complete', outcome, readyMs: 15000 });
    expect(events[1]).not.toBe(events[0]); for (const event of events) checked(event);
    expect(JSON.stringify(events)).not.toContain('private-'); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000); expect(events).toHaveLength(2);
  });

  it.each(['current', 'cursor'] as const)('separates slow %s head reads from scanning and emits only fixed public counters', async kind => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient(), db = observed(client, event => events.push(event));
    const tenant = 'private-tenant-sentinel', activity = 'https://example.test/private-query-sentinel', store = db.forTenant(tenant);
    const rows = [1, 2].map(second => { const row = record(undefined, `2026-10-20T10:00:0${second}.000Z`); row.statement.object = { id: activity }; return row; });
    await store.putBatchWithAttachments(rows, new Map());
    const query = { ...filter, activity, ascending: true, limit: 1 };
    const token = kind === 'cursor' ? (await store.query(query)).more! : undefined;
    const gate = pause(), read = client.readHead.bind(client), historical = client.readSnapshotAt.bind(client);
    if (kind === 'current') client.readHead = async () => { await gate.wait(); return read(); };
    else client.readSnapshotAt = async reference => { await gate.wait(); return historical(reference); };
    fakeClock(); const pending = store.query({ ...query, cursor: token }); await gate.waiting;
    await vi.advanceTimersByTimeAsync(5000);
    expect(events[0]).toMatchObject({ event: 'ongoing', phase: 'head', headMs: 5000, scannedRows: 0, returnedRows: 0 });
    gate.release(); expect((await pending).statements.map(row => row.id)).toEqual([rows[kind === 'current' ? 0 : 1]!.id]);
    expect(events).toHaveLength(2); expect(events[1]).toMatchObject({ event: 'complete', phase: 'scan', outcome: 'success', headMs: 5000, indexedRows: 2, scannedRows: 1, returnedRows: 1 });
    for (const event of events) checked(event);
    const serialized = JSON.stringify(events);
    for (const privateValue of [tenant, activity, owner, scope.pod, scope.headUrl, secret, ...rows.map(row => row.id), token].filter((value): value is string => !!value)) expect(serialized).not.toContain(privateValue);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports slow scan failure without retaining the exception or firing after completion', async () => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient(), store = observed(client, event => events.push(event)).forTenant('alice');
    await store.put(record()); const gate = pause();
    client.readArtifact = async () => { await gate.wait(); throw new Error('private-ciphertext-reference-token-sentinel'); };
    fakeClock(); const pending = store.query(filter); await gate.waiting;
    await vi.advanceTimersByTimeAsync(5000); expect(events[0]).toMatchObject({ event: 'ongoing', phase: 'scan', scanMs: 5000, indexedRows: 1 });
    gate.release(); await expect(pending).rejects.toThrow('private-ciphertext-reference-token-sentinel');
    expect(events).toHaveLength(2); expect(events[1]).toMatchObject({ event: 'complete', phase: 'scan', outcome: 'error', scanMs: 5000 });
    for (const event of events) checked(event);
    expect(JSON.stringify(events)).not.toContain('private-'); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000); expect(events).toHaveLength(2);
  });

  it('reports completed synchronous index work without inventing an ongoing timer event', async () => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient(), store = observed(client, event => events.push(event)).forTenant('alice');
    const row = record(); await store.put(row); const read = client.readHead.bind(client);
    fakeClock(); let monotonic = 0; vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    client.readHead = async () => {
      const head = await read(), records = new Map(head.records), iterate = records[Symbol.iterator].bind(records);
      let measured = false;
      records[Symbol.iterator] = () => {
        // Simulate time consumed by synchronous verified-index traversal. Do not
        // advance event-loop timers: they cannot interrupt synchronous work.
        if (!measured) { measured = true; monotonic += 6000; }
        return iterate();
      };
      return { ...head, records };
    };
    expect((await store.query(filter)).statements).toEqual([row]);
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ event: 'complete', outcome: 'success', elapsedMs: 6000, indexMs: 6000, returnedRows: 1 });
    checked(events[0]!); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10000); expect(events).toHaveLength(1);
  });

  it.each(['ready', 'head', 'artifact'] as const)('cleans a pending diagnostic timer after early %s failure', async phase => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient(), store = observed(client, event => events.push(event)).forTenant('alice');
    if (phase !== 'ready') await store.put(record());
    if (phase === 'ready') client.readyFailure = true;
    if (phase === 'head') client.readHead = async () => { throw new Error('private-head-failure'); };
    if (phase === 'artifact') client.readArtifact = async () => { throw new Error('private-artifact-failure'); };
    fakeClock(); await expect(store.query(filter)).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10000); expect(events).toEqual([]);
  });

  it('does not start diagnostics for a slow point read, even with time fields present', async () => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient(), store = observed(client, event => events.push(event)).forTenant('alice'), row = record();
    await store.put(row); const gate = pause(), read = client.readHeadRecords.bind(client);
    client.readHeadRecords = async paths => { await gate.wait(); return read(paths); };
    fakeClock(); const pending = store.query({ ...filter, statementId: row.id }); await gate.waiting;
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(10000);
    gate.release(); expect((await pending).statements).toEqual([row]); expect(events).toEqual([]);
  });

  it.each(['throw', 'reject'] as const)('keeps query results and counters unchanged when an observer tries to mutate and %s', async behavior => {
    const events: NativeLrsQueryDiagnostic[] = [], client = new TestNativeClient();
    const observer = (event: NativeLrsQueryDiagnostic) => {
      events.push(event);
      if (behavior === 'reject') return Promise.reject(new Error('private-async-observer-sentinel'));
      (event as { scannedRows: number }).scannedRows = -999;
      throw new Error('private-sync-observer-sentinel');
    };
    const store = observed(client, observer).forTenant('alice'), row = record(); await store.put(row);
    const gate = pause(), read = client.readHead.bind(client); client.readHead = async () => { await gate.wait(); return read(); };
    fakeClock(); const pending = store.query(filter); await gate.waiting; await vi.advanceTimersByTimeAsync(5000);
    gate.release(); expect((await pending).statements).toEqual([row]); await Promise.resolve();
    expect(events).toHaveLength(2); expect(events[1]).toMatchObject({ outcome: 'success', scannedRows: 1, returnedRows: 1 });
    for (const event of events) checked(event); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('projects production diagnostic logs without transport requests, including a failing sink=%s', async failingSink => {
    const capability = 'private-synthetic-capability-sentinel', privateKey = '0x' + '22'.repeat(32);
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected transport request'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      if (failingSink) throw new Error('private-stdio-observer-sentinel');
      return true;
    });
    const db = createConfiguredNativeLrsDatabase({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'interego',
      FOXXI_LRS_NATIVE_POD_URL: scope.pod, FOXXI_LRS_NATIVE_OWNER: owner, FOXXI_LRS_NATIVE_CAPABILITY: capability,
      FOXXI_LRS_NATIVE_PRIVATE_KEY: privateKey, FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: deriveEncryptionKeyPair(privateKey, owner).publicKey,
      FOXXI_LRS_NATIVE_HEAD_URL: scope.headUrl, FOXXI_LRS_NATIVE_ARTIFACT_CONTAINER: scope.artifactContainer });
    // Exercise the configured factory's logger through its public client port,
    // with synthetic native transport rather than real credentials or pod I/O.
    const client = new TestNativeClient();
    Object.assign(db.client, { ready: client.ready.bind(client), readHead: client.readHead.bind(client),
      readHeadRecords: client.readHeadRecords.bind(client), readSnapshotAt: client.readSnapshotAt.bind(client),
      readArtifact: client.readArtifact.bind(client), commit: client.commit.bind(client) });
    const store = db.forTenant('private-tenant-sentinel'), row = record(); await store.put(row);
    const gate = pause(), read = db.client.readHead.bind(db.client);
    db.client.readHead = async () => { await gate.wait(); return read(); };
    fakeClock(); const pending = store.query(filter); await gate.waiting; await vi.advanceTimersByTimeAsync(5000);
    gate.release(); expect((await pending).statements).toEqual([row]);
    expect(stderr).toHaveBeenCalledTimes(2); expect(fetch).not.toHaveBeenCalled();
    for (const [line] of stderr.mock.calls) {
      expect(typeof line).toBe('string'); expect(line).toMatch(/^\[foxxi-lrs\] slow-query /);
      const event = JSON.parse(String(line).slice('[foxxi-lrs] slow-query '.length)) as Record<string, unknown>;
      expect(Object.keys(event).sort()).toEqual(keys);
      for (const value of [capability, privateKey, owner, scope.pod, row.id, 'private-tenant-sentinel']) expect(String(line)).not.toContain(value);
    }
    expect(vi.getTimerCount()).toBe(0); await db.close();
  });
  it('isolates asynchronous errors from the configured logger captured writable', async () => {
    const privateKey = '0x' + '22'.repeat(32), fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected transport request'));
    let writes = 0, reported!: () => void;
    const failedWrite = new Promise<void>(resolve => { reported = resolve; });
    const sink = new Writable({ write(_chunk, _encoding, callback) {
      writes++; setImmediate(() => { callback(new Error('private-asynchronous-pipe-sentinel')); reported(); });
    } });
    // Only factory construction sees this private stream. The worker's real
    // stderr is restored before the query, so test output and OS streams remain normal.
    // Do not attach a test error listener: that would mask the production defect.
    const getStderr = vi.spyOn(process, 'stderr', 'get').mockReturnValue(Object.assign(sink, { fd: 2 as const }) as typeof process.stderr);
    let db: NativeInteregoLrsDatabase;
    try {
      db = createConfiguredNativeLrsDatabase({ NODE_ENV: 'production', FOXXI_LRS_BACKEND: 'interego',
        FOXXI_LRS_NATIVE_POD_URL: scope.pod, FOXXI_LRS_NATIVE_OWNER: owner, FOXXI_LRS_NATIVE_CAPABILITY: 'private-synthetic-capability-sentinel',
        FOXXI_LRS_NATIVE_PRIVATE_KEY: privateKey, FOXXI_LRS_NATIVE_OWNER_PUBLIC_KEY: deriveEncryptionKeyPair(privateKey, owner).publicKey,
        FOXXI_LRS_NATIVE_HEAD_URL: scope.headUrl, FOXXI_LRS_NATIVE_ARTIFACT_CONTAINER: scope.artifactContainer });
    } finally { getStderr.mockRestore(); }
    const client = new TestNativeClient();
    Object.assign(db.client, { ready: client.ready.bind(client), readHead: client.readHead.bind(client),
      readHeadRecords: client.readHeadRecords.bind(client), readSnapshotAt: client.readSnapshotAt.bind(client),
      readArtifact: client.readArtifact.bind(client), commit: client.commit.bind(client) });
    const store = db.forTenant('alice'), row = record(); await store.put(row);
    const gate = pause(), read = db.client.readHead.bind(db.client); db.client.readHead = async () => { await gate.wait(); return read(); };
    fakeClock(); const pending = store.query(filter); await gate.waiting; await vi.advanceTimersByTimeAsync(5000);
    await failedWrite; gate.release(); expect((await pending).statements).toEqual([row]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(writes).toBeGreaterThan(0); expect(sink.destroyed).toBe(true); expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); await db.close();
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
