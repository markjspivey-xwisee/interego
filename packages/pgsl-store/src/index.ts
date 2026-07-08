/**
 * @interego/pgsl-store — durable, transactional store for the PGSL lattice
 * (FoundationDB layer) + the atom-granular ABAC attribute model.
 *
 * Stage-5 foundation-first: PGSL is the canonical substrate of record; RDF and
 * the W3C Solid surface are projections over it. The store is coded against the
 * `FdbLike` seam so it runs over an in-memory fake (local unit tests, no Docker)
 * and the real FoundationDB binding (production + CI).
 *
 * Landed: content-addressing (public/private dedup split), the FdbLike seam +
 * in-memory transactional fake, and the store's grow-only node writes / resolve
 * / rehydrate / mutable control-plane.
 * Next (same seam, no new env): compose-on-write of a lattice slice, structural
 * indexes, the persistence registry, the AA/AAX ABAC attributes, and the
 * mediator-side ABAC-filtered project-on-read.
 */

export * from './addressing.js';
export * from './fdb-like.js';
export { InMemoryFdb, MemFdbConflict } from './mem-fdb.js';
export * from './node.js';
export {
  PgslStore,
  openStore,
  type PutResult,
  type PutManyResult,
  type ComposeResult,
} from './store.js';
export * from './attributes.js';
export { clearancePdp, type Pdp, type Verdict } from './abac-pdp.js';
export {
  projectHolonFor,
  type ProjectedHolon,
  type ProjectedAtom,
} from './project.js';
export { openRealFdb, type FdbRealOptions } from './fdb-real.js';
export {
  CodecRegistry,
  type Codec,
  type IngestResult,
  type IngestOptions,
} from './codec.js';
export { rdfCodec, splitTurtleStatements, rdfOpaqueUri } from './codec-rdf.js';
export { LdpStore, type LdpResource } from './ldp.js';
export {
  migratePod,
  verifyMigration,
  type SourceResource,
  type MigrationReport,
} from './migrate.js';
