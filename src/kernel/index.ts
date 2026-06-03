/**
 * @module kernel
 * @description The Interego categorical kernel — the substrate's
 * primitives exposed as a first-class API.
 *
 * Interego = **primitives + composition mechanics for emergence**, not
 * a fixed feature set. Everything that is a *particular composition*
 * (publish_context, register_agent, ...) is expressible AS composition
 * over this kernel — those higher-layer operations live elsewhere
 * (mcp-server, verticals); they MUST NOT reinvent kernel primitives.
 *
 * The kernel verbs are:
 *
 * | Verb           | Categorical role                                  |
 * |----------------|---------------------------------------------------|
 * | `mint`         | Identity-by-reference (Invariant 1)               |
 * | `dereference`  | Peircean Secondness — brute act of resolution     |
 * | `compose`      | Operadic composition over typed-hyperedge cat.    |
 * | `act`          | Peircean Thirdness made operational               |
 * | `restrict`     | Adjunction left half (whole → part)               |
 * | `extend`       | Adjunction right half (part → whole)              |
 * | `promote`      | PGSL fibration vertical movement (level k → k+1)  |
 * | `decompose`    | PGSL fibration vertical movement (level k → k-1)  |
 *
 * Each verb either delegates to an existing protocol primitive or
 * composes existing primitives. No new ontology terms; no new
 * persistence; no parallel data model. The kernel is the **surface**
 * that makes the categorical structure of the existing code visible
 * and the abstraction non-leaky.
 *
 * See `docs/ARCHITECTURAL-FOUNDATIONS.md` §3-§5 for the categorical
 * foundations realized here and §11 for the kernel's place in the
 * overall architecture.
 */

import { createHash } from 'node:crypto';

import type { IRI, ContextDescriptorData, ContextTypeName } from '../model/types.js';
import {
  union as composeUnion,
  intersection as composeIntersection,
  restriction as composeRestriction,
  override as composeOverride,
} from '../model/composition.js';

import {
  createPGSL,
  mintAtom,
  ingest as pgslIngest,
} from '../pgsl/lattice.js';
import { pullbackSquare } from '../pgsl/category.js';
import type { PGSLInstance, NodeProvenance, Value, Level } from '../pgsl/types.js';

import {
  followAffordance,
  DescriptorNotFoundError,
  AffordanceNotFoundError,
} from '../solid/affordance.js';
import { fetchGraphContent, parseManifest } from '../solid/client.js';
import { getDefaultFetch } from '../solid/client.js';
import { withTransientRetry } from '../solid/retry.js';
import type { FetchFn } from '../solid/types.js';
import type { EncryptionKeyPair } from '../crypto/encryption.js';

import { extractAffordancesFromTurtle } from './affordance-extraction.js';

import type {
  Affordance,
  KernelCompositionOperator,
  MintResult,
  DereferenceResult,
  DereferencedManifestEntry,
  ComposeResult,
  ActResult,
  RestrictResult,
  RestrictSelector,
  ExtendResult,
  PromoteResult,
  DecomposeResult,
} from './types.js';

export * from './types.js';
export { extractAffordancesFromTurtle } from './affordance-extraction.js';
export {
  decorate as decorateKernelResult,
  decorateShim,
  hydraAffordance,
  hydraEntryPoint,
  KERNEL_JSONLD_CONTEXT,
  KERNEL_RESULT_SHAPES,
} from './hypermedia.js';
export type {
  HypermediaAffordance,
  HypermediaEnvelope,
  KernelResultKind,
} from './hypermedia.js';

// ── Shared substrate state ───────────────────────────────────

/**
 * Kernel-internal PGSL instance — content-addressed, deterministic,
 * shared across `mint` / `promote` / `decompose` calls so that the
 * second `mint("foo")` returns the same IRI as the first (Invariant 1).
 *
 * This is the same instance pattern used by the rest of the
 * substrate; it is intentionally process-local because content
 * addressing is global — a `urn:pgsl:atom:<hash>` IRI minted in one
 * process matches the same IRI minted in another, with no shared
 * registry required.
 */
let _kernelPgsl: PGSLInstance | null = null;

function defaultProvenance(): NodeProvenance {
  return {
    wasAttributedTo: 'urn:cg:kernel' as IRI,
    generatedAtTime: new Date().toISOString(),
  };
}

function kernelPgsl(): PGSLInstance {
  if (_kernelPgsl) return _kernelPgsl;
  _kernelPgsl = createPGSL(defaultProvenance());
  return _kernelPgsl;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

// ═══════════════════════════════════════════════════════════════
//  Verb 1 — mint
//  Identity-by-reference (Invariant 1).
// ═══════════════════════════════════════════════════════════════

/** Options for {@link mint}. */
export interface MintOptions {
  /**
   * Substrate kind for the minted holon. Controls how the IRI is
   * derived:
   *   - `'atom'` (default) — value is minted as a PGSL atom; IRI is
   *     `urn:pgsl:atom:<sha-prefix>`.
   *   - `'fragment'` — content is a list of constituent IRIs; the
   *     fragment's IRI is content-addressed over those.
   *   - `'descriptor'` — content is treated as a ContextDescriptorData;
   *     IRI is `urn:cg:descriptor:<sha-prefix>` derived from its JSON
   *     canonicalisation.
   *   - `'opaque'` — IRI is `urn:cg:content:<sha-prefix>` over the
   *     UTF-8 bytes; useful for content not yet typed by the substrate.
   */
  readonly kind?: 'atom' | 'fragment' | 'descriptor' | 'opaque';
  /** Provenance for atom/fragment minting (defaults to a kernel stub). */
  readonly provenance?: NodeProvenance;
}

/**
 * `mint(content)` — content-addressed holon construction.
 *
 * Returns the canonical IRI for `content`. Same content → same IRI
 * (Invariant 1). Idempotent: calling `mint` twice with the same input
 * returns the same holon.
 *
 * Examples:
 * ```ts
 * mint("hello")                       // urn:pgsl:atom:<hex…>     kind: 'atom'
 * mint({ ... }, { kind: 'descriptor' }) // urn:cg:descriptor:<hex…>
 * mint([uri1, uri2], { kind: 'fragment' }) // urn:pgsl:fragment:<hex…>
 * ```
 */
export function mint(content: unknown, options?: MintOptions): MintResult {
  const kind = options?.kind ?? 'atom';

  if (kind === 'atom') {
    const value = content as Value;
    const iri = mintAtom(kernelPgsl(), value, options?.provenance);
    return {
      holon: {
        iri,
        level: 0 as Level,
        kind: 'atom',
        contentHash: sha256Hex(`atom:${String(value)}`),
        content: value,
      },
    };
  }

  if (kind === 'fragment') {
    // Content must be a non-empty sequence of values or PGSL atom IRIs.
    if (!Array.isArray(content) || content.length === 0) {
      throw new TypeError('mint(kind:fragment) requires a non-empty array of values or atom IRIs');
    }
    const iri = pgslIngest(kernelPgsl(), content as (Value | IRI)[], options?.provenance);
    // The fragment's level is its sequence length minus 1 when content
    // is a flat value list; for IRI inputs we recover it from the node.
    const node = kernelPgsl().nodes.get(iri);
    const level = (node && node.kind === 'Fragment' ? node.level : (content.length - 1)) as Level;
    return {
      holon: {
        iri,
        level,
        kind: 'fragment',
        contentHash: sha256Hex(`fragment:${content.map(String).join('|')}`),
      },
    };
  }

  if (kind === 'descriptor') {
    const desc = content as ContextDescriptorData;
    const canonical = JSON.stringify(desc, Object.keys(desc).sort());
    const hash = sha256Hex(`descriptor:${canonical}`);
    const iri = `urn:cg:descriptor:${hash.slice(0, 40)}` as IRI;
    return {
      holon: {
        iri,
        level: 1 as Level,
        kind: 'descriptor',
        contentHash: hash,
        content: desc,
      },
    };
  }

  // opaque
  const bytes = typeof content === 'string'
    ? content
    : JSON.stringify(content ?? null);
  const hash = sha256Hex(`opaque:${bytes}`);
  const iri = `urn:cg:content:${hash.slice(0, 40)}` as IRI;
  return {
    holon: {
      iri,
      level: 0 as Level,
      kind: 'opaque',
      contentHash: hash,
      content,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
//  Verb 2 — dereference
//  Peircean Secondness — the brute act of resolution.
// ═══════════════════════════════════════════════════════════════

/** Options for {@link dereference}. */
export interface DereferenceOptions {
  /** Optional fetch implementation; defaults to global `fetch`. */
  readonly fetch?: FetchFn;
  /** Recipient keypair for decrypting an encrypted envelope payload. */
  readonly recipientKeyPair?: EncryptionKeyPair;
  /**
   * When dereferencing a pod manifest, also fetch each entry's
   * descriptor and decorate its affordances onto the entry. Defaults
   * to `true` because the affordances are the substrate's hypermedia
   * surface — without them a manifest entry has no link to follow.
   * Set `false` to keep the call light (one HTTP request total).
   */
  readonly decorateManifest?: boolean;
}

const MANIFEST_PATHS = ['/.well-known/context-graphs', '/.well-known/interego', '.well-known/context-graphs'];

function looksLikeManifest(url: string): boolean {
  return MANIFEST_PATHS.some(p => url.endsWith(p) || url.endsWith(`${p}/`));
}

/**
 * `dereference(iri)` — resolve an IRI to its current representation,
 * its embedded affordances, and any lightweight provenance carried in
 * the body.
 *
 * Generalizes the protocol's existing dereference primitives:
 *   - `fetchGraphContent` for Turtle/TriG/envelope bodies
 *   - `parseManifest` + per-entry descriptor walk for
 *     `.well-known/context-graphs` manifests
 *   - affordance extraction via `extractAffordancesFromTurtle`
 *
 * Status is the protocol-level outcome — `'ok'`, `'encrypted-no-key'`
 * (envelope present, key absent), `'not-found'` (404/410), or
 * `'error'` (non-2xx other than not-found, including network
 * failures surfaced via `withTransientRetry`).
 */
export async function dereference(iri: string, options?: DereferenceOptions): Promise<DereferenceResult> {
  const fetchImpl = options?.fetch ?? getDefaultFetch();

  // Manifest path — walk the pod and surface affordances per entry.
  if (looksLikeManifest(iri)) {
    return dereferenceManifest(iri, fetchImpl, options?.decorateManifest !== false, options?.recipientKeyPair);
  }

  // Generic graph / descriptor / envelope path.
  try {
    const r = await fetchGraphContent(iri, {
      ...(options?.fetch ? { fetch: options.fetch } : {}),
      ...(options?.recipientKeyPair ? { recipientKeyPair: options.recipientKeyPair } : {}),
    });
    if (r.content === null && r.encrypted) {
      return {
        iri,
        status: 'encrypted-no-key',
        contentType: r.mediaType,
        affordances: [],
      };
    }
    const representation = r.content ?? '';
    const affordances = extractAffordancesFromTurtle(representation, iri);
    const provenance = readLightweightProvenance(representation);
    const result: Mutable<DereferenceResult> = {
      iri,
      status: 'ok',
      representation,
      contentType: r.mediaType,
      affordances,
    };
    if (provenance) result.provenance = provenance;
    return result;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/HTTP 404|HTTP 410/i.test(message) || /404 Not Found|410 Gone/i.test(message)) {
      return {
        iri,
        status: 'not-found',
        contentType: '',
        affordances: [],
        httpStatus: /410/.test(message) ? 410 : 404,
      };
    }
    return {
      iri,
      status: 'error',
      contentType: '',
      affordances: [],
    };
  }
}

async function dereferenceManifest(
  manifestUrl: string,
  fetchImpl: FetchFn,
  decorate: boolean,
  recipientKeyPair?: EncryptionKeyPair,
): Promise<DereferenceResult> {
  const response = await withTransientRetry(() => fetchImpl(manifestUrl, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  }));

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      return {
        iri: manifestUrl,
        status: 'not-found',
        contentType: '',
        affordances: [],
        httpStatus: response.status,
      };
    }
    return {
      iri: manifestUrl,
      status: 'error',
      contentType: '',
      affordances: [],
      httpStatus: response.status,
    };
  }

  const body = await response.text();
  const entries = parseManifest(body);
  const contentType = response.headers?.get('content-type') ?? 'text/turtle';

  if (!decorate) {
    return {
      iri: manifestUrl,
      status: 'ok',
      representation: body,
      contentType,
      affordances: [],
      manifestEntries: entries.map(e => ({ ...e })),
    };
  }

  // Per-entry: fetch the descriptor body, extract affordances, attach.
  const decorated: DereferencedManifestEntry[] = [];
  for (const entry of entries) {
    try {
      const r = await fetchGraphContent(entry.descriptorUrl, {
        fetch: fetchImpl,
        ...(recipientKeyPair ? { recipientKeyPair } : {}),
      });
      if (r.content) {
        decorated.push({
          ...entry,
          affordances: extractAffordancesFromTurtle(r.content, entry.descriptorUrl),
        });
      } else {
        decorated.push({ ...entry });
      }
    } catch {
      // Per-entry failure must not poison the manifest result.
      decorated.push({ ...entry });
    }
  }

  return {
    iri: manifestUrl,
    status: 'ok',
    representation: body,
    contentType,
    affordances: [],
    manifestEntries: decorated,
  };
}

/**
 * Scan a Turtle/TriG body for the substrate's standard provenance
 * predicates without a full RDF parse — cheap, best-effort, and
 * tolerant of partial/malformed bodies.
 */
function readLightweightProvenance(body: string): DereferenceResult['provenance'] {
  if (!body) return undefined;
  const out: { wasDerivedFrom?: string[]; wasGeneratedBy?: string; supersedes?: string[] } = {};

  const derivedRe = /prov:wasDerivedFrom\s+<([^>]+)>/g;
  let m;
  const derived: string[] = [];
  while ((m = derivedRe.exec(body)) !== null) derived.push(m[1]!);
  if (derived.length > 0) out.wasDerivedFrom = derived;

  const genRe = /prov:wasGeneratedBy\s+<([^>]+)>/;
  const gen = genRe.exec(body);
  if (gen) out.wasGeneratedBy = gen[1]!;

  const supRe = /cg:supersedes\s+<([^>]+)>/g;
  const sup: string[] = [];
  while ((m = supRe.exec(body)) !== null) sup.push(m[1]!);
  if (sup.length > 0) out.supersedes = sup;

  return Object.keys(out).length > 0 ? out : undefined;
}

// ═══════════════════════════════════════════════════════════════
//  Verb 3 — compose
//  Operadic composition over the typed-hyperedge category.
// ═══════════════════════════════════════════════════════════════

/** Options for {@link compose}. */
export interface ComposeOptions {
  /**
   * For `restriction`: the facet-type list to project onto. Required
   * when operator is `'restriction'` (the protocol's §3.4.3 form).
   */
  readonly types?: readonly ContextTypeName[];
  /** Explicit ID for the resulting composed descriptor. */
  readonly id?: IRI;
}

/**
 * `compose(descriptors, operator)` — apply one of the four protocol
 * operators (§3.4) to a list of `ContextDescriptorData`. Bounded-
 * lattice laws (identity, associativity, absorption) are enforced by
 * the protocol's own operators — the kernel surface just routes.
 *
 * Operator semantics:
 *   - `'union'`        — merge all facets (join in the lattice).
 *   - `'intersection'` — facets present in all operands (meet).
 *   - `'restriction'`  — project to a facet-type subset
 *                        (`options.types` required).
 *   - `'override'`     — left-biased facet replacement.
 *
 * For binary operators (`union` / `intersection` / `override`), the
 * descriptors are folded left-to-right. The result is a new
 * descriptor with `compositionOp` set — no inputs are mutated.
 */
export function compose(
  descriptors: readonly ContextDescriptorData[],
  operator: KernelCompositionOperator,
  options?: ComposeOptions,
): ComposeResult {
  if (descriptors.length === 0) {
    throw new TypeError('compose() requires at least one descriptor');
  }
  const operandIris = descriptors.map(d => d.id);

  if (operator === 'restriction') {
    if (!options?.types || options.types.length === 0) {
      throw new TypeError('compose(restriction) requires options.types');
    }
    const composed = composeRestriction(descriptors[0]!, options.types, options?.id);
    return { composed, operator, operandIris };
  }

  if (descriptors.length === 1) {
    // Unary degenerate case for binary operators — return as-is with a wrap.
    const composed = composeUnion(descriptors[0]!, descriptors[0]!, options?.id);
    return { composed, operator, operandIris };
  }

  let acc = descriptors[0]!;
  for (let i = 1; i < descriptors.length; i++) {
    const next = descriptors[i]!;
    if (operator === 'union') {
      acc = composeUnion(acc, next);
    } else if (operator === 'intersection') {
      acc = composeIntersection(acc, next);
    } else {
      acc = composeOverride(acc, next);
    }
  }
  if (options?.id) (acc as Mutable<ContextDescriptorData>).id = options.id;

  return { composed: acc, operator, operandIris };
}

// ═══════════════════════════════════════════════════════════════
//  Verb 4 — act
//  Peircean Thirdness made operational.
// ═══════════════════════════════════════════════════════════════

/** Options for {@link act}. */
export interface ActOptions {
  /** Optional fetch implementation; defaults to global `fetch`. */
  readonly fetch?: FetchFn;
  /** Forwarded `Authorization` header value (e.g. `"Bearer <token>"`). */
  readonly authorization?: string;
}

/**
 * The two invocation forms `act` accepts:
 *   - `{ descriptorUrl, actionIri }` — resolve the affordance from the
 *     descriptor, then follow.
 *   - `{ target, method, ... }` — direct invocation of a pre-resolved
 *     affordance (the shape returned by `dereference`).
 */
export type ActAffordance =
  | { readonly descriptorUrl: string; readonly actionIri: string }
  | Affordance;

/**
 * `act(affordance, payload)` — follow an affordance. Wraps
 * `followAffordance` from the Solid layer and adds support for a
 * pre-resolved `Affordance` (the shape `dereference` returns), which
 * lets callers traverse hypermedia without re-fetching the descriptor.
 */
export async function act(
  affordance: ActAffordance,
  payload?: unknown,
  options?: ActOptions,
): Promise<ActResult> {
  // Pre-resolved affordance — invoke directly.
  if (isPreResolvedAffordance(affordance)) {
    const fetchImpl = options?.fetch ?? getDefaultFetch();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': affordance.mediaType ?? 'application/json, */*',
    };
    if (options?.authorization) headers['Authorization'] = options.authorization;
    const hasPayload = payload !== undefined && payload !== null;
    const body = hasPayload ? JSON.stringify(payload) : undefined;
    const response = await withTransientRetry(async () => {
      const r = await fetchImpl(affordance.target, { method: affordance.method, headers, body });
      if (r.status >= 500) {
        throw new Error(`Affordance target ${affordance.target} returned ${r.status} ${r.statusText}`);
      }
      return r;
    });
    const responseBody = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers?.get('content-type') ?? null,
      body: responseBody,
      affordance,
    };
  }

  // Descriptor-resolved affordance — delegate to followAffordance.
  const opts: Record<string, unknown> = {};
  if (options?.fetch) opts.fetch = options.fetch;
  if (options?.authorization) opts.authorization = options.authorization;
  const result = await followAffordance(
    affordance.descriptorUrl,
    affordance.actionIri,
    payload,
    opts,
  );
  const resolved: Affordance = {
    action: result.affordance.action,
    target: result.affordance.target,
    method: result.affordance.method as Affordance['method'],
    ...(result.affordance.mediaType ? { mediaType: result.affordance.mediaType } : {}),
    fromDescriptor: affordance.descriptorUrl,
  };
  return {
    status: result.status,
    statusText: result.statusText,
    contentType: result.contentType,
    body: result.body,
    affordance: resolved,
  };
}

function isPreResolvedAffordance(a: ActAffordance): a is Affordance {
  return (a as Affordance).target !== undefined && (a as Affordance).action !== undefined;
}

// Re-export the canonical error types so `act` callers can `instanceof` check.
export { DescriptorNotFoundError, AffordanceNotFoundError };

// ═══════════════════════════════════════════════════════════════
//  Verb 5 — restrict
//  Adjunction left half (whole → part).
// ═══════════════════════════════════════════════════════════════

/**
 * `restrict(holon, selector)` — project a descriptor to a sub-hyperedge
 * specification. The protocol's §3.4.3 restriction operator is the
 * `kind: 'facet-types'` form; future selector kinds (temporal slice,
 * attribute filter) extend this union without breaking callers.
 *
 * The result satisfies the lattice property `d ∧ d|_S ≡ d|_S`
 * (verified by `verifyBoundedLattice` for the protocol-level operator).
 */
export function restrict(
  holon: ContextDescriptorData,
  selector: RestrictSelector,
): RestrictResult {
  if (selector.kind === 'facet-types') {
    const restricted = composeRestriction(holon, selector.types as readonly ContextTypeName[]);
    return { restricted, selector, originIri: holon.id };
  }
  throw new TypeError(`Unknown restrict selector kind: ${(selector as { kind: string }).kind}`);
}

// ═══════════════════════════════════════════════════════════════
//  Verb 6 — extend
//  Adjunction right half (part → whole).
// ═══════════════════════════════════════════════════════════════

/** Options for {@link extend}. */
export interface ExtendOptions {
  /**
   * When `true` (default), back-link the extended descriptor to the
   * part it came from via `cg:supersedes`, preserving the restriction
   * witness across the adjunction unit/counit cycle.
   */
  readonly preserveWitness?: boolean;
  /** Explicit ID for the resulting extended descriptor. */
  readonly id?: IRI;
}

/**
 * `extend(part, containingWhole)` — adjunction's right half. The
 * categorical inverse of `restrict`: from a part (a restricted
 * descriptor) and a containing whole, produce a descriptor whose
 * facets are the whole's, but with the part's restriction witness
 * preserved via `cg:supersedes`.
 *
 * Implementation: `compose([part, containingWhole], 'union')` plus a
 * supersedes back-link so the adjunction's unit law
 * `extend(restrict(x, S), x) ≡ x` holds up to the witness chain.
 */
export function extend(
  part: ContextDescriptorData,
  containingWhole: ContextDescriptorData,
  options?: ExtendOptions,
): ExtendResult {
  const composed = composeUnion(part, containingWhole, options?.id);
  if (options?.preserveWitness !== false) {
    const existing = composed.supersedes ?? [];
    if (!existing.includes(part.id)) {
      (composed as Mutable<ContextDescriptorData>).supersedes = [...existing, part.id];
    }
  }
  return {
    extended: composed,
    partIri: part.id,
    wholeIri: containingWhole.id,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Verb 7 — promote
//  PGSL fibration vertical movement (level k → level k+1).
// ═══════════════════════════════════════════════════════════════

/** Options for {@link promote}. */
export interface PromoteOptions {
  /** Provenance for newly minted nodes. */
  readonly provenance?: NodeProvenance;
  /**
   * Target level. When unspecified, builds the full lattice over the
   * supplied atoms (the natural promotion to the apex).
   */
  readonly toLevel?: Level;
}

/**
 * `promote(atoms[], options?)` — PGSL fibration vertical movement
 * upward. Builds the lattice from level 0 (atoms) up to the apex
 * fragment, returning the apex's IRI plus the pullback square
 * structure for the apex when the structure exists (level ≥ 2).
 *
 * Delegates to `ingest` for lattice construction and `pullbackSquare`
 * for the categorical structure of the apex.
 */
export function promote(
  atoms: readonly (Value | IRI)[],
  options?: PromoteOptions,
): PromoteResult {
  if (atoms.length === 0) {
    throw new TypeError('promote() requires at least one atom');
  }
  const pgsl = kernelPgsl();
  const apex = pgslIngest(pgsl, atoms, options?.provenance);
  const node = pgsl.nodes.get(apex);
  const level = (node && node.kind === 'Fragment' ? node.level : 0) as Level;

  if (level >= 2) {
    const square = pullbackSquare(pgsl, apex);
    if (square) {
      return {
        apex,
        level,
        pullback: {
          apex: square.apex,
          left: square.left,
          right: square.right,
          overlap: square.overlap,
        },
      };
    }
  }
  return { apex, level };
}

// ═══════════════════════════════════════════════════════════════
//  Verb 8 — decompose
//  PGSL fibration vertical movement (level k → level k-1).
// ═══════════════════════════════════════════════════════════════

/**
 * `decompose(fragmentIri)` — PGSL fibration vertical movement
 * downward. Returns the left/right constituents and their overlap
 * for a fragment of level ≥ 2 via the pullback square. Returns null
 * for atoms and level-1 fragments (no pullback structure).
 */
export function decompose(fragmentIri: IRI): DecomposeResult | null {
  const pgsl = kernelPgsl();
  const square = pullbackSquare(pgsl, fragmentIri);
  if (!square) return null;
  return {
    apex: square.apex,
    level: square.level,
    left: square.left,
    right: square.right,
    overlap: square.overlap,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Helpers / re-exports
// ═══════════════════════════════════════════════════════════════

/**
 * Reset the kernel-internal PGSL instance. Intended for tests — the
 * substrate's content addressing is global, so resetting only affects
 * in-memory mappings (existing IRIs remain valid).
 */
export function resetKernelState(): void {
  _kernelPgsl = null;
}

/** Local mutable view for incremental fill of readonly result shapes. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
