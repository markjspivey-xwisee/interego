/**
 * @interego/mdvault — a GENERAL Markdown-vault -> linked-data projection engine.
 *
 * A directory of Markdown notes carrying YAML-LD frontmatter projects to a graph. The
 * projection is PROFILE-DRIVEN: context-resolution strategy, identity-minting policy,
 * link grammar, and the rung ceiling are knobs a declarative profile sets. "Vault-LD"
 * (github.com/The-Knowledge-Graph-Guys/vault-ld) is ONE such profile — data, published
 * as a dereferenceable graph — never a module in this engine. A second dialect
 * (Obsidian/Foam/OKF) is addable with a new profile + conformance shape, no code change.
 *
 * This barrel currently exports the general, security-critical primitives (path
 * confinement, IRI/identity validation, Turtle escaping) that every profile relies on.
 * Higher layers (frontmatter parse, context composition, identity minting, wiki-link
 * resolution, the rung-<=3 authority gate, note lift, vault orchestration) land on top.
 */
export * from './errors.js';
export * from './paths.js';
export * from './iri.js';
export * from './rung-gate.js';
export * from './frontmatter.js';
export * from './context.js';
export * from './profile.js';
export * from './identity.js';
export * from './wiki.js';
export * from './lift.js';
export * from './atoms.js';
export * from './vault.js';
