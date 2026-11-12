/**
 * Native encrypted PGSL commits. The canonical head atomically publishes a bounded
 * persistent index; application indexes are disposable views of committed holons.
 */
import { createHash } from 'node:crypto';
import { createEncryptedEnvelope, openEncryptedEnvelope, mintNodeId, isPgslNodeId,
  type EncryptionKeyPair, type EncryptedEnvelope, type IRI } from '@interego/core';
import { createPGSL, ingest, mintAtom } from './lattice.js';
import type { PGSLInstance, Node, NodeProvenance } from './types.js';
import { immutableArtifactCache } from './immutable-artifact-cache.js';

export const NATIVE_COMMIT_MEDIA_TYPE = 'application/vnd.interego.native-commit+json';
/** One request that stages several immutable representations into a container, a receipt each. */
export const NATIVE_STAGE_MEDIA_TYPE = 'application/vnd.interego.native-stage+json';
const JSON_TYPE = 'application/json';
const STAGE_BATCH_ITEMS = 64, STAGE_BATCH_BYTES = 4 * 1024 * 1024;
const PREFIX = 'urn:interego:native-commit:v1:';
const HEAD = PREFIX + 'head', ENTRY = PREFIX + 'entry', LEAF = PREFIX + 'leaf';
const BRANCH = PREFIX + 'branch', EMPTY = PREFIX + 'empty', PREVIOUS = PREFIX + 'previous';
const REFERENCE = PREFIX + 'reference', OPERATION = PREFIX + 'operation', BYTES = PREFIX + 'bytes';
const ATOMIC = PREFIX + 'atomic-checkpoint';
/** Media type of a compact index node's payload: canonical JSON inside a byte holon. */
const INDEX_NODE_TYPE = 'application/vnd.interego.native-index-node+json';
const REVISION = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_LIMIT = 8 * 1024 * 1024;
const LEAF_SIZE = 16;

export class NativeCommitError extends Error {
  constructor(message: string, readonly status = 503) { super(message); this.name = 'NativeCommitError'; }
}
/** Only a proven stale native head predicate is a retryable CAS conflict. */
export class NativeCommitConflictError extends NativeCommitError {
  constructor() { super('Native head changed; read it again before retrying.', 412); this.name = 'NativeCommitConflictError'; }
}
export interface NativeCommitScope { readonly pod: string; readonly headUrl: string; readonly artifactContainer: string; readonly owner: IRI; }
export interface NativeArtifactInput { readonly pgsl: PGSLInstance; readonly topUri: IRI; }
export interface NativeArtifact { readonly topUri: IRI; readonly nodes: ReadonlyMap<IRI, Node>; }
export interface NativeArtifactReference { readonly resourceUrl: string; readonly bodyDigest: string; readonly plaintextDigest: string; readonly topUri: IRI; }
export interface NativeSnapshotReference { readonly revision: string; readonly commitUrl: string; readonly topUri: IRI; }
export interface NativeSnapshot {
  readonly scope: NativeCommitScope;
  readonly revision: string | null;
  readonly reference: NativeSnapshotReference | null;
  readonly operationId: string | null;
  readonly records: ReadonlyMap<string, NativeArtifactReference>;
  /** Present only for a selected read: unlisted keys have NOT been checked.
   * Listed missing keys are absent at this same verified native head. */
  readonly selectedRecordKeys?: readonly string[];
}
export interface NativeResourceReceipt {
  readonly version: 1; readonly status: 'committed'; readonly expectedRevision: string | null;
  readonly resource: string; readonly revision: string; readonly bodyDigest: string; readonly contentType: string;
  readonly pod: string; readonly path: string; readonly size: number; readonly updatedAt: number;
  readonly topUri: string; readonly opaqueUri: string;
}
export interface NativeCommitReceipt {
  readonly operationId: string; readonly scope: NativeCommitScope;
  readonly previousHead: NativeSnapshotReference | null; readonly head: NativeSnapshotReference;
  readonly createdAt: string; readonly replayed: boolean; readonly snapshot: NativeSnapshot;
  /** Null only for an operation recovered from the verified committed native index. */
  readonly resourceReceipt: NativeResourceReceipt | null;
}
export interface NativeCommitRequest {
  readonly operationId: string; readonly expected: NativeSnapshot;
  readonly changes: readonly { readonly key: string; readonly artifact: NativeArtifactInput | null }[];
  /** Return only these verified record paths, including on recovered/replayed
   * operations. Omission retains the complete-snapshot API. */
  readonly resultRecordKeys?: readonly string[];
}
export interface NativeCommitClient {
  ready(): Promise<void>;
  readHead(): Promise<NativeSnapshot>;
  /** Optional for compatibility with existing NativeCommitClient adapters. */
  readHeadRecords?(keys: readonly string[]): Promise<NativeSnapshot>;
  readSnapshotAt(reference: NativeSnapshotReference): Promise<NativeSnapshot>;
  readArtifact(reference: NativeArtifactReference): Promise<NativeArtifact>;
  commit(request: NativeCommitRequest): Promise<NativeCommitReceipt>;
}
/** Value-free observations: never expose a head, scope, reference, record or error. */
export interface NativeHeadReadDiagnostic {
  readonly readNumber: number;
  /** 0=current head, 1=historical snapshot. */
  readonly operation: 0 | 1;
  /** 0=progress, 1=complete. */
  readonly event: 0 | 1;
  /** 0=fresh head/backing-commit verification, 1=index materialization. */
  readonly phase: 0 | 1;
  /** 0=ongoing, 1=success, 2=error. */
  readonly outcome: 0 | 1 | 2;
  readonly elapsedMs: number;
  readonly currentMs: number;
  readonly materializationMs: number;
  readonly indexNodes: number;
  readonly indexBranches: number;
  readonly indexLeaves: number;
  readonly peakIndexReads: number;
  readonly indexReadConcurrency: number;
}
/** Value-free observations of one commit: durations, counts and sizes only. Never a head,
 * scope, reference, record key or error text. */
export interface NativeCommitDiagnostic {
  readonly commitNumber: number;
  /** 0=committed, 1=answered from an earlier identical operation, 2=head conflict, 3=other error. */
  readonly outcome: 0 | 1 | 2 | 3;
  /** 1 when the representations were staged through batched requests. */
  readonly batched: 0 | 1;
  /** 1 when the commit started from the caller's verified snapshot instead of reading the head. */
  readonly fromExpected: 0 | 1;
  readonly changes: number;
  readonly elapsedMs: number;
  /** Reading and verifying the head, and looking the operation up in it. */
  readonly headMs: number;
  /** The capability probe; 0 when a recent one was relied on. */
  readonly probeMs: number;
  /** Serializing, encrypting and index building, including reads of index nodes not yet
   * held; everything between the probe and the head write that is not a staging request. */
  readonly buildMs: number;
  readonly stageMs: number;
  readonly stageRequests: number;
  readonly stagedItems: number;
  readonly stagedBytes: number;
  readonly headWriteMs: number;
  readonly headReadMs: number;
  /** Assembling the returned snapshot after the head is published. */
  readonly resultMs: number;
}
export interface NativeCommitStoreOptions {
  /** Optional numeric observation of every commit. Observer failures, including
   * asynchronous rejection, never affect the commit. */
  readonly onCommit?: (event: NativeCommitDiagnostic) => void;
  /** Explicit opt-in for an application's bounded rolling checkpoint format.
   * Existing immutable clients refuse this format after a CAS migration. */
  readonly atomicCheckpoint?: boolean;
  /** Reuse verified immutable artifacts within this client. Heads and staging
   * readbacks remain fresh. Disabled by default for integrity-audit callers. */
  readonly cacheImmutableReads?: boolean;
  /** Opt-in immediate-child prefetch. One limiter is shared by this client's full-index materializations. */
  readonly indexReadConcurrency?: number;
  /** Opt-out of batched staging. A commit stages its changed records, the previous operation's
   * record, the index nodes on the changed paths and the commit object before the head
   * compare-and-set. When the server advertises `Interego-Native-Stage: 1`, they go in one
   * request (several for a large commit) and each is confirmed by a receipt that names it and
   * states the digest, size and type of the bytes it now holds; a missing, extra or mismatched
   * receipt refuses the commit before the head is touched. `true` here, a server that does not
   * advertise the operation, or a batch request that is not answered all stage each
   * representation with its own conditional write and read-back, as before. */
  readonly stageIndividually?: boolean;
  /** Opt-in: how long (0 to 3 600 000 ms; default 0, a probe before every commit) a commit may
   * rely on this client's last successful capability probe instead of sending another.
   * The probe only decides which requests a commit sends; every write is still confirmed by
   * its own receipt or read-back, so a server that changed within the period costs a refused
   * commit or the slower staging path, never an unconfirmed write. `ready()` always probes. */
  readonly capabilityProbeTtlMs?: number;
  /** Opt-in reuse of the immutable commit object that backs a head. Every head read still
   * fetches and verifies the head itself; what is skipped is the second fetch of the
   * content-addressed commit object when this client has already fetched it, or staged it
   * with a confirmation, and checked its digest. The kept bytes are decrypted and compared
   * with the head on every use. As with the other reuse options, a hit no longer shows that
   * the pod still serves that object, so integrity-audit callers leave this off (the default). */
  readonly reuseBackingCommits?: boolean;
  /** Opt-in: a commit whose `expected` is a snapshot object this client itself returned
   * starts from that verified head instead of reading the head again first. A head that has
   * since moved is then caught by the head compare-and-set, after staging and with the same
   * conflict or replay outcome, not before staging. Any other `expected` value, and the
   * default, read and compare the current head first. */
  readonly commitFromExpectedSnapshot?: boolean;
  /** Opt-in: write index nodes in the compact form. An index node holds up to sixteen
   * references. As one wide PGSL tuple, each of those and every contiguous run of them is a
   * node of its own, so sixteen references (about 5 KB) become several hundred nodes and
   * roughly 440 KB of plaintext, and the root node is rewritten by every commit. The compact
   * form is a byte holon (the same five-field tuple `createNativeByteArtifact` makes) whose
   * payload is the canonical JSON of the same references. It is still a content-addressed,
   * validated PGSL holon, encrypted and staged like any other artifact.
   *
   * Every client from this version on READS both forms, whatever this option says, so a
   * store converts gradually as its paths are rewritten and the two kinds of writer can share
   * a head. A client older than this option cannot read a compact node: turn it on only when
   * every reader of the store has been upgraded. */
  readonly compactIndexNodes?: boolean;
  /** Opt-in reuse of decoded index nodes within this client, bounded by the
   * total number of entries retained (least recently used nodes leave first).
   * An index node is immutable and content addressed: it is kept only after it
   * was fetched, digest-checked, decrypted and validated under the exact
   * reference and hash prefix it is later asked for, so a hit proves the same
   * content. The head itself is never cached: every read fetches and verifies
   * the current head, and only nodes it shares with an earlier verified index
   * are reused, so a changed head costs the changed paths, not the whole index.
   * Concurrent reads of one node share a single fetch. What a hit no longer
   * shows is that the pod still serves that artifact, so integrity-audit
   * callers leave this off (the default). */
  readonly indexNodeCacheEntries?: number;
  readonly onHeadRead?: (event: NativeHeadReadDiagnostic) => void;
  /** Already resolved and authorized through the adapter's capability/Type Index contract. */
  readonly scope: NativeCommitScope;
  readonly fetch: typeof globalThis.fetch;
  readonly senderKeyPair: EncryptionKeyPair;
  /** Explicit, verified owner binding; not a key discovered from an unsigned arbitrary URL. */
  readonly ownerPublicKey: string;
  readonly recipientPublicKeys: readonly string[];
  /** CSS's native storage domain is "css"; this is not the logical owner pod URL. */
  readonly storageDomain?: string;
  readonly maxArtifactBytes?: number;
}
export interface NativeAtomicCheckpoint {
  readonly revision: string | null;
  readonly artifact: NativeArtifact | null;
}
interface Representation { bytes: Uint8Array; revision: string; }
/** One commit's representations awaiting a batched staging request. */
interface StagePlan {
  readonly pending: { url: string; bytes: Uint8Array; topUri: IRI }[];
  readonly urls: Set<string>;
  /** Run once everything added so far is confirmed staged. */
  readonly confirmed: (() => void)[];
  bytes: number;
  /** False: each representation is written and read back at once; the plan only meters it. */
  readonly batched: boolean;
  stageMs: number; requests: number; items: number; stagedBytes: number;
}
interface CommitMeter {
  outcome: 0 | 1 | 2 | 3; batched: 0 | 1; fromExpected: 0 | 1; changes: number;
  headMs: number; probeMs: number; buildMs: number; headWriteMs: number; headReadMs: number;
  resultAt?: number; plan?: StagePlan;
}
interface DecodedHead extends NativeSnapshot {
  logicalDigest: string; createdAt: string; previous: NativeSnapshotReference | null;
  index: NativeArtifactReference | null;
}
interface IndexLeaf { kind: 'leaf'; entries: Map<string, NativeArtifactReference>; }
interface IndexBranch { kind: 'branch'; children: Map<string, NativeArtifactReference>; }
type IndexNode = IndexLeaf | IndexBranch;
type IndexReadOutcome = { ok: true; node: IndexNode } | { ok: false; error: unknown };
interface IndexReadContext {
  stopped: boolean; failed: boolean; error?: unknown;
  pending: Set<Promise<IndexReadOutcome>>;
  nodes: number; branches: number; leaves: number; active: number; peak: number;
}
interface IndexReadJob {
  context: IndexReadContext; reference: NativeArtifactReference; prefix: string;
  resolve: (outcome: IndexReadOutcome) => void;
}

function digest(bytes: Uint8Array | string): string { return 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function recordSelection(keys: readonly string[]): readonly string[] {
  if (!Array.isArray(keys) || keys.length > 1000) fail('Native record selection exceeds capacity.', 400);
  const selected = new Set<string>();
  for (const key of keys) { bounded(key, 4096, 'record selection key'); selected.add(key); }
  return Object.freeze([...selected].sort(compareStrings));
}
/** Ordered results from at most `limit` tasks in flight; no task starts after a failure. */
async function mapBounded<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const position = next++;
      try { results[position] = await task(items[position]!); } catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
function hashKey(key: string): string { return createHash('sha256').update(key).digest('hex'); }
function fail(message: string, status = 503): never { throw new NativeCommitError(message, status); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function publicKey(value: string): boolean { try { const bytes = Buffer.from(value, 'base64'); return bytes.length === 32 && bytes.toString('base64') === value; } catch { return false; } }
function bounded(value: unknown, max: number, label: string): asserts value is string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/.test(value)) fail('Invalid native ' + label, 400);
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 128) fail('Native value nesting exceeds capacity.', 413);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonical(v, depth + 1)).join(',') + ']';
  if (object(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
  }
  return fail('Native values must contain finite JSON data.');
}
function uri(value: string): URL {
  let result: URL; try { result = new URL(value); } catch { return fail('Invalid native resource URL.', 400); }
  if (result.protocol !== 'https:' && !(result.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(result.hostname))) fail('Native transport requires HTTPS.', 400);
  if (result.username || result.password || result.search || result.hash || /%2f|%5c|%2e/i.test(result.pathname)) fail('Native resource URL contains unsafe components.', 400);
  return result;
}
function revisionFromEtag(value: string | null): string | null {
  return value?.match(/^"(sha256:[a-f0-9]{64})(?:-[^"\r\n]{1,200})?"$/)?.[1] ?? null;
}
function literal(pgsl: PGSLInstance, value: string): IRI { return mintAtom(pgsl, value); }
function tuple(pgsl: PGSLInstance, values: readonly string[]): IRI { return ingest(pgsl, values.map(v => literal(pgsl, v))); }
function nativeUri(kind: 'atom' | 'fragment', hash: string, actual: string): boolean {
  return actual === mintNodeId(kind, hash) || actual === 'urn:pgsl:' + kind + ':' + hash;
}
function fields(artifact: NativeArtifact, id: IRI): readonly IRI[] {
  const node = artifact.nodes.get(id); if (node?.kind !== 'Fragment') return fail('Native tuple is missing.');
  return node.items;
}
function value(artifact: NativeArtifact, id: IRI | undefined): string {
  const node = id && artifact.nodes.get(id);
  if (!node || node.kind !== 'Atom' || typeof node.value !== 'string') return fail('Native tuple field is not a string atom.');
  return node.value;
}
function valueOrNull(artifact: NativeArtifact, id: IRI | undefined): string | null {
  const node = id && artifact.nodes.get(id);
  return node && node.kind === 'Atom' && typeof node.value === 'string' ? node.value : null;
}

/** Whether `part` is exactly the run of `whole` starting at `offset` that omits one item. */
function sameItems(part: readonly string[], whole: readonly string[], offset: 0 | 1): boolean {
  if (part.length !== whole.length - 1) return false;
  for (let i = 0; i < part.length; i++) if (part[i] !== whole[i + offset]) return false;
  return true;
}
/** Validate content addresses and complete acyclic closure; unrelated nodes are not published. */
export function validateNativeArtifact(artifact: NativeArtifact): NativeArtifact {
  bounded(artifact.topUri, 4096, 'top URI');
  const output = new Map<IRI, Node>(), active = new Set<IRI>();
  const visit = (id: IRI, depth: number): void => {
    if (output.has(id)) return;
    if (depth > 128 || output.size + active.size > 100_000) fail('Native lattice exceeds capacity.', 413);
    if (active.has(id)) fail('Native lattice contains a cycle.');
    const node = artifact.nodes.get(id);
    if (!node || node.uri !== id || !object(node.provenance) || typeof node.provenance.wasAttributedTo !== 'string'
      || !Number.isFinite(Date.parse(node.provenance.generatedAtTime))) fail('Native lattice has a missing or malformed node.');
    active.add(id);
    if (node.kind === 'Atom') {
      if (node.level !== 0 || node.encrypted !== undefined || !['string', 'number', 'boolean'].includes(typeof node.value)
        || (typeof node.value === 'number' && !Number.isFinite(node.value))) fail('Invalid native atom.');
      const hash = createHash('sha256').update('atom:' + String(node.value)).digest('hex').slice(0, 40);
      if (!nativeUri('atom', hash, id)) fail('Native atom content address mismatch.');
    } else if (node.kind === 'Fragment') {
      if (!Array.isArray(node.items) || !Number.isSafeInteger(node.level) || node.level < 1 || node.items.length !== node.level
        || !Number.isSafeInteger(node.height) || node.height < 1) fail('Invalid native fragment.');
      const hash = createHash('sha256').update('fragment:L' + node.level + ':' + node.items.join('|')).digest('hex').slice(0, 40);
      if (!nativeUri('fragment', hash, id)) fail('Native fragment content address mismatch.');
      for (const child of node.items) { if (typeof child !== 'string') fail('Invalid native child URI.'); visit(child, depth + 1); }
      if (node.level === 1 && (node.height !== 1 || node.left !== undefined || node.right !== undefined)) fail('Native level-one fragment metadata is inconsistent.');
      if (node.level > 1) {
        if (!node.left || !node.right) fail('Native fragment lacks constituents.');
        visit(node.left, depth + 1); visit(node.right, depth + 1);
        const left = artifact.nodes.get(node.left), right = artifact.nodes.get(node.right);
        // Both constituents were visited above, so their items are arrays of strings.
        if (left?.kind !== 'Fragment' || right?.kind !== 'Fragment' || !sameItems(left.items, node.items, 0)
          || !sameItems(right.items, node.items, 1) || node.height !== Math.max(left.height, right.height) + 1) fail('Native fragment constituents do not match its content.');
      }
    } else fail('Unknown native node kind.');
    active.delete(id); output.set(id, node);
  };
  visit(artifact.topUri, 0);
  return { topUri: artifact.topUri, nodes: output };
}
function serializeArtifact(input: NativeArtifact): Uint8Array {
  const checked = validateNativeArtifact(input);
  return Buffer.from(canonical({ topUri: checked.topUri, nodes: Object.fromEntries([...checked.nodes].sort(([a], [b]) => compareStrings(a, b))) }));
}
/** Exact bytes live in a typed canonical PGSL holon; there is no auxiliary byte database. */
export function createNativeByteArtifact(input: { owner: IRI; contentType: string; bytes: Uint8Array; provenance?: NodeProvenance }): NativeArtifactInput {
  bounded(input.owner, 4096, 'owner'); bounded(input.contentType, 200, 'content type');
  const pgsl = createPGSL(input.provenance ?? { wasAttributedTo: input.owner, generatedAtTime: new Date().toISOString() });
  const topUri = tuple(pgsl, [BYTES, input.owner, input.contentType, digest(input.bytes), Buffer.from(input.bytes).toString('base64')]);
  return { pgsl, topUri };
}
export function readNativeByteArtifact(input: NativeArtifact): { owner: IRI; contentType: string; bytes: Uint8Array; sha256: string } {
  const artifact = validateNativeArtifact(input), row = fields(artifact, artifact.topUri);
  if (row.length !== 5 || value(artifact, row[0]) !== BYTES) return fail('Not a native byte artifact.');
  const encoded = value(artifact, row[4]), bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || digest(bytes) !== value(artifact, row[3])) fail('Native byte content digest mismatch.');
  return { owner: value(artifact, row[1]) as IRI, contentType: value(artifact, row[2]), bytes, sha256: digest(bytes) };
}

export class NativeCommitStore implements NativeCommitClient {
  private readonly scope: NativeCommitScope;
  private readonly recipients: readonly string[];
  private readonly limit: number;
  private readonly artifactCacheNamespace = {};
  private readonly indexReadConcurrency: number;
  private indexReadsActive = 0;
  private readonly indexReadQueue: IndexReadJob[] = [];
  private headReadSequence = 0;
  private commitSequence = 0;
  private readonly indexNodeCacheLimit: number;
  private readonly verifiedIndexNodes = new Map<string, { node: IndexNode; weight: number }>();
  private verifiedIndexNodeWeight = 0;
  private readonly indexNodeReads = new Map<string, Promise<IndexNode>>();
  private readonly probeTtl: number;
  private probed: { at: number; batchedStaging: boolean } | undefined;
  /** Digest-checked commit objects by URL; a handful, since only recent heads are asked for. */
  private readonly backingCommits = new Map<string, Uint8Array>();
  /** The verified head behind each snapshot object this client handed out. */
  private readonly snapshotHeads = new WeakMap<object, DecodedHead>();
  constructor(private readonly options: NativeCommitStoreOptions) {
    this.probeTtl = options.capabilityProbeTtlMs ?? 0;
    if (!Number.isSafeInteger(this.probeTtl) || this.probeTtl < 0 || this.probeTtl > 3_600_000) fail('Invalid native capability probe period.', 400);
    this.indexNodeCacheLimit = options.indexNodeCacheEntries ?? 0;
    if (!Number.isSafeInteger(this.indexNodeCacheLimit) || this.indexNodeCacheLimit < 0 || this.indexNodeCacheLimit > 4_000_000) fail('Invalid native index node cache capacity.', 400);
    this.indexReadConcurrency = options.indexReadConcurrency ?? 1;
    if (!Number.isSafeInteger(this.indexReadConcurrency) || this.indexReadConcurrency < 1 || this.indexReadConcurrency > 8) fail('Invalid native index read concurrency.', 400);
    const pod = uri(options.scope.pod), head = uri(options.scope.headUrl), container = uri(options.scope.artifactContainer);
    if (!pod.pathname.endsWith('/') || !container.pathname.endsWith('/') || head.origin !== pod.origin || container.origin !== pod.origin
      || !head.pathname.startsWith(pod.pathname) || !container.pathname.startsWith(pod.pathname)) fail('Native resources must remain in the authorized pod scope.', 400);
    bounded(options.scope.owner, 4096, 'owner');
    this.scope = Object.freeze({ ...options.scope, pod: pod.href, headUrl: head.href, artifactContainer: container.href });
    this.recipients = [...new Set(options.recipientPublicKeys)].sort();
    if (!publicKey(options.ownerPublicKey) || this.recipients.some(k => !publicKey(k)) || !this.recipients.includes(options.ownerPublicKey)
      || !this.recipients.includes(options.senderKeyPair.publicKey)) fail('Native storage requires explicit owner and stable reader recipients.', 400);
    this.limit = options.maxArtifactBytes ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1024 || this.limit > DEFAULT_LIMIT) fail('Invalid native capacity.', 400);
  }
  /** Capability discovery only; a verified no-op CAS is the adapter's write-authority check. */
  async ready(): Promise<void> { await this.discover(); }
  /** The same single probe; also whether the server stages several representations in one request. */
  private async discover(): Promise<{ batchedStaging: boolean }> {
    let response: Response;
    try { response = await this.options.fetch(this.scope.headUrl, { method: 'OPTIONS', redirect: 'manual' }); }
    catch { return fail('Native atomic resource commits are unavailable.'); }
    if (!response.ok || response.headers.get('Interego-Native-Commit') !== '1'
      || !response.headers.get('Accept-Put')?.split(',').map(s => s.trim()).includes(NATIVE_COMMIT_MEDIA_TYPE)) fail('Native atomic resource commits are unavailable.');
    this.probed = { at: Date.now(), batchedStaging: response.headers.get('Interego-Native-Stage') === '1' };
    return this.probed;
  }
  private rememberBackingCommit(url: string, bytes: Uint8Array): void {
    if (this.options.reuseBackingCommits !== true) return;
    this.backingCommits.delete(url); this.backingCommits.set(url, Uint8Array.from(bytes));
    while (this.backingCommits.size > 8) this.backingCommits.delete(this.backingCommits.keys().next().value!);
  }
  private target(url: string): URL {
    const parsed = uri(url), pod = uri(this.scope.pod);
    if (parsed.href !== url || parsed.origin !== pod.origin || !parsed.pathname.startsWith(pod.pathname)) fail('Native resource escaped its authorized pod.');
    return parsed;
  }
  private async bytes(response: Response, limit = this.limit): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) { const bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.length > limit) fail('Native representation exceeds capacity.', 413); return bytes; }
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > limit) { await reader.cancel(); fail('Native representation exceeds capacity.', 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  }
  private async readRepresentation(url: string): Promise<Representation | null> {
    this.target(url);
    let response: Response;
    try { response = await this.options.fetch(url, { headers: { Accept: JSON_TYPE, 'Cache-Control': 'no-cache' }, redirect: 'manual' }); }
    catch { return fail('Native resource read is unavailable.'); }
    if (response.status === 404) return null;
    if (!response.ok || response.headers.get('Content-Type')?.split(';')[0]?.trim() !== JSON_TYPE) fail('Native resource is unreadable; no empty-state fallback.');
    const revision = revisionFromEtag(response.headers.get('ETag')), stated = response.headers.get('Interego-Revision'), bytes = await this.bytes(response);
    if (!revision || stated !== revision || response.headers.get('Interego-Body-Digest') !== digest(bytes)) fail('Native read metadata is not bound to its representation.');
    return { bytes, revision };
  }
  private encrypt(artifact: NativeArtifact): Uint8Array {
    return this.encryptPlaintext(serializeArtifact(artifact));
  }
  private encryptPlaintext(plaintext: Uint8Array): Uint8Array {
    const bytes = Buffer.from(JSON.stringify(createEncryptedEnvelope(Buffer.from(plaintext).toString('utf8'), this.recipients, this.options.senderKeyPair)));
    if (bytes.length > this.limit) fail('Encrypted native artifact exceeds capacity.', 413);
    return bytes;
  }
  private decrypt(bytes: Uint8Array, expectedTop?: IRI): NativeArtifact {
    let envelope: EncryptedEnvelope;
    try { envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as EncryptedEnvelope; } catch { return fail('Native ciphertext is malformed.'); }
    const keys = Array.isArray(envelope?.wrappedKeys) ? envelope.wrappedKeys.map(k => k.recipientPublicKey).sort() : [];
    if (envelope.version !== 1 || envelope.algorithm !== 'X25519-XSalsa20-Poly1305' || canonical(keys) !== canonical(this.recipients)) fail('Native ciphertext recipient binding changed.');
    let plaintext: string | null;
    try { plaintext = openEncryptedEnvelope(envelope, this.options.senderKeyPair); } catch { return fail('Native ciphertext cannot be decrypted.'); }
    if (!plaintext) return fail('Native ciphertext cannot be decrypted; no empty-state fallback.');
    let parsed: unknown; try { parsed = JSON.parse(plaintext); } catch { return fail('Native plaintext is malformed.'); }
    if (!object(parsed) || typeof parsed.topUri !== 'string' || !object(parsed.nodes) || Object.keys(parsed.nodes).length > 100_000
      || (expectedTop && parsed.topUri !== expectedTop)) return fail('Native canonical top URI mismatch.');
    const nodes = new Map(Object.entries(parsed.nodes)) as Map<IRI, Node>;
    const artifact = validateNativeArtifact({ topUri: parsed.topUri as IRI, nodes });
    if (artifact.nodes.size !== nodes.size || Buffer.from(serializeArtifact(artifact)).toString('utf8') !== plaintext) fail('Native lattice contains extra or noncanonical data.');
    return artifact;
  }
  private resourceUrl(kind: 'artifact' | 'commit', bodyDigest: string): string {
    if (!REVISION.test(bodyDigest)) return fail('Invalid native body digest.');
    return this.scope.artifactContainer + kind + '-' + bodyDigest.slice(7) + '.json';
  }
  private expectedUrl(url: string, kind: 'artifact' | 'commit', bodyDigest: string): void {
    this.target(url); if (url !== this.resourceUrl(kind, bodyDigest)) fail('Native immutable reference is not content bound.');
  }
  private checkReference(reference: NativeArtifactReference): void {
    this.expectedUrl(reference.resourceUrl, 'artifact', reference.bodyDigest);
    if (!REVISION.test(reference.plaintextDigest) || !isPgslNodeId(reference.topUri)) fail('Native artifact reference is malformed.');
  }
  private receipt(input: unknown, response: Response, url: string, bytes: Uint8Array, expectedRevision: string | null): NativeResourceReceipt {
    this.target(url);
    if (!object(input) || input.version !== 1 || input.status !== 'committed' || input.expectedRevision !== expectedRevision || input.resource !== url
      || input.pod !== (this.options.storageDomain ?? 'css') || input.path !== url || input.contentType !== JSON_TYPE
      || input.bodyDigest !== digest(bytes) || input.size !== bytes.length || typeof input.revision !== 'string' || !REVISION.test(input.revision)
      || input.revision === expectedRevision || revisionFromEtag(response.headers.get('ETag')) !== input.revision
      || typeof input.updatedAt !== 'number' || !Number.isFinite(input.updatedAt) || input.updatedAt < 0
      || typeof input.topUri !== 'string' || !isPgslNodeId(input.topUri) || typeof input.opaqueUri !== 'string' || !isPgslNodeId(input.opaqueUri)) fail('Native commit receipt is not bound to the submitted resource.');
    return input as unknown as NativeResourceReceipt;
  }
  private async put(url: string, bytes: Uint8Array, expectedRevision: string | null): Promise<NativeResourceReceipt | null> {
    this.target(url);
    const headers: Record<string, string> = { 'Content-Type': NATIVE_COMMIT_MEDIA_TYPE, Accept: JSON_TYPE };
    if (expectedRevision === null) headers['If-None-Match'] = '*';
    else { if (!REVISION.test(expectedRevision)) fail('Invalid native expected revision.', 400); headers['If-Match'] = '"' + expectedRevision + '"'; }
    let response: Response;
    try {
      response = await this.options.fetch(url, { method: 'PUT', redirect: 'manual', headers,
        body: JSON.stringify({ version: 1, expectedRevision, contentType: JSON_TYPE, bodyBase64: Buffer.from(bytes).toString('base64') }) });
    } catch { return null; }
    if (response.status === 412) throw new NativeCommitConflictError();
    if (response.status >= 500) return null;
    if (!response.ok) fail('Native commit was not confirmed.');
    let receipt: unknown;
    try { receipt = JSON.parse(Buffer.from(await this.bytes(response, 32_768)).toString('utf8')); } catch { return fail('Native commit acknowledgement is unreadable.'); }
    return this.receipt(receipt, response, url, bytes, expectedRevision);
  }
  /** Every immutable representation is independently native CP-rooted before publication:
   * written and read back here, or, with a plan, confirmed by receipt in flushStaged(). */
  private async stage(url: string, bytes: Uint8Array, topUri: IRI, plan?: StagePlan): Promise<void> {
    if (!plan) return this.stageNow(url, bytes, topUri);
    if (!plan.batched) {
      const started = performance.now();
      try { return await this.stageNow(url, bytes, topUri); }
      finally { plan.stageMs += performance.now() - started; plan.requests += 2; plan.items++; plan.stagedBytes += bytes.length; }
    }
    if (plan.urls.has(url)) return;
    // What a commit holds unstaged is bounded by one request, not by the size of the commit.
    if (plan.pending.length && (plan.pending.length >= STAGE_BATCH_ITEMS || plan.bytes + bytes.length > STAGE_BATCH_BYTES)) await this.flushStaged(plan);
    plan.urls.add(url); plan.pending.push({ url, bytes, topUri }); plan.bytes += bytes.length;
  }
  private async stageNow(url: string, bytes: Uint8Array, topUri: IRI): Promise<void> {
    try { await this.put(url, bytes, null); } catch (error) { if (!(error instanceof NativeCommitConflictError)) throw error; }
    const existing = await this.readRepresentation(url);
    if (!existing || !Buffer.from(existing.bytes).equals(Buffer.from(bytes))) fail('Native immutable artifact could not be read back unchanged.');
    this.decrypt(existing.bytes, topUri);
  }
  /** Returns only when everything the plan holds is confirmed staged; the caller publishes
   * the head after that and not before. */
  private async flushStaged(plan: StagePlan): Promise<void> {
    const items = plan.pending.splice(0), started = performance.now(); plan.bytes = 0;
    try {
      if (items.length) plan.requests++;
      if (items.length && !await this.stageTogether(items)) {
        // Not answered: each representation is confirmed by its own write and read-back instead.
        for (const item of items) { plan.requests += 2; await this.stageNow(item.url, item.bytes, item.topUri); }
      }
    } finally {
      plan.stageMs += performance.now() - started; plan.items += items.length;
      for (const item of items) plan.stagedBytes += item.bytes.length;
    }
    for (const confirmed of plan.confirmed.splice(0)) confirmed();
  }
  /** One request for all of `items`. False when the server did not answer it (nothing is
   * assumed staged). An answer that does not confirm exactly these representations is refused. */
  private async stageTogether(items: readonly { url: string; bytes: Uint8Array; topUri: IRI }[]): Promise<boolean> {
    const container = this.scope.artifactContainer;
    const named = items.map(item => {
      this.target(item.url);
      const name = item.url.slice(container.length);
      if (!item.url.startsWith(container) || !name || name.includes('/')) fail('Native immutable reference is not content bound.');
      return { name, contentType: JSON_TYPE, bodyBase64: Buffer.from(item.bytes).toString('base64') };
    });
    let response: Response;
    try {
      response = await this.options.fetch(container, { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': NATIVE_STAGE_MEDIA_TYPE, Accept: JSON_TYPE }, body: JSON.stringify({ version: 1, items: named }) });
    } catch { return false; }
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* already closed */ } return false; }
    let answer: unknown;
    try { answer = JSON.parse(Buffer.from(await this.bytes(response, 65_536)).toString('utf8')); } catch { return fail('Native staging acknowledgement is unreadable.'); }
    if (!object(answer) || answer.version !== 1 || !Array.isArray(answer.receipts) || answer.receipts.length !== items.length) return fail('Native staging receipts do not cover the submitted representations.');
    items.forEach((item, position) => {
      const receipt: unknown = (answer.receipts as unknown[])[position];
      if (!object(receipt) || receipt.name !== named[position]!.name || receipt.status !== 'staged' || typeof receipt.created !== 'boolean'
        || receipt.bodyDigest !== digest(item.bytes) || receipt.size !== item.bytes.length || receipt.contentType !== JSON_TYPE
        || typeof receipt.revision !== 'string' || !REVISION.test(receipt.revision)) fail('Native staging receipt is not bound to the submitted representation.');
      // The same check a read-back gets: what was confirmed opens to the expected holon.
      this.decrypt(item.bytes, item.topUri);
    });
    return true;
  }
  private async persist(artifact: NativeArtifactInput, plan?: StagePlan): Promise<NativeArtifactReference> {
    return this.persistPlaintext(artifact.topUri, serializeArtifact({ topUri: artifact.topUri, nodes: artifact.pgsl.nodes }), plan);
  }
  private async persistPlaintext(topUri: IRI, plaintext: Uint8Array, plan?: StagePlan): Promise<NativeArtifactReference> {
    const bytes = this.encryptPlaintext(plaintext), bodyDigest = digest(bytes);
    const reference = { resourceUrl: this.resourceUrl('artifact', bodyDigest), bodyDigest, plaintextDigest: digest(plaintext), topUri };
    await this.stage(reference.resourceUrl, bytes, reference.topUri, plan);
    return reference;
  }
  async readArtifact(reference: NativeArtifactReference): Promise<NativeArtifact> {
    this.checkReference(reference);
    // All bindings are part of the key; an alias with a changed plaintext or
    // top URI must not borrow the verification of a different reference.
    const key = JSON.stringify([reference.resourceUrl, reference.bodyDigest, reference.plaintextDigest, reference.topUri]);
    const cached = this.options.cacheImmutableReads === true
      ? immutableArtifactCache.get(this.artifactCacheNamespace, key) : undefined;
    const bytes = cached ?? (await this.readRepresentation(reference.resourceUrl))?.bytes;
    if (!bytes || digest(bytes) !== reference.bodyDigest) return fail('Committed native artifact is unavailable or changed.');
    // Cache ciphertext, never caller-visible mutable node maps. Decryption and
    // both content bindings are checked on every read, including a warm hit.
    const artifact = this.decrypt(bytes, reference.topUri);
    if (digest(serializeArtifact(artifact)) !== reference.plaintextDigest) fail('Native artifact plaintext binding changed.');
    if (!cached && this.options.cacheImmutableReads === true) immutableArtifactCache.set(this.artifactCacheNamespace, key, bytes);
    return artifact;
  }
  private referenceTuple(pgsl: PGSLInstance, tag: string, key: string, reference: NativeArtifactReference): IRI {
    return tuple(pgsl, [tag, key, reference.resourceUrl, reference.bodyDigest, reference.plaintextDigest, reference.topUri]);
  }
  private parseReference(artifact: NativeArtifact, id: IRI, tag: string): { key: string; reference: NativeArtifactReference } {
    const row = fields(artifact, id);
    if (row.length !== 6 || value(artifact, row[0]) !== tag) fail('Native reference tuple is malformed.');
    const reference = { resourceUrl: value(artifact, row[2]), bodyDigest: value(artifact, row[3]), plaintextDigest: value(artifact, row[4]), topUri: value(artifact, row[5]) as IRI };
    this.checkReference(reference);
    return { key: value(artifact, row[1]), reference };
  }
  private indexNodeKey(reference: NativeArtifactReference, prefix: string): string {
    // Every binding and the hash prefix the node was validated under are part
    // of the key: an alias cannot borrow another reference's verification.
    return JSON.stringify([reference.resourceUrl, reference.bodyDigest, reference.plaintextDigest, reference.topUri, prefix]);
  }
  private rememberIndexNode(key: string, node: IndexNode): void {
    if (!this.indexNodeCacheLimit) return;
    const entries = node.kind === 'leaf' ? node.entries : node.children;
    // Snapshots hand these references to callers; a cached one must not change.
    for (const reference of entries.values()) Object.freeze(reference);
    const old = this.verifiedIndexNodes.get(key);
    if (old) { this.verifiedIndexNodes.delete(key); this.verifiedIndexNodeWeight -= old.weight; }
    const weight = entries.size + 1;
    if (weight > this.indexNodeCacheLimit) return;
    this.verifiedIndexNodes.set(key, { node, weight }); this.verifiedIndexNodeWeight += weight;
    while (this.verifiedIndexNodeWeight > this.indexNodeCacheLimit) {
      const oldest = this.verifiedIndexNodes.keys().next().value!;
      this.verifiedIndexNodeWeight -= this.verifiedIndexNodes.get(oldest)!.weight; this.verifiedIndexNodes.delete(oldest);
    }
  }
  /** Nodes returned here are shared and never mutated: writers copy before changing. */
  private async indexNode(reference: NativeArtifactReference, prefix: string): Promise<IndexNode> {
    if (!this.indexNodeCacheLimit) return this.readIndexNode(reference, prefix);
    this.checkReference(reference);
    const key = this.indexNodeKey(reference, prefix), cached = this.verifiedIndexNodes.get(key);
    if (cached) { this.verifiedIndexNodes.delete(key); this.verifiedIndexNodes.set(key, cached); return cached.node; }
    const pending = this.indexNodeReads.get(key);
    if (pending) return pending;
    const read = this.readIndexNode(reference, prefix).then(node => {
      this.indexNodeReads.delete(key); this.rememberIndexNode(key, node); return node;
    }, (error: unknown) => { this.indexNodeReads.delete(key); throw error; });
    this.indexNodeReads.set(key, read);
    return read;
  }
  private async readIndexNode(reference: NativeArtifactReference, prefix: string): Promise<IndexNode> {
    const artifact = await this.readArtifact(reference), row = fields(artifact, artifact.topUri), tag = value(artifact, row[0]);
    // Either form yields (key, reference) pairs; the bindings below are checked on both alike.
    let kind: string, pairs: { key: string; reference: NativeArtifactReference }[];
    if (tag === BYTES) ({ kind, pairs } = this.compactIndexEntries(artifact));
    else {
      if (row.length < 2 || row.length > LEAF_SIZE + 1) fail('Native index node exceeds its bounded fanout.');
      kind = tag; pairs = row.slice(1).map(id => this.parseReference(artifact, id, ENTRY));
    }
    if (kind === LEAF) {
      const entries = new Map<string, NativeArtifactReference>();
      for (const entry of pairs) {
        bounded(entry.key, 4300, 'index key');
        if (!hashKey(entry.key).startsWith(prefix) || entries.has(entry.key)) fail('Native index leaf binding changed.');
        entries.set(entry.key, entry.reference);
      }
      return { kind: 'leaf', entries };
    }
    if (kind !== BRANCH || prefix.length >= 64) return fail('Native index branch is malformed.');
    const children = new Map<string, NativeArtifactReference>();
    for (const child of pairs) {
      if (!/^[a-f0-9]$/.test(child.key) || children.has(child.key)) fail('Native index branch binding changed.');
      children.set(child.key, child.reference);
    }
    return { kind: 'branch', children };
  }
  /** The payload of a compact index node, accepted only as the exact canonical bytes a writer produces. */
  private compactIndexEntries(artifact: NativeArtifact): { kind: string; pairs: { key: string; reference: NativeArtifactReference }[] } {
    const body = readNativeByteArtifact(artifact);
    if (body.owner !== this.scope.owner || body.contentType !== INDEX_NODE_TYPE || body.bytes.length > 262_144) return fail('Native index node owner or type binding changed.');
    const text = Buffer.from(body.bytes).toString('utf8');
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { return fail('Native index node is malformed.'); }
    if (!object(parsed) || Object.keys(parsed).length !== 2 || (parsed.kind !== 'leaf' && parsed.kind !== 'branch')
      || !Array.isArray(parsed.entries) || parsed.entries.length < 1 || parsed.entries.length > LEAF_SIZE) return fail('Native index node exceeds its bounded fanout.');
    const pairs = (parsed.entries as unknown[]).map(entry => {
      if (!Array.isArray(entry) || entry.length !== 5 || entry.some(field => typeof field !== 'string')) return fail('Native index node is malformed.');
      const [key, resourceUrl, bodyDigest, plaintextDigest, topUri] = entry as string[];
      const reference = { resourceUrl: resourceUrl!, bodyDigest: bodyDigest!, plaintextDigest: plaintextDigest!, topUri: topUri as IRI };
      this.checkReference(reference);
      return { key: key!, reference };
    });
    // One encoding per node: sorted by key and canonical, so equal content cannot hide in different bytes.
    if (text !== this.compactIndexPayload(parsed.kind, pairs.map(pair => [pair.key, pair.reference]))) fail('Native index node is not canonical.');
    return { kind: parsed.kind === 'leaf' ? LEAF : BRANCH, pairs };
  }
  private compactIndexPayload(kind: 'leaf' | 'branch', entries: readonly (readonly [string, NativeArtifactReference])[]): string {
    return canonical({ kind, entries: [...entries].sort(([a], [b]) => compareStrings(a, b))
      .map(([key, reference]) => [key, reference.resourceUrl, reference.bodyDigest, reference.plaintextDigest, reference.topUri]) });
  }
  private async saveIndex(node: IndexNode, prefix: string, plan?: StagePlan): Promise<NativeArtifactReference> {
    const entries = node.kind === 'leaf' ? node.entries : node.children;
    let input: NativeArtifactInput;
    if (this.options.compactIndexNodes === true) {
      input = createNativeByteArtifact({ owner: this.scope.owner, contentType: INDEX_NODE_TYPE,
        bytes: Buffer.from(this.compactIndexPayload(node.kind, [...entries])) });
    } else {
      const pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: new Date().toISOString() });
      const rows = [...entries].sort(([a], [b]) => compareStrings(a, b)).map(([key, reference]) => this.referenceTuple(pgsl, ENTRY, key, reference));
      input = { pgsl, topUri: ingest(pgsl, [literal(pgsl, node.kind === 'leaf' ? LEAF : BRANCH), ...rows]) };
    }
    const reference = await this.persist(input, plan);
    // Staging confirmed this exact node and decrypted it; the next head read
    // after this client's own commit need not fetch what it has just verified.
    // With a plan that has not happened yet, so the node is kept only once it has.
    const remember = (): void => this.rememberIndexNode(this.indexNodeKey(reference, prefix), node);
    if (plan?.batched) plan.confirmed.push(remember); else remember();
    return reference;
  }
  private async buildIndex(entries: Map<string, NativeArtifactReference>, prefix: string, plan?: StagePlan): Promise<NativeArtifactReference | null> {
    if (!entries.size) return null;
    if (entries.size <= LEAF_SIZE) return this.saveIndex({ kind: 'leaf', entries }, prefix, plan);
    if (prefix.length >= 64) return fail('Native index hash collision; existing state was not changed.');
    const groups = new Map<string, Map<string, NativeArtifactReference>>();
    for (const [key, value] of entries) {
      const nibble = hashKey(key)[prefix.length]!;
      if (!groups.has(nibble)) groups.set(nibble, new Map());
      groups.get(nibble)!.set(key, value);
    }
    const children = new Map<string, NativeArtifactReference>();
    for (const [nibble, group] of [...groups].sort(([a], [b]) => compareStrings(a, b))) children.set(nibble, (await this.buildIndex(group, prefix + nibble, plan))!);
    return this.saveIndex({ kind: 'branch', children }, prefix, plan);
  }
  private async updateIndex(root: NativeArtifactReference | null, changes: Map<string, NativeArtifactReference | null>, prefix = '', plan?: StagePlan): Promise<NativeArtifactReference | null> {
    const node: IndexNode = root ? await this.indexNode(root, prefix) : { kind: 'leaf', entries: new Map() };
    if (node.kind === 'leaf') {
      const entries = new Map(node.entries);
      for (const [key, value] of changes) { if (!hashKey(key).startsWith(prefix)) fail('Native index mutation escaped its branch.'); if (value) entries.set(key, value); else entries.delete(key); }
      return this.buildIndex(entries, prefix, plan);
    }
    const children = new Map(node.children), groups = new Map<string, Map<string, NativeArtifactReference | null>>();
    for (const [key, value] of changes) {
      if (!hashKey(key).startsWith(prefix)) fail('Native index mutation escaped its branch.');
      const nibble = hashKey(key)[prefix.length]!;
      if (!groups.has(nibble)) groups.set(nibble, new Map()); groups.get(nibble)!.set(key, value);
    }
    for (const [nibble, group] of [...groups].sort(([a], [b]) => compareStrings(a, b))) {
      const child = await this.updateIndex(children.get(nibble) ?? null, group, prefix + nibble, plan);
      if (child) children.set(nibble, child); else children.delete(nibble);
    }
    return children.size ? this.saveIndex({ kind: 'branch', children }, prefix, plan) : null;
  }
  private async lookup(root: NativeArtifactReference | null, key: string): Promise<NativeArtifactReference | null> {
    let reference = root, prefix = '';
    while (reference) {
      const node = await this.indexNode(reference, prefix);
      if (node.kind === 'leaf') return node.entries.get(key) ?? null;
      const nibble = hashKey(key)[prefix.length]!; prefix += nibble; reference = node.children.get(nibble) ?? null;
    }
    return null;
  }
  private stopIndexReads(context: IndexReadContext, error?: unknown): void {
    context.stopped = true;
    if (!context.failed) { context.failed = true; context.error = error; }
    for (let i = this.indexReadQueue.length - 1; i >= 0; i--) {
      const job = this.indexReadQueue[i]!;
      if (job.context === context) { this.indexReadQueue.splice(i, 1); job.resolve({ ok: false, error: context.error }); }
    }
  }
  private pumpIndexReads(): void {
    while (this.indexReadsActive < this.indexReadConcurrency && this.indexReadQueue.length) {
      const job = this.indexReadQueue.shift()!, context = job.context;
      if (context.stopped) { job.resolve({ ok: false, error: context.error }); continue; }
      this.indexReadsActive++; context.active++; context.peak = Math.max(context.peak, context.active);
      const finish = (outcome: IndexReadOutcome): void => {
        if (!outcome.ok) this.stopIndexReads(context, outcome.error);
        this.indexReadsActive--; context.active--; job.resolve(outcome); this.pumpIndexReads();
      };
      void Promise.resolve().then(() => {
        if (context.stopped) throw context.error;
        return this.indexNode(job.reference, job.prefix);
      }).then(node => {
        context.nodes++; if (node.kind === 'branch') context.branches++; else context.leaves++;
        finish({ ok: true, node });
      }, error => finish({ ok: false, error }));
    }
  }
  private prefetchIndexNode(reference: NativeArtifactReference, prefix: string, context: IndexReadContext): Promise<IndexReadOutcome> {
    const pending = new Promise<IndexReadOutcome>(resolve => {
      this.indexReadQueue.push({ context, reference, prefix, resolve }); this.pumpIndexReads();
    });
    context.pending.add(pending);
    void pending.then(() => { context.pending.delete(pending); });
    return pending;
  }
  private async records(root: NativeArtifactReference | null, context: IndexReadContext): Promise<Map<string, NativeArtifactReference>> {
    const result = new Map<string, NativeArtifactReference>(), seen = new Set<string>();
    const walk = async (reference: NativeArtifactReference, prefix: string, prefetched?: Promise<IndexReadOutcome>): Promise<void> => {
      if (context.failed) throw context.error;
      if (seen.has(reference.resourceUrl)) fail('Native index contains a cycle or duplicate branch.');
      seen.add(reference.resourceUrl);
      let node: IndexNode;
      if (this.indexReadConcurrency === 1) {
        node = await this.indexNode(reference, prefix);
        context.nodes++; if (node.kind === 'branch') context.branches++; else context.leaves++;
        context.peak = Math.max(context.peak, 1);
      } else {
        const outcome = await (prefetched ?? this.prefetchIndexNode(reference, prefix, context));
        if (!outcome.ok) throw outcome.error;
        if (context.failed) throw context.error;
        node = outcome.node;
      }
      if (node.kind === 'leaf') { for (const [key, ref] of node.entries) if (key.startsWith('record:')) result.set(key.slice(7), ref); return; }
      // Only this consumed branch's immediate children are prefetched. A prefetched
      // branch cannot schedule grandchildren until DFS reaches it.
      const children = [...node.children];
      const prepared = this.indexReadConcurrency === 1 ? [] : children.map(([nibble, child]) => this.prefetchIndexNode(child, prefix + nibble, context));
      for (let i = 0; i < children.length; i++) {
        const [nibble, child] = children[i]!; await walk(child, prefix + nibble, prepared[i]);
      }
    };
    try { if (root) await walk(root, ''); return result; }
    catch (error) { this.stopIndexReads(context, error); throw error; }
    finally {
      // All speculative results are handled, including failures in siblings DFS
      // never reaches. Cancelled queued jobs settle without waiting for a permit.
      context.stopped = true;
      await Promise.all([...context.pending]);
    }
  }
  private empty(): DecodedHead {
    return { scope: this.scope, revision: null, reference: null, operationId: null, records: new Map(), logicalDigest: '', createdAt: '', previous: null, index: null };
  }
  private decodeHead(bytes: Uint8Array, revision: string, expectedTop?: IRI): DecodedHead {
    const artifact = this.decrypt(bytes, expectedTop), row = fields(artifact, artifact.topUri);
    if (row.length !== 9 || value(artifact, row[0]) !== HEAD || value(artifact, row[1]) !== this.scope.pod
      || value(artifact, row[2]) !== this.scope.owner || value(artifact, row[3]) !== this.scope.headUrl) return fail('Native head scope/owner binding changed.');
    const operationId = value(artifact, row[4]), logicalDigest = value(artifact, row[5]), createdAt = value(artifact, row[6]);
    bounded(operationId, 200, 'operation ID');
    if (!REVISION.test(logicalDigest) || !Number.isFinite(Date.parse(createdAt))) fail('Native commit identity is malformed.');
    let previous: NativeSnapshotReference | null = null;
    if (valueOrNull(artifact, row[7]) !== EMPTY) {
      const prior = fields(artifact, row[7]!);
      if (prior.length !== 4 || value(artifact, prior[0]) !== PREVIOUS) fail('Native previous-head reference is malformed.');
      previous = { revision: value(artifact, prior[1]), commitUrl: value(artifact, prior[2]), topUri: value(artifact, prior[3]) as IRI };
      if (!REVISION.test(previous.revision)) fail('Native previous revision is malformed.');
    }
    const index = valueOrNull(artifact, row[8]) === EMPTY ? null : this.parseReference(artifact, row[8]!, REFERENCE).reference;
    return { scope: this.scope, revision, reference: { revision, commitUrl: this.resourceUrl('commit', digest(bytes)), topUri: artifact.topUri }, operationId, records: new Map(), logicalDigest, createdAt, previous, index };
  }
  private async archived(reference: NativeSnapshotReference): Promise<DecodedHead> {
    if (!REVISION.test(reference.revision)) return fail('Invalid native historical revision.');
    const match = reference.commitUrl.match(/\/commit-([a-f0-9]{64})\.json$/);
    if (!match) return fail('Invalid native commit reference.');
    this.expectedUrl(reference.commitUrl, 'commit', 'sha256:' + match[1]);
    const kept = this.options.reuseBackingCommits === true ? this.backingCommits.get(reference.commitUrl) : undefined;
    const bytes = kept ?? (await this.readRepresentation(reference.commitUrl))?.bytes;
    // The digest and the decryption below are checked on a kept copy exactly as on a fetched one.
    if (!bytes || digest(bytes) !== 'sha256:' + match[1]) return fail('Native commit history is unavailable or changed.');
    const decoded = this.decodeHead(bytes, reference.revision, reference.topUri);
    if (!kept) this.rememberBackingCommit(reference.commitUrl, bytes);
    return decoded;
  }
  private async current(): Promise<DecodedHead> {
    const stored = await this.readRepresentation(this.scope.headUrl);
    if (!stored) return this.empty();
    const head = this.decodeHead(stored.bytes, stored.revision);
    const archived = await this.archived(head.reference!);
    if (archived.logicalDigest !== head.logicalDigest || archived.operationId !== head.operationId) fail('Native head is not backed by its immutable commit.');
    return head;
  }
  private indexReadContext(): IndexReadContext { return { stopped: false, failed: false, pending: new Set(), nodes: 0, branches: 0, leaves: 0, active: 0, peak: 0 }; }
  private async complete(head: DecodedHead, context = this.indexReadContext()): Promise<DecodedHead> {
    const complete = { ...head, records: await this.records(head.index, context) };
    this.snapshotHeads.set(complete, head);
    return complete;
  }
  private async observedHead(operation: 0 | 1, load: () => Promise<DecodedHead>): Promise<NativeSnapshot> {
    if (!this.options.onHeadRead) return this.complete(await load());
    const context = this.indexReadContext(), readNumber = ++this.headReadSequence, started = performance.now();
    let currentDone: number | undefined, reports = 0, outcome: NativeHeadReadDiagnostic['outcome'] = 2;
    const report = (event: NativeHeadReadDiagnostic['event']): void => {
      const now = performance.now();
      const diagnostic: NativeHeadReadDiagnostic = Object.freeze({ readNumber, operation, event,
        phase: currentDone === undefined ? 0 : 1, outcome: event === 0 ? 0 : outcome,
        elapsedMs: Math.round(now - started), currentMs: Math.round((currentDone ?? now) - started),
        materializationMs: currentDone === undefined ? 0 : Math.round(now - currentDone),
        indexNodes: context.nodes, indexBranches: context.branches, indexLeaves: context.leaves,
        peakIndexReads: context.peak, indexReadConcurrency: this.indexReadConcurrency });
      try { void Promise.resolve(this.options.onHeadRead!(diagnostic)).catch(() => {}); } catch { /* Observation is never read authority. */ }
    };
    // At most 24 progress records (six minutes), plus completion. No values or
    // references are retained, and a slow observer cannot block the head read.
    const timer = setInterval(() => { if (++reports <= 24) report(0); else clearInterval(timer); }, 15000);
    timer.unref?.();
    try {
      const head = await load(); currentDone = performance.now();
      const complete = await this.complete(head, context); outcome = 1; return complete;
    } finally { clearInterval(timer); report(1); }
  }
  async readHead(): Promise<NativeSnapshot> { return this.observedHead(0, () => this.current()); }
  /** An explicitly composed bounded checkpoint uses the same encrypted native CAS
   * protocol without creating independently rooted immutable history files.
   * Applications put their explicitly bounded rollback window inside the holon.
   * Migration of an immutable head requires an explicit application CAS. */
  private checkpointScope(): void {
    if (this.options.atomicCheckpoint !== true) fail('Atomic checkpoints require explicit composition.', 400);
  }
  async readAtomicCheckpoint(): Promise<NativeAtomicCheckpoint> {
    this.checkpointScope();
    const stored = await this.readRepresentation(this.scope.headUrl);
    if (!stored) return { revision: null, artifact: null };
    const artifact = this.decrypt(stored.bytes), row = fields(artifact, artifact.topUri);
    if (valueOrNull(artifact, row[0]) !== ATOMIC) {
      // Legacy migration input must be an exact scoped head backed by its
      // immutable commit, not merely a decryptable artifact from this owner.
      const head = this.decodeHead(stored.bytes, stored.revision);
      const archived = await this.archived(head.reference!);
      if (archived.logicalDigest !== head.logicalDigest || archived.operationId !== head.operationId) fail('Native head is not backed by its immutable commit.');
      return { revision: stored.revision, artifact };
    }
    if (row.length !== 6 || value(artifact, row[1]) !== this.scope.owner || value(artifact, row[2]) !== this.scope.pod
      || value(artifact, row[3]) !== this.scope.headUrl || value(artifact, row[4]) !== this.scope.artifactContainer) fail('Atomic checkpoint scope changed.');
    return { revision: stored.revision, artifact: validateNativeArtifact({ topUri: row[5]!, nodes: artifact.nodes }) };
  }
  private atomicCheckpointBytes(input: NativeArtifactInput): { bytes: Uint8Array; artifact: NativeArtifact; topUri: IRI } {
    this.checkpointScope();
    const artifact = validateNativeArtifact({ topUri: input.topUri, nodes: input.pgsl.nodes });
    const body = readNativeByteArtifact(artifact);
    const rollingCheckpointType = body.contentType === 'application/vnd.interego.rolling-checkpoint+gzip'
      || body.contentType === 'application/vnd.interego.rolling-checkpoint-delta-v1+br';
    if (body.owner !== this.scope.owner || !rollingCheckpointType) fail('Atomic checkpoint ownership or type changed.', 400);
    const pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: new Date().toISOString() });
    for (const [id, node] of artifact.nodes) pgsl.nodes.set(id, node);
    const topUri = ingest(pgsl, [ATOMIC, this.scope.owner, this.scope.pod, this.scope.headUrl, this.scope.artifactContainer]
      .map(v => literal(pgsl, v)).concat(artifact.topUri));
    // Wrapper literals share content addresses with submitted atoms such as
    // the owner. Keep the submitted provenance as well as its exact content.
    for (const [id, node] of artifact.nodes) pgsl.nodes.set(id, node);
    const bytes = this.encrypt({ topUri, nodes: pgsl.nodes });
    // A hard per-resource bound also limits superseded physical blocks between
    // successful shared-store collections. Oversize writes preserve the head.
    if (bytes.length > 1024 * 1024) fail('Atomic checkpoint exceeds its 1 MiB storage budget.', 413);
    return { bytes, artifact, topUri };
  }
  /** The encrypted representation's byte length, including scope wrapping.
   * Encryption changes the nonce and ciphertext on each call, but not their
   * encoded lengths. Applications can reserve this size in a durable budget. */
  atomicCheckpointSize(input: NativeArtifactInput): number {
    return this.atomicCheckpointBytes(input).bytes.length;
  }
  async commitAtomicCheckpoint(expectedRevision: string | null, input: NativeArtifactInput,
    options: { readonly maxEncryptedBytes?: number } = {}): Promise<NativeAtomicCheckpoint> {
    this.checkpointScope();
    if (expectedRevision !== null && !REVISION.test(expectedRevision)) fail('Invalid checkpoint revision.', 400);
    const maximum = options.maxEncryptedBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024) fail('Invalid atomic checkpoint byte reservation.', 400);
    const { bytes, artifact, topUri } = this.atomicCheckpointBytes(input);
    if (bytes.length > maximum) fail('Atomic checkpoint exceeds its reserved encrypted bytes.', 413);
    await this.ready();
    await this.put(this.scope.headUrl, bytes, expectedRevision);
    const actual = await this.readRepresentation(this.scope.headUrl);
    if (!actual || !Buffer.from(actual.bytes).equals(Buffer.from(bytes))) fail('Checkpoint outcome is uncertain; recover the same operation before retrying.');
    this.decrypt(actual.bytes, topUri);
    return { revision: actual.revision, artifact };
  }
  /** Verify only requested HAMT paths under ONE verified current head. This
   * does not validate branches outside the explicitly returned selection. */
  private async selected(head: DecodedHead, keys: readonly string[]): Promise<DecodedHead> {
    const records = new Map<string, NativeArtifactReference>();
    // Independent paths under one already verified head: bounded, not serial.
    const found = await mapBounded(keys, this.indexReadConcurrency, key => this.lookup(head.index, 'record:' + key));
    keys.forEach((key, position) => { const reference = found[position]; if (reference) records.set(key, reference); });
    const selected = { ...head, records, selectedRecordKeys: keys };
    this.snapshotHeads.set(selected, head);
    return selected;
  }
  async readHeadRecords(keys: readonly string[]): Promise<NativeSnapshot> {
    const selected = recordSelection(keys);
    return this.selected(await this.current(), selected);
  }
  private async operation(operationId: string, current: DecodedHead): Promise<DecodedHead | null> {
    if (current.operationId === operationId) return current;
    const ref = await this.lookup(current.index, 'operation:' + operationId);
    if (!ref) return null;
    const artifact = await this.readArtifact(ref), row = fields(artifact, artifact.topUri);
    if (row.length !== 6 || value(artifact, row[0]) !== OPERATION || value(artifact, row[1]) !== operationId) return fail('Native operation index is malformed.');
    const reference = { revision: value(artifact, row[3]), commitUrl: value(artifact, row[4]), topUri: value(artifact, row[5]) as IRI };
    const prior = await this.archived(reference);
    if (prior.operationId !== operationId || prior.logicalDigest !== value(artifact, row[2])) fail('Native operation receipt binding changed.');
    return prior;
  }
  async readSnapshotAt(reference: NativeSnapshotReference): Promise<NativeSnapshot> {
    return this.observedHead(1, async () => {
      const current = await this.current();
      if (canonical(current.reference) === canonical(reference)) return current;
      const archived = await this.archived(reference);
      const retained = await this.operation(archived.operationId!, current);
      if (!retained || canonical(retained.reference) !== canonical(reference)) return fail('Historical snapshot is not in the committed native index.');
      return retained;
    });
  }
  private async result(head: DecodedHead, replayed: boolean, receipt: NativeResourceReceipt | null,
    selectedRecordKeys?: readonly string[]): Promise<NativeCommitReceipt> {
    if (!head.reference || !head.operationId) return fail('Native commit receipt lacks a committed head.');
    return { operationId: head.operationId, scope: this.scope, previousHead: head.previous, head: head.reference, createdAt: head.createdAt,
      replayed, snapshot: selectedRecordKeys === undefined ? await this.complete(head) : await this.selected(head, selectedRecordKeys), resourceReceipt: receipt };
  }
  async commit(request: NativeCommitRequest): Promise<NativeCommitReceipt> {
    if (!this.options.onCommit) return this.commitMeasured(request, undefined);
    const meter: CommitMeter = { outcome: 3, batched: 0, fromExpected: 0, changes: 0, headMs: 0, probeMs: 0, buildMs: 0, headWriteMs: 0, headReadMs: 0 };
    const started = performance.now(), commitNumber = ++this.commitSequence;
    try { return await this.commitMeasured(request, meter); }
    catch (error) { meter.outcome = error instanceof NativeCommitConflictError ? 2 : 3; throw error; }
    finally {
      const ended = performance.now(), plan = meter.plan, round = Math.round;
      const event: NativeCommitDiagnostic = Object.freeze({ commitNumber, outcome: meter.outcome, batched: meter.batched, fromExpected: meter.fromExpected,
        changes: meter.changes, elapsedMs: round(ended - started), headMs: round(meter.headMs), probeMs: round(meter.probeMs), buildMs: round(meter.buildMs),
        stageMs: round(plan?.stageMs ?? 0), stageRequests: plan?.requests ?? 0, stagedItems: plan?.items ?? 0, stagedBytes: plan?.stagedBytes ?? 0,
        headWriteMs: round(meter.headWriteMs), headReadMs: round(meter.headReadMs), resultMs: meter.resultAt === undefined ? 0 : round(ended - meter.resultAt) });
      try { void Promise.resolve(this.options.onCommit(event)).catch(() => {}); } catch { /* Observation is never commit authority. */ }
    }
  }
  private async commitMeasured(request: NativeCommitRequest, meter: CommitMeter | undefined): Promise<NativeCommitReceipt> {
    const began = performance.now();
    // Detach caller selection before the first await, including its absence.
    const selectedRecordKeys = request.resultRecordKeys === undefined ? undefined : recordSelection(request.resultRecordKeys);
    bounded(request.operationId, 200, 'operation ID');
    if (canonical(request.expected.scope) !== canonical(this.scope) || !Array.isArray(request.changes) || request.changes.length > 1000) fail('Native mutation scope or capacity is invalid.', 400);
    // Bind keys and canonical digests before I/O without retaining every plaintext buffer.
    const changes = request.changes.map(change => {
      if (!change.artifact) return { key: change.key, artifact: null };
      const native = { topUri: change.artifact.topUri, nodes: change.artifact.pgsl.nodes }, plaintext = serializeArtifact(native);
      if (plaintext.length > this.limit) fail('Encrypted native artifact exceeds capacity.', 413);
      return { key: change.key, artifact: { ...native, plaintextDigest: digest(plaintext) } };
    }).sort((a, b) => compareStrings(a.key, b.key)), keys = new Set<string>();
    for (const change of changes) {
      bounded(change.key, 4096, 'record key'); if (keys.has(change.key)) fail('Native mutation repeats a record key.', 400); keys.add(change.key);
    }
    const logicalDigest = digest(canonical({ scope: this.scope, changes: changes.map(c => ({ key: c.key, plaintextDigest: c.artifact?.plaintextDigest ?? null })) }));
    // Only an object this client returned is trusted as a verified head; a copy reads again.
    const known = this.options.commitFromExpectedSnapshot === true ? this.snapshotHeads.get(request.expected) : undefined;
    const current = known ?? await this.current(), prior = await this.operation(request.operationId, current);
    if (meter) { meter.changes = changes.length; meter.fromExpected = known ? 1 : 0; meter.headMs = performance.now() - began; }
    if (prior) {
      if (prior.logicalDigest !== logicalDigest) fail('Native operation ID was already committed with different content.', 409);
      if (meter) { meter.outcome = 1; meter.resultAt = performance.now(); }
      return this.result(prior, true, null, selectedRecordKeys);
    }
    if (current.revision !== request.expected.revision || canonical(current.reference) !== canonical(request.expected.reference)) throw new NativeCommitConflictError();
    const probing = performance.now();
    const { batchedStaging } = this.probed && Date.now() - this.probed.at < this.probeTtl ? this.probed : await this.discover();
    const batched = batchedStaging && this.options.stageIndividually !== true, building = performance.now();
    // Without batching and without an observer there is no plan, exactly as before.
    const plan: StagePlan | undefined = batched || meter
      ? { pending: [], urls: new Set(), confirmed: [], bytes: 0, batched, stageMs: 0, requests: 0, items: 0, stagedBytes: 0 } : undefined;
    if (meter) { meter.probeMs = building - probing; meter.batched = batched ? 1 : 0; meter.plan = plan; }
    const indexChanges = new Map<string, NativeArtifactReference | null>();
    // Digest reuse is local to this commit's fixed scope, encryption keys and recipients.
    const staged = new Map<string, NativeArtifactReference>();
    for (const change of changes) {
      let reference: NativeArtifactReference | null = null;
      if (change.artifact) {
        const plaintext = serializeArtifact(change.artifact);
        if (digest(plaintext) !== change.artifact.plaintextDigest) fail('Native artifact changed during commit.', 400);
        reference = staged.get(change.artifact.plaintextDigest) ?? await this.persistPlaintext(change.artifact.topUri, plaintext, plan);
        staged.set(change.artifact.plaintextDigest, reference);
      }
      indexChanges.set('record:' + change.key, reference);
    }
    if (current.reference) {
      const pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: new Date().toISOString() });
      const topUri = tuple(pgsl, [OPERATION, current.operationId!, current.logicalDigest, current.reference.revision, current.reference.commitUrl, current.reference.topUri]);
      indexChanges.set('operation:' + current.operationId!, await this.persist({ pgsl, topUri }, plan));
    }
    const index = indexChanges.size ? await this.updateIndex(current.index, indexChanges, '', plan) : current.index;
    const createdAt = new Date().toISOString(), pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: createdAt });
    const previous = current.reference ? tuple(pgsl, [PREVIOUS, current.reference.revision, current.reference.commitUrl, current.reference.topUri]) : literal(pgsl, EMPTY);
    const indexTuple = index ? this.referenceTuple(pgsl, REFERENCE, 'index', index) : literal(pgsl, EMPTY);
    const topUri = ingest(pgsl, [literal(pgsl, HEAD), literal(pgsl, this.scope.pod), literal(pgsl, this.scope.owner), literal(pgsl, this.scope.headUrl),
      literal(pgsl, request.operationId), literal(pgsl, logicalDigest), literal(pgsl, createdAt), previous, indexTuple]);
    const bytes = this.encrypt({ topUri, nodes: pgsl.nodes }), commitUrl = this.resourceUrl('commit', digest(bytes));
    await this.stage(commitUrl, bytes, topUri, plan);
    // Nothing below runs until every representation this head refers to is confirmed staged.
    if (plan?.batched) await this.flushStaged(plan);
    // Confirmed staged, by receipt or read-back: the head about to be published is backed by it.
    this.rememberBackingCommit(commitUrl, bytes);
    const writing = performance.now();
    if (meter) meter.buildMs = writing - building - (plan?.stageMs ?? 0);
    let receipt: NativeResourceReceipt | null;
    try { receipt = await this.put(this.scope.headUrl, bytes, current.revision); }
    catch (error) {
      if (meter) meter.headWriteMs = performance.now() - writing;
      if (!(error instanceof NativeCommitConflictError)) throw error;
      const winner = await this.operation(request.operationId, await this.current());
      if (winner && winner.logicalDigest === logicalDigest) {
        if (meter) { meter.outcome = 1; meter.resultAt = performance.now(); }
        return this.result(winner, true, null, selectedRecordKeys);
      }
      throw error;
    }
    const reading = performance.now();
    if (meter) meter.headWriteMs = reading - writing;
    if (!receipt) {
      const recovered = await this.operation(request.operationId, await this.current());
      if (!recovered || recovered.logicalDigest !== logicalDigest) return fail('Native head acknowledgement is uncertain; retry the same operation ID.');
      if (meter) { meter.outcome = 1; meter.resultAt = performance.now(); }
      return this.result(recovered, true, null, selectedRecordKeys);
    }
    const committed = this.decodeHead(bytes, receipt.revision, topUri), actual = await this.readRepresentation(this.scope.headUrl);
    if (meter) meter.headReadMs = performance.now() - reading;
    if (!actual || actual.revision !== receipt.revision || !Buffer.from(actual.bytes).equals(Buffer.from(bytes))) {
      const ancestor = await this.operation(request.operationId, await this.current());
      if (!ancestor || ancestor.reference?.revision !== receipt.revision || ancestor.reference.topUri !== topUri || ancestor.logicalDigest !== logicalDigest) return fail('Native committed head could not be verified unchanged.');
    }
    this.decrypt(bytes, topUri);
    if (meter) { meter.outcome = 0; meter.resultAt = performance.now(); }
    return this.result(committed, false, receipt, selectedRecordKeys);
  }
}
