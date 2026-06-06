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

// ── Verb 9 — reduce (fold over a cg:supersedes chain) ────────
//
// `reduce(chainHeadIri, reducerSpec?)` walks the cg:supersedes back-
// links from the head to the oldest link, folds the chain through a
// declarative reducer (NOT arbitrary code), and returns a canonical
// "current state" alongside a ReplayProof a third party can use to
// independently verify the fold. The reducer is itself content-
// addressed; a verifier re-fetches chain + reducer by CID and replays.
//
// Categorical role: the fold is the colimit of the chain in the
// supersession category — a left-Kan extension along the inclusion
// of the chain into the descriptor category. The reducer is the
// algebra; checkpoints are the standard "every k-th cocone" trick that
// localizes mismatches without re-replaying from scratch.

/**
 * Declarative reducer specification. Two substrate-honest kinds:
 *
 *   - `'turtle-template'` — a Turtle document with `{?prior.cg:value}`
 *     / `{?current.cg:value}` placeholders. The kernel binds them and
 *     materializes triples. Pure data; no execution.
 *
 *   - `'shacl-transform'` — a SHACL graph using `sh:rule` /
 *     `sh:construct` / `sh:targetClass`. The fold runs each link
 *     through the SHACL engine; the rule's constructed triples become
 *     the next state. Pure shape transformation.
 *
 * Arbitrary code is intentionally excluded so the fold is replayable
 * by any independent verifier with the same SHACL engine or Turtle
 * template renderer.
 */
export type ReducerSpec =
  | { readonly kind: 'turtle-template'; readonly template: string }
  | { readonly kind: 'shacl-transform'; readonly shape: string };

/** Options for {@link reduce}. */
export interface ReduceOptions {
  /**
   * Inline reducer specification. When omitted, the kernel reads
   * `cg:reducer <iri>` from the chain head's descriptor body and
   * dereferences the named reducer artifact (itself content-addressed).
   */
  readonly reducerSpec?: ReducerSpec;
  /**
   * Maximum chain length the fold will walk before aborting. Defaults
   * to 64 — same order of magnitude as the delegation-chain cycle
   * guard at delegation.ts:612-623. Cycles already break naturally
   * because supersedes is a DAG; the Set-of-visited guard provides
   * defense in depth.
   */
  readonly maxChain?: number;
  /**
   * Checkpoint interval — every k-th link is hashed into the
   * ReplayProof so a verifier can short-circuit from the nearest
   * checkpoint when partial trust is acceptable. Defaults to 8.
   */
  readonly checkpointEvery?: number;
  /**
   * Resolver for individual chain links. When omitted, the kernel uses
   * its own `dereference` against each `cg:supersedes` IRI. Tests
   * supply a stub so the fold can be exercised without touching HTTP.
   */
  readonly fetch?: (iri: IRI) => Promise<string | null>;
}

/**
 * A single checkpoint in the ReplayProof. `index` is the link's
 * position in the chain (0 = oldest), `afterLinkCid` is the chain
 * link's CID, `stateCid` is the CID of the fold's accumulator state
 * AFTER applying that link.
 */
export interface ReplayCheckpoint {
  readonly index: number;
  readonly afterLinkCid: string;
  readonly stateCid: string;
}

/**
 * Verifiable replay witness. Independent verification protocol:
 *   1. Re-fetch every CID in `chainCids` from any pod or IPFS gateway.
 *   2. Re-fetch the reducer by `reducerCid`.
 *   3. Replay the fold with the same `maxChain` bound.
 *   4. Assert that every `chainCid`, the `reducerCid`, every
 *      checkpoint `stateCid`, and the final head CID match. Mismatch
 *      at any step localizes the divergence (chain tampering vs
 *      reducer drift vs fold non-determinism).
 */
export interface ReplayProof {
  /** Chain link CIDs, oldest → newest. */
  readonly chainCids: readonly string[];
  /** Content-address of the reducer artifact. */
  readonly reducerCid: string;
  /** Which kind of reducer was applied. */
  readonly reducerKind: 'turtle-template' | 'shacl-transform';
  /** Number of links folded (length of `chainCids`). */
  readonly chainLength: number;
  /** Periodic state checkpoints (every `checkpointEvery` links). */
  readonly checkpoints: readonly ReplayCheckpoint[];
  /** CID of the final folded state — anchors the head end of the proof. */
  readonly headStateCid: string;
}

/** Result of `reduce(chainHeadIri, options?)`. */
export interface ReduceResult {
  /**
   * The reduced canonical state, serialized as Turtle. The head's
   * modal-status semantics (Asserted / Hypothetical / Counterfactual)
   * carries through unchanged — reduce is a fold, not a re-derivation.
   */
  readonly head: string;
  /** Witness for independent verification. */
  readonly replayProof: ReplayProof;
  /** Number of links folded. */
  readonly chainLength: number;
  /** Chain head IRI the fold started from. */
  readonly chainHeadIri: IRI;
}
