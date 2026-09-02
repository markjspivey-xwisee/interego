/**
 * @module kernel/hypermedia
 * @description Linked-data + Hydra + SHACL decoration helpers for kernel
 * outputs.
 *
 * Every response the substrate emits is JSON, but JSON alone is not
 * navigable — clients see a flat record with no clue how to traverse to
 * the next resource. This module is the **substrate-wide policy** that
 * makes every output:
 *
 *  1. **Linked-data native**  — top-level `@context` / `@id` / `@type`
 *     so any JSON-LD 1.1 client can parse the response directly into
 *     RDF.
 *  2. **Hypermedia-driven**   — every actionable next step is exposed
 *     as a `hydra:Operation`-typed `affordances[]` entry. Clients
 *     follow the link instead of hardcoding URL templates.
 *  3. **SHACL-aware**         — every response advertises the SHACL
 *     shape its payload conforms to via `iep:conformsToShape`, so
 *     validators can verify the wire shape without out-of-band schema.
 *
 * The helpers are intentionally policy-only: they do not mutate the
 * underlying verb behaviour, they decorate the JSON envelope. Tools that
 * ignore the new fields continue to work unchanged; clients that look
 * for them get a native hypermedia surface.
 *
 * The kernel-response class hierarchy this module emits — `iep:KernelResult`
 * and its eight verb-specific subclasses (`iep:MintResult`,
 * `iep:DereferenceResult`, `iep:ComposeResult`, `iep:ActResult`,
 * `iep:RestrictResult`, `iep:ExtendResult`, `iep:PromoteResult`,
 * `iep:DecomposeResult`), plus `iep:ToolResult` for compatibility shims and
 * `iep:RelayEntryPoint` for the Hydra entry-point envelope — is declared in
 * `docs/ns/cg.ttl`. All other typing resolves into existing `iep:`, `hydra:`,
 * `sh:`, and `dcat:` IRIs.
 */

import type { IRI } from '../model/types.js';
import { CG, IEH, HYDRA, SHACL as SH } from '../rdf/namespaces.js';
import type { Affordance } from './types.js';

// ── JSON-LD context (the substrate-wide vocabulary surface) ──

/**
 * The JSON-LD `@context` every kernel-verb response carries. Defines
 * the prefixes a JSON-LD 1.1 client needs to expand the response into
 * RDF — including the substrate's `iep:`, `ieh:`, `hydra:`, `sh:`, and
 * a few standard companions (`prov:`, `dcat:`, `dct:`, `xsd:`).
 */
export const KERNEL_JSONLD_CONTEXT = Object.freeze({
  iep:    CG,
  // ns/harness# — the published harness namespace (docs/ns/harness.ttl). The
  // former value here, ns/cgh#, was never published and 404s; readers keep
  // accepting it via CGH_LEGACY.
  ieh:    IEH,
  hydra: HYDRA,
  sh:    SH,
  prov:  'http://www.w3.org/ns/prov#',
  dcat:  'http://www.w3.org/ns/dcat#',
  dct:   'http://purl.org/dc/terms/',
  xsd:   'http://www.w3.org/2001/XMLSchema#',
  rdf:   'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs:  'http://www.w3.org/2000/01/rdf-schema#',
  // Term aliases: lift the wire-level field names that appear in
  // kernel responses onto canonical predicates so a JSON-LD reader
  // resolves them without per-tool config.
  affordances:     { '@id': `${CG}affordance`,             '@container': '@set' },
  conformsToShape: { '@id': `${SH}shapesGraph`,            '@type': '@id' },
  operandIris:     { '@id': `${CG}operand`,                '@container': '@set', '@type': '@id' },
  action:          { '@id': `${CG}action`,                 '@type': '@id' },
  target:          { '@id': `${HYDRA}target`,              '@type': '@id' },
  method:          { '@id': `${HYDRA}method` },
  mediaType:       { '@id': `${HYDRA}returnsContentType` },
  expects:         { '@id': `${HYDRA}expects`,             '@type': '@id' },
  returns:         { '@id': `${HYDRA}returns`,             '@type': '@id' },
  apex:            { '@id': `${CG}apex`,                   '@type': '@id' },
  left:            { '@id': `${CG}left`,                   '@type': '@id' },
  right:           { '@id': `${CG}right`,                  '@type': '@id' },
  overlap:         { '@id': `${CG}overlap`,                '@type': '@id' },
}) as Readonly<Record<string, unknown>>;

// ── SHACL shape IRIs we reference on outputs ──

/**
 * Map of kernel result kinds to their canonical SHACL shape IRI. The
 * shapes themselves are exported by `validation/shacl-shapes.ts`; this
 * map is the lookup verbs use to advertise which shape a payload
 * conforms to.
 *
 * Result types that don't have a dedicated shape resolve to the
 * generic `iep:KernelResultShape` (a permissive base shape with
 * `@context` + `@id` + `@type` requirements).
 */
export const KERNEL_RESULT_SHAPES = Object.freeze({
  holon:       `${CG}HolonShape`           as IRI,
  descriptor:  `${CG}ContextDescriptorShape` as IRI,
  composed:    `${CG}ComposedDescriptorShape` as IRI,
  manifest:    `${CG}ManifestShape`        as IRI,
  affordance:  `${CG}AffordanceShape`      as IRI,
  promote:     `${CG}PromoteResultShape`   as IRI,
  decompose:   `${CG}DecomposeResultShape` as IRI,
  act:         `${CG}ActResultShape`       as IRI,
  dereference: `${CG}DereferenceResultShape` as IRI,
  reduce:      `${CG}ReduceResultShape`    as IRI,
  result:      `${CG}KernelResultShape`    as IRI,
  /**
   * ★ THE ONE KIND THAT IS NOT A SUCCESS. Ten kinds above describe ways to succeed and
   * there was no way to DECLINE, so a handler that refused returned an ordinary result whose
   * only signal was an `error` string. The REST dispatch, which sets no status of its own,
   * then sent it as HTTP 200: an unauthenticated call to a published affordance reported
   * SUCCESS to every caller that reads a status code. See `iep:Refusal` in docs/ns/iep.ttl.
   */
  refusal:     `${CG}RefusalShape`         as IRI,
}) as Readonly<Record<string, IRI>>;

/**
 * Which HTTP status each kernel result kind projects to.
 *
 * ★ DATA, NOT A BRANCH — AND THAT IS THE POINT. The dispatcher must not sniff a payload for
 * an `error` key to decide a status; that is the `if (x)` this substrate refuses everywhere
 * else, and the note above `KERNEL_RESULT_SHAPES` already states the rule: "each kernel verb
 * hands its own kind so we don't have to sniff the payload". A verb that DECLINES hands
 * `refusal`, and the code falls out of this table.
 *
 * Absent from this map means 200. Only the kinds that are not successes need an entry, and
 * `refusal` carries its own `iep:refusalStatus` when it needs to be more specific than the
 * default here (401 for a missing credential, 403 for a held-but-insufficient one).
 */
export const KERNEL_RESULT_STATUS = Object.freeze({
  refusal: 401,
}) as Readonly<Record<string, number>>;

/**
 * Does a response BODY declare itself an `iep:Refusal`?
 *
 * ── WHY A RETRY LAYER NEEDS THIS ─────────────────────────────────────────────
 *
 * A refusal is a DECISION. `followAffordance` throws on `status >= 500` so that
 * `withTransientRetry` will retry it, which is right for an infrastructure 5xx and wrong for a
 * vertical that has already decided: `unreadable-workspace`, `append-failed` and foxxi's
 * `upstreamFailed` all answer 502 BY DESIGN, and sending the same request three more times
 * cannot change any of them. Measured before this existed: one declined call cost four
 * attempts across ~15s of backoff and was refused identically four times.
 *
 * The test is the same one the dispatcher applies — the declared `kind`, never a sniff for an
 * `error` key. A body that is not JSON, or is JSON without that kind, is not a refusal, and
 * the caller keeps whatever policy it had.
 */
export function declaresRefusal(body: string): boolean {
  // Cheap reject first: parsing every 5xx body to answer "no" is the common case.
  if (!body || body.length > 1_000_000 || !body.includes('"refusal"')) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return Boolean(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>)['kind'] === 'refusal',
    );
  } catch {
    return false;
  }
}

// ── Hypermedia decoration ──

/**
 * Result-type discriminator used by the decorator to compute the
 * `@type` / `iep:conformsToShape` / suggested affordances. Each kernel
 * verb hands its own kind so we don't have to sniff the payload.
 */
export type KernelResultKind =
  | 'mint'
  | 'dereference'
  | 'compose'
  | 'act'
  | 'restrict'
  | 'extend'
  | 'promote'
  | 'decompose'
  | 'reduce';

/**
 * A fully Hydra-typed affordance, ready to be serialized as JSON-LD.
 * The on-wire structure mirrors `iep:Affordance` + `hydra:Operation`:
 * `@id` is the affordance subject IRI, `@type` lists the multi-class
 * typing, and the remaining fields are the operational metadata
 * (`hydra:method`, `hydra:target`, ...).
 */
export interface HypermediaAffordance {
  readonly '@id'?: string;
  readonly '@type': readonly string[];
  readonly action: string;
  readonly target: string;
  readonly method: string;
  readonly mediaType?: string;
  readonly expects?: string;
  readonly returns?: string;
  readonly fromDescriptor?: string;
}

/**
 * Decorate a raw affordance with full Hydra typing. The on-wire
 * representation becomes a multi-typed JSON-LD node — `iep:Affordance`,
 * `ieh:Affordance` (the harness namespace mirror used by verticals),
 * `hydra:Operation` — so any Hydra-aware client picks it up natively.
 */
export function hydraAffordance(aff: Affordance): HypermediaAffordance {
  const types: string[] = [
    `${CG}Affordance`,
    `${IEH}Affordance`,
    `${HYDRA}Operation`,
  ];
  const out: Mutable<HypermediaAffordance> = {
    '@type': types,
    action: aff.action,
    target: aff.target,
    method: aff.method,
  };
  if (aff.subjectIri) out['@id'] = aff.subjectIri;
  if (aff.mediaType) out.mediaType = aff.mediaType;
  if (aff.fromDescriptor) out.fromDescriptor = aff.fromDescriptor;
  return out;
}

/**
 * The JSON-LD envelope every kernel response is wrapped in. Adds
 * `@context`, an `@id` (when the result has a canonical IRI), an
 * `@type` list, a `iep:conformsToShape` shape IRI, and an
 * `affordances` array of fully Hydra-typed next-step operations.
 *
 * The original verb payload is spread at the top level so existing
 * consumers that read `r.holon` / `r.composed` / `r.apex` etc.
 * continue to work unchanged.
 */
export interface HypermediaEnvelope {
  readonly '@context': Readonly<Record<string, unknown>>;
  readonly '@id'?: string;
  readonly '@type': readonly string[];
  readonly conformsToShape: IRI;
  readonly affordances: readonly HypermediaAffordance[];
}

/**
 * Decorate a kernel-verb result with the substrate's hypermedia
 * envelope. The result's own fields are preserved verbatim at the top
 * level; the decoration adds `@context`, `@id`, `@type`,
 * `iep:conformsToShape`, and `affordances` (the hydra:Operation list
 * of next-step navigations).
 *
 * `nextSteps` lists the affordances that should be advertised for
 * subsequent traversal. Each entry is a partial affordance — the
 * decorator fills in the hydra typing.
 */
export function decorate<T extends Record<string, unknown>>(
  result: T,
  options: {
    readonly kind: KernelResultKind;
    readonly id?: string;
    readonly extraTypes?: readonly string[];
    readonly shape?: IRI;
    readonly nextSteps?: ReadonlyArray<Partial<Affordance> & { readonly action: string; readonly target: string; readonly method?: Affordance['method'] }>;
    /** Existing affordances already on the result (e.g. dereference). */
    readonly existing?: readonly Affordance[];
  },
): T & HypermediaEnvelope {
  const types = [...resolveTypes(options.kind), ...(options.extraTypes ?? [])];
  const shape = options.shape ?? resolveShape(options.kind);

  const allAffordances: HypermediaAffordance[] = [];
  if (options.existing) {
    for (const a of options.existing) allAffordances.push(hydraAffordance(a));
  }
  if (options.nextSteps) {
    for (const step of options.nextSteps) {
      allAffordances.push(hydraAffordance({
        action: step.action,
        target: step.target,
        method: (step.method ?? 'POST') as Affordance['method'],
        ...(step.mediaType ? { mediaType: step.mediaType } : {}),
        ...(step.fromDescriptor ? { fromDescriptor: step.fromDescriptor } : {}),
        ...(step.subjectIri ? { subjectIri: step.subjectIri } : {}),
      }));
    }
  }

  const envelope = {
    '@context': KERNEL_JSONLD_CONTEXT,
    ...(options.id ? { '@id': options.id } : {}),
    '@type': types,
    conformsToShape: shape,
    affordances: allAffordances,
  } as HypermediaEnvelope;

  // Spread the result's own fields LAST so verb-specific properties
  // (holon, composed, apex, ...) sit alongside the envelope. We keep
  // `affordances` from the envelope — if the result already had an
  // `affordances` array we already merged it via `options.existing`.
  // Use a `Mutable<>` cast so TS allows the dynamic build.
  const out: Record<string, unknown> = { ...envelope };
  for (const [k, v] of Object.entries(result)) {
    if (k === 'affordances') continue; // already handled
    out[k] = v;
  }
  return out as T & HypermediaEnvelope;
}

function resolveTypes(kind: KernelResultKind): string[] {
  switch (kind) {
    case 'mint':        return [`${CG}MintResult`,        `${CG}Holon`];
    case 'dereference': return [`${CG}DereferenceResult`, `${HYDRA}Resource`];
    case 'compose':     return [`${CG}ComposeResult`,     `${CG}ComposedDescriptor`];
    case 'act':         return [`${CG}ActResult`];
    case 'restrict':    return [`${CG}RestrictResult`,    `${CG}ContextDescriptor`];
    case 'extend':      return [`${CG}ExtendResult`,      `${CG}ContextDescriptor`];
    case 'promote':     return [`${CG}PromoteResult`];
    case 'decompose':   return [`${CG}DecomposeResult`];
    case 'reduce':      return [`${CG}ReduceResult`];
  }
}

function resolveShape(kind: KernelResultKind): IRI {
  switch (kind) {
    case 'mint':        return KERNEL_RESULT_SHAPES['holon']!;
    case 'dereference': return KERNEL_RESULT_SHAPES['dereference']!;
    case 'compose':     return KERNEL_RESULT_SHAPES['composed']!;
    case 'act':         return KERNEL_RESULT_SHAPES['act']!;
    case 'restrict':    return KERNEL_RESULT_SHAPES['descriptor']!;
    case 'extend':      return KERNEL_RESULT_SHAPES['descriptor']!;
    case 'promote':    return KERNEL_RESULT_SHAPES['promote']!;
    case 'decompose':   return KERNEL_RESULT_SHAPES['decompose']!;
    case 'reduce':      return KERNEL_RESULT_SHAPES['reduce']!;
  }
}

// ── Shim hypermedia (for the 27 named tools) ──

/**
 * Decorate a named-shim payload (publish_context, discover_context,
 * etc.) with the same hypermedia envelope kernel verbs use. The
 * shim's wire shape is preserved verbatim; the decoration adds
 * `@context`, `@id` (when known), `@type` (the action IRI as a class),
 * `conformsToShape`, and `affordances` for next-step navigation.
 *
 * Shims aren't kernel verbs, so we accept the `@type` + shape IRI
 * directly instead of resolving from a fixed enum.
 */
export function decorateShim<T extends Record<string, unknown>>(
  payload: T,
  options: {
    readonly tool: string;
    readonly id?: string;
    readonly types?: readonly string[];
    readonly shape?: IRI;
    readonly nextSteps?: ReadonlyArray<Partial<Affordance> & { readonly action: string; readonly target: string; readonly method?: Affordance['method'] }>;
  },
): T & HypermediaEnvelope {
  const types = [
    `${CG}ToolResult`,
    `urn:iep:tool-result:${options.tool}`,
    ...(options.types ?? []),
  ];
  return decorate(payload as Record<string, unknown>, {
    kind: 'act', // generic — shim isn't a kernel kind
    ...(options.id ? { id: options.id } : {}),
    extraTypes: types,
    ...(options.shape ? { shape: options.shape } : {}),
    ...(options.nextSteps ? { nextSteps: options.nextSteps } : {}),
  }) as T & HypermediaEnvelope;
}

// ── Hydra EntryPoint (the top-level relay surface) ──

/**
 * The JSON-LD `hydra:EntryPoint` document an HTTP relay returns at
 * its root. Lists every top-level operation a Hydra-aware client can
 * follow, plus the SHACL shapes graph and the relay's tool catalog.
 *
 * Callers pass the relay's base URL (e.g. `https://interego.example`)
 * and a list of (name, target, method) triples for the operations
 * worth advertising. The decorator embeds them as fully Hydra-typed
 * operations alongside the `@context` so clients can navigate
 * directly from the entry point to any endpoint.
 */
export function hydraEntryPoint(options: {
  readonly base: string;
  readonly title?: string;
  readonly description?: string;
  readonly operations: ReadonlyArray<{
    readonly name: string;
    readonly target: string;
    readonly method?: string;
    readonly description?: string;
    readonly returns?: string;
  }>;
  readonly shapesGraph?: string;
}): Record<string, unknown> {
  const base = options.base.replace(/\/$/, '');
  const operations = options.operations.map(op => ({
    '@type': [
      `${CG}Affordance`,
      `${IEH}Affordance`,
      `${HYDRA}Operation`,
    ],
    action: `urn:iep:action:${op.name}`,
    title: op.name,
    target: op.target.startsWith('http') ? op.target : `${base}${op.target}`,
    method: op.method ?? 'GET',
    ...(op.description ? { description: op.description } : {}),
    ...(op.returns ? { returns: op.returns } : {}),
  }));

  return {
    '@context': KERNEL_JSONLD_CONTEXT,
    '@id': base,
    '@type': [`${HYDRA}EntryPoint`, `${CG}RelayEntryPoint`],
    ...(options.title ? { 'hydra:title': options.title } : {}),
    ...(options.description ? { 'hydra:description': options.description } : {}),
    conformsToShape: `${CG}RelayEntryPointShape`,
    ...(options.shapesGraph ? { shapesGraph: options.shapesGraph } : {}),
    affordances: operations,
  };
}

/** Local mutable view for incremental fill. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
