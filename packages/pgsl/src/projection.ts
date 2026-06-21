/**
 * @module pgsl/projection
 * @description PGSL → cg-RDF projection engine (Stage 3 of foundation-first).
 *
 * Foundation-first principle: a holon (a PGSL node) is the source of truth; a
 * context descriptor + a manifest entry are DETERMINISTIC RENDERS (projections)
 * of that holon — never independent artifacts maintained out-of-band. So the
 * manifest is a *render of a lattice slice*: `projectLatticeSlice(pgsl, uris)`
 * yields the same entries every time, each carrying `iep:pgslUri` back to the
 * exact holon it projects. Because the holon URI is content-addressed, the same
 * content from two different pods projects to the same `graphUri`/`pgslUri` —
 * structural overlap is detectable across federation from the manifest alone.
 *
 * This inverts the legacy path (manifest built by scanning pod files + filename
 * heuristics — the source of the recurring manifest-collapse bugs). The render
 * here is format-compatible with the existing manifest, so `parseManifest` reads
 * it unchanged (non-breaking); Stage 5 migrates the live publish path onto this
 * engine. Composes {@link nodeToTurtle} (the lattice's own RDF render) rather
 * than re-deriving any serialization.
 */
import { createHash } from 'node:crypto';
import type { ManifestEntry } from '@interego/core';
import type { Node, Fragment, PGSLInstance } from './types.js';
import { nodeToTurtle, pgslTurtlePrefixes } from './rdf.js';

export const CG_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#' as const;
export const DCT_NS = 'http://purl.org/dc/terms/' as const;

export interface HolonProjection {
  readonly pgslUri: string;
  readonly pgslLevel: number;
  /**
   * Content graph IRI this descriptor describes — the holon's own URI.
   * Content-addressed, so identical content across pods yields an identical
   * graphUri (federation overlap is detectable without fetching bodies).
   */
  readonly graphUri: string;
  /** Deterministic descriptor resource URL under the supplied container. */
  readonly descriptorUrl: string;
  /** iep:ContextDescriptor Turtle (a Projection facet) + the holon's pgsl: triples. */
  readonly descriptorTurtle: string;
  /** Manifest row data for this descriptor — render via {@link renderManifestEntry}. */
  readonly manifestEntry: ManifestEntry;
}

export interface ProjectHolonOptions {
  /**
   * Container URL where the descriptor resource is placed. Callers resolve this
   * via the agent's Solid Type Index (resolveStorageForShape) so each agent's
   * projections live where that agent self-describes — never a hardcoded path.
   */
  readonly descriptorBase: string;
  /**
   * URL of the ENCRYPTED canonical holon resource this descriptor projects, if
   * already known. When provided, the descriptor links to it (iep:encryptedHolon)
   * with a followable hydra affordance — so a reader DISCOVERS + FOLLOWS the link
   * to fetch + decrypt the holon, rather than recomputing a resource path.
   */
  readonly encryptedHolonUrl?: string;
  /**
   * Opt-in: additionally emit nested typed facets (`iep:hasFacet [a iep:AgentFacet …]`,
   * Temporal/Provenance/Trust/Semiotic) DERIVED FROM `node.provenance`, so the
   * interrogative router answers Who/When/Why/How/WhatKind/Whether over this
   * descriptor instead of returning `absent`. Default OFF → the descriptor is
   * byte-identical for the manifest-render / persist callers (the new triples are
   * additive to, and a different predicate from, the existing `iep:hasFacetType
   * iep:Projection` marker). Honest tiers: Who/When/WhatKind=full; Why/How=partial;
   * Whether=partial (`SelfAsserted` unless the node is signed). `iep:validFrom` is
   * sourced from `provenance.generatedAtTime` — for an immutable lattice holon the
   * moment it was minted is when its assertion takes effect (also carried, exactly,
   * as `prov:generatedAtTime` on the Provenance facet).
   */
  readonly typedFacets?: boolean;
  /**
   * Content-type tag for the Semiotic facet's `iep:interpretationFrame` (e.g.
   * `foxxi:Verification`, `ob3:OpenBadgeCredential`). Only read when `typedFacets`
   * is set; pure (no clock / IO). When absent a defensible default frame is used so
   * the five core facets are always present together.
   */
  readonly contentType?: string;
}

function levelOf(node: Node): number {
  return node.kind === 'Atom' ? 0 : (node as Fragment).level;
}

/** Deterministic descriptor slug from a holon URI (stable across runs + pods). */
export function descriptorSlug(pgslUri: string): string {
  return `holon-${createHash('sha256').update(pgslUri).digest('hex').slice(0, 24)}`;
}

/** Percent-encode a content-type tag into one opaque URN segment (deterministic). */
function contentTypeFrame(contentType: string): string {
  return `urn:iep:contenttype:${contentType.replace(/:/g, '%3A')}`;
}

/**
 * Nested typed facet bnodes derived ENTIRELY from `node.provenance` + `contentType`
 * (pure, deterministic — no clock read). Emitted as `iep:hasFacet [a iep:XFacet …]` so
 * BOTH the SHACL six-facet shape (which keys off the `iep:hasFacet` wrapper) and the
 * interrogative router (which keys off the bnode's `rdf:type`) read them. Each line
 * ends with ` ;` so it chains inside the descriptor's predicate list.
 *
 * Honest by construction: no synthetic `prov:Activity` (would be empty padding); no
 * `iep:modalStatus` (the modal-truth-consistency shape requires groundTruth when
 * Asserted — we don't fabricate truth of a type tag); no `iep:proof` (the router
 * never reads it and the demo holons are unsigned). Trust is `SelfAsserted` unless
 * the node actually carries a signature.
 */
function typedFacetLines(node: Node, contentType?: string): string[] {
  const p = node.provenance;
  const agent = `<${p.wasAttributedTo}>`;
  const when = `"${p.generatedAtTime}"^^xsd:dateTime`;
  const trustLevel = p.signature ? 'iep:CryptographicallyVerified' : 'iep:SelfAsserted';
  const frame = contentTypeFrame(contentType ?? 'unspecified');
  return [
    `    iep:hasFacet [ a iep:AgentFacet ;`,
    `        iep:assertingAgent [ a prov:Agent ; iep:agentIdentity ${agent} ] ;`,
    `        iep:agentRole iep:Author ;`,
    `        iep:onBehalfOf ${agent} ] ;`,
    `    iep:hasFacet [ a iep:TemporalFacet ; iep:validFrom ${when} ] ;`,
    `    iep:hasFacet [ a iep:ProvenanceFacet ;`,
    `        prov:wasAttributedTo ${agent} ;`,
    `        prov:generatedAtTime ${when} ] ;`,
    `    iep:hasFacet [ a iep:TrustFacet ; iep:trustLevel ${trustLevel} ] ;`,
    `    iep:hasFacet [ a iep:SemioticFacet ; iep:interpretationFrame <${frame}> ] ;`,
  ];
}

/**
 * Project a single holon into a context descriptor + manifest entry. Pure and
 * deterministic: same (node, descriptorBase) → byte-identical descriptorUrl,
 * descriptorTurtle, and manifestEntry.
 */
export function projectHolon(
  node: Node,
  pgsl: PGSLInstance,
  opts: ProjectHolonOptions,
): HolonProjection {
  const base = opts.descriptorBase.endsWith('/') ? opts.descriptorBase : `${opts.descriptorBase}/`;
  const pgslUri = node.uri;
  const pgslLevel = levelOf(node);
  const graphUri = node.uri;
  const descriptorUrl = `${base}${descriptorSlug(pgslUri)}.ttl`;

  const encHolon = opts.encryptedHolonUrl;
  const descriptorTurtle = [
    pgslTurtlePrefixes(),
    `@prefix iep: <${CG_NS}> .`,
    `@prefix dct: <${DCT_NS}> .`,
    `@prefix hydra: <http://www.w3.org/ns/hydra/core#> .`,
    ``,
    `<${descriptorUrl}> a iep:ContextDescriptor ;`,
    `    iep:describes <${graphUri}> ;`,
    `    iep:hasFacetType iep:Projection ;`,
    // Opt-in: additive typed facets so interrogative_route answers over this
    // descriptor (default OFF keeps manifest-render / persist callers byte-identical).
    ...(opts.typedFacets ? typedFacetLines(node, opts.contentType) : []),
    `    iep:pgslUri <${pgslUri}> ;`,
    `    iep:pgslLevel "${pgslLevel}"^^xsd:nonNegativeInteger ;`,
    // Hypermedia link to the encrypted canonical holon resource — a reader
    // follows this rather than recomputing the resource path.
    ...(encHolon ? [`    iep:encryptedHolon <${encHolon}> ;`] : []),
    `    prov:wasAttributedTo <${node.provenance.wasAttributedTo}> .`,
    ``,
    // Describe the encrypted resource + how to read it (followable affordance).
    ...(encHolon ? [
      `<${encHolon}> a iep:EncryptedHolon ;`,
      `    iep:ofDescriptor <${descriptorUrl}> ;`,
      `    iep:pgslUri <${pgslUri}> ;`,
      `    iep:encryptionAlgorithm "X25519-XSalsa20-Poly1305" ;`,
      `    iep:affordance [`,
      `        a hydra:Operation ;`,
      `        hydra:method "GET" ;`,
      `        hydra:title "Resolve + decrypt the canonical PGSL holon (recipient key required)" ;`,
      `        hydra:returns iep:EncryptedHolon`,
      `    ] .`,
      ``,
    ] : []),
    `# ── projected holon (PGSL lattice render) ──────────────────`,
    nodeToTurtle(node, pgsl),
    ``,
  ].join('\n');

  const manifestEntry: ManifestEntry = {
    descriptorUrl,
    describes: [graphUri],
    facetTypes: ['Projection'],
    pgslUri,
    pgslLevel,
  };

  return { pgslUri, pgslLevel, graphUri, descriptorUrl, descriptorTurtle, manifestEntry };
}

export interface LatticeSliceProjection {
  readonly entries: readonly ManifestEntry[];
  /** descriptorUrl → descriptor Turtle, for writing each as a pod resource. */
  readonly descriptors: ReadonlyMap<string, string>;
}

/**
 * Project a slice of the lattice (a set of holon URIs) into manifest entries +
 * descriptors. The returned `entries` ARE the manifest — a render of this slice,
 * not a scan of a pod. Missing URIs are skipped (the caller decides the slice).
 */
export function projectLatticeSlice(
  pgsl: PGSLInstance,
  uris: readonly string[],
  opts: ProjectHolonOptions,
): LatticeSliceProjection {
  const entries: ManifestEntry[] = [];
  const descriptors = new Map<string, string>();
  for (const uri of uris) {
    const node = pgsl.nodes.get(uri);
    if (!node) continue;
    const p = projectHolon(node, pgsl, opts);
    entries.push(p.manifestEntry);
    descriptors.set(p.descriptorUrl, p.descriptorTurtle);
  }
  return { entries, descriptors };
}

/**
 * Render one manifest entry as a `iep:ManifestEntry` Turtle row, including the
 * `iep:pgslUri`/`iep:pgslLevel` lattice pointer. Format-compatible with the live
 * manifest, so `parseManifest` (in @interego/solid) reads it back losslessly.
 */
export function renderManifestEntry(entry: ManifestEntry): string {
  const lines: string[] = [`<${entry.descriptorUrl}> a iep:ManifestEntry ;`];
  if (entry.cid) lines.push(`    iep:contentCid "${entry.cid}" ;`);
  for (const g of entry.describes) lines.push(`    iep:describes <${g}> ;`);
  for (const ft of [...new Set(entry.facetTypes)]) lines.push(`    iep:hasFacetType iep:${ft} ;`);
  if (entry.validFrom) lines.push(`    iep:validFrom "${entry.validFrom}"^^xsd:dateTime ;`);
  if (entry.validUntil) lines.push(`    iep:validUntil "${entry.validUntil}"^^xsd:dateTime ;`);
  if (entry.conformsTo) for (const c of entry.conformsTo) lines.push(`    dct:conformsTo <${c}> ;`);
  if (entry.supersedes) for (const s of entry.supersedes) lines.push(`    iep:supersedes <${s}> ;`);
  if (entry.modalStatus) lines.push(`    iep:modalStatus iep:${entry.modalStatus} ;`);
  if (entry.trustLevel) lines.push(`    iep:trustLevel iep:${entry.trustLevel} ;`);
  if (entry.issuer) lines.push(`    iep:issuer <${entry.issuer}> ;`);
  if (entry.pgslUri) lines.push(`    iep:pgslUri <${entry.pgslUri}> ;`);
  if (entry.pgslLevel !== undefined) lines.push(`    iep:pgslLevel "${entry.pgslLevel}"^^xsd:nonNegativeInteger ;`);
  const last = lines.length - 1;
  lines[last] = lines[last]!.replace(/ ;$/, ' .');
  return lines.join('\n');
}

// ── W3C interop renderers (Stage 4) ─────────────────────────
//
// A holon is the canonical source; a Verifiable Credential or an
// ActivityStreams notification is a PROJECTION of it. These are
// Interego-CORE interop surfaces (general-purpose W3C vocab). Vertical
// domain shapes — xAPI / cmi5 / SCORM / CLR for Foxxi — are projected by
// the VERTICAL over these foundations and MUST NOT live here. Renderers
// are pure + deterministic (timestamps are passed in, never generated), so
// they compose with the encrypted-envelope persistence (createEncryptedEnvelope)
// to satisfy "encrypt findings/creds" without baking crypto into the render.

/** An unsigned W3C Verifiable Credential projected from a holon. */
export interface HolonCredential {
  readonly '@context': readonly string[];
  readonly id: string;
  readonly type: readonly string[];
  readonly issuer: string;
  readonly issuanceDate: string;
  readonly credentialSubject: {
    readonly id: string;
    readonly pgslUri: string;
    readonly pgslLevel: number;
    readonly [claim: string]: unknown;
  };
}

export interface ProjectCredentialOptions {
  /** Issuing agent (DID/WebID). Defaults to the holon's prov:wasAttributedTo. */
  readonly issuer?: string;
  /** ISO timestamp — passed in for determinism (renderers never call Date.now). */
  readonly issuanceDate: string;
  /** Extra VC types appended after the base ['VerifiableCredential','LatticeProjection']. */
  readonly extraTypes?: readonly string[];
  /** Additional credential claims merged into credentialSubject. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/**
 * Project a holon into an unsigned W3C Verifiable Credential. The
 * credentialSubject IS the holon (id = its content-addressed graph URI), so the
 * VC is verifiably a render of the lattice. The caller signs it with existing VC
 * machinery and may wrap it with createEncryptedEnvelope to encrypt the finding.
 */
export function projectHolonToCredential(
  node: Node,
  opts: ProjectCredentialOptions,
): HolonCredential {
  const pgslUri = node.uri;
  const pgslLevel = levelOf(node);
  return {
    '@context': ['https://www.w3.org/2018/credentials/v1', CG_NS],
    id: `${pgslUri}#vc`,
    type: ['VerifiableCredential', 'LatticeProjection', ...(opts.extraTypes ?? [])],
    issuer: opts.issuer ?? node.provenance.wasAttributedTo,
    issuanceDate: opts.issuanceDate,
    credentialSubject: {
      id: pgslUri,
      pgslUri,
      pgslLevel,
      ...(opts.claims ?? {}),
    },
  };
}

/** An ActivityStreams 2.0 activity projected from a holon (for LDN delivery). */
export interface HolonActivity {
  readonly '@context': string;
  readonly type: string;
  readonly actor: string;
  readonly object: {
    readonly id: string;
    readonly type: string;
    readonly 'pgsl:level': number;
  };
  readonly published: string;
  readonly to?: readonly string[];
}

export interface ProjectActivityOptions {
  /** Actor (DID/WebID). Defaults to the holon's prov:wasAttributedTo. */
  readonly actor?: string;
  /** Activity type (Create | Announce | Update …). Default 'Create'. */
  readonly activityType?: string;
  /** ISO timestamp — passed in for determinism. */
  readonly published: string;
  /** Recipient inboxes/actors. */
  readonly to?: readonly string[];
}

/**
 * Project a holon into an ActivityStreams 2.0 activity referencing the holon's
 * content graph — the payload an agent POSTs to a peer's LDN inbox to announce a
 * new/updated holon. The object.id is the content-addressed graph URI, so a
 * recipient can dereference + verify the same holon.
 */
export function projectHolonToActivity(
  node: Node,
  opts: ProjectActivityOptions,
): HolonActivity {
  const activity: HolonActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: opts.activityType ?? 'Create',
    actor: opts.actor ?? node.provenance.wasAttributedTo,
    object: {
      id: node.uri,
      type: 'Document',
      'pgsl:level': levelOf(node),
    },
    published: opts.published,
    ...(opts.to ? { to: opts.to } : {}),
  };
  return activity;
}

/** Render a full manifest body (prefixes + entry rows) for a lattice slice. */
export function renderManifestBody(entries: readonly ManifestEntry[]): string {
  const prefixes = [
    `@prefix iep: <${CG_NS}> .`,
    `@prefix dct: <${DCT_NS}> .`,
    `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .`,
  ].join('\n');
  return `${prefixes}\n\n${entries.map(renderManifestEntry).join('\n\n')}\n`;
}
