/**
 * @module pgsl/types
 * @description Set-theoretic foundation for Poly-Granular Sequence Lattice
 *
 * The PGSL is a deterministic, content-addressed lattice of overlapping
 * sub-structures. These types define the sets and domains from which
 * the categorical structure is built.
 *
 * Foundation:
 *   - Value: primitive data (the ground set)
 *   - URI: canonical identifiers (content-addressed)
 *   - Level: granularity (number of base atoms in a fragment)
 *   - Height: topological depth in the lattice
 *   - Node = Atom | Fragment (discriminated union)
 *
 * The types are set-theoretic — they define WHAT things are.
 * The categorical structure (HOW they compose) is in category.ts.
 * The monad operations (HOW they're constructed) are in lattice.ts.
 */

import type { IRI } from '../model/types.js';

// ── Primitive Domains ───────────────────────────────────────

/** A primitive value — element of the ground set V. */
export type Value = string | number | boolean;

/**
 * Tokenization granularity — controls what constitutes an atom.
 *
 *   'character' — each character is an atom (finest granularity)
 *   'word'      — each whitespace-separated token is an atom (default)
 *   'sentence'  — each sentence is an atom (coarsest)
 *
 * The PGSL is granularity-agnostic — it works on any sequence of values.
 * The granularity determines how content is split into that sequence.
 */
/**
 * Tokenization granularity — controls what constitutes an atom.
 *
 *   'character' — each character is an atom (finest granularity)
 *   'word'      — each whitespace-separated token is an atom (default)
 *   'sentence'  — each sentence is an atom (coarsest)
 *   'structured' — recursive: nested structures (tuples, lists, trees)
 *                  are ingested as nested lattice fragments. Inner structures
 *                  become atoms at the outer level. Preserves nesting.
 *                  ((0,0),(0,0)) ≠ (0,0,0,0) because nesting depth differs.
 */
export type TokenGranularity = 'character' | 'word' | 'sentence' | 'structured';

/** Level ℓ ∈ ℕ — the granularity of a fragment (number of base atoms). */
export type Level = number;

/** Height h ∈ ℕ — topological depth from the root. */
export type Height = number;

// ── Provenance Metadata ─────────────────────────────────────

/**
 * Mandatory provenance on every PGSL node.
 * This is the data that the provenance natural transformation η assigns.
 */
export interface NodeProvenance {
  /** DID/WebID of the agent who minted this node. */
  readonly wasAttributedTo: IRI;
  /** ISO 8601 timestamp of creation. */
  readonly generatedAtTime: string;
  /** ECDSA signature of the content hash (optional — set when node is signed). */
  readonly signature?: string;
  /** Ethereum address of the signer (recovered from signature). */
  readonly signerAddress?: string;
  /** Encrypted content key, wrapped for authorized recipients (optional). */
  readonly encryptedForRecipients?: readonly string[];
}

// ── Node Types (Discriminated Union) ────────────────────────

/**
 * An Atom — a leaf node in the lattice.
 *
 * Set-theoretically: an element of the set Atom ⊂ Node
 * where level = 0 and the node contains exactly one Value.
 *
 * The canonicity invariant guarantees: for any value v ∈ V,
 * there exists exactly one URI u such that Atom(u).value = v.
 * This is the universal property of the free object.
 */
export interface Atom {
  readonly kind: 'Atom';
  /** The canonical URI (content-addressed from the value). */
  readonly uri: IRI;
  /**
   * The primitive value this atom represents. For encrypted atoms this
   * holds a redaction placeholder (e.g. `'__ENCRYPTED__'`) — the real
   * value lives in `encrypted` and can only be recovered by a recipient.
   */
  readonly value: Value;
  /** Level is always 0 for atoms. */
  readonly level: 0;
  /** Provenance: who minted this atom and when. */
  readonly provenance: NodeProvenance;
  /** IPFS CID (computed from content, optionally pinned). */
  readonly cid?: string;
  /**
   * Optional encrypted payload for this atom. When present, `value`
   * is a redacted placeholder and the true content is recoverable by
   * any recipient whose key is wrapped inside the envelope. Lattice
   * structural operations (meet, join, level, pullback) operate on
   * URIs and don't need the plaintext — so encrypted atoms still
   * compose correctly in fragments. See crypto/facet-encryption.ts.
   */
  readonly encrypted?: import('../crypto/facet-encryption.js').EncryptedFacetValue;
}

/**
 * A Fragment — a composite node in the lattice.
 *
 * Set-theoretically: an element of the set Fragment ⊂ Node
 * where level ≥ 1 and the node contains references to other nodes.
 *
 * Level 1: structural wrapper around exactly one atom (no constituents).
 * Level k ≥ 2: formed by the overlapping pair construction (pullback)
 *   from two level-(k-1) fragments sharing (k-1) atoms.
 *
 * The structural determinism invariant guarantees: for any sequence
 * of URIs, the resulting hierarchy is unique and reproducible.
 */
export interface Fragment {
  readonly kind: 'Fragment';
  /** The canonical URI (content-addressed from the items). */
  readonly uri: IRI;
  /** The level (number of base atoms this fragment spans). */
  readonly level: Level;
  /** The height (depth from the lattice top). */
  readonly height: Height;
  /** The ordered sequence of item URIs this fragment contains. */
  readonly items: readonly IRI[];
  /** IPFS CID (computed from content, optionally pinned). */
  readonly cid?: string;
  /**
   * The two constituents (for level ≥ 2).
   * The overlapping pair: left and right fragments of level (k-1)
   * whose intersection (pullback) is a fragment of level (k-2).
   *
   * For level 1: undefined (wraps a single atom).
   */
  readonly left?: IRI;
  readonly right?: IRI;
  /** Provenance: who constructed this fragment and when. */
  readonly provenance: NodeProvenance;
}

/** A Node is either an Atom or a Fragment. */
export type Node = Atom | Fragment;

// ── Containment Annotation (contextual properties on edges) ─

/**
 * Contextual metadata for a containment relationship.
 *
 * Properties belong to the EDGE (parent contains child at position),
 * not to the node itself. Same node can have different annotations
 * in different containing fragments — this IS the Peircean interpretant.
 *
 * Serialized as RDF 1.2 triple annotations:
 *   <parent> cg:hasItem <child> {| cg:position 1 ; cg:contextualDepth 2 |} .
 */
export interface ContainmentAnnotation {
  /** The containing fragment URI */
  readonly parentUri: IRI;
  /** The contained node URI */
  readonly childUri: IRI;
  /** Position of child in parent's items array (0-indexed) */
  readonly position: number;
  /** Distance from the bottom of the containing structure (0 = leaf) */
  readonly depthFromBottom: number;
  /** Distance from the top of the containing structure (0 = top) */
  readonly depthFromTop: number;
  /** Total depth of the containing structure */
  readonly totalDepth: number;
  /** What percentage of the parent this child represents */
  readonly span: number;
  /** Structural role based on position */
  readonly role: ContainmentRole;
}

/**
 * The structural role of a node within its containing fragment.
 * Determined by position and context.
 */
export type ContainmentRole =
  | 'head'       // first item (position 0)
  | 'tail'       // last item
  | 'medial'     // middle item(s)
  | 'sole'       // only item (level 1 wrapper)
  | 'left'       // left constituent of pullback pair
  | 'right'      // right constituent of pullback pair
  | 'overlap';   // shared region in pullback

// ── Registry Types ──────────────────────────────────────────

/**
 * Atom Registry: V → URI
 *
 * Maps values to their canonical URIs.
 * Implements the canonicity invariant: each value has exactly one URI.
 * This is the object map of the free functor F: V → PGSL.
 */
export type AtomRegistry = Map<string, IRI>;

/**
 * Fragment Registry: URI[] → URI
 *
 * Maps sequences of item URIs to their canonical fragment URI.
 * The key is a deterministic hash of the item sequence.
 * Implements structural determinism.
 */
export type FragmentRegistry = Map<string, IRI>;

/**
 * Node Repository: URI → Node
 *
 * The underlying store. Maps URIs to their full node data.
 * This is the "object of objects" in the presheaf.
 */
export type NodeRepository = Map<IRI, Node>;

// ── PGSL Instance ───────────────────────────────────────────

/**
 * A PGSL instance — the tuple (A, F, N).
 *
 * Set-theoretically: a triple of registries that together define
 * the complete lattice state.
 *
 * Categorically: this is the data of a presheaf P: L^op → Set
 * where P(ℓ) = { nodes at level ℓ } and P(ℓ → ℓ-1) = constituent-of.
 */
export interface PGSLInstance {
  /** Atom Registry: maps values to canonical URIs. */
  readonly atoms: AtomRegistry;
  /** Fragment Registry: maps item sequences to canonical URIs. */
  readonly fragments: FragmentRegistry;
  /** Node Repository: maps URIs to full node data. */
  readonly nodes: NodeRepository;
  /** Default provenance for new nodes minted by this instance. */
  readonly defaultProvenance: NodeProvenance;

  // ── Lazy Lattice Construction (opt-in) ─────────────────────

  /**
   * When true, ingest() only builds levels 0–2 eagerly.
   * Higher levels are constructed on-demand when queried.
   */
  readonly lazyMode?: boolean;

  /**
   * If set, ingest() stops building at this level.
   * Fragments at maxLevel store their items but don't build higher.
   */
  readonly maxLevel?: number;

  /**
   * Deferred chains for lazy construction.
   * Maps a chain key (content hash of the atom URI sequence)
   * to the full ordered atom URI sequence. Higher-level fragments
   * are built from these on demand.
   */
  readonly deferredChains?: Map<string, IRI[]>;
}

// ── Direction (for QueryNeighbors) ──────────────────────────

export type Direction = 'left' | 'right' | 'both';

// ── Morphism Types (for category.ts) ────────────────────────

/**
 * A constituent-of morphism in the level category L.
 *
 * Represents the relationship: fragment F at level k
 * has constituent C at level (k-1).
 *
 * In the presheaf, this is the restriction map P(k) → P(k-1).
 */
export interface ConstituentMorphism {
  /** The parent fragment URI. */
  readonly parent: IRI;
  /** The constituent fragment URI. */
  readonly constituent: IRI;
  /** Whether this is the left or right constituent. */
  readonly position: 'left' | 'right';
  /** The parent's level. */
  readonly parentLevel: Level;
  /** The constituent's level (always parentLevel - 1). */
  readonly constituentLevel: Level;
}

/**
 * A pullback square — the categorical structure of the overlapping pair.
 *
 *   fragment_k ────→ right_{k-1}
 *       |                 |
 *       ↓                 ↓
 *   left_{k-1} ─────→ overlap_{k-2}
 *
 * The overlap region is the fiber product of left and right
 * over their shared sub-fragment.
 */
export interface PullbackSquare {
  /** The top-level fragment (level k). */
  readonly apex: IRI;
  /** The left constituent (level k-1). */
  readonly left: IRI;
  /** The right constituent (level k-1). */
  readonly right: IRI;
  /** The overlap (level k-2) — the shared sub-fragment. */
  readonly overlap: IRI;
  /** The level of the apex. */
  readonly level: Level;
}
