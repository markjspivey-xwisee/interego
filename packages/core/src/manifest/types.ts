/**
 * @module manifest/types
 * @description Substrate-level shape of a manifest row.
 *
 * The Solid binding writes a `.well-known/context-graphs` manifest that
 * lists every published descriptor with the columns below. The fields
 * are protocol-shaped (descriptor URL, described graphs, facet types,
 * temporal range, modal status, trust level, supersedes chain, PGSL
 * structural URI), so the type sits in the substrate even though the
 * binding that produces it ships in `@interego/solid`.
 *
 * Keeping the type in core lets the kernel's `dereference` verb and the
 * generic affordance follower work against ManifestEntry rows without
 * importing the Solid binding.
 */

import type {
  ContextTypeName,
  TrustLevel,
  ModalStatus,
  ContextFacetData,
} from '../model/types.js';

/** A single entry from the context-graphs manifest. */
export interface ManifestEntry {
  /** IRI of the context descriptor resource. */
  readonly descriptorUrl: string;
  /**
   * Content-addressable identity of this descriptor's Turtle body.
   * Mirrored on the manifest row at publish time so CAS supersession
   * gates (`checkSupersessionPrecondition`) can compare `if_match`
   * against the head CID without a round-trip body GET + rehash. The
   * manifest is already the head pointer; mirroring the CID makes it
   * the head identity too, which closes the precondition fully inside
   * one manifest fetch.
   *
   * Optional — legacy entries written before this field landed are
   * still valid; consumers (the precondition gate) fall back to a
   * descriptor-body fetch + recompute when this field is absent.
   */
  readonly cid?: string;
  /** IRIs of the named graphs this descriptor covers. */
  readonly describes: readonly string[];
  /** Facet types present on this descriptor. */
  readonly facetTypes: readonly ContextTypeName[];
  /** Temporal validity start (if declared). */
  readonly validFrom?: string;
  /** Temporal validity end (if declared). */
  readonly validUntil?: string;
  /** Modal status from the Semiotic facet (if present). */
  readonly modalStatus?: ModalStatus;
  /** Trust level from the Trust facet (if present). */
  readonly trustLevel?: TrustLevel;
  /** Schemas/vocabularies this entry conforms to (cleartext-mirrored from dct:conformsTo). */
  readonly conformsTo?: readonly string[];
  /**
   * Descriptor IRIs this entry supersedes. Manifest-mirrored from
   * iep:supersedes on the descriptor itself so callers can identify
   * head-of-chain entries (those NOT named in any other entry's
   * supersedes list) without re-fetching every TriG. Empty / absent
   * means this entry supersedes nothing — i.e. it's either a fresh
   * publish or a head we haven't traced backward yet.
   */
  readonly supersedes?: readonly string[];
  /**
   * Issuer DID extracted from the descriptor's Trust facet (if present).
   * Cleartext-mirrored on the manifest so trust-aware readers can filter
   * by author without re-fetching every descriptor's TriG. The full Trust
   * facet (including this issuer) is also surfaced on `facets` below.
   */
  readonly issuer?: string;
  /**
   * Minimal reconstruction of the descriptor's facets, surfaced on the
   * manifest so trust-aware readers can filter by facet shape (e.g.
   * Trust.trustLevel + Trust.issuer) without re-fetching every TriG.
   *
   * Only the subset of facet fields that the manifest mirrors is
   * populated here — full facet round-trip requires fetching the
   * descriptor itself. Currently populated:
   *   - Trust: { type, trustLevel, issuer }
   *   - Semiotic: { type, modalStatus }
   */
  readonly facets?: readonly ContextFacetData[];
  /**
   * PGSL structural URI (if the content was ingested into the lattice).
   * Same content from different pods produces the same URI —
   * structural overlap is detectable across federation.
   */
  readonly pgslUri?: string;
  /** PGSL structural level. */
  readonly pgslLevel?: number;
  /**
   * Structural overlap with a query or other descriptor.
   * Computed via PGSL lattice meet — the shared sub-structure.
   */
  readonly structuralOverlap?: {
    readonly meetUri?: string;
    readonly meetResolved?: string;
    readonly meetLevel?: number;
  };
}
