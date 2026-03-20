/**
 * @module sparql/patterns
 * @description SPARQL 1.2 query pattern builders for Context Graphs
 *
 * Generates parameterized SPARQL queries for the common access
 * patterns defined in §8 of the specification.
 *
 * Reuses: SPARQL 1.2 Query Language [WD]
 */

import { sparqlPrefixes, type PrefixKey } from '../rdf/namespaces.js';
import type { ContextTypeName, ModalStatus, TrustLevel } from '../model/types.js';

// ── Default prefixes for CG queries ──────────────────────────

const CG_PREFIXES: PrefixKey[] = ['cg', 'prov', 'xsd', 'rdfs', 'rdf'];

function prefixBlock(extra?: PrefixKey[]): string {
  const all = new Set([...CG_PREFIXES, ...(extra ?? [])]);
  return sparqlPrefixes([...all]);
}

// ── Query: Retrieve all context for a Named Graph (§8.1) ────

/**
 * Generate a SPARQL query that retrieves all Context Descriptor
 * facets for a given Named Graph IRI.
 */
export function queryContextForGraph(graphIRI: string): string {
  return `${prefixBlock()}

SELECT ?descriptor ?facetType ?validFrom ?validUntil ?agent ?modalStatus
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes <${graphIRI}> ;
        cg:hasFacet ?facet .

    ?facet a ?facetType .

    OPTIONAL { ?facet cg:validFrom ?validFrom }
    OPTIONAL { ?facet cg:validUntil ?validUntil }
    OPTIONAL {
        ?facet cg:assertingAgent ?agentNode .
        ?agentNode cg:agentIdentity ?agent .
    }
    OPTIONAL { ?facet cg:modalStatus ?modalStatus }
}`;
}

// ── Query: Filter graphs by temporal window (§8.2) ──────────

/**
 * Generate a SPARQL query that finds all Named Graphs whose
 * Temporal Facet includes a given point in time.
 */
export function queryGraphsAtTime(dateTime: string): string {
  return `${prefixBlock()}

SELECT ?graph ?descriptor
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes ?graph ;
        cg:hasFacet ?tf .

    ?tf a cg:TemporalFacet ;
        cg:validFrom ?from ;
        cg:validUntil ?until .

    FILTER (?from <= "${dateTime}"^^xsd:dateTime
         && ?until >= "${dateTime}"^^xsd:dateTime)
}`;
}

/**
 * Find graphs whose temporal window overlaps a given interval.
 */
export function queryGraphsInInterval(from: string, until: string): string {
  return `${prefixBlock()}

SELECT ?graph ?descriptor ?from ?until
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes ?graph ;
        cg:hasFacet ?tf .

    ?tf a cg:TemporalFacet ;
        cg:validFrom ?from ;
        cg:validUntil ?until .

    FILTER (?from <= "${until}"^^xsd:dateTime
         && ?until >= "${from}"^^xsd:dateTime)
}
ORDER BY ?from`;
}

// ── Query: Filter by modal status (§8.3) ────────────────────

/**
 * Find all graphs with a given semiotic modal status.
 */
export function queryGraphsByModalStatus(status: ModalStatus): string {
  return `${prefixBlock()}

SELECT ?graph ?descriptor ?confidence
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes ?graph ;
        cg:hasFacet ?sf .

    ?sf a cg:SemioticFacet ;
        cg:modalStatus cg:${status} .

    OPTIONAL { ?sf cg:epistemicConfidence ?confidence }
}
ORDER BY DESC(?confidence)`;
}

// ── Query: Filter by facet type ──────────────────────────────

/**
 * Find all graphs that have a context descriptor containing
 * a specific facet type.
 */
export function queryGraphsByFacetType(facetType: ContextTypeName): string {
  return `${prefixBlock()}

SELECT ?graph ?descriptor ?facet
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes ?graph ;
        cg:hasFacet ?facet .

    ?facet a cg:${facetType}Facet .
}`;
}

// ── Query: Provenance chain ──────────────────────────────────

/**
 * Retrieve the full provenance chain for a Named Graph.
 */
export function queryProvenanceChain(graphIRI: string): string {
  return `${prefixBlock()}

SELECT ?descriptor ?activity ?agent ?startedAt ?endedAt ?source
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes <${graphIRI}> ;
        cg:hasFacet ?pf .

    ?pf a cg:ProvenanceFacet .

    OPTIONAL {
        ?pf prov:wasGeneratedBy ?activity .
        OPTIONAL { ?activity prov:wasAssociatedWith ?agent }
        OPTIONAL { ?activity prov:startedAtTime ?startedAt }
        OPTIONAL { ?activity prov:endedAtTime ?endedAt }
    }
    OPTIONAL { ?pf prov:wasDerivedFrom ?source }
}
ORDER BY DESC(?endedAt)`;
}

// ── Query: Trust level filter ────────────────────────────────

/**
 * Find graphs at or above a given trust level.
 */
export function queryGraphsByTrustLevel(minLevel: TrustLevel): string {
  // Map trust levels to numeric scores for comparison
  const levelMap: Record<TrustLevel, number> = {
    SelfAsserted: 1,
    ThirdPartyAttested: 2,
    CryptographicallyVerified: 3,
  };
  const minScore = levelMap[minLevel];

  return `${prefixBlock()}

SELECT ?graph ?descriptor ?trustLevel ?issuer
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes ?graph ;
        cg:hasFacet ?tf .

    ?tf a cg:TrustFacet ;
        cg:trustLevel ?trustLevel .

    OPTIONAL { ?tf cg:issuer ?issuer }

    # Filter by trust level (semantic ordering)
    VALUES (?trustLevel ?score) {
        (cg:SelfAsserted 1)
        (cg:ThirdPartyAttested 2)
        (cg:CryptographicallyVerified 3)
    }
    FILTER (?score >= ${minScore})
}
ORDER BY DESC(?score)`;
}

// ── Query: Federation origin ─────────────────────────────────

/**
 * Find all graphs originating from a specific Solid pod or endpoint.
 */
export function queryGraphsByOrigin(originIRI: string): string {
  return `${prefixBlock(['dcat'])}

SELECT ?graph ?descriptor ?lastSynced ?syncProtocol
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes ?graph ;
        cg:hasFacet ?ff .

    ?ff a cg:FederationFacet ;
        cg:origin <${originIRI}> .

    OPTIONAL { ?ff cg:lastSynced ?lastSynced }
    OPTIONAL { ?ff cg:syncProtocol ?syncProtocol }
}
ORDER BY DESC(?lastSynced)`;
}

// ── Query: Full context manifest ─────────────────────────────

/**
 * Retrieve the complete context manifest for an RDF Dataset.
 */
export function queryContextManifest(): string {
  return `${prefixBlock()}

SELECT ?descriptor ?graph ?facetType ?version
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes ?graph ;
        cg:hasFacet ?facet .

    ?facet a ?facetType .
    FILTER (STRSTARTS(STR(?facetType), STR(cg:)))

    OPTIONAL { ?descriptor cg:version ?version }
}
ORDER BY ?graph ?descriptor`;
}

// ── ASK: Does a graph have a specific context type? ──────────

/**
 * ASK query to check if a graph has a context descriptor
 * containing a specific facet type.
 */
export function askHasContextType(
  graphIRI: string,
  facetType: ContextTypeName
): string {
  return `${prefixBlock()}

ASK {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes <${graphIRI}> ;
        cg:hasFacet ?facet .

    ?facet a cg:${facetType}Facet .
}`;
}

/**
 * CONSTRUCT a complete Context Descriptor graph for a Named Graph.
 */
export function constructContextForGraph(graphIRI: string): string {
  return `${prefixBlock()}

CONSTRUCT {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes <${graphIRI}> ;
        cg:version ?version ;
        cg:validFrom ?dFrom ;
        cg:validUntil ?dUntil ;
        cg:hasFacet ?facet .

    ?facet a ?facetType ;
        ?facetProp ?facetVal .
}
WHERE {
    ?descriptor a cg:ContextDescriptor ;
        cg:describes <${graphIRI}> ;
        cg:hasFacet ?facet .

    ?facet a ?facetType ;
        ?facetProp ?facetVal .

    OPTIONAL { ?descriptor cg:version ?version }
    OPTIONAL { ?descriptor cg:validFrom ?dFrom }
    OPTIONAL { ?descriptor cg:validUntil ?dUntil }
}`;
}
