/**
 * node-id.ts — the PGSL node identifier scheme, in ONE place.
 *
 * A PGSL node id is content-addressed and now a DEREFERENCEABLE URL: it both DENOTES
 * (a stable, location-independent identity — same content, same id on every pod) and
 * RESOLVES TO CONNOTATION (following it reaches the node's description, via the relay
 * authority that redirects to a public-lattice resolver, the w3id.org / PURL pattern).
 * That is the standing principle: every identifier is a dereferenceable URL, not a urn.
 *
 *   https://relay.interego.xwisee.com/ns/pgsl/<kind>/<hash>      kind ∈ {atom,fragment,metagraph}
 *
 * The authority is a COMPILE-TIME constant, never env-derived: a mutable authority
 * would mint different ids for the same content in dev vs prod and split the
 * federation-overlap corpus. It is a NAMING authority (like w3id.org), not the
 * location of a data copy, so the id stays location-independent.
 *
 * DUAL-READ. Every corpus persisted before this scheme holds the legacy
 * `urn:pgsl:<kind>:<hash>` form. `isPgslNodeId` / `pgslNodeKind` / `pgslNodeHash`
 * accept BOTH — a node reference is recognised by SCHEME, never by local-map
 * membership (a membership test would atomize a remote/forward reference as a literal
 * value and silently poison the lattice). The hash is identical across schemes for an
 * atom (its hash is over the value); a fragment's hash cascades over its item ids, so a
 * lattice's fragments are consistent within one scheme.
 */

/** The resolving canonical authority for a PGSL node id. Must match the relay route
 *  (GET /ns/pgsl/:kind/:hash) and describe.ts's pgslCanonicalUrl. */
export const PGSL_ID_AUTHORITY = 'https://relay.interego.xwisee.com/ns/pgsl' as const;
/** The legacy identifier scheme, still READ everywhere (never re-minted). */
export const LEGACY_PGSL_PREFIX = 'urn:pgsl:' as const;

export type PgslNodeKind = 'atom' | 'fragment' | 'metagraph';

/** Mint a node id under the current (URL) scheme from a content hash. */
export function mintNodeId(kind: PgslNodeKind, hash: string): string {
  return `${PGSL_ID_AUTHORITY}/${kind}/${hash}`;
}

/** True if `x` is a PGSL node id — the current URL scheme OR the legacy urn. This is
 *  the correct ingest/routing discriminator: identity by scheme, not by map membership.
 *  Returns a plain boolean (not a `x is string` predicate) so it never over-narrows an
 *  already-string argument's else-branch to `never`. */
export function isPgslNodeId(x: unknown): boolean {
  return typeof x === 'string' && (x.startsWith(`${PGSL_ID_AUTHORITY}/`) || x.startsWith(LEGACY_PGSL_PREFIX));
}

/** Parse the kind of a node id (either scheme), or null if not a node id. */
export function pgslNodeKind(x: string): PgslNodeKind | null {
  if (x.startsWith(LEGACY_PGSL_PREFIX)) {
    const k = x.slice(LEGACY_PGSL_PREFIX.length).split(':', 1)[0];
    return k === 'atom' || k === 'fragment' || k === 'metagraph' ? k : null;
  }
  if (x.startsWith(`${PGSL_ID_AUTHORITY}/`)) {
    const rest = x.slice(PGSL_ID_AUTHORITY.length + 1);
    const k = rest.split('/', 1)[0];
    return k === 'atom' || k === 'fragment' || k === 'metagraph' ? k : null;
  }
  return null;
}

/** Parse the content hash of a node id (either scheme), or null if not a node id. The
 *  hash is the last '/'-or-':' segment — identical whether urn or URL scheme. */
export function pgslNodeHash(x: string): string | null {
  if (x.startsWith(LEGACY_PGSL_PREFIX)) {
    const parts = x.split(':');
    return parts.length >= 4 ? parts[parts.length - 1]! : null;
  }
  if (x.startsWith(`${PGSL_ID_AUTHORITY}/`)) {
    const seg = x.split('/');
    return seg[seg.length - 1] || null;
  }
  return null;
}

/** Re-express a legacy urn node id under the current URL scheme (idempotent — a URL
 *  id is returned unchanged; a non-node-id is returned unchanged). Deterministic:
 *  same input, same output, on every pod. */
export function toCanonicalNodeId(x: string): string {
  const m = /^urn:pgsl:(atom|fragment|metagraph):(.+)$/.exec(x);
  return m ? mintNodeId(m[1] as PgslNodeKind, m[2]!) : x;
}
