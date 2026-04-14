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
  const trigDocument = wrapAsTriG(descriptorTurtle, graphContent, primaryGraph);

  // 1. PUT the TriG document
  const graphUrl = `${container}${graphSlug}.trig`;
  const graphResponse = await fetchFn(graphUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': TRIG_CONTENT_TYPE,
      'If-None-Match': '*',
    },
    body: trigDocument,
  });
  if (!graphResponse.ok && graphResponse.status !== 412) {
    throw new Error(
      `Failed to write graph to ${graphUrl}: ${graphResponse.status} ${graphResponse.statusText}`,
    );
  }

  // 2. PUT the descriptor as standalone Turtle
  const descriptorUrl = `${container}${slug}.ttl`;
  const descResponse = await fetchFn(descriptorUrl, {
    method: 'PUT',
    headers: { 'Content-Type': TURTLE_CONTENT_TYPE },
    body: descriptorTurtle,
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
    manifestBody = `${turtlePrefixes(['cg', 'xsd', 'hydra', 'dcat', 'dprod'])}\n\n${manifestHeaderTurtle(pod)}\n\n${newEntry}\n`;
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

  return { descriptorUrl, graphUrl, manifestUrl, pgslUri, pgslLevel };
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
