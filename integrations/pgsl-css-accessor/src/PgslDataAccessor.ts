/**
 * PgslDataAccessor — a Community Solid Server storage backend backed by the PGSL
 * store. It implements CSS's 8-method `DataAccessor` contract over `LdpStore`, so
 * a running CSS serves LDP/WebID/WAC/etc. UNCHANGED while its storage is the PGSL
 * lattice on Postgres/FoundationDB. Everything Solid stays above this seam.
 *
 * Contract fidelity (mirrors CSS's FileDataAccessor):
 *  - documents + containers carry dc:modified -> ETag/Last-Modified/304/If-Match;
 *  - getMetadata reads a STAT (no payload materialization) + re-hydrates any
 *    persisted non-derived metadata quads (pim:Storage / custom / content-type
 *    parameters survive write->read via writeMetadata/writeDocument);
 *  - getChildren yields per-child rdf:type + posix:size + dc:modified;
 *  - large non-RDF payloads stream in fixed-size chunks (getData/writeDocument
 *    never materialize a whole big blob).
 *
 * Isolated (non-workspace) dir: depends on the heavy @solid/community-server and
 * imports pgsl-store's BUILT dist directly (no @interego/* runtime deps here).
 */

import { Readable } from 'node:stream';
import {
  RepresentationMetadata,
  guardStream,
  NotFoundHttpError,
  serializeQuads,
  parseQuads,
  readableToString,
  parseContentType,
  RDF,
  LDP,
  POSIX,
  DC,
  IANA,
  CONTENT_TYPE_TERM,
  SOLID_META,
  toNamedTerm,
  type DataAccessor,
  type Representation,
  type ResourceIdentifier,
  type Guarded,
} from '@solid/community-server';
// pgsl-store: built dist modules (no @interego/* runtime deps on this path).
import { LdpStore } from '../../../packages/pgsl-store/dist/ldp.js';

const CONTAINER_MARKER_CT = 'internal/container';
const NQUADS = 'application/n-quads';

export class PgslDataAccessor implements DataAccessor {
  constructor(
    private readonly ldp: LdpStore,
    private readonly pod = 'css',
  ) {}

  // Streams are only copied, never inspected, so all data is supported.
  async canHandle(_representation: Representation): Promise<void> {
    /* accept all */
  }

  async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    const st = await this.ldp.stat(this.pod, identifier.path);
    if (!st || st.contentType === CONTAINER_MARKER_CT) throw new NotFoundHttpError();
    // BYTE-mode stream of Buffers (large blobs never materialize whole). Mapping to
    // Buffer + objectMode:false is required — a bare Readable.from(gen) over
    // Uint8Arrays yields an OBJECT-mode stream, so byte consumers (readableToString)
    // read the numeric array text ("123,34,...") instead of the actual bytes.
    const src = this.ldp.readStream(this.pod, identifier.path);
    const bytes = (async function* () {
      for await (const chunk of src) yield Buffer.from(chunk);
    })();
    return guardStream(Readable.from(bytes, { objectMode: false }));
  }

  async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    if (identifier.path.endsWith('/')) {
      const st = await this.ldp.stat(this.pod, identifier.path);
      const exists = st !== null || (await this.ldp.listChildren(this.pod, identifier.path)).length > 0;
      if (!exists) throw new NotFoundHttpError();
      const md = await this.baseMetadata(identifier, st?.meta);
      md.add(RDF.terms.type, LDP.terms.Container);
      md.add(RDF.terms.type, LDP.terms.BasicContainer);
      md.add(RDF.terms.type, LDP.terms.Resource);
      // dc:modified -> container ETag/Last-Modified/304/If-Match (CSS refreshes the
      // marker's timestamp on every child add/delete).
      if (st) md.set(DC.terms.modified, new Date(st.updatedAt).toISOString());
      return md;
    }
    const st = await this.ldp.stat(this.pod, identifier.path);
    if (!st || st.contentType === CONTAINER_MARKER_CT) throw new NotFoundHttpError();
    const md = await this.baseMetadata(identifier, st.meta);
    this.setContentType(md, st.contentType);
    md.add(RDF.terms.type, LDP.terms.Resource);
    md.set(POSIX.terms.size, `${st.size}`);
    // dc:modified -> CSS's BasicETagHandler emits an ETag ("<mtime>-<ct>") so
    // If-Match/If-None-Match optimistic concurrency (the manifest CAS) works.
    md.set(DC.terms.modified, new Date(st.updatedAt).toISOString());
    return md;
  }

  async *getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    for (const child of await this.ldp.listChildren(this.pod, identifier.path)) {
      const md = new RepresentationMetadata({ path: child.path });
      md.add(RDF.terms.type, LDP.terms.Resource);
      if (child.isContainer) {
        md.add(RDF.terms.type, LDP.terms.Container);
        md.add(RDF.terms.type, LDP.terms.BasicContainer);
      } else {
        if (typeof child.size === 'number') md.set(POSIX.terms.size, `${child.size}`);
        // Contained-resource media-type hint (per the Solid contained-resource
        // metadata note), guarded against an invalid content-type.
        if (child.contentType && child.contentType !== CONTAINER_MARKER_CT) {
          try {
            md.add(RDF.terms.type, toNamedTerm(`${IANA.namespace}${child.contentType.split(';')[0]!.trim()}#Resource`));
          } catch {
            /* skip an unmappable content-type */
          }
        }
      }
      if (child.updatedAt) md.set(DC.terms.modified, new Date(child.updatedAt).toISOString());
      yield md;
    }
  }

  async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const contentType = this.fullContentType(metadata) ?? 'application/octet-stream';
    const meta = await this.extractMeta(metadata);
    if (this.ldp.hasCodec(contentType)) {
      // RDF must be drained whole for the codec ingest (RDF resources are small).
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(Buffer.from(chunk));
      await this.ldp.writeResource(this.pod, identifier.path, new Uint8Array(Buffer.concat(chunks)), contentType, {}, meta);
    } else {
      // Non-RDF: chunked stream (a large blob never materializes whole).
      await this.ldp.writeStream(this.pod, identifier.path, data, contentType, meta);
    }
  }

  async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    // Marker for existence + persist any non-derived container metadata (pim:Storage on the root).
    const meta = await this.extractMeta(metadata);
    await this.ldp.writeResource(this.pod, identifier.path, new Uint8Array(0), CONTAINER_MARKER_CT, {}, meta);
  }

  async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    const ct = identifier.path.endsWith('/') ? CONTAINER_MARKER_CT : this.fullContentType(metadata);
    const meta = await this.extractMeta(metadata);
    await this.ldp.setMeta(this.pod, identifier.path, meta, ct);
  }

  async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const existed = await this.ldp.deleteResource(this.pod, identifier.path);
    if (!existed) throw new NotFoundHttpError();
  }

  // ── helpers ──

  /** Base metadata = a fresh object re-hydrated with any persisted non-derived quads. */
  private async baseMetadata(identifier: ResourceIdentifier, meta?: string): Promise<RepresentationMetadata> {
    const md = new RepresentationMetadata(identifier);
    if (meta) {
      // N-Quads auto-detects (TriG-family) — no explicit format needed.
      const quads = await parseQuads(guardStream(Readable.from([meta])));
      md.addQuads(quads);
    }
    return md;
  }

  /** The full content-type incl. parameters (charset etc.), or undefined. */
  private fullContentType(metadata: RepresentationMetadata): string | undefined {
    return metadata.contentTypeObject?.toHeaderValueString() ?? metadata.contentType;
  }

  /** Set a (possibly parameterized) content-type on the response metadata. */
  private setContentType(md: RepresentationMetadata, full: string): void {
    try {
      md.contentTypeObject = parseContentType(full);
    } catch {
      md.contentType = full.split(';')[0]!.trim();
    }
  }

  /** Serialize the non-derived metadata quads to persist (mirrors FileDataAccessor.writeMetadataFile). */
  private async extractMeta(metadata: RepresentationMetadata): Promise<string | undefined> {
    metadata.remove(RDF.terms.type, LDP.terms.Resource);
    metadata.remove(RDF.terms.type, LDP.terms.Container);
    metadata.remove(RDF.terms.type, LDP.terms.BasicContainer);
    metadata.removeAll(DC.terms.modified);
    metadata.removeAll(POSIX.terms.size);
    metadata.removeAll(CONTENT_TYPE_TERM); // content-type is stored on the record
    // Response-only metadata (ldp:contains, WAC-Allow, ...) must never persist.
    const quads = metadata
      .quads()
      .filter((q) => q.graph.value !== SOLID_META.terms.ResponseMetadata.value);
    if (quads.length === 0) return undefined;
    return readableToString(serializeQuads(quads, NQUADS));
  }
}
