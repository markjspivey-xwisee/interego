/**
 * LdpStore — store-backed LDP resource CRUD: the CORE logic a CSS
 * `PgslDataAccessor` delegates to (read/write/delete a resource, list a
 * container), decoupled from CSS's internal Representation/Components.js types
 * so it is unit-testable with no running CSS.
 *
 * An LDP resource maps to the store as: content nodes via the codec seam (RDF ->
 * opaque byte-atom + structural projection; non-RDF -> a single opaque atom, or,
 * for LARGE payloads, a fragment of fixed-size opaque chunk atoms so a big blob
 * never materializes as one giant base64 string), plus a MUTABLE per-resource
 * record in the control-plane { topUri, opaqueUri, contentType, updatedAt, size,
 * chunkUris?, meta? } keyed by (pod, path). The record is what makes LDP
 * PUT-overwrite and DELETE work over a grow-only content-addressed node store:
 * overwriting repoints the record at the new node(s); the old (still
 * content-addressed) nodes simply become unreferenced.
 *
 * `updatedAt` is surfaced as dc:modified (CSS ETag/Last-Modified). `size` lets a
 * metadata read (stat) avoid materializing the payload. `meta` round-trips any
 * non-derived metadata quads (writeMetadata) so pim:Storage / custom metadata /
 * content-type parameters survive a write->read.
 */

import type { PgslStore } from './store.js';
import type { CodecRegistry, IngestOptions } from './codec.js';
import { atomAddress } from './addressing.js';
import { createHash } from 'node:crypto';
import type { StoredNode } from './node.js';
import {
  assertExpectedResourceRevision, resourceCollection, representationDigest, NativeResourceManagedError,
  type NativeResourceRecord, type NativeResourceCommitResult, type NativeResourceDeleteResult,
} from './resource.js';

export interface LdpResource {
  bytes: Uint8Array;
  size: number;
  meta?: string;
  contentType: string;
  updatedAt: number;
  revision: string;
  bodyDigest: string;
}
/** Metadata about a resource WITHOUT reading its bytes. */
export interface LdpStat {
  revision: string;
  topUri: string;
  opaqueUri: string;
  bodyDigest?: string;
  contentType: string;
  size: number;
  updatedAt: number;
  /** Serialized non-derived metadata quads (N-Quads), if any. */
  meta?: string;
}
/** Direct child of a container + enough to type/size/date it in a listing. */
export interface ChildMeta {
  path: string;
  isContainer: boolean;
  contentType?: string;
  size?: number;
  updatedAt?: number;
}

type ResourceRecord = NativeResourceRecord;

/** Chunk size for large opaque payloads (keeps peak memory + atom size bounded). */
const CHUNK_SIZE = 512 * 1024;

const b64 = (u: Uint8Array): string =>
  Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const bareCt = (ct: string): string => ct.split(';')[0]!.trim();
const containerPrefix = (containerPath: string): string =>
  containerPath === '' || containerPath.endsWith('/') ? containerPath : `${containerPath}/`;

export class LdpStore {
  constructor(
    private readonly store: PgslStore,
    private readonly codecs: CodecRegistry,
  ) {}

  private col(pod: string): string {
    return resourceCollection(pod);
  }

  /** Does a codec (RDF) handle this content-type? (RDF must be drained whole for ingest.) */
  hasCodec(contentType: string): boolean {
    return this.codecs.get(bareCt(contentType)) !== undefined;
  }

  /** Create/overwrite a resource from full bytes. RDF ingests via its codec; any
   *  other type is a single opaque atom (byte-faithful). `contentType` may carry
   *  parameters (e.g. charset) — they are stored + restored; the bare type keys the codec. */
  async writeResource(
    pod: string, path: string, bytes: Uint8Array, contentType: string,
    opts: IngestOptions = {}, meta?: string,
  ): Promise<void> {
    const prepared = this.prepareResource(bytes, contentType, opts, meta);
    await this.replacePrepared(pod, path, prepared.nodes, prepared.record);
  }

  /** Required-precondition native write for atomic commits through the Solid boundary. */
  async commitResource(
    pod: string, path: string, bytes: Uint8Array, contentType: string,
    options: { expectedRevision: string | null; meta?: string },
  ): Promise<NativeResourceCommitResult> {
    assertExpectedResourceRevision(options.expectedRevision);
    const prepared = this.prepareResource(bytes, contentType, {}, options.meta);
    return this.store.commitResource(prepared.nodes, {
      pod, resource: path, record: prepared.record, expectedRevision: options.expectedRevision,
    });
  }

  private prepareResource(bytes: Uint8Array, contentType: string, opts: IngestOptions, meta?: string): {
    nodes: StoredNode[]; record: ResourceRecord;
  } {
    const codec = this.codecs.get(bareCt(contentType));
    const base = { contentType, updatedAt: Date.now(), size: bytes.length, meta, bodyDigest: representationDigest(bytes) };
    if (codec) {
      const ing = codec.ingest(bytes, opts);
      return { nodes: ing.nodes, record: { ...base, topUri: ing.topUri, opaqueUri: ing.opaqueUri } };
    }
    const value = b64(bytes);
    const uri = atomAddress(value, opts);
    return { nodes: [{ uri, kind: 'atom', level: 0, value, provenance: { opaque: true, contentType } }],
      record: { ...base, topUri: uri, opaqueUri: uri } };
  }

  /** Legacy unconditional LDP writes retain replacement semantics, atomically. */
  private async replacePrepared(pod: string, path: string, nodes: StoredNode[], record: ResourceRecord): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.store.resourceHead(pod, path);
      const result = await this.store.commitResource(nodes, {
        pod, resource: path, record, expectedRevision: head?.revision ?? null, legacy: true,
      });
      if (result.status === 'committed') return;
    }
    throw new Error('native resource changed repeatedly during replacement');
  }

  /** Create/overwrite a LARGE opaque resource from a byte stream WITHOUT
   *  materializing it whole: fixed-size chunk atoms + a fragment listing them. */
  async writeStream(
    pod: string,
    path: string,
    source: AsyncIterable<Uint8Array>,
    contentType: string,
    meta?: string,
  ): Promise<void> {
    const chunkNodes: StoredNode[] = [];
    const chunkUris: string[] = [];
    let size = 0;
    const bodyHash = createHash('sha256');
    let buf = Buffer.alloc(0);
    const emit = (chunk: Buffer): void => {
      const value = chunk.toString('base64');
      const uri = atomAddress(value, {});
      chunkNodes.push({ uri, kind: 'atom', level: 0, value, provenance: { opaque: true, contentType, chunk: true } });
      chunkUris.push(uri);
    };
    for await (const piece of source) {
      const p = Buffer.from(piece);
      size += p.length;
      bodyHash.update(p);
      buf = buf.length ? Buffer.concat([buf, p]) : p;
      while (buf.length >= CHUNK_SIZE) {
        emit(buf.subarray(0, CHUNK_SIZE));
        buf = buf.subarray(CHUNK_SIZE);
      }
    }
    if (buf.length > 0 || chunkUris.length === 0) emit(buf); // final (or the empty-resource) chunk
    const fragHex = createHash('sha256').update(`blob:${chunkUris.join('|')}`).digest('hex').slice(0, 40);
    const fragUri = `urn:pgsl:fragment:${fragHex}`;
    const fragNode: StoredNode = { uri: fragUri, kind: 'fragment', level: 1, items: chunkUris };
    await this.replacePrepared(pod, path, [...chunkNodes, fragNode], {
      topUri: fragUri, opaqueUri: fragUri, contentType, updatedAt: Date.now(),
      size, chunkUris, meta, bodyDigest: `sha256:${bodyHash.digest('hex')}`,
    });
  }

  /** Resource metadata WITHOUT reading the payload (null if absent). */
  async stat(pod: string, path: string): Promise<LdpStat | null> {
    const head = await this.store.resourceHead(pod, path);
    if (!head) return null;
    const rec = head.record;
    return { contentType: rec.contentType, size: rec.size ?? 0, updatedAt: rec.updatedAt ?? 0, meta: rec.meta,
      revision: head.revision, topUri: rec.topUri, opaqueUri: rec.opaqueUri, bodyDigest: rec.bodyDigest };
  }

  /** Stream a resource's bytes in order (chunk-by-chunk for large blobs). */
  async *readStream(pod: string, path: string): AsyncIterableIterator<Uint8Array> {
    const head = await this.store.resourceHead(pod, path);
    if (!head) return;
    const rec = head.record;
    const uris = rec.chunkUris?.length ? rec.chunkUris : [rec.opaqueUri];
    const digest = createHash('sha256');
    let size = 0;
    for (const uri of uris) {
      const atom = await this.store.resolve(uri);
      if (!atom || atom.kind !== 'atom' || typeof atom.value !== 'string') throw new Error('native resource payload is unavailable');
      const bytes = unb64(atom.value);
      digest.update(bytes);
      size += bytes.byteLength;
      yield bytes;
    }
    if ((rec.size !== undefined && size !== rec.size)
      || (rec.bodyDigest && `sha256:${digest.digest('hex')}` !== rec.bodyDigest)) throw new Error('native resource payload integrity failed');
  }

  /** Exact bytes and revision from one captured native head; missing payload is not absence. */
  async readResource(pod: string, path: string, maxBytes?: number): Promise<LdpResource | null> {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new Error('native resource read limit must be a safe nonnegative integer');
    }
    const head = await this.store.resourceHead(pod, path);
    if (!head) return null;
    const rec = head.record;
    // The bound is checked on this exact captured head before loading atoms.
    // A separate stat() followed by an unbounded read would race with a writer.
    if (maxBytes !== undefined && (!Number.isSafeInteger(rec.size) || rec.size < 0 || rec.size > maxBytes)) {
      throw new Error('native resource exceeds the requested read limit');
    }
    const uris = rec.chunkUris?.length ? rec.chunkUris : [rec.opaqueUri];
    const parts: Uint8Array[] = [];
    let size = 0;
    for (const uri of uris) {
      const atom = await this.store.resolve(uri);
      if (!atom || atom.kind !== 'atom' || typeof atom.value !== 'string') throw new Error('native resource payload is unavailable');
      if (maxBytes !== undefined && size + Buffer.byteLength(atom.value, 'base64') > maxBytes) {
        throw new Error('native resource exceeds the requested read limit');
      }
      const part = unb64(atom.value);
      size += part.byteLength;
      if (maxBytes !== undefined && size > maxBytes) throw new Error('native resource exceeds the requested read limit');
      parts.push(part);
    }
    const bytes = Buffer.concat(parts);
    const bodyDigest = representationDigest(bytes);
    if ((rec.size !== undefined && bytes.byteLength !== rec.size) || (rec.bodyDigest && bodyDigest !== rec.bodyDigest)) {
      throw new Error('native resource payload integrity failed');
    }
    return { bytes, size: bytes.byteLength, meta: rec.meta, contentType: rec.contentType, updatedAt: rec.updatedAt ?? 0, revision: head.revision, bodyDigest };
  }

  /** Update only the metadata quads of an existing (or newly minimal) resource. */
  async setMeta(pod: string, path: string, meta: string | undefined, contentType?: string): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const head = await this.store.resourceHead(pod, path);
      if (head?.record.nativeManaged) throw new NativeResourceManagedError();
      let bodyDigest = head?.record.bodyDigest;
      if (head && !bodyDigest) {
        const body = await this.readResource(pod, path);
        // Legacy heads may predate representation digests; only use a digest
        // from the identical captured head, otherwise start the CAS attempt again.
        if (!body || body.revision !== head.revision) continue;
        bodyDigest = body.bodyDigest;
      }
      const prepared = head ? {
        nodes: [] as StoredNode[],
        record: { ...head.record, meta, updatedAt: Date.now(), bodyDigest },
      } : this.prepareResource(new Uint8Array(0), contentType ?? 'application/octet-stream', {}, meta);
      const result = await this.store.commitResource(prepared.nodes, {
        pod, resource: path, record: prepared.record, expectedRevision: head?.revision ?? null, legacy: true,
      });
      if (result.status === 'committed') return;
    }
    throw new Error('native resource changed repeatedly during metadata update');
  }

  /**
   * Delete a resource's record and its overlay rows (grow-only content nodes are left in
   * place; the collector in gc.ts reclaims them once nothing points at them).
   */
  async deleteResource(pod: string, path: string): Promise<boolean> {
    return this.store.deleteLegacyResource(pod, path);
  }

  /** Required-precondition deletion of one exact native-managed document head. */
  async deleteResourceConditionally(
    pod: string, path: string, expectedRevision: string,
  ): Promise<NativeResourceDeleteResult> {
    return this.store.deleteResource(pod, path, expectedRevision);
  }

  /** Direct child PATHS of a container (LDP containment derived from the paths). */
  async listContainer(pod: string, containerPath: string): Promise<string[]> {
    return (await this.listChildren(pod, containerPath)).map((c) => c.path);
  }

  /** Direct children of a container WITH per-child type/size/date (from the records). */
  async listChildren(pod: string, containerPath: string): Promise<ChildMeta[]> {
    // The store walks only the direct children (it jumps over each child container's subtree),
    // so a listing costs what the container holds, not what the whole server holds.
    const children = await this.store.cpListChildren<ResourceRecord>(this.col(pod), containerPrefix(containerPath));
    return children
      .map(({ id, branch, value }): ChildMeta => branch
        // A child container; its updatedAt is its marker's, when the marker exists.
        ? { path: id, isContainer: true, updatedAt: value?.updatedAt }
        : { path: id, isContainer: false, contentType: value!.contentType, size: value!.size ?? 0, updatedAt: value!.updatedAt })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** Does the container hold anything at all? One bounded read, for an existence check. */
  async hasChildren(pod: string, containerPath: string): Promise<boolean> {
    return this.store.cpHasUnder(this.col(pod), containerPrefix(containerPath));
  }
}
