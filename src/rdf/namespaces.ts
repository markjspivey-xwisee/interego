/**
 * @module rdf/namespaces
 * @description Namespace IRIs and prefix bindings for Context Graphs 1.0
 *
 * Reuses: RDF 1.2, RDFS 1.2, XSD, OWL 2, PROV-O, OWL-Time,
 *         Dublin Core Terms, Activity Streams 2.0, SHACL, WAC,
 *         Verifiable Credentials 2.0, DID Core, DCAT 3, LDP,
 *         Solid Terms, Web Annotation
 */

// ── Namespace IRIs ───────────────────────────────────────────

export const CG   = 'https://ns.foxximediums.com/context-graphs#' as const;
export const RDF  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' as const;
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#' as const;
export const XSD  = 'http://www.w3.org/2001/XMLSchema#' as const;
export const OWL  = 'http://www.w3.org/2002/07/owl#' as const;
export const PROV = 'http://www.w3.org/ns/prov#' as const;
export const TIME = 'http://www.w3.org/2006/time#' as const;
export const DCT  = 'http://purl.org/dc/terms/' as const;
export const AS   = 'https://www.w3.org/ns/activitystreams#' as const;
export const SHACL = 'http://www.w3.org/ns/shacl#' as const;
export const ACL  = 'http://www.w3.org/ns/auth/acl#' as const;
export const VC   = 'https://www.w3.org/2018/credentials#' as const;
export const DID  = 'https://www.w3.org/ns/did#' as const;
export const DCAT = 'http://www.w3.org/ns/dcat#' as const;
export const LDP  = 'http://www.w3.org/ns/ldp#' as const;
export const SOLID = 'http://www.w3.org/ns/solid/terms#' as const;
export const OA   = 'http://www.w3.org/ns/oa#' as const;
export const HYDRA = 'http://www.w3.org/ns/hydra/core#' as const;
export const DPROD = 'https://dprod.org/ns/dprod#' as const;
export const FOAF = 'http://xmlns.com/foaf/0.1/' as const;

// ── Prefix Map ───────────────────────────────────────────────

export const PREFIXES = {
  cg:    CG,
  rdf:   RDF,
  rdfs:  RDFS,
  xsd:   XSD,
  owl:   OWL,
  prov:  PROV,
  time:  TIME,
  dct:   DCT,
  as:    AS,
  sh:    SHACL,
  acl:   ACL,
  vc:    VC,
  did:   DID,
  dcat:  DCAT,
  ldp:   LDP,
  solid: SOLID,
  oa:    OA,
  hydra: HYDRA,
  dprod: DPROD,
  foaf:  FOAF,
} as const;

export type PrefixKey = keyof typeof PREFIXES;

// ── Context Graphs Named Terms ───────────────────────────────

/** All CG-namespaced class IRIs */
export const CGClass = {
  ContextDescriptor:   `${CG}ContextDescriptor`,
  ComposedDescriptor:  `${CG}ComposedDescriptor`,
  ContextFacet:        `${CG}ContextFacet`,
  TemporalFacet:       `${CG}TemporalFacet`,
  ProvenanceFacet:     `${CG}ProvenanceFacet`,
  AgentFacet:          `${CG}AgentFacet`,
  AccessControlFacet:  `${CG}AccessControlFacet`,
  SemioticFacet:       `${CG}SemioticFacet`,
  TrustFacet:          `${CG}TrustFacet`,
  FederationFacet:     `${CG}FederationFacet`,
  ContextType:         `${CG}ContextType`,
  CompositionOperator: `${CG}CompositionOperator`,
  PodDirectory:        `${CG}PodDirectory`,
  DataProduct:         `${CG}DataProduct`,
  Affordance:          `${CG}Affordance`,
} as const;

/** All CG-namespaced property IRIs */
export const CGProp = {
  describes:            `${CG}describes`,
  hasFacet:             `${CG}hasFacet`,
  facetType:            `${CG}facetType`,
  compositionOp:        `${CG}compositionOp`,
  operand:              `${CG}operand`,
  restrictToType:       `${CG}restrictToType`,
  supersedes:           `${CG}supersedes`,
  version:              `${CG}version`,
  validFrom:            `${CG}validFrom`,
  validUntil:           `${CG}validUntil`,
  temporalResolution:   `${CG}temporalResolution`,
  temporalRelation:     `${CG}temporalRelation`,
  provenanceChain:      `${CG}provenanceChain`,
  assertingAgent:       `${CG}assertingAgent`,
  onBehalfOf:           `${CG}onBehalfOf`,
  agentRole:            `${CG}agentRole`,
  agentIdentity:        `${CG}agentIdentity`,
  authorization:        `${CG}authorization`,
  consentBasis:         `${CG}consentBasis`,
  interpretationFrame:  `${CG}interpretationFrame`,
  signSystem:           `${CG}signSystem`,
  groundTruth:          `${CG}groundTruth`,
  modalStatus:          `${CG}modalStatus`,
  epistemicConfidence:  `${CG}epistemicConfidence`,
  languageTag:          `${CG}languageTag`,
  verifiableCredential: `${CG}verifiableCredential`,
  issuer:               `${CG}issuer`,
  proofMechanism:       `${CG}proofMechanism`,
  trustLevel:           `${CG}trustLevel`,
  revocationStatus:     `${CG}revocationStatus`,
  origin:               `${CG}origin`,
  storageEndpoint:      `${CG}storageEndpoint`,
  syncProtocol:         `${CG}syncProtocol`,
  replicaOf:            `${CG}replicaOf`,
  lastSynced:           `${CG}lastSynced`,
  hasPod:               `${CG}hasPod`,
  podUrl:               `${CG}podUrl`,
  // Affordance & DPROD alignment
  affordance:           `${CG}affordance`,
  canPublish:           `${CG}canPublish`,
  canDiscover:          `${CG}canDiscover`,
  canSubscribe:         `${CG}canSubscribe`,
  dataProduct:          `${CG}dataProduct`,
  outputPort:           `${CG}outputPort`,
  inputPort:            `${CG}inputPort`,
} as const;

/** Named individuals: Context Types */
export const CGContextType = {
  Temporal:       `${CG}Temporal`,
  Provenance:     `${CG}Provenance`,
  Agent:          `${CG}Agent`,
  AccessControl:  `${CG}AccessControl`,
  Semiotic:       `${CG}Semiotic`,
  Trust:          `${CG}Trust`,
  Federation:     `${CG}Federation`,
} as const;

/** Named individuals: Composition Operators */
export const CGCompositionOp = {
  union:        `${CG}union`,
  intersection: `${CG}intersection`,
  restriction:  `${CG}restriction`,
  override:     `${CG}override`,
} as const;

/** Named individuals: Modal Status (Semiotic Facet) */
export const CGModalStatus = {
  Asserted:       `${CG}Asserted`,
  Hypothetical:   `${CG}Hypothetical`,
  Counterfactual: `${CG}Counterfactual`,
  Quoted:         `${CG}Quoted`,
  Retracted:      `${CG}Retracted`,
} as const;

/** Named individuals: Trust Level */
export const CGTrustLevel = {
  SelfAsserted:              `${CG}SelfAsserted`,
  ThirdPartyAttested:        `${CG}ThirdPartyAttested`,
  CryptographicallyVerified: `${CG}CryptographicallyVerified`,
} as const;

/** Named individuals: Agent Roles */
export const CGAgentRole = {
  Author:    `${CG}Author`,
  Curator:   `${CG}Curator`,
  Validator: `${CG}Validator`,
} as const;

/** Named individuals: Sync Protocols (Federation Facet) */
export const CGSyncProtocol = {
  SolidNotifications:        `${CG}SolidNotifications`,
  WebSub:                    `${CG}WebSub`,
  LinkedDataNotifications:   `${CG}LinkedDataNotifications`,
  Polling:                   `${CG}Polling`,
} as const;

// ── Utility: compact / expand ────────────────────────────────

/**
 * Expand a prefixed name to a full IRI.
 * @example expand('cg:ContextDescriptor') → 'https://ns.foxximediums.com/context-graphs#ContextDescriptor'
 */
export function expand(prefixed: string): string {
  const colon = prefixed.indexOf(':');
  if (colon === -1) return prefixed;
  const prefix = prefixed.slice(0, colon) as PrefixKey;
  const ns = PREFIXES[prefix];
  if (!ns) return prefixed;
  return `${ns}${prefixed.slice(colon + 1)}`;
}

/**
 * Compact a full IRI to prefixed form, or return as-is if no prefix matches.
 * @example compact('http://www.w3.org/ns/prov#Entity') → 'prov:Entity'
 */
export function compact(iri: string): string {
  for (const [prefix, ns] of Object.entries(PREFIXES)) {
    if (iri.startsWith(ns)) {
      return `${prefix}:${iri.slice(ns.length)}`;
    }
  }
  return iri;
}

/**
 * Generate a Turtle prefix block for all registered prefixes.
 */
export function turtlePrefixes(include?: PrefixKey[]): string {
  const entries = include
    ? Object.entries(PREFIXES).filter(([k]) => include.includes(k as PrefixKey))
    : Object.entries(PREFIXES);
  return entries
    .map(([prefix, ns]) => `@prefix ${prefix}: <${ns}> .`)
    .join('\n');
}

/**
 * Generate a SPARQL PREFIX block.
 */
export function sparqlPrefixes(include?: PrefixKey[]): string {
  const entries = include
    ? Object.entries(PREFIXES).filter(([k]) => include.includes(k as PrefixKey))
    : Object.entries(PREFIXES);
  return entries
    .map(([prefix, ns]) => `PREFIX ${prefix}: <${ns}>`)
    .join('\n');
}
