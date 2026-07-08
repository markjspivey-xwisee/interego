/**
 * PgslDataAccessor — a Community Solid Server storage backend backed by the PGSL
 * store (Stage 2). It implements CSS's 8-method `DataAccessor` contract over
 * `LdpStore`, so a running CSS serves LDP/WebID/WAC/etc. UNCHANGED while its
 * storage is the PGSL lattice on FoundationDB. Everything Solid stays above this
 * seam; this only does storage.
 *
 * Kept in an ISOLATED (non-workspace) dir: it depends on @solid/community-server
 * (heavy) + foundationdb (native) which we do NOT want in the main workspace
 * install. It imports pgsl-store's BUILT dist modules directly — and those
 * modules import no @interego/* at runtime (only abac-pdp does, which this does
 * not use), so no @interego resolution is needed here.
 *
 * Tested by exercising these methods against a real FoundationDB in CI
 * (.github/workflows/pgsl-css-accessor.yml). The full Components.js server config
 * is a thin follow-on; this proves the storage integration.
 */

import { Readable } from 'node:stream';
import {
  RepresentationMetadata,
  guardedStreamFrom,
  NotFoundHttpError,
  RDF,
  LDP,
  POSIX,
  type DataAccessor,
  type Representation,
  type ResourceIdentifier,
  type Guarded,
} from '@solid/community-server';
// pgsl-store: built dist modules (no @interego/* runtime deps on this path).
import { LdpStore } from '../../../packages/pgsl-store/dist/ldp.js';

const CONTAINER_MARKER_CT = 'internal/container';

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
    const res = await this.ldp.readResource(this.pod, identifier.path);
    if (!res || res.contentType === CONTAINER_MARKER_CT) throw new NotFoundHttpError();
    return guardedStreamFrom(Buffer.from(res.bytes));
  }

  async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    if (identifier.path.endsWith('/')) {
      const exists =
        (await this.ldp.readResource(this.pod, identifier.path)) !== null ||
        (await this.ldp.listContainer(this.pod, identifier.path)).length > 0;
      if (!exists) throw new NotFoundHttpError();
      const md = new RepresentationMetadata(identifier);
      md.add(RDF.terms.type, LDP.terms.Container);
      md.add(RDF.terms.type, LDP.terms.BasicContainer);
      md.add(RDF.terms.type, LDP.terms.Resource);
      return md;
    }
    const res = await this.ldp.readResource(this.pod, identifier.path);
    if (!res || res.contentType === CONTAINER_MARKER_CT) throw new NotFoundHttpError();
    const md = new RepresentationMetadata(identifier);
    md.contentType = res.contentType;
    md.add(RDF.terms.type, LDP.terms.Resource);
    md.set(POSIX.terms.size, `${res.bytes.length}`);
    return md;
  }

  async *getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    const children = await this.ldp.listContainer(this.pod, identifier.path);
    for (const childPath of children) {
      yield new RepresentationMetadata({ path: childPath });
    }
  }

  async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of data) chunks.push(Buffer.from(chunk));
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const contentType = metadata.contentType ?? 'application/octet-stream';
    await this.ldp.writeResource(this.pod, identifier.path, bytes, contentType);
  }

  async writeContainer(identifier: ResourceIdentifier, _metadata: RepresentationMetadata): Promise<void> {
    // Mark container existence; children come from getChildren (containment
    // triples are generated above this accessor by DataAccessorBasedStore).
    await this.ldp.writeResource(this.pod, identifier.path, new Uint8Array(0), CONTAINER_MARKER_CT);
  }

  async writeMetadata(_identifier: ResourceIdentifier, _metadata: RepresentationMetadata): Promise<void> {
    // Minimal: arbitrary metadata-quad round-trip is a follow-on refinement;
    // content-type + resource type are reconstructed in getMetadata.
  }

  async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    const existed = await this.ldp.deleteResource(this.pod, identifier.path);
    if (!existed) throw new NotFoundHttpError();
  }
}
