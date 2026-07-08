/**
 * PgslDataAccessorFactory — a Components.js-constructable CSS DataAccessor that
 * builds the whole PGSL chain (Postgres FdbLike adapter -> PgslStore -> LdpStore
 * -> PgslDataAccessor) from a single connection string. Simple constructor
 * (connectionString + optional pod), so its Components.js metadata is trivial,
 * and CSS's config just swaps the storage backend's `accessor` to this.
 *
 * The chain is built lazily on first use (openPgStore is async; DI construction
 * is sync), then delegated to. Isolated dir + pgsl-store built dist (accessor
 * path has no @interego/* runtime deps); `pg` is loaded by openPgStore.
 */

import type { Readable } from 'node:stream';
import type {
  DataAccessor,
  Representation,
  RepresentationMetadata,
  ResourceIdentifier,
  Guarded,
} from '@solid/community-server';
import { PgslDataAccessor } from './PgslDataAccessor.js';
import { openPgStore } from '../../../packages/pgsl-store/dist/pg-store.js';
import { openStore } from '../../../packages/pgsl-store/dist/store.js';
import { LdpStore } from '../../../packages/pgsl-store/dist/ldp.js';
import { CodecRegistry } from '../../../packages/pgsl-store/dist/codec.js';
import { rdfCodec } from '../../../packages/pgsl-store/dist/codec-rdf.js';

export class PgslDataAccessorFactory implements DataAccessor {
  private inner?: PgslDataAccessor;
  private building?: Promise<PgslDataAccessor>;

  constructor(
    private readonly connectionString?: string,
    private readonly pod = 'css',
  ) {}

  private async accessor(): Promise<PgslDataAccessor> {
    if (this.inner) return this.inner;
    if (!this.building) {
      this.building = (async () => {
        const fdb = await this.openBackend();
        const ldp = new LdpStore(openStore(fdb), new CodecRegistry().register(rdfCodec));
        this.inner = new PgslDataAccessor(ldp, this.pod);
        return this.inner;
      })();
    }
    return this.building;
  }

  /**
   * Resolve the FdbLike backend. Production: Postgres via the connection string
   * (config param or PGSL_PG_CONNSTR). `PGSL_INMEM=1` selects the in-memory
   * FdbLike fake — used only to smoke-test the full CSS server WIRING
   * (componentsjs descriptor + config + AppRunner + accessor) with no DB.
   */
  private async openBackend() {
    if (process.env.PGSL_INMEM === '1') {
      const { InMemoryFdb } = await import('../../../packages/pgsl-store/dist/mem-fdb.js');
      return new InMemoryFdb();
    }
    const connectionString = this.connectionString ?? process.env.PGSL_PG_CONNSTR;
    if (!connectionString) {
      throw new Error(
        'PgslDataAccessorFactory: no Postgres connection string (set PGSL_PG_CONNSTR or pass connectionString, or PGSL_INMEM=1 for the in-memory backend)',
      );
    }
    return openPgStore({ connectionString });
  }

  async canHandle(representation: Representation): Promise<void> {
    return (await this.accessor()).canHandle(representation);
  }
  async getData(identifier: ResourceIdentifier): Promise<Guarded<Readable>> {
    return (await this.accessor()).getData(identifier);
  }
  async getMetadata(identifier: ResourceIdentifier): Promise<RepresentationMetadata> {
    return (await this.accessor()).getMetadata(identifier);
  }
  getChildren(identifier: ResourceIdentifier): AsyncIterableIterator<RepresentationMetadata> {
    // Delegate lazily: build the accessor, then yield from its generator.
    const self = this;
    return (async function* () {
      const acc = await self.accessor();
      yield* acc.getChildren(identifier);
    })();
  }
  async writeDocument(
    identifier: ResourceIdentifier,
    data: Guarded<Readable>,
    metadata: RepresentationMetadata,
  ): Promise<void> {
    return (await this.accessor()).writeDocument(identifier, data, metadata);
  }
  async writeContainer(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    return (await this.accessor()).writeContainer(identifier, metadata);
  }
  async writeMetadata(identifier: ResourceIdentifier, metadata: RepresentationMetadata): Promise<void> {
    return (await this.accessor()).writeMetadata(identifier, metadata);
  }
  async deleteResource(identifier: ResourceIdentifier): Promise<void> {
    return (await this.accessor()).deleteResource(identifier);
  }
}
