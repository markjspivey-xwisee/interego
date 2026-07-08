/**
 * pgsl-css-accessor — a Community Solid Server storage backend that serves the
 * W3C Solid/LDP surface out of the PGSL lattice (foundation-first Stage 5).
 *
 * Exports:
 *  - PgslDataAccessor: the CSS DataAccessor over an already-built LdpStore.
 *  - PgslDataAccessorFactory: a Components.js-constructable DataAccessor that
 *    builds the whole chain (Postgres FdbLike adapter -> PgslStore -> LdpStore)
 *    from a connection string (or PGSL_PG_CONNSTR), for use in a CSS config.
 *
 * componentsjs-generator scans this export to emit dist/components/*.jsonld.
 * Only the factory is exported here (its constructor takes plain strings, so the
 * generator maps it cleanly); PgslDataAccessor is imported by its own module
 * path where needed and is not a Components.js entry point.
 */
export { PgslDataAccessorFactory } from './PgslDataAccessorFactory.js';
