/**
 * @module rdf/system-ontology
 * @description Full Context Graphs system as an OWL ontology with SHACL shapes,
 * Hydra API description, and DCAT/DPROD catalog generation.
 *
 * Extends the PGSL-layer ontology (pgsl/rdf.ts) to cover every concept in the
 * system: context descriptors, facets, coherence, paradigms, persistence,
 * decisions, Hydra operations, DCAT federation, and PROV-O alignment.
 */

import { PGSL_NS } from '../pgsl/rdf.js';
import {
  RDF, RDFS, XSD, OWL, PROV, SHACL, ACL, DCAT, HYDRA, DPROD, FOAF, DCT,
} from './namespaces.js';

// ── Namespace Constants ─────────────────────────────────────

export const CG_NS    = 'https://markjspivey-xwisee.github.io/context-graphs/ns/cg#' as const;
export const WAC_NS   = ACL;
export const HYDRA_NS = HYDRA;
export const DCAT_NS  = DCAT;
export const DPROD_NS = DPROD;
export const PROV_NS  = PROV;
export const SHACL_NS = SHACL;
export const OWL_NS   = OWL;
export const RDFS_NS  = RDFS;
export const RDF_NS   = RDF;
export const XSD_NS   = XSD;
export const DCT_NS   = DCT;
export const FOAF_NS  = FOAF;

// ── Prefix Block ────────────────────────────────────────────

/**
 * Returns all namespace prefixes used across the system as Turtle declarations.
 */
export function allPrefixes(): string {
  return [
    `@prefix cg: <${CG_NS}> .`,
    `@prefix pgsl: <${PGSL_NS}> .`,
    `@prefix hydra: <${HYDRA_NS}> .`,
    `@prefix dcat: <${DCAT_NS}> .`,
    `@prefix dprod: <${DPROD_NS}> .`,
    `@prefix prov: <${PROV_NS}> .`,
    `@prefix sh: <${SHACL_NS}> .`,
    `@prefix owl: <${OWL_NS}> .`,
    `@prefix rdfs: <${RDFS_NS}> .`,
    `@prefix rdf: <${RDF_NS}> .`,
    `@prefix xsd: <${XSD_NS}> .`,
    `@prefix dcterms: <${DCT_NS}> .`,
    `@prefix foaf: <${FOAF_NS}> .`,
    `@prefix wac: <${WAC_NS}> .`,
  ].join('\n');
}

// ── OWL Ontology ────────────────────────────────────────────

/**
 * Returns the complete Context Graphs OWL ontology as Turtle,
 * covering every concept in the system.
 */
export function systemOntology(): string {
  return `${allPrefixes()}

# ════════════════════════════════════════════════════════════
# Context Graphs System Ontology
# ════════════════════════════════════════════════════════════

<${CG_NS}> a owl:Ontology ;
    rdfs:label "Context Graphs System Ontology" ;
    rdfs:comment "Complete OWL ontology for Context Graphs 1.0 — composable, verifiable, federated context infrastructure." ;
    owl:versionInfo "1.0.0" ;
    owl:imports <${PGSL_NS}> .

# ── PROV-O Alignment ────────────────────────────────────────

pgsl:Atom rdfs:subClassOf prov:Entity .
pgsl:Fragment rdfs:subClassOf prov:Entity .
cg:ContextDescriptor rdfs:subClassOf prov:Entity .

# ── Transitive / Inverse Properties (PGSL) ──────────────────

pgsl:contains a owl:TransitiveProperty ;
    owl:inverseOf pgsl:containedIn .

pgsl:containedIn a owl:ObjectProperty ;
    rdfs:domain pgsl:Node ;
    rdfs:range pgsl:Fragment ;
    rdfs:label "contained in" ;
    rdfs:comment "Inverse of pgsl:contains." .

cg:describes owl:inverseOf cg:describedBy .

cg:describedBy a owl:ObjectProperty ;
    rdfs:label "described by" ;
    rdfs:comment "Inverse of cg:describes — links a named graph to its descriptor." .

# ── CG Classes: Core Descriptor ─────────────────────────────

cg:ContextDescriptor a owl:Class ;
    rdfs:label "Context Descriptor" ;
    rdfs:comment "The core metadata envelope that describes a named graph with typed facets." .

cg:ComposedDescriptor a owl:Class ;
    rdfs:subClassOf cg:ContextDescriptor ;
    rdfs:label "Composed Descriptor" ;
    rdfs:comment "A descriptor produced by algebraic composition of source descriptors." .

# ── CG Classes: Facet Hierarchy ──────────────────────────────

cg:ContextFacet a owl:Class ;
    rdfs:label "Context Facet" ;
    rdfs:comment "Abstract base for all typed facets attached to a context descriptor." .

cg:TemporalFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:ProvenanceFacet, cg:AgentFacet, cg:AccessControlFacet,
        cg:SemioticFacet, cg:TrustFacet, cg:FederationFacet, cg:CausalFacet, cg:ProjectionFacet ;
    rdfs:label "Temporal Facet" ;
    rdfs:comment "Time-bounded validity window for context." .

cg:ProvenanceFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:AgentFacet, cg:AccessControlFacet, cg:SemioticFacet,
        cg:TrustFacet, cg:FederationFacet, cg:CausalFacet, cg:ProjectionFacet ;
    rdfs:label "Provenance Facet" ;
    rdfs:comment "Origin and derivation chain of the context." .

cg:AgentFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:AccessControlFacet, cg:SemioticFacet, cg:TrustFacet,
        cg:FederationFacet, cg:CausalFacet, cg:ProjectionFacet ;
    rdfs:label "Agent Facet" ;
    rdfs:comment "The asserting agent, role, and delegation chain." .

cg:AccessControlFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:SemioticFacet, cg:TrustFacet, cg:FederationFacet,
        cg:CausalFacet, cg:ProjectionFacet ;
    rdfs:label "Access Control Facet" ;
    rdfs:comment "WAC-based authorization and consent." .

cg:SemioticFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:TrustFacet, cg:FederationFacet, cg:CausalFacet, cg:ProjectionFacet ;
    rdfs:label "Semiotic Facet" ;
    rdfs:comment "Interpretation frame, modal status, and epistemic confidence." .

cg:TrustFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:FederationFacet, cg:CausalFacet, cg:ProjectionFacet ;
    rdfs:label "Trust Facet" ;
    rdfs:comment "Verifiable credentials, trust level, and revocation status." .

cg:FederationFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:CausalFacet, cg:ProjectionFacet ;
    rdfs:label "Federation Facet" ;
    rdfs:comment "Origin pod, storage endpoint, and sync protocol." .

cg:CausalFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    owl:disjointWith cg:ProjectionFacet ;
    rdfs:label "Causal Facet" ;
    rdfs:comment "Pearl-style structural causal model attachment." .

cg:ProjectionFacet a owl:Class ;
    rdfs:subClassOf cg:ContextFacet ;
    rdfs:label "Projection Facet" ;
    rdfs:comment "Vocabulary mapping and selective exposure for cross-boundary sharing." .

# ── CG Properties ────────────────────────────────────────────

cg:describes a owl:ObjectProperty ;
    rdfs:domain cg:ContextDescriptor ;
    rdfs:label "describes" ;
    rdfs:comment "Links a descriptor to the named graph it describes." .

cg:hasFacet a owl:ObjectProperty ;
    rdfs:domain cg:ContextDescriptor ;
    rdfs:range cg:ContextFacet ;
    rdfs:label "has facet" ;
    rdfs:comment "Links a descriptor to one of its typed facets." .

cg:validFrom a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:domain cg:TemporalFacet ;
    rdfs:range xsd:dateTime ;
    rdfs:label "valid from" ;
    rdfs:comment "Start of the temporal validity window." .

cg:validUntil a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:domain cg:TemporalFacet ;
    rdfs:range xsd:dateTime ;
    rdfs:label "valid until" ;
    rdfs:comment "End of the temporal validity window (open-ended if absent)." .

cg:trustLevel a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain cg:TrustFacet ;
    rdfs:range cg:TrustLevelEnum ;
    rdfs:label "trust level" ;
    rdfs:comment "Verification tier: SelfAsserted, ThirdPartyAttested, or CryptographicallyVerified." .

cg:TrustLevelEnum a owl:Class ;
    owl:oneOf ( cg:SelfAsserted cg:ThirdPartyAttested cg:CryptographicallyVerified ) ;
    rdfs:label "Trust Level Enumeration" .

cg:SelfAsserted a owl:NamedIndividual, cg:TrustLevelEnum ;
    rdfs:label "Self-Asserted" .
cg:ThirdPartyAttested a owl:NamedIndividual, cg:TrustLevelEnum ;
    rdfs:label "Third-Party Attested" .
cg:CryptographicallyVerified a owl:NamedIndividual, cg:TrustLevelEnum ;
    rdfs:label "Cryptographically Verified" .

cg:modalStatus a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain cg:SemioticFacet ;
    rdfs:range cg:ModalStatusEnum ;
    rdfs:label "modal status" ;
    rdfs:comment "Epistemic modality of the assertion." .

cg:ModalStatusEnum a owl:Class ;
    owl:oneOf ( cg:Asserted cg:Hypothetical cg:Counterfactual cg:Quoted cg:Retracted ) ;
    rdfs:label "Modal Status Enumeration" .

cg:Asserted a owl:NamedIndividual, cg:ModalStatusEnum ;
    rdfs:label "Asserted" .
cg:Hypothetical a owl:NamedIndividual, cg:ModalStatusEnum ;
    rdfs:label "Hypothetical" .
cg:Counterfactual a owl:NamedIndividual, cg:ModalStatusEnum ;
    rdfs:label "Counterfactual" .
cg:Quoted a owl:NamedIndividual, cg:ModalStatusEnum ;
    rdfs:label "Quoted" .
cg:Retracted a owl:NamedIndividual, cg:ModalStatusEnum ;
    rdfs:label "Retracted" .

cg:epistemicConfidence a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:domain cg:SemioticFacet ;
    rdfs:range xsd:decimal ;
    rdfs:label "epistemic confidence" ;
    rdfs:comment "Confidence level between 0.0 and 1.0." .

cg:wasAttributedTo a owl:ObjectProperty ;
    rdfs:domain cg:ProvenanceFacet ;
    rdfs:label "was attributed to" ;
    rdfs:comment "The agent responsible for this context." .

cg:composedFrom a owl:ObjectProperty ;
    rdfs:domain cg:ComposedDescriptor ;
    rdfs:range cg:ContextDescriptor ;
    rdfs:label "composed from" ;
    rdfs:comment "Links a composed descriptor to its source descriptors." .

cg:compositionOperator a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain cg:ComposedDescriptor ;
    rdfs:range cg:CompositionOperatorEnum ;
    rdfs:label "composition operator" ;
    rdfs:comment "The algebraic operator used: union, intersection, restriction, or override." .

cg:CompositionOperatorEnum a owl:Class ;
    owl:oneOf ( cg:union cg:intersection cg:restriction cg:override ) ;
    rdfs:label "Composition Operator Enumeration" .

cg:union a owl:NamedIndividual, cg:CompositionOperatorEnum ;
    rdfs:label "Union" .
cg:intersection a owl:NamedIndividual, cg:CompositionOperatorEnum ;
    rdfs:label "Intersection" .
cg:restriction a owl:NamedIndividual, cg:CompositionOperatorEnum ;
    rdfs:label "Restriction" .
cg:override a owl:NamedIndividual, cg:CompositionOperatorEnum ;
    rdfs:label "Override" .

# ── Coherence Classes ────────────────────────────────────────

cg:CoherenceCertificate a owl:Class ;
    rdfs:label "Coherence Certificate" ;
    rdfs:comment "Result of a coherence verification between two agents' views." .

cg:CoherenceStatus a owl:Class ;
    owl:oneOf ( cg:Verified cg:Divergent cg:Unexamined ) ;
    rdfs:label "Coherence Status" .

cg:Verified a owl:NamedIndividual, cg:CoherenceStatus ;
    rdfs:label "Verified" .
cg:Divergent a owl:NamedIndividual, cg:CoherenceStatus ;
    rdfs:label "Divergent" .
cg:Unexamined a owl:NamedIndividual, cg:CoherenceStatus ;
    rdfs:label "Unexamined" .

cg:AtomCoherence a owl:Class ;
    rdfs:label "Atom Coherence" ;
    rdfs:comment "Per-atom usage analysis within a coherence check." .

cg:CoherenceObstruction a owl:Class ;
    rdfs:label "Coherence Obstruction" ;
    rdfs:comment "A specific divergence point between two agents' interpretations." .

cg:agentA a owl:ObjectProperty ;
    rdfs:domain cg:CoherenceCertificate ;
    rdfs:label "agent A" .

cg:agentB a owl:ObjectProperty ;
    rdfs:domain cg:CoherenceCertificate ;
    rdfs:label "agent B" .

cg:coherenceStatus a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain cg:CoherenceCertificate ;
    rdfs:range cg:CoherenceStatus ;
    rdfs:label "coherence status" .

cg:hasObstruction a owl:ObjectProperty ;
    rdfs:domain cg:CoherenceCertificate ;
    rdfs:range cg:CoherenceObstruction ;
    rdfs:label "has obstruction" .

cg:obstructionAtom a owl:ObjectProperty ;
    rdfs:domain cg:CoherenceObstruction ;
    rdfs:range pgsl:Atom ;
    rdfs:label "obstruction atom" .

# ── Paradigm Classes ─────────────────────────────────────────

cg:ParadigmSet a owl:Class ;
    rdfs:label "Paradigm Set" ;
    rdfs:comment "A computed set of interchangeable items at a syntagmatic position." .

cg:ParadigmConstraint a owl:Class ;
    rdfs:label "Paradigm Constraint" ;
    rdfs:comment "A rule linking two paradigm sets via an operation." .

cg:ParadigmOperation a owl:Class ;
    owl:oneOf ( cg:Subset cg:Intersect cg:Union cg:Exclude cg:Equal ) ;
    rdfs:label "Paradigm Operation" .

cg:Subset a owl:NamedIndividual, cg:ParadigmOperation ;
    rdfs:label "Subset" .
cg:Intersect a owl:NamedIndividual, cg:ParadigmOperation ;
    rdfs:label "Intersect" .
cg:Union a owl:NamedIndividual, cg:ParadigmOperation ;
    rdfs:label "Union" .
cg:Exclude a owl:NamedIndividual, cg:ParadigmOperation ;
    rdfs:label "Exclude" .
cg:Equal a owl:NamedIndividual, cg:ParadigmOperation ;
    rdfs:label "Equal" .

cg:SyntagmaticPattern a owl:Class ;
    rdfs:label "Syntagmatic Pattern" ;
    rdfs:comment "A chain pattern with wildcards for paradigm set computation." .

cg:patternA a owl:ObjectProperty ;
    rdfs:domain cg:ParadigmConstraint ;
    rdfs:range cg:SyntagmaticPattern ;
    rdfs:label "pattern A" .

cg:positionA a owl:DatatypeProperty ;
    rdfs:domain cg:ParadigmConstraint ;
    rdfs:range xsd:nonNegativeInteger ;
    rdfs:label "position A" .

cg:patternB a owl:ObjectProperty ;
    rdfs:domain cg:ParadigmConstraint ;
    rdfs:range cg:SyntagmaticPattern ;
    rdfs:label "pattern B" .

cg:positionB a owl:DatatypeProperty ;
    rdfs:domain cg:ParadigmConstraint ;
    rdfs:range xsd:nonNegativeInteger ;
    rdfs:label "position B" .

cg:paradigmOp a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain cg:ParadigmConstraint ;
    rdfs:range cg:ParadigmOperation ;
    rdfs:label "paradigm operation" .

# ── Persistence Classes ──────────────────────────────────────

cg:PersistenceRecord a owl:Class ;
    rdfs:label "Persistence Record" ;
    rdfs:comment "Tier metadata tracking where a node is stored." .

cg:PersistenceTier a owl:Class ;
    owl:oneOf ( cg:Memory cg:Local cg:Pod cg:IPFS cg:Chain ) ;
    rdfs:label "Persistence Tier" .

cg:Memory a owl:NamedIndividual, cg:PersistenceTier ;
    rdfs:label "Memory" .
cg:Local a owl:NamedIndividual, cg:PersistenceTier ;
    rdfs:label "Local" .
cg:Pod a owl:NamedIndividual, cg:PersistenceTier ;
    rdfs:label "Pod" .
cg:IPFS a owl:NamedIndividual, cg:PersistenceTier ;
    rdfs:label "IPFS" .
cg:Chain a owl:NamedIndividual, cg:PersistenceTier ;
    rdfs:label "Chain" .

cg:persistenceUri a owl:DatatypeProperty ;
    rdfs:domain cg:PersistenceRecord ;
    rdfs:range xsd:anyURI ;
    rdfs:label "persistence URI" .

cg:persistenceTier a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain cg:PersistenceRecord ;
    rdfs:range cg:PersistenceTier ;
    rdfs:label "persistence tier" .

cg:promotedAt a owl:DatatypeProperty ;
    rdfs:domain cg:PersistenceRecord ;
    rdfs:range xsd:dateTime ;
    rdfs:label "promoted at" .

# ── Decision Classes ─────────────────────────────────────────

cg:Decision a owl:Class ;
    rdfs:label "Decision" ;
    rdfs:comment "A selected affordance from a paradigm set." .

cg:DecisionStrategy a owl:Class ;
    owl:oneOf ( cg:Exploit cg:Explore cg:Delegate cg:Abstain ) ;
    rdfs:label "Decision Strategy" .

cg:Exploit a owl:NamedIndividual, cg:DecisionStrategy ;
    rdfs:label "Exploit" .
cg:Explore a owl:NamedIndividual, cg:DecisionStrategy ;
    rdfs:label "Explore" .
cg:Delegate a owl:NamedIndividual, cg:DecisionStrategy ;
    rdfs:label "Delegate" .
cg:Abstain a owl:NamedIndividual, cg:DecisionStrategy ;
    rdfs:label "Abstain" .

cg:ObservationSection a owl:Class ;
    rdfs:label "Observation Section" ;
    rdfs:comment "What an agent has seen — the observed portion of a chain." .

cg:decisionStrategy a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain cg:Decision ;
    rdfs:range cg:DecisionStrategy ;
    rdfs:label "decision strategy" .

cg:selectedAffordance a owl:ObjectProperty ;
    rdfs:domain cg:Decision ;
    rdfs:label "selected affordance" .

cg:observation a owl:ObjectProperty ;
    rdfs:domain cg:Decision ;
    rdfs:range cg:ObservationSection ;
    rdfs:label "observation" .

# ── DCAT / DPROD Alignment ───────────────────────────────────

cg:PodService a owl:Class ;
    rdfs:subClassOf dcat:DataService ;
    rdfs:label "Pod" ;
    rdfs:comment "A Solid pod exposed as a DCAT DataService." .

cg:PodCatalog a owl:Class ;
    rdfs:subClassOf dcat:Catalog ;
    rdfs:label "Pod Catalog" ;
    rdfs:comment "Federation-wide catalog of discoverable pods." .

# ── Hydra Integration (class stubs for API) ──────────────────

cg:NodeEndpoint a owl:Class, hydra:Class ;
    rdfs:label "Node Endpoint" ;
    rdfs:comment "HATEOAS-driven node resource." .

cg:ChainEndpoint a owl:Class, hydra:Class ;
    rdfs:label "Chain Endpoint" ;
    rdfs:comment "HATEOAS-driven chain resource." .

cg:NodeRepresentation a owl:Class ;
    rdfs:label "Node Representation" ;
    rdfs:comment "The JSON representation of a dereferenced node." .

cg:IngestRequest a owl:Class ;
    rdfs:label "Ingest Request" ;
    rdfs:comment "Payload for ingesting raw content." .

cg:IngestResponse a owl:Class ;
    rdfs:label "Ingest Response" ;
    rdfs:comment "Result of an ingest operation." .

cg:ComposeRequest a owl:Class ;
    rdfs:label "Compose Request" ;
    rdfs:comment "Payload for algebraic composition." .

cg:ComposeResponse a owl:Class ;
    rdfs:label "Compose Response" ;
    rdfs:comment "Result of a compose operation." .

cg:ConstraintRequest a owl:Class ;
    rdfs:label "Constraint Request" ;
    rdfs:comment "Payload for creating a paradigm constraint." .

cg:QueryRequest a owl:Class ;
    rdfs:label "Query Request" ;
    rdfs:comment "SPARQL query payload." .

cg:QueryResponse a owl:Class ;
    rdfs:label "Query Response" ;
    rdfs:comment "SPARQL query result." .

cg:CoherenceRequest a owl:Class ;
    rdfs:label "Coherence Request" ;
    rdfs:comment "Payload for a coherence check." .

cg:PodAddRequest a owl:Class ;
    rdfs:label "Pod Add Request" ;
    rdfs:comment "Payload for adding a pod to the federation." .
`;
}

// ── SHACL Shapes ────────────────────────────────────────────

/**
 * Returns SHACL shapes for validating the full Context Graphs system.
 */
export function systemShaclShapes(): string {
  return `${allPrefixes()}

# ════════════════════════════════════════════════════════════
# Context Graphs SHACL Shapes
# ════════════════════════════════════════════════════════════

# ── Context Descriptor Shape ─────────────────────────────────

cg:ContextDescriptorShape a sh:NodeShape ;
    sh:targetClass cg:ContextDescriptor ;
    sh:property [
        sh:path cg:describes ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:name "describes"
    ] ;
    sh:property [
        sh:path cg:hasFacet ;
        sh:minCount 1 ;
        sh:class cg:ContextFacet ;
        sh:name "must have at least one facet"
    ] .

# ── Temporal Facet Shape ─────────────────────────────────────

cg:TemporalFacetShape a sh:NodeShape ;
    sh:targetClass cg:TemporalFacet ;
    sh:property [
        sh:path cg:validFrom ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
        sh:name "valid from (required)"
    ] ;
    sh:property [
        sh:path cg:validUntil ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
        sh:name "valid until (optional)"
    ] .

# ── Trust Facet Shape ────────────────────────────────────────

cg:TrustFacetShape a sh:NodeShape ;
    sh:targetClass cg:TrustFacet ;
    sh:property [
        sh:path cg:trustLevel ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( cg:SelfAsserted cg:ThirdPartyAttested cg:CryptographicallyVerified ) ;
        sh:name "trust level (required, from enumeration)"
    ] .

# ── Semiotic Facet Shape ─────────────────────────────────────

cg:SemioticFacetShape a sh:NodeShape ;
    sh:targetClass cg:SemioticFacet ;
    sh:property [
        sh:path cg:modalStatus ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( cg:Asserted cg:Hypothetical cg:Counterfactual cg:Quoted cg:Retracted ) ;
        sh:name "modal status (required)"
    ] ;
    sh:property [
        sh:path cg:epistemicConfidence ;
        sh:maxCount 1 ;
        sh:datatype xsd:decimal ;
        sh:minInclusive 0 ;
        sh:maxInclusive 1 ;
        sh:name "epistemic confidence (0.0 to 1.0)"
    ] .

# ── Coherence Certificate Shape ──────────────────────────────

cg:CoherenceCertificateShape a sh:NodeShape ;
    sh:targetClass cg:CoherenceCertificate ;
    sh:property [
        sh:path cg:agentA ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:name "agent A (required)"
    ] ;
    sh:property [
        sh:path cg:agentB ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:name "agent B (required)"
    ] ;
    sh:property [
        sh:path cg:coherenceStatus ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( cg:Verified cg:Divergent cg:Unexamined ) ;
        sh:name "status (required)"
    ] .

# ── Paradigm Constraint Shape ────────────────────────────────

cg:ParadigmConstraintShape a sh:NodeShape ;
    sh:targetClass cg:ParadigmConstraint ;
    sh:property [
        sh:path cg:patternA ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class cg:SyntagmaticPattern ;
        sh:name "pattern A (required)"
    ] ;
    sh:property [
        sh:path cg:positionA ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
        sh:name "position A (required)"
    ] ;
    sh:property [
        sh:path cg:paradigmOp ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( cg:Subset cg:Intersect cg:Union cg:Exclude cg:Equal ) ;
        sh:name "operation (required)"
    ] ;
    sh:property [
        sh:path cg:patternB ;
        sh:maxCount 1 ;
        sh:class cg:SyntagmaticPattern ;
        sh:name "pattern B (optional — omitted for unary constraints)"
    ] ;
    sh:property [
        sh:path cg:positionB ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
        sh:name "position B (optional)"
    ] .

# ── Persistence Record Shape ─────────────────────────────────

cg:PersistenceRecordShape a sh:NodeShape ;
    sh:targetClass cg:PersistenceRecord ;
    sh:property [
        sh:path cg:persistenceUri ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:anyURI ;
        sh:name "URI (required)"
    ] ;
    sh:property [
        sh:path cg:persistenceTier ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( cg:Memory cg:Local cg:Pod cg:IPFS cg:Chain ) ;
        sh:name "tier (required)"
    ] ;
    sh:property [
        sh:path cg:promotedAt ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
        sh:name "promoted at (required)"
    ] .
`;
}

// ── Hydra API Description ───────────────────────────────────

/**
 * Returns the Hydra API documentation as Turtle.
 */
export function systemHydraApi(): string {
  return `${allPrefixes()}

# ════════════════════════════════════════════════════════════
# Context Graphs Hydra API Documentation
# ════════════════════════════════════════════════════════════

cg:ApiDocumentation a hydra:ApiDocumentation ;
    hydra:title "Context Graphs API" ;
    hydra:description "HATEOAS-driven API for the Context Graphs system." ;
    hydra:entrypoint </api> ;
    hydra:supportedClass
        cg:NodeEndpoint,
        cg:ChainEndpoint .

# ── Node Endpoint ────────────────────────────────────────────

cg:NodeEndpoint a hydra:Class ;
    hydra:title "Node" ;
    hydra:description "A PGSL node (atom or fragment) with context descriptors and affordances." ;
    hydra:supportedOperation [
        a hydra:Operation ;
        hydra:method "GET" ;
        hydra:title "Dereference node" ;
        hydra:description "Retrieve the full representation of a node including its context descriptors." ;
        hydra:returns cg:NodeRepresentation ;
    ] .

# ── Chain Endpoint ───────────────────────────────────────────

cg:ChainEndpoint a hydra:Class ;
    hydra:title "Chain" ;
    hydra:description "A syntagmatic chain (sequence of fragments)." ;
    hydra:supportedOperation [
        a hydra:Operation ;
        hydra:method "GET" ;
        hydra:title "Dereference chain" ;
        hydra:description "Retrieve the chain and its paradigm sets at each position." ;
        hydra:returns cg:NodeRepresentation ;
    ] .

# ── Ingest Operation ─────────────────────────────────────────

cg:IngestOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Ingest content" ;
    hydra:description "Ingest raw text content, producing atoms and initial fragments." ;
    hydra:expects cg:IngestRequest ;
    hydra:returns cg:IngestResponse .

# ── Ingest URIs Operation ────────────────────────────────────

cg:IngestUrisOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Ingest URIs" ;
    hydra:description "Ingest content from one or more URIs." ;
    hydra:expects cg:IngestRequest ;
    hydra:returns cg:IngestResponse .

# ── Chain (build) Operation ──────────────────────────────────

cg:ChainBuildOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Build chain" ;
    hydra:description "Build a syntagmatic chain from a sequence of node URIs." ;
    hydra:expects cg:IngestRequest ;
    hydra:returns cg:NodeRepresentation .

# ── Constraint Operation ─────────────────────────────────────

cg:ConstrainOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Create paradigm constraint" ;
    hydra:description "Create a constraint linking two paradigm sets via an operation." ;
    hydra:expects cg:ConstraintRequest ;
    hydra:returns cg:ConstraintRequest .

# ── Query Operation ──────────────────────────────────────────

cg:QueryOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "SPARQL query" ;
    hydra:description "Execute a SPARQL 1.2 query against the Context Graphs store." ;
    hydra:expects cg:QueryRequest ;
    hydra:returns cg:QueryResponse .

# ── Compose Operation ────────────────────────────────────────

cg:ComposeOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Algebraic composition" ;
    hydra:description "Compose context descriptors using union, intersection, restriction, or override." ;
    hydra:expects cg:ComposeRequest ;
    hydra:returns cg:ComposeResponse .

# ── Coherence Check Operation ────────────────────────────────

cg:CoherenceCheckOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Coherence check" ;
    hydra:description "Check coherence between two agents' views of a chain." ;
    hydra:expects cg:CoherenceRequest ;
    hydra:returns cg:CoherenceCertificate .

# ── Decision Operation ───────────────────────────────────────

cg:DecisionOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Record decision" ;
    hydra:description "Record an agent's decision (selected affordance) at a paradigm position." ;
    hydra:expects cg:Decision ;
    hydra:returns cg:Decision .

# ── Pod Add Operation ────────────────────────────────────────

cg:PodAddOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Add pod" ;
    hydra:description "Register a new Solid pod in the federation." ;
    hydra:expects cg:PodAddRequest ;
    hydra:returns cg:PodService .

# ── Pod Discover Operation ───────────────────────────────────

cg:PodDiscoverOperation a hydra:Operation ;
    hydra:method "GET" ;
    hydra:title "Discover pods" ;
    hydra:description "Discover all pods in the federation catalog." ;
    hydra:returns cg:PodCatalog .
`;
}

// ── DCAT Catalog ────────────────────────────────────────────

export interface PodInfo {
  readonly uri: string;
  readonly title: string;
  readonly accessUrl: string;
  readonly description?: string;
}

/**
 * Generate a DCAT catalog with DPROD alignment for a set of federated pods.
 */
export function systemDcatCatalog(pods: readonly PodInfo[]): string {
  const podEntries = pods.map(pod => {
    const desc = pod.description
      ? `\n    dcterms:description "${pod.description}" ;`
      : '';
    return `
<${pod.uri}> a dcat:Dataset, dprod:DataProduct ;
    dcterms:title "${pod.title}" ;${desc}
    dcat:distribution [
        a dcat:Distribution ;
        dcat:accessURL <${pod.accessUrl}> ;
        dcat:mediaType "text/turtle" ;
    ] .`;
  });

  const podList = pods.map(p => `<${p.uri}>`).join(', ');

  return `${allPrefixes()}

# ════════════════════════════════════════════════════════════
# Context Graphs Federation Catalog (DCAT + DPROD)
# ════════════════════════════════════════════════════════════

<urn:catalog:context-graphs> a dcat:Catalog ;
    dcterms:title "Context Graphs Federation" ;
    dcterms:description "Federated catalog of Context Graphs pods." ;
    dcat:dataset ${podList} .
${podEntries.join('\n')}
`;
}
