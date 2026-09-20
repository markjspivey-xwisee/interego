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

export interface LdpResource {
  bytes: Uint8Array;
  contentType: string;
  updatedAt: number;
}
/** Metadata about a resource WITHOUT reading its bytes. */
export interface LdpStat {
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

interface ResourceRecord {
  topUri: string;
  opaqueUri: string;
  contentType: string;
  updatedAt: number;
  size: number;
  /** Present iff the payload is chunked (large opaque blob) — stream these in order. */
  chunkUris?: string[];
  /** Serialized non-derived metadata quads (N-Quads). */
  meta?: string;
}

/** Chunk size for large opaque payloads (keeps peak memory + atom size bounded). */
const CHUNK_SIZE = 512 * 1024;

const b64 = (u: Uint8Array): string =>
  Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));
const bareCt = (ct: string): string => ct.split(';')[0]!.trim();

export class LdpStore {
  constructor(
    private readonly store: PgslStore,
    private readonly codecs: CodecRegistry,
  ) {}

  private col(pod: string): string {
    return `ldp ${pod}`;
  }

  /** Does a codec (RDF) handle this content-type? (RDF must be drained whole for ingest.) */
  hasCodec(contentType: string): boolean {
    return this.codecs.get(bareCt(contentType)) !== undefined;
  }

  /** Create/overwrite a resource from full bytes. RDF ingests via its codec; any
   *  other type is a single opaque atom (byte-faithful). `contentType` may carry
   *  parameters (e.g. charset) — they are stored + restored; the bare type keys the codec. */
  async writeResource(
    pod: string,
    path: string,
    bytes: Uint8Array,
    contentType: string,
    opts: IngestOptions = {},
    meta?: string,
  ): Promise<void> {
    const codec = this.codecs.get(bareCt(contentType));
    const updatedAt = Date.now();
    let rec: ResourceRecord;
    if (codec) {
      const ing = codec.ingest(bytes, opts);
      await this.store.compose(ing.nodes, { pod, resource: path });
      rec = { topUri: ing.topUri, opaqueUri: ing.opaqueUri, contentType, updatedAt, size: bytes.length, meta };
    } else {
      const value = b64(bytes);
      const uri = atomAddress(value, opts);
      const node: StoredNode = {
        uri,
        kind: 'atom',
        level: 0,
        value,
        provenance: { opaque: true, contentType },
      };
      await this.store.compose([node], { pod, resource: path });
      rec = { topUri: uri, opaqueUri: uri, contentType, updatedAt, size: bytes.length, meta };
    }
    await this.store.cpSet(this.col(pod), path, rec);
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
    await this.store.compose([...chunkNodes, fragNode], { pod, resource: path });
    await this.store.cpSet(this.col(pod), path, {
      topUri: fragUri,
      opaqueUri: fragUri,
      contentType,
      updatedAt: Date.now(),
      size,
      chunkUris,
      meta,
    });
  }

  /** Resource metadata WITHOUT reading the payload (null if absent). */
  async stat(pod: string, path: string): Promise<LdpStat | null> {
    const rec = await this.store.cpGet<ResourceRecord>(this.col(pod), path);
    if (!rec) return null;
    return { contentType: rec.contentType, size: rec.size ?? 0, updatedAt: rec.updatedAt ?? 0, meta: rec.meta };
  }

  /** Stream a resource's bytes in order (chunk-by-chunk for large blobs). */
  async *readStream(pod: string, path: string): AsyncIterableIterator<Uint8Array> {
    const rec = await this.store.cpGet<ResourceRecord>(this.col(pod), path);
    if (!rec) return;
    const uris = rec.chunkUris?.length ? rec.chunkUris : [rec.opaqueUri];
    for (const uri of uris) {
      const atom = await this.store.resolve(uri);
      if (atom && typeof atom.value === 'string') yield unb64(atom.value);
    }
  }

  /** Read a resource's exact bytes + content-type (null if absent). */
  async readResource(pod: string, path: string): Promise<LdpResource | null> {
    const rec = await this.store.cpGet<ResourceRecord>(this.col(pod), path);
    if (!rec) return null;
    const uris = rec.chunkUris?.length ? rec.chunkUris : [rec.opaqueUri];
    const parts: Uint8Array[] = [];
    for (const uri of uris) {
      const atom = await this.store.resolve(uri);
      if (!atom || typeof atom.value !== 'string') return null;
      parts.push(unb64(atom.value));
    }
    return { bytes: Buffer.concat(parts), contentType: rec.contentType, updatedAt: rec.updatedAt ?? 0 };
  }

  /** Update only the metadata quads of an existing (or newly minimal) resource. */
  async setMeta(pod: string, path: string, meta: string | undefined, contentType?: string): Promise<void> {
    const rec = await this.store.cpGet<ResourceRecord>(this.col(pod), path);
    if (rec) {
      rec.meta = meta;
      rec.updatedAt = Date.now();
      await this.store.cpSet(this.col(pod), path, rec);
      return;
    }
    const ct = contentType ?? 'application/octet-stream';
    const value = b64(new Uint8Array(0));
    const uri = atomAddress(value, {});
    await this.store.compose(
      [{ uri, kind: 'atom', level: 0, value, provenance: { opaque: true, contentType: ct } }],
      { pod, resource: path },
    );
    await this.store.cpSet(this.col(pod), path, { topUri: uri, opaqueUri: uri, contentType: ct, updatedAt: Date.now(), size: 0, meta });
  }

  /**
   * Delete a resource's record and its overlay rows (grow-only content nodes are left in
   * place; the collector in gc.ts reclaims them once nothing points at them).
   */
  async deleteResource(pod: string, path: string): Promise<boolean> {
    const existed = (await this.store.cpGet(this.col(pod), path)) !== null;
    await this.store.cpDelete(this.col(pod), path);
    await this.store.clearOverlay(pod, path);
    return existed;
  }

  /** Direct child PATHS of a container (LDP containment derived from the paths). */
  async listContainer(pod: string, containerPath: string): Promise<string[]> {
    return (await this.listChildren(pod, containerPath)).map((c) => c.path);
  }

  /** Direct children of a container WITH per-child type/size/date (from the records). */
  async listChildren(pod: string, containerPath: string): Promise<ChildMeta[]> {
    const prefix =
      containerPath === '' || containerPath.endsWith('/') ? containerPath : `${containerPath}/`;
    const entries = await this.store.cpList<ResourceRecord>(this.col(pod), prefix);
    const direct = new Map<string, ChildMeta>();
    for (const { id, value } of entries) {
      if (id === prefix) continue;
      const rest = id.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        // A direct DOCUMENT child (container markers live at slash-terminated paths).
        const childPath = prefix + rest;
        direct.set(childPath, {
          path: childPath,
          isContainer: false,
          contentType: value.contentType,
          size: value.size ?? 0,
          updatedAt: value.updatedAt,
        });
      } else {
        // A direct CONTAINER child; capture its marker's updatedAt if this entry IS the marker.
        const childPath = `${prefix}${rest.slice(0, slash)}/`;
        const isMarker = rest === `${rest.slice(0, slash)}/`;
        const prev = direct.get(childPath);
        direct.set(childPath, {
          path: childPath,
          isContainer: true,
          updatedAt: isMarker ? value.updatedAt : prev?.updatedAt,
        });
      }
    }
    return [...direct.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}
