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
// Type-only: erased at compile time, so the kernel's type surface takes on no runtime
// dependency on the RDF layer. The ReplayProof carries this exact shape rather than a
// `string | null` of its own so that "there is no digest" always arrives with the reason
// attached — the union makes a bare, unexplained null unrepresentable.
import type { GraphDigestResult } from '../rdf/graph-digest.js';
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
 * One field of a control's input contract — a `sh:property` constraint read from
 * the SHACL NodeShape that `expects` points to, surfaced INLINE so a form-capable
 * client can render the form without a second dereference. The `expects` IRI stays
 * the canonical reference; this is an additive convenience projection of it.
 */
export interface ShapeField {
  /** `sh:path` — the property this field constrains (IRI). */
  readonly path: string;
  /** `sh:name` — a human label for the field, when declared. */
  readonly name?: string;
  /** `sh:description` — help text, when declared. */
  readonly description?: string;
  /** `sh:datatype` — the value datatype (IRI), when declared. */
  readonly datatype?: string;
  /** `sh:minCount` — minimum cardinality, when declared. */
  readonly minCount?: number;
  /** `sh:maxCount` — maximum cardinality, when declared. */
  readonly maxCount?: number;
  /** `sh:minLength` — minimum string length, when declared. */
  readonly minLength?: number;
  /** `sh:maxLength` — maximum string length, when declared. */
  readonly maxLength?: number;
  /** `sh:pattern` — a regex the value must match, when declared. */
  readonly pattern?: string;
}

/**
 * Structured form of a `iep:Affordance` block read from a descriptor's
 * representation. Carries everything `act` needs to follow the link.
 *
 * This is intentionally a flat, JSON-friendly shape — the kernel
 * surface is consumed by language-agnostic clients (MCP tools, HTTP
 * APIs) as well as the TS library.
 */
export interface Affordance {
  /** The `iep:action` IRI — what the affordance does. */
  readonly action: string;
  /** The `hydra:target` URL — where to invoke. */
  readonly target: string;
  /** The HTTP method (default `'POST'` when unspecified). */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `dcat:mediaType` of the response, when declared. */
  readonly mediaType?: string;
  /** `hydra:expects` / `iep:inputShape` — the input contract (e.g. a SHACL
   *  shape IRI) the affordance validates against, when declared. */
  readonly expects?: string;
  /** `hydra:returns` — the output type, when declared. */
  readonly returns?: string;
  /** The `expects` SHACL shape's `sh:property` field constraints, resolved inline
   *  from the same graph the affordance was read from (when the shape is defined
   *  there). Surfaced so a form client needs no second dereference. */
  readonly fields?: readonly ShapeField[];
  /**
   * The descriptor this affordance was read from. Empty when the
   * affordance was constructed directly (no source descriptor — e.g.
   * a synthesized agent-level affordance).
   */
  readonly fromDescriptor?: string;
  /**
   * The subject IRI of the `iep:Affordance` block inside the descriptor,
   * when the block has a named subject. Useful for debugging and for
   * agents that index affordances by IRI.
   */
  readonly subjectIri?: string;
  /**
   * The evidence sources this affordance READS, when the descriptor declares them.
   *
   * ── ★★ THE HALF A CALLER COULD NEVER SEE ────────────────────────────────────────────────
   *
   * An affordance's `hydra:target` says where to INVOKE it. `iep:reads` says which stores its
   * answer comes FROM — and, per source, whether there is a queryable service or only a copy. The
   * extractor read the invoke half and dropped this one, so every caller's only option was to POST
   * and take whatever came back, however large. That is why a 1.2 MB record shipped: not because
   * the descriptor was silent, but because nothing surfaced what it said.
   */
  readonly reads?: readonly EvidenceSourceRef[];
}

/**
 * One store an affordance answers from, as its descriptor declares it.
 *
 * ★ `accessService` IS THE ZERO-COPY HANDLE — DCAT's term for a service you QUERY, distinct from
 * `accessURL`, which is where a copy is fetched. A caller that can see an access service can ask a
 * narrow question instead of transferring a corpus; one that cannot has no choice but the copy.
 */
export interface EvidenceSourceRef {
  /** `iep:store` / `dcat:accessURL` — where the data lives. */
  readonly store?: string;
  /** `dcat:accessService` — a queryable DataService over this store, when one exists. */
  readonly accessService?: string;
  /** `iep:populatedBy` — the endpoint that WRITES this store (never a read handle). */
  readonly populatedBy?: string;
  /** `iep:admits` — what the store accepts, in one sentence a caller can act on. */
  readonly admits?: string;
  /** `iep:enrolmentRegister` — where membership of this source is published, when applicable. */
  readonly enrolmentRegister?: string;
  /** `rdfs:label`, when declared. */
  readonly label?: string;
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
   * ★ SET ONLY WHEN `manifestEntries` IS KNOWN TO BE SHORT OF THE POD'S ACTUAL INDEX.
   *
   * A pod past the manifest write bound keeps its recent rows in
   * `.well-known/context-graphs` and links the rest into archive segments. `dereference`
   * follows those links, so `manifestEntries` is normally the whole index and this field is
   * ABSENT. It appears when a segment the manifest advertised could not be read — the one
   * situation in which the list is a subset. A caller acting on completeness (a compliance
   * sweep, a supersession walk, anything that reads absence as evidence) must check it;
   * absence of the field is the affirmative "this is everything".
   */
  readonly manifestPartial?: true;
  /**
   * How many entries the manifest actually holds, when a `limit` truncated the returned set.
   *
   * ★ Present only for truncation, not for an unreachable archive segment — there the total is
   * genuinely unknown, and inventing one would be worse than omitting it.
   */
  readonly manifestTotalEntries?: number;
  /** The archive segment IRIs that would not load, when `manifestPartial` is set. */
  readonly manifestArchivesUnreachable?: readonly string[];
  /**
   * Structured provenance read from the representation. Parsed via the
   * substrate's `parseTrig` so every prov:* / iep:supersedes / dct:* triple
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
    /** iep:supersedes — IRIs of holons this one replaces in a chain. */
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

// ── Verb 9 — reduce (fold over a iep:supersedes chain) ────────
//
// `reduce(chainHeadIri, reducerSpec?)` walks the iep:supersedes back-
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
 *   - `'turtle-template'` — a Turtle document with `{?prior.iep:value}`
 *     / `{?current.iep:value}` placeholders. The kernel binds them and
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
   * `iep:reducer <iri>` from the chain head's descriptor body and
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
   * its own `dereference` against each `iep:supersedes` IRI. Tests
   * supply a stub so the fold can be exercised without touching HTTP.
   */
  readonly fetch?: (iri: IRI) => Promise<string | null>;
  /**
   * How the walker reconstructs the chain from `iep:supersedes`
   * back-links:
   *
   *   - `'shortest'` (default) — preserves historical behaviour: at each
   *     link the walker follows the FIRST iep:supersedes IRI it finds
   *     (effectively a breadth-shortest path back to an origin). Fast,
   *     deterministic, and correct when each descriptor declares a
   *     single back-link.
   *
   *   - `'full'` — collects every descriptor reachable through the
   *     transitive iep:supersedes closure of the head, then folds them
   *     in canonical lineage order: sorted by `iep:validFrom` ascending
   *     (oldest first), falling back to descriptor-URL lexical sort for
   *     ties. The ReplayProof's `chainCids[]` are emitted in that same
   *     sorted order so independent verifiers reproduce the same head.
   *     Use when `auto_supersede_prior` writes ALL priors per version
   *     and you need a full lineage audit rather than just one branch.
   */
  readonly traversal?: 'shortest' | 'full';
}

/**
 * Reducer-shape options shared by every traversal mode. Surfaced as its
 * own alias so the MCP layer can typecheck against the same shape the
 * kernel signature consumes.
 */
export type ReducerOptions = ReduceOptions;

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
  /**
   * Graph-identity twin of `stateCid` — same accumulator state, hashed as triples
   * rather than as characters. See {@link ReplayProof} for why both are carried.
   */
  readonly stateGraphDigest: GraphDigestResult;
}

/**
 * Verifiable replay witness. Independent verification protocol:
 *   1. Re-fetch every chain link and the reducer artifact by IRI, and
 *      recompute their CIDs — see the note below on what a
 *      `urn:iep:cid:` value is and is not.
 *   2. Replay the fold with the same `maxChain` bound.
 *   3. Assert that every `chainCid`, the `reducerCid`, every
 *      checkpoint `stateCid`, and the final head CID match. Mismatch
 *      at any step localizes the divergence (chain tampering vs
 *      reducer drift vs fold non-determinism).
 *   4. Where step 3 mismatches, compare the graph digests before
 *      reporting tampering — a mismatch on the CID with agreement on
 *      the digest is a re-serialization, not a changed graph. ★ The
 *      `reducerCid` has no digest to compare against, so a mismatch
 *      THERE is unresolved rather than confirmed — see that field.
 *
 * ★ A `urn:iep:cid:` VALUE HERE IS NOT AN IPFS ADDRESS. It is `sha256(s)` truncated
 * to 40 hex characters, minted by `reduceCid` in kernel/index.ts. A real CIDv1 —
 * the base32 multihash `computeCid` (crypto/ipfs.ts) produces and the relay computes
 * over descriptor bodies — is a different address space, so nothing resolves these
 * strings from a pod or a gateway. They are comparison values: a verifier fetches
 * the chain by IRI, re-folds, and checks that the CIDs it recomputes agree.
 *
 * ★ TWO HASHES, TWO DIFFERENT QUESTIONS — NEVER COMPARE ACROSS THEM. A `urn:iep:cid:`
 * value addresses BYTES: sha256 over the exact character stream the fold emitted. A
 * `graph-nquads-sha256:` value addresses what those bytes SAY: the parsed triples,
 * prefixes expanded and statements sorted (rdf/graph-digest.ts). Neither subsumes
 * the other, so a verifier compares CID to CID and digest to digest, positionally.
 *
 * ★ WHY THE DIGESTS ARE HERE AT ALL. The byte CIDs cannot survive a
 * re-serialization. Two chains stating identical triples but written with a
 * different prefix alias, a different statement order or different indentation fold
 * to DIFFERENT `headStateCid` values and the SAME `headStateGraphDigest`
 * (measured in `tests/kernel-reduce.test.ts`). Without the digest, a proof of chain
 * state is a proof about one serialization of it. That is latent rather than
 * breaking today — one deterministic serializer is in play, so a replay on this
 * build reproduces the CIDs exactly — but the substrate already rewrites payloads
 * on the way through `publish()`/`wrapAsTriG` (@prefix lines hoisted to document
 * scope, body lines re-indented), which is precisely the class of change the byte
 * CID cannot absorb. The same reasoning is spelled out at length in
 * rdf/graph-digest.ts, which is where the authorship path hit this first.
 *
 * ★ THE CIDs ARE NOT REDEFINED, AND THAT IS DELIBERATE. `headStateCid` is the
 * published verification contract (docs/ns/iep.ttl `iep:ReplayProof`); recomputing
 * it over canonical triples would silently invalidate every proof already issued
 * against a fold nobody changed. The digests are ADDED alongside.
 */
export interface ReplayProof {
  /** Chain link CIDs, oldest → newest. */
  readonly chainCids: readonly string[];
  /**
   * Graph-identity twin of each `chainCids` entry, INDEX-PARALLEL with it —
   * `chainGraphDigests[i]` digests the same link body `chainCids[i]` addresses.
   * Present per link because `headStateGraphDigest` alone would leave the other
   * half of the proof byte-fragile: a verifier that re-serializes still has to
   * localize which link diverged.
   */
  readonly chainGraphDigests: readonly GraphDigestResult[];
  /**
   * Content-address of the reducer artifact.
   *
   * ★ THE ONE CID HERE WITH NO GRAPH DIGEST BESIDE IT — AND FOR `shacl-transform`
   * THAT IS AN OPEN GAP, NOT A DECISION. "No digest" means "not attested", never
   * "attested by bytes".
   *
   * For `turtle-template` a digest is barely available: the template is substituted
   * as TEXT before anything parses, and the usual idioms put a placeholder where a
   * term or a whole statement belongs, so the template itself generally does not
   * parse as Turtle.
   *
   * For `shacl-transform` the shape IS parsed — `runShaclRules` reads it into triples
   * — so its alias, statement order and indentation never reach the fold. Measured
   * with one projecting shape serialized two ways: identical `head`, identical
   * `headStateCid`, identical `headStateGraphDigest`, DIFFERENT `reducerCid`. A
   * verifier re-fetching a republished shape sees a reducer mismatch on a fold that
   * did not change, which is the false-tampering report the digests exist to prevent.
   * ★ SO DO NOT TREAT A `reducerCid` MISMATCH AS TAMPERING ON ITS OWN: check
   * `headStateGraphDigest` first. Closing the gap means a `reducerGraphDigest` field
   * here (a refusal-with-reason for the template kind), which is a wire-shape change.
   */
  readonly reducerCid: string;
  /** Which kind of reducer was applied. */
  readonly reducerKind: 'turtle-template' | 'shacl-transform';
  /** Number of links folded (length of `chainCids`). */
  readonly chainLength: number;
  /** Periodic state checkpoints (every `checkpointEvery` links). */
  readonly checkpoints: readonly ReplayCheckpoint[];
  /** CID of the final folded state — anchors the head end of the proof. */
  readonly headStateCid: string;
  /**
   * Graph-identity digest of the final folded state, or the REASON there is none.
   *
   * ★ A NULL HERE IS A NAMED REFUSAL, NOT A ZERO. A fold whose state does not parse
   * (a `{?prior}` placed in term position produces exactly that) carries
   * `{ digest: null, reason }` rather than falling back to the byte hash. Falling
   * back would put a real-looking value in this field that attests bytes no
   * independent implementation can reproduce — the same "three shapes, one CID"
   * ambiguity the shacl-transform branch already refuses by rethrowing rather than
   * unioning.
   */
  readonly headStateGraphDigest: GraphDigestResult;
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
