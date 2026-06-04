/**
 * @module kernel/types
 * @description Type surface for the Interego categorical kernel.
 *
 * The kernel exposes the substrate's primitives as first-class verbs.
 * The categorical foundations are spelled out in
 * `docs/ARCHITECTURAL-FOUNDATIONS.md`:
 *
 * | Kernel verb        | Categorical role                                |
 * |--------------------|-------------------------------------------------|
 * | `mint`             | Identity-by-reference (Invariant 1)             |
 * | `dereference`      | Peircean Secondness — brute act of resolution   |
 * | `compose`          | Operadic composition over typed-hyperedge       |
 * |                    | category (the four operators form a lattice)    |
 * | `act`              | Peircean Thirdness made operational             |
 * | `restrict`/`extend`| Restriction/extension adjunction (Invariant 3)  |
 * | `promote`/`decompose` | PGSL fibration vertical movement             |
 *
 * The types in this module describe the kernel's wire surface only. They
 * compose the existing protocol types — `ContextDescriptorData`,
 * `ManifestEntry`, the PGSL Atom/Fragment shapes — without redefining
 * them. The kernel is a categorical SURFACE over the substrate, not a
 * parallel data model.
 */

import type { IRI, ContextDescriptorData, CompositionOperator } from '../model/types.js';
import type { ManifestEntry } from '../manifest/types.js';
import type { LatticeLevel as Level } from '../lattice/adapter.js';
export type { LatticeLevel as Level } from '../lattice/adapter.js';

// ── Holon ────────────────────────────────────────────────────

/**
 * A holon is a dereferenceable IRI together with its level + kind in
 * the substrate. Atoms, fragments, descriptors, and manifests are all
 * holons; what they have in common is exactly the kernel's surface —
 * `mint` produces an IRI, `dereference` resolves it, `compose` joins
 * two, `act` follows an affordance carried on its representation.
 */
export interface Holon {
  /** Canonical IRI — the identity-by-reference (Invariant 1). */
  readonly iri: IRI;
  /** PGSL level (0 = atom, k ≥ 1 = fragment / higher composite). */
  readonly level: Level;
  /**
   * Substrate kind for downstream routing:
   *   - `'atom'`     — a leaf value in the PGSL lattice.
   *   - `'fragment'` — a composite at level ≥ 1.
   *   - `'descriptor'` — a Context Descriptor (typed-hyperedge over
   *                      named graphs).
   *   - `'manifest'`   — a pod's `.well-known/context-graphs` entry list.
   *   - `'opaque'`     — content of unknown substrate kind (still a
   *                      legitimate holon — the IRI is dereferenceable).
   */
  readonly kind: 'atom' | 'fragment' | 'descriptor' | 'manifest' | 'opaque';
  /**
   * The minted content's SHA-256 (hex), when the holon was produced by
   * a content-addressed verb (`mint`, `promote`). Absent when the
   * holon's IRI was supplied externally (e.g. a fetched descriptor's
   * existing identifier).
   */
  readonly contentHash?: string;
  /**
   * For atom holons: the original value passed to `mint`. For other
   * kinds the canonical content is reachable by `dereference(iri)`
   * and is not duplicated here.
   */
  readonly content?: unknown;
}

// ── Affordance (the Peircean Third made operational) ─────────

/**
 * Structured form of a `cg:Affordance` block read from a descriptor's
 * representation. Carries everything `act` needs to follow the link.
 *
 * This is intentionally a flat, JSON-friendly shape — the kernel
 * surface is consumed by language-agnostic clients (MCP tools, HTTP
 * APIs) as well as the TS library.
 */
export interface Affordance {
  /** The `cg:action` IRI — what the affordance does. */
  readonly action: string;
  /** The `hydra:target` URL — where to invoke. */
  readonly target: string;
  /** The HTTP method (default `'POST'` when unspecified). */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `dcat:mediaType` of the response, when declared. */
  readonly mediaType?: string;
  /**
   * The descriptor this affordance was read from. Empty when the
   * affordance was constructed directly (no source descriptor — e.g.
   * a synthesized agent-level affordance).
   */
  readonly fromDescriptor?: string;
  /**
   * The subject IRI of the `cg:Affordance` block inside the descriptor,
   * when the block has a named subject. Useful for debugging and for
   * agents that index affordances by IRI.
   */
  readonly subjectIri?: string;
}

// ── Composition operator (re-export for ergonomics) ──────────

/**
 * The four operators of §3.4 — `'union' | 'intersection' | 'restriction' | 'override'`.
 * Re-exported from the protocol-level type so kernel consumers don't
 * need a second import to choose an operator.
 */
export type KernelCompositionOperator = CompositionOperator;

// ── Verb result types ────────────────────────────────────────

/** Result of `mint(content)`. */
export interface MintResult {
  readonly holon: Holon;
}

/**
 * Result of `dereference(iri)`. Returns the carried representation,
 * the affordances embedded in it (for hypermedia-driven traversal),
 * and lightweight provenance read from the representation when present.
 *
 * `status` is the protocol-level outcome:
 *   - `'ok'`               — representation retrieved.
 *   - `'encrypted-no-key'` — representation is an encrypted envelope
 *                            and the caller did not supply a key.
 *   - `'not-found'`        — 404 / 410.
 *   - `'error'`            — network or non-2xx status.
 */
export interface DereferenceResult {
  readonly iri: string;
  readonly status: 'ok' | 'encrypted-no-key' | 'not-found' | 'error';
  /** The fetched representation body, when status is `'ok'`. */
  readonly representation?: string;
  readonly contentType: string;
  readonly affordances: readonly Affordance[];
  /**
   * Manifest-style entry list, when the IRI is a pod
   * `.well-known/context-graphs` manifest. Each entry's affordances
   * (when its descriptor's representation was inspected) are echoed
   * on the entry too.
   */
  readonly manifestEntries?: readonly DereferencedManifestEntry[];
  /**
   * Structured provenance read from the representation. Parsed via the
   * substrate's `parseTrig` so every prov:* / cg:supersedes / dct:* triple
   * is recovered, including multi-value lists and across all subjects in
   * the document (descriptor IRI + named graph IRI + any blank-node
   * provenance constructs). When the body is unparseable, `provenance`
   * is omitted (we don't surface partial garbage as substrate truth).
   */
  readonly provenance?: {
    /** prov:wasDerivedFrom — IRIs of prior holons this one depends on. */
    readonly wasDerivedFrom?: readonly string[];
    /** prov:wasGeneratedBy — the generating activity's IRI. */
    readonly wasGeneratedBy?: string;
    /** prov:wasAttributedTo — the responsible agent(s) IRI. */
    readonly wasAttributedTo?: readonly string[];
    /** prov:generatedAtTime — when the holon came into being. */
    readonly generatedAtTime?: string;
    /** cg:supersedes — IRIs of holons this one replaces in a chain. */
    readonly supersedes?: readonly string[];
    /** dct:conformsTo — SHACL shapes / ontology terms this conforms to. */
    readonly conformsTo?: readonly string[];
  };
  /** Numeric HTTP status from the underlying fetch (when applicable). */
  readonly httpStatus?: number;
}

/** A manifest entry decorated with the affordances of its descriptor. */
export interface DereferencedManifestEntry extends ManifestEntry {
  readonly affordances?: readonly Affordance[];
}

/** Result of `compose(descriptors, op)`. */
export interface ComposeResult {
  readonly composed: ContextDescriptorData;
  readonly operator: KernelCompositionOperator;
  readonly operandIris: readonly IRI[];
}

/** Result of `act(affordance, payload)`. */
export interface ActResult {
  /** HTTP status from the affordance's target. */
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string | null;
  /** Raw response body — caller decides whether to `JSON.parse`. */
  readonly body: string;
  /** Echo of the affordance that was followed. */
  readonly affordance: Affordance;
}

/** Result of `restrict(holon, selector)`. */
export interface RestrictResult {
  readonly restricted: ContextDescriptorData;
  readonly selector: RestrictSelector;
  readonly originIri: IRI;
}

/**
 * Selector for `restrict`. The selector is a sub-hyperedge specification.
 * Initial form: a facet-type list — project the descriptor to the named
 * facet types only. This is the protocol's §3.4.3 restriction operator;
 * future selector forms (temporal slice, attribute filter) can extend
 * this union without breaking callers.
 */
export type RestrictSelector =
  | { readonly kind: 'facet-types'; readonly types: readonly string[] };

/** Result of `extend(part, whole)`. */
export interface ExtendResult {
  readonly extended: ContextDescriptorData;
  readonly partIri: IRI;
  readonly wholeIri: IRI;
}

/** Result of `promote(atoms[], level)`. */
export interface PromoteResult {
  /** The apex fragment IRI at the promoted level. */
  readonly apex: IRI;
  /** The promoted level (k ≥ 1). */
  readonly level: Level;
  /** The pullback square — when the level was reached by pullback. */
  readonly pullback?: {
    readonly apex: IRI;
    readonly left: IRI;
    readonly right: IRI;
    readonly overlap: IRI;
  };
}

/** Result of `decompose(fragmentIri)`. */
export interface DecomposeResult {
  readonly apex: IRI;
  readonly level: Level;
  readonly left: IRI;
  readonly right: IRI;
  readonly overlap: IRI;
}
