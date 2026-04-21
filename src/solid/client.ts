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

import type { ContextDescriptorData, ContextTypeName, OwnerProfileData, AgentDelegationCredential, DelegationVerification, IRI, SemioticFacetData, TrustFacetData, ModalStatus, TrustLevel } from '../model/types.js';
import { toTurtle } from '../rdf/serializer.js';
import { turtlePrefixes } from '../rdf/namespaces.js';
import { ownerProfileToTurtle, parseOwnerProfile, delegationCredentialToJsonLd, verifyDelegation } from '../model/delegation.js';
import { createEncryptedEnvelope, openEncryptedEnvelope, type EncryptedEnvelope, type EncryptionKeyPair } from '../crypto/encryption.js';

import type {
  FetchFn,
  WebSocketConstructor,
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

function getDefaultFetch(): FetchFn {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)['fetch'] === 'function') {
    return (globalThis as Record<string, unknown>)['fetch'] as FetchFn;
  }
  throw new Error('No fetch implementation available. Pass one via options.fetch.');
}

function getDefaultWebSocket(): WebSocketConstructor {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (typeof globalThis !== 'undefined' && typeof (globalThis as Record<string, unknown>)['WebSocket'] === 'function') {
    return (globalThis as Record<string, unknown>)['WebSocket'] as WebSocketConstructor;
  }
  throw new Error('No WebSocket implementation available. Pass one via options.WebSocket.');
}

/**
 * Wrap Turtle triples inside a TriG named graph block.
 */
function wrapAsTriG(
  descriptorTurtle: string,
  graphContent: string,
  graphIri: string,
): string {
  const lines: string[] = [];

  // Emit prefix block once (from the descriptor output).
  const prefixEnd = descriptorTurtle.lastIndexOf('@prefix');
  const afterLastPrefix = descriptorTurtle.indexOf('\n', prefixEnd);
  const prefixBlock = descriptorTurtle.slice(0, afterLastPrefix + 1);
  const descriptorBody = descriptorTurtle.slice(afterLastPrefix + 1).trim();

  lines.push(prefixBlock);
  lines.push('');
  lines.push('# ── Context Descriptor ────────────────────────────');
  lines.push(descriptorBody);
  lines.push('');
  lines.push('# ── Named Graph Content ───────────────────────────');
  lines.push(`<${graphIri}> {`);
  for (const line of graphContent.split('\n')) {
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
 *   cg:canDiscover  → GET the manifest
 *   cg:canSubscribe → WebSocket via Solid Notifications
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
    `<${manifestUrl}> a hydra:Collection, cg:DataProduct ;`,
    `    hydra:manages [`,
    `        hydra:property cg:describes ;`,
    `        hydra:object cg:ManifestEntry`,
    `    ] ;`,
    `    # HATEOAS affordances — what agents can do with this manifest`,
    `    hydra:operation [`,
    `        a hydra:Operation ;`,
    `        hydra:method "GET" ;`,
    `        hydra:title "Discover context descriptors" ;`,
    `        hydra:expects <http://www.w3.org/ns/hydra/core#Resource> ;`,
    `        hydra:returns cg:ManifestEntry`,
    `    ] ;`,
    `    hydra:operation [`,
    `        a hydra:Operation ;`,
    `        hydra:method "PUT" ;`,
    `        hydra:title "Publish new context descriptor" ;`,
    `        hydra:expects cg:ContextDescriptor ;`,
    `        hydra:returns cg:ManifestEntry`,
    `    ] ;`,
    `    # Affordance declarations for agent capability discovery`,
    `    cg:affordance cg:canDiscover, cg:canSubscribe ;`,
    `    # DPROD: this manifest is a data product output port`,
    `    cg:outputPort [`,
    `        a dcat:Distribution ;`,
    `        dcat:mediaType "text/turtle" ;`,
    `        dcat:accessURL <${manifestUrl}>`,
    `    ] .`,
  ].join('\n');
}

/**
 * Build a Turtle manifest entry for a published descriptor.
 */
function manifestEntryTurtle(
  descriptorUrl: string,
  descriptor: ContextDescriptorData,
): string {
  const lines: string[] = [];
  lines.push(`<${descriptorUrl}> a cg:ManifestEntry ;`);

  for (const g of descriptor.describes) {
    lines.push(`    cg:describes <${g}> ;`);
  }

  const facetTypes = [...new Set(descriptor.facets.map(f => f.type))];
  for (const ft of facetTypes) {
    lines.push(`    cg:hasFacetType cg:${ft} ;`);
  }

  if (descriptor.validFrom) {
    lines.push(`    cg:validFrom "${descriptor.validFrom}"^^xsd:dateTime ;`);
  }
  if (descriptor.validUntil) {
    lines.push(`    cg:validUntil "${descriptor.validUntil}"^^xsd:dateTime ;`);
  }

  // conformsTo (cleartext-mirrored)
  if (descriptor.conformsTo) {
    for (const c of descriptor.conformsTo) {
      lines.push(`    dct:conformsTo <${c}> ;`);
    }
  }

  // Extract modalStatus from Semiotic facet if present
  const semioticFacet = descriptor.facets.find((f): f is SemioticFacetData => f.type === 'Semiotic');
  if (semioticFacet?.modalStatus) {
    lines.push(`    cg:modalStatus cg:${semioticFacet.modalStatus} ;`);
  }

  // Extract trustLevel from Trust facet if present
  const trustFacet = descriptor.facets.find((f): f is TrustFacetData => f.type === 'Trust');
  if (trustFacet?.trustLevel) {
    lines.push(`    cg:trustLevel cg:${trustFacet.trustLevel} ;`);
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
 *   <url> a cg:ManifestEntry ;
 *       cg:describes <graph> ;
 *       cg:hasFacetType cg:Temporal ;
 *       cg:validFrom "..."^^xsd:dateTime .
 */
export function parseManifest(turtle: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  let current: {
    descriptorUrl: string;
    describes: string[];
    facetTypes: ContextTypeName[];
    validFrom?: string;
    validUntil?: string;
    modalStatus?: ModalStatus;
    trustLevel?: TrustLevel;
    conformsTo?: string[];
  } | null = null;

  for (const rawLine of turtle.split('\n')) {
    const line = rawLine.trim();

    const entryMatch = line.match(/^<([^>]+)>\s+a\s+cg:ManifestEntry/);
    if (entryMatch) {
      if (current) {
        entries.push({ ...current });
      }
      current = {
        descriptorUrl: entryMatch[1]!,
        describes: [],
        facetTypes: [],
      };
      continue;
    }

    if (!current) continue;

    const describesMatch = line.match(/cg:describes\s+<([^>]+)>/);
    if (describesMatch) {
      current.describes.push(describesMatch[1]!);
    }

    const facetMatch = line.match(/cg:hasFacetType\s+cg:(\w+)/);
    if (facetMatch) {
      current.facetTypes.push(facetMatch[1]! as ContextTypeName);
    }

    const fromMatch = line.match(/cg:validFrom\s+"([^"]+)"/);
    if (fromMatch) {
      current.validFrom = fromMatch[1]!;
    }

    const untilMatch = line.match(/cg:validUntil\s+"([^"]+)"/);
    if (untilMatch) {
      current.validUntil = untilMatch[1]!;
    }

    const modalMatch = line.match(/cg:modalStatus\s+cg:(\w+)/);
    if (modalMatch) {
      current.modalStatus = modalMatch[1]! as ModalStatus;
    }

    const trustMatch = line.match(/cg:trustLevel\s+cg:(\w+)/);
    if (trustMatch) {
      current.trustLevel = trustMatch[1]! as TrustLevel;
    }

    const conformsMatch = line.match(/dct:conformsTo\s+<([^>]+)>/);
    if (conformsMatch) {
      current.conformsTo = current.conformsTo ?? [];
      current.conformsTo.push(conformsMatch[1]!);
    }

    if (line.endsWith('.')) {
      if (current) {
        entries.push({ ...current });
        current = null;
      }
    }
  }

  if (current) {
    entries.push({ ...current });
  }

  return entries;
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

  const descriptorTurtle = toTurtle(descriptor);
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
  });
  const descriptorWithDistribution = descriptorTurtle.trimEnd() + '\n\n' + distributionBlock + '\n';
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

  // 3. Update the manifest
  const manifestUrl = `${pod}${MANIFEST_PATH}`;
  const newEntry = manifestEntryTurtle(descriptorUrl, descriptor);

  let manifestBody: string;
  const existingResp = await fetchFn(manifestUrl, {
    method: 'GET',
    headers: { 'Accept': TURTLE_CONTENT_TYPE },
  });

  if (existingResp.ok) {
    const existing = await existingResp.text();
    if (existing.includes(`<${descriptorUrl}>`)) {
      manifestBody = existing;
    } else {
      manifestBody = `${existing.trimEnd()}\n\n${newEntry}\n`;
    }
  } else {
    manifestBody = `${turtlePrefixes(['cg', 'xsd', 'hydra', 'dcat', 'dprod', 'dct'])}\n\n${manifestHeaderTurtle(pod)}\n\n${newEntry}\n`;
  }

  const manifestResp = await fetchFn(manifestUrl, {
    method: 'PUT',
    headers: { 'Content-Type': TURTLE_CONTENT_TYPE },
    body: manifestBody,
  });
  if (!manifestResp.ok) {
    throw new Error(
      `Failed to update manifest at ${manifestUrl}: ${manifestResp.status} ${manifestResp.statusText}`,
    );
  }

  // 4. Optional: ingest into PGSL lattice for structural indexing
  let pgslUri: string | undefined;
  let pgslLevel: number | undefined;
  if (options.pgsl) {
    try {
      const { embedInPGSL } = await import('../pgsl/geometric.js');
      const topUri = embedInPGSL(options.pgsl, graphContent, descriptor, options.pgslGranularity);
      const node = options.pgsl.nodes.get(topUri);
      pgslUri = topUri;
      pgslLevel = node?.level;
    } catch {
      // PGSL ingestion is optional — don't fail the publish
    }
  }

  const result: PublishResult = { descriptorUrl, graphUrl, manifestUrl };
  if (encryptedFlag) (result as { encrypted?: boolean }).encrypted = true;
  if (pgslUri !== undefined) (result as { pgslUri?: string }).pgslUri = pgslUri;
  if (pgslLevel !== undefined) (result as { pgslLevel?: number }).pgslLevel = pgslLevel;
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
 *   - cg:Affordance individuals (cg:canFetchPayload, cg:canDecrypt)
 *   - cg:affordance object property (from cg.ttl)
 *   - cgh:Affordance class (harness ontology; rdfs:subClassOf hydra:Operation
 *     — single block is both a Hydra Operation AND a harness affordance)
 *   - dcat:Distribution (W3C data-catalog vocab; the facet is also a DCAT
 *     distribution so DCAT-aware catalogs can ingest it natively)
 *   - alignment.ttl cross-layer axioms (cg:FederationFacet rdfs:seeAlso
 *     dcat:Distribution; cgh:Affordance rdfs:subClassOf hydra:Operation)
 *
 * The block declares a single affordance that is simultaneously:
 *   - a cg:Affordance  (discovery-time capability)
 *   - a cgh:Affordance (execution-time operation, via subclass relation)
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
}): string {
  const actionIRI = d.encrypted ? 'cg:canDecrypt' : 'cg:canFetchPayload';
  const returnsClass = d.encrypted ? 'cg:EncryptedGraphEnvelope' : 'cg:GraphPayload';
  const lines: string[] = [
    '# ── Affordance (cg:Affordance, cgh:Affordance, dcat:Distribution, hydra:Operation) ──',
    `<> cg:affordance [`,
    `    a cg:Affordance, cgh:Affordance, hydra:Operation, dcat:Distribution ;`,
    `    cg:action ${actionIRI} ;`,
    `    hydra:method "GET" ;`,
    `    hydra:target <${d.graphUrl}> ;`,
    `    hydra:returns ${returnsClass} ;`,
    `    hydra:title "${d.encrypted ? 'Fetch encrypted graph envelope' : 'Fetch graph payload'}" ;`,
    `    dcat:accessURL <${d.graphUrl}> ;`,
    `    dcat:mediaType "${d.graphContentType}" ;`,
    `    cg:encrypted ${d.encrypted ? 'true' : 'false'}`,
  ];
  if (d.encrypted && d.encryptionAlgorithm) {
    lines.push(`    ; cg:encryptionAlgorithm "${d.encryptionAlgorithm}"`);
  }
  if (d.encrypted && typeof d.recipientCount === 'number') {
    lines.push(`    ; cg:recipientCount ${d.recipientCount}`);
  }
  lines.push(`] .`);
  return lines.join('\n');
}

export interface DistributionLink {
  readonly accessURL: string;
  readonly mediaType: string;
  readonly encrypted: boolean;
  readonly encryptionAlgorithm?: string;
}

/**
 * Parse a descriptor's affordance block and return the graph payload's
 * accessURL + media type + encryption status. Matches the canonical
 * `cg:affordance [...]` form plus a legacy `cg:hasDistribution [...]`
 * form (preserved for descriptors written before the ontology
 * realignment). Returns null when no linkage is declared.
 */
export function parseDistributionFromDescriptorTurtle(turtle: string): DistributionLink | null {
  // Canonical form: cg:affordance [ ... a dcat:Distribution ... ]
  // Legacy form:    cg:hasDistribution [ ... a dcat:Distribution ... ]
  // Try canonical first; fall back to legacy.
  let match = turtle.match(/cg:affordance\s*\[([\s\S]*?)\]/);
  if (!match) match = turtle.match(/cg:hasDistribution\s*\[([\s\S]*?)\]/);
  if (!match) return null;
  const block = match[1]!;
  // Prefer hydra:target over dcat:accessURL (they're synonymous in our
  // emission, but hydra:target is the operation-centric view for
  // dispatch; dcat:accessURL is the catalog-centric view. Either works).
  const accessUrlMatch = block.match(/hydra:target\s+<([^>]+)>/) || block.match(/dcat:accessURL\s+<([^>]+)>/);
  const mediaTypeMatch = block.match(/dcat:mediaType\s+"([^"]+)"/);
  const encryptedMatch = block.match(/cg:encrypted\s+(true|false)/);
  const algoMatch = block.match(/cg:encryptionAlgorithm\s+"([^"]+)"/);
  if (!accessUrlMatch || !mediaTypeMatch) return null;
  const result: DistributionLink = {
    accessURL: accessUrlMatch[1]!,
    mediaType: mediaTypeMatch[1]!,
    encrypted: encryptedMatch?.[1] === 'true',
  };
  if (algoMatch) (result as { encryptionAlgorithm?: string }).encryptionAlgorithm = algoMatch[1];
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
  const r = await fetchFn(graphUrl, { headers: { 'Accept': `${ENVELOPE_CONTENT_TYPE}, ${TRIG_CONTENT_TYPE}, ${TURTLE_CONTENT_TYPE}` } });
  if (!r.ok) throw new Error(`Failed to GET ${graphUrl}: ${r.status} ${r.statusText}`);
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

  const response = await fetchFn(manifestUrl, {
    method: 'GET',
    headers: { 'Accept': TURTLE_CONTENT_TYPE },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return [];
    }
    throw new Error(
      `Failed to fetch manifest from ${manifestUrl}: ${response.status} ${response.statusText}`,
    );
  }

  const turtle = await response.text();
  const entries = parseManifest(turtle);

  if (!filter) return entries;

  return entries.filter(entry => matchesFilter(entry, filter));
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
  const headResponse = await fetchFn(pod, {
    method: 'HEAD',
  });

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
  const descResponse = await fetchFn(storageDescUrl, {
    method: 'GET',
    headers: { 'Accept': 'text/turtle' },
  });

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
  const subResponse = await fetchFn(subscriptionEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ld+json' },
    body: JSON.stringify({
      '@context': ['https://www.w3.org/ns/solid/notification/v1'],
      type: 'http://www.w3.org/ns/solid/notifications#WebSocketChannel2023',
      topic,
    }),
  });

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
  const ws = new WS(wsUrl);

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
 * Verify that an agent is authorized to act on a pod by checking the
 * pod's agent registry.
 *
 * @param agentId - The agent claiming delegation
 * @param podUrl - The pod URL being acted on
 * @param options - Optional configuration
 * @returns Verification result
 */
export async function verifyAgentDelegation(
  agentId: IRI,
  podUrl: string,
  options: RegistryOptions = {},
): Promise<DelegationVerification> {
  return verifyDelegation(
    agentId,
    podUrl,
    async (url: string) => readAgentRegistry(url, options),
  );
}
