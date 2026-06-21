/**
 * @module solid/client
 * @description Solid pod runtime for Interego 1.0
 *
 * Three functions that bridge the data-model layer to a live
 * decentralized storage layer:
 *
 *   publish()   — write a descriptor + graph to a Solid pod
 *   discover()  — fetch and filter the context-graphs manifest
 *   subscribe() — watch a pod for context-graph changes via
 *                 Solid Notifications Protocol (WebSocket)
 *
 * Uses only fetch and WebSocket — zero additional dependencies.
 */

import type { ContextDescriptorData, ContextTypeName, OwnerProfileData, AgentDelegationCredential, DelegationVerification, DelegationVerifier, IRI, SemioticFacetData, TrustFacetData, ModalStatus, TrustLevel, ContextFacetData } from '@interego/core';
import { toTurtle } from '@interego/core';
import { turtlePrefixes } from '@interego/core';
import { ownerProfileToTurtle, parseOwnerProfile, delegationCredentialToJsonLd, parseDelegationCredential, verifyDelegation } from '@interego/core';
import { createEncryptedEnvelope, openEncryptedEnvelope, type EncryptedEnvelope, type EncryptionKeyPair } from '@interego/core';
import { computeCid } from '@interego/core';
import { withTransientRetry } from '@interego/core/http';
import { getDefaultFetch, getDefaultWebSocket } from '@interego/core/http';

import { PublishPreconditionFailedError, PublishShapeViolationError } from './types.js';
import { validateAgainstShape } from '@interego/core';

import type { FetchFn } from '@interego/core/http';
import type {
  PublishResult,
  PublishOptions,
  DiscoverFilter,
  DiscoverOptions,
  ManifestEntry,
  ContextChangeCallback,
  ContextChangeEvent,
  Subscription,
  SubscribeOptions,
  RegistryOptions,
} from './types.js';

import { AGENT_REGISTRY_PATH, CREDENTIALS_PATH } from './types.js';

// ── Constants ───────────────────────────────────────────────

const MANIFEST_PATH = '.well-known/context-graphs';

// ── Per-pod in-process manifest mutex ───────────────────────
//
// publish() does a read-modify-write cycle against
//   ${pod}/.well-known/context-graphs
// using HTTP optimistic concurrency (If-Match / If-None-Match) with up
// to 8 backoff retries. That CAS dance is the correct protection
// against cross-process / cross-host writers, but it is the WRONG tool
// for in-process concurrent publishes from the same Node process
// (e.g. a relay handling N parallel cartographer fan-outs or a
// Promise.all over voters from one pod):
//
//   - every writer GETs the same etag
//   - every writer builds a body that contains only its own entry
//   - the server commits one writer and 412s the rest
//   - the rest re-GET, retry, and only converge after burning their
//     retry budget
//
// Under heavy in-process contention this either drops entries (when
// the post-PUT verify read-back races with another writer's PUT into
// a false-positive) or throws after maxAttempts=8 (visible as
// `Failed to update manifest ... after 8 attempts`).
//
// Fix: serialize same-process writers to the same pod by chaining
// their manifest read-modify-write cycles through a per-pod promise
// queue. A Map<manifestUrl, Promise<void>> at module scope. On entry
// to the manifest-update block, await the prior promise for this pod
// (if any) and replace the map entry with the new tail so subsequent
// callers queue behind us. On exit, if we are the current tail (no
// one queued behind), delete the entry so the map doesn't grow.
//
// This collapses N same-process writers from a retry-storm into a
// serial queue — each iteration sees the freshest body and no etag
// fight is needed. Cross-process writers still get the existing HTTP
// CAS protection unchanged.
const manifestWriteQueues = new Map<string, Promise<void>>();

async function withManifestLock<T>(
  manifestUrl: string,
  body: () => Promise<T>,
): Promise<T> {
  const previous = manifestWriteQueues.get(manifestUrl) ?? Promise.resolve();
  let resolveTail!: () => void;
  const tail = new Promise<void>((r) => { resolveTail = r; });
  // Chain so subsequent callers wait for the prior tail AND for us.
  const newTail = previous.then(() => tail);
  manifestWriteQueues.set(manifestUrl, newTail);
  try {
    // Wait for any prior writer to finish their CAS cycle before we
    // start ours. We deliberately swallow prior errors — a previous
    // publish failing should not prevent the next one from starting.
    await previous.catch(() => undefined);
    return await body();
  } finally {
    resolveTail();
    // If no one queued behind us, drop the entry so the map doesn't
    // grow unbounded across the lifetime of the process.
    if (manifestWriteQueues.get(manifestUrl) === newTail) {
      manifestWriteQueues.delete(manifestUrl);
    }
  }
}
const DEFAULT_CONTAINER = 'context-graphs/';
const TURTLE_CONTENT_TYPE = 'text/turtle';
const TRIG_CONTENT_TYPE = 'application/trig';
// JWE-family IANA type; pragmatically correct for our tweetnacl envelope
// even though we aren't using JOSE's wire format — the semantics match
// (encrypted payload + per-recipient wrapped keys) and the media type is
// the signal other clients need to know "don't try to parse this as RDF".
const ENVELOPE_CONTENT_TYPE = 'application/jose+json';

// ── Helpers ─────────────────────────────────────────────────

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function slugFromIri(iri: string): string {
  const last = iri.split(/[/:#]/).filter(Boolean).pop() ?? 'descriptor';
  return encodeURIComponent(last);
}

/**
 * Predict the URL `publish()` will use for a given pod + descriptor ID
 * BEFORE actually calling publish(). Used by callers (notably the
 * compliance flow) that need to know the future URL — e.g., to embed
 * a self-referential `iep:proof` URL in the descriptor's TrustFacet
 * before the descriptor is serialized + signed.
 *
 * Returns the same URL `publish()` would generate as `descriptorUrl`.
 * If the caller passes custom `containerPath` or `descriptorSlug` to
 * publish(), they should pass them here too so the prediction matches.
 */
export function predictDescriptorUrl(
  podUrl: string,
  descriptorId: string,
  options?: { containerPath?: string; descriptorSlug?: string },
): string {
  const pod = ensureTrailingSlash(podUrl);
  const container = ensureTrailingSlash(`${pod}${options?.containerPath ?? DEFAULT_CONTAINER}`);
  const slug = options?.descriptorSlug ?? slugFromIri(descriptorId);
  return `${container}${slug}.ttl`;
}

/**
 * Predict the URL `publish()` will use for the graph payload.
 *
 * Mirrors the file-naming convention used inside publish() — the
 * payload lives at `<container>/<descriptorSlug>-graph.trig` for
 * plaintext publishes and `<container>/<descriptorSlug>-graph.envelope.jose.json`
 * for encrypted ones. Surfaced as a separate helper so the MCP relay's
 * accept-then-publish path can return a content-addressable graph URL
 * synchronously, before the actual CSS write has completed.
 *
 * The same warning applies as predictDescriptorUrl — if the caller
 * passes custom `containerPath`/`descriptorSlug`/`graphSlug` to publish(),
 * pass them here too.
 */
export function predictGraphUrl(
  podUrl: string,
  descriptorId: string,
  options?: {
    containerPath?: string;
    descriptorSlug?: string;
    graphSlug?: string;
    encrypted?: boolean;
  },
): string {
  const pod = ensureTrailingSlash(podUrl);
  const container = ensureTrailingSlash(`${pod}${options?.containerPath ?? DEFAULT_CONTAINER}`);
  const slug = options?.descriptorSlug ?? slugFromIri(descriptorId);
  const graphSlug = options?.graphSlug ?? `${slug}-graph`;
  return options?.encrypted
    ? `${container}${graphSlug}.envelope.jose.json`
    : `${container}${graphSlug}.trig`;
}

/**
 * Predict the URL `publish()` will use for the manifest. The manifest
 * is per-pod (not per-descriptor), so this only depends on the pod URL.
 */
export function predictManifestUrl(podUrl: string): string {
  const pod = ensureTrailingSlash(podUrl);
  return `${pod}${MANIFEST_PATH}`;
}

// Substrate-level HTTP plumbing (`getDefaultFetch`, `getDefaultWebSocket`,
// `withTransientRetry`) lives in `../http/`. `getDefaultFetch` used to be
// defined and exported from this file — it is re-exported below so the
// historical import path keeps working.
export { getDefaultFetch } from '@interego/core/http';

/**
 * Wrap Turtle triples inside a TriG named graph block.
 *
 * Per W3C TriG (https://www.w3.org/TR/trig/) §2.2, `@prefix` / `@base`
 * directives appear only at document scope, never inside a wrappedGraph
 * `{ ... }` block. The historical implementation indented the caller's
 * `graphContent` verbatim into the named-graph block, which meant any
 * `@prefix` lines embedded in caller-supplied content landed inside
 * the block — a syntax error in strict parsers, and (worse) silently
 * mis-scoped in lenient parsers, so prefixed terms in the content
 * never resolved at document level. This broke SHACL gates that target
 * prefixed IRIs (`ex:Thing`): the shape's target IRI parsed against
 * an unbound prefix, the gate found zero focus nodes, and the shape
 * vacuously conformed.
 *
 * This implementation extracts every `@prefix` / `@base` (and SPARQL
 * `PREFIX` / `BASE`) directive from `graphContent`, merges them with
 * the descriptor's own prefix block at document scope (descriptor
 * declarations win on conflict; new prefix names are appended), and
 * emits ONLY the remaining triples inside the named-graph block — which
 * inherits the document-level prefix bindings automatically.
 */
function wrapAsTriG(
  descriptorTurtle: string,
  graphContent: string,
  graphIri: string,
): string {
  // Extract the descriptor's prefix block — everything up to and
  // including the newline that follows the last `@prefix` directive.
  const prefixEnd = descriptorTurtle.lastIndexOf('@prefix');
  const afterLastPrefix = descriptorTurtle.indexOf('\n', prefixEnd);
  const descriptorPrefixBlock = descriptorTurtle.slice(0, afterLastPrefix + 1);
  const descriptorBody = descriptorTurtle.slice(afterLastPrefix + 1).trim();

  // Identify per-line directives in the caller-supplied graph content.
  // Recognise the four standard forms: `@prefix`, `@base`, SPARQL
  // `PREFIX`, and SPARQL `BASE`. Matched lines are hoisted; everything
  // else is treated as graph body.
  const directiveRe = /^\s*(@prefix\s+\w*:\s*<[^>]+>\s*\.|@base\s+<[^>]+>\s*\.|PREFIX\s+\w*:\s*<[^>]+>|BASE\s+<[^>]+>)\s*$/i;
  const graphLines = graphContent.split('\n');
  const graphDirectives: string[] = [];
  const graphBodyLines: string[] = [];
  for (const line of graphLines) {
    if (directiveRe.test(line)) {
      graphDirectives.push(line.trim());
    } else {
      graphBodyLines.push(line);
    }
  }

  // Collect the prefix names the descriptor already declares so caller
  // prefixes that name the same alias don't shadow the descriptor's
  // canonical binding. Normalise SPARQL-style `PREFIX` directives to
  // Turtle `@prefix` form when re-emitting, so the document is
  // syntactically uniform.
  const prefixNameRe = /^\s*(?:@prefix|PREFIX)\s+(\w*):/i;
  const declaredPrefixes = new Set<string>();
  for (const l of descriptorPrefixBlock.split('\n')) {
    const m = l.match(prefixNameRe);
    if (m) declaredPrefixes.add(m[1]!);
  }
  const additionalPrefixLines: string[] = [];
  for (const directive of graphDirectives) {
    const m = directive.match(prefixNameRe);
    // `@base` / `BASE` have no prefix name; if a caller declares a base
    // we hoist it once and let the descriptor block keep its (typically
    // absent) base. SPARQL `PREFIX a: <...>` → Turtle `@prefix a: <...> .`
    if (!m) {
      // @base / BASE — hoist verbatim, normalising SPARQL form to Turtle.
      if (/^\s*BASE\s/i.test(directive)) {
        additionalPrefixLines.push(directive.replace(/^\s*BASE\s+(<[^>]+>)\s*$/i, '@base $1 .'));
      } else {
        additionalPrefixLines.push(directive);
      }
      continue;
    }
    if (declaredPrefixes.has(m[1]!)) continue;
    declaredPrefixes.add(m[1]!);
    if (/^\s*PREFIX\s/i.test(directive)) {
      additionalPrefixLines.push(
        directive.replace(/^\s*PREFIX\s+(\w*):\s*(<[^>]+>)\s*$/i, '@prefix $1: $2 .'),
      );
    } else {
      additionalPrefixLines.push(directive);
    }
  }

  const lines: string[] = [];
  lines.push(descriptorPrefixBlock.trimEnd());
  if (additionalPrefixLines.length > 0) {
    lines.push(additionalPrefixLines.join('\n'));
  }
  lines.push('');
  lines.push('# ── Context Descriptor ────────────────────────────');
  lines.push(descriptorBody);
  lines.push('');
  lines.push('# ── Named Graph Content ───────────────────────────');
  lines.push(`<${graphIri}> {`);
  for (const line of graphBodyLines) {
    lines.push(line ? `    ${line}` : '');
  }
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build the Hydra Collection header for the manifest.
 * The manifest is a hydra:Collection with hypermedia affordances.
 *
 * Affordances declared:
 *   hydra:operation → PUT (publish new context)
 *   iep:canDiscover  → GET the manifest
 *   iep:canSubscribe → WebSocket via Solid Notifications
 *
 * DPROD alignment:
 *   Each manifest is also a dprod:DataProduct with an outputPort
 *   (the manifest itself as a DCAT distribution).
 */
function manifestHeaderTurtle(podUrl: string): string {
  const manifestUrl = `${podUrl}${MANIFEST_PATH}`;
  return [
    `# Interego Manifest — Hydra-aware, DPROD-aligned`,
    ``,
    `<${manifestUrl}> a hydra:Collection, iep:DataProduct ;`,
    `    hydra:manages [`,
    `        hydra:property iep:describes ;`,
    `        hydra:object iep:ManifestEntry`,
    `    ] ;`,
    `    # HATEOAS affordances — what agents can do with this manifest`,
    `    hydra:operation [`,
    `        a hydra:Operation ;`,
    `        hydra:method "GET" ;`,
    `        hydra:title "Discover context descriptors" ;`,
    `        hydra:expects <http://www.w3.org/ns/hydra/core#Resource> ;`,
    `        hydra:returns iep:ManifestEntry`,
    `    ] ;`,
    `    hydra:operation [`,
    `        a hydra:Operation ;`,
    `        hydra:method "PUT" ;`,
    `        hydra:title "Publish new context descriptor" ;`,
    `        hydra:expects iep:ContextDescriptor ;`,
    `        hydra:returns iep:ManifestEntry`,
    `    ] ;`,
    `    # Affordance declarations for agent capability discovery`,
    `    iep:affordance iep:canDiscover, iep:canSubscribe ;`,
    `    # DPROD: this manifest is a data product output port`,
    `    iep:outputPort [`,
    `        a dcat:Distribution ;`,
    `        dcat:mediaType "text/turtle" ;`,
    `        dcat:accessURL <${manifestUrl}>`,
    `    ] .`,
  ].join('\n');
}

/**
 * Build a Turtle manifest entry for a published descriptor.
 *
 * `descriptorCid` (optional) is the content-CID of the descriptor's
 * Turtle body. When supplied it's mirrored onto the entry as
 * `iep:contentCid "<cid>"` so CAS supersession gates can compare
 * `if_match` against the head identity without a body GET + rehash.
 */
function manifestEntryTurtle(
  descriptorUrl: string,
  descriptor: ContextDescriptorData,
  descriptorCid?: string,
): string {
  const lines: string[] = [];
  lines.push(`<${descriptorUrl}> a iep:ManifestEntry ;`);

  if (descriptorCid) {
    lines.push(`    iep:contentCid "${descriptorCid}" ;`);
  }

  for (const g of descriptor.describes) {
    lines.push(`    iep:describes <${g}> ;`);
  }

  const facetTypes = [...new Set(descriptor.facets.map(f => f.type))];
  for (const ft of facetTypes) {
    lines.push(`    iep:hasFacetType iep:${ft} ;`);
  }

  if (descriptor.validFrom) {
    lines.push(`    iep:validFrom "${descriptor.validFrom}"^^xsd:dateTime ;`);
  }
  if (descriptor.validUntil) {
    lines.push(`    iep:validUntil "${descriptor.validUntil}"^^xsd:dateTime ;`);
  }

  // conformsTo (cleartext-mirrored)
  if (descriptor.conformsTo) {
    for (const c of descriptor.conformsTo) {
      lines.push(`    dct:conformsTo <${c}> ;`);
    }
  }

  // supersedes (cleartext-mirrored — lets downstream code identify
  // head-of-chain entries from the manifest alone, without fetching
  // each descriptor's TriG)
  if (descriptor.supersedes && descriptor.supersedes.length > 0) {
    for (const s of descriptor.supersedes) {
      lines.push(`    iep:supersedes <${s}> ;`);
    }
  }

  // Extract modalStatus from Semiotic facet if present
  const semioticFacet = descriptor.facets.find((f): f is SemioticFacetData => f.type === 'Semiotic');
  if (semioticFacet?.modalStatus) {
    lines.push(`    iep:modalStatus iep:${semioticFacet.modalStatus} ;`);
  }

  // Extract trustLevel + issuer from Trust facet if present
  const trustFacet = descriptor.facets.find((f): f is TrustFacetData => f.type === 'Trust');
  if (trustFacet?.trustLevel) {
    lines.push(`    iep:trustLevel iep:${trustFacet.trustLevel} ;`);
  }
  if (trustFacet?.issuer) {
    // Cleartext-mirror the issuer DID so trust-aware federation readers
    // can filter by author from the manifest alone (no descriptor fetch).
    // iep:issuer is already defined in docs/ns/cg.ttl as "the issuer of
    // the trust assertion (typically a DID)" — exactly what we need here.
    lines.push(`    iep:issuer <${trustFacet.issuer}> ;`);
  }

  // Replace trailing ; with .
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ ;$/, ' .');

  return lines.join('\n');
}

// ── Manifest parsing ────────────────────────────────────────

/**
 * Parse a Turtle manifest into ManifestEntry[].
 *
 * Expects the lightweight format written by publish():
 *   <url> a iep:ManifestEntry ;
 *       iep:describes <graph> ;
 *       iep:hasFacetType iep:Temporal ;
 *       iep:validFrom "..."^^xsd:dateTime .
 */
export function parseManifest(turtle: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  let current: {
    descriptorUrl: string;
    cid?: string;
    describes: string[];
    facetTypes: ContextTypeName[];
    validFrom?: string;
    validUntil?: string;
    modalStatus?: ModalStatus;
    trustLevel?: TrustLevel;
    issuer?: string;
    conformsTo?: string[];
    supersedes?: string[];
    pgslUri?: string;
    pgslLevel?: number;
  } | null = null;

  const finalize = (
    e: NonNullable<typeof current>,
  ): ManifestEntry => {
    // Reconstruct the minimal facet set the manifest mirrors so that
    // trust-aware readers can filter by facet shape without re-fetching
    // each descriptor's TriG. Only the fields the manifest itself
    // carries are populated; everything else stays in the descriptor.
    //
    // Trust-facet reconstruction has two trigger paths:
    //   (a) trustLevel and/or issuer were directly extracted from the
    //       manifest entry by the regex sweep above — populate the facet
    //       with whichever fields landed.
    //   (b) the manifest declared `iep:hasFacetType iep:Trust` for the entry
    //       but neither trustLevel nor issuer were captured. This can
    //       happen when an upstream serializer flattens or re-orders the
    //       entry. Still emit a Trust facet so trust-aware readers see the
    //       declared shape; they will fall back to the descriptor for the
    //       missing fields rather than misclassify the entry as untrusted.
    const facets: ContextFacetData[] = [];
    const hasTrustFacetType = e.facetTypes.includes('Trust' as ContextTypeName);
    if (e.trustLevel || e.issuer || hasTrustFacetType) {
      const tf: { type: 'Trust'; trustLevel?: TrustLevel; issuer?: IRI } = { type: 'Trust' };
      if (e.trustLevel) tf.trustLevel = e.trustLevel;
      if (e.issuer) tf.issuer = e.issuer as IRI;
      facets.push(tf as ContextFacetData);
    }
    if (e.modalStatus) {
      facets.push({ type: 'Semiotic', modalStatus: e.modalStatus } as ContextFacetData);
    }
    const out: ManifestEntry = {
      descriptorUrl: e.descriptorUrl,
      ...(e.cid !== undefined ? { cid: e.cid } : {}),
      describes: e.describes,
      facetTypes: e.facetTypes,
      ...(e.validFrom !== undefined ? { validFrom: e.validFrom } : {}),
      ...(e.validUntil !== undefined ? { validUntil: e.validUntil } : {}),
      ...(e.modalStatus !== undefined ? { modalStatus: e.modalStatus } : {}),
      ...(e.trustLevel !== undefined ? { trustLevel: e.trustLevel } : {}),
      ...(e.issuer !== undefined ? { issuer: e.issuer } : {}),
      ...(e.conformsTo !== undefined ? { conformsTo: e.conformsTo } : {}),
      ...(e.supersedes !== undefined ? { supersedes: e.supersedes } : {}),
      ...(e.pgslUri !== undefined ? { pgslUri: e.pgslUri } : {}),
      ...(e.pgslLevel !== undefined ? { pgslLevel: e.pgslLevel } : {}),
      ...(facets.length > 0 ? { facets } : {}),
    };
    return out;
  };

  for (const rawLine of turtle.split('\n')) {
    const line = rawLine.trim();

    const entryMatch = line.match(/^<([^>]+)>\s+a\s+iep:ManifestEntry/);
    if (entryMatch) {
      if (current) {
        entries.push(finalize(current));
      }
      current = {
        descriptorUrl: entryMatch[1]!,
        describes: [],
        facetTypes: [],
      };
      continue;
    }

    if (!current) continue;

    const cidMatch = line.match(/iep:contentCid\s+"([^"]+)"/);
    if (cidMatch) {
      current.cid = cidMatch[1]!;
    }

    const describesMatch = line.match(/iep:describes\s+<([^>]+)>/);
    if (describesMatch) {
      current.describes.push(describesMatch[1]!);
    }

    const facetMatch = line.match(/iep:hasFacetType\s+iep:(\w+)/);
    if (facetMatch) {
      current.facetTypes.push(facetMatch[1]! as ContextTypeName);
    }

    const fromMatch = line.match(/iep:validFrom\s+"([^"]+)"/);
    if (fromMatch) {
      current.validFrom = fromMatch[1]!;
    }

    const untilMatch = line.match(/iep:validUntil\s+"([^"]+)"/);
    if (untilMatch) {
      current.validUntil = untilMatch[1]!;
    }

    const modalMatch = line.match(/iep:modalStatus\s+iep:(\w+)/);
    if (modalMatch) {
      current.modalStatus = modalMatch[1]! as ModalStatus;
    }

    const trustMatch = line.match(/iep:trustLevel\s+iep:(\w+)/);
    if (trustMatch) {
      current.trustLevel = trustMatch[1]! as TrustLevel;
    }

    const issuerMatch = line.match(/iep:issuer\s+<([^>]+)>/);
    if (issuerMatch) {
      current.issuer = issuerMatch[1]!;
    }

    const conformsMatch = line.match(/dct:conformsTo\s+<([^>]+)>/);
    if (conformsMatch) {
      current.conformsTo = current.conformsTo ?? [];
      current.conformsTo.push(conformsMatch[1]!);
    }

    const supersedesMatch = line.match(/iep:supersedes\s+<([^>]+)>/);
    if (supersedesMatch) {
      current.supersedes = current.supersedes ?? [];
      current.supersedes.push(supersedesMatch[1]!);
    }

    // PGSL lattice pointer (Stage 3 projection) — links a manifest row back to
    // the holon it projects. Content-addressed, so structural overlap across
    // pods is detectable from the manifest alone. Additive: legacy rows omit it.
    const pgslUriMatch = line.match(/iep:pgslUri\s+<([^>]+)>/);
    if (pgslUriMatch) {
      current.pgslUri = pgslUriMatch[1]!;
    }
    const pgslLevelMatch = line.match(/iep:pgslLevel\s+"(\d+)"/);
    if (pgslLevelMatch) {
      current.pgslLevel = Number(pgslLevelMatch[1]);
    }

    if (line.endsWith('.')) {
      if (current) {
        entries.push(finalize(current));
        current = null;
      }
    }
  }

  if (current) {
    entries.push(finalize(current));
  }

  return entries;
}

// ── Manifest reconstruction (heals f-manifest-collapse) ─────────────
//
// The manifest at <pod>/.well-known/context-graphs is an INDEX, not the
// authority — every descriptor + payload is content-addressed and
// fetchable by URL, and supersession links live inside the descriptors.
// So a lost/truncated index is fully recoverable by scanning the on-pod
// descriptors and rebuilding one entry each. Used by (a) publish()'s
// 404-heal path so a missing manifest is never replaced by a 1-entry
// stub, and (b) the relay's /admin/rebuild-manifest one-shot restore.

const _fetchFallback: FetchFn = (async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  return {
    ok: r.ok, status: r.status, statusText: r.statusText,
    headers: { get: (n: string) => r.headers.get(n) },
    text: () => r.text(), json: () => r.json(),
  };
}) as FetchFn;

/**
 * Build a single manifest entry from a descriptor's Turtle by extracting
 * the indexable fields (describes, validFrom, conformsTo, supersedes,
 * facet types, modalStatus, trustLevel, contentCid) — mirrors the shape
 * `manifestEntryTurtle` emits. Returns null if the Turtle has no
 * `iep:describes` (i.e. it isn't a descriptor).
 */
function manifestEntryFromDescriptorTurtle(descriptorUrl: string, ttl: string): string | null {
  const grabAll = (src: string): string[] => {
    const out: string[] = []; const re = new RegExp(src, 'g'); let m: RegExpExecArray | null;
    while ((m = re.exec(ttl)) !== null) out.push(m[1]!);
    return out;
  };
  const describes = grabAll('iep:describes\\s+<([^>]+)>');
  if (describes.length === 0) return null;
  const one = (src: string): string | undefined => (ttl.match(new RegExp(src)) ?? [])[1];
  const validFrom = one('iep:validFrom\\s+"([^"]+)"');
  const validUntil = one('iep:validUntil\\s+"([^"]+)"');
  const conformsTo = grabAll('dct:conformsTo\\s+<([^>]+)>');
  const supersedes = grabAll('iep:supersedes\\s+<([^>]+)>');
  const facetTypes = [...new Set(grabAll('a\\s+iep:(\\w+)Facet\\b'))]; // 'TemporalFacet' → 'Temporal'
  const modalStatus = one('iep:modalStatus\\s+iep:(\\w+)');
  const trustLevel = one('iep:trustLevel\\s+iep:(\\w+)');
  const issuer = one('iep:issuer\\s+<([^>]+)>');
  const cid = one('iep:contentCid\\s+"([^"]+)"');

  const lines: string[] = [`<${descriptorUrl}> a iep:ManifestEntry ;`];
  if (cid) lines.push(`    iep:contentCid "${cid}" ;`);
  for (const g of describes) lines.push(`    iep:describes <${g}> ;`);
  for (const ft of facetTypes) lines.push(`    iep:hasFacetType iep:${ft} ;`);
  if (validFrom) lines.push(`    iep:validFrom "${validFrom}"^^xsd:dateTime ;`);
  if (validUntil) lines.push(`    iep:validUntil "${validUntil}"^^xsd:dateTime ;`);
  for (const c of conformsTo) lines.push(`    dct:conformsTo <${c}> ;`);
  for (const s of supersedes) lines.push(`    iep:supersedes <${s}> ;`);
  if (modalStatus) lines.push(`    iep:modalStatus iep:${modalStatus} ;`);
  if (trustLevel) lines.push(`    iep:trustLevel iep:${trustLevel} ;`);
  if (issuer) lines.push(`    iep:issuer <${issuer}> ;`);
  lines[lines.length - 1] = lines[lines.length - 1]!.replace(/;\s*$/, '.');
  return lines.join('\n');
}

/** List the descriptor (.ttl, NOT -graph.trig) URLs in a pod's context-graphs/ container. */
// Pod-root containers that never hold cg descriptors/credentials — skipped on a
// pod-wide manifest scan (don't walk a huge LDN inbox or profile docs).
const NON_DESCRIPTOR_CONTAINERS = new Set(['inbox/', '.well-known/', 'profile/', 'settings/']);

/**
 * Read a container's DECLARED membership — the objects of its `ldp:contains`
 * (the LDP membership *control* the container publishes), resolved against the
 * container base. We follow the hypermedia the container advertises rather than
 * inferring membership from filename shape: a regex over filenames is exactly
 * what silently dropped %-encoded credential names and whole containers. Walks
 * the object list after each ldp:contains (prefixed or full-IRI), tolerant of
 * dotted IRIs (`…/1781.ttl`) since each object is delimited by its own `<>`.
 */
function ldpContainsMembers(body: string, base: string): string[] {
  const out: string[] = [];
  const predRe = /(?:ldp:contains|<http:\/\/www\.w3\.org\/ns\/ldp#contains>)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = predRe.exec(body)) !== null) {
    let i = pm.index + pm[0].length;
    // Collect the comma/whitespace-separated <…> objects until the statement
    // boundary (a token that is not a separator or another <…>).
    for (;;) {
      while (i < body.length && /[\s,]/.test(body[i]!)) i++;
      if (body[i] !== '<') break;
      const end = body.indexOf('>', i);
      if (end < 0) break;
      const ref = body.slice(i + 1, end);
      try { out.push(new URL(ref, base).toString()); } catch { /* skip malformed */ }
      i = end + 1;
    }
  }
  return out;
}

async function listDescriptorUrls(pod: string, fetchFn: FetchFn): Promise<string[]> {
  // Membership comes from each container's advertised `ldp:contains`, NOT a
  // filename regex. Enumerate the pod's child containers from the root's
  // ldp:contains (minus known system ones), always including the two we know
  // hold manifest content, then read each container's ldp:contains members.
  // Non-descriptor members are filtered downstream by
  // manifestEntryFromDescriptorTurtle (it reads each member's declared type), so
  // the only filename heuristic left is distinguishing a descriptor (`.ttl`)
  // from its own graph payload (`-graph.trig`) — both are real declared members.
  const containers = new Set<string>([`${pod}${DEFAULT_CONTAINER}`, `${pod}foxxi-wallet/`]);
  try {
    const root = await fetchFn(pod, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } });
    if (root.ok) {
      for (const member of ldpContainsMembers(await root.text(), pod)) {
        if (member.startsWith(pod) && member.endsWith('/') && member !== pod
            && !NON_DESCRIPTOR_CONTAINERS.has(member.slice(pod.length))) {
          containers.add(member);
        }
      }
    }
  } catch { /* fall back to the known containers below */ }

  const urls = new Set<string>();
  for (const containerUrl of containers) {
    let r: Awaited<ReturnType<FetchFn>>;
    try { r = await fetchFn(containerUrl, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } }); }
    catch (e) { throw new Error(`container GET <${containerUrl}> failed: ${(e as Error).message}`); }
    if (r.status === 404) continue;                       // missing container (e.g. no foxxi-wallet yet) — fine
    // Any non-404 failure aborts the rebuild rather than PUT a PARTIAL manifest
    // (a transient 5xx must not silently drop a whole container's entries).
    if (!r.ok) throw new Error(`container GET <${containerUrl}> -> ${r.status} ${r.statusText}`);
    for (const member of ldpContainsMembers(await r.text(), containerUrl)) {
      if (member.endsWith('.ttl') && !member.endsWith('-graph.trig')) urls.add(member);
    }
  }
  return [...urls];
}

/**
 * Compose the full manifest body for a pod from its on-pod descriptors.
 * Scans the container, fetches each descriptor, and rebuilds an entry
 * per descriptor. Returns { body, scanned, written }.
 */
async function buildManifestBodyFromPod(
  pod: string,
  fetchFn: FetchFn,
): Promise<{ body: string; scanned: number; written: number }> {
  const descriptorUrls = await listDescriptorUrls(pod, fetchFn);
  const entries: string[] = [];
  await Promise.allSettled(descriptorUrls.map(async durl => {
    try {
      const r = await fetchFn(durl, { method: 'GET', headers: { Accept: TURTLE_CONTENT_TYPE } });
      if (!r.ok) return;
      const entry = manifestEntryFromDescriptorTurtle(durl, await r.text());
      if (entry) entries.push(entry);
    } catch { /* skip unreadable descriptor */ }
  }));
  const prefixes = turtlePrefixes(['iep', 'xsd', 'hydra', 'dcat', 'dprod', 'dct']);
  const body = `${prefixes}\n\n${manifestHeaderTurtle(pod)}\n\n${entries.join('\n\n')}\n`;
  return { body, scanned: descriptorUrls.length, written: entries.length };
}

/**
 * Reconstruct + write a pod's manifest from its on-pod descriptors.
 * One-shot heal for a collapsed/lost index. Overwrites the manifest
 * (no CAS — this is an operator restore). Returns counts.
 */
export async function rebuildManifestFromPod(
  podUrl: string,
  opts: { fetch?: FetchFn; log?: (m: string) => void } = {},
): Promise<{ scanned: number; written: number; manifestUrl: string }> {
  const fetchFn = opts.fetch ?? _fetchFallback;
  const log = opts.log ?? (() => {});
  const pod = podUrl.endsWith('/') ? podUrl : `${podUrl}/`;
  const { body, scanned, written } = await buildManifestBodyFromPod(pod, fetchFn);
  const manifestUrl = `${pod}${MANIFEST_PATH}`;
  const put = await fetchFn(manifestUrl, { method: 'PUT', headers: { 'Content-Type': TURTLE_CONTENT_TYPE }, body });
  if (!put.ok) throw new Error(`manifest PUT <${manifestUrl}> -> ${put.status} ${put.statusText}`);
  log(`[rebuildManifestFromPod] ${manifestUrl}: scanned ${scanned}, wrote ${written}`);
  return { scanned, written, manifestUrl };
}

// ── Filter logic ────────────────────────────────────────────

function matchesFilter(entry: ManifestEntry, filter: DiscoverFilter): boolean {
  if (filter.facetType && !entry.facetTypes.includes(filter.facetType)) {
    return false;
  }

  if (filter.validFrom && entry.validUntil) {
    if (entry.validUntil < filter.validFrom) return false;
  }

  if (filter.validUntil && entry.validFrom) {
    if (entry.validFrom > filter.validUntil) return false;
  }

  if (filter.trustLevel) {
    if (!entry.facetTypes.includes('Trust') || entry.trustLevel !== filter.trustLevel) {
      return false;
    }
  }

  if (filter.modalStatus) {
    if (!entry.facetTypes.includes('Semiotic') || entry.modalStatus !== filter.modalStatus) {
      return false;
    }
  }

  // effectiveAt — "currently valid at time T": interval-contains check.
  // validFrom <= T AND (validUntil >= T OR validUntil absent).
  // Descriptors without a validFrom are treated as always-started;
  // descriptors without a validUntil are treated as open-ended.
  if (filter.effectiveAt) {
    const t = filter.effectiveAt;
    if (entry.validFrom && entry.validFrom > t) return false;
    if (entry.validUntil && entry.validUntil < t) return false;
  }

  // graphIri — narrow to descriptors that mention this graph IRI in
  // their iep:describes set. The single most useful narrowing filter
  // for agent workflows; without it, a learner asking "where is
  // urn:graph:X on this pod" has to fetch the whole manifest and
  // post-filter, which truncates on harness UIs for any pod with
  // more than ~20 entries.
  if (filter.graphIri) {
    if (!entry.describes.includes(filter.graphIri as IRI)) return false;
  }

  return true;
}

// ═════════════════════════════════════════════════════════════
//  publish()
// ═════════════════════════════════════════════════════════════

/**
 * Publish a Context Descriptor and its associated Named Graph
 * content to a Solid pod.
 *
 * 1. Serializes the descriptor to Turtle using the existing serializer.
 * 2. Wraps descriptor + graph content into a TriG document.
 * 3. PUTs the TriG to an LDP container on the pod.
 * 4. PATCHes the .well-known/context-graphs manifest.
 *
 * @param descriptor - The Context Descriptor to publish.
 * @param graphContent - Pre-serialized RDF content of the named graph
 *                       (Turtle triples — will be wrapped in a GRAPH block).
 * @param podUrl - Root URL of the Solid pod (e.g. "https://alice.solidcommunity.net/").
 * @param options - Optional configuration.
 * @returns URLs of the published resources.
 */
/**
 * Maximum permitted size of a descriptor's named-graph payload in bytes.
 * Producers that genuinely need to publish larger artifacts should split
 * the payload across multiple atoms in the PGSL lattice and reference
 * them via pgsl:contains / dct:hasPart from the descriptor — the descriptor
 * itself stays small, the bulk content is content-addressed and
 * deduplicated at the atom layer. Default 4 MiB is generous for
 * descriptor metadata + reasonable inline payloads but caps memory
 * bombs and aborts pathological inputs (multi-GB serialization) before
 * they hit the network. Override via PublishOptions.maxGraphBytes.
 */
const DEFAULT_MAX_GRAPH_BYTES = 4 * 1024 * 1024;

/**
 * Read a descriptor's Turtle representation directly from the pod for
 * the purposes of the CAS supersession precondition. Returns null on
 * 404 (head was deleted) so the caller can mark the head as "missing"
 * in the observed list without throwing. Any other non-200 surfaces
 * as an Error.
 *
 * FIX (combined sign_authorship + if_match path) — two changes:
 *
 *   1. We DO NOT send `Cache-Control: no-cache`. The original
 *      no-cache header forced CSS to skip its own response cache and
 *      re-read Azure Files on every CAS check, which is exactly the
 *      read path that flakes on a just-written descriptor URL. The
 *      CAS gate does NOT need byte-identical freshness — it needs
 *      current-or-newer — and CSS's normal cache already invalidates
 *      on PUT. Dropping the bypass header removes the failure mode
 *      where the post-write supersession check exhausts its retry
 *      budget on a transient Azure-Files re-read storm.
 *
 *   2. The retry budget is raised to 6 attempts / 500 ms base
 *      (~0.5s/1s/2s/4s/8s/16s, ~32 s ceiling) to match the symmetric
 *      window used by the graph + descriptor PUTs below. The
 *      combined signed-authorship + if_match path always traverses
 *      this code path (iep:supersedes is populated by the relay's
 *      auto-supersede block) and was the only configuration that
 *      consistently surfaced as `fetch failed (4×)` — the default
 *      maxAttempts=4 budget was symmetric on neither side, so a
 *      transient Azure-Files / CSS 5xx on the just-written rev1
 *      descriptor URL could exhaust read attempts mid-window.
 *
 *   3. On 4xx-other-than-404 we surface the descriptor URL + status
 *      in the error message so the failure shows up as
 *      `CAS prior-head fetch <url> failed: <code>` instead of bubbling
 *      up as an opaque `fetch failed` from the undici layer.
 */
async function fetchDescriptorTurtleForCas(
  descriptorUrl: string,
  fetchFn: FetchFn,
): Promise<string | null> {
  // The substrate `withTransientRetry` only retries on THROWN errors —
  // a returned 5xx response is "successful network call, server said
  // no" and falls through without retry. Azure Files cold-cache spikes
  // surface as 503 responses, not connection-reset throws, so we must
  // promote 5xx responses to throws INSIDE the lambda for the retry to
  // see them as transient. The thrown message embeds the status digits
  // so withTransientRetry's TRANSIENT_PATTERN (/5\d\d/) matches.
  let attempts = 0;
  const resp = await withTransientRetry(async () => {
    attempts++;
    const r = await fetchFn(descriptorUrl, {
      method: 'GET',
      headers: {
        'Accept': TURTLE_CONTENT_TYPE,
      },
    });
    if (r.status >= 500) {
      throw new Error(
        `publish: CAS prior-head fetch <${descriptorUrl}> failed: ${r.status} ${r.statusText} (attempt ${attempts})`,
      );
    }
    return r;
  }, { maxAttempts: 6, baseMs: 500 });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(
      `publish: CAS prior-head fetch <${descriptorUrl}> failed: ${resp.status} ${resp.statusText}`,
    );
  }
  return await resp.text();
}

/**
 * Result of a successful CAS precondition check (returned, not thrown).
 *
 * Carries the resolved head identifiers so callers (e.g. the relay's
 * `handlePublishContext`) can echo `previousHeadUrl` / `previousHeadCid`
 * synchronously even when the rest of the publish chain is deferred to
 * a background task. `preconditionWitness` records which side of the
 * `(ifMatchSupersedes, ifMatchCid)` pair matched, so the descriptor
 * Turtle written later (in Phase B) can append the same audit comment
 * the original synchronous path emitted.
 */
export interface SupersessionPreconditionPass {
  readonly ok: true;
  readonly resolvedHeadUrl: string;
  readonly resolvedHeadCid: string | null;
  readonly preconditionWitness: { matched: string; via: 'supersedes' | 'cid' };
  readonly currentHead: {
    readonly descriptorUrl: string;
    readonly cid: string | null;
    readonly supersedesList: readonly string[];
  };
}

/**
 * Standalone CAS supersession precondition check.
 *
 * Lifted out of {@link publish} so the relay can run the precondition
 * GET synchronously on the request thread (Phase A) and then defer the
 * actual graph + descriptor + manifest writes (Phase B) to a background
 * task — same 412 contract on the wire, but the typical happy-path
 * latency drops from ~7-10 s of CSS round-trips to ~1 s.
 *
 * Inputs are the same fields `publish()` derives internally:
 *   - `supersedesList` — `descriptor.supersedes` for the publish about
 *     to happen. MUST be non-empty when either match option is set,
 *     otherwise we throw immediately (the original publish() did too).
 *   - `ifMatchSupersedes` / `ifMatchCid` — caller-supplied head
 *     assertions. URL form gates on `descriptor.supersedes` equality;
 *     CID form gates on `computeCid(headTurtle)` equality. If both are
 *     set they must resolve to the same head.
 *   - `fetchFn` — pod-side fetch, threaded down from the relay so the
 *     bearer token / DPoP signing carry through unchanged.
 *
 * Throws {@link PublishPreconditionFailedError} on mismatch — same
 * shape as the in-publish path so the relay's existing 412 envelope
 * (`error:'precondition_failed', code:412, currentHead, retryHint`)
 * keeps working unchanged. On success returns `SupersessionPreconditionPass`
 * with the resolved head identifiers + the witness object.
 *
 * Non-412 failures (transient GET exhaustion, malformed turtle) bubble
 * up as regular `Error`s — the caller should map those to 503 +
 * retryable=true, NOT 412 (a 412 says "your assertion was wrong",
 * not "we couldn't tell").
 */
export async function checkSupersessionPrecondition(input: {
  readonly supersedesList: readonly string[];
  readonly ifMatchSupersedes?: string;
  readonly ifMatchCid?: string;
  readonly fetchFn: FetchFn;
  /**
   * Optional fast-path CID resolver. When provided, the precondition
   * check consults this lookup BEFORE falling back to a full descriptor
   * body GET + rehash. The relay populates this from the cached
   * manifest's `iep:contentCid` mirror — which is the same source the
   * `get_current_head` tool resolves from. Returning a string skips the
   * body fetch entirely for that supersedes target; returning null
   * (legacy manifest entry without the CID mirror, or unknown target)
   * falls through to the existing body-GET path.
   *
   * Why this exists: the Azure-Files transient that surfaced as 503
   * `precondition_unavailable` retryable=true was almost always the
   * `fetchDescriptorTurtleForCas` step — a full-body Turtle GET on a
   * cold cache. The manifest fetch the relay already does to build the
   * supersedes list also carries the head CID, so a manifest-mirrored
   * comparison removes the flaky read from the CAS path entirely.
   */
  readonly headCidLookup?: (descriptorUrl: string) => string | null | undefined;
}): Promise<SupersessionPreconditionPass> {
  const { supersedesList, ifMatchSupersedes, ifMatchCid, fetchFn, headCidLookup } = input;
  if (ifMatchSupersedes === undefined && ifMatchCid === undefined) {
    throw new Error(
      'checkSupersessionPrecondition: at least one of ifMatchSupersedes / ifMatchCid must be set — callers should skip this function when no precondition was requested.',
    );
  }
  if (supersedesList.length === 0) {
    throw new PublishPreconditionFailedError(
      'publish: ifMatchSupersedes/ifMatchCid was provided but descriptor.supersedes is empty — nothing to compare against. Add the prior head IRI to descriptor.supersedes (or drop the precondition).',
      {
        ...(ifMatchSupersedes !== undefined ? { supersedes: ifMatchSupersedes } : {}),
        ...(ifMatchCid !== undefined ? { cid: ifMatchCid } : {}),
      },
      { descriptorUrl: null, cid: null, supersedesList: [] },
    );
  }
  // Walk each supersedes target; collect descriptor URL + CID pairs so
  // the error response (on mismatch) carries the full observed head set.
  //
  // Optimization: if the caller supplied `headCidLookup` and it returns
  // a CID for this target, skip the descriptor body fetch entirely — the
  // manifest is the authoritative head pointer, and now (with the
  // `iep:contentCid` mirror) the head identity too. Body fetch is the
  // fallback when the lookup misses (legacy manifest entries written
  // before the mirror landed).
  //
  // The ifMatchSupersedes URL-form comparison doesn't need a CID at all
  // (it's a string match on supersedesList), so when only that option is
  // set we can record cid: '' without any pod read whatsoever — saves
  // one round-trip per supersedes target on every plain auto_supersede
  // publish, regardless of the manifest mirror state.
  const observed: { descriptorUrl: string; cid: string }[] = [];
  // Per-target fetch errors are recorded but do NOT abort the loop —
  // a single unresolvable target shouldn't kill the precondition when
  // ANOTHER target might match if_match. Surfaced only if no target
  // ends up matching, so the operator can see what went wrong.
  const targetErrors: { target: string; error: string }[] = [];
  for (const target of supersedesList) {
    const lookupCid = headCidLookup?.(target);
    if (typeof lookupCid === 'string' && lookupCid.length > 0) {
      observed.push({ descriptorUrl: target, cid: lookupCid });
      continue;
    }
    // Only http(s) targets are reachable via fetch. Non-http schemes
    // (urn:, did:, ipfs:, etc.) cannot be content-addressed by GET +
    // computeCid here — they're semantic supersession references the
    // user put in their content's `iep:supersedes` triples, lifted into
    // descriptor.supersedes by normalizePublishInputs. Treat them as
    // unresolvable for CAS purposes; record cid:'' so the loop
    // continues and another (http) target can still match if_match.
    // Without this guard, Node fetch rejects the urn: URL with
    // `fetch failed`, the 6-attempt retry burns ~15s on the same
    // unresolvable input, and the whole precondition surfaces as
    // `precondition_unavailable` even when an http target in the
    // SAME list would have resolved cleanly. (Rev 190 fix.)
    if (!/^https?:\/\//i.test(target)) {
      observed.push({ descriptorUrl: target, cid: '' });
      continue;
    }
    // Body-fetch the head: gates the ifMatchCid comparison AND
    // populates resolvedHeadCid as a side effect that callers
    // (e.g. the relay) echo back in their 202 response so the next
    // publish can pass it as the next CAS token. Per-target failures
    // are recorded and the loop continues — another http target may
    // still match.
    try {
      const headTurtle = await fetchDescriptorTurtleForCas(target, fetchFn);
      if (headTurtle === null) {
        observed.push({ descriptorUrl: target, cid: '' });
        continue;
      }
      const cid = computeCid(headTurtle);
      observed.push({ descriptorUrl: target, cid });
    } catch (err) {
      observed.push({ descriptorUrl: target, cid: '' });
      targetErrors.push({ target, error: (err as Error).message });
    }
  }

  let witness: { matched: string; via: 'supersedes' | 'cid' } | null = null;
  let resolvedHeadUrl: string | null = null;
  let resolvedHeadCid: string | null = null;

  if (ifMatchSupersedes !== undefined) {
    const hit = observed.find((o) => o.descriptorUrl === ifMatchSupersedes);
    if (!hit) {
      throw new PublishPreconditionFailedError(
        `publish: ifMatchSupersedes precondition failed — ${ifMatchSupersedes} is not among the declared supersedes targets [${supersedesList.join(', ')}].`,
        { supersedes: ifMatchSupersedes, ...(ifMatchCid !== undefined ? { cid: ifMatchCid } : {}) },
        { descriptorUrl: observed[0]?.descriptorUrl ?? null, cid: observed[0]?.cid ?? null, supersedesList: observed.map((o) => o.descriptorUrl) },
      );
    }
    witness = { matched: hit.descriptorUrl, via: 'supersedes' };
    resolvedHeadUrl = hit.descriptorUrl;
    resolvedHeadCid = hit.cid || null;
  }

  if (ifMatchCid !== undefined) {
    const hit = observed.find((o) => o.cid === ifMatchCid);
    if (!hit) {
      // If NO target resolved to a non-empty CID AND we recorded
      // per-target errors, this isn't "your assertion was wrong" —
      // it's "we couldn't tell". Surface as a transient Error so the
      // caller maps to 503 retryable, NOT 412 definitive. Without
      // this branch, a publish whose supersedes list is entirely
      // unresolvable (all urn:, all unreachable) would falsely
      // surface as 412 and the caller would re-read the manifest and
      // come back with the same urn: targets to no avail.
      const anyResolved = observed.some(o => o.cid.length > 0);
      if (!anyResolved && targetErrors.length > 0) {
        const tail = targetErrors.slice(0, 3).map(e => `<${e.target}>: ${e.error}`).join('; ');
        throw new Error(
          `publish: CAS precondition could not be resolved — every target in descriptor.supersedes was unreachable (first errors: ${tail}). This is a substrate / connectivity issue, not a definitive ifMatchCid mismatch — retry once the underlying read recovers.`,
        );
      }
      throw new PublishPreconditionFailedError(
        `publish: ifMatchCid precondition failed — CID ${ifMatchCid} does not match any current supersedes head (observed CIDs: [${observed.map((o) => o.cid).filter(Boolean).join(', ')}]).`,
        { ...(ifMatchSupersedes !== undefined ? { supersedes: ifMatchSupersedes } : {}), cid: ifMatchCid },
        { descriptorUrl: observed[0]?.descriptorUrl ?? null, cid: observed[0]?.cid ?? null, supersedesList: observed.map((o) => o.descriptorUrl) },
      );
    }
    if (witness && witness.matched !== hit.descriptorUrl) {
      throw new PublishPreconditionFailedError(
        `publish: ifMatchSupersedes and ifMatchCid identified different heads (${witness.matched} vs ${hit.descriptorUrl}).`,
        { supersedes: ifMatchSupersedes, cid: ifMatchCid },
        { descriptorUrl: hit.descriptorUrl, cid: hit.cid, supersedesList: observed.map((o) => o.descriptorUrl) },
      );
    }
    witness = { matched: hit.descriptorUrl, via: witness ? 'supersedes' : 'cid' };
    resolvedHeadUrl = hit.descriptorUrl;
    resolvedHeadCid = hit.cid;
  }

  // Unreachable on the contract above (either branch must have fired
  // because at least one of the match options was set) — guard anyway
  // so TS narrows resolvedHeadUrl/witness.
  if (!witness || resolvedHeadUrl === null) {
    throw new Error(
      'checkSupersessionPrecondition: internal invariant violated — match option set but no witness produced.',
    );
  }

  return {
    ok: true,
    resolvedHeadUrl,
    resolvedHeadCid,
    preconditionWitness: witness,
    currentHead: {
      descriptorUrl: resolvedHeadUrl,
      cid: resolvedHeadCid,
      supersedesList: observed.map((o) => o.descriptorUrl),
    },
  };
}

export async function publish(
  descriptor: ContextDescriptorData,
  graphContent: string,
  podUrl: string,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const container = ensureTrailingSlash(
    `${pod}${options.containerPath ?? DEFAULT_CONTAINER}`,
  );

  const slug = options.descriptorSlug ?? slugFromIri(descriptor.id);
  const graphSlug = options.graphSlug ?? `${slug}-graph`;

  // Size guard — reject before serialization so an oversized publish
  // can't drive the process OOM. Byte-length, not char-length, to
  // account for multibyte UTF-8 content.
  const maxBytes = options.maxGraphBytes ?? DEFAULT_MAX_GRAPH_BYTES;
  const graphBytes = Buffer.byteLength(graphContent, 'utf8');
  if (graphBytes > maxBytes) {
    throw new Error(
      `publish: graph payload is ${graphBytes} bytes; max permitted is ${maxBytes} bytes (override via PublishOptions.maxGraphBytes). For payloads larger than this, content-address into the PGSL lattice and reference atoms via pgsl:contains / dct:hasPart instead of inlining.`,
    );
  }

  // FIX 4 — optional conformance gate. When the caller passes a list of
  // shape graphs (typically derived from the target container's
  // .well-known/container-shape declaration), run each one against the
  // inbound graphContent BEFORE any pod write. On violation throw 422
  // semantics — the descriptor + payload never land on the pod.
  if (options.conformsToShapes && options.conformsToShapes.length > 0) {
    for (const { shapeIri, shapeTurtle } of options.conformsToShapes) {
      const report = validateAgainstShape(graphContent, shapeTurtle, { entailment: 'rdfs' });
      if (!report.conforms) {
        throw new PublishShapeViolationError(
          `publish: inbound graph violates shape ${shapeIri}`,
          shapeIri,
          report.results.map(r => ({
            focusNode: r.focusNode,
            path: r.path,
            value: r.value,
            constraint: r.constraintComponent,
            severity: r.severity,
            message: r.message,
          })),
        );
      }
    }
  }

  // ── CAS supersession precondition ────────────────────────────
  //
  // When the caller passes `ifMatchSupersedes` / `ifMatchCid` they are
  // asserting that the current chain head for THIS descriptor's
  // supersedes target is the specified descriptor (or has the specified
  // content-CID). The check is a substrate-level gate: zero CSS writes
  // happen if the precondition fails, so two concurrent writers can't
  // both succeed in forking the chain.
  //
  // Resolution rules:
  //   - If descriptor.supersedes is empty/absent and either precondition
  //     option is set, this is a contract bug — throw immediately so the
  //     caller notices.
  //   - For each supersedes target we GET the descriptor Turtle (fresh
  //     read, no cache) and compute its content-CID. The "current head"
  //     is the union of (a) the explicit supersedes targets and (b) any
  //     other descriptor turtles those targets resolve to via further
  //     iep:supersedes back-links — but we only walk one hop and gate on
  //     the explicit targets. Manifest-level head resolution belongs in
  //     the caller (see relay's auto_supersede_prior block) so the
  //     substrate primitive stays cheap.
  //   - If ifMatchSupersedes is set it must equal one of descriptor.supersedes.
  //   - If ifMatchCid is set it must equal the CID of one of those targets'
  //     descriptor Turtles.
  //   - On mismatch we throw PublishPreconditionFailedError carrying the
  //     observed current head — the caller re-reads and rebuilds before
  //     retrying.
  //
  // The precondition is observable downstream too: when either match
  // option is supplied AND succeeds, we emit the witness predicate
  // iep:supersedesPredicate (a custom audit predicate) into the descriptor
  // Turtle by appending it after the body — that lets verifiers
  // reconstruct which prior head the precondition was gated against.
  let resolvedHeadUrl: string | null = null;
  let resolvedHeadCid: string | null = null;
  let preconditionWitness: { matched: string; via: 'supersedes' | 'cid' } | null = null;
  const supersedesList: readonly string[] = descriptor.supersedes ?? [];
  if (options.ifMatchSupersedes !== undefined || options.ifMatchCid !== undefined) {
    // Delegate to the standalone helper so the in-publish gate and the
    // relay's Phase-A pre-flight share one implementation (and one bug
    // surface). The helper throws PublishPreconditionFailedError on
    // mismatch with the same envelope this block used to construct
    // inline — no observable change to existing callers.
    const pass = await checkSupersessionPrecondition({
      supersedesList,
      ...(options.ifMatchSupersedes !== undefined ? { ifMatchSupersedes: options.ifMatchSupersedes } : {}),
      ...(options.ifMatchCid !== undefined ? { ifMatchCid: options.ifMatchCid } : {}),
      fetchFn,
      ...(options.headCidLookup ? { headCidLookup: options.headCidLookup } : {}),
    });
    resolvedHeadUrl = pass.resolvedHeadUrl;
    resolvedHeadCid = pass.resolvedHeadCid;
    preconditionWitness = pass.preconditionWitness;
  } else if (supersedesList.length > 0) {
    // No precondition was requested, but the descriptor IS superseding
    // something. Compute the head CID anyway so callers can pass it back
    // as ifMatchCid on the next publish. Best-effort: a transient read
    // failure here just leaves previousHeadCid absent in the result.
    //
    // Manifest fast-path: if the caller supplied a headCidLookup AND it
    // has a CID for the head, skip the body fetch entirely. Falls
    // through to body-GET only when the manifest mirror is missing
    // (legacy entry) or the caller didn't supply the lookup.
    const fastHeadCid = options.headCidLookup?.(supersedesList[0]!);
    if (typeof fastHeadCid === 'string' && fastHeadCid.length > 0) {
      resolvedHeadUrl = supersedesList[0]!;
      resolvedHeadCid = fastHeadCid;
    } else {
      try {
        const headTurtle = await fetchDescriptorTurtleForCas(supersedesList[0]!, fetchFn);
        if (headTurtle !== null) {
          resolvedHeadUrl = supersedesList[0]!;
          resolvedHeadCid = computeCid(headTurtle);
        }
      } catch { /* best-effort */ }
    }
  }

  const baseDescriptorTurtle = toTurtle(descriptor);
  // When the precondition matched, append a Turtle comment witness so
  // downstream auditors can verify which prior head this publish was
  // gated against, without introducing a new iep: term (the ontology
  // lint blocks unregistered iep:* IRIs). The witness rides on top of
  // the existing iep:supersedes triple already in the descriptor — the
  // comment names the precondition source (URL vs CID) and which one
  // of the supersedes targets satisfied it.
  const descriptorTurtle = preconditionWitness
    ? `${baseDescriptorTurtle.trimEnd()}\n# ── CAS supersession witness (precondition matched at publish time, via ${preconditionWitness.via}) ──\n# iep:supersedes precondition gated against <${preconditionWitness.matched}>\n`
    : baseDescriptorTurtle;
  const primaryGraph = descriptor.describes[0]!;

  // 1. PUT the graph payload — plaintext TriG OR encrypted envelope.
  //    When options.encrypt is set, the named-graph content is wrapped in
  //    an nacl-box envelope with one wrapped key per recipient, so CSS /
  //    Azure Files / IPFS see only ciphertext. Descriptor metadata stays
  //    plaintext so federation queries (facet type, temporal filter,
  //    trust level) work without the viewer being an authorized recipient.
  let graphUrl: string;
  let graphBody: string;
  let graphContentType: string;
  let encryptedFlag = false;
  if (options.encrypt) {
    const envelope = createEncryptedEnvelope(
      wrapAsTriG(descriptorTurtle, graphContent, primaryGraph),
      options.encrypt.recipients,
      options.encrypt.senderKeyPair,
    );
    graphUrl = `${container}${graphSlug}.envelope.jose.json`;
    graphBody = JSON.stringify(envelope);
    graphContentType = ENVELOPE_CONTENT_TYPE;
    encryptedFlag = true;
  } else {
    graphUrl = `${container}${graphSlug}.trig`;
    graphBody = wrapAsTriG(descriptorTurtle, graphContent, primaryGraph);
    graphContentType = TRIG_CONTENT_TYPE;
  }

  // The graph PUT carries the bulk of the payload bytes — typically the
  // largest single request in the publish path. Under upstream envoy
  // churn (Azure Container Apps' fronting proxy) a mid-write socket
  // reset surfaces here as a generic "fetch failed". The default
  // schedule (4 attempts, 1s/2s/4s/8s) can exhaust within a single
  // envoy reload window; bump to 6 attempts with a 500ms base
  // (~0.5s/1s/2s/4s/8s/16s, ~32s ceiling) so we ride out longer blips
  // without changing the overall budget more than necessary. Descriptor
  // PUT below uses the same tuning for symmetry.
  await withTransientRetry(async () => {
    const graphResponse = await fetchFn(graphUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': graphContentType,
        'If-None-Match': '*',
      },
      body: graphBody,
    });
    if (!graphResponse.ok && graphResponse.status !== 412) {
      throw new Error(
        `Failed to write graph to ${graphUrl}: ${graphResponse.status} ${graphResponse.statusText}`,
      );
    }
  }, { maxAttempts: 6, baseMs: 500 });

  // 2. PUT the descriptor as standalone Turtle — augmented with a
  //    hypermedia Distribution block linking to the graph payload.
  //    This is HATEOAS: the descriptor self-describes where its graph
  //    content lives, what media type it serves, whether it's encrypted,
  //    and what HTTP operations a client can invoke to retrieve and
  //    decrypt it. Clients follow the link instead of constructing URLs
  //    by naming convention.
  const descriptorUrl = `${container}${slug}.ttl`;
  const distributionBlock = buildDistributionBlock({
    graphUrl,
    graphContentType,
    encrypted: encryptedFlag,
    encryptionAlgorithm: encryptedFlag ? 'X25519-XSalsa20-Poly1305' : undefined,
    recipientCount: options.encrypt?.recipients.length,
    visibility: options.visibility,
    descriptorId: descriptor.id,
    relayBaseUrl: options.relayBaseUrl,
  });
  // Optional authorship-proof block. When the caller minted a signed
  // authorship proof for THIS publish (typically via `sign_authorship:
  // true` in the relay shim → `createSignedAuthorship` with the
  // calling agent's delegation key), embed it as
  //   <> iep:authorshipProof [ a iep:SignedAuthorship ; ... ] .
  // adjacent to the AgentFacet block. Independent of the trust-facet
  // iep:proof block (which signs the whole descriptor turtle and is
  // operator-grade): authorship binds the AgentFacet to THIS agent's
  // delegation key so any reader can verify "the named agent actually
  // signed this AgentFacet" without trusting pod storage.
  //
  // Also asserts `dct:conformsTo <iep:SignedAuthorship>` so readers
  // can detect a signed-authorship descriptor by feature, not by
  // probe-parse.
  const authorshipBlock = options.authorshipProof
    ? buildAuthorshipProofBlock(options.authorshipProof)
    : '';
  const descriptorWithDistribution =
    descriptorTurtle.trimEnd()
    + '\n\n' + distributionBlock
    + (authorshipBlock ? ('\n\n' + authorshipBlock) : '')
    + '\n';
  // Content-CID of the exact Turtle body about to land on the pod.
  // Mirrored into the manifest entry below so CAS supersession gates
  // (`checkSupersessionPrecondition`) can compare `if_match` against
  // the head identity without re-fetching + rehashing the body.
  const descriptorContentCid = computeCid(descriptorWithDistribution);
  await withTransientRetry(async () => {
    const descResponse = await fetchFn(descriptorUrl, {
      method: 'PUT',
      headers: { 'Content-Type': TURTLE_CONTENT_TYPE },
      body: descriptorWithDistribution,
    });
    if (!descResponse.ok) {
      throw new Error(
        `Failed to write descriptor to ${descriptorUrl}: ${descResponse.status} ${descResponse.statusText}`,
      );
    }
  }, { maxAttempts: 6, baseMs: 500 });

  // 3. Update the manifest — CAS-safe via HTTP If-Match.
  //
  //    publish() can be called concurrently by multiple agents (or
  //    multiple processes on the same agent's machine). The naive
  //    GET-then-PUT pattern races: two clients read the same manifest,
  //    each appends their own entry, the last PUT clobbers the other's
  //    entry. We use HTTP optimistic concurrency:
  //
  //      1. GET manifest, capture ETag from response
  //      2. PUT with `If-Match: <ETag>` (server rejects with 412 if
  //         the manifest changed since our GET)
  //      3. On 412, retry from step 1 with fresh ETag + fresh entries
  //         (a few times with backoff; throw if persistent contention).
  //
  //    For the cold-start (no manifest yet), use `If-None-Match: *` so
  //    the PUT succeeds only if no manifest exists — protects against
  //    two cold-start clients clobbering each other.
  const manifestUrl = `${pod}${MANIFEST_PATH}`;
  const newEntry = manifestEntryTurtle(descriptorUrl, descriptor, descriptorContentCid);
  // Under N-way concurrent contention (e.g. 5 voters firing Promise.all),
  // 5 internal retries are not enough — the exponential window doesn't
  // grow fast enough to scatter every writer to a clean If-Match slot.
  // 8 attempts gives 50/100/200/400/800/1500/1500/1500ms (each + 0-200ms
  // jitter) ≈ up to ~7s of scatter, which keeps every writer in the
  // queue under realistic governance / cartographer-fanout contention.
  const maxAttempts = 8;
  let lastError: string | null = null;
  // Per-pod in-process serialization (see manifestWriteQueues above):
  // collapses concurrent same-process writers into a serial queue so
  // the HTTP CAS dance only has to defend against cross-process races,
  // not against same-process writers fighting each other.
  await withManifestLock(manifestUrl, async () => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let manifestBody: string;
    let etag: string | null = null;

    // 5xx-as-throw promotion (see discover() / fetchDescriptorTurtleForCas
    // for the same pattern): Azure-Files cold-cache 503s arrive as
    // returned responses, so `withTransientRetry` only sees them retry-
    // eligible when we throw inside the lambda.
    const existingResp = await withTransientRetry(async () => {
      const r = await fetchFn(manifestUrl, {
        method: 'GET',
        headers: { 'Accept': TURTLE_CONTENT_TYPE },
      });
      if (r.status >= 500) {
        throw new Error(`manifest GET <${manifestUrl}> failed: ${r.status} ${r.statusText}`);
      }
      return r;
    });

    let alreadyPublished = false;
    if (existingResp.ok) {
      etag = existingResp.headers?.get('etag') ?? null;
      const existing = await existingResp.text();
      if (existing.includes(`<${descriptorUrl}>`)) {
        // Already in manifest (idempotent re-publish); skip the PUT.
        alreadyPublished = true;
        manifestBody = existing;
      } else {
        manifestBody = `${existing.trimEnd()}\n\n${newEntry}\n`;
      }
    } else if (existingResp.status === 404) {
      // Manifest absent. This is EITHER a true cold-start (no descriptors
      // yet) OR a lost/collapsed index whose descriptors are still intact
      // (the f-manifest-collapse failure mode). Reconstruct from the
      // on-pod descriptors so a missing index is never replaced by a
      // 1-entry stub that truncates the pod. The just-written descriptor
      // is normally picked up by the scan; append it defensively if the
      // container listing hasn't caught up yet.
      let rebuiltBody: string | null = null;
      try {
        const rebuilt = await buildManifestBodyFromPod(pod, fetchFn);
        if (rebuilt.written > 0) {
          rebuiltBody = rebuilt.body.includes(`<${descriptorUrl}>`)
            ? rebuilt.body
            : `${rebuilt.body.trimEnd()}\n\n${newEntry}\n`;
        }
      } catch {
        rebuiltBody = null;
      }
      manifestBody = rebuiltBody
        ?? `${turtlePrefixes(['iep', 'xsd', 'hydra', 'dcat', 'dprod', 'dct'])}\n\n${manifestHeaderTurtle(pod)}\n\n${newEntry}\n`;
    } else {
      // Non-404 non-ok (e.g. 403/401, or a non-5xx transient): the
      // manifest may well EXIST but be momentarily unreadable. Rebuilding
      // from scratch here is what truncated live indexes
      // (f-manifest-collapse). Refuse to truncate — back off and retry;
      // a later attempt re-reads the real manifest.
      lastError = `manifest GET ${existingResp.status} ${existingResp.statusText} (attempt ${attempt}/${maxAttempts}); refusing to rebuild-from-scratch on a non-404`;
      const backoff = Math.min(50 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200), 1500);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    if (alreadyPublished) break;

    const headers: Record<string, string> = { 'Content-Type': TURTLE_CONTENT_TYPE };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*';   // cold-start: only PUT if no manifest exists

    // 5xx-as-throw promotion: same rationale as the GET above. 412
    // (CAS conflict) stays as a normal response — the loop below
    // checks `manifestResp.ok` and falls through to retry with a
    // freshly-read etag on 412, which is the deliberate behavior.
    const manifestResp = await withTransientRetry(async () => {
      const r = await fetchFn(manifestUrl, {
        method: 'PUT', headers, body: manifestBody,
      });
      if (r.status >= 500) {
        throw new Error(`manifest PUT <${manifestUrl}> failed: ${r.status} ${r.statusText}`);
      }
      return r;
    });

    if (manifestResp.ok) {
      // Belt-and-suspenders: under N-way contention (e.g. 4+ concurrent
      // writers), some storage backends accept simultaneous PUTs with
      // matching If-Match etags due to a TOCTOU gap between the etag
      // check and the body write. A 200 OK then is misleading — the
      // server may have already overwritten our payload with a later
      // writer's body. Verify by reading the manifest back; if our entry
      // is missing, treat as a conflict and retry. This terminates
      // because each retry GETs the freshest etag and rebuilds the body.
      const verifyResp = await withTransientRetry(async () => {
        const r = await fetchFn(manifestUrl, {
          method: 'GET',
          headers: { 'Accept': TURTLE_CONTENT_TYPE },
        });
        if (r.status >= 500) {
          throw new Error(`manifest verify-GET <${manifestUrl}> failed: ${r.status} ${r.statusText}`);
        }
        return r;
      });
      if (verifyResp.ok) {
        const verifyBody = await verifyResp.text();
        if (!verifyBody.includes(`<${descriptorUrl}>`)) {
          lastError = `post-PUT verification: entry missing after 200 OK (attempt ${attempt}/${maxAttempts}; concurrent writer clobbered us)`;
          const exponentialBase = 50 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 200);
          const backoff = Math.min(exponentialBase + jitter, 1500);
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
      }
      lastError = null;
      break;
    }
    if (manifestResp.status === 412) {
      // Precondition Failed: another writer beat us. Retry with fresh GET.
      lastError = `412 (concurrent manifest update detected, attempt ${attempt}/${maxAttempts})`;
      // Exponential backoff with wider jitter, capped at 1.5s per attempt.
      // Linear backoff retry-storms under heavy contention because the
      // re-attempt window doesn't grow fast enough to spread writers.
      // Exponential (50/100/200/400/800/1500/1500/1500ms) plus 0-200ms
      // jitter scatters 5+ concurrent retries effectively (wider jitter
      // than the original 50ms because the writer pool is larger).
      const exponentialBase = 50 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 200);
      const backoff = Math.min(exponentialBase + jitter, 1500);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    // 5xx — server is unhappy (CSS has been observed returning 500 from the
    // manifest endpoint once the manifest grows past ~14 entries; the failure
    // mode is server-internal and transient from our side). Treat like 412:
    // back off, GET the freshest etag, rebuild the body, and re-PUT. This is
    // the same recovery shape the in-loop CAS retry already implements, just
    // gated on the server-side overload signal instead of the concurrent-write
    // signal.
    if (manifestResp.status >= 500 && manifestResp.status < 600) {
      lastError = `${manifestResp.status} (server-side manifest update failure, attempt ${attempt}/${maxAttempts})`;
      const exponentialBase = 50 * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * 200);
      const backoff = Math.min(exponentialBase + jitter, 1500);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }
    throw new Error(
      `Failed to update manifest at ${manifestUrl}: ${manifestResp.status} ${manifestResp.statusText}`,
    );
  }
  if (lastError) {
    throw new Error(
      `Failed to update manifest at ${manifestUrl} after ${maxAttempts} attempts: ${lastError}`,
    );
  }
  }); // end withManifestLock

  // 4. Optional: ingest into PGSL lattice for structural indexing
  let pgslUri: string | undefined;
  let pgslLevel: number | undefined;
  if (options.pgsl) {
    try {
      // Late-import `@interego/pgsl` so the substrate has no compile-time
      // dependency on it; the publish stays usable without PGSL installed.
      // Cast to `unknown` first to bypass the TS "cannot find module" check
      // (the substrate's package.json deliberately does not declare a
      // dependency on `@interego/pgsl` — that would be a circular dep —
      // so the resolver only finds it at runtime when PGSL is installed
      // alongside core).
      const dyn = Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
      const mod = await dyn('@interego/pgsl') as {
        embedInPGSL: (pgsl: unknown, content: string, descriptor: unknown, granularity?: string) => string;
      };
      const pgslInstance = options.pgsl as { nodes: Map<string, { level?: number }> };
      const topUri = mod.embedInPGSL(pgslInstance, graphContent, descriptor, options.pgslGranularity);
      const node = pgslInstance.nodes.get(topUri);
      pgslUri = topUri;
      pgslLevel = node?.level;
    } catch {
      // PGSL ingestion is optional — don't fail the publish.
      // (Also handles the case where `@interego/pgsl` isn't installed.)
    }
  }

  const result: PublishResult = { descriptorUrl, graphUrl, manifestUrl };
  if (encryptedFlag) (result as { encrypted?: boolean }).encrypted = true;
  if (pgslUri !== undefined) (result as { pgslUri?: string }).pgslUri = pgslUri;
  if (pgslLevel !== undefined) (result as { pgslLevel?: number }).pgslLevel = pgslLevel;
  // CAS chain head — included whenever we resolved one, regardless of
  // whether a precondition was supplied. Callers can use these to chain
  // a sequence of supersessions atomically (publish → previousHeadCid →
  // ifMatchCid on next publish → ...).
  if (resolvedHeadCid !== null) (result as { previousHeadCid?: string }).previousHeadCid = resolvedHeadCid;
  if (resolvedHeadUrl !== null) (result as { previousHeadUrl?: string }).previousHeadUrl = resolvedHeadUrl;
  return result;
}

// ═════════════════════════════════════════════════════════════
//  Hypermedia: Distribution link serialization + parsing
// ═════════════════════════════════════════════════════════════

/**
 * Build the Turtle block that links a descriptor to its graph payload
 * using the project's existing affordance + hypermedia ontology.
 *
 * Emission shape aligns with:
 *   - iep:Affordance individuals (iep:canFetchPayload, iep:canDecrypt)
 *   - iep:affordance object property (from cg.ttl)
 *   - ieh:Affordance class (harness ontology; rdfs:subClassOf hydra:Operation
 *     — single block is both a Hydra Operation AND a harness affordance)
 *   - dcat:Distribution (W3C data-catalog vocab; the facet is also a DCAT
 *     distribution so DCAT-aware catalogs can ingest it natively)
 *   - alignment.ttl cross-layer axioms (iep:FederationFacet rdfs:seeAlso
 *     dcat:Distribution; ieh:Affordance rdfs:subClassOf hydra:Operation)
 *
 * The block declares a single affordance that is simultaneously:
 *   - a iep:Affordance  (discovery-time capability)
 *   - a ieh:Affordance (execution-time operation, via subclass relation)
 *   - a hydra:Operation (HATEOAS client dispatch target)
 *   - a dcat:Distribution (data-catalog compatible)
 *
 * Single RDF node carrying the full set of hats — any client that speaks
 * any of these vocabularies can dispatch against it.
 */
function buildDistributionBlock(d: {
  graphUrl: string;
  graphContentType: string;
  encrypted: boolean;
  encryptionAlgorithm?: string;
  recipientCount?: number;
  visibility?: 'public' | 'shared' | 'private';
  descriptorId?: string;
  relayBaseUrl?: string;
}): string {
  const actionIRI = d.encrypted ? 'iep:canDecrypt' : 'iep:canFetchPayload';
  const returnsClass = d.encrypted ? 'iep:EncryptedGraphEnvelope' : 'iep:GraphPayload';
  const lines: string[] = [
    '# ── Affordance (iep:Affordance, ieh:Affordance, dcat:Distribution, hydra:Operation) ──',
    `<> iep:affordance [`,
    `    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;`,
    `    iep:action ${actionIRI} ;`,
    `    hydra:method "GET" ;`,
    `    hydra:target <${d.graphUrl}> ;`,
    `    hydra:returns ${returnsClass} ;`,
    `    hydra:title "${d.encrypted ? 'Fetch encrypted graph envelope' : 'Fetch graph payload'}" ;`,
    `    dcat:accessURL <${d.graphUrl}> ;`,
    `    dcat:mediaType "${d.graphContentType}" ;`,
    `    iep:encrypted ${d.encrypted ? 'true' : 'false'}`,
  ];
  if (d.encrypted && d.encryptionAlgorithm) {
    lines.push(`    ; iep:encryptionAlgorithm "${d.encryptionAlgorithm}"`);
  }
  if (d.encrypted && typeof d.recipientCount === 'number') {
    lines.push(`    ; iep:recipientCount ${d.recipientCount}`);
  }
  // Visibility is the audience-class signal for consumers (and for ACL
  // writers that mirror it onto the pod). Default-omitted preserves the
  // historical wire format for `shared` graphs; only emit when caller
  // declared `public` or `private` so older parsers don't trip on an
  // unknown predicate.
  if (d.visibility === 'public' || d.visibility === 'private') {
    lines.push(`    ; iep:visibility "${d.visibility}"`);
  }
  lines.push(`] .`);

  // Second affordance: iep:renderView. Server-side plaintext projection
  // for thin clients (no X25519 keypair) that hold a bearer token. Only
  // emitted when the payload is encrypted AND the publisher supplied a
  // relay base URL — without one we'd have no projection endpoint to
  // point at. iep:canDecrypt above remains the point-of-fetch path for
  // clients holding a recipient key; iep:renderView is the asymmetric
  // counterpart for thin clients. See cg.ttl `iep:renderView`.
  if (d.encrypted && d.relayBaseUrl && d.descriptorId) {
    const relayBase = d.relayBaseUrl.replace(/\/$/, '');
    const renderTarget = `${relayBase}/render/${encodeURIComponent(d.descriptorId)}`;
    lines.push('');
    lines.push('# ── Affordance (iep:renderView — server-side projection for thin clients) ──');
    lines.push(`<> iep:affordance [`);
    lines.push(`    a iep:Affordance, ieh:Affordance, hydra:Operation ;`);
    lines.push(`    iep:action iep:renderView ;`);
    lines.push(`    hydra:method "GET" ;`);
    lines.push(`    hydra:target <${renderTarget}> ;`);
    lines.push(`    hydra:returns iep:GraphPayload ;`);
    lines.push(`    hydra:title "Render plaintext projection of encrypted graph (relay unwraps for authorized bearer)" ;`);
    lines.push(`    dcat:mediaType "text/turtle"`);
    lines.push(`] .`);
  }
  return lines.join('\n');
}

/**
 * Build the Turtle block embedding an authorship proof in the
 * descriptor. Shape:
 *
 *   <> dct:conformsTo <https://markjspivey-xwisee.github.io/interego/ns/iep#SignedAuthorship> .
 *   <> iep:authorshipProof [
 *     a iep:SignedAuthorship ;
 *     iep:scheme "EcdsaSecp256k1Signature2019" ;
 *     iep:issuer <agentId> ;
 *     iep:verificationMethod <did:ethr:0x...> ;
 *     iep:signerAddress "0x..." ;
 *     iep:created "2026-06-06T..." ;
 *     iep:ownerWebId <https://...> ;
 *     iep:descriptorId <descriptorIRI> ;
 *     iep:proofValue "0x..."
 *   ] .
 *
 * Verifiable from the descriptor ALONE: the embedded
 * `iep:verificationMethod` resolves to a public key (did:ethr:0x...
 * recovers directly; other DID methods would be resolved). The
 * canonical payload is reconstructed from (issuer, ownerWebId,
 * descriptorId, created, agentDid?) at verify time so any tampering
 * with those fields invalidates the signature.
 */
function buildAuthorshipProofBlock(p: import('@interego/core').AuthorshipProof): string {
  // Escape minimal Turtle-literal hazards in the proof value + signer
  // address (they are hex / base64 in practice but defensive).
  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines: string[] = [
    '# ── Authorship Proof (iep:SignedAuthorship) ──',
    `<> dct:conformsTo <https://markjspivey-xwisee.github.io/interego/ns/iep#SignedAuthorship> .`,
    `<> iep:authorshipProof [`,
    `    a iep:SignedAuthorship ;`,
    `    iep:scheme "${esc(p.scheme)}" ;`,
    `    iep:issuer <${p.issuer}> ;`,
    `    iep:verificationMethod <${p.verificationMethod}> ;`,
    `    iep:signerAddress "${esc(p.signerAddress)}" ;`,
    `    iep:created "${esc(p.created)}"^^xsd:dateTime ;`,
    `    iep:ownerWebId <${p.ownerWebId}> ;`,
    `    iep:descriptorId <${p.descriptorId}> ;`,
  ];
  if (p.agentDid) {
    lines.push(`    iep:agentDid "${esc(p.agentDid)}" ;`);
  }
  lines.push(`    iep:proofValue "${esc(p.proofValue)}"`);
  lines.push(`] .`);
  return lines.join('\n');
}

/**
 * Parse the `iep:authorshipProof [...]` block embedded in a descriptor
 * Turtle document. Returns null when no authorship proof is present.
 * Forgiving regex-based parser (mirrors the existing
 * `parseDistributionFromDescriptorTurtle` style) so it stays in step
 * with the relay's hand-built emitter without dragging a full Turtle
 * parser into the runtime.
 */
export function parseAuthorshipProofFromDescriptorTurtle(
  turtle: string,
): import('@interego/core').AuthorshipProof | null {
  const blockMatch = turtle.match(/iep:authorshipProof\s+\[([^\]]+)\]/);
  if (!blockMatch) return null;
  const body = blockMatch[1]!;
  const read = (re: RegExp): string | undefined => {
    const m = body.match(re);
    return m?.[1];
  };
  const issuer = read(/iep:issuer\s+<([^>]+)>/);
  const verificationMethod = read(/iep:verificationMethod\s+<([^>]+)>/);
  const signerAddress = read(/iep:signerAddress\s+"([^"]+)"/);
  const created = read(/iep:created\s+"([^"]+)"/);
  const ownerWebId = read(/iep:ownerWebId\s+<([^>]+)>/);
  const descriptorId = read(/iep:descriptorId\s+<([^>]+)>/);
  const proofValue = read(/iep:proofValue\s+"([^"]+)"/);
  const scheme = read(/iep:scheme\s+"([^"]+)"/) ?? 'EcdsaSecp256k1Signature2019';
  const agentDid = read(/iep:agentDid\s+"([^"]+)"/);
  if (!issuer || !verificationMethod || !signerAddress || !created
      || !ownerWebId || !descriptorId || !proofValue) {
    return null;
  }
  type IRIType = import('@interego/core').IRI;
  return {
    issuer: issuer as IRIType,
    verificationMethod: verificationMethod as IRIType,
    signerAddress,
    created,
    ownerWebId: ownerWebId as IRIType,
    descriptorId: descriptorId as IRIType,
    proofValue,
    scheme,
    ...(agentDid ? { agentDid } : {}),
  };
}

export interface DistributionLink {
  readonly accessURL: string;
  readonly mediaType: string;
  readonly encrypted: boolean;
  readonly encryptionAlgorithm?: string;
  /**
   * Audience class declared on the affordance via `iep:visibility`. Absent
   * when the descriptor predates the visibility extension (treat as
   * `'shared'` for backwards compatibility).
   */
  readonly visibility?: 'public' | 'shared' | 'private';
}

/**
 * Parse a descriptor's affordance block and return the graph payload's
 * accessURL + media type + encryption status. Matches the canonical
 * `iep:affordance [...]` form plus a legacy `iep:hasDistribution [...]`
 * form (preserved for descriptors written before the ontology
 * realignment). Returns null when no linkage is declared.
 */
export function parseDistributionFromDescriptorTurtle(turtle: string): DistributionLink | null {
  // Canonical form: iep:affordance [ ... a dcat:Distribution ... ]
  // Legacy form:    iep:hasDistribution [ ... a dcat:Distribution ... ]
  // Try canonical first; fall back to legacy.
  let match = turtle.match(/iep:affordance\s*\[([\s\S]*?)\]/);
  if (!match) match = turtle.match(/iep:hasDistribution\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  const block = match[1]!;
  // Prefer hydra:target over dcat:accessURL (they're synonymous in our
  // emission, but hydra:target is the operation-centric view for
  // dispatch; dcat:accessURL is the catalog-centric view. Either works).
  const accessUrlMatch = block.match(/hydra:target\s+<([^>]+)>/) || block.match(/dcat:accessURL\s+<([^>]+)>/);
  const mediaTypeMatch = block.match(/dcat:mediaType\s+"([^"]+)"/);
  const encryptedMatch = block.match(/iep:encrypted\s+(true|false)/);
  const algoMatch = block.match(/iep:encryptionAlgorithm\s+"([^"]+)"/);
  const visibilityMatch = block.match(/iep:visibility\s+"(public|shared|private)"/);
  if (!accessUrlMatch || !mediaTypeMatch) return null;
  const result: DistributionLink = {
    accessURL: accessUrlMatch[1]!,
    mediaType: mediaTypeMatch[1]!,
    encrypted: encryptedMatch?.[1] === 'true',
  };
  if (algoMatch) (result as { encryptionAlgorithm?: string }).encryptionAlgorithm = algoMatch[1];
  if (visibilityMatch) {
    (result as { visibility?: 'public' | 'shared' | 'private' }).visibility =
      visibilityMatch[1] as 'public' | 'shared' | 'private';
  }
  return result;
}

// ═════════════════════════════════════════════════════════════
//  Fetch & decrypt an encrypted graph payload
// ═════════════════════════════════════════════════════════════

/**
 * Fetch a graph URL that may be an encrypted envelope and return plaintext
 * if the caller's key is a recipient. Plaintext TriG passes through
 * unchanged. Returns null when the caller isn't a recipient (authorized
 * but no wrapped key for their public key) or decryption fails.
 */
export async function fetchGraphContent(
  graphUrl: string,
  options: { fetch?: FetchFn; recipientKeyPair?: EncryptionKeyPair } = {},
): Promise<{ content: string | null; encrypted: boolean; mediaType: string }> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const r = await withTransientRetry(async () => {
    const resp = await fetchFn(graphUrl, { headers: { 'Accept': `${ENVELOPE_CONTENT_TYPE}, ${TRIG_CONTENT_TYPE}, ${TURTLE_CONTENT_TYPE}` } });
    if (!resp.ok) throw new Error(`Failed to GET ${graphUrl}: ${resp.status} ${resp.statusText}`);
    return resp;
  });
  const mediaType = r.headers?.get('Content-Type') ?? '';
  const body = await r.text();

  const looksLikeEnvelope = graphUrl.endsWith('.envelope.jose.json') || mediaType.includes('jose') || mediaType.includes('json');
  if (!looksLikeEnvelope) {
    return { content: body, encrypted: false, mediaType };
  }
  // Attempt envelope parse; if it's malformed JSON, surface body as-is.
  let env: EncryptedEnvelope;
  try {
    env = JSON.parse(body) as EncryptedEnvelope;
  } catch {
    return { content: body, encrypted: false, mediaType };
  }
  if (!env || env.algorithm !== 'X25519-XSalsa20-Poly1305' || !Array.isArray(env.wrappedKeys)) {
    return { content: body, encrypted: false, mediaType };
  }
  if (!options.recipientKeyPair) {
    return { content: null, encrypted: true, mediaType };
  }
  const plaintext = openEncryptedEnvelope(env, options.recipientKeyPair);
  return { content: plaintext, encrypted: true, mediaType };
}

// ═════════════════════════════════════════════════════════════
//  discover()
// ═════════════════════════════════════════════════════════════

/**
 * Discover Context Descriptors published on a Solid pod.
 *
 * Fetches the .well-known/context-graphs manifest, parses it,
 * and returns entries optionally filtered by facet type,
 * temporal range, trust level, or modal status.
 *
 * @param podUrl - Root URL of the Solid pod.
 * @param filter - Optional filter criteria.
 * @param options - Optional configuration.
 * @returns Matching manifest entries.
 */
export async function discover(
  podUrl: string,
  filter?: DiscoverFilter,
  options: DiscoverOptions = {},
): Promise<ManifestEntry[]> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const manifestUrl = `${pod}${MANIFEST_PATH}`;

  // Promote 5xx RESPONSES to throws inside the lambda so
  // `withTransientRetry` actually retries them. Without this, a single
  // Azure-Files cold-cache 503 (a returned response, not a thrown
  // network error) escapes the retry loop unhandled and surfaces as
  // `precondition_unavailable` to every caller that relies on the
  // manifest read — including the Phase A CAS pre-flight in the
  // MCP relay's publish_context handler. The thrown message embeds the
  // status digits so the helper's TRANSIENT_PATTERN (/5\d\d/) matches.
  let attempts = 0;
  const response = await withTransientRetry(async () => {
    attempts++;
    const r = await fetchFn(manifestUrl, {
      method: 'GET',
      headers: { 'Accept': TURTLE_CONTENT_TYPE },
    });
    if (r.status >= 500) {
      throw new Error(
        `Failed to fetch manifest from ${manifestUrl}: ${r.status} ${r.statusText} (attempt ${attempts})`,
      );
    }
    return r;
  }, { maxAttempts: 6, baseMs: 500 });

  if (!response.ok) {
    if (response.status === 404) {
      return [];
    }
    throw new Error(
      `Failed to fetch manifest from ${manifestUrl}: ${response.status} ${response.statusText} (after ${attempts} attempts)`,
    );
  }

  const turtle = await response.text();
  const parsed = parseManifest(turtle);
  // Resolve relative entry URLs against the manifest base. CSS may serialize
  // same-origin descriptor URLs as RELATIVE (e.g. `../context-graphs/X.ttl`,
  // `../foxxi-wallet/cred-…`) — notably after a PATCH triggers a re-serialize —
  // and downstream consumers (clr.ts fetchCredential, the mesh projector, etc.)
  // call fetch()/new URL() on `descriptorUrl`/`describes`, which throws on a
  // relative string ("Failed to parse URL from ../…"). Absolutize here so every
  // consumer gets a resolvable URL regardless of how the manifest was serialized.
  // Absolute http(s)/urn values pass through unchanged.
  const absolutize = (u: string): string => {
    try { return new URL(u, manifestUrl).href; } catch { return u; }
  };
  const entries: ManifestEntry[] = parsed.map(e => ({
    ...e,
    ...(e.descriptorUrl ? { descriptorUrl: absolutize(e.descriptorUrl) } : {}),
    ...(Array.isArray(e.describes) ? { describes: e.describes.map(absolutize) } : {}),
  }));

  // Apply filter, then sort, then limit. Order matters: filter first
  // so the sort+limit operate over the relevant slice; sort before
  // limit so 'latest N' actually returns the N most-recent matches
  // rather than the N first matches in server-native order.
  const filtered = filter
    ? entries.filter(entry => matchesFilter(entry, filter))
    : entries;

  const sortMode = filter?.sort ?? 'newest-first';
  let sorted: ManifestEntry[] = filtered;
  if (sortMode !== 'unsorted') {
    // Sort by `validFrom` (the descriptor's own declared instant of
    // becoming valid — same field publish() stamps with the publish
    // moment). Entries lacking validFrom sink to the end on
    // newest-first, rise to the front on oldest-first — consistent
    // with treating "no declared start" as "indeterminate, deprioritize
    // when ranking by recency."
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = a.validFrom ?? '';
      const bv = b.validFrom ?? '';
      if (sortMode === 'newest-first') {
        if (!av && bv) return 1;
        if (av && !bv) return -1;
        if (av === bv) return 0;
        return av < bv ? 1 : -1;
      }
      // oldest-first
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      if (av === bv) return 0;
      return av < bv ? -1 : 1;
    });
    sorted = copy;
  }

  if (filter?.limit !== undefined && filter.limit >= 0) {
    return sorted.slice(0, filter.limit);
  }
  return sorted;
}

// ═════════════════════════════════════════════════════════════
//  subscribe()
// ═════════════════════════════════════════════════════════════

/**
 * Subscribe to context-graph changes on a Solid pod using the
 * Solid Notifications Protocol (WebSocket channel).
 *
 * Discovery follows the Solid Protocol:
 *   1. HEAD the pod URL to find the storage description via
 *      Link rel="http://www.w3.org/ns/solid/terms#storageDescription".
 *   2. GET the storage description (Turtle) and parse the
 *      WebSocketChannel2023 subscription endpoint.
 *   3. POST a subscription request for the context-graphs resource.
 *   4. Open a WebSocket to the returned receiveFrom URL.
 *
 * @see https://solidproject.org/TR/notifications-protocol
 *
 * @param podUrl - Root URL of the Solid pod.
 * @param callback - Invoked on each context-graph change event.
 * @param options - Optional configuration.
 * @returns A Subscription handle with an unsubscribe() method.
 */
export async function subscribe(
  podUrl: string,
  callback: ContextChangeCallback,
  options: SubscribeOptions = {},
): Promise<Subscription> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const WS = options.WebSocket ?? getDefaultWebSocket();
  const pod = ensureTrailingSlash(podUrl);
  const topic = `${pod}${MANIFEST_PATH}`;

  // Step 1: Discover the storage description URL.
  // Per Solid Protocol, any resource's response includes a Link header
  // with rel="http://www.w3.org/ns/solid/terms#storageDescription".
  const headResponse = await withTransientRetry(() => fetchFn(pod, {
    method: 'HEAD',
  }));

  let storageDescUrl: string | undefined;

  // Parse Link header for storageDescription
  const linkHeader = headResponse.headers?.get('link') ?? headResponse.headers?.get('Link') ?? '';
  const storageDescMatch = linkHeader.match(/<([^>]+)>;\s*rel="http:\/\/www\.w3\.org\/ns\/solid\/terms#storageDescription"/);
  if (storageDescMatch) {
    storageDescUrl = storageDescMatch[1]!;
  }

  // Fallback: try .well-known/solid at the pod URL
  if (!storageDescUrl) {
    storageDescUrl = `${pod}.well-known/solid`;
  }

  // Step 2: Fetch the storage description to find the notification endpoint.
  const descResponse = await withTransientRetry(() => fetchFn(storageDescUrl, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  }));

  if (!descResponse.ok) {
    throw new Error(
      `Failed to fetch storage description from ${storageDescUrl}: ${descResponse.status} ${descResponse.statusText}`,
    );
  }

  const descBody = await descResponse.text();

  // Parse the WebSocket subscription endpoint from the Turtle description.
  // CSS returns Turtle like:
  //   <../.notifications/WebSocketChannel2023/> notify:channelType notify:WebSocketChannel2023 .
  // The URL may be relative (CSS uses relative IRIs) — resolve against the description URL.
  let subscriptionEndpoint: string | undefined;

  const wsEndpointMatch = descBody.match(/<([^>]*WebSocketChannel2023[^>]*)>/);
  if (wsEndpointMatch) {
    const raw = wsEndpointMatch[1]!;
    // Resolve relative URLs against the storage description URL
    try {
      subscriptionEndpoint = new URL(raw, storageDescUrl).href;
    } catch {
      subscriptionEndpoint = raw;
    }
  }

  // Fallback: construct the conventional CSS path
  if (!subscriptionEndpoint) {
    const serverRoot = storageDescUrl.replace(/\.well-known\/solid$/, '');
    subscriptionEndpoint = `${serverRoot}.notifications/WebSocketChannel2023/`;
  }

  // Step 3: Request a WebSocket subscription for the topic.
  const subResponse = await withTransientRetry(() => fetchFn(subscriptionEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify({
      '@context': ['https://www.w3.org/ns/solid/notification/v1'],
      type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      topic,
    }),
  }));

  if (!subResponse.ok) {
    throw new Error(
      `Failed to subscribe at ${subscriptionEndpoint}: ${subResponse.status} ${subResponse.statusText}`,
    );
  }

  const subResult = await subResponse.json() as Record<string, unknown>;
  const wsUrl = (subResult['receiveFrom'] ?? subResult['source']) as string;

  if (!wsUrl) {
    throw new Error('Subscription response did not contain a WebSocket URL (receiveFrom)');
  }

  // Step 4: Open WebSocket and listen for notifications.
  //
  // Some WebSocket implementations throw synchronously from the
  // constructor on transient failures (DNS hiccup, refused connect).
  // We retry the open itself with the same backoff schedule the rest
  // of the substrate uses — but only for the open. Once the channel
  // is established the long-lived stream is the caller's resume
  // problem; we deliberately do not paper over disconnects below.
  const ws = await withTransientRetry(() => Promise.resolve(new WS(wsUrl)));

  ws.onmessage = (event: { data: unknown }) => {
    try {
      const notification = JSON.parse(
        typeof event.data === 'string' ? event.data : '',
      ) as Record<string, unknown>;

      let changeType: ContextChangeEvent['type'];
      const asType = notification['type'] as string | undefined;
      if (asType === 'Add' || asType === 'Create') {
        changeType = 'Add';
      } else if (asType === 'Update') {
        changeType = 'Update';
      } else if (asType === 'Remove' || asType === 'Delete') {
        changeType = 'Remove';
      } else {
        changeType = 'Update';
      }

      const objectVal = notification['object'];
      const resource =
        typeof objectVal === 'string'
          ? objectVal
          : (typeof objectVal === 'object' && objectVal !== null
              ? (objectVal as Record<string, unknown>)['id'] as string
              : topic);

      callback({
        resource,
        type: changeType,
        timestamp:
          (notification['published'] as string) ??
          new Date().toISOString(),
      });
    } catch {
      // Ignore unparseable messages (e.g. ping frames)
    }
  };

  return {
    unsubscribe: () => {
      ws.close();
    },
  };
}

// ═════════════════════════════════════════════════════════════
//  Agent Registry — pod-level owner/agent delegation
// ═════════════════════════════════════════════════════════════

/**
 * Write an owner profile (agent registry) to a Solid pod.
 *
 * Stores the profile at `{podUrl}/agents` as Turtle containing:
 *   - The owner's WebID and name
 *   - All authorized agents with scope, validity, and revocation status
 *
 * @param profile - The owner profile to write
 * @param podUrl - Root URL of the Solid pod
 * @param options - Optional configuration
 * @returns The URL where the registry was written
 */
export async function writeAgentRegistry(
  profile: OwnerProfileData,
  podUrl: string,
  options: RegistryOptions = {},
): Promise<string> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const registryUrl = `${pod}${AGENT_REGISTRY_PATH}`;
  const turtle = ownerProfileToTurtle(profile);

  const resp = await fetchFn(registryUrl, {
    method: 'PUT',
    headers: { 'Content-Type': TURTLE_CONTENT_TYPE },
    body: turtle,
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to write agent registry to ${registryUrl}: ${resp.status} ${resp.statusText}`,
    );
  }

  return registryUrl;
}

/**
 * Read an owner profile (agent registry) from a Solid pod.
 *
 * @param podUrl - Root URL of the Solid pod
 * @param options - Optional configuration
 * @returns The parsed owner profile, or null if not found
 */
export async function readAgentRegistry(
  podUrl: string,
  options: RegistryOptions = {},
): Promise<OwnerProfileData | null> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const registryUrl = `${pod}${AGENT_REGISTRY_PATH}`;

  const resp = await fetchFn(registryUrl, {
    method: 'GET',
    headers: { 'Accept': TURTLE_CONTENT_TYPE },
  });

  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(
      `Failed to read agent registry from ${registryUrl}: ${resp.status} ${resp.statusText}`,
    );
  }

  const turtle = await resp.text();
  return parseOwnerProfile(turtle);
}

/**
 * Write a delegation credential to a Solid pod.
 *
 * Stores the credential at `{podUrl}/credentials/{agentId}.jsonld`
 * as JSON-LD conforming to the VC Data Model 2.0.
 *
 * @param credential - The delegation credential to write
 * @param podUrl - Root URL of the Solid pod
 * @param options - Optional configuration
 * @returns The URL where the credential was written
 */
export async function writeDelegationCredential(
  credential: AgentDelegationCredential,
  podUrl: string,
  options: RegistryOptions = {},
): Promise<string> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const agentSlug = encodeURIComponent(credential.credentialSubject.id);
  const credentialUrl = `${pod}${CREDENTIALS_PATH}${agentSlug}.jsonld`;
  const jsonLd = delegationCredentialToJsonLd(credential);

  const resp = await fetchFn(credentialUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/ld+json' },
    body: jsonLd,
  });

  if (!resp.ok) {
    throw new Error(
      `Failed to write credential to ${credentialUrl}: ${resp.status} ${resp.statusText}`,
    );
  }

  return credentialUrl;
}

/**
 * Read a signed delegation credential from a Solid pod.
 *
 * Returns `null` when no credential exists for the agent. Used by
 * `verifyAgentDelegation` when a `verifier` is supplied: the credential
 * is rehydrated, its canonical payload is recomputed, and the proof block
 * is checked against the owner's wallet key.
 */
export async function readDelegationCredential(
  podUrl: string,
  agentId: IRI,
  options: RegistryOptions = {},
): Promise<AgentDelegationCredential | null> {
  const fetchFn = options.fetch ?? getDefaultFetch();
  const pod = ensureTrailingSlash(podUrl);
  const agentSlug = encodeURIComponent(agentId);
  const credentialUrl = `${pod}${CREDENTIALS_PATH}${agentSlug}.jsonld`;

  const resp = await fetchFn(credentialUrl, {
    method: 'GET',
    headers: { 'Accept': 'application/ld+json' },
  });
  if (!resp.ok) {
    if (resp.status === 404) return null;
    throw new Error(
      `Failed to read delegation credential from ${credentialUrl}: ${resp.status} ${resp.statusText}`,
    );
  }
  const jsonLd = await resp.text();
  return parseDelegationCredential(jsonLd);
}

/**
 * Options for `verifyAgentDelegation` — extends the registry options with
 * an optional `verifier` callback that turns the function into a
 * cryptographic chain check. When supplied, verifyAgentDelegation walks
 * the signed VC chain from the agent up to the pod owner and only
 * returns `trustLevel: 'CryptographicallyVerified'` if every link
 * validates.
 */
export interface VerifyAgentDelegationOptions extends RegistryOptions {
  /** Cryptographic verifier for VC proof blocks. */
  readonly verifier?: DelegationVerifier;
  /** Whether to walk sub-delegation chains (default true). */
  readonly walkSubDelegations?: boolean;
  /** Maximum chain depth before erroring out (default 8). */
  readonly maxChainLength?: number;
}

/**
 * Verify that an agent is authorized to act on a pod by checking the
 * pod's agent registry, and — when a `verifier` is supplied — its signed
 * delegation credential chain.
 *
 * Without a verifier, the result mirrors the legacy registry-only check
 * and carries `trustLevel: 'SelfAsserted'`. With a verifier, the signed
 * VC at `<pod>/credentials/<agentId>.jsonld` is fetched, its proof is
 * checked against the owner's wallet key, and any sub-delegation chain
 * is walked to the pod owner — only then is the result labelled
 * `'CryptographicallyVerified'`.
 *
 * @param agentId - The agent claiming delegation
 * @param podUrl - The pod URL being acted on
 * @param options - Optional configuration (fetch, verifier, chain limits)
 * @returns Verification result
 */
export async function verifyAgentDelegation(
  agentId: IRI,
  podUrl: string,
  options: VerifyAgentDelegationOptions = {},
): Promise<DelegationVerification> {
  return verifyDelegation(
    agentId,
    podUrl,
    async (url: string) => readAgentRegistry(url, options),
    options.verifier
      ? {
          fetchCredential: async (url, agent) => readDelegationCredential(url, agent, options),
          verifier: options.verifier,
          walkSubDelegations: options.walkSubDelegations,
          maxChainLength: options.maxChainLength,
        }
      : {},
  );
}

// ─────────────────────────────────────────────────────────────
//  verify_agent response envelope (shared by MCP shims)
// ─────────────────────────────────────────────────────────────

/**
 * Stable response envelope returned by every `verify_agent` MCP tool
 * (both the stdio shim under `mcp-server/` and the HTTP relay under
 * `deploy/mcp-relay/`).
 *
 * Why this exists: the raw `DelegationVerification` shape uses
 * trust-label string-discrimination (`trustLevel === 'CryptographicallyVerified'`)
 * to tell registry-only from chain-walked results. Downstream agents
 * (claude.ai connector, ChatGPT, codex/cursor bridges, regulators)
 * need to branch on a single boolean — they should not have to parse
 * `trustLevel` strings. So we surface `delegationChain` as a concrete
 * object iff the chain walk succeeded, and `null` otherwise.
 *
 * The raw `valid` / `owner` / `agent` / `scope` fields stay alongside
 * so the v0.4 wire shape still passes through; this is additive.
 */
export interface VerifyAgentEnvelope {
  readonly verified: boolean;
  readonly trustLevel: 'CryptographicallyVerified' | 'SelfAsserted';
  /**
   * Number of signed links in the verified chain. 0 when verification
   * failed before any link could be checked; 1 for a direct
   * owner→agent delegation; n>1 for sub-delegated chains.
   */
  readonly chainLength: number;
  /**
   * Concrete chain block, ONLY populated when
   * `trustLevel === 'CryptographicallyVerified'`. Clients branch on
   * `delegationChain != null` to gate cryptographic-trust paths.
   */
  readonly delegationChain: {
    readonly anchored: true;
    readonly owner?: IRI;
    readonly agent?: IRI;
    readonly scope?: string;
    readonly length: number;
  } | null;
  readonly reason: string | null;
  // Raw fields kept for back-compat.
  readonly valid: boolean;
  readonly owner?: IRI;
  readonly agent?: IRI;
  readonly scope?: string;
}

/**
 * Wrap a `DelegationVerification` (the raw result returned by
 * `verifyAgentDelegation`) in the stable `verify_agent` envelope.
 *
 * Factored out so the stdio shim under `mcp-server/server.ts` and the
 * HTTP shim under `deploy/mcp-relay/server.ts` emit byte-equivalent
 * JSON for the same `(agent_id, pod_url)` input — wire-format drift
 * between the two surfaces was the original observable bug
 * (johnny's `{ verified, agents:[...] }` paraphrase did not match the
 * stdio text-summary that callers actually hit).
 */
export function buildVerifyAgentEnvelope(result: DelegationVerification): VerifyAgentEnvelope {
  const trustLevel = result.trustLevel ?? 'SelfAsserted';
  const chainLength = result.chainLength ?? (result.valid ? 1 : 0);
  const cryptographicallyVerified = result.valid && trustLevel === 'CryptographicallyVerified';
  return {
    verified: result.valid,
    trustLevel,
    chainLength,
    delegationChain: cryptographicallyVerified
      ? {
          anchored: true,
          owner: result.owner,
          agent: result.agent,
          scope: result.scope,
          length: chainLength,
        }
      : null,
    reason: result.reason ?? null,
    valid: result.valid,
    owner: result.owner,
    agent: result.agent,
    scope: result.scope,
  };
}
