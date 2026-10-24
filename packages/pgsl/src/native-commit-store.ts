/**
 * Native encrypted PGSL commits. The canonical head atomically publishes a bounded
 * persistent index; application indexes are disposable views of committed holons.
 */
import { createHash } from 'node:crypto';
import { createEncryptedEnvelope, openEncryptedEnvelope, mintNodeId, isPgslNodeId,
  type EncryptionKeyPair, type EncryptedEnvelope, type IRI } from '@interego/core';
import { createPGSL, ingest, mintAtom } from './lattice.js';
import type { PGSLInstance, Node, NodeProvenance } from './types.js';

export const NATIVE_COMMIT_MEDIA_TYPE = 'application/vnd.interego.native-commit+json';
const JSON_TYPE = 'application/json';
const PREFIX = 'urn:interego:native-commit:v1:';
const HEAD = PREFIX + 'head', ENTRY = PREFIX + 'entry', LEAF = PREFIX + 'leaf';
const BRANCH = PREFIX + 'branch', EMPTY = PREFIX + 'empty', PREVIOUS = PREFIX + 'previous';
const REFERENCE = PREFIX + 'reference', OPERATION = PREFIX + 'operation', BYTES = PREFIX + 'bytes';
const ATOMIC = PREFIX + 'atomic-checkpoint';
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
export interface NativeCommitStoreOptions {
  /** Explicit opt-in for an application's bounded rolling checkpoint format.
   * Existing immutable clients refuse this format after a CAS migration. */
  readonly atomicCheckpoint?: boolean;
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
interface DecodedHead extends NativeSnapshot {
  logicalDigest: string; createdAt: string; previous: NativeSnapshotReference | null;
  index: NativeArtifactReference | null;
}
interface IndexLeaf { kind: 'leaf'; entries: Map<string, NativeArtifactReference>; }
interface IndexBranch { kind: 'branch'; children: Map<string, NativeArtifactReference>; }
type IndexNode = IndexLeaf | IndexBranch;

function digest(bytes: Uint8Array | string): string { return 'sha256:' + createHash('sha256').update(bytes).digest('hex'); }
function compareStrings(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function recordSelection(keys: readonly string[]): readonly string[] {
  if (!Array.isArray(keys) || keys.length > 1000) fail('Native record selection exceeds capacity.', 400);
  const selected = new Set<string>();
  for (const key of keys) { bounded(key, 4096, 'record selection key'); selected.add(key); }
  return Object.freeze([...selected].sort(compareStrings));
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
        if (left?.kind !== 'Fragment' || right?.kind !== 'Fragment' || canonical(left.items) !== canonical(node.items.slice(0, -1))
          || canonical(right.items) !== canonical(node.items.slice(1)) || node.height !== Math.max(left.height, right.height) + 1) fail('Native fragment constituents do not match its content.');
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
  constructor(private readonly options: NativeCommitStoreOptions) {
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
  async ready(): Promise<void> {
    let response: Response;
    try { response = await this.options.fetch(this.scope.headUrl, { method: 'OPTIONS', redirect: 'manual' }); }
    catch { return fail('Native atomic resource commits are unavailable.'); }
    if (!response.ok || response.headers.get('Interego-Native-Commit') !== '1'
      || !response.headers.get('Accept-Put')?.split(',').map(s => s.trim()).includes(NATIVE_COMMIT_MEDIA_TYPE)) fail('Native atomic resource commits are unavailable.');
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
    const bytes = Buffer.from(JSON.stringify(createEncryptedEnvelope(Buffer.from(serializeArtifact(artifact)).toString('utf8'), this.recipients, this.options.senderKeyPair)));
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
  /** Every immutable representation is independently native CP-rooted before publication. */
  private async stage(url: string, bytes: Uint8Array, topUri: IRI): Promise<void> {
    try { await this.put(url, bytes, null); } catch (error) { if (!(error instanceof NativeCommitConflictError)) throw error; }
    const existing = await this.readRepresentation(url);
    if (!existing || !Buffer.from(existing.bytes).equals(Buffer.from(bytes))) fail('Native immutable artifact could not be read back unchanged.');
    this.decrypt(existing.bytes, topUri);
  }
  private async persist(artifact: NativeArtifactInput): Promise<NativeArtifactReference> {
    const native = { topUri: artifact.topUri, nodes: artifact.pgsl.nodes }, bytes = this.encrypt(native), bodyDigest = digest(bytes);
    const reference = { resourceUrl: this.resourceUrl('artifact', bodyDigest), bodyDigest, plaintextDigest: digest(serializeArtifact(native)), topUri: artifact.topUri };
    await this.stage(reference.resourceUrl, bytes, reference.topUri);
    return reference;
  }
  async readArtifact(reference: NativeArtifactReference): Promise<NativeArtifact> {
    this.checkReference(reference);
    const stored = await this.readRepresentation(reference.resourceUrl);
    if (!stored || digest(stored.bytes) !== reference.bodyDigest) return fail('Committed native artifact is unavailable or changed.');
    const artifact = this.decrypt(stored.bytes, reference.topUri);
    if (digest(serializeArtifact(artifact)) !== reference.plaintextDigest) fail('Native artifact plaintext binding changed.');
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
  private async indexNode(reference: NativeArtifactReference, prefix: string): Promise<IndexNode> {
    const artifact = await this.readArtifact(reference), row = fields(artifact, artifact.topUri), tag = value(artifact, row[0]);
    if (row.length < 2 || row.length > LEAF_SIZE + 1) fail('Native index node exceeds its bounded fanout.');
    if (tag === LEAF) {
      const entries = new Map<string, NativeArtifactReference>();
      for (const id of row.slice(1)) {
        const entry = this.parseReference(artifact, id, ENTRY); bounded(entry.key, 4300, 'index key');
        if (!hashKey(entry.key).startsWith(prefix) || entries.has(entry.key)) fail('Native index leaf binding changed.');
        entries.set(entry.key, entry.reference);
      }
      return { kind: 'leaf', entries };
    }
    if (tag !== BRANCH || prefix.length >= 64) return fail('Native index branch is malformed.');
    const children = new Map<string, NativeArtifactReference>();
    for (const id of row.slice(1)) {
      const child = this.parseReference(artifact, id, ENTRY);
      if (!/^[a-f0-9]$/.test(child.key) || children.has(child.key)) fail('Native index branch binding changed.');
      children.set(child.key, child.reference);
    }
    return { kind: 'branch', children };
  }
  private async saveIndex(node: IndexNode): Promise<NativeArtifactReference> {
    const pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: new Date().toISOString() });
    const entries = node.kind === 'leaf' ? node.entries : node.children;
    const rows = [...entries].sort(([a], [b]) => compareStrings(a, b)).map(([key, reference]) => this.referenceTuple(pgsl, ENTRY, key, reference));
    const topUri = ingest(pgsl, [literal(pgsl, node.kind === 'leaf' ? LEAF : BRANCH), ...rows]);
    return this.persist({ pgsl, topUri });
  }
  private async buildIndex(entries: Map<string, NativeArtifactReference>, prefix: string): Promise<NativeArtifactReference | null> {
    if (!entries.size) return null;
    if (entries.size <= LEAF_SIZE) return this.saveIndex({ kind: 'leaf', entries });
    if (prefix.length >= 64) return fail('Native index hash collision; existing state was not changed.');
    const groups = new Map<string, Map<string, NativeArtifactReference>>();
    for (const [key, value] of entries) {
      const nibble = hashKey(key)[prefix.length]!;
      if (!groups.has(nibble)) groups.set(nibble, new Map());
      groups.get(nibble)!.set(key, value);
    }
    const children = new Map<string, NativeArtifactReference>();
    for (const [nibble, group] of [...groups].sort(([a], [b]) => compareStrings(a, b))) children.set(nibble, (await this.buildIndex(group, prefix + nibble))!);
    return this.saveIndex({ kind: 'branch', children });
  }
  private async updateIndex(root: NativeArtifactReference | null, changes: Map<string, NativeArtifactReference | null>, prefix = ''): Promise<NativeArtifactReference | null> {
    const node: IndexNode = root ? await this.indexNode(root, prefix) : { kind: 'leaf', entries: new Map() };
    if (node.kind === 'leaf') {
      const entries = new Map(node.entries);
      for (const [key, value] of changes) { if (!hashKey(key).startsWith(prefix)) fail('Native index mutation escaped its branch.'); if (value) entries.set(key, value); else entries.delete(key); }
      return this.buildIndex(entries, prefix);
    }
    const children = new Map(node.children), groups = new Map<string, Map<string, NativeArtifactReference | null>>();
    for (const [key, value] of changes) {
      if (!hashKey(key).startsWith(prefix)) fail('Native index mutation escaped its branch.');
      const nibble = hashKey(key)[prefix.length]!;
      if (!groups.has(nibble)) groups.set(nibble, new Map()); groups.get(nibble)!.set(key, value);
    }
    for (const [nibble, group] of [...groups].sort(([a], [b]) => compareStrings(a, b))) {
      const child = await this.updateIndex(children.get(nibble) ?? null, group, prefix + nibble);
      if (child) children.set(nibble, child); else children.delete(nibble);
    }
    return children.size ? this.saveIndex({ kind: 'branch', children }) : null;
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
  private async records(root: NativeArtifactReference | null): Promise<Map<string, NativeArtifactReference>> {
    const result = new Map<string, NativeArtifactReference>(), seen = new Set<string>();
    const walk = async (reference: NativeArtifactReference, prefix: string): Promise<void> => {
      if (seen.has(reference.resourceUrl)) fail('Native index contains a cycle or duplicate branch.');
      seen.add(reference.resourceUrl);
      const node = await this.indexNode(reference, prefix);
      if (node.kind === 'leaf') { for (const [key, ref] of node.entries) if (key.startsWith('record:')) result.set(key.slice(7), ref); return; }
      for (const [nibble, child] of node.children) await walk(child, prefix + nibble);
    };
    if (root) await walk(root, '');
    return result;
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
    const stored = await this.readRepresentation(reference.commitUrl);
    if (!stored || digest(stored.bytes) !== 'sha256:' + match[1]) return fail('Native commit history is unavailable or changed.');
    return this.decodeHead(stored.bytes, reference.revision, reference.topUri);
  }
  private async current(): Promise<DecodedHead> {
    const stored = await this.readRepresentation(this.scope.headUrl);
    if (!stored) return this.empty();
    const head = this.decodeHead(stored.bytes, stored.revision);
    const archived = await this.archived(head.reference!);
    if (archived.logicalDigest !== head.logicalDigest || archived.operationId !== head.operationId) fail('Native head is not backed by its immutable commit.');
    return head;
  }
  private async complete(head: DecodedHead): Promise<DecodedHead> { return { ...head, records: await this.records(head.index) }; }
  async readHead(): Promise<NativeSnapshot> { return this.complete(await this.current()); }
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
    for (const key of keys) {
      const reference = await this.lookup(head.index, 'record:' + key);
      if (reference) records.set(key, reference);
    }
    return { ...head, records, selectedRecordKeys: keys };
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
    const current = await this.current();
    if (canonical(current.reference) === canonical(reference)) return this.complete(current);
    const archived = await this.archived(reference);
    const retained = await this.operation(archived.operationId!, current);
    if (!retained || canonical(retained.reference) !== canonical(reference)) return fail('Historical snapshot is not in the committed native index.');
    return this.complete(retained);
  }
  private async result(head: DecodedHead, replayed: boolean, receipt: NativeResourceReceipt | null,
    selectedRecordKeys?: readonly string[]): Promise<NativeCommitReceipt> {
    if (!head.reference || !head.operationId) return fail('Native commit receipt lacks a committed head.');
    return { operationId: head.operationId, scope: this.scope, previousHead: head.previous, head: head.reference, createdAt: head.createdAt,
      replayed, snapshot: selectedRecordKeys === undefined ? await this.complete(head) : await this.selected(head, selectedRecordKeys), resourceReceipt: receipt };
  }
  async commit(request: NativeCommitRequest): Promise<NativeCommitReceipt> {
    // Detach caller selection before the first await, including its absence.
    const selectedRecordKeys = request.resultRecordKeys === undefined ? undefined : recordSelection(request.resultRecordKeys);
    bounded(request.operationId, 200, 'operation ID');
    if (canonical(request.expected.scope) !== canonical(this.scope) || !Array.isArray(request.changes) || request.changes.length > 1000) fail('Native mutation scope or capacity is invalid.', 400);
    const changes = [...request.changes].sort((a, b) => compareStrings(a.key, b.key)), keys = new Set<string>();
    for (const change of changes) {
      bounded(change.key, 4096, 'record key'); if (keys.has(change.key)) fail('Native mutation repeats a record key.', 400); keys.add(change.key);
      if (change.artifact) validateNativeArtifact({ topUri: change.artifact.topUri, nodes: change.artifact.pgsl.nodes });
    }
    const logicalDigest = digest(canonical({ scope: this.scope, changes: changes.map(c => ({ key: c.key, plaintextDigest: c.artifact ? digest(serializeArtifact({ topUri: c.artifact.topUri, nodes: c.artifact.pgsl.nodes })) : null })) }));
    const current = await this.current(), prior = await this.operation(request.operationId, current);
    if (prior) { if (prior.logicalDigest !== logicalDigest) fail('Native operation ID was already committed with different content.', 409); return this.result(prior, true, null, selectedRecordKeys); }
    if (current.revision !== request.expected.revision || canonical(current.reference) !== canonical(request.expected.reference)) throw new NativeCommitConflictError();
    await this.ready();
    const indexChanges = new Map<string, NativeArtifactReference | null>();
    for (const change of changes) indexChanges.set('record:' + change.key, change.artifact ? await this.persist(change.artifact) : null);
    if (current.reference) {
      const pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: new Date().toISOString() });
      const topUri = tuple(pgsl, [OPERATION, current.operationId!, current.logicalDigest, current.reference.revision, current.reference.commitUrl, current.reference.topUri]);
      indexChanges.set('operation:' + current.operationId!, await this.persist({ pgsl, topUri }));
    }
    const index = indexChanges.size ? await this.updateIndex(current.index, indexChanges) : current.index;
    const createdAt = new Date().toISOString(), pgsl = createPGSL({ wasAttributedTo: this.scope.owner, generatedAtTime: createdAt });
    const previous = current.reference ? tuple(pgsl, [PREVIOUS, current.reference.revision, current.reference.commitUrl, current.reference.topUri]) : literal(pgsl, EMPTY);
    const indexTuple = index ? this.referenceTuple(pgsl, REFERENCE, 'index', index) : literal(pgsl, EMPTY);
    const topUri = ingest(pgsl, [literal(pgsl, HEAD), literal(pgsl, this.scope.pod), literal(pgsl, this.scope.owner), literal(pgsl, this.scope.headUrl),
      literal(pgsl, request.operationId), literal(pgsl, logicalDigest), literal(pgsl, createdAt), previous, indexTuple]);
    const bytes = this.encrypt({ topUri, nodes: pgsl.nodes }), commitUrl = this.resourceUrl('commit', digest(bytes));
    await this.stage(commitUrl, bytes, topUri);
    let receipt: NativeResourceReceipt | null;
    try { receipt = await this.put(this.scope.headUrl, bytes, current.revision); }
    catch (error) {
      if (!(error instanceof NativeCommitConflictError)) throw error;
      const winner = await this.operation(request.operationId, await this.current());
      if (winner && winner.logicalDigest === logicalDigest) return this.result(winner, true, null, selectedRecordKeys);
      throw error;
    }
    if (!receipt) {
      const recovered = await this.operation(request.operationId, await this.current());
      if (!recovered || recovered.logicalDigest !== logicalDigest) return fail('Native head acknowledgement is uncertain; retry the same operation ID.');
      return this.result(recovered, true, null, selectedRecordKeys);
    }
    const committed = this.decodeHead(bytes, receipt.revision, topUri), actual = await this.readRepresentation(this.scope.headUrl);
    if (!actual || actual.revision !== receipt.revision || !Buffer.from(actual.bytes).equals(Buffer.from(bytes))) {
      const ancestor = await this.operation(request.operationId, await this.current());
      if (!ancestor || ancestor.reference?.revision !== receipt.revision || ancestor.reference.topUri !== topUri || ancestor.logicalDigest !== logicalDigest) return fail('Native committed head could not be verified unchanged.');
    }
    this.decrypt(bytes, topUri);
    return this.result(committed, false, receipt, selectedRecordKeys);
  }
}
