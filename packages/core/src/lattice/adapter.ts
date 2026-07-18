/**
 * @module lattice/adapter
 * @description Pluggable lattice backend for the kernel's mint / promote /
 * decompose verbs.
 *
 * The kernel needs three operations from "the lattice":
 *   1. Mint an atom from a value, content-addressed deterministically.
 *   2. Promote a sequence of values or atom IRIs into a fragment, returning
 *      the apex IRI and its lattice level.
 *   3. Decompose a fragment IRI into its left/right constituents and the
 *      structural overlap (the pullback square at the apex), when the
 *      fragment has structure to decompose (level ≥ 2).
 *
 * The historical implementation called into `pgsl/lattice` + `pgsl/category`
 * directly. That made the kernel package have to bundle the full PGSL
 * runtime even for callers that only mint atoms — and it made the
 * substrate-vs-vertical split impossible at the package boundary.
 *
 * `LatticeAdapter` decouples those two roles:
 *   - The kernel imports only this adapter interface.
 *   - A lattice-aware adapter (`@interego/pgsl`) registers itself at module
 *     load time via {@link setKernelLatticeAdapter}, replacing the built-in
 *     pure-hash fallback. The fallback preserves wire compat — the URI
 *     scheme is the same (`urn:pgsl:atom:<hash40>`) — so callers that don't
 *     install `@interego/pgsl` still get content-addressed atom IRIs, just
 *     without the structural index needed for promote / decompose.
 *
 * No new ontology terms. The URI scheme is the existing PGSL one.
 */

import { createHash } from 'node:crypto';
import type { IRI } from '../model/types.js';
import { mintNodeId } from './node-id.js';

/** A scalar value the lattice can address by content. */
export type LatticeValue = string | number | boolean;

/** A non-negative integer lattice level (0 = atom). */
export type LatticeLevel = number;

/**
 * Optional provenance attached to a newly-minted node. The kernel
 * forwards this to the adapter so lattice-aware backends can record it
 * alongside the structural information.
 */
export interface LatticeProvenance {
  readonly wasAttributedTo?: IRI;
  readonly generatedAtTime?: string;
  readonly wasDerivedFrom?: readonly IRI[];
  readonly comment?: string;
}

/** Result of {@link LatticeAdapter.mint}. */
export interface AdapterMintResult {
  readonly iri: IRI;
  readonly level: LatticeLevel;
  readonly contentHash: string;
}

/** Result of {@link LatticeAdapter.promote}. */
export interface AdapterPromoteResult {
  readonly apex: IRI;
  readonly level: LatticeLevel;
}

/** Result of {@link LatticeAdapter.decompose}. */
export interface AdapterDecomposeResult {
  readonly apex: IRI;
  readonly level: LatticeLevel;
  readonly left: IRI;
  readonly right: IRI;
  readonly overlap: IRI;
}

/** Result of {@link LatticeAdapter.resolve}. */
export interface AdapterResolveResult {
  readonly iri: IRI;
  readonly kind: 'atom' | 'fragment';
  readonly level: LatticeLevel;
  /** Recursively-resolved content (string projection of the node). */
  readonly value: string;
  /** For fragments: constituent item IRIs. Empty array for atoms. */
  readonly items: readonly IRI[];
}

/**
 * Pluggable lattice backend. The kernel composes against this surface;
 * `@interego/pgsl` provides a lattice-aware implementation; the built-in
 * fallback below provides a pure-hash mint and "no structure" promote /
 * decompose so callers that never install PGSL still get deterministic
 * atom IRIs.
 */
export interface LatticeAdapter {
  mint(content: LatticeValue, provenance?: LatticeProvenance): AdapterMintResult;
  promote(
    items: readonly (LatticeValue | IRI)[],
    provenance?: LatticeProvenance,
  ): AdapterPromoteResult;
  decompose(fragmentIri: IRI): AdapterDecomposeResult | null;
  /**
   * Resolve a lattice node IRI to its content. Returns `null` when the
   * IRI is not known to the adapter (no structural index for the
   * fallback, or unknown node for a lattice-aware adapter). Optional so
   * adapters can leave it unimplemented and the kernel handles absence
   * gracefully.
   */
  resolve?(iri: IRI): AdapterResolveResult | null;
}

// ── Built-in fallback ───────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Build the canonical PGSL atom URI for a value — same scheme as
 * `pgsl/lattice#atomUri`. Preserved here so the fallback adapter
 * preserves wire compat with the lattice-aware adapter.
 */
function fallbackAtomUri(value: LatticeValue): IRI {
  const hash = sha256Hex(`atom:${String(value)}`);
  return mintNodeId('atom', hash.slice(0, 40)) as IRI;
}

/**
 * Build a fragment URI from item URIs at a given level. Same scheme as
 * `pgsl/lattice#fragmentUri`. The fallback uses this so an apex minted
 * by the fallback shares the URI space with the PGSL adapter.
 */
function fallbackFragmentUri(items: readonly IRI[], level: LatticeLevel): IRI {
  const hash = sha256Hex(`fragment:L${level}:${items.join('|')}`);
  return mintNodeId('fragment', hash.slice(0, 40)) as IRI;
}

/**
 * Resolve a fragment input item to its URI. If the item is already a
 * URI string (`urn:…` / `http(s):…`), pass through; otherwise treat it
 * as a fresh atom value and mint its URI.
 */
function fallbackItemToUri(item: LatticeValue | IRI): IRI {
  if (typeof item === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(item)) {
    return item as IRI;
  }
  return fallbackAtomUri(item as LatticeValue);
}

/**
 * The built-in pure-hash adapter. No in-memory index, no structural
 * pullback — `decompose` always returns null because there is no
 * recorded lattice to walk. Atom + fragment URI schemes match the
 * full PGSL adapter so wire compat is preserved.
 */
export function fallbackLatticeAdapter(): LatticeAdapter {
  return {
    mint(content: LatticeValue): AdapterMintResult {
      const iri = fallbackAtomUri(content);
      return {
        iri,
        level: 0,
        contentHash: sha256Hex(`atom:${String(content)}`),
      };
    },
    promote(items: readonly (LatticeValue | IRI)[]): AdapterPromoteResult {
      if (items.length === 0) {
        throw new TypeError('promote() requires at least one item');
      }
      // Walk the items to URI atoms first so the fragment hash uses URIs.
      const uris = items.map(fallbackItemToUri);
      // Level recovered from the items — atoms are level 0; an item that
      // is already a URI may itself be a fragment of unknown level. The
      // fallback approximates: level = items.length - 1 (the same
      // sequence-length default the lattice-aware adapter falls back to
      // when no node is registered).
      const level = Math.max(0, items.length - 1);
      const apex = level === 0 ? uris[0]! : fallbackFragmentUri(uris, level);
      return { apex, level };
    },
    decompose(_fragmentIri: IRI): AdapterDecomposeResult | null {
      // No lattice index — cannot reconstruct the pullback structure.
      // Callers needing decompose must register the lattice-aware
      // adapter (`@interego/pgsl`).
      return null;
    },
  };
}

// ── Adapter registry ────────────────────────────────────────

let _activeAdapter: LatticeAdapter = fallbackLatticeAdapter();

/**
 * Replace the kernel's active lattice adapter. `@interego/pgsl` calls
 * this at module-import side-effect time so `import '@interego/pgsl'`
 * is enough to activate lattice-aware mint / promote / decompose.
 *
 * Passing `null` restores the built-in fallback — used by tests.
 */
export function setKernelLatticeAdapter(adapter: LatticeAdapter | null): void {
  _activeAdapter = adapter ?? fallbackLatticeAdapter();
}

/**
 * Get the active lattice adapter. Used internally by the kernel's mint /
 * promote / decompose verbs; not part of the public substrate surface.
 */
export function getKernelLatticeAdapter(): LatticeAdapter {
  return _activeAdapter;
}
