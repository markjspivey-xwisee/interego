/**
 * @module rdf/system-ontology
 * @description Full Interego system as an OWL ontology with SHACL shapes,
 * Hydra API description, and DCAT/DPROD catalog generation.
 *
 * Extends the PGSL-layer ontology (pgsl/rdf.ts) to cover every concept in the
 * system: context descriptors, facets, coherence, paradigms, persistence,
 * decisions, Hydra operations, DCAT federation, and PROV-O alignment.
 */

import {
  RDF, RDFS, XSD, OWL, PROV, SHACL, ACL, DCAT, HYDRA, DPROD, FOAF, DCT,
} from './namespaces.js';

// ── Namespace Constants ─────────────────────────────────────

/**
 * PGSL namespace IRI. Inlined here (rather than imported from the PGSL
 * package) because `rdf/system-ontology` is a substrate-level module
 * and the substrate cannot depend on `@interego/pgsl`. The PGSL package
 * exports the same constant — they MUST stay in sync.
 */
export const PGSL_NS  = 'https://markjspivey-xwisee.github.io/interego/ns/pgsl#' as const;
export const CG_NS    = 'https://markjspivey-xwisee.github.io/interego/ns/iep#' as const;
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
    `@prefix iep: <${CG_NS}> .`,
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
 * Returns the complete Interego OWL ontology as Turtle,
 * covering every concept in the system.
 */
export function systemOntology(): string {
  return `${allPrefixes()}

# ════════════════════════════════════════════════════════════
# Interego System Ontology
# ════════════════════════════════════════════════════════════

<${CG_NS}> a owl:Ontology ;
    rdfs:label "Interego System Ontology" ;
    rdfs:comment "Complete OWL ontology for Interego 1.0 — composable, verifiable, federated context infrastructure." ;
    owl:versionInfo "1.0.0" ;
    owl:imports <${PGSL_NS}> .

# ── PROV-O Alignment ────────────────────────────────────────

pgsl:Atom rdfs:subClassOf prov:Entity .
pgsl:Fragment rdfs:subClassOf prov:Entity .
iep:ContextDescriptor rdfs:subClassOf prov:Entity .

# ── Transitive / Inverse Properties (PGSL) ──────────────────

pgsl:contains a owl:TransitiveProperty ;
    owl:inverseOf pgsl:containedIn .

pgsl:containedIn a owl:ObjectProperty ;
    rdfs:domain pgsl:Node ;
    rdfs:range pgsl:Fragment ;
    rdfs:label "contained in" ;
    rdfs:comment "Inverse of pgsl:contains." .

iep:describes owl:inverseOf iep:describedBy .

iep:describedBy a owl:ObjectProperty ;
    rdfs:label "described by" ;
    rdfs:comment "Inverse of iep:describes — links a named graph to its descriptor." .

# ── CG Classes: Core Descriptor ─────────────────────────────

iep:ContextDescriptor a owl:Class ;
    rdfs:label "Context Descriptor" ;
    rdfs:comment "The core metadata envelope that describes a named graph with typed facets." .

iep:ComposedDescriptor a owl:Class ;
    rdfs:subClassOf iep:ContextDescriptor ;
    rdfs:label "Composed Descriptor" ;
    rdfs:comment "A descriptor produced by algebraic composition of source descriptors." .

# ── CG Classes: Facet Hierarchy ──────────────────────────────

iep:ContextFacet a owl:Class ;
    rdfs:label "Context Facet" ;
    rdfs:comment "Abstract base for all typed facets attached to a context descriptor." .

iep:TemporalFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:ProvenanceFacet, iep:AgentFacet, iep:AccessControlFacet,
        iep:SemioticFacet, iep:TrustFacet, iep:FederationFacet, iep:CausalFacet, iep:ProjectionFacet ;
    rdfs:label "Temporal Facet" ;
    rdfs:comment "Time-bounded validity window for context." .

iep:ProvenanceFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:AgentFacet, iep:AccessControlFacet, iep:SemioticFacet,
        iep:TrustFacet, iep:FederationFacet, iep:CausalFacet, iep:ProjectionFacet ;
    rdfs:label "Provenance Facet" ;
    rdfs:comment "Origin and derivation chain of the context." .

iep:AgentFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:AccessControlFacet, iep:SemioticFacet, iep:TrustFacet,
        iep:FederationFacet, iep:CausalFacet, iep:ProjectionFacet ;
    rdfs:label "Agent Facet" ;
    rdfs:comment "The asserting agent, role, and delegation chain." .

iep:AccessControlFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:SemioticFacet, iep:TrustFacet, iep:FederationFacet,
        iep:CausalFacet, iep:ProjectionFacet ;
    rdfs:label "Access Control Facet" ;
    rdfs:comment "WAC-based authorization and consent." .

iep:SemioticFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:TrustFacet, iep:FederationFacet, iep:CausalFacet, iep:ProjectionFacet ;
    rdfs:label "Semiotic Facet" ;
    rdfs:comment "Interpretation frame, modal status, and epistemic confidence." .

iep:TrustFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:FederationFacet, iep:CausalFacet, iep:ProjectionFacet ;
    rdfs:label "Trust Facet" ;
    rdfs:comment "Verifiable credentials, trust level, and revocation status." .

iep:FederationFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:CausalFacet, iep:ProjectionFacet ;
    rdfs:label "Federation Facet" ;
    rdfs:comment "Origin pod, storage endpoint, and sync protocol." .

iep:CausalFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    owl:disjointWith iep:ProjectionFacet ;
    rdfs:label "Causal Facet" ;
    rdfs:comment "Pearl-style structural causal model attachment." .

iep:ProjectionFacet a owl:Class ;
    rdfs:subClassOf iep:ContextFacet ;
    rdfs:label "Projection Facet" ;
    rdfs:comment "Vocabulary mapping and selective exposure for cross-boundary sharing." .

# ── CG Properties ────────────────────────────────────────────

iep:describes a owl:ObjectProperty ;
    rdfs:domain iep:ContextDescriptor ;
    rdfs:label "describes" ;
    rdfs:comment "Links a descriptor to the named graph it describes." .

iep:hasFacet a owl:ObjectProperty ;
    rdfs:domain iep:ContextDescriptor ;
    rdfs:range iep:ContextFacet ;
    rdfs:label "has facet" ;
    rdfs:comment "Links a descriptor to one of its typed facets." .

iep:validFrom a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:domain iep:TemporalFacet ;
    rdfs:range xsd:dateTime ;
    rdfs:label "valid from" ;
    rdfs:comment "Start of the temporal validity window." .

iep:validUntil a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:domain iep:TemporalFacet ;
    rdfs:range xsd:dateTime ;
    rdfs:label "valid until" ;
    rdfs:comment "End of the temporal validity window (open-ended if absent)." .

iep:trustLevel a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain iep:TrustFacet ;
    rdfs:range iep:TrustLevelEnum ;
    rdfs:label "trust level" ;
    rdfs:comment "Verification tier: SelfAsserted, ThirdPartyAttested, or CryptographicallyVerified." .

iep:TrustLevelEnum a owl:Class ;
    owl:oneOf ( iep:SelfAsserted iep:ThirdPartyAttested iep:CryptographicallyVerified ) ;
    rdfs:label "Trust Level Enumeration" .

iep:SelfAsserted a owl:NamedIndividual, iep:TrustLevelEnum ;
    rdfs:label "Self-Asserted" .
iep:ThirdPartyAttested a owl:NamedIndividual, iep:TrustLevelEnum ;
    rdfs:label "Third-Party Attested" .
iep:CryptographicallyVerified a owl:NamedIndividual, iep:TrustLevelEnum ;
    rdfs:label "Cryptographically Verified" .

iep:modalStatus a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain iep:SemioticFacet ;
    rdfs:range iep:ModalStatusEnum ;
    rdfs:label "modal status" ;
    rdfs:comment "Epistemic modality of the assertion." .

iep:ModalStatusEnum a owl:Class ;
    owl:oneOf ( iep:Asserted iep:Hypothetical iep:Counterfactual iep:Quoted iep:Retracted ) ;
    rdfs:label "Modal Status Enumeration" .

iep:Asserted a owl:NamedIndividual, iep:ModalStatusEnum ;
    rdfs:label "Asserted" .
iep:Hypothetical a owl:NamedIndividual, iep:ModalStatusEnum ;
    rdfs:label "Hypothetical" .
iep:Counterfactual a owl:NamedIndividual, iep:ModalStatusEnum ;
    rdfs:label "Counterfactual" .
iep:Quoted a owl:NamedIndividual, iep:ModalStatusEnum ;
    rdfs:label "Quoted" .
iep:Retracted a owl:NamedIndividual, iep:ModalStatusEnum ;
    rdfs:label "Retracted" .

iep:epistemicConfidence a owl:DatatypeProperty, owl:FunctionalProperty ;
    rdfs:domain iep:SemioticFacet ;
    rdfs:range xsd:double ;
    rdfs:label "epistemic confidence" ;
    rdfs:comment "Confidence level between 0.0 and 1.0." .

iep:wasAttributedTo a owl:ObjectProperty ;
    rdfs:domain iep:ProvenanceFacet ;
    rdfs:label "was attributed to" ;
    rdfs:comment "The agent responsible for this context." .

iep:composedFrom a owl:ObjectProperty ;
    rdfs:domain iep:ComposedDescriptor ;
    rdfs:range iep:ContextDescriptor ;
    rdfs:label "composed from" ;
    rdfs:comment "Links a composed descriptor to its source descriptors." .

iep:compositionOp a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain iep:ComposedDescriptor ;
    rdfs:range iep:CompositionOperator ;
    rdfs:label "composition operator" ;
    rdfs:comment "The algebraic operator used: union, intersection, restriction, or override." .

iep:union a owl:NamedIndividual, iep:CompositionOperator ;
    rdfs:label "Union" .
iep:intersection a owl:NamedIndividual, iep:CompositionOperator ;
    rdfs:label "Intersection" .
iep:restriction a owl:NamedIndividual, iep:CompositionOperator ;
    rdfs:label "Restriction" .
iep:override a owl:NamedIndividual, iep:CompositionOperator ;
    rdfs:label "Override" .

# ── Coherence Classes ────────────────────────────────────────

iep:CoherenceCertificate a owl:Class ;
    rdfs:label "Coherence Certificate" ;
    rdfs:comment "Result of a coherence verification between two agents' views." .

iep:CoherenceStatus a owl:Class ;
    owl:oneOf ( iep:Verified iep:Divergent iep:Unexamined ) ;
    rdfs:label "Coherence Status" .

iep:Verified a owl:NamedIndividual, iep:CoherenceStatus ;
    rdfs:label "Verified" .
iep:Divergent a owl:NamedIndividual, iep:CoherenceStatus ;
    rdfs:label "Divergent" .
iep:Unexamined a owl:NamedIndividual, iep:CoherenceStatus ;
    rdfs:label "Unexamined" .

iep:AtomCoherence a owl:Class ;
    rdfs:label "Atom Coherence" ;
    rdfs:comment "Per-atom usage analysis within a coherence check." .

iep:CoherenceObstruction a owl:Class ;
    rdfs:label "Coherence Obstruction" ;
    rdfs:comment "A specific divergence point between two agents' interpretations." .

iep:agentA a owl:ObjectProperty ;
    rdfs:domain iep:CoherenceCertificate ;
    rdfs:label "agent A" .

iep:agentB a owl:ObjectProperty ;
    rdfs:domain iep:CoherenceCertificate ;
    rdfs:label "agent B" .

iep:coherenceStatus a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain iep:CoherenceCertificate ;
    rdfs:range iep:CoherenceStatus ;
    rdfs:label "coherence status" .

iep:hasObstruction a owl:ObjectProperty ;
    rdfs:domain iep:CoherenceCertificate ;
    rdfs:range iep:CoherenceObstruction ;
    rdfs:label "has obstruction" .

iep:obstructionAtom a owl:ObjectProperty ;
    rdfs:domain iep:CoherenceObstruction ;
    rdfs:range pgsl:Atom ;
    rdfs:label "obstruction atom" .

# ── Paradigm Classes ─────────────────────────────────────────

iep:ParadigmSet a owl:Class ;
    rdfs:label "Paradigm Set" ;
    rdfs:comment "A computed set of interchangeable items at a syntagmatic position." .

iep:ParadigmConstraint a owl:Class ;
    rdfs:label "Paradigm Constraint" ;
    rdfs:comment "A rule linking two paradigm sets via an operation." .

iep:ParadigmOperation a owl:Class ;
    owl:oneOf ( iep:Subset iep:Intersect iep:Union iep:Exclude iep:Equal ) ;
    rdfs:label "Paradigm Operation" .

iep:Subset a owl:NamedIndividual, iep:ParadigmOperation ;
    rdfs:label "Subset" .
iep:Intersect a owl:NamedIndividual, iep:ParadigmOperation ;
    rdfs:label "Intersect" .
iep:Union a owl:NamedIndividual, iep:ParadigmOperation ;
    rdfs:label "Union" .
iep:Exclude a owl:NamedIndividual, iep:ParadigmOperation ;
    rdfs:label "Exclude" .
iep:Equal a owl:NamedIndividual, iep:ParadigmOperation ;
    rdfs:label "Equal" .

iep:SyntagmaticPattern a owl:Class ;
    rdfs:label "Syntagmatic Pattern" ;
    rdfs:comment "A chain pattern with wildcards for paradigm set computation." .

iep:patternA a owl:ObjectProperty ;
    rdfs:domain iep:ParadigmConstraint ;
    rdfs:range iep:SyntagmaticPattern ;
    rdfs:label "pattern A" .

iep:positionA a owl:DatatypeProperty ;
    rdfs:domain iep:ParadigmConstraint ;
    rdfs:range xsd:nonNegativeInteger ;
    rdfs:label "position A" .

iep:patternB a owl:ObjectProperty ;
    rdfs:domain iep:ParadigmConstraint ;
    rdfs:range iep:SyntagmaticPattern ;
    rdfs:label "pattern B" .

iep:positionB a owl:DatatypeProperty ;
    rdfs:domain iep:ParadigmConstraint ;
    rdfs:range xsd:nonNegativeInteger ;
    rdfs:label "position B" .

iep:paradigmOp a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain iep:ParadigmConstraint ;
    rdfs:range iep:ParadigmOperation ;
    rdfs:label "paradigm operation" .

# ── Persistence Classes ──────────────────────────────────────

iep:PersistenceRecord a owl:Class ;
    rdfs:label "Persistence Record" ;
    rdfs:comment "Tier metadata tracking where a node is stored." .

iep:PersistenceTier a owl:Class ;
    owl:oneOf ( iep:MemoryTier iep:Local iep:PodTier iep:IPFS iep:ChainTier ) ;
    rdfs:label "Persistence Tier" .

iep:MemoryTier a owl:NamedIndividual, iep:PersistenceTier ;
    rdfs:label "Memory" .
iep:Local a owl:NamedIndividual, iep:PersistenceTier ;
    rdfs:label "Local" .
iep:PodTier a owl:NamedIndividual, iep:PersistenceTier ;
    rdfs:label "Pod" .
iep:IPFS a owl:NamedIndividual, iep:PersistenceTier ;
    rdfs:label "IPFS" .
iep:ChainTier a owl:NamedIndividual, iep:PersistenceTier ;
    rdfs:label "Chain" .

iep:persistenceUri a owl:DatatypeProperty ;
    rdfs:domain iep:PersistenceRecord ;
    rdfs:range xsd:anyURI ;
    rdfs:label "persistence URI" .

iep:persistenceTier a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain iep:PersistenceRecord ;
    rdfs:range iep:PersistenceTier ;
    rdfs:label "persistence tier" .

iep:promotedAt a owl:DatatypeProperty ;
    rdfs:domain iep:PersistenceRecord ;
    rdfs:range xsd:dateTime ;
    rdfs:label "promoted at" .

# ── Decision Classes ─────────────────────────────────────────

iep:Decision a owl:Class ;
    rdfs:label "Decision" ;
    rdfs:comment "A selected affordance from a paradigm set." .

iep:DecisionStrategy a owl:Class ;
    owl:oneOf ( iep:Exploit iep:Explore iep:DelegateStrategy iep:Abstain ) ;
    rdfs:label "Decision Strategy" .

iep:Exploit a owl:NamedIndividual, iep:DecisionStrategy ;
    rdfs:label "Exploit" .
iep:Explore a owl:NamedIndividual, iep:DecisionStrategy ;
    rdfs:label "Explore" .
iep:DelegateStrategy a owl:NamedIndividual, iep:DecisionStrategy ;
    rdfs:label "Delegate" .
iep:Abstain a owl:NamedIndividual, iep:DecisionStrategy ;
    rdfs:label "Abstain" .

iep:ObservationSection a owl:Class ;
    rdfs:label "Observation Section" ;
    rdfs:comment "What an agent has seen — the observed portion of a chain." .

iep:decisionStrategy a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:domain iep:Decision ;
    rdfs:range iep:DecisionStrategy ;
    rdfs:label "decision strategy" .

iep:selectedAffordance a owl:ObjectProperty ;
    rdfs:domain iep:Decision ;
    rdfs:label "selected affordance" .

iep:observation a owl:ObjectProperty ;
    rdfs:domain iep:Decision ;
    rdfs:range iep:ObservationSection ;
    rdfs:label "observation" .

# ── DCAT / DPROD Alignment ───────────────────────────────────

iep:PodService a owl:Class ;
    rdfs:subClassOf dcat:DataService ;
    rdfs:label "Pod" ;
    rdfs:comment "A Solid pod exposed as a DCAT DataService." .

iep:PodCatalog a owl:Class ;
    rdfs:subClassOf dcat:Catalog ;
    rdfs:label "Pod Catalog" ;
    rdfs:comment "Federation-wide catalog of discoverable pods." .

# ── Hydra Integration (class stubs for API) ──────────────────

iep:NodeEndpoint a owl:Class, hydra:Class ;
    rdfs:label "Node Endpoint" ;
    rdfs:comment "HATEOAS-driven node resource." .

iep:ChainEndpoint a owl:Class, hydra:Class ;
    rdfs:label "Chain Endpoint" ;
    rdfs:comment "HATEOAS-driven chain resource." .

iep:NodeRepresentation a owl:Class ;
    rdfs:label "Node Representation" ;
    rdfs:comment "The JSON representation of a dereferenced node." .

iep:IngestRequest a owl:Class ;
    rdfs:label "Ingest Request" ;
    rdfs:comment "Payload for ingesting raw content." .

iep:IngestResponse a owl:Class ;
    rdfs:label "Ingest Response" ;
    rdfs:comment "Result of an ingest operation." .

iep:ComposeRequest a owl:Class ;
    rdfs:label "Compose Request" ;
    rdfs:comment "Payload for algebraic composition." .

iep:ComposeResponse a owl:Class ;
    rdfs:label "Compose Response" ;
    rdfs:comment "Result of a compose operation." .

iep:ConstraintRequest a owl:Class ;
    rdfs:label "Constraint Request" ;
    rdfs:comment "Payload for creating a paradigm constraint." .

iep:QueryRequest a owl:Class ;
    rdfs:label "Query Request" ;
    rdfs:comment "SPARQL query payload." .

iep:QueryResponse a owl:Class ;
    rdfs:label "Query Response" ;
    rdfs:comment "SPARQL query result." .

iep:CoherenceRequest a owl:Class ;
    rdfs:label "Coherence Request" ;
    rdfs:comment "Payload for a coherence check." .

iep:PodAddRequest a owl:Class ;
    rdfs:label "Pod Add Request" ;
    rdfs:comment "Payload for adding a pod to the federation." .
`;
}

// ── SHACL Shapes ────────────────────────────────────────────

/**
 * Returns SHACL shapes for validating the full Interego system.
 */
export function systemShaclShapes(): string {
  return `${allPrefixes()}

# ════════════════════════════════════════════════════════════
# Interego SHACL Shapes
# ════════════════════════════════════════════════════════════

# ── Context Descriptor Shape ─────────────────────────────────

iep:ContextDescriptorShape a sh:NodeShape ;
    sh:targetClass iep:ContextDescriptor ;
    sh:property [
        sh:path iep:describes ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:name "describes"
    ] ;
    sh:property [
        sh:path iep:hasFacet ;
        sh:minCount 1 ;
        sh:class iep:ContextFacet ;
        sh:name "must have at least one facet"
    ] .

# ── Temporal Facet Shape ─────────────────────────────────────

iep:TemporalFacetShape a sh:NodeShape ;
    sh:targetClass iep:TemporalFacet ;
    sh:property [
        sh:path iep:validFrom ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
        sh:name "valid from (required)"
    ] ;
    sh:property [
        sh:path iep:validUntil ;
        sh:maxCount 1 ;
        sh:datatype xsd:dateTime ;
        sh:name "valid until (optional)"
    ] .

# ── Trust Facet Shape ────────────────────────────────────────

iep:TrustFacetShape a sh:NodeShape ;
    sh:targetClass iep:TrustFacet ;
    sh:property [
        sh:path iep:trustLevel ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( iep:SelfAsserted iep:ThirdPartyAttested iep:CryptographicallyVerified ) ;
        sh:name "trust level (required, from enumeration)"
    ] .

# ── Semiotic Facet Shape ─────────────────────────────────────

iep:SemioticFacetShape a sh:NodeShape ;
    sh:targetClass iep:SemioticFacet ;
    sh:property [
        sh:path iep:modalStatus ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( iep:Asserted iep:Hypothetical iep:Counterfactual iep:Quoted iep:Retracted ) ;
        sh:name "modal status (required)"
    ] ;
    sh:property [
        sh:path iep:epistemicConfidence ;
        sh:maxCount 1 ;
        sh:datatype xsd:decimal ;
        sh:minInclusive 0 ;
        sh:maxInclusive 1 ;
        sh:name "epistemic confidence (0.0 to 1.0)"
    ] .

# ── Coherence Certificate Shape ──────────────────────────────

iep:CoherenceCertificateShape a sh:NodeShape ;
    sh:targetClass iep:CoherenceCertificate ;
    sh:property [
        sh:path iep:agentA ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:name "agent A (required)"
    ] ;
    sh:property [
        sh:path iep:agentB ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:name "agent B (required)"
    ] ;
    sh:property [
        sh:path iep:coherenceStatus ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( iep:Verified iep:Divergent iep:Unexamined ) ;
        sh:name "status (required)"
    ] .

# ── Paradigm Constraint Shape ────────────────────────────────

iep:ParadigmConstraintShape a sh:NodeShape ;
    sh:targetClass iep:ParadigmConstraint ;
    sh:property [
        sh:path iep:patternA ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:class iep:SyntagmaticPattern ;
        sh:name "pattern A (required)"
    ] ;
    sh:property [
        sh:path iep:positionA ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
        sh:name "position A (required)"
    ] ;
    sh:property [
        sh:path iep:paradigmOp ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( iep:Subset iep:Intersect iep:Union iep:Exclude iep:Equal ) ;
        sh:name "operation (required)"
    ] ;
    sh:property [
        sh:path iep:patternB ;
        sh:maxCount 1 ;
        sh:class iep:SyntagmaticPattern ;
        sh:name "pattern B (optional — omitted for unary constraints)"
    ] ;
    sh:property [
        sh:path iep:positionB ;
        sh:maxCount 1 ;
        sh:datatype xsd:nonNegativeInteger ;
        sh:name "position B (optional)"
    ] .

# ── Persistence Record Shape ─────────────────────────────────

iep:PersistenceRecordShape a sh:NodeShape ;
    sh:targetClass iep:PersistenceRecord ;
    sh:property [
        sh:path iep:persistenceUri ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:anyURI ;
        sh:name "URI (required)"
    ] ;
    sh:property [
        sh:path iep:persistenceTier ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:in ( iep:MemoryTier iep:Local iep:PodTier iep:IPFS iep:ChainTier ) ;
        sh:name "tier (required)"
    ] ;
    sh:property [
        sh:path iep:promotedAt ;
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
# Interego Hydra API Documentation
# ════════════════════════════════════════════════════════════

iep:ApiDocumentation a hydra:ApiDocumentation ;
    hydra:title "Interego API" ;
    hydra:description "HATEOAS-driven API for the Interego system." ;
    hydra:entrypoint </api> ;
    hydra:supportedClass
        iep:NodeEndpoint,
        iep:ChainEndpoint .

# ── Node Endpoint ────────────────────────────────────────────

iep:NodeEndpoint a hydra:Class ;
    hydra:title "Node" ;
    hydra:description "A PGSL node (atom or fragment) with context descriptors and affordances." ;
    hydra:supportedOperation [
        a hydra:Operation ;
        hydra:method "GET" ;
        hydra:title "Dereference node" ;
        hydra:description "Retrieve the full representation of a node including its context descriptors." ;
        hydra:returns iep:NodeRepresentation ;
    ] .

# ── Chain Endpoint ───────────────────────────────────────────

iep:ChainEndpoint a hydra:Class ;
    hydra:title "Chain" ;
    hydra:description "A syntagmatic chain (sequence of fragments)." ;
    hydra:supportedOperation [
        a hydra:Operation ;
        hydra:method "GET" ;
        hydra:title "Dereference chain" ;
        hydra:description "Retrieve the chain and its paradigm sets at each position." ;
        hydra:returns iep:NodeRepresentation ;
    ] .

# ── Ingest Operation ─────────────────────────────────────────

iep:IngestOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Ingest content" ;
    hydra:description "Ingest raw text content, producing atoms and initial fragments." ;
    hydra:expects iep:IngestRequest ;
    hydra:returns iep:IngestResponse .

# ── Ingest URIs Operation ────────────────────────────────────

iep:IngestUrisOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Ingest URIs" ;
    hydra:description "Ingest content from one or more URIs." ;
    hydra:expects iep:IngestRequest ;
    hydra:returns iep:IngestResponse .

# ── Chain (build) Operation ──────────────────────────────────

iep:ChainBuildOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Build chain" ;
    hydra:description "Build a syntagmatic chain from a sequence of node URIs." ;
    hydra:expects iep:IngestRequest ;
    hydra:returns iep:NodeRepresentation .

# ── Constraint Operation ─────────────────────────────────────

iep:ConstrainOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Create paradigm constraint" ;
    hydra:description "Create a constraint linking two paradigm sets via an operation." ;
    hydra:expects iep:ConstraintRequest ;
    hydra:returns iep:ConstraintRequest .

# ── Query Operation ──────────────────────────────────────────

iep:QueryOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "SPARQL query" ;
    hydra:description "Execute a SPARQL 1.2 query against the Interego store." ;
    hydra:expects iep:QueryRequest ;
    hydra:returns iep:QueryResponse .

# ── Compose Operation ────────────────────────────────────────

iep:ComposeOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Algebraic composition" ;
    hydra:description "Compose context descriptors using union, intersection, restriction, or override." ;
    hydra:expects iep:ComposeRequest ;
    hydra:returns iep:ComposeResponse .

# ── Coherence Check Operation ────────────────────────────────

iep:CoherenceCheckOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Coherence check" ;
    hydra:description "Check coherence between two agents' views of a chain." ;
    hydra:expects iep:CoherenceRequest ;
    hydra:returns iep:CoherenceCertificate .

# ── Decision Operation ───────────────────────────────────────

iep:DecisionOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Record decision" ;
    hydra:description "Record an agent's decision (selected affordance) at a paradigm position." ;
    hydra:expects iep:Decision ;
    hydra:returns iep:Decision .

# ── Pod Add Operation ────────────────────────────────────────

iep:PodAddOperation a hydra:Operation ;
    hydra:method "POST" ;
    hydra:title "Add pod" ;
    hydra:description "Register a new Solid pod in the federation." ;
    hydra:expects iep:PodAddRequest ;
    hydra:returns iep:PodService .

# ── Pod Discover Operation ───────────────────────────────────

iep:PodDiscoverOperation a hydra:Operation ;
    hydra:method "GET" ;
    hydra:title "Discover pods" ;
    hydra:description "Discover all pods in the federation catalog." ;
    hydra:returns iep:PodCatalog .
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
# Interego Federation Catalog (DCAT + DPROD)
# ════════════════════════════════════════════════════════════

<urn:catalog:context-graphs> a dcat:Catalog ;
    dcterms:title "Interego Federation" ;
    dcterms:description "Federated catalog of Interego pods." ;
    dcat:dataset ${podList} .
${podEntries.join('\n')}
`;
}
