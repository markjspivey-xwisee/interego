/**
 * @interego/pgsl-store — durable, transactional store for the PGSL lattice
 * (FoundationDB layer) + the atom-granular ABAC attribute model.
 *
 * Stage-5 foundation-first: PGSL is the canonical substrate of record; RDF and
 * the W3C Solid surface are projections over it. This package holds the store
 * (FDB), the content-addressing rules, and the access-attribute model.
 *
 * Build status: Stage 0 in progress. Environment-independent core (addressing,
 * codec) landed + unit-tested; the FDB-transactional layer (put/resolve/compose/
 * rehydrate + control-plane) and the mediator-side ABAC project-on-read follow,
 * and require a running FoundationDB (Linux container).
 */

export * from './addressing.js';
